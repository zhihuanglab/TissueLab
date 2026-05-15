// store/slices/imageSettingsSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

interface ImageSettingsState {
  brightness: number
  contrast: number
  saturation: number
  sharpness: number
  gamma: number
}

const initialState: ImageSettingsState = {
  brightness: 50,
  contrast: 50,
  saturation: 50,
  sharpness: 50,
  gamma: 1,
}

const imageSettingsSlice = createSlice({
  name: 'imageSettings',
  initialState,
  reducers: {
    setBrightness(state, action: PayloadAction<number>) {
      state.brightness = Math.max(0, Math.min(100, action.payload))
    },
    setContrast(state, action: PayloadAction<number>) {
      state.contrast = Math.max(0, Math.min(100, action.payload))
    },
    setSaturation(state, action: PayloadAction<number>) {
      state.saturation = Math.max(0, Math.min(100, action.payload))
    },
    setSharpness(state, action: PayloadAction<number>) {
      state.sharpness = Math.max(0, Math.min(100, action.payload))
    },
    setGamma(state, action: PayloadAction<number>) {
      state.gamma = Math.max(0.1, Math.min(3, action.payload))
    },
    setImageSetting(state, action: PayloadAction<{ setting: keyof ImageSettingsState; value: number }>) {
      const { setting, value } = action.payload
      if (setting === 'gamma') {
        state[setting] = Math.max(0.1, Math.min(3, value))
      } else {
        state[setting] = Math.max(0, Math.min(100, value))
      }
    },
    resetImageSettings(state) {
      return initialState
    },
  },
})

export const {
  setBrightness,
  setContrast,
  setSaturation,
  setSharpness,
  setGamma,
  setImageSetting,
  resetImageSettings,
} = imageSettingsSlice.actions

export default imageSettingsSlice.reducer
