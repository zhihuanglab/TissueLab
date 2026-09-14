/**
 * Viewport contour cache (LOD: all_annotations).
 * Hit only when the live viewport is a subset of an *actually fetched* request AABB.
 * Do not inflate / union coverage — that falsely claims unfetched gaps and blocks
 * refresh during slow pans.
 * Covered windows are capped: keep up to MAX nearest the newest fetch (intersecting /
 * containing count as distance 0; larger windows win ties). Newest always kept.
 * Keyed by instanceId::path — clear on slide switch to avoid cross-slide hits.
 */
import { type ViewportAabb, aabbArea, expandAabb, isSubsetAabb } from './viewportGeometryCache';
import { geometryIntersectsAabb, getContourGeometry } from './contourGeometry';

export type ContourAnnotation = {
  id: number | string;
  /** Flat image-space coords [x0, y0, x1, y1, ...]; point count is length / 2. */
  points?: Int32Array;
  [key: string]: unknown;
};

/**
 * Extra margin when filtering cache → paint so cells at the edge don't pop during
 * small pans before the next paint. Independent of wire prefetch.
 */
const CONTOUR_PAINT_MARGIN_RATIO = 0.05;

/**
 * True if the contour's point AABB intersects `aabb` (empty / missing points → false).
 * The AABB itself is memoised per contour object — re-sweeping every point of
 * every cached cell on each frame was the dominant cost of the overlay pipeline.
 */
function contourIntersectsAabb(
  annotation: ContourAnnotation,
  aabb: ViewportAabb,
): boolean {
  return geometryIntersectsAabb(
    getContourGeometry(annotation),
    aabb.x1,
    aabb.y1,
    aabb.x2,
    aabb.y2,
  );
}

/**
 * Keep only contours that intersect `aabb`.
 * Returns the same array ref when every annotation is kept (avoids React/WebGL churn).
 */
function filterContoursForPaint(
  annotations: ContourAnnotation[],
  aabb: ViewportAabb,
): ContourAnnotation[] {
  if (annotations.length === 0) return annotations;
  let keptAll = true;
  const out: ContourAnnotation[] = [];
  for (let i = 0; i < annotations.length; i++) {
    const ann = annotations[i];
    if (contourIntersectsAabb(ann, aabb)) {
      out.push(ann);
    } else {
      keptAll = false;
    }
  }
  return keptAll ? annotations : out;
}

/** What the cell overlay currently holds, per slide. See {@link resolveContourPaint}. */
type PaintedContours = {
  /** The cache array the painted set was selected from. */
  source: ContourAnnotation[];
  /** The margin-expanded viewport it was filtered against. */
  coverage: ViewportAabb;
};

const paintedStore = new Map<string, PaintedContours>();

/**
 * Choose the cells to paint for `viewport`, and remember the choice.
 *
 * Painting is skipped when the same cache array is already on the canvas and the
 * viewport has not left the box that set was filtered against, so a pan does not
 * re-filter the cache and re-upload every vertex buffer per frame.
 *
 * That skip is only sound if every writer of the cell overlay keeps this record
 * honest. Contour paints go through here; every other writer — the high-zoom
 * nuclei LOD, static images, the centroid LOD, the nuclei toggle — MUST call
 * {@link forgetContourPaint}, since what they put on the canvas is not a
 * filtered view of a cache array and no coverage box describes it. Skip that and
 * the record claims coverage the canvas does not have, so the next call drops a
 * repaint it needed and cells stay unpainted.
 */
export function resolveContourPaint(opts: {
  instanceId: string;
  path: string;
  data: ContourAnnotation[];
  /** Live viewport in image space; null when it cannot be read. */
  viewport: ViewportAabb | null;
}): { skip: true } | { skip: false; toPaint: ContourAnnotation[] } {
  const { instanceId, path, data, viewport } = opts;
  const key = cacheKey(instanceId, path);

  if (!viewport) {
    // No viewport to filter against — paint everything and claim no coverage,
    // so the next call with a viewport always repaints.
    paintedStore.delete(key);
    return { skip: false, toPaint: data };
  }

  const prev = paintedStore.get(key);
  if (prev && prev.source === data && isSubsetAabb(viewport, prev.coverage)) {
    return { skip: true };
  }

  // Expand once and filter against that, so the box we remember is exactly the
  // box the painted set was selected with.
  const coverage = expandAabb(viewport, CONTOUR_PAINT_MARGIN_RATIO);
  const toPaint = filterContoursForPaint(data, coverage);
  paintedStore.set(key, { source: data, coverage });
  return { skip: false, toPaint };
}

/** Drop the painted record so the next {@link resolveContourPaint} repaints. */
export function forgetContourPaint(instanceId?: string, path?: string): void {
  if (instanceId != null && path != null) {
    paintedStore.delete(cacheKey(instanceId, path));
    return;
  }
  if (instanceId != null) {
    for (const key of [...paintedStore.keys()]) {
      if (key.startsWith(`${instanceId}::`)) paintedStore.delete(key);
    }
    return;
  }
  paintedStore.clear();
}

type ContourCacheEntry = {
  path: string;
  instanceId: string;
  /** Request AABBs that were actually fetched (wire may already include prefetch). */
  covered: ViewportAabb[];
  data: ContourAnnotation[];
};

/** Contours are heavier than centroids — cap merged cells kept in memory/GPU paint. */
const MAX_CACHE_CONTOURS = 40_000;
/** Max stored fetch windows; prune keeps those nearest the newest request. */
const MAX_COVERED_REGIONS = 64;

function cacheKey(instanceId: string, path: string): string {
  return `${instanceId}::${path}`;
}

const store = new Map<string, ContourCacheEntry>();
const pendingContourRequests = new Map<string, ViewportAabb[]>();

export function clearViewportContourCache(instanceId?: string, path?: string): void {
  // The painted record points at arrays from this cache — dropping one without
  // the other would leave the paint guard comparing against a freed generation.
  forgetContourPaint(instanceId, path);
  if (instanceId != null && path != null) {
    store.delete(cacheKey(instanceId, path));
    pendingContourRequests.delete(instanceId);
    return;
  }
  if (instanceId != null) {
    for (const key of [...store.keys()]) {
      if (key.startsWith(`${instanceId}::`)) store.delete(key);
    }
    pendingContourRequests.delete(instanceId);
    return;
  }
  store.clear();
  pendingContourRequests.clear();
}

export function getViewportContourCache(
  instanceId: string,
  path: string,
): ContourCacheEntry | null {
  return store.get(cacheKey(instanceId, path)) ?? null;
}

export function tryHitViewportContourCache(
  instanceId: string,
  path: string,
  viewport: ViewportAabb,
): ContourAnnotation[] | null {
  const entry = store.get(cacheKey(instanceId, path));
  if (!entry) return null;
  // Must be fully inside one fetched window — not an inflated union of windows.
  if (!entry.covered.some((aabb) => isSubsetAabb(viewport, aabb))) return null;
  return entry.data;
}

function aabbHalfDiag(a: ViewportAabb): number {
  return Math.hypot((a.x2 - a.x1) / 2, (a.y2 - a.y1) / 2) || 1;
}

function aabbsIntersect(a: ViewportAabb, b: ViewportAabb): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

/**
 * Prune distance to `ref` (usually newest fetch).
 * Intersecting / containing → 0 so a large low-zoom window is not dropped just
 * because the newest high-zoom window has a tiny half-diagonal.
 * Otherwise: axis-aligned edge gap / ref half-diagonal.
 */
function coverageDist(a: ViewportAabb, ref: ViewportAabb): number {
  if (
    aabbsIntersect(a, ref) ||
    isSubsetAabb(ref, a) ||
    isSubsetAabb(a, ref)
  ) {
    return 0;
  }
  const dx = Math.max(0, Math.max(a.x1 - ref.x2, ref.x1 - a.x2));
  const dy = Math.max(0, Math.max(a.y1 - ref.y2, ref.y1 - a.y2));
  return Math.hypot(dx, dy) / aabbHalfDiag(ref);
}

/**
 * Keep newest + nearest older windows. Ties: larger area, then more recent.
 * Slow pan → local corridor; jump → drop far; zoom-in → keep overlapping overview.
 */
function pruneCoveredRegions(regions: ViewportAabb[]): ViewportAabb[] {
  if (regions.length <= MAX_COVERED_REGIONS) return regions;

  const newestIdx = regions.length - 1;
  const newest = regions[newestIdx];
  const rest = regions
    .map((aabb, index) => ({
      index,
      dist: coverageDist(aabb, newest),
      area: aabbArea(aabb),
    }))
    .filter((s) => s.index !== newestIdx)
    .sort(
      (a, b) =>
        a.dist - b.dist || b.area - a.area || b.index - a.index,
    );

  const keepIdx = new Set<number>([newestIdx]);
  for (const s of rest) {
    if (keepIdx.size >= MAX_COVERED_REGIONS) break;
    keepIdx.add(s.index);
  }
  return regions.filter((_, i) => keepIdx.has(i));
}

function addCoveredRegion(
  prev: ViewportAabb[],
  requestAabb: ViewportAabb,
): ViewportAabb[] {
  // Already covered by an existing fetch → keep list unchanged.
  if (prev.some((aabb) => isSubsetAabb(requestAabb, aabb))) return prev;
  // Drop older windows fully inside this new fetch.
  const kept = prev.filter((aabb) => !isSubsetAabb(aabb, requestAabb));
  kept.push({ ...requestAabb });
  return pruneCoveredRegions(kept);
}

export function upsertViewportContourCache(opts: {
  instanceId: string;
  path: string;
  requestAabb: ViewportAabb;
  data: ContourAnnotation[];
  merge?: boolean;
}): ContourCacheEntry {
  const { instanceId, path, requestAabb, data, merge = true } = opts;
  const key = cacheKey(instanceId, path);
  const prev = store.get(key);

  let covered = [{ ...requestAabb }];
  let mergedData = data;

  const sameSlide = prev && prev.path === path && prev.instanceId === instanceId;

  if (merge && sameSlide) {
    const merged = mergeContoursById(prev.data, data);
    if (merged.length <= MAX_CACHE_CONTOURS) {
      mergedData = merged;
      covered = addCoveredRegion(prev.covered, requestAabb);
    }
    // Over cap: keep only this fetch's cells + its AABB. Claiming older covered
    // windows would be a false hit (those cells were dropped).
  }

  const entry: ContourCacheEntry = { path, instanceId, covered, data: mergedData };
  store.set(key, entry);
  return entry;
}

function mergeContoursById(
  a: ContourAnnotation[],
  b: ContourAnnotation[],
): ContourAnnotation[] {
  const map = new Map<string | number, ContourAnnotation>();
  for (const ann of a) map.set(ann.id, ann);
  for (const ann of b) map.set(ann.id, ann);
  return [...map.values()];
}

/**
 * Remember the AABB a contour request was sent for, so the reply can be paired
 * back to it — the wire frame does not echo the window.
 *
 * Contour requests are single-flight, and abandoning one dequeues here, so at
 * most one entry can legitimately be outstanding. A non-empty queue means one
 * leaked; keeping it would pair every later reply with a stale window, recording
 * coverage for a region never fetched. A false hit there suppresses the refetch
 * permanently, so drop the stale entries.
 */
export function enqueueContourRequest(instanceId: string, aabb: ViewportAabb): void {
  const stale = pendingContourRequests.get(instanceId);
  if (stale && stale.length > 0) {
    console.warn(
      '[Overlay] contour request queue out of sync; dropping stale request AABBs',
      { instanceId, dropped: stale.length },
    );
  }
  pendingContourRequests.set(instanceId, [{ ...aabb }]);
}

export function dequeueContourRequest(instanceId: string): ViewportAabb | null {
  const q = pendingContourRequests.get(instanceId);
  if (!q || q.length === 0) return null;
  const next = q.shift()!;
  if (q.length === 0) pendingContourRequests.delete(instanceId);
  else pendingContourRequests.set(instanceId, q);
  return next;
}
