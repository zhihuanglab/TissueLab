import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  enabled: false,
  parameters: {
    confidence: 0.5,
    threshold: 0.7,
    maxDetections: 100,
    useEnhancement: false
  }
};

const coPilotSlice = createSlice({
  name: 'coPilot',
  initialState,
  reducers: {
    setCoPilotEnabled: (state, action) => {
      state.enabled = action.payload;
    },
  },
});

export const { setCoPilotEnabled } = coPilotSlice.actions;
export default coPilotSlice.reducer; 