import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { resolveConfig } from "@loopingai/core";
import { runHandleTask, type HandleTaskParams } from "@loopingai/core/round";
import { deliverAbandonedTask } from "@/abandoned-task";
import { CLAUDE_CODER_CONFIG } from "@/config";
import { roundPolicy } from "@/round-policy";
import { claudeCoder } from "./definition";

/** The claude-coder agent's task workflow: core's orchestration, its own binding. */
export class ClaudeCoderWorkflow extends WorkflowEntrypoint<
  Env,
  HandleTaskParams
> {
  /**
   * The catch is the whole reason `run` is not just the `runHandleTask` call:
   * without it, a transient fault that never stops being one leaves the Task in
   * `working` and the user told nothing. The reasoning, and the production
   * incident behind it, is on `deliverAbandonedTask` in `@/abandoned-task`.
   *
   * This agent needs it at least as much as the coder does. Its rounds are long
   * and its subtasks are longer — one `claude -p` session can hold a chunk step
   * open for the better part of eight minutes — so a step that keeps failing
   * burns its retries over a much longer wall-clock window, and the silence at
   * the end of it is correspondingly more expensive to diagnose.
   */
  async run(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<void> {
    try {
      await this.handle(event, step);
    } catch (err) {
      await deliverAbandonedTask({
        params: event.payload,
        step,
        cause: err,
        signingKey: this.env.A2A_SIGNING_KEY,
        label: "claude-coder",
        agent: () => claudeCoder.resolveAgent(this.env, event.payload.identity)
      });
    }
  }

  /** The orchestration proper — every ordinary outcome ends inside here. */
  private async handle(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<void> {
    await runHandleTask(event.payload, step, {
      resolveAgent: (identity) => claudeCoder.resolveAgent(this.env, identity),
      config: resolveConfig(CLAUDE_CODER_CONFIG),
      policy: roundPolicy,
      signingKey: this.env.A2A_SIGNING_KEY
    });
  }
}
