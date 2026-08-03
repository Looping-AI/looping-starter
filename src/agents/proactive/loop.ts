import type {
  LanguageModel,
  PrepareStepFunction,
  StopCondition,
  ToolSet
} from "ai";
import { generateText, isStepCount } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import {
  buildIntermediateContentHandler,
  isTransientAiError,
  sessionMessage,
  toModelMessages,
  type ModelPair,
  type OnContent,
  type SessionLike
} from "@loopingai/core/agent";
import {
  isNoReplyTurn,
  NO_REPLY_GUIDANCE,
  NO_REPLY_TOOL_NAME
} from "@loopingai/plugins/triage";

/**
 * The proactive agent's turn: **one** inference over the caller's continuous
 * Session that either answers or deliberately says nothing.
 *
 * This file exists to be different from `../reactive/turn.ts`, and the difference
 * is the argument for the whole package split. Both run on the same core — the
 * same Session, the same model pair with its fallback, the same transient-error
 * classification, the same intermediate-content streaming. Nothing about how they
 * *end* is shared:
 *
 * | | reactive | proactive |
 * |---|---|---|
 * | bound by | a mutable `TurnBudget` metered across rounds | a flat `MAX_STEPS` |
 * | ends when | the model calls a control tool (`toolChoice: "required"`) | the model stops, or calls `no_reply` |
 * | can decline | no — every round must produce an answer or delegate | yes, that is the point |
 * | rounds | many, driven by a Workflow | exactly one |
 *
 * Core ships neither shape. If it had been built from the reactive agent alone it
 * would have shipped `RoundMode`, a control-tool abstraction and a round contract,
 * and this file would be fighting all three.
 *
 * ## Where triage went
 *
 * The predecessor called `shouldReply(...)` right here, inline, after appending
 * the user message. It is now `@loopingai/plugins/triage` declaring
 * `shouldHandleTurn`, and the **DO** consults every installed gate through
 * `runtime.shouldHandleTurn({ history })` before this function is ever called. So
 * the fast path — the channel noise the agent is not part of — never reaches the
 * loop at all, and this file no longer knows that triage exists.
 *
 * What stayed is the *late* decline below: the agent looks something up, concludes
 * there is nothing worth adding, and calls `no_reply`. The two cover different
 * moments — the gate judges the message, the tool judges what looking into it
 * turned up — which is why both survive.
 */

export const TRANSIENT_REPLY =
  "The AI service is temporarily unavailable. Please try again in a moment.";

/**
 * How a turn ended:
 * - `reply`    — there is an answer to deliver. Includes the *transient* failure
 *                path ({@link TRANSIENT_REPLY}): the model was briefly
 *                unavailable, nothing is broken, and the turn genuinely ended by
 *                telling the user to try again.
 * - `no_reply` — the agent deliberately declined to answer.
 * - `failed`   — an unexpected, non-transient failure aborted the turn. The
 *                distinction from `reply` is load-bearing: it is what makes the
 *                workflow POST a `failed` Task, and A2A v1.0 carries no
 *                structured task error, so the terminal state is the only way to
 *                tell the gateway this turn broke.
 */
export type TurnOutcome =
  | { kind: "reply"; text: string }
  | { kind: "no_reply" }
  | { kind: "failed"; text: string };

/** Everything a single agent turn needs, assembled by the DO before the loop runs. */
export interface RunTurnArgs {
  /** The Durable Object's one continuous Session (history + soul + memory). */
  session: SessionLike;
  /**
   * History **including** the inbound turn, which the DO has already appended.
   *
   * The append is the caller's, not this loop's, and that moved deliberately.
   * Triage is now a plugin gate the DO consults, and the message has to be in
   * history before the gate runs — the agent follows the channel whether or not
   * it speaks, and the next message's gate needs this one for context. Appending
   * here as well would either duplicate the turn or force this loop to know
   * whether the DO had already done it.
   */
  history: SessionMessage[];
  /** Per-request system-prompt suffix (verified caller context). Advisory. */
  systemSuffix: string;
  /** Agent-specific tools, merged over the session's own `set_context` tool. */
  tools: ToolSet;
  /** Primary + fallback model pair. */
  models: ModelPair;
  /** Tool-loop step ceiling. See `MAX_STEPS` in `src/config.ts`. */
  maxSteps: number;
  /** Friendly reply for an unexpected (non-transient) failure. */
  unexpectedReply: string;
  /** Streams intermediate content while the model works. Best-effort. */
  onContent?: OnContent;
}

/**
 * Run a single agent turn against the DO's continuous Session: a Workers-AI
 * `generateText` tool loop over the history (primary → fallback model on any
 * error), persisting the assistant reply and returning its text. The inbound text
 * keeps its `<turn>` provenance wrapper verbatim for the model and for recall to
 * read.
 *
 * **Never throws**: a transient (capacity/timeout) failure resolves to a friendly
 * "try again" message, an unexpected failure to `unexpectedReply`, so the DO's
 * caller always gets an outcome to publish.
 */
export async function runTurn(args: RunTurnArgs): Promise<TurnOutcome> {
  const {
    session,
    history,
    systemSuffix,
    tools: extraTools,
    models,
    maxSteps,
    onContent
  } = args;
  let modelId = models.primaryId();

  try {
    const instructions = (await session.refreshSystemPrompt()) + systemSuffix;
    const tools = { ...(await session.tools()), ...extraTools };
    const withoutNoReply = Object.keys(tools).filter(
      (name) => name !== NO_REPLY_TOOL_NAME
    );

    // Whether the agent has streamed any user-facing content this turn. Flipped
    // by the tracked `onContent` below and read live by `prepareStep`/`stopWhen`.
    // It is the single signal behind `no_reply`: available until we speak, then
    // withdrawn. Turn-level (not per attempt), so a primary→fallback re-run after
    // the primary streamed inherits it and the fallback cannot go silent.
    let repliedAny = false;
    const tracked: OnContent | undefined = onContent
      ? async (content, i) => {
          repliedAny = true;
          await onContent(content, i);
        }
      : undefined;

    // Stop as soon as the agent declines — otherwise the SDK would feed the
    // (meaningless) `no_reply` result back and spend another step. The two
    // conditions are OR'd: `isStepCount` caps the loop, `isNoReplyTurn` ends it on
    // a `no_reply` call we haven't disqualified. Not `hasToolCall("no_reply")`,
    // which would also stop on a `no_reply` call we mean to ignore (after the
    // agent has already spoken).
    const stopWhen: Array<StopCondition<ToolSet>> = [
      isStepCount(maxSteps),
      ({ steps }) => isNoReplyTurn(repliedAny, steps)
    ];

    // Offer `no_reply` (and the guidance explaining it) on every step until the
    // agent has spoken; withdraw both once it has. This lets the agent decline
    // late while never going silent after streaming content.
    //
    // Both branches state `instructions` outright. Since AI SDK 7 a `prepareStep`
    // instruction override *carries forward* to later steps until another
    // override replaces it — omitting the field no longer falls back to the
    // top-level value, so the withdrawing branch has to name the un-suffixed
    // prompt explicitly or the guidance would linger after the tool is gone.
    const prepareStep: PrepareStepFunction<ToolSet> = () =>
      repliedAny
        ? { activeTools: withoutNoReply, instructions }
        : { instructions: instructions + NO_REPLY_GUIDANCE };

    // One attempt against one model. Built per call rather than shared so each
    // attempt gets a fresh content handler: the 0-based stepIndex counter resets,
    // a primary→fallback re-run reuses the same index per position, and the
    // gateway dedupes by id.
    //
    // `no_reply` is passed as a suppressed tool: a step that calls it ends the
    // turn with no reply, so text the model wrote alongside it must not leak out
    // as a `working` push — which would also mark us as having spoken. This is
    // the only place it can be caught, since the SDK fires the step callback
    // *before* it evaluates `stopWhen`.
    const attempt = (model: LanguageModel) =>
      generateText({
        model,
        instructions,
        messages: toModelMessages(history),
        tools,
        stopWhen,
        prepareStep,
        // We do our own primary → fallback recovery below, so disable the SDK's
        // per-model exponential-backoff retries — they'd only add latency on a
        // hard failure and duplicate our fallback.
        maxRetries: 0,
        onStepEnd: tracked
          ? buildIntermediateContentHandler(tracked, [NO_REPLY_TOOL_NAME])
          : undefined
      });

    let result: Awaited<ReturnType<typeof attempt>>;
    try {
      result = await attempt(models.primary());
    } catch (primaryErr) {
      // The fallback re-runs the whole turn, but `repliedAny` is turn-level and
      // survives the re-run: if the primary already streamed a `working` push,
      // the fallback inherits `repliedAny === true` and cannot go silent, so it
      // must deliver a final reply. If nothing had streamed yet, the fallback is
      // free to decline just as the primary was.
      console.warn(
        "[agent-loop] AI error on primary model, retrying with fallback",
        { model: modelId, error: String(primaryErr) }
      );
      modelId = models.fallbackId();
      result = await attempt(models.fallback());
    }

    // Before the empty-text check below, which a no-reply turn would otherwise
    // trip: its step is `finishReason:"tool-calls"` with (usually) no text, and
    // would be reported to the caller as a model failure. Reading the outcome
    // off `result.steps` rather than trusting `stopWhen` also covers the case of
    // an invalid `no_reply` call, which exits the loop without consulting it.
    // Any text the model wrote alongside the call is discarded here, unread.
    if (isNoReplyTurn(repliedAny, result.steps)) {
      console.debug("[agent-loop] no_reply — declining to answer", {
        model: modelId
      });
      return { kind: "no_reply" };
    }

    const replyText = result.text.trim();
    const finishReason = result.finishReason;

    if (!replyText || finishReason === "length") {
      if (finishReason === "length") {
        console.warn(
          "[agent-loop] model response truncated (finish_reason=length)",
          { model: modelId }
        );
      } else {
        console.warn("[agent-loop] empty response from model", {
          model: modelId,
          finishReason
        });
      }
      return { kind: "reply", text: TRANSIENT_REPLY };
    }

    await session.appendMessage(sessionMessage("assistant", replyText));
    return { kind: "reply", text: replyText };
  } catch (err) {
    console.error("[agent-loop] turn failed", {
      model: modelId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    // A transient blip is a turn that completed by saying "try again" — the work
    // is recoverable and nothing is broken. An unexpected error is a real
    // failure, and `failed` is the only way to say so on the wire: A2A v1.0 has
    // no structured task error, so the terminal state carries the whole signal.
    return isTransientAiError(err)
      ? { kind: "reply", text: TRANSIENT_REPLY }
      : { kind: "failed", text: args.unexpectedReply };
  }
}
