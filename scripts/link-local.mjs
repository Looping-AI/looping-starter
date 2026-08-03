#!/usr/bin/env node
/**
 * Install the sibling `looping-core` / `looping-plugins` checkouts into this
 * repo, for developing across the three at once.
 *
 * `npm pack` + tarball install, deliberately — **not `npm link`**, and not a
 * `file:` dependency either:
 *
 * - `npm link` symlinks the checkout, which gives it its own `node_modules` and
 *   so its own copy of every peer. Two copies of `agents` in one Worker bundle
 *   breaks the `Session` / `SessionMessage` types and every `instanceof`, and it
 *   breaks at runtime rather than at the type level, which is the worst place to
 *   find out.
 * - A `file:` dependency has the same duplication hazard and additionally hides
 *   packing mistakes: a file missing from `package.json#files` still resolves
 *   locally and 404s for everyone else.
 *
 * A tarball is what npm actually publishes, so if it works here it works from the
 * registry. Nothing is written to `package.json` — this leaves the manifest's
 * published semver ranges alone, so a plain `npm install` (and CI, which never
 * runs this) always builds against the real packages.
 *
 * Re-run it after changing either sibling; `npm install` alone will not pick the
 * change up.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SIBLINGS = ["looping-core", "looping-plugins"];
const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "looping-pack-"));
const tarballs = [];

for (const name of SIBLINGS) {
  const dir = path.resolve(root, "..", name);
  if (!existsSync(dir)) {
    console.error(
      `${name} not found at ${dir}.\n` +
        "Check out the three repos as siblings, or skip this script and use the " +
        "published packages."
    );
    process.exit(1);
  }
  console.log(`packing ${name}…`);
  // `npm pack` runs the package's own `prepack`, so this builds `dist/` and runs
  // its export verification — the same gate a real publish passes.
  execFileSync("npm", ["pack", "--pack-destination", out], {
    cwd: dir,
    stdio: "inherit"
  });
}

for (const file of readdirSync(out)) {
  if (file.endsWith(".tgz")) tarballs.push(path.join(out, file));
}

console.log(`installing ${tarballs.length} tarball(s)…`);
// `--no-save` keeps the published ranges in package.json intact.
execFileSync("npm", ["install", "--no-save", ...tarballs], {
  cwd: root,
  stdio: "inherit"
});
console.log("done. Re-run after changing either sibling.");
