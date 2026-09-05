import { defineAgent } from "@dynamicagents/core/worker";
import { manifest } from "./manifest";

/**
 * How this agent is reached: its tenant id, its card, its Durable Object, and the
 * Workflow its turns run on — declared once.
 *
 * `src/index.ts` mounts the tenant from this, and `./workflow.ts` resolves its DO
 * stub from this, so the two cannot address different Durable Objects. Naming a
 * sibling's workflow here used to type-check perfectly and fail at runtime, after
 * auth, after the turn was accepted, as a task that never called back.
 */
export const reactive = defineAgent({
  tenant: "reactive",
  manifest,
  agent: (env: Env) => env.ReactiveAgent,
  workflow: (env: Env) => env.HANDLE_TASK_WORKFLOW
});
