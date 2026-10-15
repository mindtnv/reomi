// «Блокноты 2.0» N4 — notebook source recommendations (Р11). Vectors-only.
//
// CONTRACT (read from ai/suggest-sources.ts + modules/notebooks.ts GET
// /notebooks/:id/suggest-sources):
//   * Centroid = AVG of a sample of the notebook's ATTACHED document vectors.
//   * Probe = ANN over UNATTACHED `ready` document vectors of the SAME user,
//     GROUP BY source_id (MAX score), top-5 {sourceId, title, kind, score}.
//   * Attached sources are EXCLUDED (they're the centroid, not a suggestion).
//   * A foreign user's source is EXCLUDED (user-scoped). A non-ready source is
//     EXCLUDED. CARD vectors never influence the centroid/probe (document-guard).
//   * No attached vectors → not_indexed. Nothing to suggest → {items:[]}.
//   * foreign notebook → 404.
//
// Document vectors seeded directly; `vectorFor(text)` gives deterministic cosine.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  db,
  kbChunk,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  sourceChunks as sourceChunksTable,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const EMBED_DIM = 1536;

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

/**
 * Seed a source with one document chunk of vector `vec`. Optionally attach it to a
 * notebook. `status` controls readiness. Returns the source id.
 */
async function seedSource(opts: {
  userId: string;
  notebookId?: string;
  title: string;
  vec: number[];
  status?: 'ready' | 'indexing' | 'pending';
}): Promise<string> {
  const status = opts.status ?? 'ready';
  const [src] = await db
    .insert(sourcesTable)
    .values({ userId: opts.userId, kind: 'pdf', title: opts.title, status, verified: true, chunkCount: 1 })
    .returning({ id: sourcesTable.id });
  const sourceId = src!.id;
  if (opts.notebookId) {
    await db
      .insert(notebookSourcesTable)
      .values({ userId: opts.userId, notebookId: opts.notebookId, sourceId });
  }
  await db
    .insert(sourceChunksTable)
    .values({ userId: opts.userId, sourceId, position: 0, text: opts.title, embedded: true });
  await db.insert(kbChunk).values({
    userId: opts.userId,
    sourceType: 'document',
    sourceId,
    parentId: sourceId,
    position: 0,
    text: opts.title,
    embedding: opts.vec,
    embeddingModel: 'test-fixture',
    sourceHash: `fixture-${sourceId}`,
    cardId: null,
  });
  return sourceId;
}

/** Seed a REAL card + a CARD kb_chunk (FK to `cards` holds). Returns the card id. */
async function seedCardChunk(cookie: string, userId: string, vec: number[]): Promise<string> {
  const deckRes = await callApp(app, 'POST', '/decks', { cookie, body: { name: 'D' } });
  const deckId = (await deckRes.json<{ id: string }>()).id;
  const card = await seedBasicCard(app, cookie, { deckId, front: 'f', back: 'b' });
  await db.insert(kbChunk).values({
    userId,
    sourceType: 'card',
    sourceId: card.id,
    parentId: card.id,
    position: 0,
    text: 'card',
    embedding: vec,
    embeddingModel: 'test-fixture',
    sourceHash: `card-${card.id}`,
    cardId: card.id,
  });
  return card.id;
}

interface SuggestResp {
  items: { sourceId: string; title: string; kind: string; score: number }[];
  reason?: string;
}
async function getSuggest(cookie: string, nb: string): Promise<{ status: number; body: SuggestResp }> {
  const res = await callApp(app, 'GET', `/notebooks/${nb}/suggest-sources`, { cookie });
  return { status: res.status, body: await res.json<SuggestResp>() };
}

describe('suggest-sources — recommendation', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('an unattached ready source with a similar vector is recommended', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);

    const topic = vectorFor('machine-learning');
    // Attached (the centroid).
    await seedSource({ userId, notebookId: nb, title: 'Attached', vec: topic });
    // Unattached ready source with a near vector → should be suggested.
    const candidate = await seedSource({ userId, title: 'Candidate', vec: nearVec(topic, 1) });
    // An unattached ready source with an UNRELATED vector → below the floor.
    await seedSource({ userId, title: 'Unrelated', vec: vectorFor('cooking-recipes') });

    const { status, body } = await getSuggest(cookie, nb);
    expect(status).toBe(200);
    expect(body.reason).toBeUndefined();
    const ids = body.items.map((i) => i.sourceId);
    expect(ids).toContain(candidate);
    const cand = body.items.find((i) => i.sourceId === candidate)!;
    expect(cand.title).toBe('Candidate');
    expect(cand.kind).toBe('pdf');
    expect(cand.score).toBeGreaterThan(0.3);
    expect(cand.score).toBeLessThanOrEqual(1);
    // Unrelated must not appear.
    expect(body.items.some((i) => i.title === 'Unrelated')).toBe(false);
  });

  test('an attached source is excluded from its own recommendations', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);

    const topic = vectorFor('topic');
    const attached = await seedSource({ userId, notebookId: nb, title: 'Attached', vec: topic });
    // A second attached source (identical vector) — still excluded, it's attached.
    const attached2 = await seedSource({
      userId,
      notebookId: nb,
      title: 'Attached2',
      vec: nearVec(topic, 2),
    });
    // One unattached candidate to prove the probe runs.
    const candidate = await seedSource({ userId, title: 'Free', vec: nearVec(topic, 3) });

    const { body } = await getSuggest(cookie, nb);
    const ids = body.items.map((i) => i.sourceId);
    expect(ids).not.toContain(attached);
    expect(ids).not.toContain(attached2);
    expect(ids).toContain(candidate);
  });

  test('a foreign user\'s source is never recommended', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const nb = await freshNotebook(a.userId);
    const topic = vectorFor('shared');
    await seedSource({ userId: a.userId, notebookId: nb, title: 'A Attached', vec: topic });

    // User B owns a ready source with the SAME vector — must NOT leak to A.
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    await seedSource({ userId: b.userId, title: 'B Source', vec: nearVec(topic, 1) });

    const { body } = await getSuggest(a.cookie, nb);
    expect(body.items.some((i) => i.title === 'B Source')).toBe(false);
    // Nothing else of A's is unattached → empty.
    expect(body.items).toEqual([]);
  });

  test('a non-ready source is excluded from candidates', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const topic = vectorFor('t');
    await seedSource({ userId, notebookId: nb, title: 'Attached', vec: topic });
    // Unattached but INDEXING (not ready) → excluded even with a perfect vector.
    await seedSource({ userId, title: 'MidIngest', vec: nearVec(topic, 1), status: 'indexing' });

    const { body } = await getSuggest(cookie, nb);
    expect(body.items.some((i) => i.title === 'MidIngest')).toBe(false);
    expect(body.items).toEqual([]);
  });

  test('card vectors never influence the centroid or appear as suggestions', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const topic = vectorFor('topic');
    await seedSource({ userId, notebookId: nb, title: 'Attached', vec: topic });
    // A card chunk near the topic — must not become a suggestion (no source row to
    // join `status='ready'`) NOR pollute the centroid (document-guard on the AVG).
    const cardId = await seedCardChunk(cookie, userId, topic);
    // A legit unattached candidate.
    const candidate = await seedSource({ userId, title: 'Candidate', vec: nearVec(topic, 5) });

    const { body } = await getSuggest(cookie, nb);
    const ids = body.items.map((i) => i.sourceId);
    expect(ids).toContain(candidate);
    // The card id must never appear.
    expect(ids).not.toContain(cardId);
  });
});

describe('suggest-sources — degrade + ownership', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('no attached document vectors → not_indexed', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    // An attached source with chunks but NO kb_chunk vectors (parked).
    const [src] = await db
      .insert(sourcesTable)
      .values({ userId, kind: 'pdf', title: 'Parked', status: 'ready', verified: true, chunkCount: 1 })
      .returning({ id: sourcesTable.id });
    await db.insert(notebookSourcesTable).values({ userId, notebookId: nb, sourceId: src!.id });
    await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId: src!.id, position: 0, text: 'parked', embedded: false });

    const { status, body } = await getSuggest(cookie, nb);
    expect(status).toBe(200);
    expect(body.reason).toBe('not_indexed');
    expect(body.items).toEqual([]);
  });

  test('empty notebook → not_indexed', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { body } = await getSuggest(cookie, nb);
    expect(body.reason).toBe('not_indexed');
    expect(body.items).toEqual([]);
  });

  test('everything attached / nothing to suggest → empty items', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    // The only source is attached → no candidates left.
    await seedSource({ userId, notebookId: nb, title: 'Only', vec: vectorFor('x') });
    const { body } = await getSuggest(cookie, nb);
    expect(body.reason).toBeUndefined();
    expect(body.items).toEqual([]);
  });

  test('foreign notebook → 404', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail('a'));
    const nb = await freshNotebook(userId);
    const other = await signUpAndCookie(app, uniqueEmail('b'));
    const res = await callApp(app, 'GET', `/notebooks/${nb}/suggest-sources`, { cookie: other.cookie });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
