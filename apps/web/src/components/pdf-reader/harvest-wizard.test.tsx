import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { useNN } from '../../lib/store';
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { HarvestWizard } = await import('./harvest-wizard');
let root: Root, host: HTMLDivElement, originalFetch: typeof fetch;
const candidate = { origin: { kind: 'mark', markId: '01900000-0000-7000-8000-000000000001' }, page: 1,
  front: 'Initial question', back: 'Initial answer', quote: 'Original selection',
  evidence: { sourceVersion: '2026-09-21T00:00:00.000Z', originHash: 'a'.repeat(64) } };
const t = (key: string) => key;
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
  useNN.setState({ decks: [], profile: { userId: 'harvest-owner' } as any });
  localStorage.removeItem('nn:nb:quickdeck');
  localStorage.removeItem('reomi:nb:quickdeck');
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; useNN.getState().reset(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
const button = (key: string) => Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes(key))!;
async function editAndCreateDeck() {
  const front = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(front, 'My edited question');
    front.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('assistant.newDestinationDeck').click());
  const name = host.querySelector<HTMLInputElement>('input[maxlength="100"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'First deck');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  expect(host.querySelector('textarea')!.value).toBe('My edited question');
  await act(async () => button('notebooks.harvest.review').click());
}
for (const stale of [false, true]) test(stale ? 'stale harvest preserves edited candidates and explains how to regenerate' : 'a fresh collection creates its first deck inline and saves edited harvest candidates', async () => {
  let submitted: any, closed = false, applied = 0, generations = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).endsWith('/decks')) return Response.json({ id: 'first-deck', name: 'First deck', color: 'lime' });
    if (String(url).endsWith('/apply')) {
      submitted = JSON.parse(init.body);
      return stale ? Response.json({ error: 'harvest_evidence_stale' }, { status: 409 }) : Response.json({ created: 1, cardIds: ['card'] });
    }
    generations++; return Response.json({ candidates: [candidate] });
  }) as unknown as typeof fetch;
  await act(async () => root.render(<HarvestWizard open sourceId="source" onClose={() => { closed = true; }} onApplied={count => { applied = count; }} t={t} />));
  await editAndCreateDeck();
  const apply = button('notebooks.harvest.apply'); expect(apply.disabled).toBe(false);
  await act(async () => { apply.click(); });
  expect(generations).toBe(1);
  expect(submitted).toMatchObject({ deckId: 'first-deck', cards: [{ ...candidate, front: 'My edited question' }] });
  if (stale) {
    expect(closed).toBe(false); expect(applied).toBe(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('notebooks.harvest.stale');
    await act(async () => button('notebooks.harvest.back').click());
    expect(host.querySelector('textarea')!.value).toBe('My edited question');
  } else { expect(closed).toBe(true); expect(applied).toBe(1); }
});
