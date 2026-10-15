import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from '../navigation';
import { DialogProvider } from '../dialog';
import { useNN } from '../../lib/store';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNEditor } = await import('./editor');
const { NNDecks } = await import('./decks');
let root: Root, host: HTMLDivElement, previousFetch: typeof fetch;
const router = { bfcacheId: 'test', push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {} };
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  previousFetch = globalThis.fetch; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  useNN.setState({ bootstrapped: true, decks: [], cards: [], profile: { userId: 'object-link-owner' } as any });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch; useNN.getState().reset(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });

test('flashcard-note link retains readable source fields even when all generated cards were deleted', async () => {
  let requested = '';
  globalThis.fetch = (async (url: any) => { requested = String(url); return Response.json({
    note: { id: 'note-without-cards', fieldValues: { Front: 'Preserved question', Back: 'Preserved answer' } },
    noteType: { id: 'type', name: 'Basic', fields: [{ name: 'Front' }, { name: 'Back' }] }, cards: [],
  }); }) as typeof fetch;
  await act(async () => root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/editor">
    <SearchParamsContext.Provider value={new URLSearchParams({ noteId: 'note-without-cards' })}><AppNavigationProvider><DialogProvider>
      <NNEditor />
    </DialogProvider></AppNavigationProvider></SearchParamsContext.Provider>
  </PathnameContext.Provider></AppRouterContext.Provider>));
  expect(requested).toContain('/notes/note-without-cards');
  expect(host.textContent).toContain('Preserved question');
  expect(host.textContent).toContain('Preserved answer');
  expect(host.textContent).toContain('editor.orphanNote');
});

test('deck object link selects its target and expands a collapsed parent', async () => {
  const parent = { id: 'parent', name: 'Parent deck', parentId: null, color: 'lime', species: 'fern', position: 0 };
  const child = { ...parent, id: 'child', name: 'Target deck', parentId: 'parent' };
  useNN.setState({ decks: [parent,child] as any });
  localStorage.removeItem('reomi:decks:collapsed');
  localStorage.setItem('nn:decks:collapsed', JSON.stringify(['parent']));
  globalThis.fetch = (async (url: any) => Response.json(String(url).includes('forecast')
    ? { days: 7, overdueCount: 0, total: 0, buckets: [] }
    : { overall: { serverNow: new Date().toISOString(), total: 0, nextDueAt: null }, decks: {} })) as typeof fetch;
  await act(async () => root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/decks">
    <SearchParamsContext.Provider value={new URLSearchParams({ focus: child.id })}><AppNavigationProvider><DialogProvider>
      <NNDecks />
    </DialogProvider></AppNavigationProvider></SearchParamsContext.Provider>
  </PathnameContext.Provider></AppRouterContext.Provider>));
  expect(host.querySelector('.reomi-deck-detail-heading h2')?.textContent).toBe('Target deck');
  expect(host.querySelector(`[data-deck-id="${child.id}"]`)).not.toBeNull();
  localStorage.removeItem('nn:decks:collapsed');
});
