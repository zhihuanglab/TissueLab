/**
 * Per-contour geometry (AABB + point centroid), derived once per contour object.
 *
 * Three callers want these numbers — the viewport filter, the click hit-test and
 * the edge pass — and each used to sweep every point of every cached contour on
 * every frame. Contour objects are stable (the parser builds them once and the
 * cache merge carries the same references forward), so the sweep runs lazily and
 * the result is memoised on the object under a private symbol.
 */

/** Flat image-space coords [x0, y0, x1, y1, ...] — never an array of pairs. */
type PointList = ArrayLike<number>;

export interface ContourLike {
  points?: PointList | null;
}

export type ContourGeometry = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Mean of the points — NOT the AABB centre. Matches the legacy edge pass. */
  centerX: number;
  centerY: number;
  /** True when the contour carries no usable points; every test must miss. */
  empty: boolean;
};

const GEOMETRY = Symbol('contourGeometry');
/** Guards against a contour whose points were swapped after the first sweep. */
const GEOMETRY_SOURCE = Symbol('contourGeometrySource');

const EMPTY_GEOMETRY: ContourGeometry = Object.freeze({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
  centerX: 0,
  centerY: 0,
  empty: true,
});

type Carrier = ContourLike & {
  [GEOMETRY]?: ContourGeometry;
  [GEOMETRY_SOURCE]?: PointList | null;
};

function computeGeometry(points: PointList): ContourGeometry {
  const numPoints = points.length >> 1;
  if (numPoints === 0) return EMPTY_GEOMETRY;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sumX = 0;
  let sumY = 0;

  for (let i = 0; i < numPoints; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    sumX += x;
    sumY += y;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    centerX: sumX / numPoints,
    centerY: sumY / numPoints,
    empty: false,
  };
}

/**
 * Geometry for `contour`, computed on first call and memoised on the object.
 * Repeat calls are a symbol lookup and a reference compare.
 */
export function getContourGeometry(contour: ContourLike | null | undefined): ContourGeometry {
  if (!contour) return EMPTY_GEOMETRY;
  const carrier = contour as Carrier;
  const points = carrier.points;
  if (!points || points.length === 0) return EMPTY_GEOMETRY;

  const cached = carrier[GEOMETRY];
  if (cached !== undefined && carrier[GEOMETRY_SOURCE] === points) return cached;

  const geometry = computeGeometry(points);
  // Non-enumerable so the memo never leaks into JSON / spread / React deps.
  Object.defineProperty(carrier, GEOMETRY, {
    value: geometry,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(carrier, GEOMETRY_SOURCE, {
    value: points,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return geometry;
}

/** Ray cast over flat contour coords [x0, y0, x1, y1, ...]. */
export function isPointInContour(x: number, y: number, points: PointList | null | undefined): boolean {
  if (!points) return false;
  const n = points.length >> 1;
  if (n < 3) return false;

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The first contour whose polygon contains (x, y), or null. Each contour is
 * AABB-rejected first, so only a contour the point could be inside is ray-cast.
 */
export function findContourAtPoint<T extends ContourLike>(
  contours: readonly T[],
  x: number,
  y: number,
): T | null {
  for (let i = 0; i < contours.length; i++) {
    const contour = contours[i];
    const points = contour?.points;
    if (!points || points.length < 6) continue;
    const geometry = getContourGeometry(contour);
    if (x < geometry.minX || x > geometry.maxX) continue;
    if (y < geometry.minY || y > geometry.maxY) continue;
    if (isPointInContour(x, y, points)) return contour;
  }
  return null;
}

/**
 * Half-open overlap test, identical to the sweep it replaces: a contour whose
 * bounds only touch an edge of `aabb` does not count as inside.
 */
export function geometryIntersectsAabb(
  geometry: ContourGeometry,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  if (geometry.empty) return false;
  return (
    geometry.minX < x2 &&
    geometry.maxX > x1 &&
    geometry.minY < y2 &&
    geometry.maxY > y1
  );
}
