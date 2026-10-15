/**
 * UTC calendar day from a stats payload. Eden revives `YYYY-MM-DD` into a Date,
 * and `Date#split` is what crashed the stats chart labels.
 */
export function utcDayKey(value: unknown): string {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : '';
  if (typeof value !== 'string' || value.length < 10) return '';
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

/** A study date is an exact UTC calendar day, never Date's rollover parsing. */
export function studyDateIso(value: string): string | null {
  const day = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return date.toISOString();
}
