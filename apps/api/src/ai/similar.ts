// "Similar cards" lookup — semantic neighbours of ONE card, computed from the
// card's ALREADY-STORED kb_chunk embedding(s). No embedding API call happens at
// runtime: the stored vector IS the query vector, so this works even when
// `embeddingEnabled` is false (no OPENAI_API_KEY) as long as the index data
// exists. A card with no embedded chunk degrades to `reason: 'not_indexed'`.
//
// The heavy lifting is `retrieve()` (retrieve.ts) — it already enforces the
// mandatory `kb_chunk.user_id = $userId` first conjunct (the SOLE cross-tenant
// boundary on the global HNSW index), `embedding IS NOT NULL`, and the
// suspended-card exclusion.

import { and, eq, isNotNull } from 'drizzle-orm';
import { db, kbChunk } from '@reomi/db';
import { retrieve } from './retrieve.ts';

export interface SimilarCardItem {
  cardId: string;
  deckId: string;
  /** Cosine similarity of the closest chunk pair (1 = identical). */
  score: number;
  /** Short render_text excerpt for list rendering (plain text, ≤240 chars). */
  snippet: string;
}

export interface SimilarCardsResult {
  items: SimilarCardItem[];
  /** Set when the SOURCE card has no embedded chunk (honest degrade, not an error). */
  reason?: 'not_indexed';
}

const DEFAULT_K = 6;
const MAX_K = 20;
const DEFAULT_MIN_SCORE = 0.3;
const SNIPPET_CHARS = 240;
/** How many source chunks of the card to query with (today the indexer writes 1). */
const MAX_SOURCE_CHUNKS = 4;

export function clampSimilarK(k: number | undefined): number {
  if (k === undefined || !Number.isFinite(k)) return DEFAULT_K;
  return Math.max(1, Math.min(Math.floor(k), MAX_K));
}

export function clampMinScore(s: number | undefined, fallback = DEFAULT_MIN_SCORE): number {
  if (s === undefined || !Number.isFinite(s)) return fallback;
  return Math.max(0, Math.min(s, 1));
}

function toSnippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= SNIPPET_CHARS ? flat : `${flat.slice(0, SNIPPET_CHARS - 1)}…`;
}

/**
 * Top-k semantically similar cards for `cardId`, both sides scoped to `userId`.
 * Multi-chunk cards are aggregated by MAX score per neighbour card (the closest
 * fragment wins) and the source card itself is excluded. The caller is expected
 * to have verified card ownership already (the route 404s a foreign id before
 * calling this).
 */
export async function similarCards(args: {
  userId: string;
  cardId: string;
  k?: number;
  minScore?: number;
}): Promise<SimilarCardsResult> {
  const k = clampSimilarK(args.k);
  const minScore = clampMinScore(args.minScore);

  // The stored vectors of the source card — user-scoped AND card-scoped.
  const sourceChunks = await db
    .select({ embedding: kbChunk.embedding })
    .from(kbChunk)
    .where(
      and(
        eq(kbChunk.userId, args.userId),
        eq(kbChunk.cardId, args.cardId),
        isNotNull(kbChunk.embedding),
      ),
    )
    .orderBy(kbChunk.position)
    .limit(MAX_SOURCE_CHUNKS);

  if (sourceChunks.length === 0) {
    return { items: [], reason: 'not_indexed' };
  }

  // Over-fetch per chunk: the source card's own chunk(s) occupy the top slots
  // (distance ≈ 0) and multi-chunk neighbours can repeat across queries.
  const fetchK = k * 2 + 4;
  const best = new Map<string, SimilarCardItem>();
  for (const chunk of sourceChunks) {
    const hits = await retrieve({
      userId: args.userId,
      queryEmbedding: chunk.embedding!,
      k: fetchK,
      minScore,
    });
    for (const hit of hits) {
      if (hit.cardId === args.cardId) continue;
      const prev = best.get(hit.cardId);
      if (!prev || hit.score > prev.score) {
        best.set(hit.cardId, {
          cardId: hit.cardId,
          deckId: hit.deckId,
          score: hit.score,
          snippet: toSnippet(hit.text),
        });
      }
    }
  }

  const items = [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
  return { items };
}
