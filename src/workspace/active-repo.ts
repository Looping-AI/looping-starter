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
 *
 * ## Known limitation: one task at a time, per caller
 *
 * The row is keyed `id = 1` — **one selection per agent object**, and an agent
 * object is per caller, not per task. Two tasks from the same caller running at
 * once, cloning different repositories, therefore overwrite each other's
 * selection: the later `set()` wins, and from that moment the earlier task's own
 * tools (`repo_diff`, the reads, and the commit/push that ends it) resolve to the
 * *other* task's workspace. Cancellation cleanup follows the same wrong name.
 *
 * Delegated work is not exposed to this. A subagent facet receives its workspace
 * name on `ctx.runtime`, resolved on the parent at delegation time and pinned for
 * the life of the subtask, so a session cannot be moved out from under itself.
 * The exposure is the parent's own tool calls, between one task's clone and the
 * other's.
 *
 * **It is not fixable in this file**, which is why this is documented rather than
 * patched. The fix is to key the selection by task, and nothing here can: core's
 * `PluginHost` exposes `env`, `storage`, `callerKey` and `aiGatewayId`, and no
 * task or context identifier at all — so a plugin, and this thunk, have no way to
 * ask which task they are serving. Closing it means adding that identity to
 * `PluginHost` upstream and threading it through `workspaceName()`, which must
 * stay synchronous. Until then this agent assumes one task at a time per caller,
 * and that assumption is load-bearing.
 *
 * Note the workspace itself should stay keyed on `(caller, repo)` even after
 * that change. Making workspaces per-task would give each one a cold container
 * and a fresh `node_modules`, which is the cost the whole design exists to avoid;
 * it is the *routing* that needs task scope, not the storage.
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
   * actually idle is decided by the workspace, from its own `lastUsedAt` — and
   * an entry that goes missing only means that workspace falls back to its own
   * alarm.
   *
   * This used to claim a stale entry was free, on the grounds that it "pokes an
   * already-empty object and is told there is nothing to do". That was wrong in
   * both halves: a reclaimed workspace has had its storage deleted, so
   * `lastUsedAt` reads as `0`, which is maximally idle — it was told it had
   * reclaimed something, every week, forever, logging a false line and
   * recreating storage to empty it again. `reclaimIfIdle` now reports nothing to
   * do when there is nothing there, and {@link forget} keeps this list
   * proportional to the workspaces that actually exist. Both, because they fix
   * different halves: one stops the lie, the other stops the growth.
   */
  seen(): string[];
  /**
   * Drop a repository from the candidate list.
   *
   * Called when its workspace has been reclaimed, so the weekly sweep stops
   * paying for a workspace that no longer exists. `set()` puts it back on the
   * next clone, which is the whole reason this is safe to do: forgetting a
   * candidate loses nothing that the next checkout does not restore.
   */
  forget(repo: string): void;
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
    },

    forget(repo: string): void {
      ensure();
      storage.sql.exec(`DELETE FROM ${SEEN_TABLE} WHERE repo = ?`, repo);
    }
  };
}
