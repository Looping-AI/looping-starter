import { env } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import { MAX_CHUNKS_PER_BRANCH, type CoreConfig } from "@loopingai/core";
import {
  buildCompletedTask,
  buildFailedTask,
  parsePrivateJwk,
  postNotification,
  signCallbackJwt,
  type GatewayIdentity
} from "@loopingai/core/a2a";
import { selectWave, type SubtaskId } from "@loopingai/core/subtasks";
import type { RoundAgentBase, TurnPushContext } from "./agent";
import type { RoundMode } from "./turn";

/**
 * The async task controller. The gateway does not wait for a synchronous reply:
 * the Worker accepts a turn (returns a `submitted` Task) and hands the actual work
 * to this durable Workflow, which orchestrates it end to end and delivers the
 * reply to the gateway's push-notification webhook.
 *
 * The shape is a **round loop**, not a fixed sequence of phases:
 *
 * 0. **Pre-work** — resolve the caller's agent, mark the Task working.
 * 1. **Round** — one main-agent inference that either answers the user (the Task
 *    is done) or delegates durable Subtasks plus the acknowledgment the user sees
 *    while they run.
 * 2. **Execute** — a delegating round's Subtask DAG runs in waves, every
 *    dependency-ready node concurrently, each in an isolated managed subagent.
 *    Then the loop returns to 1, where the model sees the results and decides
 *    again — answer, or delegate once more.
 * 3. **Deliver** — persist the terminal Task, then POST a signed callback.
 *
 * The main agent is never forced either way. A round that has run out of budget —
 * `mainAgentLimits`, in turns or in wall clock — is handed no tools but the
 * answer, so it has to give one; every other round chooses. That is the whole
 * reason this file is a loop, and the whole termination argument.
 *
 * Why a Workflow (not a DO alarm or `waitUntil`): `step.do(...)` gives durable,
 * independently-retried steps that survive isolate eviction, and a future
 * `escalate` decision (ask the human, then continue) slots in cleanly as another
 * branch of the loop built on `step.waitForEvent(...)`.
 *
 * A Workflow is a separate entrypoint and cannot touch the agent DO's SQLite
 * directly, so: the task inputs travel as the workflow **payload**, and the agent
 * runtime plus task state are reached only through **native DO RPC**.
 *
 * Idempotency: the instance id is derived from the gateway's `messageId`
 * (deterministic across dispatch retries), so a re-dispatch never starts a second
 * run. Within a run, every step is re-runnable: the Subtask rows and the Session
 * are the source of truth, and each round recovers from them rather than
 * re-inferring.
 */
export interface HandleTaskParams {
  /** The accepted task id (echoed back to the gateway on the callback). */
  taskId: string;
  /** The user turn text to answer. */
  text: string;
  /** The verified calling gateway-agent identity (keys the DO + the Session). */
  identity: GatewayIdentity;
  /** A2A context id, echoed on the completed Task. */
  contextId: string;
  /** Gateway push-notification webhook (also the callback JWT `aud`). */
  pushUrl: string;
  /** Per-task validation token the gateway set; echoed in the callback header. */
  pushToken: string;
  /** This agent's card-signing JWKS URL — the callback JWT `jku` (pinned key). */
  jku: string;
}

/**
 * What distinguishes one agent's use of this loop from another's.
 *
 * The whole body below is agent-agnostic — it names no soul, no plugin and no
 * model. Reactive and arc-player differ only in these three values, which is why
 * they share one workflow body behind two thin entrypoints rather than two copies
 * of a 250-line orchestration.
 */
export interface HandleTaskDeps {
  /** Route to the right DO class for the verified caller. */
  resolveAgent: (identity: GatewayIdentity) => AgentStub;
  /** Resolved config — the loop reads `mainAgentLimits` and `maxSubtasks`. */
  config: CoreConfig;
}

/** User-facing text on a failed Task. Core ships no copy; the diagnostic is logged. */
export const TASK_FAILED_TEXT =
  "Sorry — something went wrong handling that request.";

/**
 * The caller's agent DO stub — every phase runs through it.
 *
 * Typed on the abstract base rather than a concrete class: the orchestration
 * below calls only methods the base declares, and both round agents' stubs
 * satisfy it. Naming one of them here is what would make this file a sibling
 * import for the other.
 */
type AgentStub = DurableObjectStub<RoundAgentBase>;

/**
 * The orchestration itself, split from the `WorkflowEntrypoint` wiring so it can
 * be driven with a fake `step` in tests (workerd forbids constructing a
 * `WorkflowEntrypoint` outside the runtime) — and so a second agent can reuse it
 * with different deps.
 *
 * Every `step.do` return here is a small projection — a status, an id, a reply.
 * Never a Subtask row: a step return is capped at 1 MiB and a Subtask carries
 * verbatim history snapshots, so the rows stay in the DO and the Workflow carries
 * references to them.
 *
 * **Step names are durable cache keys.** Everything inside the round loop carries
 * its round for that reason: `turn:<round>`, `deadline:<round>`,
 * `scan:<round>:<wave>`, `cancel:<round>:<wave>`. Renaming one silently re-runs
 * its effect on replay.
 */
export async function runHandleTask(
  p: HandleTaskParams,
  step: WorkflowStep,
  deps: HandleTaskDeps
): Promise<void> {
  const limits = deps.config.mainAgentLimits;
  // Pre-work. Routing is pure, so it needs no step of its own.
  const stub = deps.resolveAgent(p.identity);
  const push: TurnPushContext = {
    taskId: p.taskId,
    contextId: p.contextId,
    pushUrl: p.pushUrl,
    pushToken: p.pushToken,
    jku: p.jku
  };

  const started = await step.do(
    "working",
    async () => (await stub.markWorking(p.taskId)) === "ok"
  );
  if (!started) return;

  // Main-agent turns spent so far, across every round. Summed from cached step
  // returns, so a replay reconstructs the identical number and the `mode` input
  // below stays deterministic.
  let turnsUsed = 0;

  // The Task's own start, in a step so replays read the original instant rather
  // than restarting the clock — otherwise a Workflow that retried its way through
  // the night would never observe the deadline it had long since passed.
  //
  // When escalation lands, this is the line that needs care: a Task suspended on
  // `step.waitForEvent(...)` must **rebase** it on resume, or a human's thinking
  // time is charged to the agent and a Task that asked a question is dead before
  // the answer arrives. `turnsUsed` needs no such handling — waiting costs none.
  const startedAtMs = await step.do("started", async () => Date.now());

  // At most one round per turn of the budget, **plus one**: an `open` round always
  // spends at least one turn, so `maxTurns` of them exhaust the budget — and the
  // forced-answer round that follows needs an iteration of its own to happen in.
  // Off by one here and a Task of cheap rounds would fall out of the loop with no
  // reply instead of being made to give one.
  for (let round = 0; round <= limits.maxTurns; round++) {
    // The clock is read *inside a step* so its answer is cached with the round:
    // `mode` is a step input, and a replay that re-read `Date.now()` would
    // reconstruct a different one. Time is the budget a Task can spend without
    // spending the other — a round waiting on slow subtasks moves it while
    // `turnsUsed` does not.
    const overdue = await step.do(
      `deadline:${round}`,
      async () => Date.now() - startedAtMs >= limits.maxWallMs
    );

    // Out of turns or out of time ⇒ this round gets no tools at all and must
    // answer. Not a failure mode: it is how a ceiling returns the work instead of
    // dropping it.
    const mode: RoundMode =
      turnsUsed >= limits.maxTurns || overdue ? "final" : "open";
    if (mode === "final") {
      // Worth its own line: from the outside, a round the budget ended is
      // indistinguishable from a model that simply chose to answer.
      console.warn("[handle-task] task budget spent, forcing an answer", {
        taskId: p.taskId,
        round,
        turnsUsed,
        overdue
      });
    }

    // The main agent decides. `runTaskTurn` persists whatever the round produced
    // — a final reply, or the Subtask rows plus the acknowledgment it already
    // pushed — so this step returns only the verdict plus what it cost. A typed
    // `failed` is a real outcome (both models produced unusable output, with no
    // durable work to fall back on) and routes to failed delivery; a transient
    // fault throws and the step retries, recovering from the durable rows with no
    // second inference.
    const turn = await step.do(`turn:${round}`, async () => {
      // Projected to a plain object: an RPC return carries a `Disposable` brand a
      // step result cannot serialize. Every branch must carry `turns` — a field
      // this projection drops is a field the budget never sees.
      const result = await stub.runTaskTurn({
        taskId: p.taskId,
        text: p.text,
        identity: p.identity,
        round,
        mode,
        turnsRemaining: limits.maxTurns - turnsUsed,
        push
      });
      if (result.status === "replied")
        return {
          status: result.status,
          reply: result.reply,
          turns: result.turns
        };
      if (result.status === "failed")
        return {
          status: result.status,
          error: result.error,
          turns: result.turns
        };
      return { status: result.status, turns: result.turns };
    });

    turnsUsed += turn.turns;

    if (turn.status === "canceled") return;
    if (turn.status === "failed") {
      console.error("[handle-task] round failed", {
        taskId: p.taskId,
        round,
        error: turn.error
      });
      await deliver(p, step, stub, null);
      return;
    }
    if (turn.status === "replied") {
      await deliver(p, step, stub, turn.reply);
      return;
    }

    // Delegated: run this round's DAG, then loop and let the model decide again.
    const executed = await executeDag(p, step, stub, round, push, deps);
    if (executed === "canceled") return;
    if (executed === "stuck") {
      await deliver(p, step, stub, null);
      return;
    }
  }

  // Unreachable: a `final` round is handed only `final_reply`, so it either
  // answers or fails, and both return above. Reaching here means a round
  // delegated with no turns left to do it with.
  console.error("[handle-task] round budget exhausted without a reply", {
    taskId: p.taskId
  });
  await deliver(p, step, stub, null);
}

/**
 * How one round's DAG ended. `stuck` is an invariant violation — see `selectWave`.
 *
 * No chunk count: chunks are not a budget. What a branch may spend is bounded by
 * its own Recipe's turns and wall clock, and `MAX_CHUNKS_PER_BRANCH` is only a
 * platform backstop.
 */
type DagOutcome = "done" | "canceled" | "stuck";

/**
 * Drive one round's Subtask DAG to termination, one wave at a time.
 *
 * Bounded by `maxSubtasks + 1` iterations rather than looping until `done`: a
 * wave that reports `ready` always retires at least one active node, so N
 * Subtasks need at most N waves of work plus one final scan to observe `done`.
 * Exhausting the budget means the DAG stopped making progress, which is the same
 * corruption `stuck` names.
 *
 * Every step name carries the round, because step names are durable cache keys:
 * two rounds of the same Task reusing `scan:0` would replay the first round's
 * cached answer into the second.
 */
async function executeDag(
  p: HandleTaskParams,
  step: WorkflowStep,
  stub: AgentStub,
  round: number,
  push: TurnPushContext,
  deps: HandleTaskDeps
): Promise<DagOutcome> {
  for (let wave = 0; wave <= deps.config.maxSubtasks; wave++) {
    // One durable step per wave: `skipBlockedSubtasks` reports cancellation,
    // propagates skips past any branch that just failed, and returns the
    // refreshed DAG projection — one round trip, one consistent answer.
    const scan = await step.do(`scan:${round}:${wave}`, async () => {
      const result = await stub.skipBlockedSubtasks(p.taskId, round);
      return result.canceled
        ? { canceled: true as const, nodes: [] }
        : { canceled: false as const, nodes: result.nodes };
    });

    if (scan.canceled) {
      await step.do(`cancel:${round}:${wave}`, async () => {
        await stub.cancelPendingSubtasks(p.taskId);
      });
      return "canceled";
    }

    const decision = selectWave(scan.nodes);
    if (decision.kind === "done") return "done";
    if (decision.kind === "stuck") {
      console.error("[handle-task] subtask DAG made no progress", {
        taskId: p.taskId,
        round,
        wave,
        active: decision.active
      });
      return "stuck";
    }

    // Every dependency-ready node runs concurrently — the per-round Subtask
    // maximum is the only fan-out bound. `runBranch` never rejects, so a single
    // branch cannot fast-fail `Promise.all` and strand its siblings' durable
    // results.
    await Promise.all(
      decision.ids.map((id) => runBranch(p, step, stub, id, push))
    );
  }

  console.error("[handle-task] subtask DAG exceeded its wave budget", {
    taskId: p.taskId,
    round
  });
  return "stuck";
}

/**
 * Run one Subtask to termination as a sequence of durable **chunk** steps, and
 * make sure the row ends terminal either way.
 *
 * `executeSubtaskChunk(id, chunk)` advances one chunk: a single-chunk recipe is
 * `done` on chunk 0 (step `execute:<id>`); a long recipe yields `done: false` and
 * the loop runs the next chunk (`execute:<id>:chunk:<n>`) until it terminates.
 * Each chunk is its own retryable step, and the child resumes from its
 * checkpoint — so no step approaches the platform timeout.
 *
 * It resolves a deterministic branch failure into a `failed` row itself and
 * throws only on a transient fault (retry me) or a lifecycle bug. So a throw that
 * survives every retry — or a run that never terminates within the chunk budget —
 * means nobody is left to resolve this row: fail *the branch* and let the next
 * round disclose the gap, rather than discarding the durable work its siblings
 * finished.
 *
 * What bounds a branch is its Recipe's turns and wall clock, both enforced inside
 * the child, both ending in a report rather than a kill. `MAX_CHUNKS_PER_BRANCH`
 * is a platform backstop held unreachable by design, so the `failSubtask` below
 * should never fire — if it does, a Recipe has been given more turns than the cap
 * allows.
 *
 * Step ids are unique across rounds (SQLite assigns them), so these names need no
 * round prefix.
 */
async function runBranch(
  p: HandleTaskParams,
  step: WorkflowStep,
  stub: AgentStub,
  id: SubtaskId,
  push: TurnPushContext
): Promise<void> {
  try {
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_BRANCH; chunk++) {
      // Chunk 0 keeps the plain `execute:<id>` step name so single-chunk branches
      // replay identically; later chunks append `:chunk:<n>`.
      const stepName =
        chunk === 0 ? `execute:${id}` : `execute:${id}:chunk:${chunk}`;
      const done = await step.do(stepName, async () => {
        // The DO posts any progress itself; the step returns only the verdict.
        const outcome = await stub.executeSubtaskChunk(id, chunk, push);
        return outcome.done;
      });
      if (done) return;
    }
    // Unreachable while every Recipe's `maxTurns` stays under the cap: a chunk
    // that yields always advanced a turn, so the budget summary comes first.
    console.error("[handle-task] subtask exceeded its chunk budget", {
      taskId: p.taskId,
      subtaskId: id
    });
    await step.do(`fail:${id}`, async () => {
      await stub.failSubtask(
        id,
        `execution exceeded ${MAX_CHUNKS_PER_BRANCH} chunks`
      );
    });
  } catch (err) {
    console.error("[handle-task] subtask execution exhausted retries", {
      taskId: p.taskId,
      subtaskId: id,
      err: String(err)
    });
    await step.do(`fail:${id}`, async () => {
      await stub.failSubtask(id, `execution exhausted retries: ${String(err)}`);
    });
  }
}

/**
 * Persist the terminal Task, then notify the gateway. A null `reply` delivers a
 * `failed` Task with user-safe text; the diagnostic is already logged.
 *
 * The Task is built **inside** the step and returned, so `notify` posts exactly
 * what was persisted: building it in the body would re-stamp `new Date()` on
 * every replay and post a Task that differs from the stored one.
 *
 * **The guarded write is the cancellation check.** `saveTask` refuses to write a
 * terminal state over a `canceled` row and says so, and it does that read and
 * write in one synchronous pass inside the DO. Probing first and saving second
 * would leave a window — between the two calls, and again between this step and
 * `notify` — in which a `tasks/cancel` lands and the gateway still receives a
 * `completed` callback. Keying the notify on "did the write apply" closes it.
 */
async function deliver(
  p: HandleTaskParams,
  step: WorkflowStep,
  stub: AgentStub,
  reply: string | null
): Promise<void> {
  const task = await step.do("complete", async () => {
    const terminal =
      reply !== null
        ? buildCompletedTask(p.taskId, p.contextId, reply)
        : buildFailedTask(p.taskId, p.contextId, TASK_FAILED_TEXT);
    return (await stub.saveTask(terminal)) ? terminal : null;
  });
  if (!task) return;

  // Sweep this Task's managed children now that it is terminal and every `execute`
  // step has unwound. Deleting them here — rather than right after each successful
  // chunk — keeps `deleteSubAgent`'s facet-abort from landing on a still-open
  // `executeChunk` RPC, which telemetry mis-records as a failure. Best-effort and
  // idempotent, so it is safe on replay.
  await step.do("sweep", async () => {
    await stub.sweepTaskChildren(p.taskId);
  });

  // Notify the gateway: a card-key-signed callback POST. Retried by the step on a
  // non-2xx; the terminal messageId is deterministic and the gateway is
  // idempotent/single-use, so retries are safe. If it ultimately fails, the
  // gateway's own reaction backstop clears the pending marker.
  //
  // Signed with the deployment's key. There is one: the card sits at a
  // well-known URI, which RFC 8615 defines per-authority, so this origin
  // publishes one card and the gateway pins one key for every agent on it.
  await step.do("notify", async () => {
    const jwt = await signCallbackJwt(parsePrivateJwk(env.A2A_SIGNING_KEY), {
      jku: p.jku,
      aud: p.pushUrl
    });
    const res = await postNotification(p.pushUrl, p.pushToken, jwt, task);
    if (!res.ok) {
      throw new Error(`gateway notification failed: HTTP ${res.status}`);
    }
  });
}
