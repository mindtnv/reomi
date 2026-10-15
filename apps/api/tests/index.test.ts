// RAG indexing integration tests (Slice 3, plan §231 AC4 + §266-267).
//
// Uses buildApp() + app.handle (via callApp) + an injected DETERMINISTIC fake
// embedder + `await drainIndexQueue()` to make indexing synchronous WITHOUT real
// API keys. The fake's mere presence flips the effective embedding switch on
// (openai-client `isEmbeddingEnabled()` → true when a fake `embed` is injected),
// so `enqueueIndex`/index/reindex all operate even though OPENAI_API_KEY is
// unset in the test env. Mirrors how the suite pins `now`/fuzz today.
//
// Covers:
//   * POST /notes  → a kb_chunk row with an embedding appears for the card.
//   * PATCH /notes (content change) → chunk text/embedding updated, hash changed.
//   * a no-content updatedAt bump (PATCH /cards setDue, bulk move) → NO re-embed.
//   * bulk addTag → no re-embed (tags live on notes, not the chunk).
//   * POST /ai/reindex → all caller cards queued/indexed via the batch worker.
//   * user-scoping: user B's cards never indexed under A; reindex is caller-only.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { db, kbChunk } from '@reomi/db';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
} from '../src/ai/openai-client.ts';
import { drainIndexQueue } from '../src/ai/index-queue.ts';
import { cooldownReset } from '../src/ai-cooldown.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

const EMBED_DIM = 1536;

// Deterministic embedder: maps a text to a fixed 1536-dim vector by hashing the
// text into a handful of non-zero slots. Same text → same vector (so a content
// change yields a DIFFERENT vector, and an unchanged text yields the same one).
// Tracks call count + the exact texts embedded so tests can assert that a
// no-content bump did NOT trigger a paid re-embed.
let embedCalls = 0;
let embeddedTexts: string[] = [];
function fakeEmbed(texts: string[]): Promise<number[][]> {
  embedCalls += 1;
  embeddedTexts.push(...texts);
  return Promise.resolve(
    texts.map((t) => {
      const v = new Array<number>(EMBED_DIM).fill(0);
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      // Scatter a few deterministic components so vectors differ by content.
      for (let i = 0; i < 8; i++) {
        const idx = (h + i * 131) % EMBED_DIM;
        v[idx] = ((h >>> (i * 3)) % 100) / 100 + 0.01;
      }
      return v;
    }),
  );
}

function resetEmbedSpy(): void {
  embedCalls = 0;
  embeddedTexts = [];
}

async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  return (
    await (await callApp(app, 'POST', '/decks', { cookie, body: { name } })).json<{ id: string }>()
  ).id;
}

/** Read the position-0 chunk for a card directly from the DB. */
async function chunkForCard(cardId: string) {
  const [row] = await db
    .select()
    .from(kbChunk)
    .where(and(eq(kbChunk.cardId, cardId), eq(kbChunk.position, 0)))
    .limit(1);
  return row ?? null;
}

describe('rag indexing (Slice 3)', () => {
  beforeEach(async () => {
    await resetTestDb();
    __setAiClientForTests({ embed: fakeEmbed });
    resetEmbedSpy();
  });

  afterAll(() => {
    __resetAiClientForTests();
  });

  test('POST /notes → a kb_chunk row with an embedding appears for the card', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, {
      deckId,
      front: 'What is the capital of France?',
      back: 'Paris',
    });

    await drainIndexQueue({ timeoutMs: 5000 });

    const chunk = await chunkForCard(card.id);
    expect(chunk).not.toBeNull();
    expect(chunk!.userId).toBe(userId);
    expect(chunk!.sourceType).toBe('card');
    expect(chunk!.sourceId).toBe(card.id);
    expect(chunk!.parentId).toBe(card.id);
    expect(chunk!.position).toBe(0);
    expect(chunk!.embedding).not.toBeNull();
    expect(chunk!.embedding!.length).toBe(EMBED_DIM);
    expect(chunk!.embeddingModel).toBe('text-embedding-3-small');
    expect(chunk!.sourceHash).toBeTruthy();
    expect(chunk!.text.length).toBeGreaterThan(0);
    expect(embedCalls).toBeGreaterThan(0);
  });

  test('PATCH /notes (content change) → chunk text + embedding updated, sourceHash changed', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Old front', back: 'Old back' });
    await drainIndexQueue({ timeoutMs: 5000 });

    const before = await chunkForCard(card.id);
    expect(before).not.toBeNull();
    const beforeHash = before!.sourceHash;
    const beforeText = before!.text;

    // Resolve the noteId from the card payload to PATCH the note content.
    const noteId = card.noteId;
    resetEmbedSpy();
    const res = await callApp(app, 'PATCH', `/notes/${noteId}`, {
      cookie,
      body: { fieldValues: { Front: 'Brand new front', Back: 'Brand new back' } },
    });
    expect(res.status).toBe(200);
    await drainIndexQueue({ timeoutMs: 5000 });

    const after = await chunkForCard(card.id);
    expect(after).not.toBeNull();
    expect(after!.sourceHash).not.toBe(beforeHash);
    expect(after!.text).not.toBe(beforeText);
    expect(after!.text).toContain('Brand new front');
    // A content change DID re-embed.
    expect(embedCalls).toBeGreaterThan(0);
  });

  test('no-content updatedAt bump (PATCH /cards setDue) → NO re-embed, chunk unchanged', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Stable front', back: 'Stable back' });
    await drainIndexQueue({ timeoutMs: 5000 });

    const before = await chunkForCard(card.id);
    expect(before).not.toBeNull();
    const beforeHash = before!.sourceHash;
    const beforeEmbedding = JSON.stringify(before!.embedding);

    // setDue bumps cards.updatedAt but does NOT touch render_text.
    resetEmbedSpy();
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const res = await callApp(app, 'PATCH', `/cards/${card.id}`, { cookie, body: { setDue: due } });
    expect(res.status).toBe(200);

    // PATCH /cards does NOT enqueue (no write-hook), so nothing should be queued.
    await drainIndexQueue({ timeoutMs: 1000 });
    expect(embedCalls).toBe(0);

    const after = await chunkForCard(card.id);
    expect(after!.sourceHash).toBe(beforeHash);
    expect(JSON.stringify(after!.embedding)).toBe(beforeEmbedding);
  });

  test('bulk move → NO re-embed (content unchanged, sourceHash skip)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckA = await freshDeck(cookie, 'A');
    const deckB = await freshDeck(cookie, 'B');
    const card = await seedBasicCard(app, cookie, { deckId: deckA, front: 'Movable', back: 'card' });
    await drainIndexQueue({ timeoutMs: 5000 });
    const before = await chunkForCard(card.id);

    resetEmbedSpy();
    const res = await callApp(app, 'POST', '/cards/bulk', {
      cookie,
      body: { action: 'move', cardIds: [card.id], payload: { deckId: deckB } },
    });
    expect(res.status).toBe(200);
    await drainIndexQueue({ timeoutMs: 1000 });
    expect(embedCalls).toBe(0);

    const after = await chunkForCard(card.id);
    expect(after!.sourceHash).toBe(before!.sourceHash);
  });

  test('bulk addTag → no re-embed (tags live on notes, not the chunk)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Tag me', back: 'please' });
    await drainIndexQueue({ timeoutMs: 5000 });
    const before = await chunkForCard(card.id);
    const beforeHash = before!.sourceHash;

    resetEmbedSpy();
    const res = await callApp(app, 'POST', '/cards/bulk', {
      cookie,
      body: { action: 'addTag', cardIds: [card.id], payload: { tag: 'biology' } },
    });
    expect(res.status).toBe(200);
    await drainIndexQueue({ timeoutMs: 5000 });

    // render_text unchanged → sourceHash unchanged → NO re-embed. Tags live on
    // the notes row (tag-filtered retrieval JOINs it live), so the chunk is left
    // untouched — bulk tag ops never enqueue an index pass.
    expect(embedCalls).toBe(0);
    const after = await chunkForCard(card.id);
    expect(after).not.toBeNull();
    expect(after!.sourceHash).toBe(beforeHash);
  });

  test('POST /ai/reindex → all caller cards queued/indexed via the batch worker', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const c1 = await seedBasicCard(app, cookie, { deckId, front: 'Card one', back: 'a' });
    const c2 = await seedBasicCard(app, cookie, { deckId, front: 'Card two', back: 'b' });
    const c3 = await seedBasicCard(app, cookie, { deckId, front: 'Card three', back: 'c' });
    await drainIndexQueue({ timeoutMs: 5000 });

    // Wipe the chunks so reindex has work to do, then reindex from scratch.
    await db.delete(kbChunk);
    resetEmbedSpy();

    const res = await callApp(app, 'POST', '/ai/reindex', { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ queued: number }>();
    expect(body.queued).toBe(3);

    await drainIndexQueue({ timeoutMs: 5000 });
    for (const c of [c1, c2, c3]) {
      const chunk = await chunkForCard(c.id);
      expect(chunk).not.toBeNull();
      expect(chunk!.embedding).not.toBeNull();
    }
    expect(embedCalls).toBeGreaterThan(0);
  });

  test('user-scoping: user B cards never indexed under A; /ai/reindex is caller-only', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckA = await freshDeck(a.cookie, 'A');
    const deckB = await freshDeck(b.cookie, 'B');
    const cardA = await seedBasicCard(app, a.cookie, { deckId: deckA, front: 'A topic', back: 'a' });
    const cardB = await seedBasicCard(app, b.cookie, { deckId: deckB, front: 'B topic', back: 'b' });
    await drainIndexQueue({ timeoutMs: 5000 });

    // Each chunk carries its own owner's userId — never crossed.
    const chunkA = await chunkForCard(cardA.id);
    const chunkB = await chunkForCard(cardB.id);
    expect(chunkA!.userId).toBe(a.userId);
    expect(chunkB!.userId).toBe(b.userId);

    // Wipe + reindex AS user A only → only A's card is requeued.
    await db.delete(kbChunk);
    resetEmbedSpy();
    const res = await callApp(app, 'POST', '/ai/reindex', { cookie: a.cookie });
    const body = await res.json<{ queued: number }>();
    expect(body.queued).toBe(1);
    await drainIndexQueue({ timeoutMs: 5000 });

    expect(await chunkForCard(cardA.id)).not.toBeNull();
    expect(await chunkForCard(cardB.id)).toBeNull();
  });

  // The per-user reindex cooldown short-circuits under NODE_ENV=test; force it on
  // (mirrors rate-limit.test.ts) to prove a rapid second reindex gets 429.
  test('POST /ai/reindex rapid second call ⇒ 429 cooldown (forced-on)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    await seedBasicCard(app, cookie, { deckId, front: 'Card one', back: 'a' });
    await drainIndexQueue({ timeoutMs: 5000 });

    cooldownReset();
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const first = await callApp(app, 'POST', '/ai/reindex', { cookie });
      expect(first.status).toBe(200);

      const second = await callApp(app, 'POST', '/ai/reindex', { cookie });
      expect(second.status).toBe(429);
      const body = await second.json<{ error: string; retryAfterMs: number }>();
      expect(body.error).toBe('cooldown');
      expect(body.retryAfterMs).toBeGreaterThan(0);
    } finally {
      process.env.NODE_ENV = savedEnv;
      cooldownReset();
    }
    await drainIndexQueue({ timeoutMs: 5000 });
  });
});
