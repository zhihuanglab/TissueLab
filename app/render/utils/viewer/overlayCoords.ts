import type { ViewportAabb } from './viewportGeometryCache';

/** Visible image AABB (+ optional screen/dpr/rotation for Redux). */
export type VisibleImageCoordinates = {
  image: ViewportAabb;
  screen: { x: number; y: number; width: number; height: number };
  dpr: number;
  rotation: number;
};

/** Full slide AABB in image pixels — used for one-shot centroid requests. */
export function getFullImageAabb(viewer: any): ViewportAabb | null {
  const tiledImage = viewer?.world?.getItemAt?.(0);
  const size = tiledImage?.getContentSize?.();
  if (!size || !(size.x > 0) || !(size.y > 0)) return null;
  return { x1: 0, y1: 0, x2: Math.ceil(size.x), y2: Math.ceil(size.y) };
}

export function getVisibleImageCoordinates(viewer: any): VisibleImageCoordinates | null {
  if (!viewer?.viewport) return null;
  // Prefer current (true) bounds so mid-animation / settled frames match what's on screen.
  const viewportBounds =
    typeof viewer.viewport.getBounds === 'function'
      ? viewer.viewport.getBounds(true)
      : viewer.viewport.getBounds();
  const tiledImage = viewer.world?.getItemAt?.(0);
  const topLeft = tiledImage
    ? tiledImage.viewportToImageCoordinates(viewportBounds.getTopLeft())
    : viewer.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
  const bottomRight = tiledImage
    ? tiledImage.viewportToImageCoordinates(viewportBounds.getBottomRight())
    : viewer.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());

  const viewerRect = viewer.element?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
  const dpr = 1;
  // @ts-ignore - getRotation(current) exists at runtime
  const rotation = viewer.viewport.getRotation?.(true) || 0;

  // floor/ceil so rounding never shrinks the visible AABB (edge cells would drop out).
  return {
    image: {
      x1: Math.floor(Math.min(topLeft.x, bottomRight.x)),
      y1: Math.floor(Math.min(topLeft.y, bottomRight.y)),
      x2: Math.ceil(Math.max(topLeft.x, bottomRight.x)),
      y2: Math.ceil(Math.max(topLeft.y, bottomRight.y)),
    },
    screen: {
      x: Math.round((window.screenLeft + viewerRect.left) * dpr),
      y: Math.round((window.screenTop + viewerRect.top) * dpr),
      width: Math.round(viewerRect.width * dpr),
      height: Math.round(viewerRect.height * dpr),
    },
    dpr,
    rotation,
  };
}

/** True when OSD springs are still moving (current ≠ target). */
export function isViewportAnimating(viewer: any): boolean {
  const v = viewer?.viewport;
  if (!v?.getCenter || !v?.getZoom) return false;
  const cCur = v.getCenter(true);
  const cTgt = v.getCenter(false);
  const zCur = v.getZoom(true);
  const zTgt = v.getZoom(false);
  const dx = cCur.x - cTgt.x;
  const dy = cCur.y - cTgt.y;
  return dx * dx + dy * dy > 1e-12 || Math.abs(zCur - zTgt) > 1e-9;
}
