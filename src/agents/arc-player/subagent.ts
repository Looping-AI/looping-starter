import type { AgentPlugin, CoreConfigOverrides } from "@loopingai/core";
import { StarterSubagentBase } from "@/round-agent/subagent";
import { ARC_PLAYER_CONFIG } from "@/config";
import type { PluginHost } from "@/plugin-host";
import { plugins } from "./plugins";

/**
 * The arc-player's subagent facet — where a game is actually played.
 *
 * Its own class, and its own plugin list, so an execution here can reach the
 * `arc-game` tool family and the reactive agent's children cannot. The framework
 * resolves a facet by `this.constructor.name`, so this must stay a named, exported
 * class (and the bundler must keep class names — see `scripts/verify-isolation.mjs`).
 */
export class ArcPlayerSubagent extends StarterSubagentBase {
  protected agentConfig(): CoreConfigOverrides {
    return ARC_PLAYER_CONFIG;
  }

  protected agentPlugins(host: PluginHost): AgentPlugin[] {
    return plugins(host);
  }
}
