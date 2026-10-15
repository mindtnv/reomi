import { beforeEach, describe, expect, test } from 'bun:test';
import { cards, db, profile } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

async function setup() {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  await callApp(app, 'GET', '/profile', { cookie });
  const deck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Study' } })).json<{ id: string }>();
  return { cookie, userId, deckId: deck.id };
}

describe('study queue', () => {
  beforeEach(resetTestDb);

  test('due learning steps remain available after the mature-review budget runs out', async () => {
    const { cookie, userId, deckId } = await setup();
    const ids: string[] = [];
    for (const state of ['learning', 'relearning', 'review'] as const) {
      const card = await seedBasicCard(app, cookie, { deckId, front: state });
      await db.update(cards).set({ state, due: new Date(Date.now() - 60_000) }).where(eq(cards.id, card.id));
      ids.push(card.id);
    }
    await db.update(profile).set({ reviewsDoneToday: 200, dailyCountsDate: new Date().toISOString().slice(0, 10) })
      .where(eq(profile.userId, userId));
    const result = await callApp(app, 'GET', '/cards/queue', { cookie });
    expect(result.status).toBe(200);
    const queue = await result.json<any>();
    expect(queue.due.map((c: any) => c.id)).toEqual(ids.slice(0, 2));
  });

  test('learning has priority and equal timestamps use stable card IDs', async () => {
    const { cookie, deckId } = await setup();
    const due = new Date(Date.now() - 60_000);
    const mature = await seedBasicCard(app, cookie, { deckId, front: 'Old review' });
    await db.update(cards).set({ state: 'review', due: new Date(due.getTime() - 60_000) }).where(eq(cards.id, mature.id));
    const a = await seedBasicCard(app, cookie, { deckId, front: 'A' });
    const b = await seedBasicCard(app, cookie, { deckId, front: 'B' });
    // Update in reverse physical order to avoid relying on insertion order.
    await db.update(cards).set({ state: 'learning', due }).where(eq(cards.id, b.id));
    await db.update(cards).set({ state: 'learning', due }).where(eq(cards.id, a.id));
    const freshA = await seedBasicCard(app, cookie, { deckId, front: 'New A' });
    const freshB = await seedBasicCard(app, cookie, { deckId, front: 'New B' });
    await db.update(cards).set({ createdAt: due }).where(eq(cards.id, freshB.id));
    await db.update(cards).set({ createdAt: due }).where(eq(cards.id, freshA.id));
    const queue = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queue.due.map((c: any) => c.id)).toEqual([...[a.id, b.id].sort(), mature.id]);
    expect(queue.new.map((c: any) => c.id)).toEqual([freshA.id, freshB.id].sort());
  });

  test('queue rejects fractional, negative and malformed limits as input errors', async () => {
    const { cookie } = await setup();
    for (const value of ['-1', '1.5', 'NaN', 'Infinity', 'word', '']) {
      for (const field of ['newLimit', 'reviewLimit']) {
        const response = await callApp(app, 'GET', `/cards/queue?${field}=${value}`, { cookie });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'invalid_limit' });
      }
    }
  });

  test('malformed or conflicting scope links fail as input errors', async () => {
    const { cookie, deckId } = await setup();
    expect((await callApp(app, 'GET', '/cards/queue?filteredDeckId=invalid', { cookie })).status).toBe(400);
    expect((await callApp(app, 'GET', `/cards/queue?deckId=${deckId}&filteredDeckId=${deckId}`, { cookie })).status).toBe(400);
  });

  test('zero disables introductions and mature reviews, but never learning', async () => {
    const { cookie, deckId } = await setup();
    await seedBasicCard(app, cookie, { deckId, front: 'New' });
    const learning = await seedBasicCard(app, cookie, { deckId, front: 'Learning' });
    await db.update(cards).set({ state: 'learning', due: new Date(Date.now() - 60_000) }).where(eq(cards.id, learning.id));
    const queue = await (await callApp(app, 'GET', '/cards/queue?newLimit=0&reviewLimit=0', { cookie })).json<any>();
    expect(queue.new).toEqual([]);
    expect(queue.due.map((c: any) => c.id)).toEqual([learning.id]);
  });

  test('large learning backlogs return a bounded page', async () => {
    const { cookie, deckId, userId } = await setup();
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Seed' });
    await db.insert(cards).values(Array.from({ length: 510 }, (_, i) => ({
      userId, deckId, noteId: card.noteId, templateOrd: i + 1,
      state: 'learning' as const, due: new Date(Date.now() - 60_000),
    })));
    const queue = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queue.total).toBe(500);
    expect(queue.due).toHaveLength(500);
    expect(queue.new).toEqual([]);
  });

  test('summary distinguishes daily limits from future learning and suspended cards', async () => {
    const { cookie, userId, deckId } = await setup();
    await seedBasicCard(app, cookie, { deckId, front: 'New' });
    const due = await seedBasicCard(app, cookie, { deckId, front: 'Review' });
    await db.update(cards).set({ state: 'review', due: new Date(Date.now() - 60_000) }).where(eq(cards.id, due.id));
    const learning = await seedBasicCard(app, cookie, { deckId, front: 'Later' });
    const next = new Date(Date.now() + 600_000);
    await db.update(cards).set({ state: 'learning', due: next }).where(eq(cards.id, learning.id));
    const paused = await seedBasicCard(app, cookie, { deckId, front: 'Paused' });
    await db.update(cards).set({ suspended: true }).where(eq(cards.id, paused.id));
    await db.update(profile).set({ newIntroducedToday: 20, reviewsDoneToday: 200, dailyCountsDate: new Date().toISOString().slice(0, 10) })
      .where(eq(profile.userId, userId));
    const queue = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queue.total).toBe(0);
    expect(queue.summary).toMatchObject({
      total: 4, newCount: 1, learningCount: 1, reviewCount: 1, suspendedCount: 1,
      dueLearning: 0, dueReview: 1, availableNew: 0, availableReview: 0, totalAvailable: 0,
      newRemaining: 0, reviewRemaining: 0, limitedNew: 1, limitedReview: 1,
      nextLearningAt: next.toISOString(),
    });
  });

  test('foreign and missing decks cannot fall back to the whole collection', async () => {
    const a = await setup();
    const b = await setup();
    await seedBasicCard(app, a.cookie, { deckId: a.deckId, front: 'Private A' });
    await seedBasicCard(app, b.cookie, { deckId: b.deckId, front: 'Private B' });
    for (const deckId of [b.deckId, '01900000-0000-7000-8000-000000000001']) {
      const response = await callApp(app, 'GET', `/cards/queue?deckId=${deckId}`, { cookie: a.cookie });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'deck_not_found' });
    }
  });

  test('summary includes descendants and ignores other users', async () => {
    const a = await setup();
    const b = await setup();
    const child = await (await callApp(app, 'POST', '/decks', {
      cookie: a.cookie, body: { name: 'Child', parentId: a.deckId },
    })).json<{ id: string }>();
    await seedBasicCard(app, a.cookie, { deckId: a.deckId, front: 'Parent' });
    await seedBasicCard(app, a.cookie, { deckId: child.id, front: 'Child' });
    await seedBasicCard(app, b.cookie, { deckId: b.deckId, front: 'Private' });
    const queue = await (await callApp(app, 'GET', `/cards/queue?deckId=${a.deckId}`, { cookie: a.cookie })).json<any>();
    expect(queue.total).toBe(2);
    expect(queue.summary).toMatchObject({ total: 2, newCount: 2, totalAvailable: 2 });
  });

  test('legacy filtered decks cannot offer ungradeable suspended cards', async () => {
    const { cookie, deckId } = await setup();
    const active = await seedBasicCard(app, cookie, { deckId, front: 'Active' });
    const paused = await seedBasicCard(app, cookie, { deckId, front: 'Paused' });
    await db.update(cards).set({ suspended: true }).where(eq(cards.id, paused.id));
    const filter = await (await callApp(app, 'POST', '/filtered-decks', {
      cookie, body: { name: 'Legacy', query: '', includeSuspended: true },
    })).json<{ id: string }>();
    const queue = await (await callApp(app, 'GET', `/cards/queue?filteredDeckId=${filter.id}`, { cookie })).json<any>();
    expect(queue.due.map((c: any) => c.id)).toEqual([active.id]);
    expect(queue.mode).toBe('filtered');
  });

  test('the next UTC day makes yesterday\'s budget available without a write', async () => {
    const { cookie, userId, deckId } = await setup();
    await seedBasicCard(app, cookie, { deckId, front: 'New' });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await db.update(profile).set({ newIntroducedToday: 20, reviewsDoneToday: 200, dailyCountsDate: yesterday })
      .where(eq(profile.userId, userId));
    const queue = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queue.new).toHaveLength(1);
    expect(queue.summary).toMatchObject({ newRemaining: 20, reviewRemaining: 200, totalAvailable: 1 });
    const [unchanged] = await db.select().from(profile).where(eq(profile.userId, userId));
    expect(unchanged!.dailyCountsDate).toBe(yesterday);
  });
});
