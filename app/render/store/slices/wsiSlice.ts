import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface WSIInstance {
  instanceId: string;
  wsiInfo: any;
  fileInfo: any;
  isActive: boolean;
  viewportState?: {
    x: number;
    y: number;
    zoom: number;
  };
}

interface WSIState {
  instances: { [instanceId: string]: WSIInstance };
  activeInstanceId: string | null;
  // Remove global state, completely depend on instance management
  syncCoordinates: boolean; // Add viewport synchronization control
}

const initialState: WSIState = {
  instances: {},
  activeInstanceId: null,
  syncCoordinates: true, // Default enable viewport synchronization
};

const wsiSlice = createSlice({
  name: 'wsi',
  initialState,
  reducers: {
    // Add WSI instance
    addWSIInstance: (state, action: PayloadAction<{ instanceId: string; wsiInfo: any; fileInfo: any }>) => {
      const { instanceId, wsiInfo, fileInfo } = action.payload;
      
      // Set previous instance to inactive
      Object.values(state.instances).forEach(instance => {
        instance.isActive = false;
      });
      
      // Add new instance
      state.instances[instanceId] = {
        instanceId,
        wsiInfo,
        fileInfo,
        isActive: true,
        viewportState: { x: 0, y: 0, zoom: 1 }
      };
      state.activeInstanceId = instanceId;
    },
    
    // Set active instance
    setActiveInstance: (state, action: PayloadAction<string>) => {
      const instanceId = action.payload;
      if (state.instances[instanceId]) {
        // Set all instances to inactive
        Object.values(state.instances).forEach(instance => {
          instance.isActive = false;
        });
        // Set active instance
        state.instances[instanceId].isActive = true;
        state.activeInstanceId = instanceId;
      }
    },
    
    // Remove WSI instance
    removeWSIInstance: (state, action: PayloadAction<string>) => {
      const instanceId = action.payload;
      if (state.instances[instanceId]) {
        delete state.instances[instanceId];
        
        // If the deleted instance is the active instance, select another instance as active instance
        if (state.activeInstanceId === instanceId) {
          const remainingInstanceIds = Object.keys(state.instances);
          if (remainingInstanceIds.length > 0) {
            state.activeInstanceId = remainingInstanceIds[0];
            state.instances[remainingInstanceIds[0]].isActive = true;
          } else {
            state.activeInstanceId = null;
          }
        }
      }
    },
    
    // Update instance viewport state
    updateInstanceViewport: (state, action: PayloadAction<{ 
      instanceId: string; 
      viewportState: { x: number; y: number; zoom: number } 
    }>) => {
      const { instanceId, viewportState } = action.payload;
      if (state.instances[instanceId]) {
        state.instances[instanceId].viewportState = viewportState;
      }
    },
    
    // Sync all instance viewport states
    syncAllViewports: (state, action: PayloadAction<{ x: number; y: number; zoom: number }>) => {
      const viewportState = action.payload;
      Object.values(state.instances).forEach(instance => {
        instance.viewportState = viewportState;
      });
    },
    
    // Set viewport synchronization
    setSyncCoordinates: (state, action: PayloadAction<boolean>) => {
      state.syncCoordinates = action.payload;
    },
    
    // Update specific instance WSI info
    updateInstanceWSIInfo: (state, action: PayloadAction<{ 
      instanceId: string; 
      wsiInfo: any; 
      fileInfo?: any 
    }>) => {
      const { instanceId, wsiInfo, fileInfo } = action.payload;
      if (state.instances[instanceId]) {
        state.instances[instanceId].wsiInfo = wsiInfo;
        if (fileInfo) {
          state.instances[instanceId].fileInfo = fileInfo;
        }
      }
    },
    
    // Replace current active instance with new WSI data
    replaceCurrentInstance: (state, action: PayloadAction<{ instanceId: string; wsiInfo: any; fileInfo: any }>) => {
      const { instanceId, wsiInfo, fileInfo } = action.payload;
      
      // If there's an active instance, remove it first
      if (state.activeInstanceId && state.instances[state.activeInstanceId]) {
        delete state.instances[state.activeInstanceId];
      }
      
      // Add new instance as the active one
      state.instances[instanceId] = {
        instanceId,
        wsiInfo,
        fileInfo,
        isActive: true,
        viewportState: { x: 0, y: 0, zoom: 1 }
      };
      state.activeInstanceId = instanceId;
    },
  },
});

export const { 
  addWSIInstance, 
  setActiveInstance, 
  removeWSIInstance, 
  updateInstanceViewport, 
  syncAllViewports,
  setSyncCoordinates,
  updateInstanceWSIInfo,
  replaceCurrentInstance
} = wsiSlice.actions;

export default wsiSlice.reducer; 