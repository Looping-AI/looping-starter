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

describe("against the real Durable Object", () => {
  it("reports cancellation from both markWorking and the guarded save", async () => {
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
    // Five round trips into a cold Durable Object, the first of which runs
    // core's whole migration journal. Vitest's 5 s default is enough on an idle
    // machine and not enough when the pool is running every other spec file
    // alongside it — which showed up as a timeout here the day an unrelated
    // seventh spec was added. The test is not slow because anything is wrong;
    // it is slow because it is the only one that boots a real agent.
  }, 20_000);
});
