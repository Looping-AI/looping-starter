import {
  MAX_TOOL_CALL_MS,
  restrictMainAgentTools,
  type AgentPlugin
} from "@loopingai/core";
import type { PluginHost } from "@loopingai/core/host";
import {
  computer,
  computerExec,
  type ComputerConfig
} from "@loopingai/plugins/computer";
import { repo } from "@loopingai/plugins/repo";
import { browser } from "@loopingai/plugins/browser";
import { activeRepo } from "./active-repo";
import { code } from "./code";
import { workspaceName, WORKSPACE_DIR } from "./workspace-do";

/**
 * The one file you edit to add or remove a capability for this agent.
 *
 * Delete a line and that module leaves the bundle entirely. Nothing in core
 * imports a plugin, and `@loopingai/plugins` has no root barrel — the bare
 * specifier does not resolve — so the guarantee is structural rather than a
 * tree-shaker's opinion. `npm run verify:isolation` asserts it on the built graph.
 *
 * ## Two lists, because the parent and its subagents are not the same agent
 *
 * This agent **always delegates**: the parent orchestrates and reviews, and every
 * edit is made by a subagent. That is a deliberate split, not an accident of
 * configuration, and the reason is context. A parent that reads files, runs
 * builds and reads their output accumulates a session nobody can afford to keep
 * warm — and it is exactly the session that has to survive for the *whole* task,
 * across every round. Pushing the expensive, disposable half into subagents
 * leaves the parent holding a short transcript of decisions.
 *
 * So the parent's surface is: git, a browser, and read-only access to the
 * checkout so it can check a claim rather than take one on trust. What it does
 * not have is a shell, a writer, or an editor.
 *
 * ## Why there is no `workspace()` here
 *
 * `@loopingai/plugins/workspace` is a virtual filesystem over this Durable
 * Object's own SQLite. The computer plugin's filesystem is a *different* Durable
 * Object's SQLite, mounted into a container. Installing both would hand the
 * model two unrelated filesystems and no way to tell from a path which one it is
 * addressing — so this agent has exactly one, and it is the one with a compiler
 * in it.
 */

/** The sandbox tools the *parent* keeps: enough to verify, not enough to edit. */
const PARENT_SANDBOX_TOOLS = ["sb_read", "sb_ls", "sb_exists"] as const;

/**
 * What the parent is told about the workspace, replacing the plugin's own block.
 *
 * The plugin's version advertises `sb_exec`, `sb_write` and `sb_edit`, which the
 * parent no longer has. Leaving it in place is not a cosmetic problem: a model
 * told it has a shell spends a turn discovering it does not, and the natural
 * next move — doing the work itself — is the one thing this split exists to
 * prevent.
 */
const PARENT_SANDBOX_CAPABILITY = [
  "You can read the workspace the subagents work in, but not change it:",
  "- `sb_read` reads a file, `sb_ls` lists a directory, `sb_exists` checks a path.",
  "Use these to check a subagent's report against what is actually on disk — read the file it says it changed. You cannot run commands, write, or edit; that is what delegation is for.",
  "`node_modules` is not in the workspace — it lives in the container only — so these tools cannot see inside it. That is expected and not a sign anything is missing."
].join("\n");

/**
 * The workspace both lists address: one per caller **per repository**.
 *
 * Keyed on the caller *and* the repository because the substrate makes that
 * structural rather than optional — `@cloudflare/computer` pairs one Durable
 * Object with one container, so two repositories cannot share a workspace even
 * if we wanted them to.
 *
 * The repository comes from `activeRepo`, which the repo plugin's
 * `beforeCheckout` sets from the clone URL before any git runs. Before the first
 * clone there is nothing to name, and the fallback is a caller-level workspace —
 * which is only ever used for the moments before a repository has been chosen.
 *
 * The consequence to keep in mind is that a caller's checkout **outlives the
 * task**, which is why `repo_clone` fetches and resets an existing one rather
 * than assuming an empty directory. What does *not* outlive the container is
 * `node_modules`; see `install.ts`.
 */
function container(host: PluginHost<Env>): ComputerConfig {
  const active = activeRepo(host);
  return {
    binding: host.env.CODER_WORKSPACE,
    workspaceName: () => workspaceName(host.callerKey(), active.get()),
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
     * `CoderWorkspaceDO` arms a reinstall the moment it sees a cold container, so
     * by the time a command that needs `node_modules` arrives, the install is
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
     * Note the other end of the same command: `CONTAINER_IDLE_MS` in
     * `workspace-do.ts` must stay above this, or the idle sweeper destroys the
     * container out from under a command still running in it.
     */
    timeoutMs: MAX_TOOL_CALL_MS
  };
}

/**
 * The main agent's capabilities: git, a browser, and eyes on the checkout.
 *
 * Read the `restrictMainAgentTools` call as the point of this file. The computer
 * and browser plugins are **installed** here, they just do not hand the parent
 * their full surface — and installing them is not optional even for the one that
 * gives the parent nothing, because `validateRecipe` runs on the *parent* and
 * drops any tool family the parent's plugins did not register. A parent that
 * "tidied away" a plugin it does not call would silently delete that family from
 * every recipe its subagents run.
 */
export const parentPlugins = (host: PluginHost<Env>): AgentPlugin[] => {
  const config = container(host);
  const active = activeRepo(host);
  const workspace = () =>
    host.env.CODER_WORKSPACE.get(
      host.env.CODER_WORKSPACE.idFromName(
        workspaceName(host.callerKey(), active.get())
      )
    );

  return [
    // Declared first: order in this array is the order the delegating model is
    // shown the subtask types, and `code` is the only one this agent has.
    //
    // It takes the workspace name because it *owns* the `code` type, which makes
    // it the plugin whose `resolveRuntime` core calls — the one hook that runs
    // on the parent, where `host.callerKey()` resolves rather than throwing.
    code({
      workspaceName: () => workspaceName(host.callerKey(), active.get())
    }),
    repo({
      // Composed rather than imported: the repo plugin needs a shell, not a
      // container, so it takes one instead of depending on the computer module.
      // This is also what lets the parent keep git while having no shell of its
      // own — `computerExec` is a function, not a tool.
      exec: computerExec(config),
      token: () => host.env.GITHUB_TOKEN,

      // The two hooks that make per-repository workspaces work, and the order
      // between them is the whole design. `beforeCheckout` fires with the parsed
      // URL *before* git runs, so the clone lands in the right workspace rather
      // than in one it would have to be moved out of. `afterCheckout` fires once
      // the tree is there, which is when an install becomes meaningful.
      beforeCheckout: ({ owner, repo: name }) => active.set(`${owner}/${name}`),
      afterCheckout: async ({ dir, repo: name }) => {
        // Returns as soon as the command is spawned — the workspace object
        // drains it. Blocking here would put a 225-second install inside a
        // model turn, which is the failure this whole arrangement avoids.
        await workspace().startInstall({
          dir,
          ...(name ? { repo: name } : {})
        });
      }
    }),
    restrictMainAgentTools(computer(config), {
      allow: [...PARENT_SANDBOX_TOOLS],
      capability: PARENT_SANDBOX_CAPABILITY
    }),
    // Full surface, for reading documentation an unfamiliar dependency needs.
    // Deliberately last — an agent that reaches for the web before reading the
    // repository in front of it is usually about to solve the wrong problem.
    browser({ binding: host.env.BROWSER })
  ];
};

/**
 * The subagent's capabilities: the shell and the browser, and no git at all.
 *
 * No `repo` here, deliberately. The parent owns the history — it clones,
 * reviews, commits, pushes and opens the pull request — and a subagent sharing
 * the parent's checkout must not also share its ability to rewrite it. Anything
 * a subagent legitimately needs from git (`git status`, `git diff`, `git log`)
 * it can run through `sb_exec`, which is read-only in effect and leaves no
 * credential anywhere near it.
 *
 * `code(...)` **must** be here even though the subagent never delegates:
 * `RecipeSubagentBase` re-checks `types.validateParams(request.type, …)` on its
 * inbound request, which throws `unknown subtask type: code` against a registry
 * that has never heard of it.
 */
export const subagentPlugins = (host: PluginHost<Env>): AgentPlugin[] => {
  const config = container(host);

  return [
    // The name resolves from `ctx.runtime` on a subagent, so this thunk is only
    // a fallback — and on a facet `host.callerKey()` throws, which is exactly
    // why the parent puts the resolved name on the runtime in the first place.
    code({ workspaceName: () => config.workspaceName() }),
    computer(config),
    browser({ binding: host.env.BROWSER })
  ];
};
