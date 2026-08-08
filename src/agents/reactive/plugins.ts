import type { AgentPlugin } from "@loopingai/core";
import { browser } from "@loopingai/plugins/browser";
import { recall } from "@loopingai/plugins/recall";
import { workspace } from "@loopingai/plugins/workspace";
import { RECALL, SLIDES } from "@/config";
import type { PluginHost } from "@loopingai/core/host";
import { general } from "./general";
import { slides } from "./slides";

/**
 * The one file you edit to add or remove a capability for this agent.
 *
 * Delete a line and that module leaves the bundle entirely. Nothing in core
 * imports a plugin, and `@loopingai/plugins` has no root barrel — the bare
 * specifier does not resolve — so the guarantee is structural rather than a
 * tree-shaker's opinion. `npm run verify:isolation` asserts it on the built graph.
 *
 * Each agent in this Worker has its own copy of this file, which is what keeps
 * arc-agi out of the proactive agent's graph. There is deliberately no shared
 * one: a single list would put every plugin in every agent.
 */

export const plugins = (host: PluginHost<Env>): AgentPlugin[] => [
  // The catch-all, first: order here is the order the delegating model is shown
  // the types, and it should read the general case before the specialized ones.
  general(),

  // Read web pages. Requires the `BROWSER` binding and a paid Workers plan.
  browser({ binding: host.env.BROWSER }),

  // Design slide decks, render them to PDF, and deliver a link. Written in this
  // repo rather than installed — like `general` above — because a recipe must
  // declare its own soul, and what a deck should look like is this agent's
  // opinion. Shares the `BROWSER` binding: rendering is `browserPdf` over
  // self-contained HTML, so there is no slides library in the bundle.
  slides({
    bucket: host.env.BUCKET,
    browser: host.env.BROWSER,
    storage: host.storage,
    baseUrl: host.env.PUBLIC_BASE_URL,
    // For `deck_review`'s own vision-model call — the deck's only reviewer, and
    // necessarily a plugin-owned call: the round loop's primary model is
    // text-only. The gateway id is the host's resolved one, so review calls sit
    // beside the agent's in one gateway.
    ai: host.env.AI,
    aiGatewayId: host.aiGatewayId,
    ...SLIDES
  }),

  // The durable file store behind every subagent execution's workspace, plus
  // tools over it. At most one installed plugin may back a workspace; drop this
  // and core falls back to an in-memory one, so `runtime.workspaceBacking` is
  // always defined and the SubagentRuntime never needs a null check.
  workspace(),

  // Episodic memory: the messages each compaction folds away are embedded into
  // Vectorize and searchable afterwards. Wired to the session through
  // `runtime.onMessagesDisplaced` — see `agent.ts`.
  recall({
    ai: host.env.AI,
    index: host.env.VECTORIZE,
    namespace: host.callerKey,
    // The host's *resolved* gateway id, so embedding calls are correlated with
    // chat calls. Spread the rest: enumerating each field silently drops any
    // option the plugin adds later.
    aiGatewayId: host.aiGatewayId,
    ...RECALL
  })
];
