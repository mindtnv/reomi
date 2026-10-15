import { expect, test } from '@playwright/test';
import { clearPasswordFields } from './clear-secrets';
import { rememberSecret } from './secret-scan';

const probe = 'snapshot-probe-secret';

test('a cleared password stays out of the page snapshot', async ({ page }) => {
  rememberSecret(probe);
  await page.setContent(
    '<form onsubmit="event.preventDefault()"><label>Пароль<input type="password" /></label><button type="submit">Войти</button></form>',
  );
  await page.getByLabel('Пароль').fill(probe);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await clearPasswordFields(page);
  await page.locator('input[type="password"]').evaluate((el, secret) => {
    (el as HTMLInputElement).value = secret;
  }, probe);
  const snapshot = await page.locator('body').ariaSnapshot();
  expect(snapshot).not.toContain(probe);
});
