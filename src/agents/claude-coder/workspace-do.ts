import {
  claudeCodeSession,
  type CredentialState,
  type CredentialStore,
  type Lead
} from "@loopingai/plugins/claude-code";
import {
  WorkspaceObjectBase,
  type WorkspaceObjectConfig
} from "@/workspace/object";
import { INSTALL_PLAN } from "@/workspace/install-plan";
import { claudeCodeConfig, CREDENTIALS_KEY } from "./claude-code";

/**
 * The claude-coder's workspace, bound as `CLAUDE_CODER_WORKSPACE`.
 *
 * Everything a workspace does is in `src/workspace/object.ts`, shared with the
 * coder: one Durable Object, one container, one repository, the checkout in
 * SQLite, `computerd` mounting it at `/workspace`. Two things are this agent's
 * own, and both exist for the same reason — **the container must never hold an
 * Anthropic credential**.
 *
 * 1. `egress: { mode: "http-gateway" }`, so every outbound request from the
 *    container is intercepted and handed to a `Fetcher` on this side of the
 *    boundary. That `Fetcher` swaps a real credential in.
 * 2. The credential pool's state, in this object's own storage.
 *
 * The container is an arbitrary-code-execution environment by design — `npm ci`
 * runs a cloned repository's `postinstall`, and the agent runs that repository's
 * test suite — so a `printenv` in there finds `CREDENTIAL_PLACEHOLDER` and
 * nothing else.
 */
export class ClaudeCoderWorkspaceDO extends WorkspaceObjectBase {
  /**
   * The credential pool's `{ index → resetAt }` map.
   *
   * **Per workspace, deliberately.** Every workspace draws the same subscription
   * buckets, so the strictly-correct home for this is one shared object that all
   * of them consult. That costs a Durable Object class, a binding, a migration
   * and an RPC on the rotation path; keeping it here costs one wasted `429` per
   * workspace per rotation, bounded by `max_instances`. At five instances that
   * is the cheaper trade by a wide margin — and if it ever stops being, the
   * `CredentialStore` seam is exactly where a shared object would plug in.
   */
  readonly #credentials: CredentialStore = {
    read: async () =>
      (await this.ctx.storage.get<CredentialState[]>(CREDENTIALS_KEY)) ?? [],
    write: async (states) => {
      await this.ctx.storage.put(CREDENTIALS_KEY, states);
    }
  };

  /**
   * Built once, and only for its `egress()` — this object never starts a
   * session. The facet does that, over RPC, through the workspace runtime.
   *
   * The workspace name thunk is unused on this path and would be wrong here
   * anyway: the name is resolved on the *parent*, from the verified caller, and
   * this object already knows which workspace it is by being it.
   */
  readonly #session = claudeCodeSession(
    claudeCodeConfig(this.env, () => this.ctx.id.toString())
  );

  protected workspaceConfig(): WorkspaceObjectConfig {
    return {
      binding: "CLAUDE_CODER_WORKSPACE",
      label: "claude-coder-workspace",
      installPlan: INSTALL_PLAN,
      egress: {
        mode: "http-gateway",
        gateway: this.#session.egress(this.#credentials)
      }
    };
  }

  /**
   * Is any credential usable right now, and if not, when?
   *
   * Asked by the facet **before** it starts a session, and the saving is real:
   * an invocation carries an 18.7-27k-token cached prefix before it does
   * anything, and starting one only to have the gateway refuse its first model
   * call pays a container start and that prefix to learn what this RPC answers
   * for free.
   *
   * Not consulted on resume — a session already running is not asking for a new
   * credential, and refusing to drain one would strand a run that is doing fine.
   */
  async claudeCredentials(): Promise<Lead> {
    return await this.#session.credentials(this.#credentials);
  }
}
