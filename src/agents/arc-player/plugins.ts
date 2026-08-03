import type { AgentPlugin } from "@loopingai/core";
import { arcAgi } from "@loopingai/plugins/arc-agi";
import { workspace } from "@loopingai/plugins/workspace";
import type { PluginHost } from "@/plugin-host";

/**
 * The arc-player's capabilities. Two lines, and that is the whole example.
 *
 * Everything the main agent will be told about ARC — what it can do, and how to
 * build a `delegate` payload for a play — is declared by the plugin on its
 * subtask type, and rendered by `runtime.renderCapabilities()` and
 * `types.renderDelegationGuidance()`. So nothing in this repo names a scorecard,
 * a guid, or a game. If adding a domain to an agent needed more than this, the
 * plugin contract would be wrong.
 *
 * No `/browser` and no `/recall`: this agent plays games, and neither reading web
 * pages nor searching archived conversation has anything to do with that. That is
 * also what makes the isolation check meaningful — the reactive agent's graph
 * carries both and no arc-agi, this one the reverse.
 */
export const plugins = (host: PluginHost): AgentPlugin[] => [
  arcAgi({
    apiKey: host.env.ARC_API_KEY,
    // The DO's own storage, for the `arc_scorecards` ledger. The plugin declares
    // the table through its `PluginStore`; `AgentDB` runs the DDL at DO start.
    storage: host.storage,
    // A play is a long sequence of cheap spatial decisions, not conversation, so
    // it could reasonably run on a different pair. Passing the agent's own keeps
    // one model story for this example — and `validateRecipe` would substitute
    // them anyway, since a recipe may only name models in the host's allowlist.
    primaryModelId: host.primaryModelId,
    fallbackModelId: host.fallbackModelId
  }),

  // A play accumulates notes across chunks — what the level looks like, which
  // mechanics are confirmed — and the workspace is where they live. Without a
  // backend core falls back to an in-memory one, which an eviction mid-play would
  // silently empty.
  workspace()
];
