import type {
  AssistantContent,
  LanguageModel,
  ModelMessage,
  ToolSet
} from "ai";
import { generateText, hasToolCall, isStepCount } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import type { AgentLimits } from "@loopingai/core";
import type { SubtaskTypeRegistry } from "@loopingai/core/subtasks";
import {
  appendOnce,
  buildIntermediateContentHandler,
  controlTools,
  controlToolSet,
  deterministicSessionMessage,
  finalReplyMessageId,
  isTransientAiError,
  parseRoundAckMessageId,
  roundAckMessageId,
  sessionText,
  stepAllowance,
  taskUserMessageId,
  FINAL_REPLY_TOOL_NAME,
  type ControlTool,
  type ModelPair,
  type OnContent,
  type SessionLike,
  type TurnBudget,
  type TurnDecision
} from "@loopingai/core/agent";
import {
  DELEGATE_TOOL_NAME,
  delegateCallInput,
  delegateCallOutput,
  delegateToolCallId,
  isCatalogEligible,
  type CompositionBranch,
  type ReferenceCatalogEntry,
  type SubtaskDraft
} from "@loopingai/core/subtasks";

/**
 * One **round** of the main agent: a single inference over the agent's continuous
 * Session that ends in one of two decisions — answer the user, or delegate.
 *
 * This file is the agent's, not core's, and that is the whole point of the split:
 * core ships the session, the model pair, the budget, the control-tool
 * abstraction and the delegation layer, because both predecessor loops needed
 * those identically. How a round *ends* is the one thing agents genuinely differ
 * on, so it lives here — compare `../proactive/loop.ts`, which bounds itself with
 * a flat step count and ends on a `no_reply` tool call instead.
 *
 * This is the whole task pipeline's control point. The Workflow runs rounds in a
 * loop: a round that delegates gets its Subtask DAG executed and is followed by
 * another round; a round that answers ends the Task. So "compose" is not a
 * separate phase with its own rules — it is simply the round in which the model
 * decides it has enough to answer.
 *
 * Two layers of tools, and the difference is the design:
 *
 * - **Work tools** (whatever the installed plugins offer the main agent, plus the
 *   Session's own `set_context`) carry an `execute` and run *inside* the round's
 *   tool loop. They never end a round; the model keeps reasoning over their
 *   results. Every round gets them except the one the budget forced — looking
 *   something up before answering is ordinary work, not a special phase, right up
 *   until there is nothing left to spend on it (see {@link RoundMode}).
 * - **Control tools** — `delegate` and `final_reply` — have no `execute`. The call
 *   *is* the round's output: the loop halts on it, and for `delegate` the Workflow
 *   performs it durably. Because the loop halts, the SDK never validates their
 *   input either, so each one checks its own and the round repairs what it rejects
 *   — see core's `agent/control.ts`. A future `escalate` (ask the human) is the
 *   same shape: another entry there, another variant of {@link TurnDecision},
 *   another `case` in the Workflow's switch.
 *
 * Nothing forces the *choice*, and that is deliberate. An earlier design pinned
 * `toolChoice` to a specific tool to force delegation in one phase and forbid it in
 * another, which meant a request the main agent was best placed to answer got
 * shipped to a memoryless subagent, and material that came back could only ever be
 * turned into prose. That is still rejected: the model picks its own ending, and
 * delegating twice is allowed.
 *
 * What *is* forced is that the round end in a control call at all —
 * `toolChoice: "required"`, with both endings declared as tools. Plain text used to
 * be an outcome, and it made narration indistinguishable from an answer: a model
 * that wrote "I'll start the game" and emitted no call ended the Task successfully
 * having done nothing. Two named tools is also a much easier discrimination for a
 * small model than prose-versus-tool, which is what the weaker fallback models
 * consistently got wrong.
 *
 * Narration survived that fix by moving house. A round whose results have just come
 * back can still announce its next step *inside* a `final_reply` — "now sending the
 * second one" — and that ends the Task as surely as prose did, having done nothing,
 * while telling the user the opposite. No mechanism can catch it: `final_reply` is a
 * legitimate ending for exactly this round, and only the model knows whether the
 * request is finished. So it is the round contract that has to close it, which is
 * why that document keeps the two endings symmetric *after* results land rather
 * than treating "results are in" as a cue to answer.
 *
 * The model reasons over the whole conversation but references it by **catalog
 * index only** — see {@link renderTurnMessages}.
 */

/**
 * The prompt copy for one configured agent, built once per Durable Object
 * instance.
 *
 * In the predecessor these were module-level `const`s: template literals
 * interpolating `MAX_SUBTASKS`, the subtask-type enum and the budget, all
 * evaluated at *import* time. That is precisely what the package split cannot do
 * — the type enum is a function of the plugins this agent installed, which is a
 * function of `env`, which does not exist at module scope on Workers.
 *
 * So it is a builder, and the DO memoizes the result in `onStart`. Same cost as
 * before (once), same values, but now they can differ per agent: arc-player
 * builds these from the same function with a different plugin set and reads a
 * different type enum out of it, with no second copy of this file.
 */
export interface TurnInstructions {
  /** Contract + per-type delegation guidance. Appended to soul + caller context. */
  open: string;
  /** Further appended when the budget is spent. See {@link FINAL_ROUND_NOTE}. */
  final: string;
}

/**
 * The round contract itself: how a round ends, and what `delegate` takes. True of
 * every request, and it names no domain — what any individual Subtask type needs
 * said about it is that type's to declare, via `SubtaskTypeSpec.delegationGuidance`.
 */
export function roundContract(
  typeKeys: readonly string[],
  maxSubtasks: number
): string {
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

- "localKey": a short unique identifier within this call (e.g. "research"). Must not
  be blank.
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
- "dependsOn": the localKeys this subtask needs the output of. Leave it empty for
  work that can start immediately. Dependent subtasks receive their prerequisites'
  output. The graph must be acyclic, and may only reference subtasks in this same
  call.

Subtasks with no dependency between them run at the same time, so only add an edge
where output genuinely feeds input.

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
the user has been told otherwise. If your next step is more work, that step is a
\`${DELEGATE_TOOL_NAME}\` call whose "reply" carries the very words you would have
announced.

If some work failed or was skipped, say plainly what you could not do, in one
short sentence, without diagnostics or blame — then give them everything you did
manage. Never present a partial answer as complete, and never invent a result for
work that failed.`;
}

/**
 * Appended when the Task has spent its budget (see {@link RoundMode}). Neither
 * `delegate` nor any work tool is declared in that case, so this explains a
 * constraint the model can already see rather than imposing one. `final_reply`
 * remains, and is the only way to end.
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

/**
 * Build both prompt suffixes for one configured agent.
 *
 * The contract, then whatever the delegable types have to say about being
 * delegated — each declared by the type that owns it (`SubtaskTypeSpec`) and
 * collected by the runtime's registry, so no domain is named in this file. That
 * is the rule the two prompt fields on a subtask type exist to hold: everything
 * the main agent is told about a domain is declared by the plugin that owns it,
 * never written inside the loop.
 */
export function buildTurnInstructions(
  types: SubtaskTypeRegistry,
  maxSubtasks: number,
  limits: AgentLimits
): TurnInstructions {
  const guidance = types.renderDelegationGuidance({
    delegateTool: DELEGATE_TOOL_NAME,
    finalReplyTool: FINAL_REPLY_TOOL_NAME
  });
  const open =
    roundContract(types.keys, maxSubtasks) +
    (guidance ? `\n\n${guidance}` : "");
  return { open, final: open + finalRoundNote(limits) };
}

/** User-facing note appended when a deterministic join has to disclose gaps. */
const PARTIAL_NOTE =
  "Some parts of this request could not be completed, so this answer covers " +
  "only what succeeded.";

/** Join one branch's parts into its text block. */
function branchText(branch: CompositionBranch): string {
  return (branch.resultParts ?? []).map((p) => p.text).join("\n");
}

/** Group every branch by the round that delegated it, preserving ordinal order. */
function byRound(
  branches: CompositionBranch[]
): Map<number, CompositionBranch[]> {
  const rounds = new Map<number, CompositionBranch[]>();
  for (const branch of branches) {
    const existing = rounds.get(branch.round);
    if (existing) existing.push(branch);
    else rounds.set(branch.round, [branch]);
  }
  return rounds;
}

/**
 * Rebuild one round's `delegate` call and pair it with its result.
 *
 * Both halves are real. That round's model genuinely emitted this call; the
 * subagents genuinely produced these outcomes. All that separates them is a
 * Workflow boundary and, often, hours — so the pair is reconstructed here rather
 * than carried, from the durable rows that are the record of what happened.
 *
 * Failed and skipped branches are included so the model can disclose them rather
 * than quietly answering as if the work had been done; their diagnostics are not
 * (see `delegateCallOutput`).
 */
function delegationPair(
  taskId: string,
  round: number,
  replyText: string | null,
  branches: CompositionBranch[]
): ModelMessage[] {
  const toolCallId = delegateToolCallId(taskId, round);
  const content: AssistantContent = [];
  // The acknowledgment the user already saw, if it is still in history.
  if (replyText) content.push({ type: "text", text: replyText });
  content.push({
    type: "tool-call",
    toolCallId,
    toolName: DELEGATE_TOOL_NAME,
    input: delegateCallInput(replyText ?? "", branches)
  });
  return [
    { role: "assistant", content },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: DELEGATE_TOOL_NAME,
          output: { type: "json", value: delegateCallOutput(branches) }
        }
      ]
    }
  ];
}

/**
 * Render the model's view for one round: the conversation, with every earlier
 * round's delegation restored as the call-and-result it actually was, and every
 * referenceable turn marked with the catalog index the model selects it by.
 *
 * One pass, two jobs, because they have to agree. The `[ref N]` markers use
 * `isCatalogEligible` — the same predicate the catalog is numbered with — so a
 * marker and its entry can never drift: compaction summaries (`assistant` role,
 * generated) stay in the messages unmarked, readable for context but structurally
 * uncitable as conversation evidence, which is exactly the intent.
 *
 * A round's acknowledgment is stored as plain assistant text (history is
 * text-only, and stays that way — `sessionText`, the catalog, compaction, and
 * recall all read text parts). So its `delegate` call is re-attached to that
 * message here, and the result appended after it, for this one inference call. The
 * pair is emitted together, anchored on the ack's deterministic id, so a `tool`
 * message can never be orphaned from its call — and an ack that has been compacted
 * away still gets its pair, appended at the end minus the acknowledgment text: a
 * result the model cannot place beats a malformed history.
 *
 * Acks are deliberately **not** catalog-eligible: they are the agent's own
 * scaffolding, and a subtask referencing "I'm on it" as verbatim conversation
 * evidence would be noise. That holds for every ack in the Session, not only the
 * ones this render can pair with branches — see `parseRoundAckMessageId`.
 *
 * Everything here is ephemeral — scaffolding for this call only. Reference text is
 * snapshotted from the catalog, so no `[ref N]` prefix ever reaches a Subtask, and
 * the Session never sees any of this markup.
 */
export function renderTurnMessages(
  history: SessionMessage[],
  taskId: string,
  branches: CompositionBranch[]
): { messages: ModelMessage[]; catalog: ReferenceCatalogEntry[] } {
  const rounds = byRound(branches);
  const ackIds = new Map(
    [...rounds.keys()].map((round) => [roundAckMessageId(taskId, round), round])
  );

  const catalog: ReferenceCatalogEntry[] = [];
  const messages: ModelMessage[] = [];
  const anchored = new Set<number>();

  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const role = message.role;
    const text = sessionText(message);

    const round = ackIds.get(message.id);
    if (round !== undefined) {
      messages.push(
        ...delegationPair(taskId, round, text, rounds.get(round) ?? [])
      );
      anchored.add(round);
      continue;
    }

    // An acknowledgment with no branches behind it — recognized by id, since
    // nothing in the message body distinguishes an ack from ordinary assistant
    // prose. This Task's own is the crash-window leftover: the ack landed, the
    // rows did not, and this render belongs to the retry that will decide the
    // round again. Dropping it is what makes that retry a clean re-decision —
    // left in, it reads as "already delegated" and invites the model to answer
    // instead of delegating, ending the Task with no work done. Another Task's
    // ack is real history the user saw, so it stays as context, but uncitable:
    // no round of *this* Task can hold it up as conversation evidence.
    const ack = parseRoundAckMessageId(message.id);
    if (ack) {
      if (ack.taskId !== taskId) messages.push({ role, content: text });
      continue;
    }

    if (!isCatalogEligible(message)) {
      // Not referenceable (a compaction summary): still context for reasoning.
      messages.push({ role, content: text });
      continue;
    }
    const index = catalog.length + 1;
    catalog.push({ index, role, text });
    messages.push({ role, content: `[ref ${index}] ${text}` });
  }

  // Rounds whose acknowledgment is no longer in history (compacted away by a
  // concurrent task), in round order so the results still read chronologically.
  const orphaned = [...rounds.entries()]
    .filter(([round]) => !anchored.has(round))
    .sort(([a], [b]) => a - b);
  for (const [round, roundBranches] of orphaned) {
    messages.push(...delegationPair(taskId, round, null, roundBranches));
  }

  return { messages, catalog };
}

/**
 * Deterministic fallback reply: the successful branches' text in ordinal order,
 * plus a short note when some branches did not succeed.
 *
 * Used when a round's inference is unavailable but its predecessors' work is
 * durable. Failing the whole Task because the answering model is down would throw
 * away good results the user asked for.
 */
export function joinSuccessfulBranches(branches: CompositionBranch[]): string {
  const successes = branches.filter((b) => b.status === "completed");
  const body = successes.map(branchText).join("\n\n");
  const incomplete = branches.length > successes.length;
  return incomplete ? `${body}\n\n${PARTIAL_NOTE}` : body;
}

/**
 * How much rope this round gets, decided by the Workflow from the Task's spent
 * budget.
 *
 * - `open` — the normal round: `delegate`, `final_reply`, and every work tool.
 *   It may spend whatever is left of the turn budget.
 * - `final` — the Task has spent its turns or its wall clock. **No work tools and
 *   no `delegate`**: the only thing on the table is the answer. This is not a
 *   punishment but the shape of the ceiling — a budget that ends in a forced
 *   answer returns the work, where one that simply stopped would discard it.
 *   Costs one turn, or two if the primary model fails and the fallback has to
 *   produce the answer instead; a fallback with no step to spend could not answer
 *   at all.
 */
export type RoundMode = "open" | "final";

export interface RunTurnArgs {
  /** The DO's one continuous Session. */
  session: SessionLike;
  /** Parent Task id — derives the deterministic Session message ids. */
  taskId: string;
  /** 0-based round within this Task. */
  round: number;
  /** The inbound user text (keeps its `<turn>` provenance wrapper verbatim). Appended on round 0 only. */
  text: string;
  /** What this round may do — see {@link RoundMode}. */
  mode: RoundMode;
  /**
   * The Task's unspent turns, and the tally this round writes back into them.
   * Mutated in place as the model works, so the primary and the fallback draw on
   * one allowance rather than one each — see `TurnBudget`.
   *
   * There is no per-round allowance beyond what the Task has left: an early round
   * that dithers spends what a later one would have had, and is then handed a
   * `final` round to answer in. The caller reads `spent` when the round returns.
   */
  budget: TurnBudget;
  /** Per-request system-prompt suffix (verified caller context). */
  systemSuffix: string;
  /** The main agent's gated **work** tools, merged over the session's own tools. */
  tools: ToolSet;
  /** Primary + fallback model pair. */
  models: ModelPair;
  /** Every earlier round's branches, all rounds, in stable ordinal order. */
  branches: CompositionBranch[];
  /**
   * The installed subtask types — what `delegate` may name. From
   * `runtime.types`; was a module-scope import in the predecessor.
   */
  types: SubtaskTypeRegistry;
  /** `CoreConfig.maxSubtasks`, the per-round fan-out bound. */
  maxSubtasks: number;
  /** `CoreConfig.model.maxOutputTokens`. */
  maxOutputTokens: number;
  /** The prompt suffixes, memoized by the DO. See {@link buildTurnInstructions}. */
  instructions: TurnInstructions;
  /** Streams intermediate content while the model reasons. Best-effort. */
  onContent?: OnContent;
}

/**
 * Terminal outcome of one round. `failed` means both models produced unusable
 * output *and* there was no durable work to fall back on — the parent Task fails
 * rather than running a synthesized subtask nobody asked for. Transient faults
 * throw instead (the Workflow step retries).
 *
 * What the round cost is not here: it is in the caller's `TurnBudget`, which every
 * exit has already charged — including the ones that failed. A round that burned
 * the primary and recovered on the fallback spent both, and there is no variant
 * that could quietly forgive the expensive half of a bad round.
 */
export type RunTurnOutcome =
  | { status: "replied"; reply: string }
  | { status: "delegated"; reply: string; drafts: SubtaskDraft[] }
  | { status: "failed"; error: string };

/**
 * A control call the round refused, kept so it can be handed back to the model
 * verbatim. `input` is whatever the model actually sent — unvalidated by
 * definition, since failing validation is why it is here.
 */
interface RejectedCall {
  toolName: string;
  input: unknown;
}

/**
 * What one attempt produced.
 *
 * The two failure shapes are the whole point of the split. `rejected` present means
 * the model reached an ending and got its *shape* wrong — repairable, and by the
 * same model, which now has something specific to fix. `rejected` absent means the
 * attempt produced no ending at all, which no amount of feedback can address and
 * which is what the fallback slot exists for.
 */
type Attempt =
  | { ok: true; decision: TurnDecision }
  | { ok: false; error: unknown; rejected?: RejectedCall };

/**
 * One attempt against a single model: let it work, and take whichever ending it
 * lands on.
 *
 * Takes the model **factory**, not a model: resolving it can throw (a missing
 * binding, a bad id), and that has to count as this attempt failing so the other
 * model still gets its turn.
 *
 * The model uses its work tools freely — answering well can genuinely need a
 * lookup or a recall — and the loop ends by calling a control tool. None has an
 * `execute`, so there is nothing to continue from and the loop halts on the call.
 * Two endings in one step are resolved by `ControlTool.precedence`.
 *
 * Every control call is then parsed by the tool that owns it, because nothing else
 * has: an execute-less tool's input never passes through the SDK's validation. A
 * parse failure comes back as `rejected` — a repairable failure, not a dead
 * attempt.
 *
 * Charges the budget as it goes, whether it succeeds or not: a failed attempt cost
 * exactly as much as a successful one, and a call that died on its fourth step
 * still spent four turns.
 */
async function attempt(
  args: RunTurnArgs,
  control: ControlTool[],
  model: () => LanguageModel,
  instructions: string,
  messages: ModelMessage[]
): Promise<Attempt> {
  const final = args.mode === "final";
  // A `final` round is handed nothing to work with, only the way out. Leaving the
  // work tools on would invite it to spend a budget it has already spent — and
  // the composing round has every branch result in its messages already, so the
  // thing it needs is not a lookup but an ending.
  const workTools: ToolSet = final ? {} : args.tools;
  // One step per attempt for a `final` round: it exists to produce the answer, and
  // that answer is deliberately spent *beyond* the budget rather than out of it.
  //
  // An `open` round gets whatever the shared budget still holds, read here rather
  // than at the top of the round — so the fallback sees what the primary spent
  // without anyone having to subtract it. See `stepAllowance` for the floor.
  const stepBudget = final
    ? 1
    : stepAllowance(args.budget.allowance, args.budget.spent);
  const content = args.onContent
    ? buildIntermediateContentHandler(args.onContent, [
        DELEGATE_TOOL_NAME,
        FINAL_REPLY_TOOL_NAME
      ])
    : undefined;

  try {
    const result = await generateText({
      model: model(),
      instructions,
      messages,
      // Control tools are declared *first*: tool order is part of the prompt, and
      // the two endings are the thing every round has to reach. Work tool names
      // are compile-time constants and none collides with a control name, so the
      // spread order costs nothing.
      tools: { ...controlToolSet(control), ...workTools },
      // Every ending is a control call, so the model must always call something.
      // Work tools stay freely available — `required` constrains the *shape* of a
      // step's output, not which tool is chosen.
      toolChoice: "required",
      maxOutputTokens: args.maxOutputTokens,
      stopWhen: [
        isStepCount(stepBudget),
        // Halt on any ending this round declares, so a new control tool needs no
        // change here.
        ...control.map((c) => hasToolCall(c.name))
      ],
      // We do our own primary → fallback recovery, so disable the SDK's
      // per-model backoff (it would only add latency and duplicate the fallback).
      maxRetries: 0,
      // Charged here rather than from `result.steps` so a throw mid-loop still
      // bills the steps already spent — the `catch` below has no `result` to read.
      onStepEnd: async (step) => {
        args.budget.spent += 1;
        if (content) await content(step);
      }
    });

    // The most committal ending the model reached, and every call it made to that
    // tool. Ranking by precedence rather than by position keeps "which ending
    // wins" a property the tools declare, not a chain of ifs here.
    const reached = control
      .map((c) => ({
        control: c,
        inputs: result.toolCalls
          .filter((call) => call.toolName === c.name)
          .map((call) => call.input as unknown)
      }))
      .filter((c) => c.inputs.length > 0)
      .sort((a, b) => b.control.precedence - a.control.precedence)[0];

    if (reached) {
      // The call that counts, per the tool — a repeated `final_reply` means its
      // last one. Held outside the `try` so a rejection shows the model *that*
      // call and not whichever came first, which it may already have moved past.
      // Only a `select` that throws leaves it unresolved, and that error is about
      // the repeats themselves, so the first call represents them as well as any.
      let subject: unknown = reached.inputs[0];
      try {
        subject = reached.control.select(reached.inputs);
        return { ok: true, decision: reached.control.parse(subject) };
      } catch (error) {
        // The model ended the round but the call cannot be used. Repairable: it is
        // handed this error and asked again, rather than costing the whole slot.
        return {
          ok: false,
          error,
          rejected: {
            toolName: reached.control.name,
            input: subject
          }
        };
      }
    }

    // No control call. Either the model ran out of steps mid-tool-use, or it
    // ignored `toolChoice: "required"` and narrated an action instead of taking
    // one — the failure this whole design exists to catch. Failing the attempt
    // hands the round to the fallback model rather than shipping the narration to
    // the user as if it were an answer.
    if (result.finishReason === "length") {
      console.warn("[turn] model output truncated", {
        taskId: args.taskId,
        round: args.round,
        maxOutputTokens: args.maxOutputTokens
      });
    }
    return {
      ok: false,
      error: new Error(
        `round produced no decision (finishReason=${result.finishReason}, textLength=${result.text.trim().length})`
      )
    };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * How many times one model may be shown its own rejected control call and asked
 * again, before the round gives up on that slot.
 *
 * Repair belongs to the **slot**, not the round. A rejected call is not evidence
 * that a model is unavailable — it is a model that understood the request and got
 * the shape wrong, which is the one failure it can actually fix once it is shown
 * the rejection. Falling straight through to the fallback instead spends a whole
 * second model on a fresh guess that has no idea the first one failed: that is how
 * two slots produced the identical missing-param error and killed a round either
 * of them could have repaired.
 *
 * The fallback keeps its real job — covering a primary that could not answer at
 * all — and is still reached once repairs run out, since a model that cannot get
 * the shape right in four tries has earned a second opinion.
 */
const MAX_REPAIR_ATTEMPTS = 3;

/**
 * The id a repaired exchange is anchored on, derived from the Task and round like
 * every other id here. Suffixed per repair, so several rejected calls can sit in
 * one attempt's messages without colliding.
 */
function controlCallId(taskId: string, round: number): string {
  return `task:${taskId}:round:${round}:control`;
}

/**
 * A rejected control call paired with its rejection, as the exchange the model has
 * to see in order to fix it.
 *
 * This is deliberately the same shape the SDK produces for a work tool that failed
 * — the call, then an `error-text` result carrying the reason. A work tool gets
 * this for free and models already know how to read it; a control tool halts the
 * loop before the SDK can, so the round builds it by hand. Nothing here is
 * specific to which control tool was refused.
 *
 * Shaped as a real tool exchange rather than a prose "that was wrong" user turn,
 * because that is what it is — and an assistant tool-call with no matching result
 * is a malformed message list to every provider.
 *
 * Entirely ephemeral. These messages exist for the next `generateText` call and are
 * never appended to the Session: the durable record of a round is the ending it
 * landed on, and a call that was thrown out is not something a later round should
 * be able to read back as history.
 */
function repairExchange(
  toolCallId: string,
  rejected: RejectedCall,
  error: unknown
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: rejected.toolName,
          input: rejected.input
        }
      ]
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: rejected.toolName,
          output: {
            type: "error-text",
            value:
              `${String(error)}\n\n` +
              `The round did not end and nothing was started. Call ${rejected.toolName} ` +
              `again, keeping the parts that were fine and fixing only what the error names.`
          }
        }
      ]
    }
  ];
}

/**
 * Run one round against the continuous Session: append the user turn (round 0),
 * let the model decide over the indexed history, validate any delegation against
 * this round's catalog, and persist what the user will see.
 *
 * Every append uses a deterministic id, so a Workflow-step re-run neither
 * duplicates the turn nor changes an already-delivered reply.
 *
 * Two nested recoveries, and they answer different failures. Within a slot, a
 * decomposition the catalog rejects is handed back to the *same* model as a failed
 * tool result, up to {@link MAX_REPAIR_ATTEMPTS} times — a shape error is the one
 * thing a model can fix once it sees it. Across slots, an attempt that produced no
 * decision at all moves to the fallback model, which is what that slot is for.
 *
 * Throws only on a transient platform fault (for the Workflow step to retry).
 * A deterministic failure that outlasts every repair on both slots, with durable
 * work behind it, degrades to {@link joinSuccessfulBranches} rather than discarding
 * completed branches; with nothing behind it, it resolves to `{ status: "failed" }`.
 */
export async function runTurn(args: RunTurnArgs): Promise<RunTurnOutcome> {
  const { session, taskId, round, text, systemSuffix, models, branches } = args;

  if (round === 0) {
    await appendOnce(
      session,
      deterministicSessionMessage(taskUserMessageId(taskId), "user", text)
    );
  }

  const history = await session.getHistory();
  const { messages, catalog } = renderTurnMessages(history, taskId, branches);
  const system =
    (await session.refreshSystemPrompt()) +
    systemSuffix +
    (args.mode === "final" ? args.instructions.final : args.instructions.open);

  // This round's endings, built with the catalog a `delegate` is checked against.
  const control = controlTools({
    catalog,
    delegable: args.mode !== "final",
    types: args.types,
    maxSubtasks: args.maxSubtasks
  });

  const diagnostics: string[] = [];
  const errors: unknown[] = [];

  for (const slot of ["primary", "fallback"] as const) {
    const modelId =
      slot === "primary" ? models.primaryId() : models.fallbackId();
    const model = slot === "primary" ? models.primary : models.fallback;

    // This slot's own view: the round's messages plus whatever repair exchange it
    // accumulates. A fresh copy per slot, so a fallback that is reached is never
    // handed the primary's rejected calls to be confused by.
    const slotMessages = [...messages];

    for (let repair = 0; repair <= MAX_REPAIR_ATTEMPTS; repair += 1) {
      // Both slots draw on the one `args.budget`, which each attempt reads on entry
      // and charges as it works. A fallback attempt is spend, not a free retry —
      // and so is a repair.
      const outcome = await attempt(args, control, model, system, slotMessages);

      if (!outcome.ok) {
        errors.push(outcome.error);
        const { rejected } = outcome;
        diagnostics.push(
          rejected
            ? `${slot} (${modelId}, attempt ${repair + 1}): ${String(outcome.error)}`
            : `${slot} (${modelId}): ${String(outcome.error)}`
        );
        console.warn(
          rejected
            ? "[turn] control call rejected"
            : "[turn] model attempt failed",
          {
            taskId,
            round,
            model: modelId,
            ...(rejected ? { tool: rejected.toolName, repair } : {}),
            error: String(outcome.error)
          }
        );

        // No rejected call means no ending to correct — the attempt produced
        // nothing, which is the failure the fallback slot exists for.
        //
        // Otherwise repair, while this slot has both attempts and turns left. Past
        // the allowance every attempt gets `stepAllowance`'s one-step floor, which
        // is enough to reach an ending but not to reconsider one — so retrying
        // there buys a worse call at a real cost.
        if (
          rejected &&
          repair < MAX_REPAIR_ATTEMPTS &&
          args.budget.spent < args.budget.allowance
        ) {
          slotMessages.push(
            ...repairExchange(
              `${controlCallId(taskId, round)}:repair:${repair}`,
              rejected,
              outcome.error
            )
          );
          continue;
        }
        break;
      }

      if (outcome.decision.kind === "reply") {
        // A throw here is a storage fault: it propagates so the step retries.
        const reply = await appendOnce(
          session,
          deterministicSessionMessage(
            finalReplyMessageId(taskId),
            "assistant",
            outcome.decision.text
          )
        );
        return { status: "replied", reply };
      }

      const stored = await appendOnce(
        session,
        deterministicSessionMessage(
          roundAckMessageId(taskId, round),
          "assistant",
          outcome.decision.reply
        )
      );
      return {
        status: "delegated",
        reply: stored,
        drafts: outcome.decision.drafts
      };
    }
  }

  // A transient fault is not a decision failure — let the step retry rather than
  // failing the user's Task over Workers-AI capacity.
  const transient = errors.find((e) => isTransientAiError(e));
  if (transient) throw transient;

  const detail = `round ${round} exhausted both models — ${diagnostics.join("; ")}`;

  // Both models failed deterministically. Any branch results behind us are durable
  // and useful; deliver them joined rather than failing a Task whose work is done.
  if (branches.some((b) => b.status === "completed")) {
    console.warn("[turn] falling back to deterministic join", {
      taskId,
      round
    });
    const reply = await appendOnce(
      session,
      deterministicSessionMessage(
        finalReplyMessageId(taskId),
        "assistant",
        joinSuccessfulBranches(branches)
      )
    );
    return { status: "replied", reply };
  }

  return { status: "failed", error: detail };
}
