import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { newUuidV7, type UiActionReceipt } from '@reomi/shared';
import { useNN } from '../lib/store';
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { RecentActionsProvider, RecentActions } = await import('./recent-actions');
const { ToastsStack, raiseToast } = await import('./toasts');
const { OperationsProvider } = await import('./operations-provider');
const { OperationsButton, OperationsHost } = await import('./operations-center');
let root: Root, host: HTMLDivElement, oldFetch: typeof fetch;
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; oldFetch = globalThis.fetch;
  useNN.setState({ profile: { userId: newUuidV7() } as any });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = oldFetch; useNN.getState().reset(); sessionStorage.clear(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
const receipt = (n: number): UiActionReceipt => ({ id: `receipt-${n}`, requestId: `request-${n}`, kind: 'source-metadata',
  target: { kind: 'source', id: `book-${n}`, revision: '1' }, label: `Book ${n}`, createdAt: new Date().toISOString(),
  undoUntil: new Date(Date.now() + 600_000).toISOString(), consumedAt: null });

test('more than four unexpired actions remain reachable after toast lifetime and owner change clears them', async () => {
  let accountChanged = false;
  globalThis.fetch = (async (url: unknown) => Response.json(String(url).endsWith('/session') ? { sessionId: newUuidV7() }
    : { items: accountChanged ? [] : Array.from({ length: 6 }, (_, i) => receipt(i)), nextCursor: null, serverTime: new Date().toISOString() })) as unknown as typeof fetch;
  await act(async () => root.render(<RecentActionsProvider><RecentActions /></RecentActionsProvider>));
  expect(host.querySelectorAll('li')).toHaveLength(6);
  expect([...host.querySelectorAll('button')].filter(button => button.textContent === 'actionsRecovery.undo')).toHaveLength(6);
  accountChanged = true;
  await act(async () => useNN.setState({ profile: { userId: newUuidV7() } as any }));
  expect(host.textContent).not.toContain('Book 0');
});

test('lost undo response stays visible and focus reconciliation reads its receipt without replaying', async () => {
  const initial = receipt(0);
  let committed = false, writes = 0;
  globalThis.fetch = (async (url: unknown) => {
    const path = String(url);
    if (path.endsWith('/session')) return Response.json({ sessionId: newUuidV7() });
    if (path.endsWith('/undo')) { committed = true; writes++; throw new Error('lost response'); }
    if (path.includes('/receipts/')) return Response.json({ receipt: { ...initial, consumedAt: new Date().toISOString() }, result: {}, outcome: 'undone', replayed: true, serverTime: new Date().toISOString() });
    return Response.json({ items: committed ? [] : [initial], nextCursor: null, serverTime: new Date().toISOString() });
  }) as unknown as typeof fetch;
  await act(async () => root.render(<RecentActionsProvider><RecentActions /></RecentActionsProvider>));
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'actionsRecovery.undo')!.click());
  expect(host.textContent).toContain('actionsRecovery.uncertain');
  expect(host.textContent).toContain('Book 0');
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(writes).toBe(1);
  expect(host.textContent).not.toContain('Book 0');
});

test('an expired actionable toast leaves undo in the common panel without increasing the long-operation count', async () => {
  const item = receipt(1), owner = useNN.getState().profile!.userId;
  globalThis.fetch = (async (url: unknown) => {
    const path = String(url);
    if (path.includes('/operations/v1')) return Response.json({ serverTime: new Date().toISOString(), active: { items: [], total: 0, nextCursor: null }, attention: { items: [], total: 0, nextCursor: null }, recent: { items: [], total: 0, nextCursor: null } });
    return Response.json(path.endsWith('/session') ? { sessionId: newUuidV7() } : { items: [item], nextCursor: null, serverTime: new Date().toISOString() });
  }) as unknown as typeof fetch;
  await act(async () => root.render(<OperationsProvider><RecentActionsProvider><OperationsButton /><OperationsHost /><ToastsStack /></RecentActionsProvider></OperationsProvider>));
  let displayed: any;
  window.addEventListener('nn:toast', event => { displayed = (event as CustomEvent).detail; }, { once: true });
  await act(async () => window.dispatchEvent(new CustomEvent('nn:ui-action', { detail: { owner, receipt: item } })));
  expect(host.querySelector('.nn-toast-action')?.textContent).toBe('actionsRecovery.undo');
  expect(host.querySelector('.nn-operations-count')).toBeNull();
  await act(async () => raiseToast({ ...displayed, durationMs: 1 }));
  await act(async () => { await Bun.sleep(10); });
  expect(host.querySelector('.reomi-toast')).toBeNull();
  expect(host.querySelector('.nn-recent-actions')?.textContent).toContain('Book 1');
  expect(host.querySelector('.nn-recent-actions')?.textContent).toContain('actionsRecovery.undo');
});

test('unavailable session storage is disclosed and server time controls expiry', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')!;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('denied'); } });
  const item = receipt(0);
  globalThis.fetch = (async (url: unknown) => Response.json(String(url).endsWith('/session') ? { sessionId: newUuidV7() }
    : { items: [item], nextCursor: null, serverTime: new Date(Date.now() + 660000).toISOString() })) as unknown as typeof fetch;
  try {
    await act(async () => root.render(<RecentActionsProvider><RecentActions /></RecentActionsProvider>));
    expect(host.textContent).toContain('actionsRecovery.reloadUnavailable');
    expect(host.textContent).toContain('actionsRecovery.expired');
    expect([...host.querySelectorAll('button')].find(button => button.textContent === 'actionsRecovery.undo')!.disabled).toBe(true);
  } finally { Object.defineProperty(globalThis, 'sessionStorage', descriptor); }
});

test('same-tab remount reads the stored server session and offers remain reachable without Operations', async () => {
  const { StandaloneActions } = await import('./recent-actions');
  const owner = useNN.getState().profile!.userId!, sessionId = newUuidV7();
  sessionStorage.setItem(`nn:ui-actions:session:v1:${encodeURIComponent(owner)}`, sessionId);
  const sessions: string[] = []; let issued = 0;
  globalThis.fetch = (async (url: unknown) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/session')) { issued++; return Response.json({ sessionId: newUuidV7() }); }
    sessions.push(parsed.searchParams.get('sessionId')!);
    return Response.json({ items: Array.from({ length: 6 }, (_, i) => receipt(i)), nextCursor: null, serverTime: new Date().toISOString() });
  }) as unknown as typeof fetch;
  const view = <RecentActionsProvider><StandaloneActions /></RecentActionsProvider>;
  await act(async () => root.render(view));
  await act(async () => root.render(null));
  await act(async () => root.render(view));
  expect(issued).toBe(0); expect(sessions).toEqual([sessionId, sessionId]);
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.querySelector('dialog')!.open).toBe(true); expect(host.querySelectorAll('li')).toHaveLength(6);
});

test('memory-only session warning survives remount when storage remains denied', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')!;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('denied'); } });
  let issued = 0;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).endsWith('/session')) { issued++; return Response.json({ sessionId: newUuidV7() }); }
    return Response.json({ items: [receipt(1)], nextCursor: null, serverTime: new Date().toISOString() });
  }) as unknown as typeof fetch;
  try {
    const view = <RecentActionsProvider><RecentActions /></RecentActionsProvider>;
    await act(async () => root.render(view)); await act(async () => root.render(null)); await act(async () => root.render(view));
    expect(issued).toBe(1); expect(host.textContent).toContain('actionsRecovery.reloadUnavailable');
  } finally { Object.defineProperty(globalThis, 'sessionStorage', descriptor); }
});
