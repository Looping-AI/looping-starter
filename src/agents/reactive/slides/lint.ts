import { SIZE_PX } from "./render";
import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type Block,
  type Deck,
  type Slide
} from "./schema";

/**
 * Deterministic layout review — the substitute for letting the model look at
 * its own deck.
 *
 * A visual preview is the obvious design and it does not work here: the models
 * this agent runs on (`@cf/zai-org/glm-5.2`, `@cf/moonshotai/kimi-k2.7-code`) are
 * not reliably multimodal, so a rendered PNG is a tool result they cannot read.
 * But the failures that a human would catch by looking — text overflowing its
 * box, a block off the canvas, two blocks on top of each other — are all
 * *already in the JSON*. So we compute them instead, and hand back sentences.
 *
 * Everything here is an estimate, deliberately conservative: a false "this may
 * overflow" costs a model one adjustment, while a missed one costs a clipped
 * slide in a PDF nobody re-reads. Pure, so it tests without a renderer.
 */

export interface Finding {
  slide: string;
  block?: string;
  kind: "offcanvas" | "overflow" | "overlap" | "empty" | "tiny";
  message: string;
}

/** Average glyph width as a fraction of font size, for the fit estimate. */
const GLYPH_RATIO = 0.52;
/** Line box as a multiple of font size — matches the renderer's `line-height`. */
const LINE_HEIGHT = 1.45;
/** Below this fraction of overlap, two boxes are adjacent rather than colliding. */
const OVERLAP_TOLERANCE = 0.18;

/** The text a block will actually render, and the size it renders at. */
function textOf(block: Block): { chars: number; px: number } | null {
  switch (block.type) {
    case "title":
      return {
        chars: block.props.text.length,
        px: SIZE_PX[block.props.size ?? "xl"]
      };
    case "subtitle":
      return { chars: block.props.text.length, px: SIZE_PX.lg };
    case "text":
      return {
        chars: block.props.text.length,
        px: SIZE_PX[block.props.size ?? "md"]
      };
    case "bullets": {
      const px = SIZE_PX[block.props.size ?? "md"];
      // Each item starts a line however short it is, so bill a full line per
      // item and let the wrap estimate add to it.
      const chars = block.props.items.reduce(
        (sum, item) => sum + item.length,
        0
      );
      return { chars, px };
    }
    case "card": {
      const heading = block.props.heading?.length ?? 0;
      const body = block.props.body?.length ?? 0;
      return { chars: heading + body, px: SIZE_PX.sm };
    }
    case "logo":
      return { chars: block.props.text.length, px: SIZE_PX.sm };
    default:
      return null;
  }
}

/** Estimated rendered height of a block's text at its box width. */
function estimatedHeight(block: Block): number | null {
  const measured = textOf(block);
  if (!measured || measured.chars === 0) return null;
  const inner = block.type === "card" ? block.w - 48 : block.w;
  const perLine = Math.max(1, Math.floor(inner / (measured.px * GLYPH_RATIO)));
  let lines = Math.ceil(measured.chars / perLine);
  if (block.type === "bullets") {
    // At least one line per item, whatever the wrap estimate said.
    lines = Math.max(lines, block.props.items.length);
  }
  if (block.type === "card" && block.props.heading) lines += 1;
  const padding = block.type === "card" ? 44 : 0;
  return lines * measured.px * LINE_HEIGHT + padding;
}

/** Fractional area of `a` covered by `b`. */
function overlapFraction(a: Block, b: Block): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (a.w * a.h);
}

/**
 * Blocks that are *meant* to sit under other things. A `box` is a background
 * panel and a `card` is a container — flagging either for overlapping the text
 * it exists to hold would make the whole check noise.
 */
const BACKDROP_TYPES = new Set<Block["type"]>(["box", "card", "image", "svg"]);

function lintSlide(slide: Slide): Finding[] {
  const findings: Finding[] = [];

  if (slide.blocks.length === 0) {
    findings.push({
      slide: slide.id,
      kind: "empty",
      message: "slide has no blocks"
    });
    return findings;
  }

  for (const block of slide.blocks) {
    if (
      block.x < 0 ||
      block.y < 0 ||
      block.x + block.w > SLIDE_WIDTH ||
      block.y + block.h > SLIDE_HEIGHT
    ) {
      findings.push({
        slide: slide.id,
        block: block.id,
        kind: "offcanvas",
        message:
          `extends past the ${SLIDE_WIDTH}×${SLIDE_HEIGHT} canvas ` +
          `(x ${block.x}…${block.x + block.w}, y ${block.y}…${block.y + block.h})`
      });
    }

    if (block.w < 40 || block.h < 24) {
      findings.push({
        slide: slide.id,
        block: block.id,
        kind: "tiny",
        message: `is ${block.w}×${block.h} — too small to render legibly`
      });
    }

    const needed = estimatedHeight(block);
    if (needed !== null && needed > block.h * 1.05) {
      findings.push({
        slide: slide.id,
        block: block.id,
        kind: "overflow",
        message:
          `text needs about ${Math.ceil(needed)}px but the box is ${block.h}px ` +
          "— shorten it, widen the box, or drop a size"
      });
    }
  }

  for (const [i, a] of slide.blocks.entries()) {
    for (const b of slide.blocks.slice(i + 1)) {
      if (BACKDROP_TYPES.has(a.type) || BACKDROP_TYPES.has(b.type)) continue;
      const fraction = Math.max(overlapFraction(a, b), overlapFraction(b, a));
      if (fraction > OVERLAP_TOLERANCE) {
        findings.push({
          slide: slide.id,
          block: a.id,
          kind: "overlap",
          message: `overlaps "${b.id}" by ${Math.round(fraction * 100)}%`
        });
      }
    }
  }

  return findings;
}

export function lintDeck(deck: Deck): Finding[] {
  return deck.slides.flatMap(lintSlide);
}

/** Findings as the lines a model reads back. */
export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return "No layout problems found.";
  return findings
    .map((f) => `- ${f.slide}${f.block ? `/${f.block}` : ""}: ${f.message}`)
    .join("\n");
}
