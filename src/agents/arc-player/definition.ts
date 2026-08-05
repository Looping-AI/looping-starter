import { defineAgent } from "@loopingai/core/worker";
import { manifest } from "./manifest";

/** See `../reactive/definition.ts` — the same declaration, this agent's bindings. */
export const arcPlayer = defineAgent({
  tenant: "arc-player",
  manifest,
  agent: (env: Env) => env.ArcPlayerAgent,
  workflow: (env: Env) => env.ARC_HANDLE_TASK_WORKFLOW
});
