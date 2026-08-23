import { DurableObject, tracing } from "cloudflare:workers";
// One Durable Object has one alarm, and this object wakes for five different
// reasons. `WakeMap` is the multiplexer; what it does *not* own is what this
// object owes on waking, which is `#dispatch` below.
import { WakeMap, type WakeIntent } from "@loopingai/core/alarm";
// The sibling barrel: `WakeMap` owns *when* this object wakes, `JobLifecycle`
// owns what the install owes on waking.
import { JobLifecycle, type JobContext } from "@loopingai/core/job";
import {
  Workspace,
  type DurableObjectStorageLike,
  type SyncRetryIntent,
  type SyncRetryScheduler,
  type WorkspaceEgressPolicy,
  type WorkspaceOptions,
  type WorkspaceRuntimeExecHandle,
  type WorkspaceStub
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer
} from "@cloudflare/computer/backends/container";
import {
  createGitClient,
  type AuthCallback,
  type GitClient
} from "@cloudflare/computer/git";
import { createCloudflareObserver } from "@cloudflare/computer/observe/cloudflare";
import {
  installFingerprint,
  pathExists,
  resolveInstallCommand,
  truncateOutput,
  type InstallPlan,
  type InstallProbe,
  type InstallState
} from "@loopingai/plugins/computer";
// The shape `/repo` already defines for exactly this: a git failure is data,
// because it means git answered. A throw on this path means the object was
// unreachable, which is a different thing and must stay distinguishable.
import type { RepoGitResult } from "@loopingai/plugins/repo";

/**
 * A workspace: one Durable Object, one container, one repository.
 *
 * **Shared by every agent in this Worker that has a container**, which today is
 * `coder` and `claude-coder`. Each subclasses {@link WorkspaceObjectBase} and
 * supplies three values — its wrangler binding name, its egress policy and a log
 * label — and inherits everything else. The two objects were byte-identical
 * apart from those three, and the second was going to be a copy of ~1500 lines
 * whose comments record failures that cost production time to find; a copy of
 * that drifts in whichever direction the object nobody redeployed recently went.
 *
 * It lives in `src/workspace/` rather than in either agent's directory because
 * `verify:isolation` fails an agent that imports a sibling's module: the
 * sibling's plugins come with it. Anything two agents share belongs here or at
 * the top level, never inside one of them.
 *
 * `@cloudflare/computer` pairs a SQLite-backed virtual filesystem in *this*
 * object's storage with a container running `computerd`, which mounts it over
 * FUSE at `/workspace`. Commands run against the same tree the Worker reads over
 * RPC, and the tree outlives the container — which is why this replaced
 * `@cloudflare/sandbox`, whose disk died with the container and whose R2
 * snapshot path needed S3 credentials a Workers binding cannot supply.
 *
 * **One repository per object**, because `computer` is strictly 1 DO ↔ 1
 * container: the id derives from caller *and* repository (see `workspaceName`),
 * so two repositories for one caller are two objects and two containers.
 *
 * **It constructs `Workspace` rather than using `withWorkspace`.** The mixin
 * stores the `Workspace` under a module-private symbol the package does not
 * export, so a method on the object cannot reach it — and two things the host is
 * required to do live there and are absent from the `WorkspaceClient` it hands
 * back: `retryPendingSync` (the library "does not own your DO's alarm") and the
 * direct `runtime` access the detached install needs. So this object owns the
 * `Workspace` and implements the one method the mixin otherwise provides,
 * `__getWorkspaceStub`. Callers outside see no difference.
 */

/** Where every checkout lives, inside the container and in the VFS. */
export const WORKSPACE_DIR = "/workspace";

/**
 * The Durable Object name for one caller's checkout of one repository.
 *
 * Exported because several places must agree on it and none can see the others:
 * the plugin that resolves the stub, the agent that hands it down to subagents,
 * and the cancellation path. A pipe rather than a slash, so the caller half
 * cannot forge a repository boundary by containing one.
 *
 * `repo` is undefined only before the first `repo_clone` of a session — the
 * repository is model-chosen, so there is genuinely nothing to key on until it
 * has chosen. That window resolves to a caller-level workspace, which is never
 * cloned into: `beforeCheckout` sets the repository before any git runs.
 */
export function workspaceName(callerKey: string, repo?: string): string {
  return repo ? `${callerKey}|${repo}` : `${callerKey}|<unassigned>`;
}

// --- what this object wakes for, and when ----------------------------------

/**
 * The install's job id, which is also the key its state record lives under.
 *
 * Every other key is derived from it by `JobLifecycle`: `install:armed`,
 * `install:last-armed`, `install:context`, and the wake intents `install-run`
 * and `install-watch`. Changing this value renames all of them, which is a
 * storage migration — the specs that read these keys directly would fail first.
 */
const INSTALL_KEY = "install";

/**
 * How long after arming an install before arming another.
 *
 * Arming is self-limiting for a *successful* install — it writes `running`, and
 * a finished one leaves `done` with the container up, so the cheap
 * `container.running` check short-circuits every later call. A **failing** one
 * has no such property: it lands back on `failed`, the container is still down,
 * and the next `__getWorkspaceStub` would arm again. That is the busiest entry
 * point in the object, so "again" means on essentially every tool call.
 *
 * This is the bound. Five minutes is longer than a whole task and far longer
 * than an install (88s measured), so a genuinely broken container retries at
 * roughly the rate a human would, while a task starting twenty minutes later
 * still gets a fresh attempt without anyone clearing anything.
 */
const INSTALL_ARM_COOLDOWN_MS = 5 * 60_000;

/** How often the watchdog checks on a running install. */
const INSTALL_WATCH_MS = 60_000;

/**
 * How far past its own timeout a `running` install is still given the benefit of
 * the doubt.
 *
 * Generous on purpose. Declaring a live install dead costs a duplicate `npm ci`;
 * the margin only has to be wider than the slack between the runtime killing a
 * command and this object hearing about it.
 */
const INSTALL_STALE_MS = 5 * 60_000;

/**
 * What the install records about itself, alongside the state record.
 *
 * `startedAt` is core's, and it is the generation marker: a drain compares the
 * stamp it captured against the stamp on disk, and a mismatch means it has been
 * superseded. The rest is this install's own — `dir` because a cold container
 * has no caller to ask, `repo` so a repository with an `INSTALL_PLAN` override
 * resolves the same command the second time, `fingerprint` for the skip
 * condition, and `command` so a re-attach can name what it is waiting on.
 */
interface InstallContext extends JobContext {
  dir: string;
  repo?: string;
  fingerprint: string | null;
  command: string;
}

/** The wake intent that reclaims a workspace nobody has touched. */
const IDLE_RECLAIM = "idle-reclaim";

/**
 * How long a workspace survives without being used.
 *
 * A Durable Object is **never** reclaimed by the platform: it exists as long as
 * its storage does, and a namespace cannot be enumerated from a Worker, so
 * nothing else is coming to clean up. Source-only workspaces are small — 6.3 MB
 * for looping-gateway — which makes this hygiene rather than cost control, but
 * unbounded hygiene is still unbounded.
 */
const IDLE_RECLAIM_MS = 7 * 24 * 60 * 60 * 1000;

/** The wake intent that stops a container nobody is using. */
const CONTAINER_IDLE = "container-idle";

/**
 * How long a container stays up after the last command **started**.
 *
 * No `sleepAfter` to lean on: `withWorkspaceContainer` wraps the runtime's raw
 * `ctx.container`, not `@cloudflare/containers`' `Container`, so idle shutdown is
 * ours to schedule.
 *
 * **This must exceed the longest command the shell allows**, and breaking that
 * kills work in flight. The idle clock is armed by `#touch()` on the way *into*
 * this object; a command touches once and then nothing touches again until it
 * finishes, since `handle.result()` is one long await and the FUSE traffic under
 * it never surfaces as an RPC. So the window is measured from when a command
 * starts, not when it ends.
 *
 * At the previous ten minutes that window was **exactly** the computer plugin's
 * `DEFAULT_TIMEOUT_MS` — two timers of the same length started moments apart,
 * and whichever fired first destroyed the container the other depended on.
 * Reported as "repeated exec-backend crashes/restarts": `npm run check` (28 s
 * measured) always survived, a full `npm test` never did.
 *
 * Twenty minutes is double that ceiling. Raise it — never lower it — if
 * `sb_exec` is ever given a longer timeout.
 *
 * **The default, not the policy.** An agent whose longest command runs longer
 * than this must say so via {@link WorkspaceObjectConfig.containerIdleMs},
 * because the rule above is about the agent rather than about this base class:
 * `claude-coder` holds one `claude -p` session open for its whole 40-minute
 * timeout, and at twenty minutes the container would be stopped out from under a
 * live session. Chunk boundaries re-enter this object and `#touch()`, which
 * mostly hides that — but "mostly" is not the guarantee this constant is
 * documented to give, and a retried or delayed chunk is all it takes.
 */
const CONTAINER_IDLE_MS = 20 * 60_000;

/**
 * Refuse to grow past this, of the 10 GB a Durable Object may hold.
 *
 * Source-only workspaces run at ~6 MB, so this should never fire — which is
 * exactly why it is worth having. If something does start pulling a large tree
 * in, a sentence naming the number beats a write failing somewhere unrelated
 * with nothing to connect it to.
 */
const STORAGE_CAP_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * The exec id an install runs under.
 *
 * Fixed rather than generated, because the point is to find it again: an
 * isolate that dies mid-drain leaves the command running in the container, and
 * `getExec(id, { resume: "tail" })` is how the next invocation re-attaches
 * instead of starting a second `npm ci` alongside the first.
 */
const INSTALL_EXEC_ID = "dependency-install";

/** The wake key for one backend's pending pull. */
const syncRetryKey = (backend: string): string => `sync-retry:${backend}`;

/**
 * The library's persistence hook, over the wake map.
 *
 * `Workspace` calls this itself: `schedule` after a post-command pull fails,
 * `clear` after one finally succeeds. All this side owns is where the intent
 * lives and when the object wakes to act on it.
 */
function syncRetryScheduler(wake: WakeMap): SyncRetryScheduler {
  return {
    async get(backend: string): Promise<SyncRetryIntent | undefined> {
      const intent = await wake.get(syncRetryKey(backend));
      if (!intent) return undefined;
      return {
        backend,
        attempt: intent.attempt ?? 0,
        notBefore: intent.notBefore
      };
    },
    async schedule(intent: SyncRetryIntent): Promise<void> {
      await wake.set({
        key: syncRetryKey(intent.backend),
        notBefore: intent.notBefore,
        attempt: intent.attempt
      });
    },
    async clear(backend: string): Promise<void> {
      await wake.clear(syncRetryKey(backend));
    }
  };
}

// --- the object -------------------------------------------------------------

/**
 * The container half.
 *
 * `withWorkspaceContainer` adds one method, `getWorkspaceContainer()`, over
 * `this.ctx.container` — the runtime's own container handle. There is no
 * `@cloudflare/containers` `Container` subclass here and so no `sleepAfter`:
 * idle shutdown is this object's job, and it lands on the wake map with
 * everything else.
 */
const WorkspaceContainerBase = withWorkspaceContainer(
  class extends DurableObject<Env> {}
);

/**
 * The three things one workspace object does not share with the other.
 *
 * Everything else about a workspace is identical between agents, which is why
 * this interface is short and why it is worth having at all: a seam this narrow
 * makes "what is different about this agent's container" a question with a
 * complete answer in one place.
 */
export interface WorkspaceObjectConfig {
  /**
   * The wrangler Durable Object binding this class is bound as.
   *
   * Not cosmetic and not derivable: `computerd` dials **back** through it. The
   * backend builds the container's loopback from this name plus the object id,
   * so a wrong one produces a container that starts, mounts nothing and fails
   * at the first command with no mention of a binding.
   */
  binding: string;
  /**
   * Where this workspace's container may send traffic, and through what.
   *
   * `direct` is the plain behaviour: the container's own network position.
   * `http-gateway` routes **everything** through a `Fetcher` this Worker
   * supplies, which is what puts the Worker on the model path — see
   * `@loopingai/plugins/claude-code`.
   *
   * **Required in practice, and its absence is silent.** `@cloudflare/computer`
   * 0.2.0 made this a policy defaulting to `{ mode: "none" }`, and the backend
   * derives the container's network flag from it. Omit it and the container
   * comes up with no network at all: the workspace mounts, commands run, and
   * the install dies on a registry it cannot reach with nothing naming egress
   * as the cause.
   */
  egress: WorkspaceEgressPolicy;
  /** How this deployment installs dependencies for this agent's checkouts. */
  installPlan: InstallPlan;
  /** Log prefix — `coder-workspace`, `claude-coder-workspace`. */
  label: string;
  /**
   * How long this agent's container stays up after the last command **started**.
   *
   * A per-agent value because the invariant on {@link CONTAINER_IDLE_MS} — it
   * must exceed the longest command the shell allows — is an invariant about the
   * *agent*, and the two differ by a factor of four. The coder's longest command
   * is a tool call; `claude-coder`'s is a whole `claude -p` session that runs
   * detached for its entire timeout.
   *
   * Omit it for the default. Raise it, never lower it, and raise it whenever the
   * agent's longest command grows.
   */
  containerIdleMs?: number;
}

/**
 * One caller's checkout of one repository, and the container that mounts it.
 *
 * Abstract because a Durable Object class takes no constructor arguments, so
 * per-agent configuration cannot arrive that way. {@link workspaceConfig} is the
 * seam, and it is the shape core's own `RecipeSubagentBase.subagentRuntime`
 * uses for exactly the same reason.
 *
 * ## Why `backend` and `#workspace` are lazy
 *
 * **Base class fields run before subclass fields**, so as plain fields they
 * would read `undefined` from any `workspaceConfig()` that touches a subclass
 * field — which `ClaudeCoderWorkspaceDO`'s does, for its credential store.
 * Memoised getters remove the hazard rather than documenting it, which is what
 * lets a subclass implement the seam however it likes.
 */
export abstract class WorkspaceObjectBase extends WorkspaceContainerBase {
  /**
   * Everything this agent's workspace does differently. Called once, lazily.
   *
   * Read through {@link #cfg}, never directly: an implementation may build
   * something real — `claude-coder`'s constructs its egress gateway — and this
   * is consulted on the busiest path in the object.
   */
  protected abstract workspaceConfig(): WorkspaceObjectConfig;

  #configMemo?: WorkspaceObjectConfig;

  get #cfg(): WorkspaceObjectConfig {
    return (this.#configMemo ??= this.workspaceConfig());
  }

  /** This object's log prefix, so two workspaces stay tellable apart. */
  get #tag(): string {
    return this.#cfg.label;
  }

  /**
   * How long an install may run before it is killed.
   *
   * Read from the plan in three places, which is why it is a getter: the
   * fallback has to be the same number in all three, and a `??` repeated three
   * times is three chances to write a different one.
   */
  /** This agent's container-idle window — see {@link WorkspaceObjectConfig}. */
  get #containerIdleMs(): number {
    return this.#cfg.containerIdleMs ?? CONTAINER_IDLE_MS;
  }

  get #installTimeoutMs(): number {
    return this.#cfg.installPlan.timeoutMs ?? 20 * 60_000;
  }

  readonly #wake = new WakeMap(this.ctx.storage);

  /**
   * The dependency install, as a job this object owns through its alarm.
   *
   * `JobLifecycle` is core's, and what it owns is the choreography that is wrong
   * in the same four ways every time: arming before anything runs, one job at a
   * time under a staleness bound, a drain that can outlive its job, and a job
   * nobody is draining. The three timings below are this install's. The **drain
   * loop stays here**, because an install runs to completion and writes a single
   * verdict rather than reporting progress between bounded windows.
   *
   * **The alarm runs the install, and that is not a detail.** An install takes
   * ~85 seconds and must not be owned by the request that noticed it was needed:
   * an earlier attempt handed one to `ctx.waitUntil` from a gate poll that
   * returned in milliseconds, and the drain was disposed underneath it
   * mid-`npm ci`. An alarm invocation belongs to the object rather than to any
   * caller, so nothing it awaits can be cut short by a response being sent.
   *
   * **Arming writes `running` before anything is running**, which is what holds
   * the gate shut in the moments before the alarm fires. `#beginInstall` then
   * refuses to start while a `running` record stands, and is right to — that
   * guard is what stops two `npm ci` processes sharing one
   * {@link INSTALL_EXEC_ID} and writing each other's verdicts. So the alarm
   * presents the stamp arming wrote to `claim`, which recognises its own
   * placeholder and nothing else; taking over any `running` record instead would
   * reintroduce the displacement bug the guard exists to prevent.
   */
  readonly #install = new JobLifecycle<{ command: string }, InstallContext>({
    id: INSTALL_KEY,
    storage: this.ctx.storage,
    wake: this.#wake,
    staleMs: INSTALL_STALE_MS,
    watchMs: INSTALL_WATCH_MS,
    armCooldownMs: INSTALL_ARM_COOLDOWN_MS
  });

  /**
   * The container backend.
   *
   * `container: () => this` hands the backend this object's own container.
   * `workspace` is how `computerd` dials *back* in: the runtime builds a loopback
   * binding from the exported `WorkspaceProxy` class and these two values, which
   * is why `src/index.ts` re-exports it and why dropping that export breaks the
   * container with no compile error.
   *
   * Nothing sets `egressHost`; the default `computer.internal` is the host the
   * container's outbound HTTP is intercepted on, internal to that loopback.
   *
   * The binding name and the egress policy are the subclass's — see
   * {@link WorkspaceObjectConfig}, which carries the warnings that used to live
   * on this comment.
   */
  #backendMemo?: CloudflareContainerBackend;

  get backend(): CloudflareContainerBackend {
    return (this.#backendMemo ??= new CloudflareContainerBackend({
      container: () => this,
      workspace: {
        binding: this.#cfg.binding,
        id: this.ctx.id.toString()
      },
      egress: this.#cfg.egress
    }));
  }

  #workspaceMemo?: Workspace;

  get #workspace(): Workspace {
    return (this.#workspaceMemo ??= new Workspace(this.#workspaceOptions()));
  }

  #workspaceOptions(): WorkspaceOptions {
    return {
      // `ctx.storage.sql.exec` returns a narrower row type than
      // `DurableObjectStorageLike` declares and the two are invariant, so the
      // cast goes through `unknown`. The runtime shapes match; this is the
      // pattern the package's own example uses.
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      backends: [this.backend],
      // Required, not optional. Without it a post-command pull that fails has
      // nowhere to record itself and nothing to resume it, and the container
      // keeps edits the workspace never sees.
      retryScheduler: syncRetryScheduler(this.#wake),
      // One span per sync push, sync pull, exec spawn and filesystem op, into
      // the same Workers Observability view the rest of this Worker traces to.
      // Needs `observability.traces.enabled` in wrangler.jsonc; without the
      // feature flag `tracing` is undefined and this degrades to a no-op.
      observer: createCloudflareObserver({ tracing }),
      // Git, running **here** rather than in the container.
      //
      // This is what lets the forge token stay on this side of the boundary.
      // `createGitClient` binds isomorphic-git to `provider()` — the local
      // SQLite store, not the wire — so a clone, fetch or push executes next to
      // the data it writes, and the container never holds a credential at all.
      // The alternative it replaces ran credentialed `git` in the container and
      // had to build a disposable git dir per operation to survive the fact that
      // git executes whatever `.git/config` and `.git/hooks` name.
      //
      // Needs `@platformatic/vfs`, an optional peer of `@cloudflare/computer`:
      // the adapter that wraps `provider()` into an isomorphic-git FsClient
      // imports it lazily and throws a named error when it is absent.
      git: createGitClient(),
      // Only the commit-producing subcommands read this, and the three
      // operations driven from here — clone, fetch, push — are not among them.
      // Set anyway so that a `pull` or `merge` added later fails on the merge
      // itself rather than on `MissingIdentityError`, and set to the same pair
      // `/repo` writes into the checkout's own config at clone time, so a commit
      // cannot be attributed differently depending on which side made it.
      defaultGitIdentity: {
        name: "looping-coder",
        email: "coder@looping.invalid"
      }
    };
  }

  /**
   * Repair a lost alarm on the way in.
   *
   * The one failure the wake map cannot defend against from the inside: the
   * runtime retries a throwing `alarm()` a bounded number of times and then
   * stops for good, and a deleted-class migration takes the alarm with the
   * storage. Both leave intents sitting in the map with nothing coming for them,
   * and the symptom is silence.
   *
   * So every RPC into this object checks. That fully covers `sync-retry`,
   * `install-watch` and `container-idle`, which only matter while somebody is
   * using the workspace. It does **not** cover `idle-reclaim`, which by
   * definition fires when nobody is — that one has the agent's weekly cron
   * poking `reclaimIfIdle` as its backstop.
   */
  async #repairAlarm(): Promise<void> {
    try {
      await this.#wake.rearm();
    } catch (err) {
      console.error(`[${this.#tag}] could not repair the alarm`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
    }
  }

  /**
   * What `getWorkspace(stub)` calls from outside this object.
   *
   * The one piece of `withWorkspace` reimplemented here — see the file comment
   * for why the mixin is not used. `ready()` first, because the stub is only
   * meaningful once the workspace has opened its store.
   */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    // The busiest entry point by far, and therefore the one that keeps both the
    // idle clock and the alarm honest.
    await this.#touch();
    await this.#repairAlarm();
    await this.#armInstallIfCold();
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  /**
   * Clone, fetch and push — the three operations that need the forge token.
   *
   * They live here rather than on the `WorkspaceStub` the plugin already holds
   * because `WorkspaceGitStub` exposes only `cli(argv)` across a Durable Object
   * boundary, and argv cannot carry an `onAuth` callback. Routed through here,
   * the credential is read from *this* object's `env` and never crosses an RPC
   * boundary, never appears in an argument list, and never enters the container.
   *
   * That last clause is the point. The previous arrangement ran credentialed
   * `git` inside the container and built a disposable bare git dir per operation,
   * because git executes whatever `.git/config` and `.git/hooks` name and the
   * model has a root shell on that filesystem. It closed the durable form of the
   * attack but not the window where the token sat in a container process's
   * environment, readable through `/proc`. isomorphic-git runs here and has no
   * hooks, no `ext::` transport, no template directory and no credential helpers.
   *
   * Each takes `url` explicitly rather than a remote name: resolving `origin`
   * would read `.git/config`, a workspace file a co-installed shell tool can
   * write.
   */
  async gitClone(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    branch?: string;
    depth?: number;
  }): Promise<RepoGitResult> {
    return this.#git(req.allowedHosts, async (git, onAuth) => {
      // Spelled out rather than `git.clone`, and the reason is the credential.
      //
      // `clone` is the one network operation the client does not give an
      // `onAuth` callback — it authenticates only through a `headers` option,
      // which means attaching the token to the very first request to a URL the
      // *model* chose. Composing the same work out of `fetch` puts every
      // credentialed request on this side of `onAuth` instead, where the host is
      // checked at the moment the token would be handed over. The cost is four
      // calls instead of one; `clone` is these four.
      await git.init({ dir: req.dir });
      await git.remoteAdd({
        dir: req.dir,
        name: "origin",
        url: req.url,
        force: true
      });
      const fetched = await git.fetch({
        url: req.url,
        dir: req.dir,
        onAuth,
        // `depth: 0` means full history to isomorphic-git, so a caller that
        // asked for nothing gets the shallow default rather than the whole repo.
        depth: req.depth ?? 1,
        singleBranch: true,
        tags: false,
        ...(req.branch ? { ref: req.branch } : {})
      });
      const landed =
        req.branch ?? fetched.defaultBranch?.replace(/^refs\/heads\//, "");
      if (!landed)
        throw new Error(
          `cloned ${req.url} but the remote named no default branch to check out`
        );
      await git.checkout({ dir: req.dir, ref: landed });
      // What a real `git clone` writes and the container's git will look for:
      // without it the branch tracks nothing, and a subagent reaching for a bare
      // `git status` in the shell sees a branch with no upstream.
      await git.configSet({
        dir: req.dir,
        path: `branch.${landed}.remote`,
        value: "origin"
      });
      await git.configSet({
        dir: req.dir,
        path: `branch.${landed}.merge`,
        value: `refs/heads/${landed}`
      });
      return landed;
    });
  }

  async gitFetch(req: {
    url: string;
    dir: string;
    allowedHosts: string[];
    depth?: number;
  }): Promise<RepoGitResult> {
    return this.#git(req.allowedHosts, async (git, onAuth) => {
      const result = await git.fetch({
        url: req.url,
        dir: req.dir,
        onAuth,
        prune: true,
        tags: false,
        singleBranch: false,
        ...(req.depth ? { depth: req.depth } : {})
      });
      return `fetched ${req.url} (default branch ${result.defaultBranch ?? "unknown"})`;
    });
  }

  async gitPush(req: {
    url: string;
    dir: string;
    branch: string;
    allowedHosts: string[];
  }): Promise<RepoGitResult> {
    return this.#git(req.allowedHosts, async (git, onAuth) => {
      const result = await git.push({
        url: req.url,
        dir: req.dir,
        ref: req.branch,
        remoteRef: req.branch,
        onAuth
        // No `force`, ever, and not a knob: `/repo` refuses anything but a plain
        // branch name precisely so that a push cannot be turned into a force
        // push, and this is the other end of that promise.
      });
      // isomorphic-git reports a rejected push in the *result* rather than by
      // throwing — a non-fast-forward comes back `ok: false` with the reason on
      // the ref. Reading only the absence of an exception would report every
      // rejected push as a success, in the one plugin whose entire theme is that
      // a failed command is not a completed operation.
      if (!result.ok) {
        const perRef = Object.entries(result.refs)
          .filter(([, status]) => !status.ok)
          .map(([ref, status]) => `${ref}: ${status.error ?? "rejected"}`)
          .join("; ");
        throw new Error(
          result.error ?? perRef ?? "the remote rejected the push"
        );
      }
      return `pushed ${req.branch} to ${req.url}`;
    });
  }

  /**
   * The shared body: entry-point bookkeeping, the credential, and the translation
   * back into something that survives RPC.
   *
   * A thrown `GitError` loses its prototype crossing a Durable Object boundary,
   * so `instanceof` on the far side is not available and the caller would be left
   * pattern-matching a string. The `code` is lifted here, while the error is
   * still itself, and travels as data.
   */
  async #git(
    allowedHosts: string[],
    body: (git: GitClient, onAuth: AuthCallback) => Promise<string>
  ): Promise<RepoGitResult> {
    await this.#touch();
    await this.#repairAlarm();
    await this.#workspace.ready();

    // Bound to the credential rather than checked before the call, which is
    // strictly stronger: this is the moment the token would be handed over, and
    // it sees the URL git actually authenticated against — including one it
    // reached by redirect. A host nobody allowed gets no credential and the
    // request fails unauthenticated, rather than the token being offered to it
    // and *then* the mistake being noticed.
    const onAuth: AuthCallback = (url) => {
      let host: string;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return {};
        host = parsed.hostname;
      } catch {
        return {};
      }
      if (!allowedHosts.includes(host)) {
        console.warn(`[${this.#tag}] refused to authenticate to a host`, {
          host
        });
        return {};
      }
      return { username: "x-access-token", password: this.env.GITHUB_TOKEN };
    };

    try {
      return { ok: true, detail: await body(this.#workspace.git, onAuth) };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      return {
        ok: false,
        ...(typeof code === "string" ? { code } : {}),
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /**
   * Start a dependency install the moment we can see one will be needed.
   *
   * The signal is `container.running`, and it is free: `node_modules` lives in
   * the container and dies with it, so a stopped container plus a `done` record
   * is not ambiguous — the tree that record describes is gone. The getter is
   * synchronous, so the warm path costs one boolean and touches no storage.
   *
   * Armed here because `__getWorkspaceStub()` is reached before any command
   * runs, which is the earliest honest moment in a task. The model spends its
   * first minute reading the README and running `git status`, none of which
   * needs dependencies — an install armed here runs *through* that minute, where
   * one armed on the first `npm` command charges its full 85 seconds to that
   * command.
   *
   * It writes `running` before anything is running because the alarm has not
   * fired yet, and a `done` record would let an `npm` command through against a
   * tree that is not there. That also makes the method self-limiting: the next
   * call sees `running` and stops, so the busiest entry point in the object arms
   * at most once per cold container. The staleness bound in {@link #installState}
   * covers an alarm that never fires; the watch intent covers one that dies
   * part-way.
   */
  async #armInstallIfCold(): Promise<void> {
    // Running container: whatever the record says about `node_modules`, it is
    // still true. This is the branch that runs on almost every call.
    if (this.ctx.container?.running) return;

    /**
     * Narrowed to `done` **or** `failed` to read `state.command` — the command
     * the placeholder has to carry, since the gate renders it while the alarm is
     * still pending. Core's `isRearmable` is the authority on *which* states may
     * re-arm and re-checks this inside {@link JobLifecycle.arm}; this is
     * deliberately the same pair, for the reason recorded below.
     *
     * Arming used to require `done` alone, on the reasoning that re-driving a
     * failed install would loop. That reasoning belonged to an earlier design
     * where the check ran on *every* gated command; this runs once per cold
     * container and writes `running` immediately, so it cannot loop.
     *
     * The cost of leaving `failed` out was immediate: a run whose install had
     * failed left that record behind, the next task saw it, declined to arm, and
     * was rescued only because the parent happened to call `repo_clone` that
     * time. A workspace would otherwise never re-arm again — one bad install
     * poisoning every task after it.
     *
     * `skipped` and `idle` stay excluded for good reasons rather than caution:
     * `skipped` means the resolver looked and found nothing to install, so a
     * missing tree is correct and permanent; `idle` means nothing has ever been
     * installed, so there is no `install:context` naming where to do it — that
     * is `repo_clone`'s job and it is handled below anyway.
     *
     * `#installState()` rather than the lifecycle's raw `read()`, so a `running`
     * record left by a dead isolate is repaired to `failed` here and can arm,
     * instead of standing until something else looks at it.
     */
    const state = await this.#installState();
    if (state.state !== "done" && state.state !== "failed") return;

    // Where to install. Written by the install that succeeded before the
    // container went away, and the only record of it — there is no caller here to
    // ask, which is the whole reason `repo` is persisted alongside `dir`.
    const context = await this.#install.context();
    if (!context?.dir) return;

    console.info(`[${this.#tag}] cold container — arming a reinstall`, {
      id: this.ctx.id.toString(),
      dir: context.dir
    });

    // Everything the arming handshake needs — the placeholder write, the stamp
    // the alarm presents to `claim`, the cooldown floor and the run intent — in
    // one call, and unwound as a unit if the intent cannot be scheduled.
    await this.#install.arm({ command: state.command });
  }

  // --- lifecycle ---------------------------------------------------------------

  /**
   * Mark this workspace as in use, and push its reclamation back.
   *
   * Every entry point calls this, which is what makes the idle clock measure
   * *use* rather than "when the agent last said this name". The agent hands a
   * workspace name to a subagent once and then never sees the traffic; the
   * workspace sees all of it.
   */
  async #touch(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.put("lastUsedAt", now);
    await this.#wake.set({
      key: IDLE_RECLAIM,
      notBefore: now + IDLE_RECLAIM_MS
    });
    await this.#wake.set({
      key: CONTAINER_IDLE,
      notBefore: now + this.#containerIdleMs
    });
  }

  /**
   * Throw this workspace away if nothing has touched it for `maxIdleMs`.
   *
   * Re-checks the clock rather than trusting the caller: the alarm may have been
   * armed a week ago, and a use since then must win. Safe to call from anywhere
   * for the same reason, which is what lets the agent's cron poke it as a
   * backstop without needing to know anything.
   */
  async reclaimIfIdle(
    maxIdleMs: number = IDLE_RECLAIM_MS
  ): Promise<{ reclaimed: boolean; idleMs: number; bytes: number }> {
    const lastUsedAt = await this.ctx.storage.get<number>("lastUsedAt");
    const bytes = this.ctx.storage.sql.databaseSize;

    // Nothing has ever used this object, so there is nothing to reclaim.
    //
    // Load-bearing, not defensive. `lastUsedAt` is written by `#touch()` and
    // removed by the `deleteAll()` below, so an *already reclaimed* workspace
    // reads exactly like a brand new one — and the old `?? 0` turned that into
    // "idle since the epoch", the most idle a workspace can possibly be. The
    // weekly sweep therefore re-reclaimed every workspace it had ever reclaimed,
    // every week, recreating storage just to empty it and logging a reclaim that
    // did not happen.
    if (lastUsedAt === undefined) return { reclaimed: false, idleMs: 0, bytes };

    const idleMs = Date.now() - lastUsedAt;
    if (idleMs < maxIdleMs) return { reclaimed: false, idleMs, bytes };

    console.info(`[${this.#tag}] reclaiming an idle workspace`, {
      id: this.ctx.id.toString(),
      idleDays: Math.round(idleMs / 86_400_000),
      bytes
    });

    await this.#stopContainer();
    // `deleteAll` does not take the alarm with it, so the alarm goes first —
    // otherwise a reclaimed object wakes once more into empty storage.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();

    return { reclaimed: true, idleMs, bytes };
  }

  /** Stop the container, keeping nothing. The workspace is what persists. */
  async #stopContainer(): Promise<void> {
    try {
      await this.ctx.container?.destroy();
    } catch (err) {
      // Already gone, most likely, and a container that cannot be stopped must
      // not turn a clean reclaim into a failed alarm.
      console.warn(`[${this.#tag}] could not stop the container`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
    }
  }

  /**
   * Refuse to keep filling an object that is running out of room.
   *
   * Checked before an install rather than continuously: that is the only
   * operation here that can move the number meaningfully, and a failure with the
   * number in it is worth far more than a write erroring further downstream.
   */
  #storageHeadroom(): string | undefined {
    const bytes = this.ctx.storage.sql.databaseSize;
    if (bytes < STORAGE_CAP_BYTES) return undefined;
    return (
      `this workspace holds ${(bytes / 1e9).toFixed(1)} GB, against a 10 GB ` +
      `per-object limit. Nothing further will be written to it — reclaim it, or ` +
      `point this caller at a smaller repository.`
    );
  }

  // --- the dependency install ------------------------------------------------

  /** `resolveInstallCommand` reads the checkout through this. */
  #probe(): InstallProbe {
    const fs = this.#workspace.fs;
    return {
      // The plugin's own, which asks for the stub's `exists` and only falls back
      // to `stat` when there is none — the local `WorkspaceFilesystem` here being
      // exactly that case.
      exists: (path) => pathExists(fs, path),
      readFile: (path) => fs.readFile(path, "utf8")
    };
  }

  /**
   * Is there a `node_modules` in the container right now?
   *
   * Asked of the **container**, not the workspace, and that is the whole point:
   * `node_modules` is never synced, so `ws.fs` would say no even when a perfectly
   * good tree is sitting there — and would say nothing useful about a tree that
   * has just been thrown away with its container.
   */
  async #dependenciesPresent(dir: string): Promise<boolean> {
    try {
      using handle = await this.#workspace.runtime.exec(
        `test -d "${dir}/node_modules"`,
        { cwd: "/", encoding: "utf8", timeoutMs: 30_000 }
      );
      return (await handle.result()).exitCode === 0;
    } catch {
      // Unreachable container, most likely. Treat as absent: a redundant
      // install costs time, a skipped one costs a confusing failure.
      return false;
    }
  }

  /**
   * Start installing this checkout's dependencies, and return without waiting.
   *
   * Called from `repo_clone` through the repo plugin's `afterCheckout` hook, so
   * it runs inside a model turn and must not block on the install — 225 seconds
   * for looping-gateway, against a chunk step that dies at ten minutes.
   *
   * That caller is a model turn, which lives long enough to hold the drain handed
   * to `ctx.waitUntil` below. **A short-lived caller cannot**, which is why the
   * cold-container path goes through the alarm and {@link #installAwaited} rather
   * than calling this.
   */
  async startInstall(req: {
    dir: string;
    repo?: string;
  }): Promise<InstallState> {
    return this.#beginInstall(req, (handle) => {
      // Drained here, in this object, on nobody's step budget. The watchdog picks
      // it up if this isolate does not survive the command.
      this.ctx.waitUntil(this.#drainInstall(handle));
    });
  }

  /**
   * The same install, drained **inside the caller** rather than after it.
   *
   * For the alarm, which owns no request: nothing it awaits can be cut short by a
   * response being sent, so the drain cannot be disposed out from under an
   * `npm ci` half-way through. Returns once the command has actually finished.
   */
  async #installAwaited(
    req: { dir: string; repo?: string },
    armedAt: number
  ): Promise<InstallState> {
    await this.#beginInstall(req, (handle) => this.#drainInstall(handle), {
      takeOverArmedAt: armedAt
    });
    return this.#installState();
  }

  /**
   * Resolve, guard, spawn — and hand the running command to `own`, which decides
   * whether the drain outlives this call or is awaited within it. That choice is
   * the only difference between the two entry points above, and it is the
   * difference that broke production, so it is the one thing this parameterises.
   */
  async #beginInstall(
    req: { dir: string; repo?: string },
    own: (handle: WorkspaceRuntimeExecHandle<"utf8">) => void | Promise<void>,
    opts?: { takeOverArmedAt?: number }
  ): Promise<InstallState> {
    await this.#touch();
    await this.#workspace.ready();

    /**
     * One install at a time, and this guard is load-bearing.
     *
     * `repo_clone` calls this and a retried chunk calls it again — three times
     * in fifty seconds, in the run that prompted this. Every call spawns with
     * the same `INSTALL_EXEC_ID`, so each displaced the last, and the displaced
     * command's drain was still attached through `ctx.waitUntil`. That drain
     * then wrote *its* outcome over a record describing an install still running
     * perfectly well, which came back from production as a "stale dependency
     * install failed" no amount of waiting would clear.
     *
     * `#installState()` rather than the lifecycle's raw `read()`, so this
     * inherits the re-attach as well: a `running` record left by a dead isolate
     * is resolved here rather than blocking a legitimate retry forever.
     * {@link JobLifecycle.claim} applies the staleness bound again on the way
     * past, which is deliberate belt-and-braces — the bound is the guarantee,
     * and a caller that forgot to repair first would otherwise wedge the job.
     *
     * `takeOverArmedAt` is the one exemption, narrow on purpose. The alarm's
     * placeholder is a `running` record for an install that has not started, so
     * the alarm must pass its own guard — and only its own. Matching the exact
     * `startedAt` it wrote is what stops that becoming "take over any running
     * install", which is the displacement bug above in a new hat.
     */
    const current = await this.#installState();
    const claim = this.#install.claim(
      current,
      this.#installTimeoutMs,
      opts?.takeOverArmedAt
    );
    if (!claim.ok) {
      console.info(`[${this.#tag}] an install is already in flight`, {
        id: this.ctx.id.toString(),
        command: claim.current.command,
        seconds: Math.round((Date.now() - claim.current.startedAt) / 1000)
      });
      return claim.current;
    }

    const full = this.#storageHeadroom();
    if (full) {
      const state: InstallState = { state: "skipped", reason: full };
      await this.#install.write(state);
      return state;
    }

    const probe = this.#probe();
    const resolution = await resolveInstallCommand(
      probe,
      req.dir,
      this.#cfg.installPlan,
      req.repo
    );

    if (resolution.kind === "skip") {
      const state: InstallState = {
        state: "skipped",
        reason: resolution.reason
      };
      await this.#install.write(state);
      return state;
    }

    const fingerprint = await installFingerprint(probe, req.dir, resolution);

    /**
     * The skip condition, and **both halves are required**.
     *
     * A matching fingerprint says the same install would produce the same tree.
     * It does not say the tree is there — the fingerprint is in this object's
     * storage, which is durable, and `node_modules` is in the container, which
     * is not. Skipping on the fingerprint alone would skip exactly the install a
     * cold container needs most, and the symptom is a subagent whose first
     * `import` fails for no visible reason.
     */
    const previous = await this.ctx.storage.get<{ fingerprint: string }>(
      "install:completed"
    );
    if (
      fingerprint &&
      previous?.fingerprint === fingerprint &&
      (await this.#dependenciesPresent(req.dir))
    ) {
      const state: InstallState = {
        state: "done",
        command: resolution.command,
        exitCode: 0,
        finishedAt: Date.now(),
        ms: 0,
        tail: "dependencies already installed for this lockfile"
      };
      await this.#install.write(state);
      return state;
    }

    const startedAt = Date.now();
    const state: InstallState = {
      state: "running",
      command: resolution.command,
      startedAt
    };
    await this.#install.write(state);
    await this.#install.putContext({
      dir: req.dir,
      // Kept so a reinstall driven by `installStatus` — which has no caller to
      // ask — resolves the same command this one did. Without it a repository
      // with an `INSTALL_PLAN` override would silently fall back to the default
      // on every cold container, installing a different tree than the first time.
      ...(req.repo ? { repo: req.repo } : {}),
      fingerprint,
      command: resolution.command,
      startedAt
    });

    /**
     * The watchdog is armed **before** the spawn, and that order is the whole
     * point of this block.
     *
     * The record above already says `running`, and every `sb_exec` gates on it.
     * So from here until something writes a terminal state, the install owns the
     * workspace — and if this isolate dies in the next few milliseconds, the
     * alarm is the only thing that can take it back. Arming afterwards leaves a
     * window where the gate is closed and nothing is scheduled to open it, which
     * is not theoretical: a `runtime.exec` that threw on the container's
     * WebSocket left a workspace `running` for half an hour, refusing every
     * command, until the task hit its own timeout.
     *
     * Arming early is free. The handler re-reads the record and clears the
     * intent if it is not `running`, so an install that fails or finishes first
     * just costs one wake-up.
     */
    await this.#install.armWatch();

    let handle: WorkspaceRuntimeExecHandle<"utf8">;
    try {
      handle = await this.#workspace.runtime.exec(resolution.command, {
        id: INSTALL_EXEC_ID,
        cwd: req.dir,
        encoding: "utf8",
        timeoutMs: this.#installTimeoutMs
      });
    } catch (err) {
      // The command never started, so nothing will ever drain it and no
      // re-attach can find it. Close the record here: a `failed` install is
      // recoverable — the subagent is told what happened and can run the command
      // itself — where a `running` one that nobody owns is not.
      console.error(`[${this.#tag}] the install could not be started`, {
        id: this.ctx.id.toString(),
        command: resolution.command,
        err: String(err)
      });
      const failed: InstallState = {
        state: "failed",
        command: resolution.command,
        finishedAt: Date.now(),
        error:
          `the install could not be started (${String(err)}). The container ` +
          "was most likely unreachable. Run the command yourself with sb_exec, " +
          "or clone again to retry it."
      };
      await this.#install.write(failed);
      await this.#install.clearWatch();
      return failed;
    }

    await own(handle);

    return state;
  }

  /**
   * Where the checkout actually is, as recorded when it was installed into.
   *
   * The repo plugin reports the authoritative path in `RepoCheckout.dir` and
   * `startInstall` persists it. Callers outside this object would otherwise
   * re-derive it from the repository name, which is a second spelling of one
   * path and drifts the moment a clone lands anywhere but `<workdir>/<repo>`.
   */
  async checkoutDir(): Promise<string | undefined> {
    return (await this.#install.context())?.dir;
  }

  /**
   * Where the install has got to — the gate `sb_exec` consults before running.
   *
   * Almost a plain read of {@link #installState}. It does **not** probe the
   * container, and a previous version that did is worth a warning.
   *
   * That version answered the right question — a `done` record describes a
   * `node_modules` that died with its container, and nothing noticed — but
   * answered it here, on the gate's path, by calling `startInstall`. The gate polls
   * this method from a tool call that returns in milliseconds, and `startInstall`
   * hands its drain to `ctx.waitUntil`, whose lifetime is that invocation's. The
   * drain outlived its owner and died mid-`npm ci` with "WritableStream RPC stub
   * was disposed without calling close()", leaving a half-written tree that cost
   * a nine-minute task to unpick.
   *
   * Detecting a cold container now happens once, in {@link #armInstallIfCold},
   * off a boolean rather than a container round-trip — and the install itself runs
   * in the alarm, which owns no request and outlives every RPC. Keep it that way:
   * **nothing that starts a long job belongs on this path.**
   */
  async installStatus(): Promise<InstallState> {
    const state = await this.#installState();
    if (state.state !== "failed") return state;

    /**
     * A `failed` record that is no longer true, cleared.
     *
     * `failed` is not inert: the gate renders it as a warning in front of *every*
     * subsequent command — "anything importing from node_modules will fail". So a
     * record that outlives the failure it describes actively misinforms, and the
     * subagent is the one most likely to have made it obsolete, by running the
     * install itself after being told the host's attempt failed.
     *
     * That is not hypothetical. In one run the subagent recovered a corrupt tree
     * with `rm -rf node_modules && npm ci`, and then read "the dependency install
     * failed" on every command afterwards — and re-ran a 60-second gate six times.
     *
     * Only ever downgrades a `failed` to `done`, and only on positive evidence
     * that the tree is there. It never invents a success.
     */
    const context = await this.#install.context();
    if (!context?.dir) return state;
    if (!(await this.#dependenciesPresent(context.dir))) return state;

    console.info(`[${this.#tag}] dependencies are back — clearing failure`, {
      id: this.ctx.id.toString(),
      dir: context.dir
    });
    const done: InstallState = {
      state: "done",
      command: state.command,
      exitCode: 0,
      finishedAt: Date.now(),
      ms: 0,
      tail: "dependencies are present; the earlier failure no longer applies"
    };
    await this.#install.write(done);
    return done;
  }

  /**
   * The install record itself, with its staleness bound and re-attach applied.
   *
   * Split from {@link installStatus} so `startInstall` can consult the record
   * without re-entering the dependency probe above — which calls `startInstall`,
   * and would otherwise recurse without end.
   *
   * Re-attaches on the way past. An isolate reset leaves the record saying
   * `running` with nothing draining it, and without this the state would say
   * `running` forever while the command had long since finished.
   */
  async #installState(): Promise<InstallState> {
    const state = await this.#install.read();

    if (state.state !== "running") return state;

    /**
     * `running` has an expiry, and everything above this line is why.
     *
     * `running` is the one state that blocks work: `sb_exec` waits on it and
     * then refuses to run. Every other state is a fact the subagent can act on.
     * So it is the state that must not be able to outlive the thing it
     * describes — and the ways it can are not all reachable from here. The spawn
     * can fail before the drain is attached; the drain can be cut short by an
     * eviction; `getExec` can hand back a handle to a container that never
     * answers. Each of those has a fix of its own, and none of them is a proof.
     *
     * This is the proof. The command carries a `timeoutMs` that the runtime
     * enforces, so past that plus a wide margin, a live install is not a
     * possibility — whatever the record says, the truth is that nobody is coming
     * back with an exit code. Writing `failed` here is not a guess about what
     * happened, it is the only accurate thing left to say.
     */
    if (this.#install.isStale(state, this.#installTimeoutMs)) {
      const minutes = Math.round((Date.now() - state.startedAt) / 60_000);
      console.error(`[${this.#tag}] abandoning a stale install`, {
        id: this.ctx.id.toString(),
        command: state.command,
        minutes
      });
      const failed: InstallState = {
        state: "failed",
        command: state.command,
        finishedAt: Date.now(),
        error:
          `the install has been running for ${minutes} minutes without ` +
          "reporting, which is past its timeout — it is not going to finish. " +
          "Run the command yourself with sb_exec if you still need it."
      };
      await this.#install.write(failed);
      await this.#install.clearWatch();
      return failed;
    }

    if (!this.#draining) {
      await this.#reattachInstall();
      return await this.#install.read();
    }
    return state;
  }

  /** True while this isolate holds the drain, so the watchdog leaves it alone. */
  #draining = false;

  async #drainInstall(
    handle: WorkspaceRuntimeExecHandle<"utf8">
  ): Promise<void> {
    this.#draining = true;
    const context = await this.#install.context();
    const command = context?.command ?? "(unknown)";
    const startedAt = context?.startedAt ?? Date.now();

    /**
     * Whether this drain still owns the record.
     *
     * The guard in `startInstall` stops two installs overlapping in the first
     * place; this makes it harmless if one ever does. A drain can outlive the
     * command it was watching — `ctx.waitUntil` keeps running after the RPC
     * returns — and the damage a late one does is silent: it writes a verdict
     * about a finished command over a record describing a live one, and every
     * `sb_exec` then reads a result that belongs to nothing.
     *
     * `startedAt` is the generation marker. `#beginInstall` rewrites the context
     * before it spawns, so a drain whose stamp no longer matches has been
     * superseded and has nothing useful left to say. The marker also **latches**:
     * ownership is not recoverable, so a stamp that happens to match again does
     * not hand the record back.
     *
     * Wrapped rather than used bare only to log the transition, and only once —
     * a superseded drain asks this on both the success and the error path.
     */
    const generation = this.#install.generation(startedAt);
    let logged = false;
    const stillMine = async (): Promise<boolean> => {
      if (await generation.stillMine()) return true;
      if (!logged) {
        logged = true;
        console.warn(`[${this.#tag}] discarding a superseded install drain`, {
          id: this.ctx.id.toString(),
          command,
          startedAt,
          current: (await this.#install.context())?.startedAt
        });
      }
      return false;
    };

    try {
      const result = await handle.result();
      // Middle-out rather than a tail cut, and it marks what it dropped: an
      // install's diagnosis is split between the two ends — the first error and
      // the summary that follows it — and a plain `slice(-n)` silently keeps
      // only the half that happens to be last.
      const tail = truncateOutput(result.stdout + result.stderr, 2000);
      if (!(await stillMine())) return;

      if (result.exitCode === 0) {
        // Recorded only on success, and this is what the skip condition reads.
        // A failed install must not leave a fingerprint behind, or the next
        // checkout would decide the tree it never built is already good.
        if (context?.fingerprint) {
          await this.ctx.storage.put("install:completed", {
            fingerprint: context.fingerprint,
            at: Date.now()
          });
        }
        console.info(`[${this.#tag}] install finished`, {
          id: this.ctx.id.toString(),
          command,
          seconds: Math.round((Date.now() - startedAt) / 1000)
        });
        await this.#install.write({
          state: "done",
          command,
          exitCode: 0,
          finishedAt: Date.now(),
          ms: Date.now() - startedAt,
          tail
        });
      } else {
        // Logged, and this line is not optional. This is the *ordinary* way an
        // install fails — the other paths are all exceptional — and it used to
        // write the record and say nothing, so an operator looking at why the
        // subagent was complaining found the complaint and no cause. The tail
        // is the install's own last words; without it the only copy is inside a
        // Durable Object nobody can query.
        console.error(`[${this.#tag}] install failed`, {
          id: this.ctx.id.toString(),
          command,
          exitCode: result.exitCode,
          seconds: Math.round((Date.now() - startedAt) / 1000),
          tail: truncateOutput(tail, 1000)
        });
        await this.#install.write({
          state: "failed",
          command,
          finishedAt: Date.now(),
          exitCode: result.exitCode,
          error: `the install command exited ${result.exitCode}`,
          tail
        });
      }
    } catch (err) {
      // Superseded drains fail here constantly — replacing an exec is what
      // breaks the old handle — so this check matters more on the error path
      // than on the success one.
      if (!(await stillMine())) return;
      // The drain itself broke — the container went away mid-install, most
      // likely. Distinct from a non-zero exit above, and worth telling apart in
      // the logs, because this one says nothing about the repository.
      console.error(`[${this.#tag}] install drain failed`, {
        id: this.ctx.id.toString(),
        command,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        err: String(err)
      });
      await this.#install.write({
        state: "failed",
        command,
        finishedAt: Date.now(),
        error: String(err)
      });
    } finally {
      this.#draining = false;
      handle[Symbol.dispose]();
      // Not if this drain was superseded: the watchdog belongs to whichever
      // install owns the record now, and clearing it here would disarm the one
      // recovery path the *live* install has.
      if (!generation.superseded()) await this.#install.clearWatch();
    }
  }

  /**
   * Pick up an install this isolate did not start.
   *
   * `getExec` with `resume: "tail"` re-opens the stream of a command that is
   * still running in the container — or replays the end of one that finished
   * while nobody was listening, which is the case that would otherwise leave the
   * record stuck at `running` and every `sb_exec` blocked behind it.
   */
  async #reattachInstall(): Promise<void> {
    if (this.#draining) return;
    try {
      const handle = await this.#workspace.runtime.getExec(INSTALL_EXEC_ID, {
        encoding: "utf8",
        resume: "tail"
      });
      this.ctx.waitUntil(this.#drainInstall(handle));
    } catch (err) {
      // The exec is gone entirely — the container was replaced under it. Say so
      // rather than leaving the gate closed forever; the next checkout starts a
      // new install, and `sb_exec` can run in the meantime.
      console.warn(`[${this.#tag}] could not re-attach to the install`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
      const context = await this.#install.context();
      await this.#install.write({
        state: "failed",
        command: context?.command ?? "(unknown)",
        finishedAt: Date.now(),
        error:
          "the install stopped without reporting — its container was most " +
          "likely replaced. Re-run it with sb_exec, or clone again to restart it."
      });
      await this.#install.clearWatch();
    }
  }

  /**
   * `computerd`'s outbound WebSocket upgrade, on its way back in.
   *
   * The container dials the loopback rather than the other way round, so this
   * object is the server for its own container's capnweb session. Everything
   * else on this object is RPC; this is the only HTTP it speaks.
   */
  override fetch(request: Request): Promise<Response> {
    return this.backend.handleFetch(request);
  }

  /**
   * Every durable wake-up this object has, dispatched from the one alarm.
   *
   * Two rules, and both are here because breaking either fails silently:
   *
   * 1. **This must not throw.** The runtime retries a failing alarm handler a
   *    bounded number of times and then stops for good — so an intent that
   *    throws would eventually take the *others* down with it, permanently, and
   *    the only symptom is that nothing ever happens again. Each intent is
   *    caught on its own and the re-arm runs in a `finally`.
   * 2. **An intent that neither reschedules nor clears itself is dropped.**
   *    Otherwise it stays due forever and the object wakes in a loop. The one
   *    real case is `retryPendingSync` returning `exhausted`, which by design
   *    leaves the intent in storage; the sweep below is what stops that
   *    becoming a permanent spin, and it logs loudly because an exhausted sync
   *    means edits were lost.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();

    let due: WakeIntent[];
    try {
      due = await this.#wake.due(now);
    } catch (err) {
      console.error(`[${this.#tag}] could not read the wake map`, {
        id: this.ctx.id.toString(),
        err: String(err)
      });
      await this.#wake.repair(now).catch(() => {});
      return;
    }

    try {
      for (const intent of due) {
        try {
          await this.#dispatch(intent);
        } catch (err) {
          console.error(`[${this.#tag}] wake intent failed`, {
            id: this.ctx.id.toString(),
            key: intent.key,
            err: String(err)
          });
        }

        // The backstop from rule 2: if the handler left the intent exactly as
        // it found it, it is not going to make progress on the next wake
        // either.
        const after = await this.#wake.get(intent.key).catch(() => undefined);
        if (after && after.notBefore === intent.notBefore) {
          console.error(`[${this.#tag}] dropping a stuck wake intent`, {
            id: this.ctx.id.toString(),
            key: intent.key,
            attempt: after.attempt
          });
          await this.#wake.clear(intent.key).catch(() => {});
        }
      }
    } finally {
      await this.#wake.rearm().catch((err: unknown) => {
        console.error(`[${this.#tag}] could not re-arm the alarm`, {
          id: this.ctx.id.toString(),
          err: String(err)
        });
      });
    }
  }

  /** Route one due intent to whatever owns it. */
  async #dispatch(intent: WakeIntent): Promise<void> {
    if (intent.key.startsWith("sync-retry:")) {
      const backend = intent.key.slice("sync-retry:".length);
      const result = await this.#workspace.retryPendingSync(backend);

      if (result.status === "exhausted") {
        // The library leaves the intent stored on this path, so clear it here
        // rather than letting the stuck-intent sweep do it silently. Edits made
        // in the container by the command that triggered this pull are gone.
        console.error(`[${this.#tag}] pending sync exhausted`, {
          id: this.ctx.id.toString(),
          backend,
          attempt: result.attempt,
          err: result.error
        });
        await this.#wake.clear(intent.key);
      }
      return;
    }

    if (intent.key === this.#install.runIntent) {
      // Cleared first, and unconditionally. This handler runs for minutes, and an
      // intent left in place would be re-dispatched by the next wake — arming a
      // second `npm ci` alongside the first, which is how a tree gets corrupted.
      // `startInstall`'s in-flight guard would catch that, but the cheaper answer
      // is not to schedule it twice.
      await this.#wake.clear(intent.key);

      const context = await this.#install.context();
      const armedAt = await this.#install.armedAt();
      await this.#install.clearArmed();
      if (!context?.dir || armedAt === undefined) return;

      const state = await this.#installAwaited(
        {
          dir: context.dir,
          ...(context.repo ? { repo: context.repo } : {})
        },
        armedAt
      );
      console.info(`[${this.#tag}] armed reinstall finished`, {
        id: this.ctx.id.toString(),
        dir: context.dir,
        state: state.state
      });
      return;
    }

    if (intent.key === this.#install.watchIntent) {
      const state = await this.#install.read();
      if (state.state !== "running") {
        await this.#wake.clear(intent.key);
        return;
      }
      // Still running and nobody draining it: this isolate is new since the
      // command started. Re-attach, and come back if it is still going.
      await this.#reattachInstall();
      await this.#install.armWatch();
      return;
    }

    if (intent.key === IDLE_RECLAIM) {
      const { reclaimed, idleMs } = await this.reclaimIfIdle();
      // Not idle after all — something used it since this was armed. `#touch`
      // has already moved the deadline, so there is nothing to re-arm; clearing
      // would throw away the *new* intent, so this deliberately does neither.
      if (!reclaimed) {
        console.info(`[${this.#tag}] idle reclaim deferred`, {
          id: this.ctx.id.toString(),
          idleMinutes: Math.round(idleMs / 60_000)
        });
      }
      return;
    }

    if (intent.key === CONTAINER_IDLE) {
      // An install still running is "in use" even though nothing has called in
      // — stopping the container under it would throw away the work and leave
      // the gate closed until something noticed.
      const state = await this.#install.read();
      if (state.state === "running") {
        await this.#wake.set({
          key: CONTAINER_IDLE,
          notBefore: Date.now() + this.#containerIdleMs
        });
        return;
      }

      // Re-read the clock rather than trusting the alarm, the same way
      // `reclaimIfIdle` does. `#touch` moves the intent forward, but an alarm
      // already in flight cannot be recalled — so without this a workspace that
      // was used a second ago can still have its container stopped by a wake-up
      // that was scheduled before that use.
      const lastUsedAt =
        (await this.ctx.storage.get<number>("lastUsedAt")) ?? 0;
      const idleMs = Date.now() - lastUsedAt;
      if (idleMs < this.#containerIdleMs) {
        await this.#wake.set({
          key: CONTAINER_IDLE,
          notBefore: lastUsedAt + this.#containerIdleMs
        });
        return;
      }

      await this.#stopContainer();
      await this.#wake.clear(intent.key);
      return;
    }

    console.warn(`[${this.#tag}] unknown wake intent`, {
      id: this.ctx.id.toString(),
      key: intent.key
    });
    await this.#wake.clear(intent.key);
  }
}
