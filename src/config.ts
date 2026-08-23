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
 * The coder's models — a distinct pair from the shared `MODEL` above.
 *
 * Same provider as every other agent here (Workers AI through AI Gateway) and
 * the same primary, so what this block actually expresses is one difference:
 * **a much larger output ceiling**. A coding round writes a file and a test in
 * the same turn, and a truncated patch reads as a finished one, so 32k rather
 * than reactive's 16k. Everything else is deliberately the house default.
 *
 * Both slots must support function calling and tolerate a long system prompt.
 * That is not a formality here — the round loop runs with `toolChoice:
 * "required"` and a round *ends* only when the model calls a control tool, so a
 * model that answers in prose instead burns the entire turn budget reaching no
 * ending. The pair is picked on that behaviour before anything else.
 *
 * The fallback is a different vendor and family, per `ModelConfig`'s advice:
 * what makes a primary throw — an outage, a rate limit, a bad deploy of one
 * vendor's serving stack — is correlated within a family, so a same-family
 * fallback is a retry wearing a costume. `resolveConfig` refuses an identical
 * pair outright.
 *
 * ## Why this is no longer Claude
 *
 * It was `claude-opus-5` / `claude-sonnet-5` until 2026-08-20, reached through
 * an AI Gateway custom provider whose origin was a separate Worker holding two
 * Anthropic *subscription* credentials. That path is gone, and it is worth
 * writing down why so nobody rebuilds it.
 *
 * A subscription credential does not work for raw Messages API calls on any
 * frontier model. Every Opus call returned `429` in ~10 ms at zero tokens, and
 * Sonnet followed. Haiku 4.5 was the sole exception, and Haiku 4.5 rejects the
 * `output_config.effort` field this agent was built around — so the one model
 * that answered was the one model that could not be used. Holding two
 * credentials on separate accounts did not clear it either: both refused the
 * same request. The remedy is not a better proxy; it is either a real API
 * credential or the sanctioned `claude-code` client, and neither is this file's
 * business.
 *
 * `reasoningEffort` is now plain `"high"`, inside core's three-value union. The
 * `xhigh` this used to run at existed only as an argument to the Anthropic
 * runtime and has nothing to reach through any more.
 */
const CODER_MODEL = {
  chatModelId: "@cf/zai-org/glm-5.2",
  fallbackChatModelId: "@cf/moonshotai/kimi-k2.7-code",
  /** AI Gateway slug; `"default"` auto-provisions on first request. */
  aiGatewayId: "default",
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
 * The claude-coder agent: the coder's shape, with the *work* done elsewhere.
 *
 * The parent round loop is Workers AI like every other agent here — it
 * orchestrates, reviews and talks to the user, and none of that needs a frontier
 * model. What is different is that its subtasks do not run core's tool loop at
 * all: each one is a Claude Code session inside the workspace container, driven
 * by `@loopingai/plugins/claude-code`. See {@link CLAUDE_CODE_SESSION} for the
 * numbers that bound *that*, which are not these.
 *
 * `maxSubtasks: 1`, and it is the one value here worth arguing about.
 *
 * Every other delegating agent in this repo fans out. This one must not, and the
 * reason is the shared checkout: two Claude Code sessions in one container are
 * two autonomous agents editing one working tree, each running the project's
 * test suite over the other's half-finished edits. The coder already warns its
 * model about this for `code` subtasks — "subagents share one checkout, so two
 * of them editing the same files conflict rather than parallelise" — and there
 * the subagents are short and closely briefed. Here they are long and
 * unsupervised, so the guidance becomes a limit.
 *
 * Raise it only alongside a story for how two sessions avoid each other.
 */
export const CLAUDE_CODER_CONFIG: CoreConfigOverrides = {
  ...CODER_CONFIG,
  maxSubtasks: 1
};

/**
 * What bounds one Claude Code session — and **this is the whole list**.
 *
 * Worth being explicit, because the obvious place to look is wrong. Core's
 * `subagentLimits.maxWallMs` and the recipe's own `limits` do **not** apply:
 * they are metered by the resumable runner, and this agent's `executeChunk`
 * bypasses it entirely to drive the CLI instead. A limit written there is inert.
 *
 * Nor is there a spend cap. One was built and deleted (plugins 0.6.0): an
 * estimate in dollars is a guess about a subscription bucket nobody can read,
 * and the gateway now reads the bucket directly — it rotates to the next
 * credential when Anthropic says the current one is spent. That handles the
 * 5-hour and weekly limits; it is not a per-session bound and is not meant as
 * one.
 *
 * So `timeoutMs` is the ceiling, and it is enforced by the container runtime.
 */
export const CLAUDE_CODE_SESSION = {
  /**
   * Opus 5, deliberately, because it is the reason this agent exists.
   *
   * A subscription credential 429s at zero tokens against the raw Messages API
   * on every frontier model; the same credential answers through the sanctioned
   * client. Reaching Opus is the whole payoff, so spending the bucket on
   * something cheaper would be paying the setup cost and declining the return.
   *
   * The cost is real and worth stating: a 5-hour bucket is roughly $10 of
   * Opus-equivalent and a substantial coding subtask is plausibly $1-5, so
   * expect two to four of them per bucket per credential. `claude-sonnet-5`
   * stretches that several times further if a deployment would rather have
   * volume.
   */
  model: "claude-opus-5",

  /**
   * Forty minutes, and **this is the ceiling on a session** — see above.
   *
   * Longer than the workspace base's twenty-minute default container-idle
   * window, so `ClaudeCoderWorkspaceDO` raises its own above this value —
   * derived from this constant, so the two cannot drift.
   *
   * That is a correction. The argument here used to be that the length was safe
   * because the idle clock is re-armed whenever anything enters the workspace
   * object, and every chunk boundary does, at most `windowMs` apart. The first
   * half is true and the conclusion does not follow: it makes the container's
   * survival depend on chunk boundaries arriving on time, and a retried or
   * delayed chunk is all it takes to exceed the remaining twelve minutes. The
   * cost of being wrong is the container stopped under a live session, losing
   * the work and the 18.7-27k-token prefix that bought it. A window wider than
   * the whole session does not need the argument at all.
   */
  timeoutMs: 40 * 60_000,

  /**
   * How long one chunk blocks before checkpointing and yielding.
   *
   * Inside `CHUNK_SOFT_MS` (15 min) and well inside `STEP_TIMEOUT_MS` (30 min).
   * Forty minutes of session is about five chunks against
   * `MAX_CHUNKS_PER_BRANCH` (40), so the structural backstop is nowhere near
   * binding — which is the point: a chunk that returned the moment it had
   * nothing to read would burn all forty in seconds.
   */
  windowMs: 8 * 60_000,

  /**
   * Advisory, all three. Claude Code's own subagent tree is invisible to
   * Looping's scheduler and multiplies whatever they say; `timeoutMs` is what
   * actually stops a run.
   */
  maxTurns: 60,
  maxSubagentDepth: 1,
  maxConcurrentSubagents: 4
} as const;

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
