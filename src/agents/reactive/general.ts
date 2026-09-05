import { definePlugin, type AgentPlugin } from "@dynamicagents/core";
import { WORKSPACE_FAMILY } from "@dynamicagents/plugins/workspace";
import { BROWSER_FAMILY } from "@dynamicagents/plugins/browser";

/**
 * The `general` subtask type — a plugin this repo writes rather than installs.
 *
 * Worth reading as the example it is: a plugin is not a package, it is an object
 * satisfying a contract, and `definePlugin` is available to your app for exactly
 * this. Nothing here imports from `@dynamicagents/plugins` except two family-name
 * constants, and nothing in core knows this type exists — it arrives through the
 * same `plugins()` array as the published ones and is indistinguishable from them
 * at the seam.
 *
 * It is also the reason there is no `@dynamicagents/plugins/general`. A house-default
 * subagent soul in a library is exactly what core refuses to have: `validateRecipe`
 * rejects a recipe with no soul rather than lending it one, so that no run ever
 * executes under an identity nobody chose. This is the identity *this* agent
 * chose, which makes the starter the right place for it.
 */

/**
 * The soul for the general recipe — the frozen identity of a managed Subtask
 * subagent with no domain of its own.
 *
 * Distinct from the main agent's soul in `./soul.ts`, and the distinction is
 * structural rather than stylistic: a subagent has no Session, no durable memory,
 * no recall, and no access to parent history beyond the references supplied
 * inline on its Subtask. Writing it as though it did is how a subagent ends up
 * asking a follow-up question nobody will ever read.
 */
export const GENERAL_SUBAGENT_SOUL = [
  "You are a stateless execution subagent. You are given a single, self-contained task with all necessary context supplied inline.",
  "Complete exactly that task and return a concise, direct result.",
  "Your result is raw material, not a reply: a parent agent composes it — often with other subagents' results — into the single answer the user actually sees. You are never speaking to the user. Return only the substance: no greeting, no preamble, no restating the task, no sign-off.",
  "You have no memory of past conversations and no access to any conversation beyond the references provided.",
  "Do not ask follow-up questions; work only from what you are given.",
  "Use your tools when they help, and never fabricate a tool result."
].join("\n");

/**
 * The catch-all: any self-contained unit of work with no domain of its own.
 *
 * Declared first in `plugins()` so the delegating model reads the catch-all
 * before the specialized types — order in that array is the order the model is
 * shown them, and it is the one thing this type's placement actually controls.
 */
export function general(): AgentPlugin {
  return definePlugin({
    key: "general",

    subtaskType: {
      key: "general",
      description:
        "Any self-contained piece of work: research, drafting, summarizing, reading a web page.",
      // No params: work with no domain has no ids to quote.
      params: null,
      recipe: {
        key: "general",
        version: 1,
        soul: GENERAL_SUBAGENT_SOUL,
        // Named families, not imported tools. `validateRecipe` drops any family
        // no installed plugin registered, so uninstalling `/browser` degrades
        // this recipe to a workspace-only subagent rather than breaking it — and
        // uninstalling both leaves a subagent that can still think and answer.
        toolFamilies: [BROWSER_FAMILY, WORKSPACE_FAMILY],
        enabled: true,
        // Nothing to override: work with no domain of its own has no reason to
        // want a different budget from the baseline.
        limits: {},
        // Comfortably above the turn budget, so a general run never prunes its
        // own context. Stated rather than defaulted — core requires it, because
        // how much context a domain needs is a property of the domain.
        historyWindow: 64,
        reportMetrics: false
      }
    }

    // No `capability` and no `delegationGuidance`. The catch-all needs no
    // introduction beyond its one-line description, and every line of prompt copy
    // is paid for on every round.
  });
}
