import { z } from "zod";
import {
  BLOCK_TYPES,
  blockSchema,
  slideSchema,
  type Block,
  type Deck,
  type Slide
} from "./schema";

/**
 * The edit vocabulary — a closed, validated set of operations over a {@link Deck}.
 *
 * This is the answer to "how does the subagent change a deck", and it is
 * deliberately *not* generated code. A deck's mutation surface is small and
 * enumerable, so an op can be **refused before it runs**: a bad edit becomes a
 * tool error the model corrects on its next turn, which a half-executed script
 * cannot be. It also keeps the whole edit path pure and testable with no model,
 * no binding and no network.
 *
 * Three rules run through every handler:
 *
 * 1. **Address by id, never by index.** The model works from an outline listing
 *    slide and block ids; an index is a number that silently means something
 *    different the moment an earlier op inserts or deletes.
 * 2. **Validate before mutating.** Each handler builds the new value, parses it,
 *    and only then splices it in — so a failed op leaves the deck exactly as it
 *    was without anyone having to clone it first. That is what lets a batch
 *    report per-op results instead of being all-or-nothing.
 * 3. **Every member is flat.** No op embeds a whole block or slide object. The
 *    union is what the `deck_apply` tool schema is generated from, and a
 *    discriminated union nested inside another one produces JSON Schema that the
 *    Workers AI models this agent runs on fill in unreliably. `add_block` takes
 *    its fields spread out and assembles them here instead.
 */

/** Ops accepted in one `deck_apply` call. A batch, not a program. */
export const MAX_OPS = 40;

/** Bounds the applier needs from the host's config. */
export interface OpLimits {
  maxSlides: number;
}

/**
 * A props patch: flat, JSON-Schema-friendly values only.
 *
 * The union is enumerated rather than left as `unknown` for the same reason the
 * ops are flat — `additionalProperties: true` is where a model's tool-call
 * filling degrades. Every prop the block schema declares is a string, number,
 * boolean or (for `bullets.items`) an array of strings, so nothing is lost.
 */
const propsPatch = z
  .record(
    z.string(),
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.string())
    ])
  )
  .describe("Props to merge into the target. A `null` value removes the key.");

const slideRef = z.string().min(1).describe("Slide id, from the outline");
const blockRef = z.string().min(1).describe("Block id, from the outline");

export const opSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("set_text"),
    slide: slideRef,
    block: blockRef,
    text: z
      .string()
      .describe("Replacement text. For a `bullets` block, one item per line.")
  }),
  z.strictObject({
    op: z.literal("set_props"),
    slide: slideRef,
    block: blockRef,
    props: propsPatch
  }),
  z.strictObject({
    op: z.literal("move_block"),
    slide: slideRef,
    block: blockRef,
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().optional(),
    h: z.number().optional()
  }),
  z.strictObject({
    op: z.literal("add_block"),
    slide: slideRef,
    block: z
      .string()
      .min(1)
      .describe("Id for the new block, unique on the slide"),
    type: z.enum(BLOCK_TYPES),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    props: propsPatch.describe("The new block's props, for its type")
  }),
  z.strictObject({
    op: z.literal("remove_block"),
    slide: slideRef,
    block: blockRef
  }),
  z.strictObject({
    op: z.literal("add_slide"),
    slide: z
      .string()
      .min(1)
      .describe("Id for the new slide, unique in the deck"),
    after: slideRef
      .optional()
      .describe("Insert after this slide id; omit to append at the end"),
    background: z
      .string()
      .optional()
      .describe("Background colour as hex, e.g. #0b1220"),
    dotGrid: z.boolean().optional()
  }),
  z.strictObject({ op: z.literal("remove_slide"), slide: slideRef }),
  z.strictObject({
    op: z.literal("reorder_slide"),
    slide: slideRef,
    after: slideRef
      .optional()
      .describe("Move to sit after this slide id; omit to move to the front")
  }),
  z.strictObject({
    op: z.literal("set_notes"),
    slide: slideRef,
    notes: z.string().describe("Speaker notes. Not rendered into the PDF.")
  }),
  z.strictObject({
    op: z.literal("restyle"),
    slide: slideRef.optional().describe("Limit to one slide; omit for all"),
    type: z
      .enum(BLOCK_TYPES)
      .optional()
      .describe("Limit to one block type; omit for all"),
    props: propsPatch
  }),
  z.strictObject({
    op: z.literal("set_deck"),
    title: z.string().max(200).optional(),
    theme: z.enum(["light", "dark"]).optional()
  })
]);

export type DeckOp = z.infer<typeof opSchema>;

export type OpResult =
  | { index: number; op: DeckOp["op"]; ok: true; note: string }
  | { index: number; op: DeckOp["op"]; ok: false; error: string };

/** A rejected op. Carries only a message — the model is the audience. */
class OpError extends Error {}

function fail(message: string): never {
  throw new OpError(message);
}

/** The first Zod issue, rendered as one line a model can act on. */
function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function findSlide(deck: Deck, id: string): { slide: Slide; index: number } {
  const index = deck.slides.findIndex((s) => s.id === id);
  if (index === -1) {
    fail(
      `no slide "${id}" — slides are ${deck.slides.map((s) => s.id).join(", ")}`
    );
  }
  return { slide: deck.slides[index], index };
}

function findBlock(slide: Slide, id: string): { block: Block; index: number } {
  const index = slide.blocks.findIndex((b) => b.id === id);
  if (index === -1) {
    fail(
      `no block "${id}" on slide "${slide.id}" — blocks are ` +
        (slide.blocks.map((b) => b.id).join(", ") || "(none)")
    );
  }
  return { block: slide.blocks[index], index };
}

/** Merge a patch into props: a defined value sets, `null` removes. */
function mergeProps(
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * Parse a block-shaped value and hand it back. The single place a block-shaped
 * mutation is validated, so `strictObject` catches an invented prop here and
 * names it, rather than the deck failing much later at save time.
 */
function parseBlock(candidate: unknown): Block {
  const parsed = blockSchema.safeParse(candidate);
  if (!parsed.success) fail(issueText(parsed.error));
  return parsed.data;
}

/**
 * The one type-aware helper the text ops need: which prop carries a block's
 * words. Returns null for blocks that have none, so `set_text` refuses them with
 * a message naming what it can target instead of writing a prop that would be
 * rejected two frames later.
 */
function textProp(block: Block): "text" | "items" | "body" | null {
  switch (block.type) {
    case "title":
    case "subtitle":
    case "text":
    case "logo":
      return "text";
    case "bullets":
      return "items";
    case "card":
      return "body";
    default:
      return null;
  }
}

/** Split a `set_text` payload into bullet items, tolerating list markers. */
function toItems(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((line) => line !== "");
}

function applyOne(deck: Deck, op: DeckOp, limits: OpLimits): string {
  switch (op.op) {
    case "set_text": {
      const { slide } = findSlide(deck, op.slide);
      const { block, index } = findBlock(slide, op.block);
      const prop = textProp(block);
      if (!prop) {
        fail(
          `a "${block.type}" block holds no text — use set_props to change it`
        );
      }
      const value = prop === "items" ? toItems(op.text) : op.text;
      slide.blocks[index] = parseBlock({
        ...block,
        props: { ...block.props, [prop]: value }
      });
      return `set ${prop} on ${op.slide}/${op.block}`;
    }

    case "set_props": {
      const { slide } = findSlide(deck, op.slide);
      const { block, index } = findBlock(slide, op.block);
      slide.blocks[index] = parseBlock({
        ...block,
        props: mergeProps(block.props, op.props)
      });
      return `updated props on ${op.slide}/${op.block}`;
    }

    case "move_block": {
      const { slide } = findSlide(deck, op.slide);
      const { block, index } = findBlock(slide, op.block);
      slide.blocks[index] = parseBlock({
        ...block,
        x: op.x ?? block.x,
        y: op.y ?? block.y,
        w: op.w ?? block.w,
        h: op.h ?? block.h
      });
      return `moved ${op.slide}/${op.block}`;
    }

    case "add_block": {
      const { slide } = findSlide(deck, op.slide);
      if (slide.blocks.some((b) => b.id === op.block)) {
        fail(`slide "${op.slide}" already has a block "${op.block}"`);
      }
      const block = parseBlock({
        id: op.block,
        type: op.type,
        x: op.x,
        y: op.y,
        w: op.w,
        h: op.h,
        // Through `mergeProps` rather than passed straight in: the patch type
        // admits `null` as "remove this key", and on a *new* block that reads as
        // "leave it unset" rather than as a null the block schema would refuse.
        props: mergeProps({}, op.props)
      });
      const parsed = slideSchema.safeParse({
        ...slide,
        blocks: [...slide.blocks, block]
      });
      if (!parsed.success) fail(issueText(parsed.error));
      slide.blocks.push(block);
      return `added ${op.type} "${op.block}" to ${op.slide}`;
    }

    case "remove_block": {
      const { slide } = findSlide(deck, op.slide);
      const { index } = findBlock(slide, op.block);
      slide.blocks.splice(index, 1);
      return `removed ${op.slide}/${op.block}`;
    }

    case "add_slide": {
      if (deck.slides.some((s) => s.id === op.slide)) {
        fail(`deck already has a slide "${op.slide}"`);
      }
      if (deck.slides.length >= limits.maxSlides) {
        fail(`this deck is capped at ${limits.maxSlides} slides`);
      }
      const parsed = slideSchema.safeParse({
        id: op.slide,
        blocks: [],
        ...(op.background !== undefined || op.dotGrid !== undefined
          ? {
              background: {
                ...(op.background !== undefined
                  ? { color: op.background }
                  : {}),
                ...(op.dotGrid !== undefined ? { dotGrid: op.dotGrid } : {})
              }
            }
          : {})
      });
      if (!parsed.success) fail(issueText(parsed.error));
      const at =
        op.after === undefined
          ? deck.slides.length
          : findSlide(deck, op.after).index + 1;
      deck.slides.splice(at, 0, parsed.data);
      return `added empty slide "${op.slide}" at position ${at + 1} — add blocks to it next`;
    }

    case "remove_slide": {
      if (deck.slides.length === 1) fail("a deck must keep at least one slide");
      const { index } = findSlide(deck, op.slide);
      deck.slides.splice(index, 1);
      return `removed slide "${op.slide}"`;
    }

    case "reorder_slide": {
      const { index } = findSlide(deck, op.slide);
      if (op.after === op.slide) fail("a slide cannot move after itself");
      // Resolve the anchor *before* the splice: removing the slide shifts every
      // later index, and reading the anchor afterwards moved it by one.
      const anchor =
        op.after === undefined ? -1 : findSlide(deck, op.after).index;
      const [moved] = deck.slides.splice(index, 1);
      const at = anchor === -1 ? 0 : anchor < index ? anchor + 1 : anchor;
      deck.slides.splice(at, 0, moved);
      return `moved slide "${op.slide}" to position ${at + 1}`;
    }

    case "set_notes": {
      const { slide, index } = findSlide(deck, op.slide);
      const parsed = slideSchema.safeParse({ ...slide, notes: op.notes });
      if (!parsed.success) fail(issueText(parsed.error));
      deck.slides[index] = parsed.data;
      return `set notes on ${op.slide}`;
    }

    case "restyle": {
      const slides = op.slide ? [findSlide(deck, op.slide).slide] : deck.slides;
      let touched = 0;
      for (const slide of slides) {
        for (const [index, block] of slide.blocks.entries()) {
          if (op.type && block.type !== op.type) continue;
          slide.blocks[index] = parseBlock({
            ...block,
            props: mergeProps(block.props, op.props)
          });
          touched += 1;
        }
      }
      if (touched === 0) fail("that selection matched no blocks");
      return `restyled ${touched} block(s)`;
    }

    case "set_deck": {
      if (op.title !== undefined) deck.title = op.title;
      if (op.theme !== undefined) deck.theme = op.theme;
      return "updated deck settings";
    }
  }
}

/**
 * Apply a batch in order, reporting each op independently.
 *
 * Partial success is the point: a model that gets six of seven ops right should
 * keep the six and be told about the one, rather than having a whole turn's work
 * discarded over a typo in an id. `deck` is mutated in place — handlers validate
 * before they write, so a rejected op has changed nothing.
 */
export function applyOps(
  deck: Deck,
  ops: readonly DeckOp[],
  limits: OpLimits
): { deck: Deck; results: OpResult[] } {
  const results: OpResult[] = [];
  for (const [index, op] of ops.entries()) {
    try {
      results.push({
        index,
        op: op.op,
        ok: true,
        note: applyOne(deck, op, limits)
      });
    } catch (error) {
      if (!(error instanceof OpError)) throw error;
      results.push({ index, op: op.op, ok: false, error: error.message });
    }
  }
  return { deck, results };
}

/** Op results as the lines the model reads back. */
export function formatResults(results: readonly OpResult[]): string {
  return results
    .map((r) =>
      r.ok ? `${r.index}. ok — ${r.note}` : `${r.index}. FAILED — ${r.error}`
    )
    .join("\n");
}
