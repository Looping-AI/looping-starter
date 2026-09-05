import type { AgentManifest } from "@dynamicagents/core/a2a";

/**
 * The transport-independent half of this agent's AgentCard. `buildBaseCard` adds
 * `supportedInterfaces` (one entry: the deployment's shared `/a2a` url, tagged
 * with this agent's `arc-player` tenant id) and the security scheme. Served only
 * via `GetExtendedAgentCard`, since the well-known path carries the deployment's
 * stub card.
 */
export const manifest: AgentManifest = {
  name: "ARC-AGI Player",
  description:
    "Plays ARC-AGI-3 games. Delegates each play to an isolated subagent that " +
    "explores the level over a long, resumable run, then reports the score and " +
    "what the play established.",
  version: "0.1.0",
  // `extensions` is a required (repeated) protobuf field in v1.0 — we declare no
  // protocol extensions, so it stays empty.
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "play-arc-game",
      name: "Play an ARC-AGI-3 game",
      description:
        "Play a named ARC-AGI-3 game to completion and report its score, the mechanics confirmed, and what was left untested.",
      tags: ["arc-agi", "games", "reasoning"],
      examples: ["Play the ARC-AGI-3 game ls20.", "Play ft09 and vc33."],
      // Empty means "inherit the card's defaultInput/OutputModes".
      inputModes: [],
      outputModes: [],
      // Empty means "inherit the card-level requirement" (the gatekeeper JWT).
      securityRequirements: []
    },
    {
      id: "list-arc-games",
      name: "List available games",
      description:
        "List the ARC-AGI-3 games available to play, with their exact ids.",
      tags: ["arc-agi", "catalogue"],
      examples: ["Which ARC games can you play?"],
      inputModes: [],
      outputModes: [],
      securityRequirements: []
    }
  ]
};
