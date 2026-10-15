import { ensureTestDom } from '@/lib/test-dom-setup';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { CARD_COLUMNS } from '@/lib/card-columns';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { CardColumnPicker } = await import('./card-column-picker');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  ensureTestDom();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('nn:locale', 'en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.querySelector('.reomi-column-picker')?.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

test('column checks are painted boxes and question stays required', async () => {
  let selected = ['question', 'answer'];
  await act(async () => root.render(
    <I18nProvider>
      <CardColumnPicker selected={selected} onChange={ids => { selected = ids; }} onReset={() => { selected = ['question']; }} />
    </I18nProvider>,
  ));
  await act(async () => host.querySelector('button')!.click());
  const panel = document.querySelector('.reomi-column-picker')!;
  expect(panel.querySelectorAll('input[type="checkbox"]:not(.reomi-check-input)').length).toBe(0);
  expect(panel.querySelectorAll('.reomi-check-box').length).toBe(CARD_COLUMNS.length);
  const question = [...panel.querySelectorAll('label')].find(label => label.textContent?.includes('Question'))!;
  expect(question.querySelector('input')!.disabled).toBe(true);
  expect(question.querySelector('.reomi-check-box')!.getAttribute('data-checked')).toBe('true');
  expect(question.textContent).toContain('Required');
  const answer = [...panel.querySelectorAll('label')].find(label => label.textContent?.includes('Answer'))!;
  await act(async () => answer.querySelector('input')!.click());
  expect(selected).toEqual(['question']);
});
