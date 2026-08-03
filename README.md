# looping-starter

**A working, deployable Looping agent on Cloudflare Workers.**

Zero-trust A2A, durable task lifecycle, delegation to isolated subagents, episodic
memory. Clone it, generate keys, deploy.

It ships **three example agents in one Worker** — grow the one you want, `rm -rf` the
rest. Adding or removing a capability is a single line.

> Part of a three-package split:
> [`@loopingai/core`](https://github.com/Looping-AI/looping-core) (the mandatory foundation) ·
> [`@loopingai/plugins`](https://github.com/Looping-AI/looping-plugins) (optional capabilities) ·
> **`looping-starter`** (this — a working agent that composes them).

---

## Quick start

```bash
npm install
npm run keygen          # one key for the deployment — see .dev.vars.example
npx wrangler vectorize create looping-starter-recall --dimensions=1024 --metric=cosine
npm run dev
```

Then set your secrets (`.dev.vars` locally, `wrangler secret put` deployed) and:

```bash
npm run deploy
```

Register each agent with your gateway using the **same endpoint** and its own
**tenant id**:

| endpoint                    | tenant id    |
| --------------------------- | ------------ |
| `https://<your-worker>/a2a` | `reactive`   |
| `https://<your-worker>/a2a` | `proactive`  |
| `https://<your-worker>/a2a` | `arc-player` |

> **Browser Rendering needs a paid Workers plan.** On the free tier, remove `browser()`
> from the agents' `plugins.ts` and the `browser` binding from `wrangler.jsonc`.

---

## One Worker, several agents

A Worker is not one agent. The three here are **tenants** of one deployment — one origin,
one endpoint, one signing key, one card ([`src/index.ts`](src/index.ts)):

```ts
createA2AWorker<Env>({
  manifest: hostManifest,
  tenants: {
    reactive: { manifest, resolveAgent, startTurn },
    proactive: { … },
    "arc-player": { … }
  }
});
```

```
/.well-known/agent-card.json   the stub card for the deployment
/.well-known/jwks.json         the one public key, verifying every card
/a2a                           every agent, picked by params.tenant
```

`AgentInterface.tenant` is the A2A mechanism for exactly this — _"an opaque string used for
routing requests to a specific agent or tenant when multiple agents are served behind a
single A2A endpoint"_ — and §8.3.2 requires a client to send the value the interface it
selected declared. A tenant is required on every request: there is no default agent and no
implicit routing.

### Why not a path prefix per agent

That is what this repo did first, and it cannot work. The AgentCard lives at a **well-known
URI**, which RFC 8615 defines per-authority, so only one card per origin is discoverable at
the path A2A registered with IANA. A gateway resolving `/.well-known/agent-card.json`
against the origin found whichever agent owned the bare path and pinned _its_ key for all
three — so the other two registered under a name and key that were not theirs, and their
push callbacks were rejected after the model work was already done.

So the card served there is a **stub** describing the deployment. Each agent's real card —
its name, skills and signature — comes from `GetExtendedAgentCard`, the spec's own
tenant-aware card method:

```jsonc
// POST /a2a
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "GetExtendedAgentCard",
  "params": { "tenant": "proactive" }
}
```

A card carries one interface entry and clients take the first, so the stub cannot list its
siblings — they are named in its `description` for a human, and registered out of band.

### One key, and what actually separates them

The three used to hold their own signing keys, which never bought anything: they share a
Worker and an `env`, so each could always read the others'. The card is per-origin and so
is the key.

What separates them is the gateway token's **tenant claim**, checked against the tenant the
request addressed. That is a real boundary — it is cryptographic, and it holds even though
all three share an audience. Without it `tenant` would be an unauthenticated field in the
request body, and a token minted for one agent would work against any sibling.

> **This needs a gateway that mints the tenant claim and registers agents with a tenant id**
> ([looping-gateway#62](https://github.com/Looping-AI/looping-gateway/pull/62)). The two
> sides do not interoperate across that change in either direction, so they deploy together
> and registered agents are re-registered.

---

## The three agents

| Agent                                   | What it is                                                              | Why it's here                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`reactive/`](src/agents/reactive/)     | Round loop, DAG delegation, wave scheduling, subagent execution         | The flagship                                                                                     |
| [`proactive/`](src/agents/proactive/)   | Sees every message, decides whether each is for it, answers in one turn | **The second consumer** — the only thing proving core isn't shaped around reactive's assumptions |
| [`arc-player/`](src/agents/arc-player/) | Plays ARC-AGI-3 games                                                   | Proves a domain plugin composes without touching anything shared                                 |

Reactive and arc-player share [`src/round-agent/`](src/round-agent/) — the loop, the DO
body, the workflow orchestration — and differ in five methods each. Proactive shares none
of it, which is the point: two genuinely different loop shapes on one core.

|             | reactive                                                  | proactive                            |
| ----------- | --------------------------------------------------------- | ------------------------------------ |
| bound by    | a mutable `TurnBudget` metered across rounds              | a flat `MAX_STEPS`                   |
| ends when   | the model calls a control tool (`toolChoice: "required"`) | the model stops, or calls `no_reply` |
| can decline | no — every round answers or delegates                     | yes, that is the point               |
| rounds      | many, driven by a Workflow                                | exactly one                          |

---

## The one file you edit

Each agent has its own `plugins.ts`. Delete a line and that module leaves the bundle
entirely:

```ts
// src/agents/reactive/plugins.ts
export const plugins = (host: PluginHost): AgentPlugin[] => [
  general({
    primaryModelId: host.primaryModelId,
    fallbackModelId: host.fallbackModelId
  }),
  browser({ binding: host.env.BROWSER }),
  workspace(),
  recall({
    ai: host.env.AI,
    index: host.env.VECTORIZE,
    namespace: host.callerKey
  })
];
```

Nothing in core imports a plugin, and `@loopingai/plugins` has no root barrel — the bare
specifier does not resolve — so the guarantee is structural rather than a tree-shaker's
opinion. `npm run verify:isolation` asserts it on the built module graph.

There is deliberately **no shared plugin list**: a single one would put every plugin in
every agent and make the guarantee unmeasurable.

`plugins` takes a host object rather than `env` because a plugin may need more than
bindings — `arcAgi` needs the DO's storage for its ledger, and `recall` needs the verified
caller as a **thunk**, since that identity does not exist yet when `onStart` runs.

### Writing your own

A plugin is not a package; it is an object satisfying a contract.
[`src/agents/reactive/general.ts`](src/agents/reactive/general.ts) is one this repo writes
rather than installs — the `general` catch-all subtask type, declared with `definePlugin`
and indistinguishable from a published plugin at the seam.

It is also _why_ there is no `@loopingai/plugins/general`: core's `validateRecipe` refuses
a recipe with no soul rather than lending it one, so that no run ever executes under an
identity nobody chose. That identity is yours to write.

---

## Delete what you don't want

Three edits, no leftovers. To drop `arc-player`:

1. `rm -rf src/agents/arc-player`
2. Remove its entry from `tenants` and its exports in [`src/index.ts`](src/index.ts)
3. In [`wrangler.jsonc`](wrangler.jsonc), remove the `ArcPlayerAgent` DO binding (and its
   `new_sqlite_classes` entry), the `ARC_HANDLE_TASK_WORKFLOW` workflow, and the
   `ARC_API_KEY` secret — but **not** `A2A_SIGNING_KEY`, which the whole deployment shares

Then drop its block from `scripts/verify-isolation.mjs`. Dropping `proactive` additionally
frees you to remove the `triage` plugin; dropping both round agents frees
`src/round-agent/` entirely.

---

## What runs in CI

```bash
npm run check              # wrangler types, prettier, eslint, tsc (src + test)
npm test                   # vitest, inside real workerd
npm run verify:isolation   # per-agent module graphs + size ceilings
npx wrangler deploy --dry-run --outdir dist
```

`verify:isolation` is the one that survives a refactor six months from now. This Worker
deploys as **one bundle containing all three agents**, so grepping `dist/` for "arc-agi"
would always find it and prove nothing. Instead each agent's entry is bundled on its own,
and esbuild's **metafile** — the exact list of modules in the graph, not a string search —
is checked for plugins that agent does not install:

```
✓ reactive:   4091 KiB (ceiling 4395 KiB), 468 modules, no cross-agent plugin
✓ proactive:  2555 KiB (ceiling 2832 KiB), 452 modules, no cross-agent plugin
✓ arc-player: 2987 KiB (ceiling 3223 KiB), 466 modules, no cross-agent plugin
```

It earns its keep: it caught a real leak during this repo's own construction, when the
shared base class still lived in `agents/reactive/` and arc-player extending it dragged
`/browser` and `/recall` into a graph that installs neither.

---

## Local development across the three repos

```bash
npm run link:local    # npm pack + tarball install from ../looping-core, ../looping-plugins
```

`npm pack` + tarball, deliberately — **not `npm link`**, which symlinks the checkout and
gives it its own copy of every peer. Two copies of `agents` in one Worker bundle breaks the
`Session` / `SessionMessage` types and every `instanceof`, at runtime rather than at the
type level. A tarball is what npm actually publishes, so if it works here it works from the
registry.

Nothing is written to `package.json`, so a plain `npm install` — and CI, which never runs
this — always builds against the real packages.

---

## Layout

```
src/
  index.ts              ← the tenant map: tenant id → agent
  host-manifest.ts      ← the stub card served at the well-known path
  config.ts             ← model ids, budgets, limits (values; core owns the shapes)
  plugin-host.ts        ← what a plugin may need from its host
  caller-context.ts     ← rendering of the verified gateway identity
  round-agent/          ← shared by reactive + arc-player: turn loop, DO body, workflow, subagent
  agents/
    reactive/           ← plugins, soul, manifest, the `general` plugin, thin subclasses
    proactive/          ← its own loop, DO, workflow, plugins, soul, manifest
    arc-player/         ← plugins, soul, manifest, thin subclasses
test/
scripts/
```

## License

[GPL-3.0-only](./LICENSE).
