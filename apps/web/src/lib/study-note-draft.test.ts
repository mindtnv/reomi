import { expect, test } from 'bun:test';
import { NOTE_CONTENT_MAX } from '@reomi/shared';
import { isStudyNoteDraft, isStudyNoteSave } from './study-note-draft';

test('an over-limit written buffer remains recoverable without pretending it is a valid save', () => {
  const draft = { version: 1, owner: { kind: 'source', id: 'book' }, expectedRevision: 0, title: 'Long note', content: 'x'.repeat(NOTE_CONTENT_MAX + 100) };
  expect(isStudyNoteDraft(draft)).toBe(true);
  expect(isStudyNoteSave(draft)).toBe(false);
  expect(isStudyNoteDraft({ ...draft, pendingSave: { owner: 'user', requestId: 'request', fingerprint: 'x', payload: draft } })).toBe(false);
});
