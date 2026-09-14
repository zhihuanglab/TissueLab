import Module from 'node:module';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for the renderer against the real local service.
 *
 *     cd app/render && npm run test:e2e                        # all projects
 *     cd app/render && npx playwright test --project=chromium  # web mode only
 *     cd app/render && npx playwright test --project=electron  # Electron shell (dev entry)
 *     cd app/render && npx playwright test --project=packaged  # built app (needs TL_PACKAGED_APP)
 *
 * `tests/frontend/e2e/global-setup.ts` boots the mock LLM, the Python service
 * and the Next.js renderer once per run and publishes their addresses through
 * `process.env.TL_E2E_*` (see `tests/frontend/e2e/fixtures.ts`).
 *
 * Projects:
 *   chromium  the renderer in a browser (web mode)
 *   electron  `app/electron/main_electron.js` launched through Playwright's
 *             `_electron`, pointed at the same renderer / service
 *   packaged  the electron-builder output; skipped unless TL_PACKAGED_APP
 *             points at the executable (it boots its own service)
 *
 * Environment knobs:
 *   TL_PYTHON        interpreter for the service (default: the tissuelab-ai conda env)
 *   TL_TEST_SLIDE    whole-slide image copied into the local user's storage
 *   TL_PACKAGED_APP  built executable for the `packaged` project
 *   TL_E2E_BUILD=1   run `next build && next start` instead of `next dev`
 *   TL_E2E_KEEP=1    keep the temporary service root (logs, storage) after the run
 */
const renderRoot = __dirname;
const e2eDir = path.resolve(renderRoot, '..', '..', 'tests', 'frontend', 'e2e');

// The spec files live outside this package. Node resolves bare imports such as
// `@playwright/test` by walking up from the importing file, so add this
// package's node_modules as a fallback lookup path. NODE_PATH is inherited by
// the worker processes, which re-evaluate this config as well.
const nodeModules = path.join(renderRoot, 'node_modules');
if (!(process.env.NODE_PATH || '').split(path.delimiter).includes(nodeModules)) {
  process.env.NODE_PATH = [nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  (Module as unknown as { _initPaths: () => void })._initPaths();
}

const ELECTRON_SPECS = ['**/electron.spec.ts', '**/packaged.spec.ts'];

export default defineConfig({
  testDir: e2eDir,
  globalSetup: path.join(e2eDir, 'global-setup.ts'),
  outputDir: path.join(renderRoot, 'test-results'),
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ELECTRON_SPECS,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'electron',
      testMatch: '**/electron.spec.ts',
    },
    {
      name: 'packaged',
      testMatch: '**/packaged.spec.ts',
      timeout: 300_000,
    },
  ],
});
