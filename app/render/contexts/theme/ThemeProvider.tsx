'use client'

import * as React from "react"
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"

interface ThemeProviderProps {
  children: React.ReactNode
}

// Internal component to sync theme with Electron on mount
function ThemeSync() {
  const { theme, systemTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  const hasSynced = React.useRef(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    // Only sync once after component is mounted and theme is resolved
    if (!mounted || hasSynced.current) return

    // Get the actual theme (resolve system theme if needed)
    const currentTheme = theme === "system" ? systemTheme : theme

    // Notify Electron to update title bar overlay colors on initialization
    if (typeof window !== 'undefined' && window.electron && currentTheme) {
      try {
        window.electron.send('update-titlebar-theme', currentTheme)
        console.log(`[Theme] Synced theme with Electron on initialization: ${currentTheme}`)
        hasSynced.current = true
      } catch (error) {
        console.error('Failed to sync theme with Electron:', error)
      }
    }
  }, [mounted, theme, systemTheme])

  return null
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem>
      <ThemeSync />
      {children}
    </NextThemesProvider>
  )
}
