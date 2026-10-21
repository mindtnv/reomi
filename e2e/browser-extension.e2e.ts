import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { librarySmokeSession } from './library-smoke-session';
import { rememberSecret } from './secret-scan';

test('loaded extension previews locally, recovers an uncertain save and creates a reviewed source-backed card', async ({ page }, testInfo) => {
  test.skip(process.env.E2E_TARGET === 'prod', 'Unpacked extension and fixture host are local-only.');
  test.skip(process.env.E2E_SKIP_UNPACKED_EXTENSION === 'true', 'This local browser forbids unpacked extensions by administrator policy; CI must run this test.');
  const { api, target } = await librarySmokeSession(page);
  const excerpt = 'A Pod groups one or more containers that share storage and network resources.';
  const fixture = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<html><head><title>Understanding Pods</title></head><body><article><h1>Understanding Pods</h1><p id="selection">${excerpt}</p><p>${'Kubernetes manages containerized workloads and services. '.repeat(20)}</p><form><input type="password" value="PRIVATE_FIXTURE"><p>PRIVATE_FORM</p></form></article></body></html>`); });
  await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done));
  const port = (fixture.address() as { port: number }).port, fixtureUrl = `http://localhost:${port}/article`;
  execFileSync('bun', ['run', '--filter', '@reomi/extension', 'build:dev'], { env: { ...process.env, REOMI_EXTENSION_TEST_ORIGIN: `http://localhost:${port}` }, stdio: 'pipe' });
  const extensionPath = resolve('apps/extension/dist/chromium-dev'), profile = mkdtempSync(join(tmpdir(), 'reomi-extension-'));
  let context: BrowserContext | undefined, tokenId: string | undefined, sourceId: string | undefined, deckId: string | undefined;
  const evidence = process.env.E2E_EVIDENCE_DIR ?? resolve('e2e/artifacts'); mkdirSync(evidence, { recursive: true });
  const shot = async (view: Page, name: string) => {
    expect(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await view.screenshot({ path: join(evidence, `browser-extension-${name}.png`), fullPage: true });
  };
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, locale: 'en-US', viewport: { width: 1280, height: 800 },
      ...(testInfo.project.use.launchOptions?.executablePath ? { executablePath: testInfo.project.use.launchOptions.executablePath } : {}),
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`], ignoreDefaultArgs: ['--disable-extensions'] });
    await context.addCookies(await page.context().cookies());
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const content = await context.newPage(); await content.goto(fixtureUrl);
    await content.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById('selection')!); getSelection()?.removeAllRanges(); getSelection()?.addRange(range); });
    // A test-only permission for this one local fixture replaces the browser
    // toolbar's activeTab gesture. Production packages have no page host grant.
    await worker.evaluate(async url => {
      const chrome = (globalThis as any).chrome;
      const tabs = await chrome.tabs.query({ url });
      await chrome.storage.local.set({ entry: { tabId: tabs[0].id, selection: true, at: Date.now() } });
    }, fixtureUrl);
    const popup = await context.newPage(); await popup.setViewportSize({ width: 380, height: 760 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByRole('heading', { name: 'Keep the useful parts.' })).toBeVisible(); await shot(popup, 'connect-light');
    const createdToken = await page.request.post(`${api}/profile/tokens`, { data: { name: target.deckName, scope: 'capture' } }); expect(createdToken.ok()).toBe(true);
    const credential = await createdToken.json(); tokenId = credential.item.id; rememberSecret(credential.token);
    await popup.getByLabel('Browser capture token', { exact: true }).fill(credential.token);
    await popup.getByRole('button', { name: 'Connect Reomi', exact: true }).click();
    await expect(popup.locator('#token')).toHaveValue('');
    await expect(popup.locator('#excerpt')).toHaveText(excerpt); await expect(popup.getByRole('button', { name: 'Selection', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await popup.getByRole('button', { name: 'Page', exact: true }).click(); await expect(popup.locator('#excerpt')).not.toContainText('PRIVATE_');
    await popup.getByRole('button', { name: 'Selection', exact: true }).click();
    await shot(popup, 'preview-light'); await popup.emulateMedia({ colorScheme: 'dark' }); await shot(popup, 'preview-dark');
    let attempts = 0;
    await context.route('**/extension/captures', async route => {
      attempts += 1;
      if (attempts !== 1) return route.continue();
      const response = await route.fetch(); expect(response.ok()).toBe(true); sourceId = (await response.json()).sourceId;
      await route.abort('connectionreset');
    });
    await popup.getByRole('button', { name: 'Save to library', exact: true }).click();
    await expect(popup.getByRole('alert')).toContainText('could not be confirmed');
    // Close/reopen simulates popup lifetime loss after the server committed.
    await popup.reload(); await expect(popup.getByRole('button', { name: 'Retry the save' })).toBeVisible();
    await popup.getByRole('button', { name: 'Retry the save' }).click();
    await expect(popup.getByRole('heading', { name: 'Saved to your library' })).toBeVisible(); expect(attempts).toBe(2); await shot(popup, 'saved-dark');
    const listed = await (await page.request.get(`${api}/library?limit=300`)).json();
    expect(listed.items.filter((item: { id: string }) => item.id === sourceId)).toHaveLength(1);
    const deck = await page.request.post(`${api}/decks`, { data: { name: target.deckName } }); expect(deck.ok()).toBe(true); deckId = (await deck.json()).id;
    const opened = context.waitForEvent('page'); await popup.getByRole('button', { name: 'Create a card', exact: true }).click();
    const reader = await opened; await reader.waitForURL(`**/library/${sourceId}?capture=*`);
    const dialog = reader.getByRole('dialog', { name: 'New card' });
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole('textbox', { name: 'Back', exact: true })).toHaveValue(excerpt);
    await expect(reader.locator('[data-source-text-body]')).toContainText(excerpt);
    await shot(reader, 'handoff-desktop-light');
    await reader.addInitScript(() => { const native = matchMedia.bind(window); window.matchMedia = query => { const value = native(query); if (query === '(display-mode: standalone)') Object.defineProperty(value, 'matches', { value: true }); return value; }; localStorage.setItem('reomi:theme', JSON.stringify({ version: 2, mode: 'dark', palette: 'default' })); });
    await reader.setViewportSize({ width: 320, height: 740 }); await reader.reload(); await expect(dialog).toBeVisible(); await shot(reader, 'handoff-standalone-small-dark');
    await dialog.getByRole('textbox', { name: 'Front', exact: true }).fill('What does a Pod group?');
    const saved = reader.waitForResponse(response => response.url().endsWith(`/sources/${sourceId}/quick-card`) && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Create card', exact: true }).click(); expect((await saved).ok()).toBe(true);
    const result = await (await saved).json(); expect(result.cardIds.length).toBe(1);
    await expect(dialog).toHaveCount(0); await expect(reader).not.toHaveURL(/capture=/);
    const references = await page.request.get(`${api}/cards/${result.cardIds[0]}/sources`); expect(references.ok()).toBe(true);
    const edges = await references.json(); expect(JSON.stringify(edges)).toContain(sourceId!); expect(JSON.stringify(edges)).toContain(excerpt);
    await page.goto('/settings'); await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible(); await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    await page.getByRole('button', { name: 'Permissions' }).click(); await page.getByRole('option', { name: 'Browser capture' }).click();
    await shot(page, 'settings-desktop-light');
    await page.addInitScript(() => { const native = matchMedia.bind(window); window.matchMedia = query => { const value = native(query); if (query === '(display-mode: standalone)') Object.defineProperty(value, 'matches', { value: true }); return value; }; });
    await page.setViewportSize({ width: 320, height: 740 }); await page.reload(); await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible(); await page.getByRole('tab', { name: 'Connections', exact: true }).click(); await shot(page, 'settings-standalone-small');
    await page.request.delete(`${api}/profile/tokens/${tokenId}`); tokenId = undefined;
    await popup.reload(); await expect(popup.getByRole('alert')).toContainText('invalid, expired or revoked');
  } finally {
    if (tokenId) await page.request.delete(`${api}/profile/tokens/${tokenId}`);
    if (sourceId) await page.request.delete(`${api}/library/items/${sourceId}`);
    if (deckId) await page.request.delete(`${api}/decks/${deckId}`);
    await context?.close(); await new Promise<void>(done => fixture.close(() => done())); rmSync(profile, { recursive: true, force: true });
  }
});
