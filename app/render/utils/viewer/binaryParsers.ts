import { CentroidsArray, createCentroidsArrayProxy } from '@/components/imageViewer/CentroidsArray';

/**
 * Helper function to read uint32 from arrayBuffer at offset, handling alignment
 */
export function readUint32(arrayBuffer: ArrayBuffer, offset: number): number {
  if (offset % 4 === 0) {
    return new Uint32Array(arrayBuffer, offset, 1)[0];
  } else {
    // Not aligned, read manually using Uint8Array
    const bytes = new Uint8Array(arrayBuffer, offset, 4);
    return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
  }
}

/**
 * Parse binary segmentation data format
 * Format: 
 * - 4 bytes: type header ('c') + 3 bytes padding (aligned)
 * - uint32: count of points
 * - Points array: each point is [id(uint32), x(int32), y(int32), class_id(int32)]
 * - uint32: count of class names
 * - Class names: each name is [length(uint32), utf-8 bytes]
 * - uint32: count of class colors
 * - Class colors: each color is [length(uint32), utf-8 bytes]
 * - uint32: length of class counts JSON
 * - Class counts: JSON string [utf-8 bytes]
 */
export function parseSegmentationBinary(buffer: Uint8Array): any {
  // Get the underlying ArrayBuffer from the Uint8Array
  // Optimize: avoid slice() if buffer is already a complete view (byteOffset = 0)
  // In practice, Uint8Array from WebSocket/decompression always uses ArrayBuffer, not SharedArrayBuffer
  let arrayBuffer: ArrayBuffer;
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    // Buffer is already a complete view, use it directly (no copy)
    arrayBuffer = buffer.buffer as ArrayBuffer;
  } else {
    // Buffer is a partial view, need to slice (creates a copy)
    arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }
  let offset = 4; // Skip type header ('c') + 3 bytes padding (4 bytes total, aligned)
  
  // Read points count (using helper to handle alignment)
  const numPoints = readUint32(arrayBuffer, offset);
  offset += 4;
  
  // Optimized: Use TypedArray views for batch reading
  // Format: id(uint32), x(int32), y(int32), class_id(int32) = 16 bytes per point
  // Memory layout per point: [id(4B)][x(4B)][y(4B)][class_id(4B)]
  const pointsByteLength = numPoints * 16;
  const pointsStartOffset = offset;
  
  // Use Int32Array + CentroidsArray wrapper for efficient access
  // Format: [id, x, y, classId, id, x, y, classId, ...] - flat array
  const centroidsData = new Int32Array(arrayBuffer, pointsStartOffset, numPoints * 4);
  const centroids = createCentroidsArrayProxy(centroidsData, numPoints);
  
  offset += pointsByteLength;
  
  // Read class names count (using helper to handle alignment)
  const numClassNames = readUint32(arrayBuffer, offset);
  offset += 4;
  
  // Read class names
  const classNames: string[] = [];
  for (let i = 0; i < numClassNames; i++) {
    const nameLength = readUint32(arrayBuffer, offset);
    offset += 4;
    const nameBytes = buffer.slice(offset, offset + nameLength);
    const name = new TextDecoder().decode(nameBytes);
    offset += nameLength;
    classNames.push(name);
  }
  
  // Read class colors count (using helper to handle alignment)
  const numClassColors = readUint32(arrayBuffer, offset);
  offset += 4;
  
  // Read class colors
  const classColors: string[] = [];
  for (let i = 0; i < numClassColors; i++) {
    const colorLength = readUint32(arrayBuffer, offset);
    offset += 4;
    const colorBytes = buffer.slice(offset, offset + colorLength);
    const color = new TextDecoder().decode(colorBytes);
    offset += colorLength;
    classColors.push(color);
  }
  
  // Read class counts JSON (using helper to handle alignment)
  const countsLength = readUint32(arrayBuffer, offset);
  offset += 4;
  const countsBytes = buffer.slice(offset, offset + countsLength);
  const countsJson = new TextDecoder().decode(countsBytes);
  const classCountsById = JSON.parse(countsJson);
  
  // Return in the same format as JSON version
  return {
    type: 'centroids',
    centroids: centroids,
    class_names: classNames,
    class_colors: classColors,
    class_counts_by_id: classCountsById,
    dynamic_class_names: classNames
  };
}

/**
 * Parse binary annotations/contours data format
 * Format:
 * - 4 bytes: type header ('a' or 'A') + 3 bytes padding (aligned)
 * - uint32: count of annotations
 * - For each annotation:
 *   - uint32: id (nucleus index)
 *   - int32: class_id
 *   - uint32: point count
 *   - Points: [x(int32), y(int32)] * point_count
 * - uint32: count of class names
 * - Class names: each name is [length(uint32), utf-8 bytes]
 * - uint32: count of class colors
 * - Class colors: each color is [length(uint32), utf-8 bytes]
 * - uint32: length of class counts JSON
 * - Class counts: JSON string [utf-8 bytes]
 */
export function parseAnnotationsBinary(buffer: Uint8Array): any {
  // Get the underlying ArrayBuffer from the Uint8Array
  // Optimize: avoid slice() if buffer is already a complete view (byteOffset = 0)
  // In practice, Uint8Array from WebSocket/decompression always uses ArrayBuffer, not SharedArrayBuffer
  let arrayBuffer: ArrayBuffer;
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    // Buffer is already a complete view, use it directly (no copy)
    arrayBuffer = buffer.buffer as ArrayBuffer;
  } else {
    // Buffer is a partial view, need to slice (creates a copy)
    arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }
  let offset = 4; // Skip type header ('a' or 'A') + 3 bytes padding (4 bytes total, aligned)
  
  // Read annotations count (using helper to handle alignment)
  const numAnnotations = readUint32(arrayBuffer, offset);
  offset += 4;
  
  // Read annotations
  const annotations: any[] = [];
  let annotationsOffset = offset;
  
  for (let i = 0; i < numAnnotations; i++) {
    const id = readUint32(arrayBuffer, annotationsOffset);
    annotationsOffset += 4;
    // Read int32: check alignment
    const classId = annotationsOffset % 4 === 0 
      ? new Int32Array(arrayBuffer, annotationsOffset, 1)[0]
      : (() => {
          const bytes = new Uint8Array(arrayBuffer, annotationsOffset, 4);
          return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) | 0;
        })();
    annotationsOffset += 4;
    const numPoints = readUint32(arrayBuffer, annotationsOffset);
    annotationsOffset += 4;
    
    // Optimized: Use TypedArray for batch reading points
    // Format: [x(int32), y(int32)] = 8 bytes per point
    if (numPoints > 0) {
      const pointsByteLength = numPoints * 8;
      
      // Header is now 4-byte aligned (type header + 3 bytes padding), so all offsets are aligned
      // Use Int32Array for fast batch reading
      const pointsInt32View = new Int32Array(arrayBuffer, annotationsOffset, numPoints * 2);
      
      // Pre-allocate points array
      const points: number[][] = new Array(numPoints);
      for (let j = 0; j < numPoints; j++) {
        points[j] = [pointsInt32View[j * 2], pointsInt32View[j * 2 + 1]];
      }
      
      annotations.push({
        id: id.toString(),
        points: points,
        class_id: classId
      });
      
      annotationsOffset += pointsByteLength;
    } else {
      annotations.push({
        id: id.toString(),
        points: [],
        class_id: classId
      });
    }
  }
  offset = annotationsOffset;
  
  // Read class names count (using helper to handle alignment)
  const numClassNames = readUint32(arrayBuffer, offset);
  offset += 4;
  
  // Read class names
  const classNames: string[] = [];
  for (let i = 0; i < numClassNames; i++) {
    const nameLength = readUint32(arrayBuffer, offset);
    offset += 4;
    const nameBytes = buffer.slice(offset, offset + nameLength);
    const name = new TextDecoder().decode(nameBytes);
    offset += nameLength;
    classNames.push(name);
  }
  
  // Read class colors count (using helper to handle alignment)
  const numClassColors = readUint32(arrayBuffer, offset);
  offset += 4;
  
  // Read class colors
  const classColors: string[] = [];
  for (let i = 0; i < numClassColors; i++) {
    const colorLength = readUint32(arrayBuffer, offset);
    offset += 4;
    const colorBytes = buffer.slice(offset, offset + colorLength);
    const color = new TextDecoder().decode(colorBytes);
    offset += colorLength;
    classColors.push(color);
  }
  
  // Read class counts JSON (using helper to handle alignment)
  const countsLength = readUint32(arrayBuffer, offset);
  offset += 4;
  const countsBytes = buffer.slice(offset, offset + countsLength);
  const countsJson = new TextDecoder().decode(countsBytes);
  const classCountsById = JSON.parse(countsJson);
  
  // Return in the same format as JSON version
  return {
    type: 'annotations',
    annotations: annotations,
    class_names: classNames,
    class_colors: classColors,
    class_counts_by_id: classCountsById,
    dynamic_class_names: classNames
  };
}

