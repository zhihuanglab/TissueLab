// store/slices/viewerSettingsSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

const ROI_RECOMMEND_TYPE_KEY = 'tissuelab_roi_recommend_type'

function getInitialRoiRecommendType(): 'nuclei' | 'tissue' {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem(ROI_RECOMMEND_TYPE_KEY)
    if (saved === 'nuclei' || saved === 'tissue') return saved
  }
  return 'nuclei'
}

interface ViewerSettingsState {
  zoomSpeed: number // wheel speed
  centroidSize: number // centroid size
  overlayAlpha: number // overlay alpha (transparency for centroid and patch overlays)
  trackpadGesture: boolean // trackpad gesture enabled
  showNavigator: boolean // navigator visibility
  centroidThreshold: number // centroid threshold (zoom level)
  roiRecommendType: 'nuclei' | 'tissue' // ROIs dropdown: Nuclei vs Tissue switch
  selectedMaskKey: string // which mask to overlay, e.g. "mask_Stroma" or "" for default
  /** When true, user annotations (GT) are always highlighted regardless of selection */
  highlightGtAnnotations: boolean
}

const HIGHLIGHT_GT_KEY = 'tissuelab_highlight_gt_annotations'

function getInitialHighlightGt(): boolean {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem(HIGHLIGHT_GT_KEY)
    if (saved === 'true') return true
    if (saved === 'false') return false
  }
  return false
}

const initialState: ViewerSettingsState = {
  zoomSpeed: 0.5, // Default wheel speed
  centroidSize: 1.5, // Default centroid size
  overlayAlpha: 0.4, // Default overlay alpha (transparency for centroid and patch overlays)
  trackpadGesture: false, // Will be updated on the client after hydration
  showNavigator: false, // Default navigator visibility
  centroidThreshold: 10, // Default centroid threshold (zoom level)
  roiRecommendType: getInitialRoiRecommendType(),
  selectedMaskKey: '',
  highlightGtAnnotations: getInitialHighlightGt(),
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
    setOverlayAlpha(state, action: PayloadAction<number>) {
      state.overlayAlpha = action.payload
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
    setCentroidThreshold(state, action: PayloadAction<number>) {
      state.centroidThreshold = action.payload
    },
    setRoiRecommendType(state, action: PayloadAction<'nuclei' | 'tissue'>) {
      state.roiRecommendType = action.payload
      if (typeof window !== 'undefined') {
        localStorage.setItem(ROI_RECOMMEND_TYPE_KEY, action.payload)
      }
    },
    setSelectedMaskKey(state, action: PayloadAction<string>) {
      state.selectedMaskKey = action.payload ?? ''
    },
    setHighlightGtAnnotations(state, action: PayloadAction<boolean>) {
      state.highlightGtAnnotations = action.payload
      if (typeof window !== 'undefined') {
        localStorage.setItem(HIGHLIGHT_GT_KEY, String(action.payload))
      }
    },
    toggleHighlightGtAnnotations(state) {
      state.highlightGtAnnotations = !state.highlightGtAnnotations
      if (typeof window !== 'undefined') {
        localStorage.setItem(HIGHLIGHT_GT_KEY, String(state.highlightGtAnnotations))
      }
    },
  },
})

export const {
  setZoomSpeed,
  setCentroidSize,
  setOverlayAlpha,
  setTrackpadGesture,
  setShowNavigator,
  toggleShowNavigator,
  setCentroidThreshold,
  setRoiRecommendType,
  setSelectedMaskKey,
  setHighlightGtAnnotations,
  toggleHighlightGtAnnotations,
} = viewerSettingsSlice.actions

export default viewerSettingsSlice.reducer
