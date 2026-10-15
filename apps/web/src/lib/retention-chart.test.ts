import { describe, expect, test } from 'bun:test';
import { retentionStroke, retentionY } from './retention-chart.ts';

describe('retention chart', () => {
  test('90% sits on the shared target line', () => {
    expect(retentionY(0.9)).toBe(32);
  });

  test('a day with no answers breaks the stroke', () => {
    const path = retentionStroke([
      { x: 0, y: 40, missing: false },
      { x: 10, y: 50, missing: true },
      { x: 20, y: 30, missing: false },
    ]);
    expect(path).toBe('M 0.0 40.0 M 20.0 30.0');
    expect(path.includes('L 10.0')).toBe(false);
  });
});