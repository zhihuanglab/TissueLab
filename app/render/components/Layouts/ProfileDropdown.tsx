'use client'

import React, { useState, useEffect } from 'react'
import { User, LogOut, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useUserInfo } from '@/provider/UserInfoProvider'

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

  if (!isOpen) return null

  return (
    <div
      className='absolute right-0 top-12 flex w-80 flex-col rounded-lg bg-gray-900 border border-gray-700 px-6 py-6 text-left shadow-xl z-50'
      onClick={(e) => e.stopPropagation()}
      onMouseLeave={onClose}
    >
      {userInfo ? (
        <>
          {/* User Info Section */}
          <div className='flex items-center gap-4 mb-6'>
            <Avatar key={avatarPreview || 'fallback'} className={`h-12 w-12 ${avatarPreview ? '' : 'bg-gray-700 text-gray-200'}`}>
              {avatarPreview ? (
                <AvatarImage 
                  src={avatarPreview} 
                  alt={preferredName || userInfo.email || "User"}
                  onError={() => { /* no-op: header controls global preview */ }}
                />
              ) : null}
              <AvatarFallback delayMs={0} className="text-sm bg-gray-700 text-gray-200">
                {preferredName 
                  ? preferredName.charAt(0).toUpperCase() 
                  : userInfo.email 
                    ? userInfo.email.charAt(0).toUpperCase() 
                    : "U"
                }
              </AvatarFallback>
            </Avatar>
            <div className='flex-1'>
              <div className='text-gray-200 font-medium text-sm'>
                {preferredName || userInfo.email}
              </div>
              <div className='text-gray-400 text-xs'>
                User ID: {userInfo.user_id}
              </div>
            </div>
          </div>

          {/* Organization Display */}
          <div className='w-full justify-start gap-3 px-2 py-2 text-left text-sm font-medium text-gray-300 cursor-default'>
            <div className='flex items-center justify-between'>
              <span>Organization</span>
              <span className='text-green-300 bg-gray-800 px-2 py-0.5 rounded text-xs'>
                {organization || 'null'}
              </span>
            </div>
          </div>

          {/* Custom Title Display - GitHub style */}
          <div className='w-full justify-start gap-3 px-2 py-2 text-left text-sm font-medium text-gray-300 cursor-default'>
            <div className='flex items-center justify-between'>
              <span>Title</span>
              <span className='text-blue-300 bg-gray-800 px-2 py-0.5 rounded text-xs'>
                {customTitle || 'null'}
              </span>
            </div>
          </div>

          <div className='border-t border-gray-700 my-2'></div>

          {/* Menu Items */}
          <div className='space-y-1'>
            <Button
              variant='ghost'
              className='w-full justify-start gap-3 px-2 py-2 text-left text-sm font-medium text-gray-300 hover:text-gray-100 hover:bg-gray-800'
              onClick={handleAccountSettings}
            >
              <User size={18} />
              Account Settings
            </Button>

            <Button
              variant='ghost'
              className='w-full justify-start gap-3 px-2 py-2 text-left text-sm font-medium text-gray-300 hover:text-gray-100 hover:bg-gray-800'
              onClick={handlePreferences}
            >
              <Settings size={18} />
              Preferences
            </Button>

            <div className='border-t border-gray-700 my-2'></div>

            <Button
              variant='ghost'
              className='w-full justify-start gap-3 px-2 py-2 text-left text-sm font-medium text-red-400 hover:text-red-300 hover:bg-gray-800'
              onClick={handleLogout}
            >
              <LogOut size={18} />
              Log out
            </Button>
          </div>
        </>
      ) : (
        <div className='text-gray-400'>Loading user info...</div>
      )}
    </div>
  )
}

export default ProfileDropdown