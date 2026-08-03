import { Agent, type Schedule } from "agents";
import type { ToolSet } from "ai";
import { TaskState, type Task } from "@a2a-js/sdk";
import {
  createAgentRuntime,
  resolveConfig,
  validateRecipe,
  type AgentPlugin,
  type AgentRuntime,
  type CoreConfigOverrides,
  type ResolvedRecipe
} from "@loopingai/core";
import {
  parsePrivateJwk,
  buildWorkingTask,
  postNotification,
  signCallbackJwt,
  type GatewayIdentity,
  type PlainTask
} from "@loopingai/core/a2a";
import { AgentDB, stateOf } from "@loopingai/core/db";
import {
  buildAgentSession,
  createModelRuntime,
  finalReplyMessageId,
  newTurnBudget,
  roundAckMessageId,
  sessionText,
  type GatewayMetadata,
  type ModelPair,
  type ModelRuntime,
  type SessionLike,
  type TurnBudget
} from "@loopingai/core/agent";
import type {
  CompositionBranch,
  DependencyResult,
  RecipeChunkResult,
  RecipeExecutionRequest,
  RecipeExecutionResult,
  Subtask,
  SubtaskChunkOutcome,
  SubtaskId,
  SubtaskNode,
  SubtaskRuntime,
  SubtaskScan,
  SubtaskStatus,
  TurnTaskResult,
  TurnVerdict
} from "@loopingai/core/subtasks";
import { FINGERPRINT_MISMATCH, subagentName } from "@loopingai/core/subagent";
import { callerContext } from "@/caller-context";
import type { PluginHost } from "@/plugin-host";
import type { SubagentClass } from "./subagent";
import {
  buildTurnInstructions,
  runTurn,
  type RoundMode,
  type TurnInstructions
} from "./turn";

/**
 * Everything the DO needs to stream **intermediate** `working` push notifications
 * live during a turn. Threaded in from the HandleTaskWorkflow, which owns the
 * terminal `completed` callback; these are the progress messages before it.
 * RPC-serializable (crosses the workflow → DO boundary).
 */
export interface TurnPushContext {
  /** The accepted task id (echoed on every callback of this turn). */
  taskId: string;
  /** A2A context id, echoed on every callback. */
  contextId: string;
  /** Gateway push-notification webhook (also the callback JWT `aud`). */
  pushUrl: string;
  /** Per-task validation token the gateway set; echoed in the callback header. */
  pushToken: string;
  /** This agent's card-signing JWKS URL — the callback JWT `jku` (pinned key). */
  jku: string;
}

/**
 * Stand-in acknowledgement for the unreachable case where a round's Subtasks are
 * durable but its acknowledgment is not in the Session (the ack is always appended
 * first). Neutral by design: the work is valid and running, so the user gets an
 * honest acknowledgement rather than a failed Task.
 */
const RECOVERED_REPLY = "Working on your request.";

/**
 * A **delegating** agent as a Durable Object: one instance per calling
 * gateway-agent (keyed by the verified JWT `identity.key`), each owning **one
 * continuous Session** — durable history plus a self-edited `memory` block,
 * backed by `this.sql`. All of a caller's turns (any channel or thread)
 * accumulate into this single conversation.
 *
 * A task workflow drives the round loop here through native Cloudflare RPC
 * (`runTaskTurn`, `skipBlockedSubtasks`, `executeSubtaskChunk`, …) — not HTTP:
 * the DO is a private implementation detail of the Worker, never exposed over the
 * network, so it needs no internal A2A/JSON-RPC layer.
 *
 * ## Why this is a base class, and why it lives here
 *
 * Two agents in this repo are round agents — `reactive` and `arc-player` — and
 * they differ in exactly five things: config, plugins, soul, subagent facet, and
 * signing key. Everything else, all ~1000 lines of it, is identical. So it lives
 * in `src/round-agent/`, which is neither of their directories: an agent
 * importing a *sibling's* module is precisely what `npm run verify:isolation`
 * fails on, because the sibling's plugin list comes with it.
 *
 * (It caught exactly that during this port. The base class started out in
 * `agents/reactive/agent.ts`, and arc-player extending it pulled `/browser` and
 * `/recall` into a graph that installs neither.)
 *
 * ## What this class no longer knows
 *
 * The predecessor had four ARC-specific leaks in this file — `resolveRuntime`
 * branching on a tool family, an `arcScorecardDeps` helper, `leaseScorecard` /
 * `leasePlay`, and an `enrichResult` that read a game score. Each was a piece of
 * domain policy living in code that had no other reason to know what a scorecard
 * was. They are now hooks on `AgentPlugin`, so the only thing this class knows is
 * that it installed some plugins: nothing here names a card, a guid, or a game.
 *
 * That inversion is what makes one class body serve both agents.
 */
export abstract class RoundAgentBase extends Agent<Env> {
  private session?: SessionLike;
  private _runtime?: AgentRuntime;
  private _models?: ModelRuntime;
  private _pair?: ModelPair;
  private _db?: AgentDB;
  private _instructions?: TurnInstructions;

  /**
   * The verified caller this instance belongs to, set on the first turn.
   *
   * `onStart` runs before any request, so it is not known when `plugins()` is
   * built — which is why anything per-caller (`/recall`'s namespace) takes a
   * thunk. The DO is keyed 1:1 by this value, so it is constant once set.
   */
  private identityKey?: string;

  /**
   * Test-only model injection. A **field**, not a constructor argument or RPC
   * parameter, so it never appears on the generated DO stub: production callers
   * cannot reach it, and no model configuration crosses the RPC boundary.
   */
  modelsOverride?: ModelPair;

  // --- the three seams a subclass overrides --------------------------------

  /** This agent's config overrides. Merged onto core's baseline once, at start. */
  protected abstract agentConfig(): CoreConfigOverrides;

  /** This agent's installed capabilities. See `./plugins.ts`. */
  protected abstract agentPlugins(host: PluginHost): AgentPlugin[];

  /**
   * This agent's identity, with the installed plugins' capability blocks already
   * rendered in. Core ships no prompt copy — see `./soul.ts`.
   */
  protected abstract agentSoul(capabilities: string): string;

  /**
   * The facet class this agent's subtasks execute in.
   *
   * A seam because each agent's children must reach that agent's plugins, and a
   * facet cannot be handed a runtime: `parentAgent()` is an RPC stub, and a
   * `SubagentRuntime` is mostly functions. So the class itself carries the
   * binding — see `src/subagent.ts`.
   *
   * Typed as a **concrete** constructor: `RecipeSubagentBase` is abstract, and
   * `subAgent()` rightly refuses an abstract class, since it is what constructs
   * one.
   */
  protected abstract subagentClass(): SubagentClass;

  // --- assembly -------------------------------------------------------------

  /**
   * Everything that would otherwise be a module-level constant, resolved once per
   * DO instance from this agent's config and its installed plugins.
   *
   * Resolving a registry at *import* time is the one thing the package split
   * exists to prevent: it freezes the registry before `env` exists (which on
   * Workers is always), defeats tree-shaking, and makes per-agent plugin
   * selection impossible — which is exactly what this Worker needs, since three
   * agents share one module graph and must not share one plugin list.
   */
  protected get runtime(): AgentRuntime {
    return (this._runtime ??= createAgentRuntime({
      config: this.agentConfig(),
      plugins: this.agentPlugins({
        env: this.env,
        storage: this.ctx.storage,
        // A thunk, not a value — see `identityKey`.
        callerKey: () => this.requireIdentityKey(),
        primaryModelId: this.resolvedModelIds().primary,
        fallbackModelId: this.resolvedModelIds().fallback
      }),
      // Opt in to verifying every plugin's declared bindings exist. Fails at DO
      // start with a sentence naming the plugin, rather than at the first tool
      // call inside a request someone is waiting on.
      env: this.env
    }));
  }

  /**
   * The model ids a locally-declared recipe runs on, resolved before the runtime
   * exists.
   *
   * Deliberately not `this.runtime.config` — that would be a cycle, since
   * building the runtime is what needs these. `resolveConfig` is cheap, pure, and
   * fills in core's defaults, so this is the same pair the runtime will land on;
   * that matters because a recipe's models are checked against
   * `policy.modelAllowlist`, which is built from these very values.
   */
  private resolvedModelIds(): { primary: string; fallback: string } {
    const { model } = resolveConfig(this.agentConfig());
    return { primary: model.chatModelId, fallback: model.fallbackChatModelId };
  }

  /** The agent's database (drizzle + migrations), built once per DO instance. */
  protected get db(): AgentDB {
    return (this._db ??= new AgentDB(this.ctx.storage, {
      maxSubtasks: this.runtime.config.maxSubtasks,
      // Plugin-owned tables, applied after core's own migrations. A store that
      // throws fails DO start rather than being skipped — a plugin whose tables
      // are missing would otherwise fail at its first tool call.
      stores: this.runtime.stores
    }));
  }

  /** The model runtime for this instance, built lazily over the `AI` binding. */
  private get models(): ModelRuntime {
    return (this._models ??= createModelRuntime({
      ai: this.env.AI,
      config: this.runtime.config.model
    }));
  }

  /** The prompt suffixes, built once from this agent's installed subtask types. */
  private get instructions(): TurnInstructions {
    return (this._instructions ??= buildTurnInstructions(
      this.runtime.types,
      this.runtime.config.maxSubtasks,
      this.runtime.config.mainAgentLimits
    ));
  }

  async onStart(): Promise<void> {
    // Await migrations before the SDK dispatches any RPC — eliminates the race
    // between schema creation and first query on cold start / hibernation wake-up.
    await this.db.ensureReady();
    // Register the weekly cleanup cron once per DO instance (idempotent guard).
    const existing = await this.listSchedules({ type: "cron" });
    if (!existing.some((s) => s.callback === "cleanupOldTasks")) {
      await this.schedule("0 1 * * 0", "cleanupOldTasks", {});
    }
  }

  /**
   * Cron handler: delete notify_tasks and their Subtasks older than 30 days.
   * Both are keyed on their own `created_at`, written in the same Task lifecycle,
   * so a parent Task and its Subtasks age out together. Runs Sunday 01:00 UTC.
   *
   * A plugin's own tables are its business — core's journal does not reach them,
   * and neither does this sweep.
   */
  async cleanupOldTasks(
    _payload: Record<string, never>,
    _schedule: Schedule
  ): Promise<void> {
    this.db.tasks.cleanup();
    this.db.subtasks.cleanup();
  }

  /**
   * The main agent's primary/fallback pair. With `metadata` it builds a fresh
   * pair carrying that AI Gateway correlation tag (so `cf ai` ties the call to
   * its Task and round); without it — the Session's own compaction model — it
   * reuses a memoized default. A test `modelsOverride` always wins.
   */
  private modelPair(metadata?: GatewayMetadata): ModelPair {
    if (this.modelsOverride) return this.modelsOverride;
    if (!metadata) return (this._pair ??= this.models.createModelPair());
    return this.models.createModelPair({ metadata });
  }

  /**
   * The one continuous Session for this caller (rebuilt from `this.sql` after
   * eviction). Memoized — `identity` is constant for the DO's life, since the DO
   * is keyed 1:1 by `identity.key`.
   *
   * `onMessagesDisplaced` is the whole integration for anything that wants the
   * messages a compaction folds away: core performs the compaction, so core
   * announces the loss, and the runtime fans it out to every plugin that asked.
   * `/recall`'s archive is one listener; an audit log would be another. It reads
   * no `this`, so the bare reference is correct.
   */
  getSession(identity: GatewayIdentity): SessionLike {
    this.identityKey ??= identity.key ?? undefined;
    const { session, model } = this.runtime.config;
    return (this.session ??= buildAgentSession(
      this,
      this.modelPair().primary(),
      {
        soul: () => this.agentSoul(this.runtime.renderCapabilities()),
        memoryDescription: session.memoryDescription,
        memoryMaxTokens: session.memoryMaxTokens,
        compactAfterTokens: session.compactAfterTokens,
        compactTailTokens: session.compactTailTokens,
        maxOutputTokens: model.maxOutputTokens,
        onMessagesDisplaced: this.runtime.onMessagesDisplaced
      }
    ));
  }

  /**
   * The main agent's **work tools** for this caller — the `execute`-bearing tools
   * every round runs its loop over (see `./turn.ts`). The control tools that *end*
   * a round are not here; `runTurn` adds those.
   *
   * The Session's own `set_context`/`load_context` come first, with the installed
   * plugins' tools layered over them: the soul instructs the model to record
   * durable facts with `set_context`, so it has to actually be on the call.
   *
   * Which plugin tools appear is the plugins' business, not this class's. A
   * plugin may shape its surface from durable state — `/recall` offers its search
   * only once history has actually been compacted, because a tool whose only
   * possible answer is "nothing here yet" costs a call to discover that and costs
   * every round the tokens to describe it.
   */
  private async mainAgentTools(session: SessionLike): Promise<ToolSet> {
    return {
      ...(await session.tools()),
      ...(await this.runtime.mainAgentTools({ session }))
    };
  }

  /** The caller key, which is present on every path that can reach a plugin. */
  private requireIdentityKey(): string {
    if (!this.identityKey) {
      throw new Error("identity.key is required for per-caller isolation");
    }
    return this.identityKey;
  }

  /**
   * POST one `working` Task snapshot to the gateway callback, keyed by a stable
   * semantic `key` (`r<round>:step:<n>` for tool-loop content, `ack:<round>` for a
   * delegating round's acknowledgment). Best-effort: every failure is logged and
   * swallowed, so a progress post never aborts generation or fails a phase.
   */
  private async postWorking(
    push: TurnPushContext,
    text: string,
    key: string,
    signedJwt?: string
  ): Promise<void> {
    try {
      const jwt = signedJwt ?? (await this.signCallback(push));
      const task = buildWorkingTask(push.taskId, push.contextId, text, key);
      const res = await postNotification(
        push.pushUrl,
        push.pushToken,
        jwt,
        task
      );
      if (!res.ok) {
        console.warn("[agent] working notification non-2xx", {
          taskId: push.taskId,
          key,
          status: res.status
        });
      }
    } catch (err) {
      console.warn("[agent] working notification failed", {
        taskId: push.taskId,
        key,
        err: String(err)
      });
    }
  }

  /**
   * Sign a push-notification callback JWT (5m TTL).
   *
   * One key for the whole deployment, read directly rather than through a
   * per-agent seam. The card is served at a well-known URI, which RFC 8615
   * defines per-authority, so this origin publishes one card and the gateway
   * pins one key — every agent here signs its callbacks with it, and `jku`
   * resolves to the one JWKS that serves its public half.
   */
  private signCallback(push: TurnPushContext): Promise<string> {
    return signCallbackJwt(parsePrivateJwk(this.env.A2A_SIGNING_KEY), {
      jku: push.jku,
      aud: push.pushUrl
    });
  }

  /**
   * Build the intermediate-content sink for one round: sign the callback JWT once
   * (lazily, reused across every progress message), then POST each content
   * message as a `working` Task snapshot. The key is `r<round>:step:<stepIndex>`
   * so a re-run dedupes on the gateway — and so two rounds of the same Task cannot
   * collide, which a bare step index would.
   */
  private streamWorking(
    push: TurnPushContext,
    round: number
  ): (text: string, stepIndex: number) => Promise<void> {
    let jwt: string | undefined;
    return async (text: string, stepIndex: number) => {
      try {
        jwt ??= await this.signCallback(push);
      } catch (err) {
        console.warn("[agent] callback signing failed", {
          taskId: push.taskId,
          err: String(err)
        });
        return;
      }
      await this.postWorking(push, text, `r${round}:step:${stepIndex}`, jwt);
    };
  }

  // --- The task round loop (turn → execute → turn → …) ---------------------
  //
  // The parent-owned half of the Task flow. The Workflow drives these over DO RPC
  // (it cannot touch this SQLite or this Session directly); each is a durable
  // step, so every method here is safe to call again after a crash — a round is
  // idempotent on its durable output, and execution recovers from either the
  // parent row or the child's cached result.

  /**
   * One main-agent round: answer the user, or delegate a durable Subtask DAG and
   * return the acknowledgment the user sees while it runs.
   *
   * This is the RPC boundary, so it is where the round's cost becomes a field. The
   * budget is created here, handed to {@link decideRound} to be spent, and read
   * back exactly once — so no branch of the round has to remember to report a
   * number, and none can report the wrong one.
   */
  async runTaskTurn(input: {
    taskId: string;
    text: string;
    identity: GatewayIdentity;
    round: number;
    mode: RoundMode;
    /** What the Task has left. Bounds this round. */
    turnsRemaining: number;
    push?: TurnPushContext;
  }): Promise<TurnTaskResult> {
    const budget = newTurnBudget(input.turnsRemaining);
    const verdict = await this.decideRound(input, budget);
    return { ...verdict, turns: budget.spent };
  }

  /**
   * The round itself, charging `budget` as it goes.
   *
   * Idempotent, and the recovery order is the contract:
   *
   * 1. A canceled Task stops here.
   * 2. A durable **final reply** means some round already answered — return it
   *    without inference. Re-answering could produce different words for a reply
   *    the user may already have received.
   * 3. Durable **rows for this round** mean this round already delegated —
   *    recover its acknowledgment from the Session, with no inference and no
   *    duplicate rows.
   * 4. Otherwise, infer.
   *
   * Cancellation is re-read **after** inference too, not just before it: the model
   * call is the widest window in the round, and neither the Subtask rows nor the
   * callback may land for a Task the caller already gave up on. The reply is
   * already in the Session by then (`runTurn` appends under deterministic ids
   * before returning) — that is durable history, not output the user sees.
   *
   * Returns a typed `failed` result when both models produce unusable output and
   * no durable work exists to fall back on (the Workflow routes it to failed
   * delivery); throws only on a transient fault, for the step to retry.
   */
  private async decideRound(
    input: {
      taskId: string;
      text: string;
      identity: GatewayIdentity;
      round: number;
      mode: RoundMode;
      push?: TurnPushContext;
    },
    budget: TurnBudget
  ): Promise<TurnVerdict> {
    const { taskId, text, identity, round, mode, push } = input;
    const session = this.getSession(identity);

    if (await this.isTaskCanceled(taskId)) return { status: "canceled" };

    const answered = await session.getMessage(finalReplyMessageId(taskId));
    if (answered) {
      return { status: "replied", reply: sessionText(answered) };
    }

    const existing = this.db.subtasks.listRound(taskId, round);
    if (existing.length > 0) {
      const stored = await session.getMessage(roundAckMessageId(taskId, round));
      const reply = stored ? sessionText(stored) : RECOVERED_REPLY;
      if (!stored) {
        // Unreachable: the ack is appended before the rows are persisted. Warn
        // and deliver a neutral acknowledgement rather than poisoning a Task
        // whose subtasks are valid and ready to run.
        console.warn("[agent] round ack missing on recovery", {
          taskId,
          round
        });
      }
      if (push) await this.postWorking(push, reply, `ack:${round}`);
      return { status: "delegated", reply, subtasks: existing };
    }

    const outcome = await runTurn({
      session,
      taskId,
      round,
      text,
      mode,
      budget,
      systemSuffix: callerContext(identity),
      tools: await this.mainAgentTools(session),
      models: this.modelPair({ taskId, round }),
      branches: this.compositionBranches(taskId),
      types: this.runtime.types,
      maxSubtasks: this.runtime.config.maxSubtasks,
      maxOutputTokens: this.runtime.config.model.maxOutputTokens,
      instructions: this.instructions,
      onContent: push ? this.streamWorking(push, round) : undefined
    });
    if (outcome.status === "failed") return outcome;

    // Cancelled while the model worked: persist nothing and publish nothing. The
    // turns stay charged — the model ran, whatever became of its output.
    if (await this.isTaskCanceled(taskId)) return { status: "canceled" };

    if (outcome.status === "replied") {
      return { status: "replied", reply: outcome.reply };
    }

    // The ack is durable in the Session before the rows exist. A crash in this
    // window re-runs the round and persists the *retry's* drafts under the
    // *first* attempt's ack — both are valid outputs of the same input, and no
    // invariant breaks. The reverse order could strand persisted subtasks with no
    // recoverable acknowledgment.
    const subtasks = this.db.subtasks.createDecomposition(
      taskId,
      round,
      outcome.drafts
    );
    if (push) await this.postWorking(push, outcome.reply, `ack:${round}`);
    return { status: "delegated", reply: outcome.reply, subtasks };
  }

  /**
   * Every round's branches for a Task, in stable ordinal order — what a round
   * needs to reunite each earlier `delegate` call with its result (see
   * `renderTurnMessages`). Built inside the DO and consumed here, so the 1 MiB
   * Workflow-step cap that keeps {@link SubtaskNode} narrow does not apply.
   */
  private compositionBranches(taskId: string): CompositionBranch[] {
    return this.db.subtasks.list(taskId).map((s) => ({
      subtaskId: s.id,
      round: s.round,
      ordinal: s.ordinal,
      type: s.type,
      prompt: s.prompt,
      dependsOn: s.dependsOn,
      params: s.params,
      status: s.status,
      resultParts: s.resultParts,
      error: s.error
    }));
  }

  /** A Task's Subtasks, every round, in stable ordinal order. */
  async listSubtasks(taskId: string): Promise<Subtask[]> {
    return this.db.subtasks.list(taskId);
  }

  /**
   * The Workflow's per-wave scan for **one round's** DAG: report a cancellation,
   * or skip every pending Subtask blocked by a dependency that did not succeed and
   * return the refreshed DAG as scheduler {@link SubtaskNode}s.
   *
   * Scoped to the round because dependency edges never cross one: an earlier
   * round's rows are already terminal and irrelevant to this wave, and including
   * them would only widen a projection that has a size cap.
   *
   * Skipping runs to a fixpoint because it propagates: a node skipped for a
   * failed prerequisite blocks *its* dependents in turn. Bounded by the
   * per-round maximum. Independent branches are untouched — one branch's failure
   * never stops work that does not depend on it.
   *
   * The cancellation verdict rides along rather than being probed separately, so
   * a wave costs one round trip and cannot act on a stale answer.
   */
  async skipBlockedSubtasks(
    taskId: string,
    round: number
  ): Promise<SubtaskScan> {
    if (await this.isTaskCanceled(taskId)) return { canceled: true };
    const blocked = new Set<SubtaskStatus>(["failed", "skipped", "canceled"]);
    for (;;) {
      const current = this.db.subtasks.listRound(taskId, round);
      const byId = new Map(current.map((s) => [s.id, s]));
      const next = current.filter(
        (s) =>
          s.status === "pending" &&
          s.dependsOn.some((dep) => {
            const parent = byId.get(dep);
            return parent !== undefined && blocked.has(parent.status);
          })
      );
      if (next.length === 0) {
        return { canceled: false, nodes: current.map(toSubtaskNode) };
      }
      for (const s of next) this.db.subtasks.skip(s.id);
    }
  }

  /** Parent cancellation: cancel every still-pending Subtask. Returns the count. */
  async cancelPendingSubtasks(taskId: string): Promise<number> {
    return this.db.subtasks.cancelPending(taskId);
  }

  /**
   * Force one branch terminal after the Workflow gave up on it: its
   * `execute:<id>` step exhausted every retry, so `executeSubtaskChunk` will not
   * be called again and no one else will resolve the row.
   *
   * The Workflow fails the *branch* rather than the Task so composition can
   * disclose the gap while sibling branches keep their durable results. The
   * managed child releases its external state and is then swept, both
   * best-effort — nothing will read its cache now, but an abandoned run may still
   * hold something outside this system, and dropping the child is not a reason to
   * leak it. Idempotent: a no-op once the row is terminal.
   */
  async failSubtask(id: SubtaskId, error: string): Promise<void> {
    const subtask = this.db.subtasks.get(id);
    if (!subtask) return;
    this.db.subtasks.fail(id, error);
    const name = subagentName(subtask.taskId, id);
    await this.releaseRuntimeQuietly(subtask);
    await this.abortChildQuietly(name, this.toolFamiliesForType(subtask.type));
    await this.deleteChildQuietly(name);
  }

  /**
   * Run **one durable chunk** of a Subtask in an isolated, managed subagent,
   * posting any progress the chunk emitted and durably recording a terminal
   * outcome.
   *
   * The Workflow calls this repeatedly (chunk 0, 1, …) until it returns
   * `done: true` — a single-chunk recipe finishes on chunk 0, a long one spans
   * many. The row status distinguishes the cases with no chunk-number bookkeeping:
   * chunk 0 claims `pending → running` (fresh — delete any stale child); every
   * later chunk (and every retry) finds the row already `running` and leaves the
   * child alone so its checkpointed run state resumes.
   *
   * The lifecycle rules that make it safe to re-run:
   *
   * - A terminal row short-circuits: the result is already durable.
   * - A **fresh** execution deletes any stale child first.
   * - An **ambiguous retry** (row already `running`) must *not* delete the child.
   * - A **successful** chunk does *not* delete its child here — deletion is
   *   deferred to a single post-delivery {@link sweepTaskChildren}, so a facet is
   *   never aborted in the same tick its RPC returned (telemetry would mis-record
   *   that as a failure). The result is still copied into the parent before any
   *   delete; that now happens strictly later.
   *
   * Throws on a transient fault (the step retries and the child resumes from its
   * checkpoint) and on scheduler-invariant violations — both are bugs, not
   * outcomes.
   */
  async executeSubtaskChunk(
    id: SubtaskId,
    chunk: number,
    push?: TurnPushContext
  ): Promise<SubtaskChunkOutcome> {
    const prepared = await this.prepareChunk(id);
    if (prepared.kind === "terminal") {
      return { done: true, status: prepared.subtask.status, progress: [] };
    }
    const { request, recipe, name, runtime } = prepared;

    const outcome = await this.executeChunkInChild(
      name,
      request,
      chunk,
      runtime
    );

    // The Task may have been canceled while the chunk ran — checked *before* any
    // progress is published, so a canceled Task emits nothing further. Applies to
    // a yield as much as to a terminal chunk: a run interrupted mid-flight by
    // `markCanceled` yields rather than caching a bogus failure.
    if (await this.isTaskCanceled(request.taskId)) {
      this.db.subtasks.cancelRunning(id);
      await this.releaseRuntime(request);
      await this.abortChildQuietly(name, recipe.toolFamilies);
      await this.deleteChildQuietly(name);
      return {
        done: true,
        status: this.requireSubtask(id).status,
        progress: outcome.progress
      };
    }

    // Post progress the chunk emitted (best-effort; postWorking never throws).
    // Deterministic keys let the gateway dedupe a re-posted event on replay.
    if (push) {
      for (const event of outcome.progress) {
        await this.postWorking(push, event.text, event.key);
      }
    }

    if (!outcome.done) {
      return { done: false, status: "running", progress: outcome.progress };
    }

    // Let the owning plugin amend the terminal result before it is persisted —
    // e.g. append a score the subagent had no way to read. Returning the result
    // unchanged is always valid, and a plugin that declares no hook gets this for
    // free.
    const result = await this.runtime.enrichResult(
      { request, runtime },
      outcome.result
    );
    const persisted = this.persistResult(id, result);
    if (!persisted) {
      const current = this.requireSubtask(id);
      if (current.status === "pending" || current.status === "running") {
        throw new Error(
          `subtask ${id} could not record its result (status=${current.status})`
        );
      }
      await this.deleteChildQuietly(name);
      return { done: true, status: current.status, progress: outcome.progress };
    }

    // The result is durable in the parent now, but the child is **not** deleted
    // here. `deleteSubAgent` aborts the facet, and aborting it in the same tick
    // this `executeChunk` RPC returned stamps that already-successful invocation
    // `outcome:exception` in telemetry — a false-positive error on every
    // completed Subtask. The parent sweeps all of a Task's children once, after
    // delivery, when every `execute` step has unwound.
    return {
      done: true,
      status: this.requireSubtask(id).status,
      progress: outcome.progress
    };
  }

  /**
   * Delete every managed child this Task created — called **once**, from the
   * Workflow's delivery step, after the Task is terminal.
   *
   * Per-Subtask deletion is deferred to here rather than run right after each
   * successful chunk because `deleteSubAgent` aborts the facet: aborting a child
   * in the same tick its `executeChunk` RPC returned records that
   * already-successful invocation as `outcome:exception`, which is pure
   * false-positive error noise (one per completed Subtask). By delivery every
   * `execute` step has unwound, so these deletes hit **idle** facets and record
   * nothing. Best-effort and idempotent — a name with no live facet is a silent
   * no-op — so a Workflow replay of the sweep step is safe.
   *
   * Cancellation paths do their own child cleanup, so a canceled Task that never
   * reaches delivery does not leak.
   */
  async sweepTaskChildren(taskId: string): Promise<void> {
    for (const subtask of this.db.subtasks.list(taskId)) {
      await this.deleteChildQuietly(subagentName(taskId, subtask.id));
    }
  }

  /**
   * The shared front half of a chunk: resolve terminal/cancel short-circuits,
   * validate the Recipe, claim the row (fresh-vs-retry), and assemble the
   * execution request. Deterministic every chunk, so the request — and thus its
   * fingerprint — is identical across a run's chunks and their retries.
   */
  private async prepareChunk(id: SubtaskId): Promise<
    | { kind: "terminal"; subtask: Subtask }
    | {
        kind: "ready";
        request: RecipeExecutionRequest;
        recipe: ResolvedRecipe;
        name: string;
        runtime: SubtaskRuntime;
      }
  > {
    const subtask = this.db.subtasks.get(id);
    if (!subtask) throw new Error(`unknown subtask: ${id}`);
    const name = subagentName(subtask.taskId, id);

    if (subtask.status !== "pending" && subtask.status !== "running") {
      // Already terminal. Sweep the child in case a previous run persisted the
      // result and crashed before deleting it.
      await this.deleteChildQuietly(name);
      return { kind: "terminal", subtask };
    }

    if (await this.isTaskCanceled(subtask.taskId)) {
      // Start no new work. A row left `running` by a crashed attempt is resolved
      // here — `cancelPending` only reaches pending rows.
      if (subtask.status === "running") {
        this.db.subtasks.cancelRunning(id);
        await this.releaseRuntimeQuietly(subtask);
        await this.abortChildQuietly(
          name,
          this.toolFamiliesForType(subtask.type)
        );
        await this.deleteChildQuietly(name);
        return { kind: "terminal", subtask: this.requireSubtask(id) };
      }
      return { kind: "terminal", subtask };
    }

    const dependencyResults = this.loadDependencyResults(subtask);

    let recipe: ResolvedRecipe | undefined;
    let validated;
    try {
      recipe = this.runtime.types.resolveRecipe(subtask.type);
      validated = validateRecipe(recipe, this.runtime.policy);
    } catch (err) {
      // An unknown/retired type or a disabled/soul-less Recipe is a
      // configuration bug, not a transient fault. Record it as a branch failure
      // so the DAG's skip semantics apply to its dependents.
      const recipeId = recipe?.key ?? subtask.type;
      const recipeVersion = recipe?.version ?? 0;
      const message = recipe
        ? `recipe ${recipeId} unusable: ${String(err)}`
        : `unknown subtask type "${subtask.type}": ${String(err)}`;
      this.db.subtasks.start(id, { recipeId, recipeVersion });
      this.db.subtasks.fail(id, message);
      return { kind: "terminal", subtask: this.requireSubtask(id) };
    }

    // Claim the row. Winning the `pending → running` transition distinguishes a
    // fresh execution (chunk 0) from a retry/continuation — the difference that
    // decides whether the child may be deleted.
    const claimed = this.db.subtasks.start(id, {
      recipeId: validated.key,
      recipeVersion: validated.version
    });

    if (claimed) {
      await this.deleteChildQuietly(name);
    } else {
      const current = this.requireSubtask(id);
      if (current.status !== "running") {
        return { kind: "terminal", subtask: current };
      }
      // Ambiguous retry / later chunk: leave the child so its run state resumes.
    }

    const request: RecipeExecutionRequest = {
      taskId: subtask.taskId,
      subtaskId: id,
      type: subtask.type,
      recipe: validated,
      prompt: subtask.prompt,
      references: subtask.references,
      dependencyResults,
      params: subtask.params
    };
    return {
      kind: "ready",
      request,
      recipe: validated,
      name,
      // Resolve the session state this execution needs and no model can supply —
      // a leased external resource, a session handle, a cookie jar — by asking
      // the plugin that owns the type. `{}` for a type whose plugin declares no
      // `resolveRuntime`, which is most of them.
      //
      // Called once per **chunk**, not once per run, and deliberately outside the
      // fingerprint: what it returns can legitimately change between two chunks
      // of one run, and must not make a retry look like different work.
      runtime: await this.runtime.resolveRuntime({
        taskId: subtask.taskId,
        subtaskId: id,
        type: subtask.type,
        params: subtask.params,
        toolFamilies: validated.toolFamilies
      })
    };
  }

  /**
   * Invoke the managed child for one chunk, recreating it once on a fingerprint
   * mismatch (a stale child from a *different* request — recoverable exactly once;
   * a second mismatch is a genuine lifecycle bug and must surface).
   */
  private async executeChunkInChild(
    name: string,
    request: RecipeExecutionRequest,
    chunk: number,
    runtime: SubtaskRuntime
  ): Promise<RecipeChunkResult> {
    const child = await this.subAgent(this.subagentClass(), name);
    try {
      return await child.executeChunk(request, chunk, runtime);
    } catch (err) {
      if (!String(err).includes(FINGERPRINT_MISMATCH)) throw err;
      console.warn("[agent] stale subagent state, recreating", { name });
      await this.deleteSubAgent(this.subagentClass(), name);
      const fresh = await this.subAgent(this.subagentClass(), name);
      return await fresh.executeChunk(request, chunk, runtime);
    }
  }

  /** Let the owning plugin release whatever `resolveRuntime` acquired. */
  private releaseRuntime(request: RecipeExecutionRequest): Promise<void> {
    return this.runtime.onAbort({
      taskId: request.taskId,
      subtaskId: request.subtaskId,
      type: request.type,
      params: request.params,
      toolFamilies: request.recipe.toolFamilies
    });
  }

  /** The same, from a durable row rather than a built request. Best-effort. */
  private async releaseRuntimeQuietly(subtask: Subtask): Promise<void> {
    try {
      await this.runtime.onAbort({
        taskId: subtask.taskId,
        subtaskId: subtask.id,
        type: subtask.type,
        params: subtask.params,
        toolFamilies: this.toolFamiliesForType(subtask.type)
      });
    } catch (err) {
      console.warn("[agent] plugin runtime release failed", {
        subtaskId: subtask.id,
        err: String(err)
      });
    }
  }

  /** The validated tool families for a Subtask type, or none if unusable. */
  private toolFamiliesForType(type: string): string[] {
    try {
      return validateRecipe(
        this.runtime.types.resolveRecipe(type),
        this.runtime.policy
      ).toolFamilies;
    } catch {
      return [];
    }
  }

  /**
   * Best-effort release of a child's external state on cancellation (e.g. close a
   * leased resource recorded in its workspace). Swallows failures — an unreleased
   * resource is a documented residual, not a reason to fail cancellation.
   */
  private async abortChildQuietly(
    name: string,
    toolFamilies: string[]
  ): Promise<void> {
    if (toolFamilies.length === 0) return;
    try {
      const child = await this.subAgent(this.subagentClass(), name);
      await child.abortExecution(toolFamilies);
    } catch (err) {
      console.warn("[agent] subagent abort failed", { name, err: String(err) });
    }
  }

  /** Persist a child's terminal outcome. Returns whether the guarded write applied. */
  private persistResult(id: SubtaskId, result: RecipeExecutionResult): boolean {
    if (result.status === "failed") {
      return this.db.subtasks.fail(id, result.error);
    }
    try {
      return this.db.subtasks.complete(id, result.resultParts);
    } catch (err) {
      // A "completed" result with no usable text breaks the child's contract.
      // Record it as a failure — retrying would only replay the same bad result
      // from the child's cache forever.
      console.warn("[agent] malformed completed result", {
        subtaskId: id,
        err: String(err)
      });
      return this.db.subtasks.fail(id, `malformed result: ${String(err)}`);
    }
  }

  /**
   * Load a Subtask's dependency results, in ordinal order.
   *
   * Order is semantic: it feeds the child's request fingerprint, so a retry must
   * build the identical array or the cache misses. A dependency that has not
   * completed means the scheduler ran this node too early.
   */
  private loadDependencyResults(subtask: Subtask): DependencyResult[] {
    if (subtask.dependsOn.length === 0) return [];
    const deps = this.db.subtasks
      .list(subtask.taskId)
      .filter((s) => subtask.dependsOn.includes(s.id));
    if (deps.length !== subtask.dependsOn.length) {
      throw new Error(`subtask ${subtask.id} has unknown dependencies`);
    }
    return deps.map((dep) => {
      if (dep.status !== "completed" || !dep.resultParts) {
        throw new Error(
          `subtask ${subtask.id} ran before dependency ${dep.id} completed ` +
            `(status=${dep.status})`
        );
      }
      return {
        subtaskId: dep.id,
        type: dep.type,
        resultParts: dep.resultParts
      };
    });
  }

  /** Re-read a Subtask that must exist (it was just written). */
  private requireSubtask(id: SubtaskId): Subtask {
    const row = this.db.subtasks.get(id);
    if (!row) throw new Error(`subtask ${id} disappeared`);
    return row;
  }

  /** Delete a managed child, swallowing failures (used on best-effort sweeps). */
  private async deleteChildQuietly(name: string): Promise<void> {
    try {
      await this.deleteSubAgent(this.subagentClass(), name);
    } catch (err) {
      console.warn("[agent] subagent cleanup failed", {
        name,
        err: String(err)
      });
    }
  }

  /** Whether the parent Task has been canceled (checked before and after work). */
  private async isTaskCanceled(taskId: string): Promise<boolean> {
    const task = this.db.tasks.get(taskId);
    return task !== null && stateOf(task) === TaskState.TASK_STATE_CANCELED;
  }

  // --- Async task state (accept + notify) ---------------------------------
  //
  // Thin RPC surface delegating to AgentDB's `tasks` table. Native RPC methods —
  // the DO is never a network-reachable server. The workflow, which cannot touch
  // this SQLite directly, calls these via DO RPC.
  //
  // The Task-returning methods return `PlainTask` — the SDK `Task` narrowed to
  // what survives Cloudflare's RPC types. Returning the raw SDK `Task` breaks the
  // generated DO-stub types (under v1.0 it blows past TypeScript's
  // instantiation-depth limit).

  async beginTask(input: {
    messageId: string;
    taskId: string;
    contextId: string;
  }): Promise<PlainTask> {
    return this.db.tasks.begin(input);
  }

  async getTask(taskId: string): Promise<PlainTask | null> {
    return this.db.tasks.get(taskId);
  }

  /**
   * Persist a Task, returning whether the guarded write applied. The Workflow's
   * terminal delivery keys its callback on this: `false` means a cancellation
   * beat it to the row and nothing is sent.
   *
   * A `canceled` state routes to {@link markCanceled} instead of a plain write —
   * this is the path a `tasks/cancel` actually takes today (the a2a-js handler is
   * constructed per request, so its event bus is empty on a cancel call and it
   * records the cancellation through the TaskStore rather than through the
   * executor). Both entry points therefore converge on the same method.
   */
  async saveTask(task: Task): Promise<boolean> {
    if (stateOf(task) === TaskState.TASK_STATE_CANCELED) {
      await this.markCanceled(task.id, task);
      return true;
    }
    return this.db.tasks.save(task);
  }

  /**
   * Move the Task to `working`. Returns `"canceled"` when the caller cancelled
   * first — the Workflow reads that instead of probing with a separate
   * {@link getTask}, which removes the gap between probe and act.
   *
   * Anything else is `"ok"`, including an unknown row and a row already `working`
   * (a replayed step): only an actual cancellation stops the pipeline.
   */
  async markWorking(taskId: string): Promise<"ok" | "canceled"> {
    if (await this.isTaskCanceled(taskId)) return "canceled";
    this.db.tasks.markWorking(taskId);
    return "ok";
  }

  async cancelTask(taskId: string): Promise<PlainTask | null> {
    return this.markCanceled(taskId);
  }

  /**
   * The one place a Task becomes canceled. Flips the row (terminal — every
   * non-canceled write is refused afterwards), then interrupts whatever is still
   * running for it: each `running` Subtask's managed child gets `abortRun`, so a
   * long recipe stops at its current model call instead of at the next chunk
   * boundary (up to `chunkSoftMs` later).
   *
   * `task` is supplied when the caller already built the canceled Task (the
   * a2a-js cancel branch attaches its own status message); otherwise the row's
   * own guarded flip produces it.
   *
   * Best-effort throughout: a child that cannot be reached is logged, never
   * fatal. Cancellation must not fail because cleanup did.
   */
  private async markCanceled(
    taskId: string,
    task?: Task
  ): Promise<PlainTask | null> {
    const canceled = task
      ? (this.db.tasks.save(task), this.db.tasks.get(taskId))
      : this.db.tasks.cancel(taskId);
    if (!canceled) return null;

    // Only `running` rows have a live child. `subAgent` *creates* a facet that
    // does not exist, so a wider fan-out would materialize children just to abort
    // them. Bounded by `maxSubtasks`.
    for (const subtask of this.db.subtasks.list(taskId)) {
      if (subtask.status !== "running") continue;
      const name = subagentName(taskId, subtask.id);
      try {
        const child = await this.subAgent(this.subagentClass(), name);
        await child.abortRun();
      } catch (err) {
        console.warn("[agent] subagent abortRun failed", {
          name,
          err: String(err)
        });
      }
    }
    return canceled;
  }
}

/** Project a durable row to the scheduler's view. */
function toSubtaskNode(s: Subtask): SubtaskNode {
  return {
    id: s.id,
    ordinal: s.ordinal,
    status: s.status,
    dependsOn: s.dependsOn
  };
}
