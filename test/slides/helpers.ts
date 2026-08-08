import type { Tool, ToolSet } from "ai";
import { makeWorkspaceHandle, memoryWorkspaceBacking } from "@loopingai/core";
import type { ToolFamilyContext } from "@loopingai/core";
import type { SlidesRuntime } from "@/agents/reactive/slides";
import type { Reviewer } from "@/agents/reactive/slides/review";
import type { DeckLedger, DeckRow } from "@/agents/reactive/slides/store";

/**
 * Run a tool the way the AI SDK would, and return what the model would read.
 *
 * `ToolExecutionOptions` carries fields a real call supplies and a spec cares
 * about none of them, so the cast is confined here rather than repeated.
 */
export async function callNamed(
  tools: ToolSet,
  name: string,
  input: unknown = {}
): Promise<string> {
  const tool: Tool | undefined = tools[name];
  if (!tool) throw new Error(`no tool named "${name}"`);
  const execute = tool.execute;
  if (!execute) throw new Error(`tool "${name}" has no execute`);
  return (await execute(
    input as never,
    {
      toolCallId: "test-call",
      messages: [],
      context: undefined
    } as never
  )) as string;
}

/**
 * A fresh execution context: an in-memory workspace, standing in for the facet's
 * own SQLite.
 *
 * Building a *new* one is how a spec models the thing that actually happens
 * between two edits of a deck — the child is deleted and its workspace goes with
 * it, so the second execution has to re-seed from R2.
 */
export function execution(
  runtime: SlidesRuntime
): ToolFamilyContext<SlidesRuntime> {
  return {
    workspace: makeWorkspaceHandle(memoryWorkspaceBacking()),
    emitProgress: () => {},
    params: {},
    runtime
  };
}

/** An in-memory {@link DeckLedger} — the `ledger` test seam. */
export function fakeLedger(): DeckLedger {
  const rows = new Map<string, DeckRow>();
  return {
    insert(deckId, title) {
      if (rows.has(deckId)) return;
      const now = Date.now();
      rows.set(deckId, {
        deckId,
        title,
        slideCount: 0,
        createdAt: now,
        updatedAt: now,
        savedAt: null
      });
    },
    get: (deckId) => rows.get(deckId) ?? null,
    list: (limit = 10) =>
      [...rows.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit),
    count: () => rows.size,
    recordSave(deckId, title, slideCount) {
      const now = Date.now();
      const existing = rows.get(deckId);
      rows.set(deckId, {
        deckId,
        title,
        slideCount,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        savedAt: now
      });
    }
  };
}

/**
 * A reviewer that never renders or calls a model. `review.spec.ts` covers the
 * real one; everywhere else the deck's *content* is the subject and a review
 * would only add a browser call and a model call to assert nothing about.
 */
export function fakeReviewer(
  reply = "LOOKS GOOD",
  onCall?: (slideIds: readonly string[] | undefined) => void
): Reviewer {
  return {
    review: async (_deck, slideIds) => {
      onCall?.(slideIds);
      return reply;
    }
  };
}

/** A PDF renderer that never touches Browser Rendering. */
export function fakeRender(
  onCall?: (html: string) => void
): (html: string) => Promise<Uint8Array> {
  return async (html) => {
    onCall?.(html);
    return new TextEncoder().encode(`%PDF-1.4 ${html.length} bytes of html`);
  };
}
