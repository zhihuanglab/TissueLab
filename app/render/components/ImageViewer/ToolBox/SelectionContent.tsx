"use client"

import { useCallback, useState, useEffect } from "react"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { ImageAnnotation } from "@annotorious/react"
import { useDispatch, useSelector } from "react-redux"
import { AppDispatch, RootState } from "@/store"
import { apiFetch } from '@/utils/common/apiFetch'
import { getErrorMessage } from "@/utils/common/apiResponse"
import { toast } from "sonner"
import {
  selectPatchClassificationData,
  setPatchClassificationData,
  updatePatchOverlayColors,
  clearPatchOverridesForIds,
  selectPatchOverlays,
} from "@/store/slices/viewer/annotationSlice"
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config"
import { formatPath } from "@/utils/pathUtils"
import EventBus from "@/utils/EventBus"
import { isPublicReadOnlyPath, getRestrictedDirectoryMessage } from "@/utils/sampleDirectoryUtils"
import { getDefaultOutputPath } from "@/utils/workflowUtils"
import { selectSelectedModelForPath } from "@/store/slices/chat/modelSelectionSlice"
import { annotationTypeStore } from "@/store/zustand/slice/annotationTypesStore"
import { savePNGFromCurrentSelection } from "@/utils/snapshot.util"
import { useRefreshGtHighlightIndices } from "@/hooks/viewer/useRefreshGtHighlightIndices"

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
  onSave: (color: string, customText?: string) => void
  shapeCoords: { x1: number; y1: number; x2: number; y2: number } | null
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
  onSave,
  shapeCoords
}: SelectionContentProps) {
  const dispatch = useDispatch<AppDispatch>();
  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses);
  const reduxPatchClassificationData = useSelector(selectPatchClassificationData);
  const currentPatches = useSelector(selectPatchOverlays);
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const currentOrgan = useSelector((state: RootState) => state.workflow.currentOrgan);
  const updateAfterEveryAnnotation = useSelector((state: RootState) => state.workflow.updateAfterEveryAnnotation);
  const updatePatchAfterEveryAnnotation = useSelector((state: RootState) => state.workflow.updatePatchAfterEveryAnnotation);
  const patchClassifierPath = useSelector((state: RootState) => state.workflow.patchClassifierPath);
  const patchClassifierSavePath = useSelector((state: RootState) => state.workflow.patchClassifierSavePath);
  const selectedFolder = useSelector((state: RootState) => state.fileManager.selectedFolder);
  // Local Electron-only build: cloud file source no longer exists.
  const isWebMode = false;
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

  const [formattedPath, setFormattedPath] = useState(formatPath(currentPath ?? ""));
  const refreshGtHighlightIndices = useRefreshGtHighlightIndices();

  useEffect(() => {
    setFormattedPath(formatPath(currentPath ?? ""));
  }, [currentPath]);

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
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/patch_classification`, {
        method: 'GET',
        returnAxiosFormat: true,
      });
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
      console.error('Failed to refresh patch classification data:', error);
    }
  }, [dispatch, reduxPatchClassificationData]);

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
    if (isPublicReadOnlyPath(currentPath ?? undefined)) {
      toast.error(getRestrictedDirectoryMessage('annotate'));
      onCancel();
      return;
    }

    if (!shapeCoords) {
      console.error("Shape coordinates (Raw BBox) not found in Redux state. Cannot mark nuclei.");
      return;
    }
    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = shapeCoords;

    // 2. Check if the original annotation is a Polygon and get its RAW points
    let polygonRawPoints: number[][] | null = null;
    let selectorType = annotation.target.selector?.type; // Store type for logging/debugging

    if (selectorType === 'POLYGON') {
      // Use type assertion for potentially dynamic geometry structure
      const geometry = annotation.target.selector.geometry as any;
      if (geometry && Array.isArray(geometry.points) && geometry.points.length > 0) {
        polygonRawPoints = geometry.points;
      }
    }

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
      const response = await apiFetch(urlWithParams, {
        method: 'GET',
        returnAxiosFormat: true,
      });
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

      if (annotation && annotatorInstance) {
        const newRectangleBodies = annotation.bodies.filter((b) => b.purpose !== 'style');
        newRectangleBodies.push({
          id: String(Date.now()) + '-rectstyle',
          annotation: annotation.id,
          type: 'TextualBody',
          purpose: 'style',
          value: item.color,
          created: new Date(),
          creator: { id: 'default' },
        });

        const updatedRectangleAnnotation = {
          ...annotation,
          bodies: newRectangleBodies,
        };
        annotatorInstance.updateAnnotation(updatedRectangleAnnotation);

        if (annotatorInstance.viewer) {
          annotatorInstance.setSelected(null);
          annotatorInstance.setSelected(updatedRectangleAnnotation.id);
          annotatorInstance.viewer.forceRedraw();
        }
      }

      onCancel();

      const savePayload: any = {
        path: getDefaultOutputPath(formattedPath),
        wf_id: 1,
        region_geometry: { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 },
        matching_indices,
        classification: item.name,
        color: item.color,
        method: `${selectorType || selectedTool || 'unknown'} selection`.toLowerCase(),
        annotator: 'Unknown',
        ui_nuclei_classes: nucleiClasses.map((cls) => cls.name),
        ui_nuclei_colors: nucleiClasses.map((cls) => cls.color),
        ui_organ: currentOrgan,
      };
      if (polygonRawPoints) savePayload.polygon_vertices = polygonRawPoints;

      const headers: any = {};
      if (!instanceIdProp) {
        console.warn('[SelectionContent] Missing instanceIdProp; aborting save_annotation to avoid mismatched session.');
        return;
      }
      headers['X-Instance-ID'] = instanceIdProp;

      void apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_annotation`, {
        method: 'POST',
        body: JSON.stringify(savePayload),
        headers,
        returnAxiosFormat: true,
      })
        .then(() => {
          try {
            EventBus.emit('refresh-annotations');
          } catch {}
          try {
            EventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
          } catch {}
          refreshGtHighlightIndices();

          if (updateAfterEveryAnnotation && currentPath && nucleiClasses.length > 0) {
            const zarrPath = getDefaultOutputPath(formattedPath);
            EventBus.emit('trigger-nuclei-update', { zarrPath, source: 'auto-selection-mark' });
          }
        })
        .catch((err) => {
          console.error('POST /save_annotation error or workflow trigger error:', err);
          rollback();
          
          // Check if error is related to samples directory restriction
          const errorMessage = getErrorMessage(err, '');
          if (errorMessage.includes('sample directories') || errorMessage.includes('Cannot annotate in sample directories')) {
            toast.error(getRestrictedDirectoryMessage('annotate nuclei'));
          } else {
            toast.error(getErrorMessage(err, 'Failed to save nuclei annotations. Reverted to previous state.'));
          }
          
          EventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
        });
    } catch (error) {
      console.error('Error during markAllNuclei API call or processing:', error);
      
      // Check if error is related to samples directory restriction
      const errorMessage = getErrorMessage(error, '');
      if (errorMessage.includes('sample directories') || errorMessage.includes('Cannot annotate in sample directories')) {
        toast.error(getRestrictedDirectoryMessage('annotate nuclei'));
      } else {
        toast.error(getErrorMessage(error, 'Unable to mark nuclei for this region.'));
      }
    }
  }, [
    currentPath,
    shapeCoords,
    annotation,
    nucleiClasses,
    applyOptimisticAnnotationTypes,
    annotatorInstance,
    onCancel,
    formattedPath,
    selectedTool,
    currentOrgan,
    instanceIdProp,
    updateAfterEveryAnnotation,
    dispatch,
    refreshGtHighlightIndices,
  ]);

  /** Mark region as "NOT this class" (negative selection): same as tissue, exclude_classes=[className] */
  const markNucleiExclude = useCallback(async (item: { name: string }) => {
    if (isPublicReadOnlyPath(currentPath ?? undefined)) {
      toast.error(getRestrictedDirectoryMessage('annotate'));
      onCancel();
      return;
    }
    if (!shapeCoords) {
      console.error("Shape coordinates (Raw BBox) not found in Redux state. Cannot mark nuclei exclude.");
      return;
    }
    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = shapeCoords;
    let polygonRawPoints: number[][] | null = null;
    const selectorType = annotation.target.selector?.type;
    if (selectorType === 'POLYGON') {
      const geometry = annotation.target.selector.geometry as any;
      if (geometry?.points?.length) polygonRawPoints = geometry.points;
    }
    const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/query`;
    const apiParams: any = {
      x1: bboxX1, x2: bboxX2, y1: bboxY1, y2: bboxY2,
      file_path: formattedPath,
    };
    if (polygonRawPoints) apiParams.polygon_points = JSON.stringify(polygonRawPoints);
    try {
      const urlWithParams = `${url}?${new URLSearchParams(apiParams as Record<string, string>).toString()}`;
      const response = await apiFetch(urlWithParams, { method: 'GET', returnAxiosFormat: true });
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
      onCancel();
      const savePayload: any = {
        path: getDefaultOutputPath(formattedPath),
        region_geometry: { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 },
        matching_indices,
        classification: null,
        exclude_classes: [item.name],
        color: '#aaaaaa',
        method: 'negative selection',
        annotator: 'Unknown',
        ui_nuclei_classes: nucleiClasses.map((c) => c.name),
        ui_nuclei_colors: nucleiClasses.map((c) => c.color),
        ui_organ: currentOrgan,
      };
      const headers: any = {};
      if (instanceIdProp) headers['X-Instance-ID'] = instanceIdProp;
      void apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_annotation`, {
        method: 'POST',
        body: JSON.stringify(savePayload),
        headers,
        returnAxiosFormat: true,
      })
        .then(() => {
          EventBus.emit('refresh-annotations');
          EventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
          toast.success(`Marked region as not "${item.name}"`);
          refreshGtHighlightIndices();

          if (updateAfterEveryAnnotation && currentPath && nucleiClasses.length > 0) {
            const zarrPath = getDefaultOutputPath(formattedPath);
            EventBus.emit('trigger-nuclei-update', { zarrPath, source: 'auto-selection-exclude' });
          }
        })
        .catch((err) => {
          console.error('POST save_annotation (exclude) error:', err);
          const msg = getErrorMessage(err, '');
          if (msg.includes('sample directories')) toast.error(getRestrictedDirectoryMessage('annotate nuclei'));
          else toast.error(getErrorMessage(err, 'Failed to save nuclei exclusion.'));
          EventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
        });
    } catch (e) {
      console.error('markNucleiExclude error:', e);
      toast.error(getErrorMessage(e, 'Unable to mark nuclei exclude for this region.'));
    }
  }, [
    currentPath,
    shapeCoords,
    annotation,
    nucleiClasses,
    formattedPath,
    currentOrgan,
    instanceIdProp,
    onCancel,
    updateAfterEveryAnnotation,
    dispatch,
    refreshGtHighlightIndices,
  ]);

  const markTissue = useCallback(async (classId: number) => {
    // Check if in samples directory first
    if (isPublicReadOnlyPath(currentPath ?? undefined)) {
      toast.error(getRestrictedDirectoryMessage('annotate tissue'));
      onCancel();
      return;
    }

    if (!shapeCoords) {
      console.error('[MarkTissue] Shape coordinates (Raw BBox) not found in Redux state.');
      toast.error('Unable to mark tissue: Missing region coordinates.');
      return;
    }
    const { x1: rawBBoxX1, y1: rawBBoxY1, x2: rawBBoxX2, y2: rawBBoxY2 } = shapeCoords;

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
    const selector = annotation.target.selector;
    const selectorType = selector?.type;

    if (selectorType === 'POLYGON') {
      const geometry = selector.geometry as any;
      if (geometry && Array.isArray(geometry.points) && geometry.points.length > 0) {
        polygonRawPoints = geometry.points;
        console.log('[MarkTissue] Detected Polygon, raw points obtained:', polygonRawPoints);
      } else {
        console.warn('[MarkTissue] Polygon selector detected, but raw points are missing or invalid.', geometry);
      }
    } else {
      console.log('[MarkTissue] Detected Rectangle or other shape type.');
    }

    const saveUrl = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_tissue`;

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
      annotator: "Unknown"
    };

    if (polygonRawPoints) {
      payload.polygon_points = polygonRawPoints;
      console.log('[MarkTissue] Adding polygon_points to save_tissue payload:', payload.polygon_points);
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
      dispatch(updatePatchOverlayColors({ ids: optimisticIds, color: colorHex, persistOverride: false }));
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
        dispatch(updatePatchOverlayColors({ ids, color, persistOverride: false }));
      });
    };

    onCancel();

    const zarrPath = getDefaultOutputPath(formattedPath);

    // Direct API call (same as cell annotation) - no queue
    void apiFetch(saveUrl, {
      method: 'POST',
      body: JSON.stringify(payload),
      returnAxiosFormat: true,
    })
      .then((response) => {
        try {
          // Update UI immediately (synchronous)
          const matchingIndices: number[] = response?.data?.data?.matching_indices ?? response?.data?.matching_indices ?? [];
          if (matchingIndices.length > 0) {
            const normalizedIds = matchingIndices.map((idx) => Number(idx));
            dispatch(updatePatchOverlayColors({ ids: normalizedIds, color: colorHex, persistOverride: false }));
            if (optimisticIds.length) {
              const backendIdSet = new Set(normalizedIds);
              revertGroups.forEach(({ color, ids }) => {
                const missing = ids.filter((id) => !backendIdSet.has(id));
                if (missing.length) {
                  dispatch(updatePatchOverlayColors({ ids: missing, color, persistOverride: false }));
                }
              });
            }
            EventBus.emit('refresh-patches');
          } else if (optimisticIds.length) {
            revertOptimisticUpdates();
          }

          // Fire-and-forget: Don't block on query operations
          // Refresh operations are async and don't need to wait
          EventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
          refreshGtHighlightIndices();

          // Route patch auto-update through the panel's manual update handler
          // so payload semantics (including class_operations) stay identical.
          if (updatePatchAfterEveryAnnotation && currentPath && reduxPatchClassificationData) {
            EventBus.emit('trigger-patch-update', { zarrPath, source: 'auto-selection-mark' });
          }

          // Refresh counts asynchronously - don't block
          refreshPatchCountsFromServer().catch(err => console.error('[SelectionContent] Refresh counts error:', err));
        } catch (err) {
          console.error('[MarkTissue] Error processing response:', err);
        }
      })
      .catch((err) => {
        console.error('POST /save_tissue error:', err);
        revertOptimisticUpdates();
        
        // Check for specific error types and provide user-friendly messages
        const errorMessage = getErrorMessage(err, '');
        
        if (errorMessage.includes('sample directories') || errorMessage.includes('Cannot annotate in sample directories')) {
          toast.error(getRestrictedDirectoryMessage('annotate tissue'));
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
        
        EventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
      });
  }, [
    currentPath,
    shapeCoords,
    reduxPatchClassificationData,
    annotation,
    formattedPath,
    currentPatches,
    isPointInsidePolygon,
    dispatch,
    onCancel,
    updatePatchAfterEveryAnnotation,
    refreshPatchCountsFromServer,
    refreshGtHighlightIndices,
  ]);

  /** Mark region as "NOT this class" (negative selection): tissue_class=null, exclude_classes=[className] */
  const markTissueExclude = useCallback(async (classId: number) => {
    if (isPublicReadOnlyPath(currentPath ?? undefined)) {
      toast.error(getRestrictedDirectoryMessage('annotate tissue'));
      onCancel();
      return;
    }
    if (!shapeCoords) {
      toast.error('Unable to mark tissue: Missing region coordinates.');
      return;
    }
    if (!reduxPatchClassificationData || classId < 0 || classId >= reduxPatchClassificationData.class_name.length) {
      toast.error('Invalid patch classification selection.');
      return;
    }
    const { x1: rawBBoxX1, y1: rawBBoxY1, x2: rawBBoxX2, y2: rawBBoxY2 } = shapeCoords;
    const className = reduxPatchClassificationData.class_name[classId];
    let polygonRawPoints: number[][] | null = null;
    const selector = annotation.target.selector;
    const selectorType = selector?.type;
    if (selectorType === 'POLYGON') {
      const geometry = selector.geometry as any;
      if (geometry?.points?.length) polygonRawPoints = geometry.points;
    }
    const saveUrl = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_tissue`;
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
      annotator: 'Unknown'
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
        dispatch(updatePatchOverlayColors({ ids, color, persistOverride: false }));
      });
    };
    if (optimisticIds.length) {
      dispatch(updatePatchOverlayColors({ ids: optimisticIds, color: '#aaaaaa', persistOverride: false }));
    }
    onCancel();
    const zarrPath = getDefaultOutputPath(formattedPath);
    void apiFetch(saveUrl, { method: 'POST', body: JSON.stringify(payload), returnAxiosFormat: true })
      .then((response) => {
        const matchingIndices: number[] = response?.data?.data?.matching_indices ?? response?.data?.matching_indices ?? [];
        if (matchingIndices.length > 0) {
          const normalizedIds = matchingIndices.map((i: number) => Number(i));
          dispatch(clearPatchOverridesForIds(normalizedIds));
          if (optimisticIds.length) {
            const backendIdSet = new Set(normalizedIds);
            revertGroups.forEach(({ color, ids }) => {
              const missing = ids.filter((id) => !backendIdSet.has(id));
              if (missing.length) dispatch(updatePatchOverlayColors({ ids: missing, color, persistOverride: false }));
            });
          }
          EventBus.emit('refresh-patches');
        } else if (optimisticIds.length) revertOptimisticUpdates();
        EventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
        if (updatePatchAfterEveryAnnotation && currentPath && reduxPatchClassificationData) {
          EventBus.emit('trigger-patch-update', { zarrPath, source: 'auto-selection-exclude' });
        }
        refreshPatchCountsFromServer().catch(() => {});
        refreshGtHighlightIndices();
      })
      .catch((err) => {
        console.error('POST /save_tissue (exclude) error:', err);
        revertOptimisticUpdates();
        const msg = getErrorMessage(err, '');
        if (msg.includes('sample directories')) toast.error(getRestrictedDirectoryMessage('annotate tissue'));
        else toast.error(getErrorMessage(err, 'Failed to save tissue exclusion.'));
        EventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
      });
  }, [
    currentPath,
    shapeCoords,
    reduxPatchClassificationData,
    annotation,
    formattedPath,
    currentPatches,
    isPointInsidePolygon,
    dispatch,
    onCancel,
    updatePatchAfterEveryAnnotation,
    refreshPatchCountsFromServer,
    refreshGtHighlightIndices,
  ]);

  const clearNucleiAnnotations = useCallback(async () => {
    // Check if in samples directory
    if (isPublicReadOnlyPath(currentPath ?? undefined)) {
      toast.error(getRestrictedDirectoryMessage('clear annotations'));
      onCancel();
      return;
    }

    if (!shapeCoords) {
      console.error("Shape coordinates not found. Cannot clear nuclei annotations.");
      toast.error('Unable to clear annotations: Missing region coordinates.');
      return;
    }

    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = shapeCoords;

    // Get polygon points if available
    let polygonRawPoints: number[][] | null = null;
    const selectorType = annotation.target.selector?.type;

    if (selectorType === 'POLYGON') {
      const geometry = annotation.target.selector.geometry as any;
      if (geometry && Array.isArray(geometry.points) && geometry.points.length > 0) {
        polygonRawPoints = geometry.points;
      }
    }

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

      const headers: any = {};
      if (instanceIdProp) {
        headers['X-Instance-ID'] = instanceIdProp;
      }

      const response = await apiFetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers,
        returnAxiosFormat: true,
      });

      const clearedCount = response?.data?.data?.cleared_count ?? response?.data?.cleared_count ?? 0;
      
      if (clearedCount > 0) {
        toast.success(`Cleared ${clearedCount} nuclei annotation(s)`);
        
        // Refresh annotations
        EventBus.emit('refresh-annotations');
        EventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
        refreshGtHighlightIndices();
      } else {
        toast('No nuclei annotations found in this region.');
      }

      onCancel();
    } catch (error) {
      console.error('Error clearing nuclei annotations:', error);
      const errorMessage = getErrorMessage(error, '');
      if (errorMessage.includes('sample directories')) {
        toast.error(getRestrictedDirectoryMessage('clear annotations'));
      } else {
        toast.error(getErrorMessage(error, 'Failed to clear nuclei annotations.'));
      }
    }
  }, [
    currentPath,
    shapeCoords,
    annotation,
    formattedPath,
    instanceIdProp,
    onCancel,
    refreshGtHighlightIndices,
  ]);

  const clearTissueAnnotations = useCallback(async () => {
    // Check if in samples directory
    if (isPublicReadOnlyPath(currentPath ?? undefined)) {
      toast.error(getRestrictedDirectoryMessage('clear annotations'));
      onCancel();
      return;
    }

    if (!shapeCoords) {
      console.error("Shape coordinates not found. Cannot clear tissue annotations.");
      toast.error('Unable to clear annotations: Missing region coordinates.');
      return;
    }

    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = shapeCoords;

    // Get polygon points if available
    let polygonRawPoints: number[][] | null = null;
    const selectorType = annotation.target.selector?.type;

    if (selectorType === 'POLYGON') {
      const geometry = annotation.target.selector.geometry as any;
      if (geometry && Array.isArray(geometry.points) && geometry.points.length > 0) {
        polygonRawPoints = geometry.points;
      }
    }

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

      const headers: any = {};
      if (instanceIdProp) {
        headers['X-Instance-ID'] = instanceIdProp;
      }

      const response = await apiFetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers,
        returnAxiosFormat: true,
      });

      const clearedCount = response?.data?.data?.cleared_count ?? response?.data?.cleared_count ?? 0;
      
      if (clearedCount > 0) {
        toast.success(`Cleared ${clearedCount} tissue annotation(s)`);
        
        // Refresh patches and annotations
        EventBus.emit('refresh-patches');
        EventBus.emit('refresh-annotations');
        EventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
        refreshGtHighlightIndices();
        
        // Refresh patch counts from server
        await refreshPatchCountsFromServer();
      } else {
        toast('No tissue annotations found in this region.');
      }

      onCancel();
    } catch (error) {
      console.error('Error clearing tissue annotations:', error);
      const errorMessage = getErrorMessage(error, '');
      if (errorMessage.includes('sample directories')) {
        toast.error(getRestrictedDirectoryMessage('clear annotations'));
      } else {
        toast.error(getErrorMessage(error, 'Failed to clear tissue annotations.'));
      }
    }
  }, [
    currentPath,
    shapeCoords,
    annotation,
    formattedPath,
    instanceIdProp,
    onCancel,
    refreshPatchCountsFromServer,
    refreshGtHighlightIndices,
  ]);

  const markNucleiAsGroundTruth = useCallback(async () => {
    // Check if in samples directory
    if (isPublicReadOnlyPath(currentPath ?? undefined)) {
      toast.error(getRestrictedDirectoryMessage('mark as ground truth'));
      onCancel();
      return;
    }

    if (!shapeCoords) {
      console.error("Shape coordinates not found. Cannot mark nuclei as ground truth.");
      toast.error('Unable to mark as ground truth: Missing region coordinates.');
      return;
    }

    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = shapeCoords;

    // Get polygon points if available
    let polygonRawPoints: number[][] | null = null;
    const selectorType = annotation.target.selector?.type;

    if (selectorType === 'POLYGON') {
      const geometry = annotation.target.selector.geometry as any;
      if (geometry && Array.isArray(geometry.points) && geometry.points.length > 0) {
        polygonRawPoints = geometry.points;
      }
    }

    try {
      const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/save_annotation/batch`;
      const payload: any = {
        path: getDefaultOutputPath(formattedPath),
        annotation_type: 'nuclei',
        x1: bboxX1,
        y1: bboxY1,
        x2: bboxX2,
        y2: bboxY2,
      };

      if (polygonRawPoints) {
        payload.polygon_points = polygonRawPoints;
      }

      const headers: any = {};
      if (instanceIdProp) {
        headers['X-Instance-ID'] = instanceIdProp;
      }

      const response = await apiFetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers,
        returnAxiosFormat: true,
      });

      const markedCount = response?.data?.data?.marked_count ?? response?.data?.marked_count ?? 0;
      
      if (markedCount > 0) {
        toast.success(`Marked ${markedCount} nuclei annotation(s) as ground truth`);
        
        // Refresh annotations
        EventBus.emit('refresh-annotations');
        EventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
        refreshGtHighlightIndices();
      } else {
        toast('No AI-predicted nuclei annotations found in this region to mark as ground truth.');
      }

      onCancel();
    } catch (error) {
      console.error('Error marking nuclei as ground truth:', error);
      const errorMessage = getErrorMessage(error, '');
      if (errorMessage.includes('sample directories')) {
        toast.error(getRestrictedDirectoryMessage('mark as ground truth'));
      } else {
        toast.error(getErrorMessage(error, 'Failed to mark nuclei as ground truth.'));
      }
    }
  }, [
    currentPath,
    shapeCoords,
    annotation,
    formattedPath,
    instanceIdProp,
    onCancel,
    refreshGtHighlightIndices,
  ]);

  const markTissueAsGroundTruth = useCallback(async () => {
    // Check if in samples directory
    if (isPublicReadOnlyPath(currentPath ?? undefined)) {
      toast.error(getRestrictedDirectoryMessage('mark as ground truth'));
      onCancel();
      return;
    }

    if (!shapeCoords) {
      console.error("Shape coordinates not found. Cannot mark tissue as ground truth.");
      toast.error('Unable to mark as ground truth: Missing region coordinates.');
      return;
    }

    const { x1: bboxX1, y1: bboxY1, x2: bboxX2, y2: bboxY2 } = shapeCoords;

    // Get polygon points if available
    let polygonRawPoints: number[][] | null = null;
    const selectorType = annotation.target.selector?.type;

    if (selectorType === 'POLYGON') {
      const geometry = annotation.target.selector.geometry as any;
      if (geometry && Array.isArray(geometry.points) && geometry.points.length > 0) {
        polygonRawPoints = geometry.points;
      }
    }

    try {
      const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/save_annotation/batch`;
      const payload: any = {
        path: getDefaultOutputPath(formattedPath),
        annotation_type: 'tissue',
        x1: bboxX1,
        y1: bboxY1,
        x2: bboxX2,
        y2: bboxY2,
      };

      if (polygonRawPoints) {
        payload.polygon_points = polygonRawPoints;
      }

      const headers: any = {};
      if (instanceIdProp) {
        headers['X-Instance-ID'] = instanceIdProp;
      }

      const response = await apiFetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers,
        returnAxiosFormat: true,
      });

      const markedCount = response?.data?.data?.marked_count ?? response?.data?.marked_count ?? 0;
      
      if (markedCount > 0) {
        toast.success(`Marked ${markedCount} tissue annotation(s) as ground truth`);
        
        // Refresh patches and annotations
        EventBus.emit('refresh-patches');
        EventBus.emit('refresh-annotations');
        EventBus.emit('refresh-websocket-path', { path: formattedPath, forceReload: true });
        refreshGtHighlightIndices();
        
        // Refresh patch counts from server
        await refreshPatchCountsFromServer();
      } else {
        toast('No AI-predicted tissue annotations found in this region to mark as ground truth.');
      }

      onCancel();
    } catch (error) {
      console.error('Error marking tissue as ground truth:', error);
      const errorMessage = getErrorMessage(error, '');
      if (errorMessage.includes('sample directories')) {
        toast.error(getRestrictedDirectoryMessage('mark as ground truth'));
      } else {
        toast.error(getErrorMessage(error, 'Failed to mark tissue as ground truth.'));
      }
    }
  }, [
    currentPath,
    shapeCoords,
    annotation,
    formattedPath,
    instanceIdProp,
    onCancel,
    refreshPatchCountsFromServer,
    refreshGtHighlightIndices,
  ]);

  return (
    <div className="grid grid-cols-2 gap-2 h-full">
      {/* Left: Annotate nuclei as / Annotate tissue as (each class Yes / No) */}
      <div className="space-y-2 overflow-y-auto">
        <div className="space-y-0.5">
          <Label className="text-xs font-medium">Annotate nuclei as</Label>
          <div className="space-y-0.5 bg-secondary/20 p-1 rounded-md overflow-y-auto max-h-[160px]">
            {nucleiClasses.map((item, index) => (
              <div key={index} className="flex items-center gap-1.5 py-px">
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                <span className="text-xs truncate min-w-0 flex-1">{item.name}</span>
                <div className="flex gap-0.5 shrink-0">
                  <Button variant="outline" size="sm" className="h-5 px-1 text-[11px]" onClick={() => markAllNuclei(item)}>Yes</Button>
                  <Button variant="outline" size="sm" className="h-5 px-1 text-[11px]" onClick={() => markNucleiExclude(item)}>No</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
        {reduxPatchClassificationData && (
          <div className="space-y-0.5">
            <Label className="text-xs font-medium">Annotate tissue as</Label>
            <div className="space-y-0.5 bg-secondary/20 p-1 rounded-md overflow-y-auto max-h-[160px]">
              {reduxPatchClassificationData.class_name.map((name, index) => (
                <div key={index} className="flex items-center gap-1.5 py-px">
                  <div className="w-2.5 h-2.5 rounded shrink-0" style={{ backgroundColor: reduxPatchClassificationData.class_hex_color[index] || '#FFFF00' }} />
                  <span className="text-xs truncate min-w-0 flex-1">{name}</span>
                  <div className="flex gap-0.5 shrink-0">
                    <Button variant="outline" size="sm" className="h-5 px-1 text-[11px]" onClick={() => markTissue(index)}>Yes</Button>
                    <Button variant="outline" size="sm" className="h-5 px-1 text-[11px]" onClick={() => markTissueExclude(index)}>No</Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right: Clear region, Mark region */}
      <div className="space-y-2 overflow-y-auto max-h-[280px] pr-1">
        <div className="space-y-0.5">
          <Label className="text-xs font-medium">Clear this region</Label>
          <div className="space-y-0.5 bg-secondary/20 p-1 rounded-md">
            <Button variant="outline" size="sm" className="h-7 w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10 text-xs" onClick={() => clearNucleiAnnotations()}>
              All nuclei annotations
            </Button>
            {reduxPatchClassificationData && (
              <Button variant="outline" size="sm" className="h-7 w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10 text-xs" onClick={() => clearTissueAnnotations()}>
                All tissue annotations
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-0.5">
          <Label className="text-xs font-medium">Mark this region as ground truth</Label>
          <div className="space-y-0.5 bg-secondary/20 p-1 rounded-md">
            <Button variant="outline" size="sm" className="h-7 w-full justify-start text-primary hover:text-primary hover:bg-primary/10 text-xs" onClick={() => markNucleiAsGroundTruth()}>
              All nuclei predictions
            </Button>
            {reduxPatchClassificationData && (
              <Button variant="outline" size="sm" className="h-7 w-full justify-start text-primary hover:text-primary hover:bg-primary/10 text-xs" onClick={() => markTissueAsGroundTruth()}>
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
  customText,
  onSave,
  onCancel,
  annotatorInstance,
  shapeCoords
}: {
  selectedColor: string
  customText: string
  onSave: (color: string, customText?: string) => void
  onCancel: () => void
  annotatorInstance: any
  shapeCoords: { x1: number; y1: number; x2: number; y2: number } | null
}) {
  const handleSave = () => {
    if (selectedColor) {
      onSave(selectedColor, customText);
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
        <Button variant="outline" size="sm" onClick={onCancel}>
          Delete
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!selectedColor}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
