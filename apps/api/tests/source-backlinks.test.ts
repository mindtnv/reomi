// NotebookLM M3 — backlink routes + cascade/tombstone integration tests.
//
// CONTRACT (read from cards.ts GET /cards/:id/sources + notebooks.ts
// GET /sources/:id/cards + the card_sources schema cascade asymmetry, NOT invented):
//   * GET /cards/:id/sources — ownership 404; rows carry joined sourceTitle/
//     notebookTitle/position/page/snippet (≤240); empty ⇒ { items: [] }.
//   * GET /sources/:id/cards — ownership 404; DISTINCT cards + deckName + a front
//     excerpt + link count; empty ⇒ { items: [] }.
//   * Cascade asymmetry (AC3.3 — the only place a referencing row survives its
//     referent): delete SOURCE → the card_sources edge SURVIVES as a tombstone
//     (sourceChunkId/sourceId SET NULL) and the CARD is intact; the backlink
//     route renders the tombstone. Delete NOTEBOOK (library refactor Р3) → its
//     conversations cascade away and card_sources.notebookId/conversationId go
//     NULL, but the SOURCE + its chunk are PRESERVED (library-owned) so the edge's
//     sourceId/sourceChunkId stay live; the card is intact. Delete CARD → its
//     edges are gone (the card side cascades).
//
// Edges are inserted DIRECTLY via db (full control over the provenance chain +
// the cascade scenarios) over API-seeded cards. The card_provenance.test.ts suite
// covers the agent-driven write of these edges end-to-end; here we exercise the
// READ routes + the FK cascade semantics in isolation.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  cardSources as cardSourcesTable,
  cards as cardsTable,
  conversations as conversationsTable,
  db,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  sourceChunks as sourceChunksTable,
  sources as sourcesTable,
} from '@reomi/db';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// ── Fixture helpers ────────────────────────────────────────────────────────────

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

async function seedSource(
  userId: string,
  notebookId: string,
  title: string,
  chunks: { text: string; page?: number; heading?: string }[],
): Promise<{ sourceId: string; chunkIds: string[] }> {
  const [src] = await db
    .insert(sourcesTable)
    .values({
      userId,
      kind: 'text',
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
      .values({
        userId,
        sourceId,
        position: i,
        text: c.text,
        page: c.page,
        heading: c.heading,
        embedded: true,
      })
      .returning({ id: sourceChunksTable.id });
    chunkIds.push(sc!.id);
  }
  return { sourceId, chunkIds };
}

async function freshConversation(userId: string, notebookId: string): Promise<string> {
  const [conv] = await db
    .insert(conversationsTable)
    .values({ userId, notebookId, title: 'T' })
    .returning({ id: conversationsTable.id });
  return conv!.id;
}

/** Insert a card_sources edge directly (the M3 provenance writer's row shape). */
async function linkEdge(opts: {
  userId: string;
  cardId: string;
  sourceChunkId: string;
  sourceId: string;
  notebookId: string;
  conversationId: string;
}): Promise<string> {
  const [row] = await db
    .insert(cardSourcesTable)
    .values({
      userId: opts.userId,
      cardId: opts.cardId,
      sourceChunkId: opts.sourceChunkId,
      sourceId: opts.sourceId,
      notebookId: opts.notebookId,
      conversationId: opts.conversationId,
      messageId: null,
    })
    .returning({ id: cardSourcesTable.id });
  return row!.id;
}

async function freshDeck(cookie: string, name = 'Deck'): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name } });
  return (await res.json<{ id: string }>()).id;
}

describe('backlinks — GET /cards/:id/sources', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {});

  test('renders rows with joined sourceTitle/notebookTitle/position/page/snippet', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Biology');
    const deckId = await freshDeck(cookie);
    const { sourceId, chunkIds } = await seedSource(userId, notebookId, 'Cell Notes', [
      { text: 'A passage about the mitochondria and ATP synthesis.', page: 12, heading: 'Chapter 1' },
    ]);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'ATP?', back: 'Mitochondria' });
    const convId = await freshConversation(userId, notebookId);
    await linkEdge({
      userId,
      cardId: card.id,
      sourceChunkId: chunkIds[0]!,
      sourceId,
      notebookId,
      conversationId: convId,
    });

    const res = await callApp(app, 'GET', `/cards/${card.id}/sources`, { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{
      items: {
        sourceChunkId: string | null;
        sourceId: string | null;
        notebookId: string | null;
        sourceTitle: string | null;
        notebookTitle: string | null;
        position: number | null;
        page: number | null;
        heading: string | null;
        snippet: string | null;
      }[];
    }>();
    expect(body.items.length).toBe(1);
    const item = body.items[0]!;
    expect(item.sourceChunkId).toBe(chunkIds[0]!);
    expect(item.sourceId).toBe(sourceId);
    expect(item.notebookId).toBe(notebookId);
    expect(item.sourceTitle).toBe('Cell Notes');
    expect(item.notebookTitle).toBe('Biology');
    expect(item.position).toBe(0);
    expect(item.page).toBe(12);
    expect(item.heading).toBe('Chapter 1');
    expect(item.snippet).toBe('A passage about the mitochondria and ATP synthesis.');
  });

  test('snippet is capped to 240 chars', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId);
    const deckId = await freshDeck(cookie);
    const longText = 'x'.repeat(500);
    const { sourceId, chunkIds } = await seedSource(userId, notebookId, 'Doc', [{ text: longText }]);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Q', back: 'A' });
    const convId = await freshConversation(userId, notebookId);
    await linkEdge({
      userId,
      cardId: card.id,
      sourceChunkId: chunkIds[0]!,
      sourceId,
      notebookId,
      conversationId: convId,
    });

    const res = await callApp(app, 'GET', `/cards/${card.id}/sources`, { cookie });
    const body = await res.json<{ items: { snippet: string | null }[] }>();
    expect(body.items[0]!.snippet!.length).toBe(240);
  });

  test('404 for a foreign card; { items: [] } when there are no edges', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Q', back: 'A' });

    // No edges → empty list (200).
    const empty = await callApp(app, 'GET', `/cards/${card.id}/sources`, { cookie });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [] });

    // Foreign card → 404.
    const other = await signUpAndCookie(app, uniqueEmail('b'));
    const foreign = await callApp(app, 'GET', `/cards/${card.id}/sources`, { cookie: other.cookie });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'not_found' });

    // userId referenced (lint: keep the destructure meaningful).
    expect(typeof userId).toBe('string');
  });
});

describe('backlinks — GET /sources/:id/cards', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {});

  test('returns distinct cards with deckName + front excerpt + link count', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId);
    const deckId = await freshDeck(cookie, 'German');
    const { sourceId, chunkIds } = await seedSource(userId, notebookId, 'Doc', [
      { text: 'chunk zero' },
      { text: 'chunk one' },
    ]);
    const cardA = await seedBasicCard(app, cookie, { deckId, front: 'Front A', back: 'Back A' });
    const cardB = await seedBasicCard(app, cookie, { deckId, front: 'Front B', back: 'Back B' });
    const convId = await freshConversation(userId, notebookId);

    // cardA linked to BOTH chunks (2 edges → count 2, ONE distinct card row);
    // cardB linked to one chunk.
    await linkEdge({ userId, cardId: cardA.id, sourceChunkId: chunkIds[0]!, sourceId, notebookId, conversationId: convId });
    await linkEdge({ userId, cardId: cardA.id, sourceChunkId: chunkIds[1]!, sourceId, notebookId, conversationId: convId });
    await linkEdge({ userId, cardId: cardB.id, sourceChunkId: chunkIds[0]!, sourceId, notebookId, conversationId: convId });

    const res = await callApp(app, 'GET', `/sources/${sourceId}/cards`, { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{
      items: { cardId: string; front: string; deckId: string; deckName: string | null; count: number }[];
    }>();
    // Two DISTINCT cards (cardA appears ONCE despite two edges).
    expect(body.items.length).toBe(2);
    const byCard = new Map(body.items.map((i) => [i.cardId, i]));
    expect(byCard.get(cardA.id)!.count).toBe(2);
    expect(byCard.get(cardA.id)!.front).toBe('Front A');
    expect(byCard.get(cardA.id)!.deckName).toBe('German');
    expect(byCard.get(cardB.id)!.count).toBe(1);
  });

  test('404 for a foreign source; { items: [] } when no cards link to it', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, notebookId, 'Doc', [{ text: 'lonely chunk' }]);

    const empty = await callApp(app, 'GET', `/sources/${sourceId}/cards`, { cookie });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [] });

    const other = await signUpAndCookie(app, uniqueEmail('b'));
    const foreign = await callApp(app, 'GET', `/sources/${sourceId}/cards`, { cookie: other.cookie });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'not_found' });
  });
});

describe('backlinks — cascade asymmetry (AC3.3)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {});

  test('delete SOURCE → card_sources edge survives as a tombstone (chunk/source NULL); card intact; backlink renders the tombstone', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Notebook');
    const deckId = await freshDeck(cookie);
    const { sourceId, chunkIds } = await seedSource(userId, notebookId, 'To Delete', [
      { text: 'doomed passage', page: 5 },
    ]);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Survivor Q', back: 'A' });
    const convId = await freshConversation(userId, notebookId);
    const edgeId = await linkEdge({
      userId,
      cardId: card.id,
      sourceChunkId: chunkIds[0]!,
      sourceId,
      notebookId,
      conversationId: convId,
    });

    // Delete the source via the real route (soft-delete + cleanup).
    const del = await callApp(app, 'DELETE', `/sources/${sourceId}`, { cookie });
    expect(del.status).toBe(200);

    // The edge ROW survives — sourceChunkId + sourceId SET NULL (tombstone).
    const [edge] = await db.select().from(cardSourcesTable).where(eq(cardSourcesTable.id, edgeId));
    expect(edge).toBeTruthy();
    expect(edge!.sourceChunkId).toBeNull();
    expect(edge!.sourceId).toBeNull();
    // The notebook side is still intact (only the source was deleted).
    expect(edge!.notebookId).toBe(notebookId);
    expect(edge!.cardId).toBe(card.id);

    // The CARD is fully intact.
    const [stillCard] = await db.select().from(cardsTable).where(eq(cardsTable.id, card.id));
    expect(stillCard).toBeTruthy();
    expect(stillCard!.renderFrontText).toBe('Survivor Q');

    // The backlink route returns the tombstone row (null source fields, snippet null).
    const res = await callApp(app, 'GET', `/cards/${card.id}/sources`, { cookie });
    const body = await res.json<{
      items: { sourceChunkId: string | null; sourceId: string | null; sourceTitle: string | null; snippet: string | null }[];
    }>();
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.sourceChunkId).toBeNull();
    expect(body.items[0]!.sourceId).toBeNull();
    expect(body.items[0]!.sourceTitle).toBeNull();
    expect(body.items[0]!.snippet).toBeNull();
  });

  test('delete NOTEBOOK → conversation and source survive; only notebook links detach', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Notebook');
    const deckId = await freshDeck(cookie);
    const { sourceId, chunkIds } = await seedSource(userId, notebookId, 'Src', [{ text: 'p' }]);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Q', back: 'A' });
    const convId = await freshConversation(userId, notebookId);
    const edgeId = await linkEdge({
      userId,
      cardId: card.id,
      sourceChunkId: chunkIds[0]!,
      sourceId,
      notebookId,
      conversationId: convId,
    });

    // Delete the notebook through the real route; owned source work and chat history survive.
    const del = await callApp(app, 'DELETE', `/notebooks/${notebookId}`, { cookie });
    expect(del.status).toBe(200);

    // The conversation retains its identity with a detached notebook binding.
    const conv = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, convId));
    expect(conv.length).toBe(1);
    expect(conv[0]!.notebookId).toBeNull();

    // The SOURCE + its CHUNK survive (they're library-owned now).
    expect(
      (await db.select().from(sourcesTable).where(eq(sourcesTable.id, sourceId))).length,
    ).toBe(1);
    expect(
      (await db.select().from(sourceChunksTable).where(eq(sourceChunksTable.id, chunkIds[0]!))).length,
    ).toBe(1);

    // Only notebook ownership detaches; conversation and source references remain.
    const [edge] = await db.select().from(cardSourcesTable).where(eq(cardSourcesTable.id, edgeId));
    expect(edge).toBeTruthy();
    expect(edge!.notebookId).toBeNull();
    expect(edge!.conversationId).toBe(convId);
    expect(edge!.sourceId).toBe(sourceId);
    expect(edge!.sourceChunkId).toBe(chunkIds[0]!);
    expect(edge!.cardId).toBe(card.id);

    // The CARD survives (nothing is lost).
    const [stillCard] = await db.select().from(cardsTable).where(eq(cardsTable.id, card.id));
    expect(stillCard).toBeTruthy();
  });

  test('delete CARD → its provenance edges are gone (the card side cascades)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId);
    const deckId = await freshDeck(cookie);
    const { sourceId, chunkIds } = await seedSource(userId, notebookId, 'Src', [{ text: 'p' }]);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Q', back: 'A' });
    const convId = await freshConversation(userId, notebookId);
    await linkEdge({
      userId,
      cardId: card.id,
      sourceChunkId: chunkIds[0]!,
      sourceId,
      notebookId,
      conversationId: convId,
    });

    // Sanity: one edge exists.
    expect(
      (await db.select().from(cardSourcesTable).where(eq(cardSourcesTable.cardId, card.id))).length,
    ).toBe(1);

    // Delete the card via the real route.
    const del = await callApp(app, 'DELETE', `/cards/${card.id}`, { cookie });
    expect(del.status).toBe(200);

    // The edge is GONE (card side cascades).
    expect(
      (await db.select().from(cardSourcesTable).where(and(eq(cardSourcesTable.userId, userId), eq(cardSourcesTable.cardId, card.id)))).length,
    ).toBe(0);
    // The source + its chunk are untouched (only the card was deleted).
    const [stillSource] = await db.select().from(sourcesTable).where(eq(sourcesTable.id, sourceId));
    expect(stillSource).toBeTruthy();
  });
});
