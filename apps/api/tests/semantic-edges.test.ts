// GET /graph/semantic-edges integration tests.
//
// Same fixture discipline as similar.test.ts: vectors go straight into
// kb_chunk (insertChunkFixture), no AI client involved — the endpoint must
// work from stored data alone.

import { beforeEach, describe, expect, test } from 'bun:test';
import { cards as cardsTable, db } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  callApp,
  insertChunkFixture,
  nearVectorFixture,
  resetTestDb,
  seedBasicCard,
  signUpAndCookie,
  uniqueEmail,
  vectorFixtureFor,
} from './helpers.ts';

const app = buildApp();

interface EdgesBody {
  edges: { a: string; b: string; score: number }[];
  nodes: number;
  reason?: string;
}

async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name } });
  return (await res.json<{ id: string }>()).id;
}

async function getEdges(cookie: string, query = ''): Promise<EdgesBody> {
  const res = await callApp(app, 'GET', `/graph/semantic-edges${query}`, { cookie });
  expect(res.status).toBe(200);
  return res.json<EdgesBody>();
}

/** Seed a card + a fixture chunk in one go; returns the card id. */
async function seedEmbedded(
  cookie: string,
  userId: string,
  deckId: string,
  front: string,
  vector: number[],
): Promise<string> {
  const card = await seedBasicCard(app, cookie, { deckId, front, back: 'a' });
  await insertChunkFixture(userId, card.id, front, vector);
  return card.id;
}

describe('GET /graph/semantic-edges', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('401 without a session cookie', async () => {
    const res = await callApp(app, 'GET', '/graph/semantic-edges', {});
    expect(res.status).toBe(401);
  });

  test('no embedded chunks → { edges: [], nodes: 0, reason: "not_indexed" } (200)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' }); // card, no chunk

    const body = await getEdges(cookie);
    expect(body.edges).toEqual([]);
    expect(body.nodes).toBe(0);
    expect(body.reason).toBe('not_indexed');
  });

  test('clusters: edges inside a cluster, none across; pairs unique with a < b; no loops', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const bio = vectorFixtureFor('biology cluster');
    const fr = vectorFixtureFor('totally different french cluster');
    const b1 = await seedEmbedded(cookie, userId, deckId, 'bio-1', bio);
    const b2 = await seedEmbedded(cookie, userId, deckId, 'bio-2', nearVectorFixture(bio, 0.04, 1));
    const f1 = await seedEmbedded(cookie, userId, deckId, 'fr-1', fr);
    const f2 = await seedEmbedded(cookie, userId, deckId, 'fr-2', nearVectorFixture(fr, 0.04, 2));

    const body = await getEdges(cookie);
    expect(body.nodes).toBe(4);
    expect(body.reason).toBeUndefined();

    const key = (a: string, b: string) => [a, b].sort().join('|');
    const keys = body.edges.map((e) => key(e.a, e.b));
    // Each unordered pair appears exactly once, normalized a < b, no self-loops.
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of body.edges) {
      expect(e.a < e.b).toBe(true);
      expect(e.a).not.toBe(e.b);
      expect(e.score).toBeGreaterThan(0);
      expect(e.score).toBeLessThanOrEqual(1.0000001);
    }
    // Intra-cluster edges exist…
    expect(keys).toContain(key(b1, b2));
    expect(keys).toContain(key(f1, f2));
    // …cross-cluster ones don't (minScore default 0.35 cuts unrelated vectors).
    expect(keys).not.toContain(key(b1, f1));
    expect(keys).not.toContain(key(b2, f2));
  });

  test('multi-chunk cards collapse to a single edge per pair', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const base = vectorFixtureFor('multichunk pair');
    const c1 = await seedBasicCard(app, cookie, { deckId, front: 'm1', back: 'a' });
    const c2 = await seedBasicCard(app, cookie, { deckId, front: 'm2', back: 'a' });
    await insertChunkFixture(userId, c1.id, 'm1 p0', base, 0);
    await insertChunkFixture(userId, c1.id, 'm1 p1', nearVectorFixture(base, 0.02, 1), 1);
    await insertChunkFixture(userId, c2.id, 'm2 p0', nearVectorFixture(base, 0.03, 2), 0);
    await insertChunkFixture(userId, c2.id, 'm2 p1', nearVectorFixture(base, 0.04, 3), 1);

    const body = await getEdges(cookie);
    const between = body.edges.filter(
      (e) => [e.a, e.b].sort().join('|') === [c1.id, c2.id].sort().join('|'),
    );
    expect(between.length).toBe(1);
  });

  test('suspended cards produce no edges (neither as source nor target)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const base = vectorFixtureFor('suspended edge topic');
    const live = await seedEmbedded(cookie, userId, deckId, 'live', base);
    const sus = await seedEmbedded(cookie, userId, deckId, 'sus', nearVectorFixture(base));
    await db.update(cardsTable).set({ suspended: true }).where(eq(cardsTable.id, sus));

    const body = await getEdges(cookie);
    expect(body.edges.some((e) => e.a === sus || e.b === sus)).toBe(false);
    expect(body.edges.some((e) => e.a === live || e.b === live)).toBe(false); // its only twin is suspended
    expect(body.nodes).toBe(1); // only the live card counts
  });

  test('limit and minScore params clamp/filter', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const base = vectorFixtureFor('param topic');
    for (let i = 0; i < 5; i++) {
      await seedEmbedded(cookie, userId, deckId, `p${i}`, nearVectorFixture(base, 0.02, i + 1));
    }

    const all = await getEdges(cookie);
    expect(all.edges.length).toBeGreaterThan(1);

    const limited = await getEdges(cookie, '?limit=1');
    expect(limited.edges.length).toBe(1);

    const strict = await getEdges(cookie, '?minScore=0.9999');
    expect(strict.edges.length).toBe(0);
    expect(strict.reason).toBeUndefined(); // indexed, just nothing above the floor
  });

  test('cross-user isolation: B\'s identical vectors never appear in A\'s edges', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckA = await freshDeck(a.cookie, 'A');
    const deckB = await freshDeck(b.cookie, 'B');
    const base = vectorFixtureFor('cross user edges');
    const a1 = await seedEmbedded(a.cookie, a.userId, deckA, 'a1', base);
    const a2 = await seedEmbedded(a.cookie, a.userId, deckA, 'a2', nearVectorFixture(base, 0.04, 1));
    // B carries the IDENTICAL vectors — without the user predicate the global
    // HNSW index would interleave B's cards into A's neighbour lists.
    const b1 = await seedEmbedded(b.cookie, b.userId, deckB, 'b1', base);
    const b2 = await seedEmbedded(b.cookie, b.userId, deckB, 'b2', nearVectorFixture(base, 0.04, 1));

    const body = await getEdges(a.cookie);
    const ids = new Set(body.edges.flatMap((e) => [e.a, e.b]));
    expect(ids.has(b1)).toBe(false);
    expect(ids.has(b2)).toBe(false);
    expect(ids.has(a1)).toBe(true);
    expect(ids.has(a2)).toBe(true);
    expect(body.nodes).toBe(2);
  });
});
