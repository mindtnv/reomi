// Whole-graph semantic edges: for each of the user's embedded cards, its top-k
// nearest neighbours by cosine similarity over the STORED kb_chunk vectors —
// one k-NN-join SQL statement, no embedding API calls at runtime.
//
// Shape: a CTE of source chunks (user-scoped, suspended excluded, capped at
// `maxNodes` newest-first — deliberately the same ordering as the client's
// first /cards page, so edges mostly land on mirrored nodes) CROSS JOIN LATERAL
// a per-row ANN probe (`ORDER BY embedding <=> src.embedding LIMIT n`). The
// LATERAL subquery is kept MINIMAL (kb_chunk only, three predicates) so the
// planner can use the HNSW index; on small corpora it will pick a seq scan
// inside the LATERAL instead, which is just the exact-scan fallback — same
// results, fine at that size. The `maxNodes` cap bounds the worst case.
//
// The suspended filter for the TARGET side runs OUTSIDE the lateral (a JOIN
// inside scares the planner away from the index); `LIMIT k*2` over-fetches to
// compensate for neighbours dropped by that outer filter.
//
// Undirected dedup: `GROUP BY LEAST(a,b), GREATEST(a,b)` + `MAX(score)`
// collapses the A→B / B→A probes (and multi-chunk pairs) into one edge.
//
// CRITICAL: the HNSW index is GLOBAL — `kc.user_id = $userId` is the sole
// cross-tenant boundary and is present in BOTH the CTE and the lateral probe.
//
// EXPLAIN ANALYZE (dev, 113 embedded cards, 2026-06): the planner picks a
// top-N-heapsort seq scan inside the LATERAL (the exact-scan fallback) —
// ~66 ms end-to-end. If a much larger corpus ever degrades this, the knobs are
// `SET LOCAL hnsw.ef_search = 100` / `SET LOCAL hnsw.iterative_scan =
// 'relaxed_order'` inside a transaction around this query (pgvector ≥ 0.8).

import { sql } from 'drizzle-orm';
import { db } from '@reomi/db';

export interface SemanticEdge {
  /** Card ids of the undirected edge, a < b (uuid order). */
  a: string;
  b: string;
  /** Cosine similarity of the closest chunk pair (1 = identical). */
  score: number;
}

export interface SemanticEdgesResult {
  edges: SemanticEdge[];
  /** How many embedded source cards were considered. */
  nodes: number;
  /** Set when the user has no embedded chunks at all (honest degrade). */
  reason?: 'not_indexed';
}

const DEFAULT_NEIGHBORS = 3;
const MAX_NEIGHBORS = 10;
const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_MAX_NODES = 1000;
const HARD_MAX_NODES = 2000;
const DEFAULT_MAX_EDGES = 500;
const HARD_MAX_EDGES = 1000;

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return def;
  return Math.max(min, Math.min(Math.floor(v), max));
}

export async function semanticEdges(args: {
  userId: string;
  k?: number;
  minScore?: number;
  maxNodes?: number;
  maxEdges?: number;
}): Promise<SemanticEdgesResult> {
  const userId = args.userId;
  const k = clampInt(args.k, DEFAULT_NEIGHBORS, 1, MAX_NEIGHBORS);
  const minScore =
    args.minScore !== undefined && Number.isFinite(args.minScore)
      ? Math.max(0, Math.min(args.minScore, 1))
      : DEFAULT_MIN_SCORE;
  const maxNodes = clampInt(args.maxNodes, DEFAULT_MAX_NODES, 1, HARD_MAX_NODES);
  const maxEdges = clampInt(args.maxEdges, DEFAULT_MAX_EDGES, 1, HARD_MAX_EDGES);

  // Cheap pre-count: how many embedded, non-suspended cards exist. Doubles as
  // the `nodes` stat and the `not_indexed` degrade signal.
  const countRows = (await db.execute(sql`
    SELECT count(DISTINCT kc.card_id) AS cnt
    FROM kb_chunk kc
    JOIN cards c ON c.id = kc.card_id
    WHERE kc.user_id = ${userId}
      AND kc.embedding IS NOT NULL
      AND kc.source_type = 'card'
      AND c.suspended = false
  `)) as unknown as Array<{ cnt: number | string }>;
  const nodes = Math.min(Number(countRows[0]?.cnt ?? 0), maxNodes);
  if (nodes === 0) {
    return { edges: [], nodes: 0, reason: 'not_indexed' };
  }

  const rows = (await db.execute(sql`
    WITH src AS (
      SELECT kc.id, kc.card_id, kc.embedding
      FROM kb_chunk kc
      JOIN cards c ON c.id = kc.card_id
      WHERE kc.user_id = ${userId}
        AND kc.embedding IS NOT NULL
        AND kc.source_type = 'card'
        AND c.suspended = false
      ORDER BY c.created_at DESC
      LIMIT ${maxNodes}
    ),
    pairs AS (
      SELECT src.card_id AS card_a, nn.card_id AS card_b, nn.score
      FROM src
      CROSS JOIN LATERAL (
        SELECT kc2.card_id, 1 - (kc2.embedding <=> src.embedding) AS score
        FROM kb_chunk kc2
        WHERE kc2.user_id = ${userId}
          AND kc2.embedding IS NOT NULL
          -- CARD-graph guard: this probe does NOT join cards, so a document
          -- chunk (card_id NULL, NotebookLM source) would otherwise consume a
          -- slot in the LIMIT k*2 ANN window, yielding fewer than k card
          -- neighbours after the outer card join. Exclude document vectors here.
          AND kc2.source_type = 'card'
          AND kc2.card_id <> src.card_id
        ORDER BY kc2.embedding <=> src.embedding
        LIMIT ${k * 2}
      ) nn
      WHERE nn.score >= ${minScore}
    )
    SELECT
      LEAST(p.card_a, p.card_b)    AS a,
      GREATEST(p.card_a, p.card_b) AS b,
      MAX(p.score)                 AS score
    FROM pairs p
    JOIN cards cb ON cb.id = p.card_b
    WHERE cb.suspended = false
    GROUP BY 1, 2
    ORDER BY 3 DESC
    LIMIT ${maxEdges}
  `)) as unknown as Array<{ a: string; b: string; score: number | string }>;

  return {
    nodes,
    edges: rows.map((r) => ({ a: r.a, b: r.b, score: Number(r.score) })),
  };
}
