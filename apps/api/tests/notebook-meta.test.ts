// «Блокноты 2.0» N1 — notebook metadata (PATCH explicit map) + grid list
// (counts, archived filter, pinned-first sort). Pure route tests via
// `app.handle`. We assert:
//   * PATCH maps each field (title/emoji/color/description/pinned/archived),
//     ignores unknown fields, validates lengths + color palette, 400 on empty.
//   * pinned/archived toggles do NOT bump updatedAt; title DOES (Р15).
//   * GET list: pinned-first sort, archived filter (default hides archived),
//     one-query counts (sourceCount/noteCount/cardCount; cardCount LIVE only).
//   * foreign notebook id → 404.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  cardSources,
  db,
  notebookArtifacts as notebookArtifactsTable,
  notebookNotes,
  notebooks,
  notebookSources,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { __resetAiClientForTests } from '../src/ai/openai-client.ts';
import {
  callApp,
  resetTestDb,
  seedBasicCard,
  signUpAndCookie,
  uniqueEmail,
} from './helpers.ts';

const app = buildApp();

interface NotebookRow {
  id: string;
  title: string;
  emoji: string | null;
  color: string | null;
  description: string | null;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
}

async function createNotebook(cookie: string, title = 'NB'): Promise<NotebookRow> {
  const res = await callApp(app, 'POST', '/notebooks', { cookie, body: { title } });
  expect(res.status).toBe(200);
  return res.json<NotebookRow>();
}

describe('notebook metadata PATCH (Р13)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('maps every field; ignores unknown fields', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const res = await callApp(app, 'PATCH', `/notebooks/${nb.id}`, {
      cookie,
      body: {
        title: 'Cell Biology',
        emoji: '🧬',
        color: 'violet',
        description: 'A study notebook.',
        pinned: true,
        archived: false,
        bogus: 'ignored', // unknown field — silently dropped by the explicit map
      },
    });
    expect(res.status).toBe(200);
    const row = await res.json<NotebookRow & { bogus?: unknown }>();
    expect(row.title).toBe('Cell Biology');
    expect(row.emoji).toBe('🧬');
    expect(row.color).toBe('violet');
    expect(row.description).toBe('A study notebook.');
    expect(row.pinned).toBe(true);
    expect(row).not.toHaveProperty('bogus');
  });

  test('null on emoji/color/description clears the field', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    await callApp(app, 'PATCH', `/notebooks/${nb.id}`, {
      cookie,
      body: { emoji: '📘', color: 'lime', description: 'x' },
    });
    const cleared = await callApp(app, 'PATCH', `/notebooks/${nb.id}`, {
      cookie,
      body: { emoji: null, color: null, description: null },
    });
    const row = await cleared.json<NotebookRow>();
    expect(row.emoji).toBeNull();
    expect(row.color).toBeNull();
    expect(row.description).toBeNull();
  });

  test('validations: bad color → 400; over-length description → 400; empty body → 400', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);

    const badColor = await callApp(app, 'PATCH', `/notebooks/${nb.id}`, {
      cookie,
      body: { color: 'chartreuse' },
    });
    expect(badColor.status).toBe(400);
    expect((await badColor.json<{ error: string }>()).error).toBe('invalid_color');

    const longDesc = await callApp(app, 'PATCH', `/notebooks/${nb.id}`, {
      cookie,
      body: { description: 'x'.repeat(501) },
    });
    expect(longDesc.status).toBe(400);
    expect((await longDesc.json<{ error: string }>()).error).toBe('invalid_description');

    const empty = await callApp(app, 'PATCH', `/notebooks/${nb.id}`, { cookie, body: {} });
    expect(empty.status).toBe(400);
    expect((await empty.json<{ error: string }>()).error).toBe('nothing_to_update');
  });

  test('pinned/archived toggles do NOT bump updatedAt; title DOES (Р15)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const before = (
      await db.select({ u: notebooks.updatedAt }).from(notebooks).where(eq(notebooks.id, nb.id))
    )[0]!.u;

    // Wait a tick so a real bump is observable.
    await new Promise((r) => setTimeout(r, 10));

    // pin → updatedAt unchanged.
    await callApp(app, 'PATCH', `/notebooks/${nb.id}`, { cookie, body: { pinned: true } });
    const afterPin = (
      await db.select({ u: notebooks.updatedAt }).from(notebooks).where(eq(notebooks.id, nb.id))
    )[0]!.u;
    expect(afterPin.getTime()).toBe(before.getTime());

    // archive → updatedAt still unchanged.
    await callApp(app, 'PATCH', `/notebooks/${nb.id}`, { cookie, body: { archived: true } });
    const afterArchive = (
      await db.select({ u: notebooks.updatedAt }).from(notebooks).where(eq(notebooks.id, nb.id))
    )[0]!.u;
    expect(afterArchive.getTime()).toBe(before.getTime());

    // title → updatedAt bumps.
    await callApp(app, 'PATCH', `/notebooks/${nb.id}`, { cookie, body: { title: 'Renamed' } });
    const afterTitle = (
      await db.select({ u: notebooks.updatedAt }).from(notebooks).where(eq(notebooks.id, nb.id))
    )[0]!.u;
    expect(afterTitle.getTime()).toBeGreaterThan(before.getTime());
  });

  test('foreign notebook → 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const nbB = await createNotebook(b.cookie);
    const res = await callApp(app, 'PATCH', `/notebooks/${nbB.id}`, {
      cookie: a.cookie,
      body: { title: 'hijack' },
    });
    expect(res.status).toBe(404);
  });

  test('attach bumps updatedAt; idempotent re-attach does NOT; detach bumps (Р15)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const [src] = await db
      .insert(sourcesTable)
      .values({ userId, kind: 'text' as const, title: 's1', status: 'ready' as const, verified: true })
      .returning({ id: sourcesTable.id });

    const readUpdatedAt = async () =>
      (
        await db.select({ u: notebooks.updatedAt }).from(notebooks).where(eq(notebooks.id, nb.id))
      )[0]!.u;

    const before = await readUpdatedAt();
    await new Promise((r) => setTimeout(r, 10));

    // First attach inserts a new edge → bump.
    const attach1 = await callApp(app, 'POST', `/notebooks/${nb.id}/sources/attach`, {
      cookie,
      body: { sourceIds: [src!.id] },
    });
    expect(attach1.status).toBe(200);
    expect((await attach1.json<{ attached: number }>()).attached).toBe(1);
    const afterAttach = await readUpdatedAt();
    expect(afterAttach.getTime()).toBeGreaterThan(before.getTime());

    await new Promise((r) => setTimeout(r, 10));

    // Idempotent re-attach of the SAME source inserts nothing → NO bump.
    const attach2 = await callApp(app, 'POST', `/notebooks/${nb.id}/sources/attach`, {
      cookie,
      body: { sourceIds: [src!.id] },
    });
    expect(attach2.status).toBe(200);
    expect((await attach2.json<{ attached: number }>()).attached).toBe(0);
    const afterReattach = await readUpdatedAt();
    expect(afterReattach.getTime()).toBe(afterAttach.getTime());

    await new Promise((r) => setTimeout(r, 10));

    // Detach removes a real edge → bump.
    const detach = await callApp(app, 'DELETE', `/notebooks/${nb.id}/sources/${src!.id}`, {
      cookie,
    });
    expect(detach.status).toBe(200);
    const afterDetach = await readUpdatedAt();
    expect(afterDetach.getTime()).toBeGreaterThan(afterReattach.getTime());
  });
});

describe('notebook grid list (Р13)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('pinned-first sort, then updatedAt DESC', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const a = await createNotebook(cookie, 'A');
    await new Promise((r) => setTimeout(r, 5));
    const b = await createNotebook(cookie, 'B');
    await new Promise((r) => setTimeout(r, 5));
    const c = await createNotebook(cookie, 'C');
    // Pin A (oldest) — it must jump to the top despite being least-recent.
    await callApp(app, 'PATCH', `/notebooks/${a.id}`, { cookie, body: { pinned: true } });

    const res = await callApp(app, 'GET', '/notebooks', { cookie });
    const { items } = await res.json<{ items: NotebookRow[] }>();
    expect(items.map((i) => i.id)).toEqual([a.id, c.id, b.id]);
  });

  test('archived filter: default hides archived; ?archived=true shows only archive', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const live = await createNotebook(cookie, 'Live');
    const arch = await createNotebook(cookie, 'Archived');
    await callApp(app, 'PATCH', `/notebooks/${arch.id}`, { cookie, body: { archived: true } });

    const def = await callApp(app, 'GET', '/notebooks', { cookie });
    const defItems = (await def.json<{ items: NotebookRow[] }>()).items;
    expect(defItems.map((i) => i.id)).toEqual([live.id]);

    const archived = await callApp(app, 'GET', '/notebooks?archived=true', { cookie });
    const archItems = (await archived.json<{ items: NotebookRow[] }>()).items;
    expect(archItems.map((i) => i.id)).toEqual([arch.id]);
  });

  test('counts in one query: sourceCount / noteCount / cardCount (LIVE cards only)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie, 'Counts');

    // Attach 2 sources.
    const seeded = await db
      .insert(sourcesTable)
      .values([
        { userId, kind: 'text' as const, title: 's1', status: 'ready' as const, verified: true },
        { userId, kind: 'text' as const, title: 's2', status: 'ready' as const, verified: true },
      ])
      .returning({ id: sourcesTable.id });
    await db
      .insert(notebookSources)
      .values(seeded.map((s) => ({ userId, notebookId: nb.id, sourceId: s.id })));

    // 3 notes.
    await db.insert(notebookNotes).values(
      [1, 2, 3].map((i) => ({
        userId,
        notebookId: nb.id,
        title: `note ${i}`,
        content: `body ${i}`,
      })),
    );

    // 2 cards born in this notebook (card_sources.notebook_id=nb), + a 3rd card
    // whose card gets DELETED → its card_sources row cascades, so it must NOT be
    // counted (cardCount JOINs cards = LIVE only).
    const deck = await (
      await callApp(app, 'POST', '/decks', { cookie, body: { name: 'D' } })
    ).json<{ id: string }>();
    const card1 = await seedBasicCard(app, cookie, { deckId: deck.id, front: 'q1' });
    const card2 = await seedBasicCard(app, cookie, { deckId: deck.id, front: 'q2' });
    const card3 = await seedBasicCard(app, cookie, { deckId: deck.id, front: 'q3' });
    await db.insert(cardSources).values([
      { userId, cardId: card1.id, sourceId: seeded[0]!.id, notebookId: nb.id },
      { userId, cardId: card2.id, sourceId: seeded[0]!.id, notebookId: nb.id },
      { userId, cardId: card3.id, sourceId: seeded[0]!.id, notebookId: nb.id },
    ]);
    // Delete card3 → its card_sources edge cascades (card FK), dropping it from cardCount.
    await callApp(app, 'DELETE', `/cards/${card3.id}`, { cookie });

    const res = await callApp(app, 'GET', '/notebooks', { cookie });
    const item = (await res.json<{ items: (NotebookRow & {
      sourceCount: number;
      noteCount: number;
      cardCount: number;
    })[] }>()).items.find((i) => i.id === nb.id)!;
    expect(item.sourceCount).toBe(2);
    expect(item.noteCount).toBe(3);
    expect(item.cardCount).toBe(2); // card3 deleted → not counted
  });

  test('detail GET returns current overview fingerprint', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const res = await callApp(app, 'GET', `/notebooks/${nb.id}`, { cookie });
    expect(res.status).toBe(200);
    const row = await res.json<{ currentFingerprint: string; overviewFingerprint: string | null }>();
    // No ready sources ⇒ the sentinel.
    expect(row.currentFingerprint).toBe('empty');
    expect(row.overviewFingerprint).toBeNull();
  });

  test('list returns artifactCount / generatingCount / generatingTitle / coverSources', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie, 'StudioNB');

    // Attach 2 sources (oldest-attach first order for coverSources).
    const [src1, src2] = await db
      .insert(sourcesTable)
      .values([
        { userId, kind: 'text' as const, title: 'Source Alpha', status: 'ready' as const, verified: true },
        { userId, kind: 'pdf' as const, title: 'Source Beta', status: 'ready' as const, verified: true },
      ])
      .returning({ id: sourcesTable.id });
    // Insert the join edges with a small delay so added_at order is deterministic.
    await db.insert(notebookSources).values({ userId, notebookId: nb.id, sourceId: src1!.id });
    await new Promise((r) => setTimeout(r, 5));
    await db.insert(notebookSources).values({ userId, notebookId: nb.id, sourceId: src2!.id });

    // Insert 2 artifacts: one ready, one generating.
    await db.insert(notebookArtifactsTable).values([
      {
        userId,
        notebookId: nb.id,
        type: 'summary',
        status: 'ready',
        title: 'Finished Summary',
        sourceIds: [src1!.id],
      },
      {
        userId,
        notebookId: nb.id,
        type: 'faq',
        status: 'generating',
        title: 'Live FAQ',
        sourceIds: [src1!.id],
      },
    ]);

    const res = await callApp(app, 'GET', '/notebooks', { cookie });
    expect(res.status).toBe(200);
    const item = (
      await res.json<{
        items: (NotebookRow & {
          artifactCount: number;
          generatingCount: number;
          generatingTitle: string | null;
          coverSources: { title: string; kind: string; coverMediaId: string | null }[];
        })[];
      }>()
    ).items.find((i) => i.id === nb.id)!;

    expect(item.artifactCount).toBe(2);
    expect(item.generatingCount).toBe(1);
    expect(item.generatingTitle).toBe('Live FAQ');
    // coverSources should be 2 items in oldest-attach-first order.
    expect(item.coverSources).toHaveLength(2);
    expect(item.coverSources[0]!.title).toBe('Source Alpha');
    expect(item.coverSources[0]!.kind).toBe('text');
    expect(item.coverSources[0]!.coverMediaId).toBeNull();
    expect(item.coverSources[1]!.title).toBe('Source Beta');
    expect(item.coverSources[1]!.kind).toBe('pdf');
  });

  test('coverSources is capped at 4', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie, 'BigNB');

    // Insert 6 sources and attach them.
    const srcs = await db
      .insert(sourcesTable)
      .values(
        Array.from({ length: 6 }, (_, i) => ({
          userId,
          kind: 'text' as const,
          title: `S${i + 1}`,
          status: 'ready' as const,
          verified: true,
        })),
      )
      .returning({ id: sourcesTable.id });
    for (const s of srcs) {
      await db.insert(notebookSources).values({ userId, notebookId: nb.id, sourceId: s.id });
      await new Promise((r) => setTimeout(r, 2));
    }

    const res = await callApp(app, 'GET', '/notebooks', { cookie });
    const item = (
      await res.json<{ items: (NotebookRow & { coverSources: unknown[] })[] }>()
    ).items.find((i) => i.id === nb.id)!;

    expect(item.coverSources).toHaveLength(4);
  });

  test('list: no artifacts → artifactCount=0, generatingCount=0, generatingTitle=null', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie, 'EmptyNB');

    const res = await callApp(app, 'GET', '/notebooks', { cookie });
    const item = (
      await res.json<{
        items: (NotebookRow & {
          artifactCount: number;
          generatingCount: number;
          generatingTitle: string | null;
          coverSources: unknown[];
        })[];
      }>()
    ).items.find((i) => i.id === nb.id)!;

    expect(item.artifactCount).toBe(0);
    expect(item.generatingCount).toBe(0);
    expect(item.generatingTitle).toBeNull();
    expect(item.coverSources).toEqual([]);
  });

  test('foreign user cannot see another user notebook in list', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    await createNotebook(b.cookie, 'Secret');

    const res = await callApp(app, 'GET', '/notebooks', { cookie: a.cookie });
    const { items } = await res.json<{ items: NotebookRow[] }>();
    expect(items).toHaveLength(0);
  });
});

describe('notebook sources list — readingPercent + readingStatus (A1)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('readingStatus and readingPercent appear after a reading-state PUT', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie, 'Reading NB');

    const [src] = await db
      .insert(sourcesTable)
      .values({ userId, kind: 'pdf' as const, title: 'MyPDF', status: 'ready' as const, verified: true })
      .returning({ id: sourcesTable.id });
    await db.insert(notebookSources).values({ userId, notebookId: nb.id, sourceId: src!.id });

    // Before any reading-state update: null values.
    const before = await callApp(app, 'GET', `/notebooks/${nb.id}/sources`, { cookie });
    expect(before.status).toBe(200);
    const beforeItem = (await before.json<{ items: { id: string; readingStatus: string | null; readingPercent: number | null }[] }>()).items[0]!;
    expect(beforeItem.readingStatus).toBeNull();
    expect(beforeItem.readingPercent).toBeNull();

    // PUT reading-state → auto-transitions to 'reading', stores percent.
    const put = await callApp(app, 'PUT', `/library/items/${src!.id}/reading-state`, {
      cookie,
      body: { percent: 0.4, page: 5 },
    });
    expect(put.status).toBe(200);

    // Now sources list should reflect the reading state.
    const after = await callApp(app, 'GET', `/notebooks/${nb.id}/sources`, { cookie });
    const afterItem = (await after.json<{ items: { id: string; readingStatus: string | null; readingPercent: number | null }[] }>()).items[0]!;
    expect(afterItem.readingStatus).toBe('reading');
    expect(afterItem.readingPercent).toBeCloseTo(0.4, 2);
  });

  test('sources include author and coverMediaId fields', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie, 'Meta NB');

    const [src] = await db
      .insert(sourcesTable)
      .values({ userId, kind: 'pdf' as const, title: 'Rich PDF', status: 'ready' as const, verified: true, author: 'Alan Turing' })
      .returning({ id: sourcesTable.id });
    await db.insert(notebookSources).values({ userId, notebookId: nb.id, sourceId: src!.id });

    const res = await callApp(app, 'GET', `/notebooks/${nb.id}/sources`, { cookie });
    const item = (await res.json<{ items: { id: string; author: string | null; coverMediaId: string | null }[] }>()).items[0]!;
    expect(item.author).toBe('Alan Turing');
    expect(item.coverMediaId).toBeNull();
  });

  test('foreign notebook → 404 for sources list', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const nb = await createNotebook(b.cookie, 'B NB');
    const res = await callApp(app, 'GET', `/notebooks/${nb.id}/sources`, { cookie: a.cookie });
    expect(res.status).toBe(404);
  });
});
