import { createSlice, PayloadAction } from '@reduxjs/toolkit'

interface LayoutState {
  sidebarShow: boolean
  unfoldable: boolean
  imageLoaded: boolean
  isMobile: boolean
}

const initialState: LayoutState = {
  sidebarShow: true,
  unfoldable: false,
  imageLoaded: false,
  isMobile: false,
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
  },
})

export const {
  setSidebarShow,
  toggleSidebarShow,
  setSidebarUnfoldable,
  toggleSidebarUnfoldable,
  setImageLoaded,
  setIsMobile,
} = layoutSlice.actions

export default layoutSlice.reducer

export type { LayoutState }

