import { useEffect, useLayoutEffect, useRef } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch, store } from '@/store';
import {
  setAnnotations,
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
} from '@/store/slices/viewer/annotationSlice';
import { clearGtHighlightIndices } from '@/store/slices/viewer/gtHighlightSlice';
import { clearViewportOverlayCaches } from '@/utils/viewer/viewportOverlayCaches';
import { flushSelectedManualDrawings, withManualPersistSuppressed } from '@/utils/viewer/persistManualDrawing';
import { EMPTY_OVERLAY_PENDING, type OverlayPendingRequest } from '@/utils/viewer/overlayRequestNotify';

// Per-instance previous path (survives remount of a given viewer session).
const prevPathByInstance = new Map<string, string | null>();

interface UseFileChangeHandlerParams {
  currentPath: string | null;
  instanceId?: string | null;
  /** When false, ignore shared currentPath changes (inactive viewer session). */
  isActive?: boolean;
  annotatorInstance: any;
  viewerInstance: any;
  setAllTilesLoaded: (loaded: boolean) => void;
  setExistAnnotationFile: (exists: boolean) => void;
  /** Slide changed / cleared — drop the binding and shut the wire gate. */
  releaseBinding: () => void;
  lastHashRef: React.MutableRefObject<string | null>;
  // Cleared on file switch so WS handlers drop stale centroid messages
  // queued for the previous slide; the next set_path ack reopens the gate.
  setPendingRequest?: (type: OverlayPendingRequest) => void;
}

/** Persist selected manuals to the *old* slide before suppress wipe. */
function clearAnnotoriousLayer(
  annotator: any,
  instanceId?: string | null,
  /** Previous slide path — flush dirty selection here before wipe. */
  flushPath?: string | null,
) {
  if (!annotator) return;
  // Must run outside suppress so comment/geometry/style reach the old sidecar.
  if (flushPath) {
    flushSelectedManualDrawings(annotator, instanceId, flushPath);
  }
  // Block deselect flush onto the new slide's manual.json during wipe.
  withManualPersistSuppressed(instanceId, () => {
    try {
      annotator.cancelSelected?.();
    } catch {}
    try {
      annotator.setAnnotations([], true);
    } catch {}
  });
}

/**
 * Hook to handle file path changes and cleanup
 * Extracted from OpenSeadragonContainer to improve code organization
 */
export const useFileChangeHandler = (params: UseFileChangeHandlerParams) => {
  const dispatch = useDispatch<AppDispatch>();
  const {
    currentPath,
    instanceId,
    isActive = true,
    annotatorInstance,
    viewerInstance,
    setAllTilesLoaded,
    setExistAnnotationFile,
    releaseBinding,
    lastHashRef,
    setPendingRequest,
  } = params;

  const pathKey = instanceId || '__default__';

  const annotatorInstanceRef = useRef(annotatorInstance);
  const viewerInstanceRef = useRef(viewerInstance);
  // Path changed while Annotorious was not ready — clear as soon as it mounts.
  const pendingAnnotoriousClearRef = useRef(false);
  const pendingFlushPathRef = useRef<string | null>(null);

  useEffect(() => {
    annotatorInstanceRef.current = annotatorInstance;
    viewerInstanceRef.current = viewerInstance;
    if (annotatorInstance && pendingAnnotoriousClearRef.current) {
      pendingAnnotoriousClearRef.current = false;
      const flushPath = pendingFlushPathRef.current;
      pendingFlushPathRef.current = null;
      clearAnnotoriousLayer(annotatorInstance, instanceId, flushPath);
    }
  }, [annotatorInstance, viewerInstance, instanceId]);

  useLayoutEffect(() => {
    if (!isActive) return;

    const prevPath = prevPathByInstance.has(pathKey)
      ? prevPathByInstance.get(pathKey)!
      : null;

    if (!prevPathByInstance.has(pathKey)) {
      prevPathByInstance.set(pathKey, currentPath);
      return;
    }

    if (prevPath !== currentPath) {
      // Un-bind: the gate stays shut until the new slide's set_path is acked.
      releaseBinding();
      setPendingRequest?.(EMPTY_OVERLAY_PENDING);

      if (instanceId && prevPath) {
        clearViewportOverlayCaches(instanceId, prevPath);
      } else if (instanceId) {
        clearViewportOverlayCaches(instanceId);
      }

      dispatch(setAnnotations([]));
      dispatch(clearNucleiSegmentation());
      dispatch(clearTissueSegmentation());
      dispatch(clearGtHighlightIndices());
      // Cell overlay state is emptied during render in OpenSeadragonContainer
      // (covers inactive panes). Do not setState again here — a fresh `[]`
      // would schedule another commit after layout.

      if (annotatorInstanceRef.current) {
        clearAnnotoriousLayer(annotatorInstanceRef.current, instanceId, prevPath);
        pendingAnnotoriousClearRef.current = false;
        pendingFlushPathRef.current = null;
      } else {
        pendingAnnotoriousClearRef.current = true;
        pendingFlushPathRef.current = prevPath;
      }

      dispatch(clearAnnotationTypes());

      // Do NOT send set_path:"" — races with the real set_path in OSD container.
      // releaseBinding() already forgets the bound path.

      dispatch(clearPatchOverrides());
      const currentPatchData = store.getState().annotations.patchClassificationData;
      if (currentPatchData && currentPatchData.class_name.length > 1) {
        dispatch(
          setPatchClassificationData({
            class_id: [0],
            class_name: ['Negative control'],
            class_hex_color: ['#aaaaaa'],
            class_counts: [0],
          }),
        );
      } else if (currentPatchData?.class_counts?.some((count) => count > 0)) {
        dispatch(
          setPatchClassificationData({
            ...currentPatchData,
            class_counts: currentPatchData.class_counts.map(() => 0),
          }),
        );
      }
      setAllTilesLoaded(false);
      setExistAnnotationFile(false);
      releaseBinding();

      lastHashRef.current = null;

      const currentNucleiClasses = store.getState().annotations.nucleiClasses;
      if (currentNucleiClasses.length > 1) {
        dispatch(resetNucleiClasses());
      } else {
        const hasNonZeroCounts = currentNucleiClasses.some((cls) => cls.count > 0);
        if (hasNonZeroCounts) {
          dispatch(
            setNucleiClasses(
              currentNucleiClasses.map((cls) => ({ ...cls, count: 0 })),
            ),
          );
        }
      }

      dispatch(resetRegionClasses());
      dispatch(setActiveManualClassificationClass(null));
      dispatch(classificationRequestComplete());
      dispatch(resetClassificationEnabled());

      if (store.getState().annotations.isEditPanelOpen) {
        dispatch(toggleEditPanel());
      }

      if (
        viewerInstanceRef.current &&
        viewerInstanceRef.current.world.getItemCount() > 0
      ) {
        try {
          viewerInstanceRef.current.forceRedraw();
        } catch (error) {
          console.warn('[File Change] Failed to force redraw:', error);
        }
      }
    }

    prevPathByInstance.set(pathKey, currentPath);
    // Setter identities from useState are stable — keep deps on path only.
  }, [currentPath, instanceId, isActive, dispatch]);
};
