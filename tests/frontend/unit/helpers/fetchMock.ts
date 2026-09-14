import { vi } from 'vitest';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  /** JSON-parsed body when it was a JSON string, otherwise the raw body. */
  body: any;
}

export interface Route {
  method?: string;
  match: string | RegExp | ((url: string) => boolean);
  reply: (call: RecordedCall) => Response | Promise<Response>;
}

/** A JSON `Response` with the given status (default 200). */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...((init.headers as Record<string, string>) ?? {}) },
  });
}

/** The backend envelope: `{ code, message, data, request_id }` on HTTP 200. */
export function envelope(data: unknown, code = 0, message = 'ok', init: ResponseInit = {}): Response {
  return jsonResponse({ code, message, data, request_id: 'req-test' }, init);
}

export function textResponse(text: string, init: ResponseInit = {}): Response {
  return new Response(text, { status: 200, ...init, headers: { 'content-type': 'text/plain', ...((init.headers as Record<string, string>) ?? {}) } });
}

/**
 * Replace `globalThis.fetch` with a router. Unmatched requests reject so a
 * test cannot silently hit an endpoint it did not declare.
 */
export function installFetchMock(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers as HeadersInit | undefined);
    let body: any = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep the raw string */
      }
    }
    const call: RecordedCall = { url, method, headers, body };
    calls.push(call);
    for (const route of routes) {
      if (route.method && route.method.toUpperCase() !== method) continue;
      const hit =
        typeof route.match === 'string'
          ? url.includes(route.match)
          : route.match instanceof RegExp
            ? route.match.test(url)
            : route.match(url);
      if (hit) return route.reply(call);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
