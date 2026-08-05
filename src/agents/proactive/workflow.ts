import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  buildCompletedTask,
  buildFailedTask,
  buildNoReplyCompletedTask,
  createPushChannel,
  type GatewayIdentity
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
      signingKey: this.env.A2A_SIGNING_KEY
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
  const stub = deps.resolveAgent(p.identity);

  // A Task canceled before this workflow got going stops here, before a single
  // model call is billed. `markWorking` reports the cancellation itself rather
  // than being probed for it, so there is no window between asking and acting.
  const started = await step.do(
    "working",
    async () => (await stub.markWorking(p.taskId)) === "ok"
  );
  if (!started) return;

  // Generate the reply. Durable + retried; `converse` never rejects for a turn
  // failure — it reports one as `failed` — so a throw here is a genuine RPC
  // fault. The push context lets the DO stream intermediate `working` callbacks
  // live during generation; this step returns only how the turn ended.
  const outcome = await step.do("generate", async () => {
    const result = await stub.converse(p.text, p.identity, {
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
  const task =
    outcome.kind === "no_reply"
      ? buildNoReplyCompletedTask(p.taskId, p.contextId)
      : outcome.kind === "failed"
        ? buildFailedTask(p.taskId, p.contextId, outcome.text)
        : buildCompletedTask(p.taskId, p.contextId, outcome.text);

  // Persist the terminal task, unless the caller canceled it meanwhile.
  //
  // **The guarded write is the cancellation check.** `saveTask` refuses to write a
  // terminal state over a `canceled` row and says so, doing that read and write in
  // one synchronous pass inside the DO. Probing with `getTask` first and saving
  // second would leave a window — between the two calls, and again between this
  // step and `notify` — in which a `CancelTask` lands and the gateway still
  // receives a `completed` callback. Keying the notify on "did the write apply"
  // closes it.
  const saved = await step.do("complete", async () => stub.saveTask(task));
  if (!saved) return;

  // Notify the gateway: a card-key-signed callback POST. Retried by the step on a
  // non-2xx; the gateway is idempotent/single-use, so retries are safe. If it
  // ultimately fails, the gateway's own reaction backstop clears the pending
  // marker.
  //
  // Signed with the deployment's key. There is one: the card sits at a
  // well-known URI, which RFC 8615 defines per-authority, so this origin
  // publishes one card and the gateway pins one key for every agent on it.
  await step.do("notify", async () => {
    await createPushChannel(deps.signingKey, {
      taskId: p.taskId,
      contextId: p.contextId,
      pushUrl: p.pushUrl,
      pushToken: p.pushToken,
      jku: p.jku
    }).deliver(task);
  });
}
