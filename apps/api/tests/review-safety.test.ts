import { beforeEach, describe, expect, test } from 'bun:test';
import { buildApp } from '../src/app.ts';
import { cards, db, profile } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

async function setup(withProfile = true) {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  if (withProfile) await callApp(app, 'GET', '/profile', { cookie });
  const deck = await (await callApp(app, 'POST', '/decks', {
    cookie, body: { name: 'Study' },
  })).json<{ id: string }>();
  const card = await seedBasicCard(app, cookie, { deckId: deck.id, front: 'Question', back: 'Answer' });
  return { cookie, userId, deckId: deck.id, card };
}

describe('review safety', () => {
  beforeEach(resetTestDb);

  test('concurrent cards each contribute to the profile and history', async () => {
    const { cookie, deckId, card } = await setup();
    const all = [card];
    for (let i = 1; i < 8; i++) {
      all.push(await seedBasicCard(app, cookie, { deckId, front: `Question ${i}` }));
    }
    const results = await Promise.all(all.map((c) => callApp(app, 'POST', '/reviews', {
      cookie, body: { cardId: c.id, rating: 3, durationMs: 60_000 },
    })));
    expect(results.map((r) => r.status)).toEqual(all.map(() => 200));
    const profile = await (await callApp(app, 'GET', '/profile', { cookie })).json<any>();
    expect(profile.xp).toBe(80);
    expect(profile.newIntroducedToday).toBe(8);
    expect(profile.todayMinutes).toBe(8);
    const history = (await (await callApp(app, 'GET', '/reviews', { cookie })).json<any>()).items;
    expect(history).toHaveLength(8);
  });

  test('grading before the first profile read still saves the rollup', async () => {
    const { cookie, card } = await setup(false);
    const result = await callApp(app, 'POST', '/reviews', {
      cookie, body: { cardId: card.id, rating: 3 },
    });
    expect(result.status).toBe(200);
    const body = await result.json<any>();
    expect(body.profile?.xp).toBe(10);
    const profile = await (await callApp(app, 'GET', '/profile', { cookie })).json<any>();
    expect(profile.newIntroducedToday).toBe(1);
    expect(profile.streakDays).toBe(1);
  });

  test('concurrent submissions of one displayed version save only one grade', async () => {
    const { cookie, card } = await setup();
    const body = { cardId: card.id, rating: 3, expectedReps: card.reps, expectedUpdatedAt: card.updatedAt };
    const results = await Promise.all([1, 2].map(() => callApp(app, 'POST', '/reviews', { cookie, body })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    expect(await conflict.json()).toMatchObject({ error: 'card_changed' });
    const profile = await (await callApp(app, 'GET', '/profile', { cookie })).json<any>();
    expect(profile.xp).toBe(10);
    expect(profile.newIntroducedToday).toBe(1);
    expect(await (await callApp(app, 'GET', '/reviews/count', { cookie })).json()).toEqual({ count: 1 });
  });

  test('manual card changes reject the displayed version without writing a grade', async () => {
    const { cookie, card } = await setup();
    await callApp(app, 'PATCH', `/cards/${card.id}`, { cookie, body: { setDue: '2030-01-01T00:00:00.000Z' } });
    const result = await callApp(app, 'POST', '/reviews', {
      cookie, body: { cardId: card.id, rating: 3, expectedReps: card.reps, expectedUpdatedAt: card.updatedAt },
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: 'card_changed' });
    expect(await (await callApp(app, 'GET', '/reviews/count', { cookie })).json()).toEqual({ count: 0 });
  });

  test('concurrent undo cannot restore the same snapshot twice', async () => {
    const { cookie, card } = await setup();
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 3 } });
    const results = await Promise.all([1, 2].map(() => callApp(app, 'POST', '/reviews/undo', { cookie })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(await (await callApp(app, 'GET', '/reviews/count', { cookie })).json()).toEqual({ count: 0 });
    const profile = await (await callApp(app, 'GET', '/profile', { cookie })).json<any>();
    expect(profile.xp).toBe(0);
  });

  test('racing a grade and undo keeps rollups consistent with surviving history', async () => {
    const { cookie, deckId, card } = await setup();
    const next = await seedBasicCard(app, cookie, { deckId, front: 'Next' });
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 3 } });
    const results = await Promise.all([
      callApp(app, 'POST', '/reviews/undo', { cookie }),
      callApp(app, 'POST', '/reviews', { cookie, body: { cardId: next.id, rating: 4 } }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const history = (await (await callApp(app, 'GET', '/reviews', { cookie })).json<any>()).items;
    const profile = await (await callApp(app, 'GET', '/profile', { cookie })).json<any>();
    expect(history).toHaveLength(1);
    expect(profile.xp).toBe(history.reduce((sum, r) => sum + ({ 3: 10, 4: 15 }[r.rating as 3 | 4] ?? 0), 0));
    expect(profile.newIntroducedToday).toBe(1);
  });

  test('targeted undo cannot revert another tab\'s newer grade', async () => {
    const { cookie, deckId, card } = await setup();
    const first = await (await callApp(app, 'POST', '/reviews', {
      cookie, body: { cardId: card.id, rating: 3 },
    })).json<any>();
    const next = await seedBasicCard(app, cookie, { deckId, front: 'Next' });
    const second = await (await callApp(app, 'POST', '/reviews', {
      cookie, body: { cardId: next.id, rating: 4 },
    })).json<any>();
    const stale = await callApp(app, 'POST', '/reviews/undo', { cookie, body: { reviewId: first.review.id } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'review_changed' });
    expect(await (await callApp(app, 'GET', '/reviews/count', { cookie })).json()).toEqual({ count: 2 });
    const undone = await callApp(app, 'POST', '/reviews/undo', { cookie, body: { reviewId: second.review.id } });
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ reviewId: second.review.id, card: { id: next.id }, profile: { xp: 10 } });
    const duplicate = await callApp(app, 'POST', '/reviews/undo', { cookie, body: { reviewId: second.review.id } });
    expect(duplicate.status).toBe(409);
  });

  test('an abandoned tab cannot credit hours for one answer', async () => {
    const { cookie, card } = await setup();
    const result = await callApp(app, 'POST', '/reviews', {
      cookie, body: { cardId: card.id, rating: 3, durationMs: 3_600_000 },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ review: { durationMs: 600_000 }, profile: { todayMinutes: 10 } });
  });

  test('invalid history timestamps fail as input errors', async () => {
    const { cookie } = await setup();
    for (const since of ['invalid', '9999999999999999999999999']) {
      const result = await callApp(app, 'GET', `/reviews?since=${since}`, { cookie });
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({ error: 'invalid_since' });
    }
  });

  test('short answers accumulate toward the daily goal and undo restores the exact total', async () => {
    const { cookie, card } = await setup();
    await callApp(app, 'PATCH', '/profile', { cookie, body: { dailyGoalMinutes: 1 } });
    for (let i = 0; i < 3; i++) {
      const result = await callApp(app, 'POST', '/reviews', {
        cookie, body: { cardId: card.id, rating: 3, durationMs: 15_000 },
      });
      expect(result.status).toBe(200);
      expect((await result.json<any>()).dailyGoalJustMet).toBe(false);
    }
    const fourth = await (await callApp(app, 'POST', '/reviews', {
      cookie, body: { cardId: card.id, rating: 3, durationMs: 15_000 },
    })).json<any>();
    expect(fourth.profile.todayMinutes).toBe(1);
    expect(fourth.dailyGoalJustMet).toBe(true);
    const undo = await callApp(app, 'POST', '/reviews/undo', { cookie, body: { reviewId: fourth.review.id } });
    expect(undo.status).toBe(200);
    const restored = await undo.json<any>();
    expect(restored.profile.todayMinutes).toBe(0);
    expect(restored.profile.dailyGoalMetCount).toBe(0);
    const retry = await (await callApp(app, 'POST', '/reviews', {
      cookie, body: { cardId: card.id, rating: 3, durationMs: 15_000 },
    })).json<any>();
    expect(retry.profile.todayMinutes).toBe(1);
    expect(retry.profile.dailyGoalMetCount).toBe(1);
  });

  test('learning and relearning grades do not consume the mature-review budget', async () => {
    const { cookie, card, userId } = await setup();
    for (const state of ['learning', 'relearning'] as const) {
      await db.update(cards).set({ state, stability: 1, difficulty: 5, reps: 1 }).where(eq(cards.id, card.id));
      const result = await callApp(app, 'POST', '/reviews', {
        cookie, body: { cardId: card.id, rating: 3 },
      });
      expect(result.status).toBe(200);
    }
    const [savedProfile] = await db.select().from(profile).where(eq(profile.userId, userId));
    expect(savedProfile!.newIntroducedToday).toBe(0);
    expect(savedProfile!.reviewsDoneToday).toBe(0);
  });

  test('undo order follows serialized grades even when a card version is ahead of the clock', async () => {
    const { cookie, deckId, card } = await setup();
    const next = await seedBasicCard(app, cookie, { deckId, front: 'Second' });
    await db.update(cards).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(cards.id, card.id));
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 3 } });
    const second = await (await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: next.id, rating: 4 } })).json<any>();
    const undo = await callApp(app, 'POST', '/reviews/undo', { cookie, body: { reviewId: second.review.id } });
    expect(undo.status).toBe(200);
    expect(await undo.json()).toMatchObject({ card: { id: next.id, reps: 0 }, profile: { xp: 10 } });
  });
});
