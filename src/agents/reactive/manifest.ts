import type { AgentManifest } from "@loopingai/core/a2a";

/**
 * The transport-independent half of this agent's AgentCard — everything that does
 * not depend on the request origin. `buildBaseCard` adds `supportedInterfaces`
 * (one entry: the deployment's shared `/a2a` url, tagged with this agent's tenant
 * id) and the security scheme. Served only via `GetExtendedAgentCard`, since the
 * well-known path carries the deployment's stub card.
 *
 * `AgentManifest` is core's, derived from the SDK's `AgentCard` rather than
 * hand-declared, so a protocol field that gains a requirement fails the build
 * here instead of silently going unadvertised.
 */
export const manifest: AgentManifest = {
  name: "Reactive Agent",
  description:
    "A delegating A2A agent. Verifies the gateway identity JWT, then answers the " +
    "caller via a Workers-AI round loop — handing work to isolated subagents when " +
    "it helps — with a durable per-caller memory (one continuous, self-compacting " +
    "conversation).",
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
      // Empty means "inherit the card's defaultInput/OutputModes"; every skill
      // here is plain text like the agent as a whole.
      inputModes: [],
      outputModes: [],
      // Empty means "inherit the card-level requirement" (the gateway JWT).
      securityRequirements: []
    },
    {
      id: "delegate",
      name: "Research and long-running work",
      description:
        "Break a request into concurrent subtasks run by isolated subagents, then compose their results into one answer.",
      tags: ["research", "delegation"],
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
