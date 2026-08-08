import { z } from "zod";
import type { ResolvedRecipe, SubtaskTypeSpec } from "@loopingai/core";
import { SLIDES_FAMILY } from "./family";
import { SLIDES_CAPABILITY, slidesDelegationGuidance } from "./main-agent";
import { SLIDES_SUBAGENT_SOUL } from "./soul";

/** The Subtask type the decomposer emits for "build/change a deck" work. */
export const SLIDES_TYPE = "slides";

/**
 * The execution configuration for deck work.
 *
 * **It names no model, and there is no field to name one with.** Core's
 * `ResolvedRecipe` refuses that deliberately, and `validateRecipe` stamps the
 * host's own pair onto the `ValidatedRecipe` the runner consumes. So deck
 * authoring runs on whatever `REACTIVE_CONFIG.model` says — currently
 * `@cf/zai-org/glm-5.2` with `@cf/moonshotai/kimi-k2.7-code` behind it — and
 * there is no `SLIDES.modelId` anywhere. (Pinning one *inside a plugin* is only
 * possible for a plugin that makes its own `generateText` call, the way
 * `@loopingai/plugins/triage` does; nothing here does.)
 *
 * `maxTurns: 34` — a deck is a sequence of cheap, structured edits, and a
 * twelve-slide build measured at roughly one `deck_apply` per two slides plus
 * open, lint, a fix pass and save. Raised from 30 when `deck_review` arrived:
 * a visual review plus acting on what it says is worth several turns, and a run
 * that spends its budget before saving publishes nothing at all. It must stay
 * under 39: a yielding chunk always advances at least one turn, so a run takes at
 * most `maxTurns` chunks and `MAX_CHUNKS_PER_BRANCH` is 40.
 *
 * `historyWindow: 24` counts *assistant messages*, i.e. tool calls rather than
 * slides. It can be this modest because `deck_apply` and `deck_outline` both
 * return the full outline and `elideToolOutputs` keeps the newest result per
 * tool at any age — so the model's picture of the deck stays current even after
 * the turn that produced it has scrolled away.
 *
 * `reportMetrics: false` — someone who asked for a deck does not want a turn
 * count appended to the answer.
 */
export const SLIDES_RECIPE: ResolvedRecipe = {
  key: SLIDES_TYPE,
  version: 1,
  soul: SLIDES_SUBAGENT_SOUL,
  // This family alone, and both omissions are deliberate.
  //
  // No `workspace`: the deck's working copy lives in the workspace, but the
  // family reaches it through its `ToolFamilyContext` — putting `ws_write` in
  // front of the model would let it edit the draft *behind* the op validator,
  // which is the one thing the op schema exists to prevent. `ARC_GAME_RECIPE`
  // dropped the workspace tools for a related reason.
  //
  // No `browser`: research is a different subtask. "A deck about X" decomposes
  // into a `general` subtask that reads about X and a `slides` subtask that
  // depends on it — and core already feeds `dependencyResults` into the child's
  // prompt, so the material arrives without this recipe growing a second job.
  toolFamilies: [SLIDES_FAMILY],
  enabled: true,
  limits: { maxTurns: 34 },
  historyWindow: 24,
  reportMetrics: false
};

/**
 * The slides type. Its one param is an id the model quotes back from a tool
 * result it has already seen — `deck_new` for a new deck, `deck_list` for an
 * existing one — which is what makes the contract checkable before anything
 * runs.
 *
 * `deck_id` is **required**, and that is a constraint rather than a choice:
 * `SubtaskParamsShape` is `Record<string, z.ZodType<string>>` and cannot express
 * an optional param. Which is what makes `deck_new` a main-agent tool: a new
 * deck needs an id to exist *before* the subtask is created, so minting one is
 * the parent's job, not something the child discovers.
 */
export const SLIDES_SPEC: SubtaskTypeSpec = {
  key: SLIDES_TYPE,
  description:
    "Design a slide deck, or revise one that already exists. Produces a rendered PDF.",
  params: z.object({
    deck_id: z
      .string()
      .min(1)
      .describe("An exact deck id from `deck_new` or `deck_list`")
  }),
  paramsHelp:
    "requires param `deck_id` — call `deck_new` for a new deck, or `deck_list` to reuse an existing one",
  // Everything the main agent is told about slides is declared here, never
  // written into a runtime. Both blocks sit on the *type* rather than on the
  // plugin: they are rendered by different call sites, so setting both would
  // make the main agent read the same advice twice on every round.
  capability: SLIDES_CAPABILITY,
  delegationGuidance: slidesDelegationGuidance,
  recipe: SLIDES_RECIPE
};
