import OpenSeadragon from 'openseadragon';
import { restoredEpoch } from './tileSession';

// The Tile URL identifies pixels. Demand lifetime belongs to the transport,
// rather than a generation captured when OSD first creates the Tile.
const active = new WeakMap<object, Set<any>>();
const cancelled = new WeakSet<object>();
const stopped = new WeakSet<object>();

// OSD logs every failed tile as an error, cancellations included. A cancel
// completes synchronously (abort -> fail -> _onTileLoad), so demote OSD's
// errors to debug for that call only. OSD.console is window.console itself:
// swap the reference, never patch its methods.
let quiet: any = null;
let quietBase: any = null;
function quietly(cancel: () => void) {
  const osd = OpenSeadragon as any;
  const base = osd.console;
  if (base === quiet) return cancel();
  // Built once and reused: cancels come in bursts on every pan or zoom.
  if (base !== quietBase) {
    quietBase = base;
    quiet = Object.assign(Object.create(base), { error: base.debug.bind(base) });
  }
  osd.console = quiet;
  try {
    cancel();
  } finally {
    osd.console = base;
  }
}

export function tileTransport() {
  const base = OpenSeadragon.TileSource.prototype as any;
  return {
    downloadTileStart(this: any, job: any) {
      const viewer = job.tile?.tiledImage?.viewer;
      const jobs = viewer ? (active.get(viewer) ?? new Set<any>()) : null;
      if (viewer && jobs) active.set(viewer, jobs);
      jobs?.add(job);
      job.userData.demandSettled = false;
      // Retries reuse the job, while the auth guard replaces its callbacks on
      // each attempt. Rewrap those callbacks without nesting our old wrappers.
      if (job.finish !== job.userData.demandFinish) {
        job.userData.demandFinishBase = job.finish;
      }
      if (job.fail !== job.userData.demandFail) {
        job.userData.demandFailBase = job.fail;
      }
      const finish = job.userData.demandFinishBase;
      const fail = job.userData.demandFailBase;
      job.finish = job.userData.demandFinish = function (...args: any[]) {
        if (job.userData.demandSettled) return;
        try {
          // The auth guard may reject a JSON envelope by calling job.fail().
          // Let that failure run before marking this attempt settled.
          return finish.apply(this, args);
        } finally {
          job.userData.demandSettled = true;
          jobs?.delete(job);
        }
      };
      job.fail = job.userData.demandFail = function (...args: any[]) {
        if (job.userData.demandSettled) return;
        job.userData.demandSettled = true;
        jobs?.delete(job);
        // tileSession reloads this tile once the session is back; OSD's own
        // retry would wait tileRetryDelay and resend the old URL.
        if (viewer?.__tileSessionHolds?.(args[1])) job.tries = 1 + (viewer.tileRetryMax ?? 0);
        return fail.apply(this, args);
      };
      // Recheck demand whenever a job actually starts: OSD queues jobs past
      // its loader limit and starts them later (tries === 1), and its retry
      // timer restarts failed ones. Both may be off-screen by then.
      if (job.userData.demandCancelled || (viewer && stopped.has(viewer)) ||
          (viewer && !needed(viewer, job.tile))) {
        markCancelled(job.tile);
        job.tries = 1 + (viewer?.tileRetryMax ?? 0);
        quietly(() => job.fail('Image load aborted: obsolete tile demand.', null));
        return;
      }
      const url = new URL(job.src, window.location.href);
      // A session restored by tileSession serves a newer epoch than the URL holds.
      const epoch = restoredEpoch(job.tile?.tiledImage?.source);
      if (epoch !== undefined) url.searchParams.set('content_epoch', String(epoch));
      const hints: Record<string, string> = {
        'X-Tile-Priority': viewer?._tileBackground ? '2' : job.tile?.level === 0 ? '0' : '1',
      };
      if (job.tile) job.tile.__demandCancelled = false;
      // OSD 6 records only the squared distance to the viewport centre.
      const distance = Math.sqrt(Number(job.tile?.squaredDistance));
      if (Number.isFinite(distance)) hints['X-Tile-Distance'] = String(Math.min(1e6, Math.max(0, distance)));
      // Scheduling hints go in headers: the URL is the browser's cache key, and
      // a distance in it made every request for the same tile a miss. A copy,
      // since tileAuth hands the job the tile's own header object.
      job.ajaxHeaders = { ...job.ajaxHeaders, ...hints };
      job.src = url.toString();
      base.downloadTileStart.call(this, job);
    },
  };
}

// tileRevive must not spend its budget re-requesting tiles nobody wants.
function markCancelled(tile: any) {
  if (!tile) return;
  cancelled.add(tile);
  tile.__demandCancelled = true;
}

export function intersects(a: any, b: any) {
  return a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
}

function needed(viewer: any, tile: any, current?: any, target?: any) {
  const image = tile?.tiledImage;
  if (!image) return true;
  if (viewer.world.getIndexOfItem(image) < 0) return false;
  if (tile.level === 0) return true;
  current ??= viewer.viewport.getBounds(true).getBoundingBox();
  target ??= viewer.viewport.getBounds(false).getBoundingBox();
  const width = image.source.dimensions.x;
  const bounds = image.imageToViewportRectangle(tile.bounds.x * width,
    tile.bounds.y * width, tile.bounds.width * width, tile.bounds.height * width).getBoundingBox();
  return intersects(bounds, current) || intersects(bounds, target);
}

export function installTileDemand(viewer: any) {
  let disposed = false;
  stopped.delete(viewer);
  const cancel = (job: any) => {
    if (!active.get(viewer)?.has(job)) return;
    markCancelled(job.tile);
    job.userData.demandCancelled = true;
    // Do not schedule another retry after an intentional cancellation.
    job.tries = 1 + viewer.tileRetryMax;
    quietly(() => job.abort());
  };
  const update = () => {
    const current = viewer.viewport.getBounds(true).getBoundingBox();
    const target = viewer.viewport.getBounds(false).getBoundingBox();
    for (const job of Array.from(active.get(viewer) ?? [])) {
      const tile = job.tile;
      // Retain both the presently displayed region and the animation target.
      if (!needed(viewer, tile, current, target)) cancel(job);
    }
  };
  const failed = ({tile}: any) => {
    if (!cancelled.delete(tile)) return;
    // OSD writes exists=false after this event. Restore after that callback,
    // so returning to the region can request it again without resetting caches.
    queueMicrotask(() => {
      if (disposed || tile.tiledImage?.viewer !== viewer) return;
      tile.exists = true;
      viewer.forceRedraw();
    });
  };
  const overview = ({item}: any) => {
    // OSD 6.1 has no public single-tile prefetch API. Reuse its own Tile and
    // ImageLoader, so this request shares cache, limits and completion events.
    if (!item?._getTile || !item?._loadTile || item.source.minLevel !== 0) return;
    const time = Date.now();
    const tile = item._getTile(0, 0, 0, time, item.source.getNumTiles(0));
    if (!tile.loaded && !tile.loading) item._loadTile(tile, time);
  };
  const removed = ({item}: any) => {
    for (const job of Array.from(active.get(viewer) ?? [])) {
      if (job.tile?.tiledImage === item) cancel(job);
    }
  };
  viewer.addHandler('viewport-change', update);
  viewer.addHandler('tile-load-failed', failed);
  viewer.world.addHandler('add-item', overview);
  viewer.world.addHandler('remove-item', removed);
  for (let i = 0; i < viewer.world.getItemCount(); i++) overview({item: viewer.world.getItemAt(i)});
  return () => {
    disposed = true;
    stopped.add(viewer);
    viewer.removeHandler('viewport-change', update);
    viewer.removeHandler('tile-load-failed', failed);
    viewer.world.removeHandler('add-item', overview);
    viewer.world.removeHandler('remove-item', removed);
    for (const job of Array.from(active.get(viewer) ?? [])) cancel(job);
    active.delete(viewer);
  };
}
