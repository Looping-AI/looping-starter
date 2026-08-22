import type { WorkflowStep } from "cloudflare:workers";
import {
  buildFailedTask,
  deliverTerminalTask,
  type PlainTask
} from "@loopingai/core/a2a";
import type { HandleTaskParams } from "@loopingai/core/round";
import { roundPolicy } from "@/round-policy";

/**
 * Turn an unrecoverable orchestration fault into a delivered failed Task.
 *
 * ## The failure this exists for
 *
 * Core distinguishes two ways a round ends badly. A **typed** failure — the
 * models were tried and nothing usable came back — returns `status: "failed"`,
 * and core delivers it. A **transient** fault instead throws, so the step retries
 * and recovers from the durable rows without paying for a second inference. That
 * is the right default and nothing here changes it.
 *
 * What it does not cover is a transient fault that never stops being one.
 * `step.do` retries a bounded number of times and then rethrows, and with nothing
 * above it to catch that, `runHandleTask` unwinds, core's delivery path is never
 * reached, and the Workflow instance errors with the Task still sitting in
 * `working`. The user is told nothing at all — and because the instance dies
 * mid-`run`, the runtime records it as *"your Worker's code had hung and would
 * never generate a response"*, which reads like a bug in the workflow file rather
 * than a provider that was refusing every request.
 *
 * Observed exactly that way on 2026-08-19: `turn:0-1` exhausted its four attempts
 * against a rate-limited Claude, and the coder simply went quiet.
 *
 * ## Why it is here rather than in an agent's directory
 *
 * It was written in `agents/coder/workflow.ts` and every delegating agent owes
 * its users the same thing — so a second copy was the obvious next step and the
 * wrong one. This is `src/` because that is where this repository puts what two
 * agents genuinely share (`scripts/verify-isolation.mjs` says so in as many
 * words), and it names no agent: the caller passes a resolver and a label.
 *
 * It imports nothing from `@loopingai/plugins`, so it is free of the isolation
 * question entirely — any agent can carry it.
 *
 * A module-level function rather than a method, for the reason core's
 * `runHandleTask` is one: workerd forbids constructing a `WorkflowEntrypoint`
 * outside the runtime, so anything left inside a class body cannot be driven by a
 * spec — and this path exists precisely because the untested one was the one that
 * broke.
 */

/**
 * The two RPCs a terminal delivery needs, whichever agent is behind them.
 *
 * Structural on purpose: `CoderAgent` and `ClaudeCoderAgent` are different
 * Durable Object classes and this file must not know either name.
 */
export interface TerminalTaskAgent {
  saveTask(task: PlainTask): Promise<boolean>;
  sweepTaskChildren(taskId: string): Promise<void>;
}

export interface AbandonedTaskConfig {
  params: HandleTaskParams;
  step: WorkflowStep;
  /** The fault that exhausted the retries. Logged, and rethrown if delivery fails. */
  cause: unknown;
  /** The agent's card-signing key, for the callback JWT. */
  signingKey: string;
  /** Log prefix — the agent's tenant id. */
  label: string;
  /**
   * The agent this Task belongs to.
   *
   * A thunk, and it must be: `deliverTerminalTask` resolves it separately inside
   * each step body, because a Durable Object stub is a live connection and one
   * hoisted out of a step never reconnects after a replay.
   */
  agent: () => TerminalTaskAgent;
}

export async function deliverAbandonedTask(
  config: AbandonedTaskConfig
): Promise<void> {
  const { params, step, cause, label } = config;

  console.error(`[${label}] task abandoned after retries were exhausted`, {
    taskId: params.taskId,
    error: String(cause)
  });

  try {
    await deliverTerminalTask(step, {
      push: {
        taskId: params.taskId,
        contextId: params.contextId,
        pushUrl: params.pushUrl,
        pushToken: params.pushToken,
        jku: params.jku
      },
      signingKey: config.signingKey,
      // Resolved inside each closure, never hoisted — see `agent` above.
      saveTask: (task) => config.agent().saveTask(task),
      // The words are `roundPolicy.copy.taskFailed` rather than anything
      // sharper. The distinctions a `failureCopy` draws are about *which
      // credential* was refused, and reaching here means the round never got far
      // enough to say — the diagnostic is logged instead, which is where it
      // belongs.
      terminal: () =>
        buildFailedTask(
          params.taskId,
          params.contextId,
          roundPolicy.copy.taskFailed
        ),
      // The Task is terminal either way, so its managed children are garbage
      // either way. `deliverTerminalTask` already treats this as best-effort.
      sweep: async () => {
        await config.agent().sweepTaskChildren(params.taskId);
      }
    });
  } catch (deliveryFailed) {
    // Rethrow the *original* fault, not this one. Swallowing here would mark the
    // instance successful while the user got nothing — strictly worse than the
    // erroring instance we started with, because it would also be silent in the
    // Workflows console. `cause` is what an operator needs to see.
    console.error(`[${label}] could not deliver the failed Task`, {
      taskId: params.taskId,
      error: String(deliveryFailed)
    });
    throw cause;
  }
}
