// /stats module integration tests: the due forecast + interval retention curve.
//
// Cards are seeded via the real API (seedBasicCard) and then their FSRS columns
// (due/state/suspended) are set DIRECTLY via db.update — the POST /reviews path
// applies FSRS and only ever grades "now", which can't produce controlled due
// dates. Reviews are likewise inserted directly with controlled reviewed_at
// (same approach as progress-tools.test.ts).

import { beforeEach, describe, expect, test } from 'bun:test';
import { cards as cardsTable, db, deckOptionsPreset, decks as decksTable, notes, reviews } from '@reomi/db';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';
import {
  clampForecastDays,
  dueForecast,
  RETENTION_BUCKETS,
  studyOverview,
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

  test('same UTC day collapses; a cross-midnight gap under 24h is "<1d"', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const sameDay = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    const noon = daysAgo(3);
    noon.setUTCHours(12, 0, 0, 0);
    await seedReview(userId, sameDay, deckId, 1, noon);
    await seedReview(userId, sameDay, deckId, 3, new Date(noon.getTime() + 10 * 60000));

    const crossed = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    const late = daysAgo(2);
    late.setUTCHours(23, 30, 0, 0);
    await seedReview(userId, crossed, deckId, 3, late);
    await seedReview(userId, crossed, deckId, 3, new Date(late.getTime() + 60 * 60000));

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

  test('retentionPct counts Hard as success within the bucket', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    // Three cards, each with a ~1-day gap; second grades 2, 1, 1 → 33%.
    for (const rating of [2, 1, 1]) {
      const c = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
      await seedReview(userId, c, deckId, 3, daysAgo(2));
      await seedReview(userId, c, deckId, rating, daysAgo(1));
    }

    const body = await getRetention(cookie);
    const b = bucketByLabel(body, '1d');
    expect(b.count).toBe(3);
    expect(b.retentionPct).toBe(33);
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

interface OverviewBody {
  answerCount: number;
  answerSuccessCount: number;
  answerSuccessPct: number | null;
  trueRetentionCount: number;
  trueRetentionPct: number | null;
  series: { day: string; answerCount: number; answerSuccessPct: number | null; trueRetentionPct: number | null }[];
  target: { status: 'uniform' | 'mixed'; retentionPct: number | null };
  undoSnapshot?: unknown;
}
interface DeckBreakdownBody {
  decks: {
    id: string;
    ownCards: number;
    subtreeCards: number;
    ownAnswerCount: number;
    ownAnswerSuccessPct: number | null;
    subtreeAnswerCount: number;
    targetRetentionPct: number;
  }[];
}

async function getOverview(cookie: string, query = ''): Promise<OverviewBody> {
  const res = await callApp(app, 'GET', `/stats/overview${query}`, { cookie });
  expect(res.status).toBe(200);
  return res.json<OverviewBody>();
}

describe('GET /stats/overview and /stats/decks', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('one of each rating is 75% answer success, and a same-day repeat is not true retention', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    for (const rating of [1, 2, 3, 4]) {
      const cardId = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
      await seedReview(userId, cardId, deckId, rating, new Date());
    }
    const repeated = await seedScheduledCard(cookie, deckId, { due: daysFromNow(1) });
    const first = daysAgo(1);
    first.setUTCHours(12, 0, 0, 0);
    await seedReview(userId, repeated, deckId, 1, first);
    await seedReview(userId, repeated, deckId, 3, new Date(first.getTime() + 60_000));

    const body = await getOverview(cookie, '?days=7');
    expect(JSON.stringify(body)).not.toContain('undoSnapshot');
    const today = body.series.find((point) => point.answerCount === 4)!;
    expect(today.answerSuccessPct).toBe(75);
    const earlier = body.series.find((point) => point.day === first.toISOString().slice(0, 10))!;
    expect(earlier.answerCount).toBe(2);
    expect(earlier.answerSuccessPct).toBe(50);
    expect(earlier.trueRetentionPct).toBe(0);
    expect(body.series.filter((point) => point.answerCount === 0).every((point) => point.answerSuccessPct === null && point.trueRetentionPct === null)).toBe(true);
    expect(body.answerSuccessPct).toBe(67);
  });

  test('UTC buckets stay on the UTC day under New York and Auckland', async () => {
    const { userId, cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const earlyCard = await seedScheduledCard(cookie, deckId, { due: daysFromNow(2) });
    const lateCard = await seedScheduledCard(cookie, deckId, { due: daysFromNow(2) });
    const early = daysAgo(2);
    early.setUTCHours(0, 30, 0, 0);
    const late = daysAgo(2);
    late.setUTCHours(23, 30, 0, 0);
    await seedReview(userId, earlyCard, deckId, 3, early);
    await seedReview(userId, lateCard, deckId, 3, late);
    const due = daysFromNow(1);
    due.setUTCHours(0, 30, 0, 0);
    await seedScheduledCard(cookie, deckId, { due });
    const utcDay = early.toISOString().slice(0, 10);
    const nextDay = new Date(early.getTime() + 86_400_000).toISOString().slice(0, 10);
    const dueDay = due.toISOString().slice(0, 10);

    for (const zone of ['America/New_York', 'Pacific/Auckland']) {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL TIME ZONE '${zone}'`));
        const overview = await studyOverview({ userId, days: 7 }, tx);
        expect(overview.series.find((point) => point.day === utcDay)?.answerCount).toBe(2);
        expect(overview.series.find((point) => point.day === nextDay)?.answerCount ?? 0).toBe(0);
        const forecast = await dueForecast({ userId, days: 7 }, tx);
        expect(forecast.buckets.find((bucket) => bucket.day === dueDay)?.count).toBe(1);
        const dates = (await tx.execute(sql`
          SELECT (timestamptz '2026-03-08 04:30:00+00' AT TIME ZONE 'UTC')::date AS spring,
                 (timestamptz '2026-01-15 14:30:00+00' AT TIME ZONE 'UTC')::date AS winter
        `)) as unknown as { spring: Date | string; winter: Date | string }[];
        const spring = dates[0]!.spring instanceof Date ? dates[0]!.spring.toISOString().slice(0, 10) : String(dates[0]!.spring).slice(0, 10);
        const winter = dates[0]!.winter instanceof Date ? dates[0]!.winter.toISOString().slice(0, 10) : String(dates[0]!.winter).slice(0, 10);
        expect(spring).toBe('2026-03-08');
        expect(winter).toBe('2026-01-15');
      });
    }
  });

  test('deck breakdown counts the full collection, and targets follow effective retention', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const parent = await freshDeck(cookie, 'Parent');
    const child = await freshDeck(cookie, 'Child', parent);
    const other = await freshDeck(cookie, 'Other');
    const unused = await freshDeck(cookie, 'Unused');
    const seeded = await seedBasicCard(app, cookie, { deckId: parent, front: 'q', back: 'a' });
    const [note] = await db.select({ noteTypeId: notes.noteTypeId }).from(notes).where(eq(notes.userId, userId)).limit(1);
    await db.execute(sql`
      WITH inserted AS (
        INSERT INTO notes (user_id, note_type_id, field_values)
        SELECT ${userId}, ${note!.noteTypeId}::uuid, '{"Front":"q","Back":"a"}'::jsonb
        FROM generate_series(1, 100)
        RETURNING id
      )
      INSERT INTO cards (user_id, deck_id, note_id)
      SELECT ${userId}, ${parent}::uuid, id FROM inserted
    `);
    await db.execute(sql`
      WITH inserted AS (
        INSERT INTO notes (user_id, note_type_id, field_values)
        SELECT ${userId}, ${note!.noteTypeId}::uuid, '{"Front":"q","Back":"a"}'::jsonb
        FROM generate_series(1, 400)
        RETURNING id
      )
      INSERT INTO cards (user_id, deck_id, note_id)
      SELECT ${userId}, ${child}::uuid, id FROM inserted
    `);
    await db.update(cardsTable).set({ suspended: true }).where(eq(cardsTable.id, seeded.id));
    const otherCard = await seedScheduledCard(cookie, other, { due: daysFromNow(1) });
    await seedReview(userId, seeded.id, parent, 1, new Date());
    await seedReview(userId, otherCard, other, 2, new Date());

    const [parentPreset] = await db.insert(deckOptionsPreset).values({ userId, name: 'parent', desiredRetention: 0.8 }).returning({ id: deckOptionsPreset.id });
    const [otherPreset] = await db.insert(deckOptionsPreset).values({ userId, name: 'other', desiredRetention: 0.95 }).returning({ id: deckOptionsPreset.id });
    const [unusedPreset] = await db.insert(deckOptionsPreset).values({ userId, name: 'unused', desiredRetention: 0.5 }).returning({ id: deckOptionsPreset.id });
    await db.update(decksTable).set({ presetId: parentPreset!.id }).where(eq(decksTable.id, parent));
    await db.update(decksTable).set({ presetId: otherPreset!.id }).where(eq(decksTable.id, other));
    await db.update(decksTable).set({ presetId: unusedPreset!.id }).where(eq(decksTable.id, unused));

    const breakdown = await (await callApp(app, 'GET', '/stats/decks?days=30', { cookie })).json<DeckBreakdownBody>();
    const byId = new Map(breakdown.decks.map((deck) => [deck.id, deck]));
    const parentRow = byId.get(parent)!;
    const childRow = byId.get(child)!;
    const otherRow = byId.get(other)!;
    const unusedRow = byId.get(unused)!;
    expect(parentRow.ownCards + childRow.ownCards + otherRow.ownCards + unusedRow.ownCards).toBe(502);
    expect(parentRow.ownCards).toBe(101);
    expect(childRow.ownCards).toBe(400);
    expect(parentRow.subtreeCards).toBe(501);
    expect(childRow.subtreeCards).toBe(400);
    expect(parentRow.subtreeCards + childRow.subtreeCards).toBeGreaterThan(501);
    expect(unusedRow.ownCards).toBe(0);
    expect(unusedRow.ownAnswerSuccessPct).toBeNull();
    expect(parentRow.ownAnswerSuccessPct).toBe(0);
    expect(otherRow.ownAnswerSuccessPct).toBe(100);
    expect(parentRow.ownAnswerCount + otherRow.ownAnswerCount).toBe(2);
    expect(parentRow.targetRetentionPct).toBe(80);
    expect(childRow.targetRetentionPct).toBe(80);
    expect(otherRow.targetRetentionPct).toBe(95);

    const mixed = await getOverview(cookie);
    expect(mixed.target).toEqual({ status: 'mixed', retentionPct: null });
    const scoped = await getOverview(cookie, `?deckId=${parent}`);
    expect(scoped.target).toEqual({ status: 'uniform', retentionPct: 80 });
    expect(scoped.answerCount).toBe(1);
    const foreign = await getOverview(cookie, '?deckId=00000000-0000-0000-0000-0000000000ff');
    expect(foreign.answerCount).toBe(0);
    expect(foreign.target).toEqual({ status: 'uniform', retentionPct: null });
  });
});
