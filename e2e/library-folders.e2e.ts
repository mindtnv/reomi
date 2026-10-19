import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { smokeTarget } from './smoke-target';
import { rememberSecret } from './secret-scan';

test('library folders preserve materials through nested, single and batch organization', async ({ page }) => {
  const target = smokeTarget(process.env);
  rememberSecret(target.password);
  const api = target.mode === 'prod' ? 'https://api.reomi.ru' : 'http://localhost:3000';
  const origin = target.mode === 'prod' ? 'https://app.reomi.ru' : 'http://localhost:3001';
  const credentials = target.mode === 'prod'
    ? { email: target.email, password: target.password }
    : { email: target.email, password: target.password, name: target.name };
  const login = await page.request.post(`${api}/api/auth/${target.mode === 'prod' ? 'sign-in' : 'sign-up'}/email`, { data: credentials, headers: { origin } });
  expect(login.ok()).toBe(true);
  const prefix = target.mode === 'prod' ? `${target.deckName} ` : '';
  const rootName = `${prefix}Research`, childName = `${prefix}Workloads`, destinationName = `${prefix}Reading list`;
  const folderIds: string[] = [], sourceIds: string[] = [];
  const folderNav = page.getByRole('navigation', { name: 'Library folders', exact: true });
  async function createFolder(name: string) {
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New folder', exact: true });
    await dialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill(name);
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/library/folders' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
    const response = await responsePromise; expect(response.ok()).toBe(true);
    const folder = await response.json() as { id: string };
    folderIds.push(folder.id);
    await expect(folderNav.locator('[aria-current="page"]')).toContainText(name);
    return folder.id;
  }
  async function chooseDestination(name: string) {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name, exact: true }).click();
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  async function shot(name: string) {
    if (target.mode === 'prod') return;
    const dir = process.env.E2E_EVIDENCE_DIR ?? join(process.cwd(), 'e2e/artifacts');
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `library-folders-${name}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator('.reomi-library-controls').evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return [...node.querySelectorAll('button,a')].every(control => {
        const rect = control.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      });
    })).toBe(true);
  }
  try {
    await page.goto('/library');
    await expect(folderNav.getByRole('button', { name: /^All materials/ })).toBeVisible();
    const rootId = await createFolder(rootName);
    await createFolder('2026-10-19');
    await shot('date-name');
    await page.locator('.reomi-folder-actions').getByRole('button', { name: 'Rename', exact: true }).click();
    const renameInput = page.getByRole('dialog').getByRole('textbox', { name: 'Folder name', exact: true });
    await renameInput.fill(childName);
    await renameInput.press('Enter');
    await expect(folderNav.locator('[aria-current="page"]')).toContainText(childName);
    for (const title of ['Pod lifecycle', 'Deployments', 'Services']) {
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('button', { name: 'Paste text', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add text', exact: true });
      await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(`${prefix}${title}`);
      await dialog.getByRole('textbox', { name: 'Text', exact: true }).fill(`${title}\n\nKubernetes manages container workloads. Each resource has a defined lifecycle and a desired state.`);
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/library/items' && response.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      const response = await responsePromise; expect(response.ok()).toBe(true);
      sourceIds.push((await response.json() as { id: string }).id);
      await expect(page.getByRole('checkbox', { name: `Select material: ${prefix}${title}`, exact: true })).toBeVisible();
    }
    await folderNav.getByRole('button', { name: /^All materials/ }).click();
    const destinationId = await createFolder(destinationName);
    await folderNav.getByRole('button', { name: new RegExp(`^${childName}`) }).click();
    await page.getByRole('button', { name: `Move material: ${prefix}Pod lifecycle`, exact: true }).click();
    await chooseDestination(destinationName);
    await expect(page.getByRole('checkbox', { name: `Select material: ${prefix}Pod lifecycle`, exact: true })).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Select all shown', exact: true }).check();
    await page.locator('.reomi-library-selection').getByRole('button', { name: 'Move', exact: true }).click();
    await chooseDestination(destinationName);
    await expect(page.locator('.reomi-library-selection')).toHaveCount(0);
    await folderNav.getByRole('button', { name: new RegExp(`^${rootName}`) }).click();
    await page.locator('.reomi-folder-actions').getByRole('button', { name: 'Move', exact: true }).click();
    const moveResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/library/folders/${rootId}` && response.request().method() === 'PATCH');
    await chooseDestination(destinationName);
    expect((await moveResponse).ok()).toBe(true);
    const tree = await (await page.request.get(`${api}/library/folders`)).json() as { items: { id: string; parentId: string | null }[] };
    expect(tree.items.find(folder => folder.id === rootId)?.parentId).toBe(destinationId);
    await folderNav.getByRole('button', { name: new RegExp(`^${destinationName}`) }).click();
    await page.reload();
    await expect(folderNav.locator('[aria-current="page"]')).toContainText(destinationName);
    await expect(page.getByRole('checkbox', { name: /^Select material:/ })).toHaveCount(3);
    await expect(page.getByRole('button', { name: /^Format,/ })).toBeHidden();
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Format,/ })).toBeVisible();
    await shot('desktop-filters');
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await shot('desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Folders', exact: true })).toBeVisible();
    expect(await page.locator('.reomi-library-toolbar').evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(120);
    await shot('mobile');
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Sort,/ })).toBeVisible();
    await shot('mobile-filters');
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.getByRole('button', { name: 'Folders', exact: true }).click();
    await shot('mobile-tree');
    await page.getByRole('button', { name: 'Folders', exact: true }).click();
    await page.addInitScript(() => {
      const native = window.matchMedia.bind(window);
      window.matchMedia = query => {
        const result = native(query);
        if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: true });
        return result;
      };
    });
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Folder path' })).toContainText(destinationName);
    await shot('standalone-mobile');
    if (target.mode === 'local') {
      await page.evaluate(() => localStorage.setItem('reomi:locale', 'ru'));
      await page.reload();
      await expect(page.getByRole('button', { name: 'Фильтры', exact: true })).toBeVisible();
      await shot('standalone-mobile-ru');
      await page.setViewportSize({ width: 320, height: 740 });
      await shot('small-mobile-ru');
      await page.evaluate(() => localStorage.setItem('reomi:locale', 'en'));
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await expect(folderNav.locator('[aria-current="page"]')).toContainText(destinationName);
    await shot('standalone-desktop');
    await page.locator('.reomi-folder-actions').getByRole('button', { name: 'Delete folder', exact: true }).click();
    const destinationDialog = page.getByRole('dialog', { name: 'Where should the materials go?', exact: true });
    await expect(destinationDialog).toContainText('3 materials');
    await destinationDialog.getByRole('button', { name: 'Move', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Delete folder', exact: true });
    await expect(confirmation).toContainText(destinationName);
    await confirmation.getByRole('button', { name: 'Delete folder', exact: true }).click();
    await expect(folderNav.getByRole('button', { name: new RegExp(`^${destinationName}`) })).toHaveCount(0);
    for (const id of sourceIds) {
      const source = await (await page.request.get(`${api}/library/items/${id}`)).json() as { id: string; folderId: string | null };
      expect(source.id).toBe(id); expect(source.folderId).toBeNull();
    }
  } finally {
    // Clean only fixtures created by this walk. Folder cleanup always keeps sources.
    for (const id of sourceIds) await page.request.delete(`${api}/library/items/${id}`);
    for (const id of folderIds) {
      const response = await page.request.get(`${api}/library/folders/${id}/delete-preview`);
      if (response.status() === 404) continue;
      if (response.ok()) {
        const preview = await response.json() as { confirmationToken: string };
        await page.request.delete(`${api}/library/folders/${id}`, { data: { confirmationToken: preview.confirmationToken } });
      }
    }
  }
});
