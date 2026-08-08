import { describe, it, expect } from "vitest";
import { pdfInput } from "@/agents/reactive/slides/pdf";
import { renderDeckHtml } from "@/agents/reactive/slides/render";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "@/agents/reactive/slides/schema";
import { deck } from "./fixtures";

/**
 * The Browser Rendering options — a regression suite for a bug that shipped to
 * production invisibly.
 *
 * The first live decks came back as blank US-Letter pages. Nothing caught it:
 * the deck JSON was correct, the renderer was correct, `deck_lint` passed, and
 * the whole suite was green. The two options that ruined the output were an
 * unexamined literal inside a call no test could reach, and both of them were
 * simply the endpoint's defaults.
 *
 * Which is the point of every assertion below: these are not tuning values with
 * a sensible fallback, they are the difference between a deck and two white
 * rectangles, and the only place that difference is observable before a deploy
 * is here.
 */

describe("pdfInput", () => {
  it("prints backgrounds", () => {
    // `printBackground` defaults to false. With it off, slide backgrounds, `box`
    // fills and `card` fills are all dropped while text colours render normally
    // — so a deck looks *almost* right, which is why it survived review.
    expect(pdfInput("<p>x</p>").pdfOptions.printBackground).toBe(true);
  });

  it("lets the CSS @page rule decide the paper size", () => {
    // The single most important line in this file, and the one that was wrong
    // the first time. `format` defaults to `"letter"` and beats `width`/`height`,
    // so *omitting* format does not leave the size unspecified — it leaves it
    // Letter. `preferCSSPageSize` is the only way to outrank it, which makes
    // `@page { size: … }` in `render.ts` the real source of truth.
    //
    // With this false, a deck renders at `MediaBox [0 0 792 612]` — Letter,
    // landscape — and 1200px-wide content gets clipped on it.
    expect(pdfInput("<p>x</p>").pdfOptions.preferCSSPageSize).toBe(true);
  });

  it("still states the size explicitly, agreeing with the CSS", () => {
    const { pdfOptions } = pdfInput("<p>x</p>");

    expect(pdfOptions.width).toBe(`${SLIDE_WIDTH}px`);
    expect(pdfOptions.height).toBe(`${SLIDE_HEIGHT}px`);
    expect(pdfOptions.scale).toBe(1);
  });

  it("never sets `format`", () => {
    // Belt and braces next to `preferCSSPageSize`: an explicit `format` would
    // outrank width/height again, and the CSS rule is doing that job now.
    expect(pdfInput("<p>x</p>").pdfOptions).not.toHaveProperty("format");
  });

  it("keeps the @page rule the renderer emits in sync with these numbers", () => {
    // The two halves of the page size live in different files — `@page` in the
    // renderer, `preferCSSPageSize` here — and `preferCSSPageSize: true` makes
    // the renderer's copy the one that wins. If they ever disagree, the PDF
    // silently follows the CSS, so this pins them together.
    expect(renderDeckHtml(deck())).toContain(
      `@page{size:${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px;margin:0}`
    );
  });

  it("leaves no margin, so a slide is edge to edge", () => {
    const { margin } = pdfInput("<p>x</p>").pdfOptions;

    expect(margin).toEqual({
      top: "0",
      right: "0",
      bottom: "0",
      left: "0"
    });
  });

  it("lays out in the same viewport the renderer positions against", () => {
    // The viewport and the paper are different things and both must be the slide
    // canvas: one is what the page is laid out in, the other what it is printed
    // onto. A mismatch is how content ends up clipped rather than scaled.
    expect(pdfInput("<p>x</p>").viewport).toEqual({
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT
    });
  });

  it("passes the html through untouched", () => {
    const html = "<section class='slide'>hello</section>";
    expect(pdfInput(html).html).toBe(html);
  });
});
