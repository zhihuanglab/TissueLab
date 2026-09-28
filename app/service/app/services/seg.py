import cv2

from app.utils.geometry import patch_group_outline
from app.services.patch_masks import mask_grid_transform
import math
import json
import orjson
import gc
import contextlib
from datetime import datetime
from scipy.spatial import KDTree
import numpy as np
import time
import threading
import os
from typing import Dict, List, Optional, Any, Tuple
from collections import OrderedDict
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from app.utils import resolve_path
from app.core.logger import logger
from app.config.zarr_config import (
    ZarrGroups,
    ZarrDatasets,
    find_segmentation_group,
    read_user_anno_class_palette,
    write_user_anno_class_palette,
)
from app.config.zarr_compat import (
    open_zarr,
    open_zarr_cm,
    create_array,
    as_zarr_path,
    is_zarr_store_path,
)
from app.config import zarr_compat as _zc

# Cross-platform file locking imports
try:
    import fcntl
    HAS_FCNTL = True
except ImportError:
    HAS_FCNTL = False

try:
    import msvcrt
    HAS_MSVCRT = True
except ImportError:
    HAS_MSVCRT = False

try:
    from matplotlib.path import Path
    MATPLOTLIB_AVAILABLE = True
except ImportError:
    MATPLOTLIB_AVAILABLE = False
    print("[WARN] Matplotlib not installed. Polygon filtering will fallback to bounding box.")

def safe_load_zarr_dataset(dataset):
    """Safely load Zarr dataset, handling both scalar and array datasets"""
    try:
        if dataset.shape == ():  # scalar dataset
            return dataset[()]
        else:  # array dataset
            return dataset[:]
    except Exception as e:
        # Fallback: try to load as scalar
        try:
            return dataset[()]
        except Exception as fallback_e:
            print(f"[WARN] Failed to load dataset even as scalar: {fallback_e}")
            return None

def transform_points_numpy(points, M):
    # points shape: (N, 2), M shape: (3, 3)
    # BLAS-optimized NumPy implementation with maximum performance
    # Use BLAS matrix multiplication: result = points @ M[:2, :2].T + M[:2, 2]
    result = points @ M[:2, :2].T + M[:2, 2]
    return result

def is_file_locked(file_path):
    """check if zarr file is locked"""
    try:
        with open_zarr_cm(file_path, 'r') as _:
            return False
    except:
        return True

def get_file_path(request_or_params):
    """Extract file path from request parameters - Zarr only.

    Resolution order:
      1. Explicit ``relative_path`` / ``file_path`` query/body (path-only APIs)
      2. Session ``current_file_path`` via ``X-Instance-ID`` (handler/viewer APIs)

    No global singleton fallback.
    """
    current_file_path = None
    
    # Extract parameters from request object or dict
    request_obj = None
    if hasattr(request_or_params, 'query_params'):
        # FastAPI Request object
        query_params = request_or_params.query_params
        request_obj = request_or_params
    elif isinstance(request_or_params, dict):
        # Dictionary of parameters
        query_params = request_or_params
    else:
        return None
    
    # Try to get relative_path first, then fall back to file_path for compatibility
    file_path = query_params.get('relative_path') or query_params.get('file_path')
    client_sent_absolute = False
    if file_path:
        # Resolve virtual path aliases first (e.g., 'samples/Data' -> '/data/public')
        from app.config.path_config import resolve_virtual_path
        file_path = resolve_virtual_path(file_path)
        if not file_path:
            return None  # Invalid path alias
        # Captured BEFORE resolve_path: that makes every path absolute, so
        # testing its output answers nothing. Alias expansion counts as
        # absolute — ``samples/Data/x`` legitimately lands outside the storage
        # root.
        client_sent_absolute = os.path.isabs(file_path)
        file_path = resolve_path(file_path)

    if file_path:
        from app.config.path_config import is_local_desktop_path

        # resolve_path has already joined a relative path under STORAGE_ROOT and
        # made it absolute, so the only question left is whether a path the
        # client sent as *relative* escaped the storage root by traversal. One
        # sent as absolute is a location the local user named themselves.
        #
        # Not "…and it exists": the caller may be about to create it, and
        # returning '' for a missing sidecar left the guard downstream with an
        # empty path, which it answered with READ_ACCESS_DENIED — a permission
        # denial for a path nobody was denied.
        file_path = os.path.normpath(file_path)
        if not client_sent_absolute and is_local_desktop_path(file_path):
            return ''
    
    if not file_path and request_obj is not None:
        # Prefer the viewer session slide over any global singleton path.
        try:
            from app.utils.common.request import get_instance_id
            from app.services.load import sessions, session_lock
            instance_id = get_instance_id(request_obj)
            if instance_id:
                with session_lock:
                    session = sessions.get(instance_id)
                    session_path = session.get("current_file_path") if session else None
                if session_path:
                    file_path = session_path
        except Exception:
            pass

    # No global current_file_path fallback: callers must pass an explicit path
    # or send X-Instance-ID with a bound session slide.
    
    current_file_path = file_path

    # Zarr-only resolution: always map a slide path to its companion ``.zarr``
    # store. Previously we only rewrote when the store already existed, so a
    # missing sidecar left callers with the ``.svs``/``.tiff`` file itself —
    # ``load_file`` then raised NotADirectoryError ("path exists but is not a
    # directory") and the classifications API returned 500. Prefer a missing
    # ``.zarr`` path so callers get FileNotFoundError / can degrade gracefully.
    if current_file_path:
        current_file_path = as_zarr_path(current_file_path)

    return current_file_path


def _unclassified_negative_annotations(zf, cell_classes, ua=None) -> Dict[str, List]:
    """Cells whose only label is a "No", and which no longer show a class.

    A negative selection stores ``-(2 + k)``: "this cell is NOT class k". It never
    says what the cell *is*, so the loader retracts a prediction it contradicts
    and the cell goes back to having no class — which the viewer would otherwise
    render as "Unclassified", i.e. "nobody has said anything about this cell".
    That is the opposite of the truth, so hand back the excluded class name and
    let the viewer say "Not <class>".

    Only the cells that actually ended up blank are returned; a cell marked
    "not QQQ" but predicted "Stroma" keeps Stroma and is not in here. The rule
    mirrors ``_clear_contradicted_predictions``, and is reproduced from the store
    rather than the handler so this stays a metadata-only read.
    """
    empty = {"cell_ids": [], "excluded_classes": []}
    neg_rows = np.flatnonzero(cell_classes <= -2)
    if neg_rows.size == 0:
        return empty          # the common case pays nothing beyond this test

    if ua is None:
        ua = zf['User-Annotations']
    ua_names, _ = read_user_anno_class_palette(ua, 'cell')
    if not ua_names:
        return empty
    excluded_k = (-cell_classes[neg_rows] - 2).astype(int)
    keep = (excluded_k >= 0) & (excluded_k < len(ua_names))
    neg_rows, excluded_k = neg_rows[keep], excluded_k[keep]
    if neg_rows.size == 0:
        return empty

    # Which of them still carry a model class. No classification at all means
    # every cell is blank, so they all qualify.
    grp = ZarrGroups.CELL_CLASSIFICATION
    class_indices = None
    model_names = []
    if grp in zf:
        if 'class_indices' in zf[grp]:
            class_indices = np.asarray(zf[grp]['class_indices'][()])
        if 'classes/name' in zf[grp]:
            model_names = [n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n)
                           for n in zf[grp]['classes/name'][()]]

    if class_indices is not None and len(model_names):
        in_range = neg_rows < len(class_indices)
        neg_rows, excluded_k = neg_rows[in_range], excluded_k[in_range]
        # The two palettes are ordered independently; bridge them by name, the
        # same way the exporters do. Built per *class* rather than per marked
        # cell — same reason as _clear_contradicted_predictions: a comprehension
        # over excluded_k is O(marked cells) of Python.
        model_index_of = {name: i for i, name in enumerate(model_names)}
        ua_to_model = np.array(
            [model_index_of.get(str(name), -1) for name in ua_names], dtype=int
        )
        excluded_model_idx = ua_to_model[excluded_k]
        current = class_indices[neg_rows]
        blank = (current < 0) | (current == excluded_model_idx)
        neg_rows, excluded_k = neg_rows[blank], excluded_k[blank]

    return {
        "cell_ids": neg_rows.tolist(),
        "excluded_classes": [str(ua_names[k]) for k in excluded_k],
    }


def get_user_annotation_indices(file_path: str) -> Dict[str, List[int]]:
    """Return indices of user-annotated (ground truth) nuclei and tissue from zarr.
    Data format follows save_tissue / save_annotation (User-Annotations/cell
    and User-Annotations/patch).

    Both kinds of mark count as ground truth: ``class >= 0`` is "this IS class k",
    ``class <= -2`` is a negative selection ("not class ``-class - 2``"). Only
    ``-1`` — never annotated, or cleared — is not the user's work. A "No" is
    something the user told us, so it highlights like any other annotation.

    Also returns ``negative_annotations``: the cells a "No" left with nothing to
    show, so the viewer can label them "Not <class>" instead of "Unclassified".
    See ``_unclassified_negative_annotations``.

    Returns:
        {"nuclei_indices": [int, ...], "tissue_indices": [int, ...],
         "negative_annotations": {"cell_ids": [int, ...], "excluded_classes": [str, ...]}}
    """
    result = {"nuclei_indices": [], "tissue_indices": [],
              "negative_annotations": {"cell_ids": [], "excluded_classes": []}}
    if not file_path or not os.path.exists(file_path):
        return result
    pending_cell_classes = None
    try:
        with open_zarr_cm(file_path, mode='r') as zf:
            # Look the group up once and hand it around. Every zarr v3 metadata
            # access — a containment test as much as an index — is a round trip
            # through zarr's async-to-sync bridge, measured at 0.35-0.6 ms each
            # against a ~7 ms array read. This block used to ask for
            # 'User-Annotations' twice and rebuild the group three times.
            ua = zf['User-Annotations'] if 'User-Annotations' in zf else None
            # Nuclei: User-Annotations/cell structured array; cell_class >= 0 means user-annotated
            if ua is not None and 'cell' in ua:
                arr = ua['cell']
                if hasattr(arr.dtype, 'names') and arr.dtype.names is not None and 'class' in arr.dtype.names:
                    full = arr[:]
                    cell_classes = np.asarray(full['class'])
                    annotated = (cell_classes >= 0) | (cell_classes <= -2)
                    result["nuclei_indices"] = np.where(annotated)[0].tolist()
                    # Computed after the patch read below, not here: the whole
                    # body shares one except-and-return-what-we-have, so a failure
                    # in the extra work would silently cost the caller its patch
                    # indices as well.
                    pending_cell_classes = cell_classes
            # Patch: User-Annotations/patch dense structured array. Same rule as
            # the cells above — positives and negative selections both count.
            if ua is not None and 'patch' in ua:
                parr = ua['patch']
                if hasattr(parr.dtype, 'names') and parr.dtype.names is not None and 'class' in parr.dtype.names:
                    pfull = parr[:]
                    mask = (pfull['class'] >= 0) | (pfull['class'] <= -2)
                    result["tissue_indices"] = np.where(mask)[0].tolist()
            if pending_cell_classes is not None:
                result["negative_annotations"] = _unclassified_negative_annotations(
                    zf, pending_cell_classes, ua=ua)
    except Exception as e:
        logger.warning(f"get_user_annotation_indices failed for {file_path}: {e}")
    return result


def clear_all_caches_and_reset_handler():
    """Clear all instance-scoped segmentation handlers."""
    global _annotations_data

    _annotations_data = {}

    try:
        from app.services.seg_registry import clear_all_instance_handlers
        clear_all_instance_handlers()
    except Exception as e:
        print(f"[WARN] Exception while trying to reset instance SegmentationHandlers: {e}")

    return {"status": "success", "message": "All caches cleared and handler reset."}

# Removed zarr cache related functions

# Removed force_release_all_zarr_files function

# Removed force_release_all_file_locks function

# Removed all cache-related functions

def query_viewport(handler: "SegmentationHandler",
                  x1: float, y1: float, x2: float, y2: float,
                  polygon_points: Optional[List[Tuple[float, float]]] = None, # Received in RAW frontend/OSD coordinates
                  class_name: Optional[str] = None, color: Optional[str] = None,
                  file_path: Optional[str] = None, with_classes: bool = False) -> Dict:
    """
    Query nuclei within viewport, optionally filtering points strictly inside the provided polygon.
    Coordinates (x1, y1, x2, y2, polygon_points) and handler centroids are expected in the same frontend/OSD image coordinate system.
    Uses KDTree (when available) for O(log N + K) candidate lookup, then exact bbox / polygon refine.
    """

    # Use handler's already loaded data instead of reading from file
    if handler.centroids is None or len(handler.centroids) == 0:
        raise ValueError("Centroids data not loaded in handler")

    centroids_arr = np.asarray(handler.centroids)
    total_centroids = len(centroids_arr)
    matching_indices: List[int] = []

    if total_centroids > 0:
        # A KDTree ball used to pre-filter candidates before this exact bbox
        # test, which is the tell: the bbox was always the real predicate and the
        # tree only ever narrowed the input to it. Do the bbox directly.
        in_bbox_mask = (
            (x1 <= centroids_arr[:, 0]) & (centroids_arr[:, 0] <= x2) &
            (y1 <= centroids_arr[:, 1]) & (centroids_arr[:, 1] <= y2)
        )
        indices_in_bbox = np.flatnonzero(in_bbox_mask)

        if len(indices_in_bbox) > 0:
            # 2. If Polygon points provided, perform PIP test using backend centroids and frontend polygon
            if polygon_points and MATPLOTLIB_AVAILABLE:
                points_to_test = centroids_arr[indices_in_bbox]

                try:
                    polygon_path = Path(polygon_points)
                    tolerance_radius = -1e-9
                    is_inside = polygon_path.contains_points(points_to_test, radius=tolerance_radius)
                    matching_indices = indices_in_bbox[np.where(is_inside)[0]].tolist()
                except Exception as pip_error:
                    print(f"[ERROR] query_viewport - Error during PIP test: {pip_error}")
                    traceback.print_exc()
                    matching_indices = indices_in_bbox.tolist()
                    print("[WARN] query_viewport - Falling back to BBox results due to PIP error.")

            else:  # Rectangle or no matplotlib
                if polygon_points and not MATPLOTLIB_AVAILABLE:
                    print("[WARN] query_viewport - Matplotlib not found. Returning all points within bounding box.")
                matching_indices = indices_in_bbox.tolist()

    # Store annotation colors based on the FINAL matching indices (indices into centroids array)
    if class_name and color and len(matching_indices) > 0:
        handler.store_annotation_color(matching_indices, class_name, color)

    result = {
        "viewport": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
        "matching_indices": matching_indices,
        "count": len(matching_indices),
    }

    # Per-cell current class, for the negative ("No") selection: it may only
    # retract a prediction it contradicts, and has no other source for this.
    # Opt-in because the same endpoint serves plain viewport refreshes and the
    # result set is unbounded — a name per cell on a 213k-cell viewport cost
    # 109 ms / 2.35 MB, against 11-16 ms for the query itself.
    if with_classes:
        class_ids = getattr(handler, "class_id", None)
        class_names = getattr(handler, "class_name", None)
        names_out = [str(n) for n in class_names] if class_names is not None else []
        if class_ids is not None and names_out and len(matching_indices) > 0:
            class_ids = np.asarray(class_ids)
            idx = np.asarray(matching_indices)
            cids = np.full(len(idx), -1, dtype=int)
            in_range = (idx >= 0) & (idx < len(class_ids))
            cids[in_range] = class_ids[idx[in_range]]
            # -1 for anything outside the palette so a client never indexes past it.
            cids[(cids < 0) | (cids >= len(names_out))] = -1
            result["matching_class_ids"] = cids.tolist()
        else:
            result["matching_class_ids"] = [-1] * len(matching_indices)
        result["class_names"] = names_out

    return result


def _zarr_str(value) -> Optional[str]:
    """Decode one zarr string cell (bytes / numpy str / str) to text."""
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except Exception:
            return None
    if isinstance(value, str):
        # Some writers land a repr of bytes ("b'Tumor'") in a str dataset.
        if len(value) > 3 and value[:2] in ("b'", 'b"') and value[-1] == value[1]:
            inner = value[2:-1]
            try:
                return inner.encode("latin-1").decode("unicode_escape")
            except Exception:
                return inner
        return value
    decoded = getattr(value, "decode", None)
    if callable(decoded):
        try:
            return value.decode("utf-8")
        except Exception:
            return None
    return str(value)


def _tissue_display_names(ts_group) -> List[str]:
    """Ordered display names from ``Tissue-Segmentation/classes/name``.

    Written in RUN order by the segmentation node — deliberately NOT the order
    ``masks/`` lists in, which comes from the store.
    """
    try:
        if 'classes' not in ts_group or 'name' not in ts_group['classes']:
            return []
        raw = ts_group['classes']['name'][()]
    except Exception:
        return []
    if raw is None:
        return []
    if isinstance(raw, np.ndarray):
        cells = raw.flat if raw.size else []
    elif isinstance(raw, (list, tuple)):
        cells = raw
    else:
        cells = [raw]
    out = []
    for cell in cells:
        name = _zarr_str(cell)
        if name:
            out.append(name)
    return out


def _norm_tissue_key(name) -> str:
    """Comparison key for a tissue name.

    The segmentation nodes derive a subgroup name with ``_sanitize_class_name``
    ("lymph node" -> "lymph_node") which preserves case, so ``masks/Tumor`` and
    the display name "Tumor" differ only by separators — but older stores and
    hand-built zarrs vary in case, so fold that too. Matches the viewer's
    ``normaliseTissueName`` so both ends agree on what "the same tissue" means.
    """
    return str(name or "").strip().lower().replace("_", " ")


def _tissue_display_name_for_sub(ts_group, sub: Optional[str]) -> Optional[str]:
    """Display name for the mask subgroup ``sub``, matched BY NAME.

    ``masks/<sub>`` and ``classes/name`` are two independent orderings (store
    listing vs. run order), so they must never be zipped by index — that is what
    made a mask render under a different tissue's name and colour.
    """
    if not sub:
        return None
    names = _tissue_display_names(ts_group)
    if not names:
        return None
    if sub == 'default':
        # Legacy single-tissue layout: the sole class IS this mask.
        return names[0] if len(names) == 1 else None
    target = _norm_tissue_key(sub)
    for name in names:
        if _norm_tissue_key(name) == target:
            return name
    return None


def list_mask_options(file_path: Optional[str] = None) -> Dict:
    """
    List available tissue masks from the unified Tissue-Segmentation layout:
    Tissue-Segmentation/masks/<tissue>/mask (2D bool). The 'default' subgroup maps to
    key 'mask' (label "Default") to preserve the default-toggle contract; every other
    subgroup maps to key=<tissue> (label = prettified tissue name).
    """
    if not file_path or not is_zarr_store_path(file_path):
        return {"success": False, "error": "Zarr file not found", "options": []}
    try:
        with open_zarr_cm(file_path, 'r') as zarr_file:
            options = []
            if 'Tissue-Segmentation' not in zarr_file:
                return {"success": True, "options": options}
            ts = zarr_file['Tissue-Segmentation']
            if 'masks' not in ts:
                return {"success": True, "options": options}
            masks_group = ts['masks']
            for sub in sorted(masks_group.keys()):
                try:
                    grp = masks_group[sub]
                    if not hasattr(grp, 'keys') or 'mask' not in grp:
                        continue
                    m = grp['mask']
                    if not hasattr(m, 'shape') or len(m.shape) != 2:
                        continue
                    if sub == 'default':
                        key, label = 'mask', 'Default'
                    else:
                        key = sub
                        # Prefer the tissue's real display name over one guessed
                        # from the subgroup, so the menu entry, the hover label
                        # and the overlay colour are all the same string
                        # ("Squamous Cell Carcinoma", not "Squamous cell carcinoma").
                        label = _tissue_display_name_for_sub(ts, sub) or sub.replace('_', ' ').capitalize()
                    options.append({"key": key, "label": label})
                except Exception:
                    continue
            return {"success": True, "options": options}
    except Exception as e:
        logger.exception(f"[Mask] list_mask_options failed: {e}")
        return {"success": False, "error": str(e), "options": []}


def get_segmentation_mask(handler: Optional["SegmentationHandler"],
                          x1: float, y1: float, x2: float, y2: float,
                          file_path: Optional[str] = None,
                          target_width: Optional[int] = None,
                          target_height: Optional[int] = None,
                          mask_key: Optional[str] = None) -> Dict:
    """
    Get binary mask for the given viewport.
    If mask_key is set (e.g. mask_Stroma), read from Segmentation/mask_key; otherwise
    read from SegmentationNode (mask, binary_mask, etc.).
    Coordinates are in RAW frontend/OSD image coordinate system.
    """
    start_time = time.time()
    step_start = time.time()

    # Step 1: Get file path
    if not file_path:
        if handler is None:
            raise ValueError("file_path is required when handler is not provided")
        file_path = handler.get_current_file_path()

    if not file_path or not is_zarr_store_path(file_path):
        raise ValueError(f"Zarr file not found: {file_path}")
    
    step_elapsed = time.time() - step_start

    try:
        # Step 2: Open Zarr file
        step_start = time.time()
        with open_zarr_cm(file_path, 'r') as zarr_file:
            step_elapsed = time.time() - step_start

            # Step 3: Resolve mask from the unified Tissue-Segmentation layout:
            #   Tissue-Segmentation/masks/<tissue>/mask (2D bool).
            # mask_key is the tissue subgroup name; "" / "mask" / None -> the 'default'
            # subgroup (or the sole tissue when no 'default' exists).
            step_start = time.time()
            if 'Tissue-Segmentation' not in zarr_file:
                return {"success": False, "error": "Tissue-Segmentation group not found"}
            ts_group = zarr_file['Tissue-Segmentation']
            if 'masks' not in ts_group:
                return {"success": False, "error": "Tissue-Segmentation/masks group not found"}
            masks_group = ts_group['masks']
            mask_dataset = None
            tissue_class = None
            sub = (mask_key or "").strip()
            if sub in ("", "mask"):
                # No key: fall back to 'default', else the first tissue in the
                # SAME order list_mask_options presents. zarr v3 lists a group in
                # store order, so `next(iter(...))` picked an arbitrary mask that
                # need not be the one the Tissue Overlay menu shows first.
                sub = "default" if "default" in masks_group else next(iter(sorted(masks_group.keys())), None)
            if sub and sub in masks_group and hasattr(masks_group[sub], 'keys') \
                    and 'mask' in masks_group[sub] \
                    and hasattr(masks_group[sub]['mask'], 'shape') and len(masks_group[sub]['mask'].shape) == 2:
                mask_dataset = masks_group[sub]['mask']
                tissue_class = "" if sub == "default" else sub
            if mask_dataset is None:
                return {"success": False, "error": "Mask dataset not found in Tissue-Segmentation/masks"}
            # Masks derived from patch classification (services/patch_masks.py)
            # are stored on the patch grid: one cell per `scale` level-0 pixels,
            # offset by `origin`. Everything below works in the mask's own
            # units, so bring the viewport into grid space here and scale the
            # sizes back on the way out. VISTA masks have scale 1, origin 0.
            raw_x1, raw_y1 = x1, y1
            grid_scale, (grid_ox, grid_oy) = mask_grid_transform(masks_group[sub])
            if grid_scale != 1 or grid_ox or grid_oy:
                x1 = (x1 - grid_ox) / grid_scale
                y1 = (y1 - grid_oy) / grid_scale
                x2 = (x2 - grid_ox) / grid_scale
                y2 = (y2 - grid_oy) / grid_scale
            # Note: overlay color is resolved on the frontend from the shared patch
            # classification color map (by tissue_class), so no color is returned here.
            
            step_elapsed = time.time() - step_start

            # Step 4: Get full mask shape
            step_start = time.time()
            mask_shape = mask_dataset.shape
            if len(mask_shape) != 2:
                return {"success": False, "error": f"Expected 2D mask, got shape {mask_shape}"}
            mask_height, mask_width = mask_shape
            step_elapsed = time.time() - step_start

            # Step 5: Calculate coordinates and optimize reading strategy
            step_start = time.time()
            # Store original requested viewport size (before clipping)
            requested_width = int(x2 - x1)
            requested_height = int(y2 - y1)
            
            # Clip coordinates to mask bounds for reading
            mask_x0 = max(0, min(int(x1), mask_width))
            mask_y0 = max(0, min(int(y1), mask_height))
            mask_x1 = max(0, min(int(x2), mask_width))
            mask_y1 = max(0, min(int(y2), mask_height))
            
            # Ensure valid range for reading
            if mask_x1 <= mask_x0:
                mask_x1 = mask_x0 + 1
            if mask_y1 <= mask_y0:
                mask_y1 = mask_y0 + 1
            
            actual_width = mask_x1 - mask_x0
            actual_height = mask_y1 - mask_y0
            
            # OPTIMIZATION: If target dimensions are provided, calculate stride to read downsampled data directly
            # This dramatically reduces I/O and memory usage (e.g., from 1.17B pixels to 776K pixels)
            use_stride_reading = False
            stride_x = 1
            stride_y = 1
            read_x0 = mask_x0
            read_y0 = mask_y0
            read_x1 = mask_x1
            read_y1 = mask_y1
            
            if target_width is not None and target_height is not None and target_width > 0 and target_height > 0:
                # Calculate aspect ratios
                requested_aspect = requested_width / requested_height if requested_height > 0 else 1.0
                target_aspect = target_width / target_height if target_height > 0 else 1.0
                
                # Calculate target dimensions maintaining viewport aspect ratio
                if requested_aspect > target_aspect:
                    # Viewport is wider - fit to target width
                    final_target_width = target_width
                    final_target_height = int(target_width / requested_aspect)
                else:
                    # Viewport is taller - fit to target height
                    final_target_height = target_height
                    final_target_width = int(target_height * requested_aspect)
                
                # Calculate stride based on actual read size vs target size
                # Add 20% buffer to ensure we don't lose edge information
                if actual_width > final_target_width * 1.2:
                    stride_x = max(1, int(actual_width / (final_target_width * 1.2)))
                    use_stride_reading = True
                if actual_height > final_target_height * 1.2:
                    stride_y = max(1, int(actual_height / (final_target_height * 1.2)))
                    use_stride_reading = True

            # Update actual_mask_width/height to reflect what will be read
            actual_mask_width = read_x1 - read_x0
            actual_mask_height = read_y1 - read_y0
            step_elapsed = time.time() - step_start

            # Step 6: Read mask data from Zarr (optimized with stride if applicable)
            step_start = time.time()
            if use_stride_reading:
                # Use stride reading to directly read downsampled data
                # This reduces I/O by ~1500x in typical cases
                mask_subset = mask_dataset[read_y0:read_y1:stride_y, read_x0:read_x1:stride_x]
                # Update actual dimensions to reflect stride reading
                actual_width = mask_subset.shape[1]
                actual_height = mask_subset.shape[0]
                actual_mask_width = actual_width * stride_x
                actual_mask_height = actual_height * stride_y
            else:
                # Read full resolution (for cases without target dimensions or when stride not beneficial)
                mask_subset = mask_dataset[read_y0:read_y1, read_x0:read_x1]
                actual_mask_width = actual_width
                actual_mask_height = actual_height
            step_elapsed = time.time() - step_start

            # Update actual dimensions to reflect what was actually read
            # Note: If stride reading was used, actual_width/height reflect the downsampled size
            if not use_stride_reading:
                actual_width = mask_subset.shape[1]
                actual_height = mask_subset.shape[0]
                # Ensure actual_mask_width/height are set correctly (represent original size)
                actual_mask_width = read_x1 - read_x0
                actual_mask_height = read_y1 - read_y0
            
            # If viewport exceeded image bounds, pad with zeros to match requested size
            # region_size should be the actual mask data size (before padding, before downsampling)
            # This ensures frontend calculates correct size even when viewport exceeds bounds
            # Note: If stride reading was used, we need to scale requested size to match stride resolution
            if use_stride_reading:
                # Scale requested size to match stride resolution
                scaled_requested_width = requested_width // stride_x
                scaled_requested_height = requested_height // stride_y
                scaled_actual_mask_width = actual_mask_width // stride_x
                scaled_actual_mask_height = actual_mask_height // stride_y
            else:
                scaled_requested_width = requested_width
                scaled_requested_height = requested_height
                scaled_actual_mask_width = actual_mask_width
                scaled_actual_mask_height = actual_mask_height
            
            # Step 7: Padding (if needed)
            step_start = time.time()
            if scaled_requested_width != actual_width or scaled_requested_height != actual_height:
                # Create full-size array filled with zeros (use scaled size if stride reading)
                padded_mask = np.zeros((scaled_requested_height, scaled_requested_width), dtype=mask_subset.dtype)
                
                # Calculate offset where the read data should be placed in the padded array
                # mask_x0 is clipped to [0, mask_width], so:
                # - If x1 < 0: mask_x0 = 0, offset_x = 0 - x1 > 0 (positive)
                # - If 0 <= x1 <= mask_width: mask_x0 = x1, offset_x = x1 - x1 = 0
                # - If x1 > mask_width: mask_x0 = mask_width, offset_x = mask_width - x1 < 0 (negative)
                # So offset_x can be negative when viewport exceeds right/bottom bounds, need to clip to 0
                if use_stride_reading:
                    # Scale offsets to match stride resolution
                    offset_x = (mask_x0 - int(x1)) // stride_x
                    offset_y = (mask_y0 - int(y1)) // stride_y
                else:
                    offset_x = mask_x0 - int(x1)
                    offset_y = mask_y0 - int(y1)
                
                # Clip offsets to valid range (non-negative)
                offset_x = max(0, offset_x)
                offset_y = max(0, offset_y)
                
                # Calculate how much data we can actually place (may be less if viewport was partially outside)
                place_width = min(actual_width, scaled_requested_width - offset_x)
                place_height = min(actual_height, scaled_requested_height - offset_y)
                
                # Place the read data into the padded array
                if place_width > 0 and place_height > 0:
                    padded_mask[offset_y:offset_y+place_height, offset_x:offset_x+place_width] = mask_subset[:place_height, :place_width]
                
                mask_subset = padded_mask
            step_elapsed = time.time() - step_start

            # Step 8: Convert to binary (ensure uint8)
            step_start = time.time()
            if mask_subset.dtype != np.uint8:
                mask_subset = (mask_subset > 0).astype(np.uint8) * 255
            else:
                # Ensure binary: 0 or 255
                mask_subset = (mask_subset > 0).astype(np.uint8) * 255
            step_elapsed = time.time() - step_start

            # Step 9: Downsample if target dimensions are provided
            step_start = time.time()
            # Maintain aspect ratio of the requested viewport region (now mask_subset matches requested size)
            # mask_subset now has the requested size (may be padded with zeros)
            viewport_height, viewport_width = mask_subset.shape
            final_height = viewport_height
            final_width = viewport_width
            
            # Calculate downsampling scale for actual mask data (if padding occurred)
            # This is needed to calculate the actual mask data size after downsampling
            downscale_x = 1.0
            downscale_y = 1.0
            
            if target_width is not None and target_height is not None and target_width > 0 and target_height > 0:
                # Calculate aspect ratios
                viewport_aspect = viewport_width / viewport_height if viewport_height > 0 else 1.0
                target_aspect = target_width / target_height if target_height > 0 else 1.0
                
                # Calculate target dimensions maintaining viewport aspect ratio
                if viewport_aspect > target_aspect:
                    # Viewport is wider - fit to target width
                    final_width = target_width
                    final_height = int(target_width / viewport_aspect)
                else:
                    # Viewport is taller - fit to target height
                    final_height = target_height
                    final_width = int(target_height * viewport_aspect)
                
                # Only resize if current size is significantly different from target
                # (If stride reading was used, we may already be close to target size)
                if abs(viewport_width - final_width) > 2 or abs(viewport_height - final_height) > 2:
                    # Calculate downsampling scale
                    # Use actual mask data size if padding occurred, otherwise use viewport size
                    # This ensures correct scale calculation even when viewport exceeds bounds
                    if use_stride_reading:
                        # If stride reading was used, actual_mask_width/height represent original size
                        # Scale them to match current viewport resolution
                        effective_mask_width = actual_mask_width if actual_mask_width > 0 else (viewport_width * stride_x)
                        effective_mask_height = actual_mask_height if actual_mask_height > 0 else (viewport_height * stride_y)
                        downscale_x = effective_mask_width / final_width
                        downscale_y = effective_mask_height / final_height
                    elif scaled_requested_width != actual_mask_width or scaled_requested_height != actual_mask_height:
                        # Padding occurred, use actual mask data size for scale calculation
                        effective_mask_width = actual_mask_width if actual_mask_width > 0 else viewport_width
                        effective_mask_height = actual_mask_height if actual_mask_height > 0 else viewport_height
                        downscale_x = effective_mask_width / final_width
                        downscale_y = effective_mask_height / final_height
                    else:
                        # No padding, use viewport size
                        downscale_x = viewport_width / final_width
                        downscale_y = viewport_height / final_height
                    
                    # Nearest neighbour keeps the mask binary; cv2 takes (width, height)
                    mask_subset = cv2.resize(mask_subset, (final_width, final_height), interpolation=cv2.INTER_NEAREST)
            step_elapsed = time.time() - step_start

            # Step 10: Resolve the DISPLAY name for the mask Step 3 actually
            # selected. `sub` is the zarr-safe subgroup name ("lymph_node");
            # classes/name holds display names ("Lymph node") in RUN order, which
            # is NOT the order masks/ lists in — so match by name, never by index.
            # This previously read classes/name[0] unconditionally whenever no
            # mask_key was given, labelling and colouring whichever mask the store
            # happened to list first with the first tissue that was run. Correct
            # only when the group held exactly one mask.
            step_start = time.time()
            display_name = _tissue_display_name_for_sub(ts_group, sub)
            if display_name:
                tissue_class = display_name
            step_elapsed = time.time() - step_start


            # Step 11: Convert to bytes
            step_start = time.time()
            result = {
                "success": True,
                "data": mask_subset.tobytes(),
                "shape": [final_height, final_width],
                "dtype": "uint8",
                "offset": [int(raw_x1), int(raw_y1)],  # Original requested offset in RAW coordinates (may be negative)
                "full_shape": [mask_height * grid_scale + grid_oy, mask_width * grid_scale + grid_ox],
                # Actual mask data size in RAW coordinates (before padding, before downsampling)
                "region_size": [actual_mask_width * grid_scale, actual_mask_height * grid_scale]
            }
            
            if tissue_class and tissue_class != 'default':
                result["class"] = tissue_class
            
            step_elapsed = time.time() - step_start

            # Total time
            total_elapsed = time.time() - start_time

            return result
    except Exception as e:
        total_elapsed = time.time() - start_time
        logger.error(f"[Mask] Error after {total_elapsed*1000:.2f}ms: {str(e)}", exc_info=e)
        traceback.print_exc()
        return {"success": False, "error": str(e)}


def query_patches_in_viewport(handler: Optional["SegmentationHandler"],
                             x1: float, y1: float, x2: float, y2: float,
                             polygon_points: Optional[List[Tuple[float, float]]] = None,
                             file_path: Optional[str] = None) -> Dict:
    """
    Query patches whose centroids fall within the viewport or polygon.
    All coordinates are expected in RAW frontend/OSD coordinate system.
    """
    if not file_path:
        raise ValueError("No file path provided for query_patches_in_viewport")

    if not os.path.exists(file_path):
        raise ValueError(f"Zarr file not found: {file_path}")

    # Read patch coordinates directly from Zarr file
    try:
        with open_zarr_cm(file_path, 'r') as zarr_file:
            # Look for patch coordinates in different possible locations
            patch_coords_data = None
            
            # First try root level keys
            for key in ['patch_coordinates', 'patch_coords', 'patches']:
                if key in zarr_file:
                    patch_coords_data = zarr_file[key]
                    break
            
            # Patch coordinates live in Patch-Segmentation (MUSK embedding writer).
            if patch_coords_data is None and 'Patch-Segmentation' in zarr_file:
                patch_seg = zarr_file['Patch-Segmentation']
                if 'coordinates' in patch_seg:
                    patch_coords_data = patch_seg['coordinates']

            # If still not found, try other possible group locations
            if patch_coords_data is None:
                for group_name in ['PatchNode', 'PatchData', 'patches']:
                    if group_name in zarr_file:
                        group = zarr_file[group_name]
                        for coord_key in ['coordinates', 'coords', 'patch_coordinates']:
                            if coord_key in group:
                                patch_coords_data = group[coord_key]
                                break
                        if patch_coords_data is not None:
                            break
            
            if patch_coords_data is None:
                raise ValueError("Patch coordinates data not found in Zarr file")

            query_start = time.time()
            original_patch_coords_level0 = np.array(patch_coords_data)
            total_patches = len(original_patch_coords_level0)
            matching_indices = []

            if total_patches > 0:
                # Validate patch coordinates shape before accessing columns
                if len(original_patch_coords_level0.shape) < 2 or original_patch_coords_level0.shape[1] < 4:
                    raise ValueError(f"Expected patch coordinates to have at least 4 columns (Nx4), but got shape {original_patch_coords_level0.shape}")
                
                # Calculate centroids for all patches (in Level 0 coordinates)
                centroids_x = np.mean(original_patch_coords_level0[:, [0, 2]], axis=1)
                centroids_y = np.mean(original_patch_coords_level0[:, [1, 3]], axis=1)
                
                if polygon_points and MATPLOTLIB_AVAILABLE:
                    # For polygon query, first filter by viewport for optimization
                    viewport_mask = (
                        (centroids_x >= x1) & (centroids_x <= x2) &
                        (centroids_y >= y1) & (centroids_y <= y2)
                    )
                    indices_in_viewport = np.where(viewport_mask)[0]

                    if len(indices_in_viewport) > 0:
                        # For polygon filtering, use the viewport-filtered centroids
                        points_to_test = np.column_stack((
                            centroids_x[indices_in_viewport],
                            centroids_y[indices_in_viewport]
                        ))

                        try:
                            polygon_path = Path(polygon_points)
                            tolerance_radius = -1e-9
                            is_inside = polygon_path.contains_points(points_to_test, radius=tolerance_radius)
                            final_indices_mask = np.where(is_inside)[0]
                            matching_indices = indices_in_viewport[final_indices_mask].tolist()
                        except Exception as pip_error:
                            print(f"[ERROR] query_patches_in_viewport - Error during PIP test: {pip_error}")
                            matching_indices = []
                            print("[WARN] query_patches_in_viewport - Error in polygon test, returning empty result")
                else:
                    # For bbox query, use the original bbox coordinates
                    bbox_mask = (
                        (centroids_x >= min(x1, x2)) & (centroids_x <= max(x1, x2)) &
                        (centroids_y >= min(y1, y2)) & (centroids_y <= max(y1, y2))
                    )
                    matching_indices = np.where(bbox_mask)[0].tolist()

            query_end = time.time()

            return {
                "viewport": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                "matching_patch_indices": matching_indices,
                "count": len(matching_indices)
            }
    except Exception as e:
        print(f"[ERROR] query_patches_in_viewport - Error reading Zarr file: {e}")
        raise ValueError(f"Error reading Zarr file: {str(e)}")

def get_tissues(handler: "SegmentationHandler", file_path: Optional[str] = None) -> Dict:
    """Get tissue data"""
    
    # if a new file path is provided, load it
    if file_path and os.path.exists(file_path):
        handler.load_file(file_path, force_reload=False)
    else:
        # otherwise use the current loaded file path
        file_path = handler.get_current_file_path()
        if file_path:
            handler.load_file(file_path, force_reload=False)
        else:
            return {
                "tissues": [],
                "patch": {},
                "count": 0
            }
    
    tissues = handler.tissues
    tissue_annotations = handler.get_all_tissue_annotations()
    
    return {
        "tissues": tissues,
        "patch": tissue_annotations,
        "count": len(tissues)
    }

def reload_segmentation_data(handler: "SegmentationHandler", path: Optional[str] = None) -> Dict:
    """Reload segmentation data"""
    
    if path:
        zarr_path = as_zarr_path(path)
        
        # Check if we need to switch to a different zarr file
        current_zarr_file = handler.zarr_file
        if current_zarr_file != zarr_path:
            # Switching to a different file - need to load it
            if os.path.exists(zarr_path):
                try:
                    handler.load_file(zarr_path, force_reload=True, reload_segmentation_data=True)
                    return {
                        "message": f"Successfully switched to and reloaded segmentation data from {zarr_path}",
                    }
                except Exception as e:
                    logger.error(f"Failed to load zarr file {zarr_path}: {e}", exc_info=e)
                    return {
                        "message": f"Failed to load zarr file: {str(e)}",
                        "error": str(e)
                    }
            else:
                # File doesn't exist, but still invalidate cache
                handler.invalidate_user_counts_cache()
                return {
                    "message": f"Zarr file not found: {zarr_path}. Cache invalidated.",
                }
        else:
            # Same file - just invalidate cache and reload
            handler.invalidate_user_counts_cache()
            if os.path.exists(zarr_path):
                try:
                    handler.load_file(zarr_path, force_reload=True, reload_segmentation_data=True)
                    return {
                        "message": f"Successfully reloaded segmentation data from {zarr_path}",
                    }
                except Exception as e:
                    logger.error(f"Failed to reload zarr file {zarr_path}: {e}", exc_info=e)
                    return {
                        "message": f"Failed to reload zarr file: {str(e)}",
                        "error": str(e)
                    }
            else:
                return {
                    "message": f"Zarr file not found: {zarr_path}. Cache invalidated.",
                }
    else:
        current_path = handler.get_current_file_path()
        # Force reload to ensure data is refreshed after workflow completion
        handler.invalidate_user_counts_cache()
        if current_path and os.path.exists(current_path):
            try:
                handler.load_file(current_path, force_reload=True, reload_segmentation_data=True)
                return {
                    "message": f"Successfully reloaded segmentation data from {current_path}",
                }
            except Exception as e:
                logger.error(f"Failed to reload zarr file {current_path}: {e}", exc_info=e)
                return {
                    "message": f"Failed to reload zarr file: {str(e)}",
                    "error": str(e)
                }
        else:
            return {
                "message": f"Successfully invalidated cache for {current_path or 'unknown path'}",
            }

def reset_segmentation_data(handler: "SegmentationHandler") -> Dict:
    """Reset all segmentation data when switching images"""
    handler.reset_data()
    
    return {
        "message": "Successfully reset all segmentation data",
    }

def set_segmentation_types(handler: "SegmentationHandler", tissue_type: Optional[str] = None, nuclei_type: Optional[str] = None, patch_type: Optional[str] = None) -> Dict:
    """Set segmentation types"""
    if tissue_type:
        handler.set_tissue_segmentation_prefix(tissue_type)
        return {
            "message": f"Successfully set tissue type to {tissue_type}",
            "tissue_type": tissue_type
        }
    
    elif nuclei_type:
        handler.set_nuclei_segmentation_prefix(nuclei_type)
        return {
            "message": f"Successfully set nuclei type to {nuclei_type}",
            "nuclei_type": nuclei_type
        }
    
    elif patch_type:
        handler.set_patch_classification_prefix(patch_type)
        return {
            "message": f"Successfully set patch type to {patch_type}",
            "patch_type": patch_type
        }
    
    else:
        raise ValueError("Missing type parameter. Either 'tissue' or 'nuclei' or 'patch' must be provided")

def get_classifications(handler: "SegmentationHandler") -> Dict:
    """Get cell classification data"""
    data = handler.get_cell_classification_data()
    if data is None:
        raise ValueError("No classification data in zarr")
    return data

def get_annotation_colors(handler: "SegmentationHandler") -> Dict:
    """Get annotation colors from handler"""
    return handler.get_annotation_colors()

def update_class_color_service(handler: "SegmentationHandler", class_name: str, new_color: str, file_path: str):
    """Service function to update a class color in ClassificationNode."""
    handler.ensure_file(file_path, need_centroids=True)
    handler.update_class_color_in_zarr(class_name, new_color)
    return {"message": f"Successfully updated color for class '{class_name}' to '{new_color}'."}

def update_patch_class_color_service(handler: "SegmentationHandler", class_name: str, new_color: str, file_path: str):
    """Service function to update a patch classification class color in MuskNode."""
    handler.ensure_file(file_path, need_centroids=True)
    handler.update_patch_class_color_in_zarr(class_name, new_color)
    return {"message": f"Successfully updated patch classification color for class '{class_name}' to '{new_color}'."}


def _write_annotation_rows(array, buffer, row_ids) -> None:
    """Persist only the rows of ``buffer`` that changed.

    A region or review-panel mark touches a few thousand cells out of millions,
    and cell ids follow the segmentation's region-visit order, so those rows sit
    in one or two chunks. Writing the whole array back re-compresses every chunk
    of an 800 MB store to persist a few thousand rows.

    Rows spread over most of the array fall back to the single bulk write, where
    going chunk by chunk only adds overhead.
    """
    n_rows = int(array.shape[0])
    chunk = int(array.chunks[0]) if getattr(array, "chunks", None) else 0
    ids = np.asarray(row_ids, dtype=np.int64)
    if chunk <= 0 or ids.size == 0:
        array[:] = buffer
        return
    touched = np.unique(ids // chunk)
    total = max(1, -(-n_rows // chunk))
    if touched.size * 4 > total * 3:
        array[:] = buffer
        return
    for c in touched:
        start = int(c) * chunk
        array[start:min(start + chunk, n_rows)] = buffer[start:min(start + chunk, n_rows)]


def clear_nuclei_annotations_in_region(
    handler: "SegmentationHandler",
    file_path: str,
    x1: float, y1: float, x2: float, y2: float,
    polygon_points: Optional[List[List[float]]] = None
) -> Dict:
    """Clear all nuclei annotations within the specified region.
    
    Args:
        handler: SegmentationHandler instance
        file_path: Path to the zarr file
        x1, y1, x2, y2: Bounding box in the same image coordinate system as handler centroids (frontend/OSD)
        polygon_points: Optional polygon vertices for more precise selection
        
    Returns:
        Dict with cleared_count and success status
    """
    import zarr
    
    # Ensure file is loaded
    if handler:
        handler.ensure_file(file_path, need_centroids=True)

    cleared_count = 0
    cleared_classes = {}  # Track how many of each class were cleared
    
    try:
        with open_zarr_cm(file_path, mode='a') as zf:
            if 'User-Annotations' not in zf or 'cell' not in zf['User-Annotations']:
                return {"cleared_count": 0, "message": "No nuclei annotations found"}

            array = zf['User-Annotations/cell']

            # Check if this is a structured array
            if not (hasattr(array.dtype, 'names') and array.dtype.names is not None):
                return {"cleared_count": 0, "message": "Invalid annotation format"}

            # Read the full array
            full_array = array[:]

            # Get class names for tracking (cell palette).
            user_anno_group = zf['User-Annotations']
            class_names, _ = read_user_anno_class_palette(user_anno_group, 'cell')

            # Helper function to check if point is inside polygon
            def is_point_in_polygon(px, py, polygon):
                if not polygon or len(polygon) < 3:
                    return True  # No polygon, use bbox only
                inside = False
                n = len(polygon)
                j = n - 1
                for i in range(n):
                    xi, yi = polygon[i][0], polygon[i][1]
                    xj, yj = polygon[j][0], polygon[j][1]
                    if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi):
                        inside = not inside
                    j = i
                return inside
            
            # Find and clear annotations in region
            # Need to get centroid coordinates - they should be in the handler
            centroids = None
            if handler and handler.centroids is not None:
                centroids = handler.centroids
            else:
                # Try to load centroids from zarr file directly
                # Look for SegmentationNode centroids
                for key in zf.keys():
                    if 'Cell-Segmentation' in key or 'segmentation' in key.lower():
                        seg_group = zf[key]
                        if 'centroids' in seg_group:
                            centroids = seg_group['centroids'][:]
                            break
            
            if centroids is None:
                print(f"[clear_nuclei_annotations] ERROR: No centroids available!")
                return {"cleared_count": 0, "message": "Cannot find cell centroids"}
            
            # Input bbox (x1, y1, x2, y2), polygon_points, and handler centroids use the same image coordinate space.
            
            # Narrow to "annotated AND inside the bbox" with numpy before touching
            # Python. Applying these two scalar tests one cell at a time cost 7 s
            # on a 2M-cell slide — and a second full scan, which existed only to
            # produce a debug log line, was part of it.
            cleared_cell_ids = []  # Track which cells were cleared for handler update
            candidate_ids = np.empty(0, dtype=np.int64)
            if 'class' in array.dtype.names:
                n_cells = min(len(full_array), len(centroids))
                cls = np.asarray(full_array['class'][:n_cells])
                cxs = np.asarray(centroids[:n_cells, 0])
                cys = np.asarray(centroids[:n_cells, 1])
                candidate_ids = np.flatnonzero(
                    (cls >= 0) & (cxs >= x1) & (cxs <= x2) & (cys >= y1) & (cys <= y2)
                )
            has_annotator = 'annotator' in array.dtype.names
            has_method = 'method' in array.dtype.names
            for cell_id in candidate_ids.tolist():
                cx, cy = centroids[cell_id]

                # Check polygon if provided
                if polygon_points and not is_point_in_polygon(cx, cy, polygon_points):
                    continue

                # Get old class name for tracking
                old_class_index = int(full_array['class'][cell_id])
                old_class_name = class_names[old_class_index] if 0 <= old_class_index < len(class_names) else 'Unknown'

                # Clear the annotation
                full_array['class'][cell_id] = -1
                full_array['color'][cell_id] = -1

                # Clear other fields if they exist
                if has_annotator:
                    full_array['annotator'][cell_id] = ''
                if has_method:
                    full_array['method'][cell_id] = ''

                cleared_count += 1
                cleared_cell_ids.append(cell_id)
                cleared_classes[old_class_name] = cleared_classes.get(old_class_name, 0) + 1

            if cleared_count > 0:
                # Write back to zarr — only the chunks the cleared cells live in.
                _write_annotation_rows(array, full_array, cleared_cell_ids)
                # Drop selection-geometry entries for cleared annotations.
                try:
                    from app.services.tasks import prune_orphan_selection_geometry
                    prune_orphan_selection_geometry(user_anno_group, 'cell')
                except Exception as e:
                    try:
                        logger.error(f"orphan selection-geometry prune failed: {e}", exc_info=True)
                    except Exception:
                        pass
                
                # IMPORTANT: Also update handler's in-memory class_id cache
                # This ensures WebSocket returns updated colors immediately
                if handler and hasattr(handler, 'class_id') and handler.class_id is not None:
                    for cell_id in cleared_cell_ids:
                        if cell_id < len(handler.class_id):
                            handler.class_id[cell_id] = -1

                    # CRITICAL: Clear viewport cache to ensure fresh data is returned
                    # Without this, cached annotation data with old class_ids would be returned
                    if hasattr(handler, '_viewport_cache'):
                        handler._viewport_cache.clear()

                # Update class_counts
                if 'cell_class_counts' in user_anno_group:
                    try:
                        counts_raw = user_anno_group['cell_class_counts'][()]
                        if isinstance(counts_raw, bytes):
                            counts_dict = json.loads(counts_raw.decode('utf-8'))
                        elif isinstance(counts_raw, str):
                            counts_dict = json.loads(counts_raw)
                        else:
                            counts_dict = {}

                        # Decrement counts for cleared classes
                        for class_name, count in cleared_classes.items():
                            if class_name in counts_dict:
                                counts_dict[class_name] = max(0, counts_dict[class_name] - count)
                                if counts_dict[class_name] == 0:
                                    del counts_dict[class_name]

                        # Save updated counts
                        counts_bytes = json.dumps(counts_dict, ensure_ascii=False).encode('utf-8')
                        existing_ds = user_anno_group['cell_class_counts']
                        if existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                            existing_ds[()] = counts_bytes
                        else:
                            del user_anno_group['cell_class_counts']
                            create_array(user_anno_group, 'cell_class_counts', data=np.array(counts_bytes, dtype=f"S{max(1, len(counts_bytes))}"), overwrite=True)
                    except Exception as e:
                        print(f"[clear_nuclei_annotations] Warning: Failed to update class_counts: {e}")

        return {"cleared_count": cleared_count, "cleared_classes": cleared_classes}
    
    except Exception as e:
        print(f"[clear_nuclei_annotations] Error: {e}")
        traceback.print_exc()
        raise ValueError(f"Failed to clear nuclei annotations: {str(e)}")


def mark_nuclei_as_ground_truth_in_region(
    handler: "SegmentationHandler",
    file_path: str,
    x1: float, y1: float, x2: float, y2: float,
    polygon_points: Optional[List[List[float]]] = None,
    cell_indices: Optional[List[int]] = None,
    cell_classes: Optional[Dict[Any, str]] = None,
    annotator: str = "Unknown",
) -> Dict:
    """Mark nuclei annotations in the specified region as ground truth (user annotations).

    Cells are saved into User-Annotations/cell. By default a cell is
    recorded with its AI prediction (from ClassificationNode) — i.e. the AI
    prediction is "promoted" to a ground truth annotation. A cell listed in
    cell_classes is instead recorded with that explicit class, which lets the
    review panel save both "Yes" (confirm prediction) and "No" (corrected class)
    through this single endpoint.

    When cell_indices is provided, only those cell ids are considered (bbox/polygon check skipped).

    Args:
        handler: SegmentationHandler instance
        file_path: Path to the zarr file
        x1, y1, x2, y2: Bounding box in the same image coordinate system as handler centroids (frontend/OSD)
        polygon_points: Optional polygon vertices for more precise selection
        cell_indices: Optional list of cell ids to mark; when set, only these ids are considered
        cell_classes: Optional {cell_id: class_name} map; a listed cell is recorded
            with that class instead of its AI prediction (cell ids may be int or str)

    Returns:
        Dict with marked_count and success status
    """
    import zarr
    
    # Ensure file is loaded
    if handler:
        handler.ensure_file(file_path, need_centroids=True)

    if handler.class_id is None or handler.class_name is None:
        return {"marked_count": 0, "message": "No AI predictions found (ClassificationNode not loaded)"}
    
    marked_count = 0
    marked_classes = {}  # Track how many of each class were marked
    unmarked_classes = {}  # Old classes vacated when an override re-labels a cell

    try:
        with open_zarr_cm(file_path, mode='a') as zf:
            # Ensure user_annotation group exists
            if 'User-Annotations' not in zf:
                zf.create_group('User-Annotations')

            user_anno_group = zf['User-Annotations']

            # Get or create nuclei_annotations array
            from app.services.tasks import _get_annotation_dtype
            annotation_dtype = _get_annotation_dtype()
            
            centroids_len = len(handler.centroids) if handler.centroids is not None else 0
            if centroids_len == 0:
                return {"marked_count": 0, "message": "No centroids found"}
            
            # Create or get existing annotations array
            if 'cell' not in user_anno_group:
                # Create new array
                optimal_chunk_size = max(1000, min(centroids_len, (8 * 1024 * 1024) // annotation_dtype.itemsize))
                annotations_array = create_array(
                    user_anno_group,
                    'cell',
                    shape=(centroids_len,),
                    dtype=annotation_dtype,
                    chunks=(optimal_chunk_size,),
                    compressor=_zc.lz4(),
                    fill_value=None,
                )
                annotations_array.attrs['annotation_format'] = 'structured'
                # Initialize with -1 (unclassified)
                full_array = np.zeros(centroids_len, dtype=annotation_dtype)
                for field in ['class', 'color']:
                    full_array[field] = -1
                annotations_array[:] = full_array
            else:
                annotations_array = user_anno_group['cell']
                full_array = annotations_array[:]
            
            # Get class names + colors. Handler-resident values (decoded from
            # the live ClassificationNode) win; otherwise fall back to the
            # persisted cell palette on User-Annotations attrs.
            class_names = []
            class_colors = []
            if handler.class_name is not None:
                class_names = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in handler.class_name]
            if handler.class_hex_color is not None:
                class_colors = [color.decode('utf-8') if isinstance(color, bytes) else str(color) for color in handler.class_hex_color]
            if not class_names or not class_colors:
                anno_names, anno_colors = read_user_anno_class_palette(user_anno_group, 'cell')
                if not class_names:
                    class_names = anno_names
                if not class_colors:
                    class_colors = anno_colors

            if not class_names:
                return {"marked_count": 0, "message": "No class names found"}
            
            # Helper function to check if point is inside polygon
            def is_point_in_polygon(px, py, polygon):
                if not polygon or len(polygon) < 3:
                    return True  # No polygon, use bbox only
                inside = False
                n = len(polygon)
                j = n - 1
                for i in range(n):
                    xi, yi = polygon[i][0], polygon[i][1]
                    xj, yj = polygon[j][0], polygon[j][1]
                    if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi):
                        inside = not inside
                    j = i
                return inside
            
            # Helper function to convert hex color to RGB integer
            def hex_to_rgb_int(hex_color):
                if not hex_color or hex_color == '' or hex_color == '-1':
                    return -1
                try:
                    # Remove # if present
                    hex_color = hex_color.lstrip('#')
                    if len(hex_color) == 6:
                        return int(hex_color, 16)
                    return -1
                except:
                    return -1
            
            # Find cells in region that have AI predictions but are not yet user annotations
            centroids = handler.centroids
            n_cells = min(len(full_array), len(centroids), len(handler.class_id))
            
            if cell_indices is not None:
                candidate_ids = [c for c in cell_indices if 0 <= c < n_cells]
            else:
                # Region mark: apply the bbox in numpy instead of walking every
                # cell on the slide in Python (2.6 s to select 5k cells out of
                # 2M). The per-cell loop below still runs, over the survivors, so
                # the polygon test and the class rules are untouched.
                cxs = np.asarray(centroids[:n_cells, 0])
                cys = np.asarray(centroids[:n_cells, 1])
                candidate_ids = np.flatnonzero(
                    (cxs >= x1) & (cxs <= x2) & (cys >= y1) & (cys <= y2)
                ).tolist()
            
            # Normalize per-cell class overrides (JSON object keys arrive as strings)
            class_overrides = {}
            if cell_classes:
                for k, v in cell_classes.items():
                    if v:
                        class_overrides[str(k)] = str(v)

            marked_cell_ids = []
            # All cells of one save share a datetime. Region marks also store the
            # region's shape as selection geometry (collected here, written to the
            # group attr after the array write-back); review/active-learning marks
            # (cell_indices) deliberately store none — see below.
            mark_ts0 = int(datetime.now().timestamp() * 1000)
            geom_entries = {}
            # Treat a GT mark like a normal annotation: real annotator + a
            # selection-style method (region → rectangle/polygon), instead of the
            # old 'ground_truth'/'mark_as_ground_truth'. Review-panel saves are
            # tagged 'active learning' so they read as what they are.
            mark_annotator = annotator or "Unknown"
            mark_method = ('active learning' if cell_indices is not None
                           else ('polygon selection' if polygon_points else 'rectangle selection'))
            # Built per *class*, not per marked cell: the review panel marks
            # thousands at a time, and `name not in class_names` + `.index(name)`
            # is two O(classes) scans on every one of them.
            class_id_of = {name: i for i, name in enumerate(class_names)}
            FALLBACK_COLOR_INT = hex_to_rgb_int('#808080')
            for cell_id in candidate_ids:
                override_name = class_overrides.get(str(cell_id))

                # Resolve the class to record: explicit override (review "No"),
                # else the cell's AI prediction (review "Yes" / box-select).
                if override_name is not None:
                    target_class_id = class_id_of.get(override_name, -1)
                    if target_class_id < 0:
                        print(f"[mark_nuclei_as_ground_truth] Unknown class '{override_name}' for cell {cell_id}, skipping")
                        continue
                else:
                    ai_class_id = handler.class_id[cell_id]
                    if ai_class_id < 0:
                        continue  # No AI prediction and no explicit class
                    target_class_id = int(ai_class_id)

                # Already a user annotation: skip prediction-based marks, but let
                # an explicit override re-label it.
                prev_class_id = int(full_array['class'][cell_id])
                if prev_class_id >= 0 and override_name is None:
                    continue  # Already a user annotation, skip

                # When not using cell_indices, filter by region
                if cell_indices is None:
                    cx, cy = centroids[cell_id]
                    if not (x1 <= cx <= x2 and y1 <= cy <= y2):
                        continue
                    if polygon_points and not is_point_in_polygon(cx, cy, polygon_points):
                        continue

                # If an override re-labels an already-annotated cell, the old
                # class count must be decremented to stay consistent.
                if prev_class_id >= 0 and 0 <= prev_class_id < len(class_names):
                    prev_name = class_names[prev_class_id]
                    unmarked_classes[prev_name] = unmarked_classes.get(prev_name, 0) + 1

                # Record as a ground-truth user annotation
                class_name = class_names[target_class_id] if 0 <= target_class_id < len(class_names) else 'Unknown'
                class_color_hex = class_colors[target_class_id] if 0 <= target_class_id < len(class_colors) else '#808080'
                class_color_int = hex_to_rgb_int(class_color_hex)
                if class_color_int < 0:
                    # A palette entry can be empty or malformed, and hex_to_rgb_int
                    # answers -1 for those. -1 in the colour column is the sentinel
                    # for "this row is not a real annotation" (see
                    # _apply_manual_nuclei_annotations), so writing it next to a real
                    # class produces a row the panel counts but the overlay and the
                    # classifier both ignore. Fall back the same way a bad index does.
                    class_color_int = FALLBACK_COLOR_INT

                # Update the annotation array
                full_array['class'][cell_id] = target_class_id
                full_array['color'][cell_id] = class_color_int
                
                # Set metadata fields
                if 'annotator' in full_array.dtype.names:
                    full_array['annotator'][cell_id] = mark_annotator
                cell_ts = mark_ts0
                if 'datetime' in full_array.dtype.names:
                    full_array['datetime'][cell_id] = cell_ts
                if 'method' in full_array.dtype.names:
                    full_array['method'][cell_id] = mark_method
                # No selection geometry for review/active-learning marks. The
                # geometry attr is what `_collect_user_annotation_save_events`
                # enumerates, so writing one per cell turned every review "Yes"
                # into its own hand-drawn-looking annotation in the sidebar and
                # in the CSV/GeoJSON export. The label itself still lives in
                # User-Annotations/cell, which is what active learning reads.

                marked_count += 1
                marked_cell_ids.append(cell_id)
                marked_classes[class_name] = marked_classes.get(class_name, 0) + 1

            if marked_count > 0:
                # Write back to zarr — only the chunks the marked cells live in.
                _write_annotation_rows(annotations_array, full_array, marked_cell_ids)

                # Region mark → store the GT selection shape once (polygon, or
                # rectangle corners from the bbox), shared by all marked cells
                # via mark_ts0.
                if cell_indices is None:
                    verts = None
                    if polygon_points and len(polygon_points) >= 3:
                        verts = [[float(p[0]), float(p[1])] for p in polygon_points]
                    elif x2 > x1 and y2 > y1:
                        verts = [[float(x1), float(y1)], [float(x2), float(y1)],
                                 [float(x2), float(y2)], [float(x1), float(y2)]]
                    if verts:
                        geom_entries[str(mark_ts0)] = {
                            'method': mark_method,
                            'annotator': mark_annotator,
                            'vertices': verts,
                        }
                # Persist collected geometry onto the User-Annotations group attr
                # (same place save_annotation writes cell_selection_geometry).
                if geom_entries:
                    try:
                        existing = dict(user_anno_group.attrs.get('cell_selection_geometry', {}) or {})
                        existing.update(geom_entries)
                        user_anno_group.attrs['cell_selection_geometry'] = existing
                    except Exception as _ge:
                        print(f"[mark_nuclei_as_ground_truth] geometry store failed: {_ge}")
                
                # Pin cell palette under v3 keys (with v1 mirror) so downstream
                # _apply_manual_nuclei_annotations / supervised classification
                # can read them via the standard helper.
                if class_names or class_colors:
                    write_user_anno_class_palette(user_anno_group, 'cell', class_names, class_colors)
                
                # Update handler's in-memory class_id cache (no change needed, already correct)
                # But clear viewport cache to ensure fresh data
                if hasattr(handler, '_viewport_cache'):
                    handler._viewport_cache.clear()
                # Invalidate nuclei counts caches so API/UI get fresh counts after ground truth update
                if hasattr(handler, 'invalidate_user_counts_cache') and callable(handler.invalidate_user_counts_cache):
                    handler.invalidate_user_counts_cache()
                else:
                    if hasattr(handler, '_user_annotation_counts_cache'):
                        handler._user_annotation_counts_cache = None
                    if hasattr(handler, '_global_label_counts_cache'):
                        handler._global_label_counts_cache = None

                # Update class_counts
                try:
                    if 'cell_class_counts' in user_anno_group:
                        counts_raw = user_anno_group['cell_class_counts'][()]
                        if isinstance(counts_raw, bytes):
                            counts_dict = json.loads(counts_raw.decode('utf-8'))
                        elif isinstance(counts_raw, str):
                            counts_dict = json.loads(counts_raw)
                        else:
                            counts_dict = {}
                    else:
                        counts_dict = {}
                    
                    # Increment counts for marked classes
                    for class_name, count in marked_classes.items():
                        counts_dict[class_name] = counts_dict.get(class_name, 0) + count

                    # Decrement counts for classes vacated by an override re-label
                    for class_name, count in unmarked_classes.items():
                        counts_dict[class_name] = max(0, counts_dict.get(class_name, 0) - count)
                        if counts_dict[class_name] == 0:
                            del counts_dict[class_name]

                    # Save updated counts
                    counts_bytes = json.dumps(counts_dict, ensure_ascii=False).encode('utf-8')
                    if 'cell_class_counts' in user_anno_group:
                        existing_ds = user_anno_group['cell_class_counts']
                        if existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                            existing_ds[()] = counts_bytes
                        else:
                            del user_anno_group['cell_class_counts']
                            create_array(user_anno_group, 'cell_class_counts', data=np.array(counts_bytes, dtype=f"S{max(1, len(counts_bytes))}"), overwrite=True)
                    else:
                        create_array(user_anno_group, 'cell_class_counts', data=np.array(counts_bytes, dtype=f"S{max(1, len(counts_bytes))}"), overwrite=True)
                except Exception as e:
                    print(f"[mark_nuclei_as_ground_truth] Warning: Failed to update class_counts: {e}")

        return {"marked_count": marked_count, "marked_classes": marked_classes}
    
    except Exception as e:
        print(f"[mark_nuclei_as_ground_truth] Error: {e}")
        traceback.print_exc()
        raise ValueError(f"Failed to mark nuclei as ground truth: {str(e)}")


def clear_tissue_annotations_in_region(
    handler: "SegmentationHandler",
    file_path: str,
    x1: float, y1: float, x2: float, y2: float,
    polygon_points: Optional[List[List[float]]] = None
) -> Dict:
    """Clear all tissue annotations within the specified region.
    
    Args:
        handler: SegmentationHandler instance
        file_path: Path to the zarr file
        x1, y1, x2, y2: Bounding box in the same image coordinate system as handler patch_coordinates (frontend/OSD)
        polygon_points: Optional polygon vertices for more precise selection
        
    Returns:
        Dict with cleared_count and success status
    """
    import zarr
    
    # Ensure file is loaded
    if handler:
        handler.ensure_file(file_path, need_centroids=True)
    
    cleared_count = 0
    cleared_classes = {}

    try:
        from app.services.tasks import load_patch_annotations, save_patch_annotations

        annotations_dict = load_patch_annotations(file_path) or {}
        if not annotations_dict:
            return {"cleared_count": 0, "message": "No tissue annotations found"}

        def is_point_in_polygon(px, py, polygon):
            if not polygon or len(polygon) < 3:
                return True
            inside = False
            n = len(polygon)
            j = n - 1
            for i in range(n):
                xi, yi = polygon[i][0], polygon[i][1]
                xj, yj = polygon[j][0], polygon[j][1]
                if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi):
                    inside = not inside
                j = i
            return inside

        # patch_coordinates format is [x1, y1, x2, y2]; centroid is the midpoint.
        patch_centroids = {}
        if handler and handler.patch_coordinates is not None:
            for i, pc in enumerate(handler.patch_coordinates):
                if len(pc) == 4:
                    px1, py1, px2, py2 = pc
                    patch_centroids[i] = ((px1 + px2) / 2, (py1 + py2) / 2)

        patches_to_clear = []
        for patch_id, ann in list(annotations_dict.items()):
            if not isinstance(ann, dict):
                continue
            try:
                pid_int = int(patch_id)
            except (TypeError, ValueError):
                continue
            if pid_int not in patch_centroids:
                continue
            px, py = patch_centroids[pid_int]
            if not (x1 <= px <= x2 and y1 <= py <= y2):
                continue
            if polygon_points and not is_point_in_polygon(px, py, polygon_points):
                continue
            patches_to_clear.append(pid_int)
            old_class = ann.get('class', 'Unknown')
            cleared_classes[old_class] = cleared_classes.get(old_class, 0) + 1

        for pid in patches_to_clear:
            annotations_dict.pop(pid, None)
            cleared_count += 1

        if cleared_count > 0:
            n_patches = len(handler.patch_coordinates) if handler and handler.patch_coordinates is not None else None
            save_patch_annotations(file_path, annotations_dict, n_patches=n_patches)
            # Drop selection-geometry orphaned by the cleared patches.
            try:
                from app.services.tasks import prune_orphan_selection_geometry
                with open_zarr_cm(file_path, 'a') as _zf:
                    if 'User-Annotations' in _zf:
                        prune_orphan_selection_geometry(_zf['User-Annotations'], 'patch')
            except Exception as e:
                try:
                    logger.error(f"orphan selection-geometry prune failed: {e}", exc_info=True)
                except Exception:
                    pass

            if handler:
                for pid in patches_to_clear:
                    if hasattr(handler, 'tissue_annotations') and handler.tissue_annotations:
                        handler.tissue_annotations.pop(pid, None)
                    if hasattr(handler, 'patch_class_id') and handler.patch_class_id is not None and pid < len(handler.patch_class_id):
                        handler.patch_class_id[pid] = -1
                if hasattr(handler, '_viewport_cache'):
                    try:
                        handler._viewport_cache.clear()
                    except Exception:
                        pass

        return {"cleared_count": cleared_count, "cleared_classes": cleared_classes}

    except Exception as e:
        print(f"[clear_tissue_annotations] Error: {e}")
        traceback.print_exc()
        raise ValueError(f"Failed to clear tissue annotations: {str(e)}")


def mark_patches_as_ground_truth(
    handler: "SegmentationHandler",
    file_path: str,
    patch_indices: List[int],
    patch_classes: Optional[Dict] = None,
    annotator: str = "Unknown",
) -> Dict:
    """Mark specific patches as ground-truth user annotations (patch review save).

    Per-patch counterpart of mark_patches_as_ground_truth_in_region (which is
    region-only). For each patch in patch_indices the recorded class is the
    explicit override in patch_classes (review "No"), else the patch's AI
    prediction (review "Yes"). Writes User-Annotations/patch (JSON).
    """
    import zarr

    if not patch_indices:
        return {"success": True, "marked_count": 0, "message": "No patches to mark"}

    # Ensure the slide is loaded
    if handler:
        handler.ensure_file(file_path, need_patches=True)
    if not hasattr(handler, 'patch_class_id') or handler.patch_class_id is None:
        return {"success": False, "marked_count": 0, "message": "No patch classification loaded"}

    # Per-patch class overrides (review "No"); JSON keys arrive as strings
    overrides = {}
    if patch_classes:
        for k, v in patch_classes.items():
            if v:
                overrides[str(k)] = str(v)

    marked_count = 0

    try:
        from app.services.tasks import load_patch_annotations, save_patch_annotations
        class_names = []
        if getattr(handler, 'patch_class_name', None) is not None:
            class_names = [n.decode('utf-8') if isinstance(n, bytes) else str(n)
                           for n in handler.patch_class_name]
        if not class_names:
            return {"success": False, "marked_count": 0, "message": "No patch class names found"}

        class_colors = []
        if getattr(handler, 'patch_class_hex_color', None) is not None:
            class_colors = [c.decode('utf-8') if isinstance(c, bytes) else str(c)
                            for c in handler.patch_class_hex_color]

        annotations_dict = load_patch_annotations(file_path) or {}
        n_patches = len(handler.patch_class_id)
        now_ms = int(datetime.now().timestamp() * 1000)
        marked_ids = []
        for raw_pid in patch_indices:
            try:
                patch_id = int(raw_pid)
            except (ValueError, TypeError):
                continue
            if patch_id < 0 or patch_id >= n_patches:
                continue
            override_name = overrides.get(str(patch_id))
            if override_name is not None:
                if override_name not in class_names:
                    print(f"[mark_patches_as_ground_truth] Unknown class '{override_name}' for patch {patch_id}, skipping")
                    continue
                class_name = override_name
            else:
                ai_class_id = int(handler.patch_class_id[patch_id])
                if ai_class_id < 0:
                    continue
                class_name = class_names[ai_class_id] if 0 <= ai_class_id < len(class_names) else 'Unknown'

            prev = annotations_dict.get(patch_id)
            if isinstance(prev, dict) and prev.get('class') == class_name:
                continue

            cls_idx = class_names.index(class_name)
            color_hex = class_colors[cls_idx] if cls_idx < len(class_colors) else ''
            # All patches of one review save share a datetime, and none of them
            # gets selection geometry. The geometry attr is what
            # `_collect_user_annotation_save_events` enumerates, so writing one
            # bbox per patch turned every review "Yes" into its own
            # hand-drawn-looking annotation in the sidebar and in the
            # CSV/GeoJSON export. The label itself still lives in
            # User-Annotations/patch, which is what active learning reads.
            annotations_dict[patch_id] = {
                'patch_ID': patch_id,
                'class': class_name,
                'color': color_hex,
                'annotator': annotator or 'Unknown',
                'datetime': now_ms,
                'method': 'active learning',
            }
            marked_ids.append(patch_id)
            marked_count += 1

        if marked_count > 0:
            save_patch_annotations(file_path, annotations_dict, n_patches=n_patches, class_names=class_names)
            # Refresh the handler cache so subsequent reads see the new state.
            if handler is not None:
                if not hasattr(handler, 'tissue_annotations') or handler.tissue_annotations is None:
                    handler.tissue_annotations = {}
                for pid in marked_ids:
                    handler.tissue_annotations[pid] = annotations_dict[pid]
                if hasattr(handler, '_viewport_cache'):
                    try:
                        handler._viewport_cache.clear()
                    except Exception:
                        pass

        return {"success": True, "marked_count": marked_count}
    except Exception as e:
        print(f"[mark_patches_as_ground_truth] Error: {e}")
        traceback.print_exc()
        return {"success": False, "marked_count": 0, "message": str(e)}


def remove_patch_annotations(
    handler: "SegmentationHandler",
    file_path: str,
    patch_indices: List[int],
) -> Dict:
    """Remove patches' user annotations from User-Annotations/patch.

    Each listed patch's row is reset to class=-1 (unclassified) in the dense
    structured array.
    """
    if not patch_indices:
        return {"success": True, "removed_count": 0, "message": "No patches to remove"}

    try:
        from app.services.tasks import load_patch_annotations, save_patch_annotations

        annotations_dict = load_patch_annotations(file_path) or {}
        if not annotations_dict:
            return {"success": True, "removed_count": 0, "message": "No tissue annotations"}

        removed_ids = []
        for raw_pid in patch_indices:
            try:
                pid = int(raw_pid)
            except (ValueError, TypeError):
                continue
            if annotations_dict.pop(pid, None) is not None:
                removed_ids.append(pid)

        if removed_ids:
            n_patches = len(handler.patch_coordinates) if handler and handler.patch_coordinates is not None else None
            save_patch_annotations(file_path, annotations_dict, n_patches=n_patches)
            # Drop selection-geometry orphaned by the removed patches.
            try:
                import zarr as _zarr
                from app.services.tasks import prune_orphan_selection_geometry
                with open_zarr_cm(file_path, 'a') as _zf:
                    if 'User-Annotations' in _zf:
                        prune_orphan_selection_geometry(_zf['User-Annotations'], 'patch')
            except Exception as e:
                try:
                    logger.error(f"orphan selection-geometry prune failed: {e}", exc_info=True)
                except Exception:
                    pass
            if handler is not None and getattr(handler, 'tissue_annotations', None):
                for pid in removed_ids:
                    handler.tissue_annotations.pop(pid, None)
                if hasattr(handler, '_viewport_cache'):
                    try:
                        handler._viewport_cache.clear()
                    except Exception:
                        pass

        return {"success": True, "removed_count": len(removed_ids)}
    except Exception as e:
        print(f"[remove_patch_annotations] Error: {e}")
        traceback.print_exc()
        return {"success": False, "removed_count": 0, "message": str(e)}


def mark_patches_as_ground_truth_in_region(
    handler: "SegmentationHandler",
    file_path: str,
    x1: float, y1: float, x2: float, y2: float,
    polygon_points: Optional[List[List[float]]] = None,
    annotator: str = "Unknown",
) -> Dict:
    """Mark AI-predicted tissue annotations in the specified region as ground truth (user annotations).
    
    This function finds patches in the region that have AI predictions (from patch classification model)
    but are NOT yet in User-Annotations/patch, and saves them as user annotations.
    This effectively "promotes" AI predictions to ground truth annotations.
    
    Args:
        handler: SegmentationHandler instance
        file_path: Path to the zarr file
        x1, y1, x2, y2: Bounding box in the same image coordinate system as handler patch_coordinates (frontend/OSD)
        polygon_points: Optional polygon vertices for more precise selection
        
    Returns:
        Dict with marked_count and success status
    """
    import zarr

    if handler:
        handler.ensure_file(file_path, need_patches=True)

    if handler.patch_coordinates is None:
        return {"marked_count": 0, "message": "No patch coordinates found"}
    if not hasattr(handler, 'patch_class_id') or handler.patch_class_id is None:
        return {"marked_count": 0, "message": "No AI predictions found (patch classification not loaded)"}

    marked_count = 0
    marked_classes = {}

    try:
        from app.services.tasks import load_patch_annotations, save_patch_annotations

        class_names = []
        if getattr(handler, 'patch_class_name', None) is not None:
            class_names = [n.decode('utf-8') if isinstance(n, bytes) else str(n)
                           for n in handler.patch_class_name]
        if not class_names:
            return {"marked_count": 0, "message": "No patch class names found"}

        class_colors = []
        if getattr(handler, 'patch_class_hex_color', None) is not None:
            class_colors = [c.decode('utf-8') if isinstance(c, bytes) else str(c)
                            for c in handler.patch_class_hex_color]

        annotations_dict = load_patch_annotations(file_path) or {}

        def is_point_in_polygon(px, py, polygon):
            if not polygon or len(polygon) < 3:
                return True
            inside = False
            n = len(polygon)
            j = n - 1
            for i in range(n):
                xi, yi = polygon[i][0], polygon[i][1]
                xj, yj = polygon[j][0], polygon[j][1]
                if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi):
                    inside = not inside
                j = i
            return inside

        patch_coords = handler.patch_coordinates
        n_patches = min(len(patch_coords), len(handler.patch_class_id))

        # Patch centres and the bbox test in numpy, the same way the cell mark
        # path does it — building a centroid dict for every patch on the slide
        # and then re-walking them all in Python cost two full scans per mark.
        # Ragged / non-(N,4) stores fall back to the per-patch walk.
        coords_arr = np.asarray(patch_coords[:n_patches])
        centres = None
        if coords_arr.ndim == 2 and coords_arr.shape[1] == 4:
            pcx = (coords_arr[:, 0] + coords_arr[:, 2]) / 2.0
            pcy = (coords_arr[:, 1] + coords_arr[:, 3]) / 2.0
            cls_arr = np.asarray(handler.patch_class_id[:n_patches])
            candidate_patches = np.flatnonzero(
                (cls_arr >= 0) & (pcx >= x1) & (pcx <= x2) & (pcy >= y1) & (pcy <= y2)
            ).tolist()
            centres = (pcx, pcy)
        else:
            candidate_patches = [
                i for i in range(n_patches)
                if len(patch_coords[i]) == 4 and int(handler.patch_class_id[i]) >= 0
            ]

        now_ms = int(datetime.now().timestamp() * 1000)
        patches_to_mark = []
        for patch_id in candidate_patches:
            ai_class_id = int(handler.patch_class_id[patch_id])
            if patch_id in annotations_dict:
                continue
            if centres is not None:
                px, py = float(centres[0][patch_id]), float(centres[1][patch_id])
            else:
                px1, py1, px2, py2 = patch_coords[patch_id]
                px, py = (px1 + px2) / 2, (py1 + py2) / 2
                if not (x1 <= px <= x2 and y1 <= py <= y2):
                    continue
            if polygon_points and not is_point_in_polygon(px, py, polygon_points):
                continue
            class_name = class_names[ai_class_id] if 0 <= ai_class_id < len(class_names) else 'Unknown'
            color_hex = class_colors[ai_class_id] if 0 <= ai_class_id < len(class_colors) else ''
            annotations_dict[patch_id] = {
                'patch_ID': int(patch_id),
                'class': class_name,
                'color': color_hex,
                'annotator': annotator or 'Unknown',
                'datetime': now_ms,
                'method': ('polygon selection' if polygon_points else 'rectangle selection'),
            }
            patches_to_mark.append(patch_id)
            marked_count += 1
            marked_classes[class_name] = marked_classes.get(class_name, 0) + 1

        if marked_count > 0:
            save_patch_annotations(file_path, annotations_dict, n_patches=len(patch_coords), class_names=class_names)
            # Store the GT region shape (polygon or rectangle corners) once,
            # shared by all marked patches via now_ms.
            verts = None
            if polygon_points and len(polygon_points) >= 3:
                verts = [[float(p[0]), float(p[1])] for p in polygon_points]
            elif x2 > x1 and y2 > y1:
                verts = [[float(x1), float(y1)], [float(x2), float(y1)],
                         [float(x2), float(y2)], [float(x1), float(y2)]]
            if verts:
                try:
                    import zarr as _zarr
                    with open_zarr_cm(file_path, 'a') as _zf:
                        if 'User-Annotations' in _zf:
                            _ua = _zf['User-Annotations']
                            _ex = dict(_ua.attrs.get('patch_selection_geometry', {}) or {})
                            _ex[str(now_ms)] = {
                                'method': ('polygon selection' if polygon_points else 'rectangle selection'),
                                'annotator': annotator or 'Unknown',
                                'vertices': verts,
                            }
                            _ua.attrs['patch_selection_geometry'] = _ex
                except Exception as _ge:
                    print(f"[mark_patches_as_ground_truth_in_region] geometry store failed: {_ge}")
            if handler:
                if not getattr(handler, 'tissue_annotations', None):
                    handler.tissue_annotations = {}
                for pid in patches_to_mark:
                    handler.tissue_annotations[pid] = annotations_dict[pid]
                if hasattr(handler, '_viewport_cache'):
                    try:
                        handler._viewport_cache.clear()
                    except Exception:
                        pass

        return {"marked_count": marked_count, "marked_classes": marked_classes}

    except Exception as e:
        print(f"[mark_patches_as_ground_truth_in_region] Error: {e}")
        traceback.print_exc()
        raise ValueError(f"Failed to mark tissue as ground truth: {str(e)}")


# Contours are held in RAM up to this much per handler; bigger stays lazy.
CONTOURS_RAM_BUDGET_BYTES = 256 * 1024 * 1024

# Working-set budget when a deleted class's column is shifted out of
# Cell-Classification/probabilities (see _delete_class_from_cell_classification).
PROB_REINDEX_BLOCK_BYTES = 32 * 1024 * 1024



class SegmentationHandler:
    BUFFER = 200

    def indices_in_viewport(self, x1, y1, x2, y2, buffer=None, centroids=None):
        """Indices of centroids inside the viewport rect, expanded by BUFFER.

        Replaces a KD-tree ball query around the viewport centre. That tree cost
        692 ms to build for 213k cells, was rebuilt on every slide open, and was
        never used for anything but this — no nearest-neighbour lookup anywhere.
        The mask below answers the same question in single-digit milliseconds.

        It also answers it more precisely. The ball used the rect's circumradius,
        so it returned everything in the circle *around* the viewport: 1.57x the
        cells for a square viewport, every one of them packed, compressed, sent
        and uploaded to the GPU before being discarded off-screen.
        """
        centroids = self.centroids if centroids is None else centroids
        if centroids is None or len(centroids) == 0:
            return np.empty(0, dtype=np.intp)
        margin = self.BUFFER if buffer is None else buffer
        xs = centroids[:, 0]
        ys = centroids[:, 1]
        mask = (
            (xs >= x1 - margin) & (xs <= x2 + margin) &
            (ys >= y1 - margin) & (ys <= y2 + margin)
        )
        return np.flatnonzero(mask)

    def __init__(self, zarr_file_path=None):
        self.zarr_file = None
        self._zarr_file_obj = None  # Keep Zarr file object open for reuse
        self.centroids = None
        self.contours = None
        self.tissues = None
        self.probabilities = None
        self.annotations_data = {}
        self.tissue_annotations = {}
        self.kd_tree = None
        self.class_id = None
        self.class_name = None
        self.class_hex_color = None
        self.patch_coordinates = None
        self.patch_centroids = None
        self.patch_class_id = None
        self.patch_class_name = None
        self.patch_class_hex_color = None
        self.patch_class_probabilities = None

        # Viewport result cache disabled: stale entries caused residual overlays
        # across classification updates and image switches.
        self._viewport_cache = OrderedDict()
        self._cache_max_size = 0

        # Removed unnecessary caches for Zarr files
        self.annotation_colors = {
            "class_id": [],
            "class_name": [],
            "class_hex_color": []
        }
        self.nuclei_model_timestamp = None
        self.patch_model_timestamp = None

        # prefix
        self._nuclei_segmentation_prefix = "Cell-Segmentation"
        self._tissue_segmentation_prefix = "BiomedParseNode"
        self._classification_prefix = 'Cell-Classification'
        self._patch_classification_prefix = 'Patch-Classification'
        self._patch_segmentation_prefix = 'Patch-Segmentation'

        # No debounce: rapid set_path / reload must always take effect.
        self._last_load_time = 0.0
        self._min_reload_interval = 0.0
        
        # Cache for user annotation counts (not arrays - arrays are read directly when needed)
        self._user_annotation_counts_cache = None

        # Reuse exporter thread pool to avoid per-request startup stutter.
        self._geojson_export_executor = None
        self._geojson_export_workers = min(12, max(2, ((os.cpu_count() or 8) // 2)))

        if zarr_file_path:
            try:
                self.load_file(zarr_file_path)
            except Exception as e:
                print(f"[ERROR] SegmentationHandler.__init__ - Failed to load file {zarr_file_path}: {e}")
                print(f"[ERROR] SegmentationHandler.__init__ - Exception type: {type(e).__name__}")
                print(f"[ERROR] SegmentationHandler.__init__ - Full traceback: {traceback.format_exc()}")
                # Don't raise the exception, just log it and continue with empty handler
                # This allows the handler to be created even if the file loading fails

    def _get_geojson_export_executor(self):
        """Get or create a reusable thread pool for GeoJSON export."""
        if self._geojson_export_executor is None:
            self._geojson_export_executor = ThreadPoolExecutor(max_workers=self._geojson_export_workers)
        return self._geojson_export_executor

    def release_export_pool(self) -> None:
        """Retire the GeoJSON export threads without touching any data.

        The registry releases an idle handler by dropping its reference rather
        than calling reset_data, because a request may still be holding one —
        but a ThreadPoolExecutor's workers are NOT reliably retired by garbage
        collection (measured: threads outlive the collected owner), so the pool
        has to be closed explicitly.

        ``cancel_futures`` is deliberately not set: work already submitted must
        be allowed to finish, and _export_geojson already recreates the pool on
        RuntimeError if a later export finds it closed.
        """
        executor = getattr(self, "_geojson_export_executor", None)
        if executor is None:
            return
        self._geojson_export_executor = None
        try:
            executor.shutdown(wait=False)
        except Exception as e:
            print(f"[Warn] release_export_pool => {e}")

    @staticmethod
    def _same_zarr_path(a: Optional[str], b: Optional[str]) -> bool:
        """True when two paths refer to the same zarr store (normcase + abspath)."""
        if not a or not b:
            return False
        try:
            return os.path.normcase(os.path.normpath(os.path.abspath(a))) == os.path.normcase(
                os.path.normpath(os.path.abspath(b))
            )
        except Exception:
            return a == b

    def ensure_file(
        self,
        zarr_file_path: str,
        *,
        need_centroids: bool = False,
        need_patches: bool = False,
    ) -> None:
        """Bind this handler to ``zarr_file_path``, reloading when path or required data is missing."""
        if not zarr_file_path:
            raise ValueError("zarr_file_path is required")

        path_changed = not self._same_zarr_path(self.zarr_file, zarr_file_path)
        missing_centroids = need_centroids and (
            self.centroids is None
        )
        missing_patches = need_patches and self.patch_coordinates is None

        if path_changed:
            # Drop previous workset entirely before binding a new slide.
            self.release_zarr()
            self.load_file(
                zarr_file_path,
                force_reload=True,
                reload_segmentation_data=need_centroids or need_patches,
            )
            return

        if missing_centroids or missing_patches or getattr(self, "_needs_reload", False):
            self.load_file(
                zarr_file_path,
                force_reload=True,
                reload_segmentation_data=need_centroids or need_patches or missing_centroids,
            )

    def _warm_contours_async(self, path) -> None:
        """Pull ``contours`` into RAM a second from now, then swap it in.

        Reading 63 MB the instant the bind returns lands on the tile burst for the
        slide just opened and cost ~30 ms on the next set_path, so it waits — on a
        daemon timer, which also means a pending warm never holds up shutdown. The
        swap is one attribute assignment, so a reader sees either the zarr array
        or the ndarray (both answer the same queries), and the guards drop the
        result if the handler has moved on meanwhile.

        Every reload arms its own timer. A dedupe flag looked cheaper but did not
        converge: a burst of reloads suppressed every warm after the first, and
        that one then lost the swap race to a newer array and left the slide lazy
        for good. Redundant timers cost nothing instead — whichever lands first
        makes the rest return at the isinstance check below.
        """
        def warm() -> None:
            try:
                array = self.contours
                if array is None or isinstance(array, np.ndarray):
                    return                      # already warm, or gone
                if not self._same_zarr_path(self.zarr_file, path):
                    return                      # switched away
                data = np.array(array)
                if self._same_zarr_path(self.zarr_file, path) and self.contours is array:
                    self.contours = data
            except Exception as e:
                logger.warning(f"[load_file] contour warm failed for {path}: {e}")

        timer = threading.Timer(1.0, warm)
        timer.daemon = True
        timer.start()

    def release_zarr(self) -> None:
        """Clear in-memory segmentation state without reloading a file."""
        self.zarr_file = None
        # Drop held zarr store handle before nulling large arrays.
        zarr_obj = getattr(self, "_zarr_file_obj", None)
        self._zarr_file_obj = None
        if zarr_obj is not None:
            try:
                store = getattr(zarr_obj, "store", None)
                if store is not None and hasattr(store, "close"):
                    store.close()
            except Exception:
                pass
            del zarr_obj

        try:
            self._viewport_cache.clear()
        except Exception:
            pass
        self._merged_patches_cache = {}

        # Explicitly drop large numpy / scipy structures so CPython can reclaim ASAP.
        for attr in (
            "centroids",
            "contours",
            "tissues",
            "probabilities",
            "patch_coordinates",
            "patch_centroids",
            "patch_class_id",
            "patch_class_name",
            "patch_class_hex_color",
            "patch_class_probabilities",
            "kd_tree",
            "class_id",
            "class_name",
            "class_hex_color",
        ):
            try:
                setattr(self, attr, None)
            except Exception:
                pass

        self.annotations_data = {}
        self.tissue_annotations = {}
        self.annotation_colors = {
            "class_id": [],
            "class_name": [],
            "class_hex_color": [],
        }
        self._user_annotation_counts_cache = None
        self._global_label_counts_cache = None
        self._last_load_time = 0.0
        self._needs_reload = False

        # Shut down per-handler export pool if it was created.
        executor = getattr(self, "_geojson_export_executor", None)
        if executor is not None:
            try:
                executor.shutdown(wait=False, cancel_futures=True)
            except TypeError:
                # Python < 3.9 compat: cancel_futures not available
                try:
                    executor.shutdown(wait=False)
                except Exception:
                    pass
            except Exception:
                pass
            self._geojson_export_executor = None

        # Encourage prompt return of large array buffers after handler teardown.
        try:
            gc.collect()
        except Exception:
            pass

    def reset_data(self):
        """Clear all in-memory data. Does not reload the previous file."""
        self.release_zarr()

    def _classification_stamp_on_disk(self):
        """Identity of the classification result currently on disk.

        zarr's LocalStore writes every file (metadata and chunks) as a temp file
        renamed into place, so the array directory's mtime moves when zarr.json
        is rewritten (a run re-creates the array) and the ``c`` chunk directory's
        mtime moves on any in-place chunk write. Two stats, no directory walk;
        directory mtimes behave this way on Linux, macOS and NTFS alike.
        Returns None when there is no result on disk.
        """
        try:
            array_dir = os.path.join(self.zarr_file, self.get_classification_prefix(), 'class_indices')
            meta = os.stat(array_dir).st_mtime_ns
        except (OSError, TypeError):
            return None
        try:
            chunks = os.stat(os.path.join(array_dir, 'c')).st_mtime_ns
        except OSError:
            chunks = None
        return (meta, chunks)

    def _normalize_class_id_length(self):
        """Ensure self.class_id length matches number of centroids; pad/truncate with -1."""
        try:
            if self.centroids is None or self.class_id is None:
                return
            num_cells = len(self.centroids)
            current_len = len(self.class_id)
            if current_len == num_cells:
                return
            normalized = np.full(num_cells, -1, dtype=int)
            copy_len = min(current_len, num_cells)
            if copy_len > 0:
                try:
                    normalized[:copy_len] = self.class_id[:copy_len]
                except Exception:
                    pass
            self.class_id = normalized
        except Exception as e:
            print(f"[Warn] _normalize_class_id_length => {e}")

    def update_class_definitions(self, ui_classes: List[str], ui_colors: List[str]):
        """
        Merges class definitions from the UI with the handler's in-memory state.
        This ensures that new classes created in the UI are known to the backend for the session.
        """
        if self.class_name is None: self.class_name = []
        if self.class_hex_color is None: self.class_hex_color = []

        # Convert to lists if they are numpy arrays
        current_names = list(self.class_name)
        current_colors = list(self.class_hex_color)

        for i, name in enumerate(ui_classes):
            if name not in current_names:
                current_names.append(name)
                # Ensure the colors list is extended safely
                if i < len(ui_colors):
                    current_colors.append(ui_colors[i])
                else:
                    current_colors.append("#FFFFFF") # Default color for safety
            else:
                # Update existing class color if provided
                if i < len(ui_colors):
                    existing_index = current_names.index(name)
                    current_colors[existing_index] = ui_colors[i]

        self.class_name = np.array(current_names)
        self.class_hex_color = np.array(current_colors)

    def load_file(self, zarr_file_path, force_reload: bool = True, reload_segmentation_data: bool = True):
        """Load data directly from Zarr file - simplified version without cache
        
        Args:
            zarr_file_path: Path to the Zarr file
            force_reload: Whether to force a reload even if file is already loaded
            reload_segmentation_data: Whether to reload centroids and contours (set to False to only refresh annotations)
        """

        # Fast-path: if the same file is already loaded, check if reload is really needed
        if self._same_zarr_path(self.zarr_file, zarr_file_path):
            needs_reload = getattr(self, '_needs_reload', False)
            # Lightweight binds (WS set_path) only set zarr_file; do not treat
            # "path set + file exists" as fully loaded when centroids are required.
            has_workset = self.centroids is not None
            if not reload_segmentation_data and not force_reload and not needs_reload:
                # Cheap staleness probe (one stat): a classification run that
                # finished since the last load must not keep serving old labels.
                result_unchanged = (
                    self._classification_stamp_on_disk() == getattr(self, '_classification_stamp', None)
                )
                if (has_workset or self._zarr_file_obj is not None) and result_unchanged:
                    return
            
            # Throttle rapid consecutive reload requests (disabled when interval is 0)
            now = time.time()
            last = getattr(self, '_last_load_time', 0.0)
            min_interval = getattr(self, '_min_reload_interval', 0.0)
            if (
                min_interval > 0
                and (now - last) < min_interval
                and not needs_reload
                and not reload_segmentation_data
                and not force_reload
            ):
                return

        # Clear caches
        # Removed unnecessary caches for Zarr files
        self._user_annotation_counts_cache = None
        # IMPORTANT: Also clear global label counts cache to ensure fresh data after reload
        self._global_label_counts_cache = None
        # Viewport annotations embed class_id/colors; stale entries would keep the old overlay
        # after NuClass Update even when in-memory class_id was refreshed.
        if force_reload or getattr(self, '_needs_reload', False):
            try:
                self._viewport_cache.clear()
            except Exception:
                pass

        # Close old handle when switching files OR force-reloading. Writers such as
        # NuClass delete/recreate Cell-Classification; a stale read handle can keep
        # serving the previous group and leave the overlay unchanged after Update.
        if self._zarr_file_obj is not None and (force_reload or self.zarr_file != zarr_file_path):
            try:
                # Zarr files don't need explicit close, but we should clear the reference
                self._zarr_file_obj = None
            except Exception as e:
                logger.warning(f"Exception occurred while clearing Zarr file references: {e}")

        self.zarr_file = zarr_file_path
        
        # Load data directly from Zarr file - no cache needed.
        # Do not use os.access(R_OK): it false-denies Windows directory
        # symlinks used by Viewer single-file shares.
        if not is_zarr_store_path(zarr_file_path):
            raise FileNotFoundError(f"Zarr file not found: {zarr_file_path}")

        # Open Zarr file and keep it open for reuse (read-only mode is safe to keep open).
        # Deliberately unlocked: zarr.open only reads root metadata and returns a lazy
        # handle, so the array reads this is meant to protect all happen after the
        # call anyway. The one mutation reachable from here is ensure_v3's repair,
        # which takes zarr_lock itself. The write lock that used to wrap this bought
        # nothing and nested inside ensure_v3's, burning the full 120 s timeout.
        if self._zarr_file_obj is None:
            self._zarr_file_obj = open_zarr(zarr_file_path, 'r')
        
        try:
            zarr_file = self._zarr_file_obj
            
            # Get prefixes for data organization. Patch data lives in two groups
            # now: Patch-Segmentation (embeddings + coordinates) and
            # Patch-Classification (class_indices + classes/ + probabilities).
            classification_prefix = self.get_classification_prefix()
            patch_prefix = self.get_patch_classification_prefix()
            patch_seg_prefix = getattr(self, '_patch_segmentation_prefix', 'Patch-Segmentation')

            # Large slides keep contours as a live zarr array. After force_reload we
            # discarded the old handle, so those refs are stale and must be rebound
            # even when the caller asked for a lightweight (no-geometry) reload.
            lazy_contours_stale = False
            if force_reload and self.contours is not None and not isinstance(self.contours, np.ndarray):
                lazy_contours_stale = True

            # Only reload centroids and contours if reload_segmentation_data is True
            if reload_segmentation_data or lazy_contours_stale:
                # Check Cell-Segmentation group structure
                if 'Cell-Segmentation' in zarr_file:
                    seg_group = zarr_file['Cell-Segmentation']
                    
                    # Look for centroids and contours in Cell-Segmentation group
                    if 'centroids' in seg_group:
                        self.centroids = np.array(seg_group['centroids'])
                    else:
                        self.centroids = None
                    
                    # Look for contours with lazy loading optimization
                    if 'contours' in seg_group:
                        # Budget by bytes, not cell count: 50k cells is 12 MB of
                        # these 32-point contours, so the old rule kept a 63 MB
                        # array (CMU-1, 248k cells) lazy and re-read chunks of it
                        # on every viewport query — 18 ms against 7 ms in RAM,
                        # and 102 vs 5 ms on a slide whose cells are not stored
                        # in viewport order. Warmed in the background so the read
                        # stays off the slide switch; until it lands, queries use
                        # the lazy path and are correct, just slower.
                        contours_array = seg_group['contours']
                        nbytes = (
                            int(np.prod(contours_array.shape))
                            * contours_array.dtype.itemsize
                        )
                        self.contours = contours_array
                        if nbytes <= CONTOURS_RAM_BUDGET_BYTES:
                            self._warm_contours_async(zarr_file_path)
                    else:
                        self.contours = None
                else:
                    self.centroids = None
                    self.contours = None
            else:
                # Intentionally skip centroids/contours loading in lightweight mode.
                # Callers that need segmentation geometry should explicitly request
                # reload_segmentation_data=True and will trigger on-demand loading.
                pass


            # Load classification data - try metadata first, then fallback to datasets
            class_id_key = f'{classification_prefix}_nuclei_class_id'
            class_name_key = f'{classification_prefix}_nuclei_class_name'
            class_hex_color_key = f'{classification_prefix}_nuclei_class_HEX_color'
            
            # Try to load from metadata first
            if classification_prefix in zarr_file:
                group = zarr_file[classification_prefix]
                if hasattr(group, 'attrs'):
                    metadata_class_names = group.attrs.get('class_names', [])
                    metadata_class_colors = group.attrs.get('class_colors', [])

                    # Prefer metadata attributes (current format). Writers (NuClass, seg
                    # services) persist class_names/class_colors on the group attrs.
                    loaded_from_metadata = False
                    if metadata_class_names and metadata_class_colors:
                        disk_names = [str(n) for n in metadata_class_names]
                        disk_colors = [str(c) for c in metadata_class_colors]
                        prev_names = (
                            [str(n) for n in self.class_name]
                            if self.class_name is not None
                            else None
                        )
                        # Soft preserve only when the on-disk palette matches memory.
                        # Otherwise keeping old class_id while swapping names/colors
                        # paints cells with the wrong labels.
                        same_palette = prev_names is not None and prev_names == disk_names
                        # Same names is not the same result: a re-run with an
                        # unchanged class list rewrites class_indices under the
                        # same palette, and every non-force reload (REST reads,
                        # refresh_annotations) would keep serving the old labels.
                        disk_stamp = self._classification_stamp_on_disk()
                        same_result = disk_stamp == getattr(self, '_classification_stamp', None)
                        can_preserve = (
                            not force_reload
                            and same_palette
                            and same_result
                            and self.class_id is not None
                            and self.centroids is not None
                            and len(self.class_id) == len(self.centroids)
                            and np.any(self.class_id >= 0)
                        )

                        if can_preserve:
                            # Names stable: allow color-only refresh from disk.
                            self.class_hex_color = np.array(disk_colors)
                            loaded_from_metadata = True
                            needs_population = False
                        else:
                            self.class_name = np.array(disk_names)
                            self.class_hex_color = np.array(disk_colors)
                            loaded_from_metadata = True

                            if self.centroids is not None:
                                self.class_id = np.full(len(self.centroids), -1, dtype=int)
                            else:
                                self.class_id = np.array([-1])

                            needs_population = True

                        # Load per-cell assignments from class_indices when needed.
                        try:
                            if needs_population and 'class_indices' in group:
                                self.class_id = np.array(group['class_indices'][:], dtype=int)
                        except Exception as e:
                            print(f"[Warn] load_file => Failed populating nuclei_class_id from class_indices: {e}")
                        self._classification_stamp = disk_stamp
                        # Ensure length alignment
                        self._normalize_class_id_length()

                    # Skip flattened root-level keys only when attrs+indices already loaded.
                    if loaded_from_metadata:
                        skip_dataset_loading = True
                    elif self.class_id is not None and self.class_name is not None:
                        skip_dataset_loading = True
                    else:
                        skip_dataset_loading = False
                else:
                    skip_dataset_loading = False
            else:
                skip_dataset_loading = False
            
            # Load classification data from Zarr (only if metadata not available)
            if not skip_dataset_loading:
                # First load class_name and class_hex_color (needed for class_id mapping)
                if class_name_key in zarr_file:
                    raw_class_name = np.array(zarr_file[class_name_key])
                else:
                    raw_class_name = None
                
                if class_hex_color_key in zarr_file:
                    raw_class_hex_color = np.array(zarr_file[class_hex_color_key])
                else:
                    raw_class_hex_color = None
                
                # Process class name and hex color data
                if raw_class_name is not None:
                    # Check if it's a numpy array first
                    if hasattr(raw_class_name, 'dtype') and raw_class_name.dtype.kind == 'S':  # byte string
                        self.class_name = np.array([name.decode('utf-8') for name in raw_class_name])
                    elif isinstance(raw_class_name, list):
                        self.class_name = np.array(raw_class_name)
                    else:
                        self.class_name = raw_class_name
                else:
                    self.class_name = None
                    
                if raw_class_hex_color is not None:
                    # Check if it's a numpy array first
                    if hasattr(raw_class_hex_color, 'dtype') and raw_class_hex_color.dtype.kind == 'S':  # byte string
                        self.class_hex_color = np.array([color.decode('utf-8') for color in raw_class_hex_color])
                    elif isinstance(raw_class_hex_color, list):
                        self.class_hex_color = np.array(raw_class_hex_color)
                    else:
                        self.class_hex_color = raw_class_hex_color
                else:
                    self.class_hex_color = None
                
                # Now load class_id data (only if not already loaded from group)
                if self.class_id is None:
                    if class_id_key in zarr_file:
                        self.class_id = np.array(zarr_file[class_id_key])
                    else:
                        # Try alternative locations for class_id data
                        if 'User-Annotations' in zarr_file:
                            user_ann_group = zarr_file['User-Annotations']
                            
                            # Check if nuclei_annotations contains class_id information
                            if 'cell' in user_ann_group:
                                try:
                                    nuclei_ann_data = user_ann_group['cell'][()]
                                    if isinstance(nuclei_ann_data, bytes):
                                        nuclei_ann_json = json.loads(nuclei_ann_data.decode('utf-8'))
                                        
                                        # Try to extract class_id information from annotations
                                        if nuclei_ann_json:
                                            # Initialize class_id array with -1 (unclassified)
                                            self.class_id = np.full(len(self.centroids), -1, dtype=np.int32)
                                            
                                            # Extract class_id from annotations
                                            for cell_id, annotation_data in nuclei_ann_json.items():
                                                if isinstance(cell_id, str) and cell_id.isdigit():
                                                    idx = int(cell_id)
                                                    if idx < len(self.class_id):
                                                        # Get class_id from annotation data
                                                        cell_class = annotation_data.get('class')
                                                        if cell_class:
                                                            # Map class name to class_id
                                                            if self.class_name is not None:
                                                                try:
                                                                    class_idx = np.where(self.class_name == cell_class)[0]
                                                                    if len(class_idx) > 0:
                                                                        self.class_id[idx] = class_idx[0]
                                                                except Exception as e:
                                                                    logger.warning(
                                                                        f"Failed to map cell_class '{cell_class}' to class_id for cell_id '{cell_id}': "
                                                                        f"[{type(e).__name__}] {e}"
                                                                    )
                                        else:
                                            self.class_id = None
                                    else:
                                        self.class_id = None
                                except Exception as e:
                                    self.class_id = None
                            else:
                                self.class_id = None
                        else:
                            self.class_id = None
                        # Also try string label dataset at root for ClassificationNode
                        alt_string_key = f'{classification_prefix}_nuclei_class'
                        if self.class_id is None and alt_string_key in zarr_file and self.class_name is not None:
                            try:
                                raw_labels = np.array(zarr_file[alt_string_key])
                                labels = [lbl.decode('utf-8') if isinstance(lbl, (bytes, bytearray)) else str(lbl) for lbl in raw_labels]
                                name_to_idx = {name: i for i, name in enumerate(self.class_name)}
                                self.class_id = np.array([name_to_idx.get(label, -1) for label in labels], dtype=int)
                            except Exception as e:
                                print(f"[Warn] load_file => Failed mapping root label dataset '{alt_string_key}': {e}")

                # Ensure length alignment
                self._normalize_class_id_length()
            
            # Apply manual nuclei annotations to update class_id (always, regardless of skip_dataset_loading)
            self._apply_manual_nuclei_annotations(zarr_file)
            
            # Everything from here to validate_centroids is patch-overlay data,
            # loaded on a bind whose caller asked for cell centroids. Lapped
            # separately so the split is visible.
            # Load patch coordinates from Patch-Segmentation.
            if patch_seg_prefix in zarr_file and 'coordinates' in zarr_file[patch_seg_prefix]:
                self.patch_coordinates = np.array(zarr_file[patch_seg_prefix]['coordinates'])

            # Load patch class data from Patch-Classification group.
            if patch_prefix in zarr_file and 'class_indices' in zarr_file[patch_prefix]:
                patch_group = zarr_file[patch_prefix]
                self.patch_class_id = np.array(patch_group['class_indices'][:])
                if 'classes/name' in patch_group:
                    self.patch_class_name = np.array([
                        n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n)
                        for n in patch_group['classes/name'][:]
                    ])
                if 'classes/color' in patch_group:
                    self.patch_class_hex_color = np.array([
                        c.decode('utf-8') if isinstance(c, (bytes, bytearray)) else str(c)
                        for c in patch_group['classes/color'][:]
                    ])
                # Per-patch class probabilities (absent for zero-shot).
                if 'probabilities' in patch_group:
                    self.patch_class_probabilities = np.array(patch_group['probabilities'][:])
            

            # Load other data
            if 'tissues' in zarr_file:
                self.tissues = np.array(zarr_file['tissues']).tolist()
            else:
                self.tissues = []
            
            if 'annotations_data' in zarr_file:
                self.annotations_data = dict(zarr_file['annotations_data'])
            else:
                self.annotations_data = {}
            

            try:
                from app.services.tasks import load_patch_annotations
                # Reuse the open store instead of reopening it.
                self.tissue_annotations = load_patch_annotations(zarr_file_path, zarr_file)
            except Exception as _e:
                logger.warning(f"[load_file] patch annotations load failed: {_e}")
                self.tissue_annotations = {}
            
            # Build KD tree if centroids and contours are available (full reload or
            # after rebinding stale lazy contour refs that forced a geometry reload).
            # This used to build a scipy KDTree here — 692ms for 213k cells, on
            # every slide open, for a structure whose only callers were radius
            # searches that indices_in_viewport now answers with a mask. The
            # validation it wrapped is still needed: indices_in_viewport indexes
            # centroids[:, 0] and [:, 1] directly.
            # Validate a snapshot, not the attribute: a concurrent reload (a
            # workflow finishing while set_path force-reloads the same handler)
            # swaps it between these reads, and the except below then blanked the
            # slide's centroids over a race rather than over bad data.
            centroids = self.centroids
            if centroids is not None:
                try:
                    if not isinstance(centroids, np.ndarray):
                        centroids = np.array(centroids)
                    if len(centroids.shape) != 2 or centroids.shape[1] != 2:
                        print(f"[Error] load_file => Invalid centroids shape: {centroids.shape}, expected (N, 2)")
                        centroids = None
                    elif np.any(np.isnan(centroids)) or np.any(np.isinf(centroids)):
                        print(f"[Error] load_file => Centroids contain NaN or infinite values")
                        centroids = None
                except Exception as e:
                    print(f"[Error] load_file => Failed to validate centroids: {e}")
                    print(f"[Error] load_file => Traceback: {traceback.format_exc()}")
                    centroids = None
                self.centroids = centroids
            
            # Manual nuclei annotations are now applied earlier in the method
            
            # Mark the list mirror stale rather than rebuilding it here: it is one
            # Python list entry per cell (a 2M-element list on a big slide) and
            # every reader of it is either rare (the exporters) or unused by the
            # app (/v1/annotation_colors). The property below builds it on demand.
            if self.class_id is not None and self.class_name is not None and self.class_hex_color is not None:
                self._annotation_colors = None
            
            # Load manual tissue annotations if they exist
            self._apply_manual_patch_annotations(zarr_file)
            
            # Update last load time
            self._last_load_time = time.time()
            self._needs_reload = False

        except Exception as e:
            print(f"[ERROR] load_file - Error reading Zarr file: {e}")
            print(f"[ERROR] load_file - Exception type: {type(e).__name__}")
            print(f"[ERROR] load_file - Full traceback: {traceback.format_exc()}")
            raise
    
    def refresh_annotations(self):
        """Refresh only annotations data without reloading centroids and contours.
        This is much faster than a full reload and should be used after saving annotations.
        """
        if not self.zarr_file or not os.path.exists(self.zarr_file):
            print(f"[Warning] refresh_annotations => No valid Zarr file loaded")
            return

        # Clear annotation cache
        self._user_annotation_counts_cache = None
        
        try:
            # Only reload annotations-related data, not centroids/contours
            # Set _needs_reload=True to ensure annotations are applied even if class_id is None
            # Use force_reload=False to respect debounce interval (0.2s) for rapid consecutive calls
            # This prevents performance issues when refresh_annotations is called multiple times quickly
            self._needs_reload = True
            self.load_file(self.zarr_file, force_reload=False, reload_segmentation_data=False)
        except Exception as e:
            print(f"[ERROR] refresh_annotations => Error refreshing annotations: {e}")
            print(f"[ERROR] refresh_annotations => Full traceback: {traceback.format_exc()}")
            raise
    def _apply_manual_patch_annotations(self, zarr_file):
        if 'User-Annotations' not in zarr_file or 'patch' not in zarr_file['User-Annotations']:
            return

        try:
            raw_bytes = zarr_file['User-Annotations/patch'][()]
            manual_annotations = json.loads(raw_bytes.decode("utf-8"))
        except Exception as e:
            print(f"[Error] Failed to load or parse manual annotations: {e}")
            return
            
        if not manual_annotations:
            return

        # Scenario 1: No model data exists, initialize everything from manual annotations
        if self.patch_class_name is None:
            if self.patch_coordinates is None:
                print("[Error] Cannot apply manual annotations without patch coordinates. Aborting.")
                return

            # Create a mapping from class name to a new integer ID (exclude negative selection entries with tissue_class None)
            all_manual_classes = sorted(list(set(item['class'] for item in manual_annotations.values() if item.get('class') is not None)))
            
            # Ensure "Negative control" is present and first if needed
            if "Negative control" not in all_manual_classes:
                self.patch_class_name = ["Negative control"] + all_manual_classes
            else:
                self.patch_class_name = ["Negative control"] + [cls for cls in all_manual_classes if cls != "Negative control"]

            self.patch_class_id = np.full(len(self.patch_coordinates), -1, dtype=int) # Default all to unclassified (-1)
            
            # Don't extract colors from annotations - use default, colors will come from colormap
            # Initialize with default colors, will be overridden by colormap if available
            self.patch_class_hex_color = ["#808080"] * len(self.patch_class_name)
            if "Negative control" in self.patch_class_name:
                 nc_index = self.patch_class_name.index("Negative control")
                 self.patch_class_hex_color[nc_index] = "#aaaaaa" # Default color for negative control
        else:
            # Ensure mutable Python lists for appending new classes/colors
            if isinstance(self.patch_class_name, np.ndarray):
                try:
                    self.patch_class_name = self.patch_class_name.tolist()
                except Exception:
                    self.patch_class_name = list(self.patch_class_name)
            if self.patch_class_hex_color is None:
                self.patch_class_hex_color = []
            elif isinstance(self.patch_class_hex_color, np.ndarray):
                try:
                    self.patch_class_hex_color = self.patch_class_hex_color.tolist()
                except Exception:
                    self.patch_class_hex_color = list(self.patch_class_hex_color)

        # Now, proceed with overriding based on the (potentially just created) class mapping
        class_to_id_map = {name: i for i, name in enumerate(self.patch_class_name)}
        
        for patch_id_str, annotation in manual_annotations.items():
            try:
                patch_id = int(patch_id_str)
            except (ValueError, TypeError):
                continue

            class_name = annotation.get("class")

            if class_name is None:
                continue

            # Check if the manually annotated class exists in our current list.
            if class_name not in class_to_id_map:
                new_id = len(self.patch_class_name)
                self.patch_class_name.append(class_name)
                # Don't read color from annotation - use default, color will come from colormap
                self.patch_class_hex_color.append('#808080')  # Default, will be overridden by colormap
                class_to_id_map[class_name] = new_id

            # Get the ID for the class and update the patch_class_id array
            target_class_id = class_to_id_map[class_name]
            
            if 0 <= patch_id < len(self.patch_class_id):
                user_ts_str = annotation.get('datetime')
                if user_ts_str and self.patch_model_timestamp:
                    try:
                        user_ts = datetime.strptime(user_ts_str, '%Y-%m-%d %H:%M:%S.%f')
                        model_ts = datetime.fromisoformat(self.patch_model_timestamp)
                        if user_ts <= model_ts:
                            continue
                    except ValueError as ve:
                        pass
                self.patch_class_id[patch_id] = target_class_id
            else:
                print(f"[Warning] Manual annotation patch_ID {patch_id} is out of bounds.")
        
        # Update self.tissue_annotations with the loaded manual annotations
        self.tissue_annotations = manual_annotations

    def _load_annotations_array(self, zarr_file, fields=None, return_non_empty_indices=False):
        """
        Load annotations from Zarr file using structured array format.
        Returns the structured array directly (no conversion to dict).
        
        Args:
            zarr_file: Open Zarr file object
            fields: Optional list of field names to load. If None, loads all fields.
                    This can significantly speed up loading for large arrays.
            return_non_empty_indices: If True, also return indices of non-empty annotations.
        
        Returns:
            Structured array or None if no annotations found or error occurred.
            If return_non_empty_indices=True, returns (array, non_empty_indices) tuple.
        """
        if 'User-Annotations' not in zarr_file:
            return None if not return_non_empty_indices else (None, None)
        
        user_annotation_group = zarr_file['User-Annotations']
        base_name = 'cell'
        
        # Only support structured array format
        if base_name not in user_annotation_group:
            # No annotations found
            return None if not return_non_empty_indices else (None, None)
        
        try:
            annotations_dataset = user_annotation_group[base_name]
            array_size = annotations_dataset.shape[0]
            
            # Optimize: only load specific fields if requested
            # For structured arrays with large fields (like region_geometry U2048), 
            # loading only needed fields is much faster than loading entire array
            if fields:
                
                # Load only requested fields directly (Zarr handles this efficiently)
                # This avoids loading large unused fields like region_geometry
                dtype_list = [(field, annotations_dataset.dtype[field]) for field in fields if field in annotations_dataset.dtype.names]
                if not dtype_list:
                    return None if not return_non_empty_indices else (None, None)
                
                # zarr v3 cannot index a structured Array by field name (it
                # raises a cast error). A structured dtype is stored as whole
                # records per chunk anyway, so read the records once and select
                # the requested fields with numpy.
                #
                # THE RECORD IS 400 BYTES, nearly all of it the method/annotator
                # Unicode fields — callers here want the two 4-byte int columns.
                # So copy into a packed array rather than returning the view
                # `raw[fields]` would give: a view keeps the whole record array
                # alive through its `.base` (800 MB on a 2M-cell slide, against
                # 16 MB packed). Same reasoning applies wherever this array is
                # read; the full read itself is unavoidable.
                raw = annotations_dataset[:]
                result = np.empty(array_size, dtype=dtype_list)
                for field, _field_dtype in dtype_list:
                    result[field] = raw[field]
                del raw
                return result if not return_non_empty_indices else (result, None)
            else:
                # Load entire structured array (slower but complete). `[:]` is
                # already a fresh array; np.array() around it only copied it again.
                manual_annotations = annotations_dataset[:]
                return manual_annotations if not return_non_empty_indices else (manual_annotations, None)
        except Exception as e:
            print(f"[Error] Failed to load structured array format annotations: {e}")
            return None if not return_non_empty_indices else (None, None)
    
    def _clear_contradicted_predictions(self, cell_class_ids, original_indices, user_anno_class_names):
        """Retract predictions that a negative ("No") annotation has ruled out.

        A negative selection stores ``-(2 + k)``: the cell is NOT class ``k``.
        That never says what the cell *is*, so this only drops a prediction it
        contradicts — a cell painted "QQQ" after the user marked it "not QQQ"
        goes back to unclassified; one predicted "Stroma" keeps its colour.

        ``k`` indexes the User-Annotations palette, ``self.class_id`` indexes
        Cell-Classification's; nothing keeps the two orderings in step, so they
        are bridged by name (as the exporters do with ``palette_i = -ci - 2``).
        """
        if self.class_id is None or not len(user_anno_class_names):
            return
        cell_class_ids = np.asarray(cell_class_ids)
        neg_rows = np.flatnonzero(cell_class_ids <= -2)
        if neg_rows.size == 0:
            return

        excluded_k = (-cell_class_ids[neg_rows] - 2).astype(int)
        keep = (excluded_k >= 0) & (excluded_k < len(user_anno_class_names))
        neg_rows, excluded_k = neg_rows[keep], excluded_k[keep]

        # Annotation rows map back to cell indices only when the loader returned
        # a sparse subset; otherwise the row index is the cell index.
        if original_indices is not None:
            original_indices = np.asarray(original_indices)
            keep = neg_rows < len(original_indices)
            neg_rows, excluded_k = neg_rows[keep], excluded_k[keep]
            cell_ids = original_indices[neg_rows]
        else:
            cell_ids = neg_rows

        class_id = np.asarray(self.class_id)
        keep = (cell_ids >= 0) & (cell_ids < len(class_id))
        cell_ids, excluded_k = cell_ids[keep], excluded_k[keep]

        model_names = [str(n) for n in (self.class_name if self.class_name is not None else [])]
        # Built per *class*, not per annotated cell: this runs on every reload,
        # and a heavily annotated slide has as many negative rows as marked
        # cells — a comprehension over excluded_k would be O(cells) of Python.
        model_index_of = {name: i for i, name in enumerate(model_names)}
        ua_to_model = np.array(
            [model_index_of.get(str(name), -1) for name in user_anno_class_names],
            dtype=int,
        )
        excluded_model_idx = ua_to_model[excluded_k]

        contradicted = (excluded_model_idx >= 0) & (class_id[cell_ids] == excluded_model_idx)
        if not np.any(contradicted):
            return
        class_id[cell_ids[contradicted]] = -1
        self.class_id = class_id

    def _apply_manual_nuclei_annotations(self, zarr_file):
        # Always apply manual annotations to ensure handler state is synchronized with Zarr file
            
        if 'User-Annotations' not in zarr_file:
            return
        
        # Load structured array directly (no dict conversion for performance)
        # Load both cell_class and cell_color to check for unclassified cells (cell_class=0 with empty color)
        load_result = self._load_annotations_array(zarr_file, fields=['class', 'color'], return_non_empty_indices=True)
        if isinstance(load_result, tuple):
            manual_annotations, original_indices = load_result
        else:
            manual_annotations = load_result
            original_indices = None
        
        if manual_annotations is None or len(manual_annotations) == 0:
            # Initialize default classification data if none exists
            if self.class_name is None and self.centroids is not None:
                self.class_name = ["Negative control"]
                self.class_hex_color = ["#aaaaaa"]
                self.class_id = np.full(len(self.centroids), -1, dtype=int)
            return

        # Get cell class data (direct field access, no copy)
        # For structured arrays, field access is O(1) and doesn't copy data
        cell_class_data = manual_annotations['class']
        
        # Also check cell_color to ensure we only count cells with actual annotations
        # A cell with cell_class=0 but empty cell_color should be treated as unclassified (-1)
        cell_color_data = None
        if 'color' in manual_annotations.dtype.names:
            cell_color_data = manual_annotations['color']
        
        # Structured array format: cell_class is int32 ID
        # -1 = unclassified (not annotated)
        # 0+ = class index in class_names array (0 = "Negative control" if it's first, 1+ = other classes)
        if cell_class_data.dtype.kind not in ['i', 'u']:
            # Not integer format - this should not happen with new format
            logger.warning(f"[_apply_manual_nuclei_annotations] Unexpected dtype for cell_class: {cell_class_data.dtype}. Expected integer format.")
            return
        
        cell_class_ids = cell_class_data.copy() if hasattr(cell_class_data, 'copy') else cell_class_data
        
        # If cell_class is >= 0 but cell_color is -1 (not set), treat as unclassified (-1)
        if cell_color_data is not None:
            # cell_color is now int32 (-1 = not set, 0 = black is a valid color)
            empty_color_mask = (cell_color_data < 0)
            # Set cell_class to -1 for cells with empty color (unclassified)
            cell_class_ids[empty_color_mask] = -1
        
        non_empty_mask = cell_class_ids >= 0  # >= 0 means classified (including "Negative control" at index 0)
        
        # Get class_names from metadata for ID to name mapping
        # Read both at once via the helper so v3/v2/v1 fallback is handled in one place.
        class_names_from_metadata = []
        class_colors_from_metadata = []
        if 'User-Annotations' in zarr_file:
            class_names_from_metadata, class_colors_from_metadata = read_user_anno_class_palette(
                zarr_file['User-Annotations'], 'cell',
            )
        
        if not np.any(non_empty_mask):
            if self.class_name is None and self.centroids is not None:
                self.class_name = ["Negative control"]
                self.class_hex_color = ["#aaaaaa"]
                self.class_id = np.full(len(self.centroids), -1, dtype=int)
            # A store whose only annotations are negatives has no positive row to
            # apply, but its "No" marks still have predictions to retract.
            self._clear_contradicted_predictions(
                cell_class_ids, original_indices, class_names_from_metadata,
            )
            return

        # Scenario 1: No model data exists, initialize everything from manual annotations
        # OR: class_name exists but class_id is not properly initialized (e.g., after reset)
        if self.class_name is None or self.class_id is None or (self.centroids is not None and len(self.class_id) != len(self.centroids)):
            if self.centroids is None:
                print("[Error] Cannot apply manual annotations without centroids data. Aborting.")
                return

            # If class_name already exists (from ClassificationNode), use it; otherwise extract from annotations
            if self.class_name is None:
                # Use class_names from metadata
                if class_names_from_metadata:
                    self.class_name = ["Negative control"] + [name for name in class_names_from_metadata if name != "Negative control"]
                    # Map colors to class names (helper already returned the palette).
                    if class_colors_from_metadata:
                        color_map = dict(zip(class_names_from_metadata, class_colors_from_metadata))
                        self.class_hex_color = ["#aaaaaa"]  # Negative control color
                        for name in class_names_from_metadata:
                            if name != "Negative control":
                                self.class_hex_color.append(color_map.get(name, "#808080"))
                    else:
                        self.class_hex_color = ["#aaaaaa"] + ["#808080"] * (len(self.class_name) - 1)
                else:
                    # No metadata found, use default
                    self.class_name = ["Negative control"]
                    self.class_hex_color = ["#aaaaaa"]
            else:
                # class_name exists but class_id needs initialization
                # Ensure class_hex_color is also initialized if missing
                if self.class_hex_color is None or len(self.class_hex_color) != len(self.class_name):
                    self.class_hex_color = ["#808080"] * len(self.class_name)
                    if "Negative control" in self.class_name:
                        nc_index = self.class_name.index("Negative control")
                        self.class_hex_color[nc_index] = "#aaaaaa"
                
                # BUG FIX: Merge user-added classes from user_annotation.attrs into self.class_name
                # This ensures manually added classes (e.g., "Adipocytes (Fat Cells)") are not lost
                # when handler reloads data after save_annotation invalidates the cache
                if class_names_from_metadata:
                    current_names = list(self.class_name)
                    current_colors = list(self.class_hex_color) if self.class_hex_color is not None else []
                    color_map = dict(zip(class_names_from_metadata, class_colors_from_metadata)) if class_colors_from_metadata else {}

                    # Add missing classes from metadata
                    classes_added = []
                    for meta_name in class_names_from_metadata:
                        if meta_name not in current_names:
                            current_names.append(meta_name)
                            current_colors.append(color_map.get(meta_name, "#808080"))
                            classes_added.append(meta_name)

                    if classes_added:
                        self.class_name = np.array(current_names)
                        self.class_hex_color = np.array(current_colors)

            # Default all nuclei to UNCLASSIFIED (-1) until explicitly annotated
            self.class_id = np.full(len(self.centroids), -1, dtype=int)
        else:
            # Scenario 2: Both class_name and class_id exist with correct lengths
            # Still need to merge user-added classes from metadata to ensure consistency
            if class_names_from_metadata:
                current_names = list(self.class_name)
                current_colors = list(self.class_hex_color) if self.class_hex_color is not None else []
                color_map = dict(zip(class_names_from_metadata, class_colors_from_metadata)) if class_colors_from_metadata else {}

                # Add missing classes from metadata
                classes_added = []
                for meta_name in class_names_from_metadata:
                    if meta_name not in current_names:
                        current_names.append(meta_name)
                        current_colors.append(color_map.get(meta_name, "#808080"))
                        classes_added.append(meta_name)

                if classes_added:
                    self.class_name = np.array(current_names)
                    self.class_hex_color = np.array(current_colors)

        # Now, proceed with overriding based on the (potentially just created) class mapping
        class_to_id_map = {name: i for i, name in enumerate(self.class_name)}
        
        # Pre-allocate lists for better performance
        class_name_list = list(self.class_name)
        class_hex_color_list = list(self.class_hex_color)
        
        # Batch process annotations using numpy operations (much faster)
        
        # Filter annotations using numpy masks
        valid_indices = np.where(non_empty_mask)[0]
        
        # First pass: collect valid annotations and new classes
        # Use vectorized operations where possible
        
        # Map sparse indices back to original indices if needed
        if original_indices is not None:
            # original_indices contains the mapping from sparse array to full array
            # After reset, original_indices might be from a different array size,
            # so we need to ensure valid_indices are within bounds
            max_valid_idx = len(original_indices) - 1
            if len(valid_indices) > 0 and valid_indices.max() > max_valid_idx:
                # Reset detected: recalculate valid_indices based on current array size
                # Recalculate valid_indices based on current array
                valid_indices = np.where(non_empty_mask)[0]
                # After reset, use valid_indices directly as nucleus_ids
                nucleus_ids = valid_indices if len(valid_indices) > 0 else np.array([], dtype=int)
            else:
                # Ensure valid_indices are within bounds before indexing
                if len(valid_indices) > 0 and valid_indices.max() >= len(original_indices):
                    # Additional safety check: filter out out-of-bounds indices
                    valid_mask = valid_indices < len(original_indices)
                    valid_indices = valid_indices[valid_mask]
                nucleus_ids = original_indices[valid_indices] if len(valid_indices) > 0 else np.array([], dtype=int)
        else:
            nucleus_ids = valid_indices
        
        # Vectorized filtering: use integer IDs directly (new format)
        # cell_class_ids are already integer IDs:
        # -1 = unclassified (not annotated)
        # 0+ = class index in class_names array (0 = "Negative control" if it's first, 1+ = other classes)
        cell_class_subset = cell_class_ids[valid_indices]
        
        # Create mask for valid classes (>= 0 means classified, including "Negative control" at index 0)
        # No need to check for temporary classes in new format - they're handled by class_names mapping
        valid_class_mask = cell_class_subset >= 0
        
        # Apply mask
        filtered_nucleus_ids = nucleus_ids[valid_class_mask]
        filtered_class_ids = cell_class_subset[valid_class_mask]
        
        # Handle timestamp filtering if needed (load datetime only if filtering is needed)
        if self.nuclei_model_timestamp and len(filtered_nucleus_ids) > 0:
            # Load datetime field only when needed for filtering
            if 'User-Annotations' in zarr_file:
                user_annotation_group = zarr_file['User-Annotations']
                if 'cell' in user_annotation_group:
                    try:
                        datetime_data = user_annotation_group['cell'][:]['datetime']
                        filtered_datetime = datetime_data[valid_indices][valid_class_mask]
                        
                        timestamp_mask = np.ones(len(filtered_nucleus_ids), dtype=bool)
                        model_ts = datetime.fromisoformat(self.nuclei_model_timestamp)
                        model_timestamp_ms = int(model_ts.timestamp() * 1000)  # Convert to milliseconds
                        
                        # Structured array format: datetime is timestamp in milliseconds (int64)
                        if datetime_data.dtype.kind not in ['i', 'u']:
                            logger.warning(f"[_apply_manual_nuclei_annotations] Unexpected dtype for datetime: {datetime_data.dtype}. Expected integer timestamp format.")
                            # Skip timestamp filtering if format is incorrect
                            timestamp_mask = np.ones(len(filtered_nucleus_ids), dtype=bool)
                        else:
                            # Timestamp format: keep annotations with timestamp > model_timestamp (newer annotations)
                            timestamp_mask = filtered_datetime > model_timestamp_ms
                        
                        # Apply timestamp mask
                        filtered_nucleus_ids = filtered_nucleus_ids[timestamp_mask]
                        filtered_class_ids = filtered_class_ids[timestamp_mask]
                    except Exception as e:
                        print(f"[Debug] Could not load datetime for filtering: {e}")
        
        # Check bounds using vectorized operation
        bounds_mask = (filtered_nucleus_ids >= 0) & (filtered_nucleus_ids < len(self.class_id))
        out_of_bounds_count = np.sum(~bounds_mask)
        if out_of_bounds_count > 0:
            print(f"[Warning] {out_of_bounds_count} manual annotation cell_IDs are out of bounds.")
        
        # Apply bounds mask
        final_nucleus_ids = filtered_nucleus_ids[bounds_mask]
        final_class_ids = filtered_class_ids[bounds_mask]
        
        # For new format, class_ids are already indices in class_names_from_metadata
        # We need to map them to self.class_name indices
        # If class_names_from_metadata matches self.class_name, we can use IDs directly
        # Otherwise, we need to map them
        
        # Second pass: apply annotations in batch using integer IDs directly
        # New format: class_ids are already indices, just need to map to self.class_name
        if len(final_nucleus_ids) > 0:
            # Map class_ids from metadata indices to self.class_name indices
            # If class_names_from_metadata matches self.class_name, IDs can be used directly
            # Otherwise, we need to create a mapping
            if class_names_from_metadata and len(class_names_from_metadata) > 0:
                # Check if metadata has "Negative control" and if self.class_name has it at index 0
                metadata_has_nc = "Negative control" in class_names_from_metadata
                handler_has_nc_at_0 = (len(self.class_name) > 0 and self.class_name[0] == "Negative control")
                
                # If metadata doesn't have "Negative control" but handler does (at index 0),
                # we need to offset the class_ids by +1
                # Example: metadata has ["Class1", "Class2"] with class_id 0,1
                #          handler has ["Negative control", "Class1", "Class2"]
                #          metadata class_id 0 should map to handler class_id 1
                needs_offset = not metadata_has_nc and handler_has_nc_at_0
                
                if needs_offset:
                    # Offset all class_ids by +1 to account for "Negative control" added at index 0
                    offset_class_ids = final_class_ids + 1
                    # Filter valid IDs (within range of self.class_name)
                    max_class_id = len(self.class_name) - 1
                    valid_mask = (offset_class_ids >= 0) & (offset_class_ids <= max_class_id)
                    if np.any(valid_mask):
                        valid_nucleus_ids = final_nucleus_ids[valid_mask]
                        valid_class_ids = offset_class_ids[valid_mask]
                        # Vectorized assignment
                        self.class_id[valid_nucleus_ids] = valid_class_ids
                    else:
                        print(f"[Warning] No valid class IDs found after offset (max={max_class_id})")
                else:
                    # Create mapping from metadata class_names to self.class_name indices
                    metadata_to_handler_map = {}
                    for i, name in enumerate(class_names_from_metadata):
                        if name in class_to_id_map:
                            metadata_to_handler_map[i] = class_to_id_map[name]
                        else:
                            # Class not found in handler, skip it
                            metadata_to_handler_map[i] = -1
                    
                    # Map class_ids using vectorized operation
                    # Create a lookup array for fast mapping
                    lookup_size = max(max(final_class_ids), max(metadata_to_handler_map.keys())) + 1 if len(final_class_ids) > 0 else 0
                    lookup_array = np.full(lookup_size, -1, dtype=np.int32)
                    for k, v in metadata_to_handler_map.items():
                        lookup_array[k] = v
                    # Use numpy advanced indexing; out-of-bounds indices will be set to -1
                    mapped_class_ids = np.where(
                        (final_class_ids >= 0) & (final_class_ids < lookup_size),
                        lookup_array[final_class_ids],
                        -1
                    )
                    # Filter valid mappings (>= 0)
                    valid_mask = mapped_class_ids >= 0
                    if np.any(valid_mask):
                        valid_nucleus_ids = final_nucleus_ids[valid_mask]
                        valid_class_ids = mapped_class_ids[valid_mask]
                        
                        # Vectorized assignment (much faster than loop)
                        self.class_id[valid_nucleus_ids] = valid_class_ids
                    else:
                        print(f"[Warning] No valid class mappings found for {len(final_class_ids)} annotations")
            else:
                # No metadata, use IDs directly (assuming they match self.class_name)
                # Filter valid IDs (within range of self.class_name)
                max_class_id = len(self.class_name) - 1
                valid_mask = (final_class_ids >= 0) & (final_class_ids <= max_class_id)
                if np.any(valid_mask):
                    valid_nucleus_ids = final_nucleus_ids[valid_mask]
                    valid_class_ids = final_class_ids[valid_mask]
                    
                    # Vectorized assignment
                    self.class_id[valid_nucleus_ids] = valid_class_ids
                else:
                    print(f"[Warning] No valid class IDs found (max={max_class_id})")
        
        # Convert back to numpy arrays
        self.class_name = np.array(class_name_list)
        self.class_hex_color = np.array(class_hex_color_list)

        # Negative selection ("No"): drop the predictions those marks contradict.
        # Runs after the palette above is final — the helper resolves by name.
        self._clear_contradicted_predictions(
            cell_class_ids, original_indices, class_names_from_metadata,
        )
        
        # Cache mechanism removed - always process annotations
        
        # Auto-create ClassificationNode if it doesn't exist and we have classification data
        if self.class_name is not None and self.class_hex_color is not None and len(self.class_name) > 0:
            try:
                zarr_file_path = self.get_current_file_path()

                with open_zarr_cm(zarr_file_path, 'a') as zf:
                    if 'Cell-Classification' not in zf:
                        classification_group = zf.create_group('Cell-Classification')
                        
                        # Store class information as group attributes
                        classification_group.attrs['class_names'] = [str(name) for name in self.class_name]
                        classification_group.attrs['class_colors'] = [str(color) for color in self.class_hex_color]
                        classification_group.attrs['path'] = str(zarr_file_path)
                        classification_group.attrs['last_updated'] = time.time()
                        
                        # nuclei_class_id is not stored in ClassificationNode attributes
                        # It is dynamically extracted from User-Annotations/cell when needed
            except Exception as e:
                print(f"[Debug] Failed to create ClassificationNode: {e}")
                traceback.print_exc()

    def set_classification_prefix(self, prefix):
        """set prefix for classification result"""
        self._classification_prefix = prefix

    def get_classification_prefix(self):
        """get prefix for classification result"""
        return self._classification_prefix
    
    def set_nuclei_segmentation_prefix(self, prefix):
        """set prefix for nuclei segmentation result"""
        self._nuclei_segmentation_prefix = prefix

    def get_nuclei_segmentation_prefix(self):
        """get prefix for nuclei segmentation result"""
        return self._nuclei_segmentation_prefix
    
    def set_tissue_segmentation_prefix(self, prefix):
        """set prefix for tissue segmentation result"""
        self._tissue_segmentation_prefix = prefix
    
    def get_patch_classification_prefix(self):
        """get prefix for patch classification result"""
        return self._patch_classification_prefix
    
    def set_patch_classification_prefix(self, prefix):
        """set prefix for patch classification result"""
        self._patch_classification_prefix = prefix

    def get_tissue_segmentation_prefix(self):
        """get prefix for tissue segmentation result"""
        return self._tissue_segmentation_prefix
    
    def get_patch_classification(self):
        """Return (class_ids, class_names, hex_colors, class_counts) for the patch panel.

        Source priority for class names + colors:
          1. self.patch_class_name / self.patch_class_hex_color  — populated from
             Patch-Classification/classes during load_file
          2. Patch-Classification/classes/{name,color} read directly from zarr
             (covers the case where handler state was cleared but zarr is fresh)
          3. Patch-Classification/userData/{tissue_classes, tissue_colors} —
             covers the case where the user configured classes in the panel but
             has not run classification yet (so /classes doesn't exist).

        Counts are always computed live from User-Annotations/patch via
        np.bincount — no cache, no JSON-bytes blob.
        """
        def _decode_list(raw):
            if raw is None:
                return []
            if hasattr(raw, 'tolist'):
                raw = raw.tolist()
            if isinstance(raw, (bytes, bytearray)):
                return [raw.decode('utf-8')]
            if isinstance(raw, list):
                return [(x.decode('utf-8') if isinstance(x, (bytes, bytearray)) else str(x)) for x in raw]
            return [str(raw)]

        processed_class_name = _decode_list(getattr(self, 'patch_class_name', None))
        processed_class_hex_color = _decode_list(getattr(self, 'patch_class_hex_color', None))

        # Fallback chain when handler state is empty (e.g. right after reset or
        # before MUSK Classification has populated Patch-Classification).
        if not processed_class_name and self.zarr_file and os.path.exists(self.zarr_file):
            try:
                with open_zarr_cm(self.zarr_file, 'r') as zf:
                    if 'Patch-Classification' in zf:
                        pc = zf['Patch-Classification']
                        if 'classes/name' in pc:
                            processed_class_name = _decode_list(pc['classes/name'][:])
                        if 'classes/color' in pc:
                            processed_class_hex_color = _decode_list(pc['classes/color'][:])
                    if not processed_class_name and 'Patch-Classification' in zf and 'userData' in zf['Patch-Classification']:
                        ud = zf['Patch-Classification/userData']
                        if 'tissue_classes' in ud:
                            try:
                                raw = ud['tissue_classes'][()]
                                if isinstance(raw, (bytes, bytearray)):
                                    raw = raw.decode('utf-8')
                                processed_class_name = list(json.loads(raw))
                            except Exception as e:
                                try:
                                    logger.error(f"patch tissue_class/colors parse failed: {e}", exc_info=True)
                                except Exception:
                                    pass
                        if 'tissue_colors' in ud:
                            try:
                                raw = ud['tissue_colors'][()]
                                if isinstance(raw, (bytes, bytearray)):
                                    raw = raw.decode('utf-8')
                                processed_class_hex_color = list(json.loads(raw))
                            except Exception as e:
                                try:
                                    logger.error(f"patch tissue_class/colors parse failed: {e}", exc_info=True)
                                except Exception:
                                    pass
            except Exception as e:
                print(f"[get_patch_classification] zarr fallback read failed: {e}")

        # Pad / truncate colors to match names so the frontend always sees a
        # consistent (name, color) pair.
        num_classes = len(processed_class_name)
        if len(processed_class_hex_color) < num_classes:
            processed_class_hex_color = list(processed_class_hex_color) + ["#aaaaaa"] * (num_classes - len(processed_class_hex_color))
        elif len(processed_class_hex_color) > num_classes:
            processed_class_hex_color = processed_class_hex_color[:num_classes]

        defined_class_ids = list(range(num_classes))

        # Live counts from User-Annotations/patch — one bincount, no cache.
        class_counts = [0] * num_classes
        if num_classes > 0 and self.zarr_file and os.path.exists(self.zarr_file):
            try:
                with open_zarr_cm(self.zarr_file, 'r') as zf:
                    if 'User-Annotations' in zf and 'patch' in zf['User-Annotations']:
                        parr = zf['User-Annotations/patch'][:]
                        if hasattr(parr.dtype, 'names') and parr.dtype.names and 'class' in parr.dtype.names:
                            ci = parr['class']
                            valid = ci[(ci >= 0) & (ci < num_classes)]
                            if valid.size > 0:
                                counts = np.bincount(valid, minlength=num_classes)
                                class_counts = counts[:num_classes].tolist()
            except Exception as e:
                print(f"[get_patch_classification] count compute failed: {e}")

        return defined_class_ids, processed_class_name, processed_class_hex_color, class_counts
    
    def get_current_file_path(self):
        if self.zarr_file:
            return self.zarr_file
        return None

    def clear_annotations_cache(self):
        self.annotations_data = {}
        self.tissue_annotations = {}
    
    #   classification
    def _build_class_palette(self):
        """Class names + colors for the cell classes, or ``None`` when absent.

        Metadata only: reads ``class_name`` / ``class_hex_color`` and the
        User-Annotations palette. Never touches centroids or the per-cell
        assignments, so it can answer without a segmentation-data load.
        """
        if self.class_name is None or self.class_hex_color is None:
            return None

        # Prefer User-Annotations colors for matching names and append user-only
        # classes at the end — never replace the whole palette with a differently
        # ordered User-Annotations list (that would mis-color the overlay).
        names_out = [str(name) for name in self.class_name] if self.class_name is not None else []
        colors_out = [str(color) for color in self.class_hex_color] if self.class_hex_color is not None else []
        while len(colors_out) < len(names_out):
            colors_out.append("#808080")
        colors_out = colors_out[: len(names_out)]

        try:
            if self._zarr_file_obj is not None:
                zarr_file = self._zarr_file_obj
            elif self.zarr_file and os.path.exists(self.zarr_file):
                zarr_file = open_zarr(self.zarr_file, 'r')
                self._zarr_file_obj = zarr_file
            else:
                zarr_file = None

            if zarr_file is not None and 'User-Annotations' in zarr_file:
                user_anno = zarr_file['User-Annotations']
                user_anno_names, user_anno_colors = read_user_anno_class_palette(user_anno, 'cell')
                if user_anno_names and len(user_anno_names) == len(user_anno_colors):
                    color_by_name = {
                        str(n): str(c) for n, c in zip(user_anno_names, user_anno_colors)
                    }
                    for i, name in enumerate(names_out):
                        if name in color_by_name:
                            colors_out[i] = color_by_name[name]
                    for n, c in zip(user_anno_names, user_anno_colors):
                        name = str(n)
                        if name not in names_out:
                            names_out.append(name)
                            colors_out.append(str(c))
        except Exception as e:
            logger.warning(f"Failed to read user_annotation metadata for class names and colors: {e}")

        return names_out, colors_out

    def get_cell_classification_palette(self):
        """Class names and colors, without the per-cell assignments.

        This is all the viewer needs: the overlay frames already carry each
        cell's ``class_id``. Skipping ``class_indices`` lets the caller answer
        from metadata alone instead of loading every centroid and building the
        KD-tree first (measured at 1455 ms on a fresh handler).
        """
        palette = self._build_class_palette()
        if palette is None:
            return None
        names_out, colors_out = palette
        return {"class_names": names_out, "class_colors": colors_out}

    def get_cell_classification_data(self):
        """Palette plus the per-cell class assignments (exports, workflows).

        Needs the segmentation arrays loaded — see
        ``get_cell_classification_palette`` for the metadata-only variant.
        """
        # Only load if handler doesn't have data
        if self.centroids is None or self.zarr_file is None:
            current_file = self.get_current_file_path()
            if not current_file:
                return None
            self.load_file(current_file, force_reload=False, reload_segmentation_data=False)

        # If there are no base classifications from the Zarr file, there's nothing to return.
        if self.class_id is None or self.class_name is None or self.class_hex_color is None:
            return None

        palette = self._build_class_palette()
        if palette is None:
            return None
        names_out, colors_out = palette

        # User overrides already live in self.class_id via _apply_manual_nuclei_annotations
        # (User-Annotations/cell rows with class >= 0). No separate AL-reclassification
        # store to read here. class_indices use the handler/model index space.
        effective_class_ids = np.copy(self.class_id)

        return {
            "class_indices": effective_class_ids.tolist(),
            "class_names": names_out,
            "class_colors": colors_out,
        }

    # `None` means "derive from the classification arrays on next read" (set by
    # load_file); anything else is used as-is, so the append log that
    # store_annotation_color builds is never clobbered by the derived form.
    _annotation_colors = None

    @property
    def annotation_colors(self):
        cached = self._annotation_colors
        if cached is None:
            def as_list(v):
                if v is None:
                    return []
                return v.tolist() if hasattr(v, 'tolist') else list(v)
            cached = {
                "class_id": as_list(self.class_id),
                "class_name": as_list(self.class_name),
                "class_hex_color": as_list(self.class_hex_color),
            }
            self._annotation_colors = cached
        return cached

    @annotation_colors.setter
    def annotation_colors(self, value):
        self._annotation_colors = value

    def store_annotation_color(self, indices, class_name, color):
        """Store the color for the given indices (vectorized)."""
        # Convert to numpy array if not already
        if not isinstance(indices, np.ndarray):
            indices = np.array(indices)
        # Vectorized batch append: extend all lists at once
        n = len(indices)
        self.annotation_colors["class_id"].extend(indices.tolist())
        self.annotation_colors["class_name"].extend([class_name] * n)
        self.annotation_colors["class_hex_color"].extend([color] * n)

    def get_annotation_color(self, index):
        """Class name and colour for one cell index, or None.

        ``annotation_colors`` holds one of two shapes, and this has to read both:

        * derived (the property above) — ``class_id`` is one class index per
          cell, ``class_name``/``class_hex_color`` are the palette, so the
          answer is ``class_name[class_id[index]]``;
        * append log (``store_annotation_color``) — all three lists are parallel
          and ``class_id`` holds cell indices, so the answer is the entry whose
          ``class_id`` equals ``index``.

        The old guard mixed the two — ``index < len(class_id)`` treats ``index``
        as a position while ``index in class_id`` treats it as a value — so a
        log holding cells [7, 8, 9] answered None for all of them.
        """
        colors = self.annotation_colors or {}
        ids = colors.get("class_id") or []
        names = colors.get("class_name") or []
        hexes = colors.get("class_hex_color") or []
        if not ids or not names:
            return None
        try:
            index = int(index)
        except (TypeError, ValueError):
            return None

        if len(ids) == len(names) == len(hexes):
            # Append log. Scanned from the end so the most recent mark of a cell
            # wins, which is what re-annotating it means.
            for pos in range(len(ids) - 1, -1, -1):
                if ids[pos] == index:
                    return {"class_name": names[pos], "class_hex_color": hexes[pos]}
            return None

        # Derived: index addresses a cell, its value addresses the palette.
        if not 0 <= index < len(ids):
            return None
        palette_i = ids[index]
        if not 0 <= palette_i < min(len(names), len(hexes)):
            return None
        return {"class_name": names[palette_i], "class_hex_color": hexes[palette_i]}
    
    def get_annotation_colors(self):
        """Get all annotation colors."""
        return self.annotation_colors

    def create_annotation(self, index, contour, color: Optional[str] = None, class_id: Optional[Any] = None, class_name: Optional[str] = None, is_patch: bool = False):
        """
        Create a simplified annotation format without zoom scale factor.
        Color is only retrieved from ClassificationNode, no default value.
        Returns: {
            "centroids": [x, y],
            "contours": [[x, y], ...],  # Original coordinates, not scaled
            "color": str or None,  # Only from ClassificationNode, None if no classification
            "classid": int or None,
            "classname": str or "N/A",
            "minX": float,
            "minY": float,
            "maxX": float,
            "maxY": float
        }
        """
        if not isinstance(contour, np.ndarray):
            contour_np = np.array(contour)
        else:
            contour_np = contour

        # Legacy check for old (2, K) format. The new format is (K, 2).
        if contour_np.ndim == 2 and contour_np.shape[0] == 2:
            print(f"[create_annotation] WARNING: Received legacy (2, K) contour format for index {index}. Transposing. Please update the data source to provide (K, 2) format.")
            contour_np = contour_np.T

        # Validate if contour_np is now (K, 2) with K >= 3
        if not (contour_np.ndim == 2 and contour_np.shape[1] == 2 and contour_np.shape[0] >= 3):
            print(f"[create_annotation] Warning: Contour for index {index} has invalid shape {contour_np.shape} after potential transpose. Expected (K, 2) with K >= 3. Skipping.")
            return None

        # Convert contour to list format (original coordinates, no scaling)
        try:
            contours_list = [
                [float(x), float(y)]
                for x, y in contour_np  # Iterates over rows (points) of (K,2) array
            ]
        except Exception as e:
            print(f"[create_annotation] Error processing contour points for index {index}, shape {contour_np.shape}: {e}.")
            return None

        if not contours_list or len(contours_list) < 3:
            print(f"[create_annotation] Warning: Contour for index {index} resulted in < 3 points. Skipping.")
            return None

        # Get centroid from centroids array
        centroid = None
        if self.centroids is not None and 0 <= index < len(self.centroids):
            centroid = [float(self.centroids[index][0]), float(self.centroids[index][1])]

        # Get classification data from ClassificationNode (no default values)
        class_id_val = None
        class_name_val = "N/A"
        effective_color = None  # No default, only from ClassificationNode

        if is_patch:
            if class_id is not None:
                try:
                    class_id_val = int(class_id)
                except (ValueError, TypeError):
                    class_id_val = None
            if class_id_val is not None and class_id_val < 0:
                class_id_val = None

            if class_name is not None:
                class_name_val = class_name.decode('utf-8') if isinstance(class_name, bytes) else str(class_name)
                if not class_name_val.strip():
                    class_name_val = "N/A"

            if color is not None:
                effective_color = color.decode('utf-8') if isinstance(color, bytes) else str(color)
        else:
            try:
                # Only get color from ClassificationNode if classification data exists
                if self.class_id is not None and self.class_name is not None and self.class_hex_color is not None and \
                   0 <= index < len(self.class_id):
                    
                    assigned_class_id_val = self.class_id[index]
                    class_id_val = int(assigned_class_id_val) if assigned_class_id_val >= 0 else None
                    
                    if class_id_val is not None and 0 <= class_id_val < len(self.class_hex_color) and \
                       0 <= class_id_val < len(self.class_name):
                        # Get color from ClassificationNode
                        effective_color = self.class_hex_color[class_id_val]
                        if isinstance(effective_color, bytes):
                            effective_color = effective_color.decode('utf-8')
                        
                        # Get class name from ClassificationNode
                        class_name_val = self.class_name[class_id_val]
                        if isinstance(class_name_val, bytes):
                            class_name_val = class_name_val.decode('utf-8')
            except (ValueError, IndexError, TypeError) as e:
                print(f"[Debug] Error getting classification data for nucleus index {index}: {str(e)}")
                # Keep color as None if classification data is not available

        # Calculate bounds from contours (original coordinates, no scaling)
        xs = [p[0] for p in contours_list]
        ys = [p[1] for p in contours_list]
        min_x = float(min(xs))
        min_y = float(min(ys))
        max_x = float(max(xs))
        max_y = float(max(ys))

        # For patches, `index` is the patch index, not a cell index, so the
        # cell-centroid lookup above picks the wrong point (a random cell, or
        # [0, 0] when no cells exist). Patch coords are x1,y1,x2,y2, so use the
        # bounding-box center instead, ensuring "View" jumps to the patch center.
        if is_patch:
            centroid = [(min_x + max_x) / 2.0, (min_y + max_y) / 2.0]

        # Return simplified annotation format
        annotation = {
            "id": str(index),
            "centroids": centroid if centroid else [0.0, 0.0],
            "contours": contours_list,
            "color": effective_color,
            "classid": class_id_val,
            "classname": class_name_val,
            "minX": min_x,
            "minY": min_y,
            "maxX": max_x,
            "maxY": max_y
        }

        # Store in annotations_data for backward compatibility (if needed)
        self.annotations_data[index] = annotation
        return annotation

    def create_tissue_annotation(self):
        """
        default color is yellow.
        """
        if not self.tissues or len(self.tissues) == 0:
            return

        for tissue in self.tissues:
            index = tissue["id"]
            contour = tissue["points"]

            points = [[float(x), float(y)] for x, y in contour]
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            bounds = {
                "minX": min(xs),
                "minY": min(ys),
                "maxX": max(xs),
                "maxY": max(ys)
            }

            unique_id = str(index)
            tissue_color = "#ffff00"

            style_body = {
                "id": unique_id,
                "annotation": unique_id,
                "type": "TextualBody",
                "purpose": "style",
                "value": tissue_color,
                "created": datetime.now().isoformat(),
                "creator": {
                    "id": "default",
                    "type": "AI"
                }
            }

            annotation = {
                "id": unique_id,
                "type": "Annotation",
                "bodies": [style_body],
                "target": {
                    "annotation": unique_id,
                    "selector": {
                        "type": "POLYGON",
                        "geometry": {
                            "points": points,
                            "bounds": bounds
                        }
                    }
                },
                "creator": {
                    "isGuest": True,
                    "id": "nrESYlDUe8L1qF6Ffhq4"
                },
                "created": datetime.now().isoformat()
            }

            self.tissue_annotations[index] = annotation

    def get_all_tissue_annotations(self):
        """Get all tissue annotations."""
        # first create tissue annotations
        self.create_tissue_annotation()
        # return in list format
        return list(self.tissue_annotations.values())

    def get_all_annotations(self):
        """
        normal annotation.
        """
        return list(self.annotations_data.values())

    def get_annotations_in_viewport(self, x1, y1, x2, y2, use_classification=False, simplified=False,
                                    as_arrays=False):
        """``as_arrays=True`` (simplified only) returns ``(ids, class_ids, contours)``
        as int32 arrays — ``contours`` is ``(n, k, 2)`` when the store's contours
        are uniform, else a list of ``(k_i, 2)`` — instead of one dict per cell.
        For a whole-slide query that is the difference between ~10 ms and ~250 ms
        of per-cell Python, which holds the GIL and stalls the event loop."""
        # Check if we have the required data, try to reload if missing
        if self.centroids is None or self.contours is None:
            print(f"[Warning] get_annotations_in_viewport => Missing required data - attempting reload")
            if self.zarr_file and os.path.exists(self.zarr_file):
                try:
                    # Only reload segmentation data if it's missing
                    self.load_file(self.zarr_file, force_reload=True, reload_segmentation_data=True)
                except Exception as e:
                    print(f"[ERROR] get_annotations_in_viewport => Failed to reload data: {e}")
                    return [], {}

        # Circumradius of the viewport rect (+ BUFFER). Using max(w,h)/2 * 1.2
        # leaves the four corners uncovered on near-square windows.
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        width = x2 - x1
        height = y2 - y1
        radius = math.sqrt(width ** 2 + height ** 2) / 2.0 + self.BUFFER
        # buffer=0 on purpose: contours are expensive to load (lazy zarr, large
        # viewports), so this path wants the exact viewport, not the padded one.
        # The old code took the padded ball and clipped it back down here; asking
        # for the exact rect up front is the same set without the round trip.
        points_in_view = self.indices_in_viewport(x1, y1, x2, y2, buffer=0)

        # One snapshot for the whole query. This reads the array once per cell in
        # the fallback path, and a rebind clearing it midway made those reads fail
        # one by one — each caught and skipped, so the reply came back silently
        # short instead of failing. The background warm also swaps this attribute;
        # both representations answer the same, but only if it is the same one
        # throughout.
        contours = self.contours
        if contours is None:
            # Cleared by a rebind after the guard above. Answer as an empty
            # viewport rather than failing the read once per cell.
            return [], {}

        # Check cache for simplified annotations (disabled when _cache_max_size == 0)
        if simplified and not as_arrays and self._cache_max_size > 0:
            # The index set used to be part of the key, as a tuple of up to 213k
            # Python ints: three full-size allocations to build, an O(n) hash on
            # every lookup, and megabytes retained per entry. It was guarding
            # against the indices changing under a fixed viewport, which every
            # path that can do that already handles — load_file clears this cache
            # on force_reload, release_zarr clears it, and so do the eight
            # annotation-mutation sites. The viewport alone identifies the entry.
            cache_key = (x1, y1, x2, y2, use_classification)
            if cache_key in self._viewport_cache:
                cached_result, cached_counts = self._viewport_cache[cache_key]
                return cached_result, cached_counts

            # Manage cache size
            if len(self._viewport_cache) >= self._cache_max_size:
                # Remove oldest entry (true FIFO using OrderedDict)
                self._viewport_cache.popitem(last=False)  # last=False removes oldest

        if simplified:
            # Optimized simplified annotation data for frontend rendering.
            # Binary wire format only needs id / class_id / points — skip per-cell
            # color maps (frontend colors from class palette).
            if len(points_in_view) == 0:
                counts = self.get_all_nuclei_counts()
                if counts is None:
                    counts = {'class_counts_by_id': {}, 'dynamic_class_names': []}
                return [], counts

            # One gather for both representations: an in-RAM ndarray and a lazy
            # zarr Array both fancy-index along axis 0 (zarr reads only the chunks
            # touched — 15k cells: 21 ms, against ~250 ms per-cell). Uniform
            # (N, k, 2) stores need no per-cell validation.
            valid_indices = np.asarray(points_in_view)
            valid_contours = None
            if getattr(contours, 'ndim', 0) == 3 and contours.shape[2] == 2:
                try:
                    n_rows = contours.shape[0]
                    if not isinstance(contours, np.ndarray) and len(valid_indices) * 4 > n_rows:
                        # Large selection on the lazy array: one full read (32 ms)
                        # beats fancy-indexing the same rows (158 ms), and it is
                        # exactly what _warm_contours_async would load — keep it.
                        # Only within the same RAM budget load_file uses to decide
                        # whether to keep the array lazy, or one whole-slide query
                        # would pin a store that was deliberately left on disk.
                        nbytes = int(np.prod(contours.shape)) * contours.dtype.itemsize
                        if nbytes <= CONTOURS_RAM_BUDGET_BYTES:
                            full = np.asarray(contours[:])
                            if self.contours is contours:
                                self.contours = full
                            contours = full
                    if isinstance(contours, np.ndarray) and len(valid_indices) == n_rows:
                        # indices_in_viewport returns flatnonzero output, so a
                        # full-length selection is every row in order: pass the
                        # array through instead of copying it (63 MB on CMU-1).
                        valid_contours = contours
                    else:
                        valid_contours = np.asarray(contours[valid_indices])
                except Exception as e:
                    logger.warning(f"[get_annotations_in_viewport] batch contour read failed, falling back: {e}")
            if valid_contours is None:
                # Ragged / legacy layouts: per-cell, with transposition and validity checks.
                valid_contours = []
                valid_indices = []
                for idx in points_in_view:
                    try:
                        contour = contours[idx]
                        if not isinstance(contour, np.ndarray):
                            contour = np.array(contour)
                        if contour.ndim == 2 and contour.shape[0] == 2:
                            contour = contour.T
                        if contour.ndim == 2 and contour.shape[1] == 2 and contour.shape[0] >= 3:
                            valid_contours.append(contour)
                            valid_indices.append(idx)
                    except (IndexError, KeyError, TypeError) as e:
                        print(f"[get_annotations_in_viewport] Warning: Error accessing contour {idx}: {e}")
                        continue

            if len(valid_contours) == 0:
                counts = self.get_all_nuclei_counts()
                if counts is None:
                    counts = {'class_counts_by_id': {}, 'dynamic_class_names': []}
                return [], counts

            class_id_arr = self.class_id

            if as_arrays:
                ids = np.asarray(valid_indices, dtype=np.int32)
                class_ids = np.full(len(ids), -1, dtype=np.int32)
                if class_id_arr is not None and len(class_id_arr):
                    known = ids < len(class_id_arr)
                    # Gather first, then narrow: class_id is int64, so converting
                    # it whole allocated and rewrote every cell on the slide to
                    # read the few thousand in view — on every pan and zoom.
                    class_ids[known] = np.asarray(class_id_arr)[ids[known]].astype(np.int32)
                counts = self.get_all_nuclei_counts() or {'class_counts_by_id': {}, 'dynamic_class_names': []}
                result = counts.copy()
                if self.class_name is not None and self.class_hex_color is not None:
                    result['class_names'] = list(self.class_name)
                    result['class_colors'] = list(self.class_hex_color)
                return (ids, class_ids, valid_contours), result

            # Build wire payloads directly (int32 matches binary packer; no float64 detour / stack)
            simplified_annotations = []
            for i, idx in enumerate(valid_indices):
                points = np.asarray(valid_contours[i], dtype=np.int32, order='C')
                effective_class_id = -1
                if class_id_arr is not None and idx < len(class_id_arr):
                    effective_class_id = int(class_id_arr[idx])
                simplified_annotations.append({
                    "id": int(idx),
                    "points": points,
                    "class_id": effective_class_id,
                })

            counts = self.get_all_nuclei_counts()
            if counts is None:
                counts = {'class_counts_by_id': {}, 'dynamic_class_names': []}

            result = counts.copy()
            if self.class_name is not None and self.class_hex_color is not None:
                result['class_names'] = self.class_name.tolist() if hasattr(self.class_name, 'tolist') else list(self.class_name)
                result['class_colors'] = self.class_hex_color.tolist() if hasattr(self.class_hex_color, 'tolist') else list(self.class_hex_color)

            if self._cache_max_size > 0:
                cache_key = (x1, y1, x2, y2, use_classification)
                self._viewport_cache[cache_key] = (simplified_annotations, result)

            return simplified_annotations, result
        else:
            # Create full annotation data for integration with user annotations
            annotations = []
            for idx in points_in_view:
                contour = contours[idx]

                # Color is retrieved from ClassificationNode in create_annotation, no default value
                annotation = self.create_annotation(idx, contour)
                if annotation:
                    annotations.append(annotation)

            counts = self.get_all_nuclei_counts()
            if counts is None:
                counts = {'class_counts_by_id': {}, 'dynamic_class_names': []}
            return annotations, counts

    def get_clusters_in_viewport(self, x1, y1, x2, y2):
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        width = x2 - x1
        height = y2 - y1
        radius = math.sqrt(width ** 2 + height ** 2) / 2.0 + self.BUFFER
        indices_in_view = self.indices_in_viewport(x1, y1, x2, y2)
        points = self.centroids[indices_in_view].tolist()
        return points

    def get_centroids_in_viewport(self, x1, y1, x2, y2):
        # Check if handler needs reload due to file change
        if hasattr(self, '_needs_reload') and self._needs_reload:
            try:
                # Check if we need to force reload centroids (e.g., after file switch)
                force_reload_centroids = hasattr(self, '_force_reload_centroids') and self._force_reload_centroids
                
                # If centroids/contours are already loaded and we don't need to force reload, only refresh annotations
                if self.centroids is not None and self.contours is not None and not force_reload_centroids:
                    self.load_file(self.zarr_file, force_reload=True, reload_segmentation_data=False)
                else:
                    # Force reload centroids/contours if flag is set or if they don't exist
                    self.load_file(self.zarr_file, force_reload=True, reload_segmentation_data=True)
                    # Clear the force reload flag after successful reload
                    if force_reload_centroids:
                        self._force_reload_centroids = False
                
                # Reset the reload flag after successful reload
                self._needs_reload = False
            except Exception as e:
                print(f"[ERROR] SegmentationHandler - Failed to reload data: {e}")
                # Don't reset the flag if reload failed, so it will try again next time
        
        # return points
        if self.centroids is None or self.contours is None:
            print(f"[Warning] get_centroids_in_viewport => Missing required data - centroids: {self.centroids is not None}, contours: {self.contours is not None}")
            print(f"[Warning] get_centroids_in_viewport => zarr_file: {self.zarr_file}")

            # Try to reload data if file exists but data is missing
            if self.zarr_file and os.path.exists(self.zarr_file):
                print(f"[Warning] get_centroids_in_viewport => Attempting to reload data from {self.zarr_file}")
                try:
                    # Only reload segmentation data if it's missing
                    self.load_file(self.zarr_file, force_reload=True, reload_segmentation_data=True)

                    # Check again after reload
                    if self.centroids is None or self.contours is None:
                        print(f"[ERROR] get_centroids_in_viewport => Data still missing after reload")
                        return [], {}
                except Exception as e:
                    print(f"[ERROR] get_centroids_in_viewport => Failed to reload data: {e}")
                    return [], {}
            else:
                print(f"[Warning] get_centroids_in_viewport => No valid zarr_file to reload from")
                return [], {}
        
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        width = x2 - x1
        height = y2 - y1
        diagonal = math.sqrt(width ** 2 + height ** 2)
        radius = diagonal / 2 + self.BUFFER
        
        # One snapshot each, used for the whole query. A reload swaps these
        # attributes in place, so reading them twice can index the indices of one
        # array into another — or into None, once release_zarr has cleared it.
        centroids = self.centroids
        class_id = self.class_id
        indices_in_view = self.indices_in_viewport(x1, y1, x2, y2, centroids=centroids)

        # Vectorized processing for better performance
        if len(indices_in_view) == 0:
            # Return empty numpy array with correct shape for consistency
            points = np.empty((0, 4), dtype=np.int32)
        else:
            # Convert indices_in_view to numpy array for vectorized indexing
            indices_array = np.asarray(indices_in_view)
            
            # Vectorized coordinate extraction
            scaled_coords = centroids[indices_array]
            
            # Vectorized class_id extraction
            if class_id is not None:
                # Create a mask for valid indices
                valid_mask = indices_array < len(class_id)
                # Initialize with -1 (unclassified)
                effective_class_ids = np.full(len(indices_array), -1, dtype=np.int32)
                # Fill valid indices with actual class_id values
                effective_class_ids[valid_mask] = class_id[indices_array[valid_mask]].astype(np.int32)
            else:
                effective_class_ids = np.full(len(indices_array), -1, dtype=np.int32)
            
            # [index, x, y, class_id] as int32 — what they already are on disk
            # and what the wire format sends. Building this as float64 cost twice
            # the memory (40 MB on a 1.25M-cell slide) and made the packer convert
            # it all back on the way out.
            points = np.empty((len(indices_array), 4), dtype=np.int32)
            points[:, 0] = indices_array
            points[:, 1] = scaled_coords[:, 0]
            points[:, 2] = scaled_coords[:, 1]
            points[:, 3] = effective_class_ids
                
        counts = self.get_all_nuclei_counts()

        # Ensure counts is not None and has the expected structure
        if counts is None:
            counts = {'class_counts_by_id': {}, 'dynamic_class_names': []}

        # Add color information to the response
        # Priority: user_annotation.attrs['class_colors'] (user's manual annotations) > self.class_hex_color (from ClassificationNode)
        result = counts.copy()
        
        # Get class names and colors
        class_names_out = None
        class_colors_out = None
        
        # Try to get colors from user_annotation.attrs first (most up-to-date)
        try:
            if self.zarr_file and os.path.exists(self.zarr_file):
                if self._zarr_file_obj is not None:
                    zarr_file = self._zarr_file_obj
                else:
                    zarr_file = open_zarr(self.zarr_file, 'r')
                    self._zarr_file_obj = zarr_file
                
                if 'User-Annotations' in zarr_file:
                    user_anno_names, user_anno_colors = read_user_anno_class_palette(
                        zarr_file['User-Annotations'], 'cell',
                    )
                    if user_anno_names and len(user_anno_names) == len(user_anno_colors):
                        class_names_out = [str(name) for name in user_anno_names]
                        class_colors_out = [str(color) for color in user_anno_colors]
        except Exception as e:
            # Failed to read user annotation colors; will fall back to default colors.
            logger.warning(f"Could not read user annotation colors from Zarr file: {e}")
        
        # Fallback to self.class_hex_color if user_annotation doesn't have colors
        if class_names_out is None or class_colors_out is None:
            if self.class_name is not None and self.class_hex_color is not None:
                class_names_out = self.class_name.tolist() if hasattr(self.class_name, 'tolist') else list(self.class_name)
                class_colors_out = self.class_hex_color.tolist() if hasattr(self.class_hex_color, 'tolist') else list(self.class_hex_color)
        
        # Always include class_names and class_colors in result if available
        if class_names_out is not None and class_colors_out is not None:
            result['class_names'] = class_names_out
            result['class_colors'] = class_colors_out
        
        return points, result

    def get_region_probability_histogram(self, x1, y1, x2, y2, class_idx):
        """
        Get all probability values for cells in bbox that are predicted as class_idx.
        Expects (x1, y1, x2, y2) in real pixel coordinates (level0).
        Returns probs: list of floats (one per cell), indices: list of int (centroid index per cell).
        """
        if self.centroids is None or len(self.centroids) == 0:
            logger.debug("[get_region_probability_histogram] No centroids")
            return {"probs": [], "indices": []}
        centroids_x = self.centroids[:, 0]
        centroids_y = self.centroids[:, 1]
        in_bbox_mask = (
            (x1 <= centroids_x) & (centroids_x <= x2) &
            (y1 <= centroids_y) & (centroids_y <= y2)
        )
        indices_in_region = np.where(in_bbox_mask)[0]
        if len(indices_in_region) == 0:
            logger.debug("[get_region_probability_histogram] No cells in bbox (x1=%s y1=%s x2=%s y2=%s)", x1, y1, x2, y2)
            return {"probs": [], "indices": []}
        if not self.zarr_file or not os.path.exists(self.zarr_file):
            return {"probs": [], "indices": []}
        try:
            with open_zarr_cm(self.zarr_file, "r") as zf:
                probabilities = None
                classification_group = zf.get(ZarrGroups.CELL_CLASSIFICATION)
                if classification_group is not None and ZarrDatasets.PROBABILITIES in classification_group:
                    probabilities = classification_group[ZarrDatasets.PROBABILITIES][:]
                if probabilities is None:
                    seg_group = find_segmentation_group(zf)
                    if seg_group is not None and ZarrDatasets.PROBABILITIES in seg_group:
                        probabilities = seg_group[ZarrDatasets.PROBABILITIES][:]
                if probabilities is None:
                    logger.debug("[get_region_probability_histogram] No probability dataset in ClassificationNode or seg group")
                    return {"probs": [], "indices": []}
                probabilities = np.asarray(probabilities)
                n_cells = probabilities.shape[0] if probabilities.ndim >= 1 else 0
                if n_cells == 0:
                    return {"probs": [], "indices": []}
                # Restrict to indices that exist in the probability array (in case len(probabilities) != len(centroids))
                valid_mask = indices_in_region < n_cells
                indices_valid = indices_in_region[valid_mask]
                if len(indices_valid) == 0:
                    logger.debug("[get_region_probability_histogram] No valid indices (n_cells=%s, max_idx=%s)", n_cells, int(np.max(indices_in_region)) if len(indices_in_region) > 0 else -1)
                    return {"probs": [], "indices": []}
                # Need ClassificationNode and class IDs for both single-class and all-classes (same logic)
                if classification_group is None:
                    return {"probs": [], "indices": []}
                classifications = None
                if ZarrDatasets.CLASS_INDICES in classification_group:
                    classifications = np.array(classification_group[ZarrDatasets.CLASS_INDICES][:])
                if classifications is None:
                    return {"probs": [], "indices": []}
                class_in_region = classifications[indices_valid]
                # class_idx == -1: all classes — same logic as single-class but for every class, then merge
                if class_idx == -1:
                    n_classes = probabilities.shape[1] if probabilities.ndim >= 2 else (int(np.max(classifications)) + 1 if len(classifications) > 0 else 0)
                    all_probs = []
                    all_indices = []
                    for c in range(n_classes):
                        mask = class_in_region == c
                        if not np.any(mask):
                            continue
                        if probabilities.ndim == 2:
                            probs_c = probabilities[indices_valid, c][mask]
                        else:
                            probs_c = probabilities[indices_valid][mask]
                        probs_c = np.clip(probs_c.astype(np.float64), 0.0, 1.0)
                        indices_c = indices_valid[mask]
                        all_probs.append(probs_c)
                        all_indices.append(indices_c)
                    if len(all_probs) == 0:
                        return {"probs": [], "indices": []}
                    probs = np.concatenate(all_probs)
                    indices_matched = np.concatenate(all_indices)
                    return {"probs": probs.tolist(), "indices": indices_matched.tolist()}
                # Single-class path
                mask = class_in_region == class_idx
                if not np.any(mask):
                    return {"probs": [], "indices": []}
                if probabilities.ndim == 2:
                    probs = probabilities[indices_valid, class_idx][mask]
                else:
                    probs = probabilities[indices_valid][mask]
                probs = np.clip(probs.astype(np.float64), 0.0, 1.0)
                indices_matched = indices_valid[mask]
                return {"probs": probs.tolist(), "indices": indices_matched.tolist()}
        except Exception as e:
            logger.warning(f"[get_region_probability_histogram] Error: {e}")
            return {"probs": [], "indices": []}

    def get_centroids_in_viewport_matrix(self, x1, y1, x2, y2, params):
        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        width = x2 - x1
        height = y2 - y1
        diagonal = math.sqrt(width ** 2 + height ** 2)
        radius = diagonal / 2 + self.BUFFER

        indices_in_view = self.indices_in_viewport(x1, y1, x2, y2)
        if len(indices_in_view) == 0:
            return []

        # Obtain points to be transformed (in image coordinates)
        points = self.centroids[indices_in_view].astype(float)

        zoom = params.get("zoom")
        contentBounds = params.get("contentBounds")
        contentSize = params.get("contentSize")
        container_size = params["containerSize"]
        bounds = params["bounds"]
        margins = params["margins"]

        # Construct the affine transformation matrix (image -> viewport -> viewer)
        # image -> viewport
        # viewport_x = (image_x / contentSize['x']) * contentBounds['width'] + contentBounds['x']
        # viewport_y = (image_y / contentSize['x']) * contentBounds['width'] + contentBounds['y']
        s = contentBounds['width'] / contentSize['x']
        M_image_to_viewport = np.array([
            [s,   0, contentBounds['x']],
            [0,   s, contentBounds['y']],
            [0,   0, 1]
        ], dtype=np.float64)

        # viewport -> viewer
        # scale = container_size["width"] / bounds["width"]
        scale = container_size["width"] / bounds["width"]
        # viewer_x = (viewport_x - bounds['x']) * scale + margins['left']
        # viewer_y = (viewport_y - bounds['y']) * scale + margins['top']
        M_viewport_to_viewer = np.array([
            [scale,     0, (-bounds['x'])*scale + margins['left']],
            [0,     scale, (-bounds['y'])*scale + margins['top']],
            [0,         0, 1]
        ], dtype=np.float64)

        # Merge matrices
        M = M_viewport_to_viewer @ M_image_to_viewport

        # Transform points using NumPy matrix operations
        pixel_points = transform_points_numpy(points, M)
        return pixel_points.tolist()

    def imageToViewportCoordinates(self, image_x, image_y, zoom, contentBounds, contentSize):
        """
        Converts image coordinates to viewport coordinates.

        Args:
            image_x (float): X coordinate in image space.
            image_y (float): Y coordinate in image space.
            zoom (float): The current zoom level.
            contentBounds (dict): contentBounds
            contentSize (dict): contentSize

        Returns:
            list[float, float]: viewport coordinates [x, y].
        """
        # Calculate scale factor
        scale = contentBounds['width']
        delta_x = image_x / contentSize['x'] * scale
        delta_y = image_y / contentSize['x'] * scale

        # Adjust with content bounds
        viewport_x = delta_x + contentBounds['x']
        viewport_y = delta_y + contentBounds['y']

        return [viewport_x, viewport_y]

    def viewportToViewerElementCoordinates(self, viewport_x, viewport_y, container_size, bounds, margins, rotation_degrees):
        """
        Converts viewport coordinates to viewer element coordinates, applying rotation.

        Args:
            viewport_x (float): X coordinate in viewport space.
            viewport_y (float): Y coordinate in viewport space.
            container_size (dict): Dictionary containing the container's width and height.
            bounds (dict): Dictionary containing the content bounds {x, y, width, height}.
            margins (dict): Dictionary containing margins {left, top}.
            rotation_degrees (float): Rotation angle in degrees.

        Returns:
            list[float, float]: Viewer element coordinates [viewer_x, viewer_y].
        """
        # Calculate the container scale
        scale_x = container_size["width"] / bounds["width"]
        scale_y = container_size["height"] / bounds["height"]

        # Normalize viewport coordinates relative to bounds
        normalized_x = viewport_x - bounds["x"]
        normalized_y = viewport_y - bounds["y"]

        # Apply rotation
        radians = math.radians(rotation_degrees)
        if rotation_degrees in [-90, 90]:  # Handle axis swap for 90-degree rotations
            rotated_x = normalized_y * math.sin(radians) + normalized_x * math.cos(radians)
            rotated_y = normalized_y * math.cos(radians) - normalized_x * math.sin(radians)
        else:
            rotated_x = normalized_x * math.cos(radians) - normalized_y * math.sin(radians)
            rotated_y = normalized_x * math.sin(radians) + normalized_y * math.cos(radians)

        # Scale to viewer element size and add margins
        viewer_x = rotated_x * scale_x + margins["left"]
        viewer_y = rotated_y * scale_y + margins["top"]

        return [viewer_x, viewer_y]

    def get_annotations(self, offset=0, limit=None):
        """
        get normal annotations.
        
        Parameters:
            offset (int): start index
            limit (int, optional): the max number of annotations to return
            
        Returns:
            tuple: (annotations list, total count)
        """

        # Convert parameters to integer type
        try:
            offset = int(offset)
        except (ValueError, TypeError):
            print(f"[Debug] Failed to convert offset, using default value 0")
            offset = 0
            
        if limit is not None:
            try:
                limit = int(limit)
            except (ValueError, TypeError):
                print(f"[Debug] Failed to convert limit, using default value 100")
                limit = 100
        
        annotations = []
        total_count = len(self.centroids) if self.centroids is not None else 0
        
        # check if there is centroids and contours data
        if self.centroids is not None and self.contours is not None:
            # determine the end index
            if limit is None:
                end_idx = len(self.centroids)
            else:
                try:
                    # Make sure limit is an integer
                    limit = int(limit)
                    end_idx = offset + limit
                except (ValueError, TypeError):
                    print(f"[Debug] limit is not a valid number, using default value")
                    end_idx = len(self.centroids)

            # iterate over the specified range of indices
            for idx in range(offset, end_idx):
                if idx >= len(self.centroids):
                    break
                
                # Get contour for this cell
                contour = self.contours[idx]
                
                # Create simplified annotation (no zoom scale, direct from zarr data)
                # Color will be retrieved from ClassificationNode in create_annotation, no default value
                annotation = self.create_annotation(idx, contour)
                if annotation is not None:
                    annotations.append(annotation)


        return annotations, total_count

    def generate_annotations_csv_stream(self, batch_size=5000):
        """
        Generate CSV content for annotations in streaming fashion.
        Yields CSV chunks (batches) to avoid loading all data into memory at once.

        Optimized for 300k+ cells with vectorized operations.

        Parameters:
            batch_size (int): Number of rows to process per batch

        Yields:
            str: CSV content chunks
        """

        # Add metadata as comments (CSV readers will ignore lines starting with #)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        total_count = len(self.centroids) if self.centroids is not None else 0

        yield f"# Cell Classification Overview Export\n"
        yield f"# Generated: {timestamp}\n"
        yield f"# Total Cells in Zarr: {total_count}\n"
        yield f"# Batch Size: {batch_size}\n"

        # Yield CSV header
        yield "ID,Centroid_X,Centroid_Y,MinX,MinY,MaxX,MaxY,Class_ID,Class_Name,Class_Color,Contours\n"

        if total_count == 0 or self.centroids is None or self.contours is None:
            # Empty dataset - only header
            return

        # Escape CSV helper - defined once outside loop
        def escape_csv(value):
            if value == "" or value is None:
                return ""
            str_value = str(value)
            # Only escape if necessary (most values won't need it)
            if "," in str_value or '"' in str_value or "\n" in str_value or ";" in str_value:
                return f'"{str_value.replace(chr(34), chr(34)+chr(34))}"'
            return str_value

        # Pre-decode class name / color lookup tables once. Same pattern the
        # GeoJSON exporter uses (see _build_geojson_feature_json) — these are
        # short arrays indexed by class_id, and bytes from zarr need decoding.
        class_names_cache = None
        class_colors_cache = None
        if self.class_name is not None and self.class_hex_color is not None:
            cache_len = min(len(self.class_name), len(self.class_hex_color))
            if cache_len > 0:
                class_names_cache = [
                    n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n)
                    for n in self.class_name[:cache_len]
                ]
                class_colors_cache = [
                    c.decode('utf-8') if isinstance(c, (bytes, bytearray)) else str(c)
                    for c in self.class_hex_color[:cache_len]
                ]

        # Track statistics for debugging
        total_rows_generated = 0
        total_skipped = 0
        generated_ids = set()  # Track generated IDs to detect duplicates

        # Process data in batches to avoid memory issues
        for batch_start in range(0, total_count, batch_size):
            batch_start_time = time.time()
            batch_end = min(batch_start + batch_size, total_count)

            # Read centroids batch (vectorized, much faster than individual access)
            centroids_batch = self.centroids[batch_start:batch_end]

            # Read contours batch (this is the slowest operation)
            contours_batch = self.contours[batch_start:batch_end]

            batch_rows = []

            # Process each cell in the batch
            for i, idx in enumerate(range(batch_start, batch_end)):
                # CRITICAL: Verify this ID hasn't been generated before
                if idx in generated_ids:
                    print(f"[ERROR] Duplicate ID detected: {idx}. This should never happen!")
                    total_skipped += 1
                    continue
                generated_ids.add(idx)
                try:
                    # Get centroids from batch (already in memory)
                    centroid_x = float(centroids_batch[i][0])
                    centroid_y = float(centroids_batch[i][1])

                    # Get contour from batch
                    contour = contours_batch[i]
                    if not isinstance(contour, np.ndarray):
                        contour = np.array(contour)

                    # Handle legacy (2, K) format
                    if contour.ndim == 2 and contour.shape[0] == 2:
                        contour = contour.T

                    # Calculate bounds and format contours
                    if contour.ndim == 2 and contour.shape[1] == 2 and contour.shape[0] >= 3:
                        # Vectorized bounds calculation (faster)
                        min_x = float(contour[:, 0].min())
                        min_y = float(contour[:, 1].min())
                        max_x = float(contour[:, 0].max())
                        max_y = float(contour[:, 1].max())

                        # Simplified contours format - faster string building
                        # Use numpy array operations where possible
                        contours_str = ";".join(f"{x:.1f},{y:.1f}" for x, y in contour)
                    else:
                        min_x = min_y = max_x = max_y = ""
                        contours_str = ""

                    # Look up classification for this cell. -1 / out-of-range
                    # = "Unclassified" with empty name/color (consistent with
                    # what the GeoJSON exporter emits in the same situation).
                    class_id_str = ""
                    class_name_str = ""
                    class_color_str = ""
                    if self.class_id is not None and 0 <= idx < len(self.class_id):
                        ci = int(self.class_id[idx])
                        if ci >= 0:
                            class_id_str = str(ci)
                            if class_names_cache is not None and ci < len(class_names_cache):
                                class_name_str = class_names_cache[ci]
                                class_color_str = class_colors_cache[ci]

                    # Build CSV row - minimize string operations
                    # Most numeric values don't need escaping
                    row = f"{idx},{centroid_x},{centroid_y},{min_x},{min_y},{max_x},{max_y},{class_id_str},{escape_csv(class_name_str)},{escape_csv(class_color_str)},{escape_csv(contours_str)}"
                    batch_rows.append(row)

                except Exception as e:
                    print(f"[Warning] Error processing cell {idx} for CSV export: {e}")
                    total_skipped += 1
                    continue

            # Yield the batch as CSV rows
            if batch_rows:
                total_rows_generated += len(batch_rows)
                batch_csv = "\n".join(batch_rows) + "\n"
                batch_time = time.time() - batch_start_time
                yield batch_csv

        # Final summary with verification
        unique_ids_count = len(generated_ids)

        if unique_ids_count != total_rows_generated:
            print(f"[WARNING] Unique IDs ({unique_ids_count}) != Generated rows ({total_rows_generated})!")

        if total_rows_generated + total_skipped != total_count:
            print(f"[WARNING] Generated ({total_rows_generated}) + Skipped ({total_skipped}) != Expected ({total_count})!")

    def _hex_to_rgb_triplet(self, hex_color):
        """Convert hex color string to RGB triplet for GeoJSON properties."""
        if not isinstance(hex_color, str):
            return None

        color = hex_color.strip()
        if not color:
            return None

        if color.startswith('#'):
            color = color[1:]

        if len(color) == 3:
            color = ''.join(ch * 2 for ch in color)

        if len(color) != 6:
            return None

        try:
            return [
                int(color[0:2], 16),
                int(color[2:4], 16),
                int(color[4:6], 16),
            ]
        except ValueError:
            return None

    def _build_valid_geojson_ring(self, contour: np.ndarray):
        """Build a valid GeoJSON linear ring; return None for invalid/degenerate shapes."""
        arr = np.asarray(contour)
        if arr.ndim != 2 or arr.shape[1] != 2:
            return None

        # Fast path for integer contours from segmentation outputs.
        if arr.dtype.kind in ('i', 'u'):
            arr = arr.astype(np.int32, copy=False)
        else:
            arr = arr.astype(np.float32, copy=False)

        # This runs once per cell on a few dozen points, so each numpy call
        # costs more than the arithmetic it does: ask a scalar question first
        # and only build a mask when the answer says there is work.

        # Drop non-finite coordinates only for floating-point contours.
        if arr.dtype.kind == 'f' and not np.isfinite(arr).all():
            arr = arr[np.isfinite(arr).all(axis=1)]
            if arr.shape[0] < 3:
                return None

        # Remove consecutive duplicate points.
        if arr.shape[0] > 1:
            differs = (arr[1:] != arr[:-1]).any(axis=1)
            if not differs.all():
                keep = np.ones(arr.shape[0], dtype=bool)
                keep[1:] = differs
                arr = arr[keep]
        if arr.shape[0] < 3:
            return None

        # Close ring.
        if arr[0, 0] != arr[-1, 0] or arr[0, 1] != arr[-1, 1]:
            arr = np.vstack((arr, arr[:1]))

        open_arr = arr[:-1]
        if open_arr.shape[0] < 3:
            return None

        open_pts = np.ascontiguousarray(open_arr.reshape((-1, 1, 2)), dtype=np.float32)

        try:
            area = abs(float(cv2.contourArea(open_pts)))
        except Exception:
            return None
        if area <= 1e-6:
            return None

        # Only fall back to a hull when the ring is not already convex; that
        # avoids the expensive custom intersection logic.
        try:
            is_convex = cv2.isContourConvex(open_pts)
        except Exception:
            is_convex = True

        if not is_convex:
            hull_points = self._ring_convex_hull(arr[:-1])
            if hull_points is None:
                return None
            return hull_points

        return arr

    def _ring_convex_hull(self, points):
        """Return a closed convex-hull ring from an open point list."""
        pts_open = np.asarray(points)
        if pts_open.ndim != 2 or pts_open.shape[1] != 2 or pts_open.shape[0] < 3:
            return None

        if pts_open.dtype.kind in ('i', 'u'):
            pts_open = pts_open.astype(np.int32, copy=False)
        else:
            pts_open = pts_open.astype(np.float32, copy=False)

        pts = np.ascontiguousarray(pts_open.reshape((-1, 1, 2)))
        try:
            hull = cv2.convexHull(pts, returnPoints=True)
        except Exception:
            return None
        if hull is None:
            return None

        ring = hull[:, 0, :]
        if ring.shape[0] < 3:
            return None
        if not np.array_equal(ring[0], ring[-1]):
            ring = np.vstack((ring, ring[0]))

        ring_open = np.ascontiguousarray(ring[:-1].reshape((-1, 1, 2)), dtype=np.float32)
        if ring_open.shape[0] < 3:
            return None
        if abs(float(cv2.contourArea(ring_open))) <= 1e-6:
            return None

        return ring

    def _build_geojson_feature_json(
        self,
        idx: int,
        contour,
        centroid,
        class_names_cache,
        class_colors_cache,
        class_rgbs_cache,
    ):
        """Build one GeoJSON feature and return compact JSON string; return None if invalid."""
        try:
            if not isinstance(contour, np.ndarray):
                contour = np.array(contour)

            if contour.ndim == 2 and contour.shape[0] == 2:
                contour = contour.T

            if not (contour.ndim == 2 and contour.shape[1] == 2 and contour.shape[0] >= 3):
                return None

            ring = self._build_valid_geojson_ring(contour)
            if ring is None:
                return None

            # Keep ring dtype consistent with source contour dtype.
            if contour.dtype.kind in ('i', 'u'):
                ring = np.rint(ring).astype(np.int32, copy=False)
            else:
                ring = ring.astype(np.float32, copy=False)

            # centroid_x = float(centroid[0])
            # centroid_y = float(centroid[1])

            class_id_val = None
            class_name_val = "N/A"
            class_color_val = None
            classification_rgb = None

            if self.class_id is not None and 0 <= idx < len(self.class_id):
                assigned_class_id_val = self.class_id[idx]
                if assigned_class_id_val >= 0:
                    class_id_val = int(assigned_class_id_val)
                    if class_names_cache is not None and class_id_val < len(class_names_cache):
                        class_name_val = class_names_cache[class_id_val]
                        class_color_val = class_colors_cache[class_id_val]
                        classification_rgb = class_rgbs_cache[class_id_val]

            classification_name = class_name_val if class_name_val and class_name_val != "N/A" else "Unclassified"
            if classification_name != "Unclassified" and not classification_name.startswith("TL_"):
                classification_name = f"TL_{classification_name}"

            feature = {
                "type": "Feature",
                "id": str(idx),
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [ring],
                },
                "properties": {
                    "objectType": "annotation",
                    "classification": {
                        "name": classification_name,
                        "color": classification_rgb,
                    },
                },
            }

            return orjson.dumps(feature, option=orjson.OPT_SERIALIZE_NUMPY)
        except Exception as e:
            print(f"[GeoJSON Export] Skipping cell {idx} due to error: {e}")
            return None

    def generate_annotations_geojson_stream(self, batch_size=31523):
        """Generate a GeoJSON FeatureCollection stream for nuclei segmentation/classification.

        The properties include QuPath-friendly classification fields:
        - properties.classification.name
        - properties.classification.color (RGB array)
        """
        total_count = len(self.centroids) if self.centroids is not None else 0

        yield b'{"type":"FeatureCollection","features":['

        if total_count == 0 or self.centroids is None or self.contours is None:
            yield b']}'
            return

        class_names_cache = None
        class_colors_cache = None
        class_rgbs_cache = None
        if self.class_name is not None and self.class_hex_color is not None:
            cache_len = min(len(self.class_name), len(self.class_hex_color))
            if cache_len > 0:
                class_names_cache = [
                    n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n)
                    for n in self.class_name[:cache_len]
                ]
                class_colors_cache = [
                    c.decode('utf-8') if isinstance(c, (bytes, bytearray)) else str(c)
                    for c in self.class_hex_color[:cache_len]
                ]
                class_rgbs_cache = [self._hex_to_rgb_triplet(c) for c in class_colors_cache]

        use_parallel = total_count >= 2000
        first_feature = True

        executor = self._get_geojson_export_executor() if use_parallel else None

        for batch_start in range(0, total_count, batch_size):
            batch_end = min(batch_start + batch_size, total_count)
            centroids_batch = self.centroids[batch_start:batch_end]
            contours_batch = self.contours[batch_start:batch_end]

            if executor is not None:
                batch_len = batch_end - batch_start
                block_size = max(64, min(512, batch_len // 16 if batch_len > 0 else 128))

                def _process_block(block_start):
                    block_end = min(block_start + block_size, batch_len)
                    out = []
                    for offset in range(block_start, block_end):
                        idx = batch_start + offset
                        feature_json = self._build_geojson_feature_json(
                            idx=idx,
                            contour=contours_batch[offset],
                            centroid=centroids_batch[offset],
                            class_names_cache=class_names_cache,
                            class_colors_cache=class_colors_cache,
                            class_rgbs_cache=class_rgbs_cache,
                        )
                        if feature_json is not None:
                            out.append(feature_json)
                    return out

                try:
                    iterator = executor.map(_process_block, range(0, batch_len, block_size), chunksize=1)
                except RuntimeError:
                    # If a stale executor was shut down unexpectedly, recreate once.
                    self._geojson_export_executor = None
                    executor = self._get_geojson_export_executor()
                    iterator = executor.map(_process_block, range(0, batch_len, block_size), chunksize=1)

                for block_features in iterator:
                    if not block_features:
                        continue
                    block_chunk = b','.join(block_features)
                    if first_feature:
                        yield block_chunk
                        first_feature = False
                    else:
                        yield b',' + block_chunk
            else:
                serial_block = []
                serial_block_limit = 256
                for i, idx in enumerate(range(batch_start, batch_end)):
                    feature_json = self._build_geojson_feature_json(
                        idx=idx,
                        contour=contours_batch[i],
                        centroid=centroids_batch[i],
                        class_names_cache=class_names_cache,
                        class_colors_cache=class_colors_cache,
                        class_rgbs_cache=class_rgbs_cache,
                    )
                    if feature_json is None:
                        continue
                    serial_block.append(feature_json)
                    if len(serial_block) >= serial_block_limit:
                        serial_chunk = b','.join(serial_block)
                        if first_feature:
                            yield serial_chunk
                            first_feature = False
                        else:
                            yield b',' + serial_chunk
                        serial_block = []

                if serial_block:
                    serial_chunk = b','.join(serial_block)
                    if first_feature:
                        yield serial_chunk
                        first_feature = False
                    else:
                        yield b',' + serial_chunk

        yield b']}'

    # ------------------------------------------------------------------
    # User-annotation export (CSV + GeoJSON)
    #
    # User-drawn region annotations live under `User-Annotations/`. There
    # are two subarrays — `/cell` and `/patch` — both with the same
    # structured dtype (class, color, region_x1/y1/x2/y2, ...). The FE
    # writes per-cell reclassifications into `/cell` and per-patch
    # painting into `/patch`. Each subarray has its own palette resolved
    # via `read_user_anno_class_palette(group, kind)` (v3 prefixed keys
    # on parent → v2 subarray attrs → v1 bare parent keys).
    #
    # Only rows with `class >= 0` and a real region rectangle (not the
    # writer's all-`-1` sentinel) are exported.
    # ------------------------------------------------------------------

    def _collect_user_annotated_subarray(
        self, subarray, class_names, class_colors, source_label,
        include_regionless=False, root=None,
    ):
        """Walk one User-Annotations subarray (`cell` or `patch`) and yield
        valid (idx, source, x1, y1, x2, y2, class_name, class_hex_color,
        method, annotator, datetime) tuples — the same per-region fields the
        classifier `.tlcls` embeds. Vectorizes the `class >= 0` check the same
        way the Active Learning loader (services/review.py) does — important
        when the subarray has 100k+ rows.

        `include_regionless=True` keeps rows whose region is the
        (-1,-1,-1,-1) sentinel. Patch annotations are identified by patch
        index rather than a drawn pixel rectangle, so they always carry that
        sentinel — exporters that don't need a bbox (CSV) pass True to include
        them; geometry exporters (GeoJSON) leave it False."""
        # zarr v3 cannot index a structured Array by field name; a structured
        # dtype is stored as whole records per chunk, so read records once and
        # select fields with numpy.
        try:
            records = subarray[:]
            classes = records['class']
        except Exception:
            return
        # Positives (class >= 0) and negative/exclude marks (class <= -2). A
        # negative encodes the EXCLUDED class as -(2 + k); class == -1 is an
        # empty placeholder and is skipped.
        valid_idx = np.where((classes >= 0) | (classes <= -2))[0]
        if valid_idx.size == 0:
            return
        valid_classes = classes[valid_idx]
        # Per-region metadata — older stores may lack these fields, so default
        # to blanks rather than crash the whole export.
        fields = set(getattr(subarray.dtype, 'names', None) or ())
        methods = records['method'][valid_idx] if 'method' in fields else None
        annotators = records['annotator'][valid_idx] if 'annotator' in fields else None
        datetimes = records['datetime'][valid_idx] if 'datetime' in fields else None
        # Drawn selection geometry (rectangle/polygon vertices) lives on the
        # User-Annotations GROUP attrs, keyed by the save's datetime. All rows
        # from one selection share that datetime, so each row joins to its shape.
        try:
            geom_map = {}
            if root is not None and 'User-Annotations' in root:
                geom_map = dict(
                    root['User-Annotations'].attrs.get(
                        f'{source_label}_selection_geometry', {}) or {})
        except Exception:
            geom_map = {}
        # Fallback geometry for annotations with no drawn selection (single
        # click / Review-Panel confirm): the object's own outline — a cell's
        # segmented nucleus contour (Cell-Segmentation/contours[idx]) or a
        # patch's grid bbox (Patch-Segmentation/coordinates[idx]).
        contours = patch_coords = None
        if root is not None:
            try:
                if source_label == 'cell' and 'Cell-Segmentation/contours' in root:
                    contours = root['Cell-Segmentation/contours']
                elif source_label == 'patch' and 'Patch-Segmentation/coordinates' in root:
                    patch_coords = root['Patch-Segmentation/coordinates']
            except Exception:
                contours = patch_coords = None

        for i in range(valid_idx.size):
            idx = int(valid_idx[i])
            ci = int(valid_classes[i])
            # Resolve the class palette index: positives index directly; a
            # negative/exclude mark -(2+k) refers to the EXCLUDED class k (the
            # Method column says 'negative selection' so the two are distinct).
            palette_i = ci if ci >= 0 else (-ci - 2)
            # Same-index sanity: skip rather than invent if attrs and per-row
            # class index are out of sync with each other.
            if not (0 <= palette_i < len(class_names)) or not (0 <= palette_i < len(class_colors)):
                continue
            # Positives show the class; negatives show "Not <class>" so a reader
            # of just the Class_Name column isn't misled (Method also says
            # 'negative selection'). Negatives are gray, like in the store/UI.
            if ci >= 0:
                class_name = class_names[palette_i]
                class_color = class_colors[palette_i]
            else:
                class_name = f"Not {class_names[palette_i]}"
                class_color = "#aaaaaa"
            method = str(methods[i]) if methods is not None else ""
            annotator = str(annotators[i]) if annotators is not None else ""
            dt = int(datetimes[i]) if datetimes is not None else ""
            # Resolve the shape: drawn selection by datetime, else the object's
            # own contour/coords. The per-row bbox field was removed from the
            # store, so x1..y2 below are derived from these vertices.
            vertices = None
            if dt != "" and geom_map:
                entry = geom_map.get(str(dt))
                if entry:
                    vertices = entry.get('vertices')
            if vertices is None and contours is not None:
                try:
                    arr = np.asarray(contours[idx])
                    # Legacy contours are stored (2, K); normalize to (K, 2).
                    if arr.ndim == 2 and arr.shape[0] == 2 and arr.shape[1] != 2:
                        arr = arr.T
                    if arr.ndim == 2 and arr.shape[1] == 2 and arr.shape[0] >= 3:
                        vertices = arr.tolist()
                except Exception:
                    pass
            elif vertices is None and patch_coords is not None:
                try:
                    px1, py1, px2, py2 = (float(v) for v in patch_coords[idx][:4])
                    vertices = [[px1, py1], [px2, py1], [px2, py2], [px1, py2]]
                except Exception:
                    pass
            # bbox derived from the resolved vertices (no stored region field).
            if vertices:
                xs = [float(p[0]) for p in vertices]
                ys = [float(p[1]) for p in vertices]
                x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
            else:
                # No geometry resolved at all — skip unless the caller wants
                # every annotated row regardless (then emit a -1 sentinel bbox).
                if not include_regionless:
                    continue
                x1 = y1 = x2 = y2 = -1.0
            yield (idx, source_label, x1, y1, x2, y2, class_name,
                   class_color, method, annotator, dt, vertices)

    def _collect_user_annotated_regions(self, include_regionless=False):
        """Return a list of (idx, source, x1, y1, x2, y2, class_name,
        class_hex_color, method, annotator, datetime) tuples covering both
        `/cell` and `/patch` subarrays.

        `source` is `'cell'` or `'patch'` so consumers can distinguish — the
        two subarrays index independently (a `cell` row 0 and a `patch` row 0
        are different annotations). `include_regionless` is forwarded to the
        subarray walker (see its docstring)."""
        out = []
        file_path = self.get_current_file_path()
        if not file_path:
            return out
        import zarr
        zf = open_zarr(file_path, mode='r')
        if 'User-Annotations' not in zf:
            return out
        group = zf['User-Annotations']

        for subname in ('cell', 'patch'):
            if subname not in group:
                continue
            names, colors = read_user_anno_class_palette(group, subname)
            out.extend(self._collect_user_annotated_subarray(
                group[subname], names, colors, subname,
                include_regionless=include_regionless, root=zf))
        return out

    def _collect_user_annotation_save_events(self):
        """Return one record per SAVE EVENT — i.e. one record per region the
        user painted with one class — instead of per affected cell/patch row.

        Same shape as the `.tlcls` `user_annotations` embed: each entry has
        `class` / `color` (int RGB) / `datetime` / `method` / `annotator` /
        `image_name` / `vertices` / `source` ('cell' or 'patch') /
        `class_name` / `class_color_hex` (added for human-readable export).

        A single save can affect tens of thousands of cell rows; this view
        collapses all of those back to the one region the user drew, which
        is what most downstream consumers actually want."""
        out = []
        file_path = self.get_current_file_path()
        if not file_path:
            return out
        import zarr
        zf = open_zarr(file_path, mode='r')
        if 'User-Annotations' not in zf:
            return out
        group = zf['User-Annotations']
        image_name = os.path.basename(file_path.rstrip('/').rstrip('\\'))

        for subname in ('cell', 'patch'):
            if subname not in group:
                continue
            sub = group[subname]
            names, colors = read_user_anno_class_palette(group, subname)
            # Save-event vertices: {str(datetime): {method, annotator, vertices}}
            geom_map = dict(group.attrs.get(f'{subname}_selection_geometry', {}) or {})
            if not geom_map:
                # Older saves don't have selection_geometry. Skip cleanly —
                # the per-row collector still serves those if the caller wants
                # the verbose view.
                continue

            fields = set(getattr(sub.dtype, 'names', None) or ())
            if not {'class', 'datetime'}.issubset(fields):
                continue
            sub_records = sub[:]
            # Copy the two int columns out and drop the records — a field view
            # would pin the whole array for the rest of the call (see
            # _load_annotations_array on why the record is so much bigger than
            # the columns anyone reads).
            classes_arr = np.asarray(sub_records['class'])
            datetimes_arr = np.asarray(sub_records['datetime'])
            del sub_records
            # First-seen row index per datetime. np.unique's return_index is
            # exactly "first occurrence", so this is the vectorised form of the
            # dict-insert-on-miss scan — which walked every annotated row in
            # Python on a path the annotation sidebar hits on every refresh.
            nonzero = np.flatnonzero(datetimes_arr)
            if nonzero.size:
                uniq_dts, first_pos = np.unique(datetimes_arr[nonzero], return_index=True)
                first_idx_by_dt = dict(zip(uniq_dts.tolist(), nonzero[first_pos].tolist()))
            else:
                first_idx_by_dt = {}

            for dt_str, info in geom_map.items():
                try:
                    dt = int(dt_str)
                except (TypeError, ValueError):
                    continue
                row_idx = first_idx_by_dt.get(dt)
                if row_idx is None:
                    # Geometry recorded but no row references it — orphan
                    # save event. Still useful (the region the user drew is
                    # known) but we can't recover the class without a row.
                    continue
                ci = int(classes_arr[row_idx])
                # ci >= 0 → direct palette index; ci <= -2 → "Not <class_k>"
                # where k = -(ci) - 2 (the "negative selection" sentinel).
                palette_i = ci if ci >= 0 else (-ci - 2)
                if not (0 <= palette_i < len(names)) or not (0 <= palette_i < len(colors)):
                    continue
                if ci >= 0:
                    class_name = names[palette_i]
                    class_color_hex = colors[palette_i]
                else:
                    class_name = f"Not {names[palette_i]}"
                    class_color_hex = '#aaaaaa'
                # Encode hex → 0xRRGGBB int to match .tlcls `color` field.
                try:
                    color_int = int(class_color_hex.lstrip('#'), 16)
                except ValueError:
                    color_int = 0
                out.append({
                    'source': subname,
                    'class': ci,
                    'class_name': class_name,
                    'color': color_int,
                    'class_color_hex': class_color_hex,
                    'datetime': dt,
                    'method': info.get('method', ''),
                    'annotator': info.get('annotator', ''),
                    'image_name': image_name,
                    'vertices': info.get('vertices') or [],
                })

        # Stable order: by datetime ascending so re-runs produce the same file
        out.sort(key=lambda r: (r['datetime'], r['source']))
        return out

    def generate_user_annotations_csv_stream(self, batch_size=5000):
        """Stream user annotations as CSV — one row per SAVE EVENT (one region
        the user drew with one class). Mirrors the `.tlcls` `user_annotations`
        embed: instead of expanding to all affected cell rows, each save shows
        up exactly once. Both `cell` and `patch` save events land in the same
        stream, distinguished by the `Source` column."""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        events = self._collect_user_annotation_save_events()

        yield f"# User Annotations Export\n"
        yield f"# Generated: {timestamp}\n"
        yield f"# Save events: {len(events)}\n"
        yield "Source,Class_ID,Class_Name,Class_Color,Color_Int,Method,Annotator,Datetime,Image_Name,Vertices\n"

        def escape_csv(value):
            if value is None or value == "":
                return ""
            s = str(value)
            if any(ch in s for ch in (",", '"', "\n", ";")):
                return '"' + s.replace('"', '""') + '"'
            return s

        for batch_start in range(0, len(events), batch_size):
            batch = events[batch_start:batch_start + batch_size]
            rows = []
            for ev in batch:
                vertices_json = json.dumps(ev['vertices']) if ev['vertices'] else ""
                rows.append(
                    f"{ev['source']},{ev['class']},"
                    f"{escape_csv(ev['class_name'])},{escape_csv(ev['class_color_hex'])},{ev['color']},"
                    f"{escape_csv(ev['method'])},{escape_csv(ev['annotator'])},{ev['datetime']},"
                    f"{escape_csv(ev['image_name'])},{escape_csv(vertices_json)}\n"
                )
            if rows:
                yield "".join(rows)

    def generate_user_annotations_geojson_stream(self, batch_size=5000):
        """Stream user annotations as GeoJSON — one Feature per SAVE EVENT.

        Each feature's `geometry` is the polygon the user actually drew
        (rectangle = 4 corners + closing point; polygon = its vertices).
        `properties.classification` is QuPath-compatible (name + RGB
        triplet). `properties.source` is `'cell'` or `'patch'`."""
        events = self._collect_user_annotation_save_events()

        yield b'{"type":"FeatureCollection","features":['

        first_feature = True
        for batch_start in range(0, len(events), batch_size):
            batch = events[batch_start:batch_start + batch_size]
            chunks = []
            for ev in batch:
                vertices = ev['vertices']
                if not vertices or len(vertices) < 3:
                    continue
                ring = [[float(p[0]), float(p[1])] for p in vertices]
                if ring[0] != ring[-1]:
                    ring.append(ring[0])
                # Feature id is `<source>:<datetime>` — unique per save event;
                # `cell` and `patch` saves with the same datetime stay distinct.
                feature = {
                    "type": "Feature",
                    "id": f"{ev['source']}:{ev['datetime']}",
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                    "properties": {
                        "objectType": "annotation",
                        "source": ev['source'],
                        "method": ev['method'],
                        "annotator": ev['annotator'],
                        "datetime": ev['datetime'],
                        "image_name": ev['image_name'],
                        "classification": {
                            "name": ev['class_name'],
                            "color": self._hex_to_rgb_triplet(ev['class_color_hex']),
                        },
                    },
                }
                chunks.append(orjson.dumps(feature, option=orjson.OPT_SERIALIZE_NUMPY))
            if chunks:
                joined = b",".join(chunks)
                if first_feature:
                    yield joined
                    first_feature = False
                else:
                    yield b"," + joined

        yield b']}'

    def _patch_classification_palette(self):
        """Decoded (names, colors) lists for patch classes, indexed by class id."""
        names = [
            n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n)
            for n in (self.patch_class_name if self.patch_class_name is not None else [])
        ]
        colors = [
            c.decode('utf-8') if isinstance(c, (bytes, bytearray)) else str(c)
            for c in (self.patch_class_hex_color if self.patch_class_hex_color is not None else [])
        ]
        return names, colors

    def generate_patch_classification_csv_stream(self, batch_size=5000):
        """Stream per-patch AI classification results as CSV — one row per
        classified patch (the patch counterpart of the cell-classification
        overview export)."""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        coords = self.patch_coordinates
        class_ids = self.patch_class_id
        total = len(coords) if coords is not None else 0

        yield f"# Patch Classification Overview Export\n"
        yield f"# Generated: {timestamp}\n"
        yield f"# Total Patches: {total}\n"
        yield "ID,X1,Y1,X2,Y2,Class_ID,Class_Name,Class_Color\n"
        if total == 0 or class_ids is None:
            return
        names, colors = self._patch_classification_palette()

        def escape_csv(value):
            if value is None or value == "":
                return ""
            s = str(value)
            if any(ch in s for ch in (",", '"', "\n", ";")):
                return '"' + s.replace('"', '""') + '"'
            return s

        for start in range(0, total, batch_size):
            rows = []
            for i in range(start, min(start + batch_size, total)):
                cid = int(class_ids[i])
                if cid < 0:
                    continue  # unclassified patch
                try:
                    x1, y1, x2, y2 = (int(v) for v in coords[i][:4])
                except Exception:
                    continue
                nm = names[cid] if 0 <= cid < len(names) else ""
                cl = colors[cid] if 0 <= cid < len(colors) else ""
                rows.append(f"{i},{x1},{y1},{x2},{y2},{cid},{escape_csv(nm)},{escape_csv(cl)}\n")
            if rows:
                yield "".join(rows)

    def generate_patch_classification_geojson_stream(self, batch_size=5000):
        """Stream per-patch AI classification results as GeoJSON — one
        rectangle feature per classified patch (from its grid bbox)."""
        coords = self.patch_coordinates
        class_ids = self.patch_class_id
        total = len(coords) if coords is not None else 0

        yield b'{"type":"FeatureCollection","features":['
        if total == 0 or class_ids is None:
            yield b']}'
            return
        names, colors = self._patch_classification_palette()

        first_feature = True
        for start in range(0, total, batch_size):
            chunks = []
            for i in range(start, min(start + batch_size, total)):
                cid = int(class_ids[i])
                if cid < 0:
                    continue
                try:
                    x1, y1, x2, y2 = (float(v) for v in coords[i][:4])
                except Exception:
                    continue
                ring = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]
                nm = names[cid] if 0 <= cid < len(names) else ""
                cl = colors[cid] if 0 <= cid < len(colors) else ""
                feature = {
                    "type": "Feature",
                    "id": f"patch:{i}",
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                    "properties": {
                        "objectType": "annotation",
                        "source": "patch",
                        "classification": {
                            "name": nm,
                            "color": self._hex_to_rgb_triplet(cl),
                        },
                    },
                }
                chunks.append(orjson.dumps(feature, option=orjson.OPT_SERIALIZE_NUMPY))
            if chunks:
                joined = b",".join(chunks)
                if first_feature:
                    yield joined
                    first_feature = False
                else:
                    yield b"," + joined
        yield b']}'

    def save_patch_classification_to_file(self, file_path, format_type="json") -> bool:
        """
        save patch classification results to file, including coordinates, classification ID, name and color information.
        """
        try:
            # ensure we have data to save
            if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
                print("no patch data to export")
                return False

            def decode_if_bytes(data):
                """decode bytes type data to string"""
                if isinstance(data, bytes):
                    return data.decode('utf-8')
                elif isinstance(data, np.ndarray):
                    return [decode_if_bytes(item) for item in data]
                elif isinstance(data, list):
                    return [decode_if_bytes(item) for item in data]
                return data

            patch_data = []
            for i in range(len(self.patch_coordinates)):
                patch = {
                    "id": i,
                    "coordinates": self.patch_coordinates[i].tolist() if self.patch_coordinates is not None else [],
                    "class_id": int(self.patch_class_id[i]) if self.patch_class_id is not None and i < len(self.patch_class_id) else -1,
                    "class_name": decode_if_bytes(self.patch_class_name[self.patch_class_id[i]]) if self.patch_class_name is not None and self.patch_class_id is not None and i < len(self.patch_class_id) else "",
                    "class_hex_color": decode_if_bytes(self.patch_class_hex_color[self.patch_class_id[i]]) if self.patch_class_hex_color is not None and self.patch_class_id is not None and i < len(self.patch_class_id) else "#ff0000"
                }
                patch_data.append(patch)

            if format_type.lower() == "json":
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(patch_data, f, ensure_ascii=False, indent=4)
            elif format_type.lower() == "csv":
                with open(file_path, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.writer(f)
                    # write header
                    writer.writerow(["id", "x1", "y1", "x2", "y2", "class_id", "class_name", "class_hex_color"])
                    
                    # write data rows
                    for i in range(len(self.patch_coordinates)):
                        coords = self.patch_coordinates[i]
                        class_id = self.patch_class_id[i] if self.patch_class_id is not None and i < len(self.patch_class_id) else -1
                        class_name = decode_if_bytes(self.patch_class_name[i]) if self.patch_class_name is not None and i < len(self.patch_class_name) else ""
                        class_color = decode_if_bytes(self.patch_class_hex_color[i]) if self.patch_class_hex_color is not None and i < len(self.patch_class_hex_color) else "#ff0000"
                        
                        writer.writerow([
                            i,              # patch id
                            coords[0],      # x1
                            coords[1],      # y1
                            coords[2],      # x2
                            coords[3],      # y2
                            class_id,       # class_id
                            class_name,     # class_name
                            class_color     # class_hex_color
                        ])
            else:
                print(f"unsupported file format: {format_type}, supported formats are csv or json")
                return False
            return True
        except Exception as e:
            print(f"save patch classification to file error: {str(e)}")
            return False

    def save_classification_to_file(self, file_path, format_type="json"):
        """
        Save classification results (annotation_colors) to a CSV or JSON file.

        Parameters:
            file_path (str): Output file path
            format_type (str): File format, supports "csv" or "json", default is "json"

        Returns:
            bool: Returns True if successful, otherwise False
        """
        try:
            # Make sure we have data to save
            if not self.annotation_colors or not self.annotation_colors.get("class_id") or len(self.annotation_colors["class_id"]) == 0:
                print("No classification data to export")
                return False

            if format_type.lower() == "json":
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(self.annotation_colors, f, ensure_ascii=False, indent=4)
            elif format_type.lower() == "csv":
                # Get the arrays
                class_ids = self.annotation_colors.get("class_id", [])
                class_names = self.annotation_colors.get("class_name", [])
                class_colors = self.annotation_colors.get("class_hex_color", [])
                
                with open(file_path, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.writer(f)
                    # Write header row with four columns
                    writer.writerow(["id", "class_id", "class_name", "class_hex_color"])
                    
                    # Write data rows
                    for i in range(len(class_ids)):
                        class_id = class_ids[i]
                        
                        # Get corresponding name and color based on class_id
                        class_name = ""
                        class_color = ""
                        if 0 <= class_id < len(class_names):
                            class_name = class_names[class_id]
                        if 0 <= class_id < len(class_colors):
                            class_color = class_colors[class_id]
                            
                        writer.writerow([
                            i,              # id (index)
                            class_id,       # class_id value
                            class_name,     # class_name corresponding to class_id
                            class_color     # class_hex_color corresponding to class_id
                        ])
            else:
                print(f"Unsupported file format: {format_type}, supported formats are csv or json")
                return False
            return True
        except Exception as e:
            print(f"Error saving classification results to file: {str(e)}")
            return False

    def save_segmentation_to_file(self, file_path, format_type="json"):
        """
        Save segmentation results (centroids and contours) to a CSV or JSON file.

        Parameters:
            file_path (str): Output file path
            format_type (str): File format, supports "csv" or "json", default is "json"

        Returns:
            bool: Returns True if successful, otherwise False
        """
        try:
            # Make sure we have data to save, use empty arrays if not available
            centroids_data = self.centroids.tolist() if self.centroids is not None else []
            
            # For large datasets with zarr arrays, don't convert all at once
            contours_data = []
            if self.contours is not None:
                # Check if it's a numpy array or zarr array
                if hasattr(self.contours, '__array__') and len(self.contours) <= 50000:
                    # Small dataset or numpy array - can convert safely
                    contours_data = self.contours.tolist()
                # For large zarr arrays, we'll load per-cell below
            
            segmentation_data = []
            for i in range(len(centroids_data)):
                # Get contour - handle both preloaded list and lazy zarr array
                if i < len(contours_data):
                    cell_contour = contours_data[i]
                elif self.contours is not None and i < len(self.contours):
                    # Lazy load from zarr
                    cell_contour = self.contours[i].tolist() if hasattr(self.contours[i], 'tolist') else list(self.contours[i])
                else:
                    cell_contour = []
                
                nucleus = {
                    "id": i,
                    "centroid": centroids_data[i],
                    "contour": cell_contour,
                    "class_id": self.annotation_colors["class_id"][i] if i < len(self.annotation_colors.get("class_id", [])) else -1,
                    "class_name": self.annotation_colors["class_name"][self.annotation_colors["class_id"][i]] if i < len(self.annotation_colors.get("class_id", [])) and self.annotation_colors["class_id"][i] < len(self.annotation_colors.get("class_name", [])) else "",
                    "class_hex_color": self.annotation_colors["class_hex_color"][self.annotation_colors["class_id"][i]] if i < len(self.annotation_colors.get("class_id", [])) and self.annotation_colors["class_id"][i] < len(self.annotation_colors.get("class_hex_color", [])) else "#ff0000"
                }
                segmentation_data.append(nucleus)
            
            if format_type.lower() == "json":
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(segmentation_data, f, ensure_ascii=False, indent=4)
            elif format_type.lower() == "csv":
                with open(file_path, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.writer(f)
                    # Write header row
                    writer.writerow(["id", "centroid_x", "centroid_y", "contour", "class_id", "class_name", "class_hex_color"])
                    
                    # Write data rows
                    for i in range(len(centroids_data)):
                        class_id = -1
                        class_name = ""
                        class_color = "#ff0000"  # Default red color
                        
                        # If classification data is available, get the corresponding information
                        if i < len(self.annotation_colors.get("class_id", [])):
                            class_id = self.annotation_colors["class_id"][i]
                            if 0 <= class_id < len(self.annotation_colors.get("class_name", [])):
                                class_name = self.annotation_colors["class_name"][class_id]
                            if 0 <= class_id < len(self.annotation_colors.get("class_hex_color", [])):
                                class_color = self.annotation_colors["class_hex_color"][class_id]
                        
                        # Get contour - handle both preloaded list and lazy zarr array
                        if i < len(contours_data):
                            contour_str = str(contours_data[i])
                        elif self.contours is not None and i < len(self.contours):
                            contour_str = str(self.contours[i].tolist() if hasattr(self.contours[i], 'tolist') else list(self.contours[i]))
                        else:
                            contour_str = "[]"
                        
                        centroid_x = centroids_data[i][0] if i < len(centroids_data) else 0
                        centroid_y = centroids_data[i][1] if i < len(centroids_data) else 0
                        
                        writer.writerow([
                            i,             # id (index)
                            centroid_x,    # centroid x coordinate
                            centroid_y,    # centroid y coordinate
                            contour_str,   # contour points
                            class_id,      # class ID
                            class_name,    # class name
                            class_color    # class color
                        ])
            else:
                print(f"Unsupported file format: {format_type}, supported formats are csv or json")
                return False
                
            return True
        except Exception as e:
            print(f"Error saving segmentation results to file: {str(e)}")
            return False

    def get_patch_centroids(self):
        """get all patch centroids"""
        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            return []

        # Validate patch coordinates shape before accessing columns
        if len(self.patch_coordinates.shape) < 2 or self.patch_coordinates.shape[1] < 4:
            raise ValueError(f"Expected patch coordinates to have at least 4 columns (Nx4), but got shape {self.patch_coordinates.shape}")

        centroids_x = np.mean(self.patch_coordinates[:, [0, 2]], axis=1)
        centroids_y = np.mean(self.patch_coordinates[:, [1, 3]], axis=1)
        
        result = np.column_stack((centroids_x, centroids_y))
        return result.astype(float)
    
    def get_patch_centroids_in_viewport(self, x1, y1, x2, y2):
        """
        get all patches in viewport, return all patches that have any part in viewport
        Now includes patch dimensions for dynamic rendering
        """
        # Check if handler needs reload due to file change
        if hasattr(self, '_needs_reload') and self._needs_reload:
            print(f"[DEBUG] SegmentationHandler - Reloading data due to file change")
            self.load_file(self.zarr_file)
            # Reset the reload flag after successful reload
            self._needs_reload = False
        
        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            if self.zarr_file and os.path.exists(self.zarr_file):
                try:
                    # Patch overlays only need patch metadata; avoid forcing full nuclei reload here.
                    self.load_file(self.zarr_file, force_reload=True, reload_segmentation_data=False)
                except Exception as e:
                    print(f"[ERROR] get_patch_centroids_in_viewport => Failed to load patch data: {e}")
                    return [], {}

        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            return [], {}
        
        # Validate patch coordinates shape before accessing columns
        if len(self.patch_coordinates.shape) < 2 or self.patch_coordinates.shape[1] < 4:
            raise ValueError(f"Expected patch coordinates to have at least 4 columns (Nx4), but got shape {self.patch_coordinates.shape}")
        
        # calculate all centroids
        centroids_x = np.mean(self.patch_coordinates[:, [0, 2]], axis=1)
        centroids_y = np.mean(self.patch_coordinates[:, [1, 3]], axis=1)
        
        # calculate patch dimensions (width and height) in Level 0 coordinates
        patch_widths = self.patch_coordinates[:, 2] - self.patch_coordinates[:, 0]
        patch_heights = self.patch_coordinates[:, 3] - self.patch_coordinates[:, 1]
        
        # create mask for patches that have any part in viewport
        patch_x1 = self.patch_coordinates[:, 0]
        patch_y1 = self.patch_coordinates[:, 1]
        patch_x2 = self.patch_coordinates[:, 2]
        patch_y2 = self.patch_coordinates[:, 3]
        
        mask = (patch_x2 >= x1) & (patch_x1 <= x2) & (patch_y2 >= y1) & (patch_y1 <= y2)
        
        indices = np.where(mask)[0]

        if len(indices) == 0:
            return [], {}

        # Get class IDs for patches in view
        patch_class_ids_in_view = []
        if hasattr(self, 'patch_class_id') and self.patch_class_id is not None:
            patch_class_ids_in_view = self.patch_class_id[indices]

        # Calculate counts
        class_counts_by_id = {}
        if len(patch_class_ids_in_view) > 0:
            unique, counts = np.unique(patch_class_ids_in_view, return_counts=True)
            class_counts_by_id = dict(zip(unique.astype(str), counts))

        # Manual patch annotations for color overrides. Prefer the in-memory
        # cache populated by load_file(); fall back to a direct zarr read via
        # the canonical helper if the handler hasn't loaded yet.
        manual_annots = self.tissue_annotations if isinstance(getattr(self, 'tissue_annotations', None), dict) else {}
        if not manual_annots and self.zarr_file and os.path.exists(self.zarr_file):
            try:
                from app.services.tasks import load_patch_annotations
                manual_annots = load_patch_annotations(self.zarr_file)
            except Exception as e:
                print(f"[PATCHES] Failed to read User-Annotations/patch for override: {e}")

        # Get colors for each patch using colormap (similar to nuclei)
        colors = []
        # Class id the frontend should paint with: the manual/AL override when a
        # patch has one, else the AI prediction. The overlay resolves its color
        # from this id (falling back to `colors` only when the id is < 0), so
        # sending the raw prediction here made user relabels invisible.
        effective_class_ids = []
        try:
            patch_class_names_list = [
                n.decode('utf-8') if isinstance(n, bytes) else str(n)
                for n in (self.patch_class_name if self.patch_class_name is not None else [])
            ]
        except Exception:
            patch_class_names_list = []

        # Priority: self.patch_class_hex_color (from zarr patch group, contains all classes from model)
        # Similar to get_cell_classification_data which uses self.class_name and self.class_hex_color
        user_tissue_colormap = None
        if hasattr(self, 'patch_class_name') and self.patch_class_name is not None and \
           hasattr(self, 'patch_class_hex_color') and self.patch_class_hex_color is not None:
            try:
                # Get class names and colors from handler (loaded from zarr patch group)
                names_list = list(self.patch_class_name) if self.patch_class_name is not None else []
                decoded_colors = [c.decode('utf-8') if isinstance(c, bytes) else str(c) for c in self.patch_class_hex_color]
                
                if len(names_list) == len(decoded_colors) and len(names_list) > 0:
                    user_tissue_colormap = {
                        name: color for name, color in zip(names_list, decoded_colors)
                    }
            except Exception as e:
                print(f"[PATCHES] Failed to build colormap from handler data: {e}")
        
        # Get colors for each patch
        for idx_in_view, class_id in zip(indices, patch_class_ids_in_view):
            # Check if this patch has a manual annotation override
            manual_class_name = None
            manual_negative = None  # negative selection: tissue_class is None, exclude_classes present
            if isinstance(manual_annots, dict):
                key_str = str(int(idx_in_view))
                manual = manual_annots.get(key_str)
                if manual is None:
                    manual = manual_annots.get(int(idx_in_view))
                if manual and isinstance(manual, dict):
                    manual_class_name = manual.get('class')
                    if not manual_class_name and manual.get('exclude_classes'):
                        manual_negative = manual
            
            # Determine which class name to use: positive manual override > prediction (class_id)
            class_name_to_use = None
            if manual_class_name:
                class_name_to_use = manual_class_name
            elif class_id >= 0 and self.patch_class_name is not None and class_id < len(self.patch_class_name):
                try:
                    class_name_to_use = str(self.patch_class_name[class_id])
                except (IndexError, TypeError):
                    pass
            
            # Negative selection keeps the prediction id; a positive override
            # reports the override's own class id.
            eff_class_id = int(class_id)
            if manual_class_name and not manual_negative:
                try:
                    eff_class_id = patch_class_names_list.index(manual_class_name)
                except ValueError:
                    pass
            effective_class_ids.append(eff_class_id)

            # Get color: for negative selection prefer prediction color when available, else gray
            if manual_negative:
                # Negative selection (exclude_classes): show prediction color if we have one, else gray
                pred_class_name = None
                if class_id >= 0 and self.patch_class_name is not None and class_id < len(self.patch_class_name):
                    try:
                        pred_class_name = str(self.patch_class_name[class_id])
                    except (IndexError, TypeError):
                        pass
                if pred_class_name and user_tissue_colormap and pred_class_name in user_tissue_colormap:
                    color_to_use = user_tissue_colormap[pred_class_name]
                    colors.append(color_to_use)
                else:
                    color_to_use = manual_negative.get('color') or '#aaaaaa'
                    colors.append(color_to_use)
            elif class_name_to_use and user_tissue_colormap and class_name_to_use in user_tissue_colormap:
                color_to_use = user_tissue_colormap[class_name_to_use]
                colors.append(color_to_use)
            elif class_id == -1:
                colors.append("#cccccc")  # Light gray for unclassified
            else:
                colors.append("#808080")  # Default dark gray for unknown/error
                if len(colors) <= 3:
                    print(f"[PATCHES] Warning: No color found for class '{class_name_to_use}' (class_id={class_id}), using default gray")
        
        # If no color map exists at all, default everything to light gray
        if not user_tissue_colormap:
            for idx_in_view in indices:
                colors.append("#cccccc")

        # Create result array [index, centroid_x, centroid_y, width, height, color, class_id]
        # Width and height are included for dynamic patch rendering
        # class_id is included to enable optimistic color updates in frontend (similar to nuclei)
        result_with_colors = []
        centroids_in_view_x = centroids_x[mask]
        centroids_in_view_y = centroids_y[mask]
        widths_in_view = patch_widths[mask]
        heights_in_view = patch_heights[mask]

        for i in range(len(indices)):
            if i < len(effective_class_ids):
                class_id = int(effective_class_ids[i])
            elif i < len(patch_class_ids_in_view):
                class_id = int(patch_class_ids_in_view[i])
            else:
                class_id = -1
            result_with_colors.append([
                int(indices[i]),
                float(centroids_in_view_x[i]),
                float(centroids_in_view_y[i]),
                float(widths_in_view[i]),
                float(heights_in_view[i]),
                str(colors[i]) if colors[i] else "#cccccc",  # Force string for JSON
                class_id  # Add class_id for optimistic color updates
            ])

        return result_with_colors, self.get_all_patch_counts()

    def merge_patches_in_viewport(self, x1: float, y1: float, x2: float, y2: float):
        """
        Merge adjacent patches within viewport and return the contour points of the merged area.
        Only checks adjacency in 8 directions (up, down, left, right, and diagonals).
        """
        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            return
        
        # Validate patch coordinates shape before accessing columns
        if len(self.patch_coordinates.shape) < 2 or self.patch_coordinates.shape[1] < 4:
            raise ValueError(f"Expected patch coordinates to have at least 4 columns (Nx4), but got shape {self.patch_coordinates.shape}")
        
        # Create mask for all patches
        patch_x1 = self.patch_coordinates[:, 0]
        patch_y1 = self.patch_coordinates[:, 1]
        patch_x2 = self.patch_coordinates[:, 2]
        patch_y2 = self.patch_coordinates[:, 3]
        
        # Find patches within viewport
        viewport_mask = (patch_x2 >= x1) & (patch_x1 <= x2) & (patch_y2 >= y1) & (patch_y1 <= y2)
        viewport_indices = np.where(viewport_mask)[0]
        
        if len(viewport_indices) == 0:
            return

        # Create visit markers array (only mark patches within viewport)
        visited = np.zeros(len(self.patch_coordinates), dtype=bool)
        
        # Pre-calculate patch centers and dimensions for faster adjacency checks
        centers = np.column_stack([
            (patch_x1 + patch_x2) / 2,
            (patch_y1 + patch_y2) / 2
        ])
        dimensions = np.column_stack([
            patch_x2 - patch_x1,
            patch_y2 - patch_y1
        ])
        
        def is_adjacent_vectorized(current_idx, other_indices, tolerance=1e-6):
            """Vectorized version of adjacency check"""
            current_center = centers[current_idx]
            other_centers = centers[other_indices]
            
            current_dim = dimensions[current_idx]
            other_dims = dimensions[other_indices]
            
            # Calculate distances and average dimensions
            dx = np.abs(other_centers[:, 0] - current_center[0])
            dy = np.abs(other_centers[:, 1] - current_center[1])
            
            avg_width = (current_dim[0] + other_dims[:, 0]) / 2
            avg_height = (current_dim[1] + other_dims[:, 1]) / 2
            
            # Return boolean mask of adjacent patches
            return (dx <= avg_width + tolerance) & (dy <= avg_height + tolerance)

        def find_connected_patches(start_idx):
            connected = []
            stack = [start_idx]
            
            if self.patch_class_hex_color is not None and self.patch_class_id is not None:
                # get start patch color and class name
                start_color = self.patch_class_hex_color[self.patch_class_id[start_idx]]
                start_class_name = self.patch_class_name[self.patch_class_id[start_idx]] if self.patch_class_name is not None else None
                
                # decode if bytes type
                if isinstance(start_color, bytes):
                    start_color = start_color.decode('utf-8')
                if isinstance(start_class_name, bytes):
                    start_class_name = start_class_name.decode('utf-8')
                    
                # check if it is default color or Negative control class
                if start_color == "#aaaaaa" or (start_class_name and start_class_name.lower() == "negative control"):
                    return [], None
            else:
                start_color = None
                start_class_name = None

            while stack:
                current = stack.pop()
                if visited[current]:
                    continue
                
                visited[current] = True
                connected.append(current)
                
                # Get unvisited patches in viewport
                unvisited_mask = ~visited[viewport_indices]
                if not np.any(unvisited_mask):
                    continue
                
                unvisited_indices = viewport_indices[unvisited_mask]
                
                # Check adjacency for all unvisited patches at once
                adjacent_mask = is_adjacent_vectorized(current, unvisited_indices)
                adjacent_indices = unvisited_indices[adjacent_mask]
                
                # Filter by color if needed
                if start_color is not None and len(adjacent_indices) > 0:
                    colors = self.patch_class_hex_color[self.patch_class_id[adjacent_indices]]
                    colors = np.array([c.decode('utf-8') if isinstance(c, bytes) else c for c in colors])
                    color_mask = colors == start_color
                    adjacent_indices = adjacent_indices[color_mask]
                
                stack.extend(adjacent_indices)
            
            return connected, start_color if start_color else "#aaaaaa"

        def get_contour_points(patches):
            return patch_group_outline(self.patch_coordinates, patches)

        # Only traverse patches within viewport
        merged_patch_annotations = {}
        for i in viewport_indices:
            if not visited[i]:
                connected_patches, color = find_connected_patches(i)
                if connected_patches and color:
                    # Get contour points
                    contour_points = get_contour_points(connected_patches)
                    points = [[float(x), float(y)] for x, y in contour_points]
                    xs = [p[0] for p in points]
                    ys = [p[1] for p in points]
                    bounds = {
                        "minX": min(xs),
                        "minY": min(ys),
                        "maxX": max(xs),
                        "maxY": max(ys)
                    }

                    unique_id = f"merged_patch_{len(merged_patch_annotations)}"
                    style_body = {
                        "id": unique_id,
                        "annotation": unique_id,
                        "type": "TextualBody",
                        "purpose": "style",
                        "value": color,
                        "created": datetime.now().isoformat(),
                        "creator": {
                            "id": "default",
                            "type": "AI"
                        }
                    }

                    annotation = {
                        "id": unique_id,
                        "type": "Annotation",
                        "bodies": [style_body],
                        "target": {
                            "annotation": unique_id,
                            "selector": {
                                "type": "POLYGON",
                                "geometry": {
                                    "points": points,
                                    "bounds": bounds
                                }
                            }
                        },
                        "creator": {
                            "isGuest": True,
                            "id": "nrESYlDUe8L1qF6Ffhq4"
                        },
                        "created": datetime.now().isoformat()
                    }

                    merged_patch_annotations[unique_id] = annotation

        return merged_patch_annotations

    def process_and_store_merged_patches(self):
        """
        process all patches and store the merged patches in cache
        """
        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            self._merged_patches_cache = {}
            return

        # Validate patch coordinates shape before accessing columns
        if len(self.patch_coordinates.shape) < 2 or self.patch_coordinates.shape[1] < 4:
            raise ValueError(f"Expected patch coordinates to have at least 4 columns (Nx4), but got shape {self.patch_coordinates.shape}")

        visited = np.zeros(len(self.patch_coordinates), dtype=bool)
        
        centers = np.column_stack([
            (self.patch_coordinates[:, 0] + self.patch_coordinates[:, 2]) / 2,
            (self.patch_coordinates[:, 1] + self.patch_coordinates[:, 3]) / 2
        ])
        dimensions = np.column_stack([
            self.patch_coordinates[:, 2] - self.patch_coordinates[:, 0],
            self.patch_coordinates[:, 3] - self.patch_coordinates[:, 1]
        ])
        
        def is_adjacent_vectorized(current_idx, other_indices, tolerance=1e-6):
            current_center = centers[current_idx]
            other_centers = centers[other_indices]
            current_dim = dimensions[current_idx]
            other_dims = dimensions[other_indices]
            dx = np.abs(other_centers[:, 0] - current_center[0])
            dy = np.abs(other_centers[:, 1] - current_center[1])
            avg_width = (current_dim[0] + other_dims[:, 0]) / 2
            avg_height = (current_dim[1] + other_dims[:, 1]) / 2
            return (dx <= avg_width + tolerance) & (dy <= avg_height + tolerance)

        def find_connected_patches(start_idx):
            connected = []
            stack = [start_idx]
            
            if self.patch_class_hex_color is not None and self.patch_class_id is not None:
                start_color = self.patch_class_hex_color[self.patch_class_id[start_idx]]
                start_class_name = self.patch_class_name[self.patch_class_id[start_idx]] if self.patch_class_name is not None else None
                
                # decode if bytes type
                if isinstance(start_color, bytes):
                    start_color = start_color.decode('utf-8')
                if isinstance(start_class_name, bytes):
                    start_class_name = start_class_name.decode('utf-8')
                    
                # check if it is default color or Negative control class
                if start_color == "#aaaaaa" or (start_class_name and start_class_name.lower() == "negative control"):
                    return [], None
            else:
                start_color = None
                start_class_name = None

            while stack:
                current = stack.pop()
                if visited[current]:
                    continue
                
                visited[current] = True
                connected.append(current)
                
                unvisited_mask = ~visited
                if not np.any(unvisited_mask):
                    continue
                
                unvisited_indices = np.where(unvisited_mask)[0]
                adjacent_mask = is_adjacent_vectorized(current, unvisited_indices)
                adjacent_indices = unvisited_indices[adjacent_mask]
                
                if start_color is not None and len(adjacent_indices) > 0:
                    colors = self.patch_class_hex_color[self.patch_class_id[adjacent_indices]]
                    colors = np.array([c.decode('utf-8') if isinstance(c, bytes) else c for c in colors])
                    color_mask = colors == start_color
                    adjacent_indices = adjacent_indices[color_mask]
                
                stack.extend(adjacent_indices)
            
            return connected, start_color if start_color else "#aaaaaa"

        def get_contour_points(patches):
            return patch_group_outline(self.patch_coordinates, patches)

        # store merged results
        self._merged_patches_cache = {}
        all_indices = np.arange(len(self.patch_coordinates))
        
        for i in all_indices:
            if not visited[i]:
                connected_patches, color = find_connected_patches(i)
                if connected_patches and color:
                    contour_points = get_contour_points(connected_patches)
                    points = [[float(x), float(y)] for x, y in contour_points]

                    # calculate bounds
                    xs = [p[0] for p in points]
                    ys = [p[1] for p in points]
                    bounds = {
                        "minX": min(xs),
                        "minY": min(ys),
                        "maxX": max(xs),
                        "maxY": max(ys)
                    }
                    
                    unique_id = f"merged_patch_{len(self._merged_patches_cache)}"
                    
                    # create annotation object
                    annotation = {
                        "id": unique_id,
                        "type": "Annotation",
                        "bodies": [{
                            "id": unique_id,
                            "annotation": unique_id,
                            "type": "TextualBody",
                            "purpose": "style",
                            "value": color,
                            "created": datetime.now().isoformat(),
                            "creator": {"id": "default", "type": "AI"}
                        }],
                        "target": {
                            "annotation": unique_id,
                            "selector": {
                                "type": "POLYGON",
                                "geometry": {
                                    "points": points,
                                    "bounds": bounds
                                }
                            }
                        },
                        "creator": {
                            "isGuest": True,
                            "id": "nrESYlDUe8L1qF6Ffhq4"
                        },
                        "created": datetime.now().isoformat()
                    }
                    
                    self._merged_patches_cache[unique_id] = {
                        "annotation": annotation,
                        "bounds": bounds
                    }

    def get_merged_patches_in_viewport(self, x1: float, y1: float, x2: float, y2: float):
        """
        get the merged patches in viewport
        
        Args:
            x1, y1, x2, y2: the boundary coordinates of the viewport
            
        Returns:
            Dict: the merged patches in viewport
        """
        if not hasattr(self, '_merged_patches_cache'):
            self.process_and_store_merged_patches()
        
        result = {}
        for patch_id, patch_data in self._merged_patches_cache.items():
            bounds = patch_data["bounds"]
            # check if it intersects with the viewport
            if (bounds["maxX"] >= x1 and bounds["minX"] <= x2 and
                bounds["maxY"] >= y1 and bounds["minY"] <= y2):
                result[patch_id] = patch_data["annotation"]

        return result

    def get_patches(self, offset=0, limit=None):
        """
        Get patches with pagination support.
        
        Args:
            offset (int): The starting index for pagination
            limit (int, optional): The maximum number of patches to return
            
        Returns:
            tuple: A tuple containing (patches_list, total_count)
        """
        # Convert offset and limit to integers
        try:
            offset = int(offset)
        except (ValueError, TypeError):
            offset = 0
            print(f"[Debug] get_patches => Invalid offset, using default: {offset}")
            
        try:
            limit = int(limit) if limit is not None else None
        except (ValueError, TypeError):
            limit = None
            print(f"[Debug] get_patches => Invalid limit, using default: {limit}")
            
        patches_list = []
        total_count = 0
        
        # Check if patch data is available
        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            return patches_list, total_count
            
        total_count = len(self.patch_coordinates)
        
        # Determine the end index for iteration
        end_idx = total_count
        if limit is not None:
            end_idx = min(offset + limit, total_count)
            
        # Iterate over the specified range of indices
        for idx in range(offset, end_idx):
            # Create a patch annotation
            patch_coords = self.patch_coordinates[idx]
            x1_coord, y1_coord, x2_coord, y2_coord = patch_coords
            
            # Create contour points for the patch (rectangle)
            contour = [
                [x1_coord, y1_coord],
                [x2_coord, y1_coord],
                [x2_coord, y2_coord],
                [x1_coord, y2_coord],
                [x1_coord, y1_coord]  # Close the polygon
            ]
            
            # Get class information for the patch.
            # No default color: an unclassified patch carries no color (same as
            # unclassified cells), so the UI shows it blank instead of a fake red.
            patch_specific_color = None       # Color only set once a class is assigned
            patch_assigned_class_id = -1      # Default class_id
            patch_specific_class_name = ""    # Default class_name

            if hasattr(self, 'patch_class_id') and self.patch_class_id is not None and \
               idx < len(self.patch_class_id):
                
                current_patch_class_id_val = self.patch_class_id[idx]
                patch_assigned_class_id = int(current_patch_class_id_val)

                if hasattr(self, 'patch_class_hex_color') and self.patch_class_hex_color is not None and \
                   0 <= current_patch_class_id_val < len(self.patch_class_hex_color):
                    color_val = self.patch_class_hex_color[current_patch_class_id_val]
                    patch_specific_color = color_val.decode('utf-8') if isinstance(color_val, bytes) else str(color_val)

                if hasattr(self, 'patch_class_name') and self.patch_class_name is not None and \
                   0 <= current_patch_class_id_val < len(self.patch_class_name):
                    name_val = self.patch_class_name[current_patch_class_id_val]
                    patch_specific_class_name = name_val.decode('utf-8') if isinstance(name_val, bytes) else str(name_val)
            
            # Create the annotation
            patch_annotation = self.create_annotation(
                index=idx,  # Use patch index as unique ID for the annotation
                contour=contour, 
                color=patch_specific_color, # This will be used for style and as class_hex_color
                class_id=patch_assigned_class_id,
                class_name=patch_specific_class_name,
                is_patch=True
            )
            patches_list.append(patch_annotation)

        return patches_list, total_count

    def get_all_nuclei_counts(self, instance_id: str = None) -> Dict[str, Any]:
        """
        Returns the persisted class counts from /User-Annotations/cell/__attrs_class_counts__ in Zarr.
        Maps to ID-based if possible. Uses cache to avoid repeated file I/O.

        Args:
            instance_id: Optional viewer instance id for per-session AL counts.
                        If None, Active Learning reclassifications will not be applied.
            
        Returns:
            Dict with class counts and related data
        """
        zarr_path = self.get_current_file_path()
        cache_key = (zarr_path, instance_id)

        # Check cache first (keyed by instance_id when provided)
        # IMPORTANT: If cache key doesn't match exactly, we must recompute to avoid stale data
        # This is especially critical after reset operations
        if self._user_annotation_counts_cache is not None:
            cached_key, cache_result = self._user_annotation_counts_cache
            if cached_key == cache_key:
                return cache_result
            else:
                # Clear the mismatched cache to prevent stale data
                self._user_annotation_counts_cache = None

        counts_dict = {}
        
        # Read directly from Zarr file
        if not zarr_path or not os.path.exists(zarr_path):
            print(f"[WARN] get_all_nuclei_counts => Zarr file not found: {zarr_path}")
            result = self._compute_counts_from_manual_annotations()
            # Cache the result even if it's empty
            self._user_annotation_counts_cache = (cache_key, result)
            return result

        fallback_done = False
        weak_counts = {}
        # The handler already holds this store open. Opening it again costs a
        # fresh zarr open plus the auto-convert directory probe that open_zarr_cm
        # runs every time — measured at 323 ms of the 1264 ms first centroids
        # query, spent re-opening a store that was already in hand.
        cached_store = getattr(self, "_zarr_file_obj", None)
        reuse_cached = cached_store is not None and self._same_zarr_path(
            getattr(self, "zarr_file", None), zarr_path
        )
        try:
            store_cm = (
                contextlib.nullcontext(cached_store)
                if reuse_cached
                else open_zarr_cm(zarr_path, 'r')
            )
            with store_cm as zarr_file:
                # Look for class counts in user_annotation group
                if 'User-Annotations' in zarr_file:
                    user_anno_group = zarr_file['User-Annotations']

                    if 'cell_class_counts' in user_anno_group:
                        raw_data = user_anno_group['cell_class_counts'][()]
                        try:
                            if isinstance(raw_data, bytes):
                                counts_dict = json.loads(raw_data.decode('utf-8'))
                            else:
                                counts_dict = json.loads(raw_data)
                        except (json.JSONDecodeError, UnicodeDecodeError) as e:
                            print(f"[WARN] get_all_nuclei_counts => Failed to parse counts data: {e}")
                            counts_dict = {}

                # Both counters below read the same `class` column, and that read
                # is essentially the whole cost of this call (~0.3 s per pass on a
                # 2M-cell slide). Load it once and hand it to both, rather than
                # letting each one read the array for itself.
                shared_class_ids = None
                loaded = self._load_annotations_array(zarr_file, fields=['class'])
                if loaded is not None:
                    shared_class_ids = np.asarray(loaded['class'])
                    del loaded

                if not counts_dict:
                    # Fall back while the store is still open, rather than
                    # reopening it below just to find there is nothing to count.
                    counts_dict = self._compute_counts_from_manual_annotations(
                        zarr_file, cell_class_ids=shared_class_ids)
                    fallback_done = True
                # Weak ("not this type") marks are not in cell_class_counts, so they
                # always come off the annotation array — read them here while the
                # store is in hand instead of reopening it.
                weak_counts = self._compute_weak_counts_from_manual_annotations(
                    zarr_file, cell_class_ids=shared_class_ids)
        except Exception as e:
            print(f"[WARN] get_all_nuclei_counts => Error reading Zarr file: {e}")
            counts_dict = {}

        # Step 3: NO LONGER apply Active Learning reclassifications from memory
        # BUG FIX: Removed the logic that was adding _reclassified_cells counts to class_counts
        # 
        # REASON: This caused double-counting because:
        # 1. save_reclassifications_via_existing_api() updates class_counts in Zarr when saving
        # 2. _get_reclassified_cells() loads saved reclassifications from Zarr into _reclassified_cells
        # 3. If we then add _reclassified_cells counts to class_counts, we're counting the same data twice
        #
        # SOLUTION: class_counts from Zarr is the SINGLE SOURCE OF TRUTH for counts.
        # - When reclassifications are saved, class_counts is updated
        # - When we read class_counts, it already contains all saved reclassifications
        # - No need to add in-memory reclassifications because they are saved immediately

        # Step 4: Fallback computation only if absolutely necessary. Skipped when
        # the in-store attempt above already ran — it reopens the zarr.
        if not counts_dict and not fallback_done:
            counts_dict = self._compute_counts_from_manual_annotations()

        # Build and return result
        if counts_dict or weak_counts:
            result = self._build_id_based_counts(counts_dict)
            # dynamic_class_names may have grown while mapping the positive counts,
            # so map the weak ones against the final list.
            name_to_id = {n: str(i) for i, n in enumerate(result['dynamic_class_names'])}
            result['negative_class_counts_by_id'] = {
                i: 0 for i in result['class_counts_by_id']
            }
            for name, n in weak_counts.items():
                cid = name_to_id.get(name)
                if cid is not None:
                    result['negative_class_counts_by_id'][cid] = n
            # Cache the result (now includes instance_id in cache key)
            # IMPORTANT: Always update cache with current key to prevent stale data
            self._user_annotation_counts_cache = (cache_key, result)
        else:
            # No data available, return empty result
            result = {'class_counts_by_id': {}, 'negative_class_counts_by_id': {},
                      'dynamic_class_names': []}
            # Cache the empty result too
            # IMPORTANT: Always update cache with current key to prevent stale data
            self._user_annotation_counts_cache = (cache_key, result)

        return result

    def _compute_weak_counts_from_manual_annotations(self, zarr_file=None,
                                                     cell_class_ids=None) -> Dict[str, int]:
        """Count "not this type" marks, keyed by the class name they exclude.

        Weak marks are stored as ``class == -(2 + class_index)``, so unlike the
        positive counts they are not in ``cell_class_counts`` and have to be read
        off the annotation array. Pass ``cell_class_ids`` to reuse a `class`
        column the caller already loaded.
        """
        try:
            if zarr_file is None and (not self.zarr_file or not os.path.exists(self.zarr_file)):
                return {}
            store = (
                contextlib.nullcontext(zarr_file)
                if zarr_file is not None
                else open_zarr_cm(self.zarr_file, 'r')
            )
            with store as zarr_file:
                if 'User-Annotations' not in zarr_file:
                    return {}
                user_anno_group = zarr_file['User-Annotations']
                class_names, _ = read_user_anno_class_palette(user_anno_group, 'cell')
                if not class_names:
                    return {}
                if cell_class_ids is None:
                    manual_annotations = self._load_annotations_array(zarr_file, fields=['class'])
                    if manual_annotations is None:
                        return {}
                    cell_class_ids = np.asarray(manual_annotations['class'])
                # One pass over the marked rows rather than one full scan per
                # class: the marks are a few thousand against every cell on the
                # slide, and the class list can be long.
                neg = cell_class_ids[cell_class_ids <= -2]
                if neg.size == 0:
                    return {}
                excluded_k = (-neg - 2).astype(np.int64)
                excluded_k = excluded_k[(excluded_k >= 0) & (excluded_k < len(class_names))]
                if excluded_k.size == 0:
                    return {}
                tally = np.bincount(excluded_k, minlength=len(class_names))
                return {class_names[i]: int(c) for i, c in enumerate(tally) if c}
        except Exception as e:
            logger.debug("Could not compute weak annotation counts: %s", e)
            return {}

    def _compute_counts_from_manual_annotations(self, zarr_file=None,
                                                cell_class_ids=None) -> Dict[str, int]:
        """Count manually labelled cells, keyed by class name.

        An empty dict means "nobody has labelled a cell on this slide yet" —
        the normal state for a fresh slide, not an error.

        Pass an already-open ``zarr_file`` to reuse it; the caller normally has
        the store open already and reopening it here doubled the work needed to
        conclude there is nothing to count. Pass ``cell_class_ids`` to reuse a
        `class` column the caller already loaded.
        """
        try:
            # Read directly from Zarr file - no cache needed
            if zarr_file is None and (not self.zarr_file or not os.path.exists(self.zarr_file)):
                print(f"[WARN] _compute_counts_from_manual_annotations => Zarr file not found: {self.zarr_file}")
                return {}

            store = (
                contextlib.nullcontext(zarr_file)
                if zarr_file is not None
                else open_zarr_cm(self.zarr_file, 'r')
            )
            with store as zarr_file:
                if 'User-Annotations' in zarr_file:
                    user_anno_group = zarr_file['User-Annotations']
                    class_names, _ = read_user_anno_class_palette(user_anno_group, 'cell')

                    if not class_names:
                        # No metadata, can't convert IDs to names
                        print(f"[_compute_counts_from_manual_annotations] No class_names in metadata, cannot compute counts")
                        return {}

                    # Load only cell_class field (much faster than loading entire array)
                    if cell_class_ids is None:
                        manual_annotations = self._load_annotations_array(zarr_file, fields=['class'])
                        cell_class_ids = manual_annotations['class'] if manual_annotations is not None else None
                    if cell_class_ids is not None:
                        # Use numpy operations for much better performance
                        # New format: -1 = unclassified, 0+ = class index
                        non_empty_mask = cell_class_ids >= 0
                        
                        annotated_count = np.sum(non_empty_mask)

                        if np.any(non_empty_mask):
                            valid_class_ids = cell_class_ids[non_empty_mask]
                            # Filter out invalid indices before counting
                            valid_indices_mask = (valid_class_ids >= 0) & (valid_class_ids < len(class_names))
                            valid_class_ids = valid_class_ids[valid_indices_mask]
                        else:
                            return {}
                    else:
                        # The class palette exists but no `cell` array does:
                        # classes were defined, nothing has been labelled yet.
                        # Normal on a fresh slide — this used to print "Failed",
                        # which reads like an error and sends people debugging.
                        logger.debug(
                            "No manually labelled cells on %s; counts are empty",
                            self.zarr_file,
                        )
                        return {}
                else:
                    return {}

            # User overrides already live inside manual_annotations['class'], so the
            # final per-cell class is the value we count directly.
            #
            # Counted by palette index, not by name: the ids are already a numpy
            # int array, so bincount is one pass. Materialising a name per
            # labelled cell and calling np.unique on it meant a Python
            # comprehension over every annotation plus a string sort.
            name_counts = {}
            if valid_class_ids.size > 0:
                per_class = np.bincount(valid_class_ids, minlength=len(class_names))
                for idx in np.flatnonzero(per_class):
                    name = class_names[idx]
                    if name:
                        # Two palette slots can carry the same name; np.unique
                        # merged those, so keep adding rather than overwriting.
                        name_counts[str(name)] = name_counts.get(str(name), 0) + int(per_class[idx])

            return name_counts

        except Exception as e:
            print(f"[ERROR] _compute_counts_from_manual_annotations: {e}")
            return {}

    def _build_id_based_counts(self, counts_dict: Dict[str, int]) -> Dict[str, Any]:
        """Build ID-based counts from name-based counts (optimized)"""
        if self.class_name is None or len(self.class_name) == 0:
            # No class mapping available, return name-based
            return {
                'class_counts_by_id': {str(i): count for i, (name, count) in enumerate(counts_dict.items())},
                'dynamic_class_names': sorted(counts_dict.keys())
            }

        # Use existing class names as base
        old_names = [
            n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n)
            for n in list(self.class_name)
        ]
        dynamic_class_names = list(old_names)

        # Remove duplicates while preserving order
        seen = set()
        dynamic_class_names = [n for n in dynamic_class_names if not (n in seen or seen.add(n))]
        
        # Ensure 'Negative control' exists and is first
        if 'Negative control' not in dynamic_class_names:
            dynamic_class_names = ['Negative control'] + dynamic_class_names
        else:
            # Move to front if not already
            if dynamic_class_names[0] != 'Negative control':
                dynamic_class_names = ['Negative control'] + [n for n in dynamic_class_names if n != 'Negative control']

        # self.class_id indexes self.class_name. Reordering / prepending names
        # without moving the per-cell ids with them relabels every cell: with
        # ['Tumor', 'Negative control'] pinned to ['Negative control', 'Tumor'],
        # id 0 stops meaning Tumor and every overlay frame paints it grey.
        if dynamic_class_names != old_names and self.class_id is not None:
            try:
                new_index_of = {n: i for i, n in enumerate(dynamic_class_names)}
                lut = np.array([new_index_of.get(n, -1) for n in old_names], dtype=int)
                ids = np.asarray(self.class_id, dtype=int)
                valid = (ids >= 0) & (ids < len(lut))
                remapped = ids.copy()
                remapped[valid] = lut[ids[valid]]
                self.class_id = remapped
            except Exception as e:
                logger.warning(f"[_build_id_based_counts] class_id remap after palette reorder failed: {e}")
        
        # Update class_hex_color to match the new order
        if self.class_hex_color is not None:
            # Create a mapping from old class names to colors
            old_color_map = {}
            if len(self.class_name) == len(self.class_hex_color):
                for i, name in enumerate(self.class_name):
                    if isinstance(name, (bytes, bytearray)):
                        name = name.decode('utf-8')
                    old_color_map[str(name)] = self.class_hex_color[i]
            
            # Build new color array based on dynamic_class_names order
            new_colors = []
            for name in dynamic_class_names:
                if name in old_color_map:
                    new_colors.append(old_color_map[name])
                elif name == 'Negative control':
                    new_colors.append('#aaaaaa')  # Default color for negative control
                else:
                    new_colors.append('#808080')  # Default color for unknown classes
            
            self.class_hex_color = np.array(new_colors)
        
        # Update class_name to match dynamic_class_names
        self.class_name = np.array(dynamic_class_names)

        # Create ID mapping
        name_to_id = {name: str(i) for i, name in enumerate(dynamic_class_names)}
        class_counts_by_id = {str(i): 0 for i in range(len(dynamic_class_names))}

        # Map counts to IDs, adding new classes as needed
        for name, count in counts_dict.items():
            normalized_name = name.decode('utf-8') if isinstance(name, (bytes, bytearray)) else str(name)
            if normalized_name in name_to_id:
                class_counts_by_id[name_to_id[normalized_name]] = count
            else:
                # Add new class
                new_id = str(len(dynamic_class_names))
                dynamic_class_names.append(normalized_name)
                name_to_id[normalized_name] = new_id
                class_counts_by_id[new_id] = count

        result = {
            'class_counts_by_id': class_counts_by_id,
            'dynamic_class_names': dynamic_class_names
        }
        return result

    def invalidate_user_counts_cache(self):
        """Invalidate all user-related caches to ensure fresh data"""
        self._user_annotation_counts_cache = None
        self._global_label_counts_cache = None
        self._needs_reload = True
        # Also clear viewport cache to ensure fresh annotation data
        if hasattr(self, '_viewport_cache'):
            self._viewport_cache.clear()

    def get_global_nuclei_label_counts(self) -> Dict[str, Any]:
        """
        Compute global nuclei label counts across the entire slide using the
        effective in-memory class assignments (model + manual overrides).

        Returns a dict:
          {
            'total_cells': int,
            'class_counts_by_id': { '0': int, '1': int, ... },
            'dynamic_class_names': [str, ...],
            'class_hex_colors': [str, ...]
          }
        """
        # Use caching for performance - total_counts is called frequently
        # Check cache first to avoid expensive recalculations
        current_file = self.get_current_file_path()
        if hasattr(self, '_global_label_counts_cache') and self._global_label_counts_cache is not None:
            # Check if cache is still valid (file hasn't changed)
            cached_file, cached_result = self._global_label_counts_cache
            if cached_file == current_file:
                return cached_result

        # Only load if handler doesn't have zarr_file set
        # Note: centroids check is done later only if needed for total_cells calculation
        if self.zarr_file is None:
            if not current_file:
                return {
                    'total_cells': 0,
                    'class_counts_by_id': {},
                    'dynamic_class_names': [],
                    'class_hex_colors': [],
                }
            self.load_file(current_file, force_reload=False, reload_segmentation_data=False)
        
        # Load centroids only if needed for total_cells (lazy loading)
        if self.centroids is None and self.zarr_file is not None:
            # Only reload segmentation data if we need centroids for total_cells
            self.load_file(current_file, force_reload=False, reload_segmentation_data=True)

        # IMPORTANT: Ensure manual annotations are applied before calculating counts
        # This is critical because save_annotation may have updated the Zarr file,
        # but the handler's in-memory class_id may not reflect the latest changes
        # until _apply_manual_nuclei_annotations is called
        if self.zarr_file is not None and os.path.exists(self.zarr_file):
            try:
                if self._zarr_file_obj is not None:
                    zarr_file = self._zarr_file_obj
                else:
                    zarr_file = open_zarr(self.zarr_file, 'r')
                    self._zarr_file_obj = zarr_file
                
                # Re-apply manual annotations to ensure class_id is up-to-date
                # This is especially important after save_annotation updates
                self._apply_manual_nuclei_annotations(zarr_file)
            except Exception as e:
                # Log but don't fail - we'll use existing class_id if re-application fails
                logger.warning(f"[get_global_nuclei_label_counts] Failed to re-apply manual annotations: {e}")

        total_cells = int(len(self.centroids)) if self.centroids is not None else 0

        # If there is no classification palette, return zeros
        if self.class_name is None or self.class_id is None:
            result = {
                'total_cells': total_cells,
                'class_counts_by_id': {},
                'dynamic_class_names': [],
                'class_hex_colors': []
            }
            # No caching needed for Zarr
            return result

        # class_ids is the source of truth for per-cell class assignment now —
        # _apply_manual_nuclei_annotations() above already overlays the user's
        # User-Annotations/cell rows onto self.class_id, so no separate
        # reclassification pass is needed here.
        try:
            class_ids = np.array(self.class_id)
        except Exception:
            class_ids = self.class_id

        # Count only labeled nuclei (class_id >= 0)
        labeled_mask = (class_ids >= 0)
        safe_ids = class_ids[labeled_mask] if hasattr(labeled_mask, '__len__') else class_ids
        if safe_ids is None or (hasattr(safe_ids, 'size') and safe_ids.size == 0) or (isinstance(safe_ids, list) and len(safe_ids) == 0):
            bincount = np.array([], dtype=int)
        else:
            max_id = int(np.max(safe_ids)) if hasattr(safe_ids, 'size') and safe_ids.size > 0 else int(max(safe_ids))
            bincount = np.bincount(safe_ids.astype(int), minlength=max(len(self.class_name), max_id + 1))

        # Normalize lengths and types
        names_list = list(self.class_name) if self.class_name is not None else []
        colors_list = list(self.class_hex_color) if self.class_hex_color is not None else []
        # Decode bytes if present
        names_list = [n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n) for n in names_list]
        colors_list = [c.decode('utf-8') if isinstance(c, (bytes, bytearray)) else str(c) for c in colors_list]
        
        # Priority: user_annotation.attrs['class_colors'] (updated by save_annotation/update_class_color) > self.class_hex_color (from ClassificationNode)
        # user_annotation.attrs['class_colors'] contains user's manual annotation colors (most up-to-date)
        try:
            if self._zarr_file_obj is not None:
                zarr_file = self._zarr_file_obj
            elif self.zarr_file and os.path.exists(self.zarr_file):
                zarr_file = open_zarr(self.zarr_file, 'r')
                self._zarr_file_obj = zarr_file
            else:
                zarr_file = None
            
            if zarr_file is not None and 'User-Annotations' in zarr_file:
                user_anno_names, user_anno_colors = read_user_anno_class_palette(
                    zarr_file['User-Annotations'], 'cell',
                )
                # Build color map from user_annotation metadata and overlay onto colors_list
                if user_anno_names and len(user_anno_names) == len(user_anno_colors):
                    color_map = {name: color for name, color in zip(user_anno_names, user_anno_colors)}
                    for i, name in enumerate(names_list):
                        if name in color_map:
                            colors_list[i] = str(color_map[name])
        except Exception as e:
            # Log and continue: failure to read user_annotation colors is non-fatal
            logger.warning(f"Failed to read user_annotation colors: {e}")

        # Ensure bincount length matches number of classes
        num_classes = len(names_list)
        if bincount.shape[0] < num_classes:
            pad = np.zeros(num_classes - bincount.shape[0], dtype=int)
            bincount = np.concatenate([bincount, pad])
        elif bincount.shape[0] > num_classes:
            bincount = bincount[:num_classes]

        class_counts_by_id = {str(i): int(bincount[i]) for i in range(num_classes)}

        result = {
            'total_cells': total_cells,
            'class_counts_by_id': class_counts_by_id,
            'dynamic_class_names': names_list,
            'class_hex_colors': colors_list
        }

        # Cache result for performance (invalidate when annotations change)
        current_file = self.get_current_file_path()
        self._global_label_counts_cache = (current_file, result)
        
        return result

    def invalidate_global_counts_cache(self):
        # No caching needed for Zarr files
        pass

    def get_all_patch_counts(self) -> Dict[str, Any]:
        """Return per-class patch counts computed live from User-Annotations/patch.

        Counts come from np.bincount on the dense structured-array `class` column
        — no cache, no JSON-bytes blob. Class names come from
        Patch-Classification/classes/name (or the in-memory handler state) so
        the integer indices in User-Annotations/patch resolve consistently.

        Returns:
            {'class_counts_by_id': {str(i): count, ...}, 'dynamic_class_names': [name, ...]}
        """
        dynamic_class_names: List[str] = []
        if self.patch_class_name is not None and len(self.patch_class_name) > 0:
            dynamic_class_names = [
                n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n)
                for n in self.patch_class_name
            ]
        elif self.zarr_file and os.path.exists(self.zarr_file):
            try:
                with open_zarr_cm(self.zarr_file, 'r') as zarr_file:
                    patch_prefix = self.get_patch_classification_prefix()
                    if patch_prefix in zarr_file and 'classes/name' in zarr_file[patch_prefix]:
                        raw_names = zarr_file[patch_prefix]['classes/name'][:]
                        dynamic_class_names = [
                            n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n)
                            for n in raw_names
                        ]
            except Exception as e:
                print(f"[get_all_patch_counts] failed to load class names: {e}")

        if 'Negative control' not in dynamic_class_names:
            dynamic_class_names = ['Negative control'] + dynamic_class_names
        elif dynamic_class_names and dynamic_class_names[0] != 'Negative control':
            dynamic_class_names = ['Negative control'] + [n for n in dynamic_class_names if n != 'Negative control']

        num_classes = len(dynamic_class_names)
        class_counts_by_id: Dict[str, int] = {str(i): 0 for i in range(num_classes)}

        if num_classes > 0 and self.zarr_file and os.path.exists(self.zarr_file):
            try:
                with open_zarr_cm(self.zarr_file, 'r') as zarr_file:
                    if 'User-Annotations' in zarr_file and 'patch' in zarr_file['User-Annotations']:
                        parr = zarr_file['User-Annotations/patch'][:]
                        if hasattr(parr.dtype, 'names') and parr.dtype.names and 'class' in parr.dtype.names:
                            ci = parr['class']
                            valid = ci[(ci >= 0) & (ci < num_classes)]
                            if valid.size > 0:
                                counts = np.bincount(valid, minlength=num_classes)
                                for i in range(num_classes):
                                    class_counts_by_id[str(i)] = int(counts[i])
            except Exception as e:
                print(f"[get_all_patch_counts] count compute failed: {e}")

        return {'class_counts_by_id': class_counts_by_id, 'dynamic_class_names': dynamic_class_names}

    def invalidate_patch_counts_cache(self):
        # No caching needed for Zarr files
        pass

    def save_class_metadata(self, class_names: list, class_colors: list, zarr_file_path: str):
        """
        Save class names and colors as metadata in Zarr file using group attributes.
        This is more efficient than storing as datasets.
        """
        try:
            with open_zarr_cm(zarr_file_path, 'a') as zarr_file:
                classification_prefix = self.get_classification_prefix()
                
                # Create or get the classification group
                if classification_prefix not in zarr_file:
                    group = zarr_file.create_group(classification_prefix)
                else:
                    group = zarr_file[classification_prefix]
                
                # Store class information as group attributes
                group.attrs['class_names'] = class_names
                group.attrs['class_colors'] = class_colors
                group.attrs['last_updated'] = time.time()

        except Exception as e:
            print(f"[ERROR] save_class_metadata => Failed to save metadata: {e}")
            raise

    def load_class_metadata(self, zarr_file_path: str):
        """
        Load class names and colors from Zarr file metadata.
        """
        try:
            with open_zarr_cm(zarr_file_path, 'r') as zarr_file:
                classification_prefix = self.get_classification_prefix()
                
                if classification_prefix in zarr_file:
                    group = zarr_file[classification_prefix]
                    
                    # Load from group attributes
                    if hasattr(group, 'attrs'):
                        class_names = group.attrs.get('class_names', [])
                        class_colors = group.attrs.get('class_colors', [])
                        
                        if class_names and class_colors:
                            return class_names, class_colors

                return [], []
                
        except Exception as e:
            print(f"[ERROR] load_class_metadata => Failed to load metadata: {e}")
            return [], []

    def update_class_color_in_zarr(self, class_name: str, new_color: str):
        """
        Updates the color for a given class name in the Zarr file.

        This method updates the colormap only (not individual annotation colors):
        1. If a classification model has been run, it updates the canonical color
           in the `/ClassificationNode/class_colors` attributes.
        2. It updates the colormap in `/user_annotation/` group attributes 
           (`class_colors` and `class_names`).
        3. It updates tissue/patch annotation colors if applicable.

        Note: The frontend reads colors from the colormap, so we don't need to
        update individual `cell_color` fields in annotations, which is slow for
        large datasets.
        """
        if not self.zarr_file or not os.path.exists(self.zarr_file):
            raise ValueError("A valid Zarr file is not loaded.")

        with open_zarr_cm(self.zarr_file, 'r+') as zarr_file:
            # --- 1. Update ClassificationNode attributes (current format) ---
            classification_prefix = self.get_classification_prefix()
            if classification_prefix in zarr_file:
                group = zarr_file[classification_prefix]
                
                # Check if data is stored as attributes (current format)
                if hasattr(group, 'attrs') and 'class_names' in group.attrs and 'class_colors' in group.attrs:
                    class_names = group.attrs.get('class_names', [])
                    class_colors = group.attrs.get('class_colors', [])
                    
                    # Directly modify the list (attrs are mutable)
                    if class_name in class_names:
                        class_index = class_names.index(class_name)
                        class_colors[class_index] = new_color
                        
                        # Update attributes (list is already modified, but ensure it's saved)
                        group.attrs['class_colors'] = class_colors
                        group.attrs['last_updated'] = time.time()
                    else:
                        print(f"Warning: Class '{class_name}' not found in ClassificationNode attributes")
                
                # Fallback: Check for old dataset format (legacy)
                elif 'classes/name' in group and 'classes/color' in group:
                    raw_names = safe_load_zarr_dataset(group['classes/name'])
                    if raw_names is not None:
                        class_names = [name.decode('utf-8') for name in raw_names]
                        if class_name in class_names:
                            class_index = class_names.index(class_name)
                            color_dataset = group['classes/color']
                            
                            # Ensure dataset is writeable
                            if color_dataset.dtype.kind == 'S':
                                color_dataset[class_index] = new_color.encode('utf-8')
                            else:
                                 print(f"Warning: Color dataset in ClassificationNode is not of string type.")
                    else:
                        print(f"Warning: Failed to load nuclei_class_name from ClassificationNode")

            # --- 2. Update Manual Nuclei Annotations colormap (structured array format) ---
            # Note: We only update the colormap, not individual cell_color fields.
            # The frontend reads colors from the colormap (nucleiClasses[class_id].color),
            # so updating cell_color is redundant and slow for large datasets.
            user_annot_group_path = 'User-Annotations'
            if user_annot_group_path in zarr_file:
                user_anno_group = zarr_file[user_annot_group_path]
                
                # Update user_annotation.attrs['class_colors'] if it exists (this is the colormap)
                user_class_names, user_class_colors = read_user_anno_class_palette(user_anno_group, 'cell')
                if user_class_names and user_class_colors:
                    # Directly modify the list (attrs are mutable)
                    if class_name in user_class_names:
                        class_index = user_class_names.index(class_name)
                        user_class_colors[class_index] = new_color
                        write_user_anno_class_palette(user_anno_group, 'cell', user_class_names, user_class_colors)

            # --- 3. Refresh per-row color in User-Annotations/patch ---
            # The patch annotation is a dense structured array (class is an
            # int index into the patch palette). Resolve the class index for
            # `class_name`, then vectorise the color update for every row
            # whose class matches.
            patch_path = f"{user_annot_group_path}/patch"
            if patch_path in zarr_file:
                try:
                    patch_ds = zarr_file[patch_path]
                    patch_arr = patch_ds[:]
                    if patch_arr.dtype.names and 'class' in patch_arr.dtype.names and 'color' in patch_arr.dtype.names:
                        # Look up class index from the patch palette.
                        names, _ = read_user_anno_class_palette(user_anno_group, 'patch')
                        try:
                            target_idx = names.index(class_name)
                        except ValueError:
                            target_idx = -1
                        if target_idx >= 0:
                            try:
                                new_color_int = int(str(new_color).lstrip('#'), 16)
                            except (TypeError, ValueError):
                                new_color_int = -1
                            if new_color_int >= 0:
                                mask = patch_arr['class'] == target_idx
                                if mask.any():
                                    patch_arr['color'][mask] = new_color_int
                                    del zarr_file[patch_path]
                                    create_array(zarr_file, patch_path, data=patch_arr, dtype=patch_arr.dtype, overwrite=True)
                except Exception as e:
                    # Non-fatal — colormap on the group will already show the new color.
                    print(f"Info: Skipped patch annotation color refresh: {e}")

            # Zarr files don't need explicit flush - changes are automatically persisted

        # --- 4. Invalidate Cache and Update In-Memory State ---
        # Clear caches only (no need to reload file, we've already updated Zarr and memory)

    def update_patch_class_color_in_zarr(self, class_name: str, new_color: str):
        """
        Updates the color for a given patch classification class name in the Zarr file.
        
        This method updates the colormap in MuskNode:
        1. Updates the canonical color in `/Patch-Classification/classes/color` (attributes or dataset format).
        2. Updates the colormap in `/user_annotation/` group attributes if applicable.
        """
        if not self.zarr_file or not os.path.exists(self.zarr_file):
            raise ValueError("A valid Zarr file is not loaded.")

        with open_zarr_cm(self.zarr_file, 'r+') as zarr_file:
            # Update patch classification colors in MuskNode
            patch_classification_prefix = self.get_patch_classification_prefix()
            
            if patch_classification_prefix in zarr_file:
                patch_group = zarr_file[patch_classification_prefix]
                
                # Check if data is stored as attributes (current format)
                if hasattr(patch_group, 'attrs') and 'classes/name' in patch_group.attrs and 'classes/color' in patch_group.attrs:
                    patch_class_names = patch_group.attrs.get('classes/name', [])
                    patch_class_colors = patch_group.attrs.get('classes/color', [])
                    
                    # Directly modify the list (attrs are mutable)
                    if class_name in patch_class_names:
                        patch_class_index = patch_class_names.index(class_name)
                        patch_class_colors[patch_class_index] = new_color
                        
                        # Update attributes (list is already modified, but ensure it's saved)
                        patch_group.attrs['classes/color'] = patch_class_colors
                        patch_group.attrs['last_updated'] = time.time()
                    else:
                        print(f"Warning: Class '{class_name}' not found in {patch_classification_prefix} attributes. Available classes: {patch_class_names}")
                
                # Fallback: Check for old dataset format (legacy)
                elif 'classes/name' in patch_group and 'classes/color' in patch_group:
                    raw_patch_names = safe_load_zarr_dataset(patch_group['classes/name'])
                    if raw_patch_names is not None:
                        patch_class_names = [name.decode('utf-8') if isinstance(name, (bytes, bytearray)) else str(name) for name in raw_patch_names]
                        if class_name in patch_class_names:
                            patch_class_index = patch_class_names.index(class_name)
                            patch_color_dataset = patch_group['classes/color']
                            if patch_color_dataset.dtype.kind == 'S':
                                patch_color_dataset[patch_class_index] = new_color.encode('utf-8')
                            else:
                                print(f"Warning: Color dataset in {patch_classification_prefix} is not of string type: {patch_color_dataset.dtype}")
                        else:
                            print(f"Warning: Class '{class_name}' not found in {patch_classification_prefix} dataset. Available classes: {patch_class_names}")
                    else:
                        print(f"Warning: Failed to load tissue_class_name from {patch_classification_prefix}")
                else:
                    print(f"Warning: Neither attributes nor dataset format found in {patch_classification_prefix}")

            # Patch-Classification/classes/color is now the canonical color
            # source (written above); no separate user_annotation.attrs mirror.

        # Invalidate cache
        self._user_annotation_counts_cache = None
        self._global_label_counts_cache = None  # Clear cell distribution cache
        
        # Force reload on next patch request to ensure updated colors are used
        # This ensures get_patch_centroids_in_viewport will see the updated colors

        # Update in-memory patch_class_hex_color to reflect the new color
        # This ensures get_patch_centroids_in_viewport and other functions see the updated color immediately
        if self.patch_class_name is not None:
            # Convert to list for easier manipulation
            patch_class_name_list = list(self.patch_class_name) if hasattr(self.patch_class_name, '__iter__') else []
            if class_name in patch_class_name_list:
                patch_class_index = patch_class_name_list.index(class_name)
                if self.patch_class_hex_color is not None:
                    # Convert to list for easier manipulation, then convert back to original format
                    was_numpy = isinstance(self.patch_class_hex_color, np.ndarray)
                    if was_numpy:
                        color_list = self.patch_class_hex_color.tolist()
                    else:
                        color_list = list(self.patch_class_hex_color) if hasattr(self.patch_class_hex_color, '__iter__') else []
                    
                    # Ensure the list is long enough
                    while len(color_list) <= patch_class_index:
                        color_list.append('#aaaaaa')
                    
                    # Update the color
                    old_color = color_list[patch_class_index] if patch_class_index < len(color_list) else None
                    color_list[patch_class_index] = new_color
                    
                    # Convert back to original format
                    # Ensure all colors are strings (not bytes) for consistency
                    color_list = [str(c) for c in color_list]
                    if was_numpy:
                        # Use string dtype to ensure colors are stored as strings
                        self.patch_class_hex_color = np.array(color_list, dtype='U')
                    else:
                        self.patch_class_hex_color = color_list
                else:
                    print(f"[DEBUG] update_patch_class_color_in_zarr: patch_class_hex_color is None, cannot update")
            else:
                print(f"[DEBUG] update_patch_class_color_in_zarr: Class '{class_name}' not found in patch_class_name: {patch_class_name_list}")


    def _delete_class_from_cell_classification(self, zarr_file, class_name: str) -> None:
        """Drop ``class_name`` from the Cell-Classification palette and move the
        model predictions with it.

        ``class_indices`` numbers Cell-Classification's OWN palette, not the
        User-Annotations one — nothing keeps the two orderings in step (see
        ``_clear_contradicted_predictions``), so the slot is located by name
        here. Shortening the palette without renumbering the ids leaves every
        class above the deleted one pointing at its neighbour.
        """
        grp_name = ZarrGroups.CELL_CLASSIFICATION
        if grp_name not in zarr_file:
            return
        group = zarr_file[grp_name]

        def decode(values):
            return [v.decode('utf-8') if isinstance(v, (bytes, bytearray)) else str(v) for v in values]

        names = decode(group.attrs.get('class_names', []) or [])
        colors = decode(group.attrs.get('class_colors', []) or [])
        if class_name not in names:
            return
        deleted_idx = names.index(class_name)
        if len(colors) != len(names):
            colors = ['#808080'] * len(names)

        new_names = [n for i, n in enumerate(names) if i != deleted_idx]
        new_colors = [c for i, c in enumerate(colors) if i != deleted_idx]

        # The deleted class becomes unclassified; everything above it slides down
        # one slot to follow the palette. Written back in place: the shape does
        # not change, so this is one pass over the ids with no second copy.
        if 'class_indices' in group:
            ids = np.asarray(group['class_indices'][()])
            ids[ids == deleted_idx] = -1  # -1 is never > deleted_idx, so order is safe
            ids[ids > deleted_idx] -= 1
            group['class_indices'][:] = ids

        # Probabilities are one column per class, in the same order. Shift the
        # columns after the deleted one left, then shrink the array.
        #
        # Only columns >= deleted_idx move, and the array is chunked along the
        # column axis too, so the read and the write are both restricted to that
        # slice — touching the whole row band instead cost 2-8x as much (960 ms
        # vs 440 ms deleting the middle class of 20 on a 2M-cell slide; the write
        # is ~4x more expensive than the read, so narrowing it is what pays).
        # Row blocks are whole chunks: a partial one turns every write into a
        # read-modify-write of the chunks it straddles.
        probs = group['probabilities'] if 'probabilities' in group else None
        if probs is not None and probs.ndim == 2 and probs.shape[1] == len(names):
            n_rows, n_cols = int(probs.shape[0]), int(probs.shape[1])
            if deleted_idx < n_cols - 1:
                moved_cols = n_cols - deleted_idx - 1
                chunk_rows = max(1, int(probs.chunks[0]))
                chunk_bytes = max(1, chunk_rows * moved_cols * probs.dtype.itemsize)
                block = chunk_rows * max(1, PROB_REINDEX_BLOCK_BYTES // chunk_bytes)
                for start in range(0, n_rows, block):
                    stop = min(start + block, n_rows)
                    probs[start:stop, deleted_idx:-1] = probs[start:stop, deleted_idx + 1:]
            probs.resize((n_rows, n_cols - 1))

        # classes/{index,name,color} is the parallel array form other readers
        # bridge through (see the negative-selection remap above).
        if 'classes' in group:
            classes_grp = group['classes']
            create_array(classes_grp, 'index', data=np.arange(len(new_names), dtype=np.int32), overwrite=True)
            create_array(classes_grp, 'name',
                         data=np.array([n.encode('utf-8') for n in new_names], dtype='S256'), overwrite=True)
            create_array(classes_grp, 'color',
                         data=np.array([c.encode('utf-8') for c in new_colors], dtype='S256'), overwrite=True)

        group.attrs['class_names'] = new_names
        group.attrs['class_colors'] = new_colors
        group.attrs['last_updated'] = time.time()
        logger.info(
            f"[delete_class] reindexed Cell-Classification predictions after removing "
            f"'{class_name}' at index {deleted_idx} ({len(names)} -> {len(new_names)} classes)"
        )

    def delete_class_in_zarr(self, class_name: str, reassign_to: str = "Negative control") -> Dict[str, Any]:
        """
        Persistently delete a nuclei class from the Zarr file.

        Steps:
        - Remove the deleted class from name/color arrays.
        - Remap nuclei_class_id: nuclei of the deleted class -> UNCLASSIFIED (-1), and shift indices above the deleted index down by 1.
        - Do the same for the model side (Cell-Classification palette,
          class_indices, probabilities) via
          ``_delete_class_from_cell_classification`` — that palette is numbered
          independently of this one.
        - Remove manual nuclei annotations for this class and persist updated counts.
        - Invalidate caches so future reads reflect changes.
        """
        if not self.zarr_file or not os.path.exists(self.zarr_file):
            raise ValueError("A valid Zarr file is not loaded.")

        if class_name == "Negative control":
            raise ValueError("Cannot delete 'Negative control' class.")

        affected = 0
        reassigned_to_name = None

        with open_zarr_cm(self.zarr_file, 'r+') as zarr_file:
            # Only process data stored in user_annotation (current format)
            if 'User-Annotations' not in zarr_file:
                return {"message": "Success", "affected_nuclei": 0, "reassigned_to": None}
            
            user_annotation_group = zarr_file['User-Annotations']
            base_name = 'cell'
            
            # Only support structured array format
            if base_name not in user_annotation_group:
                return {"message": "Success", "affected_nuclei": 0, "reassigned_to": None}
            
            try:
                # Load structured array. `[:]` already hands back a fresh array, so
                # wrapping it in np.array() only bought a second 176 MB copy.
                manual_annotations = user_annotation_group[base_name][:]
                cell_class_ids = manual_annotations['class']
                # Snapshot: the reindex below rewrites this column, so every mask
                # has to be taken against the ids as they were on disk.
                orig_class_ids = np.array(cell_class_ids, copy=True)
                
                # Get class palette from metadata to find class index (cell context)
                class_names, class_colors = read_user_anno_class_palette(user_annotation_group, 'cell')

                if not class_names:
                    return {"message": "Error", "error": "No class_names found in metadata"}

                # Find class index
                try:
                    class_index = class_names.index(class_name)
                except ValueError:
                    print(f"Class '{class_name}' not found in class_names")
                    return {"message": "Success", "affected_nuclei": 0, "reassigned_to": None}

                # Set once the in-memory array diverges from the store; every path
                # out of here has to flush it exactly once.
                annotations_dirty = False

                # Remove the deleted class from class_names and class_colors in metadata
                # so the colormap is updated immediately.
                if class_colors and class_index < len(class_colors):
                    updated_class_names = [name for i, name in enumerate(class_names) if i != class_index]
                    updated_class_colors = [color for i, color in enumerate(class_colors) if i != class_index]
                    write_user_anno_class_palette(user_annotation_group, 'cell', updated_class_names, updated_class_colors)
                    # Update class_names variable for subsequent processing
                    class_names = updated_class_names

                    # The palette just lost a slot, so every annotation above it now
                    # names the wrong class. Shift them down to match — this is the
                    # "shift indices above the deleted index down by 1" step in the
                    # docstring, and without it deleting a class silently relabels
                    # every annotation that came after it.
                    shifted = orig_class_ids > class_index
                    manual_annotations['class'][shifted] = orig_class_ids[shifted] - 1
                    # "not this type" rows encode their class as -(2 + index), so they
                    # move the same way; a constraint naming the deleted class is void.
                    weak_deleted = orig_class_ids == -(2 + class_index)
                    weak_above = orig_class_ids < -(2 + class_index)
                    manual_annotations['class'][weak_deleted] = -1
                    manual_annotations['class'][weak_above] = orig_class_ids[weak_above] + 1
                    # Not written yet: the clear-out below edits the same array, and
                    # one write of it costs ~235 ms per 2M cells. The early return
                    # for `affected == 0` flushes this on its way out.
                    annotations_dirty = bool(np.any(shifted) or np.any(weak_above) or np.any(weak_deleted))
                    if annotations_dirty:
                        logger.info(
                            f"[delete_class] reindexed {int(np.sum(shifted))} annotations and "
                            f"{int(np.sum(weak_above))} weak marks after removing '{class_name}' "
                            f"at index {class_index}"
                        )

                # The model keeps its own palette, and its predictions are
                # numbered against that one. Do this here rather than after the
                # `affected == 0` return below: deleting a class nobody labelled
                # by hand but the model DID predict is the ordinary case, and it
                # leaves through that return.
                try:
                    self._delete_class_from_cell_classification(zarr_file, class_name)
                except Exception as e:
                    logger.warning(
                        f"[delete_class] Cell-Classification reindex failed for '{class_name}': {e}"
                    )

                # Count affected nuclei (against the ids as they were on disk)
                affected = np.sum(orig_class_ids == class_index)
                
                if affected == 0:
                    print(f"Class '{class_name}' (index {class_index}) not found in user_annotation")
                    if annotations_dirty:
                        user_annotation_group[base_name][:] = manual_annotations
                    return {"message": "Success", "affected_nuclei": 0, "reassigned_to": None}
                
                # Clear annotations for this class (set to -1 = unclassified)
                mask = orig_class_ids == class_index
                manual_annotations['class'][mask] = -1
                manual_annotations['color'][mask] = -1  # -1 means not set (0 = black is a valid color)
                manual_annotations['annotator'][mask] = ''
                # Reset datetime: timestamp format (int64), 0 means not set
                if 'datetime' in manual_annotations.dtype.names:
                    if manual_annotations['datetime'].dtype.kind in ['i', 'u']:
                        manual_annotations['datetime'][mask] = 0
                    else:
                        logger.warning(f"[delete_class] Unexpected datetime dtype: {manual_annotations['datetime'].dtype}. Expected integer timestamp.")
                manual_annotations['method'][mask] = ''
                # Reset region geometry fields (stored as 4 integers)
                if 'region_x1' in manual_annotations.dtype.names:
                    manual_annotations['region_x1'][mask] = -1
                    manual_annotations['region_y1'][mask] = -1
                    manual_annotations['region_x2'][mask] = -1
                    manual_annotations['region_y2'][mask] = -1
                else:
                    logger.warning(f"[delete_class] region_x1 field not found in annotations dtype. Expected structured array format.")
                
                # Update structured array
                user_annotation_group[base_name][:] = manual_annotations
                # Drop selection-geometry entries orphaned by the class delete.
                try:
                    from app.services.tasks import prune_orphan_selection_geometry
                    prune_orphan_selection_geometry(user_annotation_group, 'cell')
                except Exception as e:
                    try:
                        logger.error(f"orphan selection-geometry prune failed: {e}", exc_info=True)
                    except Exception:
                        pass

            except Exception as e:
                print(f"[Error] Failed to delete class from structured array format: {e}")
                return {"message": f"Error: {str(e)}", "affected_nuclei": 0, "reassigned_to": None}
            
            # Update class_counts
            if 'cell_class_counts' in user_annotation_group:
                try:
                    raw_counts = user_annotation_group['cell_class_counts'][()]
                    counts_dict = json.loads(raw_counts.decode('utf-8') if isinstance(raw_counts, (bytes, bytearray)) else raw_counts)
                    counts_dict.pop(class_name, None)  # Remove the deleted class
                    
                    del user_annotation_group['cell_class_counts']
                    _counts_bytes = json.dumps(counts_dict).encode('utf-8')
                    create_array(
                        user_annotation_group,
                        'cell_class_counts',
                        data=np.array(_counts_bytes, dtype=f"S{max(1, len(_counts_bytes))}"),
                        overwrite=True,
                    )
                except Exception as e:
                    print(f"Warning: Failed to update class_counts: {e}")
            
            # Update user_annotation.attrs and ClassificationNode with remaining class information
            try:
                # Extract remaining class names and colors from structured array.
                # `manual_annotations` was written back above, so it already IS the
                # on-disk state — re-reading it cost a second full pass over the
                # array (176 MB on a 2M-cell slide).
                remaining_classes = {}
                cell_class_ids = manual_annotations['class']
                cell_color_data = manual_annotations['color']
                
                # Get class_names from metadata (cell context)
                class_names, _ = read_user_anno_class_palette(user_annotation_group, 'cell')

                if class_names:
                    # Find all non-empty annotations (new format: -1 = unclassified, 0+ = class index)
                    # cell_color is now int32 (-1 = not set, 0 = black is valid)
                    non_empty_mask = (cell_class_ids >= 0) & (cell_color_data >= 0)
                    if np.any(non_empty_mask):
                        valid_class_ids = cell_class_ids[non_empty_mask]
                        valid_colors_int = cell_color_data[non_empty_mask]
                        from app.services.tasks import _int_color_to_hex
                        # One colour per class, taken from that class's first
                        # labelled cell. Converting every labelled cell up front
                        # threw all but a handful of the results away.
                        for class_id in np.unique(valid_class_ids):
                            if 0 <= class_id < len(class_names):
                                # np.unique guarantees a match, so argmax is the first one.
                                first_idx = int(np.argmax(valid_class_ids == class_id))
                                cls_color = _int_color_to_hex(valid_colors_int[first_idx])
                                if cls_color:
                                    remaining_classes[class_names[class_id]] = cls_color
                
                if remaining_classes:
                    # Refresh colours only. The palette itself was already updated
                    # above (and the annotation indices shifted to match it);
                    # rebuilding it from whatever the annotations happen to mention
                    # would drop every class nobody has labelled yet and renumber the
                    # rest out from under the stored indices.
                    palette_names, palette_colors = read_user_anno_class_palette(user_annotation_group, 'cell')
                    refreshed_colors = [
                        remaining_classes.get(name, palette_colors[i] if i < len(palette_colors) else "")
                        for i, name in enumerate(palette_names)
                    ]
                    write_user_anno_class_palette(user_annotation_group, 'cell', palette_names, refreshed_colors)

                    # Refresh the model palette's COLOURS only, matched by name.
                    # Its class list is its own (class_indices is numbered against
                    # it, and _delete_class_from_cell_classification above already
                    # took the deleted slot out of both) — assigning the
                    # User-Annotations list here renumbered every prediction
                    # whenever the two orderings differed.
                    if 'Cell-Classification' in zarr_file:
                        classification_group = zarr_file['Cell-Classification']
                        model_names = [str(n) for n in classification_group.attrs.get('class_names', []) or []]
                        if model_names:
                            model_colors = [str(c) for c in classification_group.attrs.get('class_colors', []) or []]
                            color_by_name = dict(zip(palette_names, refreshed_colors))
                            updated = [
                                color_by_name.get(name, model_colors[i] if i < len(model_colors) else "")
                                for i, name in enumerate(model_names)
                            ]
                            classification_group.attrs['class_colors'] = updated
                            # classes/color is the same palette in array form; leaving
                            # it behind would give the group two disagreeing colour
                            # lists (the readers pick different ones).
                            if 'classes' in classification_group and 'color' in classification_group['classes']:
                                create_array(
                                    classification_group['classes'], 'color',
                                    data=np.array([c.encode('utf-8') for c in updated], dtype='S256'),
                                    overwrite=True,
                                )
                            classification_group.attrs['last_updated'] = time.time()

            except Exception as e:
                print(f"Warning: Failed to update user_annotation.attrs and ClassificationNode: {e}")

            # Invalidate caches so future reads reflect changes
            self.invalidate_user_counts_cache()
            
            return {"message": "Success", "affected_nuclei": affected, "reassigned_to": reassigned_to_name}


# ==================== API support helpers ====================
# Thin functions that own the request-shaped logic previously inlined in app.api.seg,
# keeping the API layer a pure forwarding layer.

def build_mask_binary_response(result: Dict) -> Tuple[bytes, Dict[str, str]]:
    """Pack a segmentation-mask result dict into binary content and HTTP headers."""
    import struct

    data_bytes = result["data"]
    shape = result["shape"]
    offset = result.get("offset", [0, 0])
    full_shape = result.get("full_shape", shape)
    tissue_class = result.get("class")
    tissue_class_bytes = tissue_class.encode('utf-8') if tissue_class else b""

    # Header: success + shape0 + shape1 + offset_x + offset_y + full_shape0 + full_shape1
    #         + data_len + tissue_class_len  (9 * 4 = 36 bytes, little-endian)
    header = struct.pack(
        '<IIIIIIIII',
        1,
        shape[0], shape[1],
        offset[0], offset[1],
        full_shape[0], full_shape[1],
        len(data_bytes), len(tissue_class_bytes),
    )
    content = header + data_bytes + tissue_class_bytes

    headers = {
        "X-Mask-Shape": f"{shape[0]},{shape[1]}",
        "X-Mask-Offset": f"{offset[0]},{offset[1]}",
        "X-Mask-Full-Shape": f"{full_shape[0]},{full_shape[1]}",
    }
    region_size = result.get("region_size", None)
    if region_size:
        headers["X-Mask-Region-Size"] = f"{region_size[0]},{region_size[1]}"
    if tissue_class:
        headers["X-Tissue-Class"] = tissue_class
    return content, headers


def save_annotation_batch_service(instance_id: str, req: Dict) -> Dict:
    """Batch-mark nuclei/tissue as ground truth for a region.

    Requires an existing instance handler (bound via set_path). Raises ValueError
    on invalid input.
    """
    from app.services.seg_registry import get_annotation_handler

    if not instance_id:
        raise ValueError("instance_id is required")

    path = req.get("path", "")
    for key in ["path", "zarr_path", "file_path"]:
        if key in req and isinstance(req.get(key), str):
            req[key] = resolve_path(req[key])
    req["instance_id"] = instance_id

    from app.services.load import get_session_data
    session_data = get_session_data(instance_id)
    session_path_raw = session_data.get("current_file_path")
    request_path_raw = req.get("path")
    if session_path_raw and request_path_raw:
        session_zarr = as_zarr_path(str(session_path_raw))
        request_zarr = as_zarr_path(resolve_path(request_path_raw))
        session_abs = os.path.realpath(resolve_path(session_zarr))
        request_abs = os.path.realpath(resolve_path(request_zarr))
        if session_abs != request_abs:
            raise ValueError("Session file path and request path must point to the same Zarr file")

    if session_path_raw:
        zarr_path = resolve_path(as_zarr_path(str(session_path_raw)))
    else:
        zarr_path = resolve_path(request_path_raw) if request_path_raw else None
    if not zarr_path or not os.path.exists(zarr_path):
        raise ValueError("No Zarr path available or file not found")

    handler = get_annotation_handler(instance_id)
    if handler is None:
        raise ValueError("No segmentation handler for instance; open the slide first")
    handler.ensure_file(zarr_path, need_centroids=True)

    annotation_type = req.get("annotation_type", "nuclei")
    x1, y1, x2, y2 = req.get("x1"), req.get("y1"), req.get("x2"), req.get("y2")
    polygon_points = req.get("polygon_points")
    cell_indices = req.get("cell_indices")  # optional: only mark these cell ids
    has_cell_indices = isinstance(cell_indices, list) and len(cell_indices) > 0

    # The bounding box is only used for region selection; when explicit cell ids
    # are given (e.g. review-panel saves) it is unused, so don't require it.
    if not has_cell_indices and (x1 is None or y1 is None or x2 is None or y2 is None):
        raise ValueError("Bounding box coordinates (x1, y1, x2, y2) are required")
    x1 = x1 if x1 is not None else 0
    y1 = y1 if y1 is not None else 0
    x2 = x2 if x2 is not None else 0
    y2 = y2 if y2 is not None else 0

    if annotation_type == "nuclei":
        # optional {cell_id: class_name} — listed cells use that class instead of the AI prediction
        cell_classes = req.get("cell_classes")
        result = mark_nuclei_as_ground_truth_in_region(
            handler=handler, file_path=zarr_path,
            x1=x1, y1=y1, x2=x2, y2=y2, polygon_points=polygon_points,
            cell_indices=cell_indices if has_cell_indices else None,
            cell_classes=cell_classes if isinstance(cell_classes, dict) else None,
            annotator=req.get("annotator", "Unknown"),
        )
    elif annotation_type == "tissue":
        result = mark_patches_as_ground_truth_in_region(
            handler=handler, file_path=zarr_path,
            x1=x1, y1=y1, x2=x2, y2=y2, polygon_points=polygon_points,
            annotator=req.get("annotator", "Unknown"),
        )
    else:
        raise ValueError(f"Invalid annotation_type: {annotation_type}. Must be 'nuclei' or 'tissue'")

    return {
        "message": result.get("message", "Batch annotation saved"),
        "marked_count": result.get("marked_count", 0),
        "marked_classes": result.get("marked_classes", {}),
    }


def resolve_classifier_tasknode_url(model_name: str) -> Optional[str]:
    """HTTP base URL for NuClass (ClassificationNode) or MUSK (MuskClassification) tasknode."""
    node_port = None
    node_remote_host = None
    try:
        from app.services.tasks import manager

        if model_name in manager.nodes:
            node = manager.nodes[model_name]
            node_port = getattr(node, "port", None)
            if node_port is not None:
                is_remote, remote_host, _mnt = manager._is_remote_node(model_name)
                if is_remote:
                    node_remote_host = remote_host
    except Exception as e:
        logger.warning("classifier_tasknode_save: manager lookup failed: %s", e)

    if node_port is None:
        try:
            from app.services.tasks import list_node_ports

            snap = list_node_ports(skip_health_checks=True) or {}
            nodes = snap.get("nodes") or {}
            info = nodes.get(model_name)
            if not info and isinstance(nodes, dict):
                for _k, v in nodes.items():
                    if isinstance(v, dict) and v.get("model_name") == model_name:
                        info = v
                        break
            if isinstance(info, dict):
                node_port = info.get("port")
                if not node_remote_host:
                    node_remote_host = info.get("remote_host")
        except Exception as e:
            logger.warning("classifier_tasknode_save: list_node_ports failed: %s", e)

    if node_port is None:
        node_port = 8006
        logger.warning("classifier_tasknode_save: defaulting to port %s for %s", node_port, model_name)

    host = node_remote_host or "127.0.0.1"
    return f"http://{host}:{node_port}"
