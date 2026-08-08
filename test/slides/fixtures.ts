import type { Block, Deck, Slide } from "@/agents/reactive/slides/schema";

/** A syntactically valid deck id — 32 lowercase hex characters. */
export const DECK_ID = "0123456789abcdef0123456789abcdef";
export const OTHER_DECK_ID = "fedcba9876543210fedcba9876543210";

export function block(over: Partial<Block> & Pick<Block, "type">): Block {
  return {
    id: "b1",
    x: 96,
    y: 96,
    w: 400,
    h: 80,
    props: {},
    ...over
  } as Block;
}

export function slide(over: Partial<Slide> = {}): Slide {
  return { id: "s1", blocks: [], ...over };
}

/** A small, valid deck. Every spec starts from this and mutates what it cares about. */
export function deck(over: Partial<Deck> = {}): Deck {
  return {
    schema: "looping.slides.1",
    deckId: DECK_ID,
    title: "Quarterly Review",
    theme: "light",
    slides: [
      slide({
        id: "s1",
        blocks: [
          block({
            id: "t1",
            type: "title",
            x: 96,
            y: 260,
            w: 1008,
            h: 120,
            props: { text: "Quarterly Review", size: "xl" }
          })
        ]
      })
    ],
    ...over
  };
}
