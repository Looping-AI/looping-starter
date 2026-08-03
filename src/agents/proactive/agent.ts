import { Agent, type Schedule } from "agents";
import { env } from "cloudflare:workers";
import type { Task } from "@a2a-js/sdk";
import {
  createAgentRuntime,
  resolveConfig,
  type AgentRuntime,
  type CoreConfig
} from "@loopingai/core";
import {
  parsePrivateJwk,
  buildWorkingTask,
  postNotification,
  signCallbackJwt,
  type GatewayIdentity,
  type PlainTask,
  type TaskListQuery
} from "@loopingai/core/a2a";
import { AgentDB } from "@loopingai/core/db";
import {
  buildAgentSession,
  createModelRuntime,
  sessionMessage,
  type ModelPair,
  type ModelRuntime,
  type SessionLike
} from "@loopingai/core/agent";
import { noReplyTool, NO_REPLY_TOOL_NAME } from "@loopingai/plugins/triage";
import { MAX_STEPS, PROACTIVE_CONFIG } from "@/config";
import { callerContext } from "@/caller-context";
import { soulPrompt } from "./soul";
import { plugins } from "./plugins";
import { runTurn, type TurnOutcome } from "./loop";

/**
 * Everything the DO needs to stream intermediate `working` push notifications
 * live during a turn. RPC-serializable (crosses the workflow → DO boundary).
 */
export interface TurnPushContext {
  taskId: string;
  contextId: string;
  /** Gateway push-notification webhook (also the callback JWT `aud`). */
  pushUrl: string;
  /** Per-task validation token the gateway set; echoed in the callback header. */
  pushToken: string;
  /** This agent's card-signing JWKS URL — the callback JWT `jku` (pinned key). */
  jku: string;
}

/** User-facing text when a turn fails for an unexpected (non-transient) reason. */
const UNEXPECTED_REPLY =
  "Sorry — something went wrong while I was working on that.";

/** This agent's model pair, resolved over core's defaults. */
function resolvedModelIds(): {
  primaryModelId: string;
  fallbackModelId: string;
} {
  const { model } = resolveConfig(PROACTIVE_CONFIG);
  return {
    primaryModelId: model.chatModelId,
    fallbackModelId: model.fallbackChatModelId
  };
}

/**
 * The proactive agent as a Durable Object: one instance per calling gateway-agent
 * (keyed by the verified JWT `identity.key`), each owning **one continuous
 * Session** — durable history plus a self-edited `memory` block, backed by
 * `this.sql`.
 *
 * ## Why this file matters more than its size suggests
 *
 * It is the **second consumer**. Everything it shares with `../reactive/agent.ts`
 * — the runtime built in `onStart`, `AgentDB` over plugin stores, the session with
 * its displacement fan-out, the model pair — is shared because two genuinely
 * different agents both needed it, not because one agent happened to be written
 * that way. Everything it does *not* share is the evidence that core stopped at
 * the right place: no Workflow, no subagent facet, no delegation, no round
 * budget, and a turn that is allowed to end in silence.
 *
 * The outer Worker reaches this DO with a single native Cloudflare RPC call —
 * `stub.converse(...)` — not HTTP: the DO is a private implementation detail of
 * the Worker, never exposed over the network.
 */
export class ProactiveAgent extends Agent<Env> {
  private session?: SessionLike;
  private _runtime?: AgentRuntime;
  private _models?: ModelRuntime;
  private _pair?: ModelPair;
  private _db?: AgentDB;
  private identityKey?: string;

  /** Test-only model injection. A field, so it never reaches the RPC stub. */
  modelsOverride?: ModelPair;

  /**
   * Everything that would otherwise be a module-level constant, resolved once per
   * DO instance from this agent's config and its installed plugins.
   */
  private get runtime(): AgentRuntime {
    return (this._runtime ??= createAgentRuntime({
      config: PROACTIVE_CONFIG,
      plugins: plugins({
        env: this.env,
        storage: this.ctx.storage,
        callerKey: () => this.requireIdentityKey(),
        // Inert for this agent: it declares no recipes, because it never
        // delegates. Passed anyway so `PluginHost` stays one shape across all
        // three agents rather than three near-identical ones.
        ...resolvedModelIds()
      }),
      env: this.env
    }));
  }

  private get config(): CoreConfig {
    return this.runtime.config;
  }

  /** The agent's database (drizzle + migrations), built once per DO instance. */
  private get db(): AgentDB {
    return (this._db ??= new AgentDB(this.ctx.storage, {
      maxSubtasks: this.config.maxSubtasks,
      stores: this.runtime.stores
    }));
  }

  private get models(): ModelRuntime {
    return (this._models ??= createModelRuntime({
      ai: this.env.AI,
      config: this.config.model
    }));
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

  /** Cron handler: delete notify_tasks rows older than 30 days. Sunday 01:00 UTC. */
  async cleanupOldTasks(
    _payload: Record<string, never>,
    _schedule: Schedule
  ): Promise<void> {
    this.db.tasks.cleanup();
  }

  private modelPair(): ModelPair {
    if (this.modelsOverride) return this.modelsOverride;
    return (this._pair ??= this.models.createModelPair());
  }

  /** The caller key, present on every path that can reach a plugin. */
  private requireIdentityKey(): string {
    if (!this.identityKey) {
      throw new Error("identity.key is required for per-caller isolation");
    }
    return this.identityKey;
  }

  /**
   * The one continuous Session for this caller (rebuilt from `this.sql` after
   * eviction). Memoized — `identity` is constant for the DO's life.
   *
   * The `onMessagesDisplaced` wiring is identical to the reactive agent's, and
   * that is the point: core performs the compaction, so core announces the loss,
   * and every plugin that asked to hear about it does. Neither agent knows that
   * `/recall` is what listens.
   */
  getSession(identity: GatewayIdentity): SessionLike {
    this.identityKey ??= identity.key ?? undefined;
    const { session, model } = this.config;
    return (this.session ??= buildAgentSession(
      this,
      this.modelPair().primary(),
      {
        soul: () => soulPrompt(this.runtime.renderCapabilities()),
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
   * Answer one turn for this caller and return how it ended: a reply to deliver,
   * a deliberate `no_reply`, or `failed`. The workflow maps those onto the three
   * terminal Task shapes.
   *
   * ## The two places a turn can decline
   *
   * **The gate, here.** Every plugin declaring `shouldHandleTurn` is consulted
   * before anything expensive is built or called, and the answers are AND-ed. The
   * user message is appended *first* — deliberately — so a message the agent
   * declines is still read into history: it follows the channel whether or not it
   * speaks, and the next message's gate needs this one for context.
   *
   * **The `no_reply` tool, in the loop.** The late counterpart: look something up,
   * then conclude there is nothing worth adding. The gate judges the message; the
   * tool judges what looking into it turned up.
   *
   * The union is returned whole rather than collapsed to a scalar. The constraint
   * that used to force a collapse is narrower than it looks: DO RPC intersects
   * every *object* return with `Disposable`, whose symbol key fails the
   * `Rpc.Serializable` bound — but that bound applies to what a `step.do(...)`
   * **returns**, not to what an RPC hands back inside one. The workflow projects
   * this union onto a fresh object literal within its step.
   *
   * `runTurn` never throws — it reports failure as `failed` rather than rejecting
   * — so this rejects only on a genuine RPC/transport fault.
   */
  async converse(
    text: string,
    identity: GatewayIdentity,
    push?: TurnPushContext
  ): Promise<TurnOutcome> {
    const session = this.getSession(identity);

    // Append **before** the gate, so a message the agent declines is still read
    // into history: it follows the channel whether or not it speaks, and the next
    // message's gate needs this one for context. The gate then judges a history
    // that already includes the message being judged — which is what makes an
    // otherwise unclassifiable turn ("yes", "thanks", "and the second one?")
    // classifiable at all.
    await session.appendMessage(sessionMessage("user", text));
    const history = await session.getHistory();

    if (!(await this.runtime.shouldHandleTurn({ history }))) {
      return { kind: "no_reply" };
    }

    return runTurn({
      session,
      history,
      systemSuffix: callerContext(identity),
      tools: {
        ...(await this.runtime.mainAgentTools({ session })),
        // The late decline. Contributed here rather than by the plugin's
        // `mainAgentTools`, because whether it is on the call changes *within* a
        // turn — it is withdrawn the moment the agent speaks — and a plugin's
        // tool surface is resolved once, before the turn starts.
        [NO_REPLY_TOOL_NAME]: noReplyTool
      },
      models: this.modelPair(),
      maxSteps: MAX_STEPS,
      unexpectedReply: UNEXPECTED_REPLY,
      onContent: push ? this.streamWorking(push) : undefined
    });
  }

  /**
   * Build the intermediate-content sink for a turn: sign the callback JWT once
   * (lazily, reused across every progress message; 5m TTL), then POST each content
   * message as a `working` Task snapshot. Best-effort — every failure is logged
   * and swallowed so streaming never aborts generation or the turn.
   *
   * The key is the bare step index because this agent runs exactly one turn per
   * task; an agent with rounds must key on both (see `buildWorkingTask`).
   */
  private streamWorking(
    push: TurnPushContext
  ): (text: string, stepIndex: number) => Promise<void> {
    let jwt: string | undefined;
    return async (text: string, stepIndex: number) => {
      try {
        jwt ??= await signCallbackJwt(
          parsePrivateJwk(this.env.A2A_SIGNING_KEY),
          { jku: push.jku, aud: push.pushUrl }
        );
        const task = buildWorkingTask(
          push.taskId,
          push.contextId,
          text,
          String(stepIndex)
        );
        const res = await postNotification(
          push.pushUrl,
          push.pushToken,
          jwt,
          task
        );
        if (!res.ok) {
          console.warn("[proactive-agent] working notification non-2xx", {
            taskId: push.taskId,
            stepIndex,
            status: res.status
          });
        }
      } catch (err) {
        console.warn("[proactive-agent] working notification failed", {
          taskId: push.taskId,
          stepIndex,
          err: String(err)
        });
      }
    };
  }

  // --- Async task state (accept + notify) ---------------------------------
  //
  // Thin RPC surface delegating to AgentDB's `tasks` table. Native RPC methods —
  // the DO is never a network-reachable server. The workflow, which cannot touch
  // this SQLite directly, calls these via DO RPC.

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

  async listTasks(
    query: TaskListQuery
  ): Promise<{ tasks: PlainTask[]; totalSize: number }> {
    return this.db.tasks.list(query);
  }

  async saveTask(task: Task): Promise<boolean> {
    return this.db.tasks.save(task);
  }

  async markWorking(taskId: string): Promise<void> {
    this.db.tasks.markWorking(taskId);
  }

  async cancelTask(taskId: string): Promise<PlainTask | null> {
    return this.db.tasks.cancel(taskId);
  }
}

/** The resolved config, for callers outside the DO (the workflow). */
export const proactiveConfig = (): CoreConfig =>
  resolveConfig(PROACTIVE_CONFIG);

/**
 * Resolve the per-caller agent DO stub, keyed by the verified `identity.key`.
 * Pure routing — the DO's methods are honestly typed now that its `Task` returns
 * are `PlainTask`, so callers reach the agent directly with no cast.
 */
export function getAgent(
  identity: GatewayIdentity
): DurableObjectStub<ProactiveAgent> {
  if (!identity.key) {
    throw new Error("identity.key is required to route to the agent DO");
  }
  return env.ProactiveAgent.get(env.ProactiveAgent.idFromName(identity.key));
}
