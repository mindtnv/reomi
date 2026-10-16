import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { StudySummary } from '@reomi/shared';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from './navigation';
import { useNN } from '../lib/store';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { DeckDetails } = await import('./deck-details');

const counts: StudySummary = {
  total: 4, newCount: 1, learningCount: 1, reviewCount: 1, suspendedCount: 1, buriedCount: 0, dueBuried: 0,
  dueNew: 0, dueLearning: 0, dueReview: 0, nextLearningAt: null, nextDueAt: null,
  newRemaining: 1, reviewRemaining: 1, availableNew: 1, availableReview: 1, totalAvailable: 2,
  limitedNew: 0, limitedReview: 0, serverNow: '2026-10-16T05:00:00.000Z',
};
const deck = { id: 'deck', name: 'Study', color: 'lime' as const, species: 'fern' as const, createdAt: 0 };
const router = { bfcacheId: 'test', push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {} };

let root: Root;
let container: HTMLDivElement;
let originalFetch: typeof fetch;

beforeEach(() => {
  ensureTestDom();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ days: 7, labels: [], buckets: [], overdueCount: 0, total: 0 })) as unknown as typeof fetch;
  useNN.setState({ bootstrapped: true, profile: { userId: 'deck-owner' } as never });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  useNN.getState().reset();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

afterAll(() => { try { GlobalRegistrator.unregister(); } catch { /* already unregistered */ } });

test('deck composition lists buried cards beside suspended cards, including zero', async () => {
  await act(async () => root.render(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/decks">
        <AppNavigationProvider>
          <DeckDetails deck={deck} decks={[deck]} counts={counts} onBack={() => {}} onAppearance={() => {}} />
        </AppNavigationProvider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  ));
  const text = container.querySelector('.reomi-deck-state-values')?.textContent ?? '';
  const suspended = text.indexOf('cards.states.suspended');
  const buried = text.indexOf('cards.states.buried');
  expect(suspended).toBeGreaterThanOrEqual(0);
  expect(buried).toBeGreaterThan(suspended);
  expect(text).toContain('0');
});
