/**
 * Stable app envelope shared by AI Service and Ctrl-Service.
 *
 * Always present (never null / never omitted):
 *   { code: number, message: string, data: T, request_id: string }
 *
 * code === 0 means success. Permission denials put structured fields in data:
 *   data.error_code, data.access_mode, data.operation
 */
import { isPathAccessDenied, noticeFromDeniedError } from '@/utils/common/pathAccess.utils';

export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
  request_id: string;
}

export interface ApiErrorDetails {
  error_code: string;
  access_mode: string;
  operation: string;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Normalize any backend-ish body into the stable ApiResponse shape. */
export function normalizeApiResponse(raw: unknown): ApiResponse {
  const body = asRecord(raw);
  const details = asRecord(body.data);
  return {
    code: typeof body.code === 'number' ? body.code : 500,
    message: asString(body.message, 'Request failed'),
    data: (body.data ?? {}) as ApiResponse['data'],
    request_id: asString(body.request_id ?? details.request_id),
  };
}

export function readApiErrorDetails(response: ApiResponse): ApiErrorDetails {
  const details = asRecord(response.data);
  return {
    ...details,
    error_code: asString(details.error_code ?? (response as any).error_code),
    access_mode: asString(details.access_mode ?? (response as any).access_mode),
    operation: asString(details.operation ?? (response as any).operation),
  };
}

/**
 * Thrown when the backend returns a business-level error (code !== 0) on HTTP 200.
 * Structured fields are always strings ("" when absent) — never undefined/null.
 */
export class ApiError extends Error {
  code: number;
  data: Record<string, unknown>;
  requestId: string;
  errorCode: string;
  accessMode: string;
  operation: string;

  constructor(response: Partial<ApiResponse> & { code: number; message: string }) {
    const normalized = normalizeApiResponse(response);
    const details = readApiErrorDetails(normalized);
    super(normalized.message);
    this.name = 'ApiError';
    this.code = normalized.code;
    this.data = asRecord(normalized.data);
    this.requestId = normalized.request_id;
    this.errorCode = details.error_code;
    this.accessMode = details.access_mode;
    this.operation = details.operation;
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
  if (isPathAccessDenied(error)) {
    const notice = noticeFromDeniedError(error);
    return `${notice.title}. ${notice.description}`;
  }
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
 * AI AppResponse is `{ code, message, data, request_id }` on HTTP 200 — extract inner `data` when `code === 0`.
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
      throw new ApiError(normalizeApiResponse(b));
    }
    return (b.data ?? {}) as T;
  }
  return body as T;
}
