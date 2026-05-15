import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface GtHighlightState {
  /** Nuclei (centroid) indices that are user-annotated (GT), always highlighted when preference is on */
  nucleiIndices: number[];
  /** Tissue (patch) indices that are user-annotated (GT), always highlighted when preference is on */
  tissueIndices: number[];
}

const initialState: GtHighlightState = {
  nucleiIndices: [],
  tissueIndices: [],
};

export const gtHighlightSlice = createSlice({
  name: 'gtHighlight',
  initialState,
  reducers: {
    setGtHighlightIndices(
      state,
      action: PayloadAction<{ nucleiIndices: number[]; tissueIndices: number[] }>
    ) {
      state.nucleiIndices = action.payload.nucleiIndices ?? [];
      state.tissueIndices = action.payload.tissueIndices ?? [];
    },
    clearGtHighlightIndices(state) {
      state.nucleiIndices = [];
      state.tissueIndices = [];
    },
  },
});

export const { setGtHighlightIndices, clearGtHighlightIndices } = gtHighlightSlice.actions;
export default gtHighlightSlice.reducer;
