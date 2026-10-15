import type { Card as FsrsCard } from 'ts-fsrs';

// Client-side FSRS helpers. Scheduling/preview logic lives in @reomi/shared
// (single source of truth, honors per-user requestRetention) — this module only
// keeps the pure display helper that has no scheduler dependency.

export function humanInterval(card: FsrsCard, now: Date = new Date(), locale = 'en'): string {
  const ms = new Date(card.due).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return locale.startsWith('ru') ? 'сейчас' : 'now';
  const format = (value: number, unit: string) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(value);
  if (ms < 60_000) return format(Math.max(1, Math.ceil(ms / 1000)), 'second');
  const mins = Math.round(ms / 60000);
  if (mins < 60) return format(mins, 'minute');
  const hours = Math.round(mins / 60);
  if (hours < 24) return format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 30) return format(days, 'day');
  const months = Math.round(days / 30);
  if (months < 12) return format(months, 'month');
  return format(Math.round(months / 12), 'year');
}
