import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { cards, db, reviews } from '@reomi/db';
import { percentOf, studySpans } from '@reomi/shared';
import { excludeActiveHolds } from './card-holds.ts';
import { resolveDeckConfig, type DeckConfigSnapshot } from './deck-config.ts';
import { ledgerForRead, loadStudyClock } from './study-day.ts';

/** Raw-SQL executor. A transaction can be passed so tests can `SET LOCAL TIME ZONE`. */
export interface StatsExecutor {
  execute(query: SQL): Promise<unknown>;
}

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
  /** Share of every answer rated Hard, Good or Easy. Null when there are no answers. */
  answerSuccessPct: number | null;
  answerSuccessCount: number;
  /** Alias of `answerSuccessPct` for existing readers. This is not true retention. */
  retentionPct: number | null;
  /** First review of each card in each study epoch. Repeated answers in that epoch do not count. */
  trueRetentionCount: number;
  trueRetentionSuccessCount: number;
  trueRetentionPct: number | null;
  studyMinutes: number;
  days: number;
  /** Non-empty study-day labels. A missing stamp falls back to the UTC date of reviewed_at. */
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
export async function studyStats(args: StudyStatsArgs, executor: StatsExecutor = db): Promise<StudyStatsResult> {
  const userId = args.userId;
  const days = clampDays(args.days);
  const deckScoped = args.scope === 'deck';

  // user_id is the mandatory FIRST conjunct; the window + (optional) deck filter
  // are ADDITIONAL predicates. For a deck scope with no resolved ids, force an
  // empty result set (`reviews.deck_id IN (NULL)` is never true) so a foreign
  // deck returns "no reviews" rather than silently going global.
  const conds = [
    sql`user_id = ${userId}`,
    reviewedRange(rollingLower(days), rollingUpper()),
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

  const rows = (await executor.execute(sql`
    SELECT
      coalesce(study_day, to_char((reviewed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')) AS day,
      count(*)                              AS cnt,
      sum(CASE WHEN rating >= 2 THEN 1 ELSE 0 END) AS remembered,
      sum(duration_ms)                      AS duration
    FROM reviews
    WHERE ${where}
    GROUP BY 1
    ORDER BY 1
  `)) as unknown as HeatmapRow[];
  const trueRows = (await executor.execute(sql`
    WITH ranked AS (
      SELECT rating, reviewed_at,
             row_number() OVER (
               PARTITION BY card_id, coalesce(study_epoch_start, (date_trunc('day', reviewed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
               ORDER BY reviewed_at, id
             ) AS rn
      FROM reviews
      WHERE ${scopeWhere(userId, deckScoped, args.deckIds)}
        AND ${reviewedRange(rollingDayFloor(days), rollingUpper())}
    )
    SELECT count(*) AS cnt,
           sum(CASE WHEN rating >= 2 THEN 1 ELSE 0 END) AS remembered
    FROM ranked
    WHERE rn = 1
      AND ${reviewedRange(rollingLower(days), rollingUpper())}
  `)) as unknown as { cnt: number | string; remembered: number | string }[];

  let reviewCount = 0;
  let remembered = 0;
  let durationMs = 0;
  const heatmap: { day: string; count: number }[] = [];
  for (const r of rows) {
    const cnt = Number(r.cnt);
    reviewCount += cnt;
    remembered += Number(r.remembered);
    durationMs += Number(r.duration ?? 0);
    const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
    heatmap.push({ day, count: cnt });
  }

  const answerSuccessPct = percentOf(remembered, reviewCount);
  const trueRetentionCount = Number(trueRows[0]?.cnt ?? 0);
  const trueRetentionSuccessCount = Number(trueRows[0]?.remembered ?? 0);
  const studyMinutes = Math.round(durationMs / 60000);

  let profile: StudyStatsResult['profile'] = undefined;
  if (!deckScoped) {
    const profileRows = (await executor.execute(sql`
      SELECT streak_days AS "streakDays", level, xp
      FROM profile
      WHERE user_id = ${userId}
      LIMIT 1
    `)) as unknown as { streakDays: number; level: number; xp: number }[];
    profile = profileRows[0] ?? null;
  }

  return {
    reviewCount,
    answerSuccessPct,
    answerSuccessCount: remembered,
    retentionPct: answerSuccessPct,
    trueRetentionCount,
    trueRetentionSuccessCount,
    trueRetentionPct: percentOf(trueRetentionSuccessCount, trueRetentionCount),
    studyMinutes,
    days,
    heatmap,
    profile,
  };
}

/** Ownership and optional deck filter, without the rolling time window. */
function scopeWhere(userId: string, deckScoped: boolean, deckIds: string[] | undefined): SQL {
  const conds = [sql`user_id = ${userId}`];
  if (deckScoped) {
    const ids = deckIds ?? [];
    if (ids.length === 0) conds.push(sql`false`);
    else {
      const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
      conds.push(sql`deck_id IN (${list})`);
    }
  }
  return sql.join(conds, sql` AND `);
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
  /** Cards already due before the open study day's start. */
  overdueCount: number;
  /** Sum of all bucket counts (today .. today+days). */
  total: number;
  /** Day-bucketed due counts, sparse (only non-empty days), oldest-first. */
  buckets: { day: string; count: number }[];
  /** Study-day labels from today through the forecast window, oldest-first. */
  labels: string[];
}

interface ForecastRow {
  day: Date | string;
  cnt: number | string;
}

/** Deck predicate. An empty id list matches nothing; undefined leaves the column open. */
function deckSql(deckIds: string[] | undefined, column: SQL): SQL {
  if (deckIds === undefined) return sql`true`;
  if (deckIds.length === 0) return sql`false`;
  const list = sql.join(
    deckIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`${column} IN (${list})`;
}

/** Shared deck-scope predicate: deckIds=[] forces an empty result set. */
function deckScopeConds(deckIds: string[] | undefined): SQL[] {
  if (deckIds === undefined) return [];
  return [deckSql(deckIds, sql`deck_id`)];
}

async function studyCalendar(
  userId: string,
  pastDays: number,
  futureDays: number,
  executor: StatsExecutor,
) {
  const clock = await loadStudyClock(userId, executor);
  return {
    ...studySpans({
      now: clock.now,
      policy: clock.policy,
      ledger: ledgerForRead(clock.ledger),
      pastDays,
      futureDays,
    }),
    now: clock.now,
  };
}

/**
 * Forward-looking review workload: how many cards come due on each of the next
 * `days` study days (clamped 1..90), plus the overdue backlog due before the
 * open day's start. Excludes suspended cards and `state='new'`.
 */
export async function dueForecast(args: DueForecastArgs, executor: StatsExecutor = db): Promise<DueForecastResult> {
  const userId = args.userId;
  const days = clampForecastDays(args.days);
  const calendar = await studyCalendar(userId, 0, days - 1, executor);
  const spans = [calendar.today, ...calendar.future];
  const spanRows = sql.join(
    spans.map((span) => sql`(${span.label}::text, ${span.start.toISOString()}::timestamptz, ${span.end.toISOString()}::timestamptz)`),
    sql`, `,
  );
  const deck = deckSql(args.deckIds, sql`c.deck_id`);
  const rows = (await executor.execute(sql`
    SELECT s.label AS day, count(c.id) AS cnt
    FROM (VALUES ${spanRows}) AS s(label, start_at, end_at)
    LEFT JOIN cards c
      ON c.user_id = ${userId}
     AND c.suspended = false
     AND c.state <> 'new'
     AND c.due >= s.start_at
     AND c.due < s.end_at
     AND ${excludeActiveHolds(sql`c.id`, sql`s.start_at`)}
     AND ${deck}
    GROUP BY s.label, s.start_at
    ORDER BY s.start_at
  `)) as unknown as ForecastRow[];
  const overdueRows = (await executor.execute(sql`
    SELECT count(*) AS cnt
    FROM cards
    WHERE user_id = ${userId}
      AND suspended = false
      AND state <> 'new'
      AND due < ${calendar.today.start.toISOString()}::timestamptz
      AND ${excludeActiveHolds(sql`id`, calendar.now)}
      AND ${deckSql(args.deckIds, sql`deck_id`)}
  `)) as unknown as { cnt: number | string }[];

  let total = 0;
  const buckets: { day: string; count: number }[] = [];
  for (const r of rows) {
    const count = Number(r.cnt);
    if (count <= 0) continue;
    total += count;
    const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
    buckets.push({ day, count });
  }

  return {
    days,
    overdueCount: Number(overdueRows[0]?.cnt ?? 0),
    total,
    buckets,
    labels: spans.map((span) => span.label),
  };
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
  /** Share of first-of-day reviews in this bucket rated Hard or better. Null when count is 0. */
  retentionPct: number | null;
}

interface RetentionRow {
  bucket: number | string;
  cnt: number | string;
  remembered: number | string;
}

/**
 * True retention by the elapsed gap since the previous counted review of the
 * same card. Only the first review of each card in each study epoch is counted.
 * A missing stamp uses UTC midnight. The first counted review of a card is excluded.
 */
export async function retentionCurve(
  args: RetentionCurveArgs,
  executor: StatsExecutor = db,
): Promise<{ days: number; buckets: RetentionBucket[] }> {
  const userId = args.userId;
  const days = clampDays(args.days ?? 365);

  const innerWhere = sql.join(
    [sql`user_id = ${userId}`, ...deckScopeConds(args.deckIds)],
    sql` AND `,
  );

  const epochStart = sql`coalesce(f.study_epoch_start, (date_trunc('day', f.reviewed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))`;
  const rows = (await executor.execute(sql`
    WITH ranked AS (
      SELECT card_id, rating, reviewed_at, id, study_epoch_start,
             row_number() OVER (
               PARTITION BY card_id, coalesce(study_epoch_start, (date_trunc('day', reviewed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
               ORDER BY reviewed_at, id
             ) AS rn
      FROM reviews
      WHERE ${innerWhere}
        AND ${reviewedRange(rollingDayFloor(days), rollingUpper())}
    ),
    firsts AS (
      SELECT card_id, rating, reviewed_at, id, study_epoch_start
      FROM ranked
      WHERE rn = 1
        AND ${reviewedRange(rollingLower(days), rollingUpper())}
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
      sum(CASE WHEN rating >= 2 THEN 1 ELSE 0 END) AS remembered
    FROM (
      SELECT f.rating,
             f.reviewed_at - prev.reviewed_at AS gap
      FROM firsts f
      LEFT JOIN LATERAL (
        SELECT p.reviewed_at
        FROM reviews p
        WHERE p.user_id = ${userId}
          AND p.card_id = f.card_id
          AND p.reviewed_at < ${epochStart}
          AND p.reviewed_at >= coalesce(
            (
              SELECT max(older.study_epoch_start)
              FROM reviews older
              WHERE older.user_id = ${userId}
                AND older.card_id = f.card_id
                AND older.reviewed_at < ${epochStart}
                AND ${deckSql(args.deckIds, sql`older.deck_id`)}
            ),
            (date_trunc('day', (
              SELECT max(older.reviewed_at)
              FROM reviews older
              WHERE older.user_id = ${userId}
                AND older.card_id = f.card_id
                AND older.reviewed_at < ${epochStart}
                AND ${deckSql(args.deckIds, sql`older.deck_id`)}
            ) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          )
          AND ${deckSql(args.deckIds, sql`p.deck_id`)}
        ORDER BY p.reviewed_at, p.id
        LIMIT 1
      ) prev ON true
    ) seq
    WHERE gap IS NOT NULL
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

export interface LearningSeriesPoint {
  day: string;
  answerCount: number;
  answerSuccessCount: number;
  answerSuccessPct: number | null;
  trueRetentionCount: number;
  trueRetentionSuccessCount: number;
  trueRetentionPct: number | null;
  averageGrade: number | null;
  durationMs: number;
}

export interface LearningOverview {
  days: number;
  answerCount: number;
  answerSuccessCount: number;
  answerSuccessPct: number | null;
  trueRetentionCount: number;
  trueRetentionSuccessCount: number;
  trueRetentionPct: number | null;
  studyMinutes: number;
  averageGrade: number | null;
  grades: { again: number; hard: number; good: number; easy: number };
  /** Exactly `days` study-day labels ending today. Empty days keep null percents. */
  series: LearningSeriesPoint[];
  /** Index is the hour in `hourZone`. Legacy policy uses UTC. */
  hours: { count: number; success: number }[];
  hourZone: string;
  lastReviewedAt: string | null;
  target: { status: 'uniform' | 'mixed'; retentionPct: number | null };
}

export interface DeckLearningRow {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  ownCards: number;
  subtreeCards: number;
  ownAnswerCount: number;
  ownAnswerSuccessCount: number;
  ownAnswerSuccessPct: number | null;
  subtreeAnswerCount: number;
  subtreeAnswerSuccessCount: number;
  subtreeAnswerSuccessPct: number | null;
  ownMinutes: number;
  subtreeMinutes: number;
  targetRetentionPct: number;
}

interface AnswerDayRow {
  day: Date | string;
  cnt: number | string;
  remembered: number | string;
  rating_sum: number | string | null;
  duration: number | string | null;
  again: number | string;
  hard: number | string;
  good: number | string;
  easy: number | string;
}

function utcDayKey(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function rollingLower(days: number): SQL {
  return sql`now() - ${`${days} days`}::interval`;
}

/** A day past `now()` so a host clock slightly ahead of Postgres still counts. */
function rollingUpper(): SQL {
  return sql`now() + interval '1 day'`;
}

/** UTC midnight of the day that contains the rolling window start. */
function rollingDayFloor(days: number): SQL {
  return sql`(date_trunc('day', (${rollingLower(days)}) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
}

/** `reviewed_at` range. The column is not cast, so the user/time index applies. */
function reviewedRange(start: SQL, end: SQL): SQL {
  return sql`reviewed_at >= ${start} AND reviewed_at < ${end}`;
}

const STUDY_STAMP_SLACK_MS = 3 * 24 * 60 * 60 * 1000;

function spanStampWhere(spans: { start: Date; end: Date; label: string }[]): SQL {
  const start = new Date(spans[0]!.start.getTime() - STUDY_STAMP_SLACK_MS);
  const end = spans[spans.length - 1]!.end;
  const labels = sql.join(spans.map((span) => sql`${span.label}`), sql`, `);
  return sql`${reviewedRange(sql`${start.toISOString()}::timestamptz`, sql`${end.toISOString()}::timestamptz`)} AND (
    study_day IN (${labels})
    OR (study_day IS NULL AND to_char((reviewed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') IN (${labels}))
  )`;
}

function averageGrade(sum: number, count: number): number | null {
  if (count <= 0) return null;
  return Math.round((sum / count) * 100) / 100;
}

interface TargetDeckRow {
  id: string;
  parentId: string | null;
  presetId: string | null;
  name: string;
  color: string;
}

function configSnapshot(
  deckRows: TargetDeckRow[],
  presetRows: { id: string; desiredRetention: number | null }[],
  profileRows: { desiredRetention: number | null }[],
): DeckConfigSnapshot {
  return {
    userDecks: deckRows,
    presetsById: new Map(presetRows.map((row) => [row.id, row])),
    profile: profileRows[0] ?? null,
  } as DeckConfigSnapshot;
}

/**
 * Effective retention for the collection or one deck. Decks with no cards do
 * not vote, so an unused preset cannot mark a uniform collection as mixed.
 * `targetDeckId === null` is an unowned scope and reveals no preset.
 */
async function retentionTarget(
  userId: string,
  targetDeckId: string | null | undefined,
  executor: StatsExecutor,
): Promise<LearningOverview['target']> {
  if (targetDeckId === null) return { status: 'uniform', retentionPct: null };
  const deckRows = (await executor.execute(sql`
    SELECT id, parent_id AS "parentId", preset_id AS "presetId", name, color
    FROM decks WHERE user_id = ${userId}
  `)) as unknown as TargetDeckRow[];
  const presetRows = (await executor.execute(sql`
    SELECT id, desired_retention AS "desiredRetention",
           new_per_day AS "newPerDay", reviews_per_day AS "reviewsPerDay",
           learning_steps AS "learningSteps", relearning_steps AS "relearningSteps",
           leech_threshold AS "leechThreshold", maximum_interval AS "maximumInterval"
    FROM deck_options_preset WHERE user_id = ${userId}
  `)) as unknown as { id: string; desiredRetention: number | null }[];
  const profileRows = (await executor.execute(sql`
    SELECT desired_retention AS "desiredRetention" FROM profile WHERE user_id = ${userId} LIMIT 1
  `)) as unknown as { desiredRetention: number | null }[];
  const countRows = (await executor.execute(sql`
    SELECT deck_id AS "deckId", count(*) AS cnt FROM cards WHERE user_id = ${userId} GROUP BY deck_id
  `)) as unknown as { deckId: string; cnt: number | string }[];
  const snapshot = configSnapshot(deckRows, presetRows, profileRows);
  const percentFor = (deckId: string | null) =>
    Math.round(resolveDeckConfig(deckId, snapshot).desiredRetention * 100);
  if (targetDeckId) return { status: 'uniform', retentionPct: percentFor(targetDeckId) };
  const own = new Map(countRows.map((row) => [row.deckId, Number(row.cnt)]));
  const voting = deckRows.filter((deck) => (own.get(deck.id) ?? 0) > 0);
  if (voting.length === 0) return { status: 'uniform', retentionPct: percentFor(null) };
  const percents = voting.map((deck) => percentFor(deck.id));
  const first = percents[0]!;
  return percents.every((value) => value === first)
    ? { status: 'uniform', retentionPct: first }
    : { status: 'mixed', retentionPct: null };
}

export interface StudyOverviewArgs {
  userId: string;
  /** Undefined = whole account. Empty array = empty scope (foreign deck). */
  deckIds?: string[];
  /**
   * Undefined = collection target. A deck id = that deck's effective retention.
   * Null = unowned deck; the target percent stays null.
   */
  targetDeckId?: string | null;
  days?: number;
}

export async function studyOverview(
  args: StudyOverviewArgs,
  executor: StatsExecutor = db,
): Promise<LearningOverview> {
  const days = clampDays(args.days);
  const userId = args.userId;
  const deckScoped = args.deckIds !== undefined;
  const calendar = await studyCalendar(userId, days - 1, 0, executor);
  const spans = [...calendar.past, calendar.today];
  const hourZone = calendar.legacy ? 'UTC' : calendar.zone;
  const where = sql`${scopeWhere(userId, deckScoped, args.deckIds)} AND ${spanStampWhere(spans)}`;
  const answerRows = (await executor.execute(sql`
    SELECT coalesce(study_day, to_char((reviewed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')) AS day,
           count(*) AS cnt,
           sum(CASE WHEN rating >= 2 THEN 1 ELSE 0 END) AS remembered,
           sum(rating) AS rating_sum,
           sum(duration_ms) AS duration,
           sum(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS again,
           sum(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS hard,
           sum(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS good,
           sum(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS easy
    FROM reviews
    WHERE ${where}
    GROUP BY 1
  `)) as unknown as AnswerDayRow[];
  const trueRows = (await executor.execute(sql`
    WITH ranked AS (
      SELECT rating, reviewed_at, study_day, study_epoch_start,
             row_number() OVER (
               PARTITION BY card_id, coalesce(study_epoch_start, (date_trunc('day', reviewed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
               ORDER BY reviewed_at, id
             ) AS rn
      FROM reviews
      WHERE ${where}
    )
    SELECT coalesce(study_day, to_char((reviewed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')) AS day,
           count(*) AS cnt,
           sum(CASE WHEN rating >= 2 THEN 1 ELSE 0 END) AS remembered
    FROM ranked
    WHERE rn = 1
    GROUP BY 1
  `)) as unknown as { day: Date | string; cnt: number | string; remembered: number | string }[];
  const hourRows = (await executor.execute(sql`
    SELECT EXTRACT(HOUR FROM (reviewed_at AT TIME ZONE ${hourZone}))::int AS hour,
           count(*) AS cnt,
           sum(CASE WHEN rating >= 2 THEN 1 ELSE 0 END) AS remembered
    FROM reviews
    WHERE ${where}
    GROUP BY 1
  `)) as unknown as { hour: number | string; cnt: number | string; remembered: number | string }[];
  const lastRows = (await executor.execute(sql`
    SELECT max(reviewed_at) AS last
    FROM reviews
    WHERE ${scopeWhere(userId, deckScoped, args.deckIds)}
  `)) as unknown as { last: Date | string | null }[];

  const answers = new Map(answerRows.map((row) => [utcDayKey(row.day), row]));
  const truth = new Map(trueRows.map((row) => [utcDayKey(row.day), row]));
  const series: LearningSeriesPoint[] = [];
  const grades = { again: 0, hard: 0, good: 0, easy: 0 };
  let durationMs = 0;
  let ratingSum = 0;
  for (const span of spans) {
    const day = span.label;
    const answer = answers.get(day);
    const first = truth.get(day);
    const answerCount = Number(answer?.cnt ?? 0);
    const answerSuccessCount = Number(answer?.remembered ?? 0);
    const trueRetentionCount = Number(first?.cnt ?? 0);
    const trueRetentionSuccessCount = Number(first?.remembered ?? 0);
    const dayRating = Number(answer?.rating_sum ?? 0);
    durationMs += Number(answer?.duration ?? 0);
    ratingSum += dayRating;
    grades.again += Number(answer?.again ?? 0);
    grades.hard += Number(answer?.hard ?? 0);
    grades.good += Number(answer?.good ?? 0);
    grades.easy += Number(answer?.easy ?? 0);
    series.push({
      day,
      answerCount,
      answerSuccessCount,
      answerSuccessPct: percentOf(answerSuccessCount, answerCount),
      trueRetentionCount,
      trueRetentionSuccessCount,
      trueRetentionPct: percentOf(trueRetentionSuccessCount, trueRetentionCount),
      averageGrade: averageGrade(dayRating, answerCount),
      durationMs: Number(answer?.duration ?? 0),
    });
  }
  const answerCount = series.reduce((sum, point) => sum + point.answerCount, 0);
  const answerSuccessCount = series.reduce((sum, point) => sum + point.answerSuccessCount, 0);
  const trueRetentionCount = series.reduce((sum, point) => sum + point.trueRetentionCount, 0);
  const trueRetentionSuccessCount = series.reduce((sum, point) => sum + point.trueRetentionSuccessCount, 0);
  const hours = Array.from({ length: 24 }, () => ({ count: 0, success: 0 }));
  for (const row of hourRows) {
    const hour = Number(row.hour);
    if (hour >= 0 && hour < 24) hours[hour] = { count: Number(row.cnt), success: Number(row.remembered) };
  }
  const last = lastRows[0]?.last;
  return {
    days,
    answerCount,
    answerSuccessCount,
    answerSuccessPct: percentOf(answerSuccessCount, answerCount),
    trueRetentionCount,
    trueRetentionSuccessCount,
    trueRetentionPct: percentOf(trueRetentionSuccessCount, trueRetentionCount),
    studyMinutes: Math.round(durationMs / 60000),
    averageGrade: averageGrade(ratingSum, answerCount),
    grades,
    series,
    hours,
    lastReviewedAt: last instanceof Date ? last.toISOString() : last ? String(last) : null,
    hourZone,
    target: await retentionTarget(userId, args.targetDeckId, executor),
  };
}

function subtreeTotal(root: string, children: Map<string, string[]>, own: Map<string, number>): number {
  const seen = new Set<string>();
  const walk = (id: string): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    let total = own.get(id) ?? 0;
    for (const child of children.get(id) ?? []) total += walk(child);
    return total;
  };
  return walk(root);
}

/**
 * One row per owned deck. Own counts are additive. Subtree counts include
 * descendants and must not be summed with each other.
 */
export async function deckBreakdown(
  userId: string,
  days?: number,
  executor: StatsExecutor = db,
): Promise<{ days: number; decks: DeckLearningRow[] }> {
  const windowDays = clampDays(days);
  const calendar = await studyCalendar(userId, windowDays - 1, 0, executor);
  const spans = [...calendar.past, calendar.today];
  const deckRows = (await executor.execute(sql`
    SELECT id, parent_id AS "parentId", preset_id AS "presetId", name, color
    FROM decks WHERE user_id = ${userId}
    ORDER BY name, id
  `)) as unknown as TargetDeckRow[];
  const cardRows = (await executor.execute(sql`
    SELECT deck_id AS "deckId", count(*) AS cnt
    FROM cards WHERE user_id = ${userId}
    GROUP BY deck_id
  `)) as unknown as { deckId: string; cnt: number | string }[];
  const reviewRows = (await executor.execute(sql`
    SELECT deck_id AS "deckId",
           count(*) AS cnt,
           sum(CASE WHEN rating >= 2 THEN 1 ELSE 0 END) AS remembered,
           sum(duration_ms) AS duration
    FROM reviews
    WHERE user_id = ${userId}
      AND deck_id IS NOT NULL
      AND ${spanStampWhere(spans)}
    GROUP BY deck_id
  `)) as unknown as { deckId: string; cnt: number | string; remembered: number | string; duration: number | string | null }[];
  const presetRows = (await executor.execute(sql`
    SELECT id, desired_retention AS "desiredRetention",
           new_per_day AS "newPerDay", reviews_per_day AS "reviewsPerDay",
           learning_steps AS "learningSteps", relearning_steps AS "relearningSteps",
           leech_threshold AS "leechThreshold", maximum_interval AS "maximumInterval"
    FROM deck_options_preset WHERE user_id = ${userId}
  `)) as unknown as { id: string; desiredRetention: number | null }[];
  const profileRows = (await executor.execute(sql`
    SELECT desired_retention AS "desiredRetention" FROM profile WHERE user_id = ${userId} LIMIT 1
  `)) as unknown as { desiredRetention: number | null }[];
  const snapshot = configSnapshot(deckRows, presetRows, profileRows);
  const ownCards = new Map(cardRows.map((row) => [row.deckId, Number(row.cnt)]));
  const ownAnswers = new Map(reviewRows.map((row) => [row.deckId, Number(row.cnt)]));
  const ownSuccess = new Map(reviewRows.map((row) => [row.deckId, Number(row.remembered)]));
  const ownDuration = new Map(reviewRows.map((row) => [row.deckId, Number(row.duration ?? 0)]));
  const children = new Map<string, string[]>();
  for (const deck of deckRows) {
    if (!deck.parentId) continue;
    const list = children.get(deck.parentId) ?? [];
    list.push(deck.id);
    children.set(deck.parentId, list);
  }
  const decksOut: DeckLearningRow[] = deckRows.map((deck) => {
    const cards = ownCards.get(deck.id) ?? 0;
    const answers = ownAnswers.get(deck.id) ?? 0;
    const success = ownSuccess.get(deck.id) ?? 0;
    const subtreeCards = subtreeTotal(deck.id, children, ownCards);
    const subtreeAnswerCount = subtreeTotal(deck.id, children, ownAnswers);
    const subtreeAnswerSuccessCount = subtreeTotal(deck.id, children, ownSuccess);
    const subtreeMs = subtreeTotal(deck.id, children, ownDuration);
    return {
      id: deck.id,
      name: deck.name,
      parentId: deck.parentId,
      color: deck.color,
      ownCards: cards,
      subtreeCards,
      ownAnswerCount: answers,
      ownAnswerSuccessCount: success,
      ownAnswerSuccessPct: percentOf(success, answers),
      subtreeAnswerCount,
      subtreeAnswerSuccessCount,
      subtreeAnswerSuccessPct: percentOf(subtreeAnswerSuccessCount, subtreeAnswerCount),
      ownMinutes: Math.round((ownDuration.get(deck.id) ?? 0) / 60000),
      subtreeMinutes: Math.round(subtreeMs / 60000),
      targetRetentionPct: Math.round(resolveDeckConfig(deck.id, snapshot).desiredRetention * 100),
    };
  });
  decksOut.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { days: windowDays, decks: decksOut };
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
