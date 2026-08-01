# looping-starter — plan

> Sibling repos: [`looping-core`](https://github.com/Looping-AI/looping-core) ·
> [`looping-plugins`](https://github.com/Looping-AI/looping-plugins)

## What this repo is

A working, deployable Looping agent on Cloudflare Workers, built on `@looping/core` and
`@looping/plugins`. It ships **three example implementations** — grow the one you want,
`rm -rf` the rest. Adding or removing a capability is a single line in `src/plugins.ts`.

It is also, deliberately, **the compatibility suite for the other two repos.** Both
predecessor repos (`proactive-agent`, `reactive-agent`) are legacy/deprecated and nothing
migrates onto core, so these three examples are the only thing proving the abstraction is
real. A one-consumer abstraction is a guess — the proactive example in particular is
load-bearing, not decoration.

---

## Layout

```
src/
  plugins.ts              ← the one file you edit to add/remove capability
  config.ts               ← model ids, budgets, limits (values; core owns the shapes)
  agents/
    reactive/             ← round loop + delegation: turn.ts, DO, handle-task workflow
    proactive/            ← triage + single-turn converse: loop.ts, DO, notify-task workflow
    arc-player/           ← reactive loop + @looping/plugins/arc-agi wired up
wrangler.jsonc            ← bindings, per-example secret blocks commented
scripts/generate-keys.mjs
.github/workflows/        ← test + the bundle-isolation check
```

## The one file you edit

```ts
// src/plugins.ts
import { arcAgi }  from "@looping/plugins/arc-agi";
import { browser } from "@looping/plugins/browser";

export const plugins = (env: Env) => [
  arcAgi({ apiKey: env.ARC_API_KEY }),
  browser({ binding: env.BROWSER })
];
```

Delete a line → that module leaves the bundle entirely. Nothing in core imports a plugin
and `@looping/plugins` has no root barrel, so the guarantee is structural rather than a
tree-shaker's opinion.

`plugins` is a **function of `env`**, not a module-level array. On Workers `env` doesn't
exist at module scope, and core's registry is built per DO instance in `onStart()`:

```ts
const runtime = createAgentRuntime({ config, plugins: plugins(this.env) });
```

---

## The three examples

Source paths are relative to `../reactive-agent` (R) and `../proactive-agent` (P), both
deprecated but still on disk for the lift.

| Example | Contents | Source | ~LOC | Why it exists |
|---|---|---|---|---|
| `reactive/` | `turn.ts` + DO + `handle-task` workflow + soul/config | `R:src/agent/turn.ts` (897), `R:src/reactive-agent/index.ts` (1,170 → ~800 once plugin hooks are extracted), `R:src/workflows/handle-task.ts` (443) | 2,300 | The flagship: round loop, DAG delegation, wave scheduling, subagent execution |
| `proactive/` | `loop.ts` + DO + `notify-task` workflow + `/triage` plugin | `P:src/agent/loop.ts` (320), `P:src/proactive-agent/index.ts` (307), `P:src/workflows/notify-task.ts` (133) | 800 | **The second consumer.** The only thing proving core isn't secretly shaped around reactive's assumptions |
| `arc-player/` | reactive's loop + arc soul + `/arc-agi` + `/grid-analysis` | `R:src/recipes/arc-game/soul.ts`, `main-agent.ts` | 200 | Proves a domain plugin composes without touching core |

Each is deletable in one `rm -rf` plus one line in `plugins.ts`.

### What the examples own that core deliberately doesn't

- **The loop bodies.** Core ships `RunTurnArgs`, `ControlTool`, `TurnBudget`, `stepAllowance`,
  `isTransientAiError` — the examples write `turn.ts` / `loop.ts` on top.
- **The DO class body** and the Workflow body. Core ships `RecipeSubagent`,
  `createA2AWorker`, `AgentDB`, and the plugin hooks; the example assembles them.
- **The main agent's soul.** In R it's 7 hardcoded lines in `src/agent/prompt.ts` — the
  main agent is the one "recipe" with no Recipe. Here the example supplies it, exactly the
  way a plugin supplies a subagent's soul.
- **`config.ts` values** — model ids, `MAIN_AGENT_LIMITS`, `SUBAGENT_LIMITS`,
  `MAX_SUBTASKS`, compaction thresholds. Core ships the shapes only.

Note R and P genuinely diverge here and both are worth keeping: R ends turns with
`toolChoice: "required"` over `final_reply`/`delegate` and meters a mutable `TurnBudget`
across rounds; P bounds with a constant `MAX_STEPS` and reads `no_reply` off the last
step's tool calls. Two loop shapes on one core is the point.

---

## Bindings

From core (mandatory): `AI`, one Durable Object, one Workflow, secrets `A2A_SIGNING_KEY`
and `GATEWAY_ORIGINS`.

From plugins (declared via `requires`, asserted at startup): `ARC_API_KEY` for `/arc-agi`,
`BROWSER` for `/browser`, `VECTORIZE` for `/recall`.

`wrangler.jsonc` carries all of them with the per-example blocks commented, so deleting an
example is also a comment-out rather than a puzzle. Note `RecipeSubagent` needs **no**
binding and no `new_sqlite_classes` entry in production — it's a managed facet under the
parent DO. It does need a test-only binding in `vitest.config.ts`; that workaround ships
documented.

---

## The CI that keeps the promise

Build each example with `wrangler deploy --dry-run --outdir dist`, then assert:

1. **Cross-plugin absence** — arc-agi source strings do not appear in the proactive
   example's bundle.
2. **Size budget** — each bundle stays under a checked-in byte ceiling.
3. **Contract skew** — installing a deliberately mismatched `@looping/core` fails startup
   with the `PLUGIN_CONTRACT_VERSION` message, not a type error.

This is the only defence that survives a refactor six months from now. Without it the
subpath-export discipline in `looping-plugins` rots silently the first time someone adds a
convenience re-export.

---

## Local development against unpublished packages

```jsonc
// package.json — fast inner loop
"overrides": {
  "@looping/core":    "file:../looping-core",
  "@looping/plugins": "file:../looping-plugins"
}
```

Use `npm pack` + tarball install for pre-release verification. **Not `npm link`** — it
duplicates peer deps, and two copies of `agents` in one Worker bundle breaks the
`Session`/`SessionMessage` types and `instanceof`. CI always installs from the registry so
a link-only-works build can never ship.

---

## Milestones

Blocked on `looping-core` and `looping-plugins` reaching `next`.

1. **Scaffold** — `package.json`, `wrangler.jsonc`, `tsconfig`, eslint from
   `@looping/core/eslint`, `scripts/generate-keys.mjs`, `.dev.vars.example`, husky.
2. **`reactive/`** — the flagship, ported first. Its specs come with it and are the
   fastest signal that core's extracted shapes are actually sufficient.
3. **`proactive/`** — the real test. Expect this to surface places where core over-fit to
   reactive; fixing those in core is the point of doing it.
4. **`arc-player/`** — thin by construction. If it isn't thin, the plugin contract is wrong.
5. **CI checks** (bundle isolation, size budget, contract skew).
6. **README + getting-started** — clone, `npm i`, generate keys, set `GATEWAY_ORIGINS`,
   `wrangler deploy`, register with the gateway. Plus a "delete what you don't want" section.
7. Once green: promote `@looping/core` and `@looping/plugins` from `next` to `latest`, then
   **archive `proactive-agent` and `reactive-agent`** with a README pointer here.

## Verification

- All three examples build, and each ported spec suite stays green.
- The three CI assertions above pass.
- **End to end against the live gateway**, per example: signed card fetch, JWKS fetch, one
  full task round-trip with push notification delivered and verified.
- `arc-player` completes a real ARC-AGI game (the recorded VCR cassette covers the
  hermetic case; this is the live one).
