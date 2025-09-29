import React, { useRef, useEffect, useMemo, useCallback, useState } from "react";
import OpenSeadragon from "openseadragon";
import { useSelector } from "react-redux";
import { RootState } from "@/store";
import { mat2d } from "gl-matrix";
import { RectangleCoords, ShapeData } from "@/store/slices/shapeSlice";
import { webglContextManager } from '@/utils/webglContextManager';

const ZOOM_SCALE = 16; // same constant as in viewer component

interface DrawingOverlayProps {
  viewer: OpenSeadragon.Viewer | null;
  centroids: Array<[number, number, number, number]>; // [id, x, y, class_id]
  threshold: number;
  classificationData?: {
    nuclei_class_id: number[];
    nuclei_class_name: string[];
    nuclei_class_HEX_color: string[];
  } | null;
  annotations: any[];
  nucleiClasses: { name: string, color: string, count: number }[];
}

interface AnnotationBody {
  id: string;
  annotation: string;
  type: string;
  purpose: string;
  value: string;
  created: string;
  creator: {
    id: string;
    type: string;
  };
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

  // Convert rectangle coordinates to image coordinates (same scale as centroids)
  const rectX1 = rect.x1 * ZOOM_SCALE;
  const rectY1 = rect.y1 * ZOOM_SCALE;
  const rectX2 = rect.x2 * ZOOM_SCALE;
  const rectY2 = rect.y2 * ZOOM_SCALE;

  // Check if point is inside rectangle
  return x >= Math.min(rectX1, rectX2) && x <= Math.max(rectX1, rectX2) &&
    y >= Math.min(rectY1, rectY2) && y <= Math.max(rectY1, rectY2);
}

// Check if a point is inside a polygon using ray casting algorithm
const isPointInPolygon = (x: number, y: number, polygonPoints: [number, number][] | null): boolean => {
  if (!polygonPoints || polygonPoints.length < 3) return false;

  // Convert polygon points to image coordinates (same scale as centroids)
  const scaledPolygonPoints = polygonPoints.map(point => [
    point[0] * ZOOM_SCALE,
    point[1] * ZOOM_SCALE
  ]);

  let inside = false;
  const n = scaledPolygonPoints.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = scaledPolygonPoints[i][0];
    const yi = scaledPolygonPoints[i][1];
    const xj = scaledPolygonPoints[j][0];
    const yj = scaledPolygonPoints[j][1];

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
  nucleiClasses
}) => {
  const centroidSize = useSelector((state: RootState) => state.viewerSettings.centroidSize) ?? 1.5;
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

  const annotationTypes = useSelector((state: RootState) => state.annotations?.annotationTypeMap || {});
  const slideInfo = useSelector((state: RootState) => state.svsPath.slideInfo);
  const shapeData = useSelector((state: RootState) => state.shape.shapeData); // Lastest shape data drawn by annotorious
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

    let imgX1 = liveRectangleCoords.x1 * ZOOM_SCALE;
    let imgY1 = liveRectangleCoords.y1 * ZOOM_SCALE;
    let imgX2 = liveRectangleCoords.x2 * ZOOM_SCALE;
    let imgY2 = liveRectangleCoords.y2 * ZOOM_SCALE;

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

  const hexToRgb = (hex: string) => {
    // remove prefix #
    const sanitizedHex = hex.replace(/^#/, '');
    // 3 bit HEX to 6 bit HEX
    const fullHex = sanitizedHex.length === 3
      ? sanitizedHex.split('').map(c => c + c).join('')
      : sanitizedHex;
    const bigint = parseInt(fullHex, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return [r, g, b];
  }

  // Boundary check for centroid-in-ROI rule. Prefer polygon points when available.
  const isPointInBoundary = useCallback((x: number, y: number, shapeData: ShapeData | null): boolean => {
    if (!shapeData) return false;

    if (shapeData.polygonPoints && shapeData.polygonPoints.length >= 3) {
      return isPointInPolygon(x, y, shapeData.polygonPoints);
    }

    if (shapeData.rectangleCoords) {
      return isPointInRectangle(x, y, shapeData.rectangleCoords);
    }

    return false;
  }, []);

  // Process centroid data
  const processedCentroidData = useMemo(() => {
    if (!centroids.length) return { imageCoords: new Float32Array(0), colors: new Float32Array(0), count: 0 };

    const imageCoords = new Float32Array(centroids.length * 2);
    const colors = new Float32Array(centroids.length * 4);

    for (let i = 0; i < centroids.length; i++) {
      const [idx, x, y, class_id] = centroids[i];

      // Store image coordinates
      imageCoords[i * 2] = x;
      imageCoords[i * 2 + 1] = y;

      // Default color is gray
      let finalColor = [128, 128, 128];

      // First, check for a manual override. This takes highest priority.
      if (idx in annotationTypes) {
        finalColor = hexToRgb(annotationTypes[idx].color || '#808080');
      }
      // If no manual override, use the backend-provided class ID.
      else if (class_id > -1 && nucleiClasses && class_id < nucleiClasses.length) {
        finalColor = hexToRgb(nucleiClasses[class_id].color || '#808080');
      }

      // Check if this centroid is inside the boundary selection
      const isHighlighted = isPointInBoundary(x, y, shapeData || null);

      // If highlighted, use yellow color
      if (isHighlighted) {
        finalColor = [255, 255, 0]; // Yellow
      }

      colors[i * 4] = finalColor[0] / 255;
      colors[i * 4 + 1] = finalColor[1] / 255;
      colors[i * 4 + 2] = finalColor[2] / 255;
      colors[i * 4 + 3] = isHighlighted ? 0.8 : 0.6; // Higher alpha for highlighted items
    }

    return { imageCoords, colors, count: centroids.length };
  }, [centroids, annotationTypes, nucleiClasses, shapeData, isPointInBoundary]);

  // Process polygon data (filled)
  const processedPolygonData = useMemo(() => {

    if (!annotations.length) return { vertices: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0), count: 0 };

    let totalVertices = 0;
    let totalIndices = 0;
    annotations.forEach(annotation => {
      const selectorRaw = annotation.target?.selector;
      const selector = Array.isArray(selectorRaw)
        ? selectorRaw.find((s: any) => s?.type === 'POLYGON' && s?.geometry?.points)
        : selectorRaw;
      if (selector?.type === 'POLYGON' && selector.geometry?.points) {
        const points = selector.geometry.points;
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
      const selectorRaw = annotation.target?.selector;
      const selector = Array.isArray(selectorRaw)
        ? selectorRaw.find((s: any) => s?.type === 'POLYGON' && s?.geometry?.points)
        : selectorRaw;
      if (selector?.type === 'POLYGON' && selector.geometry?.points) {
        const points = selector.geometry.points;
        // Priority: optimistic Redux override -> existing style body -> fallback gray
        const override = (annotationTypes && annotation?.id != null) ? annotationTypes[annotation.id] : undefined;
        const color = override?.color || (annotation.bodies.find((b: AnnotationBody) => b.purpose === 'style')?.value) || '#808080';
        const rgb = hexToRgb(color);

        // For fill, always use base color; highlight handled by edge pass
        const finalColor = rgb;

        points.forEach((point: number[], i: number) => {
          vertices[vertexIndex * 2] = point[0];
          vertices[vertexIndex * 2 + 1] = point[1];

          colors[vertexIndex * 4] = finalColor[0] / 255;
          colors[vertexIndex * 4 + 1] = finalColor[1] / 255;
          colors[vertexIndex * 4 + 2] = finalColor[2] / 255;
          colors[vertexIndex * 4 + 3] = 0.6;

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
  }, [annotations, annotationTypes]);

  // Process polygon edge data (contours)
  const processedPolygonEdgeData = useMemo(() => {
    if (!annotations.length) return { vertices: new Float32Array(0), colors: new Float32Array(0), count: 0 };

    let totalEdgeVertices = 0;
    // First pass: count edges for highlighted polygons
    annotations.forEach(annotation => {
      const selectorRaw = annotation.target?.selector;
      const selector = Array.isArray(selectorRaw)
        ? selectorRaw.find((s: any) => s?.type === 'POLYGON' && s?.geometry?.points)
        : selectorRaw;
      if (selector?.type === 'POLYGON' && selector.geometry?.points) {
        const points = selector.geometry.points as [number, number][];
        if (!points || points.length < 2) return;
        // Highlight check: centroid of polygon inside rectangle ROI only
        let centerX = 0, centerY = 0;
        for (const p of points) { centerX += p[0]; centerY += p[1]; }
        centerX /= points.length; centerY /= points.length;
        const isHighlighted = isPointInBoundary(centerX, centerY, shapeData || null);
        if (isHighlighted) {
          // Each edge contributes 2 vertices (start, end)
          totalEdgeVertices += points.length * 2; // including closing edge
        }
      }
    });

    if (totalEdgeVertices === 0) {
      return { vertices: new Float32Array(0), colors: new Float32Array(0), count: 0 };
    }

    const edgeVertices = new Float32Array(totalEdgeVertices * 2);
    const edgeColors = new Float32Array(totalEdgeVertices * 4);
    let edgeVertexIndex = 0;

    // Second pass: build edge vertices only for highlighted polygons
    annotations.forEach(annotation => {
      const selectorRaw = annotation.target?.selector;
      const selector = Array.isArray(selectorRaw)
        ? selectorRaw.find((s: any) => s?.type === 'POLYGON' && s?.geometry?.points)
        : selectorRaw;
      if (selector?.type === 'POLYGON' && selector.geometry?.points) {
        const points = selector.geometry.points as [number, number][];
        if (!points || points.length < 2) return;

        let centerX = 0, centerY = 0;
        for (const p of points) { centerX += p[0]; centerY += p[1]; }
        centerX /= points.length; centerY /= points.length;
        const isHighlighted = isPointInBoundary(centerX, centerY, shapeData || null);

        if (!isHighlighted) return;

        // Yellow color for highlighted edges
        const stroke = [255 / 255, 255 / 255, 0 / 255, 0.9];

        for (let i = 0; i < points.length; i++) {
          const a = points[i];
          const b = points[(i + 1) % points.length]; // closing edge

          // push segment a -> b
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
  }, [annotations, shapeData, isPointInBoundary]);

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
    if (centroidDataCache.current.count > 0) {
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

      // Draw centroids
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 48, centroidDataCache.current.count);
    }

    // Draw polygons (filled) if available
    if (polygonDataCache.current.count > 0) {
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
      // Render filled triangles (using 32-bit indices)
      gl.drawElements(gl.TRIANGLES, polygonDataCache.current.count, gl.UNSIGNED_INT, 0);
    }

    // Draw highlighted polygon edges (contours) if available
    if (polygonEdgeDataCache.current.count > 0 && polygonEdgeVaoRef.current && polygonEdgeBuffersRef.current) {
      gl.useProgram(polygonProgramRef.current);
      gl.bindVertexArray(polygonEdgeVaoRef.current);

      const uImageToViewerLoc2 = gl.getUniformLocation(polygonProgramRef.current, 'u_imageToViewer');
      const uCanvasSizeLoc2 = gl.getUniformLocation(polygonProgramRef.current, 'u_canvasSize');
      if (uImageToViewerLoc2 && uCanvasSizeLoc2) {
        gl.uniform2fv(uCanvasSizeLoc2, [canvas.width, canvas.height]);
        gl.uniformMatrix3fv(uImageToViewerLoc2, false, imageToViewerMat3);
      }

      // Note: line width is implementation-defined; many browsers clamp to 1
      gl.drawArrays(gl.LINES, 0, polygonEdgeDataCache.current.count);
    }

    gl.bindVertexArray(null);
  }, [viewer, centroidSize]);

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

    redraw();
  }, [processedCentroidData, redraw]);

  // Update polygon data
  useEffect(() => {
    if (!glRef.current || !polygonBuffersRef.current) return;

    const gl = glRef.current;
    const currentHash = `${processedPolygonData.count}_${Array.from(processedPolygonData.vertices.slice(0, 4)).join(',')}`;

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
