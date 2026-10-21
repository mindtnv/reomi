import { ensureTestDom } from '@/lib/test-dom-setup';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { DialogProvider } from './dialog';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { McpSettings } = await import('./mcp-settings');

let host: HTMLDivElement;
let root: Root;
let originalFetch: typeof fetch;
let languageDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  ensureTestDom();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  languageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'language');
  Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'ru-RU' });
  localStorage.setItem('reomi:locale', 'en');
  localStorage.setItem('nn:locale', 'en');
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json([])) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  globalThis.fetch = originalFetch;
  if (languageDescriptor) Object.defineProperty(navigator, 'language', languageDescriptor);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

test('app access offers scoped credentials and a separate agent disclosure', async () => {
  await act(async () => root.render(<I18nProvider><DialogProvider><McpSettings /></DialogProvider></I18nProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.querySelectorAll('select').length).toBe(0);
  expect(host.querySelectorAll('details').length).toBe(0);
  const name = host.querySelector<HTMLInputElement>('input.reomi-input')!;
  expect(name.placeholder).toBe('Codex / Claude');
  const groups = host.querySelectorAll('[role="radiogroup"]');
  expect(groups).toHaveLength(1);
  expect(groups[0].textContent).toContain('90 days');
  const permissions = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
  expect(permissions.textContent).toContain('Read only');
  await act(async () => permissions.click());
  const capture = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('Browser capture'))!;
  await act(async () => capture.click());
  expect(host.textContent).toContain('Paste this token into the Reomi extension');
  const connect = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Connect an agent'))!;
  expect(connect.textContent).toContain('Connect an agent');
  await act(async () => connect.click());
  expect(connect.getAttribute('aria-expanded')).toBe('true');
  expect(host.textContent).toContain('Copy MCP URL');
});
