import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNSelect } = await import('./nn-select');

afterAll(() => {
  try { GlobalRegistrator.unregister(); } catch { /* already unregistered */ }
});

async function openSelect(parent: ParentNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const mount = document.createElement('div');
  parent.appendChild(mount);
  const root = createRoot(mount);
  await act(async () => {
    root.render(<NNSelect ariaLabel="Choice" value="all" onChange={() => {}} options={[{ value: 'all', label: 'All' }, { value: 'pdf', label: 'PDF' }]} />);
  });
  const trigger = mount.querySelector('button')!;
  await act(async () => { trigger.click(); });
  const listId = trigger.getAttribute('aria-controls');
  const list = listId ? document.getElementById(listId) : null;
  return { root, mount, list };
}

test('the option list renders in document.body outside a dialog', async () => {
  const { root, mount, list } = await openSelect(document.body);
  expect(list?.closest('.reomi-select-popover')?.parentElement?.tagName).toBe('BODY');
  await act(async () => root.unmount());
  mount.remove();
});

test('the option list renders inside the dialog that owns the trigger', async () => {
  const dialog = document.createElement('dialog');
  document.body.appendChild(dialog);
  dialog.open = true;
  const { root, list } = await openSelect(dialog);
  expect(list?.closest('.reomi-select-popover')?.parentElement).toBe(dialog);
  await act(async () => root.unmount());
  dialog.remove();
});
