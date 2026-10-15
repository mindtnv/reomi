import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider, useNavigationGuard } from './navigation';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import type { Root } from 'react-dom/client';
import type { OperationsFeed } from '@reomi/shared';
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { OperationsProvider } = await import('./operations-provider');
const { OperationsButton, OperationsHost } = await import('./operations-center');
const { useNN } = await import('../lib/store');
let root: Root, host: HTMLDivElement, oldFetch: typeof fetch;
const initial = useNN.getState();
function Navigation({ children, push = () => {} }: { children: React.ReactNode; push?: (path: string) => void }) {
  return <AppRouterContext.Provider value={{ push, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} } as any}>
    <PathnameContext.Provider value="/cards"><SearchParamsContext.Provider value={new URLSearchParams()}>
      <AppNavigationProvider>{children}</AppNavigationProvider>
    </SearchParamsContext.Provider></PathnameContext.Provider>
  </AppRouterContext.Provider>;
}
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  oldFetch = globalThis.fetch; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  useNN.setState({ profile: { userId: 'owner' } as any });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = oldFetch; useNN.setState(initial); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
const feed: OperationsFeed = { serverTime: new Date().toISOString(), active: { items: [], total: 0, nextCursor: null }, attention: { items: [], total: 0, nextCursor: null },
  recent: { total: 1, nextCursor: null, items: [{ kind: 'artifact', id: 'quiz', runId: 'run', title: 'Ready quiz', artifactType: 'quiz', phase: 'ready',
    startedAt: null, finishedAt: new Date().toISOString(), canRead: false, canSearch: false, progress: null,
    retry: { allowed: false, reason: 'not_failed', needsDefaults: false }, destination: { kind: 'source-artifact', id: 'quiz', sourceId: null } }] } };

test('the shell list survives route content changes and opens an exact retained quiz without a write', async () => {
  const paths: string[] = [], methods: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => { methods.push(init?.method ?? 'GET'); return Response.json(String(_url).endsWith('/artifacts/quiz') ? { destination: feed.recent.items[0]!.destination } : feed); }) as unknown as typeof fetch;
  const render = (page: string) => <Navigation push={path => paths.push(path)}>
    <OperationsProvider><p>{page}</p><OperationsButton /><OperationsHost /></OperationsProvider>
  </Navigation>;
  await act(async () => root.render(render('Library')));
  await act(async () => root.render(render('Cards')));
  await act(async () => host.querySelector<HTMLButtonElement>('.nn-operations-button')!.click());
  expect(host.querySelector('dialog')?.open).toBe(true);
  expect(document.activeElement).toBe(host.querySelector('dialog'));
  expect(host.querySelector('dialog')?.getAttribute('aria-describedby')).toBeTruthy();
  expect(host.textContent).toContain('Ready quiz');
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'operations.open')!.click());
  expect(paths).toEqual(['/library/study?artifact=quiz']);
  expect(methods.every(method => method === 'GET')).toBe(true);
});

test('account change removes outgoing titles before a delayed replacement feed arrives', async () => {
  let resolve!: (response: Response) => void;
  let current = true;
  globalThis.fetch = (async () => current ? Response.json(feed) : new Promise<Response>(r => { resolve = r; })) as unknown as typeof fetch;
  await act(async () => root.render(<Navigation><OperationsProvider><OperationsHost /></OperationsProvider></Navigation>));
  expect(host.textContent).toContain('Ready quiz');
  current = false;
  await act(async () => useNN.setState({ profile: { userId: 'next-owner' } as any }));
  expect(host.textContent).not.toContain('Ready quiz');
  await act(async () => resolve(Response.json({ ...feed, recent: { items: [], total: 0, nextCursor: null } })));
});

test('a denied departure keeps Operations open and its exact destination ready for retry', async () => {
  const paths: string[] = []; let allowed = false;
  function Editor() { useNavigationGuard(async () => allowed); return <input defaultValue="Unsaved note" />; }
  globalThis.fetch = (async (url: unknown) => Response.json(String(url).endsWith('/artifacts/quiz') ? { destination: feed.recent.items[0]!.destination } : feed)) as unknown as typeof fetch;
  await act(async () => root.render(<Navigation push={path => paths.push(path)}><OperationsProvider><Editor /><OperationsButton /><OperationsHost /></OperationsProvider></Navigation>));
  await act(async () => host.querySelector<HTMLButtonElement>('.nn-operations-button')!.click());
  const open = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'operations.open')!.click();
  await act(async () => open());
  expect(paths).toEqual([]); expect(host.querySelector('dialog')!.open).toBe(true); expect(host.querySelector('input')!.value).toBe('Unsaved note');
  allowed = true; await act(async () => open()); expect(paths).toEqual(['/library/study?artifact=quiz']);
});

test('a new run for the same operation preserves the focused result control', async () => {
  let current = structuredClone(feed);
  globalThis.fetch = (async () => Response.json(current)) as unknown as typeof fetch;
  await act(async () => root.render(<Navigation><OperationsProvider><OperationsButton /><OperationsHost /></OperationsProvider></Navigation>));
  await act(async () => host.querySelector<HTMLButtonElement>('.nn-operations-button')!.click());
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'operations.open')!;
  await act(async () => button.focus()); current.recent.items[0]!.runId = 'replacement-run';
  await act(async () => window.dispatchEvent(new Event('nn:operations-changed')));
  expect(document.activeElement === button).toBe(true); expect(button.isConnected).toBe(true);
});

test('lost retry response remains explicit and reuses its receipt identity', async () => {
  const failed = structuredClone(feed); failed.recent = { items: [], total: 0, nextCursor: null };
  failed.attention = { items: [{ ...feed.recent.items[0]!, phase: 'failed', retry: { allowed: true, reason: null, needsDefaults: false } }], total: 1, nextCursor: null };
  const requests: any[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { requests.push(JSON.parse(String(init.body))); if (requests.length === 1) throw new Error('lost response'); return Response.json({ ok: true }); }
    return Response.json(failed);
  }) as unknown as typeof fetch;
  await act(async () => root.render(<Navigation><OperationsProvider><OperationsButton /><OperationsHost /></OperationsProvider></Navigation>));
  await act(async () => host.querySelector<HTMLButtonElement>('.nn-operations-button')!.click());
  const retry = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'operations.retry')!.click();
  await act(async () => retry()); expect(host.textContent).toContain('operations.uncertain');
  await act(async () => window.dispatchEvent(new Event('focus'))); expect(requests).toHaveLength(1);
  await act(async () => retry()); expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
});

test('a source deleted after observation resolves its still-retained quiz at action time', async () => {
  const current = structuredClone(feed); current.recent.items[0]!.destination = { kind: 'source-artifact', id: 'quiz', sourceId: 'gone-book' };
  const paths: string[] = [], reads: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    reads.push(String(url));
    return Response.json(String(url).endsWith('/operations/v1/artifacts/quiz') ? { destination: { kind: 'source-artifact', id: 'quiz', sourceId: null } } : current);
  }) as unknown as typeof fetch;
  await act(async () => root.render(<Navigation push={path => paths.push(path)}><OperationsProvider><OperationsButton /><OperationsHost /></OperationsProvider></Navigation>));
  await act(async () => host.querySelector<HTMLButtonElement>('.nn-operations-button')!.click());
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'operations.open')!.click());
  expect(paths).toEqual(['/library/study?artifact=quiz']); expect(reads.some(path => path.endsWith('/operations/v1/artifacts/quiz'))).toBe(true);
});

test('keyboard Show more releases row ordering so the newly loaded page is actually visible', async () => {
  const first = structuredClone(feed); first.recent.total = 2; first.recent.nextCursor = 'second';
  globalThis.fetch = (async (url: unknown) => {
    const next = structuredClone(first);
    if (String(url).includes('recentCursor=second')) next.recent = { items: [{ ...feed.recent.items[0]!, id: 'second-quiz', title: 'Second quiz' }], total: 2, nextCursor: null };
    return Response.json(next);
  }) as unknown as typeof fetch;
  await act(async () => root.render(<Navigation><OperationsProvider><OperationsButton /><OperationsHost /></OperationsProvider></Navigation>));
  await act(async () => host.querySelector<HTMLButtonElement>('.nn-operations-button')!.click());
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'operations.open')!.focus());
  await act(async () => { const more = [...host.querySelectorAll('button')].find(button => button.textContent === 'operations.more')!; more.focus(); more.click(); });
  expect(host.querySelectorAll('[data-operation-id]')).toHaveLength(2); expect(host.textContent).toContain('Second quiz');
});

test('a deleted result remains a labelled fallback, never an enabled result or retry', async () => {
  let current = structuredClone(feed); current.recent.items[0]!.destination = { kind: 'source-artifact', id: 'quiz', sourceId: 'book' };
  globalThis.fetch = (async () => Response.json(current)) as unknown as typeof fetch;
  await act(async () => root.render(<Navigation><OperationsProvider><OperationsButton /><OperationsHost /></OperationsProvider></Navigation>));
  await act(async () => host.querySelector<HTMLButtonElement>('.nn-operations-button')!.click());
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'operations.open')!.focus());
  current.recent = { items: [], total: 0, nextCursor: null };
  await act(async () => window.dispatchEvent(new Event('nn:operations-changed')));
  expect(host.textContent).toContain('operations.resultUnavailable'); expect(host.textContent).not.toContain('operations.quizReady');
  expect([...host.querySelectorAll('[data-operation-id] button')].some(button => button.textContent === 'operations.open' || button.textContent === 'operations.retry')).toBe(false);
});

test('closing Operations while resolving a result cancels the later navigation intent', async () => {
  const current = structuredClone(feed); current.recent.items[0]!.destination = { kind: 'source-artifact', id: 'quiz', sourceId: 'book' };
  const result = Promise.withResolvers<Response>(), paths: string[] = [];
  globalThis.fetch = (async (url: unknown) => String(url).endsWith('/operations/v1/artifacts/quiz') ? result.promise : Response.json(current)) as unknown as typeof fetch;
  await act(async () => root.render(<Navigation push={path => paths.push(path)}><OperationsProvider><OperationsButton /><OperationsHost /></OperationsProvider></Navigation>));
  await act(async () => host.querySelector<HTMLButtonElement>('.nn-operations-button')!.click());
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'operations.open')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('dialog header button')!.click());
  await act(async () => result.resolve(Response.json({ destination: { kind: 'source-artifact', id: 'quiz', sourceId: 'book' } })));
  expect(paths).toEqual([]); expect(host.querySelector('dialog')!.open).toBe(false);
});
