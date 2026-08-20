/**
 * The recorded specs: real HTTP, captured once, replayed forever after.
 *
 * Two halves, and they cover different things.
 *
 * **`vcr wiring`** needs no credentials and no network. Its cassette is
 * hand-written and its host is obviously synthetic, because what it pins is the
 * *transport*: a real `fetch()` from inside workerd has to come out of a
 * committed cassette. This is the half that fails loudly if the recorder ever
 * stops being installed — which has happened before, in core, when the pool
 * removed the `fetchMock` option and an unknown key under `miniflare` was
 * ignored rather than rejected. Nothing noticed until a consumer saw
 * `internal error; reference = …` naming nothing.
 *
 * **`the coder's model call`** is the one that has to be recorded against the
 * real thing, and the only external API this Worker talks to. It exercises the
 * whole credential path in one go: `mintProxyToken` signs, the proxy verifies
 * against this deployment's public JWKS, and core's Anthropic adapter speaks the
 * Messages API and parses what comes back. Every part of that fails *quietly* —
 * a mismatched `iss`/`jku` is a 401 on every request with nothing printing the
 * claim that caused it — and no unit test reaches any of it.
 *
 * ## Recording it
 *
 * ```bash
 * npm run test:record
 * ```
 *
 * It needs two things first, because the replay URL and the record URL have to
 * be the same string — cassettes are matched on method, URL and body:
 *
 * 1. `ANTHROPIC_PROXY_ORIGIN` set to the real proxy origin, in
 *    `vitest.config.ts` rather than your shell, so replay resolves the identical
 *    value. It is a public per-deployment origin, not a credential.
 * 2. `SELF_ORIGIN` below set to an origin the proxy allowlists — it is signed
 *    into the request as `iss`, so recording under one and replaying under
 *    another changes the token.
 * 3. `A2A_SIGNING_KEY` set to the real deployment key, so the proxy accepts the
 *    minted token. This one **is** a credential — keep it in your shell, and
 *    note that `excludeHeaders` in `vitest.config.ts` strips `authorization`
 *    from the cassette, which is what makes the result safe to commit.
 *
 * The call goes straight to the proxy rather than through AI Gateway, which is
 * not the production path but is the recordable one: `env.AI.gateway(id).getUrl()`
 * throws `Binding AI needs to be run remotely`, and this suite sets
 * `remoteBindings: false` deliberately — see the note in `vitest.config.ts`. What
 * that costs is gateway-side coverage; what it keeps is the credential and wire
 * path, which is where the silent failures live.
 *
 * Then commit `test/snapshots/`, and `npm test` replays it with no credentials
 * and no network.
 *
 * ## Two traps, both hit while recording this
 *
 * **Record the one test, not the file.** `npm run test:record` alone also runs
 * `vcr wiring`, whose cassette is hand-written against a synthetic host that
 * cannot be re-recorded. Always pass `-t`:
 *
 * ```bash
 * A2A_SIGNING_KEY='<the real deployment key>' \
 *   npm run test:record -- -t "mints a token the proxy accepts"
 * ```
 *
 * **A failed recording still writes a cassette.** The recorder captures whatever
 * came back, so a run that 401s leaves a cassette that replays that 401 forever
 * — and the next `npm test` reports a confidently wrong failure with no hint it
 * is reading a recording of a mistake. Delete the file and re-record; never
 * commit one without reading the status codes in it:
 *
 * ```bash
 * python3 -c "import json,sys; [print(r['statusCode']) for e in json.load(open(sys.argv[1])) for r in e['responses']]" \
 *   test/snapshots/<cassette>.json
 * ```
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { generateText } from "ai";
import { resolveConfig } from "@loopingai/core";
import { setupRecording } from "@loopingai/core/testing";
import { createAnthropicModelRuntime } from "@loopingai/core/anthropic";
import { mintProxyToken } from "@/agents/coder/proxy-token";
import { CODER_CONFIG } from "@/config";

/**
 * The `iss` the recorded token carries. Pinned rather than read from `env`
 * because it is signed *into* the cassette's request: recording under one origin
 * and replaying under another changes the token, and the proxy would refuse it.
 * Point this at the origin your proxy allowlists before recording.
 */
const SELF_ORIGIN = "https://agents.loopingai.org";

/**
 * Long enough for a real recording, irrelevant on replay.
 *
 * Vitest's 5s default is a *replay* budget: a cassette hit returns in
 * milliseconds. Recording is a live `claude-opus-5` call at `xhigh` effort with
 * thinking on, which routinely runs tens of seconds — so the default turned a
 * successful recording into `Test timed out in 5000ms`, with the cassette left
 * unwritten and nothing naming the real cause.
 */
const RECORD_TIMEOUT_MS = 120_000;

setupRecording();

describe("vcr wiring", () => {
  it("serves a fetch from a committed cassette", async () => {
    const res = await fetch("https://api.example/starter-wiring");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
  });
});

describe("the coder's model call", () => {
  it(
    "mints a token the proxy accepts, and parses what Claude returns",
    async () => {
      // `resolveConfig`, not the raw override: `ModelConfig` requires the fields
      // `CoreConfigOverrides` leaves optional, and this is the same merge the DO
      // does at startup — so the spec calls Claude with the ids the coder really
      // runs on rather than a hand-assembled lookalike.
      const config = resolveConfig(CODER_CONFIG);

      const runtime = createAnthropicModelRuntime({
        // The proxy directly. See the note above on why this is not the gateway.
        baseUrl: () => env.ANTHROPIC_PROXY_ORIGIN,
        // The whole point of the spec: a real signature, verified on the far side.
        // `selfOrigin` is the `iss`, and it must be an origin the proxy allowlists.
        authToken: () => mintProxyToken(env, SELF_ORIGIN),
        config: config.model,
        // The coder's own settings, not defaults — `xhigh` is above the three
        // values core's `reasoningEffort` union allows, so it only reaches the API
        // through this argument, and nothing else asserts that it survives.
        effort: "xhigh",
        cache: "1h"
      });

      const result = await generateText({
        model: runtime.createModelPair().primary(),
        // Deliberately trivial and deterministic: what is under test is the
        // credential and the wire format, not the model's judgement. A prompt with
        // an interesting answer would make this a flaky assertion about Claude.
        prompt: "Reply with exactly the word: ready",
        // Not 16, which is what this asked for while the primary was Sonnet and
        // `effort` was the only reasoning control. The primary is `claude-opus-5`
        // now, thinking is **on by default** there, and thinking tokens are drawn
        // from this same ceiling — so a 16-token budget is spent reasoning about a
        // one-word answer and the reply comes back empty with
        // `finishReason: "length"`. Generous rather than tuned: the recording is
        // made once and the assertion should not be a bet on how long Claude
        // thinks about the word "ready".
        maxOutputTokens: 4096
      });

      expect(result.text.toLowerCase()).toContain("ready");
      expect(result.finishReason).toBeDefined();
      // Named explicitly so a truncated reply fails as itself rather than as a
      // confusing "does not contain ready".
      expect(result.finishReason).not.toBe("length");
    },
    RECORD_TIMEOUT_MS
  );
});
