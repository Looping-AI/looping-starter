import type { PluginHost } from "@loopingai/core/host";
import { computerExec } from "@loopingai/plugins/computer";
import { activeRepo } from "./active-repo";
import { workspaceContainer } from "./container";
import {
  workspaceName,
  WORKSPACE_DIR,
  type WorkspaceObjectBase
} from "./object";

/**
 * The two things an agent with a workspace owes it, beyond the object itself.
 *
 * Both were written once in `coder/agent.ts` and would otherwise be copied into
 * every sibling — and both are the kind of code that is subtly wrong in a copy:
 * one is a cleanup that must not throw away the expensive thing, the other is a
 * sweep whose whole job is to decide nothing.
 */

/** A workspace namespace, as either agent's `Env` spells it. */
export type WorkspaceNamespace = DurableObjectNamespace<WorkspaceObjectBase>;

/**
 * Discard a cancelled task's half-finished edits — without discarding the
 * workspace.
 *
 * The guarantee: a cancelled task's working tree is an edit nobody asked for,
 * and the checkout outlives the task, so leaving it would hand the *next* task
 * someone's abandoned work as if it were the starting point.
 *
 * **Throwing the container away does not achieve this**, and it used to. The
 * container *was* the state; now the checkout lives in a Durable Object and
 * survives the container entirely, so `destroy()` would discard `node_modules` —
 * the one thing that is genuinely expensive to rebuild — while leaving the
 * abandoned edits exactly where they were. Exactly backwards.
 *
 * So the reset happens in the checkout. `-e node_modules` keeps the install,
 * which no cancellation has any reason to invalidate.
 *
 * Best-effort and deliberately not fatal: `git clean` on a checkout that does
 * not exist yet is a no-op, and a cancellation must complete either way.
 */
export async function discardWorkingTree(config: {
  binding: WorkspaceNamespace;
  name: string;
  /** `owner/repo`, for the fallback path only. */
  repo: string | undefined;
  label: string;
}): Promise<void> {
  try {
    // The same settings the tools run under — `shell: "bash"` above all, which
    // a partial copy of this config used to drop.
    const exec = computerExec(
      workspaceContainer(config.binding, () => config.name)
    );
    // The path the checkout is actually at, as the repo plugin reported it.
    // Falling back to the conventional layout only when nothing has installed
    // yet, in which case there is no working tree to discard either.
    const dir =
      (await config.binding
        .get(config.binding.idFromName(config.name))
        .checkoutDir()) ??
      `${WORKSPACE_DIR}/${config.repo?.split("/")[1] ?? "repo"}`;
    await exec("git reset --hard && git clean -fd -e node_modules", {
      cwd: dir
    });
  } catch (err) {
    console.warn(`[${config.label}] could not discard the working tree`, {
      err: String(err)
    });
  }
}

/**
 * Offer every workspace this caller has used a chance to go.
 *
 * A **backstop**, not the mechanism. Each workspace arms its own `idle-reclaim`
 * alarm on every use, and that is what normally fires — exactly seven days after
 * the last touch, with no registry and no help from the agent.
 *
 * What this covers is the one case a workspace cannot cover itself. A throwing
 * `alarm()` is retried a bounded number of times and then dropped permanently,
 * and `idle-reclaim` is the only intent that cannot heal on the next RPC,
 * because by definition nothing is calling in.
 *
 * The agent decides nothing. It knows which names it handed out; the workspace
 * knows when it was last touched, which is the only clock worth reading — the
 * agent names a workspace once and then the subagent facet uses it for the rest
 * of the task, traffic the agent never sees.
 */
export async function sweepIdleWorkspaces(config: {
  host: PluginHost<Env>;
  binding: WorkspaceNamespace;
  label: string;
}): Promise<void> {
  let callerKey: string;
  try {
    callerKey = config.host.callerKey();
  } catch {
    // A scheduled wake-up on an instance that has never served a turn. There is
    // nothing to sweep, because nothing was ever handed out.
    return;
  }

  for (const repo of activeRepo(config.host).seen()) {
    const name = workspaceName(callerKey, repo);
    try {
      const result = await config.binding
        .get(config.binding.idFromName(name))
        .reclaimIfIdle();
      if (result.reclaimed) {
        console.info(`[${config.label}] reclaimed an idle workspace`, { name });
      }
    } catch (err) {
      // Best-effort per workspace: one unreachable object must not stop the
      // sweep reaching the rest.
      console.warn(`[${config.label}] could not sweep a workspace`, {
        name,
        err: String(err)
      });
    }
  }
}
