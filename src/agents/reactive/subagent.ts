import type { AgentPlugin, CoreConfigOverrides } from "@loopingai/core";
import { StarterSubagentBase } from "@/round-agent/subagent";
import { REACTIVE_CONFIG } from "@/config";
import type { PluginHost } from "@/plugin-host";
import { plugins } from "./plugins";

/**
 * The reactive agent's subagent facet.
 *
 * Named, exported, and trivial by design: the framework resolves a facet by
 * `this.constructor.name`, and the only thing that distinguishes one agent's
 * children from another's is which plugins they can reach. Everything else is
 * `StarterSubagentBase`.
 */
export class ReactiveSubagent extends StarterSubagentBase {
  protected agentConfig(): CoreConfigOverrides {
    return REACTIVE_CONFIG;
  }

  protected agentPlugins(host: PluginHost): AgentPlugin[] {
    return plugins(host);
  }
}
