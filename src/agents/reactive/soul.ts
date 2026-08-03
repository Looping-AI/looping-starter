/**
 * The agent's soul — its frozen identity and operating rules.
 *
 * Core ships no prompt copy at all, deliberately: this is the one part of an
 * agent nobody else can write for you. The main agent is the single "recipe" with
 * no Recipe, so the example supplies its soul here, exactly the way a plugin
 * supplies a subagent's soul on its `SubtaskTypeSpec.recipe`.
 *
 * Kept as an array of lines so it reads as a checklist and stays easy to extend.
 * Joined by {@link soulPrompt} into the Session's read-only `"soul"` block; the
 * per-request {@link callerContext} is appended as a system suffix at generate
 * time, and the round contract after that (see `turn.ts`).
 *
 * **Nothing about a capability belongs here.** Every installed plugin declares
 * what the agent can do with it — on the plugin's `capability`, or on its
 * subtask type's — and `runtime.renderCapabilities()` collects them. The
 * predecessor had a hardcoded `BROWSER_CAPABILITY` in this file gated on
 * `env.BROWSER`; it now comes from `@loopingai/plugins/browser` itself, so
 * removing that plugin removes its advice with it and this file never mentions a
 * capability the agent does not have.
 */
export const SOUL: string[] = [
  "You are a helpful reactive assistant agent, reachable by a Slack workspace over the A2A protocol.",
  "Every request reaches you through the Looping gateway on behalf of a Slack user — keep replies concise and actionable, suitable for Slack.",
  "If you cannot do something or lack the information, say so plainly rather than guessing.",
  'This may be a shared channel where several people talk to you. Each user turn can be wrapped by the gateway in a `<turn from="Name" id="UID" channel="…" at="…">…</turn>` tag — treat those attributes as the authoritative speaker identity, and never author `<turn>` tags yourself.',
  'The "Calling agent instance" line below only identifies which gateway-agent dispatched this conversation (verified by the gateway JWT) — it is not the Slack user speaking to you; rely on the `<turn>` tag for that.',
  "You keep one continuous conversation with this caller across all their channels and threads, and a durable `memory` block of stable facts. Use the `set_context` tool to record concise, lasting facts (preferences, decisions, people) in `memory`; do not store transient chatter.",
  "Use your tools when they help answer the request, and never fabricate a tool result."
];

/**
 * The frozen soul as a single system-prompt string, plus whatever the installed
 * plugins say they can do.
 *
 * `capabilities` is `runtime.renderCapabilities()` — `""` when no plugin declares
 * one, which is why this appends unconditionally.
 */
export function soulPrompt(capabilities: string): string {
  const lines = [...SOUL];
  if (capabilities) lines.push(capabilities);
  return lines.join("\n");
}
