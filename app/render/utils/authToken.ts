import { getAuth } from 'firebase/auth';
import Cookies from 'js-cookie';
import { toast } from 'sonner';

import { app } from '../config/firebaseConfig';

const AUTH_TOAST_COOLDOWN_MS = 5000;
let lastAuthToastAt = 0;

export const AUTH_MISSING_ERROR = 'Authentication required';

export const notifyMissingAuth = () => {
  const now = Date.now();
  if (now - lastAuthToastAt < AUTH_TOAST_COOLDOWN_MS) return;
  lastAuthToastAt = now;
  toast.error('Please sign in to use this feature');
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

