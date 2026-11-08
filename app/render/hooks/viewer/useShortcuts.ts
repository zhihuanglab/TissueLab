import { useCallback, useEffect } from 'react'
import { useDispatch, useSelector, useStore } from 'react-redux'
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
  const store = useStore<RootState>()
  const bindings = useSelector((state: RootState) => state.shortcuts.bindings)

  useEffect(() => {
    const loaded = loadFromLocalStorage()
    // Merge over defaults so any keys missing from a saved set (e.g. a newly
    // added tool) always resolve to a valid binding.
    if (loaded) dispatch(setAllShortcuts({ ...DEFAULT_SHORTCUTS, ...loaded }))
  }, [dispatch])

  // Persist only on an explicit change. Saving whatever Redux held on mount
  // wrote the defaults over the user's bindings before they were loaded,
  // whenever two components using this hook mounted together.
  const updateShortcut = useCallback((action: ShortcutActionKey, key: string) => {
    dispatch(setShortcut({ action: action, key }))
    saveToLocalStorage(store.getState().shortcuts.bindings)
  }, [dispatch, store])

  const reset = useCallback(() => {
    dispatch(resetShortcuts())
    saveToLocalStorage(store.getState().shortcuts.bindings)
  }, [dispatch, store])

  const isConflict = (key: string, self?: ShortcutActionKey) => {
    return Object.entries(bindings).some(([k, v]) => v === key && (k as ShortcutActionKey) !== self)
  }

  return { bindings, updateShortcut, reset, isConflict }
}


