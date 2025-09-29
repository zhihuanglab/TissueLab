"use client";
import React, { useEffect, useRef, useState } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { RootState } from '@/store'
import { LayoutDashboard, Workflow, BookOpen, FileCode, Microscope, ChevronLeft, Menu, X, User, Settings, Layers, Grid, ZoomIn, PanelLeft, MoreHorizontal } from "lucide-react"
import { cn } from "@/utils/twMerge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Progress } from "@/components/ui/progress"
import {setSidebarShow} from "@/store/slices/sidebarSlice";
import { useSignupModal } from "@/store/zustand/store";
import { useUserInfo } from "@/provider/UserInfoProvider";
import GlobalSignupModal from "@/components/auth/GlobalSignupModal/GlobalSignupModal";
import ProfileDropdown from "./ProfileDropdown";
import AccountSettingsModal from "./AccountSettingsModal";
import PreferencesModal from "./PreferencesModal";

const AppHeader: React.FC = () => {
  const headerRef = useRef<HTMLDivElement>(null)
  const dispatch = useDispatch()
  const sidebarShow = useSelector((state: RootState) => state.sidebar.sidebarShow)
  const setSignupModalOpen = useSignupModal((s) => s.setSignupModalOpen)
  const { userInfo, userIdentity, isLoadingUser, logout } = useUserInfo()
  const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false)
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState(false)
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false)
  const [customTitle, setCustomTitle] = useState('')
  const [preferredName, setPreferredName] = useState('')
  const [organization, setOrganization] = useState('')
  const [avatarPreview, setAvatarPreview] = useState('')
  const globalAvatarUrl = useSelector((state: RootState) => state.user.avatarUrl)
  const globalPreferredName = useSelector((state: RootState) => state.user.preferredName)
  const globalCustomTitle = useSelector((state: RootState) => state.user.customTitle)
  const globalOrganization = useSelector((state: RootState) => state.user.organization)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [isWindows, setIsWindows] = useState(false)
  const [isElectron, setIsElectron] = useState(false)
  const [titlebarHeight, setTitlebarHeight] = useState<number>(64)
  const [rightInset, setRightInset] = useState<number>(0)

  useEffect(() => {
    if (typeof navigator !== 'undefined') {
      setIsWindows(navigator.userAgent.toLowerCase().includes('windows'))
    }
    if (typeof window !== 'undefined') {
      setIsElectron(!!window.electron)
    }
  }, [])

  useEffect(() => {
    // For web version, use fixed height
    if (!isElectron) {
      setTitlebarHeight(64) // Fixed height for web
      setRightInset(0) // No right inset for web
      return
    }


    // For Electron version, adapt to Windows titlebar overlay geometry like VSCode
    const w = typeof window !== 'undefined' ? window : null
    const nav: any = typeof navigator !== 'undefined' ? navigator : null
    const wco = nav && nav.windowControlsOverlay

    const updateFromOverlay = () => {
      try {
        const rect = wco?.getTitlebarAreaRect?.()
        if (rect) {
          const h = Math.max(32, Math.round(rect.height))
          setTitlebarHeight(h)
          const inset = Math.max(0, (w?.innerWidth || 0) - (rect.x + rect.width))
          setRightInset(Math.max(8, Math.round(inset + 8)))
          return true
        }
      } catch {}
      return false
    }

    if (isWindows && wco) {
      updateFromOverlay()
      wco.addEventListener?.('geometrychange', updateFromOverlay)
      
      // Also listen for window resize events to handle maximize/restore
      const handleResize = () => {
        setTimeout(updateFromOverlay, 100) // Small delay to ensure geometry is updated
      }
      window.addEventListener('resize', handleResize)
      
      return () => {
        wco.removeEventListener?.('geometrychange', updateFromOverlay)
        window.removeEventListener('resize', handleResize)
      }
    } else if (isWindows) {
      // Fallback: approximate using devicePixelRatio
      const dpr = w ? w.devicePixelRatio || 1 : 1
      setTitlebarHeight(56) // match main overlay option
      setRightInset(Math.round(136 * dpr))
    }

    // Cleanup function for all cases
    return () => {
      // No additional cleanup needed as event listeners are handled in the conditional blocks above
    }
  }, [isWindows, isElectron])

  // Load user preferences from localStorage and Redux
  useEffect(() => {
    if (typeof window !== 'undefined' && userInfo?.user_id) {
      try {
        // prefer Redux state, if not available, load from localStorage
        const rawTitle = globalCustomTitle || localStorage.getItem(`custom_title_${userInfo.user_id}`)
        const rawName = globalPreferredName || localStorage.getItem(`preferred_name_${userInfo.user_id}`)
        const rawOrg = globalOrganization || localStorage.getItem(`organization_${userInfo.user_id}`)
        const rawAvatar = globalAvatarUrl || localStorage.getItem(`user_avatar_${userInfo.user_id}`)

        const savedTitle = rawTitle && rawTitle !== 'null' ? rawTitle : ''
        const savedName = rawName && rawName !== 'null' ? rawName : ''
        const savedOrganization = rawOrg && rawOrg !== 'null' ? rawOrg : ''
        const savedAvatar = rawAvatar && rawAvatar !== 'null' ? rawAvatar : ''
        
        // synchronize whether empty or not, to avoid old value residue
        setCustomTitle(savedTitle)
        setPreferredName(savedName)
        setOrganization(savedOrganization)
        setAvatarPreview(savedAvatar)
      } catch (error) {
        console.error('Error loading user preferences:', error)
      }
    }
  }, [userInfo?.user_id, globalCustomTitle, globalPreferredName, globalOrganization, globalAvatarUrl])

  // Prefer Redux avatarUrl; fallback to localStorage-loaded avatar
  useEffect(() => {
    if (globalAvatarUrl && globalAvatarUrl !== 'null') {
      setAvatarPreview(globalAvatarUrl)
      return
    }
    if (typeof window !== 'undefined' && userInfo?.user_id) {
      const savedAvatarRaw = localStorage.getItem(`user_avatar_${userInfo.user_id}`)
      const savedAvatar = savedAvatarRaw && savedAvatarRaw !== 'null' ? savedAvatarRaw : ''
      setAvatarPreview(savedAvatar)
    }
  }, [globalAvatarUrl, userInfo?.user_id])

  // Listen cross-tab/window storage sync and custom localStorageChanged events
  useEffect(() => {
    if (typeof window === 'undefined' || !userInfo?.user_id) return

    const handleStorageChange = () => {
      try {
        // prefer Redux state, if not available, load from localStorage
        const rawAvatar = globalAvatarUrl || localStorage.getItem(`user_avatar_${userInfo.user_id}`)
        const rawTitle = globalCustomTitle || localStorage.getItem(`custom_title_${userInfo.user_id}`)
        const rawName = globalPreferredName || localStorage.getItem(`preferred_name_${userInfo.user_id}`)
        const rawOrg = globalOrganization || localStorage.getItem(`organization_${userInfo.user_id}`)

        const savedAvatar = rawAvatar && rawAvatar !== 'null' ? rawAvatar : ''
        const savedTitle = rawTitle && rawTitle !== 'null' ? rawTitle : ''
        const savedName = rawName && rawName !== 'null' ? rawName : ''
        const savedOrganization = rawOrg && rawOrg !== 'null' ? rawOrg : ''
        
        // If key exists, update; if removed, clear to fallback
        setAvatarPreview(savedAvatar || '')
        setCustomTitle(savedTitle)
        setPreferredName(savedName)
        setOrganization(savedOrganization)
      } catch {}
    }

    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('localStorageChanged', handleStorageChange as EventListener)
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('localStorageChanged', handleStorageChange as EventListener)
    }
  }, [userInfo?.user_id, globalAvatarUrl, globalCustomTitle, globalPreferredName, globalOrganization])

  // Debug logging removed

  useEffect(() => {
    const handleScroll = () => {
      if (headerRef.current) {
        headerRef.current.classList.toggle('shadow-sm', document.documentElement.scrollTop > 0)
      }
    }

    document.addEventListener('scroll', handleScroll)
    return () => {
      document.removeEventListener('scroll', handleScroll)
    }
  }, [])

  // Profile dropdown handlers
  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => {
      setIsProfileDropdownOpen(false)
    }, 1000)
  }

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
  }

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return (
    <header
      className="electron-drag relative flex flex-shrink-0 items-center border-b border-gray-700 bg-gray-900 px-6 dark:border-gray-800 dark:bg-gray-950"
      style={{ height: titlebarHeight }}>
      <div className="electron-no-drag flex items-center space-x-4">
        {!sidebarShow && (
          <Button
            variant="ghost"
            size="icon"
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            onClick={() => dispatch(setSidebarShow(!sidebarShow))}
          >
            <PanelLeft className="h-5 w-5"/>
          </Button>
        )}
      </div>
      
      {/* Middle area - prevents overlap with right side */}
      <div className="flex-1 pr-40" />
      
      {/* Right side - Login/Profile - Absolutely positioned to stay fixed */}
      <div
        className="electron-no-drag absolute top-0 flex h-full items-center space-x-4 px-6 bg-gray-900 dark:bg-gray-950"
        style={{ 
          right: isWindows ? rightInset : 0,
          minWidth: 'fit-content'
        }}>
        {userIdentity === 3 && userInfo ? (
          <>
            <div
              className="relative"
              onMouseLeave={handleMouseLeave}
              onMouseEnter={handleMouseEnter}
            >
              <Avatar 
              key={avatarPreview || 'fallback'}
                className={`h-9 w-9 cursor-pointer hover:ring-2 hover:ring-blue-500/50 transition-all ${avatarPreview ? '' : 'bg-gray-700 text-gray-200'}`}
                onClick={() => setIsProfileDropdownOpen(!isProfileDropdownOpen)}
              >
              {avatarPreview ? (
                  <AvatarImage 
                  src={avatarPreview} 
                  alt={preferredName || userInfo.email || "User"}
                  onError={() => setAvatarPreview('')}
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
              <ProfileDropdown
                isOpen={isProfileDropdownOpen}
                onClose={() => setIsProfileDropdownOpen(false)}
                onLogout={logout}
                onOpenAccountSettings={() => {
                  setIsAccountSettingsOpen(true)
                  setIsProfileDropdownOpen(false)
                }}
                onOpenPreferences={() => {
                  setIsPreferencesOpen(true)
                  setIsProfileDropdownOpen(false)
                }}
                customTitle={customTitle}
                preferredName={preferredName}
                organization={organization}
                avatarPreview={avatarPreview}
              />
            </div>
            
            {/* Electron Menu Button - Only show on Windows Electron */}
            {isWindows && isElectron && (
              <Button
                variant="ghost"
                size="icon"
                className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                onClick={(e) => {
                  if (typeof window !== 'undefined' && window.electron) {
                    // Get button position
                    const rect = e.currentTarget.getBoundingClientRect()
                    const x = Math.round(rect.left)
                    const y = Math.round(rect.bottom)
                    
                    // Send position to main process
                    window.electron.send('show-application-menu', { x, y })
                  }
                }}
              >
                <MoreHorizontal className="h-5 w-5"/>
              </Button>
            )}
          </>
        ) : (
          <>
            <Button 
              variant="ghost" 
              className="flex items-center gap-2 rounded-full hover:text-gray-400"
              onClick={() => setSignupModalOpen(true)}
            >
              <User className="h-5 w-5 text-gray-500 dark:text-gray-400" />
              <span className="text-gray-400">Login</span>
            </Button>
            
            {/* Electron Menu Button - Only show on Windows Electron */}
            {isWindows && isElectron && (
              <Button
                variant="ghost"
                size="icon"
                className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                onClick={(e) => {
                  if (typeof window !== 'undefined' && window.electron) {
                    // Get button position
                    const rect = e.currentTarget.getBoundingClientRect()
                    const x = Math.round(rect.left)
                    const y = Math.round(rect.bottom)
                    
                    // Send position to main process
                    window.electron.send('show-application-menu', { x, y })
                  }
                }}
              >
                <MoreHorizontal className="h-5 w-5"/>
              </Button>
            )}
          </>
        )}
      </div>
      <GlobalSignupModal preventInteractOutside={false} />
      
      {/* Move modals to AppHeader level to prevent unmounting */}
      <AccountSettingsModal
        isOpen={isAccountSettingsOpen}
        onClose={() => setIsAccountSettingsOpen(false)}
        onTitleUpdate={(title) => setCustomTitle(title)}
        onPreferencesUpdate={(preferences) => {
          if (preferences.customTitle !== undefined) setCustomTitle(preferences.customTitle)
          if (preferences.preferredName !== undefined) setPreferredName(preferences.preferredName)
          if (preferences.organization !== undefined) setOrganization(preferences.organization)
          if (preferences.avatarPreview !== undefined) setAvatarPreview(preferences.avatarPreview)
        }}
      />
      
      <PreferencesModal
        isOpen={isPreferencesOpen}
        onClose={() => setIsPreferencesOpen(false)}
      />
    </header>
  )
}

export default AppHeader
