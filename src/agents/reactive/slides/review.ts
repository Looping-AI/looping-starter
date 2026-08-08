import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { browserScreenshot } from "agents/browser";
import type { QuickActionBinding } from "agents/browser";
import { renderDeckHtml, slideElementId } from "./render";
import { SLIDE_HEIGHT, SLIDE_WIDTH, type Deck } from "./schema";

/**
 * The visual reviewer — the subagent's only way to see what it actually made.
 *
 * ## Why this is a plugin-owned model call rather than an image tool result
 *
 * The obvious design is to let `deck_review` return the screenshot *as its tool
 * result*, so the round loop's own model looks at it. The AI SDK supports that
 * (`toModelOutput` → `{ type: "content", value: [{ type: "file-data", … }] }`).
 * It cannot work here, for two independent reasons:
 *
 * 1. **The provider drops it.** `workers-ai-provider` converts a `content` tool
 *    result with `.filter(p => p.type === "text")` — every non-text part is
 *    silently discarded on the way to the model.
 * 2. **The model cannot see anyway.** `@cf/zai-org/glm-5.2`, this agent's
 *    primary, is text-only.
 *
 * What the provider *does* support is an image `file` part in a **user message**,
 * which it converts to an `image_url` data URI. So the review happens here, on a
 * vision model this module owns, and what crosses back into the tool loop is
 * ordinary text. This is the `@loopingai/plugins/triage` shape exactly — and it
 * is the one place in this plugin where naming a model id is legitimate, because
 * authoring runs on core's recipe runner, which by design cannot name one.
 *
 * ## Why it is needed at all
 *
 * `lint.ts` reasons about geometry and catches overflow, collisions and blocks
 * off the canvas. It cannot catch a slide that is *correct and terrible*: the
 * emphasis on the wrong line, two slides that say the same thing, a colour that
 * renders as invisible, a layout that is technically inside its box and reads as
 * empty. Those were exactly the failures the first live decks had — and the two
 * worst of them (dropped backgrounds, wrong page size) were invisible to every
 * check that did not look at the rendered output.
 */

/** Small and fast is wrong here — this one has to actually read the slide. */
const DEFAULT_REVIEW_MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";
/** How many slides one review may look at. Each is a browser render. */
const DEFAULT_MAX_REVIEW_SLIDES = 8;
/**
 * Room to finish the thought.
 *
 * This was 700, on the theory that a critique read by another model must stay
 * short. That was the wrong lever: brevity is the *prompt's* job, and a ceiling
 * only decides whether a long review arrives whole or is cut off mid-sentence.
 * Three of six reviews in one observed run hit 700 exactly — truncated — which
 * costs the same tokens and latency as the full critique while handing the
 * subagent a finding that stops halfway through naming what to fix.
 *
 * Generous on purpose: a review that fits is never billed for the headroom.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 5_000;

/**
 * The reviewer's instructions.
 *
 * Written against the failure mode a reviewer actually has, which is not missing
 * problems — it is **inventing praise**. A model shown a slide and asked "how is
 * it?" will find something nice to say, and a review that opens with "clean and
 * professional" is one the subagent will act on by changing nothing. So: no
 * compliments, findings only, and an explicit way to say there is nothing wrong.
 */
export const REVIEW_RULES = [
  "You are reviewing rendered slides for a deck that will be sent to someone as a PDF. You are shown the slides as images, exactly as they will look.",
  "Report only what is *wrong*. Do not compliment, do not summarize what the slide contains, and do not restate its text back.",
  "",
  "Look for, in rough order of severity:",
  "- Text that is cut off, overlapping something else, or running outside the slide.",
  "- A slide that looks empty or unfinished — large blank regions, one stray line of text, a heading with nothing under it.",
  "- Text that is too small to read comfortably, or too low-contrast against what is behind it.",
  "- Colours that clearly did not render: a block that should be filled and is white, or text the same colour as its background.",
  "- Emphasis in the wrong place: the biggest text on the slide should be the most important thing on it.",
  "- Two slides that make the same point, or a slide carrying more than one idea.",
  "- Anything that looks accidental rather than designed — a lone element floating in a corner, wildly uneven margins.",
  "",
  "Write one short bullet per problem, each starting with the slide id, e.g. `- s3: the subtitle is clipped on the right`. Be specific about *which element* and *what to do*.",
  "If a slide has nothing wrong with it, say nothing about it at all.",
  "If the whole deck is fine, reply with exactly: LOOKS GOOD"
].join("\n");

/** What the reviewer reports when it could not run. See {@link makeReviewer}. */
export const REVIEW_UNAVAILABLE =
  "Visual review is unavailable right now, so this deck has not been looked at. " +
  "Continue using `deck_lint` and your own judgement, and say in your report that the deck was not visually reviewed.";

export interface ReviewerDeps {
  /** The `AI` binding. Read lazily — see {@link makeReviewer}. */
  ai: Ai;
  /** The `BROWSER` binding, for rendering a slide to a PNG. */
  browser: QuickActionBinding;
  /**
   * The host's **resolved** AI Gateway id, so review calls are correlated with
   * the agent's own — which is also how `npm run cf -- ai` can tell whether a
   * run reviewed its deck at all.
   */
  aiGatewayId?: string;
  modelId?: string;
  maxSlides?: number;
  maxOutputTokens?: number;
  /** Test override: skips the provider entirely. */
  model?: LanguageModel;
  /** Test override: skips Browser Rendering, which has no local mode. */
  screenshot?: (html: string, selector: string) => Promise<Uint8Array>;
}

export interface Reviewer {
  /**
   * Review the named slides (or the first `maxSlides` of the deck) and return a
   * critique the subagent can act on. Never throws.
   */
  review(deck: Deck, slideIds?: readonly string[]): Promise<string>;
}

export function makeReviewer(deps: ReviewerDeps): Reviewer {
  const {
    ai,
    browser,
    aiGatewayId,
    modelId = DEFAULT_REVIEW_MODEL_ID,
    maxSlides = DEFAULT_MAX_REVIEW_SLIDES,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS
  } = deps;

  /**
   * Built on first use, never at module scope. Cloudflare evaluates module scope
   * during `wrangler deploy` to validate the new version, and bindings are not
   * populated at that point — constructing eagerly makes `createWorkersAI` throw
   * "you must provide either a binding or credentials".
   */
  let cached: LanguageModel | undefined;
  const reviewer = (): LanguageModel =>
    (cached ??=
      deps.model ??
      createWorkersAI({
        binding: ai,
        ...(aiGatewayId ? { gateway: { id: aiGatewayId } } : {})
      })(modelId));

  const shoot =
    deps.screenshot ??
    (async (html: string, selector: string): Promise<Uint8Array> => {
      const { data } = await browserScreenshot(browser, {
        html,
        selector,
        // The viewport still has to be the slide canvas even though only one
        // element is captured: layout happens first, and a narrower viewport
        // would reflow the page before the crop is taken.
        viewport: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT }
      });
      return data;
    });

  return {
    async review(deck, slideIds) {
      const wanted =
        slideIds && slideIds.length > 0
          ? deck.slides.filter((s) => slideIds.includes(s.id))
          : deck.slides;
      if (wanted.length === 0) {
        return "No such slide in this deck — check the outline for the ids.";
      }
      const chosen = wanted.slice(0, maxSlides);

      try {
        // Rendered once for the whole batch: the HTML is identical for every
        // slide, and only the selector differs.
        const html = renderDeckHtml(deck);
        const shots = await Promise.all(
          chosen.map((s) => shoot(html, `#${slideElementId(s.id)}`))
        );

        // One call carrying every image, not one call per slide. The provider
        // accumulates multiple image parts into a single message, and a reviewer
        // that sees the whole deck can say "s4 repeats s2" — which is a finding
        // no per-slide review can ever produce.
        const messages: ModelMessage[] = [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  `Deck: "${deck.title}" (${deck.theme} theme), ${deck.slides.length} slide(s) total.`,
                  `You are shown ${chosen.length} of them, in this order: ${chosen.map((s) => s.id).join(", ")}.`,
                  "Review them."
                ].join("\n")
              },
              ...shots.map((data) => ({
                type: "file" as const,
                data,
                mediaType: "image/png"
              }))
            ]
          }
        ];

        const { text } = await generateText({
          model: reviewer(),
          instructions: REVIEW_RULES,
          messages,
          maxOutputTokens,
          // Consistent with the rest of the runtime: failure is handled here, so
          // SDK backoff would only add latency in front of a fail-soft path.
          maxRetries: 0
        });

        const critique = text.trim();
        return critique === ""
          ? "The review came back empty. Treat the deck as unreviewed."
          : critique;
      } catch (error) {
        // Fails soft, and the asymmetry is deliberate. A broken reviewer must
        // degrade to "this deck was not looked at" — never to a failed run that
        // discards a deck which is otherwise finished and correct.
        console.warn("[slides] visual review failed", {
          model: modelId,
          slides: chosen.length,
          error: String(error)
        });
        return REVIEW_UNAVAILABLE;
      }
    }
  };
}
