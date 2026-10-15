import { beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, sources, sourceChunks } from '@reomi/db';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';
const app = buildApp(); beforeEach(resetTestDb);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title: 'Documentation', status: 'ready' }).returning();
  const [chunk] = await db.insert(sourceChunks).values({ userId, sourceId: source!.id, position: 0, text: 'A **Pod** groups containers.' }).returning();
  const selection = { version: 1, quote: 'Pod', chunks: [{ chunkId: chunk!.id, textHash: hash(chunk!.text), renderedHash: hash('A Pod groups containers.'), start: 2, end: 5 }] };
  return { cookie, userId, source: source!, chunk: chunk!, selection };
}
test('text marks persist their quote and become unavailable after reingestion without pointing elsewhere', async () => {
  const f = await fixture();
  const result = await callApp(app, 'POST', `/sources/${f.source.id}/text-marks`, { cookie: f.cookie, body: { kind: 'note', selection: f.selection, note: 'Remember Pods' } });
  expect(result.status).toBe(200); const mark = await result.json<any>();
  expect(mark.selection).toEqual(f.selection); expect(mark.anchorStatus).toBe('anchored');
  await db.delete(sourceChunks).where(eq(sourceChunks.id, f.chunk.id));
  await db.insert(sourceChunks).values({ userId: f.userId, sourceId: f.source.id, position: 0, text: 'A completely different section' });
  const listing = await callApp(app, 'GET', `/sources/${f.source.id}/text-marks`, { cookie: f.cookie });
  const retained = (await listing.json<any>()).items[0];
  expect(retained.id).toBe(mark.id); expect(retained.anchorStatus).toBe('unavailable'); expect(retained.selection.quote).toBe('Pod');
  const edited = await callApp(app, 'PATCH', `/sources/${f.source.id}/text-marks/${mark.id}`, { cookie: f.cookie, body: { note: 'Revised note' } });
  expect(edited.status).toBe(200); expect((await edited.json<any>()).note).toBe('Revised note');
  expect((await callApp(app, 'DELETE', `/sources/${f.source.id}/text-marks/${mark.id}`, { cookie: f.cookie })).status).toBe(200);
});
test('forged chunk parents, stale versions and another owner fail without creating a mark', async () => {
  const a = await fixture(), b = await fixture();
  const post = (cookie: string, selection: unknown) => callApp(app, 'POST', `/sources/${a.source.id}/text-marks`, { cookie, body: { kind: 'highlight', selection } });
  expect((await post(b.cookie,a.selection)).status).toBe(404);
  expect((await post(a.cookie,b.selection)).status).toBe(400);
  expect((await post(a.cookie,{ ...a.selection, chunks: [{ ...a.selection.chunks[0], textHash: hash('changed') }] })).status).toBe(409);
  const fallback = await post(a.cookie,{ version: 1, quote: 'User-supplied quote', chunks: [] });
  expect(fallback.status).toBe(200); const mark = await fallback.json<any>(); expect(mark.anchorStatus).toBe('quote_only');
  for (const method of ['GET','PATCH','DELETE'] as const) {
    const path = `/sources/${a.source.id}/text-marks${method === 'GET' ? '' : `/${mark.id}`}`;
    const result = await callApp(app, method, path, { cookie: b.cookie, ...(method === 'PATCH' ? { body: { note: 'Changed' } } : {}) });
    expect(result.status).toBe(404); expect(await result.text()).not.toContain('User-supplied quote');
  }
});

for (const kind of ['text', 'url', 'epub']) test(`readable ${kind} sources share persistent selection and note actions`, async () => {
  const f = await fixture();
  await db.update(sources).set({ kind }).where(eq(sources.id, f.source.id));
  const saved = await callApp(app, 'POST', `/sources/${f.source.id}/text-marks`, { cookie: f.cookie,
    body: { kind: 'note', selection: f.selection, note: 'My retained annotation' } });
  expect(saved.status).toBe(200); const mark = await saved.json<any>();
  const page = await (await callApp(app, 'GET', `/sources/${f.source.id}/text-marks`, { cookie: f.cookie })).json<any>();
  expect(page.items[0]).toMatchObject({ id: mark.id, kind: 'note', note: 'My retained annotation', anchorStatus: 'anchored', selection: f.selection });
  expect(page.items[0].selection).not.toHaveProperty('rects'); expect(page.items[0].selection).not.toHaveProperty('page');
});
