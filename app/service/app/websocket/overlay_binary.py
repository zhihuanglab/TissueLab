"""Binary wire format for viewer overlay frames.

One zstd-compressed frame per viewport reply. All integers little-endian.

    magic    u8    0x54 'T'
    version  u8    1
    kind     u8    1 centroids | 2 annotations | 3 all_annotations
    id_len   u8    byte length of the instance id
    instance_id    id_len utf-8 bytes
    pad            zeros to the next 4-byte boundary

    n_names    u32 ; n_names  x (u32 byte_len + utf-8 bytes)
    n_colors   u32 ; n_colors x (u32 byte_len + utf-8 bytes)
    counts_len u32 ; counts_len utf-8 bytes (JSON object)
    pad              zeros to the next 4-byte boundary

    kind == centroids:
        u32 count
        i32[count * 4]        id, x, y, class_id  (interleaved)

    kind == annotations | all_annotations:
        u32 count
        u32 total_points
        i32[count]            ids
        i32[count]            class_ids
        i32[count]            point_counts
        i32[total_points * 2] xy  (contours concatenated, in `ids` order)

Two things drive the layout:

* ``instance_id`` is in the header because one WebSocket serves every open
  viewer — without it the client cannot tell whose frame it just received.
* Variable-length metadata sits *before* the numbers, and both the header and
  the metadata block are padded to 4 bytes, so the whole numeric payload is
  4-byte aligned. The client reads it as typed-array views with no per-record
  work, and the contour arrays are columnar so one view covers every cell
  instead of one view per cell.
"""

import json
import struct
from typing import Dict, Iterable, List, Optional

import numpy as np

MAGIC = 0x54  # 'T'
VERSION = 1

KIND_CENTROIDS = 1
KIND_ANNOTATIONS = 2
KIND_ALL_ANNOTATIONS = 3

KIND_BY_REQUEST_TYPE = {
    "centroids": KIND_CENTROIDS,
    "annotations": KIND_ANNOTATIONS,
    "all_annotations": KIND_ALL_ANNOTATIONS,
}


def _pad_to_4(buf: bytearray) -> None:
    remainder = len(buf) % 4
    if remainder:
        buf.extend(b"\x00" * (4 - remainder))


def _pack_header(buf: bytearray, kind: int, instance_id: Optional[str]) -> None:
    id_bytes = (instance_id or "").encode("utf-8")[:255]
    buf.extend(struct.pack("<BBBB", MAGIC, VERSION, kind, len(id_bytes)))
    buf.extend(id_bytes)
    _pad_to_4(buf)


def _pack_strings(buf: bytearray, values: Optional[Iterable[str]]) -> None:
    items = [str(v).encode("utf-8") for v in (values or [])]
    buf.extend(struct.pack("<I", len(items)))
    for item in items:
        buf.extend(struct.pack("<I", len(item)))
        buf.extend(item)


def _pack_metadata(
    buf: bytearray,
    class_names: Optional[List[str]],
    class_colors: Optional[List[str]],
    class_counts_by_id: Optional[Dict],
) -> None:
    _pack_strings(buf, class_names)
    _pack_strings(buf, class_colors)
    counts = json.dumps(class_counts_by_id or {}).encode("utf-8")
    buf.extend(struct.pack("<I", len(counts)))
    buf.extend(counts)
    _pad_to_4(buf)


def _as_int32(values, columns: int) -> np.ndarray:
    """Normalise centroid/contour input to an (n, columns) int32 matrix."""
    arr = np.asarray(values if values is not None else [], dtype=np.int32)
    if arr.size == 0:
        return np.zeros((0, columns), dtype=np.int32)
    if arr.ndim == 1:
        usable = (arr.size // columns) * columns
        return arr[:usable].reshape(-1, columns)
    if arr.shape[1] >= columns:
        return arr[:, :columns]
    padded = np.full((arr.shape[0], columns), -1, dtype=np.int32)
    padded[:, : arr.shape[1]] = arr
    return padded


def pack_centroids_frame(
    instance_id: Optional[str],
    points,
    class_names: Optional[List[str]] = None,
    class_colors: Optional[List[str]] = None,
    class_counts_by_id: Optional[Dict] = None,
) -> bytes:
    """Pack a centroids frame: rows of ``[id, x, y, class_id]``."""
    buf = bytearray()
    _pack_header(buf, KIND_CENTROIDS, instance_id)
    _pack_metadata(buf, class_names, class_colors, class_counts_by_id)

    matrix = _as_int32(points, 4)
    buf.extend(struct.pack("<I", len(matrix)))
    buf.extend(np.ascontiguousarray(matrix, dtype="<i4").tobytes())
    return bytes(buf)


def pack_contours_frame(
    instance_id: Optional[str],
    kind: int,
    ids: np.ndarray,
    class_ids: np.ndarray,
    contours,
    class_names: Optional[List[str]] = None,
    class_colors: Optional[List[str]] = None,
    class_counts_by_id: Optional[Dict] = None,
) -> bytes:
    """Pack an annotations/all_annotations frame. ``contours`` is an ``(n, k, 2)``
    array or a list of ``(k_i, 2)`` arrays, in ``ids`` order. Array-only on
    purpose: a per-cell Python loop over a whole slide holds the GIL for
    hundreds of milliseconds and stalls the event loop."""
    buf = bytearray()
    _pack_header(buf, kind, instance_id)
    _pack_metadata(buf, class_names, class_colors, class_counts_by_id)

    if isinstance(contours, np.ndarray) and contours.ndim == 3:
        point_counts = np.full(len(contours), contours.shape[1], dtype="<i4")
        xy = contours.reshape(-1, 2)
    else:
        point_counts = np.fromiter((len(c) for c in contours), dtype="<i4", count=len(contours))
        xy = np.concatenate(contours) if len(contours) else np.zeros((0, 2), dtype=np.int32)

    # join, not extend, and a memoryview for the xy block: it is tens of MB and
    # join copies it anyway, so materialising an intermediate bytes for it
    # doubles the work (63 MB: 7.3 ms -> 3.5 ms).
    return b"".join((
        bytes(buf),
        struct.pack("<II", len(ids), len(xy)),
        np.asarray(ids, dtype="<i4").tobytes(),
        np.asarray(class_ids, dtype="<i4").tobytes(),
        point_counts.tobytes(),
        memoryview(np.ascontiguousarray(xy, dtype="<i4")).cast("B"),
    ))
