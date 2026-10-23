import { afterEach, beforeEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, ensureBuiltins, cardSources, cards, libraryFolders, sources, sourceChunks } from '@reomi/db';
import { newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app';
import { __setPageFetchForTests } from '../src/ai/page-reader';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp();
beforeEach(resetTestDb);
afterEach(() => __setPageFetchForTests(null));
async function learner(scope = 'capture') {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const response = await callApp(app, 'POST', '/profile/tokens', { cookie: owner.cookie, body: { name: 'Browser', scope } });
  expect(response.status).toBe(200);
  return { ...owner, ...await response.json<{ token: string; item: { id: string } }>() };
}
function payload(overrides: Record<string, unknown> = {}) {
  return { requestKey: newUuidV7(), url: 'https://example.com/article#chapter', title: 'Rendered article',
    text: 'Pods group containers. This is the visible passage captured by the learner.', mode: 'selection', ...overrides };
}
const capture = (token: string, body = payload()) => callApp(app, 'POST', '/extension/captures', { headers: { authorization: `Bearer ${token}` }, body });

test('capture credentials are revocable and cannot read MCP, general REST or credentials', async () => {
  const a = await learner();
  expect((await callApp(app, 'GET', '/extension/connection', { headers: { authorization: `Bearer ${a.token}` } })).status).toBe(200);
  expect((await callApp(app, 'GET', '/extension/connection', { cookie: a.cookie })).status).toBe(401);
  expect((await callApp(app, 'POST', '/mcp', { headers: { authorization: `Bearer ${a.token}` }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status).toBe(401);
  expect((await callApp(app, 'GET', '/library', { headers: { authorization: `Bearer ${a.token}` } })).status).toBe(401);
  expect((await callApp(app, 'GET', '/profile/tokens', { headers: { authorization: `Bearer ${a.token}` } })).status).toBe(401);
  const reader = await learner('read'); expect((await capture(reader.token)).status).toBe(401);
  await callApp(app, 'DELETE', `/profile/tokens/${a.item.id}`, { cookie: a.cookie });
  expect((await capture(a.token)).status).toBe(401);
});

test('capture persists readable chunks atomically in the ordinary browser folder without refetch or AI', async () => {
  const a = await learner();
  __setPageFetchForTests(async () => { throw new Error('Capture must not fetch the remote page'); });
  const response = await capture(a.token); expect(response.status).toBe(200);
  const receipt = await response.json<{ receiptId: string; sourceId: string; readerUrl: string }>();
  const [source] = await db.select().from(sources);
  const [folder] = await db.select().from(libraryFolders);
  expect(source).toMatchObject({ id: receipt.sourceId, kind: 'url', userId: a.userId, folderId: folder!.id, status: 'indexing' });
  expect(folder!.purpose).toBe('browser'); expect(source!.url).toBe('https://example.com/article');
  expect((await db.select().from(sourceChunks)).map(c => c.text).join(' ')).toContain('Pods group containers.');
  expect(receipt.readerUrl).toBe(`/library/${source!.id}?capture=${receipt.receiptId}`);
});

test('concurrent retries resolve once, changed arguments conflict, identical snapshots reuse without moving', async () => {
  const a = await learner(), body = payload();
  const responses = await Promise.all([capture(a.token, body), capture(a.token, body)]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  const [first, replay] = await Promise.all(responses.map(r => r.json<{ receiptId: string; sourceId: string }>()));
  expect(first).toEqual(replay); expect(await db.select().from(sources)).toHaveLength(1);
  expect((await capture(a.token, { ...body, text: 'Changed text' })).status).toBe(409);
  const [folder] = await db.insert(libraryFolders).values({ userId: a.userId, name: 'Another folder' }).returning();
  const again = await capture(a.token, { ...body, requestKey: newUuidV7(), folderId: folder!.id });
  expect(again.status).toBe(200); expect((await again.json<{ sourceId: string }>()).sourceId).toBe(first!.sourceId);
  expect((await db.select().from(sources))[0]!.folderId).not.toBe(folder!.id);
});

test('deleted receipts never resurrect; an explicit new save and changed text create new snapshots', async () => {
  const a = await learner(), body = payload();
  const receipt = await (await capture(a.token, body)).json<{ receiptId: string; sourceId: string }>();
  const changed = await capture(a.token, payload({ text: 'A changed version stays separate from the original study source.' }));
  expect(changed.status).toBe(200); expect(await db.select().from(sources)).toHaveLength(2);
  await db.delete(sources).where(eq(sources.id, receipt.sourceId));
  expect((await capture(a.token, body)).status).toBe(410);
  expect((await capture(a.token, { ...body, requestKey: newUuidV7() })).status).toBe(200);
  expect(await db.select().from(sources)).toHaveLength(2);
});

test('invalid destinations, limits and payloads never partially create a source or default folder', async () => {
  const a = await learner(), b = await learner();
  const [foreign] = await db.insert(libraryFolders).values({ userId: b.userId, name: 'Private' }).returning();
  expect((await capture(a.token, payload({ folderId: foreign!.id }))).status).toBe(404);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:password@example.com/'])
    expect((await capture(a.token, payload({ url }))).status).toBe(400);
  expect((await capture(a.token, payload({ text: ' '.repeat(20) }))).status).toBe(400);
  expect((await capture(a.token, payload({ text: 'x'.repeat(200001) }))).status).toBe(400);
  const { env } = await import('../src/env');
  await db.insert(sources).values(Array.from({ length: env.ai.MAX_LIBRARY_ITEMS_PER_USER }, (_, i) => ({ userId: a.userId, kind: 'text' as const, title: `Existing ${i}`, status: 'ready' as const })));
  expect((await capture(a.token)).status).toBe(409);
  expect(await db.select().from(libraryFolders).where(eq(libraryFolders.userId, a.userId))).toHaveLength(0);
  expect(await db.select().from(sourceChunks)).toHaveLength(0);
});

test('card handoff is session-owned and rejects changed or deleted source evidence', async () => {
  const a = await learner(), b = await learner(), body = payload();
  const saved = await (await capture(a.token, body)).json<{ receiptId: string; sourceId: string }>();
  const path = `/library/captures/${saved.receiptId}`;
  expect((await callApp(app, 'GET', path, { cookie: b.cookie })).status).toBe(404);
  expect((await callApp(app, 'GET', path, { headers: { authorization: `Bearer ${a.token}` } })).status).toBe(401);
  const own = await callApp(app, 'GET', path, { cookie: a.cookie }); expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({ sourceId: saved.sourceId, quote: body.text });
  await db.update(sourceChunks).set({ text: 'Changed source text' }).where(eq(sourceChunks.sourceId, saved.sourceId));
  expect((await callApp(app, 'GET', path, { cookie: a.cookie })).status).toBe(409);
  const fresh = await capture(a.token, payload()); expect(fresh.status).toBe(200);
  expect((await fresh.json<{ sourceId: string }>()).sourceId).not.toBe(saved.sourceId);
});

test('reviewed card handoff stores source evidence and rejects text changed after opening the editor', async () => {
  await ensureBuiltins(db);
  const a = await learner();
  const saved = await (await capture(a.token)).json<{ receiptId: string; sourceId: string }>();
  const handoff = await (await callApp(app, 'GET', `/library/captures/${saved.receiptId}`, { cookie: a.cookie })).json<{ quote: string; textSelection: unknown }>();
  const deck = await (await callApp(app, 'POST', '/decks', { cookie: a.cookie, body: { name: 'Browser study' } })).json<{ id: string }>();
  const body = { deckId: deck.id, front: 'What do Pods group?', back: 'Containers.', quote: handoff.quote, textSelection: handoff.textSelection };
  const created = await callApp(app, 'POST', `/sources/${saved.sourceId}/quick-card`, { cookie: a.cookie, body });
  expect(created.status, JSON.stringify(await created.json())).toBe(200);
  const [edge] = await db.select().from(cardSources);
  expect(edge!.sourceId).toBe(saved.sourceId); expect(edge!.sourceSnapshot?.quote).toBe(handoff.quote);
  await db.update(sourceChunks).set({ text: 'Updated after opening the draft' }).where(eq(sourceChunks.sourceId, saved.sourceId));
  expect((await callApp(app, 'POST', `/sources/${saved.sourceId}/quick-card`, { cookie: a.cookie, body })).status).toBe(409);
  expect(await db.select().from(cards)).toHaveLength(1);
});
