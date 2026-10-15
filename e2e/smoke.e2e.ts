import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { smokeTarget } from './smoke-target';

const evidenceDir = process.env.E2E_EVIDENCE_DIR ?? join(process.cwd(), 'e2e', 'artifacts');

async function shot(page: Page, name: string) {
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Account:/ })).toBeVisible();
}

async function openDecks(page: Page) {
  const garden = page.getByRole('heading', { name: 'A quiet garden.' });
  if (await garden.isVisible()) {
    await page.getByRole('link', { name: 'Build a deck' }).click();
  } else {
    await page.getByRole('link', { name: 'Decks', exact: true }).click();
  }
  await expect(page).toHaveURL(/\/decks(?:\?|$)/);
}

async function deleteCreatedDeck(page: Page, deckName: string) {
  await page.goto('/decks');
  if (page.url().includes('/auth/sign-in')) return;
  const row = page.getByRole('treeitem', { name: deckName, exact: true });
  const appeared = await row
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  await page.getByRole('button', { name: `Deck menu: ${deckName}` }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(deckName);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row).toHaveCount(0);
}

test('sign in, create a deck, review a card, and open statistics', async ({ page }) => {
  const target = smokeTarget(process.env);
  let walked = false;
  let walkError: unknown;
  try {
    if (target.mode === 'local') {
      await test.step('sign up', async () => {
        await page.goto('/auth/sign-up');
        await page.getByLabel('Имя').fill(target.name);
        await page.getByLabel('Email').fill(target.email);
        await page.getByLabel('Пароль').fill(target.password);
        await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
        await expect(page.getByRole('heading', { name: 'A quiet garden.' })).toBeVisible();
        await shot(page, '01-garden');
      });
      await test.step('sign out', async () => {
        await page.getByRole('button', { name: `Account: ${target.name}` }).click();
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await expect(page).toHaveURL(/\/auth\/sign-in/);
      });
    }

    await test.step('sign in', async () => {
      await signIn(page, target.email, target.password);
      await shot(page, '02-signed-in');
    });

    await test.step('create a deck', async () => {
      await openDecks(page);
      await page.getByRole('button', { name: 'New deck' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'New deck' });
      await dialog.getByLabel('Name').fill(target.deckName);
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page.getByRole('treeitem', { name: target.deckName, exact: true })).toBeVisible();
      await shot(page, '03-deck');
    });

    await test.step('add a card', async () => {
      await page.getByRole('button', { name: `Deck menu: ${target.deckName}` }).click();
      await page.getByRole('menuitem', { name: 'Add card', exact: true }).click();
      await expect(page).toHaveURL(/\/editor\?deck=/);
      await page.getByRole('textbox', { name: 'Question', exact: true }).fill(target.question);
      await page.getByRole('textbox', { name: 'Answer', exact: true }).fill(target.answer);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page).toHaveURL(/\/editor\?card=/);
      await expect(page.getByText('Card saved', { exact: true })).toBeVisible();
      await shot(page, '04-card');
    });

    await test.step('review the card', async () => {
      await page.getByRole('link', { name: 'Decks', exact: true }).click();
      await page.getByRole('button', { name: `Deck menu: ${target.deckName}` }).click();
      await page.getByRole('menuitem', { name: 'Study', exact: true }).click();
      await expect(page).toHaveURL(/\/review\?deck=/);
      await expect(page.getByText(target.question, { exact: true })).toBeVisible();
      await expect(page.getByText(target.answer, { exact: true })).toBeHidden();
      await page.getByRole('button', { name: 'Show answer' }).click();
      await expect(page.getByText(target.answer, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /3\s+Good/ }).click();
      await expect(page.getByRole('heading', { name: 'Your next review is coming up' })).toBeVisible();
      await expect(page.getByText('Your answers have already been saved.')).toBeVisible();
      await shot(page, '05-review');
    });

    await test.step('open statistics', async () => {
      await page.getByRole('link', { name: 'Stats', exact: true }).click();
      await expect(page).toHaveURL(/\/stats(?:\?|$)/);
      await expect(page.getByText('Due forecast', { exact: true })).toBeVisible();
      await expect(page.getByText('Retention by interval', { exact: true })).toBeVisible();
      await expect(page.getByText('Per-deck performance', { exact: true })).toBeVisible();
      const row = page
        .locator('div')
        .filter({ has: page.getByText(target.deckName, { exact: true }) })
        .filter({ has: page.getByText('1 own', { exact: true }) })
        .last();
      await expect(row).toBeVisible();
      await shot(page, '06-stats');
    });
    walked = true;
  } catch (error) {
    walkError = error;
  }

  let deleteError: unknown;
  try {
    await deleteCreatedDeck(page, target.deckName);
  } catch (error) {
    deleteError = error;
  }
  if (!walked && walkError) throw walkError;
  if (deleteError) throw deleteError;
});
