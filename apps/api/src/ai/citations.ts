// Citation resolution — extracted from ai.ts so BOTH the chat module and the
// `search_cards` tool (apps/api/src/ai/tools.ts) share one implementation.
//
// Resolves retrieved chunks into RagChunk (for the prompt/model-facing text) +
// Citation[] (for the client + persistence). Deck names are looked up in one
// batched query for the prompt context block.

import { inArray } from 'drizzle-orm';
import { db, decks, type Citation } from '@reomi/db';
import {
  CARD_TOKEN_RE,
  SRC_TOKEN_RE,
  isSourceCitation,
  type RagChunk,
  type SourceCitation,
} from '@reomi/shared';
import type { RankedChunk } from './retrieve.ts';

/** Snippet length stored on each Citation (for the client's hover/preview). */
export const SNIPPET_LEN = 240;

export async function resolveCitations(
  hits: RankedChunk[],
): Promise<{ ragChunks: RagChunk[]; citations: Citation[] }> {
  if (hits.length === 0) return { ragChunks: [], citations: [] };

  const deckIds = [...new Set(hits.map((h) => h.deckId))];
  const deckRows = await db
    .select({ id: decks.id, name: decks.name })
    .from(decks)
    .where(inArray(decks.id, deckIds));
  const deckNameById = new Map(deckRows.map((d) => [d.id, d.name]));

  const ragChunks: RagChunk[] = hits.map((h) => ({
    cardId: h.cardId,
    text: h.text,
    deckName: deckNameById.get(h.deckId),
  }));
  const citations: Citation[] = hits.map((h) => ({
    cardId: h.cardId,
    chunkId: h.chunkId,
    deckId: h.deckId,
    snippet: h.text.slice(0, SNIPPET_LEN),
  }));
  return { ragChunks, citations };
}

// ── `[src:]` / `[card:]` token intersect (Р5) ─────────────────────────────────
// Extracted from the inline intersect that used to live inside `runAgentTurn`
// (ai.ts): ONE implementation of "keep only the citations the model actually
// referenced by token" so the chat loop AND the studio artifact generator (N2)
// behave identically. Pure — NO fallback (the chat loop keeps its own
// "fall back to the capped union when nothing intersected" branch, so its
// observable behavior is unchanged; pinned by the notebook-chat tests).

/** Chunk ids referenced via `[src:<id>]` tokens in `text`. */
export function emittedSrcIds(text: string): Set<string> {
  const ids = new Set<string>();
  // A fresh RegExp per call — the shared literals carry the `g` flag (stateful
  // `lastIndex`); reusing the literal across calls would skip matches.
  for (const m of text.matchAll(new RegExp(SRC_TOKEN_RE))) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

/** Card ids referenced via `[card:<id>]` tokens in `text`. */
export function emittedCardIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(new RegExp(CARD_TOKEN_RE))) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

/**
 * Filter a union of citations down to the ones the model REFERENCED by token —
 * source citations against the `[src:]` tokens (by `sourceChunkId`), card
 * citations against the `[card:]` tokens (by `cardId`). Pure intersect: when the
 * model emitted no tokens of EITHER kind this returns `[]` (the caller owns the
 * fallback). Identical semantics to the former inline filter in `runAgentTurn`.
 */
export function intersectSourceTokens(text: string, citations: Citation[]): Citation[] {
  const srcIds = emittedSrcIds(text);
  const cardIds = emittedCardIds(text);
  if (srcIds.size === 0 && cardIds.size === 0) return [];
  return citations.filter((c) =>
    isSourceCitation(c) ? srcIds.has(c.sourceChunkId) : cardIds.has(c.cardId),
  );
}

/**
 * Post-process a generated artifact's markdown (Р5): keep `[src:<id>]` tokens
 * whose id was in the SAMPLED context (`allowed`), strip the rest (a model can
 * hallucinate or "cite" an un-sampled chunk — those must never survive into the
 * rendered text). Returns the cleaned text + the subset of context citations the
 * (now-valid) tokens reference, in token-appearance-free union order.
 */
export function applyArtifactCitations(
  text: string,
  context: SourceCitation[],
): { text: string; citations: SourceCitation[] } {
  const allowed = new Set(context.map((c) => c.sourceChunkId));
  // Strip invalid tokens (id not in the sampled context).
  const cleaned = text.replace(new RegExp(SRC_TOKEN_RE), (whole, id: string) =>
    allowed.has(id) ? whole : '',
  );
  // The citations the SURVIVING tokens reference (deduped by sourceChunkId).
  const referenced = emittedSrcIds(cleaned);
  const citations = context.filter((c) => referenced.has(c.sourceChunkId));
  return { text: cleaned, citations };
}
