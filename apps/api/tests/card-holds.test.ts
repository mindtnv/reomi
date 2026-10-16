import { beforeEach, describe, expect, test } from 'bun:test';
import { cards, db, profile, reviews, studyDayPolicy } from '@reomi/db';
import { parseStudyDayPolicy, readStudyDay, type StudyLedger } from '@reomi/shared';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { listDecksWithCounts } from '../src/modules/cards.ts';
import { __setDatabaseNowForTests } from '../src/modules/study-day.ts';
import { callApp, resetTestDb, seedBasicCard, seedNote, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

type HoldBody = {
  action: 'bury' | 'unbury';
  until: string | null;
  cardIds: string[];
  changed: number;
};

type StudyDayBody = { label: string; startsAt: string; endsAt: string };

async function setup() {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  await callApp(app, 'GET', '/profile', { cookie });
  const deck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Study' } })).json<{ id: string }>();
  return { cookie, userId, deckId: deck.id };
}

async function studyDay(cookie: string): Promise<StudyDayBody> {
  const res = await callApp(app, 'GET', '/profile/study-day', { cookie });
  expect(res.status).toBe(200);
  return res.json();
}

async function postHold(cookie: string, body: unknown) {
  return callApp(app, 'POST', '/cards/holds', { cookie, body });
}

async function scheduleOf(cardId: string) {
  const [row] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
  return {
    due: row!.due.toISOString(),
    state: row!.state,
    reps: row!.reps,
    lapses: row!.lapses,
    stability: row!.stability,
    difficulty: row!.difficulty,
    suspended: row!.suspended,
    updatedAt: row!.updatedAt.toISOString(),
  };
}

async function reviewRows(userId: string) {
  return db.select({ id: reviews.id }).from(reviews).where(eq(reviews.userId, userId));
}

async function holdReason(cardId: string): Promise<string | null> {
  const rows = await db.execute<{ reason: string }>(sql`
    SELECT reason FROM card_holds WHERE card_id = ${cardId}::uuid
  `);
  const list = Array.isArray(rows) ? rows : [];
  return list[0]?.reason ?? null;
}

function queueIds(body: { due: { id: string }[]; new: { id: string }[] }) {
  return [...body.due.map((card) => card.id), ...body.new.map((card) => card.id)];
}

function unopenedLedger(): StudyLedger {
  return {
    budget: { phase: 'unopened', newIntroduced: 0, reviewsDone: 0 },
    todayMinutes: 0,
    streakDays: 0,
    streakFreezes: 0,
    lastReviewEpochEnd: null,
    lastReviewLabel: null,
    dailyGoalMetCount: 0,
    dailyGoalMetLabel: null,
    goalMetEpochStart: null,
    dailyGoalMinutes: 15,
    xp: 0,
  };
}

describe('POST /cards/holds', () => {
  beforeEach(async () => {
    __setDatabaseNowForTests(null);
    await resetTestDb();
  });

  test('burying one due card hides it until the open study day ends and writes no review', async () => {
    const { cookie, userId, deckId } = await setup();
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Held' });
    const kept = await seedBasicCard(app, cookie, { deckId, front: 'Kept' });
    const before = await scheduleOf(card.id);
    const [profileBefore] = await db.select().from(profile).where(eq(profile.userId, userId));
    const day = await studyDay(cookie);

    const buried = await postHold(cookie, { action: 'bury', cardIds: [card.id] });
    expect(buried.status).toBe(200);
    const body = await buried.json<HoldBody>();
    expect(body).toMatchObject({ action: 'bury', until: day.endsAt, cardIds: [card.id], changed: 1 });
    expect(new Date(body.until!).getTime()).toBeGreaterThan(Date.now());
    expect(await scheduleOf(card.id)).toEqual(before);
    expect(await reviewRows(userId)).toEqual([]);
    const [profileAfter] = await db.select().from(profile).where(eq(profile.userId, userId));
    expect(profileAfter!.studyEpochStart).toEqual(profileBefore!.studyEpochStart);
    expect(profileAfter!.studyEpochEnd).toEqual(profileBefore!.studyEpochEnd);
    expect(await holdReason(card.id)).toBe('user');

    const queue = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queueIds(queue)).toEqual([kept.id]);
    expect(queue.heldCardIds).toEqual([card.id]);
    expect(queue.due.every((row: { hold: unknown }) => row.hold === null)).toBe(true);
    expect(queue.new.every((row: { hold: unknown }) => row.hold === null)).toBe(true);
    expect(queue.summary).toMatchObject({
      total: 2,
      newCount: 1,
      buriedCount: 1,
      dueBuried: 1,
      suspendedCount: 0,
      dueNew: 1,
      totalAvailable: 1,
    });
    expect(queue.summary.newCount + queue.summary.learningCount + queue.summary.reviewCount
      + queue.summary.suspendedCount + queue.summary.buriedCount).toBe(queue.summary.total);

    const listed = await (await callApp(app, 'GET', '/cards?due=true', { cookie })).json<{ items: { id: string }[] }>();
    expect(listed.items.map((row) => row.id)).toEqual([kept.id]);
    const detail = await (await callApp(app, 'GET', `/cards/${card.id}`, { cookie })).json<{ hold: { until: string; reason: string } }>();
    expect(detail.hold).toEqual({ until: day.endsAt, reason: 'user' });

    const decks = await listDecksWithCounts(userId, new Date());
    expect(decks.find((row) => row.id === deckId)).toMatchObject({ total: 2, due: 1 });

    const again = await postHold(cookie, { action: 'bury', cardIds: [card.id] });
    expect(again.status).toBe(200);
    expect(await again.json<HoldBody>()).toMatchObject({
      action: 'bury', until: day.endsAt, cardIds: [card.id], changed: 0,
    });

    const grade = await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 3 } });
    expect(grade.status).toBe(409);
    expect(await grade.json()).toMatchObject({ error: 'card_held' });
    const operationId = crypto.randomUUID();
    const operation = await callApp(app, 'POST', `/reviews/operations/${operationId}`, {
      cookie, body: { cardId: card.id, rating: 3 },
    });
    expect(operation.status).toBe(409);
    expect(await operation.json()).toMatchObject({ error: 'card_held' });
    expect(await reviewRows(userId)).toEqual([]);
    expect(await scheduleOf(card.id)).toEqual(before);
    expect((await callApp(app, 'GET', `/reviews/operations/${operationId}`, { cookie })).status).toBe(404);

    const back = await postHold(cookie, { action: 'unbury', cardIds: [card.id] });
    expect(back.status).toBe(200);
    expect(await back.json<HoldBody>()).toMatchObject({
      action: 'unbury', until: null, cardIds: [card.id], changed: 1,
    });
    const restored = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queueIds(restored).sort()).toEqual([card.id, kept.id].sort());
    expect(restored.heldCardIds).toEqual([]);
    const cleared = await (await callApp(app, 'GET', `/cards/${card.id}`, { cookie })).json<{ hold: unknown }>();
    expect(cleared.hold).toBeNull();
    const repeat = await postHold(cookie, { action: 'unbury', cardIds: [card.id] });
    expect(repeat.status).toBe(200);
    expect(await repeat.json<HoldBody>()).toMatchObject({ action: 'unbury', until: null, cardIds: [], changed: 0 });
  });

  test('a future learning step is listed for the session and does not set the next learning time', async () => {
    const { cookie, deckId } = await setup();
    const soon = new Date(Date.now() + 600_000);
    const later = new Date(Date.now() + 1_200_000);
    const buriedLearning = await seedBasicCard(app, cookie, { deckId, front: 'Soon' });
    const liveLearning = await seedBasicCard(app, cookie, { deckId, front: 'Later' });
    const buriedReview = await seedBasicCard(app, cookie, { deckId, front: 'Future review' });
    await db.update(cards).set({ state: 'learning', due: soon }).where(eq(cards.id, buriedLearning.id));
    await db.update(cards).set({ state: 'learning', due: later }).where(eq(cards.id, liveLearning.id));
    await db.update(cards).set({ state: 'review', due: soon }).where(eq(cards.id, buriedReview.id));

    const buried = await postHold(cookie, { action: 'bury', cardIds: [buriedLearning.id, buriedReview.id] });
    expect(buried.status).toBe(200);
    expect((await buried.json<HoldBody>()).cardIds.sort()).toEqual([buriedLearning.id, buriedReview.id].sort());

    const queue = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queueIds(queue)).toEqual([]);
    expect(queue.heldCardIds.sort()).toEqual([buriedLearning.id, buriedReview.id].sort());
    expect(queue.summary).toMatchObject({
      total: 3,
      learningCount: 1,
      reviewCount: 0,
      buriedCount: 2,
      dueBuried: 0,
      dueLearning: 0,
      nextLearningAt: later.toISOString(),
      nextDueAt: later.toISOString(),
    });
  });

  test('user bury holds a learning card that is due now', async () => {
    const { cookie, deckId } = await setup();
    const learning = await seedBasicCard(app, cookie, { deckId, front: 'Learning' });
    await db.update(cards).set({ state: 'learning', due: new Date(Date.now() - 60_000) }).where(eq(cards.id, learning.id));
    const buried = await postHold(cookie, { action: 'bury', cardIds: [learning.id] });
    expect(buried.status).toBe(200);
    expect((await buried.json<HoldBody>()).changed).toBe(1);
    const queue = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queueIds(queue)).toEqual([]);
    expect(queue.summary).toMatchObject({ learningCount: 0, buriedCount: 1, dueBuried: 1, dueLearning: 0, nextLearningAt: null });
  });

  test('note bury and unbury cover every card of the note in one result', async () => {
    const { cookie, userId, deckId } = await setup();
    const first = await seedBasicCard(app, cookie, { deckId, front: 'One' });
    await db.insert(cards).values({ userId, deckId, noteId: first.noteId, templateOrd: 1 });
    const siblings = await db.select({ id: cards.id }).from(cards).where(eq(cards.noteId, first.noteId));
    expect(siblings).toHaveLength(2);

    const buried = await postHold(cookie, { action: 'bury', noteId: first.noteId });
    expect(buried.status).toBe(200);
    const body = await buried.json<HoldBody>();
    expect(body.action).toBe('bury');
    expect(body.changed).toBe(2);
    expect(body.cardIds.sort()).toEqual(siblings.map((row) => row.id).sort());
    const hidden = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queueIds(hidden)).toEqual([]);

    const again = await postHold(cookie, { action: 'bury', noteId: first.noteId });
    expect(await again.json<HoldBody>()).toMatchObject({ changed: 0, cardIds: expect.any(Array) });
    expect((await again.json<HoldBody>()).cardIds.sort()).toEqual(body.cardIds.sort());

    const back = await postHold(cookie, { action: 'unbury', noteId: first.noteId });
    expect(back.status).toBe(200);
    const restored = await back.json<HoldBody>();
    expect(restored).toMatchObject({ action: 'unbury', until: null, changed: 2 });
    expect(restored.cardIds.sort()).toEqual(body.cardIds.sort());
    const queue = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queueIds(queue).sort()).toEqual(body.cardIds.sort());
  });

  test('unbury deletes a user hold and leaves a sibling hold in place', async () => {
    const { cookie, userId, deckId } = await setup();
    const userCard = await seedBasicCard(app, cookie, { deckId, front: 'User' });
    const sibling = await seedBasicCard(app, cookie, { deckId, front: 'Sibling' });
    const day = await studyDay(cookie);
    await db.execute(sql`
      INSERT INTO card_holds (card_id, user_id, buried_until, reason)
      VALUES
        (${userCard.id}::uuid, ${userId}, ${day.endsAt}::timestamptz, 'user'),
        (${sibling.id}::uuid, ${userId}, ${day.endsAt}::timestamptz, 'sibling')
    `);

    const back = await postHold(cookie, { action: 'unbury', cardIds: [userCard.id, sibling.id] });
    expect(back.status).toBe(200);
    expect(await back.json<HoldBody>()).toMatchObject({
      action: 'unbury', until: null, cardIds: [userCard.id], changed: 1,
    });
    expect(await holdReason(userCard.id)).toBeNull();
    expect(await holdReason(sibling.id)).toBe('sibling');
    const still = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queueIds(still)).toEqual([userCard.id]);

    const taken = await postHold(cookie, { action: 'bury', cardIds: [sibling.id] });
    expect(taken.status).toBe(200);
    expect(await taken.json<HoldBody>()).toMatchObject({ action: 'bury', cardIds: [sibling.id], changed: 1 });
    expect(await holdReason(sibling.id)).toBe('user');
    const released = await postHold(cookie, { action: 'unbury', cardIds: [sibling.id] });
    expect((await released.json<HoldBody>()).cardIds).toEqual([sibling.id]);
    expect(await holdReason(sibling.id)).toBeNull();
  });

  test('a note unbury removes only user holds', async () => {
    const { cookie, userId, deckId } = await setup();
    const first = await seedBasicCard(app, cookie, { deckId, front: 'Note' });
    const [second] = await db.insert(cards).values({
      userId, deckId, noteId: first.noteId, templateOrd: 1,
    }).returning({ id: cards.id });
    const day = await studyDay(cookie);
    const buried = await postHold(cookie, { action: 'bury', noteId: first.noteId });
    expect(buried.status).toBe(200);
    await db.execute(sql`
      UPDATE card_holds SET reason = 'sibling' WHERE card_id = ${second!.id}::uuid
    `);
    const back = await postHold(cookie, { action: 'unbury', noteId: first.noteId });
    expect(await back.json<HoldBody>()).toMatchObject({ cardIds: [first.id], changed: 1, until: null });
    expect(await holdReason(second!.id)).toBe('sibling');
    const queue = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queueIds(queue)).toEqual([first.id]);
  });

  test('an expired hold returns the card when it is otherwise due', async () => {
    const { cookie, deckId } = await setup();
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Expired' });
    const buried = await postHold(cookie, { action: 'bury', cardIds: [card.id] });
    expect(buried.status).toBe(200);
    await db.execute(sql`
      UPDATE card_holds SET buried_until = now() - interval '1 second' WHERE card_id = ${card.id}::uuid
    `);
    const queue = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<any>();
    expect(queueIds(queue)).toEqual([card.id]);
    expect(queue.heldCardIds).toEqual([]);
    const detail = await (await callApp(app, 'GET', `/cards/${card.id}`, { cookie })).json<{ hold: unknown }>();
    expect(detail.hold).toBeNull();
  });

  test('suspended wins over an active hold in the counts', async () => {
    const { cookie, deckId } = await setup();
    const paused = await seedBasicCard(app, cookie, { deckId, front: 'Paused' });
    await db.update(cards).set({ suspended: true }).where(eq(cards.id, paused.id));
    const buried = await postHold(cookie, { action: 'bury', cardIds: [paused.id] });
    expect(buried.status).toBe(200);
    const summary = await (await callApp(app, 'GET', '/cards/study-summary', { cookie })).json<any>();
    expect(summary.overall).toMatchObject({
      total: 1, newCount: 0, learningCount: 0, reviewCount: 0, suspendedCount: 1, buriedCount: 0, dueBuried: 0,
    });
    const detail = await (await callApp(app, 'GET', `/cards/${paused.id}`, { cookie })).json<{ hold: { reason: string } | null }>();
    expect(detail.hold?.reason).toBe('user');
    const buriedSearch = await (await callApp(app, 'GET', '/cards/search?q=is:buried', { cookie })).json<{ items: { id: string }[] }>();
    expect(buriedSearch.items).toEqual([]);
    const suspendedSearch = await (await callApp(app, 'GET', '/cards/search?q=is:suspended', { cookie })).json<{ items: { id: string }[] }>();
    expect(suspendedSearch.items.map((row) => row.id)).toEqual([paused.id]);
  });

  test('schedule searches skip an active hold and is:buried matches it', async () => {
    const { cookie, deckId } = await setup();
    const fresh = await seedBasicCard(app, cookie, { deckId, front: 'New' });
    const learning = await seedBasicCard(app, cookie, { deckId, front: 'Learn' });
    const review = await seedBasicCard(app, cookie, { deckId, front: 'Review' });
    const free = await seedBasicCard(app, cookie, { deckId, front: 'Free' });
    await db.update(cards).set({ state: 'learning', due: new Date(Date.now() - 60_000) }).where(eq(cards.id, learning.id));
    await db.update(cards).set({ state: 'review', due: new Date(Date.now() - 60_000) }).where(eq(cards.id, review.id));
    await db.update(cards).set({ state: 'review', due: new Date(Date.now() - 60_000) }).where(eq(cards.id, free.id));
    const buried = await postHold(cookie, { action: 'bury', cardIds: [fresh.id, learning.id, review.id] });
    expect(buried.status).toBe(200);

    const search = async (q: string) => {
      const res = await callApp(app, 'GET', `/cards/search?q=${encodeURIComponent(q)}`, { cookie });
      expect(res.status).toBe(200);
      return (await res.json<{ items: { id: string }[] }>()).items.map((row) => row.id).sort();
    };
    expect(await search('is:new')).toEqual([]);
    expect(await search('is:learn')).toEqual([]);
    expect(await search('is:review')).toEqual([free.id]);
    expect(await search('is:due')).toEqual([free.id]);
    expect(await search('is:buried')).toEqual([fresh.id, learning.id, review.id].sort());
  });

  test('every filtered sort, including cram, omits an active hold', async () => {
    const { cookie, deckId } = await setup();
    const day = await studyDay(cookie);
    const pastHeld = await seedBasicCard(app, cookie, { deckId, front: 'Past held', tags: ['held'] });
    const pastFree = await seedBasicCard(app, cookie, { deckId, front: 'Past free', tags: ['held'] });
    const futureHeld = await seedBasicCard(app, cookie, { deckId, front: 'Future held', tags: ['held'] });
    const futureFree = await seedBasicCard(app, cookie, { deckId, front: 'Future free', tags: ['held'] });
    const past = new Date(Date.now() - 60_000);
    const future = new Date(new Date(day.endsAt).getTime() + 3_600_000);
    await db.update(cards).set({ state: 'review', due: past }).where(eq(cards.id, pastHeld.id));
    await db.update(cards).set({ state: 'review', due: past }).where(eq(cards.id, pastFree.id));
    await db.update(cards).set({ state: 'review', due: future }).where(eq(cards.id, futureHeld.id));
    await db.update(cards).set({ state: 'review', due: future }).where(eq(cards.id, futureFree.id));
    const buried = await postHold(cookie, { action: 'bury', cardIds: [pastHeld.id, futureHeld.id] });
    expect(buried.status).toBe(200);
    expect((await buried.json<HoldBody>()).until).toBe(day.endsAt);

    for (const sortOrder of ['due', 'added', 'random', 'difficultyDesc', 'lapses', 'overdue', 'cram'] as const) {
      const filter = await (await callApp(app, 'POST', '/filtered-decks', {
        cookie,
        body: { name: sortOrder, query: 'tag:held', sortOrder, cardLimit: 50, includeSuspended: false },
      })).json<{ id: string }>();
      const queue = await (await callApp(app, 'GET', `/cards/queue?filteredDeckId=${filter.id}`, { cookie })).json<any>();
      const ids = queue.due.map((row: { id: string }) => row.id);
      expect(ids, sortOrder).not.toContain(pastHeld.id);
      expect(ids, sortOrder).not.toContain(futureHeld.id);
      if (sortOrder === 'cram') {
        expect(ids, sortOrder).toEqual(expect.arrayContaining([pastFree.id, futureFree.id]));
        expect(queue.heldCardIds.sort()).toEqual([pastHeld.id, futureHeld.id].sort());
      } else if (sortOrder === 'overdue') {
        expect(ids, sortOrder).toContain(pastFree.id);
        expect(ids, sortOrder).not.toContain(futureFree.id);
        expect(queue.heldCardIds).toEqual([pastHeld.id]);
      } else {
        expect(ids, sortOrder).toContain(pastFree.id);
        expect(queue.heldCardIds.sort()).toEqual([pastHeld.id, futureHeld.id].sort());
      }
      expect(queue.studyDay.endsAt).toBe(day.endsAt);
    }
  });

  test('a card due next study day stays in that forecast bucket when the hold ends tonight', async () => {
    const { cookie, deckId } = await setup();
    const day = await studyDay(cookie);
    const overdueHeld = await seedBasicCard(app, cookie, { deckId, front: 'Overdue held' });
    const overdueFree = await seedBasicCard(app, cookie, { deckId, front: 'Overdue free' });
    const todayHeld = await seedBasicCard(app, cookie, { deckId, front: 'Today held' });
    const todayFree = await seedBasicCard(app, cookie, { deckId, front: 'Today free' });
    const nextHeld = await seedBasicCard(app, cookie, { deckId, front: 'Next held' });
    const nextFree = await seedBasicCard(app, cookie, { deckId, front: 'Next free' });
    const nextDue = new Date(new Date(day.endsAt).getTime() + 3_600_000);
    await db.update(cards).set({ state: 'review', due: new Date(Date.now() - 2 * 86_400_000) }).where(eq(cards.id, overdueHeld.id));
    await db.update(cards).set({ state: 'review', due: new Date(Date.now() - 2 * 86_400_000) }).where(eq(cards.id, overdueFree.id));
    await db.update(cards).set({ state: 'review', due: new Date(Date.now() - 60_000) }).where(eq(cards.id, todayHeld.id));
    await db.update(cards).set({ state: 'review', due: new Date(Date.now() - 60_000) }).where(eq(cards.id, todayFree.id));
    await db.update(cards).set({ state: 'review', due: nextDue }).where(eq(cards.id, nextHeld.id));
    await db.update(cards).set({ state: 'review', due: nextDue }).where(eq(cards.id, nextFree.id));
    const buried = await postHold(cookie, { action: 'bury', cardIds: [overdueHeld.id, todayHeld.id, nextHeld.id] });
    expect(buried.status).toBe(200);
    expect((await buried.json<HoldBody>()).until).toBe(day.endsAt);

    const forecast = await (await callApp(app, 'GET', '/stats/forecast?days=7', { cookie })).json<{
      overdueCount: number;
      total: number;
      buckets: { day: string; count: number }[];
    }>();
    expect(forecast.overdueCount).toBe(1);
    expect(forecast.buckets.find((bucket) => bucket.day === day.label)?.count).toBe(1);
    const later = forecast.buckets.find((bucket) => bucket.day !== day.label);
    expect(later?.count).toBe(2);
    expect(forecast.total).toBe(3);
  });

  test('a custom zone keeps the stored study epoch end', async () => {
    const { cookie, userId, deckId } = await setup();
    const opener = await seedBasicCard(app, cookie, { deckId, front: 'Open' });
    expect((await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: opener.id, rating: 3 } })).status).toBe(200);
    const saved = await callApp(app, 'PATCH', '/profile/study-day', {
      cookie, body: { timeZone: 'Asia/Tokyo', rolloverMinute: 0 },
    });
    expect(saved.status).toBe(200);
    const [opened] = await db.select().from(profile).where(eq(profile.userId, userId));
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Hold' });
    const buried = await postHold(cookie, { action: 'bury', cardIds: [card.id] });
    expect(buried.status).toBe(200);
    expect((await buried.json<HoldBody>()).until).toBe(opened!.studyEpochEnd!.toISOString());
    const [after] = await db.select().from(profile).where(eq(profile.userId, userId));
    expect(after!.studyEpochStart!.toISOString()).toBe(opened!.studyEpochStart!.toISOString());
    expect(after!.studyEpochEnd!.toISOString()).toBe(opened!.studyEpochEnd!.toISOString());
  });

  test('a Tokyo 04:00 rollover uses the database clock when the host clock is already past it', async () => {
    const policy = parseStudyDayPolicy({ timeZone: 'Asia/Tokyo', rolloverMinute: 4 * 60 });
    const hostNow = new Date();
    const boundary = readStudyDay(hostNow, policy, unopenedLedger()).startsAt;
    const databaseNow = new Date(boundary.getTime() - 1);
    const open = readStudyDay(databaseNow, policy, unopenedLedger());
    expect(hostNow.getTime()).toBeGreaterThanOrEqual(open.endsAt.getTime());
    expect(databaseNow.getTime()).toBeLessThan(open.endsAt.getTime());

    const { cookie, userId, deckId } = await setup();
    await db.insert(studyDayPolicy).values({ userId, timeZone: 'Asia/Tokyo', rolloverMinute: 240 });
    await db.update(profile).set({
      studyEpochStart: open.startsAt,
      studyEpochEnd: open.endsAt,
      dailyCountsDate: open.label,
    }).where(eq(profile.userId, userId));
    const held = await seedBasicCard(app, cookie, { deckId, front: 'Skew held' });
    const free = await seedBasicCard(app, cookie, { deckId, front: 'Skew free' });
    const dueAt = new Date(open.startsAt.getTime() + 60_000);
    await db.update(cards).set({ state: 'review', due: dueAt }).where(eq(cards.id, held.id));
    await db.update(cards).set({ state: 'review', due: dueAt }).where(eq(cards.id, free.id));

    __setDatabaseNowForTests(databaseNow);
    try {
      const buried = await postHold(cookie, { action: 'bury', cardIds: [held.id] });
      expect(buried.status).toBe(200);
      expect((await buried.json<HoldBody>()).until).toBe(open.endsAt.toISOString());
      const [after] = await db.select().from(profile).where(eq(profile.userId, userId));
      expect(after!.studyEpochEnd!.toISOString()).toBe(open.endsAt.toISOString());

      const queue = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<{
        due: { id: string }[];
        new: { id: string }[];
      }>();
      const ids = queueIds(queue);
      expect(ids).toContain(free.id);
      expect(ids).not.toContain(held.id);

      const forecast = await (await callApp(app, 'GET', '/stats/forecast?days=7', { cookie })).json<{
        overdueCount: number;
        buckets: { day: string; count: number }[];
      }>();
      expect(forecast.overdueCount).toBe(0);
      expect(forecast.buckets.find((bucket) => bucket.day === open.label)?.count).toBe(1);
    } finally {
      __setDatabaseNowForTests(null);
    }
  });

  test('a study day that does not contain now refuses the bury and writes nothing', async () => {
    const { cookie, userId, deckId } = await setup();
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Mismatch' });
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(Date.now() + 2 * 86_400_000);
    await db.update(profile).set({
      studyEpochStart: start,
      studyEpochEnd: end,
      dailyCountsDate: '2099-01-02',
    }).where(eq(profile.userId, userId));
    const buried = await postHold(cookie, { action: 'bury', cardIds: [card.id] });
    expect(buried.status).toBe(409);
    expect(await buried.json()).toMatchObject({ error: 'epoch_mismatch' });
    const listed = await (await callApp(app, 'GET', '/cards?due=true', { cookie })).json<{ items: { id: string }[] }>();
    expect(listed.items.map((row) => row.id)).toContain(card.id);
    await expect(holdReason(card.id)).resolves.toBeNull();
  });

  test('foreign card ids drop out and a missing note is not found', async () => {
    const owner = await setup();
    const other = await setup();
    const owned = await seedBasicCard(app, owner.cookie, { deckId: owner.deckId, front: 'Mine' });
    const foreign = await seedBasicCard(app, other.cookie, { deckId: other.deckId, front: 'Theirs' });
    const mixed = await postHold(owner.cookie, { action: 'bury', cardIds: [owned.id, foreign.id] });
    expect(mixed.status).toBe(200);
    expect(await mixed.json<HoldBody>()).toMatchObject({ cardIds: [owned.id], changed: 1 });
    expect(await holdReason(owned.id)).toBe('user');
    expect(await holdReason(foreign.id)).toBeNull();
    const onlyForeign = await postHold(owner.cookie, { action: 'bury', cardIds: [foreign.id] });
    expect(onlyForeign.status).toBe(200);
    expect(await onlyForeign.json<HoldBody>()).toMatchObject({ action: 'bury', cardIds: [], changed: 0 });
    expect(await holdReason(foreign.id)).toBeNull();

    const missing = await postHold(owner.cookie, { action: 'bury', noteId: crypto.randomUUID() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'not_found' });
    const foreignNote = await postHold(owner.cookie, { action: 'unbury', noteId: foreign.noteId });
    expect(foreignNote.status).toBe(404);

    const emptyNote = await seedNote(app, owner.cookie, {
      deckId: owner.deckId, fields: { Front: 'Empty', Back: '' },
    });
    await db.delete(cards).where(eq(cards.noteId, emptyNote.note.id));
    const none = await postHold(owner.cookie, { action: 'bury', noteId: emptyNote.note.id });
    expect(none.status).toBe(200);
    expect(await none.json<HoldBody>()).toMatchObject({ action: 'bury', cardIds: [], changed: 0 });
  });

  test('an empty selection, both targets, and more than 1000 cards are invalid', async () => {
    const { cookie, userId, deckId } = await setup();
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Cap' });
    for (const body of [
      { action: 'bury', cardIds: [] },
      { action: 'bury' },
      { action: 'bury', cardIds: [card.id], noteId: card.noteId },
      { action: 'unbury', cardIds: Array.from({ length: 1001 }, () => crypto.randomUUID()) },
    ]) {
      const res = await postHold(cookie, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_hold' });
    }
    await db.insert(cards).values(Array.from({ length: 1000 }, (_, i) => ({
      userId, deckId, noteId: card.noteId, templateOrd: i + 1,
    })));
    const tooMany = await postHold(cookie, { action: 'bury', noteId: card.noteId });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ error: 'invalid_hold' });
    const one = await postHold(cookie, { action: 'bury', cardIds: [card.id] });
    expect(one.status).toBe(200);
    expect((await one.json<HoldBody>()).changed).toBe(1);
  });

  test('deleting the card removes its hold', async () => {
    const { cookie, deckId } = await setup();
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Gone' });
    expect((await postHold(cookie, { action: 'bury', cardIds: [card.id] })).status).toBe(200);
    expect((await callApp(app, 'DELETE', `/cards/${card.id}`, { cookie })).status).toBe(200);
    expect(await holdReason(card.id)).toBeNull();
  });
});
