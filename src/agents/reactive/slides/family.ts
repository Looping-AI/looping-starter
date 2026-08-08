import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolFamilyContext, WorkspaceHandle } from "@loopingai/core";
import type { Reviewer } from "./review";
import { formatFindings, lintDeck } from "./lint";
import { applyOps, formatResults, MAX_OPS, opSchema } from "./ops";
import { outlineDeck } from "./outline";
import { renderDeckHtml } from "./render";
import { blankDeck, deckSchema, MAX_DECK_BYTES, type Deck } from "./schema";
import { DeckReadError, getDeck, putDeck } from "./store";

/**
 * The subagent's tool family — the only surface that mutates a deck.
 *
 * ## The working copy, and why there is one
 *
 * Edits land on a copy in the execution's **workspace**, and only `deck_save`
 * writes to R2. Two facts about `@loopingai/core`'s subagent force that shape:
 *
 * - The facet caches one terminal result per request fingerprint and *replays*
 *   it on retry, and a Workflow step may re-run a chunk after a crash. So every
 *   write on this path has to be safe to repeat. A whole-deck PUT keyed by
 *   `deckId` is; a stream of per-op writes to R2 is not.
 * - The workspace is destroyed with the child (after delivery, on cancellation,
 *   and on the fingerprint-mismatch recreate). So it is *scratch* — perfect for
 *   a draft, useless for the artifact — and `deck_open` must be able to re-seed
 *   from R2 at any chunk boundary, which is exactly what happens after a
 *   recreate.
 *
 * The cost is that an interrupted run loses its uncommitted edits. That is the
 * right failure: the previous deck stays intact and nobody is handed half a
 * revision. The soul tells the model so.
 *
 * ## `deckId` is never a tool argument
 *
 * It arrives on `ctx.runtime`, resolved by the parent against the caller's own
 * ledger before the execution started. A model that could pass a deck id could
 * pass someone else's.
 */

/** This family's name, as a recipe's `toolFamilies` lists it. */
export const SLIDES_FAMILY = "slides";

/** Where the draft lives inside the execution's workspace. */
const WORKING_PATH = "deck.json";

/**
 * Session state the parent resolves for one execution.
 *
 * `known` rather than a throw: `resolveRuntime` is awaited inside the parent's
 * `prepareChunk`, where a rejection is a transient fault the Workflow retries
 * forever. An id the caller does not own has to travel *into* the execution and
 * be reported by a tool — the same shape `@loopingai/plugins/arc-agi` uses for a
 * missing `game_id`.
 *
 * **Every field is optional**, matching `ArcRuntime`. That is a type-level
 * requirement rather than a statement about the data: core's `SubtaskRuntime` is
 * `Record<string, unknown>`, and a `ToolFamilyBuilder` is a function *parameter*
 * position — so `AgentPlugin<SlidesRuntime>` only lands in an `AgentPlugin[]` if
 * a bare runtime bag is assignable to this, which all-optional is what buys. The
 * tools below therefore read it defensively, once, at the top.
 */
export type SlidesRuntime = {
  deckId?: string;
  /** Whether this deck id appears in the calling agent's ledger. */
  known?: boolean;
  /** The title recorded at `deck_new`, seeding a deck that does not exist yet. */
  title?: string;
};

/** What the family needs from the host, closed over so none of it is model input. */
export interface SlidesFamilyDeps {
  bucket: R2Bucket;
  /**
   * HTML → PDF bytes. A function rather than the `BROWSER` binding so tests can
   * substitute one: Browser Rendering has no local mode, and the vitest pool runs
   * with `remoteBindings: false`.
   */
  renderPdf: (html: string) => Promise<Uint8Array>;
  maxSlides: number;
  /**
   * The visual reviewer behind `deck_review` — the only way this execution can
   * see what it actually produced. See `review.ts` for why it is a model call
   * this plugin owns rather than an image handed back to the tool loop.
   */
  reviewer: Reviewer;
}

const NO_DRAFT =
  "No deck is open in this execution. Call `deck_open` first — it loads the deck you were given.";

/** Read the working copy, or null if `deck_open` has not run. */
async function readDraft(workspace: WorkspaceHandle): Promise<Deck | null> {
  const raw = await workspace.read(WORKING_PATH);
  if (raw === null) return null;
  // Parsed rather than trusted. The file is ours, but it survives chunk
  // boundaries and isolate restarts, and a schema change between deploys would
  // otherwise surface as a renderer crash instead of a readable message.
  return deckSchema.parse(JSON.parse(raw));
}

/** Write the working copy back, refusing a draft that outgrew the workspace. */
async function writeDraft(
  workspace: WorkspaceHandle,
  deck: Deck
): Promise<string | null> {
  const json = JSON.stringify(deck);
  if (json.length > MAX_DECK_BYTES) {
    return (
      `This deck is ${Math.round(json.length / 1024)} KiB, over the ` +
      `${Math.round(MAX_DECK_BYTES / 1024)} KiB limit. Nothing was changed — ` +
      "remove an image or shorten the longest text blocks."
    );
  }
  await workspace.write(WORKING_PATH, json);
  return null;
}

export function buildSlidesTools(
  deps: SlidesFamilyDeps,
  ctx: ToolFamilyContext<SlidesRuntime>
): ToolSet {
  const { workspace, runtime } = ctx;
  // Narrowed once, here. The runtime bag is optional-by-type (see
  // `SlidesRuntime`), and an execution that reached this family always has a
  // deck id resolved for it — but "always" is a claim about the parent, not
  // something the type can carry, so an absent one degrades to `known: false`
  // and is reported like any other unusable id.
  const deckId = runtime.deckId ?? "";
  const known = runtime.known === true && deckId !== "";
  const title = runtime.title ?? "Untitled deck";

  /** The guard every tool opens with. Reported, never thrown — see {@link SlidesRuntime}. */
  const unavailable = (): string | null =>
    known
      ? null
      : `Deck "${deckId}" is not one of this caller's decks, so it cannot be opened or changed. Report that and stop.`;

  return {
    deck_open: tool({
      description:
        "Load the deck you were given into this execution and show its outline. " +
        "Call this first, always. If the deck has no content yet you get a blank one to build on.",
      inputSchema: z.object({}),
      execute: async () => {
        const blocked = unavailable();
        if (blocked) return blocked;
        let stored: Deck | null;
        try {
          stored = await getDeck(deps.bucket, deckId);
        } catch (error) {
          if (!(error instanceof DeckReadError)) throw error;
          return `${error.message} — report this and stop; do not start over on top of it.`;
        }
        const deck = stored ?? blankDeck(deckId, title);
        const refused = await writeDraft(workspace, deck);
        if (refused) return refused;
        return [
          stored
            ? "Opened the existing deck."
            : "No deck yet — started a blank one.",
          outlineDeck(deck)
        ].join("\n");
      }
    }),

    deck_outline: tool({
      description:
        "Show the current outline: every slide id, every block id, its type, its box and its text. " +
        "Ops address slides and blocks by these ids.",
      inputSchema: z.object({}),
      execute: async () => {
        const deck = await readDraft(workspace);
        return deck === null ? NO_DRAFT : outlineDeck(deck);
      }
    }),

    deck_apply: tool({
      description:
        "Apply a batch of edits to the deck. Ops run in order and are reported individually — " +
        "one bad op does not discard the rest of the batch. Batch related changes into a single call " +
        "rather than making one call per block. Nothing is published until `deck_save`.",
      inputSchema: z.object({
        ops: z.array(opSchema).min(1).max(MAX_OPS)
      }),
      execute: async ({ ops }) => {
        const blocked = unavailable();
        if (blocked) return blocked;
        const deck = await readDraft(workspace);
        if (deck === null) return NO_DRAFT;
        const { results } = applyOps(deck, ops, { maxSlides: deps.maxSlides });
        const refused = await writeDraft(workspace, deck);
        if (refused) return refused;
        return [formatResults(results), "", outlineDeck(deck)].join("\n");
      }
    }),

    deck_lint: tool({
      description:
        "Check the deck for layout problems you cannot see: text that will overflow its box, " +
        "blocks off the canvas, collisions, empty slides. Run this before saving and fix what it reports.",
      inputSchema: z.object({}),
      execute: async () => {
        const deck = await readDraft(workspace);
        if (deck === null) return NO_DRAFT;
        return formatFindings(lintDeck(deck));
      }
    }),

    deck_review: tool({
      description:
        "Look at the rendered slides and get a critique back. This is the only way to see what you have actually made — " +
        "`deck_lint` checks geometry, but it cannot tell you a slide reads as empty, that the emphasis is on the wrong line, " +
        "or that a colour did not come out. Run it once the deck is complete and lint is clean, then fix what it reports.",
      inputSchema: z.object({
        slides: z
          .array(z.string())
          .optional()
          .describe(
            "Slide ids to review. Omit to review the deck from the start."
          )
      }),
      execute: async ({ slides }) => {
        const deck = await readDraft(workspace);
        if (deck === null) return NO_DRAFT;
        return deps.reviewer.review(deck, slides);
      }
    }),

    deck_save: tool({
      description:
        "Render the deck to PDF and publish it. This is the only step that makes anything durable. " +
        "Call it once, at the end, when the deck is complete and `deck_lint` is clean.",
      inputSchema: z.object({}),
      execute: async () => {
        const blocked = unavailable();
        if (blocked) return blocked;
        const deck = await readDraft(workspace);
        if (deck === null) return NO_DRAFT;

        let pdf: Uint8Array;
        try {
          pdf = await deps.renderPdf(renderDeckHtml(deck));
        } catch (error) {
          // Returned, not thrown. A render failure is frequently transient
          // (Browser Rendering is a remote service), and the model's options are
          // to retry or to report — both of which need it to know what happened.
          // Throwing would end the tool loop with an opaque step error instead.
          return `Rendering failed: ${String(error)}. The deck is unchanged; you may try \`deck_save\` once more, and report the failure if it persists.`;
        }
        await putDeck(deps.bucket, deck, pdf);

        const findings = lintDeck(deck);
        return [
          `Saved "${deck.title}" — ${deck.slides.length} slide(s), ${Math.round(pdf.length / 1024)} KiB.`,
          findings.length > 0
            ? `Saved with ${findings.length} outstanding layout warning(s).`
            : "Layout is clean.",
          "The parent agent attaches the link; do not invent a URL."
        ].join("\n");
      }
    })
  };
}
