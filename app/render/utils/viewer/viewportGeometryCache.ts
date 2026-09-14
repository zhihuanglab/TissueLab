/**
 * Slide-level centroid store (full-slide fetch — no AABB).
 * Contour LOD uses viewportContourCache. AABB helpers are shared by contours.
 */
import { CentroidsArray } from '../../types/centroidsArray';

export type ViewportAabb = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export function expandAabb(aabb: ViewportAabb, marginRatio = 0.1): ViewportAabb {
  const w = Math.max(0, aabb.x2 - aabb.x1);
  const h = Math.max(0, aabb.y2 - aabb.y1);
  const mx = w * marginRatio;
  const my = h * marginRatio;
  return {
    x1: aabb.x1 - mx,
    y1: aabb.y1 - my,
    x2: aabb.x2 + mx,
    y2: aabb.y2 + my,
  };
}

export function aabbArea(aabb: ViewportAabb): number {
  return Math.max(0, aabb.x2 - aabb.x1) * Math.max(0, aabb.y2 - aabb.y1);
}

export function isSubsetAabb(inner: ViewportAabb, outer: ViewportAabb): boolean {
  return (
    inner.x1 >= outer.x1 &&
    inner.y1 >= outer.y1 &&
    inner.x2 <= outer.x2 &&
    inner.y2 <= outer.y2
  );
}

export function coordKeyOf(aabb: ViewportAabb): string {
  return `${aabb.x1},${aabb.y1},${aabb.x2},${aabb.y2}`;
}

function cacheKey(instanceId: string, path: string): string {
  return `${instanceId}::${path}`;
}

const store = new Map<string, CentroidsArray>();

export function clearViewportGeometryCache(instanceId?: string, path?: string): void {
  if (instanceId != null && path != null) {
    store.delete(cacheKey(instanceId, path));
    return;
  }
  if (instanceId != null) {
    for (const key of [...store.keys()]) {
      if (key.startsWith(`${instanceId}::`)) store.delete(key);
    }
    return;
  }
  store.clear();
}

export function getCachedCentroids(instanceId: string, path: string): CentroidsArray | null {
  return store.get(cacheKey(instanceId, path)) ?? null;
}

export function setCachedCentroids(
  instanceId: string,
  path: string,
  data: CentroidsArray,
): void {
  store.set(cacheKey(instanceId, path), data);
}
