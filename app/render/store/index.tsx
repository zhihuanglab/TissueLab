// store/index.tsx - Migrated to tissuelab.org lightweight approach
import { configureStore } from '@reduxjs/toolkit'
import { combineReducers } from 'redux'
// Removed redux-persist - using localStorage directly for lightweight data like tissuelab.org

import userReducer from './slices/userSlice'
import layoutReducer from './slices/layoutSlice'
import themeReducer from './slices/themeSlice'
import fileManagerReducer from './slices/fileManagerSlice'
import annotationReducer from "@/store/slices/viewer/annotationSlice";
import coPilotReducer from "@/store/slices/chat/coPilotSlice";
import svsPathReducer from './slices/svsPathSlice';
import agentReducer from "@/store/slices/chat/agentSlice";
import shapeReducer from '@/store/slices/viewer/shapeSlice';
import chatReducer from "@/store/slices/chat/chatSlice";
import modelTypeReducer from '@/store/slices/chat/modelTypeSlice';
import workflowReducer from '@/store/slices/chat/workflowSlice';
import viewerReducer from '@/store/slices/viewer/viewerSlice';
import toolReducer from '@/store/slices/viewer/toolSlice';
import wsiReducer from '@/store/slices/wsiSlice';
import reviewReducer from '@/store/slices/reviewSlice';
import imageSettingsReducer from '@/store/slices/viewer/imageSettingsSlice';
import viewerSettingsReducer from '@/store/slices/viewer/viewerSettingsSlice';
import gtHighlightReducer from '@/store/slices/viewer/gtHighlightSlice';
import modelSelectionReducer from '@/store/slices/chat/modelSelectionSlice';
import shortcutsReducer from '@/store/slices/viewer/shortcutsSlice';
import recordingTranscriptReducer from '@/store/slices/viewer/recordingTranscriptSlice';

// No more persist config - following tissuelab.org pattern
const rootReducer = combineReducers({
  user: userReducer,
  layout: layoutReducer,
  theme: themeReducer,
  fileManager: fileManagerReducer,
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
  wsi: wsiReducer,
  review: reviewReducer,
  imageSettings: imageSettingsReducer,
  viewerSettings: viewerSettingsReducer,
  gtHighlight: gtHighlightReducer,
  modelSelection: modelSelectionReducer,
  shortcuts: shortcutsReducer,
  recordingTranscript: recordingTranscriptReducer,
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
