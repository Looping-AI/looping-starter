import {
  WorkspaceObjectBase,
  type WorkspaceObjectConfig
} from "@/workspace/object";
import { INSTALL_PLAN } from "@/workspace/install-plan";

/**
 * The coder's workspace, bound as `CODER_WORKSPACE`.
 *
 * Everything this object does lives in `src/workspace/object.ts` and is shared
 * with `claude-coder`: one Durable Object, one container, one repository, with
 * the checkout in SQLite and `computerd` mounting it over FUSE at `/workspace`.
 * What is *this agent's* is the four values below.
 *
 * The subclass exists rather than the shared class being bound directly because
 * a Durable Object is addressed by class name: two agents need two classes, two
 * bindings and two `new_sqlite_classes` entries, or they would share one
 * namespace and one caller's checkout would answer for both.
 */
export class CoderWorkspaceDO extends WorkspaceObjectBase {
  protected workspaceConfig(): WorkspaceObjectConfig {
    return {
      binding: "CODER_WORKSPACE",
      label: "coder-workspace",
      installPlan: INSTALL_PLAN,
      /**
       * `direct` — the container's own network position, which is the behaviour
       * this agent has always had.
       *
       * Deliberately **not** `http-gateway`. That mode routes every outbound
       * request through a Worker `Fetcher`, and this agent has no reason to put
       * itself on that path: it holds no credential the container needs, since
       * `/repo` runs clone, fetch and push as isomorphic-git inside this object.
       * `claude-coder` is the agent that needs it, and it needs it for exactly
       * one reason — swapping a credential the container must never hold.
       */
      egress: { mode: "direct" }
    };
  }
}

/**
 * Re-exported, not moved on.
 *
 * `WORKSPACE_DIR` and `workspaceName` are read by this agent's `plugins.ts`,
 * `agent.ts` and its specs. Keeping the import path they already use means the
 * extraction is invisible to them — which is the point of a behaviour-preserving
 * refactor, and what lets the ten existing workspace specs stand as the
 * regression net for it.
 */
export { WORKSPACE_DIR, workspaceName } from "@/workspace/object";
