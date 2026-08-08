import { z } from "zod";

/**
 * The deck document — the one representation everything else in this directory
 * agrees on.
 *
 * Modelled on Cloudflare OS's `workspace.1` slide format (`{ slides: [{ id,
 * background, blocks: [{ id, type, x, y, w, h, props }] }] }` in a 1200×675
 * coordinate space), because it is a proven model-friendly shape: absolute
 * geometry with no layout engine to reason about, and a small closed vocabulary
 * of block types. Cloudflare's version lives in a Durable Object and is rendered
 * by a hand-written client; ours is a JSON object in R2 rendered to HTML and then
 * to PDF. The schema is deliberately close enough that a deck could be handed to
 * a Cloudflare OS gadget later.
 *
 * Two properties here are load-bearing rather than tidy, and both exist because
 * **every value in this document is model output that ends up inside a rendered
 * HTML page**:
 *
 * 1. **Nothing may reference the network.** `browserPdf` renders our HTML with no
 *    origin behind it, so an external URL is at best a blank box and at worst a
 *    request we did not intend to make. Images are data URIs only, and inline SVG
 *    is screened for remote references (see {@link svgMarkup}).
 * 2. **Free-form strings never reach a CSS value.** Colours and sizes are
 *    constrained here — to a hex pattern and to a token enum — so that a model
 *    cannot put `url(…)` or an arbitrary declaration into a style attribute. The
 *    renderer HTML-escapes text; this file is what keeps everything that is *not*
 *    text from needing escaping at all.
 */

/** Schema tag persisted with every deck, so a future migration can branch. */
export const DECK_SCHEMA = "looping.slides.1";

/** Slide coordinate space. Every `x`/`y`/`w`/`h` is in these units. */
export const SLIDE_WIDTH = 1200;
export const SLIDE_HEIGHT = 675;

/** Hard ceilings, independent of the configurable `maxSlides`. */
export const MAX_BLOCKS_PER_SLIDE = 24;
export const MAX_TEXT_CHARS = 2_000;
export const MAX_BULLETS = 12;
export const MAX_SVG_CHARS = 8_000;
/**
 * Per-image data-URI ceiling.
 *
 * Small, and bounded by something specific: an image is carried *inside* the
 * deck JSON, and the deck JSON is held as a single file in the execution's
 * workspace, which core caps at `WORKSPACE_MAX_FILE_BYTES` (512 KiB). One
 * generous image would spend the whole budget and make every subsequent
 * `deck_apply` fail on a limit the model cannot see.
 *
 * There is also no image *source* in this build — no image model, and the
 * renderer cannot fetch a URL — so the type exists for schema completeness and
 * for a caller who supplies one. Diagrams are `svg` blocks.
 */
export const MAX_IMAGE_CHARS = 64 * 1024;

/**
 * Serialized deck ceiling, checked before the working copy is written.
 *
 * Under core's 512 KiB `WORKSPACE_MAX_FILE_BYTES` with room to spare, so the
 * failure the model meets is this message rather than a `WorkspaceLimitError`
 * raised from inside a write it did not know was near a limit.
 */
export const MAX_DECK_BYTES = 400 * 1024;

/** A deck id: 128 bits of randomness, lowercase hex. Also the capability. */
export const DECK_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Mint a deck id. The id *is* the capability in the delivery URL — see `index.ts`. */
export function newDeckId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const deckId = z.string().regex(DECK_ID_PATTERN, "not a deck id");

/**
 * A colour, constrained to `#rgb` / `#rrggbb` / `#rrggbbaa`.
 *
 * Not cosmetic: these land in `style="…"` attributes. A free-form string there
 * accepts `url(https://…)`, which would defeat the offline-render invariant, and
 * accepts a `;` that closes the declaration and opens another.
 */
const color = z
  .string()
  .regex(
    /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
    "colours must be hex, e.g. #1f2937"
  );

/** Text scale as a token, never a number — a model asked for px will pick 400. */
const size = z.enum(["sm", "md", "lg", "xl"]);
const align = z.enum(["left", "center", "right"]);

const text = (max = MAX_TEXT_CHARS) => z.string().max(max);

/** Block/slide ids are model-authored labels, so keep them boring and quotable. */
const nodeId = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-zA-Z0-9_-]+$/, "ids may use letters, digits, '-' and '_' only");

/**
 * Inline SVG markup, screened for anything that reaches outside the page.
 *
 * A refinement rather than a sanitizer on purpose: rewriting model output means
 * rendering something the model did not write and cannot see, so a deck that
 * looks wrong has no explanation. Rejecting hands the model a tool error it can
 * act on, which is the same contract every other op has.
 */
const svgMarkup = z
  .string()
  .min(1)
  .max(MAX_SVG_CHARS)
  .refine((s) => !/<\s*(script|foreignObject|iframe|use)\b/i.test(s), {
    message: "svg may not contain <script>, <foreignObject>, <iframe> or <use>"
  })
  .refine((s) => !/\bon[a-z]+\s*=/i.test(s), {
    message: "svg may not carry event handler attributes"
  })
  .refine((s) => !/(?:xlink:)?href\s*=\s*["']?(?!#)/i.test(s), {
    message:
      "svg may not reference anything outside itself — draw shapes and paths, not links or external images"
  });

/** A data URI for an inline image. No `http(s):` — see the note at the top. */
const dataUri = z
  .string()
  .max(MAX_IMAGE_CHARS)
  .regex(
    /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/,
    "images must be base64 data URIs"
  );

/**
 * The block vocabulary — a discriminated union, so the renderer switches
 * exhaustively and an unknown `type` is refused here rather than silently
 * rendering as nothing.
 *
 * Geometry (`x`, `y`, `w`, `h`) is shared and lives at the top level; everything
 * type-specific is under `props`, which is `strictObject` throughout: a prop the
 * model invented is an error it can see, not intent that vanishes.
 */
const geometry = {
  id: nodeId,
  x: z
    .number()
    .min(-SLIDE_WIDTH)
    .max(SLIDE_WIDTH * 2),
  y: z
    .number()
    .min(-SLIDE_HEIGHT)
    .max(SLIDE_HEIGHT * 2),
  w: z
    .number()
    .min(1)
    .max(SLIDE_WIDTH * 2),
  h: z
    .number()
    .min(1)
    .max(SLIDE_HEIGHT * 2)
};

export const blockSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...geometry,
    type: z.literal("title"),
    props: z.strictObject({
      text: text(300),
      align: align.optional(),
      size: size.optional(),
      color: color.optional()
    })
  }),
  z.strictObject({
    ...geometry,
    type: z.literal("subtitle"),
    props: z.strictObject({
      text: text(300),
      align: align.optional(),
      color: color.optional()
    })
  }),
  z.strictObject({
    ...geometry,
    type: z.literal("text"),
    props: z.strictObject({
      text: text(),
      align: align.optional(),
      size: size.optional(),
      color: color.optional()
    })
  }),
  z.strictObject({
    ...geometry,
    type: z.literal("bullets"),
    props: z.strictObject({
      items: z.array(text(400)).min(1).max(MAX_BULLETS),
      size: size.optional(),
      color: color.optional()
    })
  }),
  z.strictObject({
    ...geometry,
    type: z.literal("card"),
    props: z.strictObject({
      heading: text(200).optional(),
      body: text(800).optional(),
      accent: color.optional(),
      fill: color.optional()
    })
  }),
  z.strictObject({
    ...geometry,
    type: z.literal("box"),
    props: z.strictObject({
      fill: color.optional(),
      stroke: color.optional(),
      radius: z.number().min(0).max(64).optional()
    })
  }),
  z.strictObject({
    ...geometry,
    type: z.literal("arrow"),
    props: z.strictObject({
      dir: z.enum(["right", "left", "up", "down"]),
      stroke: color.optional()
    })
  }),
  z.strictObject({
    ...geometry,
    type: z.literal("divider"),
    props: z.strictObject({ stroke: color.optional() })
  }),
  z.strictObject({
    ...geometry,
    type: z.literal("image"),
    props: z.strictObject({ dataUri, alt: text(200).optional() })
  }),
  z.strictObject({
    ...geometry,
    type: z.literal("svg"),
    props: z.strictObject({ markup: svgMarkup })
  }),
  z.strictObject({
    ...geometry,
    type: z.literal("logo"),
    props: z.strictObject({ text: text(60), color: color.optional() })
  })
]);

export const slideSchema = z.strictObject({
  id: nodeId,
  background: z
    .strictObject({
      color: color.optional(),
      dotGrid: z.boolean().optional()
    })
    .optional(),
  notes: text(1_000).optional(),
  blocks: z.array(blockSchema).max(MAX_BLOCKS_PER_SLIDE)
});

export const deckSchema = z.strictObject({
  schema: z.literal(DECK_SCHEMA),
  deckId,
  title: text(200),
  theme: z.enum(["light", "dark"]),
  slides: z.array(slideSchema).min(1)
});

export type Block = z.infer<typeof blockSchema>;
export type BlockType = Block["type"];
export type Slide = z.infer<typeof slideSchema>;
export type Deck = z.infer<typeof deckSchema>;

/** Every block type, for tool descriptions and the op schema's `select`. */
export const BLOCK_TYPES = [
  "title",
  "subtitle",
  "text",
  "bullets",
  "card",
  "box",
  "arrow",
  "divider",
  "image",
  "svg",
  "logo"
] as const satisfies readonly BlockType[];

/**
 * A new, empty deck: one title slide and nothing else.
 *
 * Deliberately minimal. A richer starting template reads to a model as content
 * it should keep, and the decks that came back were the template with the words
 * changed.
 */
export function blankDeck(
  id: string,
  title: string,
  theme: Deck["theme"] = "light"
): Deck {
  return {
    schema: DECK_SCHEMA,
    deckId: id,
    title,
    theme,
    slides: [
      {
        id: "s1",
        blocks: [
          {
            id: "t1",
            type: "title",
            x: 96,
            y: 260,
            w: 1008,
            h: 120,
            props: { text: title, align: "left", size: "xl" }
          }
        ]
      }
    ]
  };
}
