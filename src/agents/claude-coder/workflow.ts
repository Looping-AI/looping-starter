import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { resolveConfig } from "@loopingai/core";
import { runHandleTask, type HandleTaskParams } from "@loopingai/core/round";
import { CLAUDE_CODER_CONFIG } from "@/config";
import { roundPolicy } from "@/round-policy";
import { claudeCoder } from "./definition";

/** The claude-coder agent's task workflow: core's orchestration, its own binding. */
export class ClaudeCoderWorkflow extends WorkflowEntrypoint<
  Env,
  HandleTaskParams
> {
  async run(
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
