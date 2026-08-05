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
    forbidden: [plugin("arc-agi"), plugin("triage")],
    maxBytes: 3_700_000
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
      "@cloudflare/shell",
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
    forbidden: [plugin("triage"), plugin("browser"), plugin("recall")],
    maxBytes: 3_300_000
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
  const result = await build({
    entryPoints: agent.entries.map((e) => path.join(root, e)),
    bundle: true,
    write: false,
    metafile: true,
    // Never written (`write: false`), but esbuild requires it whenever there is
    // more than one entry point.
    outdir: path.join(root, ".isolation-check"),
    format: "esm",
    // Resolve the way wrangler does. `platform: "neutral"` applies no export
    // conditions at all, which makes perfectly-installed packages (`partyserver`,
    // via `agents`) look unresolvable — and a check that cannot resolve the graph
    // cannot measure it.
    platform: "browser",
    conditions: ["workerd", "worker", "browser", "import", "module", "default"],
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
  });

  const inputs = Object.keys(result.metafile.inputs);
  const bytes = result.outputFiles.reduce((n, f) => n + f.contents.length, 0);

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
