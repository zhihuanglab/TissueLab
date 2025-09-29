import { useCallback, useEffect } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { RootState } from '@/store'
import { resetShortcuts, setAllShortcuts, setShortcut, ShortcutActionKey } from '@/store/slices/shortcutsSlice'

const STORAGE_KEY = 'tissuelab_shortcuts'

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
    if (loaded) dispatch(setAllShortcuts(loaded))
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


