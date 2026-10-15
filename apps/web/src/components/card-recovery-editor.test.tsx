import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from './navigation';
import { DialogProvider } from './dialog';
import { BASIC_NOTE_TYPE, newUuidV7 } from '@reomi/shared';
import { useNN } from '../lib/store';
import { noteTypeFromApi } from '../lib/mappers';
import { readEditorDraft, writeEditorDraft } from '../lib/editor-drafts';
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNCardForm } = await import('./card-form');
let root: Root, host: HTMLDivElement, oldFetch: typeof fetch;
const owner = 'card-recovery-owner';
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; oldFetch = globalThis.fetch;
  localStorage.clear(); sessionStorage.clear();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  useNN.setState({ profile: { userId: owner } as any, bootstrapped: true, cards: [],
    decks: [{ id: 'deck', name: 'Deck', color: 'lime', species: 'fern', createdAt: 0 }],
    noteTypes: [noteTypeFromApi({ ...BASIC_NOTE_TYPE, updatedAt: '2026-09-23T00:00:00.000Z' })] });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = oldFetch; useNN.getState().reset(); localStorage.clear(); sessionStorage.clear(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
const button = (key: string) => [...host.querySelectorAll('button')].find(button => button.textContent === key)!;
async function front(value: string) {
  await act(async () => { const input = host.querySelector<HTMLTextAreaElement>('textarea[data-nn-field]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const router = { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {}, bfcacheId: 'recovery' };
const view = (onSaved: () => void) => <AppRouterContext.Provider value={router}><PathnameContext.Provider value="/editor">
  <AppNavigationProvider><DialogProvider><NNCardForm onSaved={onSaved} /></DialogProvider></AppNavigationProvider>
</PathnameContext.Provider></AppRouterContext.Provider>;

test('lost card creation resolves once, retains newer text across reload, then updates the created note', async () => {
  let creates = 0, updates = 0, savedCallbacks = 0;
  let committed: any;
  const receipt = (requestId: string, content: string, version: string) => {
    const note = { id: 'saved-note', noteTypeId: BASIC_NOTE_TYPE.id, fieldValues: { Front: content, Back: '' }, tags: [], updatedAt: version };
    return { result: { note, cards: [{ id: 'saved-card', noteId: note.id, deckId: 'deck', templateOrd: 0, state: 'new' }] }, outcome: 'applied', replayed: false,
      serverTime: version, receipt: { id: 'receipt', requestId, kind: 'card-note-save', label: 'Card', target: { kind: 'card-note', id: note.id, revision: version },
        createdAt: version, consumedAt: null, undoUntil: null } };
  };
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/session')) return Response.json({ sessionId: newUuidV7() });
    if (path.includes('/receipts/')) return Response.json({ ...committed, replayed: true });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (/\/notes\/operations\/[0-9a-f-]{36}$/i.test(path)) {
      if ((init?.method ?? 'GET') !== 'POST') {
        return committed
          ? Response.json({ status: 'committed', result: committed.result })
          : Response.json({ error: 'operation_not_found' }, { status: 404 });
      }
      creates++;
      committed = receipt('operation', body.fieldValues.Front, '2026-09-23T00:00:01.000Z');
      throw new Error('reply lost after commit');
    }
    if (path.endsWith('/card-notes')) {
      creates++; committed = receipt(body.requestId, body.input.fieldValues.Front, '2026-09-23T00:00:01.000Z');
      throw new Error('reply lost after commit');
    }
    if (path.endsWith('/preview')) return Response.json({ sourceVersion: committed.result.note.updatedAt, confirmationToken: 'confirmed', impact: { willDeleteCards: 0 } });
    if (path.includes('/card-notes/saved-note')) {
      updates++; expect(body.input.expectedUpdatedAt).toBe(committed.result.note.updatedAt);
      committed = receipt(body.requestId, body.input.fieldValues.Front, '2026-09-23T00:00:02.000Z'); return Response.json(committed);
    }
    return Response.json({ items: [] });
  }) as unknown as typeof fetch;
  const onSaved = () => { savedCallbacks++; };
  await act(async () => root.render(view(onSaved)));
  await front('A');
  await act(async () => button('actions.create').click());
  expect(host.textContent).toContain('actionsRecovery.uncertain');
  await front('Newer B');
  await act(async () => button('actionsRecovery.retry').click());
  expect(creates).toBe(1); expect(savedCallbacks).toBe(0);
  expect(host.querySelector<HTMLTextAreaElement>('textarea[data-nn-field]')!.value).toBe('Newer B');
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  expect((readEditorDraft({ ownerId: owner, kind: 'note', entityId: 'new' })?.value as any).savedNoteId).toBe('saved-note');
  await act(async () => root.render(null));
  await act(async () => root.render(view(onSaved)));
  await act(async () => button('editor.draft.restore').click());
  expect(host.querySelector<HTMLTextAreaElement>('textarea[data-nn-field]')!.value).toBe('Newer B');
  await act(async () => button('actions.save').click());
  expect(creates).toBe(1); expect(updates).toBe(1); expect(savedCallbacks).toBe(1);
});

test('reopening a new-note draft repeats one create operation', async () => {
  const posts: string[] = [];
  let creates = 0;
  const committed = new Map<string, { note: { id: string }; cards: Array<{ id: string }> }>();
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/session')) return Response.json({ sessionId: newUuidV7() });
    const operationId = path.match(/\/notes\/operations\/([0-9a-f-]{36})/i)?.[1];
    if (operationId && (init?.method ?? 'GET') === 'GET') {
      const saved = committed.get(operationId);
      return saved ? Response.json({ status: 'committed', result: saved }) : Response.json({ error: 'operation_not_found' }, { status: 404 });
    }
    if (operationId && init?.method === 'POST') {
      posts.push(operationId);
      const saved = committed.get(operationId);
      if (saved) return Response.json({ ...saved, replayed: true });
      creates += 1;
      const body = JSON.parse(String(init.body));
      const note = { id: 'saved-note', noteTypeId: BASIC_NOTE_TYPE.id, fieldValues: body.fieldValues, tags: [], updatedAt: '2026-09-23T00:00:01.000Z' };
      const result = { note, cards: [{ id: 'saved-card', noteId: note.id, deckId: 'deck', templateOrd: 0, state: 'new' }] };
      committed.set(operationId, result);
      throw new Error('reply lost after commit');
    }
    if (path.includes('/card-notes') && (init?.method ?? 'GET') === 'POST') {
      creates += 1;
      posts.push('legacy');
      throw new Error('reply lost after commit');
    }
    return Response.json({ items: [] });
  }) as unknown as typeof fetch;
  await act(async () => root.render(view(() => {})));
  await front('A');
  await act(async () => button('actions.create').click());
  await act(async () => root.render(null));
  const scope = { ownerId: owner, kind: 'note' as const, entityId: 'new' };
  const stored = readEditorDraft(scope);
  expect(stored?.value).toBeTruthy();
  writeEditorDraft(scope, { ...(stored!.value as object), pendingSave: null }, stored!.revision);
  await act(async () => root.render(view(() => {})));
  await act(async () => button('editor.draft.restore').click());
  await act(async () => button('actions.create').click());
  expect(creates).toBe(1);
  expect(posts).not.toContain('legacy');
  expect(new Set(posts).size).toBe(1);
});

test('a deleted note drops the uncertain create so the next save posts a new operation', async () => {
  const posts: string[] = [];
  let revertedReads = 0;
  const tombstones = new Set<string>();
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/session')) return Response.json({ sessionId: newUuidV7() });
    const operationId = path.match(/\/notes\/operations\/([0-9a-f-]{36})/i)?.[1];
    if (operationId && (init?.method ?? 'GET') === 'GET') {
      if (tombstones.has(operationId)) {
        revertedReads += 1;
        return Response.json({ status: 'reverted' });
      }
      return Response.json({ error: 'operation_not_found' }, { status: 404 });
    }
    if (operationId && init?.method === 'POST') {
      posts.push(operationId);
      if (posts.length === 1) throw new Error('reply lost after commit');
      const note = { id: 'second-note', noteTypeId: BASIC_NOTE_TYPE.id, fieldValues: { Front: 'A', Back: '' }, tags: [], updatedAt: '2026-09-23T00:00:02.000Z' };
      return Response.json({ note, cards: [{ id: 'second-card', noteId: note.id, deckId: 'deck', templateOrd: 0, state: 'new' }], replayed: false });
    }
    return Response.json({ items: [] });
  }) as unknown as typeof fetch;
  await act(async () => root.render(view(() => {})));
  await front('A');
  await act(async () => button('actions.create').click());
  expect(host.textContent).toContain('actionsRecovery.uncertain');
  tombstones.add(posts[0]!);
  await act(async () => button('actionsRecovery.retry').click());
  await act(async () => button('actionsRecovery.retry').click());
  expect(revertedReads).toBe(1);
  expect(posts).toHaveLength(2);
  expect(posts[1]).not.toBe(posts[0]);
});
