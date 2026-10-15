import { defineConfig } from '@playwright/test';

const prod = process.env.E2E_TARGET === 'prod';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 45_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: prod ? 'https://app.reomi.ru' : 'http://localhost:3001',
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 30_000,
    navigationTimeout: 90_000,
    trace: prod ? 'off' : 'retain-on-failure',
    video: prod ? 'off' : 'off',
    screenshot: 'only-on-failure',
  },
});
