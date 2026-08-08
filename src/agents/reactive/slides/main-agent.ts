import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { DelegationNames } from "@loopingai/core";
import { outlineDeck } from "./outline";
import { newDeckId } from "./schema";
import {
  DeckReadError,
  deckUrl,
  getDeck,
  type DeckLedger,
  type DeckRow
} from "./store";

/**
 * The main agent's half: what it is told about decks, and the three tools it
 * gets.
 *
 * All three are **read-or-mint, never mutate**. Designing and revising both
 * happen in the subagent, under a soul with a budget and an op validator; the
 * main agent's job is to know which deck is being talked about and to hand the
 * link on. Splitting mutation across both surfaces would mean two copies of the
 * op vocabulary and two prompts describing it, which is exactly the drift
 * `SubtaskTypeSpec.capability` exists to end.
 *
 * `deck_new` is the one that mints, and it exists because of a type-level
 * constraint rather than a preference: `deck_id` cannot be an optional Subtask
 * param (see `recipe.ts`), so a new deck needs an id *before* the Subtask is
 * created. It is the same shape as `arc_list_games` → `game_id` — a tool result
 * the model quotes into `delegate`.
 */

export const SLIDES_CAPABILITY = [
  "You can produce slide decks. A deck is designed by a subagent and rendered to a PDF you link to.",
  "- `deck_new` mints an id for a new deck. Call it, then delegate a `slides` subtask quoting that id.",
  "- `deck_list` shows the decks this caller already has, with their ids and links.",
  "- `deck_outline` shows what is on a deck's slides, so you can answer a question about one without delegating.",
  "You never edit a deck yourself — every change, from a full rebuild to a single reworded heading, is a `slides` subtask against the deck's existing id. Reusing the id is what makes it an edit rather than a new deck.",
  "When a subtask returns a deck link, pass that URL through to the user exactly as given. Never invent, shorten or guess one."
].join("\n");

export const slidesDelegationGuidance = (names: DelegationNames): string =>
  [
    "## Slide decks",
    `Mint an id with \`deck_new\` (or find one with \`deck_list\`), then \`${names.delegateTool}\` a \`slides\` subtask quoting it.`,
    "To change an existing deck, delegate against the **same** id and say only what should change — the subagent reads the current deck itself, so do not restate its contents.",
    "Research first if the deck needs facts you do not have: a `general` subtask, with the `slides` subtask depending on it. Do not ask the slides subagent to look things up.",
    `If it is unclear which deck the user means, ask with \`${names.finalReplyTool}\` rather than guessing.`
  ].join("\n");

/** What the main-agent tools need from the host. */
export interface SlidesMainAgentDeps {
  ledger: DeckLedger;
  bucket: R2Bucket;
  baseUrl: string;
}

function describeRow(row: DeckRow, baseUrl: string): string {
  const when = new Date(row.updatedAt)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  return row.savedAt === null
    ? `- ${row.deckId} — "${row.title}" (started ${when}, never finished)`
    : `- ${row.deckId} — "${row.title}", ${row.slideCount} slide(s), updated ${when}\n  ${deckUrl(baseUrl, row.deckId)}`;
}

/**
 * Build the main agent's tools.
 *
 * `hasDecks` shapes the surface: `deck_list` and `deck_outline` are withheld
 * until there is something to list. A tool whose only possible answer is
 * "nothing here yet" costs the model a call to discover that and costs every
 * round the tokens to describe it — the plugin contract calls this out
 * explicitly, and it is why `mainAgentTools` may return a promise.
 */
export function buildSlidesMainAgentTools(
  deps: SlidesMainAgentDeps,
  hasDecks: boolean
): ToolSet {
  const tools: ToolSet = {
    deck_new: tool({
      description:
        "Mint an id for a NEW slide deck. Returns the id to quote as the `deck_id` param of a `slides` subtask. " +
        "Do not call this to change a deck that already exists — reuse its id instead.",
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe("Working title for the deck")
      }),
      execute: async ({ title }) => {
        const deckId = newDeckId();
        deps.ledger.insert(deckId, title);
        return `deck_id: ${deckId} (title "${title}"). Delegate a \`slides\` subtask with this exact id to build it.`;
      }
    })
  };

  if (!hasDecks) return tools;

  tools.deck_list = tool({
    description:
      "List this caller's slide decks, newest first, with their ids and links. " +
      "Use it to find the id of a deck the user wants changed.",
    inputSchema: z.object({}),
    execute: async () => {
      const rows = deps.ledger.list();
      if (rows.length === 0) return "No decks yet.";
      return rows.map((r) => describeRow(r, deps.baseUrl)).join("\n");
    }
  });

  tools.deck_outline = tool({
    description:
      "Show what is on a deck's slides — every slide, its blocks and their text. " +
      "Use this to answer a question about a deck without delegating.",
    inputSchema: z.object({
      deck_id: z.string().min(1).describe("An exact id from `deck_list`")
    }),
    execute: async ({ deck_id }) => {
      // The ledger is the authorization boundary: deck ids are unguessable, but
      // this is what makes "only this caller's decks" true by construction
      // rather than by improbability.
      if (deps.ledger.get(deck_id) === null) {
        return `No deck "${deck_id}" belongs to this caller. Use \`deck_list\`.`;
      }
      try {
        const deck = await getDeck(deps.bucket, deck_id);
        return deck === null
          ? "That deck was started but never finished, so it has no slides yet."
          : outlineDeck(deck);
      } catch (error) {
        if (!(error instanceof DeckReadError)) throw error;
        return error.message;
      }
    }
  });

  return tools;
}
