'use client'

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import { cn } from "@/utils/twMerge"

const DEFAULT_THEME = "dark"

export function ModeToggle() {
  const { setTheme, resolvedTheme } = useTheme()
  const [pendingTheme, setPendingTheme] = React.useState<"light" | "dark" | null>(null)

  React.useEffect(() => {
    if (pendingTheme && resolvedTheme === pendingTheme) {
      setPendingTheme(null)
    }
  }, [resolvedTheme, pendingTheme])

  const isDark =
    pendingTheme !== null
      ? pendingTheme === "dark"
      : resolvedTheme === "dark"

  const handleToggle = React.useCallback(() => {
    const nextTheme = isDark ? "light" : "dark"
    setPendingTheme(nextTheme)
    setTheme(nextTheme || DEFAULT_THEME)

    if (typeof window !== "undefined" && window.electron) {
      try {
        window.electron.send("update-titlebar-theme", nextTheme || DEFAULT_THEME)
      } catch (error) {
        console.error("Failed to update title bar theme:", error)
      }
    }
  }, [isDark, setTheme])

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        "relative transition-colors duration-200 ease-out",
        "text-muted-foreground hover:bg-accent hover:text-foreground",
        pendingTheme && "bg-accent text-foreground"
      )}
      aria-label="switch theme"
      onClick={handleToggle}
    >
      <span
        className="relative block h-5 w-5 shrink-0"
        suppressHydrationWarning
      >
        <Sun
          className={cn(
            "absolute inset-0 m-auto h-5 w-5 transition-opacity duration-200 ease-out",
            isDark ? "opacity-0" : "opacity-100"
          )}
          aria-hidden
        />
        <Moon
          className={cn(
            "absolute inset-0 m-auto h-5 w-5 transition-opacity duration-200 ease-out",
            isDark ? "opacity-100" : "opacity-0"
          )}
          aria-hidden
        />
      </span>
      <span className="sr-only">switch theme</span>
    </Button>
  )
}
