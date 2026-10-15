import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { useNN } from '../lib/store';
import { noteTypeFromApi } from '../lib/mappers';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NoteTypeDeletionDialog } = await import('./note-type-deletion');
const type = noteTypeFromApi({ id: 'type-id', name: 'Owned', kind: 'basic', fields: [], templates: [], styling: '', isBuiltin: false });
const impact = { noteTypeId: type.id, name: 'Current server name', notes: 701, cards: 700, reviews: 900,
  notesWithoutCards: 1, sourceVersion: '2026-09-19T00:00:00.000Z', confirmationToken: 'a'.repeat(64) };
let root: Root;
let host: HTMLDivElement;
let savedFetch: typeof fetch;
let closed: number;
let preserved: number;
const button = (text: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === text)!;
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  savedFetch = globalThis.fetch; closed = 0; preserved = 0;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  useNN.setState({ bootstrapped: true, noteTypes: [type], cards: [] });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); globalThis.fetch = savedFetch;
  useNN.getState().reset(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
async function render() {
  await act(async () => root.render(<NoteTypeDeletionDialog type={type} onClose={() => { closed++; }} onPreserve={() => { preserved++; }} />));
}

test('delete uses the complete server preview and sends its exact confirmation only on click', async () => {
  const requests: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
    return Response.json(init.method === 'DELETE' ? { ok: true } : impact);
  }) as typeof fetch;
  await render();
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toContain('/delete-preview');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('noteTypes.deletion.counts');
  // No loaded cards are required to expose the server's orphan/export choices.
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('noteTypes.deletion.orphans');
  expect(button('noteTypes.deletion.apply').disabled).toBe(false);
  await act(async () => { button('noteTypes.deletion.apply').click(); button('noteTypes.deletion.apply').click(); });
  expect(requests.filter(r => r.method === 'DELETE')).toEqual([{ url: requests[0].url.replace('/delete-preview', ''), method: 'DELETE', body: { confirmationToken: impact.confirmationToken } }]);
  expect(closed).toBe(1);
  expect(useNN.getState().noteTypes).toHaveLength(0);
});

test('failed preview cannot delete; preservation navigation never sends DELETE', async () => {
  let available = false;
  const methods: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    methods.push(init.method); return available ? Response.json(impact) : Response.json({ error: 'unavailable' }, { status: 503 });
  }) as typeof fetch;
  await render();
  expect(button('noteTypes.deletion.apply')).toBeUndefined();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('noteTypes.deletion.loadFailed');
  available = true;
  await act(async () => button('noteTypes.deletion.refresh').click());
  await act(async () => button('noteTypes.deletion.preserve').click());
  expect(preserved).toBe(1);
  expect(methods).toEqual(['GET', 'GET']);
});

test('stale confirmation clears impact until a new explicit preview and decision', async () => {
  let reads = 0; const tokens: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    if (init.method !== 'DELETE') return Response.json({ ...impact, confirmationToken: ++reads === 1 ? 'a'.repeat(64) : 'b'.repeat(64) });
    tokens.push(JSON.parse(init.body).confirmationToken);
    return tokens.length === 1 ? Response.json({ error: 'preview_changed' }, { status: 409 }) : Response.json({ ok: true });
  }) as typeof fetch;
  await render();
  await act(async () => button('noteTypes.deletion.apply').click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('noteTypes.deletion.changed');
  expect(button('noteTypes.deletion.apply')).toBeUndefined();
  expect(closed).toBe(0);
  await act(async () => button('noteTypes.deletion.refresh').click());
  expect(tokens).toHaveLength(1);
  await act(async () => button('noteTypes.deletion.apply').click());
  expect(tokens).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
});

test('lost delete response offers state reconciliation instead of reusing old consent', async () => {
  globalThis.fetch = (async (_url: any, init: any) => {
    if (init.method === 'DELETE') throw new TypeError('network_lost');
    return Response.json(impact);
  }) as typeof fetch;
  await render();
  await act(async () => button('noteTypes.deletion.apply').click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('noteTypes.deletion.checkState');
  expect(button('noteTypes.deletion.apply')).toBeUndefined();
  expect(button('noteTypes.convert.reload')).toBeDefined();
  expect(useNN.getState().noteTypes).toHaveLength(1);
});

test('JSON export downloads persisted notes before any deletion', async () => {
  const original = { notes: [{ id: 'orphan', fieldValues: { Q: 'Preserve this' } }], cards: [], reviews: [] };
  const requests: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push(`${init.method} ${url}`); return Response.json(String(url).includes('/profile/export') ? original : impact);
  }) as typeof fetch;
  let blob: Blob | undefined;
  const create = spyOn(URL, 'createObjectURL').mockImplementation(value => { blob = value as Blob; return 'blob:export'; });
  const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const click = spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    await render();
    await act(async () => button('noteTypes.deletion.export').click());
    expect(JSON.parse(await blob!.text())).toEqual(original);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:export');
    expect(requests.every(r => r.startsWith('GET'))).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('noteTypes.deletion.exported');
  } finally { create.mockRestore(); revoke.mockRestore(); click.mockRestore(); }
});

test('late previews after unmount do not revive the dialog', async () => {
  const response = Promise.withResolvers<Response>();
  globalThis.fetch = (async (_url: any, _init: any) => response.promise) as typeof fetch;
  await render();
  await act(async () => root.render(null));
  await act(async () => response.resolve(Response.json(impact)));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(closed).toBe(0);
});

test.each(['en', 'ru'])('complete impact numbers render in %s with an empty local card mirror', async locale => {
  const { I18nProvider } = await import('../lib/i18n');
  localStorage.removeItem('reomi:locale');
  const previous = localStorage.getItem('nn:locale');
  localStorage.setItem('nn:locale', locale);
  globalThis.fetch = (async (_url: any, _init: any) => Response.json(impact)) as typeof fetch;
  try {
    await act(async () => root.render(<I18nProvider><NoteTypeDeletionDialog type={type} onClose={() => {}} onPreserve={() => {}} /></I18nProvider>));
    const text = document.querySelector('[role="dialog"]')!.textContent!;
    expect(text).toContain('701'); expect(text).toContain('700'); expect(text).toContain('900');
    expect(text).toContain('Current server name');
    expect(text).not.toContain('noteTypes.');
  } finally {
    if (previous === null) localStorage.removeItem('nn:locale'); else localStorage.setItem('nn:locale', previous);
  }
});
