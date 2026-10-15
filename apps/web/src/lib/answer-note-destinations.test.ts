import { expect, test } from 'bun:test';
import { answerNoteDestinations } from './answer-note-destinations';
import type { AssistantContextSnapshot } from '@reomi/shared';
const context: AssistantContextSnapshot = { version: 1, revision: 0, policy: 'focus', sourceIds: [], deckIds: [], refs: [
  { ref: { kind: 'source', id: 'book' }, label: 'Book', available: true },
  { ref: { kind: 'source_passage', id: 'book', locator: { quote: 'Excerpt' } }, label: 'Book', available: true },
  { ref: { kind: 'notebook', id: 'notebook' }, label: 'Notebook', available: true },
  { ref: { kind: 'source', id: 'gone' }, label: 'Deleted book', available: false },
] };
test('saving an answer offers its original source and notebook once each', () => {
  expect(answerNoteDestinations([{ role: 'user', context }, { role: 'assistant' }], 1)).toEqual([
    { kind: 'source', id: 'book', label: 'Book' }, { kind: 'notebook', id: 'notebook', label: 'Notebook' },
  ]);
});
test('an answer with its own snapshot uses that snapshot and missing history does not invent a destination', () => {
  expect(answerNoteDestinations([{ role: 'user', context }, { role: 'assistant', context: { ...context, refs: [] } }], 1)).toEqual([]);
  expect(answerNoteDestinations([{ role: 'assistant' }], 0)).toEqual([]);
});
