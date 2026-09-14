import { useEffect, useRef } from 'react';
import eventBus from '@/utils/common/eventBus';
import { stripZarrSuffix, workflowZarrPathsMatch } from '@/utils/agent/workflow/pathNorm';
import { requireSegInstanceId } from '@/utils/viewer/segWs';
import type { OverlayPendingRequest } from '@/utils/viewer/overlayRequestNotify';
import { EMPTY_OVERLAY_PENDING } from '@/utils/viewer/overlayRequestNotify';
import { clearViewportOverlayCaches } from '@/utils/viewer/viewportOverlayCaches';

interface UseViewportRefreshParams {
  socket: WebSocket | null;
  currentPath: string | null;
  instanceId?: string | null;
  isActive?: boolean;
  setPendingRequest: React.Dispatch<React.SetStateAction<OverlayPendingRequest>>;
  lastHashRef: React.MutableRefObject<string | null>;
  lastSentPathRef: React.MutableRefObject<string | null>;
  /** set_path just went out — hand the slide-binding machine the new path. */
  bindPath: (path: string) => void;
  /** Re-bound to a path we already hold: rebuild the overlay in place. */
  rebuildOverlay: () => void;
  refreshPatchClassificationData: () => Promise<void>;
  pathReadyForDataRef?: React.MutableRefObject<boolean>;
  /** Unified overlay hub */
  forceOverlaySync: (opts?: {
    intent?: 'explicit' | 'continuous';
    refetch?: boolean;
  }) => void;
  /** Clear overlay session (gate close / before set_path). */
  resetOverlay: (opts?: { keepPaint?: boolean }) => void;
  /** Clear abandon debt after reload gate (see scheduleForceOverlay). */
  clearAbandonedCellReplies?: () => void;
  requestPatches: () => void;
  /**
   * Render-visible mirror of the binding wire gate (`bound` or `failed`).
   * A ref cannot be an effect dependency, so this is what a held patch refresh
   * watches to notice the gate reopening. Required, not optional: omitting it
   * would silently strand every held refresh instead of failing loudly.
   */
  isPathBound: boolean;
}

/**
 * Path refresh / set_path only. Viewport overlay pulls go through overlay session.
 */
export const useViewportRefresh = (params: UseViewportRefreshParams) => {
  const {
    socket,
    currentPath,
    instanceId,
    isActive = true,
    setPendingRequest,
    lastHashRef,
    lastSentPathRef,
    bindPath,
    rebuildOverlay,
    refreshPatchClassificationData,
    pathReadyForDataRef,
    forceOverlaySync,
    resetOverlay,
    clearAbandonedCellReplies,
    requestPatches,
    isPathBound,
  } = params;

  const pendingPathRefreshRef = useRef<{
    path: string;
    forceReload?: boolean;
    skipViewportRefresh?: boolean;
  } | null>(null);

  useEffect(() => {
    const sendSetPath = (
      normalizedIncoming: string,
      forceReload?: boolean,
      skipViewportRefresh?: boolean,
    ) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      lastHashRef.current = null;
      const normalizedCurrent = stripZarrSuffix(currentPath || '');
      if (!forceReload && (lastSentPathRef.current === normalizedIncoming || normalizedIncoming === normalizedCurrent)) {
        if (!skipViewportRefresh) {
          // Already bound to this path — just rebuild the overlay for it.
          rebuildOverlay();
        }
        return true;
      }

      if (!requireSegInstanceId(instanceId, 'set_path refresh')) {
        return false;
      }

      if (forceReload && typeof instanceId === 'string' && instanceId) {
        clearViewportOverlayCaches(instanceId);
      }
      if (forceReload) {
        // Same path does not hit the overlay path-change reset — clear the flight
        // or a dropped pre-reload response can wedge cellFlight forever.
        // `keepPaint`: this is the slide already on screen, and the backend rebind
        // that follows can take seconds. Blanking here is what made a finished run
        // look like the overlay had been switched off until the new frame landed;
        // the frame that replaces it repaints unconditionally.
        resetOverlay({ keepPaint: true });
        clearAbandonedCellReplies?.();
        setPendingRequest(EMPTY_OVERLAY_PENDING);
      }

      socket.send(
        JSON.stringify({
          type: 'set_path',
          path: normalizedIncoming,
          instance_id: instanceId,
          // A forced rebind must not be dropped as a duplicate of a same-path
          // bind already in flight: that one may have read the zarr before the
          // run that triggered this refresh finished writing it.
          ...(forceReload ? { force_reload: true } : {}),
        })
      );
      // Shuts the wire gate, records the path and arms the shared no-ack
      // deadline; the container owns what happens when it expires.
      bindPath(normalizedIncoming);
      return true;
    };

    const flushPendingPathRefresh = () => {
      const pending = pendingPathRefreshRef.current;
      if (!pending) return;
      if (sendSetPath(pending.path, pending.forceReload, pending.skipViewportRefresh)) {
        pendingPathRefreshRef.current = null;
      }
    };

    const handleRefreshWebSocketPath = ({
      path,
      forceReload,
      skipViewportRefresh,
    }: {
      path: string;
      forceReload?: boolean;
      skipViewportRefresh?: boolean;
    }) => {
      if (!path) {
        return;
      }
      const normalizedIncoming = stripZarrSuffix(path);
      const normalizedMine = stripZarrSuffix(currentPath || '');
      // Emitters decide "this reload is for the open slide" with
      // workflowZarrPathsMatch (see runWorkflowCompletionShared). Re-checking it
      // here with raw string equality dropped every reload whose path was an
      // equivalent-but-different form of ours — Windows `\` vs `/` from
      // formatPath, storage-relative vs absolute, case — so a finished
      // classification never refreshed the overlay at all.
      if (normalizedMine && !workflowZarrPathsMatch(normalizedIncoming, normalizedMine)) {
        return;
      }
      if (!normalizedMine && !isActive) {
        return;
      }
      // Bind our own form of the path, not the emitter's. boundPathRef is what
      // the container compares against `currentPath` to decide whether it still
      // needs a set_path; binding a different spelling of the same slide would
      // make it fire a second, redundant bind on the next render.
      const targetPath = normalizedMine || normalizedIncoming;
      if (sendSetPath(targetPath, forceReload, skipViewportRefresh)) {
        pendingPathRefreshRef.current = null;
        return;
      }
      // Wait for socket `open` (or effect re-run when socket becomes OPEN).
      pendingPathRefreshRef.current = {
        path: targetPath,
        forceReload,
        skipViewportRefresh,
      };
    };

    if (isActive) {
      flushPendingPathRefresh();
    }

    const onSocketOpen = () => {
      flushPendingPathRefresh();
    };
    socket?.addEventListener('open', onSocketOpen);

    eventBus.on('refresh-websocket-path', handleRefreshWebSocketPath);
    return () => {
      eventBus.off('refresh-websocket-path', handleRefreshWebSocketPath);
      socket?.removeEventListener('open', onSocketOpen);
    };
  }, [
    socket,
    currentPath,
    setPendingRequest,
    lastHashRef,
    lastSentPathRef,
    instanceId,
    isActive,
    pathReadyForDataRef,
    forceOverlaySync,
    resetOverlay,
    clearAbandonedCellReplies,
  ]);

  // `refresh-patches` is emitted in the same tick as the `refresh-websocket-path`
  // that begins a reload (see runWorkflowCompletionShared), so the wire gate is
  // already shut when it lands: `requestPatches` is dropped by canSendWire
  // without ever marking a flight, and `refreshPatchClassificationData` reads
  // HTTP from a handler still serving the pre-run zarr. Both then keep the
  // pre-run legend/patches on screen. Hold the refresh and replay it when the
  // gate reopens — see the effect below.
  const pendingPatchRefreshRef = useRef(false);

  useEffect(() => {
    const runPatchRefresh = () => {
      void refreshPatchClassificationData();
      requestPatches();
    };

    const handleRefreshPatches = () => {
      if (!isActive) return;
      if (pathReadyForDataRef && !pathReadyForDataRef.current) {
        pendingPatchRefreshRef.current = true;
        return;
      }
      runPatchRefresh();
    };

    eventBus.on('refresh-patches', handleRefreshPatches);
    return () => {
      eventBus.off('refresh-patches', handleRefreshPatches);
    };
  }, [requestPatches, refreshPatchClassificationData, isActive, pathReadyForDataRef]);

  // The gate reopening is the replay trigger, whichever way it opened: the
  // set_path ack, the no-ack retry-then-rebuild ladder, or `binding.fail()` (a
  // backend error, which reopens the wire deliberately so late data is still
  // accepted). `isPathBound` mirrors that transition into render, because a ref
  // cannot be an effect dependency.
  useEffect(() => {
    if (!isPathBound) return;
    if (!pendingPatchRefreshRef.current) return;
    if (!isActive) return;
    pendingPatchRefreshRef.current = false;
    void refreshPatchClassificationData();
    requestPatches();
  }, [isPathBound, isActive, refreshPatchClassificationData, requestPatches]);
};
