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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const raw = Number(parts.find((part) => part.type === 'hour')?.value);
  if (raw === 24) return 0;
  return raw;
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
