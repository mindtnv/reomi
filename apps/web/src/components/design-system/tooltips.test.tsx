import { ensureTestDom } from '@/lib/test-dom-setup';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { Tooltips } = await import('./tooltips');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  ensureTestDom();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render() {
  await act(async () => root.render(<><Tooltips /><a href="/home" data-tooltip="Home">Home</a></>));
  return host.querySelector('a')!;
}

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
}

test('activating a control with the pointer does not leave its tooltip open', async () => {
  const link = await render();
  await act(async () => {
    link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
  await settle();
  expect(document.querySelectorAll('[role="tooltip"]').length).toBe(0);
});

test('keyboard focus still shows the tooltip', async () => {
  const link = await render();
  await act(async () => { link.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
  await settle();
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Home');
});
