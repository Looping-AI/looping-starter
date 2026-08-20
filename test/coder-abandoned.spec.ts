import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import { TaskState } from "@a2a-js/sdk";
import type { GatewayIdentity, PlainTask } from "@loopingai/core/a2a";
import { roundPolicy } from "@/round-policy";
import { deliverAbandonedTask } from "@/agents/coder/workflow";

/**
 * The path that turns an exhausted retry ladder into words the user sees.
 *
 * This is the one branch in the coder's workflow that no other spec reaches and
 * that production reached first: on 2026-08-19 the `turn:0` step burned its four
 * attempts against a rate-limited Claude, `runHandleTask` threw, and the Task sat
 * in `working` forever while the runtime logged a hang. Nothing failed loudly —
 * which is exactly why it needs a spec rather than a comment.
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
 * An env whose agent namespace hands back a recording stub. `resolveAgent` does
 * `ns.get(ns.idFromName(key))`, so those two methods are the whole surface.
 */
function fakeEnv(options: FakeAgentOptions = {}) {
  const calls: string[] = [];
  const saved: PlainTask[] = [];
  const stub = {
    async saveTask(task: PlainTask) {
      calls.push("saveTask");
      saved.push(task);
      return options.saveTask ?? true;
    },
    async sweepTaskChildren() {
      calls.push("sweepTaskChildren");
    }
  };
  const patched = {
    ...env,
    CoderAgent: {
      idFromName: (name: string) => name,
      get: () => stub
    }
  } as unknown as Env;
  return { env: patched, calls, saved };
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
    const agent = fakeEnv();
    const { step } = fakeStep();

    await deliverAbandonedTask(
      agent.env,
      params("t1"),
      step,
      new Error("AI_RetryError: Failed after 3 attempts")
    );

    expect(agent.calls).toContain("saveTask");
    const failed = agent.saved[0];
    expect(failed?.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    // The user is told something, and it is the policy's words rather than a
    // paraphrase invented at the failure site.
    expect(JSON.stringify(failed)).toContain(roundPolicy.copy.taskFailed);
  });

  it("logs the original cause, since nothing else records it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const agent = fakeEnv();
    const { step } = fakeStep();

    await deliverAbandonedTask(
      agent.env,
      params("t2"),
      step,
      new Error("AI_RetryError: 429 rate_limit_error")
    );

    expect(error).toHaveBeenCalledWith(
      "[coder] task abandoned after retries were exhausted",
      expect.objectContaining({
        taskId: "t2",
        error: expect.stringContaining("429 rate_limit_error")
      })
    );
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
    const agent = fakeEnv({ saveTask: false });
    const { step, ran } = fakeStep();

    await deliverAbandonedTask(agent.env, params("t3"), step, new Error("x"));

    expect(agent.calls).toContain("saveTask");
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
    const { env: patched } = fakeEnv();
    const broken = {
      ...patched,
      CoderAgent: {
        idFromName: (name: string) => name,
        get: () => ({
          async saveTask() {
            throw new Error("durable object unreachable");
          }
        })
      }
    } as unknown as Env;
    const { step } = fakeStep();

    await expect(
      deliverAbandonedTask(broken, params("t4"), step, cause)
    ).rejects.toBe(cause);
  });
});
