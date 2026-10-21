import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { librarySmokeSession } from './library-smoke-session';

test('documentation preview, collection controls and compact source reading', async ({ page }) => {
  test.skip(process.env.E2E_TARGET === 'prod', 'Deterministic documentation UI fixtures are local-only; domain import is covered by API integration tests.');
  const { api } = await librarySmokeSession(page);
  await page.addInitScript(() => { localStorage.setItem('reomi:locale', 'en'); localStorage.setItem('reomi:theme', JSON.stringify({ version: 2, mode: 'light', palette: 'default' })); });
  const collectionId = '01900000-0000-7000-8000-000000000071';
  let collection: Record<string, unknown> | null = null, selected: string[] = [], folderId: string | undefined;
  const sourceIds: string[] = [], folderIds: string[] = [];
  // Browser fixtures isolate remote discovery from network availability. The API
  // suite exercises the real durable worker and guarded HTTP-fetch seam.
  await page.route('**/library/documentation**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'DELETE') { collection = null; return route.fulfill({ json: { ok: true } }); }
    if (path.endsWith('/preview')) return route.fulfill({ json: {
      id: collectionId, rootUrl: 'https://kubernetes.io/docs/', title: 'Kubernetes', locale: 'en', total: 4, available: 10,
      expiresAt: new Date(Date.now() + 600000).toISOString(), sections: [
        { prefix: '/docs/', parent: null, title: 'docs', pageCount: 4, newPageCount: 4, reference: false },
        { prefix: '/docs/concepts/', parent: '/docs/', title: 'concepts', pageCount: 2, newPageCount: 2, reference: false },
        { prefix: '/docs/concepts/workloads/', parent: '/docs/concepts/', title: 'workloads', pageCount: 2, newPageCount: 2, reference: false },
        { prefix: '/docs/tasks/', parent: '/docs/', title: 'tasks', pageCount: 1, newPageCount: 1, reference: false },
        { prefix: '/docs/reference/', parent: '/docs/', title: 'reference', pageCount: 1, newPageCount: 1, reference: true },
      ],
    } });
    if (path.endsWith('/confirm')) {
      selected = route.request().postDataJSON().prefixes;
      const root = await page.request.post(`${api}/library/folders`, { data: { name: 'Kubernetes documentation' } });
      expect(root.ok()).toBe(true); folderId = (await root.json()).id; folderIds.push(folderId!);
      const child = await page.request.post(`${api}/library/folders`, { data: { name: 'Workloads', parentId: folderId } });
      const childId = (await child.json()).id; folderIds.push(childId);
      for (const title of ['Pods', 'Deployments']) {
        const response = await page.request.post(`${api}/library/items`, { data: { kind: 'text', title, folderId: childId,
          text: `${title}\n\nKubernetes manages containerized workloads. This saved material remains readable independently of a notebook.` } });
        expect(response.ok()).toBe(true); sourceIds.push((await response.json()).id);
      }
      collection = { id: collectionId, rootUrl: 'https://kubernetes.io/docs/', title: 'Kubernetes', locale: 'en', folderId,
        state: 'completed', total: 2, completed: 2, pending: 0, failed: 0, deleted: 0, errorCode: null,
        checkedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), schedule: 'off', nextSyncAt: null,
        checking: false, syncError: null, lastResult: { added: 2, updated: 0, unchanged: 0, failed: 0, missing: 0, completedAt: new Date().toISOString() } };
      return route.fulfill({ json: collection });
    }
    if (path.endsWith('/updates')) { collection = { ...collection, state: 'running', pending: 2, completed: 0 }; return route.fulfill({ json: collection }); }
    if (path.endsWith('/schedule')) { const schedule = route.request().postDataJSON().schedule; collection = { ...collection, schedule, nextSyncAt: schedule === 'off' ? null : new Date(Date.now() + 86_400_000).toISOString() }; return route.fulfill({ json: collection }); }
    if (path.endsWith('/cancel')) { collection = { ...collection, state: 'cancelled' }; return route.fulfill({ json: collection }); }
    return route.fulfill({ json: { items: collection ? [collection] : [] } });
  });
  async function shot(name: string) {
    const dir = process.env.E2E_EVIDENCE_DIR ?? join(process.cwd(), 'e2e/artifacts'); mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `library-documentation-${name}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  try {
    await page.goto('/library');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Connect documentation', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect documentation', exact: true });
    await dialog.getByRole('textbox', { name: 'Documentation URL' }).fill('https://kubernetes.io/docs/home/');
    await dialog.getByRole('button', { name: 'Find sections', exact: true }).click();
    await expect(dialog.getByText('https://kubernetes.io/docs/', { exact: true })).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'tasks', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(dialog.getByRole('checkbox', { name: 'tasks', exact: true })).not.toBeChecked();
    await expect(dialog).toContainText('2 selected. 2 new materials');
    await dialog.getByRole('button', { name: 'Expand concepts', exact: true }).click();
    await shot('preview-desktop-light');
    await page.setViewportSize({ width: 390, height: 844 }); await shot('preview-mobile-light');
    await page.setViewportSize({ width: 1280, height: 800 });
    await dialog.getByRole('button', { name: 'Add to library', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(selected).toContain('/docs/concepts/'); expect(selected).toContain('!/docs/tasks/');
    await expect(page.locator('.nn-lib-row').filter({ hasText: 'Pods' })).toBeVisible();
    await expect(page.locator('.nn-lib-grid')).toHaveCount(0);
    const schedule = page.getByRole('button', { name: 'Auto-update: Kubernetes' });
    await schedule.focus(); await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await expect(schedule).toContainText('Every day');
    await expect(page.getByText(/^Next check:/)).toBeVisible();
    await shot('collection-desktop-light');
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await expect(page.getByRole('progressbar', { name: 'Import progress' })).toBeVisible();
    await shot('progress-desktop-light');
    await page.getByRole('button', { name: 'Stop import', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume import', exact: true })).toBeVisible();
    await page.locator('.nn-lib-row').filter({ hasText: 'Pods' }).click();
    await expect(page).toHaveURL(new RegExp(`/library/${sourceIds[0]}`));
    await expect(page.getByText('Kubernetes manages containerized workloads.', { exact: false }).first()).toBeVisible();
    await page.goto('/library');
    await page.addInitScript(() => {
      const native = window.matchMedia.bind(window);
      window.matchMedia = query => { const result = native(query); if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: true }); return result; };
      localStorage.setItem('reomi:locale', 'ru'); localStorage.setItem('reomi:theme', JSON.stringify({ version: 2, mode: 'dark', palette: 'default' }));
    });
    await page.reload(); await expect(page.getByRole('button', { name: 'Продолжить импорт', exact: true })).toBeVisible();
    await shot('standalone-desktop-dark-ru');
    await page.setViewportSize({ width: 320, height: 740 }); await shot('standalone-small-dark-ru');
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await page.getByRole('button', { name: 'Подключить документацию', exact: true }).click();
    const ruDialog = page.getByRole('dialog', { name: 'Подключить документацию', exact: true });
    await ruDialog.getByRole('textbox', { name: 'Адрес документации' }).fill('https://kubernetes.io/docs/home/');
    await ruDialog.getByRole('button', { name: 'Найти разделы', exact: true }).click();
    await expect(ruDialog.getByRole('checkbox', { name: 'concepts', exact: true })).toBeVisible();
    await shot('preview-standalone-small-dark-ru');
    await page.keyboard.press('Escape'); await expect(ruDialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Отключить документацию', exact: true }).click();
    const disconnect = page.getByRole('dialog', { name: 'Отключить документацию', exact: true });
    await expect(disconnect).toContainText('останутся в библиотеке');
    await disconnect.getByRole('button', { name: 'Отключить документацию', exact: true }).click();
    await expect(page.locator('.reomi-doc-connections')).toHaveCount(0);
    expect((await page.request.get(`${api}/library/items/${sourceIds[0]}`)).ok()).toBe(true);
  } finally {
    for (const id of sourceIds) await page.request.delete(`${api}/library/items/${id}`);
    for (const id of folderIds.reverse()) {
      const preview = await page.request.get(`${api}/library/folders/${id}/delete-preview`);
      if (preview.ok()) await page.request.delete(`${api}/library/folders/${id}`, { data: { confirmationToken: (await preview.json()).confirmationToken } });
    }
  }
});
