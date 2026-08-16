import type {
  AgentPlugin,
  CoreConfigOverrides,
  ModelConfig
} from "@loopingai/core";
import type { ModelRuntime } from "@loopingai/core/agent";
import type { PluginHost } from "@loopingai/core/host";
import { RecipeSubagentHost } from "@loopingai/core/round";
import { CODER_CONFIG } from "@/config";
import { coderModels } from "./models";
import { subagentPlugins } from "./plugins";

/**
 * The coder agent's subagent facet.
 *
 * Named and exported by design: the framework resolves a facet by
 * `this.constructor.name`. It needs no wrangler binding — only the export from
 * `src/index.ts` — but it does need a test-only one; see `vitest.config.ts`.
 */
export class CoderSubagent extends RecipeSubagentHost<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return CODER_CONFIG;
  }

  /**
   * The **subagent's** list, which is deliberately not its parent's.
   *
   * This is the half with hands: a full shell, a writer, an editor and a
   * browser — and no git, because the parent owns the history. The base class's
   * doc comment says "the same plugins as its parent", which was true of every
   * other agent here and is exactly what this one had to stop doing.
   */
  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return subagentPlugins(host);
  }

  /**
   * The same provider the parent runs on — literally the same function, from
   * `./models.ts`, which is what makes "the same" a fact rather than a promise.
   *
   * This override is not optional. A facet left on core's Workers AI default
   * would execute every delegated subtask on a different model than the round
   * that delegated it, and it would do so silently, because both satisfy
   * `ModelRuntime` and nothing downstream can tell them apart.
   */
  protected override modelRuntime(model: ModelConfig): ModelRuntime {
    return coderModels(this.env, model);
  }
}
