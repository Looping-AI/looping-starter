import type { ModelRuntimeFactory } from "@loopingai/core/agent";
import { createAnthropicModelRuntime } from "@loopingai/core/anthropic";
import { mintProxyToken } from "./proxy-token";

/**
 * The coder's provider: Claude instead of Workers AI.
 *
 * One factory rather than a body in each of `agent.ts` and `subagent.ts`,
 * because the parent and its subagent facet **must** run the same provider: a
 * facet left on core's Workers AI default would run every delegated subtask on a
 * different model than the round that delegated it, silently, since both satisfy
 * `ModelRuntime`.
 *
 * Curried on `selfOrigin` so what it returns is still a `ModelRuntimeFactory` —
 * the type both seams take, which is what stops the parent and the facet drifting
 * onto different providers. The thunk is deliberately lazy: core learns this
 * deployment's origin from the turn that arrives, and a runtime may well be built
 * before one has.
 */
export const coderModels =
  (selfOrigin: () => string): ModelRuntimeFactory<Env> =>
  (env, config) =>
    createAnthropicModelRuntime({
      // A **custom** AI Gateway provider, not the provider-native `/anthropic`
      // path. That path is provider-aware and can supply its own credential via
      // BYOK or Unified Billing, so a credential sent through it is not
      // necessarily the one that does the work. A custom provider forwards
      // `Authorization` untouched and injects nothing.
      //
      // Gateway read from `config` — the agent's *resolved* config, so an override
      // cannot make two call sites disagree about which gateway this agent is on.
      baseUrl: () =>
        env.AI.gateway(config.aiGatewayId).getUrl(config.aiGatewayProvider),
      // Not a Claude credential — this Worker holds none. A short-lived token for
      // `looping-anthropic-proxy`, which attaches the real one on the far side.
      authToken: () => mintProxyToken(env, selfOrigin()),
      // The gateway's own credential, which is not the model's. `default` has
      // Authenticated Gateway on, and without this the request is rejected at the
      // door — a 401 Anthropic never sees and the gateway never logs, which reads
      // exactly like a dead Claude token.
      gatewayToken: () => env.AI_GATEWAY_TOKEN,
      config,
      // Above the three values core's `reasoningEffort` union allows, which is why
      // it is passed here rather than through `ModelConfig`.
      effort: "xhigh",
      // The hour, not the default five minutes: this agent's rounds are separated
      // by container boots, installs and test suites, so a 5-minute entry has
      // expired by the next round and the whole soul-plus-tools prefix is re-billed
      // at full price.
      cache: "1h"
    });
