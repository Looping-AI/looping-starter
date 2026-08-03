import type { CoreConfigOverrides } from "@loopingai/core";

/**
 * Every value this agent tunes, in one file.
 *
 * Core owns the *shapes* and a working baseline (`DEFAULT_CORE_CONFIG`); what is
 * here is only what this deployment wants different, merged and validated once
 * per Durable Object instance by `resolveConfig` inside `createAgentRuntime`.
 * That is the whole reason these are exported values rather than the bare
 * module-level constants the predecessor repos used: a constant read at import
 * time is not overridable, and it freezes before `env` exists — which on Workers
 * is always.
 *
 * Nothing here is a platform fact. Chunk sizing, step timeouts and the rest live
 * in core's `platform.ts` and are deliberately not tunable.
 */

/**
 * What every agent in this Worker shares: the model pair and the gateway they
 * are billed and correlated through.
 *
 * The fallback is deliberately a *different vendor and family* from the primary.
 * A same-family fallback shares the failure mode you are falling back from.
 */
const MODEL = {
  chatModelId: "@cf/zai-org/glm-5.2",
  fallbackChatModelId: "@cf/moonshotai/kimi-k2.7-code",
  /** AI Gateway slug; `"default"` auto-provisions on first request. */
  aiGatewayId: "default",
  maxOutputTokens: 16_384,
  reasoningEffort: "medium"
} as const;

/**
 * The reactive agent: delegates, so it pays for rounds of subagent work and is
 * bounded across all of them.
 *
 * `compactAfterTokens` is tight on purpose. A delegating agent accumulates
 * branch results fast, and the invariant core asserts —
 * `compactAfterTokens - compactTailTokens >= 10_000` — is what keeps compaction
 * from firing on a near-empty middle. Never lower the threshold without lowering
 * the tail with it.
 */
export const REACTIVE_CONFIG: CoreConfigOverrides = {
  model: MODEL,
  mainAgentLimits: { maxTurns: 20, maxWallMs: 60 * 60_000 },
  subagentLimits: { maxTurns: 20, maxWallMs: 30 * 60_000 },
  toolOutputWindow: 4,
  maxSubtasks: 8,
  session: {
    memoryMaxTokens: 1200,
    compactAfterTokens: 16_000,
    compactTailTokens: 5_000
  }
};

/**
 * The arc-player: reactive's loop, but every task is one long game.
 *
 * Higher wall clock and turn ceilings because a play legitimately runs for tens
 * of minutes, and `maxSubtasks` is low because the useful fan-out is one subtask
 * per game named, not eight.
 */
export const ARC_PLAYER_CONFIG: CoreConfigOverrides = {
  ...REACTIVE_CONFIG,
  mainAgentLimits: { maxTurns: 40, maxWallMs: 2 * 60 * 60_000 },
  subagentLimits: { maxTurns: 60, maxWallMs: 60 * 60_000 },
  maxSubtasks: 4
};

/**
 * The proactive agent: single-turn, no delegation, so most of the delegation
 * config above is inert for it and left at core's defaults.
 *
 * A cheaper, faster fallback than reactive's: this agent answers in one turn in
 * a live channel, where a slow reply is worse than a slightly weaker one.
 * `compactAfterTokens` is far higher because a channel conversation is long and
 * cheap per message, unlike a delegating agent's branch results.
 */
export const PROACTIVE_CONFIG: CoreConfigOverrides = {
  model: { ...MODEL, fallbackChatModelId: "@cf/google/gemma-4-26b-a4b-it" },
  session: {
    memoryMaxTokens: 1200,
    compactAfterTokens: 60_000,
    compactTailTokens: 5_000
  }
};

/**
 * The proactive loop's step ceiling.
 *
 * Starter-owned rather than a `CoreConfig` field, and that is the point: core
 * ships `AgentLimits` in turns and wall-clock because those are the only two
 * currencies both loops agreed on. How *this* loop bounds itself is its own
 * business — reactive meters a mutable `TurnBudget` across rounds instead, and
 * neither shape belongs to core.
 */
export const MAX_STEPS = 8;

/**
 * `@loopingai/plugins/recall` tuning.
 *
 * The embedding model's output dimension and metric must match the Vectorize
 * index (`--dimensions=1024 --metric=cosine`). Changing the model means
 * recreating the index.
 */
export const RECALL = {
  embeddingModelId: "@cf/baai/bge-m3",
  topK: 5,
  /**
   * Max chars of a message stored in its vector metadata, under Vectorize's
   * ~10 KiB/vector limit. Recall returns this snippet plus provenance, not the
   * full original message.
   */
  metadataTextMax: 2000
} as const;

/**
 * `@loopingai/plugins/triage` tuning — the proactive agent's pre-turn gate.
 *
 * A small, fast model on purpose: it runs in front of *every* message the agent
 * sees, most of which are not for it, and its verdict is a single boolean.
 */
export const TRIAGE = {
  modelId: "@cf/qwen/qwen3-30b-a3b-fp8",
  historyMessages: 12,
  messageMaxChars: 500
} as const;
