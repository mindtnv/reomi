import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from '../navigation';
import { DialogProvider } from '../dialog';
import { cardFromApi, deckFromApi, noteTypeFromApi } from '../../lib/mappers';
import { useNN } from '../../lib/store';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNCardsBrowser } = await import('./cards-browser');

const betaType = noteTypeFromApi({ id: 'type-beta', name: 'Beta type', kind: 'basic', fields: [], templates: [] });
const betaDeck = deckFromApi({ id: 'deck-shared', name: 'Beta deck', color: 'lime', createdAt: '2026-01-01T00:00:00.000Z', position: 0 });
const betaCard = cardFromApi({
  id: 'card-beta', deckId: 'deck-shared', noteId: 'note-beta', state: 'new',
  due: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  renderFrontText: 'Beta question', renderBackText: 'Beta answer',
  note: { id: 'note-beta', fieldValues: { Front: 'Beta question' }, tags: ['beta-tag'] },
  noteType: betaType,
});
const alphaCard = {
  id: 'card-alpha', deckId: 'deck-alpha', noteId: 'note-alpha', state: 'review',
  due: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z',
  renderFrontText: 'Alpha question', renderBackText: 'Alpha answer',
  note: { id: 'note-alpha', fieldValues: { Front: 'Alpha question' }, tags: ['alpha-tag'] },
  noteType: { id: 'type-alpha', name: 'Alpha type', kind: 'basic', fields: [], templates: [] },
};

let root: Root;
let host: HTMLDivElement;
let oldFetch: typeof fetch;
const router = { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {}, bfcacheId: 'test' };
const calls: Array<{ url: string; resolve: (response: Response) => void }> = [];

function installAccountB() {
  useNN.setState({
    bootstrapped: true,
    profile: { userId: 'user-b', name: 'Beta' } as any,
    decks: [betaDeck],
    cards: [betaCard],
    noteTypes: [betaType],
    cardTags: ['beta-tag'],
  });
}

function hangFetch() {
  calls.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
    calls.push({ url: String(input), resolve });
  })) as unknown as typeof fetch;
}

async function renderBrowser() {
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router as any}>
        <PathnameContext.Provider value="/cards">
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <AppNavigationProvider>
              <DialogProvider>
                <NNCardsBrowser />
              </DialogProvider>
            </AppNavigationProvider>
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>,
    );
  });
}

beforeEach(() => {
  ensureTestDom();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  oldFetch = globalThis.fetch;
  hangFetch();
  useNN.getState().reset();
  installAccountB();
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

test('an open cards browser keeps the next account after a late search, deck rename, delete, and tag reply', async () => {
  await renderBrowser();
  expect(host.textContent).toContain('Beta question');
  expect(host.textContent).toContain('Beta deck');
  expect(host.textContent).toContain('beta-tag');

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  const search = calls.find((call) => call.url.includes('/cards/search'));
  expect(search).toBeTruthy();
  const rename = useNN.getState().updateDeck('deck-shared', { name: 'Alpha deck' });
  const removal = useNN.getState().deleteDeck('deck-shared');
  const tags = useNN.getState().getCardTags();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const pendingDecks = calls.filter((call) => call.url.includes('/decks/'));
  const tagCall = [...calls].reverse().find((call) => call.url.includes('/cards/tags'));
  expect(pendingDecks.length).toBeGreaterThanOrEqual(2);
  expect(tagCall).toBeTruthy();

  await act(async () => {
    useNN.getState().reset();
    installAccountB();
    search!.resolve(Response.json({ items: [alphaCard], nextCursor: null }));
    pendingDecks[pendingDecks.length - 2]!.resolve(Response.json({ id: 'deck-shared', name: 'Alpha deck', color: 'lime', createdAt: '2026-01-01T00:00:00.000Z', position: 0 }));
    pendingDecks[pendingDecks.length - 1]!.resolve(Response.json({ ok: true }));
    tagCall!.resolve(Response.json({ tags: ['alpha-tag'] }));
    await Promise.all([rename, removal, tags]);
  });

  expect(host.querySelector('[data-card-row="card-alpha"]')).toBeNull();
  expect(host.querySelector('[data-card-row="card-beta"]')).not.toBeNull();
  expect(host.textContent).toContain('Beta question');
  expect(host.textContent).toContain('Beta deck');
  expect(host.textContent).toContain('beta-tag');
  expect(host.textContent).not.toContain('Alpha question');
  expect(host.textContent).not.toContain('Alpha deck');
  expect(host.textContent).not.toContain('alpha-tag');
});
