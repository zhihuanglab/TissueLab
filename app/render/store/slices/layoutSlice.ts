import { createSlice, PayloadAction } from '@reduxjs/toolkit'

interface LayoutState {
  sidebarShow: boolean
  unfoldable: boolean
  imageLoaded: boolean
  isMobile: boolean
  // True from the moment a slide-open is triggered (dashboard click / file browser)
  // until the viewer renders it — drives the full-screen "Opening…" cover. Lives in
  // Redux so it survives the dashboard → /imageViewer route change.
  wsiOpening: boolean
}

const initialState: LayoutState = {
  sidebarShow: true,
  unfoldable: false,
  imageLoaded: false,
  isMobile: false,
  wsiOpening: false,
}

const layoutSlice = createSlice({
  name: 'layout',
  initialState,
  reducers: {
    setSidebarShow(state, action: PayloadAction<boolean>) {
      state.sidebarShow = action.payload
    },
    toggleSidebarShow(state) {
      state.sidebarShow = !state.sidebarShow
    },
    setSidebarUnfoldable(state, action: PayloadAction<boolean>) {
      state.unfoldable = action.payload
    },
    toggleSidebarUnfoldable(state) {
      state.unfoldable = !state.unfoldable
    },
    setImageLoaded(state, action: PayloadAction<boolean>) {
      state.imageLoaded = action.payload
    },
    setIsMobile(state, action: PayloadAction<boolean>) {
      state.isMobile = action.payload
    },
    setWsiOpening(state, action: PayloadAction<boolean>) {
      state.wsiOpening = action.payload
    },
  },
})

export const {
  setSidebarShow,
  toggleSidebarShow,
  setSidebarUnfoldable,
  toggleSidebarUnfoldable,
  setImageLoaded,
  setIsMobile,
  setWsiOpening,
} = layoutSlice.actions

export default layoutSlice.reducer

export type { LayoutState }

