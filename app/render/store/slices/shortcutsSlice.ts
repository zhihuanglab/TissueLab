import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export type ShortcutActionKey =
  | 'toggleNuclei'
  | 'togglePatches'
  | 'tool.move'
  | 'tool.polygon'
  | 'tool.rectangle'
  | 'tool.line'

export interface ShortcutsState {
  bindings: Record<ShortcutActionKey, string>
}

export const DEFAULT_SHORTCUTS: Record<ShortcutActionKey, string> = {
  toggleNuclei: 'Space',
  togglePatches: 'x',
  'tool.move': '1',
  'tool.polygon': '2',
  'tool.rectangle': '3',
  'tool.line': '4',
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


