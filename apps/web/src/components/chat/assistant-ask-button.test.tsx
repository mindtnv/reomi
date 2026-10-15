import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { AssistantObjectRef } from '@reomi/shared';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { AssistantAskButton } = await import('./assistant-ask-button');
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });

test('object Ask carries an exact typed reference without submitting a surrounding editor form', async () => {
  let submitted = false;
  const intents: unknown[] = [];
  const listener = (event: Event) => intents.push((event as CustomEvent).detail);
  window.addEventListener('nn:assistant:ask', listener);
  try {
    for (const kind of ['card', 'deck', 'source', 'notebook', 'written_note', 'artifact'] as const) {
      const object: AssistantObjectRef = { kind, id: '01900000-0000-7000-8000-000000000001' };
      await act(async () => root.render(<form onSubmit={event => { event.preventDefault(); submitted = true; }}>
        <AssistantAskButton object={object} compact />
      </form>));
      const button = host.querySelector('button')!;
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-label')).toBeTruthy();
      await act(async () => button.click());
      expect(intents.at(-1)).toEqual({ ref: object });
    }
    expect(submitted).toBe(false);
    expect(intents).toHaveLength(6);
  } finally { window.removeEventListener('nn:assistant:ask', listener); }
});
