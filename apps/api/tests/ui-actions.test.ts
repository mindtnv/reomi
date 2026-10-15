import { beforeEach, expect, test } from 'bun:test';
import { db, sources, notebookNotes, notebooks, decks, cards, uiActionReceipts } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers';
import { cleanupUiActionReceipts } from '../src/modules/ui-action-receipts';

const app = buildApp();
beforeEach(resetTestDb);
const envelope = () => ({ requestId: newUuidV7(), sessionId: newUuidV7() });

test('a repeated written-note create resolves the same receipt and never stores its body in the receipt', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId: owner.userId, kind: 'text', title: 'Book' }).returning();
  const body = { ...envelope(), owner: { kind: 'source', id: source!.id }, input: { title: 'Note', content: 'Private draft text' } };
  const save = () => callApp(app, 'POST', '/ui-actions/v1/study-notes', { cookie: owner.cookie, body });
  const [a, b] = await Promise.all([save(), save()]);
  expect(a.status).toBe(200); expect(b.status).toBe(200);
  const first = await a.json<any>(), repeated = await b.json<any>();
  expect(first.receipt.id).toBe(repeated.receipt.id);
  expect(first.result.id).toBe(repeated.result.id);
  expect(await db.select().from(notebookNotes)).toHaveLength(1);
  expect(JSON.stringify(await db.select().from(uiActionReceipts))).not.toContain('Private draft text');
  const receipt = await callApp(app, 'GET', `/ui-actions/v1/receipts/${body.requestId}`, { cookie: owner.cookie });
  expect(receipt.status).toBe(200);
  const stored = await receipt.json<any>();
  expect(stored.receipt.undoUntil).toBeNull();
  const changed = await callApp(app, 'POST', '/ui-actions/v1/study-notes', { cookie: owner.cookie, body: { ...body, input: { ...body.input, content: 'Different' } } });
  expect(changed.status).toBe(409);
});

test('metadata undo restores only its patch, is idempotent and rejects later legacy ABA changes', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId: owner.userId, kind: 'text', title: 'A', author: 'Author' }).returning();
  const saved = await callApp(app, 'PATCH', `/ui-actions/v1/sources/${source!.id}`, { cookie: owner.cookie,
    body: { ...envelope(), expectedRevision: 0, patch: { title: 'B' } } });
  expect(saved.status).toBe(200);
  const result = await saved.json<any>();
  await db.update(sources).set({ chunkCount: 3 }).where(eq(sources.id, source!.id));
  const undo = () => callApp(app, 'POST', `/ui-actions/v1/receipts/${result.receipt.id}/undo`, { cookie: owner.cookie });
  const [a, b] = await Promise.all([undo(), undo()]);
  expect(a.status).toBe(200); expect(b.status).toBe(200);
  const [restored] = await db.select().from(sources).where(eq(sources.id, source!.id));
  expect(restored).toMatchObject({ title: 'A', author: 'Author', chunkCount: 3 });
  const again = await callApp(app, 'PATCH', `/ui-actions/v1/sources/${source!.id}`, { cookie: owner.cookie,
    body: { ...envelope(), expectedRevision: (restored as any).metadataRevision, patch: { title: 'B' } } });
  expect(again.status).toBe(200);
  const receipt = (await again.json<any>()).receipt;
  await db.update(sources).set({ title: 'C' }).where(eq(sources.id, source!.id));
  await db.update(sources).set({ title: 'B' }).where(eq(sources.id, source!.id));
  expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${receipt.id}/undo`, { cookie: owner.cookie })).status).toBe(409);
});

test('written-note stale saves preserve current text and pin undo does not change content recency', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId: owner.userId, kind: 'text', title: 'Book' }).returning();
  const created = await callApp(app, 'POST', '/sources/' + source!.id + '/notes', { cookie: owner.cookie, body: { title: 'Note', content: 'Original' } });
  const note = await created.json<any>();
  const pin = await callApp(app, 'PATCH', `/ui-actions/v1/study-notes/${note.id}`, { cookie: owner.cookie,
    body: { ...envelope(), expectedRevision: 0, patch: { pinned: true } } });
  expect(pin.status).toBe(200);
  const pinned = await pin.json<any>();
  expect(pinned.result.updatedAt).toBe(note.updatedAt);
  const stale = await callApp(app, 'PATCH', `/ui-actions/v1/study-notes/${note.id}`, { cookie: owner.cookie,
    body: { ...envelope(), expectedRevision: 0, patch: { content: 'Stale overwrite' } } });
  expect(stale.status).toBe(409);
  expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${pinned.receipt.id}/undo`, { cookie: owner.cookie })).status).toBe(200);
  const [current] = await db.select().from(notebookNotes).where(eq(notebookNotes.id, note.id));
  expect(current!.content).toBe('Original'); expect(current!.pinned).toBe(false);
  expect(current!.updatedAt.toISOString()).toBe(note.updatedAt);
});

test('receipt reads and undo offers are isolated even when session and request IDs are known', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail()), other = await signUpAndCookie(app, uniqueEmail());
  const [deck] = await db.insert(decks).values({ userId: owner.userId, name: 'Deck' }).returning();
  const identity = envelope();
  const saved = await callApp(app, 'PATCH', `/ui-actions/v1/decks/${deck!.id}`, { cookie: owner.cookie,
    body: { ...identity, expectedRevision: 0, patch: { name: 'Renamed' } } });
  expect(saved.status).toBe(200);
  const { receipt } = await saved.json<any>();
  expect((await callApp(app, 'GET', `/ui-actions/v1/receipts/${identity.requestId}`, { cookie: other.cookie })).status).toBe(404);
  expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${receipt.id}/undo`, { cookie: other.cookie })).status).toBe(404);
  const list = await callApp(app, 'GET', `/ui-actions/v1?sessionId=${identity.sessionId}`, { cookie: other.cookie });
  expect(list.status).toBe(200); expect((await list.json<any>()).items).toEqual([]);
});

test('deck move undo restores exact sibling order, refuses a later legacy move, and does not touch another tree', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail()), other = await signUpAndCookie(app, uniqueEmail());
  const [a, b, c, foreign] = await db.insert(decks).values([
    { userId: owner.userId, name: 'A', position: 0 }, { userId: owner.userId, name: 'B', position: 1 },
    { userId: owner.userId, name: 'C', position: 2 }, { userId: other.userId, name: 'Foreign' },
  ]).returning();
  const version = async () => (await (await callApp(app, 'GET', '/ui-actions/v1/deck-hierarchy', { cookie: owner.cookie })).json<any>()).revision;
  const move = async () => callApp(app, 'POST', `/ui-actions/v1/decks/${c!.id}/move`, { cookie: owner.cookie,
    body: { ...envelope(), expectedRevision: await version(), placement: 'before', targetId: a!.id } });
  const moved = await move(); expect(moved.status).toBe(200);
  const { receipt } = await moved.json<any>();
  expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${receipt.id}/undo`, { cookie: owner.cookie })).status).toBe(200);
  const restored = await db.select().from(decks).where(eq(decks.userId, owner.userId)).orderBy(decks.position);
  expect(restored.map(row => [row.id, row.position, row.parentId])).toEqual([[a!.id, 0, null], [b!.id, 1, null], [c!.id, 2, null]]);
  const again = await move(); expect(again.status).toBe(200);
  const second = (await again.json<any>()).receipt;
  expect((await callApp(app, 'POST', `/decks/${b!.id}/move`, { cookie: owner.cookie, body: { targetId: a!.id, placement: 'inside' } })).status).toBe(200);
  expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${second.id}/undo`, { cookie: owner.cookie })).status).toBe(409);
  expect(await db.select().from(decks).where(eq(decks.id, foreign!.id))).toEqual([foreign!]);
});

test('notebook-title and deck metadata undo preserve unrelated settings and detect old-client writes', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [notebook] = await db.insert(notebooks).values({ userId: owner.userId, title: 'Notebook', emoji: '📘' }).returning();
  const [deck] = await db.insert(decks).values({ userId: owner.userId, name: 'Deck', color: 'lime' }).returning();
  for (const [path, id, patch] of [['notebooks', notebook!.id, { title: 'New' }], ['decks', deck!.id, { name: 'New', color: 'rose', icon: 'book' }]] as const) {
    const response = await callApp(app, 'PATCH', `/ui-actions/v1/${path}/${id}`, { cookie: owner.cookie, body: { ...envelope(), expectedRevision: 0, patch } });
    expect(response.status).toBe(200);
    const { receipt } = await response.json<any>();
    if (path === 'notebooks') await db.update(notebooks).set({ emoji: '🌿' }).where(eq(notebooks.id, id));
    expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${receipt.id}/undo`, { cookie: owner.cookie })).status).toBe(200);
  }
  expect((await db.select().from(notebooks).where(eq(notebooks.id, notebook!.id)))[0]).toMatchObject({ title: 'Notebook', emoji: '🌿' });
  expect((await db.select().from(decks).where(eq(decks.id, deck!.id)))[0]).toMatchObject({ name: 'Deck', color: 'lime', icon: null });
});

test('offers paginate beyond toasts and expired or changed/deleted targets never get an unsafe undo', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId: owner.userId, kind: 'text', title: 'A' }).returning();
  const sessionId = newUuidV7();
  for (let revision = 0; revision < 23; revision++) {
    const result = await callApp(app, 'PATCH', `/ui-actions/v1/sources/${source!.id}`, { cookie: owner.cookie,
      body: { requestId: newUuidV7(), sessionId, expectedRevision: revision, patch: { title: `Title ${revision}` } } });
    expect(result.status).toBe(200);
  }
  const list = await (await callApp(app, 'GET', `/ui-actions/v1?sessionId=${sessionId}`, { cookie: owner.cookie })).json<any>();
  expect(list.items).toHaveLength(20);
  const more = await (await callApp(app, 'GET', `/ui-actions/v1?sessionId=${sessionId}&cursor=${list.nextCursor}`, { cookie: owner.cookie })).json<any>();
  expect(more.items).toHaveLength(3);
  expect(new Set([...list.items, ...more.items].map(row => row.id)).size).toBe(23);
  const last = more.items.at(-1);
  await db.update(uiActionReceipts).set({ undoUntil: new Date(0) }).where(eq(uiActionReceipts.id, last.id));
  expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${last.id}/undo`, { cookie: owner.cookie })).status).toBe(409);
  const first = list.items[list.items.length - 1];
  expect((await (await callApp(app, 'GET', `/ui-actions/v1/receipts/${first.requestId}`, { cookie: owner.cookie })).json<any>()).outcome).toBe('changed');
  await db.delete(sources).where(eq(sources.id, source!.id));
  expect((await (await callApp(app, 'GET', `/ui-actions/v1/receipts/${first.requestId}`, { cookie: owner.cookie })).json<any>()).outcome).toBe('unavailable');
  await db.update(uiActionReceipts).set({ expiresAt: new Date(0) }).where(eq(uiActionReceipts.id, first.id));
  await cleanupUiActionReceipts();
  expect((await callApp(app, 'GET', `/ui-actions/v1/receipts/${first.requestId}`, { cookie: owner.cookie })).status).toBe(404);
});

test('retained written-note edits remain recoverable after source deletion', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId: owner.userId, kind: 'text', title: 'Book' }).returning();
  const created = await callApp(app, 'POST', '/ui-actions/v1/study-notes', { cookie: owner.cookie,
    body: { ...envelope(), owner: { kind: 'source', id: source!.id }, input: { title: 'Retained', content: 'Before' } } });
  const note = (await created.json<any>()).result;
  await db.delete(sources).where(eq(sources.id, source!.id));
  const update = await callApp(app, 'PATCH', `/ui-actions/v1/study-notes/${note.id}`, { cookie: owner.cookie,
    body: { ...envelope(), expectedRevision: 0, patch: { content: 'After' } } });
  expect(update.status).toBe(200);
  const result = await update.json<any>();
  expect(result.result).toMatchObject({ content: 'After', sourceId: null, sourceOriginTitle: 'Book' });
  expect(result.receipt.undoUntil).toBeNull();
});

test('a later rename that changes a historical sibling tie cannot be erased by move undo', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [a, b] = await db.insert(decks).values([{ userId: owner.userId, name: 'A' }, { userId: owner.userId, name: 'B' }]).returning();
  const version = await (await callApp(app, 'GET', '/ui-actions/v1/deck-hierarchy', { cookie: owner.cookie })).json<any>();
  const moved = await callApp(app, 'POST', `/ui-actions/v1/decks/${b!.id}/move`, { cookie: owner.cookie,
    body: { ...envelope(), expectedRevision: version.revision, placement: 'before', targetId: a!.id } });
  expect(moved.status).toBe(200);
  const { receipt } = await moved.json<any>();
  await db.update(decks).set({ name: 'Z' }).where(eq(decks.id, a!.id));
  expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${receipt.id}/undo`, { cookie: owner.cookie })).status).toBe(409);
  expect((await db.select().from(decks).where(eq(decks.id, a!.id)))[0]!.name).toBe('Z');
});

test('an expired request cannot become a second create after its receipt is cleaned up', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId: owner.userId, kind: 'text', title: 'Book' }).returning();
  const time = (Date.now() - 8 * 86400_000).toString(16).padStart(12, '0');
  const requestId = `${time.slice(0, 8)}-${time.slice(8)}${newUuidV7().slice(13)}`;
  const response = await callApp(app, 'POST', '/ui-actions/v1/study-notes', { cookie: owner.cookie, body: {
    requestId, sessionId: newUuidV7(), owner: { kind: 'source', id: source!.id }, input: { title: 'Expired', content: 'Cannot duplicate' },
  } });
  expect(response.status).toBe(409);
  expect(await db.select().from(notebookNotes)).toHaveLength(0);
});

test('subtree move and undo keep schedules intact; deleting the new parent cannot resurrect the subtree', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [parent, root] = await db.insert(decks).values([{ userId: owner.userId, name: 'Parent', position: 0 }, { userId: owner.userId, name: 'Root', position: 1 }]).returning();
  const [child] = await db.insert(decks).values({ userId: owner.userId, name: 'Child', parentId: root!.id }).returning();
  const card = await seedBasicCard(app, owner.cookie, { deckId: child!.id, front: 'Question' });
  await callApp(app, 'POST', '/reviews', { cookie: owner.cookie, body: { cardId: card.id, rating: 4 } });
  const before = await db.select().from(cards).where(eq(cards.id, card.id));
  const move = async () => {
    const snapshot = await (await callApp(app, 'GET', '/ui-actions/v1/deck-hierarchy', { cookie: owner.cookie })).json<any>();
    expect(snapshot.decks.map((row: any) => row.id)).toContain(child!.id);
    const result = await callApp(app, 'POST', `/ui-actions/v1/decks/${root!.id}/move`, { cookie: owner.cookie,
      body: { ...envelope(), expectedRevision: snapshot.revision, targetId: parent!.id, placement: 'inside' } });
    expect(result.status).toBe(200); return result.json<any>();
  };
  const first = await move();
  expect(await db.select().from(cards).where(eq(cards.id, card.id))).toEqual(before);
  expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${first.receipt.id}/undo`, { cookie: owner.cookie })).status).toBe(200);
  expect(await db.select().from(cards).where(eq(cards.id, card.id))).toEqual(before);
  const second = await move();
  expect((await callApp(app, 'DELETE', `/decks/${parent!.id}`, { cookie: owner.cookie })).status).toBe(200);
  expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${second.receipt.id}/undo`, { cookie: owner.cookie })).status).toBe(409);
  expect(await db.select().from(decks).where(eq(decks.id, root!.id))).toHaveLength(0);
});

test('pin ABA through the legacy endpoint invalidates an earlier undo and concurrent pin replay only advances once', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId: owner.userId, kind: 'text', title: 'Book' }).returning();
  const note = await (await callApp(app, 'POST', `/sources/${source!.id}/notes`, { cookie: owner.cookie, body: { title: 'Note', content: 'Body' } })).json<any>();
  const body = { ...envelope(), expectedRevision: 0, patch: { pinned: true } };
  const [a, b] = await Promise.all([1, 2].map(() => callApp(app, 'PATCH', `/ui-actions/v1/study-notes/${note.id}`, { cookie: owner.cookie, body })));
  expect(a.status).toBe(200); expect(b.status).toBe(200);
  const result = await a.json<any>();
  expect(result.result.metadataRevision).toBe(1);
  await callApp(app, 'PATCH', `/study/notes/${note.id}`, { cookie: owner.cookie, body: { pinned: false } });
  await callApp(app, 'PATCH', `/study/notes/${note.id}`, { cookie: owner.cookie, body: { pinned: true } });
  expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${result.receipt.id}/undo`, { cookie: owner.cookie })).status).toBe(409);
});

test('receipt cleanup removes at most 500 expired records and retains live reconciliation data', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail()), sessionId = newUuidV7(), targetId = newUuidV7();
  const rows = Array.from({ length: 503 }, (_, index) => ({ userId: owner.userId, sessionId, requestId: newUuidV7(), requestHash: 'test-hash',
    kind: 'source-metadata' as const, target: { kind: 'source' as const, id: targetId, revision: '1' }, label: 'Cleanup fixture',
    expiresAt: index === 502 ? new Date(Date.now() + 86400000) : new Date(0) }));
  await db.insert(uiActionReceipts).values(rows);
  await cleanupUiActionReceipts();
  expect(await db.select().from(uiActionReceipts).where(eq(uiActionReceipts.userId, owner.userId))).toHaveLength(3);
  await cleanupUiActionReceipts();
  const remaining = await db.select().from(uiActionReceipts).where(eq(uiActionReceipts.userId, owner.userId));
  expect(remaining).toHaveLength(1); expect(remaining[0]!.requestId).toBe(rows[502]!.requestId);
});
