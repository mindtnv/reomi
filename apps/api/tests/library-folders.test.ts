import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, sources, sourceReadingState, notebooks, notebookSources, sourceChunks, kbChunk, cards, cardSources } from '@reomi/db';
import { __setAiClientForTests, __resetAiClientForTests } from '../src/ai/openai-client';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail, seedBasicCard } from './helpers';

const app = buildApp();
type Folder = { id: string; name: string; parentId: string | null; revision: number; count: number };
const folderPath = '/library/folders';
async function create(cookie: string, name: string, parentId?: string) {
  const response = await callApp(app, 'POST', folderPath, { cookie, body: { name, parentId } });
  expect(response.status).toBe(200);
  return response.json<Folder>();
}
async function seed(userId: string, title = 'Material') {
  return (await db.insert(sources).values({ userId, kind: 'text', title, status: 'ready', verified: true }).returning())[0]!;
}
describe('library folders', () => {
  beforeEach(resetTestDb);
  afterEach(__resetAiClientForTests);

  test('persistent nested CRUD rejects duplicate names, cycles, foreign parents and stale revisions', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const root = await create(a.cookie, '  Research  ');
    expect(root.name).toBe('Research');
    const child = await create(a.cookie, 'Articles', root.id);
    const foreign = await create(b.cookie, 'Private');
    expect((await callApp(app, 'POST', folderPath, { cookie: a.cookie, body: { name: 'research' } })).status).toBe(409);
    expect((await callApp(app, 'PATCH', `${folderPath}/${root.id}`, { cookie: a.cookie, body: { parentId: child.id, revision: root.revision } })).status).toBe(409);
    expect((await callApp(app, 'PATCH', `${folderPath}/${child.id}`, { cookie: a.cookie, body: { parentId: foreign.id, revision: child.revision } })).status).toBe(404);
    const renamed = await callApp(app, 'PATCH', `${folderPath}/${child.id}`, { cookie: a.cookie, body: { name: 'Notes', revision: child.revision } });
    expect(renamed.status).toBe(200);
    expect((await callApp(app, 'PATCH', `${folderPath}/${child.id}`, { cookie: a.cookie, body: { name: 'Old', revision: child.revision } })).status).toBe(409);
    const list = await (await callApp(app, 'GET', folderPath, { cookie: a.cookie })).json<{ items: Folder[] }>();
    expect(list.items.map(x => x.name).sort()).toEqual(['Notes', 'Research']);
    expect(list.items.find(x => x.name === 'Notes')?.parentId).toBe(root.id);
  });

  test('batch placement and folder deletion preserve source identity, reading and notebook links', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const root = await create(a.cookie, 'Inbox');
    const child = await create(a.cookie, 'Child', root.id);
    const source = await seed(a.userId);
    const deck = await (await callApp(app, 'POST', '/decks', { cookie: a.cookie, body: { name: 'Learning' } })).json<{ id: string }>();
    const card = await seedBasicCard(app, a.cookie, { deckId: deck.id, front: 'Question', back: 'Answer' });
    await db.insert(cardSources).values({ userId: a.userId, cardId: card.id, sourceId: source.id });
    const [cardBefore] = await db.select().from(cards).where(eq(cards.id, card.id));
    const [notebook] = await db.insert(notebooks).values({ userId: a.userId, title: 'Notebook' }).returning();
    await db.insert(notebookSources).values({ userId: a.userId, notebookId: notebook!.id, sourceId: source.id });
    await db.insert(sourceReadingState).values({ userId: a.userId, sourceId: source.id, status: 'reading', percent: 0.5 });
    const move = await callApp(app, 'POST', `${folderPath}/move-items`, { cookie: a.cookie, body: { sourceIds: [source.id], folderId: child.id } });
    expect(move.status).toBe(200);
    let [live] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(live!.folderId).toBe(child.id);
    expect(live!.metadataRevision).toBe(source.metadataRevision + 1);
    expect(live!.updatedAt.toISOString()).toBe(source.updatedAt.toISOString());
    const preview = await (await callApp(app, 'GET', `${folderPath}/${root.id}/delete-preview`, { cookie: a.cookie })).json<{ folderCount: number; materialCount: number; confirmationToken: string }>();
    expect(preview.folderCount).toBe(2);
    expect(preview.materialCount).toBe(1);
    const remove = await callApp(app, 'DELETE', `${folderPath}/${root.id}`, { cookie: a.cookie, body: { confirmationToken: preview.confirmationToken, destinationId: null } });
    expect(remove.status).toBe(200);
    [live] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(live!.folderId).toBeNull();
    expect(live!.metadataRevision).toBe(source.metadataRevision + 2);
    expect(live!.updatedAt.toISOString()).toBe(source.updatedAt.toISOString());
    expect(await db.select().from(notebookSources)).toHaveLength(1);
    expect((await db.select().from(sourceReadingState))[0]!.percent).toBe(0.5);
    expect((await db.select().from(cards).where(eq(cards.id, card.id)))[0]).toEqual(cardBefore);
    expect((await db.select().from(cardSources))[0]!.sourceId).toBe(source.id);
  });

  test('a mixed-owner batch changes nothing and changed subtree invalidates a delete preview', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const folder = await create(a.cookie, 'Folder');
    const own = await seed(a.userId);
    const foreign = await seed(b.userId);
    const move = await callApp(app, 'POST', `${folderPath}/move-items`, { cookie: a.cookie, body: { sourceIds: [own.id, foreign.id], folderId: folder.id } });
    expect(move.status).toBe(404);
    expect((await db.select().from(sources).where(eq(sources.id, own.id)))[0]!.folderId).toBeNull();
    const preview = await (await callApp(app, 'GET', `${folderPath}/${folder.id}/delete-preview`, { cookie: a.cookie })).json<{ confirmationToken: string }>();
    await callApp(app, 'POST', `${folderPath}/move-items`, { cookie: a.cookie, body: { sourceIds: [own.id], folderId: folder.id } });
    expect((await callApp(app, 'DELETE', `${folderPath}/${folder.id}`, { cookie: a.cookie, body: { confirmationToken: preview.confirmationToken } })).status).toBe(409);
    expect((await db.select().from(sources).where(eq(sources.id, own.id)))[0]!.folderId).toBe(folder.id);
  });

  test('browser-default initialization is concurrent-idempotent and recreates only on request', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const replies = await Promise.all([1, 2, 3].map(() => callApp(app, 'POST', `${folderPath}/browser-default`, { cookie: a.cookie, body: { name: 'Из браузера' } })));
    expect(replies.map(r => r.status)).toEqual([200, 200, 200]);
    const folders = await Promise.all(replies.map(r => r.json<Folder>()));
    expect(new Set(folders.map(x => x.id)).size).toBe(1);
    const first = folders[0]!;
    const preview = await (await callApp(app, 'GET', `${folderPath}/${first.id}/delete-preview`, { cookie: a.cookie })).json<{ confirmationToken: string }>();
    expect((await callApp(app, 'DELETE', `${folderPath}/${first.id}`, { cookie: a.cookie, body: { confirmationToken: preview.confirmationToken } })).status).toBe(200);
    const list = await (await callApp(app, 'GET', folderPath, { cookie: a.cookie })).json<{ items: Folder[] }>();
    expect(list.items).toHaveLength(0);
    expect((await create(a.cookie, 'Ordinary')).id).not.toBe(first.id);
    const replacement = await (await callApp(app, 'POST', `${folderPath}/browser-default`, { cookie: a.cookie, body: {} })).json<Folder>();
    expect(replacement.id).not.toBe(first.id);
  });

  test('deletion accepts an outside destination and rejects descendants and foreign destinations without writing', async () => {
    const a = await signUpAndCookie(app, uniqueEmail()), b = await signUpAndCookie(app, uniqueEmail());
    const root = await create(a.cookie, 'Root'), child = await create(a.cookie, 'Child', root.id);
    const destination = await create(a.cookie, 'Retained'), foreign = await create(b.cookie, 'Private');
    const source = await seed(a.userId);
    await callApp(app, 'POST', `${folderPath}/move-items`, { cookie: a.cookie, body: { sourceIds: [source.id], folderId: child.id } });
    const preview = await (await callApp(app, 'GET', `${folderPath}/${root.id}/delete-preview`, { cookie: a.cookie })).json<{ confirmationToken: string }>();
    for (const [destinationId, status] of [[child.id, 409], [foreign.id, 404]] as const) {
      expect((await callApp(app, 'DELETE', `${folderPath}/${root.id}`, { cookie: a.cookie, body: { ...preview, destinationId } })).status).toBe(status);
      expect((await db.select().from(sources).where(eq(sources.id, source.id)))[0]!.folderId).toBe(child.id);
    }
    expect((await callApp(app, 'DELETE', `${folderPath}/${root.id}`, { cookie: a.cookie, body: { ...preview, destinationId: destination.id } })).status).toBe(200);
    const [retained] = await db.select().from(sources).where(eq(sources.id, source.id));
    expect(retained!.folderId).toBe(destination.id);
    expect(retained!.updatedAt).toEqual(source.updatedAt);
  });

  test('malformed sort cursor fields return a client error rather than a database error', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const source = await seed(a.userId);
    for (const patch of [{ readAt: 42 }, { createdAt: 42 }, { readAt: 'invalid' }]) {
      const cursor = `v2.${Buffer.from(JSON.stringify({ sort: 'lastRead', id: source.id, title: source.title, createdAt: source.createdAt.toISOString(), readAt: null, ...patch })).toString('base64url')}`;
      expect((await callApp(app, 'GET', `/library?sort=lastRead&cursor=${encodeURIComponent(cursor)}`, { cookie: a.cookie })).status).toBe(400);
    }
  });

  test('subtree counts, title filtering and pagination cover every source for each sort', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const parent = await create(a.cookie, 'Parent');
    const child = await create(a.cookie, 'Child', parent.id);
    const outside = await seed(a.userId, 'Outside');
    const records = [];
    for (let i = 0; i < 7; i++) records.push(await seed(a.userId, `Article ${Math.floor(i / 2)}`));
    await callApp(app, 'POST', `${folderPath}/move-items`, { cookie: a.cookie, body: { sourceIds: records.slice(0, 3).map(s => s.id), folderId: parent.id } });
    await callApp(app, 'POST', `${folderPath}/move-items`, { cookie: a.cookie, body: { sourceIds: records.slice(3).map(s => s.id), folderId: child.id } });
    await db.insert(sourceReadingState).values({ userId: a.userId, sourceId: records[3]!.id, status: 'reading', updatedAt: new Date('2026-10-19T00:00:00Z') });
    const counts = await (await callApp(app, 'GET', folderPath, { cookie: a.cookie })).json<{ items: Folder[]; totalCount: number; unfiledCount: number }>();
    expect(counts.totalCount).toBe(8); expect(counts.unfiledCount).toBe(1);
    expect(counts.items.find(f => f.id === parent.id)?.count).toBe(7);
    expect(counts.items.find(f => f.id === child.id)?.count).toBe(4);
    for (const sort of ['added', 'title', 'lastRead']) {
      const ids: string[] = []; let cursor: string | null = null;
      do {
        const response = await callApp(app, 'GET', `/library?folderId=${parent.id}&sort=${sort}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: a.cookie });
        expect(response.status).toBe(200);
        const page = await response.json<{ items: { id: string }[]; nextCursor: string | null }>();
        ids.push(...page.items.map(s => s.id)); cursor = page.nextCursor;
        expect(ids.length).toBeLessThanOrEqual(7);
      } while (cursor);
      expect(new Set(ids).size).toBe(7);
      expect(ids).not.toContain(outside.id);
    }
    const filtered = await (await callApp(app, 'GET', `/library?folderId=${parent.id}&q=Article%203`, { cookie: a.cookie })).json<{ items: { id: string }[] }>();
    expect(filtered.items.map(s => s.id)).toEqual([records[6]!.id]);
    const unfiled = await (await callApp(app, 'GET', '/library?folderId=unfiled', { cookie: a.cookie })).json<{ items: { id: string }[] }>();
    expect(unfiled.items.map(s => s.id)).toEqual([outside.id]);
  });

  test('content retrieval scopes candidates before the search limit and rejects foreign scopes', async () => {
    const a = await signUpAndCookie(app, uniqueEmail()), b = await signUpAndCookie(app, uniqueEmail());
    const parent = await create(a.cookie, 'Parent'), child = await create(a.cookie, 'Child', parent.id), foreign = await create(b.cookie, 'Private');
    const inside = await seed(a.userId), outside = await seed(a.userId);
    await callApp(app, 'POST', `${folderPath}/move-items`, { cookie: a.cookie, body: { sourceIds: [inside.id], folderId: child.id } });
    const vector = new Array<number>(1536).fill(0); vector[0] = 1;
    __setAiClientForTests({ embed: async texts => texts.map(() => vector) });
    for (const source of [inside, outside]) {
      await db.insert(sourceChunks).values({ userId: a.userId, sourceId: source.id, position: 0, text: 'Library knowledge', embedded: true });
      await db.insert(kbChunk).values({ userId: a.userId, sourceType: 'document', sourceId: source.id, parentId: source.id, position: 0, text: 'Library knowledge', embedding: vector, embeddingModel: 'fixture', sourceHash: source.id });
    }
    const result = await (await callApp(app, 'GET', `/library/search?q=knowledge&limit=1&folderId=${parent.id}`, { cookie: a.cookie })).json<{ groups: { source: { id: string } }[] }>();
    expect(result.groups.map(g => g.source.id)).toEqual([inside.id]);
    expect((await callApp(app, 'GET', `/library/search?q=knowledge&folderId=${foreign.id}`, { cookie: a.cookie })).status).toBe(404);
  });

  test('new text placement uses the selected owned folder and rejects a deleted explicit destination', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const folder = await create(a.cookie, 'Inbox');
    const added = await callApp(app, 'POST', '/library/items', { cookie: a.cookie, body: { kind: 'text', title: 'Page', text: 'Useful material', folderId: folder.id } });
    expect(added.status).toBe(200);
    expect((await added.json<{ folderId: string }>()).folderId).toBe(folder.id);
    const preview = await (await callApp(app, 'GET', `${folderPath}/${folder.id}/delete-preview`, { cookie: a.cookie })).json<{ confirmationToken: string }>();
    await callApp(app, 'DELETE', `${folderPath}/${folder.id}`, { cookie: a.cookie, body: { confirmationToken: preview.confirmationToken } });
    const rejected = await callApp(app, 'POST', '/library/items', { cookie: a.cookie, body: { kind: 'text', title: 'Late page', text: 'Useful material', folderId: folder.id } });
    expect(rejected.status).toBe(404);
    expect(await db.select().from(sources)).toHaveLength(1);
  });

  test('concurrent opposing folder moves cannot form a cycle', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const x = await create(a.cookie, 'A'), y = await create(a.cookie, 'B');
    const outcomes = await Promise.all([
      callApp(app, 'PATCH', `${folderPath}/${x.id}`, { cookie: a.cookie, body: { parentId: y.id, revision: 0 } }),
      callApp(app, 'PATCH', `${folderPath}/${y.id}`, { cookie: a.cookie, body: { parentId: x.id, revision: 0 } }),
    ]);
    expect(outcomes.map(r => r.status).sort()).toEqual([200, 409]);
  });
});
