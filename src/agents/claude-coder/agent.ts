import type { AgentPlugin, CoreConfigOverrides } from "@loopingai/core";
import type { PluginHost } from "@loopingai/core/host";
import {
  RoundAgentBase,
  type RoundPolicy,
  type SubagentClass
} from "@loopingai/core/round";
import { CLAUDE_CODER_CONFIG } from "@/config";
import { roundPolicy } from "@/round-policy";
import { activeRepo } from "@/workspace/active-repo";
import { discardWorkingTree, sweepIdleWorkspaces } from "@/workspace/lifecycle";
import { workspaceName } from "@/workspace/object";
import { parentPlugins } from "./plugins";
import { soulPrompt } from "./soul";
import { ClaudeCoderSubagent } from "./subagent";

/** This agent's log prefix and workspace label. */
const LABEL = "claude-coder";

/**
 * The claude-coder agent — the coder's sibling, with a different engine.
 *
 * The parent is an ordinary Looping round agent on Workers AI: it clones,
 * reviews diffs, commits, pushes and opens pull requests, and it has no shell,
 * no editor and no way to write a file. What is different is one level down.
 * Its subtasks do not run core's tool loop; each is a Claude Code session inside
 * this agent's own container, against the same durable checkout. See
 * `./subagent.ts`.
 *
 * That exists because a Claude **subscription** credential 429s at zero tokens
 * against the raw Messages API on every frontier model, and the same credential
 * answers through the sanctioned client. The harness is the unlock — so the way
 * to reach Opus on a subscription is to run the client, and the way to do that
 * safely is to keep the credential on this side of the container boundary. The
 * overrides below are all lifecycle, exactly as in `../coder/agent.ts`.
 */
export class ClaudeCoderAgent extends RoundAgentBase<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return CLAUDE_CODER_CONFIG;
  }

  /**
   * The **parent's** list, which is not the subagent's — see `plugins.ts`. The
   * asymmetry is starker here than in the coder: the subagent's list is one
   * entry, because a Claude Code session brings its own tools.
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
    return ClaudeCoderSubagent;
  }

  /**
   * Register the workspace reclaim sweep alongside core's own cleanup cron.
   *
   * A backstop for the one wake intent a workspace cannot heal itself — see
   * `sweepIdleWorkspaces`. `super.onStart()` first: core registers its own
   * weekly task cleanup there, and both schedules coexist.
   */
  override async onStart(): Promise<void> {
    await super.onStart();
    const existing = await this.listSchedules({ type: "cron" });
    if (!existing.some((s) => s.callback === "reclaimIdleWorkspaces")) {
      // Sunday 03:00 UTC — an hour after the coder's, which is an hour after
      // core's, so no two sweeps contend for the same instance.
      await this.schedule("0 3 * * 0", "reclaimIdleWorkspaces", {});
    }
  }

  /** Cron handler, delegating to the shared sweep. */
  async reclaimIdleWorkspaces(): Promise<void> {
    await sweepIdleWorkspaces({
      host: this.pluginHost(),
      binding: this.env.CLAUDE_CODER_WORKSPACE,
      label: LABEL
    });
  }

  /**
   * Discard a cancelled task's half-finished edits — without discarding the
   * workspace.
   *
   * The reasoning is on `discardWorkingTree`. It matters more here than for the
   * coder: a cancelled Claude Code session is stopped mid-turn with `SIGTERM`
   * (see `subagent.ts`), so the tree it leaves is whatever it had reached, and
   * the checkout outlives the task.
   */
  protected override async onTaskCanceled(taskId: string): Promise<void> {
    await super.onTaskCanceled(taskId);
    const repo = activeRepo(this.pluginHost()).get();
    await discardWorkingTree({
      binding: this.env.CLAUDE_CODER_WORKSPACE,
      name: workspaceName(this.#identityKeyOrTask(taskId), repo),
      repo,
      label: LABEL
    });
  }

  /**
   * The caller key, resilient to being called before a caller is known.
   *
   * Cancellation can arrive on an instance that has not served a turn, where
   * `callerKey` throws. Falling back to the task id is wrong-but-harmless: it
   * addresses a workspace nobody has ever used rather than someone else's.
   */
  #identityKeyOrTask(taskId: string): string {
    try {
      return this.pluginHost().callerKey();
    } catch {
      return taskId;
    }
  }
}
