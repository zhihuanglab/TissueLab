import { useEffect, useRef, useCallback } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch, store } from '@/store';
import { toast } from 'sonner';
import { decompressZstd } from '@/utils/compressionUtils';
import { CentroidsArray } from '@/components/imageViewer/CentroidsArray';
import { parseSegmentationBinary, parseAnnotationsBinary } from '@/utils/viewer/binaryParsers';
import {
  setAnnotations,
  setNucleiClasses,
  setPatchOverlays,
  clearPatchOverlays,
  clearPatchOverrides,
} from '@/store/slices/viewer/annotationSlice';
import EventBus from '@/utils/EventBus';

// Empty CentroidsArray constant for reuse
const EMPTY_CENTROIDS = new CentroidsArray(new Int32Array(0), 0);

interface UseWebSocketMessageHandlerParams {
  socket: WebSocket | null;
  annotatorInstance: any;
  viewerInstance: any;
  currentPath: string | null;
  showBackendAnnotations: boolean;
  showPatches: boolean;
  classificationEnabled: boolean;
  threshold: number;
  centroidThreshold: number;
  updateCentroids: (centroids: CentroidsArray) => void;
  setCentroids: (centroids: CentroidsArray) => void;
  setRenderingAnnotations: (annotations: any[]) => void;
  setLoadingAnnotations: (loading: boolean) => void;
  setExistAnnotationFile: (exists: boolean) => void;
  setIsRequestPending: (pending: boolean) => void;
  setCurrentRequestType: (type: 'space' | 'x' | null) => void;
  setIsZarrInitializing: (initializing: boolean) => void;
  updateCountsFromBackend: (counts: Record<string, number>) => void;
  refreshPatchClassificationData: () => Promise<void>;
  handleLoadClassification: () => Promise<void>;
  resetQueryFlag: () => void;
  // Refs
  hasherRef: React.MutableRefObject<any>;
  lastHashRef: React.MutableRefObject<string | null>;
  zarrInitTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  quickSpaceFallbackTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  errorConfirmTimersRef: React.MutableRefObject<{
    space: ReturnType<typeof setTimeout> | null;
    x: ReturnType<typeof setTimeout> | null;
  }>;
  errorConfirmAttemptsRef: React.MutableRefObject<{ space: number; x: number }>;
  annotationsCounter: React.MutableRefObject<{
    received: number;
    total: number;
    lastTimestamp: number;
  }>;
  existAnnotationFile: boolean;
  isZarrInitializing: boolean;
  currentRequestType: 'space' | 'x' | null;
  lastSentPathRef: React.MutableRefObject<string | null>;
}

/**
 * Hook to handle WebSocket message processing for the viewer
 * Extracted from OpenSeadragonContainer to improve code organization
 */
export const useWebSocketMessageHandler = (params: UseWebSocketMessageHandlerParams) => {
  const dispatch = useDispatch<AppDispatch>();
  const {
    socket,
    annotatorInstance,
    viewerInstance,
    currentPath,
    showBackendAnnotations,
    showPatches,
    classificationEnabled,
    threshold,
    centroidThreshold,
    updateCentroids,
    setCentroids,
    setRenderingAnnotations,
    setLoadingAnnotations,
    setExistAnnotationFile,
    setIsRequestPending,
    setCurrentRequestType,
    setIsZarrInitializing,
    updateCountsFromBackend,
    refreshPatchClassificationData,
    handleLoadClassification,
    resetQueryFlag,
    hasherRef,
    lastHashRef,
    zarrInitTimeoutRef,
    quickSpaceFallbackTimerRef,
    errorConfirmTimersRef,
    errorConfirmAttemptsRef,
    annotationsCounter,
    existAnnotationFile,
    isZarrInitializing,
    currentRequestType,
    lastSentPathRef,
  } = params;
  const annotatorInstanceRef = useRef(annotatorInstance);
  const viewerInstanceRef = useRef(viewerInstance);
  const processWebSocketMessageRef = useRef<(data: any) => Promise<void>>(async () => {});

  useEffect(() => {
    annotatorInstanceRef.current = annotatorInstance;
    viewerInstanceRef.current = viewerInstance;
  }, [annotatorInstance, viewerInstance]);

  // Process different types of WebSocket messages
  const processWebSocketMessage = useCallback(
    async (data: any) => {
      const isImageFile = !!(
        currentPath &&
        (currentPath.toLowerCase().endsWith('.png') ||
          currentPath.toLowerCase().endsWith('.jpg') ||
          currentPath.toLowerCase().endsWith('.jpeg') ||
          currentPath.toLowerCase().endsWith('.bmp'))
      );

      // Handle "no segmentation data" message
      if (data.status === 'info' && data.message === 'No segmentation data available for this image') {
        return handleNoSegmentationData(data, isImageFile);
      }

      // Any set_path success ack (includes "Path set successfully" and "Path already set" — same handler path)
      if (data.status === 'success' && data.type === 'set_path') {
        return handleZarrLoadedSuccess(data);
      }

      // Handle "Zarr file loaded successfully" message (legacy payloads without type: set_path)
      if (
        data.status === 'success' &&
        (data.message === 'Zarr file loaded successfully' || data.message?.startsWith('Path set successfully'))
      ) {
        return handleZarrLoadedSuccess(data);
      }

      // Handle other status messages
      if (data.status === 'info') {
        if (data.message === 'clear annotations') {
          return;
        }
        return;
      }

      // Handle compression metadata silently
      if (data.compressed !== undefined && data.original_size !== undefined && data.compressed_size !== undefined) {
        return;
      }


      // Handle standalone success messages
      if (data.status === 'success') {
        if (viewerInstance) {
          viewerInstance.viewport.update();
        }
        return;
      }

      // Handle info messages
      if (data.type === 'info' || data.status === 'info') {
        return;
      }

      let receivedActualData = false;

      // Handle centroids
      if (data.type === 'centroids' && (Array.isArray(data.centroids) || data.centroids instanceof CentroidsArray)) {
        receivedActualData = await handleCentroidsMessage(data, isImageFile);
      }
      // Handle patches
      else if (data.type === 'patches' && Array.isArray(data.patches)) {
        receivedActualData = await handlePatchesMessage(data, isImageFile);
      }
      // Handle all_annotations
      else if (data.type === 'all_annotations' && Array.isArray(data.all_annotations)) {
        receivedActualData = await handleAllAnnotationsMessage(data, isImageFile);
      }
      // Handle annotations
      else if (data.type === 'annotations' && Array.isArray(data.annotations)) {
        receivedActualData = await handleAnnotationsMessage(data, isImageFile);
      }
      // Handle errors and other messages
      else {
        handleOtherMessages(data, isImageFile);
      }

      // If this message contained actual segmentation data, mark Zarr as loaded
      if (receivedActualData) {
        setExistAnnotationFile(true);
        setIsRequestPending(false);

        // Cancel quick fallback and confirm timers on any data arrival
        if (quickSpaceFallbackTimerRef.current) {
          clearTimeout(quickSpaceFallbackTimerRef.current as unknown as number);
          quickSpaceFallbackTimerRef.current = null;
        }
        if (errorConfirmTimersRef.current.space) {
          clearTimeout(errorConfirmTimersRef.current.space as unknown as number);
          errorConfirmTimersRef.current.space = null;
          errorConfirmAttemptsRef.current.space = 0;
        }
        if (errorConfirmTimersRef.current.x) {
          clearTimeout(errorConfirmTimersRef.current.x as unknown as number);
          errorConfirmTimersRef.current.x = null;
          errorConfirmAttemptsRef.current.x = 0;
        }
      }
    },
    [
      currentPath,
      viewerInstance,
      showBackendAnnotations,
      showPatches,
      annotatorInstance,
      dispatch,
      setCentroids,
      setRenderingAnnotations,
      setExistAnnotationFile,
      setIsRequestPending,
      setCurrentRequestType,
      setIsZarrInitializing,
      updateCountsFromBackend,
      refreshPatchClassificationData,
      handleLoadClassification,
      existAnnotationFile,
      isZarrInitializing,
      currentRequestType,
      zarrInitTimeoutRef,
      quickSpaceFallbackTimerRef,
      errorConfirmTimersRef,
      errorConfirmAttemptsRef,
      annotationsCounter,
      lastSentPathRef,
    ]
  );

  useEffect(() => {
    processWebSocketMessageRef.current = processWebSocketMessage;
  }, [processWebSocketMessage]);

  useEffect(() => {
    if (!socket) {
      return;
    }

    const handleMessage = async (event: MessageEvent) => {
      try {
        if (event.data === 'pong') {
          return;
        }

        let data: any;
        const isBlob =
          event.data instanceof Blob ||
          (event.data &&
            typeof event.data === 'object' &&
            'size' in event.data &&
            'arrayBuffer' in event.data) ||
          (event.data && event.data.toString && event.data.toString().includes('[object Blob]'));
        const isArrayBuffer = event.data instanceof ArrayBuffer;

        if (isArrayBuffer || isBlob) {
          let arrayBuffer: ArrayBuffer;
          if (isBlob) {
            arrayBuffer = await event.data.arrayBuffer();
          } else {
            arrayBuffer = event.data;
          }

          try {
            const decompressed = await decompressZstd(arrayBuffer);
            const firstByte = decompressed[0];

            if (firstByte === 0x63) {
              data = parseSegmentationBinary(decompressed);
            } else if (firstByte === 0x61 || firstByte === 0x41) {
              data = parseAnnotationsBinary(decompressed);
              if (firstByte === 0x41) {
                data.type = 'all_annotations';
                data.all_annotations = data.annotations;
              }
            } else {
              const jsonString = new TextDecoder().decode(decompressed);
              data = JSON.parse(jsonString);
            }
          } catch (error) {
            console.error('[WS COMPRESSED] Failed to decompress/parse data:', error);
            return;
          }
        } else {
          try {
            data = JSON.parse(event.data);
          } catch (error) {
            console.error('[WS ERROR] Failed to parse JSON data:', error);
            return;
          }
        }

        if (typeof event.data === 'string' && event.data.length > 1000 && hasherRef.current) {
          const hash = hasherRef.current.h64(event.data);
          if (hash === lastHashRef.current) {
            setLoadingAnnotations(false);
            setIsRequestPending(false);
            setCurrentRequestType(null);
            return;
          }
          lastHashRef.current = hash;
        }

        await processWebSocketMessageRef.current(data);

        // Reset states on completion
        setLoadingAnnotations(false);
        setIsRequestPending(false);
        setCurrentRequestType(null);
        resetQueryFlag();
      } catch (error) {
        console.error('[WS ERROR] Error parsing WebSocket message:', error);
        if (typeof event.data === 'string') {
          console.error('[WS ERROR] Raw message data:', event.data.substring(0, 500));
        } else if (event.data instanceof ArrayBuffer) {
          console.error(
            '[WS ERROR] Raw message data:',
            `ArrayBuffer data (${event.data.byteLength} bytes)`
          );
        } else if (event.data instanceof Blob) {
          console.error(
            '[WS ERROR] Raw message data:',
            `Blob data (${event.data.size} bytes, type: ${event.data.type})`
          );
        } else {
          console.error('[WS ERROR] Raw message data:', event.data);
        }

        setExistAnnotationFile(false);
        if (annotatorInstanceRef.current) {
          annotatorInstanceRef.current.setAnnotations([], true);
        }
        setCentroids(EMPTY_CENTROIDS);
        dispatch(setAnnotations([]));
        if (viewerInstanceRef.current) {
          viewerInstanceRef.current.viewport.update();
        }
        setLoadingAnnotations(false);
        setIsRequestPending(false);
        setCurrentRequestType(null);
        resetQueryFlag();
      }
    };

    socket.onmessage = handleMessage;

    return () => {
      if (socket.onmessage === handleMessage) {
        socket.onmessage = null;
      }
    };
  }, [socket, dispatch, resetQueryFlag, setCentroids, setCurrentRequestType, setExistAnnotationFile, setIsRequestPending, setLoadingAnnotations]);

  // Helper functions for processing different message types
  const handleNoSegmentationData = useCallback(
    (data: any, isImageFile: boolean) => {
      if (isZarrInitializing) {
        toast('Image is loading, please wait a moment...');
        setLoadingAnnotations(false);
        setIsRequestPending(false);
        setCurrentRequestType(null);
        return;
      }

      // Show specific message based on what user requested
      if (!existAnnotationFile) {
        if (currentRequestType === 'space') {
          toast.warning('Zarr file not found. Please run segmentation workflow first.');
        } else if (currentRequestType === 'x') {
          toast.warning('Zarr file not found. Please run patch classification workflow first.');
        } else if (showBackendAnnotations || showPatches) {
          toast.warning('Zarr file not found. Please run workflow first.');
        } else {
          toast(data.message);
        }
      } else {
        if (currentRequestType === 'space') {
          toast('No cell result');
        } else if (currentRequestType === 'x') {
          toast('No patch result');
        } else if (showBackendAnnotations && !showPatches) {
          toast('No cell result');
        } else if (showPatches) {
          toast('No patch result');
        } else {
          toast(data.message);
        }
      }

      // Clear visual annotations
      if (annotatorInstance) {
        annotatorInstance.setAnnotations([], true);
      }
      dispatch(setAnnotations([]));

      // Clear Zarr initialization timeout
      if (zarrInitTimeoutRef.current) {
        clearTimeout(zarrInitTimeoutRef.current);
        zarrInitTimeoutRef.current = null;
      }

      setLoadingAnnotations(false);
      setIsRequestPending(false);
      setCurrentRequestType(null);
      setExistAnnotationFile(false);
      setCentroids(EMPTY_CENTROIDS);
      dispatch(clearPatchOverlays());
      dispatch(clearPatchOverrides());
    },
    [
      isZarrInitializing,
      existAnnotationFile,
      currentRequestType,
      showBackendAnnotations,
      showPatches,
      annotatorInstance,
      dispatch,
      setCentroids,
      setLoadingAnnotations,
      setIsRequestPending,
      setCurrentRequestType,
      setExistAnnotationFile,
      zarrInitTimeoutRef,
    ]
  );

  const handleZarrLoadedSuccess = useCallback(
    async (data: any) => {
      // set_path acks often omit data_available; missing field means zarr is bound (same as first load)
      const rawAvail = data?.data_available;
      const dataAvailable =
        rawAvail === undefined || rawAvail === null ? true : rawAvail !== false;
      setExistAnnotationFile(!!dataAvailable);
      setIsZarrInitializing(false);
      setLoadingAnnotations(false);
      setIsRequestPending(false);

      // Clear Zarr initialization timeout
      if (zarrInitTimeoutRef.current) {
        clearTimeout(zarrInitTimeoutRef.current);
        zarrInitTimeoutRef.current = null;
      }

      // Emit event to notify that path has been set successfully
      EventBus.emit('websocket-path-set-success', { path: currentPath });

      // Cancel quick fallback when Zarr is confirmed
      if (quickSpaceFallbackTimerRef.current) {
        clearTimeout(quickSpaceFallbackTimerRef.current as unknown as number);
        quickSpaceFallbackTimerRef.current = null;
      }

      // Cancel any outstanding confirm timers
      if (errorConfirmTimersRef.current.space) {
        clearTimeout(errorConfirmTimersRef.current.space as unknown as number);
        errorConfirmTimersRef.current.space = null;
        errorConfirmAttemptsRef.current.space = 0;
      }
      if (errorConfirmTimersRef.current.x) {
        clearTimeout(errorConfirmTimersRef.current.x as unknown as number);
        errorConfirmTimersRef.current.x = null;
        errorConfirmAttemptsRef.current.x = 0;
      }

      // Delegate viewport-based requests to event hook
      if (viewerInstance) {
        viewerInstance.viewport.update();
      }

      await handleLoadClassification();

      // Emit event to signal handler reload is complete
      const pathForEvent = currentPath || lastSentPathRef.current || '';
      EventBus.emit('handler-reload-complete', { path: pathForEvent });
    },
    [
      currentPath,
      viewerInstance,
      handleLoadClassification,
      setExistAnnotationFile,
      setIsZarrInitializing,
      setLoadingAnnotations,
      setIsRequestPending,
      zarrInitTimeoutRef,
      quickSpaceFallbackTimerRef,
      errorConfirmTimersRef,
      errorConfirmAttemptsRef,
      lastSentPathRef,
    ]
  );

  const handleCentroidsMessage = useCallback(
    async (data: any, isImageFile: boolean): Promise<boolean> => {
      let receivedActualData = false;

      if (data.centroids.length > 0) {
        receivedActualData = true;
      } else if (data.centroids.length === 0 && currentRequestType === 'space') {
        toast('No cell result');
      }

      if (!isImageFile) {
        if (data.centroids instanceof CentroidsArray) {
          setCentroids(data.centroids);
        } else if (Array.isArray(data.centroids)) {
          const flatData = new Int32Array(data.centroids.length * 4);
          for (let i = 0; i < data.centroids.length; i++) {
            const point = data.centroids[i];
            const idx = i * 4;
            flatData[idx] = point[0];
            flatData[idx + 1] = point[1];
            flatData[idx + 2] = point[2];
            flatData[idx + 3] = point[3];
          }
          setCentroids(new CentroidsArray(flatData, data.centroids.length));
        } else {
          setCentroids(EMPTY_CENTROIDS);
        }
      }

      // Handle class counts and names
      let counts: Record<string, number> = {};
      let dynamicNames: string[] = [];
      if (data.class_counts_by_id) {
        counts = data.class_counts_by_id;
      }
      if (data.dynamic_class_names || data.class_names) {
        dynamicNames = data.dynamic_class_names || data.class_names;
        const currentNucleiClasses = store.getState().annotations.nucleiClasses;
        const currentClassNames = currentNucleiClasses.map((c) => c.name);

        // Check if we need to add new classes (only add, never remove or reorder)
        // This prevents the "two counting logic fighting" issue where WebSocket 
        // would dispatch with stale counts, overwriting fresh API counts
        const newClassNames = dynamicNames.filter((name: string) => !currentClassNames.includes(name));
        
        if (newClassNames.length > 0) {
          // Only add new classes, preserve existing classes and their counts completely
          const backendColors = data.class_colors || [];
          const backendColorMap = new Map<string, string>();
          dynamicNames.forEach((name: string, idx: number) => {
            backendColorMap.set(name, backendColors[idx] || '#aaaaaa');
          });

          // Start with existing classes (preserving order and counts)
          const mergedClasses = [...currentNucleiClasses];
          
          // Add only the new classes
          newClassNames.forEach((name: string) => {
            const backendColor = backendColorMap.get(name) || '#aaaaaa';
            mergedClasses.push({ name, color: backendColor, count: 0 });
          });

          // Ensure 'Negative control' is first
          const negativeControl = mergedClasses.find((cls) => cls.name === 'Negative control');
          const others = mergedClasses.filter((cls) => cls.name !== 'Negative control');
          const orderedClasses = negativeControl ? [negativeControl, ...others] : mergedClasses;

          console.log('[WS MSG] handleCentroidsMessage => Adding new classes only', {
            newClasses: newClassNames,
            existing: currentNucleiClasses.map(c => ({ name: c.name, count: c.count })),
            result: orderedClasses.map(c => ({ name: c.name, count: c.count })),
          });
          dispatch(setNucleiClasses(orderedClasses));
          
          // Trigger API refresh to get correct counts for the new classes
          EventBus.emit('refresh-annotations');
        } else {
          // No new classes - only update colors if needed (without touching counts)
          const backendColors = data.class_colors || [];
          let needsColorUpdate = false;
          
          const updatedClasses = currentNucleiClasses.map((cls, idx) => {
            const backendIdx = dynamicNames.indexOf(cls.name);
            if (backendIdx >= 0 && backendColors[backendIdx] && backendColors[backendIdx] !== cls.color) {
              // Special case: don't change Negative control color
              if (cls.name === 'Negative control') return cls;
              needsColorUpdate = true;
              return { ...cls, color: backendColors[backendIdx] };
            }
            return cls;
          });
          
          if (needsColorUpdate) {
            console.log('[WS MSG] handleCentroidsMessage => Only updating colors, counts preserved');
            dispatch(setNucleiClasses(updatedClasses));
          }
        }
      }
      // BUG FIX: Don't call updateCountsFromBackend here because:
      // 1. WebSocket may return stale counts (before save_annotation completes)
      // 2. fetchGlobalTotals (API) already updates counts with fresh data
      // 3. This was causing counts to flicker back to old values after save
      // updateCountsFromBackend(counts);  // DISABLED - let API handle counts
      return receivedActualData;
    },
    [currentRequestType, setCentroids, dispatch]
  );

  const handlePatchesMessage = useCallback(
    async (data: any, isImageFile: boolean): Promise<boolean> => {
      let receivedActualData = false;

      console.log('[Patch Overlay] WebSocket patches payload received:', {
        patchCount: Array.isArray(data?.patches) ? data.patches.length : 0,
        firstPatch: Array.isArray(data?.patches) && data.patches.length > 0 ? data.patches[0] : null,
        classCountsById: data?.class_counts_by_id ?? null,
        currentRequestType,
        showPatches,
        isImageFile,
      });

      if (data.patches.length > 0) {
        receivedActualData = true;
      } else if (data.patches.length === 0) {
        if (currentRequestType === 'x' || showPatches) {
          toast('No patch result');
        }
      }

      dispatch(setPatchOverlays(data.patches));
      if (data.class_counts_by_id) {
        await refreshPatchClassificationData();
      }
      return receivedActualData;
    },
    [currentRequestType, showPatches, dispatch, refreshPatchClassificationData]
  );

  const handleAllAnnotationsMessage = useCallback(
    async (data: any, isImageFile: boolean): Promise<boolean> => {
      if (!isImageFile) {
        if (data.all_annotations.length === 0 && currentRequestType === 'space') {
          toast('No cell result');
        }
        setRenderingAnnotations(data.all_annotations);
        // BUG FIX: Don't update counts from WebSocket - let API handle it
        // WebSocket may return stale counts, causing flicker after save
        // if (data.class_counts_by_id) {
        //   updateCountsFromBackend(data.class_counts_by_id);
        // }
      }
      return data.all_annotations.length > 0;
    },
    [currentRequestType, setRenderingAnnotations]
  );

  const handleAnnotationsMessage = useCallback(
    async (data: any, isImageFile: boolean): Promise<boolean> => {
      let receivedActualData = false;

      if (data.annotations.length > 0) {
        receivedActualData = true;
      } else if (data.annotations.length === 0 && currentRequestType === 'space' && showBackendAnnotations) {
        toast('No cell result');
      }

      if (showBackendAnnotations) {
        annotationsCounter.current.received += data.annotations.length;
        annotationsCounter.current.lastTimestamp = Date.now();
        const backendAnnotations = data.annotations.map((annotation: any) => ({
          ...annotation,
          isBackend: true,
        }));

        dispatch(setAnnotations(backendAnnotations));
        setRenderingAnnotations(backendAnnotations);
      }

      // BUG FIX: Don't update counts from WebSocket - let API handle it
      // WebSocket may return stale counts, causing flicker after save
      // if (data.class_counts_by_id) {
      //   updateCountsFromBackend(data.class_counts_by_id);
      // }

      // Handle centroids if they are part of an 'annotations' message (for image files)
      if (isImageFile && data.centroids_for_image) {
        if (data.centroids_for_image instanceof CentroidsArray) {
          setCentroids(data.centroids_for_image);
        } else if (Array.isArray(data.centroids_for_image)) {
          const flatData = new Int32Array(data.centroids_for_image.length * 4);
          for (let i = 0; i < data.centroids_for_image.length; i++) {
            const point = data.centroids_for_image[i];
            const idx = i * 4;
            flatData[idx] = point[0];
            flatData[idx + 1] = point[1];
            flatData[idx + 2] = point[2];
            flatData[idx + 3] = point[3];
          }
          setCentroids(new CentroidsArray(flatData, data.centroids_for_image.length));
        }
        if (data.centroids_for_image.length > 0) {
          receivedActualData = true;
        } else if (data.centroids_for_image.length === 0 && currentRequestType === 'space') {
          toast('No cell result');
        }
      }

      return receivedActualData;
    },
    [
      showBackendAnnotations,
      currentRequestType,
      annotatorInstance,
      dispatch,
      setRenderingAnnotations,
      setCentroids,
      annotationsCounter,
    ]
  );

  const handleOtherMessages = useCallback(
    (data: any, isImageFile: boolean) => {
      if (data.status === 'error' && (data.error_type === 'FileNotFoundError' || data.error_type === 'NoDataError')) {
        if (isZarrInitializing) {
          toast('Image is loading, please wait a moment...');
          setCurrentRequestType(null);
          setIsRequestPending(false);
          return;
        }

        if (!existAnnotationFile) {
          if (currentRequestType === 'space') {
            toast.warning('Zarr file not found. Please run segmentation workflow first.');
          } else if (currentRequestType === 'x') {
            toast.warning('Zarr file not found. Please run patch classification workflow first.');
          } else {
            setIsZarrInitializing(false);
          }
          setCurrentRequestType(null);
          setIsRequestPending(false);
        } else {
          if (currentRequestType === 'space') {
            toast('No cell result');
          } else if (currentRequestType === 'x') {
            toast('No patch result');
          } else {
            setIsZarrInitializing(false);
          }
          setCurrentRequestType(null);
          setIsRequestPending(false);
        }

        if (zarrInitTimeoutRef.current) {
          clearTimeout(zarrInitTimeoutRef.current);
          zarrInitTimeoutRef.current = null;
        }
      } else if (data.status === 'error') {
        if (isZarrInitializing) {
          toast('Image is loading, please wait a moment...');
          setCurrentRequestType(null);
          setIsRequestPending(false);
          return;
        }

        if (!existAnnotationFile) {
          if (currentRequestType === 'space') {
            toast.warning('Zarr file not found. Please run segmentation workflow first.');
          } else if (currentRequestType === 'x') {
            toast.warning('Zarr file not found. Please run patch classification workflow first.');
          } else {
            setIsZarrInitializing(false);
          }
          setCurrentRequestType(null);
          setIsRequestPending(false);
        } else {
          if (currentRequestType === 'space') {
            toast('No cell result');
          } else if (currentRequestType === 'x') {
            toast('No patch result');
          } else {
            setIsZarrInitializing(false);
          }
          setCurrentRequestType(null);
          setIsRequestPending(false);
        }

        if (zarrInitTimeoutRef.current) {
          clearTimeout(zarrInitTimeoutRef.current);
          zarrInitTimeoutRef.current = null;
        }
      } else if (data.status === 'warning') {
        if (!isZarrInitializing) {
          toast.warning(data.message || 'Warning from server');
        }
      } else if (data.status === 'info' && data.message) {
        if (isZarrInitializing && (currentRequestType === 'space' || currentRequestType === 'x')) {
          toast('Image is loading, please wait a moment...');
        } else if (!isZarrInitializing) {
          toast(data.message);
        }
      } else if (data.status === 'success' && data.message) {
        toast.success(data.message);
        setCurrentRequestType(null);
      }
    },
    [
      isZarrInitializing,
      existAnnotationFile,
      currentRequestType,
      setCurrentRequestType,
      setIsRequestPending,
      setIsZarrInitializing,
      zarrInitTimeoutRef,
    ]
  );
};
