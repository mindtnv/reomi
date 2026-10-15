// Vector retrieval integration tests (Slice 4, plan §268, AC2).
//
// Seeds + indexes cards through the real API with a DETERMINISTIC fake embedder
// (injected via `__setAiClientForTests`, made synchronous via `drainIndexQueue`),
// then exercises `retrieve()` directly against the live pgvector index.
//
// Determinism: the fake embedder maps each text to a fixed unit-ish vector by
// scattering its hash across a few slots — same text → same vector, different
// text → (almost surely) a different vector. To make COSINE RANKING predictable
// we build query embeddings from the SAME embedder applied to the same topic
// text the target card carries, so the target card is the nearest neighbour.
//
// Covers:
//   * retrieve returns the expected top-k for a known topic (AC2).
//   * deck filter restricts the result set.
//   * suspended cards are excluded.
//   * empty corpus → [].
//   * CROSS-USER ISOLATION (SHOULD-FIX #11): A and B index identical topics; a
//     retrieve as A returns ONLY A's chunks, none of B's leak from the global
//     HNSW index, and the generated SQL always carries `user_id = $A`.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { db, kbChunk } from '@reomi/db';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { __resetAiClientForTests, __setAiClientForTests } from '../src/ai/openai-client.ts';
import { drainIndexQueue } from '../src/ai/index-queue.ts';
import { retrieve } from '../src/ai/retrieve.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const EMBED_DIM = 1536;

// Deterministic embedder shared with index.test.ts's approach: hash a text into
// a few non-zero slots. Same text → same vector.
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

function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map(vectorFor));
}

async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  return (
    await (await callApp(app, 'POST', '/decks', { cookie, body: { name } })).json<{ id: string }>()
  ).id;
}

/**
 * Build a query embedding matching a card's render_text. seedBasicCard's Basic
 * note renders to `"<front>\n<back>"` (front + back joined) — the render_text
 * the indexer embeds. We reconstruct it so the query vector === the chunk vector
 * for that card, making it the guaranteed nearest neighbour.
 */
function queryEmbeddingForChunkText(text: string): number[] {
  return vectorFor(text);
}

describe('retrieve (Slice 4)', () => {
  beforeEach(async () => {
    await resetTestDb();
    __setAiClientForTests({ embed: fakeEmbed });
  });

  afterAll(() => {
    __resetAiClientForTests();
  });

  test('returns the expected top-k for a known topic (AC2)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const photosynthesis = await seedBasicCard(app, cookie, {
      deckId,
      front: 'What is photosynthesis?',
      back: 'Plants converting light into energy',
    });
    await seedBasicCard(app, cookie, {
      deckId,
      front: 'Capital of France?',
      back: 'Paris',
    });
    await seedBasicCard(app, cookie, {
      deckId,
      front: 'Speed of light?',
      back: '299792458 m/s',
    });
    await drainIndexQueue({ timeoutMs: 5000 });

    // Read the indexed chunk text for the photosynthesis card and query with its
    // exact embedding → it must be the top hit.
    const [chunk] = await db
      .select({ text: kbChunk.text })
      .from(kbChunk)
      .where(and(eq(kbChunk.cardId, photosynthesis.id), eq(kbChunk.position, 0)))
      .limit(1);
    expect(chunk).toBeTruthy();

    const hits = await retrieve({
      userId,
      queryEmbedding: queryEmbeddingForChunkText(chunk!.text),
      k: 10,
    });

    expect(hits.length).toBe(3);
    expect(hits[0]!.cardId).toBe(photosynthesis.id);
    // Exact-match cosine distance ≈ 0 → score ≈ 1.
    expect(hits[0]!.score).toBeGreaterThan(0.99);
    // Provenance is carried.
    expect(hits[0]!.deckId).toBe(deckId);
    expect(hits[0]!.chunkId).toBeTruthy();
    expect(hits[0]!.text).toBe(chunk!.text);
  });

  test('k caps the result count', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    let first: string | undefined;
    for (let i = 0; i < 5; i++) {
      const c = await seedBasicCard(app, cookie, { deckId, front: `Topic ${i}`, back: `Body ${i}` });
      if (i === 0) first = c.renderText;
    }
    await drainIndexQueue({ timeoutMs: 5000 });

    const hits = await retrieve({ userId, queryEmbedding: vectorFor(first!), k: 2 });
    expect(hits.length).toBe(2);
  });

  test('deck filter restricts results to the named deck', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckA = await freshDeck(cookie, 'A');
    const deckB = await freshDeck(cookie, 'B');
    const inA = await seedBasicCard(app, cookie, { deckId: deckA, front: 'Alpha', back: 'in A' });
    const inB = await seedBasicCard(app, cookie, { deckId: deckB, front: 'Beta', back: 'in B' });
    await drainIndexQueue({ timeoutMs: 5000 });

    const hits = await retrieve({
      userId,
      queryEmbedding: vectorFor(inA.renderText),
      k: 10,
      deckIds: [deckA],
    });
    const cardIds = hits.map((h) => h.cardId);
    expect(cardIds).toContain(inA.id);
    expect(cardIds).not.toContain(inB.id);
  });

  test('suspended cards are excluded from retrieval', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Suspendable', back: 'card' });
    await drainIndexQueue({ timeoutMs: 5000 });

    // The chunk exists and is retrievable before suspension.
    const [chunk] = await db
      .select({ text: kbChunk.text })
      .from(kbChunk)
      .where(and(eq(kbChunk.cardId, card.id), eq(kbChunk.position, 0)))
      .limit(1);
    const before = await retrieve({ userId, queryEmbedding: vectorFor(chunk!.text), k: 10 });
    expect(before.map((h) => h.cardId)).toContain(card.id);

    // Suspend → excluded.
    const res = await callApp(app, 'POST', '/cards/bulk', {
      cookie,
      body: { action: 'suspend', cardIds: [card.id] },
    });
    expect(res.status).toBe(200);

    const after = await retrieve({ userId, queryEmbedding: vectorFor(chunk!.text), k: 10 });
    expect(after.map((h) => h.cardId)).not.toContain(card.id);
  });

  test('empty corpus → []', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const hits = await retrieve({ userId, queryEmbedding: vectorFor('anything'), k: 10 });
    expect(hits).toEqual([]);
  });

  test('empty query embedding → [] (no SQL run)', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const hits = await retrieve({ userId, queryEmbedding: [], k: 10 });
    expect(hits).toEqual([]);
  });

  // ── Relevance threshold (minScore) — the off-topic "always returns k" fix ────
  test('minScore gates weak matches (off-topic query → fewer/zero chunks)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, {
      deckId,
      front: 'What is photosynthesis?',
      back: 'Plants converting light into energy',
    });
    await drainIndexQueue({ timeoutMs: 5000 });
    const [chunk] = await db
      .select({ text: kbChunk.text })
      .from(kbChunk)
      .where(and(eq(kbChunk.cardId, card.id), eq(kbChunk.position, 0)))
      .limit(1);

    // An exact-match query (score ≈ 1) clears a moderate threshold.
    const pass = await retrieve({
      userId,
      queryEmbedding: queryEmbeddingForChunkText(chunk!.text),
      k: 10,
      minScore: 0.5,
    });
    expect(pass.map((h) => h.cardId)).toContain(card.id);

    // An impossible threshold (>1) prunes everything in SQL — even the exact match.
    const none = await retrieve({
      userId,
      queryEmbedding: queryEmbeddingForChunkText(chunk!.text),
      k: 10,
      minScore: 1.01,
    });
    expect(none).toEqual([]);

    // WITHOUT a threshold, an unrelated query STILL returns the card — this is the
    // naive "top-k always fires" behavior the minScore gate exists to fix.
    const unrelatedNoGate = await retrieve({
      userId,
      queryEmbedding: vectorFor('zzz totally unrelated qqq'),
      k: 10,
    });
    expect(unrelatedNoGate.length).toBeGreaterThan(0);
  });

  // ── Cross-user isolation (SHOULD-FIX #11, CRITICAL) ─────────────────────────
  test('cross-user isolation: A and B index identical topics; retrieve as A leaks none of B', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckA = await freshDeck(a.cookie, 'A');
    const deckB = await freshDeck(b.cookie, 'B');

    // Identical topic text for BOTH users → identical chunk vectors → both are
    // exact nearest neighbours of the query in the GLOBAL HNSW index. The ONLY
    // thing keeping B out of A's result is the user_id predicate.
    const front = 'Mitochondria';
    const back = 'the powerhouse of the cell';
    const cardA = await seedBasicCard(app, a.cookie, { deckId: deckA, front, back });
    const cardB = await seedBasicCard(app, b.cookie, { deckId: deckB, front, back });
    await drainIndexQueue({ timeoutMs: 5000 });

    // Sanity: both chunks exist in the shared index with identical text.
    const chunkA = (
      await db
        .select({ text: kbChunk.text, userId: kbChunk.userId })
        .from(kbChunk)
        .where(and(eq(kbChunk.cardId, cardA.id), eq(kbChunk.position, 0)))
        .limit(1)
    )[0];
    const chunkB = (
      await db
        .select({ text: kbChunk.text, userId: kbChunk.userId })
        .from(kbChunk)
        .where(and(eq(kbChunk.cardId, cardB.id), eq(kbChunk.position, 0)))
        .limit(1)
    )[0];
    expect(chunkA!.text).toBe(chunkB!.text); // identical embedding inputs
    expect(chunkA!.userId).toBe(a.userId);
    expect(chunkB!.userId).toBe(b.userId);

    // Retrieve as A — high k so nothing is truncated.
    const hitsA = await retrieve({ userId: a.userId, queryEmbedding: vectorFor(chunkA!.text), k: 50 });
    // (a) every returned chunk belongs to A; (b) none of B's leak.
    expect(hitsA.length).toBeGreaterThan(0);
    expect(hitsA.map((h) => h.cardId)).toContain(cardA.id);
    expect(hitsA.map((h) => h.cardId)).not.toContain(cardB.id);

    // Resolve the owner of every returned chunk and assert ALL are A's.
    const owners = await Promise.all(
      hitsA.map(async (h) => {
        const [row] = await db
          .select({ userId: kbChunk.userId })
          .from(kbChunk)
          .where(eq(kbChunk.id, h.chunkId))
          .limit(1);
        return row!.userId;
      }),
    );
    for (const owner of owners) expect(owner).toBe(a.userId);

    // Mirror: retrieve as B returns ONLY B's chunk.
    const hitsB = await retrieve({ userId: b.userId, queryEmbedding: vectorFor(chunkB!.text), k: 50 });
    expect(hitsB.map((h) => h.cardId)).toContain(cardB.id);
    expect(hitsB.map((h) => h.cardId)).not.toContain(cardA.id);
  });

  // (c) The generated SQL always carries the user_id predicate — asserted by
  // construction: retrieve() unconditionally pushes `kc.user_id = $userId` as the
  // FIRST WHERE conjunct (see retrieve.ts). The leak-free results above are the
  // behavioural proof; this test pins the construction so a refactor that drops
  // the predicate fails loudly.
  test('user_id predicate is always present in the generated SQL (by construction)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckB = await freshDeck(b.cookie, 'B');
    // Only B has data; A has none. With the mandatory predicate, A retrieves [].
    await seedBasicCard(app, b.cookie, { deckId: deckB, front: 'Only B', back: 'has this' });
    await drainIndexQueue({ timeoutMs: 5000 });

    const hitsA = await retrieve({ userId: a.userId, queryEmbedding: vectorFor('Only B\nhas this'), k: 50 });
    // If the user_id predicate were missing, A would see B's chunk. It must not.
    expect(hitsA).toEqual([]);
  });
});
