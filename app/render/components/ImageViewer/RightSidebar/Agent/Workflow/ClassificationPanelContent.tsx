"use client";
import { InlineSpinner } from '@/components/assets/PageLoading';
import ClassList from '@/components/imageViewer/Review/ClassList';
import ErrorBoundary from '@/components/imageViewer/Review/ErrorBoundary';
import ActiveLearningPanel, { ActiveLearningPanelRef } from '@/components/imageViewer/Review/ReviewPanel';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RangeInput } from "@/components/ui/range-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { useReview } from "@/hooks/useReview";
import { AppDispatch, RootState, store } from "@/store";
import { getErrorMessage } from "@/utils/common/apiResponse";
import { setIsGenerating as setIsChatGenerating } from "@/store/slices/chat/chatSlice";
import { selectSelectedModelForPath } from "@/store/slices/chat/modelSelectionSlice";
import { setCurrentOrgan, setIsRunning, setUpdateAfterEveryAnnotation, setUpdateClassifier } from "@/store/slices/chat/workflowSlice";
import {
  setCandidatesData,
  setCandidatesError,
  setCandidatesLoading,
  setProbDistCache,
  setReviewSession,
  setROI,
  setZoom
} from "@/store/slices/reviewSlice";
import {
  addNucleiClass,
  AnnotationClass,
  clearAnnotationTypes,
  deleteNucleiClass,
  setActiveManualClassificationClass,
  setAnnotations,
  setNucleiClasses,
  updateNucleiClass
} from "@/store/slices/viewer/annotationSlice";
import { DrawingTool, setTool } from "@/store/slices/viewer/toolSlice";
import { generateRandomColor, validateAndFixColor } from "@/utils/colorUtils";
import { NEGATIVE_CONTROL_CLASS_NAME, normalizeClassName } from "@/utils/patchClassificationUtils";
import { useRefreshGtHighlightIndices } from '@/hooks/viewer/useRefreshGtHighlightIndices';
import { apiFetch } from '@/utils/common/apiFetch';
import EventBus from "@/utils/EventBus";
import { formatPath } from "@/utils/pathUtils";
import { getRestrictedDirectoryMessage, isPublicReadOnlyPath } from "@/utils/sampleDirectoryUtils";
import { resetWorkflowBeforeStart } from "@/utils/workflowUtils";
import Image from "next/image";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiaDrawPolygonSolid } from "react-icons/lia";
import { PiRectangle } from "react-icons/pi";
import { useDispatch, useSelector } from "react-redux";
import { toast } from "sonner";
import { ClassificationFooter } from "./Card/ClassificationFooter";
import { ClassificationHeader } from "./Card/ClassificationHeader";
import { ClassifierStatusBanner } from "./Card/ClassifierStatusBanner";
import { PatchClassRow } from "./Card/Patch-ClassRow";
import {
  cellTypeOptions,
  getContentStringValue,
  hasClassifierDisplayOverride,
  removeClassifierPathContent,
} from "./constants";
import { ClassificationPanelContentProps } from "./types";

// Timeout for waiting for handler reload complete event (in milliseconds)
const HANDLER_RELOAD_TIMEOUT_MS = 5000;

export const ClassificationPanelContent: React.FC<ClassificationPanelContentProps> = ({
  panel,
  onContentChange,
  terminology = "cell",
  hideReviewPanel = false,
  graphStartWorkflow,
}) => {
  // Use "Patch" terminology for VISTA-style annotation; "Cell" for NuClass (default).
  const isPatchMode = terminology === "patch";
  const _termTitle = isPatchMode ? "Patch" : "Cell";
  const _termTitleId = isPatchMode ? "Patch" : "Nuclei";
  const dispatch = useDispatch<AppDispatch>();
  const nucleiClasses = useSelector((state: any) => state.annotations.nucleiClasses as AnnotationClass[]);
  const activeManualClass = useSelector((state: any) => state.annotations.activeManualClassificationClass as AnnotationClass | null);
  const updateAfterEveryAnnotation = useSelector((state: any) => state.workflow.updateAfterEveryAnnotation as boolean);
  const updateClassifier = useSelector((state: any) => state.workflow.updateClassifier as boolean);
  const { annotatorInstance } = useAnnotatorInstance();
  
  // Get current path and selected model from FileBrowserSidebar
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const selectedFolder = useSelector((state: RootState) => state.fileManager.selectedFolder);
  // Local Electron-only build: cloud file source no longer exists.
  const isWebMode = false;
  // MULTI-USER ISOLATION: Get activeInstanceId for per-instance storage
  const activeInstanceId = useSelector((state: RootState) => state.wsi.activeInstanceId);

  // Helper function to generate headers with instance_id for multi-user isolation
  const getApiHeaders = useCallback((): Record<string, string> => {
    return activeInstanceId ? { 'X-Instance-ID': activeInstanceId } : {};
  }, [activeInstanceId]);
  const refreshGtHighlightIndices = useRefreshGtHighlightIndices();
  // Get selected model for current path
  const selectedModelForCurrentPath = useSelector((state: RootState) => {
    // Use selectedFolder if available, otherwise try to get parent directory from currentPath
    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }
    // In web mode, empty string means root directory
    if (isWebMode && targetPath === '') {
      targetPath = '';
    }
    return selectSelectedModelForPath(state, targetPath);
  });

  const classifierLoadPath = useMemo(() => {
    const v = panel.content.find(item => item.key === 'classifier_path')?.value;
    return typeof v === 'string' ? v.trim() : '';
  }, [panel.content]);

  const hasClassifierApplied = Boolean(selectedModelForCurrentPath) || Boolean(classifierLoadPath);
  
  // Get Active Learning state for target cell zoom
  const reviewState = useReview();
  // Get shape data for ROI selection
  const shapeData = useSelector((state: any) => state.shape.shapeData as any);
  // Ref for ActiveLearningPanel to access its methods
  const activeLearningPanelRef = useRef<ActiveLearningPanelRef>(null);
  // Track pending reclassifications count
  const [pendingReclassificationsCount, setPendingReclassificationsCount] = useState(0);
  // Auto-save timer
  const autoSaveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [newClassName, setNewClassName] = useState(cellTypeOptions[0]);
  const [newClassColor, setNewClassColor] = useState(() => 
    generateRandomColor(nucleiClasses.map(c => c.color))
  );
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const debounceTimeoutId = useRef<NodeJS.Timeout | null>(null);
  const pendingRenameOpsRef = useRef<Array<{ from: string; to: string }>>([]);
  const pendingAddOpsRef = useRef<Array<{ name: string; color?: string }>>([]);
  const sliderDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const viewSizeDebounceRef = useRef<NodeJS.Timeout | null>(null);
  // Ref to store cleanup function for handler reload timeout
  const handlerReloadCleanupRef = useRef<(() => void) | null>(null);
  // Ref to track previous path for cleanup on image switch
  const prevPathRef = useRef<string | null>(null);
  
  
  
  // Cell review states
  const [selectedCell, setSelectedCell] = useState<{
    cellId: string;
    centroid: { x: number; y: number };
    slideId: string;
    fixedZLayer?: number | null;
    isZStack?: boolean;
    numZLayers?: number;
  } | null>(null);
  
  // Z-stack layer control for review panel
  const [reviewFixedZLayer, setReviewFixedZLayer] = useState<number | null>(null);
  
  // Preview state for Active Learning candidates - separate from confirmed selection
  const [previewCell, setPreviewCell] = useState<{
    cellId: string;
    centroid: { x: number; y: number };
    slideId: string;
    isPreview?: boolean;
  } | null>(null);
  const [showReviewModal, setShowReviewModal] = useState(false);
  
  // path - moved here to be available for autoSaveReclassifications
  const [formattedPath, setFormattedPath] = useState(formatPath(currentPath ?? ""));
  
  // Auto-save function
  const autoSaveReclassifications = useCallback(async () => {
    if (!showReviewModal || !formattedPath) return;
    
    try {
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/reclassification/commit`, {
        method: 'POST',
        body: JSON.stringify({
          slide_id: formattedPath
        }),
        headers: getApiHeaders(),
        returnAxiosFormat: true, 
      });
      
      if (response.data?.success && response.data?.count > 0) {
        // Auto-save successful (silent)
      }
    } catch (error) {
      // Auto-save failed (silent)
    }
  }, [formattedPath, showReviewModal, getApiHeaders]);
  
  // Set up auto-save interval when Review Modal is open
  useEffect(() => {
    if (showReviewModal) {
      // Start auto-save every 30 seconds
      autoSaveIntervalRef.current = setInterval(autoSaveReclassifications, 30000);
    } else {
      // Clear interval when modal closes
      if (autoSaveIntervalRef.current) {
        clearInterval(autoSaveIntervalRef.current);
        autoSaveIntervalRef.current = null;
      }
    }
    
    // Cleanup on unmount
    return () => {
      if (autoSaveIntervalRef.current) {
        clearInterval(autoSaveIntervalRef.current);
      }
    };
  }, [showReviewModal, autoSaveReclassifications]);
  const [reviewData, setReviewData] = useState<{
    image: string | null;
    bounds: { x: number; y: number; w: number; h: number };
    centroid?: { x: number; y: number };
    contour?: { x: number; y: number }[];
    pixel_spacing_um?: number;
    fov_um?: number;
    targetCell?: {
      centroid: { x: number; y: number };
      cellId: string;
      isFullImage: boolean;
      isLargeContext: boolean;
      tileSource?: any; // OpenSeadragon TileSource
    };
  } | null>(null);
  const [showContour, setShowContour] = useState(true); // Default to true for better UX
  const [isLoadingReview, setIsLoadingReview] = useState(false);
  const [isResizingView, setIsResizingView] = useState(false); // Lightweight loading for view size slider
  const [reviewError, setReviewError] = useState<string | null>(null);
  
  // Track the contour overlay annotation ID for cleanup
  const [contourAnnotationId, setContourAnnotationId] = useState<string | null>(null);

  const ensureHash = (hex: string | undefined | null): string => {
    if (!hex) return '#000000';
    return hex.startsWith('#') ? hex : `#${hex}`;
  };

  /**
   * When a classifier is applied (model selected and/or classifier_path set), the panel must list
   * every class stored in zarr (merged user + append-only classifier classes) and use zarr colors.
   */
  const syncNucleiClassesFromClassificationsIfClassifier = useCallback(async () => {
    if (!formattedPath || !activeInstanceId) return;
    if (!hasClassifierApplied) return;
    try {
      const classResp = await apiFetch(
        `${AI_SERVICE_API_ENDPOINT}/seg/v1/classifications?file_path=${encodeURIComponent(formattedPath)}`,
        { method: 'GET', returnAxiosFormat: true }
      );
      const classData = (classResp?.data as { data?: unknown })?.data ?? classResp?.data;
      const rawNames = classData?.nuclei_class_name;
      const rawColors = classData?.nuclei_class_HEX_color;
      if (!Array.isArray(rawNames) || rawNames.length === 0) {
        return;
      }

      const manualResp = await apiFetch(
        `${AI_SERVICE_API_ENDPOINT}/seg/v1/manual_annotation_counts?file_path=${encodeURIComponent(formattedPath)}`,
        { method: 'GET', returnAxiosFormat: true, headers: getApiHeaders() }
      );
      const manualData = (manualResp?.data as { data?: unknown })?.data ?? manualResp?.data;
      const countsMap: Record<string, number> = (manualData?.class_counts_by_id as Record<string, number>) || {};

      const finalClasses: AnnotationClass[] = rawNames.map((nameVal: string, i: number) => {
        const name = typeof nameVal === 'string' ? nameVal : String(nameVal ?? '');
        const rawHex = Array.isArray(rawColors) && rawColors[i] != null ? String(rawColors[i]) : '';
        const zarrColor =
          name === 'Negative control'
            ? '#aaaaaa'
            : validateAndFixColor(ensureHash(rawHex || '#808080'));
        return {
          name,
          color: zarrColor,
          count: Number(countsMap[String(i)] ?? 0),
          persisted: true,
        };
      });

      dispatch(setNucleiClasses(finalClasses));
    } catch (e) {
      console.warn('[ClassificationPanel] Classifier mode: failed to sync classes from classifications', e);
    }
  }, [formattedPath, activeInstanceId, hasClassifierApplied, dispatch, getApiHeaders]);
  
  // OpenSeadragon viewer ref for Review modal
  const reviewViewerRef = useRef<any>(null);

  // Cleanup timers on component unmount
  useEffect(() => {
    const sliderTimeout = sliderDebounceRef.current;
    const debounceTimeout = debounceTimeoutId.current;
    const handlerReloadCleanup = handlerReloadCleanupRef.current;
    const viewSizeTimeout = viewSizeDebounceRef.current;
    
    return () => {
      if (sliderTimeout) {
        clearTimeout(sliderTimeout);
      }
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      if (viewSizeTimeout) {
        clearTimeout(viewSizeTimeout);
      }
      if (handlerReloadCleanup) {
        handlerReloadCleanup();
      }
    };
  }, []);

  // Helper functions will be defined after formattedPath declaration

  // ROI detection logic - copied from DrawingOverlay.tsx

  // Check if a point is inside the rectangle selection
  const isPointInRectangle = (x: number, y: number, rect: any): boolean => {
    if (!rect) return false;
    return x >= Math.min(rect.x1, rect.x2) && x <= Math.max(rect.x1, rect.x2) &&
           y >= Math.min(rect.y1, rect.y2) && y <= Math.max(rect.y1, rect.y2);
  };

  // Check if a point is inside a polygon using ray casting algorithm (from DrawingOverlay.tsx)
  const isPointInPolygon = (x: number, y: number, polygonPoints: [number, number][]): boolean => {
    if (!polygonPoints || polygonPoints.length < 3) return false;

    let inside = false;
    const n = polygonPoints.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygonPoints[i][0];
      const yi = polygonPoints[i][1];
      const xj = polygonPoints[j][0];
      const yj = polygonPoints[j][1];

      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }

    return inside;
  };

  // Unified boundary check function that supports both rectangle and polygon (from DrawingOverlay.tsx)
  const isPointInBoundary = (x: number, y: number, shapeData: any): boolean => {
    if (!shapeData) return false;

    // If polygon points exist, use polygon boundary check
    if (shapeData.polygonPoints && shapeData.polygonPoints.length > 0) {
      return isPointInPolygon(x, y, shapeData.polygonPoints);
    }

    // Otherwise, use rectangle boundary check
    if (shapeData.rectangleCoords) {
      return isPointInRectangle(x, y, shapeData.rectangleCoords);
    }

    return false;
  };

  const hashROI = (roi: any): string => {
    // Simple hash for ROI - replace with more robust implementation
    return JSON.stringify(roi);
  };


  const buildProbDist = (cells: any[]): number[] => {
    // Build probability distribution histogram (20 bins) using max probability
    const bins = new Array(20).fill(0);
    cells.forEach(cell => {
      // Use max probability (cell.probability should be max prob from backend)
      const maxProb = cell.probability || cell.prob || 0.5;
      const binIndex = Math.min(19, Math.floor(maxProb * 20));
      bins[binIndex]++;
    });
    return bins;
  };

  // Global totals state
  const [totalCells, setTotalCells] = useState<number | null>(null);
  const [globalSegments, setGlobalSegments] = useState<{
    name: string;
    color: string;
    count: number;
  }[] | null>(null);
  
  // Get annotations from Redux at component level
  const annotations = useSelector((state: RootState) => state.annotations.annotations);
  
  // Helper functions
  const selectCellsInRegion = useCallback(async (shapeData: any): Promise<any[]> => {
    try {
      
      // First, try to get real data from backend API
      try {
        const { x1, y1, x2, y2 } = shapeData.rectangleCoords;

        // Call backend API to get cells within ROI with their classification data
        const queryParams = {
          x1,
          y1,
          x2,
          y2,
          // Don't filter by class_name here - we want all cells in ROI
        };
        
        
        const stringParams = Object.fromEntries(
          Object.entries(queryParams).map(([k, v]) => [k, String(v)])
        );
        const urlWithParams = `${AI_SERVICE_API_ENDPOINT}/seg/v1/query?${new URLSearchParams(stringParams).toString()}`;
        const response = await apiFetch(urlWithParams, {
          method: 'GET',
          returnAxiosFormat: true,
        });
        
        
        const responseData = (response.data as { data?: unknown })?.data ?? response.data;
        
        if (responseData && responseData.matching_indices && Array.isArray(responseData.matching_indices)) {
          
          // Try to get additional cell data including classifications
          let cellsWithClassification = [];
          
          try {
            // Call classification API to get cell classifications
            const classificationResponse = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classifications?file_path=${encodeURIComponent(formattedPath)}`, {
              method: 'GET',
              returnAxiosFormat: true,
            });
            
            const classData =
              (classificationResponse.data as { data?: unknown })?.data ?? classificationResponse.data;
            
            // If we have classification data, use it to enrich our cells
            if (classData && classData.nuclei_class_name && classData.nuclei_class_HEX_color) {
              const classNames = classData.nuclei_class_name;
              const classColors = classData.nuclei_class_HEX_color;
              
              cellsWithClassification = responseData.matching_indices.map((cellIndex: number, i: number) => {
                const roiWidth = x2 - x1;
                const roiHeight = y2 - y1;
                const offsetX = (roiWidth / 4) * (i % 4);
                const offsetY = (roiHeight / 3) * Math.floor(i / 4);
                const x = x1 + offsetX + (Math.random() - 0.5) * (roiWidth / 8);
                const y = y1 + offsetY + (Math.random() - 0.5) * (roiHeight / 8);
                
                // Assign classification based on cell index or random assignment
                const classIdx = cellIndex % classNames.length;
                const assignedClassName = classNames[classIdx];
                const assignedColor = classColors[classIdx];
                
                return {
                  cell_id: `backend-cell-${cellIndex}`,
                  id: `backend-cell-${cellIndex}`,
                  className: assignedClassName,
                  class_name: assignedClassName,
                  color: assignedColor,
                  centroid: { x: Math.round(x), y: Math.round(y) },
                  probability: 0,
                  prob: 0,
                  crop: {
                    bounds: { x: Math.round(x - 64), y: Math.round(y - 64), w: 128, h: 128 },
                    bbox: null,
                    contour: null,
                  },
                  // Mark as real backend data
                  isBackend: true,
                  backendIndex: cellIndex,
                };
              });
            }
          } catch (classError) {
          }
          
          // If we couldn't get classification data, fall back to basic format
          if (cellsWithClassification.length === 0) {
            cellsWithClassification = responseData.matching_indices.map((cellIndex: number, i: number) => {
              const roiWidth = x2 - x1;
              const roiHeight = y2 - y1;
              const offsetX = (roiWidth / 4) * (i % 4);
              const offsetY = (roiHeight / 3) * Math.floor(i / 4);
              const x = x1 + offsetX + (Math.random() - 0.5) * (roiWidth / 8);
              const y = y1 + offsetY + (Math.random() - 0.5) * (roiHeight / 8);
              
              return {
                cell_id: `backend-cell-${cellIndex}`,
                id: `backend-cell-${cellIndex}`,
                className: reviewState?.selectedClass || 'Unknown',
                class_name: reviewState?.selectedClass || 'Unknown',
                centroid: { x: Math.round(x), y: Math.round(y) },
                probability: 0.5 + Math.random() * 0.5, // 0.5-1.0
                prob: 0.5 + Math.random() * 0.5,
                crop: {
                  bounds: { x: Math.round(x - 64), y: Math.round(y - 64), w: 128, h: 128 },
                  bbox: null,
                  contour: null,
                },
                // Mark as real backend data
                isBackend: true,
                backendIndex: cellIndex,
              };
            });
          }
          
          return cellsWithClassification;
        }
        
      } catch (apiError) {
      }
      
      // Fallback 1: Try to get data from Redux annotations
      const currentAnnotations = annotations || [];
      
      // Debug what annotations we actually have
      currentAnnotations.forEach((ann: any, index: number) => {
      });
      
      // Filter to backend annotations with polygon geometry (real cell data)
      const backendCells = currentAnnotations.filter((annotation: any) => {
        const selector = Array.isArray(annotation.target?.selector) 
          ? annotation.target.selector[0] 
          : annotation.target?.selector;
        
        return annotation.isBackend && 
               selector?.geometry?.points && 
               selector.geometry.points.length > 0;
      });
      
      
      if (backendCells.length > 0) {
        // Convert backend cell annotations to our format
        const cells = backendCells.map((annotation: any, index: number) => {
          const selector = Array.isArray(annotation.target?.selector) 
            ? annotation.target.selector[0] 
            : annotation.target?.selector;
          
          // Calculate centroid from polygon points
          const points = selector.geometry.points;
          const sumX = points.reduce((sum: number, point: number[]) => sum + point[0], 0);
          const sumY = points.reduce((sum: number, point: number[]) => sum + point[1], 0);
          const centroid = { x: sumX / points.length, y: sumY / points.length };
          
          // Get classification from annotation bodies
          const classificationBody = annotation.bodies?.find((body: any) => 
            body.purpose === 'classification' || body.purpose === 'tagging'
          );
          
          return {
            cell_id: annotation.id,
            id: annotation.id,
            className: classificationBody?.value || reviewState?.selectedClass || 'Unknown',
            class_name: classificationBody?.value || reviewState?.selectedClass || 'Unknown', 
            centroid,
            probability: 0,
            prob: 0,
            crop: {
              bounds: { x: Math.round(centroid.x - 64), y: Math.round(centroid.y - 64), w: 128, h: 128 },
              bbox: null,
              contour: null,
            },
          };
        });
        
        
        // Filter cells by ROI bounds
        const { x1, y1, x2, y2 } = shapeData.rectangleCoords;

        const cellsInROI = cells.filter((cell: any) => {
          const { x, y } = cell.centroid;
          const inROI = x >= x1 && x <= x2 && y >= y1 && y <= y2;
          if (inROI) {
          }
          return inROI;
        });
        
        
        return cellsInROI;
      }
      
      // No fallback data - return empty array if no real data available
      return [];
      
    } catch (error) {
      return [];
    }
  }, [formattedPath, reviewState?.selectedClass, annotations]);
  
  // Load candidates and probability distribution
  const loadCandidatesAndProbDist = useCallback(async () => {
    // Use reviewState for selected class and slide ID
    if (!reviewState?.selectedClass || !formattedPath) return;

    // Set Active Learning session
    dispatch(setReviewSession({
      slideId: formattedPath || currentPath || 'unknown',
      className: reviewState.selectedClass
    }));

    dispatch(setCandidatesLoading(true));
    
    try {
      
      // Call Active Learning API using POST to avoid long query strings
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/candidates`, {
        method: 'POST',
        body: JSON.stringify({
          slide_id: formattedPath,
          class_name: reviewState.selectedClass,
          threshold: reviewState.threshold || 0.5,
          sort: reviewState.sort || "asc",
          limit: reviewState.pageSize || 80,
          offset: (reviewState.page || 0) * (reviewState.pageSize || 80),
        }),
        returnAxiosFormat: true,
      });


      if (response.data) {
        // Unwrapped AppResponse.data (optional legacy .data nesting)
        let total, hist, items;
        const root = response.data as Record<string, any>;
        const actualData = root.data ?? root;
        total = actualData.total;
        hist = actualData.hist || actualData.histogram_bins || [];
        items = actualData.items || actualData.candidates || [];


        dispatch(setCandidatesData({
          total: total || 0,
          hist: hist || [],
          items: items || []
        }));
        
        dispatch(setCandidatesError(null));
        
        // Handle probability distribution - use histogram from API response
        const cacheKey = `${formattedPath}_AL_${reviewState.selectedClass}_${reviewState.threshold}`;
        dispatch(setProbDistCache({ key: cacheKey, data: hist || [] }));
        
      } else {
        throw new Error('Invalid response format from Active Learning API');
      }

    } catch (error: any) {
      dispatch(setCandidatesError(getErrorMessage(error, 'Failed to load Active Learning candidates')));
      
      // Fallback to ROI-based selection for compatibility
      try {
        if (shapeData) {
          const cells = await selectCellsInRegion(shapeData);
          const filtered = cells.filter((cell: any) => {
            const cellClassName = cell.className || cell.class_name;
            return cellClassName && 
              cellClassName.toLowerCase().trim() === reviewState.selectedClass?.toLowerCase().trim();
          });
          
          dispatch(setCandidatesData({
            total: filtered.length,
            items: filtered.map((cell: any) => ({
              cell_id: cell.cell_id || cell.id || cell.cellId,
              prob: cell.prob || cell.probability || 0,
              centroid: cell.centroid || { x: 0, y: 0 },
              crop: {
                image: cell.crop?.image || cell.image || '',
                bounds: cell.crop?.bounds || cell.bbox || { x: 0, y: 0, w: 0, h: 0 },
                bbox: cell.crop?.bbox || cell.bbox,
                contour: cell.crop?.contour || cell.contour,
              },
              label: cell.label,
            })),
            hist: []
          }));
          
        }
      } catch (fallbackError) {
        let finalErrorMessage = 'Failed to load data';
        if (fallbackError instanceof Error) {
          if (fallbackError.message.includes('classification')) {
            finalErrorMessage = 'Please first click the Update button to run the classification model, then use the Review function';
          } else {
            finalErrorMessage = fallbackError.message;
          }
        }
        dispatch(setCandidatesError(finalErrorMessage));
      }
    } finally {
      dispatch(setCandidatesLoading(false));
    }
  }, [reviewState, formattedPath, currentPath, dispatch, shapeData, selectCellsInRegion]);
  
  // Debug path information

  useEffect(() => {
    if (isWebMode) {
      // In web mode, always use forward slashes
      setFormattedPath((currentPath ?? "").replace(/\\/g, "/"));
    } else {
      // In desktop mode, use formatPath for OS-specific formatting
      setFormattedPath(formatPath(currentPath ?? ""));
    }
  }, [currentPath, isWebMode]);

  // Clear cell-related state when switching images to prevent stale overlay
  useEffect(() => {
    // Debug: log current path changes
    console.log(`[ClassificationPanel] useEffect triggered, currentPath: ${currentPath}, prevPathRef: ${prevPathRef.current}`);
    
    // Initialize prevPathRef on first mount
    if (prevPathRef.current === null) {
      console.log(`[ClassificationPanel] Initializing prevPathRef with: ${currentPath}`);
      prevPathRef.current = currentPath;
      return;
    }
    
    // Only clear if path actually changed
    if (prevPathRef.current !== currentPath) {
      console.log(`[ClassificationPanel] Path changed from ${prevPathRef.current} to ${currentPath}, clearing cell overlay state`);
      
      // Get current contourAnnotationId from state using a ref to avoid closure issues
      // We'll use a functional update pattern to access current state
      setContourAnnotationId((currentContourId) => {
        // Clean up contour overlay annotation from annotator if it exists
        if (currentContourId && annotatorInstance) {
          try {
            const annotations = annotatorInstance.getAnnotations();
            const contourAnnotation = annotations.find((ann: any) => ann.id === currentContourId);
            if (contourAnnotation) {
              annotatorInstance.removeAnnotation(currentContourId);
              console.log(`[ClassificationPanel] Removed contour annotation: ${currentContourId}`);
            }
          } catch (error) {
            console.warn(`[ClassificationPanel] Failed to remove contour annotation:`, error);
          }
        }
        return null; // Clear the contour annotation ID
      });
      
      // Clear selected cell state
      setSelectedCell(null);
      setPreviewCell(null);
      
      // Clear review data
      setReviewData(null);
      setReviewError(null);
      setIsLoadingReview(false);
      
      // Clear contour data
      setContourData(null);
      setCachedCellData(null);
      
      // Reset z-layer state
      setReviewFixedZLayer(null);
      
      // Close review modal if open
      setShowReviewModal(false);
      
      // Clean up review viewer
      if (reviewViewerRef.current) {
        try {
          reviewViewerRef.current.destroy();
          console.log(`[ClassificationPanel] Destroyed review viewer`);
        } catch (error) {
          console.warn(`[ClassificationPanel] Failed to destroy review viewer:`, error);
        }
        reviewViewerRef.current = null;
      }
      
      console.log(`[ClassificationPanel] Cell overlay state cleared successfully`);
    }
    
    prevPathRef.current = currentPath;
  }, [currentPath, annotatorInstance]); // Only depend on currentPath and annotatorInstance

  // Auto-update panel content when selected model changes in FileBrowserSidebar.
  // Graph "Load classifier" stores paths + classifier_display_name; file browser selection should then take over (drop display override).
  useEffect(() => {
    const classifierDisplayName = getContentStringValue(panel.content, "classifier_display_name");
    if (classifierDisplayName === "") {
      let newContent = removeClassifierPathContent(panel.content);
      newContent = newContent.filter((item) => item.key !== "classifier_display_name");
      if (newContent.length !== panel.content.length) {
        onContentChange(panel.id, { ...panel, content: newContent });
      }
      return;
    }

    if (selectedModelForCurrentPath) {
      let modelPath;
      if (isWebMode) {
        modelPath = `${selectedFolder || ''}/${selectedModelForCurrentPath}`.replace(/\/+/g, '/');
      } else {
        modelPath = `${selectedFolder || ''}\\${selectedModelForCurrentPath}`.replace(/\\+/g, '\\');
      }

      let newContent = [...panel.content].filter((item) => item.key !== "classifier_display_name");
      const loadIndex = newContent.findIndex((item) => item.key === "classifier_path");
      const saveIndex = newContent.findIndex((item) => item.key === "save_classifier_path");

      if (loadIndex > -1) {
        newContent[loadIndex] = { ...newContent[loadIndex], value: modelPath };
      } else {
        newContent.push({ key: "classifier_path", type: "input", value: modelPath });
      }

      if (updateClassifier) {
        if (saveIndex > -1) {
          newContent[saveIndex] = { ...newContent[saveIndex], value: modelPath };
        } else {
          newContent.push({ key: "save_classifier_path", type: "input", value: modelPath });
        }
      } else if (saveIndex > -1) {
        newContent.splice(saveIndex, 1);
      }

      onContentChange(panel.id, { ...panel, content: newContent });
      return;
    }

    if (hasClassifierDisplayOverride(panel.content)) {
      return;
    }

    let newContent = [...panel.content];
    const loadIndex = newContent.findIndex((item) => item.key === "classifier_path");
    const saveIndex = newContent.findIndex((item) => item.key === "save_classifier_path");
    if (loadIndex > -1) {
      newContent.splice(loadIndex, 1);
    }
    if (saveIndex > -1) {
      const adjustedSaveIndex = saveIndex > loadIndex ? saveIndex - 1 : saveIndex;
      newContent.splice(adjustedSaveIndex, 1);
    }
    onContentChange(panel.id, { ...panel, content: newContent });
  }, [selectedModelForCurrentPath, selectedFolder, isWebMode, updateClassifier]); // eslint-disable-line react-hooks/exhaustive-deps

  const promptInitRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      const promptValue = panel.content.find(item => item.key === "prompt")?.value;
      const promptKey = `${panel.id}::${typeof promptValue === 'string' ? promptValue : JSON.stringify(promptValue ?? '')}`;
      
      if (promptInitRef.current === promptKey) {
        return;
      }
      promptInitRef.current = promptKey;

      let promptContent: { organ_type?: string; nuclei_classes?: string[] } | undefined = undefined;
      if (promptValue) {
        if (typeof promptValue === 'string') {
          try {
            promptContent = JSON.parse(promptValue) as { organ_type?: string; nuclei_classes?: string[] };
          } catch (e) {
            let classString = promptValue;
            if (classString.includes('=')) {
              classString = classString.substring(classString.indexOf('=') + 1).trim();
              // Remove surrounding quotes if present (handles various quote types)
              classString = classString.replace(/^["'`](.*)["'`]$/, '$1');
            }
            
            const classes = classString
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);
            
            if (classes.length > 0) {
              promptContent = { nuclei_classes: classes };
            }
          }
        } else {
          promptContent = promptValue as { organ_type?: string; nuclei_classes?: string[] };
        }
      }
      
      if (promptContent && 'nuclei_classes' in promptContent && Array.isArray(promptContent.nuclei_classes)) {
        // Normalize the agent's class list: rewrite catch-all aliases
        // (Others / Unknown / Background / Misc / ...) to "Negative control",
        // strip empty entries, and de-duplicate.
        const normalizedClasses = Array.from(new Set(
          promptContent.nuclei_classes
            .map((c) => normalizeClassName(c))
            .filter((c) => c.length > 0)
        ));

        const classesWithData = nucleiClasses.filter(cls => cls.persisted === true && cls.count > 0);
        const hasBackendClasses = classesWithData.length > 0;

        if (hasBackendClasses) {
          const currentClassNames = nucleiClasses.map(cls => cls.name.toLowerCase());
          const newClasses: string[] = [];

          normalizedClasses.forEach((className) => {
            if (!currentClassNames.includes(className.toLowerCase())) {
              newClasses.push(className);
            }
          });

          if (newClasses.length > 0) {
            newClasses.forEach(className => {
              const existingColors = nucleiClasses.map(c => c.color);
              const randomColor = generateRandomColor(existingColors);
              dispatch(addNucleiClass({
                name: className,
                count: 0,
                color: randomColor,
                persisted: false,
              }));
            });
          }
        } else {
          const currentClassNames = nucleiClasses.map(cls => cls.name.toLowerCase());
          const toAdd: string[] = [];
          const toKeep = new Set<string>();

          // Always preserve "Negative control" — the built-in catch-all
          // class must never be removed even if the agent omits it.
          toKeep.add(NEGATIVE_CONTROL_CLASS_NAME.toLowerCase());

          normalizedClasses.forEach((className) => {
            const lowerName = className.toLowerCase();
            toKeep.add(lowerName);
            if (!currentClassNames.includes(lowerName)) {
              toAdd.push(className);
            }
          });

          const toRemoveIndices: number[] = [];
          nucleiClasses.forEach((cls, idx) => {
            if (!cls.persisted && !toKeep.has(cls.name.toLowerCase())) {
              toRemoveIndices.push(idx);
            }
          });
          
          if (toRemoveIndices.length > 0) {
            toRemoveIndices.sort((a, b) => b - a).forEach(index => {
              dispatch(deleteNucleiClass(index));
            });
          }
          
          if (toAdd.length > 0) {
            toAdd.forEach(className => {
              const existingColors = nucleiClasses.map(c => c.color);
              const randomColor = generateRandomColor(existingColors);
              dispatch(addNucleiClass({
                name: className,
                count: 0,
                color: randomColor,
                persisted: false,
              }));
            });
          }
        }
      }
    } catch (error) {
      console.error('Error in workflow input processing:', error);
    }
  }, [panel.content, dispatch, nucleiClasses, panel.id]);

  // Fetch global totals (model + manual overrides) from backend
  const fetchGlobalTotals = useCallback(async () => {
    try {
      if (!formattedPath) return;

      // Get TOTAL counts (model + manual) for display
      const totalResp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/total_counts?file_path=${encodeURIComponent(formattedPath)}`, {
        method: 'GET',
        returnAxiosFormat: true,
      });
      const totalData = totalResp?.data?.data || totalResp?.data;

      if (totalData) {
        const names: string[] = (totalData.dynamic_class_names || []) as string[];
        const colors: string[] = (totalData.class_hex_colors || []) as string[];
        const countsMap: Record<string, number> = totalData.class_counts_by_id || {};
        const total: number = typeof totalData.total_cells === 'number' ? totalData.total_cells : null;

        // Get current nucleiClasses from Redux store to match colors by name
        const state = store.getState();
        const currentNucleiClasses = state.annotations.nucleiClasses as AnnotationClass[];
        
        // Create a map of class name to color from nucleiClasses for accurate color matching
        const classColorMap = new Map<string, string>();
        currentNucleiClasses.forEach(cls => {
          classColorMap.set(cls.name.toLowerCase(), cls.color);
        });

        const segs = names.map((n: string, i: number) => {
          // Ensure 'Negative control' always uses #aaaaaa color
          if (n === 'Negative control') {
            return {
              name: n,
              color: '#aaaaaa',
              count: countsMap[String(i)] || 0,
            };
          }
          
          // Try to find color from nucleiClasses first (by name match)
          const matchedClass = currentNucleiClasses.find(cls => cls.name.toLowerCase() === n.toLowerCase());
          const colorFromNucleiClasses = matchedClass?.color;
          
          // Use color from nucleiClasses if found, otherwise fall back to backend color, then to default
          const finalColor = colorFromNucleiClasses || colors[i] || (() => {
            // Use muted-foreground as fallback color, dynamically calculated
            if (typeof window !== 'undefined') {
              const mutedForeground = getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim();
              return `hsl(${mutedForeground})`;
            }
            return '#aaaaaa'; // Fallback for SSR
          })();
          
          return {
            name: n,
            color: finalColor,
            count: countsMap[String(i)] || 0,
          };
        });

        setTotalCells(total);
        setGlobalSegments(segs);
      }

      // Get MANUAL annotation counts for the annotation panel
      const manualResp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/manual_annotation_counts?file_path=${encodeURIComponent(formattedPath)}`, {
        method: 'GET',
        returnAxiosFormat: true,
        headers: getApiHeaders()
      });
      const manualData = manualResp?.data?.data || manualResp?.data;

      if (manualData) {
        const manualNames: string[] = (manualData.dynamic_class_names || []) as string[];
        const manualCountsMap: Record<string, number> = manualData.class_counts_by_id || {};

        // Get current nucleiClasses from Redux store to avoid stale closure
        const state = store.getState();
        const currentNucleiClasses = state.annotations.nucleiClasses as AnnotationClass[];

        // Update nucleiClasses with manual annotation counts only
        // Only update if counts actually changed to avoid unnecessary re-renders
        const updatedNucleiClasses = currentNucleiClasses.map(cls => {
          const classIndex = manualNames.indexOf(cls.name);
          if (classIndex >= 0) {
            const newCount = manualCountsMap[String(classIndex)] || 0;
            if (cls.count !== newCount) {
              return {
                ...cls,
                count: newCount
              };
            }
          } else if (cls.count !== 0) {
            return { ...cls, count: 0 };
          }
          return cls; // Return same object if no change
        });

        // Only dispatch if something actually changed
        const hasChanges = updatedNucleiClasses.some((updated, index) => 
          updated !== currentNucleiClasses[index] || updated.count !== currentNucleiClasses[index].count
        );
        
        if (hasChanges) {
          dispatch(setNucleiClasses(updatedNucleiClasses));
        }
      }

    } catch (e) {
      console.error('Error fetching counts:', e);
    }
  }, [formattedPath, dispatch, getApiHeaders]); // Don't include nucleiClasses to avoid infinite loop

  const getContrastTextColor = (hexColor: string): string => {
    try {
      let hex = hexColor.replace('#', '');
      if (hex.length === 3) {
        hex = hex.split('').map((c) => c + c).join('');
      }
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      return brightness > 150 ? '#000000' : '#ffffff';
    } catch {
      return '#000000';
    }
  };

  const formatCompact = (value: number | null | undefined): string => {
    if (value == null || isNaN(value as any)) return '0';
    const n = Number(value);
    if (n >= 1_000_000) {
      const v = n / 1_000_000;
      const s = v >= 10 ? Math.round(v).toString() : v.toFixed(1);
      return s.replace(/\.0$/, '') + 'M';
    }
    if (n >= 10_000) {
      return Math.round(n / 1_000).toString() + 'k';
    }
    if (n >= 1_000) {
      const v = n / 1_000;
      return v.toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return n.toLocaleString();
  };

  // Load totals on path change (classifier mode: full class list + zarr colors first)
  useEffect(() => {
    if (!activeInstanceId) return;
    void (async () => {
      if (formattedPath && hasClassifierApplied) {
        await syncNucleiClassesFromClassificationsIfClassifier();
      }
      await fetchGlobalTotals();
    })();
  }, [formattedPath, fetchGlobalTotals, activeInstanceId, hasClassifierApplied, syncNucleiClassesFromClassificationsIfClassifier]);

  // Refresh totals on backend refresh events with debouncing
  useEffect(() => {
    let debounceTimer: NodeJS.Timeout;

    const refreshHandler = () => {
      // Clear any pending refresh
      clearTimeout(debounceTimer);
      // Debounce to avoid multiple rapid calls
      debounceTimer = setTimeout(() => {
        void (async () => {
          if (formattedPath && activeInstanceId && hasClassifierApplied) {
            await syncNucleiClassesFromClassificationsIfClassifier();
          }
          await fetchGlobalTotals();
        })();
      }, 100);
    };

    EventBus.on('refresh-annotations', refreshHandler);
    // Also listen to refresh-websocket-path for workflow completion
    EventBus.on('refresh-websocket-path', refreshHandler);

    return () => {
      clearTimeout(debounceTimer);
      EventBus.off('refresh-annotations', refreshHandler);
      EventBus.off('refresh-websocket-path', refreshHandler);
    };
  }, [fetchGlobalTotals, formattedPath, activeInstanceId, hasClassifierApplied, syncNucleiClassesFromClassificationsIfClassifier]);

  // Remove local manual reclassification handler
  // We'll rely entirely on backend updates to avoid sync issues

  const handleAddClass = () => {
    // Validate class name
    const trimmedName = newClassName.trim();
    if (!trimmedName) {
      return; // Should not happen due to button disabled, but extra safety
    }
    
    if (editingIndex !== null) {
      const oldName = String(nucleiClasses[editingIndex]?.name ?? "").trim();
      // Update existing class
      const updatedClass: AnnotationClass = {
        ...nucleiClasses[editingIndex],
        name: trimmedName,
        color: newClassColor
      };
      
      dispatch(updateNucleiClass({
        index: editingIndex, 
        newClass: updatedClass
      }));

      if (oldName && trimmedName && oldName !== trimmedName) {
        pendingRenameOpsRef.current.push({ from: oldName, to: trimmedName });
      }
    } else {
      // Check if class already exists (case-insensitive)
      const exists = nucleiClasses.some(cls => cls.name.toLowerCase() === trimmedName.toLowerCase());
      if (exists) {
        // Class already exists, show warning and keep modal open
        toast.warning(`Class "${trimmedName}" already exists in the list.`);
        return;
      }
      
      // Add new class
      dispatch(addNucleiClass({
        name: trimmedName,
        count: 0,
        color: newClassColor
      }));
      pendingAddOpsRef.current.push({ name: trimmedName, color: newClassColor });
    }
    
    // Reset state
    setShowModal(false);
    setNewClassName(cellTypeOptions[0]);
    setNewClassColor(generateRandomColor(nucleiClasses.map(c => c.color)));
    setEditingIndex(null);
  };
  
  // Function to open add/edit modal
  const openAddClassModal = () => {
    setShowModal(true);
  };
  
  // Function to edit a class
  const editClass = (index: number) => {
    const cls = nucleiClasses[index];
    setNewClassName(cls.name);
    setNewClassColor(cls.color);
    setEditingIndex(index);
    setShowModal(true);
  };

  // Helpers
  const getZarrPath = (): string | null => (formattedPath ? `${formattedPath}.zarr` : null);

  const performDelete = async (index: number, className: string, reassignTo = 'Negative control') => {
    const zarrPath = getZarrPath();
    if (!zarrPath) return;
    await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/delete-class`, {
      method: 'POST',
      body: JSON.stringify({
        class_name: className,
        reassign_to: reassignTo,
        file_path: zarrPath,
      }),
      returnAxiosFormat: true,
    });
    dispatch(deleteNucleiClass(index));
    dispatch(clearAnnotationTypes());
    if (activeManualClass && activeManualClass.name === className) {
      dispatch(setActiveManualClassificationClass(null));
    }
    EventBus.emit('refresh-annotations');
    EventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
  };

  const handleDeleteClass = async (index: number) => {
    const cls = nucleiClasses[index];
    if (!cls) return;
    const removedName = String(cls.name ?? "").trim();

    if (removedName) {
      pendingAddOpsRef.current = pendingAddOpsRef.current.filter(op => op.name !== removedName);
      pendingRenameOpsRef.current = pendingRenameOpsRef.current.filter(
        op => op.from !== removedName && op.to !== removedName
      );
    }

    if (!cls.persisted) {
      dispatch(deleteNucleiClass(index));
      return;
    }
    await performDelete(index, cls.name, 'Negative control');
  };
  
  // Reset function
  const handleReset = async () => {
    const getDefaultOutputPath = (path: string): string => {
      if (!path) return "";
      return path + '.zarr';
    };

    const outputPath = getDefaultOutputPath(formattedPath);
    if (!outputPath) {
        setShowResetModal(false);
        return;
    }

    setIsResetting(true);

    try {
      // API call to the new backend endpoint
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/reset_classification`, {
        method: 'POST',
        body: JSON.stringify({
          zarr_path: outputPath
        }),
        returnAxiosFormat: true,
      });

      if (response.data?.status === 'success') {
          // On success: keep all classes but zero their counts
          const cleared = nucleiClasses.map(cls => ({ ...cls, count: 0 }));
          dispatch(setNucleiClasses(cleared));
          dispatch(setAnnotations([]));
          dispatch(clearAnnotationTypes());

          // Emit websocket refresh first to trigger handler reload
          EventBus.emit("refresh-websocket-path", { path: outputPath, forceReload: true });

          // Helper function to fetch statistics after handler reload complete
          const fetchStatisticsAfterReset = async () => {
            try {
              // Get class names and colors from classifications endpoint
              const classResp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classifications?file_path=${encodeURIComponent(formattedPath)}`, {
                method: 'GET',
                returnAxiosFormat: true,
              });
              const classData = classResp?.data;
              
              // BUG FIX: Use manual_annotation_counts instead of total_counts
              // to be consistent with fetchGlobalTotals and avoid "two counting logic fighting"
              const manualResp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/manual_annotation_counts?file_path=${encodeURIComponent(formattedPath)}`, {
                method: 'GET',
                returnAxiosFormat: true,
                headers: getApiHeaders()
              });
              const manualData = manualResp?.data?.data || manualResp?.data;
              
              if (classData && classData.nuclei_class_name && classData.nuclei_class_HEX_color) {
                const countsMap: Record<string, number> = manualData?.class_counts_by_id || {};
                const finalClasses = classData.nuclei_class_name.map((rawName: string, i: number) => {
                  const name = typeof rawName === 'string' ? rawName : String(rawName ?? '');
                  // Ensure 'Negative control' always uses #aaaaaa color
                  const color = name === 'Negative control' ? '#aaaaaa' : (classData.nuclei_class_HEX_color[i] || '#aaaaaa');
                  return {
                    name,
                    color,
                    count: countsMap[String(i)] || 0, // Get count from manual_annotation_counts
                    persisted: true,
                  };
                });
                dispatch(setNucleiClasses(finalClasses));
              }
            } catch (e) {
              console.warn("Failed to fetch classifications after reset:", e);
            }
          };

          // Wait for handler reload complete signal in background (non-blocking)
          // This ensures backend has completed: 1) reload handlers, 2) re-apply manual annotations, 3) clear active learning memory
          // Use setTimeout to make this async and non-blocking so UI doesn't freeze
          // Clear any existing cleanup before setting up a new one
          if (handlerReloadCleanupRef.current) {
            handlerReloadCleanupRef.current();
            handlerReloadCleanupRef.current = null;
          }

          // Store references to timeout and handler for cleanup
          let timeout: ReturnType<typeof setTimeout> | null = null;
          let handler: ((eventData: { path?: string }) => void) | null = null;

          const cleanup = () => {
            if (timeout) {
              clearTimeout(timeout);
              timeout = null;
            }
            if (handler) {
              EventBus.off('handler-reload-complete', handler);
              handler = null;
            }
          };

          // Store cleanup function in ref so it can be called on component unmount
          handlerReloadCleanupRef.current = cleanup;

          setTimeout(() => {
            timeout = setTimeout(() => {
              cleanup();
              handlerReloadCleanupRef.current = null;
              setIsResetting(false);
              console.warn("Timeout waiting for handler reload complete, fetching statistics anyway");
              fetchStatisticsAfterReset();
              refreshGtHighlightIndices();
            }, HANDLER_RELOAD_TIMEOUT_MS);

            handler = (eventData: { path?: string }) => {
              // Check if this event is for the correct path (normalize paths for comparison)
              const eventPath = eventData?.path?.replace(/\.(zarr)$/i, '') || '';
              const targetPath = outputPath.replace(/\.(zarr)$/i, '');
              
              if (!eventData.path || eventPath === targetPath) {
                cleanup();
                handlerReloadCleanupRef.current = null;
                setIsResetting(false);
                fetchStatisticsAfterReset();
                refreshGtHighlightIndices();
              }
            };

            EventBus.on('handler-reload-complete', handler);
          }, 0);

      } else {
        setIsResetting(false);
      }
    } catch (error) {
      setIsResetting(false);
    } finally {
        setShowResetModal(false);
    }
  };
  
  // Update function
  const handleClickUpdate = async () => {
    // Check if in samples directory
    if (isPublicReadOnlyPath(currentPath) || isPublicReadOnlyPath(selectedFolder)) {
      console.error(getRestrictedDirectoryMessage('update panel'));
      return;
    }

    const getDefaultOutputPath = (path: string): string => {
      if (!path) return "";
      return path + '.zarr';
    };

    const outputPath = getDefaultOutputPath(formattedPath);
    const organValue = panel.content.find(item => item.key === "organ")?.value ?? "";

    // Use paths from panel.content (they are synced with FileBrowserSidebar)
    // This ensures UI display and actual payload are always consistent
    // If not found in panel.content, use null (no fallback calculation)
    let finalLoadPath = getContentStringValue(panel.content, "classifier_path");
    let finalSavePath = getContentStringValue(panel.content, "save_classifier_path");
    const classifierDisplayName = getContentStringValue(panel.content, "classifier_display_name");
    if (classifierDisplayName === "") {
      finalLoadPath = null;
      finalSavePath = null;
    }
    
    // Ensure save_path is cleared if updateClassifier is false
    if (!updateClassifier) {
      finalSavePath = null;
    }
    
    // Normalize: convert undefined to null for consistency
    finalLoadPath = finalLoadPath ?? null;
    finalSavePath = finalSavePath ?? null;
    
    console.log('[ClassificationPanel] Workflow paths:', {
      finalLoadPath,
      finalSavePath,
      updateClassifier,
      selectedModelForCurrentPath,
      hasSelectedModel: !!selectedModelForCurrentPath
    });

    const classOperations = {
      renames: pendingRenameOpsRef.current
        .map(op => ({ from: String(op.from || '').trim(), to: String(op.to || '').trim() }))
        .filter(op => op.from && op.to && op.from !== op.to),
      adds: pendingAddOpsRef.current
        .map(op => ({ name: String(op.name || '').trim(), color: op.color }))
        .filter(op => op.name),
    };

    const workflowPayload = {
      zarr_path: outputPath,
      step1: {
        nodeId: "ClassificationNode",
        input: {
          nuclei_classes: nucleiClasses.map(cls => cls.name),
          nuclei_colors: nucleiClasses.map(cls => cls.color),
          organ: organValue,
          classifier_path: finalLoadPath,
          save_classifier_path: finalSavePath,
          ...(classOperations.renames.length || classOperations.adds.length
            ? { class_operations: classOperations }
            : {}),
        }
      }
    };

    try {
      // Reset workflow state and close SSE connection before starting
      // Use shared utility function for consistent behavior
      await resetWorkflowBeforeStart(dispatch);

      dispatch(setIsChatGenerating(true));
      dispatch(setIsRunning(true));

      console.log("[ClassificationPanel] Workflow payload:", workflowPayload);

      if (graphStartWorkflow) {
        // `graphStartWorkflow` is `useWorkflowRuntimeStatus().startWorkflow`, which already emits
        // `workflow-graph-run-start` before POST (same hook as graph Run).
        await graphStartWorkflow(workflowPayload as Record<string, unknown>)
        dispatch(setIsChatGenerating(false))
        pendingRenameOpsRef.current = [];
        pendingAddOpsRef.current = [];
      } else {
        EventBus.emit("workflow-graph-run-start");
        const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, {
          method: "POST",
          body: JSON.stringify(workflowPayload),
          returnAxiosFormat: true,
        });

        if (response.status !== 200) {
          EventBus.emit("workflow-graph-run-aborted");
          dispatch(setIsChatGenerating(false));
          dispatch(setIsRunning(false));
        } else {
          pendingRenameOpsRef.current = [];
          pendingAddOpsRef.current = [];
        }
      }
    } catch (error) {
      EventBus.emit("workflow-graph-run-aborted");
      dispatch(setIsChatGenerating(false));
      dispatch(setIsRunning(false));
    }
  };

  // Unify "auto update after annotation" with manual Update button behavior.
  // All auto paths emit this event; this handler reuses handleClickUpdate so payloads stay identical.
  useEffect(() => {
    const handler = async (eventData?: { zarrPath?: string; source?: string }) => {
      const target = (eventData?.zarrPath || '').replace(/\.(zarr)$/i, '');
      const current = (formattedPath || '').replace(/\.(zarr)$/i, '');
      if (!target || !current || target !== current) {
        return;
      }
      await handleClickUpdate();
    };
    EventBus.on('trigger-nuclei-update', handler);
    return () => {
      EventBus.off('trigger-nuclei-update', handler);
    };
  }, [formattedPath, handleClickUpdate]);

  const handleClassSelect = (index: number) => {
    const selectedClass = nucleiClasses[index];
    if (activeManualClass && activeManualClass.name === selectedClass.name && activeManualClass.color === selectedClass.color) {
      dispatch(setActiveManualClassificationClass(null));
    } else {
      dispatch(setActiveManualClassificationClass(selectedClass));
    }
  };

  // File selection is now handled by FileBrowserSidebar
  const handleFileSelect = async (type: 'load' | 'save') => {
    console.log(`File selection for ${type} is now handled by FileBrowserSidebar`);
  };

  // Path management is now handled entirely by FileBrowserSidebar
  const handlePathChange = (type: 'load' | 'save', value: string | null) => {
    let newContent = [...panel.content];
    const key = type === 'save' ? "save_classifier_path" : "classifier_path";
    const itemIndex = newContent.findIndex(item => item.key === key);
    
    if (value) {
      if (itemIndex > -1) {
        newContent[itemIndex] = { ...newContent[itemIndex], value };
      } else {
        newContent.push({ key, type: 'input', value });
      }
    } else {
      if (itemIndex > -1) {
        newContent.splice(itemIndex, 1);
      }
    }
    
    onContentChange(panel.id, { ...panel, content: newContent });
  };

  // Handle update classifier checkbox change
  const handleUpdateClassifierChange = (checked: boolean) => {
    dispatch(setUpdateClassifier(checked));

    if (checked && selectedModelForCurrentPath) {
      let modelPath;
      if (isWebMode) {
        modelPath = `${selectedFolder || ''}/${selectedModelForCurrentPath}`.replace(/\/+/g, '/');
      } else {
        modelPath = `${selectedFolder || ''}\\${selectedModelForCurrentPath}`.replace(/\\+/g, '\\');
      }
      handlePathChange('load', modelPath);
      handlePathChange('save', modelPath);
    } else if (checked) {
      const load = getContentStringValue(panel.content, "classifier_path");
      if (load) {
        handlePathChange('save', load);
      }
    } else if (!checked) {
      handlePathChange('save', null);
    }
  };

  const panelClassifierLoadPath = getContentStringValue(panel.content, "classifier_path");
  const classifierResolvedForUpdate =
    Boolean(selectedModelForCurrentPath) || Boolean(panelClassifierLoadPath?.trim());


  // Handle color change with optimistic update (no API call, will be saved on Update button click)
  const handleColorChange = (index: number, newColor: string) => {
    // Prevent color change for 'Negative control' - it must always be #aaaaaa
    const targetClass = nucleiClasses[index];
    if (targetClass && targetClass.name === 'Negative control') {
      return; // Do not allow color changes for Negative control
    }

    // Validate and fix color if it's black or white
    const existingColors = nucleiClasses.map(c => c.color);
    const validatedColor = validateAndFixColor(newColor, existingColors);

    // Clear any pending timeout
    if (debounceTimeoutId.current) {
      clearTimeout(debounceTimeoutId.current);
      debounceTimeoutId.current = null;
    }

    // Immediately update the UI with optimistic update (no debounce, no API call)
    // The color will be saved to backend when user clicks Update button
    const originalClass = nucleiClasses[index];
    dispatch(updateNucleiClass({
      index,
      newClass: { ...originalClass, color: validatedColor }
    }));

    // Note: No API call here - color will be saved to backend via workflow payload when Update is clicked
  };

  const currentTool = useSelector((state: RootState) => state.tool.currentTool);
  const handleToolChange = (tool: DrawingTool) => {
    dispatch(setTool(tool));
  };

  // Cell selection event listener setup
  useEffect(() => {
    
    // Cell selection event handler
    const handleCellSelectionEvent = (event: CustomEvent) => {
      // Skip if this is from AL candidate selection to avoid conflicts
      if ((window as any)._alSelectionInProgress) {
        return;
      }
      
      const { cellId, centroid, slideId } = event.detail;
      
      try {
        // Validate input parameters
        if (!cellId || typeof cellId !== 'string') {
          return;
        }

        if (!centroid || typeof centroid.x !== 'number' || typeof centroid.y !== 'number') {
          return;
        }

        const newSelectedCell = {
          cellId,
          centroid, // Already in level-0 coordinates
          slideId: slideId || currentPath || "unknown"
        };

        // When selecting a new cell, keep old image for smooth transition
        // (shows semi-transparent loading overlay instead of gray loading)
        if (selectedCell?.cellId !== cellId) {
          // Don't clear reviewData - keep old image visible during loading
          // setReviewData(null);  // Removed for smoother UX
          // setShowContour(false); // Removed: keep user's contour preference
          setReviewError(null);
          // Reset zoom to default when switching cells
          dispatch(setZoom(90));
          // Note: Contour cleanup is now handled within the Review modal
        }

        setSelectedCell(newSelectedCell);
        
        // Only fetch review data if not from AL panel selection
        // AL panel will fetch its own review data via onSelectedCellChange callback
        
      } catch (error) {
      }
    };

    // Add event listener
    window.addEventListener('cellSelected', handleCellSelectionEvent as EventListener);
    
    return () => {
      window.removeEventListener('cellSelected', handleCellSelectionEvent as EventListener);
    };
  }, [currentPath, selectedCell?.cellId]); // Include dependencies used in the event handler

  // Store the actual window size used for coordinate mapping
  const [actualWindowSize, setActualWindowSize] = useState<number>(512);
  
  // Setup cell positioning and contour display in main viewer
  // forceZoom: optional zoom value to use (bypasses Redux state race condition when switching cells)
  const setupTargetCellWithMainViewer = async (cell: typeof selectedCell, forceZoom?: number) => {
    if (!cell) return;
    
    
    // Position viewer using centroid and contour data
    await showNucleiWithViewer(cell, forceZoom);
  };


  // Show nuclei with positioning and contour display
  // forceZoom: optional zoom value to use directly (for cell switching to avoid race condition)
  const showNucleiWithViewer = async (cell: typeof selectedCell, forceZoom?: number) => {
    if (!cell) return;

    
    // Use forceZoom if provided (when switching cells), otherwise use Redux state
    const effectiveZoom = forceZoom ?? reviewState?.zoom;
    
    // Ensure we have a proper default zoom for patch mode (reset if too low)
    if (!effectiveZoom || effectiveZoom < 10) {
      dispatch(setZoom(90)); // Default zoom value
    }
    
    setIsLoadingReview(true);
    setReviewError(null);
    

    try {
      // Get contour data from cell
      let contourData: any = null;
      let cellBounds: any = null;

      // Try to get contour from candidate data first
      if ((cell as any).contour && Array.isArray((cell as any).contour)) {
        contourData = (cell as any).contour;
        
        // Calculate bounds from contour coordinates
        const xs = contourData.map((p: any) => p.x);
        const ys = contourData.map((p: any) => p.y);
        cellBounds = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys)
        };
      } else {
        // Skip API call to prevent state changes that cause candidate pool refresh
        contourData = null;
        cellBounds = null;
      }

      // Get slide image and position viewer to cell
      // Use forceZoom to calculate patch size directly (bypasses Redux state race condition)
      const patchSize = forceZoom ? calculatePatchSizeFromZoom(forceZoom) : undefined;
      await fetchAndPositionCell(cell, contourData, cellBounds, patchSize);

    } catch (error: any) {
      setReviewError(getErrorMessage(error, 'Failed to show nuclei'));
      setIsLoadingReview(false);
    }
  };

  // Variable patch size calculation based on zoom level
  const calculatePatchSizeFromZoom = (zoomValue: number): number => {
    // Formula: patchsize = (102-zoomval)*30
    // Range: zoomval 1-100, initial 90
    // Results: 60px (zoomval=100) to 3030px (zoomval=1), initial 360px (zoomval=90)
    const normalizedZoom = Math.max(1, Math.min(100, zoomValue));
    const patchSize = (102 - normalizedZoom) * 30;
    
    return patchSize;
  };
  



  // Fetch and display cell patch with variable size
  const fetchAndPositionCell = async (
    cell: typeof selectedCell, 
    contourData: any, 
    cellBounds: any,
    customPatchSize?: number, // Allow custom patch size for zoom changes
    forceContourType?: string | null, // Allow overriding contour type
  ) => {
    if (!cell) {
      return;
    }

    // Use custom patch size if provided (from slider), otherwise calculate from current zoom
    const currentZoom = reviewState?.zoom || 90; // Default zoom value
    const currentPatchSize = customPatchSize || calculatePatchSizeFromZoom(currentZoom);

    setIsLoadingReview(true);

    try {
      // Call backend API to get cell patch with variable size
      const requestPayload: any = {
        slide_id: cell.slideId,
        cell_id: cell.cellId,
        centroid: cell.centroid,
        window_size_px: currentPatchSize,  // Variable patch size
        return_contour: true,
        contour_type: forceContourType !== undefined ? forceContourType : (showContour ? 'polygon' : null)  // Contour display type
      };
      
      // Priority: cell's fixedZLayer (from candidate click) > reviewFixedZLayer (from selector)
      // This ensures newly selected cells use their own z-layer state immediately
      let effectiveZLayer = (cell as any).fixedZLayer;
      if (effectiveZLayer === undefined) {
        // Only use reviewFixedZLayer if cell doesn't have its own fixedZLayer
        effectiveZLayer = reviewFixedZLayer;
      }
      if (effectiveZLayer !== undefined && effectiveZLayer !== null) {
        requestPayload.fixed_z_layer = effectiveZLayer;
        console.log('[fetchAndPositionCell] Using fixed z-layer:', effectiveZLayer);
      }
      
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/nuclei_classification/cell_review_tile`, {
        method: 'POST',
        body: JSON.stringify(requestPayload),
        returnAxiosFormat: true,
      });


      // Handle API response format (cell patch data)  
      let patchImage: string;
      let patchData: any;
      
      const patchBody = response.data as Record<string, any>;
      patchData = patchBody?.image != null ? patchBody : patchBody?.data;
      if (patchData?.image) {
        
        // Create image URL from base64 data
        patchImage = patchData.image;
        
        // Check if the image data already has the data URL prefix
        if (!patchImage.startsWith('data:image/')) {
          patchImage = `data:image/jpeg;base64,${patchImage}`;
        }
        
        

        // Set up review data with cell patch (NO OpenSeadragon positioning needed)
        setReviewData({
          image: patchImage,
          bounds: patchData.bounds,
          centroid: patchData.centroid,
          contour: patchData.contour,
          pixel_spacing_um: patchData.pixel_spacing_um,
          fov_um: patchData.fov_um,
          targetCell: {
            centroid: patchData.centroid,
            cellId: cell.cellId,
            isPatch: true  // Mark this as patch display (not full slide)
          } as any
        });

        // Store contour data separately
        if (patchData.contour) {
          setContourData({
            contour: patchData.contour,
            bounds: patchData.bounds
          });
        }
        
        // Cache cell data for slider zoom functionality
        setCachedCellData({
          slide: cell.slideId,
          cellId: cell.cellId,
          centroid: cell.centroid,
          contour: patchData.contour,
          bounds: patchData.bounds
        });
        
      } else {
        throw new Error(
          (response.data as { message?: string })?.message || 'Failed to get cell patch'
        );
      }

      
      setIsLoadingReview(false);
      
      // Force open Review Modal for immediate viewing
      setShowReviewModal(true);

    } catch (error: any) {
      setReviewError(getErrorMessage(error, 'Failed to fetch and position cell'));
      setIsLoadingReview(false);
    }
  };


  // Store contour data separately to avoid conflicts
  const [contourData, setContourData] = useState<{
    contour?: { x: number; y: number }[];
    bounds?: { x: number; y: number; w: number; h: number };
  } | null>(null);

  // Fetch contour data using original API (separate from main image)
  const fetchCellReviewData = async (cell: typeof selectedCell, magnification?: number, overrideZLayer?: number | null, overrideShowContour?: boolean) => {
    if (!cell) return;
    
    const currentMagnification = magnification ?? 40; 
    
    try {
      // Validate cell data before making request
      if (!cell.cellId || !cell.centroid || typeof cell.centroid.x !== 'number' || typeof cell.centroid.y !== 'number') {
        throw new Error('Invalid cell data: missing cellId or centroid coordinates');
      }

      // Normalize the slide path for the backend
      const normalizedSlideId = cell.slideId.replace(/\\/g, '/');
      
      // Use current patch size from zoom state to avoid size changes
      const currentZoom = reviewState?.zoom || 90;
      const currentPatchSize = calculatePatchSizeFromZoom(currentZoom);
      
      // Use overrideShowContour if provided, otherwise use current state
      const effectiveShowContour = overrideShowContour !== undefined ? overrideShowContour : showContour;
      
      const requestPayload: any = {
        slide_id: normalizedSlideId,
        cell_id: cell.cellId,
        centroid: cell.centroid,
        window_size_px: currentPatchSize,  // Use current patch size
        padding_ratio: 0.2,
        magnification: currentMagnification,
        return_contour: true,
        contour_type: effectiveShowContour ? 'polygon' : null  // Pass contour display preference
      };
      
      // Use overrideZLayer if provided, otherwise prioritize cell's fixedZLayer > reviewFixedZLayer
      let effectiveZLayer;
      if (overrideZLayer !== undefined) {
        effectiveZLayer = overrideZLayer;
      } else {
        // Priority: cell's fixedZLayer (from candidate) > reviewFixedZLayer (from selector)
        effectiveZLayer = (cell as any).fixedZLayer;
        if (effectiveZLayer === undefined) {
          effectiveZLayer = reviewFixedZLayer;
        }
      }
      if (effectiveZLayer !== undefined && effectiveZLayer !== null) {
        requestPayload.fixed_z_layer = effectiveZLayer;
        console.log('[Review Panel] Using fixed z-layer:', effectiveZLayer);
      } else {
        console.log('[Review Panel] No fixed z-layer, will use GIF if available');
      }
      
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/nuclei_classification/cell_review_tile`, {
        method: 'POST',
        body: JSON.stringify(requestPayload),
        returnAxiosFormat: true,
      });
      
      
      const d = response.data as Record<string, any>;

      // Classification fields may sit on unwrapped body or under .data
      let cellClassificationData: any = null;
      if (d?.data && (d.data.predicted_class != null || d.data.probs || d.data.label)) {
        cellClassificationData = d.data;
      } else if (d?.predicted_class != null || d?.probs || d?.label) {
        cellClassificationData = d;
      }
      if (
        cellClassificationData?.predicted_class ||
        cellClassificationData?.probs ||
        cellClassificationData?.label
      ) {
        setSelectedCell(prev =>
          prev
            ? {
                ...prev,
                predicted_class: cellClassificationData.predicted_class,
                probs: cellClassificationData.probs,
                label: cellClassificationData.label,
              }
            : null
        );
      }

      if (response.status === 200) {
        if (d?.success && d?.data) {
          setReviewData(d.data as any);
        } else if (d?.image) {
          setReviewData(d as any);
        } else if (d?.data?.image) {
          setReviewData(d.data as any);
        } else {
          const errorMsg =
            d?.message || d?.error || 'Unknown error occurred while fetching cell data';
          setReviewError(errorMsg);
        }
      } else {
        const errorMsg = d?.error || `HTTP ${response.status} error`;
        setReviewError(errorMsg);
      }

    } catch (error: any) {
      setContourData(null);
    }
  };

  // Keep the old function for backward compatibility if needed
  // Fetch full slide image for Target Cell with 100x zoom positioning
  const fetchTargetCellImage = async (cell: typeof selectedCell) => {
    if (!cell) return;
    
    setIsLoadingReview(true);
    setReviewError(null);
    
    try {
      // Validate cell data
      if (!cell.cellId || !cell.centroid || typeof cell.centroid.x !== 'number' || typeof cell.centroid.y !== 'number') {
        throw new Error('Invalid cell data: missing cellId or centroid coordinates');
      }

      const normalizedSlideId = cell.slideId.replace(/\\/g, '/');
      
      
      // Get the high resolution slide image - handle binary response
      const url = `${AI_SERVICE_API_ENDPOINT}/load/v1/slide/preview_by_path?file_path=${encodeURIComponent(normalizedSlideId)}&preview_type=thumbnail&size=12288`;
      const res = await apiFetch(url, {
        method: 'GET',
        isReturnResponse: true,
      });
      
      if (!res.ok) {
        throw new Error(`API returned status ${res.status}`);
      }
      
      const arrayBuffer = await res.arrayBuffer();
      const response = {
        status: res.status,
        headers: res.headers,
        data: arrayBuffer,
      };
      
      // Check if we got binary image data
      const contentType = response.headers.get('content-type') || '';
      
      let slideImage = null;
      let imageWidth = 12288;
      let imageHeight = 12288;
      
      if (contentType.includes('image/') || response.data.byteLength > 10000) {
        // We got binary image data - convert to base64
        
        // Convert ArrayBuffer to base64
        const uint8Array = new Uint8Array(response.data);
        // Use Unicode-safe base64 encoding for bytes
        const { bytesToBase64 } = await import('@/utils/string.utils');
        const base64 = bytesToBase64(uint8Array);
        
        // Determine image format from content type or first bytes
        let mimeType = 'image/jpeg';
        if (contentType.includes('image/png')) {
          mimeType = 'image/png';
        } else if (contentType.includes('image/gif')) {
          mimeType = 'image/gif';
        } else if (contentType.includes('image/webp')) {
          mimeType = 'image/webp';
        }
        
        slideImage = `data:${mimeType};base64,${base64}`;
        
      } else {
        // Try to parse as JSON (fallback)
        try {
          const textData = new TextDecoder().decode(response.data);
          const jsonData = JSON.parse(textData);
          
          if (jsonData.code !== 0) {
            throw new Error(jsonData.message || jsonData.error || 'Unknown error');
          }
          
          const previewData = jsonData.data;
          if (previewData && previewData.thumbnail) {
            slideImage = previewData.thumbnail;
            imageWidth = previewData.width || previewData.image_width || 12288;
            imageHeight = previewData.height || previewData.image_height || 12288;
          }
        } catch (parseError) {
          throw new Error('Invalid response format - not binary image or valid JSON');
        }
      }
      
      if (!slideImage) {
        throw new Error('No slide image found in API response');
      }
      
      
      // Try to get contour data and slide metadata for the cell
      let contourData = null;
      let slideDimensions = { width: 395600, height: 389312 }; // fallback
      
      try {
        // Prepare request payload with optional fixed_z_layer
        const payload: any = {
          slide_id: normalizedSlideId,
          cell_id: cell.cellId,
          centroid: cell.centroid,
          window_size_px: 512,
          padding_ratio: 0.2, // Match backend default for consistent crop bounds
          return_contour: true
        };
        
        // Priority: cell's fixedZLayer (from candidate) > reviewFixedZLayer (from selector)
        let effectiveZLayer = (cell as any).fixedZLayer;
        if (effectiveZLayer === undefined) {
          effectiveZLayer = reviewFixedZLayer;
        }
        if (effectiveZLayer !== undefined && effectiveZLayer !== null) {
          payload.fixed_z_layer = effectiveZLayer;
          console.log('[fetchTargetCellImage] Using fixed z-layer:', effectiveZLayer);
        }
        
        const contourResponse = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/nuclei_classification/cell_review_tile`, {
          method: 'POST',
          body: JSON.stringify(payload),
          returnAxiosFormat: true,
        });
        
        const contourBody = contourResponse.data as Record<string, any>;
        const contourPayload = contourBody?.data ?? contourBody;
        if (contourPayload?.debug_crop_info) {
          // Store debug info for logging (optional)
        }

        if (contourPayload?.contour) {
          contourData = contourPayload.contour;
        }
        if (contourPayload?.slide_width && contourPayload?.slide_height) {
          slideDimensions = {
            width: contourPayload.slide_width,
            height: contourPayload.slide_height,
          };
        }
      } catch (contourError) {
      }

      // Create data structure compatible with OpenSeadragon using actual image dimensions
      const data = {
        image: slideImage,  // Full slide image as base64
        bounds: { x: 0, y: 0, w: imageWidth, h: imageHeight },  // Use actual image dimensions
        contour: contourData,  // Add contour data if available
        targetCell: {
          centroid: cell.centroid,
          cellId: cell.cellId,
          isFullImage: true,  // This is the full slide image
          isLargeContext: false,
          tileSource: {
            width: slideDimensions.width,  // Original slide width from API or fallback
            height: slideDimensions.height  // Original slide height from API or fallback
          }
        }
       };
       
       setReviewData(data);
       
     } catch (error: any) {
       if (error.response) {
        setReviewError(getErrorMessage(error, 'Failed to load cell data'));
       } else if (error.request) {
        setReviewError('No response from server - check network connection');
      } else {
        setReviewError(getErrorMessage(error, 'Failed to load cell data'));
      }
      
      // NO FALLBACK - we want to see the full slide image or show error
    } finally {
      setIsLoadingReview(false);
    }
  };

  // Define extended cell type for internal use
  interface ExtendedCell {
    cellId: string;
    centroid: { x: number; y: number };
    slideId: string;
    label?: string;
    predicted_class?: string;
    probs?: Record<string, number>;
  }

  // Try to get cell classification from Redux annotations
  const getCellClassFromAnnotations = (cellId: string) => {
    const annotation = annotations.find((ann: any) => ann.id === cellId);
    if (annotation) {
      // Check if annotation has classification info
      const body = annotation.bodies?.[0];
      if (body?.classification || body?.predicted_class || body?.label) {
        return body.classification || body.predicted_class || body.label;
      }
    }
    return null;
  };

  // Infer target class from selected cell
  const inferTargetClass = (cell: typeof selectedCell | ExtendedCell | any) => {
    if (!cell) return null;
    
    
    // Priority 1: Use explicit label if available
    if (cell.label) return cell.label;
    
    // Priority 2: Use predicted class if available  
    if (cell.predicted_class) return cell.predicted_class;
    
    // Priority 3: Get top-1 from probabilities
    if (cell.probs && typeof cell.probs === 'object') {
      const entries = Object.entries(cell.probs);
      if (entries.length > 0) {
        const top = entries.sort((a: [string, any], b: [string, any]) => (b[1] as number) - (a[1] as number))[0];
        return top ? top[0] : null;
      }
    }

    // Priority 4: Try to get from Redux annotations
    if (cell.cellId) {
      const classFromAnnotations = getCellClassFromAnnotations(cell.cellId);
      if (classFromAnnotations) {
        return classFromAnnotations;
      }
    }
    
    // Fallback: Use negative control as default since most cells are negative
    if (nucleiClasses && nucleiClasses.length > 0) {
      const negativeClass = nucleiClasses.find(cls => cls.name === 'Negative control');
      if (negativeClass) {
        return negativeClass.name;
      }
      // If no negative control, use first available class
      const firstClass = nucleiClasses[0];
      return firstClass.name;
    }
    
    return null;
  };

  // Store cell data for zoom slider functionality
  const [cachedCellData, setCachedCellData] = useState<{
    slide: string;
    cellId: string;
    centroid: { x: number; y: number };
    contour: any;
    bounds: any;
  } | null>(null);

  // Handle class selection change - only auto-load if we have ROI and class
  useEffect(() => {
    if (reviewState?.selectedClass && shapeData && annotations.length > 0) {
      // When both ROI (shapeData) and class are selected, and we have annotation data, auto-load candidates
      loadCandidatesAndProbDist();
    }
  }, [reviewState?.selectedClass, reviewState?.threshold, annotations.length, loadCandidatesAndProbDist, shapeData]); // Include threshold dependency

  // Handle Review button click with guards
  const handleReviewClick = () => {
    // Check if in samples directory
    if (isPublicReadOnlyPath(currentPath ?? undefined) || isPublicReadOnlyPath(selectedFolder ?? undefined)) {
      toast.error(getRestrictedDirectoryMessage('review'));
      return;
    }
    
    // Update ROI in reviewState (use shapeData if available, otherwise null for whole slide)
    if (shapeData && (shapeData.rectangleCoords || shapeData.polygonPoints)) {
      dispatch(setROI(shapeData));
    } else {
      dispatch(setROI(null));
    }
    
    // Force fetch global totals for comparison
    fetchGlobalTotals();
    
    // Always show the review modal first
    setReviewError(null);
    setShowReviewModal(true);
    
    // Then try to load candidates and probability distribution
    loadCandidatesAndProbDist();
    
    // Note: Don't call setupTargetCellWithMainViewer here because Active Learning Panel 
    // will handle selected cells through its onSelectedCellChange callback
  };

  // Handle Yes/No classification actions
  const handleYesNoAction = async (cellId: string, action: 'yes' | 'no') => {
    try {
      // Call existing yes/no write logic - replace with your actual implementation
      await writeYesNo(cellId, action);
      
      // Optionally refresh data or update UI
      // You might want to update the cell's classification status
      
    } catch (error) {
      // Show error to user using beautiful web notification
      console.error('Failed to save classification:', error);
      const errorMessage = getErrorMessage(error, 'Unable to save the classification result.');
      const errorDiv = document.createElement('div');
      errorDiv.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: hsl(var(--destructive) / 0.1);
        border: 1.5px solid hsl(var(--destructive));
        color: hsl(var(--destructive));
        padding: 20px;
        border-radius: 4px;
        z-index: 10000;
        font-family: var(--font-inter), 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        font-size: 16px;
        line-height: 1.4;
        max-width: 400px;
        min-width: 320px;
                      box-shadow: 0 4px 12px hsl(var(--destructive) / 0.2);
        display: flex;
        align-items: center;
        gap: 16px;
        animation: slideIn 0.3s ease-out;
      `;

      // Create icon element
      const iconDiv = document.createElement('div');
      iconDiv.style.cssText = `
        font-size: 24px;
        flex-shrink: 0;
      `;
      iconDiv.textContent = '❌';

      // Create text element
      const textDiv = document.createElement('div');
      textDiv.style.cssText = `
        flex: 1;
      `;
      textDiv.innerHTML = `<div>${errorMessage}</div>`;

      errorDiv.appendChild(iconDiv);
      errorDiv.appendChild(textDiv);
      document.body.appendChild(errorDiv);
      setTimeout(() => errorDiv.remove(), 3000);
    }
  };

  // Helper function to write Yes/No classification - replace with your actual implementation
  const writeYesNo = async (cellId: string, result: 'yes' | 'no'): Promise<void> => {
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classify_cell`, {
      method: 'POST',
      body: JSON.stringify({
        file_path: formattedPath + '.zarr',
        cell_id: cellId,
        classification: result,
        class_name: reviewState?.selectedClass
      }),
      returnAxiosFormat: true,
    });
    
  };

  return (
    <div className="bg-card overflow-hidden">
      {/* Section header: title + primary actions + toggle */}
      <div>
        <ClassificationHeader
          title={_termTitle}
          titleId={_termTitleId}
          updateClassifierId={`updateClassifier-${panel.id}`}
          updateClassifierChecked={updateClassifier}
          onUpdateClassifierChange={handleUpdateClassifierChange}
          updateClassifierDisabled={!classifierResolvedForUpdate}
          updateClassifierTitle={
            selectedModelForCurrentPath
              ? "Update the selected classifier"
              : panelClassifierLoadPath
                ? "Update the classifier file loaded into this node (same path as load)"
                : "No classifier selected"
          }
          onAddClass={openAddClassModal}
          onReset={() => setShowResetModal(true)}
          newClassVariant="outline"
          resetVariant="outline"
        />
      </div>

      <div>
        <ClassifierStatusBanner
          selectedModelForCurrentPath={selectedModelForCurrentPath}
          updateClassifier={updateClassifier}
          actualClassifierPath={getContentStringValue(panel.content, "classifier_path")}
          actualSaveClassifierPath={getContentStringValue(panel.content, "save_classifier_path")}
          actualClassifierName={getContentStringValue(panel.content, "classifier_display_name")}
        />

        {/* Annotations tools - Nuclei Classification specific */}
        <div className="flex gap-1 items-center my-2">
          <Label htmlFor="annotations-tools" className="text-xs font-medium text-muted-foreground mr-1">Annotations:</Label>
          <Button
            variant="outline"
            size="icon"
            className={`h-5 w-5 rounded-[4px] border border-border ${
              currentTool === 'rectangle'
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-card'
            }`}
            onClick={() => handleToolChange('rectangle')}
            title="Rectangle tool"
          >
            <PiRectangle className="h-3 w-3" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className={`h-5 w-5 rounded-[4px] border border-border ${
              currentTool === 'polygon'
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-card'
            }`}
            onClick={() => handleToolChange('polygon')}
            title="Polygon tool"
          >
            <LiaDrawPolygonSolid className="h-3 w-3" />
          </Button>
        </div>

        {/* Class list: stacked rows with bottom border */}
        <div className="border-t border-border/40 pt-0">
          {nucleiClasses.map((cls, index) => (
            <PatchClassRow
              key={index}
              name={cls.name}
              index={index}
              count={cls.count}
              color={ensureHash(cls.color)}
              isSelected={activeManualClass !== null && 
                          activeManualClass.name === cls.name && 
                          activeManualClass.color === cls.color}
              isDeletable={cls.name !== 'Negative control'}
              onSelect={handleClassSelect}
              onEdit={editClass}
              onDelete={handleDeleteClass}
              onColorChange={(rowIndex, newColor) => {
                handleColorChange(rowIndex, newColor);
              }}
            />
          ))}
        </div>

        {/* Global totals stacked bar - Nuclei Classification specific */}
        {globalSegments && totalCells !== null && totalCells > 0 && (
          <div className="mt-3 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Cell distribution (whole slide)</span>
              <span>Total cells: {totalCells.toLocaleString()}</span>
            </div>
            <div className="w-full h-7 rounded overflow-hidden border border-foreground/40 bg-background">
              <div className="flex h-full w-full">
                {(() => {
                  const labeled = globalSegments.reduce((s, seg) => s + (seg.count || 0), 0);
                  const segments = [...globalSegments];
                  const unlabeled = Math.max(0, totalCells - labeled);
                  if (unlabeled > 0) {
                    // Use muted color for unlabeled segments, dynamically calculated from CSS variable
                    const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
                    const unlabeledColor = `hsl(${mutedColor})`;
                    segments.push({ name: 'Unlabeled', color: unlabeledColor, count: unlabeled });
                  }
                  const denom = Math.max(1, totalCells);
                  return segments
                    .filter(s => s.count > 0)
                    .map((seg, idx) => {
                      const pct = (seg.count / denom) * 100;
                      const textColor = getContrastTextColor(seg.color);
                      const hoverText = `${seg.name}: ${seg.count.toLocaleString()} (${Math.round(pct)}%)`;
                      return (
                        <div
                          key={`${seg.name}-${idx}`}
                          style={{ width: `${pct}%`, backgroundColor: seg.color }}
                          className="h-full relative shadow-[inset_0_0_4px_hsl(var(--foreground)/0.15)]"
                          title={hoverText}
                        >
                          {pct >= 8 && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center px-1 py-[1px]">
                              <span className="text-[10px] leading-3 font-medium" style={{ color: textColor }}>{formatCompact(seg.count)}</span>
                              <span className="text-[10px] leading-3" style={{ color: textColor }}>{Math.round(pct)}%</span>
                            </div>
                          )}
                        </div>
                      );
                    });
                })()}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Update/Review controls */}
      <div>
        <ClassificationFooter
          updateAfterAnnotationId="updateAfterEveryAnnotation"
          updateAfterAnnotationChecked={updateAfterEveryAnnotation}
          onUpdateAfterAnnotationChange={(checked) => dispatch(setUpdateAfterEveryAnnotation(checked === true))}
          onUpdate={handleClickUpdate}
          onReview={handleReviewClick}
          updateVariant="secondary"
          reviewVariant="default"
        />
      </div>
      
      {/* Add/Edit Class Modal */}
      <Dialog open={showModal} onOpenChange={(open) => {
        if (!open) {
          setShowModal(false);
          setEditingIndex(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingIndex !== null ? 'Edit Class' : 'Add New Class'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="cell-type-select" className="text-muted-foreground">
                Cell Type:
              </Label>
              <Select
                value={newClassName}
                onValueChange={(value) => setNewClassName(value)}
              >
                <SelectTrigger id="cell-type-select">
                  <SelectValue placeholder="Select cell type" />
                </SelectTrigger>
                <SelectContent>
                  {cellTypeOptions.map((option) => (
                    <SelectItem key={option} value={option}>{option}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-cell-type">
                Or enter custom cell type:
              </Label>
              <Textarea
                id="custom-cell-type"
                value={
                  newClassName === 'Negative control'
                    ? ''
                    : newClassName
                }
                onChange={(e) => setNewClassName(e.target.value)}
                rows={2}
                placeholder="Enter custom cell type"
                className="placeholder:text-muted-foreground/40"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="class-color">Color:</Label>
              <Input
                id="class-color"
                type="color"
                value={newClassColor}
                onChange={(e) => {
                  const existingColors = nucleiClasses.map(c => c.color);
                  // Validate and fix color if it's black or white
                  const validatedColor = validateAndFixColor(e.target.value, existingColors);
                  setNewClassColor(validatedColor);
                }}
                className="h-10 w-full cursor-pointer"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setShowModal(false);
                setEditingIndex(null);
              }}
            >
              Cancel
            </Button>
            <Button 
              onClick={handleAddClass} 
              disabled={!newClassName.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {editingIndex !== null ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Reset modal */}
      <Dialog open={showResetModal} onOpenChange={(open) => {
        if (!open) {
          setShowResetModal(false);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Reset</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            {isResetting ? (
              <div className="flex items-center gap-2 justify-center py-4">
                <InlineSpinner size={20} color="#6352a3" />
                <span className="text-sm text-muted-foreground">Resetting...</span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Are you sure you want to reset? This will delete all classification results and manual annotations from the current Zarr file. This action cannot be undone.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button 
              variant="secondary" 
              onClick={() => {
                setShowResetModal(false);
                setIsResetting(false);
              }}
              disabled={isResetting}
            >
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleReset}
              disabled={isResetting}
            >
              {isResetting ? (
                <>
                  <InlineSpinner size={16} color="#fff" className="mr-2" />
                  Resetting...
                </>
              ) : (
                'Reset'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      
      {/* Save modal */}
      <Dialog open={showSaveModal} onOpenChange={(open) => {
        if (!open) {
          setShowSaveModal(false);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save to Cloud</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="description" className="font-semibold">Description:</Label>
              <Textarea
                id="description"
                rows={3}
                placeholder="Before sync, describe your work please."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="placeholder:text-muted-foreground/40"
              />
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="is-public"
                checked={isPublic}
                onCheckedChange={(checked) => setIsPublic(checked === true)}
              />
              <Label htmlFor="is-public" className="text-sm font-normal cursor-pointer">
                I wish to make this contribution public.
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowSaveModal(false)}>
              Cancel
            </Button>
            {/* Temporarily commented out upload to cloud functionality */}
            {/* 
            <Button
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() => {
                // Add your save logic here
                setShowSaveModal(false);
              }}
            >
              Upload to cloud
            </Button>
            */}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Review Modal with Active Learning */}
      <Dialog 
        open={showReviewModal} 
        onOpenChange={async (open) => {
          if (!open) {
            setShowReviewModal(false);
            setReviewData(null);
            setShowContour(false);
            setReviewError(null);
            // Clean up Review viewer
            if (reviewViewerRef.current) {
              try {
                reviewViewerRef.current.destroy();
              } catch {}
              reviewViewerRef.current = null;
            }
            // Clear temporary class cells when closing panel
            try {
              await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/clear-temporary-cells`, {
                method: 'POST',
                body: JSON.stringify({
                  slide_id: formattedPath
                }),
                headers: getApiHeaders(),
                returnAxiosFormat: true,
              });
            } catch (error) {
              // Silent failure
            }
            // Refresh annotation counts to ensure correct display
            fetchGlobalTotals();
            // Don't clear Active Learning session here - let it persist
          }
        }}
      >
        <DialogContent className="max-w-[1200px] w-full max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Cell Review & Active Learning - {selectedCell?.cellId}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto" style={{ maxHeight: '80vh' }}>
          <div className="flex flex-col lg:flex-row gap-4">
            {/* Left side - Target cell / Review */}
            <div className="flex-shrink-0 w-full lg:w-[400px] xl:w-[500px]">
              <h5 className="mb-3 text-base sm:text-lg">Target Cell</h5>
              
              {/* Cell patch display */}
              <div className="w-full border border-border relative bg-muted/40" style={{ height: 'clamp(250px, 50vh, 380px)' }}>
                {isLoadingReview && !reviewData ? (
                  // Gray loading - only when no previous image exists
                  <div style={{ 
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center',
                    backgroundColor: 'hsl(var(--muted))'
                  }}>
                    <div className="spinner-border" role="status" style={{ width: '2rem', height: '2rem' }}>
                      <span className="visually-hidden">Loading...</span>
                    </div>
                  </div>
                ) : reviewData ? (
                  <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                    {/* Cell patch image display */}
                    <Image 
                      src={reviewData.image || '/placeholder.png'}
                      alt="Cell patch"
                      fill
                      style={{ 
                        objectFit: 'cover', // Fill container completely
                        backgroundColor: 'hsl(var(--muted))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '4px'
                      }}
                      onLoad={() => {
                        setIsLoadingReview(false);
                      }}
                      unoptimized // Disable optimization for dynamic images
                      onError={(e) => {
                        setIsLoadingReview(false);
                      }}
                    />
                    {/* Lightweight loading overlay for view size adjustment or cell switching */}
                    {(isResizingView || isLoadingReview) && (
                      <div style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.4)',
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        borderRadius: '4px',
                        zIndex: 10
                      }}>
                        <div style={{
                          color: 'white',
                          fontSize: '14px',
                          fontWeight: 500,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px'
                        }}>
                          <div className="animate-spin" style={{
                            width: '16px',
                            height: '16px',
                            border: '2px solid rgba(255,255,255,0.3)',
                            borderTopColor: 'white',
                            borderRadius: '50%'
                          }} />
                          {isResizingView ? 'Resizing...' : 'Loading...'}
                        </div>
                      </div>
                    )}
                  </div>
                ) : reviewError ? (
                  <div className="flex flex-col justify-center items-center h-full">
                    <div className="text-center">
                      <div className="text-warning mb-3">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                        </svg>
                      </div>
                      <h6 className="text-destructive">Error Loading Cell Data</h6>
                      <p className="text-muted-foreground mb-3">{reviewError}</p>
                      <Button 
                        size="sm"
                        onClick={() => selectedCell && fetchCellReviewData(selectedCell)}
                      >
                        Retry
                      </Button>
                    </div>
                  </div>
                ) : !reviewState?.selectedClass ? (
                  <div style={{ 
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center',
                    backgroundColor: 'hsl(var(--muted))'
                  }}>
                    <div className="text-center" style={{ width: '100%', padding: '20px' }}>
                      <p className="mb-2" style={{ textAlign: 'center', margin: '0 auto', fontSize: '14px', color: 'hsl(var(--foreground))', opacity: 0.8 }}>Click cells in the candidate pool on the right for detailed viewing</p>
                      <div style={{ textAlign: 'center', margin: '0 auto', fontSize: '13px', color: 'hsl(var(--foreground))', opacity: 0.7 }}>Please first select a cell type</div>
                    </div>
                  </div>
                ) : !selectedCell ? (
                  <div className="flex flex-col justify-center items-center h-full" style={{ backgroundColor: 'hsl(var(--muted))' }}>
                    <div className="text-center">
                      <div className="text-muted-foreground mb-3">
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor" opacity="0.5">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                        </svg>
                      </div>
                      <p className="text-muted-foreground">Click cells in the candidate pool on the right for detailed viewing</p>
                      <span className="text-muted-foreground text-xs">Select a candidate cell to start review</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-center items-center h-full">
                    <p className="text-muted-foreground">No image data available</p>
                  </div>
                )}
              </div>

              {/* Controls */}
              <div className="mt-2 sm:mt-3">
                {/* Patch Size Control - right side = small patch, left side = large patch */}
                <div className="mb-2 sm:mb-3">
                  <RangeInput
                    label={`View Size (Patch: ${calculatePatchSizeFromZoom(reviewState?.zoom || 90)}px)`}
                    min={1}
                    max={100}
                    step={1}
                    value={reviewState?.zoom || 90}
                    onChange={async (e) => {
                      const newZoom = parseFloat(e.target.value);
                      
                      // Update Redux state immediately for visual feedback
                      dispatch(setZoom(newZoom));
                      
                      // Show lightweight loading overlay
                      setIsResizingView(true);
                      
                      // Clear any pending debounce
                      if (viewSizeDebounceRef.current) {
                        clearTimeout(viewSizeDebounceRef.current);
                      }
                      
                      // Debounce the actual fetch - only trigger when user stops dragging
                      viewSizeDebounceRef.current = setTimeout(async () => {
                        const newPatchSize = calculatePatchSizeFromZoom(newZoom);
                        
                        // Only re-fetch if we have cached data and modal is open
                        if (cachedCellData && showReviewModal) {
                          try {
                            // Re-create the cell object from cached data
                            const cachedCell = {
                              cellId: cachedCellData.cellId,
                              slideId: cachedCellData.slide,
                              centroid: cachedCellData.centroid
                            };
                            await fetchAndPositionCell(cachedCell, cachedCellData.contour, cachedCellData.bounds, newPatchSize);
                          } catch (error) {
                            // Silently handle error
                          } finally {
                            setIsResizingView(false);
                          }
                        } else {
                          setIsResizingView(false);
                        }
                      }, 200); // 200ms debounce for smooth experience
                    }}
                    labelClassName="text-xs sm:text-sm"
                    containerClassName="mb-0"
                  />
                </div>

                <div className="mb-2 sm:mb-3">
                  <div className="flex items-center justify-between gap-2 flex-nowrap">
                     <div className="flex-shrink-0 flex items-center gap-2" style={{ whiteSpace: 'nowrap' }}>
                       <Checkbox
                         id="show-contour-review"
                         checked={showContour}
                         onCheckedChange={async (checked) => {
                           const newShowContour = checked === true;
                           setShowContour(newShowContour);
                           
                           // Re-fetch with new contour setting (pass explicit value to avoid async state issue)
                           if (selectedCell && showReviewModal) {
                             await fetchCellReviewData(selectedCell, 40, undefined, newShowContour);
                           }
                         }}
                         disabled={!selectedCell}  // Only disable if no cell is selected - contour toggle is always available
                         className="h-4 w-4"
                       />
                       <label htmlFor="show-contour-review" className="text-sm mb-0 cursor-pointer">
                         Show contour
                       </label>
                     </div>
                    
                    {/* Z-Stack layer selector - only show if cell is from z-stack */}
                    {selectedCell && selectedCell.isZStack && selectedCell.numZLayers && selectedCell.numZLayers > 1 && (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-xs font-medium whitespace-nowrap">Layer:</span>
                        <select
                          value={reviewFixedZLayer === null ? 'gif' : reviewFixedZLayer}
                          onChange={(e) => {
                            const value = e.target.value;
                            let newZLayer: number | null;
                            if (value === 'gif') {
                              newZLayer = null;
                              setReviewFixedZLayer(null);
                            } else {
                              newZLayer = parseInt(value);
                              setReviewFixedZLayer(newZLayer);
                            }
                            // Reload image with new layer (pass explicit value to avoid async state issue)
                            fetchCellReviewData(selectedCell, 40, newZLayer);
                          }}
                          className="px-2 py-1 text-xs bg-card text-primary rounded border border-primary font-medium cursor-pointer hover:bg-primary/10"
                        >
                          <option value="gif">GIF</option>
                          {Array.from({ length: selectedCell.numZLayers }, (_, i) => (
                            <option key={i} value={i}>L{i + 1}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                  {cachedCellData && (
                    <span className="text-success block mt-1 text-xs">
                      Contour available
                    </span>
                  )}
                </div>

                {/* Cell Information */}
                {selectedCell && (
                  <div className="text-xs sm:text-sm text-muted-foreground mb-2">
                    <div className="mb-1">
                      <span className="font-medium">Cell ID:</span> {selectedCell.cellId}
                      {(selectedCell as any).isPreview && (
                        <Badge variant="default" className="ml-2 text-[9px] h-auto py-0.5 px-1.5">Preview</Badge>
                      )}
                    </div>
                    <div className="mb-1">
                      <span className="font-medium">Centroid:</span> ({selectedCell.centroid.x.toFixed(1)}, {selectedCell.centroid.y.toFixed(1)})
                    </div>
                    {reviewData?.pixel_spacing_um && (
                      <div className="mb-1">
                        <span className="font-medium">Resolution:</span> {reviewData.pixel_spacing_um}μm/pixel
                      </div>
                    )}
                    {reviewData?.fov_um && (
                      <div className="mb-1">
                        <span className="font-medium">FOV:</span> ~{reviewData.fov_um.toFixed(1)} μm
                      </div>
                    )}
                    
                  </div>
                )}

                {/* Class List - moved to bottom after cell information */}
                <div className="mt-2 sm:mt-3">
                  <ClassList
                    nucleiClasses={nucleiClasses || []}
                    selectedClass={reviewState?.className || null}
                    onSelectClass={(className: string | null) => {
                      const finalSlideId = formattedPath || currentPath || 'unknown';
                      dispatch(setReviewSession({
                        slideId: finalSlideId,
                        className: className
                      }));
                    }}
                  />
                </div>

              </div>
            </div>

            {/* Right side - Active Learning Panel (omitted when caller opts out, e.g. VISTA) */}
            {!hideReviewPanel && (
            <ErrorBoundary>
              <ActiveLearningPanel
                ref={activeLearningPanelRef}
                selectedCell={selectedCell}
                isVisible={showReviewModal}
                onSelectedCellChange={(newSelectedCell) => {
                  
                  // Allow full Review Modal display (not preview mode)
                  const cellData = {
                    ...newSelectedCell,
                    isPreview: false, // Enable full Review Modal
                    isDirectClick: true // Mark as direct click for identification
                  };
                  
                  // Check if switching to a new cell
                  const isSwitchingCell = selectedCell?.cellId !== newSelectedCell.cellId;
                  
                  // Reset zoom to default when switching to a new cell
                  if (isSwitchingCell) {
                    dispatch(setZoom(90));
                  }
                  
                  setSelectedCell(cellData);
                  setPreviewCell(cellData);
                  
                  // Sync z-layer state from candidate to review panel
                  if ((newSelectedCell as any).fixedZLayer !== undefined) {
                    setReviewFixedZLayer((newSelectedCell as any).fixedZLayer);
                    console.log('[Review Panel] Synced fixedZLayer from candidate:', (newSelectedCell as any).fixedZLayer);
                  } else {
                    setReviewFixedZLayer(null);  // Reset to GIF if not specified
                  }
                  
                  // Use full setupTargetCellWithMainViewer (not preview)
                  // Pass forceZoom=90 when switching cells to avoid Redux state race condition
                  setupTargetCellWithMainViewer(cellData, isSwitchingCell ? 90 : undefined);
                }}
                onPendingCountChange={setPendingReclassificationsCount}
              />
            </ErrorBoundary>
            )}
          </div>
          </div>
          <DialogFooter>
            <Button 
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
              onClick={async () => {
              try {
                // Batch processing: submit all pending reclassifications first
                let savedCount = 0; // Track how many were just saved
                if (activeLearningPanelRef.current) {
                  const pendingCount = activeLearningPanelRef.current.getPendingReclassificationsCount();
                  if (pendingCount > 0) {
                    // Save the count before submitting (this is what was just saved)
                    savedCount = pendingCount;
                    await activeLearningPanelRef.current.submitPendingReclassifications();
                  }
                }
                
                // Call the active learning service to prepare and save reclassifications
                const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/reclassification/commit`, {
                  method: 'POST',
                  body: JSON.stringify({
                    slide_id: formattedPath
                  }),
                  headers: getApiHeaders(),
                  returnAxiosFormat: true,
                });
                
                if (response.data?.success) {
                  const saveData = response.data;
                  
                  if (saveData.count > 0) {
                    // Show success message using new design
                    const successDiv = document.createElement('div');
                    successDiv.style.cssText = `
                      position: fixed;
                      top: 50%;
                      left: 50%;
                      transform: translate(-50%, -50%);
                      background: #e8f5e9;
                      border: 1.5px solid #4caf50;
                      color: #2e7d32;
                      padding: 20px;
                      border-radius: 4px;
                      z-index: 10000;
                      font-family: var(--font-inter), 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                      font-size: 16px;
                      line-height: 1.4;
                      max-width: 400px;
                      min-width: 320px;
                      box-shadow: 0 4px 12px rgba(76, 175, 80, 0.2);
                      display: flex;
                      align-items: center;
                      gap: 16px;
                      animation: slideIn 0.3s ease-out;
                    `;

                    // Create icon element
                    const iconDiv = document.createElement('div');
                    iconDiv.style.cssText = `
                      font-size: 24px;
                      flex-shrink: 0;
                    `;
                    iconDiv.textContent = '✅';

                    // Create text element
                    const textDiv = document.createElement('div');
                    textDiv.style.cssText = `
                      flex: 1;
                    `;
                    // Use the count we saved before submitting (actual new count from this session)
                    // If savedCount is 0, fall back to new_count from API response
                    const newCount = savedCount > 0 ? savedCount : (saveData.new_count || 0);
                    const totalCount = saveData.count || 0;
                    let message = '';
                    if (newCount > 0 && totalCount > newCount) {
                      message = `Saved ${newCount} new reclassification${newCount === 1 ? '' : 's'} (total: ${totalCount})`;
                    } else if (newCount > 0) {
                      message = `Saved ${newCount} reclassification${newCount === 1 ? '' : 's'}`;
                    } else if (totalCount > 0) {
                      message = `${totalCount} reclassification${totalCount === 1 ? '' : 's'} saved`;
                    } else {
                      message = `Reclassifications saved successfully`;
                    }
                    textDiv.innerHTML = `<div><strong>Reclassifications Saved!</strong></div><div style="margin-top: 4px;">${message}</div>`;

                    // Add animation keyframes
                    if (!document.getElementById('notification-styles')) {
                      const style = document.createElement('style');
                      style.id = 'notification-styles';
                      style.textContent = `
                        @keyframes slideIn {
                          from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
                          to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                        }
                      `;
                      document.head.appendChild(style);
                    }

                    successDiv.appendChild(iconDiv);
                    successDiv.appendChild(textDiv);
                    document.body.appendChild(successDiv);
                    setTimeout(() => successDiv.remove(), 4000);
                    
                    // Trigger WebSocket path refresh to reload annotations and centroids for overlay update
                    EventBus.emit('refresh-websocket-path', { path: formattedPath.replace(/\.zarr$/, ''), forceReload: true });
                  } else {
                    // Show info message using new design
                    const infoDiv = document.createElement('div');
                    infoDiv.style.cssText = `
                      position: fixed;
                      top: 50%;
                      left: 50%;
                      transform: translate(-50%, -50%);
                      background: #e3f2fd;
                      border: 1.5px solid #2196f3;
                      color: #1565c0;
                      padding: 20px;
                      border-radius: 4px;
                      z-index: 10000;
                      font-family: var(--font-inter), 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                      font-size: 16px;
                      line-height: 1.4;
                      max-width: 400px;
                      min-width: 320px;
                      box-shadow: 0 4px 12px rgba(33, 150, 243, 0.2);
                      display: flex;
                      align-items: center;
                      gap: 16px;
                      animation: slideIn 0.3s ease-out;
                    `;

                    // Create icon element
                    const iconDiv = document.createElement('div');
                    iconDiv.style.cssText = `
                      font-size: 24px;
                      flex-shrink: 0;
                    `;
                    iconDiv.textContent = 'ℹ️';

                    // Create text element
                    const textDiv = document.createElement('div');
                    textDiv.style.cssText = `
                      flex: 1;
                    `;
                    textDiv.innerHTML = `<div><strong>No Changes to Save</strong></div><div style="margin-top: 4px;">No reclassifications were made or all cells were returned to their original classes.</div>`;

                    infoDiv.appendChild(iconDiv);
                    infoDiv.appendChild(textDiv);
                    document.body.appendChild(infoDiv);
                    setTimeout(() => infoDiv.remove(), 4000);
                  }
                } else {
                  const errorMsg =
                    (response.data as { error?: string })?.error ||
                    (response.data as { message?: string })?.message ||
                    'Unknown error';
                  // Show error message using new design
                  const errorDiv = document.createElement('div');
                  errorDiv.style.cssText = `
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: #ffebee;
                    border: 1.5px solid #f44336;
                    color: #c62828;
                    padding: 20px;
                    border-radius: 4px;
                    z-index: 10000;
                    font-family: var(--font-inter), 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                    font-size: 16px;
                    line-height: 1.4;
                    max-width: 400px;
                    min-width: 320px;
                    box-shadow: 0 4px 12px rgba(244, 67, 54, 0.2);
                    display: flex;
                    align-items: center;
                    gap: 16px;
                    animation: slideIn 0.3s ease-out;
                  `;

                  // Create icon element
                  const iconDiv = document.createElement('div');
                  iconDiv.style.cssText = `
                    font-size: 24px;
                    flex-shrink: 0;
                  `;
                  iconDiv.textContent = '❌';

                  // Create text element
                  const textDiv = document.createElement('div');
                  textDiv.style.cssText = `
                    flex: 1;
                  `;
                  textDiv.innerHTML = `<div>${errorMsg}</div>`;

                  errorDiv.appendChild(iconDiv);
                  errorDiv.appendChild(textDiv);
                  document.body.appendChild(errorDiv);
                  setTimeout(() => errorDiv.remove(), 4000);
                }
                
              } catch (error: any) {
                const errorMsg = getErrorMessage(error, 'Network error');
                // Show error message using new design
                const errorDiv = document.createElement('div');
                errorDiv.style.cssText = `
                  position: fixed;
                  top: 50%;
                  left: 50%;
                  transform: translate(-50%, -50%);
                  background: #ffeeec;
                  border: 1.5px solid #e14434;
                  color: #c62828;
                  padding: 20px;
                  border-radius: 4px;
                  z-index: 10000;
                  font-family: var(--font-inter), 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                  font-size: 16px;
                  line-height: 1.4;
                  max-width: 400px;
                  min-width: 320px;
                      box-shadow: 0 4px 12px hsl(var(--destructive) / 0.2);
                  display: flex;
                  align-items: center;
                  gap: 16px;
                  animation: slideIn 0.3s ease-out;
                `;

                // Create icon element
                const iconDiv = document.createElement('div');
                iconDiv.style.cssText = `
                  font-size: 24px;
                  flex-shrink: 0;
                `;
                iconDiv.textContent = '❌';

                // Create text element
                const textDiv = document.createElement('div');
                textDiv.style.cssText = `
                  flex: 1;
                `;
                textDiv.innerHTML = `<div><strong>Network Error</strong></div><div style="margin-top: 4px;">${errorMsg}</div>`;

                errorDiv.appendChild(iconDiv);
                errorDiv.appendChild(textDiv);
                document.body.appendChild(errorDiv);
                setTimeout(() => errorDiv.remove(), 4000);
              }
            }}
          >
            Update {pendingReclassificationsCount > 0 && `(${pendingReclassificationsCount} pending)`}
          </Button>
          <Button 
            variant="secondary" 
            onClick={async () => {
              // Auto-save all reclassifications before closing
              try {
                // Submit pending batch reclassifications first
                if (activeLearningPanelRef.current) {
                  const pendingCount = activeLearningPanelRef.current.getPendingReclassificationsCount();
                  if (pendingCount > 0) {
                    await activeLearningPanelRef.current.submitPendingReclassifications();
                  }
                }
                
                // Save all reclassifications to Zarr file
                const saveResponse = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/reclassification/commit`, {
                  method: 'POST',
                  body: JSON.stringify({
                    slide_id: formattedPath
                  }),
                  headers: getApiHeaders(),
                  returnAxiosFormat: true,
                });
                
                if (saveResponse.data?.success && saveResponse.data?.count > 0) {
                  // Silent save success, no notification
                }
              } catch (error) {
                // Silent failure, don't disturb user
              }
              
              // Close Modal
              setShowReviewModal(false);
              setReviewData(null);
              setShowContour(false);
              setReviewError(null);
              // Clean up Review viewer
              if (reviewViewerRef.current) {
                try {
                  reviewViewerRef.current.destroy();
                } catch {}
                reviewViewerRef.current = null;
              }
              // Don't clear Active Learning session here - let it persist
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>

    </div>
  );
};   
