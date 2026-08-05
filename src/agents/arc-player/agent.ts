import type { AgentPlugin, CoreConfigOverrides } from "@loopingai/core";
import type { PluginHost } from "@loopingai/core/host";
import {
  RoundAgentBase,
  type RoundPolicy,
  type SubagentClass
} from "@loopingai/core/round";
import { ARC_PLAYER_CONFIG } from "@/config";
import { roundPolicy } from "@/round-policy";
import { plugins } from "./plugins";
import { soulPrompt } from "./soul";
import { ArcPlayerSubagent } from "./subagent";

/**
 * The arc-player: the same round loop as the reactive agent, a different soul, a
 * different plugin list. Nothing else.
 *
 * This is the example that tests whether the plugin contract is real. It reuses
 * `@loopingai/core/round` **unchanged** and adds a whole domain — a delegable
 * subtask type, a catalogue tool, a scorecard ledger, a leased external session —
 * by naming one plugin in `plugins.ts`. If it had needed a hook, a flag, or a
 * conditional anywhere in the shared code, the contract would be leaking.
 *
 * It is a separate Durable Object class because a wrangler binding maps to one
 * class and these need different configurations. That is the only reason.
 */
export class ArcPlayerAgent extends RoundAgentBase<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return ARC_PLAYER_CONFIG;
  }

  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return plugins(host);
  }

  protected agentSoul(capabilities: string): string {
    return soulPrompt(capabilities);
  }

  protected roundPolicy(): RoundPolicy {
    return roundPolicy;
  }

  protected subagentClass(): SubagentClass {
    return ArcPlayerSubagent;
  }
}
