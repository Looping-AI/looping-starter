import { describe, it, expect } from "vitest";
import { formatFindings, lintDeck } from "@/agents/reactive/slides/lint";
import { block, deck, slide } from "./fixtures";

/**
 * The layout check, which stands in for letting the model look at its own deck.
 *
 * A rendered preview is the obvious design and cannot work here: the models this
 * agent runs on are not reliably multimodal, so a PNG is a tool result they
 * cannot read. Every failure a human would catch by looking is already in the
 * JSON, so it is computed instead — and computing it means it is testable without
 * rendering anything.
 */

const kinds = (d: Parameters<typeof lintDeck>[0]) =>
  lintDeck(d).map((f) => f.kind);

describe("lintDeck", () => {
  it("passes a well-formed slide", () => {
    expect(lintDeck(deck())).toEqual([]);
  });

  it("flags a block that runs off the canvas", () => {
    const d = deck({
      slides: [
        slide({
          blocks: [
            block({
              id: "t1",
              type: "title",
              x: 1000,
              y: 96,
              w: 400,
              h: 100,
              props: { text: "Wide" }
            })
          ]
        })
      ]
    });

    expect(kinds(d)).toContain("offcanvas");
  });

  it("flags text that will not fit its box", () => {
    const d = deck({
      slides: [
        slide({
          blocks: [
            block({
              id: "t1",
              type: "title",
              x: 96,
              y: 96,
              w: 400,
              h: 80,
              props: { text: "x".repeat(200), size: "xl" }
            })
          ]
        })
      ]
    });

    const overflow = lintDeck(d).find((f) => f.kind === "overflow");
    expect(overflow?.message).toContain("the box is 80px");
  });

  it("bills a full line per bullet however short the item is", () => {
    const d = deck({
      slides: [
        slide({
          blocks: [
            block({
              id: "b1",
              type: "bullets",
              x: 96,
              y: 96,
              w: 900,
              h: 60,
              props: { items: ["a", "b", "c", "d", "e", "f"] }
            })
          ]
        })
      ]
    });

    expect(kinds(d)).toContain("overflow");
  });

  it("flags two text blocks sitting on top of each other", () => {
    const d = deck({
      slides: [
        slide({
          blocks: [
            block({
              id: "t1",
              type: "title",
              x: 96,
              y: 96,
              w: 400,
              h: 100,
              props: { text: "A" }
            }),
            block({
              id: "t2",
              type: "title",
              x: 96,
              y: 96,
              w: 400,
              h: 100,
              props: { text: "B" }
            })
          ]
        })
      ]
    });

    expect(kinds(d)).toContain("overlap");
  });

  it("does not flag a backdrop under its own content", () => {
    // A `box` is a background panel and a `card` is a container. Flagging either
    // for overlapping the text it exists to hold would make the check noise, and
    // a check that is noise gets ignored.
    const d = deck({
      slides: [
        slide({
          blocks: [
            block({
              id: "x1",
              type: "box",
              x: 80,
              y: 80,
              w: 600,
              h: 200,
              props: {}
            }),
            block({
              id: "t1",
              type: "title",
              x: 96,
              y: 96,
              w: 400,
              h: 100,
              props: { text: "On top" }
            })
          ]
        })
      ]
    });

    expect(kinds(d)).not.toContain("overlap");
  });

  it("flags a block too small to render legibly, and an empty slide", () => {
    const d = deck({
      slides: [
        slide({
          id: "s1",
          blocks: [
            block({
              id: "t1",
              type: "title",
              x: 96,
              y: 96,
              w: 20,
              h: 10,
              props: { text: "" }
            })
          ]
        }),
        slide({ id: "s2", blocks: [] })
      ]
    });

    expect(kinds(d)).toContain("tiny");
    expect(kinds(d)).toContain("empty");
  });

  it("formats findings as lines a model can act on", () => {
    expect(formatFindings([])).toBe("No layout problems found.");
    expect(
      formatFindings([
        { slide: "s1", block: "t1", kind: "overflow", message: "too long" }
      ])
    ).toBe("- s1/t1: too long");
  });
});
