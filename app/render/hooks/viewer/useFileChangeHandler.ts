import { useEffect, useRef } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch, store } from '@/store';
import {
  setAnnotations,
  clearPatchOverlays,
  clearPatchOverrides,
  setNucleiClasses,
  resetNucleiClasses,
  setPatchClassificationData,
  clearAnnotationTypes,
  clearNucleiSegmentation,
  clearTissueSegmentation,
  resetRegionClasses,
  setActiveManualClassificationClass,
  classificationRequestComplete,
  resetClassificationEnabled,
  toggleEditPanel,
  setEditAnnotations,
} from '@/store/slices/viewer/annotationSlice';
import { clearGtHighlightIndices } from '@/store/slices/viewer/gtHighlightSlice';
import { CentroidsArray } from '@/components/imageViewer/CentroidsArray';

const EMPTY_CENTROIDS = new CentroidsArray(new Int32Array(0), 0);

// Global ref to track previous path across component unmounts/remounts
// This ensures cleanup happens even when OpenSeadragonContainer is unmounted and remounted
const globalPrevPathRef = { current: null as string | null };

interface UseFileChangeHandlerParams {
  currentPath: string | null;
  annotatorInstance: any;
  socket: WebSocket | null;
  viewerInstance: any;
  setCentroids: (centroids: CentroidsArray) => void;
  setAllTilesLoaded: (loaded: boolean) => void;
  setExistAnnotationFile: (exists: boolean) => void;
  setIsZarrInitializing: (initializing: boolean) => void;
  zarrInitTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  lastHashRef: React.MutableRefObject<string | null>;
  lastSentPathRef?: React.MutableRefObject<string | null>;
  ZARR_INIT_TIMEOUT_MS: number;
}

/**
 * Hook to handle file path changes and cleanup
 * Extracted from OpenSeadragonContainer to improve code organization
 */
export const useFileChangeHandler = (params: UseFileChangeHandlerParams) => {
  const dispatch = useDispatch<AppDispatch>();
  const {
    currentPath,
    annotatorInstance,
    socket,
    viewerInstance,
    setCentroids,
    setAllTilesLoaded,
    setExistAnnotationFile,
    setIsZarrInitializing,
    zarrInitTimeoutRef,
    lastHashRef,
    lastSentPathRef,
    ZARR_INIT_TIMEOUT_MS,
  } = params;

  // Use refs to store latest values to avoid unnecessary re-renders
  const annotatorInstanceRef = useRef(annotatorInstance);
  const socketRef = useRef(socket);
  const viewerInstanceRef = useRef(viewerInstance);
  
  // Update refs when values change
  useEffect(() => {
    annotatorInstanceRef.current = annotatorInstance;
    socketRef.current = socket;
    viewerInstanceRef.current = viewerInstance;
  }, [annotatorInstance, socket, viewerInstance]);

  // Use global ref to track previous path across component unmounts/remounts
  // This ensures cleanup happens even when OpenSeadragonContainer is unmounted and remounted
  useEffect(() => {
    // Debug: log current path changes
    console.log(`[File Change] useEffect triggered, currentPath: ${currentPath}, globalPrevPathRef: ${globalPrevPathRef.current}`);
    
    // Initialize globalPrevPathRef on first mount (when it's null)
    if (globalPrevPathRef.current === null) {
      console.log(`[File Change] Initializing globalPrevPathRef with: ${currentPath}`);
      globalPrevPathRef.current = currentPath;
      
      // Mark that we need to clear backend on first mount (when socket is ready)
      // This flag will be used in a separate effect that watches socket connection
      return;
    }
    
    // Only run cleanup if path actually changed
    if (globalPrevPathRef.current !== currentPath) {
      console.log(`[File Change] Path changed from ${globalPrevPathRef.current} to ${currentPath}`);

      // 1) Clear backend annotations from Redux
      dispatch(setAnnotations([]));
      dispatch(clearNucleiSegmentation());
      dispatch(clearTissueSegmentation());
      dispatch(clearGtHighlightIndices());
      console.log(`[File Change] Cleared Redux annotations and segmentation data`);

      // 2) Clear UI annotations from Annotorious
      if (annotatorInstanceRef.current) {
        const beforeAnnotations = annotatorInstanceRef.current.getAnnotations();
        console.log(`[File Change] UI annotations count before cleanup: ${beforeAnnotations.length}`);
        annotatorInstanceRef.current.setAnnotations([], true);
        const afterAnnotations = annotatorInstanceRef.current.getAnnotations();
        console.log(`[File Change] Cleared UI annotations: ${beforeAnnotations.length} -> ${afterAnnotations.length}`);
      }

      // Clear zustand annotation types store (unconditionally, even if annotatorInstance is not ready)
      // This ensures cleanup happens when switching files from dashboard where annotatorInstance may not be initialized yet
      dispatch(clearAnnotationTypes());
      console.log(`[File Change] Cleared zustand annotation types store`);

      // 3) Do NOT send set_path:"" here.  The OpenSeadragonContainer useEffect
      //    (registered earlier in the component) fires first in the same render
      //    cycle and already sends set_path with the *new* path.  Sending an
      //    empty path afterwards would race and delete the handler the new
      //    set_path just created, leaving the viewer with no data ("No cell
      //    result").  The backend replaces/reloads the handler when it receives
      //    a new path, so an explicit clear is unnecessary.

      // Reset lastSentPathRef so the OpenSeadragonContainer effect knows it
      // must (re-)send the new path on the *next* render if this effect ran
      // in the same cycle before it.
      if (lastSentPathRef) {
        console.log(`[File Change] Resetting lastSentPathRef from ${lastSentPathRef.current} to null`);
        lastSentPathRef.current = null;
      }

      // 4) Clear centroids and patches
      setCentroids(EMPTY_CENTROIDS);
      dispatch(clearPatchOverlays());
      dispatch(clearPatchOverrides());
      setAllTilesLoaded(false);
      setExistAnnotationFile(false);
      setIsZarrInitializing(false); // Reset Zarr initialization state when switching images

      // 5) Clear Zarr initialization timeout when switching images
      if (zarrInitTimeoutRef.current) {
        clearTimeout(zarrInitTimeoutRef.current);
        zarrInitTimeoutRef.current = null;
      }

      // 6) Clear hash when switching images to avoid duplicate message detection
      lastHashRef.current = null;
      console.log(`[File Change] Cleared hash to avoid duplicate message detection`);

      // 7) Reset nucleiClasses to initial state (only Negative control) when switching files
      // This ensures colormap is reset and old classes don't persist across file switches
      const currentNucleiClasses = store.getState().annotations.nucleiClasses;
      // Only reset if there are more than just the default Negative control class
      if (currentNucleiClasses.length > 1) {
        dispatch(resetNucleiClasses());
        console.log(`[File Change] Reset nucleiClasses to initial state (removed ${currentNucleiClasses.length - 1} classes)`);
      } else {
        // If only Negative control exists, just reset its count
        const resetCounts = currentNucleiClasses.map((cls) => ({ ...cls, count: 0 }));
        const hasNonZeroCounts = currentNucleiClasses.some((cls) => cls.count > 0);
        if (hasNonZeroCounts) {
          dispatch(setNucleiClasses(resetCounts));
        }
      }

      // 8) Reset patch classification counts when switching images
      const currentPatchData = store.getState().annotations.patchClassificationData;
      if (currentPatchData?.class_counts?.some((count) => count > 0)) {
        dispatch(
          setPatchClassificationData({
            ...currentPatchData,
            class_counts: currentPatchData.class_counts.map(() => 0),
          })
        );
      }

      // 9) Reset region classes and other UI states
      dispatch(resetRegionClasses());
      dispatch(setActiveManualClassificationClass(null));
      dispatch(classificationRequestComplete()); // Reset classification request state
      dispatch(resetClassificationEnabled()); // Reset classification enabled state
      
      // Close edit panel if open and clear edit annotation
      const currentState = store.getState().annotations;
      if (currentState.isEditPanelOpen) {
        dispatch(toggleEditPanel()); // This will close it if open
      }
      if (currentState.editAnnotation !== undefined) {
        // setEditAnnotations only accepts string, so we use empty string to clear
        // The reducer will set it, but we need to check if there's a better way
        // For now, we'll just close the panel which should handle the cleanup
      }
      console.log(`[File Change] Reset region classes and UI states`);

      // 10) Force redraw viewer
      if (viewerInstanceRef.current && viewerInstanceRef.current.world.getItemCount() > 0) {
        try {
          viewerInstanceRef.current.forceRedraw();
        } catch (error) {
          console.warn('[File Change] Failed to force redraw:', error);
        }
      }

      console.log(`[File Change] Completed cleaning and reset`);
    }

    // Update global previous path reference
    globalPrevPathRef.current = currentPath;
  }, [
    currentPath,
    dispatch,
    setCentroids,
    setAllTilesLoaded,
    setExistAnnotationFile,
    setIsZarrInitializing,
    zarrInitTimeoutRef,
    lastHashRef,
    lastSentPathRef,
  ]);

  // Do not proactively send an empty set_path on first mount.
  // When a slide is already selected, that extra clear can race with the real set_path
  // request and leave the backend handler in a transient "not ready" state.
};
