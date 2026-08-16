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
 * **You must choose these. Core ships no default, on purpose.** Which model an
 * agent runs on sets the cost of every turn, the tool-calling reliability the
 * whole control-tool design rests on, and the failure modes the fallback exists
 * to escape. A framework default would be making that call on your behalf,
 * silently, and being wrong for most agents — and a model id frozen into a
 * published package outlives every deprecation until someone bumps the package.
 * Written here, it is read by whoever owns the bill.
 *
 * ## Why this pair
 *
 * **Primary — `@cf/zai-org/glm-5.2`.** This loop lives or dies on function
 * calling: a round ends only when the model calls a *control tool*, and a model
 * that answers in prose instead of calling `final_reply` burns the whole budget
 * reaching no ending. GLM is picked for reliable multi-tool-call behaviour over
 * long contexts, which is what a delegating round actually is — read branch
 * results, decide, call one of several endings.
 *
 * **Fallback — `@cf/moonshotai/kimi-k2.7-code`.** Deliberately a *different
 * vendor and family*. The fallback exists for when the primary throws, and the
 * things that make it throw — an outage, a rate limit, a deprecation, a bad
 * deploy of one vendor's serving stack — are correlated within a family. A
 * same-family fallback is a retry wearing a costume; core now refuses an
 * identical pair outright for this reason.
 *
 * ## Changing them
 *
 * Both must support function calling and tolerate a long system prompt. After
 * changing either, re-read `mainAgentLimits.maxTurns`: a model that needs more
 * steps to reach an ending spends the same budget faster.
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
 * The coder's models — Claude, not Workers AI.
 *
 * The only agent in this Worker that changes provider, and the reason is narrow:
 * writing code that compiles and passes its own tests is the task where model
 * quality shows up as a working pull request or a wasted container hour.
 * `src/agents/coder/models.ts` builds these through `@loopingai/core/anthropic`,
 * and the agent and its subagent facet both return it from `modelRuntime()`;
 * nothing else about the round loop changes.
 *
 * ## Why the primary is Sonnet and not Opus
 *
 * It was `claude-opus-5`, and on 2026-08-11 that was measured costing an hour per
 * task while never once serving a request.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token` — a Claude
 * *subscription* credential, and subscriptions cap Opus separately from and far
 * more tightly than Sonnet. With that cap spent, every Opus call returned
 * `429 Wholesale Rate limited` in about 10ms at zero tokens, while the Sonnet call
 * issued moments later on the same credential succeeded every time. Both the
 * orchestrator (`[turn] model attempt failed`, rounds 0, 1 and 2) and the
 * subagents (`[recipe-runner] primary attempt failed, trying fallback`) hit it.
 *
 * So the agent was already running entirely on its fallback. Naming Opus bought no
 * Opus — it bought three doomed retries in front of every single model call.
 *
 * **Restoring Opus here is a credential change, not a config change.** It needs a
 * metered Anthropic API key in place of the subscription token; put the id back
 * only once that is in place, or this comment will be rewritten a third time.
 *
 * ## Why the fallback is also Claude
 *
 * `ModelConfig` advises a different vendor and family for the fallback slot, and
 * that advice is right for every other agent here — a same-family fallback shares
 * the failure mode you are escaping. It does not apply to this one, for a
 * mechanical reason and a judgement one. Mechanically, both slots are built by
 * the same Anthropic runtime, so a Workers AI id in the fallback would not
 * resolve. And on judgement: a weaker model that quietly finishes a half-written
 * refactor produces a pull request that looks finished and is not, which is worse
 * than a failed task. Haiku is the step down, not a different bet.
 *
 * The two slots must stay *different*, though. Leaving both on Sonnet would make
 * the fallback a retry wearing a costume — the exact thing `ModelConfig` warns
 * against, and the thing the Opus 429s proved the cost of.
 *
 * `reasoningEffort` stays inside core's three-value union; the coder actually
 * runs at `xhigh`, which the agent passes to the Anthropic runtime directly.
 */
const CODER_MODEL = {
  chatModelId: "claude-sonnet-5",
  fallbackChatModelId: "claude-haiku-4-5-20251001",
  aiGatewayId: "default",
  // A custom provider, not the provider-native `anthropic` path. The gateway
  // forwards `Authorization` untouched to a custom provider and injects nothing,
  // which is what keeps the credential ours; the native path can supply its own
  // via BYOK / Unified Billing. The slug must match the one registered on the
  // account (`npm run cf -- provider:create`) minus its mandatory `custom-`
  // prefix, which belongs in the request URL.
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
 * **Same primary, different fallback — `@cf/google/gemma-4-26b-a4b-it`.** This
 * agent answers in one turn in a live channel, so its fallback is chosen for
 * latency rather than depth: when the primary is down, a fast adequate reply
 * beats a slow strong one that arrives after the conversation moved on. That is
 * the opposite trade from reactive, whose fallback still has to hold a
 * delegating round together, and it is exactly the kind of per-agent judgement
 * a framework default cannot make.
 *
 * Still a different vendor from the primary, for the same correlated-failure
 * reason as reactive's.
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
