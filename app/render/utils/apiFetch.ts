
import { getOrCreateDeviceId } from './helperUtils';
import { AUTH_MISSING_ERROR, getAuthToken, notifyMissingAuth } from './authToken';

export type FetchRequestInit = RequestInit & {
  isStream?: boolean;
  isReturnResponse?: boolean;
};

/**
 * @description request interface
 * @param url request address
 * @param options request options
 * @param options.isStream whether to return stream
 * @returns request result
 */
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
    if (!token) {
      notifyMissingAuth();
      throw new Error(AUTH_MISSING_ERROR);
    }
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(url, {
    ...rest,
    headers,
  });

  if (options.isStream) return res.body;
  if (options.isReturnResponse) return res;

  // Try to parse JSON response; if fails, fallback to text
  let data: any = null;
  let textBody: string | null = null;
  try {
    data = await res.json();
  } catch (_) {
    try {
      textBody = await res.text();
    } catch {}
  }

  if (res.ok) return data ?? {};

  const message = (data && (data.detail || data.error || data.message)) || textBody || `Request failed with status ${res.status}`;
  const error: any = new Error(message);
  (error as any).status = res.status;
  (error as any).data = data ?? textBody;
  (error as any).url = url;
  throw error;
};

// for storing the last execution time of the throttle function
const throttleTimers: Record<string, number> = {};

/**
 * @description throttle request interface, only execute the first request within N seconds
 * @param url request address
 * @param options request options
 * @param delay throttle time (milliseconds), default 1000ms
 * @returns request result
 */
export const throttleFetch = async (
  url: string,
  options: FetchRequestInit,
  delay: number = 1000
) => {
  // generate request unique identifier
  const key = `${url}-${options.method || 'GET'}-${JSON.stringify(options.body || {})}`;
  const now = Date.now();

  // if it is the first call or the throttle time has passed, execute the request
  if (!throttleTimers[key] || now - throttleTimers[key] >= delay) {
    throttleTimers[key] = now;
    return apiFetch(url, options);
  }

  return Promise.resolve('wait');
};

// for storing the timer of the debounce function
const debounceTimers: Record<string, NodeJS.Timeout> = {};

/**
 * @description debounce request interface, only execute the last request within N seconds
 * @param url request address
 * @param options request options
 * @param delay debounce time (milliseconds), default 300ms
 * @returns request result Promise
 */
export const debounceFetch = (
  url: string,
  options: FetchRequestInit,
  delay: number = 300
) => {
  return new Promise((resolve, reject) => {
    // generate request unique identifier
    const key = `${url}-${options.method || 'GET'}-${JSON.stringify(options.body || {})}`;

    // clear previous timer
    if (debounceTimers[key]) {
      clearTimeout(debounceTimers[key]);
    }

    // set new timer
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
