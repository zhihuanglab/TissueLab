'use client';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithCredential,
  signInAnonymously,
  setPersistence,
  browserLocalPersistence,
} from 'firebase/auth';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { getStorage, ref, getDownloadURL } from 'firebase/storage';
import { initUserAssetsEndpoint, initUserEndpoint, getUserAvatarEndpoint } from '../config/endpoints';
import { useDispatch } from 'react-redux';
import { setUserAvatarUrl, setPreferredName, setCustomTitle, setOrganization } from '@/store/slices/userSlice';
import { useGoogleOneTapLogin } from '@react-oauth/google';
import { app } from '../config/firebaseConfig';
import { getFirestoreDb } from '../config/firebaseFirestore';
import { apiFetch } from '@/utils/common/apiFetch';
import { useInterval } from 'react-use';
import tryCatchPromise from '@/utils/tryCatchPromise';
import Cookies from 'js-cookie';
import { handleLogout } from '@/utils/common/authUtils';
import { forceRefreshAuthToken } from '@/utils/common/authToken';

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

export function UserInfoProvider({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  const [userInfo, setUserInfo] = useState<UserInfoAssets | null>(null);
  const [userCacheData, setUserCacheData] = useState<UserCacheData>({
    repairInputImg: null,
    repairOutputImg: null,
    repairOutputThumbnail: null,
  });
  const [userIdentity, setUserIdentity] = useState<1 | 2 | 3>(1);
  const [authToken, setAuthToken] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);

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
      // Get token from cookies
      let token = Cookies.get('tissuelab_token') || null;
      
      // If there is no token in cookies, get it from Firebase and set it to cookies
      if (!token) {
        const nowAuth = getAuth(app);
        await nowAuth.authStateReady();
        token = nowAuth.currentUser
          ? await nowAuth.currentUser.getIdToken()
          : null;
        
        // Save token to cookies if it exists
        if (token) {
          Cookies.set('tissuelab_token', token, { expires: 30 }); // 30 days
        } else {
          Cookies.remove('tissuelab_token');
        }
      }
      
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
      // Silence object-not-found noise by returning empty string
      const message = String(error?.code || error?.message || '');
      if (message.includes('object-not-found')) {
        return '';
      }
      return '';
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

      try {
        // enhance persistence setting
        await setPersistence(nowAuth, browserLocalPersistence);
      } catch (error) {
        console.error('Persistence setup failed:', error);
        anonymousLoginLock.current = false;
        anonymousLoginPromise.current = null;
        return { authToken: null };
      }

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

      
      const userCredential = await signInAnonymously(nowAuth);
      const authToken = await userCredential.user?.getIdToken();
      setAuthToken(authToken);

      try {
        const res = await apiFetch(initUserEndpoint, { method: 'POST' });
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
        if (!currentUser.isAnonymous) {
          const userDbIndex = doc(db, 'users', currentUser.uid);
          const { data: docSnap, error } = await tryCatchPromise(
            getDoc(userDbIndex)
          );
          if (error) {
            console.error(`updateUserInfo Firestore error:`, error);
            // If Firestore fails, still try to call the backend API
          }
        }
        
        // Try to call backend API regardless of Firestore status
        
        
        try {
          const authToken = await nowAuth.currentUser?.getIdToken();
          setAuthToken(authToken);
          const userInfo = await apiFetch(initUserAssetsEndpoint, {
            method: 'POST',
            body: JSON.stringify({}),
          });
          setUserInfo(userInfo);
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
      const authToken = await nowAuth.currentUser?.getIdToken();
      setAuthToken(authToken);
      const userInfo = await apiFetch(initUserAssetsEndpoint, {
        method: 'POST',
      });
      setUserInfo(userInfo);
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

  useEffect(() => {
    // check persisted auth state when init
    const checkPersistedAuth = async () => {
      const nowAuth = getAuth(app);
      await setPersistence(nowAuth, browserLocalPersistence);
      await nowAuth.authStateReady();
    };
    checkPersistedAuth();

    // Listen to auth changes
    const unsubscribeAuth = onAuthStateChanged(getAuth(app), async (user) => {
      // when user auth state changed, reset tokenCache
      resetTokenCache();
      // when anonymous login, do not trigger again
      if (anonymousLoginLock.current) {
        return;
      }

      // Handle logout (user is null)
      if (!user) {
        setUserInfo(null);
        setUserIdentity(1);
        setAuthToken(undefined);
        setIsLoading(false);
        profileListenSeqRef.current += 1;
        try {
          offSnapshot.current?.();
        } catch {}
        // Clear token from cookies
        Cookies.remove('tissuelab_token');
        
        return;
      }
      
      // Handle login - set token to cookies after login
      if (user) {
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
        await updateUserInfo();
      }
    });

    // Cleanup
    return () => {
      unsubscribeAuth();
      profileListenSeqRef.current += 1;
      try {
        offSnapshot.current?.();
      } catch {}
    };
  }, [resetTokenCache, updateUserInfo]);

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
