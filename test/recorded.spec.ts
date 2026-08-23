/**
 * The recorded spec: a real `fetch()` from inside workerd, served from a
 * committed cassette.
 *
 * What this pins is the **transport**, not any particular API. The cassette is
 * hand-written and the host is obviously synthetic, because the thing under test
 * is that the VCR recorder is installed at all — and this fails loudly if it
 * ever stops being. That has happened before, in core, when the pool removed the
 * `fetchMock` option and an unknown key under `miniflare` was ignored rather
 * than rejected. Nothing noticed until a consumer saw
 * `internal error; reference = …` naming nothing.
 *
 * ## There used to be a second half here
 *
 * A `the coder's model call` suite recorded a live Claude call through
 * `looping-anthropic-proxy`, exercising the whole credential path: `mintProxyToken`
 * signed, the proxy verified against this deployment's public JWKS, and core's
 * Anthropic adapter parsed the reply.
 *
 * It is gone with the path it covered. The coder now reaches Workers AI through
 * the `AI` binding, and there is nothing equivalent to record: this suite runs
 * with `remoteBindings: false` (see the note in `vitest.config.ts`), so the
 * binding is not live here, and a binding call is not an HTTP request the
 * recorder can capture in the first place.
 *
 * That suite is also why this file was worth keeping rather than deleting. Its
 * cassette could never be committed — every recording attempt came back `429`
 * from a subscription credential that frontier models refuse — and core's VCR
 * *throws* on a missing cassette rather than skipping, so `npm test` and CI were
 * red for as long as it existed.
 *
 * Model-call coverage lives where it can run without credentials: the unit specs
 * against core's `mock-model`.
 */
import { describe, it, expect } from "vitest";
import { setupRecording } from "@loopingai/core/testing";

setupRecording();

describe("vcr wiring", () => {
  it("serves a fetch from a committed cassette", async () => {
    const res = await fetch("https://api.example/starter-wiring");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
  });
});
