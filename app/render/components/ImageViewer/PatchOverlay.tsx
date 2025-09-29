import React, { useRef, useEffect, useCallback } from "react";
import OpenSeadragon from "openseadragon";
import { useSelector } from "react-redux";
import { mat2d } from "gl-matrix";
import { RootState } from "@/store";
import { ShapeData, RectangleCoords } from "@/store/slices/shapeSlice";
// import { selectPatchClassificationData } from "@/store/slices/annotationSlice";

const ZOOM_SCALE = 16; // Keep in sync with DrawingOverlay / Annotorious selection scaling

const selectPatchClassificationData = (state: RootState) => null; // Placeholder

// Point-in-rectangle (ROI) using image-space coordinates
const isPointInRectangle = (x: number, y: number, rect: RectangleCoords | null): boolean => {
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
}

// Point-in-polygon (ROI) using image-space coordinates (ray casting)
const isPointInPolygon = (x: number, y: number, polygonPoints: [number, number][] | undefined): boolean => {
  if (!polygonPoints || polygonPoints.length < 3) return false;
  const pts = polygonPoints.map(p => [p[0] * ZOOM_SCALE, p[1] * ZOOM_SCALE] as [number, number]);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

interface DrawingOverlayProps {
  viewer: OpenSeadragon.Viewer | null;
  patches: Array<[number, number, number, string]>; // [idx, x, y, color]
  patchClassificationData?: {
    nuclei_class_id: number[];
    nuclei_class_name: string[];
    nuclei_class_HEX_color: string[];
  } | null;
}

const PatchOverlay: React.FC<DrawingOverlayProps> = ({
  viewer,
  patches,
  patchClassificationData
}) => {
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const annotationTypes = useSelector((state: RootState) => state.annotations.annotationTypeMap);
  const reduxPatchClassificationData = useSelector(selectPatchClassificationData);
  const shapeData = useSelector((state: RootState) => state.shape.shapeData);
  // const slideDimensions = useSelector((state: RootState) => state.svsPath.slideInfo.dimensions); // Access slide dimensions if needed for other calculations

  /**
   * Converts a HEX color string to an RGB array.
   * @param hex - The HEX color string (e.g., "#RRGGBB" or "#RGB").
   * @returns An array [R, G, B].
   */
  const hexToRgb = useCallback((hex: string): [number, number, number] => {
    // Remove prefix #
    const sanitizedHex = hex.replace(/^#/, '');
    // Convert 3-bit HEX to 6-bit HEX (e.g., "F0C" -> "FF00CC")
    const fullHex = sanitizedHex.length === 3
      ? sanitizedHex.split('').map(c => c + c).join('')
      : sanitizedHex;
    const bigint = parseInt(fullHex, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return [r, g, b];
  }, []);

  /**
   * Updates the overlay by resizing the canvas and redrawing patches.
   */
  const updateOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas || !viewer) return;

    // Get the viewer's canvas element to match its size
    const viewerCanvas = viewer.canvas;
    if (!viewerCanvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Resize canvas
    canvas.width = viewerCanvas.clientWidth;
    canvas.height = viewerCanvas.clientHeight;
    // Clear with identity transform before drawing
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // ----- Build image-to-viewer (pixel) transform including rotation & flip -----
    const tiledImageInstance = viewer.world.getItemAt(0);
    if (!tiledImageInstance) return;

    const dimX = tiledImageInstance.source.dimensions.x;
    const dimY = tiledImageInstance.source.dimensions.y;
    const contentAspectX = dimX / dimY;

    const boundsNoRotate = viewer.viewport.getBoundsNoRotate(true);
    const containerInnerSize = viewer.viewport.getContainerSize();
    const margins = viewer.viewport.getMargins();
    const marginLeft = (margins as any).left ?? 0;
    const marginTop = (margins as any).top ?? 0;
    const boundsTopLeft = boundsNoRotate.getTopLeft();
    const pixelFromPointRatio = containerInnerSize.x / boundsNoRotate.width;

    // image -> normalized viewport coords
    const imageToViewportMat = mat2d.create();
    mat2d.scale(imageToViewportMat, imageToViewportMat, [
      1 / dimX,
      1 / dimY / contentAspectX
    ]);

    // rotation about viewport center
    const rotationMat = mat2d.create();
    const center = viewer.viewport.getCenter(true);
    // @ts-ignore - getRotation supports current parameter but types may be incomplete
    const rotationDegree = viewer.viewport.getRotation(true);
    if (rotationDegree !== 0) {
      mat2d.translate(rotationMat, rotationMat, [center.x, center.y]);
      mat2d.rotate(rotationMat, rotationMat, (rotationDegree * Math.PI) / 180);
      mat2d.translate(rotationMat, rotationMat, [-center.x, -center.y]);
    }

    // viewport -> viewer pixels
    const viewportToViewerMat = mat2d.create();
    mat2d.scale(viewportToViewerMat, viewportToViewerMat, [pixelFromPointRatio, pixelFromPointRatio]);
    mat2d.translate(viewportToViewerMat, viewportToViewerMat, [-boundsTopLeft.x, -boundsTopLeft.y]);
    mat2d.translate(viewportToViewerMat, viewportToViewerMat, [marginLeft, marginTop]);

    // compose final transform
    const imageToViewerMat = mat2d.create();
    mat2d.multiply(imageToViewerMat, viewportToViewerMat, rotationMat);
    mat2d.multiply(imageToViewerMat, imageToViewerMat, imageToViewportMat);

    // Handle viewer flip (horizontal)
    const flipped = (viewer.viewport.getFlip && viewer.viewport.getFlip()) || false;
    let a = imageToViewerMat[0], b = imageToViewerMat[1], c = imageToViewerMat[2], d = imageToViewerMat[3], e = imageToViewerMat[4], f = imageToViewerMat[5];
    if (flipped) {
      a = -a;
      c = -c;
      e = canvas.width - e;
    }

    // Apply transform so drawing with image-space coordinates will rotate/scale correctly
    ctx.setTransform(a, b, c, d, e, f);

    // ----- Draw patches in image coordinates (transform handles rotation/scale) -----
    const originalPatchImageSize = 224 * 16; // image-space size
    const desiredFixedScreenGap = 2; // pixels
    const minVisiblePatchSize = 3; // pixels

    // Compute screen pixels per image unit from the transform (uniform scale)
    const scale = Math.hypot(a, b);
    const cellScreenPx = scale * originalPatchImageSize;

    let effectiveGap = desiredFixedScreenGap;
    if (cellScreenPx - desiredFixedScreenGap < minVisiblePatchSize) {
      effectiveGap = Math.max(0, Math.floor(cellScreenPx - minVisiblePatchSize));
    }

    const drawSizeScreenPx = Math.max(minVisiblePatchSize, cellScreenPx - effectiveGap);
    if (drawSizeScreenPx <= 0) return;

    const drawSizeImageUnits = drawSizeScreenPx / scale;
    const offsetImageUnits = ((cellScreenPx - drawSizeScreenPx) / 2) / scale; // center-inset

    patches.forEach(([idx, x, y, color]) => {
      const drawXImage = (x - originalPatchImageSize / 2) + offsetImageUnits;
      const drawYImage = (y - originalPatchImageSize / 2) + offsetImageUnits;

      const finalColor = hexToRgb(color || '#aaaaaa');
      ctx.fillStyle = `rgba(${finalColor[0]}, ${finalColor[1]}, ${finalColor[2]}, 0.6)`;
      ctx.fillRect(drawXImage, drawYImage, drawSizeImageUnits, drawSizeImageUnits);

      // Highlight if patch center is inside ROI (rectangle or polygon)
      if (shapeData) {
        const hit = (shapeData.polygonPoints && shapeData.polygonPoints.length >= 3)
          ? isPointInPolygon(x, y, shapeData.polygonPoints)
          : (shapeData.rectangleCoords ? isPointInRectangle(x, y, shapeData.rectangleCoords) : false);
        if (hit) {
          ctx.strokeStyle = '#ffff00';
          // Keep a ~2px screen-space stroke width regardless of zoom
          const scale = Math.hypot(a, b);
          ctx.lineWidth = Math.max(1 / scale, 2 / scale);
          ctx.strokeRect(drawXImage, drawYImage, drawSizeImageUnits, drawSizeImageUnits);
        }
      }
    });
  }, [viewer, patches, hexToRgb, shapeData]);

  // Setup event handlers for viewer updates
  useEffect(() => {
    if (!viewer) return;

    // Add event handlers to OpenSeadragon viewer to redraw overlay on relevant events
    viewer.addHandler("update-viewport", updateOverlay);

    // Cleanup function: remove event handlers when component unmounts or dependencies change
    return () => {
      viewer.removeHandler("update-viewport", updateOverlay);
    };
  }, [viewer, updateOverlay]);

  // Initialize overlay when component mounts
  useEffect(() => {
    if (!viewer || !patches) return;
    updateOverlay();
  }, [viewer, patches, updateOverlay]);

  // Redraw when ROI selection changes
  useEffect(() => {
    if (!viewer) return;
    updateOverlay();
  }, [viewer, shapeData, updateOverlay]);

  return (
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
  );
};

export default PatchOverlay;
