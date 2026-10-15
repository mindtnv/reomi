import { adaptRecoveryFetch } from '../../lib/test-recovery-fetch';
import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from '../navigation';
import { DialogProvider } from '../dialog';
import { I18nProvider } from '../../lib/i18n';
import { clearSessionResourceCache } from '../../lib/session-resource';
import { useNN } from '../../lib/store';

// Re-register before loading DOM-dependent modules; other suites tear the DOM down.
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNStats } = await import('./stats');

const router = { bfcacheId: 'test', push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {} };
let root: Root;
let container: HTMLDivElement;
let originalFetch: typeof fetch;

function seriesPoint(day: string, answerCount = 0) {
  return {
    day,
    answerCount,
    answerSuccessCount: answerCount,
    answerSuccessPct: answerCount ? 100 : null,
    trueRetentionCount: answerCount,
    trueRetentionSuccessCount: answerCount,
    trueRetentionPct: answerCount ? 100 : null,
    averageGrade: answerCount ? 3 : null,
    durationMs: 0,
  };
}

function hours(peak?: { index: number; count: number; success: number }) {
  return Array.from({ length: 24 }, (_, index) =>
    peak && index === peak.index ? { count: peak.count, success: peak.success } : { count: 0, success: 0 },
  );
}

function overview(extra: Record<string, unknown>) {
  return {
    days: 30,
    answerCount: 0,
    answerSuccessCount: 0,
    answerSuccessPct: null,
    trueRetentionCount: 0,
    trueRetentionSuccessCount: 0,
    trueRetentionPct: null,
    studyMinutes: 0,
    averageGrade: null,
    grades: { again: 0, hard: 0, good: 0, easy: 0 },
    series: [seriesPoint('2026-10-15')],
    hours: hours(),
    target: { status: 'uniform', retentionPct: 90 },
    ...extra,
  };
}

beforeEach(() => {
  ensureTestDom();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.removeItem('reomi:locale');
  localStorage.setItem('nn:locale', 'en');
  clearSessionResourceCache();
  originalFetch = globalThis.fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useNN.setState({ profile: { userId: 'stats-owner', xp: 0, level: 1, streakDays: 0 } as never, bootstrapped: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  useNN.getState().reset();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

afterAll(() => GlobalRegistrator.unregister());

async function render() {
  await act(async () => root.render(
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/stats">
        <I18nProvider>
          <AppNavigationProvider>
            <DialogProvider>
              <NNStats />
            </DialogProvider>
          </AppNavigationProvider>
        </I18nProvider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  ));
}

function mockStats(
  body: ReturnType<typeof overview>,
  forecast: { days: number; overdueCount: number; total: number; buckets: { day: string; count: number }[] } = {
    days: 30,
    overdueCount: 0,
    total: 0,
    buckets: [],
  },
) {
  globalThis.fetch = adaptRecoveryFetch((async (url: unknown) => {
    const path = String(url);
    if (path.includes('/stats/overview')) return Response.json(body);
    if (path.includes('/stats/decks')) return Response.json({ days: 30, decks: [] });
    if (path.includes('/stats/forecast')) return Response.json(forecast);
    if (path.includes('/stats/retention')) return Response.json({ days: 365, buckets: [] });
    return Response.json({});
  }) as unknown as typeof fetch);
}

function section(title: string): string {
  const heading = [...container.querySelectorAll('div')].find((el) => el.childNodes.length === 1 && el.textContent === title);
  return heading?.parentElement?.textContent ?? '';
}

test('stats screen renders Eden-revived UTC days and the peak hour the percentage uses', async () => {
  const today = new Date().toISOString().slice(0, 10);
  mockStats(overview({
    answerCount: 4,
    answerSuccessCount: 3,
    answerSuccessPct: 75,
    trueRetentionCount: 4,
    trueRetentionSuccessCount: 3,
    trueRetentionPct: 75,
    averageGrade: 2.5,
    grades: { again: 1, hard: 1, good: 1, easy: 1 },
    series: [seriesPoint('2026-10-15', 4)],
    hours: hours({ index: 15, count: 4, success: 3 }),
  }), {
    days: 30,
    overdueCount: 0,
    total: 4,
    buckets: [{ day: today, count: 4 }],
  });
  await render();
  expect(container.textContent).toContain('Oct 15');
  expect(container.textContent).toContain('3pm');
  expect(container.textContent).not.toContain('3pm–');
  expect(container.textContent).not.toContain('5pm');
  expect(container.textContent).toContain('75%');
  expect(container.innerHTML).toContain(`${today}: 4`);
  expect(container.innerHTML).not.toContain(`${today}: 0`);
});

test('grade shares are a dash when there are no reviews', async () => {
  mockStats(overview({}));
  await render();
  const grades = section('Grade distribution');
  expect(grades).toContain('Again');
  expect(grades).toContain('—');
  expect(grades).not.toContain('%');
});
