import { describe, it, expect } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { FakeSession, mockModel } from "@loopingai/core/testing";
import { sessionMessage, type ModelPair } from "@loopingai/core/agent";
import { noReplyTool, NO_REPLY_TOOL_NAME } from "@loopingai/plugins/triage";
import {
  runTurn,
  TRANSIENT_REPLY,
  type RunTurnArgs
} from "@/agents/proactive/loop";

/**
 * The proactive loop — the second consumer's turn, and the evidence that core
 * stopped at the right place.
 *
 * Everything asserted here is a shape the reactive round loop does not have: a
 * flat step ceiling instead of a metered budget, an ending that is allowed to be
 * silence, and a `no_reply` that is honoured or ignored depending on whether the
 * agent has already spoken. Core ships none of it — and if core had been built
 * from the reactive agent alone, it would have shipped a control-tool abstraction
 * this file would be fighting.
 */

const MODELS = { primary: "@cf/test/primary", fallback: "@cf/test/fallback" };

function pair(primary: ReturnType<typeof mockModel>, fallback = primary) {
  return {
    primary: () => primary,
    fallback: () => fallback,
    primaryId: () => MODELS.primary,
    fallbackId: () => MODELS.fallback
  } as unknown as ModelPair;
}

/** History with the inbound turn already appended — the DO's job, not the loop's. */
function withTurn(session: FakeSession, text: string) {
  const message = sessionMessage("user", text);
  session.appendMessage(message);
  return session.messages;
}

function args(overrides: Partial<RunTurnArgs> = {}): RunTurnArgs {
  const session = overrides.session ?? new FakeSession();
  return {
    session,
    history: withTurn(session as FakeSession, "is anyone there?"),
    systemSuffix: "",
    tools: { [NO_REPLY_TOOL_NAME]: noReplyTool },
    models: pair(mockModel({ text: "here is your answer" })),
    maxSteps: 8,
    unexpectedReply: "something went wrong",
    ...overrides
  };
}

describe("replying", () => {
  it("returns the model's text and persists it", async () => {
    const session = new FakeSession();
    const outcome = await runTurn(args({ session }));

    expect(outcome).toEqual({ kind: "reply", text: "here is your answer" });
    expect(session.messages.at(-1)?.role).toBe("assistant");
  });

  it("does not append the user turn — the DO already did", async () => {
    // The append moved to the caller when triage became a plugin gate: the
    // message has to be in history *before* the gate runs, so appending here as
    // well would duplicate every turn.
    const session = new FakeSession();
    await runTurn(args({ session }));
    expect(session.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("treats an empty response as transient rather than as an answer", async () => {
    const outcome = await runTurn(
      args({ models: pair(mockModel({ text: "   " })) })
    );
    expect(outcome).toEqual({ kind: "reply", text: TRANSIENT_REPLY });
  });
});

describe("declining late, via the no_reply tool", () => {
  it("ends the turn in silence when nothing has been said yet", async () => {
    const session = new FakeSession();
    const outcome = await runTurn(
      args({
        session,
        models: pair(
          mockModel({ toolCall: { toolName: NO_REPLY_TOOL_NAME, input: {} } })
        )
      })
    );

    expect(outcome).toEqual({ kind: "no_reply" });
    // Nothing assistant-shaped is persisted: the agent read the channel and
    // chose not to speak.
    expect(session.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("ignores a no_reply once the agent has already streamed content", async () => {
    // The guard that makes `no_reply` a *late* decision rather than a way to
    // discard a turn the user has already seen. Hiding the tool is not enough —
    // the SDK resolves a call against the unfiltered map, so a model that names
    // it after speaking would execute it happily.
    const streamed: string[] = [];
    const outcome = await runTurn(
      args({
        models: pair(
          mockModel(
            { text: "let me check", toolCall: { toolName: "noop", input: {} } },
            { toolCall: { toolName: NO_REPLY_TOOL_NAME, input: {} } },
            { text: "actually, here it is" }
          )
        ),
        tools: {
          [NO_REPLY_TOOL_NAME]: noReplyTool,
          // A real tool, so the first step can carry text *and* a tool call —
          // which is what makes it an intermediate step, which is what streams
          // the content that then disqualifies the `no_reply`.
          noop: tool({
            description: "does nothing",
            inputSchema: z.object({}),
            execute: async () => "ok"
          })
        },
        onContent: (text) => {
          streamed.push(text);
        }
      })
    );

    expect(streamed).toContain("let me check");
    expect(outcome.kind).not.toBe("no_reply");
  });
});

describe("failure handling", () => {
  it("reports an unexpected failure as `failed`, not as a reply", async () => {
    // The distinction is load-bearing: A2A v1.0 carries no structured task
    // error, so the terminal state is the only way to tell the gateway the turn
    // broke rather than answered.
    const exploding = {
      primary: () => {
        throw new Error("boom");
      },
      fallback: () => {
        throw new Error("boom");
      },
      primaryId: () => MODELS.primary,
      fallbackId: () => MODELS.fallback
    } as unknown as ModelPair;

    const outcome = await runTurn(
      args({ models: exploding, unexpectedReply: "sorry, it broke" })
    );
    expect(outcome).toEqual({ kind: "failed", text: "sorry, it broke" });
  });

  it("reports a transient capacity blip as a reply telling the user to retry", async () => {
    const transient = {
      primary: () => {
        throw new Error("capacity temporarily exceeded");
      },
      fallback: () => {
        throw new Error("capacity temporarily exceeded");
      },
      primaryId: () => MODELS.primary,
      fallbackId: () => MODELS.fallback
    } as unknown as ModelPair;

    // Nothing is broken and the work is recoverable, so the turn genuinely
    // completed — by saying "try again".
    const outcome = await runTurn(args({ models: transient }));
    expect(outcome).toEqual({ kind: "reply", text: TRANSIENT_REPLY });
  });
});
