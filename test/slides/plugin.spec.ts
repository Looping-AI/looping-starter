import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { createAgentRuntime, validateRecipe } from "@loopingai/core";
import type { EnrichResultContext } from "@loopingai/core";
import type { RecipeExecutionResult } from "@loopingai/core/subtasks";
import { REACTIVE_CONFIG, SLIDES } from "@/config";
import { slides, SLIDES_FAMILY, SLIDES_TYPE } from "@/agents/reactive/slides";
import type { SlidesRuntime } from "@/agents/reactive/slides";
import { buildSlidesTools } from "@/agents/reactive/slides/family";
import { newDeckId } from "@/agents/reactive/slides/schema";
import { getDeck, pdfKey } from "@/agents/reactive/slides/store";
import { serveDeck } from "@/agents/reactive/slides/route";
import {
  callNamed,
  execution,
  fakeReviewer,
  fakeLedger,
  fakeRender
} from "./helpers";

/**
 * The plugin seam: what this repo's `slides` contributes to the agent, and how
 * the parent-side and facet-side halves meet.
 *
 * The pure layers (renderer, ops, lint) are covered on their own. What is left
 * is everything that depends on the *runtime contract* — the subtask type, the
 * runtime a parent resolves, the link a parent attaches, and the durability
 * boundary between the execution workspace and R2.
 */

const BASE_URL = "https://agent.example.test";

/**
 * `storage` is required by the config and untouched when a `ledger` is supplied
 * — the same shape `arcAgi({ store })` uses, so the cast stays in one place.
 */
const plugin = (over: Partial<Parameters<typeof slides>[0]> = {}) =>
  slides({
    bucket: env.BUCKET,
    browser: env.BROWSER,
    storage: {} as DurableObjectStorage,
    ai: env.AI,
    reviewer: fakeReviewer(),
    baseUrl: BASE_URL,
    ledger: fakeLedger(),
    render: fakeRender(),
    ...SLIDES,
    ...over
  });

describe("the subtask type it registers", () => {
  it("is delegable, and refuses a subtask that names no deck", () => {
    const runtime = createAgentRuntime({
      config: REACTIVE_CONFIG,
      plugins: [plugin()]
    });

    expect(runtime.types.keys).toEqual([SLIDES_TYPE]);
    // The value of a closed type set: a deck edit that names no deck cannot
    // succeed, and refusing it here costs no model call.
    expect(() => runtime.types.validateParams(SLIDES_TYPE, {})).toThrow();
    expect(
      runtime.types.validateParams(SLIDES_TYPE, { deck_id: "abc" })
    ).toEqual({ deck_id: "abc" });
  });

  it("runs on the host's model pair, because a recipe cannot name one", () => {
    // Core refuses a recipe the right to state a model, so there is no
    // `SLIDES.modelId` to test — what there is instead is this: whatever the
    // agent is configured with is what a deck is designed on.
    const runtime = createAgentRuntime({
      config: REACTIVE_CONFIG,
      plugins: [plugin()]
    });
    const validated = validateRecipe(
      runtime.types.resolveRecipe(SLIDES_TYPE),
      runtime.policy
    );

    expect(validated.primaryModelId).toBe(REACTIVE_CONFIG.model?.chatModelId);
    expect(validated.fallbackModelId).toBe(
      REACTIVE_CONFIG.model?.fallbackChatModelId
    );
    expect(validated.soul.length).toBeGreaterThan(0);
  });

  it("names its own tool family and nothing else", () => {
    // No `workspace`: the draft lives there, and `ws_write` in front of the
    // model would let it edit around the op validator. No `browser`: research
    // is a separate subtask feeding this one through a dependency edge.
    const runtime = createAgentRuntime({
      config: REACTIVE_CONFIG,
      plugins: [plugin()]
    });

    expect(runtime.types.resolveRecipe(SLIDES_TYPE).toolFamilies).toEqual([
      SLIDES_FAMILY
    ]);
  });

  it("declares the bindings and secrets the host must supply", () => {
    // `PUBLIC_BASE_URL` is in `requires` rather than defaulted because there is
    // no honest default: an absent one builds `undefined/d/<id>.pdf`, which
    // renders in Slack as a perfectly ordinary link and fails only when somebody
    // clicks it. Naming it at DO start is the whole point.
    const build = () =>
      createAgentRuntime({
        config: REACTIVE_CONFIG,
        plugins: [plugin()],
        env: { AI: env.AI } as unknown as typeof env
      });

    expect(build).toThrow(/missing bindings or secrets/);
    expect(build).toThrow(/BROWSER/);
    expect(build).toThrow(/BUCKET/);
    expect(build).toThrow(/PUBLIC_BASE_URL/);
  });
});

describe("the main agent's surface", () => {
  it("offers only `deck_new` until there is a deck to list", async () => {
    // A tool whose only possible answer is "nothing here yet" costs a call to
    // discover that and costs every round the tokens to describe it.
    const ledger = fakeLedger();
    const empty = await plugin({ ledger }).mainAgentTools!({
      session: {} as never
    });
    expect(Object.keys(empty)).toEqual(["deck_new"]);

    await callNamed(empty, "deck_new", { title: "Roadmap" });

    const stocked = await plugin({ ledger }).mainAgentTools!({
      session: {} as never
    });
    expect(Object.keys(stocked).sort()).toEqual([
      "deck_list",
      "deck_new",
      "deck_outline"
    ]);
  });

  it("mints an id the model can quote straight into `delegate`", async () => {
    const ledger = fakeLedger();
    const tools = await plugin({ ledger }).mainAgentTools!({
      session: {} as never
    });

    const said = await callNamed(tools, "deck_new", { title: "Roadmap" });
    const id = /deck_id: ([0-9a-f]{32})/.exec(said)?.[1];

    expect(id).toBeDefined();
    expect(ledger.get(id!)).toMatchObject({ title: "Roadmap", savedAt: null });
  });

  it("refuses to read a deck this caller does not own", async () => {
    // Deck ids are unguessable, but the ledger is what makes "only this
    // caller's decks" true by construction rather than by improbability.
    const ledger = fakeLedger();
    ledger.insert(newDeckId(), "Mine");
    const tools = await plugin({ ledger }).mainAgentTools!({
      session: {} as never
    });

    expect(
      await callNamed(tools, "deck_outline", { deck_id: newDeckId() })
    ).toContain("belongs to this caller");
  });
});

describe("resolveRuntime", () => {
  const resolve = (ledger: ReturnType<typeof fakeLedger>, deckId: string) =>
    plugin({ ledger }).resolveRuntime!({
      taskId: "t1",
      subtaskId: 1,
      type: SLIDES_TYPE,
      params: { deck_id: deckId },
      toolFamilies: [SLIDES_FAMILY]
    });

  it("resolves a known id against the caller's ledger", async () => {
    const ledger = fakeLedger();
    const id = newDeckId();
    ledger.insert(id, "Roadmap");

    await expect(resolve(ledger, id)).resolves.toEqual({
      deckId: id,
      known: true,
      title: "Roadmap"
    });
  });

  it("reports an unknown id instead of rejecting", async () => {
    // It is awaited inside the parent's `prepareChunk`, where a rejection is a
    // transient fault the Workflow retries — forever, for an id that will never
    // become valid. So the verdict travels into the execution instead.
    await expect(resolve(fakeLedger(), newDeckId())).resolves.toMatchObject({
      known: false
    });
  });
});

describe("the facet's tool family", () => {
  const family = (runtime: SlidesRuntime, render = fakeRender()) => {
    const ctx = execution(runtime);
    return {
      ctx,
      tools: buildSlidesTools(
        {
          bucket: env.BUCKET,
          renderPdf: render,
          maxSlides: 20,
          reviewer: fakeReviewer()
        },
        ctx
      )
    };
  };

  it("builds, renders and publishes a deck", async () => {
    const deckId = newDeckId();
    let renderedHtml = "";
    const { tools } = family(
      { deckId, known: true, title: "Roadmap" },
      fakeRender((html) => {
        renderedHtml = html;
      })
    );

    expect(await callNamed(tools, "deck_open")).toContain("blank one");
    const applied = await callNamed(tools, "deck_apply", {
      ops: [
        { op: "set_text", slide: "s1", block: "t1", text: "Roadmap 2027" },
        { op: "add_slide", slide: "s2", after: "s1" }
      ]
    });
    expect(applied).toContain("0. ok");
    expect(applied).toContain("1. ok");

    expect(await callNamed(tools, "deck_save")).toContain("Saved");

    const stored = await getDeck(env.BUCKET, deckId);
    expect(stored?.slides.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(await env.BUCKET.head(pdfKey(deckId))).not.toBeNull();
    expect(renderedHtml).toContain("Roadmap 2027");
  });

  it("re-seeds a fresh execution from R2, because the workspace is scratch", async () => {
    // The facet is deleted after delivery and its workspace goes with it, so
    // this is what a *follow-up message* actually does: a brand-new execution
    // over the same deck id, reading the last committed state back.
    const deckId = newDeckId();
    const first = family({ deckId, known: true, title: "Roadmap" });
    await callNamed(first.tools, "deck_open");
    await callNamed(first.tools, "deck_apply", {
      ops: [{ op: "set_text", slide: "s1", block: "t1", text: "Committed" }]
    });
    await callNamed(first.tools, "deck_save");

    const second = family({ deckId, known: true, title: "Roadmap" });
    const opened = await callNamed(second.tools, "deck_open");

    expect(opened).toContain("Opened the existing deck");
    expect(opened).toContain("Committed");
  });

  it("loses uncommitted edits rather than publishing half a revision", async () => {
    const deckId = newDeckId();
    const first = family({ deckId, known: true, title: "Roadmap" });
    await callNamed(first.tools, "deck_open");
    await callNamed(first.tools, "deck_apply", {
      ops: [{ op: "set_text", slide: "s1", block: "t1", text: "Saved once" }]
    });
    await callNamed(first.tools, "deck_save");

    // A second execution edits but never saves — the deck it was working from
    // stays exactly as the last commit left it.
    const abandoned = family({ deckId, known: true, title: "Roadmap" });
    await callNamed(abandoned.tools, "deck_open");
    await callNamed(abandoned.tools, "deck_apply", {
      ops: [{ op: "set_text", slide: "s1", block: "t1", text: "Never saved" }]
    });

    const stored = await getDeck(env.BUCKET, deckId);
    expect(stored?.slides[0].blocks[0].props).toMatchObject({
      text: "Saved once"
    });
  });

  it("refuses an execution whose deck the caller does not own", async () => {
    const { tools } = family({ deckId: newDeckId(), known: false, title: "x" });

    expect(await callNamed(tools, "deck_open")).toContain(
      "not one of this caller's decks"
    );
    expect(await callNamed(tools, "deck_save")).toContain(
      "not one of this caller's decks"
    );
  });

  it("tells the model to open the deck before touching it", async () => {
    const { tools } = family({
      deckId: newDeckId(),
      known: true,
      title: "Roadmap"
    });

    expect(await callNamed(tools, "deck_outline")).toContain("deck_open");
    expect(
      await callNamed(tools, "deck_apply", {
        ops: [{ op: "set_deck", title: "x" }]
      })
    ).toContain("deck_open");
  });

  it("reports a render failure instead of ending the tool loop", async () => {
    // Browser Rendering is a remote service and its failures are frequently
    // transient. The model's options are to retry or to report — both need it to
    // know what happened, which a thrown step error does not give it.
    const deckId = newDeckId();
    const { tools } = family({ deckId, known: true, title: "Roadmap" }, () => {
      throw new Error("browser unavailable");
    });
    await callNamed(tools, "deck_open");

    const said = await callNamed(tools, "deck_save");
    expect(said).toContain("Rendering failed");
    expect(await env.BUCKET.head(pdfKey(deckId))).toBeNull();
  });
});

describe("enrichResult — the link the parent attaches", () => {
  const completed = (): RecipeExecutionResult => ({
    status: "completed",
    resultParts: [{ kind: "text", text: "Built a 4-slide deck." }],
    modelId: "@cf/test/primary"
  });

  /** Only `runtime` is read; the request is filled to satisfy the type. */
  const context = (runtime: SlidesRuntime) =>
    ({ runtime, request: {} }) as unknown as EnrichResultContext<SlidesRuntime>;

  it("attaches nothing when no PDF was ever rendered", async () => {
    // A run that spent its budget before `deck_save` still returns a completed
    // result — core asks for a final report with no tools — and a URL appended
    // to that is a dead link.
    const result = await plugin().enrichResult!(
      context({ deckId: newDeckId(), known: true, title: "Roadmap" }),
      completed()
    );

    expect(result).toEqual(completed());
  });

  it("attaches the link and records the save once a PDF exists", async () => {
    const deckId = newDeckId();
    const ledger = fakeLedger();
    ledger.insert(deckId, "Roadmap");
    const { tools } = {
      tools: buildSlidesTools(
        {
          bucket: env.BUCKET,
          renderPdf: fakeRender(),
          maxSlides: 20,
          reviewer: fakeReviewer()
        },
        execution({ deckId, known: true, title: "Roadmap" })
      )
    };
    await callNamed(tools, "deck_open");
    await callNamed(tools, "deck_apply", {
      ops: [{ op: "add_slide", slide: "s2" }]
    });
    await callNamed(tools, "deck_save");

    const result = await plugin({ ledger }).enrichResult!(
      context({ deckId, known: true, title: "Roadmap" }),
      completed()
    );

    expect(result.status).toBe("completed");
    const parts = result.status === "completed" ? result.resultParts : [];
    expect(parts.at(-1)?.text).toContain(`${BASE_URL}/d/${deckId}.pdf`);
    expect(ledger.get(deckId)).toMatchObject({ slideCount: 2 });
    expect(ledger.get(deckId)?.savedAt).not.toBeNull();
  });
});

describe("the delivery route", () => {
  it("serves a rendered deck", async () => {
    const deckId = newDeckId();
    const tools = buildSlidesTools(
      {
        bucket: env.BUCKET,
        renderPdf: fakeRender(),
        maxSlides: 20,
        reviewer: fakeReviewer()
      },
      execution({ deckId, known: true, title: "Roadmap" })
    );
    await callNamed(tools, "deck_open");
    await callNamed(tools, "deck_save");

    const response = await serveDeck(
      new Request(`${BASE_URL}/d/${deckId}.pdf`),
      env.BUCKET
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/pdf");
    expect(response?.headers.get("content-disposition")).toContain("roadmap");
    expect(response?.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("answers HEAD, which is what a link unfurler sends", async () => {
    const deckId = newDeckId();
    const tools = buildSlidesTools(
      {
        bucket: env.BUCKET,
        renderPdf: fakeRender(),
        maxSlides: 20,
        reviewer: fakeReviewer()
      },
      execution({ deckId, known: true, title: "Roadmap" })
    );
    await callNamed(tools, "deck_open");
    await callNamed(tools, "deck_save");

    const response = await serveDeck(
      new Request(`${BASE_URL}/d/${deckId}.pdf`, { method: "HEAD" }),
      env.BUCKET
    );

    expect(response?.status).toBe(200);
    expect(response?.body).toBeNull();
    expect(Number(response?.headers.get("content-length"))).toBeGreaterThan(0);
  });

  it("404s an id with no deck behind it", async () => {
    const response = await serveDeck(
      new Request(`${BASE_URL}/d/${newDeckId()}.pdf`),
      env.BUCKET
    );

    expect(response?.status).toBe(404);
  });

  it("falls through to A2A for anything that is not a deck", async () => {
    // `null` rather than a 404 is what keeps mounting this in front of
    // `createA2AWorker` safe: the card, the JWKS and `/a2a` are untouched.
    for (const url of [
      `${BASE_URL}/a2a`,
      `${BASE_URL}/d/not-a-deck-id.pdf`,
      `${BASE_URL}/.well-known/agent-card.json`
    ]) {
      expect(await serveDeck(new Request(url), env.BUCKET)).toBeNull();
    }
    expect(
      await serveDeck(
        new Request(`${BASE_URL}/d/${newDeckId()}.pdf`, { method: "POST" }),
        env.BUCKET
      )
    ).toBeNull();
  });
});
