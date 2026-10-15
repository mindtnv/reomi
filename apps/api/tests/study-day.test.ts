import { beforeEach, describe, expect, test } from 'bun:test';
import { cards, db, profile, reviews, studyDayPolicy } from '@reomi/db';
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

async function pin(userId: string, cardId: string, instant: string) {
  const stamp = new Date(Date.parse(instant) - 1);
  await db.update(cards).set({ updatedAt: stamp }).where(eq(cards.id, cardId));
  await db.update(profile).set({ updatedAt: stamp }).where(eq(profile.userId, userId));
}

async function ownedProfile(userId: string) {
  const [row] = await db.select().from(profile).where(eq(profile.userId, userId));
  return row!;
}

describe('study day', () => {
  beforeEach(resetTestDb);

  test('the New York fall fold keeps one budget across the repeated hour', async () => {
    expect(Date.now()).toBeLessThan(Date.parse('2026-11-01T05:29:00.000Z'));
    const { cookie, userId, deckId } = await setup();
    const saved = await callApp(app, 'PATCH', '/profile/study-day', {
      cookie,
      body: { timeZone: 'America/New_York', rolloverMinute: 90 },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      legacy: false,
      zone: 'America/New_York',
      rolloverMinute: 90,
      usedNew: 0,
      usedReviews: 0,
      todayMinutes: 0,
      takesEffectAt: null,
    });

    const first = await seedBasicCard(app, cookie, { deckId, front: 'Before' });
    await pin(userId, first.id, '2026-11-01T05:29:00.000Z');
    const early = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId: first.id, rating: 3, durationMs: 120_000 },
    });
    expect(early.status).toBe(200);
    const earlyProfile = await ownedProfile(userId);
    expect(earlyProfile.studyEpochStart!.toISOString()).toBe('2026-10-31T05:30:00.000Z');
    expect(earlyProfile.studyEpochEnd!.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(earlyProfile.dailyCountsDate).toBe('2026-10-31');
    expect(earlyProfile.newIntroducedToday).toBe(1);
    expect(earlyProfile.reviewsDoneToday).toBe(0);
    expect(earlyProfile.todayMinutes).toBe(2);
    expect(earlyProfile.streakDays).toBe(1);

    const second = await seedBasicCard(app, cookie, { deckId, front: 'After' });
    await pin(userId, second.id, '2026-11-01T06:00:00.000Z');
    const rolled = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId: second.id, rating: 3, durationMs: 60_000 },
    });
    expect(rolled.status).toBe(200);
    const rolledProfile = await ownedProfile(userId);
    expect(rolledProfile.studyEpochStart!.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(rolledProfile.studyEpochEnd!.toISOString()).toBe('2026-11-02T06:30:00.000Z');
    expect(rolledProfile.dailyCountsDate).toBe('2026-11-01');
    expect(rolledProfile.newIntroducedToday).toBe(1);
    expect(rolledProfile.reviewsDoneToday).toBe(0);
    expect(rolledProfile.todayMinutes).toBe(1);
    expect(rolledProfile.streakDays).toBe(2);

    const third = await seedBasicCard(app, cookie, { deckId, front: 'Later fold' });
    await pin(userId, third.id, '2026-11-01T06:30:00.000Z');
    const same = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId: third.id, rating: 3, durationMs: 60_000 },
    });
    expect(same.status).toBe(200);
    const sameProfile = await ownedProfile(userId);
    expect(sameProfile.studyEpochStart!.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(sameProfile.studyEpochEnd!.toISOString()).toBe('2026-11-02T06:30:00.000Z');
    expect(sameProfile.newIntroducedToday).toBe(2);
    expect(sameProfile.todayMinutes).toBe(2);
    expect(sameProfile.streakDays).toBe(2);

    const rows = await db.select().from(reviews).where(eq(reviews.userId, userId));
    const byCard = new Map(rows.map((row) => [row.cardId, row]));
    expect(byCard.get(first.id)!.studyDay).toBe('2026-10-31');
    expect(byCard.get(first.id)!.studyEpochStart!.toISOString()).toBe('2026-10-31T05:30:00.000Z');
    expect(byCard.get(second.id)!.studyDay).toBe('2026-11-01');
    expect(byCard.get(second.id)!.studyEpochStart!.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(byCard.get(third.id)!.studyDay).toBe('2026-11-01');
    expect(byCard.get(third.id)!.studyEpochStart!.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  test('a zone save during an open epoch keeps the budget for the next grade', async () => {
    const { cookie, userId, deckId } = await setup();
    const first = await seedBasicCard(app, cookie, { deckId, front: 'One' });
    const graded = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId: first.id, rating: 3, durationMs: 60_000 },
    });
    expect(graded.status).toBe(200);
    const opened = await ownedProfile(userId);
    expect(opened.newIntroducedToday).toBe(1);
    expect(opened.studyEpochStart).not.toBeNull();

    const saved = await callApp(app, 'PATCH', '/profile/study-day', {
      cookie,
      body: { timeZone: 'Asia/Tokyo', rolloverMinute: 0 },
    });
    expect(saved.status).toBe(200);
    const body = await saved.json<{
      legacy: boolean;
      zone: string;
      usedNew: number;
      startsAt: string;
      endsAt: string;
      takesEffectAt: string | null;
    }>();
    expect(body.legacy).toBe(false);
    expect(body.zone).toBe('Asia/Tokyo');
    expect(body.usedNew).toBe(1);
    expect(body.startsAt).toBe(opened.studyEpochStart!.toISOString());
    expect(body.endsAt).toBe(opened.studyEpochEnd!.toISOString());
    expect(body.takesEffectAt).toBe(opened.studyEpochEnd!.toISOString());

    const afterSave = await ownedProfile(userId);
    expect(afterSave.newIntroducedToday).toBe(1);
    expect(afterSave.reviewsDoneToday).toBe(0);
    expect(afterSave.todayMinutes).toBe(opened.todayMinutes);
    expect(afterSave.studyEpochStart!.toISOString()).toBe(opened.studyEpochStart!.toISOString());
    expect(afterSave.studyEpochEnd!.toISOString()).toBe(opened.studyEpochEnd!.toISOString());
    const [policy] = await db.select().from(studyDayPolicy).where(eq(studyDayPolicy.userId, userId));
    expect(policy!.timeZone).toBe('Asia/Tokyo');
    expect(policy!.rolloverMinute).toBe(0);

    const second = await seedBasicCard(app, cookie, { deckId, front: 'Two' });
    const next = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId: second.id, rating: 3, durationMs: 60_000 },
    });
    expect(next.status).toBe(200);
    const consumed = await ownedProfile(userId);
    expect(consumed.newIntroducedToday).toBe(2);
    expect(consumed.studyEpochStart!.toISOString()).toBe(opened.studyEpochStart!.toISOString());
    expect(consumed.studyEpochEnd!.toISOString()).toBe(opened.studyEpochEnd!.toISOString());
  });

  test('undo restores the ledger instants and leaves the saved policy', async () => {
    const { cookie, userId, deckId } = await setup();
    const saved = await callApp(app, 'PATCH', '/profile/study-day', {
      cookie,
      body: { timeZone: 'Asia/Tokyo', rolloverMinute: 0 },
    });
    expect(saved.status).toBe(200);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'One' });
    const graded = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId: card.id, rating: 3, durationMs: 60_000 },
    });
    expect(graded.status).toBe(200);
    const opened = await ownedProfile(userId);
    expect(opened.studyEpochStart).not.toBeNull();
    expect(opened.newIntroducedToday).toBe(1);

    const undo = await callApp(app, 'POST', '/reviews/undo', { cookie });
    expect(undo.status).toBe(200);
    const restored = await ownedProfile(userId);
    expect(restored.studyEpochStart).toBeNull();
    expect(restored.studyEpochEnd).toBeNull();
    expect(restored.lastReviewEpochEnd).toBeNull();
    expect(restored.goalMetEpochStart).toBeNull();
    expect(restored.newIntroducedToday).toBe(0);
    expect(restored.dailyCountsDate).toBeNull();
    const [policy] = await db.select().from(studyDayPolicy).where(eq(studyDayPolicy.userId, userId));
    expect(policy!.timeZone).toBe('Asia/Tokyo');
    expect(policy!.rolloverMinute).toBe(0);
  });

  test("another user's policy does not move this user's day", async () => {
    const owner = await setup();
    const other = await setup();
    const card = await seedBasicCard(app, owner.cookie, { deckId: owner.deckId, front: 'Mine' });
    expect((await callApp(app, 'POST', '/reviews', {
      cookie: owner.cookie,
      body: { cardId: card.id, rating: 3, durationMs: 60_000 },
    })).status).toBe(200);
    const before = await (await callApp(app, 'GET', '/profile/study-day', { cookie: owner.cookie })).json<{
      legacy: boolean;
      zone: string;
      label: string;
      startsAt: string;
      endsAt: string;
      usedNew: number;
    }>();
    expect(before.legacy).toBe(true);
    expect(before.zone).toBe('UTC');
    expect(before.usedNew).toBe(1);

    const foreign = await callApp(app, 'PATCH', '/profile/study-day', {
      cookie: other.cookie,
      body: { timeZone: 'Asia/Tokyo', rolloverMinute: 0 },
    });
    expect(foreign.status).toBe(200);
    const after = await (await callApp(app, 'GET', '/profile/study-day', { cookie: owner.cookie })).json<{
      legacy: boolean;
      zone: string;
      label: string;
      startsAt: string;
      endsAt: string;
      usedNew: number;
    }>();
    expect(after).toEqual(before);
    const ownerPolicies = await db.select().from(studyDayPolicy).where(eq(studyDayPolicy.userId, owner.userId));
    expect(ownerPolicies).toEqual([]);
    const otherPolicies = await db.select().from(studyDayPolicy).where(eq(studyDayPolicy.userId, other.userId));
    expect(otherPolicies).toHaveLength(1);
    expect(otherPolicies[0]!.timeZone).toBe('Asia/Tokyo');
  });

  test('profile patch does not store a zone, and a refused alias is rejected', async () => {
    const { cookie, userId } = await setup();
    const patched = await callApp(app, 'PATCH', '/profile', {
      cookie,
      body: { name: 'Ada', timeZone: 'Asia/Tokyo', rolloverMinute: 90 },
    });
    expect(patched.status === 200 || patched.status === 400).toBe(true);
    const row = await ownedProfile(userId);
    expect(row.studyEpochStart).toBeNull();
    expect(row.studyEpochEnd).toBeNull();
    const policies = await db.select().from(studyDayPolicy).where(eq(studyDayPolicy.userId, userId));
    expect(policies).toEqual([]);
    if (patched.status === 200) expect(row.name).toBe('Ada');
    else expect(row.name).not.toBe('Ada');

    const alias = await callApp(app, 'PATCH', '/profile/study-day', {
      cookie,
      body: { timeZone: 'US/Eastern', rolloverMinute: 0 },
    });
    expect(alias.status).toBe(400);
    expect(await alias.json()).toEqual({ error: 'invalid_policy' });
    const half = await callApp(app, 'PATCH', '/profile/study-day', {
      cookie,
      body: { timeZone: 'Asia/Tokyo', rolloverMinute: null },
    });
    expect(half.status).toBe(400);
    expect(await half.json()).toEqual({ error: 'invalid_policy' });
  });
});
