import { tool } from "ai";
import { definePlugin, type AgentPlugin } from "@dynamicagents/core";
import { z } from "zod";
import type { computerExec } from "@dynamicagents/plugins/computer";
import type { ActiveRepo } from "./active-repo";
import { WORKSPACE_DIR, type WorkspaceObjectBase } from "./object";

/**
 * A place to work when the work is not a repository.
 *
 * ## The gap this closes
 *
 * Both coding agents in this Worker are built around a checkout: the soul says
 * clone first, the workspace is keyed on the repository, and every delegation
 * runs inside the tree a clone produced. That is right for the work they mostly
 * do and wrong for the rest of it. "Check what this actually returns", "write a
 * script and run it", "try that regex against these twenty lines" all need a
 * container and none of them needs a repository — and with no way to say so, the
 * agent asked its user for an empty one to clone. Which is the request that
 * started this: an empty repository is a workaround for a missing verb.
 *
 * A caller-level workspace already existed for the window before the first
 * clone (`callerKey|<unassigned>`, see `workspaceName`) and is not the answer.
 * It has no git in it, so a cancelled task's edits cannot be reset out of it; it
 * is never enrolled in the weekly reclaim sweep, because that sweep walks the
 * repositories a caller has cloned; and nothing names it, so nothing can say
 * what it is for.
 *
 * ## A scratchpad is a repository whose remote is nowhere
 *
 * That framing is the whole design, and it is why this file is short. Every
 * mechanism a checkout already has applies unchanged:
 *
 * - **Routing.** {@link SCRATCH_REPO} goes through `activeRepo.set()` exactly as
 *   a clone does, so `workspaceName` keys it to its own Durable Object and its
 *   own container, `resolveRuntime` hands that name to a delegated session, and
 *   `@cloudflare/computer`'s one-object-one-container pairing is untouched.
 * - **Cleanup.** `discardWorkingTree` runs `git reset --hard && git clean -fdx`
 *   on a cancelled task. That works here because this really is a git
 *   repository — see the empty commit below, which is what makes it work on the
 *   first task rather than the second.
 * - **Reclaim.** `set()` also puts it in `seen()`, so the weekly sweep covers
 *   it, and the workspace's own seven-day `idle-reclaim` alarm ends it the same
 *   way it ends a checkout. Nothing here needs a lifetime of its own, and that
 *   is the point: a scratchpad with bespoke cleanup is a second thing to get
 *   wrong.
 *
 * ## What it deliberately is not
 *
 * It has no `origin`, so `repo_push` and `repo_open_pr` fail in it — with git's
 * own message, which is honest, and the capability block below says so first so
 * no round is spent finding out. Nothing here is ever pushed anywhere, which is
 * the property that makes it safe to let a session do as it likes in.
 */

/**
 * The repository sentinel a scratchpad is keyed on.
 *
 * Angle brackets because no forge name can contain them: this shares a namespace
 * with `owner/repo` strings from {@link ActiveRepo}, and a sentinel a caller
 * could clone is a sentinel a caller could collide with. It is the same reason
 * `workspaceName` spells the unassigned window `<unassigned>`.
 */
export const SCRATCH_REPO = "<scratch>";

/** Where a scratchpad lives, in the container and in the workspace filesystem. */
export const SCRATCH_DIR = `${WORKSPACE_DIR}/scratch`;

/** How much of a dirty tree is worth reciting back. */
const STATUS_MAX_LINES = 20;

/**
 * A command's outcome, with the one distinction `success` cannot carry.
 *
 * `unreachable` means the command never ran, which is not the same answer as
 * "it ran and said no" — the same separation `/repo` keeps, and for the same
 * reason: three branches here would otherwise read a lost container as a fact
 * about the scratchpad.
 */
interface ScratchRun {
  success: boolean;
  stdout: string;
  stderr: string;
  unreachable?: true;
}

export interface ScratchConfig {
  /** A shell in the workspace — `computerExec(config)`, the same one `/repo` gets. */
  exec: ReturnType<typeof computerExec>;
  /** The workspace object the active selection currently resolves to. */
  workspace: () => DurableObjectStub<WorkspaceObjectBase>;
  /** Where the selection is made, and the reason this must run before anything else. */
  active: ActiveRepo;
  /** Whose name the scratchpad's commits carry. Matches the repo plugin's author. */
  author: { name: string; email: string };
}

/**
 * What the delegating agent is told, and the two lines that stop a wasted round.
 *
 * The mixing rule is the one worth the tokens. A workspace selection is one row
 * per caller (see `active-repo.ts`), so opening a scratchpad mid-task points the
 * task's *other* tools — `repo_diff`, the commit, the push — at the scratchpad
 * instead of at the checkout they were reading a moment ago. That is a
 * documented limitation of the selection rather than something this plugin can
 * fix, so the model is told the rule instead of being allowed to discover it.
 */
const SCRATCH_CAPABILITY = [
  "## A scratchpad, for work that is not a repository",
  "",
  "`scratch_open` gives you a container to work in without cloning anything: a",
  "git repository at `" +
    SCRATCH_DIR +
    "` with no remote. Reach for it when the",
  "request needs code to *run* rather than a repository to change — checking what",
  "something actually returns, writing and running a throwaway script, trying an",
  "approach out before committing to it.",
  "",
  "Open it, then delegate the work as usual; the session runs in it exactly as it",
  "would in a checkout. It is durable, so a later task finds whatever the last one",
  "left there, and it is reclaimed once nothing has touched it for a week. Pass",
  "`reset: true` to start from an empty tree.",
  "",
  "**Nothing in it is ever pushed.** There is no remote, so there is no branch to",
  "push and no pull request to open — the work itself, and what you learned from",
  "it, is the deliverable. Say so plainly when you report back.",
  "",
  "**One task works in one place.** A task is either working in a cloned",
  "repository or in the scratchpad. Opening the scratchpad points every other tool",
  "you hold at it, so do not open it part-way through work on a checkout — finish",
  "that first."
].join("\n");

/**
 * Create a scratchpad that does not exist yet.
 *
 * **The empty commit is load-bearing.** Without it the repository has no `HEAD`,
 * and `git reset --hard` — which is what `discardWorkingTree` runs when a task
 * is cancelled — fails with `fatal: Failed to resolve 'HEAD'`. That cleanup is
 * best-effort by design, so the failure would be a logged warning and a
 * scratchpad still holding a cancelled session's half-written files, which the
 * next task then inherits as its starting point. One commit at creation closes
 * it.
 *
 * The identity arrives through the environment rather than in the command text,
 * so a configured name containing a quote is a value rather than shell syntax,
 * and it is set repo-locally for the reason `repo_clone` sets it there: a global
 * identity in this container would attach itself to any other repository sharing
 * it.
 */
const INIT_COMMAND = [
  `mkdir -p "${SCRATCH_DIR}"`,
  `cd "${SCRATCH_DIR}"`,
  "git init -q",
  'git config user.name "$GIT_NAME"',
  'git config user.email "$GIT_EMAIL"',
  'git commit -q --allow-empty -m "scratchpad"'
].join(" && ");

/**
 * The scratchpad tool, for a host that already has a shell and a workspace.
 *
 * It lives here rather than in `@dynamicagents/plugins` because what a scratchpad
 * *is* — the sentinel, the directory, the enrolment in this deployment's reclaim
 * sweep — is a fact about how this Worker keys its workspaces, not about
 * containers in general.
 */
export function scratch(config: ScratchConfig): AgentPlugin {
  /**
   * The seam where an unreachable container stops being an exception.
   *
   * `computerExec` throws when the object or the container cannot be reached,
   * and every branch below has to tell that apart from a command that ran and
   * failed — read as "there is no repository here", a lost connection would
   * re-init over a scratchpad that is fine and discard what was in it. The same
   * distinction `/repo` draws, for the same reason, at the same kind of seam.
   */
  const run = async (
    command: string,
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<ScratchRun> => {
    try {
      return await config.exec(command, { cwd: SCRATCH_DIR, ...options });
    } catch (err) {
      console.warn("[scratch] the container could not be reached", {
        command,
        err: String(err)
      });
      return {
        success: false,
        stdout: "",
        stderr: String(err),
        unreachable: true
      };
    }
  };

  return definePlugin({
    key: "scratch",
    capability: SCRATCH_CAPABILITY,
    mainAgentTools: () => ({
      scratch_open: tool({
        description:
          "Open a scratchpad: a git repository with no remote, in your container, " +
          "for work that does not need a cloned repository. Use it before " +
          "delegating anything that needs to run code but has no repository to " +
          "change. Nothing in it is ever pushed.",
        inputSchema: z.object({
          reset: z
            .boolean()
            .optional()
            .describe(
              "Discard everything in the scratchpad first, including files an earlier task left"
            )
        }),
        execute: async ({ reset }) => {
          /**
           * First, and before anything that resolves a workspace name.
           *
           * The same ordering `repo_clone` gets from `beforeCheckout`, and for
           * the same reason: `exec` and `workspace()` below both go through the
           * active selection, so a command issued before this line runs in
           * whichever workspace the last task left open.
           */
          config.active.set(SCRATCH_REPO);

          const existing = await run("git rev-parse --git-dir");
          if (existing.unreachable) {
            return (
              "could not reach the container to open the scratchpad: " +
              `${existing.stderr.trim() || "no answer"}\n` +
              "Nothing was created or changed. Try again in a moment."
            );
          }

          let fresh = false;
          if (!existing.success) {
            // From the workdir, not from the scratchpad: the first thing this
            // command does is create the directory the others run in.
            const init = await run(INIT_COMMAND, {
              cwd: WORKSPACE_DIR,
              env: {
                GIT_NAME: config.author.name,
                GIT_EMAIL: config.author.email
              }
            });
            if (!init.success) {
              return (
                `could not create the scratchpad at ${SCRATCH_DIR}: ` +
                `${init.stderr.trim() || init.stdout.trim() || "git init failed"}`
              );
            }
            fresh = true;
          } else if (reset) {
            const cleaned = await run("git reset --hard -q && git clean -fdxq");
            if (!cleaned.success) {
              return (
                `the scratchpad at ${SCRATCH_DIR} could not be reset: ` +
                `${cleaned.stderr.trim() || cleaned.stdout.trim() || "git failed"}\n` +
                "It is still there and still usable, but it holds whatever it held before."
              );
            }
          }

          /**
           * Record it where a delegation will look.
           *
           * This is the whole reason a scratchpad can be delegated into at all:
           * `checkoutDir()` answers from the checkout record, and a scratchpad
           * has no install to write one as a side effect — a directory with no
           * `package.json` is precisely the case the install resolver skips.
           *
           * `present` is the same probe the delegation itself will make, so a
           * container whose filesystem has not caught up is reported here, in a
           * tool result the model can act on, rather than as a subtask that
           * refuses a scratchpad this call just said it had opened.
           */
          const noted = await config.workspace().noteCheckout({
            dir: SCRATCH_DIR,
            kind: "scratch"
          });
          if (!noted.present) {
            return (
              `the scratchpad at ${SCRATCH_DIR} was ${fresh ? "created" : "opened"}, but the ` +
              `workspace cannot see it yet. Call scratch_open again before delegating.`
            );
          }

          const opened = fresh
            ? `Opened a new scratchpad at ${SCRATCH_DIR}.`
            : reset
              ? `Opened the scratchpad at ${SCRATCH_DIR} and emptied it.`
              : `Reopened the scratchpad at ${SCRATCH_DIR}, which an earlier task may have left files in.`;

          return [
            opened,
            "It is a git repository with no remote, so nothing in it is pushed anywhere.",
            await describeTree(run, fresh || reset === true)
          ]
            .filter(Boolean)
            .join(" ");
        }
      })
    })
  });
}

/**
 * What is in the tree, in one sentence.
 *
 * Worth a command because the alternative is the model assuming an empty
 * scratchpad and delegating a brief written for one — the checkout tools carry
 * the same warning for the same reason ("it may already contain work from an
 * earlier task — check before assuming it is empty"). Skipped when this call is
 * what made it empty, since there is nothing to report and no reason to pay for
 * the round trip.
 */
async function describeTree(
  run: (command: string) => Promise<ScratchRun>,
  knownEmpty: boolean
): Promise<string> {
  if (knownEmpty) return "It is empty.";
  const listed = await run("git status --porcelain");
  // Silence rather than a guess: the scratchpad is open either way, and "it is
  // empty" would be a claim this command did not support.
  if (!listed.success) return "";
  const lines = listed.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return "Its working tree is clean.";
  const shown = lines.slice(0, STATUS_MAX_LINES).join("\n");
  const rest =
    lines.length > STATUS_MAX_LINES
      ? `\n… and ${lines.length - STATUS_MAX_LINES} more`
      : "";
  return `It currently holds:\n${shown}${rest}`;
}
