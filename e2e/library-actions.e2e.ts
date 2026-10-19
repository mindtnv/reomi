import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { librarySmokeSession } from './library-smoke-session';

test('library quick actions and saved work keep the app workspace', async ({ page }) => {
  const { target, api } = await librarySmokeSession(page);
  const title = target.mode === 'prod' ? `${target.deckName} Reading material` : 'Kubernetes: workload basics';
  const created = await page.request.post(`${api}/library/items`, { data: { kind: 'text', title, text: `${title}\n\nA material can be organized without losing its source identity.` } });
  expect(created.ok()).toBe(true);
  const { id } = await created.json() as { id: string };
  async function shot(name: string) {
    if (target.mode === 'prod') return;
    const dir = process.env.E2E_EVIDENCE_DIR ?? join(process.cwd(), 'e2e/artifacts'); mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `library-actions-${name}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  let noteId: string | undefined;
  const noteTitle = target.mode === 'prod' ? `${target.deckName} Source note` : 'How materials stay connected';
  const noteContent = 'Moving a material preserves its original source and every note linked to it.';
  try {
    const note = await page.request.post(`${api}/sources/${id}/notes`, { data: { title: noteTitle, content: noteContent } });
    expect(note.ok()).toBe(true); noteId = (await note.json() as { id: string }).id;
    await page.goto('/library/study');
    await expect.soft(page.locator('.reomi-saved-study.reomi-page-surface')).toBeVisible({ timeout: 5000 });
    await page.goto('/library');
    const material = page.locator('.reomi-library-selectable').filter({ has: page.locator(`[data-navigation-anchor="${id}"]`) });
    await expect(material).toBeVisible();
    await material.getByRole('button', { name: `Actions for ${title}`, exact: true }).click();
    const menu = page.getByRole('menu', { name: title, exact: true });
    await expect(menu.getByRole('menuitem', { name: 'Move to folder', exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/library');
    await shot('desktop-menu');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(material.getByRole('button', { name: `Actions for ${title}`, exact: true })).toBeFocused();
    await material.getByRole('button', { name: new RegExp(title) }).first().click({ button: 'right' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const rename = page.getByRole('dialog');
    await rename.getByRole('textbox').fill(`${title} renamed`);
    await rename.getByRole('button', { name: 'Save', exact: true }).click();
    const renamed = `${title} renamed`;
    await expect(material).toContainText(renamed);
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    const row = page.locator('.reomi-library-selectable-row').filter({ has: page.getByRole('checkbox', { name: `Select material: ${renamed}`, exact: true }) });
    const rowMenuButton = row.getByRole('button', { name: `Actions for ${renamed}`, exact: true });
    await rowMenuButton.focus(); await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: renamed, exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await page.request.get(`${api}/library/items/${id}`)).ok()).toBe(true);
    await shot('desktop-list');
    await page.getByRole('link', { name: 'Saved study work', exact: true }).click();
    await expect(page.locator('.reomi-saved-study.reomi-page-surface')).toBeVisible();
    await expect(page.locator('.nn-app-sidebar-slot')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Only work with an unavailable source', exact: true })).toBeVisible();
    await shot('saved-desktop');
    await page.getByRole('button', { name: 'Documents', exact: true }).click();
    await shot('saved-documents');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('saved-mobile');
    await page.addInitScript(() => {
      const native = window.matchMedia.bind(window);
      window.matchMedia = query => { const result = native(query); if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: true }); return result; };
    });
    await page.reload(); await expect(page.locator('.reomi-saved-study')).toBeVisible();
    await shot('saved-standalone-mobile');
    await page.goto('/library');
    await page.getByRole('button', { name: 'Grid view', exact: true }).click();
    await material.getByRole('button', { name: `Actions for ${renamed}`, exact: true }).click();
    await expect(page.getByRole('menu', { name: renamed, exact: true })).toBeVisible();
    await shot('standalone-mobile-menu');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 800 });
    await material.getByRole('button', { name: `Actions for ${renamed}`, exact: true }).click();
    await shot('standalone-desktop-menu');
    await page.keyboard.press('Escape');
    if (target.mode === 'local') {
      await page.evaluate(() => localStorage.setItem('reomi:theme', JSON.stringify({ version: 2, mode: 'dark', palette: 'default' })));
      await page.reload();
      await material.getByRole('button', { name: `Actions for ${renamed}`, exact: true }).click();
      await shot('dark-desktop-menu'); await page.keyboard.press('Escape');
    }
    await material.getByRole('checkbox', { name: `Select material: ${renamed}`, exact: true }).check();
    await material.getByRole('button', { name: `Actions for ${renamed}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(material).toHaveCount(0);
    await expect(page.locator('.reomi-library-selection')).toHaveCount(0);
    await page.goto(`/library/study?note=${noteId}`);
    await expect(page.getByText(noteContent, { exact: true })).toBeVisible();
    await shot('retained-note');
    await page.goto('/library/study');
    await page.getByRole('checkbox', { name: 'Only work with an unavailable source', exact: true }).check();
    await expect(page.getByText(noteTitle, { exact: true })).toBeVisible();
    await shot('retained-filter');
    if (target.mode === 'local') {
      await page.evaluate(() => localStorage.setItem('reomi:locale', 'ru'));
      await page.goto('/library/study'); await expect(page.locator('.reomi-saved-study')).toBeVisible();
      await shot('saved-ru-desktop');
      await page.setViewportSize({ width: 320, height: 740 }); await shot('saved-ru-small');
    }
  } finally {
    if (noteId) await page.request.delete(`${api}/study/notes/${noteId}`);
    await page.request.delete(`${api}/library/items/${id}`);
  }
});
