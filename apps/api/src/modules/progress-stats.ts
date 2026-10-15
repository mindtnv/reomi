// Progress aggregation helpers for the agent's READ progress-tools (S4 / AC1.1,
// AC1.2, AC1.5). User-scoped — every query carries `user_id` as the MANDATORY
// FIRST conjunct (Principle 4), the only cross-user boundary on these reads.
//
// `studyStats` is the only genuinely new server capability in this milestone: a
// single GROUP BY `date_trunc('day', reviewed_at)` over `reviews`, plus (for the
// global scope) a `profile` read for streak/level/xp. `cardProgress` reads the
// card's flat FSRS columns + its last-N review history (scoped by BOTH cardId AND
// userId — defense-in-depth even though the card is loaded user-scoped, M4).
//
// Neither helper throws for an empty history: an account with no reviews returns
// `reviewCount:0` + `retentionPct:null` (the "no reviews yet" render case), and a
// foreign/missing card returns `null`. The tool wrappers in ai/tools.ts turn
// these into graceful `ToolResult`s (never an error into the loop, Principle 5).

import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { cards, db, profile as profileTable, reviews } from '@reomi/db';

/** Clamp the heatmap/aggregation window. undefined → 30; <1 → 1; >365 → 365. */
export function clampDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return 30;
  const floored = Math.floor(days);
  return Math.max(1, Math.min(floored, 365));
}

export interface StudyStatsArgs {
  userId: string;
  scope: 'global' | 'deck';
  /** Resolved deck subtree (deck + descendants). Empty/undefined ⇒ no deck filter. */
  deckIds?: string[];
  days?: number;
}

export interface StudyStatsResult {
  reviewCount: number;
  /** % of reviews graded >= 3 (Hard counts as a lapse-avoiding "remembered"). NULL when no reviews. */
  retentionPct: number | null;
  studyMinutes: number;
  days: number;
  /** Day-bucketed counts (date_trunc('day', reviewed_at)::date), oldest-first. */
  heatmap: { day: string; count: number }[];
  /** Global scope only — the user's gamification snapshot. */
  profile?: { streakDays: number; level: number; xp: number } | null;
}

interface HeatmapRow {
  day: Date | string;
  cnt: number | string;
  remembered: number | string;
  duration: number | string | null;
}

/**
 * User-scoped study aggregates over the last `days` (default 30, clamped 1..365).
 * ONE GROUP BY query. For `scope:'deck'` an empty `deckIds` resolves to a scope
 * that matches no rows (an un-owned/foreign deck yields no reviews — NOT a global
 * fallback). For `scope:'global'` also reads the profile streak/level/xp.
 */
export async function studyStats(args: StudyStatsArgs): Promise<StudyStatsResult> {
  const userId = args.userId;
  const days = clampDays(args.days);
  const deckScoped = args.scope === 'deck';

  // user_id is the mandatory FIRST conjunct; the window + (optional) deck filter
  // are ADDITIONAL predicates. For a deck scope with no resolved ids, force an
  // empty result set (`reviews.deck_id IN (NULL)` is never true) so a foreign
  // deck returns "no reviews" rather than silently going global.
  const conds = [
    sql`user_id = ${userId}`,
    sql`reviewed_at >= now() - ${`${days} days`}::interval`,
  ];
  if (deckScoped) {
    const ids = args.deckIds ?? [];
    if (ids.length === 0) {
      conds.push(sql`false`);
    } else {
      const list = sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      );
      conds.push(sql`deck_id IN (${list})`);
    }
  }
  const where = sql.join(conds, sql` AND `);

  const rows = (await db.execute(sql`
    SELECT
      date_trunc('day', reviewed_at)::date AS day,
      count(*)                              AS cnt,
      sum(CASE WHEN rating >= 3 THEN 1 ELSE 0 END) AS remembered,
      sum(duration_ms)                      AS duration
    FROM reviews
    WHERE ${where}
    GROUP BY 1
    ORDER BY 1
  `)) as unknown as HeatmapRow[];

  let reviewCount = 0;
  let remembered = 0;
  let durationMs = 0;
  const heatmap: { day: string; count: number }[] = [];
  for (const r of rows) {
    const cnt = Number(r.cnt);
    reviewCount += cnt;
    remembered += Number(r.remembered);
    durationMs += Number(r.duration ?? 0);
    // `day` comes back as a Date (timestamptz cast) or an ISO string depending on
    // the driver — normalize to a yyyy-mm-dd string.
    const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
    heatmap.push({ day, count: cnt });
  }

  const retentionPct =
    reviewCount > 0 ? Math.round((remembered / reviewCount) * 100) : null;
  const studyMinutes = Math.round(durationMs / 60000);

  let profile: StudyStatsResult['profile'] = undefined;
  if (!deckScoped) {
    const [p] = await db
      .select({
        streakDays: profileTable.streakDays,
        level: profileTable.level,
        xp: profileTable.xp,
      })
      .from(profileTable)
      .where(eq(profileTable.userId, userId))
      .limit(1);
    profile = p ?? null;
  }

  return { reviewCount, retentionPct, studyMinutes, days, heatmap, profile };
}

/** Clamp the forward-looking forecast window. undefined → 30; <1 → 1; >90 → 90. */
export function clampForecastDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return 30;
  const floored = Math.floor(days);
  return Math.max(1, Math.min(floored, 90));
}

export interface DueForecastArgs {
  userId: string;
  /** Resolved deck subtree (deck + descendants). Empty array ⇒ empty scope. */
  deckIds?: string[];
  days?: number;
}

export interface DueForecastResult {
  days: number;
  /** Cards already overdue BEFORE the start of today (UTC) — the backlog. */
  overdueCount: number;
  /** Sum of all bucket counts (today .. today+days). */
  total: number;
  /** Day-bucketed due counts, sparse (only non-empty days), oldest-first. */
  buckets: { day: string; count: number }[];
}

interface ForecastRow {
  day: Date | string;
  cnt: number | string;
}

/** Shared deck-scope predicate: deckIds=[] forces an empty result set. */
function deckScopeConds(deckIds: string[] | undefined): SQL[] {
  if (deckIds === undefined) return [];
  if (deckIds.length === 0) return [sql`false`];
  const list = sql.join(
    deckIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return [sql`deck_id IN (${list})`];
}

/**
 * Forward-looking review workload: how many cards come due on each of the next
 * `days` days (clamped 1..90), plus the overdue backlog as a SEPARATE count
 * (due before the start of today — disjoint from the buckets, so "today"
 * includes anything that came due earlier today). Excludes suspended cards and
 * `state='new'` (a new card's `due` is a fictitious defaultNow() — the queue
 * introduces new cards by createdAt with a daily cap, see cards.ts).
 */
export async function dueForecast(args: DueForecastArgs): Promise<DueForecastResult> {
  const userId = args.userId;
  const days = clampForecastDays(args.days);

  const base = [
    sql`user_id = ${userId}`,
    sql`suspended = false`,
    sql`state <> 'new'`,
    ...deckScopeConds(args.deckIds),
  ];
  const bucketWhere = sql.join(
    [
      ...base,
      sql`due >= date_trunc('day', now())`,
      sql`due < date_trunc('day', now()) + ${`${days} days`}::interval`,
    ],
    sql` AND `,
  );
  const overdueWhere = sql.join([...base, sql`due < date_trunc('day', now())`], sql` AND `);

  const rows = (await db.execute(sql`
    SELECT date_trunc('day', due)::date AS day, count(*) AS cnt
    FROM cards
    WHERE ${bucketWhere}
    GROUP BY 1
    ORDER BY 1
  `)) as unknown as ForecastRow[];

  const overdueRows = (await db.execute(sql`
    SELECT count(*) AS cnt FROM cards WHERE ${overdueWhere}
  `)) as unknown as { cnt: number | string }[];

  let total = 0;
  const buckets: { day: string; count: number }[] = [];
  for (const r of rows) {
    const count = Number(r.cnt);
    total += count;
    const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
    buckets.push({ day, count });
  }

  return { days, overdueCount: Number(overdueRows[0]?.cnt ?? 0), total, buckets };
}

export interface RetentionCurveArgs {
  userId: string;
  /** Resolved deck subtree. Empty array ⇒ empty scope. */
  deckIds?: string[];
  /** Window over reviewed_at (clamped 1..365, default 365). */
  days?: number;
}

/** Interval-bucket labels, index-aligned with the SQL CASE below. */
export const RETENTION_BUCKETS = [
  '<1d',
  '1d',
  '2-3d',
  '4-7d',
  '8-15d',
  '16-30d',
  '31-90d',
  '90d+',
] as const;

export interface RetentionBucket {
  bucket: (typeof RETENTION_BUCKETS)[number];
  count: number;
  /** % of reviews in this bucket graded >= 3. NULL when count is 0. */
  retentionPct: number | null;
}

interface RetentionRow {
  bucket: number | string;
  cnt: number | string;
  remembered: number | string;
}

/**
 * TRUE retention as a function of the interval since the PREVIOUS review of the
 * same card: a LAG window over `reviews` partitioned by card_id. The first
 * review of a card (gap IS NULL) is excluded — it has no interval. The `<1d`
 * bucket isolates learning/relearning steps honestly (cheaper and more robust
 * than parsing undo_snapshot jsonb per row). IMPORTANT: the time window filters
 * OUTSIDE the windowed CTE — filtering inside would make LAG lose the previous
 * review and mis-compute gaps at the window edge.
 */
export async function retentionCurve(
  args: RetentionCurveArgs,
): Promise<{ days: number; buckets: RetentionBucket[] }> {
  const userId = args.userId;
  const days = clampDays(args.days ?? 365);

  const innerWhere = sql.join(
    [sql`user_id = ${userId}`, ...deckScopeConds(args.deckIds)],
    sql` AND `,
  );

  const rows = (await db.execute(sql`
    WITH seq AS (
      SELECT rating, reviewed_at,
             reviewed_at - LAG(reviewed_at) OVER (PARTITION BY card_id ORDER BY reviewed_at) AS gap
      FROM reviews
      WHERE ${innerWhere}
    )
    SELECT CASE
        WHEN gap < interval '1 day'   THEN 0
        WHEN gap < interval '2 days'  THEN 1
        WHEN gap < interval '4 days'  THEN 2
        WHEN gap < interval '8 days'  THEN 3
        WHEN gap < interval '16 days' THEN 4
        WHEN gap < interval '31 days' THEN 5
        WHEN gap < interval '91 days' THEN 6
        ELSE 7
      END AS bucket,
      count(*) AS cnt,
      sum(CASE WHEN rating >= 3 THEN 1 ELSE 0 END) AS remembered
    FROM seq
    WHERE gap IS NOT NULL
      AND reviewed_at >= now() - ${`${days} days`}::interval
    GROUP BY 1
    ORDER BY 1
  `)) as unknown as RetentionRow[];

  const byIndex = new Map<number, { count: number; remembered: number }>();
  for (const r of rows) {
    byIndex.set(Number(r.bucket), { count: Number(r.cnt), remembered: Number(r.remembered) });
  }
  const buckets: RetentionBucket[] = RETENTION_BUCKETS.map((label, i) => {
    const row = byIndex.get(i);
    const count = row?.count ?? 0;
    return {
      bucket: label,
      count,
      retentionPct: count > 0 ? Math.round(((row?.remembered ?? 0) / count) * 100) : null,
    };
  });

  return { days, buckets };
}

export interface CardProgressResult {
  cardId: string;
  state: string;
  reps: number;
  lapses: number;
  due: string; // ISO
  stability: number;
  difficulty: number;
  lastReview: string | null; // ISO | null
  suspended: boolean;
  recent: { rating: number; reviewedAt: string }[];
}

/**
 * Load a card's FSRS scheduling state + its last-`n` reviews — both user-scoped.
 * The card is loaded `and(eq(id), eq(userId))`; the reviews read is scoped by
 * BOTH cardId AND userId (P4 / M4 — `user_id` is mandatory on EVERY new query,
 * defense-in-depth even though the card is already owned). Returns `null` for a
 * foreign/missing card (the tool turns that into a graceful result, not a throw).
 */
export async function cardProgress(
  userId: string,
  cardId: string,
  n = 10,
): Promise<CardProgressResult | null> {
  const [card] = await db
    .select({
      id: cards.id,
      state: cards.state,
      reps: cards.reps,
      lapses: cards.lapses,
      due: cards.due,
      stability: cards.stability,
      difficulty: cards.difficulty,
      lastReview: cards.lastReview,
      suspended: cards.suspended,
    })
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
    .limit(1);
  if (!card) return null;

  const recentRows = await db
    .select({ rating: reviews.rating, reviewedAt: reviews.reviewedAt })
    .from(reviews)
    .where(and(eq(reviews.cardId, cardId), eq(reviews.userId, userId)))
    .orderBy(desc(reviews.reviewedAt))
    .limit(n);

  return {
    cardId: card.id,
    state: card.state,
    reps: card.reps,
    lapses: card.lapses,
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    lastReview: card.lastReview ? card.lastReview.toISOString() : null,
    suspended: card.suspended,
    recent: recentRows.map((r) => ({ rating: r.rating, reviewedAt: r.reviewedAt.toISOString() })),
  };
}
