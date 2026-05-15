"use client";
import {
  AnnotationBody,
  AnnotationState,
  ImageAnnotation,
} from "@annotorious/react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
// OpenSeadragon  will be dynamically imported to avoid SSR issues
import DrawingOverlay from "@/components/imageViewer/DrawingOverlay";
import PatchOverlay from "@/components/imageViewer/PatchOverlay";
import MaskOverlay from "@/components/imageViewer/MaskOverlay";
import dynamic from "next/dynamic";
import ReactDOM from "react-dom";

// functions
import { UserSelectAction } from "@annotorious/react";

// redux
import { RootState, store } from "@/store";
import {
  setPendingGraphOverlayRestore,
  type GraphWorkflowOverlaySnapshot,
} from "@/store/slices/chat/workflowSlice";
import {
  classificationRequestComplete,
  setClassificationEnabled,
} from "@/store/slices/viewer/annotationSlice";
import {
  RectangleCoords,
  resetShapeData,
  setShapeData,
} from "@/store/slices/viewer/shapeSlice";
import { setGtHighlightIndices, clearGtHighlightIndices } from "@/store/slices/viewer/gtHighlightSlice";
import { setTool } from "@/store/slices/viewer/toolSlice";
import { useDispatch, useSelector } from "react-redux";

import {
  clearAnnotationTypes,
  clearPatchOverlays,
  clearPatchOverrides,
  selectPatchClassificationData,
  selectPatchOverlays,
  setAnnotations,
  setNucleiClasses,
  setPatchClassificationData,
} from "@/store/slices/viewer/annotationSlice";
import { appendSegment, resetTranscriptDisplay, setListening, setTranscriptError, setGptThinking } from "@/store/slices/viewer/recordingTranscriptSlice";
import EventBus from "@/utils/EventBus";

//custom components
import useAnnotatorInitialization from "@/hooks/viewer/useAnnotatorInitialization";
import { useOpenSeadragonGestures } from "@/hooks/viewer/useOpenSeadragonGestures";
import useOpenSeadragonViewerEvents from "@/hooks/viewer/useOpenSeadragonViewerEvents";
import { useAutoViewActLogging } from "@/hooks/viewer/useViewActLogger";
import { useCollectRealtime } from "@/hooks/viewer/useCollectRealtime";
import { usePresence } from "@/hooks/viewer/usePresence";

// hashing function
import xxhash from "xxhash-wasm";

import Cookies from "js-cookie";

import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { useViewerSettings } from "@/hooks/viewer/useViewerSettings";
import { useWebGLCleanup } from "@/hooks/viewer/useWebGLCleanup";
import { webglContextManager } from "@/utils/webglContextManager";

import OSDNavigator from "@/components/imageViewer/OSDNavigator";
import {
  AI_SERVICE_API_ENDPOINT,
  AI_SERVICE_SOCKET_ENDPOINT,
} from "@/constants/config";

// Workflow utility
import AnnotationPopup from "@/components/imageViewer/ToolBox/AnnotationPopup";
import RulerTooltip from "@/components/imageViewer/Viewer/RulerTooltip";
import ViewerStatusBar from "@/components/imageViewer/Viewer/ViewerStatusBar";
import ViewerToolbar from "@/components/imageViewer/Viewer/ViewerToolbar";
import ZStackController from "@/components/imageViewer/ZStackController";
import { useWs } from "@/contexts/WsProvider";
import { useAnnotationHandlers } from "@/hooks/viewer/useAnnotationHandlers";
import { useRefreshGtHighlightIndices } from "@/hooks/viewer/useRefreshGtHighlightIndices";
import { useChannelUpdates } from "@/hooks/viewer/useChannelUpdates";
import { useFileChangeHandler } from "@/hooks/viewer/useFileChangeHandler";
import { useKeyboardHandlers } from "@/hooks/viewer/useKeyboardHandlers";
import { useViewportDataRequests } from "@/hooks/viewer/useViewportDataRequests";
import { useViewportRefresh } from "@/hooks/viewer/useViewportRefresh";
import { useWebSocketMessageHandler } from "@/hooks/viewer/useWebSocketMessageHandler";
import { selectSelectedModelForPath } from "@/store/slices/chat/modelSelectionSlice";
import {
  annotationTypeStore,
  useAnnotationTypes,
} from "@/store/zustand/slice/annotationTypesStore";
import { apiFetch } from "@/utils/common/apiFetch"; // centralized http client
import { getErrorMessage } from "@/utils/common/apiResponse";
import {
  createTileSource,
  createTileUrlGenerator,
  createTileUrlGeneratorForLayer,
  getLargestTiledImage,
} from "@/utils/viewer/viewerHelpers";
import { formatPath } from "@/utils/pathUtils";
import { getDefaultOutputPath } from "@/utils/workflowUtils";
import { getMaskOptions, type MaskOption } from "@/services/data.service";
import { setSelectedMaskKey } from "@/store/slices/viewer/viewerSettingsSlice";
import OpenSeadragon from "openseadragon";
import "@annotorious/react/annotorious-react.css";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { CentroidsArray } from "./CentroidsArray";

// dynamic import packages
const OpenSeadragonAnnotator = dynamic(
  () => import("@annotorious/react").then((mod) => mod.OpenSeadragonAnnotator),
  { ssr: false },
);
const OpenSeadragonAnnotationPopup = dynamic(
  () =>
    import("@annotorious/react").then(
      (mod) => mod.OpenSeadragonAnnotationPopup,
    ),
  { ssr: false },
);
const OpenSeadragonViewer = dynamic(
  () => import("@annotorious/react").then((mod) => mod.OpenSeadragonViewer),
  { ssr: false },
);

// Empty CentroidsArray constant for reuse
const EMPTY_CENTROIDS = new CentroidsArray(new Int32Array(0), 0);

const OpenSeadragonContainer: React.FC<{ instanceId?: string }> = ({
  instanceId,
}) => {
  const [tileSource, setTileSource] = useState<any>(null);
  const [options, setOptions] = useState<any>(null);
  const [headerHeight, setHeaderHeight] = useState(104);
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const lastResetTimestampRef = useRef<number>(0);
  const overlayHostRef = useRef<HTMLDivElement | null>(null);

  // Instance cleanup is handled at page-level; avoid duplicate scheduling here

  // Use WebGL cleanup hook
  useWebGLCleanup(instanceId || undefined);

  // Filter out OpenSeadragon viewport warnings from third-party libraries
  useEffect(() => {
    const originalError = console.error;

    console.error = (...args: any[]) => {
      // Filter out specific OpenSeadragon warnings from third-party libraries
      const message = args[0]?.toString() || "";
      if (
        message.includes("viewportToImageCoordinates") ||
        message.includes("viewportToImageRectangle")
      ) {
        // Silently ignore these warnings
        return;
      }
      // Pass through all other errors
      originalError.apply(console, args);
    };

    return () => {
      console.error = originalError;
    };
  }, []);

  // Load viewer settings from localStorage on component mount
  const { zoomSpeed, trackpadGesture, showNavigator, toggleShowNavigator } =
    useViewerSettings();

  const [showPatches, setShowPatches] = useState(false);
  const [showMask, setShowMask] = useState(false);
  const [maskOptions, setMaskOptions] = useState<MaskOption[]>([]);
  const selectedMaskKey = useSelector((state: RootState) => state.viewerSettings.selectedMaskKey);

  // Wrapper for setShowMask to set loading state when enabling mask
  const handleSetShowMask = useCallback(
    (value: React.SetStateAction<boolean>) => {
      const newValue = typeof value === "function" ? value(showMask) : value;
      if (newValue && !showMask) {
        // When enabling mask, set loading state immediately
        setLoadingMask(true);
      } else if (!newValue) {
        setLoadingMask(false);
      }
      setShowMask(value);
    },
    [showMask],
  );
  const showPatchesRef = useRef(showPatches);
  showPatchesRef.current = showPatches;
  const showMaskRef = useRef(showMask);
  showMaskRef.current = showMask;
  // Access viewer instance early to avoid use-before-declare
  const {
    setAnnotatorInstance,
    viewerInstance,
    setViewerInstance,
    setInstanceId,
  } = useAnnotatorInstance();

  // Create and manage a controlled overlay host inside OSD canvas
  useEffect(() => {
    const canvas = (viewerInstance?.canvas as HTMLElement | undefined) || null;

    if (!canvas) {
      return;
    }

    const host = document.createElement("div");
    host.style.position = "absolute";
    host.style.top = "0";
    host.style.left = "0";
    host.style.width = "100%";
    host.style.height = "100%";
    host.style.pointerEvents = "none";
    host.dataset.tlOverlayHost = "1";

    const placeBeforeAnnotorious = () => {
      const annotoriousGl = canvas.querySelector(".a9s-gl-canvas");
      const annotoriousCanvas = canvas.querySelector(".a9s-canvas");
      const reference =
        (annotoriousCanvas as Node) || (annotoriousGl as Node) || null;

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
    const mainImageCanvas = canvasContainer.querySelector(
      "canvas:first-of-type",
    ) as HTMLCanvasElement;
    if (!mainImageCanvas) return;

    // Apply CSS filter effect
    const applyImageFilters = () => {
      const { brightness, contrast, saturation, sharpness, gamma } =
        imageSettings;

      // Convert percentage values to CSS filter values
      const brightnessValue = brightness / 50 - 1; // 50% = 1, 0% = -1, 100% = 1
      const contrastValue = contrast / 50; // 50% = 1, 0% = 0, 100% = 2
      const saturationValue = saturation / 50; // 50% = 1, 0% = 0, 100% = 2

      // Improved sharpness implementation using contrast and brightness combination
      // Sharpness > 50: increase contrast and slight brightness boost
      // Sharpness < 50: decrease contrast and slight brightness reduction
      let sharpnessContrastMultiplier = 1;
      let sharpnessBrightnessOffset = 0;

      if (sharpness > 50) {
        // Increase sharpness: boost contrast and slight brightness
        const sharpnessFactor = (sharpness - 50) / 50; // 0 to 1
        sharpnessContrastMultiplier = 1 + sharpnessFactor * 0.5; // 1 to 1.5
        sharpnessBrightnessOffset = sharpnessFactor * 0.1; // 0 to 0.1
      } else if (sharpness < 50) {
        // Decrease sharpness: reduce contrast and slight brightness
        const sharpnessFactor = (50 - sharpness) / 50; // 0 to 1
        sharpnessContrastMultiplier = 1 - sharpnessFactor * 0.3; // 1 to 0.7
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
      const finalBrightnessValue =
        1 + brightnessValue + sharpnessBrightnessOffset;

      // Build CSS filter string
      const filters = [
        `brightness(${finalBrightnessValue})`,
        `contrast(${finalContrastValue})`,
        `saturate(${saturationValue})`,
        `hue-rotate(0deg)`, // Keep hue unchanged
      ]
        .filter(Boolean)
        .join(" ");

      // Apply filter only to the main image canvas, not the container
      mainImageCanvas.style.filter = filters;
    };

    applyImageFilters();
  }, [viewerInstance, imageSettings]);

  // Viewer height calculation
  useEffect(() => {
    const isElectron =
      typeof window !== "undefined" &&
      (window.navigator.userAgent.includes("Electron") || !!window.electron);
    const isWindows = navigator.userAgent.toLowerCase().includes("win");

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
  const currentPath = useSelector(
    (state: RootState) => state.svsPath.currentPath,
  );

  // Fetch mask options when path changes (Segmentation/mask_tissuename or default)
  useEffect(() => {
    if (!currentPath) {
      setMaskOptions([]);
      return;
    }
    const zarrPath = getDefaultOutputPath(formatPath(currentPath));
    if (!zarrPath) {
      setMaskOptions([]);
      return;
    }
    getMaskOptions(zarrPath).then((res) => {
      if (res.success && res.options) setMaskOptions(res.options);
      else setMaskOptions([]);
    });
  }, [currentPath]);

  const { onlineUsers } = usePresence(currentPath);

  useEffect(() => {
    console.log("[Container] usePresence returned users:", onlineUsers);
  }, [onlineUsers]);

  // Get slide info for MPP calculation
  const slideInfo = useSelector((state: RootState) => state.svsPath.slideInfo);

  // reloading related
  const [dragging, setDragging] = useState(false);
  const textRef = useRef(null);

  // hide/show state
  const [showBackendAnnotations, setShowBackendAnnotations] = useState(false);
  /** Latest Cell / backend overlay flag for graph workflow snapshot (see workflow-graph-run-* listeners). */
  const showBackendAnnotationsRef = useRef(showBackendAnnotations);
  showBackendAnnotationsRef.current = showBackendAnnotations;
  const [showUserAnnotations, setShowUserAnnotations] = useState(true);
  const showUserAnnotationsRef = useRef(showUserAnnotations);
  showUserAnnotationsRef.current = showUserAnnotations;
  const [existAnnotationFile, setExistAnnotationFile] = useState(false);

  // Track current request type for appropriate error messages
  const [currentRequestType, setCurrentRequestType] = useState<
    "space" | "x" | null
  >(null);

  // Track if a request is pending to prevent rapid key presses
  const [isRequestPending, setIsRequestPending] = useState(false);

  // Track if Zarr file is being initialized (set_path sent but not yet loaded)
  const [isZarrInitializing, setIsZarrInitializing] = useState(false);

  // Protection period removed - tiles loading is sufficient protection

  // Zarr initialization timeout
  const zarrInitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ZARR_INIT_TIMEOUT_MS = 30000; // Sample/public Zarr initialization can be slow; avoid premature timeout

  const nucleiClasses = useSelector(
    (state: RootState) => state.annotations.nucleiClasses,
  );
  const { annotationTypes, version: annotationTypesVersion } =
    useAnnotationTypes();
  const activeManualClassificationClass = useSelector(
    (state: RootState) => state.annotations.activeManualClassificationClass,
  );
  const updateAfterEveryAnnotation = useSelector(
    (state: RootState) => state.workflow.updateAfterEveryAnnotation,
  );
  const updateClassifier = useSelector(
    (state: RootState) => state.workflow.updateClassifier,
  );
  const currentSvsPath = useSelector(
    (state: RootState) => state.svsPath.currentPath,
  );
  const currentOrgan = useSelector(
    (state: RootState) => state.workflow.currentOrgan,
  );
  const isRunning = useSelector((state: RootState) => state.workflow.isRunning);
  const currentTool = useSelector((state: RootState) => state.tool.currentTool);

  // Workflow graph / hook startWorkflow: restore viewer overlay toggles to their state at run start when the run finishes.
  useEffect(() => {
    const onGraphRunStart = () => {
      const active = store.getState().wsi.activeInstanceId;
      if (active != null && instanceId != null && active !== instanceId) {
        return;
      }
      const snap: GraphWorkflowOverlaySnapshot = {
        showBackendAnnotations: showBackendAnnotationsRef.current,
        showPatches: showPatchesRef.current,
        showMask: showMaskRef.current,
        showUserAnnotations: showUserAnnotationsRef.current,
      };
      store.dispatch(setPendingGraphOverlayRestore(snap));
    };
    const onGraphRunAbort = () => {
      store.dispatch(setPendingGraphOverlayRestore(null));
    };
    const onGraphRunFinished = () => {
      const active = store.getState().wsi.activeInstanceId;
      if (active != null && instanceId != null && active !== instanceId) {
        return;
      }
      const pending = store.getState().workflow.pendingGraphOverlayRestore;
      if (pending === null) {
        return;
      }
      store.dispatch(setPendingGraphOverlayRestore(null));
      setShowBackendAnnotations(pending.showBackendAnnotations);
      setShowPatches(pending.showPatches);
      handleSetShowMask(pending.showMask);
      setShowUserAnnotations(pending.showUserAnnotations);
    };
    EventBus.on("workflow-graph-run-start", onGraphRunStart);
    EventBus.on("workflow-graph-run-aborted", onGraphRunAbort);
    EventBus.on("workflow-graph-run-finished", onGraphRunFinished);
    return () => {
      EventBus.off("workflow-graph-run-start", onGraphRunStart);
      EventBus.off("workflow-graph-run-aborted", onGraphRunAbort);
      EventBus.off("workflow-graph-run-finished", onGraphRunFinished);
    };
  }, [instanceId, handleSetShowMask]);

  // Get selectedFolder and selected model for classifier path
  const selectedFolder = useSelector(
    (state: RootState) => state.fileManager.selectedFolder,
  );
  // Get selected model for current path (same logic as ClassificationPanelContent)
  const selectedModelForCurrentPath = useSelector((state: RootState) => {
    let targetPath = selectedFolder || "";
    if (!targetPath && currentPath) {
      const separator = currentPath.includes("\\") ? "\\" : "/";
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath =
        lastIndex !== -1 ? currentPath.substring(0, lastIndex) : currentPath;
    }
    return selectSelectedModelForPath(state, targetPath);
  });

  const dynamicDrawingEnabled = showUserAnnotations && currentTool !== "move";

  // Ref to hold the latest activeManualClassificationClass
  const activeManualClassificationClassRef = useRef(
    activeManualClassificationClass,
  );

  useEffect(() => {
    activeManualClassificationClassRef.current =
      activeManualClassificationClass;
  }, [activeManualClassificationClass]);

  const annotationFilter = useCallback(
    (annotation: { isBackend: any }) => {
      const isImageFile =
        currentPath &&
        (currentPath.toLowerCase().endsWith(".png") ||
          currentPath.toLowerCase().endsWith(".jpg") ||
          currentPath.toLowerCase().endsWith(".jpeg") ||
          currentPath.toLowerCase().endsWith(".bmp"));

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
    },
    [showBackendAnnotations, showUserAnnotations, currentPath],
  );

  // Current ROI selection (rectangle or polygon) for ROI-aware styling
  const shapeData = useSelector((state: RootState) => state.shape.shapeData);
  const filterHighlightIndices = useSelector((state: RootState) => state.shape.filterHighlightIndices);

  // threshold
  const threshold = useSelector(
    (state: RootState) => state.annotations.threshold,
  );
  const centroidThreshold = useSelector(
    (state: RootState) => state.viewerSettings.centroidThreshold,
  );

  const dispatch = useDispatch();

  // initialize annotator
  const { annotatorInstance, viewerRef } = useAnnotatorInitialization();

  // Eye-tracking module: when enabled, feeds gaze data into behavior logger (saved with viewport to Firebase)
  // Collect tab: real-time transcription via WebSocket (OpenAI Realtime API proxy)
  const collectRealtime = useCollectRealtime();
  const collectRealtimeRef = useRef(collectRealtime);
  collectRealtimeRef.current = collectRealtime;
  const transcriptActive = useSelector((state: RootState) => state.recordingTranscript.transcriptActive);
  const realtimeActiveRef = useRef(false);
  const gptPlaceholderIdRef = useRef<string | null>(null);

  useEffect(() => {
    const realtime = collectRealtimeRef.current;
    if (transcriptActive) {
      if (!realtimeActiveRef.current) {
        realtimeActiveRef.current = true;
        // Clear UI only: show only new segments; full transcript still uploaded with behavior
        dispatch(resetTranscriptDisplay());
        dispatch(setTranscriptError(null));
        dispatch(setListening(true));
        const sessionId = instanceId || 'default';
        const wsUrl = `${AI_SERVICE_SOCKET_ENDPOINT}/collect/realtime?session_id=${encodeURIComponent(sessionId)}`;
        realtime.start(wsUrl, {
          onDelta: (interimText) => {
            dispatch(
              appendSegment({
                id: "realtime-interim",
                text: interimText,
                timestamp: Date.now(),
                isFinal: false,
              })
            );
          },
          onCompleted: (text) => {
            if (text)
              dispatch(
                appendSegment({
                  id: `b-${Date.now()}`,
                  text,
                  timestamp: Date.now(),
                  isFinal: true,
                })
              );
          },
          onGptThinking: (thinking) => {
            dispatch(setGptThinking(thinking));
            if (thinking) {
              const id = `gpt-placeholder-${Date.now()}`;
              gptPlaceholderIdRef.current = id;
              dispatch(
                appendSegment({
                  id,
                  text: '...',
                  timestamp: Date.now(),
                  isFinal: false,
                  source: 'gpt',
                })
              );
            }
          },
          onGptFollowUp: (message) => {
            dispatch(setGptThinking(false));
            const id = gptPlaceholderIdRef.current ?? `gpt-${Date.now()}`;
            gptPlaceholderIdRef.current = null;
            dispatch(
              appendSegment({
                id,
                text: message,
                timestamp: Date.now(),
                isFinal: true,
                source: 'gpt',
              })
            );
          },
          onError: (message) => {
            dispatch(setTranscriptError(message));
          },
        });
      }
    } else {
      if (realtimeActiveRef.current) {
        realtimeActiveRef.current = false;
        dispatch(setListening(false));
        realtime.stop();
      }
    }
  }, [transcriptActive, dispatch, instanceId]);

  // Collecting data: send viewport every 0.5s so trigger uses current screenshot + transcript
  useEffect(() => {
    if (!transcriptActive) return;
    const id = setInterval(() => {
      const viewer = viewerRef.current;
      const realtime = collectRealtimeRef.current;
      if (!viewer?.viewport?.getBounds || !viewer?.world?.getItemAt(0) || !realtime.sendViewport) return;
      try {
        const bounds = viewer.viewport.getBounds();
        const tiled = viewer.world.getItemAt(0) as { viewportToImageCoordinates: (p: unknown) => { x: number; y: number } };
        const topLeft = tiled.viewportToImageCoordinates(bounds.getTopLeft());
        const bottomRight = tiled.viewportToImageCoordinates(bounds.getBottomRight());
        const x = Math.max(0, Math.round(topLeft.x));
        const y = Math.max(0, Math.round(topLeft.y));
        const w = Math.max(1, Math.round(bottomRight.x - topLeft.x));
        const h = Math.max(1, Math.round(bottomRight.y - topLeft.y));
        realtime.sendViewport({ x, y, w, h });
      } catch (_) {}
    }, 500);
    return () => clearInterval(id);
  }, [transcriptActive]);

  // Auto view-action logging - monitors image path changes; logs mouse, viewport, eye, voice to behavior Firebase
  useAutoViewActLogging({ viewerRef });

  // Get current instance id
  const currentInstanceId = instanceId;

  const isThisInstanceActive = useSelector((state: RootState) =>
    instanceId ? Boolean(state.wsi.instances[instanceId]?.isActive) : true,
  );

  // Validate instance data completeness
  useEffect(() => {
    if (instanceId && (!currentWSIInfo || !currentWSIFileInfo)) {
      console.warn(`Instance ${instanceId} is missing WSI data:`, {
        hasWSIInfo: !!currentWSIInfo,
        hasFileInfo: !!currentWSIFileInfo,
      });
    }
  }, [instanceId, currentWSIInfo, currentWSIFileInfo]);

  // websocket
  const { socket, status } = useWs(`${AI_SERVICE_SOCKET_ENDPOINT}/segment/`);
  // centorids
  const [centroids, setCentroids] = useState<CentroidsArray>(EMPTY_CENTROIDS);
  const patches = useSelector(selectPatchOverlays);
  const patchClassificationData = useSelector(selectPatchClassificationData);

  const updateCentroids = useCallback((newCentroids: CentroidsArray) => {
    setCentroids(newCentroids);
  }, []);

  const updateRenderingAnnotations = (newAnnotations: any[]) => {
    setRenderingAnnotations(newAnnotations);
  };

  // mouse position feature state
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [imageBounds, setImageBounds] = useState({
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
  });
  const [imageRotation, setImageRotation] = useState(0);
  const [magnification, setMagnification] = useState(1);

  const [allTilesLoaded, setAllTilesLoaded] = useState(false);
  const [loadingAnnotations, setLoadingAnnotations] = useState(false);
  const [loadingMask, setLoadingMask] = useState(false);

  // new state for classification data
  const [classificationData, setClassificationData] = useState<{
    nuclei_class_id: number[];
    nuclei_class_name: string[];
    nuclei_class_HEX_color: string[];
  } | null>(null);

  // new state for using classification or not
  const classificationEnabled = useSelector(
    (state: RootState) => state.annotations.classificationEnabled,
  );

  const [renderingAnnotations, setRenderingAnnotations] = useState<any[]>([]);

  // State for ruler hover tooltip
  const [rulerTooltip, setRulerTooltip] = useState<{
    visible: boolean;
    text: string;
    position: { x: number; y: number };
  }>({
    visible: false,
    text: "",
    position: { x: 0, y: 0 },
  });

  const lastRequestTimeRef = useRef(0);

  // Retry mechanism to confirm Zarr presence before showing errors for Space/X
  const errorConfirmTimersRef = useRef<{
    space: ReturnType<typeof setTimeout> | null;
    x: ReturnType<typeof setTimeout> | null;
  }>({ space: null, x: null });
  const errorConfirmAttemptsRef = useRef<{ space: number; x: number }>({
    space: 0,
    x: 0,
  });
  const lastWorkflowRefreshTsRef = useRef<number>(0);
  const quickSpaceFallbackTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  // Avoid effect loops by using ref instead of state
  const lastHashRef = useRef<string | null>(null);
  const setHasNucleiDataRef = useRef<((value: boolean) => void) | null>(null);
  const setHasPatchDataRef = useRef<((value: boolean) => void) | null>(null);

  // Check current UI/data state to decide if we should suppress errors
  const hasRenderableSegmentationData = useCallback(() => {
    try {
      const backendAnns = annotatorInstance
        ? annotatorInstance
            .getAnnotations()
            .filter((a: any) => a && a.isBackend) || []
        : [];
      return !!(
        existAnnotationFile ||
        backendAnns.length > 0 ||
        (centroids && centroids.length > 0) ||
        (renderingAnnotations && renderingAnnotations.length > 0)
      );
    } catch (e) {
      return !!existAnnotationFile;
    }
  }, [annotatorInstance, existAnnotationFile, centroids, renderingAnnotations]);

  // Refresh patch classification data function
  const refreshPatchClassificationData = useCallback(async () => {
    const getDefaultPatchData = () => ({
      class_id: [0],
      class_name: ["Negative control"],
      class_hex_color: ["#aaaaaa"],
      class_counts: [0],
    });

    const isNonFatalPatchClassificationMessage = (value: unknown) => {
      if (typeof value !== "string") return false;
      const normalized = value.trim().toLowerCase();
      return normalized.includes("no handler found for device");
    };

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
      const response = await apiFetch(
        `${AI_SERVICE_API_ENDPOINT}/seg/v1/patch_classification`,
        {
          method: "GET",
          returnAxiosFormat: true,
        },
      );
      const rawBody = response.data;
      const wrappedErrorCode =
        typeof rawBody?.code === "number" ? rawBody.code : undefined;
      const wrappedErrorMessage =
        typeof rawBody?.message === "string" ? rawBody.message : undefined;

      if (
        wrappedErrorCode !== undefined &&
        wrappedErrorCode !== 0 &&
        isNonFatalPatchClassificationMessage(wrappedErrorMessage)
      ) {
        console.warn(
          "[Patch Classification] Backend handler is not ready yet; keeping existing patch overlay state.",
        );
        return;
      }

      const payload = rawBody?.data ?? rawBody;

      if (
        payload &&
        Array.isArray(payload.class_name) &&
        payload.class_name.length > 0
      ) {
        setHasPatchDataRef.current?.(true);
        const currentPatchData =
          store.getState().annotations.patchClassificationData;

        // Create server classes representation (similar to handleLoadClassification for nuclei, { method: 'GET', returnAxiosFormat: true })
        const serverClasses = payload.class_name.map(
          (name: string, index: number) => {
            const normalizedName =
              typeof name === "string" ? name : String(name ?? "");
            return {
              name: normalizedName,
              class_id: Array.isArray(payload.class_id)
                ? payload.class_id[index] ?? index
                : index,
              class_hex_color:
                Array.isArray(payload.class_hex_color) &&
                payload.class_hex_color[index]
                  ? payload.class_hex_color[index]
                  : "#aaaaaa",
              class_counts:
                coerceCountsArray(
                  payload.class_counts,
                  payload.class_name.length,
                )[index] ?? 0,
            };
          },
        );

        // Merge server classes with local classes (similar to handleLoadClassification logic)
        // Start with all server classes
        const finalClasses = [...serverClasses];

        // Then add local classes that are not in server
        if (currentPatchData && currentPatchData.class_name) {
          currentPatchData.class_name.forEach((localName, index) => {
            if (
              !finalClasses.some(
                (serverClass) => serverClass.name === localName,
              )
            ) {
              const numericIds = finalClasses
                .map((cls) =>
                  Number.isFinite(Number(cls.class_id))
                    ? Number(cls.class_id)
                    : null,
                )
                .filter((val) => val !== null) as number[];
              const nextId =
                numericIds.length > 0
                  ? Math.max(...numericIds) + 1
                  : finalClasses.length;

              finalClasses.push({
                name: localName,
                class_id: nextId,
                class_hex_color:
                  currentPatchData.class_hex_color?.[index] || "#aaaaaa",
                class_counts: currentPatchData.class_counts?.[index] ?? 0,
              });
            } else {
              // If local class exists in server, preserve local color if available
              const serverIndex = finalClasses.findIndex(
                (cls) => cls.name === localName,
              );
              if (
                serverIndex >= 0 &&
                currentPatchData.class_hex_color?.[index]
              ) {
                finalClasses[serverIndex].class_hex_color =
                  currentPatchData.class_hex_color[index];
              }
            }
          });
        }

        // Use counts from server (which includes updated patch_class_counts from Zarr)
        // Don't restore from local state - server has the authoritative counts
        // finalClasses already has the correct counts from serverClasses, so use it directly
        const finalClassesWithCounts = finalClasses;

        // Convert back to serverData format
        const serverData = {
          class_id: finalClassesWithCounts.map((cls) => cls.class_id),
          class_name: finalClassesWithCounts.map((cls) => cls.name),
          class_hex_color: finalClassesWithCounts.map(
            (cls) => cls.class_hex_color,
          ),
          class_counts: finalClassesWithCounts.map((cls) => cls.class_counts),
        };

        if (serverData.class_counts.length < serverData.class_name.length) {
          serverData.class_counts = [
            ...serverData.class_counts,
            ...new Array(
              serverData.class_name.length - serverData.class_counts.length,
            ).fill(0),
          ];
        }

        // Ensure 'Negative control' always uses #aaaaaa color
        const ncIndex = serverData.class_name.findIndex(
          (name: string) => name === "Negative control",
        );
        if (ncIndex >= 0 && ncIndex < serverData.class_hex_color.length) {
          serverData.class_hex_color[ncIndex] = "#aaaaaa";
        }

        dispatch(setPatchClassificationData(serverData));
      } else {
        setHasPatchDataRef.current?.(false);
        const fallback = store.getState().annotations.patchClassificationData;
        if (fallback && fallback.class_name.length > 0) {
          dispatch(setPatchClassificationData(fallback));
        } else {
          dispatch(setPatchClassificationData(getDefaultPatchData()));
        }
      }
    } catch (error) {
      if (
        isNonFatalPatchClassificationMessage(
          typeof (error as { message?: unknown })?.message === "string"
            ? (error as { message: string }).message
            : undefined,
        )
      ) {
        console.warn(
          "[Patch Classification] Backend handler is not ready yet; keeping existing patch overlay state.",
        );
        return;
      }

      console.error("Failed to refresh patch classification data:", error);
      setHasPatchDataRef.current?.(false);
      const fallback = store.getState().annotations.patchClassificationData;
      if (fallback && fallback.class_name.length > 0) {
        dispatch(setPatchClassificationData(fallback));
      } else {
        dispatch(setPatchClassificationData(getDefaultPatchData()));
      }
    }
  }, [dispatch]);

  // Use viewport data requests hook
  const {
    requestViewportDataForType,
    requestPatchesForViewport,
    keydownUpdate,
    keydownUpdatePatches,
    confirmZarrMissingThenNotify,
    hasNucleiData,
    hasPatchData,
    setHasNucleiData,
    setHasPatchData,
  } = useViewportDataRequests({
    viewerInstance,
    socket,
    annotatorInstance,
    currentPath,
    instanceId,
    threshold,
    centroidThreshold,
    classificationEnabled,
    showUserAnnotations,
    annotationFilter,
    setLoadingAnnotations,
    refreshPatchClassificationData,
    lastHashRef,
    lastRequestTimeRef,
    lastWorkflowRefreshTsRef,
    errorConfirmTimersRef,
    errorConfirmAttemptsRef,
    quickSpaceFallbackTimerRef,
    existAnnotationFile,
    isZarrInitializing,
    setCurrentRequestType,
    hasRenderableSegmentationData,
    centroids,
    renderingAnnotations,
  });

  // Update refs with setters from hook
  setHasNucleiDataRef.current = setHasNucleiData;
  setHasPatchDataRef.current = setHasPatchData;

  // Overlay visibility should depend on whether the viewer can make requests for the
  // current slide, not on whether classification metadata has already been fetched.
  const overlaySocketAvailable =
    !!socket &&
    status !== WebSocket.CLOSED &&
    status !== WebSocket.CLOSING;

  const nucleiModeAvailable = overlaySocketAvailable && !!currentPath;

  const patchModeAvailable = overlaySocketAvailable && !!currentPath;

  const maskModeAvailable = maskOptions.length > 0;

  useEffect(() => {
    if (!nucleiModeAvailable && showBackendAnnotations) {
      setShowBackendAnnotations(false);
      setLoadingAnnotations(false);
      setIsRequestPending(false);
      setCurrentRequestType(null);
    }
  }, [nucleiModeAvailable, showBackendAnnotations]);

  useEffect(() => {
    if (!patchModeAvailable && showPatches) {
      setShowPatches(false);
      setLoadingAnnotations(false);
      setIsRequestPending(false);
      setCurrentRequestType(null);
    }
  }, [patchModeAvailable, showPatches]);

  useEffect(() => {
    if (!maskModeAvailable && showMask) {
      handleSetShowMask(false);
    }
  }, [handleSetShowMask, maskModeAvailable, showMask]);

  const handleLoadClassification = useCallback(async () => {
    if (!currentPath) {
      console.log("No currentPath, cannot load classification");
      return;
    }

    const isNonFatalHandlerNotReadyMessage = (value: unknown) => {
      if (typeof value !== "string") return false;
      return value.trim().toLowerCase().includes("no handler found for device");
    };

    const managerUrl = `${AI_SERVICE_API_ENDPOINT}/seg/v1/classifications?file_path=${encodeURIComponent(currentPath)}`;

    try {
      const resp = await apiFetch(managerUrl, {
        method: "GET",
        returnAxiosFormat: true,
      });

      const responseData = resp.data;
      console.log("backend Classification data++++++:", responseData);

      const wrappedErrorCode =
        typeof responseData?.code === "number" ? responseData.code : undefined;
      const wrappedErrorMessage =
        typeof responseData?.message === "string" ? responseData.message : undefined;

      if (
        wrappedErrorCode !== undefined &&
        wrappedErrorCode !== 0 &&
        isNonFatalHandlerNotReadyMessage(wrappedErrorMessage)
      ) {
        console.warn(
          "[Classification] Backend handler is not ready yet; keeping existing overlay classification state.",
        );
        return;
      }

      if (
        responseData &&
        responseData.nuclei_class_name &&
        responseData.nuclei_class_HEX_color &&
        responseData.nuclei_class_id
      ) {
        setHasNucleiDataRef.current?.(true);
        const { nuclei_class_name, nuclei_class_HEX_color, nuclei_class_id } =
          responseData;

        // Get the current classes from Redux to preserve local additions and counts
        const currentNucleiClasses = store.getState().annotations.nucleiClasses;

        // Create a representation of the server data
        const serverClasses = nuclei_class_name.map(
          (rawName: string, index: number) => {
            const name =
              typeof rawName === "string" ? rawName : String(rawName ?? "");
            return {
              name,
              color: nuclei_class_HEX_color[index],
              count: 0,
              persisted: true,
            };
          },
        );

        // Merge server classes with local classes
        const finalClasses = [...serverClasses];
        currentNucleiClasses.forEach((localClass) => {
          if (
            !finalClasses.some(
              (finalClass) => finalClass.name === localClass.name,
            )
          ) {
            finalClasses.push(localClass);
          }
        });

        // Restore counts for all classes from the pre-update local state
        const finalClassesWithCounts = finalClasses.map((cls) => {
          const existingClass = currentNucleiClasses.find(
            (c) => c.name === cls.name,
          );
          return {
            ...cls,
            count: existingClass ? existingClass.count : 0,
            persisted: cls.persisted ?? existingClass?.persisted ?? true,
          };
        });

        dispatch(setNucleiClasses(finalClassesWithCounts));

        const newAnnotationTypeMapPayload = nuclei_class_id.map(
          (id_val: number, index: number) => {
            const classIndexForMap = nuclei_class_id[index];

            return {
              id: String(index),
              classIndex: classIndexForMap,
              color: nuclei_class_HEX_color[classIndexForMap],
              category: nuclei_class_name[classIndexForMap],
            };
          },
        );
        annotationTypeStore.getState().setMany(newAnnotationTypeMapPayload);
        setClassificationData(responseData);
        dispatch(setClassificationEnabled(true)); // Set to true since data is available
      } else {
        setHasNucleiDataRef.current?.(false);
        setClassificationData(null);
        dispatch(setClassificationEnabled(false)); // Disable classification if no Zarr data, but keep UI state
        // Also clear any stale per-cell overrides
        dispatch(clearAnnotationTypes());
      }
    } catch (err: any) {
      if (
        isNonFatalHandlerNotReadyMessage(
          typeof err?.message === "string" ? err.message : undefined,
        )
      ) {
        console.warn(
          "[Classification] Backend handler is not ready yet; keeping existing overlay classification state.",
        );
        return;
      }

      // Check if it's a 404 error
      if (err?.response?.status === 404) {
        setHasNucleiDataRef.current?.(false);
      }
      setClassificationData(null);
      dispatch(setClassificationEnabled(false));
      // Also clear any stale per-cell overrides on error
      dispatch(clearAnnotationTypes());
    }

    await refreshPatchClassificationData();
  }, [currentPath, dispatch, refreshPatchClassificationData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-check data availability when workflow completes
  const previousIsRunningRef = useRef(isRunning);
  useEffect(() => {
    const wasRunning = previousIsRunningRef.current;
    previousIsRunningRef.current = isRunning;

    // Only re-check on an actual running -> idle transition, not on first mount
    if (wasRunning && !isRunning && currentPath) {
      // Small delay to ensure backend has finished processing
      const timer = setTimeout(() => {
        console.log("[Workflow Complete] Re-checking data availability...");
        handleLoadClassification();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isRunning, currentPath, handleLoadClassification]);

  // Fetch user-annotation (GT) indices when image is open and "highlight GT" preference is on
  const highlightGtAnnotations = useSelector(
    (state: RootState) => state.viewerSettings.highlightGtAnnotations,
  );
  const refreshGtHighlightIndices = useRefreshGtHighlightIndices();
  useEffect(() => {
    if (!highlightGtAnnotations) {
      dispatch(clearGtHighlightIndices());
      return;
    }
    if (!currentPath) return;
    const url = `${AI_SERVICE_API_ENDPOINT}/seg/v1/user_annotation_indices?file_path=${encodeURIComponent(currentPath)}`;
    apiFetch(url, { method: "GET", returnAxiosFormat: true })
      .then((resp: any) => {
        const data = resp?.data?.data ?? resp?.data ?? {};
        const nucleiIndices = Array.isArray(data.nuclei_indices) ? data.nuclei_indices : [];
        const tissueIndices = Array.isArray(data.tissue_indices) ? data.tissue_indices : [];
        dispatch(setGtHighlightIndices({ nucleiIndices, tissueIndices }));
      })
      .catch(() => {
        dispatch(setGtHighlightIndices({ nucleiIndices: [], tissueIndices: [] }));
      });
  }, [currentPath, highlightGtAnnotations, dispatch]);

  // pass the new state to the hook
  const { resetQueryFlag } = useOpenSeadragonViewerEvents(
    viewerInstance,
    annotatorInstance,
    socket,
    status,
    instanceId,
    updateCentroids,
    showBackendAnnotations,
    showUserAnnotations,
    showPatches,
    setLoadingAnnotations,
    renderingAnnotations,
    updateRenderingAnnotations,
  );

  // --- Unified Count Update Logic ---
  const updateCountsFromBackend = useCallback(
    (counts: Record<string, number>) => {
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
      if (
        JSON.stringify(currentNucleiClasses.map((c) => c.count)) !==
        JSON.stringify(updatedNucleiClasses.map((c) => c.count))
      ) {
        dispatch(setNucleiClasses(updatedNucleiClasses));
        console.log(
          `[WS COUNTS] Updated nuclei class counts from backend.`,
          counts,
        );
      }
    },
    [dispatch],
  );

  // --- End of Unified Logic ---

  const handleFullyLoadedChange = useCallback((event: any) => {
    const isFullyLoaded = event.fullyLoaded;
    console.log("Tile loaded event triggered:", { isFullyLoaded, event });
    setAllTilesLoaded(isFullyLoaded);
    if (isFullyLoaded) {
      console.log("All tiles fully loaded!");
    }
  }, []);

  const handleAddItem = useCallback(
    (event: any) => {
      const tiledImage = event.item;
      // bind fully-loaded-change event
      tiledImage.addHandler("fully-loaded-change", handleFullyLoadedChange);
      setAllTilesLoaded(false);
    },
    [handleFullyLoadedChange],
  );

  const handleRemoveItem = useCallback(
    (event: any) => {
      const tiledImage = event.item;
      // remove event listener
      tiledImage.removeHandler("fully-loaded-change", handleFullyLoadedChange);
    },
    [handleFullyLoadedChange],
  );

  useEffect(() => {
    if (viewerInstance) {
      const viewer = viewerInstance;
      console.log("Binding tile loaded events to viewer:", {
        viewerExists: !!viewer,
        worldExists: !!viewer.world,
        itemCount: viewer.world.getItemCount(),
      });

      // listen to add and remove item events in world
      viewer.world.addHandler("add-item", handleAddItem);
      viewer.world.addHandler("remove-item", handleRemoveItem);

      // add event listener to existing tiledImage
      for (let i = 0; i < viewer.world.getItemCount(); i++) {
        const tiledImage = viewer.world.getItemAt(i);
        console.log(`Binding fully-loaded-change event to tiledImage ${i}`);
        tiledImage.addHandler("fully-loaded-change", handleFullyLoadedChange);
      }

      return () => {
        try {
          if (viewer && viewer.world) {
            // clean up world event listener
            viewer.world.removeHandler("add-item", handleAddItem);
            viewer.world.removeHandler("remove-item", handleRemoveItem);
            // clean up all tiledImage event listener
            for (let i = 0; i < viewer.world.getItemCount(); i++) {
              const tiledImage = viewer.world.getItemAt(i);
              tiledImage.removeHandler(
                "fully-loaded-change",
                handleFullyLoadedChange,
              );
            }
          }
        } catch (error) {
          console.warn("Error cleaning up viewer handlers:", error);
        }
      };
    }
  }, [
    viewerInstance,
    handleAddItem,
    handleRemoveItem,
    handleFullyLoadedChange,
  ]);

  useEffect(() => {
    console.log("[container] instances changed:", annotatorInstance);
    if (annotatorInstance) {
      console.log("[container] annotatorInstance:", annotatorInstance);
      console.log(
        "[container] annotatorInstance.viewer:",
        annotatorInstance?.viewer,
      );
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
      annotatorInstance.setStyle(
        (annotation: ImageAnnotation, state: AnnotationState) => {
          // does this annotation have a style body in redux?
          const annotationType = annotationTypes.get(String(annotation.id));

          // Helper utilities for ROI-aware highlight
          const rectContainsPoint = (x: number, y: number) => {
            const rect = shapeData?.rectangleCoords;
            if (!rect) return false;
            const minX = Math.min(rect.x1, rect.x2);
            const maxX = Math.max(rect.x1, rect.x2);
            const minY = Math.min(rect.y1, rect.y2);
            const maxY = Math.max(rect.y1, rect.y2);
            return x >= minX && x <= maxX && y >= minY && y <= maxY;
          };

          const polyContainsPoint = (x: number, y: number) => {
            const poly = shapeData?.polygonPoints;
            if (!poly || poly.length < 3) return false;
            const pts = poly.map(
              (p) => [p[0], p[1]] as [number, number],
            );
            let inside = false;
            for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
              const xi = pts[i][0],
                yi = pts[i][1];
              const xj = pts[j][0],
                yj = pts[j][1];
              const intersect =
                yi > y !== yj > y &&
                x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi;
              if (intersect) inside = !inside;
            }
            return inside;
          };

          // ROI contains point: prioritize polygon over rectangle
          const roiContainsPoint = (x: number, y: number) => {
            if (!shapeData) return false;
            // If polygon ROI exists, use polygon containment check
            if (
              shapeData.polygonPoints &&
              shapeData.polygonPoints.length >= 3
            ) {
              return polyContainsPoint(x, y);
            }
            // Otherwise fall back to rectangle ROI
            if (shapeData.rectangleCoords) {
              return rectContainsPoint(x, y);
            }
            return false;
          };

          const selector: any = annotation?.target?.selector;
          const isBackendAnno = (annotation as any)?.isBackend === true;

          // Compute ROI highlight only for backend cell polygons
          let isRoiHighlighted = false;
          if (
            isBackendAnno &&
            selector?.type === "POLYGON" &&
            selector?.geometry?.points &&
            shapeData &&
            shapeData.rectangleCoords
          ) {
            const points = selector.geometry.points as [number, number][];
            if (points && points.length > 0) {
              // Only polygon centroid inside rectangle ROI counts
              let cx = 0,
                cy = 0;
              for (const [px, py] of points) {
                cx += px;
                cy += py;
              }
              cx /= points.length;
              cy /= points.length;
              isRoiHighlighted = roiContainsPoint(cx, cy);
            }
          }

          if (annotationType) {
            //if this annotation has a style body in redux, use that color
            const existingClassification = annotation.bodies.find(
              (b) => b.purpose === "classification",
            );

            // if the classification body doesn't exist or the value is different, update the annotation
            // BUT only if we're not already updating this annotation (prevent infinite loop)
            if (
              (!existingClassification ||
                existingClassification.value !== annotationType.category) &&
              !updatingAnnotationsRef.current.has(annotation.id)
            ) {
              // Mark this annotation as being updated
              updatingAnnotationsRef.current.add(annotation.id);

              const updatedBodies = [
                ...annotation.bodies.filter(
                  (b) => b.purpose !== "classification",
                ),
                {
                  id: String(Date.now()),
                  annotation: annotation.id,
                  type: "TextualBody",
                  purpose: "classification",
                  value: annotationType.category,
                  created: new Date().toISOString(),
                  creator: {
                    id: "default",
                    type: "Person",
                  },
                },
              ];

              const updatedAnnotation = {
                ...annotation,
                bodies: updatedBodies,
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
              strokeWidth: state?.selected || state?.hovered ? 2 : 1,
            } as any;

            // ROI-aware yellow contour override
            if (isRoiHighlighted) {
              baseStyle.stroke = "#ffff00";
              baseStyle.strokeWidth = Math.max(baseStyle.strokeWidth || 1, 2);
            }

            // Filter tool selection: always no fill (selection and after), so it doesn't block the view
            const isFilterSelection =
              currentTool === "filter" &&
              !isBackendAnno &&
              (selector?.type === "RECTANGLE" || selector?.type === "POLYGON");
            if (isFilterSelection) {
              baseStyle.fillOpacity = 0;
            }

            return baseStyle;
          }

          // find the color of the annotation
          const styleBody = annotation.bodies.find(
            (b) => b.purpose === "style",
          );
          // get the color from the annotation
          const color = styleBody?.value || "#00ff00";

          // ensure state is not undefined
          const isSelected = state?.selected || false;
          const isHovered = state?.hovered || false;

          // base style
          const style = {
            fill: color,
            fillOpacity: isSelected || isHovered ? 0.6 : 0.4,
            stroke: color,
            strokeOpacity: 1,
            strokeWidth: isSelected || isHovered ? 2 : 1,
          };

          // ROI-aware yellow contour override
          if (isRoiHighlighted) {
            (style as any).stroke = "#ffff00";
            (style as any).strokeWidth = Math.max(
              (style as any).strokeWidth || 1,
              2,
            );
          }

          // Filter tool selection: always no fill (selection and after), so it doesn't block the view
          const isFilterSelection =
            currentTool === "filter" &&
            !isBackendAnno &&
            (selector?.type === "RECTANGLE" || selector?.type === "POLYGON");
          if (isFilterSelection) {
            (style as any).fillOpacity = 0;
          }

          return style;
        },
      );
    }
  }, [annotatorInstance, annotationTypes, annotationTypesVersion, shapeData, currentTool]);

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
          if (
            Date.now() - lastResetTimestampRef.current <
            HIGHLIGHT_RESET_GUARD_MS
          )
            return;
          if (!hasActiveSelection()) return;
          func();
        }, SHAPE_UPDATE_DEBOUNCE_MS);
      };

      const dispatchShapeCoords = (
        annotation: ImageAnnotation,
      ): RectangleCoords | null => {
        // Guard: avoid dispatch shortly after a reset or when selection is empty
        if (
          Date.now() - lastResetTimestampRef.current <
          HIGHLIGHT_RESET_GUARD_MS
        )
          return null;
        if (!hasActiveSelection()) return null;
        const selector = annotation.target?.selector;

        // Ruler annotations (LINE type) should not trigger cell highlighting
        if (selector?.type === "LINE") {
          return null;
        }

        if (selector?.type === "RECTANGLE") {
          const geometry = selector.geometry;
          if (geometry?.bounds) {
            const {
              minX: rawMinX,
              minY: rawMinY,
              maxX: rawMaxX,
              maxY: rawMaxY,
            } = geometry.bounds;
            const coords = {
              x1: rawMinX,
              y1: rawMinY,
              x2: rawMaxX,
              y2: rawMaxY,
            };
            // Debounce shape data dispatching to prevent churn
            scheduleShapeUpdate(() => {
              dispatch(setShapeData({ rectangleCoords: coords }));
            });
            return coords;
          }
        } else if (selector?.type === "POLYGON") {
          const geometry = selector.geometry;
          if (
            geometry &&
            (geometry as any).points &&
            (geometry as any).points.length > 0
          ) {
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
                x1: minX,
                y1: minY,
                x2: maxX,
                y2: maxY,
              };
              const polygonPoints = rawPoints.map((p) => [
                p[0],
                p[1],
              ]) as [number, number][];
              // Debounce shape data dispatching to prevent churn
              scheduleShapeUpdate(() => {
                dispatch(
                  setShapeData({
                    rectangleCoords: coords,
                    polygonPoints: polygonPoints,
                  }),
                );
              });
              return coords;
            }
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
            type: "Annotation",
            created: creationDate,
            creator: {
              id: "default",
              type: "AI",
            },
            bodies: [
              {
                id: String(Date.now()),
                annotation: annotation.id,
                type: "TextualBody",
                purpose: "style",
                value: "#00ff00",
                created: creationDate,
                creator: {
                  id: "default",
                  type: "AI",
                },
              },
            ],
          };
          try {
            await annotatorInstance.updateAnnotation(updatedAnnotation);
            await annotatorInstance.setSelected(updatedAnnotation.id);
            const finalAnnotation = {
              ...updatedAnnotation,
              isBackend: false,
            };
            await annotatorInstance.updateAnnotation(finalAnnotation);
            // Do not dispatch here; selection handler will update highlight
          } catch (error) {
            console.error("Error updating annotation:", error);
          }
        } else {
          // Only update highlight if this annotation is currently selected
          const selected = annotatorInstance.getSelected?.() || [];
          const isSelected =
            selected.some((a: any) => a?.id === annotation.id) ||
            selectedIdsRef.current.has(annotation.id);
          if (isSelected) {
            dispatchShapeCoords(annotation);
          }
        }
      };

      annotatorInstance.on("createAnnotation", onFinalAnnotation);
      annotatorInstance.on("updateAnnotation", onFinalAnnotation);

      // Add real-time selection tracking for immediate highlight updates
      const onSelectAnnotation = (annotation: ImageAnnotation) => {
        const coords = dispatchShapeCoords(annotation);
        if (coords) EventBus.emit("shape-resizing", coords);
      };

      annotatorInstance.on("selectAnnotation", onSelectAnnotation);

      // Track selection changes and clear highlight if none
      annotatorInstance.on("selectionChanged", (selected: any[]) => {
        selectedIdsRef.current = new Set((selected || []).map((a) => a.id));
        if (!selected || selected.length === 0) {
          lastResetTimestampRef.current = Date.now();
          dispatch(resetShapeData());
          return;
        }

        // Ruler annotations (LINE type) should not trigger cell highlighting
        const annotation = selected[selected.length - 1];
        const selector = Array.isArray(annotation?.target?.selector)
          ? annotation.target.selector[0]
          : annotation?.target?.selector;
        if (selector?.type === "LINE") {
          lastResetTimestampRef.current = Date.now();
          dispatch(resetShapeData());
        }
      });

      // --- Live-resizing (polygon) with Pointer Events ---
      // Use pointer events so it works with mouse, pen, and touch.
      // Read live geometry from the DOM (<polygon points="…">) because the
      // annotation model is only committed at the end of editing.

      const parsePointsAttr = (attr: string): [number, number][] =>
        attr
          .trim()
          .split(/\s+/)
          .map((pair) => {
            const [x, y] = pair.split(",").map(parseFloat);
            return [x, y] as [number, number];
          });

      const emitLivePolygonFromDOM = (group: SVGGElement) => {
        // Guard: if selection was just cleared, ignore transient DOM updates
        if (
          Date.now() - lastResetTimestampRef.current <
          HIGHLIGHT_RESET_GUARD_MS
        )
          return;
        if (!hasActiveSelection()) return;
        const poly = group.querySelector("polygon") as SVGPolygonElement | null;
        if (!poly) return;

        const attr = poly.getAttribute("points") || "";
        const raw = parsePointsAttr(attr);
        if (raw.length === 0) return;

        // Compute bounds in OSD image coords
        let minX = raw[0][0],
          minY = raw[0][1],
          maxX = raw[0][0],
          maxY = raw[0][1];
        for (let i = 1; i < raw.length; i++) {
          const [px, py] = raw[i];
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
        }

        const coords = {
          x1: minX,
          y1: minY,
          x2: maxX,
          y2: maxY,
        };

        const polygonPoints = raw.map(([px, py]) => [
          px,
          py,
        ]) as [number, number][];

        // Keep Redux shape state in sync for listeners that rely on it
        dispatch(setShapeData({ rectangleCoords: coords, polygonPoints }));

        // Notify any external listeners
        EventBus.emit("shape-resizing", {
          rectangleCoords: coords,
          polygonPoints,
        });
      };

      const onPointerDown = (evt: PointerEvent) => {
        // Check for handle drag or annotation move
        const handle = (evt.target as HTMLElement)?.closest(
          ".a9s-handle, .a9s-edge-handle",
        ) as HTMLElement | null;
        const annotation = (evt.target as HTMLElement)?.closest(
          "g.a9s-annotation.selected",
        ) as SVGGElement | null;
        const polygon = (evt.target as HTMLElement)?.closest(
          "polygon",
        ) as SVGPolygonElement | null;

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
          group = handle.closest(
            "g.a9s-annotation.selected",
          ) as SVGGElement | null;
          targetElement = handle;
        } else if (polygon) {
          group = polygon.closest(
            "g.a9s-annotation.selected",
          ) as SVGGElement | null;
          targetElement = polygon;
        } else if (annotation) {
          group = annotation;
          targetElement = annotation;
        }

        if (!group) return;

        // Capture the pointer so we keep receiving move/up events even if it leaves the SVG
        if (targetElement) {
          try {
            (targetElement as any).setPointerCapture?.(evt.pointerId);
          } catch {
            /* no-op */
          }
        }

        const onPointerMove = (_e: PointerEvent) => {
          if (group && group.querySelector("polygon")) {
            // Live updates for polygons
            emitLivePolygonFromDOM(group);
            return;
          }
          // Fallback: read from selected (works for rect/line, or after idle if autoSave=true)
          const selected = annotatorInstance.getSelected?.();
          if (selected && selected.length > 0) {
            const coords = dispatchShapeCoords(selected[0]);
            if (coords) EventBus.emit("shape-resizing", coords);
          }
        };

        const onPointerUp = (_e: PointerEvent) => {
          window.removeEventListener(
            "pointermove",
            onPointerMove as EventListener,
          );
          window.removeEventListener("pointerup", onPointerUp as EventListener);
          if (targetElement) {
            try {
              (targetElement as any).releasePointerCapture?.(evt.pointerId);
            } catch {
              /* no-op */
            }
          }
        };

        window.addEventListener("pointermove", onPointerMove as EventListener);
        window.addEventListener("pointerup", onPointerUp as EventListener);
      };

      // Add additional event listeners for polygon movement
      const onMouseMove = (evt: MouseEvent) => {
        // Check if we're currently dragging a polygon
        const selectedAnnotation = document.querySelector(
          "g.a9s-annotation.selected",
        ) as SVGGElement | null;
        if (selectedAnnotation && selectedAnnotation.querySelector("polygon")) {
          // Check if the mouse is over the polygon or its handles
          const target = evt.target as Element;
          if (
            target &&
            (target.closest("polygon") ||
              target.closest(".a9s-handle, .a9s-edge-handle"))
          ) {
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
          if (
            mutation.type === "attributes" &&
            mutation.attributeName === "points"
          ) {
            const target = mutation.target as SVGPolygonElement;
            const group = target.closest(
              "g.a9s-annotation.selected",
            ) as SVGGElement | null;
            if (group) {
              emitLivePolygonFromDOM(group);
            }
          }
        });
      });

      // Start observing polygon elements
      const startObservingPolygons = () => {
        const polygons = document.querySelectorAll("polygon");
        polygons.forEach((polygon) => {
          observer.observe(polygon, {
            attributes: true,
            attributeFilter: ["points"],
          });
        });
      };

      // Initial observation
      startObservingPolygons();

      // Set up a periodic check for new polygons
      const polygonCheckInterval = setInterval(() => {
        const polygons = document.querySelectorAll("polygon");
        polygons.forEach((polygon) => {
          if (!polygon.hasAttribute("data-observed")) {
            polygon.setAttribute("data-observed", "true");
            observer.observe(polygon, {
              attributes: true,
              attributeFilter: ["points"],
            });
          }
        });
      }, 1000);

      // Attach on the annotation SVG layer
      const annotationLayerEl = viewer.element?.querySelector(
        ".a9s-annotationlayer",
      );
      if (annotationLayerEl) {
        annotationLayerEl.addEventListener(
          "pointerdown",
          onPointerDown as EventListener,
        );
        annotationLayerEl.addEventListener(
          "mousemove",
          onMouseMove as EventListener,
        );
      }

      return () => {
        annotatorInstance.off("createAnnotation", onFinalAnnotation);
        annotatorInstance.off("updateAnnotation", onFinalAnnotation);
        annotatorInstance.off("selectAnnotation", onSelectAnnotation);
        // Re-query the annotation layer element for cleanup since it might have changed
        const cleanupAnnotationLayerEl = viewer.element?.querySelector(
          ".a9s-annotationlayer",
        );
        if (cleanupAnnotationLayerEl) {
          cleanupAnnotationLayerEl.removeEventListener(
            "pointerdown",
            onPointerDown as EventListener,
          );
          cleanupAnnotationLayerEl.removeEventListener(
            "mousemove",
            onMouseMove as EventListener,
          );
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
      const sig = visibleChannels
        .map((idx) => `${idx}:${channels[idx]?.color || ""}`)
        .join("|");
      console.log("[Channel Signature] Generated signature:", sig);
      return sig;
    } catch (error) {
      console.warn("[Channel Signature] Error generating signature:", error);
      return "";
    }
  }, [visibleChannels, channels]);

  // Track current z-layer for tile URL generation
  const [currentZLayer, setCurrentZLayer] = useState<number>(0);

  // Listen for z-layer changes
  useEffect(() => {
    const handleZLayerChange = (event: CustomEvent) => {
      const { layer } = event.detail;
      setCurrentZLayer(layer);
    };

    window.addEventListener(
      "zLayerChanged",
      handleZLayerChange as EventListener,
    );
    return () => {
      window.removeEventListener(
        "zLayerChanged",
        handleZLayerChange as EventListener,
      );
    };
  }, []);

  // Use helper function to create tile URL generator
  const getTileUrl = useMemo(
    () =>
      createTileUrlGenerator(
        visibleChannels,
        channels,
        currentInstanceId,
        channelSignature,
        currentZLayer,
      ),
    [
      visibleChannels,
      channels,
      currentInstanceId,
      channelSignature,
      currentZLayer,
    ],
  );

  // Listen for Z-Stack layer changes and refresh viewer
  useEffect(() => {
    const handleZLayerChange = (event: CustomEvent) => {
      const { layer } = event.detail;

      if (viewerInstance && tileSource && currentWSIInfo) {
        try {
          // Get current dimensions
          let level_0_width = 50000;
          let level_0_height = 50000;
          if (Array.isArray(currentWSIInfo.dimensions)) {
            if (
              currentWSIInfo.dimensions.length > 0 &&
              Array.isArray(currentWSIInfo.dimensions[0])
            ) {
              [level_0_width, level_0_height] = currentWSIInfo.dimensions[0];
            }
          } else {
            [level_0_width, level_0_height] = currentWSIInfo.dimensions;
          }

          // Use helper functions to create tile URL generator and tile source
          const getTileUrlForLayer = createTileUrlGeneratorForLayer(
            visibleChannels,
            channels,
            currentInstanceId,
            channelSignature,
            layer,
          );

          const newTileSource = createTileSource(
            { width: level_0_width, height: level_0_height },
            getTileUrlForLayer,
            currentInstanceId,
            currentWSIFileInfo,
            { zLayer: layer },
          );

          // Save current viewport state
          const currentBounds = viewerInstance.viewport.getBounds();
          const currentZoom = viewerInstance.viewport.getZoom();
          const currentRotation = viewerInstance.viewport.getRotation();

          const world = viewerInstance.world;
          const oldItem = world.getItemCount() > 0 ? world.getItemAt(0) : null;

          // Strategy: Preload new tiles first, then seamlessly switch
          // 1. Add new TiledImage with opacity=0 (invisible)
          // 2. Wait for visible viewport tiles to load
          // 3. Fade in new image and remove old one

          viewerInstance.addTiledImage({
            tileSource: newTileSource,
            index: 1, // Add on top of old image
            opacity: 0, // Start invisible
            success: (event: any) => {
              const newItem = event.item;

              // Restore viewport to trigger tile loading
              viewerInstance.viewport.fitBounds(currentBounds, true);
              viewerInstance.viewport.zoomTo(currentZoom, undefined, true);
              if (currentRotation !== 0) {
                viewerInstance.viewport.setRotation(currentRotation);
              }

              // Wait for tiles to load, then switch
              let switchTimeout: NodeJS.Timeout;
              let tilesLoadedCount = 0;

              const performSwitch = () => {
                // Fade in new image
                newItem.setOpacity(1);

                // Remove old image after a brief delay
                setTimeout(() => {
                  if (oldItem) {
                    world.removeItem(oldItem);
                  }
                }, 100);

                // Clear timeout
                if (switchTimeout) {
                  clearTimeout(switchTimeout);
                }

                // Remove event listener
                newItem.removeHandler("tile-loaded", handleTileLoaded);
              };

              const handleTileLoaded = () => {
                tilesLoadedCount++;

                // Switch after first few tiles are loaded
                if (tilesLoadedCount >= 3) {
                  performSwitch();
                }
              };

              // Listen for tile loading
              newItem.addHandler("tile-loaded", handleTileLoaded);

              // Fallback: switch after 200ms even if tiles still loading
              switchTimeout = setTimeout(() => {
                performSwitch();
              }, 200);

              // If tiles already loaded, switch immediately
              setTimeout(() => {
                if (newItem._tilesLoading === 0) {
                  performSwitch();
                }
              }, 50);
            },
          });
        } catch (error) {
          console.error(
            "[OpenSeadragon] Error reloading tiles for z-layer change:",
            error,
          );
        }
      }
    };

    window.addEventListener(
      "zLayerChanged",
      handleZLayerChange as EventListener,
    );

    return () => {
      window.removeEventListener(
        "zLayerChanged",
        handleZLayerChange as EventListener,
      );
    };
  }, [
    viewerInstance,
    tileSource,
    getTileUrl,
    currentWSIInfo,
    currentWSIFileInfo,
    currentInstanceId,
    channelSignature,
    channels,
    visibleChannels,
  ]);

  const initViewer = useCallback(async () => {
    if (!currentInstanceId) {
      console.warn("Cannot initialize viewer: instanceId is not available");
      return;
    }

    console.log("Initializing viewer with instanceId:", currentInstanceId);

    let level_0_width = 50000;
    let level_0_height = 50000;
    let levelCount = 0;
    try {
      const loadData = currentWSIInfo;
      console.log("Received WSI info:", loadData);
      if (loadData && loadData.dimensions) {
        // Handle both array format (legacy) and tuple format (new)
        if (Array.isArray(loadData.dimensions)) {
          // Legacy format: dimensions is an array of arrays
          if (
            loadData.dimensions.length > 0 &&
            Array.isArray(loadData.dimensions[0])
          ) {
            [level_0_width, level_0_height] = loadData.dimensions[0];
            levelCount = loadData.dimensions.length;
          }
        } else {
          // New format: dimensions is a tuple (width, height)
          [level_0_width, level_0_height] = loadData.dimensions;
          levelCount = loadData.level_count || 1;
        }
        console.log("Parsed dimensions:", {
          level_0_width,
          level_0_height,
          levelCount,
        });
      } else {
        console.warn("Invalid or missing dimensions in loadData.");
      }
    } catch (error) {
      console.error("Error initializing viewer:", error);
    }

    // Use helper function to create tile source
    const newTileSource = createTileSource(
      { width: level_0_width, height: level_0_height },
      getTileUrl,
      currentInstanceId,
      currentWSIFileInfo,
      { channelSignature },
    );

    // Add levelCount property (not in helper function)
    newTileSource._levelCount = levelCount;

    setTileSource(newTileSource);
  }, [
    getTileUrl,
    currentWSIInfo,
    currentWSIFileInfo,
    currentInstanceId,
    channelSignature,
  ]);

  useEffect(() => {
    if (currentInstanceId) {
      console.log("InstanceId available, initializing viewer...");
      initViewer();
    } else {
      console.log(
        "InstanceId not available yet, skipping viewer initialization",
      );
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
    setImageRotation,
    setMagnification,
  });

  useEffect(() => {
    if (tileSource) {
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
        imageLoaderLimit: 6, // Limit concurrent requests to allow effective cancellation
        ajaxHeaders: undefined,
        tileSources: {
          ...tileSource,
          getTileUrl: getTileUrl,
        },
        gestureSettingsMouse: {
          flickEnabled: false, // Disable default flick gesture
          clickToZoom: false,
          dblClickToZoom: false,
          dragToPan: true, // Keep mouse drag panning
          scrollToZoom: false,
          // macOS map style gesture settings
          dragToPanThreshold: 3, // Drag threshold to prevent accidental panning
          dragToPanMomentum: 0.25, // Drag momentum to make panning smoother
        },
        rotationIncrement: 30,
        gestureSettingsTouch: {
          pinchRotate: true,
        },
        animationTime: 0.3, // Increase animation time to make gestures smoother
        springStiffness: 6.5, // Decrease spring stiffness to make gestures more natural
        timeout: 1000000,
        // macOS map style gesture settings
        immediateRender: false, // Delay rendering, improve performance
        blendTime: 0.1, // Blend time, make transition smoother
        alwaysBlend: false, // Do not always blend, improve performance
        // Zoom level constraints
        minZoomLevel: 0.1,
        maxZoomLevel: 2000,
        // Add instance specific configuration
        _instanceId: currentInstanceId,
        _tileSourceKey: tileSource._key,
        _dimensions: tileSource._dimensions,
      };

      setOptions(instanceOptions);
    }
  }, [tileSource, visibleChannels, getTileUrl, currentInstanceId]);

  // tool
  const handleToolbarClick = useCallback((tool: string | undefined) => {
    if (tool === undefined) {
      dispatch(setTool('move'));
    } else if (tool === 'move' || tool === 'polygon' || tool === 'rectangle' || tool === 'line' || tool === 'filter') {
      dispatch(setTool(tool));
    } //else if (tool === 'Undo' && annotatorInstance) {
      //annotatorInstance.undo();
      //} else if (tool === 'Filter') {
      //dispatch(setShowThreshold(!showThreshold));
      //}
      // Handle other non-drawing tools here, e.g., ruler
    },
    [dispatch],
  );

  // Go to recommended viewport (toolbar dropdown): ROIs → Nuclei/Tissue → class; API supports nuclei only
  const [loadingRecommendViewport, setLoadingRecommendViewport] = useState(false);
  const handleGoToRecommended = useCallback(
    async (roiType: "nuclei" | "tissue", targetClass: number) => {
      if (roiType === "tissue") {
        toast.info("Tissue ROI recommendation is not supported yet.");
        return;
      }
      if (!currentPath || !viewerInstance?.viewport) {
        toast.error("No slide or viewer. Cannot go to recommended region.");
        return;
      }
      const formattedPath = formatPath(currentPath);
      setLoadingRecommendViewport(true);
      try {
        const resp = await apiFetch(
          `${AI_SERVICE_API_ENDPOINT}/tasks/v1/recommend_viewport?file_path=${encodeURIComponent(formattedPath)}&target_class=${targetClass}&selection_mode=high_confidence`,
          { method: "GET", returnAxiosFormat: true },
        );
        const data = resp?.data?.data ?? resp?.data;
        const bbox = data?.bbox;
        if (
          !bbox ||
          typeof bbox.x !== "number" ||
          typeof bbox.y !== "number" ||
          typeof bbox.width !== "number" ||
          typeof bbox.height !== "number"
        ) {
          toast.error(data?.message ?? "No viewport recommended");
          return;
        }
        const tiledImage = getLargestTiledImage(viewerInstance);
        if (!tiledImage) {
          toast.error("Could not get image size");
          return;
        }
        const contentSize = tiledImage.getContentSize();
        if (!contentSize || contentSize.x <= 0 || contentSize.y <= 0) {
          toast.error("Invalid image size");
          return;
        }
        const vx = bbox.x / contentSize.x;
        const vy = bbox.y / contentSize.y;
        const vw = bbox.width / contentSize.x;
        const vh = bbox.height / contentSize.y;
        const rect = new OpenSeadragon.Rect(vx, vy, vw, vh);
        viewerInstance.viewport.fitBounds(rect, false);
        viewerInstance.viewport.applyConstraints();
        toast.success("Moved to recommended region");
      } catch (e) {
        toast.error(getErrorMessage(e, "Failed to get recommended viewport"));
      } finally {
        setLoadingRecommendViewport(false);
      }
    },
    [currentPath, viewerInstance],
  );

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
    toast("Please open images from Dashboard");
  };

  //if progress changes, open new tileSource
  useEffect(() => {
    if (viewerInstance && reloading > 0 && tileSource && currentInstanceId) {
      console.log("Opening tileSource with instanceId:", currentInstanceId);
      viewerInstance.open(tileSource);
    }
  }, [reloading, tileSource, viewerInstance, currentInstanceId]);

  // websocket

  const annotationsCounter = useRef({
    received: 0,
    total: 0,
    lastTimestamp: Date.now(),
  });

  // hashing
  const hasherRef = useRef<any>(null);
  useEffect(() => {
    const initHasher = async () => {
      if (!hasherRef.current) {
        hasherRef.current = await xxhash();
        console.log("XXHash initialized");
      }
    };

    initHasher();
  }, []); // Init hasher once on load

  // Track the last sent path to avoid duplicate set_path requests
  const lastSentPathRef = useRef<string | null>(null);
  const setPathRetryCountRef = useRef(0);

  const resendSetPath = useCallback(() => {
    if (!currentPath || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    console.log("[WebSocket] Resending set_path:", currentPath);
    socket.send(
      JSON.stringify({
        type: "set_path",
        path: currentPath,
        instance_id: instanceId,
      }),
    );
  }, [currentPath, socket, instanceId]);

  // Use WebSocket message handler hook
  useWebSocketMessageHandler({
    socket,
    annotatorInstance,
    viewerInstance,
    currentPath,
    showBackendAnnotations,
    showPatches,
    classificationEnabled,
    threshold,
    centroidThreshold,
    updateCentroids,
    setCentroids,
    setRenderingAnnotations,
    setLoadingAnnotations,
    setExistAnnotationFile,
    setIsRequestPending,
    setCurrentRequestType,
    setIsZarrInitializing,
    updateCountsFromBackend,
    refreshPatchClassificationData,
    handleLoadClassification,
    resetQueryFlag,
    hasherRef,
    lastHashRef,
    zarrInitTimeoutRef,
    quickSpaceFallbackTimerRef,
    errorConfirmTimersRef,
    errorConfirmAttemptsRef,
    annotationsCounter,
    existAnnotationFile,
    isZarrInitializing,
    currentRequestType,
    lastSentPathRef,
  });

  useEffect(() => {
    if (currentPath && socket && status === WebSocket.OPEN) {
      // Only send set_path if the path has actually changed
      if (lastSentPathRef.current !== currentPath) {
        console.log("Sending file path to WebSocket:", currentPath);
        // Clear hash when WebSocket connection is established and file path is set
        lastHashRef.current = null;
        console.log("[WebSocket] Cleared hash when establishing connection");
        if (showBackendAnnotations) setLoadingAnnotations(true);
        if (socket && socket.readyState === WebSocket.OPEN) {
          // Clear any existing timeout
          if (zarrInitTimeoutRef.current) {
            clearTimeout(zarrInitTimeoutRef.current);
            zarrInitTimeoutRef.current = null;
          }

          setIsZarrInitializing(true); // Mark Zarr as initializing

          // Set timeout for Zarr initialization
          zarrInitTimeoutRef.current = setTimeout(() => {
            const canRetry =
              setPathRetryCountRef.current < 1 &&
              socket.readyState === WebSocket.OPEN &&
              !!currentPath;

            if (canRetry) {
              setPathRetryCountRef.current += 1;
              console.log(
                `[Zarr Init Timeout] No response after ${ZARR_INIT_TIMEOUT_MS / 1000} seconds, retrying set_path once for: ${currentPath}`,
              );
              socket.send(
                JSON.stringify({
                  type: "set_path",
                  path: currentPath,
                  instance_id: instanceId,
                }),
              );
              zarrInitTimeoutRef.current = setTimeout(() => {
                console.log(
                  `[Zarr Init Timeout] No response after retry, assuming initialization stalled`,
                );
                setIsZarrInitializing(false);
                setLoadingAnnotations(false);
                setIsRequestPending(false);
                setCurrentRequestType(null);
                zarrInitTimeoutRef.current = null;
              }, ZARR_INIT_TIMEOUT_MS);
              return;
            }

            console.log(
              `[Zarr Init Timeout] No response after ${ZARR_INIT_TIMEOUT_MS / 1000} seconds, assuming initialization stalled`,
            );
            setIsZarrInitializing(false);
            setLoadingAnnotations(false);
            setIsRequestPending(false);
            setCurrentRequestType(null);
            zarrInitTimeoutRef.current = null;
          }, ZARR_INIT_TIMEOUT_MS);

          socket.send(
            JSON.stringify({
              type: "set_path",
              path: currentPath,
              instance_id: instanceId,
            }),
          );
          setPathRetryCountRef.current = 0;
          lastSentPathRef.current = currentPath;
        }
      }
    }
    // Do not depend on `allTilesLoaded` or `showBackendAnnotations`: they change during pan/zoom
    // or UI toggles and would re-run this effect constantly while spamming "path unchanged" logs.
  }, [currentPath, socket, status, instanceId]);

  // Keyboard shortcuts handling
  useKeyboardHandlers({
    socket,
    allTilesLoaded,
    isZarrInitializing,
    isRequestPending,
    existAnnotationFile,
    showBackendAnnotations,
    showPatches,
    showMask,
    setShowBackendAnnotations,
    setShowPatches,
    setShowMask: handleSetShowMask,
    setCurrentRequestType,
    setIsRequestPending,
    keydownUpdate,
    keydownUpdatePatches,
    resendSetPath,
    quickSpaceFallbackTimerRef,
    lastWorkflowRefreshTsRef,
  });

  // Viewport refresh handling
  useViewportRefresh({
    socket,
    viewerInstance,
    currentPath,
    threshold,
    centroidThreshold,
    classificationEnabled,
    showBackendAnnotations,
    existAnnotationFile,
    instanceId,
    setLoadingAnnotations,
    setIsZarrInitializing,
    setIsRequestPending,
    setCurrentRequestType,
    zarrInitTimeoutRef,
    lastHashRef,
    lastSentPathRef,
    lastWorkflowRefreshTsRef,
    ZARR_INIT_TIMEOUT_MS,
    requestPatchesForViewport,
    refreshPatchClassificationData,
  });

  // hide/show backEnd annotations
  useEffect(() => {
    if (annotatorInstance) {
      annotatorInstance.setFilter((annotation: { isBackend: any }) => {
        if (!showBackendAnnotations && annotation.isBackend) return false;
        if (!showUserAnnotations && !annotation.isBackend) return false;
        return true;
      });
    }
  }, [annotatorInstance, showBackendAnnotations, showUserAnnotations]);

  // File change handling
  useFileChangeHandler({
    currentPath,
    annotatorInstance,
    socket,
    viewerInstance,
    setCentroids,
    setAllTilesLoaded,
    setExistAnnotationFile,
    setIsZarrInitializing,
    zarrInitTimeoutRef,
    lastHashRef,
    lastSentPathRef,
    ZARR_INIT_TIMEOUT_MS,
  });

  // Channel updates handling
  useChannelUpdates({
    viewerInstance,
    tileSource,
    visibleChannels,
    channels,
    channelSignature,
    currentWSIInfo,
    currentWSIFileInfo,
    currentInstanceId,
    getTileUrl,
    setAllTilesLoaded,
  });

  const isRequestingClassification = useSelector(
    (state: RootState) => state.annotations.isRequestingClassification,
  );

  useEffect(() => {
    const handleClassificationRequest = async () => {
      dispatch(setClassificationEnabled(true));

      // 1) clear backend annotations
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "clear_annotations",
          }),
        );
      }

      // 2) front-end clear annotations
      if (annotatorInstance) {
        annotatorInstance.setAnnotations([], true);
        dispatch(setAnnotations([]));
      }
      dispatch(clearPatchOverlays());
      dispatch(clearPatchOverrides());
      setCentroids(EMPTY_CENTROIDS);
      setShowBackendAnnotations(true);

      await handleLoadClassification();
      dispatch(classificationRequestComplete());
    };

    if (isRequestingClassification) {
      handleClassificationRequest();
    }
  }, [
    isRequestingClassification,
    annotatorInstance,
    currentPath,
    socket,
    dispatch,
    handleLoadClassification,
  ]);

  // Add Redux Status Monitoring
  const reduxAnnotations = useSelector(
    (state: RootState) => state.annotations.annotations,
  );

  // Add periodic memory checks
  useEffect(() => {
    if (annotatorInstance) {
      const intervalId = setInterval(() => {
        try {
          const uiAnnotations = annotatorInstance.getAnnotations();
          const reduxStateAnnotations =
            store.getState().annotations.annotations;

          // Try to output memory usage (Chrome only)
          if (window.performance && (window.performance as any).memory) {
          }

          // Check if they match
          if (uiAnnotations.length !== reduxStateAnnotations.length) {
          }
        } catch (error) {
          console.error("[Periodic Check] Error:", error);
        }
      }, 30000); // Check every 30 seconds

      return () => clearInterval(intervalId);
    }
  }, [annotatorInstance]);

  // Monitor Redux state changes
  useEffect(() => {}, [reduxAnnotations.length]);

  // Set viewer instance to context when annotatorInstance changes
  useEffect(() => {
    if (annotatorInstance?.viewer) {
      console.log("Setting viewerInstance to context:", {
        annotatorInstanceExists: !!annotatorInstance,
        viewerExists: !!annotatorInstance.viewer,
      });
      setViewerInstance(annotatorInstance.viewer);
    }
    // clear the viewer instance when the component unmounts
    return () => {
      console.log("Clearing viewerInstance from context");
      setViewerInstance(null);

      // Clean up WebGL contexts to prevent leaks
      if (webglContextManager.getContextCount() > 0) {
        console.log("Cleaning up WebGL contexts on viewer instance change");
        webglContextManager.releaseAllContexts();
      }
    };
  }, [annotatorInstance, setViewerInstance]);

  // Use annotation handlers hook
  const {
    handleCanvasDoubleClick,
    handleClickAnnotationForClassification,
    rulerHandler,
    rulerLeaveHandler,
    rulerMoveHandler,
  } = useAnnotationHandlers({
    viewerInstance,
    annotatorInstance,
    centroids,
    activeManualClassificationClassRef,
    currentSvsPath,
    currentPath,
    currentInstanceId,
    nucleiClasses,
    currentOrgan,
    slideInfo: { mpp: slideInfo?.mpp ?? undefined },
    mousePos,
    handleToolbarClick,
    selectedFolder,
    selectedModelForCurrentPath,
    updateClassifier,
    updateAfterEveryAnnotation,
    setRulerTooltip,
    onSaveAnnotationSuccess: refreshGtHighlightIndices,
  });

  return (
    <div
      className="flex flex-col bg-background text-foreground h-full"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ViewerToolbar
        currentTool={currentTool}
        onToolClick={handleToolbarClick}
        showBackendAnnotations={showBackendAnnotations}
        setShowBackendAnnotations={setShowBackendAnnotations}
        keydownUpdate={keydownUpdate}
        nucleiModeAvailable={nucleiModeAvailable}
        showPatches={showPatches}
        setShowPatches={setShowPatches}
        keydownUpdatePatches={keydownUpdatePatches}
        patchModeAvailable={patchModeAvailable}
        showMask={showMask}
        setShowMask={handleSetShowMask}
        maskModeAvailable={maskModeAvailable}
        maskOptions={maskOptions}
        selectedMaskKey={selectedMaskKey}
        onSelectMaskKey={(key) => dispatch(setSelectedMaskKey(key))}
        onGoToRecommended={handleGoToRecommended}
        onlineUsers={onlineUsers}
      />

      {/* OpenSeadragon viewer */}
      {/*@ts-ignore*/}
      <OpenSeadragonAnnotator
        autoSave
        drawingEnabled={dynamicDrawingEnabled}
        tool={currentTool === 'move' ? undefined : currentTool === 'filter' ? 'rectangle' : currentTool}
        userSelectAction={showUserAnnotations ? UserSelectAction.EDIT : UserSelectAction.NONE}
        drawingMode="drag"
        key={`annotator-${currentInstanceId}-${tileSource?._key || "default"}`} // use tileSource key to ensure re-creation
      >
        {/* Viewer height automatically fills remaining space */}
        <div className="relative w-full flex-1 min-h-0">
          {/*@ts-ignore*/}
          {options && (
            <OpenSeadragonViewer
              key={`viewer-${currentInstanceId}-${tileSource?._key || "default"}`} // use tileSource key to ensure re-creation
              className="bg-muted w-full h-full relative"
              options={options}
            />
          )}

          {/* Z-Stack UI: positioned within tile viewport only (excludes ViewerToolbar + 22px status bar) */}
          {isThisInstanceActive && (
            <div
              className="pointer-events-none absolute inset-x-0 top-0 z-[50]"
              style={{ bottom: 22 }}
            >
              <ZStackController
                sessionId={currentInstanceId || "default"}
                onLayerChange={() => {
                  /* tiles refresh via zLayerChanged listener in viewer */
                }}
              />
            </div>
          )}

          {/* OSD Navigator */}
          {viewerInstance && showNavigator && (
            <OSDNavigator navigatorSizeRatio={0.2} autoHideDelay={1000} />
          )}

          {(showBackendAnnotations || (currentTool === "filter" && filterHighlightIndices != null && filterHighlightIndices.length > 0)) &&
            overlayHostRef.current &&
            ReactDOM.createPortal(
              <DrawingOverlay
                viewer={viewerInstance}
                centroids={centroids}
                annotations={renderingAnnotations}
                threshold={threshold}
                classificationData={classificationData}
                nucleiClasses={nucleiClasses}
                filterOnlyHighlight={!showBackendAnnotations && currentTool === "filter" && (filterHighlightIndices?.length ?? 0) > 0}
              />,
              overlayHostRef.current,
            )}

          {showPatches &&
            overlayHostRef.current &&
            ReactDOM.createPortal(
              <PatchOverlay viewer={viewerInstance} patches={patches} />,
              overlayHostRef.current,
            )}

          {showMask &&
            overlayHostRef.current &&
            ReactDOM.createPortal(
              <MaskOverlay
                viewer={viewerInstance}
                currentPath={currentPath}
                selectedMaskKey={selectedMaskKey}
                onLoadingChange={setLoadingMask}
              />,
              overlayHostRef.current,
            )}


          {/* Full-screen loading overlay for Go to recommended */}
          {loadingRecommendViewport && (
            <div
              className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/80 backdrop-blur-sm"
              aria-live="polite"
              aria-busy="true"
            >
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <p className="mt-3 text-sm font-medium text-foreground">Loading recommended region...</p>
            </div>
          )}

          {/* Status bar at the bottom of the viewer */}
          <ViewerStatusBar
            mousePos={mousePos}
            imageBounds={imageBounds}
            imageRotation={imageRotation}
            magnification={magnification}
            currentWSIFileInfo={currentWSIFileInfo}
            loadingAnnotations={loadingAnnotations}
            loadingMask={loadingMask}
            allTilesLoaded={allTilesLoaded}
          />
        </div>
        {/*@ts-ignore*/}
        <OpenSeadragonAnnotationPopup
          popup={(props: any) => (
            <AnnotationPopup
              annotation={props.annotation}
              selectedTool={currentTool}
              onSave={(color, customText) => {
                try {
                  const annotation = annotatorInstance.getAnnotationById(
                    props.annotation.id,
                  );
                  if (annotation) {
                    const updatedAnnotation = {
                      ...annotation,
                      bodies: [
                        ...annotation.bodies.filter(
                          (b: AnnotationBody) =>
                            b.purpose !== "style" && b.purpose !== "comment",
                        ),
                        {
                          id: String(Date.now()),
                          annotation: annotation.id,
                          type: "TextualBody",
                          purpose: "style",
                          value: color,
                          created: new Date().toISOString(),
                          creator: {
                            id: "default",
                            type: "Person",
                          },
                        },
                        {
                          id: String(Date.now()),
                          annotation: annotation.id,
                          type: "TextualBody",
                          purpose: "comment",
                          value: customText,
                          created: new Date().toISOString(),
                          creator: {
                            id: "default",
                            type: "Person",
                          },
                        },
                      ],
                    };

                    // use updateAnnotation to update the annotation
                    annotatorInstance.updateAnnotation(updatedAnnotation);
                    // re-select the annotation to show the updated style
                    annotatorInstance.setSelected(updatedAnnotation.id);
                  }
                  annotatorInstance.cancelSelected();
                } catch (error) {
                  console.error("Error saving annotation:", error);
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
          )}
        />
      </OpenSeadragonAnnotator>

      {/* Ruler Tooltip */}
      <RulerTooltip
        visible={rulerTooltip.visible}
        text={rulerTooltip.text}
        position={rulerTooltip.position}
      />

      {dragging && (
        <div
          ref={textRef}
          className="z-50 absolute inset-0 flex items-center justify-center bg-black bg-opacity-50"
        >
          <p className="text-white text-2xl z-10">
            Drag the file here to reload
          </p>
        </div>
      )}
    </div>
  );
};

export default OpenSeadragonContainer;
