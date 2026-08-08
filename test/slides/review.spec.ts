import { describe, it, expect } from "vitest";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  makeReviewer,
  REVIEW_UNAVAILABLE
} from "@/agents/reactive/slides/review";
import { block, deck, slide } from "./fixtures";

/**
 * The visual reviewer — the subagent's only way to see its own work.
 *
 * Two things are asserted here that nothing else can, and both are why the first
 * live decks shipped broken:
 *
 * 1. **The images actually reach the model.** The whole feature is image parts in
 *    one message. `workers-ai-provider` silently drops non-text content from
 *    *tool results* — which is why this is a plugin-owned call at all — so "did
 *    an image get attached" is the assertion the design rests on. These specs
 *    inspect the **converted provider prompt**, i.e. what the provider is
 *    actually handed, rather than what was passed to `generateText`.
 * 2. **A broken reviewer does not break a deck.** It fails soft, deliberately: a
 *    finished, correct deck must not be discarded because a review rate-limited.
 */

const PNG = new Uint8Array([137, 80, 78, 71]);

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 }
};

/** One converted user-message part, as the provider receives it. */
type PromptPart = { type: string; text?: string; mediaType?: string };

/**
 * A model that records the prompt it was handed. Built directly on
 * `MockLanguageModelV3` rather than core's `mockModel`, which scripts *replies*
 * and exposes no hook for reading the request — and the request is the subject
 * of this spec.
 */
function captureModel(reply = "- s1: the title is clipped"): {
  model: LanguageModel;
  parts: () => PromptPart[];
} {
  const seen: PromptPart[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const user = options.prompt.find((m) => m.role === "user");
      seen.push((user?.content ?? []) as PromptPart[]);
      return {
        content: [{ type: "text" as const, text: reply }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USAGE,
        warnings: []
      };
    }
  });
  return {
    model: model as unknown as LanguageModel,
    parts: () => seen[0] ?? []
  };
}

/** Three slides with distinguishable ids. */
const threeSlides = () =>
  deck({
    slides: ["s1", "s2", "s3"].map((id) =>
      slide({
        id,
        blocks: [block({ id: `t-${id}`, type: "title", props: { text: id } })]
      })
    )
  });

const reviewerWith = (
  model: LanguageModel,
  over: Partial<Parameters<typeof makeReviewer>[0]> = {}
) =>
  makeReviewer({
    ai: {} as Ai,
    browser: {} as never,
    model,
    screenshot: async () => PNG,
    ...over
  });

describe("makeReviewer", () => {
  it("attaches one image part per reviewed slide", async () => {
    const { model, parts } = captureModel();

    await reviewerWith(model).review(threeSlides());

    const images = parts().filter((p) => p.type === "file");
    expect(images).toHaveLength(3);
    expect(images.every((p) => p.mediaType === "image/png")).toBe(true);
  });

  it("tells the model which slide each image is", async () => {
    // The images arrive as an ordered list with no labels of their own, so the
    // text part is the only thing that lets a finding name a slide id — and a
    // critique that cannot name a slide is one the subagent cannot act on.
    const { model, parts } = captureModel();

    await reviewerWith(model).review(threeSlides());

    const text = parts().find((p) => p.type === "text")?.text ?? "";
    expect(text).toContain("s1, s2, s3");
  });

  it("reviews only the slides it was asked for", async () => {
    const { model, parts } = captureModel();

    await reviewerWith(model).review(threeSlides(), ["s2"]);

    expect(parts().filter((p) => p.type === "file")).toHaveLength(1);
    expect(parts().find((p) => p.type === "text")?.text).toContain(
      "You are shown 1 of them"
    );
  });

  it("caps how many slides one review renders", async () => {
    // Each slide is a Browser Rendering call, so this bounds latency rather than
    // tokens — an uncapped review of a 20-slide deck is 20 round trips.
    const { model, parts } = captureModel();
    let shots = 0;

    await reviewerWith(model, {
      maxSlides: 2,
      screenshot: async () => {
        shots += 1;
        return PNG;
      }
    }).review(threeSlides());

    expect(shots).toBe(2);
    expect(parts().filter((p) => p.type === "file")).toHaveLength(2);
  });

  it("returns the critique verbatim", async () => {
    const { model } = captureModel("- s2: the subtitle is unreadable");

    expect(await reviewerWith(model).review(threeSlides())).toBe(
      "- s2: the subtitle is unreadable"
    );
  });

  it("says so when the slide ids match nothing", async () => {
    const { model } = captureModel();

    expect(await reviewerWith(model).review(threeSlides(), ["nope"])).toContain(
      "No such slide"
    );
  });

  it("degrades to a message when the render fails", async () => {
    // Browser Rendering is a remote service on a paid plan. A finished, correct
    // deck must not be discarded because one render call failed — so this
    // returns rather than throws, and says plainly the deck was not looked at.
    const { model } = captureModel();

    const said = await reviewerWith(model, {
      screenshot: async () => {
        throw new Error("browser unavailable");
      }
    }).review(threeSlides());

    expect(said).toBe(REVIEW_UNAVAILABLE);
    expect(said).toContain("not been looked at");
  });

  it("treats an empty critique as unreviewed rather than as approval", async () => {
    // An empty reply is indistinguishable from "nothing is wrong" unless it is
    // named, and reading silence as approval is how a broken review path stays
    // invisible. The prompt asks for a literal LOOKS GOOD in the fine case.
    const { model } = captureModel("   ");

    expect(await reviewerWith(model).review(threeSlides())).toContain(
      "unreviewed"
    );
  });
});
