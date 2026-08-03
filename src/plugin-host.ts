/**
 * Everything a plugin may need from its host, resolved per Durable Object
 * instance.
 *
 * Not just `env`, and each addition is load-bearing:
 *
 * - `storage` — a plugin that owns tables needs the DO's storage to build a
 *   query handle over (`@loopingai/plugins/arc-agi` does). `this.ctx.storage`.
 * - `callerKey` — **a thunk, deliberately.** It derives from the verified
 *   caller's identity, which does not exist yet when `plugins()` runs in
 *   `onStart()`. The DO is keyed 1:1 by that caller, so the value is constant
 *   once known; a thunk is what lets the host supply it late while every hook
 *   reads the same one.
 * - the model ids — what a locally-declared recipe runs on. A recipe may only
 *   name models in the host's allowlist, so a plugin that ships a recipe is
 *   handed the host's pair rather than guessing.
 *
 * It lives at the top level rather than in one agent's directory because all
 * three agents pass this shape, and an agent importing it from a *sibling* is
 * exactly the kind of edge `npm run verify:isolation` fails on — a type-only
 * import is erased, but the next person makes it a value import and the sibling's
 * whole plugin list comes with it.
 */
export interface PluginHost {
  env: Env;
  storage: DurableObjectStorage;
  /** The verified caller. A thunk — it does not exist when `onStart` runs. */
  callerKey: () => string;
  /** `config.model.chatModelId` — what a locally-declared recipe runs on. */
  primaryModelId: string;
  /** `config.model.fallbackChatModelId`. */
  fallbackModelId: string;
}
