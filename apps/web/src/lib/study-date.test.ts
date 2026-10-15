import { expect, test } from 'bun:test';
import { civilDate, studyDateIso, utcDayKey } from './study-date';

test('manual study dates reject rollover and ambiguous input', () => {
  expect(studyDateIso('2028-02-29')).toBe('2028-02-29T00:00:00.000Z');
  expect(studyDateIso('2026-02-29')).toBeNull();
  expect(studyDateIso('2026-02-31')).toBeNull();
  expect(studyDateIso('tomorrow')).toBeNull();
  expect(studyDateIso('02/03/2026')).toBeNull();
  expect(studyDateIso('')).toBeNull();
});

test('stats day keys survive Eden reviving YYYY-MM-DD into a Date', () => {
  expect(utcDayKey('2026-10-15')).toBe('2026-10-15');
  expect(utcDayKey(new Date('2026-10-15T00:00:00.000Z'))).toBe('2026-10-15');
  expect(utcDayKey(new Date('not-a-day'))).toBe('');
});

test('a study-day label is the civil date, and a rolled-over day is not', () => {
  const spring = civilDate('2026-03-08');
  expect(spring?.getFullYear()).toBe(2026);
  expect(spring?.getMonth()).toBe(2);
  expect(spring?.getDate()).toBe(8);
  expect(civilDate('2026-02-31')).toBeNull();
  expect(civilDate('')).toBeNull();
});
