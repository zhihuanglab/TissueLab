import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type PanelType = 'quantification' | 'tissue_segmentation' | null;

interface PanelState {
  activePanelType: PanelType;
  isOpen: boolean;
}

const initialState: PanelState = {
  activePanelType: null,
  isOpen: false,
};

const panelSlice = createSlice({
  name: 'panel',
  initialState,
  reducers: {
    openPanel: (state, action: PayloadAction<PanelType>) => {
      state.activePanelType = action.payload;
      state.isOpen = true;
    },
    closePanel: (state) => {
      state.activePanelType = null;
      state.isOpen = false;
    },
  },
});

export const { openPanel, closePanel } = panelSlice.actions;
export default panelSlice.reducer; 