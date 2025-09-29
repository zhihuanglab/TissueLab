import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import OpenSeadragon from 'openseadragon';

interface ViewerCoordinates {
  image: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
  screen: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  dpr: number;
}

interface ViewerState {
  currentViewerCoordinates: ViewerCoordinates | null;
}

const initialState: ViewerState = {
  currentViewerCoordinates: null,
};

const viewerSlice = createSlice({
  name: 'viewer',
  initialState,
  reducers: {
    setCurrentViewerCoordinates: (state, action: PayloadAction<ViewerCoordinates | null>) => {
      state.currentViewerCoordinates = action.payload as any;
    }
  }
});

export const { setCurrentViewerCoordinates } = viewerSlice.actions;
export default viewerSlice.reducer; 