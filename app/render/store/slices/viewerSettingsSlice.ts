// store/slices/viewerSettingsSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

interface ViewerSettingsState {
  zoomSpeed: number // wheel speed
  centroidSize: number // centroid size
  trackpadGesture: boolean // trackpad gesture enabled
  showNavigator: boolean // navigator visibility
}

const initialState: ViewerSettingsState = {
  zoomSpeed: 2.0, // Default wheel speed (increased for better Mac experience)
  centroidSize: 1.5, // Default centroid size
  trackpadGesture: false, // Will be updated on the client after hydration
  showNavigator: false, // Default navigator visibility
}

const viewerSettingsSlice = createSlice({
  name: 'viewerSettings',
  initialState,
  reducers: {
    setZoomSpeed(state, action: PayloadAction<number>) {
      state.zoomSpeed = action.payload
    },
    setCentroidSize(state, action: PayloadAction<number>) {
      state.centroidSize = action.payload
    },
    setTrackpadGesture(state, action: PayloadAction<boolean>) {
      state.trackpadGesture = action.payload
    },
    setShowNavigator(state, action: PayloadAction<boolean>) {
      state.showNavigator = action.payload
    },
    toggleShowNavigator(state) {
      state.showNavigator = !state.showNavigator
    },
  },
})

export const {
  setZoomSpeed,
  setCentroidSize,
  setTrackpadGesture,
  setShowNavigator,
  toggleShowNavigator
} = viewerSettingsSlice.actions

export default viewerSettingsSlice.reducer
