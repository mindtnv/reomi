import { defineConfig } from '@playwright/test';

process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

/** Production screenshot walk. Invoked only by `scripts/visual-audit.sh`. */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/visual-audit.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 1_200_000,
  expect: { timeout: 45_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: 'https://app.reomi.ru',
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 30_000,
    navigationTimeout: 90_000,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
