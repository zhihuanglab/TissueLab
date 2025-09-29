// store/slices/userSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

interface UserState {
  user: any | null
  avatarUrl: string | null
  preferredName: string | null
  customTitle: string | null
  organization: string | null
  showLoginPanel: boolean
  showRegisterPanel: boolean
}

const initialState: UserState = {
  user: null,
  avatarUrl: null,
  preferredName: null,
  customTitle: null,
  organization: null,
  showLoginPanel: false,
  showRegisterPanel: false,
}

const userSlice = createSlice({
  name: 'user',
  initialState,
  reducers: {
    setUser: (state, action: PayloadAction<any>) => {
      state.user = action.payload
    },
    setUserAvatarUrl: (state, action: PayloadAction<string | null>) => {
      state.avatarUrl = action.payload || null
    },
    setPreferredName: (state, action: PayloadAction<string | null>) => {
      state.preferredName = action.payload || null
    },
    setCustomTitle: (state, action: PayloadAction<string | null>) => {
      state.customTitle = action.payload || null
    },
    setOrganization: (state, action: PayloadAction<string | null>) => {
      state.organization = action.payload || null
    },
    logoutUser: (state) => {
      state.user = null
      state.avatarUrl = null
      state.preferredName = null
      state.customTitle = null
      state.organization = null
    },
    showLoginPanel: (state) => {
      state.showLoginPanel = true
      state.showRegisterPanel = false
    },
    hideLoginPanel: (state) => {
      state.showLoginPanel = false
    },
    showRegisterPanel: (state) => {
      state.showRegisterPanel = true
      state.showLoginPanel = false
    },
    hideRegisterPanel: (state) => {
      state.showRegisterPanel = false
    },
  },
})

export const { 
  setUser, 
  setUserAvatarUrl, 
  setPreferredName, 
  setCustomTitle, 
  setOrganization, 
  logoutUser, 
  showLoginPanel, 
  hideLoginPanel, 
  showRegisterPanel, 
  hideRegisterPanel 
} = userSlice.actions

export default userSlice.reducer
