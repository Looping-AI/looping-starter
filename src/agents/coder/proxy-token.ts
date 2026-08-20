import { signCallerToken } from "@loopingai/core/a2a";

/**
 * The credential this Worker presents to `looping-anthropic-proxy`.
 *
 * **A signed token, not a shared secret.** Behind an AI Gateway custom provider
 * the only thing surviving the hop is `Authorization`: the gateway strips
 * `cf-aig-authorization`, Access strips its own JWT, and source IP proves
 * nothing because AI Gateway egresses from the same network as every other
 * Worker. So `Authorization` carries the whole trust decision, and a static
 * secret there would be replayable forever once captured and rotatable only by
 * redeploying two Workers in lockstep. The proxy verifies this against a public
 * JWKS instead, so it stores no shared secret at all.
 *
 * **It reuses `A2A_SIGNING_KEY`** — the key already signing this deployment's
 * AgentCards, whose public half is already at the `jku` this token points to. A
 * second key would buy nothing: the two uses are separated by `aud`, and `jose`
 * selects by `kid` regardless.
 */

/** Survives clock skew across two Workers and a gateway hop; worthless from a log. */
const TOKEN_TTL_SECONDS = 120;

/**
 * Attribution only — **no claim in this token selects an Anthropic credential**.
 * The proxy makes that choice from the upstream response alone, so nothing a
 * caller asserts can reach for a different one.
 */
const PROXY_TENANT = "coder";

/**
 * Mint one caller token for one request to the proxy.
 *
 * Per request, not per round or per isolate — which is why
 * `AnthropicRuntimeDeps.authToken` is async-capable and core rebuilds its client
 * per call rather than memoizing one with a baked-in credential.
 *
 * Signing, the key cache, the `iss`/`jku` agreement and audience normalization
 * are all `signCallerToken`. Only the claims are this deployment's.
 *
 * ## `selfOrigin` is discovered, not configured
 *
 * It comes from core's `requireSelfOrigin()` — the origin under the `jku` that
 * arrives with every turn — which is why this Worker no longer carries a
 * `SELF_ORIGIN` secret. That secret only ever restated the origin the request
 * already came in on, and had to be kept byte-identical by hand with the proxy's
 * `CALLER_ORIGINS`; `looping-anthropic-proxy` deleted its own half of that pair
 * for the same reason and derives the audience it expects from `url.origin`.
 *
 * The value is pinned from the first turn an isolate serves and constant after
 * that, so every token this deployment mints carries the same `iss` until the
 * next deploy. What an operator still has to get right is one line on the other
 * side: the origin this agent is registered and reached at must be in the
 * proxy's `CALLER_ORIGINS` — which was already true of the JWKS the proxy
 * fetches from that same origin.
 */
export async function mintProxyToken(
  env: Env,
  selfOrigin: string
): Promise<string> {
  return signCallerToken({
    signingKey: env.A2A_SIGNING_KEY,
    issuer: selfOrigin,
    audience: env.ANTHROPIC_PROXY_ORIGIN,
    identity: {
      // Attribution, and it moves with the origin for the same reason `iss`
      // does. Nothing on the proxy keys durable state on it.
      key: `looping:coder:${selfOrigin}`,
      name: "Looping coder agent",
      kind: "agent"
    },
    tenant: PROXY_TENANT,
    ttlSeconds: TOKEN_TTL_SECONDS
  });
}
