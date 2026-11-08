'use client'

import * as React from "react"
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"

interface ThemeProviderProps {
  children: React.ReactNode
}

// Internal component that keeps the Electron title bar in step with the
// resolved theme: on start-up, and whenever it changes afterwards (including
// an OS light/dark switch while the theme is "system").
function ThemeSync() {
  const { theme, systemTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  const lastSent = React.useRef<string | null>(null)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    if (!mounted) return

    // Get the actual theme (resolve system theme if needed)
    const currentTheme = theme === "system" ? systemTheme : theme
    if (!currentTheme || currentTheme === lastSent.current) return

    // Notify Electron to update title bar overlay colors
    if (typeof window !== 'undefined' && window.electron) {
      try {
        window.electron.send('update-titlebar-theme', currentTheme)
        console.log(`[Theme] Synced theme with Electron: ${currentTheme}`)
        lastSent.current = currentTheme
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
