import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { newUuidV7 } from '@reomi/shared';
import { DialogProvider } from '../dialog';
import { useNN } from '../../lib/store';
import { readEditorDraft, writeEditorDraft } from '../../lib/editor-drafts';
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { WrittenNoteEditor } = await import('./written-note-editor');
let root: Root, host: HTMLDivElement, oldFetch: typeof fetch, owner: string;
const scope = () => ({ ownerId: owner, kind: 'study-note' as const, entityId: 'source:book:new' });
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  owner = newUuidV7(); useNN.setState({ profile: { userId: owner } as any });
  oldFetch = globalThis.fetch; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); globalThis.fetch = oldFetch; useNN.getState().reset();
  localStorage.clear(); sessionStorage.clear(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
const button = (text: string) => [...host.querySelectorAll('button')].find(button => button.textContent === text)!;
async function type(selector: string, value: string) {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const row = { id: 'note', ownerKind: 'source', sourceId: 'book', sourceOriginId: 'book', sourceOriginTitle: 'Book', title: 'A', content: 'Saved text',
  metadataRevision: 0, kind: 'manual', pinned: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const saved = { result: row, outcome: 'applied', replayed: false, serverTime: new Date().toISOString(), receipt: {
  id: 'receipt', requestId: 'request', kind: 'study-note-create', label: 'A', target: { kind: 'study-note', id: 'note', revision: '0' },
  createdAt: new Date().toISOString(), undoUntil: null, consumedAt: null,
} };

test('a failed create keeps all text and offers inline retry instead of closing the editor', async () => {
  globalThis.fetch = (async (url: unknown) => String(url).endsWith('/session') ? Response.json({ sessionId: newUuidV7() })
    : Response.json({ error: 'invalid_note' }, { status: 400 })) as unknown as typeof fetch;
  let closed = false;
  await act(async () => root.render(<DialogProvider><WrittenNoteEditor studyOwner={{ kind: 'source', id: 'book' }} onSaved={() => { closed = true; }} onClose={() => { closed = true; }} /></DialogProvider>));
  await type('input', 'Keep title'); await type('textarea', 'Keep all\nmy text');
  await act(async () => button('notebooks.notes.save').click());
  expect(closed).toBe(false);
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep all\nmy text');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('actionsRecovery.failed');
  expect(button('actionsRecovery.retry')).toBeDefined();
});

test('a late acknowledgement saves A but preserves newer B and its recovery draft', async () => {
  const response = Promise.withResolvers<Response>();
  const requests: any[] = [];
  globalThis.fetch = (async (url: unknown, init: any) => {
    if (String(url).endsWith('/session')) return Response.json({ sessionId: newUuidV7() });
    requests.push(JSON.parse(init.body)); return response.promise;
  }) as unknown as typeof fetch;
  let close: boolean | undefined;
  await act(async () => root.render(<DialogProvider><WrittenNoteEditor studyOwner={{ kind: 'source', id: 'book' }} onSaved={(_note, shouldClose) => { close = shouldClose; }} onClose={() => {}} /></DialogProvider>));
  await type('input', 'A'); await type('textarea', 'Saved text');
  await act(async () => { button('notebooks.notes.save').click(); });
  await type('textarea', 'Newer B');
  await act(async () => response.resolve(Response.json(saved)));
  expect(requests).toHaveLength(1);
  expect(requests[0].input.content).toBe('Saved text');
  expect(close).toBe(false);
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Newer B');
  expect(host.textContent).not.toContain('actionsRecovery.saved');
  await act(async () => { window.dispatchEvent(new Event('pagehide')); });
  expect((readEditorDraft(scope())?.value as any).content).toBe('Newer B');
});

test('reload offers a written-note draft without writing and restores its original version', async () => {
  writeEditorDraft(scope(), { version: 1, owner: { kind: 'source', id: 'book' }, expectedRevision: 9, title: 'Recovered title', content: 'Recovered text' }, null);
  let writes = 0;
  globalThis.fetch = (async () => { writes++; return Response.json({}); }) as unknown as typeof fetch;
  await act(async () => root.render(<DialogProvider><WrittenNoteEditor studyOwner={{ kind: 'source', id: 'book' }} onSaved={() => {}} onClose={() => {}} /></DialogProvider>));
  expect(host.textContent).toContain('editor.draft.found');
  await act(async () => button('editor.draft.restore').click());
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Recovered text');
  expect(writes).toBe(0);
  expect((readEditorDraft(scope())?.value as any).expectedRevision).toBe(9);
});
