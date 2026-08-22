import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import { TaskState } from "@a2a-js/sdk";
import type { GatewayIdentity, PlainTask } from "@loopingai/core/a2a";
import { roundPolicy } from "@/round-policy";
import { deliverAbandonedTask, type TerminalTaskAgent } from "@/abandoned-task";

/**
 * The path that turns an exhausted retry ladder into words the user sees.
 *
 * This is the one branch in a delegating agent's workflow that no other spec
 * reaches and that production reached first: on 2026-08-19 the `turn:0` step
 * burned its four attempts against a rate-limited Claude, `runHandleTask` threw,
 * and the Task sat in `working` forever while the runtime logged a hang. Nothing
 * failed loudly — which is exactly why it needs a spec rather than a comment.
 *
 * Driven against the shared helper rather than through a workflow class, because
 * workerd forbids constructing a `WorkflowEntrypoint` outside the runtime. Both
 * `CoderWorkflow` and `ClaudeCoderWorkflow` call exactly this function from their
 * `catch`; what they add is a label and which agent to resolve.
 */

const IDENTITY: GatewayIdentity = {
  key: "custom:test:coder",
  name: "test-caller",
  kind: "custom",
  workspaceId: 1
};

/** A `WorkflowStep` that records which steps the delivery reached. */
function fakeStep() {
  const ran: string[] = [];
  const step = {
    async do(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const body = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      ran.push(name);
      return await body();
    }
  } as unknown as WorkflowStep;
  return { step, ran };
}

interface FakeAgentOptions {
  /** Whether the guarded terminal write applies. `false` ⇒ a cancel won. */
  saveTask?: boolean;
}

/**
 * A recording agent stub. `TerminalTaskAgent` is the whole surface the delivery
 * needs, which is what lets this spec name no Durable Object at all.
 */
function fakeAgent(options: FakeAgentOptions = {}) {
  const calls: string[] = [];
  const saved: PlainTask[] = [];
  const stub: TerminalTaskAgent = {
    async saveTask(task: PlainTask) {
      calls.push("saveTask");
      saved.push(task);
      return options.saveTask ?? true;
    },
    async sweepTaskChildren() {
      calls.push("sweepTaskChildren");
    }
  };
  return { agent: () => stub, calls, saved };
}

function params(taskId: string) {
  return {
    taskId,
    text: "ship the thing",
    identity: IDENTITY,
    contextId: `ctx-${taskId}`,
    // Never reached: `notify` posts here, and the suite stubs fetch away.
    pushUrl: "https://gateway.invalid/push",
    pushToken: "push-token",
    jku: "https://agents.invalid/.well-known/jwks.json"
  };
}

describe("deliverAbandonedTask", () => {
  it("saves a failed Task carrying the policy's copy", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const fake = fakeAgent();
    const { step } = fakeStep();

    await deliverAbandonedTask({
      params: params("t1"),
      step,
      cause: new Error("AI_RetryError: Failed after 3 attempts"),
      signingKey: env.A2A_SIGNING_KEY,
      label: "coder",
      agent: fake.agent
    });

    expect(fake.calls).toContain("saveTask");
    const failed = fake.saved[0];
    expect(failed?.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    // The user is told something, and it is the policy's words rather than a
    // paraphrase invented at the failure site.
    expect(JSON.stringify(failed)).toContain(roundPolicy.copy.taskFailed);
  });

  it("logs the original cause, since nothing else records it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const fake = fakeAgent();
    const { step } = fakeStep();

    await deliverAbandonedTask({
      params: params("t2"),
      step,
      cause: new Error("AI_RetryError: 429 rate_limit_error"),
      signingKey: env.A2A_SIGNING_KEY,
      label: "coder",
      agent: fake.agent
    });

    expect(error).toHaveBeenCalledWith(
      "[coder] task abandoned after retries were exhausted",
      expect.objectContaining({
        taskId: "t2",
        error: expect.stringContaining("429 rate_limit_error")
      })
    );
  });

  /**
   * The label is the caller's, so an operator reading the log can tell which of
   * the two coders went quiet. This is the assertion that would have failed
   * while `claude-coder` had no recovery at all: its workflow reached
   * `runHandleTask` with nothing above it, so no line was ever logged.
   */
  it("labels the log with the agent that abandoned the task", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const fake = fakeAgent();
    const { step } = fakeStep();

    await deliverAbandonedTask({
      params: params("t5"),
      step,
      cause: new Error("session step exhausted its retries"),
      signingKey: env.A2A_SIGNING_KEY,
      label: "claude-coder",
      agent: fake.agent
    });

    expect(error).toHaveBeenCalledWith(
      "[claude-coder] task abandoned after retries were exhausted",
      expect.objectContaining({ taskId: "t5" })
    );
    expect(fake.calls).toContain("saveTask");
  });

  /**
   * The guarded write is the cancellation check. A user who cancelled while the
   * retries were still burning must not have their Task overwritten as failed —
   * and `deliverTerminalTask` keys the callback on whether the write applied.
   */
  it("does not notify when a cancel already won the write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      posted.push(String(input));
      return new Response("{}", { status: 200 });
    });
    const fake = fakeAgent({ saveTask: false });
    const { step, ran } = fakeStep();

    await deliverAbandonedTask({
      params: params("t3"),
      step,
      cause: new Error("x"),
      signingKey: env.A2A_SIGNING_KEY,
      label: "coder",
      agent: fake.agent
    });

    expect(fake.calls).toContain("saveTask");
    expect(ran).not.toContain("notify");
    expect(posted).toHaveLength(0);
  });

  /**
   * If the delivery itself cannot complete, the instance must still error — a
   * swallowed fault would mark the run successful while the user got nothing,
   * which is strictly worse than the erroring instance this replaced.
   */
  it("rethrows the original cause when delivery fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const cause = new Error("the original fault");
    const { step } = fakeStep();

    await expect(
      deliverAbandonedTask({
        params: params("t4"),
        step,
        cause,
        signingKey: env.A2A_SIGNING_KEY,
        label: "coder",
        agent: () => ({
          async saveTask(): Promise<boolean> {
            throw new Error("durable object unreachable");
          },
          async sweepTaskChildren(): Promise<void> {}
        })
      })
    ).rejects.toBe(cause);
  });
});
