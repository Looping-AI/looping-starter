import { definePlugin, type AgentPlugin } from "@loopingai/core";
import type { RecipeExecutionResult } from "@loopingai/core/subtasks";
import { browserPdf } from "agents/browser";
import type { QuickActionBinding } from "agents/browser";
import { makeReviewer, type Reviewer } from "./review";
import { buildSlidesTools, SLIDES_FAMILY, type SlidesRuntime } from "./family";
import { buildSlidesMainAgentTools } from "./main-agent";
import { pdfInput } from "./pdf";
import { SLIDES_SPEC, SLIDES_TYPE } from "./recipe";
import {
  deckUrl,
  getDeck,
  hasPdf,
  makeDeckLedger,
  slidesDeckStore,
  type DeckLedger
} from "./store";

/**
 * `slides` — design a deck, render it to PDF, deliver a link, and revise it on
 * the next message.
 *
 * A plugin this repo writes rather than installs, like `general.ts`: a plugin is
 * an object satisfying a contract, and `definePlugin` is available to the app
 * for exactly this. It is also where it belongs — `validateRecipe` refuses a
 * recipe with no soul rather than lending it one, and what a deck should look
 * like is this agent's opinion, not a library's.
 *
 * ## The three hooks, and why each one is where it is
 *
 * - **`toolFamilies`** runs on the *facet*. It is the only surface that mutates
 *   a deck.
 * - **`resolveRuntime`** runs on the *parent*, once per chunk, outside the
 *   request fingerprint. It resolves the model-supplied `deck_id` against this
 *   caller's ledger — which is exactly what `SubtaskTypeSpec` describes params
 *   as being: "ids it chose, validated for shape and resolved against durable
 *   rows at execution start". It is also the authorization boundary, because R2
 *   keys carry no caller segment (`PluginHost.callerKey()` throws on a facet).
 * - **`enrichResult`** runs on the *parent*, after a terminal result. It is what
 *   attaches the link, and it has to be here rather than in the child for two
 *   reasons: the child does not know the deployment's public origin, and only
 *   the parent can check that a PDF was actually written before promising one.
 *   `@loopingai/plugins/arc-agi` appends a score in the same place.
 */

/** How many slides one deck may hold, unless the host says otherwise. */
const DEFAULT_MAX_SLIDES = 20;

export interface SlidesConfig {
  /** The `BUCKET` R2 binding. Decks live under `decks/`. */
  bucket: R2Bucket;
  /**
   * The `BROWSER` binding. Browser Rendering is a **paid-plan** feature and has
   * no local mode, so `wrangler dev` needs `remote: true` and the test suite
   * uses {@link SlidesConfig.render} instead.
   */
  browser: QuickActionBinding;
  /** The Durable Object's storage, for the `slides_decks` ledger. */
  storage: DurableObjectStorage;
  /**
   * Public origin of this deployment, e.g. `https://agent.example.com` — the
   * `PUBLIC_BASE_URL` secret. Used to build the delivery URL, which is why it is
   * host config: the Durable Object has no request to read an origin from.
   */
  baseUrl: string;
  /** The `AI` binding — the visual reviewer's own model call. See `review.ts`. */
  ai: Ai;
  /**
   * The host's **resolved** AI Gateway id, so review calls land in the same
   * gateway as the agent's — which is what makes "did this run review its deck?"
   * answerable from `npm run cf -- ai`.
   */
  aiGatewayId?: string;
  maxSlides?: number;
  /** Vision model for `deck_review`. Must accept image input. */
  reviewModelId?: string;
  maxReviewSlides?: number;
  reviewMaxOutputTokens?: number;
  /** Test override: HTML → PDF bytes, skipping Browser Rendering entirely. */
  render?: (html: string) => Promise<Uint8Array>;
  /** Test override: an in-memory ledger, skipping SQLite. */
  ledger?: DeckLedger;
  /** Test override: a stub reviewer, skipping both the browser and the model. */
  reviewer?: Reviewer;
}

export function slides(config: SlidesConfig): AgentPlugin<SlidesRuntime> {
  const {
    bucket,
    browser,
    storage,
    baseUrl,
    ai,
    aiGatewayId,
    maxSlides = DEFAULT_MAX_SLIDES,
    reviewModelId,
    maxReviewSlides,
    reviewMaxOutputTokens
  } = config;

  // Lazy for the same reason the model inside it is: this factory runs at DO
  // start on both the parent and the facet, and `makeReviewer` must not touch a
  // binding until something actually reviews a deck.
  let cachedReviewer: Reviewer | undefined = config.reviewer;
  const reviewer = (): Reviewer =>
    (cachedReviewer ??= makeReviewer({
      ai,
      browser,
      ...(aiGatewayId ? { aiGatewayId } : {}),
      ...(reviewModelId ? { modelId: reviewModelId } : {}),
      ...(maxReviewSlides ? { maxSlides: maxReviewSlides } : {}),
      ...(reviewMaxOutputTokens
        ? { maxOutputTokens: reviewMaxOutputTokens }
        : {})
    }));

  // Built on first use, never at module scope, and never eagerly in this
  // factory: `makeDeckLedger` only wraps the storage handle, but this same
  // factory runs on the subagent facet too (its `plugins.ts` is the parent's),
  // where the ledger table does not exist because the facet builds no `AgentDB`.
  // Nothing down there calls a ledger method, and laziness is what keeps that
  // true by construction rather than by luck.
  let cached: DeckLedger | undefined = config.ledger;
  const ledger = (): DeckLedger => (cached ??= makeDeckLedger(storage));

  const renderPdf =
    config.render ??
    (async (html: string): Promise<Uint8Array> => {
      // Every option that matters is in `pdfInput`, where it can be asserted.
      // The two that are not merely tuning — `printBackground` and the explicit
      // page size — both defaulted wrong and shipped invisibly; see `pdf.ts`.
      const { data } = await browserPdf(browser, pdfInput(html));
      return data;
    });

  return definePlugin<SlidesRuntime>({
    key: "slides",

    subtaskType: SLIDES_SPEC,

    toolFamilies: {
      [SLIDES_FAMILY]: (ctx) => ({
        tools: buildSlidesTools(
          { bucket, renderPdf, maxSlides, reviewer: reviewer() },
          ctx
        )
      })
    },

    // No `capability` here: it lives on the subtask type, with the delegation
    // guidance it has to agree with. See `SLIDES_SPEC`.
    mainAgentTools: async () => {
      const store = ledger();
      return buildSlidesMainAgentTools(
        { ledger: store, bucket, baseUrl },
        store.count() > 0
      );
    },

    /**
     * Resolve the deck this execution is for.
     *
     * `known: false` rather than a throw. This is awaited inside the parent's
     * `prepareChunk`, where a rejection is a *transient fault* the Workflow
     * retries — so an id the caller does not own would retry forever instead of
     * being reported once. It travels into the execution and `deck_open` says
     * so, the same shape arc-agi uses for a missing `game_id`.
     *
     * Called once per chunk, so it stays a pure lookup: it mints nothing and
     * writes nothing, and re-running it on chunk 7 must mean what it meant on
     * chunk 0.
     */
    async resolveRuntime(ctx) {
      const deckId = ctx.params.deck_id ?? "";
      const row = deckId ? ledger().get(deckId) : null;
      return {
        deckId,
        known: row !== null,
        title: row?.title ?? "Untitled deck"
      };
    },

    /**
     * Attach the link, and record the save.
     *
     * The PDF is checked for rather than assumed. A run that spent its budget
     * before calling `deck_save` still returns a completed result — core's
     * `summarizeBudget` asks for a final report with no tools — and appending a
     * URL to it would hand the user a dead link for a deck that was never
     * rendered. So the honest answer is to append nothing and let the child's own
     * report explain itself.
     *
     * Safe to repeat on a Workflow step replay: two reads and an upsert.
     */
    async enrichResult(ctx, result): Promise<RecipeExecutionResult> {
      if (result.status !== "completed") return result;
      const { deckId } = ctx.runtime;
      if (!deckId) return result;

      const rendered = await hasPdf(bucket, deckId);
      if (!rendered) return result;

      const deck = await getDeck(bucket, deckId).catch(() => null);
      if (deck) {
        ledger().recordSave(deckId, deck.title, deck.slides.length);
      }

      return {
        ...result,
        resultParts: [
          ...result.resultParts,
          {
            kind: "text",
            text: `Deck link (give this to the user verbatim): ${deckUrl(baseUrl, deckId)}`
          }
        ]
      };
    },

    // No `onAbort`. A cancelled execution holds nothing outside this system: the
    // working copy dies with the facet, and R2 holds only what a completed
    // `deck_save` committed. Declaring an empty hook would imply otherwise.

    store: slidesDeckStore,

    // A plugin cannot add its own wrangler binding or secret, so declaring them
    // turns a missing one into a startup error naming this plugin rather than a
    // failed tool call inside a request someone is waiting on.
    //
    // `PUBLIC_BASE_URL` is in here rather than defaulted because there is no
    // honest default: an absent one silently produces `undefined/d/<id>.pdf`,
    // which renders in Slack as a link and fails only when somebody clicks it.
    requires: {
      bindings: ["BROWSER", "BUCKET"],
      secrets: ["PUBLIC_BASE_URL"]
    }
  });
}

export { SLIDES_FAMILY, SLIDES_TYPE };
export type { SlidesRuntime };
