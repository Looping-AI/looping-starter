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
 * The split is the whole point. There are **three** authorities between a round
 * and Claude — AI Gateway, the Anthropic proxy, and Anthropic itself — each
 * with its own credential, and all three answer `401`. Naming the wrong one
 * costs an operator a rotation of a secret that was working, and leaves the
 * broken one broken.
 *
 * Note that only two of the three are rotations at all. The proxy credential is
 * minted per request from `A2A_SIGNING_KEY`, and its `iss` is this Worker's own
 * origin as discovered from the request path rather than a secret, so when it is
 * refused the fault is upstream of any stored value — which is why that copy
 * sends an operator to look rather than to rotate.
 */
const CREDENTIAL_COPY: Record<NonRecoverableKind, string> = {
  credential: [
    "I could not reach Claude: it rejected the credential.",
    "",
    "Both of them, in fact — the proxy tries its fallback token whenever the primary is refused, so this means neither works. They live in the looping-anthropic-proxy Worker, not this one. An operator needs to mint new ones and redeploy the secrets from that repository:",
    "",
    "    claude setup-token",
    "    npx wrangler secret put ANTHROPIC_TOKEN_PRIMARY",
    "    claude setup-token",
    "    npx wrangler secret put ANTHROPIC_TOKEN_FALLBACK",
    "",
    "Paste each new token when prompted, then send this request again. Nothing was changed in the repository."
  ].join("\n"),

  "proxy-credential": [
    "I could not reach Claude: the Anthropic proxy rejected this Worker before the request got there.",
    "",
    "This one is not a token to rotate. The credential it refused is a short-lived token signed per request with A2A_SIGNING_KEY, so a rejection means the two Workers disagree about something rather than that a secret expired. Claude never saw this request, and its credentials are almost certainly fine.",
    "",
    "An operator should check, in this order:",
    "",
    "  1. The origin this Worker is reached on appears in CALLER_ORIGINS (the proxy). That is the origin serving its /.well-known/jwks.json — the one the gateway calls it at, which is a workers.dev or preview hostname if that is what was registered.",
    "  2. ANTHROPIC_PROXY_ORIGIN (this Worker) is the proxy's own public origin — the Base URL the gateway forwards to.",
    "  3. A2A_SIGNING_KEY was rotated here but the JWKS this Worker serves at /.well-known/jwks.json still serves the old public key.",
    "",
    "Then send this request again. Nothing was changed in the repository."
  ].join("\n"),

  "gateway-credential": [
    "I could not reach Claude: the AI Gateway rejected the request before it got there.",
    "",
    "That is the gateway's own token, not the Claude one — Claude never saw this request, so its credential is probably fine. An operator needs to mint a gateway token (AI Gateway → the gateway → Settings → Create authentication token) and redeploy the secret:",
    "",
    "    npx wrangler secret put AI_GATEWAY_TOKEN",
    "",
    "Then send this request again. Nothing was changed in the repository."
  ].join("\n"),

  "unknown-credential": [
    "I could not reach Claude: something on the path refused the request, and the response did not say which.",
    "",
    "There are three authorities involved and it is one of them. Checking in order, cheapest first:",
    "",
    "  1. The proxy — no rotation needed. Confirm the origin this Worker is reached on is in the proxy's CALLER_ORIGINS and that ANTHROPIC_PROXY_ORIGIN names the proxy's own origin.",
    "  2. The gateway:",
    "         npx wrangler secret put AI_GATEWAY_TOKEN    # AI Gateway → Settings → Create authentication token",
    "  3. Claude, from the looping-anthropic-proxy repository:",
    "         claude setup-token && npx wrangler secret put ANTHROPIC_TOKEN_PRIMARY",
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
