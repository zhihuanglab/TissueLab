import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export type ShortcutActionKey =
  | 'toggleNuclei'
  | 'togglePatches'
  | 'toggleMask'
  | 'tool.move'
  | 'tool.lasso'
  | 'tool.polygon'
  | 'tool.rectangle'
  | 'tool.line'
  | 'tool.filter'

export interface ShortcutsState {
  bindings: Record<ShortcutActionKey, string>
}

export const DEFAULT_SHORTCUTS: Record<ShortcutActionKey, string> = {
  toggleNuclei: 'Space',
  togglePatches: 'x',
  toggleMask: 'm',
  'tool.move': 'Escape',
  'tool.lasso': '1',
  'tool.rectangle': '2',
  'tool.polygon': '3',
  'tool.line': '4',
  'tool.filter': '5',
}

/**
 * The binding name of a key press: 'Space', a lowercased printable character,
 * or `event.code` for anything else.
 */
export function shortcutKeyFromEvent(event: KeyboardEvent): string {
  if (event.key === ' ') return 'Space'
  return event.key && event.key.length === 1 ? event.key.toLowerCase() : event.code
}

/** The other action already bound to `key`, if any. */
export function findShortcutConflict(
  bindings: Record<ShortcutActionKey, string>,
  key: string,
  self: ShortcutActionKey,
): ShortcutActionKey | undefined {
  return (Object.keys(bindings) as ShortcutActionKey[]).find((k) => k !== self && bindings[k] === key)
}

const initialState: ShortcutsState = {
  bindings: { ...DEFAULT_SHORTCUTS },
}

const shortcutsSlice = createSlice({
  name: 'shortcuts',
  initialState,
  reducers: {
    setShortcut(state, action: PayloadAction<{ action: ShortcutActionKey; key: string }>) {
      const { action: actionKey, key } = action.payload
      state.bindings[actionKey] = key
    },
    resetShortcuts(state) {
      state.bindings = { ...DEFAULT_SHORTCUTS }
    },
    setAllShortcuts(state, action: PayloadAction<Record<ShortcutActionKey, string>>) {
      state.bindings = { ...action.payload }
    },
  },
})

export const { setShortcut, resetShortcuts, setAllShortcuts } = shortcutsSlice.actions
export default shortcutsSlice.reducer


