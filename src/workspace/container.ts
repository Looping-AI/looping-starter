import { MAX_TOOL_CALL_MS } from "@dynamicagents/core";
import type { ComputerConfig } from "@dynamicagents/plugins/computer";
import type { WorkspaceObjectBase } from "./object";
import { WORKSPACE_DIR } from "./object";

/**
 * The container settings every path into a workspace shares.
 *
 * Exported and shared because a partial copy of this has already caused an
 * outage. The coder's cancellation path used to rebuild its own — without
 * `shell: "bash"` — so a cancelled task's cleanup ran under a different shell
 * than every other command in the same container. One definition is what stops
 * that, and now it stops it across two agents rather than two call sites.
 *
 * The name is a parameter rather than resolved here: it is one workspace per
 * caller **per repository** (`@cloudflare/computer` pairs one Durable Object
 * with one container, so two repositories cannot share one), and the callers
 * differ in how they reach the caller half — `host.callerKey()` on a plugin
 * list, which throws once a task is cancelled, and `identityKeyOrTask` on the
 * cancellation path.
 *
 * A caller's checkout **outlives the task**, which is why `repo_clone` fetches
 * and resets an existing one rather than assuming an empty directory. What does
 * *not* outlive the container is `node_modules`; see `./install-plan.ts`.
 */
export function workspaceContainer(
  binding: DurableObjectNamespace<WorkspaceObjectBase>,
  workspaceName: () => string
): ComputerConfig {
  return {
    binding,
    workspaceName,
    cwd: WORKSPACE_DIR,
    /**
     * The image is `debian:stable-slim`, so `/bin/sh` is **dash** — and a model
     * writing shell writes bash. Left unset, a subagent lost two minutes to
     * `${PIPESTATUS[0]}` in a pipeline: dash has no such variable, failed the line
     * with exit 2 after a 58-second `npm run check`, and the model re-ran the
     * whole check a third time under `bash -c` to recover. See `ComputerConfig.shell`.
     *
     * Safe because the base image ships bash — that third command is the proof it
     * was there all along.
     */
    shell: "bash",
    /**
     * Above the plugin's 90-second default, because this deployment starts its
     * installs *early* rather than on demand.
     *
     * The workspace object arms a reinstall the moment it sees a cold container,
     * so by the time a command that needs `node_modules` arrives, the install is
     * usually part-done and the gate only has to absorb the remainder. But "usually"
     * is not "always": a model that reaches for `npm` immediately meets a fresh
     * ~85-second `npm ci`, and at 90 seconds the gate would give up a few seconds
     * short, report "nothing was run — call again in a moment", and spend a turn
     * on it.
     *
     * Three minutes covers a measured install with room, and stays far inside both
     * `MAX_TOOL_CALL_MS` and `CHUNK_SOFT_MS` — the wait happens inside one
     * `sb_exec`, so those are the ceilings that matter.
     */
    installGateMs: 180_000,
    /**
     * Stated rather than defaulted, because it is half of an invariant that spans
     * two packages and used to be enforced by neither.
     *
     * `CHUNK_SOFT_MS` is a *soft* deadline checked between turns, so the chunk a
     * command runs in can overrun by however long that command takes. Core sizes
     * the headroom under its step timeout against `MAX_TOOL_CALL_MS` — and can
     * only do that if the tools a host installs actually honour it. Core installs
     * no tools, so nothing but this line makes that true here.
     *
     * The plugin's own default happens to be the same ten minutes today. Writing
     * it out means a future change to either number is caught by the assertion in
     * core's `platform.spec.ts` rather than by a `WorkflowTimeoutError` in
     * production, which is how the previous version of this was found.
     *
     * Note the other end of the same command: `CONTAINER_IDLE_MS` in `./object.ts`
     * must stay above this, or the idle sweeper destroys the container out from
     * under a command still running in it.
     */
    timeoutMs: MAX_TOOL_CALL_MS
  };
}
