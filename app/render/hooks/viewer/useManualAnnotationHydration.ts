import { useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '@/store';
import { setAnnotations } from '@/store/slices/viewer/annotationSlice';
import { isWriteBlockedPath } from '@/utils/common/pathAccess.utils';
import {
  ensureValidAnnotation,
  isFilterEphemeral,
  isManualAnnotation,
  manualRecordToAnnotorious,
  toManualZarrPath,
} from '@/utils/viewer/annotation.utils';
import { apiListManualAnnotations } from '@/utils/viewer/manualAnnotation.api';
import {
  hasManualSyncWorkForPath,
  isManualPersistApproved,
  isPendingManualDelete,
  isTrackedManualWrite,
  seedManualSyncedFromDisk,
  whenManualSyncIdleOrTimeout,
} from '@/utils/viewer/manualAnnotationSync';
import {
  flushSelectedManualDrawings,
  withManualPersistSuppressed,
} from '@/utils/viewer/persistManualDrawing';

interface UseManualAnnotationHydrationParams {
  currentPath: string | null;
  instanceId?: string | null;
  isActive?: boolean;
  annotatorInstance: any;
}

/**
 * Load User-Annotations/manual.json after the path queue drains.
 * Merge keeps pending / failed local writes (even when disk still has the id).
 */
export function useManualAnnotationHydration(params: UseManualAnnotationHydrationParams) {
  const {
    currentPath,
    instanceId,
    isActive = true,
    annotatorInstance,
  } = params;
  const dispatch = useDispatch<AppDispatch>();
  const requestSeqRef = useRef(0);
  const settledKeyRef = useRef<string | null>(null);
  const [peerDiskRev, setPeerDiskRev] = useState(0);

  const prevAnnotatorRef = useRef(annotatorInstance);
  if (prevAnnotatorRef.current !== annotatorInstance) {
    prevAnnotatorRef.current = annotatorInstance;
    settledKeyRef.current = null;
  }

  // Peer pane wrote the same sidecar — re-pull.
  // (delete-fail repair sends instanceId:'' so this pane also re-pulls.)
  useEffect(() => {
    const onChanged = (evt: Event) => {
      const detail = (evt as CustomEvent).detail;
      if (!instanceId || !currentPath) return;
      if (detail?.instanceId && detail.instanceId === instanceId) return;
      const zarrPath = toManualZarrPath(currentPath);
      if (!zarrPath || !detail?.path || detail.path !== zarrPath) return;
      settledKeyRef.current = null;
      setPeerDiskRev((n) => n + 1);
    };
    window.addEventListener('manual-annotations-changed', onChanged);
    return () =>
      window.removeEventListener('manual-annotations-changed', onChanged);
  }, [instanceId, currentPath]);

  useEffect(() => {
    // Inactive: drop settle so activate / switch-back can re-list after a failure.
    if (!isActive) {
      settledKeyRef.current = null;
      return;
    }
    if (!annotatorInstance || !currentPath || !instanceId) return;

    const zarrPath = toManualZarrPath(currentPath);
    if (!zarrPath) return;

    const pathKey = `${instanceId}|${zarrPath}`;
    if (settledKeyRef.current === pathKey) return;

    // Slide wipe is owned by useFileChangeHandler (flush-before-wipe).
    // This hook only list → merge once idle.

    const seq = ++requestSeqRef.current;
    let cancelled = false;

    (async () => {
      try {
        await whenManualSyncIdleOrTimeout(zarrPath, 15_000);
        if (cancelled || seq !== requestSeqRef.current) return;

        let records = await apiListManualAnnotations(instanceId, zarrPath);
        if (cancelled || seq !== requestSeqRef.current) return;

        if (hasManualSyncWorkForPath(zarrPath)) {
          await whenManualSyncIdleOrTimeout(zarrPath, 5_000);
          if (cancelled || seq !== requestSeqRef.current) return;
          records = await apiListManualAnnotations(instanceId, zarrPath);
          if (cancelled || seq !== requestSeqRef.current) return;
        }

        const manuals = records
          .map((r) => manualRecordToAnnotorious(r))
          .filter((m: any) => m && !isPendingManualDelete(m?.id));

        // Flush live color/comment before suppress merge — popup deselect
        // under suppress would return null and drop unsaved edits.
        flushSelectedManualDrawings(
          annotatorInstance,
          instanceId,
          currentPath,
        );
        seedManualSyncedFromDisk(zarrPath, records);

        const diskIds = new Set(
          manuals.map((m: any) => String(m?.id || '')).filter(Boolean),
        );
        const writeBlocked = isWriteBlockedPath(currentPath ?? undefined);
        const canvasAnns = annotatorInstance.getAnnotations?.() || [];

        const keep = canvasAnns
          .filter((a: any) => {
            if (a?.isBackend === true) return true;
            if (isFilterEphemeral(a)) return false;
            if (isManualAnnotation(a)) {
              const id = String(a?.id || '');
              if (!id) return false;
              // Pending / failed upserts win over stale disk (same id).
              if (isTrackedManualWrite(id)) return true;
              // Unsaved draft (never Saved) — disk never had it; keep drawing.
              if (!isManualPersistApproved(id)) return true;
              if (diskIds.has(id)) return false;
              if (writeBlocked) return true;
              return false;
            }
            return true;
          })
          .map((a: any) => ensureValidAnnotation(a));

        const keepIds = new Set(
          keep.map((a: any) => String(a?.id || '')).filter(Boolean),
        );
        const merged = [
          ...manuals.filter((m: any) => !keepIds.has(String(m?.id || ''))),
          ...keep,
        ];
        withManualPersistSuppressed(instanceId, () => {
          annotatorInstance.setAnnotations(merged, true);
        });
        dispatch(setAnnotations(merged.filter((a: any) => !a?.isBackend)));

        settledKeyRef.current = pathKey;
      } catch (e) {
        if (cancelled || seq !== requestSeqRef.current) return;
        // Leave unsettled so deactivate→activate or peer event can retry.
        console.warn('[manual-hydrate] list failed:', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isActive, annotatorInstance, currentPath, instanceId, peerDiskRev]);
}
