import { ensureTestDom } from '../lib/test-dom-setup';
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { I18nProvider } from '../lib/i18n';
import { writeBrowserValue } from '../lib/storage-migration';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { ReminderSettings } = await import('./reminder-settings');

let root: Root;
let container: HTMLDivElement;

afterEach(() => { root?.unmount(); container?.remove(); });

async function render(locale: 'en' | 'ru', props: React.ComponentProps<typeof ReminderSettings>) {
  localStorage.clear();
  localStorage.setItem('nn:locale', locale);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<I18nProvider><ReminderSettings {...props} /></I18nProvider>); });
  await act(async () => { await Promise.resolve(); });
}

describe('reminder settings', () => {
  for (const locale of ['en', 'ru'] as const) {
    test(`${locale} saves the server choice and keeps the local flag local`, async () => {
      const saved: unknown[] = [];
      const permissions: string[] = [];
      writeBrowserValue(localStorage, 'nn:notifications:enabled', 'true');
      await render(locale, {
        load: async () => ({ saved: false, vapidPublicKey: null, emailEnabled: false, pushEnabled: false }),
        save: async (choice) => { saved.push(choice); },
        requestPermission: async () => { permissions.push('asked'); return 'granted'; },
      });
      const text = container.textContent ?? '';
      if (locale === 'en') {
        expect(text).toContain('Local notification on this device when you open the app.');
        expect(text.toLowerCase()).not.toContain('background');
      } else {
        expect(text).toContain('Локальное уведомление на этом устройстве при открытии приложения.');
        expect(text).not.toContain('фон');
      }
      expect(text).toContain(locale === 'en' ? 'Push is not configured on this server.' : 'Push на этом сервере не настроен.');
      expect(saved).toHaveLength(0);
      expect(permissions).toHaveLength(0);
      const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      await act(async () => { boxes[0]!.click(); });
      const save = [...container.querySelectorAll('button')].find((button) => /Save reminders|Сохранить напоминания/.test(button.textContent ?? ''));
      await act(async () => { save!.click(); });
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ digestEnabled: true, emailEnabled: false, pushEnabled: false });
      expect(permissions).toHaveLength(0);
    });
  }

  test('notification permission is requested only from the push button', async () => {
    const permissions: string[] = [];
    const subscribed: string[] = [];
    await render('en', {
      load: async () => ({ saved: false, vapidPublicKey: 'public-key' }),
      save: async () => undefined,
      requestPermission: async () => { permissions.push('asked'); return 'granted'; },
      subscribe: async (key) => { subscribed.push(key); },
    });
    expect(permissions).toHaveLength(0);
    const push = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Allow push on this device');
    await act(async () => { push!.click(); });
    expect(permissions).toEqual(['asked']);
    expect(subscribed).toEqual(['public-key']);
  });
});
