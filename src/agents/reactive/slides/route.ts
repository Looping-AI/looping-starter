import { pdfKey } from "./store";

/**
 * `GET /d/<deckId>.pdf` — the delivery route.
 *
 * Mounted in `src/index.ts` *in front of* the handler `createA2AWorker` returns,
 * which is a plain `(request, env) => Promise<Response>` and composes like any
 * other function. Returning `null` here is what makes that composition safe:
 * anything this route does not recognise falls through to A2A untouched, so the
 * card, the JWKS and `/a2a` behave exactly as before.
 *
 * ## Authorization
 *
 * **The deck id is the capability.** It is 128 bits from `crypto.getRandomValues`
 * and appears nowhere but the caller's own ledger and the message the agent sent
 * them — the same model as an unlisted share link. There is no token, no expiry
 * and no session, which is a deliberate trade: the alternative adds a required
 * secret to every deploy to protect a link the recipient is being handed anyway.
 *
 * What the id does *not* do is grant anything else. It reads one object under one
 * prefix; it cannot enumerate, and the regex is what keeps a path from being a
 * path at all.
 */

/** Exactly a 32-hex-character deck id — see `DECK_ID_PATTERN` in `schema.ts`. */
const DECK_PATH = /^\/d\/([0-9a-f]{32})\.pdf$/;

/**
 * Serve a rendered deck, or `null` if this request is not for one.
 *
 * `HEAD` is handled properly rather than falling through: link unfurlers and
 * scanners send it, and answering with a 404 would make a perfectly good deck
 * look broken in the Slack preview that quotes it.
 */
export async function serveDeck(
  request: Request,
  bucket: R2Bucket
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const match = DECK_PATH.exec(new URL(request.url).pathname);
  if (!match) return null;

  const key = pdfKey(match[1]);
  const headers = new Headers({
    // A leaked link should not become a search result. The link is the
    // capability, so the one cheap thing worth doing is keeping it out of an
    // index that would hand it to everybody.
    "x-robots-tag": "noindex, nofollow",
    // **A deck is mutable at a stable URL**, which is the whole point of the
    // feature: "make slide 3 tighter" re-saves over the same key and the user
    // clicks the same link again. `max-age=300` was therefore actively wrong —
    // it served the pre-edit deck for five minutes and made a working edit look
    // like a broken one. It cost real debugging time.
    //
    // `no-cache` still caches; it just requires revalidation before use. With
    // the ETag below that is a 304 in the common case, and a full re-download of
    // ~10 KiB otherwise.
    "cache-control": "no-cache, must-revalidate"
  });

  if (request.method === "HEAD") {
    const meta = await bucket.head(key);
    if (!meta) return notFound();
    meta.writeHttpMetadata(headers);
    headers.set("content-length", String(meta.size));
    headers.set("etag", meta.httpEtag);
    return new Response(null, { headers });
  }

  const object = await bucket.get(key);
  if (!object) return notFound();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

/** Deliberately identical for "no such deck" and "never rendered". */
function notFound(): Response {
  return new Response("No deck here.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
