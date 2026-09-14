import { useEffect, useRef, useCallback, type Dispatch, type SetStateAction } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch, store } from '@/store';
import { toast } from 'sonner';
import { decompressZstd } from '@/utils/common/compression.utils';
import { CentroidsArray } from '@/types/centroidsArray';
import { parseOverlayFrame } from '@/utils/viewer/binaryParsers';
import {
  setNucleiClasses,
  type PatchOverlayEntry,
} from '@/store/slices/viewer/annotationSlice';
import { applyIncomingNucleiClasses } from '@/utils/annotations/nucleiClassList';
import eventBus from '@/utils/common/eventBus';
import {
  resolveMissingOverlayNotify,
  hasOverlayPending,
  EMPTY_OVERLAY_PENDING,
  type OverlayPendingRequest,
} from '@/utils/viewer/overlayRequestNotify';
import { applyCentroidFrame, applyContourFrame, shouldPaintContours } from '@/utils/viewer/overlayApply';
import type { ContourAnnotation } from '@/utils/viewer/viewportContourCache';
import {
  forgetContourPaint,
  resolveContourPaint,
  tryHitViewportContourCache,
} from '@/utils/viewer/viewportContourCache';
import { getVisibleImageCoordinates } from '@/utils/viewer/overlayCoords';
import {
  cellWireTypeOf,
  isStaticImagePath,
  settleKindForMessage,
  type SettleKind,
} from '@/utils/viewer/overlaySession';
import { workflowZarrPathsMatch } from '@/utils/agent/workflow/pathNorm';
// Empty CentroidsArray constant for reuse
const EMPTY_CENTROIDS = new CentroidsArray(new Int32Array(0), 0);
const EMPTY_PATCHES: PatchOverlayEntry[] = [];

type ViewportPayloadResult = {
  /** false when the frame was dropped as stale (path not ready). */
  applied: boolean;
  /** true when the payload contained at least one overlay item. */
  hasData: boolean;
};

interface UseWebSocketMessageHandlerParams {
  socket: WebSocket | null;
  viewerInstance: any;
  currentPath: string | null;
  /** Paint gates — updated synchronously on nuclei/patches/filter toggle before React commit. */
  showBackendAnnotationsRef: React.MutableRefObject<boolean>;
  showPatchesRef: React.MutableRefObject<boolean>;
  filterToolRef: React.MutableRefObject<boolean>;
  setCentroids: (centroids: CentroidsArray) => void;
  setRenderingAnnotations: (annotations: any[]) => void;
  setPatches: Dispatch<SetStateAction<PatchOverlayEntry[]>>;
  setExistAnnotationFile: (exists: boolean) => void;
  setPendingRequest: React.Dispatch<React.SetStateAction<OverlayPendingRequest>>;
  /** Backend acked the bind; the gate stays shut until the caches rebuild. */
  onBindAcked: () => void;
  /** Bind failed / no data; opens the gate so late frames are not lost. */
  onBindFailed: () => void;
  /** Handler is serving this slide: rebuild the overlay and open the gate. */
  onHandlerReady: () => void;
  refreshPatchClassificationData: () => Promise<void>;
  handleLoadClassification: () => Promise<boolean>;
  settleOverlay: (
    kind: SettleKind,
    opts: { applied: boolean },
  ) => void;
  /**
   * Wire/reconnect/no-seg fault: abandon open cell reply + clear open flights.
   */
  faultOverlay: (opts?: { retry?: boolean }) => void;
  /**
   * After reset while a cell request was in flight — drop that many cell
   * replies without paint/dequeue/settle. Kind-scoped so types don't cross-steal.
   */
  takeAbandonedCellReply?: (
    kind: 'centroids' | 'all_annotations' | 'annotations',
  ) => boolean;
  /** When false, unexpected patches frames must not mark ready. */
  isPatchesFlying?: () => boolean;
  /** When false, no binary viewport reply can belong to this viewer. */
  expectsWireFrame?: () => boolean;
  instanceId?: string | null;
  // Refs
  hasherRef: React.MutableRefObject<any>;
  lastHashRef: React.MutableRefObject<string | null>;
  annotationsCounter: React.MutableRefObject<{
    received: number;
    total: number;
    lastTimestamp: number;
  }>;
  existAnnotationFile: boolean;
  isZarrInitializing: boolean;
  pendingRequest: OverlayPendingRequest;
  lastSentPathRef: React.MutableRefObject<string | null>;
  pathReadyForDataRef?: React.MutableRefObject<boolean>;
}

/**
 * Hook to handle WebSocket message processing for the viewer
 * Extracted from OpenSeadragonContainer to improve code organization
 */
export const useWebSocketMessageHandler = (params: UseWebSocketMessageHandlerParams) => {
  const dispatch = useDispatch<AppDispatch>();
  const {
    socket,
    viewerInstance,
    currentPath,
    showBackendAnnotationsRef: showBackendRef,
    showPatchesRef: showPatchesGateRef,
    filterToolRef,
    setCentroids,
    setRenderingAnnotations,
    setPatches,
    setExistAnnotationFile,
    setPendingRequest,
    onBindAcked,
    onBindFailed,
    onHandlerReady,
    refreshPatchClassificationData,
    handleLoadClassification,
    settleOverlay,
    faultOverlay,
    takeAbandonedCellReply,
    isPatchesFlying,
    expectsWireFrame,
    instanceId,
    hasherRef,
    lastHashRef,
    annotationsCounter,
    existAnnotationFile,
    isZarrInitializing,
    pendingRequest,
    lastSentPathRef,
    pathReadyForDataRef,
  } = params;
  const viewerInstanceRef = useRef(viewerInstance);
  const pendingRequestRef = useRef(pendingRequest);
  const existAnnotationFileRef = useRef(existAnnotationFile);
  const instanceIdRef = useRef(instanceId);
  const settleOverlayRef = useRef(settleOverlay);
  const faultOverlayRef = useRef(faultOverlay);
  const takeAbandonedCellReplyRef = useRef(takeAbandonedCellReply);
  const isPatchesFlyingRef = useRef(isPatchesFlying);
  const onBindFailedRef = useRef(onBindFailed);
  const expectsWireFrameRef = useRef(expectsWireFrame);
  /** Guard against NoDataError → set_path rebound loops. */
  const noDataReboundRef = useRef(false);
  const processWebSocketMessageRef = useRef<
    (data: any) => Promise<ViewportPayloadResult | null>
  >(async () => null);

  viewerInstanceRef.current = viewerInstance;
  pendingRequestRef.current = pendingRequest;
  existAnnotationFileRef.current = existAnnotationFile;
  instanceIdRef.current = instanceId;
  settleOverlayRef.current = settleOverlay;
  faultOverlayRef.current = faultOverlay;
  takeAbandonedCellReplyRef.current = takeAbandonedCellReply;
  isPatchesFlyingRef.current = isPatchesFlying;
  onBindFailedRef.current = onBindFailed;
  expectsWireFrameRef.current = expectsWireFrame;

  // Process different types of WebSocket messages
  const processWebSocketMessage = useCallback(
    async (data: any): Promise<ViewportPayloadResult | null> => {
      const isImageFile = isStaticImagePath(currentPath);

      // Any set_path success ack ("Path set successfully" / "Path already set").
      if (data.status === 'success' && data.type === 'set_path') {
        await handleZarrLoadedSuccess(data);
        return null;
      }

      if (data.status === 'info') {
        return null;
      }

      // Handle standalone success messages
      if (data.status === 'success') {
        if (viewerInstance) {
          viewerInstance.viewport.update();
        }
        return null;
      }

      let viewportResult: ViewportPayloadResult | null = null;

      // Handle centroids
      if (data.type === 'centroids' && (Array.isArray(data.centroids) || data.centroids instanceof CentroidsArray)) {
        // Late reply after reset — do not paint/settle (new flight owns settle).
        if (takeAbandonedCellReplyRef.current?.('centroids')) {
          viewportResult = null;
        } else {
          viewportResult = await handleCentroidsMessage(data, isImageFile);
        }
      }
      // Handle patches
      else if (data.type === 'patches' && Array.isArray(data.patches)) {
        if (!isPatchesFlyingRef.current?.()) {
          viewportResult = null;
        } else {
          viewportResult = await handlePatchesMessage(data, isImageFile);
        }
      }
      // Handle cell overlays (contours LOD + nuclei high-zoom annotations)
      else if (
        (data.type === 'all_annotations' && Array.isArray(data.all_annotations)) ||
        (data.type === 'annotations' && Array.isArray(data.annotations))
      ) {
        const abandonKind =
          data.type === 'all_annotations' ? 'all_annotations' : 'annotations';
        if (takeAbandonedCellReplyRef.current?.(abandonKind)) {
          // Skip applyContourFrame entirely so FIFO stays aligned with the new request.
          viewportResult = null;
        } else {
          viewportResult = await handleCellOverlayMessage(data, isImageFile);
        }
      }
      // Handle errors and other messages
      else {
        handleOtherMessages(data, isImageFile);
      }

        if (viewportResult) {
        if (viewportResult.hasData) {
          setExistAnnotationFile(true);
        }
        // Applied frames (empty or not) settle nuclei/patches; stale drops keep pending.
        setPendingRequest((prev) => {
          if (!viewportResult.applied) return prev;
          const kind = settleKindForMessage(data);
          if (kind === 'cell') return { ...prev, nuclei: false };
          if (kind === 'patches') return { ...prev, patches: false };
          return prev;
        });
      }
      return viewportResult;
    },
    [
      currentPath,
      viewerInstance,
      dispatch,
      setCentroids,
      setRenderingAnnotations,
      setPatches,
      setExistAnnotationFile,
      setPendingRequest,
      onBindAcked,
      onBindFailed,
      onHandlerReady,
      refreshPatchClassificationData,
      handleLoadClassification,
      isZarrInitializing,
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

    // Serialize handlers — decompress/process are async; overlapping onmessage
    // races settle/catch-up and contour FIFO.
    let messageChain: Promise<void> = Promise.resolve();

    const handleMessage = (event: MessageEvent) => {
      messageChain = messageChain.then(() => processMessage(event)).catch((error) => {
        console.error('[WS ERROR] Unhandled message chain error:', error);
      });
    };

    const processMessage = async (event: MessageEvent) => {
      try {
        if (event.data === 'pong') {
          return;
        }

        let data: any;
        const isBlob =
          event.data instanceof Blob ||
          (!!event.data &&
            typeof event.data === 'object' &&
            typeof event.data.arrayBuffer === 'function');
        const isArrayBuffer = event.data instanceof ArrayBuffer;

        if (isArrayBuffer || isBlob) {
          // Binary frames are always viewport replies. Every viewer now sees
          // every frame on the shared socket, so skip the decompress unless this
          // viewer is actually waiting for one.
          if (expectsWireFrameRef.current && !expectsWireFrameRef.current()) {
            return;
          }
          let arrayBuffer: ArrayBuffer;
          if (isBlob) {
            // Fallback only. This await resumes when the main thread is next
            // free, so under load a frame waited hundreds of ms here before a
            // single byte was decompressed. The socket asks for 'arraybuffer'
            // (see WsProvider), which skips the hop; reaching this branch means
            // some other socket is still handing us Blobs.
            arrayBuffer = await event.data.arrayBuffer();
          } else {
            arrayBuffer = event.data;
          }

          try {
            const decompressed = await decompressZstd(arrayBuffer);
            // Overlay frames are self-describing; anything else is compressed JSON.
            data =
              parseOverlayFrame(decompressed) ??
              JSON.parse(new TextDecoder().decode(decompressed));
          } catch (error) {
            console.error('[WS COMPRESSED] Failed to decompress/parse data:', error);
            // Abandon open cell flight — do not wipe FIFO then race a retry enqueue.
            faultOverlayRef.current({ retry: true });
            return;
          }
        } else {
          try {
            data = JSON.parse(event.data);
          } catch (error) {
            console.error('[WS ERROR] Failed to parse JSON data:', error);
            faultOverlayRef.current({ retry: true });
            return;
          }
        }

        // Shared socket: every viewer sees every frame. Drop the ones owned by
        // another viewer — otherwise they paint foreign cells and settle the
        // wrong flight. Frames with no routing field come from an older backend;
        // keep the legacy "process everything" behaviour for those.
        const frameInstance =
          typeof data?.instance_id === 'string' ? data.instance_id : '';
        if (
          frameInstance &&
          instanceIdRef.current &&
          frameInstance !== instanceIdRef.current
        ) {
          return;
        }

        // Backend could not answer this request (handler rebound mid-flight, or
        // the send itself failed). Settle as "not applied" so the spinner clears
        // and the hub re-requests the live viewport instead of waiting forever.
        if (data?.status === 'dropped') {
          // A drop is still the answer to a request. If that request had already
          // been abandoned (reset / LOD switch), the ledger is owed THIS message
          // and nothing else will ever pay it: `sendPayload` holds every later
          // cell send while the debt stands, so the layer stops updating with no
          // flight open and no error anywhere. Consume it here, exactly like the
          // frame path does, instead of settling a newer flight that is still out.
          const abandonKind = cellWireTypeOf(data);
          if (abandonKind && takeAbandonedCellReplyRef.current?.(abandonKind)) {
            return;
          }
          const droppedKind = settleKindForMessage(data);
          if (droppedKind) {
            settleOverlayRef.current(droppedKind, { applied: false });
          }
          return;
        }

        // Hash only after a settled apply. Abandoned / path-gated drops return null
        // without settle — recording the hash first let an identical follow-up skip
        // settle and wedge cellFlight forever (NuClass reload + 50x zoom-out).
        let payloadHash: string | null = null;
        if (typeof event.data === 'string' && event.data.length > 1000 && hasherRef.current) {
          payloadHash = hasherRef.current.h64(event.data);
          if (payloadHash === lastHashRef.current) {
            // Duplicate of an already-settled payload. First copy owns settle.
            return;
          }
        }

        const viewportResult = await processWebSocketMessageRef.current(data);

        // Only settle overlay flights for real viewport payloads (or hard errors).
        // Do not clear loading on info/success — that raced mid-flight requests.
        if (viewportResult != null) {
          if (payloadHash != null) {
            lastHashRef.current = payloadHash;
          }
          const kind = settleKindForMessage(data);
          if (kind) {
            settleOverlayRef.current(kind, {
              applied: viewportResult.applied,
            });
          }
        } else if (data?.status === 'error') {
          // NoDataError rebind already closed pathReady + queued set_path.
          // Do not reopen the gate or fault-wipe mid-rebind.
          const rebinding =
            data.error_type === 'NoDataError' && noDataReboundRef.current;
          if (!rebinding) {
            onBindFailedRef.current();
            // `retry: true`: a failed viewport request is the end of the road
            // otherwise — the fault clears the flight, and with `pendingRequest`
            // already emptied by the reload nothing toasts either, so the layer
            // silently stops updating. The reducer's own fault budget
            // (MAX_FAULT_RETRIES, cleared by any applied frame) is what keeps a
            // backend that errors on everything from looping.
            faultOverlayRef.current({ retry: true });
          }
        }
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
        // Same contract as the centroid LOD: this blanks the cell overlay, so
        // the contour paint record must not keep claiming coverage for it.
        // Instance-wide: this handler's effect does not depend on currentPath, so
        // a path argument here could be a stale one and would forget the wrong key.
        if (typeof instanceIdRef.current === 'string' && instanceIdRef.current) {
          forgetContourPaint(instanceIdRef.current);
        }
        setCentroids(EMPTY_CENTROIDS);
        setRenderingAnnotations([]);
        setPatches(EMPTY_PATCHES);
        if (viewerInstanceRef.current) {
          viewerInstanceRef.current.viewport.update();
        }
        setPendingRequest(EMPTY_OVERLAY_PENDING);
        faultOverlayRef.current();
      }
    };

    // Every open viewer shares one segmentation socket, and `onmessage` is a
    // single slot: the last mounted viewer used to steal delivery from all the
    // others (their overlay requests then never settled — spinner forever), and
    // its unmount cleared the slot so nobody received anything at all.
    socket.addEventListener('message', handleMessage);

    return () => {
      socket.removeEventListener('message', handleMessage);
    };
  }, [socket, setCentroids, setRenderingAnnotations, setPendingRequest, setExistAnnotationFile, pathReadyForDataRef, hasherRef, lastHashRef]);

  // Helper functions for processing different message types
  const notifyMissingOverlayData = useCallback(
    (existAnnotationFileOverride?: boolean) => {
      const pending = pendingRequestRef.current;
      const existFile =
        existAnnotationFileOverride !== undefined
          ? existAnnotationFileOverride
          : existAnnotationFileRef.current;
      const notifyToast = resolveMissingOverlayNotify({
        pendingRequest: pending,
        existAnnotationFile: existFile,
      });
      if (notifyToast?.level === 'warning') {
        toast.warning(notifyToast.message);
      } else if (notifyToast) {
        toast(notifyToast.message);
      }
      setPendingRequest(EMPTY_OVERLAY_PENDING);
    },
    [setPendingRequest]
  );

  const handleZarrLoadedSuccess = useCallback(
    async (data: any) => {
      // Late set_path ack from another instance or a previous slide must not
      // reopen the overlay gate or emit handler-reload-complete.
      const ackInstance = typeof data?.instance_id === 'string' ? data.instance_id : '';
      if (ackInstance && instanceIdRef.current && ackInstance !== instanceIdRef.current) {
        return;
      }
      const ackPath = typeof data?.path === 'string' ? data.path : '';
      const expectedPath = lastSentPathRef.current || currentPath;
      if (
        ackPath &&
        expectedPath &&
        ackPath !== expectedPath &&
        !workflowZarrPathsMatch(ackPath, expectedPath)
      ) {
        return;
      }
      // set_path acks often omit data_available; missing field means zarr is bound (same as first load)
      const rawAvail = data?.data_available;
      const dataAvailable =
        rawAvail === undefined || rawAvail === null ? true : rawAvail !== false;
      setExistAnnotationFile(!!dataAvailable);
      noDataReboundRef.current = false;
      // Enters `rebuilding`: cancels the no-ack deadline but keeps the gate shut
      // until handler-reload-complete rebuilds the caches. Opening it here raced
      // classificationEnabled + forceSync.
      onBindAcked();

      // Emit event to notify that path has been set successfully
      eventBus.emit('websocket-path-set-success', { path: currentPath });

      // Delegate viewport-based requests to event hook
      if (viewerInstance) {
        viewerInstance.viewport.update();
      }

      // Rebuild this viewer's overlay for the freshly bound handler and open the
      // wire gate. Direct call, not an eventBus round-trip: the old path bounced
      // through a global event and a requestAnimationFrame, so recovery hung on
      // frame scheduling and on a path/instance guard that could silently drop it.
      onHandlerReady();

      // Classifications are an HTTP round-trip that lands right when the tile
      // burst for the new slide is saturating the backend. Awaiting it here held
      // the first annotation request for ~0.5 s of visible "nothing happening".
      // It only feeds `use_classification`; the frame carries its own class names
      // and colors, and the session's classificationEnabled effect re-syncs if the
      // flag actually flips.
      void handleLoadClassification().catch((error) => {
        console.warn('[Classification] load failed after bind', error);
      });

      // Still broadcast for other panels (workflow classification waits on this).
      const pathForEvent = currentPath || lastSentPathRef.current || '';
      eventBus.emit('handler-reload-complete', {
        path: pathForEvent,
        instanceId: instanceIdRef.current ?? data?.instance_id ?? undefined,
      });
    },
    [
      currentPath,
      viewerInstance,
      handleLoadClassification,
      setExistAnnotationFile,
      onBindAcked,
      onBindFailed,
      onHandlerReady,
      lastSentPathRef,
      pathReadyForDataRef,
    ]
  );

  const handleCentroidsMessage = useCallback(
    async (data: any, isImageFile: boolean): Promise<ViewportPayloadResult | null> => {
      // Drop messages that arrive before the new set_path ack / reload rebuild.
      // Return null (no settle) — applied:false would clear a newer cellFlight and
      // request resync while the gate is still closed (NuClass refresh wedge).
      if (pathReadyForDataRef && !pathReadyForDataRef.current) {
        return null;
      }

      // Empty viewport is normal (pan/zoom) — never toast here.
      const hasData = data.centroids.length > 0;

      let centroidsForView: CentroidsArray = EMPTY_CENTROIDS;
      if (!isImageFile) {
        centroidsForView = CentroidsArray.fromPoints(data.centroids);

        // Upsert spatial cache + LOD paint gate
        const iid = typeof instanceId === 'string' ? instanceId : '';
        const pathKey = currentPath || '';
        if (iid && pathKey) {
          const liveZoom =
            typeof viewerInstanceRef.current?.viewport?.getZoom === 'function'
              ? viewerInstanceRef.current.viewport.getZoom()
              : null;
          const centroidThreshold = store.getState().viewerSettings.centroidThreshold;
          const applied = applyCentroidFrame({
            instanceId: iid,
            path: pathKey,
            data: centroidsForView,
            liveZoom,
            centroidThreshold,
          });
          centroidsForView = applied.data;
          // Still cache; only paint when nuclei/filter still wants cell overlay.
          if (applied.paint && (showBackendRef.current || filterToolRef.current)) {
            // The centroid LOD wipes the cell overlay, so the contour paint
            // record no longer describes the canvas. Leaving it makes the next
            // zoom back in hit `prev.source === data` over the old coverage box
            // and skip the repaint — the cells never come back.
            forgetContourPaint(iid, pathKey);
            setRenderingAnnotations([]);
            setCentroids(centroidsForView);
          }
        } else if (showBackendRef.current || filterToolRef.current) {
          forgetContourPaint(
            typeof instanceId === 'string' ? instanceId : '',
            currentPath || '',
          );
          setRenderingAnnotations([]);
          setCentroids(centroidsForView);
        }
      }

      // Nuclei class taxonomy. Counts ride along on the frame but are ignored:
      // WS counts can predate an in-flight save, and fetchGlobalTotals owns them.
      if (data.dynamic_class_names || data.class_names) {
        const dynamicNames: string[] = data.dynamic_class_names || data.class_names;
        const currentNucleiClasses = store.getState().annotations.nucleiClasses;
        const backendColors = data.class_colors || [];
        const nextClasses = applyIncomingNucleiClasses({
          incomingNames: dynamicNames,
          incomingColors: backendColors,
          current: currentNucleiClasses,
          mergeMode: "ws",
        });
        const namesChanged =
          nextClasses.length !== currentNucleiClasses.length ||
          nextClasses.some((cls, idx) => cls.name !== currentNucleiClasses[idx]?.name);
        const colorsChanged = nextClasses.some(
          (cls, idx) => cls.color !== currentNucleiClasses[idx]?.color,
        );
        if (namesChanged || colorsChanged) {
          dispatch(setNucleiClasses(nextClasses));
          if (namesChanged) {
            eventBus.emit('refresh-annotations');
          }
        }
      }
      return { applied: true, hasData };
    },
    [setCentroids, setRenderingAnnotations, dispatch, pathReadyForDataRef, instanceId, currentPath],
  );

  const handlePatchesMessage = useCallback(
    async (data: any, _isImageFile: boolean): Promise<ViewportPayloadResult> => {
      const pathReady = !pathReadyForDataRef || pathReadyForDataRef.current;
      const patches = (Array.isArray(data.patches) ? data.patches : []) as PatchOverlayEntry[];
      const hasData = patches.length > 0;
      if (!pathReady || !showPatchesGateRef.current) {
        return { applied: false, hasData };
      }
      setPatches(patches);
      if (data.class_counts_by_id) {
        await refreshPatchClassificationData();
      }
      return { applied: true, hasData };
    },
    [refreshPatchClassificationData, pathReadyForDataRef, setPatches]
  );

  const handleCellOverlayMessage = useCallback(
    async (data: any, isImageFile: boolean): Promise<ViewportPayloadResult | null> => {
      const isContourLod = data.type === 'all_annotations';
      const raw = (
        isContourLod ? data.all_annotations : data.annotations
      ) as ContourAnnotation[];

      if (pathReadyForDataRef && !pathReadyForDataRef.current) {
        // No settle while gated. Do not dequeue — abandon/reset already balanced FIFO.
        return null;
      }

      let hasData = raw.length > 0;

      if (isContourLod) {
        const liveZoom =
          typeof viewerInstanceRef.current?.viewport?.getZoom === 'function'
            ? viewerInstanceRef.current.viewport.getZoom()
            : null;
        const centroidThreshold = store.getState().viewerSettings.centroidThreshold;
        const iid = typeof instanceId === 'string' ? instanceId : '';
        const pathKey = currentPath || '';

        let annotations = raw;
        let paint = shouldPaintContours(liveZoom, centroidThreshold, isImageFile);
        if (iid && pathKey) {
          const applied = applyContourFrame({
            instanceId: iid,
            path: pathKey,
            data: raw,
            liveZoom,
            centroidThreshold,
            isImageFile,
            merge: true,
          });
          annotations = applied.data;
          paint = applied.paint;
        }

        if (paint && (showBackendRef.current || filterToolRef.current)) {
          if (!isImageFile) {
            // Prefer a cache entry that covers the *live* viewport. If the user
            // panned during flight, live may sit outside this reply's request
            // AABB — still paint the merged cache (image-space) so we don't
            // blank the overlay; catch-up will fill the newly exposed margin.
            const live = getVisibleImageCoordinates(viewerInstanceRef.current)?.image;
            const hit =
              iid && pathKey && live
                ? tryHitViewportContourCache(iid, pathKey, live)
                : null;
            const merged = hit ?? annotations;
            // Same policy as the session hook's paint effect — and, critically,
            // the same record. Filtering here without recording the result left
            // that record describing a wider coverage than the canvas actually
            // held, so the next viewport change skipped a repaint it needed and
            // cells that scrolled into view were never drawn.
            const resolved = resolveContourPaint({
              instanceId: iid,
              path: pathKey,
              data: merged,
              viewport: live ?? null,
            });
            setCentroids(EMPTY_CENTROIDS);
            if (!resolved.skip) setRenderingAnnotations(resolved.toPaint);
          } else {
            // Static images skip the viewport cache; paint the frame directly —
            // so nothing here matches the contour record.
            forgetContourPaint(iid, pathKey);
            setCentroids(EMPTY_CENTROIDS);
            setRenderingAnnotations(annotations);
          }
        }
      } else if (showBackendRef.current) {
        const liveZoom =
          typeof viewerInstanceRef.current?.viewport?.getZoom === 'function'
            ? viewerInstanceRef.current.viewport.getZoom()
            : null;
        const { threshold } = store.getState().annotations;
        // annotations are explicit high-zoom only — don't paint a late frame after LOD drop.
        const paintAnnotations =
          isImageFile || (typeof liveZoom === 'number' && liveZoom >= threshold);
        if (paintAnnotations) {
          annotationsCounter.current.received += raw.length;
          annotationsCounter.current.lastTimestamp = Date.now();
          // High-zoom nuclei are a different LOD: an unfiltered set for a tiny
          // window, which the contour record cannot describe. Drop the record,
          // or on the way back down — when zoom crosses `threshold` and the LOD
          // flips to contours — the paint guard reads a record left over from a
          // low-zoom contour paint, finds the new wide viewport inside that old
          // coverage, and skips the very repaint that was needed. The canvas
          // then keeps this tiny high-zoom set while the view shows far more.
          forgetContourPaint(
            typeof instanceId === 'string' ? instanceId : '',
            currentPath || '',
          );
          setCentroids(EMPTY_CENTROIDS);
          // OSD overlay only — never push backend cells into Annotorious.
          setRenderingAnnotations(raw);
        }
      }

      return { applied: true, hasData };
    },
    [
      setRenderingAnnotations,
      setCentroids,
      annotationsCounter,
      pathReadyForDataRef,
      instanceId,
      currentPath,
    ],
  );

  const handleOtherMessages = useCallback(
    (data: any, _isImageFile: boolean) => {
      if (data.status === 'error' && (data.error_type === 'FileNotFoundError' || data.error_type === 'NoDataError')) {
        const isZarrMissing = data.error_type === 'FileNotFoundError';

        // A definitive outcome for the bind — stop pretending we are still loading.
        if (isZarrMissing) {
          setExistAnnotationFile(false);
        }
        onBindFailed();

        // Empty patches/annotations now ack with empty arrays, so NoDataError here is
        // a real missing-layer / missing-zarr outcome for the active nuclei/patches intent.
        if (hasOverlayPending(pendingRequestRef.current)) {
          notifyMissingOverlayData(isZarrMissing ? false : undefined);
        } else {
        }

        // Handler may have been idle-swept or lost after backend restart — rebind once.
        if (
          data.error_type === 'NoDataError' &&
          currentPath &&
          !isZarrMissing &&
          !noDataReboundRef.current
        ) {
          noDataReboundRef.current = true;
          console.warn('[WebSocket] NoDataError — rebinding set_path for', currentPath);
          eventBus.emit('refresh-websocket-path', {
            path: currentPath,
            forceReload: true,
          });
          window.setTimeout(() => {
            noDataReboundRef.current = false;
          }, 15000);
        }
      } else if (data.status === 'error') {
        onBindFailed();

        // Generic errors keep their own message — never remap to No cell/patch result.
        if (hasOverlayPending(pendingRequestRef.current)) {
          toast.error(data.message || 'Request failed');
          setPendingRequest(EMPTY_OVERLAY_PENDING);
        }
      } else if (data.status === 'warning') {
        if (!isZarrInitializing) {
          toast.warning(data.message || 'Warning from server');
        }
      }
      // info/success are handled earlier in processWebSocketMessage
    },
    [
      isZarrInitializing,
      notifyMissingOverlayData,
      setPendingRequest,
      onBindAcked,
      onBindFailed,
      onHandlerReady,
      setExistAnnotationFile,
      currentPath,
    ]
  );
};
