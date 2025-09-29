import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type DrawingTool = 'rectangle' | 'polygon' | 'move' | 'line';

interface ToolState {
  currentTool: DrawingTool;
}

const initialState: ToolState = {
  currentTool: 'move',
};

const toolSlice = createSlice({
  name: 'tool',
  initialState,
  reducers: {
    setTool(state, action: PayloadAction<DrawingTool>) {
      state.currentTool = action.payload;
    },
  },
});

export const { setTool } = toolSlice.actions;

export default toolSlice.reducer; 