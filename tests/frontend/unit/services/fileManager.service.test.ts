import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPathAccessDenied } from '@/utils/common/pathAccess.utils';
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
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
vi.mock('@/config/firebase.config', () => ({ app: {} }));

type Service = typeof import('@/services/fileManager.service');

let service: Service;
let API: string;
let COMMUNITY: string;

// The service memoises `/fm/v1/config` and the default path at module level,
// so every test gets a freshly evaluated module.
beforeEach(async () => {
  vi.resetModules();
  ({ CTRL_SERVICE_API_ENDPOINT: API, COMMUNITY_API_ENDPOINT: COMMUNITY } = await import('@/config/api.config'));
  service = await import('@/services/fileManager.service');
});

describe('services/fileManager.service', () => {
  describe('getConfig', () => {
    it('GETs /fm/v1/config with the local bearer token and returns the plain config body', async () => {
      const { calls } = installFetchMock([
        { method: 'GET', match: '/fm/v1/config', reply: () => jsonResponse({ defaultPath: 'users/local', quota: { used: 1, limit: 2 } }) },
      ]);

      const cfg = await service.getConfig();
      expect(cfg).toEqual({ defaultPath: 'users/local', quota: { used: 1, limit: 2 } });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API}/fm/v1/config`);
      expect(calls[0].headers.get('authorization')).toBe('Bearer local');
    });

    it('unwraps an envelope-wrapped config', async () => {
      installFetchMock([{ method: 'GET', match: '/fm/v1/config', reply: () => envelope({ defaultPath: 'users/local' }) }]);
      await expect(service.getConfig()).resolves.toEqual({ defaultPath: 'users/local' });
    });

    it('shares one in-flight request and refetches on forceRefresh', async () => {
      const { calls } = installFetchMock([{ method: 'GET', match: '/fm/v1/config', reply: () => jsonResponse({ defaultPath: 'users/local' }) }]);
      await Promise.all([service.getConfig(), service.getConfig(), service.getConfig()]);
      expect(calls).toHaveLength(1);
      await service.getConfig(true);
      expect(calls).toHaveLength(2);
    });

    it('rejects with a structured error on an envelope error and does not cache it', async () => {
      const { calls } = installFetchMock([
        { method: 'GET', match: '/fm/v1/config', reply: () => envelope({ error_code: 'STORAGE_UNAVAILABLE' }, 500, 'storage offline') },
      ]);
      const error = await service.getConfig().catch((e) => e);
      // apiFetch already rejects envelope errors (ApiError) before the service's
      // own FmApiError wrapper runs; both carry the same structured fields.
      expect(['ApiError', 'FmApiError']).toContain(error.name);
      expect(error.status).toBe(500);
      expect(error.message).toBe('storage offline');
      expect(error.errorCode).toBe('STORAGE_UNAVAILABLE');
      await service.getConfig().catch(() => undefined);
      expect(calls).toHaveLength(2);
    });
  });

  describe('listFiles', () => {
    it('GETs /fm/v1/files?path=…&offset=0 and returns the bare array the backend sends without a limit', async () => {
      const rows = [
        { name: 'CMU-1.svs', path: 'users/local/CMU-1.svs', is_dir: false, size: 177552579, mtime: 1_700_000_000 },
        { name: 'folder', path: 'users/local/folder', is_dir: true, size: 0, mtime: 1_700_000_000 },
      ];
      const { calls } = installFetchMock([{ method: 'GET', match: '/fm/v1/files?', reply: () => jsonResponse(rows) }]);

      const result = await service.listFiles('users/local');
      expect(result).toEqual(rows);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API}/fm/v1/files?path=users%2Flocal&offset=0`);
      expect(calls[0].headers.get('authorization')).toBe('Bearer local');
    });

    it('encodes pagination and view options as the backend query parameters', async () => {
      const page = { items: [{ name: 'a.svs' }], pagination: { offset: 20, limit: 10, total: 31, has_more: true } };
      const { calls } = installFetchMock([{ method: 'GET', match: '/fm/v1/files?', reply: () => jsonResponse(page) }]);

      const result = await service.listFiles('users/local/sub', 20, 10, {
        sortBy: 'name',
        sortDir: 'asc',
        includeNonImage: false,
        groupZarr: true,
        dirsOnly: false,
      });
      expect(result).toEqual(page);
      const url = new URL(calls[0].url);
      expect(`${url.origin}${url.pathname}`).toBe(`${API}/fm/v1/files`);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        path: 'users/local/sub',
        offset: '20',
        limit: '10',
        sort_by: 'name',
        sort_dir: 'asc',
        include_non_image: 'false',
        group_zarr: 'true',
        dirs_only: 'false',
      });
    });

    it('clamps an unknown sort key (from stale localStorage) to mtime instead of 422-ing', async () => {
      const { calls } = installFetchMock([{ method: 'GET', match: '/fm/v1/files?', reply: () => jsonResponse([]) }]);
      await service.listFiles('users/local', 0, 5, { sortBy: 'bogus' as any, sortDir: 'sideways' as any });
      const params = new URL(calls[0].url).searchParams;
      expect(params.get('sort_by')).toBe('mtime');
      expect(params.get('sort_dir')).toBe('desc');
    });

    it('falls back to the personal path from /fm/v1/config when no path is given', async () => {
      const { calls } = installFetchMock([
        { method: 'GET', match: '/fm/v1/config', reply: () => jsonResponse({ defaultPath: 'users\\local' }) },
        { method: 'GET', match: '/fm/v1/files?', reply: () => jsonResponse([]) },
      ]);
      await service.listFiles('');
      expect(calls.map((c) => c.url)).toEqual([`${API}/fm/v1/config`, `${API}/fm/v1/files?path=users%2Flocal&offset=0`]);
    });

    it('listFilesPage always returns the paginated shape', async () => {
      installFetchMock([{ method: 'GET', match: '/fm/v1/files?', reply: () => jsonResponse({ items: [{ name: 'x' }], pagination: { offset: 0, limit: 25, total: 1, has_more: false } }) }]);
      const page = await service.listFilesPage('users/local', 0, 25);
      expect(page.items).toEqual([{ name: 'x' }]);
      expect(page.pagination).toEqual({ offset: 0, limit: 25, total: 1, has_more: false });
    });

    it('rejects with the backend denial when listing a forbidden path', async () => {
      installFetchMock([
        {
          method: 'GET',
          match: '/fm/v1/files?',
          reply: () => envelope({ error_code: 'PUBLIC_READ_ONLY_FORBIDDEN', access_mode: 'samples', operation: 'list' }, 403, 'denied'),
        },
      ]);
      const error = await service.listFiles('samples/private').catch((e) => e);
      expect(['ApiError', 'FmApiError']).toContain(error.name);
      expect(error.status).toBe(403);
      expect(error.message).toBe('denied');
      expect(error.errorCode).toBe('PUBLIC_READ_ONLY_FORBIDDEN');
      expect(error.accessMode).toBe('samples');
      expect(error.operation).toBe('list');
      expect(isPathAccessDenied(error)).toBe(true);
    });

    it('surfaces plain HTTP failures with their status', async () => {
      installFetchMock([{ method: 'GET', match: '/fm/v1/files?', reply: () => jsonResponse({ detail: 'not found' }, { status: 404 }) }]);
      const error = await service.listFiles('users/local/missing').catch((e) => e);
      expect(error.status).toBe(404);
      expect(error.message).toBe('not found');
    });
  });

  describe('community downloads (hosted TissueLab server)', () => {
    it('downloadCommunityClassifier mints a token link on the community server and opens the token URL', async () => {
      const { calls } = installFetchMock([
        { method: 'POST', match: '/community/v1/classifiers/uploaded-1/download-link', reply: () => envelope({ download_token: 'tok-1', file_name: 'x.tlcls' }) },
      ]);
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      let anchor: HTMLAnchorElement | null = null;
      const append = vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
        anchor = node as HTMLAnchorElement;
        return node;
      });

      await service.downloadCommunityClassifier('uploaded-1', 'tumor.tlcls');

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${COMMUNITY}/community/v1/classifiers/uploaded-1/download-link`);
      expect(calls[0].url.startsWith(API)).toBe(false);
      expect(calls[0].headers.get('authorization')).toBe('Bearer local');
      expect(click).toHaveBeenCalledTimes(1);
      expect(anchor!.href).toBe(`${COMMUNITY}/community/v1/classifiers/download/tok-1`);
      expect(anchor!.download).toBe('tumor.tlcls');
      click.mockRestore();
      append.mockRestore();
    });

    it('downloadCommunityModel rejects when the community returns no token', async () => {
      installFetchMock([{ method: 'POST', match: '/community/v1/models/m-1/download-link', reply: () => envelope({}) }]);
      await expect(service.downloadCommunityModel('m-1')).rejects.toThrow(/download token/);
    });
  });

  describe('getFileAccess', () => {
    it('GETs /fm/v1/files/access with the encoded path and parses the local ACL shape', async () => {
      const { calls } = installFetchMock([
        { method: 'GET', match: '/fm/v1/files/access', reply: () => jsonResponse({ path: 'users/local/CMU-1.svs', readOnly: false, shareMode: null }) },
      ]);
      const access = await service.getFileAccess('users/local/CMU-1.svs');
      expect(access).toEqual({ path: 'users/local/CMU-1.svs', readOnly: false, shareMode: null });
      expect(calls[0].url).toBe(`${API}/fm/v1/files/access?path=users%2Flocal%2FCMU-1.svs`);
      expect(calls[0].headers.get('authorization')).toBe('Bearer local');
    });

    it('reports samples as read-only (envelope-wrapped)', async () => {
      installFetchMock([{ method: 'GET', match: '/fm/v1/files/access', reply: () => envelope({ path: 'samples/CMU-1.svs', readOnly: true, shareMode: null }) }]);
      const access = await service.getFileAccess('samples/CMU-1.svs');
      expect(access.readOnly).toBe(true);
      expect(access.shareMode).toBeNull();
    });
  });
});
