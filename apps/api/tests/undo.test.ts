import { beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { cards, db, deckOptionsPreset, decks, profile, reviews } from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

async function makeDeck(cookie: string, name: string): Promise<string> {
  const deck = await (
    await callApp(app, 'POST', '/decks', { cookie, body: { name } })
  ).json<{ id: string }>();
  return deck.id;
}

async function insertPreset(
  userId: string,
  over: Partial<typeof deckOptionsPreset.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(deckOptionsPreset)
    .values({ userId, name: 'P', ...over })
    .returning();
  return row!.id;
}

async function bindPreset(deckId: string, presetId: string): Promise<void> {
  await db.update(decks).set({ presetId }).where(eq(decks.id, deckId));
}

async function setupCard(): Promise<{
  cookie: string;
  userId: string;
  cardId: string;
  deckId: string;
}> {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  await callApp(app, 'GET', '/profile', { cookie });
  const deckId = await makeDeck(cookie, 'D');
  const card = await seedBasicCard(app, cookie, { deckId, front: 'der Hund', back: 'the dog' });
  return { cookie, userId, cardId: card.id, deckId };
}

/** Read the raw card row (all FSRS columns, dates as Date). */
async function rawCard(cardId: string) {
  const [row] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
  return row!;
}

/** Read the raw profile row. */
async function rawProfile(userId: string) {
  const [row] = await db.select().from(profile).where(eq(profile.userId, userId)).limit(1);
  return row!;
}

/** Stringify a card row's mutate-set fields for byte-identical comparison. */
function cardMutateSet(c: Awaited<ReturnType<typeof rawCard>>) {
  return {
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsedDays,
    scheduledDays: c.scheduledDays,
    learningSteps: c.learningSteps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    lastReview: c.lastReview ? c.lastReview.toISOString() : null,
    suspended: c.suspended,
    updatedAt: c.updatedAt.toISOString(),
  };
}

function profileMutateSet(p: Awaited<ReturnType<typeof rawProfile>>) {
  return {
    streakDays: p.streakDays,
    streakFreezes: p.streakFreezes,
    lastReviewDate: p.lastReviewDate,
    todayMinutes: p.todayMinutes,
    todayMinutesDate: p.todayMinutesDate,
    dailyGoalMetCount: p.dailyGoalMetCount,
    dailyGoalMetDate: p.dailyGoalMetDate,
    xp: p.xp,
    level: p.level,
    plantStage: p.plantStage,
    newIntroducedToday: p.newIntroducedToday,
    reviewsDoneToday: p.reviewsDoneToday,
    dailyCountsDate: p.dailyCountsDate,
    updatedAt: p.updatedAt.toISOString(),
  };
}

describe('reviews — undo', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('round-trip: grade → undo restores card + profile byte-identically (incl. updatedAt)', async () => {
    const { cookie, userId, cardId } = await setupCard();

    const cardBefore = cardMutateSet(await rawCard(cardId));
    const profileBefore = profileMutateSet(await rawProfile(userId));

    const grade = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId, rating: 3, durationMs: 2000 },
    });
    expect(grade.status).toBe(200);

    // The grade actually changed things.
    expect(cardMutateSet(await rawCard(cardId))).not.toEqual(cardBefore);
    expect(profileMutateSet(await rawProfile(userId))).not.toEqual(profileBefore);

    const undo = await callApp(app, 'POST', '/reviews/undo', { cookie });
    expect(undo.status).toBe(200);
    const body = await undo.json<{ card: { id: string }; profile: { xp: number } }>();
    expect(body.card.id).toBe(cardId);

    // Byte-identical restore, including updatedAt.
    expect(cardMutateSet(await rawCard(cardId))).toEqual(cardBefore);
    expect(profileMutateSet(await rawProfile(userId))).toEqual(profileBefore);

    // The review row is gone.
    const [row] = await db.select().from(reviews).where(eq(reviews.userId, userId));
    expect(row).toBeUndefined();
  });

  test('undo response shape matches grade response (card + profile for the mirror)', async () => {
    const { cookie, cardId } = await setupCard();
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 3 } });
    const undo = await callApp(app, 'POST', '/reviews/undo', { cookie });
    const body = await undo.json<{
      card: { state: string; reps: number; lapses: number };
      profile: { xp: number; streakDays: number };
    }>();
    // Card is back to new with 0 reps; profile XP back to 0.
    expect(body.card.state).toBe('new');
    expect(body.card.reps).toBe(0);
    expect(body.card.lapses).toBe(0);
    expect(body.profile.xp).toBe(0);
    expect(body.profile.streakDays).toBe(0);
  });

  test('undo twice → second returns 404 nothing_to_undo', async () => {
    const { cookie, cardId } = await setupCard();
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 3 } });

    const first = await callApp(app, 'POST', '/reviews/undo', { cookie });
    expect(first.status).toBe(200);

    const second = await callApp(app, 'POST', '/reviews/undo', { cookie });
    expect(second.status).toBe(404);
    expect(await second.json<{ error: string }>()).toEqual({ error: 'nothing_to_undo' });
  });

  test('undo with no grades at all → 404', async () => {
    const { cookie } = await setupCard();
    const res = await callApp(app, 'POST', '/reviews/undo', { cookie });
    expect(res.status).toBe(404);
    expect(await res.json<{ error: string }>()).toEqual({ error: 'nothing_to_undo' });
  });

  test("undo only ever touches the caller's own reviews (other user → 404)", async () => {
    const { cookie: aCookie, cardId: aCard } = await setupCard();
    // A grades a card.
    await callApp(app, 'POST', '/reviews', { cookie: aCookie, body: { cardId: aCard, rating: 3 } });

    // B has no grades → B's undo is 404 (does not touch A's review).
    const { cookie: bCookie } = await setupCard();
    const bUndo = await callApp(app, 'POST', '/reviews/undo', { cookie: bCookie });
    expect(bUndo.status).toBe(404);

    // A's review row is still present and undoable.
    const aUndo = await callApp(app, 'POST', '/reviews/undo', { cookie: aCookie });
    expect(aUndo.status).toBe(200);
  });

  test('filtered-source grade → undo restores daily counters unchanged (no-op restore)', async () => {
    const { cookie, userId, cardId } = await setupCard();
    const profileBefore = profileMutateSet(await rawProfile(userId));

    await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId, rating: 3, source: 'filtered' },
    });

    // Daily counters never moved for a filtered grade.
    const afterGrade = await rawProfile(userId);
    expect(afterGrade.newIntroducedToday).toBe(0);
    expect(afterGrade.reviewsDoneToday).toBe(0);
    expect(afterGrade.dailyCountsDate).toBeNull();

    const undo = await callApp(app, 'POST', '/reviews/undo', { cookie });
    expect(undo.status).toBe(200);

    // Profile fully restored — counters still null, XP/streak rolled back.
    expect(profileMutateSet(await rawProfile(userId))).toEqual(profileBefore);
  });

  test('leech auto-suspend → undo removes the suspension', async () => {
    const { cookie, userId, cardId } = await setupCard();
    const presetId = await insertPreset(userId, { leechThreshold: 3 });
    // Bind the card's deck to the low-threshold preset.
    const deckId = (await rawCard(cardId)).deckId;
    await bindPreset(deckId, presetId);
    // Drive to Review with 2 prior lapses; next Again → lapse 3 → suspend.
    await db
      .update(cards)
      .set({ state: 'review', lapses: 2, stability: 10, difficulty: 5, reps: 5 })
      .where(eq(cards.id, cardId));

    const cardBefore = cardMutateSet(await rawCard(cardId));
    expect(cardBefore.suspended).toBe(false);

    const grade = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId, rating: 1 },
    });
    const gradeBody = await grade.json<{ leeched: boolean; card: { suspended: boolean } }>();
    expect(gradeBody.leeched).toBe(true);
    expect(gradeBody.card.suspended).toBe(true);

    const undo = await callApp(app, 'POST', '/reviews/undo', { cookie });
    expect(undo.status).toBe(200);
    const undoBody = await undo.json<{ card: { suspended: boolean; lapses: number } }>();
    expect(undoBody.card.suspended).toBe(false);
    expect(undoBody.card.lapses).toBe(2);
    // Byte-identical including the un-suspend.
    expect(cardMutateSet(await rawCard(cardId))).toEqual(cardBefore);
  });

  test('new → learning transition → undo returns card to new', async () => {
    const { cookie, cardId } = await setupCard();
    expect((await rawCard(cardId)).state).toBe('new');

    const grade = await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 1 } });
    const gradeBody = await grade.json<{ card: { state: string } }>();
    expect(gradeBody.card.state).not.toBe('new'); // moved into learning

    const undo = await callApp(app, 'POST', '/reviews/undo', { cookie });
    const undoBody = await undo.json<{ card: { state: string } }>();
    expect(undoBody.card.state).toBe('new');
  });

  test('two grades in the same instant → undo rolls back the genuinely-last (id DESC tie-break)', async () => {
    const { cookie, userId } = await setupCard();
    const deckId = await makeDeck(cookie, 'tie');
    const c1 = await seedBasicCard(app, cookie, { deckId, front: 'a', back: 'b' });
    const c2 = await seedBasicCard(app, cookie, { deckId, front: 'c', back: 'd' });

    // Grade both.
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: c1.id, rating: 3 } });
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: c2.id, rating: 3 } });

    // Force both review rows to the SAME reviewedAt so the tie-break is on id.
    // Use a moment >= the cards' updatedAt so the stale-guard (updatedAt >
    // reviewedAt) doesn't trip — here we exercise the id-DESC tie-break only.
    const tie = new Date(Date.now() + 60_000);
    await db.update(reviews).set({ reviewedAt: tie }).where(eq(reviews.userId, userId));

    // Determine which review row has the larger id (the genuinely-last to undo).
    const rows = await db
      .select({ id: reviews.id, cardId: reviews.cardId })
      .from(reviews)
      .where(eq(reviews.userId, userId))
      .orderBy(sql`${reviews.id} DESC`);
    const lastCardId = rows[0]!.cardId;

    const undo = await callApp(app, 'POST', '/reviews/undo', { cookie });
    expect(undo.status).toBe(200);
    const body = await undo.json<{ card: { id: string } }>();
    // Undo restored the card whose review row had the larger id.
    expect(body.card.id).toBe(lastCardId);

    // Exactly one review row remains (the other-card grade).
    const remaining = await db.select().from(reviews).where(eq(reviews.userId, userId));
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.cardId).not.toBe(lastCardId);
  });

  test('NULL-snapshot review row (legacy / pre-0008) → 404, not 500', async () => {
    const { cookie, userId, cardId, deckId } = await setupCard();
    // Insert a review row WITHOUT a snapshot (simulates a pre-0008 grade).
    await db.insert(reviews).values({
      userId,
      cardId,
      deckId,
      rating: 3,
      durationMs: 0,
      reviewedAt: new Date(),
      nextDue: new Date(),
      nextStability: 1,
      nextDifficulty: 1,
      // undoSnapshot omitted → NULL
    });

    const res = await callApp(app, 'POST', '/reviews/undo', { cookie });
    expect(res.status).toBe(404);
    expect(await res.json<{ error: string }>()).toEqual({ error: 'nothing_to_undo' });

    // The NULL-snapshot row was NOT deleted.
    const rows = await db.select().from(reviews).where(eq(reviews.userId, userId));
    expect(rows.length).toBe(1);
  });

  test('card modified after grade (updatedAt > reviewedAt) → 409 card_modified_since_review', async () => {
    const { cookie, cardId } = await setupCard();
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 3 } });

    // Simulate a manual mutation (forget / setDue, Step 3) bumping updatedAt to
    // a moment strictly after the grade's reviewedAt.
    await db
      .update(cards)
      .set({ updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(cards.id, cardId));

    const undo = await callApp(app, 'POST', '/reviews/undo', { cookie });
    expect(undo.status).toBe(409);
    expect(await undo.json<{ error: string }>()).toEqual({ error: 'card_modified_since_review' });

    // The review row was NOT deleted (undo blocked, not consumed).
    const rows = await db.select().from(reviews).where(eq(reviews.cardId, cardId));
    expect(rows.length).toBe(1);
  });

  test('only the LAST grade is undone — earlier grade survives a single undo', async () => {
    const { cookie, userId, cardId } = await setupCard();
    // Two sequential grades on the same card.
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 3 } });
    const afterFirst = cardMutateSet(await rawCard(cardId));
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 3 } });

    const undo = await callApp(app, 'POST', '/reviews/undo', { cookie });
    expect(undo.status).toBe(200);
    // Card is back to the state AFTER the first grade (the 2nd was undone).
    expect(cardMutateSet(await rawCard(cardId))).toEqual(afterFirst);
    // One review row remains.
    const rows = await db.select().from(reviews).where(eq(reviews.userId, userId));
    expect(rows.length).toBe(1);
  });
});
