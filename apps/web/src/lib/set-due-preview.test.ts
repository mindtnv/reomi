import { expect, test } from 'bun:test';
import { setDueStateGroups } from './set-due-preview';

test('set due preview groups each FSRS state once, with relearning beside learning', () => {
  expect(setDueStateGroups(['review', 'new', 'relearning', 'learning', 'new'])).toEqual(['new', 'learning', 'review']);
  expect(setDueStateGroups(['relearning'])).toEqual(['learning']);
  expect(setDueStateGroups([])).toEqual([]);
});
