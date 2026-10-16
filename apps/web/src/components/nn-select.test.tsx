import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, expect, test } from 'bun:test';
import React, { act, useState } from 'react';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNSelect } = await import('./nn-select');

afterAll(() => {
  try { GlobalRegistrator.unregister(); } catch { /* already unregistered */ }
});

const formatOptions = [
  { value: 'all', label: 'All' },
  { value: 'pdf', label: 'PDF' },
  { value: 'epub', label: 'EPUB' },
];

async function renderSelect(parent: ParentNode, props: Partial<React.ComponentProps<typeof NNSelect>> = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const mount = document.createElement('div');
  parent.appendChild(mount);
  const root = createRoot(mount);
  await act(async () => {
    root.render(<NNSelect ariaLabel="Format" value="pdf" onChange={() => {}} options={formatOptions} {...props} />);
  });
  const trigger = mount.querySelector('button')!;
  return { root, mount, trigger };
}

async function openSelect(parent: ParentNode, props?: Partial<React.ComponentProps<typeof NNSelect>>) {
  const rendered = await renderSelect(parent, props);
  await act(async () => { rendered.trigger.click(); });
  const listId = rendered.trigger.getAttribute('aria-controls');
  const list = listId ? document.getElementById(listId) : null;
  return { ...rendered, list };
}

function key(node: Element, keyName: string) {
  node.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
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

test('the option list renders inside a role=dialog that owns the trigger', async () => {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.appendChild(dialog);
  const { root, list } = await openSelect(dialog);
  expect(list?.closest('.reomi-select-popover')?.parentElement).toBe(dialog);
  await act(async () => root.unmount());
  dialog.remove();
});

test('the closed trigger name includes the visible value', async () => {
  const { root, mount, trigger } = await renderSelect(document.body);
  expect(trigger.getAttribute('aria-label')).toBe('Format, PDF');
  expect(trigger.textContent).toContain('PDF');
  await act(async () => root.unmount());
  mount.remove();
});

test('a short listbox is the focused node and exposes the active option', async () => {
  const { root, mount, list } = await openSelect(document.body);
  expect(list?.getAttribute('role')).toBe('listbox');
  expect(document.activeElement).toBe(list);
  const active = document.getElementById(list?.getAttribute('aria-activedescendant') ?? '');
  expect(active?.textContent).toContain('PDF');
  await act(async () => root.unmount());
  mount.remove();
});

test('Enter on a disabled placeholder does not select the first field', async () => {
  const picked: string[] = [];
  const options = [
    { value: '-1', label: 'Choose a field', disabled: true },
    { value: '0', label: 'Front' },
    { value: '1', label: 'Back' },
  ];
  const { root, mount, list } = await openSelect(document.body, {
    ariaLabel: 'Answer', value: '-1', options, onChange: (value) => picked.push(value),
  });
  await act(async () => { key(list!, 'Enter'); });
  expect(picked).toEqual([]);
  await act(async () => { key(list!, 'ArrowDown'); });
  await act(async () => { key(list!, 'Enter'); });
  expect(picked).toEqual(['0']);
  await act(async () => root.unmount());
  mount.remove();
});

test('Space selects the highlighted option and letters jump to a matching option', async () => {
  const picked: string[] = [];
  const { root, mount, list } = await openSelect(document.body, { onChange: (value) => picked.push(value) });
  await act(async () => { key(list!, 'e'); });
  const active = document.getElementById(list?.getAttribute('aria-activedescendant') ?? '');
  expect(active?.textContent).toContain('EPUB');
  await act(async () => { key(list!, ' '); });
  expect(picked).toEqual(['epub']);
  await act(async () => root.unmount());
  mount.remove();
});

test('ArrowUp, Home, and End open a closed menu', async () => {
  const { root, mount, trigger } = await renderSelect(document.body);
  await act(async () => { key(trigger, 'ArrowUp'); });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  await act(async () => { key(document.activeElement!, 'Escape'); });
  await act(async () => { key(trigger, 'Home'); });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  await act(async () => { key(document.activeElement!, 'Escape'); });
  await act(async () => { key(trigger, 'End'); });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  await act(async () => root.unmount());
  mount.remove();
});

test('Tab from an open menu stays inside the dialog', async () => {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.appendChild(dialog);
  const { root, mount, list } = await openSelect(dialog);
  const after = document.createElement('button');
  after.textContent = 'After';
  dialog.appendChild(after);
  await act(async () => { key(list!, 'Tab'); });
  expect(document.activeElement).toBe(after);
  expect(dialog.isConnected).toBe(true);
  expect(document.querySelector('.reomi-select-popover')).toBeNull();
  await act(async () => root.unmount());
  dialog.remove();
});

test('an outside click closes the menu and leaves the dialog open', async () => {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const backdrop = document.createElement('div');
  let backdropClicks = 0;
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) backdropClicks += 1; });
  backdrop.append(dialog);
  document.body.appendChild(backdrop);
  const { root, list } = await openSelect(dialog);
  expect(list).toBeTruthy();
  await act(async () => {
    backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  });
  expect(backdropClicks).toBe(0);
  expect(document.querySelector('.reomi-select-popover')).toBeNull();
  expect(dialog.isConnected).toBe(true);
  await act(async () => root.unmount());
  backdrop.remove();
});

test('opening the menu calls showPopover', async () => {
  const original = HTMLElement.prototype.showPopover;
  HTMLElement.prototype.showPopover = function showPopover(this: HTMLElement) {
    this.setAttribute('data-popover-open', 'true');
  };
  try {
    const { root, mount, list } = await openSelect(document.body);
    expect(list?.closest('.reomi-select-popover')?.getAttribute('data-popover-open')).toBe('true');
    await act(async () => root.unmount());
    mount.remove();
  } finally {
    HTMLElement.prototype.showPopover = original;
  }
});

test('a failed showPopover keeps the menu visible', async () => {
  const original = HTMLElement.prototype.showPopover;
  HTMLElement.prototype.showPopover = function showPopover() {
    throw new Error('no top layer');
  };
  try {
    const { root, mount, list } = await openSelect(document.body);
    const popover = list?.closest('.reomi-select-popover');
    expect(popover?.hasAttribute('popover')).toBe(false);
    expect(popover?.textContent).toContain('PDF');
    await act(async () => root.unmount());
    mount.remove();
  } finally {
    HTMLElement.prototype.showPopover = original;
  }
});

test('a missing showPopover keeps the menu visible', async () => {
  const original = HTMLElement.prototype.showPopover;
  delete (HTMLElement.prototype as { showPopover?: () => void }).showPopover;
  try {
    const { root, mount, list } = await openSelect(document.body);
    const popover = list?.closest('.reomi-select-popover');
    expect(popover?.hasAttribute('popover')).toBe(false);
    expect(popover?.textContent).toContain('PDF');
    await act(async () => root.unmount());
    mount.remove();
  } finally {
    HTMLElement.prototype.showPopover = original;
  }
});

function DialogHarness() {
  const [open, setOpen] = useState(true);
  const [placement, setPlacement] = useState('inside');
  if (!open) return <p>dialog-closed</p>;
  return (
    <div role="dialog" aria-label="Move">
      <NNSelect ariaLabel="Destination" value={placement} onChange={setPlacement} options={[{ value: 'inside', label: 'Inside' }, { value: 'before', label: 'Before' }]} />
      <button type="button" onClick={() => setOpen(false)}>Close dialog</button>
    </div>
  );
}

test('choosing an option does not close the parent dialog', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const root = createRoot(mount);
  await act(async () => { root.render(<DialogHarness />); });
  const trigger = mount.querySelector<HTMLButtonElement>('button.reomi-select')!;
  expect(trigger.getAttribute('aria-label')).toBe('Destination, Inside');
  await act(async () => { trigger.click(); });
  await act(async () => {
    Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent === 'Before')!.click();
  });
  expect(mount.textContent).toContain('Before');
  expect(mount.textContent).not.toContain('dialog-closed');
  await act(async () => root.unmount());
  mount.remove();
});
