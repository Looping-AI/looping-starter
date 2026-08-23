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
 * Do not add a suite here that records a real model call. Core's VCR *throws*
 * on a missing cassette rather than skipping, so a suite whose cassette cannot
 * be committed keeps `npm test` and CI red. Model-call coverage belongs where it
 * runs without credentials: the unit specs against core's `mock-model`.
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
