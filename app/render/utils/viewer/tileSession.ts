/**
 * Bring a viewer back when the backend loses its session.
 *
 * A service restart (crash, OOM, deploy) drops every session, and nothing else
 * re-creates one: the websocket reconnect rebinds overlays only. Each tile is
 * then refused (INSTANCE_OWNER_MISMATCH), and regions not already cached stay
 * on the coarse level until the file is reopened. A 409 is the same story for a
 * session that moved to another tile epoch.
 *
 * Restore the session under the same instance id (one request at a time,
 * backing off when it fails), then reload the failed tiles in place. A new tile
 * source would rebuild the viewer and send it home, so the restored epoch is
 * kept on the tile source instead, and tileDemand puts it on every request.
 */

import { isTileSessionLost } from "./tileResponse";
import { reviveFailedTiles } from "./tileRevive";

const RETRY_DELAYS_MS = [5_000, 15_000, 60_000];

/** The epoch a restored session serves; tileDemand sends it as content_epoch. */
export const restoredEpoch = (source: any): number | undefined => source?.__tileEpoch;

export interface TileSessionOptions {
  /** True for a tile source of the viewer's current instance. */
  owns: (source: any) => boolean;
  /** Re-create the backend session; resolves to its tile epoch, rejects when it cannot. */
  restore: () => Promise<number>;
  /** Called once when every retry has failed. */
  onGiveUp?: () => void;
}

const epochIn = (url: unknown): string | null => {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url, window.location.href).searchParams.get("content_epoch");
  } catch {
    return null;
  }
};

/** Watch `viewer` for a lost backend session. Returns the unsubscribe. */
export function watchTileSession(viewer: any, { owns, restore, onGiveUp }: TileSessionOptions): () => void {
  let disposed = false;
  let running = false;
  let failures = 0;
  let notBefore = 0;
  // Restores that succeed yet keep being needed (tiles and API calls sent as
  // different users): past this many a minute, back off as if they had failed.
  const recent: number[] = [];

  // Asked by tileDemand for each failed tile: skip OSD's own retry, which waits
  // tileRetryDelay; the restore reloads the tile as soon as it finishes.
  const holds = (request: XMLHttpRequest | undefined) =>
    !disposed && (running || isTileSessionLost(request));
  viewer.__tileSessionHolds = holds;

  const run = async () => {
    running = true;
    try {
      const now = Date.now();
      while (recent.length && now - recent[0] > 60_000) recent.shift();
      if (recent.length >= 10) throw new Error("Too many restores in a minute");
      recent.push(now);
      const epoch = await restore();
      if (disposed) return;
      failures = 0;
      notBefore = 0;
      for (let i = 0; i < viewer.world.getItemCount(); i++) {
        const source = viewer.world.getItemAt(i)?.source;
        if (owns(source)) source.__tileEpoch = epoch;
      }
      reviveFailedTiles(viewer);
    } catch (error) {
      if (disposed) return;
      console.warn("[tileSession] restoring the instance failed:", error);
      if (failures < RETRY_DELAYS_MS.length) {
        notBefore = Date.now() + RETRY_DELAYS_MS[failures++];
      } else {
        notBefore = Infinity;
        onGiveUp?.();
      }
    } finally {
      running = false;
    }
  };

  const onTileFailed = (event: any) => {
    if (disposed || !isTileSessionLost(event?.tileRequest)) return;
    // A closed slide's tiles are refused too: only the current instance counts.
    const image = event?.tiledImage;
    if (!image || viewer.world?.getIndexOfItem?.(image) < 0 || !owns(image.source)) return;
    // Sent before a restore that has since moved the source to a new epoch:
    // nothing to restore, just load it again (after OSD marks it missing).
    const epoch = restoredEpoch(image.source);
    const sent = epochIn(event.tileRequest?.responseURL);
    if (epoch !== undefined && sent !== null && sent !== String(epoch)) {
      queueMicrotask(() => {
        if (!disposed) reviveFailedTiles(viewer);
      });
      return;
    }
    if (running || Date.now() < notBefore) return;
    void run();
  };

  viewer.addHandler("tile-load-failed", onTileFailed);
  return () => {
    disposed = true;
    if (viewer.__tileSessionHolds === holds) delete viewer.__tileSessionHolds;
    viewer.removeHandler("tile-load-failed", onTileFailed);
  };
}
