import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type Block,
  type Deck,
  type Slide
} from "./schema";

/**
 * `Deck` → a single self-contained HTML document, ready for `browserPdf`.
 *
 * Pure, synchronous, and **offline**: no stylesheet link, no webfont, no image
 * host, no script. That is not a preference — `browserPdf` renders this string
 * with no origin behind it, so anything the page tries to fetch is a request we
 * did not intend and a box that renders empty. `render.spec.ts` asserts the
 * output contains no external reference, which is the cheapest possible guard on
 * the property the whole rendering path depends on.
 *
 * Being pure is the other half: the entire visual layer is testable with no
 * model, no binding and no network, which is what keeps the expensive end-to-end
 * run for the things only it can tell us.
 */

/**
 * Size tokens → px. Tokens exist so a model cannot ask for 400px type.
 *
 * Exported because `lint.ts` estimates whether text will fit, and an estimate
 * built on different numbers from the renderer's is an estimate of nothing.
 */
export const SIZE_PX = { sm: 20, md: 26, lg: 36, xl: 64 } as const;

interface Palette {
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  rule: string;
  surface: string;
}

const PALETTES: Record<Deck["theme"], Palette> = {
  light: {
    bg: "#ffffff",
    fg: "#111827",
    muted: "#4b5563",
    accent: "#2563eb",
    rule: "#e5e7eb",
    surface: "#f9fafb"
  },
  dark: {
    bg: "#0b1220",
    fg: "#f3f4f6",
    muted: "#9ca3af",
    accent: "#60a5fa",
    rule: "#1f2937",
    surface: "#111a2b"
  }
};

/**
 * HTML-escape a text value.
 *
 * Every string that reaches the page goes through here — the one exception is
 * `svg.props.markup`, which is markup by definition and is screened in
 * `schema.ts` instead. Quotes are escaped too because these values also land in
 * attributes (`alt`).
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The absolute box every block sits in. */
function boxStyle(block: Block): string {
  return `left:${block.x}px;top:${block.y}px;width:${block.w}px;height:${block.h}px`;
}

function renderBlock(block: Block, p: Palette): string {
  const box = boxStyle(block);

  switch (block.type) {
    case "title": {
      const { text, align = "left", size = "xl", color = p.fg } = block.props;
      return `<div class="b" style="${box};display:flex;align-items:center;justify-content:${flex(align)}"><span style="font-size:${SIZE_PX[size]}px;font-weight:700;line-height:1.1;letter-spacing:-0.02em;color:${color};text-align:${align}">${esc(text)}</span></div>`;
    }
    case "subtitle": {
      const { text, align = "left", color = p.muted } = block.props;
      return `<div class="b" style="${box};display:flex;align-items:center;justify-content:${flex(align)}"><span style="font-size:${SIZE_PX.lg}px;font-weight:500;line-height:1.25;color:${color};text-align:${align}">${esc(text)}</span></div>`;
    }
    case "text": {
      const { text, align = "left", size = "md", color = p.fg } = block.props;
      return `<div class="b" style="${box};font-size:${SIZE_PX[size]}px;line-height:1.45;color:${color};text-align:${align};white-space:pre-wrap">${esc(text)}</div>`;
    }
    case "bullets": {
      const { items, size = "md", color = p.fg } = block.props;
      const li = items
        .map(
          (item) =>
            `<li style="margin:0 0 ${Math.round(SIZE_PX[size] * 0.5)}px 0">${esc(item)}</li>`
        )
        .join("");
      return `<ul class="b" style="${box};margin:0;padding:0 0 0 ${SIZE_PX[size]}px;font-size:${SIZE_PX[size]}px;line-height:1.4;color:${color}">${li}</ul>`;
    }
    case "card": {
      const {
        heading,
        body,
        accent = p.accent,
        fill = p.surface
      } = block.props;
      const head = heading
        ? `<div style="font-size:${SIZE_PX.md}px;font-weight:650;color:${p.fg};margin:0 0 10px 0">${esc(heading)}</div>`
        : "";
      const text = body
        ? `<div style="font-size:${SIZE_PX.sm}px;line-height:1.45;color:${p.muted};white-space:pre-wrap">${esc(body)}</div>`
        : "";
      return `<div class="b" style="${box};background:${fill};border-radius:14px;border-left:6px solid ${accent};padding:22px 24px;box-sizing:border-box;overflow:hidden">${head}${text}</div>`;
    }
    case "box": {
      const { fill = "#00000000", stroke, radius = 12 } = block.props;
      const border = stroke ? `border:2px solid ${stroke};` : "";
      return `<div class="b" style="${box};background:${fill};${border}border-radius:${radius}px;box-sizing:border-box"></div>`;
    }
    case "arrow": {
      const { dir, stroke = p.accent } = block.props;
      return `<div class="b" style="${box}">${arrowSvg(block.w, block.h, dir, stroke)}</div>`;
    }
    case "divider": {
      const { stroke = p.rule } = block.props;
      return `<div class="b" style="${box};display:flex;align-items:center"><span style="display:block;width:100%;height:2px;background:${stroke}"></span></div>`;
    }
    case "image": {
      const { dataUri, alt = "" } = block.props;
      return `<img class="b" style="${box};object-fit:contain" src="${dataUri}" alt="${esc(alt)}">`;
    }
    case "svg": {
      // Inserted verbatim: it is markup by definition, and `schema.ts` has
      // already refused scripts, event handlers and every outward reference.
      return `<div class="b" style="${box};overflow:hidden">${block.props.markup}</div>`;
    }
    case "logo": {
      const { text, color = p.muted } = block.props;
      return `<div class="b" style="${box};display:flex;align-items:center;font-size:${SIZE_PX.sm}px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${color}">${esc(text)}</div>`;
    }
  }
}

/** `align` → the flexbox main-axis value that centres/ends a single line. */
function flex(align: "left" | "center" | "right"): string {
  return align === "center"
    ? "center"
    : align === "right"
      ? "flex-end"
      : "flex-start";
}

/** A stroked arrow drawn to fill its block box. Inline, so nothing is fetched. */
function arrowSvg(
  w: number,
  h: number,
  dir: "right" | "left" | "up" | "down",
  stroke: string
): string {
  const horizontal = dir === "right" || dir === "left";
  const [x1, y1, x2, y2] = horizontal
    ? dir === "right"
      ? [6, h / 2, w - 6, h / 2]
      : [w - 6, h / 2, 6, h / 2]
    : dir === "down"
      ? [w / 2, 6, w / 2, h - 6]
      : [w / 2, h - 6, w / 2, 6];
  const head = 14;
  // The head, as two strokes rotated off the shaft's direction.
  const ux = x2 - x1;
  const uy = y2 - y1;
  const len = Math.hypot(ux, uy) || 1;
  const nx = ux / len;
  const ny = uy / len;
  const wing = (sign: number): string => {
    const cos = Math.cos((sign * 145 * Math.PI) / 180);
    const sin = Math.sin((sign * 145 * Math.PI) / 180);
    const rx = nx * cos - ny * sin;
    const ry = nx * sin + ny * cos;
    return `${round(x2 + rx * head)},${round(y2 + ry * head)}`;
  };
  // No `xmlns`: inline SVG in an HTML document does not need one, and leaving it
  // out keeps "this page names no URL of its own" a blunt, assertable property.
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none"><path d="M${round(x1)},${round(y1)} L${round(x2)},${round(y2)} M${wing(1)} L${round(x2)},${round(y2)} L${wing(-1)}" stroke="${stroke}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The DOM id a slide renders under — how the reviewer screenshots one alone. */
export function slideElementId(slideId: string): string {
  return `slide-${slideId}`;
}

function renderSlide(slide: Slide, p: Palette): string {
  const bg = slide.background?.color ?? p.bg;
  const grid = slide.background?.dotGrid ? `<div class="dots"></div>` : "";
  const blocks = slide.blocks.map((b) => renderBlock(b, p)).join("");
  // The id is what lets `review.ts` pass `selector: '#slide-<id>'` to Browser
  // Rendering and get back one slide rather than the whole document. Safe to
  // interpolate unescaped: `nodeId` in `schema.ts` restricts slide ids to
  // `[A-Za-z0-9_-]`, so they are already valid CSS selectors.
  return `<section class="slide" id="${slideElementId(slide.id)}" style="background:${bg}">${grid}${blocks}</section>`;
}

/**
 * The whole document.
 *
 * `@page` is sized to the slide so one `.slide` is exactly one PDF page with no
 * margin — the reason a deck comes out of `browserPdf` at 1200×675 rather than on
 * Letter paper with the corners cut off.
 *
 * The font stack is system-only and ends in `sans-serif`. A webfont would be the
 * single most tempting thing to add here and is the one thing that cannot work:
 * it is a network fetch, and the renderer has no origin to fetch from.
 */
export function renderDeckHtml(deck: Deck): string {
  const p = PALETTES[deck.theme];
  const slides = deck.slides.map((s) => renderSlide(s, p)).join("");
  return [
    `<meta charset="utf-8">`,
    `<title>${esc(deck.title)}</title>`,
    `<style>`,
    `@page{size:${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px;margin:0}`,
    `*{box-sizing:border-box}`,
    `html,body{margin:0;padding:0;background:${p.bg}}`,
    `body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Liberation Sans","DejaVu Sans",sans-serif;color:${p.fg};-webkit-font-smoothing:antialiased}`,
    `.slide{position:relative;width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;overflow:hidden;page-break-after:always;break-after:page}`,
    `.slide:last-child{page-break-after:auto;break-after:auto}`,
    `.b{position:absolute}`,
    `.dots{position:absolute;inset:0;background-image:radial-gradient(${p.rule} 1.5px,transparent 1.5px);background-size:32px 32px;opacity:.6}`,
    `ul.b{list-style-position:outside}`,
    `</style>`,
    slides
  ].join("");
}
