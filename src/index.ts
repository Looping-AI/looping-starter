import { createA2AWorker } from "@loopingai/core/worker";

import { hostManifest } from "./host-manifest";
import { reactive } from "./agents/reactive/definition";
import { proactive } from "./agents/proactive/definition";
import { arcPlayer } from "./agents/arc-player/definition";
import { serveDeck } from "./agents/reactive/slides/route";

// Durable Objects and Workflows must be exported from the Worker entry so the
// runtime can resolve them by class name. `ReactiveSubagent` / `ArcPlayerSubagent`
// are **facets**: they need no wrangler binding and no `new_sqlite_classes` entry,
// only this export, so `ctx.exports` can find them.
export { ReactiveAgent } from "./agents/reactive/agent";
export { ReactiveSubagent } from "./agents/reactive/subagent";
export { HandleTaskWorkflow } from "./agents/reactive/workflow";
export { ProactiveAgent } from "./agents/proactive/agent";
export { NotifyTaskWorkflow } from "./agents/proactive/workflow";
export { ArcPlayerAgent } from "./agents/arc-player/agent";
export { ArcPlayerSubagent } from "./agents/arc-player/subagent";
export { ArcHandleTaskWorkflow } from "./agents/arc-player/workflow";

/**
 * One Worker, three agents, addressed by A2A `tenant`.
 *
 * They share one origin, one endpoint, one signing key and one card:
 *
 * ```
 * /.well-known/agent-card.json   the stub card for the deployment
 * /.well-known/jwks.json         the one public key, verifying every card
 * /a2a                           every agent, picked by params.tenant
 * ```
 *
 * Each agent is one `defineAgent` call in its own `definition.ts` — tenant id,
 * card, Durable Object, Workflow. That declaration is what is mounted here *and*
 * what the agent's Workflow resolves its DO stub from, so the two can never
 * address different objects. Adding an agent is one file plus a line below plus
 * its wrangler bindings; `npm run agent:new <tenant>` does all of it.
 *
 * ## Why not a path prefix per agent
 *
 * That is what this used to do, and it cannot work. The AgentCard lives at a
 * **well-known URI**, which RFC 8615 defines per-authority, so only one card per
 * origin is discoverable at the path A2A registered with IANA. A gateway
 * resolving `/.well-known/agent-card.json` against the origin found whichever
 * agent owned the bare path and pinned *its* key for all three — so the other
 * two registered under a name and key that were not theirs, and their push
 * callbacks were rejected after the model work was already done.
 *
 * `AgentInterface.tenant` is the protocol's own answer: "an opaque string used
 * for routing requests to a specific agent or tenant when multiple agents are
 * served behind a single A2A endpoint". Each agent's real card comes from
 * `GetExtendedAgentCard`, and every request names its tenant — there is no
 * default and no implicit routing.
 *
 * ## One signing key
 *
 * The three used to hold their own, which never bought anything: they share a
 * Worker and an `env`, so each could always read the others' secrets. The card
 * is per-origin now and so is the key — `A2A_SIGNING_KEY`, core's default.
 *
 * What separates them is the gateway token's tenant claim, checked by core
 * against the tenant the request addressed. That is a real boundary: it is
 * cryptographic, and it holds even though all three share an audience.
 */
/**
 * The A2A surface: three routes, and the only thing a gateway ever talks to.
 * A plain `(request, env) => Promise<Response>`, so it composes.
 */
const a2a = createA2AWorker<Env>({
  manifest: hostManifest,
  agents: [reactive, proactive, arcPlayer]
});

/**
 * One route sits in front of it: `GET /d/<deckId>.pdf`, which serves a deck the
 * reactive agent rendered.
 *
 * It is a *public* route by design — the link is handed to a Slack user, who
 * opens it in a browser with no gateway token — so it cannot live behind the A2A
 * handler's authentication. `serveDeck` returns `null` for anything it does not
 * recognise, so A2A is reached unchanged and the ordering is not load-bearing in
 * either direction. See `agents/reactive/slides/route.ts` for what authorizes it.
 */
export default {
  async fetch(request, env) {
    return (await serveDeck(request, env.BUCKET)) ?? a2a(request, env);
  }
} satisfies ExportedHandler<Env>;
