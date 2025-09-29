import { message } from 'antd';

/**
 * Snapshot utility for capturing canvas views
 */

export interface SnapshotOptions {
  /** background color */
  backgroundColor?: string | null;
  /** whether to enable CORS */
  useCORS?: boolean;
  /** whether to allow taint canvas */
  allowTaint?: boolean;
  /** whether to enable logging */
  logging?: boolean;
}

export interface SnapshotResult {
  /** whether to succeed */
  success: boolean;
  /** error message (if any) */
  error?: string;
  /** generated blob object */
  blob?: Blob;
  /** file name */
  filename?: string;
}

/**
 * Trim transparent borders from a canvas by cropping to the non-transparent bounding box
 */
const removeTransparentBorders = (
  sourceCanvas: HTMLCanvasElement,
  alphaThreshold: number = 1
): HTMLCanvasElement => {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const ctx = sourceCanvas.getContext('2d');
  if (!ctx) return sourceCanvas;

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  let top = 0;
  let left = 0;
  let right = width - 1;
  let bottom = height - 1;

  // find top
  outerTop: for (; top < height; top++) {
    for (let x = 0; x < width; x++) {
      if (data[(top * width + x) * 4 + 3] >= alphaThreshold) break outerTop;
    }
  }

  // find bottom
  outerBottom: for (; bottom >= top; bottom--) {
    for (let x = 0; x < width; x++) {
      if (data[(bottom * width + x) * 4 + 3] >= alphaThreshold) break outerBottom;
    }
  }

  // find left
  outerLeft: for (; left < width; left++) {
    for (let y = top; y <= bottom; y++) {
      if (data[(y * width + left) * 4 + 3] >= alphaThreshold) break outerLeft;
    }
  }

  // find right
  outerRight: for (; right >= left; right--) {
    for (let y = top; y <= bottom; y++) {
      if (data[(y * width + right) * 4 + 3] >= alphaThreshold) break outerRight;
    }
  }

  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;

  // if fully transparent or nothing to trim, return original
  if (cropWidth <= 0 || cropHeight <= 0 || (left === 0 && top === 0 && right === width - 1 && bottom === height - 1)) {
    return sourceCanvas;
  }

  const out = document.createElement('canvas');
  out.width = cropWidth;
  out.height = cropHeight;
  const outCtx = out.getContext('2d');
  if (!outCtx) return sourceCanvas;

  outCtx.drawImage(sourceCanvas, left, top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return out;
};

/**
 * generate snapshot file name
 * @returns formatted file name
 */
export const generateSnapshotFilename = (): string => {
  const now = new Date();
  
  const yyyy = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  
  return `Tissuelab ${yyyy}-${MM}-${dd} ${hh}-${mm}-${ss}`;
};

/**
 * create temporary canvas
 * @param width width
 * @param height height
 * @returns temporary canvas and context
 */
export const createTempCanvas = (
  width: number, 
  height: number, 
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null => {
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  
  if (!tempCtx) {
    return null;
  }

  // set canvas size
  tempCanvas.width = width;
  tempCanvas.height = height;

  // fill background color
  tempCtx.fillStyle = 'transparent';
  tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

  return { canvas: tempCanvas, ctx: tempCtx };
};

/**
 * download file
 * @param blob blob
 * @param filename file name
 */
export const downloadFile = (blob: Blob, filename: string): void => {
  const link = document.createElement('a');
  link.download = `${filename}.png`;
  
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.click();
  
  // clean up URL object
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 100);
};

/**
 * capture OpenSeadragon viewer screenshot
 * @param viewerInstance OpenSeadragon viewer instance
 * @param options screenshot options
 * @returns Promise<SnapshotResult>
 */
export const captureSnapshot = async (
  viewerInstance: any,
  options: SnapshotOptions = {}
): Promise<SnapshotResult> => {
  const {
    backgroundColor = null,  // default transparent background
    useCORS = true,
    allowTaint = true,
    logging = true
  } = options;

  try {
    // check viewer instance
    if (!viewerInstance) {
      return {
        success: false,
        error: 'Viewer instance not available'
      };
    }

    // get container size
    const containerRect = viewerInstance.container.getBoundingClientRect();
    
    // use html2canvas result, avoid edge seam caused by scale/interpolation
    let exportCanvas: HTMLCanvasElement | null = null;

    // debug: check viewer container elements
    if (logging) {
      console.log('Viewer container:', viewerInstance.container);
      console.log('Viewer container children:', viewerInstance.container.children);
    }
    
    // find OpenSeadragon canvas
    const openseadragonCanvas = viewerInstance.container.querySelector('.openseadragon-canvas') as HTMLCanvasElement;
    
    if (!openseadragonCanvas) {
      return {
        success: false,
        error: 'No suitable canvas element found for screenshot'
      };
    }
    
    if (logging) {
      console.log('Using canvas:', openseadragonCanvas.className, openseadragonCanvas);
    }

    try {
      // dynamically import html2canvas to avoid SSR problem
      const html2canvas = (await import('html2canvas')).default;

      const html2CanvasOptions: any = {
        useCORS,
        allowTaint,
        logging,
        // transparent background: null; also pass in specific color string
        backgroundColor: backgroundColor,
        // avoid 1px edge due to high DPR scale interpolation
        scale: 1
      };

      const canvas = await (html2canvas as any)(openseadragonCanvas, html2CanvasOptions);

      if (logging) {
        console.log('html2canvas result:', canvas.width, 'x', canvas.height);
      }

      // directly crop the transparent edges of the html2canvas result canvas
      exportCanvas = removeTransparentBorders(canvas, 1);
      
      if (logging) {
        console.log('Successfully drew html2canvas result to temporary canvas');
      }
      
    } catch (html2canvasError) {
      console.error('html2canvas failed:', html2canvasError);
      return {
        success: false,
        error: 'Failed to capture canvas'
      };
    }

    // generate file name
    const filename = generateSnapshotFilename();

    // convert (trimmed) canvas to blob
    return new Promise((resolve) => {
      const finalCanvas: HTMLCanvasElement = exportCanvas || openseadragonCanvas;
      finalCanvas.toBlob((blob: Blob | null) => {
        if (blob) {
          resolve({
            success: true,
            blob,
            filename
          });
        } else {
          resolve({
            success: false,
            error: 'Failed to create snapshot blob'
          });
        }
      }, 'image/png');
    });
    
  } catch (error) {
    console.error('Error capturing snapshot:', error);
    return {
      success: false,
      error: `Error capturing snapshot: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
};

/**
 * execute complete screenshot process (including download)
 * @param viewerInstance OpenSeadragon viewer instance
 * @param options screenshot options
 * @returns Promise<boolean> whether to succeed
 */
export const takeSnapshot = async (
  viewerInstance: any,
  options: SnapshotOptions = {}
): Promise<boolean> => {
  const result = await captureSnapshot(viewerInstance, options);
  
  if (!result.success) {
    message.error(result.error || 'Failed to capture snapshot');
    return false;
  }

  if (result.blob && result.filename) {
    downloadFile(result.blob, result.filename);
    message.success('Snapshot captured successfully!');
    return true;
  }

  message.error('Failed to create snapshot');
  return false;
};

/**
 * capture and download a region (in viewer element pixel coordinates) as JPEG
 * Only captures content from the OpenSeadragon canvas element.
 */
export const takeSnapshotRegion = async (
  viewerInstance: any,
  region: { x: number; y: number; width: number; height: number },
  options: SnapshotOptions & { quality?: number; filenameSuffix?: string } = {}
): Promise<boolean> => {
  const {
    backgroundColor = null,
    useCORS = true,
    allowTaint = true,
    logging = true,
    quality = 0.92,
    filenameSuffix = 'region'
  } = options as any;

  try {
    if (!viewerInstance) {
      message.error('Viewer instance not available');
      return false;
    }

    const canvasEl = viewerInstance?.container?.querySelector?.('.openseadragon-canvas') as HTMLCanvasElement | null;
    if (!canvasEl) {
      message.error('No OpenSeadragon canvas found');
      return false;
    }

    const html2canvas = (await import('html2canvas')).default as any;
    const baseCanvas: HTMLCanvasElement = await html2canvas(canvasEl, {
      useCORS,
      allowTaint,
      logging,
      backgroundColor: backgroundColor, // null -> transparent for PNG
      scale: 1
    });

    const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

    const sx = Math.floor(clamp(region.x, 0, baseCanvas.width));
    const sy = Math.floor(clamp(region.y, 0, baseCanvas.height));
    const sw = Math.floor(clamp(region.width, 0, baseCanvas.width - sx));
    const sh = Math.floor(clamp(region.height, 0, baseCanvas.height - sy));

    if (sw <= 0 || sh <= 0) {
      message.error('Invalid crop region');
      return false;
    }

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = sw;
    cropCanvas.height = sh;
    const cropCtx = cropCanvas.getContext('2d');
    if (!cropCtx) {
      message.error('Failed to create crop context');
      return false;
    }

    // Optional background fill if provided (PNG keeps transparency by default)
    if (backgroundColor) {
      cropCtx.fillStyle = backgroundColor;
      cropCtx.fillRect(0, 0, sw, sh);
    }
    cropCtx.drawImage(baseCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

    const filenameBase = generateSnapshotFilename();

    const blob: Blob | null = await new Promise((resolve) => {
      if (cropCanvas.toBlob) {
        cropCanvas.toBlob((b) => resolve(b), 'image/png');
      } else {
        try {
          const dataUrl = cropCanvas.toDataURL('image/png');
          const parts = dataUrl.split(',');
          const bstr = atob(parts[1]);
          const u8 = new Uint8Array(bstr.length);
          for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
          resolve(new Blob([u8], { type: 'image/png' }));
        } catch {
          resolve(null);
        }
      }
    });

    if (!blob) {
      message.error('Failed to create JPEG blob');
      return false;
    }

    // Download as .png
    const link = document.createElement('a');
    link.download = `${filenameBase} ${filenameSuffix}.png`;
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);

    message.success('Region snapshot saved');
    return true;
  } catch (error) {
    console.error('Error capturing region snapshot:', error);
    message.error('Error capturing region snapshot');
    return false;
  }
};

/**
 * Fast path: directly crop from OpenSeadragon canvas without html2canvas
 * region is in CSS pixels relative to the OSD canvas element's client box
 */
export const takeSnapshotRegionFromCanvas = async (
  viewerInstance: any,
  region: { x: number; y: number; width: number; height: number },
  options: { quality?: number; filenameSuffix?: string; backgroundColor?: string } = {}
): Promise<boolean> => {
  const { quality = 0.95, filenameSuffix = 'region', backgroundColor } = options;

  try {
    const hostEl = viewerInstance?.container?.querySelector?.('.openseadragon-canvas') as HTMLElement | null;
    const baseCanvas = (hostEl?.querySelector?.('canvas') as HTMLCanvasElement | null)
      || (viewerInstance?.drawer?.canvas as HTMLCanvasElement | null)
      || null;
    if (!hostEl || !baseCanvas) {
      message.error('No OpenSeadragon canvas found');
      return false;
    }

    // Map CSS pixels to base canvas pixel coordinates (use host rect as CSS reference)
    const hostRect = hostEl.getBoundingClientRect();
    const baseCanvasRect = baseCanvas.getBoundingClientRect();
    const baseScaleX = baseCanvas.width / Math.max(1, hostRect.width);
    const baseScaleY = baseCanvas.height / Math.max(1, hostRect.height);

    const baseOffsetX = baseCanvasRect.left - hostRect.left;
    const baseOffsetY = baseCanvasRect.top - hostRect.top;

    const rxCss = region.x;
    const ryCss = region.y;
    const rwCss = Math.max(1, region.width);
    const rhCss = Math.max(1, region.height);

    // Base layer source rect in its own pixel space
    const sxBase = Math.floor((rxCss - baseOffsetX) * baseScaleX);
    const syBase = Math.floor((ryCss - baseOffsetY) * baseScaleY);
    const swBase = Math.floor(rwCss * baseScaleX);
    const shBase = Math.floor(rhCss * baseScaleY);

    // Prepare output canvas in BASE canvas pixel scale to avoid resampling seams
    const out = document.createElement('canvas');
    out.width = Math.max(1, swBase);
    out.height = Math.max(1, shBase);
    const ctx = out.getContext('2d');
    if (!ctx) {
      message.error('Failed to create canvas context');
      return false;
    }

    // Optional background fill (PNG keeps transparency if not provided)
    if (backgroundColor) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, out.width, out.height);
    }

    // Compose base canvas + any overlay canvases under viewerInstance.canvas
    const overlayRoot = (viewerInstance?.canvas as HTMLElement | null) || hostEl;
    const overlayCanvases = (Array.from(overlayRoot.querySelectorAll('canvas')) as HTMLCanvasElement[]);
    const layers: HTMLCanvasElement[] = [];
    const seen = new Set<HTMLCanvasElement>();
    if (baseCanvas && !seen.has(baseCanvas)) { seen.add(baseCanvas); layers.push(baseCanvas); }
    overlayCanvases.forEach(c => { if (!seen.has(c)) { seen.add(c); layers.push(c); } });

    const drawLayer = (layerCanvas: HTMLCanvasElement) => {
      const layerRect = layerCanvas.getBoundingClientRect();
      // Map CSS to layer pixels
      const scaleX = layerCanvas.width / Math.max(1, layerRect.width);
      const scaleY = layerCanvas.height / Math.max(1, layerRect.height);
      const layerOffsetX = layerRect.left - hostRect.left;
      const layerOffsetY = layerRect.top - hostRect.top;

      const sxRaw = (rxCss - layerOffsetX) * scaleX;
      const syRaw = (ryCss - layerOffsetY) * scaleY;
      const swRaw = rwCss * scaleX;
      const shRaw = rhCss * scaleY;

      // Clamp source rect to layer bounds
      let sx = Math.floor(sxRaw);
      let sy = Math.floor(syRaw);
      let sw = Math.floor(swRaw);
      let sh = Math.floor(shRaw);

      let dx = 0;
      let dy = 0;

      // If sx < 0, shift dest x accordingly
      if (sx < 0) {
        const shiftCss = (-sx) / scaleX; // how many CSS px are outside on the left
        dx = Math.floor(shiftCss * baseScaleX);
        sw += sx; // reduce width by the amount out of bounds
        sx = 0;
      }
      if (sy < 0) {
        const shiftCss = (-sy) / scaleY;
        dy = Math.floor(shiftCss * baseScaleY);
        sh += sy;
        sy = 0;
      }
      // Cap width/height to layer bounds
      sw = Math.min(sw, layerCanvas.width - sx);
      sh = Math.min(sh, layerCanvas.height - sy);

      if (sw <= 0 || sh <= 0) return; // nothing visible

      const dw = Math.floor(sw * (baseScaleX / scaleX));
      const dh = Math.floor(sh * (baseScaleY / scaleY));

      ctx.drawImage(layerCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
    };

    layers.forEach(drawLayer);

    // toBlob fallback
    const blob: Blob | null = await new Promise((resolve) => {
      if (out.toBlob) {
        out.toBlob((b) => resolve(b), 'image/png');
      } else {
        try {
          const dataUrl = out.toDataURL('image/png');
          const parts = dataUrl.split(',');
          const bstr = atob(parts[1]);
          const u8 = new Uint8Array(bstr.length);
          for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
          resolve(new Blob([u8], { type: 'image/png' }));
        } catch {
          resolve(null);
        }
      }
    });

    if (!blob) {
      message.error('Failed to create JPEG blob');
      return false;
    }

    const filenameBase = generateSnapshotFilename();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = `${filenameBase} ${filenameSuffix}.png`;
    a.href = url;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);

    message.success('Region snapshot saved');
    return true;
  } catch (e) {
    console.error('Region crop failed:', e);
    message.error('Region crop failed');
    return false;
  }
};

/**
 * Capture and download a polygon area (polygon vertices are in CSS pixels relative to the OSD canvas host element)
 * Uses html2canvas path (same as takeSnapshotRegion) to avoid WebGL seam artifacts.
 */
export const takeSnapshotPolygon = async (
  viewerInstance: any,
  polygonCssPoints: Array<[number, number]>,
  options: SnapshotOptions & { quality?: number; filenameSuffix?: string; format?: 'png' | 'jpeg' | 'jpg'; backgroundColor?: string } = {}
): Promise<boolean> => {
  const {
    backgroundColor = null,
    useCORS = true,
    allowTaint = true,
    logging = true,
    quality = 0.92,
    filenameSuffix = 'polygon',
    format = 'png'
  } = options as any;

  try {
    if (!viewerInstance) {
      message.error('Viewer instance not available');
      return false;
    }
    const hostEl = viewerInstance?.container?.querySelector?.('.openseadragon-canvas') as HTMLElement | null;
    const baseCanvas = (hostEl?.querySelector?.('canvas') as HTMLCanvasElement | null)
      || (viewerInstance?.drawer?.canvas as HTMLCanvasElement | null)
      || null;
    if (!hostEl || !baseCanvas) {
      message.error('No OpenSeadragon canvas found');
      return false;
    }

    if (!polygonCssPoints || polygonCssPoints.length < 3) {
      message.error('Invalid polygon');
      return false;
    }

    // Compute polygon bounding box in CSS space
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [px, py] of polygonCssPoints) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }

    // Clamp bbox into base canvas bounds
    const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
    const bx = Math.floor(clamp(minX, 0, baseCanvas.width));
    const by = Math.floor(clamp(minY, 0, baseCanvas.height));
    const bw = Math.floor(clamp(maxX - minX, 0, baseCanvas.width - bx));
    const bh = Math.floor(clamp(maxY - minY, 0, baseCanvas.height - by));

    if (bw <= 0 || bh <= 0) {
      message.error('Invalid polygon bounds');
      return false;
    }

    // Prepare output canvas (crop of bbox)
    const out = document.createElement('canvas');
    out.width = bw;
    out.height = bh;
    const ctx = out.getContext('2d');
    if (!ctx) {
      message.error('Failed to create canvas context');
      return false;
    }

    // Fill background for JPEG (no alpha); PNG keeps transparency
    if (format !== 'png') {
      ctx.fillStyle = backgroundColor ?? '#ffffff';
      ctx.fillRect(0, 0, bw, bh);
    }

    // Map CSS pixels to base canvas pixel coordinates
    const hostRect = hostEl.getBoundingClientRect();
    const baseCanvasRect = baseCanvas.getBoundingClientRect();
    const baseScaleX = baseCanvas.width / Math.max(1, hostRect.width);
    const baseScaleY = baseCanvas.height / Math.max(1, hostRect.height);
    const baseOffsetX = baseCanvasRect.left - hostRect.left;
    const baseOffsetY = baseCanvasRect.top - hostRect.top;

    const sxBase = Math.floor((bx - baseOffsetX) * baseScaleX);
    const syBase = Math.floor((by - baseOffsetY) * baseScaleY);
    const swBase = Math.floor(bw * baseScaleX);
    const shBase = Math.floor(bh * baseScaleY);

    // Compose base canvas + any overlay canvases under viewerInstance.canvas
    const overlayRoot = (viewerInstance?.canvas as HTMLElement | null) || hostEl;
    const overlayCanvases = (Array.from(overlayRoot.querySelectorAll('canvas')) as HTMLCanvasElement[]);
    const layers: HTMLCanvasElement[] = [];
    const seen = new Set<HTMLCanvasElement>();
    if (baseCanvas && !seen.has(baseCanvas)) { seen.add(baseCanvas); layers.push(baseCanvas); }
    overlayCanvases.forEach(c => { if (!seen.has(c)) { seen.add(c); layers.push(c); } });

    // Crop region equals polygon bounding box in CSS px
    const rxCss = bx;
    const ryCss = by;
    const rwCss = bw;
    const rhCss = bh;

    const drawLayer = (layerCanvas: HTMLCanvasElement) => {
      const layerRect = layerCanvas.getBoundingClientRect();
      // Map CSS to layer pixels
      const scaleX = layerCanvas.width / Math.max(1, layerRect.width);
      const scaleY = layerCanvas.height / Math.max(1, layerRect.height);
      const layerOffsetX = layerRect.left - hostRect.left;
      const layerOffsetY = layerRect.top - hostRect.top;

      const sxRaw = (rxCss - layerOffsetX) * scaleX;
      const syRaw = (ryCss - layerOffsetY) * scaleY;
      const swRaw = rwCss * scaleX;
      const shRaw = rhCss * scaleY;

      // Clamp source rect to layer bounds
      let sx = Math.floor(sxRaw);
      let sy = Math.floor(syRaw);
      let sw = Math.floor(swRaw);
      let sh = Math.floor(shRaw);

      let dx = 0;
      let dy = 0;

      // If sx < 0, shift dest x accordingly
      if (sx < 0) {
        const shiftCss = (-sx) / scaleX; // how many CSS px are outside on the left
        dx = Math.floor(shiftCss * baseScaleX);
        sw += sx; // reduce width by the amount out of bounds
        sx = 0;
      }
      if (sy < 0) {
        const shiftCss = (-sy) / scaleY;
        dy = Math.floor(shiftCss * baseScaleY);
        sh += sy;
        sy = 0;
      }
      // Cap width/height to layer bounds
      sw = Math.min(sw, layerCanvas.width - sx);
      sh = Math.min(sh, layerCanvas.height - sy);

      if (sw <= 0 || sh <= 0) return; // nothing visible

      const dw = Math.floor(sw * (baseScaleX / scaleX));
      const dh = Math.floor(sh * (baseScaleY / scaleY));

      ctx.drawImage(layerCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
    };

    // Optional background fill (PNG keeps transparency if not provided)
    if (backgroundColor) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, bw, bh);
    }

    layers.forEach(drawLayer);

    // Build polygon mask path (relative to bbox top-left)
    const toLocal = (pt: [number, number]) => [pt[0] - bx, pt[1] - by] as [number, number];
    const localPoints = polygonCssPoints.map(toLocal);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(localPoints[0][0], localPoints[0][1]);
    for (let i = 1; i < localPoints.length; i++) {
      ctx.lineTo(localPoints[i][0], localPoints[i][1]);
    }
    ctx.closePath();

    // Keep only pixels inside polygon
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.fill();
    ctx.restore();

    const filenameBase = generateSnapshotFilename();

    const toBlobAsync = (): Promise<Blob | null> => new Promise((resolve) => {
      const mime = 'image/png';
      if (out.toBlob) {
        out.toBlob((b) => resolve(b), mime);
      } else {
        try {
          const dataUrl = out.toDataURL(mime);
          const parts = dataUrl.split(',');
          const bstr = atob(parts[1]);
          const u8 = new Uint8Array(bstr.length);
          for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
          resolve(new Blob([u8], { type: mime }));
        } catch {
          resolve(null);
        }
      }
    });

    const blob = await toBlobAsync();
    if (!blob) {
      message.error('Failed to create image blob');
      return false;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = `${filenameBase} ${filenameSuffix}.png`;
    a.href = url;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);

    message.success('Polygon snapshot saved');
    return true;
  } catch (e) {
    console.error('Polygon snapshot failed:', e);
    message.error('Polygon snapshot failed');
    return false;
  }
};

/**
 * Save PNG from current selection. Attempts polygon mask if a polygon is selected; otherwise falls back to
 * rectangle bounding box. If DOM-based capture fails, falls back to geometry transform using provided rectangle coords.
 */
export const savePNGFromCurrentSelection = async (
  viewerInstance: any,
  shapeCoords: { x1: number; y1: number; x2: number; y2: number } | null | undefined,
  options: { scaleFactor?: number; backgroundColor?: string; quality?: number; filenameSuffix?: string } = {}
): Promise<boolean> => {
  try {
    if (!viewerInstance) {
      console.error('[SavePNG] Viewer not available');
      return false;
    }

    const { scaleFactor = 16, backgroundColor = '#ffffff', quality = 0.95, filenameSuffix = 'annotation' } = options;

    const viewer = viewerInstance as any;
    const world = viewer.world;
    const item = world && world.getItemAt ? world.getItemAt(0) : null;
    if (!item) {
      console.error('[SavePNG] No tiled image item found');
      return false;
    }

    // 1) Try DOM-based bounding box from Annotorious overlay (most reliable)
    const selectedGroup: SVGGElement | null = document.querySelector('g.a9s-annotation.selected');
    const viewerEl: HTMLElement = viewer.container as HTMLElement;
    const canvasEl = viewerEl.querySelector('.openseadragon-canvas') as HTMLCanvasElement | null;
    const viewerRect = viewerEl.getBoundingClientRect();
    const canvasRect = canvasEl ? canvasEl.getBoundingClientRect() : viewerRect;

    if (selectedGroup) {
      // Hide Annotorious SVG elements (layer + handles) to avoid capturing frames
      const hideSelectors = [
        '.a9s-annotationlayer',
        '.a9s-handle',
        '.a9s-edge-handle',
        'g.a9s-annotation',
        '.a9s-selection'
      ];
      const hiddenEls: Array<{ el: HTMLElement, prev: string }> = [];
      hideSelectors.forEach(sel => {
        viewerEl.querySelectorAll(sel).forEach((n) => {
          const el = n as HTMLElement;
          hiddenEls.push({ el, prev: el.style.visibility });
          el.style.visibility = 'hidden';
        });
      });
      try {
        // Prefer polygon-masked export when polygon exists
        const poly = selectedGroup.querySelector('polygon') as SVGPolygonElement | null;
        if (poly) {
          try {
            const svg = poly.ownerSVGElement as SVGSVGElement | null;
            const ctm = poly.getScreenCTM?.();
            if (svg && ctm) {
              const raw = (poly.getAttribute('points') || '')
                .trim()
                .split(/\s+/)
                .map(pair => pair.split(',').map(parseFloat))
                .filter(p => p.length === 2 && !Number.isNaN(p[0]) && !Number.isNaN(p[1])) as [number, number][];
              if (raw.length >= 3) {
                const toScreen = (pt: [number, number]) => {
                  const sp = svg.createSVGPoint();
                  sp.x = pt[0];
                  sp.y = pt[1];
                  const scr = sp.matrixTransform(ctm);
                  return [scr.x, scr.y] as [number, number];
                };
                const screenPts = raw.map(toScreen);
                // Convert to CSS coords relative to OSD canvas element
                const cssPts = screenPts.map(([sx, sy]) => [sx - canvasRect.left, sy - canvasRect.top]) as [number, number][];
                const okPoly = await takeSnapshotPolygon(viewer, cssPts, {
                  backgroundColor,
                  quality,
                  filenameSuffix
                });
                if (okPoly) return true;
              }
            }
          } catch (e) {
            console.warn('[SavePNG] Polygon snapshot failed, fallback to bbox crop', e);
          }
        }

        // Fallback to rectangle bbox export (prefer exact outer rect bounds)
        let rectBBox = selectedGroup.getBoundingClientRect();
        const outerRectEl = selectedGroup.querySelector('rect.a9s-outer') as SVGGraphicsElement | null;
        if (outerRectEl) {
          try {
            rectBBox = outerRectEl.getBoundingClientRect();
          } catch {}
        }
        let rx = Math.round(rectBBox.left - canvasRect.left);
        let ry = Math.round(rectBBox.top - canvasRect.top);
        let rw = Math.round(rectBBox.width);
        let rh = Math.round(rectBBox.height);
        rw = Math.max(1, rw);
        rh = Math.max(1, rh);

        // First try direct canvas crop (WebGL-safe)
        const ok = await takeSnapshotRegionFromCanvas(viewer, { x: rx, y: ry, width: rw, height: rh }, {
          backgroundColor,
          quality,
          filenameSuffix
        });
        if (ok) return true;

        // Fallback: html2canvas(base) + crop
        const ok2 = await takeSnapshotRegion(viewer, { x: rx, y: ry, width: rw, height: rh }, {
          backgroundColor,
          quality,
          filenameSuffix
        } as any);
        if (ok2) return true;
      } finally {
        // Restore visibility
        hiddenEls.forEach(({ el, prev }) => { el.style.visibility = prev || ''; });
      }
    }

    // 2) Fallback to geometry transform: image -> viewport -> viewer pixels -> canvas pixels
    if (!shapeCoords) {
      console.error('[SavePNG] Rectangle coordinates not found');
      return false;
    }

    const scale = scaleFactor;
    const x1Raw = shapeCoords.x1 * scale;
    const y1Raw = shapeCoords.y1 * scale;
    const x2Raw = shapeCoords.x2 * scale;
    const y2Raw = shapeCoords.y2 * scale;

    const OSD: any = (window as any).OpenSeadragon;
    const pImage1 = OSD ? new OSD.Point(x1Raw, y1Raw) : { x: x1Raw, y: y1Raw };
    const pImage2 = OSD ? new OSD.Point(x2Raw, y2Raw) : { x: x2Raw, y: y2Raw };

    const pViewport1 = item.imageToViewportCoordinates(pImage1);
    const pViewport2 = item.imageToViewportCoordinates(pImage2);
    const pPixel1 = viewer.viewport.viewportToViewerElementCoordinates(pViewport1);
    const pPixel2 = viewer.viewport.viewportToViewerElementCoordinates(pViewport2);

    const leftViewer = Math.min(pPixel1.x, pPixel2.x);
    const topViewer = Math.min(pPixel1.y, pPixel2.y);
    const rightViewer = Math.max(pPixel1.x, pPixel2.x);
    const bottomViewer = Math.max(pPixel1.y, pPixel2.y);

    // translate to canvas element pixel space (since we snapshot the canvas element)
    const offsetX = canvasRect.left - viewerRect.left;
    const offsetY = canvasRect.top - viewerRect.top;

    let rx = Math.round(leftViewer - offsetX);
    let ry = Math.round(topViewer - offsetY);
    let rw = Math.round(rightViewer - leftViewer);
    let rh = Math.round(bottomViewer - topViewer);
    // Ensure positive and minimum size
    rw = Math.max(1, rw);
    rh = Math.max(1, rh);

    const region = { x: rx, y: ry, width: rw, height: rh };

    const okFinal = await takeSnapshotRegion(viewer, region, {
      backgroundColor,
      quality,
      filenameSuffix
    } as any);
    return okFinal;
  } catch (err) {
    console.error('[SavePNG] Failed:', err);
    return false;
  }
};