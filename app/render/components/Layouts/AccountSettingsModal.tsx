'use client'

import React, { useState, useEffect, useLayoutEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { useUserInfo } from '@/provider/UserInfoProvider'
import { apiFetch } from '@/utils/apiFetch'
import http from '@/utils/http'
import { updateUserProfileEndpoint, uploadUserAvatarEndpoint, getUserAvatarEndpoint, deleteUserAvatarEndpoint } from '@/config/endpoints'
import { useDispatch, useSelector } from 'react-redux'
import { setUserAvatarUrl } from '@/store/slices/userSlice'
import { doc, getFirestore, setDoc, serverTimestamp } from 'firebase/firestore'
import { getStorage, ref, getDownloadURL } from 'firebase/storage'
import AvatarCropper from '@/components/ui/AvatarCropper'
import NotificationToast from '@/components/ui/NotificationToast'

interface AccountSettingsModalProps {
  isOpen: boolean
  onClose: () => void
  onTitleUpdate?: (title: string) => void
  onPreferencesUpdate?: (preferences: { customTitle?: string, preferredName?: string, organization?: string, avatarPreview?: string }) => void
}

const AccountSettingsModal: React.FC<AccountSettingsModalProps> = ({
  isOpen,
  onClose,
  onTitleUpdate,
  onPreferencesUpdate,
}) => {
  const { userInfo, logout, updateUserInfo, getAuthToken } = useUserInfo()
  const dispatch = useDispatch()

  // Helper function to get authenticated Firebase Storage URL
  const getAuthenticatedStorageUrl = async (storageUrl: string) => {
    try {
      // Check if it's a Firebase Storage URL
      if (storageUrl.includes('firebasestorage.googleapis.com') || storageUrl.includes('storage.googleapis.com')) {
        const storage = getStorage()
        const storageRef = ref(storage, storageUrl)
        const downloadUrl = await getDownloadURL(storageRef)
        return downloadUrl
      }
      return storageUrl // Return as-is if not Firebase Storage
    } catch (error) {
      console.warn('Failed to get authenticated storage URL:', error)
      return storageUrl // Fallback to original URL
    }
  }
  const [preferredName, setPreferredName] = useState('')
  const [customTitle, setCustomTitle] = useState('')
  const [organization, setOrganization] = useState('')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [isAvatarEditOpen, setIsAvatarEditOpen] = useState(false)
  const [isCropperOpen, setIsCropperOpen] = useState(false)
  const [originalImage, setOriginalImage] = useState<string>('')
  const [originalFileName, setOriginalFileName] = useState<string>('')

  // Reset states when modal opens - NO component recreation
  useEffect(() => {
    if (isOpen) {
      // Only reset UI states, don't recreate components
      setIsLoading(false)
      setIsAvatarEditOpen(false)
      setAvatarFile(null)
      // Keep inputs ready - don't disable them
    }
  }, [isOpen])

  // Load user preferences from localStorage - with performance optimization
  useEffect(() => {
    if (!isOpen || !userInfo?.user_id || typeof window === 'undefined') {
      return
    }
    
    // Use setTimeout to make localStorage read non-blocking
    const loadPreferences = () => {
      try {
        const savedTitle = localStorage.getItem(`custom_title_${userInfo.user_id}`)
        const savedName = localStorage.getItem(`preferred_name_${userInfo.user_id}`)
        const savedOrganization = localStorage.getItem(`organization_${userInfo.user_id}`)
        const savedAvatar = localStorage.getItem(`user_avatar_${userInfo.user_id}`)
        
        const title = savedTitle || ''
        const name = savedName || ''
        const org = savedOrganization || ''
        const avatar = savedAvatar || ''
        
        
        setCustomTitle(title)
        setPreferredName(name)
        setOrganization(org)
        setAvatarPreview(avatar)
        
        
      } catch (error) {
        console.error('Error loading preferences:', error)
      }
    }
    
    // Make it non-blocking but with a fallback
    const timeoutId = setTimeout(loadPreferences, 0)
    
    // Cleanup timeout on unmount
    return () => clearTimeout(timeoutId)
  }, [isOpen, userInfo?.user_id])


  // Use useLayoutEffect to ensure input readiness after state changes - reduce dependencies to prevent excessive re-runs

  // Handle avatar file selection - now opens cropper
  const [toast, setToast] = useState<{ visible: boolean; title: string; message: string, variant?: 'success' | 'warning' | 'error' }>(
    { visible: false, title: '', message: '', variant: 'success' }
  )

  const showToast = (title: string, message: string, variant: 'success' | 'warning' | 'error' = 'success') => {
    setToast({ visible: true, title, message, variant })
  }
  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // File type validation - supported formats
    const supportedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    if (!supportedTypes.includes(file.type)) {
      showToast('Unsupported file type', 'Please upload JPG, PNG, GIF, or WebP images.', 'warning')
      return
    }

    // File size validation - max 5MB
    const maxSize = 5 * 1024 * 1024 // 5MB in bytes
    if (file.size > maxSize) {
      showToast('File size too large', 'Please upload an image smaller than 5MB.', 'warning')
      return
    }

    // Read file and open cropper
    setOriginalFileName(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      const result = e.target?.result as string
      setOriginalImage(result)
      setIsCropperOpen(true)
      setIsAvatarEditOpen(false) // Close avatar edit modal
    }
    reader.readAsDataURL(file)
  }

  // Handle cropped image from cropper
  const handleCropComplete = (croppedFile: File) => {
    setAvatarFile(croppedFile)
    const reader = new FileReader()
    reader.onload = (e) => {
      const result = e.target?.result as string
      setAvatarPreview(result)
    }
    reader.readAsDataURL(croppedFile)
  }

  // Handle avatar deletion - restore to default
  const handleAvatarDelete = async () => {
    setAvatarFile(null)
    setAvatarPreview('')
    if (typeof window !== 'undefined' && userInfo?.user_id) {
      localStorage.removeItem(`user_avatar_${userInfo.user_id}`)
      // Call backend to delete stored avatar
      try {
        await http.delete(deleteUserAvatarEndpoint(userInfo.user_id), {
          headers: {
            'Authorization': `Bearer ${await getAuthToken()}`,
          },
        })
      } catch {}
      try {
        // Clear Firestore profile avatar to broadcast change across clients
        const db = getFirestore()
        const profileRef = doc(db, 'users', userInfo.user_id)
        const ts = Date.now()
        setDoc(profileRef, { avatar_url: '', avatarUpdatedAt: ts }, { merge: true })
      } catch (e) {
        console.warn('Failed to clear avatar in Firestore:', e)
      }
      try {
        // Also clear avatar in backend profile so API returns empty URL
        apiFetch(updateUserProfileEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            preferred_name: preferredName || "",
            custom_title: customTitle || "",
            organization: organization || "",
            avatar_url: "",
          }),
        }).catch(() => {})
      } catch {}
      try {
        // Broadcast to same-tab listeners
        window.dispatchEvent(new Event('localStorageChanged'))
      } catch {}
    }
    // Update global Redux avatar to ensure immediate UI refresh
    try { dispatch(setUserAvatarUrl(null)) } catch {}
    setIsAvatarEditOpen(false)
  }

  // Save all user preferences to localStorage AND backend following Kaze.ai pattern
  const saveUserPreferences = async () => {
    if (typeof window !== 'undefined' && userInfo?.user_id) {
      setIsLoading(true)
      try {
        // Step 1: Save to localStorage for immediate UI response
        localStorage.setItem(`custom_title_${userInfo.user_id}`, customTitle)
        localStorage.setItem(`preferred_name_${userInfo.user_id}`, preferredName)
        localStorage.setItem(`organization_${userInfo.user_id}`, organization)
        // Avatar uploading to backend if a new file is selected
        if (avatarFile) {
          try {
            const form = new FormData()
            form.append('file', avatarFile)
            const resp = await http.post(uploadUserAvatarEndpoint(userInfo.user_id), form, {
              headers: {
                'Authorization': `Bearer ${await getAuthToken()}`,
              }
            })
            const data = resp.data
            const newUrl = data?.avatar_url || ''
            if (newUrl) {
              try {
                // Get authenticated URL for Firebase Storage
                const authenticatedUrl = await getAuthenticatedStorageUrl(newUrl)
                const ts = Date.now()
                const urlWithTs = `${authenticatedUrl}${authenticatedUrl.includes('?') ? '&' : '?'}t=${ts}`
                localStorage.setItem(`user_avatar_${userInfo.user_id}`, urlWithTs)
                setAvatarPreview(urlWithTs)
                dispatch(setUserAvatarUrl(urlWithTs))
                // write to Firestore profile to broadcast change
                try {
                  const db = getFirestore()
                  const profileRef = doc(db, 'users', userInfo.user_id)
                  await setDoc(profileRef, { avatar_url: newUrl, avatarUpdatedAt: ts }, { merge: true })
                } catch (e) {
                  console.warn('Failed to write avatar to Firestore:', e)
                }
              } catch (error) {
                console.warn('Failed to process uploaded avatar URL:', error)
              }
            }
          } catch (e) {
            showToast('Avatar upload failed', 'Please try again.', 'error')
          }
        } else if (avatarPreview && avatarPreview.startsWith('data:image')) {
          // Fallback: user changed avatar earlier (base64) but not picked a new file this time
          try {
            const res = await http.get(avatarPreview, { responseType: 'blob' })
            const blob = res.data
            // Only accept JPEG/PNG
            const mime = blob.type
            if (!['image/jpeg','image/jpg','image/png'].includes(mime)) {
              throw new Error('Unsupported avatar mime')
            }
            if (blob.size > 5 * 1024 * 1024) {
              throw new Error('Avatar too large (>5MB)')
            }
            const form = new FormData()
            form.append('file', new File([blob], `avatar.${mime.includes('png') ? 'png' : 'jpg'}`, { type: mime }))
            const resp = await http.post(uploadUserAvatarEndpoint(userInfo.user_id), form, {
              headers: {
                'Authorization': `Bearer ${await getAuthToken()}`,
              }
            })
            const data = resp.data
            const newUrl = data?.avatar_url || ''
            if (newUrl) {
              try {
                // Get authenticated URL for Firebase Storage
                const authenticatedUrl = await getAuthenticatedStorageUrl(newUrl)
                const ts = Date.now()
                const urlWithTs = `${authenticatedUrl}${authenticatedUrl.includes('?') ? '&' : '?'}t=${ts}`
                localStorage.setItem(`user_avatar_${userInfo.user_id}`, urlWithTs)
                setAvatarPreview(urlWithTs)
                dispatch(setUserAvatarUrl(urlWithTs))
                try {
                  const db = getFirestore()
                  const profileRef = doc(db, 'users', userInfo.user_id)
                  await setDoc(profileRef, { avatar_url: newUrl, avatarUpdatedAt: ts }, { merge: true })
                } catch (e) {
                  console.warn('Failed to write avatar to Firestore:', e)
                }
              } catch (error) {
                console.warn('Failed to process uploaded avatar URL:', error)
              }
            }
          } catch (e) {
            console.warn('Fallback avatar upload failed:', e)
          }
        }

        // Trigger custom event for same-tab localStorage changes
        window.dispatchEvent(new Event('localStorageChanged'))

        // Step 2: Sync to backend for admin access and data persistence
        try {
          // send profile update to backend
          
          const response = await apiFetch(updateUserProfileEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              preferred_name: preferredName || "",
              custom_title: customTitle || "",
              organization: organization || "",
              avatar_url: avatarPreview || "",
            }),
          })
          
          /* debug removed: backend response */
          
          if (response.success) {
            /* debug removed: profile update successful */

            // Refresh user info to trigger updates in other components
            await updateUserInfo();
          } else {
            console.warn('Backend sync partially failed:', response.message);
          }
        } catch (backendError) {
          // Don't break the UI if backend sync fails - localStorage is the fallback
          console.error('Backend sync failed, but localStorage saved:', backendError);
        }

        // Step 2.5: Also write directly to Firestore to ensure cross-client sync
        try {
          const db = getFirestore()
          const profileRef = doc(db, 'users', userInfo.user_id)
          const updateData: any = {}
          
          // Only update non-avatar fields here (avatar is handled separately above)
          updateData.preferred_name = preferredName || ""
          updateData.custom_title = customTitle || ""
          updateData.organization = organization || ""
          updateData.profileUpdatedAt = Date.now()

          await setDoc(profileRef, updateData, { merge: true })
          console.log('Profile data synced to Firestore successfully')
        } catch (firestoreError) {
          console.warn('Failed to sync profile to Firestore:', firestoreError)
          // Don't break the flow if Firestore sync fails
        }
        
        // Step 3: Update parent components
        onTitleUpdate?.(customTitle)
        onPreferencesUpdate?.({
          customTitle,
          preferredName,
          organization,
          avatarPreview
        })
        
        
        
        // Don't auto-close modal, let user decide
        // Success feedback could be added here (toast, etc.)
      } catch (error) {
        console.error('Error saving user preferences:', error)
      } finally {
        setIsLoading(false)
      }
    }
  }

  const handleDeleteAccount = async () => {
    if (confirm('Are you sure you want to delete your account? This action cannot be undone.')) {
      try {
        setIsLoading(true)
        // Here you would typically call a delete account API
        /* debug removed: delete account requested */
        await logout()
      } catch (error) {
        console.error('Error deleting account:', error)
      } finally {
        setIsLoading(false)
      }
    }
  }


  const handleClose = () => {
    onClose() // Simply close the modal
  }

  if (!userInfo) return null


  return (
    <div>
      <Dialog 
      open={isOpen} 
      onOpenChange={(open) => {
        // Handle all dialog close events (ESC, outside click, etc.)
        if (!open) {
          handleClose()
        }
      }}>
      <DialogContent 
        className="max-w-5xl w-[90vw] max-h-[90vh] overflow-y-auto bg-gray-50 border-gray-300 text-gray-900"
        onPointerDownOutside={(e) => {
          // Prevent accidental closes when clicking inside
        }}
        onInteractOutside={(e) => {
          // Allow closing only on escape or explicit close button
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold text-gray-800">
            Account Settings
          </DialogTitle>
          <DialogDescription className="text-gray-600">
            manage your account settings and preferences
          </DialogDescription>
        </DialogHeader>


        <div className="space-y-6 mt-6">
          {/* User Profile Section */}
          <div className="space-y-4">
            <h3 className="text-base font-medium text-gray-700">Profile</h3>
            
            <div className="flex items-center space-x-4">
              <div className="relative">
                <Avatar key={avatarPreview || 'fallback'} className={`h-16 w-16 cursor-pointer hover:opacity-80 transition-opacity ${avatarPreview ? '' : 'bg-gray-200 text-gray-700'}`} onClick={() => setIsAvatarEditOpen(true)}>
                  {avatarPreview ? (
                    <AvatarImage 
                      src={avatarPreview} 
                      alt={preferredName || userInfo?.email || "User"}
                      onError={() => setAvatarPreview('')}
                    />
                  ) : null}
                  <AvatarFallback delayMs={0} className="text-lg bg-gray-200 text-gray-700">
                    {preferredName 
                      ? preferredName.charAt(0).toUpperCase() 
                      : userInfo?.email 
                        ? userInfo?.email?.charAt(0).toUpperCase() 
                        : "U"
                    }
                  </AvatarFallback>
                </Avatar>
                <input
                  type="file"
                  id="avatar-upload"
                  accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                  onChange={handleAvatarChange}
                  className="hidden"
                />
                <button
                  onClick={() => setIsAvatarEditOpen(true)}
                  className="absolute bottom-0 right-0 bg-blue-600 hover:bg-blue-700 text-white rounded-full p-1 cursor-pointer transition-colors"
                >
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
              </div>
              <div>
                <div className="font-medium text-gray-800">{preferredName || userInfo?.email}</div>
                <div className="text-sm text-gray-500">User ID: {userInfo.user_id}</div>
              </div>
            </div>
          </div>

          <Separator className="bg-gray-300" />

          {/* Preferred Name Section */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-base font-medium text-gray-700">Personal Information</h3>
              <div className="flex space-x-2">
                <Button
                  onClick={saveUserPreferences}
                  disabled={isLoading}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  size="sm"
                >
                  {isLoading ? 'Saving...' : 'Save Changes'}
                </Button>
                <Button
                  onClick={handleClose}
                  variant="outline"
                  className="border-gray-300 text-gray-700 hover:bg-white"
                  size="sm"
                >
                  Close
                </Button>
              </div>
            </div>
            
            <div className="space-y-4">
              <div>
                <Label htmlFor="preferredName" className="text-sm font-medium text-gray-600">
                  Preferred Name
                </Label>
                <p className="text-xs text-gray-500 mt-1">
                  This will be displayed instead of your email in the profile
                </p>
                <Input
                  id="preferredName"
                  value={preferredName}
                  onChange={(e) => setPreferredName(e.target.value)}
                  placeholder="Enter your preferred name"
                  className="mt-2 bg-white border-gray-300 text-gray-800"
                  maxLength={50}
                />
                <div className="text-xs text-gray-500 mt-1">
                  Character count: {preferredName.length}/50
                </div>
              </div>

              <div>
                <Label htmlFor="organization" className="text-sm font-medium text-gray-600">
                  Organization
                </Label>
                <p className="text-xs text-gray-500 mt-1">
                  Your company or organization name
                </p>
                <Input
                  id="organization"
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                  placeholder="Enter your organization"
                  className="mt-2 bg-white border-gray-300 text-gray-800"
                  maxLength={100}
                />
                <div className="text-xs text-gray-500 mt-1">
                  Character count: {organization.length}/100
                </div>
              </div>

              <div>
                <Label htmlFor="customTitle" className="text-sm font-medium text-gray-600">
                  Custom Title
                </Label>
                <p className="text-xs text-gray-500 mt-1">
                  This will be displayed in your profile dropdown
                </p>
                <Input
                  id="customTitle"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="Enter your custom title"
                  className="mt-2 bg-white border-gray-300 text-gray-800"
                  maxLength={50}
                />
                <div className="text-xs text-gray-500 mt-1">
                  Character count: {customTitle.length}/50
                </div>
              </div>
            </div>
          </div>

          <Separator className="bg-gray-300" />

          {/* Account Management */}
          <div className="space-y-4">
            <h3 className="text-base font-medium text-gray-700">Account Management</h3>
            
            <div className="space-y-3">
              <div>
                <h4 className="text-sm font-medium text-gray-600">Email</h4>
                <p className="text-sm text-gray-500">{userInfo?.email}</p>
              </div>
              
              <div>
                <h4 className="text-sm font-medium text-gray-600">Account Created</h4>
                <p className="text-sm text-gray-500">
                  {userInfo.registered_at 
                    ? (() => {
                        // Handle different timestamp formats
                        const timestamp = userInfo.registered_at;
                        let date: Date;
                        
                        // If it's a very large number (milliseconds)
                        if (timestamp > 1000000000000) {
                          date = new Date(timestamp);
                        } 
                        // If it's a standard Unix timestamp (seconds)
                        else if (timestamp > 1000000000) {
                          date = new Date(timestamp * 1000);
                        } 
                        // If it's an invalid timestamp, show raw value for debugging
                        else {
                          return `Invalid timestamp: ${timestamp}`;
                        }
                        
                        // Check if date is valid
                        if (isNaN(date.getTime())) {
                          return `Invalid date: ${timestamp}`;
                        }
                        
                        return date.toLocaleDateString();
                      })()
                    : 'Unknown'
                  }
                </p>
              </div>
            </div>
          </div>

          <Separator className="bg-gray-300" />

          {/* Danger Zone */}
          <div className="space-y-4">
            <h3 className="text-base font-medium text-red-600">Danger Zone</h3>
            
            <div className="bg-red-50 border border-red-300 rounded-lg p-4">
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="text-sm font-medium text-red-700">Delete Account</h4>
                  <p className="text-xs text-red-600 mt-1">
                    Once you delete your account, there is no going back. Please be certain.
                  </p>
                </div>
                <Button
                  onClick={handleDeleteAccount}
                  disabled={true}
                  variant="destructive"
                  className="ml-4 opacity-50 cursor-not-allowed"
                >
                  Delete Account
                </Button>
              </div>
            </div>
          </div>
        </div>

      </DialogContent>
      </Dialog>

      {/* Avatar Edit Modal */}
      <Dialog open={isAvatarEditOpen} onOpenChange={setIsAvatarEditOpen}>
        <DialogContent className="max-w-md bg-gray-50 border-gray-300 text-gray-900">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold text-gray-800">
              Edit Profile Photo
            </DialogTitle>
            <DialogDescription className="text-gray-600">
              Update or remove your profile photo
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 mt-6">
            {/* Current Avatar Preview */}
            <div className="flex justify-center">
              <Avatar key={avatarPreview || 'fallback'} className={`h-24 w-24 ${avatarPreview ? '' : 'bg-gray-200 text-gray-700'}`}>
                {avatarPreview ? (
                  <AvatarImage 
                    src={avatarPreview} 
                    alt={preferredName || userInfo?.email || "User"}
                    onError={() => setAvatarPreview('')}
                  />
                ) : null}
                <AvatarFallback delayMs={0} className="text-2xl bg-gray-200 text-gray-700">
                  {preferredName 
                    ? preferredName.charAt(0).toUpperCase() 
                    : userInfo?.email 
                      ? userInfo?.email?.charAt(0).toUpperCase() 
                      : "U"
                  }
                </AvatarFallback>
              </Avatar>
            </div>

            {/* Action Buttons */}
            <div className="space-y-3">
              <Button
                asChild
                className="w-full bg-blue-600 hover:bg-blue-700"
              >
                <label htmlFor="avatar-upload-modal" className="cursor-pointer">
                  <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  {avatarPreview ? 'Change Photo' : 'Upload Photo'}
                </label>
              </Button>
              
              <input
                type="file"
                id="avatar-upload-modal"
                accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                onChange={handleAvatarChange}
                className="hidden"
              />

              {avatarPreview && (
                <Button
                  onClick={handleAvatarDelete}
                  variant="outline"
                  className="w-full border-red-300 text-red-600 hover:bg-red-50 hover:border-red-400"
                >
                  <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Remove Photo
                </Button>
              )}
            </div>

            {/* Info Text */}
            <div className="text-xs text-gray-500 text-center">
              Supported formats: JPG, PNG, GIF, WebP<br />
              Maximum file size: 5MB<br />
              <span className="text-blue-600">Crop and resize after upload</span>
            </div>
          </div>

          <div className="flex justify-end mt-6 pt-4 border-t border-gray-300">
            <Button
              onClick={() => setIsAvatarEditOpen(false)}
              variant="outline"
              className="border-gray-300 text-gray-700 hover:bg-white"
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Avatar Cropper Modal */}
      <AvatarCropper
        isOpen={isCropperOpen}
        onClose={() => setIsCropperOpen(false)}
        imageSrc={originalImage}
        onCropComplete={handleCropComplete}
        fileName={originalFileName}
      />

      <NotificationToast
        isVisible={toast.visible}
        title={toast.title}
        message={toast.message}
        onDismiss={() => setToast((t) => ({ ...t, visible: false }))}
        variant={toast.variant}
      />
    </div>
  )
}

export default AccountSettingsModal
