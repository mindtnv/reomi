export type ReminderLocale = 'ru' | 'en';

export interface ReminderCopy {
  subject: string;
  text: string;
}

function reviewLine(locale: ReminderLocale, reviewUrl: string): string {
  return locale === 'ru' ? `Повторение: ${reviewUrl}` : `Review: ${reviewUrl}`;
}

/** Digest copy is built only from the available count and the review link. */
export function digestCopy(locale: ReminderLocale, count: number, reviewUrl: string): ReminderCopy {
  if (locale === 'ru') {
    return {
      subject: `Reomi: ${count} к повторению`,
      text: `Сейчас доступно карточек: ${count}.\n${reviewLine(locale, reviewUrl)}`,
    };
  }
  return {
    subject: `Reomi: ${count} due`,
    text: `Cards available now: ${count}.\n${reviewLine(locale, reviewUrl)}`,
  };
}

/** Streak copy names the length and, when any remain, the freeze count. */
export function streakCopy(
  locale: ReminderLocale,
  streak: number,
  freezes: number,
  reviewUrl: string,
): ReminderCopy {
  if (locale === 'ru') {
    const freeze = freezes > 0 ? ` Заморозок: ${freezes}.` : '';
    return {
      subject: `Reomi: серия ${streak}`,
      text: `Серия ${streak} дней ещё не закрыта сегодня.${freeze}\n${reviewLine(locale, reviewUrl)}`,
    };
  }
  const freeze = freezes > 0 ? ` Freezes left: ${freezes}.` : '';
  return {
    subject: `Reomi: streak ${streak}`,
    text: `Your ${streak}-day streak has no review yet today.${freeze}\n${reviewLine(locale, reviewUrl)}`,
  };
}

export function localHour(now: Date, timeZone: string): number {
  return wallClock(now.getTime(), wallFormat(timeZone)).hour;
}

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function wallFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function wallClock(instant: number, format: Intl.DateTimeFormat): WallClock {
  const parts = format.formatToParts(new Date(instant));
  const num = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  let hour = num('hour');
  if (hour === 24) hour = 0;
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    hour,
    minute: num('minute'),
    second: num('second'),
  };
}

function wallStamp(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
}

function nextCalendarDay(clock: WallClock): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + 1));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** UTC instants inside the probed offsets where the zone clock reads hour:00:00 on that civil date. */
function localHourInstants(
  year: number,
  month: number,
  day: number,
  hour: number,
  format: Intl.DateTimeFormat,
): number[] {
  const nominal = Date.UTC(year, month - 1, day, hour, 0, 0);
  const found = new Set<number>();
  for (let offsetHours = -14; offsetHours <= 14; offsetHours += 1) {
    const probe = nominal + offsetHours * 3_600_000;
    const probeClock = wallClock(probe, format);
    const utc = nominal - (wallStamp(probeClock) - probe);
    const back = wallClock(utc, format);
    if (
      back.year === year
      && back.month === month
      && back.day === day
      && back.hour === hour
      && back.minute === 0
      && back.second === 0
    ) {
      found.add(utc);
    }
  }
  return [...found];
}

/**
 * First instant in [start, end) when the zone clock jumps forward across hour:00.
 * A spring-forward gap has no real hour:00; the transition itself is that moment.
 */
function forwardJumpAcrossHour(
  start: number,
  end: number,
  hour: number,
  format: Intl.DateTimeFormat,
): number | null {
  const target = hour * 3_600;
  const step = 15 * 60 * 1000;
  const samples: number[] = [];
  for (let t = start + step; t < end; t += step) samples.push(t);
  samples.push(end - 1);
  let prevT = start;
  let prev = wallClock(start, format);
  for (const sample of samples) {
    if (sample <= prevT) continue;
    const cur = wallClock(sample, format);
    const utcElapsed = sample - prevT;
    const localElapsed = wallStamp(cur) - wallStamp(prev);
    if (localElapsed > utcElapsed + 1_000) {
      const origin = prev;
      const originT = prevT;
      let lo = originT;
      let hi = sample;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const midClock = wallClock(mid, format);
        const midUtc = mid - originT;
        const midLocal = wallStamp(midClock) - wallStamp(origin);
        if (midLocal > midUtc + 1_000) hi = mid;
        else lo = mid;
      }
      const before = wallClock(hi - 1, format);
      const after = wallClock(hi, format);
      const beforeSec = before.hour * 3_600 + before.minute * 60 + before.second;
      const afterSec = after.hour * 3_600 + after.minute * 60 + after.second;
      const sameDay = before.year === after.year && before.month === after.month && before.day === after.day;
      const covers = sameDay
        ? beforeSec < target && afterSec > target
        : beforeSec < target || afterSec > target;
      if (covers) return hi;
    }
    prevT = sample;
    prev = cur;
  }
  return null;
}

/**
 * `due_at` for one UTC study day: the first instant in [00:00Z, 24:00Z) when the
 * zone clock reaches `hour:00`. A duplicated fall-back hour uses the earlier
 * occurrence. A spring-forward gap uses the jump that skips the hour. When the
 * hour neither occurs nor is jumped inside the day, there is no send that day.
 */
export function studyDayDueAt(now: Date, hour: number, timeZone: string): Date | null {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = start + 86_400_000;
  const format = wallFormat(timeZone);
  const opening = wallClock(start, format);
  const tomorrow = nextCalendarDay(opening);
  const hits = [
    ...localHourInstants(opening.year, opening.month, opening.day, hour, format),
    ...localHourInstants(tomorrow.year, tomorrow.month, tomorrow.day, hour, format),
  ].filter((instant) => instant >= start && instant < end);
  if (hits.length > 0) return new Date(Math.min(...hits));
  const jumped = forwardJumpAcrossHour(start, end, hour, format);
  return jumped === null ? null : new Date(jumped);
}

/** True once `now` is at or after today's `due_at` and still inside that UTC study day. */
export function isLocalHourDue(now: Date, hour: number, timeZone: string): boolean {
  const due = studyDayDueAt(now, hour, timeZone);
  return due !== null && now.getTime() >= due.getTime();
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
