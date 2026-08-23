import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { CHUNK_STEP } from "@loopingai/core";
import {
  buildCompletedTask,
  buildFailedTask,
  buildNoReplyCompletedTask,
  deliverAbandonedTask,
  deliverTerminalTask,
  type GatewayIdentity,
  type TurnPushContext
} from "@loopingai/core/a2a";
import type { ProactiveAgent } from "./agent";
import { proactive } from "./definition";

/**
 * The proactive agent's async task controller.
 *
 * Compare `../reactive/workflow.ts`, which is a round loop with a DAG scheduler
 * inside it. This one is a straight line — accept, generate once, deliver — and
 * that is the whole difference between the two agents expressed as control flow.
 * Core ships neither; it ships the durable task lifecycle both deliver through.
 *
 * Why a Workflow rather than `waitUntil`: `step.do(...)` gives durable,
 * independently-retried steps that survive isolate eviction, so a generation that
 * outlives the request still calls back.
 *
 * Idempotency: the instance id is derived from the gateway's `messageId`
 * (deterministic across dispatch retries), so a re-dispatch never starts a second
 * run — `converse` executes exactly once.
 */
/**
 * What this agent tells a user when its retries run out.
 *
 * Its own string, and deliberately **not** `roundPolicy.copy.taskFailed`.
 * `round-policy.ts` says in its own docblock that it belongs to the two round
 * agents, and it value-imports `DELEGATE_TOOL_NAME` from
 * `@loopingai/core/subtasks` — so reaching for it here pulled the whole
 * delegation machinery into an agent that answers in one turn and pushed this
 * bundle 337 KiB over its ceiling. `npm run verify:isolation` caught it, which
 * is exactly what that ceiling is for.
 */
const ABANDONED_COPY =
  "I could not finish this — something on the way to the model kept failing " +
  "and did not recover. Nothing was changed. Sending the request again is " +
  "worth a try; if it keeps happening, an operator should check the logs for " +
  "this task id.";

export interface NotifyTaskParams {
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
 * What distinguishes one use of this controller from another — the same shape
 * `HandleTaskDeps` gives the round agents, for the same two reasons: a spec can
 * drive the orchestration against a fake stub, and a second agent could reuse the
 * body with a different resolver.
 *
 * Routing used to be a hardcoded `getAgent(p.identity)` here, which made the two
 * cancellation checks below untestable — a spec could not put the DO into the
 * states they exist to catch.
 */
export interface NotifyTaskDeps {
  /** Route to the agent DO for the verified caller. */
  resolveAgent: (
    identity: GatewayIdentity
  ) => DurableObjectStub<ProactiveAgent>;
  /** The deployment's Ed25519 private JWK, for the terminal callback. */
  signingKey: string;
  /**
   * What the user is told when the retries run out — see {@link runNotifyTask}.
   *
   * A dep rather than a constant because it is user-facing copy, and this
   * repository keeps that with the agent: core ships none, which is why
   * `deliverAbandonedTask` takes the words rather than inventing them.
   */
  abandonedCopy: string;
}

export class NotifyTaskWorkflow extends WorkflowEntrypoint<
  Env,
  NotifyTaskParams
> {
  async run(
    event: Readonly<WorkflowEvent<NotifyTaskParams>>,
    step: WorkflowStep
  ): Promise<void> {
    await runNotifyTask(event.payload, step, {
      resolveAgent: (identity) => proactive.resolveAgent(this.env, identity),
      signingKey: this.env.A2A_SIGNING_KEY,
      abandonedCopy: ABANDONED_COPY
    });
  }
}

/**
 * The orchestration itself, split from the `WorkflowEntrypoint` wiring so it can
 * be driven with a fake `step` in tests (workerd forbids constructing a
 * `WorkflowEntrypoint` outside the runtime). Reads env via the module-level
 * `cloudflare:workers` import rather than a parameter. Steps are named so retries
 * are durable and idempotent.
 */
export async function runNotifyTask(
  p: NotifyTaskParams,
  step: WorkflowStep,
  deps: NotifyTaskDeps
): Promise<void> {
  const push: TurnPushContext = {
    taskId: p.taskId,
    contextId: p.contextId,
    pushUrl: p.pushUrl,
    pushToken: p.pushToken,
    jku: p.jku
  };
  try {
    await generateAndDeliver(p, step, deps, push);
  } catch (cause) {
    // The same guard core puts inside `runHandleTask`, wired by hand because
    // this agent's orchestration is its own — a straight line, not a round loop.
    // Without it, a `generate` step that exhausts its retries unwinds past the
    // delivery below and leaves the Task in `working` with the user told
    // nothing, which has cost a production task before.
    await deliverAbandonedTask(step, cause, {
      push,
      signingKey: deps.signingKey,
      saveTask: (task) => deps.resolveAgent(p.identity).saveTask(task),
      text: deps.abandonedCopy,
      // No `sweep`: this agent delegates to nothing, so it has no managed
      // children to reclaim — the same reason the ordinary delivery omits one.
      label: "proactive"
    });
  }
}

/** The straight line itself: accept, generate once, deliver. */
async function generateAndDeliver(
  p: NotifyTaskParams,
  step: WorkflowStep,
  deps: NotifyTaskDeps,
  push: TurnPushContext
): Promise<void> {
  // Resolved **inside** each step body, never once up here. A stub is a live
  // connection; a severed one never reconnects, so a workflow that hoisted it
  // spent the rest of its retries talking to a socket that was already gone.
  const agent = () => deps.resolveAgent(p.identity);

  // A Task canceled before this workflow got going stops here, before a single
  // model call is billed. `markWorking` reports the cancellation itself rather
  // than being probed for it, so there is no window between asking and acting.
  const started = await step.do(
    "working",
    async () => (await agent().markWorking(p.taskId)) === "ok"
  );
  if (!started) return;

  // Generate the reply. Durable + retried; `converse` never rejects for a turn
  // failure — it reports one as `failed` — so a throw here is a genuine RPC
  // fault. The push context lets the DO stream intermediate `working` callbacks
  // live during generation; this step returns only how the turn ended.
  const outcome = await step.do("generate", CHUNK_STEP, async () => {
    const result = await agent().converse(p.text, p.identity, {
      taskId: p.taskId,
      contextId: p.contextId,
      pushUrl: p.pushUrl,
      pushToken: p.pushToken,
      jku: p.jku
    });
    // Projected onto a plain object literal: a DO RPC return carries a
    // `Disposable` brand whose symbol key a step result cannot serialize.
    return result.kind === "no_reply"
      ? { kind: result.kind }
      : { kind: result.kind, text: result.text };
  });

  // Three terminal shapes. A no-reply turn still completes and still calls back —
  // the gateway's pending row must resolve either way — it just carries no
  // message to post. A failed turn must call back as `failed`: A2A v1.0 has no
  // structured task error, so the terminal state is the only signal the gateway
  // has that the turn broke.
  //
  // The persist-then-notify pair is core's, and the guarded write inside it is
  // the cancellation check. No `sweep`: this agent delegates to nothing, so it
  // has no managed children to reclaim.
  await deliverTerminalTask(step, {
    push,
    // One key per deployment: the card sits at a well-known URI, which RFC 8615
    // defines per-authority, so this origin publishes one card and the gateway
    // pins one key for every agent on it.
    signingKey: deps.signingKey,
    saveTask: (task) => agent().saveTask(task),
    // Built inside the `complete` step by the helper. Building it out here would
    // re-stamp `new Date()` on every replay, so `notify` would post a Task that
    // differs from the one actually stored.
    terminal: () =>
      outcome.kind === "no_reply"
        ? buildNoReplyCompletedTask(p.taskId, p.contextId)
        : outcome.kind === "failed"
          ? buildFailedTask(p.taskId, p.contextId, outcome.text)
          : buildCompletedTask(p.taskId, p.contextId, outcome.text)
  });
}
