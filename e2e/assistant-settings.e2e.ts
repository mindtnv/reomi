import { expect, test, type Page } from '@playwright/test';
import { parseChatProbe } from '../packages/shared/src/chat-probe.ts';
import { clearPasswordFields } from './clear-secrets';
import { rememberSecret } from './secret-scan';
import { smokeTarget, type SmokeTarget } from './smoke-target';

const LIVE_SKIP = 'CHAT_API_KEY unset; skipping live assistant assertion';
const PROMPT = 'Reply with the single word ok.';

function apiBase(mode: SmokeTarget['mode']): string {
  return mode === 'prod' ? 'https://api.reomi.ru' : 'http://localhost:3000';
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await clearPasswordFields(page);
  await expect(page.getByLabel(/^Account:/)).toBeVisible();
}

async function signUpLocal(page: Page, target: SmokeTarget) {
  await page.goto('/auth/sign-up');
  await page.getByLabel('Имя').fill(target.name);
  await page.getByLabel('Email').fill(target.email);
  await page.getByLabel('Пароль').fill(target.password);
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await clearPasswordFields(page);
  await expect(page.getByRole('heading', { name: 'A quiet garden.' })).toBeVisible();
  await page.getByLabel(`Account: ${target.name}`, { exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in/);
}

async function readChatProbe(page: Page, base: string) {
  const text = await page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    return res.text();
  }, `${base}/ai/chat-probe`);
  try {
    return parseChatProbe(JSON.parse(text));
  } catch {
    return null;
  }
}

test.afterEach(async ({ page }) => {
  await clearPasswordFields(page);
});

test('settings shows Notifications after sign-in', async ({ page }) => {
  const target = smokeTarget(process.env);
  rememberSecret(target.password);
  if (target.mode === 'local') await signUpLocal(page, target);
  await signIn(page, target.email, target.password);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 2 })).toBeVisible();
  await expect(page.getByText('Application error')).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings/);
});

test('a reachable chat host answers without the attention card', async ({ page }) => {
  const target = smokeTarget(process.env);
  rememberSecret(target.password);
  if (target.mode === 'local') await signUpLocal(page, target);
  await signIn(page, target.email, target.password);

  const probe = await readChatProbe(page, apiBase(target.mode));
  if (probe && probe.ok === false && probe.state === 'disabled' && target.mode !== 'prod') {
    test.skip(true, LIVE_SKIP);
  }
  expect(probe).toEqual({ ok: true });

  await page.goto('/chat');
  const entry = page.locator('.reomi-assistant-page-entry');
  const composer = entry.locator('.reomi-assistant-composer');
  const input = composer.getByLabel('Message to assistant');
  await expect(input).toBeVisible();
  await input.fill(PROMPT);
  const send = composer.getByRole('button', { name: 'Send message' });
  await expect(send).toBeEnabled();
  await send.click();

  const reply = entry.locator('.reomi-chat-prose').filter({ hasText: /\S/ }).first();
  const attention = page.getByText('The assistant needs attention', { exact: true });
  const unavailable = page.getByText('The AI service is temporarily unavailable.', { exact: true });
  const generic = page.getByText('Something went wrong. Please try again.', { exact: true });
  const winner = await Promise.race([
    reply.waitFor({ state: 'visible', timeout: 90_000 }).then(() => 'reply' as const),
    attention.or(unavailable).or(generic).waitFor({ state: 'visible', timeout: 90_000 }).then(() => 'attention' as const),
  ]);
  expect(winner).toBe('reply');
  expect((await reply.innerText()).trim().length).toBeGreaterThan(0);
});
