import { WorkflowEntrypoint, env } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { TaskState } from "@a2a-js/sdk";
import {
  buildCompletedTask,
  buildFailedTask,
  buildNoReplyCompletedTask,
  parsePrivateJwk,
  postNotification,
  signCallbackJwt,
  type GatewayIdentity
} from "@loopingai/core/a2a";
import { getAgent } from "./agent";

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

export class NotifyTaskWorkflow extends WorkflowEntrypoint<
  Env,
  NotifyTaskParams
> {
  async run(
    event: Readonly<WorkflowEvent<NotifyTaskParams>>,
    step: WorkflowStep
  ): Promise<void> {
    await runNotifyTask(event.payload, step);
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
  step: WorkflowStep
): Promise<void> {
  const stub = getAgent(p.identity);

  await step.do("working", async () => {
    await stub.markWorking(p.taskId);
  });

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
  const canceled = await step.do("complete", async () => {
    const current = await stub.getTask(p.taskId);
    if (current?.status.state === TaskState.TASK_STATE_CANCELED) return true;
    await stub.saveTask(task);
    return false;
  });
  if (canceled) return;

  // Notify the gateway: a card-key-signed callback POST. Retried by the step on a
  // non-2xx; the gateway is idempotent/single-use, so retries are safe. If it
  // ultimately fails, the gateway's own reaction backstop clears the pending
  // marker.
  //
  // Signed with *this agent's* key: three agents share this Worker, and the
  // gateway verifies each callback against the card it registered for that agent.
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
