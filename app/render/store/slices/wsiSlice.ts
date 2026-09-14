import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface WSIInstance {
  instanceId: string;
  /** Canonical slide path for this viewer session (handler / set_path source of truth). */
  filePath: string | null;
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
  syncCoordinates: boolean;
}

const initialState: WSIState = {
  instances: {},
  activeInstanceId: null,
  syncCoordinates: true,
};

export function resolveInstanceFilePath(fileInfo: any): string | null {
  if (!fileInfo || typeof fileInfo !== 'object') return null;
  const raw = fileInfo.filePath ?? fileInfo.path ?? null;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function buildInstance(
  instanceId: string,
  wsiInfo: any,
  fileInfo: any,
  isActive: boolean,
): WSIInstance {
  return {
    instanceId,
    filePath: resolveInstanceFilePath(fileInfo),
    wsiInfo,
    fileInfo,
    isActive,
    viewportState: { x: 0, y: 0, zoom: 1 },
  };
}

const wsiSlice = createSlice({
  name: 'wsi',
  initialState,
  reducers: {
    addWSIInstance: (state, action: PayloadAction<{ instanceId: string; wsiInfo: any; fileInfo: any }>) => {
      const { instanceId, wsiInfo, fileInfo } = action.payload;

      Object.values(state.instances).forEach((instance) => {
        instance.isActive = false;
      });

      state.instances[instanceId] = buildInstance(instanceId, wsiInfo, fileInfo, true);
      state.activeInstanceId = instanceId;
    },

    setActiveInstance: (state, action: PayloadAction<string>) => {
      const instanceId = action.payload;
      if (state.instances[instanceId]) {
        Object.values(state.instances).forEach((instance) => {
          instance.isActive = false;
        });
        state.instances[instanceId].isActive = true;
        state.activeInstanceId = instanceId;
      }
    },

    removeWSIInstance: (state, action: PayloadAction<string>) => {
      const instanceId = action.payload;
      if (state.instances[instanceId]) {
        delete state.instances[instanceId];

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

    updateInstanceViewport: (
      state,
      action: PayloadAction<{
        instanceId: string;
        viewportState: { x: number; y: number; zoom: number };
      }>,
    ) => {
      const { instanceId, viewportState } = action.payload;
      if (state.instances[instanceId]) {
        state.instances[instanceId].viewportState = viewportState;
      }
    },

    syncAllViewports: (state, action: PayloadAction<{ x: number; y: number; zoom: number }>) => {
      const viewportState = action.payload;
      Object.values(state.instances).forEach((instance) => {
        instance.viewportState = viewportState;
      });
    },

    setSyncCoordinates: (state, action: PayloadAction<boolean>) => {
      state.syncCoordinates = action.payload;
    },

    updateInstanceWSIInfo: (
      state,
      action: PayloadAction<{
        instanceId: string;
        wsiInfo: any;
        fileInfo?: any;
      }>,
    ) => {
      const { instanceId, wsiInfo, fileInfo } = action.payload;
      if (state.instances[instanceId]) {
        state.instances[instanceId].wsiInfo = wsiInfo;
        if (fileInfo) {
          state.instances[instanceId].fileInfo = fileInfo;
          const nextPath = resolveInstanceFilePath(fileInfo);
          if (nextPath) {
            state.instances[instanceId].filePath = nextPath;
          }
        }
      }
    },

    /** Update the canonical slide path for one viewer session (drives set_path / handlers). */
    updateInstanceFilePath: (
      state,
      action: PayloadAction<{ instanceId: string; filePath: string | null }>,
    ) => {
      const { instanceId, filePath } = action.payload;
      if (state.instances[instanceId]) {
        state.instances[instanceId].filePath = filePath;
        if (state.instances[instanceId].fileInfo) {
          state.instances[instanceId].fileInfo = {
            ...state.instances[instanceId].fileInfo,
            filePath,
          };
        }
      }
    },

    /** Shallow-merge fields into an instance's fileInfo (e.g. shareMode refresh). */
    patchInstanceFileInfo: (
      state,
      action: PayloadAction<{ instanceId: string; patch: Record<string, unknown> }>,
    ) => {
      const { instanceId, patch } = action.payload;
      const inst = state.instances[instanceId];
      if (!inst) return;
      inst.fileInfo = { ...(inst.fileInfo || {}), ...patch };
      const nextPath = resolveInstanceFilePath(inst.fileInfo);
      if (nextPath) inst.filePath = nextPath;
    },

    replaceCurrentInstance: (
      state,
      action: PayloadAction<{ instanceId: string; wsiInfo: any; fileInfo: any }>,
    ) => {
      const { instanceId, wsiInfo, fileInfo } = action.payload;

      if (state.activeInstanceId && state.instances[state.activeInstanceId]) {
        delete state.instances[state.activeInstanceId];
      }

      state.instances[instanceId] = buildInstance(instanceId, wsiInfo, fileInfo, true);
      state.activeInstanceId = instanceId;
    },

    resetWSIState: () => {
      return initialState;
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
  updateInstanceFilePath,
  patchInstanceFileInfo,
  replaceCurrentInstance,
  resetWSIState,
} = wsiSlice.actions;

export const selectInstanceFilePath = (
  state: { wsi: WSIState },
  instanceId: string | null | undefined,
): string | null => {
  if (!instanceId) return null;
  return state.wsi.instances[instanceId]?.filePath ?? null;
};

export const selectActiveInstanceFilePath = (state: { wsi: WSIState }): string | null => {
  const id = state.wsi.activeInstanceId;
  if (!id) return null;
  return state.wsi.instances[id]?.filePath ?? null;
};

export default wsiSlice.reducer;
