#!/usr/bin/env node
/**
 * Prove that each agent's module graph is its own.
 *
 * ## What this actually checks, and why it is not the obvious thing
 *
 * This Worker deploys as **one bundle containing all three agents**, so grepping
 * `dist/` for "arc-agi" would always find it and prove nothing. The invariant
 * that matters is the one a user relies on the moment they delete the two agents
 * they don't want: *each agent's graph pulls in only the plugins that agent
 * installed.* So each entry is bundled on its own here, in CI only, and the
 * result is inspected.
 *
 * The check is on esbuild's **metafile** — the exact list of modules that made it
 * into the graph — not on string matching. A string search answers "does this
 * word appear", which a comment or a coincidence can satisfy; the metafile
 * answers "did this module get pulled in", which is the actual question. A single
 * convenience re-export added to `@loopingai/plugins` six months from now would
 * silently defeat a grep and cannot defeat this.
 *
 * It also enforces a **size ceiling** per agent. Not for its own sake: bundle
 * growth is the observable symptom of the subpath-export discipline rotting, and
 * a ceiling is what turns a slow leak into a failing build.
 *
 * Run: `npm run verify:isolation`
 */
import { build } from "esbuild";
import { builtinModules } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const plugin = (name) => `@loopingai/plugins/dist/${name}/`;
/** A core subpath. `/round` is the delegation engine — opt-in, and its own graph. */
const core = (name) => `@loopingai/core/dist/${name}/`;

/**
 * One agent, its entry points, and what must not be in its graph.
 *
 * `forbidden` is the interesting column. Each entry is a plugin *another* agent
 * installs — so it is not a list of things nobody uses, it is a list of things
 * that exist in this repo and must not have leaked sideways.
 */
const AGENTS = [
  {
    name: "reactive",
    entries: [
      "src/agents/reactive/agent.ts",
      "src/agents/reactive/workflow.ts",
      "src/agents/reactive/subagent.ts"
    ],
    forbidden: [
      plugin("arc-agi"),
      plugin("triage"),
      plugin("computer"),
      plugin("repo"),
      "@cloudflare/computer"
    ],
    // Re-baselined when `splitting` was turned on above, not because this agent
    // grew: the old number simply never counted the chunks it reaches through a
    // dynamic `import()`. Measured 3687 KiB the first time it was weighed
    // honestly, against a 3613 KiB ceiling it had been quietly over. ~8% over
    // that measurement, the headroom every entry here runs with.
    maxBytes: 4_080_000
  },
  {
    name: "proactive",
    entries: [
      "src/agents/proactive/agent.ts",
      "src/agents/proactive/workflow.ts"
    ],
    // Also no `/workspace`: this agent never delegates, so no execution ever
    // needs a durable file store — and `@cloudflare/shell` is a real dependency
    // to carry for nothing.
    //
    // And no `@loopingai/core/round`. That is the strongest assertion here: core
    // ships the whole delegating loop — DAG scheduler, chunked subagent
    // execution, the repair ladder — behind an opt-in subpath, and an agent that
    // answers in one turn must not pay a byte for it. If this ever fails, the
    // root barrel has started re-exporting `/round`.
    forbidden: [
      plugin("arc-agi"),
      plugin("workspace"),
      plugin("computer"),
      plugin("repo"),
      "@cloudflare/shell",
      "@cloudflare/computer",
      core("round")
    ],
    maxBytes: 1_750_000
  },
  {
    name: "arc-player",
    entries: [
      "src/agents/arc-player/agent.ts",
      "src/agents/arc-player/subagent.ts"
    ],
    // No triage, no browser, no recall: this agent plays games.
    forbidden: [
      plugin("triage"),
      plugin("browser"),
      plugin("recall"),
      plugin("computer"),
      plugin("repo"),
      "@cloudflare/computer"
    ],
    maxBytes: 3_300_000
  },
  {
    name: "coder",
    entries: [
      "src/agents/coder/agent.ts",
      "src/agents/coder/workflow.ts",
      "src/agents/coder/subagent.ts"
    ],
    // No arc-agi, no triage, no recall — and no `/workspace`, which is the one
    // worth stating: the computer plugin is this agent's filesystem, and having
    // both would hand the model two unrelated ones with no way to tell from a
    // path which it is addressing.
    forbidden: [
      plugin("arc-agi"),
      plugin("triage"),
      plugin("recall"),
      plugin("workspace"),
      "@cloudflare/shell"
    ],
    // Higher than its siblings because it is the only agent carrying a container
    // client and a second model provider — but still a real ceiling, ~8% over
    // the measured size, the same headroom the others run with. Raise it
    // deliberately, with the dependency bump that caused it, never to make a red
    // build go green.
    //
    // Moved 4300 → 5450 KB in two steps, both deliberate and worth separating:
    //   +111 KiB  turning on `splitting` — weight this agent already carried
    //             through dynamic imports and this script could not see.
    //   +608 KiB  `@cloudflare/computer/git` in the workspace DO, which bundles
    //             isomorphic-git so that clone, fetch and push run on this side
    //             of the container boundary and the forge token never crosses
    //             it. Bought knowingly: it is the cost of the credential never
    //             being readable by a shell the model controls.
    // Measured 4918 KiB after both.
    maxBytes: 5_450_000
  }
];

/**
 * Modules the Workers runtime provides, so esbuild must not try to resolve them.
 *
 * The bare builtins (`fs`, `path`, …) are here because transitive dependencies
 * still import them unprefixed, and `nodejs_compat` supplies them at runtime —
 * wrangler's own build externalizes the same set. Without them this fails on
 * dependencies that have nothing to do with what is being measured.
 */
const EXTERNAL = ["cloudflare:*", "node:*", ...builtinModules];

let leakFailed = false;
let sizeFailed = false;

for (const agent of AGENTS) {
  const results = [];
  for (const entry of agent.entries)
    results.push(
      await build({
        entryPoints: [path.join(root, entry)],
        bundle: true,
        write: false,
        metafile: true,
        // Never written (`write: false`), but esbuild requires it whenever a build
        // can emit more than one file — which `splitting` makes true of all of them.
        outdir: path.join(root, ".isolation-check"),
        format: "esm",
        // Load-bearing, and the reason this file once measured a lie.
        //
        // Without it esbuild cannot emit chunks, so a module reached only through a
        // dynamic `import()` is parsed — it still appears in `metafile.inputs`, so
        // the isolation half of this check always saw it — and then dropped from the
        // output. `@cloudflare/computer/git` lazy-loads its bundled isomorphic-git
        // exactly that way, and wiring it into the coder moved the real deploy by
        // ~800 KiB while this script reported no change at all. A ceiling that
        // cannot see the largest thing anyone has added to a bundle is not a
        // ceiling.
        //
        // It is paired with building one entry point at a time below. `splitting`
        // across all three at once would also hoist what they *share* into one
        // chunk, which counts shared code once instead of once per entry and would
        // silently redefine every ceiling in this file. One entry per build keeps
        // the old scale and adds only what was missing.
        splitting: true,
        // Resolve the way wrangler does. `platform: "neutral"` applies no export
        // conditions at all, which makes perfectly-installed packages (`partyserver`,
        // via `agents`) look unresolvable — and a check that cannot resolve the graph
        // cannot measure it.
        platform: "browser",
        conditions: [
          "workerd",
          "worker",
          "browser",
          "import",
          "module",
          "default"
        ],
        mainFields: ["module", "main"],
        target: "es2022",
        external: EXTERNAL,
        // Required, not cosmetic. The Agents SDK resolves a facet through
        // `ctx.exports[this.constructor.name]`, so a build that minifies class
        // identifiers turns `ArcPlayerSubagent` into `_a` and the lookup fails at
        // runtime. Keeping names here also keeps this measurement honest against the
        // real deploy, which does the same.
        keepNames: true,
        // Minified, so the ceiling is a number about the *deploy* rather than about
        // source formatting. Unminified sizes drift with comments and would make the
        // budget react to documentation.
        minify: true,
        absWorkingDir: root,
        logLevel: "silent"
      })
    );

  const inputs = [
    ...new Set(results.flatMap((r) => Object.keys(r.metafile.inputs)))
  ];
  const bytes = results.reduce(
    (n, r) => n + r.outputFiles.reduce((m, f) => m + f.contents.length, 0),
    0
  );

  const leaked = agent.forbidden.filter((needle) =>
    inputs.some((input) => input.includes(needle))
  );

  if (leaked.length > 0) {
    leakFailed = true;
    console.error(`✗ ${agent.name}: leaked ${leaked.join(", ")}`);
    for (const needle of leaked) {
      // Name the actual file, so the fix is obvious rather than a hunt.
      const culprits = inputs.filter((i) => i.includes(needle)).slice(0, 3);
      for (const c of culprits) console.error(`    via ${c}`);
    }
  } else if (bytes > agent.maxBytes) {
    sizeFailed = true;
    console.error(
      `✗ ${agent.name}: ${fmt(bytes)} exceeds its ${fmt(agent.maxBytes)} ceiling.\n` +
        "    Either something was pulled in that should not have been, or the " +
        "ceiling needs raising deliberately."
    );
  } else {
    console.log(
      `✓ ${agent.name}: ${fmt(bytes)} (ceiling ${fmt(agent.maxBytes)}), ` +
        `${inputs.length} modules, no cross-agent plugin`
    );
  }
}

function fmt(n) {
  return `${(n / 1024).toFixed(0)} KiB`;
}

if (leakFailed) {
  console.error(
    "\nA plugin reached an agent that does not install it. Nothing in core " +
      "imports a plugin and `@loopingai/plugins` has no root barrel, so this is " +
      "almost always one agent importing another agent's module — follow the " +
      "`via` lines. Anything genuinely shared by two agents belongs in " +
      "src/round-agent/ or src/, never in a sibling's directory."
  );
}
if (sizeFailed) {
  console.error(
    "\nAn agent outgrew its ceiling with no forbidden plugin in its graph. " +
      "Either a dependency arrived that nobody asked for, or the agent really " +
      "did grow — in which case raise the number here, deliberately, in the same " +
      "commit as whatever grew it."
  );
}
if (leakFailed || sizeFailed) process.exit(1);

console.log("\nEach agent's graph carries only the plugins it installs.");
