# looping-starter

**A working, deployable Looping agent on Cloudflare Workers.**

Zero-trust A2A, durable task lifecycle, delegation to isolated subagents, episodic
memory. Clone it, generate keys, deploy.

It ships **three example agents in one Worker** — grow the one you want, and
`npm run agent:remove` the rest. Adding or removing a capability is a single line.

Everything here is an _example_. The round loop, the durable Subtask DAG, the
subagent execution and the task lifecycle all live in `@loopingai/core`, so this
repo is the ~250 lines per agent that are actually yours: plugins, soul, manifest,
config, and the round contract.

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
```

Put the key and `GATEWAY_ORIGINS` in `.dev.vars` before starting — the Worker reads both
on its first request ([`.dev.vars.example`](.dev.vars.example) lists all three secrets):

```bash
npm run dev
```

To ship, set the same secrets with `wrangler secret put` and:

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

`/a2a` is core's default, not a requirement — see [Where the endpoints
live](#where-the-endpoints-live). Register whatever path this deployment actually serves.

> **Browser Rendering needs a paid Workers plan.** Two plugins use it: `browser()` reads
> web pages with it, and `slides()` renders decks to PDF with it. On the free tier, remove
> **both** from `src/agents/reactive/plugins.ts` (and `browser()` from arc-player's), then
> the `browser` binding from `wrangler.jsonc`. Dropping only one leaves the binding
> required.

> **`slides()` also needs an R2 bucket and your public origin.** Create the bucket with
> `wrangler r2 bucket create looping-files`, and set `PUBLIC_BASE_URL` to the origin this
> Worker is deployed at (`wrangler secret put PUBLIC_BASE_URL` in production, `.dev.vars`
> locally). That is what deck links are built from, and a Durable Object has no request to
> read an origin off.

---

## One Worker, several agents

A Worker is not one agent. The three here are **tenants** of one deployment — one origin,
one endpoint, one signing key, one card ([`src/index.ts`](src/index.ts)):

```ts
// src/agents/reactive/definition.ts — declared once
export const reactive = defineAgent({
  tenant: "reactive",
  manifest,
  agent: (env: Env) => env.ReactiveAgent,
  workflow: (env: Env) => env.HANDLE_TASK_WORKFLOW
});

// src/index.ts — mounted
createA2AWorker<Env>({
  manifest: hostManifest,
  agents: [reactive, proactive, arcPlayer]
});
```

That same declaration is what the agent's Workflow resolves its DO stub from, so
the tenant and the workflow can never address different Durable Objects — a
mismatch that used to type-check perfectly and surface as a task that never
called back.

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

### Where the endpoints live

Only the **first** of those three paths is fixed, for the reason the next section gives:
it is a well-known URI, so core matches it by suffix and you cannot move it. The other two
are defaults, and both are options on `createA2AWorker`:

```ts
createA2AWorker<Env>({
  manifest: hostManifest,
  tenants: { … },
  rpcPath: "/rpc",                     // default "/a2a"
  jwksPath: "/.well-known/keys.json"   // default "/.well-known/jwks.json"
});
```

Nothing else has to be told. The cards' `supportedInterfaces[0].url` is built as
`${origin}${rpcPath}`, each card's `jku` points at `jwksPath`, and the gateway-token
`audience` defaults to that same `${origin}${rpcPath}` — so the path served, the path
advertised, and the audience tokens must be minted for stay in step by construction.

What does _not_ follow automatically is the **gateway's registration**, which has to name
the endpoint this deployment actually serves: that URL is the `aud` its tokens carry. Change
`rpcPath` on an already-registered agent and every request 401s until it is re-registered.

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
// POST /a2a  (whatever `rpcPath` serves)
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
> ([looping-gateway#62](https://github.com/Looping-AI/looping-gateway/pull/62)), on the
> `loopingai.org` claim namespace
> ([#68](https://github.com/Looping-AI/looping-gateway/pull/68)). Both are required: a
> gateway with the first but not the second mints `https://looping.ai/tenant`, core reads
> `https://loopingai.org/tenant`, and every request 401s on the empty-tenant comparison. The
> two sides do not interoperate across either change in either direction, so they deploy
> together and registered agents are re-registered.

---

## The three agents

| Agent                                   | What it is                                                              | Why it's here                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`reactive/`](src/agents/reactive/)     | Round loop, DAG delegation, wave scheduling, subagent execution         | The flagship                                                                                     |
| [`proactive/`](src/agents/proactive/)   | Sees every message, decides whether each is for it, answers in one turn | **The second consumer** — the only thing proving core isn't shaped around reactive's assumptions |
| [`arc-player/`](src/agents/arc-player/) | Plays ARC-AGI-3 games                                                   | Proves a domain plugin composes without touching anything shared                                 |

Reactive and arc-player are both `RoundAgentBase` from
[`@loopingai/core/round`](https://github.com/Looping-AI/looping-core) and differ in five
methods each. Proactive extends `LoopingAgent` directly and writes its own loop — it
imports no part of `/round` at all, and `npm run verify:isolation` asserts that on the
built graph. Two genuinely different loop shapes on one core.

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
  slides({
    bucket: host.env.BUCKET,
    browser: host.env.BROWSER,
    storage: host.storage,
    baseUrl: host.env.PUBLIC_BASE_URL
  }),
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

## Add or delete an agent

One command each.

```bash
npm run agent:new demo                 # a delegating round agent
npm run agent:new watcher --kind single  # a single-turn agent, its own loop
npm run agent:remove arc-player
```

Each edits the four places an agent exists — its directory, [`src/index.ts`](src/index.ts),
[`wrangler.jsonc`](wrangler.jsonc) (DO binding, sqlite migration, workflow binding), and
[`scripts/verify-isolation.mjs`](scripts/verify-isolation.mjs) — then runs prettier over
what it touched. `agent:new` then tells you the two things it cannot decide for you: the
config entry and the agent's soul.

This used to be documented as "three edits, no leftovers". It was five, they were not
adjacent, and a missed one failed at a different time each: a forgotten DO binding at
deploy, a forgotten `new_sqlite_classes` entry at the first request, a forgotten
isolation entry _never_ — it just quietly stopped checking that agent.

Add-then-remove returns all four files byte-for-byte to where they started, which is
the test that keeps this honest.

> The signing key and `GATEWAY_ORIGINS` are **not** removed: they belong to the
> deployment, not to any one agent. A secret only one agent's plugins needed —
> `ARC_API_KEY` — is yours to drop.

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
✓ reactive: 3433 KiB (ceiling 3613 KiB), 482 modules, no cross-agent plugin
✓ proactive: 1558 KiB (ceiling 1709 KiB), 454 modules, no cross-agent plugin
✓ arc-player: 2865 KiB (ceiling 3223 KiB), 459 modules, no cross-agent plugin
```

Proactive's `forbidden` list carries `@loopingai/core/dist/round/` as well as the
plugins its siblings install. That is the strongest line in the file: core ships the
whole delegating loop behind an opt-in subpath, and an agent that answers in one turn
must not pay a byte for it. It is also why proactive is ~1.5 MiB rather than ~2.5.

(Sizes move with every dependency bump; the ceilings are what CI enforces.)

It earns its keep: it caught a real leak during this repo's own construction, when the
shared base class still lived in `agents/reactive/` and arc-player extending it dragged
`/browser` and `/recall` into a graph that installs neither.

---

## Looking at a running deployment

```bash
cp .cf.env.example .cf.env    # an account-scoped API token + your account id
npm run cf -- logs --since 2h --level error
npm run cf -- wf handle-task
npm run cf -- ai --since 2h
```

[`scripts/cf.mjs`](scripts/cf.mjs) is a small Cloudflare API proxy for the three questions
a deploy actually raises: what did it log, did the workflow finish its steps, and what did
the model get asked. Each subcommand prints a digest rather than the raw envelope — `logs`
a level-tallied timeline, `wf <name> <instance>` per-step pass/fail, `ai <logId>` the
prompt and reply as text — with `--json` or `--raw` when you want the body. This Worker's
workflows are `handle-task`, `arc-handle-task` and `notify-task`.

The credentials go in `.cf.env`, not `.dev.vars`, because they are not bindings: they
authenticate **you** to the Cloudflare API, not the Worker to anything. Keeping them in
their own file also keeps the token off wrangler's dotenv path, so it is never loaded into
the Worker's env or uploaded as a secret. The script reads the file itself and holds the
token in memory — it never becomes an argv, so it stays out of your shell history and out
of an agent's context, and it is redacted from the output as a safety net.

Anything the subcommands don't cover falls through to a raw request:

```bash
npm run cf -- GET workflows -q per_page=50
npm run cf -- help
```

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

`--no-save` protects the manifest, not the lockfile: npm can still pin both packages to
`file:/var/folders/…/looping-pack-*.tgz`, and those paths do not exist on a CI runner — or
on your machine once the temp dir is cleaned. The script now detects that and restores
`package-lock.json` itself, so the damage no longer lands on whoever pulls next.

---

## Layout

```
src/
  index.ts              ← the agents this Worker mounts
  host-manifest.ts      ← the stub card served at the well-known path
  config.ts             ← model ids, budgets, limits (values; core owns the shapes)
  round-policy.ts       ← the round contract + user-facing copy (core ships no prompt copy)
  agents/
    reactive/           ← definition, plugins, soul, manifest, the `general` and `slides` plugins
    proactive/          ← its own loop + workflow, plus the same five files
    arc-player/         ← definition, plugins, soul, manifest, thin subclasses
test/
scripts/
```

## License

[GPL-3.0-only](./LICENSE).
