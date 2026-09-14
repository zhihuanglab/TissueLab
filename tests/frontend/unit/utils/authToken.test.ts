import Cookies from 'js-cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Firebase Auth double: a mutable current user behind the SDK's `getAuth`.
const fake = vi.hoisted(() => ({
  currentUser: null as null | { uid: string; isAnonymous: boolean; getIdToken: (force?: boolean) => Promise<string> },
}));
vi.mock('firebase/auth', () => ({
  getAuth: () => ({
    get currentUser() {
      return fake.currentUser;
    },
    authStateReady: async () => undefined,
  }),
}));
vi.mock('@/config/firebase.config', () => ({ app: {} }));

import {
  AUTH_COOKIE_NAME,
  forceRefreshAuthToken,
  getAuthToken,
  LOCAL_DEFAULT_TOKEN,
  notifyMissingAuth,
  registerAuthTokenCacheInvalidator,
  resolveSessionToken,
} from '@/utils/common/authToken';
import { signupModalStore } from '@/store/zustand/store';

const user = (uid: string, token: string, opts: { throws?: boolean } = {}) => ({
  uid,
  isAnonymous: true,
  getIdToken: vi.fn(async (force?: boolean) => {
    if (opts.throws) throw new Error('network down');
    return force ? `${token}-fresh` : token;
  }),
});

beforeEach(() => {
  fake.currentUser = null;
  Cookies.remove(AUTH_COOKIE_NAME);
  vi.stubEnv('NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN', undefined);
  signupModalStore.getState().setSignupModalOpen(false, undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('utils/common/authToken (Firebase session)', () => {
  it('prefers the Firebase ID token and mirrors it into the session cookie', async () => {
    fake.currentUser = user('anon-1', 'id-token');
    await expect(getAuthToken()).resolves.toBe('id-token');
    expect(Cookies.get(AUTH_COOKIE_NAME)).toBe('id-token');
  });

  it('falls back to the cookie when there is no Firebase user', async () => {
    Cookies.set(AUTH_COOKIE_NAME, 'cookie-token');
    await expect(resolveSessionToken()).resolves.toBe('cookie-token');
    await expect(getAuthToken()).resolves.toBe('cookie-token');
  });

  it('falls back to the cookie when Firebase cannot supply a token (offline)', async () => {
    Cookies.set(AUTH_COOKIE_NAME, 'cookie-token');
    fake.currentUser = user('anon-1', 'unused', { throws: true });
    await expect(getAuthToken()).resolves.toBe('cookie-token');
  });

  it('falls back to the local placeholder with no Firebase user and no cookie (local service ignores it)', async () => {
    await expect(resolveSessionToken()).resolves.toBeNull();
    await expect(getAuthToken()).resolves.toBe(LOCAL_DEFAULT_TOKEN);
    expect(LOCAL_DEFAULT_TOKEN).toBe('local-default-token');
  });

  it('forceRefreshAuthToken asks Firebase for a fresh token, rewrites the cookie and invalidates caches', async () => {
    fake.currentUser = user('anon-1', 'id-token');
    const invalidate = vi.fn();
    const unregister = registerAuthTokenCacheInvalidator(invalidate);

    await expect(forceRefreshAuthToken()).resolves.toBe('id-token-fresh');
    expect(fake.currentUser.getIdToken).toHaveBeenCalledWith(true);
    expect(Cookies.get(AUTH_COOKIE_NAME)).toBe('id-token-fresh');
    expect(invalidate).toHaveBeenCalledTimes(1);

    unregister();
    await forceRefreshAuthToken();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('forceRefreshAuthToken resolves to null without a signed-in user', async () => {
    await expect(forceRefreshAuthToken()).resolves.toBeNull();
  });

  it('notifyMissingAuth opens the sign-in modal once per cooldown window', () => {
    vi.useFakeTimers();
    notifyMissingAuth();
    expect(signupModalStore.getState().isSignupModalOpen).toBe(true);
    expect(signupModalStore.getState().signupModalContext?.description).toMatch(/sign in/i);

    signupModalStore.getState().setSignupModalOpen(false, undefined);
    notifyMissingAuth();
    expect(signupModalStore.getState().isSignupModalOpen).toBe(false);

    vi.advanceTimersByTime(3_500);
    notifyMissingAuth();
    expect(signupModalStore.getState().isSignupModalOpen).toBe(true);
  });
});
