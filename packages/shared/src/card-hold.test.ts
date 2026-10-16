import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CARD_IS_VALUES } from './card-query.ts';
import { holdIsActive } from './card-hold.ts';
import { STUDY_COUNT_KEYS, type StudyCounts } from './study.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');

describe('holdIsActive', () => {
  test('an absent or unparsable hold is inactive', () => {
    expect(holdIsActive(null, NOW)).toBe(false);
    expect(holdIsActive(undefined, NOW)).toBe(false);
    expect(holdIsActive({ until: 'not-a-date', reason: 'user' }, NOW)).toBe(false);
  });

  test('the hold is active only while its deadline is still ahead', () => {
    expect(holdIsActive({ until: '2026-10-16T12:00:00.000Z', reason: 'user' }, NOW)).toBe(false);
    expect(holdIsActive({ until: '2026-10-16T11:59:59.999Z', reason: 'sibling' }, NOW)).toBe(false);
    expect(holdIsActive({ until: '2026-10-16T12:00:00.001Z', reason: 'sibling' }, NOW)).toBe(true);
  });
});

test('study count keys are the numeric study counts', () => {
  const zero: StudyCounts = {
    total: 0,
    newCount: 0,
    learningCount: 0,
    reviewCount: 0,
    suspendedCount: 0,
    buriedCount: 0,
    dueBuried: 0,
    dueNew: 0,
    dueLearning: 0,
    dueReview: 0,
    nextLearningAt: null,
    nextDueAt: null,
  };
  const numeric = (Object.keys(zero) as (keyof StudyCounts)[]).filter((key) => typeof zero[key] === 'number');
  expect([...STUDY_COUNT_KEYS].sort()).toEqual(numeric.sort());
});

test('both isMatch switches name every card is: value', () => {
  const client = readFileSync(resolve(import.meta.dir, 'card-query-predicate.ts'), 'utf8');
  const server = readFileSync(resolve(import.meta.dir, '../../../apps/api/src/modules/card-query-sql.ts'), 'utf8');
  for (const value of CARD_IS_VALUES) {
    expect(client).toContain(`case '${value}':`);
    expect(server).toContain(`case '${value}':`);
  }
});
