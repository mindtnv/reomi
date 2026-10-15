import { describe, expect, test } from 'bun:test';
import { newFsrsCard } from '@reomi/shared';
import { humanInterval } from './fsrs';

describe('review interval display', () => {
  const now = new Date('2026-09-19T00:00:00Z');
  test('short intervals never display zero minutes', () => {
    expect(humanInterval(newFsrsCard(new Date(now.getTime() + 10_000)), now, 'en')).toContain('10');
  });
  test('Russian study controls use Russian units', () => {
    expect(humanInterval(newFsrsCard(new Date(now.getTime() + 600_000)), now, 'ru')).toContain('мин');
    expect(humanInterval(newFsrsCard(now), now, 'ru')).toBe('сейчас');
  });
  test('bad timestamps are unknown, not a NaN interval', () => {
    const card = newFsrsCard(now);
    card.due = new Date(NaN);
    expect(humanInterval(card, now, 'en')).toBe('—');
  });
});
