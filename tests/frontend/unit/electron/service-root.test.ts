// @vitest-environment node
/**
 * `getServiceRoot(app)` from app/electron/ipc/service-root.js decides where
 * Electron writes on the Python service's behalf:
 *
 *   TL_SERVICE_ROOT env  >  packaged: app.getPath('userData')  >  dev: app/service
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(here, '..', '..', '..', '..', 'app', 'electron');

interface FakeApp {
  isPackaged: boolean;
  getPath: (name: string) => string;
}

const { getServiceRoot } = createRequire(import.meta.url)(path.join(ELECTRON_DIR, 'ipc', 'service-root.js')) as {
  getServiceRoot: (app?: FakeApp) => string;
};

const fakeApp = (isPackaged: boolean, userData = 'C:\\Users\\someone\\AppData\\Roaming\\TissueLab'): FakeApp => ({
  isPackaged,
  getPath: vi.fn((name: string) => (name === 'userData' ? userData : `/unexpected/${name}`)),
});

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.TL_SERVICE_ROOT;
  delete process.env.TL_SERVICE_ROOT;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.TL_SERVICE_ROOT;
  else process.env.TL_SERVICE_ROOT = savedEnv;
});

describe('getServiceRoot', () => {
  it('honours TL_SERVICE_ROOT over everything else', () => {
    vi.stubEnv('TL_SERVICE_ROOT', 'D:\\tl-root');
    const packaged = fakeApp(true);
    expect(getServiceRoot(packaged)).toBe('D:\\tl-root');
    expect(packaged.getPath).not.toHaveBeenCalled();
    expect(getServiceRoot(fakeApp(false))).toBe('D:\\tl-root');
    expect(getServiceRoot(undefined)).toBe('D:\\tl-root');
  });

  it('ignores an empty TL_SERVICE_ROOT', () => {
    vi.stubEnv('TL_SERVICE_ROOT', '');
    expect(getServiceRoot(fakeApp(true, 'C:\\ud'))).toBe('C:\\ud');
  });

  it('uses the per-user app data folder when packaged', () => {
    const app = fakeApp(true, 'C:\\ud\\TissueLab');
    expect(getServiceRoot(app)).toBe('C:\\ud\\TissueLab');
    expect(app.getPath).toHaveBeenCalledTimes(1);
    expect(app.getPath).toHaveBeenCalledWith('userData');
  });

  it('falls back to the app/service checkout in development', () => {
    const expected = path.resolve(ELECTRON_DIR, '..', 'service');
    const app = fakeApp(false);
    expect(path.resolve(getServiceRoot(app))).toBe(expected);
    expect(app.getPath).not.toHaveBeenCalled();
    // The helpers call it without an app object in some code paths.
    expect(path.resolve(getServiceRoot(undefined))).toBe(expected);
  });
});
