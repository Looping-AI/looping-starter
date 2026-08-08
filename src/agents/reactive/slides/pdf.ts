import type { QuickActionPage } from "agents/browser";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "./schema";

/**
 * The Browser Rendering request that turns a deck's HTML into its PDF.
 *
 * A separate, pure module for one reason: **the defaults here are wrong for this
 * use, and both of the wrong ones shipped invisibly.** The first live decks came
 * out as blank US-Letter pages, and nothing in the type system, the test suite or
 * the deck JSON was able to say so — the JSON was correct, the renderer was
 * correct, and the options that ruined it were an unexamined literal inside a
 * call nobody could reach from a test.
 *
 * What actually happened, both confirmed against a deployed deck:
 *
 * - **`printBackground` defaults to `false`.** Every slide background, `box`
 *   fill and `card` fill was dropped, while text colours rendered normally. A
 *   two-colour test deck came back as two white pages.
 * - **`preferCSSPageSize` defaults to `false`**, so `@page { size: … }` in
 *   `render.ts` was ignored and the page came out `792×612pt` — US Letter,
 *   landscape — instead of `900×506pt`. 1200px-wide content was then laid out on
 *   a 1056px page and clipped on the right.
 *
 * So this file exists to be *asserted*, not just to be tidy. `pdf.spec.ts` pins
 * every field below.
 */

/**
 * `pdfOptions` as the Browser Rendering `/pdf` endpoint accepts it.
 *
 * Declared here because `QuickActionPage` does not carry it: the helper chain is
 * `browserPdf` → `runQuickAction` → `browser.quickAction(action, params)`, which
 * forwards `params` to the REST endpoint verbatim, so a field the SDK's types do
 * not name still arrives. Every property below is documented on the endpoint.
 */
export interface PdfOptions {
  printBackground: boolean;
  preferCSSPageSize: boolean;
  width: string;
  height: string;
  scale: number;
  margin: { top: string; right: string; bottom: string; left: string };
}

export type PdfInput = QuickActionPage & { pdfOptions: PdfOptions };

/**
 * Build the `/pdf` request for a rendered deck.
 *
 * Returned as a typed value rather than written inline at the call site, and
 * that is load-bearing rather than style: TypeScript's excess-property check
 * fires on an object *literal* passed to a `QuickActionPage` parameter, and
 * would reject `pdfOptions` outright. A variable of a wider type is assignable,
 * so this needs no cast — and keeping the cast out is what lets the type still
 * catch a typo in `viewport` or `html`.
 */
export function pdfInput(html: string): PdfInput {
  return {
    html,
    // The layout viewport. Distinct from the paper size below, and both are
    // needed: the viewport is what the page is laid out in, the paper is what it
    // is printed onto. They match here because a slide is exactly one page.
    viewport: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT },
    pdfOptions: {
      // Without this every background is dropped — see the note above.
      printBackground: true,
      // **This must be `true`, and the reason is not obvious.**
      //
      // `format` defaults to `"letter"` (see `BrowserRunPDFOptions` in
      // `worker-configuration.d.ts`) and the endpoint documents format as taking
      // priority over `width`/`height`. So omitting `format` does *not* leave
      // the page unspecified — it leaves it Letter, which then beats the
      // explicit size below. There is no way to unset it.
      //
      // `preferCSSPageSize` is the documented escape: it gives the CSS `@page`
      // rule priority over every other size declaration, format included. So the
      // real source of truth is `@page { size: … }` in `render.ts`, and this is
      // what makes it win.
      //
      // Setting this `false` and trusting `width`/`height` is exactly the bug
      // that shipped: the PDF came back `792×612pt` — Letter, landscape — with
      // 1200px-wide content clipped on it, while `printBackground` (which has no
      // competing default) worked perfectly. Half a fix looks a lot like none.
      preferCSSPageSize: true,
      // Kept as a fallback for a renderer that honours these and ignores
      // `preferCSSPageSize`. They agree with the `@page` rule by construction —
      // both derive from `SLIDE_WIDTH`/`SLIDE_HEIGHT`.
      width: `${SLIDE_WIDTH}px`,
      height: `${SLIDE_HEIGHT}px`,
      scale: 1,
      // A slide is edge to edge; any margin would inset it and shrink the
      // 1200×675 canvas the whole coordinate system assumes.
      margin: { top: "0", right: "0", bottom: "0", left: "0" }
    }
  };
}
