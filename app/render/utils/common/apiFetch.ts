import { getOrCreateDeviceId } from '../deviceUtils';
import { AUTH_MISSING_ERROR, getAuthToken, notifyMissingAuth } from './authToken';
import { notifyRateLimitExceeded } from '../requestErrorNotifications';
import { CTRL_SERVICE_API_ENDPOINT, AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { ApiError, isApiResponse } from './apiResponse';

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

export type FetchRequestInit = RequestInit & {
  isStream?: boolean;
  isReturnResponse?: boolean;
  returnAxiosFormat?: boolean;
};

export const apiFetch = async (url: string, options: FetchRequestInit) => {
  const { headers: initHeaders, ...rest } = options;

  const headers = new Headers(initHeaders as HeadersInit | undefined);
  const deviceId = getOrCreateDeviceId();
  headers.set('X-Device-Id', deviceId);

  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (!headers.has('Authorization')) {
    const token = await getAuthToken();

    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    } else if (url.startsWith('https://')) {
      notifyMissingAuth();
      throw new Error(AUTH_MISSING_ERROR);
    }
  }

  const res = await fetch(url, {
    ...rest,
    headers,
  });

  if (options.isReturnResponse) {
    if (res.status === 429) notifyRateLimitExceeded();
    return res;
  }

  if (options.isStream) {
    if (!res.ok && res.status === 429) notifyRateLimitExceeded();
    return res.body;
  }

  let data: any = null;
  let textBody: string | null = null;
  try {
    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await res.json();
    } else {
      textBody = await res.text();
      data = textBody;
    }
  } catch (_) {
    data = null;
  }

  if (typeof data === 'string' && data.trim().startsWith('{')) {
    try {
      data = JSON.parse(data);
    } catch (_) {
      /* keep string */
    }
  }

  if (res.ok && isApiResponse(data)) {
    if (data.code !== 0) {
      if (data.code === 429) notifyRateLimitExceeded(data.message);
      if (options.returnAxiosFormat) {
        return {
          data,
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
          config: options,
        };
      }
      throw new ApiError(data);
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
      const message = extractErrorMessage(data, textBody, res.status);
      if (res.status === 429) notifyRateLimitExceeded(message);
      const error: any = new Error(message);
      error.response = {
        data,
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      };
      error.status = res.status;
      throw error;
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

  const message = extractErrorMessage(data, textBody, res.status);
  if (res.status === 429) notifyRateLimitExceeded(message);
  const error: any = new Error(message);
  (error as any).status = res.status;
  (error as any).data = data ?? textBody;
  (error as any).url = url;
  throw error;
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
