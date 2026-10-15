// GET /cards/:id/similar integration tests.
//
// Embeddings are inserted DIRECTLY into kb_chunk via insertChunkFixture — NO
// __setAiClientForTests, no drainIndexQueue. That is the point: the endpoint
// must work from stored vectors alone (NODE_ENV=test keeps embeddingEnabled
// false), proving independence from the AI client.

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

interface SimilarBody {
  items: { cardId: string; deckId: string; score: number; snippet: string }[];
  reason?: string;
}

async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name } });
  return (await res.json<{ id: string }>()).id;
}

async function getSimilar(cookie: string, cardId: string, query = ''): Promise<SimilarBody> {
  const res = await callApp(app, 'GET', `/cards/${cardId}/similar${query}`, { cookie });
  expect(res.status).toBe(200);
  return res.json<SimilarBody>();
}

describe('GET /cards/:id/similar', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('401 without a session cookie', async () => {
    const res = await callApp(
      app,
      'GET',
      '/cards/00000000-0000-0000-0000-000000000001/similar',
      {},
    );
    expect(res.status).toBe(401);
  });

  test('404 on a missing id and on ANOTHER user\'s card (ownership before lookup)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckB = await freshDeck(b.cookie, 'B');
    const cardB = await seedBasicCard(app, b.cookie, { deckId: deckB, front: 'qb', back: 'a' });

    const missing = await callApp(
      app,
      'GET',
      '/cards/00000000-0000-0000-0000-0000000000aa/similar',
      { cookie: a.cookie },
    );
    expect(missing.status).toBe(404);

    const foreign = await callApp(app, 'GET', `/cards/${cardB.id}/similar`, { cookie: a.cookie });
    expect(foreign.status).toBe(404);
  });

  test('card without an embedded chunk → { items: [], reason: "not_indexed" }', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });

    const body = await getSimilar(cookie, card.id);
    expect(body.items).toEqual([]);
    expect(body.reason).toBe('not_indexed');
  });

  test('happy path: nearest card first, source card excluded, scores descend', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const c1 = await seedBasicCard(app, cookie, { deckId, front: 'mitochondria', back: 'a' });
    const c2 = await seedBasicCard(app, cookie, { deckId, front: 'mitochondria-2', back: 'a' });
    const c3 = await seedBasicCard(app, cookie, { deckId, front: 'french verbs', back: 'a' });

    const base = vectorFixtureFor('mitochondria are the powerhouse');
    await insertChunkFixture(userId, c1.id, 'mitochondria are the powerhouse', base);
    await insertChunkFixture(userId, c2.id, 'mitochondria produce ATP', nearVectorFixture(base));
    await insertChunkFixture(userId, c3.id, 'unrelated french verbs', vectorFixtureFor('unrelated french verbs'));

    const body = await getSimilar(cookie, c1.id);
    expect(body.reason).toBeUndefined();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]!.cardId).toBe(c2.id);
    expect(body.items.every((i) => i.cardId !== c1.id)).toBe(true);
    for (let i = 1; i < body.items.length; i++) {
      expect(body.items[i - 1]!.score).toBeGreaterThanOrEqual(body.items[i]!.score);
    }
    expect(body.items[0]!.score).toBeGreaterThan(0);
    expect(body.items[0]!.score).toBeLessThanOrEqual(1);
    expect(body.items[0]!.snippet.length).toBeGreaterThan(0);
  });

  test('multi-chunk source card yields no duplicate neighbours (MAX aggregation)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const src = await seedBasicCard(app, cookie, { deckId, front: 'src', back: 'a' });
    const other = await seedBasicCard(app, cookie, { deckId, front: 'other', back: 'a' });

    const base = vectorFixtureFor('shared topic vector');
    // Source card has TWO chunks, both near the same neighbour.
    await insertChunkFixture(userId, src.id, 'shared topic part one', base, 0);
    await insertChunkFixture(userId, src.id, 'shared topic part two', nearVectorFixture(base, 0.03, 2), 1);
    await insertChunkFixture(userId, other.id, 'shared topic neighbour', nearVectorFixture(base, 0.05, 3));

    const body = await getSimilar(cookie, src.id);
    const ids = body.items.map((i) => i.cardId);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
    expect(ids).toContain(other.id);
    expect(ids).not.toContain(src.id);
  });

  test('suspended cards never appear in results', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const src = await seedBasicCard(app, cookie, { deckId, front: 'src', back: 'a' });
    const sus = await seedBasicCard(app, cookie, { deckId, front: 'sus', back: 'a' });
    const base = vectorFixtureFor('suspension test topic');
    await insertChunkFixture(userId, src.id, 'suspension test topic', base);
    await insertChunkFixture(userId, sus.id, 'suspension test twin', nearVectorFixture(base));
    await db.update(cardsTable).set({ suspended: true }).where(eq(cardsTable.id, sus.id));

    const body = await getSimilar(cookie, src.id);
    expect(body.items.map((i) => i.cardId)).not.toContain(sus.id);
  });

  test('k clamps and minScore filters', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const src = await seedBasicCard(app, cookie, { deckId, front: 'src', back: 'a' });
    const base = vectorFixtureFor('clamp topic');
    await insertChunkFixture(userId, src.id, 'clamp topic', base);
    for (let i = 0; i < 4; i++) {
      const c = await seedBasicCard(app, cookie, { deckId, front: `n${i}`, back: 'a' });
      // eps=0.5 keeps the neighbours similar (cos ≈ 0.9) but FAR from identical,
      // so the strict minScore below reliably cuts all of them.
      await insertChunkFixture(userId, c.id, `clamp neighbour ${i}`, nearVectorFixture(base, 0.5, i + 1));
    }

    const limited = await getSimilar(cookie, src.id, '?k=2');
    expect(limited.items.length).toBeLessThanOrEqual(2);

    // minScore=0.999 cuts everything that isn't (near-)identical.
    const strict = await getSimilar(cookie, src.id, '?minScore=0.999');
    expect(strict.items.length).toBe(0);
    expect(strict.reason).toBeUndefined(); // indexed, just no matches
  });

  test('cross-user isolation: identical vectors for user B never leak into A', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckA = await freshDeck(a.cookie, 'A');
    const deckB = await freshDeck(b.cookie, 'B');
    const cardA = await seedBasicCard(app, a.cookie, { deckId: deckA, front: 'qa', back: 'a' });
    const twinB = await seedBasicCard(app, b.cookie, { deckId: deckB, front: 'qb', back: 'b' });

    const base = vectorFixtureFor('identical topic both users');
    await insertChunkFixture(a.userId, cardA.id, 'identical topic both users', base);
    // B's card carries the IDENTICAL vector — the global HNSW index would rank
    // it first if the user predicate were missing.
    await insertChunkFixture(b.userId, twinB.id, 'identical topic both users', base);

    const body = await getSimilar(a.cookie, cardA.id);
    expect(body.items.map((i) => i.cardId)).not.toContain(twinB.id);
  });

  test('sanity: AI is OFF in tests, yet similar works from stored vectors', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const statusRes = await callApp(app, 'GET', '/ai/status', { cookie });
    const status = await statusRes.json<{ embeddingEnabled: boolean }>();
    expect(status.embeddingEnabled).toBe(false);

    const deckId = await freshDeck(cookie);
    const c1 = await seedBasicCard(app, cookie, { deckId, front: 'a1', back: 'a' });
    const c2 = await seedBasicCard(app, cookie, { deckId, front: 'a2', back: 'a' });
    const base = vectorFixtureFor('offline similar works');
    await insertChunkFixture(userId, c1.id, 'offline similar works', base);
    await insertChunkFixture(userId, c2.id, 'offline similar twin', nearVectorFixture(base));

    const body = await getSimilar(cookie, c1.id);
    expect(body.items.map((i) => i.cardId)).toContain(c2.id);
  });
});
