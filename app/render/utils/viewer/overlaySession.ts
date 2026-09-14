import { CentroidsArray } from '../../types/centroidsArray';
import type { ViewportAabb } from './viewportGeometryCache';
import { coordKeyOf } from './viewportGeometryCache';
import type { ContourAnnotation } from './viewportContourCache';
import type { VisibleImageCoordinates } from './overlayCoords';

// --- LOD / wire mapping ---

export type OverlayIntent = 'continuous' | 'explicit';

/** UI / session mode (`contours` <-> wire `all_annotations`). */
export type OverlayMode = 'none' | 'centroids' | 'contours' | 'annotations';

export type OverlayWsType = 'centroids' | 'all_annotations' | 'annotations';

const WS_TYPE: Record<Exclude<OverlayMode, 'none'>, OverlayWsType> = {
  centroids: 'centroids',
  contours: 'all_annotations',
  annotations: 'annotations',
};

export function wsTypeFor(mode: Exclude<OverlayMode, 'none'>): OverlayWsType {
  return WS_TYPE[mode];
}

/**
 * Cell wire type an incoming message answers, or null if it is not a cell reply.
 *
 * Lives here, next to the machine, because it is what decides whether a message
 * can pay an abandoned-reply debt — and every message form has to agree on that,
 * frames and `status: 'dropped'` acks alike. When the drop path skipped this, a
 * dropped answer to an already-abandoned request left the debt standing forever
 * and `sendPayload` held every later cell send.
 */
export function cellWireTypeOf(data: unknown): OverlayWsType | null {
  const type = (data as { type?: unknown } | null | undefined)?.type;
  if (
    type === 'centroids' ||
    type === 'all_annotations' ||
    type === 'annotations'
  ) {
    return type;
  }
  return null;
}

/** Which layer's flight a message settles, or null if it settles nothing. */
export function settleKindForMessage(data: unknown): SettleKind | null {
  const type = (data as { type?: unknown } | null | undefined)?.type;
  if (type === 'patches') return 'patches';
  return cellWireTypeOf(data) ? 'cell' : null;
}

/** Contours + high-zoom annotations both paint cell overlays (not centroids). */
export function isViewportCellMode(mode: OverlayMode): boolean {
  return mode === 'contours' || mode === 'annotations';
}

export function isViewportCellFlight(flight: OverlayWsType | null): boolean {
  return flight === 'all_annotations' || flight === 'annotations';
}

export function isStaticImagePath(path: string | null | undefined): boolean {
  if (!path) return false;
  const p = path.toLowerCase();
  return p.endsWith('.png') || p.endsWith('.jpg') || p.endsWith('.jpeg') || p.endsWith('.bmp');
}

/**
 * LOD resolver.
 * - continuous: centroids | contours
 * - explicit (nuclei overlay): + high-zoom annotations
 */
export function resolveOverlayRequest(opts: {
  zoom: number;
  centroidThreshold: number;
  threshold: number;
  needOverlay: boolean;
  isImageFile: boolean;
  intent: OverlayIntent;
}): Exclude<OverlayMode, 'none'> | null {
  const { zoom, centroidThreshold, threshold, needOverlay, isImageFile, intent } = opts;
  if (!needOverlay) return null;

  if (intent === 'explicit') {
    if (isImageFile || zoom >= threshold) return 'annotations';
    if (zoom >= centroidThreshold) return 'contours';
    return 'centroids';
  }

  if (isImageFile || zoom >= centroidThreshold) return 'contours';
  return 'centroids';
}

// --- Session state machine ---

export type SettleKind = 'cell' | 'patches';

/** Patches are slide-scoped: idle -> flying -> ready (or clear -> idle). */
export type PatchesPhase = 'idle' | 'flying' | 'ready';

export type NetworkPayload = {
  generation: number;
  /** Contours/annotations viewport key; centroids unused (''). */
  coordKey: string;
  wsType: OverlayWsType;
  image: ViewportAabb;
  useClassification: boolean;
  /**
   * User is waiting on this one (mode change / explicit pull) rather than a
   * background pan refill. Drives the spinner, which is derived from this state
   * instead of being switched on and off from every call site.
   */
  showsSpinner: boolean;
};

/** Side effects produced by the reducer - run by the session hub. */
export type OverlayEffect =
  | { type: 'paint'; layer: 'centroids'; data: CentroidsArray | null }
  | { type: 'paint'; layer: 'cells'; data: ContourAnnotation[] | null }
  | {
      type: 'cell_net';
      payload: NetworkPayload;
      /**
       * idle: coalesce until viewport settles (hub flushes via sendPayload)
       * loading: send immediately + shared spinner
       */
      timing: 'idle' | 'loading';
    }
  | { type: 'cancel_idle' }
  | { type: 'patches_net'; image: ViewportAabb }
  /** Hub re-sync. `scope: 'patches'` replays patches only (queued / patches-only drop). */
  | { type: 'resync'; refetch?: boolean; scope?: 'patches' }
  /** Socket reopened with no open flight - hub may flush coalesced idle payload. */
  | { type: 'flush_idle' }
  /** Flight cancelled without matching settle. Hub: abandon counter + FIFO dequeue. */
  | { type: 'abandon_cell'; kind: OverlayWsType };

export type OverlayState = {
  generation: number;
  mode: OverlayMode;
  /** Last applied / requested cell viewport key ('' for centroids). */
  coordKey: string;
  centroidsReady: boolean;
  /** null = idle; otherwise the in-flight cell wire type (settle / FIFO gating). */
  cellFlight: null | OverlayWsType;
  /** The open cell flight is one the user is waiting on (see NetworkPayload). */
  cellFlightShowsSpinner: boolean;
  patches: PatchesPhase;
  /** Request arrived while flying — replay patches after this flight settles. */
  patchesQueued: boolean;
  /**
   * Re-sync once after cell settle (viewport/mode advanced, or reset/refetch while flying).
   * Cleared on settle; may emit a `resync` effect.
   * - reuse: may still paint from local cell cache on catch-up
   * - refetch: catch-up must hit the wire (in-flight reset / readiness dirty)
   */
  pendingCatchUp: null | 'reuse' | 'refetch';
  /**
   * Consecutive faults that asked for a retry without any frame landing in
   * between. This is the machine's own backoff: a wire/parse/backend-error fault
   * must re-request (otherwise the layer keeps whatever it had and nobody ever
   * asks again), but a backend answering every request with an error would then
   * loop forever. Any applied frame — or a reset — clears it.
   */
  faultRetries: number;
};

export type OverlaySyncSnapshot = {
  zoom: number;
  coordinates: VisibleImageCoordinates;
  path: string;
  instanceId: string;
  needOverlay: boolean;
  isImageFile: boolean;
  centroidThreshold: number;
  threshold: number;
  classificationEnabled: boolean;
  showPatches: boolean;
  intent: OverlayIntent;
  /**
   * This sync must go to the network: ignore local cell cache hits and dirty
   * centroidsReady/coordKey. Does NOT clear the module-level store ? use
   * clearViewportOverlayCaches for data invalidation (reload / NuClass / ?).
   */
  refetch?: boolean;
  cacheHit: CentroidsArray | null;
  contourCacheHit: ContourAnnotation[] | null;
  fullImage?: ViewportAabb | null;
};

/**
 * - sync: viewport / LOD / toggles
 * - settled: WS frame applied / dropped (+ resync from pendingCatchUp XOR applied:false)
 *   `applied: true`: mark centroidsReady when appropriate; patches -> ready
 *   `applied: false`: clear coordKey/centroidsReady so retry can re-request same view
 * - fault: wire/parse/reconnect/no-seg - abandon open cell + clear flights
 * - wire_open: socket reopen - fault+retry if flying, else flush_idle
 * - reset: path change (`all`) or nuclei/filter (`cell` does not touch patches)
 * - patches: request / clear
 * - sent: wire send succeeded (marks flight)
 *
 * Idle coalesce lives in the hub (`pendingPayload` + animation-finish/rAF);
 * the reducer only schedules `cell_net` with timing idle|loading.
 */
export type OverlayEvent =
  | { type: 'sync'; snapshot: OverlaySyncSnapshot }
  | { type: 'settled'; kind: SettleKind; applied: boolean }
  | { type: 'fault'; retry: boolean }
  | { type: 'wire_open' }
  | {
      type: 'reset';
      scope: 'all' | 'cell';
      /**
       * Leave what is on the canvas alone. A same-slide reload replaces data the
       * viewer is still looking at, and clearing here empties the overlay for the
       * whole backend rebind — seconds on a large slide — for no gain: the frame
       * that replaces it repaints unconditionally (the paint record is forgotten
       * with it), and an emptied result still arrives as an empty frame and
       * clears. Only a real teardown — layer off, slide switch — clears here.
       */
      keepPaint?: boolean;
    }
  | { type: 'patches'; op: 'request' | 'clear'; image?: ViewportAabb }
  | { type: 'sent'; layer: 'cell'; payload: NetworkPayload }
  | { type: 'sent'; layer: 'patches' };

export function createOverlayState(): OverlayState {
  return {
    generation: 0,
    mode: 'none',
    coordKey: '',
    centroidsReady: false,
    cellFlight: null,
    cellFlightShowsSpinner: false,
    patches: 'idle',
    patchesQueued: false,
    pendingCatchUp: null,
    faultRetries: 0,
  };
}

/** How many times in a row a fault may re-request before the machine gives up. */
const MAX_FAULT_RETRIES = 3;

/** Hub idle-flush guard - stale generation or open flight must not send. */
export function canSendIdlePayload(
  state: OverlayState,
  payload: NetworkPayload,
): boolean {
  return payload.generation === state.generation && !state.cellFlight;
}

function maybePushPatches(
  effects: OverlayEffect[],
  next: OverlayState,
  snap: OverlaySyncSnapshot,
): void {
  if (
    !snap.showPatches ||
    next.patches !== 'idle' ||
    !snap.fullImage ||
    effects.some((e) => e.type === 'patches_net')
  ) {
    return;
  }
  effects.push({ type: 'patches_net', image: snap.fullImage });
}

function markPendingCatchUp(next: OverlayState, refetch: boolean): OverlayState {
  // Escalate reuse -> refetch if either side asks for refetch.
  const kind = refetch || next.pendingCatchUp === 'refetch' ? 'refetch' : 'reuse';
  return { ...next, pendingCatchUp: kind };
}

function pushCancelIdle(effects: OverlayEffect[]): void {
  if (!effects.some((e) => e.type === 'cancel_idle')) {
    effects.push({ type: 'cancel_idle' });
  }
}

function pushAbandonCell(effects: OverlayEffect[], kind: OverlayWsType): void {
  effects.push({ type: 'abandon_cell', kind });
}

/** Nuclei on -> explicit (3-tier); filter-only / off -> continuous (2-tier). */
export function overlayIntentForNuclei(showBackend: boolean): OverlayIntent {
  return showBackend ? 'explicit' : 'continuous';
}

/**
 * Patches phase machine:
 *   flying + applied   -> ready
 *   flying + dropped   -> idle
 *   idle/ready + *     -> unchanged (orphan/late settle must not flip phase)
 */
function settlePatchesPhase(
  phase: PatchesPhase,
  applied: boolean,
): PatchesPhase {
  if (phase !== 'flying') return phase;
  return applied ? 'ready' : 'idle';
}

function canUseLocalCellCache(snap: OverlaySyncSnapshot): boolean {
  return !snap.refetch && !!snap.instanceId && !!snap.path;
}

function pushClearPaintForMode(
  effects: OverlayEffect[],
  prevMode: OverlayMode,
): void {
  if (prevMode === 'centroids') {
    effects.push({ type: 'paint', layer: 'centroids', data: null });
  }
  if (isViewportCellMode(prevMode)) {
    effects.push({ type: 'paint', layer: 'cells', data: null });
  }
}

function buildCellNetEffect(opts: {
  state: OverlayState;
  snap: OverlaySyncSnapshot;
  mode: Exclude<OverlayMode, 'none'>;
  image: ViewportAabb;
  viewportCoordKey: string;
  modeChanged: boolean;
}): OverlayEffect {
  const { state, snap, mode, image, viewportCoordKey, modeChanged } = opts;
  // Contours/annotations follow the viewport through zoom springs — idle-coalesce
  // until animation-finish (or rAF when already settled). Immediate loading on
  // every modeChanged frame caused a zoom request storm (abandon every other
  // frame) and a long spinner despite ~30–50ms backend replies.
  const viewportCell = isViewportCellMode(mode);
  const loading =
    !!snap.refetch ||
    (!viewportCell && (snap.intent === 'explicit' || modeChanged));
  return {
    type: 'cell_net',
    payload: {
      generation: state.generation,
      coordKey: mode === 'centroids' ? '' : viewportCoordKey,
      wsType: wsTypeFor(mode),
      image,
      useClassification: snap.classificationEnabled,
      showsSpinner: loading,
    },
    timing: loading ? 'loading' : 'idle',
  };
}

export function reduceOverlay(
  state: OverlayState,
  event: OverlayEvent,
): { state: OverlayState; effects: OverlayEffect[] } {
  switch (event.type) {
    case 'sync':
      return reduceSync(state, event.snapshot);
    case 'settled': {
      const { kind, applied } = event;
      let next = { ...state };
      const effects: OverlayEffect[] = [];
      if (kind === 'patches') {
        const wasFlying = next.patches === 'flying';
        const queued = next.patchesQueued;
        next = {
          ...next,
          patches: settlePatchesPhase(next.patches, applied),
          patchesQueued: false,
        };
        if (queued || (wasFlying && !applied)) {
          effects.push({ type: 'resync', scope: 'patches' });
        }
        return { state: next, effects };
      }
      const catchUp = state.pendingCatchUp;
      // A frame landed, so the fault budget is spent on nothing — reset it.
      if (applied && next.faultRetries !== 0) {
        next = { ...next, faultRetries: 0 };
      }

      if (
        applied &&
        next.mode === 'centroids' &&
        next.cellFlight === 'centroids'
      ) {
        next = { ...next, centroidsReady: true };
      }
      if (!applied) {
        next = { ...next, coordKey: '', centroidsReady: false };
      }
      next = { ...next, cellFlight: null, cellFlightShowsSpinner: false, pendingCatchUp: null };
      if (catchUp != null) {
        effects.push({
          type: 'resync',
          refetch: catchUp === 'refetch',
        });
      } else if (!applied) {
        effects.push({ type: 'resync' });
      }
      return { state: next, effects };
    }
    case 'fault': {
      const hadCell = state.cellFlight;
      const hadPatchesFlying = state.patches === 'flying';
      const catchUp = hadCell ? state.pendingCatchUp : null;
      // A catch-up is a request the viewport already asked for, not a retry of
      // the failure — it does not spend the fault budget.
      const mayRetry = event.retry && state.faultRetries < MAX_FAULT_RETRIES;
      const spendsBudget = event.retry && catchUp == null;
      // Only invalidate cell readiness when a cell flight is involved - patches-only
      // reconnect must not force a full-slide centroids re-fetch.
      const next: OverlayState = {
        ...state,
        cellFlight: null,
        cellFlightShowsSpinner: false,
        pendingCatchUp: null,
        ...(hadCell ? { coordKey: '', centroidsReady: false } : {}),
        patches: hadPatchesFlying ? 'idle' : state.patches,
        patchesQueued: hadPatchesFlying ? false : state.patchesQueued,
        faultRetries:
          spendsBudget && mayRetry ? state.faultRetries + 1 : state.faultRetries,
      };
      const effects: OverlayEffect[] = [];
      if (hadCell) pushAbandonCell(effects, hadCell);
      pushCancelIdle(effects);
      // Honor pending catch-up first (same mutual exclusion as settled).
      if (catchUp != null) {
        effects.push({
          type: 'resync',
          refetch: catchUp === 'refetch',
        });
      } else if (mayRetry) {
        // Patches-only: don't retick cell LOD. Otherwise a normal sync is enough
        // (maybePushPatches is a no-op unless patches are idle).
        effects.push(
          hadPatchesFlying && !hadCell
            ? { type: 'resync', scope: 'patches' }
            : { type: 'resync' },
        );
      }
      return { state: next, effects };
    }
    case 'wire_open': {
      if (state.cellFlight || state.patches === 'flying') {
        return reduceOverlay(state, { type: 'fault', retry: true });
      }
      return { state, effects: [{ type: 'flush_idle' }] };
    }
    case 'reset': {
      const effects: OverlayEffect[] = [{ type: 'cancel_idle' }];
      // Toggle off resets to mode none before sync — sync then sees modeChanged
      // false and would skip paint:null. Clear here so the hub drops cells and
      // the paint-dedupe ref cannot block the next cache-hit open. `keepPaint`
      // opts out for a reload of the slide already on screen (see the event).
      if (!event.keepPaint) {
        pushClearPaintForMode(effects, state.mode);
      }
      if (event.scope === 'cell') {
        return {
          state: {
            ...state,
            generation: state.generation + 1,
            mode: 'none',
            coordKey: '',
            centroidsReady: false,
            pendingCatchUp: state.cellFlight ? 'refetch' : null,
            faultRetries: 0,
          },
          effects,
        };
      }
      if (state.cellFlight) pushAbandonCell(effects, state.cellFlight);
      return {
        state: {
          ...createOverlayState(),
          generation: state.generation + 1,
        },
        effects,
      };
    }
    case 'patches': {
      if (event.op === 'clear') {
        return {
          state: { ...state, patches: 'idle', patchesQueued: false },
          effects: [],
        };
      }
      if (!event.image) return { state, effects: [] };
      if (state.patches === 'flying') {
        return { state: { ...state, patchesQueued: true }, effects: [] };
      }
      return {
        state,
        effects: [{ type: 'patches_net', image: event.image }],
      };
    }
    case 'sent':
      if (event.layer === 'cell') {
        return {
          state: {
            ...state,
            coordKey: event.payload.coordKey,
            cellFlight: event.payload.wsType,
            cellFlightShowsSpinner: event.payload.showsSpinner,
          },
          effects: [],
        };
      }
      return {
        state: { ...state, patches: 'flying' },
        effects: [],
      };
    default:
      return { state, effects: [] };
  }
}

function reduceSync(
  state: OverlayState,
  snap: OverlaySyncSnapshot,
): { state: OverlayState; effects: OverlayEffect[] } {
  const effects: OverlayEffect[] = [];
  let next: OverlayState = { ...state };

  if (snap.refetch) {
    // Never clear cellFlight here - defer via pendingCatchUp.
    // Patches readiness is owned by reset scope:'all' / patches clear, not refetch.
    next = {
      ...next,
      coordKey: '',
      centroidsReady: false,
    };
    if (next.cellFlight) {
      next = markPendingCatchUp(next, true);
    }
    pushCancelIdle(effects);
  }

  const desiredMode: OverlayMode =
    resolveOverlayRequest({
      zoom: snap.zoom,
      centroidThreshold: snap.centroidThreshold,
      threshold: snap.threshold,
      needOverlay: snap.needOverlay,
      isImageFile: snap.isImageFile,
      intent: snap.intent,
    }) ?? 'none';

  const viewport = snap.coordinates.image;
  const viewportCoordKey = coordKeyOf(viewport);
  const fullImage = snap.fullImage ?? null;

  const modeChanged = next.mode !== desiredMode;
  if (modeChanged) {
    const prevMode = next.mode;
    next = {
      ...next,
      generation: next.generation + 1,
      mode: desiredMode,
      coordKey: '',
    };
    pushCancelIdle(effects);

    if (desiredMode === 'none') {
      pushClearPaintForMode(effects, prevMode);
    }
  }

  if (desiredMode === 'none') {
    // Turning overlay off must not leave cellFlight wedged waiting for a reply.
    if (next.cellFlight) {
      const abandoned = next.cellFlight;
      next = { ...next, cellFlight: null, cellFlightShowsSpinner: false, pendingCatchUp: null };
      pushAbandonCell(effects, abandoned);
    }
    maybePushPatches(effects, next, snap);
    return { state: next, effects };
  }

  if (
    desiredMode === 'centroids' &&
    snap.cacheHit &&
    canUseLocalCellCache(snap)
  ) {
    if (modeChanged || !next.centroidsReady) {
      effects.push({ type: 'paint', layer: 'centroids', data: snap.cacheHit });
    }
    next = { ...next, centroidsReady: true };
    // Full-slide centroids from cache fully satisfy this mode — an open cell
    // flight (usually a stale contour request) must not stay wedged, or later
    // zooms only mark catch-up and never send again if the reply never arrives.
    if (next.cellFlight) {
      const abandoned = next.cellFlight;
      next = { ...next, cellFlight: null, cellFlightShowsSpinner: false, pendingCatchUp: null };
      pushAbandonCell(effects, abandoned);
    }
    pushCancelIdle(effects);
    maybePushPatches(effects, next, snap);
    return { state: next, effects };
  }

  if (
    desiredMode === 'contours' &&
    snap.contourCacheHit &&
    canUseLocalCellCache(snap)
  ) {
    const viewportMoved = modeChanged || next.coordKey !== viewportCoordKey;
    if (viewportMoved) {
      effects.push({ type: 'paint', layer: 'cells', data: snap.contourCacheHit });
    }
    if (next.cellFlight) {
      // Live viewport is already covered — drop the in-flight fetch instead of
      // waiting for a stale reply + catch-up (which also risked FIFO skew).
      const abandoned = next.cellFlight;
      next = {
        ...next,
        cellFlight: null,
        cellFlightShowsSpinner: false,
        pendingCatchUp: null,
        coordKey: viewportCoordKey,
      };
      pushAbandonCell(effects, abandoned);
    } else {
      next = {
        ...next,
        coordKey: viewportCoordKey,
        pendingCatchUp: null,
      };
    }
    pushCancelIdle(effects);
    maybePushPatches(effects, next, snap);
    return { state: next, effects };
  }

  if (desiredMode === 'centroids' && !fullImage) {
    // Can't send centroids yet. If a viewport flight is still open it will never
    // satisfy this mode — abandon so a later sync with fullImage can send.
    if (isViewportCellFlight(next.cellFlight)) {
      const abandoned = next.cellFlight!;
      next = { ...next, cellFlight: null, cellFlightShowsSpinner: false, pendingCatchUp: null };
      pushAbandonCell(effects, abandoned);
    }
    maybePushPatches(effects, next, snap);
    return { state: next, effects };
  }

  // Mismatched open flights block the opposite LOD forever if the reply is lost.
  // Drop them so the desired mode can send (or wait on a matching flight only).
  if (desiredMode === 'centroids' && isViewportCellFlight(next.cellFlight)) {
    const abandoned = next.cellFlight!;
    next = { ...next, cellFlight: null, cellFlightShowsSpinner: false, pendingCatchUp: null };
    pushAbandonCell(effects, abandoned);
  } else if (
    isViewportCellMode(desiredMode) &&
    next.cellFlight === 'centroids'
  ) {
    next = { ...next, cellFlight: null, cellFlightShowsSpinner: false, pendingCatchUp: null };
    pushAbandonCell(effects, 'centroids');
  }

  const wantsCentroidsNet =
    desiredMode === 'centroids' &&
    (!next.centroidsReady || !!snap.refetch);

  const wantsViewportCellNet =
    isViewportCellMode(desiredMode) &&
    (modeChanged || !!snap.refetch || next.coordKey !== viewportCoordKey);

  if ((wantsViewportCellNet || wantsCentroidsNet) && next.cellFlight) {
    // Same-kind flight still open: coalesce. Viewport pans always need catch-up.
    // Matching centroids flight: only when LOD/mode changed (refetch already flagged).
    // Do NOT abandon-and-resend on the second viewport change — that fires every
    // other rAF during zoom springs and queues dozens of all_annotations calls.
    // Settle → resync (pendingCatchUp) fetches the final viewport once.
    // Still refresh the idle pending payload to the latest viewport so a throttle
    // flush / animation-finish after settle cannot send a stale AABB.
    if (wantsViewportCellNet || modeChanged) {
      next = markPendingCatchUp(next, false);
      if (wantsViewportCellNet && isViewportCellMode(desiredMode)) {
        effects.push(
          buildCellNetEffect({
            state: next,
            snap,
            mode: desiredMode,
            image: viewport,
            viewportCoordKey,
            modeChanged: false,
          }),
        );
      }
      maybePushPatches(effects, next, snap);
      return { state: next, effects };
    }
    maybePushPatches(effects, next, snap);
    return { state: next, effects };
  }

  if (wantsCentroidsNet || wantsViewportCellNet) {
    // Centroids already returned early when fullImage is missing.
    effects.push(
      buildCellNetEffect({
        state: next,
        snap,
        mode: desiredMode,
        image: desiredMode === 'centroids' ? fullImage! : viewport,
        viewportCoordKey,
        modeChanged,
      }),
    );
  }

  maybePushPatches(effects, next, snap);
  return { state: next, effects };
}
