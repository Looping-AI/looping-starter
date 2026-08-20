import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
// The realm-neutral slice, deliberately. This file runs in **Node**, and the
// `/testing` barrel pulls in `cloudflare:test` and `vitest`, which fails at load
// before a single test runs.
import {
  GATEWAY_ORIGIN,
  TEST_AGENT_PRIVATE_JWK
} from "@loopingai/core/testing/fixtures";
// Node-realm half of the VCR harness: it reaches `node:fs` to read and write
// cassettes, which workerd has no equivalent of.
import { createVcr, recordFromEnv } from "@loopingai/core/testing/node";

/**
 * The whole suite runs in the Workers runtime (workerd via miniflare) through a
 * single `cloudflareTest()` pool — including the loop specs, which drive the
 * round and turn operations against an injected mock model and a `FakeSession`.
 *
 * The pool reads `wrangler.jsonc` directly (main, compat settings, the AI
 * binding, and the three agent DOs with their SQLite migration) so this config
 * cannot drift from it; secrets are supplied via `process.env` below.
 */

// Test defaults for the required secrets. Real env vars — from CI or the shell —
// take precedence via `??=`. The pool sources `secrets.required`
// (wrangler.jsonc) from `process.env` into the worker `env`.
//
// One key for the whole deployment, in tests as in production — the card is
// per-origin, so the key the gateway pins is too.
process.env.A2A_SIGNING_KEY ??= JSON.stringify(TEST_AGENT_PRIVATE_JWK);
process.env.GATEWAY_ORIGINS ??= JSON.stringify([GATEWAY_ORIGIN]);
process.env.ARC_API_KEY ??= "test-key";
// The coder's two. Never real: nothing in the suite reaches Claude, the gateway
// or GitHub — the adapter is unit-tested in core against a fake client, and the
// repo tools against an injected `exec`. These exist only so `secrets.required`
// is satisfied and the pool stops warning.
//
// No Claude credential appears here because this Worker no longer holds one:
// it authenticates to `looping-anthropic-proxy` with a token signed from
// `A2A_SIGNING_KEY` above, and the proxy holds the Anthropic tokens.
//
// `AI_GATEWAY_TOKEN` is a separate authority again: it authenticates this
// Worker *to* AI Gateway, which is why it is listed on its own.
process.env.GITHUB_TOKEN ??= "test-token";
process.env.AI_GATEWAY_TOKEN ??= "test-token";
// The proxy this Worker calls. A public string rather than a credential, but a
// secret all the same because it is per-deployment, so it is answered here like
// the rest. Nothing in the suite calls the proxy; it only needs to be a
// well-formed origin.
//
// This Worker's *own* origin has no line here on purpose: core discovers it from
// the `jku` on each turn, so there is nothing to answer — and a default here
// would hide the case an operator actually hits.
// The real origin, not a placeholder, and that is load-bearing for exactly one
// spec: `recorded.spec.ts` dispatches at this value, so it is baked into the
// cassette's match key (method + URL + body). Recording under a real origin and
// replaying under `https://proxy.test` is a cassette miss that reads as a
// missing recording. Answered here rather than left to a shell variable for the
// same reason — a value only the recorder's machine has is a value replay does
// not have.
//
// Safe to point at production: nothing reaches it without a cassette. The VCR
// `outboundService` blocks every un-recorded fetch rather than forwarding it.
process.env.ANTHROPIC_PROXY_ORIGIN ??= "https://anthropic-proxy.loopingai.org";

/**
 * The recorder, and the reason the suite cannot reach the network by accident.
 *
 * Every outbound fetch flows through this one Miniflare hook. With no active
 * cassette it is **blocked** rather than forwarded, so a spec that grows a real
 * HTTP call fails loudly instead of silently depending on someone's credentials
 * and an internet connection.
 *
 * `outboundService` is the hook, never `fetchMock`: pool 0.20 removed that
 * option, and an unknown key under `miniflare` is ignored rather than rejected —
 * which is how a previous wiring of this failed silently.
 */
const vcr = createVcr({
  snapshotsDir: path.resolve(import.meta.dirname, "test/snapshots"),
  record: recordFromEnv(),
  // What makes a cassette safe to commit, and why replay needs no credentials.
  excludeHeaders: ["authorization", "x-api-key", "cookie", "set-cookie"]
});

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") }
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Required, not just the default. Workers AI has no local execution mode
      // (Miniflare always proxies `AI` through a remote-connection worker), and
      // leaving this unset — even though `false` is its documented default —
      // measurably makes the pool eagerly establish that remote connection per
      // test file (~15-20s total, plus a reproducible teardown hang: "close
      // timed out after 10000ms"). Passing `false` explicitly avoids it
      // entirely: `AI.run()` still fails gracefully the moment a turn actually
      // calls it, but nothing is attempted at test-file startup.
      remoteBindings: false,
      miniflare: {
        outboundService: vcr.outboundService,
        // Test-only Durable Object bindings for the subagent facet classes.
        //
        // In production they need NO binding and NO `new_sqlite_classes` entry —
        // facet storage is created beneath the bound parent agent — but the
        // Vitest pool only marks *bound* classes as DO classes, so without this
        // `ctx.exports.ReactiveSubagent` is not facet-compatible and
        // `subAgent()` throws. See "Notes for testing" in
        // node_modules/agents/docs/sub-agents.md.
        durableObjects: {
          REACTIVE_SUBAGENT: {
            className: "ReactiveSubagent",
            useSQLite: true
          },
          ARC_PLAYER_SUBAGENT: {
            className: "ArcPlayerSubagent",
            useSQLite: true
          },
          CODER_SUBAGENT: {
            className: "CoderSubagent",
            useSQLite: true
          }
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    // Node realm. Last chance to flush a cassette; each is already written when
    // its test releases it, so this is only a safety net.
    globalSetup: ["@loopingai/core/testing/vcr-global-setup"]
  }
});
