import { e2eEnv, expect, FORBIDDEN_URL_TOKENS, KNOWN_CLOUD_LEAKS, mentionsAny, test } from './fixtures';
import { gotoDashboard, openAgentChat, openSlide } from './helpers';

/** Walk the main routes and return every URL the page requested. */
async function walkApp(page: Parameters<typeof gotoDashboard>[0], slideName: string | null): Promise<void> {
  const files = page.waitForResponse((res) => res.url().includes('/fm/v1/files?'));
  await gotoDashboard(page);
  await files;

  const nodes = page.waitForResponse((res) => res.url().includes('/tasks/v1/list_nodes_extended'));
  const community = page.waitForResponse((res) => res.url().includes('/community/v1/classifiers/public'));
  await page.goto('/community');
  await nodes;
  await community;

  if (slideName) {
    await openSlide(page, slideName);
    await openAgentChat(page);
    await page.getByRole('button', { name: 'Main Info' }).click();
  } else {
    await page.goto('/imageViewer');
  }
  await page.waitForTimeout(2_000);
}

test.describe('network isolation', () => {
  test('all traffic goes to the renderer, the local service or the (mocked) community', async ({ page, guards }) => {
    const { rendererOrigin, backendOrigin, communityOrigin, slideName } = e2eEnv();
    await walkApp(page, slideName);

    expect(guards.requests.length).toBeGreaterThan(0);
    expect(guards.requests.some((u) => u.startsWith(backendOrigin))).toBe(true);
    expect(guards.requests.some((u) => u.startsWith(rendererOrigin))).toBe(true);
    // The hosted community is the one remote the app talks to — here the mock.
    expect(guards.requests.some((u) => u.startsWith(communityOrigin))).toBe(true);
    // Firebase Auth never left the mocked Identity Toolkit surface.
    expect(guards.firebase.handled).toContain('accounts:signUp');
    expect(guards.firebase.unmocked).toEqual([]);
    expect(guards.unexpectedForbiddenRequests(), `requests containing ${FORBIDDEN_URL_TOKENS.join(' / ')}`).toEqual([]);

    // Anything else that is not the documented leak is reported for review.
    const foreign = guards.foreignOrigins().filter((origin) => !KNOWN_CLOUD_LEAKS.some((k) => k.startsWith(origin)));
    if (foreign.length) {
      test.info().annotations.push({ type: 'external-origins', description: foreign.join(', ') });
    }
    expect(guards.pageErrors).toEqual([]);
  });

  test.describe('strict', () => {

    test('no request ever contains vlm.ai / tissuelab.org / :5002 / Firestore / Firebase Storage', async ({ page, guards }) => {
      const { slideName } = e2eEnv();
      await walkApp(page, slideName);

      const offending = guards.requests.filter((url) => mentionsAny(url, FORBIDDEN_URL_TOKENS).length > 0);
      expect(offending, `requests containing ${FORBIDDEN_URL_TOKENS.join(' / ')}`).toEqual([]);
    });
  });
});
