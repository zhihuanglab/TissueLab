import { RootState } from "@/store";
import { useAnnotationTypes } from '@/store/zustand/slice/annotationTypesStore';
import { getContourGeometry } from '@/utils/viewer/contourGeometry';
import { webglContextManager } from '@/utils/viewer/webglContextManager';
import { mat2d } from "gl-matrix";
import OpenSeadragon from "openseadragon";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSelector } from "react-redux";
import { CentroidsArray } from '@/types/centroidsArray';

/** Unique per mounted overlay canvas; see the context-id comment in the GL setup. */
let drawingOverlayCanvasSeq = 0;

interface DrawingOverlayProps {
  viewer: OpenSeadragon.Viewer | null;
  centroids: CentroidsArray; // [id, x, y, class_id]
  annotations: any[];
  nucleiClasses: { name: string, color: string, count: number }[];
  /** When true (filter mode, cell overlay off): only draw highlighted cells (yellow), not the rest */
  filterOnlyHighlight?: boolean;
}


/**
 * Palette entries the centroid shader can address. The index is one byte, so
 * 256 is the natural ceiling — not an arbitrary cap. Slot 255 is reserved for
 * the "no class" colour, which lets the shader look colour up unconditionally.
 */
const PALETTE_SIZE = 256;
/** Reserved slot holding the default grey. */
const PALETTE_INDEX_NONE = 255;
/** Usable slots for real colours: everything below the reserved one. */
const MAX_PALETTE_COLORS = PALETTE_INDEX_NONE;

// Centroid vertex shader
//
// Colour comes from a palette texture rather than per-instance vertex data: a
// recolour (selection drag) uploads one index byte + one highlight byte per
// centroid, and changing the palette or the alpha touches no vertex buffer at
// all — just a 1KB texture or a uniform.
const centroidVertexShaderSource = `#version 300 es
    uniform vec2 u_scale;
    uniform mat3 u_imageToViewer; // 3x3 matrix for 2D transformation
    uniform vec2 u_canvasSize;

    // 256x1 RGBA8. Slot 255 is the default colour, so every index is valid and
    // the lookup needs no bounds test.
    uniform sampler2D u_palette;
    uniform float u_alpha;
    uniform float u_highlightAlpha;
    uniform vec3 u_highlightColor;

    in vec2 a_position;
    in vec2 a_imageCoords; // Image coordinates instead of NDC
    // Both are plain (NOT normalised) unsigned bytes, so they arrive as 0..255.
    in float a_paletteIndex;
    in float a_highlight;

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

      vec3 base = texelFetch(u_palette, ivec2(int(a_paletteIndex + 0.5), 0), 0).rgb;
      bool highlighted = a_highlight > 0.5;
      v_color = vec4(
        highlighted ? u_highlightColor : base,
        highlighted ? u_highlightAlpha : u_alpha
      );
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

/**
 * One centroid dot, as an independent triangle list. The draw call needs the
 * vertex count, so it derives from the same constant — a literal here drew a
 * partial (or over-long) circle whenever the segment count changed.
 */
const CENTROID_CIRCLE_SEGMENTS = 16;
const CENTROID_CIRCLE_VERTICES = CENTROID_CIRCLE_SEGMENTS * 3;

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

// Ray casting over flat contour coords [x0, y0, x1, y1, ...].
const isPointInPolygon = (x: number, y: number, polygonPoints: Int32Array | null): boolean => {
  if (!polygonPoints) return false;
  const n = polygonPoints.length >> 1;
  if (n < 3) return false;

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygonPoints[i * 2];
    const yi = polygonPoints[i * 2 + 1];
    const xj = polygonPoints[j * 2];
    const yj = polygonPoints[j * 2 + 1];

    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }

  return inside;
}

const DrawingOverlay: React.FC<DrawingOverlayProps> = ({
  viewer,
  centroids,
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
    /** [paletteIndex, highlight] per instance — 2 bytes, the recolour payload. */
    attribs: WebGLBuffer;
    imageCoords: WebGLBuffer;
  } | null>(null);
  /** 256x1 RGBA8 colour lookup, re-uploaded only when the palette changes. */
  const centroidPaletteTexRef = useRef<WebGLTexture | null>(null);
  const centroidVaoRef = useRef<WebGLVertexArrayObject | null>(null);

  // Polygon program
  const polygonProgramRef = useRef<WebGLProgram | null>(null);
  const polygonBuffersRef = useRef<{
    position: WebGLBuffer;
    color: WebGLBuffer;
    indices: WebGLBuffer;
  } | null>(null);
  const polygonVaoRef = useRef<WebGLVertexArrayObject | null>(null);

  // Polygon edge (contour) buffers. Positions only — the stroke colour is a
  // constant supplied through the generic vertex attribute, not a buffer.
  const polygonEdgeBuffersRef = useRef<{
    position: WebGLBuffer;
  } | null>(null);
  const polygonEdgeVaoRef = useRef<WebGLVertexArrayObject | null>(null);
  /** `a_color` slot for the edge pass; fed a constant instead of a buffer. */
  const polygonEdgeColorLocationRef = useRef<number>(-1);
  /**
   * Uniform locations, resolved once at link time. They were looked up by name
   * on every draw — eleven string lookups per frame during a pan, for values
   * that cannot change while the program lives.
   */
  const uniformsRef = useRef<{
    centroid: {
      scale: WebGLUniformLocation | null;
      imageToViewer: WebGLUniformLocation | null;
      canvasSize: WebGLUniformLocation | null;
      palette: WebGLUniformLocation | null;
      highlightColor: WebGLUniformLocation | null;
      alpha: WebGLUniformLocation | null;
      highlightAlpha: WebGLUniformLocation | null;
    };
    polygon: {
      imageToViewer: WebGLUniformLocation | null;
      canvasSize: WebGLUniformLocation | null;
    };
  } | null>(null);

  const { annotationTypes, version: annotationTypesVersion } = useAnnotationTypes();
  const shapeData = useSelector((state: RootState) => state.shape.shapeData); // Lastest shape data drawn by annotorious
  const filterHighlightIndices = useSelector((state: RootState) => state.shape.filterHighlightIndices);
  const highlightGtAnnotations = useSelector((state: RootState) => state.viewerSettings.highlightGtAnnotations);
  const gtHighlightNucleiIndices = useSelector((state: RootState) => state.gtHighlight.nucleiIndices);
  // Click-to-inspect: which cell's class to show, and where (page coords for the
  // fixed tooltip). Mirrors MaskOverlay's tooltip but on click, not hover.
  const [classPopup, setClassPopup] = useState<{ x: number; y: number; name: string; color: string } | null>(null);
  // The class-on-click affordance is gated to the "move" (navigate) tool so it
  // never fires while the user is drawing/selecting. Ref so the OSD click
  // handler always reads the current tool without re-subscribing.
  const currentTool = useSelector((state: RootState) => state.tool.currentTool);
  const currentToolRef = useRef(currentTool);
  currentToolRef.current = currentTool;

  /**
   * What the GPU currently holds — deliberately not what the memos above hold.
   *
   * `redraw` runs from OpenSeadragon's own animation frame, so it can land after
   * a React render but before the effect that uploads that render's buffers.
   * Sizing a draw call from a memo would then issue it against the previous
   * buffer and read past its end. These are written only next to the matching
   * `bufferData`, which is why the draw calls need no bounds check.
   */
  const uploadedCentroidsRef = useRef<{
    /** Identities, to skip re-uploading data the GPU already has. */
    imageCoords: Float32Array | null;
    palette: Uint8Array | null;
    instanceCount: number;
  }>({
    imageCoords: null,
    palette: null,
    instanceCount: 0,
  });

  /** Element-buffer indices uploaded for the fill pass. */
  const uploadedPolygonIndicesRef = useRef(0);
  /** Position-buffer vertices uploaded for the edge pass. */
  const uploadedEdgeVerticesRef = useRef(0);

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

    // 0-255, the form both consumers want: the centroid palette texture stores
    // bytes, and the polygon fill buffer is a normalised unsigned byte
    // attribute the GPU converts to 0..1 on read. Normalising here and scaling
    // back would be a pointless round trip.
    const result: [number, number, number] = [
      (bigint >> 16) & 255,
      (bigint >> 8) & 255,
      bigint & 255
    ];
    
    // Cache the result
    hexToRgbCache.current.set(hex, result);
    return result;
  }, []);

  // Pre-compute polygon AABB and rectangle bounds for boundary checking
  const boundaryShape = useMemo(() => {
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
  const checkPointInBoundary = useCallback((x: number, y: number, boundary: NonNullable<typeof boundaryShape>): boolean => {
    // Fast bounding box check first (rejects most points quickly)
    if (x < boundary.minX || x > boundary.maxX || y < boundary.minY || y > boundary.maxY) {
      return false;
    }

    // Point is within bounding box, do detailed check
    if (boundary.type === 'rectangle') {
      return true; // Already confirmed by bounding box
    }

    // Polygon ray casting
    if (boundary.type === 'polygon') {
      const points = boundary.points;
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
  // Positions, split out from colours: they only change when the centroid set
  // itself changes. Selecting a region rewrites every colour but moves nothing,
  // and rebuilding 200k+ coordinates for that was pure waste — as is re-uploading
  // them (see the buffer effect, which now skips unchanged positions).
  const centroidPositions = useMemo(() => {
    if (!centroids.length) return new Float32Array(0);
    const count = centroids.length;
    const data = centroids.getData();
    const out = new Float32Array(count * 2);
    for (let i = 0, j = 0; i < count; i++, j += 4) {
      out[i * 2] = data[j + 1];
      out[i * 2 + 1] = data[j + 2];
    }
    return out;
  }, [centroids]);

  const processedCentroidData = useMemo(() => {
    // annotationTypes is a Map mutated in place; `version` is the only signal
    // that its contents changed, so it stays in the dep list unread.
    void annotationTypesVersion;

    /** 256x1 RGBA8 palette; slot PALETTE_INDEX_NONE holds the default grey. */
    const makePalette = () => {
      const texels = new Uint8Array(PALETTE_SIZE * 4);
      const o = PALETTE_INDEX_NONE * 4;
      texels[o] = 128; texels[o + 1] = 128; texels[o + 2] = 128; texels[o + 3] = 255;
      return texels;
    };

    if (!centroids.length) {
      return {
        imageCoords: new Float32Array(0),
        attribs: new Uint8Array(0),
        palette: makePalette(),
        count: 0,
      };
    }

    const count = centroids.length;
    const boundary = boundaryShape;
    const hasBoundary = boundary !== null;
    const filterSet = filterHighlightIndices != null ? new Set(filterHighlightIndices) : null;
    const useFilterHighlight = filterHighlightIndices != null;
    const gtSet = highlightGtAnnotations && gtHighlightNucleiIndices.length > 0 ? new Set(gtHighlightNucleiIndices) : null;
    const data = centroids.getData();

    // One slot per class, then one per distinct manual override colour. Override
    // colours come from a small category list, so they dedupe to a handful.
    const palette = makePalette();
    const slotOfColor = new Map<string, number>();
    const classSlot: number[] = [];
    let nextSlot = 0;
    let overflowed = false;

    const addColor = (hex: string): number => {
      const seen = slotOfColor.get(hex);
      if (seen !== undefined) return seen;
      if (nextSlot >= MAX_PALETTE_COLORS) {
        overflowed = true;
        return PALETTE_INDEX_NONE;
      }
      const rgb = hexToRgb(hex);
      const slot = nextSlot++;
      const o = slot * 4;
      palette[o] = rgb[0]; palette[o + 1] = rgb[1]; palette[o + 2] = rgb[2]; palette[o + 3] = 255;
      slotOfColor.set(hex, slot);
      return slot;
    };

    if (nucleiClasses) {
      for (let c = 0; c < nucleiClasses.length; c++) {
        classSlot.push(addColor(nucleiClasses[c].color || '#808080'));
      }
    }

    const hasOverrides = annotationTypes.size > 0;
    const overrideSlot = new Map<string, number>();
    if (hasOverrides) {
      for (const [id, entry] of annotationTypes) {
        overrideSlot.set(id, addColor(entry.color || '#808080'));
      }
    }

    if (overflowed) {
      // 255 distinct overlay colours is far past any real nuclei taxonomy; if it
      // ever happens the extras render as the default grey rather than wrong.
      console.warn(
        `[DrawingOverlay] more than ${MAX_PALETTE_COLORS} distinct overlay colours; ` +
        'the excess render in the default colour.',
      );
    }

    const slotFor = (idx: number, class_id: number): number => {
      if (hasOverrides) {
        const slot = overrideSlot.get(String(idx));
        if (slot !== undefined) return slot;
      }
      if (class_id > -1 && class_id < classSlot.length) return classSlot[class_id];
      return PALETTE_INDEX_NONE;
    };

    // Filter-only mode (cell overlay off): only highlighted cells are drawn, so
    // positions are a filtered subset rather than the shared array.
    if (filterOnlyHighlight && useFilterHighlight && filterSet) {
      let n = 0;
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        if (filterSet.has(data[j]) || (gtSet && gtSet.has(data[j]))) n++;
      }
      const imageCoords = new Float32Array(n * 2);
      const attribs = new Uint8Array(n * 2);
      let out = 0;
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        if (!filterSet.has(data[j]) && !(gtSet && gtSet.has(data[j]))) continue;
        imageCoords[out * 2] = data[j + 1];
        imageCoords[out * 2 + 1] = data[j + 2];
        attribs[out * 2] = PALETTE_INDEX_NONE; // unused: always highlighted
        attribs[out * 2 + 1] = 1;
        out++;
      }
      return { imageCoords, attribs, palette, count: n };
    }

    /** [paletteIndex, highlight] per instance. */
    const attribs = new Uint8Array(count * 2);

    if (hasBoundary) {
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        const idx = data[j];
        const inBoundary = checkPointInBoundary(data[j + 1], data[j + 2], boundary!);
        const gtHighlight = gtSet ? gtSet.has(idx) : false;
        const highlighted = gtHighlight || (useFilterHighlight
          ? (inBoundary && filterSet!.has(idx))
          : inBoundary);
        attribs[i * 2] = highlighted ? PALETTE_INDEX_NONE : slotFor(idx, data[j + 3]);
        attribs[i * 2 + 1] = highlighted ? 1 : 0;
      }
    } else {
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        const idx = data[j];
        const highlighted = gtSet ? gtSet.has(idx) : false;
        attribs[i * 2] = highlighted ? PALETTE_INDEX_NONE : slotFor(idx, data[j + 3]);
        attribs[i * 2 + 1] = highlighted ? 1 : 0;
      }
    }

    return { imageCoords: centroidPositions, attribs, palette, count };
    // Deliberately no overlayAlpha — it is a uniform, so listing it here would
    // rebuild every instance attribute each time the slider moved.
  }, [centroids, centroidPositions, annotationTypes, annotationTypesVersion, nucleiClasses, boundaryShape, filterHighlightIndices, filterOnlyHighlight, highlightGtAnnotations, gtHighlightNucleiIndices, hexToRgb, checkPointInBoundary]);

  // Process polygon data (filled)
  const processedPolygonData = useMemo(() => {
    // annotationTypes is a Map mutated in place; `version` is the only signal
    // that its contents changed, so it stays in the dep list unread.
    void annotationTypesVersion;

    if (filterOnlyHighlight) return { vertices: new Float32Array(0), colors: new Uint8Array(0), indices: new Uint32Array(0), count: 0 };
    if (!annotations.length) return { vertices: new Float32Array(0), colors: new Uint8Array(0), indices: new Uint32Array(0), count: 0 };

    let totalVertices = 0;
    let totalIndices = 0;
    annotations.forEach(annotation => {
      // Contour points are flat [x0, y0, x1, y1, ...] — never an array of pairs.
      const numPoints = annotation.points ? annotation.points.length >> 1 : 0;
      if (numPoints >= 3) {
        totalVertices += numPoints;
        totalIndices += (numPoints - 2) * 3;
      }
    });

    if (totalVertices === 0) {
      return { vertices: new Float32Array(0), colors: new Uint8Array(0), indices: new Uint32Array(0), count: 0 };
    }

    const vertices = new Float32Array(totalVertices * 2);
    const colors = new Uint8Array(totalVertices * 4);
    const fillAlpha = Math.round(overlayAlpha * 255);
    // Use 32-bit indices to support large vertex counts (>65535)
    const indices = new Uint32Array(totalIndices);
    let vertexIndex = 0;
    let indexIndex = 0;
    let baseVertex = 0;

    annotations.forEach(annotation => {
      const points: Int32Array | undefined = annotation.points;
      const numPoints = points ? points.length >> 1 : 0;

      if (numPoints >= 3) {
        // 0-255, matching hexToRgb. NB: before the buffer became a normalised
        // byte attribute this 128 clamped to white, so unclassified cells used
        // to render lighter than they do now.
        let finalColor = [128, 128, 128]; // Default gray #808080

        // First, check for a manual override. This takes highest priority.
        const override = annotation?.id != null ? annotationTypes.get(String(annotation.id)) : null;
        if (override) {
          finalColor = hexToRgb(override.color || '#808080');
        } else if (annotation.class_id !== undefined && annotation.class_id > -1 && nucleiClasses && annotation.class_id < nucleiClasses.length) {
          finalColor = hexToRgb(nucleiClasses[annotation.class_id].color || '#808080');
        } else if (annotation.color) {
          finalColor = hexToRgb(annotation.color);
        }

        // For fill, always use base color; highlight handled by edge pass

        for (let i = 0; i < numPoints; i++) {
          vertices[vertexIndex * 2] = points![i * 2];
          vertices[vertexIndex * 2 + 1] = points![i * 2 + 1];

          colors[vertexIndex * 4] = finalColor[0];
          colors[vertexIndex * 4 + 1] = finalColor[1];
          colors[vertexIndex * 4 + 2] = finalColor[2];
          colors[vertexIndex * 4 + 3] = fillAlpha;

          vertexIndex++;
        }

        for (let i = 1; i < numPoints - 1; i++) {
          indices[indexIndex++] = baseVertex;
          indices[indexIndex++] = baseVertex + i;
          indices[indexIndex++] = baseVertex + i + 1;
        }

        baseVertex += numPoints;
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

  // Precise hit-test: the cell whose CONTOUR polygon actually contains (cx, cy).
  // AABB-reject each cell first (cheap bounds compare, memoised on the contour);
  // only the polygon the point could be inside runs the ray-cast. Returns that
  // cell's class index, or null when the point is outside every contour.
  const findCellClassAtPoint = useCallback((cx: number, cy: number): number | null => {
    for (let a = 0; a < annotations.length; a++) {
      const annotation = annotations[a];
      const points = annotation?.points as Int32Array | undefined;
      if (!points || points.length < 6) continue;
      const geometry = getContourGeometry(annotation);
      if (cx < geometry.minX || cx > geometry.maxX) continue;
      if (cy < geometry.minY || cy > geometry.maxY) continue;
      if (!isPointInPolygon(cx, cy, points)) continue;
      const classId = annotation.class_id;
      return typeof classId === "number" ? classId : -1;
    }
    return null;
  }, [annotations]);

  // Process polygon edge data (contours) — WebGL highlight is the contour (yellow edges).
  // With selection: when filterHighlightIndices set, only show contours for highlighted (prob >= threshold); else show all in region.
  const processedPolygonEdgeData = useMemo(() => {
    // No `colors` here: the edge pass feeds its constant stroke through the
    // generic vertex attribute, so there is no colour buffer to return.
    if (!annotations.length) return { vertices: new Float32Array(0), count: 0 };

    const boundary = boundaryShape;
    const hasBoundary = boundary !== null;
    const filterSet = filterHighlightIndices != null ? new Set(filterHighlightIndices) : null;
    const useFilterHighlight = filterHighlightIndices != null;
    const gtSet = highlightGtAnnotations && gtHighlightNucleiIndices.length > 0 ? new Set(gtHighlightNucleiIndices) : null;

    // Decide once which contours get stroked, then write only their vertices:
    // the decision includes findNearestCentroidId, a nearest-neighbour search.
    let totalEdgeVertices = 0;
    const strokedPoints: Int32Array[] = [];

    annotations.forEach(annotation => {
      const points: Int32Array | undefined = annotation.points;
      const numPoints = points ? points.length >> 1 : 0;
      if (numPoints < 2) return;

      const { centerX, centerY } = getContourGeometry(annotation);
      const inBoundary = hasBoundary ? checkPointInBoundary(centerX, centerY, boundary!) : false;
      const cellId = Number(annotation.id);
      const nearestId = Number.isFinite(cellId) ? null : findNearestCentroidId(centerX, centerY);
      const idInSet = useFilterHighlight
        ? (Number.isFinite(cellId) ? filterSet!.has(cellId) : (nearestId !== null && filterSet!.has(nearestId)))
        : true;
      const gtHighlight = gtSet ? (Number.isFinite(cellId) ? gtSet.has(cellId) : (nearestId !== null && gtSet.has(nearestId))) : false;
      // When filter highlight is active: show contour if id is in set (no boundary required).
      // GT highlight: always show contour for user-annotated (GT) indices.
      const isHighlighted = gtHighlight || (useFilterHighlight ? idInSet : (inBoundary && idInSet));
      if (!isHighlighted) return;

      strokedPoints.push(points!);
      totalEdgeVertices += numPoints * 2;
    });

    if (totalEdgeVertices === 0) {
      return { vertices: new Float32Array(0), count: 0 };
    }

    // Positions only. The stroke is one constant colour for every edge vertex,
    // so storing it per vertex meant building and uploading a 38 MB buffer of
    // the same four floats on every frame at a full contour cache. It is now a
    // constant generic vertex attribute set once per draw (see redraw).
    const edgeVertices = new Float32Array(totalEdgeVertices * 2);
    let edgeVertexIndex = 0;

    for (const points of strokedPoints) {
      const numPoints = points.length >> 1;
      for (let i = 0; i < numPoints; i++) {
        const ai = i * 2;
        const bi = ((i + 1) % numPoints) * 2;

        edgeVertices[edgeVertexIndex * 2] = points[ai];
        edgeVertices[edgeVertexIndex * 2 + 1] = points[ai + 1];
        edgeVertexIndex++;

        edgeVertices[edgeVertexIndex * 2] = points[bi];
        edgeVertices[edgeVertexIndex * 2 + 1] = points[bi + 1];
        edgeVertexIndex++;
      }
    }

    return {
      vertices: edgeVertices,
      count: edgeVertexIndex
    };
  }, [annotations, boundaryShape, checkPointInBoundary, filterHighlightIndices, highlightGtAnnotations, gtHighlightNucleiIndices, findNearestCentroidId]);

  const redraw = useCallback(() => {
    const gl = glRef.current;
    const canvas = overlayRef.current;

    if (!gl || !isWebGL2Context(gl) || !canvas || !viewer || !centroidProgramRef.current || !polygonProgramRef.current ||
      !centroidBuffersRef.current || !polygonBuffersRef.current ||
      !centroidVaoRef.current || !polygonVaoRef.current) return;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (
      uploadedCentroidsRef.current.instanceCount === 0 &&
      uploadedPolygonIndicesRef.current === 0 &&
      uploadedEdgeVerticesRef.current === 0
    ) return;

    const zoom = viewer.viewport.getZoom(true);
    const rawPointSize = (centroidSize * 0.8) + 3.5* Math.log(Math.max(zoom, 1e-6));
    const pointSize = Math.max(rawPointSize, 0.8); // Avoid negative sizes
    const flipped = viewer.viewport.getFlip();

    // Setup transformation matrices
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

    // gl-matrix Acceleration
    const imageToViewportMat = mat2d.create();
    mat2d.scale(imageToViewportMat, imageToViewportMat, [
      1 / dimX,
      1 / dimY / contentAspectX,
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

    // Each pass is guarded on its own uniforms, so a missing one cannot take the
    // passes after it down with it.
    const centroidUniforms = uniformsRef.current?.centroid;
    if (centroidUniforms && uploadedCentroidsRef.current.instanceCount > 0) {
      gl.useProgram(centroidProgramRef.current);
      gl.bindVertexArray(centroidVaoRef.current);

      gl.uniform2fv(centroidUniforms.scale, [pointSize / canvas.width, pointSize / canvas.height]);
      gl.uniform2fv(centroidUniforms.canvasSize, [canvas.width, canvas.height]);
      gl.uniformMatrix3fv(centroidUniforms.imageToViewer, false, imageToViewerMat3);

      // Colour: a palette texture plus two alphas, so recolouring never
      // rewrites a vertex buffer and restyling touches no per-instance data.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, centroidPaletteTexRef.current);
      gl.uniform1i(centroidUniforms.palette, 0);
      gl.uniform3f(centroidUniforms.highlightColor, 1, 1, 0);
      gl.uniform1f(centroidUniforms.alpha, overlayAlpha);
      gl.uniform1f(centroidUniforms.highlightAlpha, Math.min(overlayAlpha + 0.2, 1.0));

      // The count is written in the same effect that uploads the buffer, so it
      // cannot outrun it — the old Math.min/<= dance could never fire.
      gl.drawArraysInstanced(
        gl.TRIANGLES,
        0,
        CENTROID_CIRCLE_VERTICES,
        uploadedCentroidsRef.current.instanceCount,
      );
    }

    const polygonUniforms = uniformsRef.current?.polygon;

    // Draw polygons (filled) if available
    if (polygonUniforms && uploadedPolygonIndicesRef.current > 0) {
      gl.useProgram(polygonProgramRef.current);
      gl.bindVertexArray(polygonVaoRef.current);

      gl.uniform2fv(polygonUniforms.canvasSize, [canvas.width, canvas.height]);
      gl.uniformMatrix3fv(polygonUniforms.imageToViewer, false, imageToViewerMat3);

      // Bind element array buffer
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, polygonBuffersRef.current.indices);
      // Render filled triangles (32-bit indices).
      gl.drawElements(gl.TRIANGLES, uploadedPolygonIndicesRef.current, gl.UNSIGNED_INT, 0);
    }

    // Draw highlighted polygon edges (contours) if available
    if (polygonUniforms &&
        uploadedEdgeVerticesRef.current > 0 &&
        polygonEdgeVaoRef.current &&
        polygonEdgeBuffersRef.current) {
      gl.useProgram(polygonProgramRef.current);
      gl.bindVertexArray(polygonEdgeVaoRef.current);

      gl.uniform2fv(polygonUniforms.canvasSize, [canvas.width, canvas.height]);
      gl.uniformMatrix3fv(polygonUniforms.imageToViewer, false, imageToViewerMat3);

      // The stroke colour, as a constant generic vertex attribute rather than a
      // per-vertex buffer. Set per draw: the current value of a generic vertex
      // attribute is context state, not part of the VAO.
      if (polygonEdgeColorLocationRef.current >= 0) {
        gl.vertexAttrib4f(
          polygonEdgeColorLocationRef.current,
          1.0,
          1.0,
          0.0,
          Math.min(overlayAlpha + 0.5, 1.0),
        );
      }

      // Note: line width is implementation-defined; many browsers clamp to 1.
      gl.drawArrays(gl.LINES, 0, uploadedEdgeVerticesRef.current);
    }

    gl.bindVertexArray(null);
  }, [viewer, centroidSize, overlayAlpha]);

  // The three buffer effects all fire in the same commit when a frame lands, and
  // each redraw replays the matrix setup and up to ~1M triangles. The first
  // request queues a microtask and the rest join it, so one redraw runs after
  // every effect in the commit has uploaded.
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;
  const redrawQueuedRef = useRef(false);
  const scheduleRedraw = useCallback(() => {
    if (redrawQueuedRef.current) return;
    redrawQueuedRef.current = true;
    queueMicrotask(() => {
      redrawQueuedRef.current = false;
      redrawRef.current();
    });
  }, []);

  // WebGL setup
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !viewer) return;

    // Generate a consistent context ID for this canvas. A counter, not
    // Date.now(): two viewers mounting in the same millisecond produced the same
    // id, and the manager releases an existing context before reusing an id —
    // so the second overlay silently killed the first one's GL context.
    const contextId = canvas.id || `drawing_overlay_${++drawingOverlayCanvasSeq}`;
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
    const centroidAttribBuffer = gl.createBuffer();
    const centroidImageCoordsBuffer = gl.createBuffer();
    if (!centroidPositionBuffer || !centroidAttribBuffer || !centroidImageCoordsBuffer) return;

    centroidBuffersRef.current = {
      position: centroidPositionBuffer,
      attribs: centroidAttribBuffer,
      imageCoords: centroidImageCoordsBuffer,
    };

    // NEAREST + CLAMP: the palette is a lookup table, never interpolated.
    const paletteTexture = gl.createTexture();
    if (!paletteTexture) return;
    centroidPaletteTexRef.current = paletteTexture;
    gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Create and upload circle vertices (only once)
    const circleVertices = createCircleVertices(CENTROID_CIRCLE_SEGMENTS);
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

    // Palette index + highlight flag, interleaved 2 bytes per instance. This is
    // the buffer a selection drag re-uploads: 0.21 MB at 200k centroids.
    // NOT normalised — the shader wants 0..255, not 0..1.
    const paletteIndexLocation = gl.getAttribLocation(centroidProgram, "a_paletteIndex");
    const highlightLocation = gl.getAttribLocation(centroidProgram, "a_highlight");
    gl.bindBuffer(gl.ARRAY_BUFFER, centroidAttribBuffer);
    gl.enableVertexAttribArray(paletteIndexLocation);
    gl.vertexAttribPointer(paletteIndexLocation, 1, gl.UNSIGNED_BYTE, false, 2, 0);
    gl.vertexAttribDivisor(paletteIndexLocation, 1);
    gl.enableVertexAttribArray(highlightLocation);
    gl.vertexAttribPointer(highlightLocation, 1, gl.UNSIGNED_BYTE, false, 2, 1);
    gl.vertexAttribDivisor(highlightLocation, 1);

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
    // Normalised unsigned byte: 4 bytes per vertex instead of 16. At ~1.2M
    // vertices that is a 19 MB upload down to 4.8 MB, and the shader is
    // unchanged — the GPU hands `a_color` over as the same vec4 in 0..1.
    gl.vertexAttribPointer(polygonColorLocation, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    // Bind indices buffer
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, polygonIndicesBuffer);

    gl.bindVertexArray(null);

    // Setup polygon edge VAO and buffers (for contour drawing)
    const polygonEdgeVao = gl.createVertexArray();
    if (!polygonEdgeVao) return;
    polygonEdgeVaoRef.current = polygonEdgeVao;
    gl.bindVertexArray(polygonEdgeVao);

    const polygonEdgePositionBuffer = gl.createBuffer();
    if (!polygonEdgePositionBuffer) return;

    polygonEdgeBuffersRef.current = {
      position: polygonEdgePositionBuffer,
    };

    // Set up position attribute for edges
    gl.bindBuffer(gl.ARRAY_BUFFER, polygonEdgePositionBuffer);
    const polygonEdgePositionLocation = gl.getAttribLocation(polygonProgram, "a_position");
    gl.enableVertexAttribArray(polygonEdgePositionLocation);
    gl.vertexAttribPointer(polygonEdgePositionLocation, 2, gl.FLOAT, false, 0, 0);

    // Colour: one constant for every edge vertex, so the array is left DISABLED
    // and the value comes from the generic vertex attribute (set per draw in
    // redraw). Enabling it meant shipping the same four floats 2.4M times —
    // 38 MB per frame at a full contour cache.
    const polygonEdgeColorLocation = gl.getAttribLocation(polygonProgram, "a_color");
    gl.disableVertexAttribArray(polygonEdgeColorLocation);
    polygonEdgeColorLocationRef.current = polygonEdgeColorLocation;

    gl.bindVertexArray(null);

    uniformsRef.current = {
      centroid: {
        scale: gl.getUniformLocation(centroidProgram, 'u_scale'),
        imageToViewer: gl.getUniformLocation(centroidProgram, 'u_imageToViewer'),
        canvasSize: gl.getUniformLocation(centroidProgram, 'u_canvasSize'),
        palette: gl.getUniformLocation(centroidProgram, 'u_palette'),
        highlightColor: gl.getUniformLocation(centroidProgram, 'u_highlightColor'),
        alpha: gl.getUniformLocation(centroidProgram, 'u_alpha'),
        highlightAlpha: gl.getUniformLocation(centroidProgram, 'u_highlightAlpha'),
      },
      polygon: {
        imageToViewer: gl.getUniformLocation(polygonProgram, 'u_imageToViewer'),
        canvasSize: gl.getUniformLocation(polygonProgram, 'u_canvasSize'),
      },
    };

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
          gl.deleteBuffer(centroidBuffersRef.current.attribs);
          gl.deleteBuffer(centroidBuffersRef.current.imageCoords);
        }
        if (centroidPaletteTexRef.current) {
          gl.deleteTexture(centroidPaletteTexRef.current);
          centroidPaletteTexRef.current = null;
        }
        if (polygonBuffersRef.current) {
          gl.deleteBuffer(polygonBuffersRef.current.position);
          gl.deleteBuffer(polygonBuffersRef.current.color);
          gl.deleteBuffer(polygonBuffersRef.current.indices);
        }
        if (polygonEdgeBuffersRef.current) {
          gl.deleteBuffer(polygonEdgeBuffersRef.current.position);
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

      // Only on a real size change: assigning width/height reallocates the GL
      // drawing buffer even when the value is identical, and this runs inside
      // OSD's rAF on every pan/zoom frame.
      const width = viewerCanvas.clientWidth;
      const height = viewerCanvas.clientHeight;
      if (canvas.width === width && canvas.height === height) return;

      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    };

    const updateOverlay = () => {
      resizeCanvas();
      redrawRef.current();
    };

    updateOverlay();

    viewer.addHandler("update-viewport", updateOverlay);

    return () => {
      viewer.removeHandler("update-viewport", updateOverlay);
    };
  }, [viewer]);

  // Point size and alpha are read at draw time rather than baked into a buffer,
  // so a style change has no buffer upload to ride along with.
  useEffect(() => {
    scheduleRedraw();
  }, [centroidSize, overlayAlpha, scheduleRedraw]);

  // Click-to-inspect a cell's class. Fires ONLY when:
  //   • the active tool is "move" (never while drawing/selecting), and
  //   • the click lands INSIDE a cell's contour polygon.
  // The point-in-polygon test needs contour polygons to exist, so in centroid
  // (dots-only) mode there are no polygons to hit and nothing pops — exactly the
  // "contour mode only, no trigger on centroids" behavior. Pan/zoom dismiss it.
  // Read by the click handler through a ref: these change on every contour
  // repaint, and as dependencies they re-registered three OSD handlers per frame
  // during a pan.
  const clickReadsRef = useRef({ findCellClassAtPoint, nucleiClasses, annotations });
  clickReadsRef.current.findCellClassAtPoint = findCellClassAtPoint;
  clickReadsRef.current.nucleiClasses = nucleiClasses;
  clickReadsRef.current.annotations = annotations;

  useEffect(() => {
    if (!viewer) return;

    const onClick = (event: any) => {
      if (!event.quick) return;                       // a real click, not a drag
      if (currentToolRef.current !== "move") return;  // move (navigate) tool only
      const reads = clickReadsRef.current;
      // The overlay stays mounted while hidden (empty data) — with no contours
      // there is nothing to hit, so skip the coordinate maths and the setState.
      if (reads.annotations.length === 0) return;
      const tiledImage = viewer.world.getItemAt(0);
      if (!tiledImage) return;
      const imgPoint = tiledImage.viewportToImageCoordinates(
        viewer.viewport.pointFromPixel(event.position),
      );
      const classId = reads.findCellClassAtPoint(imgPoint.x, imgPoint.y);
      if (classId === null) { setClassPopup(null); return; } // outside every contour

      const cls = classId >= 0 && classId < reads.nucleiClasses.length
        ? reads.nucleiClasses[classId]
        : undefined;
      const oe = event.originalEvent as MouseEvent | undefined;
      setClassPopup({
        x: oe?.clientX ?? 0,
        y: oe?.clientY ?? 0,
        name: cls?.name ?? "Unclassified",
        color: cls?.color ?? "#888888",
      });
    };
    const dismiss = () => setClassPopup(null);

    viewer.addHandler("canvas-click", onClick);
    viewer.addHandler("canvas-drag", dismiss);
    viewer.addHandler("canvas-scroll", dismiss);
    return () => {
      viewer.removeHandler("canvas-click", onClick);
      viewer.removeHandler("canvas-drag", dismiss);
      viewer.removeHandler("canvas-scroll", dismiss);
    };
  }, [viewer]);

  // Blank the GPU canvas before paint when cell data is gone (path switch).
  // Layout effect, not passive: the nuclei toggle is a keydown, and clearing
  // after the buffer effects leaves one visible frame of stale cells.
  useLayoutEffect(() => {
    if (centroids.length > 0 || annotations.length > 0) return;
    uploadedCentroidsRef.current.instanceCount = 0;
    uploadedPolygonIndicesRef.current = 0;
    uploadedEdgeVerticesRef.current = 0;
    if (!glRef.current) return;
    redrawRef.current();
  }, [centroids, annotations]);

  // Update centroid data
  useEffect(() => {
    if (!glRef.current || !centroidBuffersRef.current) return;

    const gl = glRef.current;
    const buffers = centroidBuffersRef.current;
    const uploaded = uploadedCentroidsRef.current;

    // The palette is 1KB and only changes when the class list or an override
    // does, so it is re-uploaded on identity change rather than every frame.
    if (centroidPaletteTexRef.current && uploaded.palette !== processedCentroidData.palette) {
      gl.bindTexture(gl.TEXTURE_2D, centroidPaletteTexRef.current);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, PALETTE_SIZE, 1, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, processedCentroidData.palette,
      );
    }

    if (processedCentroidData.count === 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.imageCoords);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.attribs);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(0), gl.STATIC_DRAW);
      uploadedCentroidsRef.current = {
        imageCoords: new Float32Array(0),
        palette: processedCentroidData.palette,
        instanceCount: 0,
      };
      scheduleRedraw();
      return;
    }

    // Positions keep their array identity while the centroid set is unchanged,
    // so a selection drag — which only recolours — never re-sends them.
    if (uploaded.imageCoords !== processedCentroidData.imageCoords) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.imageCoords);
      gl.bufferData(gl.ARRAY_BUFFER, processedCentroidData.imageCoords, gl.STATIC_DRAW);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.attribs);
    gl.bufferData(gl.ARRAY_BUFFER, processedCentroidData.attribs, gl.STATIC_DRAW);

    uploadedCentroidsRef.current = {
      imageCoords: processedCentroidData.imageCoords,
      palette: processedCentroidData.palette,
      instanceCount: processedCentroidData.count,
    };

    scheduleRedraw();
  }, [processedCentroidData, scheduleRedraw]);

  // Update polygon data
  useEffect(() => {
    if (!glRef.current || !polygonBuffersRef.current) return;

    const gl = glRef.current;

    if (processedPolygonData.count === 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, polygonBuffersRef.current.position);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, polygonBuffersRef.current.color);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(0), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, polygonBuffersRef.current.indices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(0), gl.STATIC_DRAW);
      // Update cache to reflect empty state
      uploadedPolygonIndicesRef.current = 0;
      scheduleRedraw();
      return;
    }

    // Always update buffers when data changes
    gl.bindBuffer(gl.ARRAY_BUFFER, polygonBuffersRef.current.position);
    gl.bufferData(gl.ARRAY_BUFFER, processedPolygonData.vertices, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, polygonBuffersRef.current.color);
    gl.bufferData(gl.ARRAY_BUFFER, processedPolygonData.colors, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, polygonBuffersRef.current.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, processedPolygonData.indices, gl.STATIC_DRAW);

    uploadedPolygonIndicesRef.current = processedPolygonData.count;

    scheduleRedraw();
  }, [processedPolygonData, scheduleRedraw]);

  // Update polygon edge data
  useEffect(() => {
    if (!glRef.current || !polygonEdgeBuffersRef.current) return;

    const gl = glRef.current;

    if (processedPolygonEdgeData.count === 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, polygonEdgeBuffersRef.current.position);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.STATIC_DRAW);
      // Update cache to reflect empty state
      uploadedEdgeVerticesRef.current = 0;
      scheduleRedraw();
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, polygonEdgeBuffersRef.current.position);
    gl.bufferData(gl.ARRAY_BUFFER, processedPolygonEdgeData.vertices, gl.STATIC_DRAW);

    uploadedEdgeVerticesRef.current = processedPolygonEdgeData.count;

    scheduleRedraw();
  }, [processedPolygonEdgeData, scheduleRedraw]);

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
          pointerEvents: "none"
        }}
      />
      {classPopup && (
        <div
          style={{
            position: "fixed",
            left: `${classPopup.x + 12}px`,
            top: `${classPopup.y - 34}px`,
            zIndex: 10000,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 8px",
            borderRadius: "4px",
            background: "rgba(0, 0, 0, 0.82)",
            color: "#fff",
            fontSize: "12px",
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
          }}
        >
          <span
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "2px",
              background: classPopup.color,
              display: "inline-block",
              flexShrink: 0,
            }}
          />
          {classPopup.name}
        </div>
      )}
    </>
  );
};

// The parent re-renders far more often than the overlay data changes; without
// this, those renders reach the three buffer-building memos above. `centroids` /
// `annotations` do change identity per wire frame, so real frames still render.
export default React.memo(DrawingOverlay);
