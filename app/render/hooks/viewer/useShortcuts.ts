import { useCallback, useEffect } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { RootState } from '@/store'
import { DEFAULT_SHORTCUTS, resetShortcuts, setAllShortcuts, setShortcut, ShortcutActionKey } from '@/store/slices/viewer/shortcutsSlice'

// Bumped to v2 when the default tool shortcuts changed (move→Esc, lasso=1, …).
// A new key means previously-saved bindings are ignored, so everyone picks up
// the new defaults; customizations then save under the new key.
const STORAGE_KEY = 'tissuelab_shortcuts_v2'

const loadFromLocalStorage = (): Record<ShortcutActionKey, string> | null => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return null
}

const saveToLocalStorage = (bindings: Record<ShortcutActionKey, string>) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings))
  } catch {}
}

export const useShortcuts = () => {
  const dispatch = useDispatch()
  const bindings = useSelector((state: RootState) => state.shortcuts.bindings)

  useEffect(() => {
    const loaded = loadFromLocalStorage()
    // Merge over defaults so any keys missing from a saved set (e.g. a newly
    // added tool) always resolve to a valid binding.
    if (loaded) dispatch(setAllShortcuts({ ...DEFAULT_SHORTCUTS, ...loaded }))
  }, [dispatch])

  useEffect(() => {
    saveToLocalStorage(bindings)
  }, [bindings])

  const updateShortcut = useCallback((action: ShortcutActionKey, key: string) => {
    dispatch(setShortcut({ action: action, key }))
  }, [dispatch])

  const reset = useCallback(() => {
    dispatch(resetShortcuts())
  }, [dispatch])

  const isConflict = (key: string, self?: ShortcutActionKey) => {
    return Object.entries(bindings).some(([k, v]) => v === key && (k as ShortcutActionKey) !== self)
  }

  return { bindings, updateShortcut, reset, isConflict }
}


