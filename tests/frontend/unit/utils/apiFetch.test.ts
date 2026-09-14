import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/utils/common/apiFetch';
import { AI_SERVICE_API_ENDPOINT, COMMUNITY_API_ENDPOINT } from '@/config/api.config';
import { isPathAccessDenied } from '@/utils/common/pathAccess.utils';
import { envelope, installFetchMock, jsonResponse, textResponse, UUID_RE } from '../helpers/fetchMock';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));

// The session token comes from Firebase (utils/common/authToken); stub it so
// each test decides whether a token exists and what a forced refresh returns.
const auth = vi.hoisted(() => ({
  token: 'firebase-token' as string | null,
  refreshed: 'refreshed-token' as string | null,
  notifyMissingAuth: vi.fn(),
  forceRefreshAuthToken: vi.fn(),
}));
vi.mock('@/utils/common/authToken', () => ({
  AUTH_MISSING_ERROR: 'Authentication required',
  LOCAL_DEFAULT_TOKEN: 'local-default-token',
  getAuthToken: vi.fn(async () => auth.token),
  forceRefreshAuthToken: (...args: unknown[]) => {
    auth.forceRefreshAuthToken(...args);
    return Promise.resolve(auth.refreshed);
  },
  notifyMissingAuth: (...args: unknown[]) => auth.notifyMissingAuth(...args),
}));

const LOCAL_URL = `${AI_SERVICE_API_ENDPOINT}/example`;
const COMMUNITY_URL = `${COMMUNITY_API_ENDPOINT}/community/v1/classifiers/public`;

beforeEach(() => {
  auth.token = 'firebase-token';
  auth.refreshed = 'refreshed-token';
});

describe('utils/common/apiFetch', () => {
  it('sends the Firebase bearer token, a stable X-Device-Id and JSON content type to the local service', async () => {
    const { calls } = installFetchMock([{ match: '/api/example', reply: () => envelope({ ok: true }) }]);

    const result = await apiFetch(LOCAL_URL, { method: 'POST', body: JSON.stringify({ a: 1 }) });
    expect(result).toEqual({ ok: true });

    const [first] = calls;
    expect(first.method).toBe('POST');
    expect(first.headers.get('authorization')).toBe('Bearer firebase-token');
    expect(first.headers.get('x-device-id')).toMatch(UUID_RE);
    expect(first.headers.get('content-type')).toBe('application/json');
    expect(first.headers.has('x-instance-id')).toBe(false);
    expect(first.body).toEqual({ a: 1 });

    await apiFetch(LOCAL_URL, { method: 'GET' });
    expect(calls[1].headers.get('x-device-id')).toBe(first.headers.get('x-device-id'));
    expect(window.sessionStorage.getItem('tissuelab-device-id')).toBe(first.headers.get('x-device-id'));
  });

  it('sends the same Firebase bearer token to the hosted community', async () => {
    const { calls } = installFetchMock([{ match: '/community/v1/classifiers/public', reply: () => envelope({ classifiers: [] }) }]);
    await expect(apiFetch(COMMUNITY_URL, { method: 'GET' })).resolves.toEqual({ classifiers: [] });
    expect(calls[0].url).toBe(COMMUNITY_URL);
    expect(calls[0].url.startsWith('https://ctrl.vlm.ai/api')).toBe(true);
    expect(calls[0].headers.get('authorization')).toBe('Bearer firebase-token');
  });

  it('without a token, a local request still goes out — just without an Authorization header', async () => {
    auth.token = null;
    const { calls } = installFetchMock([{ match: '/api/example', reply: () => envelope({ ok: true }) }]);
    await expect(apiFetch(LOCAL_URL, { method: 'GET' })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.has('authorization')).toBe(false);
    expect(auth.notifyMissingAuth).not.toHaveBeenCalled();
  });

  it('without a token, a community request asks for a sign-in and rejects before hitting the network', async () => {
    auth.token = null;
    const { calls } = installFetchMock([{ match: '/community/', reply: () => envelope({}) }]);
    await expect(apiFetch(COMMUNITY_URL, { method: 'GET' })).rejects.toThrow('Authentication required');
    expect(calls).toHaveLength(0);
    expect(auth.notifyMissingAuth).toHaveBeenCalledTimes(1);
  });

  it('sends the local placeholder token to the local service only; the community gets a sign-in prompt', async () => {
    auth.token = 'local-default-token';
    const { calls } = installFetchMock([{ match: '/api/example', reply: () => envelope({ ok: true }) }]);
    await expect(apiFetch(LOCAL_URL, { method: 'GET' })).resolves.toEqual({ ok: true });
    expect(calls[0].headers.get('authorization')).toBe('Bearer local-default-token');

    await expect(apiFetch(COMMUNITY_URL, { method: 'GET' })).rejects.toThrow('Authentication required');
    expect(calls).toHaveLength(1);
    expect(auth.notifyMissingAuth).toHaveBeenCalledTimes(1);
  });

  it('refreshes the token once and replays when the community answers { code: 401 } on HTTP 200', async () => {
    let attempt = 0;
    const { calls } = installFetchMock([
      {
        match: '/community/v1/classifiers/public',
        reply: () => (attempt++ === 0 ? envelope(null, 401, 'Token expired') : envelope({ classifiers: [1] })),
      },
    ]);
    await expect(apiFetch(COMMUNITY_URL, { method: 'GET' })).resolves.toEqual({ classifiers: [1] });
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get('authorization')).toBe('Bearer firebase-token');
    expect(calls[1].headers.get('authorization')).toBe('Bearer refreshed-token');
    expect(auth.forceRefreshAuthToken).toHaveBeenCalledTimes(1);
  });

  it('surfaces the 401 as an ApiError when the refresh yields no token', async () => {
    auth.refreshed = null;
    const { calls } = installFetchMock([{ match: '/community/', reply: () => envelope(null, 401, 'No authentication token provided.') }]);
    const error = await apiFetch(COMMUNITY_URL, { method: 'GET' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(401);
    expect(error.message).toBe('No authentication token provided.');
    expect(calls).toHaveLength(1);
  });

  it('keeps a caller-provided Authorization header and attaches X-Instance-ID only when asked', async () => {
    const { calls } = installFetchMock([{ match: '/api/example', reply: () => envelope({}) }]);

    await apiFetch(LOCAL_URL, { method: 'GET', headers: { Authorization: 'Bearer custom' }, instanceId: 'inst-1' });
    expect(calls[0].headers.get('authorization')).toBe('Bearer custom');
    expect(calls[0].headers.get('x-instance-id')).toBe('inst-1');

    await apiFetch(LOCAL_URL, { method: 'GET', instanceId: '' });
    expect(calls[1].headers.has('x-instance-id')).toBe(false);
  });

  it('unwraps the { code: 0, data } envelope, also in axios format', async () => {
    installFetchMock([{ match: '/api/example', reply: () => envelope({ items: [1, 2] }) }]);

    await expect(apiFetch(LOCAL_URL, { method: 'GET' })).resolves.toEqual({ items: [1, 2] });

    const axiosLike = await apiFetch(LOCAL_URL, { method: 'GET', returnAxiosFormat: true });
    expect(axiosLike.status).toBe(200);
    expect(axiosLike.data).toEqual({ items: [1, 2] });
  });

  it('returns plain (non-envelope) JSON bodies untouched', async () => {
    installFetchMock([{ match: '/api/example', reply: () => jsonResponse({ defaultPath: 'users/local' }) }]);
    await expect(apiFetch(LOCAL_URL, { method: 'GET' })).resolves.toEqual({ defaultPath: 'users/local' });
  });

  it('throws ApiError for a { code: 403, data: { error_code } } denial on HTTP 200', async () => {
    installFetchMock([
      {
        match: '/api/example',
        reply: () =>
          envelope(
            { error_code: 'PUBLIC_READ_ONLY_FORBIDDEN', access_mode: 'samples', operation: 'create' },
            403,
            'Read-only samples',
          ),
      },
    ]);

    const error = await apiFetch(LOCAL_URL, { method: 'POST', body: '{}' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(403);
    expect(error.status).toBe(403);
    expect(error.message).toBe('Read-only samples');
    expect(error.errorCode).toBe('PUBLIC_READ_ONLY_FORBIDDEN');
    expect(error.accessMode).toBe('samples');
    expect(error.operation).toBe('create');
    expect(error.requestId).toBe('req-test');
    expect(isPathAccessDenied(error)).toBe(true);
  });

  it('still throws the business error when the caller asked for the raw Response', async () => {
    installFetchMock([{ match: '/api/example', reply: () => envelope({ error_code: 'VIEW_ONLY_FORBIDDEN' }, 403, 'nope') }]);
    const error = await apiFetch(LOCAL_URL, { method: 'GET', isReturnResponse: true }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.errorCode).toBe('VIEW_ONLY_FORBIDDEN');
  });

  it('hands back the Response for successful non-JSON bodies when isReturnResponse is set', async () => {
    installFetchMock([{ match: '/api/example', reply: () => textResponse('hello') }]);
    const res = (await apiFetch(LOCAL_URL, { method: 'GET', isReturnResponse: true })) as Response;
    expect(res).toBeInstanceOf(Response);
    await expect(res.text()).resolves.toBe('hello');
  });

  it('surfaces HTTP errors with status and the backend detail message', async () => {
    installFetchMock([{ match: '/api/example', reply: () => jsonResponse({ detail: 'boom' }, { status: 500 }) }]);
    const error = await apiFetch(LOCAL_URL, { method: 'GET' }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.message).toBe('boom');
    expect(error.url).toBe(LOCAL_URL);
  });

  it('attaches an axios-style response to HTTP errors in returnAxiosFormat mode', async () => {
    installFetchMock([{ match: '/api/example', reply: () => jsonResponse({ detail: 'missing' }, { status: 404 }) }]);
    const error = await apiFetch(LOCAL_URL, { method: 'POST', body: '{}', returnAxiosFormat: true }).catch((e) => e);
    expect(error.status).toBe(404);
    expect(error.response?.status).toBe(404);
    expect(error.response?.data).toEqual({ detail: 'missing' });
  });

  it('reads structured denial fields from an HTTP 403 envelope too', async () => {
    installFetchMock([
      {
        match: '/api/example',
        reply: () => envelope({ error_code: 'PUBLIC_READ_ONLY_FORBIDDEN', access_mode: 'samples', operation: 'delete' }, 403, 'denied', { status: 403 }),
      },
    ]);
    const error = await apiFetch(LOCAL_URL, { method: 'POST', body: '{}' }).catch((e) => e);
    expect(error.status).toBe(403);
    expect(error.errorCode).toBe('PUBLIC_READ_ONLY_FORBIDDEN');
    expect(error.accessMode).toBe('samples');
    expect(error.operation).toBe('delete');
    expect(isPathAccessDenied(error)).toBe(true);
  });

  it('notifies on rate limiting (code 429) and throws', async () => {
    installFetchMock([{ match: '/api/example', reply: () => envelope({}, 429, 'slow down') }]);
    const error = await apiFetch(LOCAL_URL, { method: 'GET' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(429);
    expect(toast.error).toHaveBeenCalledWith('slow down');
  });
});
