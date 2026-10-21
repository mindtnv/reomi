import { expect, test } from '@playwright/test';
import { librarySmokeSession } from './library-smoke-session';

test('live Kubernetes sections become readable library materials and retain identity on refresh', async ({ page }) => {
  test.skip(process.env.E2E_TARGET !== 'prod' || process.env.E2E_LIVE_DOCUMENTATION !== 'true', 'Opt-in production acceptance uses real public documentation.');
  test.setTimeout(480_000);
  const { api, target } = await librarySmokeSession(page);
  await page.addInitScript(() => localStorage.setItem('reomi:locale', 'en'));
  const base = `${api}/library/documentation`;
  const title = `${target.deckName} Kubernetes`;
  let connectionId: string | undefined, folderId: string | undefined;
  type Item = { id: string; kind: string; url: string; total: number };
  async function items(): Promise<Item[]> {
    const response = await page.request.get(`${api}/library/items?folderId=${folderId}&limit=300`);
    expect(response.ok()).toBe(true);
    const result = await response.json(); expect(result.nextCursor).toBeNull(); return result.items;
  }
  async function complete() {
    await expect.poll(async () => {
      const response = await page.request.get(`${base}/${connectionId}`);
      expect(response.ok()).toBe(true);
      return (await response.json()).state;
    }, { timeout: 180_000, intervals: [1000, 2000, 5000] }).toBe('completed');
  }
  try {
    const preview = await page.request.post(`${base}/preview`, { data: { url: 'https://kubernetes.io/docs/home/', locale: 'en' }, timeout: 120_000 });
    expect(preview.ok()).toBe(true);
    const manifest = await preview.json(); connectionId = manifest.id;
    expect(manifest.rootUrl).toBe('https://kubernetes.io/docs/'); expect(manifest.locale).toBe('en');
    const sections = manifest.sections as { prefix: string; pageCount: number; newPageCount: number }[];
    // Select only a small, entirely new branch. Existing account materials are never refreshed or removed by this check.
    const branch = sections.filter(s => s.prefix.startsWith('/docs/concepts/') && s.pageCount > 0 && s.pageCount <= 2 && s.newPageCount === s.pageCount)
      .sort((a, b) => a.pageCount - b.pageCount || b.prefix.length - a.prefix.length)[0];
    expect(branch, 'A small unused concepts branch is required for a bounded live acceptance').toBeDefined();
    const confirmed = await page.request.post(`${base}/${connectionId}/confirm`, { data: { title, prefixes: [branch!.prefix] } });
    expect(confirmed.ok()).toBe(true); folderId = (await confirmed.json()).folderId;
    await complete();
    const saved = await items(); expect(saved).toHaveLength(branch!.pageCount);
    for (const item of saved) { expect(item.kind).toBe('url'); expect(item.url).toContain(`https://kubernetes.io${branch!.prefix}`); expect(item.total).toBeGreaterThan(0); }
    await page.goto(`/library/${saved[0]!.id}`);
    await expect(page.locator('[data-source-text-body]').first()).toBeVisible();
    expect((await page.locator('[data-source-text-body]').allTextContents()).join(' ').length).toBeGreaterThan(100);
    const scheduled = await page.request.patch(`${base}/${connectionId}/schedule`, { data: { schedule: 'daily' } });
    expect(scheduled.ok()).toBe(true);
    expect(await scheduled.json()).toMatchObject({ schedule: 'daily' });
    await page.goto('/library');
    const control = page.getByRole('button', { name: `Auto-update: ${title}`, exact: true });
    await expect(control).toContainText('Every day');
    await control.click(); await page.getByRole('option', { name: 'Off', exact: true }).click();
    await expect(control).toContainText('Off');
    const refresh = await page.request.post(`${base}/${connectionId}/updates`, { timeout: 120_000 });
    expect(refresh.ok()).toBe(true); await complete();
    expect((await items()).map(i => i.id).sort()).toEqual(saved.map(i => i.id).sort());
    const summary = await (await page.request.get(`${base}/${connectionId}`)).json();
    expect(summary.lastResult.added).toBe(0); expect(summary.failed).toBe(0);
  } finally {
    if (connectionId) {
      const disconnected = await page.request.delete(`${base}/${connectionId}`);
      expect([200, 404]).toContain(disconnected.status());
    }
    if (folderId) {
      // The unique collection folder contains only this run's newly imported sources.
      for (const item of await items()) expect((await page.request.delete(`${api}/library/items/${item.id}`)).ok()).toBe(true);
      const preview = await page.request.get(`${api}/library/folders/${folderId}/delete-preview`);
      expect(preview.ok()).toBe(true);
      expect((await page.request.delete(`${api}/library/folders/${folderId}`, { data: { confirmationToken: (await preview.json()).confirmationToken } })).ok()).toBe(true);
    }
  }
});
