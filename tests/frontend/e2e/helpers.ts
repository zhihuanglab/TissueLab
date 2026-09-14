import { expect, type Locator, type Page, type Response } from '@playwright/test';

export const CHAT_INPUT_PLACEHOLDER = 'Type your message...';

/**
 * Close the VersionNotice banner if it is showing (it is pinned over the
 * bottom of the window and swallows clicks). Normally the fixture stubs the
 * version check so it never appears; this is the belt to that suspenders.
 */
export async function dismissBanners(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss notice' });
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click();
    await expect(dismiss).toBeHidden();
  }
}

export async function gotoDashboard(page: Page): Promise<void> {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await dismissBanners(page);
}

/**
 * Establish the session the way a real visit does: land on the dashboard and
 * wait until the anonymous Firebase sign-in has produced a token that reached
 * the local service (`/users/v1/me` with an Authorization header). Pages that
 * talk to the hosted community on mount (Community, profiles) are only visited
 * afterwards — on a brand-new browser profile the very first request would
 * otherwise race the sign-in, exactly as in the hosted app.
 */
export async function bootSession(page: Page, idToken: string): Promise<void> {
  const me = page.waitForResponse(
    (res) => res.url().includes('/users/v1/me') && res.request().headers()['authorization'] === `Bearer ${idToken}`,
    { timeout: 60_000 },
  );
  await gotoDashboard(page);
  await me;
}

/** The file-manager row for the slide (exact name, so `X.svs.zarr` does not match). */
export function slideRow(page: Page, slideName: string): Locator {
  return page.locator('[data-file-row]', { has: page.getByText(slideName, { exact: true }) }).first();
}

/**
 * Dashboard -> click the slide -> image viewer with an OpenSeadragon canvas.
 * Resolves with the first successful tile response.
 */
export async function openSlide(page: Page, slideName: string): Promise<Response> {
  await gotoDashboard(page);
  const row = slideRow(page, slideName);
  await expect(row).toBeVisible({ timeout: 60_000 });

  const tile = page.waitForResponse((res) => res.url().includes('/load/v1/tile/') && res.status() === 200, { timeout: 90_000 });
  await row.click();

  await expect(page).toHaveURL(/\/imageViewer/, { timeout: 60_000 });
  await expect(page.locator('.openseadragon-canvas canvas').first()).toBeVisible({ timeout: 90_000 });
  await dismissBanners(page);
  return tile;
}

/** Open the "Agentic AI" rail in the viewer and return the chat input. */
export async function openAgentChat(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Agentic AI' }).click();
  const input = page.getByPlaceholder(CHAT_INPUT_PLACEHOLDER);
  await expect(input).toBeVisible();
  return input;
}

/**
 * Type a prompt, submit it and wait for the agent endpoint the UI is expected
 * to call for it (`/agent/v1/chat`, `/agent/v1/get_steps`, …).
 */
export async function sendChat(page: Page, text: string, expectedEndpoint: string | RegExp, timeout = 90_000): Promise<Response> {
  const matches = (url: string) => (typeof expectedEndpoint === 'string' ? url.includes(expectedEndpoint) : expectedEndpoint.test(url));
  const reply = page.waitForResponse((res) => matches(res.url()), { timeout });
  const input = page.getByPlaceholder(CHAT_INPUT_PLACEHOLDER);
  await input.fill(text);
  await dismissBanners(page);
  await page.locator('form button[type="submit"]').click();
  return reply;
}

/** Sidebar avatar -> profile dropdown -> "Account Settings" dialog. */
export async function openAccountSettings(page: Page, displayName: string): Promise<Locator> {
  const nameBlock = page.getByTitle(displayName).first();
  await expect(nameBlock).toBeVisible();
  await dismissBanners(page);
  // The clickable avatar is the first child of the block that also holds the name.
  const avatar = nameBlock.locator('xpath=ancestor::div[contains(@class,"relative")][1]').locator('> span').first();
  await avatar.click();
  await page.getByRole('button', { name: 'Account Settings' }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Account Settings' });
  await expect(dialog).toBeVisible();
  return dialog;
}
