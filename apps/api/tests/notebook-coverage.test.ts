// «Блокноты 2.0» N3 — card-coverage of a notebook's sources (Р9). SQL-only.
//
// CONTRACT (read from modules/notebooks.ts GET /notebooks/:id/coverage):
//   * Per ATTACHED source: totalChunks (COUNT source_chunks), coveredChunks
//     (DISTINCT chunk with a LIVE card edge — the JOIN on `cards` drops
//     tombstones/deleted cards), cardCount (DISTINCT live card_id with provenance
//     on the source's chunks), pct.
//   * A DELETED card stops contributing (its card_sources edge cascades; even a
//     SET-NULL tombstone is excluded by the cards JOIN) → pct drops.
//   * gaps: top-5 headings with the most UNCOVERED chunks; NULL heading → null.
//   * An empty source (0 chunks) → pct 0 with no division-by-zero.
//   * Aggregate over the notebook. Foreign notebook → 404.
//
// Cards + provenance edges inserted directly via db (mirrors card-provenance.test.ts).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  cardSources as cardSourcesTable,
  cards as cardsTable,
  db,
  ensureBuiltins,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  sourceChunks as sourceChunksTable,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db.insert(notebooksTable).values({ userId, title }).returning({ id: notebooksTable.id });
  return nb!.id;
}

async function freshDeck(cookie: string, name = 'Deck'): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name } });
  return (await res.json<{ id: string }>()).id;
}

/** Seed an attached source with N chunks (optional headings). Returns chunk ids. */
async function seedSource(
  userId: string,
  notebookId: string,
  title: string,
  chunks: { text: string; heading?: string }[],
): Promise<{ sourceId: string; chunkIds: string[] }> {
  const [src] = await db
    .insert(sourcesTable)
    .values({ userId, kind: 'pdf', title, status: 'ready', verified: true, chunkCount: chunks.length })
    .returning({ id: sourcesTable.id });
  const sourceId = src!.id;
  await db.insert(notebookSourcesTable).values({ userId, notebookId, sourceId });
  const chunkIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const [sc] = await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId, position: i, text: chunks[i]!.text, heading: chunks[i]!.heading, embedded: true })
      .returning({ id: sourceChunksTable.id });
    chunkIds.push(sc!.id);
  }
  return { sourceId, chunkIds };
}

/** Link a card to a source chunk (one provenance edge). */
async function linkCard(
  userId: string,
  cardId: string,
  sourceId: string,
  notebookId: string,
  sourceChunkId: string,
): Promise<void> {
  await db.insert(cardSourcesTable).values({ userId, cardId, sourceId, notebookId, sourceChunkId });
}

interface CoverageResp {
  items: { sourceId: string; title: string; totalChunks: number; coveredChunks: number; cardCount: number; pct: number }[];
  aggregate: { totalChunks: number; coveredChunks: number; cardCount: number; pct: number };
  gaps: { sourceId: string; sourceTitle: string; heading: string | null; uncovered: number }[];
}

async function getCoverage(cookie: string, nb: string): Promise<{ status: number; body: CoverageResp }> {
  const res = await callApp(app, 'GET', `/notebooks/${nb}/coverage`, { cookie });
  return { status: res.status, body: await res.json<CoverageResp>() };
}

describe('coverage — basic counting', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
  });

  test('covered chunks + cardCount + pct over a source', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const deckId = await freshDeck(cookie);
    const { sourceId, chunkIds } = await seedSource(userId, nb, 'Doc', [
      { text: 'c0' }, { text: 'c1' }, { text: 'c2' }, { text: 'c3' },
    ]);

    // Two cards covering chunk0 and chunk1 (chunk2/3 uncovered) → pct 50%.
    const card1 = await seedBasicCard(app, cookie, { deckId, front: 'Q1' });
    const card2 = await seedBasicCard(app, cookie, { deckId, front: 'Q2' });
    await linkCard(userId, card1.id, sourceId, nb, chunkIds[0]!);
    await linkCard(userId, card2.id, sourceId, nb, chunkIds[1]!);

    const { status, body } = await getCoverage(cookie, nb);
    expect(status).toBe(200);
    expect(body.items.length).toBe(1);
    const item = body.items[0]!;
    expect(item.totalChunks).toBe(4);
    expect(item.coveredChunks).toBe(2);
    expect(item.cardCount).toBe(2);
    expect(item.pct).toBe(50);
    // Aggregate mirrors the single source.
    expect(body.aggregate).toEqual({ totalChunks: 4, coveredChunks: 2, cardCount: 2, pct: 50 });
  });

  test('two cards on the SAME chunk → coveredChunks 1, cardCount 2', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const deckId = await freshDeck(cookie);
    const { sourceId, chunkIds } = await seedSource(userId, nb, 'Doc', [{ text: 'c0' }, { text: 'c1' }]);

    const card1 = await seedBasicCard(app, cookie, { deckId, front: 'Q1' });
    const card2 = await seedBasicCard(app, cookie, { deckId, front: 'Q2' });
    await linkCard(userId, card1.id, sourceId, nb, chunkIds[0]!);
    await linkCard(userId, card2.id, sourceId, nb, chunkIds[0]!);

    const { body } = await getCoverage(cookie, nb);
    const item = body.items[0]!;
    expect(item.coveredChunks).toBe(1);
    expect(item.cardCount).toBe(2);
    expect(item.pct).toBe(50);
  });
});

describe('coverage — tombstone filtering', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
  });

  test('a DELETED card no longer counts (pct drops)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const deckId = await freshDeck(cookie);
    const { sourceId, chunkIds } = await seedSource(userId, nb, 'Doc', [{ text: 'c0' }, { text: 'c1' }]);

    const card1 = await seedBasicCard(app, cookie, { deckId, front: 'Q1' });
    const card2 = await seedBasicCard(app, cookie, { deckId, front: 'Q2' });
    await linkCard(userId, card1.id, sourceId, nb, chunkIds[0]!);
    await linkCard(userId, card2.id, sourceId, nb, chunkIds[1]!);

    // Both covered first.
    let cov = await getCoverage(cookie, nb);
    expect(cov.body.items[0]!.coveredChunks).toBe(2);
    expect(cov.body.items[0]!.pct).toBe(100);

    // Delete card2's NOTE row → the card cascades; its card_sources edge cascades
    // too (card_id is NOT NULL → ON DELETE CASCADE). The cards JOIN drops it → coverage 1.
    await db.delete(cardsTable).where(eq(cardsTable.id, card2.id));

    cov = await getCoverage(cookie, nb);
    expect(cov.body.items[0]!.coveredChunks).toBe(1);
    expect(cov.body.items[0]!.cardCount).toBe(1);
    expect(cov.body.items[0]!.pct).toBe(50);
  });
});

describe('coverage — gaps + empty + foreign', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
  });

  test('gaps rank headings by uncovered-chunk count; NULL heading → null', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const deckId = await freshDeck(cookie);
    // Heading "Intro" (2 chunks), "Body" (3 chunks), NULL heading (1 chunk).
    const { sourceId, chunkIds } = await seedSource(userId, nb, 'Doc', [
      { text: 'i0', heading: 'Intro' },
      { text: 'i1', heading: 'Intro' },
      { text: 'b0', heading: 'Body' },
      { text: 'b1', heading: 'Body' },
      { text: 'b2', heading: 'Body' },
      { text: 'x0' }, // NULL heading
    ]);

    // Cover ONE Intro chunk → Intro has 1 uncovered, Body 3 uncovered, NULL 1.
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Q' });
    await linkCard(userId, card.id, sourceId, nb, chunkIds[0]!);

    const { body } = await getCoverage(cookie, nb);
    // Top gap is Body (3 uncovered).
    expect(body.gaps[0]!.heading).toBe('Body');
    expect(body.gaps[0]!.uncovered).toBe(3);
    // A NULL-heading bucket is rendered as null.
    const nullGap = body.gaps.find((g) => g.heading === null);
    expect(nullGap).toBeTruthy();
    expect(nullGap!.uncovered).toBe(1);
    // The covered Intro chunk reduces Intro's uncovered to 1.
    const introGap = body.gaps.find((g) => g.heading === 'Intro');
    expect(introGap!.uncovered).toBe(1);
  });

  test('an empty source (0 chunks) → pct 0, no crash', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    await seedSource(userId, nb, 'Empty', []); // no chunks

    const { status, body } = await getCoverage(cookie, nb);
    expect(status).toBe(200);
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.totalChunks).toBe(0);
    expect(body.items[0]!.pct).toBe(0);
    expect(body.aggregate.pct).toBe(0);
  });

  test('a notebook with no attached sources → empty coverage', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { status, body } = await getCoverage(cookie, nb);
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.aggregate).toEqual({ totalChunks: 0, coveredChunks: 0, cardCount: 0, pct: 0 });
    expect(body.gaps).toEqual([]);
  });

  test('foreign notebook ⇒ 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(a.userId);
    const res = await callApp(app, 'GET', `/notebooks/${nb}/coverage`, { cookie: b.cookie });
    expect(res.status).toBe(404);
  });
});
