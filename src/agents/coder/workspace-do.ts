import { DurableObject, tracing } from "cloudflare:workers";
import {
  Workspace,
  type DurableObjectStorageLike,
  type SyncRetryIntent,
  type SyncRetryScheduler,
  type WorkspaceOptions,
  type WorkspaceRuntimeExecHandle,
  type WorkspaceStub
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer
} from "@cloudflare/computer/backends/container";
import { createCloudflareObserver } from "@cloudflare/computer/observe/cloudflare";
import {
  installFingerprint,
  resolveInstallCommand,
  type InstallProbe,
  type InstallState
} from "@loopingai/plugins/computer";
import { INSTALL_PLAN } from "./install";

/**
 * The coder's workspace: one Durable Object, one container, one repository.
 *
 * This is the substrate the whole agent stands on, and the shape is forced
 * rather than chosen. `@cloudflare/computer` pairs a SQLite-backed virtual
 * filesystem in *this* object's storage with a container running `computerd`,
 * which mounts that filesystem over FUSE at `/workspace`. Commands run in the
 * container against the same tree the Worker reads over RPC, and the tree
 * outlives the container — which is the entire reason this replaced
 * `@cloudflare/sandbox`, whose disk died with the container and whose R2
 * snapshot path needed S3 credentials a Workers binding cannot supply.
 *
 * **One repository per object.** `computer` is strictly 1 DO ↔ 1 container, so
 * the id is derived from caller *and* repository — see `workspaceName` below.
 * Two repositories for one caller are two objects, two containers and two
 * filesystems, which is also the answer to "never mix repos".
 *
 * ## Why this constructs `Workspace` instead of using `withWorkspace`
 *
 * `withWorkspace(Base, options)` is the documented shortcut and it is a fine
 * default — but it stores the `Workspace` under a module-private symbol that the
 * package does not export, so a method on the object cannot reach it. That
 * matters here because two things the host is *required* to do live on
 * `Workspace` and are absent from the `WorkspaceClient` the mixin hands back:
 * `retryPendingSync`, which the library explicitly cannot drive itself ("the
 * library does not own your DO's alarm"), and the direct `runtime` access the
 * detached install needs.
 *
 * So the object owns the `Workspace` and implements the one method the mixin
 * otherwise provides — `__getWorkspaceStub`, which is exactly what
 * `getWorkspace(stub)` calls across the DO boundary. Callers outside see no
 * difference.
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

// --- the durable wake-up map ------------------------------------------------

/**
 * One scheduled wake-up.
 *
 * A Durable Object has exactly **one** alarm, and this object needs it for more
 * than one thing: the sync-retry the library requires, and — in the steps that
 * follow — an install watchdog and idle reclamation. Multiplexing that by
 * calling `setAlarm` from each of them does not work; the last writer silently
 * wins, and losing the sync-retry means a subagent's edits stay stranded in a
 * container with nothing left to resume them.
 *
 * So every intent goes through {@link WakeMap}, which is the only thing in this
 * file that calls `setAlarm`.
 */
interface WakeIntent {
  /** Why we are waking. Namespaced, e.g. `sync-retry:container-shell`. */
  key: string;
  /** Epoch ms at which this intent becomes due. */
  notBefore: number;
  /** Retry counter, for the intents that carry one. */
  attempt?: number;
}

/** Single storage row holding every intent. Small, and written atomically. */
const WAKE_KEY = "wake";

/** Where the current install's state lives, for `installStatus` to read. */
const INSTALL_KEY = "install";

/** The wake intent that re-attaches to an install nobody is draining. */
const INSTALL_WATCH = "install-watch";

/**
 * The wake intent that *runs* an install, as opposed to watching one.
 *
 * Armed by {@link CoderWorkspaceDO.#armInstallIfCold} the moment a cold container
 * is seen, and handled in the alarm — which is the point. An install takes ~85
 * seconds and must not be owned by the request that noticed it was needed: the
 * previous attempt handed one to `ctx.waitUntil` from a gate poll that returned in
 * milliseconds, and the drain was disposed underneath it mid-`npm ci`.
 *
 * An alarm invocation belongs to the object rather than to any caller, so nothing
 * it awaits can be cut short by a request completing.
 */
const INSTALL_RUN = "install-run";

/**
 * The `startedAt` of the placeholder {@link CoderWorkspaceDO.#armInstallIfCold}
 * wrote, so the alarm can recognise its own.
 *
 * Arming writes a `running` record before anything is running — that is what
 * holds the gate shut in the moments before the alarm fires. But `#beginInstall`
 * refuses to start when a `running` record already exists, and it is right to:
 * that guard is what stops two `npm ci` processes sharing one `INSTALL_EXEC_ID`
 * and writing each other's verdicts.
 *
 * So the alarm has to distinguish *its own placeholder* from a genuinely live
 * install. This is how — a timestamp only the arming path could have written.
 * Taking over any `running` record instead would reintroduce exactly the
 * displacement bug the guard exists to prevent.
 */
const INSTALL_ARMED = "install:armed";

/** When arming last fired, kept so {@link INSTALL_ARM_COOLDOWN_MS} can be enforced. */
const INSTALL_LAST_ARMED = "install:last-armed";

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
 * There is no `sleepAfter` here to lean on. `withWorkspaceContainer` wraps the
 * runtime's raw `ctx.container` rather than `@cloudflare/containers`'
 * `Container`, so idle shutdown is ours to schedule.
 *
 * ## This must exceed the longest command the shell allows
 *
 * The invariant is the whole reason this constant is not smaller, and breaking
 * it is not a tuning mistake — it kills work in flight.
 *
 * The idle clock is armed by `#touch()`, which runs when something calls *into*
 * this object. A command does that once, on the way in, and then nothing
 * touches the workspace again until it finishes: `handle.result()` is one long
 * await, and the FUSE traffic underneath it never surfaces as an RPC anything
 * here can see. So the idle window is measured from the moment a command
 * starts, not from the moment it ends.
 *
 * At the previous value of ten minutes that window was **exactly** the computer
 * plugin's own `DEFAULT_TIMEOUT_MS`, which is the ceiling on a single
 * `sb_exec`. Two timers of the same length, started moments apart, and the one
 * that fires first destroys the container the other depends on. The symptom was
 * reported as "repeated exec-backend crashes/restarts": `npm run check` (28 s
 * measured) always survived and a full `npm test` never did.
 *
 * Twenty minutes is double that ceiling, so no command can outlive it. Raise it
 * again — do not lower it — if `sb_exec` is ever given a longer timeout.
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

/** How far out to re-arm when the handler itself failed and we want a retry. */
const WAKE_REPAIR_MS = 60_000;

class WakeMap {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  async all(): Promise<Record<string, WakeIntent>> {
    return (
      (await this.#storage.get<Record<string, WakeIntent>>(WAKE_KEY)) ?? {}
    );
  }

  async get(key: string): Promise<WakeIntent | undefined> {
    return (await this.all())[key];
  }

  async set(intent: WakeIntent): Promise<void> {
    const all = await this.all();
    all[intent.key] = intent;
    await this.#storage.put(WAKE_KEY, all);
    await this.rearm();
  }

  async clear(key: string): Promise<void> {
    const all = await this.all();
    if (!(key in all)) return;
    delete all[key];
    await this.#storage.put(WAKE_KEY, all);
    await this.rearm();
  }

  /** Every intent whose time has come, earliest first. */
  async due(now: number): Promise<WakeIntent[]> {
    return Object.values(await this.all())
      .filter((intent) => intent.notBefore <= now)
      .sort((a, b) => a.notBefore - b.notBefore);
  }

  /**
   * Point the alarm at the earliest deadline.
   *
   * Only ever moved **earlier**, never later: an alarm that fires too soon finds
   * nothing due, re-arms, and costs one wake-up, whereas an alarm pushed later
   * by a coincidental write silently delays whatever was already waiting. When
   * no intents remain the alarm is deleted outright, so an idle object does not
   * wake on a schedule it has no use for.
   */
  async rearm(): Promise<void> {
    const deadlines = Object.values(await this.all()).map((i) => i.notBefore);
    const existing = await this.#storage.getAlarm();

    if (deadlines.length === 0) {
      if (existing !== null) await this.#storage.deleteAlarm();
      return;
    }

    const earliest = Math.min(...deadlines);
    if (existing === null || existing > earliest) {
      await this.#storage.setAlarm(earliest);
    }
  }

  /**
   * Re-arm shortly, for when the handler failed before it could work out what
   * it owed. Distinct from {@link rearm} because that one trusts the map, and
   * the map is what we just failed to read.
   */
  async repair(now: number): Promise<void> {
    const existing = await this.#storage.getAlarm();
    if (existing === null) await this.#storage.setAlarm(now + WAKE_REPAIR_MS);
  }
}

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
 * The Durable Object bound as `CODER_WORKSPACE`.
 *
 * Field initialisation order is load-bearing and safe: `#wake` and `backend`
 * are declared before `#workspace`, and class fields run top to bottom after
 * `super()`, so `this.ctx` exists and the backend is built by the time the
 * `Workspace` constructor reads it.
 */
export class CoderWorkspaceDO extends WorkspaceContainerBase {
  readonly #wake = new WakeMap(this.ctx.storage);

  /**
   * The container backend.
   *
   * `container: () => this` hands the backend this object's own container.
   * `workspace` is how `computerd` dials *back* in: the runtime builds a
   * loopback binding from the exported `WorkspaceProxy` class and these two
   * values, which is why `src/index.ts` re-exports `WorkspaceProxy` and why
   * dropping that export breaks the container with no compile error.
   *
   * Nothing sets `egressHost`; the default `computer.internal` is the host the
   * container's outbound HTTP is intercepted on, and it is internal to that
   * loopback. (The upstream example on `main` passes `egress: { mode: "direct" }`
   * — that option does not exist in the published 0.1.1, whose typings carry
   * `egressHost` instead. `main` is ahead of the registry.)
   */
  readonly backend = new CloudflareContainerBackend({
    container: () => this,
    workspace: {
      binding: "CODER_WORKSPACE",
      id: this.ctx.id.toString()
    }
  });

  readonly #workspace = new Workspace(this.#workspaceOptions());

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
      observer: createCloudflareObserver({ tracing })
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
      console.error("[coder-workspace] could not repair the alarm", {
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
   * Start a dependency install the moment we can see one will be needed.
   *
   * ## The signal is `container.running`, and it is free
   *
   * `node_modules` lives in the container and dies with it. So a stopped container
   * plus a record saying `done` is not ambiguous: the tree that record describes is
   * gone. `ctx.container.running` is a synchronous getter, so the warm path — every
   * call but the first of a cold task — costs one boolean and touches no storage.
   *
   * ## Why here, and why not later
   *
   * `__getWorkspaceStub()` is reached before any command runs, which makes it the
   * earliest honest moment in a task. That matters more than it looks: the model
   * spends its first minute reading the README and running `git status`, none of
   * which needs dependencies (see `needsDependencies` in the computer plugin). An
   * install armed here runs *through* that minute. Armed on the first `npm` command
   * instead, the same install would charge its full 85 seconds to that command, and
   * the minute would have bought nothing.
   *
   * ## Why it writes `running` before anything is running
   *
   * The alarm has not fired yet, and a `done` record left in place would let an
   * `npm` command through in the meantime, against a tree that is not there. This
   * also makes the method self-limiting: the next call sees `running`, not `done`,
   * and stops — so the busiest entry point in the object does at most one arming
   * per cold container.
   *
   * The staleness bound in {@link #installState} covers the case where the alarm
   * never fires, and `INSTALL_WATCH` covers an alarm that dies part-way.
   */
  async #armInstallIfCold(): Promise<void> {
    // Running container: whatever the record says about `node_modules`, it is
    // still true. This is the branch that runs on almost every call.
    if (this.ctx.container?.running) return;

    /**
     * `done` **and** `failed`, and the second one was a gap worth closing.
     *
     * Arming used to require `done`, on the reasoning that re-driving a failed
     * install would loop. That reasoning belonged to an earlier design where the
     * check ran on *every* gated command; this runs once per cold container and
     * writes `running` immediately, so it cannot loop.
     *
     * The cost of leaving `failed` out was immediate: a run whose install had
     * failed left that record behind, the next task saw it, declined to arm, and
     * was rescued only because the parent happened to call `repo_clone` that
     * time. A workspace would otherwise never re-arm again — one bad install
     * poisoning every task after it.
     *
     * `skipped` and `idle` are still excluded, and for good reasons rather than
     * caution: `skipped` means the resolver looked and found nothing to install,
     * so a missing tree is correct and permanent; `idle` means nothing has ever
     * been installed, so there is no `install:context` naming where to do it —
     * that is `repo_clone`'s job and it is handled below anyway.
     */
    const state = await this.#installState();
    if (state.state !== "done" && state.state !== "failed") return;

    // The bound on retrying a failure. See INSTALL_ARM_COOLDOWN_MS — without it,
    // an install that cannot start re-arms on every call into this object.
    const lastArmed = await this.ctx.storage.get<number>(INSTALL_LAST_ARMED);
    if (
      lastArmed !== undefined &&
      Date.now() - lastArmed < INSTALL_ARM_COOLDOWN_MS
    )
      return;

    // Where to install. Written by the install that succeeded before the
    // container went away, and the only record of it — there is no caller here to
    // ask, which is the whole reason `repo` is persisted alongside `dir`.
    const context = await this.ctx.storage.get<{
      dir: string;
      repo?: string;
    }>("install:context");
    if (!context?.dir) return;

    console.info("[coder-workspace] cold container — arming a reinstall", {
      id: this.ctx.id.toString(),
      dir: context.dir
    });

    const armedAt = Date.now();
    await this.#putInstall({
      state: "running",
      command: state.command,
      startedAt: armedAt
    });
    await this.ctx.storage.put(INSTALL_ARMED, armedAt);
    await this.ctx.storage.put(INSTALL_LAST_ARMED, armedAt);
    await this.#wake.set({ key: INSTALL_RUN, notBefore: armedAt });
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
      notBefore: now + CONTAINER_IDLE_MS
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
    const lastUsedAt = (await this.ctx.storage.get<number>("lastUsedAt")) ?? 0;
    const idleMs = Date.now() - lastUsedAt;
    const bytes = this.ctx.storage.sql.databaseSize;

    if (idleMs < maxIdleMs) return { reclaimed: false, idleMs, bytes };

    console.info("[coder-workspace] reclaiming an idle workspace", {
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
      console.warn("[coder-workspace] could not stop the container", {
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
      // The local `WorkspaceFilesystem` has no `exists` — that lives on the
      // stub, which is what callers *outside* this object get. `stat` is the
      // equivalent here, and a throw means absent.
      exists: (path) =>
        fs.stat(path).then(
          () => true,
          () => false
        ),
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

  async #putInstall(state: InstallState): Promise<void> {
    await this.ctx.storage.put(INSTALL_KEY, state);
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
     * `repo_clone` calls this, and a chunk that is retried calls it again —
     * three times in fifty seconds, in the run that prompted this. Every call
     * spawns with the same `INSTALL_EXEC_ID`, so each one displaced the last,
     * and the displaced command's drain was still attached through
     * `ctx.waitUntil`. That drain then wrote *its* outcome over a record
     * describing an install that was still running perfectly well — a `failed`
     * from a command that had been replaced, sitting on top of a live one.
     *
     * Which is exactly what came back from production: a "stale dependency
     * install failed" that no amount of waiting would clear, because the thing
     * it described was already gone.
     *
     * `#installState()` rather than a raw read, so this inherits the staleness
     * bound and the re-attach: a `running` record left behind by a dead isolate
     * is resolved here rather than blocking a legitimate retry forever.
     *
     * `takeOverArmedAt` is the one exemption, and it is narrow on purpose: the
     * alarm's placeholder is a `running` record describing an install that has not
     * started, so the alarm must be able to pass its own guard — and only its own.
     * Matching on the exact `startedAt` it wrote (see {@link INSTALL_ARMED}) is
     * what keeps that from becoming "take over any running install", which is the
     * displacement bug above wearing a new hat.
     */
    const current = await this.#installState();
    if (
      current.state === "running" &&
      current.startedAt !== opts?.takeOverArmedAt
    ) {
      console.info("[coder-workspace] an install is already in flight", {
        id: this.ctx.id.toString(),
        command: current.command,
        seconds: Math.round((Date.now() - current.startedAt) / 1000)
      });
      return current;
    }

    const full = this.#storageHeadroom();
    if (full) {
      const state: InstallState = { state: "skipped", reason: full };
      await this.#putInstall(state);
      return state;
    }

    const probe = this.#probe();
    const resolution = await resolveInstallCommand(
      probe,
      req.dir,
      INSTALL_PLAN,
      req.repo
    );

    if (resolution.kind === "skip") {
      const state: InstallState = {
        state: "skipped",
        reason: resolution.reason
      };
      await this.#putInstall(state);
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
      await this.#putInstall(state);
      return state;
    }

    const startedAt = Date.now();
    const state: InstallState = {
      state: "running",
      command: resolution.command,
      startedAt
    };
    await this.#putInstall(state);
    await this.ctx.storage.put("install:context", {
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
    await this.#wake.set({
      key: INSTALL_WATCH,
      notBefore: Date.now() + INSTALL_WATCH_MS
    });

    let handle: WorkspaceRuntimeExecHandle<"utf8">;
    try {
      handle = await this.#workspace.runtime.exec(resolution.command, {
        id: INSTALL_EXEC_ID,
        cwd: req.dir,
        encoding: "utf8",
        timeoutMs: INSTALL_PLAN.timeoutMs ?? 20 * 60_000
      });
    } catch (err) {
      // The command never started, so nothing will ever drain it and no
      // re-attach can find it. Close the record here: a `failed` install is
      // recoverable — the subagent is told what happened and can run the command
      // itself — where a `running` one that nobody owns is not.
      console.error("[coder-workspace] the install could not be started", {
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
      await this.#putInstall(failed);
      await this.#wake.clear(INSTALL_WATCH).catch(() => {});
      return failed;
    }

    await own(handle);

    return state;
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
    const context = await this.ctx.storage.get<{ dir: string }>(
      "install:context"
    );
    if (!context?.dir) return state;
    if (!(await this.#dependenciesPresent(context.dir))) return state;

    console.info("[coder-workspace] dependencies are back — clearing failure", {
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
    await this.#putInstall(done);
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
    const state =
      (await this.ctx.storage.get<InstallState>(INSTALL_KEY)) ??
      ({ state: "idle" } as InstallState);

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
    const limit = (INSTALL_PLAN.timeoutMs ?? 20 * 60_000) + INSTALL_STALE_MS;
    if (Date.now() - state.startedAt > limit) {
      const minutes = Math.round((Date.now() - state.startedAt) / 60_000);
      console.error("[coder-workspace] abandoning a stale install", {
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
      await this.#putInstall(failed);
      await this.#wake.clear(INSTALL_WATCH).catch(() => {});
      return failed;
    }

    if (!this.#draining) {
      await this.#reattachInstall();
      return (await this.ctx.storage.get<InstallState>(INSTALL_KEY)) ?? state;
    }
    return state;
  }

  /** True while this isolate holds the drain, so the watchdog leaves it alone. */
  #draining = false;

  async #drainInstall(
    handle: WorkspaceRuntimeExecHandle<"utf8">
  ): Promise<void> {
    this.#draining = true;
    const context = await this.ctx.storage.get<{
      dir: string;
      fingerprint: string | null;
      command: string;
      startedAt: number;
    }>("install:context");
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
     * `startedAt` is the generation marker. `startInstall` rewrites
     * `install:context` before it spawns, so a drain whose stamp no longer
     * matches has been superseded and has nothing useful left to say.
     */
    let superseded = false;
    const stillMine = async (): Promise<boolean> => {
      const now = await this.ctx.storage.get<{ startedAt: number }>(
        "install:context"
      );
      if (now?.startedAt === startedAt) return true;
      superseded = true;
      console.warn("[coder-workspace] discarding a superseded install drain", {
        id: this.ctx.id.toString(),
        command,
        startedAt,
        current: now?.startedAt
      });
      return false;
    };

    try {
      const result = await handle.result();
      const tail = (result.stdout + result.stderr).slice(-2000);
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
        console.info("[coder-workspace] install finished", {
          id: this.ctx.id.toString(),
          command,
          seconds: Math.round((Date.now() - startedAt) / 1000)
        });
        await this.#putInstall({
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
        console.error("[coder-workspace] install failed", {
          id: this.ctx.id.toString(),
          command,
          exitCode: result.exitCode,
          seconds: Math.round((Date.now() - startedAt) / 1000),
          tail: tail.slice(-1000)
        });
        await this.#putInstall({
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
      console.error("[coder-workspace] install drain failed", {
        id: this.ctx.id.toString(),
        command,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        err: String(err)
      });
      await this.#putInstall({
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
      if (!superseded) await this.#wake.clear(INSTALL_WATCH).catch(() => {});
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
      console.warn("[coder-workspace] could not re-attach to the install", {
        id: this.ctx.id.toString(),
        err: String(err)
      });
      const context = await this.ctx.storage.get<{ command: string }>(
        "install:context"
      );
      await this.#putInstall({
        state: "failed",
        command: context?.command ?? "(unknown)",
        finishedAt: Date.now(),
        error:
          "the install stopped without reporting — its container was most " +
          "likely replaced. Re-run it with sb_exec, or clone again to restart it."
      });
      await this.#wake.clear(INSTALL_WATCH).catch(() => {});
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
      console.error("[coder-workspace] could not read the wake map", {
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
          console.error("[coder-workspace] wake intent failed", {
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
          console.error("[coder-workspace] dropping a stuck wake intent", {
            id: this.ctx.id.toString(),
            key: intent.key,
            attempt: after.attempt
          });
          await this.#wake.clear(intent.key).catch(() => {});
        }
      }
    } finally {
      await this.#wake.rearm().catch((err: unknown) => {
        console.error("[coder-workspace] could not re-arm the alarm", {
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
        console.error("[coder-workspace] pending sync exhausted", {
          id: this.ctx.id.toString(),
          backend,
          attempt: result.attempt,
          err: result.error
        });
        await this.#wake.clear(intent.key);
      }
      return;
    }

    if (intent.key === INSTALL_RUN) {
      // Cleared first, and unconditionally. This handler runs for minutes, and an
      // intent left in place would be re-dispatched by the next wake — arming a
      // second `npm ci` alongside the first, which is how a tree gets corrupted.
      // `startInstall`'s in-flight guard would catch that, but the cheaper answer
      // is not to schedule it twice.
      await this.#wake.clear(intent.key);

      const context = await this.ctx.storage.get<{
        dir: string;
        repo?: string;
      }>("install:context");
      const armedAt = await this.ctx.storage.get<number>(INSTALL_ARMED);
      await this.ctx.storage.delete(INSTALL_ARMED);
      if (!context?.dir || armedAt === undefined) return;

      const state = await this.#installAwaited(
        {
          dir: context.dir,
          ...(context.repo ? { repo: context.repo } : {})
        },
        armedAt
      );
      console.info("[coder-workspace] armed reinstall finished", {
        id: this.ctx.id.toString(),
        dir: context.dir,
        state: state.state
      });
      return;
    }

    if (intent.key === INSTALL_WATCH) {
      const state = await this.ctx.storage.get<InstallState>(INSTALL_KEY);
      if (state?.state !== "running") {
        await this.#wake.clear(intent.key);
        return;
      }
      // Still running and nobody draining it: this isolate is new since the
      // command started. Re-attach, and come back if it is still going.
      await this.#reattachInstall();
      await this.#wake.set({
        key: INSTALL_WATCH,
        notBefore: Date.now() + INSTALL_WATCH_MS
      });
      return;
    }

    if (intent.key === IDLE_RECLAIM) {
      const { reclaimed, idleMs } = await this.reclaimIfIdle();
      // Not idle after all — something used it since this was armed. `#touch`
      // has already moved the deadline, so there is nothing to re-arm; clearing
      // would throw away the *new* intent, so this deliberately does neither.
      if (!reclaimed) {
        console.info("[coder-workspace] idle reclaim deferred", {
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
      const state = await this.ctx.storage.get<InstallState>(INSTALL_KEY);
      if (state?.state === "running") {
        await this.#wake.set({
          key: CONTAINER_IDLE,
          notBefore: Date.now() + CONTAINER_IDLE_MS
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
      if (idleMs < CONTAINER_IDLE_MS) {
        await this.#wake.set({
          key: CONTAINER_IDLE,
          notBefore: lastUsedAt + CONTAINER_IDLE_MS
        });
        return;
      }

      await this.#stopContainer();
      await this.#wake.clear(intent.key);
      return;
    }

    console.warn("[coder-workspace] unknown wake intent", {
      id: this.ctx.id.toString(),
      key: intent.key
    });
    await this.#wake.clear(intent.key);
  }
}
