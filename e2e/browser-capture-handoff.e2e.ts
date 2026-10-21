import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { librarySmokeSession } from './library-smoke-session';
import { rememberSecret } from './secret-scan';

test('capture handoff supports reviewed cards, source backlinks, keyboard and narrow standalone screens', async ({ page }) => {
  test.skip(process.env.E2E_TARGET === 'prod', 'Capture credentials and fixture text belong to a disposable local learner.');
  const { api, target } = await librarySmokeSession(page);
  const quote = 'A Pod groups containers that share network resources and storage.';
  const response = await page.request.post(`${api}/profile/tokens`, { data: { name: target.deckName, scope: 'capture' } }); expect(response.ok()).toBe(true);
  const credential = await response.json(); rememberSecret(credential.token);
  let sourceId: string | undefined, deckId: string | undefined;
  const dir = process.env.E2E_EVIDENCE_DIR ?? resolve('e2e/artifacts'); mkdirSync(dir, { recursive: true });
  async function shot(name: string) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(dir, `browser-extension-${name}.png`), fullPage: true });
  }
  try {
    const saved = await page.request.post(`${api}/extension/captures`, { headers: { authorization: `Bearer ${credential.token}` }, data: { requestKey: crypto.randomUUID(), title: 'Understanding Pods', text: quote, url: 'https://example.test/learning/pods', mode: 'selection' } }); expect(saved.ok()).toBe(true);
    const receipt = await saved.json(); sourceId = receipt.sourceId;
    const deck = await page.request.post(`${api}/decks`, { data: { name: target.deckName } }); expect(deck.ok()).toBe(true); deckId = (await deck.json()).id;
    await page.goto(receipt.readerUrl);
    const dialog = page.getByRole('dialog', { name: 'New card', exact: true });
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole('textbox', { name: 'Back', exact: true })).toHaveValue(quote);
    await expect(page.locator('[data-source-text-body]')).toContainText(quote); await shot('handoff-desktop-light');
    await page.addInitScript(() => { const original = matchMedia.bind(window); window.matchMedia = query => { const result = original(query); if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: true }); return result; }; localStorage.setItem('reomi:theme', JSON.stringify({ version: 2, mode: 'dark', palette: 'default' })); });
    await page.setViewportSize({ width: 320, height: 740 }); await page.reload(); await expect(dialog).toBeVisible(); await shot('handoff-standalone-small-dark');
    await dialog.getByRole('textbox', { name: 'Front', exact: true }).fill('What does a Pod group?');
    const completed = page.waitForResponse(r => r.url().endsWith(`/sources/${sourceId}/quick-card`) && r.request().method() === 'POST');
    await page.keyboard.press('Control+Enter'); const cardResponse = await completed; expect(cardResponse.ok()).toBe(true);
    const result = await cardResponse.json(); expect(result.cardIds).toHaveLength(1); await expect(dialog).toHaveCount(0); await expect(page).not.toHaveURL(/capture=/);
    const refs = await page.request.get(`${api}/cards/${result.cardIds[0]}/sources`); expect(refs.ok()).toBe(true);
    const edges = JSON.stringify(await refs.json()); expect(edges).toContain(sourceId!); expect(edges).toContain(quote);
    await page.setViewportSize({ width: 1280, height: 800 }); await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    const permissions = page.getByRole('button', { name: 'Permissions' }); await permissions.click(); await page.getByRole('option', { name: 'Browser capture', exact: true }).click();
    await permissions.scrollIntoViewIfNeeded(); await shot('settings-desktop-dark');
    await page.setViewportSize({ width: 320, height: 740 }); await shot('settings-standalone-small-dark');
    await page.request.delete(`${api}/profile/tokens/${credential.item.id}`);
    const revoked = await page.request.get(`${api}/extension/connection`, { headers: { authorization: `Bearer ${credential.token}` } }); expect(revoked.status()).toBe(401);
  } finally {
    await page.request.delete(`${api}/profile/tokens/${credential.item.id}`);
    if (sourceId) await page.request.delete(`${api}/library/items/${sourceId}`);
    if (deckId) await page.request.delete(`${api}/decks/${deckId}`);
  }
});
