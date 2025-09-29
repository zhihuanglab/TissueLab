"use client";
import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { LineGeometry } from '@annotorious/annotorious';
import { AnnotationBody, AnnotationState, ImageAnnotation, ShapeType } from '@annotorious/react';
// OpenSeadragon  will be dynamically imported to avoid SSR issues
import dynamic from 'next/dynamic';
import LoadingSpinner from '@/components/ImageViewer/ToolBox/LoadingSpinner';
import DrawingOverlay from "@/components/ImageViewer/DrawingOverlay";
import PatchOverlay from "@/components/ImageViewer/PatchOverlay";
import { debounce } from 'lodash';
import ReactDOM from 'react-dom';

// UI
import { LiaDrawPolygonSolid } from "react-icons/lia";
import { PiRectangle } from "react-icons/pi";
import { FiMove } from "react-icons/fi";
//import { LuUndo } from "react-icons/lu";
import { LuRuler } from "react-icons/lu";
//import { IoFilter } from "react-icons/io5";
import { Mouse, Monitor, Search, FileText } from "lucide-react";

// functions
import { createInstance } from "@/utils/file.service";
import { UserSelectAction } from '@annotorious/react';

// redux
import { useDispatch, useSelector } from "react-redux";
import { RootState, store } from "@/store";
import { setCurrentPath, setTotalChannels, setSlideInfo } from "@/store/slices/svsPathSlice";
import { resetShapeData, setShapeData, RectangleCoords } from "@/store/slices/shapeSlice";
import { setClassificationEnabled, classificationRequestComplete } from '@/store/slices/annotationSlice';

import { setTool } from '@/store/slices/toolSlice';
import { addWSIInstance } from '@/store/slices/wsiSlice';
import {
  setNucleiClasses,
  setAnnotationType,
  clearAnnotationTypes,
  setPatchOverlays,
  clearPatchOverlays,
  clearPatchOverrides,
  selectPatchOverlays,
} from '@/store/slices/annotationSlice';
import { AppDispatch } from "@/store";
import EventBus from "@/utils/EventBus"

//custom components
import useAnnotatorInitialization from "@/hooks/useAnnotatorInitialization";
import useOpenSeadragonViewerEvents from "@/hooks/useOpenSeadragonViewerEvents";
// Temporarily disabled viewport sync functionality
// import useViewportSync from "@/hooks/useViewportSync";
import { useOpenSeadragonGestures } from "@/hooks/useOpenSeadragonGestures";

// hashing function
import xxhash from "xxhash-wasm";

import Cookies from 'js-cookie';

import { setAnnotations, setPatchClassificationData } from "@/store/slices/annotationSlice";
import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { useWebGLCleanup } from '@/hooks/useWebGLCleanup';
import { webglContextManager } from '@/utils/webglContextManager';
import { useViewerSettings } from '@/hooks/useViewerSettings';

import OSDNavigator from "@/components/ImageViewer/OSDNavigator";
import { AI_SERVICE_API_ENDPOINT, AI_SERVICE_SOCKET_ENDPOINT } from '@/constants/config';

// Workflow utility
import { getDefaultOutputPath, triggerClassificationWorkflow } from "@/utils/workflowUtils";
const ZOOM_SCALE = 16;

// dynamic import packages
const OpenSeadragonAnnotator = dynamic(() =>
  import('@annotorious/react').then(mod => mod.OpenSeadragonAnnotator), { ssr: false }
)
const OpenSeadragonAnnotationPopup = dynamic(() =>
  import('@annotorious/react').then(mod => mod.OpenSeadragonAnnotationPopup), { ssr: false }
)
const OpenSeadragonViewer = dynamic(() =>
  import('@annotorious/react').then(mod => mod.OpenSeadragonViewer), { ssr: false }
)
import '@annotorious/react/annotorious-react.css';
import AnnotationPopup from "@/components/ImageViewer/ToolBox/AnnotationPopup";
import http from "@/utils/http"; // centralized http client
import { useWs } from "@/contexts/WsProvider"; // Re-add useWs import
import { message } from 'antd';
import { useShortcuts } from '@/hooks/useShortcuts';

const OpenSeadragonContainer: React.FC<{ instanceId?: string }> = ({ instanceId }) => {
  const [tileSource, setTileSource] = useState<any>(null);
  const [options, setOptions] = useState<any>(null);
  const [headerHeight, setHeaderHeight] = useState(104);
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const lastResetTimestampRef = useRef<number>(0);
  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  
  // Instance cleanup is handled at page-level; avoid duplicate scheduling here
  
  // Use WebGL cleanup hook
  useWebGLCleanup(instanceId || undefined);

  // Load viewer settings from localStorage on component mount
  const { zoomSpeed, trackpadGesture, showNavigator, toggleShowNavigator } = useViewerSettings();

  const [showPatches, setShowPatches] = useState(false);
  // Access viewer instance early to avoid use-before-declare
  const { setAnnotatorInstance, viewerInstance, setViewerInstance, setInstanceId } = useAnnotatorInstance();

  // Create and manage a controlled overlay host inside OSD canvas
  useEffect(() => {
    const canvas = (viewerInstance?.canvas as HTMLElement | undefined) || null;

    if (!canvas) {
      return;
    }

    const host = document.createElement('div');
    host.style.position = 'absolute';
    host.style.top = '0';
    host.style.left = '0';
    host.style.width = '100%';
    host.style.height = '100%';
    host.style.pointerEvents = 'none';
    host.dataset.tlOverlayHost = '1';

    const placeBeforeAnnotorious = () => {
      const annotoriousGl = canvas.querySelector('.a9s-gl-canvas');
      const annotoriousCanvas = canvas.querySelector('.a9s-canvas');
      const reference = (annotoriousCanvas as Node) || (annotoriousGl as Node) || null;

      if (reference) {
        if (reference.previousSibling !== host) {
          canvas.insertBefore(host, reference);
        }
      } else if (canvas.firstChild !== host) {
        canvas.insertBefore(host, canvas.firstChild);
      }
    };

    // Initial placement
    placeBeforeAnnotorious();

    // Observe future changes to keep order stable
    const observer = new MutationObserver(() => {
      placeBeforeAnnotorious();
    });
    observer.observe(canvas, { childList: true });

    overlayHostRef.current = host;

    return () => {
      observer.disconnect();
      if (host.parentNode) host.parentNode.removeChild(host);
      overlayHostRef.current = null;
    };
  }, [viewerInstance]);
  
  // Image settings: Adjustment Layer
  // Listen to image settings changes and apply to OpenSeadragon canvas
  const imageSettings = useSelector((state: RootState) => state.imageSettings);
  useEffect(() => {
    if (!viewerInstance) return;

    const canvasContainer = viewerInstance.canvas as HTMLElement;
    if (!canvasContainer) return;

    // Find the main OpenSeadragon image canvas (the first canvas element)
    // This is the actual image rendering canvas, not the container
    const mainImageCanvas = canvasContainer.querySelector('canvas:first-of-type') as HTMLCanvasElement;
    if (!mainImageCanvas) return;

    // Apply CSS filter effect
    const applyImageFilters = () => {
      const { brightness, contrast, saturation, sharpness, gamma } = imageSettings;
      
      // Convert percentage values to CSS filter values
      const brightnessValue = (brightness / 50) - 1; // 50% = 1, 0% = -1, 100% = 1
      const contrastValue = (contrast / 50); // 50% = 1, 0% = 0, 100% = 2
      const saturationValue = (saturation / 50); // 50% = 1, 0% = 0, 100% = 2
      
      // Improved sharpness implementation using contrast and brightness combination
      // Sharpness > 50: increase contrast and slight brightness boost
      // Sharpness < 50: decrease contrast and slight brightness reduction
      let sharpnessContrastMultiplier = 1;
      let sharpnessBrightnessOffset = 0;
      
      if (sharpness > 50) {
        // Increase sharpness: boost contrast and slight brightness
        const sharpnessFactor = (sharpness - 50) / 50; // 0 to 1
        sharpnessContrastMultiplier = 1 + (sharpnessFactor * 0.5); // 1 to 1.5
        sharpnessBrightnessOffset = sharpnessFactor * 0.1; // 0 to 0.1
      } else if (sharpness < 50) {
        // Decrease sharpness: reduce contrast and slight brightness
        const sharpnessFactor = (50 - sharpness) / 50; // 0 to 1
        sharpnessContrastMultiplier = 1 - (sharpnessFactor * 0.3); // 1 to 0.7
        sharpnessBrightnessOffset = -sharpnessFactor * 0.05; // 0 to -0.05
      }
      
      // For gamma, we need to use a different method, because CSS filter does not support gamma
      // Here we use CSS filter: contrast() to approximate the gamma effect
      let finalContrastValue = contrastValue;
      if (gamma !== 1) {
        const gammaContrast = Math.pow(gamma, 0.5); // Approximate gamma effect
        finalContrastValue *= gammaContrast;
      }
      
      // Apply sharpness effects to contrast and brightness
      finalContrastValue *= sharpnessContrastMultiplier;
      const finalBrightnessValue = 1 + brightnessValue + sharpnessBrightnessOffset;
      
      // Build CSS filter string
      const filters = [
        `brightness(${finalBrightnessValue})`,
        `contrast(${finalContrastValue})`,
        `saturate(${saturationValue})`,
        `hue-rotate(0deg)`, // Keep hue unchanged
      ].filter(Boolean).join(' ');

      // Apply filter only to the main image canvas, not the container
      mainImageCanvas.style.filter = filters;
    };

    applyImageFilters();
  }, [viewerInstance, imageSettings]);

  // Viewer height calculation
  useEffect(() => {
    const isElectron = typeof window !== 'undefined' && 
                     (window.navigator.userAgent.includes('Electron') || !!window.electron);
    const isWindows = navigator.userAgent.toLowerCase().includes('win');
    
    if (isElectron && isWindows) {
      // Windows Electron needs special handling due to larger titlebar overlay
      setHeaderHeight(96);
    } else {
      // Web version and macOS Electron use the same height
      setHeaderHeight(104);
    }
  }, []);

  // Get the current instance's WSI info - fully dependent on instance state
  const currentWSIInfo = useSelector((state: RootState) => {
    if (instanceId && state.wsi.instances[instanceId]) {
      return state.wsi.instances[instanceId].wsiInfo;
    }
    // If no instance is found, return null instead of global state
    return null;
  });
  
  const currentWSIFileInfo = useSelector((state: RootState) => {
    if (instanceId && state.wsi.instances[instanceId]) {
      return state.wsi.instances[instanceId].fileInfo;
    }
    // If no instance is found, return null instead of global state
    return null;
  });

  const visibleChannels = useSelector((state: RootState) => {
    return state.svsPath.visibleChannels;
  });

  const channels = useSelector((state: RootState) => state.svsPath.channels);

  // Get current path for file type checking
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);

  // Get slide info for MPP calculation
  const slideInfo = useSelector((state: RootState) => state.svsPath.slideInfo);

  // Function to convert microns to appropriate unit
  const convertToAppropriateUnit = (microns: number) => {
    if (microns >= 1000000) {
      return { value: microns / 1000000, unit: 'm' };
    } else if (microns >= 10000) {
      return { value: microns / 10000, unit: 'cm' };
    } else if (microns >= 1000) {
      return { value: microns / 1000, unit: 'mm' };
    } else {
      return { value: microns, unit: 'µm' };
    }
  };

  // toolkit
  const [hoveredTool, setHoveredTool] = useState<string | undefined | null>(null);
  const toolkitItems = useMemo(() => [
    { name: "Move", tool: "move", icon: <FiMove size={22} strokeWidth={1.5} /> },
    { name: "Polygon", tool: "polygon", icon: <LiaDrawPolygonSolid size={22} /> },
    { name: "Rectangle", tool: "rectangle", icon: <PiRectangle size={22} /> },
    { name: "Ruler", tool: "line", icon: <LuRuler size={22} /> },
    //{ name: "Undo", tool: undefined, icon: <LuUndo size={22} /> },
    //{ name: "Filter", tool: undefined, icon: <IoFilter size={22} /> }
  ], []);

  // reloading related
  const [isUploading, setIsUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const textRef = useRef(null);

  // hide/show state
  const [showBackendAnnotations, setShowBackendAnnotations] = useState(false);
  const [showUserAnnotations, setShowUserAnnotations] = useState(true);
  const [existAnnotationFile, setExistAnnotationFile] = useState(false);
  
  // Track current request type for appropriate error messages
  const [currentRequestType, setCurrentRequestType] = useState<'space' | 'x' | 'other' | null>(null);

  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses);
  const annotationTypes = useSelector((state: RootState) => state.annotations.annotationTypeMap);
  const activeManualClassificationClass = useSelector((state: RootState) => state.annotations.activeManualClassificationClass);
  const updateAfterEveryAnnotation = useSelector((state: RootState) => state.workflow.updateAfterEveryAnnotation);
  const currentSvsPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const currentOrgan = useSelector((state: RootState) => state.workflow.currentOrgan);
  const isRunning = useSelector((state: RootState) => state.workflow.isRunning);
  const currentTool = useSelector((state: RootState) => state.tool.currentTool);

  const dynamicDrawingEnabled = showUserAnnotations && currentTool !== 'move';

  // Ref to hold the latest activeManualClassificationClass
  const activeManualClassificationClassRef = useRef(activeManualClassificationClass);

  useEffect(() => {
    activeManualClassificationClassRef.current = activeManualClassificationClass;
  }, [activeManualClassificationClass]);

  const annotationFilter = useCallback((annotation: { isBackend: any; }) => {
    const isImageFile = currentPath &&
      (currentPath.toLowerCase().endsWith('.png') ||
        currentPath.toLowerCase().endsWith('.jpg') ||
        currentPath.toLowerCase().endsWith('.jpeg') ||
        currentPath.toLowerCase().endsWith('.bmp'));

    if (isImageFile) {
      if (!showBackendAnnotations && annotation.isBackend) return false;
      if (!showUserAnnotations && !annotation.isBackend) return false;
      return true;
    }

    if (!showBackendAnnotations && annotation.isBackend) {
      return false;
    }

    if (!showUserAnnotations && !annotation.isBackend) {
      return false;
    }

    return true;
  }, [showBackendAnnotations, showUserAnnotations, currentPath]);

  // Current ROI selection (rectangle or polygon) for ROI-aware styling
  const shapeData = useSelector((state: RootState) => state.shape.shapeData);

  // threshold
  const threshold = useSelector((state: RootState) => state.annotations.threshold);
  const polygon_threshold = useSelector((state: RootState) => state.annotations.polygon_threshold);

  const dispatch = useDispatch();

  // initialize annotator
  const { annotatorInstance, viewerRef } = useAnnotatorInitialization();

  // Get current instance id
  const currentInstanceId = instanceId;

  // Validate instance data completeness
  useEffect(() => {
    if (instanceId && (!currentWSIInfo || !currentWSIFileInfo)) {
      console.warn(`Instance ${instanceId} is missing WSI data:`, {
        hasWSIInfo: !!currentWSIInfo,
        hasFileInfo: !!currentWSIFileInfo
      });
    }
  }, [instanceId, currentWSIInfo, currentWSIFileInfo]);

  // websocket
  const { socket, status } = useWs(`${AI_SERVICE_SOCKET_ENDPOINT}/segment/`);
  // centorids
  const [centroids, setCentroids] = useState<Array<[number, number, number, number]>>([]);
  const patches = useSelector(selectPatchOverlays);
  const updateCentroids = useCallback((newCentroids: Array<[number, number, number, number]>) => {
    setCentroids(newCentroids);
  }, []);

  const updateRenderingAnnotations = (newAnnotations: any[]) => {
    setRenderingAnnotations(newAnnotations);
  };

  // mouse position feature state
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [imageBounds, setImageBounds] = useState({ x1: 0, y1: 0, x2: 0, y2: 0 });
  const [magnification, setMagnification] = useState(1);

  const [allTilesLoaded, setAllTilesLoaded] = useState(false);
  const [loadingAnnotations, setLoadingAnnotations] = useState(false);

  // For manual double-click detection on Annotorious annotations
  const lastClickTimestampRef = useRef<number>(0);
  const lastClickedAnnotationIdRef = useRef<string | null>(null);
  const DOUBLE_CLICK_THRESHOLD_MS = 500; // Milliseconds
  // For single-click delay to avoid conflict with double-click
  const singleClickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // new state for classification data
  const [classificationData, setClassificationData] = useState<{
    nuclei_class_id: number[],
    nuclei_class_name: string[],
    nuclei_class_HEX_color: string[]
  } | null>(null);

  // new state for using classification or not
  const classificationEnabled = useSelector((state: RootState) => state.annotations.classificationEnabled);

  const [renderingAnnotations, setRenderingAnnotations] = useState<any[]>([]);

  // State for ruler hover tooltip
  const [rulerTooltip, setRulerTooltip] = useState<{
    visible: boolean;
    text: string;
    position: { x: number; y: number };
  }>({
    visible: false,
    text: '',
    position: { x: 0, y: 0 }
  });

  // Ref to track tooltip visibility to avoid unnecessary re-creation of event handlers
  const tooltipVisibleRef = useRef(false);

  const lastRequestTimeRef = useRef(0);

  // Retry mechanism to confirm H5 presence before showing errors for Space/X
  const errorConfirmTimersRef = useRef<{ space: ReturnType<typeof setTimeout> | null; x: ReturnType<typeof setTimeout> | null }>({ space: null, x: null });
  const errorConfirmAttemptsRef = useRef<{ space: number; x: number }>({ space: 0, x: 0 });
  const lastWorkflowRefreshTsRef = useRef<number>(0);
  const quickSpaceFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check current UI/data state to decide if we should suppress errors
  const hasRenderableSegmentationData = useCallback(() => {
    try {
      const backendAnns = annotatorInstance ? (annotatorInstance.getAnnotations().filter((a: any) => a && a.isBackend) || []) : [];
      return !!(existAnnotationFile || (backendAnns.length > 0) || (centroids && centroids.length > 0) || (renderingAnnotations && renderingAnnotations.length > 0));
    } catch (e) {
      return !!existAnnotationFile;
    }
  }, [annotatorInstance, existAnnotationFile, centroids, renderingAnnotations]);

  const requestViewportDataForType = useCallback((reqType: 'space' | 'x') => {
    if (!viewerInstance || !socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      const viewportBounds = viewerInstance.viewport.getBounds();
      const topLeft = viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
      const bottomRight = viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());
      const x1 = Math.round(topLeft.x / ZOOM_SCALE);
      const y1 = Math.round(topLeft.y / ZOOM_SCALE);
      const x2 = Math.round(bottomRight.x / ZOOM_SCALE);
      const y2 = Math.round(bottomRight.y / ZOOM_SCALE);

      if (reqType === 'x') {
        socket.send(JSON.stringify({ x1, y1, x2, y2, type: 'patches' }));
        return;
      }

      const isImageFile = currentPath && (
        currentPath.toLowerCase().endsWith('.png') ||
        currentPath.toLowerCase().endsWith('.jpg') ||
        currentPath.toLowerCase().endsWith('.jpeg') ||
        currentPath.toLowerCase().endsWith('.bmp')
      );

      const zoom = viewerInstance.viewport.getZoom();
      let req: 'annotations' | 'all_annotations' | 'centroids' = 'annotations';
      if (isImageFile) {
        req = 'annotations';
      } else if (zoom >= threshold) {
        req = 'annotations';
      } else if (zoom >= polygon_threshold) {
        req = 'all_annotations';
      } else {
        req = 'centroids';
      }
      socket.send(JSON.stringify({ x1, y1, x2, y2, type: req, use_classification: classificationEnabled }));
    } catch (e) {
      console.warn('[Retry] Failed to send viewport request during confirmation:', e);
    }
  }, [viewerInstance, socket, currentPath, threshold, polygon_threshold, classificationEnabled]);

  const confirmH5MissingThenNotify = useCallback((reqType: 'space' | 'x', msgText: string) => {
    // Only retry briefly if a workflow just refreshed path; otherwise, show error immediately
    const now = Date.now();
    const withinRecentRefresh = now - lastWorkflowRefreshTsRef.current < 8000;

    // If UI already has data (e.g., workflow completed and layers visible), suppress error
    if (hasRenderableSegmentationData()) {
      setCurrentRequestType(null);
      return;
    }

    if (!withinRecentRefresh) {
      message.error(msgText);
      setCurrentRequestType(null);
      return;
    }

    const MAX_TRIES = 1;
    const DELAY_MS = 400;

    if (errorConfirmTimersRef.current[reqType]) return; // already confirming

    // Cancel quick fallback if it's running to avoid duplicate toasts
    if (reqType === 'space' && quickSpaceFallbackTimerRef.current) {
      clearTimeout(quickSpaceFallbackTimerRef.current as unknown as number);
      quickSpaceFallbackTimerRef.current = null;
    }

    errorConfirmAttemptsRef.current[reqType] = 0;

    const attempt = () => {
      errorConfirmAttemptsRef.current[reqType] += 1;
      requestViewportDataForType(reqType);

      errorConfirmTimersRef.current[reqType] = setTimeout(() => {
        const attempts = errorConfirmAttemptsRef.current[reqType];

        if (existAnnotationFile) {
          // Data arrived; cancel and reset
          if (errorConfirmTimersRef.current[reqType]) {
            clearTimeout(errorConfirmTimersRef.current[reqType] as unknown as number);
            errorConfirmTimersRef.current[reqType] = null;
          }
          errorConfirmAttemptsRef.current[reqType] = 0;
          setCurrentRequestType(null);
          return;
        }

        if (attempts < MAX_TRIES) {
          attempt();
        } else {
          message.error(msgText);
          setCurrentRequestType(null);
          if (errorConfirmTimersRef.current[reqType]) {
            clearTimeout(errorConfirmTimersRef.current[reqType] as unknown as number);
            errorConfirmTimersRef.current[reqType] = null;
          }
          errorConfirmAttemptsRef.current[reqType] = 0;
        }
      }, DELAY_MS);
    };

    attempt();
  }, [existAnnotationFile, requestViewportDataForType, hasRenderableSegmentationData]);

  const handleLoadClassification = useCallback(async () => {
    if (!currentPath) {
      console.log("No currentPath, cannot load classification");
      return;
    }

    const managerUrl = `${AI_SERVICE_API_ENDPOINT}/seg/v1/classifications?file_path=${encodeURIComponent(currentPath)}`;

    try {
      const resp = await http.get(managerUrl);

      const responseData = resp.data.data || resp.data;
      console.log("backend Classification data++++++:", responseData);

      if (responseData && responseData.nuclei_class_name && responseData.nuclei_class_HEX_color && responseData.nuclei_class_id) {
        const { nuclei_class_name, nuclei_class_HEX_color, nuclei_class_id } = responseData;

        // Get the current classes from Redux to preserve local additions and counts
        const currentNucleiClasses = store.getState().annotations.nucleiClasses;

        // Create a representation of the server data
        const serverClasses = nuclei_class_name.map((rawName: string, index: number) => {
          const name = typeof rawName === 'string' ? rawName : String(rawName ?? '');
          return {
            name,
            color: nuclei_class_HEX_color[index],
            count: 0,
            persisted: true,
          };
        });


        // Merge server classes with local classes
        const finalClasses = [...serverClasses];
        currentNucleiClasses.forEach(localClass => {
          if (!finalClasses.some(finalClass => finalClass.name === localClass.name)) {
            finalClasses.push(localClass);
          }
        });

        // Restore counts for all classes from the pre-update local state
        const finalClassesWithCounts = finalClasses.map(cls => {
          const existingClass = currentNucleiClasses.find(c => c.name === cls.name);
          return { ...cls, count: existingClass ? existingClass.count : 0, persisted: cls.persisted ?? existingClass?.persisted ?? true };
        });

        dispatch(setNucleiClasses(finalClassesWithCounts));

        const newAnnotationTypeMapPayload = nuclei_class_id.map((id_val: number, index: number) => {
          const classIndexForMap = nuclei_class_id[index];

          return {
            id: String(index),
            classIndex: classIndexForMap,
            color: nuclei_class_HEX_color[classIndexForMap],
            category: nuclei_class_name[classIndexForMap],
          };
        });
        dispatch(setAnnotationType(newAnnotationTypeMapPayload));
        setClassificationData(responseData);
        dispatch(setClassificationEnabled(true)); // Set to true since data is available
      } else {
        setClassificationData(null);
        dispatch(setClassificationEnabled(false)); // Disable classification if no H5 data, but keep UI state
        // Also clear any stale per-cell overrides
        dispatch(clearAnnotationTypes());
      }

    } catch (err) {
      setClassificationData(null);
      dispatch(setClassificationEnabled(false));
      // Also clear any stale per-cell overrides on error
      dispatch(clearAnnotationTypes());
    }

    await refreshPatchClassificationData();
  }, [currentPath, dispatch]); // eslint-disable-line react-hooks/exhaustive-deps

  // pass the new state to the hook
  const { resetQueryFlag } = useOpenSeadragonViewerEvents(
    viewerInstance,
    annotatorInstance,
    socket,
    status,
    updateCentroids,
    showBackendAnnotations,
    showUserAnnotations,
    showPatches,
    setLoadingAnnotations,
    renderingAnnotations,
    updateRenderingAnnotations
  );

  // Initialize viewport sync hook - temporarily disabled
  // useViewportSync(viewerRef);

  // --- Unified Count Update Logic ---
  const updateCountsFromBackend = useCallback((counts: Record<string, number>) => {
      // If the incoming counts object is empty, do nothing. This prevents flicker during panning.
      if (Object.keys(counts).length === 0) {
        // console.log("[WS COUNTS] Received empty counts object, ignoring to prevent flicker.");
        return;
      }

    const currentNucleiClasses = store.getState().annotations.nucleiClasses;
    if (!currentNucleiClasses || currentNucleiClasses.length === 0) return;

    const updatedNucleiClasses = currentNucleiClasses.map((cls, idx) => {
      // The index of the nucleiClasses array corresponds to the backend class_id.
      const classId = String(idx);
      const newCount = counts[classId] || 0; // Default to 0 if not in payload
      return { ...cls, count: newCount };
    });

    // Basic check to prevent redundant dispatches if counts haven't changed
    if (JSON.stringify(currentNucleiClasses.map(c => c.count)) !== JSON.stringify(updatedNucleiClasses.map(c => c.count))) {
      dispatch(setNucleiClasses(updatedNucleiClasses));
      console.log(`[WS COUNTS] Updated nuclei class counts from backend.`, counts);
    }
  }, [dispatch]);

  const refreshPatchClassificationData = useCallback(async () => {
    const getDefaultPatchData = () => ({
      class_id: [0],
      class_name: ['Negative control'],
      class_hex_color: ['#aaaaaa'],
      class_counts: [0],
    });

    const coerceCountsArray = (values: any, targetLength: number) => {
      if (!Array.isArray(values)) {
        return new Array(targetLength).fill(0);
      }
      return values.map((value: any) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : 0;
      });
    };

    try {
      const response = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/patch_classification`);
      const payload = response.data?.data ?? response.data;

      if (payload && Array.isArray(payload.class_name) && payload.class_name.length > 0) {
        const currentPatchData = store.getState().annotations.patchClassificationData;

        const serverData = {
          class_id: Array.isArray(payload.class_id) ? [...payload.class_id] : [],
          class_name: [...payload.class_name],
          class_hex_color: Array.isArray(payload.class_hex_color) ? [...payload.class_hex_color] : new Array(payload.class_name.length).fill('#aaaaaa'),
          class_counts: coerceCountsArray(payload.class_counts, payload.class_name.length),
        };

        if (currentPatchData && currentPatchData.class_name) {
          currentPatchData.class_name.forEach((localName, index) => {
            const existingIndex = serverData.class_name.findIndex((name) => name === localName);
            if (existingIndex === -1) {
              const numericIds = serverData.class_id
                .map((val) => (Number.isFinite(Number(val)) ? Number(val) : null))
                .filter((val) => val !== null) as number[];
              const nextId = numericIds.length > 0 ? Math.max(...numericIds) + 1 : serverData.class_name.length;
              serverData.class_name.push(localName);
              serverData.class_hex_color.push(currentPatchData.class_hex_color[index]);
              serverData.class_id.push(nextId);
              const fallbackCount = currentPatchData.class_counts?.[index] ?? 0;
              serverData.class_counts.push(Number.isFinite(Number(fallbackCount)) ? Number(fallbackCount) : 0);
            } else if (serverData.class_counts[existingIndex] === undefined) {
              const fallbackCount = currentPatchData.class_counts?.[index] ?? 0;
              serverData.class_counts[existingIndex] = Number.isFinite(Number(fallbackCount)) ? Number(fallbackCount) : 0;
            }
          });
        }

        if (serverData.class_counts.length < serverData.class_name.length) {
          serverData.class_counts = [
            ...serverData.class_counts,
            ...new Array(serverData.class_name.length - serverData.class_counts.length).fill(0),
          ];
        }

        dispatch(setPatchClassificationData(serverData));
      } else {
        const fallback = store.getState().annotations.patchClassificationData;
        if (fallback && fallback.class_name.length > 0) {
          dispatch(setPatchClassificationData(fallback));
        } else {
          dispatch(setPatchClassificationData(getDefaultPatchData()));
        }
      }
    } catch (error) {
      console.error('Failed to refresh patch classification data:', error);
      const fallback = store.getState().annotations.patchClassificationData;
      if (fallback && fallback.class_name.length > 0) {
        dispatch(setPatchClassificationData(fallback));
      } else {
        dispatch(setPatchClassificationData(getDefaultPatchData()));
      }
    }
  }, [dispatch]);
    
  // --- End of Unified Logic ---

  const handleFullyLoadedChange = useCallback((event: any) => {
    const isFullyLoaded = event.fullyLoaded;
    console.log('Tile loaded event triggered:', { isFullyLoaded, event });
    setAllTilesLoaded(isFullyLoaded);
    if (isFullyLoaded) {
      console.log('All tiles fully loaded!');
    }
  }, []);

  const handleAddItem = useCallback((event: any) => {
    const tiledImage = event.item;
    // bind fully-loaded-change event
    tiledImage.addHandler('fully-loaded-change', handleFullyLoadedChange);
    setAllTilesLoaded(false);
  }, [handleFullyLoadedChange]);

  const handleRemoveItem = useCallback((event: any) => {
    const tiledImage = event.item;
    // remove event listener
    tiledImage.removeHandler('fully-loaded-change', handleFullyLoadedChange);
  }, [handleFullyLoadedChange]);

  useEffect(() => {
    if (viewerInstance) {
      const viewer = viewerInstance;
      console.log('Binding tile loaded events to viewer:', { 
        viewerExists: !!viewer, 
        worldExists: !!viewer.world, 
        itemCount: viewer.world.getItemCount() 
      });

      // listen to add and remove item events in world
      viewer.world.addHandler('add-item', handleAddItem);
      viewer.world.addHandler('remove-item', handleRemoveItem);

      // add event listener to existing tiledImage
      for (let i = 0; i < viewer.world.getItemCount(); i++) {
        const tiledImage = viewer.world.getItemAt(i);
        console.log(`Binding fully-loaded-change event to tiledImage ${i}`);
        tiledImage.addHandler('fully-loaded-change', handleFullyLoadedChange);
      }

      return () => {
        try {
          if (viewer && viewer.world) {
            // clean up world event listener
            viewer.world.removeHandler('add-item', handleAddItem);
            viewer.world.removeHandler('remove-item', handleRemoveItem);
            // clean up all tiledImage event listener
            for (let i = 0; i < viewer.world.getItemCount(); i++) {
              const tiledImage = viewer.world.getItemAt(i);
              tiledImage.removeHandler('fully-loaded-change', handleFullyLoadedChange);
            }
          }
        } catch (error) {
          console.warn('Error cleaning up viewer handlers:', error);
        }
      };
    }
  }, [viewerInstance, handleAddItem, handleRemoveItem, handleFullyLoadedChange]);

  useEffect(() => {
    console.log('[container] instances changed:', annotatorInstance);
    if (annotatorInstance) {
      console.log('[container] annotatorInstance:', annotatorInstance);
      console.log('[container] annotatorInstance.viewer:', annotatorInstance?.viewer);
      // Store the annotatorInstance in context
      setAnnotatorInstance(annotatorInstance);
    }
  }, [annotatorInstance, setAnnotatorInstance]);

  // Track annotations being updated to prevent infinite loops
  const updatingAnnotationsRef = useRef(new Set<string>());
  
  // Debounce shape coordinate dispatching to prevent infinite loops
  const shapeDispatchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // set dynamic setStyle for annotatorInstance (ROI-aware yellow border highlight)
  useEffect(() => {
    if (annotatorInstance) {
      annotatorInstance.setStyle((annotation: ImageAnnotation, state: AnnotationState) => {
        // does this annotation have a style body in redux?
        const annotationType = annotationTypes[annotation.id];

        // Helper utilities for ROI-aware highlight
        const rectContainsPoint = (x: number, y: number) => {
          const rect = shapeData?.rectangleCoords;
          if (!rect) return false;
          const rx1 = rect.x1 * ZOOM_SCALE;
          const ry1 = rect.y1 * ZOOM_SCALE;
          const rx2 = rect.x2 * ZOOM_SCALE;
          const ry2 = rect.y2 * ZOOM_SCALE;
          const minX = Math.min(rx1, rx2);
          const maxX = Math.max(rx1, rx2);
          const minY = Math.min(ry1, ry2);
          const maxY = Math.max(ry1, ry2);
          return x >= minX && x <= maxX && y >= minY && y <= maxY;
        };

        const polyContainsPoint = (x: number, y: number) => {
          const poly = shapeData?.polygonPoints;
          if (!poly || poly.length < 3) return false;
          // Scale ROI polygon up to the Annotorious/image coord space
          const pts = poly.map(p => [p[0] * ZOOM_SCALE, p[1] * ZOOM_SCALE] as [number, number]);
          let inside = false;
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i][0], yi = pts[i][1];
            const xj = pts[j][0], yj = pts[j][1];
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
            if (intersect) inside = !inside;
          }
          return inside;
        };

        // Centroid-in-rectangle-only rule for ROI
        const roiContainsPoint = (x: number, y: number) => {
          if (!shapeData || !shapeData.rectangleCoords) return false;
          return rectContainsPoint(x, y);
        };

        const selector: any = annotation?.target?.selector;
        const isBackendAnno = (annotation as any)?.isBackend === true;

        // Compute ROI highlight only for backend cell polygons
        let isRoiHighlighted = false;
        if (isBackendAnno && selector?.type === 'POLYGON' && selector?.geometry?.points && shapeData && shapeData.rectangleCoords) {
          const points = selector.geometry.points as [number, number][];
          if (points && points.length > 0) {
            // Only polygon centroid inside rectangle ROI counts
            let cx = 0, cy = 0;
            for (const [px, py] of points) { cx += px; cy += py; }
            cx /= points.length; cy /= points.length;
            isRoiHighlighted = roiContainsPoint(cx, cy);
          }
        }

        if (annotationType) {
          //if this annotation has a style body in redux, use that color
          const existingClassification = annotation.bodies.find(b => b.purpose === 'classification');

          // if the classification body doesn't exist or the value is different, update the annotation
          // BUT only if we're not already updating this annotation (prevent infinite loop)
          if ((!existingClassification || existingClassification.value !== annotationType.category) 
              && !updatingAnnotationsRef.current.has(annotation.id)) {
            
            // Mark this annotation as being updated
            updatingAnnotationsRef.current.add(annotation.id);
            
            const updatedBodies = [
              ...annotation.bodies.filter(b => b.purpose !== 'classification'),
              {
                id: String(Date.now()),
                annotation: annotation.id,
                type: 'TextualBody',
                purpose: 'classification',
                value: annotationType.category,
                created: new Date().toISOString(),
                creator: {
                  id: 'default',
                  type: 'Person'
                }
              }
            ];

            const updatedAnnotation = {
              ...annotation,
              bodies: updatedBodies
            };

            // asynchronously update the annotation
            setTimeout(() => {
              try {
                annotatorInstance.updateAnnotation(updatedAnnotation);
              } finally {
                // Remove from updating set after a delay to allow the update to complete
                setTimeout(() => {
                  updatingAnnotationsRef.current.delete(annotation.id);
                }, 100);
              }
            }, 0);
          }

          // base style
          const baseStyle = {
            fill: annotationType.color,
            fillOpacity: state?.selected || state?.hovered ? 0.6 : 0.4,
            stroke: annotationType.color,
            strokeOpacity: 1,
            strokeWidth: state?.selected || state?.hovered ? 2 : 1
          } as any;

          // ROI-aware yellow contour override
          if (isRoiHighlighted) {
            baseStyle.stroke = '#ffff00';
            baseStyle.strokeWidth = Math.max(baseStyle.strokeWidth || 1, 2);
          }

          return baseStyle;
        }


        // find the color of the annotation
        const styleBody = annotation.bodies.find(b => b.purpose === 'style');
        // get the color from the annotation
        const color = styleBody?.value || '#00ff00';

        // ensure state is not undefined
        const isSelected = state?.selected || false;
        const isHovered = state?.hovered || false;

        // base style
        const style = {
          fill: color,
          fillOpacity: isSelected || isHovered ? 0.6 : 0.4,
          stroke: color,
          strokeOpacity: 1,
          strokeWidth: isSelected || isHovered ? 2 : 1
        };

        // ROI-aware yellow contour override
        if (isRoiHighlighted) {
          (style as any).stroke = '#ffff00';
          (style as any).strokeWidth = Math.max((style as any).strokeWidth || 1, 2);
        }

        return style;
      });
    }
  }, [annotatorInstance, annotationTypes, shapeData]);

  useEffect(() => {
    if (annotatorInstance && viewerInstance) {
      const viewer = viewerInstance;
      const HIGHLIGHT_RESET_GUARD_MS = 150;
      const SHAPE_UPDATE_DEBOUNCE_MS = 50;

      const hasActiveSelection = () => {
        const s = annotatorInstance.getSelected?.();
        return !!(s && s.length > 0);
      };

      const scheduleShapeUpdate = (func: () => void) => {
        if (shapeDispatchTimeoutRef.current) {
          clearTimeout(shapeDispatchTimeoutRef.current);
        }
        shapeDispatchTimeoutRef.current = setTimeout(() => {
          if (Date.now() - lastResetTimestampRef.current < HIGHLIGHT_RESET_GUARD_MS) return;
          if (!hasActiveSelection()) return;
          func();
        }, SHAPE_UPDATE_DEBOUNCE_MS);
      };

      const dispatchShapeCoords = (annotation: ImageAnnotation): RectangleCoords | null => {
        // Guard: avoid dispatch shortly after a reset or when selection is empty
        if (Date.now() - lastResetTimestampRef.current < HIGHLIGHT_RESET_GUARD_MS) return null;
        if (!hasActiveSelection()) return null;
        const selector = annotation.target?.selector;
        if (selector?.type === 'RECTANGLE') {
          const geometry = selector.geometry;
          if (geometry?.bounds) {
            const { minX: rawMinX, minY: rawMinY, maxX: rawMaxX, maxY: rawMaxY } = geometry.bounds;
            const coords = {
              x1: rawMinX / ZOOM_SCALE,
              y1: rawMinY / ZOOM_SCALE,
              x2: rawMaxX / ZOOM_SCALE,
              y2: rawMaxY / ZOOM_SCALE,
            };
            // Debounce shape data dispatching to prevent churn
            scheduleShapeUpdate(() => {
              dispatch(setShapeData({ rectangleCoords: coords }));
            });
            return coords;
          }
        } else if (selector?.type === 'POLYGON') {
          const geometry = selector.geometry;
          if (geometry && (geometry as any).points && (geometry as any).points.length > 0) {
            const rawPoints = (geometry as any).points as [number, number][];
            if (rawPoints.length > 0) {
              let minX = rawPoints[0][0];
              let minY = rawPoints[0][1];
              let maxX = rawPoints[0][0];
              let maxY = rawPoints[0][1];
              for (let i = 1; i < rawPoints.length; i++) {
                minX = Math.min(minX, rawPoints[i][0]);
                minY = Math.min(minY, rawPoints[i][1]);
                maxX = Math.max(maxX, rawPoints[i][0]);
                maxY = Math.max(maxY, rawPoints[i][1]);
              }
              const coords = {
                x1: minX / ZOOM_SCALE,
                y1: minY / ZOOM_SCALE,
                x2: maxX / ZOOM_SCALE,
                y2: maxY / ZOOM_SCALE,
              };
              const polygonPoints = rawPoints.map(p => [p[0] / ZOOM_SCALE, p[1] / ZOOM_SCALE]) as [number, number][];
              // Debounce shape data dispatching to prevent churn
              scheduleShapeUpdate(() => {
                dispatch(setShapeData({ rectangleCoords: coords, polygonPoints: polygonPoints }));
              });
              return coords;
            }
          }
        } else if (selector?.type === 'LINE') {
          const geometry = selector.geometry;
          if (geometry?.bounds) {
            const { minX: rawMinX, minY: rawMinY, maxX: rawMaxX, maxY: rawMaxY } = geometry.bounds;
            const coords = {
              x1: rawMinX / ZOOM_SCALE,
              y1: rawMinY / ZOOM_SCALE,
              x2: rawMaxX / ZOOM_SCALE,
              y2: rawMaxY / ZOOM_SCALE,
            };
            // Debounce shape data dispatching to prevent churn
            scheduleShapeUpdate(() => {
              dispatch(setShapeData({ rectangleCoords: coords }));
            });
            return coords;
          }
        }
        return null;
      };

      const onFinalAnnotation = async (annotation: ImageAnnotation) => {
        // Prevent infinite loops by checking if this annotation is already being processed
        if (updatingAnnotationsRef.current.has(annotation.id)) {
          return;
        }

        // This block handles initializing a brand new annotation
        if (!annotation.bodies || annotation.bodies.length === 0) {
          const creationDate = new Date();
          const updatedAnnotation = {
            ...annotation,
            type: 'Annotation',
            created: creationDate,
            creator: {
              id: 'default',
              type: 'AI'
            },
            bodies: [{
              id: String(Date.now()),
              annotation: annotation.id,
              type: 'TextualBody',
              purpose: 'style',
              value: '#00ff00',
              created: creationDate,
              creator: {
                id: 'default',
                type: 'AI'
              }
            }]
          };
          try {
            await annotatorInstance.updateAnnotation(updatedAnnotation);
            await annotatorInstance.setSelected(updatedAnnotation.id);
            const finalAnnotation = {
              ...updatedAnnotation,
              isBackend: false,
            }
            await annotatorInstance.updateAnnotation(finalAnnotation);
            // Do not dispatch here; selection handler will update highlight
          } catch (error) {
            console.error('Error updating annotation:', error);
          }
        } else {
          // Only update highlight if this annotation is currently selected
          const selected = annotatorInstance.getSelected?.() || [];
          const isSelected = selected.some((a: any) => a?.id === annotation.id) || selectedIdsRef.current.has(annotation.id);
          if (isSelected) {
            dispatchShapeCoords(annotation);
          }
        }
      }

      annotatorInstance.on('createAnnotation', onFinalAnnotation);
      annotatorInstance.on('updateAnnotation', onFinalAnnotation);
      
      // Add real-time selection tracking for immediate highlight updates
      const onSelectAnnotation = (annotation: ImageAnnotation) => {
        const coords = dispatchShapeCoords(annotation);
        if (coords) EventBus.emit('shape-resizing', coords);
      };
      
      annotatorInstance.on('selectAnnotation', onSelectAnnotation);

      // Track selection changes and clear highlight if none
      annotatorInstance.on('selectionChanged', (selected: any[]) => {
        selectedIdsRef.current = new Set((selected || []).map(a => a.id));
        if (!selected || selected.length === 0) {
          lastResetTimestampRef.current = Date.now();
          dispatch(resetShapeData());
        }
      });

      // --- Live-resizing (polygon) with Pointer Events ---
      // Use pointer events so it works with mouse, pen, and touch.
      // Read live geometry from the DOM (<polygon points="…">) because the
      // annotation model is only committed at the end of editing.

      const parsePointsAttr = (attr: string): [number, number][] =>
        attr.trim().split(/\s+/).map(pair => {
          const [x, y] = pair.split(',').map(parseFloat);
          return [x, y] as [number, number];
        });

      const emitLivePolygonFromDOM = (group: SVGGElement) => {
        // Guard: if selection was just cleared, ignore transient DOM updates
        if (Date.now() - lastResetTimestampRef.current < HIGHLIGHT_RESET_GUARD_MS) return;
        if (!hasActiveSelection()) return;
        const poly = group.querySelector('polygon') as SVGPolygonElement | null;
        if (!poly) return;

        const attr = poly.getAttribute('points') || '';
        const raw = parsePointsAttr(attr);
        if (raw.length === 0) return;

        // Compute bounds in OSD image coords
        let minX = raw[0][0], minY = raw[0][1], maxX = raw[0][0], maxY = raw[0][1];
        for (let i = 1; i < raw.length; i++) {
          const [px, py] = raw[i];
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
        }

        const coords = {
          x1: minX / ZOOM_SCALE,
          y1: minY / ZOOM_SCALE,
          x2: maxX / ZOOM_SCALE,
          y2: maxY / ZOOM_SCALE
        };

        const polygonPoints = raw.map(([px, py]) => [px / ZOOM_SCALE, py / ZOOM_SCALE]) as [number, number][];

        // Keep Redux shape state in sync for listeners that rely on it
        dispatch(setShapeData({ rectangleCoords: coords, polygonPoints }));

        // Notify any external listeners
        EventBus.emit('shape-resizing', { rectangleCoords: coords, polygonPoints });
      };

      const onPointerDown = (evt: PointerEvent) => {
        // Check for handle drag or annotation move
        const handle = (evt.target as HTMLElement)?.closest('.a9s-handle, .a9s-edge-handle') as HTMLElement | null;
        const annotation = (evt.target as HTMLElement)?.closest('g.a9s-annotation.selected') as SVGGElement | null;
        const polygon = (evt.target as HTMLElement)?.closest('polygon') as SVGPolygonElement | null;
        
        // Only react when the user drags an editor handle, moves an annotation, or interacts with a polygon
        if (!handle && !annotation && !polygon) {
          // Canvas interaction that doesn't hit an editable annotation - treat as blank
          const selected = annotatorInstance.getSelected?.();
          if (!selected || selected.length === 0) {
            lastResetTimestampRef.current = Date.now();
            dispatch(resetShapeData());
          }
          return;
        }

        // Scope updates to the annotation being edited
        let group: SVGGElement | null = null;
        let targetElement: Element | null = null;

        if (handle) {
          group = handle.closest('g.a9s-annotation.selected') as SVGGElement | null;
          targetElement = handle;
        } else if (polygon) {
          group = polygon.closest('g.a9s-annotation.selected') as SVGGElement | null;
          targetElement = polygon;
        } else if (annotation) {
          group = annotation;
          targetElement = annotation;
        }

        if (!group) return;

        // Capture the pointer so we keep receiving move/up events even if it leaves the SVG
        if (targetElement) {
          try { (targetElement as any).setPointerCapture?.(evt.pointerId); } catch { /* no-op */ }
        }

        const onPointerMove = (_e: PointerEvent) => {
          if (group && group.querySelector('polygon')) {
            // Live updates for polygons
            emitLivePolygonFromDOM(group);
            return;
          }
          // Fallback: read from selected (works for rect/line, or after idle if autoSave=true)
          const selected = annotatorInstance.getSelected?.();
          if (selected && selected.length > 0) {
            const coords = dispatchShapeCoords(selected[0]);
            if (coords) EventBus.emit('shape-resizing', coords);
          }
        };

        const onPointerUp = (_e: PointerEvent) => {
          window.removeEventListener('pointermove', onPointerMove as EventListener);
          window.removeEventListener('pointerup', onPointerUp as EventListener);
          if (targetElement) {
            try { (targetElement as any).releasePointerCapture?.(evt.pointerId); } catch { /* no-op */ }
          }
        };

        window.addEventListener('pointermove', onPointerMove as EventListener);
        window.addEventListener('pointerup', onPointerUp as EventListener);
      };

      // Add additional event listeners for polygon movement
      const onMouseMove = (evt: MouseEvent) => {
        // Check if we're currently dragging a polygon
        const selectedAnnotation = document.querySelector('g.a9s-annotation.selected') as SVGGElement | null;
        if (selectedAnnotation && selectedAnnotation.querySelector('polygon')) {
          // Check if the mouse is over the polygon or its handles
          const target = evt.target as Element;
          if (target && (target.closest('polygon') || target.closest('.a9s-handle, .a9s-edge-handle'))) {
            // Only emit if we're actually dragging (mouse button is pressed)
            if (evt.buttons > 0) {
              emitLivePolygonFromDOM(selectedAnnotation);
            }
          }
        }
      };

      // Add MutationObserver to watch for polygon changes
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === 'attributes' && mutation.attributeName === 'points') {
            const target = mutation.target as SVGPolygonElement;
            const group = target.closest('g.a9s-annotation.selected') as SVGGElement | null;
            if (group) {
              emitLivePolygonFromDOM(group);
            }
          }
        });
      });

      // Start observing polygon elements
      const startObservingPolygons = () => {
        const polygons = document.querySelectorAll('polygon');
        polygons.forEach((polygon) => {
          observer.observe(polygon, { attributes: true, attributeFilter: ['points'] });
        });
      };

      // Initial observation
      startObservingPolygons();

      // Set up a periodic check for new polygons
      const polygonCheckInterval = setInterval(() => {
        const polygons = document.querySelectorAll('polygon');
        polygons.forEach((polygon) => {
          if (!polygon.hasAttribute('data-observed')) {
            polygon.setAttribute('data-observed', 'true');
            observer.observe(polygon, { attributes: true, attributeFilter: ['points'] });
          }
        });
      }, 1000);

      // Attach on the annotation SVG layer
      const annotationLayerEl = viewer.element?.querySelector('.a9s-annotationlayer');
      if (annotationLayerEl) {
        annotationLayerEl.addEventListener('pointerdown', onPointerDown as EventListener);
        annotationLayerEl.addEventListener('mousemove', onMouseMove as EventListener);
      }

      return () => {
        annotatorInstance.off('createAnnotation', onFinalAnnotation);
        annotatorInstance.off('updateAnnotation', onFinalAnnotation);
        annotatorInstance.off('selectAnnotation', onSelectAnnotation);
        // Re-query the annotation layer element for cleanup since it might have changed
        const cleanupAnnotationLayerEl = viewer.element?.querySelector('.a9s-annotationlayer');
        if (cleanupAnnotationLayerEl) {
          cleanupAnnotationLayerEl.removeEventListener('pointerdown', onPointerDown as EventListener);
          cleanupAnnotationLayerEl.removeEventListener('mousemove', onMouseMove as EventListener);
        }
        // Clean up MutationObserver and interval
        observer.disconnect();
        clearInterval(polygonCheckInterval);
      };
    }
  }, [annotatorInstance, dispatch, viewerInstance]);

  const [reloading, setReloading] = useState(0);

  const channelSignature = useMemo(() => {
    try {
      const sig = visibleChannels.map(idx => `${idx}:${channels[idx]?.color || ''}`).join('|');
      console.log('[Channel Signature] Generated signature:', sig);
      return sig;
    } catch (error) {
      console.warn('[Channel Signature] Error generating signature:', error);
      return '';
    }
  }, [visibleChannels, channels]);

  const getTileUrl = useMemo(() => {
    return (level: number, x: number, y: number): string => {
      const params = new URLSearchParams();

      visibleChannels.forEach(channelIndex => {
        const channel = channels[channelIndex];
        if (channel && channel.color) {
          params.append('channels[]', channelIndex.toString());
          params.append('colors[]', channel.color.replace('#', ''));
          console.log(`[Tile URL] Adding channel ${channelIndex} with color ${channel.color}`);
        }
      });

      if (currentInstanceId) {
        params.append('instance_id', currentInstanceId);
      }
      // cache-busting signature for color changes
      if (channelSignature) {
        params.append('sig', channelSignature);
      }
      const queryString = params.toString();
      return `${AI_SERVICE_API_ENDPOINT}/load/v1/tile/${level}/${x}_${y}.jpeg${queryString ? `?${queryString}` : ''}`;
    };
  }, [visibleChannels, channels, currentInstanceId, channelSignature]);

  const initViewer = useCallback(async () => {
    if (!currentInstanceId) {
      console.warn('Cannot initialize viewer: instanceId is not available');
      return;
    }

    console.log('Initializing viewer with instanceId:', currentInstanceId);
    
    let level_0_width = 50000;
    let level_0_height = 50000;
    let levelCount = 0;
    try {
      const loadData = currentWSIInfo;
      console.log('Received WSI info:', loadData);
      if (loadData && loadData.dimensions) {
        // Handle both array format (legacy) and tuple format (new)
        if (Array.isArray(loadData.dimensions)) {
          // Legacy format: dimensions is an array of arrays
          if (loadData.dimensions.length > 0 && Array.isArray(loadData.dimensions[0])) {
        [level_0_width, level_0_height] = loadData.dimensions[0];
        levelCount = loadData.dimensions.length;
          }
        } else {
          // New format: dimensions is a tuple (width, height)
          [level_0_width, level_0_height] = loadData.dimensions;
          levelCount = loadData.level_count || 1;
        }
        console.log('Parsed dimensions:', { level_0_width, level_0_height, levelCount });
      } else {
        console.warn('Invalid or missing dimensions in loadData.');
      }
    } catch (error) {
      console.error('Error initializing viewer:', error);
    }

    let scale = 16;
    const maxLevel = 8;

    const svs_width = level_0_width * scale;
    const svs_height = level_0_height * scale;
    const tile_size = 1024;

    const newTileSource = {
      width: svs_width,
      height: svs_height,
      tileSize: tile_size,
      tileOverlap: 0,
      minLevel: 0,
      maxLevel: maxLevel,
      getTileUrl: getTileUrl,
      ajaxHeaders: {
        'Content-Type': 'application/json',
        'Accept': 'image/jpeg,image/png,image/*,*/*',
        ...(currentInstanceId && { 'X-Instance-ID': currentInstanceId }),
      },
      // Add a unique key to force refresh tileSource when fileInfo changes
      _key: `${currentInstanceId}_${currentWSIFileInfo?.filePath || ''}_${svs_width}_${svs_height}`,
      // Instance-specific identifiers
      _instanceId: currentInstanceId,
      _dimensions: { width: svs_width, height: svs_height },
      _levelCount: levelCount
    };
    setTileSource(newTileSource);
  }, [getTileUrl, currentWSIInfo, currentWSIFileInfo, currentInstanceId]);

  useEffect(() => {
    if (currentInstanceId) {
      console.log('InstanceId available, initializing viewer...');
      initViewer();
    } else {
      console.log('InstanceId not available yet, skipping viewer initialization');
    }
  }, [initViewer, currentInstanceId]);

  // Initialize gestures hook
  useOpenSeadragonGestures({
    viewerRef,
    annotatorInstance,
    zoomSpeed,
    trackpadGesture,
    setMousePos,
    setImageBounds,
    setMagnification
  });

  useEffect(() => {
    if (tileSource) {
      console.log('Setting up OpenSeadragon options with instanceId:', currentInstanceId);
      
      // Create completely independent configuration for each instance
      const instanceOptions = {
        id: `viewer-${currentInstanceId}-${tileSource._key}`, // Use instance ID and tileSource key to ensure uniqueness
        prefixUrl: "/images/icons/openseadragon/",
        navigatorSizeRatio: 0.25,
        wrapHorizontal: false,
        showNavigator: false,
        showRotationControl: true,
        showZoomControl: true,
        loadTilesWithAjax: true,
        ajaxHeaders: {
          'Content-Type': 'application/json',
          'Accept': 'image/jpeg,image/png,image/*,*/*',
          ...(currentInstanceId && { 'X-Instance-ID': currentInstanceId }),
          'Authorization': `Bearer ${Cookies.get('tissuelab_token') || process.env.NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN || 'local-default-token'}`,
        },
        tileSources: {
          ...tileSource,
          getTileUrl: getTileUrl,
        },
        gestureSettingsMouse: {
          flickEnabled: false,      // Disable default flick gesture
          clickToZoom: false,
          dblClickToZoom: false,
          dragToPan: true,          // Keep mouse drag panning
          scrollToZoom: false,
          // macOS map style gesture settings
          dragToPanThreshold: 3,    // Drag threshold to prevent accidental panning
          dragToPanMomentum: 0.25   // Drag momentum to make panning smoother
        },
        rotationIncrement: 30,
        gestureSettingsTouch: {
          pinchRotate: true
        },
        animationTime: 0.3,         // Increase animation time to make gestures smoother
        springStiffness: 6.5,       // Decrease spring stiffness to make gestures more natural
        timeout: 1000000,
        // macOS map style gesture settings
        immediateRender: false,      // Delay rendering, improve performance
        blendTime: 0.1,             // Blend time, make transition smoother
        alwaysBlend: false,         // Do not always blend, improve performance
        // Zoom level constraints
        minZoomLevel: 0.1,
        maxZoomLevel: 2000,
        // Add instance specific configuration
        _instanceId: currentInstanceId,
        _tileSourceKey: tileSource._key,
        _dimensions: tileSource._dimensions
      };
      
      console.log('Created instance-specific options for:', currentInstanceId, {
        id: instanceOptions.id,
        tileSourceKey: instanceOptions._tileSourceKey,
        dimensions: tileSource._dimensions
      });
      
      setOptions(instanceOptions);
    }
  }, [tileSource, visibleChannels, getTileUrl, currentInstanceId]);

  // tool
  const handleToolbarClick = useCallback((tool: string | undefined) => {
    if (tool === 'move' || tool === 'polygon' || tool === 'rectangle' || tool === 'line') {
      dispatch(setTool(tool));
    } //else if (tool === 'Undo' && annotatorInstance) {
      //annotatorInstance.undo();
    //} else if (tool === 'Filter') {
      //dispatch(setShowThreshold(!showThreshold));
    //}
    // Handle other non-drawing tools here, e.g., ruler
  }, [dispatch]);

  // reload related
  const handleUpload = async (filePath: string) => {
    setAllTilesLoaded(false);
    setIsUploading(true);
    try {
      // Check if we are in Electron environment
      const isElectron = typeof window !== 'undefined' && window.electron;
      
      let relativePath: string;
      
      if (isElectron) {
        // In Electron, filePath might be an absolute path
        // We need to handle this properly for the backend
        const fileName = filePath.split(/[\\/]/).pop() || '';
        
        // For Electron, we'll use the full path as the relative path
        // The backend will handle the path resolution
        relativePath = filePath;
        
        console.log('Electron environment detected. Using full path:', relativePath);
      } else {
        // In web environment, extract filename from the absolute path to use as relative path
        const fileName = filePath.split(/[\\/]/).pop();
        relativePath = fileName || filePath;
        
        console.log('Web environment. Using filename as relative path:', relativePath);
      }

      // Create instance for the WSI
      const instanceData = await createInstance(relativePath);
      console.log('OpenSeadragonContainer: instanceData:', instanceData);
      
      // Set instanceId in context
      setInstanceId(instanceData.instanceId);
      
      // Use instance data as WSI info
      const loadData = {
        dimensions: instanceData.dimensions,
        level_count: instanceData.level_count,
        total_tiles: instanceData.total_tiles,
        file_format: instanceData.file_format
      };
      
      console.log('OpenSeadragonContainer: loadData:', loadData);

      // Add the new instance to Redux state
      dispatch(addWSIInstance({
        instanceId: instanceData.instanceId,
        wsiInfo: loadData,
        fileInfo: {
          fileName: filePath.split(/[\\/]/).pop() || '',
          filePath: relativePath
        }
      }));
      dispatch(setCurrentPath({ path: relativePath }));

      //update slide info
      dispatch(setSlideInfo({
        dimensions: instanceData.dimensions[0] as [number, number], // Take first dimension level
        fileSize: instanceData.file_size || 0,
        mpp: instanceData.mpp || 1,
        magnification: instanceData.magnification || 1,
        imageType: instanceData.image_type || 'unknown',
        totalAnnotations: instanceData.total_annotations || 0,
        totalCells: instanceData.total_cells || 0,
        processingStatus: instanceData.processing_status || 'unknown',
        totalTiles: instanceData.total_tiles
      }));

      // update channels info
      if (instanceData.total_channels) {
        dispatch(setTotalChannels(instanceData.total_channels));
      }

      console.log('File uploaded successfully. Loading slide...');

      console.log('set current path:', filePath);

      // Force reload the viewer after instance is created
      console.log('Instance created, reloading viewer with instanceId:', instanceData.instanceId);
      await initViewer();
      setReloading(prev => prev + 1);

      console.log('Slide loaded successfully.');

    } catch (error) {
      console.error('Error:', error);
    } finally {
      setIsUploading(false);
    }
  };

  // Add these event handlers back
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.target === textRef.current) {
      setDragging(false);
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    message.info('Please open images from Dashboard');
  };

  //if progress changes, open new tileSource
  useEffect(() => {
    if (viewerInstance && reloading > 0 && tileSource && currentInstanceId) {
      console.log('Opening tileSource with instanceId:', currentInstanceId);
      viewerInstance.open(tileSource)
    }
  }, [reloading, tileSource, viewerInstance, currentInstanceId])

  // websocket

  const annotationsCounter = useRef({
    received: 0,
    total: 0,
    lastTimestamp: Date.now()
  });

  // hashing
  const hasherRef = useRef<any>(null);
  useEffect(() => {
    const initHasher = async () => {
      if (!hasherRef.current) {
        hasherRef.current = await xxhash();
        console.log('XXHash initialized');
      }
    };

    initHasher();
  }, []); // Init hasher once on load
  // Avoid effect loops by using ref instead of state
  const lastHashRef = useRef<string | null>(null);

  const keydownUpdate = useCallback((prev: boolean, newVal: boolean) => {
    if (annotatorInstance) {
      annotatorInstance.setFilter(annotationFilter);
    }

    // Check if this is an image file
    const isImageFile = currentPath &&
      (currentPath.toLowerCase().endsWith('.png') ||
        currentPath.toLowerCase().endsWith('.jpg') ||
        currentPath.toLowerCase().endsWith('.jpeg') ||
        currentPath.toLowerCase().endsWith('.bmp'));

    // When turning off backend annotations, clean annotations
    if (prev === true && newVal === false && annotatorInstance) {
      // Cleaning is necessary regardless of file type
      const allAnns = annotatorInstance.getAnnotations();
      const userAnns = allAnns.filter((a: { isBackend: any; }) => !a.isBackend);
      annotatorInstance.setAnnotations([], true);
      dispatch(setAnnotations([]));
      userAnns.forEach((annotation: any) => {
        annotatorInstance.addAnnotation(annotation);
      });

      // Apply filter
      annotatorInstance.setFilter((anno: { isBackend: any; }) => {
        if (!newVal && anno.isBackend) return false;
        if (!showUserAnnotations && !anno.isBackend) return false;
        return true;
      });

      lastRequestTimeRef.current = Date.now();

      // Avoid duplicate backend clear; rely on viewer-event logic to manage cleanup
      setLoadingAnnotations(false);
    }

    // When turning on backend annotations, request data
    if (prev === false && newVal === true && annotatorInstance && viewerInstance) {
      const zoom = viewerInstance.viewport.getZoom();
      console.log(`Current zoom level: ${zoom}, Threshold: ${threshold}, Above threshold: ${zoom >= threshold}`);

      const viewportBounds = viewerInstance.viewport.getBounds();
      const topLeft = viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
      const bottomRight = viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());
      const x1 = Math.round(topLeft.x / ZOOM_SCALE);
      const y1 = Math.round(topLeft.y / ZOOM_SCALE);
      const x2 = Math.round(bottomRight.x / ZOOM_SCALE);
      const y2 = Math.round(bottomRight.y / ZOOM_SCALE);

      if (socket && socket.readyState === WebSocket.OPEN && !isRunning) {
        console.log(`Preparing to send WebSocket request, parameters: x1=${x1}, y1=${y1}, x2=${x2}, y2=${y2}`);

        // Determine request type based on file type
        if (isImageFile) {
          // Image files always request annotations
          console.log("Image file, requesting annotations data");
          setLoadingAnnotations(true);
          socket.send(JSON.stringify({ x1, y1, x2, y2, type: 'annotations', use_classification: classificationEnabled, instance_id: instanceId }));
        } else if (zoom >= threshold) {
          // Non-image files, high zoom level requests annotations
          console.log("High zoom level, requesting annotations data");
          setLoadingAnnotations(true);
          socket.send(JSON.stringify({ x1, y1, x2, y2, type: 'annotations', use_classification: classificationEnabled, instance_id: instanceId }));
        } else if (zoom >= polygon_threshold) {
          // Non-image files, mid zoom level requests all_annotations
          console.log("Mid zoom level, requesting all_annotations data");
          setLoadingAnnotations(true);
          socket.send(JSON.stringify({ x1, y1, x2, y2, type: 'all_annotations', use_classification: classificationEnabled, instance_id: instanceId }));
        } else {
          // Non-image files, low zoom level requests centroids
          console.log("Low zoom level non-image file, requesting centroids data");
          setLoadingAnnotations(true);
          socket.send(JSON.stringify({ x1, y1, x2, y2, type: 'centroids', use_classification: classificationEnabled, instance_id: instanceId }));
        }
      } else if (!(socket && socket.readyState === WebSocket.OPEN)) {
        console.log("WebSocket not connected or not ready");
        // Even if WebSocket is not ready, set loading state to indicate we're trying
        setLoadingAnnotations(true);
      }
    }
  }, [annotatorInstance, threshold, classificationEnabled, socket, currentPath, dispatch,
    annotationFilter, polygon_threshold, showUserAnnotations, viewerInstance, instanceId, isRunning]);

  const requestPatchesForViewport = useCallback(() => {
    if (!viewerInstance) {
      return false;
    }

    if (isRunning) {
      console.log('[Patches] Workflow is running; deferring patch request until completion.');
      return false;
    }

    const viewportBounds = viewerInstance.viewport.getBounds();
    const topLeft = viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
    const bottomRight = viewerInstance.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());
    const x1 = Math.round(topLeft.x / ZOOM_SCALE);
    const y1 = Math.round(topLeft.y / ZOOM_SCALE);
    const x2 = Math.round(bottomRight.x / ZOOM_SCALE);
    const y2 = Math.round(bottomRight.y / ZOOM_SCALE);

    if (socket && socket.readyState === WebSocket.OPEN) {
      console.log('[Patches] Requesting patches for current viewport.');
      socket.send(JSON.stringify({ x1, y1, x2, y2, type: 'patches', instance_id: instanceId }));
      return true;
    }

    console.log('[Patches] WebSocket not connected or not ready for patches request.');
    return false;
  }, [socket, viewerInstance, instanceId, isRunning]);

  const keydownUpdatePatches = useCallback((prev: boolean, newVal: boolean) => {
    // When turning off patches, clear them and the hash to allow re-fetching
    if (prev === true && newVal === false) {
      dispatch(clearPatchOverlays());
      lastHashRef.current = null;
      console.log('[Patches] Cleared patches and reset hash.');
      return;
    }

    // When turning on patches, request data
    if (prev === false && newVal === true) {
      requestPatchesForViewport();
      void refreshPatchClassificationData();
    }
  }, [dispatch, requestPatchesForViewport, refreshPatchClassificationData]);

  useEffect(() => {
    if (socket && annotatorInstance) {
      socket.onmessage = async (event) => {
        try {
          const rawData = event.data;
          console.log('[WS RECEIVED RAW]:', rawData.substring(0, 500));

          // hash event.data if large enough
          if (typeof event.data === 'string' && event.data.length > 1000 && hasherRef.current) {
            console.time('hash-operation');
            const hash = hasherRef.current.h64(event.data);
            console.timeEnd('hash-operation');
            if (hash === lastHashRef.current) {
              console.log('[Hash] Duplicate message detected, ignoring.');
              setLoadingAnnotations(false);
              return;
            }
            lastHashRef.current = hash;
          }
          const data = JSON.parse(event.data);
          console.log('[WS RECEIVED PARSED]:', JSON.stringify(data, null, 2).substring(0, 1000));

          // handle the case when no segmentation data is available
          if (data.status === 'info' && data.message === 'No segmentation data available for this image') {
            console.log('[WS INFO] No segmentation data available for this image. Clearing all annotation data.');
            if (currentRequestType === 'space') {
              confirmH5MissingThenNotify('space', 'Space key highlights nuclei segmentation. However, either no segmentation results were found in the associated H5 file or the H5 file is missing.');
            } else {
              message.info(data.message);
            }

            // Clear visual annotations from the viewer instance
            if (annotatorInstance) {
              annotatorInstance.setAnnotations([], true);
            }

            // Clear annotations from Redux state
            dispatch(setAnnotations([]));

            setLoadingAnnotations(false);
            setExistAnnotationFile(false);
            setCentroids([]);
            dispatch(clearPatchOverlays());
            dispatch(clearPatchOverrides());
            return;
          }

          if (data.status === 'success' && data.message === 'H5 file loaded successfully') {
            console.log('[WS SUCCESS] H5 file loaded successfully. Setting existAnnotationFile to true.');
            setExistAnnotationFile(true);
            setLoadingAnnotations(false); // The "load" is complete; delegate viewport requests to event hook.

            // Cancel quick fallback when H5 is confirmed
            if (quickSpaceFallbackTimerRef.current) {
              clearTimeout(quickSpaceFallbackTimerRef.current as unknown as number);
              quickSpaceFallbackTimerRef.current = null;
            }

            // Also cancel any outstanding confirm timers since we now have data
            if (errorConfirmTimersRef.current.space) {
              clearTimeout(errorConfirmTimersRef.current.space as unknown as number);
              errorConfirmTimersRef.current.space = null;
              errorConfirmAttemptsRef.current.space = 0;
            }
            if (errorConfirmTimersRef.current.x) {
              clearTimeout(errorConfirmTimersRef.current.x as unknown as number);
              errorConfirmTimersRef.current.x = null;
              errorConfirmAttemptsRef.current.x = 0;
            }

            // Delegate all viewport-based requests to useOpenSeadragonViewerEvents via an update
            if (viewerInstance) {
              viewerInstance.viewport.update();
              console.log('[WS SUCCESS] Triggered viewer redraw; event hook will request data based on zoom and visibility.');
            }

            handleLoadClassification();
            return;
          }

          // Swallow noisy backend info messages to avoid log spam
          if (data && data.status === 'info') {
            if (data.message === 'clear annotations') {
              // Backend acknowledges clear; already handled locally when triggered
              return;
            }
            // For other info messages, log at debug level and continue if needed
            console.debug('[WS INFO]', data.message);
          } else {
            // Log WebSocket message with appropriate fields based on message type
            const logFields = [`Type: ${data.type}`];
            if (data.status !== undefined) logFields.push(`Status: ${data.status}`);
            if (data.message !== undefined) logFields.push(`Message: ${data.message}`);
            if (data.type === 'all_annotations' && data.all_annotations) {
              logFields.push(`Annotations count: ${data.all_annotations.length}`);
            }
            if (data.type === 'annotations' && data.annotations) {
              logFields.push(`Annotations count: ${data.annotations.length}`);
            }
            if (data.type === 'centroids' && data.centroids) {
              logFields.push(`Centroids count: ${data.centroids.length}`);
            }
            if (data.type === 'patches' && data.patches) {
              logFields.push(`Patches count: ${data.patches.length}`);
            }
            console.log(`[WS DEBUG] Received WebSocket message - ${logFields.join(', ')}`);
          }

          const isImageFile = currentPath &&
            (currentPath.toLowerCase().endsWith('.png') ||
              currentPath.toLowerCase().endsWith('.jpg') ||
              currentPath.toLowerCase().endsWith('.jpeg') ||
              currentPath.toLowerCase().endsWith('.bmp'));

          if (data.status === 'success') {
            console.log('[WS SUCCESS] Received general success message, possibly after set_path. Data:', data);
            // This block is now handled by the more specific 'H5 file loaded successfully' message handler.
            // The redraw logic might still be useful for other success messages.
            if (viewerInstance) {
              viewerInstance.viewport.update();
              console.log('[WS SUCCESS] Forced viewer redraw.');
            }
            // Return here since this is a standalone success message
            return;
          }

          if (data.type === 'info' || data.status === 'info') {
            // Only act on non-noisy info messages; ignore repeated clear notifications
            if (data.message && data.message !== 'clear annotations') {
              console.debug('[WS INFO] Received info message:', data.message);
            }
            return;
          }

          let receivedActualData = false; // Flag to track if this message contained renderable data

          if (data.type === 'centroids' && Array.isArray(data.centroids)) {
            console.log(`[WS CENTROIDS] Received ${data.centroids.length} centroids. Current path is image file: ${isImageFile}`);
            if (data.centroids.length > 0) {
              receivedActualData = true;
            }
            if (!isImageFile) {
              console.log('[WS CENTROIDS] Setting centroids state for non-image file.');
              setCentroids(data.centroids);
            } else {
              console.log('[WS CENTROIDS] Image file type, not setting centroids from this message type directly. Expecting annotations or centroids_for_image.');
            }
            let counts: Record<string, number> = {};
            let dynamicNames: string[] = [];
            if (data.class_counts_by_id) {
              counts = data.class_counts_by_id;
              console.log('[WS DEBUG] Extracted class_counts_by_id:', counts);
            }
            if (data.dynamic_class_names || data.class_names) {
              dynamicNames = data.dynamic_class_names || data.class_names;
              console.log('[WS DEBUG] Received class names:', dynamicNames);
              // Optional: Sync with Redux if lengths differ
              const currentClasses = store.getState().annotations.nucleiClasses.map(c => c.name);
              console.log('[WS DEBUG] Current Redux class names:', currentClasses);
              console.log('[WS DEBUG] Incoming dynamic_class_names:', dynamicNames);
              if (JSON.stringify(currentClasses) !== JSON.stringify(dynamicNames)) {
                console.log('[WS DEBUG] Syncing nucleiClasses due to mismatch.');
                // Create map of current classes by name for quick lookup
                const currentNucleiClasses = store.getState().annotations.nucleiClasses;
                const currentMap = new Map(currentNucleiClasses.map(cls => [cls.name, cls]));
                // Start with backend classes, use backend colors if available
                const backendColors = data.class_colors || [];
                const mergedClasses = dynamicNames.map((name: string, idx: number) => {
                  const existing = currentMap.get(name);
                  const backendColor = backendColors[idx] || '#aaaaaa';
                  return existing ? { ...existing, count: 0, color: backendColor } : { name, color: backendColor, count: 0 };
                });
                // Append any local classes not in backend
                currentNucleiClasses.forEach((cls: { name: string, color: string, count: number }) => {
                  if (!dynamicNames.includes(cls.name)) {
                    mergedClasses.push({ ...cls, count: cls.count });
                  }
                });
                // Log merge stats
                const addedFromBackend = dynamicNames.filter((name: string) => !currentClasses.includes(name)).length;
                const preservedLocal = currentClasses.filter((name: string) => !dynamicNames.includes(name)).length;
                console.log(`[WS DEBUG] Merged nucleiClasses: added ${addedFromBackend} from backend, preserved ${preservedLocal} local-only`);
                dispatch(setNucleiClasses(mergedClasses));
                console.log('[WS DEBUG] Synced nucleiClasses with merge:', mergedClasses);
              } else {
                console.log('[WS DEBUG] No sync needed, classes match.');
              }
            }
            updateCountsFromBackend(counts);
          } else if (data.type === 'patches' && Array.isArray(data.patches)) {
            console.log(`[WS PATCHES] Received ${data.patches.length} patches. Current path is image file: ${isImageFile}`);
            if (data.patches.length > 0) {
              receivedActualData = true;
              // Patches themselves don't mean H5 is fully "annotated" for spacebar purposes,
              // but it indicates backend processing.
            }
            dispatch(setPatchOverlays(data.patches));
            if (data.class_counts_by_id) {
              void refreshPatchClassificationData();
            }
          } else if (data.type === 'all_annotations' && Array.isArray(data.all_annotations)) {
            if (!isImageFile) {
              setRenderingAnnotations(data.all_annotations);
              if (data.class_counts_by_id) {
                updateCountsFromBackend(data.class_counts_by_id);
              }
            }
          } else if (data.type === 'annotations' && Array.isArray(data.annotations)) {
            console.log(`[WS ANNOTATIONS] Received ${data.annotations.length} annotations. showBackendAnnotations: ${showBackendAnnotations}`);
            if (data.annotations.length > 0) {
              receivedActualData = true;
            }
            if (!showBackendAnnotations) {
              console.log('[WS ANNOTATIONS] showBackendAnnotations is false, not processing.');
              // Do not return yet, might have centroids_for_image
            } else {
              annotationsCounter.current.received += data.annotations.length;
              const beforeAnnotations = annotatorInstance.getAnnotations();
              console.log(`[Memory Check] Annotations count before cleaning (UI): ${beforeAnnotations.length}`);
              const reduxAnnotations = store.getState().annotations.annotations;
              console.log(`[Memory Check] Annotations count before cleaning (Redux): ${reduxAnnotations.length}`);
              console.log(`[Memory Check] Current time: ${new Date().toISOString()}, Since last: ${Date.now() - annotationsCounter.current.lastTimestamp}ms`);
              annotationsCounter.current.lastTimestamp = Date.now();
              const backendAnnotations = data.annotations.map((annotation: any) => ({ ...annotation, isBackend: true }));

              // Get current user-created annotations to preserve them
              const userAnnotations = annotatorInstance.getAnnotations().filter((a: any) => !a.isBackend);

              // Combine and replace all annotations in the viewer
              annotatorInstance.setAnnotations([...userAnnotations, ...backendAnnotations], true);

              // Update Redux state with just the new backend annotations
              dispatch(setAnnotations(backendAnnotations));
              console.log(`[Memory Check] Redux annotations state updated, count now: ${store.getState().annotations.annotations.length}`);
              console.log(`[Memory Check] UI annotator instance updated, count now: ${annotatorInstance.getAnnotations().length}`);
            }

            if (data.class_counts_by_id) {
              updateCountsFromBackend(data.class_counts_by_id);
            }

            // Handle centroids if they are part of an 'annotations' message (for image files)
            if (isImageFile && data.centroids_for_image && Array.isArray(data.centroids_for_image)) {
              console.log(`[WS ANNOTATIONS] Also received ${data.centroids_for_image.length} centroids_for_image. Setting centroids state.`);
              setCentroids(data.centroids_for_image);
              if (data.centroids_for_image.length > 0) {
                receivedActualData = true;
              }
            }
          } else {
            console.log('[WS OTHER] Received unhandled message type or structure:', data);
            if (data.status === 'error' && (data.error_type === 'FileNotFoundError' || data.error_type === 'NoDataError')) {
              // Only show error messages when user actively pressed Space or X key
              if (currentRequestType === 'space') {
                confirmH5MissingThenNotify('space', 'Space key highlights nuclei segmentation. However, either no segmentation results were found in the associated H5 file or the H5 file is missing.');
              } else if (currentRequestType === 'x') {
                confirmH5MissingThenNotify('x', 'X key displays patch classification. However, either no patch data was found in the associated H5 file or the H5 file is missing.');
              } else {
                // Don't show error message for non-user-initiated requests
                console.log('[WS ERROR] FileNotFoundError/NoDataError received but no user action detected, not showing error message');
              }
            } else if (data.status === 'error') {
              // Only show error messages for user-initiated actions, not for automatic set_path requests
              if (currentRequestType === 'space' || currentRequestType === 'x') {
                message.error(data.message || 'Unknown error from server');
              } else {
                console.log('[WS ERROR] Error received but no user action detected, not showing error message:', data.message);
              }
            } else if (data.status === 'warning') {
              message.warning(data.message || 'Warning from server');
            } else if (data.status === 'info') {
              message.info(data.message || 'Info from server');
            } else if (data.status === 'success') {
              message.success(data.message || 'Success');
              setCurrentRequestType(null); // Reset request type after success
            } else {
              message.info(data.message || 'Unknown message from server');
            }
          }

          // If this message contained actual segmentation data (centroids or annotations),
          // then we can assume the H5 file is effectively "loaded" with results.
          if (receivedActualData) {
            console.log('[WS DATA] Actual data received in this message. Setting existAnnotationFile to true.');
            setExistAnnotationFile(true);

            // Cancel quick fallback and confirm timers on any data arrival
            if (quickSpaceFallbackTimerRef.current) {
              clearTimeout(quickSpaceFallbackTimerRef.current as unknown as number);
              quickSpaceFallbackTimerRef.current = null;
            }
            if (errorConfirmTimersRef.current.space) {
              clearTimeout(errorConfirmTimersRef.current.space as unknown as number);
              errorConfirmTimersRef.current.space = null;
              errorConfirmAttemptsRef.current.space = 0;
            }
            if (errorConfirmTimersRef.current.x) {
              clearTimeout(errorConfirmTimersRef.current.x as unknown as number);
              errorConfirmTimersRef.current.x = null;
              errorConfirmAttemptsRef.current.x = 0;
            }
          }
          setLoadingAnnotations(false);
          // Reset the query flag to allow new viewport requests
          resetQueryFlag();
        } catch (error) {
          console.error("[WS ERROR] Error parsing WebSocket message:", error);
          console.error("[WS ERROR] Raw message data:", event.data.substring(0, 500));
          setExistAnnotationFile(false); // Reset on error
          // Clear all when error occur
          annotatorInstance.setAnnotations([], true);
          setCentroids([]);
          // Key fix: Synchronize Redux state update to prevent memory leaks
          dispatch(setAnnotations([]));
          // update viewport to redraw
          if (viewerInstance) {
            viewerInstance.viewport.update();
          }
          setLoadingAnnotations(false); // Cancel loading state on error
          // Reset the query flag to allow new viewport requests
          resetQueryFlag();
        }
      };
    }

    return () => {
      if (socket) {
        socket.onmessage = null;
      }
    };
  }, [socket, annotatorInstance, updateCentroids, currentPath, showBackendAnnotations,
    dispatch, keydownUpdate, viewerInstance, handleLoadClassification, currentRequestType,
    classificationEnabled, polygon_threshold, showPatches, threshold, updateCountsFromBackend, resetQueryFlag, confirmH5MissingThenNotify, refreshPatchClassificationData]);

  // Track the last sent path to avoid duplicate set_path requests
  const lastSentPathRef = useRef<string | null>(null);

  useEffect(() => {
    console.log('Checking conditions for set_path:', {
      currentPath,
      socketExists: !!socket,
      socketStatus: status,
      allTilesLoaded,
      lastSentPath: lastSentPathRef.current
    });

    if (currentPath && socket && status === WebSocket.OPEN && allTilesLoaded) {
      // Only send set_path if the path has actually changed
      if (lastSentPathRef.current !== currentPath) {
        console.log('All tiles loaded, sending file path to WebSocket:', currentPath);
        // Clear hash when WebSocket connection is established and file path is set
        lastHashRef.current = null;
        console.log('[WebSocket] Cleared hash when establishing connection');
        if (showBackendAnnotations) setLoadingAnnotations(true);
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'set_path',
            path: currentPath,
            instance_id: instanceId
          }));
          lastSentPathRef.current = currentPath;
        }
      } else {
        console.log('Skipping set_path request - path unchanged:', currentPath);
      }
    }
  }, [currentPath, socket, status, showBackendAnnotations, allTilesLoaded, instanceId]);

  // keyboard shortcuts
  const { bindings } = useShortcuts();
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the target is an input element (input, textarea, select, etc.)
      const target = event.target as HTMLElement;
      const isInputElement = target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.contentEditable === 'true';

      if (isInputElement) {
        return;
      }
      // Ignore auto-repeat to prevent rapid toggle on/off (especially for X)
      if (event.repeat) {
        return;
      }
      const eventKeyNorm = (event.key === ' ')
        ? 'Space'
        : (event.key && event.key.length === 1 ? event.key.toLowerCase() : event.code);
      const bind = (k: string) => (k.length === 1 ? k.toLowerCase() : k);

      if (eventKeyNorm === bind(bindings.toggleNuclei)) {
        // Toggle backend annotation display
        setShowBackendAnnotations(prev => {
          const newVal = !prev;

          // Block enabling while workflow is running to avoid stuck loading
          if (newVal && isRunning) {
            message.info('Workflow is running; nuclei overlay will refresh after it completes.');
            setCurrentRequestType(null);
            return prev;
          }

          // Check WebSocket connection status immediately
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            message.error('Space key highlights nuclei segmentation. However, WebSocket connection is not available. Please check your connection and try again.');
            setCurrentRequestType(null); // Reset request type after showing error
            return prev; // Don't change state if connection failed
          }

          // Always allow space key to trigger, even if no annotation file is loaded yet
          // This ensures the first press will send the WebSocket request
          if (newVal) {
            // When turning on backend annotations, always try to request data
            console.log("Space key pressed - attempting to load backend annotations");
            setCurrentRequestType('space'); // Set request type for error message context
            keydownUpdate(prev, newVal);

            // Quick fallback: if no response comes shortly and no recent workflow refresh, show error
            if (quickSpaceFallbackTimerRef.current) {
              clearTimeout(quickSpaceFallbackTimerRef.current as unknown as number);
              quickSpaceFallbackTimerRef.current = null;
            }
            const now = Date.now();
            const withinRecentRefresh = now - lastWorkflowRefreshTsRef.current < 8000;
            if (!withinRecentRefresh) {
              quickSpaceFallbackTimerRef.current = setTimeout(() => {
                if (!existAnnotationFile) {
                  message.error('Space key highlights nuclei segmentation. However, either no segmentation results were found in the associated H5 file or the H5 file is missing.');
                  setCurrentRequestType(null);
                }
                quickSpaceFallbackTimerRef.current = null;
              }, 600);
            }
          } else {
            // When turning off, only proceed if we have annotations to clear
            if (existAnnotationFile) {
              setCurrentRequestType('space'); // Set request type for error message context
              keydownUpdate(prev, newVal);
            } else {
              console.log("No annotation file loaded, but turning off backend annotations");
            }
          }
          return newVal;
        })
        event.preventDefault(); // prevent scrolling

      } else if (eventKeyNorm === bind(bindings.togglePatches)) {
        // Toggle patch display
        // Set request type BEFORE calling setShowPatches
        setCurrentRequestType('x');
        
        setShowPatches(prev => {
          const newVal = !prev;

          // Block enabling while workflow is running to avoid stuck loading
          if (newVal && isRunning) {
            message.info('Workflow is running; patches will refresh after it completes.');
            setCurrentRequestType(null);
            return prev;
          }
          
          // Check WebSocket connection status immediately
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            message.error('X key displays patch classification. However, WebSocket connection is not available. Please check your connection and try again.');
            setCurrentRequestType(null); // Reset request type after showing error
            return prev; // Don't change state if connection failed
          }
          
          keydownUpdatePatches(prev, newVal);
          return newVal;
        });
        event.preventDefault();
      } else if (eventKeyNorm === bind(bindings['tool.move'])) {
        // switch to move tool
        dispatch(setTool('move'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(bindings['tool.polygon'])) {
        // switch to polygon tool
        dispatch(setTool('polygon'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(bindings['tool.rectangle'])) {
        // switch to rectangle tool
        dispatch(setTool('rectangle'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(bindings['tool.line'])) {
        // switch to ruler tool
        dispatch(setTool('line'));
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [annotatorInstance, existAnnotationFile, annotationFilter, keydownUpdate, keydownUpdatePatches, dispatch, socket, bindings, refreshPatchClassificationData]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Helper: request viewport data (annotations/all_annotations/centroids) for current view
    const requestViewportDataForCounts = () => {
      try {
        const viewer = viewerInstance;
        if (!viewer || !viewer.viewport || !socket || socket.readyState !== WebSocket.OPEN) return;

        const viewportBounds = viewer.viewport.getBounds();
        const topLeft = viewer.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
        const bottomRight = viewer.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());
        const x1 = Math.round(topLeft.x / ZOOM_SCALE);
        const y1 = Math.round(topLeft.y / ZOOM_SCALE);
        const x2 = Math.round(bottomRight.x / ZOOM_SCALE);
        const y2 = Math.round(bottomRight.y / ZOOM_SCALE);

        const zoom = viewer.viewport.getZoom();
        const isImageFile = currentPath && (
          currentPath.toLowerCase().endsWith('.png') ||
          currentPath.toLowerCase().endsWith('.jpg') ||
          currentPath.toLowerCase().endsWith('.jpeg') ||
          currentPath.toLowerCase().endsWith('.bmp')
        );

        let requestType: 'annotations' | 'all_annotations' | 'centroids' = 'annotations';
        if (isImageFile) {
          requestType = 'annotations';
        } else if (zoom >= threshold) {
          requestType = 'annotations';
        } else if (zoom >= polygon_threshold) {
          requestType = 'all_annotations';
        } else {
          requestType = 'centroids';
        }

        if (showBackendAnnotations) setLoadingAnnotations(true);
          socket.send(JSON.stringify({ x1, y1, x2, y2, type: requestType, use_classification: classificationEnabled, instance_id: instanceId }));
        console.log(`[DEBUG] Sent viewport request:`, { requestType, x1, y1, x2, y2, use_classification: classificationEnabled });
          socket.send(JSON.stringify({ x1, y1, x2, y2, type: 'patches', instance_id: instanceId }));
      } catch (err) {
        console.log('[DEBUG] Failed to send viewport request:', err);
      }
    };

    const handleRefreshWebSocketPath = ({ path, forceReload }: { path: string, forceReload?: boolean }) => {
      console.log("DEBUG - Sending set_path message to WebSocket:", path, "forceReload:", forceReload);
      // Mark last workflow-related refresh time for brief retry window on Space/X
      lastWorkflowRefreshTsRef.current = Date.now();
      if (socket && socket.readyState === WebSocket.OPEN && path) {
        console.log("DEBUG - Sending set_path message to WebSocket:", path);
        console.log('Refreshing WebSocket path after workflow completion:', path);
        // Clear hash when refreshing WebSocket path
        lastHashRef.current = null;
        console.log('[WebSocket] Cleared hash when refreshing path');
        // If the path hasn't changed, avoid reloading the H5; just ask for counts
        const normalizedIncoming = (path || '').replace(/\.h5$/i, '');
        const normalizedCurrent = (currentPath || '').replace(/\.h5$/i, '');
        // Force reload if the flag is set (e.g., after workflow completion)
        if (!forceReload && (lastSentPathRef.current === normalizedIncoming || normalizedIncoming === normalizedCurrent)) {
          console.log('[DEBUG] Path unchanged; skipping set_path reload and requesting viewport data for counts.');
          requestViewportDataForCounts();
        } else {
          console.log('[DEBUG] Forcing reload of H5 file due to workflow completion or path change.');
          setLoadingAnnotations(true);
          socket.send(JSON.stringify({
            type: 'set_path',
            path: normalizedIncoming,
            instance_id: instanceId
          }));
          // Do not immediately request viewport data; wait for H5 load success to avoid race
          
          // For force reload, also trigger viewer update after a short delay to ensure H5 is loaded
          if (forceReload) {
            setTimeout(() => {
              if (viewerInstance) {
                console.log('[Force Reload] Triggering viewport update and data request');
                viewerInstance.viewport.update(); // This will trigger the viewport event hooks
                viewerInstance.forceRedraw(); // Force a visual redraw
                requestViewportDataForCounts(); // Also explicitly request viewport data
              }
            }, 1500); // Wait 1.5 seconds for H5 to load
          }
        }
      } else {
        console.log("[DEBUG] WebSocket: Not ready, no path provided, or tiles not loaded, skipping send.", { 
          isSocket: !!socket, 
          state: socket?.readyState, 
          path, 
          allTilesLoaded 
        });
      }
    };

    EventBus.on("refresh-websocket-path", handleRefreshWebSocketPath);
    return () => {
      EventBus.off("refresh-websocket-path", handleRefreshWebSocketPath);
    };
  }, [socket, allTilesLoaded, viewerInstance, threshold, polygon_threshold, classificationEnabled, currentPath, showBackendAnnotations, existAnnotationFile, instanceId]);

  useEffect(() => {
    const handleRefreshPatches = () => {
      requestPatchesForViewport();
      void refreshPatchClassificationData();
    };

    EventBus.on('refresh-patches', handleRefreshPatches);
    return () => {
      EventBus.off('refresh-patches', handleRefreshPatches);
    };
  }, [requestPatchesForViewport, refreshPatchClassificationData]);

  // hide/show backEnd annotations
  useEffect(() => {
    if (annotatorInstance) {
      annotatorInstance.setFilter((annotation: { isBackend: any; }) => {
        if (!showBackendAnnotations && annotation.isBackend) return false;
        if (!showUserAnnotations && !annotation.isBackend) return false;
        return true;
      });
    }
  }, [annotatorInstance, showBackendAnnotations, showUserAnnotations]);



  useEffect(() => {
    if (viewerInstance) {
      if (annotatorInstance) {
        console.log(`[File Change] Starting to clean annotations, current path: ${currentPath}`);

        // Record state before cleaning
        const beforeAnnotations = annotatorInstance.getAnnotations();
        const beforeReduxAnnotations = store.getState().annotations.annotations;
        console.log(`[File Change] Annotations count before cleaning: ${beforeAnnotations.length}`);
        console.log(`[File Change] Annotations count in Redux state: ${beforeReduxAnnotations.length}`);

        annotatorInstance.setAnnotations([], true);
        console.log(`[File Change] Cleaned UI annotations`);

        // Synchronize Redux state
        dispatch(setAnnotations([]));
        console.log(`[File Change] Redux state reset`);
        // Clear any per-cell classification overrides to avoid stale colors on new image
        dispatch(clearAnnotationTypes());

        // Record state after operation
        const afterAnnotations = annotatorInstance.getAnnotations();
        console.log(`[File Change] Cleaned UI annotations count: ${afterAnnotations.length}`);
      }

      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'set_path', path: '' }));
        console.log(`[File Change] Sent empty path WebSocket message`);
      }
      setCentroids([]);
      dispatch(clearPatchOverlays());
      dispatch(clearPatchOverrides());
      setAllTilesLoaded(false);
      setExistAnnotationFile(false);
      // Clear hash when switching images to avoid duplicate message detection
      lastHashRef.current = null;
      console.log(`[File Change] Cleared hash to avoid duplicate message detection`);
      // Explicitly reset counts to 0 when the file changes
      const currentNucleiClasses = store.getState().annotations.nucleiClasses;
      const resetCounts = currentNucleiClasses.map(cls => ({ ...cls, count: 0 }));
      // Only reset if there are actually non-zero counts to avoid unnecessary updates
      const hasNonZeroCounts = currentNucleiClasses.some(cls => cls.count > 0);
      if (hasNonZeroCounts) {
        dispatch(setNucleiClasses(resetCounts));
      }
      if (viewerInstance && viewerInstance.world.getItemCount() > 0) {
        try {
          viewerInstance.forceRedraw();
        } catch (error) {
          console.warn('[File Change] Failed to force redraw:', error);
        }
      }

      console.log(`[File Change] Completed cleaning and reset`);
    }
  }, [currentPath, dispatch, annotatorInstance, socket, viewerInstance]);

  useEffect(() => {
    //console.log('OpenSeadragonContainer - visibleChannels changed:', visibleChannels);
    if (viewerInstance && viewerInstance.world.getItemCount() > 0) {
      //console.log('Forcing viewer redraw');
      setAllTilesLoaded(false);
      try {
        viewerInstance.forceRedraw();
      } catch (error) {
        console.warn('[Visible Channels] Failed to force redraw:', error);
      }
    }

  }, [visibleChannels, viewerInstance]);

  // limit the number of calls to change channels
  const debouncedEffect = useMemo(
    () => debounce((newVisibleChannels) => {
      if (tileSource && viewerInstance && currentWSIInfo) {
        try {
          // Get current dimensions from WSI info
          let level_0_width = 50000;
          let level_0_height = 50000;
          if (Array.isArray(currentWSIInfo.dimensions)) {
            if (currentWSIInfo.dimensions.length > 0 && Array.isArray(currentWSIInfo.dimensions[0])) {
              [level_0_width, level_0_height] = currentWSIInfo.dimensions[0];
            }
          } else {
            [level_0_width, level_0_height] = currentWSIInfo.dimensions;
          }

          let scale = 16;
          const maxLevel = 8;
          const svs_width = level_0_width * scale;
          const svs_height = level_0_height * scale;
          const tile_size = 1024;

          viewerInstance.world.removeAll();
          
          // Create a complete tile source object
          const newTileSource = {
            width: svs_width,
            height: svs_height,
            tileSize: tile_size,
            tileOverlap: 0,
            minLevel: 0,
            maxLevel: maxLevel,
            getTileUrl: getTileUrl,
            ajaxHeaders: {
              'Content-Type': 'application/json',
              'Accept': 'image/jpeg,image/png,image/*,*/*',
              ...(currentInstanceId && { 'X-Instance-ID': currentInstanceId }),
            },
            _key: `${currentInstanceId}_${currentWSIFileInfo?.filePath || ''}_${svs_width}_${svs_height}_${channelSignature}`,
            _instanceId: currentInstanceId,
            _dimensions: { width: svs_width, height: svs_height }
          };
          
          viewerInstance.addTiledImage({ tileSource: newTileSource });
        } catch (error) {
          console.warn('[Debounced Effect] Failed to rebuild tiled image:', error);
        }
      }
    }, 300),
    [tileSource, getTileUrl, viewerInstance, currentInstanceId, currentWSIInfo, currentWSIFileInfo, channelSignature]
  );

  const prevVisibleChannelsRef = useRef(visibleChannels);

  useEffect(() => {
    // Only trigger if visibleChannels has actually changed
    if (JSON.stringify(prevVisibleChannelsRef.current) !== JSON.stringify(visibleChannels)) {
      debouncedEffect(visibleChannels);
      prevVisibleChannelsRef.current = visibleChannels;
    }

    return () => {
      debouncedEffect.cancel();
    };
  }, [visibleChannels, debouncedEffect]);

  useEffect(() => {
    const handleUpdateChannels = () => {
      console.log('[Update Channels] Event received, rebuilding tiled image...');
      console.log('[Update Channels] Current visibleChannels:', visibleChannels);
      console.log('[Update Channels] Current channels:', channels);
      console.log('[Update Channels] Current channelSignature:', channelSignature);
      
      if (tileSource && viewerInstance && currentWSIInfo) {
        try {
          // Get current dimensions from WSI info
          let level_0_width = 50000;
          let level_0_height = 50000;
          if (Array.isArray(currentWSIInfo.dimensions)) {
            if (currentWSIInfo.dimensions.length > 0 && Array.isArray(currentWSIInfo.dimensions[0])) {
              [level_0_width, level_0_height] = currentWSIInfo.dimensions[0];
            }
          } else {
            [level_0_width, level_0_height] = currentWSIInfo.dimensions;
          }

          let scale = 16;
          const maxLevel = 8;
          const svs_width = level_0_width * scale;
          const svs_height = level_0_height * scale;
          const tile_size = 1024;

          viewerInstance.world.removeAll();
          
          // Create a complete tile source object
          const newTileSource = {
            width: svs_width,
            height: svs_height,
            tileSize: tile_size,
            tileOverlap: 0,
            minLevel: 0,
            maxLevel: maxLevel,
            getTileUrl: getTileUrl,
            ajaxHeaders: {
              'Content-Type': 'application/json',
              'Accept': 'image/jpeg,image/png,image/*,*/*',
              ...(currentInstanceId && { 'X-Instance-ID': currentInstanceId }),
            },
            _key: `${currentInstanceId}_${currentWSIFileInfo?.filePath || ''}_${svs_width}_${svs_height}_${channelSignature}`,
            _instanceId: currentInstanceId,
            _dimensions: { width: svs_width, height: svs_height }
          };
          
          console.log('[Update Channels] Adding new tiled image with updated URL and signature:', channelSignature);
          viewerInstance.addTiledImage({ tileSource: newTileSource });
        } catch (error) {
          console.warn('[Update Channels] Failed to rebuild tiled image:', error);
          try { viewerInstance.forceRedraw(); } catch {}
        }
      } else {
        console.warn('[Update Channels] Missing required components:', { 
          tileSource: !!tileSource, 
          viewerInstance: !!viewerInstance, 
          currentWSIInfo: !!currentWSIInfo 
        });
      }
    };

    window.addEventListener('updateChannels', handleUpdateChannels);
    return () => {
      window.removeEventListener('updateChannels', handleUpdateChannels);
    };
  }, [viewerInstance, tileSource, getTileUrl, currentInstanceId, visibleChannels, channels, channelSignature, currentWSIInfo, currentWSIFileInfo]);

  const isRequestingClassification = useSelector((state: RootState) => state.annotations.isRequestingClassification);

  useEffect(() => {
    const handleClassificationRequest = async () => {
      dispatch(setClassificationEnabled(true));

      // 1) clear backend annotations
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'clear_annotations'
        }));
      }

      // 2) front-end clear annotations
      if (annotatorInstance) {
        annotatorInstance.setAnnotations([], true);
        dispatch(setAnnotations([]));
      }
      dispatch(clearPatchOverlays());
      dispatch(clearPatchOverrides());
      setCentroids([]);
      setShowBackendAnnotations(true);

      await handleLoadClassification();
      dispatch(classificationRequestComplete());
    };

    if (isRequestingClassification) {
      handleClassificationRequest();
    }
  }, [isRequestingClassification, annotatorInstance, currentPath, socket, dispatch, handleLoadClassification]);

  // Add Redux Status Monitoring
  const reduxAnnotations = useSelector((state: RootState) => state.annotations.annotations);

  // Add periodic memory checks
  useEffect(() => {
    if (annotatorInstance) {
      const intervalId = setInterval(() => {
        try {
          const uiAnnotations = annotatorInstance.getAnnotations();
          const reduxStateAnnotations = store.getState().annotations.annotations;


          // Try to output memory usage (Chrome only)
          if (window.performance && (window.performance as any).memory) {
          }

          // Check if they match
          if (uiAnnotations.length !== reduxStateAnnotations.length) {
          }
        } catch (error) {
          console.error('[Periodic Check] Error:', error);
        }
      }, 30000); // Check every 30 seconds

      return () => clearInterval(intervalId);
    }
  }, [annotatorInstance]);

  // Monitor Redux state changes
  useEffect(() => {
  }, [reduxAnnotations.length]);

  // Set viewer instance to context when annotatorInstance changes
  useEffect(() => {
    if (annotatorInstance?.viewer) {
      console.log('Setting viewerInstance to context:', { 
        annotatorInstanceExists: !!annotatorInstance, 
        viewerExists: !!annotatorInstance.viewer 
      });
      setViewerInstance(annotatorInstance.viewer);
    }
    // clear the viewer instance when the component unmounts
    return () => {
      console.log('Clearing viewerInstance from context');
      setViewerInstance(null);
      
      // Clean up WebGL contexts to prevent leaks
      if (webglContextManager.getContextCount() > 0) {
        console.log('Cleaning up WebGL contexts on viewer instance change');
        webglContextManager.releaseAllContexts();
      }
    }
  }, [annotatorInstance, setViewerInstance]);


  const handleCanvasDoubleClick = useCallback(async (event: OpenSeadragon.CanvasDoubleClickEvent) => {
    if (!viewerInstance || !activeManualClassificationClassRef.current) {
      console.log("[handleCanvasDoubleClick] Viewer or active class not available.");
      return;
    }

    const viewer = viewerInstance;
    const activeClass = activeManualClassificationClassRef.current;

    const webPoint = event.position;
    if (!webPoint) {
      console.log("[handleCanvasDoubleClick] No webPoint from event.");
      return;
    }
    const viewportPoint = viewer.viewport.pointFromPixel(webPoint);
    const imagePoint = viewer.viewport.viewportToImageCoordinates(viewportPoint);

    let closestCentroidTuple: [number, number, number, number] | undefined = undefined;
    let minDistanceSquared = Infinity;
    const CLICK_RADIUS_SQUARED = 350 * 350; // Using 350px radius

    centroids.forEach((centroidTuple) => {
      const [, cx, cy] = centroidTuple;
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

      // Dispatch to Redux for immediate UI update (for DrawingOverlay)
      dispatch(setAnnotationType([{
        id: String(centroidId),
        // classIndex: targetNucleiClassIndex, // classIndex might be useful here if DrawingOverlay or other logic needs it
        color: newClassColor,
        category: newClassName,
      }]));

      // Force OSD redraw
      if (viewerInstance && viewerInstance.world.getItemCount() > 0) {
        try {
          viewerInstance.forceRedraw();
        } catch (error) {
          console.warn('[OSD Redraw] Failed to force redraw:', error);
        }
      }

      const h5Path = getDefaultOutputPath(currentSvsPath);
      if (!h5Path) {
        console.error("[handleCanvasDoubleClick] Could not get H5 path for saving annotation.");
        return;
      }

      const payload = {
        path: h5Path,
        region_geometry: { x1: originalX, y1: originalY, x2: originalX, y2: originalY }, // Point geometry (Level 0)
        matching_indices: [Number(centroidId)],
        classification: newClassName,
        color: newClassColor, // Sending color for potential backend use or logging
        method: "canvas double-click classification",
        annotator: "Unknown", // Or get current user info if available
        ui_nuclei_classes: nucleiClasses.map(cls => cls.name),
        ui_nuclei_colors: nucleiClasses.map(cls => cls.color),
        ui_organ: currentOrgan,
      };

      console.log("[handleCanvasDoubleClick] Sending payload to /tasks/v1/save_annotation:", payload);

      try {
        const headers: any = {};
        if (currentInstanceId) {
          headers['X-Instance-ID'] = currentInstanceId;
        }
        await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_annotation`, payload, { headers });
        console.log("[handleCanvasDoubleClick] Annotation saved successfully via API.");

        // Immediately refresh counts: global totals and per-class list via WS
        EventBus.emit('refresh-annotations');
        EventBus.emit('refresh-websocket-path', { path: h5Path, forceReload: true });

        if (updateAfterEveryAnnotation && currentSvsPath && nucleiClasses.length > 0) {
          await triggerClassificationWorkflow(dispatch as AppDispatch, h5Path, nucleiClasses, currentOrgan);
        }

        setTimeout(() => handleToolbarClick(toolkitItems[0].tool), 50);
      } catch (error) {
        console.error("[handleCanvasDoubleClick] Error saving annotation or triggering workflow via API:", error);
      }
    } else {
      console.log("[handleCanvasDoubleClick] No close centroid found, or double-click intended for Annotorious.");
    }
  }, [centroids, dispatch, currentSvsPath, updateAfterEveryAnnotation, nucleiClasses, activeManualClassificationClassRef,
    viewerInstance, toolkitItems, currentOrgan, handleToolbarClick, currentInstanceId]);

  useEffect(() => {
    const viewer = viewerInstance;
    if (viewer) {
      // Remove handler first to prevent duplicates if effect re-runs
      viewer.removeHandler('canvas-double-click', handleCanvasDoubleClick as OpenSeadragon.EventHandler<OpenSeadragon.CanvasDoubleClickEvent>);
      viewer.addHandler('canvas-double-click', handleCanvasDoubleClick as OpenSeadragon.EventHandler<OpenSeadragon.CanvasDoubleClickEvent>);

      return () => {
        if (viewer) { // Check again in cleanup as viewer might be destroyed
          viewer.removeHandler('canvas-double-click', handleCanvasDoubleClick as OpenSeadragon.EventHandler<OpenSeadragon.CanvasDoubleClickEvent>);
        }
      };
    }
  }, [handleCanvasDoubleClick, viewerInstance]);

  const handleClickAnnotationForClassification = useCallback((annotation: ImageAnnotation) => {
    // console.log(`[handleClickAnnotationForClassification] Clicked Annotation:`, annotation);

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
      const viewer = viewerInstance;
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
      const originalX_level0 = centerX_osd_image / ZOOM_SCALE;
      const originalY_level0 = centerY_osd_image / ZOOM_SCALE;
      const newClassName = activeClass.name;
      const newClassColor = activeClass.color;

      console.log(`[handleClickAnnotationForClassification] Double-click: Processing ${centroidId} with class ${newClassName}`);

      dispatch(setAnnotationType([{ id: String(centroidId), color: newClassColor, category: newClassName }]));

      if (viewerInstance && viewerInstance.world.getItemCount() > 0) {
        try {
          viewerInstance.forceRedraw();
        } catch (error) {
          console.warn('[Final Redraw] Failed to force redraw:', error);
        }
      }

      const h5Path = getDefaultOutputPath(currentSvsPath);
      if (!h5Path) {
        console.error("[handleClickAnnotationForClassification] Double-click: Could not get H5 path.");
        lastClickTimestampRef.current = 0;
        lastClickedAnnotationIdRef.current = null;
        return;
      }

      const payload = {
        path: h5Path,
        region_geometry: { x1: originalX_level0, y1: originalY_level0, x2: originalX_level0, y2: originalY_level0 },
        matching_indices: [centroidId],
        classification: newClassName,
        color: newClassColor,
        method: "annotation double-click classification",
        annotator: "Unknown",
        ui_nuclei_classes: nucleiClasses.map(cls => cls.name),
        ui_nuclei_colors: nucleiClasses.map(cls => cls.color),
        ui_organ: currentOrgan,
      };

      const headers: any = {};
      if (currentInstanceId) {
        headers['X-Instance-ID'] = currentInstanceId;
      }
      http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_annotation`, payload, { headers })
        .then(async () => {
          console.log("[handleClickAnnotationForClassification] Double-click: Annotation saved.");

          // Immediately refresh counts: global totals and per-class list via WS
          EventBus.emit('refresh-annotations');
          EventBus.emit('refresh-websocket-path', { path: h5Path, forceReload: true });
          
          if (updateAfterEveryAnnotation && currentSvsPath && nucleiClasses.length > 0) {
            await triggerClassificationWorkflow(dispatch as AppDispatch, h5Path, nucleiClasses, currentOrgan);
          }

          setTimeout(() => {
            handleToolbarClick(toolkitItems[0].tool);
            if (annotatorInstance) {
              annotatorInstance.cancelSelected();
            }
          }, 50);
        })
        .catch((error: unknown) => {
          console.error("[handleClickAnnotationForClassification] Double-click: Error saving annotation:", error);
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

        // 1) git the center point of OSD bounds (OSD image coordinates)
        const selector = annotation.target?.selector as any;
        let cx_level0: number | undefined, cy_level0: number | undefined;
        if (selector?.geometry?.bounds) {
          const { minX, minY, maxX, maxY } = selector.geometry.bounds;
          const cx_img = (minX + maxX) / 2;
          const cy_img = (minY + maxY) / 2;
          // shift to level-0 coordinates
          cx_level0 = cx_img / ZOOM_SCALE;
          cy_level0 = cy_img / ZOOM_SCALE;
        }

        // 2) parse cellId: prefer annotation.id as number, otherwise find the closest point in centroids
        let cellId: string | number | null = null;
        const idNum = Number(currentAnnotationId);
        if (Number.isFinite(idNum)) {
          cellId = idNum;
        } else if (typeof cx_level0 === 'number' && typeof cy_level0 === 'number' && centroids.length > 0) {
          let bestId: number | null = null, bestD = Infinity;
          for (const c of centroids) { // c: [id, x, y, ...]
            const dx = c[1] - cx_level0;
            const dy = c[2] - cy_level0;
            const d2 = dx*dx + dy*dy;
            if (d2 < bestD) { bestD = d2; bestId = Number(c[0]); }
          }
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
            dataSource: 'single-click'
          }
        }));

        singleClickTimeoutRef.current = null;
      }, 300);
    }
  }, [activeManualClassificationClassRef, annotatorInstance, currentSvsPath, dispatch, nucleiClasses, updateAfterEveryAnnotation,
    DOUBLE_CLICK_THRESHOLD_MS, toolkitItems, currentOrgan, handleToolbarClick, currentInstanceId, currentPath, centroids, viewerInstance]);

  // Ruler handler
  const rulerHandler = useCallback((annotation: ImageAnnotation) => {
    if (annotation.target.selector.type === ShapeType.LINE) {
      const line = annotation.target.selector.geometry as LineGeometry;
      const start = line.points[0];
      const end = line.points[1];
      const lineLength = Math.sqrt(
        Math.pow(end[0] - start[0], 2) +
        Math.pow(end[1] - start[1], 2)
      ) / ZOOM_SCALE; // unit: pixel

      // Multiply by MPP to get accurate measurement in microns
      const mpp = slideInfo.mpp || 1; // Default to 1 if MPP is not available
      const lineLengthInMicrons = lineLength * mpp; // unit: micron (µm)

      // Convert to appropriate unit
      const { value: adjustedValue, unit } = convertToAppropriateUnit(lineLengthInMicrons);

      // Show tooltip with measurement at current mouse position
      setRulerTooltip({
        visible: true,
        text: `${Math.round(lineLength)} px | ${adjustedValue.toFixed(2)} ${unit}`,
        position: { x: mousePos.x, y: mousePos.y }
      });
      tooltipVisibleRef.current = true;

      console.log(`[Annotorious DEBUG] Ruler annotation: ${adjustedValue.toFixed(2)} ${unit}`);
    }
  }, [slideInfo, mousePos]);

  const rulerLeaveHandler = useCallback(() => {
    setRulerTooltip(prev => ({ ...prev, visible: false }));
    tooltipVisibleRef.current = false;
  }, []);

  const rulerMoveHandler = useCallback((event: PointerEvent) => {
    if (tooltipVisibleRef.current) {
      const offset = 10; // Offset from cursor
      setRulerTooltip(prev => ({
        ...prev,
        position: {
          x: event.clientX + offset,
          y: event.clientY + offset
        }
      }));
    }
  }, []);

  useEffect(() => {
    if (annotatorInstance) {
      // const selectHandler = (annotation: ImageAnnotation) => handleClickAnnotationForClassification(annotation, 'selectAnnotation');
      const clickHandler = (annotation: ImageAnnotation) => handleClickAnnotationForClassification(annotation);

      // annotatorInstance.on('selectAnnotation', selectHandler);
      annotatorInstance.on('clickAnnotation', clickHandler);

      // Log all available events if possible (pseudo-code, might not exist)
      // if (typeof (annotatorInstance as any).listEvents === 'function') {
      //   console.log('[Annotorious DEBUG] Available events:', (annotatorInstance as any).listEvents());
      // }
      // if ((annotatorInstance as any).state && typeof (annotatorInstance as any).state.emitter?.events === 'function') { // Common pattern for event emitters
      //    console.log('[Annotorious DEBUG] Emitter events:', (annotatorInstance as any).state.emitter.events());
      // }

      annotatorInstance.on('mouseEnterAnnotation', rulerHandler);
      annotatorInstance.on('mouseLeaveAnnotation', rulerLeaveHandler);

      return () => {
        // annotatorInstance.off('selectAnnotation', selectHandler);
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

  useEffect(() => {
    return () => {
      if (singleClickTimeoutRef.current) {
        clearTimeout(singleClickTimeoutRef.current);
        singleClickTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    console.log('[DEBUG-OSD] OpenSeadragonContainer loaded, creating debug helper');
    
    (window as any).debugSelectCell = (cellId = 'debug-001', x = 100000, y = 50000, slideId?: string) => {
      const sid = slideId || currentPath || 'unknown';
      window.dispatchEvent(new CustomEvent('cellSelected', {
        detail: { cellId, centroid: { x, y }, slideId: sid }
      }));
      console.log('[DEBUG-OSD] dispatched cellSelected:', { cellId, x, y, slideId: sid });
    };
    
    const testListener = (event: CustomEvent) => {
      console.log('[DEBUG-OSD] cellSelected event detected in OpenSeadragonContainer:', event.detail);
    };
    
    window.addEventListener('cellSelected', testListener as EventListener);
    console.log('[DEBUG-OSD] debugSelectCell ready and test listener added');
    
    return () => {
      window.removeEventListener('cellSelected', testListener as EventListener);
    };
  }, [currentPath]);

  return (
    <div className="flex flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}>
      <div className="flex gap-2 px-2 py-1 w-full h-10">
        <span style={{ color: '#222', fontWeight: 500, fontSize: 14, marginRight: 3, alignSelf: 'center' }} className="whitespace-nowrap flex-shrink-0">Control Panel:</span>
        {/* Displaying icons directly */}
        {toolkitItems.map((item) => {
          // shortcut key mapping
          // Read from user-configurable bindings
          const shortcutMap: Record<string, string> = {
            move: bindings['tool.move'],
            polygon: bindings['tool.polygon'],
            rectangle: bindings['tool.rectangle'],
            line: bindings['tool.line']
          };
          const shortcut = item.tool && shortcutMap[item.tool as string];
          return (
            <div key={item.name} className="relative inline-block">
              {/* Button */}
              <button
                onClick={() => handleToolbarClick(item.tool === undefined ? item.name : item.tool)}
                onMouseEnter={() => setHoveredTool(item.name)}
                onMouseLeave={() => setHoveredTool(null)}
                className={`text-gray-800 hover:text-blue-600 flex items-center px-1 py-1 rounded-md ${currentTool === item.tool ? 'bg-gray-300' : ''}`}
                style={{ position: 'relative' }}
              >
                {item.icon}
                {/* shortcut key hint */}
                {shortcut && (
                  <span style={{
                    position: 'absolute',
                    right: -5,
                    bottom: -5,
                    background: 'rgba(127, 127, 127, 0.75)',
                    color: '#fff',
                    borderRadius: '50%',
                    minWidth: 15,
                    height: 15,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 600,
                    fontSize: 10,
                    pointerEvents: 'none',
                    letterSpacing: 1,
                    boxShadow: '0 1px 2px rgba(0,0,0,0.10)',
                    lineHeight: 1
                  }}>{shortcut}</span>
                )}
              </button>
              {hoveredTool === item.name && (
                <div
                  className="absolute left-0 mt-2 w-40 z-10 rounded-md shadow-lg bg-gray-100/80 backdrop-blur-md ring-1 ring-black ring-opacity-5"
                  onMouseEnter={() => setHoveredTool(item.name)}
                  onMouseLeave={() => setHoveredTool(null)}>
                  <div className="py-1">
                    <div
                      className="block px-4 py-2 text-sm text-gray-600 hover:bg-gray-200/80 hover:text-gray-900"
                    >
                      {item.name}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <div className="text-sm text-gray-700">
            Navigator
          </div>
          <button
            onClick={toggleShowNavigator}
            className={`
                w-12 h-6 flex items-center rounded-full p-1
                transition-colors
                ${showNavigator ? "bg-green-500" : "bg-gray-300"}
                `}
          >
            <div
              className={`
                  w-5 h-5 bg-white rounded-full shadow-md
                  transform transition-transform
                  ${showNavigator ? "translate-x-5" : ""}
                `}
            />
          </button>
        </div>
      </div>

      {/* OpenSeadragon viewer */}
      {/*@ts-ignore*/}
      <OpenSeadragonAnnotator
        autoSave
        drawingEnabled={dynamicDrawingEnabled}
        tool={currentTool === 'move' ? undefined : currentTool}
        userSelectAction={showUserAnnotations ? UserSelectAction.EDIT : UserSelectAction.NONE}
        drawingMode="drag"
        key={`annotator-${currentInstanceId}-${tileSource?._key || 'default'}`} // use tileSource key to ensure re-creation
      >
        {/* Viewer height dynamically calculated based on actual header heights */}
        <div 
          className="relative w-full"
          style={{ height: `calc(100vh - ${headerHeight}px)` }}
        >
          {/*@ts-ignore*/}
          {options && (
            <OpenSeadragonViewer
              key={`viewer-${currentInstanceId}-${tileSource?._key || 'default'}`} // use tileSource key to ensure re-creation
              className="bg-gray-700 w-full h-full relative"
              options={options}
            />
          )}

          {/* OSD Navigator */}
          {viewerInstance && showNavigator && (
            <OSDNavigator
              navigatorSizeRatio={0.2}
              autoHideDelay={1000}
            />
          )}

          {showBackendAnnotations && overlayHostRef.current && ReactDOM.createPortal(
            <DrawingOverlay
              viewer={viewerInstance}
              centroids={centroids}
              annotations={renderingAnnotations}
              threshold={threshold}
              classificationData={classificationData}
              nucleiClasses={nucleiClasses}
            />,
            overlayHostRef.current)}

          {showPatches && overlayHostRef.current && ReactDOM.createPortal(
            <PatchOverlay
              viewer={viewerInstance}
              patches={patches}
            />,
            overlayHostRef.current)}
          {/* Status bar at the bottom of the viewer */}
          <div style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: '22px',
            background: '#111827',
            color: '#ffffff',
            fontSize: '11px',
            fontFamily: 'Segoe UI, sans-serif',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            padding: '0 8px',
            borderTop: '1px solid #111827',
            boxShadow: '0 -1px 3px rgba(0,0,0,0.1)'
          }}>
            {/* Mouse coordinates section */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0 6px',
              height: '100%',
              borderRight: '1px solid rgba(255,255,255,0.1)',
              marginRight: '6px',
              minWidth: '120px',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}>
              <span style={{ marginRight: '6px', opacity: 0.9, flexShrink: 0 }}><Mouse size={14} /></span>
              <span style={{ 
                fontWeight: '500',
                whiteSpace: 'nowrap'
              }}>
                <span style={{ display: 'inline-block', textAlign: 'right', minWidth: '40px' }}>
                  {Math.round(mousePos.x)}
                </span>
                ,{' '}
                <span style={{ display: 'inline-block', textAlign: 'right', minWidth: '40px' }}>
                  {Math.round(mousePos.y)}
                </span>
              </span>
            </div>

            {/* View bounds section */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0 6px',
              height: '100%',
              borderRight: '1px solid rgba(255,255,255,0.1)',
              marginRight: '6px',
              gap: '6px',
              minWidth: '220px',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}>
              <span style={{ opacity: 0.9, marginRight: '6px', flexShrink: 0 }}><Monitor size={14} /></span>
              <span style={{ 
                fontWeight: '500',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: '180px'
              }}>
                (<span style={{ display: 'inline-block', textAlign: 'right', minWidth: '36px' }}>
                  {Math.round(imageBounds.x1 / ZOOM_SCALE)}
                </span>, <span style={{ display: 'inline-block', textAlign: 'right', minWidth: '36px' }}>
                  {Math.round(imageBounds.y1 / ZOOM_SCALE)}
                </span>) - (<span style={{ display: 'inline-block', textAlign: 'right', minWidth: '36px' }}>
                  {Math.round(imageBounds.x2 / ZOOM_SCALE)}
                </span>, <span style={{ display: 'inline-block', textAlign: 'right', minWidth: '36px' }}>
                  {Math.round(imageBounds.y2 / ZOOM_SCALE)}
                </span>)
              </span>
            </div>

            {/* Zoom section */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0 8px',
              height: '100%',
              minWidth: '60px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              borderRight: currentWSIFileInfo?.fileName ? '1px solid rgba(255,255,255,0.1)' : 'none',
              marginRight: currentWSIFileInfo?.fileName ? '6px' : '0'
            }}>
              <span style={{ marginRight: '6px', opacity: 0.9, flexShrink: 0 }}><Search size={14} /></span>
              <span style={{ 
                fontWeight: '500', 
                display: 'inline-block', 
                textAlign: 'right', 
                minWidth: '30px',
                whiteSpace: 'nowrap'
              }}>
                {magnification.toFixed(2)}x
              </span>
            </div>

            {/* File name section */}
            {currentWSIFileInfo?.fileName && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0 8px',
                height: '100%',
                maxWidth: '200px'
              }}>
                <span style={{ marginRight: '6px', opacity: 0.9 }}><FileText size={14} /></span>
                <span style={{ 
                  fontWeight: '500',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}>
                  {currentWSIFileInfo.fileName}
                </span>
              </div>
            )}

            {/* Spacer to push content to the left */}
            <div style={{ flex: 1 }}></div>

            {/* Loading indicators section */}
            {(loadingAnnotations && allTilesLoaded) && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0 8px',
                height: '100%',
                borderLeft: '1px solid rgba(255,255,255,0.1)',
                marginLeft: '8px',
                gap: '6px',
                whiteSpace: 'nowrap',
                minWidth: 'fit-content'
              }}>
                <div style={{
                  width: '10px',
                  height: '10px',
                  border: '1px solid rgba(255, 255, 255, 0.3)',
                  borderTop: '1px solid white',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                  flexShrink: 0
                }}></div>
                <span style={{ 
                  fontSize: '11px', 
                  opacity: 0.9,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '120px'
                }}>Loading Annotations...</span>
              </div>
            )}

            {(!isUploading && !allTilesLoaded) && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0 8px',
                height: '100%',
                borderLeft: '1px solid rgba(255,255,255,0.1)',
                marginLeft: '8px',
                gap: '6px',
                whiteSpace: 'nowrap',
                minWidth: 'fit-content'
              }}>
                <div style={{
                  width: '10px',
                  height: '10px',
                  border: '1px solid rgba(255, 255, 255, 0.3)',
                  borderTop: '1px solid white',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                  flexShrink: 0
                }}></div>
                <span style={{ 
                  fontSize: '11px', 
                  opacity: 0.9,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '100px'
                }}>Loading tiles...</span>
              </div>
            )}
          </div>
        </div>
        {/*@ts-ignore*/}
        <OpenSeadragonAnnotationPopup
          popup={(props: any) => (
            <AnnotationPopup
              annotation={props.annotation}
              selectedTool={currentTool}
              onSave={(color, customText) => {
                try {
                  const annotation = annotatorInstance.getAnnotationById(props.annotation.id);
                  if (annotation) {
                    const updatedAnnotation = {
                      ...annotation,
                      bodies: [
                        ...annotation.bodies.filter((b: AnnotationBody) => b.purpose !== 'style' && b.purpose !== 'comment'),
                        {
                          id: String(Date.now()),
                          annotation: annotation.id,
                          type: 'TextualBody',
                          purpose: 'style',
                          value: color,
                          created: new Date().toISOString(),
                          creator: {
                            id: 'default',
                            type: 'Person'
                          }
                        },
                        {
                          id: String(Date.now()),
                          annotation: annotation.id,
                          type: 'TextualBody',
                          purpose: 'comment',
                          value: customText,
                          created: new Date().toISOString(),
                          creator: {
                            id: 'default',
                            type: 'Person'
                          }
                        }
                      ]
                    };

                    // use updateAnnotation to update the annotation
                    annotatorInstance.updateAnnotation(updatedAnnotation);
                    // re-select the annotation to show the updated style
                    annotatorInstance.setSelected(updatedAnnotation.id);
                  }
                  annotatorInstance.cancelSelected();


                } catch (error) {
                  console.error('Error saving annotation:', error);
                } finally {
                  dispatch(resetShapeData());
                }
              }}
              onCancel={() => {
                try {
                  const isBackend = props?.annotation?.isBackend === true;
                  // Only remove user-drawn shapes (e.g., temporary ROI). Do NOT remove backend cell polygons.
                  if (!isBackend && props.annotation && props.annotation.id) {
                    annotatorInstance.removeAnnotation(props.annotation.id);
                  }
                } catch {}
                annotatorInstance.cancelSelected();

                // reset shape data
                dispatch(resetShapeData());
              }}
              annotatorInstance={annotatorInstance}
              instanceId={currentInstanceId}
            ></AnnotationPopup>
            // </div>
          )} />
      </OpenSeadragonAnnotator>

      {/* Ruler Tooltip */}
      {rulerTooltip.visible && (
        <div className="absolute bg-white shadow-lg border-0 text-black p-2 rounded-md text-sm font-sans z-1000 pointer-events-none"
          style={{ left: `${rulerTooltip.position.x}px`, top: `${rulerTooltip.position.y}px` }}
        >
          {rulerTooltip.text}
        </div>
      )}

      {dragging && (
        <div ref={textRef}
          className="z-50 absolute inset-0 flex items-center justify-center bg-black bg-opacity-50">
          <p className="text-white text-2xl z-10">Drag the file here to reload</p>
        </div>
      )}
      {isUploading && <LoadingSpinner />}
    </div>
  );
};

export default OpenSeadragonContainer;
