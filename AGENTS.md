# AGENTS.md — working in `looping-starter`

This is the repo you fork. It composes
[`@loopingai/core`](https://github.com/Looping-AI/looping-core) (the mandatory
foundation) and
[`@loopingai/plugins`](https://github.com/Looping-AI/looping-plugins) (optional
capabilities) into a deployable Worker.

The single most useful thing to know: **almost nothing here is framework.** The
round loop, the durable Subtask DAG, the wave scheduler, the subagent execution,
the Durable Object body and the task lifecycle are all in core. What lives here is
what core deliberately refuses to ship — the words, the config values, and which
plugins each agent installs.

If you find yourself writing durable-execution logic in this repo, that is the
signal it belongs in core instead.

---

## Where a thing goes

| You are changing…                         | It goes in                       |
| ----------------------------------------- | -------------------------------- |
| what the model is told about a domain     | the plugin that owns that domain |
| what the agent _is_                       | `src/agents/<tenant>/soul.ts`    |
| how a round ends, or a user-facing string | `src/round-policy.ts`            |
| which capabilities an agent has           | `src/agents/<tenant>/plugins.ts` |
| model ids, budgets, limits                | `src/config.ts`                  |
| cancellation, retries, idempotency, DAGs  | **`@loopingai/core`** — not here |

`src/round-policy.ts` and `src/config.ts` sit at the top level because two agents
share them. An agent importing a _sibling's_ module is what `npm run
verify:isolation` fails on, because the sibling's plugin list comes with it — even
a type-only import, because the next person makes it a value import.

---

## Adding and removing agents

```bash
npm run agent:new <tenant> [--kind round|single]
npm run agent:remove <tenant>
```

Never do it by hand. An agent exists in four places — its directory, `src/index.ts`,
three blocks in `wrangler.jsonc`, and `scripts/verify-isolation.mjs` — and each
missed one fails at a different time: a forgotten DO binding at deploy, a forgotten
`new_sqlite_classes` entry at the first request, a forgotten isolation entry
_never_, because it just stops checking that agent.

Add-then-remove must return all four files byte-for-byte to where they started.
That round trip is the test that keeps the script honest; run it if you change the
script.

**A tenant id is a public identifier.** A gateway registers against it and it rides
in a JWT claim, so renaming one is a re-registration, not a refactor.

---

## The two invariants that have already broken once

**1. Cancellation is checked by the guarded write, never by a probe.**
`saveTask` returns whether the write applied, and `markWorking` returns
`"ok" | "canceled"`. Read those. Calling `getTask` first and acting second reopens
a window in which a cancel lands and the gateway still gets a `completed`
callback — and that is exactly how this repo's proactive agent drifted from its
sibling. `test/proactive/workflow.spec.ts` pins both.

**2. `verify:isolation` is the check that survives a refactor.**
This Worker deploys as one bundle containing every agent, so grepping `dist/`
proves nothing. Each agent's entry is bundled alone and esbuild's **metafile** —
the module list, not a string search — is checked for plugins that agent does not
install, plus `@loopingai/core/dist/round/` for the agent that does not delegate.

It has caught two real leaks: a shared base class living in one agent's directory,
and (after the core split) it is what holds proactive at ~1.5 MiB instead of ~2.5.

---

## Working here

```bash
npm run check              # wrangler types, prettier, eslint, tsc (src + test)
npm test                   # vitest, inside real workerd
npm run verify:isolation   # per-agent module graphs + size ceilings
npx wrangler deploy --dry-run --outdir dist
```

`npm test` alone will not catch a type error — vitest transpiles specs without
typechecking them — so run `check` before pushing.

### Across the three repos

```bash
npm run link:local    # npm pack + tarball install from ../looping-core, ../looping-plugins
```

`npm pack` + tarball, deliberately — **not `npm link`**, which symlinks the checkout
and gives it its own copy of every peer. Two copies of `agents` in one Worker bundle
breaks the `Session` / `SessionMessage` types and every `instanceof`, at runtime
rather than at the type level.

A contract change is a three-repo publish train (core → plugins → starter), so one
repo is always briefly behind. `PLUGIN_CONTRACT_VERSION` is asserted at DO start so
a skew fails with a sentence naming the plugin rather than a structural-type error
several frames away.

---

## Size ceilings

`verify:isolation` enforces a byte ceiling per agent. They are not aesthetic:
bundle growth is the observable symptom of the subpath-export discipline rotting,
and a ceiling turns a slow leak into a failing build. Raise one **deliberately**,
with the dependency bump that caused it — never to make a build pass.
