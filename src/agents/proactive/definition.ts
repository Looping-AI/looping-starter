import { defineAgent } from "@dynamicagents/core/worker";
import { manifest } from "./manifest";

/** See `../reactive/definition.ts` — the same declaration, this agent's bindings. */
export const proactive = defineAgent({
  tenant: "proactive",
  manifest,
  agent: (env: Env) => env.ProactiveAgent,
  workflow: (env: Env) => env.NOTIFY_WORKFLOW
});
