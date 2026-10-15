import type { Page } from '@playwright/test';

export async function clearPasswordFields(page: Page) {
  await page
    .locator('input[type="password"]')
    .evaluateAll((els) => {
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      for (const el of els) {
        if (!(el instanceof HTMLInputElement)) continue;
        proto?.set?.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        Object.defineProperty(el, 'value', {
          configurable: true,
          get: () => '',
          set: () => {},
        });
      }
    })
    .catch(() => {});
}
