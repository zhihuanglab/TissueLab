import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface WindowState {
  id: number;
  selectedFolder: string;
  fileList: any[];
  currentImagePath: string | null;
  viewportCoordinates: {
    x: number;
    y: number;
    zoom: number;
  };
  isLoading: boolean;
  error: string | null;
}

interface MultiWindowState {
  windows: { [key: number]: WindowState };
  activeWindow: number;
  syncCoordinates: boolean;
  totalWindows: number;
}

const createDefaultWindow = (id: number): WindowState => ({
  id,
  selectedFolder: '',
  fileList: [],
  currentImagePath: null,
  viewportCoordinates: { x: 0, y: 0, zoom: 1 },
  isLoading: false,
  error: null,
});

const initialState: MultiWindowState = {
  windows: {
    1: createDefaultWindow(1),
    2: createDefaultWindow(2),
  },
  activeWindow: 1,
  syncCoordinates: true,
  totalWindows: 2,
};

const multiWindowSlice = createSlice({
  name: 'multiWindow',
  initialState,
  reducers: {
    setActiveWindow: (state, action: PayloadAction<number>) => {
      state.activeWindow = action.payload;
    },
    
    setSyncCoordinates: (state, action: PayloadAction<boolean>) => {
      state.syncCoordinates = action.payload;
    },
    
    addWindow: (state) => {
      const newWindowId = state.totalWindows + 1;
      state.windows[newWindowId] = createDefaultWindow(newWindowId);
      state.totalWindows = newWindowId;
      state.activeWindow = newWindowId;
    },
    
    removeWindow: (state, action: PayloadAction<number>) => {
      const windowId = action.payload;
      if (state.totalWindows > 1 && state.windows[windowId]) {
        delete state.windows[windowId];
        // If we're removing the active window, switch to the first available window
        if (state.activeWindow === windowId) {
          state.activeWindow = parseInt(Object.keys(state.windows)[0]);
        }
      }
    },
    
    updateWindowFolder: (state, action: PayloadAction<{ windowId: number; folder: string }>) => {
      const { windowId, folder } = action.payload;
      if (state.windows[windowId]) {
        state.windows[windowId].selectedFolder = folder;
      }
    },
    
    updateWindowFileList: (state, action: PayloadAction<{ windowId: number; fileList: any[] }>) => {
      const { windowId, fileList } = action.payload;
      if (state.windows[windowId]) {
        state.windows[windowId].fileList = fileList;
      }
    },
    
    updateWindowImage: (state, action: PayloadAction<{ windowId: number; imagePath: string }>) => {
      const { windowId, imagePath } = action.payload;
      if (state.windows[windowId]) {
        state.windows[windowId].currentImagePath = imagePath;
      }
    },
    
    updateWindowViewport: (state, action: PayloadAction<{ 
      windowId: number; 
      coordinates: { x: number; y: number; zoom: number } 
    }>) => {
      const { windowId, coordinates } = action.payload;
      if (state.windows[windowId]) {
        state.windows[windowId].viewportCoordinates = coordinates;
        
        // If sync is enabled, update all other windows
        if (state.syncCoordinates) {
          Object.keys(state.windows).forEach(id => {
            const numId = parseInt(id);
            if (numId !== windowId) {
              state.windows[numId].viewportCoordinates = coordinates;
            }
          });
        }
      }
    },
    
    setWindowLoading: (state, action: PayloadAction<{ windowId: number; isLoading: boolean }>) => {
      const { windowId, isLoading } = action.payload;
      if (state.windows[windowId]) {
        state.windows[windowId].isLoading = isLoading;
      }
    },
    
    setWindowError: (state, action: PayloadAction<{ windowId: number; error: string | null }>) => {
      const { windowId, error } = action.payload;
      if (state.windows[windowId]) {
        state.windows[windowId].error = error;
      }
    },
    
    resetWindow: (state, action: PayloadAction<number>) => {
      const windowId = action.payload;
      if (state.windows[windowId]) {
        state.windows[windowId] = createDefaultWindow(windowId);
      }
    },
  },
});

export const {
  setActiveWindow,
  setSyncCoordinates,
  addWindow,
  removeWindow,
  updateWindowFolder,
  updateWindowFileList,
  updateWindowImage,
  updateWindowViewport,
  setWindowLoading,
  setWindowError,
  resetWindow,
} = multiWindowSlice.actions;

export default multiWindowSlice.reducer;