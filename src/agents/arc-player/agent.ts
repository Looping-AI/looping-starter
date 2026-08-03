import { WorkflowEntrypoint, env } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  resolveConfig,
  type AgentPlugin,
  type CoreConfigOverrides
} from "@loopingai/core";
import type { GatewayIdentity } from "@loopingai/core/a2a";
import { ARC_PLAYER_CONFIG } from "@/config";
import type { PluginHost } from "@/plugin-host";
import { RoundAgentBase } from "@/round-agent/agent";
import type { SubagentClass } from "@/round-agent/subagent";
import { runHandleTask, type HandleTaskParams } from "@/round-agent/workflow";
import { plugins } from "./plugins";
import { soulPrompt } from "./soul";
import { ArcPlayerSubagent } from "./subagent";

/**
 * The arc-player: the same round loop as the reactive agent, a different soul, a
 * different plugin list. Nothing else.
 *
 * This is the example that tests whether the plugin contract is real. It reuses
 * `RoundAgentBase`, `turn.ts`, `runHandleTask` and the subagent base
 * **unchanged**, and adds a whole domain — a delegable subtask type, a catalogue
 * tool, a scorecard ledger, a leased external session — by naming one plugin in
 * `plugins.ts`. If it had needed a hook, a flag, or a conditional anywhere in the
 * shared code, the contract would be leaking; the four ARC-specific leaks the
 * predecessor had in its DO are exactly what the hooks on `AgentPlugin` replaced.
 *
 * It is a separate Durable Object class because a wrangler binding maps to one
 * class and these need different configurations. That is the only reason.
 */
export class ArcPlayerAgent extends RoundAgentBase {
  protected agentConfig(): CoreConfigOverrides {
    return ARC_PLAYER_CONFIG;
  }

  protected agentPlugins(host: PluginHost): AgentPlugin[] {
    return plugins(host);
  }

  protected agentSoul(capabilities: string): string {
    return soulPrompt(capabilities);
  }

  protected subagentClass(): SubagentClass {
    return ArcPlayerSubagent;
  }
}

/** Resolve the per-caller arc-player DO stub, keyed by the verified `identity.key`. */
export function getAgent(
  identity: GatewayIdentity
): DurableObjectStub<ArcPlayerAgent> {
  if (!identity.key) {
    throw new Error("identity.key is required to route to the agent DO");
  }
  return env.ArcPlayerAgent.get(env.ArcPlayerAgent.idFromName(identity.key));
}

/**
 * The arc-player's task workflow: the shared orchestration, its own binding.
 *
 * See `../reactive/workflow.ts` — the two are the same four lines with different
 * deps, which is the whole cost of a second round agent.
 */
export class ArcHandleTaskWorkflow extends WorkflowEntrypoint<
  Env,
  HandleTaskParams
> {
  async run(
    event: Readonly<WorkflowEvent<HandleTaskParams>>,
    step: WorkflowStep
  ): Promise<void> {
    await runHandleTask(event.payload, step, {
      resolveAgent: getAgent,
      config: resolveConfig(ARC_PLAYER_CONFIG)
    });
  }
}
