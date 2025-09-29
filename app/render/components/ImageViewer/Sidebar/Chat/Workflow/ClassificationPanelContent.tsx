"use client";
import React, { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { useDispatch, useSelector } from "react-redux";
import { AppDispatch, RootState, store } from "@/store";
import { 
  addNucleiClass, 
  deleteNucleiClass, 
  updateNucleiClass,
  resetNucleiClasses,
  setNucleiClasses,
  setAnnotations,
  setActiveManualClassificationClass,
  AnnotationClass,
  clearAnnotationTypes
} from "@/store/slices/annotationSlice";
import { setClassificationEnabled } from "@/store/slices/annotationSlice";
import { setIsRunning, setUpdateAfterEveryAnnotation, setCurrentOrgan, setUpdateClassifier } from "@/store/slices/workflowSlice";
import { setIsGenerating as setIsChatGenerating } from "@/store/slices/chatSlice";
import { 
  setActiveLearningSession, 
  setZoom,
  setROI,
  setSelectedClass,
  setCandidatesLoading,
  setCandidatesData,
  setCandidatesError,
  setProbDistCache
} from "@/store/slices/activeLearningSlice";
import { useActiveLearning } from "@/hooks/useActiveLearning";
import EventBus from "@/utils/EventBus";
import { ClassificationPanelContentProps } from "./types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Edit, Trash2, MousePointer2, FolderOpen, Shapes } from "lucide-react";
import CIcon from "@coreui/icons-react";
import { cilPlus, cilTrash, cilCloudUpload, cilCloudDownload, cilLoop, cilNotes, cilPencil, cilSettings } from "@coreui/icons";
import { CModal, CModalHeader, CModalBody, CModalFooter, CButton, CFormLabel, CFormSelect, CFormTextarea, CFormInput, CFormCheck } from "@coreui/react";
import http from "@/utils/http";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import { formatPath } from "@/utils/pathUtils";
import { cellTypeOptions } from "./constants";
import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { setTool, DrawingTool } from "@/store/slices/toolSlice";
import { LiaDrawPolygonSolid } from "react-icons/lia";
import { PiRectangle } from "react-icons/pi";
import ActiveLearningPanel, { ActiveLearningPanelRef } from '../../../ActiveLearning/ActiveLearningPanel';
import ErrorBoundary from '../../../ActiveLearning/ErrorBoundary';
import ClassList from '../../../ActiveLearning/ClassList';
import { selectSelectedModelForPath } from "@/store/slices/modelSelectionSlice";

export const ClassificationPanelContent: React.FC<ClassificationPanelContentProps> = ({
  panel,
  onContentChange,
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const nucleiClasses = useSelector((state: any) => state.annotations.nucleiClasses as AnnotationClass[]);
  const activeManualClass = useSelector((state: any) => state.annotations.activeManualClassificationClass as AnnotationClass | null);
  const updateAfterEveryAnnotation = useSelector((state: any) => state.workflow.updateAfterEveryAnnotation as boolean);
  const updateClassifier = useSelector((state: any) => state.workflow.updateClassifier as boolean);
  const { annotatorInstance } = useAnnotatorInstance();
  
  // Get current path and selected model from FileBrowserSidebar
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const selectedFolder = useSelector((state: RootState) => state.webFileManager.selectedFolder);
  const isWebMode = useSelector((state: RootState) => {
    const activeInstanceId = state.wsi.activeInstanceId;
    const activeInstance = activeInstanceId ? state.wsi.instances[activeInstanceId] : undefined;
    const source = activeInstance?.fileInfo?.source as string | undefined;
    return source === 'web';
  });
  
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
  
  // Get Active Learning state for target cell zoom
  const alState = useActiveLearning();
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
  const [newClassName, setNewClassName] = useState(cellTypeOptions[0]);
  const [newClassColor, setNewClassColor] = useState('#' + Math.floor(Math.random()*16777215).toString(16));
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [originalColor, setOriginalColor] = useState<string | null>(null);
  const debounceTimeoutId = useRef<NodeJS.Timeout | null>(null);
  const sliderDebounceRef = useRef<NodeJS.Timeout | null>(null);
  
  
  
  // Cell review states
  const [selectedCell, setSelectedCell] = useState<{
    cellId: string;
    centroid: { x: number; y: number };
    slideId: string;
  } | null>(null);
  
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
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/save-reclassifications-via-existing-api`, {
        slide_id: formattedPath
      });
      
      if (response.data.code === 0 && response.data.data?.success && response.data.data?.count > 0) {
        // Auto-save successful (silent)
      }
    } catch (error) {
      // Auto-save failed (silent)
    }
  }, [formattedPath, showReviewModal]);
  
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
  const [reviewError, setReviewError] = useState<string | null>(null);
  
  // Track the contour overlay annotation ID for cleanup
  const [contourAnnotationId, setContourAnnotationId] = useState<string | null>(null);

  const ensureHash = (hex: string | undefined | null): string => {
    if (!hex) return '#000000';
    return hex.startsWith('#') ? hex : `#${hex}`;
  };
  
  // OpenSeadragon viewer ref for Review modal
  const reviewViewerRef = useRef<any>(null);

  // Cleanup timers on component unmount
  useEffect(() => {
    const sliderTimeout = sliderDebounceRef.current;
    const debounceTimeout = debounceTimeoutId.current;
    
    return () => {
      if (sliderTimeout) {
        clearTimeout(sliderTimeout);
      }
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
    };
  }, []);

  // Helper functions will be defined after formattedPath declaration

  // ROI detection logic - copied from DrawingOverlay.tsx
  const ZOOM_SCALE = 16; // same constant as in DrawingOverlay
  
  // Check if a point is inside the rectangle selection (fixed coordinate system)
  const isPointInRectangle = (x: number, y: number, rect: any): boolean => {
    if (!rect) return false;

    // The rect coordinates are already in viewer coordinates, need to convert to image coordinates
    // Based on observed data: ROI coords are viewer coords / ZOOM_SCALE to get image coords
    // But our cell coords are already in image coordinates, so we need to reverse this
    const rectX1 = rect.x1 * ZOOM_SCALE;
    const rectY1 = rect.y1 * ZOOM_SCALE;
    const rectX2 = rect.x2 * ZOOM_SCALE;
    const rectY2 = rect.y2 * ZOOM_SCALE;

    // Check if point is inside rectangle
    return x >= Math.min(rectX1, rectX2) && x <= Math.max(rectX1, rectX2) &&
           y >= Math.min(rectY1, rectY2) && y <= Math.max(rectY1, rectY2);
  };

  // Check if a point is inside a polygon using ray casting algorithm (from DrawingOverlay.tsx)
  const isPointInPolygon = (x: number, y: number, polygonPoints: [number, number][]): boolean => {
    if (!polygonPoints || polygonPoints.length < 3) return false;

    // Convert polygon points to image coordinates (same scale as centroids)
    const scaledPolygonPoints = polygonPoints.map(point => [
      point[0] * ZOOM_SCALE,
      point[1] * ZOOM_SCALE
    ]);

    let inside = false;
    const n = scaledPolygonPoints.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = scaledPolygonPoints[i][0];
      const yi = scaledPolygonPoints[i][1];
      const xj = scaledPolygonPoints[j][0];
      const yj = scaledPolygonPoints[j][1];

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
        
        // Scale coordinates to match backend expectation (same as WebSocket data)
        const ZOOM_SCALE = 16; // From DrawingOverlay
        const scaledX1 = x1 * ZOOM_SCALE;
        const scaledY1 = y1 * ZOOM_SCALE; 
        const scaledX2 = x2 * ZOOM_SCALE;
        const scaledY2 = y2 * ZOOM_SCALE;
        
        
        // Call backend API to get cells within ROI with their classification data
        const queryParams = {
          x1: scaledX1,
          y1: scaledY1,
          x2: scaledX2,
          y2: scaledY2,
          // Don't filter by class_name here - we want all cells in ROI
        };
        
        
        const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/query`, {
          params: queryParams
        });
        
        
        const responseData = response.data.data || response.data;
        
        if (responseData && responseData.matching_indices && Array.isArray(responseData.matching_indices)) {
          
          // Try to get additional cell data including classifications
          let cellsWithClassification = [];
          
          try {
            // Call classification API to get cell classifications
            const classificationResponse = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classifications`, {
              params: { file_path: formattedPath }
            });
            
            const classData = classificationResponse.data.data || classificationResponse.data;
            
            // If we have classification data, use it to enrich our cells
            if (classData && classData.nuclei_class_name && classData.nuclei_class_HEX_color) {
              const classNames = classData.nuclei_class_name;
              const classColors = classData.nuclei_class_HEX_color;
              
              cellsWithClassification = responseData.matching_indices.map((cellIndex: number, i: number) => {
                // Get centroid coordinates - backend should provide these
                // For now, estimate centroid based on cell index and ROI
                const roiWidth = scaledX2 - scaledX1;
                const roiHeight = scaledY2 - scaledY1;
                const offsetX = (roiWidth / 4) * (i % 4);
                const offsetY = (roiHeight / 3) * Math.floor(i / 4);
                const x = scaledX1 + offsetX + (Math.random() - 0.5) * (roiWidth / 8);
                const y = scaledY1 + offsetY + (Math.random() - 0.5) * (roiHeight / 8);
                
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
              // Get centroid coordinates - backend should provide these
              // For now, estimate centroid based on cell index and ROI
              const roiWidth = scaledX2 - scaledX1;
              const roiHeight = scaledY2 - scaledY1;
              const offsetX = (roiWidth / 4) * (i % 4);
              const offsetY = (roiHeight / 3) * Math.floor(i / 4);
              const x = scaledX1 + offsetX + (Math.random() - 0.5) * (roiWidth / 8);
              const y = scaledY1 + offsetY + (Math.random() - 0.5) * (roiHeight / 8);
              
              return {
                cell_id: `backend-cell-${cellIndex}`,
                id: `backend-cell-${cellIndex}`,
                className: alState?.selectedClass || 'Unknown',
                class_name: alState?.selectedClass || 'Unknown',
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
            className: classificationBody?.value || alState?.selectedClass || 'Unknown',
            class_name: classificationBody?.value || alState?.selectedClass || 'Unknown', 
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
        
        
        // Filter cells by ROI bounds using scaled coordinates
        const { x1, y1, x2, y2 } = shapeData.rectangleCoords;
        const ZOOM_SCALE = 16;
        const scaledX1 = x1 * ZOOM_SCALE;
        const scaledY1 = y1 * ZOOM_SCALE;
        const scaledX2 = x2 * ZOOM_SCALE;  
        const scaledY2 = y2 * ZOOM_SCALE;
        
        const cellsInROI = cells.filter((cell: any) => {
          const { x, y } = cell.centroid;
          const inROI = x >= scaledX1 && x <= scaledX2 && y >= scaledY1 && y <= scaledY2;
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
  }, [formattedPath, alState?.selectedClass, annotations]);
  
  // Load candidates and probability distribution
  const loadCandidatesAndProbDist = useCallback(async () => {
    // Use alState for selected class and slide ID
    if (!alState?.selectedClass || !formattedPath) return;

    // Set Active Learning session
    dispatch(setActiveLearningSession({
      slideId: formattedPath || currentPath || 'unknown',
      className: alState.selectedClass
    }));

    dispatch(setCandidatesLoading(true));
    
    try {
      
      // Call Active Learning API using POST to avoid long query strings
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/candidates`, {
        slide_id: formattedPath,
        class_name: alState.selectedClass,
        threshold: alState.threshold || 0.5,
        sort: alState.sort || "asc",
        limit: alState.pageSize || 80,
        offset: (alState.page || 0) * (alState.pageSize || 80),
      });


      if (response.data) {
        // Handle different possible response formats (same as ActiveLearningPanel)
        let total, hist, items;

        if (response.data.code === 0 && response.data.data) {
          // Format: {code: 0, message: 'Success', data: {...}}
          const actualData = response.data.data;
          total = actualData.total;
          hist = actualData.hist || actualData.histogram_bins || [];
          items = actualData.items || actualData.candidates || [];
        } else if (response.data.total !== undefined || response.data.candidates !== undefined) {
          // Direct format: {total: N, candidates: [...], histogram_bins: [...]}
          total = response.data.total;
          hist = response.data.hist || response.data.histogram_bins || [];
          items = response.data.items || response.data.candidates || [];
        } else {
          // Fallback - treat entire response as data
          total = response.data.total || 0;
          hist = response.data.hist || response.data.histogram_bins || [];
          items = response.data.items || response.data.candidates || [];
        }


        dispatch(setCandidatesData({
          total: total || 0,
          hist: hist || [],
          items: items || []
        }));
        
        dispatch(setCandidatesError(null));
        
        // Handle probability distribution - use histogram from API response
        const cacheKey = `${formattedPath}_AL_${alState.selectedClass}_${alState.threshold}`;
        dispatch(setProbDistCache({ key: cacheKey, data: hist || [] }));
        
      } else {
        throw new Error('Invalid response format from Active Learning API');
      }

    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Failed to load Active Learning candidates';
      dispatch(setCandidatesError(errorMessage));
      
      // Fallback to ROI-based selection for compatibility
      try {
        if (shapeData) {
          const cells = await selectCellsInRegion(shapeData);
          const filtered = cells.filter((cell: any) => {
            const cellClassName = cell.className || cell.class_name;
            return cellClassName && 
              cellClassName.toLowerCase().trim() === alState.selectedClass?.toLowerCase().trim();
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
  }, [alState, formattedPath, currentPath, dispatch, shapeData, selectCellsInRegion]);
  
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

  // Auto-update panel content when selected model changes in FileBrowserSidebar
  useEffect(() => {
    if (selectedModelForCurrentPath) {
      // Construct path to the model file
      let modelPath;
      if (isWebMode) {
        // In web mode, use relative path like h5_path
        modelPath = `${selectedFolder || ''}/${selectedModelForCurrentPath}`.replace(/\/+/g, '/');
      } else {
        // In desktop mode, use absolute path
        modelPath = `${selectedFolder || ''}\\${selectedModelForCurrentPath}`.replace(/\\+/g, '\\');
      }
      
      // Update panel content with the selected model path
      handlePathChange('load', modelPath);
      
      // If update classifier is already checked, also update save path
      if (updateClassifier) {
        handlePathChange('save', modelPath);
      }
    } else {
      // When no classifier is selected, clear both load and save paths in one operation
      let newContent = [...panel.content];
      const loadIndex = newContent.findIndex(item => item.key === 'classifier_path');
      const saveIndex = newContent.findIndex(item => item.key === 'save_classifier_path');
      
      // Remove both paths if they exist
      if (loadIndex > -1) {
        newContent.splice(loadIndex, 1);
      }
      if (saveIndex > -1) {
        // Adjust index if we already removed load path
        const adjustedSaveIndex = saveIndex > loadIndex ? saveIndex - 1 : saveIndex;
        newContent.splice(adjustedSaveIndex, 1);
      }
      onContentChange(panel.id, { ...panel, content: newContent });
    }
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
          // Try JSON first; if it fails, accept comma/newline separated class names
          try {
            promptContent = JSON.parse(promptValue) as { organ_type?: string; nuclei_classes?: string[] };
          } catch (e) {
            const classes = promptValue
              .split(/[\n,]/)
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
        // Only check once during initialization to avoid infinite loop
        const currentClassNames = nucleiClasses.map(cls => cls.name.toLowerCase());
        const newClasses: string[] = [];
        
        promptContent.nuclei_classes.forEach((className: string) => {
          if (!currentClassNames.includes(className.toLowerCase())) {
            newClasses.push(className);
          }
        });
        
        // Only add truly missing classes
        if (newClasses.length > 0) {
          newClasses.forEach(className => {
            const randomColor = '#' + Math.floor(Math.random()*16777215).toString(16);
            dispatch(addNucleiClass({
              name: className,
              count: 0,
              color: randomColor,
              persisted: false,
            }));
          });
        }
      }
    } catch (error) {
    }
  }, [panel.content, dispatch, nucleiClasses, panel.id]);

  // Fetch global totals (model + manual overrides) from backend
  const fetchGlobalTotals = useCallback(async () => {
    try {
      if (!formattedPath) return;

      // Get TOTAL counts (model + manual) for display
      const totalResp = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/total_counts`, {
        params: { file_path: formattedPath }
      });
      const totalData = totalResp?.data?.data || totalResp?.data;

      if (totalData) {
        const names: string[] = (totalData.dynamic_class_names || []) as string[];
        const colors: string[] = (totalData.class_hex_colors || []) as string[];
        const countsMap: Record<string, number> = totalData.class_counts_by_id || {};
        const total: number = typeof totalData.total_cells === 'number' ? totalData.total_cells : null;

        const segs = names.map((n: string, i: number) => ({
          name: n,
          color: colors[i] || '#aaaaaa',
          count: countsMap[String(i)] || 0,
        }));

        setTotalCells(total);
        setGlobalSegments(segs);
      }

      // Get MANUAL annotation counts for the annotation panel
      const manualResp = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/manual_annotation_counts`, {
        params: { file_path: formattedPath }
      });
      const manualData = manualResp?.data?.data || manualResp?.data;

      if (manualData) {
        const manualNames: string[] = (manualData.dynamic_class_names || []) as string[];
        const manualCountsMap: Record<string, number> = manualData.class_counts_by_id || {};

        // Get current nucleiClasses from Redux store to avoid stale closure
        const state = store.getState();
        const currentNucleiClasses = state.annotations.nucleiClasses as AnnotationClass[];

        // Update nucleiClasses with manual annotation counts only
        const updatedNucleiClasses = currentNucleiClasses.map(cls => {
          const classIndex = manualNames.indexOf(cls.name);
          if (classIndex >= 0) {
            return {
              ...cls,
              count: manualCountsMap[String(classIndex)] || 0
            };
          }
          return { ...cls, count: 0 };
        });

        dispatch(setNucleiClasses(updatedNucleiClasses));
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

  // Load totals on path change
  useEffect(() => {
    fetchGlobalTotals();
  }, [formattedPath, fetchGlobalTotals]);

  // Refresh totals on backend refresh events with debouncing
  useEffect(() => {
    let debounceTimer: NodeJS.Timeout;

    const refreshHandler = () => {
      // Clear any pending refresh
      clearTimeout(debounceTimer);
      // Debounce to avoid multiple rapid calls
      debounceTimer = setTimeout(() => {
        fetchGlobalTotals();
      }, 100);
    };

    EventBus.on('refresh-annotations', refreshHandler);
    // Only listen to one event to avoid duplicate calls
    // refresh-websocket-path is more comprehensive, so we use that
    // EventBus.on('refresh-websocket-path', refreshHandler);

    return () => {
      clearTimeout(debounceTimer);
      EventBus.off('refresh-annotations', refreshHandler);
      // EventBus.off('refresh-websocket-path', refreshHandler);
    };
  }, [fetchGlobalTotals]);

  // Remove local manual reclassification handler
  // We'll rely entirely on backend updates to avoid sync issues

  const handleAddClass = () => {
    if (editingIndex !== null) {
      // Update existing class
      const updatedClass: AnnotationClass = {
        ...nucleiClasses[editingIndex],
        name: newClassName,
        color: newClassColor
      };
      
      dispatch(updateNucleiClass({
        index: editingIndex, 
        newClass: updatedClass
      }));
    } else {
      // Add new class
      dispatch(addNucleiClass({
        name: newClassName,
        count: 0,
        color: newClassColor
      }));
    }
    
    // Reset state
    setShowModal(false);
    setNewClassName(cellTypeOptions[0]);
    setNewClassColor('#' + Math.floor(Math.random()*16777215).toString(16));
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
  const getH5Path = (): string | null => (formattedPath ? `${formattedPath}.h5` : null);

  const performDelete = async (index: number, className: string, reassignTo = 'Negative control') => {
    const h5Path = getH5Path();
    if (!h5Path) return;
    await http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/delete-class`, {
      class_name: className,
      reassign_to: reassignTo,
      file_path: h5Path,
    });
    dispatch(deleteNucleiClass(index));
    dispatch(clearAnnotationTypes());
    if (activeManualClass && activeManualClass.name === className) {
      dispatch(setActiveManualClassificationClass(null));
    }
    EventBus.emit('refresh-annotations');
    EventBus.emit('refresh-websocket-path', { path: h5Path, forceReload: true });
  };

  const handleDeleteClass = async (index: number) => {
    const cls = nucleiClasses[index];
    if (!cls) return;
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
      return path + '.h5';
    };

    const outputPath = getDefaultOutputPath(formattedPath);
    if (!outputPath) {
        setShowResetModal(false);
        return;
    }

    try {
      // API call to the new backend endpoint
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/reset_classification`, {
          h5_path: outputPath
      });

      if (response.data?.data?.status === 'success' || response.data?.message === 'Success') {
          // On success: keep all classes but zero their counts
          const cleared = nucleiClasses.map(cls => ({ ...cls, count: 0 }));
          dispatch(setNucleiClasses(cleared));
          dispatch(setAnnotations([]));
          dispatch(clearAnnotationTypes());

          // After reset, fetch updated classifications to repopulate Redux immediately
          try {
            const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classifications`, {
              params: { file_path: formattedPath }
            });
            const data = resp?.data?.data;
            if (data && data.nuclei_class_name && data.nuclei_class_HEX_color) {
              const finalClasses = data.nuclei_class_name.map((rawName: string, i: number) => ({
                name: typeof rawName === 'string' ? rawName : String(rawName ?? ''),
                color: data.nuclei_class_HEX_color[i],
                count: data.nuclei_class_counts?.[i] ?? 0,
                persisted: true,
              }));
              dispatch(setNucleiClasses(finalClasses));
            }
          } catch (e) {
          }

          EventBus.emit("refresh-websocket-path", { path: outputPath, forceReload: true });

      } else {
      }
    } catch (error) {
    } finally {
        setShowResetModal(false);
    }
  };
  
  // Update function
  const handleClickUpdate = async () => {
    const getDefaultOutputPath = (path: string): string => {
      if (!path) return "";
      return path + '.h5';
    };

    const outputPath = getDefaultOutputPath(formattedPath);
    const organValue = panel.content.find(item => item.key === "organ")?.value ?? "";

    // Paths are now managed entirely by FileBrowserSidebar
    let finalLoadPath = null;
    let finalSavePath = null;
    
    if (selectedModelForCurrentPath) {
      // Always set load path when a classifier is selected
      let modelPath;
      if (isWebMode) {
        // In web mode, use relative path like h5_path
        modelPath = `${selectedFolder || ''}/${selectedModelForCurrentPath}`.replace(/\/+/g, '/');
      } else {
        // In desktop mode, use absolute path
        modelPath = `${selectedFolder || ''}\\${selectedModelForCurrentPath}`.replace(/\\+/g, '\\');
      }
      finalLoadPath = modelPath;
      
      // Only set save path when update classifier is checked
      if (updateClassifier) {
        finalSavePath = modelPath;
      }
    }

    const workflowPayload = {
      h5_path: outputPath,
      step1: {
        model: "ClassificationNode",
        input: {
          nuclei_classes: nucleiClasses.map(cls => cls.name),
          nuclei_colors: nucleiClasses.map(cls => cls.color),
          organ: organValue,
          classifier_path: finalLoadPath,
          save_classifier_path: finalSavePath,
        }
      }
    };

    try {
      dispatch(setIsChatGenerating(true));
      dispatch(setIsRunning(true));

      // Gateway workflow gating (best-effort)

      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, workflowPayload);

      if (response.data.message === "Success" || response.status === 200 || response.data.code === 0) {
      } else {
        dispatch(setIsChatGenerating(false));
        dispatch(setIsRunning(false));
      }
    } catch (error) {
      dispatch(setIsChatGenerating(false));
      dispatch(setIsRunning(false));
    }
  };

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
    const key = type === 'save' ? 'save_classifier_path' : 'classifier_path';
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
      // When enabling update, set both load and save paths to the selected model
      let modelPath;
      if (isWebMode) {
        // In web mode, use relative path like h5_path
        modelPath = `${selectedFolder || ''}/${selectedModelForCurrentPath}`.replace(/\/+/g, '/');
      } else {
        // In desktop mode, use absolute path
        modelPath = `${selectedFolder || ''}\\${selectedModelForCurrentPath}`.replace(/\\+/g, '\\');
      }
      
      handlePathChange('load', modelPath);
      handlePathChange('save', modelPath);
    } else if (!checked) {
      // When disabling update, clear save path but keep load path
      handlePathChange('save', null);
    }
  };


  const handleColorChange = (index: number, newColor: string) => {
    // Clear any pending timeout to reset the debounce timer
    if (debounceTimeoutId.current) {
      clearTimeout(debounceTimeoutId.current);
    }

    // Set a new timeout to perform the update
    debounceTimeoutId.current = setTimeout(async () => {
      const originalClass = nucleiClasses[index];

      // Now, dispatch the update for the UI
      dispatch(updateNucleiClass({
        index,
        newClass: { ...originalClass, color: newColor }
      }));

      // And make the API call
      try {
        const h5Path = formattedPath ? `${formattedPath}.h5` : null;
        if (!h5Path) {
            throw new Error("No valid file path available.");
        }
        await http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/update-class-color`, {
          class_name: originalClass.name,
          new_color: newColor,
          file_path: h5Path,
        });
        EventBus.emit("refresh-annotations");
      } catch (error) {
        // Revert the optimistic update on failure, using the color captured onMouseDown
        if (originalColor) {
            dispatch(updateNucleiClass({
                index,
                newClass: { ...originalClass, color: originalColor }
            }));
        }
      } finally {
        setOriginalColor(null); // Clear original color after attempt
      }
    }, 300); // 300ms delay feels responsive but prevents spam
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

        // Clear previous cell data when selecting a new cell
        // Keep contour state as user preference
        if (selectedCell?.cellId !== cellId) {
          setReviewData(null);
          // setShowContour(false); // Removed: keep user's contour preference
          setReviewError(null);
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
  const setupTargetCellWithMainViewer = async (cell: typeof selectedCell) => {
    if (!cell) return;
    
    
    // Position viewer using centroid and contour data
    await showNucleiWithViewer(cell);
  };


  // Show nuclei with positioning and contour display
  const showNucleiWithViewer = async (cell: typeof selectedCell) => {
    if (!cell) return;

    
    // Ensure we have a proper default zoom for patch mode (reset if too low)
    if (!alState?.zoom || alState.zoom < 10) {
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
      await fetchAndPositionCell(cell, contourData, cellBounds);

    } catch (error: any) {
      setReviewError(error?.message || 'Failed to show nuclei');
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
    const currentZoom = alState?.zoom || 90; // Default zoom value
    const currentPatchSize = customPatchSize || calculatePatchSizeFromZoom(currentZoom);

    setIsLoadingReview(true);

    try {
      // Call backend API to get cell patch with variable size
      const requestPayload = {
        slide_id: cell.slideId,
        cell_id: cell.cellId,
        centroid: cell.centroid,
        window_size_px: currentPatchSize,  // Variable patch size
        return_contour: true,
        contour_type: forceContourType !== undefined ? forceContourType : (showContour ? 'polygon' : null)  // Contour display type
      };
      
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/nuclei_classification/cell_review_tile`, requestPayload);


      // Handle API response format (cell patch data)  
      let patchImage: string;
      let patchData: any;
      
      if (response.data.code === 0 && response.data.data) {
        patchData = response.data.data;
        
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
        throw new Error(response.data.message || 'Failed to get cell patch');
      }

      
      setIsLoadingReview(false);
      
      // Force open Review Modal for immediate viewing
      setShowReviewModal(true);

    } catch (error: any) {
      setReviewError(error?.message || 'Failed to fetch and position cell');
      setIsLoadingReview(false);
    }
  };


  // Store contour data separately to avoid conflicts
  const [contourData, setContourData] = useState<{
    contour?: { x: number; y: number }[];
    bounds?: { x: number; y: number; w: number; h: number };
  } | null>(null);

  // Fetch contour data using original API (separate from main image)
  const fetchCellReviewData = async (cell: typeof selectedCell, magnification?: number) => {
    if (!cell) return;
    
    const currentMagnification = magnification ?? 40; 
    
    try {
      // Validate cell data before making request
      if (!cell.cellId || !cell.centroid || typeof cell.centroid.x !== 'number' || typeof cell.centroid.y !== 'number') {
        throw new Error('Invalid cell data: missing cellId or centroid coordinates');
      }

      // Normalize the slide path for the backend
      const normalizedSlideId = cell.slideId.replace(/\\/g, '/');
      
      const requestPayload = {
        slide_id: normalizedSlideId,
        cell_id: cell.cellId,
        centroid: cell.centroid,
        window_size_px: 512,
        padding_ratio: 0.2,
        magnification: currentMagnification,
        return_contour: true
      };
      
      
      
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/nuclei_classification/cell_review_tile`, requestPayload);
      
      
      // Debug image properties if available
      if (response.data.data || response.data.image) {
        const data = response.data.data || response.data;
      }
      

      // Check if response contains classification data
      let cellClassificationData: any = null;
      if (response.data.code === 0 && response.data.data) {
        cellClassificationData = response.data.data;
        
        // Update selectedCell with classification data for Active Learning
        if (cellClassificationData?.predicted_class || cellClassificationData?.probs || cellClassificationData?.label) {
          setSelectedCell(prev => prev ? {
            ...prev,
            predicted_class: cellClassificationData.predicted_class,
            probs: cellClassificationData.probs,
            label: cellClassificationData.label
          } as any : null);
        }
      }

      // Handle different possible response formats
      if (response.status === 200) {
        if (response.data.success && response.data.data) {
          // Format: {success: true, data: {...}}
          setReviewData(response.data.data);
          // Auto-enable contour display if contour data is available
          if (response.data.data.contour && response.data.data.contour.length > 0) {
            setShowContour(true);
          }
        } else if (response.data.code === 0 && response.data.data) {
          // Format: {code: 0, data: {...}}
          setReviewData(response.data.data);
          // Auto-enable contour display if contour data is available
          if (response.data.data.contour && response.data.data.contour.length > 0) {
            setShowContour(true);
          }
        } else if (response.data.image) {
          // Direct data format: {image: ..., bounds: ..., etc.}
          setReviewData(response.data);
          // Auto-enable contour display if contour data is available
          if (response.data.contour && response.data.contour.length > 0) {
            setShowContour(true);
          }
        } else {
          // Error response or unexpected format
          const errorMsg = response.data.message || response.data.error || 'Unknown error occurred while fetching cell data';
          setReviewError(`Failed to load cell data: ${errorMsg}`);
        }
      } else {
        const errorMsg = response.data.error || `HTTP ${response.status} error`;
        setReviewError(`Failed to load cell data: ${errorMsg}`);
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
      const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/load/v1/slide/preview_by_path`, {
        params: {
          file_path: normalizedSlideId,
          preview_type: 'thumbnail',  // Keep thumbnail but much larger size
          size: 12288  // Back to working size
        },
        timeout: 15000,  // 15 second timeout for full image
        responseType: 'arraybuffer'  // Handle binary data properly
      });
      
      
      if (response.status !== 200) {
        throw new Error(`API returned status ${response.status}`);
      }
      
      // Check if we got binary image data
      const contentType = response.headers['content-type'] || '';
      
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
            throw new Error(`API error: ${jsonData.message || jsonData.error || 'Unknown error'}`);
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
        const contourResponse = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/nuclei_classification/cell_review_tile`, {
          slide_id: normalizedSlideId,
          cell_id: cell.cellId,
          centroid: cell.centroid,
          window_size_px: 512,
          padding_ratio: 0.2, // Match backend default for consistent crop bounds
          return_contour: true
        });
        
        // Store backend debug info globally for accurate contour coordinate conversion
        if (contourResponse.data.code === 0 && contourResponse.data.data && contourResponse.data.data.debug_crop_info) {
          // Store debug info for logging (optional)
        }
        
        if (contourResponse.data.code === 0 && contourResponse.data.data) {
          if (contourResponse.data.data.contour) {
            contourData = contourResponse.data.data.contour;
          }
          
          // Try to extract slide dimensions from response if available
          const responseData = contourResponse.data.data;
          if (responseData.slide_width && responseData.slide_height) {
            slideDimensions = { 
              width: responseData.slide_width, 
              height: responseData.slide_height 
            };
          } else {
          }
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
      
      // Auto-enable contour display if contour data is available
      if (contourData && contourData.length > 0) {
        setShowContour(true);
      }
      
      
    } catch (error: any) {
      if (error.response) {
        setReviewError(`API Error: ${error.response.data?.message || error.response.data?.error || error.message}`);
      } else if (error.request) {
        setReviewError('No response from server - check network connection');
      } else {
        setReviewError(`Request error: ${error.message}`);
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
    if (alState?.selectedClass && shapeData && annotations.length > 0) {
      // When both ROI (shapeData) and class are selected, and we have annotation data, auto-load candidates
      loadCandidatesAndProbDist();
    }
  }, [alState?.selectedClass, annotations.length, loadCandidatesAndProbDist, shapeData]); // Include all dependencies

  // Handle Review button click with guards
  const handleReviewClick = () => {
    // Update ROI in alState (use shapeData if available, otherwise null for whole slide)
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
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 16px;
        line-height: 1.4;
        max-width: 400px;
        min-width: 320px;
        box-shadow: 0 4px 12px rgba(225, 68, 52, 0.2);
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
      textDiv.innerHTML = `<div><strong>Classification Failed</strong></div><div style="margin-top: 4px;">Unable to save the classification result.</div>`;

      errorDiv.appendChild(iconDiv);
      errorDiv.appendChild(textDiv);
      document.body.appendChild(errorDiv);
      setTimeout(() => errorDiv.remove(), 3000);
    }
  };

  // Helper function to write Yes/No classification - replace with your actual implementation
  const writeYesNo = async (cellId: string, result: 'yes' | 'no'): Promise<void> => {
    const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classify_cell`, {
      file_path: formattedPath + '.h5',
      cell_id: cellId,
      classification: result,
      class_name: alState?.selectedClass
    });
    
    if (response.data?.code !== 200 && response.data?.success !== true) {
      throw new Error(response.data?.message || 'Failed to save classification');
    }
  };

  return (
    <div className="px-[10px] py-[10px] space-y-2 rounded-lg bg-neutral-50 border-1">
      <div className="flex items-center justify-between">
        <Label htmlFor="organ" className="text-muted-foreground font-normal">Organ</Label>
      </div>
      <Input
        id="organ"
        value={panel.content.find(item => item.key === "organ")?.value ?? ""}
        placeholder="Enter organ or leave blank if unknown"
        onChange={(e) => {
          const organExists = panel.content.some(item => item.key === "organ");
          onContentChange(panel.id, {
            ...panel,
            content: organExists 
              ? panel.content.map((item) =>
                  item.key === "organ" ? { ...item, value: e.target.value } : item
                )
              : [...panel.content, { key: "organ", type: "input", value: e.target.value }]
          });
          dispatch(setCurrentOrgan(e.target.value));
        }}
      />
      
      <div className="mt-3">
        <div className="flex items-center justify-between mb-2">
          <Label htmlFor="cells" className="text-muted-foreground font-normal">Cells:</Label>
        </div>
        
        {/* Button row */}
        <div className="d-flex flex-column align-items-start">
          <div className="d-flex gap-1">
            {/* @ts-ignore */}
            <CButton color="primary" size="sm" onClick={openAddClassModal}>
              <CIcon icon={cilPlus}/> New Class
            </CButton>
            {/* @ts-ignore */}
            <CButton color="danger" size="sm" className="text-white" onClick={() => setShowResetModal(true)}>
              <CIcon icon={cilTrash}/> Reset
            </CButton>
            {/* @ts-ignore */}
            <div className="ms-2 flex-shrink-0 d-flex align-items-center gap-1">
              <CFormCheck
              type="checkbox"
              id={`updateClassifier-${panel.id}`}
              checked={updateClassifier}
              onChange={(e) => handleUpdateClassifierChange(e.target.checked)}
              disabled={!selectedModelForCurrentPath}
              title={selectedModelForCurrentPath ? "Update the selected classifier" : "No classifier selected"}
              className="text-xs me-1"
              />
              <label htmlFor={`updateClassifier-${panel.id}`} style={{ fontSize: '0.8rem' }}>
                Update Classifier
              </label>
            </div>
            {/* @ts-ignore */}
            {/* <CButton color="light" size="sm" onClick={() => setShowLoadInput(true)}>
              <CIcon icon={cilCloudDownload}/> Load
            </CButton> */}
          </div>
          
          {/* Selected Classifier from FileBrowser */}
          {selectedModelForCurrentPath && (
            <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs w-full">
              <div className="flex items-center gap-2 w-full">
                <span className="font-medium text-blue-800 flex-shrink-0">Selected Classifier:</span>
                <span className="text-blue-600 truncate flex-1" title={selectedModelForCurrentPath}>
                  {selectedModelForCurrentPath.replace('.tlcls', '')}
                </span>
              </div>
            </div>
          )}
          
          {/* Update Classifier Status */}
          {updateClassifier && selectedModelForCurrentPath && (
            <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded text-xs w-full">
              <div className="flex items-center gap-2 w-full">
                <span className="font-medium text-green-800 flex-shrink-0">Updating Classifier:</span>
                <span className="text-green-600 truncate flex-1" title={selectedModelForCurrentPath}>
                  {selectedModelForCurrentPath.replace('.tlcls', '')}
                </span>
              </div>
            </div>
          )}
          <div className="d-flex gap-1 mt-2 items-center">
            <Label htmlFor="annotations-tools" className="text-muted-foreground font-normal text-xs mr-1">Annotations:</Label>
            <button
                onClick={() => handleToolChange('rectangle')}
                className={`flex items-center justify-center p-2 rounded-md transition-colors ${
                  currentTool === 'rectangle'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-300'
                }`}
              > 
                <PiRectangle className="h-4 w-4" />
              </button>
              <button
                onClick={() => handleToolChange('polygon')}
                className={`flex items-center justify-center p-2 rounded-md transition-colors ${
                  currentTool === 'polygon'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-300'
                }`}
              >
                <LiaDrawPolygonSolid className="h-4 w-4" />
              </button>
          </div>
        </div>

        <div className="mt-2 border-y">
          <table className="w-full">
            <tbody>
              {nucleiClasses.map((cls, index) => (
                <tr key={index} className="border-b last:border-b-0 w-full">
                  <td className="px-2 py-1 w-8 text-center">
                    <div className="flex justify-center">
                      {activeManualClass && 
                       activeManualClass.name === cls.name && 
                       activeManualClass.color === cls.color ? (
                        <button
                          onClick={() => handleClassSelect(index)}
                        >
                          <MousePointer2 className="h-4 w-4 text-primary" />
                        </button>
                      ) : (
                        <button
                          className="w-4 h-4 cursor-pointer hover:bg-gray-100 rounded-sm"
                          onClick={() => handleClassSelect(index)}
                        />
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1 overflow-hidden w-auto max-w-0">
                    <div className="flex min-w-0 items-center w-full justify-between flex-shrink">
                      <span className="text-sm min-w-0 truncate overflow-hidden" title={cls.name}>{cls.name}</span>
                      <div className="flex-none">
                        {cls.name !== 'Negative control' && (
                          <button
                            className="ml-1 text-gray-500 hover:text-gray-700"
                            onClick={() => editClass(index)}
                          >
                            <Edit className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-1 w-8">
                    <Input
                      type="color"
                      value={ensureHash(cls.color)}
                      className="w-5 h-5 p-0 border-0"
                      onMouseDown={() => setOriginalColor(cls.color)}
                      onChange={(e) => handleColorChange(index, e.target.value)}

                    />
                  </td>
                  <td className="px-2 py-1 w-12 text-center">
                    <span className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                      {cls.count}
                    </span>
                  </td>
                  <td className="px-2 py-1 w-10 text-right">
                    {cls.name !== 'Negative control' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => handleDeleteClass(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Global totals stacked bar */}
        {globalSegments && totalCells !== null && totalCells > 0 && (
          <div className="mt-3 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Cell distribution (whole slide)</span>
              <span>Total cells: {totalCells.toLocaleString()}</span>
            </div>
            <div className="w-full h-7 rounded overflow-hidden border border-gray-200 bg-white">
              <div className="flex h-full w-full">
                {(() => {
                  const labeled = globalSegments.reduce((s, seg) => s + (seg.count || 0), 0);
                  const segments = [...globalSegments];
                  const unlabeled = Math.max(0, totalCells - labeled);
                  if (unlabeled > 0) {
                    segments.push({ name: 'Unlabeled', color: '#cccccc', count: unlabeled });
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
                          className="h-full relative"
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
      <div className="d-flex flex-column align-items-start gap-1">
        {/* Selected Cell Status - Hidden */}
        <div className="mb-2" style={{ display: 'none' }}>
          <small className="text-muted">
            Selected Cell: {selectedCell ? (
              <span className="text-success">
                {selectedCell.cellId} @ ({selectedCell.centroid.x.toFixed(1)}, {selectedCell.centroid.y.toFixed(1)})
              </span>
            ) : (
              <span className="text-warning">No cell selected - click on a segmented cell</span>
            )}
          </small>
        </div>
        
        <CFormCheck 
          label="Update after every annotation"
          checked={updateAfterEveryAnnotation}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => dispatch(setUpdateAfterEveryAnnotation(e.target.checked))}
          className="text-xs w-full space-x-2"
        />
        

        <div className="d-flex gap-1">
          {/* @ts-ignore */}
          <CButton color="success" size="sm" onClick={handleClickUpdate}>
            <CIcon icon={cilLoop}/> Update
          </CButton>
          {/* @ts-ignore */}
          <CButton 
            color="success" 
            size="sm" 
            onClick={handleReviewClick}
          >
            <CIcon icon={cilNotes}/> Review
          </CButton>
        </div>
      </div>
      
      {/* Add/Edit Class Modal */}
      <CModal
        visible={showModal}
        onClose={() => {
          setShowModal(false);
          setEditingIndex(null);
        }}
        // @ts-ignore
        scrollable
      >
        <CModalHeader closeButton>
          {editingIndex !== null ? 'Edit Class' : 'Add New Class'}
        </CModalHeader>
        <CModalBody>
          <div className="mb-3">
            <CFormLabel>
              Cell Type:
            </CFormLabel>
            <CFormSelect
              value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)}
              className="mb-2"
            >
              {cellTypeOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </CFormSelect>

            <CFormLabel>
              Or enter custom cell type:
            </CFormLabel>
            <CFormTextarea
              value={
                newClassName === 'Negative control'
                  ? ''
                  : newClassName
              }
              onChange={(e) => setNewClassName(e.target.value)}
              rows={2}
            />
          </div>
          <div className="mb-3">
            <CFormLabel>Color:</CFormLabel>
            <CFormInput
              type="color"
              value={newClassColor}
              onChange={(e) => setNewClassColor(e.target.value)}
            />
          </div>
        </CModalBody>
        <CModalFooter>
          {/* @ts-ignore */}
          <CButton
            color="secondary"
            onClick={() => {
              setShowModal(false);
              setEditingIndex(null);
            }}
          >
            Cancel
          </CButton>
          {/* @ts-ignore */}
          <CButton color="primary" onClick={handleAddClass}>
            {editingIndex !== null ? 'Save' : 'Add'}
          </CButton>
        </CModalFooter>
      </CModal>
      
      {/* Reset modal */}
      <CModal visible={showResetModal} onClose={() => setShowResetModal(false)}>
        <CModalHeader closeButton>Confirm Reset</CModalHeader>
        <CModalBody>
          Are you sure you want to reset? This will delete all classification results and manual annotations from the current H5 file. This action cannot be undone.
        </CModalBody>
        <CModalFooter>
          {/* @ts-ignore */}
          <CButton color="secondary" onClick={() => setShowResetModal(false)}>
            Cancel
          </CButton>
          {/* @ts-ignore */}
          <CButton color="danger" onClick={handleReset}>
            Reset
          </CButton>
        </CModalFooter>
      </CModal>
      
      
      {/* Save modal */}
      <CModal visible={showSaveModal} onClose={() => setShowSaveModal(false)}>
        <CModalHeader closeButton>Save to Cloud</CModalHeader>
        <CModalBody>
          <CFormLabel className="fw-bold">Description:</CFormLabel>
          <CFormTextarea
            rows={3}
            placeholder="Before sync, describe your work please."
            className="mb-3"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <CFormCheck
            className="mt-3"
            label="I wish to make this contribution public."
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
        </CModalBody>
        <CModalFooter>
          {/* @ts-ignore */}
          <CButton color="secondary" onClick={() => setShowSaveModal(false)}>
            Cancel
          </CButton>
          {/* Temporarily commented out upload to cloud functionality */}
          {/*
          <CButton
            color="primary"
            onClick={() => {
              // Add your save logic here
              setShowSaveModal(false);
            }}
          >
            Upload to cloud
          </CButton>
          */}
        </CModalFooter>
      </CModal>

      {/* Review Modal with Active Learning */}
      <CModal 
        visible={showReviewModal} 
        onClose={() => {
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
        size="xl"
        backdrop="static"
        keyboard={false}
      >
        <CModalHeader closeButton>
          <h4>Cell Review & Active Learning - {selectedCell?.cellId}</h4>
        </CModalHeader>
        <CModalBody style={{ maxHeight: '80vh', overflow: 'auto' }}>
          <div className="d-flex">
            {/* Left side - Target cell / Review */}
            <div className="flex-shrink-0" style={{ width: '500px' }}>
              <h5 className="mb-3">Target Cell</h5>
              
              {/* Cell patch display */}
              <div style={{ width: '100%', height: '380px', border: '1px solid #ddd', position: 'relative', backgroundColor: '#f8f9fa' }}>
                {isLoadingReview ? (
                  <div className="d-flex justify-content-center align-items-center h-100">
                    <div className="spinner-border" role="status">
                      <span className="visually-hidden">Loading...</span>
                    </div>
                    <span className="ms-2">Loading cell data...</span>
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
                        backgroundColor: '#f8f9fa',
                        border: '1px solid #dee2e6',
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
                  </div>
                ) : reviewError ? (
                  <div className="d-flex flex-column justify-content-center align-items-center h-100">
                    <div className="text-center">
                      <div className="text-warning mb-3">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                        </svg>
                      </div>
                      <h6 className="text-danger">Error Loading Cell Data</h6>
                      <p className="text-muted mb-3">{reviewError}</p>
                      <Button 
                        className="btn btn-primary btn-sm"
                        onClick={() => selectedCell && fetchCellReviewData(selectedCell)}
                      >
                        Retry
                      </Button>
                    </div>
                  </div>
                ) : !alState?.selectedClass ? (
                  <div className="d-flex flex-column justify-content-center align-items-center h-100" style={{ backgroundColor: '#f8f9fa' }}>
                    <div className="text-center">
                      <div className="text-muted mb-3">
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor" opacity="0.5">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                        </svg>
                      </div>
                      <p className="text-muted">Click cells in the candidate pool on the right for detailed viewing</p>
                      <small className="text-muted">Please first select a cell type</small>
                    </div>
                  </div>
                ) : !selectedCell ? (
                  <div className="d-flex flex-column justify-content-center align-items-center h-100" style={{ backgroundColor: '#f8f9fa' }}>
                    <div className="text-center">
                      <div className="text-muted mb-3">
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor" opacity="0.5">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                        </svg>
                      </div>
                      <p className="text-muted">Click cells in the candidate pool on the right for detailed viewing</p>
                      <small className="text-muted">Select a candidate cell to start review</small>
                    </div>
                  </div>
                ) : (
                  <div className="d-flex justify-content-center align-items-center h-100">
                    <p className="text-muted">No image data available</p>
                  </div>
                )}
              </div>

              {/* Controls */}
              <div className="mt-3">
                {/* Patch Size Control - right side = small patch, left side = large patch */}
                <div className="mb-3">
                  <label className="form-label">
                    View Size (Patch: {calculatePatchSizeFromZoom(alState?.zoom || 90)}px)
                  </label>
                  <input
                    type="range"
                    className="form-range"
                    min="1"
                    max="100"
                    step="1"
                    value={alState?.zoom || 90}
                    onChange={async (e) => {
                      const newZoom = parseFloat(e.target.value);
                      const newPatchSize = calculatePatchSizeFromZoom(newZoom);
                      
                      // Update Redux state
                      dispatch(setZoom(newZoom));
                      
                      // Only re-fetch if we have cached data and different size
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
                        }
                      }
                    }}
                  />
                </div>

                <div className="mb-3">
                  <CFormCheck
                    id="show-contour-review"
                    label="Show contour"
                    checked={showContour}
                    onChange={async (e) => {
                      const newShowContour = e.target.checked;
                      setShowContour(newShowContour);
                      
                      // Use cached data to re-fetch with new contour setting
                      if (cachedCellData && showReviewModal) {
                        const currentZoom = alState?.zoom || 90;
                        const currentPatchSize = calculatePatchSizeFromZoom(currentZoom);
                        
                        try {
                          const cachedCell = {
                            cellId: cachedCellData.cellId,
                            slideId: cachedCellData.slide,
                            centroid: cachedCellData.centroid
                          };
                          const contourType = newShowContour ? 'polygon' : null;
                          await fetchAndPositionCell(cachedCell, cachedCellData.contour, cachedCellData.bounds, currentPatchSize, contourType);
                        } catch (error) {
                        }
                      }
                    }}
                    disabled={!cachedCellData}  // Simplify: only disable if no cached data
                  />
                  {cachedCellData && (
                    <small className="text-success d-block mt-1">
                      Contour available
                    </small>
                  )}
                </div>

                {/* Cell Information */}
                {selectedCell && (
                  <div className="small text-muted">
                    <div>
                      Cell ID: {selectedCell.cellId}
                      {(selectedCell as any).isPreview && (
                        <span className="badge bg-info text-white ms-2" style={{ fontSize: '10px' }}>Preview</span>
                      )}
                    </div>
                    <div>Centroid: ({selectedCell.centroid.x.toFixed(1)}, {selectedCell.centroid.y.toFixed(1)})</div>
                    {reviewData?.pixel_spacing_um && (
                      <div>Resolution: {reviewData.pixel_spacing_um}μm/pixel</div>
                    )}
                    {reviewData?.fov_um && (
                      <div>FOV: ~{reviewData.fov_um.toFixed(1)} μm</div>
                    )}
                  </div>
                )}

                {/* Class List - moved to bottom after cell information */}
                <div className="mt-3">
                  <ClassList
                    nucleiClasses={nucleiClasses || []}
                    selectedClass={alState?.className || null}
                    onSelectClass={(className: string | null) => {
                      const finalSlideId = formattedPath || currentPath || 'unknown';
                      dispatch(setActiveLearningSession({
                        slideId: finalSlideId,
                        className: className
                      }));
                    }}
                  />
                </div>

              </div>
            </div>

            {/* Right side - Active Learning Panel */}
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
                  
                  setSelectedCell(cellData);
                  setPreviewCell(cellData);
                  
                  // Use full setupTargetCellWithMainViewer (not preview)
                  setupTargetCellWithMainViewer(cellData);
                }}
                onPendingCountChange={setPendingReclassificationsCount}
              />
            </ErrorBoundary>
          </div>
        </CModalBody>
        <CModalFooter>
          {/* @ts-ignore */}
          <CButton 
            color="primary"
            onClick={async () => {
              try {
                // Batch processing: submit all pending reclassifications first
                if (activeLearningPanelRef.current) {
                  const pendingCount = activeLearningPanelRef.current.getPendingReclassificationsCount();
                  if (pendingCount > 0) {
                    await activeLearningPanelRef.current.submitPendingReclassifications();
                  }
                }
                
                // Call the active learning service to prepare and save reclassifications
                const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/save-reclassifications-via-existing-api`, {
                  slide_id: formattedPath
                });
                
                if (response.data.code === 0 && response.data.data?.success) {
                  const saveData = response.data.data;
                  
                  if (saveData.count > 0) {
                    // Show success message using new design
                    const successDiv = document.createElement('div');
                    successDiv.style.cssText = `
                      position: fixed;
                      top: 50%;
                      left: 50%;
                      transform: translate(-50%, -50%);
                      background: #effae5;
                      border: 1.5px solid #559974;
                      color: #2e7d32;
                      padding: 20px;
                      border-radius: 4px;
                      z-index: 10000;
                      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                      font-size: 16px;
                      line-height: 1.4;
                      max-width: 400px;
                      min-width: 320px;
                      box-shadow: 0 4px 12px rgba(66, 142, 101, 0.2);
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
                    const newCount = saveData.new_count || 0;
                    const totalCount = saveData.count || 0;
                    const message = newCount > 0 
                      ? `Saved ${newCount} new reclassifications (total: ${totalCount})`
                      : `${totalCount} classifications have been successfully saved.`;
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
                  } else {
                    // Show info message using new design
                    const infoDiv = document.createElement('div');
                    infoDiv.style.cssText = `
                      position: fixed;
                      top: 50%;
                      left: 50%;
                      transform: translate(-50%, -50%);
                      background: #eaf1f7;
                      border: 1.5px solid #6d94c5;
                      color: #1565c0;
                      padding: 20px;
                      border-radius: 4px;
                      z-index: 10000;
                      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                      font-size: 16px;
                      line-height: 1.4;
                      max-width: 400px;
                      min-width: 320px;
                      box-shadow: 0 4px 12px rgba(25, 118, 210, 0.2);
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
                  const errorMsg = response.data.data?.error || response.data.message || 'Unknown error';
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
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    font-size: 16px;
                    line-height: 1.4;
                    max-width: 400px;
                    min-width: 320px;
                    box-shadow: 0 4px 12px rgba(225, 68, 52, 0.2);
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
                  textDiv.innerHTML = `<div><strong>Save Failed</strong></div><div style="margin-top: 4px;">${errorMsg}</div>`;

                  errorDiv.appendChild(iconDiv);
                  errorDiv.appendChild(textDiv);
                  document.body.appendChild(errorDiv);
                  setTimeout(() => errorDiv.remove(), 4000);
                }
                
              } catch (error: any) {
                const errorMsg = error.response?.data?.message || error.message || 'Network error';
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
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  font-size: 16px;
                  line-height: 1.4;
                  max-width: 400px;
                  min-width: 320px;
                  box-shadow: 0 4px 12px rgba(225, 68, 52, 0.2);
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
            style={{ 
              backgroundColor: '#7965C1', 
              borderColor: '#7965C1', 
              color: 'white',
              marginRight: '8px' 
            }}
          >
            Update {pendingReclassificationsCount > 0 && `(${pendingReclassificationsCount} pending)`}
          </CButton>
          {/* @ts-ignore */}
          <CButton 
            color="secondary" 
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
                
                // Save all reclassifications to H5 file
                const saveResponse = await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/save-reclassifications-via-existing-api`, {
                  slide_id: formattedPath
                });
                
                if (saveResponse.data.code === 0 && saveResponse.data.data?.success && saveResponse.data.data?.count > 0) {
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
          </CButton>
        </CModalFooter>
      </CModal>

    </div>
  );
};  