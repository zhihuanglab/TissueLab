import { AppDispatch } from '@/store';
import { clearPatchOverlays, setAnnotations } from '@/store/slices/viewer/annotationSlice';
import { ensureValidAnnotation } from '@/utils/annotationUtils';
import { useCallback, useState } from 'react';
import { useDispatch } from 'react-redux';
import { toast } from 'sonner';


interface UseViewportDataRequestsParams {
  viewerInstance: any;
  socket: WebSocket | null;
  annotatorInstance: any;
  currentPath: string | null;
  instanceId?: string | null;
  threshold: number;
  centroidThreshold: number;
  classificationEnabled: boolean;
  showUserAnnotations: boolean;
  annotationFilter: (annotation: any) => boolean;
  setLoadingAnnotations: (loading: boolean) => void;
  refreshPatchClassificationData: () => Promise<void>;
  // Refs
  lastHashRef: React.MutableRefObject<string | null>;
  lastRequestTimeRef: React.MutableRefObject<number>;
  lastWorkflowRefreshTsRef: React.MutableRefObject<number>;
  errorConfirmTimersRef: React.MutableRefObject<{
    space: ReturnType<typeof setTimeout> | null;
    x: ReturnType<typeof setTimeout> | null;
  }>;
  errorConfirmAttemptsRef: React.MutableRefObject<{ space: number; x: number }>;
  quickSpaceFallbackTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  // State
  existAnnotationFile: boolean;
  isZarrInitializing: boolean;
  setCurrentRequestType: (type: 'space' | 'x' | null) => void;
  hasRenderableSegmentationData: () => boolean;
  centroids: any;
  renderingAnnotations: any[];
}

/**
 * Hook to handle viewport data requests for the viewer
 * Extracted from OpenSeadragonContainer to improve code organization
 */
export const useViewportDataRequests = (params: UseViewportDataRequestsParams) => {
  const dispatch = useDispatch<AppDispatch>();
  const {
    viewerInstance,
    socket,
    annotatorInstance,
    currentPath,
    instanceId,
    threshold,
    centroidThreshold,
    classificationEnabled,
    showUserAnnotations,
    annotationFilter,
    setLoadingAnnotations,
    refreshPatchClassificationData,
    lastHashRef,
    lastRequestTimeRef,
    lastWorkflowRefreshTsRef,
    errorConfirmTimersRef,
    errorConfirmAttemptsRef,
    quickSpaceFallbackTimerRef,
    existAnnotationFile,
    isZarrInitializing,
    setCurrentRequestType,
    hasRenderableSegmentationData,
    centroids,
    renderingAnnotations,
  } = params;

  const [hasNucleiData, setHasNucleiData] = useState(true);
  const [hasPatchData, setHasPatchData] = useState(true);

  // Request viewport data based on type (space or x)
  const requestViewportDataForType = useCallback(
    (reqType: 'space' | 'x') => {
      if (!viewerInstance || !socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        const viewportBounds = viewerInstance.viewport.getBounds();
        // Use TiledImage API instead of Viewport API to avoid warnings
        const tiledImage = viewerInstance.world.getItemAt(0);
        const topLeft = tiledImage
          ? tiledImage.viewportToImageCoordinates(viewportBounds.getTopLeft())
          : viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
        const bottomRight = tiledImage
          ? tiledImage.viewportToImageCoordinates(viewportBounds.getBottomRight())
          : viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());
        const x1 = Math.round(topLeft.x);
        const y1 = Math.round(topLeft.y);
        const x2 = Math.round(bottomRight.x);
        const y2 = Math.round(bottomRight.y);

        if (reqType === 'x') {
          socket.send(JSON.stringify({ x1, y1, x2, y2, type: 'patches', instance_id: instanceId }));
          return;
        }

        const isImageFile =
          currentPath &&
          (currentPath.toLowerCase().endsWith('.png') ||
            currentPath.toLowerCase().endsWith('.jpg') ||
            currentPath.toLowerCase().endsWith('.jpeg') ||
            currentPath.toLowerCase().endsWith('.bmp'));

        const zoom = viewerInstance.viewport.getZoom();
        let req: 'annotations' | 'all_annotations' | 'centroids' = 'annotations';
        if (isImageFile) {
          req = 'annotations';
        } else if (zoom >= threshold) {
          req = 'annotations';
        } else if (zoom >= centroidThreshold) {
          req = 'all_annotations';
        } else {
          req = 'centroids';
        }
        socket.send(
          JSON.stringify({ x1, y1, x2, y2, type: req, use_classification: classificationEnabled, instance_id: instanceId })
        );
      } catch (e) {
        console.warn('[Retry] Failed to send viewport request during confirmation:', e);
      }
    },
    [viewerInstance, socket, currentPath, threshold, centroidThreshold, classificationEnabled, instanceId]
  );

  // Confirm Zarr missing and notify user
  const confirmZarrMissingThenNotify = useCallback(
    (reqType: 'space' | 'x', msgText: string) => {
      // If Zarr is still initializing, show loading message instead of error
      if (isZarrInitializing) {
        toast('Image is loading, please wait a moment...');
        setCurrentRequestType(null);
        return;
      }

      // Only retry briefly if a workflow just refreshed path; otherwise, show error immediately
      const now = Date.now();
      const withinRecentRefresh = now - lastWorkflowRefreshTsRef.current < 8000;

      // If UI already has data (e.g., workflow completed and layers visible), suppress error
      if (hasRenderableSegmentationData()) {
        setCurrentRequestType(null);
        return;
      }

      if (!withinRecentRefresh) {
        toast.error(msgText);
        setCurrentRequestType(null);
        return;
      }

      const MAX_TRIES = 1;
      const DELAY_MS = 400;

      if (errorConfirmTimersRef.current[reqType]) return; // already confirming

      // Cancel quick fallback if it's running to avoid duplicate toasts
      if (reqType === 'space' && quickSpaceFallbackTimerRef.current) {
        clearTimeout(quickSpaceFallbackTimerRef.current as unknown as number);
        quickSpaceFallbackTimerRef.current = null;
      }

      errorConfirmAttemptsRef.current[reqType] = 0;

      const attempt = () => {
        errorConfirmAttemptsRef.current[reqType] += 1;
        requestViewportDataForType(reqType);

        errorConfirmTimersRef.current[reqType] = setTimeout(() => {
          const attempts = errorConfirmAttemptsRef.current[reqType];

          if (existAnnotationFile) {
            // Data arrived; cancel and reset
            if (errorConfirmTimersRef.current[reqType]) {
              clearTimeout(errorConfirmTimersRef.current[reqType] as unknown as number);
              errorConfirmTimersRef.current[reqType] = null;
            }
            errorConfirmAttemptsRef.current[reqType] = 0;
            setCurrentRequestType(null);
            return;
          }

          if (attempts < MAX_TRIES) {
            attempt();
          } else {
            toast.error(msgText);
            setCurrentRequestType(null);
            if (errorConfirmTimersRef.current[reqType]) {
              clearTimeout(errorConfirmTimersRef.current[reqType] as unknown as number);
              errorConfirmTimersRef.current[reqType] = null;
            }
            errorConfirmAttemptsRef.current[reqType] = 0;
          }
        }, DELAY_MS);
      };

      attempt();
    },
    [
      isZarrInitializing,
      existAnnotationFile,
      requestViewportDataForType,
      hasRenderableSegmentationData,
      setCurrentRequestType,
      lastWorkflowRefreshTsRef,
      errorConfirmTimersRef,
      errorConfirmAttemptsRef,
      quickSpaceFallbackTimerRef,
    ]
  );

  // Request patches for current viewport
  const requestPatchesForViewport = useCallback(() => {
    if (!viewerInstance) {
      return false;
    }

    const viewportBounds = viewerInstance.viewport.getBounds();
    const tiledImage = viewerInstance.world.getItemAt(0);
    const topLeft = tiledImage
      ? tiledImage.viewportToImageCoordinates(viewportBounds.getTopLeft())
      : viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
    const bottomRight = tiledImage
      ? tiledImage.viewportToImageCoordinates(viewportBounds.getBottomRight())
      : viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());
    const x1 = Math.round(topLeft.x);
    const y1 = Math.round(topLeft.y);
    const x2 = Math.round(bottomRight.x);
    const y2 = Math.round(bottomRight.y);

    if (socket && socket.readyState === WebSocket.OPEN) {
      console.log('[Patches] Requesting patches for current viewport.');
      socket.send(JSON.stringify({ x1, y1, x2, y2, type: 'patches', instance_id: instanceId }));
      return true;
    }

    console.log('[Patches] WebSocket not connected or not ready for patches request.');
    return false;
  }, [socket, viewerInstance, instanceId]);

  // Handle Space key toggle for backend annotations
  const keydownUpdate = useCallback(
    (prev: boolean, newVal: boolean) => {
      if (annotatorInstance) {
        annotatorInstance.setFilter(annotationFilter);
      }

      // Check if this is an image file
      const isImageFile =
        currentPath &&
        (currentPath.toLowerCase().endsWith('.png') ||
          currentPath.toLowerCase().endsWith('.jpg') ||
          currentPath.toLowerCase().endsWith('.jpeg') ||
          currentPath.toLowerCase().endsWith('.bmp'));

      // When turning off backend annotations, clean annotations
      if (prev === true && newVal === false && annotatorInstance) {
        // Cleaning is necessary regardless of file type
        const allAnns = annotatorInstance.getAnnotations();
        const userAnns = allAnns.filter((a: { isBackend: any }) => !a.isBackend);
        annotatorInstance.setAnnotations([], true);
        dispatch(setAnnotations([]));
        userAnns.forEach((annotation: any) => {
          const validAnnotation = ensureValidAnnotation(annotation);
          annotatorInstance.addAnnotation(validAnnotation);
        });

        // Apply filter
        annotatorInstance.setFilter((anno: { isBackend: any }) => {
          if (!newVal && anno.isBackend) return false;
          if (!showUserAnnotations && !anno.isBackend) return false;
          return true;
        });

        lastRequestTimeRef.current = Date.now();

        // Avoid duplicate backend clear; rely on viewer-event logic to manage cleanup
        setLoadingAnnotations(false);
      }

      // When turning on backend annotations, request data
      if (prev === false && newVal === true && annotatorInstance && viewerInstance) {
        const zoom = viewerInstance.viewport.getZoom();
        console.log(`Current zoom level: ${zoom}, Threshold: ${threshold}, Above threshold: ${zoom >= threshold}`);

        const viewportBounds = viewerInstance.viewport.getBounds();
        const tiledImage = viewerInstance.world.getItemAt(0);
        const topLeft = tiledImage
          ? tiledImage.viewportToImageCoordinates(viewportBounds.getTopLeft())
          : viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
        const bottomRight = tiledImage
          ? tiledImage.viewportToImageCoordinates(viewportBounds.getBottomRight())
          : viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());
        const x1 = Math.round(topLeft.x);
        const y1 = Math.round(topLeft.y);
        const x2 = Math.round(bottomRight.x);
        const y2 = Math.round(bottomRight.y);

        if (socket && socket.readyState === WebSocket.OPEN && !isZarrInitializing) {
          console.log(`Preparing to send WebSocket request, parameters: x1=${x1}, y1=${y1}, x2=${x2}, y2=${y2}`);

          // Determine request type based on file type
          if (isImageFile) {
            // Image files always request annotations
            console.log('Image file, requesting annotations data');
            setLoadingAnnotations(true);
            socket.send(
              JSON.stringify({
                x1,
                y1,
                x2,
                y2,
                type: 'annotations',
                use_classification: classificationEnabled,
                instance_id: instanceId,
              })
            );
          } else if (zoom >= threshold) {
            // Non-image files, high zoom level requests annotations
            console.log('High zoom level, requesting annotations data');
            setLoadingAnnotations(true);
            socket.send(
              JSON.stringify({
                x1,
                y1,
                x2,
                y2,
                type: 'annotations',
                use_classification: classificationEnabled,
                instance_id: instanceId,
              })
            );
          } else if (zoom >= centroidThreshold) {
            // Non-image files, above centroid threshold requests all_annotations
            console.log('Above centroid threshold, requesting all_annotations data');
            setLoadingAnnotations(true);
            socket.send(
              JSON.stringify({
                x1,
                y1,
                x2,
                y2,
                type: 'all_annotations',
                use_classification: classificationEnabled,
                instance_id: instanceId,
              })
            );
          } else {
            // Non-image files, below centroid threshold requests centroids
            console.log('Below centroid threshold, requesting centroids data');
            setLoadingAnnotations(true);
            socket.send(
              JSON.stringify({
                x1,
                y1,
                x2,
                y2,
                type: 'centroids',
                use_classification: classificationEnabled,
                instance_id: instanceId,
              })
            );
          }
        } else if (!(socket && socket.readyState === WebSocket.OPEN)) {
          console.log('WebSocket not connected or not ready');
          // Even if WebSocket is not ready, set loading state to indicate we're trying
          setLoadingAnnotations(true);
        }
      }
    },
    [
      annotatorInstance,
      threshold,
      centroidThreshold,
      classificationEnabled,
      socket,
      currentPath,
      dispatch,
      annotationFilter,
      showUserAnnotations,
      viewerInstance,
      instanceId,
      isZarrInitializing,
      setLoadingAnnotations,
      lastRequestTimeRef,
    ]
  );

  // Handle X key toggle for patches
  const keydownUpdatePatches = useCallback(
    (prev: boolean, newVal: boolean) => {
      // When turning off patches, clear them and the hash to allow re-fetching
      if (prev === true && newVal === false) {
        dispatch(clearPatchOverlays());
        lastHashRef.current = null;
        setLoadingAnnotations(false);
        console.log('[Patches] Cleared patches and reset hash.');
        return;
      }

      // When turning on patches, request data
      if (prev === false && newVal === true && viewerInstance) {
        const viewportBounds = viewerInstance.viewport.getBounds();
        const topLeft = viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
        const bottomRight = viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());
        const x1 = Math.round(topLeft.x);
        const y1 = Math.round(topLeft.y);
        const x2 = Math.round(bottomRight.x);
        const y2 = Math.round(bottomRight.y);

        if (socket && socket.readyState === WebSocket.OPEN && !isZarrInitializing) {
          console.log('[Patches] Requesting patches for current viewport (user pressed X)');
          setLoadingAnnotations(true);
          socket.send(JSON.stringify({ x1, y1, x2, y2, type: 'patches', instance_id: instanceId }));
        } else if (!(socket && socket.readyState === WebSocket.OPEN)) {
          console.log('[Patches] WebSocket not connected or not ready');
          // Even if WebSocket is not ready, set loading state to indicate we're trying
          setLoadingAnnotations(true);
        }
      }
    },
    [dispatch, viewerInstance, socket, isZarrInitializing, instanceId, refreshPatchClassificationData, setLoadingAnnotations, lastHashRef]
  );

  return {
    requestViewportDataForType,
    requestPatchesForViewport,
    keydownUpdate,
    keydownUpdatePatches,
    confirmZarrMissingThenNotify,
    hasNucleiData,
    hasPatchData,
    setHasNucleiData,
    setHasPatchData,
  };
};
