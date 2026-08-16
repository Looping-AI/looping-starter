import { importJWK, SignJWT, type JWK } from "jose";
import {
  A2A_JWS_ALG,
  IDENTITY_CLAIM,
  TENANT_CLAIM,
  jwksUrl,
  parsePrivateJwk
} from "@loopingai/core/a2a";

/**
 * The credential this Worker presents to `looping-anthropic-proxy`.
 *
 * ## Why a signed token and not a shared secret
 *
 * The proxy sits behind an AI Gateway custom provider, and the only thing that
 * survives that hop is `Authorization` — the gateway consumes and strips
 * `cf-aig-authorization`, Cloudflare Access strips its own JWT, and source IP
 * proves nothing because AI Gateway egresses from the same Cloudflare network
 * as every other Worker on the platform.
 *
 * So `Authorization` carries the whole trust decision, and a static shared
 * secret there is the weakest thing that could go in it: replayable forever
 * once captured, identical for every caller, and rotatable only by redeploying
 * two Workers in lockstep.
 *
 * A short-lived EdDSA JWT is strictly better and costs one signature. The proxy
 * verifies it with core's `verifyGatewayToken` — the same primitive already
 * guarding the A2A surface — against a **public** JWKS, so the proxy stores no
 * shared secret at all. A captured token is audience-bound to one host and dead
 * within {@link TOKEN_TTL_SECONDS}.
 *
 * ## Why it reuses `A2A_SIGNING_KEY`
 *
 * The same Ed25519 key signs this deployment's AgentCards, and its public half
 * is already published at the JWKS this token's `jku` points to. A second key
 * would mean a second JWKS entry for no security gain: the two uses are
 * separated by `aud` (this token is minted for the proxy and refused anywhere
 * else) and `jose` selects by `kid` regardless. Worth revisiting only if the
 * card key ever needs a different rotation cadence than this one.
 */

/**
 * Long enough to survive clock skew between two Cloudflare Workers and a
 * gateway hop; short enough that a token captured from a log is worthless by
 * the time anyone reads it.
 */
const TOKEN_TTL_SECONDS = 120;

/**
 * What this deployment calls itself to the proxy.
 *
 * The proxy logs it for attribution and nothing more — **no claim in this token
 * selects an Anthropic credential**. That choice is made inside the proxy from
 * the upstream response alone, precisely so nothing a caller can assert reaches
 * for a different one.
 */
const PROXY_TENANT = "coder";

/**
 * `importJWK` does real work, and this is on the per-request path.
 *
 * Keyed by the raw secret so a rotated `A2A_SIGNING_KEY` invalidates it rather
 * than being ignored for the life of the isolate — the same property the lazy
 * secret reads elsewhere in this agent are careful to keep.
 */
type SigningKey = Awaited<ReturnType<typeof importJWK>>;

let cached: { raw: string; key: SigningKey; kid: string } | undefined;

async function signingKey(
  raw: string
): Promise<{ key: SigningKey; kid: string }> {
  if (cached?.raw === raw) return cached;
  const jwk: JWK & { kid: string } = parsePrivateJwk(raw);
  // Not cast to `CryptoKey`: `importJWK` returns a union, and asserting the
  // branch would be a lie the day this key is anything but Ed25519. `sign()`
  // accepts the union as-is.
  const key = await importJWK(jwk, A2A_JWS_ALG);
  cached = { raw, key, kid: jwk.kid };
  return cached;
}

/**
 * Mint one caller token for one request to the Anthropic proxy.
 *
 * Called per model request rather than per round or per isolate: a token this
 * short-lived cannot be captured once and reused, which is why
 * `AnthropicRuntimeDeps.authToken` is async-capable and why core rebuilds its
 * Anthropic client per call instead of memoizing one with a baked-in credential.
 */
export async function mintProxyToken(env: Env): Promise<string> {
  const { key, kid } = await signingKey(env.A2A_SIGNING_KEY);
  return (
    new SignJWT({
      [IDENTITY_CLAIM]: {
        key: `looping:coder:${env.SELF_ORIGIN}`,
        name: "Looping coder agent",
        kind: "agent"
      },
      [TENANT_CLAIM]: PROXY_TENANT
    })
      .setProtectedHeader({
        alg: A2A_JWS_ALG,
        kid,
        // Where the proxy fetches the public half. It validates this origin
        // against its own allowlist *before* fetching, which is what stops a
        // forged token from nominating an attacker-controlled JWKS.
        jku: jwksUrl(env.SELF_ORIGIN)
      })
      // Must agree with `jku`'s origin, or the proxy refuses it — that check is
      // what stops one allowlisted origin impersonating another.
      .setIssuer(env.SELF_ORIGIN)
      // Bound to the proxy specifically, so this token is useless against any
      // other service that trusts the same signing key.
      .setAudience(env.ANTHROPIC_PROXY_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
      .sign(key)
  );
}
