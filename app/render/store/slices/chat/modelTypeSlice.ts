import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface ModelTypeState {
  type: string;
}

const initialState: ModelTypeState = {
  type: '',
};

const modelTypeSlice = createSlice({
  name: 'modelType',
  initialState,
  reducers: {
    setModelType: (state, action: PayloadAction<string>) => {
      state.type = action.payload;
    },
  },
});

export const { setModelType } = modelTypeSlice.actions;
export default modelTypeSlice.reducer; 