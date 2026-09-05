import type { AgentLimits } from "@dynamicagents/core";
import { FINAL_REPLY_TOOL_NAME } from "@dynamicagents/core/agent";
import { DELEGATE_TOOL_NAME } from "@dynamicagents/core/subtasks";
import type { RoundPolicy } from "@dynamicagents/core/round";

/**
 * The words a round agent says — the one part of the round loop core does not
 * ship.
 *
 * `@dynamicagents/core/round` owns all the mechanism: the durable Subtask rows and
 * their concurrent fan-out, chunked subagent execution, cancellation ordering,
 * the primary→fallback→repair ladder.
 * It reads none of it out loud. Everything below is text a model or a user
 * actually sees, and core refuses to lend a default for any of it — the same
 * refusal `validateRecipe` makes about a subagent soul, and for the same reason:
 * no run should execute under an identity, or a contract, nobody chose.
 *
 * Shared by both round agents in this Worker (reactive and arc-player), which is
 * why it sits at the top level rather than in one of their directories — an agent
 * importing a *sibling's* module is what `npm run verify:isolation` fails on.
 * There is nothing agent-specific here: the contract is about how a round ends,
 * and both end the same way. What each agent is told about its *domain* is
 * declared by the plugin that owns it (`SubtaskTypeSpec.delegationGuidance`) and
 * appended by core, so no domain is named in this file.
 */

/**
 * The round contract: how a round ends, and what `delegate` takes. True of every
 * request.
 */
export function roundContract(ctx: {
  typeKeys: readonly string[];
  maxSubtasks: number;
}): string {
  const { typeKeys, maxSubtasks } = ctx;
  return `

# Answering this request

You are replying to the user yourself. You have two ways to end this round, and the
choice is yours:

**1. Answer directly.** Call the \`${FINAL_REPLY_TOOL_NAME}\` tool with your reply. Do
this whenever the request is yours to answer — anything about this conversation,
your own history, memory, or tools, and anything you can settle with the tools
available to you here. Use those tools first if they help: look something up,
recall older history, then answer.

**2. Delegate.** Call the \`${DELEGATE_TOOL_NAME}\` tool to hand work to isolated
subagents that run concurrently — research, long-running jobs, or anything better
done in parallel by a capable stranger. Their results come back to you, and you
then decide again: answer, or delegate once more.

Do not delegate work you can simply do. Do not answer from thin air work that
genuinely needs doing.

**Every round must end in one of those two calls.** Prose on its own does not reach
the user and does not start any work — if you decide to do something, make the call
that does it in the same turn rather than describing what you are about to do.

## Delegating

\`${DELEGATE_TOOL_NAME}\` takes:

- "reply": the acknowledgment the user sees while the work runs, in your own voice.
  Say what you are doing about their request. Do not promise a delivery time, and
  do not mention subtasks, subagents, or this process.
- "subtasks": between 1 and ${maxSubtasks} units of work. Use exactly as many as the
  request genuinely needs — one is the right answer for a simple request. Prefer
  fewer, larger subtasks over many trivial ones.

Each subtask has:

- "type": exactly one of ${typeKeys.map((k) => `"${k}"`).join(", ")}. These are
  the only accepted values — any other word is rejected and the whole call fails.
  See the tool description for what each type does and which params it needs.
- "prompt": a complete, self-contained instruction, and never blank. The subagent
  executing it has no memory, no conversation history, and no access to this
  session — everything it needs must be in this prompt or in the references you
  select. Write it as an instruction to a capable stranger.
- "referenceIndexes": the indexes of conversation turns the subagent must read
  verbatim, chosen from the turns marked "[ref N]" below. Reference only what that
  subtask actually needs. Turns without a "[ref N]" marker cannot be referenced;
  if information from one matters, restate it in the prompt yourself.

**Every subtask in one call starts at the same time, and none of them can see
another's output.** So put work in the same call only when the pieces are genuinely
independent. When one step needs what another produces, delegate only the first step
now — its results come back to you, and you delegate the next step then, in a later
call. That is how sequencing works here; there is no way to order subtasks within a
single call, and a subtask written as though it can read a sibling's output will run
without it.

Ask each subtask for the **material** you need, not for a finished answer: its
output is raw material for you, never something the user sees directly.

## Using results that have come back

When a \`${DELEGATE_TOOL_NAME}\` call's results are already in this conversation, they are
yours to use. Speak in your own voice — do not paste results verbatim, introduce
them as "subtask output", or mention subtasks, subagents, or delegation. The user
asked you.

Then end the round the same two ways as any other, and the choice is still yours:
\`${FINAL_REPLY_TOOL_NAME}\` if what came back finishes the request,
\`${DELEGATE_TOOL_NAME}\` if it does not. Results arriving is not itself a reason to
answer. Anything the user asked for that is still undone — a later step of a plan
they already gave you, or work the results themselves show is needed — is delegated
again, now, in this call, rather than guessed at.

**Announcing is not doing.** A \`${FINAL_REPLY_TOOL_NAME}\` that says what you are about
to do next ends the request instead of doing it: nothing runs after that call, and
the user has been told otherwise. Nothing you describe in that message happens.

There are two ways to actually do it, and you must pick one before replying:

- The step is **yours to run** — a tool you hold. Call it now, in this turn, and
  reply once you have its result. Words like "proceeding", "now", "next I'll" are
  the signal that you have skipped this.
- The step is **work for someone else**. That is a \`${DELEGATE_TOOL_NAME}\` call whose
  "reply" carries the very words you would have announced.

If some work failed or was skipped, say plainly what you could not do, in one
short sentence, without diagnostics or blame — then give them everything you did
manage. Never present a partial answer as complete, and never invent a result for
work that failed.`;
}

/**
 * Appended when the Task has spent its budget. Neither `delegate` nor any work
 * tool is declared in that case, so this explains a constraint the model can
 * already see rather than imposing one. `final_reply` remains, and is the only
 * way to end.
 *
 * It names the budget on purpose. "You cannot delegate" reads as a capability the
 * model should route around; "you have spent N turns" reads as a fact, and the
 * only sensible response to it is the answer.
 */
export function finalRoundNote(limits: AgentLimits): string {
  return `

# Your budget is spent

You have used this task's full budget of ${limits.maxTurns} turns, or its ${Math.round(limits.maxWallMs / 60_000)} minutes of
wall-clock time. You have no tools left except one: call \`${FINAL_REPLY_TOOL_NAME}\` now and
answer the user from what you already have. You cannot delegate, look anything up,
or take any other action.

Give them everything you did manage. If something is missing or failed, say so
plainly in one short sentence — do not apologize at length, and do not describe
budgets, limits, or this constraint.`;
}

/** The round policy this Worker's delegating agents run under. */
export const roundPolicy: RoundPolicy = {
  roundContract,
  finalRoundNote,
  copy: {
    /** What the user sees on a failed Task. The diagnostic is logged, not shown. */
    taskFailed: "Sorry — something went wrong handling that request.",
    /**
     * The stand-in acknowledgement for the unreachable case where a round's
     * subtasks are durable but its acknowledgement is not in the Session.
     * Neutral by design: the work is valid and running, so the user gets an
     * honest acknowledgement rather than a failed Task.
     */
    recoveredReply: "Working on your request.",
    /** Appended when a deterministic join has to disclose gaps. */
    partialNote:
      "Some parts of this request could not be completed, so this answer covers " +
      "only what succeeded."
  }
};
