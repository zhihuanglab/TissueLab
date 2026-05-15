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

  get length(): number {
    return this.numPoints;
  }

  // Get underlying Int32Array data for direct access (for performance)
  getData(): Int32Array {
    return this.data;
  }

  // Index access: centroids[i] returns subarray view [id, x, y, classId]
  [index: number]: Int32Array | undefined;
  
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

// Proxy to support index access
export function createCentroidsArrayProxy(data: Int32Array, numPoints: number): CentroidsArray & { [index: number]: Int32Array } {
  const centroids = new CentroidsArray(data, numPoints);
  return new Proxy(centroids, {
    get(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        // Numeric index access
        const index = parseInt(prop, 10);
        return target.get(index);
      }
      return (target as any)[prop];
    },
    has(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        const index = parseInt(prop, 10);
        return index >= 0 && index < numPoints;
      }
      return prop in target;
    }
  }) as CentroidsArray & { [index: number]: Int32Array };
}

