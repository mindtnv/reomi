import { describe, expect, test } from 'bun:test';
import { isRecallSuccess, percentOf, recallSuccessPercent } from './study-metrics.ts';

describe('recall success', () => {
  test('Again fails and Hard, Good and Easy pass', () => {
    expect(isRecallSuccess(1)).toBe(false);
    expect([2, 3, 4].every(isRecallSuccess)).toBe(true);
  });

  test('one of each rating is 75 percent', () => {
    expect(recallSuccessPercent({ 1: 1, 2: 1, 3: 1, 4: 1 })).toBe(75);
  });

  test('an empty population is null, not zero', () => {
    expect(percentOf(0, 0)).toBeNull();
    expect(recallSuccessPercent({ 1: 0, 2: 0, 3: 0, 4: 0 })).toBeNull();
  });
});
