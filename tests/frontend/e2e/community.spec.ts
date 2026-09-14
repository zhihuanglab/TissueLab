import defaults from '../../../app/render/constants/communityWorkflowsDefault.json';
import { e2eEnv, expect, test } from './fixtures';
import { bootSession } from './helpers';
import { MOCK_AUTHORS, MOCK_CLASSIFIERS, MOCK_MODELS, MOCK_WORKFLOWS, type RecordedCommunityRequest } from './mock-community-server';

/**
 * The Community page against the mock of the hosted TissueLab server.
 *
 * The page boots the way the hosted app does: an anonymous Firebase session
 * (answered by the Identity Toolkit mock) whose ID token is sent to the
 * community; local task nodes still come from the local service.
 */
async function recorded(communityURL: string): Promise<RecordedCommunityRequest[]> {
  const res = await fetch(`${communityURL}/__e2e/requests`);
  return (await res.json()) as RecordedCommunityRequest[];
}

test.describe('Community page (/community)', () => {
  test.beforeEach(async () => {
    await fetch(`${e2eEnv().communityURL}/__e2e/reset`);
  });

  test('browses classifiers from the hosted community with the anonymous Firebase token, showing author names', async ({ page, guards }) => {
    const { backendOrigin, communityOrigin, communityURL } = e2eEnv();

    // The anonymous session is created through the mocked Identity Toolkit on the first page.
    await bootSession(page, guards.firebase.idToken);
    expect(guards.firebase.handled).toContain('accounts:signUp');

    const classifiers = page.waitForResponse((res) => res.url().includes('/community/v1/classifiers/public'));
    const nodes = page.waitForResponse((res) => res.url().includes('/tasks/v1/list_nodes_extended'));
    await page.goto('/community');

    const list = await classifiers;
    expect(new URL(list.url()).origin).toBe(communityOrigin);
    expect((await list.json()).code).toBe(0);
    expect(new URL((await nodes).url()).origin).toBe(backendOrigin);

    // … and its ID token is what the community received.
    const publicList = (await recorded(communityURL)).find((r) => r.path === '/community/v1/classifiers/public');
    expect(publicList?.authorization).toBe(`Bearer ${guards.firebase.idToken}`);

    // The original three tabs.
    for (const name of ['Models', 'Workflows', 'Factories']) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }

    // Home: the classifiers of the selected model, with the authors resolved
    // through /community/v1/users/{uid}/public-profile.
    for (const c of MOCK_CLASSIFIERS) {
      await expect(page.getByText(c.title, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    }
    for (const author of Object.values(MOCK_AUTHORS)) {
      await expect(page.getByText(author.displayName, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    }

    // Upload / star controls exactly as in the original (not gated for anonymous sessions).
    await expect(page.getByRole('button', { name: 'Upload Classifier' })).toBeVisible();
    const star = page.getByTitle('Add star').first();
    await expect(star).toBeEnabled();
    const starResponse = page.waitForResponse((res) => res.url().includes('/star') && res.request().method() === 'POST');
    await star.click();
    await starResponse;
    await expect(page.getByTitle('Remove star').first()).toBeVisible();
    const starCall = (await recorded(communityURL)).find((r) => r.method === 'POST' && r.path.endsWith('/star'));
    expect(starCall?.authorization).toBe(`Bearer ${guards.firebase.idToken}`);

    // Every community request carried the token; the mock never answered a 401.
    const unauthenticated = (await recorded(communityURL)).filter((r) => !r.path.includes('/download/') && !r.authorization);
    expect(unauthenticated).toEqual([]);

    await page.waitForTimeout(1_000);
    expect(guards.pageErrors, 'uncaught page errors on the Community page').toEqual([]);
    expect(guards.forbiddenConsoleErrors()).toEqual([]);
  });

  test('Workflows tab lists the hosted community workflows next to the bundled presets', async ({ page, guards }) => {
    const { communityOrigin } = e2eEnv();
    await bootSession(page, guards.firebase.idToken);
    const workflows = page.waitForResponse((res) => res.url().includes('/community/v1/workflows/public'));
    await page.goto('/community?tab=workflows');
    const res = await workflows;
    expect(new URL(res.url()).origin).toBe(communityOrigin);
    expect(res.request().headers()['authorization']).toBe(`Bearer ${guards.firebase.idToken}`);

    await expect(page.getByRole('tab', { name: 'Workflows' })).toHaveAttribute('data-state', 'active');
    await expect(page.getByText(MOCK_WORKFLOWS[0].name, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    for (const preset of defaults as Array<{ name: string }>) {
      await expect(page.getByText(preset.name, { exact: true }).first()).toBeVisible();
    }
    expect(guards.pageErrors).toEqual([]);
  });

  test('Factories tab lists the local task nodes from the local service', async ({ page, guards }) => {
    const { backendOrigin } = e2eEnv();
    await bootSession(page, guards.firebase.idToken);
    const nodesResponse = page.waitForResponse((res) => res.url().includes('/tasks/v1/list_nodes_extended'));
    await page.goto('/community?tab=factories');

    const res = await nodesResponse;
    expect(new URL(res.url()).origin).toBe(backendOrigin);
    const body = await res.json();
    expect(body.code).toBe(0);
    const nodes = Object.keys(body.data?.nodes ?? {});
    expect(nodes.length, 'the local registry lists at least one task node').toBeGreaterThan(0);
    const wellKnown = ['StarDist', 'NuClass'].filter((name) => nodes.includes(name));
    expect(wellKnown.length, `expected StarDist / NuClass in the registry, got: ${nodes.join(', ')}`).toBeGreaterThan(0);

    await expect(page.getByRole('tab', { name: 'Factories' })).toHaveAttribute('data-state', 'active');
    await expect(page.getByRole('button', { name: 'Upload New Model' })).toBeVisible();
    for (const name of wellKnown) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    }
    expect(Object.keys(body.data?.category_map ?? {}).length).toBeGreaterThan(0);
    expect(guards.pageErrors).toEqual([]);
  });

  test('an author profile page shows the author with their community classifiers and models', async ({ page, guards }) => {
    const uid = MOCK_MODELS[0].ownerId;
    await bootSession(page, guards.firebase.idToken);
    const profile = page.waitForResponse((res) => res.url().includes(`/users/v1/public_profile/${uid}`));
    await page.goto(`/profile/${uid}`);
    expect(new URL((await profile).url()).origin).toBe(e2eEnv().communityOrigin);

    await expect(page.getByText(MOCK_AUTHORS[uid].displayName, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    const ownClassifiers = MOCK_CLASSIFIERS.filter((c) => c.ownerId === uid);
    for (const c of ownClassifiers) {
      await expect(page.getByText(c.title, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    }
    await page.getByRole('tab', { name: 'Models' }).click();
    await expect(page.getByText(MOCK_MODELS[0].title, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    expect(guards.pageErrors).toEqual([]);
  });
});
