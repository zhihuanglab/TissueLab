import { useEffect, useRef } from 'react';
import { useAnnotator } from '@annotorious/react';
import { mountPlugin as mountToolsPlugin } from '@annotorious/plugin-tools';
import { useDispatch, useSelector } from "react-redux";
import {
    addAnnotation, removeAnnotationById,
    setAnnotations,
    setEditPanelOpen,
    updateAnnotationById
} from "@/store/slices/viewer/annotationSlice";
import {RootState} from "@/store";
import { resetSegmentationData } from "@/services/file.service";
import OpenSeadragon from 'openseadragon';
import { setShapeData, resetShapeData } from "@/store/slices/viewer/shapeSlice";
import {
    extractManualPayload,
    isActiveViewerPane,
    isFilterEphemeral,
    isInactiveViewerPane,
    isManualAnnotation,
    toManualZarrPath,
    withFilterEphemeral,
    withManualSource,
} from '@/utils/viewer/annotation.utils';
import {
    enqueueManualDelete,
    enqueueManualUpsert,
    rememberManualId,
} from '@/utils/viewer/manualAnnotationSync';
import {
    isManualPersistSuppressed,
    persistManualDrawing,
    remoteUpdateAnnotation,
    resolveLocalAnnotatorName,
    withDefaultManualStyle,
    withManualPersistSuppressed,
} from '@/utils/viewer/persistManualDrawing';
import { useInstanceSlidePath } from '@/utils/viewer/slidePath';

function queueManualDiskUpsert(
  annotation: any,
  instanceId: string | null | undefined,
  path: string | null | undefined,
) {
  if (isManualPersistSuppressed(instanceId)) return;
  if (!isManualAnnotation(annotation)) return;
  const zarrPath = toManualZarrPath(path);
  const payload = extractManualPayload(annotation);
  if (!zarrPath || !instanceId || !payload) return;
  const datetime =
    typeof annotation?.properties?.datetime === 'number'
      ? annotation.properties.datetime
      : Date.now();
  enqueueManualUpsert(instanceId, {
    ...payload,
    path: zarrPath,
    annotator: resolveLocalAnnotatorName(),
    datetime,
  });
}

function queueManualDiskDelete(
  annotationId: string,
  instanceId: string | null | undefined,
  path: string | null | undefined,
  annotation?: any,
) {
  if (isManualPersistSuppressed(instanceId)) return;
  const id = String(annotationId || '');
  if (!id) return;
  if (!isManualAnnotation(annotation ?? { id })) return;
  const zarrPath = toManualZarrPath(path);
  if (!zarrPath || !instanceId) return;
  enqueueManualDelete(instanceId, zarrPath, id);
}

/** Prefer this viewer instance so dual-viewer writes hit the correct zarr. */
const useAnnotatorInitialization = (instanceId?: string | null) => {
    const dispatch = useDispatch();
    const annotatorInstance = useAnnotator<any>();
    const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
    const annotatorRef = useRef<any>(null);
    const lastVisibleSignatureRef = useRef<string>("");
    const rafIdRef = useRef<number | null>(null);

    const editAnnotation = useSelector((state: RootState) => state.annotations.editAnnotation)
    const activeInstanceId = useSelector((state: RootState) => state.wsi.activeInstanceId)
    const currentTool = useSelector((state: RootState) => state.tool.currentTool)
    const resolvedInstanceId = instanceId ?? activeInstanceId;
    const currentPath = useInstanceSlidePath(resolvedInstanceId);
    const instanceIdRef = useRef(resolvedInstanceId)
    const activeInstanceIdRef = useRef(activeInstanceId)
    const currentPathRef = useRef(currentPath)
    const toolRef = useRef(currentTool)
    /**
     * Annotorious undo stack only observes LOCAL changes — REMOTE slide wipe
     * leaves stale history. Block undo/redo from path change until remount.
     */
    const blockStaleUndoRef = useRef(false)
    // Leave-filter: short grace catches Annotorious setTimeout(1) create after
    // cancelDrawing; wipe at 50ms clears ephemeral leftovers. Do NOT align grace
    // with wipe — a 50ms ephemeral window would also stamp intentional rect/lasso
    // strokes drawn right after leaving filter, and the wipe would delete them.
    const filterEphemeralUntilRef = useRef(0)
    const filterWipePendingRef = useRef(false)
    const prevToolRef = useRef(currentTool)
    instanceIdRef.current = resolvedInstanceId
    activeInstanceIdRef.current = activeInstanceId
    currentPathRef.current = currentPath
    toolRef.current = currentTool

    // Detect filter leave during render (same pattern as path-key change below).
    if (prevToolRef.current === 'filter' && currentTool !== 'filter') {
        filterWipePendingRef.current = true;
        filterEphemeralUntilRef.current = performance.now() + 16;
    }
    if (currentTool === 'filter') {
        filterWipePendingRef.current = false;
    }
    prevToolRef.current = currentTool;

    // React to path/instance during render — handlers already use currentPathRef.
    const pathKey = `${resolvedInstanceId ?? ''}|${currentPath ?? ''}`;
    const prevPathKeyRef = useRef(pathKey);
    if (prevPathKeyRef.current !== pathKey) {
        prevPathKeyRef.current = pathKey;
        lastVisibleSignatureRef.current = '';
        if (rafIdRef.current) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
        blockStaleUndoRef.current = true;
    }

    // Fresh annotator = empty history; safe to undo again.
    useEffect(() => {
        blockStaleUndoRef.current = false;
    }, [annotatorInstance]);

    // Losing focus: clear selection + global ROI so the other pane cannot
    // inherit stale shapeData (selectionChanged is gated and would not sync).
    const wasActivePaneRef = useRef(false);
    useEffect(() => {
        const isActivePane = isActiveViewerPane(
            resolvedInstanceId,
            activeInstanceId,
        );
        if (wasActivePaneRef.current && !isActivePane && annotatorInstance) {
            try {
                annotatorInstance.cancelSelected?.();
            } catch {}
            dispatch(resetShapeData());
            dispatch(setEditPanelOpen(false));
        }
        wasActivePaneRef.current = isActivePane;
    }, [activeInstanceId, resolvedInstanceId, annotatorInstance, dispatch]);

    // Leaving filter: cancelDrawing + wipe non-manuals after grace.
    useEffect(() => {
        if (currentTool === 'filter') return;
        if (!filterWipePendingRef.current) return;
        if (!annotatorInstance) return;
        try {
            annotatorInstance.cancelDrawing?.();
            annotatorInstance.cancelSelected?.();
        } catch {}
        const wipeTimer = window.setTimeout(() => {
            filterWipePendingRef.current = false;
            try {
                const rest = (annotatorInstance.getAnnotations?.() || []).filter(
                    (a: any) =>
                        a?.isBackend === true || isManualAnnotation(a),
                );
                annotatorInstance.setAnnotations(rest, true);
            } catch {}
        }, 50);
        return () => window.clearTimeout(wipeTimer);
    }, [currentTool, annotatorInstance]);

    // Own Cmd/Ctrl+Z so disk stays in sync. Annotorious only undoes the canvas;
    // history `created` entries often lack properties.source after REMOTE stamp.
    useEffect(() => {
        const onKeyDown = (evt: Event) => {
            const e = evt as KeyboardEvent;
            const key = (e.key || '').toLowerCase();
            const isMac =
                typeof navigator !== 'undefined' &&
                navigator.userAgent.includes('Mac OS X');
            const ann = annotatorRef.current;
            if (!ann) return;
            // Dual viewer: both panes register document listeners — only the
            // active pane should steal undo/redo and touch its disk queue.
            const iid = instanceIdRef.current;
            if (isInactiveViewerPane(iid, activeInstanceIdRef.current)) {
                return;
            }

            const isUndo =
                key === 'z' &&
                ((isMac && e.metaKey && !e.shiftKey) ||
                    (!isMac && e.ctrlKey && !e.shiftKey));
            const isRedo =
                (key === 'z' &&
                    ((isMac && e.metaKey && e.shiftKey) ||
                        (!isMac && e.ctrlKey && e.shiftKey))) ||
                (key === 'y' && !isMac && e.ctrlKey);

            if (!isUndo && !isRedo) return;
            // Don't steal undo/redo from text fields (comment, color inputs, etc.).
            const target = e.target as HTMLElement | null;
            if (
              target &&
              (target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable)
            ) {
              return;
            }
            // Swallow undo across slide switch — Annotorious history is still
            // the previous slide's LOCAL stack until the annotator remounts.
            if (blockStaleUndoRef.current) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
            if (isUndo && !ann.canUndo?.()) return;
            if (isRedo && !ann.canRedo?.()) return;

            const hist = ann.getHistory?.();
            const change = isUndo
                ? hist?.changes?.[hist.pointer]
                : hist?.changes?.[hist.pointer + 1];

            e.preventDefault();
            e.stopImmediatePropagation();

            if (isUndo) ann.undo();
            else ann.redo();

            if (!change) return;
            const path = currentPathRef.current;
            const zarrPath = toManualZarrPath(path);
            if (!zarrPath || !iid) return;

            const created = change.created || [];
            const deleted = change.deleted || [];
            const updated = change.updated || [];

            if (isUndo) {
                // Undo create → remove from disk
                for (const a of created) {
                    if (a?.id) {
                        queueManualDiskDelete(String(a.id), iid, path, a);
                    }
                }
                // Undo delete → restore to disk
                for (const a of deleted) {
                    const live = ann.getAnnotationById?.(a?.id) || a;
                    if (!isManualAnnotation(live)) continue;
                    queueManualDiskUpsert(withManualSource(live), iid, path);
                }
                // Undo edit → write restored geometry/style
                for (const u of updated) {
                    const restored = u?.oldValue;
                    const live =
                        (restored?.id && ann.getAnnotationById?.(restored.id)) ||
                        restored;
                    if (live) queueManualDiskUpsert(live, iid, path);
                }
            } else {
                // Redo create → upsert
                for (const a of created) {
                    const live = ann.getAnnotationById?.(a?.id) || a;
                    if (!isManualAnnotation(live)) continue;
                    queueManualDiskUpsert(withManualSource(live), iid, path);
                }
                // Redo delete → remove from disk
                for (const a of deleted) {
                    if (a?.id) {
                        queueManualDiskDelete(String(a.id), iid, path, a);
                    }
                }
                for (const u of updated) {
                    const next = u?.newValue;
                    const live =
                        (next?.id && ann.getAnnotationById?.(next.id)) || next;
                    if (live) queueManualDiskUpsert(live, iid, path);
                }
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, []);

    useEffect(() => {
        if (annotatorInstance) {
            mountToolsPlugin(annotatorInstance);
            annotatorRef.current = annotatorInstance;
            viewerRef.current = annotatorInstance.viewer;

            const onCreateAnnotation = (annotation: any) => {
                if (annotation?.isBackend) return;
                // Dual viewer: only the focused pane may create/persist.
                const iid = instanceIdRef.current;
                if (isInactiveViewerPane(iid, activeInstanceIdRef.current)) {
                  // Rubberband already LOCAL-added — strip the orphan so it
                  // cannot linger on the inactive pane without Redux/disk.
                  try {
                    const id = annotation?.id;
                    if (id) {
                      if (annotatorInstance.state?.store?.deleteAnnotation) {
                        annotatorInstance.state.store.deleteAnnotation(
                          id,
                          'REMOTE',
                        );
                      } else {
                        annotatorInstance.removeAnnotation?.(id);
                      }
                    }
                    annotatorInstance.cancelDrawing?.();
                  } catch {}
                  return;
                }

                const path = currentPathRef.current;
                const zarrPath = toManualZarrPath(path);

                // Filter ROI: tool / already stamped / leave-filter grace.
                if (
                  toolRef.current === 'filter' ||
                  isFilterEphemeral(annotation) ||
                  performance.now() < filterEphemeralUntilRef.current
                ) {
                    const stamped = withFilterEphemeral(annotation);
                    try {
                        if (!remoteUpdateAnnotation(annotatorInstance, stamped)) {
                          annotatorInstance.updateAnnotation?.(stamped);
                        }
                    } catch {}
                    dispatch(addAnnotation(stamped));
                    return;
                }

                // Create only stamps locally: the drawing is a draft until the
                // popup's Save approves it (enqueue also no-ops on Viewer/Samples).
                if (iid && extractManualPayload(annotation)) {
                    const styled = withDefaultManualStyle(annotation);
                    if (zarrPath) {
                        const stamped = persistManualDrawing({
                            annotator: annotatorInstance,
                            annotation: styled,
                            instanceId: iid,
                            zarrPath,
                        });
                        dispatch(
                          addAnnotation(
                            stamped ?? withManualSource(styled),
                          ),
                        );
                        return;
                    }
                    const stamped = withManualSource(styled);
                    rememberManualId(stamped?.id);
                    try {
                        if (!remoteUpdateAnnotation(annotatorInstance, stamped)) {
                          annotatorInstance.updateAnnotation?.(stamped);
                        }
                    } catch {}
                    dispatch(addAnnotation(stamped));
                    return;
                }

                dispatch(addAnnotation(annotation));
            };

            const onDeleteAnnotation = (annotation: any) => {
                const path = currentPathRef.current;
                dispatch(removeAnnotationById(annotation.id));
                // Delete key / Footer / any LOCAL remove of a tracked manual.
                // Cmd+Z also deletes via the keydown handler (history ids).
                // Write-blocked paths skip the HTTP delete inside enqueueManualDelete.
                queueManualDiskDelete(
                    String(annotation?.id || ''),
                    instanceIdRef.current,
                    path,
                    annotation,
                );
            };

            const onViewportIntersect = (viewportAnnotations: any) => {
                // Global Redux annotations list — only the focused pane may write.
                if (
                  isInactiveViewerPane(
                    instanceIdRef.current,
                    activeInstanceIdRef.current,
                  )
                ) {
                  return;
                }

                const visibleAnnotationIds = new Set(viewportAnnotations.map((a: any) => a.id));

                const userAnnotations = annotatorInstance
                    .getAnnotations()
                    .filter((annotation: any) => !annotation.isBackend);

                const signature = `${userAnnotations.length}|${Array.from(visibleAnnotationIds).sort().join(',')}`;

                if (lastVisibleSignatureRef.current === signature) return;
                lastVisibleSignatureRef.current = signature;

                const buildPayload = () =>
                  userAnnotations.map((annotation: any) => ({
                    ...annotation,
                    isVisible: visibleAnnotationIds.has(annotation.id)
                  }));

                if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = requestAnimationFrame(() => {
                  try {
                    // Re-check focus — user may have switched panes mid-rAF.
                    if (
                      isInactiveViewerPane(
                        instanceIdRef.current,
                        activeInstanceIdRef.current,
                      )
                    ) {
                      return;
                    }
                    const payload = buildPayload();
                    dispatch(setAnnotations(payload));
                  } finally {
                    rafIdRef.current = null;
                  }
                });
            };

            const onUpdateAnnotation = (updated: any, previous: any) => {
                if (updated?.isBackend) return;
                if (
                  isInactiveViewerPane(
                    instanceIdRef.current,
                    activeInstanceIdRef.current,
                  )
                ) {
                  return;
                }
                dispatch(updateAnnotationById({
                    id: previous?.id ?? updated.id,
                    data: updated
                }));
                // Undo/redo emits updateAnnotation for geometry/style restores.
                // Live color preview also lands here; queue coalesces to latest.
                queueManualDiskUpsert(
                    updated,
                    instanceIdRef.current,
                    currentPathRef.current,
                );
            };

            const onSelectionChanged = (selected: any[]) => {
                if (
                  isInactiveViewerPane(
                    instanceIdRef.current,
                    activeInstanceIdRef.current,
                  )
                ) {
                  return;
                }
                // Set absolute open/closed — toggle flips shut when switching A→B.
                dispatch(setEditPanelOpen(Array.isArray(selected) && selected.length > 0));
                
                if (!selected || selected.length === 0) {
                    dispatch(resetShapeData());
                    return;
                }

                const annotation = selected[selected.length - 1];
                const selector = Array.isArray(annotation?.target?.selector)
                  ? annotation.target.selector[0]
                  : annotation?.target?.selector;

                if (selector?.type === 'LINE') {
                    dispatch(resetShapeData());
                    return;
                }

                const selectorCandidate = Array.isArray(annotation?.target?.selector)
                  ? annotation.target.selector.find((s: any) => s?.type === 'POLYGON' || s?.type === 'RECTANGLE' || s?.geometry?.bounds)
                  : annotation?.target?.selector;

                if (!selectorCandidate) {
                    dispatch(resetShapeData());
                    return;
                }

                try {
                    const selector: any = selectorCandidate;
                    if (selector.type === 'RECTANGLE' && selector.geometry?.bounds) {
                        const { minX, minY, maxX, maxY } = selector.geometry.bounds;
                        const coords = {
                            x1: minX,
                            y1: minY,
                            x2: maxX,
                            y2: maxY
                        };
                        dispatch(setShapeData({ rectangleCoords: coords }));
                    } else if (selector.type === 'POLYGON' && Array.isArray(selector.geometry?.points) && selector.geometry.points.length > 0) {
                        const points: [number, number][] = selector.geometry.points as [number, number][];
                        let minX = points[0][0], minY = points[0][1], maxX = points[0][0], maxY = points[0][1];
                        for (const [px, py] of points) {
                            if (px < minX) minX = px;
                            if (py < minY) minY = py;
                            if (px > maxX) maxX = px;
                            if (py > maxY) maxY = py;
                        }
                        const coords = {
                            x1: minX,
                            y1: minY,
                            x2: maxX,
                            y2: maxY
                        };
                        const polygonPoints = points.map(([px, py]) => [px, py] as [number, number]);
                        dispatch(setShapeData({ rectangleCoords: coords, polygonPoints }));
                    } else if (selector.geometry?.bounds) {
                        const { minX, minY, maxX, maxY } = selector.geometry.bounds;
                        const coords = {
                            x1: minX,
                            y1: minY,
                            x2: maxX,
                            y2: maxY
                        };
                        dispatch(setShapeData({ rectangleCoords: coords }));
                    } else {
                        dispatch(resetShapeData());
                    }
                } catch (e) {
                    dispatch(resetShapeData());
                }
            };

            annotatorInstance.on('createAnnotation', onCreateAnnotation);
            annotatorInstance.on('deleteAnnotation', onDeleteAnnotation);
            annotatorInstance.on('viewportIntersect', onViewportIntersect);
            annotatorInstance.on('updateAnnotation', onUpdateAnnotation);
            annotatorInstance.on('selectionChanged', onSelectionChanged);

            // Manuals are loaded by useManualAnnotationHydration (REMOTE).
            // Do NOT seed from Redux here — annotations may be from a previous
            // slide, and LOCAL addAnnotation would re-fire createAnnotation → disk.
            try {
                withManualPersistSuppressed(instanceIdRef.current, () => {
                    annotatorInstance.setAnnotations([], true);
                });
            } catch {}

            return () => {
                try {
                    annotatorInstance.off?.('createAnnotation', onCreateAnnotation);
                    annotatorInstance.off?.('deleteAnnotation', onDeleteAnnotation);
                    annotatorInstance.off?.('viewportIntersect', onViewportIntersect);
                    annotatorInstance.off?.('updateAnnotation', onUpdateAnnotation);
                    annotatorInstance.off?.('selectionChanged', onSelectionChanged);
                } catch {}

                if (rafIdRef.current) {
                    cancelAnimationFrame(rafIdRef.current);
                    rafIdRef.current = null;
                }

                // Leave the sync queue alone on remount — in-flight saves must finish.
                if (annotatorInstance) {
                    // REMOTE replace — clearAnnotations() is LOCAL and would fire
                    // deleteAnnotation → enqueueManualDelete → wipe User-Annotations/manual.json.
                    withManualPersistSuppressed(instanceIdRef.current, () => {
                        annotatorInstance.setAnnotations([], true);
                    });
                }

                if (viewerRef.current) {
                    viewerRef.current = null;
                }

                const id = instanceIdRef.current;
                if (id) {
                    resetSegmentationData(id)
                        .then(response => {
                            console.log('[Annotator Cleanup] Successfully reset segmentation data:', response);
                        })
                        .catch(error => {
                            console.error('[Annotator Cleanup] Failed to reset segmentation data:', error);
                        });
                }
            }
        }
    }, [annotatorInstance]);

    // Pending sync items already carry their zarr path across slide switches.
    useEffect(() => {
        if (annotatorInstance && annotatorInstance.viewer && editAnnotation) {
            annotatorInstance.fitBounds(editAnnotation, { immediately: true, padding: 20 });
        }
    }, [editAnnotation, annotatorInstance]);

    return { annotatorInstance, viewerRef }
};

export default useAnnotatorInitialization;
