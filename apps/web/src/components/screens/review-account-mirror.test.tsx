import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { BASIC_NOTE_TYPE } from '@reomi/shared';
import { AppNavigationProvider } from '../navigation';
import { noteTypeFromApi, profileFromApi } from '../../lib/mappers';
import { useNN } from '../../lib/store';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNReview } = await import('./review');

const router = { bfcacheId: 'test', push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {} };
const studyCard = {
  id: '01900000-0000-7000-8000-000000000003', deckId: 'deck', noteId: 'note',
  state: 'new', due: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  renderKind: 'basic', renderFrontText: 'Question', renderBackText: 'Answer',
  note: { id: 'note', fieldValues: { Front: 'Question', Back: 'Answer' }, tags: [] },
  noteType: BASIC_NOTE_TYPE,
};
const calls: Array<{ url: string; resolve: (response: Response) => void }> = [];
let root: Root;
let host: HTMLDivElement;
let oldFetch: typeof fetch;
let holdQueue = false;

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  ensureTestDom();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  holdQueue = false;
  calls.length = 0;
  oldFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/profile') || (holdQueue && url.includes('/cards/queue'))) {
      return new Promise<Response>((resolve) => { calls.push({ url, resolve }); });
    }
    if (url.includes('/cards/queue')) return Promise.resolve(Response.json({ due: [], new: [studyCard], mode: 'regular', summary: { serverNow: '2026-01-01T00:00:00.000Z' } }));
    return Promise.resolve(Response.json({ items: [] }));
  }) as unknown as typeof fetch;
  useNN.getState().reset();
  useNN.setState({
    bootstrapped: true, bootstrapStatus: 'ready',
    profile: profileFromApi({ userId: 'user-a', name: 'Ada', xp: 10 }),
    decks: [{ id: 'deck', name: 'Study', color: 'lime', species: 'fern', createdAt: 0 }],
    noteTypes: [noteTypeFromApi(BASIC_NOTE_TYPE)],
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  globalThis.fetch = oldFetch;
  useNN.getState().reset();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

afterAll(() => { try { GlobalRegistrator.unregister(); } catch { /* already unregistered */ } });

test('a previous profile reconciliation does not overwrite the next account', async () => {
  await act(async () => root.render(
    <AppRouterContext.Provider value={router as any}>
      <PathnameContext.Provider value="/review">
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <AppNavigationProvider><NNReview /></AppNavigationProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  ));
  expect(host.textContent).toContain('Question');
  await act(async () => useNN.setState({ noteTypes: [noteTypeFromApi({ ...BASIC_NOTE_TYPE,
    templates: BASIC_NOTE_TYPE.templates.map((template) => ({ ...template, frontTemplate: 'Changed question' })),
  })] }));
  expect(host.textContent).toContain('review.cardChanged');
  holdQueue = true;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const queue = calls.find((call) => call.url.includes('/cards/queue'));
  expect(queue).toBeTruthy();
  useNN.getState().reset();
  useNN.setState({
    bootstrapped: true, bootstrapStatus: 'ready',
    profile: profileFromApi({ userId: 'user-b', name: 'Bea', xp: 7 }),
    decks: [{ id: 'deck-b', name: 'Beta', color: 'lime', species: 'fern', createdAt: 0 }],
    noteTypes: [noteTypeFromApi(BASIC_NOTE_TYPE)],
  });
  queue!.resolve(Response.json({ due: [], new: [], mode: 'regular', summary: { serverNow: '2026-01-02T00:00:00.000Z' } }));
  await flushMicrotasks();
  const profile = calls.find((call) => call.url.includes('/profile'));
  expect(profile).toBeTruthy();
  profile!.resolve(Response.json({ userId: 'user-a', name: 'Ada', xp: 99 }));
  await flushMicrotasks();
  expect(useNN.getState().profile?.userId).toBe('user-b');
  expect(useNN.getState().profile?.xp).toBe(7);
  await act(async () => {});
  expect(useNN.getState().profile?.userId).toBe('user-b');
  expect(useNN.getState().profile?.xp).toBe(7);
});
