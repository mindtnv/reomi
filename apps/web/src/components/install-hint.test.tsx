import { ensureTestDom } from '../lib/test-dom-setup';
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { I18nProvider } from '../lib/i18n';
import { readBrowserValue } from '../lib/storage-migration';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { InstallHint } = await import('./install-hint');

let root: Root;
let container: HTMLDivElement;

afterEach(() => { root?.unmount(); container?.remove(); localStorage.clear(); });

async function render(props: React.ComponentProps<typeof InstallHint>) {
  localStorage.setItem('nn:locale', 'en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<I18nProvider><InstallHint {...props} /></I18nProvider>); });
  await act(async () => { await Promise.resolve(); });
}

describe('install hint', () => {
  test('Chromium offers install only from beforeinstallprompt and remembers a dismissal', async () => {
    const prompts: number[] = [];
    await render({ mode: 'browser', platform: 'chromium', prompt: { prompt: async () => { prompts.push(1); } } });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const install = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Install Reomi');
    expect(install).toBeTruthy();
    await act(async () => { install!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(prompts).toEqual([1]);
    const dismiss = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Not now');
    await act(async () => { dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(readBrowserValue(localStorage, 'nn:pwa:install-dismissed')).toBe('1');
    expect(container.textContent).not.toContain('Install Reomi');
    root.unmount();
    container.remove();
    await render({ mode: 'browser', platform: 'chromium', prompt: { prompt: async () => undefined } });
    expect(container.textContent ?? '').not.toContain('Install Reomi');
  });

  test('iOS outside standalone explains Share and Add to Home Screen and keeps review', async () => {
    await render({ mode: 'browser', platform: 'ios', prompt: null });
    expect(container.textContent).toContain('Share');
    expect(container.textContent).toContain('Add to Home Screen');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/review');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test('standalone hides the hint', async () => {
    await render({ mode: 'standalone', platform: 'ios', prompt: { prompt: async () => undefined } });
    expect(container.textContent ?? '').toBe('');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test('another browser gets no dialog', async () => {
    await render({ mode: 'browser', platform: 'other', prompt: null });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent ?? '').toBe('');
  });
});
