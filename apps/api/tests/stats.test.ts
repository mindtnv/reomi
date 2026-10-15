// /stats module integration tests: the due forecast + interval retention curve.
//
// Cards are seeded via the real API (seedBasicCard) and then their FSRS columns
// (due/state/suspended) are set DIRECTLY via db.update — the POST /reviews path
// applies FSRS and only ever grades "now", which can't produce controlled due
// dates. Reviews are likewise inserted directly with controlled reviewed_at
// (same approach as progress-tools.test.ts).

import { beforeEach, describe, expect, test } from 'bun:test';
import { cards as cardsTable, db, reviews } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';
import {
  clampForecastDays,
  RETENTION_BUCKETS,
} from '../src/modules/progress-stats.ts';

const app = buildApp();

const DAY_MS = 86400000;
// One fixed reference instant per test run: exact-boundary gaps (e.g. exactly
// 1 day between two seeded reviews) must not drift by the few ms between two
// separate Date.now() calls, or they'd flake across the `< interval '1 day'`
// bucket edge.
const NOW = Date.now();
const daysFromNow = (n: number): Date => new Date(NOW + n * DAY_MS);
const daysAgo = (n: number): Date => new Date(NOW - n * DAY_MS);

async function freshDeck(cookie: string, name = 'D', parentId?: string): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', {
    cookie,
    body: { name, ...(parentId ? { parentId } : {}) },
  });
  return (await res.json<{ id: string }>()).id;
}

/** Seed a card and force its scheduling columns (due/state/suspended). */
async function seedScheduledCard(
  cookie: string,
  deckId: string,
  opts: { due: Date; state?: 'learning' | 'review' | 'relearning' | 'new'; suspended?: boolean },
): Promise<string> {
  const card = await seedBasicCard(app, cookie, { deckId, front: `q-${Math.random()}`, back: 'a' });
  await db
    .update(cardsTable)
    .set({ due: opts.due, state: opts.state ?? 'review', suspended: opts.suspended ?? false })
    .where(eq(cardsTable.id, card.id));
  return card.id;
}

/** Insert a review row directly (controlled reviewed_at/rating — bypasses FSRS). */
async function seedReview(
  userId: string,
  cardId: string,
  deckId: string,
  rating: number,
  reviewedAt: Date,
): Promise<void> {
  await db.insert(reviews).values({
    userId,
    cardId,
    deckId,
    rating,
    durationMs: 30000,
    reviewedAt,
    nextDue: new Date(reviewedAt.getTime() + DAY_MS),
    nextStability: 1,
    nextDifficulty: 5,
  });
}

interface ForecastBody {
  days: number;
  overdueCount: number;
  total: number;
  buckets: { day: string; count: number }[];
}
interface RetentionBody {
  days: number;
  buckets: { bucket: string; count: number; retentionPct: number | null }[];
}

async function getForecast(cookie: string, query = ''): Promise<ForecastBody> {
  const res = await callApp(app, 'GET', `/stats/forecast${query}`, { cookie });
  expect(res.status).toBe(200);
  return res.json<ForecastBody>();
}
async function getRetention(cookie: string, query = ''): Promise<RetentionBody> {
  const res = await callApp(app, 'GET', `/stats/retention${query}`, { cookie });
  expect(res.status).toBe(200);
  return res.json<RetentionBody>();
}

const bucketByLabel = (body: RetentionBody, label: string) =>
  body.buckets.find((b) => b.bucket === label)!;

describe('GET /stats/forecast', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('401 without a session cookie', async () => {
    const res = await callApp(app, 'GET', '/stats/forecast', {});
    expect(res.status).toBe(401);
  });

  test('clampForecastDays boundaries (unit)', () => {
    expect(clampForecastDays(undefined)).toBe(30);
    expect(clampForecastDays(Number.NaN)).toBe(30);
    expect(clampForecastDays(0)).toBe(1);
    expect(clampForecastDays(-3)).toBe(1);
    expect(clampForecastDays(500)).toBe(90);
    expect(clampForecastDays(14)).toBe(14);
  });

  test('buckets due cards by day; total sums buckets', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    await seedScheduledCard(cookie, deckId, { due: daysFromNow(2) });

    const body = await getForecast(cookie);
    expect(body.days).toBe(30);
    expect(body.total).toBe(4);
    expect(body.overdueCount).toBe(0);
    const counts = body.buckets.map((b) => b.count);
    expect(counts).toEqual([3, 1]);
    // Buckets are sparse (only non-empty days) and oldest-first.
    expect(body.buckets[0]!.day < body.buckets[1]!.day).toBe(true);
  });

  test('overdue backlog is a separate count, not double-counted in buckets', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    await seedScheduledCard(cookie, deckId, { due: daysAgo(2) }); // backlog
    await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });

    const body = await getForecast(cookie);
    expect(body.overdueCount).toBe(1);
    expect(body.total).toBe(1); // only the future card
  });

  test('card due earlier TODAY lands in the today bucket, not the backlog', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    // Start of today (UTC) — still >= date_trunc('day', now()).
    const startOfTodayUtc = new Date(new Date().setUTCHours(0, 0, 0, 0));
    await seedScheduledCard(cookie, deckId, { due: startOfTodayUtc });

    const body = await getForecast(cookie);
    expect(body.overdueCount).toBe(0);
    expect(body.total).toBe(1);
    expect(body.buckets[0]!.day).toBe(startOfTodayUtc.toISOString().slice(0, 10));
  });

  test('suspended and new cards are excluded', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    await seedScheduledCard(cookie, deckId, { due: daysFromNow(1), suspended: true });
    await seedScheduledCard(cookie, deckId, { due: daysFromNow(1), state: 'new' });
    await seedScheduledCard(cookie, deckId, { due: daysAgo(1), suspended: true });

    const body = await getForecast(cookie);
    expect(body.total).toBe(0);
    expect(body.overdueCount).toBe(0);
  });

  test('cards beyond the horizon are excluded', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    await seedScheduledCard(cookie, deckId, { due: daysFromNow(3) });
    await seedScheduledCard(cookie, deckId, { due: daysFromNow(40) }); // beyond days=7

    const body = await getForecast(cookie, '?days=7');
    expect(body.days).toBe(7);
    expect(body.total).toBe(1);
  });

  test('deckId scopes to the subtree (parent + child), excluding other decks', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const parent = await freshDeck(cookie, 'Parent');
    const child = await freshDeck(cookie, 'Child', parent);
    const other = await freshDeck(cookie, 'Other');
    await seedScheduledCard(cookie, parent, { due: daysFromNow(1) });
    await seedScheduledCard(cookie, child, { due: daysFromNow(1) });
    await seedScheduledCard(cookie, other, { due: daysFromNow(1) });

    const body = await getForecast(cookie, `?deckId=${parent}`);
    expect(body.total).toBe(2);
  });

  test('foreign/un-owned deckId resolves to an empty scope, not a global fallback', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    await seedScheduledCard(cookie, deckId, { due: daysAgo(1) });

    const body = await getForecast(cookie, '?deckId=00000000-0000-0000-0000-0000000000ff');
    expect(body.total).toBe(0);
    expect(body.overdueCount).toBe(0);
  });

  test('cross-user isolation: user B cards never appear in A forecast', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckA = await freshDeck(a.cookie, 'A');
    const deckB = await freshDeck(b.cookie, 'B');
    await seedScheduledCard(a.cookie, deckA, { due: daysFromNow(1) });
    for (let i = 0; i < 5; i++) await seedScheduledCard(b.cookie, deckB, { due: daysFromNow(1) });

    const body = await getForecast(a.cookie);
    expect(body.total).toBe(1);
  });
});

describe('GET /stats/retention', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('401 without a session cookie', async () => {
    const res = await callApp(app, 'GET', '/stats/retention', {});
    expect(res.status).toBe(401);
  });

  test('returns all interval buckets in order, zero-filled', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const body = await getRetention(cookie);
    expect(body.buckets.map((b) => b.bucket)).toEqual([...RETENTION_BUCKETS]);
    expect(body.buckets.every((b) => b.count === 0 && b.retentionPct === null)).toBe(true);
  });

  test('gaps land in the right interval buckets', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);

    // Card 1: gap of exactly 1 day → '1d'.
    const c1 = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    await seedReview(userId, c1, deckId, 3, daysAgo(10));
    await seedReview(userId, c1, deckId, 3, daysAgo(9));
    // Card 2: gap of 3 days → '2-3d'.
    const c2 = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    await seedReview(userId, c2, deckId, 3, daysAgo(10));
    await seedReview(userId, c2, deckId, 1, daysAgo(7));
    // Card 3: gap of 7 days → '4-7d'.
    const c3 = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    await seedReview(userId, c3, deckId, 3, daysAgo(10));
    await seedReview(userId, c3, deckId, 4, daysAgo(3));
    // Card 4: gap of 100 days → '90d+'.
    const c4 = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    await seedReview(userId, c4, deckId, 3, daysAgo(105));
    await seedReview(userId, c4, deckId, 3, daysAgo(5));

    const body = await getRetention(cookie);
    expect(bucketByLabel(body, '1d').count).toBe(1);
    expect(bucketByLabel(body, '2-3d').count).toBe(1);
    expect(bucketByLabel(body, '4-7d').count).toBe(1);
    expect(bucketByLabel(body, '90d+').count).toBe(1);
  });

  test('sub-day gaps (learning steps) land in "<1d", not "1d"', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const c = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    const base = daysAgo(1);
    await seedReview(userId, c, deckId, 1, base);
    await seedReview(userId, c, deckId, 3, new Date(base.getTime() + 10 * 60000)); // +10 min

    const body = await getRetention(cookie);
    expect(bucketByLabel(body, '<1d').count).toBe(1);
    expect(bucketByLabel(body, '1d').count).toBe(0);
  });

  test('the first review of a card is excluded (no interval)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const c = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    await seedReview(userId, c, deckId, 3, daysAgo(1));

    const body = await getRetention(cookie);
    expect(body.buckets.every((b) => b.count === 0)).toBe(true);
  });

  test('retentionPct = share of rating>=3 within the bucket', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    // Three cards, each with a ~1-day gap; second grades 3, 3, 1 → 67%.
    for (const rating of [3, 3, 1]) {
      const c = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
      await seedReview(userId, c, deckId, 3, daysAgo(2));
      await seedReview(userId, c, deckId, rating, daysAgo(1));
    }

    const body = await getRetention(cookie);
    const b = bucketByLabel(body, '1d');
    expect(b.count).toBe(3);
    expect(b.retentionPct).toBe(67);
  });

  test('a review older than the window still serves as the LAG predecessor', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const c = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    // Predecessor outside the 7-day window; the graded review inside it.
    await seedReview(userId, c, deckId, 3, daysAgo(10));
    await seedReview(userId, c, deckId, 3, daysAgo(3));

    const body = await getRetention(cookie, '?days=7');
    expect(body.days).toBe(7);
    // Gap = 7 days → '4-7d'; the old review itself is NOT counted as a data point.
    expect(bucketByLabel(body, '4-7d').count).toBe(1);
    expect(body.buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
  });

  test('deck subtree scope + foreign deckId → empty', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const parent = await freshDeck(cookie, 'Parent');
    const child = await freshDeck(cookie, 'Child', parent);
    const other = await freshDeck(cookie, 'Other');
    for (const deckId of [parent, child, other]) {
      const c = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
      await seedReview(userId, c, deckId, 3, daysAgo(2));
      await seedReview(userId, c, deckId, 3, daysAgo(1));
    }

    const scoped = await getRetention(cookie, `?deckId=${parent}`);
    expect(bucketByLabel(scoped, '1d').count).toBe(2); // parent + child, not other

    const foreign = await getRetention(cookie, '?deckId=00000000-0000-0000-0000-0000000000ff');
    expect(foreign.buckets.every((b) => b.count === 0)).toBe(true);
  });

  test('cross-user isolation', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckB = await freshDeck(b.cookie, 'B');
    const c = await seedScheduledCard(b.cookie, deckB, { due: daysFromNow(1) });
    await seedReview(b.userId, c, deckB, 3, daysAgo(2));
    await seedReview(b.userId, c, deckB, 3, daysAgo(1));

    const body = await getRetention(a.cookie);
    expect(body.buckets.every((bk) => bk.count === 0)).toBe(true);
  });
});
