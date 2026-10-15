import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from '../navigation';
import { DialogProvider } from '../dialog';
import { useNN } from '../../lib/store';
import type { Deck } from '../../lib/types';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNDecks } = await import('./decks');

const router = { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {}, bfcacheId: 'test' };
const calls: Array<{ url: string; resolve: (response: Response) => void }> = [];
let root: Root;
let host: HTMLDivElement;
let oldFetch: typeof fetch;

function deck(id: string, name: string, extra: Partial<Deck> = {}): Deck {
  return { id, name, color: 'lime', species: 'fern', createdAt: 0, position: 0, ...extra };
}

function keptDecks() {
  return [deck('deck-a', 'Kept'), deck('deck-b', 'Other')];
}

function apiDeck(row: Deck) {
  return { id: row.id, name: row.name, color: row.color, icon: row.icon, parentId: row.parentId ?? null, position: row.position ?? 0, createdAt: '2026-01-01T00:00:00.000Z', metadataRevision: row.metadataRevision ?? 1 };
}

function applied(result: unknown) {
  return {
    result, outcome: 'applied', replayed: false, serverTime: '2026-01-01T00:00:00.000Z',
    receipt: { id: 'receipt', requestId: 'req', kind: 'deck-metadata', target: { kind: 'deck', id: 'deck-a', revision: '2' }, label: 'deck', createdAt: '2026-01-01T00:00:00.000Z', undoUntil: null, consumedAt: null },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function hangFetch() {
  calls.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
    calls.push({ url: String(input), resolve });
  })) as unknown as typeof fetch;
}

function install() {
  useNN.setState({
    bootstrapped: true, bootstrapStatus: 'ready',
    profile: { userId: 'user-a', name: 'Ada' } as any,
    decks: keptDecks(), cards: [], noteTypes: [], presets: [],
  });
}

function reauthenticate() {
  useNN.getState().reset();
  install();
}

async function renderDecks() {
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router as any}>
        <PathnameContext.Provider value="/decks">
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <AppNavigationProvider>
              <DialogProvider><NNDecks /></DialogProvider>
            </AppNavigationProvider>
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>,
    );
  });
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll('button')].find((item) => item.textContent === label || item.getAttribute('aria-label') === label);
  if (!element) throw new Error(`missing ${label}`);
  return element;
}

function latest(part: string) {
  return [...calls].reverse().find((call) => call.url.includes(part));
}

beforeEach(() => {
  ensureTestDom();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
  sessionStorage.clear();
  sessionStorage.setItem('reomi:ui-actions:session:v1:user-a', '01900000-0000-7000-8000-0000000000aa');
  oldFetch = globalThis.fetch;
  hangFetch();
  useNN.getState().reset();
  install();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  globalThis.fetch = oldFetch;
  useNN.getState().reset();
  sessionStorage.clear();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

afterAll(() => { try { GlobalRegistrator.unregister(); } catch { /* already unregistered */ } });

test('a hierarchy reply for the same account still replaces the deck tree', async () => {
  await renderDecks();
  const hierarchy = latest('/deck-hierarchy');
  expect(hierarchy).toBeTruthy();
  hierarchy!.resolve(Response.json({ revision: 4, decks: [apiDeck(deck('deck-a', 'From server')), apiDeck(deck('deck-b', 'Other'))] }));
  await act(async () => { await flushMicrotasks(); });
  expect(useNN.getState().decks.map((row) => row.name)).toEqual(['From server', 'Other']);
  expect(host.textContent).toContain('From server');
});

test('a previous hierarchy reply does not replace decks after the same account signs in again', async () => {
  await renderDecks();
  const hierarchy = latest('/deck-hierarchy');
  expect(hierarchy).toBeTruthy();
  reauthenticate();
  hierarchy!.resolve(Response.json({ revision: 9, decks: [apiDeck(deck('deck-a', 'Alpha')), apiDeck(deck('deck-b', 'Stolen'))] }));
  await flushMicrotasks();
  expect(useNN.getState().decks.map((row) => row.name)).toEqual(['Kept', 'Other']);
  await act(async () => {});
  expect(host.textContent).toContain('Kept');
  expect(host.textContent).not.toContain('Stolen');
});

test('a previous rename does not rewrite the deck after the same account signs in again', async () => {
  await renderDecks();
  latest('/deck-hierarchy')!.resolve(Response.json({ revision: 1, decks: keptDecks().map(apiDeck) }));
  await act(async () => { await flushMicrotasks(); });
  await act(async () => button('decks.deckMenu: Kept').click());
  await act(async () => { button('actions.rename').click(); await flushMicrotasks(); });
  const prompt = document.querySelector('[aria-label="decks.renamePrompt"]');
  expect(prompt).toBeTruthy();
  await act(async () => { (prompt!.querySelector('button[type="submit"]') as HTMLButtonElement).click(); await flushMicrotasks(); });
  const save = latest('/ui-actions/v1/decks/deck-a');
  expect(save).toBeTruthy();
  reauthenticate();
  save!.resolve(Response.json(applied(apiDeck(deck('deck-a', 'Alpha')))));
  await flushMicrotasks();
  expect(useNN.getState().decks.find((row) => row.id === 'deck-a')?.name).toBe('Kept');
});

test('a previous appearance save does not rewrite the deck after the same account signs in again', async () => {
  await renderDecks();
  latest('/deck-hierarchy')!.resolve(Response.json({ revision: 1, decks: keptDecks().map(apiDeck) }));
  await act(async () => { await flushMicrotasks(); });
  await act(async () => button('decks.appearance.title: Kept').click());
  await act(async () => button('actions.save').click());
  const save = latest('/ui-actions/v1/decks/deck-a');
  expect(save).toBeTruthy();
  reauthenticate();
  save!.resolve(Response.json(applied(apiDeck({ ...deck('deck-a', 'Kept'), color: 'rose', icon: 'star' }))));
  await flushMicrotasks();
  expect(useNN.getState().decks.find((row) => row.id === 'deck-a')).toMatchObject({ name: 'Kept', color: 'lime' });
});

test('a previous move does not rewrite the deck tree after the same account signs in again', async () => {
  await renderDecks();
  latest('/deck-hierarchy')!.resolve(Response.json({ revision: 3, decks: keptDecks().map(apiDeck) }));
  await act(async () => { await flushMicrotasks(); });
  await act(async () => button('decks.move.drag').click());
  const destination = host.querySelector('select[aria-label="decks.move.destination"]') as HTMLSelectElement;
  expect(destination).toBeTruthy();
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    descriptor!.set!.call(destination, 'deck-b');
    destination.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => button('decks.move.apply').click());
  const move = latest('/move');
  expect(move).toBeTruthy();
  reauthenticate();
  move!.resolve(Response.json(applied([apiDeck(deck('deck-a', 'Alpha', { parentId: 'deck-b' })), apiDeck(deck('deck-b', 'Stolen'))])));
  await flushMicrotasks();
  expect(useNN.getState().decks.map((row) => row.name)).toEqual(['Kept', 'Other']);
  expect(useNN.getState().decks.find((row) => row.id === 'deck-a')?.parentId).toBeUndefined();
});
