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
// The pair naming this Worker and the proxy it calls. Public strings rather than
// credentials, but secrets all the same because they are per-deployment, so they
// are answered here like the rest. Nothing in the suite calls the proxy; these
// only need to be well-formed origins.
process.env.SELF_ORIGIN ??= "https://looping-starter.test";
process.env.ANTHROPIC_PROXY_AUDIENCE ??= "https://proxy.test";

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
    include: ["test/**/*.spec.ts"]
  }
});
