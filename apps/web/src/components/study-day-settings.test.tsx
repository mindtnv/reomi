import { ensureTestDom } from '../lib/test-dom-setup';
import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { I18nProvider } from '../lib/i18n';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { StudyDaySettings } = await import('./study-day-settings');

let root: Root;
let container: HTMLDivElement;

afterEach(() => { root?.unmount(); container?.remove(); });

const open = {
  legacy: false,
  zone: 'Asia/Tokyo',
  rolloverMinute: 0,
  label: '2026-10-15',
  startsAt: '2026-10-15T00:00:00.000Z',
  endsAt: '2026-10-16T00:00:00.000Z',
  usedNew: 1,
  usedReviews: 2,
  todayMinutes: 4,
  takesEffectAt: '2026-10-16T00:00:00.000Z',
};

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function render(locale: 'en' | 'ru', props: React.ComponentProps<typeof StudyDaySettings>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('nn:locale', locale);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<I18nProvider><StudyDaySettings {...props} /></I18nProvider>); });
}

test('the form stays blank until the study-day response arrives', async () => {
  let release: (value: unknown) => void = () => undefined;
  const pending = new Promise((resolve) => { release = resolve; });
  await render('en', { load: () => pending, save: async () => open });
  expect(container.querySelector('input')).toBeNull();
  expect(container.textContent).toContain('Loading study day');
  expect(container.textContent).not.toContain('Asia/Tokyo');
  await act(async () => { release(open); });
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Time zone"]')?.value).toBe('Asia/Tokyo');
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Rollover minute"]')?.value).toBe('0');
  expect(container.textContent).toContain('The saved zone starts at');
  expect(container.textContent).toContain('2026');
});

test('save and reset send the study-day body, not a browser zone', async () => {
  const saved: unknown[] = [];
  await render('en', {
    load: async () => ({ ...open, legacy: true, zone: 'UTC', rolloverMinute: 0, takesEffectAt: null }),
    save: async (body) => {
      saved.push(body);
      if (body.timeZone == null) return { ...open, legacy: true, zone: 'UTC', rolloverMinute: 0, takesEffectAt: null };
      return { ...open, zone: body.timeZone, rolloverMinute: body.rolloverMinute, takesEffectAt: '2026-10-16T00:00:00.000Z' };
    },
  });
  await act(async () => { await Promise.resolve(); });
  const zone = container.querySelector<HTMLInputElement>('input[aria-label="Time zone"]')!;
  const minute = container.querySelector<HTMLInputElement>('input[aria-label="Rollover minute"]')!;
  expect(zone.value).toBe('UTC');
  expect(container.textContent).toContain('This account still uses UTC midnight.');
  await act(async () => {
    typeInto(zone, 'Asia/Tokyo');
    typeInto(minute, '90');
  });
  const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save study day');
  expect(save?.className).toContain('reomi-button');
  expect(zone.classList.contains('reomi-input')).toBe(true);
  await act(async () => { save!.click(); });
  expect(saved[0]).toEqual({ timeZone: 'Asia/Tokyo', rolloverMinute: 90 });
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Time zone"]')?.value).toBe('Asia/Tokyo');
  const reset = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Use UTC midnight');
  await act(async () => { reset!.click(); });
  expect(saved[1]).toEqual({ timeZone: null, rolloverMinute: null });
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Time zone"]')?.value).toBe('UTC');
});

test('a Russian learning section names the study day', async () => {
  await render('ru', { load: async () => open, save: async () => open });
  await act(async () => { await Promise.resolve(); });
  expect(container.textContent).toContain('Сохранённый пояс начнётся');
  expect(container.querySelector('input[aria-label="Часовой пояс"]')).not.toBeNull();
  expect(container.textContent).toContain('Ноль задаёт местную полночь. 90 задаёт 1:30.');
});
