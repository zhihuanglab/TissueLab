import React, { useRef, useEffect, useLayoutEffect, useCallback, useState } from "react";
import OpenSeadragon from "openseadragon";
import { useSelector } from "react-redux";
import { mat2d } from "gl-matrix";
import { RootState } from "@/store";
import { loadSegmentationMask } from "@/services/data.service";
import eventBus from "@/utils/common/eventBus";
import { workflowZarrPathsMatch } from "@/utils/agent/workflow/pathNorm";
import { selectPatchClassificationData } from "@/store/slices/viewer/annotationSlice";
import {
  fillMaskRgba,
  findTissueColorIndex,
  isMaskSetAtImagePoint,
  hexToRgb,
  maskBitmapKeyEquals,
  type MaskBitmapKey,
} from "@/utils/viewer/maskBitmap";


interface MaskOverlayProps {
  viewer: OpenSeadragon.Viewer | null;
  currentPath: string | null;
  selectedMaskKey?: string | null;
  onLoadingChange?: (loading: boolean) => void;
  /** Payload-less run events only refresh the viewer the run was aimed at. */
  isActiveInstance?: boolean;
}

const MaskOverlay: React.FC<MaskOverlayProps> = ({
  viewer,
  currentPath,
  selectedMaskKey,
  onLoadingChange,
  isActiveInstance = true,
}) => {
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const requestIdRef = useRef(0);
  /** A forceReload path refresh is in flight — re-read once its handler lands. */
  const awaitingHandlerReloadRef = useRef(false);
  // Rasterised mask, reused until the mask / colour / alpha actually change.
  const bitmapRef = useRef<{ key: MaskBitmapKey; canvas: HTMLCanvasElement } | null>(null);
  const [maskData, setMaskData] = useState<{
    data: Uint8Array;
    shape: [number, number];
    offset: [number, number];
    requestedOffset?: [number, number]; // Original requested coordinates (may be negative)
    requestedSize?: [number, number]; // Original requested viewport size (RAW coordinates)
    regionSize?: [number, number]; // Actual region size from backend (RAW coordinates, before downsampling)
    tissue_class?: string;
  } | null>(null);
  const overlayAlpha = useSelector((state: RootState) => state.viewerSettings.overlayAlpha) ?? 0.4;
  // Same color map the patch overlay uses (single source of truth) — VISTA colors its
  // tissue masks by looking up the tissue name here, so it always matches the patch colors.
  const reduxPatchClassificationData = useSelector(selectPatchClassificationData);
  const [hoveredPosition, setHoveredPosition] = useState<{ x: number; y: number } | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const hideTooltip = useCallback(() => setShowTooltip(false), []);

  /**
   * Load mask data for current viewport
   */
  const loadMaskForViewport = useCallback(async () => {
    // These bail-outs sit outside the try/finally below, so they own the spinner
    // themselves — a caller that switched it on before calling would otherwise
    // leave "loading mask" up forever when the viewer has no tiled image yet.
    if (!viewer || !currentPath) {
      onLoadingChange?.(false);
      return;
    }

    const tiledImageInstance = viewer.world.getItemAt(0);
    if (!tiledImageInstance) {
      onLoadingChange?.(false);
      return;
    }

    try {
      const requestId = ++requestIdRef.current;
      onLoadingChange?.(true);
      
      // Get viewport bounds in image coordinates
      const viewportBounds = viewer.viewport.getBounds();
      const topLeft = tiledImageInstance.viewportToImageCoordinates(viewportBounds.getTopLeft());
      const bottomRight = tiledImageInstance.viewportToImageCoordinates(viewportBounds.getBottomRight());
      
      // Store original coordinates (may be negative for zoom out)
      const originalX1 = Math.round(topLeft.x);
      const originalY1 = Math.round(topLeft.y);
      const originalX2 = Math.round(bottomRight.x);
      const originalY2 = Math.round(bottomRight.y);
      
      // Clip to non-negative for backend request (backend will clip anyway)
      // But we need to track the original coordinates for correct positioning
      const x1 = Math.max(0, originalX1);
      const y1 = Math.max(0, originalY1);
      const x2 = Math.max(0, originalX2);
      const y2 = Math.max(0, originalY2);
      
      // Store original coordinates for later use in rendering
      const requestedOffsetX = originalX1;
      const requestedOffsetY = originalY1;

      // Get canvas/viewer size for downsampling
      const viewerElement = viewer?.element;
      if (!viewerElement) return;
      const viewerRect = viewerElement.getBoundingClientRect();
      const canvasWidth = Math.round(viewerRect.width);
      const canvasHeight = Math.round(viewerRect.height);
      
      // Path-only mask API — no instance handler required.
      const result = await loadSegmentationMask(
        x1, y1, x2, y2, currentPath, canvasWidth, canvasHeight,
        selectedMaskKey ?? undefined,
      );

      if (requestId !== requestIdRef.current) {
        return;
      }
      
      if (result.success && result.data && result.shape && result.offset) {
        setMaskData({
          data: result.data,
          shape: result.shape,
          offset: result.offset,
          requestedOffset: [requestedOffsetX, requestedOffsetY], // Store original requested coordinates
          requestedSize: [x2 - x1, y2 - y1], // Store original requested viewport size (RAW coordinates)
          regionSize: (result as any).region_size as [number, number] | undefined, // Store actual region size from backend
          tissue_class: result.tissue_class
        });
      } else {
        setMaskData(null);
      }
    } catch (error) {
      console.error('[MaskOverlay] Failed to load mask for viewport:', error);
      setMaskData(null);
    } finally {
      onLoadingChange?.(false);
    }
  }, [viewer, currentPath, selectedMaskKey]);

  /**
   * Updates the overlay by resizing the canvas and drawing mask
   */
  const updateOverlay = useCallback(() => {
    try {
      const canvas = overlayRef.current;
      if (!canvas || !viewer) {
        return;
      }

      const viewerCanvas = viewer.canvas;
      if (!viewerCanvas) {
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      // Resize only on a real size change — assigning width/height drops the
      // backing store, and this runs inside OSD's rAF every frame. The
      // clearRect below blanks the canvas either way.
      const width = viewerCanvas.clientWidth;
      const height = viewerCanvas.clientHeight;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (!maskData) {
        return;
      }

      const tiledImageInstance = viewer.world.getItemAt(0);
      if (!tiledImageInstance) {
        return;
      }

      const dimX = tiledImageInstance.source?.dimensions?.x;
      const dimY = tiledImageInstance.source?.dimensions?.y;
      if (!dimX || !dimY) {
        return;
      }

      const [maskHeight, maskWidth] = maskData.shape;
      if (!Number.isFinite(maskHeight) || !Number.isFinite(maskWidth) || maskHeight <= 0 || maskWidth <= 0) {
        return;
      }

      if (!maskData.data || maskData.data.length === 0) {
        return;
      }

      const contentAspectX = dimX / dimY;
      const boundsNoRotate =
        typeof viewer.viewport.getBoundsNoRotate === "function"
          ? viewer.viewport.getBoundsNoRotate(true)
          : viewer.viewport.getBounds(true);
      const containerInnerSize = viewer.viewport.getContainerSize();
      const margins =
        typeof viewer.viewport.getMargins === "function"
          ? viewer.viewport.getMargins()
          : { left: 0, top: 0 };
      const marginLeft = (margins as any)?.left ?? 0;
      const marginTop = (margins as any)?.top ?? 0;
      const boundsTopLeft = boundsNoRotate.getTopLeft();
      const pixelFromPointRatio = containerInnerSize.x / boundsNoRotate.width;

      if (!Number.isFinite(pixelFromPointRatio) || pixelFromPointRatio <= 0) {
        return;
      }

      const imageToViewportMat = mat2d.create();
      mat2d.scale(imageToViewportMat, imageToViewportMat, [
        1 / dimX,
        1 / dimY / contentAspectX
      ]);

      const rotationMat = mat2d.create();
      const center = viewer.viewport.getCenter(true);
      // @ts-ignore - getRotation supports current parameter but types may be incomplete
      const rotationDegree = viewer.viewport.getRotation(true);
      if (rotationDegree !== 0) {
        mat2d.translate(rotationMat, rotationMat, [center.x, center.y]);
        mat2d.rotate(rotationMat, rotationMat, (rotationDegree * Math.PI) / 180);
        mat2d.translate(rotationMat, rotationMat, [-center.x, -center.y]);
      }

      const viewportToViewerMat = mat2d.create();
      mat2d.scale(viewportToViewerMat, viewportToViewerMat, [pixelFromPointRatio, pixelFromPointRatio]);
      mat2d.translate(viewportToViewerMat, viewportToViewerMat, [-boundsTopLeft.x, -boundsTopLeft.y]);
      mat2d.translate(viewportToViewerMat, viewportToViewerMat, [marginLeft, marginTop]);

      const imageToViewerMat = mat2d.create();
      mat2d.multiply(imageToViewerMat, viewportToViewerMat, rotationMat);
      mat2d.multiply(imageToViewerMat, imageToViewerMat, imageToViewportMat);

      const flipped = (viewer.viewport.getFlip && viewer.viewport.getFlip()) || false;
      let a = imageToViewerMat[0], b = imageToViewerMat[1], c = imageToViewerMat[2], d = imageToViewerMat[3], e = imageToViewerMat[4], f = imageToViewerMat[5];
      if (flipped) {
        a = -a;
        c = -c;
        e = canvas.width - e;
      }

      ctx.setTransform(a, b, c, d, e, f);

      const [offsetX, offsetY] = maskData.offset;
      const maskImageX = offsetX;
      const maskImageY = offsetY;

      let maskImageWidth: number;
      let maskImageHeight: number;

      if (maskData.regionSize) {
        const [regionWidth, regionHeight] = maskData.regionSize;
        maskImageWidth = regionWidth;
        maskImageHeight = regionHeight;
      } else if (maskData.requestedSize) {
        const [requestedWidth, requestedHeight] = maskData.requestedSize;
        const downscaleX = requestedWidth / maskWidth;
        const downscaleY = requestedHeight / maskHeight;
        maskImageWidth = maskWidth * downscaleX;
        maskImageHeight = maskHeight * downscaleY;
      } else {
        maskImageWidth = maskWidth;
        maskImageHeight = maskHeight;
      }

      if (!Number.isFinite(maskImageWidth) || !Number.isFinite(maskImageHeight) || maskImageWidth <= 0 || maskImageHeight <= 0) {
        return;
      }

      // Color this tissue by looking up its name in the patch classification color map
      // (reduxPatchClassificationData) — the SAME source the patch overlay uses, so the
      // two always match. No silent fallback: surface a missing color instead of hiding it.
      const classNames = reduxPatchClassificationData?.class_name ?? [];
      const classColors = reduxPatchClassificationData?.class_hex_color ?? [];
      const ci = findTissueColorIndex(classNames, maskData.tissue_class);
      const rgb = ci >= 0 ? hexToRgb(classColors[ci]) : null;
      if (!rgb) {
        console.error(
          `[MaskOverlay] No color for tissue ${JSON.stringify(maskData.tissue_class)} in the patch ` +
          `classification color map ${JSON.stringify(classNames)} — not rendering this overlay.`
        );
        return;
      }

      // Rasterise only when the mask, its colour or the alpha changed. This ran
      // per pixel on every viewport frame *and* on every parent re-render (the
      // viewer sets mousePos on every mouse move), for an unchanged mask.
      const key: MaskBitmapKey = {
        data: maskData.data,
        width: maskWidth,
        height: maskHeight,
        r: rgb[0],
        g: rgb[1],
        b: rgb[2],
        alpha: overlayAlpha,
      };

      let bitmap = bitmapRef.current;
      if (!bitmap || !maskBitmapKeyEquals(bitmap.key, key)) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = maskWidth;
        tempCanvas.height = maskHeight;
        const tempCtx = tempCanvas.getContext('2d');
        if (!tempCtx) {
          return;
        }
        const imageData = tempCtx.createImageData(maskWidth, maskHeight);
        fillMaskRgba(imageData.data, maskData.data, maskWidth, maskHeight, rgb, overlayAlpha);
        tempCtx.putImageData(imageData, 0, 0);
        bitmap = { key, canvas: tempCanvas };
        bitmapRef.current = bitmap;
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap.canvas, maskImageX, maskImageY, maskImageWidth, maskImageHeight);
    } catch (error) {
      console.error('[MaskOverlay] Failed to render mask overlay:', error);
      setMaskData(null);
      setShowTooltip(false);
      onLoadingChange?.(false);
    }
  }, [viewer, maskData, overlayAlpha, reduxPatchClassificationData]);

  useLayoutEffect(() => {
    if (!viewer) return;
    viewer.addHandler("update-viewport", updateOverlay);
    updateOverlay();
    return () => {
      viewer.removeHandler("update-viewport", updateOverlay);
    };
  }, [viewer, updateOverlay]);

  // Path / mask-key switch: drop React state before paint. The layout above
  // then redraws with maskData=null. Invalidate in-flight loads here.
  useLayoutEffect(() => {
    requestIdRef.current += 1;
    setMaskData((prev) => (prev === null ? prev : null));
  }, [currentPath, selectedMaskKey]);

  // Load mask when component mounts, path/mask selection changes, or viewport changes
  useEffect(() => {
    if (!viewer || !currentPath) {
      onLoadingChange?.(false);
      setMaskData(null);
      return;
    }
    loadMaskForViewport();
  }, [viewer, currentPath, selectedMaskKey, loadMaskForViewport, onLoadingChange]);
  
  // A run can rewrite the mask for the same slide and the same mask key, and
  // neither of those props changes — so nothing above re-fetches and the Tissue
  // Overlay keeps painting the pre-run mask until the user happens to pan or
  // zoom. Re-load on the same events the container uses to re-read the mask
  // option list.
  useEffect(() => {
    if (!viewer || !currentPath) return;

    // loadMaskForViewport owns the spinner on every exit path, so callers never
    // switch it on themselves.
    const reload = () => {
      void loadMaskForViewport();
    };

    // `workflow-graph-run-finished` and `refresh-patches` carry no path, so they
    // cannot say which slide changed. Restrict them to the active viewer — the
    // same guard the container's own run-finished handler uses — instead of
    // making every open viewer refetch its mask for someone else's run.
    const onUnaddressedRefresh = () => {
      if (!isActiveInstance) return;
      reload();
    };

    // This one does carry a path, so any viewer holding that slide may refresh.
    const onPathRefresh = (payload?: {
      path?: string;
      forceReload?: boolean;
      skipViewportRefresh?: boolean;
    }) => {
      // Bookkeeping-only refreshes (per-annotation count sync) never touch the
      // mask — reloading on those would refetch it on every single click.
      if (payload?.skipViewportRefresh) return;
      if (payload?.path && !workflowZarrPathsMatch(payload.path, currentPath)) {
        return;
      }
      // This fires as the reload *starts*: the backend handler is still serving
      // the pre-run zarr, so what comes back can be the old mask. Remember that
      // a reload is under way and re-read once it has actually landed.
      if (payload?.forceReload) awaitingHandlerReloadRef.current = true;
      reload();
    };

    // The reload has landed — this is the first moment the backend answers from
    // the rewritten zarr. Without it a run that changes the mask in place leaves
    // whatever the early refresh above happened to catch on screen until the
    // user pans.
    const onHandlerReloadComplete = (payload?: { path?: string }) => {
      if (!awaitingHandlerReloadRef.current) return;
      if (payload?.path && !workflowZarrPathsMatch(payload.path, currentPath)) {
        return;
      }
      awaitingHandlerReloadRef.current = false;
      reload();
    };

    eventBus.on("workflow-graph-run-finished", onUnaddressedRefresh);
    eventBus.on("refresh-patches", onUnaddressedRefresh);
    eventBus.on("refresh-websocket-path", onPathRefresh);
    eventBus.on("handler-reload-complete", onHandlerReloadComplete);
    return () => {
      eventBus.off("workflow-graph-run-finished", onUnaddressedRefresh);
      eventBus.off("refresh-patches", onUnaddressedRefresh);
      eventBus.off("refresh-websocket-path", onPathRefresh);
      eventBus.off("handler-reload-complete", onHandlerReloadComplete);
    };
  }, [viewer, currentPath, loadMaskForViewport, isActiveInstance]);

  // Reload mask when viewport changes (with debouncing to avoid too many requests)
  useEffect(() => {
    if (!viewer || !currentPath) return;
    
    let timeoutId: NodeJS.Timeout;
    const handleViewportChange = () => {
      // Debounce viewport changes to avoid too many requests
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        loadMaskForViewport();
      }, 300); // 300ms debounce
    };
    
    viewer.addHandler("update-viewport", handleViewportChange);
    
    return () => {
      clearTimeout(timeoutId);
      viewer.removeHandler("update-viewport", handleViewportChange);
    };
  }, [viewer, currentPath, selectedMaskKey, loadMaskForViewport, onLoadingChange]);

  // Handle mouse move to detect hover over mask regions
  const handleMouseMove = useCallback((event: MouseEvent) => {
    if (!viewer || !maskData || !maskData.tissue_class || !overlayRef.current) {
      setShowTooltip(false);
      return;
    }

    // Answer from the mask in memory, not by sampling the canvas. A 1x1
    // getImageData forces a GPU->CPU readback and a pipeline flush on every
    // mouse move; so does the getBoundingClientRect it needed for canvas
    // coordinates. OSD converts window coordinates for us.
    const tiledImage = viewer.world.getItemAt(0);
    if (!tiledImage) return;

    const imagePoint = tiledImage.viewportToImageCoordinates(
      viewer.viewport.windowToViewportCoordinates(
        new OpenSeadragon.Point(event.clientX, event.clientY),
      ),
    );

    const [maskHeight, maskWidth] = maskData.shape;
    const [offsetX, offsetY] = maskData.offset;
    // Same sizing rule the draw path uses, so hover and paint agree.
    const [spanX, spanY] =
      maskData.regionSize ?? maskData.requestedSize ?? [maskWidth, maskHeight];

    const inside = isMaskSetAtImagePoint({
      mask: maskData.data,
      width: maskWidth,
      height: maskHeight,
      offsetX,
      offsetY,
      spanX,
      spanY,
      imageX: imagePoint.x,
      imageY: imagePoint.y,
    });

    if (inside) {
      setHoveredPosition({ x: event.clientX, y: event.clientY });
      setShowTooltip(true);
    } else {
      setShowTooltip(false);
    }
  }, [viewer, maskData]);

  // Setup mouse move event listener
  useEffect(() => {
    if (!viewer || !maskData?.tissue_class) {
      setShowTooltip(false);
      return;
    }

    const viewerElement = viewer.element;
    viewerElement.addEventListener('mousemove', handleMouseMove);
    viewerElement.addEventListener('mouseleave', hideTooltip);

    return () => {
      viewerElement.removeEventListener('mousemove', handleMouseMove);
      viewerElement.removeEventListener('mouseleave', hideTooltip);
    };
  }, [viewer, maskData, handleMouseMove, hideTooltip]);

  return (
    <>
      <canvas
        ref={overlayRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none" // Ensures the canvas doesn't interfere with viewer interactions
        }}
      />
      {/* Tooltip for tissue_class */}
      {showTooltip && hoveredPosition && maskData?.tissue_class && (
        <div
          style={{
            position: "fixed",
            left: `${hoveredPosition.x + 10}px`,
            top: `${hoveredPosition.y - 30}px`,
            background: "rgba(0, 0, 0, 0.8)",
            color: "white",
            padding: "6px 12px",
            borderRadius: "4px",
            fontSize: "12px",
            fontFamily: "sans-serif",
            pointerEvents: "none",
            zIndex: 10000,
            whiteSpace: "nowrap",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.3)"
          }}
        >
          {maskData.tissue_class}
        </div>
      )}
    </>
  );
};

// The viewer container owns this overlay's props and also holds `mousePos`,
// which OSD updates on every mouse move — without memo each of those re-rendered
// the overlay and re-ran its draw effect. Its own Redux subscriptions still
// re-render it when the mask or the palette actually changes.
export default React.memo(MaskOverlay);
