'use client'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import AvatarCropper from '@/components/ui/AvatarCropper'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { deleteUserAvatarEndpoint, updateUserProfileEndpoint, uploadUserAvatarEndpoint } from '@/config/endpoints'
import { useUserInfo } from '@/provider/UserInfoProvider'
import { setUserAvatarUrl } from '@/store/slices/userSlice'
import { apiFetch } from '@/utils/common/apiFetch'
import { getFirestoreDb } from '@/config/firebaseFirestore'
import { doc, setDoc } from 'firebase/firestore'
import { getDownloadURL, getStorage, ref } from 'firebase/storage'
import { Copy } from 'lucide-react'
import React, { useEffect, useState } from 'react'
import { useDispatch } from 'react-redux'
import { toast } from 'sonner'

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

  // Copy text to clipboard with success toast
  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label} copied!`)
    } catch (error) {
      console.error('Failed to copy to clipboard:', error)
      toast.error('Copy failed', {
        description: 'Failed to copy to clipboard'
      })
    }
  }
  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // File type validation - supported formats
    const supportedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    if (!supportedTypes.includes(file.type)) {
      toast.warning('Unsupported file type', {
        description: 'Please upload JPG, PNG, GIF, or WebP images.'
      })
      return
    }

    // File size validation - max 5MB
    const maxSize = 5 * 1024 * 1024 // 5MB in bytes
    if (file.size > maxSize) {
      toast.warning('File size too large', {
        description: 'Please upload an image smaller than 5MB.'
      })
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
        await apiFetch(deleteUserAvatarEndpoint(userInfo.user_id), {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${await getAuthToken()}`,
          },
          returnAxiosFormat: true,
        })
      } catch {}
      try {
        // Clear Firestore profile avatar to broadcast change across clients
        const db = getFirestoreDb()
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
            const resp = await apiFetch(uploadUserAvatarEndpoint(userInfo.user_id), {
              method: 'POST',
              body: form,
              headers: {
                'Authorization': `Bearer ${await getAuthToken()}`,
              },
              returnAxiosFormat: true,
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
                  const db = getFirestoreDb()
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
            toast.error('Avatar upload failed', {
              description: 'Please try again.'
            })
          }
        } else if (avatarPreview && avatarPreview.startsWith('data:image')) {
          // Fallback: user changed avatar earlier (base64) but not picked a new file this time
          try {
            const res = await apiFetch(avatarPreview, {
              method: 'GET',
              isReturnResponse: true,
            })
            const blob = await res.blob()
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
            const resp = await apiFetch(uploadUserAvatarEndpoint(userInfo.user_id), {
              method: 'POST',
              body: form,
              headers: {
                'Authorization': `Bearer ${await getAuthToken()}`,
              },
              returnAxiosFormat: true,
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
                  const db = getFirestoreDb()
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
          const db = getFirestoreDb()
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
        
        toast.success('Settings saved', {
          description: 'Your preferences have been saved successfully.'
        })
        
        // Don't auto-close modal, let user decide
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
        className="max-w-5xl w-[90vw] max-h-[90vh] overflow-y-auto bg-card border-border text-foreground"
        onPointerDownOutside={(e) => {
          // Prevent accidental closes when clicking inside
        }}
        onInteractOutside={(e) => {
          // Allow closing only on escape or explicit close button
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold text-foreground">
            Account Settings
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            manage your account settings and preferences
          </DialogDescription>
        </DialogHeader>


        <div className="space-y-6 mt-6">
          {/* User Profile Section */}
          <div className="space-y-4">
            <h3 className="text-base font-medium text-foreground">Profile</h3>
            
            <div className="flex items-center space-x-4">
              <div className="relative">
                <Avatar key={avatarPreview || 'fallback'} className={`h-16 w-16 cursor-pointer hover:opacity-80 transition-opacity ${avatarPreview ? '' : 'bg-muted text-muted-foreground'}`} onClick={() => setIsAvatarEditOpen(true)}>
                  {avatarPreview ? (
                    <AvatarImage 
                      src={avatarPreview} 
                      alt={preferredName || userInfo?.email || "User"}
                      onError={() => setAvatarPreview('')}
                    />
                  ) : null}
                  <AvatarFallback delayMs={0} className="text-lg bg-muted text-muted-foreground">
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
                <Button
                  onClick={() => setIsAvatarEditOpen(true)}
                  size="icon"
                  className="absolute bottom-0 right-0 h-6 w-6 rounded-full"
                >
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </Button>
              </div>
              <div>
                <div className="font-medium text-foreground">{preferredName || userInfo?.email}</div>
                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  <span 
                    className="cursor-pointer hover:text-foreground transition-colors"
                    onClick={() => copyToClipboard(userInfo.user_id, 'User ID')}
                    title="Click to copy User ID"
                  >
                    User ID: {userInfo.user_id}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(userInfo.user_id, 'User ID')}
                    className="h-6 w-6 p-0 hover:bg-accent -mt-0.5"
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <Separator className="bg-border" />

          {/* Preferred Name Section */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-base font-medium text-foreground">Personal Information</h3>
              <Button
                onClick={saveUserPreferences}
                disabled={isLoading}
                size="sm"
              >
                {isLoading ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
            
            <div className="space-y-4">
              <div>
                <Label htmlFor="preferredName" className="text-sm font-medium text-muted-foreground">
                  Preferred Name
                </Label>
                <p className="text-xs text-muted-foreground mt-1">
                  This will be displayed instead of your email in the profile
                </p>
                <Input
                  id="preferredName"
                  value={preferredName}
                  onChange={(e) => setPreferredName(e.target.value)}
                  placeholder="Enter your preferred name"
                  className="mt-2 bg-background border-border text-foreground"
                  maxLength={50}
                />
                <div className="text-xs text-muted-foreground mt-1">
                  Character count: {preferredName.length}/50
                </div>
              </div>

              <div>
                <Label htmlFor="organization" className="text-sm font-medium text-muted-foreground">
                  Organization
                </Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Your company or organization name
                </p>
                <Input
                  id="organization"
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                  placeholder="Enter your organization"
                  className="mt-2 bg-background border-border text-foreground"
                  maxLength={100}
                />
                <div className="text-xs text-muted-foreground mt-1">
                  Character count: {organization.length}/100
                </div>
              </div>

              <div>
                <Label htmlFor="customTitle" className="text-sm font-medium text-muted-foreground">
                  Custom Title
                </Label>
                <p className="text-xs text-muted-foreground mt-1">
                  This will be displayed in your profile dropdown
                </p>
                <Input
                  id="customTitle"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="Enter your custom title"
                  className="mt-2 bg-background border-border text-foreground"
                  maxLength={50}
                />
                <div className="text-xs text-muted-foreground mt-1">
                  Character count: {customTitle.length}/50
                </div>
              </div>
            </div>
          </div>

          <Separator className="bg-border" />

          {/* Account Management */}
          <div className="space-y-4">
            <h3 className="text-base font-medium text-foreground">Account Management</h3>
            
            <div className="space-y-3">
              <div>
                <h4 className="text-sm font-medium text-muted-foreground">Email</h4>
                <div className="flex items-start gap-2">
                  <p className="text-sm text-muted-foreground">{userInfo?.email}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(userInfo?.email || '', 'Email')}
                    className="h-6 w-6 p-0 hover:bg-accent -mt-0.5"
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              
              <div>
                <h4 className="text-sm font-medium text-muted-foreground">Account Created</h4>
                <p className="text-sm text-muted-foreground">
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

          <Separator className="bg-border" />

          {/* Danger Zone */}
          <div className="space-y-4">
            <h3 className="text-base font-medium text-destructive">Danger Zone</h3>
            
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4">
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="text-sm font-medium text-destructive">Delete Account</h4>
                  <p className="text-xs text-destructive/80 mt-1">
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
        <DialogContent className="max-w-md bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold text-foreground">
              Edit Profile Photo
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Update or remove your profile photo
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 mt-6">
            {/* Current Avatar Preview */}
            <div className="flex justify-center">
              <Avatar key={avatarPreview || 'fallback'} className={`h-24 w-24 ${avatarPreview ? '' : 'bg-muted text-muted-foreground'}`}>
                {avatarPreview ? (
                  <AvatarImage 
                    src={avatarPreview} 
                    alt={preferredName || userInfo?.email || "User"}
                    onError={() => setAvatarPreview('')}
                  />
                ) : null}
                <AvatarFallback delayMs={0} className="text-2xl bg-muted text-muted-foreground">
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
                className="w-full"
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
                  className="w-full border-destructive/30 text-destructive hover:bg-destructive/10 hover:border-destructive/40"
                >
                  <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Remove Photo
                </Button>
              )}
            </div>

            {/* Info Text */}
            <div className="text-xs text-muted-foreground text-center">
              Supported formats: JPG, PNG, GIF, WebP<br />
              Maximum file size: 5MB<br />
              <span className="text-primary">Crop and resize after upload</span>
            </div>
          </div>

          <div className="flex justify-end mt-6 pt-4 border-t border-border">
            <Button
              onClick={() => setIsAvatarEditOpen(false)}
              variant="outline"
              className="border-border text-foreground hover:bg-accent"
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

    </div>
  )
}

export default AccountSettingsModal
