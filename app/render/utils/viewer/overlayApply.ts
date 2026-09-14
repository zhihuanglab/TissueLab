import { CentroidsArray } from '../../types/centroidsArray';
import {
  type ContourAnnotation,
  dequeueContourRequest,
  getViewportContourCache,
  upsertViewportContourCache,
} from './viewportContourCache';
import { setCachedCentroids } from './viewportGeometryCache';

function shouldPaintCentroids(
  liveZoom: number | null | undefined,
  centroidThreshold: number,
): boolean {
  if (typeof liveZoom !== 'number') return true;
  return liveZoom < centroidThreshold;
}

export function shouldPaintContours(
  liveZoom: number | null | undefined,
  centroidThreshold: number,
  isImageFile: boolean,
): boolean {
  if (isImageFile) return true;
  if (typeof liveZoom !== 'number') return true;
  return liveZoom >= centroidThreshold;
}

/**
 * Store full-slide centroids in memory; decide whether to paint for current LOD.
 */
export function applyCentroidFrame(opts: {
  instanceId: string;
  path: string;
  data: CentroidsArray;
  liveZoom: number | null | undefined;
  centroidThreshold: number;
}): { data: CentroidsArray; paint: boolean } {
  const { instanceId, path, data, liveZoom, centroidThreshold } = opts;
  if (instanceId && path) {
    setCachedCentroids(instanceId, path, data);
  }
  return {
    data,
    paint: shouldPaintCentroids(liveZoom, centroidThreshold),
  };
}

/**
 * Upsert contour viewport cache from FIFO request AABB; decide whether to paint.
 */
export function applyContourFrame(opts: {
  instanceId: string;
  path: string;
  data: ContourAnnotation[];
  liveZoom: number | null | undefined;
  centroidThreshold: number;
  isImageFile: boolean;
  merge?: boolean;
}): { data: ContourAnnotation[]; paint: boolean } {
  const {
    instanceId,
    path,
    data,
    liveZoom,
    centroidThreshold,
    isImageFile,
    merge = true,
  } = opts;
  const requestAabb = instanceId ? dequeueContourRequest(instanceId) : null;
  let out = data;
  if (instanceId && path && requestAabb) {
    const entry = upsertViewportContourCache({
      instanceId,
      path,
      requestAabb,
      data,
      merge,
    });
    out = entry.data;
  } else if (instanceId && path) {
    // FIFO miss (desync): still expose whatever cache we have rather than
    // replacing the overlay with a raw uncached frame alone.
    const cached = getViewportContourCache(instanceId, path);
    if (cached) out = mergeContoursByIdSafe(cached.data, data);
  }
  return {
    data: out,
    paint: shouldPaintContours(liveZoom, centroidThreshold, isImageFile),
  };
}

function mergeContoursByIdSafe(
  a: ContourAnnotation[],
  b: ContourAnnotation[],
): ContourAnnotation[] {
  const map = new Map<string | number, ContourAnnotation>();
  for (const ann of a) map.set(ann.id, ann);
  for (const ann of b) map.set(ann.id, ann);
  return [...map.values()];
}
