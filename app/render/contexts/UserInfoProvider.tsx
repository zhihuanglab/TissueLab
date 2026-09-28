'use client';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithCredential,
  signInAnonymously,
} from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { getStorage, ref, getDownloadURL } from 'firebase/storage';
import { initUserAssetsEndpoint, initUserEndpoint, getUserAvatarEndpoint } from '../config/endpoints';
import { useDispatch } from 'react-redux';
import { setUserAvatarUrl, setPreferredName, setCustomTitle, setOrganization, logoutUser } from '@/store/slices/userSlice';
import { useGoogleOneTapLogin } from '@react-oauth/google';
import { app } from '../config/firebase.config';
import { getFirestoreDb } from '../config/firebaseFirestore';
import { apiFetch } from '@/utils/common/apiFetch';
import { useInterval } from 'react-use';
import Cookies from 'js-cookie';
import {
  AUTH_SETTLE_MS,
  handleLogout,
  shouldDeferSignedOutState,
} from '@/utils/common/auth.utils';
import {
  forceRefreshAuthToken,
  notifyAuthReady,
  registerAuthTokenCacheInvalidator,
  resolveSessionToken,
} from '@/utils/common/authToken';

declare global {
  interface Window {
    google?: { accounts: { id: { cancel: () => void } } };
  }
}

export interface UserInfoAssets {
  user_id: string;
  email: string | null;
  is_anonymous: boolean; // whether anonymous user
  registered_at: number;
  // Allow additional arbitrary properties including plan, subscription, etc.
  [key: string]: any;
}
/**
 * @deprecated will be removed from global
 */
export interface UserCacheData {
  repairInputImg: string | null;
  repairOutputImg: string | null;
  repairOutputThumbnail: string | null;
}

export interface UserInfoContextType {
  /**
   * @deprecated authToken will be removed from global - use getAuthToken to ensure timely update
   */
  authToken: string | undefined;
  /**
   * @deprecated userCacheData will be removed from global
   */
  userCacheData: UserCacheData;
  /**
   * @deprecated updateUserCacheData will be removed from global
   */
  updateUserCacheData: (data: {
    [K in keyof UserCacheData]?: UserCacheData[K];
  }) => Promise<void>;

  userIdentity: 1 | 2 | 3; // 1-not user;2-anonymous user;3-logged in user
  setUserIdentity: (userIdentity: UserInfoContextType['userIdentity']) => void; // Add setter for immediate updates
  signInAnonymous: (_from: string) => Promise<{ authToken: string | null }>;
  userInfo: UserInfoAssets | null;
  isLoadingUser: boolean;
  updateUserInfoAssets: () => Promise<void>;
  updateUserInfo: () => Promise<void>;
  getAuthToken: () => Promise<string | null>;
  logout: () => Promise<void>;
}

const UserInfoContext = createContext<UserInfoContextType>({
  authToken: undefined,
  userIdentity: 1,
  setUserIdentity: () => {},
  signInAnonymous: async (_from: string) => {
    return { authToken: null };
  },
  userInfo: null,
  /**
   * @deprecated userCacheData will be removed from global
   */
  userCacheData: {
    repairInputImg: null,
    repairOutputImg: null,
    repairOutputThumbnail: null,
  },
  isLoadingUser: true,
  updateUserInfoAssets: async () => {},
  updateUserInfo: async () => {},
  updateUserCacheData: async () => {},
  getAuthToken: async () => null,
  logout: async () => {},
});

// define a simple Promise cache
interface CachedPromise<T> {
  status: 'pending' | 'success' | 'error';
  value?: T;
  error?: any;
}

// create a token cache
const tokenCache: CachedPromise<string | null> = {
  status: 'pending',
  value: undefined,
  error: undefined,
};

/** localStorage key for the most recent /v1/me payload. Used to repaint the
 *  sidebar synchronously on Provider mount so returning users don't see an
 *  empty/anonymous state while the network call is in flight. */
const CACHED_USER_INFO_KEY = 'tl_cached_user_info';

function readCachedUserInfo(): UserInfoAssets | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHED_USER_INFO_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.user_id === 'string') {
      return parsed as UserInfoAssets;
    }
  } catch { /* corrupt JSON / storage denied */ }
  return null;
}

function syncCachedProfileToRedux(
  uid: string,
  dispatch: ReturnType<typeof useDispatch>,
) {
  try {
    const pn = window.localStorage.getItem(`preferred_name_${uid}`);
    if (pn && pn !== 'null') dispatch(setPreferredName(pn));
    const ct = window.localStorage.getItem(`custom_title_${uid}`);
    if (ct && ct !== 'null') dispatch(setCustomTitle(ct));
    const org = window.localStorage.getItem(`organization_${uid}`);
    if (org && org !== 'null') dispatch(setOrganization(org));
    const av = window.localStorage.getItem(`user_avatar_${uid}`);
    if (av && av !== 'null') dispatch(setUserAvatarUrl(av));
  } catch { /* private mode */ }
}

export function UserInfoProvider({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  // SSR-safe defaults: server and the first client render must match so React
  // can hydrate. Cached identity is restored in useLayoutEffect below (before
  // paint) so returning users still see their profile almost instantly.
  const [userInfo, setUserInfo] = useState<UserInfoAssets | null>(null);
  const [userCacheData, setUserCacheData] = useState<UserCacheData>({
    repairInputImg: null,
    repairOutputImg: null,
    repairOutputThumbnail: null,
  });
  const [userIdentity, setUserIdentity] = useState<1 | 2 | 3>(1);
  const [authToken, setAuthToken] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);

  useLayoutEffect(() => {
    const cached = readCachedUserInfo();
    if (!cached?.user_id) return;

    setUserInfo(cached);
    setUserIdentity(cached.is_anonymous ? 2 : 3);
    setIsLoading(false);
    syncCachedProfileToRedux(cached.user_id, dispatch);
  }, [dispatch]);

  // when anonymous login, lock, ensure no more listening to login change before interface communication is complete
  const anonymousLoginLock = useRef(false);
  // for tracking anonymous login Promise
  const anonymousLoginPromise = useRef<Promise<{
    authToken: string | null;
  }> | null>(null);
  // execute to stop listening to user change onSnapshot
  const offSnapshot = useRef<() => void>(() => {});
  /** Invalidates deferred profile listeners (logout / rapid updateUserInfo). */
  const profileListenSeqRef = useRef(0);
  /** Last Firebase uid we wired batch runtime for (detect account switch). */
  const batchAuthUidRef = useRef<string | null>(null);

  const resetTokenCache = useCallback(() => {
    tokenCache.status = 'pending';
    tokenCache.value = undefined;
    tokenCache.error = undefined;
  }, []);

  // Helper to check if running in Electron environment
  const isElectron = useCallback(() => {
    if (typeof window === 'undefined') return false;
    return !!(window as any).electron && typeof (window as any).electron?.invoke === 'function';
  }, []);

  // Refresh Firebase token using stored Google refresh_token (Electron only)
  const refreshFirebaseToken = useCallback(async (): Promise<string | null> => {
    if (!isElectron()) {
      console.log('[Auth] Token refresh only available in Electron');
      return null;
    }

    try {
      console.log('[Auth] Attempting to refresh Firebase token using stored refresh_token...');
      
      // Get stored refresh token
      const refreshTokenResult = await (window as any).electron.getRefreshToken();
      if (!refreshTokenResult.success || !refreshTokenResult.token) {
        console.log('[Auth] No refresh token available');
        return null;
      }

      // Get client ID
      const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
      if (!clientId) {
        console.error('[Auth] Google Client ID not configured');
        return null;
      }

      // Request new tokens from Google
      const result = await (window as any).electron.googleRefreshToken({
        refreshToken: refreshTokenResult.token,
        clientId
      });

      if (!result.success || !result.tokens?.id_token) {
        console.error('[Auth] Token refresh failed:', result.error);
        
        // Delete invalid refresh token if it's permanently invalid
        // Common error codes that indicate token should be deleted:
        // - invalid_grant: token expired, revoked, or malformed
        // - unauthorized_client: client not authorized
        if (result.error && typeof result.error === 'string') {
          const errorLower = result.error.toLowerCase();
          if (errorLower.includes('invalid_grant') || 
              errorLower.includes('invalid_token') ||
              errorLower.includes('token expired') ||
              errorLower.includes('token revoked')) {
            console.warn('[Auth] Refresh token is invalid, deleting it...');
            try {
              await (window as any).electron.deleteRefreshToken();
              console.log('[Auth] Invalid refresh token deleted');
            } catch (deleteError) {
              console.error('[Auth] Failed to delete invalid token:', deleteError);
            }
          }
        }
        
        return null;
      }

      console.log('[Auth] Successfully refreshed tokens from Google');

      // Update Firebase token WITHOUT triggering re-authentication
      // Just force refresh the existing user's token to keep session alive
      const auth = getAuth(app);
      const currentUser = auth.currentUser;
      
      if (!currentUser || currentUser.isAnonymous) {
        console.warn('[Auth] No valid user to refresh token for');
        return null;
      }

      // Force refresh the Firebase token (this updates the token internally without triggering onAuthStateChanged)
      const newToken = await currentUser.getIdToken(true);
      
      if (newToken) {
        // Update cookie with the refreshed token
        Cookies.set('tissuelab_token', newToken, { expires: 30 });
        console.log('[Auth] Firebase token refreshed successfully');
      }

      return newToken || null;
    } catch (error) {
      console.error('[Auth] Error during token refresh:', error);
      return null;
    }
  }, [isElectron]);

  // Use refs to access current values in interval callbacks (avoiding stale closures)
  const userIdentityRef = useRef(userIdentity);
  const userInfoRef = useRef(userInfo);
  
  useEffect(() => {
    userIdentityRef.current = userIdentity;
  }, [userIdentity]);
  
  useEffect(() => {
    userInfoRef.current = userInfo;
  }, [userInfo]);

  // reset tokenCache every 10 minutes
  useInterval(resetTokenCache, 10 * 60 * 1000);

  // A forced refresh (apiFetch retrying a 401, WebSocket close 1008) means the
  // cached token was rejected. Drop it now instead of serving the dead one for
  // the rest of the ten-minute window.
  useEffect(() => registerAuthTokenCacheInvalidator(resetTokenCache), [resetTokenCache]);

  // Auto-refresh token every 50 minutes (Firebase tokens expire in 1 hour)
  useInterval(async () => {
    if (userIdentityRef.current !== 3) return;

    console.log('[Auth] Automatic token refresh check...');
    try {
      const newToken = isElectron()
        ? await refreshFirebaseToken()
        : await forceRefreshAuthToken();

      resetTokenCache();

      if (newToken && typeof window !== 'undefined') {
        console.log('[Auth] Dispatching tokenRefreshed event to WebSocket');
        window.dispatchEvent(new CustomEvent('tokenRefreshed', { 
          detail: { token: newToken } 
        }));
      }
    } catch (error) {
      console.warn('[Auth] Auto-refresh failed:', error);
    }
  }, 50 * 60 * 1000); // 50 minutes

  // auto refresh user info - check every 5 minutes
  useInterval(() => {
    // Use refs to get current values, avoiding stale closure
    if (userIdentityRef.current === 3 && userInfoRef.current) {
      updateUserInfoAssets().catch(error => {
        console.warn('Auto-refresh user info failed:', error);
      });
    }
  }, 5 * 60 * 1000); // 5 minutes

  const getAuthToken = useCallback(async () => {
    // if already successfully fetched, return the cached value, ensure return null instead of undefined
    if (tokenCache.status === 'success') {
      return tokenCache.value || null;
    }

    // if there is an error, throw it
    if (tokenCache.status === 'error') {
      throw tokenCache.error;
    }

    // Set status to pending before starting
    tokenCache.status = 'pending';

    try {
      // Firebase first, cookie as the fallback — see resolveSessionToken for
      // why that order, and why a throwing getIdToken falls back too.
      const token = await resolveSessionToken();

      tokenCache.status = 'success';
      tokenCache.value = token;
      return token;
    } catch (error) {
      tokenCache.status = 'error';
      tokenCache.error = error;
      throw error;
    }
  }, []);

  // Helper function to get authenticated Firebase Storage URL
  const getAuthenticatedStorageUrl = useCallback(async (storageUrl: string) => {
    try {
      // Check if it's a Firebase Storage URL
      if (storageUrl.includes('firebasestorage.googleapis.com') || storageUrl.includes('storage.googleapis.com')) {
        const storage = getStorage(app);
        const storageRef = ref(storage, storageUrl);
        const downloadUrl = await getDownloadURL(storageRef);
        return downloadUrl;
      }
      return storageUrl; // Return as-is if not Firebase Storage
    } catch (error: any) {
      const message = String(error?.code || error?.message || '');
      // The file is genuinely gone — return '' so callers drop the avatar.
      if (message.includes('object-not-found')) {
        return '';
      }
      // Transient failure (CORS / permission / network — getDownloadURL is
      // noticeably flakier on web). Fall back to the original URL instead of
      // '' so the snapshot handler doesn't wipe the cached avatar; the <img>
      // can still load it. Matches AccountSettingsModal's fallback.
      return storageUrl;
    }
  }, []);

  const signInAnonymous: (_from: string) => Promise<{
    authToken: string | null;
  }> = async (_from) => {
    // if anonymous login is in progress, return the existing Promise
    if (anonymousLoginLock.current && anonymousLoginPromise.current)
      return anonymousLoginPromise.current;

    // create new login Promise
    anonymousLoginPromise.current = (async () => {
      anonymousLoginLock.current = true;
      profileListenSeqRef.current += 1;
      offSnapshot.current?.();

      setIsLoading(true);
      const nowAuth = getAuth(app);

      // No setPersistence() call here either — see checkPersistedAuth.

      // check existing login state first
      await nowAuth.authStateReady();
      const currentUser = nowAuth.currentUser;

      // If there is already a real (non-anonymous) user, don't create anonymous user
      if (currentUser && !currentUser.isAnonymous) {
        console.log('[signInAnonymous] Real user already exists, skipping anonymous login');
        const authToken = await currentUser.getIdToken();
        setAuthToken(authToken);
        anonymousLoginLock.current = false;
        anonymousLoginPromise.current = null;
        await updateUserInfo();
        return { authToken };
      }

      // if there is an anonymous user and the token is not expired, use it directly
      if (currentUser?.isAnonymous) {
        
        const authToken = await currentUser.getIdToken();
        setAuthToken(authToken);
        anonymousLoginLock.current = false;
        anonymousLoginPromise.current = null;
        await updateUserInfo();
        return { authToken };
      }

      
      let userCredential;
      try {
        userCredential = await signInAnonymously(nowAuth);
      } catch (error) {
        // Open edition: Firebase unreachable (offline machine). Release the lock
        // so the local-profile fallback (loadLocalUserInfo) can take over.
        anonymousLoginLock.current = false;
        anonymousLoginPromise.current = null;
        throw error;
      }
      const authToken = await userCredential.user?.getIdToken();
      setAuthToken(authToken);

      try {
        const res = await apiFetch(initUserEndpoint(), { method: 'POST' });
        await updateUserInfo();
        return { authToken };
      } catch (error) {
        console.error('Failed to initialize Anonymous user:', error);
        return { authToken: null };
      } finally {
        anonymousLoginLock.current = false;
        anonymousLoginPromise.current = null;
      }
    })();

    return anonymousLoginPromise.current;
  };

  /**
   * Open edition: the local service always answers /users/v1/me with the local
   * user, token or not. Without a Firebase session (desktop app, or Firebase
   * unreachable) the app still needs that profile, so load it here and treat
   * the session as anonymous (identity 2) for everything hosted.
   */
  const localLoadInFlight = useRef<Promise<boolean> | null>(null);
  /** uid the local service reported (null until the fallback ran once). */
  const localUidRef = useRef<string | null>(null);
  const loadLocalUserInfo = useCallback(async (): Promise<boolean> => {
    // Already running as the local user: nothing to fetch, nothing to set
    // (a failed anonymous sign-in may have flipped isLoading back on).
    if (
      localUidRef.current &&
      userIdentityRef.current === 2 &&
      userInfoRef.current?.user_id === localUidRef.current
    ) {
      setIsLoading(false);
      return true;
    }
    // Single flight: checkPersistedAuth and the auth listener can both ask.
    if (localLoadInFlight.current) return localLoadInFlight.current;
    localLoadInFlight.current = (async () => {
      try {
        const localInfo = await apiFetch(initUserAssetsEndpoint(), {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (!localInfo || typeof localInfo.user_id !== 'string') return false;
        localUidRef.current = localInfo.user_id;
        // Already running as this user: no state change, so the auth effect
        // (which depends on updateUserInfo -> userInfo) is not re-triggered.
        if (userInfoRef.current?.user_id === localInfo.user_id && userIdentityRef.current === 2) {
          return true;
        }
        setUserInfo(localInfo);
        setUserIdentity(2);
        try {
          localStorage.setItem(CACHED_USER_INFO_KEY, JSON.stringify(localInfo));
          localStorage.setItem('last_user_id', localInfo.user_id);
        } catch { /* ignore quota / private-mode */ }
        syncCachedProfileToRedux(localInfo.user_id, dispatch);
        return true;
      } catch (error) {
        console.warn('[UserInfoProvider] Local user profile unavailable:', error);
        return false;
      } finally {
        setIsLoading(false);
        localLoadInFlight.current = null;
      }
    })();
    return localLoadInFlight.current;
  }, [dispatch]);
  // Read through a ref inside the auth effect so the subscription is never
  // recreated because of this callback.
  const loadLocalUserInfoRef = useRef(loadLocalUserInfo);
  useEffect(() => {
    loadLocalUserInfoRef.current = loadLocalUserInfo;
  }, [loadLocalUserInfo]);

  /**
   * @description update user info
   */
  const updateUserInfo = useCallback(async () => {
    const nowAuth = getAuth(app);
    const db = getFirestoreDb();

    try {
      await nowAuth.authStateReady();
      const currentUser = nowAuth.currentUser;
      if (currentUser) {
        setUserIdentity(currentUser.isAnonymous ? 2 : 3);
        // (Previously: an extra `getDoc(users/{uid})` round-trip whose result
        // was discarded. Removed — it added 200–500ms to every login with no
        // observable benefit; we re-fetch the same data through the backend's
        // /v1/me call below, which is the actual source of truth here.)

        try {
          const authToken = await nowAuth.currentUser?.getIdToken();
          setAuthToken(authToken);
          const localInfo = await apiFetch(initUserAssetsEndpoint(), {
            method: 'POST',
            body: JSON.stringify({}),
          });
          // Open edition: the local service reports its fixed local user; the
          // identity used everywhere else (community ownership, per-user
          // localStorage keys) is the Firebase uid, exactly as on the hosted app.
          const userInfo = { ...localInfo, user_id: currentUser.uid, is_anonymous: currentUser.isAnonymous };
          setUserInfo(userInfo);
          // Cache the latest payload so the next mount can paint the sidebar
          // instantly instead of waiting for /v1/me to return.
          try {
            localStorage.setItem(CACHED_USER_INFO_KEY, JSON.stringify(userInfo));
          } catch { /* ignore quota / private-mode */ }
          // write current user ID to localStorage, for logout cleanup
          try { localStorage.setItem('last_user_id', userInfo.user_id); } catch {}
          
          // Load cached data from localStorage immediately to prevent showing email on first login
          try {
            const cachedPreferredName = localStorage.getItem(`preferred_name_${userInfo.user_id}`);
            const cachedCustomTitle = localStorage.getItem(`custom_title_${userInfo.user_id}`);
            const cachedOrganization = localStorage.getItem(`organization_${userInfo.user_id}`);
            const cachedAvatar = localStorage.getItem(`user_avatar_${userInfo.user_id}`);
            
            if (cachedPreferredName) {
              dispatch(setPreferredName(cachedPreferredName));
            }
            if (cachedCustomTitle) {
              dispatch(setCustomTitle(cachedCustomTitle));
            }
            if (cachedOrganization) {
              dispatch(setOrganization(cachedOrganization));
            }
            if (cachedAvatar) {
              dispatch(setUserAvatarUrl(cachedAvatar));
            }
          } catch (error) {
            console.warn('[UserInfoProvider] Failed to load cached user data from localStorage:', error);
          }
          
          // Start Firestore realtime subscription for avatar/profile
          try {
            profileListenSeqRef.current += 1;
            const listenId = profileListenSeqRef.current;
            offSnapshot.current?.();
            offSnapshot.current = () => {};
            if (!currentUser.isAnonymous) {
              const userId = userInfo.user_id;
              const profileRef = doc(db, 'users', userId);
              queueMicrotask(() => {
                if (listenId !== profileListenSeqRef.current) return;
                try {
                  const unsubscribe = onSnapshot(
                    profileRef,
                    async (snap) => {
                      const data = snap.data() as {
                        avatar_url?: string;
                        avatarUpdatedAt?: number;
                        preferred_name?: string;
                        custom_title?: string;
                        organization?: string;
                        profileUpdatedAt?: number;
                      } | undefined;
                      if (!data) return;

                      // handle avatar update
                      const url = data.avatar_url || '';
                      const ts = data.avatarUpdatedAt || Date.now();
                      if (url) {
                        try {
                          const authenticatedUrl = await getAuthenticatedStorageUrl(url);
                          if (!authenticatedUrl) {
                            dispatch(setUserAvatarUrl(null));
                            if (typeof window !== 'undefined') {
                              localStorage.removeItem(`user_avatar_${userId}`);
                              window.dispatchEvent(new Event('localStorageChanged'));
                            }
                          } else {
                            const urlWithTs = `${authenticatedUrl}${authenticatedUrl.includes('?') ? '&' : '?'}t=${ts}`;
                            dispatch(setUserAvatarUrl(urlWithTs));
                            if (typeof window !== 'undefined') {
                              localStorage.setItem(`user_avatar_${userId}`, urlWithTs);
                              window.dispatchEvent(new Event('localStorageChanged'));
                            }
                          }
                        } catch (error) {
                          console.warn('Failed to process avatar URL from Firestore:', error);
                        }
                      } else {
                        try {
                          dispatch(setUserAvatarUrl(null));
                          if (typeof window !== 'undefined') {
                            localStorage.removeItem(`user_avatar_${userId}`);
                            window.dispatchEvent(new Event('localStorageChanged'));
                          }
                        } catch {}
                      }

                      if (typeof window !== 'undefined') {
                        try {
                          {
                            const val = (data.preferred_name ?? null) as string | null;
                            if (val === null || val === '') {
                              localStorage.removeItem(`preferred_name_${userId}`);
                              dispatch(setPreferredName(null));
                            } else {
                              localStorage.setItem(`preferred_name_${userId}`, val);
                              dispatch(setPreferredName(val));
                            }
                          }

                          {
                            const val = (data.custom_title ?? null) as string | null;
                            if (val === null || val === '') {
                              localStorage.removeItem(`custom_title_${userId}`);
                              dispatch(setCustomTitle(null));
                            } else {
                              localStorage.setItem(`custom_title_${userId}`, val);
                              dispatch(setCustomTitle(val));
                            }
                          }

                          {
                            const val = (data.organization ?? null) as string | null;
                            if (val === null || val === '') {
                              localStorage.removeItem(`organization_${userId}`);
                              dispatch(setOrganization(null));
                            } else {
                              localStorage.setItem(`organization_${userId}`, val);
                              dispatch(setOrganization(val));
                            }
                          }

                          window.dispatchEvent(new Event('localStorageChanged'));
                        } catch (error) {
                          console.warn('Failed to update user preferences from Firestore:', error);
                        }
                      }
                    },
                    (err) => {
                      console.warn('[UserInfoProvider] Firestore profile listener error:', err);
                    }
                  );
                  if (listenId !== profileListenSeqRef.current) {
                    unsubscribe();
                    return;
                  }
                  offSnapshot.current = unsubscribe;
                } catch (e) {
                  console.warn('Failed to subscribe user profile snapshot:', e);
                }
              });
            }
          } catch (e) {
            console.warn('Failed to subscribe user profile snapshot:', e);
          }
          // Removed redundant API avatar fetch; Firestore is the source of truth for avatar
          
        } catch (apiError) {
          console.error('API call failed:', apiError);
          // If API fails, we still update identity but no user info
          setUserInfo(null);
        }
        setIsLoading(false);
      } else {
        
        setUserInfo(null);
        setUserIdentity(1);
        setIsLoading(false);
        profileListenSeqRef.current += 1;
        try { offSnapshot.current?.(); } catch {}
        // Note: localStorage cleanup is now handled in onAuthStateChanged
      }
    } catch (error) {
      console.error('updateUserInfo error:', error);
      setIsLoading(false);
    }
  }, []);

  /**
   * @description after download/subscription/consumption, update user info
   */
  const updateUserInfoAssets = useCallback(async () => {
    try {
      if (userIdentity === 1) {
        throw Error('Non-users are prohibited from accessing assets!');
      }
      const nowAuth = getAuth(app);
      const nextToken = await nowAuth.currentUser?.getIdToken();
      // This runs on a 5-minute poll. Setting a new token/userInfo reference on
      // every tick re-renders the whole UserInfo subtree (and refetches the
      // dashboard) even when nothing changed — only update on a real change.
      setAuthToken(prev => (prev === nextToken ? prev : nextToken));
      const nextUserInfo = await apiFetch(initUserAssetsEndpoint(), {
        method: 'POST',
      });
      setUserInfo(prev =>
        JSON.stringify(prev) === JSON.stringify(nextUserInfo) ? prev : nextUserInfo
      );
    } catch (error) {
      console.error('updateUserInfo error:', error);
    }
  }, [userIdentity]);

  /**
   * @description update cache data
   */
  const updateUserCacheData = useCallback(
    async (data: { [K in keyof UserCacheData]?: UserCacheData[K] }) => {
      try {
        setUserCacheData({ ...userCacheData, ...data });
      } catch (error) {
        console.error('updateUserCacheData error:', error);
      }
    },
    [userCacheData]
  );

  const logout = useCallback(async () => {
    // Delete stored refresh token in Electron
    if (isElectron()) {
      try {
        await (window as any).electron.deleteRefreshToken();
        console.log('[Auth] Refresh token deleted on logout');
      } catch (error) {
        console.warn('[Auth] Failed to delete refresh token:', error);
      }
    }
    await handleLogout([]);
  }, [isElectron]);

  // Helper to check if running in web mode (not Electron)
  const isWebMode = useCallback(() => {
    return !isElectron();
  }, [isElectron]);

  useEffect(() => {
    // check persisted auth state when init
    const checkPersistedAuth = async () => {
      const nowAuth = getAuth(app);
      // Do NOT add setPersistence(browserLocalPersistence) back. `getAuth()`
      // migrates the stored user into indexedDB on every load and removes the
      // key from the other layers, so pinning it to localStorage meant the next
      // tab's migration deleted the very key every open tab has a `storage`
      // listener on — and those tabs signed themselves out. The default
      // hierarchy is already durable across restarts.
      await nowAuth.authStateReady();
      
      // Auto-create anonymous user in web mode if no user exists
      // Only create if there's no user at all (not even anonymous)
      if (isWebMode() && !nowAuth.currentUser) {
        console.log('[UserInfoProvider] Web mode detected, auto-creating anonymous user');
        try {
          await signInAnonymous('auto-init');
        } catch (error) {
          console.error('[UserInfoProvider] Failed to auto-create anonymous user:', error);
        }
      }
      // Open edition: still no Firebase user (desktop, or Firebase unreachable) —
      // the local service serves the local user regardless, so load that profile.
      if (!getAuth(app).currentUser && !anonymousLoginLock.current) {
        await loadLocalUserInfoRef.current();
      }
    };
    checkPersistedAuth();

    // Listen to auth changes
    const unsubscribeAuth = onAuthStateChanged(getAuth(app), async (user) => {
      // when user auth state changed, reset tokenCache
      resetTokenCache();

      // Hold a mirrored sign-out before the destructive work below it: batch
      // SSE teardown, endpoint re-routing, and finally an anonymous sign-in.
      if (
        shouldDeferSignedOutState({
          hasUser: !!user,
          isWebMode: isWebMode(),
          anonymousLoginInFlight: anonymousLoginLock.current,
        })
      ) {
        await new Promise((resolve) => setTimeout(resolve, AUTH_SETTLE_MS));
        if (getAuth(app).currentUser) {
          console.log('[UserInfoProvider] Ignoring transient signed-out state; session is back');
          return;
        }
      }

      // when anonymous login, do not trigger again
      if (anonymousLoginLock.current) {
        return;
      }
      
      // Handle logout (user is null)
      if (!user) {
        const hadBatchUid = Boolean(batchAuthUidRef.current);
        batchAuthUidRef.current = null;
        if (hadBatchUid) {
          try {
            const { resetBatchClientState } = await import('@/services/batchApi.service');
            await resetBatchClientState();
          } catch {
            /* ignore */
          }
        }
        // In web mode, auto-create anonymous user instead of staying logged out
        // This provides seamless experience - user is always authenticated
        if (isWebMode()) {
          console.log('[UserInfoProvider] Web mode: auto-creating anonymous user after logout');
          try {
            await signInAnonymous('auto-after-logout');
            return; // signInAnonymous will trigger auth state change again
          } catch (error) {
            console.error('[UserInfoProvider] Failed to auto-create anonymous user:', error);
            // Fall through to set logged out state if anonymous creation fails
          }
        }
        
        // Open edition: already running as the local user (Firebase re-reporting
        // "no user" after this effect re-subscribed) — converged, nothing to do.
        if (
          localUidRef.current &&
          userIdentityRef.current === 2 &&
          userInfoRef.current?.user_id === localUidRef.current
        ) {
          return;
        }
        setAuthToken(undefined);
        profileListenSeqRef.current += 1;
        try {
          offSnapshot.current?.();
        } catch {}
        // Clear token from cookies + drop the cached identity blob so the
        // next mount doesn't repaint the sidebar with the logged-out user.
        Cookies.remove('tissuelab_token');
        try { localStorage.removeItem(CACHED_USER_INFO_KEY); } catch {}
        // Wipe Redux user profile state — otherwise the sidebar keeps
        // rendering the previous user's avatar / preferredName until /v1/me
        // returns for the next sign-in (and for non-self next sign-ins,
        // forever, because their profile was never written there).
        dispatch(logoutUser());

        // Open edition: the app keeps working as the local user without a
        // Firebase session (desktop sign-out, offline machine). Only when the
        // local service is unreachable too does the session become "no user".
        if (!(await loadLocalUserInfoRef.current())) {
          setUserInfo(null);
          setUserIdentity(1);
          setIsLoading(false);
        }
        return;
      }
      
      // Handle login - set token to cookies after login
      if (user) {
        // Stop previous user's SSE / runtime BEFORE rewriting last_user_id, or a
        // late persistHistory can land under the new uid's history key.
        if (batchAuthUidRef.current && batchAuthUidRef.current !== user.uid) {
          try {
            const { resetBatchClientState } = await import('@/services/batchApi.service');
            await resetBatchClientState();
          } catch {
            /* ignore */
          }
        }
        try {
          localStorage.setItem('last_user_id', user.uid);
        } catch {}
        if (batchAuthUidRef.current !== user.uid) {
          batchAuthUidRef.current = user.uid;
          void import('@/services/batchApi.service')
            .then(({ restoreBatchRuntimesFromServer }) => restoreBatchRuntimesFromServer())
            .catch(() => {});
        }
        try {
          const token = await user.getIdToken();
          setAuthToken(token);
          // Set token to cookies after login
          Cookies.set('tissuelab_token', token, { expires: 30 }); // Expires in 30 days
        } catch (error) {
          console.error('Failed to get token on login:', error);
        }
      }
      
      // Handle login - update user info when auth state changes, but avoid duplicate calls
      // Use userInfoRef (not userInfo state) so this effect does not re-subscribe on every userInfo update
      const latest = userInfoRef.current;
      if (!latest || latest.user_id !== user.uid) {
        // If the cached identity is for a *different* user (e.g. someone
        // signed in fresh after a logout), drop it now so the sidebar
        // doesn't keep painting the previous user while /v1/me resolves.
        // Same for Redux profile state — without this, a new account with
        // no avatar inherits the previous account's avatar from Redux.
        if (latest && latest.user_id !== user.uid) {
          setUserInfo(null);
          try { localStorage.removeItem(CACHED_USER_INFO_KEY); } catch {}
          dispatch(logoutUser());
        }
        await updateUserInfo();
      }
      if (!user.isAnonymous) notifyAuthReady();
    });

    // Cleanup
    return () => {
      unsubscribeAuth();
      profileListenSeqRef.current += 1;
      try {
        offSnapshot.current?.();
      } catch {}
    };
  }, [resetTokenCache, updateUserInfo, signInAnonymous, isWebMode]);

  const [shouldShowOneTap, setShouldShowOneTap] = useState(false);

  // Enable One-Tap only after everything is loaded
  useEffect(() => {
    
    
    if (!isLoading && !userInfo && !anonymousLoginLock.current) {
      // Add a longer delay to ensure Google script is fully initialized
      const timer = setTimeout(() => {
        if (!isLoading && !userInfo && !anonymousLoginLock.current) {
          setShouldShowOneTap(true);
        } else {
          console.error('Google API still not available, retrying...');
          // Retry after another delay
          setTimeout(() => {
            if (window.google?.accounts?.id) {
              setShouldShowOneTap(true);
            } else {
              console.error('Google API still not available after retry');
            }
          }, 2000);
        }
      }, 3000); // Increased to 3 seconds
      return () => clearTimeout(timer);
    } else {
      setShouldShowOneTap(false);
    }
  }, [isLoading, userInfo]);

  // DISABLED: One Tap login functionality temporarily disabled
  // useGoogleOneTapLogin({
  //   onSuccess: async (credentialResponse) => {
  //     console.log('OneTab onSuccess triggered:', {
  //       credential: credentialResponse.credential ? 'present' : 'missing',
  //       credentialLength: credentialResponse.credential?.length
  //     });
      
  //     const credential = GoogleAuthProvider.credential(
  //       credentialResponse.credential
  //     );

  //     await signInWithCredential(getAuth(app), credential)
  //       .then(async (userCredential) => {
  //         console.log('signInWithCredential success:', {
  //           uid: userCredential.user.uid,
  //           email: userCredential.user.email,
  //           isAnonymous: userCredential.user.isAnonymous
  //         });
  //         const authToken = await userCredential.user?.getIdToken();
  //         setAuthToken(authToken);
  //         setUserIdentity(userCredential.user.isAnonymous ? 2 : 3);
  //         console.log('Google one-tap user initialized successfully!');
  //         return await updateUserInfo();
  //       })
  //       .catch((error) => {
  //         console.error('signInWithCredential failed:', error);
  //         console.error('Full error object:', JSON.stringify(error, null, 2));
  //       });
  //   },
  //   onError: (error) => {
  //     console.error('OneTab onError:', error);
  //     console.error('Full error object:', JSON.stringify(error, null, 2));
  //   },
  //   cancel_on_tap_outside: false,
  //   disabled: !shouldShowOneTap,
  //   use_fedcm_for_prompt: false, 
  // });

  useEffect(() => {
    // when user info loaded, cancel google one tap popup and disable shouldShowOneTap
    if (userInfo !== null) {
      
      setShouldShowOneTap(false);
      if (window.google?.accounts?.id) {
        try {
          window.google.accounts.id.cancel();
        } catch (error) {
          console.error('Failed to cancel Google OneTap:', error);
        }
      }
    }
  }, [userInfo]);

  return (
    <UserInfoContext.Provider
      value={{
        userCacheData,
        userInfo,
        isLoadingUser: isLoading,
        userIdentity,
        authToken,
        setUserIdentity,
        signInAnonymous,
        updateUserInfoAssets,
        updateUserInfo,
        updateUserCacheData,
        getAuthToken,
        logout,
      }}
    >
      {children}
    </UserInfoContext.Provider>
  );
}

// Simplify the hook to only return context
export function useUserInfo(): UserInfoContextType {
  const context = useContext(UserInfoContext);
  if (!context) {
    throw new Error('useUserInfo must be used within UserInfoProvider');
  }
  return context;
}
