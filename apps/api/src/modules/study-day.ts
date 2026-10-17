import { Elysia, status, t } from 'elysia';
import { sql, type SQL } from 'drizzle-orm';
import { db, profile, studyDayPolicy } from '@reomi/db';
import {
  describePolicyChange,
  parseStudyDayPolicy,
  readStudyDay,
  StudyDayError,
  type IanaZone,
  type StudyDayLabel,
  type StudyDayPolicy,
  type StudyDayRead,
  type StudyEpoch,
  type StudyLedger,
} from '@reomi/shared';
import type { StudyDaySnapshot } from '@reomi/shared';
import { authPlugin } from '../auth-plugin.ts';

type ProfileRow = typeof profile.$inferSelect;

interface LedgerSource {
  newIntroducedToday: number;
  reviewsDoneToday: number;
  todayMinutes: number;
  streakDays: number;
  streakFreezes: number;
  lastReviewDate: string | null;
  dailyGoalMetCount: number;
  dailyGoalMetDate: string | null;
  dailyGoalMinutes: number;
  xp: number;
  studyEpochStart: Date | null;
  studyEpochEnd: Date | null;
  lastReviewEpochEnd: Date | null;
  goalMetEpochStart: Date | null;
  dailyCountsDate: string | null;
  todayMinutesDate?: string | null;
}

export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

const LABEL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function asDate(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date : null;
}

let databaseNowForTests: Date | null = null;

export function __setDatabaseNowForTests(now: Date | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('database clock override is test-only');
  databaseNowForTests = now ? new Date(now.getTime()) : null;
}

function databaseInstantForTests(): Date | null {
  if (process.env.NODE_ENV !== 'test' || !databaseNowForTests) return null;
  return new Date(databaseNowForTests.getTime());
}

export async function readDatabaseNow(executor: SqlExecutor = db): Promise<Date> {
  const override = databaseInstantForTests();
  if (override) return override;
  const rows = rowsOf<{ studiedAt: unknown }>(await executor.execute(sql`SELECT now() AS "studiedAt"`));
  return asDate(rows[0]?.studiedAt) ?? new Date();
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asLabel(value: string | null | undefined): StudyDayLabel | null {
  if (value && LABEL_RE.test(value)) return value as StudyDayLabel;
  return null;
}

export function ledgerFromProfile(row: LedgerSource | null): StudyLedger {
  const empty: StudyLedger = {
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
  if (!row) return empty;
  const start = row.studyEpochStart;
  const end = row.studyEpochEnd;
  const label = asLabel(row.dailyCountsDate) ?? asLabel(row.todayMinutesDate) ?? asLabel(row.lastReviewDate);
  const budget: StudyLedger['budget'] =
    start && end && start.getTime() < end.getTime()
      ? {
          phase: 'open',
          epoch: {
            start,
            end,
            label: label ?? (start.toISOString().slice(0, 10) as StudyDayLabel),
          },
          newIntroduced: row.newIntroducedToday,
          reviewsDone: row.reviewsDoneToday,
        }
      : {
          phase: 'unopened',
          newIntroduced: row.newIntroducedToday,
          reviewsDone: row.reviewsDoneToday,
        };
  return {
    budget,
    todayMinutes: row.todayMinutes,
    streakDays: row.streakDays,
    streakFreezes: row.streakFreezes,
    lastReviewEpochEnd: row.lastReviewEpochEnd,
    lastReviewLabel: asLabel(row.lastReviewDate),
    dailyGoalMetCount: row.dailyGoalMetCount,
    dailyGoalMetLabel: asLabel(row.dailyGoalMetDate),
    goalMetEpochStart: row.goalMetEpochStart,
    dailyGoalMinutes: row.dailyGoalMinutes,
    xp: row.xp,
  };
}

function ledgerFromSql(row: Record<string, unknown> | undefined): StudyLedger {
  if (!row || row.userId == null) return ledgerFromProfile(null);
  const start = asDate(row.studyEpochStart);
  const end = asDate(row.studyEpochEnd);
  return ledgerFromProfile({
    newIntroducedToday: asInt(row.newIntroducedToday, 0),
    reviewsDoneToday: asInt(row.reviewsDoneToday, 0),
    todayMinutes: asInt(row.todayMinutes, 0),
    streakDays: asInt(row.streakDays, 0),
    streakFreezes: asInt(row.streakFreezes, 0),
    lastReviewDate: typeof row.lastReviewDate === 'string' ? row.lastReviewDate : null,
    dailyGoalMetCount: asInt(row.dailyGoalMetCount, 0),
    dailyGoalMetDate: typeof row.dailyGoalMetDate === 'string' ? row.dailyGoalMetDate : null,
    dailyGoalMinutes: asInt(row.dailyGoalMinutes, 15),
    xp: asInt(row.xp, 0),
    dailyCountsDate: typeof row.dailyCountsDate === 'string' ? row.dailyCountsDate : null,
    studyEpochStart: start,
    studyEpochEnd: end,
    lastReviewEpochEnd: asDate(row.lastReviewEpochEnd),
    goalMetEpochStart: asDate(row.goalMetEpochStart),
  });
}

export function ledgerForRead(ledger: StudyLedger): StudyLedger {
  if (
    ledger.budget.phase === 'unopened' &&
    (ledger.todayMinutes > 0 || ledger.budget.newIntroduced !== 0 || ledger.budget.reviewsDone !== 0)
  ) {
    return {
      ...ledger,
      todayMinutes: 0,
      budget: { phase: 'unopened', newIntroduced: 0, reviewsDone: 0 },
    };
  }
  return ledger;
}

function openEpochAt(ledger: StudyLedger, now: Date): StudyEpoch | null {
  if (ledger.budget.phase !== 'open') return null;
  if (now.getTime() < ledger.budget.epoch.start.getTime()) return null;
  if (now.getTime() >= ledger.budget.epoch.end.getTime()) return null;
  return ledger.budget.epoch;
}

export function studyDaySnapshot(read: StudyDayRead): StudyDaySnapshot {
  return {
    label: read.label,
    startsAt: read.startsAt.toISOString(),
    endsAt: read.endsAt.toISOString(),
    usedNew: read.usedNew,
    usedReviews: read.usedReviews,
    todayMinutes: read.todayMinutes,
    legacy: read.legacy,
    zone: read.zone,
    rolloverMinute: read.rolloverMinute,
  };
}

export async function loadStudyPolicy(userId: string, executor: SqlExecutor = db): Promise<StudyDayPolicy> {
  const rows = rowsOf<{ timeZone: string | null; rolloverMinute: number | string | null }>(
    await executor.execute(sql`
      SELECT time_zone AS "timeZone", rollover_minute AS "rolloverMinute"
      FROM study_day_policy
      WHERE user_id = ${userId}
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row || row.timeZone == null || row.rolloverMinute == null) return { kind: 'legacy-utc' };
  return parseStudyDayPolicy({ timeZone: row.timeZone, rolloverMinute: Number(row.rolloverMinute) });
}

export async function loadStudyClock(
  userId: string,
  executor: SqlExecutor = db,
): Promise<{ now: Date; policy: StudyDayPolicy; ledger: StudyLedger }> {
  const rows = rowsOf<Record<string, unknown>>(await executor.execute(sql`
    SELECT now() AS "studiedAt",
           p.user_id AS "userId",
           p.streak_days AS "streakDays",
           p.streak_freezes AS "streakFreezes",
           p.last_review_date AS "lastReviewDate",
           p.today_minutes AS "todayMinutes",
           p.daily_goal_met_count AS "dailyGoalMetCount",
           p.daily_goal_met_date AS "dailyGoalMetDate",
           p.daily_goal_minutes AS "dailyGoalMinutes",
           p.xp AS "xp",
           p.new_introduced_today AS "newIntroducedToday",
           p.reviews_done_today AS "reviewsDoneToday",
           p.daily_counts_date AS "dailyCountsDate",
           p.study_epoch_start AS "studyEpochStart",
           p.study_epoch_end AS "studyEpochEnd",
           p.last_review_epoch_end AS "lastReviewEpochEnd",
           p.goal_met_epoch_start AS "goalMetEpochStart",
           pol.time_zone AS "timeZone",
           pol.rollover_minute AS "rolloverMinute"
    FROM (SELECT ${userId}::text AS user_id) seed
    LEFT JOIN profile p ON p.user_id = seed.user_id
    LEFT JOIN study_day_policy pol ON pol.user_id = seed.user_id
  `));
  const row = rows[0];
  const now = databaseInstantForTests() ?? asDate(row?.studiedAt) ?? new Date();
  const policy =
    row?.timeZone == null || row.rolloverMinute == null
      ? ({ kind: 'legacy-utc' } as const)
      : parseStudyDayPolicy({ timeZone: row.timeZone, rolloverMinute: Number(row.rolloverMinute) });
  return { now, policy, ledger: ledgerFromSql(row) };
}

export async function readAccountStudyDay(
  userId: string,
  row: ProfileRow | null,
  now: Date,
  executor: SqlExecutor = db,
): Promise<{ read: StudyDayRead; takesEffectAt: Date | null }> {
  const policy = await loadStudyPolicy(userId, executor);
  const ledger = ledgerFromProfile(row);
  const read = readStudyDay(now, policy, ledgerForRead(ledger));
  return { read, takesEffectAt: openEpochAt(ledger, now)?.end ?? null };
}

function present(read: StudyDayRead, takesEffectAt: Date | null) {
  return {
    ...studyDaySnapshot(read),
    takesEffectAt: takesEffectAt ? takesEffectAt.toISOString() : null,
  };
}

async function zoneKnownToPostgres(zone: IanaZone, executor: SqlExecutor): Promise<boolean> {
  const rows = rowsOf<{ name: string }>(await executor.execute(sql`
    SELECT name FROM pg_timezone_names WHERE name = ${zone} LIMIT 1
  `));
  return rows.length === 1;
}

export const studyDayModule = new Elysia({ prefix: '/profile' })
  .use(authPlugin)
  .get(
    '/study-day',
    async ({ user }) => {
      const [row] = await db.select().from(profile).where(sql`${profile.userId} = ${user.id}`).limit(1);
      const { read, takesEffectAt } = await readAccountStudyDay(user.id, row ?? null, new Date());
      return present(read, takesEffectAt);
    },
    { auth: true },
  )
  .patch(
    '/study-day',
    async ({ user, body }) => {
      let policy: StudyDayPolicy;
      try {
        policy = parseStudyDayPolicy(body);
      } catch (err) {
        if (err instanceof StudyDayError) return status(400, { error: err.code });
        throw err;
      }
      if (policy.kind === 'explicit' && !(await zoneKnownToPostgres(policy.zone, db))) {
        return status(400, { error: 'invalid_policy' });
      }
      if (policy.kind === 'legacy-utc') {
        await db.delete(studyDayPolicy).where(sql`${studyDayPolicy.userId} = ${user.id}`);
      } else {
        await db
          .insert(studyDayPolicy)
          .values({ userId: user.id, timeZone: policy.zone, rolloverMinute: policy.rolloverMinute })
          .onConflictDoUpdate({
            target: studyDayPolicy.userId,
            set: { timeZone: policy.zone, rolloverMinute: policy.rolloverMinute, updatedAt: new Date() },
          });
      }
      const [row] = await db.select().from(profile).where(sql`${profile.userId} = ${user.id}`).limit(1);
      const now = new Date();
      const ledger = ledgerFromProfile(row ?? null);
      const read = readStudyDay(now, policy, ledgerForRead(ledger));
      const preview = describePolicyChange(now, openEpochAt(ledger, now), policy);
      return present(read, preview.takesEffectAt);
    },
    {
      auth: true,
      body: t.Object({
        timeZone: t.Union([t.String(), t.Null()]),
        rolloverMinute: t.Union([t.Integer(), t.Null()]),
      }),
    },
  );
