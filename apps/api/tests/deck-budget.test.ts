import { beforeEach, describe, expect, test } from 'bun:test';
import { cards, db, deckOptionsPreset, decks as decksTable, profile } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

async function deck(cookie: string, name: string, parentId?: string) {
  const response = await callApp(app, 'POST', '/decks', {
    cookie,
    body: { name, ...(parentId ? { parentId } : {}) },
  });
  expect(response.status).toBe(200);
  return (await response.json<{ id: string }>()).id;
}

async function bind(userId: string, deckId: string, name: string, fields: { newPerDay?: number; reviewsPerDay?: number }) {
  const [preset] = await db.insert(deckOptionsPreset).values({ userId, name, ...fields }).returning();
  await db.update(decksTable).set({ presetId: preset!.id }).where(eq(decksTable.id, deckId));
}

async function seedNew(cookie: string, deckId: string, count: number, prefix: string) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await seedBasicCard(app, cookie, { deckId, front: `${prefix}-${i}` })).id);
  return ids;
}

function fromDeck(rows: { deckId: string }[], deckId: string) {
  return rows.filter((row) => row.deckId === deckId).length;
}

async function queue(cookie: string, deckId?: string) {
  const path = deckId ? `/cards/queue?deckId=${deckId}` : '/cards/queue';
  const response = await callApp(app, 'GET', path, { cookie });
  expect(response.status).toBe(200);
  return response.json<{ new: { id: string; deckId: string }[]; due: { id: string }[]; summary: { availableNew: number; newRemaining: number; totalAvailable: number } }>();
}

async function summary(cookie: string) {
  const response = await callApp(app, 'GET', '/cards/study-summary', { cookie });
  expect(response.status).toBe(200);
  return response.json<{ overall: { availableNew: number; newRemaining: number }; decks: Record<string, { availableNew: number; newRemaining: number }> }>();
}

describe('deck budgets', () => {
  beforeEach(resetTestDb);

  test('sibling decks of 10 keep separate new budgets, and study-all matches the summary', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('siblings'));
    await callApp(app, 'GET', '/profile', { cookie });
    const a = await deck(cookie, 'A');
    const b = await deck(cookie, 'B');
    await bind(userId, a, 'A', { newPerDay: 10 });
    await bind(userId, b, 'B', { newPerDay: 10 });
    const aIds = await seedNew(cookie, a, 12, 'a');
    await seedNew(cookie, b, 12, 'b');

    const beforeA = await queue(cookie, a);
    const beforeB = await queue(cookie, b);
    const beforeAll = await queue(cookie);
    const beforeSummary = await summary(cookie);
    expect(beforeA.new).toHaveLength(10);
    expect(beforeB.new).toHaveLength(10);
    expect(fromDeck(beforeAll.new, a)).toBe(10);
    expect(fromDeck(beforeAll.new, b)).toBe(10);
    expect(beforeAll.summary.availableNew).toBe(20);
    expect(beforeSummary.overall.availableNew).toBe(20);
    expect(beforeSummary.decks[a]!.availableNew).toBe(10);
    expect(beforeSummary.decks[b]!.availableNew).toBe(10);
    expect(beforeA.summary.availableNew).toBe(beforeSummary.decks[a]!.availableNew);
    expect(beforeAll.summary.availableNew).toBe(beforeSummary.overall.availableNew);

    for (const id of aIds.slice(0, 10)) {
      expect((await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: id, rating: 3 } })).status).toBe(200);
    }
    const afterB = await queue(cookie, b);
    const afterAll = await queue(cookie);
    const afterSummary = await summary(cookie);
    expect(afterB.new).toHaveLength(10);
    expect(fromDeck(afterAll.new, a)).toBe(0);
    expect(fromDeck(afterAll.new, b)).toBe(10);
    expect(afterSummary.decks[a]!.availableNew).toBe(0);
    expect(afterSummary.decks[b]!.availableNew).toBe(10);
    expect(afterSummary.overall.availableNew).toBe(10);
    expect(afterAll.summary.availableNew).toBe(10);
  });

  test('a parent limit of 15 constrains children of 10 on the parent queue and on study-all', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('parent'));
    await callApp(app, 'GET', '/profile', { cookie });
    const parent = await deck(cookie, 'Parent');
    const a = await deck(cookie, 'A', parent);
    const b = await deck(cookie, 'B', parent);
    await bind(userId, parent, 'Parent', { newPerDay: 15 });
    await bind(userId, a, 'A', { newPerDay: 10 });
    await bind(userId, b, 'B', { newPerDay: 10 });
    const aIds = await seedNew(cookie, a, 12, 'a');
    await seedNew(cookie, b, 12, 'b');

    const parentQueue = await queue(cookie, parent);
    const all = await queue(cookie);
    const listed = await summary(cookie);
    expect(fromDeck(parentQueue.new, a)).toBe(10);
    expect(fromDeck(parentQueue.new, b)).toBe(5);
    expect(fromDeck(all.new, a)).toBe(10);
    expect(fromDeck(all.new, b)).toBe(5);
    expect((await queue(cookie, a)).new).toHaveLength(10);
    expect((await queue(cookie, b)).new).toHaveLength(10);
    expect(listed.overall.availableNew).toBe(15);
    expect(listed.decks[parent]!.availableNew).toBe(15);
    expect(listed.decks[a]!.availableNew).toBe(10);
    expect(listed.decks[b]!.availableNew).toBe(10);
    expect(parentQueue.summary.availableNew).toBe(15);
    expect(all.summary.availableNew).toBe(15);

    for (const id of aIds.slice(0, 10)) {
      expect((await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: id, rating: 3 } })).status).toBe(200);
    }
    const afterParent = await queue(cookie, parent);
    const afterAll = await queue(cookie);
    const after = await summary(cookie);
    expect(fromDeck(afterParent.new, a)).toBe(0);
    expect(fromDeck(afterParent.new, b)).toBe(5);
    expect(fromDeck(afterAll.new, b)).toBe(5);
    expect((await queue(cookie, b)).new).toHaveLength(5);
    expect(after.decks[a]!.availableNew).toBe(0);
    expect(after.decks[b]!.availableNew).toBe(5);
    expect(after.decks[parent]!.availableNew).toBe(5);
    expect(after.overall.availableNew).toBe(5);
    expect(afterAll.summary.availableNew).toBe(5);
  });

  test('one remaining new introduction admits one of two concurrent grades', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('race'));
    await callApp(app, 'GET', '/profile', { cookie });
    const id = await deck(cookie, 'Solo');
    await bind(userId, id, 'Solo', { newPerDay: 1 });
    const [first, second] = await seedNew(cookie, id, 2, 'n');
    const [left, right] = await Promise.all([
      callApp(app, 'POST', '/reviews', { cookie, body: { cardId: first, rating: 3 } }),
      callApp(app, 'POST', '/reviews', { cookie, body: { cardId: second, rating: 3 } }),
    ]);
    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([200, 409]);
    const rejected = left.status === 409 ? left : right;
    expect(await rejected.json()).toEqual({ error: 'daily_limit' });
    const [row] = await db.select().from(profile).where(eq(profile.userId, userId));
    expect(row!.newIntroducedToday).toBe(1);
    const remaining = await db.select().from(cards).where(eq(cards.userId, userId));
    expect(remaining.filter((card) => card.state === 'new')).toHaveLength(1);
    expect((await queue(cookie, id)).new).toHaveLength(0);
  });

  test('one remaining review admits one of two concurrent grades', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('review-race'));
    await callApp(app, 'GET', '/profile', { cookie });
    const id = await deck(cookie, 'Solo');
    await bind(userId, id, 'Solo', { reviewsPerDay: 1 });
    const seeded = await seedNew(cookie, id, 2, 'r');
    await db.update(cards).set({ state: 'review', due: new Date(Date.now() - 60_000) }).where(eq(cards.userId, userId));
    const [left, right] = await Promise.all(seeded.map((cardId) =>
      callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 3 } })));
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const rejected = left.status === 409 ? left : right;
    expect(await rejected.json()).toEqual({ error: 'daily_limit' });
    const [row] = await db.select().from(profile).where(eq(profile.userId, userId));
    expect(row!.reviewsDoneToday).toBe(1);
    expect(row!.newIntroducedToday).toBe(0);
  });
});
