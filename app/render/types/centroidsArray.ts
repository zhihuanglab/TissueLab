/**
 * CentroidsArray: Wrapper for Int32Array that provides nested array-like access
 * Uses subarray views for efficient access without creating new arrays
 * Format: [id, x, y, classId, id, x, y, classId, ...]
 */
export class CentroidsArray {
  private data: Int32Array;
  private numPoints: number;

  constructor(data: Int32Array, numPoints: number) {
    this.data = data;
    this.numPoints = numPoints;
  }

  /**
   * Build from nested rows [[id,x,y,classId], ...] or pass through an existing instance.
   * Prefer binary parsers that already produce Int32Array / CentroidsArray.
   */
  static fromPoints(
    points: CentroidsArray | ArrayLike<ArrayLike<number>> | null | undefined,
  ): CentroidsArray {
    if (!points) return new CentroidsArray(new Int32Array(0), 0);
    if (points instanceof CentroidsArray) return points;
    const n = points.length;
    const data = new Int32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const p = points[i]!;
      const j = i << 2;
      data[j] = p[0] as number;
      data[j + 1] = p[1] as number;
      data[j + 2] = p[2] as number;
      data[j + 3] = p[3] as number;
    }
    return new CentroidsArray(data, n);
  }

  get length(): number {
    return this.numPoints;
  }

  // Get underlying Int32Array data for direct access (for performance)
  getData(): Int32Array {
    return this.data;
  }

  // Access point i: returns subarray view [id, x, y, classId]
  get(i: number): Int32Array {
    if (i < 0 || i >= this.numPoints) return undefined as any;
    const idx = i << 2; // i * 4
    return this.data.subarray(idx, idx + 4);
  }

  // Array-like access: centroids[i] returns [id, x, y, classId]
  [Symbol.iterator]() {
    let i = 0;
    return {
      next: () => {
        if (i < this.numPoints) {
          const idx = i << 2;
          const point = this.data.subarray(idx, idx + 4);
          i++;
          return { value: point, done: false };
        }
        return { done: true };
      }
    };
  }

  // Support forEach, map, etc.
  forEach(callback: (point: Int32Array, index: number, array: CentroidsArray) => void) {
    for (let i = 0; i < this.numPoints; i++) {
      const idx = i << 2;
      callback(this.data.subarray(idx, idx + 4), i, this);
    }
  }

  // Convert to array format for compatibility (creates actual arrays)
  toArray(): Array<[number, number, number, number]> {
    const result: Array<[number, number, number, number]> = [];
    for (let i = 0; i < this.numPoints; i++) {
      const idx = i << 2;
      result.push([
        this.data[idx],            // id (number) 
        this.data[idx + 1],        // x
        this.data[idx + 2],        // y
        this.data[idx + 3]         // classId
      ]);
    }
    return result;
  }

  // Support map operation
  map<T>(callback: (point: Int32Array, index: number, array: CentroidsArray) => T): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.numPoints; i++) {
      const idx = i << 2;
      result.push(callback(this.data.subarray(idx, idx + 4), i, this));
    }
    return result;
  }

  // Support filter operation
  filter(callback: (point: Int32Array, index: number, array: CentroidsArray) => boolean): CentroidsArray {
    const filteredIndices: number[] = [];
    for (let i = 0; i < this.numPoints; i++) {
      const idx = i << 2;
      if (callback(this.data.subarray(idx, idx + 4), i, this)) {
        filteredIndices.push(i);
      }
    }
    
    // Create new Int32Array with filtered data
    const filteredData = new Int32Array(filteredIndices.length * 4);
    for (let i = 0; i < filteredIndices.length; i++) {
      const srcIdx = filteredIndices[i] << 2;
      const dstIdx = i << 2;
      filteredData[dstIdx] = this.data[srcIdx];
      filteredData[dstIdx + 1] = this.data[srcIdx + 1];
      filteredData[dstIdx + 2] = this.data[srcIdx + 2];
      filteredData[dstIdx + 3] = this.data[srcIdx + 3];
    }
    
    return new CentroidsArray(filteredData, filteredIndices.length);
  }

  // Support find operation
  find(callback: (point: Int32Array, index: number, array: CentroidsArray) => boolean): Int32Array | undefined {
    for (let i = 0; i < this.numPoints; i++) {
      const idx = i << 2;
      const point = this.data.subarray(idx, idx + 4);
      if (callback(point, i, this)) {
        return point;
      }
    }
    return undefined;
  }
}

// Support Array.isArray() check
Object.defineProperty(CentroidsArray.prototype, Symbol.toStringTag, {
  value: 'Array',
  configurable: true
});
