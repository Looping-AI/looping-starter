import type {
  AgentPlugin,
  CoreConfigOverrides,
  ModelConfig
} from "@loopingai/core";
import type { ModelRuntime } from "@loopingai/core/agent";
import type { PluginHost } from "@loopingai/core/host";
import {
  RoundAgentBase,
  type RoundPolicy,
  type SubagentClass
} from "@loopingai/core/round";
import { computerExec } from "@loopingai/plugins/computer";
import { CODER_CONFIG } from "@/config";
import { roundPolicy } from "@/round-policy";
import { activeRepo } from "./active-repo";
import { coderModels } from "./models";
import { container, parentPlugins } from "./plugins";
import { workspaceName, WORKSPACE_DIR } from "./workspace-do";
import { soulPrompt } from "./soul";
import { CoderSubagent } from "./subagent";

/**
 * The coder agent.
 *
 * A delegating round agent like `reactive`: the loop, the durable Subtask DAG and
 * the subagent execution are all `@loopingai/core/round`. Two things make it the
 * odd one out in this Worker, and both are overrides below rather than forks of
 * anything.
 */
export class CoderAgent extends RoundAgentBase<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return CODER_CONFIG;
  }

  /**
   * The **parent's** list, which is not the subagent's — see `plugins.ts`. This
   * agent orchestrates and reviews; it has git, a browser and read-only eyes on
   * the container, and no way to change a file.
   */
  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return parentPlugins(host);
  }

  protected agentSoul(capabilities: string): string {
    return soulPrompt(capabilities);
  }

  /** The words the loop says — shared with the other round agents. */
  protected roundPolicy(): RoundPolicy {
    return roundPolicy;
  }

  protected subagentClass(): SubagentClass {
    return CoderSubagent;
  }

  /**
   * Run on Claude instead of Workers AI — see `./models.ts`, which
   * `CoderSubagent` returns from the same seam. One definition, so the parent
   * and its facet cannot drift onto different providers.
   *
   * `requireSelfOrigin()` is core's: this deployment's own origin, learned from
   * the `jku` every turn carries, and the `iss` of the token minted for the
   * proxy. Passed as a thunk because it is read per model call, and a runtime is
   * built before the first turn reaches this instance.
   */
  protected override modelRuntime(model: ModelConfig): ModelRuntime {
    return coderModels(() => this.requireSelfOrigin())(this.env, model);
  }

  /**
   * Register the workspace reclaim sweep alongside core's own cleanup cron.
   *
   * A **backstop**, not the mechanism. Each workspace arms its own `idle-reclaim`
   * alarm on every use, and that is what normally fires — exactly seven days
   * after the last touch, with no registry and no help from here.
   *
   * What this covers is the one case the workspace cannot cover itself. A
   * throwing `alarm()` is retried a bounded number of times and then dropped
   * permanently, and `idle-reclaim` is the only intent that cannot heal on the
   * next RPC, because by definition nothing is calling in. So once a week this
   * pokes every workspace this caller has ever used and lets each decide.
   *
   * `super.onStart()` first: core registers its own weekly task cleanup there,
   * and both schedules coexist.
   */
  override async onStart(): Promise<void> {
    await super.onStart();
    const existing = await this.listSchedules({ type: "cron" });
    if (!existing.some((s) => s.callback === "reclaimIdleWorkspaces")) {
      // Sunday 02:00 UTC — an hour after core's, so the two never contend for
      // the same instance.
      await this.schedule("0 2 * * 0", "reclaimIdleWorkspaces", {});
    }
  }

  /**
   * Cron handler: offer every workspace this caller has used a chance to go.
   *
   * The agent decides nothing. It knows which names it handed out; the workspace
   * knows when it was last touched, which is the only clock worth reading — the
   * agent names a workspace once and then the subagent facet uses it for the
   * rest of the task, traffic the agent never sees.
   */
  async reclaimIdleWorkspaces(): Promise<void> {
    let callerKey: string;
    try {
      callerKey = this.pluginHost().callerKey();
    } catch {
      // A scheduled wake-up on an instance that has never served a turn. There
      // is nothing to sweep, because nothing was ever handed out.
      return;
    }

    for (const repo of activeRepo(this.pluginHost()).seen()) {
      const name = workspaceName(callerKey, repo);
      try {
        const result = await this.env.CODER_WORKSPACE.get(
          this.env.CODER_WORKSPACE.idFromName(name)
        ).reclaimIfIdle();
        if (result.reclaimed) {
          console.info("[coder] reclaimed an idle workspace", { name });
        }
      } catch (err) {
        // Best-effort per workspace: one unreachable object must not stop the
        // sweep reaching the rest.
        console.warn("[coder] could not sweep a workspace", {
          name,
          err: String(err)
        });
      }
    }
  }

  /**
   * Discard a cancelled task's half-finished edits — without discarding the
   * workspace.
   *
   * The guarantee is unchanged: a cancelled task's working tree is an edit
   * nobody asked for, and the checkout outlives the task, so leaving it would
   * hand the *next* task someone's abandoned work as if it were the starting
   * point.
   *
   * What changed is that throwing the container away no longer achieves it. It
   * used to, because the container *was* the state; now the checkout lives in a
   * Durable Object and survives the container entirely, so `destroy()` would
   * discard `node_modules` — the one thing that is genuinely expensive to
   * rebuild — while leaving the abandoned edits exactly where they were. Exactly
   * backwards.
   *
   * So the reset happens in the checkout. `-e node_modules` keeps the install,
   * which no cancellation has any reason to invalidate.
   */
  protected override async onTaskCanceled(taskId: string): Promise<void> {
    await super.onTaskCanceled(taskId);
    try {
      const host = this.pluginHost();
      const active = activeRepo(host);
      const name = workspaceName(this.identityKeyOrTask(taskId), active.get());
      // The same settings the tools run under — `shell: "bash"` above all, which
      // a partial copy of this config used to drop.
      const exec = computerExec(container(this.env, () => name));
      // The path the checkout is actually at, as the repo plugin reported it.
      // Falling back to the conventional layout only when nothing has installed
      // yet, in which case there is no working tree to discard either.
      const dir =
        (await this.env.CODER_WORKSPACE.get(
          this.env.CODER_WORKSPACE.idFromName(name)
        ).checkoutDir()) ??
        `${WORKSPACE_DIR}/${active.get()?.split("/")[1] ?? "repo"}`;
      // Best-effort and deliberately not fatal: `git clean` on a checkout that
      // does not exist yet is a no-op, and a cancellation must complete either
      // way.
      await exec("git reset --hard && git clean -fd -e node_modules", {
        cwd: dir
      });
    } catch (err) {
      console.warn("[coder] could not discard the working tree on cancel", {
        taskId,
        err: String(err)
      });
    }
  }

  /**
   * The caller key, resilient to being called before a caller is known.
   *
   * `plugins.ts` keys workspaces on the verified caller, and cancellation can
   * arrive on an instance that has not served a turn yet — where `callerKey`
   * throws. Falling back to the task id is wrong-but-harmless: it addresses a
   * workspace nobody has ever used rather than someone else's.
   */
  private identityKeyOrTask(taskId: string): string {
    try {
      return this.pluginHost().callerKey();
    } catch {
      return taskId;
    }
  }
}
