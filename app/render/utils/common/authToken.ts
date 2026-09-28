import { getAuth } from 'firebase/auth';
import Cookies from 'js-cookie';
import { toast } from 'sonner';

import { app } from '../../config/firebase.config';
import { signupModalStore } from '../../store/zustand/store';

const AUTH_MODAL_COOLDOWN_MS = 3000;
let lastAuthModalAt = 0;

export const AUTH_MISSING_ERROR = 'Authentication required';

let authReadyWaiter: Promise<void> | null = null;
let resolveAuthReady: (() => void) | null = null;
let authReadyTimeout: ReturnType<typeof setTimeout> | null = null;

export const notifyMissingAuth = () => {
  const now = Date.now();
  if (now - lastAuthModalAt < AUTH_MODAL_COOLDOWN_MS) return;
  lastAuthModalAt = now;
  
  // Open the login modal directly
  signupModalStore.getState().setSignupModalOpen(true, {
    description: 'Please sign in to use this feature'
  });
};

/**
 * Wait for the login modal to finish a real Firebase sign-in. Requests that
 * opened the modal can then retry themselves instead of leaving the page in a
 * stale, unauthenticated state.
 */
export const waitForAuthReady = (timeoutMs = 120_000): Promise<void> => {
  if (authReadyWaiter) return authReadyWaiter;

  authReadyWaiter = new Promise<void>((resolve, reject) => {
    resolveAuthReady = resolve;
    authReadyTimeout = setTimeout(() => {
      toast.error('Sign-in timed out. Please try again.');
      reject(new Error(AUTH_MISSING_ERROR));
      authReadyWaiter = null;
      resolveAuthReady = null;
      authReadyTimeout = null;
    }, timeoutMs);
  });

  return authReadyWaiter;
};

/** Resolve all requests waiting for the login that opened the modal. */
export const notifyAuthReady = () => {
  if (!resolveAuthReady) return;
  if (authReadyTimeout) clearTimeout(authReadyTimeout);
  resolveAuthReady();
  authReadyWaiter = null;
  resolveAuthReady = null;
  authReadyTimeout = null;
};

export const AUTH_COOKIE_NAME = 'tissuelab_token';

/**
 * The current session token: Firebase first, cookie as the fallback.
 *
 * Firebase first because the cookie is written with `expires: 30` but holds an
 * ID token that dies in an hour — reading it first served an expired token for
 * up to 30 days whenever the 50-minute refresh interval was missed (timer
 * throttling in a background window, or the machine sleeping overnight).
 * `getIdToken()` returns its cached token until close to expiry and refreshes
 * transparently after that, so asking every time is cheap and always current.
 *
 * The cookie is the fallback in BOTH directions of Firebase not answering:
 * no signed-in user, and `getIdToken()` **throwing** — which is what an offline
 * machine does when the cached token is close enough to expiry that Firebase
 * goes to the network for a new one. Letting that propagate would turn a
 * network blip into a signed-out session while a usable token sat in the cookie.
 *
 * Whatever Firebase returns is written back, because the WebSocket handshake
 * and the view-act logger read that cookie directly and cannot refresh it.
 */
export const resolveSessionToken = async (): Promise<string | null> => {
  let token: string | null = null;

  try {
    const auth = getAuth(app);
    await auth.authStateReady();
    if (auth.currentUser) {
      token = await auth.currentUser.getIdToken();
    }
  } catch (error) {
    console.warn('[Auth] Firebase could not supply a token; falling back to cookie:', error);
  }

  if (token) {
    Cookies.set(AUTH_COOKIE_NAME, token, { expires: 30 });
    return token;
  }

  return Cookies.get(AUTH_COOKIE_NAME) || null;
};

/**
 * Open edition: the placeholder handed out when there is no Firebase session
 * (desktop before sign-in, offline machine). The local service ignores bearer
 * tokens, so every local consumer — tiles, SSE streams, sockets — keeps working;
 * `apiFetch` never sends it to a hosted endpoint.
 */
export const LOCAL_DEFAULT_TOKEN = 'local-default-token';

/** Session token for an outgoing request, with the local-dev token last. */
export const getAuthToken = async (): Promise<string | null> => {
  const token = await resolveSessionToken();
  if (token) return token;

  const envToken = process.env.NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN;
  return envToken || LOCAL_DEFAULT_TOKEN;
};

/**
 * Callers that memoize a token of their own (UserInfoProvider caches one for
 * ten minutes) register here, so a forced refresh does not leave them handing
 * out the token that just got rejected.
 */
const tokenCacheInvalidators = new Set<() => void>();

export const registerAuthTokenCacheInvalidator = (invalidate: () => void): (() => void) => {
  tokenCacheInvalidators.add(invalidate);
  return () => {
    tokenCacheInvalidators.delete(invalidate);
  };
};

const invalidateAuthTokenCaches = () => {
  for (const invalidate of tokenCacheInvalidators) {
    try {
      invalidate();
    } catch (error) {
      console.warn('[Auth] Token cache invalidator failed:', error);
    }
  }
};

/**
 * A page coming back from sleep fires every one of its pending requests at
 * once, and they all get the same 401. Share one refresh between them rather
 * than asking Firebase N times for the same new token.
 */
let inFlightRefresh: Promise<string | null> | null = null;

/**
 * Force refresh the Firebase auth token and update cookie
 * Use this when receiving 401 (HTTP API) or 1008 (WebSocket) errors
 * @returns The new token if successful, null if failed
 */
export const forceRefreshAuthToken = async (): Promise<string | null> => {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = runForceRefresh().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
};

const runForceRefresh = async (): Promise<string | null> => {
  try {
    const auth = getAuth(app);
    await auth.authStateReady();

    if (auth.currentUser) {
      // Force refresh the token (true = force refresh even if not expired)
      const newToken = await auth.currentUser.getIdToken(true);
      if (newToken) {
        // Update cookie with the new token
        Cookies.set(AUTH_COOKIE_NAME, newToken, { expires: 30 });
        invalidateAuthTokenCaches();
        console.log('[Auth] Token force refreshed successfully');
        return newToken;
      }
    }

    console.warn('[Auth] No current user to refresh token for');
    return null;
  } catch (error) {
    console.error('[Auth] Failed to force refresh token:', error);
    return null;
  }
};

