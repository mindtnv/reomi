import { ensureTestDom } from '@/lib/test-dom-setup';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import type { Root } from 'react-dom/client';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { Button, Field, SegmentedControl, Surface, TextInput } = await import('./primitives');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

test('a busy action cannot be submitted twice and exposes its loading label', async () => {
  let calls = 0;
  await act(async () => root.render(<Button loading loadingLabel="Saving" onClick={() => calls++}>Save</Button>));
  const button = host.querySelector('button')!;
  button.click();
  expect(calls).toBe(0);
  expect(button.disabled).toBe(true);
  expect(button.getAttribute('aria-busy')).toBe('true');
  expect(button.getAttribute('aria-label')).toBe('Saving');
  expect(host.querySelector('.reomi-button-content')?.textContent).toBe('Save');
});

test('field label, help and validation error reference the actual input', async () => {
  await act(async () => root.render(<Field label="Title" description="Your topic" error="Required"><TextInput id="topic" aria-describedby="external-help" /></Field>));
  const input = host.querySelector('input')!;
  expect(host.querySelector('label')?.htmlFor).toBe('topic');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.getAttribute('aria-describedby')).toBe('external-help topic-help topic-error');
  expect(host.querySelector('#topic-error')?.getAttribute('role')).toBe('alert');
});

test('segmented selection skips disabled options and moves keyboard focus', async () => {
  function Example() { const [value, setValue] = useState('a'); return <SegmentedControl label="View" value={value} onChange={setValue} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }]} />; }
  await act(async () => root.render(<Example />));
  const buttons = host.querySelectorAll('button');
  buttons[0].focus();
  await act(async () => buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(buttons[2].getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(buttons[2]);
  expect(buttons[0].tabIndex).toBe(-1);
  await act(async () => buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(buttons[0].getAttribute('aria-checked')).toBe('true');
});

test('an interactive surface activates with Enter, without inventing an action on passive surfaces', async () => {
  let calls = 0;
  await act(async () => root.render(<><Surface onClick={() => calls++}>Open</Surface><Surface>Read</Surface></>));
  const surfaces = host.querySelectorAll<HTMLDivElement>('.reomi-surface');
  expect(surfaces[0].getAttribute('role')).toBe('button');
  expect(surfaces[1].hasAttribute('tabindex')).toBe(false);
  await act(async () => surfaces[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(calls).toBe(1);
});
