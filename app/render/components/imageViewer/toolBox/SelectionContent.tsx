"use client"

import { useCallback, useState, useEffect, useRef } from "react"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { ImageAnnotation } from "@annotorious/react"
import { useDispatch, useSelector } from "react-redux"
import { useActiveSlidePath, useInstanceSlidePath } from "@/utils/viewer/slidePath";
import { AppDispatch, RootState } from "@/store"
import { isSegmentationHandlerNotReadyError, segFetch } from '@/utils/common/segFetch'
import { getErrorMessage } from "@/utils/common/apiResponse"
import { toast } from "sonner"
import {
  selectPatchClassificationData,
  setPatchClassificationData,
  updatePatchOverlayColors,
  clearPatchOverridesForIds,
  addNucleiClass,
  deleteNucleiClass,
  updateNucleiClass,
  type PatchOverlayEntry,
} from "@/store/slices/viewer/annotationSlice"
import { generateRandomColor } from "@/utils/common/color.utils"
import { AI_SERVICE_API_ENDPOINT } from "@/config/api.config"
import { formatPath } from "@/utils/common/path.utils"
import eventBus from "@/utils/common/eventBus"
import { usePathWriteAccess } from "@/hooks/usePathWriteAccess"
import {
  getDefaultOutputPath,
  scheduleCoalescedClassificationAfterAnnotation,
  scheduleCoalescedPatchClassificationAfterAnnotation,
} from "@/utils/agent/workflow/workflow.utils"
import { selectSelectedModelForPath } from "@/store/slices/chat/modelSelectionSlice"
import { annotationTypeStore } from "@/store/zustand/slice/annotationTypesStore"
import { savePNGFromCurrentSelection } from "@/utils/viewer/snapshot.utils"
import { useRefreshGtHighlightIndices } from "@/hooks/viewer/useRefreshGtHighlightIndices"
import { useUserInfo } from "@/contexts/UserInfoProvider"
import { resolveAnnotatorLabel } from "@/utils/viewer/annotator"

/** Prefer live Annotorious state — popup props lag behind resize. */
function getLiveAnnotation(
  annotator: any,
  annotation: ImageAnnotation,
): ImageAnnotation {
  try {
    const id = annotation?.id;
    if (id && annotator?.getAnnotationById) {
      return annotator.getAnnotationById(id) || annotation;
    }
  } catch {}
  return annotation;
}

function getAnnotationSelector(ann: any): any {
  const selector = ann?.target?.selector;
  return Array.isArray(selector)
    ? selector.find((s: any) => s?.type === 'POLYGON' || s?.type === 'RECTANGLE') ||
        selector[0]
    : selector;
}

function getPolygonPointsFromAnnotation(ann: any): number[][] | null {
  const selector = getAnnotationSelector(ann);
  if (String(selector?.type || '').toUpperCase() !== 'POLYGON') return null;
  const points = selector?.geometry?.points;
  return Array.isArray(points) && points.length > 0 ? points : null;
}

/** Live Annotorious bounds — Redux shapeCoords can lag ~50ms behind resize. */
function getBBoxFromAnnotation(
  ann: any,
  fallback: { x1: number; y1: number; x2: number; y2: number } | null,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const selector = getAnnotationSelector(ann);
  const bounds = selector?.geometry?.bounds;
  if (
    bounds &&
    typeof bounds.minX === 'number' &&
    typeof bounds.minY === 'number' &&
    typeof bounds.maxX === 'number' &&
    typeof bounds.maxY === 'number'
  ) {
    return {
      x1: bounds.minX,
      y1: bounds.minY,
      x2: bounds.maxX,
      y2: bounds.maxY,
    };
  }
  const g = selector?.geometry;
  if (
    String(selector?.type || '').toUpperCase() === 'RECTANGLE' &&
    typeof g?.x === 'number' &&
    typeof g?.y === 'number' &&
    typeof g?.w === 'number' &&
    typeof g?.h === 'number'
  ) {
    return { x1: g.x, y1: g.y, x2: g.x + g.w, y2: g.y + g.h };
  }
  const pts = getPolygonPointsFromAnnotation(ann);
  if (pts && pts.length > 0) {
    let minX = pts[0][0];
    let minY = pts[0][1];
    let maxX = pts[0][0];
    let maxY = pts[0][1];
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { x1: minX, y1: minY, x2: maxX, y2: maxY };
  }
  return fallback;
}

interface SelectionContentProps {
  annotation: ImageAnnotation
  customText: string
  onTextChange: (text: string) => void
  selectedColor: string
  onColorChange: (color: string) => void
  selectedTool: string
  annotatorInstance: any
  instanceId?: string | null
  onCancel: () => void
  /** Dismiss AND drop the drawn shape — for marks that consume the region. */
  onDiscardRegion?: () => void
  shapeCoords: { x1: number; y1: number; x2: number; y2: number } | null
  patches?: PatchOverlayEntry[]
}

export default function SelectionContent({ 
  annotation,
  customText, 
  onTextChange,
  selectedColor,
  onColorChange,
  selectedTool,
  annotatorInstance,
  instanceId: instanceIdProp,
  onCancel,
  onDiscardRegion,
  shapeCoords,
  patches: currentPatches = [],
}: SelectionContentProps) {
  const dispatch = useDispatch<AppDispatch>();
  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses);
  const reduxPatchClassificationData = useSelector(selectPatchClassificationData);
  const recolorPatchOverlay = useCallback(
    (payload: { ids: number[]; color: string; persistOverride?: boolean }) => {
      dispatch(updatePatchOverlayColors(payload));
    },
    [dispatch],
  );
  /** Close after a mark that consumed the region; plain dismiss if unwired. */
  const discardRegion = useCallback(() => {
    (onDiscardRegion || onCancel)();
  }, [onDiscardRegion, onCancel]);
  const currentPath = useInstanceSlidePath(instanceIdProp);
  const { assertWritable, toastIfDenied, allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(currentPath);
  const currentOrgan = useSelector((state: RootState) => state.workflow.currentOrgan);
  const updateAfterEveryAnnotation = useSelector((state: RootState) => state.workflow.updateAfterEveryAnnotation);
  const updatePatchAfterEveryAnnotation = useSelector((state: RootState) => state.workflow.updatePatchAfterEveryAnnotation);
  const patchClassifierPath = useSelector((state: RootState) => state.workflow.patchClassifierPath);
  const patchClassifierSavePath = useSelector((state: RootState) => state.workflow.patchClassifierSavePath);
  const selectedFolder = useSelector((state: RootState) => state.fileManager.selectedFolder);
  const isWebMode = useSelector((state: RootState) => {
    const activeInstanceId = state.wsi.activeInstanceId;
    const activeInstance = activeInstanceId ? state.wsi.instances[activeInstanceId] : undefined;
    const source = activeInstance?.fileInfo?.source as string | undefined;
    return source === 'web';
  });
  const selectedModelForCurrentPath = useSelector((state: RootState) => {
    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }
    if (isWebMode && targetPath === '') {
      targetPath = '';
    }
    return selectSelectedModelForPath(state, targetPath);
  });

  const refreshGtHighlightIndices = useRefreshGtHighlightIndices();

  // ── Inline "add class" editors in the region popup ──
  // Click "+" → an editable row (name input + color) appears; on Enter/blur it
  // commits into the class list (locked, non-editable) and behaves like the other
  // rows (Yes/No trigger the same annotation interface). Escape cancels.
  const [addingNuclei, setAddingNuclei] = useState(false);
  const [newNucleiName, setNewNucleiName] = useState("");
  const [newNucleiColor, setNewNucleiColor] = useState("#888888");
  const [addingTissue, setAddingTissue] = useState(false);
  const [newTissueName, setNewTissueName] = useState("");
  const [newTissueColor, setNewTissueColor] = useState("#888888");

  const startAddNuclei = () => {
    setNewNucleiName("");
    setNewNucleiColor(generateRandomColor(nucleiClasses.map((c) => c.color)));
    setAddingNuclei(true);
  };
  const commitNucleiClass = () => {
    const name = newNucleiName.trim();
    if (!name) { setAddingNuclei(false); return; }
    if (nucleiClasses.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      toast.warning(`Class "${name}" already exists`);
      setAddingNuclei(false);
      return;
    }
    dispatch(addNucleiClass({ name, count: 0, color: newNucleiColor }));
    setAddingNuclei(false);
  };
  const removeNucleiClass = (index: number) => {
    dispatch(deleteNucleiClass(index));
  };

  const startAddTissue = () => {
    setNewTissueName("");
    setNewTissueColor(generateRandomColor(reduxPatchClassificationData?.class_hex_color ?? []));
    setAddingTissue(true);
  };
  const commitTissueClass = () => {
    const name = newTissueName.trim();
    const data = reduxPatchClassificationData;
    if (!name || !data) { setAddingTissue(false); return; }
    if (data.class_name.some((n: string) => n.toLowerCase() === name.toLowerCase())) {
      toast.warning(`Class "${name}" already exists`);
      setAddingTissue(false);
      return;
    }
    const nextId = data.class_id.length ? Math.max(...data.class_id) + 1 : 0;
    const newData: any = {
      ...data,
      class_id: [...data.class_id, nextId],
      class_name: [...data.class_name, name],
      class_hex_color: [...data.class_hex_color, newTissueColor],
    };
    if (data.class_counts) newData.class_counts = [...data.class_counts, 0];
    dispatch(setPatchClassificationData(newData));
    setAddingTissue(false);
  };
  const removeTissueClass = (index: number) => {
    const data = reduxPatchClassificationData;
    if (!data) return;
    const keep = (_: unknown, i: number) => i !== index;
    const newData: any = {
      ...data,
      class_id: data.class_id.filter(keep),
      class_name: data.class_name.filter(keep),
      class_hex_color: data.class_hex_color.filter(keep),
    };
    if (data.class_counts) newData.class_counts = data.class_counts.filter(keep);
    dispatch(setPatchClassificationData(newData));
  };

  const formattedPath = formatPath(currentPath ?? "");

  // Annotation author: stored as the user id (always traceable). Held in a
  // ref so the save callbacks below don't need it in their dependency arrays.
  const { userInfo } = useUserInfo();
  const annotatorLabelRef = useRef('Unknown');
  useEffect(() => {
    annotatorLabelRef.current = resolveAnnotatorLabel({ userId: userInfo?.user_id });
  }, [userInfo?.user_id]);

  const isPointInsidePolygon = useCallback((x: number, y: number, polygon: number[][]) => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = Number(polygon[i]?.[0] ?? 0);
      const yi = Number(polygon[i]?.[1] ?? 0);
      const xj = Number(polygon[j]?.[0] ?? 0);
      const yj = Number(polygon[j]?.[1] ?? 0);
      const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }, []);

  const refreshPatchCountsFromServer = useCallback(async () => {
    try {
      const resp = await segFetch(instanceIdProp, `${AI_SERVICE_API_ENDPOINT}/seg/v1/patch_classification`, {method: 'GET',
        returnAxiosFormat: true});
      const payload = resp.data?.data ?? resp.data;
      if (!payload || !Array.isArray(payload.class_name) || payload.class_name.length === 0) {
        return;
      }

      const coerceCounts = (arr: any[] | undefined, fallbackLength: number) => {
        if (!Array.isArray(arr)) {
          return new Array(fallbackLength).fill(0);
        }
        return arr.map((value) => {
          const numeric = Number(value);
          return Number.isFinite(numeric) ? numeric : 0;
        });
      };

      const mergedData = {
        class_id: Array.isArray(payload.class_id) ? [...payload.class_id] : [],
        class_name: [...payload.class_name],
        class_hex_color: Array.isArray(payload.class_hex_color) ? [...payload.class_hex_color] : new Array(payload.class_name.length).fill('#aaaaaa'),
        class_counts: coerceCounts(payload.class_counts, payload.class_name.length),
      };

      if (reduxPatchClassificationData && reduxPatchClassificationData.class_name) {
        reduxPatchClassificationData.class_name.forEach((localName, index) => {
          const existingIndex = mergedData.class_name.findIndex((name) => name === localName);
          if (existingIndex === -1) {
            const numericIds = mergedData.class_id
              .map((val) => (Number.isFinite(Number(val)) ? Number(val) : null))
              .filter((val) => val !== null) as number[];
            const nextId = numericIds.length > 0 ? Math.max(...numericIds) + 1 : mergedData.class_name.length;
            mergedData.class_name.push(localName);
            mergedData.class_hex_color.push(reduxPatchClassificationData.class_hex_color[index]);
            mergedData.class_id.push(nextId);
            const fallbackCount = reduxPatchClassificationData.class_counts?.[index] ?? 0;
            mergedData.class_counts.push(Number.isFinite(Number(fallbackCount)) ? Number(fallbackCount) : 0);
          } else if (mergedData.class_counts[existingIndex] === undefined) {
            const fallbackCount = reduxPatchClassificationData.class_counts?.[index] ?? 0;
            mergedData.class_counts[existingIndex] = Number.isFinite(Number(fallbackCount)) ? Number(fallbackCount) : 0;
          }
        });
      }

      if (mergedData.class_counts.length < mergedData.class_name.length) {
        mergedData.class_counts = [
          ...mergedData.class_counts,
          ...new Array(mergedData.class_name.length - mergedData.class_counts.length).fill(0),
        ];
      }

      dispatch(setPatchClassificationData(mergedData));
    } catch (error) {
      if (isSegmentationHandlerNotReadyError(error)) return;
      console.warn('Failed to refresh patch classification data:', error);
    }
  }, [dispatch, reduxPatchClassificationData, instanceIdProp]);

  const applyOptimisticAnnotationTypes = useCallback((
    updates: Array<{ id: string; classIndex?: number; color: string; category: string }>
  ) => {
    if (!updates.length) return () => {};

    annotationTypeStore.getState().setMany(
      updates.map(update => ({
        id: update.id,
        classIndex: update.classIndex ?? 0,
        color: update.color,
        category: update.category,
      }))
    );

    return () => {
      annotationTypeStore.getState().removeMany(updates.map(update => update.id));
    };
  }, []);

  const markAllNuclei = useCallback(async (item: any) => {
    // Check if in samples directory
    if (!assertWritable('annotate')) {
      onCancel();
      return;
    }

    // Live Annotorious geometry — popup `annotation` props / Redux shapeCoords
    // can lag after resize (shape dispatch is debounced ~50ms).
    const live = getLiveAnnotation(annotatorInstance, annotation);
    const bbox = getBBoxFromAnnotation(live, shapeCoords);
    if (!bbox) {
      console.error("Shape coordinates not found. Cannot mark nuclei.");
      return;
    }
    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = bbox;
    let polygonRawPoints = getPolygonPointsFromAnnotation(live);
    const selectorType = getAnnotationSelector(live)?.type;

    // 3. Prepare API parameters
    const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/query`;
    const apiParams: any = { // Build API parameters
      "x1": bboxX1,
      "x2": bboxX2,
      "y1": bboxY1,
      "y2": bboxY2,
      "class_name": item.name,
      "color": item.color,
      "file_path": formattedPath
    };

    // 4. If it was a polygon, add the stringified raw points
    if (polygonRawPoints) {
      try {
        // Use the alias 'polygon_points' matching the backend Query parameter
        const pts = polygonRawPoints || [];
        apiParams.polygon_points = JSON.stringify(pts);
      } catch (e) {}
    }

    try {
      const urlWithParams = `${url}?${new URLSearchParams(apiParams as Record<string, string>).toString()}`;
      const response = await segFetch(instanceIdProp, urlWithParams, {method: 'GET',
        returnAxiosFormat: true});
      const responseData = response.data;
      const matching_indices = responseData?.matching_indices ?? [];

      const classIndex = nucleiClasses.findIndex((c) => c.name === item.name);
      const updates = matching_indices.map((idx: any) => ({
        id: idx.toString(),
        classIndex,
        color: item.color,
        category: item.name,
      }));

      if (!updates.length) {
        toast('No nuclei detected in this region.');
        return;
      }

      const rollback = applyOptimisticAnnotationTypes(updates);

      if (annotatorInstance && annotatorInstance.viewer) {
        annotatorInstance.viewer.raiseEvent('update-viewport');
        annotatorInstance.viewer.raiseEvent('animation');
        annotatorInstance.viewer.raiseEvent('animation-finish');
      }

      // Selection consumed by the mark — see markTissue. The region used to be
      // recolored to the class here; there is no shape left to recolor now.
      discardRegion();
      try {
        annotatorInstance?.viewer?.forceRedraw?.();
      } catch {}

      // Omit matching_indices: backend re-queries from region_geometry / polygon_vertices
      const savePayload: any = {
        path: getDefaultOutputPath(formattedPath),
        wf_id: 1,
        region_geometry: { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 },
        classification: item.name,
        color: item.color,
        method: `${selectorType || selectedTool || 'unknown'} selection`.toLowerCase(),
        annotator: annotatorLabelRef.current,
        ui_nuclei_classes: nucleiClasses.map((cls) => cls.name),
        ui_nuclei_colors: nucleiClasses.map((cls) => cls.color),
        ui_organ: currentOrgan,
      };
      if (polygonRawPoints) savePayload.polygon_vertices = polygonRawPoints;

      if (!instanceIdProp) {
        console.warn('[SelectionContent] Missing instanceIdProp; aborting save_annotation to avoid mismatched session.');
        return;
      }

      void segFetch(instanceIdProp, `${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_annotation`, {method: 'POST',
        body: JSON.stringify(savePayload),
        returnAxiosFormat: true})
        .then(() => {
          try {
            eventBus.emit('refresh-annotations');
          } catch {}
          try {
            eventBus.emit('refresh-websocket-path', {
              path: formattedPath,
              skipViewportRefresh: true,
            });
          } catch {}
          refreshGtHighlightIndices(currentPath);

          if (updateAfterEveryAnnotation && currentPath && nucleiClasses.length > 0) {
            const zarrPath = getDefaultOutputPath(formattedPath);
            // Coalesced, not a bare emit: WorkflowGraph drops the trigger while a
            // run is in flight, so back-to-back marks lost every update after the
            // first one. The coalescer replays a single follow-up on run finish.
            scheduleCoalescedClassificationAfterAnnotation(() => ({
              zarrPath,
              source: 'auto-selection-mark',
            }));
          }
        })
        .catch((err) => {
          rollback();
          if (!isSegmentationHandlerNotReadyError(err)) {
            console.warn('POST /save_annotation error or workflow trigger error:', err);
          }
          
          // Check if error is related to samples directory restriction
          if (!toastIfDenied(err, 'annotate nuclei', 'Failed to save nuclei annotations. Reverted to previous state.')) {
            toast.error(getErrorMessage(err, 'Failed to save nuclei annotations. Reverted to previous state.'));
          }
          
          eventBus.emit('refresh-websocket-path', { path: formattedPath, skipViewportRefresh: true });
        });
    } catch (error) {
      console.error('Error during markAllNuclei API call or processing:', error);
      
      // Check if error is related to samples directory restriction
      if (!toastIfDenied(error, 'annotate nuclei', 'Unable to mark nuclei for this region.')) {
        toast.error(getErrorMessage(error, 'Unable to mark nuclei for this region.'));
      }
    }
  }, [assertWritable, toastIfDenied, currentPath, shapeCoords, annotation, nucleiClasses, applyOptimisticAnnotationTypes, annotatorInstance, onCancel, discardRegion, formattedPath, selectedTool, currentOrgan, instanceIdProp, updateAfterEveryAnnotation, dispatch, refreshGtHighlightIndices]);

  /** Mark region as "NOT this class" (negative selection): same as tissue, exclude_classes=[className] */
  const markNucleiExclude = useCallback(async (item: { name: string }) => {
    if (!assertWritable('annotate')) {
      onCancel();
      return;
    }
    const liveExcl = getLiveAnnotation(annotatorInstance, annotation);
    const bboxExcl = getBBoxFromAnnotation(liveExcl, shapeCoords);
    if (!bboxExcl) {
      console.error("Shape coordinates not found. Cannot mark nuclei exclude.");
      return;
    }
    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = bboxExcl;
    const polygonRawPoints = getPolygonPointsFromAnnotation(liveExcl);
    const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/query`;
    const apiParams: any = {
      x1: bboxX1, x2: bboxX2, y1: bboxY1, y2: bboxY2,
      file_path: formattedPath,
      // Needed to tell which of the matched cells this "No" actually contradicts.
      // Opt-in on the endpoint: plain viewport refreshes must not pay for it.
      with_classes: 'true',
    };
    if (polygonRawPoints) apiParams.polygon_points = JSON.stringify(polygonRawPoints);
    try {
      const urlWithParams = `${url}?${new URLSearchParams(apiParams as Record<string, string>).toString()}`;
      const response = await segFetch(instanceIdProp, urlWithParams, {method: 'GET',
        returnAxiosFormat: true});
      const responseData = response.data;
      const matching_indices = responseData?.matching_indices ?? [];
      if (!matching_indices.length) {
        toast('No nuclei in this region.');
        return;
      }
      if (!instanceIdProp) {
        console.warn('[SelectionContent] Missing instanceIdProp; aborting save_annotation (exclude).');
        toast.error('Missing session; cannot save.');
        return;
      }

      // Only the cells this "No" contradicts lose their colour — the same rule
      // the backend applies in _clear_contradicted_predictions, so the refresh
      // that follows confirms this rather than reverting it. Resolve the class
      // against the palette the response carries, not local `nucleiClasses`:
      // matching_class_ids index the handler's palette, ordered independently.
      // #808080 is what the overlay paints unclassified (PALETTE_INDEX_NONE),
      // so the colour does not shift again when the real data lands — but the
      // label says "Not <class>", because that is what the user actually told
      // us. "Unclassified" would read as "nobody has said anything about this
      // cell", which is the opposite of having just marked it.
      const responseClassNames: string[] = responseData?.class_names ?? [];
      const matchingClassIds: number[] = responseData?.matching_class_ids ?? [];
      const excludedClassId = responseClassNames.indexOf(item.name);
      const contradicted = excludedClassId < 0
        ? []
        : matching_indices.filter(
            (_idx: any, i: number) => matchingClassIds[i] === excludedClassId,
          );
      const rollback = contradicted.length
        ? applyOptimisticAnnotationTypes(
            contradicted.map((idx: any) => ({
              id: idx.toString(),
              classIndex: -1,
              color: '#808080',
              category: `Not ${item.name}`,
            })),
          )
        : () => {};
      if (contradicted.length && annotatorInstance?.viewer) {
        annotatorInstance.viewer.raiseEvent('update-viewport');
        annotatorInstance.viewer.raiseEvent('animation');
        annotatorInstance.viewer.raiseEvent('animation-finish');
      }

      // Selection consumed by the mark — see markTissue.
      discardRegion();
      try {
        annotatorInstance?.viewer?.forceRedraw?.();
      } catch {}
      // Omit matching_indices: backend re-queries from region_geometry / polygon_vertices
      const savePayload: any = {
        path: getDefaultOutputPath(formattedPath),
        region_geometry: { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 },
        classification: null,
        exclude_classes: [item.name],
        color: '#aaaaaa',
        method: 'negative selection',
        annotator: annotatorLabelRef.current,
        ui_nuclei_classes: nucleiClasses.map((c) => c.name),
        ui_nuclei_colors: nucleiClasses.map((c) => c.color),
        ui_organ: currentOrgan,
      };
      // Send the drawn polygon vertices for a negative selection too, so the
      // stored geometry is the real lasso shape, not just its 4-corner bbox.
      if (polygonRawPoints) savePayload.polygon_vertices = polygonRawPoints;
      void segFetch(instanceIdProp, `${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_annotation`, {method: 'POST',
        body: JSON.stringify(savePayload),
        returnAxiosFormat: true})
        .then(() => {
          eventBus.emit('refresh-annotations');
          eventBus.emit('refresh-websocket-path', { path: formattedPath, skipViewportRefresh: true });
          toast.success(`Marked region as not "${item.name}"`);
          refreshGtHighlightIndices(currentPath);

          if (updateAfterEveryAnnotation && currentPath && nucleiClasses.length > 0) {
            const zarrPath = getDefaultOutputPath(formattedPath);
            scheduleCoalescedClassificationAfterAnnotation(() => ({
              zarrPath,
              source: 'auto-selection-exclude',
            }));
          }
        })
        .catch((err) => {
          rollback();
          if (!isSegmentationHandlerNotReadyError(err)) {
            console.warn('POST save_annotation (exclude) error:', err);
          }
          if (!toastIfDenied(err, 'annotate nuclei', 'Failed to save nuclei exclusion. Reverted to previous state.')) {
            toast.error(getErrorMessage(err, 'Failed to save nuclei exclusion. Reverted to previous state.'));
          }
          eventBus.emit('refresh-websocket-path', { path: formattedPath, skipViewportRefresh: true });
        });
    } catch (e) {
      console.error('markNucleiExclude error:', e);
      toast.error(getErrorMessage(e, 'Unable to mark nuclei exclude for this region.'));
    }
  }, [assertWritable, toastIfDenied, currentPath, shapeCoords, annotation, nucleiClasses, applyOptimisticAnnotationTypes, formattedPath, currentOrgan, instanceIdProp, annotatorInstance, onCancel, discardRegion, updateAfterEveryAnnotation, dispatch, refreshGtHighlightIndices]);

  const markTissue = useCallback(async (classId: number) => {
    // Check if in samples directory first
    if (!assertWritable('annotate tissue')) {
      onCancel();
      return;
    }

    const liveTissue = getLiveAnnotation(annotatorInstance, annotation);
    const bboxTissue = getBBoxFromAnnotation(liveTissue, shapeCoords);
    if (!bboxTissue) {
      console.error('[MarkTissue] Shape coordinates not found.');
      toast.error('Unable to mark tissue: Missing region coordinates.');
      return;
    }
    const { x1: rawBBoxX1, y1: rawBBoxY1, x2: rawBBoxX2, y2: rawBBoxY2 } = bboxTissue;

    if (!reduxPatchClassificationData) {
      toast.error('Patch classification metadata is not available.');
      return;
    }
    if (classId < 0 || classId >= reduxPatchClassificationData.class_name.length) {
      toast.error('Invalid patch classification selection.');
      return;
    }
    const className = reduxPatchClassificationData.class_name[classId];
    const colorHex = reduxPatchClassificationData.class_hex_color[classId] || '#FFFF00';

    let polygonRawPoints: number[][] | null = null;
    const selector = getAnnotationSelector(liveTissue);
    const selectorType = selector?.type;
    polygonRawPoints = getPolygonPointsFromAnnotation(liveTissue);
    if (polygonRawPoints) {
      console.log('[MarkTissue] Detected Polygon, raw points obtained:', polygonRawPoints);
    } else if (selectorType === 'POLYGON') {
      console.warn('[MarkTissue] Polygon selector detected, but raw points are missing or invalid.', selector?.geometry);
    } else {
      console.log('[MarkTissue] Detected Rectangle or other shape type.');
    }

    const saveUrl = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_patch`;

    let method = 'polygon selection';
    if (selectorType === 'RECTANGLE') {
      method = 'rectangle selection';
    } else if (selectorType === 'LINE') {
      method = 'line selection';
    }
    
    const payload: any = {
      path: getDefaultOutputPath(formattedPath),
      start_x: rawBBoxX1,
      start_y: rawBBoxY1,
      end_x: rawBBoxX2,
      end_y: rawBBoxY2,
      classification: className,
      color: colorHex,
      method: method,
      annotator: annotatorLabelRef.current,
      // Authoritative global class ordering from the panel. Backend stores int
      // indices into User-Annotations/patch — without this list it can't know
      // that "Lymphocytes" is class 1 (not 0) when Patch-Classification was
      // just reset and no zarr group has the ordering yet.
      tissue_classes: [...reduxPatchClassificationData.class_name],
      tissue_colors: [...reduxPatchClassificationData.class_hex_color],
    };

    if (polygonRawPoints) {
      payload.polygon_points = polygonRawPoints;
      console.log('[MarkTissue] Adding polygon_points to save_patch payload:', payload.polygon_points);
    }

    const previousColorById = new Map<number, string>();
    const optimisticIds: number[] = [];

    if (currentPatches && currentPatches.length > 0) {
      const polygonPoints = polygonRawPoints && polygonRawPoints.length >= 3
        ? polygonRawPoints.map((pt: any) => [Number(pt[0]), Number(pt[1])])
        : null;

      currentPatches.forEach((patch) => {
        // Extract patch data: [idx, x, y, width, height, color, class_id?]
        // Support both old format (6 elements) and new format (7 elements with class_id)
        const [patchId, patchX, patchY, patchWidth, patchHeight, patchColor] = patch;
        if (
          patchX >= rawBBoxX1 && patchX <= rawBBoxX2 &&
          patchY >= rawBBoxY1 && patchY <= rawBBoxY2
        ) {
          if (polygonPoints && !isPointInsidePolygon(patchX, patchY, polygonPoints)) {
            return;
          }
          optimisticIds.push(patchId);
          if (!previousColorById.has(patchId)) {
            previousColorById.set(patchId, patchColor);
          }
        }
      });
    }

    if (optimisticIds.length) {
      // persistOverride: true → the marked color is stored in patchOverrides so
      // it SURVIVES the refresh-websocket-path reload below (which otherwise
      // repaints from the stale prediction). The container drops it again once a
      // workflow run has finished AND its handler reload has landed — see
      // shouldDropStaleOverrides. Nothing clears it on a plain re-bind, so the
      // mark survives leaving and returning to the page.
      recolorPatchOverlay({ ids: optimisticIds, color: colorHex, persistOverride: true });
    }

    const revertGroups = (() => {
      const grouped = new Map<string, number[]>();
      previousColorById.forEach((color, id) => {
        if (!grouped.has(color)) {
          grouped.set(color, []);
        }
        grouped.get(color)!.push(id);
      });
      return Array.from(grouped.entries()).map(([color, ids]) => ({ color, ids }));
    })();

    const revertOptimisticUpdates = () => {
      revertGroups.forEach(({ color, ids }) => {
        recolorPatchOverlay({ ids, color, persistOverride: false });
      });
    };

    const zarrPath = getDefaultOutputPath(formattedPath);

    if (!instanceIdProp) {
      console.warn('[SelectionContent] Missing instanceIdProp; aborting save_patch to avoid mismatched session.');
      revertOptimisticUpdates();
      onCancel();
      return;
    }

    // The drawing was only the selection for this mark — drop it instead of
    // leaving a manual annotation on the slide. save_patch (below) still writes
    // the polygon to Zarr as the patch selection geometry.
    discardRegion();

    // Direct API call (same as cell annotation) - no queue
    void segFetch(instanceIdProp, saveUrl, {method: 'POST',
      body: JSON.stringify(payload),
      returnAxiosFormat: true})
      .then((response) => {
        try {
          // Update UI immediately (synchronous)
          const matchingIndices: number[] = response?.data?.data?.matching_indices ?? response?.data?.matching_indices ?? [];
          if (matchingIndices.length > 0) {
            const normalizedIds = matchingIndices.map((idx) => Number(idx));
            // Backend-confirmed marked patches: persist (survive reload) until the
            // workflow re-predicts; the unconfirmed ones below revert (false).
            recolorPatchOverlay({ ids: normalizedIds, color: colorHex, persistOverride: true });
            if (optimisticIds.length) {
              const backendIdSet = new Set(normalizedIds);
              revertGroups.forEach(({ color, ids }) => {
                const missing = ids.filter((id) => !backendIdSet.has(id));
                if (missing.length) {
                  recolorPatchOverlay({ ids: missing, color, persistOverride: false });
                }
              });
            }
            eventBus.emit('refresh-patches');
          } else if (optimisticIds.length) {
            revertOptimisticUpdates();
          }

          // Fire-and-forget: Don't block on query operations
          // Refresh operations are async and don't need to wait
          eventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
          refreshGtHighlightIndices(currentPath);

          // Route patch auto-update through the panel's manual update handler
          // so payload semantics (including class_operations) stay identical.
          if (updatePatchAfterEveryAnnotation && currentPath && reduxPatchClassificationData) {
            scheduleCoalescedPatchClassificationAfterAnnotation(() => ({
              zarrPath,
              source: 'auto-selection-mark',
            }));
          }

          // Refresh counts asynchronously - don't block
          refreshPatchCountsFromServer().catch(err => {
            if (!isSegmentationHandlerNotReadyError(err)) {
              console.warn('[SelectionContent] Refresh counts error:', err);
            }
          });
        } catch (err) {
          console.error('[MarkTissue] Error processing response:', err);
        }
      })
      .catch((err) => {
        revertOptimisticUpdates();
        if (!isSegmentationHandlerNotReadyError(err)) {
          console.warn('POST /save_patch error:', err);
        }
        
        // Check for specific error types and provide user-friendly messages
        const errorMessage = getErrorMessage(err, '');
        
        if (toastIfDenied(err, 'annotate tissue', 'Failed to save tissue annotations.')) {
          // path ACL denial already toasted
        } else if (errorMessage.includes('Patch coordinates data could not be loaded from Zarr') || 
                   errorMessage.includes('Zarr') || 
                   errorMessage.includes('patch coordinates')) {
          toast.error(getErrorMessage(err, 'Unable to load patch data. Please ensure the image has been properly processed and try again.'));
        } else if (errorMessage.includes('network') || errorMessage.includes('timeout')) {
          toast.error(getErrorMessage(err, 'Network error occurred. Please check your connection and try again.'));
        } else if (errorMessage.includes('permission') || errorMessage.includes('access')) {
          toast.error(getErrorMessage(err, 'Permission denied. Please check your file access rights.'));
        } else {
          toast.error(getErrorMessage(err, 'Failed to save tissue annotations. Please try again or contact support if the issue persists.'));
        }
        
        eventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
      });
  }, [assertWritable, toastIfDenied, currentPath, shapeCoords, reduxPatchClassificationData, annotation, formattedPath, currentPatches, isPointInsidePolygon, dispatch, recolorPatchOverlay, annotatorInstance, onCancel, discardRegion, updatePatchAfterEveryAnnotation, refreshPatchCountsFromServer, refreshGtHighlightIndices]);

  /** Mark region as "NOT this class" (negative selection): tissue_class=null, exclude_classes=[className] */
  const markTissueExclude = useCallback(async (classId: number) => {
    if (!assertWritable('annotate tissue')) {
      onCancel();
      return;
    }
    if (!reduxPatchClassificationData || classId < 0 || classId >= reduxPatchClassificationData.class_name.length) {
      toast.error('Invalid patch classification selection.');
      return;
    }
    const liveTissueExcl = getLiveAnnotation(annotatorInstance, annotation);
    const bboxTissueExcl = getBBoxFromAnnotation(liveTissueExcl, shapeCoords);
    if (!bboxTissueExcl) {
      toast.error('Unable to mark tissue: Missing region coordinates.');
      return;
    }
    const { x1: rawBBoxX1, y1: rawBBoxY1, x2: rawBBoxX2, y2: rawBBoxY2 } = bboxTissueExcl;
    const className = reduxPatchClassificationData.class_name[classId];
    let polygonRawPoints: number[][] | null = null;
    const selector = getAnnotationSelector(liveTissueExcl);
    const selectorType = selector?.type;
    if (selectorType === 'POLYGON') {
      const geometry = selector.geometry as any;
      if (geometry?.points?.length) polygonRawPoints = geometry.points;
    }
    const saveUrl = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_patch`;
    const payload: any = {
      path: getDefaultOutputPath(formattedPath),
      start_x: rawBBoxX1,
      start_y: rawBBoxY1,
      end_x: rawBBoxX2,
      end_y: rawBBoxY2,
      classification: null,
      exclude_classes: [className],
      color: '#aaaaaa',
      method: 'negative selection',
      annotator: annotatorLabelRef.current,
      tissue_classes: [...reduxPatchClassificationData.class_name],
      tissue_colors: [...reduxPatchClassificationData.class_hex_color],
    };
    if (polygonRawPoints) payload.polygon_points = polygonRawPoints;

    const previousColorById = new Map<number, string>();
    const optimisticIds: number[] = [];
    if (currentPatches && currentPatches.length > 0) {
      const polygonPoints = polygonRawPoints && polygonRawPoints.length >= 3
        ? polygonRawPoints.map((pt: any) => [Number(pt[0]), Number(pt[1])])
        : null;
      currentPatches.forEach((patch) => {
        // Extract patch data: [idx, x, y, width, height, color, class_id?]
        // Support both old format (6 elements) and new format (7 elements with class_id)
        const [patchId, patchX, patchY, patchWidth, patchHeight, patchColor] = patch;
        if (
          patchX >= rawBBoxX1 && patchX <= rawBBoxX2 &&
          patchY >= rawBBoxY1 && patchY <= rawBBoxY2
        ) {
          if (polygonPoints && !isPointInsidePolygon(patchX, patchY, polygonPoints)) return;
          optimisticIds.push(patchId);
          if (!previousColorById.has(patchId)) previousColorById.set(patchId, patchColor);
        }
      });
    }
    const revertGroups = (() => {
      const grouped = new Map<string, number[]>();
      previousColorById.forEach((color, id) => {
        if (!grouped.has(color)) grouped.set(color, []);
        grouped.get(color)!.push(id);
      });
      return Array.from(grouped.entries()).map(([color, ids]) => ({ color, ids }));
    })();
    const revertOptimisticUpdates = () => {
      revertGroups.forEach(({ color, ids }) => {
        recolorPatchOverlay({ ids, color, persistOverride: false });
      });
    };
    if (optimisticIds.length) {
      recolorPatchOverlay({ ids: optimisticIds, color: '#aaaaaa', persistOverride: false });
    }
    if (!instanceIdProp) {
      console.warn('[SelectionContent] Missing instanceIdProp; aborting save_patch (exclude).');
      revertOptimisticUpdates();
      onCancel();
      return;
    }
    // Selection consumed by the mark — see markTissue.
    discardRegion();
    const zarrPath = getDefaultOutputPath(formattedPath);
    void segFetch(instanceIdProp, saveUrl, {method: 'POST',
      body: JSON.stringify(payload),
      returnAxiosFormat: true})
      .then((response) => {
        const matchingIndices: number[] = response?.data?.data?.matching_indices ?? response?.data?.matching_indices ?? [];
        if (matchingIndices.length > 0) {
          const normalizedIds = matchingIndices.map((i: number) => Number(i));
          dispatch(clearPatchOverridesForIds(normalizedIds));
          if (optimisticIds.length) {
            const backendIdSet = new Set(normalizedIds);
            revertGroups.forEach(({ color, ids }) => {
              const missing = ids.filter((id) => !backendIdSet.has(id));
              if (missing.length) recolorPatchOverlay({ ids: missing, color, persistOverride: false });
            });
          }
          eventBus.emit('refresh-patches');
        } else if (optimisticIds.length) revertOptimisticUpdates();
        eventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
        if (updatePatchAfterEveryAnnotation && currentPath && reduxPatchClassificationData) {
          scheduleCoalescedPatchClassificationAfterAnnotation(() => ({
            zarrPath,
            source: 'auto-selection-exclude',
          }));
        }
        refreshPatchCountsFromServer().catch(() => {});
        refreshGtHighlightIndices(currentPath);
      })
      .catch((err) => {
        revertOptimisticUpdates();
        if (!isSegmentationHandlerNotReadyError(err)) {
          console.warn('POST /save_patch (exclude) error:', err);
        }
        if (!toastIfDenied(err, 'annotate tissue', 'Failed to save tissue exclusion.')) {
          toast.error(getErrorMessage(err, 'Failed to save tissue exclusion.'));
        }
        eventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
      });
  }, [assertWritable, toastIfDenied, currentPath, shapeCoords, reduxPatchClassificationData, annotation, formattedPath, currentPatches, isPointInsidePolygon, dispatch, recolorPatchOverlay, annotatorInstance, onCancel, discardRegion, updatePatchAfterEveryAnnotation, refreshPatchCountsFromServer, refreshGtHighlightIndices]);

  const clearNucleiAnnotations = useCallback(async () => {
    // Check if in samples directory
    if (!assertWritable('clear annotations')) {
      onCancel();
      return;
    }

    const liveClearNuclei = getLiveAnnotation(annotatorInstance, annotation);
    const bboxClearNuclei = getBBoxFromAnnotation(liveClearNuclei, shapeCoords);
    if (!bboxClearNuclei) {
      console.error("Shape coordinates not found. Cannot clear nuclei annotations.");
      toast.error('Unable to clear annotations: Missing region coordinates.');
      return;
    }

    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = bboxClearNuclei;

    // Get polygon points if available (live Annotorious — popup props can be stale).
    let polygonRawPoints = getPolygonPointsFromAnnotation(liveClearNuclei);

    try {
      const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/clear_nuclei_annotations`;
      const payload: any = {
        path: getDefaultOutputPath(formattedPath),
        x1: bboxX1,
        y1: bboxY1,
        x2: bboxX2,
        y2: bboxY2,
      };

      if (polygonRawPoints) {
        payload.polygon_points = polygonRawPoints;
      }

      if (!instanceIdProp) {
        console.warn('[SelectionContent] Missing instanceIdProp; aborting request.');
        return;
      }

      const response = await segFetch(instanceIdProp, url, {method: 'POST',
        body: JSON.stringify(payload),
        returnAxiosFormat: true});

      const clearedCount = response?.data?.data?.cleared_count ?? response?.data?.cleared_count ?? 0;
      
      if (clearedCount > 0) {
        toast.success(`Cleared ${clearedCount} nuclei annotation(s)`);
        
        // Refresh annotations
        eventBus.emit('refresh-annotations');
        eventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
        refreshGtHighlightIndices(currentPath);
      } else {
        toast('No nuclei annotations found in this region.');
      }

      onCancel();
    } catch (error) {
      console.error('Error clearing nuclei annotations:', error);
      if (!toastIfDenied(error, 'clear annotations', 'Failed to clear nuclei annotations.')) {
        toast.error(getErrorMessage(error, 'Failed to clear nuclei annotations.'));
      }
    }
  }, [assertWritable, toastIfDenied, currentPath, shapeCoords, annotation, formattedPath, instanceIdProp, annotatorInstance, onCancel, refreshGtHighlightIndices]);

  const clearTissueAnnotations = useCallback(async () => {
    // Check if in samples directory
    if (!assertWritable('clear annotations')) {
      onCancel();
      return;
    }

    const liveClearTissue = getLiveAnnotation(annotatorInstance, annotation);
    const bboxClearTissue = getBBoxFromAnnotation(liveClearTissue, shapeCoords);
    if (!bboxClearTissue) {
      console.error("Shape coordinates not found. Cannot clear tissue annotations.");
      toast.error('Unable to clear annotations: Missing region coordinates.');
      return;
    }

    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = bboxClearTissue;

    // Get polygon points if available (live Annotorious — popup props can be stale).
    let polygonRawPoints = getPolygonPointsFromAnnotation(liveClearTissue);

    try {
      const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/clear_tissue_annotations`;
      const payload: any = {
        path: getDefaultOutputPath(formattedPath),
        x1: bboxX1,
        y1: bboxY1,
        x2: bboxX2,
        y2: bboxY2,
      };

      if (polygonRawPoints) {
        payload.polygon_points = polygonRawPoints;
      }

      if (!instanceIdProp) {
        console.warn('[SelectionContent] Missing instanceIdProp; aborting request.');
        return;
      }

      const response = await segFetch(instanceIdProp, url, {method: 'POST',
        body: JSON.stringify(payload),
        returnAxiosFormat: true});

      const clearedCount = response?.data?.data?.cleared_count ?? response?.data?.cleared_count ?? 0;
      
      if (clearedCount > 0) {
        toast.success(`Cleared ${clearedCount} tissue annotation(s)`);
        
        // Refresh patches and annotations
        eventBus.emit('refresh-patches');
        eventBus.emit('refresh-annotations');
        eventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
        refreshGtHighlightIndices(currentPath);
        
        // Refresh patch counts from server
        await refreshPatchCountsFromServer();
      } else {
        toast('No tissue annotations found in this region.');
      }

      onCancel();
    } catch (error) {
      console.error('Error clearing tissue annotations:', error);
      if (!toastIfDenied(error, 'clear annotations', 'Failed to clear tissue annotations.')) {
        toast.error(getErrorMessage(error, 'Failed to clear tissue annotations.'));
      }
    }
  }, [assertWritable, toastIfDenied, currentPath, shapeCoords, annotation, formattedPath, instanceIdProp, annotatorInstance, onCancel, refreshPatchCountsFromServer, refreshGtHighlightIndices]);

  const markNucleiAsGroundTruth = useCallback(async () => {
    // Check if in samples directory
    if (!assertWritable('mark as ground truth')) {
      onCancel();
      return;
    }

    const liveGtNuclei = getLiveAnnotation(annotatorInstance, annotation);
    const bboxGtNuclei = getBBoxFromAnnotation(liveGtNuclei, shapeCoords);
    if (!bboxGtNuclei) {
      console.error("Shape coordinates not found. Cannot mark nuclei as ground truth.");
      toast.error('Unable to mark as ground truth: Missing region coordinates.');
      return;
    }

    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = bboxGtNuclei;

    // Get polygon points if available (live Annotorious — popup props can be stale).
    let polygonRawPoints = getPolygonPointsFromAnnotation(liveGtNuclei);

    try {
      const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/save_annotation/batch`;
      const payload: any = {
        path: getDefaultOutputPath(formattedPath),
        annotation_type: 'nuclei',
        x1: bboxX1,
        y1: bboxY1,
        x2: bboxX2,
        y2: bboxY2,
        annotator: annotatorLabelRef.current,
      };

      if (polygonRawPoints) {
        payload.polygon_points = polygonRawPoints;
      }

      if (!instanceIdProp) {
        console.warn('[SelectionContent] Missing instanceIdProp; aborting request.');
        return;
      }

      const response = await segFetch(instanceIdProp, url, {method: 'POST',
        body: JSON.stringify(payload),
        returnAxiosFormat: true});

      const markedCount = response?.data?.data?.marked_count ?? response?.data?.marked_count ?? 0;
      
      if (markedCount > 0) {
        toast.success(`Marked ${markedCount} nuclei annotation(s) as ground truth`);
        
        // Refresh annotations
        eventBus.emit('refresh-annotations');
        eventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
        refreshGtHighlightIndices(currentPath);
      } else {
        toast('No AI-predicted nuclei annotations found in this region to mark as ground truth.');
      }

      onCancel();
    } catch (error) {
      console.error('Error marking nuclei as ground truth:', error);
      if (!toastIfDenied(error, 'mark as ground truth', 'Failed to mark nuclei as ground truth.')) {
        toast.error(getErrorMessage(error, 'Failed to mark nuclei as ground truth.'));
      }
    }
  }, [assertWritable, toastIfDenied, currentPath, shapeCoords, annotation, formattedPath, instanceIdProp, annotatorInstance, onCancel, refreshGtHighlightIndices]);

  const markTissueAsGroundTruth = useCallback(async () => {
    // Check if in samples directory
    if (!assertWritable('mark as ground truth')) {
      onCancel();
      return;
    }

    const liveGtTissue = getLiveAnnotation(annotatorInstance, annotation);
    const bboxGtTissue = getBBoxFromAnnotation(liveGtTissue, shapeCoords);
    if (!bboxGtTissue) {
      console.error("Shape coordinates not found. Cannot mark tissue as ground truth.");
      toast.error('Unable to mark as ground truth: Missing region coordinates.');
      return;
    }

    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = bboxGtTissue;

    // Get polygon points if available (live Annotorious — popup props can be stale).
    let polygonRawPoints = getPolygonPointsFromAnnotation(liveGtTissue);

    try {
      const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/save_annotation/batch`;
      const payload: any = {
        path: getDefaultOutputPath(formattedPath),
        annotation_type: 'tissue',
        x1: bboxX1,
        y1: bboxY1,
        x2: bboxX2,
        y2: bboxY2,
        annotator: annotatorLabelRef.current,
      };

      if (polygonRawPoints) {
        payload.polygon_points = polygonRawPoints;
      }

      if (!instanceIdProp) {
        console.warn('[SelectionContent] Missing instanceIdProp; aborting request.');
        return;
      }

      const response = await segFetch(instanceIdProp, url, {method: 'POST',
        body: JSON.stringify(payload),
        returnAxiosFormat: true});

      const markedCount = response?.data?.data?.marked_count ?? response?.data?.marked_count ?? 0;
      
      if (markedCount > 0) {
        toast.success(`Marked ${markedCount} tissue annotation(s) as ground truth`);
        
        // Refresh patches and annotations
        eventBus.emit('refresh-patches');
        eventBus.emit('refresh-annotations');
        eventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
        refreshGtHighlightIndices(currentPath);
        
        // Refresh patch counts from server
        await refreshPatchCountsFromServer();
      } else {
        toast('No AI-predicted tissue annotations found in this region to mark as ground truth.');
      }

      onCancel();
    } catch (error) {
      console.error('Error marking tissue as ground truth:', error);
      if (!toastIfDenied(error, 'mark as ground truth', 'Failed to mark tissue as ground truth.')) {
        toast.error(getErrorMessage(error, 'Failed to mark tissue as ground truth.'));
      }
    }
  }, [assertWritable, toastIfDenied, currentPath, shapeCoords, annotation, formattedPath, instanceIdProp, annotatorInstance, onCancel, refreshPatchCountsFromServer, refreshGtHighlightIndices]);

  return (
    <div className="grid grid-cols-2 gap-2 h-full">
      {/* Left: Annotate nuclei as / Annotate tissue as (each class Yes / No) */}
      <div className="space-y-2 overflow-y-auto">
        <div className="space-y-0.5">
          <Label className="text-xs font-medium">Annotate nuclei as</Label>
          <div className="space-y-0.5 bg-secondary/20 p-1 rounded-md overflow-y-auto max-h-[160px]">
            {nucleiClasses.map((item, index) => (
              <div key={index} className="flex items-center gap-1.5 py-px">
                <input
                  type="color"
                  value={item.color}
                  disabled={!pathWritable}
                  onChange={(e) => dispatch(updateNucleiClass({ index, newClass: { ...item, color: e.target.value } }))}
                  title={writeBlockTitle || "Change color"}
                  className="w-3.5 h-3.5 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-40"
                />
                <span className="text-xs truncate min-w-0 flex-1">{item.name}</span>
                <div className="flex gap-0.5 shrink-0">
                  <Button variant="outline" size="sm" className="h-5 px-1 text-[11px]" onClick={() => markAllNuclei(item)} disabled={!pathWritable} title={writeBlockTitle}>Yes</Button>
                  <Button variant="outline" size="sm" className="h-5 px-1 text-[11px]" onClick={() => markNucleiExclude(item)} disabled={!pathWritable} title={writeBlockTitle}>No</Button>
                  {item.name !== 'Negative control' && (
                    <button type="button" title={writeBlockTitle || "Delete class"} disabled={!pathWritable} className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40" onClick={() => removeNucleiClass(index)}>×</button>
                  )}
                </div>
              </div>
            ))}
            {addingNuclei ? (
              <div className="flex items-center gap-1.5 py-px">
                <input type="color" value={newNucleiColor} onChange={(e) => setNewNucleiColor(e.target.value)} className="h-4 w-4 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" title="Class color" />
                <input
                  autoFocus
                  value={newNucleiName}
                  onChange={(e) => setNewNucleiName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } else if (e.key === 'Escape') { setAddingNuclei(false); } }}
                  onBlur={commitNucleiClass}
                  placeholder="Class name…"
                  className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
                />
              </div>
            ) : (
              <button type="button" onClick={startAddNuclei} disabled={!pathWritable} title={writeBlockTitle} className="flex w-full items-center gap-1 px-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40">
                <span className="text-sm leading-none">+</span> Add class
              </button>
            )}
          </div>
        </div>
        {reduxPatchClassificationData && (
          <div className="space-y-0.5">
            <Label className="text-xs font-medium">Annotate patch as</Label>
            <div className="space-y-0.5 bg-secondary/20 p-1 rounded-md overflow-y-auto max-h-[160px]">
              {reduxPatchClassificationData.class_name.map((name, index) => (
                <div key={index} className="flex items-center gap-1.5 py-px">
                  <input
                    type="color"
                    value={reduxPatchClassificationData.class_hex_color[index] || '#FFFF00'}
                    onChange={(e) => {
                      if (!pathWritable) return;
                      const color = e.target.value;
                      const data = reduxPatchClassificationData;
                      // Update the class color definition…
                      dispatch(setPatchClassificationData({
                        ...data,
                        class_hex_color: data.class_hex_color.map((c: string, i: number) => (i === index ? color : c)),
                      } as any));
                      // …and recolor patches already annotated as this class on the overlay.
                      const classId = data.class_id[index];
                      const ids = currentPatches
                        .filter((p) => (p.length > 6 ? p[6] : -1) === classId)
                        .map((p) => p[0]);
                      if (ids.length) recolorPatchOverlay({ ids, color, persistOverride: true });
                    }}
                    title={writeBlockTitle || "Change color"}
                    disabled={!pathWritable}
                    className="w-3.5 h-3.5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0 disabled:cursor-not-allowed disabled:opacity-40"
                  />
                  <span className="text-xs truncate min-w-0 flex-1">{name}</span>
                  <div className="flex gap-0.5 shrink-0">
                    <Button variant="outline" size="sm" className="h-5 px-1 text-[11px]" onClick={() => markTissue(index)} disabled={!pathWritable} title={writeBlockTitle}>Yes</Button>
                    <Button variant="outline" size="sm" className="h-5 px-1 text-[11px]" onClick={() => markTissueExclude(index)} disabled={!pathWritable} title={writeBlockTitle}>No</Button>
                    {name.toLowerCase() !== 'negative control' && (
                      <button type="button" title={writeBlockTitle || "Delete class"} disabled={!pathWritable} className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40" onClick={() => removeTissueClass(index)}>×</button>
                    )}
                  </div>
                </div>
              ))}
              {addingTissue ? (
                <div className="flex items-center gap-1.5 py-px">
                  <input type="color" value={newTissueColor} onChange={(e) => setNewTissueColor(e.target.value)} className="h-4 w-4 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" title="Class color" />
                  <input
                    autoFocus
                    value={newTissueName}
                    onChange={(e) => setNewTissueName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } else if (e.key === 'Escape') { setAddingTissue(false); } }}
                    onBlur={commitTissueClass}
                    placeholder="Class name…"
                    className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
                  />
                </div>
              ) : (
                <button type="button" onClick={startAddTissue} disabled={!pathWritable} title={writeBlockTitle} className="flex w-full items-center gap-1 px-1 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40">
                  <span className="text-sm leading-none">+</span> Add class
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Right: Clear region, Mark region */}
      <div className="space-y-2 overflow-y-auto max-h-[280px] pr-1">
        <div className="space-y-0.5">
          <Label className="text-xs font-medium">Clear this region</Label>
          <div className="space-y-0.5 bg-secondary/20 p-1 rounded-md">
            <Button variant="outline" size="sm" className="h-7 w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10 text-xs" onClick={() => clearNucleiAnnotations()} disabled={!pathWritable} title={writeBlockTitle}>
              All nuclei annotations
            </Button>
            {reduxPatchClassificationData && (
              <Button variant="outline" size="sm" className="h-7 w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10 text-xs" onClick={() => clearTissueAnnotations()} disabled={!pathWritable} title={writeBlockTitle}>
                All tissue annotations
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-0.5">
          <Label className="text-xs font-medium">Mark this region as ground truth</Label>
          <div className="space-y-0.5 bg-secondary/20 p-1 rounded-md">
            <Button variant="outline" size="sm" className="h-7 w-full justify-start text-primary hover:text-primary hover:bg-primary/10 text-xs" onClick={() => markNucleiAsGroundTruth()} disabled={!pathWritable} title={writeBlockTitle}>
              All nuclei predictions
            </Button>
            {reduxPatchClassificationData && (
              <Button variant="outline" size="sm" className="h-7 w-full justify-start text-primary hover:text-primary hover:bg-primary/10 text-xs" onClick={() => markTissueAsGroundTruth()} disabled={!pathWritable} title={writeBlockTitle}>
                All tissue predictions
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Footer buttons component for SelectionContent
export function SelectionContentFooter({
  selectedColor,
  onSave,
  onDelete,
  annotatorInstance,
  shapeCoords
}: {
  selectedColor: string
  onSave: () => void
  onDelete: () => void
  annotatorInstance: any
  shapeCoords: { x1: number; y1: number; x2: number; y2: number } | null
}) {
  const currentPath = useActiveSlidePath();
  const { allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(currentPath);
  const handleSave = () => {
    if (selectedColor) {
      onSave();
    }
  };

  const handleSavePngFromRectangle = async () => {
    await savePNGFromCurrentSelection(annotatorInstance?.viewer, shapeCoords, {
      backgroundColor: '#ffffff',
      quality: 0.95,
      filenameSuffix: 'annotation',
    });
  };

  return (
    <div className="px-3 py-1 flex justify-between items-center">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={handleSavePngFromRectangle}
        >
          Save PNG
        </Button>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onDelete}>
          Delete
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!pathWritable || !selectedColor}
          title={writeBlockTitle || "Save this drawing as a manual annotation"}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
