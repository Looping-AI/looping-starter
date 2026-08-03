import { env } from "cloudflare:workers";
import { createA2AWorker } from "@loopingai/core/worker";
import {
  ignoreAlreadyExists,
  workflowIdForMessage,
  type AcceptedTurn
} from "@loopingai/core/a2a";

import { hostManifest } from "./host-manifest";
import { manifest as reactiveManifest } from "./agents/reactive/manifest";
import { manifest as proactiveManifest } from "./agents/proactive/manifest";
import { manifest as arcPlayerManifest } from "./agents/arc-player/manifest";

// Durable Objects and Workflows must be exported from the Worker entry so the
// runtime can resolve them by class name. `ReactiveSubagent` / `ArcPlayerSubagent`
// are **facets**: they need no wrangler binding and no `new_sqlite_classes` entry,
// only this export, so `ctx.exports` can find them.
export { ReactiveAgent } from "./agents/reactive/agent";
export { ReactiveSubagent } from "./agents/reactive/subagent";
export { HandleTaskWorkflow } from "./agents/reactive/workflow";
export { ProactiveAgent } from "./agents/proactive/agent";
export { NotifyTaskWorkflow } from "./agents/proactive/workflow";
export {
  ArcPlayerAgent,
  ArcHandleTaskWorkflow
} from "./agents/arc-player/agent";
export { ArcPlayerSubagent } from "./agents/arc-player/subagent";

import { getAgent as reactiveAgent } from "./agents/reactive/agent";
import { getAgent as proactiveAgent } from "./agents/proactive/agent";
import { getAgent as arcPlayerAgent } from "./agents/arc-player/agent";

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
 * is per-origin now and so is the key, which is simply honest about where the
 * boundary is — `A2A_SIGNING_KEY`, core's default, so no `secrets` option.
 *
 * What separates them is the gateway token's tenant claim, checked by core
 * against the tenant the request addressed. That is a real boundary: it is
 * cryptographic, and it holds even though all three share an audience.
 */

/** The workflow bindings a turn can be started on. */
type TurnWorkflow =
  "HANDLE_TASK_WORKFLOW" | "ARC_HANDLE_TASK_WORKFLOW" | "NOTIFY_WORKFLOW";

/**
 * Start a turn on one workflow binding, idempotently.
 *
 * The instance id is derived from the gateway's `messageId`, which is stable
 * across dispatch retries — so a retry finding its instance already running is
 * the idempotency working, not a failure. `ignoreAlreadyExists` swallows exactly
 * that race and rethrows everything else.
 */
function startOn(binding: TurnWorkflow) {
  return (turn: AcceptedTurn): Promise<void> =>
    ignoreAlreadyExists(() =>
      env[binding].create({
        id: workflowIdForMessage(turn.messageId),
        params: { ...turn }
      })
    );
}

/**
 * The agents, keyed by the tenant id a caller addresses them with.
 *
 * To remove one: delete its entry here, its `src/agents/<name>/` directory, and
 * its Durable Object and Workflow entries in `wrangler.jsonc`. Three edits, no
 * leftovers — and `npm run verify:isolation` proves the rest of the Worker never
 * depended on it.
 *
 * These ids are what a gateway registers against, so renaming one is a
 * re-registration, not a refactor.
 */
export default {
  fetch: createA2AWorker<Env>({
    manifest: hostManifest,
    tenants: {
      reactive: {
        manifest: reactiveManifest,
        // One DO instance per verified caller — what makes a task unreachable
        // from any other caller by construction. The tenant picks the agent;
        // this picks which instance of it.
        resolveAgent: reactiveAgent,
        startTurn: startOn("HANDLE_TASK_WORKFLOW")
      },
      proactive: {
        manifest: proactiveManifest,
        resolveAgent: proactiveAgent,
        startTurn: startOn("NOTIFY_WORKFLOW")
      },
      "arc-player": {
        manifest: arcPlayerManifest,
        resolveAgent: arcPlayerAgent,
        startTurn: startOn("ARC_HANDLE_TASK_WORKFLOW")
      }
    }
  })
} satisfies ExportedHandler<Env>;
