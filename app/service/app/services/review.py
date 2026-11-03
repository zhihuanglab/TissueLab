from app.config.zarr_compat import as_zarr_path, open_zarr_cm
from collections import OrderedDict
import numpy as np
import json
import logging
import contextvars
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Optional
import os
import base64
from io import BytesIO
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont
from app.utils import resolve_path
from app.services.tasks import (
    get_cell_review_tile_data,
    get_patch_review_tile_data,
    _contour_points,
    _int_color_to_hex,
    _get_annotation_dtype,
    _hex_color_to_int,
    _truncate_field,
    _safe_replace_dataset,
    _create_isolated_slide_object,
)
from app.services.seg import SegmentationHandler
from app.config.zarr_config import (
    ZarrGroups,
    ZarrDatasets,
    ZarrPaths,
    find_segmentation_group,
    read_user_anno_class_palette,
)

logger = logging.getLogger(__name__)

# ==================== CACHING ====================
# review is stateless per user. Both caches below are CONTENT-keyed, so they
# are correct to share across all users/sessions — no instance_id needed:
#   * _last_request_cache: keyed by cache_key (slide + class + threshold + …
#     + user_annotation mtime). Two users on the same slide+class share a hit.
#   * _zarr_saved_cells_cache: keyed by zarr_path, invalidated by mtime.
# A Save/Remove bumps the user_annotation mtime, which changes the key and
# invalidates stale entries.
# ==================================================

_MAX_CACHED_REQUESTS = 32  # bound memory across slides/classes/thresholds
_last_request_cache = {}   # {cache_key: {key: ..., candidate_idx: ndarray, ...}}
_request_cache_lock = threading.RLock()
# Global cache for loaded saved_cells from Zarr (shared across users for same file)
# Structure: {zarr_path: {data: Dict, mtime: float}}
# Bounded like _last_request_cache above: mtime keeps entries honest but never
# removes them, so every slide ever reviewed used to keep its saved-cell map for
# the life of the process.
_MAX_CACHED_ZARR_SAVED_CELLS = 16
_zarr_saved_cells_cache = OrderedDict()  # {zarr_path: {data: Dict, mtime: float}}
# The review routes are plain ``def``, so several run in worker threads at once,
# and bounding this cache means a key can now vanish between being found and
# being read. Hardening, not a bug fix: `k in d` then `d[k]` did not race in 18M
# measured attempts — CPython only hands the GIL over at calls and backward
# jumps, and emits neither between those two lookups. That is an implementation
# detail, and untrue on a free-threaded build, so nothing below leans on it.
_zarr_saved_cells_lock = threading.Lock()
# Per-slide arrays the cell candidate search reads (class indices, per-cell max
# probability, centroids), keyed by zarr_path and checked against a signature of
# those arrays' files. A new threshold / side / sort then re-filters in memory
# instead of re-reading the zarr, and request entries hold only candidate ids.
_MAX_CACHED_SLIDE_ARRAYS = 4
_slide_arrays_cache = OrderedDict()  # {zarr_path: {sig: tuple, centroids: ndarray, ...}}
_slide_arrays_lock = threading.Lock()
# Review tiles rendered at once per candidate page.
_TILE_WORKERS = 8


def _get_zarr_saved_cells(zarr_path: str) -> Optional[Dict]:
    """This slide's cached entry, or None. One lookup, not ``in`` then ``[]``."""
    with _zarr_saved_cells_lock:
        return _zarr_saved_cells_cache.get(zarr_path)


def _store_zarr_saved_cells(zarr_path: str, data: Dict, mtime: float) -> None:
    """Cache a slide's saved cells, evicting the least recently stored."""
    with _zarr_saved_cells_lock:
        _zarr_saved_cells_cache.pop(zarr_path, None)
        _zarr_saved_cells_cache[zarr_path] = {'data': data, 'mtime': mtime}
        while len(_zarr_saved_cells_cache) > _MAX_CACHED_ZARR_SAVED_CELLS:
            _zarr_saved_cells_cache.popitem(last=False)


def _get_request_cache(cache_key: tuple) -> Dict:
    """
    Get (or create) the cached candidate computation for this content key.

    Content-keyed and shared across all users — review holds no per-user
    state, so this is correct (and two users viewing the same slide+class
    share the cache hit). Bounded to _MAX_CACHED_REQUESTS entries.

    Locked: the review routes are plain ``def``, so several run in worker
    threads at once. Unsynchronised, two of them racing here would each build
    an entry, and the loser would spend the request filling in a dict that is
    no longer the cached one — its work silently discarded.
    """
    with _request_cache_lock:
        entry = _last_request_cache.get(cache_key)
        if entry is not None:
            return entry
        if len(_last_request_cache) >= _MAX_CACHED_REQUESTS:
            # Evict the oldest entry (dicts preserve insertion order)
            _last_request_cache.pop(next(iter(_last_request_cache)), None)
        entry = {"key": None}
        _last_request_cache[cache_key] = entry
        return entry


def _user_annotation_mtime(zarr_path: str) -> float:
    """Latest mtime of the slide's user_annotation data — a reliable
    "has it changed" signal for cache invalidation.

    The top-level .zarr directory mtime does NOT change when zarr rewrites
    chunk files in place, so caching on it serves stale data after a save.
    The user_annotation group + nuclei_annotations array directories DO get
    their mtime bumped when chunks/attrs are (re)written.
    """
    latest = 0.0
    for sub in (
        os.path.join(zarr_path, ZarrGroups.USER_ANNOTATIONS),
        os.path.join(zarr_path, ZarrGroups.USER_ANNOTATIONS, ZarrDatasets.CELL),
    ):
        try:
            latest = max(latest, os.path.getmtime(sub))
        except OSError:
            pass
    return latest


def _load_saved_cells(zarr_path: str) -> Dict:
    """
    Load saved_cells from Zarr file with caching.
    Uses global cache to avoid repeated reads of the same file.
    """
    try:
        # Check global cache first (shared across instances for same file)
        cache_entry = _get_zarr_saved_cells(zarr_path)
        if cache_entry is not None:
            # Invalidate when user_annotation has changed since we cached
            try:
                current_mtime = _user_annotation_mtime(zarr_path)
                if cache_entry.get('mtime') == current_mtime:
                    return cache_entry['data'].copy()  # Return copy to avoid mutations
            except (OSError, KeyError):
                pass  # File doesn't exist or cache is invalid, continue to load
        
        if not os.path.exists(zarr_path):
            logger.debug(f"[AL Load] Zarr file not found: {zarr_path}")
            return {}
        
        saved_data = {}
        
        # Use seg_service.py's pattern for loading manual annotations
        with open_zarr_cm(zarr_path, 'r') as zarr_file:
            # Follow seg_service.py's _apply_manual_nuclei_annotations pattern
            if ZarrGroups.USER_ANNOTATIONS not in zarr_file:
                logger.debug(f"[AL Load] No user_annotation group found in Zarr file: {zarr_path}")
                return {}

            user_annotation_group = zarr_file[ZarrGroups.USER_ANNOTATIONS]
            base_name = ZarrDatasets.CELL
            
            # Only support structured array format
            if base_name not in user_annotation_group:
                cell_class_ds = f"{base_name}_cell_class"
                if cell_class_ds in user_annotation_group:
                    logger.warning(f"[AL Load] Old separate arrays format detected. Structured array format is required.")
                elif base_name in user_annotation_group:
                    logger.warning(f"[AL Load] Deprecated JSON format detected. Structured array format is required.")
                logger.debug(f"[AL Load] No structured array format annotations found")
                return {}
            
            try:
                annotations_dataset = user_annotation_group[base_name]

                # A cell is a saved user annotation when its cell_class >= 0
                # (cell_class == -1 means unlabelled). This is the single source
                # of truth — independent of the `method` field, so it picks up
                # cells saved by the review panel, box-select, etc. alike.
                # Detect via chunked reading so a huge unlabelled dataset stays
                # cheap to scan.
                # zarr v3 cannot index a structured Array by field name; read
                # records for the slice first, then select the `class` field.
                total_size = annotations_dataset.shape[0]

                CHUNK_SIZE = 100000  # Check 100k elements at a time
                has_saved = False
                cell_class_all = None

                if total_size <= CHUNK_SIZE:
                    cell_class_all = annotations_dataset[:]['class']
                    has_saved = bool(np.any(cell_class_all >= 0))
                else:
                    for start_idx in range(0, total_size, CHUNK_SIZE):
                        end_idx = min(start_idx + CHUNK_SIZE, total_size)
                        if np.any(annotations_dataset[start_idx:end_idx]['class'] >= 0):
                            has_saved = True
                            break
                    if has_saved:
                        cell_class_all = annotations_dataset[:]['class']

                # Early return if nothing has been saved yet
                if not has_saved:
                    try:
                        mtime = _user_annotation_mtime(zarr_path)
                        _store_zarr_saved_cells(zarr_path, {}, mtime)
                    except OSError:
                        pass
                    return {}

                valid_indices = np.where(cell_class_all >= 0)[0]
                if len(valid_indices) == 0:
                    return {}
                cell_class_ids = cell_class_all[valid_indices]

                # Get class_names from metadata to convert IDs to names.
                # v3 `cell_class_names` first, fallback to v1 bare key.
                class_names, _ = read_user_anno_class_palette(user_annotation_group, 'cell')
            except Exception as e:
                try:
                    logger.error(f"class name resolution failed: {e}", exc_info=True)
                except Exception:
                    pass
                logger.warning(f"[AL Load] Failed to load structured array format annotations: {e}")
                return {}
            
            # Optimize: batch read cell_color and datetime for all valid indices at once
            # This is much faster than reading one by one
            valid_records = annotations_dataset[valid_indices]
            cell_color_data = valid_records['color']
            datetime_data = valid_records['datetime']

            saved_data = {}
            filtered_count = 0

            # Process annotations using vectorized operations where possible
            for i, idx in enumerate(valid_indices):
                # Ensure cell_id is always stored as string for consistent comparison
                cell_id_str = str(idx)

                # Convert class ID to class name
                class_id = int(cell_class_ids[i])
                if class_names and 0 <= class_id < len(class_names):
                    new_class = class_names[class_id]
                else:
                    # Invalid class ID, skip
                    filtered_count += 1
                    continue


                # Get original_class from annotation data - keep as-is even if None
                original_class = None  # Not stored in current structured array format
                
                # Use batch-read data (much faster than individual reads)
                cell_color = _int_color_to_hex(cell_color_data[i])
                # datetime_data is stored in milliseconds, but fromtimestamp() expects seconds
                # Handle 0 case explicitly: 0 means 'not set', so return None instead of epoch time
                if datetime_data[i] == 0:
                    datetime_str = None
                else:
                    datetime_str = datetime.fromtimestamp(datetime_data[i] / 1000.0).isoformat()
                
                saved_data[cell_id_str] = {
                        "original_class": original_class,
                        "new_class": new_class,
                        "prob": 0.0,  # Not stored in structured array
                        "timestamp": datetime_str,
                        # Maintain original_original_class for multi-step saved-cell tracking
                        "original_original_class": original_class,  # Keep as-is, even if None
                        # Load centroid and color from zarr if present
                        "centroid_x": None,  # Not stored in structured array (can be computed from centroids)
                        "centroid_y": None,  # Not stored in structured array (can be computed from centroids)
                        "color": cell_color
                    }
            
        # Cache the result, keyed on the user_annotation mtime
        try:
            mtime = _user_annotation_mtime(zarr_path)
            _store_zarr_saved_cells(zarr_path, saved_data, mtime)
        except OSError:
            pass  # Can't get mtime, don't cache
        
        return saved_data
        
    except Exception as e:
        logger.error(f"[AL Load] Error loading saved_cells from Zarr: {str(e)}", exc_info=e)
        return {}


def _load_saved_patches(zarr_path: str) -> Dict:
    """
    Load saved patch annotations from User-Annotations/patch (dense structured
    array, length = N_patches). A row is a saved user annotation iff class >= 0.
    Returns records of the same shape as _load_saved_cells.
    """
    try:
        if not os.path.exists(zarr_path):
            return {}
        with open_zarr_cm(zarr_path, 'r') as zf:
            if ZarrGroups.USER_ANNOTATIONS not in zf:
                return {}
            user_annotation_group = zf[ZarrGroups.USER_ANNOTATIONS]
            if 'patch' not in user_annotation_group:
                return {}

            patch_ds = user_annotation_group['patch']
            if not (hasattr(patch_ds, 'dtype') and patch_ds.dtype.names and 'class' in patch_ds.dtype.names):
                return {}

            # Resolve class index → display name via v3 `patch_class_names`
            # on the parent group; falls back to v2 (patch subarray attrs)
            # and v1 (bare keys on parent) automatically.
            class_names, class_colors = read_user_anno_class_palette(user_annotation_group, 'patch')

            patch_arr = patch_ds[:]
            class_field = patch_arr['class']
            color_field = patch_arr['color'] if 'color' in patch_arr.dtype.names else None
            datetime_field = patch_arr['datetime'] if 'datetime' in patch_arr.dtype.names else None

            saved_data = {}
            for i in range(len(patch_arr)):
                cls_idx = int(class_field[i])
                if cls_idx < 0:
                    continue
                new_class = class_names[cls_idx] if 0 <= cls_idx < len(class_names) else f"class_{cls_idx}"
                color_val = None
                if color_field is not None:
                    ci = int(color_field[i])
                    if ci >= 0:
                        color_val = f"#{ci:06x}"
                if color_val is None and 0 <= cls_idx < len(class_colors):
                    color_val = class_colors[cls_idx]
                saved_data[str(i)] = {
                    "original_class": None,
                    "new_class": new_class,
                    "prob": 0.0,
                    "timestamp": int(datetime_field[i]) if datetime_field is not None else None,
                    "original_original_class": None,
                    "centroid_x": None,
                    "centroid_y": None,
                    "color": color_val,
                }
            return saved_data

    except Exception as e:
        logger.error(f"[AL Load] Error loading saved patches from Zarr: {str(e)}", exc_info=e)
        return {}


def _placeholder_image(error_text: str = "Image Error") -> str:
    try:
        # Create a 128x128 gray placeholder image
        img = Image.new('RGB', (128, 128), color='#f0f0f0')
        draw = ImageDraw.Draw(img)
        
        # Add a subtle border
        draw.rectangle([0, 0, 127, 127], outline='#cccccc', width=1)
        
        # Add error text (try to use a basic font, fallback to default)
        try:
            font = ImageFont.load_default()
        except:
            font = None
            
        # Split text into lines and center them
        lines = error_text.split('\n')
        total_height = len(lines) * 12  # Approximate line height
        start_y = (128 - total_height) // 2
        
        for i, line in enumerate(lines):
            # Calculate text position to center it
            bbox = draw.textbbox((0, 0), line, font=font)
            text_width = bbox[2] - bbox[0]
            text_x = (128 - text_width) // 2
            text_y = start_y + i * 12
            
            # Draw text in dark gray
            draw.text((text_x, text_y), line, fill='#666666', font=font)
        
        # Convert to base64
        buffered = BytesIO()
        img.save(buffered, format="JPEG", quality=85)
        img_base64 = base64.b64encode(buffered.getvalue()).decode('utf-8')
        return f"data:image/jpeg;base64,{img_base64}"
        
    except Exception as e:
        logger.error(f"Error generating placeholder image: {e}", exc_info=e)
        # Return a minimal base64 image as fallback
        return "data:image/svg+xml;base64," + base64.b64encode(
            b'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#f0f0f0"/></svg>'
        ).decode('utf-8')


def _read_contours(zarr_path: str, cell_ids) -> Dict[int, np.ndarray]:
    """Contours of just these cells, keyed by cell id (missing ids left out).

    Reads only these cells' rows instead of the whole (N, 32, 2) array, so a
    page of tiles costs one zarr open rather than one per tile.
    """
    if not cell_ids:
        return {}
    with open_zarr_cm(zarr_path, 'r') as zf:
        seg_group = find_segmentation_group(zf)
        if seg_group is None or ZarrDatasets.CONTOURS not in seg_group:
            return {}
        contours = seg_group[ZarrDatasets.CONTOURS]
        ids = sorted({i for i in cell_ids if 0 <= i < contours.shape[0]})
        if not ids:
            return {}
        return dict(zip(ids, contours.oindex[ids]))


def _tree_signature(path: str) -> tuple:
    """(file count, newest mtime_ns) of everything under path; (0, 0) if absent.

    Rewriting a chunk bumps that chunk file's mtime but not its array
    directory's, so the files themselves are what tell a rerun apart.
    """
    count = newest = 0
    for dirpath, _, files in os.walk(path):
        for name in files:
            try:
                mtime = os.stat(os.path.join(dirpath, name)).st_mtime_ns
            except OSError:
                continue
            count += 1
            newest = max(newest, mtime)
    return count, newest


def _cell_arrays_signature(zarr_path: str) -> Optional[tuple]:
    """Changes whenever segmentation or classification rewrites an array the
    candidate search reads; None for a store that is not a directory."""
    if not os.path.isdir(zarr_path):
        return None
    seg = os.path.join(zarr_path, ZarrGroups.CELL_SEGMENTATION)
    cls = os.path.join(zarr_path, ZarrGroups.CELL_CLASSIFICATION)
    return tuple(_tree_signature(p) for p in (
        os.path.join(seg, ZarrDatasets.CENTROIDS),
        os.path.join(seg, ZarrDatasets.PROBABILITIES),
        os.path.join(cls, ZarrDatasets.CLASS_INDICES),
        os.path.join(cls, ZarrDatasets.PROBABILITIES),
        os.path.join(cls, 'classes'),
    ))


def _patch_arrays_signature(zarr_path: str) -> Optional[tuple]:
    """_cell_arrays_signature for the patch-classification group; None when
    the store is not a directory or has no such group."""
    if not os.path.isdir(zarr_path):
        return None
    name = 'Patch-Classification'
    if not os.path.isdir(os.path.join(zarr_path, name, 'class_indices')):
        with open_zarr_cm(zarr_path, 'r') as zf:
            name = _find_patch_group(zf)
        if name is None:
            return None
    group = os.path.join(zarr_path, name)
    return (name,) + tuple(_tree_signature(os.path.join(group, a))
                           for a in ('class_indices', 'coordinates', 'probabilities', 'classes'))


def _load_cell_arrays(zarr_path: str, sig: Optional[tuple], has_saved_cells: bool) -> Dict:
    """The per-cell arrays the candidate search needs, cached per slide.

    Returns {"error": ...} for a store with no usable segmentation, and leaves
    "centroids" None (uncached) when there is nothing to review, so that 409
    comes back without reading a per-cell array.
    """
    if sig is not None:
        with _slide_arrays_lock:
            entry = _slide_arrays_cache.get(zarr_path)
        if entry is not None and entry["sig"] == sig:
            return entry

    with open_zarr_cm(zarr_path, 'r') as zf:
        seg_group = find_segmentation_group(zf)
        if seg_group is None:
            logger.error(f"[AL] No segmentation data found in Zarr file: {zarr_path}")
            return {"error": "No segmentation data found in Zarr file"}
        if ZarrDatasets.CENTROIDS not in seg_group:
            logger.error(f"[AL] No centroids found in morphology group")
            return {"error": "No centroids data found in Zarr file"}

        classification_group = None
        classifications = None
        class_names = None
        if ZarrGroups.CELL_CLASSIFICATION in zf:
            classification_group = zf[ZarrGroups.CELL_CLASSIFICATION]
            if ZarrDatasets.CLASS_INDICES in classification_group:
                classifications = classification_group[ZarrDatasets.CLASS_INDICES][:]
            if 'classes/name' in classification_group:
                class_names = [name.decode() if isinstance(name, bytes) else name for name in classification_group['classes/name'][:]]

        entry = {"sig": sig, "classifications": classifications, "class_names": class_names,
                 "centroids": None, "max_probs": None, "probs_shape": None}
        if (classifications is None or class_names is None) and not has_saved_cells:
            return entry

        entry["centroids"] = seg_group[ZarrDatasets.CENTROIDS][:]  # (N, 2)

        probabilities = None
        if classification_group is not None:
            if ZarrDatasets.PROBABILITIES in classification_group:
                probabilities = classification_group[ZarrDatasets.PROBABILITIES][:]
            elif ZarrDatasets.PROBABILITIES in seg_group:
                probabilities = seg_group[ZarrDatasets.PROBABILITIES][:]

    # Only the per-cell max is ever used, so the (N, C) array is not kept.
    if probabilities is not None:
        entry["probs_shape"] = probabilities.shape
        if probabilities.ndim == 2:
            entry["max_probs"] = np.max(probabilities, axis=1)
        elif probabilities.ndim == 1:
            entry["max_probs"] = probabilities  # already a max probability per cell

    if sig is not None:
        with _slide_arrays_lock:
            _slide_arrays_cache.pop(zarr_path, None)
            _slide_arrays_cache[zarr_path] = entry
            while len(_slide_arrays_cache) > _MAX_CACHED_SLIDE_ARRAYS:
                _slide_arrays_cache.popitem(last=False)
    return entry


def _select_candidates(classifications, max_probs, target_idx: int, class_name: str,
                       threshold: float, side: str, sort_order: str) -> np.ndarray:
    """Indices predicted as target_idx on the requested side of the threshold,
    ordered by uncertainty |p - 0.5| ("asc" = most uncertain first).

    The argsort is stable so ties keep index order, as the list sort it
    replaces did (Python's reverse sort is stable too, hence -uncertainty).
    """
    max_probs = max_probs[:len(classifications)]
    # Negative control often has low probabilities by design, so show all of it.
    effective_threshold = 0.0 if class_name == "Negative control" else threshold
    in_side = (max_probs >= effective_threshold) if side == "right" else (max_probs < effective_threshold)
    idx = np.flatnonzero((classifications == target_idx) & in_side)
    uncertainty = np.abs(max_probs[idx] - 0.5)
    order = np.argsort(-uncertainty if sort_order == "desc" else uncertainty, kind="stable")
    # int32 halves what each cached request holds; cell counts stay far below 2**31.
    return idx[order].astype(np.int32)


def _cell_id_ints(ids) -> np.ndarray:
    """Saved-cell id strings as an int array; ids that are not indices dropped."""
    return np.fromiter((int(i) for i in ids if str(i).isdigit()), dtype=np.int64)


def _call_safely(render, req):
    try:
        return render(req)
    except Exception as e:
        return e


def _render_tiles(render, reqs) -> list:
    """render(req) for each req, in order, on a small thread pool: every tile
    opens the slide on its own, so a page no longer waits on serial reads.
    A tile that raises comes back as its exception."""
    if len(reqs) <= 1:
        return [_call_safely(render, r) for r in reqs]
    with ThreadPoolExecutor(max_workers=min(_TILE_WORKERS, len(reqs))) as pool:
        # One context copy per task: a Context cannot be entered by two threads.
        futures = [pool.submit(contextvars.copy_context().run, _call_safely, render, r) for r in reqs]
        return [f.result() for f in futures]


def _is_single_layer(slide_path: str) -> bool:
    """True when the slide is known not to be a z-stack, so its tiles can skip
    re-detecting that one by one. False (let each tile check) if unsure."""
    try:
        from tissuelab_sdk.wrapper import TiffFileWrapper
        return not TiffFileWrapper(slide_path).is_zstack
    except Exception:
        return False


def _build_candidates(params: Dict) -> Dict:
    try:
        slide_path = resolve_path(params["slide_id"])
        zarr_path = as_zarr_path(slide_path)
        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}

        class_name = params.get("class_name")
        threshold = params.get("threshold", 0.5)
        sort_order = params.get("sort", "asc")  # "asc" = Low to High, "desc" = High to Low
        limit = params.get("limit", 80)
        offset = params.get("offset", 0)
        exclude_saved = params.get("exclude_saved", False)
        side = params.get("side", "left")  # "left" = prob < threshold, "right" = prob >= threshold
        saved_only = params.get("saved_only", False)  # When true, return only already-saved cells

        # Check for saved cells (both persistent and temporary)
        saved_for_this_class = []
        saved_from_this_class = set()  # Cells to exclude from this class
        saved_to_this_class = set()    # Cells saved TO this class (also exclude from regular candidates)

        # All cells already saved in user_annotation for this slide
        all_saved = _load_saved_cells(zarr_path)

        if all_saved:
            for cell_id, saved_cell_data in all_saved.items():
                # Ensure cell_id is always stored as string for consistent comparison
                cell_id_str = str(cell_id)

                if saved_cell_data["new_class"] == class_name:
                    # This cell was saved TO this class
                    saved_for_this_class.append({
                        "cell_id": cell_id_str,
                        "prob": saved_cell_data["prob"],
                        "saved": True,
                        "original_class": saved_cell_data.get("original_original_class", saved_cell_data["original_class"])  # Use true original class
                    })
                    # Also add to the exclusion set to prevent duplicates in regular candidates
                    saved_to_this_class.add(cell_id_str)

                # Exclude cells that are currently saved FROM this class
                # This prevents cells from appearing in both their new class AND original class
                original_original_class = saved_cell_data.get("original_original_class", saved_cell_data["original_class"])

                # Special handling for cells with None original_class (from buggy old data)
                # These cells should be excluded from ALL classes except their new_class
                if original_original_class is None:
                    if saved_cell_data["new_class"] != class_name:
                        saved_from_this_class.add(cell_id_str)
                else:
                    # This cell's TRUE original class is this class AND it's currently saved to a different class
                    if original_original_class == class_name and saved_cell_data["new_class"] != class_name:
                        saved_from_this_class.add(cell_id_str)

        has_saved_cells = len(saved_for_this_class) > 0
        sig = _cell_arrays_signature(zarr_path)
        arrays = _load_cell_arrays(zarr_path, sig, has_saved_cells)
        if "error" in arrays:
            return {"success": False, "error": arrays["error"]}
        classifications = arrays["classifications"]
        class_names = arrays["class_names"]
        if (classifications is None or class_names is None) and not has_saved_cells:
            logger.error(f"[AL] No ClassificationNode found and no saved cells - classification must be run first")
            return {"success": False, "error": "No ClassificationNode found - please run classification first", "code": 409}
        centroids = arrays["centroids"]
        max_probs = arrays["max_probs"]
        has_probabilities = arrays["probs_shape"] is not None

        if not has_probabilities and not has_saved_cells:
            logger.warning(f"[AL] No probability data found and no saved cells")
            return {"success": False, "error": "No probability data found - please run segmentation or classification"}

        can_process_normal_candidates = (has_probabilities and class_name and
                                         classifications is not None and class_names is not None and
                                         class_name in class_names)
        if not can_process_normal_candidates and not has_saved_cells:
            if class_names is not None and class_name not in class_names:
                logger.warning(f"[AL] Target class '{class_name}' not found in available classes: {class_names}")
                return {"success": False, "error": f"Target class '{class_name}' not found in classification data"}
            logger.warning(f"[AL] No classification data available for class '{class_name}'")
            return {"success": False, "error": "No classification data available"}
        if can_process_normal_candidates and max_probs is None:
            shape = arrays["probs_shape"]
            logger.error(f"[AL] Invalid probabilities shape: {shape}, expected (N_cells, N_classes) or (N_cells,)")
            return {"success": False, "error": f"Invalid probabilities shape: {shape}"}

        # CHECK CACHE: the threshold-filtered, sorted candidates for this
        # slide + class + filter. Keyed on the array signature so a rerun of
        # classification invalidates it; saved cells are excluded per request
        # below, so a Save/Remove needs no new entry.
        cache_key = ("cell", zarr_path, sig, class_name, threshold, sort_order, side,
                     _roi_cache_key(params.get("roi"), params.get("polygon_points")),
                     params.get("cell_ids") or None)
        request_cache = _get_request_cache(cache_key)
        if sig is not None and request_cache["key"] == cache_key:
            candidate_idx = request_cache["candidate_idx"]
            target_class_histogram = request_cache["histogram"]
        else:
            if can_process_normal_candidates:
                target_class_idx = class_names.index(class_name)
                # Histogram over ALL cells predicted as the class (regardless of
                # threshold) so the user sees the full probability distribution.
                all_target_class_max_probs = max_probs[:len(classifications)][classifications == target_class_idx]
                if len(all_target_class_max_probs) > 0:
                    target_class_histogram, _ = np.histogram(all_target_class_max_probs, bins=20, range=(0.0, 1.0))
                    target_class_histogram = [int(x) for x in target_class_histogram.tolist()]
                else:
                    target_class_histogram = [0] * 20
                    logger.warning(f"[AL] No cells predicted as {class_name}, using empty histogram")

                candidate_idx = _select_candidates(classifications, max_probs, target_class_idx,
                                                   class_name, threshold, side, sort_order)

                # Apply spatial filtering: prefer ROI bbox/polygon over legacy cell_ids CSV
                if params.get("roi"):
                    candidate_idx = _filter_candidates_by_roi(
                        candidate_idx, centroids, params.get("roi"), params.get("polygon_points"))
                elif params.get("cell_ids"):
                    try:
                        # Parse comma-separated cell IDs (legacy path)
                        allowed_cell_ids = np.array(
                            [int(cid.strip()) for cid in params.get("cell_ids").split(",") if cid.strip()],
                            dtype=np.int64)
                        candidate_idx = candidate_idx[np.isin(candidate_idx, allowed_cell_ids)]
                    except (ValueError, AttributeError) as e:
                        logger.error(f"[AL] Error parsing cell_ids parameter: {e}", exc_info=e)
            else:
                # No normal candidates - only saved cells will be shown
                candidate_idx = np.empty(0, dtype=np.int32)
                target_class_histogram = [0] * 20

            request_cache["candidate_idx"] = candidate_idx
            request_cache["histogram"] = target_class_histogram
            # Last, because it is the flag readers test: the entry is shared
            # between concurrent requests for the same key, and setting it
            # first let a reader past the guard while the fields it guards
            # were still half-written.
            request_cache["key"] = cache_key

        # Saved cells always come first. Only their ids are checked here; tiles
        # are built below for the visible page only, since a class can hold
        # thousands of saved cells.
        n_cells = len(centroids)
        saved_cells = []
        seen_saved = set()
        for saved_cell in saved_for_this_class:
            cell_id_str = str(saved_cell["cell_id"])
            if not cell_id_str.isdigit():
                logger.warning(f"[AL] Error processing saved cell {cell_id_str}: not a cell index")
                continue
            if cell_id_str in seen_saved:
                logger.warning(f"[AL] Skipping duplicate saved cell {cell_id_str}")
                continue
            seen_saved.add(cell_id_str)
            if int(cell_id_str) < n_cells:
                saved_cells.append(saved_cell)

        excluded = _cell_id_ints(saved_from_this_class | saved_to_this_class)
        regular_idx = candidate_idx[~np.isin(candidate_idx, excluded)] if len(excluded) else candidate_idx

        if saved_only:
            shown_saved, shown_regular = saved_cells, regular_idx[:0]
        else:
            shown_saved, shown_regular = ([] if exclude_saved else saved_cells), regular_idx
        total_candidates = len(shown_saved) + len(shown_regular)

        # Paginate over [saved..., regular...] without materialising the list
        end_idx = min(offset + limit, total_candidates)
        page = []
        for pos in range(offset, end_idx):
            if pos < len(shown_saved):
                saved_cell = shown_saved[pos]
                page.append((int(saved_cell["cell_id"]), saved_cell))
            else:
                page.append((int(shown_regular[pos - len(shown_saved)]), None))

        page_ids = [cell_idx for cell_idx, _ in page]
        try:
            page_contours = _read_contours(zarr_path, page_ids)
        except Exception as contour_error:
            # Best effort: each tile then reads its own contour.
            logger.warning(f"[AL] Error reading contours for page: {contour_error}")
            page_contours = {}
        skip_zstack = bool(page) and _is_single_layer(slide_path[:-5] if slide_path.lower().endswith(".zarr") else slide_path)

        tile_reqs = []
        for cell_idx in page_ids:
            req = {
                "slide_id": params["slide_id"],
                "cell_id": cell_idx,
                "centroid": {"x": float(centroids[cell_idx, 0]), "y": float(centroids[cell_idx, 1])},
                "window_size_px": 128,
                "target_fov_um": 20.0,  # Standard FOV for cell review
                "padding_ratio": 0.1,   # Less padding to keep cell more centered
                "return_contour": True,
                "skip_classification": True,
                "skip_zstack": skip_zstack,
                # Gallery thumbnails render at ~100 CSS px (the enlarged view
                # fetches its own tile), so 256px at q85 cuts the page payload
                # ~4x vs the default 512px q95.
                "output_size_px": 256,
                "jpeg_quality": 85,
            }
            points = _contour_points(page_contours[cell_idx]) if cell_idx in page_contours else None
            if points is not None:
                req["contour"] = points
            tile_reqs.append(req)
        tiles = _render_tiles(get_cell_review_tile_data, tile_reqs)

        items = []
        for (cell_idx, saved_cell), req, tile in zip(page, tile_reqs, tiles):
            if isinstance(tile, Exception):
                logger.error(f"[AL] Error generating image for cell {cell_idx}: {tile}", exc_info=tile)
                tile = {"success": False, "error": str(tile)}
                placeholder = f"Cell {cell_idx}\nGeneration Error"
            else:
                placeholder = f"Cell {cell_idx}\nImage Error"
            if tile.get("success", False):
                crop_data = tile.get("data", {})
            else:
                logger.warning(f"[AL] Failed to get image for cell {cell_idx}: {tile.get('error', 'unknown')}")
                crop_data = {"image": _placeholder_image(placeholder)}
            bounds = crop_data.get("bounds") or {"x": 0, "y": 0, "w": 128, "h": 128}
            bbox = crop_data.get("bbox") or {"x": 54, "y": 54, "w": 20, "h": 20}
            crop = {
                "image": crop_data.get("image") or _placeholder_image(placeholder),
                "bounds": {
                    "x": int(bounds.get("x", 0)),
                    "y": int(bounds.get("y", 0)),
                    "w": int(bounds.get("w", 128)),
                    "h": int(bounds.get("h", 128))
                },
                "bbox": {
                    "x": int(bbox.get("x", 54)),
                    "y": int(bbox.get("y", 54)),
                    "w": int(bbox.get("w", 20)),
                    "h": int(bbox.get("h", 20))
                },
                "contour": crop_data.get("contour") or req.get("contour") or [],
                # Z-stack metadata
                "is_zstack": crop_data.get("is_zstack", False),
                "num_z_layers": crop_data.get("num_z_layers"),
                "image_format": crop_data.get("image_format", "jpeg")
            }
            if saved_cell is not None:
                items.append({
                    "cell_id": str(saved_cell["cell_id"]),
                    "prob": saved_cell["prob"],
                    "centroid": req["centroid"],
                    "label": None,  # No label yet for the new class
                    "saved": True,
                    "original_class": saved_cell["original_class"],
                    "crop": crop,
                })
            else:
                items.append({
                    "cell_id": str(cell_idx),  # Keep as string for JSON
                    "prob": float(max_probs[cell_idx]),
                    "centroid": req["centroid"],
                    "saved": False,
                    "crop": crop,
                })

        return {
            "success": True,
            "data": {
                "total": int(total_candidates),
                "hist": target_class_histogram,
                "items": items
            }
        }

    except Exception as e:
        logger.error(f"Error in _build_candidates: {str(e)}", exc_info=e)
        return {"success": False, "error": f"Error fetching candidates: {str(e)}"}


def _find_patch_group(zf) -> Optional[str]:
    """Locate the patch-classification group in the zarr.

    Returns 'Patch-Classification' when it exists; otherwise the first top-level
    group that has class_indices (configurable on the classifier side).
    """
    try:
        if 'Patch-Classification' in zf and 'class_indices' in zf['Patch-Classification']:
            return 'Patch-Classification'
    except Exception:
        pass
    for name in list(zf.keys()):
        try:
            g = zf[name]
            if 'class_indices' in g:
                return name
        except Exception:
            continue
    return None


def _find_patch_coordinates(zf, classification_group: str) -> Optional[np.ndarray]:
    """Load patch bounding boxes from the classification or segmentation group."""
    candidates = [classification_group, "Patch-Segmentation"]
    for name in candidates:
        try:
            group = zf[name]
            if "coordinates" in group:
                return np.asarray(group["coordinates"][:])
        except Exception:
            continue
    return None


def _build_patch_candidates(params: Dict) -> Dict:
    """Patch-classification mirror of _build_candidates.

    Patches now carry probabilities (Patch-Classification/probabilities), so
    the threshold / histogram / uncertainty logic is identical to cells. They
    have no contour and no z-stack, so this is leaner. Patch geometry is the
    bbox in Patch-Segmentation/coordinates; saved patches come from tissue_annotations.
    """
    try:
        slide_path_raw = resolve_path(params["slide_id"])
        zarr_path = as_zarr_path(slide_path_raw)
        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}

        class_name = params.get("class_name")
        threshold = params.get("threshold", 0.5)
        sort_order = params.get("sort", "asc")
        limit = params.get("limit", 80)
        offset = params.get("offset", 0)
        exclude_saved = params.get("exclude_saved", False)
        side = params.get("side", "left")
        saved_only = params.get("saved_only", False)

        # Content-keyed cache; the "patch" tag keeps it separate from cell entries.
        # Keyed on the array signature so rerunning patch classification
        # invalidates it; saved patches are excluded per request below.
        sig = _patch_arrays_signature(zarr_path)
        cache_key = ("patch", zarr_path, sig, class_name, threshold, sort_order, side)
        request_cache = _get_request_cache(cache_key)
        use_cache = sig is not None and request_cache["key"] == cache_key

        # ---- saved patches: split into to/from the current class ----
        saved_for_this_class = []
        saved_from_this_class = set()
        saved_to_this_class = set()
        for patch_id, sd in _load_saved_patches(zarr_path).items():
            pid = str(patch_id)
            if sd["new_class"] == class_name:
                saved_for_this_class.append({"cell_id": pid, "prob": sd["prob"],
                                             "saved": True, "original_class": sd.get("original_class")})
                saved_to_this_class.add(pid)
            else:
                # Saved to a different class -> exclude from this class's pool
                saved_from_this_class.add(pid)

        if not use_cache:
            with open_zarr_cm(zarr_path, 'r') as zf:
                patch_group = _find_patch_group(zf)
                if patch_group is None:
                    return {"success": False, "error": "No patch classification found - please run patch classification first", "code": 409}
                pg = zf[patch_group]
                if 'class_indices' not in pg:
                    return {"success": False, "error": "Patch classification data incomplete"}
                classifications = np.asarray(pg['class_indices'][:]).astype(int)
                coordinates = _find_patch_coordinates(zf, patch_group)
                if coordinates is None or coordinates.ndim != 2 or coordinates.shape[1] < 4:
                    return {"success": False, "error": "Patch classification data incomplete: patch coordinates are missing or invalid"}
                if len(coordinates) != len(classifications):
                    return {"success": False, "error": "Patch classification data incomplete: patch data lengths do not match"}
                class_names = None
                if 'classes/name' in pg:
                    class_names = [n.decode('utf-8') if isinstance(n, bytes) else str(n)
                                   for n in pg['classes/name'][:]]
                probabilities = np.asarray(pg['probabilities'][:]) if 'probabilities' in pg else None

            if probabilities is None:
                return {"success": False, "error": "No patch probabilities found - re-run patch classification (zero-shot has none)"}
            if probabilities.ndim != 2 or len(probabilities) != len(classifications):
                return {"success": False, "error": "Patch classification data incomplete: probabilities do not match patches"}
            if not class_names or class_name not in class_names:
                return {"success": False, "error": f"Class '{class_name}' not found in patch classification"}
            target_idx = class_names.index(class_name)

            # A patch "centroid" is its bbox centre (for the View jump).
            centroids = np.column_stack([
                (coordinates[:, 0] + coordinates[:, 2]) / 2.0,
                (coordinates[:, 1] + coordinates[:, 3]) / 2.0,
            ])

            max_probs = np.max(probabilities, axis=1)

            # Histogram over ALL patches predicted as the target class
            tgt_probs = max_probs[classifications == target_idx]
            if len(tgt_probs) > 0:
                target_class_histogram = [int(x) for x in np.histogram(tgt_probs, bins=20, range=(0.0, 1.0))[0].tolist()]
            else:
                target_class_histogram = [0] * 20

            candidate_idx = _select_candidates(classifications, max_probs, target_idx,
                                               class_name, threshold, side, sort_order)

            request_cache["candidate_idx"] = candidate_idx
            request_cache["histogram"] = target_class_histogram
            request_cache["centroids"] = centroids
            request_cache["coordinates"] = coordinates
            request_cache["max_probs"] = max_probs
            # Published last — see the note in the cell-candidate path.
            request_cache["key"] = cache_key
        else:
            centroids = request_cache["centroids"]
            coordinates = request_cache["coordinates"]
            max_probs = request_cache["max_probs"]
            candidate_idx = request_cache["candidate_idx"]
            target_class_histogram = request_cache["histogram"]

        def _patch_item(patch_idx: int, saved_flag: bool, original_class=None) -> Dict:
            """Build one response item via the shared review-tile pipeline.

            Patches reuse get_patch_review_tile_data (the cell tile pipeline
            with a rectangle contour synthesised from the patch bbox), so the
            crop — image, bounds, the rectangular contour — has the same shape
            as cell items. prob is the patch's AI max-probability.
            """
            bbox = coordinates[patch_idx]
            tile = get_patch_review_tile_data({
                "slide_id": params["slide_id"],
                "patch_id": int(patch_idx),
                "bbox": [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
            })
            if tile.get("success"):
                d = tile.get("data", {})
                crop = {
                    "image": d.get("image") or _placeholder_image(f"Patch {patch_idx}"),
                    "bbox": d.get("bbox", {"x": 0, "y": 0, "w": 0, "h": 0}),
                    "bounds": d.get("bounds", {"x": 0, "y": 0, "w": 0, "h": 0}),
                    "contour": d.get("contour", []),
                    "is_zstack": d.get("is_zstack", False),
                    "num_z_layers": d.get("num_z_layers"),
                    "image_format": d.get("image_format", "jpeg"),
                }
            else:
                logger.warning(f"[AL Patch] tile failed for patch {patch_idx}: {tile.get('error')}")
                crop = {
                    "image": _placeholder_image(f"Patch {patch_idx}\nImage Error"),
                    "bbox": {"x": 0, "y": 0, "w": 0, "h": 0},
                    "bounds": {"x": 0, "y": 0, "w": 0, "h": 0},
                    "contour": [],
                    "is_zstack": False,
                    "num_z_layers": None,
                    "image_format": "jpeg",
                }
            return {
                "cell_id": str(patch_idx),
                "prob": float(max_probs[patch_idx]),
                "patch_size": int(max(bbox[2] - bbox[0], bbox[3] - bbox[1])),
                "centroid": {"x": float(centroids[patch_idx, 0]), "y": float(centroids[patch_idx, 1])},
                "label": None,
                "saved": saved_flag,
                "original_class": original_class,
                "crop": crop,
            }

        # ---- assemble the unified list (saved items first, then candidates) ----
        excluded = _cell_id_ints(saved_from_this_class | saved_to_this_class)
        regular_idx = candidate_idx[~np.isin(candidate_idx, excluded)] if len(excluded) else candidate_idx
        if saved_only:
            shown_saved, shown_regular = saved_for_this_class, regular_idx[:0]
        else:
            shown_saved, shown_regular = ([] if exclude_saved else saved_for_this_class), regular_idx
        total_candidates = len(shown_saved) + len(shown_regular)

        # Paginate, then build tiles only for the visible page
        page_args = []
        seen = set()
        for pos in range(offset, min(offset + limit, total_candidates)):
            if pos < len(shown_saved):
                saved = shown_saved[pos]
                pidx = int(str(saved["cell_id"]))
                if str(pidx) in seen or pidx < 0 or pidx >= len(coordinates):
                    continue
                seen.add(str(pidx))
                page_args.append((pidx, True, saved.get("original_class")))
            else:
                pidx = int(shown_regular[pos - len(shown_saved)])
                if pidx < 0 or pidx >= len(coordinates):
                    continue
                page_args.append((pidx, False, None))
        items = _render_tiles(lambda args: _patch_item(*args), page_args)
        for item in items:
            if isinstance(item, Exception):
                raise item

        return {
            "success": True,
            "data": {
                "total": int(total_candidates),
                "hist": target_class_histogram,
                "items": items,
            },
        }

    except Exception as e:
        logger.error(f"Error in _build_patch_candidates: {str(e)}", exc_info=e)
        return {"success": False, "error": f"Error fetching patch candidates: {str(e)}"}


def convert_numpy_types(obj):
    """Convert numpy types to native Python types for JSON serialization."""
    if isinstance(obj, dict):
        return {k: convert_numpy_types(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_numpy_types(v) for v in obj]
    elif isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    else:
        return obj


def _roi_cache_key(roi, polygon_points) -> tuple:
    """Stable cache fingerprint for optional ROI / polygon filters."""
    if not roi:
        return (None,)
    box = (
        float(roi.get("x1")),
        float(roi.get("y1")),
        float(roi.get("x2")),
        float(roi.get("y2")),
    )
    poly = None
    if polygon_points and isinstance(polygon_points, (list, tuple)):
        try:
            poly = tuple(
                (float(p[0]), float(p[1]))
                for p in polygon_points
                if isinstance(p, (list, tuple)) and len(p) >= 2
            )
        except Exception:
            poly = None
    return (box, poly)


def _filter_candidates_by_roi(candidate_idx, centroids, roi, polygon_points):
    """Keep candidate indices whose centroids fall in roi bbox (and optional polygon), in order."""
    if not roi or centroids is None or len(candidate_idx) == 0:
        return candidate_idx
    try:
        x1 = float(roi["x1"]); y1 = float(roi["y1"])
        x2 = float(roi["x2"]); y2 = float(roi["y2"])
    except Exception:
        return candidate_idx

    # Guard out-of-range indices
    idxs = candidate_idx[(candidate_idx >= 0) & (candidate_idx < len(centroids))]
    pts = np.asarray(centroids)[idxs]
    keep = (
        (x1 <= pts[:, 0]) & (pts[:, 0] <= x2) &
        (y1 <= pts[:, 1]) & (pts[:, 1] <= y2)
    )
    if polygon_points and isinstance(polygon_points, (list, tuple)) and len(polygon_points) >= 3:
        try:
            from matplotlib.path import Path
            poly = [
                (float(p[0]), float(p[1]))
                for p in polygon_points
                if isinstance(p, (list, tuple)) and len(p) >= 2
            ]
            if len(poly) >= 3:
                keep &= Path(poly).contains_points(pts, radius=-1e-9)
        except Exception as e:
            logger.warning(f"[AL] ROI polygon filter failed, using bbox only: {e}")
    return idxs[keep]


def _normalize_cell_ids(cell_ids) -> Optional[str]:
    """Normalize cell_ids (list or str) to the comma-separated string the service layer expects."""
    if cell_ids is None:
        return None
    try:
        if isinstance(cell_ids, list):
            return ",".join(str(int(x)) for x in cell_ids)
        if isinstance(cell_ids, str):
            return cell_ids
        return None
    except Exception as norm_err:
        logger.error(f"Error normalizing cell_ids: {norm_err}", exc_info=norm_err)
        return None


def get_review_candidates(*, slide_id, class_name, threshold, sort, limit, offset,
                            cell_ids, exclude_saved, side, saved_only=False,
                            roi=None, polygon_points=None) -> Dict:
    """Fetch active-learning candidates and return JSON-safe data.

    Returns {"success": True, "data": <clean dict>} or {"success": False, "error": <msg>}.
    Prefer ``roi`` / ``polygon_points`` over ``cell_ids`` for spatial filtering.
    """
    params = {
        "slide_id": slide_id,
        "class_name": class_name,
        "threshold": threshold,
        "sort": sort,
        "limit": limit,
        "offset": offset,
        "cell_ids": None if roi else _normalize_cell_ids(cell_ids),
        "roi": roi,
        "polygon_points": polygon_points,
        "exclude_saved": exclude_saved,
        "side": side,
        "saved_only": saved_only,
    }
    result = _build_candidates(params)
    if not result.get("success", False):
        # Preserve a service-supplied status code (e.g. 409 "run classification first")
        # so an expected flow-order error isn't reported/surfaced as a 500.
        return {"success": False, "error": result.get("error", "Failed to fetch candidates"), "code": result.get("code", 500)}

    clean_data = convert_numpy_types(result.get("data", {}))
    try:
        json.dumps(clean_data)
    except Exception as json_error:
        logger.error(f"JSON serialization error: {json_error}", exc_info=json_error)
        return {"success": False, "error": f"JSON serialization error: {json_error}"}
    return {"success": True, "data": clean_data}


def get_patch_review_candidates(*, slide_id, class_name, threshold, sort, limit, offset,
                                exclude_saved, side, saved_only=False) -> Dict:
    """Fetch active-learning candidates for patch (MUSK) classification.

    Patch counterpart of get_review_candidates. Same shape of return value;
    no cell_ids (ROI cell filtering does not apply to patches).
    """
    params = {
        "slide_id": slide_id,
        "class_name": class_name,
        "threshold": threshold,
        "sort": sort,
        "limit": limit,
        "offset": offset,
        "exclude_saved": exclude_saved,
        "side": side,
        "saved_only": saved_only,
    }
    result = _build_patch_candidates(params)
    if not result.get("success", False):
        # Preserve a service-supplied status code (e.g. 409 "run classification first").
        return {"success": False, "error": result.get("error", "Failed to fetch patch candidates"), "code": result.get("code", 500)}

    clean_data = convert_numpy_types(result.get("data", {}))
    try:
        json.dumps(clean_data)
    except Exception as json_error:
        logger.error(f"JSON serialization error: {json_error}", exc_info=json_error)
        return {"success": False, "error": f"JSON serialization error: {json_error}"}
    return {"success": True, "data": clean_data}


def get_patch_tile_data(*, slide_id, patch_id, window_size_px=None) -> Dict:
    """Render a single patch tile at an adjustable view size (Target Patch
    preview).

    window_size_px is the side of the square region read, in slide pixels:
    the patch size renders the patch exactly, larger shows surrounding
    context. Clamped to [patch_size, patch_size * 16]. Goes through the
    shared review-tile pipeline (get_patch_review_tile_data).
    """
    try:
        slide_path_raw = resolve_path(slide_id)
        zarr_path = as_zarr_path(slide_path_raw)
        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}

        with open_zarr_cm(zarr_path, 'r') as zf:
            patch_group = _find_patch_group(zf)
            if patch_group is None or 'coordinates' not in zf[patch_group]:
                return {"success": False, "error": "No patch coordinates found"}
            coordinates = np.asarray(zf[patch_group]['coordinates'][:])

        pid = int(patch_id)
        if pid < 0 or pid >= len(coordinates):
            return {"success": False, "error": f"Patch {pid} out of range"}

        bbox = coordinates[pid]
        patch_size = max(int(bbox[2]) - int(bbox[0]), int(bbox[3]) - int(bbox[1]), 1)
        try:
            wsize = int(window_size_px) if window_size_px else patch_size
        except (TypeError, ValueError):
            wsize = patch_size
        wsize = max(patch_size, min(wsize, patch_size * 16))

        tile = get_patch_review_tile_data({
            "slide_id": slide_id,
            "patch_id": pid,
            "bbox": [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
            "window_size_px": wsize,
        })
        if not tile.get("success"):
            return {"success": False, "error": tile.get("error", "Failed to render patch tile")}
        return {"success": True, "data": tile.get("data", {})}
    except Exception as e:
        logger.error(f"Error in get_patch_tile_data: {str(e)}", exc_info=e)
        return {"success": False, "error": f"Error rendering patch tile: {str(e)}"}
