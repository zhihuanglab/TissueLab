/**
 * Mirrors the backend AppResponse envelope: { code, message, data?, request_id? }
 * code === 0 means success; any other value is a business error.
 */
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data?: T;
  request_id?: string;
}

/**
 * Thrown when the backend returns a business-level error (code !== 0) on HTTP 200.
 */
export class ApiError extends Error {
  code: number;
  data?: unknown;
  requestId?: string;

  constructor(response: ApiResponse) {
    super(response.message);
    this.name = 'ApiError';
    this.code = response.code;
    this.data = response.data;
    this.requestId = response.request_id;
  }

  /** Mirrors HTTP status when backend uses unified HTTP 200 + numeric body.code */
  get status(): number {
    return this.code;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isApiResponse(value: unknown): value is ApiResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as ApiResponse).code === 'number' &&
    'message' in value &&
    typeof (value as ApiResponse).message === 'string'
  );
}

export function getApiResponseErrorMessage(value: unknown): string | undefined {
  if (!isApiResponse(value) || value.code === 0) return undefined;
  const message = typeof value.message === 'string' ? value.message.trim() : '';
  return message || undefined;
}

export function getBackendDefinedErrorMessage(error: unknown): string | undefined {
  if (isApiError(error)) {
    const message = error.message?.trim();
    return message || undefined;
  }

  if (typeof error !== 'object' || error === null) return undefined;

  const maybeError = error as {
    message?: unknown;
    data?: unknown;
    isAppErrorWrapped?: unknown;
    response?: { data?: unknown };
  };

  if (maybeError.isAppErrorWrapped === true && typeof maybeError.message === 'string' && maybeError.message.trim()) {
    return maybeError.message.trim();
  }

  return (
    getApiResponseErrorMessage(maybeError.response?.data) ??
    getApiResponseErrorMessage(maybeError.data)
  );
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return (
    getBackendDefinedErrorMessage(error) ??
    (typeof (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message === 'string'
      ? (error as { response: { data: { message: string } } }).response.data.message
      : undefined) ??
    (error instanceof Error && error.message.trim() ? error.message.trim() : undefined) ??
    fallback
  );
}

/**
 * With `returnAxiosFormat: true`, `response.data` is the **full** JSON body.
 * AI AppResponse is `{ code, message, data }` on HTTP 200 — extract inner `data` when `code === 0`.
 * Returns `undefined` when `code !== 0`. For legacy bodies without `code`, returns the body as `T`.
 */
export function payloadFromAxiosAppResponse<T = unknown>(axiosResponse: { data: unknown }): T | undefined {
  const body = axiosResponse.data;
  if (body == null || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.code === 'number') {
    if (b.code !== 0) return undefined;
    return (b.data ?? {}) as T;
  }
  return body as T;
}

/** Like payloadFromAxiosAppResponse but throws ApiError when `code !== 0`. */
export function requireAxiosAppPayload<T = unknown>(axiosResponse: { data: unknown }): T {
  const body = axiosResponse.data;
  if (body == null || typeof body !== 'object') {
    throw new Error('Invalid response body');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.code === 'number') {
    if (b.code !== 0) {
      throw new ApiError({
        code: b.code,
        message: String(b.message ?? 'Request failed'),
        data: b.data,
      });
    }
    return (b.data ?? {}) as T;
  }
  return body as T;
}
