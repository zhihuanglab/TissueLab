"use client";
import {
  AnnotationState,
  ImageAnnotation,
  UserSelectAction,
} from "@annotorious/react";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import DrawingOverlay from "@/components/imageViewer/overlays/DrawingOverlay";
import PatchOverlay from "@/components/imageViewer/overlays/PatchOverlay";
import MaskOverlay from "@/components/imageViewer/overlays/MaskOverlay";
import LassoOverlay from "@/components/imageViewer/overlays/LassoOverlay";
import dynamic from "next/dynamic";
import ReactDOM from "react-dom";

// redux
import { RootState, store } from "@/store";
import {
  setPendingGraphOverlayRestore,
  type GraphWorkflowOverlaySnapshot,
} from "@/store/slices/chat/workflowSlice";
import {
  classificationRequestComplete,
  clearAnnotationTypes,
  clearPatchOverrides,
  clearPatchOverridesForIds,
  selectPatchClassificationData,
  setAnnotations,
  setClassificationEnabled,
  setNucleiClasses,
  setPatchClassificationData,
  type PatchOverlayEntry,
} from "@/store/slices/viewer/annotationSlice";
import {
  RectangleCoords,
  resetShapeData,
  setShapeData,
} from "@/store/slices/viewer/shapeSlice";
import { clearGtHighlightIndices } from "@/store/slices/viewer/gtHighlightSlice";
import { setTool } from "@/store/slices/viewer/toolSlice";
import { useDispatch, useSelector } from "react-redux";
import eventBus from "@/utils/common/eventBus";


//custom components
import useAnnotatorInitialization from "@/hooks/viewer/useAnnotatorInitialization";
import { useOpenSeadragonGestures } from "@/hooks/viewer/useOpenSeadragonGestures";
import { useViewportOverlaySession } from "@/hooks/viewer/useViewportOverlaySession";
import { usePathBinding } from "@/hooks/viewer/usePathBinding";
import { usePresence } from "@/hooks/viewer/usePresence";

// hashing function
import xxhash from "xxhash-wasm";

import { useAnnotatorInstance } from "@/contexts/AnnotatorContext";
import { useViewerSettings } from "@/hooks/viewer/useViewerSettings";
import { useWebGLCleanup } from "@/hooks/viewer/useWebGLCleanup";

import OSDNavigator from "@/components/imageViewer/viewer/OSDNavigator";
import {
  AI_SERVICE_API_ENDPOINT,
  AI_SERVICE_SOCKET_ENDPOINT,
} from "@/config/api.config";

// Workflow utility
import AnnotationPopup from "@/components/imageViewer/toolBox/AnnotationPopup";
import RulerTooltip from "@/components/imageViewer/viewer/RulerTooltip";
import ViewerStatusBar from "@/components/imageViewer/viewer/ViewerStatusBar";
import ViewerToolbar from "@/components/imageViewer/viewer/ViewerToolbar";
import ZStackController from "@/components/imageViewer/viewer/ZStackController";
import { useWs } from "@/contexts/WsProvider";
import { useAnnotationHandlers } from "@/hooks/viewer/useAnnotationHandlers";
import { useRefreshGtHighlightIndices } from "@/hooks/viewer/useRefreshGtHighlightIndices";
import { useChannelUpdates } from "@/hooks/viewer/useChannelUpdates";
import { useFileChangeHandler } from "@/hooks/viewer/useFileChangeHandler";
import { useManualAnnotationHydration } from "@/hooks/viewer/useManualAnnotationHydration";
import { useKeyboardHandlers } from "@/hooks/viewer/useKeyboardHandlers";
import { useViewportRefresh } from "@/hooks/viewer/useViewportRefresh";
import { useWebSocketMessageHandler } from "@/hooks/viewer/useWebSocketMessageHandler";
import { selectSelectedModelForPath } from "@/store/slices/chat/modelSelectionSlice";
import { useAnnotationTypes } from "@/store/zustand/slice/annotationTypesStore";
import { apiFetch } from "@/utils/common/apiFetch"; // centralized http client
import { segFetch } from "@/utils/common/segFetch";
import { getErrorMessage } from "@/utils/common/apiResponse";
import { getAuthToken } from "@/utils/common/authToken";
import {
  createTileSource,
  createTileUrlGenerator,
  createTileUrlGeneratorForLayer,
  getLargestTiledImage,
} from "@/utils/viewer/viewerHelpers";
import { formatPath } from "@/utils/common/path.utils";
import { toLocalWorkflowZarrPath } from "@/utils/agent/workflow/pathNorm";
import {
  extractManualPayload,
  isFilterEphemeral,
  isManualAnnotation,
  toManualZarrPath,
  withFilterEphemeral,
} from "@/utils/viewer/annotation.utils";
import { persistManualDrawing, remoteUpdateAnnotation, withManualPersistSuppressed } from "@/utils/viewer/persistManualDrawing";
import { approveManualPersist, isManualPersistApproved } from "@/utils/viewer/manualAnnotationSync";
import { isWriteBlockedPath } from "@/utils/common/pathAccess.utils";
import { getMaskOptions, type MaskOption } from "@/services/data.service";
import { setSelectedMaskKey } from "@/store/slices/viewer/viewerSettingsSlice";
import { reconcileMaskKey } from "@/utils/viewer/maskBitmap";
import OpenSeadragon from "openseadragon";
import "@annotorious/react/annotorious-react.css";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { CentroidsArray } from "@/types/centroidsArray";
import {
  EMPTY_OVERLAY_PENDING,
  type OverlayPendingRequest,
} from "@/utils/viewer/overlayRequestNotify";
import { clearViewportOverlayCaches } from "@/utils/viewer/viewportOverlayCaches";
import {
  needsSelfServiceReload,
  type WorkflowRunFinishedPayload,
} from "@/utils/agent/workflow/completionSideEffects";
import { forgetContourPaint } from "@/utils/viewer/viewportContourCache";
import {
  applyLoadedClassification,
  isNonFatalHandlerNotReadyMessage,
  dropCellOverrides,
  shouldDropStaleOverrides,
  snapshotCellOverrideIds,
} from "@/utils/viewer/classificationLoad";

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

// Empty overlay constants — reuse so emptying an already-empty overlay does not re-render.
const EMPTY_CENTROIDS = new CentroidsArray(new Int32Array(0), 0);
const EMPTY_ANNOTATIONS: any[] = [];
const EMPTY_PATCHES: PatchOverlayEntry[] = [];

const OpenSeadragonContainer: React.FC<{ instanceId?: string }> = ({
  instanceId,
}) => {
  const [tileSource, setTileSource] = useState<any>(null);
  const [options, setOptions] = useState<any>(null);
  const [tileAuthToken, setTileAuthToken] = useState<string | null>(null);
  const [headerHeight, setHeaderHeight] = useState(104);
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const lastResetTimestampRef = useRef<number>(0);
  const overlayHostRef = useRef<HTMLDivElement | null>(null);

  // OSD bypasses apiFetch, so resolve the auth token before any tile source
  // is created. Refresh periodically; changing the token rebuilds the source.
  useEffect(() => {
    let cancelled = false;
    setTileAuthToken(null);
    const refresh = async () => {
      const token = await getAuthToken();
      if (!cancelled) setTileAuthToken(token);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 50 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [instanceId]);

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
  // Single patches gate shared with keyboard / overlay session / WS.
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

  // Per-instance slide path — handler / set_path source of truth.
  const currentPath = useSelector((state: RootState) =>
    instanceId ? state.wsi.instances[instanceId]?.filePath ?? null : null,
  );

  // Fetch mask options (Tissue-Segmentation/masks/<tissue>). Re-fetch on path change AND
  // after a workflow run finishes — a VISTA run produces new masks without changing the
  // path, so without the run-finished refresh the Tissue Overlay toggle would stay disabled.
  const refreshMaskOptions = useCallback(() => {
    if (!currentPath) {
      setMaskOptions([]);
      return;
    }
    const zarrPath = toLocalWorkflowZarrPath(currentPath);
    if (!zarrPath) {
      setMaskOptions([]);
      return;
    }
    getMaskOptions(zarrPath).then((res) => {
      setMaskOptions(res.success && res.options ? res.options : []);
    });
  }, [currentPath]);

  useEffect(() => {
    refreshMaskOptions();
  }, [refreshMaskOptions]);

  useEffect(() => {
    const handler = () => refreshMaskOptions();
    // Re-fetch after a run produces masks, and after a reset removes them (reset emits
    // 'refresh-patches'), so the Tissue Overlay toggle enables/greys to match the zarr.
    eventBus.on("workflow-graph-run-finished", handler);
    eventBus.on("refresh-patches", handler);
    return () => {
      eventBus.off("workflow-graph-run-finished", handler);
      eventBus.off("refresh-patches", handler);
    };
  }, [refreshMaskOptions]);

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
  /** Single nuclei gate for keyboard / overlay session / WS / workflow snapshot. */
  const showBackendAnnotationsRef = useRef(showBackendAnnotations);
  showBackendAnnotationsRef.current = showBackendAnnotations;
  const [existAnnotationFile, setExistAnnotationFile] = useState(false);

  // Nuclei/patches toggle intent — flags mean a user overlay request is in flight
  const [pendingRequest, setPendingRequest] =
    useState<OverlayPendingRequest>(EMPTY_OVERLAY_PENDING);

  // Slide binding (set_path lifecycle) lives in one state machine — see
  // usePathBinding. The wire gate, "still initializing" flag, bound path and
  // no-ack deadline are all phases of it rather than separate variables.
  const ZARR_INIT_TIMEOUT_MS = 30000; // Sample/public Zarr initialization can be slow; avoid premature timeout
  const bindTimeoutRef = useRef<(path: string | null) => void>(() => {});
  /**
   * Has a handler rebuild landed since mount / since the current run started?
   * Two readers: the run-finished backstop only rebuilds when this is still
   * false (so the normal reload path is not doubled), and the classification
   * load only drops stale per-cell overrides when it is true (so they are never
   * dropped against a handler that is still serving the pre-run zarr).
   */
  const handlerRebuiltRef = useRef(false);
  /**
   * Armed when a workflow run finishes, consumed by the next classification load
   * that lands on a rebuilt handler.
   *
   * The per-cell overrides may ONLY be dropped in that one window. They are the
   * user's manual marks, and `useFileChangeHandler` deliberately keeps them
   * across everything except an actual slide switch — so dropping them on every
   * set_path ack (first bind, reconnect, returning to the page) loses marks the
   * user just made. A finished run is the only moment the backend result
   * genuinely supersedes them.
   */
  const pendingCellOverrideDropRef = useRef(false);
  /** Same rule for the patch overlay's `patchOverrides` (PatchOverlay gives them
   *  the same precedence over class_id that DrawingOverlay gives cell overrides). */
  const pendingPatchOverrideDropRef = useRef(false);
  /** Overrides present when the run finished — the only ones it may supersede. */
  const staleCellOverrideIdsRef = useRef<string[] | null>(null);
  const stalePatchOverrideIdsRef = useRef<number[] | null>(null);
  /**
   * Overrides whose removal is waiting for the frame that replaces them.
   *
   * The classifications fetch answers in ~100ms; the frame carrying the new
   * result lands a few hundred later. Dropping the marks when the fetch returns
   * therefore repaints the user's own labels back to model colours FIRST and
   * shows the new result SECOND — which reads as "it undid my work, then
   * refreshed". Handing the drop to the frame makes it one visible change:
   * `settleOverlay` runs in the same tick as the paint, so React commits the new
   * cells and the removed marks together.
   */
  const armedCellOverrideDropRef = useRef<string[] | null>(null);
  const armedPatchOverrideDropRef = useRef<number[] | null>(null);
  const binding = usePathBinding({
    timeoutMs: ZARR_INIT_TIMEOUT_MS,
    onTimeout: (path) => bindTimeoutRef.current(path),
  });
  const isZarrInitializing = binding.isBinding;
  const pathReadyForDataRef = binding.gateRef;
  const lastSentPathRef = binding.boundPathRef;

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
  const currentOrgan = useSelector(
    (state: RootState) => state.workflow.currentOrgan,
  );
  const isRunning = useSelector((state: RootState) => state.workflow.isRunning);
  const currentTool = useSelector((state: RootState) => state.tool.currentTool);
  // Always-fresh mirror for use inside long-lived annotator callbacks.
  const currentToolRef = useRef(currentTool);
  currentToolRef.current = currentTool;
  const filterToolRef = useRef(currentTool === "filter");
  filterToolRef.current = currentTool === "filter";

  // Get selectedFolder and selected model for classifier path
  const selectedFolder = useSelector(
    (state: RootState) => state.fileManager.selectedFolder,
  );
  const isWebMode = useMemo(() => {
    const activeInstance = instanceId
      ? store.getState().wsi.instances[instanceId]
      : undefined;
    const source = activeInstance?.fileInfo?.source as string | undefined;
    return source === "web";
  }, [instanceId]);

  // Get selected model for current path (same logic as ClassificationPanel)
  const selectedModelForCurrentPath = useSelector((state: RootState) => {
    let targetPath = selectedFolder || "";
    if (!targetPath && currentPath) {
      const separator = isWebMode
        ? "/"
        : currentPath.includes("\\")
          ? "\\"
          : "/";
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath =
        lastIndex !== -1
          ? currentPath.substring(0, lastIndex)
          : isWebMode
            ? ""
            : currentPath;
    }
    if (isWebMode && targetPath === "") {
      targetPath = "";
    }
    return selectSelectedModelForPath(state, targetPath);
  });

  // Ref to hold the latest activeManualClassificationClass
  const activeManualClassificationClassRef = useRef(
    activeManualClassificationClass,
  );

  useEffect(() => {
    activeManualClassificationClassRef.current =
      activeManualClassificationClass;
  }, [activeManualClassificationClass]);

  // Current ROI selection (rectangle or polygon) for ROI-aware styling
  const shapeData = useSelector((state: RootState) => state.shape.shapeData);
  const filterHighlightIndices = useSelector((state: RootState) => state.shape.filterHighlightIndices);

  // threshold (Space/explicit high-zoom annotations)
  const threshold = useSelector(
    (state: RootState) => state.annotations.threshold,
  );

  const dispatch = useDispatch();

  // initialize annotator
  const { annotatorInstance, viewerRef } = useAnnotatorInitialization(instanceId);

  // Get current instance id
  const currentInstanceId = instanceId;

  const isThisInstanceActive = useSelector((state: RootState) =>
    instanceId ? Boolean(state.wsi.instances[instanceId]?.isActive) : true,
  );

  const dynamicDrawingEnabled =
    isThisInstanceActive &&
    currentTool !== "move" &&
    currentTool !== "lasso";

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
  const [patches, setPatches] = useState<PatchOverlayEntry[]>(EMPTY_PATCHES);
  const patchClassificationData = useSelector(selectPatchClassificationData);

  const updateCentroids = useCallback((newCentroids: CentroidsArray) => {
    setCentroids(newCentroids);
  }, []);

  // Stable identity: this feeds the overlay hub's effect runner, so a new
  // function each render churns dispatchEvent and re-fires the effects keyed on
  // it (the classificationEnabled effect then resets + resyncs every render).
  const updateRenderingAnnotations = useCallback((newAnnotations: any[]) => {
    setRenderingAnnotations(newAnnotations);
  }, []);

  // mouse position feature state
  // Pointer position lives outside React (pointerPositionStore): OSD reports
  // every mouse move, and holding it here re-rendered this whole component —
  // the largest in the app — on each one. Only ViewerStatusBar subscribes now.
  const [imageBounds, setImageBounds] = useState({
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
  });
  const [imageRotation, setImageRotation] = useState(0);
  const [magnification, setMagnification] = useState(1);

  const [allTilesLoaded, setAllTilesLoaded] = useState(false);
  const [loadingMask, setLoadingMask] = useState(false);

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

  const lastHashRef = useRef<string | null>(null);
  // Discard this render when the slide path changes so the new image never
  // commits a frame that still holds the previous slide's overlay paint.
  const overlaySlidePathRef = useRef(currentPath);
  const overlayPathChanged = overlaySlidePathRef.current !== currentPath;
  if (overlayPathChanged) {
    setCentroids((prev) => (prev.length === 0 ? prev : EMPTY_CENTROIDS));
    setRenderingAnnotations((prev) =>
      prev.length === 0 ? prev : EMPTY_ANNOTATIONS,
    );
    setPatches((prev) => (prev.length === 0 ? prev : EMPTY_PATCHES));
  }
  const paintCentroids = overlayPathChanged ? EMPTY_CENTROIDS : centroids;
  const paintAnnotations = overlayPathChanged ? EMPTY_ANNOTATIONS : renderingAnnotations;
  const paintPatches = overlayPathChanged ? EMPTY_PATCHES : patches;
  // Gates the cell overlay's *data*, not its mounting — see the DrawingOverlay
  // portal below for why it must stay mounted.
  const cellOverlayVisible =
    showBackendAnnotations ||
    (currentTool === "filter" &&
      filterHighlightIndices != null &&
      filterHighlightIndices.length > 0);
  useLayoutEffect(() => {
    if (overlaySlidePathRef.current !== currentPath) {
      // Un-bind before the browser can deliver another frame for the old slide.
      // Layout timing, not render, so the binding machine stays the only owner.
      binding.release();
    }
    overlaySlidePathRef.current = currentPath;
  }, [currentPath, binding]);

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
      return (
        normalized.includes("no handler found for instance") ||
        normalized.includes("no segmentation handler for") ||
        normalized.includes("x-instance-id header is required")
      );
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
      const response = await segFetch(
        instanceId,
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

        // Same rule as the cell overrides: PatchOverlay paints
        // `patchOverrides[idx] || classColors[class_id]`, so a manual tissue mark
        // masks the new prediction until it is dropped — but dropping it outside
        // the post-run window would lose marks on a page switch.
        if (
          shouldDropStaleOverrides({
            runJustFinished: pendingPatchOverrideDropRef.current,
            handlerRebuilt: handlerRebuiltRef.current,
          })
        ) {
          const stale = stalePatchOverrideIdsRef.current;
          pendingPatchOverrideDropRef.current = false;
          stalePatchOverrideIdsRef.current = null;
          // Ids only — a patch marked between the run finishing and its reload
          // landing has never been in a frame, so clearing it would lose it.
          if (stale && stale.length > 0) {
            // Same timing rule as the cell overrides: let the frame that carries
            // the new prediction take the old mark with it, in one change.
            if (showPatchesRef.current) {
              armedPatchOverrideDropRef.current = stale;
            } else {
              dispatch(clearPatchOverridesForIds(stale));
            }
          }
        }
      } else {
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
      const fallback = store.getState().annotations.patchClassificationData;
      if (fallback && fallback.class_name.length > 0) {
        dispatch(setPatchClassificationData(fallback));
      } else {
        dispatch(setPatchClassificationData(getDefaultPatchData()));
      }
    }
  }, [dispatch, instanceId]);

  const overlaySession = useViewportOverlaySession({
    viewerInstance,
    socket,
    instanceId,
    updateCentroids,
    updateRenderingAnnotations,
    setPatches,
    setPendingRequest,
    showBackendAnnotations,
    showBackendAnnotationsRef,
    showPatchesRef,
    filterToolRef,
    threshold,
    lastHashRef,
    pathReadyForDataRef,
  });

  const {
    busy: overlayBusy,
    requestPatches,
    keydownUpdate,
    keydownUpdatePatches,
    settleOverlay,
    faultOverlay,
    takeAbandonedCellReply,
    isPatchesFlying,
    expectsWireFrame,
    forceSync: forceOverlaySync,
    resetAll: resetOverlay,
    clearAbandonedCellReplies,
  } = overlaySession;

  /**
   * The one place a frame is known to have been applied. Whatever else has to
   * change *with* that frame happens here, so the user sees a single update.
   *
   * Today that is the stale per-cell / per-patch override drop: those marks are
   * superseded by the run's result, but the result arrives on the frame while the
   * marks are removed by an HTTP round trip that answers earlier. Dropping them
   * on their own showed the marks reverting to model colours a few hundred ms
   * before the new cells arrived, which reads as an undo followed by a refresh.
   * `handleCellOverlayMessage` has already called `setRenderingAnnotations` by the
   * time this runs, so both land in one React commit.
   */
  const settleOverlayWithArmedDrops = useCallback(
    (kind: "cell" | "patches", opts: { applied: boolean }) => {
      if (opts.applied) {
        if (kind === "cell" && armedCellOverrideDropRef.current) {
          const ids = armedCellOverrideDropRef.current;
          armedCellOverrideDropRef.current = null;
          dropCellOverrides(ids);
        }
        if (kind === "patches" && armedPatchOverrideDropRef.current) {
          const ids = armedPatchOverrideDropRef.current;
          armedPatchOverrideDropRef.current = null;
          dispatch(clearPatchOverridesForIds(ids));
        }
      }
      settleOverlay(kind, opts);
    },
    [dispatch, settleOverlay],
  );

  // Rebuild this viewer's overlay against a freshly bound handler, then open the
  // wire gate. Drops stale pre-reload centroids/contours and re-requests. The
  // caches were just dropped, so `refetch` costs no extra read here — what it
  // buys is a request that goes out immediately (`loading` timing) instead of
  // being coalesced into the idle flush, where a later generation bump or a
  // shut gate could strand it with the overlay already blanked.
  const rebuildOverlayForHandler = useCallback(() => {
    handlerRebuiltRef.current = true;
    if (typeof instanceId === "string" && instanceId) {
      clearViewportOverlayCaches(instanceId);
    }
    // Same slide, new data: hold the current frame until the replacement lands
    // rather than blanking for the length of the round trip.
    resetOverlay({ keepPaint: true });
    // set_path may have abandoned in-flight cell replies while the gate was shut.
    // Those frames are dropped without settling, so clear the debt or the first
    // post-reload reply gets stolen.
    clearAbandonedCellReplies();
    binding.rebuilt();
    forceOverlaySync({ intent: "explicit", refetch: true });
  }, [
    instanceId,
    currentPath,
    resetOverlay,
    clearAbandonedCellReplies,
    binding,
    forceOverlaySync,
  ]);

  // Single no-ack handler for every bind (first load, slide switch, reconnect).
  // Each of those used to carry its own copy of this retry-then-rebuild ladder.
  bindTimeoutRef.current = (path) => {
    const canRetry =
      setPathRetryCountRef.current < 1 &&
      !!path &&
      !!instanceId &&
      socket?.readyState === WebSocket.OPEN;

    if (canRetry) {
      setPathRetryCountRef.current += 1;
      console.log(`[PathBinding] retrying set_path once for: ${path}`);
      socket!.send(
        JSON.stringify({ type: "set_path", path, instance_id: instanceId }),
      );
      binding.bind(path!);
      return;
    }

    // Gave up: the machine is already in `failed` (gate open, so late data is
    // still accepted). Rebuild the overlay from scratch like an ack would.
    console.log(`[PathBinding] set_path never acked; rebuilding overlay`, { path });
    setPendingRequest(EMPTY_OVERLAY_PENDING);
    rebuildOverlayForHandler();
  };

  // Spinner is derived, never set: it is on exactly while the overlay session has
  // a request the user is waiting on, or while this slide is still binding with a
  // layer switched on. Nothing can leave it stuck because nothing switches it off.
  const loadingAnnotations =
    overlayBusy || (isZarrInitializing && (showBackendAnnotations || showPatches));

  // Workflow graph / hook startWorkflow: restore viewer overlay toggles when the run
  // finishes. Keep overlays the user still has on (or had on at start); never force
  // Cell Overlay off after NuClass — refresh latest results instead.
  useEffect(() => {
    const onGraphRunStart = () => {
      // Before the active-viewer guard: every viewer must forget that it has
      // rebuilt, or one that becomes active mid-run would still look "rebuilt
      // for this run" and drop marks it never reloaded.
      handlerRebuiltRef.current = false;
      const active = store.getState().wsi.activeInstanceId;
      if (active != null && instanceId != null && active !== instanceId) {
        return;
      }
      const snap: GraphWorkflowOverlaySnapshot = {
        showBackendAnnotations: showBackendAnnotationsRef.current,
        showPatches: showPatchesRef.current,
        showMask: showMaskRef.current,
      };
      // Multi-viewer + missing activeInstanceId: merge OR so an inactive viewer
      // with toggles off cannot overwrite the active viewer's cell-on snap.
      const existing = store.getState().workflow.pendingGraphOverlayRestore;
      if (existing) {
        snap.showBackendAnnotations =
          existing.showBackendAnnotations || snap.showBackendAnnotations;
        snap.showPatches = existing.showPatches || snap.showPatches;
        snap.showMask = existing.showMask || snap.showMask;
      }
      store.dispatch(setPendingGraphOverlayRestore(snap));
    };
    const onGraphRunAbort = () => {
      store.dispatch(setPendingGraphOverlayRestore(null));
    };
    /**
     * Second reader of `handlerRebuiltRef`. The completion decides, synchronously,
     * whether it asked anyone to reload — so it reports that instead of leaving
     * every viewer to guess. `reloadEmitted: false` on a run whose zarr is the one
     * under this viewer means nothing has re-read it and nothing will, so ask
     * here; there is no waiting to see whether a reload shows up.
     *
     * `deferred` is the batch runtime holding the refresh on purpose — it owns the
     * single reload once the queue settles, and a viewer jumping in would reload
     * once per slide in the batch.
     */
    const requestReloadIfCompletionSkippedUs = (payload?: WorkflowRunFinishedPayload) => {
      const mine = instanceId
        ? store.getState().wsi.instances[instanceId]?.filePath ?? null
        : null;
      if (
        !needsSelfServiceReload({
          payload,
          viewerPath: mine,
          handlerRebuilt: handlerRebuiltRef.current,
          // Gate shut = a set_path of ours is outstanding; the broadcast that
          // started it already covers this slide.
          reloadInFlight: !pathReadyForDataRef.current,
        })
      ) {
        return;
      }
      console.warn("[Overlay] run finished with no handler reload; requesting one", {
        outputPath: payload?.outputPath,
        path: mine,
      });
      eventBus.emit("refresh-websocket-path", { path: mine, forceReload: true });
    };

    const onGraphRunFinished = (payload?: WorkflowRunFinishedPayload) => {
      // Before the active-pane guard, not after: the pane the completion missed is
      // by definition not the active one, so guarding first made this unreachable
      // for the only case it exists for. It is self-limiting — a pane the run did
      // not write, or one a reload is already coming for, decides no by itself.
      requestReloadIfCompletionSkippedUs(payload);
      const active = store.getState().wsi.activeInstanceId;
      if (active != null && instanceId != null && active !== instanceId) {
        return;
      }
      const pending = store.getState().workflow.pendingGraphOverlayRestore;
      if (pending === null) {
        return;
      }
      store.dispatch(setPendingGraphOverlayRestore(null));
      // Restore run-start enables for cell/patch/mask; never force-disable a
      // toggle still on at finish.
      const nextCell =
        pending.showBackendAnnotations || showBackendAnnotationsRef.current;
      const nextPatches = pending.showPatches || showPatchesRef.current;
      const nextMask = pending.showMask || showMaskRef.current;

      showBackendAnnotationsRef.current = nextCell;
      showPatchesRef.current = nextPatches;
      setShowBackendAnnotations(nextCell);
      setShowPatches(nextPatches);
      handleSetShowMask(nextMask);
      // Fresh paint comes from handler-reload-complete: clear caches → reset →
      // forceSync, with the current frame held until the new one lands.
    };
    eventBus.on("workflow-graph-run-start", onGraphRunStart);
    eventBus.on("workflow-graph-run-aborted", onGraphRunAbort);
    eventBus.on("workflow-graph-run-finished", onGraphRunFinished);
    return () => {
      eventBus.off("workflow-graph-run-start", onGraphRunStart);
      eventBus.off("workflow-graph-run-aborted", onGraphRunAbort);
      eventBus.off("workflow-graph-run-finished", onGraphRunFinished);
    };
  }, [instanceId, handleSetShowMask]);

  // Mid-run remount (path key bump): re-apply pending cell/patch enables so the
  // toolbar is not stuck off until workflow-graph-run-finished.
  useEffect(() => {
    const pending = store.getState().workflow.pendingGraphOverlayRestore;
    if (!pending) return;
    if (pending.showBackendAnnotations && !showBackendAnnotationsRef.current) {
      showBackendAnnotationsRef.current = true;
      setShowBackendAnnotations(true);
    }
    if (pending.showPatches && !showPatchesRef.current) {
      showPatchesRef.current = true;
      setShowPatches(true);
    }
  }, [instanceId]);

  // Overlay visibility should depend on a fully open socket for the current slide.
  // status may be null while CONNECTING (setSocket happens before onopen) — do not
  // treat that as available or the toolbar enables clicks that immediately fail.
  const overlaySocketAvailable =
    !!socket && status === WebSocket.OPEN && socket.readyState === WebSocket.OPEN;

  const nucleiModeAvailable = overlaySocketAvailable && !!currentPath;

  const patchModeAvailable = overlaySocketAvailable && !!currentPath;

  const maskModeAvailable = maskOptions.length > 0;

  // `selectedMaskKey` is one shared setting, but the masks a slide has are
  // per-slide, and the backend does not fall back for a key it cannot find
  // (only "" / "mask" resolve to the default). Derive what this viewer can
  // actually show instead of writing the shared setting back — that keeps two
  // viewers from fighting over it, and needs no reconciliation pass.
  const effectiveMaskKey = reconcileMaskKey(selectedMaskKey, maskOptions);

  useEffect(() => {
    // Keep the user's Cell/Patch toggle when the slide is still open — socket may
    // briefly be CLOSED/CLOSING during workflow forceReload reconnect. Only force
    // the toggle off when there is no slide to request overlays for.
    if (!nucleiModeAvailable && showBackendAnnotations) {
      if (!currentPath) {
        setShowBackendAnnotations(false);
      }
      setPendingRequest(EMPTY_OVERLAY_PENDING);
    }
  }, [nucleiModeAvailable, showBackendAnnotations, currentPath]);

  useEffect(() => {
    if (!patchModeAvailable && showPatches) {
      if (!currentPath) {
        setShowPatches(false);
      }
      setPendingRequest(EMPTY_OVERLAY_PENDING);
    }
  }, [patchModeAvailable, showPatches, currentPath]);

  useEffect(() => {
    if (!maskModeAvailable && showMask) {
      handleSetShowMask(false);
    }
  }, [handleSetShowMask, maskModeAvailable, showMask]);

  // Set true after a successful post-run classification load (WS ack or idle retry).
  // Cleared when a new run starts so idle retry can still backstop handler-not-ready.
  const classificationLoadOkAfterRunRef = useRef(false);

  const handleLoadClassification = useCallback(async (opts?: {
    dropStaleOverrides?: boolean;
  }): Promise<boolean> => {
    if (!currentPath) {
      console.log("No currentPath, cannot load classification");
      return false;
    }

    const managerUrl = `${AI_SERVICE_API_ENDPOINT}/seg/v1/classifications?file_path=${encodeURIComponent(currentPath)}`;

    try {
      const resp = await segFetch(instanceId, managerUrl, {
        method: "GET",
        returnAxiosFormat: true,
      });

      const responseData = resp.data;
      console.log("backend Classification data++++++:", responseData);

      const wrappedErrorMessage =
        typeof responseData?.message === "string" ? responseData.message : undefined;

      // Decision + stale-override drop live in classificationLoad so they are
      // testable without mounting this component.
      const dropStaleOverrides = shouldDropStaleOverrides({
        explicit: opts?.dropStaleOverrides,
        runJustFinished: pendingCellOverrideDropRef.current,
        handlerRebuilt: handlerRebuiltRef.current,
      });

      // An explicit caller (the "request classification" flow) has already wiped
      // the overlay itself, so there is no frame to be atomic with and it drops
      // here and now. The run-window path hands its drop to the frame instead
      // (see armedCellOverrideDropRef).
      const dropWithThisLoad = dropStaleOverrides && opts?.dropStaleOverrides === true;
      const staleOverrideIds = dropWithThisLoad ? snapshotCellOverrideIds() : null;

      const outcome = applyLoadedClassification(
        responseData,
        store.getState().annotations.nucleiClasses,
        { staleOverrideIds },
      );

      if (outcome.kind === "keep") {
        console.warn(
          isNonFatalHandlerNotReadyMessage(wrappedErrorMessage)
            ? "[Classification] Backend handler is not ready yet; keeping existing overlay classification state."
            : `[Classification] Transient classifications error; keeping existing overlay state: ${wrappedErrorMessage ?? ""}`,
        );
        return false;
      }

      if (outcome.kind === "loaded") {
        // Consumed only once it actually applied; a load that arrived before the
        // rebuild leaves it armed for the retry ladder below.
        if (dropStaleOverrides) {
          pendingCellOverrideDropRef.current = false;
          const stale = staleCellOverrideIdsRef.current;
          staleCellOverrideIdsRef.current = null;
          if (!dropWithThisLoad && stale && stale.length > 0) {
            // Nothing is painting the cell layer, so there is no frame to wait
            // for and no flicker to avoid — drop now rather than leave the arm
            // set until the layer is next switched on.
            if (showBackendAnnotationsRef.current || filterToolRef.current) {
              armedCellOverrideDropRef.current = stale;
            } else {
              dropCellOverrides(stale);
            }
          }
        }
        dispatch(setNucleiClasses(outcome.classes));
        dispatch(setClassificationEnabled(true)); // Set to true since data is available
      } else {
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
        return false;
      }

      const status = err?.response?.status as number | undefined;
      // Network blips / 5xx right after workflow completion — retry without wiping classes.
      if (!status || status >= 500 || status === 408 || status === 429) {
        console.warn(
          "[Classification] Transient classifications fetch failure; keeping existing overlay state:",
          err,
        );
        return false;
      }

      // Definitive miss (e.g. 404): clear classification UI state.
      dispatch(setClassificationEnabled(false));
      dispatch(clearAnnotationTypes());
    }

    await refreshPatchClassificationData();
    classificationLoadOkAfterRunRef.current = true;
    return true;
  }, [currentPath, dispatch, refreshPatchClassificationData, instanceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-check data availability when workflow completes (retry if handler not ready yet).
  // Skip when WS set_path ack already loaded classification successfully for this run.
  const previousIsRunningRef = useRef(isRunning);
  useEffect(() => {
    if (isRunning) {
      classificationLoadOkAfterRunRef.current = false;
    }
    const wasRunning = previousIsRunningRef.current;
    previousIsRunningRef.current = isRunning;
    if (wasRunning && !isRunning) {
      // `workflow.isRunning` is global, but a run targets one slide. Only the
      // viewer it was aimed at may drop its marks — same guard as the overlay
      // restore above. Without it, a run on slide A wipes the marks a second
      // viewer made on slide B.
      const active = store.getState().wsi.activeInstanceId;
      const isForThisViewer =
        active == null || instanceId == null || active === instanceId;
      if (isForThisViewer) {
        // A run just rewrote the zarr. Until the next classification load lands
        // on the rebuilt handler, the backend result supersedes the marks the
        // user made against the previous one — that one window is the only time
        // the per-cell / per-patch overrides may be dropped.
        pendingCellOverrideDropRef.current = true;
        pendingPatchOverrideDropRef.current = true;
        staleCellOverrideIdsRef.current = snapshotCellOverrideIds();
        stalePatchOverrideIdsRef.current = Object.keys(
          store.getState().annotations.patchOverrides,
        ).map(Number);
      }
    }

    // Only re-check on an actual running -> idle transition, not on first mount
    if (wasRunning && !isRunning && currentPath) {
      let cancelled = false;
      const delaysMs = [500, 1200, 2500];
      const timers: ReturnType<typeof setTimeout>[] = [];

      const runWithRetry = async (attempt: number) => {
        if (cancelled || classificationLoadOkAfterRunRef.current) return;
        console.log(
          `[Workflow Complete] Re-checking data availability (attempt ${attempt + 1}/${delaysMs.length})...`,
        );
        const ok = await handleLoadClassification();
        if (cancelled || ok !== false) return;
        if (attempt + 1 < delaysMs.length) {
          timers.push(
            setTimeout(() => {
              void runWithRetry(attempt + 1);
            }, delaysMs[attempt + 1] - delaysMs[attempt]),
          );
        }
      };

      timers.push(
        setTimeout(() => {
          void runWithRetry(0);
        }, delaysMs[0]),
      );

      return () => {
        cancelled = true;
        timers.forEach(clearTimeout);
      };
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
    }
    if (!currentPath) return;
    // Fetched even with highlighting off: the same response carries the
    // "Not <class>" labels for cells a "No" left blank, and those are not a
    // highlighting preference. The hook gates the highlight dispatch itself.
    refreshGtHighlightIndices(currentPath);
  }, [currentPath, highlightGtAnnotations, dispatch, refreshGtHighlightIndices]);

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
    setAllTilesLoaded(event.fullyLoaded);
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
      // Global AnnotatorContext — only the focused pane owns sidebar focus/select.
      if (isThisInstanceActive) {
        setAnnotatorInstance(annotatorInstance);
      }
    }
  }, [annotatorInstance, setAnnotatorInstance, isThisInstanceActive]);

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
      /** Drop in-flight window pointer listeners on effect teardown. */
      let detachActivePointer: (() => void) | null = null;

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

        // Prefer live Annotorious state — create handler may already have stamped
        // filter ephemeral before this listener runs.
        let live: any = annotation;
        try {
          live =
            annotatorInstance.getAnnotationById?.(annotation.id) || annotation;
        } catch {
          live = annotation;
        }
        const isFilterRoi =
          filterToolRef.current || isFilterEphemeral(live);

        // Event payload often has empty bodies; create handler may already have
        // REMOTE-stamped style — only fill style if live still lacks it.
        const liveHasStyle = (live?.bodies || []).some(
          (b: any) => b?.purpose === "style",
        );
        if (!annotation.bodies || annotation.bodies.length === 0) {
          if (!liveHasStyle) {
            const creationDate = new Date();
            let updatedAnnotation: any = {
              ...live,
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
              isBackend: false,
            };
            if (isFilterRoi) {
              updatedAnnotation = withFilterEphemeral(updatedAnnotation);
            }
            try {
              if (!remoteUpdateAnnotation(annotatorInstance, updatedAnnotation)) {
                await annotatorInstance.updateAnnotation(updatedAnnotation);
              }
            } catch (error) {
              console.error("Error updating annotation:", error);
            }
          }
          try {
            await annotatorInstance.setSelected(annotation.id);
          } catch {}
          // A fresh draw just finished — drop back to the move tool. Filter is
          // excluded: it must stay active to keep showing its ROI highlight.
          if (!isFilterRoi && currentToolRef.current !== "filter") {
            dispatch(setTool("move"));
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
        if (coords) eventBus.emit("shape-resizing", coords);
      };

      annotatorInstance.on("selectAnnotation", onSelectAnnotation);

      // Track selection changes and clear highlight if none
      const onSelectionChanged = (selected: any[]) => {
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
      };
      annotatorInstance.on("selectionChanged", onSelectionChanged);

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
        eventBus.emit("shape-resizing", {
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
            if (coords) eventBus.emit("shape-resizing", coords);
          }
        };

        const onPointerUp = (_e: PointerEvent) => {
          window.removeEventListener(
            "pointermove",
            onPointerMove as EventListener,
          );
          window.removeEventListener("pointerup", onPointerUp as EventListener);
          if (detachActivePointer) detachActivePointer = null;
          if (targetElement) {
            try {
              (targetElement as any).releasePointerCapture?.(evt.pointerId);
            } catch {
              /* no-op */
            }
          }
        };

        // So effect teardown can drop in-flight drag listeners on remount.
        detachActivePointer?.();
        detachActivePointer = () => {
          window.removeEventListener(
            "pointermove",
            onPointerMove as EventListener,
          );
          window.removeEventListener("pointerup", onPointerUp as EventListener);
        };

        window.addEventListener("pointermove", onPointerMove as EventListener);
        window.addEventListener("pointerup", onPointerUp as EventListener);
      };

      // Add additional event listeners for polygon movement (this viewer only).
      const onMouseMove = (evt: MouseEvent) => {
        const layerRoot = viewer.element;
        if (!layerRoot) return;
        // Check if we're currently dragging a polygon
        const selectedAnnotation = layerRoot.querySelector(
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
            // Dual viewer: ignore polygons belonging to the other pane.
            if (viewer.element && !viewer.element.contains(target)) return;
            const group = target.closest(
              "g.a9s-annotation.selected",
            ) as SVGGElement | null;
            if (group) {
              emitLivePolygonFromDOM(group);
            }
          }
        });
      });

      // Start observing polygon elements within this viewer only.
      const queryViewerPolygons = () =>
        viewer.element?.querySelectorAll("polygon") ?? [];

      const startObservingPolygons = () => {
        const polygons = queryViewerPolygons();
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
        const polygons = queryViewerPolygons();
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
        annotatorInstance.off("selectionChanged", onSelectionChanged);
        detachActivePointer?.();
        detachActivePointer = null;
        if (shapeDispatchTimeoutRef.current) {
          clearTimeout(shapeDispatchTimeoutRef.current);
          shapeDispatchTimeoutRef.current = null;
        }
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

      if (viewerInstance && tileSource && currentWSIInfo && tileAuthToken) {
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
            tileAuthToken,
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
    tileAuthToken,
  ]);

  const initViewer = useCallback(async () => {
    if (!currentInstanceId || !tileAuthToken) {
      console.warn("Cannot initialize viewer: instanceId or auth token is not available");
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
      tileAuthToken,
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
    tileAuthToken,
  ]);

  useEffect(() => {
    if (currentInstanceId && tileAuthToken) {
      console.log("InstanceId available, initializing viewer...");
      initViewer();
    } else {
      console.log(
        "InstanceId not available yet, skipping viewer initialization",
      );
    }
  }, [initViewer, currentInstanceId, tileAuthToken]);

  // Initialize gestures hook
  useOpenSeadragonGestures({
    viewerRef,
    annotatorInstance,
    zoomSpeed,
    trackpadGesture,
    setImageBounds,
    setImageRotation,
    setMagnification,
  });

  // Lasso bypasses Annotorious drawing, so Annotorious never calls
  // setMouseNavEnabled(false). Sync here (parent layout effect runs after
  // Annotorious's drawingEnabled effect) so rectangle→lasso cannot re-enable pan.
  useLayoutEffect(() => {
    if (!viewerInstance) return;
    if (currentTool === "lasso" && isThisInstanceActive) {
      viewerInstance.setMouseNavEnabled(false);
      return () => {
        viewerInstance.setMouseNavEnabled(true);
      };
    }
  }, [currentTool, viewerInstance, isThisInstanceActive]);

  useEffect(() => {
    if (tileSource && tileAuthToken) {
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
        ajaxHeaders: {
          Authorization: `Bearer ${tileAuthToken}`,
          Accept: "image/jpeg,image/png,image/*,*/*",
        },
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
  }, [tileSource, visibleChannels, getTileUrl, currentInstanceId, tileAuthToken]);

  // tool
  const handleToolbarClick = useCallback((tool: string | undefined) => {
    if (tool === undefined) {
      dispatch(setTool('move'));
      return;
    }
    if (tool === 'move' || tool === 'polygon' || tool === 'rectangle' || tool === 'lasso' || tool === 'line' || tool === 'filter') {
      dispatch(setTool(tool));
    }
  }, [dispatch]);

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
        // Let the tiled image do the conversion. Viewport coordinates are
        // normalised by image *width* on both axes, so dividing y by the
        // height put the region a slide-height's worth of aspect ratio off,
        // and the manual form also ignored where the image sits in the world.
        const rect = tiledImage.imageToViewportRectangle(
          bbox.x,
          bbox.y,
          bbox.width,
          bbox.height,
        );
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

  const setPathRetryCountRef = useRef(0);


  // Use WebSocket message handler hook
  useWebSocketMessageHandler({
    socket,
    viewerInstance,
    currentPath,
    showBackendAnnotationsRef,
    showPatchesRef,
    filterToolRef,
    setCentroids,
    setRenderingAnnotations,
    setPatches,
    setExistAnnotationFile,
    setPendingRequest,
    onBindAcked: binding.ack,
    onBindFailed: binding.fail,
    onHandlerReady: rebuildOverlayForHandler,
    refreshPatchClassificationData,
    handleLoadClassification,
    settleOverlay: settleOverlayWithArmedDrops,
    faultOverlay,
    takeAbandonedCellReply,
    isPatchesFlying,
    expectsWireFrame,
    hasherRef,
    lastHashRef,
    annotationsCounter,
    existAnnotationFile,
    isZarrInitializing,
    pendingRequest,
    lastSentPathRef,
    pathReadyForDataRef,
    instanceId,
  });

  useEffect(() => {
    // Bind this viewer session's own path (even when inactive) so handlers stay
    // aligned with instanceFilePath rather than the global active path.
    if (currentPath && socket && status === WebSocket.OPEN) {
      // Only send set_path if the path has actually changed
      if (lastSentPathRef.current !== currentPath) {
        console.log("Sending file path to WebSocket:", currentPath);
        lastHashRef.current = null;
        if (socket && socket.readyState === WebSocket.OPEN) {
          if (!instanceId) {
            console.warn("[WebSocket] Missing instanceId; skipping set_path");
            return;
          }
          setPathRetryCountRef.current = 0;
          socket.send(
            JSON.stringify({
              type: "set_path",
              path: currentPath,
              instance_id: instanceId,
            }),
          );
          // Records the path, arms the no-ack deadline and shuts the wire gate.
          binding.bind(currentPath);
        }
      }
    }
    // Do not depend on `allTilesLoaded` or `showBackendAnnotations`: they change during pan/zoom
    // or UI toggles and would re-run this effect constantly while spamming "path unchanged" logs.
  }, [currentPath, socket, status, instanceId, forceOverlaySync, resetOverlay, clearAbandonedCellReplies]);

  // A dropped socket un-binds this viewer: the backend handler is no longer
  // reachable, so go back to `idle` (gate shut) until the rebind below acks.
  useEffect(() => {
    if (!socket || status !== WebSocket.OPEN) {
      binding.release();
    }
  }, [socket, status, binding]);

  // After WS reconnect the socket object changes but path is unchanged — lastSentPathRef
  // would skip set_path. Force a rebind so a swept/restarted backend handler is restored.
  const lastBoundSocketRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    if (!socket || status !== WebSocket.OPEN || !currentPath || !instanceId) {
      return;
    }
    if (lastBoundSocketRef.current === socket) {
      return;
    }
    const isReconnect = lastBoundSocketRef.current != null;
    lastBoundSocketRef.current = socket;
    if (!isReconnect) {
      return;
    }
    console.log("[WebSocket] Socket reconnected — rebinding set_path:", currentPath);

    clearViewportOverlayCaches(instanceId);
    // Still the same slide — keep the last frame up across the reconnect.
    resetOverlay({ keepPaint: true });
    clearAbandonedCellReplies();
    setPendingRequest(EMPTY_OVERLAY_PENDING);
    setPathRetryCountRef.current = 0;

    socket.send(
      JSON.stringify({
        type: "set_path",
        path: currentPath,
        instance_id: instanceId,
      }),
    );
    binding.bind(currentPath);
  }, [
    socket,
    status,
    currentPath,
    instanceId,
    showBackendAnnotations,
    forceOverlaySync,
    resetOverlay,
    clearAbandonedCellReplies,
  ]);

  // Keyboard shortcuts handling
  useKeyboardHandlers({
    socket,
    pendingRequest,
    setShowBackendAnnotations,
    setShowPatches,
    setShowMask: handleSetShowMask,
    setPendingRequest,
    keydownUpdate,
    keydownUpdatePatches,
    showBackendAnnotationsRef,
    showPatchesRef,
  });

  // Viewport refresh handling
  useViewportRefresh({
    socket,
    currentPath,
    instanceId,
    isActive: isThisInstanceActive,
    setPendingRequest,
    lastHashRef,
    lastSentPathRef,
    bindPath: binding.bind,
    rebuildOverlay: rebuildOverlayForHandler,
    requestPatches,
    refreshPatchClassificationData,
    pathReadyForDataRef,
    forceOverlaySync,
    resetOverlay,
    clearAbandonedCellReplies,
    // `failed` counts as bound: usePathBinding opens the gate there on purpose.
    isPathBound: binding.phase === "bound" || binding.phase === "failed",
  });

  // hide/show backEnd annotations
  useEffect(() => {
    if (annotatorInstance) {
      annotatorInstance.setFilter((annotation: { isBackend: any }) => {
        if (!showBackendAnnotations && annotation.isBackend) return false;
        return true;
      });
    }
  }, [annotatorInstance, showBackendAnnotations]);

  // File change handling — currentPath is already this instance's filePath.
  useFileChangeHandler({
    currentPath,
    instanceId,
    isActive: isThisInstanceActive,
    annotatorInstance,
    viewerInstance,
    setAllTilesLoaded,
    setExistAnnotationFile,
    releaseBinding: binding.release,
    lastHashRef,
    setPendingRequest,
  });

  // Persist Annotorious drawings live in User-Annotations/manual.json; hydrate when
  // the slide opens / switches / sidecar .zarr becomes available.
  useManualAnnotationHydration({
    currentPath,
    instanceId: currentInstanceId,
    isActive: isThisInstanceActive,
    annotatorInstance,
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
    authToken: tileAuthToken,
    getTileUrl,
    setAllTilesLoaded,
  });

  const isRequestingClassification = useSelector(
    (state: RootState) => state.annotations.isRequestingClassification,
  );

  useEffect(() => {
    // Global classification flag — only the focused pane may rewrite Redux /
    // Annotorious; an inactive empty pane would otherwise wipe the list.
    if (!isThisInstanceActive || !isRequestingClassification) return;

    const handleClassificationRequest = async () => {
      dispatch(setClassificationEnabled(true));

      // 1) Local clear only — backend no longer handles ``clear_annotations``;
      //    handlers are instance-scoped and refreshed via set_path / reload.
      // Keep freeform manuals (disk-backed); classification reset must not wipe them.
      // isManualAnnotation covers both properties.source and tracked ids
      // (Annotorious may drop source after REMOTE writes).
      if (annotatorInstance) {
        const keepManuals = (annotatorInstance.getAnnotations?.() || []).filter(
          (a: any) => a?.isBackend !== true && isManualAnnotation(a),
        );
        withManualPersistSuppressed(currentInstanceId, () => {
          annotatorInstance.setAnnotations(keepManuals, true);
        });
        dispatch(setAnnotations(keepManuals));
      }
      dispatch(clearPatchOverrides());
      // Blanking the cell overlay invalidates the contour paint record. If Cell
      // Overlay was already on, nothing else drops it (the overlayNeedKey reset
      // only fires when the toggle actually changes), and the next contour
      // cache-hit repaint would be skipped over the stale coverage box, leaving
      // the overlay empty. Instance-wide so no stale path can be passed.
      if (typeof instanceId === "string" && instanceId) {
        forgetContourPaint(instanceId);
      }
      setCentroids(EMPTY_CENTROIDS);
      setRenderingAnnotations([]);
      setShowBackendAnnotations(true);

      await handleLoadClassification({ dropStaleOverrides: true });
      dispatch(classificationRequestComplete());
    };

    handleClassificationRequest();
  }, [
    isThisInstanceActive,
    isRequestingClassification,
    annotatorInstance,
    currentPath,
    socket,
    dispatch,
    handleLoadClassification,
  ]);

  // Publish this pane's viewer to global AnnotatorContext only when focused.
  // Never releaseAllContexts here — dual viewer DrawingOverlays own their own
  // canvases via releaseContext(canvas.id) on unmount.
  useEffect(() => {
    if (!annotatorInstance?.viewer) return;
    const viewer = annotatorInstance.viewer;
    if (isThisInstanceActive) {
      setViewerInstance(viewer);
    }
    return () => {
      setViewerInstance((prev: any) => (prev === viewer ? null : prev));
    };
  }, [annotatorInstance, setViewerInstance, isThisInstanceActive]);

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
    currentPath,
    currentInstanceId,
    nucleiClasses,
    currentOrgan,
    slideInfo: { mpp: slideInfo?.mpp ?? undefined },
    handleToolbarClick,
    isWebMode,
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
        showBackendAnnotationsRef={showBackendAnnotationsRef}
        nucleiModeAvailable={nucleiModeAvailable}
        showPatches={showPatches}
        setShowPatches={setShowPatches}
        keydownUpdatePatches={keydownUpdatePatches}
        showPatchesRef={showPatchesRef}
        pendingRequest={pendingRequest}
        setPendingRequest={setPendingRequest}
        socket={socket}
        patchModeAvailable={patchModeAvailable}
        showMask={showMask}
        setShowMask={handleSetShowMask}
        maskModeAvailable={maskModeAvailable}
        maskOptions={maskOptions}
        selectedMaskKey={effectiveMaskKey}
        onSelectMaskKey={(key) => dispatch(setSelectedMaskKey(key))}
        onGoToRecommended={handleGoToRecommended}
        onlineUsers={onlineUsers}
      />

      {/* OpenSeadragon viewer */}
      {/*@ts-ignore*/}
      <OpenSeadragonAnnotator
        autoSave
        drawingEnabled={dynamicDrawingEnabled}
        tool={currentTool === 'move' || currentTool === 'lasso' ? undefined : currentTool === 'filter' ? 'rectangle' : currentTool}
        userSelectAction={
          isThisInstanceActive
            ? UserSelectAction.EDIT
            : UserSelectAction.NONE
        }
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
          {viewerInstance && showNavigator && tileAuthToken && (
            <OSDNavigator navigatorSizeRatio={0.2} autoHideDelay={1000} authToken={tileAuthToken} />
          )}

          {/*
            Mounted for the whole session, hidden by emptying its data rather
            than by unmounting. Unmounting tore down the WebGL context
            (WEBGL_lose_context) and remounting recompiled and re-linked the
            shaders — and because the nuclei toggle is a keydown, React ran all
            of that synchronously inside the event handler (~450ms per press).
            With no data the overlay clears its canvas and its redraw returns
            immediately, so an idle overlay costs one GL context and nothing else.
          */}
          {overlayHostRef.current &&
            ReactDOM.createPortal(
              <DrawingOverlay
                viewer={viewerInstance}
                centroids={cellOverlayVisible ? paintCentroids : EMPTY_CENTROIDS}
                annotations={cellOverlayVisible ? paintAnnotations : EMPTY_ANNOTATIONS}
                nucleiClasses={nucleiClasses}
                filterOnlyHighlight={!showBackendAnnotations && currentTool === "filter" && (filterHighlightIndices?.length ?? 0) > 0}
              />,
              overlayHostRef.current,
            )}

          {showPatches &&
            overlayHostRef.current &&
            ReactDOM.createPortal(
              <PatchOverlay viewer={viewerInstance} patches={paintPatches} />,
              overlayHostRef.current,
            )}

          {viewerInstance &&
            overlayHostRef.current &&
            ReactDOM.createPortal(
              <LassoOverlay
                viewer={viewerInstance}
                annotator={annotatorInstance}
                isActiveInstance={isThisInstanceActive}
              />,
              overlayHostRef.current,
            )}

          {showMask &&
            overlayHostRef.current &&
            ReactDOM.createPortal(
              <MaskOverlay
                viewer={viewerInstance}
                currentPath={currentPath}
                selectedMaskKey={effectiveMaskKey}
                onLoadingChange={setLoadingMask}
                isActiveInstance={isThisInstanceActive}
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
              onSave={(explicit?: boolean) => {
                try {
                  // Popup already REMOTE-updates style/comment on the live shape.
                  const annotation = annotatorInstance.getAnnotationById(
                    props.annotation.id,
                  );
                  // Gone (keyboard Delete / already removed) — do not resurrect.
                  if (!annotation) return true;
                  // Create/lasso stamp source=manual on draw. Ephemeral shapes
                  // (Filter ROI, etc.) stay unstamped and must not be archived.
                  if (!isManualAnnotation(annotation)) return true;
                  // The footer Save button is the ONLY click that puts a drawing
                  // in Zarr. Annotating / marking / plain deselect just flushes
                  // edits of drawings that are already stored there.
                  if (explicit) {
                    approveManualPersist(annotation.id);
                  } else if (!isManualPersistApproved(annotation.id)) {
                    return true;
                  }

                  if (!extractManualPayload(annotation)) {
                    console.warn('[manual] skip save: missing geometry', props.annotation?.id);
                    return true;
                  }
                  const zarrPath = toManualZarrPath(currentPath);
                  if (!zarrPath || !currentInstanceId) {
                    console.warn('[manual] skip save: missing session or path');
                    return true;
                  }

                  const stamped = persistManualDrawing({
                    annotator: annotatorInstance,
                    annotation,
                    instanceId: currentInstanceId,
                    zarrPath,
                    requireExisting: true,
                  });
                  // null: suppressed wipe / deleted mid-flush — allow retry.
                  if (!stamped) return false;

                  const merged = (annotatorInstance.getAnnotations?.() || []).filter(
                    (a: any) => !a?.isBackend,
                  );
                  dispatch(setAnnotations(merged));
                  return true;
                } catch (error) {
                  // Background sync toasts on HTTP failure; deselect must stay quiet.
                  console.error("Error saving annotation:", error);
                  return false;
                } finally {
                  dispatch(resetShapeData());
                }
              }}
              onCancel={() => {
                try {
                  // Prefer live Annotorious state — popup props can be stale
                  // (e.g. after Footer Save marked source=manual).
                  const live = props?.annotation?.id
                    ? annotatorInstance.getAnnotationById(props.annotation.id)
                    : null;
                  const isBackend =
                    live?.isBackend === true ||
                    props?.annotation?.isBackend === true;
                  // Mark/dismiss: drop Filter ROI / unstamped drafts; keep manuals
                  // (incl. view-only stamps). removeAnnotation also triggers Zarr delete.
                  const shouldDrop =
                    !isBackend &&
                    !!live?.id &&
                    (isFilterEphemeral(live) ||
                      (!isManualAnnotation(live) &&
                        !isWriteBlockedPath(currentPath ?? undefined)));
                  if (shouldDrop) {
                    annotatorInstance.removeAnnotation(live.id);
                  }
                } catch {}
                annotatorInstance.cancelSelected();
                dispatch(resetShapeData());
              }}
              onDelete={() => {
                try {
                  const live = props?.annotation?.id
                    ? annotatorInstance.getAnnotationById(props.annotation.id)
                    : null;
                  const isBackend =
                    live?.isBackend === true ||
                    props?.annotation?.isBackend === true;
                  if (!isBackend && (live?.id || props.annotation?.id)) {
                    // Canvas remove always. Disk delete is skipped on Viewer/Samples
                    // inside enqueueManualDelete.
                    annotatorInstance.removeAnnotation(
                      live?.id || props.annotation.id,
                    );
                  }
                } catch {}
                annotatorInstance.cancelSelected();
                dispatch(resetShapeData());
              }}
              annotatorInstance={annotatorInstance}
              instanceId={currentInstanceId}
              patches={paintPatches}
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
          className="z-50 absolute inset-0 flex items-center justify-center bg-black/50"
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
