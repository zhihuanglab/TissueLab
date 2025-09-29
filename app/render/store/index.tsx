// store/index.tsx - Migrated to tissuelab.org lightweight approach
import { configureStore } from '@reduxjs/toolkit'
import { combineReducers } from 'redux'
// Removed redux-persist - using localStorage directly for lightweight data like tissuelab.org

import userReducer from './slices/userSlice'
import sidebarReducer from './slices/sidebarSlice'
import themeReducer from './slices/themeSlice'
import uploadedFilesReducer from './slices/uploadedFilesSlice'
import annotationReducer from "@/store/slices/annotationSlice";
import coPilotReducer from "@/store/slices/coPilotSlice";
import svsPathReducer from './slices/svsPathSlice';
import agentReducer from "@/store/slices/agentSlice";
import shapeReducer from '@/store/slices/shapeSlice';
import chatReducer from "@/store/slices/chatSlice";
import modelTypeReducer from './slices/modelTypeSlice';
import workflowReducer from './slices/workflowSlice';
import viewerReducer from './slices/viewerSlice';
import toolReducer from './slices/toolSlice';
import panelReducer from './slices/panelSlice';
import wsiReducer from './slices/wsiSlice';
import webFileManagerReducer from './slices/webFileManagerSlice';
import multiWindowReducer from './slices/multiWindowSlice';
import activeLearningReducer from './slices/activeLearningSlice';
import imageSettingsReducer from './slices/imageSettingsSlice';
import viewerSettingsReducer from './slices/viewerSettingsSlice';
import modelSelectionReducer from './slices/modelSelectionSlice';
import shortcutsReducer from './slices/shortcutsSlice';

// No more persist config - following tissuelab.org pattern
const rootReducer = combineReducers({
  user: userReducer,
  sidebar: sidebarReducer,
  theme: themeReducer,
  uploadedFiles: uploadedFilesReducer,
  annotations: annotationReducer,
  coPilot: coPilotReducer,
  svsPath: svsPathReducer,
  agent: agentReducer,
  shape: shapeReducer,
  chat: chatReducer,
  modelType: modelTypeReducer,
  workflow: workflowReducer,
  viewer: viewerReducer,
  tool: toolReducer,
  panel: panelReducer,
  wsi: wsiReducer,
  webFileManager: webFileManagerReducer,
  multiWindow: multiWindowReducer,
  activeLearning: activeLearningReducer,
  imageSettings: imageSettingsReducer,
  viewerSettings: viewerSettingsReducer,
  modelSelection: modelSelectionReducer,
  shortcuts: shortcutsReducer,
})

// Generate a unique ID for this renderer instance
const RENDERER_ID = Date.now().toString() + Math.random().toString().slice(2);

// Bounded cache with fixed size to prevent memory growth
const processedActions = new Map();
const MAX_ACTIONS_CACHED = 100;

// Add an action to the cache, removing oldest if necessary
function trackAction(fingerprint: string) {
  if (processedActions.size >= MAX_ACTIONS_CACHED) {
    // Remove oldest entry when we reach the limit
    const oldestKey = processedActions.keys().next().value;
    processedActions.delete(oldestKey);
  }
  processedActions.set(fingerprint, true);
}

// Simplified middleware that avoids duplicates
const reduxSyncMiddleware = (store: any) => (next: any) => (action: any) => {
  // Process the action locally first
  const result = next(action);
  
  // Only sync nucleiClasses actions that aren't already synced
  if (action.type?.startsWith('nucleiClasses/') && !action.meta?.synced) {
    // Create a simple fingerprint for deduplication
    const fingerprint = `${action.type}-${JSON.stringify(action.payload)}-${Date.now()}`;
    
    // Track this action
    trackAction(fingerprint);
    
    // Add metadata for synchronization
    const syncedAction = {
      ...action,
      meta: {
        ...action.meta,
        synced: true,
        fingerprint
      }
    };
    
    // Send to main process
    // window.electron.send('sync-redux-action', syncedAction);
  }
  
  return result;
};

export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [
          // Ignore annotation actions that contain Date objects
          'annotations/addAnnotation',
          'annotations/setAnnotations', 
          'annotations/updateAnnotationById',
          'annotations/setNucleiClasses',
          'annotations/setPatchClassificationData',
          'annotations/setAnnotationType',
          'annotations/clearAnnotationTypes',
          'annotations/setClassificationEnabled',
          'annotations/requestClassification',
          'annotations/classificationRequestComplete',
          'shape/setShapeData',
          'viewer/setCurrentViewerCoordinates'
        ],
        ignoredPaths: [
          'annotations.annotations',
          'annotations.nuclei_segmentation',
          'annotations.annotationTypeMap',
          'annotations.patchClassificationData',
          'annotations.nucleiClasses',
          'annotations.regionClasses',
          'annotations.activeManualClassificationClass',
          'shape.rectangleCoords',
          'shape.polygonPoints',
          'wsi.currentWSIInfo',
          'wsi.fileInfo'
        ],
        // Increase warning threshold to reduce noise
        warnAfter: 128,
      },
    }).concat(reduxSyncMiddleware), // Add the sync middleware
})

// No more persistor - following tissuelab.org lightweight approach

// // Set up IPC listener
// if (typeof window !== 'undefined') {
//   window.electron?.on('redux-state-update', (event: unknown, action: any) => {
//     // Only process actions we haven't seen before
//     if (action.meta?.fingerprint && !processedActions.has(action.meta.fingerprint)) {
//       // Track this action
//       trackAction(action.meta.fingerprint);
//       // Dispatch to local store
//       store.dispatch(action);
//     }
//   });
// }

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
