import { env } from "cloudflare:workers";
import type { AgentPlugin, CoreConfigOverrides } from "@loopingai/core";
import type { GatewayIdentity } from "@loopingai/core/a2a";
import { REACTIVE_CONFIG } from "@/config";
import type { PluginHost } from "@/plugin-host";
import { RoundAgentBase } from "@/round-agent/agent";
import type { SubagentClass } from "@/round-agent/subagent";
import { plugins } from "./plugins";
import { soulPrompt } from "./soul";
import { ReactiveSubagent } from "./subagent";

/**
 * The reactive agent: the flagship. Round loop, DAG delegation, wave scheduling,
 * subagent execution.
 *
 * All of which is `RoundAgentBase`. What is actually *this agent* is the five
 * methods below plus `./plugins.ts` and `./soul.ts` — and `../arc-player/agent.ts`
 * is the same five methods with different answers. If adding a domain to an agent
 * needed more than that, the plugin contract would be wrong.
 */
export class ReactiveAgent extends RoundAgentBase {
  protected agentConfig(): CoreConfigOverrides {
    return REACTIVE_CONFIG;
  }

  protected agentPlugins(host: PluginHost): AgentPlugin[] {
    return plugins(host);
  }

  protected agentSoul(capabilities: string): string {
    return soulPrompt(capabilities);
  }

  protected subagentClass(): SubagentClass {
    return ReactiveSubagent;
  }
}

/**
 * Resolve the per-caller agent DO stub, keyed by the verified `identity.key`.
 * Pure routing — the DO's methods are honestly typed now that its `Task` returns
 * are `PlainTask`, so callers reach the agent directly with no cast.
 */
export function getAgent(
  identity: GatewayIdentity
): DurableObjectStub<ReactiveAgent> {
  if (!identity.key) {
    throw new Error("identity.key is required to route to the agent DO");
  }
  return env.ReactiveAgent.get(env.ReactiveAgent.idFromName(identity.key));
}
