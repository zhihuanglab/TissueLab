import { CentroidsArray } from '@/types/centroidsArray';

/**
 * Reader for the overlay binary frame.
 * Layout and rationale: app/service/app/websocket/overlay_binary.py
 */

const MAGIC = 0x54; // 'T'
const VERSION = 1;

const KIND_CENTROIDS = 1;
const KIND_ANNOTATIONS = 2;
const KIND_ALL_ANNOTATIONS = 3;

const decoder = new TextDecoder();

export type OverlayFrameType = 'centroids' | 'annotations' | 'all_annotations';

export type OverlayContour = {
  id: string;
  /** Flat image-space coords [x0, y0, x1, y1, ...]; point count is length / 2. */
  points: Int32Array;
  class_id: number;
};

export type OverlayBinaryFrame = {
  type: OverlayFrameType;
  /** Routes the frame — one socket serves every open viewer. */
  instance_id: string;
  class_names: string[];
  class_colors: string[];
  class_counts_by_id: Record<string, number>;
  dynamic_class_names: string[];
  centroids?: CentroidsArray;
  annotations?: OverlayContour[];
  all_annotations?: OverlayContour[];
};

/** True when this buffer is an overlay frame (vs. a JSON payload). */
export function isOverlayFrame(buffer: Uint8Array): boolean {
  return buffer.length >= 4 && buffer[0] === MAGIC;
}

function align4(offset: number): number {
  const remainder = offset % 4;
  return remainder ? offset + (4 - remainder) : offset;
}

/** Normalise to a standalone ArrayBuffer so typed-array views stay aligned. */
function toArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return buffer.buffer as ArrayBuffer;
  }
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

class FrameCursor {
  offset = 0;

  constructor(
    readonly bytes: Uint8Array,
    readonly view: DataView,
  ) {}

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** Length-prefixed utf-8. */
  str(): string {
    const length = this.u32();
    const text = decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return text;
  }

  strList(): string[] {
    const count = this.u32();
    const values: string[] = new Array(count);
    for (let i = 0; i < count; i++) values[i] = this.str();
    return values;
  }

  /** Aligned int32 block — a view, not a copy. */
  i32Block(length: number): Int32Array {
    const block = new Int32Array(this.view.buffer, this.offset, length);
    this.offset += length * 4;
    return block;
  }

  padTo4(): void {
    this.offset = align4(this.offset);
  }
}

function readContours(cursor: FrameCursor): OverlayContour[] {
  const count = cursor.u32();
  const totalPoints = cursor.u32();
  const ids = cursor.i32Block(count);
  const classIds = cursor.i32Block(count);
  const pointCounts = cursor.i32Block(count);
  const xy = cursor.i32Block(totalPoints * 2);

  const contours: OverlayContour[] = new Array(count);
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const numPoints = pointCounts[i];
    contours[i] = {
      id: ids[i].toString(),
      // Zero-copy window into the frame. Materialising number[][] here cost ~15 ms
      // per 20k-cell frame (800k array literals) and ~10x the retained memory;
      // the frame buffer stays alive instead, which is far cheaper.
      points: xy.subarray(offset, offset + numPoints * 2),
      class_id: classIds[i],
    };
    offset += numPoints * 2;
  }
  return contours;
}

/**
 * Parse an overlay frame. Returns null when the buffer is not one (the caller
 * then falls back to JSON) or when the version does not match this client.
 */
export function parseOverlayFrame(buffer: Uint8Array): OverlayBinaryFrame | null {
  if (!isOverlayFrame(buffer)) return null;

  const version = buffer[1];
  if (version !== VERSION) {
    console.error(
      `[Overlay] binary frame v${version} does not match client v${VERSION} — update the service`,
    );
    return null;
  }

  const kind = buffer[2];
  const idLength = buffer[3];
  const arrayBuffer = toArrayBuffer(buffer);
  const bytes = new Uint8Array(arrayBuffer);
  const cursor = new FrameCursor(bytes, new DataView(arrayBuffer));

  cursor.offset = 4;
  const instanceId = idLength
    ? decoder.decode(bytes.subarray(4, 4 + idLength))
    : '';
  cursor.offset = align4(4 + idLength);

  const classNames = cursor.strList();
  const classColors = cursor.strList();
  const classCountsById = JSON.parse(cursor.str() || '{}');
  cursor.padTo4();

  const frame: OverlayBinaryFrame = {
    type: 'centroids',
    instance_id: instanceId,
    class_names: classNames,
    class_colors: classColors,
    class_counts_by_id: classCountsById,
    dynamic_class_names: classNames,
  };

  if (kind === KIND_CENTROIDS) {
    const count = cursor.u32();
    frame.centroids = new CentroidsArray(cursor.i32Block(count * 4), count);
    return frame;
  }

  if (kind === KIND_ANNOTATIONS) {
    frame.type = 'annotations';
    frame.annotations = readContours(cursor);
    return frame;
  }

  if (kind === KIND_ALL_ANNOTATIONS) {
    frame.type = 'all_annotations';
    frame.all_annotations = readContours(cursor);
    return frame;
  }

  console.error('[Overlay] unknown binary frame kind', kind);
  return null;
}
