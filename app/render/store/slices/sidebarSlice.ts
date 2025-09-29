// store/slices/sidebarSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

interface SidebarState {
  sidebarShow: boolean
  unfoldable: boolean
  imageLoaded: boolean
}

const initialState: SidebarState = {
  sidebarShow: true,
  unfoldable: false,
  imageLoaded: false,
}

const sidebarSlice = createSlice({
  name: 'sidebar',
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
  },
})

export const {
  setSidebarShow,
  toggleSidebarShow,
  setSidebarUnfoldable,
  toggleSidebarUnfoldable,
  setImageLoaded
} = sidebarSlice.actions

export default sidebarSlice.reducer
