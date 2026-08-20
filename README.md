# looping-starter

**A working, deployable Looping agent on Cloudflare Workers.**

Zero-trust A2A, durable task lifecycle, delegation to isolated subagents, episodic
memory. Clone it, generate keys, deploy.

It ships **four example agents in one Worker** — grow the one you want, and
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
npm run keygen          # one key for the deployment — see .env.example
npx wrangler vectorize create looping-starter-recall --dimensions=1024 --metric=cosine
```

Put the key and `GATEWAY_ORIGINS` in `.env` before starting — the Worker reads both
on its first request ([`.env.example`](.env.example) documents every secret,
including the coder-only ones):

```bash
npm run dev
```

Wrangler loads `.env`, then `.env.local`, then — with `--env <name>` — `.env.<name>`
and `.env.<name>.local`, each overriding the last, so a staging deployment is
`.env.staging` rather than an edit to `wrangler.jsonc`. Everything but `.env.example`
is gitignored.

> One caveat: if a `.dev.vars` file exists it wins outright and none of the above is
> read. This project uses `.env`; keep a single file so there is never a question which
> one is live.

To ship, set the same secrets with `wrangler secret put` (or push the whole file with
`npx wrangler deploy --secrets-file .env`) and:

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
| `https://<your-worker>/a2a` | `coder`      |

`/a2a` is core's default, not a requirement — see [Where the endpoints
live](#where-the-endpoints-live). Register whatever path this deployment actually serves.

> **Browser Rendering needs a paid Workers plan.** On the free tier, remove `browser()`
> from the agents' `plugins.ts` and the `browser` binding from `wrangler.jsonc`.

> **The coder's container needs a paid plan and a running Docker daemon** — Docker
> Desktop on macOS and Windows, the Docker CLI alone on Linux. `npm run deploy` builds
> `./Dockerfile` on this machine. See [The coder needs two things the others do
> not](#the-coder-needs-two-things-the-others-do-not).

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

## The four agents

| Agent                                   | What it is                                                              | Why it's here                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`reactive/`](src/agents/reactive/)     | Round loop, DAG delegation, wave scheduling, subagent execution         | The flagship                                                                                     |
| [`proactive/`](src/agents/proactive/)   | Sees every message, decides whether each is for it, answers in one turn | **The second consumer** — the only thing proving core isn't shaped around reactive's assumptions |
| [`arc-player/`](src/agents/arc-player/) | Plays ARC-AGI-3 games                                                   | Proves a domain plugin composes without touching anything shared                                 |
| [`coder/`](src/agents/coder/)           | Clones a repo into a Linux sandbox, changes it, opens a pull request    | The only agent on a different model provider — proves `ModelRuntime` is a real seam              |

Reactive, arc-player and coder are all `RoundAgentBase` from
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

### The coder needs one thing the others do not

A **container**. Everything else about it — the round loop, the durable Subtask
DAG, the model pair — is what every other agent here runs, and that is a recent
simplification worth knowing about if you are reading older notes.

It used to run **Claude** rather than Workers AI, through an AI Gateway _custom
provider_ whose origin was a sibling Worker (`looping-anthropic-proxy`) holding
the Anthropic credentials. That whole path was removed on 2026-08-20. An
Anthropic **subscription** credential does not serve raw Messages API calls on
any frontier model — every Opus call came back `429` in ~10 ms at zero tokens,
Sonnet followed, and the only model that answered was Haiku 4.5, which rejects
the `output_config.effort` field the agent was built around. Holding two
credentials on separate accounts did not help: both refused the same request.

So the coder now runs `@cf/zai-org/glm-5.2` with `@cf/moonshotai/kimi-k2.7-code`
as its fallback, through the `AI` binding like everything else. What is left in
`src/config.ts` is one `CODER_MODEL` block that differs from the shared `MODEL`
in exactly one way — a 32k output ceiling instead of 16k, because a coding round
writes a file and a test in the same turn and a truncated patch reads as a
finished one.

There is **no model credential in this deployment**, for any agent. The `AI`
binding is authenticated by the platform. Nothing to store, nothing to rotate,
and the coder's container has never seen one.

The secrets that went away with that path were `ANTHROPIC_PROXY_ORIGIN` and
`AI_GATEWAY_TOKEN`; neither has a replacement. If a gateway `401` ever appears,
it means Authenticated Gateway is switched on for the gateway named by
`aiGatewayId` — switch it off, because the binding does not send a gateway token.
`CREDENTIAL_COPY` in `src/agents/coder/workflow.ts` says as much to the operator
at the moment it happens.
The container needs the **Workers Paid** plan and a running Docker daemon on the
machine that runs `wrangler deploy` — wrangler builds `./Dockerfile` locally and
pushes the image, so that is your laptop or your CI runner, never Cloudflare:

- **macOS and Windows** — install **Docker Desktop** and have it running. The
  `docker` CLI on its own is not enough: the build needs a Linux kernel, which is
  what Desktop's VM provides. (Anything else that exposes a daemon socket works —
  OrbStack, Colima, Rancher Desktop.)
- **Linux** — the Docker CLI and engine, and nothing else. No Desktop.

With no daemon reachable, `npx wrangler deploy --containers-rollout=none` deploys
the Worker and leaves the container alone.

#### The container is cached, not destroyed — but only while it is awake

The container is keyed on the **caller**, not the task, so a follow-up request
lands in a warm container with the checkout and its `node_modules` already there.
A cancelled task destroys it (a half-finished edit must not become the next task's
starting point); a completed one keeps it.

That warm start lasts exactly as long as the container stays awake. **There is no
cross-sleep cache, and adding an R2 bucket will not give you one.** The coder used
to snapshot `/workspace` to R2 between tasks, and it never succeeded once in
production: `@cloudflare/sandbox` mounts that archive _inside the container_ over
s3fs, so it needs R2 S3-API credentials (`CLOUDFLARE_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `BACKUP_BUCKET_NAME`) — a Workers R2
binding has no presign API and cannot supply them. Every task logged
`InvalidBackupConfigError`; the whole path was dead code with a bucket attached.

It was deleted rather than credentialed. What it cached is reproducible from git
and `npm ci`; what is genuinely _not_ reproducible is uncommitted work, and the
right home for that is a Durable-Object-backed workspace
(`@cloudflare/computer`, whose VFS is DO SQLite and needs no credential at all).
That is a substrate swap rather than a config change, and it is currently blocked
on one upstream gap — an `ignore` list reachable from `Workspace.pull()`, without
which a `pull()` after `npm ci` would drag tens of thousands of files into SQLite.

One consequence worth knowing before you debug something surprising: **a caller's
checkout outlives their task.** `repo_clone` therefore fetches and resets an
existing checkout rather than assuming an empty directory — and refuses outright
if the tree is dirty, because those changes are a previous task's work and nobody
could recover them once discarded.

`CoderSubagent.modelRuntime` must stay in step with `CoderAgent.modelRuntime`: a
facet left on the default would run every delegated subtask on a different model
than the round that delegated it, silently, because both satisfy `ModelRuntime`.
Which is why neither writes the provider out — both return `coderModels` from
`src/agents/coder/models.ts`, so there is nothing to keep in step.

Delegated subtasks reach the parent's container through
`code()`'s `resolveRuntime`, which runs on the parent and puts the container key
into the runtime state every tool family receives. That indirection is required,
not stylistic: core gives a subagent execution a `callerKey` thunk that
**throws**, so a facet cannot derive the key itself.

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
deploys as **one bundle containing all four agents**, so grepping `dist/` for "arc-agi"
would always find it and prove nothing. Instead each agent's entry is bundled on its own,
and esbuild's **metafile** — the exact list of modules in the graph, not a string search —
is checked for plugins that agent does not install:

```
✓ reactive: 3370 KiB (ceiling 3613 KiB), 465 modules, no cross-agent plugin
✓ proactive: 1557 KiB (ceiling 1709 KiB), 449 modules, no cross-agent plugin
✓ arc-player: 2866 KiB (ceiling 3223 KiB), 454 modules, no cross-agent plugin
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

The credentials go in `.cf.env`, not `.env`, because they are not bindings: they
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
    reactive/           ← definition, plugins, soul, manifest, the `general` plugin
    proactive/          ← its own loop + workflow, plus the same five files
    arc-player/         ← definition, plugins, soul, manifest, thin subclasses
test/
scripts/
```

## License

[GPL-3.0-only](./LICENSE).
