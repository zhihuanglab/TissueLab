/**
 * What a failed tile request says about itself. Shared by tileAuth (was it the
 * token?) and tileRevive (is it worth asking again?), so both read one parse
 * of the body and one set of rules.
 */

import { isTokenRejectionEnvelope } from "../common/apiResponse";

const envelopes = new WeakMap<XMLHttpRequest, any>();

/**
 * The JSON error envelope a tile request got instead of an image, or null.
 * Backend errors are HTTP 200 with the envelope as the body.
 */
export function readTileEnvelope(request: XMLHttpRequest | null | undefined): any {
  if (!request || request.status !== 200) return null;
  if (envelopes.has(request)) return envelopes.get(request);
  let body: any = null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(request.response));
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    body = null;
  }
  envelopes.set(request, body);
  return body;
}

/**
 * Refused because of the token: a new token fixes it. An opaque failure
 * (status 0: offline, a proxy page without CORS headers) or a timeout (no
 * request) is not one.
 */
export function isTileTokenRejection(request: XMLHttpRequest | null | undefined): boolean {
  if (!request) return false;
  if (request.status === 401) return true;
  return isTokenRejectionEnvelope(readTileEnvelope(request));
}

// Codes that may pass: auth (a new token), timeout, rate limit.
const RETRYABLE_4XX = new Set([401, 408, 429]);
const isPermanentCode = (code: unknown): boolean =>
  typeof code === "number" && code >= 400 && code < 500 && !RETRYABLE_4XX.has(code);

/**
 * Fails the same way however often it is asked: a 4xx that is not about auth,
 * timing or rate (no such file, no access to the slide). 5xx and network
 * errors may pass, so they are not permanent.
 */
export function isPermanentTileFailure(request: XMLHttpRequest | null | undefined): boolean {
  if (!request) return false;
  if (request.status !== 200) return isPermanentCode(request.status);
  const body = readTileEnvelope(request);
  if (!body) return false;
  const errorCode = String(body.data?.error_code ?? "");
  // AUTH_TOKEN_* is a refused token; AUTH_FAILED a verification hiccup.
  return isPermanentCode(body.code) && !errorCode.startsWith("AUTH_");
}
