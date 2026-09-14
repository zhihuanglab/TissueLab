import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { downloadNodeForElectron } from '@/utils/agent/nodeManagement.utils';
import { envelope, installFetchMock, jsonResponse } from '../helpers/fetchMock';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));
// The session token comes from Firebase; pin it so the header assertions are stable.
vi.mock('@/utils/common/authToken', () => ({
  AUTH_MISSING_ERROR: 'Authentication required',
  LOCAL_DEFAULT_TOKEN: 'local-default-token',
  getAuthToken: vi.fn(async () => 'local'),
  forceRefreshAuthToken: vi.fn(async () => null),
  notifyMissingAuth: vi.fn(),
}));

const DOWNLOAD_URL_ENDPOINT = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/bundles/download_url`;
const RELOAD_ENDPOINT = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/reload_model_registry`;
const CATEGORIES = { NucleiSeg: ['StarDist', 'Cellpose'], NucleiClassify: ['NuClass'] };

/** Same platform derivation as the code under test (jsdom's UA is neither Mac nor Windows). */
const expectedPlatform = () => {
  const ua = navigator.userAgent;
  return ua.includes('Mac') ? 'darwin' : ua.includes('Windows') ? 'win' : 'linux';
};

function makeInstallingState(initial: Record<string, boolean> = {}) {
  let state = { ...initial };
  const setInstalling = vi.fn((update: (prev: Record<string, boolean>) => Record<string, boolean>) => {
    state = update(state);
  });
  return { setInstalling, get: () => state };
}

type ElectronMock = { invoke: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
let electron: ElectronMock;

beforeEach(() => {
  electron = {
    invoke: vi.fn(async (channel: string) => (channel === 'download-signed-url' ? { ok: true } : { success: true })),
    on: vi.fn(),
    off: vi.fn(),
  };
  (window as any).electron = electron;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete (window as any).electron;
});

describe('utils/agent/nodeManagement.utils — downloadNodeForElectron', () => {
  it('asks the local service for a signed bundle URL and hands it to Electron', async () => {
    const { calls } = installFetchMock([
      {
        method: 'POST',
        match: '/tasks/v1/bundles/download_url',
        reply: () => envelope({ success: true, download_url: 'https://bundles.example/StarDist-win.tar.gz', filename: 'StarDist-win.tar.gz' }),
      },
    ]);
    const installing = makeInstallingState();

    await downloadNodeForElectron('StarDist', CATEGORIES, {}, installing.setInstalling);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DOWNLOAD_URL_ENDPOINT);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('authorization')).toBe('Bearer local');
    expect(calls[0].body).toEqual({ model_name: 'StarDist', platform: expectedPlatform() });

    // Progress listener is registered before the download starts.
    expect(electron.on).toHaveBeenCalledWith('download-progress', expect.any(Function));
    expect(electron.invoke).toHaveBeenCalledTimes(1);
    expect(electron.invoke).toHaveBeenCalledWith('download-signed-url', {
      url: 'https://bundles.example/StarDist-win.tar.gz',
      filename: 'StarDist-win.tar.gz',
      showSaveDialog: false,
    });
    expect(electron.on.mock.invocationCallOrder[0]).toBeLessThan(electron.invoke.mock.invocationCallOrder[0]);
    // Still installing until Electron reports the download finished.
    expect(installing.get()).toEqual({ StarDist: true });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('extracts the bundle, reloads the registry and reports completion when the download finishes', async () => {
    const { calls } = installFetchMock([
      {
        method: 'POST',
        match: '/tasks/v1/bundles/download_url',
        reply: () => envelope({ success: true, download_url: 'https://bundles.example/StarDist.tar.gz', filename: 'StarDist.tar.gz' }),
      },
      { method: 'POST', match: '/tasks/v1/reload_model_registry', reply: () => envelope({ reloaded: true }) },
    ]);
    const installing = makeInstallingState();
    const onComplete = vi.fn();

    await downloadNodeForElectron('StarDist', CATEGORIES, {}, installing.setInstalling, onComplete);
    const onProgress = electron.on.mock.calls[0][1] as (payload: any) => Promise<void>;

    // Unrelated progress events are ignored.
    await onProgress({ url: 'https://elsewhere/other.tar.gz', state: 'completed', filePath: 'C:/tmp/other.tar.gz' });
    expect(electron.invoke).toHaveBeenCalledTimes(1);

    await onProgress({ url: 'https://bundles.example/StarDist.tar.gz', state: 'completed', filePath: 'C:/tmp/StarDist.tar.gz' });

    expect(electron.invoke).toHaveBeenCalledWith('extract-zip-and-persist', {
      zipPath: 'C:/tmp/StarDist.tar.gz',
      modelName: 'StarDist',
      factory: 'NucleiSeg',
      url: 'https://bundles.example/StarDist.tar.gz',
    });
    expect(calls.map((c) => c.url)).toEqual([DOWNLOAD_URL_ENDPOINT, RELOAD_ENDPOINT]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(installing.get()).toEqual({});
    expect(electron.off).toHaveBeenCalledWith('download-progress', onProgress);
    expect(toast.success).toHaveBeenCalled();
  });

  it('shows an info toast and downloads nothing when no bundle exists for the platform (404)', async () => {
    const { calls } = installFetchMock([
      { method: 'POST', match: '/tasks/v1/bundles/download_url', reply: () => jsonResponse({ detail: 'no bundle' }, { status: 404 }) },
    ]);
    const installing = makeInstallingState();

    await downloadNodeForElectron('NuClass', CATEGORIES, {}, installing.setInstalling);

    expect(calls).toHaveLength(1);
    expect(toast.info).toHaveBeenCalledWith('No bundle available for your platform yet');
    expect(toast.error).not.toHaveBeenCalled();
    expect(electron.invoke).not.toHaveBeenCalled();
    expect(installing.get()).toEqual({});
  });

  it('reports other failures with an error toast and clears the installing flag', async () => {
    installFetchMock([{ method: 'POST', match: '/tasks/v1/bundles/download_url', reply: () => envelope({}, 500, 'bundle host unreachable') }]);
    const installing = makeInstallingState();

    await downloadNodeForElectron('NuClass', CATEGORIES, {}, installing.setInstalling);

    expect(toast.error).toHaveBeenCalledWith('bundle host unreachable');
    expect(electron.invoke).not.toHaveBeenCalled();
    expect(installing.get()).toEqual({});
  });

  it('refuses to start a second download of a node that is already installing', async () => {
    const { calls } = installFetchMock([]);
    const installing = makeInstallingState({ StarDist: true });

    await downloadNodeForElectron('StarDist', CATEGORIES, { StarDist: true }, installing.setInstalling);

    expect(calls).toHaveLength(0);
    expect(toast.info).toHaveBeenCalledWith('This tasknode is already being installed');
    expect(electron.invoke).not.toHaveBeenCalled();
  });
});
