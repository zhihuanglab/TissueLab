import { RootState } from "@/store";
import { RectangleCoords } from "@/store/slices/viewer/shapeSlice";
import { useAnnotationTypes } from '@/store/zustand/slice/annotationTypesStore';
import { webglContextManager } from '@/utils/webglContextManager';
import { mat2d } from "gl-matrix";
import OpenSeadragon from "openseadragon";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSelector } from "react-redux";
import { CentroidsArray } from './CentroidsArray';

const INV_255 = 1 / 255; // Pre-computed inverse for faster color normalization

interface DrawingOverlayProps {
  viewer: OpenSeadragon.Viewer | null;
  centroids: CentroidsArray; // [id, x, y, class_id]
  threshold: number;
  classificationData?: {
    nuclei_class_id: number[];
    nuclei_class_name: string[];
    nuclei_class_HEX_color: string[];
  } | null;
  annotations: any[];
  nucleiClasses: { name: string, color: string, count: number }[];
  /** When true (filter mode, cell overlay off): only draw highlighted cells (yellow), not the rest */
  filterOnlyHighlight?: boolean;
}


// Centroid vertex shader
const centroidVertexShaderSource = `#version 300 es
    uniform vec2 u_scale;
    uniform mat3 u_imageToViewer; // 3x3 matrix for 2D transformation
    uniform vec2 u_canvasSize;

    in vec2 a_position;
    in vec4 a_color;
    in vec2 a_imageCoords; // Image coordinates instead of NDC

    out vec4 v_color;

    void main() {
      // Transform image coordinates to viewer coordinates using matrix
      vec3 imagePos = vec3(a_imageCoords, 1.0);
      vec3 viewerPos = u_imageToViewer * imagePos;
      
      // Convert to NDC
      vec2 ndc = (viewerPos.xy / u_canvasSize) * 2.0 - 1.0;
      ndc.y = -ndc.y; // Flip Y coordinate
      
      // Apply circle position and scale
      gl_Position = vec4(ndc + a_position * u_scale, 0.0, 1.0);
      v_color = a_color;
    }
  `;

// Polygon vertex shader
const polygonVertexShaderSource = `#version 300 es
    uniform mat3 u_imageToViewer;
    uniform vec2 u_canvasSize;

    in vec2 a_position;
    in vec4 a_color;

    out vec4 v_color;

    void main() {
      vec3 imagePos = vec3(a_position, 1.0);
      vec3 viewerPos = u_imageToViewer * imagePos;
      
      vec2 ndc = (viewerPos.xy / u_canvasSize) * 2.0 - 1.0;
      ndc.y = -ndc.y;
      
      gl_Position = vec4(ndc, 0.0, 1.0);
      v_color = a_color;
    }
  `;

const fragmentShaderSource = `#version 300 es
    precision highp float;
    in vec4 v_color;
    out vec4 fragColor;
    
    void main() {
      fragColor = v_color;
    }
  `;

// Type guard function
const isWebGL2Context = (gl: WebGLRenderingContext | WebGL2RenderingContext): gl is WebGL2RenderingContext => {
  return 'createVertexArray' in gl;
};

const createShader = (gl: WebGL2RenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
};

const createProgram = (gl: WebGL2RenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader) => {
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program));
    return null;
  }
  return program;
};

const createCircleVertices = (segments: number) => {
  const vertices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle1 = (i / segments) * Math.PI * 2;
    const angle2 = ((i + 1) / segments) * Math.PI * 2;

    // Center vertex
    vertices.push(0, 0);

    // First point on circle
    vertices.push(
      Math.cos(angle1),
      Math.sin(angle1)
    );

    // Second point on circle
    vertices.push(
      Math.cos(angle2),
      Math.sin(angle2)
    );
  }
  return vertices;
};

// Check if a point is inside the rectangle selection
const isPointInRectangle = (x: number, y: number, rect: RectangleCoords | null): boolean => {
  if (!rect) return false;

  const rectX1 = rect.x1;
  const rectY1 = rect.y1;
  const rectX2 = rect.x2;
  const rectY2 = rect.y2;

  // Check if point is inside rectangle
  return x >= Math.min(rectX1, rectX2) && x <= Math.max(rectX1, rectX2) &&
    y >= Math.min(rectY1, rectY2) && y <= Math.max(rectY1, rectY2);
}

// Check if a point is inside a polygon using ray casting algorithm
const isPointInPolygon = (x: number, y: number, polygonPoints: [number, number][] | null): boolean => {
  if (!polygonPoints || polygonPoints.length < 3) return false;

  let inside = false;
  const n = polygonPoints.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygonPoints[i][0];
    const yi = polygonPoints[i][1];
    const xj = polygonPoints[j][0];
    const yj = polygonPoints[j][1];

    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }

  return inside;
}

const DrawingOverlay: React.FC<DrawingOverlayProps> = ({
  viewer,
  centroids,
  threshold,
  classificationData,
  annotations,
  nucleiClasses,
  filterOnlyHighlight = false,
}) => {
  const centroidSize = useSelector((state: RootState) => state.viewerSettings.centroidSize) ?? 1.5;
  const overlayAlpha = useSelector((state: RootState) => state.viewerSettings.overlayAlpha) ?? 0.4;
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | WebGL2RenderingContext | null>(null);

  // Centroid program
  const centroidProgramRef = useRef<WebGLProgram | null>(null);
  const centroidBuffersRef = useRef<{
    position: WebGLBuffer;
    color: WebGLBuffer;
    imageCoords: WebGLBuffer;
  } | null>(null);
  const centroidVaoRef = useRef<WebGLVertexArrayObject | null>(null);

  // Polygon program
  const polygonProgramRef = useRef<WebGLProgram | null>(null);
  const polygonBuffersRef = useRef<{
    position: WebGLBuffer;
    color: WebGLBuffer;
    indices: WebGLBuffer;
  } | null>(null);
  const polygonVaoRef = useRef<WebGLVertexArrayObject | null>(null);

  // Polygon edge (contour) buffers
  const polygonEdgeBuffersRef = useRef<{
    position: WebGLBuffer;
    color: WebGLBuffer;
  } | null>(null);
  const polygonEdgeVaoRef = useRef<WebGLVertexArrayObject | null>(null);

  const { annotationTypes, version: annotationTypesVersion } = useAnnotationTypes();
  const slideInfo = useSelector((state: RootState) => state.svsPath.slideInfo);
  const shapeData = useSelector((state: RootState) => state.shape.shapeData); // Lastest shape data drawn by annotorious
  const filterHighlightIndices = useSelector((state: RootState) => state.shape.filterHighlightIndices);
  const highlightGtAnnotations = useSelector((state: RootState) => state.viewerSettings.highlightGtAnnotations);
  const gtHighlightNucleiIndices = useSelector((state: RootState) => state.gtHighlight.nucleiIndices);
  const [liveRectangleCoords, setLiveRectangleCoords] = useState<RectangleCoords | null>(shapeData?.rectangleCoords || null);

  // Memoize rectangleCoords to avoid unnecessary re-renders
  const rectangleCoords = useMemo(() => shapeData?.rectangleCoords || null, [
    shapeData?.rectangleCoords
  ]);

  // Update liveRectangleCoords when rectangleCoords changes
  useEffect(() => {
    setLiveRectangleCoords(prev => {
      // Simple equality check - if coordinates are different, update
      if (!prev && !rectangleCoords) return prev;
      if (!prev || !rectangleCoords) return rectangleCoords;
      if (prev.x1 !== rectangleCoords.x1 || prev.y1 !== rectangleCoords.y1 || 
          prev.x2 !== rectangleCoords.x2 || prev.y2 !== rectangleCoords.y2) {
        return rectangleCoords;
      }
      return prev;
    });
  }, [rectangleCoords]);

  useEffect(() => {
    if (!liveRectangleCoords) return;
    if (!viewer) return;

    const tiledImage = viewer.world.getItemAt(0);
    if (!tiledImage) return;

    const contentSize = tiledImage.getContentSize();
    if (contentSize.x === 0 || contentSize.y === 0) {
      // Don't set liveRectangleCoords to null here as it causes infinite loop
      // Instead, just return early
      return;
    }

    let imgX1 = liveRectangleCoords.x1;
    let imgY1 = liveRectangleCoords.y1;
    let imgX2 = liveRectangleCoords.x2;
    let imgY2 = liveRectangleCoords.y2;

    const maxX = contentSize.x;
    const maxY = contentSize.y;
    imgX1 = Math.max(0, Math.min(maxX, imgX1));
    imgX2 = Math.max(0, Math.min(maxX, imgX2));
    imgY1 = Math.max(0, Math.min(maxY, imgY1));
    imgY2 = Math.max(0, Math.min(maxY, imgY2));

    console.log('[DrawingOverlay] Selection Coords:', { x1: imgX1.toFixed(2), y1: imgY1.toFixed(2), x2: imgX2.toFixed(2), y2: imgY2.toFixed(2) });
  }, [viewer, liveRectangleCoords]);

  // Cache for centroid data
  const centroidDataCache = useRef<{
    imageCoords: Float32Array | null;
    colors: Float32Array | null;
    count: number;
    lastDataHash: string;
  }>({
    imageCoords: null,
    colors: null,
    count: 0,
    lastDataHash: ''
  });

  // Cache for polygon data
  const polygonDataCache = useRef<{
    vertices: Float32Array | null;
    colors: Float32Array | null;
    indices: Uint32Array | null;
    count: number;
    lastDataHash: string;
  }>({
    vertices: null,
    colors: null,
    indices: null,
    count: 0,
    lastDataHash: ''
  });

  // Cache for polygon edge data
  const polygonEdgeDataCache = useRef<{
    vertices: Float32Array | null;
    colors: Float32Array | null;
    count: number;
    lastDataHash: string;
  }>({
    vertices: null,
    colors: null,
    count: 0,
    lastDataHash: ''
  });

  // Cache for hex color conversions
  const hexToRgbCache = useRef<Map<string, [number, number, number]>>(new Map());
  
  const hexToRgb = useCallback((hex: string): [number, number, number] => {
    // Check cache first
    const cached = hexToRgbCache.current.get(hex);
    if (cached !== undefined) {
      return cached;
    }
    
    // Remove prefix # (optimized: use slice instead of regex)
    const sanitizedHex = hex[0] === '#' ? hex.slice(1) : hex;
    
    // 3-bit HEX to 6-bit HEX (optimized: avoid array creation)
    let fullHex: string;
    if (sanitizedHex.length === 3) {
      // Manual expansion is faster than split/map/join
      fullHex = sanitizedHex[0] + sanitizedHex[0] + 
                sanitizedHex[1] + sanitizedHex[1] + 
                sanitizedHex[2] + sanitizedHex[2];
    } else {
      fullHex = sanitizedHex;
    }
    
    const bigint = parseInt(fullHex, 16);
    
    // Convert to normalized [0.0-1.0] range for WebGL (use pre-computed inverse)
    const result: [number, number, number] = [
      ((bigint >> 16) & 255) * INV_255,
      ((bigint >> 8) & 255) * INV_255,
      (bigint & 255) * INV_255
    ];
    
    // Cache the result
    hexToRgbCache.current.set(hex, result);
    return result;
  }, []);

  // Pre-compute polygon AABB and rectangle bounds for boundary checking
  const boundaryCheckCache = useMemo(() => {
    if (!shapeData) return null;
    
    if (shapeData.polygonPoints && shapeData.polygonPoints.length >= 3) {
      const points = shapeData.polygonPoints as [number, number][];
      
      // Pre-compute bounding box for fast rejection
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const point of points) {
        if (point[0] < minX) minX = point[0];
        if (point[0] > maxX) maxX = point[0];
        if (point[1] < minY) minY = point[1];
        if (point[1] > maxY) maxY = point[1];
      }
      
      return { 
        type: 'polygon' as const, 
        points,
        minX, maxX, minY, maxY // Bounding box for fast rejection
      };
    }
    
    if (shapeData.rectangleCoords) {
      const rect = shapeData.rectangleCoords;
      const rectX1 = rect.x1;
      const rectY1 = rect.y1;
      const rectX2 = rect.x2;
      const rectY2 = rect.y2;
      return {
        type: 'rectangle' as const,
        minX: Math.min(rectX1, rectX2),
        maxX: Math.max(rectX1, rectX2),
        minY: Math.min(rectY1, rectY2),
        maxY: Math.max(rectY1, rectY2)
      };
    }
    
    return null;
  }, [shapeData]);

  // Optimized boundary check function with fast bounding box rejection
  const checkPointInBoundary = useCallback((x: number, y: number, cache: NonNullable<typeof boundaryCheckCache>): boolean => {
    // Fast bounding box check first (rejects most points quickly)
    if (x < cache.minX || x > cache.maxX || y < cache.minY || y > cache.maxY) {
      return false;
    }

    // Point is within bounding box, do detailed check
    if (cache.type === 'rectangle') {
      return true; // Already confirmed by bounding box
    }

    // Polygon ray casting
    if (cache.type === 'polygon') {
      const points = cache.points;
      let inside = false;
      const n = points.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = points[i][0];
        const yi = points[i][1];
        const xj = points[j][0];
        const yj = points[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
          inside = !inside;
        }
      }
      return inside;
    }

    return false;
  }, []);

  // Process centroid data
  const processedCentroidData = useMemo(() => {
    const versionMarker = annotationTypesVersion;
    void versionMarker;
    const start = performance.now();

    if (!centroids.length) return { imageCoords: new Float32Array(0), colors: new Float32Array(0), count: 0 };

    const count = centroids.length;
    const bc = boundaryCheckCache;
    const hasBoundary = bc !== null;
    const filterSet = filterHighlightIndices != null ? new Set(filterHighlightIndices) : null;
    const useFilterHighlight = filterHighlightIndices != null;
    const gtSet = highlightGtAnnotations && gtHighlightNucleiIndices.length > 0 ? new Set(gtHighlightNucleiIndices) : null;

    const defaultColorR = 128 / 255;
    const defaultColorG = 128 / 255;
    const defaultColorB = 128 / 255;
    const yellowColorR = 255 / 255;
    const yellowColorG = 255 / 255;
    const yellowColorB = 0 / 255;
    const data = centroids.getData();

    // Filter-only mode (cell overlay off): only draw highlighted cells (yellow), skip the rest
    if (filterOnlyHighlight && useFilterHighlight && filterSet) {
      let n = 0;
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        if (filterSet.has(data[j]) || (gtSet && gtSet.has(data[j]))) n++;
      }
      const imageCoords = new Float32Array(n * 2);
      const colors = new Float32Array(n * 4);
      let out = 0;
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        if (!filterSet.has(data[j]) && !(gtSet && gtSet.has(data[j]))) continue;
        imageCoords[out * 2] = data[j + 1];
        imageCoords[out * 2 + 1] = data[j + 2];
        colors[out * 4] = yellowColorR;
        colors[out * 4 + 1] = yellowColorG;
        colors[out * 4 + 2] = yellowColorB;
        colors[out * 4 + 3] = Math.min(overlayAlpha + 0.2, 1.0);
        out++;
      }
      return { imageCoords, colors, count: n };
    }

    const imageCoords = new Float32Array(count * 2);
    const colors = new Float32Array(count * 4);

    if (hasBoundary) {
      // Path with boundary checking
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        const idx = data[j];
        const x = data[j + 1];
        const y = data[j + 2];
        const class_id = data[j + 3];

        imageCoords[i * 2] = x;
        imageCoords[i * 2 + 1] = y;

        const inBoundary = checkPointInBoundary(x, y, bc!);
        const gtHighlight = gtSet ? gtSet.has(idx) : false;
        const isHighlighted = gtHighlight || (useFilterHighlight
          ? (inBoundary && filterSet!.has(idx))
          : inBoundary);

        if (isHighlighted) {
          colors[i * 4] = yellowColorR;
          colors[i * 4 + 1] = yellowColorG;
          colors[i * 4 + 2] = yellowColorB;
          colors[i * 4 + 3] = Math.min(overlayAlpha + 0.2, 1.0);
        } else {
        // prob < threshold or not this class: no yellow highlight, normal class color
        let r = defaultColorR, g = defaultColorG, b = defaultColorB;
        const annotationOverride = annotationTypes.get(String(idx));
        if (annotationOverride) {
          const color = hexToRgb(annotationOverride.color || '#808080');
            r = color[0];
            g = color[1];
            b = color[2];
          } else if (class_id > -1 && nucleiClasses && class_id < nucleiClasses.length) {
            const color = hexToRgb(nucleiClasses[class_id].color || '#808080');
            r = color[0];
            g = color[1];
            b = color[2];
          }
          colors[i * 4] = r;
          colors[i * 4 + 1] = g;
          colors[i * 4 + 2] = b;
          colors[i * 4 + 3] = overlayAlpha;
        }
      }
    } else {
      // Fast path: no boundary checking
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        const idx = data[j];
        const x = data[j + 1];
        const y = data[j + 2];
        const class_id = data[j + 3];

        imageCoords[i * 2] = x;
        imageCoords[i * 2 + 1] = y;

        const gtHighlight = gtSet ? gtSet.has(idx) : false;
        let r = defaultColorR, g = defaultColorG, b = defaultColorB;
        if (gtHighlight) {
          r = yellowColorR;
          g = yellowColorG;
          b = yellowColorB;
        } else {
        const annotationOverride = annotationTypes.get(String(idx));
        if (annotationOverride) {
          const color = hexToRgb(annotationOverride.color || '#808080');
          r = color[0];
          g = color[1];
          b = color[2];
        } else if (class_id > -1 && nucleiClasses && class_id < nucleiClasses.length) {
          const color = hexToRgb(nucleiClasses[class_id].color || '#808080');
          r = color[0];
          g = color[1];
          b = color[2];
        }
        }
        colors[i * 4] = r;
        colors[i * 4 + 1] = g;
        colors[i * 4 + 2] = b;
        colors[i * 4 + 3] = gtHighlight ? Math.min(overlayAlpha + 0.2, 1.0) : overlayAlpha;
      }
    }

    const end = performance.now();
    console.log(`processedCentroidData computation time: ${(end - start).toFixed(2)}ms for ${count} centroids`);

    return { imageCoords, colors, count };
  }, [centroids, annotationTypes, annotationTypesVersion, nucleiClasses, boundaryCheckCache, filterHighlightIndices, filterOnlyHighlight, highlightGtAnnotations, gtHighlightNucleiIndices, hexToRgb, checkPointInBoundary, overlayAlpha]);

  // Process polygon data (filled)
  const processedPolygonData = useMemo(() => {
    const versionMarker = annotationTypesVersion;
    void versionMarker;

    if (filterOnlyHighlight) return { vertices: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0), count: 0 };
    if (!annotations.length) return { vertices: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0), count: 0 };

    let totalVertices = 0;
    let totalIndices = 0;
    annotations.forEach(annotation => {
      const points = annotation.points;
      if (points && Array.isArray(points) && points.length >= 3) {
        totalVertices += points.length;
        totalIndices += (points.length - 2) * 3;
      }
    });

    if (totalVertices === 0) {
      return { vertices: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0), count: 0 };
    }

    const vertices = new Float32Array(totalVertices * 2);
    const colors = new Float32Array(totalVertices * 4);
    // Use 32-bit indices to support large vertex counts (>65535)
    const indices = new Uint32Array(totalIndices);
    let vertexIndex = 0;
    let indexIndex = 0;
    let baseVertex = 0;

    annotations.forEach(annotation => {
      const points = annotation.points;

      if (points && Array.isArray(points) && points.length >= 3) {
        // Use same color logic as centroid mode
        let finalColor = [128, 128, 128]; // Default gray #808080

        // First, check for a manual override. This takes highest priority.
        const override = annotation?.id != null ? annotationTypes.get(String(annotation.id)) : null;
        if (override) {
          finalColor = hexToRgb(override.color || '#808080');
        }
        // If no manual override, use the backend-provided class ID.
        else if (annotation.class_id !== undefined && annotation.class_id > -1 && nucleiClasses && annotation.class_id < nucleiClasses.length) {
          finalColor = hexToRgb(nucleiClasses[annotation.class_id].color || '#808080');
        }
        // Fallback to annotation color if available
        else if (annotation.color) {
          finalColor = hexToRgb(annotation.color);
        }

        // For fill, always use base color; highlight handled by edge pass

        points.forEach((point: number[], i: number) => {
          vertices[vertexIndex * 2] = point[0];
          vertices[vertexIndex * 2 + 1] = point[1];

          colors[vertexIndex * 4] = finalColor[0];
          colors[vertexIndex * 4 + 1] = finalColor[1];
          colors[vertexIndex * 4 + 2] = finalColor[2];
          colors[vertexIndex * 4 + 3] = overlayAlpha;

          vertexIndex++;
        });

        for (let i = 1; i < points.length - 1; i++) {
          indices[indexIndex++] = baseVertex;
          indices[indexIndex++] = baseVertex + i;
          indices[indexIndex++] = baseVertex + i + 1;
        }

        baseVertex += points.length;
      }
    });

    return {
      vertices,
      colors,
      indices,
      count: indexIndex
    };
  }, [annotations, annotationTypes, annotationTypesVersion, hexToRgb, nucleiClasses, overlayAlpha, filterOnlyHighlight]);

  // Find centroid id (index) nearest to (cx, cy); centroids are [id, x, y, classId] per row, same scale as boundary
  const findNearestCentroidId = useCallback((cx: number, cy: number): number | null => {
    if (!centroids.length) return null;
    const data = centroids.getData();
    const count = centroids.length;
    let bestId: number | null = null;
    let bestD2 = Infinity;
    for (let i = 0, j = 0; i < count; i++, j += 4) {
      const x = data[j + 1];
      const y = data[j + 2];
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestId = data[j];
      }
    }
    return bestId;
  }, [centroids]);

  // Process polygon edge data (contours) — WebGL highlight is the contour (yellow edges).
  // With selection: when filterHighlightIndices set, only show contours for highlighted (prob >= threshold); else show all in region.
  const processedPolygonEdgeData = useMemo(() => {
    if (!annotations.length) return { vertices: new Float32Array(0), colors: new Float32Array(0), count: 0 };

    const bc = boundaryCheckCache;
    const hasBoundary = bc !== null;
    const filterSet = filterHighlightIndices != null ? new Set(filterHighlightIndices) : null;
    const useFilterHighlight = filterHighlightIndices != null;
    const gtSet = highlightGtAnnotations && gtHighlightNucleiIndices.length > 0 ? new Set(gtHighlightNucleiIndices) : null;

    let totalEdgeVertices = 0;
    annotations.forEach(annotation => {
      const points = annotation.points;

      if (points && Array.isArray(points) && points.length >= 2) {
        const pointsArray = points as [number, number][];
        if (!pointsArray || pointsArray.length < 2) return;
        let centerX = 0, centerY = 0;
        for (const p of pointsArray) { centerX += p[0]; centerY += p[1]; }
        centerX /= pointsArray.length; centerY /= pointsArray.length;
        const inBoundary = hasBoundary ? checkPointInBoundary(centerX, centerY, bc!) : false;
        const cellId = Number(annotation.id);
        const nearestId = Number.isFinite(cellId) ? null : findNearestCentroidId(centerX, centerY);
        const idInSet = useFilterHighlight
          ? (Number.isFinite(cellId) ? filterSet!.has(cellId) : (nearestId !== null && filterSet!.has(nearestId)))
          : true;
        const gtHighlight = gtSet ? (Number.isFinite(cellId) ? gtSet.has(cellId) : (nearestId !== null && gtSet.has(nearestId))) : false;
        // When filter highlight is active: show contour if id is in set (no boundary required).
        // GT highlight: always show contour for user-annotated (GT) indices.
        const isHighlighted = gtHighlight || (useFilterHighlight ? idInSet : (inBoundary && idInSet));

        if (isHighlighted) {
          totalEdgeVertices += pointsArray.length * 2;
        }
      }
    });

    if (totalEdgeVertices === 0) {
      return { vertices: new Float32Array(0), colors: new Float32Array(0), count: 0 };
    }

    const edgeVertices = new Float32Array(totalEdgeVertices * 2);
    const edgeColors = new Float32Array(totalEdgeVertices * 4);
    let edgeVertexIndex = 0;
    const stroke = [1.0, 1.0, 0.0, Math.min(overlayAlpha + 0.5, 1.0)];

    annotations.forEach(annotation => {
      const points = annotation.points;

      if (points && Array.isArray(points) && points.length >= 2) {
        const pointsArray = points as [number, number][];
        if (!pointsArray || pointsArray.length < 2) return;

        let centerX = 0, centerY = 0;
        for (const p of pointsArray) { centerX += p[0]; centerY += p[1]; }
        centerX /= pointsArray.length; centerY /= pointsArray.length;

        const inBoundary = hasBoundary ? checkPointInBoundary(centerX, centerY, bc!) : false;
        const cellId = Number(annotation.id);
        const nearestId = Number.isFinite(cellId) ? null : findNearestCentroidId(centerX, centerY);
        const idInSet = useFilterHighlight
          ? (Number.isFinite(cellId) ? filterSet!.has(cellId) : (nearestId !== null && filterSet!.has(nearestId)))
          : true;
        const gtHighlight = gtSet ? (Number.isFinite(cellId) ? gtSet.has(cellId) : (nearestId !== null && gtSet.has(nearestId))) : false;
        const isHighlighted = gtHighlight || (useFilterHighlight ? idInSet : (inBoundary && idInSet));

        if (!isHighlighted) return;

        for (let i = 0; i < pointsArray.length; i++) {
          const a = pointsArray[i];
          const b = pointsArray[(i + 1) % pointsArray.length];

          edgeVertices[edgeVertexIndex * 2] = a[0];
          edgeVertices[edgeVertexIndex * 2 + 1] = a[1];
          edgeColors[edgeVertexIndex * 4] = stroke[0];
          edgeColors[edgeVertexIndex * 4 + 1] = stroke[1];
          edgeColors[edgeVertexIndex * 4 + 2] = stroke[2];
          edgeColors[edgeVertexIndex * 4 + 3] = stroke[3];
          edgeVertexIndex++;

          edgeVertices[edgeVertexIndex * 2] = b[0];
          edgeVertices[edgeVertexIndex * 2 + 1] = b[1];
          edgeColors[edgeVertexIndex * 4] = stroke[0];
          edgeColors[edgeVertexIndex * 4 + 1] = stroke[1];
          edgeColors[edgeVertexIndex * 4 + 2] = stroke[2];
          edgeColors[edgeVertexIndex * 4 + 3] = stroke[3];
          edgeVertexIndex++;
        }
      }
    });

    return {
      vertices: edgeVertices,
      colors: edgeColors,
      count: edgeVertexIndex
    };
  }, [annotations, boundaryCheckCache, checkPointInBoundary, overlayAlpha, filterHighlightIndices, highlightGtAnnotations, gtHighlightNucleiIndices, findNearestCentroidId]);

  const redraw = useCallback(() => {
    const gl = glRef.current;
    const canvas = overlayRef.current;

    if (!gl || !isWebGL2Context(gl) || !canvas || !viewer || !centroidProgramRef.current || !polygonProgramRef.current ||
      !centroidBuffersRef.current || !polygonBuffersRef.current ||
      !centroidVaoRef.current || !polygonVaoRef.current) return;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const zoom = viewer.viewport.getZoom(true);
    const rawPointSize = (centroidSize * 0.8) + 3.5* Math.log(Math.max(zoom, 1e-6));
    const pointSize = Math.max(rawPointSize, 0.8); // Avoid negative sizes
    const flipped = viewer.viewport.getFlip();

    // Setup transformation matrices
    const tiledImageInstance = viewer.world.getItemAt(0);
    if (!tiledImageInstance) return;
    const scale = 1;
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

    // gl-matrix Acceleration
    const imageToViewportMat = mat2d.create();
    mat2d.scale(imageToViewportMat, imageToViewportMat, [
      1 / dimX * scale,
      1 / dimY / contentAspectX * scale
    ]);

    const rotationMat = mat2d.create();
    const center = viewer.viewport.getCenter(true);
    // @ts-ignore - getRotation supports current parameter but types are incomplete
    const rotationDegree = viewer.viewport.getRotation(true); // Get current rotation degree
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

    // Convert mat2d to mat3 for shader
    const imageToViewerMat3 = [
      imageToViewerMat[0], imageToViewerMat[1], 0,
      imageToViewerMat[2], imageToViewerMat[3], 0,
      imageToViewerMat[4], imageToViewerMat[5], 1
    ];

    // Apply flip effect similar to annotorious-openseadragon's approach
    if (flipped) {
      imageToViewerMat3[0] = -imageToViewerMat3[0];
      imageToViewerMat3[3] = -imageToViewerMat3[3];
      imageToViewerMat3[6] = canvas.width - imageToViewerMat3[6];
    }

    // Draw centroids if available
    if (centroidDataCache.current.count > 0 && 
        centroidDataCache.current.imageCoords && 
        centroidDataCache.current.imageCoords.length > 0) {
      gl.useProgram(centroidProgramRef.current);
      gl.bindVertexArray(centroidVaoRef.current);

      // Get uniform locations
      const uScaleLoc = gl.getUniformLocation(centroidProgramRef.current, 'u_scale');
      const uImageToViewerLoc = gl.getUniformLocation(centroidProgramRef.current, 'u_imageToViewer');
      const uCanvasSizeLoc = gl.getUniformLocation(centroidProgramRef.current, 'u_canvasSize');

      if (uScaleLoc === null || uImageToViewerLoc === null || uCanvasSizeLoc === null) {
        console.error('Failed to get uniform locations for centroid program');
        return;
      }

      // Set uniforms
      const u_scale = [pointSize / canvas.width, pointSize / canvas.height];
      gl.uniform2fv(uScaleLoc, u_scale);
      gl.uniform2fv(uCanvasSizeLoc, [canvas.width, canvas.height]);
      gl.uniformMatrix3fv(uImageToViewerLoc, false, imageToViewerMat3);

      // Draw centroids - ensure count doesn't exceed buffer size
      const centroidCount = centroidDataCache.current.count;
      const maxCentroidInstances = centroidDataCache.current.imageCoords.length / 2;
      const safeCentroidCount = Math.min(centroidCount, maxCentroidInstances);
      if (safeCentroidCount > 0 && safeCentroidCount <= maxCentroidInstances) {
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 48, safeCentroidCount);
      }
    }

    // Draw polygons (filled) if available
    if (polygonDataCache.current.count > 0 && 
        polygonDataCache.current.indices && 
        polygonDataCache.current.indices.length > 0) {
      gl.useProgram(polygonProgramRef.current);
      gl.bindVertexArray(polygonVaoRef.current);

      // Get uniform locations
      const uImageToViewerLoc = gl.getUniformLocation(polygonProgramRef.current, 'u_imageToViewer');
      const uCanvasSizeLoc = gl.getUniformLocation(polygonProgramRef.current, 'u_canvasSize');

      if (uImageToViewerLoc === null || uCanvasSizeLoc === null) {
        console.error('Failed to get uniform locations for polygon program');
        return;
      }

      // Set uniforms
      gl.uniform2fv(uCanvasSizeLoc, [canvas.width, canvas.height]);
      gl.uniformMatrix3fv(uImageToViewerLoc, false, imageToViewerMat3);

      // Bind element array buffer
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, polygonBuffersRef.current.indices);
      // Render filled triangles (using 32-bit indices) - ensure count doesn't exceed buffer size
      const polygonIndexCount = polygonDataCache.current.count;
      const maxPolygonIndices = polygonDataCache.current.indices.length;
      const safePolygonIndexCount = Math.min(polygonIndexCount, maxPolygonIndices);
      if (safePolygonIndexCount > 0 && safePolygonIndexCount <= maxPolygonIndices) {
        gl.drawElements(gl.TRIANGLES, safePolygonIndexCount, gl.UNSIGNED_INT, 0);
      }
    }

    // Draw highlighted polygon edges (contours) if available
    if (polygonEdgeDataCache.current.count > 0 && 
        polygonEdgeVaoRef.current && 
        polygonEdgeBuffersRef.current &&
        polygonEdgeDataCache.current.vertices &&
        polygonEdgeDataCache.current.vertices.length > 0) {
      gl.useProgram(polygonProgramRef.current);
      gl.bindVertexArray(polygonEdgeVaoRef.current);

      const uImageToViewerLoc2 = gl.getUniformLocation(polygonProgramRef.current, 'u_imageToViewer');
      const uCanvasSizeLoc2 = gl.getUniformLocation(polygonProgramRef.current, 'u_canvasSize');
      if (uImageToViewerLoc2 && uCanvasSizeLoc2) {
        gl.uniform2fv(uCanvasSizeLoc2, [canvas.width, canvas.height]);
        gl.uniformMatrix3fv(uImageToViewerLoc2, false, imageToViewerMat3);
      }

      // Note: line width is implementation-defined; many browsers clamp to 1
      // Ensure count doesn't exceed buffer size
      const edgeVertexCount = polygonEdgeDataCache.current.count;
      const maxEdgeVertices = polygonEdgeDataCache.current.vertices.length / 2;
      const safeEdgeVertexCount = Math.min(edgeVertexCount, maxEdgeVertices);
      if (safeEdgeVertexCount > 0 && safeEdgeVertexCount <= maxEdgeVertices) {
        gl.drawArrays(gl.LINES, 0, safeEdgeVertexCount);
      }
    }

    gl.bindVertexArray(null);
  }, [viewer, centroidSize, overlayAlpha]);

  // WebGL setup
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !viewer) return;

    // Generate a consistent context ID for this canvas
    const contextId = canvas.id || `drawing_overlay_${Date.now()}`;
    canvas.id = contextId; // Set the ID on the canvas for consistency

    // Use WebGL context manager to create context
    const gl = webglContextManager.createContext(canvas, 'webgl2', {
      preserveDrawingBuffer: true
    });
    
    if (!gl || !isWebGL2Context(gl)) {
      console.error('WebGL 2.0 not supported or context creation failed');
      return;
    }
    glRef.current = gl;

    // Create centroid program
    const centroidVertexShader = createShader(gl, gl.VERTEX_SHADER, centroidVertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!centroidVertexShader || !fragmentShader) return;

    const centroidProgram = createProgram(gl, centroidVertexShader, fragmentShader);
    if (!centroidProgram) return;
    centroidProgramRef.current = centroidProgram;

    // Create polygon program
    const polygonVertexShader = createShader(gl, gl.VERTEX_SHADER, polygonVertexShaderSource);
    if (!polygonVertexShader) return;

    const polygonProgram = createProgram(gl, polygonVertexShader, fragmentShader);
    if (!polygonProgram) return;
    polygonProgramRef.current = polygonProgram;

    // Cleanup shaders
    gl.deleteShader(centroidVertexShader);
    gl.deleteShader(polygonVertexShader);
    gl.deleteShader(fragmentShader);

    // Setup centroid VAO and buffers
    const centroidVao = gl.createVertexArray();
    if (!centroidVao) return;
    centroidVaoRef.current = centroidVao;
    gl.bindVertexArray(centroidVao);

    const centroidPositionBuffer = gl.createBuffer();
    const centroidColorBuffer = gl.createBuffer();
    const centroidImageCoordsBuffer = gl.createBuffer();
    if (!centroidPositionBuffer || !centroidColorBuffer || !centroidImageCoordsBuffer) return;

    centroidBuffersRef.current = {
      position: centroidPositionBuffer,
      color: centroidColorBuffer,
      imageCoords: centroidImageCoordsBuffer,
    };

    // Create and upload circle vertices (only once)
    const circleVertices = createCircleVertices(16);
    gl.bindBuffer(gl.ARRAY_BUFFER, centroidPositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(circleVertices), gl.STATIC_DRAW);

    // Set up position attribute
    const positionLocation = gl.getAttribLocation(centroidProgram, "a_position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    // Set up image coordinates attribute
    const imageCoordsLocation = gl.getAttribLocation(centroidProgram, "a_imageCoords");
    gl.bindBuffer(gl.ARRAY_BUFFER, centroidImageCoordsBuffer);
    gl.enableVertexAttribArray(imageCoordsLocation);
    gl.vertexAttribPointer(imageCoordsLocation, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(imageCoordsLocation, 1);

    // Set up color attribute
    const colorLocation = gl.getAttribLocation(centroidProgram, "a_color");
    gl.bindBuffer(gl.ARRAY_BUFFER, centroidColorBuffer);
    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(colorLocation, 1);

    // Setup polygon VAO and buffers
    const polygonVao = gl.createVertexArray();
    if (!polygonVao) return;
    polygonVaoRef.current = polygonVao;
    gl.bindVertexArray(polygonVao);

    const polygonPositionBuffer = gl.createBuffer();
    const polygonColorBuffer = gl.createBuffer();
    const polygonIndicesBuffer = gl.createBuffer();
    if (!polygonPositionBuffer || !polygonColorBuffer || !polygonIndicesBuffer) return;

    polygonBuffersRef.current = {
      position: polygonPositionBuffer,
      color: polygonColorBuffer,
      indices: polygonIndicesBuffer,
    };

    // Set up position attribute for polygons
    gl.bindBuffer(gl.ARRAY_BUFFER, polygonPositionBuffer);
    const polygonPositionLocation = gl.getAttribLocation(polygonProgram, "a_position");
    gl.enableVertexAttribArray(polygonPositionLocation);
    gl.vertexAttribPointer(polygonPositionLocation, 2, gl.FLOAT, false, 0, 0);

    // Set up color attribute for polygons
    gl.bindBuffer(gl.ARRAY_BUFFER, polygonColorBuffer);
    const polygonColorLocation = gl.getAttribLocation(polygonProgram, "a_color");
    gl.enableVertexAttribArray(polygonColorLocation);
    gl.vertexAttribPointer(polygonColorLocation, 4, gl.FLOAT, false, 0, 0);

    // Bind indices buffer
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, polygonIndicesBuffer);

    gl.bindVertexArray(null);

    // Setup polygon edge VAO and buffers (for contour drawing)
    const polygonEdgeVao = gl.createVertexArray();
    if (!polygonEdgeVao) return;
    polygonEdgeVaoRef.current = polygonEdgeVao;
    gl.bindVertexArray(polygonEdgeVao);

    const polygonEdgePositionBuffer = gl.createBuffer();
    const polygonEdgeColorBuffer = gl.createBuffer();
    if (!polygonEdgePositionBuffer || !polygonEdgeColorBuffer) return;

    polygonEdgeBuffersRef.current = {
      position: polygonEdgePositionBuffer,
      color: polygonEdgeColorBuffer,
    };

    // Set up position attribute for edges
    gl.bindBuffer(gl.ARRAY_BUFFER, polygonEdgePositionBuffer);
    const polygonEdgePositionLocation = gl.getAttribLocation(polygonProgram, "a_position");
    gl.enableVertexAttribArray(polygonEdgePositionLocation);
    gl.vertexAttribPointer(polygonEdgePositionLocation, 2, gl.FLOAT, false, 0, 0);

    // Set up color attribute for edges
    gl.bindBuffer(gl.ARRAY_BUFFER, polygonEdgeColorBuffer);
    const polygonEdgeColorLocation = gl.getAttribLocation(polygonProgram, "a_color");
    gl.enableVertexAttribArray(polygonEdgeColorLocation);
    gl.vertexAttribPointer(polygonEdgeColorLocation, 4, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // Setup WebGL state once
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    return () => {
      if (gl) {
        if (centroidProgramRef.current) {
          gl.deleteProgram(centroidProgramRef.current);
        }
        if (polygonProgramRef.current) {
          gl.deleteProgram(polygonProgramRef.current);
        }
        if (centroidVaoRef.current) {
          gl.deleteVertexArray(centroidVaoRef.current);
        }
        if (polygonVaoRef.current) {
          gl.deleteVertexArray(polygonVaoRef.current);
        }
        if (polygonEdgeVaoRef.current) {
          gl.deleteVertexArray(polygonEdgeVaoRef.current);
        }
        if (centroidBuffersRef.current) {
          gl.deleteBuffer(centroidBuffersRef.current.position);
          gl.deleteBuffer(centroidBuffersRef.current.color);
          gl.deleteBuffer(centroidBuffersRef.current.imageCoords);
        }
        if (polygonBuffersRef.current) {
          gl.deleteBuffer(polygonBuffersRef.current.position);
          gl.deleteBuffer(polygonBuffersRef.current.color);
          gl.deleteBuffer(polygonBuffersRef.current.indices);
        }
        if (polygonEdgeBuffersRef.current) {
          gl.deleteBuffer(polygonEdgeBuffersRef.current.position);
          gl.deleteBuffer(polygonEdgeBuffersRef.current.color);
        }
        
        // Use WebGL context manager to release context
        if (canvas && canvas.id) {
          webglContextManager.releaseContext(canvas.id);
        }
      }
    };
  }, [viewer]);

  // OSD viewport update handler
  useEffect(() => {
    if (!viewer) return;

    const resizeCanvas = () => {
      const canvas = overlayRef.current;
      const gl = glRef.current;
      const viewerCanvas = viewer.canvas;
      if (!canvas || !gl || !viewerCanvas) return;

      canvas.width = viewerCanvas.clientWidth;
      canvas.height = viewerCanvas.clientHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const updateOverlay = () => {
      resizeCanvas();
      redraw();
    };

    updateOverlay();

    viewer.addHandler("update-viewport", updateOverlay);

    return () => {
      viewer.removeHandler("update-viewport", updateOverlay);
    };
  }, [viewer, redraw]);

  // Update centroid data
  useEffect(() => {
    if (!glRef.current || !centroidBuffersRef.current) return;

    const gl = glRef.current;
    const currentHash = `${processedCentroidData.count}_${Array.from(processedCentroidData.imageCoords.slice(0, 4)).join(',')}`;

    if (processedCentroidData.count === 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, centroidBuffersRef.current.imageCoords);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, centroidBuffersRef.current.color);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
      // Update cache to reflect empty state
      centroidDataCache.current = {
        imageCoords: new Float32Array(0),
        colors: new Float32Array(0),
        count: 0,
        lastDataHash: currentHash
      };
      redraw();
      return;
    }

    // Always update buffers when data changes
    gl.bindBuffer(gl.ARRAY_BUFFER, centroidBuffersRef.current.imageCoords);
    gl.bufferData(gl.ARRAY_BUFFER, processedCentroidData.imageCoords, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, centroidBuffersRef.current.color);
    gl.bufferData(gl.ARRAY_BUFFER, processedCentroidData.colors, gl.STATIC_DRAW);

    centroidDataCache.current = {
      imageCoords: processedCentroidData.imageCoords,
      colors: processedCentroidData.colors,
      count: processedCentroidData.count,
      lastDataHash: currentHash
    };

    // Force redraw immediately - this will clear the buffer if count is 0
    redraw();
  }, [processedCentroidData, redraw]);

  // Update polygon data
  useEffect(() => {
    if (!glRef.current || !polygonBuffersRef.current) return;

    const gl = glRef.current;
    const currentHash = `${processedPolygonData.count}_${Array.from(processedPolygonData.vertices.slice(0, 4)).join(',')}`;

    if (processedPolygonData.count === 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, polygonBuffersRef.current.position);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, polygonBuffersRef.current.color);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, polygonBuffersRef.current.indices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(0), gl.STATIC_DRAW);
      // Update cache to reflect empty state
      polygonDataCache.current = {
        vertices: new Float32Array(0),
        colors: new Float32Array(0),
        indices: new Uint32Array(0),
        count: 0,
        lastDataHash: currentHash
      };
      redraw();
      return;
    }

    // Always update buffers when data changes
    gl.bindBuffer(gl.ARRAY_BUFFER, polygonBuffersRef.current.position);
    gl.bufferData(gl.ARRAY_BUFFER, processedPolygonData.vertices, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, polygonBuffersRef.current.color);
    gl.bufferData(gl.ARRAY_BUFFER, processedPolygonData.colors, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, polygonBuffersRef.current.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, processedPolygonData.indices, gl.STATIC_DRAW);

    polygonDataCache.current = {
      vertices: processedPolygonData.vertices,
      colors: processedPolygonData.colors,
      indices: processedPolygonData.indices,
      count: processedPolygonData.count,
      lastDataHash: currentHash
    };

    redraw();
  }, [processedPolygonData, redraw]);

  // Update polygon edge data
  useEffect(() => {
    if (!glRef.current || !polygonEdgeBuffersRef.current) return;

    const gl = glRef.current;
    const currentHash = `${processedPolygonEdgeData.count}_${Array.from(processedPolygonEdgeData.vertices.slice(0, 4)).join(',')}`;

    if (processedPolygonEdgeData.count === 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, polygonEdgeBuffersRef.current.position);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, polygonEdgeBuffersRef.current.color);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
      // Update cache to reflect empty state
      polygonEdgeDataCache.current = {
        vertices: new Float32Array(0),
        colors: new Float32Array(0),
        count: 0,
        lastDataHash: currentHash
      };
      redraw();
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, polygonEdgeBuffersRef.current.position);
    gl.bufferData(gl.ARRAY_BUFFER, processedPolygonEdgeData.vertices, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, polygonEdgeBuffersRef.current.color);
    gl.bufferData(gl.ARRAY_BUFFER, processedPolygonEdgeData.colors, gl.STATIC_DRAW);

    polygonEdgeDataCache.current = {
      vertices: processedPolygonEdgeData.vertices,
      colors: processedPolygonEdgeData.colors,
      count: processedPolygonEdgeData.count,
      lastDataHash: currentHash
    };

    redraw();
  }, [processedPolygonEdgeData, redraw]);

  return (
    <canvas
      ref={overlayRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none"
      }}
    />
  );
};

export default DrawingOverlay;
