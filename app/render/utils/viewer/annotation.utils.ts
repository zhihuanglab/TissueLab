/**
 * Annotorious manual-drawing helpers (User-Annotations/manual.json persistence).
 */

import { toLocalWorkflowZarrPath } from '@/utils/agent/workflow/pathNorm';

export type ManualShape = 'rectangle' | 'polygon' | 'line';

export type ManualAnnotationRecord = {
  id: string;
  shape: ManualShape;
  vertices: [number, number][];
  style?: string;
  comment?: string;
  annotator?: string;
  datetime?: number;
};

export const MANUAL_SOURCE = 'manual';
/** Temporary Filter-tool ROI — never written to manual.json. */
export const FILTER_EPHEMERAL = 'filter';

/**
 * Single zarr sidecar path for manual.json read/write/hydrate.
 */
export function toManualZarrPath(path: string | null | undefined): string | null {
  return toLocalWorkflowZarrPath(path) || null;
}

/**
 * Dual-viewer focus gate: skip create / undo / selection / Redux writes when
 * this pane is clearly not the focused instance. Missing activeInstanceId does
 * not count as inactive (single-pane / startup).
 */
export function isInactiveViewerPane(
  instanceId: string | null | undefined,
  activeInstanceId: string | null | undefined,
): boolean {
  return !!(
    instanceId &&
    activeInstanceId &&
    instanceId !== activeInstanceId
  );
}

/** True when this pane is the focused dual-viewer instance. */
export function isActiveViewerPane(
  instanceId: string | null | undefined,
  activeInstanceId: string | null | undefined,
): boolean {
  return !!(
    instanceId &&
    activeInstanceId &&
    instanceId === activeInstanceId
  );
}

/**
 * Annotorious REMOTE setAnnotations often drops `properties.source`.
 * manualAnnotationSync registers a predicate over ids it has hydrated / queued.
 */
type ManualIdPredicate = (id: string) => boolean;
let trackedManualIdPredicate: ManualIdPredicate | null = null;

/** Called once from manualAnnotationSync (module init). */
export function registerTrackedManualIdPredicate(fn: ManualIdPredicate): void {
  trackedManualIdPredicate = fn;
}

/** True when this id is a disk-backed (or in-flight) manual drawing. */
function isManualId(id: string | null | undefined): boolean {
  const s = String(id || '');
  if (!s) return false;
  return trackedManualIdPredicate?.(s) === true;
}

/** Filter ROI — not a disk-backed drawing. */
export function isFilterEphemeral(annotation: any): boolean {
  return annotation?.properties?.source === FILTER_EPHEMERAL;
}

/**
 * Single source-of-truth check for freeform drawings.
 * Prefer this everywhere — do not dual-check source + known-id registry by hand.
 */
export function isManualAnnotation(annotation: any): boolean {
  if (!annotation) return false;
  if (isFilterEphemeral(annotation)) return false;
  if (annotation.properties?.source === MANUAL_SOURCE) return true;
  return isManualId(annotation.id);
}

/** Stamp a temporary Filter ROI so create/persist paths never archive it. */
export function withFilterEphemeral(annotation: any): any {
  const prev = annotation?.properties || {};
  return {
    ...annotation,
    properties: {
      ...prev,
      source: FILTER_EPHEMERAL,
    },
  };
}

export function ensureValidAnnotation(annotation: any) {
  return {
    ...annotation,
    target: {
      ...(annotation.target || {}),
      created: annotation.target?.created || new Date().toISOString(),
      source: annotation.target?.source || '',
    },
  };
}

function getSelector(annotation: any): any {
  const selector = annotation?.target?.selector;
  return Array.isArray(selector) ? selector[0] : selector;
}

function bodyValue(annotation: any, purpose: string): string {
  const bodies = Array.isArray(annotation?.bodies) ? annotation.bodies : [];
  const found = bodies.find((b: any) => b?.purpose === purpose);
  return typeof found?.value === 'string' ? found.value : '';
}

/** Bounds → 4 corners (same convention as selection_geometry). */
export function boundsToRectVertices(bounds: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): [number, number][] {
  const { minX, minY, maxX, maxY } = bounds;
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

export function extractManualPayload(
  annotation: any,
): Omit<ManualAnnotationRecord, 'annotator' | 'datetime'> | null {
  if (!annotation?.id) return null;
  const selector = getSelector(annotation);
  if (!selector?.type) return null;

  const type = String(selector.type).toUpperCase();
  let shape: ManualShape | null = null;
  let vertices: [number, number][] = [];

  if (type === 'RECTANGLE') {
    shape = 'rectangle';
    const bounds = selector.geometry?.bounds;
    if (bounds) {
      vertices = boundsToRectVertices(bounds);
    } else if (
      typeof selector.geometry?.x === 'number' &&
      typeof selector.geometry?.y === 'number' &&
      typeof selector.geometry?.w === 'number' &&
      typeof selector.geometry?.h === 'number'
    ) {
      const { x, y, w, h } = selector.geometry;
      vertices = boundsToRectVertices({
        minX: x,
        minY: y,
        maxX: x + w,
        maxY: y + h,
      });
    }
  } else if (type === 'POLYGON') {
    shape = 'polygon';
    const points = selector.geometry?.points;
    if (Array.isArray(points) && points.length >= 3) {
      vertices = points.map((p: any) => [Number(p[0]), Number(p[1])] as [number, number]);
    }
  } else if (type === 'LINE') {
    shape = 'line';
    const points = selector.geometry?.points;
    if (Array.isArray(points) && points.length >= 2) {
      vertices = points
        .slice(0, 2)
        .map((p: any) => [Number(p[0]), Number(p[1])] as [number, number]);
    }
  }

  if (!shape || vertices.length < 2) return null;

  return {
    id: String(annotation.id),
    shape,
    vertices,
    style: bodyValue(annotation, 'style') || '#00ff00',
    comment: bodyValue(annotation, 'comment') || '',
  };
}

/** Convert a Zarr manual record back into an Annotorious annotation. */
export function manualRecordToAnnotorious(record: ManualAnnotationRecord): any {
  const id = String(record.id);
  const shape = String(record.shape || '').toLowerCase() as ManualShape;
  const vertices = Array.isArray(record.vertices) ? record.vertices : [];
  const style = record.style || '#00ff00';
  const comment = record.comment || '';
  const now = new Date().toISOString();

  let selector: any = null;
  if (shape === 'rectangle' && vertices.length >= 4) {
    const xs = vertices.map((p) => p[0]);
    const ys = vertices.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    selector = {
      type: 'RECTANGLE',
      geometry: {
        x: minX,
        y: minY,
        w: maxX - minX,
        h: maxY - minY,
        bounds: { minX, minY, maxX, maxY },
      },
    };
  } else if (shape === 'polygon' && vertices.length >= 3) {
    const xs = vertices.map((p) => p[0]);
    const ys = vertices.map((p) => p[1]);
    selector = {
      type: 'POLYGON',
      geometry: {
        points: vertices,
        bounds: {
          minX: Math.min(...xs),
          minY: Math.min(...ys),
          maxX: Math.max(...xs),
          maxY: Math.max(...ys),
        },
      },
    };
  } else if (shape === 'line' && vertices.length >= 2) {
    const pts = vertices.slice(0, 2) as [number, number][];
    selector = {
      type: 'LINE',
      geometry: {
        points: pts,
        bounds: {
          minX: Math.min(pts[0][0], pts[1][0]),
          minY: Math.min(pts[0][1], pts[1][1]),
          maxX: Math.max(pts[0][0], pts[1][0]),
          maxY: Math.max(pts[0][1], pts[1][1]),
        },
      },
    };
  }

  if (!selector) return null;

  return ensureValidAnnotation({
    id,
    isBackend: false,
    properties: {
      source: MANUAL_SOURCE,
      ...(typeof record.datetime === 'number' ? { datetime: record.datetime } : {}),
    },
    target: {
      annotation: id,
      selector,
      created: now,
      source: '',
    },
    bodies: [
      {
        id: `${id}-style`,
        annotation: id,
        type: 'TextualBody',
        purpose: 'style',
        value: style,
        created: now,
      },
      {
        id: `${id}-comment`,
        annotation: id,
        type: 'TextualBody',
        purpose: 'comment',
        value: comment,
        created: now,
      },
    ],
  });
}

/** Mark an in-memory annotation as a persisted manual drawing. */
export function withManualSource(
  annotation: any,
  extras?: { datetime?: number },
): any {
  const prev = annotation?.properties || {};
  const datetime =
    extras?.datetime ??
    (typeof prev.datetime === 'number' ? prev.datetime : undefined);
  return {
    ...annotation,
    properties: {
      ...prev,
      source: MANUAL_SOURCE,
      ...(typeof datetime === 'number' ? { datetime } : {}),
    },
  };
}

export function verticesBounds(vertices: [number, number][]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  if (!Array.isArray(vertices) || vertices.length === 0) return null;
  let minX = vertices[0][0];
  let minY = vertices[0][1];
  let maxX = vertices[0][0];
  let maxY = vertices[0][1];
  for (const [x, y] of vertices) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
