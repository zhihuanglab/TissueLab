/**
 * Electron shell (development entry `app/electron/main_electron.js`) driven
 * through Playwright's `_electron` API.
 *
 *     cd app/render && npx playwright test --project=electron
 *
 * The shell is pointed at the `next dev` renderer and the Python service that
 * `global-setup.ts` boots (TL_RENDERER_URL / PUBLIC_AI_SERVICE_API_ENDPOINT),
 * and at a temporary TL_SERVICE_ROOT so downloads / extracted task nodes never
 * land in the checkout. The dev entry does not spawn a backend of its own.
 *
 * Every IPC channel the renderer uses is exercised through
 * `window.electron.invoke` exactly as the renderer would call it, then the
 * Electron-mode dashboard (`LocalFileManager`) is driven once end-to-end:
 * list a local folder, click the slide, viewer opens, tiles come from the
 * local service.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { buildFakeNodeZip } from '../helpers/zip-fixture';
import { e2eEnv, FORBIDDEN_CONSOLE_TOKENS, FORBIDDEN_URL_TOKENS, mentionsAny, renderLoopErrors } from './fixtures';
import { MOCK_CLASSIFIERS } from './mock-community-server';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'app');
const MAIN_ENTRY = path.join(APP_ROOT, 'electron', 'main_electron.js');

// `require('electron')` resolves to the path of the Electron executable.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ELECTRON_BINARY = require(path.join(APP_ROOT, 'node_modules', 'electron')) as string;

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

/** `window.electron.invoke(channel, ...args)` from inside the renderer. */
function invoke<T = unknown>(page: Page, channel: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ channel, args }) => (window as unknown as { electron: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).electron.invoke(channel, ...args),
    { channel, args },
  ) as Promise<T>;
}

/** Same, but resolve with the rejection message instead of throwing. */
function invokeError(page: Page, channel: string, ...args: unknown[]): Promise<string | null> {
  return page.evaluate(
    async ({ channel, args }) => {
      try {
        await (window as unknown as { electron: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).electron.invoke(channel, ...args);
        return null;
      } catch (error) {
        return String((error as Error)?.message ?? error);
      }
    },
    { channel, args },
  );
}

/**
 * The window that shows the renderer. `main_electron.js` also opens detached
 * DevTools; depending on the Playwright version that may surface as a window
 * too, so pick by URL rather than trusting `firstWindow()`.
 */
async function rendererWindow(app: ElectronApplication, baseURL: string, timeoutMs = 90_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (candidate.url().startsWith(baseURL)) return candidate;
    }
    await Promise.race([app.waitForEvent('window', { timeout: 2_000 }).catch(() => undefined), sleep(2_000)]);
  }
  throw new Error(`no window loaded ${baseURL} within ${timeoutMs}ms (windows: ${app.windows().map((w) => w.url()).join(', ') || 'none'})`);
}

interface DownloadEvent {
  url: string;
  state: string;
  filePath?: string;
  receivedBytes?: number;
  totalBytes?: number;
  canCancel?: boolean;
  error?: string;
}

let app: ElectronApplication;
let page: Page;
let serviceRoot: string;
let localDir: string; // the folder the dashboard browses: slide + subfolder + hidden file
let opsDir: string; // scratch folder for the file-operation channels
let slideName: string | null = null;
let slideSize = 0;
const shellLog: string[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const requests: string[] = [];

test.beforeAll(async () => {
  const { baseURL } = e2eEnv();
  serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-electron-root-'));
  opsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-electron-ops-'));
  // The service keeps the opened slide's handle until it exits, which on
  // Windows blocks deleting the folder from here. Put it inside the
  // global-setup service root instead: its teardown removes it after the
  // service has been stopped.
  localDir = fs.mkdtempSync(path.join(process.env.TL_E2E_SERVICE_ROOT || os.tmpdir(), 'tl-electron-files-'));

  fs.mkdirSync(path.join(localDir, 'subfolder'));
  fs.writeFileSync(path.join(localDir, '.hidden'), 'hidden files are skipped');
  const slide = process.env.TL_TEST_SLIDE;
  if (slide && fs.existsSync(slide)) {
    slideName = path.basename(slide);
    fs.copyFileSync(slide, path.join(localDir, slideName));
    slideSize = fs.statSync(slide).size;
  }

  app = await electron.launch({
    executablePath: ELECTRON_BINARY,
    args: [MAIN_ENTRY],
    cwd: APP_ROOT,
    env: {
      ...launchEnv(),
      TL_SERVICE_ROOT: serviceRoot,
      TL_RENDERER_URL: baseURL,
    },
    timeout: 60_000,
  });
  const proc = app.process();
  proc.stdout?.on('data', (chunk: Buffer) => shellLog.push(chunk.toString()));
  proc.stderr?.on('data', (chunk: Buffer) => shellLog.push(chunk.toString()));

  page = await rendererWindow(app, baseURL);
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => requests.push(request.url()));
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  const ownedByGlobalTeardown = !!process.env.TL_E2E_SERVICE_ROOT && localDir?.startsWith(process.env.TL_E2E_SERVICE_ROOT);
  for (const dir of [serviceRoot, opsDir, ...(ownedByGlobalTeardown ? [] : [localDir])]) {
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`[electron e2e] could not remove ${dir}: ${String((error as Error)?.message ?? error)}`);
    }
  }
});

test.beforeEach(() => {
  pageErrors.length = 0;
  consoleErrors.length = 0;
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    testInfo.annotations.push({ type: 'electron-stdio', description: shellLog.slice(-40).join('') });
  }
  expect(pageErrors, `uncaught renderer errors during "${testInfo.title}"`).toEqual([]);
  expect(renderLoopErrors(consoleErrors), `React update-depth loop during "${testInfo.title}"`).toEqual([]);
});

test.describe('electron shell IPC', () => {
  test('exposes the preload bridge and loads the renderer', async () => {
    const { baseURL } = e2eEnv();
    expect(page.url().startsWith(baseURL)).toBe(true);
    const bridge = await page.evaluate(() => {
      const e = (window as unknown as { electron?: Record<string, unknown> }).electron;
      return e ? Object.keys(e).sort() : null;
    });
    expect(bridge).toEqual([
      'deleteRefreshToken',
      'getBackendPort',
      'getRefreshToken',
      'googleOAuth',
      'googleRefreshToken',
      'invoke',
      'listLocalFiles',
      'off',
      'on',
      'readFile',
      'saveRefreshToken',
      'send',
      'writeFile',
    ]);
    // The dev shell loads "/" which redirects into the dashboard.
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 60_000 });
  });

  test('path-join joins with the platform separator', async () => {
    const joined = await invoke<string>(page, 'path-join', 'a', 'b', 'c.txt');
    expect(joined).toBe(path.join('a', 'b', 'c.txt'));
    const abs = await invoke<string>(page, 'path-join', localDir, 'subfolder', '..', 'x.svs');
    expect(abs).toBe(path.join(localDir, 'x.svs'));
  });

  test('get-backend-port returns a port number (the default when no backend was spawned)', async () => {
    const port = await invoke<number>(page, 'get-backend-port');
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
    // The preload convenience wrapper is the same channel.
    const viaBridge = await page.evaluate(() => (window as unknown as { electron: { getBackendPort: () => Promise<number> } }).electron.getBackendPort());
    expect(viaBridge).toBe(port);
    // main_electron.js never spawns the service, so this is the compiled-in default.
    expect(port).toBe(5001);
  });

  test('list-local-files returns name/path/is_dir/size/mtime entries and skips hidden files', async () => {
    const entries = await invoke<Array<{ name: string; path: string; is_dir: boolean; size: number; mtime: number }>>(page, 'list-local-files', localDir);
    expect(Array.isArray(entries)).toBe(true);

    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual([...(slideName ? [slideName] : []), 'subfolder'].sort());
    expect(names).not.toContain('.hidden');

    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['is_dir', 'mtime', 'name', 'path', 'size']);
      expect(entry.path).toBe(path.join(localDir, entry.name));
      expect(typeof entry.size).toBe('number');
      expect(Number.isInteger(entry.mtime)).toBe(true);
      expect(entry.mtime).toBeGreaterThan(1_600_000_000);
    }
    const folder = entries.find((e) => e.name === 'subfolder')!;
    expect(folder.is_dir).toBe(true);
    if (slideName) {
      const slide = entries.find((e) => e.name === slideName)!;
      expect(slide.is_dir).toBe(false);
      expect(slide.size).toBe(slideSize);
    }

    // The preload wrapper is the same channel.
    const viaBridge = await page.evaluate((dir) => (window as unknown as { electron: { listLocalFiles: (d: string) => Promise<unknown[]> } }).electron.listLocalFiles(dir), localDir);
    expect(viaBridge).toEqual(entries);

    // An unreadable directory rejects (the renderer clears its saved root on that).
    const error = await invokeError(page, 'list-local-files', path.join(localDir, 'no-such-dir'));
    expect(error).toMatch(/ENOENT/);
  });

  test('create-local-folder, rename-local-file and move-local-files', async () => {
    const created = path.join(opsDir, 'created', 'nested');
    expect(await invoke(page, 'create-local-folder', created)).toBe(true);
    expect(fs.statSync(created).isDirectory()).toBe(true);
    // Idempotent (recursive mkdir).
    expect(await invoke(page, 'create-local-folder', created)).toBe(true);

    const original = path.join(opsDir, 'note.txt');
    fs.writeFileSync(original, 'rename me');
    const renamed = path.join(opsDir, 'renamed.txt');
    expect(await invoke(page, 'rename-local-file', original, renamed)).toBe(true);
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.readFileSync(renamed, 'utf8')).toBe('rename me');

    const other = path.join(opsDir, 'other.txt');
    fs.writeFileSync(other, 'move me too');
    expect(await invoke(page, 'move-local-files', [renamed, other], created)).toBe(true);
    expect(fs.existsSync(renamed)).toBe(false);
    expect(fs.existsSync(other)).toBe(false);
    expect(fs.readFileSync(path.join(created, 'renamed.txt'), 'utf8')).toBe('rename me');
    expect(fs.readFileSync(path.join(created, 'other.txt'), 'utf8')).toBe('move me too');

    // Renaming a missing file surfaces the fs error to the renderer.
    const error = await invokeError(page, 'rename-local-file', path.join(opsDir, 'missing.txt'), path.join(opsDir, 'x.txt'));
    expect(error).toMatch(/ENOENT/);
  });

  test('write-file and read-file round trip (creating parent folders)', async () => {
    const filePath = path.join(opsDir, 'deep', 'er', 'roundtrip.txt');
    const content = 'héllo from the renderer\nline 2\n';
    const written = await invoke<{ success: boolean }>(page, 'write-file', { filePath, content });
    expect(written).toEqual({ success: true });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);

    // read-file returns the raw bytes (a Buffer on the main side, a Uint8Array in the renderer).
    const readBack = await page.evaluate(async (p) => {
      const bytes = await (window as unknown as { electron: { readFile: (f: string) => Promise<Uint8Array> } }).electron.readFile(p);
      return { isBytes: bytes instanceof Uint8Array, text: new TextDecoder().decode(bytes) };
    }, filePath);
    expect(readBack).toEqual({ isBytes: true, text: content });

    const error = await invokeError(page, 'read-file', path.join(opsDir, 'nope.txt'));
    expect(error).toMatch(/Failed to read file/);
  });

  test('upload-local-files copies files into the destination folder', async () => {
    const src1 = path.join(opsDir, 'upload-a.txt');
    const src2 = path.join(opsDir, 'upload-b.bin');
    fs.writeFileSync(src1, 'a');
    fs.writeFileSync(src2, Buffer.from([0, 1, 2, 3, 255]));
    const dest = path.join(opsDir, 'upload-dest');
    fs.mkdirSync(dest);

    expect(await invoke(page, 'upload-local-files', dest, [src1, src2])).toBe(true);

    // It is a copy: sources stay, destinations match byte for byte.
    expect(fs.existsSync(src1)).toBe(true);
    expect(fs.existsSync(src2)).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'upload-a.txt'), 'utf8')).toBe('a');
    expect([...fs.readFileSync(path.join(dest, 'upload-b.bin'))]).toEqual([0, 1, 2, 3, 255]);
  });

  test('delete-local-files removes files and whole folders', async () => {
    const file = path.join(opsDir, 'delete-me.txt');
    const dir = path.join(opsDir, 'delete-dir');
    fs.writeFileSync(file, 'x');
    fs.mkdirSync(path.join(dir, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'inner', 'f.txt'), 'y');

    expect(await invoke(page, 'delete-local-files', [file, dir])).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);

    const error = await invokeError(page, 'delete-local-files', [path.join(opsDir, 'already-gone.txt')]);
    expect(error).toMatch(/ENOENT/);
  });

  test('show-item-in-folder rejects an invalid path instead of opening anything', async () => {
    expect(await invokeError(page, 'show-item-in-folder', '')).toMatch(/Invalid path/);
    expect(await invokeError(page, 'show-item-in-folder', 42)).toMatch(/Invalid path/);
  });

  test('cancel-download of an unknown url reports no active download', async () => {
    const result = await invoke<{ ok: boolean; error?: string }>(page, 'cancel-download', 'https://example.invalid/tasknodes/nothing.zip');
    expect(result).toEqual({ ok: false, error: 'No active download found' });
  });

  test('download-signed-url stores the bundle under TL_SERVICE_ROOT and extract-zip-and-persist installs it', async () => {
    test.setTimeout(180_000);
    const zip = buildFakeNodeZip('FakeNode');
    const server = http.createServer((req, res) => {
      if (req.url === '/tasknodes/FakeNode.zip') {
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': zip.length,
          'Content-Disposition': 'attachment; filename="FakeNode.zip"',
        });
        res.end(zip);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/tasknodes/FakeNode.zip`;

    try {
      // Register the listener first, like nodeManagement.utils.ts does.
      await page.evaluate(() => {
        const w = window as unknown as { __dl: DownloadEvent[]; __dlListener: (e: DownloadEvent) => void; electron: { on: (c: string, cb: (e: DownloadEvent) => void) => void } };
        w.__dl = [];
        w.__dlListener = (event) => w.__dl.push(event);
        w.electron.on('download-progress', w.__dlListener);
      });

      const started = await invoke<{ ok: boolean; started?: boolean; target?: string; error?: string }>(page, 'download-signed-url', {
        url,
        filename: 'FakeNode.zip',
        showSaveDialog: false,
      });
      const expectedTarget = path.join(serviceRoot, 'storage', 'tasknodes', 'FakeNode.zip');
      expect(started).toEqual({ ok: true, started: true, target: expectedTarget });

      await page.waitForFunction(() => (window as unknown as { __dl: DownloadEvent[] }).__dl.some((e) => e.state === 'completed' || e.state === 'failed' || e.state === 'cancelled' || e.state === 'interrupted'), null, { timeout: 60_000 });
      let events = await page.evaluate(() => (window as unknown as { __dl: DownloadEvent[] }).__dl);
      const done = events.find((e) => e.state !== 'progressing')!;
      expect(done, `download events: ${JSON.stringify(events)}`).toMatchObject({ url, state: 'completed', filePath: expectedTarget });
      for (const progress of events.filter((e) => e.state === 'progressing')) {
        expect(progress).toMatchObject({ url, canCancel: true });
        expect(typeof progress.receivedBytes).toBe('number');
      }
      expect(fs.existsSync(expectedTarget)).toBe(true);
      expect(fs.readFileSync(expectedTarget).equals(zip)).toBe(true);
      // Nothing was written into the checkout's service folder.
      expect(fs.existsSync(path.join(APP_ROOT, 'service', 'storage', 'tasknodes', 'FakeNode.zip'))).toBe(false);

      // Now the second half of the install flow.
      await page.evaluate(() => {
        (window as unknown as { __dl: DownloadEvent[] }).__dl = [];
      });
      const extracted = await invoke<{ success: boolean; extractedPath?: string; error?: string }>(page, 'extract-zip-and-persist', {
        zipPath: done.filePath,
        modelName: 'FakeNode',
        factory: 'NucleiSeg',
        url,
      });
      const nodesDir = path.join(serviceRoot, 'storage', 'nodes', 'FakeNode');
      expect(extracted).toEqual({ success: true, extractedPath: nodesDir });

      const mainPy = path.join(nodesDir, 'FakeNode', 'main.py');
      expect(fs.existsSync(mainPy)).toBe(true);
      expect(fs.readFileSync(mainPy, 'utf8')).toContain('hello from FakeNode');

      const registryPath = path.join(serviceRoot, 'storage', 'model_registry.json');
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      expect(registry.nodes.FakeNode.factory).toBe('NucleiSeg');
      expect(path.resolve(registry.nodes.FakeNode.runtime.service_path)).toBe(path.resolve(mainPy));

      // The archive is removed after a successful extraction.
      expect(fs.existsSync(expectedTarget)).toBe(false);

      events = await page.evaluate(() => (window as unknown as { __dl: DownloadEvent[] }).__dl);
      expect(events.map((e) => e.state)).toEqual(['extracting', 'completed']);
      expect(events[1]).toMatchObject({ url, filePath: nodesDir });

      // A second download of the same filename does not overwrite: it gets a suffix.
      const again = await invoke<{ ok: boolean; target?: string }>(page, 'download-signed-url', { url, filename: 'FakeNode.zip', showSaveDialog: false });
      expect(again.ok).toBe(true);
      expect(again.target).toBe(expectedTarget); // the first one was deleted by the extraction
      await page.waitForFunction(() => (window as unknown as { __dl: DownloadEvent[] }).__dl.filter((e) => e.state === 'completed').length >= 2, null, { timeout: 60_000 });
      const third = await invoke<{ ok: boolean; target?: string }>(page, 'download-signed-url', { url, filename: 'FakeNode.zip', showSaveDialog: false });
      expect(third.target).toBe(path.join(serviceRoot, 'storage', 'tasknodes', 'FakeNode-1.zip'));
      await page.waitForFunction(() => (window as unknown as { __dl: DownloadEvent[] }).__dl.filter((e) => e.state === 'completed').length >= 3, null, { timeout: 60_000 });
      expect(fs.existsSync(third.target!)).toBe(true);
    } finally {
      await page.evaluate(() => {
        const w = window as unknown as { __dlListener?: (e: DownloadEvent) => void; electron: { off: (c: string, cb: (e: DownloadEvent) => void) => void } };
        if (w.__dlListener) w.electron.off('download-progress', w.__dlListener);
      }).catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('download-signed-url without a url fails cleanly', async () => {
    const result = await invoke<{ ok: boolean; error?: string }>(page, 'download-signed-url', { showSaveDialog: false });
    expect(result).toEqual({ ok: false, error: 'Missing URL' });
  });
});

test.describe('electron dashboard (LocalFileManager)', () => {
  test('lists the local folder and opens the slide in the viewer through the local service', async () => {
    test.skip(!slideName, 'no test slide available (set TL_TEST_SLIDE)');
    test.setTimeout(240_000);
    const { baseURL, backendOrigin } = e2eEnv();
    const slidePath = path.join(localDir, slideName!);

    // LocalFileManager restores its root folder from localStorage on mount;
    // that replaces the native folder picker (`open-folder-dialog`).
    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((dir) => window.localStorage.setItem('tissuelab_local_root_folder', dir), localDir);
    const firstRequestIndex = requests.length;
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Electron mode renders the local file manager, not the web storage cards.
    await expect(page.getByRole('button', { name: 'Open Folder' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Personal', { exact: true })).toHaveCount(0);

    const row = page.getByRole('row').filter({ has: page.getByText(slideName!, { exact: true }) }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('row').filter({ has: page.getByText('subfolder', { exact: true }) }).first()).toBeVisible();
    await expect(page.getByText('.hidden', { exact: true })).toHaveCount(0);

    // Click -> POST /load/v1/upload_path with the absolute path -> viewer with tiles.
    const uploadPath = page.waitForRequest((req) => req.url().includes('/load/v1/upload_path') && req.method() === 'POST', { timeout: 60_000 });
    const tile = page.waitForResponse((res) => res.url().includes('/load/v1/tile/') && res.status() === 200, { timeout: 120_000 });
    await row.click();

    const upload = await uploadPath;
    expect(new URL(upload.url()).origin).toBe(backendOrigin);
    expect(upload.postData() ?? '').toContain(slidePath);
    const uploadResponse = await upload.response();
    expect(uploadResponse?.status()).toBe(200);

    await expect(page).toHaveURL(/\/imageViewer/, { timeout: 90_000 });
    await expect(page.locator('.openseadragon-canvas canvas').first()).toBeVisible({ timeout: 90_000 });

    const tileResponse = await tile;
    const tileUrl = new URL(tileResponse.url());
    expect(tileUrl.origin).toBe(backendOrigin);
    expect(tileUrl.pathname).toMatch(/\/load\/v1\/tile\/\d+\/\d+_\d+\.jpeg$/);
    expect(tileResponse.headers()['content-type'] ?? '').toMatch(/image\//);
    expect((await tileResponse.body()).length).toBeGreaterThan(100);

    // Same hygiene as the web-mode suite: no cloud hosts, no leftover cloud wiring.
    await page.waitForTimeout(1_500);
    const since = requests.slice(firstRequestIndex);
    expect(since.filter((u) => mentionsAny(u, FORBIDDEN_URL_TOKENS).length > 0), 'requests to cloud hosts').toEqual([]);
    expect(
      consoleErrors.filter((m) => mentionsAny(m, FORBIDDEN_CONSOLE_TOKENS).length > 0),
      'console errors mentioning firebase / Firestore / 5002 / ctrl',
    ).toEqual([]);
    if (consoleErrors.length) {
      test.info().annotations.push({ type: 'console-errors', description: consoleErrors.join('\n') });
    }
  });

  test('Community page: local Factories work without an account, the hosted community asks for a sign-in', async () => {
    test.setTimeout(180_000);
    const { baseURL, backendOrigin, communityURL } = e2eEnv();
    await fetch(`${communityURL}/__e2e/reset`);

    const nodes = page.waitForResponse((res) => res.url().includes('/tasks/v1/list_nodes_extended'), { timeout: 90_000 });
    await page.goto(`${baseURL}/community?tab=factories`, { waitUntil: 'domcontentloaded' });
    const body = await (await nodes).json();
    const registered = Object.keys(body.data?.nodes ?? {});
    expect(registered.length).toBeGreaterThan(0);
    const wellKnown = ['StarDist', 'NuClass'].filter((name) => registered.includes(name));
    expect(wellKnown.length).toBeGreaterThan(0);

    // No Firebase session on the desktop until the user signs in with Google:
    // the community is not fetched (apiFetch refuses hosted calls without a
    // token) and the original sign-in modal is opened instead.
    const signIn = page.getByRole('dialog').filter({ hasText: 'Continue to TissueLab' });
    await expect(signIn).toBeVisible({ timeout: 60_000 });
    const mockSaw = (await (await fetch(`${communityURL}/__e2e/requests`)).json()) as Array<{ path: string; authorization: string | null }>;
    expect(mockSaw.filter((r) => r.path.startsWith('/community/'))).toEqual([]);
    // The desktop app never signed in on its own: no Identity Toolkit / Firebase traffic.
    expect(requests.filter((u) => /googleapis\.com|firebaseio\.com|firebaseapp\.com/i.test(u))).toEqual([]);
    expect(requests.some((u) => u.startsWith(backendOrigin) && u.includes('/tasks/v1/list_nodes_extended'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(signIn).toBeHidden();

    // The local Factories keep working without an account.
    await expect(page.getByRole('tab', { name: 'Factories' })).toHaveAttribute('data-state', 'active', { timeout: 60_000 });
    for (const name of wellKnown) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    }
    await expect(page.getByRole('button', { name: 'Upload New Model' })).toBeVisible();
    // Nothing from the hosted list can be on the page without a session.
    await expect(page.getByText(MOCK_CLASSIFIERS[0].title, { exact: true })).toHaveCount(0);
  });
});
