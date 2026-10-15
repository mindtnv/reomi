// Quick-card with reading provenance + AI formulate (M5 / T1):
//   * POST /sources/:id/quick-card { deckId, front, back, page?, quote? }
//     resolves the builtin Basic note type LIVE, inserts the note + cards AND the
//     card_sources provenance edges in ONE tx, returns { noteId, cardIds }:
//       - page given + page-matched source_chunks → one edge per (card × chunk),
//         capped CARD_SOURCE_LINK_CAP, each carrying sourceChunkId + sourceId,
//         notebookId/conversationId/messageId NULL (reading-born provenance —
//         library refactor: a source may belong to zero notebooks).
//       - NO page / no page-matched chunk → exactly ONE fallback edge per card
//         with sourceChunkId NULL (still sourceId; notebookId NULL).
//       - the created card appears in GET /cards/:id/sources.
//       - foreign deckId → a clean 400 (resolveNoteCreate authorizes the deck),
//         never a 500; foreign source → 404; missing front → 400 (route schema).
//   * POST /sources/:id/suggest-card { quote, page? } → the cheap complete()
//     surface → defensive JSON parse → { front, back }; chat disabled → 503
//     `ai_disabled`; an unparseable completion → 502 `suggest_failed`.
//
// Harness: direct-DB notebook/source/chunk fixtures (mirrors marked-passages),
// ensureBuiltins() so the LIVE Basic note-type resolve finds a row, and the
// injectable complete() / chat-surface fake (mirrors chat-title.test.ts) — note
// the fake must carry a chat surface (chatStreamAgentic) so isChatEnabled() flips
// on for the suggest-card route's pre-flush gate.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  cardSources as cardSourcesTable,
  cards as cardsTable,
  db,
  ensureBuiltins,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  notes as notesTable,
  sourceChunks as sourceChunksTable,
  sourceMarks as sourceMarksTable,
  sources as sourcesTable,
} from '@reomi/db';
import type { MarkRect } from '@reomi/shared';
import { asc, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { env } from '../src/env.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// ── fixtures ──────────────────────────────────────────────────────────────────

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

async function freshDeck(cookie: string, name = 'Deck'): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name } });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

/**
 * Seed a READY source + its source_chunks (each carrying a `page` so quick-card
 * can resolve page-matched chunks for provenance). Returns the source id +
 * notebook id + chunk ids (in position order).
 */
async function seedSourceWithChunks(
  userId: string,
  notebookId: string,
  title: string,
  chunks: { text: string; page?: number }[],
): Promise<{ sourceId: string; chunkIds: string[] }> {
  const [src] = await db
    .insert(sourcesTable)
    .values({
      userId,
      kind: 'pdf',
      title,
      status: 'ready',
      verified: true,
      chunkCount: chunks.length,
    })
    .returning({ id: sourcesTable.id });
  const sourceId = src!.id;
  // Library refactor: a source is user-level; the notebook binding is an edge.
  await db.insert(notebookSourcesTable).values({ userId, notebookId, sourceId });
  const chunkIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const [sc] = await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId, position: i, text: c.text, page: c.page, embedded: true })
      .returning({ id: sourceChunksTable.id });
    chunkIds.push(sc!.id);
  }
  return { sourceId, chunkIds };
}

function quickCard(cookie: string, sourceId: string, body: Record<string, unknown>) {
  return callApp(app, 'POST', `/sources/${sourceId}/quick-card`, { cookie, body });
}
function suggestCard(cookie: string, sourceId: string, body: Record<string, unknown>) {
  return callApp(app, 'POST', `/sources/${sourceId}/suggest-card`, { cookie, body });
}

async function edgesFor(userId: string) {
  return db
    .select()
    .from(cardSourcesTable)
    .where(eq(cardSourcesTable.userId, userId))
    .orderBy(asc(cardSourcesTable.createdAt));
}

// A no-op agent stream — present only so isChatEnabled() flips on for the
// suggest-card pre-flush gate (the quick-card route never streams).
async function* noopAgentStream(messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
  void messages;
  yield { type: 'finish', reason: 'stop' };
}

// ── quick-card: provenance edges ─────────────────────────────────────────────

describe('POST /sources/:id/quick-card — provenance', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('first source-backed card needs no notebook and enters the new deck study queue', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const [source] = await db.insert(sourcesTable).values({ userId, kind: 'pdf', title: 'First book', status: 'ready' }).returning();
    await db.insert(sourceChunksTable).values({ userId, sourceId: source!.id, position: 0, page: 7, text: 'A Pod groups containers.' });
    const deckId = await freshDeck(cookie);
    const saved = await quickCard(cookie, source!.id, { deckId, front: 'What does a Pod group?', back: 'Containers.', page: 7, quote: 'A Pod groups containers.' });
    expect(saved.status).toBe(200);
    const { cardIds } = await saved.json<{ cardIds: string[] }>();
    const queue = await callApp(app, 'GET', `/cards/queue?deckId=${deckId}`, { cookie });
    expect(queue.status).toBe(200);
    const queued = await queue.json<{ new: { id: string }[] }>();
    expect(queued.new.map(card => card.id)).toContain(cardIds[0]!);
    const links = await callApp(app, 'GET', `/cards/${cardIds[0]}/sources`, { cookie });
    expect(links.status).toBe(200);
    expect(await links.text()).toContain(source!.id);
    expect(await db.select({ id: notebooksTable.id }).from(notebooksTable).where(eq(notebooksTable.userId, userId))).toEqual([]);
  });

  test('page-matched chunks → one edge per chunk (full chain), conv/msg NULL', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Bio');
    const deckId = await freshDeck(cookie);
    // Page 3 has TWO chunks; page 7 has one. Card is from page 3.
    const { sourceId, chunkIds } = await seedSourceWithChunks(userId, notebookId, 'Cell Biology', [
      { text: 'mitochondria are the powerhouse', page: 3 }, // chunk 0
      { text: 'ATP synthase spans the membrane', page: 3 }, // chunk 1 (same page)
      { text: 'unrelated chapter two material', page: 7 }, // chunk 2 (different page)
    ]);

    const res = await quickCard(cookie, sourceId, {
      deckId,
      front: 'What is the powerhouse of the cell?',
      back: 'The mitochondria.',
      page: 3,
      quote: 'mitochondria are the powerhouse of the cell',
    });
    expect(res.status).toBe(200);
    const { noteId, cardIds } = await res.json<{ noteId: string; cardIds: string[] }>();
    expect(noteId).toBeTruthy();
    expect(cardIds.length).toBe(1); // Basic generates one card

    // Note + card exist.
    const noteRows = await db.select().from(notesTable).where(eq(notesTable.id, noteId));
    expect(noteRows.length).toBe(1);
    const cardRows = await db.select().from(cardsTable).where(eq(cardsTable.userId, userId));
    expect(cardRows.length).toBe(1);
    expect(cardRows[0]!.id).toBe(cardIds[0]);

    // Edges = the two page-3 chunks (the page-7 chunk is NOT linked).
    const edges = await edgesFor(userId);
    expect(edges.length).toBe(2);
    const linkedChunks = edges.map((e) => e.sourceChunkId).sort();
    expect(linkedChunks).toEqual([chunkIds[0]!, chunkIds[1]!].sort());
    expect(linkedChunks).not.toContain(chunkIds[2]);
    for (const e of edges) {
      expect(e.cardId).toBe(cardIds[0]);
      expect(e.sourceId).toBe(sourceId);
      // Library refactor: quick-card provenance is born of READING, not a
      // notebook — a library source may belong to zero notebooks, so the edge's
      // notebookId is always NULL (card_sources permits it).
      expect(e.notebookId).toBeNull();
      // Manual reading provenance — no chat conversation/message.
      expect(e.conversationId).toBeNull();
      expect(e.messageId).toBeNull();
      expect(e.sourceSnapshot).toMatchObject({ kind: 'chunk', sourceId, sourceTitle: 'Cell Biology' });
    }
    await db.delete(sourcesTable).where(eq(sourcesTable.id, sourceId));
    const retained = await edgesFor(userId);
    expect(retained.map(edge => edge.sourceSnapshot)).toEqual(edges.map(edge => edge.sourceSnapshot));
    expect(retained.every(edge => edge.sourceId === null && edge.sourceChunkId === null)).toBe(true);
  });

  test('page-matched chunks capped at CARD_SOURCE_LINK_CAP', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const cap = env.ai.CARD_SOURCE_LINK_CAP;
    // (cap + 3) chunks all on page 5 — only `cap` of them become edges.
    const chunks = Array.from({ length: cap + 3 }, (_, i) => ({ text: `chunk ${i}`, page: 5 }));
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Big', chunks);

    const res = await quickCard(cookie, sourceId, { deckId, front: 'Q', back: 'A', page: 5 });
    expect(res.status).toBe(200);
    const edges = await edgesFor(userId);
    expect(edges.length).toBe(cap);
    // All capped edges are real chunk links (non-null chunk id).
    expect(edges.every((e) => e.sourceChunkId !== null)).toBe(true);
  });

  test('NO page / no page-match → exactly ONE fallback edge with NULL sourceChunkId', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    // A source with chunks on page 1; the card is created with NO page → fallback.
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [
      { text: 'page one chunk', page: 1 },
    ]);

    const res = await quickCard(cookie, sourceId, { deckId, front: 'Q', back: 'A' });
    expect(res.status).toBe(200);
    const { cardIds } = await res.json<{ cardIds: string[] }>();

    const edges = await edgesFor(userId);
    expect(edges.length).toBe(1);
    expect(edges[0]!.sourceChunkId).toBeNull(); // fallback edge
    expect(edges[0]!.cardId).toBe(cardIds[0]);
    expect(edges[0]!.sourceId).toBe(sourceId);
    // Quick-card provenance is reading-born → notebookId is always NULL.
    expect(edges[0]!.notebookId).toBeNull();
  });

  test('page given but no chunk on that page → ONE fallback edge (NULL chunk)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    // Chunks only on page 1; the card is from page 9 (no chunk there) → fallback.
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [
      { text: 'page one chunk', page: 1 },
    ]);

    const res = await quickCard(cookie, sourceId, { deckId, front: 'Q', back: 'A', page: 9 });
    expect(res.status).toBe(200);
    const edges = await edgesFor(userId);
    expect(edges.length).toBe(1);
    expect(edges[0]!.sourceChunkId).toBeNull();
  });

  test('two quick-cards from the same source each get their OWN edge (per-card)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId, chunkIds } = await seedSourceWithChunks(userId, notebookId, 'Doc', [
      { text: 'page one chunk', page: 1 },
    ]);

    // Card A: page-matched (one edge to chunk 0). Card B: no page (one fallback).
    const a = await quickCard(cookie, sourceId, { deckId, front: 'A?', back: 'a', page: 1 });
    const b = await quickCard(cookie, sourceId, { deckId, front: 'B?', back: 'b' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const aCard = (await a.json<{ cardIds: string[] }>()).cardIds[0]!;
    const bCard = (await b.json<{ cardIds: string[] }>()).cardIds[0]!;

    const edges = await edgesFor(userId);
    expect(edges.length).toBe(2); // one per card, no dedup across cards
    const byCard = new Map(edges.map((e) => [e.cardId, e]));
    expect(byCard.get(aCard)!.sourceChunkId).toBe(chunkIds[0]); // page-matched
    expect(byCard.get(bCard)!.sourceChunkId).toBeNull(); // fallback
  });

  test('the created card is visible via GET /cards/:id/sources', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Bio');
    const deckId = await freshDeck(cookie);
    const { sourceId, chunkIds } = await seedSourceWithChunks(userId, notebookId, 'Cell Biology', [
      { text: 'page three chunk', page: 3 },
    ]);

    const res = await quickCard(cookie, sourceId, { deckId, front: 'Q', back: 'A', page: 3 });
    const cardId = (await res.json<{ cardIds: string[] }>()).cardIds[0]!;

    const sourcesRes = await callApp(app, 'GET', `/cards/${cardId}/sources`, { cookie });
    expect(sourcesRes.status).toBe(200);
    const { items } = await sourcesRes.json<{
      items: { sourceChunkId: string | null; sourceId: string | null; notebookId: string | null; sourceTitle: string | null }[];
    }>();
    expect(items.length).toBe(1);
    expect(items[0]!.sourceChunkId).toBe(chunkIds[0]);
    expect(items[0]!.sourceId).toBe(sourceId);
    // Quick-card provenance is reading-born → notebookId is always NULL.
    expect(items[0]!.notebookId).toBeNull();
    expect(items[0]!.sourceTitle).toBe('Cell Biology');
  });
});

// ── quick-card: card MARKER (S1 / M5.1) ──────────────────────────────────────

describe('POST /sources/:id/quick-card — card marker (rects)', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  const rect = (over: Partial<MarkRect> = {}): MarkRect => ({ x: 0.1, y: 0.2, w: 0.3, h: 0.04, ...over });

  test('rects + page → a kind:"card" marker row anchored to the card; response carries markId', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 3 }]);

    const res = await quickCard(cookie, sourceId, {
      deckId,
      front: 'What is X?',
      back: 'X is the answer to study.',
      page: 3,
      rects: [rect(), rect({ y: 0.3 })],
    });
    expect(res.status).toBe(200);
    const { cardIds, markId } = await res.json<{ cardIds: string[]; markId?: string }>();
    expect(markId).toBeTruthy();

    // The marker row: kind 'card', anchored to the first card, quote = the Back
    // excerpt (capped 300), rects persisted, color lime, on the right page.
    const [marker] = await db
      .select()
      .from(sourceMarksTable)
      .where(eq(sourceMarksTable.id, markId!));
    expect(marker!.kind).toBe('card');
    expect(marker!.cardId).toBe(cardIds[0]!);
    expect(marker!.sourceId).toBe(sourceId);
    expect(marker!.page).toBe(3);
    expect(marker!.color).toBe('lime');
    expect(marker!.quote).toBe('X is the answer to study.');
    expect((marker!.rects as MarkRect[]).length).toBe(2);
  });

  test('no rects → no marker (graceful); response has no markId', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    const res = await quickCard(cookie, sourceId, { deckId, front: 'Q', back: 'A', page: 1 });
    expect(res.status).toBe(200);
    const { markId } = await res.json<{ markId?: string }>();
    expect(markId).toBeUndefined();
    const rows = await db
      .select()
      .from(sourceMarksTable)
      .where(eq(sourceMarksTable.sourceId, sourceId));
    expect(rows.length).toBe(0);
  });

  test('rects WITHOUT a page → no marker (both are required)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    const res = await quickCard(cookie, sourceId, { deckId, front: 'Q', back: 'A', rects: [rect()] });
    expect(res.status).toBe(200);
    const { markId } = await res.json<{ markId?: string }>();
    expect(markId).toBeUndefined();
    const rows = await db
      .select()
      .from(sourceMarksTable)
      .where(eq(sourceMarksTable.sourceId, sourceId));
    expect(rows.length).toBe(0);
  });

  test('bad rect geometry → 400 invalid_mark, no card/marker created', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    // x = 5.0 is a gross overflow (beyond the clamp band) → reject.
    const res = await quickCard(cookie, sourceId, {
      deckId,
      front: 'Q',
      back: 'A',
      page: 1,
      rects: [rect({ x: 5.0 })],
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_mark');
    expect((await db.select().from(cardsTable).where(eq(cardsTable.userId, userId))).length).toBe(0);
    expect(
      (await db.select().from(sourceMarksTable).where(eq(sourceMarksTable.sourceId, sourceId))).length,
    ).toBe(0);
  });

  test('the marker CASCADEs when its card is deleted', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 2 }]);

    const res = await quickCard(cookie, sourceId, {
      deckId,
      front: 'Q',
      back: 'A',
      page: 2,
      rects: [rect()],
    });
    const { cardIds, markId } = await res.json<{ cardIds: string[]; markId?: string }>();
    expect(markId).toBeTruthy();

    // Delete the card → the marker dies with it (ON DELETE CASCADE).
    await db.delete(cardsTable).where(eq(cardsTable.id, cardIds[0]!));
    const rows = await db
      .select()
      .from(sourceMarksTable)
      .where(eq(sourceMarksTable.id, markId!));
    expect(rows.length).toBe(0);
  });
});

// ── quick-card: error boundaries ─────────────────────────────────────────────

describe('POST /sources/:id/quick-card — error boundaries', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('a foreign deckId → a clean 4xx (not 500), no card/edge created', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const notebookId = await freshNotebook(a.userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(a.userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    // A deck owned by B — A cannot create a card into it.
    const foreignDeck = await freshDeck(b.cookie, 'B deck');

    const res = await quickCard(a.cookie, sourceId, { deckId: foreignDeck, front: 'Q', back: 'A', page: 1 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500); // a clean error, never a 500

    // No card or edge was created for A.
    expect((await db.select().from(cardsTable).where(eq(cardsTable.userId, a.userId))).length).toBe(0);
    expect((await edgesFor(a.userId)).length).toBe(0);
  });

  test('a foreign source → 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckId = await freshDeck(a.cookie);
    // B owns the source.
    const notebookId = await freshNotebook(b.userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(b.userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    const res = await quickCard(a.cookie, sourceId, { deckId, front: 'Q', back: 'A', page: 1 });
    expect(res.status).toBe(404);
    expect((await res.json<{ error: string }>()).error).toBe('not_found');
  });

  test('missing front → 400 (route schema requires a non-empty front)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    // No front at all.
    const noFront = await quickCard(cookie, sourceId, { deckId, back: 'A', page: 1 });
    expect(noFront.status).toBe(400);

    // Empty front (minLength: 1).
    const emptyFront = await quickCard(cookie, sourceId, { deckId, front: '', back: 'A', page: 1 });
    expect(emptyFront.status).toBe(400);
  });
});

// ── suggest-card (AI formulate) ──────────────────────────────────────────────

describe('POST /sources/:id/suggest-card — AI formulate', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('fenced JSON completion → parsed { front, back }', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    // The model wraps JSON in a ```json fence + prose — the defensive parser strips it.
    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async () =>
        'Here is your card:\n```json\n{"front": "What converts light to energy?", "back": "Photosynthesis"}\n```',
    });

    const res = await suggestCard(cookie, sourceId, { quote: 'photosynthesis converts light to chemical energy', page: 1 });
    expect(res.status).toBe(200);
    const body = await res.json<{ front: string; back: string }>();
    expect(body.front).toBe('What converts light to energy?');
    expect(body.back).toBe('Photosynthesis');
  });

  test('chat disabled → 503 ai_disabled (pre-flush, no source lookup)', async () => {
    // No chat surface injected → isChatEnabled() stays false.
    __setAiClientForTests({ embed: async (t) => t.map(() => []) });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    const res = await suggestCard(cookie, sourceId, { quote: 'some excerpt', page: 1 });
    expect(res.status).toBe(503);
    expect((await res.json<{ error: string }>()).error).toBe('ai_disabled');
  });

  test('garbage completion (no parseable JSON) → 502 suggest_failed', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async () => 'I cannot make a card from this text, sorry.',
    });

    const res = await suggestCard(cookie, sourceId, { quote: 'unintelligible', page: 1 });
    expect(res.status).toBe(502);
    expect((await res.json<{ error: string }>()).error).toBe('suggest_failed');
  });

  test('a throwing complete() → 502 suggest_failed (never a 500)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async () => {
        throw new Error('gateway_down');
      },
    });

    const res = await suggestCard(cookie, sourceId, { quote: 'excerpt', page: 1 });
    expect(res.status).toBe(502);
    expect((await res.json<{ error: string }>()).error).toBe('suggest_failed');
  });

  test('a foreign source (chat enabled) → 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const notebookId = await freshNotebook(b.userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(b.userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async () => '{"front":"x","back":"y"}',
    });

    const res = await suggestCard(a.cookie, sourceId, { quote: 'excerpt', page: 1 });
    expect(res.status).toBe(404);
  });

  test('locale rides into the prompt: "ru" → Russian, "en" → English, absent → Russian (default)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    // Capture the system prompt the route hands to complete().
    let lastSystem = '';
    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async (msgs) => {
        lastSystem = msgs.find((m) => m.role === 'system')?.content ?? '';
        return '{"front":"Q","back":"A"}';
      },
    });

    // locale: 'ru' → the prompt asks for Russian.
    expect((await suggestCard(cookie, sourceId, { quote: 'excerpt', locale: 'ru' })).status).toBe(200);
    expect(lastSystem).toContain('Russian');
    expect(lastSystem).not.toContain('English');

    // locale: 'en' → English.
    expect((await suggestCard(cookie, sourceId, { quote: 'excerpt', locale: 'en' })).status).toBe(200);
    expect(lastSystem).toContain('English');
    expect(lastSystem).not.toContain('Russian');

    // absent → defaults to Russian (the n=1 RU-primary app default).
    expect((await suggestCard(cookie, sourceId, { quote: 'excerpt' })).status).toBe(200);
    expect(lastSystem).toContain('Russian');
  });
});
