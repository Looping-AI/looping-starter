import type { Block, Deck } from "./schema";

/**
 * The deck as the model reads it back.
 *
 * This is the *only* view either agent has of a deck's contents, so it carries
 * exactly what an op needs to be written: every slide id, every block id, its
 * type, its box, and enough of its text to tell two blocks apart. Ops address by
 * id (see `ops.ts`), which is why ids lead each line rather than being a detail
 * at the end.
 *
 * Deliberately terse. It is re-read after every `deck_apply`, and
 * `elideToolOutputs` keeps only the *newest* result per tool in the rolling
 * window — so this being small is what lets the model keep an accurate picture of
 * a 15-slide deck for the whole run.
 */

/** How much of a block's words to show. Enough to identify, not to re-read. */
const EXCERPT = 60;

function excerpt(block: Block): string {
  const raw = ((): string => {
    switch (block.type) {
      case "title":
      case "subtitle":
      case "text":
      case "logo":
        return block.props.text;
      case "bullets":
        return block.props.items.join(" · ");
      case "card":
        return [block.props.heading, block.props.body]
          .filter(Boolean)
          .join(" — ");
      case "image":
        return block.props.alt ?? "(image)";
      case "svg":
        return `(svg, ${block.props.markup.length} chars)`;
      case "arrow":
        return `(${block.props.dir})`;
      case "box":
      case "divider":
        return "";
    }
  })();
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  return flat.length > EXCERPT ? `"${flat.slice(0, EXCERPT)}…"` : `"${flat}"`;
}

export function outlineDeck(deck: Deck): string {
  const header = `"${deck.title}" — ${deck.slides.length} slide(s), ${deck.theme} theme`;
  const body = deck.slides.map((slide, i) => {
    const blocks = slide.blocks.map((b) => {
      const box = `${b.x},${b.y} ${b.w}×${b.h}`;
      return `    ${b.id}  ${b.type.padEnd(8)} [${box}] ${excerpt(b)}`.trimEnd();
    });
    const notes = slide.notes ? `    (notes: ${slide.notes.slice(0, 80)})` : "";
    return [
      `  ${slide.id}  (slide ${i + 1})`,
      ...blocks,
      ...(notes ? [notes] : [])
    ].join("\n");
  });
  return [header, ...body].join("\n");
}
