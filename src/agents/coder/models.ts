import type { ModelRuntimeFactory } from "@loopingai/core/agent";
import { createAnthropicModelRuntime } from "@loopingai/core/anthropic";
import { mintProxyToken } from "./proxy-token";

/**
 * The coder's provider: Claude instead of Workers AI.
 *
 * `ModelRuntime` is the entire contract, so nothing else changes: the round
 * scheduler, the control-tool repair ladder and the Workflow all keep working
 * against a `LanguageModel` and never learn which provider produced it.
 *
 * ## Why this is a module and not two methods
 *
 * The parent agent and its subagent facet must run the **same** provider — a
 * facet left on core's Workers AI default would execute every delegated subtask
 * on a different model than the round that delegated it, silently, because both
 * satisfy `ModelRuntime` and nothing downstream can tell them apart.
 *
 * This was previously two hand-copied `createAnthropicModelRuntime({...})`
 * bodies in `agent.ts` and `subagent.ts`, kept in step by three doc comments
 * telling the next reader not to let them drift. Both seams take a
 * `ModelRuntimeFactory`, so there is one definition and two one-line references
 * instead.
 */
export const coderModels: ModelRuntimeFactory<Env> = (env, config) =>
  createAnthropicModelRuntime({
    // Through AI Gateway, so these calls land in the same logs as every
    // Workers AI call in this Worker, carrying the same {taskId, round}
    // correlation core already stamps.
    //
    // Through a **custom provider**, not the provider-native `/anthropic`
    // path. That path is provider-aware: the gateway understands Anthropic's
    // auth scheme and can supply the credential itself via BYOK or Unified
    // Billing, so a credential sent through it is not necessarily the one
    // that ends up doing the work. A custom provider forwards `Authorization`
    // untouched and injects nothing, which is what puts the credential
    // decision back under our control.
    //
    // The gateway is read from the `config` argument, which is the agent's
    // *resolved* config — never the raw `CODER_CONFIG`. That used to be worth
    // a warning, because a method body could reach for either and an override
    // would make the two disagree about which gateway this agent is on. A
    // factory that is handed its config cannot reach for the other one.
    baseUrl: () =>
      env.AI.gateway(config.aiGatewayId).getUrl(config.aiGatewayProvider),
    // Not the Claude credential — this Worker no longer holds one. It is a
    // short-lived token minted for `looping-anthropic-proxy`, which is what
    // attaches the real Anthropic credential on the far side of the gateway.
    // See ./proxy-token.ts for why a signed token rather than a shared secret.
    authToken: () => mintProxyToken(env),
    // The gateway's own credential, which is not the model's. `default` has
    // Authenticated Gateway enabled, and a request to its provider-native URL
    // without this is rejected at the door — a 401 Anthropic never sees and
    // the gateway never logs, which reads exactly like a dead Claude token.
    gatewayToken: () => env.AI_GATEWAY_TOKEN,
    config,
    // Anthropic's guidance for coding and agentic work, and above the three
    // values core's `reasoningEffort` union allows — which is why it is passed
    // here rather than through `ModelConfig`.
    effort: "xhigh",
    // The hour, not the default five minutes. This agent's rounds are
    // separated by container boots, installs and test suites; a 5-minute entry
    // has expired by the next round and the whole soul-plus-tools prefix is
    // re-billed at full price. Doubling the write cost to survive that gap is
    // the cheaper side of the trade at this call volume.
    cache: "1h"
  });
