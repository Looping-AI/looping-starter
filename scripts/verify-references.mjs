#!/usr/bin/env node
/**
 * Fail if a comment names a repo path that does not exist.
 *
 * Comments here carry a lot of cross-references, and a reference is the part
 * that rots first: the file moves, the comment stays, and the next reader spends
 * a minute proving the note is stale rather than reading it. A path in a comment
 * is checkable, so this checks it.
 *
 * Deliberately narrow — only `src/`, `test/` and `scripts/` paths with a file
 * extension, which is what this repo actually writes. Prose like "the workspace
 * object" is not a reference and is not this script's business.
 *
 * Run: `npm run verify:references`
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SCAN = ["src", "test", "scripts"];
const LOOSE = [
  "README.md",
  "AGENTS.md",
  "wrangler.jsonc",
  "Dockerfile",
  ".env.example"
];
const EXT = /\.(ts|mjs|js|md|json|jsonc)$/;
const REF =
  /(?<![\w/.-])(src|test|scripts)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|mjs|js|md|json|jsonc)/g;

/**
 * Paths that are deliberately not this repo's, with the reason.
 *
 * Add to this only for a path that genuinely lives elsewhere — never to silence
 * a reference that has simply gone stale.
 */
const EXTERNAL = new Map([
  ["src/claude-code/README.md", "lives in @dynamicagents/plugins"],
  ["src/round/turn.ts", "an illustrative example in subagent prompt copy"],
  ["src/round/turn.spec.ts", "an illustrative example in subagent prompt copy"]
]);

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return EXT.test(entry) ? [full] : [];
  });

const files = [
  ...SCAN.flatMap((d) => walk(path.join(root, d))),
  ...LOOSE.map((f) => path.join(root, f)).filter(existsSync)
];

let failed = false;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const seen = new Set();
  for (const [ref] of text.matchAll(REF)) {
    if (seen.has(ref) || EXTERNAL.has(ref)) continue;
    seen.add(ref);
    if (existsSync(path.join(root, ref))) continue;
    failed = true;
    const line = text.slice(0, text.indexOf(ref)).split("\n").length;
    console.error(
      `✗ ${path.relative(root, file)}:${line} names ${ref}, which does not exist`
    );
  }
}

if (failed) {
  console.error(
    "\nA comment points at a file that is not there. Either the path moved and " +
      "the comment did not, or the reference was never right. Fix the comment — " +
      "and if the path really is outside this repo, say so in EXTERNAL above."
  );
  process.exit(1);
}

console.log("Every repo path named in a comment exists.");
