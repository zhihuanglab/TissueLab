/**
 * Central sync for Electron title bar when Radix/modal overlays are open.
 * Uses ref-counting so nested dialogs and route changes behave predictably.
 */

let overlayDepth = 0

let lastSent: { isModalOpen: boolean; currentTheme: string } | null = null

function send(isModalOpen: boolean, currentTheme: string) {
  if (
    lastSent &&
    lastSent.isModalOpen === isModalOpen &&
    lastSent.currentTheme === currentTheme
  ) {
    return
  }
  lastSent = { isModalOpen, currentTheme }

  if (typeof window === "undefined") {
    return
  }
  const electron = (window as unknown as { electron?: { send?: (ch: string, p: unknown) => void } })
    .electron
  if (!electron?.send) {
    return
  }
  try {
    electron.send("update-titlebar-overlay", {
      isModalOpen,
      currentTheme,
    })
  } catch (error) {
    console.error("Failed to sync Electron titlebar overlay:", error)
  }
}

/**
 * Call when a dialog using the dark overlay is open; cleanup runs on close or unmount.
 * Pass a getter so the last-close path uses the current resolved theme (not a stale closure).
 */
export function subscribeElectronModalOverlay(
  getTheme: () => string | undefined
): () => void {
  const t = getTheme()
  if (!t) {
    return () => {}
  }
  overlayDepth++
  if (overlayDepth === 1) {
    send(true, t)
  }

  return () => {
    if (overlayDepth === 0) {
      return
    }
    overlayDepth--
    if (overlayDepth === 0) {
      send(false, getTheme() || "dark")
    }
  }
}

/**
 * Theme changed while at least one overlay dialog is open — refresh titlebar tint.
 * `theme` should be the resolved theme string (not "system").
 */
export function syncElectronModalOverlayTheme(theme: string): void {
  if (overlayDepth > 0) {
    send(true, theme)
  }
}
