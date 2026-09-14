"""The two call sites that lost OpenCV, driven through their real entry points.

test_geometry covers the primitives; these run the methods that use them, so a
contract that only breaks in the caller — as the convex-hull shape did — shows
up here.
"""
import numpy as np
import pytest

from app.services.seg import SegmentationHandler
from app.services.tasks import _PatchStats, _ROIConfig, _roi_component_to_polygon


def _area(ring):
    p = np.asarray(ring, float)
    x, y = p[:, 0], p[:, 1]
    return abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2


def _handler(boxes, class_ids=None):
    """A handler carrying only what patch merging reads."""
    handler = object.__new__(SegmentationHandler)
    handler.patch_coordinates = np.asarray(boxes)
    count = len(boxes)
    handler.patch_class_id = np.zeros(count, int) if class_ids is None else np.asarray(class_ids)
    handler.patch_class_hex_color = np.array(["#ff0000", "#00ff00"])
    handler.patch_class_name = np.array(["Tumour", "Stroma"])
    return handler


def _grid_boxes(cols, rows, size=256, x0=1000, y0=2000):
    """Patch boxes as the handler's adjacency check expects them.

    It compares centre distance against the mean box width, so neighbours have
    to be `size` apart with a width of `size` — x2 = x1 + size, not x1 + size - 1.
    """
    return [(x0 + c * size, y0 + r * size, x0 + (c + 1) * size, y0 + (r + 1) * size)
            for r in range(rows) for c in range(cols)]


def _span(n, size=256):
    """Width of n adjacent boxes: the outline treats x2 as covered, as the
    rasterised mask it replaced did (mask[y1:y2+1, x1:x2+1])."""
    return n * size + 1


def test_merged_patch_annotation_covers_every_patch():
    boxes = _grid_boxes(3, 2)                       # 6 patches, one block
    handler = _handler(boxes)
    merged = handler.merge_patches_in_viewport(0, 0, 10_000, 10_000)

    assert len(merged) == 1, "one connected block is one annotation"
    body = next(iter(merged.values()))
    ring = _ring_of(body)
    assert _area(ring[:-1]) == _span(3) * _span(2)
    assert ring[0] == ring[-1]


def test_merged_patch_bounds_match_the_patches():
    boxes = _grid_boxes(2, 2)
    handler = _handler(boxes)
    merged = handler.merge_patches_in_viewport(0, 0, 10_000, 10_000)
    bounds = _bounds_of(next(iter(merged.values())))
    assert (bounds["minX"], bounds["minY"]) == (1000, 2000)
    assert (bounds["maxX"], bounds["maxY"]) == (1000 + _span(2), 2000 + _span(2))


def test_two_colours_stay_two_annotations():
    boxes = _grid_boxes(4, 1)
    handler = _handler(boxes, class_ids=[0, 0, 1, 1])
    merged = handler.merge_patches_in_viewport(0, 0, 10_000, 10_000)
    assert len(merged) == 2
    for body in merged.values():
        assert _area(_ring_of(body)[:-1]) == _span(2) * _span(1)


def test_concave_group_is_not_reduced_to_its_bounding_box():
    """The old OpenCV-missing fallback did exactly that."""
    boxes = _grid_boxes(3, 3)
    del boxes[4]                                    # punch out the middle
    handler = _handler(boxes)
    merged = handler.merge_patches_in_viewport(0, 0, 10_000, 10_000)
    ring = _ring_of(next(iter(merged.values())))
    # RETR_EXTERNAL semantics: the hole is not traced, but the outline is the
    # 3x3 square rather than a bounding box of something smaller
    assert _area(ring[:-1]) == _span(3) * _span(3)
    assert len(ring) == 5


def _ring_of(body):
    return [tuple(p) for p in body["target"]["selector"]["geometry"]["points"]]


def _bounds_of(body):
    return body["target"]["selector"]["geometry"]["bounds"]


def test_roi_polygon_matches_the_patches_it_reports():
    config = _ROIConfig(width_px=2240, height_px=2240, patch_size_px=56,
                        morphology_close_radius=1, fill_holes=True,
                        remove_small_islands_min_patches=0)
    cells = [(5, 5), (5, 6), (6, 5), (6, 6), (7, 5)]
    stats = {(px, py): _PatchStats(px=px, py=py, N=7) for py, px in cells}
    polygon, patches_info, bbox, summary = _roi_component_to_polygon(cells, config, stats)

    assert _area(polygon) == len(cells) * 56 ** 2
    assert {(p.py, p.px) for p in patches_info} == set(cells)
    assert summary["total_cells"] == 7 * len(cells)
    assert bbox["width"] == 2 * 56 and bbox["height"] == 3 * 56
