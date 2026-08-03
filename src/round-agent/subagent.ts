import {
  createAgentRuntime,
  type AgentPlugin,
  type CoreConfigOverrides
} from "@loopingai/core";
import { createModelRuntime } from "@loopingai/core/agent";
import {
  RecipeSubagentBase,
  type SubagentRuntime
} from "@loopingai/core/subagent";
import type { PluginHost } from "@/plugin-host";

/**
 * The managed child that executes one Subtask under a resolved Recipe.
 *
 * Core ships `RecipeSubagentBase` with the whole body — resumable chunks, the
 * terminal-result cache keyed by request fingerprint, workspace wiring,
 * cancellation, the fingerprint-mismatch contract. All that is missing is the
 * host half, and a Durable Object class is constructed by the runtime, so it
 * cannot take constructor arguments. The abstract `subagentRuntime()` is that one
 * seam.
 *
 * ## Why the facet builds its own runtime instead of asking its parent
 *
 * The obvious move is to read it off the parent, which already has one. It does
 * not work: the SDK reaches a parent through `this.parentAgent(Cls)`, which is an
 * **RPC stub**, and a `SubagentRuntime` is mostly functions — `models`, the
 * `toolFamilies` builder map, `workspaceBacking`. None of that survives
 * serialization, so the call would return a shape that type-checks and is inert.
 *
 * So each agent gets its own facet class over this base, building the same
 * runtime from the same `plugins.ts` its parent uses. Two named subclasses rather
 * than one factory-produced class, because the framework resolves a facet through
 * `ctx.exports[this.constructor.name]` — an anonymous class breaks that lookup,
 * and so does a bundler that minifies class names.
 *
 * ## Not a bound Durable Object
 *
 * A facet is created beneath its calling agent, so it needs no wrangler binding
 * and no `new_sqlite_classes` entry — only an export from the Worker entry so
 * `ctx.exports` can resolve it. It *does* need a test-only binding; see the
 * comment in `vitest.config.ts`.
 */
/**
 * A concrete facet class, as `subAgent()` requires one.
 *
 * `StarterSubagentBase` is abstract, and `subAgent()` rightly refuses an abstract
 * class — it is what constructs one. So the seam on the agent side is typed as
 * this: any of the named subclasses below it.
 */
export type SubagentClass = new (
  ...args: ConstructorParameters<typeof RecipeSubagentBase<Env>>
) => RecipeSubagentBase<Env>;

export abstract class StarterSubagentBase extends RecipeSubagentBase<Env> {
  private _rt?: SubagentRuntime;

  /** This facet's agent config — the same object its parent DO passes. */
  protected abstract agentConfig(): CoreConfigOverrides;

  /** This facet's plugins — the same list its parent DO installs. */
  protected abstract agentPlugins(host: PluginHost): AgentPlugin[];

  /**
   * Built once per facet instance. The base calls this per RPC and documents
   * that an implementation building anything expensive should memoize its own.
   */
  protected subagentRuntime(): SubagentRuntime {
    return (this._rt ??= this.buildRuntime());
  }

  private buildRuntime(): SubagentRuntime {
    const config = this.agentConfig();
    const models = {
      primary: config.model?.chatModelId ?? "",
      fallback: config.model?.fallbackChatModelId ?? ""
    };
    const runtime = createAgentRuntime({
      config,
      plugins: this.agentPlugins({
        env: this.env,
        storage: this.ctx.storage,
        // No caller identity exists down here, and nothing reads one: the
        // per-caller hooks (`/recall`'s archive and its main-agent tool) are the
        // parent's surface, never a subagent's. A throwing thunk is the honest
        // encoding — it can only fire if a plugin starts reading caller state on
        // the execution path, which is a design question, not a missing value.
        callerKey: () => {
          throw new Error(
            "a subagent execution has no caller identity — this plugin reads " +
              "per-caller state on a path where none exists"
          );
        },
        primaryModelId: models.primary,
        fallbackModelId: models.fallback
      }),
      env: this.env
    });

    return {
      policy: runtime.policy,
      types: runtime.types,
      models: createModelRuntime({
        ai: this.env.AI,
        config: runtime.config.model
      }),
      toolFamilies: runtime.toolFamilies,
      toolOutputWindow: runtime.config.toolOutputWindow,
      maxOutputTokens: runtime.config.model.maxOutputTokens,
      // Always defined: the plugin that declared a backend, or core's in-memory
      // fallback. So this needs no null check.
      workspaceBacking: runtime.workspaceBacking
    };
  }
}
