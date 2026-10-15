import { afterEach, expect, test } from 'bun:test';
import { readStudyResult, saveStudyResult, clearStudyResult, subscribeStudyResult, type StudyResult } from './study-result';
import { currentStorageKey } from './storage-migration';

const result: StudyResult = { version: 1, userId: 'a', completedAt: 1234, deckName: 'Study',
  answers: 2, cards: 1, xpGained: 10, durationMs: 1500, grades: { 1: 1, 2: 0, 3: 1, 4: 0 }, mode: 'regular', reviewHref: '/review?deck=deck' };
const data = new Map<string, string>();
const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
afterEach(() => { clearStudyResult('a', storage); data.clear(); });

test('results belong only to their signed-in owner', () => {
  saveStudyResult(result, storage);
  expect(readStudyResult('a', storage)).toEqual(result);
  expect(readStudyResult('b', storage)).toBeNull();
  expect(readStudyResult(undefined, storage)).toBeNull();
});

test('bad counts and external continuation links cannot be read as a valid result', () => {
  for (const invalid of [{ cards: -1 }, { answers: 3 }, { durationMs: null }, { reviewHref: 'https://example.com' }, { userId: 'b' }]) {
    data.set('nn:lastSession:a', JSON.stringify({ ...result, ...invalid }));
    expect(readStudyResult('a', storage)).toBeNull();
  }
});

test('a newer report in storage replaces the older cached report', () => {
  saveStudyResult(result, storage);
  const newer = { ...result, completedAt: 2000, deckName: 'Later' };
  data.set(currentStorageKey('nn:lastSession:a'), JSON.stringify(newer));
  expect(readStudyResult('a', storage)).toEqual(newer);
});

test('an older stored report stays behind a newer cached report', () => {
  const newer = { ...result, completedAt: 2000 };
  saveStudyResult(newer, storage);
  data.set(currentStorageKey('nn:lastSession:a'), JSON.stringify(result));
  expect(readStudyResult('a', storage)).toEqual(newer);
});

test('the same completion time with a different report yields the stored report', () => {
  saveStudyResult(result, storage);
  const other = { ...result, deckName: 'Other tab' };
  data.set(currentStorageKey('nn:lastSession:a'), JSON.stringify(other));
  expect(readStudyResult('a', storage)).toEqual(other);
});

test('a storage event refreshes an open page and leaves another user untouched', () => {
  const seen: Array<StudyResult | null> = [];
  const target = new EventTarget();
  const stop = subscribeStudyResult('a', (value) => { seen.push(value); }, storage, target);
  saveStudyResult(result, storage);
  const newer = { ...result, completedAt: 2000, deckName: 'Later' };
  const raw = JSON.stringify(newer);
  data.set(currentStorageKey('nn:lastSession:a'), raw);
  target.dispatchEvent(new StorageNotice(currentStorageKey('nn:lastSession:a'), raw));
  expect(seen).toEqual([newer]);
  const other = { ...result, userId: 'b', completedAt: 3000, deckName: 'Other' };
  data.set(currentStorageKey('nn:lastSession:b'), JSON.stringify(other));
  target.dispatchEvent(new StorageNotice(currentStorageKey('nn:lastSession:b'), JSON.stringify(other)));
  expect(seen).toEqual([newer]);
  expect(readStudyResult('a', storage)).toEqual(newer);
  expect(readStudyResult('b', storage)).toEqual(other);
  data.set(currentStorageKey('nn:lastSession:a'), '');
  target.dispatchEvent(new StorageNotice(currentStorageKey('nn:lastSession:a'), ''));
  expect(seen).toEqual([newer, null]);
  expect(readStudyResult('a', storage)).toBeNull();
  expect(readStudyResult('b', storage)).toEqual(other);
  stop();
  clearStudyResult('b', storage);
});

class StorageNotice extends Event {
  constructor(readonly key: string | null, readonly newValue: string | null) { super('storage'); }
}

test('blocked storage still permits an in-memory result and undo clears it', () => {
  const unavailable = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } };
  saveStudyResult(result, unavailable);
  expect(readStudyResult('a', unavailable)).toEqual(result);
  clearStudyResult('a', unavailable);
  expect(readStudyResult('a', unavailable)).toBeNull();
});
