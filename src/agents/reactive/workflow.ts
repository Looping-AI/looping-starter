import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { resolveConfig } from "@loopingai/core";
import { REACTIVE_CONFIG } from "@/config";
import { runHandleTask, type HandleTaskParams } from "@/round-agent/workflow";
import { getAgent } from "./agent";

/**
 * The reactive agent's task workflow.
 *
 * A thin entrypoint over the shared `runHandleTask` rather than a copy of it. Two
 * classes exist (this and `ArcHandleTaskWorkflow`) because a wrangler workflow
 * binding names exactly one class and each agent's instances must be its own; the
 * round loop, wave scheduling and delivery underneath are identical and stay in
 * one file.
 */
export class HandleTaskWorkflow extends WorkflowEntrypoint<
  Env,
  HandleTaskParams
> {
  async run(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<void> {
    await runHandleTask(event.payload, step, {
      resolveAgent: getAgent,
      config: resolveConfig(REACTIVE_CONFIG)
    });
  }
}
