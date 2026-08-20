import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { resolveConfig } from "@loopingai/core";
import { buildFailedTask, deliverTerminalTask } from "@loopingai/core/a2a";
import {
  runHandleTask,
  type HandleTaskParams,
  type NonRecoverableKind
} from "@loopingai/core/round";
import { CODER_CONFIG } from "@/config";
import { roundPolicy } from "@/round-policy";
import { coder } from "./definition";

/**
 * What an operator is told when a credential is refused.
 *
 * These are the only failures in this agent that no amount of retrying fixes and
 * that only a human can clear, so they get real words instead of a stack trace.
 * Kept next to the handler rather than in `round-policy.ts` because that file is
 * shared with the agents that have no credential of their own to reject.
 *
 * ## Most of this is now unreachable, and that is the honest thing to write
 *
 * `NonRecoverableKind` is core's, and it names the three authorities that can
 * sit between a round and a model: the provider, the AI Gateway, and an optional
 * intermediary between them. This agent used to have all three — Anthropic, the
 * gateway, and a proxy Worker holding the Anthropic credential.
 *
 * It now reaches Workers AI through the `AI` binding, which the platform
 * authenticates. There is no model credential in this Worker, and no
 * intermediary at all. So two of the four arms below describe a topology this
 * deployment no longer has, and the copy says so rather than sending an operator
 * to rotate a secret that does not exist.
 *
 * The `Record` stays total because core made it total on purpose: a kind added
 * upstream must fail to compile here rather than fall through to silence.
 */
const CREDENTIAL_COPY: Record<NonRecoverableKind, string> = {
  credential: [
    "I could not reach the model: the provider rejected the credential.",
    "",
    "That is unexpected here. This agent calls Workers AI through the `AI` binding, which Cloudflare authenticates for the Worker — there is no model API key in this deployment to expire or be revoked, so there is nothing for an operator to rotate.",
    "",
    "That makes this almost certainly a platform-side fault rather than a configuration one. Worth checking, in order:",
    "",
    "  1. The Cloudflare status page, for a Workers AI or AI Gateway incident.",
    "  2. Whether the account still has Workers AI enabled and is not past a billing limit.",
    "  3. `npm run cf -- ai --since 1h` — the gateway log records what the request actually returned.",
    "",
    "Then send this request again. Nothing was changed in the repository."
  ].join("\n"),

  "proxy-credential": [
    "I could not reach the model: something between this Worker and the provider rejected the request.",
    "",
    "This deployment has no such intermediary. The coder used to call Claude through a proxy Worker that held the Anthropic credential; that path was removed, and the agent now calls Workers AI through the `AI` binding directly.",
    "",
    "So this almost certainly means a stale deployment is still serving — an old version of this Worker, or a preview alias pointing at one. An operator should confirm what is actually deployed:",
    "",
    "    npx wrangler deployments list",
    "",
    "Then send this request again. Nothing was changed in the repository."
  ].join("\n"),

  "gateway-credential": [
    "I could not reach the model: the AI Gateway rejected the request before it got there.",
    "",
    "That is the gateway's own authentication, not the model's — the model never saw this request. It happens when the gateway has Authenticated Gateway switched on, because the `AI` binding does not send a gateway token.",
    "",
    "An operator has two options, and the first is usually right:",
    "",
    "  1. Turn Authenticated Gateway off for this gateway (AI Gateway → the gateway → Settings). Requests from the binding are already authenticated as this account's Worker.",
    "  2. Or point the agent at a different gateway by changing `aiGatewayId` in src/config.ts.",
    "",
    "Then send this request again. Nothing was changed in the repository."
  ].join("\n"),

  "unknown-credential": [
    "I could not reach the model: something on the path refused the request, and the response did not say which.",
    "",
    "There are two authorities left on this path, and it is one of them. Checking in order, cheapest first:",
    "",
    "  1. The AI Gateway — if Authenticated Gateway is on for this gateway, turn it off; the `AI` binding does not send a gateway token.",
    "  2. Workers AI itself — check the Cloudflare status page and that the account has Workers AI enabled and is within its limits.",
    "",
    "The gateway log is the fastest way to tell them apart, because it records the status the request actually came back with:",
    "",
    "    npm run cf -- ai --since 1h",
    "",
    "Then send this request again. Nothing was changed in the repository."
  ].join("\n")
};

/**
 * Turn an unrecoverable orchestration fault into a delivered failed Task.
 *
 * Deliberately the same delivery core would have done, not a second mechanism:
 * `deliverTerminalTask` performs the guarded write that doubles as the
 * cancellation check, so a Task the user canceled while the retries were burning
 * is still not overwritten with a failure.
 *
 * The words are `roundPolicy.copy.taskFailed` rather than anything sharper. The
 * distinctions `failureCopy` draws are about *which credential* was refused, and
 * reaching here means the round never got far enough to say — the diagnostic is
 * logged instead, which is where it belongs.
 *
 * A module-level function rather than a method for the reason core's
 * `runHandleTask` is one: workerd forbids constructing a `WorkflowEntrypoint`
 * outside the runtime, so anything left inside the class body cannot be driven
 * by a spec — and this path exists precisely because the untested one was the
 * one that broke.
 */
export async function deliverAbandonedTask(
  env: Env,
  params: HandleTaskParams,
  step: WorkflowStep,
  cause: unknown
): Promise<void> {
  console.error("[coder] task abandoned after retries were exhausted", {
    taskId: params.taskId,
    error: String(cause)
  });

  try {
    await deliverTerminalTask(step, {
      push: {
        taskId: params.taskId,
        contextId: params.contextId,
        pushUrl: params.pushUrl,
        pushToken: params.pushToken,
        jku: params.jku
      },
      signingKey: env.A2A_SIGNING_KEY,
      // Resolved inside each closure, never hoisted: a stub is a live connection
      // and a severed one never reconnects.
      saveTask: (task) =>
        coder.resolveAgent(env, params.identity).saveTask(task),
      terminal: () =>
        buildFailedTask(
          params.taskId,
          params.contextId,
          roundPolicy.copy.taskFailed
        ),
      // The Task is terminal either way, so its managed children are garbage
      // either way. `deliverTerminalTask` already treats this as best-effort.
      sweep: async () => {
        await coder
          .resolveAgent(env, params.identity)
          .sweepTaskChildren(params.taskId);
      }
    });
  } catch (deliveryFailed) {
    // Rethrow the *original* fault, not this one. Swallowing here would mark the
    // instance successful while the user got nothing — strictly worse than the
    // erroring instance we started with, because it would also be silent in the
    // Workflows console. `cause` is what an operator needs to see.
    console.error("[coder] could not deliver the failed Task", {
      taskId: params.taskId,
      error: String(deliveryFailed)
    });
    throw cause;
  }
}

/** The coder agent's task workflow: core's orchestration, its own binding. */
export class CoderWorkflow extends WorkflowEntrypoint<Env, HandleTaskParams> {
  /**
   * The catch is the whole reason `run` is not just the `runHandleTask` call.
   *
   * Core distinguishes two ways a round ends badly. A **typed** failure — both
   * models tried, nothing usable — returns `status: "failed"`, and core delivers
   * it: the user gets `roundPolicy.copy.taskFailed` or the credential words
   * below. A **transient** fault instead throws, so the step retries and
   * recovers from the durable rows without paying for a second inference. That
   * is the right default and nothing here changes it.
   *
   * What it does not cover is a transient fault that never stops being one.
   * `step.do` retries a bounded number of times and then rethrows, and there was
   * nothing above it to catch that: `runHandleTask` unwound, core's delivery
   * path was never reached, and the Workflow instance errored with the Task
   * still sitting in `working`. The user is told nothing at all — and because
   * the instance dies mid-`run`, the runtime records it as *"your Worker's code
   * had hung and would never generate a response"*, which reads like a bug in
   * this file rather than a provider that was refusing every request.
   *
   * Observed exactly that way on 2026-08-19: `turn:0-1` exhausted its four
   * attempts against a rate-limited Claude, and the coder simply went quiet.
   */
  async run(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<void> {
    try {
      await this.handle(event, step);
    } catch (err) {
      await deliverAbandonedTask(this.env, event.payload, step, err);
    }
  }

  /** The orchestration proper — every ordinary outcome ends inside here. */
  private async handle(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<void> {
    await runHandleTask(event.payload, step, {
      resolveAgent: (identity) => coder.resolveAgent(this.env, identity),
      config: resolveConfig(CODER_CONFIG),
      policy: roundPolicy,
      // Core owns the signal and the delivery — including the guarded write that
      // doubles as the cancellation check — and asks the host only for the
      // words. Which is the right split: this file knows what the secrets are
      // called and core cannot.
      //
      // Only the credential kinds get words here. `exhausted` means the models
      // were tried and could not do it, which is a thing that happened to one
      // request rather than a thing an operator can fix, and
      // `roundPolicy.copy.taskFailed` already says it — so it takes the
      // `undefined` fallback rather than a worse paraphrase.
      failureCopy: (kind, detail) => {
        if (kind === "exhausted") return undefined;
        console.error("[coder] credential refused", {
          taskId: event.payload.taskId,
          kind,
          detail
        });
        return CREDENTIAL_COPY[kind];
      },
      signingKey: this.env.A2A_SIGNING_KEY
    });
  }
}
