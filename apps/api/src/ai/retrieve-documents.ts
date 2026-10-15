// Vector retrieval over DOCUMENT chunks of a notebook (NotebookLM M2).
//
// `retrieveDocuments()` is the document analog of `retrieve()` (retrieve.ts,
// card-only): a pgvector cosine top-k against the GLOBAL HNSW index, scoped to
// `source_type='document'` AND a caller-supplied `sourceIds` whitelist (the
// per-turn source scope of the notebook chat). Each hit joins back to its
// `source_chunks` row (the SoT — carrying the canonical chunk id, page, heading)
// and its `sources` row (the title) so the grounded answer can cite
// `[src:<sourceChunkId>]` and the web reader can scroll to the right passage.
//
// CRITICAL (mirror of retrieve.ts): the HNSW index is GLOBAL across all users +
// all source types. `kc.user_id = $userId` is the SOLE cross-tenant boundary, so
// `userId` is REQUIRED and always the FIRST conjunct. `kc.source_type='document'`
// + `kc.source_id IN (...)` keep card vectors and other notebooks' sources out
// of this top-k. `sourceIds.length === 0` ⇒ return [] WITHOUT touching the DB
// (an empty scope can match nothing — the notebook has no checked-in sources).

import { sql } from 'drizzle-orm';
import { db } from '@reomi/db';

/** One ranked document chunk, carrying its source-chunk provenance. */
export interface RankedDocumentChunk {
  /** kb_chunk.id (the embedded row). */
  chunkId: string;
  /** source_chunks.id — the canonical chunk id cited as [src:<sourceChunkId>]. */
  sourceChunkId: string;
  sourceId: string;
  /** 0-based chunk position within the source (the reader's scroll anchor). */
  position: number;
  /** 1-based source page (PDF), when known. */
  page?: number;
  /** Source heading (EPUB chapter / section), when known. */
  heading?: string;
  sourceTitle: string;
  text: string;
  score: number;
}

export interface RetrieveDocumentsArgs {
  /** REQUIRED — the sole cross-tenant boundary (the HNSW index is global). */
  userId: string;
  /** The query embedding (same dimension as the kb_chunk.embedding column). */
  queryEmbedding: number[];
  /** Top-k cap (default 10). */
  k?: number;
  /** Minimum cosine SIMILARITY (`1 - distance`) — dropped IN SQL before LIMIT. */
  minScore?: number;
  /**
   * The notebook's per-turn source scope: only chunks of these sources are
   * candidates. REQUIRED non-empty — `[]` ⇒ `[]` (no DB query).
   */
  sourceIds: string[];
}

/** Render a JS number[] into a pgvector literal: `[1,2,3]`. */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/**
 * Cosine top-k retrieval over the document chunks of the given sources,
 * user-scoped. Returns the best `k` chunks (lower `<=>` distance → higher
 * score), joined to their source_chunks SoT row (page/heading + canonical id)
 * and the source title.
 *
 * The `WHERE kc.user_id = $userId` predicate is ALWAYS emitted FIRST — it is the
 * only thing preventing cross-tenant leakage from the global HNSW index. The
 * `source_type='document'` + `source_id IN (...)` conjuncts keep card vectors
 * and other notebooks' sources out of this top-k.
 */
export async function retrieveDocuments(
  args: RetrieveDocumentsArgs,
): Promise<RankedDocumentChunk[]> {
  const { userId, queryEmbedding, k = 10, minScore, sourceIds } = args;
  if (queryEmbedding.length === 0) return [];
  // Empty scope ⇒ nothing to retrieve. Skip the query entirely (an empty
  // `IN ()` would be a SQL error anyway).
  if (sourceIds.length === 0) return [];

  const vecLiteral = toVectorLiteral(queryEmbedding);

  // Build the WHERE conjuncts. The user predicate is MANDATORY and first.
  const conds = [
    sql`kc.user_id = ${userId}`,
    // Only embedded chunks are candidates.
    sql`kc.embedding IS NOT NULL`,
    // Document chunks only (the card vectors share the global index).
    sql`kc.source_type = 'document'`,
  ];
  // Source scope: `IN (...)` of scalar binds (drizzle's `sql` template spreads a
  // JS array into individual bound params, so build an explicit list).
  const list = sql.join(
    sourceIds.map((id) => sql`${id}`),
    sql`, `,
  );
  conds.push(sql`kc.source_id IN (${list})`);
  // Relevance gate: drop chunks below the similarity floor BEFORE the LIMIT, so a
  // weakly-related query returns fewer (or zero) chunks rather than always k.
  // `<=>` is cosine distance; score = 1 - distance, so `distance <= 1 - minScore`.
  if (minScore !== undefined && minScore > -1) {
    conds.push(sql`(kc.embedding <=> ${vecLiteral}::vector) <= ${1 - minScore}`);
  }
  const where = sql.join(conds, sql` AND `);

  // `<=>` is cosine DISTANCE (0 = identical). score = 1 - distance so higher is
  // better and the natural ASC distance order maps to DESC score. The SoT join
  // on (source_id, position) carries the canonical source_chunks id + page +
  // heading; the sources join carries the title.
  const rows = (await db.execute(sql`
    SELECT
      kc.id          AS chunk_id,
      sc.id          AS source_chunk_id,
      kc.source_id   AS source_id,
      kc.position    AS position,
      sc.page        AS page,
      sc.heading     AS heading,
      s.title        AS source_title,
      sc.text        AS text,
      (kc.embedding <=> ${vecLiteral}::vector) AS distance
    FROM kb_chunk kc
    JOIN source_chunks sc ON sc.source_id = kc.source_id AND sc.position = kc.position
    JOIN sources s ON s.id = kc.source_id
    WHERE ${where}
    ORDER BY kc.embedding <=> ${vecLiteral}::vector
    LIMIT ${k}
  `)) as unknown as Array<{
    chunk_id: string;
    source_chunk_id: string;
    source_id: string;
    position: number;
    page: number | null;
    heading: string | null;
    source_title: string;
    text: string;
    distance: number;
  }>;

  return rows.map((r) => ({
    chunkId: r.chunk_id,
    sourceChunkId: r.source_chunk_id,
    sourceId: r.source_id,
    position: Number(r.position),
    page: r.page == null ? undefined : Number(r.page),
    heading: r.heading == null ? undefined : r.heading,
    sourceTitle: r.source_title,
    text: r.text,
    score: 1 - Number(r.distance),
  }));
}
