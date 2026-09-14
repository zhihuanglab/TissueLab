"""The ROI outline is a union of whole patches, so its area is exactly known.

The previous OpenCV route traced the raster through pixel *centres*, so an
N x M block of patches came out as an (N-1) x (M-1) polygon — half a patch
short on every side, and a single patch degenerated to one point.
"""
import numpy as np
import pytest

from app.utils.geometry import (
    binary_close,
    cell_outline,
    ellipse_kernel,
    largest_component,
    rect_union_outline,
)


def _area(ring):
    p = np.asarray(ring, float)
    x, y = p[:, 0], p[:, 1]
    return abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2


def test_single_cell_is_a_square_not_a_point():
    mask = np.zeros((5, 5), bool)
    mask[2, 2] = True
    ring = cell_outline(largest_component(mask))
    assert len(ring) == 4
    assert _area(ring) == 1


def test_block_area_equals_its_cell_count():
    mask = np.zeros((8, 8), bool)
    mask[2:5, 2:6] = True                     # 3 x 4 = 12 cells
    ring = cell_outline(largest_component(mask))
    assert len(ring) == 4
    assert _area(ring) == 12


@pytest.mark.parametrize("seed", range(25))
def test_outline_area_matches_cell_count_and_sits_on_the_lattice(seed):
    rng = np.random.default_rng(seed)
    mask = np.zeros((20, 20), bool)
    for _ in range(rng.integers(1, 5)):
        y, x = rng.integers(0, 14, 2)
        mask[y:y + rng.integers(1, 7), x:x + rng.integers(1, 7)] = True
    component = largest_component(mask)
    if component is None:
        pytest.skip("empty mask")
    # holes would make the outer ring enclose more than the filled cells
    from scipy import ndimage
    component = ndimage.binary_fill_holes(component)
    ring = cell_outline(component)
    assert _area(ring) == component.sum()
    assert all(float(v).is_integer() for point in ring for v in point)


def test_l_shape_keeps_its_corner():
    mask = np.zeros((10, 10), bool)
    mask[2:8, 2:5] = True
    mask[5:8, 2:9] = True
    ring = cell_outline(largest_component(mask))
    assert _area(ring) == mask.sum()
    assert len(ring) == 6                     # an L has six corners


def test_closing_keeps_a_region_touching_the_border():
    """The two phases need opposite padding; one binary_closing call would not."""
    mask = np.zeros((8, 8), bool)
    mask[0:4, 0:4] = True
    assert np.array_equal(binary_close(mask, 2), mask)


def test_ellipse_kernel_is_symmetric_and_round():
    kernel = ellipse_kernel(3)
    assert kernel.shape == (7, 7)
    assert np.array_equal(kernel, kernel[::-1])
    assert np.array_equal(kernel, kernel[:, ::-1])
    assert kernel[3].all() and not kernel[0, 0]


def test_rect_union_outline_covers_exactly_the_boxes():
    """Two patches side by side: one rectangle, area = both boxes."""
    ring = rect_union_outline([(0, 0, 9, 9), (10, 0, 19, 9)])
    assert _area(ring) == 200                 # 20 x 10, boxes are inclusive
    assert len(ring) == 4


def test_rect_union_outline_keeps_a_concave_corner():
    ring = rect_union_outline([(0, 0, 9, 9), (0, 10, 4, 19)])
    assert _area(ring) == 100 + 50
    assert len(ring) == 6


def test_rect_union_outline_ignores_a_detached_group():
    """RETR_EXTERNAL semantics: the biggest region wins, as before."""
    ring = rect_union_outline([(0, 0, 9, 9), (100, 100, 102, 102)])
    assert _area(ring) == 100


def test_rect_union_outline_does_not_scale_with_pixel_extent():
    """Coordinate compression, not rasterisation.

    Rasterising boxes spread over 200k pixels needed a 40-gigapixel mask; the
    compressed grid is bounded by the box count instead.
    """
    boxes = [(i * 20000, i * 20000, i * 20000 + 99, i * 20000 + 99) for i in range(10)]
    ring = rect_union_outline(boxes)
    assert _area(ring) == 100 * 100           # only the largest group survives


def test_patch_group_outline_closes_the_ring():
    """What seg.py's get_contour_points now returns for a group of patches."""
    from app.utils.geometry import patch_group_outline

    coords = np.array([[0, 0, 9, 9], [10, 0, 19, 9], [0, 10, 9, 19]])
    points = patch_group_outline(coords, [0, 1, 2])
    assert points[0] == points[-1], "annotation payloads expect a closed ring"
    assert _area(points[:-1]) == 300          # three 10x10 boxes
    assert len(points) == 7                   # six corners of the L, plus the repeat


def test_patch_group_outline_selects_by_index():
    from app.utils.geometry import patch_group_outline

    coords = np.array([[0, 0, 9, 9], [500, 500, 509, 509]])
    assert _area(patch_group_outline(coords, [0])[:-1]) == 100
    assert patch_group_outline(coords, []) == []


def test_roi_polygon_covers_every_patch_it_recommends():
    """_roi_component_to_polygon end to end, at the shipped ROI settings."""
    from app.services.tasks import _PatchStats, _ROIConfig, _roi_component_to_polygon

    config = _ROIConfig(width_px=560, height_px=560, patch_size_px=56,
                        morphology_close_radius=0, fill_holes=True,
                        remove_small_islands_min_patches=0)
    # an L of six patches, given as (py, px)
    cells = [(2, 2), (3, 2), (4, 2), (4, 3), (4, 4), (2, 3)]
    stats = {(px, py): _PatchStats(px=px, py=py, N=3) for py, px in cells}
    polygon, patches_info, bbox, summary = _roi_component_to_polygon(cells, config, stats)

    assert _area(polygon) == len(cells) * config.patch_size_px ** 2
    assert len(patches_info) == len(cells)
    assert summary["num_patches"] == len(cells)
    assert bbox["x"] == 2 * 56 and bbox["y"] == 2 * 56


def test_roi_polygon_of_a_single_patch_is_a_square():
    """It used to come back as one point, which cannot be drawn."""
    from app.services.tasks import _PatchStats, _ROIConfig, _roi_component_to_polygon

    config = _ROIConfig(width_px=560, height_px=560, patch_size_px=56,
                        morphology_close_radius=0, remove_small_islands_min_patches=0)
    polygon, _, _, _ = _roi_component_to_polygon([(1, 1)], config,
                                                 {(1, 1): _PatchStats(px=1, py=1)})
    assert len(polygon) == 4
    assert _area(polygon) == 56 ** 2


def test_roi_polygon_is_empty_when_nothing_is_selected():
    from app.services.tasks import _ROIConfig, _roi_component_to_polygon

    assert _roi_component_to_polygon([], _ROIConfig(), {})[0] == []


def test_seg_ring_convex_hull_returns_a_closed_ring():
    """SegmentationHandler._ring_convex_hull consumes the hull directly.

    It used to index cv2's (N, 1, 2) output as hull[:, 0, :]; a plain (N, 2)
    array raises IndexError there, and the call is outside the try block.
    """
    from app.services.seg import SegmentationHandler

    concave = np.array([[0, 0], [8, 0], [4, 2], [8, 8], [0, 8]], np.float32)
    ring = SegmentationHandler._ring_convex_hull(None, concave)

    assert ring is not None
    assert ring.ndim == 2 and ring.shape[1] == 2
    assert np.array_equal(ring[0], ring[-1]), "the ring has to come back closed"
    assert _area(ring[:-1]) == 64                # the hull is the 8x8 square


def test_seg_ring_convex_hull_rejects_degenerate_input():
    from app.services.seg import SegmentationHandler

    assert SegmentationHandler._ring_convex_hull(None, np.zeros((2, 2))) is None
    collinear = np.array([[0, 0], [1, 1], [2, 2], [3, 3]], np.float32)
    assert SegmentationHandler._ring_convex_hull(None, collinear) is None
