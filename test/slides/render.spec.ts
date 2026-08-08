import { describe, it, expect } from "vitest";
import { renderDeckHtml } from "@/agents/reactive/slides/render";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "@/agents/reactive/slides/schema";
import { block, deck, slide } from "./fixtures";

/**
 * The renderer, which is the whole visual layer and has no dependencies at all —
 * so all of it is testable here, with no model, no `BROWSER` binding and no
 * network. That is the point of keeping it pure: Browser Rendering has no local
 * mode, so anything asserted through it could only be asserted in production.
 */

/**
 * The one invariant `browserPdf` actually depends on.
 *
 * The renderer is handed raw HTML with **no origin behind it**, so a page that
 * names any external resource gets a request that cannot resolve and a box that
 * renders empty. This is the cheapest possible guard on that, and it is why the
 * schema forbids non-`data:` images and screens SVG for outward references, and
 * why the arrow SVG carries no `xmlns`.
 */
function externalReferences(html: string): string[] {
  const patterns = [
    /<script\b/gi,
    /<link\b/gi,
    /@import/gi,
    /url\(\s*['"]?(?!data:)/gi,
    /\bsrc\s*=\s*['"](?!data:)/gi,
    /\bhref\s*=\s*['"](?!#)/gi,
    /https?:\/\//gi
  ];
  return patterns.flatMap((p) => [...html.matchAll(p)].map((m) => m[0]));
}

describe("renderDeckHtml", () => {
  it("names nothing outside the page", () => {
    const html = renderDeckHtml(
      deck({
        slides: [
          slide({
            id: "s1",
            blocks: [
              block({ id: "t1", type: "title", props: { text: "Hello" } }),
              block({
                id: "a1",
                type: "arrow",
                props: { dir: "right" }
              }),
              block({
                id: "i1",
                type: "image",
                props: { dataUri: "data:image/png;base64,iVBORw0KGgo=" }
              }),
              block({
                id: "g1",
                type: "svg",
                props: { markup: '<svg><circle cx="10" cy="10" r="5"/></svg>' }
              })
            ]
          })
        ]
      })
    );

    expect(externalReferences(html)).toEqual([]);
  });

  it("sizes one PDF page per slide at the slide's own dimensions", () => {
    const html = renderDeckHtml(
      deck({ slides: [slide({ id: "s1" }), slide({ id: "s2" })] })
    );

    // Without this the deck comes out of `browserPdf` on Letter paper with the
    // corners cut off, which is the failure this line exists to prevent.
    expect(html).toContain(
      `@page{size:${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px;margin:0}`
    );
    expect(html.match(/class="slide"/g)).toHaveLength(2);
    expect(html).toContain("page-break-after:always");
  });

  it("escapes model-authored text rather than rendering it as markup", () => {
    const html = renderDeckHtml(
      deck({
        title: 'Q3 & "beyond"',
        slides: [
          slide({
            blocks: [
              block({
                id: "t1",
                type: "title",
                props: { text: "<script>alert(1)</script>" }
              })
            ]
          })
        ]
      })
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Q3 &amp; &quot;beyond&quot;");
  });

  it("positions every block absolutely at its own coordinates", () => {
    const html = renderDeckHtml(
      deck({
        slides: [
          slide({
            blocks: [
              block({
                id: "t1",
                type: "title",
                x: 120,
                y: 240,
                w: 900,
                h: 100,
                props: { text: "Positioned" }
              })
            ]
          })
        ]
      })
    );

    expect(html).toContain("left:120px;top:240px;width:900px;height:100px");
  });

  it("renders each block type without falling through", () => {
    const html = renderDeckHtml(
      deck({
        slides: [
          slide({
            blocks: [
              block({ id: "b1", type: "subtitle", props: { text: "Sub" } }),
              block({ id: "b2", type: "text", props: { text: "Body" } }),
              block({
                id: "b3",
                type: "bullets",
                props: { items: ["One", "Two"] }
              }),
              block({
                id: "b4",
                type: "card",
                props: { heading: "Head", body: "Body" }
              }),
              block({ id: "b5", type: "box", props: { stroke: "#111827" } }),
              block({ id: "b6", type: "divider", props: {} }),
              block({ id: "b7", type: "logo", props: { text: "Looping" } })
            ]
          })
        ]
      })
    );

    expect(html).toContain("Sub");
    expect(html).toContain("Body");
    expect(html).toContain("<li");
    expect(html).toContain("One");
    expect(html).toContain("Head");
    expect(html).toContain("border:2px solid #111827");
    expect(html).toContain("Looping");
  });

  it("passes screened svg through verbatim", () => {
    const markup = '<svg viewBox="0 0 10 10"><path d="M0,0 L10,10"/></svg>';
    const html = renderDeckHtml(
      deck({
        slides: [
          slide({
            blocks: [block({ id: "g1", type: "svg", props: { markup } })]
          })
        ]
      })
    );

    expect(html).toContain(markup);
  });

  it("uses the dark palette when the deck asks for it", () => {
    const light = renderDeckHtml(deck({ theme: "light" }));
    const dark = renderDeckHtml(deck({ theme: "dark" }));

    expect(light).toContain("#ffffff");
    expect(dark).toContain("#0b1220");
  });
});
