import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { clearPasswordFields } from './clear-secrets';
import { rememberSecret } from './secret-scan';
import { smokeTarget } from './smoke-target';

const evidenceDir = process.env.E2E_EVIDENCE_DIR ?? join(process.cwd(), 'e2e', 'artifacts', 'visual');

const viewports = [
  { id: 'desktop', width: 1280, height: 800 },
  { id: 'mobile', width: 390, height: 844 },
] as const;

const modes = ['browser', 'standalone'] as const;

const routes = [
  { id: 'home', label: 'Home', path: '/' },
  { id: 'chat', label: 'Chat', path: '/chat' },
  { id: 'review', label: 'Review', path: '/review' },
  { id: 'decks', label: 'Decks', path: '/decks' },
  { id: 'cards', label: 'Cards', path: '/cards' },
  { id: 'library', label: 'Library', path: '/library' },
  { id: 'notebooks', label: 'Notebooks', path: '/notebooks' },
  { id: 'stats', label: 'Stats', path: '/stats' },
] as const;

const settingsTabs = [
  { id: 'general', name: 'General', sections: ['Notifications'] },
  { id: 'appearance', name: 'Appearance', sections: ['Appearance'] },
  { id: 'learning', name: 'Learning', sections: ['Study day'] },
  { id: 'ai', name: 'Assistant', sections: [] },
  { id: 'connections', name: 'Connections', sections: ['App access'] },
  { id: 'data', name: 'Data', sections: [] },
] as const;

type ShotRecord = {
  file: string;
  mode: string;
  viewport: string;
  screen: string;
  kind: 'page' | 'section' | 'dialog' | 'control';
  tag?: string;
  control?: string;
  name?: string;
  appearance?: string;
};

test('capture production screens for a design-system audit', async ({ browser }) => {
  const target = smokeTarget(process.env);
  rememberSecret(target.password);
  test.skip(target.mode !== 'prod', 'visual audit runs against https://app.reomi.ru');
  mkdirSync(evidenceDir, { recursive: true });
  const index: ShotRecord[] = [];
  const failures: string[] = [];

  for (const mode of modes) {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        baseURL: 'https://app.reomi.ru',
        locale: 'en-US',
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      if (mode === 'standalone') await emulateStandalone(context);
      const page = await context.newPage();
      const prefix = `${mode}-${viewport.id}`;
      try {
        try {
        await signIn(page, target.email, target.password, prefix);
        const standalone = await page.evaluate(() => window.matchMedia('(display-mode: standalone)').matches);
        if (standalone !== (mode === 'standalone')) {
          failures.push(`${prefix} display-mode was ${standalone ? 'standalone' : 'browser'}`);
        }

        for (const route of routes) {
          try {
            await openScreen(page, route.label, route.path);
            await settle(page);
            await capturePage(page, index, prefix, route.id);
            if (route.id === 'cards') await captureColumns(page, index, prefix);
            await captureRawControls(page, index, prefix, route.id);
          } catch (error) {
            failures.push(`${prefix} ${route.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        try {
          await captureOperations(page, index, prefix);
        } catch (error) {
          failures.push(`${prefix} operations: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
          await captureSettings(page, index, prefix);
        } catch (error) {
          failures.push(`${prefix} settings: ${error instanceof Error ? error.message : String(error)}`);
        }
        } catch (error) {
          failures.push(`${prefix} walk: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        await clearPasswordFields(page);
        await context.close();
      }
    }
  }

  writeFileSync(join(evidenceDir, 'index.json'), `${JSON.stringify({ failures, shots: index }, null, 2)}\n`);
  expect(failures, failures.join('\n')).toEqual([]);
});

async function emulateStandalone(context: BrowserContext) {
  await context.addInitScript(() => {
    const native = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (/\(\s*display-mode\s*:\s*standalone\s*\)/.test(query)) {
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return false;
          },
        };
      }
      return native(query);
    };
  });
}

async function signIn(page: Page, email: string, password: string, prefix: string) {
  await page.goto('/auth/sign-in');
  await page.screenshot({ path: join(evidenceDir, `${prefix}-sign-in.png`), fullPage: true });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await clearPasswordFields(page);
  await expect(page.locator('h1.nn-topbar-title')).toBeVisible();
}

async function settle(page: Page) {
  await expect(page.locator('h1.nn-topbar-title')).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function openScreen(page: Page, label: string, path: string) {
  await dismissDialogs(page);
  const named = new RegExp(`^${label}\\b`);
  const link = page.getByRole('link', { name: named });
  if (!(await firstVisible(link))) {
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    if (await menu.isVisible().catch(() => false)) {
      await menu.click();
      await page.getByRole('dialog', { name: 'Navigation' }).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    }
  }
  const target = page.getByRole('link', { name: named });
  if (await firstVisible(target)) {
    await target.filter({ visible: true }).first().click();
  } else {
    await page.goto(path);
  }
  await page.waitForURL((url) => (path === '/' ? url.pathname === '/' : url.pathname === path), { timeout: 20_000 }).catch(async () => {
    await page.goto(path);
  });
}

async function capturePage(page: Page, index: ShotRecord[], prefix: string, screen: string) {
  const file = `${prefix}-${screen}.png`;
  await pageScreenshot(page, file);
  index.push({ file, mode: prefix.split('-')[0] ?? prefix, viewport: prefix.split('-')[1] ?? prefix, screen, kind: 'page' });
  await captureScrollSlices(page, index, prefix, screen);
}

async function captureColumns(page: Page, index: ShotRecord[], prefix: string) {
  const button = page.getByRole('button', { name: 'Columns', exact: true });
  if (!(await button.isVisible().catch(() => false))) return;
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Columns' });
  await expect(dialog).toBeVisible();
  const file = `${prefix}-cards-columns.png`;
  await dialog.screenshot({ path: join(evidenceDir, file) });
  index.push({ file, mode: prefix.split('-')[0] ?? prefix, viewport: prefix.split('-')[1] ?? prefix, screen: 'cards-columns', kind: 'dialog' });
  await captureRawControls(page, index, prefix, 'cards-columns');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}

async function captureOperations(page: Page, index: ShotRecord[], prefix: string) {
  await dismissDialogs(page);
  let button = page.getByRole('button', { name: /Operations/ });
  if (!(await firstVisible(button))) {
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    if (await menu.isVisible().catch(() => false)) await menu.click();
    button = page.getByRole('button', { name: /Operations/ });
  }
  await button.filter({ visible: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Operations' });
  await expect(dialog).toBeVisible();
  const file = `${prefix}-operations.png`;
  await page.screenshot({ path: join(evidenceDir, file) });
  index.push({ file, mode: prefix.split('-')[0] ?? prefix, viewport: prefix.split('-')[1] ?? prefix, screen: 'operations', kind: 'dialog' });
  await captureRawControls(page, index, prefix, 'operations');
  await page.keyboard.press('Escape');
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}

async function captureSettings(page: Page, index: ShotRecord[], prefix: string) {
  await dismissDialogs(page);
  const direct = page.getByRole('link', { name: 'Settings', exact: true });
  if (!(await firstVisible(direct))) {
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    if (await menu.isVisible().catch(() => false)) await menu.click();
  }
  const account = page.locator('.nn-account-trigger');
  if (!(await firstVisible(page.getByRole('link', { name: 'Settings', exact: true }))) && (await account.isVisible().catch(() => false))) {
    await account.click();
  }
  const settings = page.getByRole('link', { name: 'Settings', exact: true });
  if (await firstVisible(settings)) await settings.filter({ visible: true }).first().click();
  else await page.goto('/settings');
  await page.waitForURL(/\/settings(?:\?|$)/);
  await settle(page);

  for (const tab of settingsTabs) {
    const select = page.locator('.reomi-settings-mobile-nav select');
    if (await select.isVisible().catch(() => false)) {
      await select.selectOption(tab.id);
    } else {
      await page.getByRole('tab', { name: tab.name, exact: true }).click();
    }
    await expect(page.getByRole('heading', { level: 1, name: tab.name, exact: true })).toBeVisible();
    await page.waitForTimeout(400);
    const file = `${prefix}-settings-${tab.id}.png`;
    await pageScreenshot(page, file);
    index.push({
      file,
      mode: prefix.split('-')[0] ?? prefix,
      viewport: prefix.split('-')[1] ?? prefix,
      screen: `settings-${tab.id}`,
      kind: 'page',
    });
    for (const section of tab.sections) {
      const heading = page.getByRole('heading', { level: 2, name: section, exact: true });
      if (!(await heading.count())) continue;
      const region = heading.locator('xpath=ancestor::section[1]');
      await region.scrollIntoViewIfNeeded();
      const sectionFile = `${prefix}-settings-${tab.id}-${slug(section)}.png`;
      await region.screenshot({ path: join(evidenceDir, sectionFile) }).catch(() => {});
      index.push({
        file: sectionFile,
        mode: prefix.split('-')[0] ?? prefix,
        viewport: prefix.split('-')[1] ?? prefix,
        screen: `settings-${tab.id}`,
        kind: 'section',
        name: section,
      });
    }
    await captureScrollSlices(page, index, prefix, `settings-${tab.id}`, '.reomi-settings-content');
    await captureRawControls(page, index, prefix, `settings-${tab.id}`);
  }
}

async function captureRawControls(page: Page, index: ShotRecord[], prefix: string, screen: string) {
  const controls = await page.evaluate(() => {
    document.querySelectorAll('[data-visual-audit]').forEach((node) => node.removeAttribute('data-visual-audit'));
    const designed = /(?:^|\s)(?:reomi-|nn-)/;
    const skipAncestor = '.reomi-library-filters, .reomi-settings-tabs, .nn-account, .nn-lib-menu, .nn-sidebar, .nn-bottom-tabs, .nn-topbar, .nn-mobile-drawer-panel, .reomi-button';
    const nodes = Array.from(document.querySelectorAll('button, input, select, textarea'));
    const found = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node instanceof HTMLInputElement && (node.type === 'password' || node.type === 'hidden')) continue;
      if (node.closest('[hidden]')) continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      const className = typeof node.className === 'string' ? node.className : '';
      if (designed.test(className)) continue;
      if (node.closest(skipAncestor)) continue;
      const appearance = style.getPropertyValue('appearance') || style.getPropertyValue('-webkit-appearance');
      const name = (node.getAttribute('aria-label') || node.innerText || node.getAttribute('placeholder') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      const id = `raw-${found.length}`;
      node.setAttribute('data-visual-audit', id);
      found.push({
        id,
        tag: node.tagName.toLowerCase(),
        type: node instanceof HTMLInputElement ? node.type : node.tagName.toLowerCase(),
        name,
        appearance,
      });
      if (found.length >= 16) break;
    }
    return found;
  });

  for (const [offset, control] of controls.entries()) {
    const file = `${prefix}-${screen}-control-${offset}-${control.tag}.png`;
    const locator = page.locator(`[data-visual-audit="${control.id}"]`);
    await locator.screenshot({ path: join(evidenceDir, file) }).catch(() => {});
    index.push({
      file,
      mode: prefix.split('-')[0] ?? prefix,
      viewport: prefix.split('-')[1] ?? prefix,
      screen,
      kind: 'control',
      tag: control.tag,
      control: control.type,
      name: control.name,
      appearance: control.appearance,
    });
  }
}

async function pageScreenshot(page: Page, file: string) {
  await page.screenshot({ path: join(evidenceDir, file) });
}

async function captureScrollSlices(page: Page, index: ShotRecord[], prefix: string, screen: string, selector = '.nn-scroll') {
  const marked = await page.evaluate((rootSelector) => {
    document.querySelectorAll('[data-visual-scroll]').forEach((node) => node.removeAttribute('data-visual-scroll'));
    let target = null;
    for (const node of document.querySelectorAll(rootSelector)) {
      if (!(node instanceof HTMLElement)) continue;
      const style = getComputedStyle(node);
      const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll';
      if (!scrollable || node.clientHeight <= 160 || node.scrollHeight <= node.clientHeight + 80) continue;
      if (!target || node.scrollHeight > target.scrollHeight) target = node;
    }
    if (!target) return 0;
    target.setAttribute('data-visual-scroll', '1');
    return Math.min(3, Math.ceil(target.scrollHeight / target.clientHeight) - 1);
  }, selector);
  if (!marked) return;
  const scroller = page.locator('[data-visual-scroll="1"]');
  for (let slice = 1; slice <= marked; slice += 1) {
    await scroller.evaluate((node, step) => {
      if (node instanceof HTMLElement) node.scrollTop = node.clientHeight * step;
    }, slice);
    await page.waitForTimeout(200);
    const file = `${prefix}-${screen}-scroll-${slice}.png`;
    await page.screenshot({ path: join(evidenceDir, file) });
    index.push({
      file,
      mode: prefix.split('-')[0] ?? prefix,
      viewport: prefix.split('-')[1] ?? prefix,
      screen,
      kind: 'page',
      name: `scroll ${slice}`,
    });
  }
  await scroller.evaluate((node) => {
    if (node instanceof HTMLElement) {
      node.scrollTop = 0;
      node.removeAttribute('data-visual-scroll');
    }
  }).catch(() => {});
}

async function dismissDialogs(page: Page) {
  const dialog = page.getByRole('dialog');
  if (await dialog.first().isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await dialog.first().waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {});
  }
}

async function firstVisible(locator: Locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
