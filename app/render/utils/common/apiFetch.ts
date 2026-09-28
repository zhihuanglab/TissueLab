import { getOrCreateDeviceId } from './device.utils';
import { AUTH_MISSING_ERROR, forceRefreshAuthToken, getAuthToken, LOCAL_DEFAULT_TOKEN, notifyMissingAuth, waitForAuthReady } from './authToken';
import { notifyRateLimitExceeded } from './errorNotifications';
import { AI_SERVICE_API_ENDPOINT, COMMUNITY_API_ENDPOINT, CTRL_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { ApiError, isApiResponse, normalizeApiResponse, readApiErrorDetails } from './apiResponse';

export { ApiError, payloadFromAxiosAppResponse, requireAxiosAppPayload } from './apiResponse';
export type { ApiResponse } from './apiResponse';

function extractErrorMessage(data: any, textBody: string | null, status: number): string {
  if (data && typeof data === 'object') {
    if (typeof data.detail === 'string') return data.detail;
    if (typeof data.message === 'string') return data.message;
    if (data.error && typeof data.error === 'object' && typeof data.error.message === 'string') {
      return data.error.message;
    }
    if (typeof data.error === 'string') return data.error;
  }
  return textBody || `Request failed with status ${status}`;
}

async function parseResponseBody(res: Response): Promise<{ data: any; textBody: string | null }> {
  let data: any = null;
  let textBody: string | null = null;
  try {
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') || contentType.includes('+json')) {
      data = await res.json();
    } else {
      textBody = await res.text();
      data = textBody;
    }
  } catch {
    data = null;
  }
  if (typeof data === 'string' && data.trim().startsWith('{')) {
    try {
      data = JSON.parse(data);
    } catch {
      /* keep text */
    }
  }
  return { data, textBody };
}

function throwBusinessError(data: unknown, url: string, options: FetchRequestInit): void {
  if (!isApiResponse(data) || data.code === 0) return;
  if (data.code === 429) notifyRateLimitExceeded(data.message);
  throw new ApiError(data);
}

function throwHttpError(
  res: Response,
  data: any,
  textBody: string | null,
  url: string,
  options: FetchRequestInit,
): never {
  const message = extractErrorMessage(data, textBody, res.status);
  if (res.status === 429) notifyRateLimitExceeded(message);
  const normalized = isApiResponse(data) ? normalizeApiResponse(data) : null;
  const details = normalized
    ? readApiErrorDetails(normalized)
    : (data?.data && typeof data.data === 'object' ? data.data : data) || {};
  const error: any = new Error(message);
  error.status = res.status;
  error.data = data ?? textBody ?? {};
  error.url = url;
  error.errorCode = String(details?.error_code ?? '');
  error.accessMode = String(details?.access_mode ?? '');
  error.operation = String(details?.operation ?? '');
  error.requestId = String(normalized?.request_id ?? data?.request_id ?? details?.request_id ?? '');
  throw error;
}

type ParsedBody = { data: any; textBody: string | null };

/**
 * Read a response body at most once per response.
 *
 * Three separate things want to look at it — the expired-token check, the
 * business-error check for raw-Response/stream callers, and the normal unwrap —
 * and each used to parse it for itself, cloning the whole payload to do so. One
 * read, shared.
 *
 * Returns null when the body must be left untouched: a successful non-JSON
 * response whose caller asked for the Response or the stream itself. That is
 * the only case where nobody here has anything to inspect.
 */
async function readBodyOnce(res: Response, callerKeepsBody: boolean): Promise<ParsedBody | null> {
  const contentType = res.headers.get('content-type') ?? '';
  if (callerKeepsBody && res.ok && !contentType.includes('json')) return null;
  // Clone only when the caller still needs to read the body afterwards.
  return parseResponseBody(callerKeepsBody ? res.clone() : res);
}

/** Inspect an already-read body so response/stream callers cannot bypass JSON business errors. */
function assertResponseSuccess(
  res: Response,
  body: ParsedBody | null,
  url: string,
  options: FetchRequestInit,
): void {
  if (body === null) return;
  throwBusinessError(body.data, url, options);
  if (!res.ok) throwHttpError(res, body.data, body.textBody, url, options);
}

export type FetchRequestInit = RequestInit & {
  isStream?: boolean;
  isReturnResponse?: boolean;
  returnAxiosFormat?: boolean;
  /**
   * Viewer session id for handler-backed AI APIs.
   * When set (non-empty), attaches ``X-Instance-ID``.
   * Path-only endpoints simply omit this field — do not invent a skip flag.
   */
  instanceId?: string | null;
};

/** True when ``instanceId`` is a non-empty viewer session id. */
function hasInstanceId(instanceId: string | null | undefined): instanceId is string {
  return typeof instanceId === 'string' && instanceId.length > 0;
}

/**
 * Whether a body can be sent a second time.
 *
 * A ReadableStream is consumed by the first fetch, so replaying that request
 * would send an empty body — worse than the 401 we are trying to recover from.
 */
function isReplayableBody(body: BodyInit | null | undefined): boolean {
  if (body == null) return true;
  if (typeof body === 'string') return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true;
  if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
    return true;
  }
  return false;
}

/**
 * An expired ID token comes back two different ways: the ctrl service answers
 * HTTP 200 with ``code: 401`` in the envelope, the local service answers a
 * real 401. Both mean "refresh and try again".
 *
 * Reads the body the caller already parsed rather than cloning its own copy.
 */
function isExpiredTokenResponse(res: Response, body: ParsedBody | null): boolean {
  if (res.status === 401) return true;
  if (!res.ok || body === null) return false;
  return isApiResponse(body.data) && body.data.code === 401;
}

export const apiFetch = async (url: string, options: FetchRequestInit) => {
  const { headers: initHeaders, instanceId, ...rest } = options;

  const headers = new Headers(initHeaders as HeadersInit | undefined);
  const deviceId = getOrCreateDeviceId();
  headers.set('X-Device-Id', deviceId);

  // Opt-in only: attach X-Instance-ID when the caller provides one (or already set it).
  // Path-only AI APIs omit ``instanceId`` and get no instance header.
  if (!headers.has('X-Instance-ID') && !headers.has('x-instance-id') && hasInstanceId(instanceId)) {
    headers.set('X-Instance-ID', instanceId);
  }

  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const ownsAuthHeader = !headers.has('Authorization');
  if (ownsAuthHeader) {
    // Open edition: without a Firebase session getAuthToken() hands out the
    // local placeholder. The local service ignores bearer tokens, so local
    // requests keep working. Hosted (community) calls need a real session:
    // open the sign-in modal and stop, instead of failing the page with a
    // runtime error. Anonymous Firebase sessions can still browse.
    const isLocalEndpoint =
      url.startsWith(CTRL_SERVICE_API_ENDPOINT) || url.startsWith(AI_SERVICE_API_ENDPOINT);
    const isCommunityEndpoint = url.startsWith(COMMUNITY_API_ENDPOINT);
    const requiresAuth = !isLocalEndpoint &&
      (url.startsWith('https://') || isCommunityEndpoint);
    let authRetried = false;

    while (true) {
      const rawToken = await getAuthToken();
      const token = rawToken === LOCAL_DEFAULT_TOKEN && !isLocalEndpoint ? null : rawToken;

      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
        break;
      }

      if (!requiresAuth) break;
      if (authRetried) throw AUTH_MISSING_ERROR;

      notifyMissingAuth();
      await waitForAuthReady();
      authRetried = true;
    }
  }

  let res = await fetch(url, {
    ...rest,
    headers,
  });

  // The caller keeps the body only when it asked for the Response or the stream.
  const callerKeepsBody = Boolean(options.isReturnResponse || options.isStream);
  let body = await readBodyOnce(res, callerKeepsBody);

  // Firebase ID tokens live an hour. Nothing on the HTTP side used to notice
  // one expiring, so a machine that slept past the 50-minute refresh interval
  // came back with every request failing until the user reloaded the app.
  // Refresh once and replay — only for requests whose Authorization header we
  // set ourselves, and only when the body survives a second send.
  if (ownsAuthHeader && isReplayableBody(rest.body) && isExpiredTokenResponse(res, body)) {
    const refreshed = await forceRefreshAuthToken();
    if (refreshed) {
      headers.set('Authorization', `Bearer ${refreshed}`);
      res = await fetch(url, {
        ...rest,
        headers,
      });
      body = await readBodyOnce(res, callerKeepsBody);
    }
  }

  if (options.isReturnResponse) {
    assertResponseSuccess(res, body, url, options);
    return res;
  }

  if (options.isStream) {
    assertResponseSuccess(res, body, url, options);
    return res.body;
  }

  const { data, textBody } = body ?? { data: null, textBody: null };

  if (res.ok && isApiResponse(data)) {
    if (data.code !== 0) {
      throwBusinessError(data, url, options);
    }
    const unwrapped = data.data ?? {};

    if (options.returnAxiosFormat) {
      return {
        data: unwrapped,
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        config: options,
      };
    }
    return unwrapped;
  }

  if (options.returnAxiosFormat) {
    if (!res.ok) {
      try {
        throwHttpError(res, data, textBody, url, options);
      } catch (error: any) {
        error.response = {
          data,
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        };
        throw error;
      }
    }
    if (res.status === 429) notifyRateLimitExceeded();
    return {
      data,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      config: options,
    };
  }

  if (res.ok) return data ?? {};

  throwHttpError(res, data, textBody, url, options);
};

const throttleTimers: Record<string, number> = {};

export const throttleFetch = async (
  url: string,
  options: FetchRequestInit,
  delay: number = 1000
) => {
  const key = `${url}-${options.method || 'GET'}-${JSON.stringify(options.body || {})}`;
  const now = Date.now();

  if (!throttleTimers[key] || now - throttleTimers[key] >= delay) {
    throttleTimers[key] = now;
    return apiFetch(url, options);
  }

  return Promise.resolve('wait');
};

const debounceTimers: Record<string, NodeJS.Timeout> = {};

export const debounceFetch = (
  url: string,
  options: FetchRequestInit,
  delay: number = 300
) => {
  return new Promise((resolve, reject) => {
    const key = `${url}-${options.method || 'GET'}-${JSON.stringify(options.body || {})}`;

    if (debounceTimers[key]) {
      clearTimeout(debounceTimers[key]);
    }

    debounceTimers[key] = setTimeout(async () => {
      try {
        const result = await apiFetch(url, options);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }, delay);
  });
};
