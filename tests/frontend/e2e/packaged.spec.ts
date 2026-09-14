/**
 * Packaged desktop app (electron-builder output) smoke test.
 *
 *     cd app && npm run dist:win
 *     cd render && TL_PACKAGED_APP=../dist/win-unpacked/TissueLab.exe npx playwright test --project=packaged
 *
 * Skipped unless TL_PACKAGED_APP points at the built executable. The packaged
 * entry (`app/electron/main.js`) starts the Next.js standalone server and
 * spawns the frozen Python service (`TissueLab_AI.exe`) itself, against the
 * TL_SERVICE_ROOT handed to it here (a temp folder), so nothing from
 * global-setup is used. Boot can take a while on first launch: 120 s.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FORBIDDEN_CONSOLE_TOKENS, mentionsAny } from './fixtures';

const PACKAGED_APP = process.env.TL_PACKAGED_APP ? path.resolve(process.env.TL_PACKAGED_APP) : '';
const BOOT_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Environment for the Electron process. When the test runner itself runs
 * inside an Electron host (VS Code, Claude Code, …) it inherits
 * ELECTRON_RUN_AS_NODE=1, which would turn the launched binary into a bare
 * Node process ("bad option: --remote-debugging-port"). Strip it.
 */
function launchEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

/** First window that shows the renderer (the splash screen is a `file://` page). */
async function rendererWindow(app: ElectronApplication, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (/^https?:\/\//.test(candidate.url())) return candidate;
    }
    await Promise.race([app.waitForEvent('window', { timeout: 2_000 }).catch(() => undefined), sleep(2_000)]);
  }
  throw new Error(`no renderer window within ${timeoutMs}ms (windows: ${app.windows().map((w) => w.url()).join(', ') || 'none'})`);
}

test.describe('packaged app', () => {
  test.skip(!PACKAGED_APP || !fs.existsSync(PACKAGED_APP), 'TL_PACKAGED_APP is not set or does not point at a built executable');

  test('boots the frozen service, shows the Electron dashboard and serves the API', async () => {
    test.setTimeout(BOOT_TIMEOUT_MS + 120_000);
    const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-packaged-root-'));
    // Fresh Chromium profile: the installed app remembers the last local root
    // folder in localStorage, which would hide the first-run empty state.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-packaged-userdata-'));
    const shellLog: string[] = [];
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];

    const app = await electron.launch({
      executablePath: PACKAGED_APP,
      args: [`--user-data-dir=${userDataDir}`],
      env: { ...launchEnv(), TL_SERVICE_ROOT: serviceRoot },
      timeout: BOOT_TIMEOUT_MS,
    });
    const proc = app.process();
    proc.stdout?.on('data', (chunk: Buffer) => shellLog.push(chunk.toString()));
    proc.stderr?.on('data', (chunk: Buffer) => shellLog.push(chunk.toString()));

    try {
      // main.js only creates the main window once the backend answered its
      // health check, so seeing the renderer already implies the service is up.
      const page = await rendererWindow(app, BOOT_TIMEOUT_MS);
      page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.waitForLoadState('domcontentloaded');

      // Dashboard in Electron mode: the local file manager with its folder picker.
      await expect(page).toHaveURL(/\/dashboard/, { timeout: BOOT_TIMEOUT_MS });
      await expect(page).toHaveTitle('TissueLab', { timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Open Folder' })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('Click Open Folder to start browsing your local files.')).toBeVisible();

      // The spawned frozen service is reachable on the port the shell picked.
      const port = await page.evaluate(() => (window as unknown as { electron: { getBackendPort: () => Promise<number> } }).electron.getBackendPort());
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThan(0);
      const openapi = await fetch(`http://127.0.0.1:${port}/api/v1/openapi.json`, { signal: AbortSignal.timeout(30_000) });
      expect(openapi.status).toBe(200);
      const spec = (await openapi.json()) as { paths?: Record<string, unknown> };
      expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);

      // The service writes under the root Electron handed it.
      expect(fs.existsSync(path.join(serviceRoot, 'storage'))).toBe(true);

      // IPC works in the packaged build (asar + preload).
      const entries = await page.evaluate((dir) => (window as unknown as { electron: { listLocalFiles: (d: string) => Promise<Array<Record<string, unknown>>> } }).electron.listLocalFiles(dir), os.homedir());
      expect(Array.isArray(entries)).toBe(true);
      for (const entry of entries.slice(0, 5)) {
        expect(Object.keys(entry).sort()).toEqual(['is_dir', 'mtime', 'name', 'path', 'size']);
      }

      await page.waitForTimeout(1_500);
      expect(pageErrors, 'uncaught renderer errors').toEqual([]);
      expect(
        consoleErrors.filter((m) => mentionsAny(m, FORBIDDEN_CONSOLE_TOKENS).length > 0),
        'console errors mentioning firebase / Firestore / 5002 / ctrl',
      ).toEqual([]);
      if (consoleErrors.length) {
        test.info().annotations.push({ type: 'console-errors', description: consoleErrors.join('\n') });
      }
    } catch (error) {
      test.info().annotations.push({ type: 'electron-stdio', description: shellLog.slice(-60).join('') });
      throw error;
    } finally {
      await app.close().catch(() => undefined);
      // main.js kills the service on quit; give it a moment before deleting its root.
      await sleep(2_000);
      try {
        fs.rmSync(serviceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (cleanupError) {
        console.warn(`[packaged e2e] could not remove ${serviceRoot}: ${String((cleanupError as Error)?.message ?? cleanupError)}`);
      }
    }
  });
});
