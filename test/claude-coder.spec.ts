import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createAgentRuntime } from "@loopingai/core";
import type { PluginHost } from "@loopingai/core/host";
import type { RecipeExecutionRequest } from "@loopingai/core/subtasks";
import { makeDoHelpers } from "@loopingai/core/testing";
import {
  CLAUDE_CODE_TYPE,
  WORKSPACE_RUNTIME_KEY
} from "@loopingai/plugins/claude-code";
import { SANDBOX_FAMILY } from "@loopingai/plugins/computer";
import { BROWSER_FAMILY } from "@loopingai/plugins/browser";
import { REPO_FAMILY } from "@loopingai/plugins/repo";
import { parentPlugins, subagentPlugins } from "@/agents/claude-coder/plugins";
import {
  installNote,
  settleDrain,
  type ClaudeCoderSubagent
} from "@/agents/claude-coder/subagent";
import { CLAUDE_CODER_CONFIG } from "@/config";

/**
 * The claude-coder's wiring, pinned.
 *
 * The division of labour between this file and `@loopingai/plugins` is worth
 * stating, because it is what keeps both suites small. The *machine* — the
 * drain, the cursor, the credential pool, the rotation — is specified in the
 * package, against fakes, with no container in sight. What is asserted here is
 * the **seam**: that this agent hands that machine the right things, and that
 * the paths where it cannot are the ones that fail with a sentence instead of a
 * stack trace.
 *
 * Every test below runs **without a container**, which the pool cannot start.
 * That is not a limitation here — the guards under test are exactly the ones
 * that must fire before a container is ever needed.
 */

/** A host in the shape the plugin lists take, over the test Worker's env. */
const host = (): PluginHost<Env> =>
  ({
    env,
    storage: undefined as unknown as DurableObjectStorage,
    callerKey: () => "test-caller",
    aiGatewayId: CLAUDE_CODER_CONFIG.model?.aiGatewayId ?? "default"
  }) as PluginHost<Env>;

const parent = () =>
  createAgentRuntime({
    config: CLAUDE_CODER_CONFIG,
    plugins: parentPlugins(host())
  });

const toolNames = async () =>
  Object.keys(
    await parent().mainAgentTools({
      session: { getCompactions: async () => [] } as never
    })
  ).sort();

/**
 * The tool split, which no typechecker can see.
 *
 * Two things enforce it and both fail quietly: an allowlist of tool *names*
 * passed to `restrictMainAgentTools`, and the fact that `validateRecipe` runs on
 * the **parent** and silently drops any family the parent did not register.
 */
describe("the parent's surface", () => {
  it("has git, a browser and read-only eyes on the checkout", async () => {
    const names = await toolNames();

    expect(names).toContain("sb_read");
    expect(names).toContain("sb_ls");
    expect(names).toContain("sb_exists");
    expect(names).toContain("repo_clone");
    expect(names).toContain("repo_open_pr");
  });

  /**
   * The whole point of the agent. A parent that could edit would edit, and the
   * session it exists to delegate to would never run.
   */
  it("has no shell, no writer and no editor", async () => {
    const names = await toolNames();

    expect(names).not.toContain("sb_exec");
    expect(names).not.toContain("sb_write");
    expect(names).not.toContain("sb_edit");
  });

  /**
   * `computer` is installed on the parent even though the parent barely uses
   * it, because `validateRecipe` runs here: a family the parent did not register
   * is dropped from every recipe its subagents run. Registering it is not
   * optional, and "tidying away" a plugin the parent does not call is how that
   * breaks.
   */
  it("registers the families a recipe may name, whether or not it calls them", () => {
    const families = [...parent().toolFamilies.keys()];

    expect(families).toContain(SANDBOX_FAMILY);
    expect(families).toContain(BROWSER_FAMILY);
    expect(families).toContain(REPO_FAMILY);
  });

  it("offers exactly one subtask type, and it is the Claude Code one", () => {
    expect(parent().types.keys).toEqual([CLAUDE_CODE_TYPE]);
  });
});

/**
 * One entry, and the reason is not economy.
 *
 * A `claude-code` subtask does not run core's tool loop at all — the session
 * brings its own tools. So there is genuinely nothing for the facet's plugins to
 * build, and the single entry is there to register the *type*: `RecipeSubagentBase`
 * re-checks `validateParams(request.type, …)` on its inbound request, and an
 * empty registry throws `unknown subtask type` before `executeChunk` runs.
 */
describe("the subagent's surface", () => {
  it("registers the type and contributes no tool families", () => {
    const runtime = createAgentRuntime({
      config: CLAUDE_CODER_CONFIG,
      plugins: subagentPlugins(host())
    });

    expect(runtime.types.keys).toEqual([CLAUDE_CODE_TYPE]);
    expect(runtime.toolFamilies.size).toBe(0);
  });

  /**
   * The facet's workspace name comes from `ctx.runtime`, put there by the
   * parent's copy of this plugin. Its own thunk must never be reachable — if it
   * ever is, something is resolving a workspace from a caller identity that does
   * not exist on a facet, and a silent fallback there would send a session into
   * the wrong container.
   */
  it("refuses to resolve a workspace name from the facet side", async () => {
    const plugin = subagentPlugins(host())[0]!;
    // `rejects`, not `toThrow`: `resolveRuntime` is async, so the throw arrives
    // as a rejection and a synchronous assertion would pass the test while
    // leaving an unhandled rejection behind it.
    await expect(
      plugin.resolveRuntime?.({
        taskId: "t",
        subtaskId: 1,
        type: CLAUDE_CODE_TYPE,
        params: {},
        toolFamilies: []
      })
    ).rejects.toThrow(/from ctx.runtime/);
  });
});

/**
 * The facet's namespace exists **only under the test pool**.
 *
 * In production a subagent facet needs no binding and no `new_sqlite_classes`
 * entry — its storage is created beneath the bound parent agent, and
 * `ctx.exports` resolves it by class name. But the Vitest pool only marks
 * *bound* classes as facet-compatible, so `vitest.config.ts` adds one, and it is
 * therefore absent from the generated `Env`. The cast is that fact, written
 * down, in the one file that needs it.
 */
const { freshStub: freshSubagent } = makeDoHelpers(
  (
    env as unknown as {
      CLAUDE_CODER_SUBAGENT: DurableObjectNamespace<ClaudeCoderSubagent>;
    }
  ).CLAUDE_CODER_SUBAGENT
);
const { freshStub: freshWorkspace } = makeDoHelpers(env.CLAUDE_CODER_WORKSPACE);

const request = (): RecipeExecutionRequest => ({
  taskId: "task-1",
  subtaskId: 1,
  type: CLAUDE_CODE_TYPE,
  recipe: {
    key: CLAUDE_CODE_TYPE,
    version: 1,
    soul: "unused",
    toolFamilies: [],
    enabled: true,
    limits: {},
    historyWindow: 1,
    reportMetrics: false
  },
  prompt: "add a --json flag",
  references: [],
  params: {}
});

/**
 * The two ways a chunk can be unable to start, and both must fail *as results*.
 *
 * Neither is transient, so neither may throw: a thrown chunk is retried by the
 * Workflow three times and then abandons the task, and retrying will not
 * conjure a checkout or a plugin registration. A failed subtask with a sentence
 * on it reaches the parent, which can tell the user.
 */
describe("executeChunk refuses to guess", () => {
  it("fails with a wiring sentence when no workspace reached it", async () => {
    const stub = freshSubagent("no-workspace");
    const outcome = await runInDurableObject(
      stub,
      (instance: ClaudeCoderSubagent) => instance.executeChunk(request(), 0)
    );

    expect(outcome.done).toBe(true);
    expect(outcome).toMatchObject({
      result: { status: "failed", modelId: null }
    });
    if (outcome.done && outcome.result.status === "failed") {
      // Names the actual fault — the plugin belongs on the parent, where
      // `resolveRuntime` runs — rather than reporting a missing container.
      expect(outcome.result.error).toMatch(/must be installed on the parent/);
    }
  });

  it("fails with an ordering sentence when nothing has been cloned", async () => {
    // A real workspace, reachable and empty: `checkoutDir()` has nothing to
    // report because no `repo_clone` has run against it.
    const workspace = freshWorkspace("no-checkout");
    const name = await runInDurableObject(workspace, (_i, state) =>
      state.id.toString()
    );

    const stub = freshSubagent("no-checkout");
    const outcome = await runInDurableObject(
      stub,
      (instance: ClaudeCoderSubagent) =>
        instance.executeChunk(request(), 0, { [WORKSPACE_RUNTIME_KEY]: name })
    );

    expect(outcome.done).toBe(true);
    if (outcome.done && outcome.result.status === "failed") {
      expect(outcome.result.error).toMatch(/Clone the repository before/);
    } else {
      expect.unreachable("a subtask with no checkout must fail");
    }
  });
});

/**
 * The pre-flight, and why it is worth an RPC.
 *
 * An invocation carries an 18.7-27k-token cached prefix before it does
 * anything, so starting a session the gateway will refuse pays a container start
 * and that prefix to learn what this answers for free — and reports it as a
 * failed run rather than as a limit with a time on it.
 */
describe("the credential pool", () => {
  it("reports a fresh pool as usable", async () => {
    const workspace = freshWorkspace("fresh-pool");
    const lead = await workspace.claudeCredentials();

    expect(lead.ok).toBe(true);
    if (lead.ok) {
      // The first entry, because order is priority — and the *test* credential,
      // which is the other half of the invariant: nothing real is in this suite.
      expect(lead.index).toBe(0);
      expect(lead.token).toBe("sk-ant-oat01-test-1");
    }
  });
});

/**
 * Cancellation ordering, and the one thing a signal does not buy.
 *
 * `stop` is `killExec(id, { signal: "SIGTERM" })` — it delivers a signal and
 * returns. SIGTERM is chosen *because* Claude Code does more work after it:
 * aborts the turn, kills its Bash process tree, runs its `SessionEnd` hooks,
 * exits 143. Meanwhile the parent's `onTaskCanceled` awaits `abortRun` and then
 * runs `git reset --hard && git clean -fdx` in the same container — and the
 * container-to-workspace sync is driven by the *drain* reaching `done`, so a
 * reset that goes first can be followed by a sync carrying files the session
 * wrote after it. The cleanup that exists to guarantee a clean tree would leave
 * an arbitrary half-reset one.
 *
 * The ordering itself needs a real container and belongs to the deploy-time
 * cancel test. What is coverable here is the wait that establishes it, which is
 * why its bound is injectable.
 */
describe("waiting for an interrupted session to unwind", () => {
  it("returns as soon as the drain settles", async () => {
    let drained: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      drained = resolve;
    });
    // A window far longer than this test could take, so a pass means it
    // observed the drain rather than outliving the bound.
    const waiting = settleDrain(settled, 30_000);
    drained();

    await expect(waiting).resolves.toBe(true);
  });

  it("gives up on a drain that never settles, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();

    // Never resolved: an isolate holding a stream a dead container will not
    // close. A cancellation still has to finish.
    const settled = new Promise<void>(() => {});

    await expect(settleDrain(settled, 10)).resolves.toBe(false);
    // Reported, because the ordering this exists for was not established and a
    // silent pass would hide a working-tree reset racing a filesystem sync.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("did not unwind within the settle window")
    );
  });

  /**
   * The no-session path must not pay the window. `abortRun` defers to the base
   * class when it is holding nothing, and a settle wait applied unconditionally
   * would stall every such cancellation for a full minute.
   */
  it("does not wait when the facet is holding no session", async () => {
    const stub = freshSubagent("abort-idle");
    const started = Date.now();
    const interrupted = await runInDurableObject(
      stub,
      (instance: ClaudeCoderSubagent) => instance.abortRun()
    );

    expect(interrupted).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

/**
 * What a session is told about the tree it is about to work in.
 *
 * The case that earned this: `claude -p` starts whether or not `node_modules`
 * is there, so a container whose `npm ci` could not reach the registry produced
 * a session failing on its first tool call and an install failing in parallel,
 * and the two arrived at the parent as one wordless `failed`. The note is the
 * only place either fact is said out loud to somebody who can act on it.
 */
describe("what the session is told about the install", () => {
  it("hands a failed install's own output to the session", () => {
    const note = installNote({
      state: "failed",
      command: "npm ci --no-audit --no-fund",
      finishedAt: Date.now(),
      error: "exited 1",
      exitCode: 1,
      tail: "npm error code SELF_SIGNED_CERT_IN_CHAIN"
    });

    expect(note).toContain("npm ci --no-audit --no-fund");
    expect(note).toContain("SELF_SIGNED_CERT_IN_CHAIN");
    // The instruction that matters: an environment fault it cannot fix has to
    // come back as a report, not as a workaround nobody can see.
    expect(note).toContain("say exactly that and stop");
  });

  it("says an install is still running rather than letting it look done", () => {
    const note = installNote({
      state: "running",
      command: "npm ci",
      startedAt: Date.now() - 30_000
    });

    expect(note).toContain("still installing");
    expect(note).toContain("npm ci");
  });

  /**
   * Silence on the happy path is deliberate. A session told its dependencies
   * are fine has learned nothing, and it pays for the sentence in prefix tokens
   * on every single run.
   */
  it("says nothing when there is nothing to say", () => {
    expect(installNote({ state: "idle" })).toBeUndefined();
    expect(
      installNote({
        state: "done",
        command: "npm ci",
        exitCode: 0,
        finishedAt: Date.now(),
        ms: 74_000
      })
    ).toBeUndefined();
  });
});
