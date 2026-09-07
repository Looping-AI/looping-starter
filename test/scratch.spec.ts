import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getWorkspace } from "@cloudflare/computer";
import { makeDoHelpers } from "@dynamicagents/core/testing";
import { createAgentRuntime } from "@dynamicagents/core";
import { CODER_CONFIG } from "@/config";
import type { ActiveRepo } from "@/workspace/active-repo";
import { workspaceName } from "@/workspace/object";
import { scratch, SCRATCH_DIR, SCRATCH_REPO } from "@/workspace/scratch";

/**
 * The scratchpad: a place to work when the work is not a repository.
 *
 * It exists because the agents had no way to say "this needs a container, not a
 * checkout", and the observable consequence was one asking its user for an empty
 * repository to clone. What is specified here is the part that is not the tool
 * call — **which workspace the call selects, and what happens to it afterwards**
 * — because that is where a scratchpad could quietly become a workspace nothing
 * ever cleans up.
 *
 * Driven through the plugin with a fake shell, since `git init` needs a
 * container the pool cannot start. The workspace object is real: `noteCheckout`
 * is the seam the whole feature rests on and a fake of it would assert nothing.
 */

const { freshStub: freshWorkspace } = makeDoHelpers(env.CODER_WORKSPACE);

/** `ActiveRepo` over two variables — the same contract, without the SQLite. */
function fakeActive(): ActiveRepo & { seenList: string[] } {
  let current: string | undefined;
  const seen: string[] = [];
  return {
    seenList: seen,
    get: () => current,
    set: (repo) => {
      current = repo;
      if (!seen.includes(repo)) seen.push(repo);
    },
    seen: () => [...seen],
    forget: (repo) => {
      const at = seen.indexOf(repo);
      if (at >= 0) seen.splice(at, 1);
    }
  };
}

/** A shell that records what it was asked and answers from a script. */
function fakeExec(
  answer: (command: string) =>
    | {
        success: boolean;
        stdout?: string;
        stderr?: string;
      }
    | Error
) {
  const commands: string[] = [];
  const exec = async (command: string) => {
    commands.push(command);
    const result = answer(command);
    if (result instanceof Error) throw result;
    return {
      success: result.success,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.success ? 0 : 1
    };
  };
  return { exec, commands };
}

const AUTHOR = { name: "da-coder", email: "coder@example.test" };

/** Build the plugin and call its one tool, as the runtime would. */
async function open(
  config: Parameters<typeof scratch>[0],
  input: { reset?: boolean } = {}
): Promise<string> {
  const runtime = createAgentRuntime({
    config: CODER_CONFIG,
    plugins: [scratch(config)]
  });
  const tools = await runtime.mainAgentTools({
    session: { getCompactions: async () => [] } as never
  });
  // Cast at the call, the way `/computer`'s own suite does: `ToolExecutionOptions`
  // is a bag of things the runtime supplies and this tool reads none of them.
  const execute = tools["scratch_open"]!.execute as (
    input: unknown,
    options: unknown
  ) => Promise<string>;
  return String(await execute(input, {}));
}

/** A workspace with a scratchpad already on disk, as `git init` would leave it. */
async function seedScratch(stub: DurableObjectStub) {
  using ws = await getWorkspace(
    stub as unknown as Parameters<typeof getWorkspace>[0]
  );
  await ws.fs.mkdir(`${SCRATCH_DIR}/.git`, { recursive: true });
  await ws.fs.writeFile(`${SCRATCH_DIR}/.git/HEAD`, "ref: refs/heads/main\n");
}

describe("opening a scratchpad", () => {
  /**
   * The selection is the whole routing decision, and it has to land before any
   * command runs — `exec` and the workspace stub both resolve through it, so a
   * command issued first would run in whichever workspace the last task left
   * open. The same ordering `repo_clone` gets from `beforeCheckout`.
   *
   * The enrolment is the lifecycle half. `sweepIdleWorkspaces` walks `seen()`,
   * so a workspace that never passes through `set()` has no backstop at all —
   * which is the state the accidental `<unassigned>` scratchpad is in today. Going
   * through the same door as a clone is what gives a scratchpad the seven-day
   * reclaim every checkout already has, with no second mechanism to maintain.
   */
  it("selects the scratchpad workspace and enrols it for reclaim", async () => {
    const stub = freshWorkspace("scratch-select");
    await seedScratch(stub);
    const active = fakeActive();
    const { exec } = fakeExec(() => ({ success: true }));

    await open({ exec, workspace: () => stub, active, author: AUTHOR });

    expect(active.get()).toBe(SCRATCH_REPO);
    // What the weekly sweep will walk, and the name it will resolve to.
    expect(active.seen()).toContain(SCRATCH_REPO);
    expect(workspaceName("caller", SCRATCH_REPO)).toBe("caller|<scratch>");
  });

  /**
   * **The empty commit is why this is asserted at all.** Without a `HEAD`, the
   * `git reset --hard` that `discardWorkingTree` runs on a cancelled task fails
   * outright — and that cleanup is best-effort, so the failure is a logged
   * warning and a scratchpad still holding the cancelled session's files, which
   * the next task inherits as its starting point.
   */
  it("creates a repository that can be reset", async () => {
    const stub = freshWorkspace("scratch-create");
    await seedScratch(stub);
    const { exec, commands } = fakeExec((command) =>
      command.startsWith("git rev-parse")
        ? { success: false, stderr: "not a git repository" }
        : { success: true }
    );

    const said = await open({
      exec,
      workspace: () => stub,
      active: fakeActive(),
      author: AUTHOR
    });

    const init = commands.find((c) => c.includes("git init"));
    expect(init).toBeDefined();
    expect(init).toContain("git commit -q --allow-empty");
    expect(said).toContain("Opened a new scratchpad");
  });

  /**
   * A probe that never ran has answered nothing. Read as "there is no repository
   * here", a lost container would re-init over a healthy scratchpad and discard
   * whatever an earlier task left in it — the same distinction `/repo` draws
   * before it clones over a directory.
   */
  it("does not re-init over a scratchpad it could not reach", async () => {
    const stub = freshWorkspace("scratch-unreachable");
    const active = fakeActive();
    const { exec, commands } = fakeExec(() => new Error("EEXEC_LOST"));

    const said = await open({
      exec,
      workspace: () => stub,
      active,
      author: AUTHOR
    });

    expect(said).toContain("could not reach the container");
    expect(said).toContain("Nothing was created or changed");
    expect(commands.some((c) => c.includes("git init"))).toBe(false);
    // The selection still happened, because it happens before anything can fail.
    expect(active.get()).toBe(SCRATCH_REPO);
  });

  /**
   * Durable across tasks is the *point* — a scratchpad that emptied itself would
   * lose the script the user is about to ask about again. So emptying it is
   * something the model asks for, and reopening says what is there rather than
   * letting a brief be written for a tree that is not empty.
   */
  it("reuses what an earlier task left, unless asked to reset", async () => {
    const stub = freshWorkspace("scratch-reuse");
    await seedScratch(stub);
    const { exec, commands } = fakeExec((command) =>
      command.startsWith("git status")
        ? { success: true, stdout: "?? primes.mjs\n" }
        : { success: true }
    );

    const said = await open({
      exec,
      workspace: () => stub,
      active: fakeActive(),
      author: AUTHOR
    });

    expect(commands.some((c) => c.includes("git clean"))).toBe(false);
    expect(said).toContain("Reopened the scratchpad");
    expect(said).toContain("primes.mjs");
  });

  it("empties it when asked", async () => {
    const stub = freshWorkspace("scratch-reset");
    await seedScratch(stub);
    const { exec, commands } = fakeExec(() => ({ success: true }));

    const said = await open(
      { exec, workspace: () => stub, active: fakeActive(), author: AUTHOR },
      { reset: true }
    );

    expect(commands.some((c) => c.includes("git clean -fdxq"))).toBe(true);
    expect(said).toContain("emptied it");
    // Nothing is asked about the tree — this call is what made it empty.
    expect(commands.some((c) => c.startsWith("git status"))).toBe(false);
  });

  /**
   * The failure mode this replaces is the one the whole change is about: a tool
   * that reports success and a delegation that then refuses, with nothing
   * connecting the two. `noteCheckout` runs the same probe the delegation will,
   * so the disagreement surfaces here — in a result the model can act on — or
   * not at all.
   */
  it("says so when the workspace cannot see what was just created", async () => {
    // No `.git` seeded: the workspace probe finds nothing.
    const stub = freshWorkspace("scratch-invisible");
    const { exec } = fakeExec(() => ({ success: true }));

    const said = await open({
      exec,
      workspace: () => stub,
      active: fakeActive(),
      author: AUTHOR
    });

    expect(said).toContain("cannot see it yet");
    expect(said).toContain("scratch_open again before delegating");
  });
});
