import type { PluginStore } from "@loopingai/core";
import { deckSchema, type Deck } from "./schema";

/**
 * Where a deck lives, and how this caller knows which decks are theirs.
 *
 * Two stores, and the split is forced by the runtime rather than chosen:
 *
 * - **The bytes go in R2.** A subagent execution's workspace is wiped when the
 *   parent deletes the child (after delivery, on cancellation, and on the
 *   fingerprint-mismatch recreate), so nothing durable can live there. R2 is the
 *   only store that outlives a facet, and it is what `deck_open` re-seeds from
 *   after any of those events.
 * - **The index goes in the caller's own Durable Object**, via
 *   `AgentPlugin.store`. It cannot go in R2 alongside the decks: keys there carry
 *   no caller segment, because `PluginHost.callerKey()` *throws* on a facet
 *   (`@loopingai/core/round`'s `RecipeSubagentHost` — "a subagent execution has
 *   no caller identity"), so nothing on the execution path may key by caller.
 *
 * That split is also the authorization model. The deck id is 128 bits of
 * randomness and is the capability in the delivery URL; the per-caller ledger is
 * what stops a model from naming an id that belongs to somebody else, because
 * `resolveRuntime` resolves every `deck_id` param against *this* caller's rows
 * before the execution starts.
 */

/** R2 key prefix. The bucket is `looping-files` and will hold more than decks. */
const PREFIX = "decks/";

export const deckKey = (deckId: string): string => `${PREFIX}${deckId}.json`;
export const pdfKey = (deckId: string): string => `${PREFIX}${deckId}.pdf`;

/**
 * The public URL for a rendered deck.
 *
 * The deck id *is* the capability: 128 bits of randomness, no token and no
 * expiry, exactly like an unlisted share link. Built in one place because two
 * callers need it — `deck_list`, and the `enrichResult` hook that attaches the
 * link to a finished subtask — and two spellings of a URL is one bug.
 */
export function deckUrl(baseUrl: string, deckId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/d/${deckId}.pdf`;
}

/** Thrown when a stored deck cannot be parsed — corruption, or a schema change. */
export class DeckReadError extends Error {}

/** Read a deck, or null if there is none. Throws if what is stored is unusable. */
export async function getDeck(
  bucket: R2Bucket,
  deckId: string
): Promise<Deck | null> {
  const object = await bucket.get(deckKey(deckId));
  if (!object) return null;
  const parsed = deckSchema.safeParse(await object.json());
  if (!parsed.success) {
    throw new DeckReadError(
      `stored deck ${deckId} does not match the current schema: ` +
        (parsed.error.issues[0]?.message ?? "invalid")
    );
  }
  return parsed.data;
}

/** Whether a rendered PDF exists — the parent's check before publishing a link. */
export async function hasPdf(
  bucket: R2Bucket,
  deckId: string
): Promise<boolean> {
  return (await bucket.head(pdfKey(deckId))) !== null;
}

/**
 * Commit a deck and its rendering together.
 *
 * A whole-object PUT of each, keyed only by `deckId`, which is what makes a
 * commit **idempotent**: the subagent facet caches one terminal result per
 * request fingerprint and replays it on retry, and a Workflow step may re-run
 * a chunk after a crash — so every write on this path has to be safe to repeat.
 *
 * `httpMetadata` is set here rather than at serve time so the delivery route can
 * simply echo it back with `writeHttpMetadata`, and the filename the user sees
 * is the deck's own title.
 */
export async function putDeck(
  bucket: R2Bucket,
  deck: Deck,
  pdf: Uint8Array
): Promise<void> {
  await bucket.put(deckKey(deck.deckId), JSON.stringify(deck), {
    httpMetadata: { contentType: "application/json" }
  });
  await bucket.put(pdfKey(deck.deckId), pdf, {
    httpMetadata: {
      contentType: "application/pdf",
      contentDisposition: `inline; filename="${filenameFor(deck.title)}"`
    }
  });
}

/** A safe, recognisable download filename. ASCII only — this rides in a header. */
export function filenameFor(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "deck"}.pdf`;
}

// --- the per-caller ledger --------------------------------------------------

/**
 * One row per deck this caller has. No caller column: the Durable Object is
 * keyed 1:1 by the verified caller, so the table *is* the scope — the same
 * reason `@loopingai/plugins/arc-agi` keeps `arc_scorecards` without one.
 *
 * `savedAt` null means minted by `deck_new` but never committed: a deck the
 * model asked for and then failed to build. Those are kept rather than swept, so
 * `deck_list` can tell the difference between "no such deck" and "that one never
 * finished".
 */
export interface DeckRow {
  deckId: string;
  title: string;
  slideCount: number;
  createdAt: number;
  updatedAt: number;
  savedAt: number | null;
}

export const SLIDES_STORE_TABLE = "slides_decks";

export const slidesDeckStore: PluginStore = {
  plugin: "slides",
  version: 1,
  ensureTables(sql) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS ${SLIDES_STORE_TABLE} (
        deck_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        slide_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        saved_at INTEGER
      )
    `);
  }
};

/**
 * The row as SQLite hands it back. A `type` rather than an `interface`, and that
 * is load-bearing: `sql.exec<T>` constrains `T` to `Record<string,
 * SqlStorageValue>`, and only a type alias gets the implicit index signature
 * that satisfies it.
 */
type Raw = {
  deck_id: string;
  title: string;
  slide_count: number;
  created_at: number;
  updated_at: number;
  saved_at: number | null;
};

const toRow = (r: Raw): DeckRow => ({
  deckId: r.deck_id,
  title: r.title,
  slideCount: r.slide_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  savedAt: r.saved_at
});

export interface DeckLedger {
  insert(deckId: string, title: string): void;
  get(deckId: string): DeckRow | null;
  list(limit?: number): DeckRow[];
  count(): number;
  recordSave(deckId: string, title: string, slideCount: number): void;
}

/**
 * The ledger's query half.
 *
 * Raw `sql.exec` rather than drizzle: six columns and five statements do not
 * earn a schema module, and every value here is bound rather than interpolated.
 * `arc-agi` reaches for drizzle because it has real predicates over a larger
 * table; this does not.
 */
export function makeDeckLedger(storage: DurableObjectStorage): DeckLedger {
  const sql = storage.sql;
  return {
    insert(deckId, title) {
      const now = Date.now();
      sql.exec(
        `INSERT INTO ${SLIDES_STORE_TABLE}
           (deck_id, title, slide_count, created_at, updated_at, saved_at)
         VALUES (?, ?, 0, ?, ?, NULL)
         ON CONFLICT (deck_id) DO NOTHING`,
        deckId,
        title,
        now,
        now
      );
    },

    get(deckId) {
      const rows = sql
        .exec<Raw>(
          `SELECT * FROM ${SLIDES_STORE_TABLE} WHERE deck_id = ?`,
          deckId
        )
        .toArray();
      return rows[0] ? toRow(rows[0]) : null;
    },

    list(limit = 10) {
      return sql
        .exec<Raw>(
          `SELECT * FROM ${SLIDES_STORE_TABLE} ORDER BY updated_at DESC LIMIT ?`,
          limit
        )
        .toArray()
        .map(toRow);
    },

    count() {
      const rows = sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${SLIDES_STORE_TABLE}`)
        .toArray();
      return rows[0]?.n ?? 0;
    },

    recordSave(deckId, title, slideCount) {
      const now = Date.now();
      // An upsert rather than an update: the row is normally there (deck_new put
      // it there), but a deck saved by a retry whose ledger write was lost must
      // still end up listed rather than becoming a PDF nobody can find again.
      sql.exec(
        `INSERT INTO ${SLIDES_STORE_TABLE}
           (deck_id, title, slide_count, created_at, updated_at, saved_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (deck_id) DO UPDATE SET
           title = excluded.title,
           slide_count = excluded.slide_count,
           updated_at = excluded.updated_at,
           saved_at = excluded.saved_at`,
        deckId,
        title,
        slideCount,
        now,
        now,
        now
      );
    }
  };
}
