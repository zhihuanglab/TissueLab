/**
 * Bring back tiles OpenSeadragon gave up on.
 *
 * After its retries OSD marks a failed tile missing (exists=false) and never
 * requests it again: whatever made it fail (an expired token, a timeout, a
 * 500, a backend restart), that region stays on the coarser level for the rest
 * of the session.
 *
 * A tile that failed for good gets a few more tries, further apart each time,
 * then is left alone: a region the backend can never serve (a corrupt tile
 * answers 500 every time) must not be requested for as long as the page is
 * open. A new token revives everything once more (reviveFailedTiles).
 */

import { isPermanentTileFailure } from "./tileResponse";

const REVIVE_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

/** Kept on the tile, so reviveFailedTiles and every watcher see the same state. */
interface ReviveState {
  /** Scheduled tries used since the tile last loaded. */
  attempts: number;
  /** When the next scheduled try is due. */
  dueAt: number;
  /** Fails the same way every time: never revive. */
  blocked: boolean;
  /** OSD itself will try again (it flags the tile missing between tries). */
  retryPending: boolean;
}

const stateOf = (tile: any): ReviveState =>
  (tile.__revive ??= { attempts: 0, dueAt: Infinity, blocked: false, retryPending: false });

const canRevive = (tile: any): boolean =>
  !!tile && tile.exists === false && !tile.loading &&
  !tile.__revive?.blocked && !tile.__revive?.retryPending;

/**
 * Make OSD request the tile again. Setting exists back alone requests nothing:
 * with only missing tiles left OSD counts the image fully loaded and stops
 * re-evaluating it, hence _needsUpdate.
 */
const revive = (tile: any, tiledImage: any) => {
  tile.exists = true;
  if (tiledImage) tiledImage._needsUpdate = true;
};

/** Make every tile OSD gave up on loadable again (after a token swap). */
export function reviveFailedTiles(viewer: any): void {
  let revived = false;
  const count = viewer.world?.getItemCount?.() ?? 0;
  for (let i = 0; i < count; i++) {
    const item = viewer.world.getItemAt(i);
    const matrix = item?.tilesMatrix ?? {};
    for (const level in matrix) {
      for (const x in matrix[level]) {
        for (const y in matrix[level][x]) {
          const tile = matrix[level][x][y];
          if (!canRevive(tile)) continue;
          revive(tile, item);
          revived = true;
        }
      }
    }
  }
  if (revived) viewer.forceRedraw?.();
}

/** Give tiles that failed for good a capped series of further tries. Returns the unsubscribe. */
export function watchTileRevive(viewer: any): () => void {
  // Tiles waiting for a scheduled try, with their tiled image.
  const waiting = new Map<any, any>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDueAt = Infinity;

  // A hidden or offline page waits for visibilitychange / online instead of
  // spending a try that cannot succeed.
  const canRequest = () =>
    document.visibilityState === "visible" &&
    (typeof navigator === "undefined" || navigator.onLine !== false);

  const clearTimer = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    timerDueAt = Infinity;
  };

  // One timer per viewer, for the earliest due tile. A burst of failures (a
  // backend restart fails every visible tile) arms it once, not per tile.
  const arm = (dueAt: number) => {
    if (dueAt >= timerDueAt) return;
    clearTimer();
    timerDueAt = dueAt;
    timer = setTimeout(runDue, Math.max(0, dueAt - Date.now()));
  };

  // From the timer, or from the page coming back (visible / online).
  const runDue = () => {
    clearTimer();
    if (viewer.isDestroyed?.() || !canRequest()) return;
    const now = Date.now();
    let revived = false;
    for (const [tile, item] of waiting) {
      if (stateOf(tile).dueAt > now) continue;
      waiting.delete(tile);
      if (viewer.world?.getIndexOfItem?.(item) < 0 || !canRevive(tile)) continue;
      revive(tile, item);
      revived = true;
    }
    if (revived) viewer.forceRedraw?.();
    let next = Infinity;
    for (const tile of waiting.keys()) next = Math.min(next, stateOf(tile).dueAt);
    if (next !== Infinity) arm(next);
  };

  const onTileFailed = (event: any) => {
    const tile = event?.tile;
    if (!tile) return;
    const state = stateOf(tile);
    // OSD fires this for every try, and starts a retry after a delay during
    // which the tile sits in neither of its queues. Only its last try is ours.
    state.retryPending = (event.tries ?? 0) < 1 + (viewer.tileRetryMax ?? 0);
    if (isPermanentTileFailure(event.tileRequest)) {
      state.blocked = true;
      waiting.delete(tile);
      return;
    }
    if (state.retryPending || state.attempts >= REVIVE_DELAYS_MS.length) return;
    state.dueAt = Date.now() + REVIVE_DELAYS_MS[state.attempts++];
    waiting.set(tile, event.tiledImage);
    arm(state.dueAt);
  };

  const onTileLoaded = (event: any) => {
    const tile = event?.tile;
    if (!tile) return;
    waiting.delete(tile);
    delete tile.__revive;
  };

  const onRemoveItem = (event: any) => {
    for (const [tile, item] of waiting) if (item === event?.item) waiting.delete(tile);
  };

  viewer.addHandler("tile-load-failed", onTileFailed);
  viewer.addHandler("tile-loaded", onTileLoaded);
  viewer.world?.addHandler("remove-item", onRemoveItem);
  window.addEventListener("online", runDue);
  document.addEventListener("visibilitychange", runDue);
  return () => {
    clearTimer();
    waiting.clear();
    viewer.removeHandler("tile-load-failed", onTileFailed);
    viewer.removeHandler("tile-loaded", onTileLoaded);
    viewer.world?.removeHandler("remove-item", onRemoveItem);
    window.removeEventListener("online", runDue);
    document.removeEventListener("visibilitychange", runDue);
  };
}
