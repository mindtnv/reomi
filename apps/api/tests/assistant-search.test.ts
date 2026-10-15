import { beforeEach, expect, test } from 'bun:test';
import { db, cards, decks, notes, noteTypes, notebookNotes, notebookArtifacts, notebooks, conversations, sources, sourceChunks } from '@reomi/db';
import { BASIC_NOTE_TYPE, newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp();
beforeEach(resetTestDb);
test('capability discovery reports only supported assistant protocol features', async () => {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const response = await callApp(app, 'GET', '/ai/status', { cookie });
  const status = await response.json<any>();
  expect(status.assistant).toEqual({ contextVersion: 1, objectSearch: true, maxConcurrentTurns: 3, sourceStudy: true });
  expect(JSON.stringify(status.assistant)).not.toContain('key');
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title: 'Manual study', status: 'ready' }).returning();
  const created = await callApp(app, 'POST', `/sources/${source!.id}/notes`, { cookie, body: { title: 'First note', content: 'Manual source study without AI.' } });
  expect(created.status).toBe(200);
  expect((await created.json<any>()).ownerKind).toBe('source');
  expect((await callApp(app, 'GET', `/sources/${source!.id}/notes`, { cookie })).status).toBe(200);
  expect((await callApp(app, 'GET', `/sources/${source!.id}/artifacts`, { cookie })).status).toBe(200);
  const listing = await callApp(app, 'GET', '/notebooks', { cookie });
  const notebookList = await listing.json<any>();
  expect(Array.isArray(notebookList) ? notebookList : notebookList.items).toHaveLength(0);

});
async function fixture(userId: string, title = 'Common topic') {
  const [deck] = await db.insert(decks).values({ userId, name: title }).returning();
  const [type] = await db.insert(noteTypes).values({ ...BASIC_NOTE_TYPE, id: newUuidV7(), name: title, userId, isBuiltin: false }).returning();
  const [note] = await db.insert(notes).values({ userId, noteTypeId: type!.id, fieldValues: { Front: title, Back: 'Body must stay private in search metadata' } }).returning();
  const [card] = await db.insert(cards).values({ userId, deckId: deck!.id, noteId: note!.id, renderFrontText: title, renderText: title }).returning();
  const [notebook] = await db.insert(notebooks).values({ userId, title }).returning();
  await db.insert(notebookNotes).values({ userId, notebookId: notebook!.id, title, content: 'Private long note body' });
  await db.insert(notebookArtifacts).values({ userId, notebookId: notebook!.id, type: 'quiz', title, sourceIds: [], contentMd: 'Private artifact body' });
  await db.insert(conversations).values({ userId, title });
  const [source] = await db.insert(sources).values({ userId, title, kind: 'text', storageKey: 'private-storage-key' }).returning();
  const [chunk] = await db.insert(sourceChunks).values({ userId, sourceId: source!.id, position: 0, heading: title, text: 'Private chapter body' }).returning();
  return { deck: deck!, type: type!, note: note!, card: card!, notebook: notebook!, source: source!, chunk: chunk! };
}

test('search finds each study object type with disambiguating metadata and no private bodies', async () => {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const f = await fixture(userId);
  const res = await callApp(app, 'GET', '/chat/context/search?q=Common&limit=30', { cookie });
  expect(res.status).toBe(200);
  const page = await res.json<any>();
  expect(new Set(page.items.map((i: any) => i.ref.kind))).toEqual(new Set([
    'card', 'deck', 'notebook', 'source', 'written_note', 'flashcard_note', 'note_type', 'artifact', 'conversation',
  ]));
  expect(page.items.find((i: any) => i.ref.kind === 'card').parent.id).toBe(f.deck.id);
  expect(page.items.find((i: any) => i.ref.kind === 'artifact').parent.id).toBe(f.notebook.id);
  expect(JSON.stringify(page)).not.toContain('Private');
  expect(JSON.stringify(page)).not.toContain('private-storage-key');
  expect(JSON.stringify(page)).not.toContain('userId');
  const passages = await callApp(app, 'GET', `/chat/context/search?type=source_passage&parentKind=source&parentId=${f.source.id}`, { cookie });
  expect(passages.status).toBe(200);
  expect((await passages.json<any>()).items[0].ref).toEqual({ kind: 'source_passage', id: f.source.id, locator: { chunkId: f.chunk.id, position: 0 } });
  expect((await callApp(app, 'GET', '/chat/context/search?type=source_passage', { cookie })).status).toBe(400);
});

test('owned results and parent filters never reveal another account or unlisted builtin types', async () => {
  const alice = await signUpAndCookie(app, uniqueEmail('alice')), bob = await signUpAndCookie(app, uniqueEmail('bob'));
  const a = await fixture(alice.userId, 'Own material'), b = await fixture(bob.userId, 'Secret material');
  const filtered = await callApp(app, 'GET', `/chat/context/search?type=card&parentKind=deck&parentId=${a.deck.id}`, { cookie: alice.cookie });
  expect((await filtered.json<any>()).items.map((i: any) => i.ref.id)).toEqual([a.card.id]);
  const hidden = await callApp(app, 'GET', '/chat/context/search?q=Secret', { cookie: alice.cookie });
  expect((await hidden.json<any>()).items).toEqual([]);
  expect((await callApp(app, 'GET', `/chat/context/search?type=source_passage&parentKind=source&parentId=${b.source.id}`, { cookie: alice.cookie })).status).toBe(404);
  expect((await callApp(app, 'GET', '/chat/context/search', {})).status).toBe(401);
  const note = await callApp(app, 'GET', `/notes/${a.note.id}`, { cookie: alice.cookie });
  expect(note.status).toBe(200);
  expect((await note.json<any>()).cards.map((c: any) => c.id)).toEqual([a.card.id]);
  expect((await callApp(app, 'GET', `/notes/${b.note.id}`, { cookie: alice.cookie })).status).toBe(404);
  await db.insert(noteTypes).values([
    { ...BASIC_NOTE_TYPE, id: newUuidV7(), name: 'Published builtin', userId: null, isBuiltin: true },
    { ...BASIC_NOTE_TYPE, id: newUuidV7(), name: 'Unpublished builtin', userId: null, isBuiltin: false },
  ]);
  const types = await (await callApp(app, 'GET', '/chat/context/search?type=note_type&q=builtin', { cookie: alice.cookie })).json<any>();
  expect(types.items.map((i: any) => i.label)).toEqual(['Published builtin']);
});

test('search treats wildcard characters literally and searches beyond the bounded display label', async () => {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  await db.insert(sources).values([
    { userId, kind: 'text', title: 'Literal %_ name' },
    { userId, kind: 'text', title: 'a'.repeat(210) + ' needle' },
  ]);
  const wildcard = await (await callApp(app, 'GET', '/chat/context/search?q=%25_', { cookie })).json<any>();
  expect(wildcard.items.map((i: any) => i.label)).toEqual(['Literal %_ name']);
  const long = await (await callApp(app, 'GET', '/chat/context/search?q=needle', { cookie })).json<any>();
  expect(long.items).toHaveLength(1);
  expect(long.items[0].label.length).toBe(200);
});

test('server search reaches cards beyond bootstrap and pages equal labels without duplicates', async () => {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const f = await fixture(userId);
  const rows = Array.from({ length: 520 }, (_, n) => ({ id: newUuidV7(), userId, noteTypeId: f.type.id, fieldValues: { Front: n === 0 ? 'Distant needle' : 'Repeated card', Back: 'Answer' } }));
  await db.insert(notes).values(rows);
  await db.insert(cards).values(rows.map((r,n) => ({ userId, noteId: r.id, deckId: f.deck.id, renderFrontText: r.fieldValues.Front, renderText: r.fieldValues.Front, createdAt: new Date(1_000 + n) })));
  const far = await callApp(app, 'GET', '/chat/context/search?type=card&q=Distant', { cookie });
  expect((await far.json<any>()).items).toHaveLength(1);
  const ids = new Set<string>(); let cursor: string | null = null;
  do {
    const res = await callApp(app, 'GET', `/chat/context/search?type=card&q=Repeated&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie });
    expect(res.status).toBe(200);
    const page = await res.json<any>();
    for (const item of page.items) { expect(ids.has(item.ref.id)).toBe(false); ids.add(item.ref.id); }
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids.size).toBe(519);
  const first = await (await callApp(app, 'GET', '/chat/context/search?type=card&limit=1', { cookie })).json<any>();
  expect((await callApp(app, 'GET', `/chat/context/search?type=source&cursor=${first.nextCursor}`, { cookie })).status).toBe(400);
  expect((await callApp(app, 'GET', '/chat/context/search?limit=1.5', { cookie })).status).toBe(400);
});
