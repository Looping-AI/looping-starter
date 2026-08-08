import { describe, it, expect } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { TaskState } from "@a2a-js/sdk";
import type { GatewayIdentity } from "@loopingai/core/a2a";
import { env } from "cloudflare:workers";
import type { ProactiveAgent } from "@/agents/proactive/agent";
import { proactive } from "@/agents/proactive/definition";
import { runNotifyTask } from "@/agents/proactive/workflow";

/**
 * Cancellation, on the proactive agent's straight-line task controller.
 *
 * Both facts asserted here are ones the delegating round loop already
 * guaranteed, and both were *lost* when this loop was written as a second copy:
 * `markWorking`'s verdict was discarded, and terminal delivery probed with a
 * separate `getTask` instead of keying on the guarded write. Neither failure is
 * visible in a type or a lint — the only thing that catches them is a spec that
 * puts the DO into the state each check exists for.
 *
 * That drift is why the round loop now lives in `@loopingai/core/round` rather
 * than in this repo. This agent keeps its own loop, deliberately — it is the
 * evidence core stopped at the right place — so it keeps these specs too.
 *
 * The first two specs drive a **fake stub**, because that is the only way to
 * reach the window that matters. The old delivery read `getTask` and then wrote
 * `saveTask` — two round trips — so the race lives strictly between them, and a
 * real DO cannot be cancelled in that gap from a test. A stub whose `getTask`
 * still reports `working` while `saveTask` refuses the write *is* that gap. The
 * last spec runs the real DO, to prove the stubbed verdicts are the ones the
 * database actually returns.
 */

const IDENTITY: GatewayIdentity = {
  key: "custom:test:proactive",
  name: "test-caller",
  kind: "custom",
  workspaceId: 1
};

interface FakeStepOptions {
  /**
   * Step results served without invoking the body — what a Workflow replay does
   * with an already-durable step. Lets a spec drive the orchestration with no
   * live model behind `generate`.
   */
  cached?: Record<string, unknown>;
  /**
   * Extra attempts a throwing body gets, like the platform's own step retries.
   * Zero (the default) keeps every other spec's single-shot behaviour.
   */
  retries?: number;
}

/** A `WorkflowStep` that records the step names the orchestration reached. */
function fakeStep(options: FakeStepOptions = {}) {
  const ran: string[] = [];
  const step = {
    async do(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const body = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      ran.push(name);
      if (Object.hasOwn(options.cached ?? {}, name))
        return options.cached![name];
      let last: unknown;
      for (let attempt = 0; attempt <= (options.retries ?? 0); attempt++) {
        try {
          return await body();
        } catch (err) {
          last = err;
        }
      }
      throw last;
    }
  } as unknown as WorkflowStep;
  return { step, ran };
}

/** The four DO methods this controller calls, and what each should answer. */
interface FakeAgentOptions {
  markWorking?: "ok" | "canceled";
  /** Whether the guarded terminal write applies. `false` ⇒ a cancel won. */
  saveTask?: boolean;
  /** What a `getTask` probe reports — deliberately allowed to disagree. */
  probeState?: TaskState;
}

function fakeAgent(options: FakeAgentOptions = {}) {
  const calls: string[] = [];
  const stub = {
    async markWorking() {
      calls.push("markWorking");
      return options.markWorking ?? "ok";
    },
    async converse() {
      calls.push("converse");
      return { kind: "reply", text: "here you go" };
    },
    async getTask() {
      calls.push("getTask");
      return {
        status: {
          state: options.probeState ?? TaskState.TASK_STATE_WORKING
        }
      };
    },
    async saveTask() {
      calls.push("saveTask");
      return options.saveTask ?? true;
    }
  } as unknown as DurableObjectStub<ProactiveAgent>;
  return { stub, calls };
}

function params(taskId: string) {
  return {
    taskId,
    text: "are you there?",
    identity: IDENTITY,
    contextId: `ctx-${taskId}`,
    // Unreachable on purpose: a spec that posts here has already failed the
    // assertion it cares about.
    pushUrl: "https://gateway.invalid/push",
    pushToken: "push-token",
    jku: "https://agent.invalid/.well-known/jwks.json"
  };
}

describe("a task canceled before the workflow starts", () => {
  it("never generates and never calls back", async () => {
    const { stub, calls } = fakeAgent({ markWorking: "canceled" });
    const { step, ran } = fakeStep();

    await runNotifyTask(params("t1"), step, {
      resolveAgent: () => stub,
      signingKey: env.A2A_SIGNING_KEY
    });

    // `markWorking` reports the cancellation itself, so the pipeline stops on
    // its verdict rather than on a separate probe. Discarding that verdict —
    // which this agent did — bills a model call and posts a callback for a task
    // the caller already abandoned.
    expect(ran).toEqual(["working"]);
    expect(calls).toEqual(["markWorking"]);
    expect(calls).not.toContain("converse");
  });
});

describe("a task canceled while the model is working", () => {
  it("keys the callback on the guarded write, not on a probe", async () => {
    // The probe says `working` and the write says "refused". Those disagree
    // exactly as they do in production when a `CancelTask` lands between the
    // two round trips the old delivery made. Only the write is authoritative:
    // it does its read and its write in one synchronous pass inside the DO.
    const { stub, calls } = fakeAgent({
      probeState: TaskState.TASK_STATE_WORKING,
      saveTask: false
    });
    const { step, ran } = fakeStep({
      cached: { generate: { kind: "reply", text: "here you go" } }
    });

    await runNotifyTask(params("t2"), step, {
      resolveAgent: () => stub,
      signingKey: env.A2A_SIGNING_KEY
    });

    expect(ran).toContain("complete");
    expect(ran).not.toContain("notify");
    // The probe is gone entirely — consulting it is what left the window open.
    expect(calls).not.toContain("getTask");
  });
});

describe("the ordinary path", () => {
  it("completes and notifies when nothing cancels", async () => {
    const { stub } = fakeAgent({ saveTask: true });
    // `notify` is cached too: this asserts the orchestration reaches it, not
    // that an unreachable gateway answers.
    const { step, ran } = fakeStep({
      cached: {
        generate: { kind: "reply", text: "here you go" },
        notify: undefined
      }
    });

    await runNotifyTask(params("t3"), step, {
      resolveAgent: () => stub,
      signingKey: env.A2A_SIGNING_KEY
    });

    expect(ran).toEqual(["working", "generate", "complete", "notify"]);
  });
});

describe("a Durable Object replaced under a running workflow", () => {
  /**
   * The third fact this second copy of the loop has to keep for itself.
   *
   * A DO stub is a live connection, not a durable address. When the runtime
   * severs it — a deploy replacing the object's code is the ordinary way — it
   * does not reconnect; it rejects with the reason it broke, forever. So a run
   * that resolves one stub and closes over it has retries that cannot retry:
   * they re-enter the step body and re-call a corpse, failing in microseconds
   * however long the backoff waited.
   *
   * This cost a task in production on the round loop — a deploy landed mid-turn
   * and every retry, plus the failure handler behind them, died on the same
   * severed stub, so the gateway received no callback at all. `@loopingai/core`
   * fixed `runHandleTask`; this loop is a deliberate second copy and had the
   * identical line. That is the same drift the file header describes, caught a
   * third time — so it gets specs here rather than a note.
   */

  /**
   * Evict the agent DO *during* a named call, the way the runtime does.
   *
   * The eviction is a moment in time, not a property of a call site, so this
   * models both halves. The stub live at that moment is broken **for good** —
   * every later call on that same object rejects, which is what makes a hoisted
   * stub unrecoverable. Every stub resolved *afterwards* is healthy, which is
   * what makes resolving per step body the fix.
   */
  function evictOn(
    live: Record<string, (...a: never[]) => unknown>,
    on: string
  ) {
    let evicted = false;
    // Calls that hit a severed stub. The count is the point, not bookkeeping:
    // it is the only place a rejection is observable, since a severed call
    // never reaches the fake agent's own log.
    let rejected = 0;
    const severed = (): never => {
      throw new Error("Durable Object reset because its code was updated.");
    };
    const resolveAgent = () => {
      if (evicted) return live as unknown as DurableObjectStub<ProactiveAgent>;
      let broken = false;
      return Object.fromEntries(
        Object.keys(live).map((key) => [
          key,
          async (...args: never[]) => {
            if (broken) {
              rejected += 1;
              severed();
            }
            if (key === on) {
              broken = true;
              evicted = true;
              rejected += 1;
              severed();
            }
            return live[key](...args);
          }
        ])
      ) as unknown as DurableObjectStub<ProactiveAgent>;
    };
    return { resolveAgent, rejections: () => rejected };
  }

  it("recovers the generation the eviction interrupted", async () => {
    // `generate` is this loop's long step — a whole model call — so it is the
    // one an eviction is most likely to land inside, exactly as the round loop's
    // `executeSubtaskChunk` was. Its retry must reach a live object and produce
    // the reply, not re-call the severed one and burn every attempt.
    const { stub, calls } = fakeAgent();
    const { step, ran } = fakeStep({
      retries: 5,
      cached: { notify: undefined }
    });
    const evicted = evictOn(
      stub as unknown as Record<string, (...a: never[]) => unknown>,
      "converse"
    );

    await runNotifyTask(params("t4"), step, {
      resolveAgent: evicted.resolveAgent,
      signingKey: env.A2A_SIGNING_KEY
    });

    // The eviction landed on the generation, and the retry then ran it for real.
    expect(evicted.rejections()).toBe(1);
    expect(calls.filter((c) => c === "converse")).toHaveLength(1);
    expect(ran).toEqual(["working", "generate", "complete", "notify"]);
  });

  it("recovers the terminal write, so a delivered task is never lost", async () => {
    // `complete` is the step that must not be lost. Everything after it — the
    // gateway's callback — is keyed on its verdict, so a stub severed here is
    // how a task that generated a perfectly good reply ends up never delivering
    // it.
    const { stub, calls } = fakeAgent({ saveTask: true });
    const { step, ran } = fakeStep({
      retries: 5,
      cached: {
        generate: { kind: "reply", text: "here you go" },
        notify: undefined
      }
    });
    const evicted = evictOn(
      stub as unknown as Record<string, (...a: never[]) => unknown>,
      "saveTask"
    );

    await runNotifyTask(params("t5"), step, {
      resolveAgent: evicted.resolveAgent,
      signingKey: env.A2A_SIGNING_KEY
    });

    expect(evicted.rejections()).toBe(1);
    expect(calls.filter((c) => c === "saveTask")).toHaveLength(1);
    expect(ran).toContain("notify");
  });

  it("resolves per step body, not once per run", async () => {
    // The property stated directly. A hoisted stub resolves exactly once no
    // matter how many steps run, and that count is the whole difference between
    // a retry that can recover and one that cannot.
    const { stub } = fakeAgent();
    let resolved = 0;
    const { step } = fakeStep({ cached: { notify: undefined } });

    await runNotifyTask(params("t6"), step, {
      resolveAgent: () => {
        resolved += 1;
        return stub;
      },
      signingKey: env.A2A_SIGNING_KEY
    });

    // `working`, `generate` and `complete` each reach the DO; `notify` is served
    // from cache and never touches it.
    expect(resolved).toBe(3);
  });
});

/**
 * Twice vitest's 5s default, and only the spec below needs it.
 *
 * Everything else in this file drives a fake stub and returns in microseconds.
 * That one reaches a **real** Durable Object, so it pays for a cold start plus
 * five sequential RPC round trips. It fits comfortably on an idle machine and has
 * intermittently blown 5s when the other test files run in parallel beside it —
 * a flake that says nothing about the code under test, and the kind that erodes
 * trust in the suite faster than a real failure does.
 */
const REAL_DO_TIMEOUT_MS = 10_000;

describe("against the real Durable Object", () => {
  it(
    "reports cancellation from both markWorking and the guarded save",
    async () => {
      // The stubs above assert what the controller does with each verdict. This
      // asserts the verdicts are real — that `AgentDB` actually answers this way
      // once a row is canceled, so the two specs are not agreeing with each other
      // about a database neither of them touched.
      const identity: GatewayIdentity = {
        ...IDENTITY,
        key: `custom:test:real:${crypto.randomUUID()}`
      };
      const stub = proactive.resolveAgent(env, identity);
      const taskId = "task-real";

      await stub.beginTask({
        messageId: "msg-1",
        taskId,
        contextId: `ctx-${taskId}`
      });
      expect(await stub.markWorking(taskId)).toBe("ok");

      await stub.cancelTask(taskId);

      expect(await stub.markWorking(taskId)).toBe("canceled");
      expect(
        await stub.saveTask({
          id: taskId,
          contextId: `ctx-${taskId}`,
          status: { state: TaskState.TASK_STATE_COMPLETED }
        } as Parameters<typeof stub.saveTask>[0])
      ).toBe(false);
    },
    REAL_DO_TIMEOUT_MS
  );
});
