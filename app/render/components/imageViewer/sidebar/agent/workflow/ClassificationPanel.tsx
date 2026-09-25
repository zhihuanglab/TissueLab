"use client";
import { usePathWriteAccess } from "@/hooks/usePathWriteAccess"
import { InlineSpinner } from '@/components/assets/PageLoading';
import CellReviewModal from '@/components/imageViewer/review/CellReviewModal';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AI_SERVICE_API_ENDPOINT } from "@/config/api.config";
import { useReview } from "@/hooks/review/useReview";
import { AppDispatch, RootState, store } from "@/store";
import { getErrorMessage } from "@/utils/common/apiResponse";
import { clearSelectedModelForPath, selectSelectedModelForPath } from "@/store/slices/chat/modelSelectionSlice";
import { setUpdateAfterEveryAnnotation, setUpdateClassifier } from "@/store/slices/chat/workflowSlice";
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
import { generateRandomColor, validateAndFixColor } from "@/utils/common/color.utils";
import { useRefreshGtHighlightIndices } from '@/hooks/viewer/useRefreshGtHighlightIndices';
import { apiFetch } from '@/utils/common/apiFetch'
import { segFetch } from '@/utils/common/segFetch';
import eventBus from "@/utils/common/eventBus";
import { formatPath } from "@/utils/common/path.utils";
import {
  getDefaultOutputPath,
  prepareAndStartClassificationWorkflow,
  registerNucleiClassOperationsBridge,
  normalizePendingClassOperations,
} from "@/utils/agent/workflow/workflow.utils";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiaDrawPolygonSolid } from "react-icons/lia";
import { PiRectangle } from "react-icons/pi";
import { useDispatch, useSelector } from "react-redux";
import { useActiveSlidePath } from "@/utils/viewer/slidePath";
import { toast } from "sonner";
import { cellTypeOptions } from "@/constants/workflow.constants";
import { ClassificationPanelProps } from "@/types/workflow.types";
import { restrictClassesToAnnotated } from "@/utils/annotations/nucleiClassList";
import {
  applyCytoformerClassificationInput,
  cytoformerOrganError,
  CYTOFORMER_ORGAN_LABEL,
  CYTOFORMER_ORGANS,
} from "@/utils/agent/workflow/cytoformer";
import {
  getClassifierDisplayBasename,
  getContentStringValue,
  hasClassifierLoaded,
  removeClassifierPathContent,
  upsertContentStringValue,
} from "@/utils/agent/workflow/panelContent";
import { ClassificationFooter } from "./card/ClassificationFooter";
import { ClassificationHeader } from "./card/ClassificationHeader";
import { ClassifierStatusBanner } from "./card/ClassifierStatusBanner";
import { PatchClassRow } from "./card/Patch-ClassRow";

// Timeout for waiting for handler reload complete event (in milliseconds)
const HANDLER_RELOAD_TIMEOUT_MS = 5000;
const NEGATIVE_CONTROL = "Negative control";
/** Radix Select forbids an empty item value; this stands in for "no organ". */
const NO_ORGAN = "__no_organ__";
const NEGATIVE_CONTROL_COLOR = "#aaaaaa";

export const ClassificationPanel: React.FC<ClassificationPanelProps> = ({
  panel,
  onContentChange,
  terminology = "cell",
  hideReviewPanel = false,
  graphStartWorkflow,
  classifierMode = "multiclass",
  onOvrLoadClass,
  onClearLoadedClassifier,
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

  const currentPath = useActiveSlidePath();
  const selectedFolder = useSelector((state: RootState) => state.fileManager.selectedFolder);
  const { assertWritable, allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(currentPath || selectedFolder);
  const isWebMode = useSelector((state: RootState) => {
    const activeInstanceId = state.wsi.activeInstanceId;
    const activeInstance = activeInstanceId ? state.wsi.instances[activeInstanceId] : undefined;
    const source = activeInstance?.fileInfo?.source as string | undefined;
    return source === 'web';
  });
  const activeInstanceId = useSelector((state: RootState) => state.wsi.activeInstanceId);

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

  const isCytoformer = panel.type === "CytoformerClassification";
  const cytoformerOrgan = useMemo(() => {
    const raw = getContentStringValue(panel.content, "organ");
    return raw?.trim() ?? "";
  }, [panel.content]);

  const setCytoformerOrgan = useCallback(
    (value: string) => {
      onContentChange(panel.id, {
        ...panel,
        // The registry defines organ as a `select`; mergeModelPanelDefaults puts
        // that item on every panel, so this only ever updates its value.
        content: upsertContentStringValue(
          panel.content,
          "organ",
          value === NO_ORGAN ? "" : value,
        ),
      });
    },
    [onContentChange, panel],
  );

  const isOvrMode = classifierMode === "one-vs-rest";
  // One-vs-rest: per-class attached .tlcls, stored as JSON in panel.content
  // under `classifier_paths` ({className: absolutePath}).
  const ovrClassifierPaths = useMemo<Record<string, string>>(() => {
    const v = panel.content.find(item => item.key === 'classifier_paths')?.value;
    if (typeof v === 'string' && v) {
      try { return JSON.parse(v) as Record<string, string>; } catch { return {}; }
    }
    return {};
  }, [panel.content]);

  // Remove one class's attached .tlcls (clear button on the row).
  const clearOvrClassifier = useCallback((className: string) => {
    const map = { ...ovrClassifierPaths };
    delete map[className];
    const newContent = panel.content.some(it => it.key === 'classifier_paths')
      ? panel.content.map(it => it.key === 'classifier_paths' ? { ...it, value: JSON.stringify(map) } : it)
      : [...panel.content, { key: 'classifier_paths', type: 'input', value: JSON.stringify(map) }];
    onContentChange(panel.id, { ...panel, content: newContent });
  }, [ovrClassifierPaths, panel, onContentChange]);

  // One-vs-rest: per-class TRAIN+SAVE destinations (`save_classifier_paths`),
  // assembled by the OvR Save dialog. Each configured class trains + writes on next run.
  const ovrSaveClassifierPaths = useMemo<Record<string, string>>(() => {
    const v = panel.content.find(item => item.key === 'save_classifier_paths')?.value;
    if (typeof v === 'string' && v) {
      try { return JSON.parse(v) as Record<string, string>; } catch { return {}; }
    }
    return {};
  }, [panel.content]);
  const clearOvrSaveClassifier = useCallback((className: string) => {
    const map = { ...ovrSaveClassifierPaths };
    delete map[className];
    const newContent = panel.content.some(it => it.key === 'save_classifier_paths')
      ? panel.content.map(it => it.key === 'save_classifier_paths' ? { ...it, value: JSON.stringify(map) } : it)
      : [...panel.content, { key: 'save_classifier_paths', type: 'input', value: JSON.stringify(map) }];
    onContentChange(panel.id, { ...panel, content: newContent });
  }, [ovrSaveClassifierPaths, panel, onContentChange]);

  const hasClassifierApplied = Boolean(selectedModelForCurrentPath) || Boolean(classifierLoadPath);
  
  // Get Active Learning state for target cell zoom
  const reviewState = useReview();
  // Get shape data for ROI selection
  const shapeData = useSelector((state: any) => state.shape.shapeData as any);
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
  // Ref to store cleanup function for handler reload timeout
  const handlerReloadCleanupRef = useRef<(() => void) | null>(null);
  // Ref to track previous path for cleanup on image switch
  const prevPathRef = useRef<string | null>(null);

  // Expose pending class ops to Graph-owned auto-update while this panel is mounted.
  useEffect(() => {
    registerNucleiClassOperationsBridge(
      () => ({
        renames: pendingRenameOpsRef.current,
        adds: pendingAddOpsRef.current,
      }),
      () => {
        pendingRenameOpsRef.current = [];
        pendingAddOpsRef.current = [];
      }
    );
    return () => registerNucleiClassOperationsBridge(null, null);
  }, []);
  
  
  
  // Cell review states
  const [selectedCell, setSelectedCell] = useState<{
    cellId: string;
    centroid: { x: number; y: number };
    slideId: string;
  } | null>(null);
  
  const [showReviewModal, setShowReviewModal] = useState(false);

  const [formattedPath, setFormattedPath] = useState(formatPath(currentPath ?? ""));

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
      const classResp = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/classifications?file_path=${encodeURIComponent(formattedPath)}`, { method: 'GET',  returnAxiosFormat: true });
      const classData = (classResp?.data as { data?: unknown })?.data ?? classResp?.data;
      const rawNames = classData?.class_names;
      const rawColors = classData?.class_colors;
      if (!Array.isArray(rawNames) || rawNames.length === 0) {
        return;
      }

      const manualResp = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/manual_annotation_counts?file_path=${encodeURIComponent(formattedPath)}`, { method: 'GET',  returnAxiosFormat: true });
      const manualData = (manualResp?.data as { data?: unknown })?.data ?? manualResp?.data;
      const countsMap: Record<string, number> = (manualData?.class_counts_by_id as Record<string, number>) || {};
      const negCountsMap: Record<string, number> = (manualData?.negative_class_counts_by_id as Record<string, number>) || {};

      const finalClasses: AnnotationClass[] = rawNames.map((nameVal: string, i: number) => {
        const name = typeof nameVal === 'string' ? nameVal : String(nameVal ?? '');
        const rawHex = Array.isArray(rawColors) && rawColors[i] != null ? String(rawColors[i]) : '';
        const zarrColor =
          name === NEGATIVE_CONTROL
            ? NEGATIVE_CONTROL_COLOR
            : validateAndFixColor(ensureHash(rawHex || '#808080'));
        return {
          name,
          color: zarrColor,
          count: Number(countsMap[String(i)] ?? 0),
          negativeCount: Number(negCountsMap[String(i)] ?? 0),
          persisted: true,
        };
      });

      dispatch(setNucleiClasses(finalClasses));
    } catch (e) {
      console.warn('[ClassificationPanel] Classifier mode: failed to sync classes from classifications', e);
    }
  }, [formattedPath, activeInstanceId, hasClassifierApplied, dispatch]);
  

  // Cleanup timers on component unmount
  useEffect(() => {
    const sliderTimeout = sliderDebounceRef.current;
    const debounceTimeout = debounceTimeoutId.current;
    const handlerReloadCleanup = handlerReloadCleanupRef.current;

    return () => {
      if (sliderTimeout) {
        clearTimeout(sliderTimeout);
      }
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      if (handlerReloadCleanup) {
        handlerReloadCleanup();
      }
    };
  }, []);

  // Helper functions will be defined after formattedPath declaration

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
        const response = await segFetch(activeInstanceId, urlWithParams, {
          method: 'GET',
          
          returnAxiosFormat: true,
        });
        
        
        const responseData = (response.data as { data?: unknown })?.data ?? response.data;
        
        if (responseData && responseData.matching_indices && Array.isArray(responseData.matching_indices)) {
          
          // Try to get additional cell data including classifications
          let cellsWithClassification = [];
          
          try {
            // Call classification API to get cell classifications
            const classificationResponse = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/classifications?file_path=${encodeURIComponent(formattedPath)}`, {
              method: 'GET',
              
              returnAxiosFormat: true,
            });
            
            const classData =
              (classificationResponse.data as { data?: unknown })?.data ?? classificationResponse.data;
            
            // If we have classification data, use it to enrich our cells
            if (classData && classData.class_names && classData.class_colors) {
              const classNames = classData.class_names;
              const classColors = classData.class_colors;
              
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
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/candidates/cell`, {
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

      // Clear selected cell state
      setSelectedCell(null);

      // Close review modal if open (the modal clears its own review state)
      setShowReviewModal(false);

      console.log(`[ClassificationPanel] Cell overlay state cleared successfully`);
    }

    prevPathRef.current = currentPath;
  }, [currentPath]);

  // Auto-update panel content when selected model changes in FileBrowserSidebar.
  // If a classifier is already loaded (path set, e.g. from Graph "Load
  // classifier"), the file browser does NOT silently override it.
  useEffect(() => {
    if (selectedModelForCurrentPath) {
      let modelPath;
      if (isWebMode) {
        modelPath = `${selectedFolder || ''}/${selectedModelForCurrentPath}`.replace(/\/+/g, '/');
      } else {
        modelPath = `${selectedFolder || ''}\\${selectedModelForCurrentPath}`.replace(/\\+/g, '\\');
      }

      let newContent = [...panel.content];
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

    if (hasClassifierLoaded(panel.content)) {
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
        const classesWithData = nucleiClasses.filter(cls => cls.persisted === true && cls.count > 0);
        const hasBackendClasses = classesWithData.length > 0;
        
        if (hasBackendClasses) {
          const currentClassNames = nucleiClasses.map(cls => cls.name.toLowerCase());
          const newClasses: string[] = [];
          
          promptContent.nuclei_classes.forEach((className: string) => {
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
          
          promptContent.nuclei_classes.forEach((className: string) => {
            const lowerName = className.toLowerCase();
            toKeep.add(lowerName);
            if (!currentClassNames.includes(lowerName)) {
              toAdd.push(className);
            }
          });
          
          const toRemoveIndices: number[] = [];
          nucleiClasses.forEach((cls, idx) => {
            // Negative control is index 0 of every backend palette; removing it
            // shifts every other class one slot against the overlay's class_ids.
            if (cls.name === NEGATIVE_CONTROL) return;
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
      const totalResp = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/total_counts?file_path=${encodeURIComponent(formattedPath)}`, {
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
          if (n === NEGATIVE_CONTROL) {
            return {
              name: n,
              color: NEGATIVE_CONTROL_COLOR,
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
      const manualResp = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/manual_annotation_counts?file_path=${encodeURIComponent(formattedPath)}`, {
        method: 'GET',
        
        returnAxiosFormat: true,
      });
      const manualData = manualResp?.data?.data || manualResp?.data;

      if (manualData) {
        const manualNames: string[] = (manualData.dynamic_class_names || []) as string[];
        const manualCountsMap: Record<string, number> = manualData.class_counts_by_id || {};
        const manualNegCountsMap: Record<string, number> = manualData.negative_class_counts_by_id || {};

        // Get current nucleiClasses from Redux store to avoid stale closure
        const state = store.getState();
        const currentNucleiClasses = state.annotations.nucleiClasses as AnnotationClass[];

        // Update nucleiClasses with manual annotation counts only
        // Only update if counts actually changed to avoid unnecessary re-renders
        const updatedNucleiClasses = currentNucleiClasses.map(cls => {
          const classIndex = manualNames.indexOf(cls.name);
          const newCount = classIndex >= 0 ? manualCountsMap[String(classIndex)] || 0 : 0;
          const newNegCount = classIndex >= 0 ? manualNegCountsMap[String(classIndex)] || 0 : 0;
          if (cls.count !== newCount || (cls.negativeCount ?? 0) !== newNegCount) {
            return { ...cls, count: newCount, negativeCount: newNegCount };
          }
          return cls; // Return same object if no change
        });

        // Only dispatch if something actually changed
        const hasChanges = updatedNucleiClasses.some((updated, index) =>
          updated !== currentNucleiClasses[index]
        );
        
        if (hasChanges) {
          dispatch(setNucleiClasses(updatedNucleiClasses));
        }
      }

    } catch (e) {
      console.error('Error fetching counts:', e);
    }
  }, [formattedPath, dispatch]); // Don't include nucleiClasses to avoid infinite loop

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

    eventBus.on('refresh-annotations', refreshHandler);
    // Also listen to refresh-websocket-path for workflow completion
    eventBus.on('refresh-websocket-path', refreshHandler);

    return () => {
      clearTimeout(debounceTimer);
      eventBus.off('refresh-annotations', refreshHandler);
      eventBus.off('refresh-websocket-path', refreshHandler);
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
  const getZarrPath = (): string | null => {
    const p = getDefaultOutputPath(formattedPath);
    return p || null;
  };

  const performDelete = async (index: number, className: string, reassignTo = NEGATIVE_CONTROL) => {
    const zarrPath = getZarrPath();
    if (!zarrPath) return;
    await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/delete-class`, {
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
    eventBus.emit('refresh-annotations');
    eventBus.emit('refresh-websocket-path', { path: zarrPath, forceReload: true });
  };

  const handleDeleteClass = async (index: number) => {
    if (!assertWritable('delete a classification')) {
      return;
    }
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
    await performDelete(index, cls.name, NEGATIVE_CONTROL);
  };
  
  // Reset function
  const handleReset = async () => {
    if (!assertWritable('reset classification')) {
      setShowResetModal(false);
      return;
    }
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
          // Reset deletes Cell-Classification and User-Annotations/cell outright,
          // so every class that came OUT of the store is now backing nothing. Drop
          // those (`persisted`) and keep Negative control plus anything the user
          // added locally, which was never in the file to begin with.
          //
          // Zeroing the counts and keeping the names is not enough: a zero-shot run
          // writes the ORGAN's cell types into this list, and the /classifications
          // refetch below cannot correct it — after the reset that endpoint 404s.
          // The preset would sit there until the next run picked it up.
          const cleared = nucleiClasses
            .filter(cls => cls.name === NEGATIVE_CONTROL || cls.persisted === false)
            .map(cls => ({ ...cls, count: 0, negativeCount: 0 }));
          dispatch(setNucleiClasses(
            cleared.some(cls => cls.name === NEGATIVE_CONTROL)
              ? cleared
              : [{ name: NEGATIVE_CONTROL, color: NEGATIVE_CONTROL_COLOR, count: 0, negativeCount: 0 }, ...cleared]
          ));
          dispatch(setAnnotations([]));
          dispatch(clearAnnotationTypes());

          // Emit websocket refresh first to trigger handler reload
          eventBus.emit("refresh-websocket-path", { path: outputPath, forceReload: true });

          // Helper function to fetch statistics after handler reload complete
          const fetchStatisticsAfterReset = async () => {
            try {
              // Get class names and colors from classifications endpoint
              const classResp = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/classifications?file_path=${encodeURIComponent(formattedPath)}`, {
                method: 'GET',
                
                returnAxiosFormat: true,
              });
              const classData = classResp?.data;
              
              // BUG FIX: Use manual_annotation_counts instead of total_counts
              // to be consistent with fetchGlobalTotals and avoid "two counting logic fighting"
              const manualResp = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/manual_annotation_counts?file_path=${encodeURIComponent(formattedPath)}`, {
                method: 'GET',
                
                returnAxiosFormat: true,
              });
              const manualData = manualResp?.data?.data || manualResp?.data;

              // Absent after a reset — the group is gone and the endpoint 404s,
              // so the zeroed list above stands. Not a silent failure.
              if (classData && classData.class_names && classData.class_colors) {
                const countsMap: Record<string, number> = manualData?.class_counts_by_id || {};
                const negCountsMap: Record<string, number> = manualData?.negative_class_counts_by_id || {};
                const finalClasses = classData.class_names.map((rawName: string, i: number) => {
                  const name = typeof rawName === 'string' ? rawName : String(rawName ?? '');
                  const color = name === NEGATIVE_CONTROL
                    ? NEGATIVE_CONTROL_COLOR
                    : (classData.class_colors[i] || NEGATIVE_CONTROL_COLOR);
                  return {
                    name,
                    color,
                    count: countsMap[String(i)] || 0, // Get count from manual_annotation_counts
                    negativeCount: negCountsMap[String(i)] || 0,
                    persisted: true,
                  };
                });
                dispatch(setNucleiClasses(finalClasses));
              }
            } catch (e) {
              console.warn("Failed to fetch classifications after reset:", e);
            }
          };

          // Wait for handler-reload-complete (event-driven); timeout is only a fallback.
          if (handlerReloadCleanupRef.current) {
            handlerReloadCleanupRef.current();
            handlerReloadCleanupRef.current = null;
          }

          let timeout: ReturnType<typeof setTimeout> | null = null;
          let handler: ((eventData: { path?: string }) => void) | null = null;

          const cleanup = () => {
            if (timeout) {
              clearTimeout(timeout);
              timeout = null;
            }
            if (handler) {
              eventBus.off('handler-reload-complete', handler);
              handler = null;
            }
          };

          handlerReloadCleanupRef.current = cleanup;

          timeout = setTimeout(() => {
            cleanup();
            handlerReloadCleanupRef.current = null;
            setIsResetting(false);
            console.warn("Timeout waiting for handler reload complete, fetching statistics anyway");
            fetchStatisticsAfterReset();
            refreshGtHighlightIndices(currentPath);
          }, HANDLER_RELOAD_TIMEOUT_MS);

          handler = (eventData: { path?: string }) => {
            const eventPath = eventData?.path?.replace(/\.(zarr)$/i, '') || '';
            const targetPath = outputPath.replace(/\.(zarr)$/i, '');

            if (!eventData.path || eventPath === targetPath) {
              cleanup();
              handlerReloadCleanupRef.current = null;
              setIsResetting(false);
              fetchStatisticsAfterReset();
              refreshGtHighlightIndices(currentPath);
            }
          };

          eventBus.on('handler-reload-complete', handler);

      } else {
        setIsResetting(false);
      }
    } catch (error) {
      setIsResetting(false);
    } finally {
        setShowResetModal(false);
    }
  };
  
  // Update function — memoized so callers (footer button) stay stable across renders.
  // Auto-update after annotation is owned by WorkflowGraph (trigger-nuclei-update),
  // so it still runs when this panel is not mounted.
  const handleClickUpdate = useCallback(async () => {
    if (store.getState().workflow.isRunning) {
      toast.message("A workflow is already running. Wait for it to finish, or stop it first.");
      return;
    }
    // Check if in samples directory
    if (!assertWritable('update panel')) {
      return;
    }

    const outputPath = getDefaultOutputPath(formattedPath);
    if (!outputPath) {
      toast.warning("No slide path resolved.");
      return;
    }
    const organValue = panel.content.find(item => item.key === "organ")?.value ?? "";

    // Use paths from panel.content (they are synced with FileBrowserSidebar).
    // The previous `classifier_display_name === ""` short-circuit caused real path
    // values to be discarded right when the user clicked Save — display_name is
    // only a UI label, not a source of truth.
    let finalLoadPath = getContentStringValue(panel.content, "classifier_path");
    let finalSavePath = getContentStringValue(panel.content, "save_classifier_path");

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

    const classOperations = normalizePendingClassOperations({
      renames: pendingRenameOpsRef.current,
      adds: pendingAddOpsRef.current,
    });

    // One-vs-rest. SAVE paths are still auto-derived from the single save base
    // path (dirname + sanitized class name) — training writes one binary per
    // class there. LOAD paths, however, are the per-class .tlcls the user
    // explicitly attached on each cell-type row (ovrClassifierPaths); classes
    // with nothing attached are simply omitted (→ no classifier → the tasknode
    // falls back to zero-shot for them). Negative control is never an OvR target.
    const isOvr = classifierMode === "one-vs-rest";
    const deriveOvrPaths = (basePath: string | null): Record<string, string> | undefined => {
      if (!basePath) return undefined;
      const norm = basePath.replace(/\\/g, "/");
      const dir = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
      const out: Record<string, string> = {};
      for (const c of nucleiClasses) {
        if (c.name.trim().toLowerCase() === "negative control") continue;
        const safe = c.name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").slice(0, 120) || "class";
        out[c.name] = dir ? `${dir}/${safe}.tlcls` : `${safe}.tlcls`;
      }
      return Object.keys(out).length ? out : undefined;
    };
    // Prefer an explicit scoped map written by the One-vs-Rest Save dialog (train
    // only the classes the user chose); otherwise derive one path per class.
    const explicitOvrSavePaths = (() => {
      const v = panel.content.find(it => it.key === 'save_classifier_paths')?.value;
      if (typeof v === 'string' && v) {
        try { const o = JSON.parse(v); if (o && typeof o === 'object' && Object.keys(o).length) return o as Record<string, string>; } catch { /* ignore */ }
      }
      return undefined;
    })();
    const ovrSavePaths = isOvr ? (explicitOvrSavePaths ?? deriveOvrPaths(finalSavePath)) : undefined;
    // Explicit per-class attachments (skip Negative control / blank paths).
    const ovrLoadPaths = isOvr
      ? (() => {
          const out: Record<string, string> = {};
          for (const [name, p] of Object.entries(ovrClassifierPaths)) {
            if (!p || name.trim().toLowerCase() === "negative control") continue;
            out[name] = p;
          }
          return Object.keys(out).length ? out : undefined;
        })()
      : undefined;

    const input: Record<string, unknown> = {
      nuclei_classes: nucleiClasses.map(cls => cls.name),
      nuclei_colors: nucleiClasses.map(cls => cls.color),
      organ: organValue,
      classifier_path: finalLoadPath,
      save_classifier_path: finalSavePath,
      classifier_mode: classifierMode,
      ...(ovrSavePaths ? { save_classifier_paths: ovrSavePaths } : {}),
      ...(ovrLoadPaths ? { classifier_paths: ovrLoadPaths } : {}),
      ...(classOperations ? { class_operations: classOperations } : {}),
    };
    const nodeId = (panel.type || "NuClass").trim() || "NuClass";
    if (isCytoformer) {
      // Class counts come from manual_annotation_counts, so this matches the
      // tasknode's own has_annotations check — and what the rows on screen show.
      // "not this type" marks count as annotations for the tasknode, so a slide
      // carrying only those is supervised too and must not demand an organ.
      const hasAnnotations = nucleiClasses.some(
        (cls) => (cls.count ?? 0) > 0 || (cls.negativeCount ?? 0) > 0,
      );
      // An attached classifier is a supervised run too — the tasknode branches
      // on CLASSIFIER_PATH alone, and the organ only ever feeds the zero-shot
      // head. In one-vs-rest every target class has to be covered: a class with
      // no classifier still falls back to zero-shot, which does need the organ.
      const ovrTargets = nucleiClasses.filter(
        (cls) => cls.name.trim().toLowerCase() !== "negative control",
      );
      const hasClassifier = isOvr
        ? ovrTargets.length > 0 && ovrTargets.every((cls) => Boolean(ovrLoadPaths?.[cls.name]))
        : Boolean(finalLoadPath);
      const organError = cytoformerOrganError(
        organValue,
        hasAnnotations || hasClassifier,
      );
      if (organError) {
        toast.error(organError);
        return;
      }
      applyCytoformerClassificationInput(input as Record<string, any>, panel);
    }
    // Both models — see buildStartWorkflowPayload.
    restrictClassesToAnnotated(input as Record<string, any>, nucleiClasses);

    const workflowPayload = {
      zarr_path: outputPath,
      step1: {
        nodeId,
        input,
      }
    };

    if (!graphStartWorkflow) {
      toast.error("Workflow starter is unavailable. Open this panel from the workflow graph.");
      return;
    }

    try {
      await prepareAndStartClassificationWorkflow({
        dispatch,
        startWorkflow: graphStartWorkflow,
        payload: workflowPayload as Record<string, unknown>,
        refreshTissuePatches: false,
        trackChatGenerating: true,
      });
      pendingRenameOpsRef.current = [];
      pendingAddOpsRef.current = [];
    } catch {
      // prepareAndStartClassificationWorkflow already resets running/hints/chat flags
    }
  }, [
    currentPath,
    selectedFolder,
    formattedPath,
    panel.content,
    updateClassifier,
    selectedModelForCurrentPath,
    nucleiClasses,
    classifierMode,
    ovrClassifierPaths,
    graphStartWorkflow,
    dispatch,
    panel,
  ]);

  const handleClassSelect = (index: number) => {
    const selectedClass = nucleiClasses[index];
    if (activeManualClass && activeManualClass.name === selectedClass.name && activeManualClass.color === selectedClass.color) {
      dispatch(setActiveManualClassificationClass(null));
    } else {
      dispatch(setActiveManualClassificationClass(selectedClass));
    }
  };

  // Clear the "Selected Classifier" banner: drop classifier_* keys from the
  // panel content AND clear the FileBrowser-side Redux selection for the same
  // path the selector above reads from.
  const handleClassifierClear = useCallback(() => {
    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }
    dispatch(clearSelectedModelForPath(targetPath));
    // "Updating Classifier" targets the selected one, so it goes with it:
    // otherwise the checkbox stays ticked with nothing to update, and the next
    // classifier picked silently lands in update mode.
    dispatch(setUpdateClassifier(false));
    const stripped = removeClassifierPathContent(panel.content).filter(
      (item) => item.key !== "classifier_display_name"
    );
    onContentChange(panel.id, { ...panel, content: stripped });
    // The graph node keeps its own copy (node.loadedClassifier) that feeds the
    // dock's "Loaded: …" chip — clear it too or the chip outlives the banner.
    onClearLoadedClassifier?.();
  }, [dispatch, selectedFolder, currentPath, isWebMode, panel, onContentChange, onClearLoadedClassifier]);

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

  // Rename only the request path shown in the status banner (classifier_path /
  // save_classifier_path) — does NOT rename the on-disk .tlcls file. Keeps the
  // original directory + extension and swaps the basename.
  const renamePathBasename = (oldPath: string, newName: string): string => {
    const sep = oldPath.includes("\\") ? "\\" : "/";
    const idx = oldPath.lastIndexOf(sep);
    const dir = idx >= 0 ? oldPath.slice(0, idx + 1) : "";
    const stem = newName.replace(/\.tlcls$/i, "").trim();
    return `${dir}${stem}.tlcls`;
  };
  const handleClassifierRename = (newName: string) => {
    const old = getContentStringValue(panel.content, "classifier_path");
    if (!old || !newName.trim()) return;
    handlePathChange("load", renamePathBasename(old, newName));
  };
  const handleSaveClassifierRename = (newName: string) => {
    const old = getContentStringValue(panel.content, "save_classifier_path");
    if (!old || !newName.trim()) return;
    handlePathChange("save", renamePathBasename(old, newName));
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
    const targetClass = nucleiClasses[index];
    if (targetClass && targetClass.name === NEGATIVE_CONTROL) {
      return;
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
          // Reset zoom to default when switching cells
          dispatch(setZoom(90));
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

  // Handle class selection change - only auto-load if we have ROI and class
  useEffect(() => {
    if (reviewState?.selectedClass && shapeData && annotations.length > 0) {
      // When both ROI (shapeData) and class are selected, and we have annotation data, auto-load candidates
      loadCandidatesAndProbDist();
    }
  }, [reviewState?.selectedClass, reviewState?.threshold, annotations.length, loadCandidatesAndProbDist, shapeData]); // Include threshold dependency

  // Handle Review button click with guards
  const handleReviewClick = () => {
    // Update ROI in reviewState (use shapeData if available, otherwise null for whole slide)
    if (shapeData && (shapeData.rectangleCoords || shapeData.polygonPoints)) {
      dispatch(setROI(shapeData));
    } else {
      dispatch(setROI(null));
    }
    
    // Force fetch global totals for comparison
    fetchGlobalTotals();
    
    // Always show the review modal first
    setShowReviewModal(true);
    
    // Then try to load candidates and probability distribution
    loadCandidatesAndProbDist();

    // Cell setup happens inside CellReviewModal — its Active Learning panel
    // fires onSelectedCellChange when a candidate is clicked.
  };

  // Helper function to write Yes/No classification - replace with your actual implementation
  const writeYesNo = async (cellId: string, result: 'yes' | 'no'): Promise<void> => {
    const response = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/classify_cell`, {
      method: 'POST',
      
      body: JSON.stringify({
        file_path: getZarrPath(),
        cell_id: cellId,
        classification: result,
        class_name: reviewState?.selectedClass
      }),
      returnAxiosFormat: true,
    });
    
  };

  return (
    <div className="bg-card overflow-hidden">
      {isCytoformer && (
        <div className="mb-2 space-y-1.5">
          <Label htmlFor="cyto-organ" className="text-xs text-muted-foreground">
            Organ <span className="text-muted-foreground/60">(optional)</span>
          </Label>
          <Select value={cytoformerOrgan || NO_ORGAN} onValueChange={setCytoformerOrgan}>
            <SelectTrigger id="cyto-organ" className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Default / clears the selection — an em dash reads as "blank", not as an organ. */}
              <SelectItem value={NO_ORGAN} className="text-xs text-muted-foreground">
                —
              </SelectItem>
              {CYTOFORMER_ORGANS.map((o) => (
                <SelectItem key={o} value={o} className="text-xs">
                  {CYTOFORMER_ORGAN_LABEL[o] ?? o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            Only needed to predict without annotations (zero-shot; unsure cells
            become “Negative control”). Once you have annotations, training uses your labels.
          </p>
        </div>
      )}
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
          writeDisabled={!pathWritable}
          writeDisabledTitle={writeBlockTitle}
        />
      </div>

      <div>
        <ClassifierStatusBanner
          selectedModelForCurrentPath={selectedModelForCurrentPath}
          updateClassifier={updateClassifier}
          actualClassifierPath={getContentStringValue(panel.content, "classifier_path")}
          actualSaveClassifierPath={getContentStringValue(panel.content, "save_classifier_path")}
          actualClassifierName={getClassifierDisplayBasename(panel.content)}
          onClear={handleClassifierClear}
          onClearSave={() => handleUpdateClassifierChange(false)}
          onRename={handleClassifierRename}
          onRenameSave={handleSaveClassifierRename}
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
              negativeCount={cls.negativeCount ?? 0}
              color={ensureHash(cls.color)}
              isSelected={activeManualClass !== null && 
                          activeManualClass.name === cls.name && 
                          activeManualClass.color === cls.color}
              isDeletable={pathWritable && cls.name !== NEGATIVE_CONTROL}
              onSelect={handleClassSelect}
              onEdit={editClass}
              onDelete={handleDeleteClass}
              onColorChange={(rowIndex, newColor) => {
                handleColorChange(rowIndex, newColor);
              }}
              writeDisabled={!pathWritable}
              writeDisabledTitle={writeBlockTitle}
              ovrEnabled={pathWritable && isOvrMode && cls.name !== NEGATIVE_CONTROL}
              ovrClassifierName={
                ovrClassifierPaths[cls.name]
                  ? (ovrClassifierPaths[cls.name].replace(/\\/g, '/').split('/').pop() || null)
                  : null
              }
              onOvrLoad={onOvrLoadClass ? () => onOvrLoadClass(cls.name) : undefined}
              onOvrClear={() => clearOvrClassifier(cls.name)}
              ovrSaveName={
                ovrSaveClassifierPaths[cls.name]
                  ? (ovrSaveClassifierPaths[cls.name].replace(/\\/g, '/').split('/').pop() || null)
                  : null
              }
              onOvrSaveClear={() => clearOvrSaveClassifier(cls.name)}
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
          writeDisabled={!pathWritable}
          writeDisabledTitle={writeBlockTitle}
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
                  newClassName === NEGATIVE_CONTROL
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

      {/* Cell review & active-learning — extracted to review/CellReviewModal */}
      <CellReviewModal
        open={showReviewModal}
        onClose={() => { setShowReviewModal(false); fetchGlobalTotals(); }}
        selectedCell={selectedCell}
        setSelectedCell={setSelectedCell}
        hideReviewPanel={hideReviewPanel}
        formattedPath={formattedPath}
      />

    </div>
  );
};
