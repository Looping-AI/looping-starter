import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { resolveConfig } from "@loopingai/core";
import { runHandleTask, type HandleTaskParams } from "@loopingai/core/round";
import { ARC_PLAYER_CONFIG } from "@/config";
import { roundPolicy } from "@/round-policy";
import { arcPlayer } from "./definition";

/**
 * The arc-player's task workflow: core's orchestration, its own binding.
 *
 * See `../reactive/workflow.ts` — the two are the same five lines with different
 * deps, which is the whole cost of a second round agent. Two classes exist because
 * a wrangler workflow binding names exactly one class and each agent's instances
 * must be its own.
 */
export class ArcHandleTaskWorkflow extends WorkflowEntrypoint<
  Env,
  HandleTaskParams
> {
  async run(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<void> {
    await runHandleTask(event.payload, step, {
      resolveAgent: (identity) => arcPlayer.resolveAgent(this.env, identity),
      config: resolveConfig(ARC_PLAYER_CONFIG),
      policy: roundPolicy,
      signingKey: this.env.A2A_SIGNING_KEY
    });
  }
}
