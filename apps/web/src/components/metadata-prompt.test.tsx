import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { newUuidV7 } from '@reomi/shared';
import { DialogProvider, useDialog } from './dialog';
import { useNN } from '../lib/store';
ensureTestDom();
const { createRoot } = await import('react-dom/client');
let root: Root, host: HTMLDivElement, oldFetch: typeof fetch;
beforeEach(() => { ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useNN.setState({ profile: { userId: newUuidV7() } as any }); sessionStorage.clear();
  oldFetch = globalThis.fetch; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = oldFetch; useNN.getState().reset(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
function Harness() {
  const { edit } = useDialog();
  return <button onClick={() => void edit({ title: 'Rename book', defaultValue: 'Old', path: '/sources/book', revision: 7, patch: title => ({ title }),
    readCurrent: async () => ({ revision: 9, value: 'Other tab' }) })}>Edit</button>;
}
const button = (text: string) => [...host.querySelectorAll('button')].find(button => button.textContent === text)!;
async function open() { await act(async () => root.render(<DialogProvider><Harness /></DialogProvider>)); await act(async () => button('Edit').click()); }
async function type(value: string) { await act(async () => { const input = host.querySelector('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
const saved = (requestId: string, title: string, revision: number) => ({ result: { id: 'book', title, metadataRevision: revision }, outcome: 'applied', replayed: false,
  receipt: { id: 'receipt', requestId, kind: 'source-metadata', target: { kind: 'source', id: 'book', revision: String(revision) }, label: title, createdAt: new Date().toISOString(), undoUntil: null, consumedAt: null }, serverTime: new Date().toISOString() });
test('failed metadata save retains input and retry uses the versioned path', async () => {
  let fail = true; const writes: any[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/session')) return Response.json({ sessionId: newUuidV7() });
    const body = JSON.parse(String(init?.body)); writes.push({ url: String(url), body });
    return fail ? Response.json({ error: 'invalid_metadata' }, { status: 400 }) : Response.json(saved(body.requestId, body.patch.title, 8));
  }) as unknown as typeof fetch;
  await open(); await type('Kept title');
  await act(async () => button('actions.save').click());
  expect(host.querySelector('input')!.value).toBe('Kept title'); expect(host.textContent).toContain('actionsRecovery.failed');
  fail = false; await act(async () => button('actionsRecovery.retry').click());
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(writes.every(write => write.url.includes('/ui-actions/v1/sources/book'))).toBe(true);
  expect(writes[1].body).toMatchObject({ expectedRevision: 7, patch: { title: 'Kept title' } });
});
test('lost metadata reply is reconciled before saving newer input', async () => {
  let committed: any, writes = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/session')) return Response.json({ sessionId: newUuidV7() });
    if (String(url).includes('/receipts/')) return Response.json({ ...committed, replayed: true });
    const body = JSON.parse(String(init?.body)); writes++;
    committed = saved(body.requestId, body.patch.title, writes === 1 ? 8 : 9);
    if (writes === 1) throw new Error('lost');
    expect(body.expectedRevision).toBe(8); return Response.json(committed);
  }) as unknown as typeof fetch;
  await open(); await type('A'); await act(async () => button('actions.save').click());
  await type('Newer B'); await act(async () => button('actionsRecovery.retry').click());
  expect(writes).toBe(1); expect(host.querySelector('input')!.value).toBe('Newer B');
  await act(async () => button('actions.save').click()); expect(writes).toBe(2);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
test('Escape requests a dirty decision and Stay preserves the same form', async () => {
  await open(); await type('Unsaved');
  await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
  await act(async () => button('editor.draft.stay').click());
  expect(host.querySelector('input')!.value).toBe('Unsaved');
});
test('conflicting metadata requires reading and explicitly accepting the current version', async () => {
  const versions: number[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/session')) return Response.json({ sessionId: newUuidV7() });
    const body = JSON.parse(String(init?.body)); versions.push(body.expectedRevision);
    return body.expectedRevision === 7 ? Response.json({ error: 'object_changed' }, { status: 409 }) : Response.json(saved(body.requestId, body.patch.title, 10));
  }) as unknown as typeof fetch;
  await open(); await type('My title'); await act(async () => button('actions.save').click());
  await act(async () => button('actionsRecovery.current').click());
  expect(host.querySelector('input')!.value).toBe('My title'); expect(host.textContent).toContain('Other tab');
  await act(async () => button('actionsRecovery.keepMine').click()); expect(versions).toEqual([7, 9]);
});
