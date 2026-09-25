import React, { useRef, useLayoutEffect, useCallback } from "react";
import OpenSeadragon from "openseadragon";
import { useSelector } from "react-redux";
import { mat2d } from "gl-matrix";
import { RootState } from "@/store";
import { RectangleCoords } from "@/store/slices/viewer/shapeSlice";
import { selectPatchClassificationData } from "@/store/slices/viewer/annotationSlice";

// Point-in-rectangle (ROI) using image-space coordinates
const isPointInRectangle = (x: number, y: number, rect: RectangleCoords | null): boolean => {
  if (!rect) return false;
  const minX = Math.min(rect.x1, rect.x2);
  const maxX = Math.max(rect.x1, rect.x2);
  const minY = Math.min(rect.y1, rect.y2);
  const maxY = Math.max(rect.y1, rect.y2);
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

// Point-in-polygon (ROI) using image-space coordinates (ray casting)
const isPointInPolygon = (x: number, y: number, polygonPoints: [number, number][] | undefined): boolean => {
  if (!polygonPoints || polygonPoints.length < 3) return false;
  const pts = polygonPoints.map(p => [p[0], p[1]] as [number, number]);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function hexToRgb(hex: string): [number, number, number] {
  const sanitizedHex = hex.replace(/^#/, '');
  const fullHex = sanitizedHex.length === 3
    ? sanitizedHex.split('').map(c => c + c).join('')
    : sanitizedHex;
  const bigint = parseInt(fullHex, 16);
  return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

interface PatchOverlayProps {
  viewer: OpenSeadragon.Viewer | null;
  patches: Array<[number, number, number, number, number, string, number]>; // [idx, x, y, width, height, color, class_id]
}

const PatchOverlay: React.FC<PatchOverlayProps> = ({
  viewer,
  patches,
}) => {
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const reduxPatchClassificationData = useSelector(selectPatchClassificationData);
  const shapeData = useSelector((state: RootState) => state.shape.shapeData);
  const overlayAlpha = useSelector((state: RootState) => state.viewerSettings.overlayAlpha) ?? 0.4;
  const patchOverrides = useSelector((state: RootState) => state.annotations.patchOverrides);
  const highlightGtAnnotations = useSelector((state: RootState) => state.viewerSettings.highlightGtAnnotations);
  const gtHighlightTissueIndices = useSelector((state: RootState) => state.gtHighlight.tissueIndices);

  const updateOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas || !viewer) return;

    // Get the viewer's canvas element to match its size
    const viewerCanvas = viewer.canvas;
    if (!viewerCanvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Resize only when the size actually changed — assigning width/height drops
    // the whole backing store, and this runs inside OSD's rAF every frame.
    // The clearRect below blanks the canvas either way.
    const width = viewerCanvas.clientWidth;
    const height = viewerCanvas.clientHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    // Clear with identity transform before drawing
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (patches.length === 0) return;

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
    const desiredFixedScreenGap = 2; // pixels
    const minVisiblePatchSize = 3; // pixels

    // Compute screen pixels per image unit from the transform (uniform scale)
    const scale = Math.hypot(a, b);
    const gtTissueSet = highlightGtAnnotations && gtHighlightTissueIndices.length > 0 ? new Set(gtHighlightTissueIndices) : null;

    patches.forEach((patch) => {
      // Extract patch data: [idx, x, y, width, height, color, class_id]
      // Handle both old format (without class_id) and new format (with class_id)
      const idx = patch[0];
      const x = patch[1];
      const y = patch[2];
      const width = patch[3];
      const height = patch[4];
      const color = patch[5];
      const class_id = patch.length > 6 ? patch[6] : -1;
      const classColors = reduxPatchClassificationData?.class_hex_color;
      const finalColor =
        patchOverrides[idx] ||
        (classColors && class_id >= 0 && class_id < classColors.length
          ? classColors[class_id]
          : color);
      
      // Use dynamic patch dimensions from backend (already in image-space coordinates)
      const patchImageWidth = width;
      const patchImageHeight = height;
      
      // Compute screen size for this specific patch
      const patchWidthScreenPx = scale * patchImageWidth;
      const patchHeightScreenPx = scale * patchImageHeight;
      
      // Calculate effective gap for this patch
      let effectiveGapX = desiredFixedScreenGap;
      let effectiveGapY = desiredFixedScreenGap;
      
      if (patchWidthScreenPx - desiredFixedScreenGap < minVisiblePatchSize) {
        effectiveGapX = Math.max(0, Math.floor(patchWidthScreenPx - minVisiblePatchSize));
      }
      if (patchHeightScreenPx - desiredFixedScreenGap < minVisiblePatchSize) {
        effectiveGapY = Math.max(0, Math.floor(patchHeightScreenPx - minVisiblePatchSize));
      }
      
      // Calculate draw size in screen pixels
      const drawWidthScreenPx = Math.max(minVisiblePatchSize, patchWidthScreenPx - effectiveGapX);
      const drawHeightScreenPx = Math.max(minVisiblePatchSize, patchHeightScreenPx - effectiveGapY);
      
      if (drawWidthScreenPx <= 0 || drawHeightScreenPx <= 0) return;
      
      // Convert back to image units
      const drawWidthImageUnits = drawWidthScreenPx / scale;
      const drawHeightImageUnits = drawHeightScreenPx / scale;
      const offsetXImageUnits = ((patchWidthScreenPx - drawWidthScreenPx) / 2) / scale;
      const offsetYImageUnits = ((patchHeightScreenPx - drawHeightScreenPx) / 2) / scale;

      // Calculate draw position (patches are centered at x, y)
      const drawXImage = (x - patchImageWidth / 2) + offsetXImageUnits;
      const drawYImage = (y - patchImageHeight / 2) + offsetYImageUnits;

      const colorToUse = finalColor || '#aaaaaa';
      const finalColorRgb = hexToRgb(colorToUse);
      ctx.fillStyle = `rgba(${finalColorRgb[0]}, ${finalColorRgb[1]}, ${finalColorRgb[2]}, ${overlayAlpha})`;
      ctx.fillRect(drawXImage, drawYImage, drawWidthImageUnits, drawHeightImageUnits);

      // Highlight if patch is user-annotated (GT) and preference is on, or if patch center is inside ROI
      const isGtHighlight = gtTissueSet ? gtTissueSet.has(idx) : false;
      const roiHit = shapeData && ((shapeData.polygonPoints && shapeData.polygonPoints.length >= 3)
        ? isPointInPolygon(x, y, shapeData.polygonPoints)
        : (shapeData.rectangleCoords ? isPointInRectangle(x, y, shapeData.rectangleCoords) : false));
      if (isGtHighlight || roiHit) {
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = Math.max(1 / scale, 2 / scale);
        ctx.strokeRect(drawXImage, drawYImage, drawWidthImageUnits, drawHeightImageUnits);
      }
    });
  }, [viewer, patches, shapeData, overlayAlpha, reduxPatchClassificationData, patchOverrides, highlightGtAnnotations, gtHighlightTissueIndices]);

  useLayoutEffect(() => {
    if (!viewer) return;
    viewer.addHandler("update-viewport", updateOverlay);
    updateOverlay();
    return () => {
      viewer.removeHandler("update-viewport", updateOverlay);
    };
  }, [viewer, updateOverlay]);

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

// See MaskOverlay: the parent re-renders on every mouse move, and this overlay's
// draw effect re-runs on every re-render. Props here (viewer, patches) are stable
// unless patches actually arrive.
export default React.memo(PatchOverlay);
