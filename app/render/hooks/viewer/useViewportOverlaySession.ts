import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '@/store';
import { setCurrentViewerCoordinates } from '@/store/slices/viewer/viewerSlice';
import { CentroidsArray } from '@/types/centroidsArray';
import { requireSegInstanceId } from '@/utils/viewer/segWs';
import { useInstanceSlidePath } from '@/utils/viewer/slidePath';
import type { PatchOverlayEntry } from '@/store/slices/viewer/annotationSlice';
import {
  getVisibleImageCoordinates,
  getFullImageAabb,
  isViewportAnimating,
} from '@/utils/viewer/overlayCoords';
import {
  canSendIdlePayload,
  createOverlayState,
  isStaticImagePath,
  overlayIntentForNuclei,
  reduceOverlay,
  type NetworkPayload,
  type OverlayEffect,
  type OverlayEvent,
  type OverlayIntent,
  type OverlayState,
  type SettleKind,
} from '@/utils/viewer/overlaySession';
import { clearViewportOverlayCaches } from '@/utils/viewer/viewportOverlayCaches';
import {
  coordKeyOf,
  expandAabb,
  getCachedCentroids,
} from '@/utils/viewer/viewportGeometryCache';
import {
  enqueueContourRequest,
  dequeueContourRequest,
  forgetContourPaint,
  resolveContourPaint,
  tryHitViewportContourCache,
} from '@/utils/viewer/viewportContourCache';
import { hasViewerCoordinateConsumers } from '@/utils/viewer/viewerCoordinateFeed';
import {
  EMPTY_OVERLAY_PENDING,
  type OverlayPendingRequest,
} from '@/utils/viewer/overlayRequestNotify';

const EMPTY_CENTROIDS = new CentroidsArray(new Int32Array(0), 0);
const EMPTY_PATCHES: PatchOverlayEntry[] = [];
const CONTOUR_PREFETCH_RATIO = 0.1;
/**
 * Coalesce idle contour sends while zoom/pan springs run.
 * Single-flight already caps wire rate to ~1/RTT; this only limits how soon
 * the *next* coalesced payload may leave after pending is armed. 50ms (~20Hz)
 * feels snappy on slow pans without returning to the every-other-rAF storm.
 */
const IDLE_NET_THROTTLE_MS = 50;
/** Watchdog for a viewport request that never gets answered. */
const OVERLAY_FLIGHT_TIMEOUT_MS = 30_000;

export type UseViewportOverlaySessionParams = {
  viewerInstance: any;
  socket: WebSocket | null;
  instanceId: string | null | undefined;
  updateCentroids: (centroids: CentroidsArray) => void;
  updateRenderingAnnotations: (annotations: any[]) => void;
  setPatches: Dispatch<SetStateAction<PatchOverlayEntry[]>>;
  /**
   * Cleared on WS settle — also clear on local cache-hit paint so toggles are not
   * stuck on "It's loading, please wait...".
   */
  setPendingRequest: React.Dispatch<React.SetStateAction<OverlayPendingRequest>>;
  /** React state — only for nuclei/filter effect deps; hot path reads the refs. */
  showBackendAnnotations: boolean;
  /** Shared with keyboard + WS — single source for nuclei/patches gates. */
  showBackendAnnotationsRef: React.MutableRefObject<boolean>;
  showPatchesRef: React.MutableRefObject<boolean>;
  filterToolRef: React.MutableRefObject<boolean>;
  threshold: number;
  lastHashRef: React.MutableRefObject<string | null>;
  /** When false, skip overlay/patch sends (waiting for set_path ack). */
  pathReadyForDataRef?: React.MutableRefObject<boolean>;
};

/** Single overlay request hub: pan/zoom, nuclei/patches toggles, and reload all go through here. */
export function useViewportOverlaySession(params: UseViewportOverlaySessionParams) {
  const {
    viewerInstance,
    socket,
    instanceId,
    updateCentroids,
    updateRenderingAnnotations,
    setPatches,
    setPendingRequest,
    showBackendAnnotations,
    showBackendAnnotationsRef: showBackendRef,
    showPatchesRef,
    filterToolRef: filterRef,
    threshold,
    lastHashRef,
    pathReadyForDataRef,
  } = params;

  const dispatch = useDispatch();
  const centroidThreshold = useSelector(
    (s: RootState) => s.viewerSettings.centroidThreshold,
  );
  const classificationEnabled = useSelector(
    (s: RootState) => s.annotations.classificationEnabled,
  );
  const currentTool = useSelector((s: RootState) => s.tool.currentTool);
  const filterTool = currentTool === 'filter';
  const currentPath = useInstanceSlidePath(instanceId);

  const stateRef = useRef<OverlayState>(createOverlayState());
  const pendingPayloadRef = useRef<NetworkPayload | null>(null);
  const idleFlushRafRef = useRef<number | null>(null);
  const idleThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafTickRef = useRef<number | null>(null);
  /**
   * After `reset scope:'all'` while a cell request was in flight, ignore that many
   * subsequent cell replies (no paint / no contour dequeue / no settle) so a late
   * response cannot corrupt FIFO or overwrite a newer flight.
   * Tracked per wire type so a centroids abandon cannot steal an all_annotations reply.
   */
  const abandonedCellRepliesRef = useRef({
    centroids: 0,
    all_annotations: 0,
    annotations: 0,
  });

  /** Drop outstanding abandon debt (reload gate / wire_open / timeout). Late frames
   * are dropped via pathReady=false without settle, so debt must not steal the
   * first post-reload cell reply. */
  const clearAbandonedCellReplies = useCallback(() => {
    abandonedCellRepliesRef.current = {
      centroids: 0,
      all_annotations: 0,
      annotations: 0,
    };
  }, []);

  /** Redux viewport coords — kept outside the overlay request state machine. */
  const lastDispatchedCoordKeyRef = useRef('');

  const noteAbandonedCellReply = useCallback(
    (kind: 'centroids' | 'all_annotations' | 'annotations') => {
      abandonedCellRepliesRef.current[kind] += 1;
      const iid = typeof instanceId === 'string' ? instanceId : '';
      // Only all_annotations enqueues contour FIFO AABBs.
      if (kind === 'all_annotations' && iid) dequeueContourRequest(iid);
    },
    [instanceId],
  );
  // Latest inputs — assign during render to avoid a pile of syncing useEffects.
  // Nuclei/patches/filter gates use shared refs from the container (keyboard writes them).
  const viewerRef = useRef(viewerInstance);
  const socketRef = useRef(socket);
  const pathRef = useRef(currentPath);
  const prevPathRef = useRef(currentPath);
  const centroidThresholdRef = useRef(centroidThreshold);
  const thresholdRef = useRef(threshold);
  const classificationRef = useRef(classificationEnabled);
  viewerRef.current = viewerInstance;
  socketRef.current = socket;
  pathRef.current = currentPath;
  // Keep filter ref aligned with Redux (tool changes are not keydown-gated).
  filterRef.current = filterTool;
  centroidThresholdRef.current = centroidThreshold;
  thresholdRef.current = threshold;
  classificationRef.current = classificationEnabled;

  /**
   * Forget what the cell overlay is holding, so the next paint is unconditional.
   * The record lives in viewportContourCache because both paint routes — this
   * hook and the socket reply handler — have to share it.
   */
  const forgetPaint = useCallback(() => {
    forgetContourPaint(
      typeof instanceId === 'string' ? instanceId : '',
      pathRef.current || '',
    );
  }, [instanceId]);

  const cancelIdleFlush = useCallback(() => {
    if (idleFlushRafRef.current != null) {
      cancelAnimationFrame(idleFlushRafRef.current);
      idleFlushRafRef.current = null;
    }
  }, []);

  const cancelIdleThrottle = useCallback(() => {
    if (idleThrottleTimerRef.current != null) {
      clearTimeout(idleThrottleTimerRef.current);
      idleThrottleTimerRef.current = null;
    }
  }, []);

  const armIdleNetworkFlushRef = useRef<() => void>(() => {});
  const flushPendingNetworkRef = useRef<() => void>(() => {});
  const resyncAndFlushRef = useRef<
    (opts?: { intent?: OverlayIntent; refetch?: boolean }) => void
  >(() => {});
  const requestPatchesRef = useRef<() => void>(() => {});

  const cancelSchedule = useCallback(() => {
    pendingPayloadRef.current = null;
    cancelIdleFlush();
    cancelIdleThrottle();
  }, [cancelIdleFlush, cancelIdleThrottle]);

  const isPathReady = useCallback(() => {
    return !pathReadyForDataRef || pathReadyForDataRef.current;
  }, [pathReadyForDataRef]);

  /**
   * Spinner state, derived from the machine rather than switched on and off by
   * callers. It is true exactly while a request the user is waiting on is open,
   * so there is no code path that can leave it stuck.
   */
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const syncBusy = useCallback(() => {
    const s = stateRef.current;
    const next = s.cellFlightShowsSpinner || s.patches === 'flying';
    if (next === busyRef.current) return;
    busyRef.current = next;
    setBusy(next);
  }, []);


  const dispatchEventRef = useRef<(event: OverlayEvent) => void>(() => {});
  const flightWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFlightWatchdog = useCallback(() => {
    if (flightWatchdogRef.current != null) {
      clearTimeout(flightWatchdogRef.current);
      flightWatchdogRef.current = null;
    }
  }, []);

  /**
   * Last-resort recovery for a request that never gets answered (dead socket,
   * backend drop, frame eaten by a stale gate). The derived spinner stays up
   * while a flight is open, so a lost reply would otherwise show "loading
   * annotations" until the page is reloaded.
   */
  const armFlightWatchdog = useCallback(() => {
    clearFlightWatchdog();
    flightWatchdogRef.current = setTimeout(() => {
      flightWatchdogRef.current = null;
      const s = stateRef.current;
      if (!s.cellFlight && s.patches !== 'flying') return;
      console.warn('[Overlay] viewport request timed out; recovering', {
        cellFlight: s.cellFlight,
        patches: s.patches,
        generation: s.generation,
      });
      // fault clears both flights, counts the abandoned cell reply so a very
      // late frame cannot desync the contour FIFO, and re-syncs the viewport.
      dispatchEventRef.current({ type: 'fault', retry: true });
      // A timed-out reply is a dead reply. Leaving its abandon debt behind would
      // block every later contour/annotation send (sendPayload holds them while
      // debt > 0) until a reconnect or slide switch cleared it.
      clearAbandonedCellReplies();
      setPendingRequest(EMPTY_OVERLAY_PENDING);
    }, OVERLAY_FLIGHT_TIMEOUT_MS);
  }, [clearAbandonedCellReplies, clearFlightWatchdog, setPendingRequest]);

  /** Single wire gate — socket open + instance + set_path ack. */
  const canSendWire = useCallback(
    (label: string) => {
      const sock = socketRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return false;
      const iid = typeof instanceId === 'string' ? instanceId : '';
      if (!requireSegInstanceId(iid || instanceId, label)) return false;
      if (!isPathReady()) return false;
      return true;
    },
    [instanceId, isPathReady],
  );

  useEffect(() => {
    return () => {
      cancelSchedule();
      clearFlightWatchdog();
    };
  }, [instanceId, cancelSchedule, clearFlightWatchdog]);

  const sendPayload = useCallback(
    (payload: NetworkPayload): boolean => {
      if (!canSendWire('overlay send')) return false;
      const iid = typeof instanceId === 'string' ? instanceId : '';

      // Abandoned replies can arrive out of order vs a newer flight (server
      // thread-pool). Hold new contour/annotation sends until debt drains so
      // takeAbandoned cannot steal the fresh reply / desync FIFO AABBs.
      if (
        (payload.wsType === 'all_annotations' &&
          abandonedCellRepliesRef.current.all_annotations > 0) ||
        (payload.wsType === 'annotations' &&
          abandonedCellRepliesRef.current.annotations > 0)
      ) {
        return false;
      }

      const requestImage =
        payload.wsType === 'all_annotations'
          ? expandAabb(payload.image, CONTOUR_PREFETCH_RATIO)
          : payload.image;
      // New flight may receive an identical JSON body — don't let lastHash skip settle.
      lastHashRef.current = null;
      try {
        socketRef.current!.send(
          JSON.stringify({
            ...requestImage,
            type: payload.wsType,
            use_classification: payload.useClassification,
            instance_id: iid || instanceId,
          }),
        );
      } catch (error) {
        // The socket can close between the readyState gate and this call. Report
        // "not sent" so the caller re-arms the payload; an escaping throw would
        // abort the rAF tick / effect run and silently stop the overlay.
        console.warn('[Overlay] cell request send failed; keeping payload pending', error);
        return false;
      }
      if (payload.wsType === 'all_annotations' && iid) {
        enqueueContourRequest(iid, { ...requestImage });
      }
      stateRef.current = reduceOverlay(stateRef.current, {
        type: 'sent',
        layer: 'cell',
        payload,
      }).state;
      armFlightWatchdog();
      syncBusy();
      return true;
    },
    [armFlightWatchdog, canSendWire, instanceId, lastHashRef, syncBusy],
  );

  const runEffects = useCallback(
    (effects: OverlayEffect[]) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'paint':
            if (effect.layer === 'centroids') {
              forgetPaint();
              if (effect.data) {
                updateRenderingAnnotations([]);
                updateCentroids(effect.data);
                // Cache hit — no WS settle will clear the toolbar pending flag.
                setPendingRequest((p) => (p.nuclei ? { ...p, nuclei: false } : p));
              } else {
                updateCentroids(EMPTY_CENTROIDS);
              }
            } else if (effect.data) {
              // Paint only cells intersecting the live viewport (+ margin). Cache may
              // hold tens of thousands; DrawingOverlay rebuild cost scales with paint size.
              const resolved = resolveContourPaint({
                instanceId: typeof instanceId === 'string' ? instanceId : '',
                path: pathRef.current || '',
                data: effect.data,
                viewport: getVisibleImageCoordinates(viewerRef.current)?.image ?? null,
              });
              if (!resolved.skip) {
                updateCentroids(EMPTY_CENTROIDS);
                updateRenderingAnnotations(resolved.toPaint);
              }
              setPendingRequest((p) => (p.nuclei ? { ...p, nuclei: false } : p));
            } else {
              forgetPaint();
              updateRenderingAnnotations([]);
            }
            // Cache-hit / clear paths never settle — drop spinner when nothing is flying.
            break;
          case 'cancel_idle':
            cancelSchedule();
            break;
          case 'cell_net':
            if (effect.timing === 'idle') {
              pendingPayloadRef.current = effect.payload;
              armIdleNetworkFlushRef.current();
              break;
            }
            {
              // loading — send now + spinner. On weak-net failure, re-arm as idle
              // pending so animation-finish / next rAF can retry (no new timer).
              const sent = sendPayload(effect.payload);
              if (sent) {
                pendingPayloadRef.current = null;
              } else {
                pendingPayloadRef.current = effect.payload;
                armIdleNetworkFlushRef.current();
              }
            }
            break;
          case 'patches_net': {
            if (!canSendWire('patches') || stateRef.current.patches === 'flying') {
              // keydown may have armed spinner before send — don't leave it stuck.
              break;
            }
            const iid = typeof instanceId === 'string' ? instanceId : '';
            lastHashRef.current = null;
            try {
              socketRef.current!.send(
                JSON.stringify({
                  ...effect.image,
                  type: 'patches',
                  instance_id: iid || instanceId,
                }),
              );
            } catch (error) {
              // Leave patches idle so the next sync retries; never let the throw
              // escape and take the rest of the effect run with it.
              console.warn('[Overlay] patches request send failed; waiting for wire reopen', error);
              break;
            }
            stateRef.current = reduceOverlay(stateRef.current, {
              type: 'sent',
              layer: 'patches',
            }).state;
            armFlightWatchdog();
            syncBusy();
            break;
          }
          case 'resync': {
            if (effect.scope === 'patches') {
              if (isPathReady() && showPatchesRef.current) {
                requestPatchesRef.current();
              }
              break;
            }
            resyncAndFlushRef.current({
              refetch: effect.refetch || undefined,
            });
            break;
          }
          case 'flush_idle':
            armIdleNetworkFlushRef.current();
            break;
          case 'abandon_cell':
            noteAbandonedCellReply(effect.kind);
            break;
          default:
            break;
        }
      }
    },
    [
      armFlightWatchdog,
      canSendWire,
      syncBusy,
      cancelSchedule,
      instanceId,
      isPathReady,
      lastHashRef,
      noteAbandonedCellReply,
      sendPayload,
      setPendingRequest,
      showPatchesRef,
      updateCentroids,
      updateRenderingAnnotations,
    ],
  );

  const dispatchEvent = useCallback(
    (event: OverlayEvent) => {
      const result = reduceOverlay(stateRef.current, event);
      stateRef.current = result.state;
      runEffects(result.effects);
      // Effects may have started a fresh flight (and re-armed the watchdog);
      // only disarm once nothing is outstanding.
      const s = stateRef.current;
      if (!s.cellFlight && s.patches !== 'flying') {
        clearFlightWatchdog();
      }
      syncBusy();
    },
    [clearFlightWatchdog, runEffects, syncBusy],
  );
  dispatchEventRef.current = dispatchEvent;

  /** WS hub: true → drop this cell reply entirely (already counted at reset). */
  const takeAbandonedCellReply = useCallback(
    (kind: 'centroids' | 'all_annotations' | 'annotations') => {
      if (abandonedCellRepliesRef.current[kind] <= 0) return false;
      abandonedCellRepliesRef.current[kind] -= 1;
      // A new contour request may have been coalesced while debt > 0 — flush now.
      if (kind === 'all_annotations' || kind === 'annotations') {
        armIdleNetworkFlushRef.current();
      }
      return true;
    },
    [],
  );

  const prevInstanceIdRef = useRef(instanceId);
  useEffect(() => {
    const prevPath = prevPathRef.current;
    const prevInstance = prevInstanceIdRef.current;
    if (instanceId && prevPath && currentPath && prevPath !== currentPath) {
      clearViewportOverlayCaches(instanceId, prevPath);
      dispatchEvent({ type: 'reset', scope: 'all' });
      // Path-change reset abandons in-flight replies; clear debt so the first
      // post-switch cell frame is not stolen (same wedge as NuClass reload).
      clearAbandonedCellReplies();
    }
    if (prevInstance && instanceId && prevInstance !== instanceId) {
      clearViewportOverlayCaches(prevInstance);
      dispatchEvent({ type: 'reset', scope: 'all' });
      clearAbandonedCellReplies();
    }
    prevPathRef.current = currentPath;
    prevInstanceIdRef.current = instanceId;
  }, [currentPath, instanceId, dispatchEvent, clearAbandonedCellReplies]);

  const flushPendingNetwork = useCallback(() => {
    const payload = pendingPayloadRef.current;
    if (!payload) return;
    // Superseded: a reset / LOD switch bumped the generation and no new payload
    // took this one's place (the reducer only emits `cell_net` for the branches
    // that want the wire). It can never satisfy `canSendIdlePayload`, and the
    // throttle below re-arms itself, so keeping it meant a 20Hz spin that never
    // sent anything while the layer waited for data. Drop it and let the machine
    // say what the live viewport needs now.
    if (payload.generation !== stateRef.current.generation) {
      pendingPayloadRef.current = null;
      cancelIdleFlush();
      cancelIdleThrottle();
      resyncAndFlushRef.current();
      return;
    }
    // Keep pending if a flight is still open — settle → resync will retry.
    // Previously we cleared first and dropped the payload, so slow pans lost
    // their coalesced request whenever a throttle/rAF fired mid-flight.
    if (!canSendIdlePayload(stateRef.current, payload)) return;
    pendingPayloadRef.current = null;
    cancelIdleFlush();
    cancelIdleThrottle();
    const sent = sendPayload(payload);
    if (!sent) {
      pendingPayloadRef.current = payload;
      armIdleNetworkFlushRef.current();
    }
  }, [cancelIdleFlush, cancelIdleThrottle, sendPayload]);

  /**
   * Coalesce idle cell_net:
   * - settled viewport → flush next rAF
   * - animating (zoom spring / inertia) → throttle so slow continuous pans still
   *   request; animation-finish also flushes the latest pending
   */
  const armIdleNetworkFlush = useCallback(() => {
    if (!pendingPayloadRef.current) return;

    if (idleThrottleTimerRef.current == null) {
      idleThrottleTimerRef.current = setTimeout(() => {
        idleThrottleTimerRef.current = null;
        if (!pendingPayloadRef.current) return;
        flushPendingNetwork();
        // Still pending (in-flight or send failed) — keep trying.
        if (pendingPayloadRef.current) armIdleNetworkFlushRef.current();
      }, IDLE_NET_THROTTLE_MS);
    }

    if (isViewportAnimating(viewerRef.current)) return;
    if (idleFlushRafRef.current != null) return;
    idleFlushRafRef.current = requestAnimationFrame(() => {
      idleFlushRafRef.current = null;
      if (!pendingPayloadRef.current) return;
      // Re-check: zoom springs may have started again between schedule and fire.
      if (isViewportAnimating(viewerRef.current)) return;
      flushPendingNetwork();
    });
  }, [flushPendingNetwork]);

  flushPendingNetworkRef.current = flushPendingNetwork;
  armIdleNetworkFlushRef.current = armIdleNetworkFlush;

  // Socket reopen: recover wedged flights, else flush idle coalesce.
  // If open already fired before this effect (fast local handshake), run immediately.
  // Depend only on socket identity — callback churn must not re-fire wire_open.
  useEffect(() => {
    if (!socket) return;
    const onOpen = () => {
      dispatchEvent({ type: 'wire_open' });
      // Dead-socket replies never arrive. fault→abandon_cell would leave debt that
      // steals the first post-reconnect cell frame and wedges cellFlight forever.
      clearAbandonedCellReplies();
    };
    if (socket.readyState === WebSocket.OPEN) {
      onOpen();
      return;
    }
    socket.addEventListener('open', onOpen);
    return () => {
      socket.removeEventListener('open', onOpen);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only socket identity
  }, [socket]);

  /**
   * Wire death is an event, not a deadline. A closed (or replaced) socket can
   * never deliver the replies it still owes, so recover on the `close` edge —
   * otherwise the spinner stays up until the 30s flight watchdog notices, and
   * a slow reconnect stretches that to the whole backoff.
   * `retry: false`: the next socket's wire_open owns the re-sync.
   */
  const previousSocketRef = useRef<WebSocket | null>(socket);
  const handleWireDeath = useCallback(() => {
    const s = stateRef.current;
    if (!s.cellFlight && s.patches !== 'flying') return;
    console.warn('[Overlay] socket closed with a request in flight; recovering', {
      cellFlight: s.cellFlight,
      patches: s.patches,
    });
    // dispatchEvent disarms the watchdog itself once nothing is left flying.
    dispatchEventRef.current({ type: 'fault', retry: false });
    clearAbandonedCellReplies();
    setPendingRequest(EMPTY_OVERLAY_PENDING);
  }, [clearAbandonedCellReplies, setPendingRequest]);

  useEffect(() => {
    const previous = previousSocketRef.current;
    previousSocketRef.current = socket;
    // Replaced (or dropped to null) without a close reaching this listener.
    if (previous && previous !== socket) handleWireDeath();
    if (!socket) return;
    if (socket.readyState !== WebSocket.CONNECTING && socket.readyState !== WebSocket.OPEN) {
      handleWireDeath();
      return;
    }
    const onClose = () => handleWireDeath();
    socket.addEventListener('close', onClose);
    return () => {
      socket.removeEventListener('close', onClose);
    };
  }, [socket, handleWireDeath]);

  const buildAndSync = useCallback(
    (opts: {
      intent: OverlayIntent;
      /** Dirty readiness + skip local cell cache hits for this sync only. */
      refetch?: boolean;
    }) => {
      const viewer = viewerRef.current;
      if (!viewer?.viewport) return;
      const coordinates = getVisibleImageCoordinates(viewer);
      if (!coordinates) return;

      const path = pathRef.current || '';
      const iid = typeof instanceId === 'string' ? instanceId : '';
      const needOverlay = showBackendRef.current || filterRef.current;
      const isImageFile = isStaticImagePath(path);
      const zoom = viewer.viewport.getZoom();
      const fullImage = getFullImageAabb(viewer);

      // This runs inside the pan/zoom rAF. A dispatch there re-runs every
      // subscribed selector in the app and schedules a React render, so publish
      // only while something is actually reading the feed (see
      // viewerCoordinateFeed) — normally nothing is.
      if (hasViewerCoordinateConsumers()) {
        const viewportCoordKey = coordKeyOf(coordinates.image);
        if (lastDispatchedCoordKeyRef.current !== viewportCoordKey) {
          lastDispatchedCoordKeyRef.current = viewportCoordKey;
          dispatch(setCurrentViewerCoordinates(coordinates));
        }
      }

      let cacheHit: CentroidsArray | null = null;
      let contourCacheHit = null as ReturnType<typeof tryHitViewportContourCache>;
      if (needOverlay && !isImageFile && iid && path && !opts.refetch) {
        if (zoom < centroidThresholdRef.current) {
          cacheHit = getCachedCentroids(iid, path);
        } else {
          contourCacheHit = tryHitViewportContourCache(iid, path, coordinates.image);
        }
      }

      dispatchEvent({
        type: 'sync',
        snapshot: {
          zoom,
          coordinates,
          path,
          instanceId: iid,
          needOverlay,
          isImageFile,
          centroidThreshold: centroidThresholdRef.current,
          threshold: thresholdRef.current,
          classificationEnabled: classificationRef.current,
          showPatches: showPatchesRef.current,
          intent: opts.intent,
          refetch: opts.refetch,
          cacheHit,
          contourCacheHit,
          fullImage,
        },
      });
    },
    [dispatch, dispatchEvent, instanceId],
  );

  /** Shared catch-up / retry path: sync then flush any idle-coalesced cell_net. */
  const resyncAndFlush = useCallback(
    (opts?: { intent?: OverlayIntent; refetch?: boolean }) => {
      const intent =
        opts?.intent ?? overlayIntentForNuclei(showBackendRef.current);
      buildAndSync({
        intent,
        refetch: opts?.refetch,
      });
      flushPendingNetworkRef.current();
    },
    [buildAndSync, showBackendRef],
  );
  resyncAndFlushRef.current = resyncAndFlush;

  const tick = useCallback(() => {
    // Nuclei on must stay explicit so high zoom keeps requesting annotations,
    // not contours (continuous 2-tier). Filter-only stays continuous.
    buildAndSync({
      intent: overlayIntentForNuclei(showBackendRef.current),
    });
  }, [buildAndSync, showBackendRef]);

  /**
   * Clear session + abandon in-flight cell replies (gate close / before pull).
   *
   * `keepPaint` leaves the current frame on the canvas while the session itself
   * resets — for a reload of the slide already on screen, where blanking would
   * only show the user an empty overlay until the replacement lands. `forgetPaint`
   * still runs either way: the record must not claim coverage for a cache array
   * that is about to be dropped, or the replacing frame would be skipped.
   */
  const resetAll = useCallback(
    (opts?: { keepPaint?: boolean }) => {
      forgetPaint();
      dispatchEvent({ type: 'reset', scope: 'all', keepPaint: opts?.keepPaint });
    },
    [dispatchEvent, forgetPaint],
  );

  const forceSync = useCallback(
    (opts?: {
      intent?: OverlayIntent;
      /**
       * In-flight catch-up only: skip local cell cache hits for this sync.
       * Data invalidation (reload / NuClass) must clearViewportOverlayCaches first,
       * then call forceSync without refetch.
       */
      refetch?: boolean;
    }) => {
      buildAndSync({
        intent: opts?.intent ?? 'explicit',
        refetch: opts?.refetch,
      });
    },
    [buildAndSync],
  );
  const forceSyncRef = useRef(forceSync);
  forceSyncRef.current = forceSync;

  const classificationBootRef = useRef(true);
  useEffect(() => {
    if (classificationBootRef.current) {
      classificationBootRef.current = false;
      return;
    }
    // Mid set_path / NuClass forceReload: path gate is closed. Defer to
    // handler-reload-complete — a reset+forceSync here races abandon debt and
    // steals the first post-reload cell frame.
    if (!isPathReady()) return;
    const iid = typeof instanceId === 'string' ? instanceId : '';
    // Instance-wide cell cache clear: path-scoped delete can miss if the store
    // key and pathRef disagree (slash / .zarr variants).
    // Cell reset only — classification does not invalidate patch geometry.
    if (iid) clearViewportOverlayCaches(iid);
    // Same slide, same cells, new colours: keep the current frame up until the
    // reclassified one replaces it. Blanking here was a second flash right after
    // the reload's, since a run flipping this flag is exactly when it fires.
    dispatchEvent({ type: 'reset', scope: 'cell', keepPaint: true });
    clearAbandonedCellReplies();
    forceSyncRef.current({ intent: 'explicit' });
  }, [classificationEnabled, instanceId, isPathReady, clearAbandonedCellReplies, dispatchEvent]);

  const requestPatches = useCallback(() => {
    const image = getFullImageAabb(viewerRef.current);
    // Patches are slide-scoped — never fall back to the visible viewport AABB.
    if (!image) return;
    dispatchEvent({ type: 'patches', op: 'request', image });
  }, [dispatchEvent]);
  requestPatchesRef.current = requestPatches;

  /**
   * Normal frame settle — reply already matched FIFO (or patches applied).
   * Dropped frames emit `retry` from the reducer; do not pass retry flags here.
   * Wire/parse/reconnect/no-seg → faultOverlay.
   */
  const settleOverlay = useCallback(
    (kind: SettleKind, opts: { applied: boolean }) => {
      dispatchEvent({ type: 'settled', kind, applied: opts.applied });
    },
    [dispatchEvent],
  );

  /**
   * Wire/reconnect/no-seg fault event — abandon + clear flights; optional retry effect.
   */
  const faultOverlay = useCallback(
    (opts?: { retry?: boolean }) => {
      dispatchEvent({ type: 'fault', retry: opts?.retry === true });
      // The reply this abandon debt waits for already failed (wire error, bad
      // frame, no-seg) — it will never arrive to drain the counter. Leaving it
      // set blocks every later contour/annotation send, because sendPayload
      // holds those back while debt > 0, and the idle flush then retries at
      // 20Hz forever. Same call the reload gate and wire_open already make.
      clearAbandonedCellReplies();
    },
    [clearAbandonedCellReplies, dispatchEvent],
  );

  const prevOverlayNeedKeyRef = useRef<string | null>(null);
  const overlayNeedKey = `${showBackendAnnotations}:${filterTool}`;
  useEffect(() => {
    const prev = prevOverlayNeedKeyRef.current;
    prevOverlayNeedKeyRef.current = overlayNeedKey;
    // Skip mount / Strict re-invoke with the same key.
    if (prev === null || prev === overlayNeedKey) return;
    // Preserve patches — nuclei/filter toggles must not re-fetch full-slide patches.
    dispatchEvent({ type: 'reset', scope: 'cell' });
    // Reset leaves mode 'none' → modeChanged forces loading send.
    buildAndSync({ intent: overlayIntentForNuclei(showBackendRef.current) });
  }, [overlayNeedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!viewerInstance) return;

    let lastZoom = viewerInstance.viewport?.getZoom?.() || 0;

    const handleViewportChange = () => {
      if (!viewerInstance?.viewport) return;
      const currentZoom = viewerInstance.viewport.getZoom();
      const zoomChange = Math.abs(currentZoom - lastZoom) / Math.max(lastZoom, 0.001);
      if (viewerInstance.imageLoader && zoomChange > 0.15) {
        viewerInstance.imageLoader.clear();
      }
      lastZoom = currentZoom;
      if (rafTickRef.current != null) return;
      rafTickRef.current = requestAnimationFrame(() => {
        rafTickRef.current = null;
        tickRef.current();
        // Instant pans (no spring) still need a flush; animating waits for finish.
        armIdleNetworkFlushRef.current();
      });
    };

    const handleAnimationFinish = () => {
      flushPendingNetworkRef.current();
    };

    viewerInstance.addHandler('viewport-change', handleViewportChange);
    viewerInstance.addHandler('animation-finish', handleAnimationFinish);
    return () => {
      viewerInstance.removeHandler('viewport-change', handleViewportChange);
      viewerInstance.removeHandler('animation-finish', handleAnimationFinish);
      if (rafTickRef.current != null) {
        cancelAnimationFrame(rafTickRef.current);
        rafTickRef.current = null;
      }
      cancelIdleFlush();
    };
  }, [viewerInstance, cancelIdleFlush]);

  const keydownUpdate = useCallback(
    (prev: boolean, newVal: boolean) => {
      // Reset/sync owned by overlayNeedKey effect — only clear UI / loading here.
      if (prev === true && newVal === false) {
        // Must drop the paint record: reset→sync to none often has modeChanged
        // false (reset already set mode none), so paint:null never runs. Leaving
        // it pointing at contour cache data makes the next cache-hit toggle skip
        // paint and leave the overlay blank.
        forgetPaint();
        if (!filterRef.current) {
          updateCentroids(EMPTY_CENTROIDS);
          updateRenderingAnnotations([]);
        }
      }
    },
    [
      forgetPaint,
      updateCentroids,
      updateRenderingAnnotations,
    ],
  );

  const keydownUpdatePatches = useCallback(
    (prev: boolean, newVal: boolean) => {
      if (prev === true && newVal === false) {
        setPatches(EMPTY_PATCHES);
        lastHashRef.current = null;
        dispatchEvent({ type: 'patches', op: 'clear' });
        return;
      }
      if (prev === false && newVal === true) {
        if (isPathReady()) {
        }
        requestPatches();
      }
    },
    [
      setPatches,
      dispatchEvent,
      isPathReady,
      lastHashRef,
      requestPatches,
    ],
  );

  return {
    /** True while a request the user is waiting on is outstanding. */
    busy,
    forceSync,
    resetAll,
    requestPatches,
    settleOverlay,
    /** Parse/reconnect/no-seg — abandon cell FIFO + settle open flights. */
    faultOverlay,
    takeAbandonedCellReply,
    clearAbandonedCellReplies,
    /** True while a patches request is awaiting settle — late replies otherwise mark ready. */
    isPatchesFlying: () => stateRef.current.patches === 'flying',
    /**
     * True when a binary viewport reply could still be ours. Every viewer shares
     * one socket and now sees every frame, so this keeps idle viewers from
     * decompressing other viewers' overlay payloads.
     */
    expectsWireFrame: () => {
      const s = stateRef.current;
      if (s.cellFlight || s.patches === 'flying') return true;
      const debt = abandonedCellRepliesRef.current;
      return debt.centroids > 0 || debt.all_annotations > 0 || debt.annotations > 0;
    },
    keydownUpdate,
    keydownUpdatePatches,
  };
}
