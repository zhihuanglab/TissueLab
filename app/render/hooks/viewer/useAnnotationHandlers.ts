import { useCallback, useEffect, useRef } from 'react';
import { useDispatch } from 'react-redux';
import { LineGeometry } from '@annotorious/annotorious';
import { ImageAnnotation, ShapeType } from '@annotorious/react';
import { AppDispatch } from '@/store';
import { AnnotationClass } from '@/store/slices/viewer/annotationSlice';
import { CentroidsArray } from '@/components/imageViewer/CentroidsArray';
import { annotationTypeStore } from '@/store/zustand/slice/annotationTypesStore';
import { getDefaultOutputPath } from '@/utils/workflowUtils';
import { convertToAppropriateUnit } from '@/utils/viewer/viewerHelpers';
import { isPublicReadOnlyPath } from '@/utils/sampleDirectoryUtils';
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { apiFetch } from '@/utils/common/apiFetch';
import EventBus from '@/utils/EventBus';

const DOUBLE_CLICK_THRESHOLD_MS = 500; // Milliseconds
const CLICK_RADIUS_SQUARED = 350 * 350; // Using 350px radius
const SINGLE_CLICK_DELAY_MS = 300;

interface UseAnnotationHandlersParams {
  viewerInstance: any;
  annotatorInstance: any;
  centroids: CentroidsArray;
  activeManualClassificationClassRef: React.MutableRefObject<any>;
  currentSvsPath: string | null;
  currentPath: string | null;
  currentInstanceId?: string | null;
  nucleiClasses: AnnotationClass[];
  currentOrgan: string | null;
  slideInfo: { mpp?: number };
  mousePos: { x: number; y: number };
  handleToolbarClick: (tool: string) => void;
  selectedFolder: string | null;
  selectedModelForCurrentPath: string | null;
  updateClassifier: boolean;
  updateAfterEveryAnnotation: boolean;
  setRulerTooltip: React.Dispatch<React.SetStateAction<{
    visible: boolean;
    text: string;
    position: { x: number; y: number };
  }>>;
  /** Called after a single-annotation save (tasks/v1/save_annotation) succeeds; e.g. refresh GT highlight indices */
  onSaveAnnotationSuccess?: () => void;
}

/**
 * Hook to handle annotation-related interactions
 * Extracted from OpenSeadragonContainer to improve code organization
 */
export const useAnnotationHandlers = (params: UseAnnotationHandlersParams) => {
  const dispatch = useDispatch<AppDispatch>();
  const {
    viewerInstance,
    annotatorInstance,
    onSaveAnnotationSuccess,
    centroids,
    activeManualClassificationClassRef,
    currentSvsPath,
    currentPath,
    currentInstanceId,
    nucleiClasses,
    currentOrgan,
    slideInfo,
    mousePos,
    handleToolbarClick,
    selectedFolder,
    selectedModelForCurrentPath,
    updateClassifier,
    updateAfterEveryAnnotation,
    setRulerTooltip,
  } = params;

  // Refs for click detection
  const lastClickTimestampRef = useRef<number>(0);
  const lastClickedAnnotationIdRef = useRef<string | null>(null);
  const singleClickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipVisibleRef = useRef(false);

  // Helper function to save annotation and trigger workflow
  const saveAnnotationAndTriggerWorkflow = useCallback(async (
    zarrPath: string,
    centroidId: number,
    originalX: number,
    originalY: number,
    newClassName: string,
    newClassColor: string,
    method: string
  ) => {
    const payload = {
      path: zarrPath,
      region_geometry: { x1: originalX, y1: originalY, x2: originalX, y2: originalY },
      matching_indices: [centroidId],
      classification: newClassName,
      color: newClassColor,
      method,
      annotator: 'Unknown',
      ui_nuclei_classes: nucleiClasses.map(cls => cls.name),
      ui_nuclei_colors: nucleiClasses.map(cls => cls.color),
      ui_organ: currentOrgan,
    };

    const headers: any = {};
    if (currentInstanceId) {
      headers['X-Instance-ID'] = currentInstanceId;
    }

    try {
      await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_annotation`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers,
        returnAxiosFormat: true,
      });
      console.log(`[Annotation Handler] Annotation saved successfully via API.`);

      // Immediately refresh counts: global totals and per-class list via WS
      EventBus.emit('refresh-annotations');
      EventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
      onSaveAnnotationSuccess?.();

      if (updateAfterEveryAnnotation && currentSvsPath && nucleiClasses.length > 0) {
        // Route auto-update through the panel's manual update handler so payload semantics
        // (including class_operations and classifier paths) stay identical.
        EventBus.emit('trigger-nuclei-update', { zarrPath, source: 'auto-annotation' });
      }

      setTimeout(() => handleToolbarClick('move'), 50);
    } catch (error) {
      console.error(`[Annotation Handler] Error saving annotation or triggering workflow via API:`, error);
    }
  }, [
    nucleiClasses,
    currentOrgan,
    currentInstanceId,
    updateAfterEveryAnnotation,
    currentSvsPath,
    dispatch,
    handleToolbarClick,
    onSaveAnnotationSuccess,
  ]);

  // Handle canvas double-click for classification
  const handleCanvasDoubleClick = useCallback(async (event: OpenSeadragon.CanvasDoubleClickEvent) => {
    // Check if in samples directory
    if (isPublicReadOnlyPath(currentSvsPath)) {
      console.log('[handleCanvasDoubleClick] Cannot annotate in samples directory');
      return;
    }

    if (!viewerInstance || !activeManualClassificationClassRef.current) {
      console.log('[handleCanvasDoubleClick] Viewer or active class not available.');
      return;
    }

    const viewer = viewerInstance;
    const activeClass = activeManualClassificationClassRef.current;

    const webPoint = event.position;
    if (!webPoint) {
      console.log('[handleCanvasDoubleClick] No webPoint from event.');
      return;
    }
    const viewportPoint = viewer.viewport.pointFromPixel(webPoint);
    const tiledImage = viewer.world.getItemAt(0);
    const imagePoint = tiledImage
      ? tiledImage.viewportToImageCoordinates(viewportPoint)
      : viewer.viewport.viewportToImageCoordinates(viewportPoint);

    let closestCentroidTuple: Int32Array | undefined = undefined;
    let minDistanceSquared = Infinity;

    // CentroidsArray only
    centroids.forEach((centroidTuple: Int32Array) => {
      const cx = centroidTuple[1]; // x
      const cy = centroidTuple[2]; // y
      const dx = imagePoint.x - cx;
      const dy = imagePoint.y - cy;
      const distSq = dx * dx + dy * dy;
      if (distSq < minDistanceSquared) {
        minDistanceSquared = distSq;
        closestCentroidTuple = centroidTuple;
      }
    });

    if (closestCentroidTuple && minDistanceSquared <= CLICK_RADIUS_SQUARED) {
      const centroidId = closestCentroidTuple[0];
      const originalX = closestCentroidTuple[1]; // This is level0_x
      const originalY = closestCentroidTuple[2]; // This is level0_y
      const newClassName = activeClass.name;
      const newClassColor = activeClass.color;

      console.log(`[handleCanvasDoubleClick] Centroid ${centroidId} double-clicked. New class: ${newClassName}`);

      annotationTypeStore.getState().setMany([{
        id: String(centroidId),
        color: newClassColor,
        category: newClassName,
      }]);

      // Force OSD redraw
      if (viewerInstance && viewerInstance.world.getItemCount() > 0) {
        try {
          viewerInstance.forceRedraw();
        } catch (error) {
          console.warn('[OSD Redraw] Failed to force redraw:', error);
        }
      }

      const zarrPath = getDefaultOutputPath(currentSvsPath);
      if (!zarrPath) {
        console.error('[handleCanvasDoubleClick] Could not get Zarr path for saving annotation.');
        return;
      }

      await saveAnnotationAndTriggerWorkflow(
        zarrPath,
        Number(centroidId),
        originalX,
        originalY,
        newClassName,
        newClassColor,
        'canvas double-click classification'
      );
    } else {
      console.log('[handleCanvasDoubleClick] No close centroid found, or double-click intended for Annotorious.');
    }
  }, [
    currentSvsPath,
    viewerInstance,
    activeManualClassificationClassRef,
    centroids,
    saveAnnotationAndTriggerWorkflow,
  ]);

  // Handle annotation click for classification (single/double click detection)
  const handleClickAnnotationForClassification = useCallback((annotation: ImageAnnotation) => {
    const currentClickTimestamp = Date.now();
    const currentAnnotationId = annotation.id;

    if (
      lastClickedAnnotationIdRef.current === currentAnnotationId &&
      (currentClickTimestamp - lastClickTimestampRef.current) < DOUBLE_CLICK_THRESHOLD_MS
    ) {
      // DOUBLE CLICK DETECTED - Cancel any pending single-click processing
      if (singleClickTimeoutRef.current) {
        clearTimeout(singleClickTimeoutRef.current);
        singleClickTimeoutRef.current = null;
      }

      console.log(`[handleClickAnnotationForClassification] Double-click on annotation ${currentAnnotationId} detected.`);

      if (!activeManualClassificationClassRef.current || !annotatorInstance || !viewerInstance) {
        console.log('[handleClickAnnotationForClassification] Double-click: Preconditions not met (active class, annotator, or viewer).');
        // Reset for next click sequence
        lastClickTimestampRef.current = 0;
        lastClickedAnnotationIdRef.current = null;
        return;
      }

      const activeClass = activeManualClassificationClassRef.current;
      const centroidId = Number(currentAnnotationId);

      if (isNaN(centroidId)) {
        console.warn('[handleClickAnnotationForClassification] Double-click: Annotation ID is not a number:', currentAnnotationId);
        lastClickTimestampRef.current = 0;
        lastClickedAnnotationIdRef.current = null;
        return;
      }

      const selector = annotation.target?.selector;
      if (!selector || !selector.geometry || !selector.geometry.bounds) {
        console.warn('[handleClickAnnotationForClassification] Double-click: Annotation has no bounds:', annotation);
        lastClickTimestampRef.current = 0;
        lastClickedAnnotationIdRef.current = null;
        return;
      }

      const bounds = selector.geometry.bounds; // OSD Image Coordinates
      const centerX_osd_image = (bounds.minX + bounds.maxX) / 2;
      const centerY_osd_image = (bounds.minY + bounds.maxY) / 2;
      const originalX_level0 = centerX_osd_image;
      const originalY_level0 = centerY_osd_image;
      const newClassName = activeClass.name;
      const newClassColor = activeClass.color;

      console.log(`[handleClickAnnotationForClassification] Double-click: Processing ${centroidId} with class ${newClassName}`);

      annotationTypeStore.getState().setMany([{ id: String(centroidId), color: newClassColor, category: newClassName }]);

      if (viewerInstance && viewerInstance.world.getItemCount() > 0) {
        try {
          viewerInstance.forceRedraw();
        } catch (error) {
          console.warn('[Final Redraw] Failed to force redraw:', error);
        }
      }

      const zarrPath = getDefaultOutputPath(currentSvsPath);
      if (!zarrPath) {
        console.error('[handleClickAnnotationForClassification] Double-click: Could not get Zarr path.');
        lastClickTimestampRef.current = 0;
        lastClickedAnnotationIdRef.current = null;
        return;
      }

      saveAnnotationAndTriggerWorkflow(
        zarrPath,
        centroidId,
        originalX_level0,
        originalY_level0,
        newClassName,
        newClassColor,
        'annotation double-click classification'
      ).then(() => {
        setTimeout(() => {
          handleToolbarClick('move');
          if (annotatorInstance) {
            annotatorInstance.cancelSelected();
          }
        }, 50);
      }).catch((error: unknown) => {
        console.error('[handleClickAnnotationForClassification] Double-click: Error saving annotation:', error);
      });

      // Reset after processing double click
      lastClickTimestampRef.current = 0;
      lastClickedAnnotationIdRef.current = null;
    } else {
      // SINGLE CLICK (or first click of a potential double click)
      if (singleClickTimeoutRef.current) {
        clearTimeout(singleClickTimeoutRef.current);
        singleClickTimeoutRef.current = null;
      }
      lastClickTimestampRef.current = currentClickTimestamp;
      lastClickedAnnotationIdRef.current = currentAnnotationId;

      singleClickTimeoutRef.current = setTimeout(() => {
        if (lastClickedAnnotationIdRef.current !== currentAnnotationId) return;

        // 1) Get the center point of OSD bounds (OSD image coordinates)
        const selector = annotation.target?.selector as any;
        let cx_level0: number | undefined, cy_level0: number | undefined;
        if (selector?.geometry?.bounds) {
          const { minX, minY, maxX, maxY } = selector.geometry.bounds;
          const cx_img = (minX + maxX) / 2;
          const cy_img = (minY + maxY) / 2;
          cx_level0 = cx_img;
          cy_level0 = cy_img;
        }

        // 2) Parse cellId: prefer annotation.id as number, otherwise find the closest point in centroids
        let cellId: string | number | null = null;
        const idNum = Number(currentAnnotationId);
        if (Number.isFinite(idNum)) {
          cellId = idNum;
        } else if (typeof cx_level0 === 'number' && typeof cy_level0 === 'number' && centroids.length > 0) {
          // Extract to local constants for TypeScript type narrowing
          const cx = cx_level0;
          const cy = cy_level0;
          let bestId: number | null = null, bestD = Infinity;
          // CentroidsArray only
          centroids.forEach((c: Int32Array) => {
            const dx = c[1] - cx;
            const dy = c[2] - cy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD) {
              bestD = d2;
              bestId = Number(c[0]);
            }
          });
          cellId = bestId;
        }

        if (cellId == null || typeof cx_level0 !== 'number' || typeof cy_level0 !== 'number') {
          console.warn('[Cell Selection] Cannot select cellId or coordinates, skipping');
          return;
        }

        // 3) Uniform distribution of level-0 coordinates
        window.dispatchEvent(new CustomEvent('cellSelected', {
          detail: {
            cellId: String(cellId),
            centroid: { x: cx_level0, y: cy_level0 }, // Level-0
            slideId: currentPath || 'unknown',
            coordSpace: 'level0',
            dataSource: 'single-click',
          },
        }));

        singleClickTimeoutRef.current = null;
      }, SINGLE_CLICK_DELAY_MS);
    }
  }, [
    activeManualClassificationClassRef,
    annotatorInstance,
    currentSvsPath,
    nucleiClasses,
    updateAfterEveryAnnotation,
    currentOrgan,
    handleToolbarClick,
    currentInstanceId,
    currentPath,
    centroids,
    viewerInstance,
    selectedFolder,
    selectedModelForCurrentPath,
    updateClassifier,
    saveAnnotationAndTriggerWorkflow,
  ]);

  // Ruler handler
  const rulerHandler = useCallback((annotation: ImageAnnotation) => {
    if (annotation.target.selector.type === ShapeType.LINE) {
      const line = annotation.target.selector.geometry as LineGeometry;
      const start = line.points[0];
      const end = line.points[1];
      const lineLength = Math.sqrt(
        Math.pow(end[0] - start[0], 2) +
        Math.pow(end[1] - start[1], 2)
      ); // unit: pixel

      // Multiply by MPP to get accurate measurement in microns
      const mpp = slideInfo.mpp || 1; // Default to 1 if MPP is not available
      const lineLengthInMicrons = lineLength * mpp; // unit: micron (µm)

      // Convert to appropriate unit
      const { value: adjustedValue, unit } = convertToAppropriateUnit(lineLengthInMicrons);

      // Show tooltip with measurement at current mouse position
      setRulerTooltip({
        visible: true,
        text: `${Math.round(lineLength)} px | ${adjustedValue.toFixed(2)} ${unit}`,
        position: { x: mousePos.x, y: mousePos.y },
      });
      tooltipVisibleRef.current = true;
    }
  }, [slideInfo, mousePos, setRulerTooltip]);

  const rulerLeaveHandler = useCallback(() => {
    setRulerTooltip(prev => ({ ...prev, visible: false }));
    tooltipVisibleRef.current = false;
  }, [setRulerTooltip]);

  const rulerMoveHandler = useCallback((event: PointerEvent) => {
    if (tooltipVisibleRef.current) {
      const offset = 10; // Offset from cursor
      setRulerTooltip(prev => ({
        ...prev,
        position: {
          x: event.clientX + offset,
          y: event.clientY + offset,
        },
      }));
    }
  }, [setRulerTooltip]);

  // Set up event listeners
  useEffect(() => {
    const viewer = viewerInstance;
    if (viewer) {
      // Remove handler first to prevent duplicates if effect re-runs
      viewer.removeHandler('canvas-double-click', handleCanvasDoubleClick as OpenSeadragon.EventHandler<OpenSeadragon.CanvasDoubleClickEvent>);
      viewer.addHandler('canvas-double-click', handleCanvasDoubleClick as OpenSeadragon.EventHandler<OpenSeadragon.CanvasDoubleClickEvent>);

      return () => {
        if (viewer) {
          // Check again in cleanup as viewer might be destroyed
          viewer.removeHandler('canvas-double-click', handleCanvasDoubleClick as OpenSeadragon.EventHandler<OpenSeadragon.CanvasDoubleClickEvent>);
        }
      };
    }
  }, [handleCanvasDoubleClick, viewerInstance]);

  useEffect(() => {
    if (annotatorInstance) {
      const clickHandler = (annotation: ImageAnnotation) => handleClickAnnotationForClassification(annotation);

      annotatorInstance.on('clickAnnotation', clickHandler);
      annotatorInstance.on('mouseEnterAnnotation', rulerHandler);
      annotatorInstance.on('mouseLeaveAnnotation', rulerLeaveHandler);

      return () => {
        annotatorInstance.off('clickAnnotation', clickHandler);
        annotatorInstance.off('mouseEnterAnnotation', rulerHandler);
        annotatorInstance.off('mouseLeaveAnnotation', rulerLeaveHandler);
      };
    }
  }, [annotatorInstance, handleClickAnnotationForClassification, rulerHandler, rulerLeaveHandler]);

  useEffect(() => {
    document.body.addEventListener('pointermove', rulerMoveHandler);
    return () => {
      document.body.removeEventListener('pointermove', rulerMoveHandler);
    };
  }, [rulerMoveHandler]);

  // Cleanup single click timeout on unmount
  useEffect(() => {
    return () => {
      if (singleClickTimeoutRef.current) {
        clearTimeout(singleClickTimeoutRef.current);
        singleClickTimeoutRef.current = null;
      }
    };
  }, []);

  return {
    handleCanvasDoubleClick,
    handleClickAnnotationForClassification,
    rulerHandler,
    rulerLeaveHandler,
    rulerMoveHandler,
  };
};

