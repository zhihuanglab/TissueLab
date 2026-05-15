import { getAuth } from 'firebase/auth';
import Cookies from 'js-cookie';
import { toast } from 'sonner';

import { app } from '../../config/firebaseConfig';

const AUTH_TOAST_COOLDOWN_MS = 3000;
let lastAuthToastAt = 0;

export const AUTH_MISSING_ERROR = 'Authentication required';

export const notifyMissingAuth = () => {
  const now = Date.now();
  if (now - lastAuthToastAt < AUTH_TOAST_COOLDOWN_MS) return;
  lastAuthToastAt = now;

  toast.info('Please sign in to access knowledge in the ecosystem');
};

export const getAuthToken = async (): Promise<string | null> => {
  try {
    const auth = getAuth(app);
    await auth.authStateReady();
    if (auth.currentUser) {
      const token = await auth.currentUser.getIdToken();
      if (token) return token;
    }
  } catch (_) {
    // ignore auth readiness issues; fall back to cookie/env check
  }

  const cookieToken = Cookies.get('tissuelab_token');
  if (cookieToken) return cookieToken;

  const envToken = process.env.NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN;
  return envToken || null;
};

/**
 * Force refresh the Firebase auth token and update cookie
 * Use this when receiving 401 (HTTP API) or 1008 (WebSocket) errors
 * @returns The new token if successful, null if failed
 */
export const forceRefreshAuthToken = async (): Promise<string | null> => {
  try {
    const auth = getAuth(app);
    await auth.authStateReady();
    
    if (auth.currentUser) {
      // Force refresh the token (true = force refresh even if not expired)
      const newToken = await auth.currentUser.getIdToken(true);
      if (newToken) {
        // Update cookie with the new token
        Cookies.set('tissuelab_token', newToken, { expires: 30 });
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

