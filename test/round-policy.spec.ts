import { describe, it, expect } from "vitest";
import { FINAL_REPLY_TOOL_NAME } from "@loopingai/core/agent";
import { DELEGATE_TOOL_NAME } from "@loopingai/core/subtasks";
import { finalRoundNote, roundContract, roundPolicy } from "@/round-policy";

/**
 * The repo-owned half of the round loop: the words, not the mechanism.
 * `@loopingai/core/round` owns the DAG scheduler and the primary→fallback
 * ladder and pins none of this prose, so it is this file's to keep correct.
 */

describe("roundContract", () => {
  const contract = (typeKeys: string[], maxSubtasks = 8) =>
    roundContract({ typeKeys, maxSubtasks });

  it("names every installed subtask type, and only those", () => {
    const text = contract(["general"]);
    expect(text).toContain('"general"');
    // The enum is what the model may emit; a type nobody installed must not
    // appear in the prose either, or the model is invited to name it.
    expect(text).not.toContain('"arc-game"');
  });

  it("names the delegate and final-reply tools by their real names", () => {
    const text = contract(["general"]);
    expect(text).toContain(DELEGATE_TOOL_NAME);
    expect(text).toContain(FINAL_REPLY_TOOL_NAME);
  });

  it("states the caller's own maxSubtasks ceiling", () => {
    expect(contract(["general"], 8)).toContain("between 1 and 8");
    expect(contract(["general"], 3)).toContain("between 1 and 3");
  });
});

describe("finalRoundNote", () => {
  it("tells a budget-spent round it has no way out but answering", () => {
    const note = finalRoundNote({ maxTurns: 20, maxWallMs: 60_000 });
    expect(note).toContain("Your budget is spent");
    expect(note).toContain(FINAL_REPLY_TOOL_NAME);
    // Names the budget as a fact rather than as a withheld capability — a
    // model told "you cannot delegate" tries to route around it.
    expect(note).toContain("20 turns");
  });

  it("says delegation is unavailable rather than staying silent about it", () => {
    // `delegate` is not declared as a tool in this state — nothing in this
    // module asserts that; it lives in the runtime's control-tool wiring. What
    // this text owns is telling the model so in plain words, rather than
    // leaving it to notice the tool is simply gone from its schema.
    const note = finalRoundNote({ maxTurns: 20, maxWallMs: 60_000 });
    expect(note).toContain("cannot delegate");
  });

  it("renders wall-clock minutes, not raw milliseconds", () => {
    const note = finalRoundNote({ maxTurns: 20, maxWallMs: 30 * 60_000 });
    expect(note).toContain("30");
    expect(note).not.toContain("1800000");
  });
});

describe("roundPolicy", () => {
  it("wires the two functions above, not a redeclared copy of them", () => {
    expect(roundPolicy.roundContract).toBe(roundContract);
    expect(roundPolicy.finalRoundNote).toBe(finalRoundNote);
  });

  it("declares non-empty copy for every user-facing string", () => {
    expect(roundPolicy.copy.taskFailed.length).toBeGreaterThan(0);
    expect(roundPolicy.copy.recoveredReply.length).toBeGreaterThan(0);
    expect(roundPolicy.copy.partialNote.length).toBeGreaterThan(0);
  });
});
