"""Exact outlines for regions made of axis-aligned rectangles.

An ROI is a group of whole patches, so the region it covers is a union of
equal squares and its outline is a rectilinear polygon: every edge runs along a
patch boundary. That outline has one correct answer, which this module walks
directly off the cell set.

The previous route went through OpenCV — rasterise the cells, trace the raster
with ``findContours``, then smooth the staircase with ``approxPolyDP``. Both
steps are approximations of something exact, and the simplification tolerance
in use (``polygon_simplify_tolerance_px / patch_size_px``, 0.5 by default) is
below one cell, so it only ever merged collinear points. That is what
``_merge_collinear`` does here, exactly and without a tolerance.
"""
from typing import List, Optional, Tuple

import numpy as np
from scipy import ndimage

Vertex = Tuple[int, int]


def _filled_bounds(mask: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    """Bounding box of the set cells as (row0, row1, col0, col1), end-exclusive.

    An ROI covers a handful of patches on a grid that spans the whole slide, so
    every step below would otherwise pay for millions of empty cells.
    """
    rows = np.flatnonzero(mask.any(axis=1))
    if rows.size == 0:
        return None
    cols = np.flatnonzero(mask.any(axis=0))
    return int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1


def largest_component(mask: np.ndarray) -> Optional[np.ndarray]:
    """The biggest 4-connected group of cells, or None if there are none.

    4-connectivity, not 8: two cells that meet only at a corner have no
    outline that is a simple polygon — the boundary would have to pass through
    that corner twice.
    """
    mask = np.asarray(mask, dtype=bool)
    bounds = _filled_bounds(mask)
    if bounds is None:
        return None
    r0, r1, c0, c1 = bounds
    labels, count = ndimage.label(mask[r0:r1, c0:c1])
    sizes = ndimage.sum_labels(np.ones_like(labels), labels, index=range(1, count + 1))
    out = np.zeros_like(mask)
    out[r0:r1, c0:c1] = labels == (int(np.argmax(sizes)) + 1)
    return out


def _boundary_edges(cells: np.ndarray) -> dict:
    """Directed unit edges of the outline, keyed by their start vertex.

    Vertices are lattice points: cell (row, col) spans x in [col, col+1] and y
    in [row, row+1]. Each edge is directed so that the filled side is on its
    left, which makes the walk below single-valued and consistently wound.
    """
    height, width = cells.shape
    padded = np.zeros((height + 2, width + 2), bool)
    padded[1:-1, 1:-1] = cells
    inner = padded[1:-1, 1:-1]
    # One boolean grid per side rather than a Python loop over the cells: a
    # region can span a lot of them, and only the walk below has to be serial.
    sides = (
        (inner & ~padded[:-2, 1:-1], (0, 0), (1, 0)),   # top:    ->  +x
        (inner & ~padded[1:-1, 2:], (1, 0), (1, 1)),    # right:  ->  +y
        (inner & ~padded[2:, 1:-1], (1, 1), (0, 1)),    # bottom: ->  -x
        (inner & ~padded[1:-1, :-2], (0, 1), (0, 0)),   # left:   ->  -y
    )
    edges: dict = {}
    for present, tail, head in sides:
        rows, cols = np.nonzero(present)
        for r, c in zip(cols.tolist(), rows.tolist()):
            edges.setdefault((r + tail[0], c + tail[1]),
                             []).append((r + head[0], c + head[1]))
    return edges


def _merge_collinear(ring: List[Vertex]) -> List[Vertex]:
    """Drop vertices that continue the previous direction."""
    if len(ring) < 3:
        return ring
    out: List[Vertex] = []
    for i, point in enumerate(ring):
        prev, nxt = ring[i - 1], ring[(i + 1) % len(ring)]
        if (point[0] - prev[0]) * (nxt[1] - point[1]) != (point[1] - prev[1]) * (nxt[0] - point[0]):
            out.append(point)
    return out


def cell_outline(cells: np.ndarray) -> List[Vertex]:
    """Vertices of the outline of ``cells``, in lattice coordinates.

    The ring starts at the lowest (x, y) vertex so the result does not depend
    on iteration order, and closes implicitly: the last vertex joins the first.
    """
    cells = np.asarray(cells, dtype=bool)
    bounds = _filled_bounds(cells)
    if bounds is None:
        return []
    r0, r1, c0, c1 = bounds
    edges = _boundary_edges(cells[r0:r1, c0:c1])
    if not edges:
        return []
    start = min(edges)
    ring: List[Vertex] = [start]
    current = edges[start][0]
    used = {(start, current)}
    while current != start:
        options = edges.get(current)
        if not options:
            break                            # open chain: cannot happen for a cell set
        step = next((v for v in options if (current, v) not in used), options[0])
        used.add((current, step))
        ring.append(current)
        current = step
        if len(ring) > 4 * cells.size + 4:   # guard, should never fire
            break
    return [(x + c0, y + r0) for x, y in _merge_collinear(ring)]


def ellipse_kernel(radius: int) -> np.ndarray:
    """The structuring element cv2.getStructuringElement(MORPH_ELLIPSE) builds."""
    size = 2 * radius + 1
    kernel = np.zeros((size, size), bool)
    for i in range(size):
        dy = i - radius
        half = int(round(np.sqrt(max(0.0, radius ** 2 - dy ** 2)))) if radius else 0
        kernel[i, radius - half: radius + half + 1] = True
    return kernel


def binary_close(mask: np.ndarray, radius: int) -> np.ndarray:
    """Morphological closing that leaves cells on the border alone.

    The phases need opposite padding — dilation sees background outside the
    grid, erosion sees foreground — which is why this cannot be a single
    ``ndimage.binary_closing`` call: that takes one border value for both and
    eats any region touching the edge.
    """
    struct = ellipse_kernel(radius)
    src = np.asarray(mask, dtype=bool)
    bounds = _filled_bounds(src)
    if bounds is None:
        return src.copy()

    # Work on the filled region plus a margin. Closing cannot reach further than
    # the dilation does, and a cell inside the margin has its whole erosion
    # neighbourhood — and those cells' dilation neighbourhoods — within it.
    pad = 2 * radius + 1
    r0, r1, c0, c1 = bounds
    window = (slice(max(r0 - pad, 0), min(r1 + pad, src.shape[0])),
              slice(max(c0 - pad, 0), min(c1 + pad, src.shape[1])))
    patch = src[window]

    # Reproduce the whole-grid borders: dilation sees background off the grid,
    # erosion sees foreground, so mark the cells that fall outside it between
    # the two phases.
    inner = (slice(pad, pad + patch.shape[0]), slice(pad, pad + patch.shape[1]))
    off_grid = np.zeros((patch.shape[0] + 2 * pad, patch.shape[1] + 2 * pad), bool)
    if window[0].start == 0:
        off_grid[:pad, :] = True
    if window[0].stop == src.shape[0]:
        off_grid[-pad:, :] = True
    if window[1].start == 0:
        off_grid[:, :pad] = True
    if window[1].stop == src.shape[1]:
        off_grid[:, -pad:] = True

    work = np.zeros_like(off_grid)
    work[inner] = patch
    dilated = ndimage.binary_dilation(work, structure=struct, border_value=0)
    dilated |= off_grid
    eroded = ndimage.binary_erosion(dilated, structure=struct, border_value=1)

    out = np.zeros_like(src)
    out[window] = eroded[inner]
    return out


def rect_union_outline(rects) -> List[Tuple[float, float]]:
    """Outline of a union of axis-aligned rectangles, without rasterising it.

    ``rects`` are inclusive ``(x1, y1, x2, y2)`` boxes, so a box covers the
    half-open span ``[x1, x2 + 1)``. Only rectangle edges can appear in the
    outline, so compressing the coordinates to the distinct edge values gives a
    grid that is exact and bounded by the number of rectangles — rather than by
    the pixel extent, which for patches spread across a slide can be tens of
    thousands wide and cost hundreds of megabytes to allocate.
    """
    boxes = np.asarray(rects, dtype=np.int64).reshape(-1, 4)
    if boxes.size == 0:
        return []
    xs = np.unique(np.concatenate([boxes[:, 0], boxes[:, 2] + 1]))
    ys = np.unique(np.concatenate([boxes[:, 1], boxes[:, 3] + 1]))
    grid = np.zeros((ys.size - 1, xs.size - 1), bool)
    for x1, y1, x2, y2 in boxes:
        grid[np.searchsorted(ys, y1): np.searchsorted(ys, y2 + 1),
             np.searchsorted(xs, x1): np.searchsorted(xs, x2 + 1)] = True
    component = largest_component(grid)
    if component is None:
        return []
    return [(float(xs[c]), float(ys[r])) for c, r in cell_outline(component)]


def patch_group_outline(patch_coordinates, patches) -> List[List[float]]:
    """Closed outline of a group of patches, as ``[[x, y], ...]``.

    ``patch_coordinates`` is the handler's ``(N, 4)`` array of inclusive
    ``(x1, y1, x2, y2)`` boxes and ``patches`` indexes into it. The ring repeats
    its first point at the end, the way the annotation payloads expect.
    """
    if patches is None or len(patches) == 0:
        return []
    ring = rect_union_outline(np.asarray(patch_coordinates)[patches])
    if not ring:
        return []
    points = [[x, y] for x, y in ring]
    points.append(points[0])
    return points
