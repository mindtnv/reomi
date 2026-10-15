import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from './navigation';
import { DialogProvider } from './dialog';
import { useNN } from '../lib/store';
import { readEditorDraft, writeEditorDraft, listEditorDrafts } from '../lib/editor-drafts';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { EditorDraftLibrary } = await import('./editor-draft-library');
let root: Root; let host: HTMLDivElement;
const router = { bfcacheId: 'test', push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {} };
const scope = { ownerId: 'library-alice', kind: 'note' as const, entityId: 'deleted-note' };
const value = { fieldValues: { Answer: 'A\nB\nC', Question: 'Alice unsaved source' }, deckId: 'missing', noteTypeId: 'missing', tagsText: 'kept', acceptedAnswersText: '',
  noteType: { id: 'missing', name: 'Saved type', kind: 'basic' as const, isBuiltin: false, styling: '',
    fields: [{ name: 'Question', ord: 0 }, { name: 'Answer', ord: 1 }], templates: [{ name: 'Card', ord: 0, frontTemplate: '{{Question}}', backTemplate: '{{Answer}}' }] } };
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  useNN.setState({ profile: { userId: scope.ownerId } as any, bootstrapped: true, cards: [], noteTypes: [] });
  writeEditorDraft(scope, value, null);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); useNN.getState().reset();
  for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i)!; if (key.startsWith('nn:editor-draft:') || key.startsWith('reomi:editor-draft:')) localStorage.removeItem(key); }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
async function render() {
  await act(async () => root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/editor">
    <AppNavigationProvider><DialogProvider><EditorDraftLibrary /></DialogProvider></AppNavigationProvider>
  </PathnameContext.Provider></AppRouterContext.Provider>));
}
const button = (key: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(key))!;

test('source remains copyable without its original note or type, and account changes replace the view', async () => {
  writeEditorDraft({ ...scope, ownerId: 'library-bob' }, { ...value, fieldValues: { Q: 'Bob source' } }, null);
  await render();
  expect((host.querySelector('textarea[aria-label="Question"]') as HTMLTextAreaElement).value).toBe('Alice unsaved source');
  expect(host.querySelector('h2')!.textContent).toBe('Alice unsaved source');
  expect(host.textContent).not.toContain('Bob source');
  await act(async () => useNN.setState({ profile: { userId: 'library-bob' } as any }));
  expect(host.textContent).not.toContain('Alice unsaved source');
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Bob source');
});

test('written-note recovery exposes retained text even when the source no longer exists', async () => {
  writeEditorDraft({ ...scope, kind: 'study-note', entityId: 'retained-note' }, { version: 1, id: 'retained-note', expectedRevision: 3,
    owner: { kind: 'source', id: 'deleted-source' }, title: 'Written draft', content: 'Full retained\nwritten text' }, null);
  await render();
  expect((host.querySelector('textarea[aria-label="Written draft"]') as HTMLTextAreaElement).value).toBe('Full retained\nwritten text');
  expect(listEditorDrafts(scope.ownerId).some(entry => entry.scope.kind === 'study-note')).toBe(true);
});

test('download preserves the entire draft payload and never clears it', async () => {
  let blob: Blob | undefined;
  const create = spyOn(URL, 'createObjectURL').mockImplementation(value => { blob = value as Blob; return 'blob:draft'; });
  const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const click = spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    await render(); await act(async () => button('editor.draft.download').click());
    expect(JSON.parse(await blob!.text())).toEqual(value);
    expect(readEditorDraft(scope)?.value).toEqual(value);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:draft');
  } finally { create.mockRestore(); revoke.mockRestore(); click.mockRestore(); }
});

test('explicit discard refuses to erase a newer revision written during confirmation', async () => {
  await render(); await act(async () => button('editor.draft.discard').click());
  const previous = readEditorDraft(scope)!;
  writeEditorDraft(scope, { ...value, fieldValues: { Q: 'Newer revision' } }, previous.revision);
  const buttons = host.querySelector('[role="dialog"]')!.querySelectorAll('button');
  await act(async () => (buttons[buttons.length - 1] as HTMLButtonElement).click());
  expect((readEditorDraft(scope)?.value as any).fieldValues.Q).toBe('Newer revision');
  expect(host.textContent).toContain('editor.draft.changed');
});
