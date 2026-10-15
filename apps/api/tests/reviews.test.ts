import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { cards, db, deckOptionsPreset, decks } from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

type ProfileRow = {
  newIntroducedToday: number;
  reviewsDoneToday: number;
  dailyCountsDate: string | null;
};

/** Insert a preset for `userId` (Phase 5 CRUD doesn't exist yet — go direct). */
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

/** Bind a deck to a preset directly (Phase 5 PATCH binding doesn't exist yet). */
async function bindPreset(deckId: string, presetId: string): Promise<void> {
  await db.update(decks).set({ presetId }).where(eq(decks.id, deckId));
}

async function makeDeck(cookie: string, name: string, parentId?: string): Promise<string> {
  const deck = await (
    await callApp(app, 'POST', '/decks', {
      cookie,
      body: { name, ...(parentId ? { parentId } : {}) },
    })
  ).json<{ id: string }>();
  return deck.id;
}

async function readProfile(cookie: string): Promise<ProfileRow> {
  return (await callApp(app, 'GET', '/profile', { cookie })).json<ProfileRow>();
}

async function setupCard(): Promise<{ cookie: string; cardId: string; deckId: string }> {
  const { cookie } = await signUpAndCookie(app, uniqueEmail());
  // Touch /profile so lazy-create runs → streak rollup has somewhere to write.
  await callApp(app, 'GET', '/profile', { cookie });
  const deck = await (
    await callApp(app, 'POST', '/decks', { cookie, body: { name: 'D' } })
  ).json<{ id: string }>();
  // Card content is derived from a note now (note-types M1): seed a Basic note.
  const card = await seedBasicCard(app, cookie, {
    deckId: deck.id,
    front: 'der Hund',
    back: 'the dog',
  });
  return { cookie, cardId: card.id, deckId: deck.id };
}

describe('reviews', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('Good grade advances the card and appends a review row', async () => {
    const { cookie, cardId } = await setupCard();
    const res = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId, rating: 3, durationMs: 2000 },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      card: { state: string; reps: number; lapses: number };
      review: { rating: number; durationMs: number };
      profile: { xp: number; streakDays: number; plantStage: number };
      leeched: boolean;
    }>();
    expect(body.card.state).not.toBe('new');
    expect(body.card.reps).toBe(1);
    expect(body.card.lapses).toBe(0);
    expect(body.review.rating).toBe(3);
    expect(body.review.durationMs).toBe(2000);
    // Good = 10 XP, streak starts at 1.
    expect(body.profile.xp).toBe(10);
    expect(body.profile.streakDays).toBe(1);
    expect(body.profile.plantStage).toBe(0);
    expect(body.leeched).toBe(false);
  });

  test('Again on a new card gives 0 XP but still counts toward streak', async () => {
    const { cookie, cardId } = await setupCard();
    const res = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId, rating: 1 },
    });
    const body = await res.json<{ profile: { xp: number; streakDays: number } }>();
    expect(body.profile.xp).toBe(0);
    expect(body.profile.streakDays).toBe(1);
  });

  test('Easy = 15 XP', async () => {
    const { cookie, cardId } = await setupCard();
    const res = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId, rating: 4 },
    });
    const body = await res.json<{ profile: { xp: number } }>();
    expect(body.profile.xp).toBe(15);
  });

  test('cannot grade a card that belongs to another user', async () => {
    const { cookie: aCookie } = await signUpAndCookie(app, uniqueEmail('a'));
    const { cookie: bCookie } = await signUpAndCookie(app, uniqueEmail('b'));
    const aDeck = await (
      await callApp(app, 'POST', '/decks', { cookie: aCookie, body: { name: 'A' } })
    ).json<{ id: string }>();
    const aCard = await seedBasicCard(app, aCookie, { deckId: aDeck.id, front: 'x', back: 'y' });
    const res = await callApp(app, 'POST', '/reviews', {
      cookie: bCookie,
      body: { cardId: aCard.id, rating: 3 },
    });
    expect(res.status).toBe(404);
  });

  test('cannot grade a suspended card (409)', async () => {
    const { cookie, cardId } = await setupCard();
    await callApp(app, 'PATCH', `/cards/${cardId}`, { cookie, body: { suspended: true } });
    const res = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId, rating: 3 },
    });
    expect(res.status).toBe(409);
  });

  test('GET /reviews/count reports totals', async () => {
    const { cookie, cardId } = await setupCard();
    const zero = await (await callApp(app, 'GET', '/reviews/count', { cookie })).json<{
      count: number;
    }>();
    expect(zero.count).toBe(0);

    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 3 } });
    const after = await (await callApp(app, 'GET', '/reviews/count', { cookie })).json<{
      count: number;
    }>();
    expect(after.count).toBe(1);
  });

  test('GET /reviews filters by since', async () => {
    const { cookie, cardId } = await setupCard();
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 3 } });
    const future = Date.now() + 60_000;
    const none = await (
      await callApp(app, 'GET', `/reviews?since=${future}`, { cookie })
    ).json<unknown>();
    expect(none).toEqual([]);
    const all = await (await callApp(app, 'GET', '/reviews', { cookie })).json<{ id: string; rating: number; undoSnapshot?: unknown }[]>();
    expect(Array.isArray(all)).toBe(true);
    expect(all).toHaveLength(1);
    expect(all[0]).toHaveProperty('undoSnapshot');
    expect(all[0]).toMatchObject({ rating: 3 });
  });

  test('GET /reviews pages without the undo snapshot', async () => {
    const { cookie, cardId } = await setupCard();
    for (const rating of [1, 2, 3] as const) {
      await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating } });
    }
    const first = await (await callApp(app, 'GET', '/reviews?limit=2', { cookie })).json<{
      items: { rating: number; undoSnapshot?: unknown }[];
      nextCursor: string | null;
    }>();
    expect(first.items.map((row) => row.rating)).toEqual([3, 2]);
    expect(first.items.every((row) => row.undoSnapshot === undefined)).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = await (await callApp(app, 'GET', `/reviews?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, { cookie })).json<{
      items: { rating: number }[];
      nextCursor: string | null;
    }>();
    expect(second.items.map((row) => row.rating)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
    expect((await callApp(app, 'GET', '/reviews?cursor=not-a-cursor', { cookie })).status).toBe(400);
  });
});

// ── M3 Phase 3: per-deck config + global daily counters ──────────────────────

describe('reviews — per-deck preset config', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('(a) custom learningSteps reach FSRS — distinct due vs default', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });

    // Control deck (no preset) + preset deck with day-scale learning steps.
    const controlDeck = await makeDeck(cookie, 'control');
    const presetDeck = await makeDeck(cookie, 'fast');
    const presetId = await insertPreset(userId, { learningSteps: ['1d', '3d'] });
    await bindPreset(presetDeck, presetId);

    const controlCard = await seedBasicCard(app, cookie, {
      deckId: controlDeck,
      front: 'a',
      back: 'b',
    });
    const presetCard = await seedBasicCard(app, cookie, {
      deckId: presetDeck,
      front: 'c',
      back: 'd',
    });

    const controlRes = await (
      await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: controlCard.id, rating: 3 } })
    ).json<{ card: { due: string } }>();
    const presetRes = await (
      await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: presetCard.id, rating: 3 } })
    ).json<{ card: { due: string } }>();

    // Default '1m','10m' steps → due within minutes; '1d','3d' → due a day out.
    expect(controlRes.card.due).not.toBe(presetRes.card.due);
    const controlMs = new Date(controlRes.card.due).getTime() - Date.now();
    const presetMs = new Date(presetRes.card.due).getTime() - Date.now();
    expect(controlMs).toBeLessThan(60 * 60 * 1000); // < 1h
    expect(presetMs).toBeGreaterThan(12 * 60 * 60 * 1000); // > 12h
  });

  test('(b) per-deck leechThreshold=3 auto-suspends at the 3rd lapse, not 8', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });

    const deckId = await makeDeck(cookie, 'leechy');
    const presetId = await insertPreset(userId, { leechThreshold: 3 });
    await bindPreset(deckId, presetId);

    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
    // Drive the card to Review state with 2 prior lapses; one more Again → 3.
    await db
      .update(cards)
      .set({ state: 'review', lapses: 2, stability: 10, difficulty: 5, reps: 5 })
      .where(eq(cards.id, card.id));

    const res = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId: card.id, rating: 1 },
    });
    const body = await res.json<{ card: { lapses: number; suspended: boolean }; leeched: boolean }>();
    expect(body.card.lapses).toBe(3);
    expect(body.leeched).toBe(true);
    expect(body.card.suspended).toBe(true);

    // A 4th grade on the now-suspended card → 409.
    const blocked = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId: card.id, rating: 3 },
    });
    expect(blocked.status).toBe(409);
  });

  test('(b2) default threshold (8) does NOT suspend at 3 lapses', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });

    const deckId = await makeDeck(cookie, 'plain'); // no preset → ANKI default 8
    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
    await db
      .update(cards)
      .set({ state: 'review', lapses: 2, stability: 10, difficulty: 5, reps: 5 })
      .where(eq(cards.id, card.id));

    const body = await (
      await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 1 } })
    ).json<{ card: { lapses: number; suspended: boolean }; leeched: boolean }>();
    expect(body.card.lapses).toBe(3);
    expect(body.leeched).toBe(false);
    expect(body.card.suspended).toBe(false);
  });

  test('(c) 3-level inheritance — child grades with grandparent preset steps', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });

    // grandparent (HAS preset) → parent (no preset) → child (no preset).
    const grand = await makeDeck(cookie, 'grand');
    const parent = await makeDeck(cookie, 'parent', grand);
    const child = await makeDeck(cookie, 'child', parent);
    const presetId = await insertPreset(userId, { learningSteps: ['1d', '3d'] });
    await bindPreset(grand, presetId);

    // Control card on a wholly-default deck for comparison.
    const controlDeck = await makeDeck(cookie, 'control');
    const controlCard = await seedBasicCard(app, cookie, {
      deckId: controlDeck,
      front: 'a',
      back: 'b',
    });
    const childCard = await seedBasicCard(app, cookie, { deckId: child, front: 'c', back: 'd' });

    const controlRes = await (
      await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: controlCard.id, rating: 3 } })
    ).json<{ card: { due: string } }>();
    const childRes = await (
      await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: childCard.id, rating: 3 } })
    ).json<{ card: { due: string } }>();

    expect(childRes.card.due).not.toBe(controlRes.card.due);
    const childMs = new Date(childRes.card.due).getTime() - Date.now();
    expect(childMs).toBeGreaterThan(12 * 60 * 60 * 1000); // grandparent's '1d' step
  });

  test('(d) NEW card grade increments new_introduced_today', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });

    const deckId = await makeDeck(cookie, 'D');
    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });

    const before = await readProfile(cookie);
    expect(before.newIntroducedToday).toBe(0);
    expect(before.reviewsDoneToday).toBe(0);

    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 3 } });

    const after = await readProfile(cookie);
    expect(after.newIntroducedToday).toBe(1);
    expect(after.reviewsDoneToday).toBe(0);
    expect(after.dailyCountsDate).toBe(new Date().toISOString().slice(0, 10));
  });

  test('(d2) REVIEW card grade increments reviews_done_today', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });

    const deckId = await makeDeck(cookie, 'D');
    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
    // Flip to a non-new state so the grade counts as a review, not introduction.
    await db
      .update(cards)
      .set({ state: 'review', stability: 10, difficulty: 5, reps: 3 })
      .where(eq(cards.id, card.id));

    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 3 } });

    const after = await readProfile(cookie);
    expect(after.newIntroducedToday).toBe(0);
    expect(after.reviewsDoneToday).toBe(1);
  });

  test('(e) source:filtered grade leaves both counters unchanged', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });

    const deckId = await makeDeck(cookie, 'D');
    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });

    const res = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId: card.id, rating: 3, source: 'filtered' },
    });
    expect(res.status).toBe(200);

    const after = await readProfile(cookie);
    expect(after.newIntroducedToday).toBe(0);
    expect(after.reviewsDoneToday).toBe(0);
    expect(after.dailyCountsDate).toBe(new Date().toISOString().slice(0, 10));
  });
});

type LeechGrade = {
  card: { id: string; lapses: number; suspended: boolean; state: string };
  review: { id: string; rating: number };
  leeched: boolean;
};

async function gradeAgain(cookie: string, cardId: string): Promise<{ status: number; body: LeechGrade }> {
  const res = await callApp(app, 'POST', '/reviews', {
    cookie,
    body: { cardId, rating: 1 },
  });
  return { status: res.status, body: await res.json<LeechGrade>() };
}

/** One Good finishes the default 10m relearning step and returns the card to review. */
async function graduateRelearning(cookie: string, cardId: string, lapses: number): Promise<LeechGrade> {
  const res = await callApp(app, 'POST', '/reviews', {
    cookie,
    body: { cardId, rating: 3 },
  });
  const body = await res.json<LeechGrade>();
  expect(res.status).toBe(200);
  expect(body.card.state).toBe('review');
  expect(body.card.lapses).toBe(lapses);
  expect(body.leeched).toBe(false);
  expect(body.card.suspended).toBe(false);
  return body;
}

async function reviewHistory(cookie: string): Promise<{ id: string; cardId: string; rating: number }[]> {
  return (await callApp(app, 'GET', '/reviews', { cookie })).json();
}

/** A review-state card one lapse short of `lapses`. */
async function armReviewCard(cookie: string, deckId: string, lapses: number): Promise<string> {
  const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
  await db
    .update(cards)
    .set({ state: 'review', lapses, stability: 10, difficulty: 5, reps: 5 })
    .where(eq(cards.id, card.id));
  return card.id;
}

describe('reviews — leech rediscovery', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('unsuspend then a later review fail suspends on the next half-threshold lapse', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });
    const deckId = await makeDeck(cookie, 'leech-return');
    const presetId = await insertPreset(userId, { leechThreshold: 4 });
    await bindPreset(deckId, presetId);
    const cardId = await armReviewCard(cookie, deckId, 3);

    const first = await gradeAgain(cookie, cardId);
    expect(first.status).toBe(200);
    expect(first.body.card.lapses).toBe(4);
    expect(first.body.leeched).toBe(true);
    expect(first.body.card.suspended).toBe(true);

    const returned = await (
      await callApp(app, 'PATCH', `/cards/${cardId}`, { cookie, body: { suspended: false } })
    ).json<{ lapses: number; suspended: boolean; state: string }>();
    expect(returned.lapses).toBe(4);
    expect(returned.suspended).toBe(false);
    expect(returned.state).toBe('relearning');

    const stillRelearning = await gradeAgain(cookie, cardId);
    expect(stillRelearning.status).toBe(200);
    expect(stillRelearning.body.card.lapses).toBe(4);
    expect(stillRelearning.body.card.state).toBe('relearning');
    expect(stillRelearning.body.leeched).toBe(false);
    expect(stillRelearning.body.card.suspended).toBe(false);

    await graduateRelearning(cookie, cardId, 4);
    const between = await gradeAgain(cookie, cardId);
    expect(between.status).toBe(200);
    expect(between.body.card.lapses).toBe(5);
    expect(between.body.card.state).toBe('relearning');
    expect(between.body.leeched).toBe(false);
    expect(between.body.card.suspended).toBe(false);

    await graduateRelearning(cookie, cardId, 5);
    const rediscovered = await gradeAgain(cookie, cardId);
    expect(rediscovered.status).toBe(200);
    expect(rediscovered.body.card.lapses).toBe(6);
    expect(rediscovered.body.leeched).toBe(true);
    expect(rediscovered.body.card.suspended).toBe(true);

    const history = await reviewHistory(cookie);
    expect(history.map((row) => row.rating)).toEqual([1, 3, 1, 3, 1, 1]);
    expect(history.map((row) => row.cardId)).toEqual(Array(6).fill(cardId));
    expect(history.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        rediscovered.body.review.id,
        between.body.review.id,
        stillRelearning.body.review.id,
        first.body.review.id,
      ]),
    );
  });

  test('lowering the threshold suspends on the next half-step of the new value', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });
    const deckId = await makeDeck(cookie, 'leech-lower');
    const presetId = await insertPreset(userId, { leechThreshold: 8 });
    await bindPreset(deckId, presetId);
    const cardId = await armReviewCard(cookie, deckId, 7);

    const first = await gradeAgain(cookie, cardId);
    expect(first.body.card.lapses).toBe(8);
    expect(first.body.leeched).toBe(true);
    expect(first.body.card.suspended).toBe(true);

    await callApp(app, 'PATCH', `/cards/${cardId}`, { cookie, body: { suspended: false } });
    const patched = await (
      await callApp(app, 'PATCH', `/deck-options/${presetId}`, {
        cookie,
        body: { leechThreshold: 5 },
      })
    ).json<{ leechThreshold: number }>();
    expect(patched.leechThreshold).toBe(5);

    const stillStudying = await (
      await callApp(app, 'GET', `/cards/${cardId}`, { cookie })
    ).json<{ lapses: number; suspended: boolean }>();
    expect(stillStudying).toMatchObject({ lapses: 8, suspended: false });
    await graduateRelearning(cookie, cardId, 8);

    const nine = await gradeAgain(cookie, cardId);
    expect(nine.status).toBe(200);
    expect(nine.body.card.lapses).toBe(9);
    expect(nine.body.leeched).toBe(false);
    expect(nine.body.card.suspended).toBe(false);

    await graduateRelearning(cookie, cardId, 9);
    const ten = await gradeAgain(cookie, cardId);
    expect(ten.status).toBe(200);
    expect(ten.body.card.lapses).toBe(10);
    expect(ten.body.leeched).toBe(false);
    expect(ten.body.card.suspended).toBe(false);

    await graduateRelearning(cookie, cardId, 10);
    const hit = await gradeAgain(cookie, cardId);
    expect(hit.status).toBe(200);
    expect(hit.body.card.lapses).toBe(11);
    expect(hit.body.leeched).toBe(true);
    expect(hit.body.card.suspended).toBe(true);

    const history = await reviewHistory(cookie);
    expect(history).toHaveLength(7);
    expect(history.map((row) => row.rating)).toEqual([1, 3, 1, 3, 1, 3, 1]);
    expect(history.map((row) => row.id)).toContain(first.body.review.id);
  });

  test('raising the threshold waits for the new multiple', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });
    const deckId = await makeDeck(cookie, 'leech-raise');
    const presetId = await insertPreset(userId, { leechThreshold: 4 });
    await bindPreset(deckId, presetId);
    const cardId = await armReviewCard(cookie, deckId, 3);

    const first = await gradeAgain(cookie, cardId);
    expect(first.body.leeched).toBe(true);
    expect(first.body.card.lapses).toBe(4);

    await callApp(app, 'PATCH', `/cards/${cardId}`, { cookie, body: { suspended: false } });
    await callApp(app, 'PATCH', `/deck-options/${presetId}`, {
      cookie,
      body: { leechThreshold: 6 },
    });
    await graduateRelearning(cookie, cardId, 4);

    const early = await gradeAgain(cookie, cardId);
    expect(early.body.card.lapses).toBe(5);
    expect(early.body.leeched).toBe(false);
    expect(early.body.card.suspended).toBe(false);

    await graduateRelearning(cookie, cardId, 5);
    const hit = await gradeAgain(cookie, cardId);
    expect(hit.body.card.lapses).toBe(6);
    expect(hit.body.leeched).toBe(true);
    expect(hit.body.card.suspended).toBe(true);

    const history = await reviewHistory(cookie);
    expect(history).toHaveLength(5);
    expect(history.map((row) => row.rating)).toEqual([1, 3, 1, 3, 1]);
    expect(history.map((row) => row.id)).toContain(first.body.review.id);
  });

  test('a threshold edit and a passing grade do not suspend or drop history', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });
    const deckId = await makeDeck(cookie, 'leech-quiet');
    const presetId = await insertPreset(userId, { leechThreshold: 4 });
    await bindPreset(deckId, presetId);
    const cardId = await armReviewCard(cookie, deckId, 3);

    const first = await gradeAgain(cookie, cardId);
    expect(first.body.card.suspended).toBe(true);
    await callApp(app, 'PATCH', `/cards/${cardId}`, { cookie, body: { suspended: false } });
    await callApp(app, 'PATCH', `/deck-options/${presetId}`, {
      cookie,
      body: { leechThreshold: 3 },
    });

    const afterEdit = await (
      await callApp(app, 'GET', `/cards/${cardId}`, { cookie })
    ).json<{ lapses: number; suspended: boolean }>();
    expect(afterEdit).toMatchObject({ lapses: 4, suspended: false });

    const passed = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId, rating: 3 },
    });
    expect(passed.status).toBe(200);
    const passedBody = await passed.json<LeechGrade>();
    expect(passedBody.card.lapses).toBe(4);
    expect(passedBody.leeched).toBe(false);
    expect(passedBody.card.suspended).toBe(false);

    const history = await reviewHistory(cookie);
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.rating)).toEqual([3, 1]);
    expect(history.map((row) => row.id)).toContain(first.body.review.id);
  });

  test('already past a lowered threshold suspends on the next half-step', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    await callApp(app, 'GET', '/profile', { cookie });
    const deckId = await makeDeck(cookie, 'leech-already');
    const presetId = await insertPreset(userId, { leechThreshold: 8 });
    await bindPreset(deckId, presetId);
    const cardId = await armReviewCard(cookie, deckId, 5);

    await callApp(app, 'PATCH', `/deck-options/${presetId}`, {
      cookie,
      body: { leechThreshold: 4 },
    });
    const before = await (
      await callApp(app, 'GET', `/cards/${cardId}`, { cookie })
    ).json<{ lapses: number; suspended: boolean }>();
    expect(before).toMatchObject({ lapses: 5, suspended: false });

    const six = await gradeAgain(cookie, cardId);
    expect(six.status).toBe(200);
    expect(six.body.card.lapses).toBe(6);
    expect(six.body.leeched).toBe(true);
    expect(six.body.card.suspended).toBe(true);

    const history = await reviewHistory(cookie);
    expect(history).toHaveLength(1);
    expect(history.map((row) => row.rating)).toEqual([1]);
    expect(history[0]?.cardId).toBe(cardId);
  });
});
