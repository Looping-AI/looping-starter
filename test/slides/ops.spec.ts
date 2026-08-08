import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  applyOps,
  MAX_OPS,
  opSchema,
  type DeckOp
} from "@/agents/reactive/slides/ops";
import type { Deck } from "@/agents/reactive/slides/schema";
import { block, deck, slide } from "./fixtures";

/**
 * The op applier — the whole edit path, and the reason this feature does not
 * need codemode.
 *
 * Two properties carry the design and both are asserted here: an op is
 * **refused before it runs** (so a bad edit is a message the model can act on,
 * not a half-applied change), and a batch **reports per op** (so one typo does
 * not discard a turn's work).
 */

const LIMITS = { maxSlides: 20 };

function apply(d: Deck, ...ops: DeckOp[]) {
  return applyOps(d, ops, LIMITS);
}

/** Three slides, for the ordering cases. */
function threeSlides(): Deck {
  return deck({
    slides: [
      slide({
        id: "s1",
        blocks: [block({ id: "t1", type: "title", props: { text: "One" } })]
      }),
      slide({ id: "s2" }),
      slide({ id: "s3" })
    ]
  });
}

describe("set_text", () => {
  it("replaces a title's words", () => {
    const d = deck();
    const { results } = apply(d, {
      op: "set_text",
      slide: "s1",
      block: "t1",
      text: "Annual Review"
    });

    expect(results[0].ok).toBe(true);
    expect(d.slides[0].blocks[0]).toMatchObject({
      props: { text: "Annual Review" }
    });
  });

  it("splits a bullets block on newlines and strips list markers", () => {
    const d = deck({
      slides: [
        slide({
          blocks: [
            block({ id: "b1", type: "bullets", props: { items: ["old"] } })
          ]
        })
      ]
    });

    apply(d, {
      op: "set_text",
      slide: "s1",
      block: "b1",
      text: "- First\n* Second\n\n• Third"
    });

    expect(d.slides[0].blocks[0]).toMatchObject({
      props: { items: ["First", "Second", "Third"] }
    });
  });

  it("refuses a block that holds no text, naming what to use instead", () => {
    const d = deck({
      slides: [slide({ blocks: [block({ id: "x1", type: "box", props: {} })] })]
    });

    const { results } = apply(d, {
      op: "set_text",
      slide: "s1",
      block: "x1",
      text: "nope"
    });

    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]).toHaveProperty(
      "error",
      expect.stringContaining("set_props")
    );
  });
});

describe("set_props", () => {
  it("merges a patch and removes a key set to null", () => {
    const d = deck({
      slides: [
        slide({
          blocks: [
            block({
              id: "t1",
              type: "title",
              props: { text: "Hi", color: "#111827" }
            })
          ]
        })
      ]
    });

    apply(
      d,
      { op: "set_props", slide: "s1", block: "t1", props: { align: "center" } },
      { op: "set_props", slide: "s1", block: "t1", props: { color: null } }
    );

    expect(d.slides[0].blocks[0].props).toEqual({
      text: "Hi",
      align: "center"
    });
  });

  it("rejects a prop the block type does not declare", () => {
    // `strictObject` is what turns an invented prop into a message rather than
    // intent that silently vanishes.
    const d = deck();
    const { results } = apply(d, {
      op: "set_props",
      slide: "s1",
      block: "t1",
      props: { fontWeight: "900" }
    });

    expect(results[0].ok).toBe(false);
    expect(d.slides[0].blocks[0].props).not.toHaveProperty("fontWeight");
  });

  it("rejects a colour that is not hex", () => {
    // Colours land in a `style` attribute, so a free-form string there is how a
    // `url(…)` or a second declaration gets in.
    const d = deck();
    const { results } = apply(d, {
      op: "set_props",
      slide: "s1",
      block: "t1",
      props: { color: "red; background:url(http://x)" }
    });

    expect(results[0].ok).toBe(false);
  });
});

describe("block geometry and lifecycle", () => {
  it("moves a block, leaving unnamed axes alone", () => {
    const d = deck();
    apply(d, { op: "move_block", slide: "s1", block: "t1", y: 80 });

    expect(d.slides[0].blocks[0]).toMatchObject({ x: 96, y: 80, w: 1008 });
  });

  it("adds a block from flat fields", () => {
    const d = deck();
    const { results } = apply(d, {
      op: "add_block",
      slide: "s1",
      block: "b2",
      type: "bullets",
      x: 96,
      y: 400,
      w: 900,
      h: 200,
      props: { items: ["One", "Two"] }
    });

    expect(results[0].ok).toBe(true);
    expect(d.slides[0].blocks).toHaveLength(2);
  });

  it("refuses a duplicate block id", () => {
    const d = deck();
    const { results } = apply(d, {
      op: "add_block",
      slide: "s1",
      block: "t1",
      type: "text",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      props: { text: "clash" }
    });

    expect(results[0].ok).toBe(false);
    expect(d.slides[0].blocks).toHaveLength(1);
  });

  it("refuses a block whose props do not match its type", () => {
    const d = deck();
    const { results } = apply(d, {
      op: "add_block",
      slide: "s1",
      block: "b9",
      type: "bullets",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      props: { text: "bullets take items, not text" }
    });

    expect(results[0].ok).toBe(false);
  });

  it("removes a block", () => {
    const d = deck();
    apply(d, { op: "remove_block", slide: "s1", block: "t1" });

    expect(d.slides[0].blocks).toHaveLength(0);
  });
});

describe("slide lifecycle", () => {
  it("appends a slide by default and inserts after a named one", () => {
    const d = threeSlides();
    apply(
      d,
      { op: "add_slide", slide: "s4" },
      { op: "add_slide", slide: "s0", after: "s1" }
    );

    expect(d.slides.map((s) => s.id)).toEqual(["s1", "s0", "s2", "s3", "s4"]);
  });

  it("enforces the deck's slide cap", () => {
    const d = deck();
    const { results } = applyOps(d, [{ op: "add_slide", slide: "s2" }], {
      maxSlides: 1
    });

    expect(results[0]).toMatchObject({ ok: false });
    expect(d.slides).toHaveLength(1);
  });

  it("refuses to remove the last slide", () => {
    const d = deck();
    const { results } = apply(d, { op: "remove_slide", slide: "s1" });

    expect(results[0].ok).toBe(false);
    expect(d.slides).toHaveLength(1);
  });

  it("reorders correctly in both directions and to the front", () => {
    // The anchor is resolved before the splice — reading it afterwards moves it
    // by one, which is the classic off-by-one this asserts against.
    const forward = threeSlides();
    apply(forward, { op: "reorder_slide", slide: "s1", after: "s3" });
    expect(forward.slides.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);

    const backward = threeSlides();
    apply(backward, { op: "reorder_slide", slide: "s3", after: "s1" });
    expect(backward.slides.map((s) => s.id)).toEqual(["s1", "s3", "s2"]);

    const front = threeSlides();
    apply(front, { op: "reorder_slide", slide: "s3" });
    expect(front.slides.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
  });
});

describe("restyle and deck settings", () => {
  it("applies to every block of a type across the deck", () => {
    const d = deck({
      slides: [
        slide({
          id: "s1",
          blocks: [
            block({ id: "t1", type: "title", props: { text: "A" } }),
            block({ id: "x1", type: "box", props: {} })
          ]
        }),
        slide({
          id: "s2",
          blocks: [block({ id: "t2", type: "title", props: { text: "B" } })]
        })
      ]
    });

    const { results } = apply(d, {
      op: "restyle",
      type: "title",
      props: { align: "center" }
    });

    expect(results[0]).toMatchObject({ ok: true, note: "restyled 2 block(s)" });
    expect(d.slides[1].blocks[0].props).toMatchObject({ align: "center" });
    expect(d.slides[0].blocks[1].props).toEqual({});
  });

  it("reports a selection that matched nothing", () => {
    const d = deck();
    const { results } = apply(d, {
      op: "restyle",
      type: "bullets",
      props: { size: "sm" }
    });

    expect(results[0].ok).toBe(false);
  });

  it("changes the deck title and theme", () => {
    const d = deck();
    apply(d, { op: "set_deck", title: "New", theme: "dark" });

    expect(d).toMatchObject({ title: "New", theme: "dark" });
  });
});

describe("batching", () => {
  it("keeps the good ops and reports only the bad one", () => {
    const d = deck();
    const { results } = apply(
      d,
      { op: "set_text", slide: "s1", block: "t1", text: "Kept" },
      { op: "set_text", slide: "nope", block: "t1", text: "Lost" },
      { op: "add_slide", slide: "s2" }
    );

    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(d.slides[0].blocks[0]).toMatchObject({ props: { text: "Kept" } });
    expect(d.slides).toHaveLength(2);
  });

  it("names the ids that do exist when one does not", () => {
    const d = threeSlides();
    const { results } = apply(d, {
      op: "set_text",
      slide: "s9",
      block: "t1",
      text: "x"
    });

    expect(results[0]).toHaveProperty(
      "error",
      expect.stringContaining("s1, s2, s3")
    );
  });
});

describe("the tool schema the model actually sees", () => {
  /** What the AI SDK hands a provider for `deck_apply`'s `inputSchema`. */
  const asJsonSchema = () =>
    z.toJSONSchema(z.object({ ops: z.array(opSchema).min(1).max(MAX_OPS) }), {
      io: "input"
    });

  it("converts to JSON Schema at all", () => {
    // The one failure mode with no other symptom: a schema that cannot be
    // converted means `deck_apply` is simply never callable, and the model
    // reports that it could not edit the deck.
    expect(() => asJsonSchema()).not.toThrow();
  });

  it("advertises every op", () => {
    const json = JSON.stringify(asJsonSchema());

    for (const op of [
      "set_text",
      "set_props",
      "move_block",
      "add_block",
      "remove_block",
      "add_slide",
      "remove_slide",
      "reorder_slide",
      "set_notes",
      "restyle",
      "set_deck"
    ]) {
      expect(json).toContain(`"${op}"`);
    }
  });

  it("keeps every op flat", () => {
    // `add_block` could have taken a whole block object, and a discriminated
    // union nested inside another one is exactly what these models fill in
    // unreliably. Its fields are spread instead, and this is what says so.
    // Round-tripped through JSON, which is what a provider actually receives and
    // is also the honest way to reach an opaque shape without fighting the
    // generic `ZodStandardJSONSchemaPayload` type.
    const schema = JSON.parse(JSON.stringify(asJsonSchema())) as {
      properties: {
        ops: {
          items: {
            anyOf?: { properties: Record<string, { const?: string }> }[];
            oneOf?: { properties: Record<string, { const?: string }> }[];
          };
        };
      };
    };
    const members =
      schema.properties.ops.items.anyOf ?? schema.properties.ops.items.oneOf!;

    expect(members).toHaveLength(11);
    const addBlock = members.find(
      (m) => m.properties.op?.const === "add_block"
    );
    expect(Object.keys(addBlock!.properties).sort()).toEqual([
      "block",
      "h",
      "op",
      "props",
      "slide",
      "type",
      "w",
      "x",
      "y"
    ]);
  });
});
