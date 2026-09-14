/**
 * Stamp source=manual + enqueue User-Annotations/manual.json.
 * The enqueue only reaches disk once the drawing is approved — i.e. the
 * annotation popup's Save button was clicked (see manualAnnotationSync).
 */

import {
  extractManualPayload,
  isFilterEphemeral,
  isManualAnnotation,
  toManualZarrPath,
  withManualSource,
} from '@/utils/viewer/annotation.utils';
import {
  enqueueManualUpsert,
  isManualUpsertSynced,
  type ManualUpsertPayload,
} from '@/utils/viewer/manualAnnotationSync';
import { resolveAnnotatorLabel } from '@/utils/viewer/annotator';
import { Origin } from '@annotorious/react';

/** Per-instance wipe guards (dual-viewer must not share these). */
const clearGenerationByInstance = new Map<string, number>();
const suppressDepthByInstance = new Map<string, number>();

function instanceKey(instanceId?: string | null): string {
  return instanceId || '__default__';
}

function getClearGeneration(instanceId?: string | null): number {
  return clearGenerationByInstance.get(instanceKey(instanceId)) || 0;
}

export function isManualPersistSuppressed(
  instanceId?: string | null,
): boolean {
  return (suppressDepthByInstance.get(instanceKey(instanceId)) || 0) > 0;
}

/** Disable persist during slide/hydrate wipe; bump clearGeneration when depth hits 0. */
export function withManualPersistSuppressed<T>(
  instanceId: string | null | undefined,
  fn: () => T,
): T {
  const k = instanceKey(instanceId);
  suppressDepthByInstance.set(k, (suppressDepthByInstance.get(k) || 0) + 1);
  try {
    return fn();
  } finally {
    const next = (suppressDepthByInstance.get(k) || 1) - 1;
    if (next <= 0) {
      suppressDepthByInstance.delete(k);
      clearGenerationByInstance.set(
        k,
        (clearGenerationByInstance.get(k) || 0) + 1,
      );
    } else {
      suppressDepthByInstance.set(k, next);
    }
  }
}

export function resolveLocalAnnotatorName(): string {
  try {
    const uid = window.localStorage.getItem('last_user_id');
    return resolveAnnotatorLabel({ userId: uid });
  } catch {
    return 'Unknown';
  }
}

/** Ensure a default green style body exists (Annotorious create path). */
export function withDefaultManualStyle(annotation: any): any {
  const bodies = Array.isArray(annotation?.bodies) ? annotation.bodies : [];
  if (bodies.some((b: any) => b?.purpose === 'style')) return annotation;
  return {
    ...annotation,
    bodies: [
      ...bodies,
      {
        id: `${annotation.id}-style`,
        annotation: annotation.id,
        type: 'TextualBody',
        purpose: 'style',
        value: '#00ff00',
        created: new Date().toISOString(),
      },
    ],
  };
}

export type PersistManualDrawingOpts = {
  annotator: any;
  annotation: any;
  instanceId: string;
  zarrPath: string;
  datetime?: number;
  /** Deselect/Save: abort if shape was deleted. Create/lasso: leave false. */
  requireExisting?: boolean;
};

function stripAnnotationRemote(annotator: any, id: string): void {
  try {
    const rest = (annotator.getAnnotations?.() || []).filter(
      (a: any) => a?.id !== id,
    );
    annotator.setAnnotations(rest, true);
  } catch {}
}

/** Prefer REMOTE store update so stamps do not enter the undo stack. */
export function remoteUpdateAnnotation(annotator: any, annotation: any): boolean {
  try {
    const store = annotator?.state?.store;
    if (store?.updateAnnotation && annotation?.id) {
      store.updateAnnotation(annotation, Origin.REMOTE);
      return true;
    }
  } catch {}
  return false;
}

/**
 * REMOTE-stamp source=manual and enqueue disk upsert.
 * Returns the stamped annotation, or null if missing / deleted / wiped.
 */
export function persistManualDrawing(
  opts: PersistManualDrawingOpts,
): any | null {
  const {
    annotator,
    instanceId,
    zarrPath,
    requireExisting = false,
  } = opts;
  if (!annotator || !instanceId || !zarrPath || !opts.annotation?.id) return null;
  if (isManualPersistSuppressed(instanceId)) return null;
  if (isFilterEphemeral(opts.annotation)) return null;

  const datetime =
    opts.datetime ??
    (typeof opts.annotation?.properties?.datetime === 'number'
      ? opts.annotation.properties.datetime
      : Date.now());

  const stamped = withManualSource(opts.annotation, { datetime });
  const payload = extractManualPayload(stamped);
  if (!payload) return null;

  const upsert: ManualUpsertPayload = {
    ...payload,
    path: zarrPath,
    annotator: resolveLocalAnnotatorName(),
    datetime,
  };

  // Already on disk — skip canvas touch (avoids undo pollution / selection clear).
  if (isManualUpsertSynced(upsert)) {
    return stamped;
  }

  const genAtStart = getClearGeneration(instanceId);
  if (requireExisting && !annotator.getAnnotationById?.(stamped.id)) {
    return null;
  }

  try {
    if (!remoteUpdateAnnotation(annotator, stamped)) {
      const rest = (annotator.getAnnotations?.() || []).filter(
        (a: any) => a?.id !== stamped.id,
      );
      annotator.setAnnotations([...rest, stamped], true);
    }
  } catch {
    return null;
  }

  if (
    isManualPersistSuppressed(instanceId) ||
    genAtStart !== getClearGeneration(instanceId)
  ) {
    stripAnnotationRemote(annotator, stamped.id);
    return null;
  }

  // enqueueManualUpsert no-ops on Viewer/Samples; local stamp is already on the canvas.
  enqueueManualUpsert(instanceId, upsert);
  return stamped;
}

/**
 * Persist currently selected manuals (hydrate merge / slide wipe).
 * Uses slide `path` for zarr resolve; enqueue no-ops on Viewer/Samples.
 */
export function flushSelectedManualDrawings(
  annotator: any,
  instanceId: string | null | undefined,
  path: string | null | undefined,
): void {
  if (!annotator || !instanceId || !path) return;
  const zarrPath = toManualZarrPath(path);
  if (!zarrPath) return;
  try {
    const selected = annotator.getSelected?.() || [];
    for (const a of selected) {
      if (!isManualAnnotation(a)) continue;
      persistManualDrawing({
        annotator,
        annotation: a,
        instanceId,
        zarrPath,
        requireExisting: true,
      });
    }
  } catch {}
}
