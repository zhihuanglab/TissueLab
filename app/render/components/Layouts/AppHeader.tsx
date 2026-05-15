'use client';

import GlobalSignupModal from "@/components/auth/GlobalSignupModal/GlobalSignupModal";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/ui/mode-toggle";
import { RootState } from '@/store';
import {
  setSidebarShow,
  toggleSidebarUnfoldable,
} from "@/store/slices/layoutSlice";
import { AnnouncementDialog } from "./AnnouncementDialog";

import { cn } from "@/utils/twMerge";
import {
  Megaphone,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

const AppHeader: React.FC = () => {
  const headerRef = useRef<HTMLDivElement>(null)
  const dispatch = useDispatch()
  const sidebarShow = useSelector((state: RootState) => state.layout.sidebarShow)
  const [isWindows, setIsWindows] = useState(false)
  const [isElectron, setIsElectron] = useState(false)
  const [titlebarHeight, setTitlebarHeight] = useState<number>(40)
  const [rightInset, setRightInset] = useState<number>(0)
  const unfoldable = useSelector((state: RootState) => state.layout.unfoldable);
  const isMobile = useSelector((state: RootState) => state.layout.isMobile);
  const [announcementOpen, setAnnouncementOpen] = useState(false);

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
      setTitlebarHeight(40) // Fixed height for web
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
      } catch { }
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

  return (
    <header
      className="electron-drag relative flex flex-shrink-0 items-center bg-background pl-2.5 px-6 transition-colors duration-300"
      style={{ height: titlebarHeight }}>
      <div className="electron-no-drag flex items-center space-x-2">
        {!sidebarShow ? (
          <Button
            variant="ghost"
            size="icon"
            className="ml-0 h-10 w-10 text-muted-foreground hover:text-foreground"
            onClick={() => dispatch(setSidebarShow(true))}
          >
            <PanelLeftOpen className="h-5 w-5" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "electron-no-drag text-muted-foreground hover:text-foreground",
              "ml-0 h-9 w-9"
            )}
            onClick={() =>
              isMobile
                ? dispatch(setSidebarShow(false))
                : dispatch(toggleSidebarUnfoldable())
            }
          >
            {isMobile
              ? <PanelLeftClose className="h-4 w-4" />
              : unfoldable ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />
            }
          </Button>
        )}
        <ModeToggle />
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setAnnouncementOpen(true)}
          aria-label="Announcements"
        >
          <Megaphone className="h-5 w-5" />
        </Button>
      </div>

      {/* Middle area - prevents overlap with right side */}
      <div className="flex-1 pr-40" />

      {/* Right side - Menu button - Absolutely positioned to stay fixed next to window controls */}
      {isWindows && isElectron && (
        <div
          className="electron-no-drag absolute top-0 flex h-full items-center space-x-4 px-6"
          style={{
            right: rightInset,
            minWidth: 'fit-content'
          }}>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground"
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
            aria-label="Application menu"
          >
            <MoreHorizontal className="h-5 w-5"/>
          </Button>
        </div>
      )}

      <GlobalSignupModal preventInteractOutside={false} />
      <AnnouncementDialog open={announcementOpen} onOpenChange={setAnnouncementOpen} />
    </header>
  )
}

export default AppHeader
