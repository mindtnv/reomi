import { beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { db, sources, sourceChunks, decks, cards, cardSources, ensureBuiltins } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';
const app = buildApp();
beforeEach(async () => { await resetTestDb(); await ensureBuiltins(db); });
async function fixture() {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const [deck] = await db.insert(decks).values({ userId, name: 'Study' }).returning();
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title: 'Original title', status: 'ready' }).returning();
  const chunks = await db.insert(sourceChunks).values(['Unrelated before', 'A **Pod** groups containers.', 'Unrelated after'].map((text, position) => ({ userId, sourceId: source!.id, position, text }))).returning();
  const chunk = chunks[1]!;
  const hash = createHash('sha256').update(chunk.text).digest('hex');
  const textSelection = { version: 1, quote: 'Pod groups containers.', chunks: [{ chunkId: chunk.id, textHash: hash, renderedHash: hash, start: 2, end: 24 }] };
  const save = (selection = textSelection) => callApp(app, 'POST', `/sources/${source!.id}/quick-card`, { cookie, body: { deckId: deck!.id, front: 'What is a Pod?', back: 'A group of containers', quote: selection.quote, textSelection: selection } });
  return { cookie, userId, source: source!, chunk, textSelection, save };
}
test('manual text cards retain only selected chunks and the historical selection after source deletion', async () => {
  const f = await fixture();
  const response = await f.save(); expect(response.status).toBe(200);
  const result = await response.json<any>();
  const links = await db.select().from(cardSources).where(eq(cardSources.cardId, result.cardIds[0]));
  expect(links).toHaveLength(1);
  expect(links[0]!.sourceChunkId).toBe(f.chunk.id);
  expect(links[0]!.sourceSnapshot).toMatchObject({ kind: 'user_selection', quote: f.textSelection.quote, sourceTitle: 'Original title', selection: f.textSelection });
  await db.delete(sources).where(eq(sources.id, f.source.id));
  const detail = await (await callApp(app, 'GET', `/cards/${result.cardIds[0]}/sources`, { cookie: f.cookie })).json<any>();
  expect(JSON.stringify(detail)).toContain('Original title');
  expect(JSON.stringify(detail)).toContain('Pod groups containers.');
});
test('stale and foreign text selection anchors fail atomically instead of linking replacement content', async () => {
  const a = await fixture(), b = await fixture();
  expect((await a.save(b.textSelection)).status).toBe(400);
  await db.update(sourceChunks).set({ text: 'Replacement content' }).where(eq(sourceChunks.id, a.chunk.id));
  expect((await a.save()).status).toBe(409);
  expect(await db.select().from(cards).where(eq(cards.userId, a.userId))).toHaveLength(0);
  expect(await db.select().from(cardSources).where(eq(cardSources.userId, a.userId))).toHaveLength(0);
});


test('a maximum-sized unanchored quote retains source-only evidence without fabricated geometry', async () => {
  const f = await fixture();
  const quote = 'Q'.repeat(4000);
  const response = await f.save({ version: 1, quote, chunks: [] });
  expect(response.status).toBe(200);
  const result = await response.json<any>();
  const [link] = await db.select().from(cardSources).where(eq(cardSources.cardId, result.cardIds[0]));
  expect(link!.sourceChunkId).toBeNull();
  expect(link!.sourceSnapshot).toMatchObject({ kind: 'user_quote', quote, sourceTitle: 'Original title' });
  expect(link!.sourceSnapshot?.page).toBeUndefined();
});

test('a PDF selection keeps its exact quote and page without attributing neighbouring page chunks', async () => {
  const f = await fixture();
  const [source] = await db.update(sources).set({ kind: 'pdf', pageCount: 8 }).where(eq(sources.id, f.source.id)).returning();
  await db.update(sourceChunks).set({ page: 3 }).where(eq(sourceChunks.sourceId, source!.id));
  const [deck] = await db.select().from(decks).where(eq(decks.userId, f.userId));
  const pdfSelection = { version: 1, page: 3, quote: 'Selected PDF text', sourceVersion: source!.updatedAt.toISOString() };
  const save = () => callApp(app, 'POST', `/sources/${source!.id}/quick-card`, { cookie: f.cookie, body: { deckId: deck!.id, front: 'Question', back: 'Answer', page: 3, quote: pdfSelection.quote, pdfSelection } });
  const response = await save(); expect(response.status).toBe(200);
  const result = await response.json<any>();
  const links = await db.select().from(cardSources).where(eq(cardSources.cardId, result.cardIds[0]));
  expect(links).toHaveLength(1); expect(links[0]!.sourceChunkId).toBeNull();
  expect(links[0]!.sourceSnapshot).toMatchObject({ kind: 'user_quote', quote: 'Selected PDF text', page: 3 });
  const readLink = async () => (await (await callApp(app, 'GET', `/cards/${result.cardIds[0]}/sources`, { cookie: f.cookie })).json<any>()).items[0];
  expect(await readLink()).toMatchObject({ page: 3, snippet: 'Selected PDF text', locationAvailable: true });
  await db.update(sources).set({ updatedAt: new Date(source!.updatedAt.getTime() + 1000) }).where(eq(sources.id, source!.id));
  expect((await save()).status).toBe(409);
  expect(await db.select().from(cards).where(eq(cards.userId, f.userId))).toHaveLength(1);
  expect((await readLink()).locationAvailable).toBe(false);
  await db.delete(sources).where(eq(sources.id, source!.id));
  expect(await readLink()).toMatchObject({ sourceId: null, sourceTitle: 'Original title', snippet: 'Selected PDF text', page: 3, locationAvailable: false });
});
