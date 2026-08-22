import { describe, it, expect } from "vitest";
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
import type { ClaudeCoderSubagent } from "@/agents/claude-coder/subagent";
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
