import React, { useRef, useEffect, useCallback, useState } from "react";
import OpenSeadragon from "openseadragon";
import { useSelector } from "react-redux";
import { mat2d } from "gl-matrix";
import { RootState } from "@/store";
import { loadSegmentationMask } from "@/services/data.service";


interface MaskOverlayProps {
  viewer: OpenSeadragon.Viewer | null;
  currentPath: string | null;
  selectedMaskKey?: string | null;
  onLoadingChange?: (loading: boolean) => void;
}

const MaskOverlay: React.FC<MaskOverlayProps> = ({
  viewer,
  currentPath,
  selectedMaskKey,
  onLoadingChange
}) => {
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const requestIdRef = useRef(0);
  const [maskData, setMaskData] = useState<{
    data: Uint8Array;
    shape: [number, number];
    offset: [number, number];
    requestedOffset?: [number, number]; // Original requested coordinates (may be negative)
    requestedSize?: [number, number]; // Original requested viewport size (RAW coordinates)
    regionSize?: [number, number]; // Actual region size from backend (RAW coordinates, before downsampling)
    tissue_class?: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const overlayAlpha = useSelector((state: RootState) => state.viewerSettings.overlayAlpha) ?? 0.4;
  const [hoveredPosition, setHoveredPosition] = useState<{ x: number; y: number } | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const hideTooltip = useCallback(() => setShowTooltip(false), []);

  /**
   * Load mask data for current viewport
   */
  const loadMaskForViewport = useCallback(async () => {
    if (!viewer || !currentPath) {
      return;
    }

    const tiledImageInstance = viewer.world.getItemAt(0);
    if (!tiledImageInstance) {
      return;
    }

    try {
      const requestId = ++requestIdRef.current;
      setIsLoading(true);
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
      const viewerElement = viewer.element;
      const viewerRect = viewerElement.getBoundingClientRect();
      const canvasWidth = Math.round(viewerRect.width);
      const canvasHeight = Math.round(viewerRect.height);
      
      // Pass canvas dimensions - backend will maintain aspect ratio
      const result = await loadSegmentationMask(x1, y1, x2, y2, currentPath, canvasWidth, canvasHeight, selectedMaskKey ?? undefined);

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
      setIsLoading(false);
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

      canvas.width = viewerCanvas.clientWidth;
      canvas.height = viewerCanvas.clientHeight;
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

      const imageData = ctx.createImageData(maskWidth, maskHeight);
      const data = imageData.data;
      const pixelCount = Math.min(maskData.data.length, maskWidth * maskHeight);

      for (let i = 0; i < pixelCount; i++) {
        const maskValue = maskData.data[i];
        const idx = i * 4;
        data[idx] = 56;
        data[idx + 1] = 255;
        data[idx + 2] = 132;
        data[idx + 3] = maskValue > 0 ? Math.round(255 * overlayAlpha) : 0;
      }

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = maskWidth;
      tempCanvas.height = maskHeight;
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) {
        return;
      }

      tempCtx.putImageData(imageData, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tempCanvas, maskImageX, maskImageY, maskImageWidth, maskImageHeight);
    } catch (error) {
      console.error('[MaskOverlay] Failed to render mask overlay:', error);
      setMaskData(null);
      setShowTooltip(false);
      onLoadingChange?.(false);
    }
  }, [viewer, maskData, overlayAlpha]);

  // Update overlay immediately when viewport changes (for real-time following)
  // This ensures the overlay follows viewport movement smoothly, even before new mask data loads
  useEffect(() => {
    if (!viewer) return;
    
    viewer.addHandler("update-viewport", updateOverlay);
    
    return () => {
      viewer.removeHandler("update-viewport", updateOverlay);
    };
  }, [viewer, updateOverlay]);

  // Load mask when component mounts, path/mask selection changes, or viewport changes
  useEffect(() => {
    if (!viewer || !currentPath) {
      setIsLoading(false);
      onLoadingChange?.(false);
      setMaskData(null);
      return;
    }
    setIsLoading(true);
    onLoadingChange?.(true);
    loadMaskForViewport();
  }, [viewer, currentPath, selectedMaskKey, loadMaskForViewport, onLoadingChange]);
  
  // Reload mask when viewport changes (with debouncing to avoid too many requests)
  useEffect(() => {
    if (!viewer || !currentPath) return;
    
    let timeoutId: NodeJS.Timeout;
    const handleViewportChange = () => {
      // Debounce viewport changes to avoid too many requests
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setIsLoading(true);
        onLoadingChange?.(true);
        loadMaskForViewport();
      }, 300); // 300ms debounce
    };
    
    viewer.addHandler("update-viewport", handleViewportChange);
    
    return () => {
      clearTimeout(timeoutId);
      viewer.removeHandler("update-viewport", handleViewportChange);
    };
  }, [viewer, currentPath, selectedMaskKey, loadMaskForViewport, onLoadingChange]);

  // Update overlay when mask data changes
  useEffect(() => {
    if (!viewer) return;
    updateOverlay();
  }, [viewer, maskData, updateOverlay]);

  // Handle mouse move to detect hover over mask regions
  const handleMouseMove = useCallback((event: MouseEvent) => {
    if (!viewer || !maskData || !maskData.tissue_class || !overlayRef.current) {
      setShowTooltip(false);
      return;
    }

    const canvas = overlayRef.current;
    const rect = canvas.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;

    // Get the pixel value at mouse position from canvas
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Get image data at mouse position (using canvas coordinates)
    // Note: The canvas has the same size as the viewer, so coordinates should match
    const sampleX = Math.floor(canvasX);
    const sampleY = Math.floor(canvasY);
    if (
      sampleX < 0 ||
      sampleY < 0 ||
      sampleX >= canvas.width ||
      sampleY >= canvas.height
    ) {
      setShowTooltip(false);
      return;
    }

    let imageData: ImageData;
    try {
      imageData = ctx.getImageData(sampleX, sampleY, 1, 1);
    } catch (error) {
      console.error('[MaskOverlay] Failed to sample mask pixel:', error);
      setShowTooltip(false);
      return;
    }
    const alpha = imageData.data[3]; // Alpha channel

    // Check if mouse is over a mask pixel (alpha > 0)
    if (alpha > 0) {
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

export default MaskOverlay;
