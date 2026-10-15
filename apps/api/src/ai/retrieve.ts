// Vector retrieval over kb_chunk (Slice 4, plan §187-208).
//
// `retrieve()` runs a pgvector cosine top-k (`<=>`) against the GLOBAL HNSW
// index and joins each hit back to its card provenance (cardId, deckId, a
// render_text snippet). No reranker — the ANN ordering is the result order.
//
// CRITICAL (SHOULD-FIX #11): the HNSW index is GLOBAL across all users. The
// `WHERE kb_chunk.user_id = $userId` predicate is the SOLE cross-tenant
// boundary, so `userId` is REQUIRED (not optional) and the predicate is ALWAYS
// present in the generated SQL. Optional deck/tag filters are applied as
// additional pre-filter predicates alongside the `<=>` ordering.

import { sql } from 'drizzle-orm';
import { db } from '@reomi/db';

export interface RankedChunk {
  chunkId: string;
  cardId: string;
  deckId: string;
  text: string;
  score: number;
}

export interface RetrieveArgs {
  /** REQUIRED — the sole cross-tenant boundary (the HNSW index is global). */
  userId: string;
  /** The query embedding (same dimension as the kb_chunk.embedding column). */
  queryEmbedding: number[];
  /** Top-k cap (default 10). */
  k?: number;
  /**
   * Minimum cosine SIMILARITY (`score = 1 - distance`) a chunk must clear to be
   * returned. Chunks below it are dropped IN SQL (before LIMIT), so an off-topic
   * query (e.g. a greeting) whose nearest chunks are only weakly related returns
   * `[]` instead of k irrelevant cards. Omit/`<= -1` to disable. Empirically,
   * unrelated text scores ≲0.27 and genuinely-relevant cards ≳0.35 for
   * text-embedding-3-small, so a default around 0.32 separates them.
   */
  minScore?: number;
  /** Optional deck pre-filter: restrict to chunks whose card lives in one of these decks. */
  deckIds?: string[];
  /** Optional tag pre-filter: restrict to chunks whose note carries ANY of these tags. */
  tags?: string[];
}

/** Render a JS number[] into a pgvector literal: `[1,2,3]`. */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/**
 * Cosine top-k retrieval, user-scoped. Returns the best `k` chunks for the
 * user (lower `<=>` distance → higher score), joined to card provenance.
 *
 * The `WHERE user_id = $userId` predicate is ALWAYS emitted — it is the only
 * thing preventing cross-tenant leakage from the global HNSW index.
 *
 * Suspended cards are excluded (a suspended card is out of study scope). Cards
 * deleted after indexing can't leak because the chunk cascades on card delete,
 * but the INNER JOIN to `cards` also guarantees a live card row.
 */
export async function retrieve(args: RetrieveArgs): Promise<RankedChunk[]> {
  const { userId, queryEmbedding, k = 10, minScore, deckIds, tags } = args;
  if (queryEmbedding.length === 0) return [];

  const vecLiteral = toVectorLiteral(queryEmbedding);

  // Build the WHERE conjuncts. The user predicate is MANDATORY and first.
  const conds = [
    sql`kc.user_id = ${userId}`,
    // Only embedded chunks are candidates.
    sql`kc.embedding IS NOT NULL`,
    // CARD-graph guard (mixed-corpus): kb_chunk now also holds 'document' chunks
    // (NotebookLM sources). This is a kc-only predicate applied BEFORE the LIMIT
    // so document vectors never consume the card top-k window (the INNER JOIN to
    // cards already drops them, but as a planner pre-filter this prevents
    // under-selection of < k card chunks on a mixed corpus). NOT a JS post-filter.
    sql`kc.source_type = 'card'`,
    // Exclude suspended cards from retrieval (out of study scope).
    sql`c.suspended = false`,
  ];
  // Relevance gate: drop chunks below the similarity floor BEFORE the LIMIT, so a
  // weakly-related query returns fewer (or zero) chunks rather than always k.
  // `<=>` is cosine distance; score = 1 - distance, so `distance <= 1 - minScore`.
  if (minScore !== undefined && minScore > -1) {
    conds.push(sql`(kc.embedding <=> ${vecLiteral}::vector) <= ${1 - minScore}`);
  }
  if (deckIds && deckIds.length > 0) {
    // drizzle's `sql` template spreads a JS array into individual bound params,
    // so build an explicit `IN (...)` list of scalar binds.
    const list = sql.join(
      deckIds.map((id) => sql`${id}`),
      sql`, `,
    );
    conds.push(sql`c.deck_id IN (${list})`);
  }
  if (tags && tags.length > 0) {
    // Tags live on the note (Anki-correct). `&&` = array overlap: match if the
    // note carries ANY of the requested tags. Build an ARRAY[...] literal of
    // scalar binds (cast to text[]) for the overlap operator.
    const list = sql.join(
      tags.map((tg) => sql`${tg}`),
      sql`, `,
    );
    conds.push(sql`n.tags && ARRAY[${list}]::text[]`);
  }
  const where = sql.join(conds, sql` AND `);

  // `<=>` is cosine DISTANCE (0 = identical). score = 1 - distance so higher is
  // better and the natural ASC distance order maps to DESC score.
  const rows = (await db.execute(sql`
    SELECT
      kc.id        AS chunk_id,
      kc.card_id   AS card_id,
      c.deck_id    AS deck_id,
      c.render_text AS render_text,
      (kc.embedding <=> ${vecLiteral}::vector) AS distance
    FROM kb_chunk kc
    JOIN cards c ON c.id = kc.card_id
    JOIN notes n ON n.id = c.note_id
    WHERE ${where}
    ORDER BY kc.embedding <=> ${vecLiteral}::vector
    LIMIT ${k}
  `)) as unknown as Array<{
    chunk_id: string;
    card_id: string;
    deck_id: string;
    render_text: string;
    distance: number;
  }>;

  return rows.map((r) => ({
    chunkId: r.chunk_id,
    cardId: r.card_id,
    deckId: r.deck_id,
    text: r.render_text,
    score: 1 - Number(r.distance),
  }));
}
