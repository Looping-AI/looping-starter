import type { AgentManifest } from "@loopingai/core/a2a";

/**
 * The transport-independent half of this agent's AgentCard. `buildBaseCard` adds
 * `supportedInterfaces` (one entry: the deployment's shared `/a2a` url, tagged
 * with this agent's `proactive` tenant id) and the security scheme. Served only
 * via `GetExtendedAgentCard`, since the well-known path carries the deployment's
 * stub card.
 */
export const manifest: AgentManifest = {
  name: "Proactive Agent",
  description:
    "A channel-resident A2A agent. Sees every message, decides whether each one " +
    "is for it, and answers in a single turn — with a durable per-caller memory " +
    "(one continuous, self-compacting conversation).",
  version: "0.1.0",
  // `extensions` is a required (repeated) protobuf field in v1.0 — we declare no
  // protocol extensions, so it stays empty.
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "chat",
      name: "Chat",
      description:
        "Chat with the caller using a Workers-AI model, calling tools when useful.",
      tags: ["chat", "assistant"],
      examples: [],
      // Empty means "inherit the card's defaultInput/OutputModes".
      inputModes: [],
      outputModes: [],
      // Empty means "inherit the card-level requirement" (the gateway JWT).
      securityRequirements: []
    },
    {
      id: "triage",
      name: "Channel triage",
      description:
        "Read a busy shared channel and reply only when the message is genuinely for this agent.",
      tags: ["triage", "channel"],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: []
    },
    {
      id: "browse",
      name: "Browse the web",
      description:
        "Read and scrape live web pages — render a page as Markdown, extract structured data, or list its links.",
      tags: ["web", "browser"],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: []
    }
  ]
};
