import type { PluginHost } from "@loopingai/core/host";

/**
 * Which repository this caller is working on, and therefore which workspace
 * their commands reach.
 *
 * ## The ordering problem this solves
 *
 * A workspace is one Durable Object, one container and **one repository** —
 * `@cloudflare/computer` pairs an object with exactly one container, so that is
 * structural rather than a convention. But the repository is not known when the
 * plugin list is built, and it is not known at the start of the task either: the
 * model chooses it by calling `repo_clone` with a URL.
 *
 * That is circular on the face of it. `repo_clone` runs `git clone` through the
 * container, so it needs a workspace *before* it can produce the repository that
 * names the workspace. The repo plugin's `beforeCheckout` hook breaks the cycle:
 * it fires with the parsed `owner/repo` after the host allowlist has passed and
 * before any git runs, which is exactly the moment to switch.
 *
 * ## Why this is SQL and not `storage.get`
 *
 * The selection has to survive an isolate eviction mid-task — a new isolate with
 * an empty closure would otherwise fall back to a caller-level workspace, and
 * `repo_diff` would report an empty tree for a checkout that is sitting right
 * there. So it is persisted.
 *
 * But `workspaceName()` is a **synchronous** thunk: it is called on the path of
 * every tool, inside `computerExec`, where there is nowhere to await. Durable
 * Object `storage.get` is async; `storage.sql` is not. So the value lives in a
 * one-row table, written on selection and read synchronously on every call, with
 * an in-memory cache in front so the common case touches no storage at all.
 */

const TABLE = "coder_active_repo";
const SEEN_TABLE = "coder_seen_repos";

/** Reads and writes for one caller's current repository. */
export interface ActiveRepo {
  /** `owner/repo`, or undefined before the first clone of this session. */
  get(): string | undefined;
  /** Record the repository a clone is about to target. */
  set(repo: string): void;
  /**
   * Every repository this caller has ever worked on.
   *
   * Not for routing — `get()` is what routes. This is the **candidate list** the
   * weekly reclaim sweep walks, and it exists because a Durable Object namespace
   * cannot be enumerated from a Worker: without a record of the names we handed
   * out, there is no way to ask a workspace whether it has gone stale.
   *
   * It is deliberately only a list of candidates. Whether a workspace is
   * actually idle is decided by the workspace, from its own `lastUsedAt` — so a
   * stale entry here pokes an already-empty object and is told there is nothing
   * to do, and an entry that goes missing only means that workspace falls back
   * to its own alarm.
   */
  seen(): string[];
}

export function activeRepo(host: PluginHost<Env>): ActiveRepo {
  const storage = host.storage;
  let cached: string | undefined;
  let ready = false;

  const ensure = () => {
    if (ready) return;
    // `IF NOT EXISTS` rather than a migration: this is one row of scratch state
    // belonging to one agent, not part of core's journal, and core's schema
    // machinery has no reason to know about it.
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), repo TEXT NOT NULL)`
    );
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${SEEN_TABLE} (repo TEXT PRIMARY KEY, at INTEGER NOT NULL)`
    );
    ready = true;
  };

  return {
    get(): string | undefined {
      if (cached !== undefined) return cached;
      try {
        ensure();
        const row = storage.sql
          .exec<{ repo: string }>(`SELECT repo FROM ${TABLE} WHERE id = 1`)
          .toArray()[0];
        cached = row?.repo;
        return cached;
      } catch {
        // A subagent facet reaches this through the same plugin list but has no
        // table of its own — and needs none, because its workspace name arrives
        // on `ctx.runtime` from the parent and this is only ever the fallback.
        // Returning undefined lets that fallback be a caller-level name rather
        // than an exception thrown from inside a tool.
        return undefined;
      }
    },

    set(repo: string): void {
      if (cached === repo) return;
      ensure();
      storage.sql.exec(
        `INSERT INTO ${TABLE} (id, repo) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET repo = excluded.repo`,
        repo
      );
      storage.sql.exec(
        `INSERT INTO ${SEEN_TABLE} (repo, at) VALUES (?, ?)
           ON CONFLICT(repo) DO UPDATE SET at = excluded.at`,
        repo,
        Date.now()
      );
      cached = repo;
    },

    seen(): string[] {
      ensure();
      return storage.sql
        .exec<{ repo: string }>(`SELECT repo FROM ${SEEN_TABLE}`)
        .toArray()
        .map((row) => row.repo);
    }
  };
}
