// «Блокноты 2.0» N4 — notebook concept-map (Р10). Vectors-only sectional graph.
//
// CONTRACT (read from ai/concept-map.ts + modules/notebooks.ts GET
// /notebooks/:id/concept-map):
//   * Phase 1 — sections: source_chunks of the notebook's READY sources GROUP into
//     (source_id, section_key) nodes; section_key = heading, else a 10-chunk
//     position bucket (`#0`, `#1`, …) so headingless text never collapses to one
//     node. Each node carries firstPos/firstChunkId (MIN position), chunkCount,
//     label (heading | null), a stable composite id `${sourceId}::${sectionKey}`.
//   * Phase 2 — edges: a document-guarded k-NN-join over the STORED document
//     vectors; cross-section pairs with cosine ≥ 0.35 become undirected edges
//     (MAX score, intra-section pairs dropped, top-3 per node).
//   * DOCUMENT-GUARD: a CARD chunk of the same user must NEVER appear as a node or
//     pull an edge (count-preservation, not a visibility assertion).
//   * Degrade: a source with no document vectors / no ready sources → not_indexed.
//   * Section cap: an even round-robin sample across sources caps node count
//     (verified by a direct call to `conceptMap` with a small maxSections).
//   * foreign notebook → 404, zero foreign-data leak.
//
// Document vectors are seeded DIRECTLY (mirrors notebook-chat.test.ts): the
// deterministic `vectorFor(text)` makes equal text → equal vector (cosine 1.0),
// and `nearVec` nudges a few slots so a cross-section pair stays ≈0.9 similar.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  db,
  kbChunk,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  sourceChunks as sourceChunksTable,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { conceptMap } from '../src/ai/concept-map.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const EMBED_DIM = 1536;

// Same hash-scatter as the other RAG tests: equal text → equal vector (cosine 1.0).
function vectorFor(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  for (let i = 0; i < 8; i++) {
    const idx = (h + i * 131) % EMBED_DIM;
    v[idx] = ((h >>> (i * 3)) % 100) / 100 + 0.01;
  }
  return v;
}
// A vector NEAR `base` but not identical — cosine to base stays high (≈0.9+).
function nearVec(base: number[], seed: number, eps = 0.02): number[] {
  const v = base.slice();
  for (let i = 0; i < 3; i++) {
    const idx = (seed * 977 + i * 263) % v.length;
    v[idx] = (v[idx] ?? 0) + eps;
  }
  return v;
}

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

interface ChunkSpec {
  text: string;
  heading?: string;
  /** Vector to embed; defaults to vectorFor(text). */
  vec?: number[];
}

/**
 * Seed a READY source attached to the notebook with the given chunks. Inserts
 * source + notebook_sources edge + source_chunks + kb_chunk DOCUMENT rows (vector
 * = spec.vec ?? vectorFor(text)). Returns the source id + source_chunk ids (in
 * position order).
 */
async function seedSource(
  userId: string,
  notebookId: string,
  title: string,
  chunks: ChunkSpec[],
  status: 'ready' | 'indexing' = 'ready',
): Promise<{ sourceId: string; chunkIds: string[] }> {
  const [src] = await db
    .insert(sourcesTable)
    .values({ userId, kind: 'pdf', title, status, verified: true, chunkCount: chunks.length })
    .returning({ id: sourcesTable.id });
  const sourceId = src!.id;
  await db.insert(notebookSourcesTable).values({ userId, notebookId, sourceId });
  const chunkIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const [sc] = await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId, position: i, text: c.text, heading: c.heading, embedded: true })
      .returning({ id: sourceChunksTable.id });
    chunkIds.push(sc!.id);
    await db.insert(kbChunk).values({
      userId,
      sourceType: 'document',
      sourceId,
      parentId: sourceId,
      position: i,
      text: c.text,
      embedding: c.vec ?? vectorFor(c.text),
      embeddingModel: 'test-fixture',
      sourceHash: `fixture-${sourceId}-${i}`,
      cardId: null,
    });
  }
  return { sourceId, chunkIds };
}

/**
 * Seed a REAL card (via the API so the FK to `cards` holds) + a CARD-type kb_chunk
 * for it (the document-guard probe). Returns the card id.
 */
async function seedCardChunk(cookie: string, userId: string, vec: number[]): Promise<string> {
  const deckRes = await callApp(app, 'POST', '/decks', { cookie, body: { name: 'D' } });
  const deckId = (await deckRes.json<{ id: string }>()).id;
  const card = await seedBasicCard(app, cookie, { deckId, front: 'card front', back: 'card back' });
  await db.insert(kbChunk).values({
    userId,
    sourceType: 'card',
    sourceId: card.id,
    parentId: card.id,
    position: 0,
    text: 'card text',
    embedding: vec,
    embeddingModel: 'test-fixture',
    sourceHash: `card-${card.id}`,
    cardId: card.id,
  });
  return card.id;
}

interface MapResp {
  nodes: {
    id: string;
    sourceId: string;
    sourceTitle: string;
    label: string | null;
    firstPos: number;
    firstChunkId: string;
    chunkCount: number;
  }[];
  edges: { a: string; b: string; score: number }[];
  reason?: string;
}

async function getMap(cookie: string, nb: string): Promise<{ status: number; body: MapResp }> {
  const res = await callApp(app, 'GET', `/notebooks/${nb}/concept-map`, { cookie });
  return { status: res.status, body: await res.json<MapResp>() };
}

describe('concept-map — sectional aggregation', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('2 sources × 2 headings → 4 nodes; cross-section edges exist (score 0..1)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);

    // Shared "topic" vectors so cross-source sections connect.
    const topicAlpha = vectorFor('topic-alpha');
    const topicBeta = vectorFor('topic-beta');

    // Source 1: heading "Intro" (alpha), heading "Methods" (beta).
    await seedSource(userId, nb, 'Book One', [
      { text: 's1-intro', heading: 'Intro', vec: topicAlpha },
      { text: 's1-methods', heading: 'Methods', vec: topicBeta },
    ]);
    // Source 2: heading "Overview" (near alpha), heading "Approach" (near beta).
    await seedSource(userId, nb, 'Book Two', [
      { text: 's2-overview', heading: 'Overview', vec: nearVec(topicAlpha, 1) },
      { text: 's2-approach', heading: 'Approach', vec: nearVec(topicBeta, 2) },
    ]);

    const { status, body } = await getMap(cookie, nb);
    expect(status).toBe(200);
    expect(body.reason).toBeUndefined();
    // 4 sections (2 sources × 2 distinct headings).
    expect(body.nodes).toHaveLength(4);
    const labels = body.nodes.map((n) => n.label).sort();
    expect(labels).toEqual(['Approach', 'Intro', 'Methods', 'Overview']);
    // Each node carries its anchor + chunk count.
    for (const n of body.nodes) {
      expect(n.chunkCount).toBe(1);
      expect(n.firstChunkId).toBeTruthy();
      expect(n.id).toBe(`${n.sourceId}::${n.label}`);
    }
    // Cross-source edges: Intro↔Overview (alpha) and Methods↔Approach (beta).
    expect(body.edges.length).toBeGreaterThanOrEqual(2);
    for (const e of body.edges) {
      expect(e.score).toBeGreaterThan(0);
      expect(e.score).toBeLessThanOrEqual(1);
      expect(e.a < e.b).toBe(true); // undirected, a<b
    }
    // No intra-section edges (every node is its own section here, but assert the
    // alpha pair connects the two sources, not a node to itself).
    const idByLabel = new Map(body.nodes.map((n) => [n.label, n.id]));
    const intro = idByLabel.get('Intro')!;
    const overview = idByLabel.get('Overview')!;
    const hasAlphaEdge = body.edges.some(
      (e) => (e.a === intro && e.b === overview) || (e.a === overview && e.b === intro),
    );
    expect(hasAlphaEdge).toBe(true);
  });

  test('NULL-heading chunks bucket by position (#0/#1 when >10 chunks)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);

    // 15 headingless chunks → bucket #0 (pos 0-9) + #1 (pos 10-14).
    const chunks: ChunkSpec[] = [];
    for (let i = 0; i < 15; i++) chunks.push({ text: `plain-${i}`, vec: vectorFor(`plain-${i}`) });
    await seedSource(userId, nb, 'Plain Doc', chunks);

    const { status, body } = await getMap(cookie, nb);
    expect(status).toBe(200);
    // Exactly 2 nodes: the two position buckets.
    expect(body.nodes).toHaveLength(2);
    for (const n of body.nodes) expect(n.label).toBeNull(); // headingless
    const sourceId = body.nodes[0]!.sourceId;
    const ids = body.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([`${sourceId}::#0`, `${sourceId}::#1`].sort());
    // Bucket #0 has 10 chunks, #1 has 5.
    const counts = body.nodes.map((n) => n.chunkCount).sort((a, b) => a - b);
    expect(counts).toEqual([5, 10]);
    // firstPos: bucket #0 starts at 0, #1 at 10.
    const byId = new Map(body.nodes.map((n) => [n.id, n]));
    expect(byId.get(`${sourceId}::#0`)!.firstPos).toBe(0);
    expect(byId.get(`${sourceId}::#1`)!.firstPos).toBe(10);
  });

  test('no intra-section edges: two chunks of ONE section never edge to each other', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);

    // One source, ONE heading "Solo", 2 identical-vector chunks (cosine 1.0 to each
    // other) — they share a section, so the pair is dropped. A SECOND source with a
    // near vector gives a legitimate cross-section edge to prove the probe runs.
    const v = vectorFor('solo-topic');
    await seedSource(userId, nb, 'Solo Doc', [
      { text: 'solo-a', heading: 'Solo', vec: v },
      { text: 'solo-b', heading: 'Solo', vec: v },
    ]);
    await seedSource(userId, nb, 'Other Doc', [{ text: 'other', heading: 'Other', vec: nearVec(v, 7) }]);

    const { body } = await getMap(cookie, nb);
    // 2 nodes (Solo bucket, Other bucket).
    expect(body.nodes).toHaveLength(2);
    // No self-edge.
    for (const e of body.edges) expect(e.a).not.toBe(e.b);
    // The Solo↔Other cross-section edge exists.
    expect(body.edges.length).toBe(1);
  });
});

describe('concept-map — document guard + degrade', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('a CARD chunk of the same user never becomes a node or pulls an edge', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);

    const topic = vectorFor('shared-topic');
    // Two document sections that connect.
    await seedSource(userId, nb, 'Doc A', [{ text: 'doc-a', heading: 'A', vec: topic }]);
    await seedSource(userId, nb, 'Doc B', [{ text: 'doc-b', heading: 'B', vec: nearVec(topic, 3) }]);
    // A CARD chunk with a vector IDENTICAL to the document topic — if the probe
    // leaked card vectors, it would either appear as a node (it can't — no section
    // row) or, more subtly, never. The count-preservation assert: nodes are exactly
    // the 2 document sections; edges only connect document sections.
    await seedCardChunk(cookie, userId, topic);

    const { body } = await getMap(cookie, nb);
    expect(body.nodes).toHaveLength(2);
    // No node references the card.
    expect(body.nodes.every((n) => n.label === 'A' || n.label === 'B')).toBe(true);
    // The single edge is the doc A↔B pair (both endpoints are document sections).
    const nodeIds = new Set(body.nodes.map((n) => n.id));
    for (const e of body.edges) {
      expect(nodeIds.has(e.a)).toBe(true);
      expect(nodeIds.has(e.b)).toBe(true);
    }
  });

  test('a source with no document vectors → not_indexed', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);

    // Source row + chunks WITHOUT kb_chunk vectors (parse-and-park state).
    const [src] = await db
      .insert(sourcesTable)
      .values({ userId, kind: 'pdf', title: 'Unindexed', status: 'ready', verified: true, chunkCount: 1 })
      .returning({ id: sourcesTable.id });
    await db.insert(notebookSourcesTable).values({ userId, notebookId: nb, sourceId: src!.id });
    await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId: src!.id, position: 0, text: 'parked', embedded: false });

    const { status, body } = await getMap(cookie, nb);
    expect(status).toBe(200);
    expect(body.reason).toBe('not_indexed');
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
  });

  test('an empty notebook (no sources) → not_indexed', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { status, body } = await getMap(cookie, nb);
    expect(status).toBe(200);
    expect(body.reason).toBe('not_indexed');
    expect(body.nodes).toEqual([]);
  });

  test('a non-ready source is excluded from the scope', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    // An indexing source with vectors — must NOT be a node (only ready sources).
    await seedSource(userId, nb, 'Mid-Ingest', [{ text: 'x', heading: 'X' }], 'indexing');
    const { body } = await getMap(cookie, nb);
    expect(body.reason).toBe('not_indexed');
    expect(body.nodes).toEqual([]);
  });
});

describe('concept-map — section cap (round-robin sample)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('a small maxSections caps nodes via an even cross-source round-robin', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);

    // Source A: 3 headings; Source B: 3 headings → 6 sections total.
    const a = await seedSource(userId, nb, 'A', [
      { text: 'a1', heading: 'A1' },
      { text: 'a2', heading: 'A2' },
      { text: 'a3', heading: 'A3' },
    ]);
    const b = await seedSource(userId, nb, 'B', [
      { text: 'b1', heading: 'B1' },
      { text: 'b2', heading: 'B2' },
      { text: 'b3', heading: 'B3' },
    ]);

    // Cap to 4 → round-robin picks A1,B1,A2,B2 (2 per source, even).
    const res = await conceptMap({
      userId,
      sourceIds: [a.sourceId, b.sourceId],
      maxSections: 4,
    });
    expect(res.nodes).toHaveLength(4);
    const fromA = res.nodes.filter((n) => n.sourceId === a.sourceId).length;
    const fromB = res.nodes.filter((n) => n.sourceId === b.sourceId).length;
    // Even sample: 2 from each source.
    expect(fromA).toBe(2);
    expect(fromB).toBe(2);
  });

  test('cap of 1 yields exactly one node', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const a = await seedSource(userId, nb, 'A', [
      { text: 'a1', heading: 'A1' },
      { text: 'a2', heading: 'A2' },
    ]);
    const res = await conceptMap({ userId, sourceIds: [a.sourceId], maxSections: 1 });
    expect(res.nodes).toHaveLength(1);
  });
});

describe('concept-map — ownership', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('foreign notebook → 404, no leak', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail('a'));
    const nb = await freshNotebook(userId);
    await seedSource(userId, nb, 'Secret', [{ text: 'secret', heading: 'Secret' }]);

    const other = await signUpAndCookie(app, uniqueEmail('b'));
    const res = await callApp(app, 'GET', `/notebooks/${nb}/concept-map`, { cookie: other.cookie });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  test('another user\'s document vectors never leak into the graph', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const nbA = await freshNotebook(a.userId);
    const topic = vectorFor('cross-tenant-topic');
    await seedSource(a.userId, nbA, 'A Doc', [{ text: 'a-doc', heading: 'A', vec: topic }]);

    // User B has a notebook with one source whose vector is IDENTICAL to A's — but
    // user_id-scoping must keep A's section out of B's graph.
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const nbB = await freshNotebook(b.userId);
    await seedSource(b.userId, nbB, 'B Doc', [{ text: 'b-doc', heading: 'B', vec: topic }]);

    const { body } = await getMap(b.cookie, nbB);
    // Only B's single section; no edge (nothing else in B's scope).
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]!.sourceTitle).toBe('B Doc');
    expect(body.edges).toEqual([]);
  });
});
