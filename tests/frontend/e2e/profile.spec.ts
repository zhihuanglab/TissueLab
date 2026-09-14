import { e2eEnv, expect, test } from './fixtures';
import { bootSession } from './helpers';

/**
 * Account UI for the default session. The open edition boots exactly like the
 * hosted app: an anonymous Firebase session (userIdentity 2) over the local
 * service. Anonymous users get the original "Login" entry in the sidebar
 * (Account Settings is reserved for signed-in accounts), and the sign-in modal
 * is the original one.
 */
test.describe('profile / account', () => {
  test('the anonymous session shows the Login entry and opens the TissueLab sign-in modal', async ({ page, guards }) => {
    const { backendOrigin } = e2eEnv();

    // The profile comes from the local service, carrying the anonymous Firebase token.
    const me = page.waitForResponse(
      (res) => res.url().includes('/users/v1/me') && res.request().headers()['authorization'] === `Bearer ${guards.firebase.idToken}`,
    );
    await bootSession(page, guards.firebase.idToken);
    const meResponse = await me;
    expect(new URL(meResponse.url()).origin).toBe(backendOrigin);
    const body = await meResponse.json();
    expect((body.data ?? body).user_id).toBe('local');
    expect(guards.firebase.handled).toContain('accounts:signUp');

    const login = page.getByRole('button', { name: /login/i }).first();
    await expect(login).toBeVisible();
    await login.click();

    const dialog = page.getByRole('dialog').filter({ hasText: 'Continue to TissueLab' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /continue with google/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /send verification code/i })).toBeVisible();

    // Close it again; nothing signed in, nothing left the local stack.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(guards.pageErrors).toEqual([]);
  });

});
