import { expect, test, type Locator, type Page } from '@playwright/test';
import { EMPTY_CARD_ERROR, focusLabel } from './a11y/evidence';
import { clearPasswordFields } from './clear-secrets';
import { rememberSecret } from './secret-scan';
import { smokeTarget } from './smoke-target';

const RATING_LABELS = ['1 Again', '2 Hard', '3 Good', '4 Easy'] as const;

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await clearPasswordFields(page);
  await expect(page.getByLabel(/^Account:/)).toBeVisible();
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

async function setZoom(page: Page, zoom: '100%' | '200%' | '400%') {
  await page.evaluate((value) => {
    document.documentElement.style.zoom = value;
  }, zoom);
}

async function expectInViewport(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
}

async function accessibleName(locator: Locator): Promise<string> {
  const name = await locator.evaluate((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim());
  if (!name) throw new Error('missing accessible name');
  return name;
}

async function reachShowAnswer(page: Page) {
  const show = page.getByRole('button', { name: 'Show answer · Space', exact: true });
  await show.waitFor({ state: 'visible' });
  await page.getByRole('main').focus();
  for (let step = 0; step < 40; step += 1) {
    if (await show.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(show).toBeFocused();
}

test.afterEach(async ({ page }) => {
  await clearPasswordFields(page);
});

test('local chromium walk records machine facts and leaves the human items open', async ({ page }) => {
  const target = smokeTarget(process.env);
  rememberSecret(target.password);
  test.skip(target.mode === 'prod', 'Chromium evidence is local-only and does not close the items.');

  const questionStem = `Question ${target.deckName}`;
  const answer = `Reply ${target.deckName}`;
  const codeToken = `SCROLL_${'A'.repeat(240)}`;
  const question = `${questionStem}\n\n\`\`\`\n${codeToken}\n\`\`\``;
  expect(question.includes(answer)).toBe(false);
  expect(answer.includes(question)).toBe(false);

  let walkError: unknown;
  try {
    await test.step('sign up', async () => {
      await page.goto('/auth/sign-up');
      await page.getByLabel('Имя').fill(target.name);
      await page.getByLabel('Email').fill(target.email);
      await page.getByLabel('Пароль').fill(target.password);
      await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
      await clearPasswordFields(page);
      await expect(page.getByRole('heading', { name: 'A quiet garden.' })).toBeVisible();
    });

    await test.step('sign out', async () => {
      await page.getByLabel(`Account: ${target.name}`, { exact: true }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page).toHaveURL(/\/auth\/sign-in/);
    });

    await test.step('sign in', async () => {
      await signIn(page, target.email, target.password);
    });

    await test.step('landmarks', async () => {
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.getByRole('main')).toHaveAttribute('tabindex', '-1');
      await expect(page.getByRole('navigation', { name: 'Menu' })).toHaveCount(1);
      await expect(page.locator('.nn-bottom-tabs')).toBeHidden();
    });

    await test.step('create a deck', async () => {
      await openDecks(page);
      await page.getByRole('button', { name: 'New deck' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'New deck' });
      await dialog.getByLabel('Name').fill(target.deckName);
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page.getByRole('treeitem', { name: target.deckName, exact: true })).toBeVisible();
    });

    await test.step('zoom to New deck', async () => {
      const created = page.getByRole('button', { name: 'New deck' }).first();
      for (const zoom of ['200%', '400%'] as const) {
        await setZoom(page, zoom);
        await expectInViewport(created);
      }
      await setZoom(page, '100%');
    });

    await test.step('empty field error', async () => {
      await page.getByRole('button', { name: `Deck menu: ${target.deckName}` }).click();
      await page.getByRole('menuitem', { name: 'Add card', exact: true }).click();
      await expect(page).toHaveURL(/\/editor\?deck=/);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      const error = page.getByRole('alert').filter({ hasText: EMPTY_CARD_ERROR }).first();
      await expect(error).toBeVisible();
      await expect(error).toHaveText(EMPTY_CARD_ERROR);
      for (const zoom of ['200%', '400%'] as const) {
        await setZoom(page, zoom);
        await expectInViewport(error);
      }
      await setZoom(page, '100%');
    });

    await test.step('add a card', async () => {
      await page.getByRole('textbox', { name: 'Question', exact: true }).fill(question);
      await page.getByRole('textbox', { name: 'Answer', exact: true }).fill(answer);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page).toHaveURL(/\/editor\?card=/);
      await expect(page.getByText('Card saved', { exact: true })).toBeVisible();
    });

    await test.step('review before reveal', async () => {
      await page.getByRole('link', { name: 'Decks', exact: true }).click();
      await page.getByRole('button', { name: `Deck menu: ${target.deckName}` }).click();
      await page.getByRole('menuitem', { name: 'Study', exact: true }).click();
      await expect(page).toHaveURL(/\/review\?deck=/);
      await expect(page.locator('.reomi-review-answer')).toHaveCount(0);
      const region = page.locator('.reomi-review-question');
      await expect(region).toContainText(questionStem);
      await expect(region).not.toContainText(answer);
    });

    await test.step('keyboard ratings', async () => {
      await reachShowAnswer(page);
      await page.keyboard.press('Space');
      const ratings = page.locator('button.reomi-rating');
      await expect(ratings).toHaveCount(4);
      await ratings.nth(0).focus();
      for (let index = 0; index < RATING_LABELS.length; index += 1) {
        const focused = page.locator('button.reomi-rating:focus');
        await expect(focused).toHaveCount(1);
        expect(focusLabel(await accessibleName(focused))).toEqual({ kind: 'label', label: RATING_LABELS[index] });
        if (index < RATING_LABELS.length - 1) await page.keyboard.press('Tab');
      }
    });

    await test.step('zoom the review controls', async () => {
      const again = page.getByRole('button', { name: 'Again' });
      const reviews = page.locator('.reomi-review-inspector').getByText('Reviews', { exact: true });
      const pre = page.locator('.reomi-review-question pre');
      for (const zoom of ['200%', '400%'] as const) {
        await setZoom(page, zoom);
        await expectInViewport(again);
        await expectInViewport(reviews);
      }
      await setZoom(page, '400%');
      const scrollsInside = await pre.evaluate((node) => node.scrollWidth > node.clientWidth);
      expect(scrollsInside).toBe(true);
      await setZoom(page, '100%');
    });

    await test.step('grade Good', async () => {
      const ratings = page.locator('button.reomi-rating');
      expect(focusLabel(await accessibleName(ratings.nth(2)))).toEqual({ kind: 'label', label: '3 Good' });
      await ratings.nth(2).click();
    });

    await test.step('zoom bulk actions', async () => {
      await page.getByRole('link', { name: 'Cards', exact: true }).click();
      await expect(page).toHaveURL(/\/cards(?:\?|$)/);
      await page.getByRole('checkbox', { name: /^Select:/ }).check();
      const selected = page.getByText('1 selected', { exact: true }).first();
      await expect(selected).toBeVisible();
      for (const zoom of ['200%', '400%'] as const) {
        await setZoom(page, zoom);
        await expectInViewport(selected);
        await page.locator('.reomi-bulk-actions').getByRole('button', { name: 'Actions', exact: true }).click();
        await expectInViewport(page.getByRole('menuitem', { name: 'Suspend', exact: true }));
        await page.keyboard.press('Escape');
      }
      await setZoom(page, '100%');
    });
  } catch (error) {
    walkError = error;
  } finally {
    let deleteError: unknown;
    try {
      await deleteCreatedDeck(page, target.deckName);
    } catch (error) {
      deleteError = error;
    }
    if (walkError) throw walkError;
    if (deleteError) throw deleteError;
  }
});
