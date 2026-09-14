import { e2eEnv, expect, test } from './fixtures';
import { gotoDashboard, slideRow } from './helpers';

test.describe('dashboard (web mode)', () => {
  test('loads against the local service, shows Personal and lists the slide', async ({ page, guards }) => {
    const { backendOrigin, slideName } = e2eEnv();

    // Register the waiters before navigating: both calls fire during page load.
    const meResponse = page.waitForResponse((res) => res.url().includes('/users/v1/me') && res.request().method() === 'POST');
    const filesResponse = page.waitForResponse((res) => res.url().includes('/fm/v1/files?') && res.status() === 200);
    await gotoDashboard(page);

    // Identity comes from the local service, not a cloud ctrl service.
    const me = await meResponse;
    expect(new URL(me.url()).origin).toBe(backendOrigin);
    expect(me.status()).toBe(200);
    const body = await me.json();
    expect((body.data ?? body).user_id).toBe('local');

    // Storage cards: Personal is the default folder.
    await expect(page.getByText('Personal', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Public Samples', { exact: true }).first()).toBeVisible();

    // The file list is populated from the real backend, from the personal folder.
    const files = await filesResponse;
    expect(new URL(files.url()).origin).toBe(backendOrigin);
    expect(new URL(files.url()).searchParams.get('path')).toMatch(/^users\/local/);

    if (slideName) {
      await expect(slideRow(page, slideName)).toBeVisible({ timeout: 60_000 });
    } else {
      test.info().annotations.push({ type: 'skipped-check', description: 'no test slide (TL_TEST_SLIDE) — slide row not asserted' });
    }

    // Give late effects (workflow history, node polling, …) a moment, then check the console.
    await page.waitForTimeout(1_500);
    expect(guards.pageErrors, 'uncaught page errors').toEqual([]);
    expect(guards.forbiddenConsoleErrors(), 'console errors mentioning firebase / Firestore / 5002 / ctrl').toEqual([]);
    if (guards.consoleErrors.length) {
      test.info().annotations.push({ type: 'console-errors', description: guards.consoleErrors.join('\n') });
    }
  });

  test('the landing route redirects to the dashboard', async ({ page, guards }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    expect(guards.pageErrors).toEqual([]);
  });
});
