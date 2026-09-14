"""
Zarr File Group Names Configuration

This module centralizes all Zarr group and dataset names used across the application.
"""

import zarr


# === Group Names ===
class ZarrGroups:
    """Top-level Zarr group names"""
    # Canonical name for nuclei/cell segmentation results. Renamed from
    # 'SegmentationNode' (also 'nuclei_segmentation' / 'morphology' in various
    # legacy entry points). Existing zarr files need scripts/migrate_segmentation_groups.py.
    CELL_SEGMENTATION = 'Cell-Segmentation'
    # Canonical name for nuclei/cell classification results. Renamed from
    # 'ClassificationNode'. Existing zarr files need
    # scripts/migrate_classification_groups.py.
    CELL_CLASSIFICATION = 'Cell-Classification'
    # Patch-level outputs (MUSK and friends). Previously a single 'MuskNode'
    # group; now split: PATCH_SEGMENTATION holds embeddings + coordinates,
    # PATCH_CLASSIFICATION holds class_indices/probabilities/classes/metadata.
    # Existing zarr files need scripts/migrate_patch_groups.py.
    PATCH_SEGMENTATION = 'Patch-Segmentation'
    PATCH_CLASSIFICATION = 'Patch-Classification'
    # User annotations: cell/patch structured arrays + freeform ``manual.json``.
    USER_ANNOTATIONS = 'User-Annotations'


# === Dataset Names ===
class ZarrDatasets:
    """Dataset names used in Zarr files"""
    # User annotation subgroups (under USER_ANNOTATIONS); each is a dense
    # structured array with the unified annotation row dtype.
    CELL = 'cell'                     # (N_cells,)   row per detected cell
    PATCH = 'patch'                   # (N_patches,) row per detected patch

    # Segmentation datasets (plural — one row per nucleus)
    CENTROIDS = 'centroids'
    CONTOURS = 'contours'
    # Canonical per-cell/patch embedding slot.
    EMBEDDINGS = 'embeddings'
    PROBABILITIES = 'probabilities'   # shared: Cell-Segmentation (N,) and Cell-Classification (N, M)
    METADATA = 'metadata'             # group with attrs: model, model_version, nuclei_count, ...

    # Classification datasets
    CLASS_INDICES = 'class_indices'   # (N,) per-cell predicted class index; -1 = unclassified
    USER_DATA = 'userData'

    # Per-class taxonomy (lives under Cell-Classification/classes/)
    CLASSES = 'classes'               # subgroup name
    CLASSES_INDEX = 'index'           # (M,) [0, 1, ..., M-1]
    CLASSES_NAME = 'name'             # (M,) S256 display names
    CLASSES_COLOR = 'color'           # (M,) S256 hex colors


# === Path Helpers ===
class ZarrPaths:
    """Common Zarr paths (for path-style access like zarr['path/to/data'])"""
    USER_ANNOTATIONS_CELL = 'User-Annotations/cell'
    USER_ANNOTATIONS_PATCH = 'User-Annotations/patch'


# === Helper Functions ===
def find_segmentation_group(zarr_file):
    """
    Return the canonical segmentation group, or None if not present.
    """
    if ZarrGroups.CELL_SEGMENTATION in zarr_file:
        return zarr_file[ZarrGroups.CELL_SEGMENTATION]
    return None


def find_classification_group(zarr_file):
    """
    Return the canonical classification group, or None if not present.
    """
    if ZarrGroups.CELL_CLASSIFICATION in zarr_file:
        return zarr_file[ZarrGroups.CELL_CLASSIFICATION]
    return None


# === User-Annotations class palette helpers ===
#
# Storage format: parent-group attrs hold both palettes side-by-side under
# prefixed keys.
#   User-Annotations/.zattrs:
#     cell_class_names  / cell_class_colors
#     patch_class_names / patch_class_colors
#
# Anything else (bare `class_names`/`class_colors` at parent, OR
# `class_names`/`class_colors` on the patch subarray) is legacy and must be
# migrated before this code can read it — see scripts/migrate_user_anno_class_palette.py.

def _decode_attr_list(value):
    """Normalize a zarr attrs string list (which may come back as a numpy
    array of bytes) to a plain Python list[str]."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value]
    return [
        v.decode('utf-8') if isinstance(v, (bytes, bytearray)) else str(v)
        for v in value
    ]


def read_user_anno_class_palette(user_anno_group, kind):
    """Return (class_names, class_colors) for `kind` ('cell' or 'patch') from
    a User-Annotations group. Reads ONLY the prefixed keys
    (`<kind>_class_names` / `<kind>_class_colors`). Returns ([], []) when
    they're absent — un-migrated zarrs need to run the migration script."""
    if kind not in ('cell', 'patch'):
        raise ValueError(f"kind must be 'cell' or 'patch', got {kind!r}")
    attrs = user_anno_group.attrs
    names_key = f'{kind}_class_names'
    colors_key = f'{kind}_class_colors'
    if names_key not in attrs:
        return [], []
    return _decode_attr_list(attrs[names_key]), _decode_attr_list(attrs.get(colors_key))


def write_user_anno_class_palette(user_anno_group, kind, class_names, class_colors):
    """Persist a class palette under prefixed keys on the parent
    User-Annotations group. Idempotent."""
    if kind not in ('cell', 'patch'):
        raise ValueError(f"kind must be 'cell' or 'patch', got {kind!r}")
    user_anno_group.attrs[f'{kind}_class_names'] = [str(n) for n in (class_names or [])]
    user_anno_group.attrs[f'{kind}_class_colors'] = [str(c) for c in (class_colors or [])]
