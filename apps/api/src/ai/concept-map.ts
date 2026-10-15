// Notebook concept-map (Р10): a SECTIONAL semantic graph over a notebook's
// document chunks — NOT a copy of semantic-edges.ts (that aggregates by card_id).
//
// Two phases, because the `heading` (the section label) lives in `source_chunks`
// while the embedding lives in the document rows of `kb_chunk` (which have no
// heading):
//
//   Phase 1 — sections: GROUP source_chunks of the notebook's ready sources into
//   sections keyed by `COALESCE(heading, '#'||floor(position/10))` (a NULL-heading
//   document is bucketed every 10 chunks so structureless text never collapses to
//   one mega-node). Cap to CONCEPT_MAP_MAX_SECTIONS via an even round-robin sample
//   across sources (ordered by first_pos within each source) — the excess is
//   dropped so a huge book can't dominate the graph or blow up the probe.
//
//   Phase 2 — edges: a k-NN-join over the DOCUMENT kb_chunk vectors of the capped
//   sections. EVERY subquery carries the three document-guard conjuncts
//   (kc.user_id, kc.source_type='document', kc.source_id IN (...)) — the global
//   HNSW index mixes card + document vectors, so without these a section's probe
//   would pull card neighbours / other users' data (§0 invariant). Each probed
//   chunk maps back to its section via a JOIN on source_chunks by (source_id,
//   position). Undirected dedup over the composite section identity
//   (LEAST/GREATEST of source_id||section_key) + MAX(score); intra-section pairs
//   are dropped. Top-3 edges per node are trimmed in JS (simpler + safer than a
//   window function — all the heavy lifting is the SQL ANN join, JS only slices).
//
// PROBE-BUDGET DECISION (documented per the spec): the LATERAL ANN probe is seeded
// from only the FIRST ~PROBE_CHUNKS_PER_SECTION (5) chunks of each capped section
// (lowest position), not every chunk. A section's opening chunks are
// representative enough for a similarity graph, and this bounds the probe to
// ≤ sections × 5 source rows × (k*2) neighbours — well within the HNSW budget even
// at the 60-section cap. The sections cap itself is the primary bound.
//
// Works from STORED vectors alone (no live embedder), exactly like semantic-edges:
// no document vectors ⇒ { nodes: [], edges: [], reason: 'not_indexed' }.

import { sql } from 'drizzle-orm';
import { db } from '@reomi/db';

/** A section node: a (source, heading-or-position-bucket) cluster of chunks. */
export interface ConceptMapNode {
  /** Stable composite id: `${sourceId}::${sectionKey}`. */
  id: string;
  sourceId: string;
  sourceTitle: string;
  /** The section heading, or null for a position-bucketed (headingless) section.
   *  The client labels a null heading as «часть N» (N from firstPos). */
  label: string | null;
  /** Lowest chunk position in the section (the citation-viewer scroll anchor). */
  firstPos: number;
  /** source_chunks.id of the section's first chunk (the viewer jump target). */
  firstChunkId: string;
  chunkCount: number;
}

export interface ConceptMapEdge {
  /** Node ids of the undirected edge (a < b by composite id). */
  a: string;
  b: string;
  /** Cosine similarity of the closest cross-section chunk pair (1 = identical). */
  score: number;
}

export interface ConceptMapResult {
  nodes: ConceptMapNode[];
  edges: ConceptMapEdge[];
  /** Set when the notebook has no document vectors at all (honest degrade). */
  reason?: 'not_indexed';
}

/** Chunks-per-position-bucket for headingless sections (matches Р10). */
const POSITION_BUCKET = 10;
/** ANN neighbours probed per seed chunk (k); LATERAL over-fetches k*2. */
const NEIGHBORS = 3;
/** Seed chunks taken from the FRONT of each section to bound the probe. */
const PROBE_CHUNKS_PER_SECTION = 5;
/** Relevance floor — pairs below this similarity are not edges. */
const MIN_SCORE = 0.35;
/** Top edges retained per node (post-filtered in JS). */
const MAX_EDGES_PER_NODE = 3;
/** Hard ceiling on the sections cap regardless of env. */
const HARD_MAX_SECTIONS = 200;

interface SectionRow {
  source_id: string;
  section_key: string;
  first_pos: number | string;
  first_chunk_id: string;
  chunk_count: number | string;
  heading: string | null;
  source_title: string;
}

/**
 * Build the sectional concept-map for a notebook.
 *
 * @param sourceIds  The notebook's READY sources (resolved by the caller from the
 *                   notebook_sources join). Empty ⇒ `not_indexed`.
 * @param maxSections Cap on section-nodes (CONCEPT_MAP_MAX_SECTIONS), clamped to
 *                   [1, HARD_MAX_SECTIONS].
 */
export async function conceptMap(args: {
  userId: string;
  sourceIds: string[];
  maxSections: number;
}): Promise<ConceptMapResult> {
  const userId = args.userId;
  const maxSections = Math.max(
    1,
    Math.min(Math.floor(args.maxSections) || 1, HARD_MAX_SECTIONS),
  );
  const sourceIds = args.sourceIds;
  if (sourceIds.length === 0) {
    return { nodes: [], edges: [], reason: 'not_indexed' };
  }

  const idList = sql.join(
    sourceIds.map((id) => sql`${id}`),
    sql`, `,
  );

  // Cheap pre-gate: a section graph is meaningless without DOCUMENT vectors. A
  // source whose chunks exist but are still PARKED (embedded=false, no kb_chunk
  // row) is "not indexed" — degrade honestly rather than emit edgeless nodes.
  // Mirrors semantic-edges' not_indexed pre-count.
  const docCountRows = (await db.execute(sql`
    SELECT count(*) AS cnt
    FROM kb_chunk kc
    WHERE kc.user_id = ${userId}
      AND kc.source_type = 'document'
      AND kc.source_id IN (${idList})
      AND kc.embedding IS NOT NULL
  `)) as unknown as Array<{ cnt: number | string }>;
  if (Number(docCountRows[0]?.cnt ?? 0) === 0) {
    return { nodes: [], edges: [], reason: 'not_indexed' };
  }

  // The section_key expression, built for a given table alias. The bucket size is
  // inlined as a RAW integer literal (a trusted constant) — drizzle would emit a
  // separate bound param per `${POSITION_BUCKET}` interpolation, and Postgres
  // requires a SELECT expression to be STRUCTURALLY identical to its GROUP BY
  // counterpart (two `floor(pos / $1)` / `floor(pos / $2)` are NOT equal → "must
  // appear in GROUP BY"). Inlining keeps every occurrence textually identical.
  const bucket = sql.raw(String(POSITION_BUCKET));
  const sectionKey = (alias: string) => {
    const a = sql.raw(alias);
    return sql`COALESCE(${a}.heading, '#' || floor(${a}.position / ${bucket})::text)`;
  };

  // ── Phase 1: sections ──────────────────────────────────────────────────────
  // GROUP source_chunks of the ready sources into (source_id, section_key) rows.
  // section_key = heading, else a position bucket so headingless text splits.
  // Carry the first chunk's id (MIN position → the viewer anchor) + count + the
  // source title (for the node label). user_id is the first conjunct.
  const sectionRows = (await db.execute(sql`
    SELECT
      sub.source_id,
      sub.section_key,
      sub.first_pos,
      sub.heading,
      sc.id           AS first_chunk_id,
      sub.chunk_count,
      s.title         AS source_title
    FROM (
      SELECT
        scc.source_id,
        ${sectionKey('scc')} AS section_key,
        MIN(scc.position) AS first_pos,
        MIN(scc.heading)  AS heading,
        COUNT(*)          AS chunk_count
      FROM source_chunks scc
      WHERE scc.user_id = ${userId}
        AND scc.source_id IN (${idList})
      GROUP BY scc.source_id, ${sectionKey('scc')}
    ) sub
    JOIN source_chunks sc
      ON sc.source_id = sub.source_id AND sc.position = sub.first_pos
    JOIN sources s ON s.id = sub.source_id
    ORDER BY sub.source_id, sub.first_pos
  `)) as unknown as SectionRow[];

  if (sectionRows.length === 0) {
    return { nodes: [], edges: [], reason: 'not_indexed' };
  }

  // Even round-robin sample across sources (by first_pos within each source) so a
  // single huge book can't dominate the graph at the cap.
  const bySource = new Map<string, SectionRow[]>();
  for (const r of sectionRows) {
    const arr = bySource.get(r.source_id) ?? [];
    arr.push(r);
    bySource.set(r.source_id, arr);
  }
  const buckets = [...bySource.values()];
  const sampled: SectionRow[] = [];
  for (let round = 0; sampled.length < maxSections; round++) {
    let any = false;
    for (const arr of buckets) {
      if (round < arr.length) {
        sampled.push(arr[round]!);
        any = true;
        if (sampled.length >= maxSections) break;
      }
    }
    if (!any) break;
  }

  const nodes: ConceptMapNode[] = sampled.map((r) => ({
    id: `${r.source_id}::${r.section_key}`,
    sourceId: r.source_id,
    sourceTitle: r.source_title,
    label: r.heading ?? null,
    firstPos: Number(r.first_pos),
    firstChunkId: r.first_chunk_id,
    chunkCount: Number(r.chunk_count),
  }));

  // Map (sourceId, sectionKey) → composite node id for the JS post-filter, and
  // collect the set of capped source ids (the probe is still document-guarded to
  // the WHOLE notebook scope — a probed chunk outside the sampled sections simply
  // won't map to a node and is dropped).
  const sectionKeys = sampled.map((r) => ({
    source_id: r.source_id,
    section_key: r.section_key,
  }));

  // Build a VALUES list of the SAMPLED (source_id, section_key) pairs so the SQL
  // can (a) restrict seed chunks to the sampled sections and (b) map each probed
  // chunk back to a sampled section. One pair list, reused twice.
  const pairValues = sql.join(
    sectionKeys.map((p) => sql`(${p.source_id}::uuid, ${p.section_key})`),
    sql`, `,
  );

  // ── Phase 2: edges ─────────────────────────────────────────────────────────
  // `seeds`: the first PROBE_CHUNKS_PER_SECTION chunks of each sampled section
  //   (lowest position), carrying their embedding + their section identity. The
  //   section identity is computed the SAME way as Phase 1 and joined to the
  //   sampled-pair VALUES list so only sampled sections seed probes.
  // `probe`: for each seed, the top-(k*2) ANN neighbours over DOCUMENT vectors of
  //   the notebook scope (the three guard conjuncts are MANDATORY). Each neighbour
  //   maps back to ITS section via source_chunks (source_id, position) + the same
  //   sampled-pair join — a neighbour outside the sampled sections is dropped.
  // Undirected dedup over the composite section id (LEAST/GREATEST), MAX(score),
  // intra-section pairs dropped.
  // Composite section_id = `${source_id}::${section_key}` for an alias. Same raw
  // bucket inlining as `sectionKey` — keeps the seed/probe section ids identical to
  // the node ids built in JS.
  const sectionId = (alias: string) => {
    const a = sql.raw(alias);
    return sql`(${a}.source_id::text || '::' || ${sectionKey(alias)})`;
  };

  const edgeRows = (await db.execute(sql`
    WITH sampled(source_id, section_key) AS (
      VALUES ${pairValues}
    ),
    seeds AS (
      SELECT
        kc.embedding,
        seed.section_id
      FROM (
        SELECT
          scc.source_id,
          scc.position,
          ${sectionId('scc')} AS section_id,
          ${sectionKey('scc')} AS section_key,
          ROW_NUMBER() OVER (
            PARTITION BY scc.source_id, ${sectionKey('scc')}
            ORDER BY scc.position
          ) AS rn
        FROM source_chunks scc
        JOIN sampled sp
          ON sp.source_id = scc.source_id
         AND sp.section_key = ${sectionKey('scc')}
        WHERE scc.user_id = ${userId}
          AND scc.source_id IN (${idList})
      ) seed
      JOIN kb_chunk kc
        ON kc.user_id = ${userId}
       AND kc.source_type = 'document'
       AND kc.source_id = seed.source_id
       AND kc.position = seed.position
      WHERE seed.rn <= ${PROBE_CHUNKS_PER_SECTION}
        AND kc.embedding IS NOT NULL
    ),
    pairs AS (
      SELECT
        seeds.section_id AS section_a,
        nbr.section_id   AS section_b,
        nbr.score
      FROM seeds
      CROSS JOIN LATERAL (
        SELECT
          ${sectionId('nsc')} AS section_id,
          1 - (kc2.embedding <=> seeds.embedding) AS score
        FROM kb_chunk kc2
        JOIN source_chunks nsc
          ON nsc.source_id = kc2.source_id AND nsc.position = kc2.position
        JOIN sampled sp2
          ON sp2.source_id = nsc.source_id
         AND sp2.section_key = ${sectionKey('nsc')}
        WHERE kc2.user_id = ${userId}
          AND kc2.source_type = 'document'
          AND kc2.source_id IN (${idList})
          AND kc2.embedding IS NOT NULL
        ORDER BY kc2.embedding <=> seeds.embedding
        LIMIT ${NEIGHBORS * 2}
      ) nbr
      WHERE nbr.score >= ${MIN_SCORE}
        AND nbr.section_id <> seeds.section_id
    )
    SELECT
      LEAST(p.section_a, p.section_b)    AS a,
      GREATEST(p.section_a, p.section_b) AS b,
      MAX(p.score)                       AS score
    FROM pairs p
    GROUP BY 1, 2
    ORDER BY 3 DESC
  `)) as unknown as Array<{ a: string; b: string; score: number | string }>;

  // Top-MAX_EDGES_PER_NODE per node, applied in JS over the score-desc rows. An
  // edge is kept only if BOTH endpoints still have budget — guarantees a symmetric
  // degree cap without a window function.
  const degree = new Map<string, number>();
  const edges: ConceptMapEdge[] = [];
  for (const r of edgeRows) {
    const da = degree.get(r.a) ?? 0;
    const db_ = degree.get(r.b) ?? 0;
    if (da >= MAX_EDGES_PER_NODE || db_ >= MAX_EDGES_PER_NODE) continue;
    degree.set(r.a, da + 1);
    degree.set(r.b, db_ + 1);
    edges.push({ a: r.a, b: r.b, score: Number(r.score) });
  }

  return { nodes, edges };
}
