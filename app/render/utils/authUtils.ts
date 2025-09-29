import { getAuth } from 'firebase/auth';
import Cookies from 'js-cookie';

export const handleLogout = async (callbacks: (() => void)[]) => {
  try {
    await getAuth().signOut();
    
    // Clear session storage
    if (typeof window !== 'undefined') {
      sessionStorage.clear();
    }
    
    // Clear auth token from cookies
    Cookies.remove('tissuelab_token');
    
    // Delay localStorage cleanup to allow UserInfoProvider to sync from Firebase on re-login
    // This prevents the race condition where localStorage is cleared before Firebase data can be restored
    if (typeof window !== 'undefined') {
      setTimeout(() => {
        try {
          const lastUserId = localStorage.getItem('last_user_id');
          
          // Method 1: Clear user-specific data if we have lastUserId
          if (lastUserId) {
            localStorage.removeItem(`preferred_name_${lastUserId}`);
            localStorage.removeItem(`custom_title_${lastUserId}`);
            localStorage.removeItem(`organization_${lastUserId}`);
            localStorage.removeItem(`user_avatar_${lastUserId}`);
            localStorage.removeItem(`preferences_${lastUserId}`);
            console.log(`Cleared data for known user ID: ${lastUserId}`);
          }
          
          // Method 2: Scan and clear all user-specific data patterns
          // This handles cases where last_user_id is missing
          const keysToRemove = [];
          const userDataPatterns = [
            'preferred_name_',
            'custom_title_',
            'organization_',
            'user_avatar_',
            'preferences_',
            'user_stats_'
          ];
          
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) {
              // Check if key matches any user data pattern
              const isUserData = userDataPatterns.some(pattern => key.startsWith(pattern));
              if (isUserData) {
                keysToRemove.push(key);
              }
            }
          }
          
          // Clear all found user data
          keysToRemove.forEach(key => {
            localStorage.removeItem(key);
            console.log(`Removed user data: ${key}`);
          });
          
          // Clear general user data that's not user-id specific
          const generalUserData = [
            'last_user_id',
            'user_stars',
            'userUploadedClassifiers',
            'user_follows',
            'uploadedClassifiers'  
          ];
          
          generalUserData.forEach(key => {
            if (localStorage.getItem(key)) {
              localStorage.removeItem(key);
              console.log(`Removed general user data: ${key}`);
            }
          });
          
          console.log('User data cleared from localStorage during logout (delayed)');
        } catch (error) {
          console.warn('Failed to clear some localStorage data during logout:', error);
        }
      }, 2000); // 2 second delay to allow re-login data sync
    }
    
    console.log('User signed out successfully.');
    
    // execute all callbacks
    callbacks.forEach((callback) => callback());
    
    // Note: No need to reload the page - the auth state change will trigger
    // the necessary state resets in the components via onAuthStateChanged
  } catch (error) {
    console.error('Error signing out:', error);
  }
};