import { getAuth } from 'firebase/auth';
import Cookies from 'js-cookie';
import { store } from '@/store';
import { logoutUser } from '@/store/slices/userSlice';

// Cross-tab auth state. Firebase mirrors the signed-in user between tabs, so
// `onAuthStateChanged(null)` does not mean "this tab signed out" — it also
// arrives while another tab is mid sign-in, or while a freshly opened one
// migrates the persisted user between storage layers. Acting on such a null is
// destructive: in web mode the app answers it by signing in anonymously, and
// because the state is shared that replaces the real session in every tab.

/** Set by `handleLogout`, so this tab's own sign-out is never held back. */
let explicitLogout = false;

/**
 * Whether a sign-out event has to be held before anything acts on it.
 *
 * Consumes `explicitLogout`, but only once the cheaper checks have passed:
 * clearing it on every event would let an unrelated sign-in arriving between
 * `handleLogout` and its sign-out swallow the pending logout.
 */
export const shouldDeferSignedOutState = (input: {
  /** The event carried a user. */
  hasUser: boolean;
  /** Web (not Electron). Electron has no sibling tabs to mirror from. */
  isWebMode: boolean;
  /** This tab is already creating an anonymous user; its own nulls are noise. */
  anonymousLoginInFlight: boolean;
}): boolean => {
  if (input.hasUser || !input.isWebMode || input.anonymousLoginInFlight) return false;
  const wasOurOwnLogout = explicitLogout;
  explicitLogout = false;
  return !wasOurOwnLogout;
};

/**
 * How long to hold it for.
 *
 * The window has to cover the other tab putting the user back, which costs
 * about three IndexedDB transactions — single-digit to low-tens of ms warm.
 * 1500ms is two orders of magnitude of headroom and only fails once a single
 * transaction takes ~500ms, so do not tune it down.
 *
 * A deadline rather than a wait for the next auth event, because when the
 * sign-out is real no further event is coming.
 */
export const AUTH_SETTLE_MS = 1500;

const USER_DATA_PATTERNS = [
  'preferred_name_',
  'custom_title_',
  'organization_',
  'user_avatar_',
  'preferences_',
  'user_stats_',
];

const GENERAL_USER_DATA_KEYS = [
  'last_user_id',
  'user_stars',
  'userUploadedClassifiers',
  'user_follows',
  'uploadedClassifiers',
  'tl_cached_user_info',
  // Dashboard UI memory — wipes the previous user's tab + subfolder
  // selection so the next account doesn't land in a folder they don't own.
  // (The dashboard's `folderForPath` would already discard a foreign-uid
  // path on read, but clearing here avoids leaking the path string at all.)
  'tl_dashboard_active_folder',
  'tl_dashboard_active_path',
];

/** Synchronously wipe every localStorage entry that belongs to the
 *  signed-out user. Keep this pure (no async) so callers can sequence it
 *  before any UI updates that read Redux. */
function clearUserLocalStorage() {
  if (typeof window === 'undefined') return;
  try {
    const lastUserId = window.localStorage.getItem('last_user_id');
    if (lastUserId) {
      for (const prefix of USER_DATA_PATTERNS) {
        window.localStorage.removeItem(`${prefix}${lastUserId}`);
      }
    }

    // Catch-all sweep for stragglers (e.g. last_user_id missing or different
    // uid still in localStorage from an aborted prior session).
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && USER_DATA_PATTERNS.some((p) => key.startsWith(p))) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }

    for (const key of GENERAL_USER_DATA_KEYS) {
      if (window.localStorage.getItem(key)) window.localStorage.removeItem(key);
    }
    // Batch history is cleared by resetBatchClientState() (called before this).
  } catch (e) {
    console.warn('Failed to clear localStorage during logout:', e);
  }
}

export const handleLogout = async (callbacks: (() => void)[]) => {
  explicitLogout = true;
  try {
    // 1. Wipe Redux user state FIRST so the sidebar (which reads avatarUrl /
    //    preferredName from Redux) doesn't keep painting the old identity
    //    while signOut + localStorage cleanup are still running.
    try { store.dispatch(logoutUser()); } catch { /* ignore */ }

    // 2. Drop session storage + auth cookie + per-user localStorage entries
    //    synchronously. The previous 2-second setTimeout was a footgun:
    //    if a different account signed in inside that window, it inherited
    //    the prior user's avatar + storage info. The Firestore onSnapshot
    //    subscription rebuilds these from server-side on re-login, so we
    //    don't need the cache to survive across the logout boundary.
    if (typeof window !== 'undefined') {
      try { window.sessionStorage.clear(); } catch { /* ignore */ }
    }
    Cookies.remove('tissuelab_token');

    // Stop batch SSE before wiping last_user_id / history keys, otherwise a late
    // persistHistory can rewrite under the unscoped or next-user key.
    try {
      const { resetBatchClientState } = await import('@/services/batchApi.service');
      await resetBatchClientState();
    } catch {
      /* ignore */
    }

    clearUserLocalStorage();

    // 3. Now flip Firebase. onAuthStateChanged will fire null, but at that
    //    point Redux + localStorage are already clean so the sidebar paints
    //    a logged-out state immediately.
    await getAuth().signOut();

    callbacks.forEach((callback) => callback());
  } catch (error) {
    console.error('Error signing out:', error);
  }
};