import type { AgentPlugin } from "@loopingai/core";
import { browser } from "@loopingai/plugins/browser";
import { recall } from "@loopingai/plugins/recall";
import { triage } from "@loopingai/plugins/triage";
import { PROACTIVE_CONFIG, RECALL, TRIAGE } from "@/config";
import type { PluginHost } from "@/plugin-host";

/**
 * The one file you edit to add or remove a capability for the proactive agent.
 *
 * Its own file, not shared with the reactive agent's, and that separation is what
 * the CI isolation check measures: nothing imported here reaches for `/arc-agi`,
 * so nothing arc-shaped can appear in this agent's module graph. A single shared
 * plugin list would put every plugin in every agent and make the guarantee
 * unmeasurable.
 *
 * Note what it does **not** install: `/workspace`. This agent never delegates, so
 * no subagent execution ever needs a durable file store — and `@cloudflare/shell`
 * is a real dependency to carry for nothing.
 */
export const plugins = (host: PluginHost): AgentPlugin[] => [
  // The pre-turn gate: is this message even for me?
  //
  // An agent that sees every message in its channels is mostly seeing messages
  // that are not for it. Left to the main loop, that judgement is made by a model
  // simultaneously trying to be helpful — and it degrades *invisibly*, because
  // failing to call a decline-tool looks identical to deciding not to. This moves
  // the decision somewhere it cannot be skipped, and it fails open: a gate that
  // throws counts as `true`, because a wrong reply is noise the user can see and
  // ignore while a wrong silence is invisible to whoever needed an answer.
  triage({
    ai: host.env.AI,
    aiGatewayId: PROACTIVE_CONFIG.model?.aiGatewayId,
    modelId: TRIAGE.modelId,
    historyMessages: TRIAGE.historyMessages,
    messageMaxChars: TRIAGE.messageMaxChars
  }),

  // Read web pages. Requires the `BROWSER` binding and a paid Workers plan.
  browser({ binding: host.env.BROWSER }),

  // Episodic memory over the messages compaction folds away.
  recall({
    ai: host.env.AI,
    index: host.env.VECTORIZE,
    namespace: host.callerKey,
    aiGatewayId: PROACTIVE_CONFIG.model?.aiGatewayId,
    embeddingModelId: RECALL.embeddingModelId,
    topK: RECALL.topK,
    metadataTextMax: RECALL.metadataTextMax
  })
];
