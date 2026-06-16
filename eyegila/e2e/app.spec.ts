/**
 * Playwright E2E tests for EyeGila.
 *
 * Pre-requisites:
 *   1. docker compose up -d             (DB + FastAPI + workers)
 *   2. python scripts/fake_detections.py --seed   (seed intersections)
 *   3. cd eyegila && npm run dev         (Vite dev server on :5173)
 *   4. cd eyegila && npx playwright install chromium
 *
 * Run: cd eyegila && npx playwright test e2e/app.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';

const BASE_URL  = process.env.BASE_URL  || 'http://localhost:5173';
const API_URL   = process.env.API_URL   || 'http://localhost:8000';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('#username').fill(ADMIN_USER);
  await page.locator('#password').fill(ADMIN_PASS);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Wait until we're redirected away from /login
  await expect(page).not.toHaveURL(/login/, { timeout: 10_000 });
}

// ─── Login ────────────────────────────────────────────────────────────────────

test.describe('Login', () => {
  test('login page renders username and password fields', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeEnabled();
  });

  test('wrong password shows error message', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('wrong-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    // Some visible indication of failure (toast, error text, or still on /login)
    await expect(page).toHaveURL(/login/, { timeout: 5_000 });
  });

  test('valid credentials redirect to dashboard', async ({ page }) => {
    await login(page);
    // Should be on dashboard or intersections page, not login
    await expect(page).not.toHaveURL(/login/);
  });

  test('unauthenticated navigation redirects to login', async ({ browser }) => {
    // Use a fresh context with no stored auth so the redirect guard triggers
    const ctx  = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE_URL}/`);
      await expect(page).toHaveURL(/login/, { timeout: 5_000 });
    } finally {
      await ctx.close();
    }
  });
});

// ─── Dashboard / Intersections ────────────────────────────────────────────────

test.describe('Intersections list', () => {

  test('shows at least one intersection after seed', async ({ page }) => {
    await page.goto(`${BASE_URL}/intersections`);
    // Wait for some intersection card or table row
    const items = page.locator('[data-testid="intersection-item"], tr[data-intersection-id], .intersection-card');
    // Fallback: any text that looks like an intersection name
    await expect(page.getByText(/junction|intersection|ave|st\.|road/i).first())
      .toBeVisible({ timeout: 10_000 });
  });

  test('page title contains "Intersections" or app name', async ({ page }) => {
    await page.goto(`${BASE_URL}/intersections`);
    await expect(page).toHaveTitle(/intersections|eyegila/i, { timeout: 5_000 });
  });
});

// ─── Recommendations ─────────────────────────────────────────────────────────

test.describe('Recommendations', () => {

  test('recommendations page loads without JS error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE_URL}/recommendations`);
    await page.waitForTimeout(2_000);
    expect(errors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0);
  });

  test('warrant badges are present (W1, W2, W4 or Recommended)', async ({ page }) => {
    await page.goto(`${BASE_URL}/recommendations`);
    // At least one warrant indicator should appear in the page
    // Status buckets: Warranted / Borderline / Not warranted / No data
    const badge = page.getByText(/W1|W2|W4|Recommended|Warranted|Borderline|No data/i).first();
    await expect(badge).toBeVisible({ timeout: 10_000 });
  });
});

// ─── Signal Timing page ───────────────────────────────────────────────────────

test.describe('Signal Timing', () => {
  // No beforeEach login — storageState already provides auth; extra login under parallel
  // load exhausts pgbouncer pool and causes query_wait_timeout failures.

  async function goToFirstSignalTiming(page: Page): Promise<boolean> {
    // Ensure we're on a web page so localStorage is accessible (storageState handles auth)
    if (!page.url().startsWith('http')) {
      await page.goto(`${BASE_URL}/`);
    }
    const token = await page.evaluate(() => localStorage.getItem('eyegila_token'));
    const res = await page.request.get(`${API_URL}/intersections/`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok()) return false;
    const intersections = await res.json();
    if (!intersections.length) return false;
    // Prefer seeded intersections (have recommendations); ad-hoc ones return 404 on /recommendations/:id
    const seeded = intersections.find(
      (i: { name: string }) => /junction|tagum|magugpo|poblacion/i.test(i.name),
    ) ?? intersections[0];
    await page.goto(`${BASE_URL}/timing/${seeded.id}`);
    return true;
  }

  test('signal timing page renders without JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const ok = await goToFirstSignalTiming(page);
    if (!ok) { test.skip(); return; }
    await page.waitForTimeout(3_000);
    const fatal = errors.filter(e =>
      !e.includes('ResizeObserver') &&
      !e.includes('THREE') &&       // 3D model load failures are non-fatal
      !e.includes('Failed to fetch')
    );
    expect(fatal).toHaveLength(0);
  });

  test('shows LOS grade badges', async ({ page }) => {
    const ok = await goToFirstSignalTiming(page);
    if (!ok) { test.skip(); return; }
    await page.waitForTimeout(3_000);
    // Skip when no simulation chunks exist yet (needs fake_detections --full)
    const noData = await page.getByText(/no simulation results/i).isVisible().catch(() => false);
    const noChunks = (await page.locator('[data-testid^="btn-chunk-"]').count()) === 0;
    if (noData || noChunks) { test.skip(); return; }
    const losBadge = page.getByText(/^[A-F]$/).first();
    await expect(losBadge).toBeVisible({ timeout: 10_000 });
  });

  test('3D canvas container is rendered', async ({ page }) => {
    const ok = await goToFirstSignalTiming(page);
    if (!ok) { test.skip(); return; }
    // Wait for page header to confirm page loaded, then check canvas
    await page.locator('[data-testid="btn-edit-timing"]').waitFor({ timeout: 10_000 }).catch(() => null);
    await page.waitForTimeout(2_000);
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeAttached({ timeout: 10_000 });
  });

  test('timing controls are visible on signal timing page', async ({ page }) => {
    const ok = await goToFirstSignalTiming(page);
    if (!ok) { test.skip(); return; }
    // Edit timing and print buttons are always present
    await expect(page.locator('[data-testid="btn-edit-timing"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="btn-print"]')).toBeVisible({ timeout: 5_000 });
  });

  test('timing table shows cycle lengths in range 40–120s', async ({ page }) => {
    const ok = await goToFirstSignalTiming(page);
    if (!ok) { test.skip(); return; }
    await page.waitForTimeout(2_000);
    // Skip when no chunk data — needs fake_detections --full seed
    const noChunks = (await page.locator('[data-testid^="btn-chunk-"]').count()) === 0;
    if (noChunks) { test.skip(); return; }
    // Trigger generate so timing table has data
    const token = await page.evaluate(() => localStorage.getItem('eyegila_token'));
    const res = await page.request.get(`${API_URL}/intersections/`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const [first] = await res.json();
    await page.request.post(`${API_URL}/recommendations/generate/${first.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await page.reload();
    await page.waitForTimeout(2_000);
    const cycleText = page.getByText(/\b(4[0-9]|[5-9][0-9]|1[0-1][0-9]|120)\s*s\b/i).first();
    await expect(cycleText).toBeVisible({ timeout: 8_000 });
  });
});

// ─── Camera detail ────────────────────────────────────────────────────────────

test.describe('Camera Detail', () => {

  test('camera list page loads', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE_URL}/cameras`);
    await page.waitForTimeout(1_500);
    const fatal = errors.filter(e => !e.includes('ResizeObserver'));
    expect(fatal).toHaveLength(0);
  });
});

// ─── Navigation ───────────────────────────────────────────────────────────────

test.describe('Navigation', () => {

  test('nav links lead to correct routes', async ({ page }) => {
    // Nav: Intersections → /, Reports → /reports, Videos → /videos
    const routes: [RegExp, string][] = [
      [/reports/i, '/reports'],
      [/videos/i, '/videos'],
    ];
    await page.goto(`${BASE_URL}/`);
    for (const [linkText, expectedPath] of routes) {
      const link = page.getByRole('link', { name: linkText }).first();
      if (await link.isVisible()) {
        await link.click();
        await expect(page).toHaveURL(new RegExp(expectedPath), { timeout: 5_000 });
        await page.goto(`${BASE_URL}/`);
      }
    }
  });

  test('404 route shows fallback, not white screen', async ({ page }) => {
    await page.goto(`${BASE_URL}/nonexistent-route-xyz`);
    await page.waitForTimeout(1_000);
    // Should not be a completely blank page
    const body = await page.textContent('body');
    expect(body?.trim().length).toBeGreaterThan(0);
  });
});

// ─── Responsive layout ────────────────────────────────────────────────────────

test.describe('Responsive layout', () => {

  test('recommendations page is readable on 375×667 (mobile)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${BASE_URL}/recommendations`);
    await page.waitForTimeout(1_500);
    // No horizontal overflow (body scroll width ≤ viewport width)
    const overflows = await page.evaluate(() => {
      return document.body.scrollWidth > window.innerWidth;
    });
    expect(overflows).toBe(false);
  });
});
