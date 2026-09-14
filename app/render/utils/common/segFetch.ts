/**
 * Handler-backed AI segmentation / tasks API client.
 * Requires a non-empty viewer ``instanceId`` — path-only endpoints should use ``apiFetch`` instead.
 */
import { apiFetch, type FetchRequestInit } from '@/utils/common/apiFetch';

export class MissingInstanceIdError extends Error {
  constructor(context?: string) {
    super(
      context
        ? `X-Instance-ID required for ${context}`
        : 'X-Instance-ID is required for segmentation handler APIs'
    );
    this.name = 'MissingInstanceIdError';
  }
}

export function requireInstanceId(
  instanceId: string | null | undefined,
  context?: string
): string {
  if (typeof instanceId === 'string' && instanceId.length > 0) {
    return instanceId;
  }
  throw new MissingInstanceIdError(context);
}

type SegFetchOptions = Omit<FetchRequestInit, 'instanceId'>;

/**
 * Like ``apiFetch``, but always attaches ``X-Instance-ID``.
 * Throws ``MissingInstanceIdError`` before the network call if id is missing.
 */
export async function segFetch(
  instanceId: string | null | undefined,
  url: string,
  options: SegFetchOptions = {}
) {
  const id = requireInstanceId(instanceId, url.split('?')[0]);
  return apiFetch(url, { ...options, instanceId: id });
}
