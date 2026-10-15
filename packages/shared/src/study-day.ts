import { levelFromXp, plantStageFromStreak } from './fsrs.ts';
import { clampFreezes } from './gamification.ts';

declare const ianaZoneBrand: unique symbol;
declare const rolloverMinuteBrand: unique symbol;
declare const studyDayLabelBrand: unique symbol;

export type IanaZone = string & { readonly [ianaZoneBrand]: 'IanaZone' };

/** 0..1439. Local minute-of-day at which the next study day begins. */
export type RolloverMinute = number & { readonly [rolloverMinuteBrand]: 'RolloverMinute' };

export type StudyDayLabel = string & { readonly [studyDayLabelBrand]: 'StudyDayLabel' };

export type StudyDayPolicy =
  | { readonly kind: 'legacy-utc' }
  | { readonly kind: 'explicit'; readonly zone: IanaZone; readonly rolloverMinute: RolloverMinute };

export interface StudyEpoch {
  readonly start: Date;
  readonly end: Date;
  readonly label: StudyDayLabel;
}

export type StoredBudget =
  | { readonly phase: 'unopened'; readonly newIntroduced: number; readonly reviewsDone: number }
  | {
      readonly phase: 'open';
      readonly epoch: StudyEpoch;
      readonly newIntroduced: number;
      readonly reviewsDone: number;
    };

type RolledBudget = {
  readonly kind: 'rolled';
  readonly epoch: StudyEpoch;
  readonly newIntroduced: 0;
  readonly reviewsDone: 0;
  /** Epochs strictly between the stored end and this epoch's start. */
  readonly boundariesCrossed: number;
};

export type ResolvedEpoch =
  | {
      readonly kind: 'same';
      readonly epoch: StudyEpoch;
      readonly newIntroduced: number;
      readonly reviewsDone: number;
      readonly boundariesCrossed: 0;
    }
  | RolledBudget
  | {
      readonly kind: 'first';
      readonly epoch: StudyEpoch;
      readonly newIntroduced: 0;
      readonly reviewsDone: 0;
      readonly boundariesCrossed: 0;
    };

export interface StudyLedger {
  readonly budget: StoredBudget;
  readonly todayMinutes: number;
  readonly streakDays: number;
  readonly streakFreezes: number;
  readonly lastReviewEpochEnd: Date | null;
  readonly lastReviewLabel: StudyDayLabel | null;
  readonly dailyGoalMetCount: number;
  readonly dailyGoalMetLabel: StudyDayLabel | null;
  readonly goalMetEpochStart: Date | null;
  readonly dailyGoalMinutes: number;
  readonly xp: number;
}

export interface StudyDayRead {
  readonly label: StudyDayLabel;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly usedNew: number;
  readonly usedReviews: number;
  readonly todayMinutes: number;
  readonly legacy: boolean;
  readonly zone: IanaZone;
  readonly rolloverMinute: RolloverMinute;
}

export interface StudyDaySpan {
  readonly label: StudyDayLabel;
  readonly start: Date;
  readonly end: Date;
}

export interface StudyCalendar {
  readonly zone: IanaZone;
  readonly rolloverMinute: RolloverMinute;
  readonly legacy: boolean;
  readonly today: StudyDaySpan;
  readonly past: readonly StudyDaySpan[];
  readonly future: readonly StudyDaySpan[];
}

export interface PolicyChangePreview {
  readonly policy: StudyDayPolicy;
  readonly openEpoch: StudyEpoch | null;
  readonly takesEffectAt: Date | null;
}

export interface StudyDayChargeInput {
  readonly now: Date;
  readonly policy: StudyDayPolicy;
  readonly ledger: StudyLedger;
  readonly resolved: ResolvedEpoch;
  readonly epochDurationMs: number;
  readonly introducedNew: boolean;
  readonly reviewedMature: boolean;
  readonly countTowardBudget: boolean;
  readonly ratingXp: number;
}

export interface ChargedLedger extends Omit<StudyLedger, 'budget'> {
  readonly budget: Extract<StoredBudget, { readonly phase: 'open' }>;
}

export interface StudyDayCharge {
  readonly ledger: ChargedLedger;
  readonly review: { readonly studyDay: StudyDayLabel; readonly studyEpochStart: Date };
  readonly freezeUsed: boolean;
  readonly dailyGoalJustMet: boolean;
  readonly xp: number;
  readonly level: number;
  readonly plantStage: 0 | 1 | 2 | 3 | 4 | 5;
}

export class StudyDayError extends Error {
  readonly code: 'invalid_policy' | 'unopened_ledger' | 'epoch_mismatch';

  constructor(code: StudyDayError['code']) {
    super(code);
    this.name = 'StudyDayError';
    this.code = code;
  }
}

const UTC_ZONE = 'UTC' as IanaZone;
const MIDNIGHT = 0 as RolloverMinute;
const LABEL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CivilTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    calendar: 'gregory',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(zone, created);
  return created;
}

function civilParts(instant: Date, zone: string): CivilTime {
  const bag = new Map<string, string>();
  for (const part of formatter(zone).formatToParts(instant)) {
    if (part.type !== 'literal') bag.set(part.type, part.value);
  }
  let hour = Number(bag.get('hour'));
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.get('year')),
    month: Number(bag.get('month')),
    day: Number(bag.get('day')),
    hour,
    minute: Number(bag.get('minute')),
    second: Number(bag.get('second')),
  };
}

function ymd(year: number, month: number, day: number): StudyDayLabel {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` as StudyDayLabel;
}

function parseLabel(label: string): { year: number; month: number; day: number } | null {
  const match = LABEL_RE.exec(label);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function shiftLabel(label: string, days: number): StudyDayLabel {
  const parsed = parseLabel(label);
  if (!parsed) throw new StudyDayError('invalid_policy');
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return ymd(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function zoneName(policy: StudyDayPolicy): string {
  return policy.kind === 'legacy-utc' ? 'UTC' : policy.zone;
}

function rolloverOf(policy: StudyDayPolicy): number {
  return policy.kind === 'legacy-utc' ? 0 : policy.rolloverMinute;
}

function brandedZone(policy: StudyDayPolicy): IanaZone {
  return policy.kind === 'legacy-utc' ? UTC_ZONE : policy.zone;
}

function brandedRollover(policy: StudyDayPolicy): RolloverMinute {
  return policy.kind === 'legacy-utc' ? MIDNIGHT : policy.rolloverMinute;
}

function offsetMs(instantMs: number, zone: string): number {
  const parts = civilParts(new Date(instantMs), zone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instantMs;
}

function clockMatches(
  instantMs: number,
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): boolean {
  const parts = civilParts(new Date(instantMs), zone);
  return (
    parts.year === year &&
    parts.month === month &&
    parts.day === day &&
    parts.hour === hour &&
    parts.minute === minute &&
    parts.second === 0
  );
}

function atOrPast(
  instantMs: number,
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): boolean {
  const parts = civilParts(new Date(instantMs), zone);
  const got = [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second];
  const want = [year, month, day, hour, minute, 0];
  for (let i = 0; i < want.length; i += 1) {
    if (got[i]! > want[i]!) return true;
    if (got[i]! < want[i]!) return false;
  }
  return true;
}

// A fall-back fold has two instants for one civil minute. The earlier one is the only boundary.
// A spring gap has none. The boundary is the transition, the first local time at or past that minute.
function firstInstant(zone: string, year: number, month: number, day: number, rolloverMinute: number): Date {
  const hour = Math.floor(rolloverMinute / 60);
  const minute = rolloverMinute % 60;
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = desiredUtc - offsetMs(desiredUtc, zone);
  guess = desiredUtc - offsetMs(guess, zone);

  let earliest: number | null = null;
  const consider = (instantMs: number) => {
    if (!clockMatches(instantMs, zone, year, month, day, hour, minute)) return;
    if (earliest === null || instantMs < earliest) earliest = instantMs;
  };
  for (let delta = -180; delta <= 180; delta += 15) {
    const probe = guess + delta * 60_000;
    consider(desiredUtc - offsetMs(probe, zone));
  }
  if (earliest !== null) return new Date(earliest);

  let lo = guess - 3 * 3_600_000;
  let hi = guess + 3 * 3_600_000;
  if (atOrPast(lo, zone, year, month, day, hour, minute) || !atOrPast(hi, zone, year, month, day, hour, minute)) {
    throw new StudyDayError('invalid_policy');
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (atOrPast(mid, zone, year, month, day, hour, minute)) hi = mid;
    else lo = mid + 1;
  }
  return new Date(lo);
}

function civilLabel(instant: Date, zone: string): StudyDayLabel {
  const parts = civilParts(instant, zone);
  return ymd(parts.year, parts.month, parts.day);
}

function firstInstantOnLabel(zone: string, label: string, rolloverMinute: number): Date {
  const parsed = parseLabel(label);
  if (!parsed) throw new StudyDayError('invalid_policy');
  return firstInstant(zone, parsed.year, parsed.month, parsed.day, rolloverMinute);
}

function epochContaining(now: Date, policy: StudyDayPolicy): StudyEpoch {
  const zone = zoneName(policy);
  const rollover = rolloverOf(policy);
  const local = civilParts(now, zone);
  const localLabel = ymd(local.year, local.month, local.day);
  const onLocalDate = firstInstantOnLabel(zone, localLabel, rollover);
  const start =
    onLocalDate.getTime() <= now.getTime()
      ? onLocalDate
      : firstInstantOnLabel(zone, shiftLabel(localLabel, -1), rollover);
  const label = civilLabel(start, zone);
  const end = firstInstantOnLabel(zone, shiftLabel(label, 1), rollover);
  if (start.getTime() > now.getTime() || end.getTime() <= now.getTime()) {
    throw new StudyDayError('invalid_policy');
  }
  return { start, end, label };
}

function nextBoundaryAfter(instant: Date, policy: StudyDayPolicy): Date {
  const end = epochContaining(instant, policy).end;
  if (end.getTime() <= instant.getTime()) throw new StudyDayError('invalid_policy');
  return end;
}

function copyEpoch(epoch: StudyEpoch): StudyEpoch {
  return {
    start: new Date(epoch.start.getTime()),
    end: new Date(epoch.end.getTime()),
    label: epoch.label,
  };
}

function intlAcceptsZone(zone: string): boolean {
  // supportedValuesOf omits UTC. DateTimeFormat accepts it, and a saved UTC row is a real policy.
  if (zone === 'UTC') return true;
  return Intl.supportedValuesOf('timeZone').includes(zone);
}

export function parseStudyDayPolicy(input: unknown): StudyDayPolicy {
  if (!input || typeof input !== 'object') throw new StudyDayError('invalid_policy');
  const body = input as { timeZone?: unknown; rolloverMinute?: unknown };
  const zoneNull = body.timeZone === null;
  const minuteNull = body.rolloverMinute === null;
  if (zoneNull !== minuteNull) throw new StudyDayError('invalid_policy');
  if (zoneNull && minuteNull) return { kind: 'legacy-utc' };
  if (typeof body.timeZone !== 'string' || !intlAcceptsZone(body.timeZone)) {
    throw new StudyDayError('invalid_policy');
  }
  if (
    typeof body.rolloverMinute !== 'number' ||
    !Number.isInteger(body.rolloverMinute) ||
    body.rolloverMinute < 0 ||
    body.rolloverMinute > 1439
  ) {
    throw new StudyDayError('invalid_policy');
  }
  return {
    kind: 'explicit',
    zone: body.timeZone as IanaZone,
    rolloverMinute: body.rolloverMinute as RolloverMinute,
  };
}

export function resolveStudyEpoch(now: Date, policy: StudyDayPolicy, ledger: StudyLedger): ResolvedEpoch {
  if (ledger.budget.phase === 'open' && now.getTime() < ledger.budget.epoch.end.getTime()) {
    if (now.getTime() < ledger.budget.epoch.start.getTime()) throw new StudyDayError('epoch_mismatch');
    return {
      kind: 'same',
      epoch: copyEpoch(ledger.budget.epoch),
      newIntroduced: ledger.budget.newIntroduced,
      reviewsDone: ledger.budget.reviewsDone,
      boundariesCrossed: 0,
    };
  }
  if (ledger.budget.phase === 'unopened') {
    if (ledger.todayMinutes > 0 || ledger.budget.newIntroduced !== 0 || ledger.budget.reviewsDone !== 0) {
      throw new StudyDayError('unopened_ledger');
    }
    return {
      kind: 'first',
      epoch: epochContaining(now, policy),
      newIntroduced: 0,
      reviewsDone: 0,
      boundariesCrossed: 0,
    };
  }

  return epochAfterFrozenEnd(now, policy, ledger.budget.epoch.end);
}

function epochAfterFrozenEnd(now: Date, policy: StudyDayPolicy, frozenEnd: Date): ResolvedEpoch {
  let start = new Date(frozenEnd.getTime());
  let crossed = 0;
  for (;;) {
    const end = nextBoundaryAfter(start, policy);
    if (now.getTime() < end.getTime()) {
      return {
        kind: 'rolled',
        epoch: { start, end, label: civilLabel(start, zoneName(policy)) },
        newIntroduced: 0,
        reviewsDone: 0,
        boundariesCrossed: crossed,
      };
    }
    crossed += 1;
    start = end;
  }
}

function streakForCharge(
  resolved: ResolvedEpoch,
  ledger: StudyLedger,
): { streakDays: number; streakFreezes: number; freezeUsed: boolean } {
  if (resolved.kind === 'same') {
    return { streakDays: ledger.streakDays, streakFreezes: ledger.streakFreezes, freezeUsed: false };
  }
  if (resolved.kind === 'first') {
    const noAnchor = ledger.lastReviewEpochEnd === null && ledger.streakDays <= 0;
    return {
      streakDays: noAnchor ? 1 : ledger.streakDays,
      streakFreezes: ledger.streakFreezes,
      freezeUsed: false,
    };
  }
  if (resolved.boundariesCrossed === 0) {
    return { streakDays: ledger.streakDays + 1, streakFreezes: ledger.streakFreezes, freezeUsed: false };
  }
  if (resolved.boundariesCrossed === 1 && ledger.streakFreezes > 0) {
    return {
      streakDays: ledger.streakDays + 1,
      streakFreezes: ledger.streakFreezes - 1,
      freezeUsed: true,
    };
  }
  return { streakDays: 1, streakFreezes: ledger.streakFreezes, freezeUsed: false };
}

export function chargeStudyDay(input: StudyDayChargeInput): StudyDayCharge {
  const { resolved, ledger } = input;
  if (resolved.kind === 'same') {
    if (ledger.budget.phase !== 'open') throw new StudyDayError('epoch_mismatch');
    if (
      ledger.budget.epoch.start.getTime() !== resolved.epoch.start.getTime() ||
      ledger.budget.epoch.end.getTime() !== resolved.epoch.end.getTime()
    ) {
      throw new StudyDayError('epoch_mismatch');
    }
  }
  if (resolved.kind === 'rolled' && ledger.budget.phase !== 'open') {
    throw new StudyDayError('epoch_mismatch');
  }

  const addNew = input.countTowardBudget && input.introducedNew ? 1 : 0;
  const addReview = input.countTowardBudget && input.reviewedMature ? 1 : 0;
  const minutes = Math.floor(Math.max(0, input.epochDurationMs) / 60_000);
  const streak = streakForCharge(resolved, ledger);
  const alreadyCredited = ledger.goalMetEpochStart?.getTime() === resolved.epoch.start.getTime();
  const met = minutes >= ledger.dailyGoalMinutes;
  const dailyGoalJustMet = met && !alreadyCredited;
  const goalMetEpochStart = dailyGoalJustMet
    ? new Date(resolved.epoch.start.getTime())
    : ledger.goalMetEpochStart === null
      ? null
      : new Date(ledger.goalMetEpochStart.getTime());
  const xp = ledger.xp + input.ratingXp;
  const streakDays = streak.streakDays;
  const epoch = copyEpoch(resolved.epoch);

  return {
    ledger: {
      budget: {
        phase: 'open',
        epoch,
        newIntroduced: resolved.newIntroduced + addNew,
        reviewsDone: resolved.reviewsDone + addReview,
      },
      todayMinutes: minutes,
      streakDays,
      streakFreezes: clampFreezes(streak.streakFreezes),
      lastReviewEpochEnd: new Date(epoch.end.getTime()),
      lastReviewLabel: epoch.label,
      dailyGoalMetCount: ledger.dailyGoalMetCount + (dailyGoalJustMet ? 1 : 0),
      dailyGoalMetLabel: dailyGoalJustMet ? epoch.label : ledger.dailyGoalMetLabel,
      goalMetEpochStart,
      dailyGoalMinutes: ledger.dailyGoalMinutes,
      xp,
    },
    review: { studyDay: epoch.label, studyEpochStart: new Date(epoch.start.getTime()) },
    freezeUsed: streak.freezeUsed,
    dailyGoalJustMet,
    xp,
    level: levelFromXp(xp),
    plantStage: plantStageFromStreak(streakDays),
  };
}

export function readStudyDay(now: Date, policy: StudyDayPolicy, ledger: StudyLedger): StudyDayRead {
  const resolved = resolveStudyEpoch(now, policy, ledger);
  const open = resolved.kind === 'same';
  return {
    label: resolved.epoch.label,
    startsAt: new Date(resolved.epoch.start.getTime()),
    endsAt: new Date(resolved.epoch.end.getTime()),
    usedNew: open ? resolved.newIntroduced : 0,
    usedReviews: open ? resolved.reviewsDone : 0,
    todayMinutes: open ? ledger.todayMinutes : 0,
    legacy: policy.kind === 'legacy-utc',
    zone: brandedZone(policy),
    rolloverMinute: brandedRollover(policy),
  };
}

function spanForLabel(policy: StudyDayPolicy, label: StudyDayLabel): StudyDaySpan {
  const zone = zoneName(policy);
  const rollover = rolloverOf(policy);
  return {
    label,
    start: firstInstantOnLabel(zone, label, rollover),
    end: firstInstantOnLabel(zone, shiftLabel(label, 1), rollover),
  };
}

export function studySpans(args: {
  now: Date;
  policy: StudyDayPolicy;
  ledger: StudyLedger;
  pastDays: number;
  futureDays: number;
}): StudyCalendar {
  const todayRead = readStudyDay(args.now, args.policy, args.ledger);
  const today: StudyDaySpan = { label: todayRead.label, start: todayRead.startsAt, end: todayRead.endsAt };
  const past: StudyDaySpan[] = [];
  for (let age = args.pastDays; age >= 1; age -= 1) {
    past.push(spanForLabel(args.policy, shiftLabel(today.label, -age)));
  }
  const future: StudyDaySpan[] = [];
  let cursor = today.end;
  for (let i = 0; i < args.futureDays; i += 1) {
    const end = nextBoundaryAfter(cursor, args.policy);
    future.push({ label: civilLabel(cursor, zoneName(args.policy)), start: cursor, end });
    cursor = end;
  }
  return {
    zone: todayRead.zone,
    rolloverMinute: todayRead.rolloverMinute,
    legacy: todayRead.legacy,
    today,
    past,
    future,
  };
}

export function describePolicyChange(
  now: Date,
  openEpoch: StudyEpoch | null,
  next: StudyDayPolicy,
): PolicyChangePreview {
  if (!Number.isFinite(now.getTime())) throw new StudyDayError('invalid_policy');
  return {
    policy: next,
    openEpoch,
    takesEffectAt: openEpoch === null ? null : new Date(openEpoch.end.getTime()),
  };
}

export function legacyUtcMidnight(label: string): Date {
  const parsed = parseLabel(label);
  if (!parsed) throw new StudyDayError('invalid_policy');
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
}

export function legacyOpenEpoch(
  dailyCountsDate: string | null,
  todayMinutesDate: string | null,
): StudyEpoch | null {
  const label =
    dailyCountsDate && todayMinutesDate
      ? dailyCountsDate > todayMinutesDate
        ? dailyCountsDate
        : todayMinutesDate
      : (dailyCountsDate ?? todayMinutesDate);
  if (!label) return null;
  const branded = shiftLabel(label, 0);
  return {
    start: legacyUtcMidnight(branded),
    end: legacyUtcMidnight(shiftLabel(branded, 1)),
    label: branded,
  };
}

export function legacyReviewEpochEnd(lastReviewDate: string | null): Date | null {
  if (lastReviewDate === null) return null;
  return legacyUtcMidnight(shiftLabel(lastReviewDate, 1));
}
