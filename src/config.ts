import type { CoreConfigOverrides } from "@loopingai/core";
// Type-only, so nothing reaches a bundle: these two names are what make a
// mistyped or renamed tuning field fail at `tsc` instead of being spread into a
// plugin config and silently ignored.
import type { RecallTuning } from "@loopingai/plugins/recall";
import type { TriageTuning } from "@loopingai/plugins/triage";

/**
 * Every value this agent tunes, in one file.
 *
 * Core owns the shapes and a working baseline (`DEFAULT_CORE_CONFIG`); this is
 * only what the deployment wants different, merged and validated once per
 * Durable Object by `resolveConfig`. Exported values rather than module-level
 * constants because a constant read at import time is not overridable and
 * freezes before `env` exists — which on Workers is always.
 *
 * Nothing here is a platform fact: chunk sizing, step timeouts and the rest live
 * in core's `platform.ts` and are deliberately not tunable.
 */

/**
 * What every agent in this Worker shares: the model pair and the gateway they
 * are billed and correlated through.
 *
 * **You must choose these — core ships no default.** The model sets the cost of
 * every turn and the tool-calling reliability the whole control-tool design
 * rests on, and a model id frozen into a published package outlives every
 * deprecation until someone bumps it.
 *
 * The primary is picked for reliable multi-tool-call behaviour over long
 * contexts, which is what a delegating round is: a round ends only when the
 * model calls a control tool, and one that answers in prose instead burns the
 * whole budget reaching no ending.
 *
 * The fallback is a **different vendor and family**, deliberately. What makes a
 * primary throw — an outage, a rate limit, a deprecation, a bad deploy of one
 * vendor's serving stack — is correlated within a family, so a same-family
 * fallback is a retry wearing a costume. Core refuses an identical pair outright.
 *
 * Both must support function calling and tolerate a long system prompt. After
 * changing either, re-read `mainAgentLimits.maxTurns`: a model needing more steps
 * to reach an ending spends the same budget faster.
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
 * `compactAfterTokens` is tight on purpose — a delegating agent accumulates
 * branch results fast. Core asserts `compactAfterTokens - compactTailTokens >=
 * 10_000`, which keeps compaction from firing on a near-empty middle, so never
 * lower the threshold without lowering the tail with it.
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
 * The coder's models — Claude, not Workers AI.
 *
 * The only agent here that changes provider, because writing code that compiles
 * and passes its own tests is where model quality shows up as a working pull
 * request or a wasted container hour. Built through `@loopingai/core/anthropic`
 * in `src/agents/coder/models.ts`; nothing about the round loop changes.
 *
 * **Both slots must accept `output_config.effort`, and that is the constraint
 * that picks them.** `models.ts` sets `effort: "xhigh"` on the *runtime*, and
 * core's `createModelPair` stamps it onto the primary and the fallback
 * identically — there is no per-slot effort. So a slot filled with a model that
 * rejects the field is not a degraded fallback, it is a dead one.
 *
 * That is not hypothetical. This pair was `claude-sonnet-5` /
 * `claude-haiku-4-5-20251001` until 2026-08-19, and Haiku 4.5 answers every
 * request carrying `output_config.effort` with
 * `400 "This model does not support the effort parameter."`. The fallback slot
 * is only ever reached once the primary has already failed, so the fault stayed
 * invisible until the night Sonnet started rate-limiting — at which point the
 * ladder that existed to absorb it turned out to have never served a single
 * call. Opus 5 and Sonnet 5 both take all five effort levels.
 *
 * **Opus primary, Sonnet fallback.** Opus was demoted on 2026-08-11 because a
 * *subscription* credential caps Opus far more tightly than Sonnet, and with the
 * cap spent every Opus call returned `429` in ~10ms at zero tokens. That reading
 * was correct about the mechanism and wrong about the remedy: the proxy now
 * holds two credentials on **separate accounts**, and it retries the whole
 * request on the second whenever the first answers `401`, `403` or `429`. A cap
 * on one account is no longer a cap on the agent.
 *
 * **The fallback is also Claude**, against `ModelConfig`'s different-vendor
 * advice, for one mechanical reason and one judgement. Both slots are built by
 * the same Anthropic runtime, so a Workers AI id would not resolve; and a weaker
 * model that quietly finishes a half-written refactor produces a pull request
 * that looks finished and is not, which is worse than a failed task.
 *
 * Be honest about what this pair does and does not buy: two Claude models share
 * a vendor, so an Anthropic-wide outage takes both. What it does cover is the
 * failure that actually happens here — a ceiling or a capacity wobble on one
 * *model*, which Sonnet absorbs at a fraction of the cost. Credential-shaped
 * failures are covered a layer down, by the proxy's two accounts.
 *
 * `reasoningEffort` stays inside core's three-value union; the coder actually
 * runs at `xhigh`, passed to the Anthropic runtime directly.
 */
const CODER_MODEL = {
  chatModelId: "claude-opus-5",
  fallbackChatModelId: "claude-sonnet-5",
  aiGatewayId: "default",
  // A custom provider, not the native `anthropic` path: the gateway forwards
  // `Authorization` untouched to a custom one and injects nothing, where the
  // native path can supply its own via BYOK / Unified Billing. The slug must
  // match the one registered on the account (`npm run cf -- provider:create`)
  // minus its mandatory `custom-` prefix, which belongs in the request URL.
  aiGatewayProvider: "custom-looping-anthropic",
  // Generous: a round that writes a file and a test spends output tokens on both,
  // and a truncated patch reads as a finished one.
  maxOutputTokens: 32_000,
  reasoningEffort: "high"
} as const;

/**
 * The coder: long rounds, few subtasks, and a real container underneath.
 *
 * Every budget here is larger than reactive's except `maxSubtasks`, and that
 * asymmetry is the point. A coding round is slow — a container boot, an install,
 * a test suite — so turns and wall clock have to be generous or the agent is
 * killed mid-build. But coding subtasks are *heavy*, not numerous: eight parallel
 * subagents editing one checkout is a merge conflict, not fan-out.
 *
 * `toolOutputWindow` is wider than reactive's because a build log the model can
 * no longer see is a build log it will run again.
 */
export const CODER_CONFIG: CoreConfigOverrides = {
  model: CODER_MODEL,
  mainAgentLimits: { maxTurns: 60, maxWallMs: 3 * 60 * 60_000 },
  subagentLimits: { maxTurns: 80, maxWallMs: 90 * 60_000 },
  toolOutputWindow: 6,
  maxSubtasks: 4,
  session: {
    memoryMaxTokens: 2_000,
    compactAfterTokens: 60_000,
    compactTailTokens: 12_000
  }
};

/**
 * The proactive agent: single-turn, no delegation, so most of the delegation
 * config above is inert for it and left at core's baseline.
 *
 * Its fallback is chosen for **latency rather than depth** — this agent answers
 * in one turn in a live channel, where a fast adequate reply beats a strong one
 * arriving after the conversation moved on. The opposite trade from reactive,
 * whose fallback still has to hold a delegating round together.
 *
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
 * The proactive loop's step ceiling — starter-owned, not a `CoreConfig` field.
 * Core ships `AgentLimits` in turns and wall-clock because those are the only
 * currencies both loops agreed on; reactive meters a mutable `TurnBudget` across
 * rounds instead, and neither shape belongs to core.
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
} as const satisfies RecallTuning;

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
} as const satisfies TriageTuning;
