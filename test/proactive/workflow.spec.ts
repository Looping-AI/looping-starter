import { describe, it, expect, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { TaskState } from "@a2a-js/sdk";
import type { GatekeeperIdentity, PlainTask } from "@dynamicagents/core/a2a";
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
 * That drift is why the round loop now lives in `@dynamicagents/core/round` rather
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

const IDENTITY: GatekeeperIdentity = {
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
}

/** A `WorkflowStep` that records the step names the orchestration reached. */
function fakeStep(options: FakeStepOptions = {}) {
  const ran: string[] = [];
  const step = {
    async do(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const body = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      ran.push(name);
      return Object.hasOwn(options.cached ?? {}, name)
        ? options.cached![name]
        : await body();
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
  const saved: PlainTask[] = [];
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
    async saveTask(task: PlainTask) {
      calls.push("saveTask");
      saved.push(task);
      return options.saveTask ?? true;
    }
  } as unknown as DurableObjectStub<ProactiveAgent>;
  return { stub, calls, saved };
}

/** Stands in for the agent's own copy; the spec only cares that it is delivered. */
const ABANDONED_COPY = "PROACTIVE ABANDONED COPY";

function params(taskId: string) {
  return {
    taskId,
    text: "are you there?",
    identity: IDENTITY,
    contextId: `ctx-${taskId}`,
    // Unreachable on purpose: a spec that posts here has already failed the
    // assertion it cares about.
    pushUrl: "https://gatekeeper.invalid/push",
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
      signingKey: env.A2A_SIGNING_KEY,
      abandonedCopy: ABANDONED_COPY
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
      signingKey: env.A2A_SIGNING_KEY,
      abandonedCopy: ABANDONED_COPY
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
    // that an unreachable gatekeeper answers.
    const { step, ran } = fakeStep({
      cached: {
        generate: { kind: "reply", text: "here you go" },
        notify: undefined
      }
    });

    await runNotifyTask(params("t3"), step, {
      resolveAgent: () => stub,
      signingKey: env.A2A_SIGNING_KEY,
      abandonedCopy: ABANDONED_COPY
    });

    expect(ran).toEqual(["working", "generate", "complete", "notify"]);
  });
});

/**
 * The third terminal shape, and the one core's own round loop has no equivalent
 * of — which is why `deliverTerminalTask` takes the Task from its caller rather
 * than choosing between two itself.
 */
describe("a turn that deliberately says nothing", () => {
  it("still completes and still calls back, carrying no message", async () => {
    const { stub, saved } = fakeAgent({ saveTask: true });
    const { step, ran } = fakeStep({
      cached: { generate: { kind: "no_reply" }, notify: undefined }
    });

    await runNotifyTask(params("t4"), step, {
      resolveAgent: () => stub,
      signingKey: env.A2A_SIGNING_KEY,
      abandonedCopy: ABANDONED_COPY
    });

    // No shortcut to the end: the gatekeeper's pending row has to resolve whether
    // or not there is anything to say, so this path runs the same four steps.
    expect(ran).toEqual(["working", "generate", "complete", "notify"]);
    expect(saved).toHaveLength(1);
    expect(saved[0].status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    // Completed, but with nothing to post.
    expect(saved[0].status?.message).toBeUndefined();
  });
});

describe("against the real Durable Object", () => {
  it("reports cancellation from both markWorking and the guarded save", async () => {
    // The stubs above assert what the controller does with each verdict. This
    // asserts the verdicts are real — that `AgentDB` actually answers this way
    // once a row is canceled, so the two specs are not agreeing with each other
    // about a database neither of them touched.
    const identity: GatekeeperIdentity = {
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
    // Five round trips into a cold Durable Object, the first of which runs
    // core's whole migration journal. Vitest's 5 s default is enough on an idle
    // machine and not enough when the pool is running every other spec file
    // alongside it — which showed up as a timeout here the day an unrelated
    // seventh spec was added. The test is not slow because anything is wrong;
    // it is slow because it is the only one that boots a real agent.
  }, 20_000);
});

/**
 * What the instance record says once the run is over.
 *
 * Every terminal shape this agent has must be distinguishable in the value
 * `run()` returns, because that value is the Workflow instance's `output` and
 * nothing else records the outcome: a delivered failure and a delivered reply
 * are otherwise the same `complete` instance with the same `ok` steps.
 *
 * That includes the shape core's round loop has no equivalent of — a turn that
 * completed with nothing to say — which is why this agent carries its own
 * verdict type rather than core's.
 */
describe("the verdict a finished run returns", () => {
  /**
   * An agent whose `generate` step can never succeed, so the run reaches the
   * abandoned path. `saveTask` decides whether the recovery's guarded write
   * applies — which is the difference between a delivered failure and a
   * cancellation that got there first.
   */
  const refusingToConverse = (
    options: { saveTask: boolean },
    message = "the model refused every attempt"
  ) => {
    const { stub } = fakeAgent(options);
    return {
      ...stub,
      async converse() {
        throw new Error(message);
      }
    } as unknown as DurableObjectStub<ProactiveAgent>;
  };

  const deps = (stub: DurableObjectStub<ProactiveAgent>) => ({
    resolveAgent: () => stub,
    signingKey: env.A2A_SIGNING_KEY,
    abandonedCopy: ABANDONED_COPY
  });

  it("tells a reply, a silence and a failure apart", async () => {
    const shapes = [
      { generate: { kind: "reply", text: "here you go" }, outcome: "replied" },
      { generate: { kind: "no_reply" }, outcome: "no-reply" },
      { generate: { kind: "failed", text: "it broke" }, outcome: "failed" }
    ];

    for (const [i, shape] of shapes.entries()) {
      const { stub } = fakeAgent({ saveTask: true });
      const { step } = fakeStep({
        cached: { generate: shape.generate, notify: undefined }
      });

      const verdict = await runNotifyTask(
        params(`verdict-${i}`),
        step,
        deps(stub)
      );

      expect(verdict).toEqual({ outcome: shape.outcome });
    }
  });

  it("reports a task canceled before it started", async () => {
    const { stub } = fakeAgent({ markWorking: "canceled" });
    const { step } = fakeStep();

    await expect(
      runNotifyTask(params("verdict-cancel"), step, deps(stub))
    ).resolves.toEqual({ outcome: "canceled" });
  });

  /**
   * The guarded write refused, which is a `tasks/cancel` landing while the model
   * worked: nothing was persisted and nothing posted. Reporting what the turn
   * *would* have said would describe an outcome the user never received — the
   * same class of defect as a failed run recording itself as a clean `complete`.
   */
  it("reports the cancellation, not the reply nobody got", async () => {
    const { stub } = fakeAgent({
      probeState: TaskState.TASK_STATE_WORKING,
      saveTask: false
    });
    const { step } = fakeStep({
      cached: { generate: { kind: "reply", text: "here you go" } }
    });

    await expect(
      runNotifyTask(params("verdict-race"), step, deps(stub))
    ).resolves.toEqual({ outcome: "canceled" });
  });

  it("reports a turn abandoned after its retries ran out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { step } = fakeStep({ cached: { "abandoned:notify": undefined } });

    const verdict = await runNotifyTask(
      params("verdict-abandoned"),
      step,
      deps(refusingToConverse({ saveTask: true }))
    );

    expect(verdict).toMatchObject({ outcome: "abandoned" });
  });

  /**
   * The recovery path has the same cancellation check as the ordinary one, and
   * the same consequence when it fires: the guarded write refused, so no failed
   * Task was persisted and none was posted. Nothing was abandoned to anyone,
   * because the caller had already stopped listening.
   */
  it("reports a cancellation that won the abandoned write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { step } = fakeStep({ cached: { "abandoned:notify": undefined } });

    await expect(
      runNotifyTask(
        params("verdict-abandoned-race"),
        step,
        deps(refusingToConverse({ saveTask: false }))
      )
    ).resolves.toEqual({ outcome: "canceled" });
  });

  /**
   * `cause` is whatever was thrown and the instance `output` has a 1 MiB
   * ceiling, so an unbounded diagnostic would fail the run while serializing its
   * record of having recovered — the one path written to avoid a silent failure,
   * made into one.
   */
  it("caps a fault whose message is a whole response body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { step } = fakeStep({ cached: { "abandoned:notify": undefined } });

    const verdict = await runNotifyTask(
      params("verdict-huge"),
      step,
      deps(refusingToConverse({ saveTask: true }, "x".repeat(500_000)))
    );

    expect(verdict.outcome).toBe("abandoned");
    const { error } = verdict as { error: string };
    expect(error.length).toBeLessThan(3_000);
    expect(error).toMatch(/truncated/);
  });
});

/**
 * A `generate` step that exhausts its retries must still reach the user.
 *
 * `generate` is a durable step: it retries a bounded number of times and then
 * rethrows. Unguarded, the orchestration unwinds past the delivery and the Task
 * stays `working` with the user told nothing — a silence that has cost a
 * production task before.
 *
 * `runHandleTask` guards itself, which covers the round agents. This one writes
 * its own orchestration, so it calls `deliverAbandonedTask` directly — the
 * reason that helper is exported rather than private to `/round`.
 */
describe("a turn whose generate step never stops failing", () => {
  it("delivers a failed Task instead of leaving it working", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { stub, saved } = fakeAgent({ saveTask: true });
    const failing = {
      ...stub,
      async converse() {
        throw new Error("the model refused every attempt");
      }
    } as unknown as DurableObjectStub<ProactiveAgent>;
    const { step, ran } = fakeStep({
      cached: { "abandoned:notify": undefined }
    });

    await runNotifyTask(params("t5"), step, {
      resolveAgent: () => failing,
      signingKey: env.A2A_SIGNING_KEY,
      abandonedCopy: ABANDONED_COPY
    });

    expect(ran).toContain("abandoned:complete");
    expect(saved).toHaveLength(1);
    expect(saved[0].status?.state).toBe(TaskState.TASK_STATE_FAILED);
    // The words are this agent's, and the diagnostic is not among them.
    expect(JSON.stringify(saved[0])).toContain(ABANDONED_COPY);
    expect(JSON.stringify(saved[0])).not.toContain("refused every attempt");
  });

  /**
   * No `sweep` step, because this agent delegates to nothing — the same reason
   * its ordinary delivery omits one. A `sweep` here would be a durable step name
   * that exists only to do nothing and could never be removed.
   */
  it("runs no sweep, having no managed children", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { stub } = fakeAgent({ saveTask: true });
    const failing = {
      ...stub,
      async converse() {
        throw new Error("boom");
      }
    } as unknown as DurableObjectStub<ProactiveAgent>;
    const { step, ran } = fakeStep({
      cached: { "abandoned:notify": undefined }
    });

    await runNotifyTask(params("t6"), step, {
      resolveAgent: () => failing,
      signingKey: env.A2A_SIGNING_KEY,
      abandonedCopy: ABANDONED_COPY
    });

    expect(ran).not.toContain("abandoned:sweep");
    // And never the ordinary delivery's names: those are durable cache keys.
    expect(ran).not.toContain("complete");
  });
});
