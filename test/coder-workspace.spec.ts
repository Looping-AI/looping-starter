import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeDoHelpers } from "@loopingai/core/testing";
import { getWorkspace } from "@cloudflare/computer";
import type { InstallState } from "@loopingai/plugins/computer";
import { INSTALL_PLAN } from "@/workspace/install-plan";

/**
 * The install gate, and the two ways it used to hang forever.
 *
 * `running` is the only install state that **blocks work**: `sb_exec` waits on
 * it and then refuses to run anything. Every other state is a fact the subagent
 * can act on — so `running` is the one that must never outlive the command it
 * describes.
 *
 * It did, in production. A `runtime.exec` that threw on the container's
 * WebSocket left the record saying `running` with nothing draining it and no
 * watchdog armed; every `sb_exec` for the next half hour polled the gate, waited
 * ninety seconds and ran nothing, until the chunk hit the ten-minute step
 * timeout and Workflows retried it into the same wall. The task never reached a
 * terminal state and the gateway never got its callback.
 *
 * Both tests below run **without a container**, which is not a limitation here
 * but the point: the pool cannot start one, so `runtime.exec` fails exactly the
 * way it failed in production.
 */

/** A fresh workspace per test — DO storage never leaks between them. */
const { freshStub: freshWorkspace } = makeDoHelpers(env.CODER_WORKSPACE);

/** Read the raw install record, bypassing the staleness repair `advisories` applies. */
function storedInstall(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<InstallState>("install")
  );
}

/**
 * Put a checkout in the workspace that the resolver will act on.
 *
 * Without this the resolver finds no `package.json`, returns `skip`, and
 * `startInstall` never reaches the spawn — so the spawn test would pass while
 * testing nothing at all.
 */
async function seedCheckout(stub: DurableObjectStub, dir: string) {
  using ws = await getWorkspace(
    stub as unknown as Parameters<typeof getWorkspace>[0]
  );
  await ws.fs.mkdir(dir, { recursive: true });
  await ws.fs.writeFile(`${dir}/package.json`, '{"name":"probe"}');
  await ws.fs.writeFile(`${dir}/package-lock.json`, '{"lockfileVersion":3}');
}

describe("the install gate", () => {
  it("reports failed, not running, when the command cannot be started", async () => {
    const stub = freshWorkspace("install-spawn");
    const dir = "/workspace/probe";
    await seedCheckout(stub, dir);

    // The resolver now has a lockfile to act on, so `startInstall` gets all the
    // way to the spawn — where there is no container, which is precisely how it
    // failed in production.
    const state = await stub.startInstall({ dir });

    expect(state.state).toBe("failed");
    if (state.state === "failed") {
      expect(state.command).toBe("npm ci --no-audit --no-fund");
    }

    // And it is written down: a caller reading the record later has to see the
    // same answer this one got, or the gate closes behind it.
    expect((await storedInstall(stub))?.state).toBe("failed");
  });

  it("abandons a running record that is past its own timeout", async () => {
    const stub = freshWorkspace("install-stale");
    const limit = INSTALL_PLAN.timeoutMs ?? 20 * 60_000;

    // Seed the exact state production was stuck in: running, nobody draining
    // it, and long enough ago that the runtime would have killed the command.
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - limit - 10 * 60_000
      } satisfies InstallState)
    );

    const [advisory] = await stub.advisories();

    expect(advisory?.kind).toBe("deps-broken");
    // The message is load-bearing — it is what the subagent reads instead of
    // waiting, so it has to say the command is not coming back.
    if (advisory?.kind === "deps-broken") {
      expect(advisory.error).toMatch(/not going to finish/);
    }

    // And it is written down, so the next `sb_exec` does not re-derive it.
    expect((await storedInstall(stub))?.state).toBe("failed");
  });

  /**
   * `repo_clone` starts the install, and a retried chunk starts it again —
   * three times in fifty seconds, in the run this test comes from. Each spawn
   * used the same exec id, so it displaced the last, and the displaced
   * command's drain was still attached: it then wrote *its* verdict over a
   * record describing an install that was still running. The subagent read a
   * "dependency install failed" belonging to a command that no longer existed.
   */
  it("resolves a running record before starting another install", async () => {
    const stub = freshWorkspace("install-reentry");
    const dir = "/workspace/probe";
    await seedCheckout(stub, dir);

    const startedAt = Date.now() - 30_000;
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt
      } satisfies InstallState)
    );

    const state = await stub.startInstall({ dir });

    // The invariant: the pre-existing `running` is never simply ignored. It is
    // either confirmed live and handed back, or resolved — and here, with no
    // container to re-attach to, resolved is the honest answer.
    expect(state).not.toMatchObject({ state: "running", startedAt });
    // Whatever it decided, the record agrees. A returned verdict that differs
    // from the stored one is how the subagent ends up reading a result that
    // describes nothing.
    expect((await storedInstall(stub))?.state).toBe(state.state);
    // The guard's live path — returning the in-flight install untouched — needs
    // a real container to reach, since the record is verified rather than
    // trusted. It is covered end to end rather than here.
  });

  it("leaves a young running record alone", async () => {
    const stub = freshWorkspace("install-young");

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "running",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - 30_000
      } satisfies InstallState)
    );

    // Half a minute in, with no container to re-attach to. The re-attach fails
    // and says so — what must *not* happen is the staleness bound firing early
    // and declaring a healthy install dead thirty seconds after it started.
    const [advisory] = await stub.advisories();
    if (advisory?.kind === "deps-broken") {
      expect(advisory.error).not.toMatch(/not going to finish/);
    }
  });

  /**
   * The counterweight to the staleness bound: `skipped` means the resolver looked
   * and found nothing to install, so a missing `node_modules` is the correct and
   * permanent state rather than a symptom. Nothing should chase it.
   */
  it("leaves a checkout with nothing to install alone", async () => {
    const stub = freshWorkspace("install-skipped");

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "skipped",
        reason: "no package.json"
      } satisfies InstallState);
      await state.storage.put("install:context", {
        dir: "/workspace/probe",
        fingerprint: null,
        command: "(none)",
        startedAt: Date.now()
      });
    });

    // `deps-absent`, not silence: a session that finds no `node_modules` should
    // be told the host looked and there was nothing to install, rather than left
    // to wonder whether an install is still coming.
    expect(await stub.advisories()).toEqual([
      { kind: "deps-absent", reason: "no package.json" }
    ]);
  });

  /**
   * A `failed` record is never retried on its own.
   *
   * Re-driving it from the gate would loop rather than recover — the install
   * failed for a reason, and the reason is usually still there. It stays the
   * subagent's to act on, via the warning the gate renders in front of the next
   * command.
   */
  it("does not auto-retry a failed install", async () => {
    const stub = freshWorkspace("install-failed-sticky");

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("install", {
        state: "failed",
        command: "npm ci --no-audit --no-fund",
        finishedAt: Date.now() - 30_000,
        error: "the container was unreachable"
      } satisfies InstallState)
    );

    // Reported whatever the `node_modules` probe says. That probe is `test -d`,
    // which the wreckage of a half-finished install satisfies just as well as a
    // healthy tree, so it qualifies the advisory rather than deleting it — and
    // the record itself is never rewritten to say something it did not observe.
    const advisories = await stub.advisories();
    expect(advisories.map((a) => a.kind)).toEqual(["deps-broken"]);
    expect((await storedInstall(stub))?.state).toBe("failed");
  });
});

/**
 * Arming the install the moment a cold container is seen.
 *
 * This is the *ordinary* second task, not an edge case. `node_modules` lives in
 * the container and dies with it; the install record lives in this object's
 * storage and does not. So once the container is reclaimed for idleness, a `done`
 * record describes a tree that is gone — and `startInstall` is only ever reached
 * from `repo_clone`, which a follow-up task never calls, because its checkout is
 * already here.
 *
 * That gap cost 99 seconds of `npm ci` inside a round. Closing it by probing from
 * the gate cost far more: the install was started from a poll that returned in
 * milliseconds, its drain died with that invocation, and the half-written tree
 * took a nine-minute task to unpick.
 *
 * So detection is a boolean read here, and the install itself belongs to the
 * alarm. These tests cover the detection; the alarm's own handler needs a
 * container and is covered end to end.
 */
describe("arming a reinstall for a cold container", () => {
  const armed = (stub: DurableObjectStub) =>
    runInDurableObject(stub, (_instance, state) =>
      state.storage.get<number>("install:armed")
    );

  /** A workspace that installed successfully, before its container went away. */
  async function seedInstalled(stub: DurableObjectStub, dir: string) {
    // The checkout has to be here too, or the resolver finds no `package.json`,
    // answers `skip`, and the armed install proves nothing by never reaching a
    // spawn — which is exactly how the first draft of this passed while testing
    // half of what it claimed.
    await seedCheckout(stub, dir);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "done",
        command: "npm ci --no-audit --no-fund",
        exitCode: 0,
        finishedAt: Date.now() - 60_000,
        ms: 80_000
      } satisfies InstallState);
      await state.storage.put("install:context", {
        dir,
        fingerprint: "stale",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - 140_000
      });
    });
  }

  /** Touch the workspace the way anything reaching it does — via the stub hook. */
  async function touchWorkspace(stub: DurableObjectStub) {
    using ws = await getWorkspace(
      stub as unknown as Parameters<typeof getWorkspace>[0]
    );
    void ws;
  }

  /**
   * Wait for the armed install to reach a terminal state.
   *
   * The alarm fires promptly — promptly enough that a first draft of these tests
   * raced it and read `install:armed` after the handler had already consumed it.
   * That is the system working, so these assert the settled outcome rather than a
   * marker that is meant to be transient.
   */
  async function settled(stub: DurableObjectStub, ms = 5_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const state = await storedInstall(stub);
      if (state?.state !== "running") return state;
      if (Date.now() > deadline) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("arms on the first workspace access, and the alarm carries it out", async () => {
    const stub = freshWorkspace("arm-cold");
    await seedInstalled(stub, "/workspace/probe");

    // `getWorkspace` goes through `__getWorkspaceStub`, which is the hook — the
    // earliest point in a task, before any command runs.
    await touchWorkspace(stub);

    // `failed` is the whole assertion. Getting there means the record left
    // `done` (so arming happened) *and* something tried to spawn an install (so
    // the alarm ran it) — and with no container in the pool, a spawn cannot
    // succeed. The old code returned `done` here and let a doomed command run.
    expect((await settled(stub))?.state).toBe("failed");
  });

  /**
   * The bound on retrying, and it has to exist.
   *
   * Arming is naturally once-only for an install that *succeeds*: it leaves
   * `done` with the container up, so the `container.running` check short-circuits
   * everything after. A failing one has no such property — it lands back on
   * `failed` with the container still down, and `__getWorkspaceStub` is the
   * busiest entry point in the object, so without a cooldown it would re-arm on
   * essentially every tool call.
   *
   * This test is the one that caught that: extending arming to `failed` made it
   * fail, which is the whole reason `INSTALL_ARM_COOLDOWN_MS` exists.
   */
  it("does not re-arm again immediately after a failure", async () => {
    const stub = freshWorkspace("arm-cooldown");
    await seedInstalled(stub, "/workspace/probe");

    await touchWorkspace(stub);
    expect((await settled(stub))?.state).toBe("failed");
    const after = await storedInstall(stub);

    // Two more accesses, as a task would make dozens of.
    await touchWorkspace(stub);
    await touchWorkspace(stub);

    // Untouched: no new `running`, and the same terminal record as before.
    expect((await storedInstall(stub))?.state).toBe("failed");
    expect(await storedInstall(stub)).toStrictEqual(after);
    expect(await armed(stub)).toBeUndefined();
  });

  /**
   * A caller's very first task: nothing has ever been installed, so there is no
   * record of *where* to install. `repo_clone` and its `afterCheckout` hook own
   * this case, exactly as they always have.
   */
  /**
   * A failed install must not poison the workspace forever.
   *
   * Arming originally required `done`, and the gap showed up immediately: a run
   * whose install failed left that record behind, the next task declined to arm,
   * and it was rescued only because the parent happened to call `repo_clone`.
   * Without that coincidence the subagent is back to running `npm ci` by hand
   * inside the round — the thing all of this exists to prevent.
   */
  it("arms for a workspace whose last install failed", async () => {
    const stub = freshWorkspace("arm-after-failure");
    const dir = "/workspace/probe";
    await seedCheckout(stub, dir);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("install", {
        state: "failed",
        command: "npm ci --no-audit --no-fund",
        finishedAt: Date.now() - 60_000,
        error: "the container was unreachable"
      } satisfies InstallState);
      await state.storage.put("install:context", {
        dir,
        fingerprint: "stale",
        command: "npm ci --no-audit --no-fund",
        startedAt: Date.now() - 140_000
      });
    });

    await touchWorkspace(stub);

    /**
     * Asserting `failed` would prove nothing — the record went in `failed` and a
     * version that armed nothing would leave it that way. The *message* is what
     * discriminates: the seeded one is invented by this test, and only a real
     * spawn attempt replaces it with the one `#beginInstall` writes when the
     * container cannot be reached.
     */
    const state = await settled(stub);
    expect(state?.state).toBe("failed");
    if (state?.state === "failed") {
      expect(state.error).toMatch(/could not be started/);
      expect(state.error).not.toMatch(/the container was unreachable$/);
    }
    expect(await armed(stub)).toBeUndefined();
  });

  it("arms nothing when no install has ever run", async () => {
    const stub = freshWorkspace("arm-first-task");

    await touchWorkspace(stub);

    expect(await armed(stub)).toBeUndefined();
    expect((await storedInstall(stub))?.state ?? "idle").toBe("idle");
  });
});

/**
 * Reclaiming, and the weekly loop it used to run forever.
 *
 * `lastUsedAt` is written by `#touch()` and removed by the `deleteAll()` that
 * reclaiming performs — so a workspace that has *already* been reclaimed reads
 * exactly like one that was never used. Defaulting that to `0` made it look
 * idle since the epoch, which is maximally idle: every weekly sweep re-reclaimed
 * every workspace it had ever reclaimed, recreating storage just to empty it
 * again and logging a reclaim that did not happen. Both the candidate table and
 * the RPC work grew for the lifetime of the caller.
 */
describe("reclaiming an idle workspace", () => {
  it("reports nothing to do for a workspace nothing has ever used", async () => {
    const stub = freshWorkspace("never-used");

    const result = await stub.reclaimIfIdle();

    // Not `reclaimed: true` with an epoch-sized `idleMs`, which is what an
    // absent `lastUsedAt` used to produce.
    expect(result.reclaimed).toBe(false);
    expect(result.idleMs).toBe(0);
  });

  it("stays false however long the sweep waits", async () => {
    // The bug was not a threshold being too low — it was a missing record
    // reading as "idle forever", so no `maxIdleMs` could ever make it false.
    const stub = freshWorkspace("never-used-zero-threshold");

    expect((await stub.reclaimIfIdle(0)).reclaimed).toBe(false);
  });

  /**
   * The other half: a workspace that has been used is still reclaimable, so the
   * fix above cannot have been "never reclaim anything".
   */
  it("still reclaims one that was used and then went idle", async () => {
    const stub = freshWorkspace("used-then-idle");
    // `getWorkspace` is the busiest entry point and the one that touches.
    using ws = await getWorkspace(
      stub as unknown as Parameters<typeof getWorkspace>[0]
    );
    await ws.fs.mkdir("/workspace/repo", { recursive: true });

    // A zero threshold stands in for a week having passed.
    expect((await stub.reclaimIfIdle(0)).reclaimed).toBe(true);
    // And once emptied it reports nothing to do rather than reclaiming again,
    // which is the loop this whole describe exists for.
    expect((await stub.reclaimIfIdle(0)).reclaimed).toBe(false);
  });
});
