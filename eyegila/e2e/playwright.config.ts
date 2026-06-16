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
  testDir: '.',
  fullyParallel: false,    // tests share auth state; keep sequential
  retries: 1,
  timeout: 30_000,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
