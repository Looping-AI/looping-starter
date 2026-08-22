import type { AgentPlugin, CoreConfigOverrides } from "@loopingai/core";
import type { PluginHost } from "@loopingai/core/host";
import { RecipeSubagentHost } from "@loopingai/core/round";
import type {
  RecipeChunkResult,
  RecipeExecutionRequest,
  RecipeExecutionResult,
  SubtaskRuntime
} from "@loopingai/core/subtasks";
import { getWorkspace } from "@cloudflare/computer";
import {
  claudeCodeSession,
  CLAUDE_CODE_TYPE,
  WORKSPACE_RUNTIME_KEY,
  type ClaudeCodeSession,
  type DrainCursor,
  type DrainOutcome,
  type SessionRuntime
} from "@loopingai/plugins/claude-code";
import { truncateOutput } from "@loopingai/plugins/computer";
import { CLAUDE_CODE_SESSION, CLAUDE_CODER_CONFIG } from "@/config";
import { claudeCodeConfig } from "./claude-code";
import { subagentPlugins } from "./plugins";

/**
 * The claude-coder's subagent facet — a Claude Code session, not a model loop.
 *
 * This is the one facet in this repository that does **not** run core's
 * resumable runner. `executeChunk` is overridden outright: the loop, the tools,
 * the context management and the system prompt all belong to a `claude -p`
 * process inside the workspace container, and core's job shrinks to what it is
 * uniquely good at — durable chunking, retry, cancellation and persistence.
 *
 * The mapping is exact, which is why this is a small file rather than a
 * framework. `RecipeChunkResult` is already
 * `{done:false, progress}` | `{done:true, result, progress}` — which is
 * precisely "the CLI is still running" versus "it exited with a report".
 */

/** Where this facet keeps its place in the session's event stream. */
const CURSOR_KEY = "claude-cursor";

/** Bound on the report text, so one runaway session cannot fill the row. */
const REPORT_MAX = 24_000;

export class ClaudeCoderSubagent extends RecipeSubagentHost<Env> {
  protected agentConfig(): CoreConfigOverrides {
    return CLAUDE_CODER_CONFIG;
  }

  protected agentPlugins(host: PluginHost<Env>): AgentPlugin[] {
    return subagentPlugins(host);
  }

  /**
   * The session driver, built from the same config the parent and the workspace
   * object hold. Its `credentials` thunk is never called here — the swap happens
   * on the Worker side of the container boundary, inside the workspace object.
   */
  #sessionMemo?: ClaudeCodeSession;

  get #session(): ClaudeCodeSession {
    return (this.#sessionMemo ??= claudeCodeSession(
      claudeCodeConfig(this.env, () => {
        throw new Error("a facet resolves its workspace from ctx.runtime");
      })
    ));
  }

  /**
   * The run this instance is holding open right now, for {@link abortRun}.
   *
   * In memory only, and that is correct rather than lazy: an isolate that lost
   * it has no in-flight drain to interrupt, so there is nothing for a persisted
   * copy to do. Mirrors the base class's own `inflight`.
   */
  #inflight?: { name: string; subtaskId: number };

  /**
   * Execute one durable chunk by draining a Claude Code session.
   *
   * The whole method is one of two shapes: start a session and drain its first
   * window, or re-attach to a running one and drain another. Everything else is
   * bookkeeping around those two calls.
   */
  override async executeChunk(
    request: RecipeExecutionRequest,
    chunk: number,
    runtime?: SubtaskRuntime,
    selfOrigin?: string
  ): Promise<RecipeChunkResult> {
    // Defensive rather than expected: this agent declares one type. A different
    // one means somebody added a second, and core's runner is the right thing to
    // hand it to.
    if (request.type !== CLAUDE_CODE_TYPE) {
      return super.executeChunk(request, chunk, runtime, selfOrigin);
    }

    /**
     * Which workspace this session runs in, resolved on the **parent**.
     *
     * `callerKey()` throws on a facet by design, so this cannot be derived here
     * — it is written by the `claude-code` plugin's `resolveRuntime`, which core
     * dispatches to whichever plugin declared the subtask type. Its absence is a
     * wiring fault, not a runtime condition, so it fails loudly.
     */
    const name = runtime?.[WORKSPACE_RUNTIME_KEY];
    if (typeof name !== "string" || !name) {
      return this.#failed(
        "this subtask arrived without a workspace name on its runtime, so " +
          "there is no checkout to work in. That is a wiring fault: the " +
          "claude-code plugin must be installed on the parent, which is where " +
          "`resolveRuntime` runs."
      );
    }

    const stub = this.env.CLAUDE_CODER_WORKSPACE.get(
      this.env.CLAUDE_CODER_WORKSPACE.idFromName(name)
    );
    const cursor = await this.ctx.storage.get<DrainCursor>(CURSOR_KEY);

    /**
     * Ask before paying for a container start.
     *
     * An invocation carries an 18.7-27k-token cached prefix before it does
     * anything, so starting a session whose first model call the gateway will
     * refuse costs that prefix to learn what one RPC answers for free — and
     * reports it as a failed run rather than as a limit with a time on it.
     *
     * Only on the first chunk. A session already running is not asking for a new
     * credential, and refusing to drain one would strand a run that is fine.
     */
    if (!cursor) {
      const lead = await stub.claudeCredentials();
      if (!lead.ok) return this.#failed(this.#exhausted(lead.retryAt));
    }

    /**
     * Where the checkout is — resolved **before** the workspace is opened, so a
     * subtask with nothing to work on costs one RPC rather than a container.
     *
     * From the workspace object, never from the brief: it is the path the repo
     * plugin reported and the install context persisted, so it is exact and a
     * model cannot point a session somewhere else. Undefined means nothing has
     * been cloned, which is a wiring-order mistake the parent's soul is told to
     * avoid — so it fails with that sentence rather than guessing a path.
     */
    const dir = cursor ? undefined : await stub.checkoutDir();
    if (!cursor && !dir) {
      return this.#failed(
        "there is no checkout in this workspace yet, so there is nothing to " +
          "work on. Clone the repository before delegating."
      );
    }

    // `using`, so the client is released even when the drain throws. The handle
    // it hands back is rebuilt on this side of the boundary from the stub's byte
    // stream, so it is a real `ReadableStream` of runtime events — which is what
    // lets the drain live here rather than inside the workspace object.
    using workspace = await getWorkspace(
      stub as unknown as Parameters<typeof getWorkspace>[0]
    );
    const runner = workspace.runtime as SessionRuntime;
    this.#inflight = { name, subtaskId: request.subtaskId };

    let outcome: DrainOutcome;
    try {
      outcome = cursor
        ? await this.#session.resume(runner, cursor)
        : await this.#session.start(
            runner,
            request.subtaskId,
            this.#brief(request),
            dir as string
          );
    } finally {
      this.#inflight = undefined;
    }

    /**
     * Commit the cursor **after** the drain, on every path including `done`.
     *
     * A Workflow retries a chunk step up to three times, and a retry re-reads
     * whatever was last committed — so writing before the drain would skip
     * events the retry never saw. Writing after means a retry re-drains from the
     * last committed sequence, and the duplicated progress notes are harmless
     * because the keys are positional, which is exactly why they are positional.
     */
    await this.ctx.storage.put(CURSOR_KEY, outcome.cursor);

    return outcome.done
      ? {
          done: true,
          progress: outcome.progress,
          result: this.#report(outcome)
        }
      : { done: false, progress: outcome.progress };
  }

  /**
   * Stop the session this instance is holding, so a cancellation lands on the
   * running process rather than at the next chunk boundary.
   *
   * `SIGTERM`, which Claude Code handles properly: it aborts the turn, kills its
   * own Bash process tree, runs `SessionEnd` hooks and exits 143. `SIGKILL`
   * would leave whatever the session had spawned still running in a container
   * that outlives the task.
   *
   * Best-effort, and it must be: a cancellation has to complete whether or not
   * the container is reachable.
   *
   * ## The return value is a claim about who resolves the row, not a status
   *
   * Core reads it that way ([`round/agent.js`](../../../node_modules/@loopingai/core/dist/round/agent.js)):
   * `true` means "there was live work and it has been interrupted, so the chunk
   * path will come back and resolve this subtask"; `false` means "there is no
   * live promise — the isolate was evicted or crashed, so nobody is coming
   * back", and core then transitions the row itself and **deletes this facet**.
   *
   * So `super.abortRun()` is the wrong answer to return here. The base tracks an
   * in-flight *model call*, set inside the `executeChunk` this class overrides
   * outright — for a `claude-code` subtask it is never set, so the base always
   * answers `false`. Returning it would tell core to tear the facet down while
   * `executeChunk` is still unwinding its drain and about to write its cursor.
   *
   * A stopped session does come back: `SIGTERM` ends the process, the drain
   * reaches `done`, and the chunk returns a terminal result. That is exactly the
   * `true` case, so it is reported as one.
   *
   * The base's answer is still right in the two cases this override does not
   * cover — no session held here, or a `stop` that could not be delivered — so
   * those defer to it rather than overclaiming.
   */
  override async abortRun(): Promise<boolean> {
    const inflight = this.#inflight;
    if (!inflight) return await super.abortRun();

    try {
      const stub = this.env.CLAUDE_CODER_WORKSPACE.get(
        this.env.CLAUDE_CODER_WORKSPACE.idFromName(inflight.name)
      );
      using workspace = await getWorkspace(
        stub as unknown as Parameters<typeof getWorkspace>[0]
      );
      await this.#session.stop(
        workspace.runtime as SessionRuntime,
        inflight.subtaskId
      );
      return true;
    } catch (err) {
      // The signal never landed, so the process may still be running and this
      // chunk may never return. `false` is the honest answer: it asks core to
      // finish the transition and clean up rather than wait for a drain that is
      // not coming.
      console.warn("[claude-coder] could not stop the session", {
        err: String(err)
      });
      return await super.abortRun();
    }
  }

  /**
   * What the session is asked to do.
   *
   * The subtask's own prompt, plus the verbatim history the delegating model
   * selected. A Claude Code session has no view of the parent's conversation and
   * cannot ask, so anything that matters has to be inline — which is the same
   * contract every subagent in this repo works under, said to a different
   * process.
   */
  #brief(request: RecipeExecutionRequest): string {
    if (request.references.length === 0) return request.prompt;
    return [
      request.prompt,
      "",
      "## Context from the conversation that produced this task",
      "",
      ...request.references.map((ref) => `**${ref.role}:** ${ref.text}`)
    ].join("\n");
  }

  /**
   * Turn a finished drain into a terminal result.
   *
   * **The text can never be empty.** `persistResult` converts an empty result
   * into a failure, so a session that exits 0 having said nothing would be
   * recorded as a failed subtask — and so would one whose `result` event never
   * arrived because the process died first. Both are handled below rather than
   * left to produce a misleading row.
   *
   * The metrics footer is added here because `CLAUDE_CODE_RECIPE` sets
   * `reportMetrics: false` and core adds none — it is not driving this run. What
   * a session cost is worth knowing when a bucket is shared with a human.
   */
  #report(
    outcome: Extract<DrainOutcome, { done: true }>
  ): RecipeExecutionResult {
    const result = outcome.result;
    // Diagnostic only — core never persists it, and the model that actually ran
    // is the one the session was launched with.
    const modelId = CLAUDE_CODE_SESSION.model;

    if (!result) {
      return {
        status: "failed",
        error:
          `the Claude Code session exited with code ${outcome.exitCode} ` +
          "without reporting a result. Its output was lost with the process — " +
          "the working tree may still hold partial edits.",
        modelId
      };
    }

    const footer = [
      `turns: ${result.numTurns ?? "?"}`,
      `duration: ${Math.round((result.durationMs ?? 0) / 1000)}s`,
      `cost: $${result.costUsd.toFixed(4)}`,
      `cache reads: ${result.usage.cacheRead}`
    ].join(" · ");

    if (result.isError) {
      // Bounded on this path too. A failing session is the *more* likely one to
      // have produced a runaway string — a loop that kept retrying, a command
      // that dumped a binary — and `error` lands in the same durable subtask row
      // the success path writes, so leaving it unbounded would defeat
      // {@link REPORT_MAX} exactly where it matters most.
      const detail =
        truncateOutput(result.text, REPORT_MAX) ||
        `the session ended as ${result.subtype}` +
          (result.apiErrorStatus === null
            ? ""
            : ` after an API ${result.apiErrorStatus}`);
      return {
        status: "failed",
        error: `${detail}\n\n_${footer}_`,
        modelId
      };
    }

    const text =
      truncateOutput(result.text, REPORT_MAX) ||
      "The session completed and reported nothing. Check the working tree " +
        "before assuming the change was made.";

    return {
      status: "completed",
      resultParts: [{ kind: "text", text: `${text}\n\n_${footer}_` }],
      modelId
    };
  }

  /** A terminal failure with words an operator or the parent can act on. */
  #failed(error: string): RecipeChunkResult {
    return {
      done: true,
      progress: [],
      result: { status: "failed", error, modelId: null }
    };
  }

  /** What to say when the whole credential pool is unavailable. */
  #exhausted(retryAt: number | undefined): string {
    if (retryAt === undefined) {
      return (
        "no Anthropic credential in this deployment is usable, and none will " +
        "recover on its own — every one was rejected, or none is configured. " +
        "An operator has to mint a fresh `claude setup-token` credential. " +
        "Nothing was changed in the repository."
      );
    }
    return (
      "every Anthropic credential in this deployment has reached its " +
      `subscription limit. The earliest resets at ${new Date(retryAt).toISOString()}. ` +
      "Nothing was changed in the repository — send this request again after that."
    );
  }
}
