import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, cards, cardSources, libraryDocumentation, libraryDocumentationPages, libraryFolders, sources, sourceChunks, sourceReadingState, notebooks, notebookSources } from '@reomi/db';
import { buildApp } from '../src/app';
import { __setDnsLookupForTests, __setPageFetchForTests } from '../src/ai/page-reader';
import { runDocumentationCollection, recoverDocumentationImports } from '../src/ai/library-documentation-worker';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp(), base = '/library/documentation';
let urls: string[], version: number, failedUrl: string | null;
type Summary = { id: string; folderId: string; state: string; total: number; completed: number; failed: number; pending: number; deleted: number };
async function preview(cookie: string) {
  const response = await callApp(app, 'POST', `${base}/preview`, { cookie, body: { url: 'https://example.com/docs/home/', locale: 'en' } });
  expect(response.status).toBe(200);
  return response.json<{ id: string; rootUrl: string; available: number; sections: { prefix: string; pageCount: number }[] }>();
}
async function confirm(cookie: string, id: string, prefixes = ['/docs/concepts/']) {
  const response = await callApp(app, 'POST', `${base}/${id}/confirm`, { cookie, body: { title: 'Kubernetes', prefixes } });
  expect(response.status).toBe(200); return response.json<Summary>();
}
async function summary(cookie: string, id: string) {
  return (await callApp(app, 'GET', `${base}/${id}`, { cookie })).json<Summary>();
}
beforeEach(async () => {
  await resetTestDb(); version = 1; failedUrl = null;
  urls = ['https://example.com/docs/concepts/workloads/pods', 'https://example.com/docs/concepts/workloads/deployments', 'https://example.com/docs/tasks/install'];
  __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  __setPageFetchForTests(async input => {
    const url = String(input);
    if (url.endsWith('/sitemap.xml')) return new Response(`<urlset>${urls.map(u => `<url><loc>${u}/</loc></url>`).join('')}</urlset>`, { headers: { 'content-type': 'application/xml' } });
    if (/llms.*\.txt$/.test(url)) return new Response('', { status: 404 });
    if (url === failedUrl) return new Response('', { status: 503 });
    return new Response(`<html><head><title>Readable ${url.split('/').pop()}</title></head><body><main><h1>Documentation</h1><p>Useful original content about containers, networking, workloads and deployments. Version ${version}. ${'Learn Kubernetes carefully. '.repeat(30)}</p></main></body></html>`, { headers: { 'content-type': 'text/html' } });
  });
});
afterEach(() => { __setDnsLookupForTests(null); __setPageFetchForTests(null); });

describe('library documentation imports', () => {
  test('preview writes no sources/folders, enforces ownership, confirms only chosen branches and is idempotent', async () => {
    const a = await signUpAndCookie(app, uniqueEmail()), b = await signUpAndCookie(app, uniqueEmail());
    const draft = await preview(a.cookie);
    expect(draft.rootUrl).toBe('https://example.com/docs/');
    expect(await db.select().from(sources)).toHaveLength(0);
    expect(await db.select().from(libraryFolders)).toHaveLength(0);
    expect((await callApp(app, 'POST', `${base}/${draft.id}/confirm`, { cookie: b.cookie, body: { title: 'Stolen', prefixes: ['/docs/'] } })).status).toBe(404);
    await confirm(a.cookie, draft.id);
    await confirm(a.cookie, draft.id);
    expect(await db.select().from(libraryDocumentationPages)).toHaveLength(2);
    await runDocumentationCollection(draft.id);
    const result = await summary(a.cookie, draft.id);
    expect(result.state).toBe('completed'); expect(result.completed).toBe(2);
    const saved = await db.select().from(sources);
    expect(saved).toHaveLength(2); expect(saved.every(s => s.kind === 'url' && s.folderId)).toBe(true);
    expect(saved.some(s => s.url?.includes('/tasks/'))).toBe(false);
    expect((await callApp(app, 'GET', `${base}/${draft.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await callApp(app, 'POST', `${base}/${draft.id}/updates`, { cookie: b.cookie })).status).toBe(404);
  });

  test('unchanged chunks retain identity; changed pages preserve metadata, reading, notebook links, and old text on fetch failure', async () => {
    const a = await signUpAndCookie(app, uniqueEmail()), draft = await preview(a.cookie);
    await confirm(a.cookie, draft.id); await runDocumentationCollection(draft.id);
    const [source] = await db.select().from(sources).orderBy(sources.id);
    const chunks = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, source!.id));
    await db.update(sources).set({ title: 'My title', tags: ['mine'] }).where(eq(sources.id, source!.id));
    await db.insert(sourceReadingState).values({ userId: a.userId, sourceId: source!.id, lastPage: 2, percent: 0.5, status: 'reading' });
    const deck = await (await callApp(app, 'POST', '/decks', { cookie: a.cookie, body: { name: 'Learning' } })).json<{ id: string }>();
    const card = await seedBasicCard(app, a.cookie, { deckId: deck.id, front: 'Pods?', back: 'Container workloads' });
    const [beforeCard] = await db.select().from(cards).where(eq(cards.id, card.id));
    const evidence = { version: 1 as const, sourceId: source!.id, sourceTitle: source!.title,
      quote: 'Version 1', chunkId: chunks[0]!.id, position: 0, textHash: 'historical-text-hash' };
    await db.insert(cardSources).values({ userId: a.userId, cardId: card.id, sourceId: source!.id, sourceChunkId: chunks[0]!.id, sourceSnapshot: evidence });
    const noteResponse = await callApp(app, 'POST', `/sources/${source!.id}/notes`, { cookie: a.cookie, body: { title: 'My note', content: 'My own saved conclusions.' } });
    expect(noteResponse.status).toBe(200);
    const noteId = (await noteResponse.json<{ id: string }>()).id;
    const [notebook] = await db.insert(notebooks).values({ userId: a.userId, title: 'Study' }).returning();
    await db.insert(notebookSources).values({ userId: a.userId, notebookId: notebook!.id, sourceId: source!.id });
    expect((await callApp(app, 'POST', `${base}/${draft.id}/updates`, { cookie: a.cookie })).status).toBe(200);
    await runDocumentationCollection(draft.id);
    expect((await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, source!.id))).map(c => c.id)).toEqual(chunks.map(c => c.id));
    version = 2;
    expect((await callApp(app, 'POST', `${base}/${draft.id}/updates`, { cookie: a.cookie })).status).toBe(200);
    await runDocumentationCollection(draft.id);
    const [updated] = await db.select().from(sources).where(eq(sources.id, source!.id));
    expect(updated!.title).toBe('My title'); expect(updated!.tags).toEqual(['mine']);
    expect(await db.select().from(notebookSources)).toHaveLength(1);
    expect((await db.select().from(sourceReadingState))[0]!.percent).toBe(0.5);
    const changed = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, source!.id));
    expect(changed[0]!.text).toContain('Version 2');
    expect((await db.select().from(cards).where(eq(cards.id, card.id)))[0]).toEqual(beforeCard);
    const [edge] = await db.select().from(cardSources).where(eq(cardSources.cardId, card.id));
    expect(edge!.sourceId).toBe(source!.id); expect(edge!.sourceSnapshot).toEqual(evidence); expect(edge!.sourceChunkId).toBeNull();
    const note = await (await callApp(app, 'GET', `/study/notes/${noteId}`, { cookie: a.cookie })).json<{ content: string }>();
    expect(note.content).toBe('My own saved conclusions.');
    failedUrl = source!.url;
    await callApp(app, 'POST', `${base}/${draft.id}/updates`, { cookie: a.cookie }); await runDocumentationCollection(draft.id);
    expect((await summary(a.cookie, draft.id)).failed).toBe(1);
    expect((await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, source!.id))).map(c => c.id)).toEqual(changed.map(c => c.id));
  });

  test('updates add newly discovered pages once and never resurrect explicitly deleted sources', async () => {
    const a = await signUpAndCookie(app, uniqueEmail()), draft = await preview(a.cookie);
    await confirm(a.cookie, draft.id); await runDocumentationCollection(draft.id);
    const [source] = await db.select().from(sources);
    await db.delete(sources).where(eq(sources.id, source!.id));
    urls.push('https://example.com/docs/concepts/workloads/jobs');
    await callApp(app, 'POST', `${base}/${draft.id}/updates`, { cookie: a.cookie }); await runDocumentationCollection(draft.id);
    expect((await summary(a.cookie, draft.id)).deleted).toBe(1);
    expect(await db.select().from(sources)).toHaveLength(2);
    expect(await db.select().from(sources).where(eq(sources.url, source!.url!))).toHaveLength(0);
  });

  test('cancel fences late work and restart recovery resumes queued pages', async () => {
    const a = await signUpAndCookie(app, uniqueEmail()), draft = await preview(a.cookie);
    await confirm(a.cookie, draft.id);
    let resolveFetch!: (response: Response) => void;
    __setPageFetchForTests(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
    const work = runDocumentationCollection(draft.id);
    for (let i = 0; i < 100 && !resolveFetch; i++) await Bun.sleep(5);
    expect(resolveFetch).toBeDefined();
    expect((await callApp(app, 'POST', `${base}/${draft.id}/cancel`, { cookie: a.cookie })).status).toBe(200);
    resolveFetch(new Response('<html><main>Late content must not be saved.</main></html>', { headers: { 'content-type': 'text/html' } }));
    await work;
    expect(await db.select().from(sources)).toHaveLength(0);
    expect((await summary(a.cookie, draft.id)).state).toBe('cancelled');
    await db.update(libraryDocumentation).set({ state: 'running' }).where(eq(libraryDocumentation.id, draft.id));
    await recoverDocumentationImports();
    expect((await summary(a.cookie, draft.id)).state).toBe('queued');
  });

  test('expired/invalid previews and missing folders fail without partial writes', async () => {
    const a = await signUpAndCookie(app, uniqueEmail()), draft = await preview(a.cookie);
    expect((await callApp(app, 'POST', `${base}/${draft.id}/confirm`, { cookie: a.cookie, body: { title: 'Kubernetes', prefixes: ['/outside/'] } })).status).toBe(400);
    expect(await db.select().from(libraryFolders)).toHaveLength(0);
    await db.update(libraryDocumentation).set({ createdAt: new Date(Date.now() - 700_000) }).where(eq(libraryDocumentation.id, draft.id));
    expect((await callApp(app, 'POST', `${base}/${draft.id}/confirm`, { cookie: a.cookie, body: { title: 'Kubernetes', prefixes: ['/docs/'] } })).status).toBe(409);
    const fresh = await preview(a.cookie); const accepted = await confirm(a.cookie, fresh.id);
    await db.delete(libraryFolders).where(eq(libraryFolders.id, accepted.folderId));
    await runDocumentationCollection(fresh.id);
    expect((await summary(a.cookie, fresh.id)).state).toBe('attention');
    expect(await db.select().from(sources)).toHaveLength(0);
  });

  test('capacity is checked before any folder or page write', async () => {
    const a = await signUpAndCookie(app, uniqueEmail()), draft = await preview(a.cookie);
    const { env } = await import('../src/env');
    await db.insert(sources).values(Array.from({ length: env.ai.MAX_LIBRARY_ITEMS_PER_USER }, (_, i) => ({ userId: a.userId, kind: 'text', title: `Existing ${i}`, status: 'ready', verified: true })));
    const response = await callApp(app, 'POST', `${base}/${draft.id}/confirm`, { cookie: a.cookie, body: { title: 'Docs', prefixes: ['/docs/'] } });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: 'library_full' });
    expect(await db.select().from(libraryFolders)).toHaveLength(0);
    expect(await db.select().from(libraryDocumentationPages)).toHaveLength(0);
  });

  test('accepted queued imports reserve capacity and overlapping scopes reserve each URL once', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const { env } = await import('../src/env');
    await db.insert(sources).values(Array.from({ length: env.ai.MAX_LIBRARY_ITEMS_PER_USER - 2 }, (_, i) => ({ userId: a.userId, kind: 'text', title: `Existing ${i}`, status: 'ready', verified: true })));
    const first = await preview(a.cookie); await confirm(a.cookie, first.id);
    const tasksPreview = await (await callApp(app, 'POST', `${base}/preview`, { cookie: a.cookie, body: { url: 'https://example.com/docs/tasks/', locale: 'en' } })).json<{ id: string; available: number }>();
    expect(tasksPreview.available).toBe(0);
    expect((await callApp(app, 'POST', `${base}/${tasksPreview.id}/confirm`, { cookie: a.cookie, body: { title: 'Tasks', prefixes: ['/docs/tasks/'] } })).status).toBe(409);
    const overlapping = await (await callApp(app, 'POST', `${base}/preview`, { cookie: a.cookie, body: { url: 'https://example.com/docs/concepts/workloads/', locale: 'en' } })).json<{ id: string; sections: { prefix: string; newPageCount: number }[] }>();
    expect(overlapping.sections.find(s => s.prefix === '/docs/concepts/workloads/')?.newPageCount).toBe(0);
    expect((await callApp(app, 'POST', `${base}/${overlapping.id}/confirm`, { cookie: a.cookie, body: { title: 'Workloads', prefixes: ['/docs/concepts/workloads/'] } })).status).toBe(200);
    await runDocumentationCollection(first.id); await runDocumentationCollection(overlapping.id);
    expect(await db.select().from(sources)).toHaveLength(env.ai.MAX_LIBRARY_ITEMS_PER_USER);
  });

  test('reuses canonical existing URL sources without moving them and rejects duplicate connections', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const [folder] = await db.insert(libraryFolders).values({ userId: a.userId, name: 'My folder' }).returning();
    const [source] = await db.insert(sources).values({ userId: a.userId, kind: 'url', url: `${urls[0]}/#section`, title: 'My source', folderId: folder!.id, status: 'ready', verified: true }).returning();
    const draft = await preview(a.cookie); await confirm(a.cookie, draft.id); await runDocumentationCollection(draft.id);
    expect(await db.select().from(sources)).toHaveLength(2);
    const [same] = await db.select().from(sources).where(eq(sources.id, source!.id));
    expect(same!.folderId).toBe(folder!.id); expect(same!.title).toBe('My source');
    const second = await preview(a.cookie);
    const response = await callApp(app, 'POST', `${base}/${second.id}/confirm`, { cookie: a.cookie, body: { title: 'Duplicate', prefixes: ['/docs/'] } });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: 'documentation_already_connected' });
  });

  test('an empty or missing remote page retains source content and sibling imports succeed', async () => {
    const a = await signUpAndCookie(app, uniqueEmail()), draft = await preview(a.cookie);
    await confirm(a.cookie, draft.id); await runDocumentationCollection(draft.id);
    const [source] = await db.select().from(sources);
    const old = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, source!.id));
    urls = urls.filter(url => url !== source!.url);
    await callApp(app, 'POST', `${base}/${draft.id}/updates`, { cookie: a.cookie }); await runDocumentationCollection(draft.id);
    expect((await summary(a.cookie, draft.id)).failed).toBe(1);
    expect((await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, source!.id))).map(c => c.id)).toEqual(old.map(c => c.id));
    const errors = await (await callApp(app, 'GET', `${base}/${draft.id}/errors`, { cookie: a.cookie })).json<{ items: { errorCode: string }[] }>();
    expect(errors.items[0]!.errorCode).toBe('remote_missing');
  });

  test('nested exclusions remain selected correctly during subsequent synchronization', async () => {
    urls.push('https://example.com/docs/concepts/networking/services');
    const a = await signUpAndCookie(app, uniqueEmail()), draft = await preview(a.cookie);
    await confirm(a.cookie, draft.id, ['/docs/', '!/docs/concepts/workloads/']); await runDocumentationCollection(draft.id);
    expect(await db.select().from(sources)).toHaveLength(2);
    urls.push('https://example.com/docs/concepts/workloads/jobs');
    await callApp(app, 'POST', `${base}/${draft.id}/updates`, { cookie: a.cookie }); await runDocumentationCollection(draft.id);
    expect(await db.select().from(sources)).toHaveLength(2);
  });

  test('disconnect is owner-scoped and leaves imported sources, folders and text intact', async () => {
    const a = await signUpAndCookie(app, uniqueEmail()), b = await signUpAndCookie(app, uniqueEmail());
    const draft = await preview(a.cookie); await confirm(a.cookie, draft.id); await runDocumentationCollection(draft.id);
    const saved = await db.select().from(sources), folders = await db.select().from(libraryFolders), chunks = await db.select().from(sourceChunks);
    expect((await callApp(app, 'DELETE', `${base}/${draft.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await callApp(app, 'DELETE', `${base}/${draft.id}`, { cookie: a.cookie })).status).toBe(200);
    expect((await callApp(app, 'GET', `${base}/${draft.id}`, { cookie: a.cookie })).status).toBe(404);
    expect((await db.select().from(sources)).map(s => s.id)).toEqual(saved.map(s => s.id));
    expect((await db.select().from(sourceChunks)).map(c => c.id)).toEqual(chunks.map(c => c.id));
    expect((await db.select().from(libraryFolders)).map(f => f.id)).toEqual(folders.map(f => f.id));
  });
});
