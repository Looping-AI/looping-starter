import { describe, it, expect } from "vitest";
import { makeSubtaskTypes } from "@loopingai/core/subtasks";
import { newTurnBudget } from "@loopingai/core/agent";
import { FakeSession, finalReply, mockModel } from "@loopingai/core/testing";
import type { ModelPair } from "@loopingai/core/agent";
import type { CompositionBranch } from "@loopingai/core/subtasks";
import {
  buildTurnInstructions,
  joinSuccessfulBranches,
  renderTurnMessages,
  runTurn,
  type RunTurnArgs
} from "@/round-agent/turn";
import { general } from "@/agents/reactive/general";

/**
 * The round loop — the part of the reactive agent core deliberately does not
 * ship. Core owns the session, the budget, the control tools and the delegation
 * layer; how a round *ends* is this file's, so this is where it gets pinned.
 */

const MODELS = {
  primaryModelId: "@cf/test/primary",
  fallbackModelId: "@cf/test/fallback"
};

// The starter's own locally-declared plugin, installed the same way a published
// one would be — which is the point of it being a plugin at all.
const types = makeSubtaskTypes([general(MODELS).subtaskType!]);

const instructions = buildTurnInstructions(types, 8, {
  maxTurns: 20,
  maxWallMs: 60_000
});

/** A model pair whose two slots can be scripted independently. */
function pair(primary: ReturnType<typeof mockModel>, fallback = primary) {
  return {
    primary: () => primary,
    fallback: () => fallback,
    primaryId: () => MODELS.primaryModelId,
    fallbackId: () => MODELS.fallbackModelId
  } as unknown as ModelPair;
}

function args(overrides: Partial<RunTurnArgs> = {}): RunTurnArgs {
  return {
    session: new FakeSession(),
    taskId: "t1",
    round: 0,
    text: "hello",
    mode: "open",
    budget: newTurnBudget(20),
    systemSuffix: "",
    tools: {},
    models: pair(mockModel(finalReply("done"))),
    branches: [],
    types,
    maxSubtasks: 8,
    maxOutputTokens: 4096,
    instructions,
    ...overrides
  };
}

describe("the round contract", () => {
  it("names every installed subtask type, and only those", () => {
    expect(instructions.open).toContain('"general"');
    // The enum is what the model may emit; a type nobody installed must not
    // appear in the prose either, or the model is invited to name it.
    expect(instructions.open).not.toContain('"arc-game"');
  });

  it("tells a budget-spent round it has no way out but answering", () => {
    expect(instructions.final).toContain("Your budget is spent");
    expect(instructions.final).toContain("final_reply");
    // Names the budget as a fact rather than as a withheld capability — a model
    // told "you cannot delegate" tries to route around it.
    expect(instructions.final).toContain("20 turns");
  });
});

describe("runTurn", () => {
  it("appends the user turn once, under a deterministic id", async () => {
    const session = new FakeSession();
    await runTurn(args({ session }));
    // A Workflow step re-runs; a second append under the same id must not
    // duplicate the turn.
    await runTurn(args({ session, round: 0 }));

    const users = session.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
  });

  it("charges the budget for every step, including a failed attempt", async () => {
    const budget = newTurnBudget(20);
    // Prose with no control call is not an ending: the attempt fails and the
    // fallback gets its turn. Both slots spent real steps.
    await runTurn(
      args({
        budget,
        models: pair(mockModel({ text: "I'll get right on that" }))
      })
    );
    expect(budget.spent).toBeGreaterThanOrEqual(2);
  });

  it("falls back to the second model when the first reaches no ending", async () => {
    const outcome = await runTurn(
      args({
        models: pair(
          mockModel({ text: "narrating instead of acting" }),
          mockModel(finalReply("the actual answer"))
        )
      })
    );
    expect(outcome).toEqual({ status: "replied", reply: "the actual answer" });
  });

  it("delivers durable branch results when both models fail", async () => {
    // The work is done and the user asked for it; failing the task because the
    // *answering* model is down would throw away good results.
    const branches: CompositionBranch[] = [
      {
        subtaskId: 1,
        round: 0,
        ordinal: 0,
        type: "general",
        prompt: "research",
        dependsOn: [],
        params: {},
        status: "completed",
        resultParts: [{ kind: "text", text: "what the branch found" }],
        error: null
      }
    ];
    const outcome = await runTurn(
      args({ branches, models: pair(mockModel({ text: "no ending" })) })
    );

    expect(outcome.status).toBe("replied");
    expect(outcome).toMatchObject({ reply: "what the branch found" });
  });

  it("fails the round when both models fail with nothing durable behind them", async () => {
    const outcome = await runTurn(
      args({ models: pair(mockModel({ text: "no ending" })) })
    );
    expect(outcome.status).toBe("failed");
  });
});

describe("renderTurnMessages", () => {
  it("marks referenceable turns with the index the model selects them by", async () => {
    const session = new FakeSession();
    await runTurn(args({ session }));

    const { messages, catalog } = renderTurnMessages(
      session.messages,
      "t1",
      []
    );
    expect(catalog).toHaveLength(
      messages.filter((m) => String(m.content).startsWith("[ref ")).length
    );
    // The markers and the catalog are produced in one pass precisely so they
    // cannot disagree; a mismatch means a subtask could cite an index that
    // resolves to different text.
    expect(catalog[0]?.index).toBe(1);
  });
});

describe("joinSuccessfulBranches", () => {
  const branch = (
    status: CompositionBranch["status"],
    text: string
  ): CompositionBranch => ({
    subtaskId: 1,
    round: 0,
    ordinal: 0,
    type: "general",
    prompt: "p",
    dependsOn: [],
    params: {},
    status,
    resultParts: [{ kind: "text", text }],
    error: null
  });

  it("joins only what succeeded", () => {
    const joined = joinSuccessfulBranches([
      branch("completed", "first"),
      branch("completed", "second")
    ]);
    expect(joined).toBe("first\n\nsecond");
  });

  it("discloses the gap rather than presenting a partial answer as complete", () => {
    const joined = joinSuccessfulBranches([
      branch("completed", "first"),
      branch("failed", "ignored")
    ]);
    expect(joined).toContain("first");
    expect(joined).toContain("could not be completed");
    expect(joined).not.toContain("ignored");
  });
});
