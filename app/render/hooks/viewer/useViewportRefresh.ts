import { useCallback, useEffect, useRef } from 'react';
import EventBus from '@/utils/EventBus';


interface UseViewportRefreshParams {
  socket: WebSocket | null;
  viewerInstance: any;
  currentPath: string | null;
  threshold: number;
  centroidThreshold: number;
  classificationEnabled: boolean;
  showBackendAnnotations: boolean;
  existAnnotationFile: boolean;
  instanceId?: string | null;
  setLoadingAnnotations: (loading: boolean) => void;
  setIsZarrInitializing: (initializing: boolean) => void;
  setIsRequestPending: (pending: boolean) => void;
  setCurrentRequestType: (type: 'space' | 'x' | null) => void;
  zarrInitTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  lastHashRef: React.MutableRefObject<string | null>;
  lastSentPathRef: React.MutableRefObject<string | null>;
  lastWorkflowRefreshTsRef: React.MutableRefObject<number>;
  ZARR_INIT_TIMEOUT_MS: number;
  requestPatchesForViewport: () => void;
  refreshPatchClassificationData: () => Promise<void>;
}

/**
 * Hook to handle viewport refresh and WebSocket path refresh events
 * Extracted from OpenSeadragonContainer to improve code organization
 */
export const useViewportRefresh = (params: UseViewportRefreshParams) => {
  const {
    socket,
    viewerInstance,
    currentPath,
    threshold,
    centroidThreshold,
    classificationEnabled,
    showBackendAnnotations,
    existAnnotationFile,
    instanceId,
    setLoadingAnnotations,
    setIsZarrInitializing,
    setIsRequestPending,
    setCurrentRequestType,
    zarrInitTimeoutRef,
    lastHashRef,
    lastSentPathRef,
    lastWorkflowRefreshTsRef,
    ZARR_INIT_TIMEOUT_MS,
    requestPatchesForViewport,
    refreshPatchClassificationData,
  } = params;

  const requestViewportDataForCounts = useCallback(() => {
    try {
      const viewer = viewerInstance;
      if (!viewer || !viewer.viewport || !socket || socket.readyState !== WebSocket.OPEN) return;

      const viewportBounds = viewer.viewport.getBounds();
      const tiledImage = viewer.world.getItemAt(0);
      const topLeft = tiledImage
        ? tiledImage.viewportToImageCoordinates(viewportBounds.getTopLeft())
        : viewer.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
      const bottomRight = tiledImage
        ? tiledImage.viewportToImageCoordinates(viewportBounds.getBottomRight())
        : viewer.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());
      const x1 = Math.round(topLeft.x);
      const y1 = Math.round(topLeft.y);
      const x2 = Math.round(bottomRight.x);
      const y2 = Math.round(bottomRight.y);

      const zoom = viewer.viewport.getZoom();
      const isImageFile =
        currentPath &&
        (currentPath.toLowerCase().endsWith('.png') ||
          currentPath.toLowerCase().endsWith('.jpg') ||
          currentPath.toLowerCase().endsWith('.jpeg') ||
          currentPath.toLowerCase().endsWith('.bmp'));

      let requestType: 'annotations' | 'all_annotations' | 'centroids' = 'annotations';
      if (isImageFile) {
        requestType = 'annotations';
      } else if (zoom >= threshold) {
        requestType = 'annotations';
      } else if (zoom >= centroidThreshold) {
        requestType = 'all_annotations';
      } else {
        requestType = 'centroids';
      }

      if (showBackendAnnotations) setLoadingAnnotations(true);
      socket.send(
        JSON.stringify({
          x1,
          y1,
          x2,
          y2,
          type: requestType,
          use_classification: classificationEnabled,
          instance_id: instanceId,
        })
      );
      socket.send(JSON.stringify({ x1, y1, x2, y2, type: 'patches', instance_id: instanceId }));
    } catch (err) {
      console.error('Failed to send viewport request:', err);
    }
  }, [
    socket,
    viewerInstance,
    currentPath,
    threshold,
    centroidThreshold,
    classificationEnabled,
    showBackendAnnotations,
    setLoadingAnnotations,
    instanceId,
  ]);

  // Coalesce viewport WS bursts (e.g. refresh-websocket-path + handler-reload-complete in quick succession).
  const viewportDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRequestViewportDataForCounts = useCallback(() => {
    if (viewportDebounceRef.current) clearTimeout(viewportDebounceRef.current);
    viewportDebounceRef.current = setTimeout(() => {
      viewportDebounceRef.current = null;
      requestViewportDataForCounts();
    }, 80);
  }, [requestViewportDataForCounts]);

  // After set_path completes (including "Path already set"), WS handler emits this — viewport refetch is event-driven (no fixed delay).
  useEffect(() => {
    const onHandlerReloadComplete = () => {
      debouncedRequestViewportDataForCounts();
    };
    EventBus.on('handler-reload-complete', onHandlerReloadComplete);
    return () => {
      EventBus.off('handler-reload-complete', onHandlerReloadComplete);
    };
  }, [debouncedRequestViewportDataForCounts]);

  useEffect(() => {
    return () => {
      if (viewportDebounceRef.current) {
        clearTimeout(viewportDebounceRef.current);
        viewportDebounceRef.current = null;
      }
    };
  }, []);

  // Handle refresh-websocket-path event
  useEffect(() => {
    const handleRefreshWebSocketPath = ({
      path,
      forceReload,
      patchesOnly: _patchesOnly,
    }: {
      path: string;
      forceReload?: boolean;
      patchesOnly?: boolean;
    }) => {
      // Mark last workflow-related refresh time for brief retry window on Space/X
      lastWorkflowRefreshTsRef.current = Date.now();
      if (socket && socket.readyState === WebSocket.OPEN && path) {
        // Clear hash when refreshing WebSocket path
        lastHashRef.current = null;
        // If the path hasn't changed, avoid reloading the Zarr; just ask for counts
        const normalizedIncoming = (path || '').replace(/\.(zarr)$/i, '');
        const normalizedCurrent = (currentPath || '').replace(/\.(zarr)$/i, '');
        // Force reload if the flag is set (e.g., after workflow completion)
        if (!forceReload && (lastSentPathRef.current === normalizedIncoming || normalizedIncoming === normalizedCurrent)) {
          debouncedRequestViewportDataForCounts();
        } else {
          // Clear any existing timeout
          if (zarrInitTimeoutRef.current) {
            clearTimeout(zarrInitTimeoutRef.current);
            zarrInitTimeoutRef.current = null;
          }

          setLoadingAnnotations(true);
          setIsZarrInitializing(true); // Mark Zarr as initializing

          // Set timeout for Zarr initialization
          zarrInitTimeoutRef.current = setTimeout(() => {
            console.log(
              `[Zarr Init Timeout] No response after ${ZARR_INIT_TIMEOUT_MS / 1000} seconds during force reload, assuming no Zarr file`,
            );
            setIsZarrInitializing(false);
            setLoadingAnnotations(false);
            setIsRequestPending(false);
            setCurrentRequestType(null);
            zarrInitTimeoutRef.current = null;
          }, ZARR_INIT_TIMEOUT_MS);

          socket.send(
            JSON.stringify({
              type: 'set_path',
              path: normalizedIncoming,
              instance_id: instanceId,
            })
          );
          // Viewport refetch: debounced path above, or handler-reload-complete after set_path ack (handleZarrLoadedSuccess).
        }
      }
    };

    EventBus.on('refresh-websocket-path', handleRefreshWebSocketPath);
    return () => {
      EventBus.off('refresh-websocket-path', handleRefreshWebSocketPath);
    };
  }, [
    socket,
    viewerInstance,
    currentPath,
    debouncedRequestViewportDataForCounts,
    setLoadingAnnotations,
    setIsZarrInitializing,
    setIsRequestPending,
    setCurrentRequestType,
    zarrInitTimeoutRef,
    lastHashRef,
    lastSentPathRef,
    lastWorkflowRefreshTsRef,
    ZARR_INIT_TIMEOUT_MS,
    instanceId,
  ]);

  // Handle refresh-patches event
  useEffect(() => {
    const handleRefreshPatches = () => {
      requestPatchesForViewport();
    };

    EventBus.on('refresh-patches', handleRefreshPatches);
    return () => {
      EventBus.off('refresh-patches', handleRefreshPatches);
    };
  }, [requestPatchesForViewport, refreshPatchClassificationData]);
};
