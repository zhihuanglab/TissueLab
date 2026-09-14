// @vitest-environment node
/**
 * `extractAndPersist` from app/electron/ipc/tasknode-helpers.js: extracts a
 * downloaded task-node bundle into `<serviceRoot>/storage/nodes/<model>/` and
 * records its entry point in `<serviceRoot>/storage/model_registry.json`.
 *
 * The helper is plain CommonJS with no Electron imports on this code path, so
 * it is loaded through Node's own `require` (bypassing Vite) and exercised
 * against a temporary service root. Extraction shells out to the OS
 * (`Expand-Archive` / `ditto` / `unzip`), so the tests run for real.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFakeNodeZip, buildZip } from '../../helpers/zip-fixture';

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPERS_PATH = path.resolve(here, '..', '..', '..', '..', 'app', 'electron', 'ipc', 'tasknode-helpers.js');

interface ExtractResult {
  success: boolean;
  extractedPath?: string;
  error?: string;
}
interface ExtractParams {
  zipPath?: string;
  modelName?: string;
  factory?: string;
  window?: unknown;
  url?: string;
  serviceRoot?: string;
}

const { extractAndPersist } = createRequire(import.meta.url)(HELPERS_PATH) as {
  extractAndPersist: (params: ExtractParams) => Promise<ExtractResult>;
};

// Shelling out to PowerShell / unzip takes a few seconds per call on Windows.
const EXTRACT_TIMEOUT = 60_000;

let serviceRoot: string;

const nodesDir = (model: string) => path.join(serviceRoot, 'storage', 'nodes', model);
const registryPath = () => path.join(serviceRoot, 'storage', 'model_registry.json');
const readRegistry = () => JSON.parse(fs.readFileSync(registryPath(), 'utf8'));

function writeZipFixture(name: string, bytes: Buffer): string {
  const zipPath = path.join(serviceRoot, name);
  fs.writeFileSync(zipPath, bytes);
  return zipPath;
}

beforeEach(() => {
  serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-extract-'));
});

afterEach(() => {
  fs.rmSync(serviceRoot, { recursive: true, force: true, maxRetries: 3 });
});

describe('extractAndPersist', () => {
  it(
    'extracts the bundle under storage/nodes/<model>, records the entry point and deletes the zip',
    async () => {
      const zipPath = writeZipFixture('FakeNode.zip', buildFakeNodeZip('FakeNode'));

      const result = await extractAndPersist({ zipPath, modelName: 'FakeNode', factory: 'NucleiSeg', serviceRoot, window: undefined });

      expect(result).toEqual({ success: true, extractedPath: nodesDir('FakeNode') });

      // Extracted tree: the archive's top-level folder lands inside the model dir.
      const mainPy = path.join(nodesDir('FakeNode'), 'FakeNode', 'main.py');
      expect(fs.existsSync(mainPy)).toBe(true);
      expect(fs.readFileSync(mainPy, 'utf8')).toContain('hello from FakeNode');
      expect(fs.existsSync(path.join(nodesDir('FakeNode'), 'FakeNode', 'README.md'))).toBe(true);

      // Registry: nodes.<model>.runtime.service_path points at main.py, factory set.
      const registry = readRegistry();
      expect(registry.nodes.FakeNode.factory).toBe('NucleiSeg');
      const servicePath: string = registry.nodes.FakeNode.runtime.service_path;
      expect(path.basename(servicePath)).toBe('main.py');
      expect(path.resolve(servicePath)).toBe(path.resolve(mainPy));
      expect(fs.existsSync(servicePath)).toBe(true);
      // Fresh registry gets the standard top-level sections.
      expect(registry).toMatchObject({ category_map: {}, category_display_names: {} });
      // Written atomically: no leftover temp file.
      expect(fs.existsSync(`${registryPath()}.tmp`)).toBe(false);

      // The downloaded archive is cleaned up.
      expect(fs.existsSync(zipPath)).toBe(false);
    },
    EXTRACT_TIMEOUT,
  );

  it(
    'merges into an existing registry without dropping other nodes or fields',
    async () => {
      fs.mkdirSync(path.join(serviceRoot, 'storage'), { recursive: true });
      fs.writeFileSync(
        registryPath(),
        JSON.stringify({
          category_map: { NucleiSeg: ['Other', 'FakeNode'] },
          category_display_names: { NucleiSeg: 'Nuclei segmentation' },
          nodes: {
            Other: { factory: 'NucleiSeg', runtime: { service_path: '/elsewhere/main.py' } },
            FakeNode: { factory: 'FromRegistry', display_name: 'Fake node', runtime: { port: 6100 } },
          },
        }),
      );
      const zipPath = writeZipFixture('FakeNode.zip', buildFakeNodeZip('FakeNode'));

      // No factory passed: the one already in the registry must survive.
      const result = await extractAndPersist({ zipPath, modelName: 'FakeNode', serviceRoot });
      expect(result.success).toBe(true);

      const registry = readRegistry();
      expect(registry.category_map).toEqual({ NucleiSeg: ['Other', 'FakeNode'] });
      expect(registry.category_display_names).toEqual({ NucleiSeg: 'Nuclei segmentation' });
      expect(registry.nodes.Other).toEqual({ factory: 'NucleiSeg', runtime: { service_path: '/elsewhere/main.py' } });
      expect(registry.nodes.FakeNode.factory).toBe('FromRegistry');
      expect(registry.nodes.FakeNode.display_name).toBe('Fake node');
      expect(registry.nodes.FakeNode.runtime.port).toBe(6100);
      expect(registry.nodes.FakeNode.runtime.service_path.endsWith('main.py')).toBe(true);
    },
    EXTRACT_TIMEOUT,
  );

  it(
    'prefers a Python entry point over other files and finds it in nested folders',
    async () => {
      const zip = buildZip([
        { name: 'bundle/README.md', data: 'readme' },
        { name: 'bundle/config.json', data: '{}' },
        { name: 'bundle/src/service.py', data: 'print(1)' },
      ]);
      const zipPath = writeZipFixture('Nested.zip', zip);

      const result = await extractAndPersist({ zipPath, modelName: 'Nested', factory: 'Seg', serviceRoot });
      expect(result.success).toBe(true);
      const servicePath: string = readRegistry().nodes.Nested.runtime.service_path;
      expect(path.basename(servicePath)).toBe('service.py');
      expect(fs.existsSync(servicePath)).toBe(true);
    },
    EXTRACT_TIMEOUT,
  );

  it(
    'reports a missing zip as {success:false, error} without throwing and leaves no registry behind',
    async () => {
      const zipPath = path.join(serviceRoot, 'does-not-exist.zip');

      const result = await extractAndPersist({ zipPath, modelName: 'Missing', factory: 'Seg', serviceRoot });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Extraction failed/);
      expect(fs.existsSync(registryPath())).toBe(false);
    },
    EXTRACT_TIMEOUT,
  );

  it(
    'reports a corrupt archive as {success:false, error} without throwing',
    async () => {
      const zipPath = writeZipFixture('corrupt.zip', Buffer.from('this is not a zip archive'));

      const result = await extractAndPersist({ zipPath, modelName: 'Corrupt', factory: 'Seg', serviceRoot });

      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error).toMatch(/Extraction failed/);
      expect(fs.existsSync(registryPath())).toBe(false);
    },
    EXTRACT_TIMEOUT,
  );

  it(
    'fails when the archive has no entry point',
    async () => {
      const zipPath = writeZipFixture('NoEntry.zip', buildZip([{ name: 'NoEntry/README.md', data: 'nothing to run' }]));

      const result = await extractAndPersist({ zipPath, modelName: 'NoEntry', factory: 'Seg', serviceRoot });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/entry point/i);
      expect(fs.existsSync(registryPath())).toBe(false);
    },
    EXTRACT_TIMEOUT,
  );

  it('rejects missing arguments up front', async () => {
    await expect(extractAndPersist({ modelName: 'X', serviceRoot })).resolves.toEqual({
      success: false,
      error: 'Missing zipPath or modelName',
    });
    await expect(extractAndPersist({ zipPath: 'x.zip', serviceRoot })).resolves.toEqual({
      success: false,
      error: 'Missing zipPath or modelName',
    });
    expect(fs.existsSync(path.join(serviceRoot, 'storage'))).toBe(false);
  });

  it(
    'emits download-progress events (extracting -> completed) on the window when a url is given',
    async () => {
      const send = vi.fn();
      const window = { webContents: { send } };
      const url = 'https://example.invalid/tasknodes/FakeNode.zip';
      const zipPath = writeZipFixture('FakeNode.zip', buildFakeNodeZip('FakeNode'));

      const result = await extractAndPersist({ zipPath, modelName: 'FakeNode', factory: 'Seg', serviceRoot, window, url });
      expect(result.success).toBe(true);

      const events = send.mock.calls.map(([channel, payload]) => ({ channel, ...payload }));
      expect(events).toEqual([
        { channel: 'download-progress', url, state: 'extracting' },
        { channel: 'download-progress', url, state: 'completed', filePath: nodesDir('FakeNode') },
      ]);
    },
    EXTRACT_TIMEOUT,
  );

  it(
    'emits a failed event when extraction fails',
    async () => {
      const send = vi.fn();
      const url = 'https://example.invalid/tasknodes/Broken.zip';
      const zipPath = writeZipFixture('Broken.zip', Buffer.from('nope'));

      const result = await extractAndPersist({ zipPath, modelName: 'Broken', serviceRoot, window: { webContents: { send } }, url });
      expect(result.success).toBe(false);

      const states = send.mock.calls.map(([, payload]) => payload.state);
      expect(states).toEqual(['extracting', 'failed']);
      expect(send.mock.calls[1][1]).toMatchObject({ url, state: 'failed' });
      expect(typeof send.mock.calls[1][1].error).toBe('string');
    },
    EXTRACT_TIMEOUT,
  );
});
