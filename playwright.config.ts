import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Extensions only run in headed Chromium with a persistent context, so these are
  // slower and serial by nature. Keep them few and load-bearing.
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
});
