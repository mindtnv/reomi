import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { PlanModuleList } = await import('./chat-presentation');
const { I18nProvider, useT } = await import('../../lib/i18n');
const { topicPlanCardRows } = await import('../../lib/topic-plan-card');

let root: Root;
let host: HTMLDivElement;

const proposal = {
  modules: [
    {
      title: 'Ownership',
      outcome: 'Explain who owns a value.',
      urls: [],
      needsPages: true,
    },
    {
      title: 'Borrowing',
      outcome: 'Share a value for a while.',
      urls: ['https://docs.example.com/learn/borrowing'],
    },
  ],
};

function Card() {
  const t = useT();
  const rows = topicPlanCardRows(proposal);
  if (!rows) return null;
  return <PlanModuleList rows={rows} t={t} />;
}

beforeEach(() => {
  ensureTestDom();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.removeItem('reomi:locale');
  localStorage.removeItem('nn:locale');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.removeItem('reomi:locale');
  localStorage.removeItem('nn:locale');
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

afterAll(() => {
  try {
    GlobalRegistrator.unregister();
  } catch {
    /* already unregistered */
  }
});

test('a module that needs pages renders the missing-pages state', async () => {
  localStorage.setItem('reomi:locale', 'ru');
  await act(async () => {
    root.render(
      <I18nProvider>
        <Card />
      </I18nProvider>,
    );
  });

  const missing = host.querySelector('.reomi-plan-pages-missing');
  expect(missing).not.toBeNull();
  expect(missing?.classList.contains('reomi-tool-result-row')).toBe(false);
  expect(missing?.getAttribute('role')).toBeNull();
  expect(missing?.textContent).toContain('Ownership');
  expect(missing?.textContent).toContain('страницы не найдены');
  expect(missing?.textContent).not.toContain('Explain who owns a value.');

  const normal = host.querySelector('.reomi-tool-result-row');
  expect(normal?.textContent).toContain('Borrowing');
  expect(normal?.textContent).toContain('Share a value for a while.');
  expect(normal?.querySelector('a')?.getAttribute('href')).toBe('https://docs.example.com/learn/borrowing');
});
