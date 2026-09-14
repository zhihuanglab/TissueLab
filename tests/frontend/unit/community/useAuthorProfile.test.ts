import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { COMMUNITY_API_ENDPOINT } from '@/config/api.config';
import { useAuthorProfile } from '@/hooks/community/useAuthorProfile';
import { envelope, installFetchMock } from '../helpers/fetchMock';

vi.mock('@/utils/common/authToken', () => ({
  AUTH_MISSING_ERROR: 'Authentication required',
  LOCAL_DEFAULT_TOKEN: 'local-default-token',
  getAuthToken: vi.fn(async () => 'firebase-token'),
  forceRefreshAuthToken: vi.fn(async () => null),
  notifyMissingAuth: vi.fn(),
}));

describe('hooks/community/useAuthorProfile', () => {
  it('resolves {uid, displayName, avatarUrl} from the community public-profile envelope', async () => {
    const { calls } = installFetchMock([
      {
        method: 'GET',
        match: '/community/v1/users/author-1/public-profile',
        reply: () => envelope({ uid: 'author-1', displayName: 'Alpha Pathologist', avatarUrl: 'https://cdn.example/a.png' }),
      },
    ]);

    const { result } = renderHook(() => useAuthorProfile('author-1'));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current?.displayName).toBe('Alpha Pathologist'));
    expect(result.current).toEqual({ uid: 'author-1', displayName: 'Alpha Pathologist', avatarUrl: 'https://cdn.example/a.png' });

    // Hosted community, with the session token.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${COMMUNITY_API_ENDPOINT}/community/v1/users/author-1/public-profile`);
    expect(calls[0].headers.get('authorization')).toBe('Bearer firebase-token');
  });

  it('dedupes concurrent lookups of the same uid and serves remounts from cache', async () => {
    const { calls } = installFetchMock([
      { method: 'GET', match: '/community/v1/users/author-2/public-profile', reply: () => envelope({ uid: 'author-2', displayName: 'Beta', avatarUrl: null }) },
    ]);
    const a = renderHook(() => useAuthorProfile('author-2'));
    const b = renderHook(() => useAuthorProfile('author-2'));
    await waitFor(() => expect(a.result.current?.displayName).toBe('Beta'));
    await waitFor(() => expect(b.result.current?.displayName).toBe('Beta'));
    expect(calls).toHaveLength(1);

    const c = renderHook(() => useAuthorProfile('author-2'));
    // Cached synchronously on remount — no flash of the fallback.
    expect(c.result.current?.displayName).toBe('Beta');
    expect(calls).toHaveLength(1);
  });

  it('skips the request for anonymous / empty uids and resolves the TissueLab brand locally', async () => {
    const { calls } = installFetchMock([]);
    const none = renderHook(() => useAuthorProfile('anonymous'));
    const empty = renderHook(() => useAuthorProfile(null));
    const brand = renderHook(() => useAuthorProfile('tissuelab'));
    expect(none.result.current).toBeNull();
    expect(empty.result.current).toBeNull();
    expect(brand.result.current).toEqual({ uid: 'tissuelab', displayName: 'TissueLab', avatarUrl: '/brand/logo.svg' });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
  });

  it('falls back to null (caller shows the uid) when the lookup fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installFetchMock([{ method: 'GET', match: '/public-profile', reply: () => envelope(null, 404, 'User not found') }]);
    const { result } = renderHook(() => useAuthorProfile('author-missing'));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });
});
