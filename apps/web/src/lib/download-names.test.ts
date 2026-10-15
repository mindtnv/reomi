import { expect, test } from 'bun:test';
import { editorDraftDownload } from './editor-drafts';
import { profileExportFile } from './profile-export';

test('account export is named for Reomi and contains only the supplied owner', () => {
  const alice = profileExportFile({ profile: { userId: 'alice' }, cards: [{ front: 'alice only' }] });
  const bob = profileExportFile({ profile: { userId: 'bob' }, cards: [{ front: 'bob only' }] });
  expect(alice.filename).toBe('reomi-export.json');
  expect(alice.body).toContain('alice only');
  expect(alice.body).not.toContain('bob');
  expect(bob.body).toContain('bob only');
  expect(bob.body).not.toContain('alice only');
  expect(alice.filename).not.toContain('neuronexus');
});

test('editor draft downloads are named for Reomi and contain only that value', () => {
  const note = editorDraftDownload({ ownerId: 'alice', front: 'kept' }, 'note');
  const other = editorDraftDownload({ ownerId: 'bob', front: 'other' }, 'type');
  expect(note.filename).toBe('reomi-note-draft.json');
  expect(other.filename).toBe('reomi-type-draft.json');
  expect(note.body).toContain('kept');
  expect(note.body).not.toContain('other');
  expect(note.filename).not.toContain('neuronexus');
});
