'use client'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { useUserInfo } from '@/provider/UserInfoProvider'
import { CheckCircle, LogOut, Settings, User } from 'lucide-react'
import React, { useState } from 'react'
import { createPortal } from 'react-dom'

interface ProfileDropdownProps {
  isOpen: boolean
  onClose: () => void
  onLogout: () => void
  onOpenAccountSettings: () => void
  onOpenPreferences: () => void
  customTitle: string
  preferredName: string
  organization: string
  avatarPreview: string
}

const ProfileDropdown: React.FC<ProfileDropdownProps> = ({
  isOpen,
  onClose,
  onLogout,
  onOpenAccountSettings,
  onOpenPreferences,
  customTitle,
  preferredName,
  organization,
  avatarPreview,
}) => {
  const { userInfo } = useUserInfo()

  // Copy success toast state
  const [copyToast, setCopyToast] = useState<{ visible: boolean; message: string }>({
    visible: false,
    message: ''
  })

  // Modal handlers - now using props from parent
  const handleAccountSettings = () => {
    onOpenAccountSettings()
  }

  const handlePreferences = () => {
    onOpenPreferences()
  }

  const handleLogout = () => {
    onLogout()
    onClose()
  }

  // Copy text to clipboard with success toast
  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyToast({ visible: true, message: `${label} copied!` })

      // Auto dismiss after 1 second
      setTimeout(() => {
        setCopyToast({ visible: false, message: '' })
      }, 1000)
    } catch (error) {
      console.error('Failed to copy to clipboard:', error)
    }
  }

  if (!isOpen) return null

  return createPortal(
    <div
      className='absolute left-0 bottom-28 flex w-80 flex-col rounded-lg bg-[hsl(var(--dropdown-bg))] border border-border px-6 py-6 text-left shadow-xl z-50'
      onClick={(e) => e.stopPropagation()}
      onMouseLeave={onClose}
    >
      {userInfo ? (
        <>
          {/* User Info Section */}
          <div className='flex items-center gap-3 min-w-0 mb-6'>
            <Avatar key={avatarPreview || 'fallback'} className={`h-12 w-12 shrink-0 ${avatarPreview ? '' : 'bg-primary text-muted-foreground'}`}>
              {avatarPreview ? (
                <AvatarImage
                  src={avatarPreview}
                  alt={preferredName || userInfo.email || "User"}
                  onError={() => { /* no-op: header controls global preview */ }}
                />
              ) : null}
              <AvatarFallback delayMs={0} className="text-sm bg-primary text-primary-foreground">
                {preferredName
                  ? preferredName.charAt(0).toUpperCase()
                  : userInfo.email
                    ? userInfo.email.charAt(0).toUpperCase()
                    : "U"
                }
              </AvatarFallback>
            </Avatar>
            <div className='flex-1 min-w-0'>
              <div
                className='max-w-[94%] truncate text-foreground font-medium text-sm'
                title={preferredName || userInfo.email || undefined}
              >
                {preferredName || userInfo.email}
              </div>
              <div
                className="text-muted-foreground text-[10px] cursor-pointer hover:text-foreground transition-colors"
                onClick={() => copyToClipboard(userInfo.user_id, 'User ID')}
                title="Click to copy User ID"
              >
                User ID: {userInfo.user_id}
              </div>
            </div>
          </div>

          {/* Organization Display */}
          <div className='w-full justify-start gap-3 px-2 py-2 text-left text-sm font-medium text-muted-foreground cursor-default'>
            <div className='flex items-center justify-between min-w-0'>
              <span>Organization</span>
              <span className='text-[hsl(var(--success))] px-1 py-0.5 rounded text-xs ml-auto max-w-[60%] truncate flex-1 min-w-0 text-right'
                title={organization || 'null'}
              >
                {organization || 'null'}
              </span>
            </div>
          </div>

          {/* Custom Title Display - GitHub style */}
          <div className='w-full justify-start gap-3 px-2 py-2 text-left text-sm font-medium text-muted-foreground cursor-default'>
            <div className='flex items-center justify-between min-w-0'>
              <span>Title</span>
              <span className='text-primary px-1 py-0.5 rounded text-xs ml-auto max-w-[60%] truncate flex-1 min-w-0 text-right'
              title={customTitle || 'null'}
              >
                {customTitle || 'null'}
              </span>
            </div>
          </div>
          <div className='border-t border-text-foreground/50 my-2'></div>

          {/* Menu Items */}
          <div className='space-y-1'>
            <Button
              variant='ghost'
              className='w-full justify-start gap-3 px-2 py-2 text-left text-sm font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
              onClick={handleAccountSettings}
            >
              <User size={18} />
              Account Settings
            </Button>

            <Button
              variant='ghost'
              className='w-full justify-start gap-3 px-2 py-2 text-left text-sm font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
              onClick={handlePreferences}
            >
              <Settings size={18} />
              Preferences
            </Button>

            <div className='border-t border-text-foreground/50 my-2'></div>

            <Button
              variant='ghost'
              className='w-full justify-start gap-3 px-2 py-2 text-left text-sm font-medium text-destructive hover:bg-foreground/5 hover:font-bold hover:text-destructive'
              onClick={handleLogout}
            >
              <LogOut size={18} />
              Log out
            </Button>
          </div>
        </>
      ) : (
        <div className='text-muted-foreground'>Loading user info...        </div>
      )}

      {/* Success Toast */}
      {copyToast.visible && (
        <>
          {/* Transparent overlay to capture clicks and close toast when clicked */}
          <div
            className="fixed inset-0 z-[9998] bg-transparent"
            onClick={() => setCopyToast({ visible: false, message: '' })}
          />
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] pointer-events-auto">
            <div className="bg-[hsl(var(--success))/10] border border-[hsl(var(--success))/30] rounded-lg shadow-lg p-3 max-w-48 min-w-40">
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-[hsl(var(--success))] flex-shrink-0" />
                <div className="text-sm font-medium text-[hsl(var(--success))]">{copyToast.message}</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
 ,
  document.body
)
}

export default ProfileDropdown