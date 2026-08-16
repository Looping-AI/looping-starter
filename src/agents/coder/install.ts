import {
  DEFAULT_INSTALL_PLAN,
  type InstallPlan
} from "@loopingai/plugins/computer";

/**
 * How **this deployment** installs dependencies, and the one file to edit when a
 * repository does it differently.
 *
 * The split is deliberate. `@loopingai/plugins/computer` owns the *procedure* —
 * look at what the checkout actually contains, in a fixed order, never guess —
 * because that is the same everywhere. The **commands** are here, because they
 * are not: one repository wants `--frozen-lockfile`, another has to build after
 * installing, a third needs a registry token exported first. A plugin that
 * hard-coded `npm ci` would be wrong for most of them.
 *
 * ## When the install runs
 *
 * On every checkout, and every cold container. `node_modules` lives in the
 * container and dies with it — only source and `.git` are durable — so a
 * container restart leaves a checkout with no dependencies, and the tree looks
 * fine until something imports one.
 *
 * It does **not** run inside a round. `repo_clone` starts it and returns; the
 * workspace Durable Object drains it on its own budget; `sb_exec` waits for it.
 * That is not an optimisation. Measured on looping-gateway, `npm ci` takes 225
 * seconds — and a subagent's chunk step is killed at ten minutes, after which
 * Workflows retries the whole chunk and runs the install *again*.
 *
 * ## Adding an override
 *
 * Key by `owner/repo`, exactly as the clone URL spells it:
 *
 * ```ts
 * overrides: {
 *   "Looping-AI/looping-gateway": "npm ci --no-audit --no-fund && npm run build"
 * }
 * ```
 *
 * An override replaces the whole command, so it must do everything — including
 * the install. It also participates in the fingerprint, so changing one here
 * re-installs on the next checkout rather than silently reusing a tree built the
 * old way.
 */
export const INSTALL_PLAN: InstallPlan = {
  // The plugin's table, unmodified. Copy it inline and edit if this deployment
  // ever needs a different command for a manager — the indirection is only
  // worth keeping while the defaults are genuinely what we want.
  //
  // Order matters and is the plugin's, not ours: pnpm, yarn, bun, then npm.
  // `package-lock.json` is last because it is the file most likely to be
  // present *and* stale in a repository that has since moved to pnpm.
  rules: DEFAULT_INSTALL_PLAN.rules,

  // A `package.json` with no lockfile still gets installed. The alternative —
  // skipping — hands the subagent a tree whose imports do not resolve, and
  // "cannot find module" is a much worse first impression of a repository than
  // a slightly non-reproducible install.
  noLockfile: DEFAULT_INSTALL_PLAN.noLockfile,

  // Nothing here yet, and that is the honest state: every repository this agent
  // has been pointed at installs the ordinary way. Add one the first time that
  // stops being true, rather than guessing in advance.
  overrides: {},

  // Above the 225 s a cold `npm ci` measured on looping-gateway, with room for
  // a repository several times larger, and well under the point where a hung
  // install would sit there all day. This bounds the command, not the round —
  // nothing is waiting on it.
  timeoutMs: 20 * 60_000
};
