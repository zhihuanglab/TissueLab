'use client';

import {
  UserCredential,
  signInWithPopup,
  GoogleAuthProvider,
  getAuth,
  signInWithCustomToken,
  signInWithCredential,
  User,
  onAuthStateChanged,
} from 'firebase/auth';
import { app } from '../config/firebaseConfig';
import { useUserInfo } from '../provider/UserInfoProvider';
import { useCallback, useEffect, useState } from 'react';
import {
  initUserEndpoint,
  updateUserProfileEndpoint,
  initUserAssetsEndpoint,
} from '../config/endpoints';
import { toast } from 'sonner';
import { apiFetch } from '../utils/common/apiFetch';


type LoginWay = 'google-login' | 'email-login';

const ErrorTipMap = {
  CODE_SEND_LIMIT_ERROR: 'Please wait 30 seconds before requesting a new code',
  CODE_NOT_EXIST_ERROR:
    'The verification code is invalid, Please request a new code',
  CODE_EXPIRED_ERROR:
    'The verification code has expired, Please request a new code',
};

const useGlobalSignup = ({
  setModalVisible,
  signupSuccess,
}: {
  setModalVisible?: (open: boolean) => void;
  signupSuccess?: () => void;
}) => {
  const { setUserIdentity, updateUserInfo } = useUserInfo();
  // Email login removed: only Google login is supported

  const handleAuthSuccess = useCallback(
    async (user: User, loginWay: LoginWay) => {
      if (!user.isAnonymous) setUserIdentity(3);
      // trigger user info update after login success
      await updateUserInfo();
      // report login
    },
    [setUserIdentity, updateUserInfo]
  );

  const handleAuthError = async (error: Error) => {
    console.error('Failed to initialize user:', error);
    const auth = getAuth();
    await auth.signOut();
    toast.error('Failed to complete sign in. Please try signing in again.');
  };

  const signInSuccessWithAuthResult = (
    authResult: UserCredential,
    loginWay: LoginWay
  ) => {
    const user = authResult.user;
    user
      .getIdToken()
      .then(() =>
        apiFetch(initUserEndpoint, {
          method: 'POST',
          body: JSON.stringify({}),
        })
      )
      .then(async () => {
        // Extract user profile information from Google login
        if (loginWay === 'google-login') {
          console.log('Google user data:', {
            displayName: user.displayName,
            photoURL: user.photoURL,
            email: user.email
          });
          
          // Update profile if we have displayName or photoURL
          if (user.displayName || user.photoURL) {
            try {
              console.log('Updating user profile with Google data...');
              
              // Check if user already has a preferred_name to avoid overwriting it
              // Check both localStorage AND backend to handle logout/login scenarios
              let shouldUpdatePreferredName = false;
              let currentPreferredName = null;
              
              if (typeof window !== 'undefined' && user.uid) {
                // First check localStorage
                currentPreferredName = localStorage.getItem(`preferred_name_${user.uid}`);
                const hasLocalPreferredName = currentPreferredName && currentPreferredName !== 'null' && currentPreferredName !== '';
                
                if (hasLocalPreferredName) {
                  // User has local preferred_name, don't override
                  shouldUpdatePreferredName = false;
                } else {
                  // No local preferred_name found
                  // Be conservative - let UserInfoProvider load from Firebase first
                  // This handles both new users and returning users after localStorage clear
                  shouldUpdatePreferredName = false;
                }
              }

              const updateData: any = {};
              
              // Only set preferred_name if user doesn't have one already
              if (shouldUpdatePreferredName && user.displayName) {
                updateData.preferred_name = user.displayName;
                console.log('Using Google displayName as preferred_name:', user.displayName);
              } else {
                console.log('Keeping existing preferred_name, not overwriting with Google displayName');
              }
              
              // Always update avatar from Google (users usually want latest Google avatar)
              if (user.photoURL) {
                updateData.avatar_url = user.photoURL;
              }
              
              // Only send update if we have something to update
              if (Object.keys(updateData).length > 0) {
                const response = await apiFetch(updateUserProfileEndpoint, {
                  method: 'POST',
                  body: JSON.stringify(updateData),
                });
                console.log('Profile update response:', response);
              }
            } catch (error) {
              console.warn('Failed to update profile from Google data:', error);
              // Don't block login if profile update fails
            }
          } else {
            console.log('No displayName or photoURL available from Google login');
          }
        }
        
        handleAuthSuccess(user, loginWay);
      })
      .catch(handleAuthError);
  };

  // Check if running in Electron environment
  const isElectron = () => {
    return typeof window !== 'undefined' && window.electron !== undefined;
  };

  // one-tap login
  const oneClickLogin = async () => {
    // In Electron, one-tap doesn't make sense, just use normal login
    if (isElectron()) {
      return loginViaGoogle();
    }
    
    const auth = getAuth(app);
    const provider = new GoogleAuthProvider();
    // remove account selection prompt, use default account
    provider.setCustomParameters({ prompt: 'none' });
    
    try {
      const authResult = await signInWithPopup(auth, provider);
      setModalVisible?.(false);
      signupSuccess?.();
      signInSuccessWithAuthResult(authResult, 'google-login');
    } catch (error: any) {
      // if no default account, fallback to normal login
      if (error.code === 'auth/account-exists-with-different-credential') {
        return loginViaGoogle();
      }
      console.error('one-tap login failed:', error);
    }
  };

  // Google signup or login - Browser-based in Electron, popup in web
  const loginViaGoogle = async () => {
    const auth = getAuth(app);
    
    // Electron: Use system browser OAuth flow
    if (isElectron()) {
      try {
        console.log('[Auth] Starting Electron OAuth flow...');
        
        // Get client ID/secret from environment variables (renderer)
        // Desktop OAuth clients ship a "client secret" that Google does not treat as confidential
        const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
        const clientSecret = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_SECRET;

        if (!clientId) {
          throw new Error('Google Client ID not configured. Please set NEXT_PUBLIC_GOOGLE_CLIENT_ID in your environment.');
        }

        toast.info('Opening browser for authentication...');

        // Pass client ID (and secret, if provided) to main process
        const result = await window.electron.googleOAuth({ clientId, clientSecret });
        
        if (!result.success || !result.tokens) {
          throw new Error(result.error || 'OAuth failed - no tokens received');
        }
        
        console.log('[Auth] OAuth successful, signing in to Firebase...');
        
        // Save refresh_token securely if available
        if (result.tokens.refresh_token) {
          try {
            console.log('[Auth] Saving refresh token...');
            const saveResult = await window.electron.saveRefreshToken({ 
              token: result.tokens.refresh_token 
            });
            if (saveResult.success) {
              console.log('[Auth] Refresh token saved successfully');
              if (saveResult.warning) {
                console.warn('[Auth] Warning:', saveResult.warning);
              }
            } else {
              console.warn('[Auth] Failed to save refresh token:', saveResult.error);
            }
          } catch (saveError) {
            console.error('[Auth] Error saving refresh token:', saveError);
            // Don't block login if saving refresh token fails
          }
        }
        
        // Use the id_token to sign in with Firebase
        const credential = GoogleAuthProvider.credential(result.tokens.id_token);
        const authResult = await signInWithCredential(auth, credential);
        
        // Immediately fetch user profile from backend and write to localStorage
        // This ensures data is available even if Firestore sync is delayed or fails
        try {
          console.log('[Auth] Fetching user profile from backend...');
          const userProfile = await apiFetch(initUserAssetsEndpoint, {
            method: 'POST',
            body: JSON.stringify({}),
          });
          
          console.log('[Auth] Got user profile:', userProfile);
          
          // Write to localStorage immediately
          if (userProfile && userProfile.user_id) {
            if (userProfile.preferred_name) {
              localStorage.setItem(`preferred_name_${userProfile.user_id}`, userProfile.preferred_name);
              console.log('[Auth] Saved preferred_name to localStorage:', userProfile.preferred_name);
            }
            if (userProfile.custom_title) {
              localStorage.setItem(`custom_title_${userProfile.user_id}`, userProfile.custom_title);
            }
            if (userProfile.organization) {
              localStorage.setItem(`organization_${userProfile.user_id}`, userProfile.organization);
            }
            
            // Don't manage avatar in login flow - let existing system handle it
            // This prevents any interference with custom avatar management
          }
        } catch (profileError) {
          console.warn('[Auth] Failed to fetch user profile:', profileError);
          // Don't block login if profile fetch fails
        }
        
        setModalVisible?.(false);
        signupSuccess?.();
        signInSuccessWithAuthResult(authResult, 'google-login');
        
        toast.success('Successfully signed in!');
      } catch (error: any) {
        console.error('Electron Google login failed:', error);
        toast.error(error.message || 'Failed to sign in with Google');
      }
      return;
    }
    
    // Web: Use popup flow (original behavior)
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const authResult = await signInWithPopup(auth, provider);
      setModalVisible?.(false);
      signupSuccess?.();
      signInSuccessWithAuthResult(authResult, 'google-login');
    } catch (error) {
      console.error('Google login failed:', error);
    }
  };

  // Email login flow removed

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(getAuth(app), async (user) => {
      if (user && !user.isAnonymous) setModalVisible?.(false);
    });

    return () => unsubscribeAuth();
  }, [setModalVisible]);

  return {
    loginViaGoogle,
    oneClickLogin,
    // Email login APIs removed
  };
};

export default useGlobalSignup;