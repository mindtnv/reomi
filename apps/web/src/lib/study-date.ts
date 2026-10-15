/**
 * UTC calendar day from a stats payload. Eden revives `YYYY-MM-DD` into a Date,
 * and `Date#split` is what crashed the stats chart labels.
 */
export function utcDayKey(value: unknown): string {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : '';
  if (typeof value !== 'string' || value.length < 10) return '';
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

/** Local civil date for a server `YYYY-MM-DD` label. Invalid labels stay null. */
export function civilDate(label: string): Date | null {
  const key = utcDayKey(label);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const civil = new Date(year, month - 1, date);
  if (civil.getFullYear() !== year || civil.getMonth() !== month - 1 || civil.getDate() !== date) return null;
  return civil;
}

/** A study date is an exact UTC calendar day, never Date's rollover parsing. */
export function studyDateIso(value: string): string | null {
  const day = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return date.toISOString();
}
