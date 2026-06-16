import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config.
 *
 * Requires the full stack running:
 *   docker compose up -d
 *   cd eyegila && npm run dev   (or `npm run preview` after `npm run build`)
 *
 * Run:
 *   cd eyegila && npx playwright test
 *   cd eyegila && npx playwright test --headed   (watch the browser)
 *   cd eyegila && npx playwright test --ui        (Playwright UI mode)
 */
export default defineConfig({
  globalSetup: './global-setup',
  testDir: '.',
  fullyParallel: true,
  workers: 2,
  retries: 1,
  timeout: 30_000,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173',
    storageState: 'e2e/.auth/user.json',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // webkit requires libgtk-4, libgraphene, libgst* — run `sudo npx playwright install-deps webkit`
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],
});
