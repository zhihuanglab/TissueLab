import { createSlice, PayloadAction } from '@reduxjs/toolkit';

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
  rotation?: number; // Optional: rotation angle in degrees (0, 30, 60, 90, ..., 360)
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