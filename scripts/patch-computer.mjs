#!/usr/bin/env node
/**
 * One patch to the installed `@cloudflare/computer`, without which the coder's
 * workspace does not work. Found by measuring a deployed Worker; it is one line,
 * and it is upstream's own fix awaiting a release.
 *
 * ## `PROBE_BATCH` — fixed on `main`, not in any published version
 *
 * `hasObjects()` probes the object store by binding one parameter per chunk hash
 * into a single `... WHERE b.hash IN (?, ?, …)`, in windows of `PROBE_BATCH`.
 * That constant is 256, sized against stock SQLite's 999-parameter limit — but a
 * **Durable Object's** SQLite accepts at most 100. Any sync batch referencing
 * 101 or more unique chunks fails with:
 *
 *     too many SQL variables at offset 417: SQLITE_ERROR
 *
 * Offset 417 is not a coincidence: the query's prefix is 117 characters and each
 * placeholder is three (`?, `), so it lands exactly on the 101st variable.
 *
 * It fails *before* `applyChanges()` and before the fetch cursor moves, so the
 * pull applies nothing and a retry hits the same batch and fails identically —
 * nothing recovers on its own. Measured: a 90-file write synced (`applied: 92`),
 * a 150-file write did not (`applied: 0`), and cloning a 584-file repository
 * left the object's storage at its empty size while the container held the whole
 * checkout.
 *
 * Fixed on `main` (issue #73, closed 2026-08-07) as `const PROBE_BATCH = 100;`
 * under the comment "SQLite accepts at most 100 bound parameters per query".
 * `0.1.1` predates that and is still the latest release. **When a release
 * carries it, delete this file and its `postinstall` hook.**
 *
 * ## The patch that is deliberately *not* here
 *
 * `computerd` drops `node_modules` from the change stream before it reaches the
 * wire — `DEFAULT_IGNORE = ["node_modules"]`, applied whenever the host omits an
 * `ignore`, which `pullOnce` always does. A second one-line patch (sending
 * `ignore: []`) defeats that, and it works: measured on a deployed Worker, the
 * whole 429 MB tree began crossing into the object.
 *
 * It is not here because it does not survive the finish line. Twice, at ~450 MB,
 * the Durable Object's isolate exceeded its 128 MB memory limit and was reset,
 * killing the sync at ~99.7% and leaving the workspace tens of files short — and
 * the reconciliation that followed pushed that shortfall *back into the
 * container*, so both sides ended up consistently wrong with nothing to flag it.
 * Slicing the transfer (pulling on a timer during the install instead of once at
 * the end) changed when the data landed and not the outcome, which points at the
 * capnweb session rather than any one batch: the package's own README warns that
 * "the RPC layer does not garbage-collect remote stubs … undisposed stubs
 * accumulate on the peer until the session ends", and nothing public cycles that
 * connection.
 *
 * So this deployment runs the package as designed: `node_modules` stays in the
 * container and is rebuilt when the container is, and the workspace holds source
 * and `.git` — about 6 MB for looping-gateway, which hydrates in seconds and has
 * never come close to the limit. Recorded here so nobody re-derives it: the
 * override is one line and it looks like it works right up until it does not.
 *
 * ## Run from two places, on purpose
 *
 * `postinstall` covers a plain `npm install`. `link:local` chains this
 * explicitly because its `npm install --no-save <tarballs>` does **not** fire the
 * root's `postinstall` — which would leave anyone developing across the sibling
 * checkouts on an unpatched bundle, and the symptom is a sync that quietly
 * applies nothing.
 *
 * ## Why this cannot rot
 *
 * Pinned to the exact version, and every other case is an error rather than a
 * silent skip: unpatched → patch; patched → no-op (idempotent, since
 * `npm install` re-runs it); expected text missing → fail; different version →
 * fail with instructions. The day `0.1.2` ships this stops the build rather than
 * leaving the workspace quietly broken, which is the failure that matters — the
 * bug above is invisible until a sync silently applies nothing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The one version these are known to apply to. */
const PINNED = "0.1.1";

/**
 * Each patch names the text it replaces. `find` must be unique in the bundle —
 * asserted below, because a second occurrence would mean the replace silently
 * hits the wrong one.
 */
const PATCHES = [
  {
    what: "PROBE_BATCH 256 → 100 (cloudflare/computer#73)",
    find: "const PROBE_BATCH = 256;",
    replace: "const PROBE_BATCH = 100;"
  }
];

const root = path.resolve(import.meta.dirname, "..");
const pkgDir = path.join(root, "node_modules", "@cloudflare", "computer");

function die(message) {
  console.error(`patch-computer: ${message}`);
  process.exit(1);
}

// Read the manifest and walk its `exports` by hand rather than asking
// `require.resolve`. That is not defensiveness for its own sake: this package's
// exports map declares only `types` and `import`, with no `require` condition,
// so `require.resolve` throws ERR_PACKAGE_PATH_NOT_EXPORTED and a `try/catch`
// around it reads as "not installed" — which is how the first version of this
// script reported success while patching nothing.
if (!existsSync(pkgDir)) {
  // Genuinely absent. `postinstall` also fires in trees that never install it.
  process.exit(0);
}

const manifest = JSON.parse(
  readFileSync(path.join(pkgDir, "package.json"), "utf8")
);
const entry = manifest.exports?.["."]?.import ?? manifest.main;
if (!entry) die(`@cloudflare/computer has no resolvable entry point`);

const file = path.join(pkgDir, entry);
if (!existsSync(file)) die(`${path.relative(root, file)} does not exist`);

const installed = manifest.version;
let source = readFileSync(file, "utf8");
const pending = PATCHES.filter((p) => !source.includes(p.replace));

if (installed !== PINNED) {
  die(
    `@cloudflare/computer@${installed} is not the pinned ${PINNED}. Re-check ` +
      `both patches in this file against the new bundle before widening the ` +
      `pin — #73 may be fixed upstream (drop that entry), but the ` +
      `node_modules ignore override is ours and will still be needed.`
  );
}

if (pending.length === 0) process.exit(0);

for (const patch of pending) {
  const occurrences = source.split(patch.find).length - 1;
  if (occurrences === 0) {
    die(
      `could not find ${JSON.stringify(patch.find)} in ` +
        `${path.relative(root, file)}. The bundle changed shape without ` +
        `changing version — patch by hand and update this script.`
    );
  }
  if (occurrences > 1) {
    die(
      `${JSON.stringify(patch.find)} appears ${occurrences} times in ` +
        `${path.relative(root, file)}; the replacement is ambiguous.`
    );
  }
  source = source.replace(patch.find, patch.replace);
}

writeFileSync(file, source);
for (const patch of pending) {
  console.log(
    `patch-computer: @cloudflare/computer@${installed} — ${patch.what}`
  );
}
