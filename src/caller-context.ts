import type { GatewayIdentity } from "@loopingai/core/a2a";

/**
 * Per-request system-prompt suffix describing the verified calling gateway-agent
 * instance, from the gateway identity JWT.
 *
 * Shared by every agent, unlike a soul: this is not prompt copy expressing who an
 * agent *is*, it is a rendering of a protocol fact — who the gateway proved it
 * was — and that fact has one correct rendering. Two agents disagreeing about how
 * to describe their caller would be a bug, not a personality.
 *
 * **Advisory context only.** This is the calling *agent instance*, not the human
 * on the other end of it, so it must never be presented to the model as "who
 * you're talking to". Each agent's soul says so explicitly, and points the model
 * at the gateway's `<turn from="…">` wrapper for the actual speaker.
 */
export function callerContext(identity: GatewayIdentity): string {
  const label = identity.name ?? identity.key;
  if (!label) {
    return "\n\nCalling agent instance: unknown (the gateway did not include an agent identity).";
  }
  const withKind = identity.kind ? `${label} (${identity.kind})` : label;
  const lines = ["", "", `Calling agent instance: ${withKind}.`];
  if (identity.workspaceId != null) {
    lines.push(`Slack workspace: ${identity.workspaceId}.`);
  }
  return lines.join("\n");
}
