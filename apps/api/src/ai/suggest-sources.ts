// Notebook source recommendations (Р11): given a notebook's attached sources,
// suggest other library sources that are semantically near the notebook's
// "centroid" — the average of a sample of its document vectors.
//
// Works from STORED vectors alone (no live embedder), like semantic-edges /
// concept-map. Two conceptual steps, ONE SQL statement:
//
//   centroid: AVG(embedding) over a sample of ≤ CENTROID_SAMPLE document vectors
//   of the ATTACHED sources (pgvector ships an `avg(vector)` aggregate). The
//   sample is bounded so a huge notebook doesn't average thousands of rows.
//
//   probe: an ANN top-k over DOCUMENT vectors NOT belonging to the attached
//   sources, JOINed to `sources` with `status='ready'` + `user_id` (so a
//   mid-ingest / foreign / non-ready source is never recommended). GROUP BY
//   source_id, MAX(score), top SUGGEST_LIMIT.
//
// EVERY probe conjunct that touches kb_chunk carries the document-guard trio
// (kc.user_id, kc.source_type='document') — the global HNSW index mixes card +
// document vectors; without the guard the centroid would drag in card vectors
// (§0 invariant). No attached vectors / nothing unattached ⇒ honest degrade.

import { sql } from 'drizzle-orm';
import { db } from '@reomi/db';

export interface SuggestedSource {
  sourceId: string;
  title: string;
  kind: string;
  /** Cosine similarity of the best chunk to the notebook centroid (1 = identical). */
  score: number;
}

export interface SuggestSourcesResult {
  items: SuggestedSource[];
  /** Set when the notebook has no document vectors to build a centroid from. */
  reason?: 'not_indexed';
}

/** Vectors averaged into the centroid (bounds the AVG over a huge notebook). */
const CENTROID_SAMPLE = 256;
/** Recommendations returned. */
const SUGGEST_LIMIT = 5;
/** Probe over-fetch before the GROUP BY collapse to distinct sources. */
const PROBE_FACTOR = 4;
/** Relevance floor — below this similarity nothing is suggested. */
const MIN_SCORE = 0.3;

/**
 * Recommend up to SUGGEST_LIMIT library sources near the notebook's centroid.
 *
 * @param attachedSourceIds  The notebook's ATTACHED sources (any status). Their
 *   document vectors form the centroid AND are excluded from the candidates.
 *   Empty ⇒ `not_indexed` (no centroid possible).
 */
export async function suggestSources(args: {
  userId: string;
  attachedSourceIds: string[];
}): Promise<SuggestSourcesResult> {
  const { userId, attachedSourceIds } = args;
  if (attachedSourceIds.length === 0) {
    return { items: [], reason: 'not_indexed' };
  }

  const attachedList = sql.join(
    attachedSourceIds.map((id) => sql`${id}`),
    sql`, `,
  );

  // ── Centroid: AVG over a bounded sample of the attached sources' doc vectors.
  // A separate query (not a CTE in the probe) so we can degrade to `not_indexed`
  // when the attached sources have NO embedded chunks yet (centroid IS NULL).
  const centroidRows = (await db.execute(sql`
    SELECT avg(c.embedding) AS centroid
    FROM (
      SELECT kc.embedding
      FROM kb_chunk kc
      WHERE kc.user_id = ${userId}
        AND kc.source_type = 'document'
        AND kc.source_id IN (${attachedList})
        AND kc.embedding IS NOT NULL
      LIMIT ${CENTROID_SAMPLE}
    ) c
  `)) as unknown as Array<{ centroid: string | null }>;

  const centroid = centroidRows[0]?.centroid ?? null;
  if (centroid == null) {
    return { items: [], reason: 'not_indexed' };
  }

  // ── Probe: ANN over UNATTACHED ready document vectors, ranked by the centroid.
  // The candidate set excludes attached sources and is gated to `status='ready'`
  // + the caller's own sources via the JOIN. user_id is the first conjunct, the
  // document-guard conjuncts keep card vectors out. GROUP BY collapses multi-chunk
  // hits per source to the best score.
  const rows = (await db.execute(sql`
    SELECT
      s.id    AS source_id,
      s.title AS title,
      s.kind  AS kind,
      MAX(1 - (kc.embedding <=> ${centroid}::vector)) AS score
    FROM kb_chunk kc
    JOIN sources s
      ON s.id = kc.source_id
     AND s.user_id = ${userId}
     AND s.status = 'ready'
    WHERE kc.user_id = ${userId}
      AND kc.source_type = 'document'
      AND kc.embedding IS NOT NULL
      AND kc.source_id NOT IN (${attachedList})
      AND (1 - (kc.embedding <=> ${centroid}::vector)) >= ${MIN_SCORE}
    GROUP BY s.id, s.title, s.kind
    ORDER BY score DESC
    LIMIT ${SUGGEST_LIMIT * PROBE_FACTOR}
  `)) as unknown as Array<{
    source_id: string;
    title: string;
    kind: string;
    score: number | string;
  }>;

  const items = rows.slice(0, SUGGEST_LIMIT).map((r) => ({
    sourceId: r.source_id,
    title: r.title,
    kind: r.kind,
    score: Number(r.score),
  }));

  return { items };
}
