import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { resolveConfig } from "@loopingai/core";
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
 * minted per request from `A2A_SIGNING_KEY`, so when it is refused the fault is
 * upstream of any stored secret — which is why that copy sends an operator to
 * look rather than to rotate.
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
    "  1. SELF_ORIGIN (this Worker) appears in CALLER_ORIGINS (the proxy).",
    "  2. ANTHROPIC_PROXY_AUDIENCE (this Worker) equals PROXY_AUDIENCE (the proxy).",
    "  3. A2A_SIGNING_KEY was rotated here but the JWKS at SELF_ORIGIN/.well-known/jwks.json still serves the old public key.",
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
    "  1. The proxy — no rotation needed. Confirm SELF_ORIGIN is in the proxy's CALLER_ORIGINS and that ANTHROPIC_PROXY_AUDIENCE matches its PROXY_AUDIENCE.",
    "  2. The gateway:",
    "         npx wrangler secret put AI_GATEWAY_TOKEN    # AI Gateway → Settings → Create authentication token",
    "  3. Claude, from the looping-anthropic-proxy repository:",
    "         claude setup-token && npx wrangler secret put ANTHROPIC_TOKEN_PRIMARY",
    "",
    "Then send this request again. Nothing was changed in the repository."
  ].join("\n")
};

/** The coder agent's task workflow: core's orchestration, its own binding. */
export class CoderWorkflow extends WorkflowEntrypoint<Env, HandleTaskParams> {
  async run(
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
