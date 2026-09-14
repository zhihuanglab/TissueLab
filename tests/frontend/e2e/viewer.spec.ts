import { e2eEnv, expect, test } from './fixtures';
import { openSlide } from './helpers';

test.describe('image viewer', () => {
  test('opening the slide shows an OpenSeadragon canvas fed by /load/v1/tile/', async ({ page, guards }) => {
    const { backendOrigin, slideName } = e2eEnv();
    test.skip(!slideName, 'no test slide available (set TL_TEST_SLIDE)');

    const tile = await openSlide(page, slideName!);

    expect(tile.status()).toBe(200);
    const tileUrl = new URL(tile.url());
    expect(tileUrl.origin).toBe(backendOrigin);
    expect(tileUrl.pathname).toMatch(/\/load\/v1\/tile\/\d+\/\d+_\d+\.jpeg$/);
    expect(tileUrl.searchParams.get('instance_id')).toBeTruthy();
    expect(tile.headers()['content-type'] ?? '').toMatch(/image\//);
    expect((await tile.body()).length).toBeGreaterThan(100);

    // The slide was registered through create_instance on the local service.
    expect(guards.requests.some((u) => u.startsWith(backendOrigin) && u.includes('/load/v1/create_instance'))).toBe(true);

    const canvas = page.locator('.openseadragon-canvas canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(100);
    expect(box?.height ?? 0).toBeGreaterThan(100);

    expect(guards.pageErrors, 'uncaught page errors while opening the slide').toEqual([]);
  });
});
