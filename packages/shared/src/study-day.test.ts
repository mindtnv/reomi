import { describe, expect, test } from 'bun:test';
import {
  chargeStudyDay,
  describePolicyChange,
  legacyOpenEpoch,
  legacyReviewEpochEnd,
  legacyUtcMidnight,
  parseStudyDayPolicy,
  readStudyDay,
  resolveStudyEpoch,
  studySpans,
  StudyDayError,
  type StudyDayPolicy,
  type StudyEpoch,
  type StudyLedger,
} from './study-day.ts';

const NEW_YORK = parseStudyDayPolicy({ timeZone: 'America/New_York', rolloverMinute: 0 });
const NEW_YORK_FOLD = parseStudyDayPolicy({ timeZone: 'America/New_York', rolloverMinute: 90 });
const TOKYO = parseStudyDayPolicy({ timeZone: 'Asia/Tokyo', rolloverMinute: 0 });
const LEGACY: StudyDayPolicy = { kind: 'legacy-utc' };

function at(iso: string): Date {
  return new Date(iso);
}

function unopened(over: Partial<StudyLedger> = {}): StudyLedger {
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
    ...over,
  };
}

function opened(
  epoch: StudyEpoch,
  counts: { newIntroduced: number; reviewsDone: number },
  over: Partial<Omit<StudyLedger, 'budget'>> = {},
): StudyLedger {
  return {
    budget: { phase: 'open', epoch, newIntroduced: counts.newIntroduced, reviewsDone: counts.reviewsDone },
    todayMinutes: 0,
    streakDays: 0,
    streakFreezes: 0,
    lastReviewEpochEnd: epoch.end,
    lastReviewLabel: epoch.label,
    dailyGoalMetCount: 0,
    dailyGoalMetLabel: null,
    goalMetEpochStart: null,
    dailyGoalMinutes: 15,
    xp: 0,
    ...over,
  };
}

describe('study day clock', () => {
  test('spring New York 2026-03-08 is one 23-hour epoch and a second grade stays on it', () => {
    const during = at('2026-03-08T06:00:00.000Z');
    const afterJump = at('2026-03-08T07:30:00.000Z');
    const openedEpoch = resolveStudyEpoch(during, NEW_YORK, unopened());

    expect(openedEpoch.kind).toBe('first');
    expect(openedEpoch.epoch.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(openedEpoch.epoch.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(openedEpoch.epoch.label).toBe('2026-03-08');
    expect(openedEpoch.epoch.end.getTime() - openedEpoch.epoch.start.getTime()).toBe(23 * 60 * 60 * 1000);
    expect(openedEpoch.newIntroduced).toBe(0);
    expect(openedEpoch.reviewsDone).toBe(0);

    const first = chargeStudyDay({
      now: during,
      policy: NEW_YORK,
      ledger: unopened(),
      resolved: openedEpoch,
      epochDurationMs: 15 * 60_000,
      introducedNew: true,
      reviewedMature: false,
      countTowardBudget: true,
      ratingXp: 10,
    });
    expect(first.ledger.budget.newIntroduced).toBe(1);
    expect(first.ledger.budget.reviewsDone).toBe(0);
    expect(first.ledger.todayMinutes).toBe(15);
    expect(first.ledger.streakDays).toBe(1);
    expect(first.freezeUsed).toBe(false);
    expect(first.dailyGoalJustMet).toBe(true);
    expect(first.ledger.dailyGoalMetCount).toBe(1);
    expect(first.ledger.goalMetEpochStart?.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(first.review.studyDay).toBe('2026-03-08');
    expect(first.review.studyEpochStart.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(first.xp).toBe(10);
    expect(first.level).toBe(1);
    expect(first.plantStage).toBe(0);

    const still = resolveStudyEpoch(afterJump, NEW_YORK, first.ledger);
    expect(still.kind).toBe('same');
    expect(still.epoch.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(still.epoch.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(still.newIntroduced).toBe(1);

    const second = chargeStudyDay({
      now: afterJump,
      policy: NEW_YORK,
      ledger: first.ledger,
      resolved: still,
      epochDurationMs: 16 * 60_000,
      introducedNew: true,
      reviewedMature: false,
      countTowardBudget: true,
      ratingXp: 10,
    });
    expect(second.ledger.budget.newIntroduced).toBe(2);
    expect(second.ledger.todayMinutes).toBe(16);
    expect(second.ledger.streakDays).toBe(1);
    expect(second.dailyGoalJustMet).toBe(false);
    expect(second.ledger.dailyGoalMetCount).toBe(1);
    expect(second.ledger.goalMetEpochStart?.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(second.xp).toBe(20);

    const rolled = resolveStudyEpoch(at('2026-03-09T04:00:00.000Z'), NEW_YORK, second.ledger);
    expect(rolled.kind).toBe('rolled');
    expect(rolled.newIntroduced).toBe(0);
    expect(rolled.reviewsDone).toBe(0);
    expect(rolled.epoch.start.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(rolled.epoch.end.toISOString()).toBe('2026-03-10T04:00:00.000Z');
  });

  test('fall New York rollover inside the repeated hour uses the earlier instant and stays one 25-hour epoch', () => {
    const between = resolveStudyEpoch(at('2026-11-01T06:00:00.000Z'), NEW_YORK_FOLD, unopened());
    expect(between.epoch.start.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(between.epoch.end.toISOString()).toBe('2026-11-02T06:30:00.000Z');
    expect(between.epoch.label).toBe('2026-11-01');
    expect(between.epoch.end.getTime() - between.epoch.start.getTime()).toBe(25 * 60 * 60 * 1000);

    const laterClock = resolveStudyEpoch(at('2026-11-01T06:30:00.000Z'), NEW_YORK_FOLD, unopened());
    expect(laterClock.epoch.start.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(laterClock.epoch.end.toISOString()).toBe('2026-11-02T06:30:00.000Z');

    const beforeRollover = resolveStudyEpoch(at('2026-11-01T05:29:00.000Z'), NEW_YORK_FOLD, unopened());
    expect(beforeRollover.epoch.start.toISOString()).toBe('2026-10-31T05:30:00.000Z');
    expect(beforeRollover.epoch.end.toISOString()).toBe('2026-11-01T05:30:00.000Z');

    const first = chargeStudyDay({
      now: at('2026-11-01T12:00:00.000Z'),
      policy: NEW_YORK_FOLD,
      ledger: unopened(),
      resolved: resolveStudyEpoch(at('2026-11-01T12:00:00.000Z'), NEW_YORK_FOLD, unopened()),
      epochDurationMs: 60_000,
      introducedNew: false,
      reviewedMature: true,
      countTowardBudget: true,
      ratingXp: 10,
    });
    expect(first.ledger.budget.reviewsDone).toBe(1);
    expect(first.ledger.budget.epoch.start.toISOString()).toBe('2026-11-01T05:30:00.000Z');

    const nextUtcDate = resolveStudyEpoch(at('2026-11-02T02:00:00.000Z'), NEW_YORK_FOLD, first.ledger);
    expect(nextUtcDate.kind).toBe('same');
    expect(nextUtcDate.epoch.start.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(nextUtcDate.epoch.end.toISOString()).toBe('2026-11-02T06:30:00.000Z');
    expect(nextUtcDate.reviewsDone).toBe(1);

    const second = chargeStudyDay({
      now: at('2026-11-02T02:00:00.000Z'),
      policy: NEW_YORK_FOLD,
      ledger: first.ledger,
      resolved: nextUtcDate,
      epochDurationMs: 120_000,
      introducedNew: false,
      reviewedMature: true,
      countTowardBudget: true,
      ratingXp: 10,
    });
    expect(second.ledger.budget.reviewsDone).toBe(2);
    expect(second.ledger.streakDays).toBe(1);
  });

  test('a zone change at 2026-10-15T23:00:00Z keeps the open UTC epoch', () => {
    const now = at('2026-10-15T23:00:00.000Z');
    const epoch: StudyEpoch = {
      start: at('2026-10-15T00:00:00.000Z'),
      end: at('2026-10-16T00:00:00.000Z'),
      label: '2026-10-15' as StudyEpoch['label'],
    };
    const ledger = opened(epoch, { newIntroduced: 4, reviewsDone: 7 }, {
      todayMinutes: 40,
      streakDays: 13,
      streakFreezes: 2,
      dailyGoalMetCount: 2,
      dailyGoalMetLabel: epoch.label,
      goalMetEpochStart: epoch.start,
      xp: 100,
    });

    const preview = describePolicyChange(now, epoch, TOKYO);
    expect(preview.takesEffectAt?.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(preview.openEpoch?.start.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(preview.openEpoch?.end.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(preview.policy).toEqual(TOKYO);

    const read = readStudyDay(now, TOKYO, ledger);
    expect(read.startsAt.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(read.endsAt.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(read.label).toBe('2026-10-15');
    expect(read.usedNew).toBe(4);
    expect(read.usedReviews).toBe(7);
    expect(read.todayMinutes).toBe(40);
    expect(read.zone).toBe('Asia/Tokyo');
    expect(read.legacy).toBe(false);

    const same = resolveStudyEpoch(now, TOKYO, ledger);
    expect(same.kind).toBe('same');
    expect(same.newIntroduced).toBe(4);
    expect(same.reviewsDone).toBe(7);
    expect(same.epoch.label).toBe('2026-10-15');

    const charged = chargeStudyDay({
      now,
      policy: TOKYO,
      ledger,
      resolved: same,
      epochDurationMs: 40 * 60_000,
      introducedNew: false,
      reviewedMature: true,
      countTowardBudget: true,
      ratingXp: 5,
    });
    expect(charged.ledger.budget.epoch.start.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(charged.ledger.budget.epoch.end.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(charged.ledger.budget.newIntroduced).toBe(4);
    expect(charged.ledger.budget.reviewsDone).toBe(8);
    expect(charged.ledger.todayMinutes).toBe(40);
    expect(charged.ledger.streakDays).toBe(13);
    expect(charged.ledger.streakFreezes).toBe(2);
    expect(charged.freezeUsed).toBe(false);
    expect(charged.dailyGoalJustMet).toBe(false);
    expect(charged.ledger.dailyGoalMetCount).toBe(2);
    expect(charged.ledger.goalMetEpochStart?.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(charged.plantStage).toBe(1);

    const spans = studySpans({ now, policy: TOKYO, ledger, pastDays: 1, futureDays: 1 });
    expect(spans.today.start.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(spans.today.end.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(spans.today.label).toBe('2026-10-15');
    expect(spans.past[0]?.label).toBe('2026-10-14');
    expect(spans.past[0]?.start.toISOString()).toBe('2026-10-13T15:00:00.000Z');
    expect(spans.past[0]?.end.toISOString()).toBe('2026-10-14T15:00:00.000Z');
    expect(spans.future[0]?.start.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(spans.future[0]?.end.toISOString()).toBe('2026-10-16T15:00:00.000Z');
    expect(spans.future[0]?.label).toBe('2026-10-16');
  });

  test('the grade at the stored end rolls from zero counters and this card adds one', () => {
    const now = at('2026-10-16T00:00:00.000Z');
    const epoch: StudyEpoch = {
      start: at('2026-10-15T00:00:00.000Z'),
      end: at('2026-10-16T00:00:00.000Z'),
      label: '2026-10-15' as StudyEpoch['label'],
    };
    const ledger = opened(epoch, { newIntroduced: 4, reviewsDone: 7 }, {
      todayMinutes: 40,
      streakDays: 13,
      streakFreezes: 2,
      xp: 100,
    });
    const resolved = resolveStudyEpoch(now, TOKYO, ledger);
    expect(resolved.kind).toBe('rolled');
    expect(resolved.boundariesCrossed).toBe(0);
    expect(resolved.newIntroduced).toBe(0);
    expect(resolved.reviewsDone).toBe(0);
    expect(resolved.epoch.start.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(resolved.epoch.end.toISOString()).toBe('2026-10-16T15:00:00.000Z');
    expect(resolved.epoch.label).toBe('2026-10-16');

    const read = readStudyDay(now, TOKYO, ledger);
    expect(read.usedNew).toBe(0);
    expect(read.usedReviews).toBe(0);
    expect(read.todayMinutes).toBe(0);
    expect(read.startsAt.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(read.endsAt.toISOString()).toBe('2026-10-16T15:00:00.000Z');

    const learning = chargeStudyDay({
      now,
      policy: TOKYO,
      ledger,
      resolved,
      epochDurationMs: 30_000,
      introducedNew: false,
      reviewedMature: false,
      countTowardBudget: true,
      ratingXp: 0,
    });
    expect(learning.ledger.budget.newIntroduced).toBe(0);
    expect(learning.ledger.budget.reviewsDone).toBe(0);

    const filtered = chargeStudyDay({
      now,
      policy: TOKYO,
      ledger,
      resolved,
      epochDurationMs: 30_000,
      introducedNew: true,
      reviewedMature: false,
      countTowardBudget: false,
      ratingXp: 0,
    });
    expect(filtered.ledger.budget.newIntroduced).toBe(0);
    expect(filtered.ledger.budget.reviewsDone).toBe(0);
    expect(filtered.ledger.streakDays).toBe(14);

    const introduced = chargeStudyDay({
      now,
      policy: TOKYO,
      ledger,
      resolved,
      epochDurationMs: 60_000,
      introducedNew: true,
      reviewedMature: false,
      countTowardBudget: true,
      ratingXp: 10,
    });
    expect(introduced.ledger.budget.newIntroduced).toBe(1);
    expect(introduced.ledger.budget.reviewsDone).toBe(0);
    expect(introduced.ledger.budget.epoch.start.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(introduced.ledger.todayMinutes).toBe(1);
    expect(introduced.ledger.streakDays).toBe(14);
    expect(introduced.freezeUsed).toBe(false);
    expect(introduced.plantStage).toBe(2);
  });

  test('one missed epoch spends a freeze and two missed epochs reset the streak', () => {
    const epoch: StudyEpoch = {
      start: at('2026-10-01T00:00:00.000Z'),
      end: at('2026-10-02T00:00:00.000Z'),
      label: '2026-10-01' as StudyEpoch['label'],
    };
    const ledger = opened(epoch, { newIntroduced: 1, reviewsDone: 1 }, {
      streakDays: 4,
      streakFreezes: 2,
    });

    const one = resolveStudyEpoch(at('2026-10-03T12:00:00.000Z'), LEGACY, ledger);
    expect(one.kind).toBe('rolled');
    expect(one.boundariesCrossed).toBe(1);
    expect(one.newIntroduced).toBe(0);
    expect(one.epoch.start.toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(one.epoch.end.toISOString()).toBe('2026-10-04T00:00:00.000Z');
    const spent = chargeStudyDay({
      now: at('2026-10-03T12:00:00.000Z'),
      policy: LEGACY,
      ledger,
      resolved: one,
      epochDurationMs: 60_000,
      introducedNew: false,
      reviewedMature: true,
      countTowardBudget: true,
      ratingXp: 10,
    });
    expect(spent.ledger.streakDays).toBe(5);
    expect(spent.ledger.streakFreezes).toBe(1);
    expect(spent.freezeUsed).toBe(true);
    expect(spent.ledger.budget.reviewsDone).toBe(1);

    const two = resolveStudyEpoch(at('2026-10-04T12:00:00.000Z'), LEGACY, ledger);
    expect(two.kind).toBe('rolled');
    expect(two.boundariesCrossed).toBe(2);
    expect(two.epoch.start.toISOString()).toBe('2026-10-04T00:00:00.000Z');
    expect(two.epoch.end.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    const reset = chargeStudyDay({
      now: at('2026-10-04T12:00:00.000Z'),
      policy: LEGACY,
      ledger,
      resolved: two,
      epochDurationMs: 60_000,
      introducedNew: false,
      reviewedMature: true,
      countTowardBudget: true,
      ratingXp: 10,
    });
    expect(reset.ledger.streakDays).toBe(1);
    expect(reset.ledger.streakFreezes).toBe(2);
    expect(reset.freezeUsed).toBe(false);
  });

  test('a missing policy row is UTC midnight', () => {
    const evening = resolveStudyEpoch(at('2026-10-15T23:00:00.000Z'), LEGACY, unopened());
    expect(evening.epoch.start.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(evening.epoch.end.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(evening.epoch.label).toBe('2026-10-15');

    const read = readStudyDay(at('2026-10-15T23:00:00.000Z'), LEGACY, unopened());
    expect(read.legacy).toBe(true);
    expect(read.zone).toBe('UTC');
    expect(read.rolloverMinute).toBe(0);
    expect(read.startsAt.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(read.endsAt.toISOString()).toBe('2026-10-16T00:00:00.000Z');

    const midnight = resolveStudyEpoch(at('2026-10-16T00:00:00.000Z'), LEGACY, unopened());
    expect(midnight.epoch.start.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(midnight.epoch.end.toISOString()).toBe('2026-10-17T00:00:00.000Z');

    const explicit = parseStudyDayPolicy({ timeZone: 'UTC', rolloverMinute: 0 });
    expect(explicit).toEqual({ kind: 'explicit', zone: 'UTC', rolloverMinute: 0 });
    const sameInstant = resolveStudyEpoch(at('2026-10-15T23:00:00.000Z'), explicit, unopened());
    expect(sameInstant.epoch.start.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(sameInstant.epoch.end.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(readStudyDay(at('2026-10-15T23:00:00.000Z'), explicit, unopened()).legacy).toBe(false);
  });

  test('the first grade sets streak to 1 only when there is no prior anchor', () => {
    const now = at('2026-06-02T12:00:00.000Z');
    const fresh = resolveStudyEpoch(now, LEGACY, unopened());
    expect(fresh.kind).toBe('first');
    const started = chargeStudyDay({
      now,
      policy: LEGACY,
      ledger: unopened(),
      resolved: fresh,
      epochDurationMs: 0,
      introducedNew: true,
      reviewedMature: false,
      countTowardBudget: true,
      ratingXp: 0,
    });
    expect(started.ledger.streakDays).toBe(1);

    const kept = unopened({ streakDays: 4 });
    const positive = resolveStudyEpoch(now, LEGACY, kept);
    expect(positive.kind).toBe('first');
    const stayed = chargeStudyDay({
      now,
      policy: LEGACY,
      ledger: kept,
      resolved: positive,
      epochDurationMs: 0,
      introducedNew: true,
      reviewedMature: false,
      countTowardBudget: true,
      ratingXp: 0,
    });
    expect(stayed.ledger.streakDays).toBe(4);
    expect(stayed.freezeUsed).toBe(false);

    const anchored = unopened({
      streakDays: 0,
      lastReviewEpochEnd: at('2026-05-01T00:00:00.000Z'),
    });
    const withAnchor = chargeStudyDay({
      now,
      policy: LEGACY,
      ledger: anchored,
      resolved: resolveStudyEpoch(now, LEGACY, anchored),
      epochDurationMs: 0,
      introducedNew: false,
      reviewedMature: true,
      countTowardBudget: true,
      ratingXp: 0,
    });
    expect(withAnchor.ledger.streakDays).toBe(0);
  });

  test('a spring gap rollover is the transition instant', () => {
    const gap = parseStudyDayPolicy({ timeZone: 'America/New_York', rolloverMinute: 150 });
    const resolved = resolveStudyEpoch(at('2026-03-08T12:00:00.000Z'), gap, unopened());
    expect(resolved.epoch.start.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(resolved.epoch.end.toISOString()).toBe('2026-03-09T06:30:00.000Z');
    expect(resolved.epoch.label).toBe('2026-03-08');
  });

  test('policy parsing accepts a saved zone and rejects a half-cleared body', () => {
    expect(parseStudyDayPolicy({ timeZone: null, rolloverMinute: null })).toEqual({ kind: 'legacy-utc' });
    expect(parseStudyDayPolicy({ timeZone: 'America/New_York', rolloverMinute: 90 })).toEqual({
      kind: 'explicit',
      zone: 'America/New_York',
      rolloverMinute: 90,
    });
    expect(() => parseStudyDayPolicy({ timeZone: 'US/Eastern', rolloverMinute: 0 })).toThrow(StudyDayError);
    expect(() => parseStudyDayPolicy({ timeZone: null, rolloverMinute: 0 })).toThrow(StudyDayError);
    expect(() => parseStudyDayPolicy({ timeZone: 'UTC', rolloverMinute: 1440 })).toThrow(StudyDayError);
    expect(describePolicyChange(at('2026-10-15T23:00:00.000Z'), null, LEGACY).takesEffectAt).toBeNull();
    expect(legacyUtcMidnight('2026-10-15').toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(legacyOpenEpoch('2026-10-14', '2026-10-15')).toEqual({
      start: at('2026-10-15T00:00:00.000Z'),
      end: at('2026-10-16T00:00:00.000Z'),
      label: '2026-10-15',
    });
    expect(legacyOpenEpoch(null, null)).toBeNull();
    expect(legacyReviewEpochEnd('2026-10-15')?.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(legacyReviewEpochEnd(null)).toBeNull();
  });

  test('an unopened ledger with leftover minutes is refused', () => {
    expect(() =>
      resolveStudyEpoch(at('2026-06-02T12:00:00.000Z'), LEGACY, unopened({ todayMinutes: 5 })),
    ).toThrow(StudyDayError);
    try {
      resolveStudyEpoch(
        at('2026-06-02T12:00:00.000Z'),
        LEGACY,
        unopened({ budget: { phase: 'unopened', newIntroduced: 2, reviewsDone: 0 } }),
      );
      throw new Error('returned');
    } catch (error) {
      expect(error).toBeInstanceOf(StudyDayError);
      expect((error as StudyDayError).code).toBe('unopened_ledger');
    }
  });
});
