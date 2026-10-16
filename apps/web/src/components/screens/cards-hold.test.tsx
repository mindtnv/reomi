import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { BASIC_NOTE_TYPE } from '@reomi/shared';
import { AppNavigationProvider } from '../navigation';
import { DialogProvider } from '../dialog';
import { cardFromApi } from '../../lib/mappers';
import { useNN } from '../../lib/store';
import type { Card } from '../../lib/types';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNCardsBrowser } = await import('./cards-browser');

const router = { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {}, bfcacheId: 'test' };
const until = '2026-10-17T21:00:00.000Z';

function browserCard(id: string, front: string, hold: CardHold | null, suspended = false): Card & { hold: CardHold | null } {
  return {
    ...cardFromApi({
      id, deckId: 'deck-a', noteId: `note-${id}`, state: 'review', suspended,
      due: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', createdAt: '2026-10-16T00:00:00.000Z',
      renderKind: 'basic', renderFrontText: front, renderBackText: 'Answer',
      note: { id: `note-${id}`, fieldValues: { Front: front, Back: 'Answer' }, tags: [] },
      noteType: BASIC_NOTE_TYPE,
    }),
    hold,
  };
}

type CardHold = { until: string; reason: 'user' };

let root: Root;
let host: HTMLDivElement;
let originalFetch: typeof fetch;
const holds: unknown[] = [];

function install(cards: Array<Card & { hold: CardHold | null }>) {
  holds.length = 0;
  useNN.setState({
    bootstrapped: true,
    profile: { userId: 'cards-owner' } as never,
    decks: [{ id: 'deck-a', name: 'Deck', color: 'lime', species: 'fern', createdAt: 0 }],
    noteTypes: [BASIC_NOTE_TYPE as never],
    cards,
    cardTags: [],
    getCardTags: async () => [],
    searchCards: async () => ({ items: cards, nextCursor: null }),
  });
}

beforeEach(() => {
  ensureTestDom();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/cards/holds')) {
      holds.push(JSON.parse(String(init?.body ?? '{}')));
      return Response.json({ action: 'bury', cardIds: ['card-a'], until });
    }
    return Response.json({ items: [] });
  }) as typeof fetch;
  window.sessionStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  globalThis.fetch = originalFetch;
  useNN.getState().reset();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

afterAll(() => { try { GlobalRegistrator.unregister(); } catch { /* already unregistered */ } });

async function render() {
  await act(async () => root.render(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/cards">
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <AppNavigationProvider><DialogProvider><NNCardsBrowser /></DialogProvider></AppNavigationProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
}

function menuLabels() {
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => (item.textContent ?? '').trim());
}

async function openRowMenu(id: string) {
  const trigger = host.querySelector(`[data-card-row="${id}"] .reomi-card-row-actions`) as HTMLButtonElement;
  expect(trigger?.disabled).toBe(false);
  await act(async () => trigger.click());
}

test('one selected card can bury that card or bury and bring back its note', async () => {
  const card = browserCard('card-a', 'Held question', null);
  install([card]);
  await render();
  await openRowMenu(card.id);
  const labels = menuLabels();
  expect(labels).toContain('cards.bulk.bury');
  expect(labels).toContain('cards.bulk.buryNote');
  expect(labels).toContain('cards.bulk.unburyNote');
  expect(labels).not.toContain('cards.bulk.unbury');
  const bury = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((item) => item.textContent === 'cards.bulk.bury');
  await act(async () => { bury!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(holds).toEqual([{ action: 'bury', cardIds: ['card-a'] }]);
});

test('a held card shows Buried beside its schedule and offers bring back', async () => {
  const card = browserCard('card-a', 'Held question', { until, reason: 'user' }, true);
  install([card]);
  await render();
  const row = host.querySelector('[data-card-row="card-a"]');
  expect(row?.textContent).toContain('cards.states.review');
  expect(row?.textContent).toContain('cards.states.suspended');
  expect(row?.textContent).toContain('cards.states.buried');
  await openRowMenu(card.id);
  const labels = menuLabels();
  expect(labels).toContain('cards.bulk.unbury');
  expect(labels).not.toContain('cards.bulk.bury');
  expect(labels).toContain('cards.bulk.buryNote');
  expect(labels).toContain('cards.bulk.unburyNote');
});

test('several selected cards bury or bring back the selection and not the note', async () => {
  const cards = [browserCard('card-a', 'First', null), browserCard('card-b', 'Second', { until, reason: 'user' })];
  install(cards);
  await render();
  const boxes = host.querySelectorAll<HTMLInputElement>('[data-card-row] input[type="checkbox"]');
  await act(async () => { boxes[0]!.click(); boxes[1]!.click(); });
  expect(host.querySelectorAll('[data-card-row] input[type="checkbox"]:checked').length).toBe(2);
  const open = Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes('cards.actions.open'));
  expect(open?.disabled).toBe(false);
  await act(async () => open!.click());
  const labels = menuLabels();
  expect(labels).toContain('cards.bulk.bury');
  expect(labels).toContain('cards.bulk.unbury');
  expect(labels).not.toContain('cards.bulk.buryNote');
  expect(labels).not.toContain('cards.bulk.unburyNote');
});
