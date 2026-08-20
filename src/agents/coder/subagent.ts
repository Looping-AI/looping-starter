import type { AgentPlugin, CoreConfigOverrides } from "@loopingai/core";
import type { PluginHost } from "@loopingai/core/host";
import { RecipeSubagentHost } from "@loopingai/core/round";
import { CODER_CONFIG } from "@/config";
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
   * There is deliberately **no `modelRuntime` override here**, and that is worth
   * a note because there used to be one and its absence looks like an omission.
   *
   * The property that matters is that a facet runs the same provider as the
   * round that delegated to it: one left on a different provider would execute
   * every subtask on a different model, silently, since both satisfy
   * `ModelRuntime` and nothing downstream can tell them apart. That used to
   * require an override in both classes pointing at one shared factory, because
   * the parent was on Claude and core's default was not.
   *
   * Now that the coder runs core's Workers AI default like every other agent,
   * the same guarantee is had by *neither* class overriding the seam — which is
   * the stronger version of it: there is no second definition to drift.
   *
   * `agentConfig` still has to match the parent's, and does: both return
   * `CODER_CONFIG`, so the pair and the ceilings resolve identically on each
   * side.
   */
}
