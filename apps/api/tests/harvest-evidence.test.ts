import { afterEach, beforeEach, expect, test } from 'bun:test';
import { db, sources, sourceMarks, sourceAnnotations, decks, cards, cardSources, ensureBuiltins } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { __setAiClientForTests, __resetAiClientForTests } from '../src/ai/openai-client';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';
const app = buildApp();
beforeEach(async () => { await resetTestDb(); await ensureBuiltins(db); });
afterEach(__resetAiClientForTests);
async function fixture() {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId, title: 'Harvest origin', kind: 'pdf', pageCount: 8, status: 'ready' }).returning();
  const [deck] = await db.insert(decks).values({ userId, name: 'Study' }).returning();
  const marks = await db.insert(sourceMarks).values(['First marked quote', 'Excluded quote'].map((quote, index) => ({ userId, sourceId: source!.id, page: index + 1, quote, kind: 'highlight', color: 'yellow', rects: [{ x: 0, y: 0, w: .2, h: .1 }] }))).returning();
  await db.insert(sourceAnnotations).values({ userId, sourceId: source!.id, page: 3, strokes: [], markedText: 'Ink quote' });
  __setAiClientForTests({ async *chatStreamAgentic() { yield { type: 'finish', reason: 'stop' }; }, async complete(messages) {
    const text = String(messages.find(message => message.role === 'user')?.content);
    return JSON.stringify([...text.matchAll(/ref="([^"]+)"/g)].map(match => ({ originRef: match[1], front: `Question ${match[1]}`, back: 'Answer' })));
  } });
  const generated = await callApp(app, 'POST', `/sources/${source!.id}/harvest-cards`, { cookie, body: {} });
  expect(generated.status).toBe(200);
  const { candidates } = await generated.json<any>();
  const apply = (entries = candidates) => callApp(app, 'POST', `/sources/${source!.id}/harvest-cards/apply`, { cookie, body: { deckId: deck!.id, cards: entries } });
  return { cookie, userId, source: source!, marks, candidates, apply };
}
test('harvest persists only each included origin quote and ignores client-supplied replacement provenance', async () => {
  const f = await fixture();
  expect(f.candidates[0].evidence).toBeDefined();
  const included = [f.candidates[0], f.candidates[2]].map(candidate => ({ ...candidate, page: 8, quote: 'Forged quote' }));
  const response = await f.apply(included); expect(response.status).toBe(200);
  const result = await response.json<any>(); expect(result.created).toBe(2);
  const links = await db.select().from(cardSources).where(eq(cardSources.userId, f.userId));
  expect(links.map(link => link.sourceSnapshot?.quote).sort()).toEqual(['First marked quote', 'Ink quote'].sort());
  expect(links.map(link => link.sourceSnapshot?.page).sort()).toEqual([1, 3]);
  const [excluded] = await db.select().from(sourceMarks).where(eq(sourceMarks.id, f.marks[1]!.id)); expect(excluded!.harvestedAt).toBeNull();
  expect((await (await f.apply(included)).json<any>()).created).toBe(0);
  await db.delete(sources).where(eq(sources.id, f.source.id));
  expect((await db.select().from(cardSources).where(eq(cardSources.userId, f.userId))).map(link => link.sourceSnapshot?.sourceTitle)).toEqual(['Harvest origin', 'Harvest origin']);
});
test('changed markup rejects the entire harvest and rolls back every origin claim and card', async () => {
  const f = await fixture();
  await db.update(sourceMarks).set({ quote: 'Edited after generation' }).where(eq(sourceMarks.id, f.marks[1]!.id));
  expect((await f.apply()).status).toBe(409);
  expect(await db.select().from(cards).where(eq(cards.userId, f.userId))).toHaveLength(0);
  expect((await db.select().from(sourceMarks).where(eq(sourceMarks.userId, f.userId))).every(mark => !mark.harvestedAt)).toBe(true);
  expect((await db.select().from(sourceAnnotations).where(eq(sourceAnnotations.userId, f.userId)))[0]!.harvestedAt).toBeNull();
});

test('a changed source version rejects harvest before committing any origin or card', async () => {
  const f = await fixture();
  await db.update(sources).set({ updatedAt: new Date(f.source.updatedAt.getTime() + 1000) }).where(eq(sources.id, f.source.id));
  const response = await f.apply();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'harvest_evidence_stale' });
  expect(await db.select().from(cards).where(eq(cards.userId, f.userId))).toHaveLength(0);
  expect((await db.select().from(sourceMarks).where(eq(sourceMarks.userId, f.userId))).every(mark => !mark.harvestedAt)).toBe(true);
});
