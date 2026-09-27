from app.config.zarr_compat import as_zarr_path, open_zarr_cm
from collections import OrderedDict
import numpy as np
import json
import logging
import threading
import traceback
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
_last_request_cache = {}   # {cache_key: {key: ..., valid_candidates: [], ...}}
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
        entry = {
            "key": None,
            "valid_candidates": [],
            "histogram": [],
            "centroids": None,
            "candidate_data": {},
            "candidates_list": [],
            "filtered_candidates": []
        }
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


def _build_candidates(params: Dict) -> Dict:
    try:
        slide_path = resolve_path(params["slide_id"])
        zarr_path = as_zarr_path(slide_path)
        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}

        # Check if this is a z-stack request
        z_layer = params.get("z_layer")  # Optional: specific z-layer to show candidates from
        show_all_layers = params.get("show_all_layers", False)  # Show candidates from all layers

        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"File not found: {zarr_path}"}
        
        class_name = params.get("class_name")
        threshold = params.get("threshold", 0.5)
        sort_order = params.get("sort", "asc")  # "asc" = Low to High, "desc" = High to Low
        limit = params.get("limit", 80)
        offset = params.get("offset", 0)
        exclude_saved = params.get("exclude_saved", False)  # New parameter
        side = params.get("side", "left")  # "left" = prob < threshold, "right" = prob >= threshold
        saved_only = params.get("saved_only", False)  # When true, return only already-saved cells
        
        # CHECK CACHE: content-keyed candidate cache. The user_annotation mtime
        # is part of the key so a Save/Remove (which rewrites user_annotation)
        # invalidates the cached candidate list. ROI fingerprint is included so
        # different regions do not share filtered lists.
        cache_key = (zarr_path, class_name, threshold, sort_order, exclude_saved, side, saved_only,
                     _user_annotation_mtime(zarr_path),
                     _roi_cache_key(params.get("roi"), params.get("polygon_points")),
                     params.get("cell_ids") or None)
        request_cache = _get_request_cache(cache_key)
        use_cache = (request_cache["key"] == cache_key and
                     request_cache["valid_candidates"] and
                     request_cache["centroids"] is not None)
        
        if use_cache:
            valid_candidates = request_cache["valid_candidates"]
            target_class_histogram = request_cache["histogram"]
            centroids = request_cache["centroids"]
        
        
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
                    # Use string type for consistent comparison
                    saved_to_this_class.add(cell_id_str)

                # Exclude cells that are currently saved FROM this class
                # This prevents cells from appearing in both their new class AND original class
                original_original_class = saved_cell_data.get("original_original_class", saved_cell_data["original_class"])
                
                # Special handling for cells with None original_class (from buggy old data)
                # These cells should be excluded from ALL classes except their new_class
                if original_original_class is None:
                    # If this cell's new_class is NOT the current class, exclude it
                    if saved_cell_data["new_class"] != class_name:
                        saved_from_this_class.add(cell_id_str)
                else:
                    # Normal case: check if original matches current class AND new is different
                    if original_original_class == class_name and saved_cell_data["new_class"] != class_name:
                        # This cell's TRUE original class is this class AND it's currently saved to a different class
                        # Exclude it from probability candidates to prevent duplicates
                        saved_from_this_class.add(cell_id_str)
        
        
        
        # SKIP EXPENSIVE OPERATIONS IF CACHE HIT
        if not use_cache:
            with open_zarr_cm(zarr_path, 'r') as zf:
                # Try different Zarr group structures for morphology data using centralized config
                seg_group = find_segmentation_group(zf)
                if seg_group is None:
                    logger.error(f"[AL] No segmentation data found in Zarr file: {zarr_path}")
                    return {"success": False, "error": "No segmentation data found in Zarr file"}
                    
                if ZarrDatasets.CENTROIDS not in seg_group:
                    logger.error(f"[AL] No centroids found in morphology group")
                    return {"success": False, "error": "No centroids data found in Zarr file"}
                    
                centroids = seg_group[ZarrDatasets.CENTROIDS][:]  # Shape: (N, 2) where N is number of cells
                contours = seg_group[ZarrDatasets.CONTOURS][:] if ZarrDatasets.CONTOURS in seg_group else None
                
                # Try to get classification results from ClassificationNode
                classification_group = None
                classifications = None
                class_names = None
                
                if ZarrGroups.CELL_CLASSIFICATION in zf:
                    classification_group = zf[ZarrGroups.CELL_CLASSIFICATION]
                    # Read classification results
                    classifications = classification_group[ZarrDatasets.CLASS_INDICES][:] if ZarrDatasets.CLASS_INDICES in classification_group else None
                    if 'classes/name' in classification_group:
                        class_names = [name.decode() if isinstance(name, bytes) else name for name in classification_group['classes/name'][:]]
                
                # If no classification data exists, but we have saved cells for this class, we can still show them
                has_classification_data = classifications is not None and class_names is not None
                has_saved_cells = len(saved_for_this_class) > 0
                
                if not has_classification_data and not has_saved_cells:
                    logger.error(f"[AL] No ClassificationNode found and no saved cells - classification must be run first")
                    return {"success": False, "error": "No ClassificationNode found - please run classification first", "code": 409}
                
                # Read probabilities - check multiple sources (only if classification group exists)
                probabilities = None
                
                if classification_group is not None:
                    if ZarrDatasets.PROBABILITIES in classification_group:
                        probabilities = classification_group[ZarrDatasets.PROBABILITIES][:]
                    elif ZarrDatasets.PROBABILITIES in seg_group:
                        probabilities = seg_group[ZarrDatasets.PROBABILITIES][:]
                
                # Only return error if we have no probabilities AND no saved cells
                if probabilities is None and not has_saved_cells:
                    logger.warning(f"[AL] No probability data found and no saved cells")
                    return {"success": False, "error": "No probability data found - please run segmentation or classification"}
            
            # Filter by target class and apply threshold and sorting  
            candidate_data = {}
            
            # Check if we can process normal candidates (from classification data)
            can_process_normal_candidates = (probabilities is not None and class_name and 
                                            classifications is not None and class_names is not None and 
                                            class_name in class_names)
            
            if can_process_normal_candidates:
                target_class_idx = class_names.index(class_name)
            elif not has_saved_cells:
                # No normal candidates AND no saved cells - return error
                if class_names is not None and class_name not in class_names:
                    logger.warning(f"[AL] Target class '{class_name}' not found in available classes: {class_names}")
                    return {"success": False, "error": f"Target class '{class_name}' not found in classification data"}
                else:
                    logger.warning(f"[AL] No classification data available for class '{class_name}'")
                    return {"success": False, "error": "No classification data available"}
            else:
                # No normal candidates BUT we have saved cells - continue with only saved cells
                pass
            
            if can_process_normal_candidates:
                # Calculate max probabilities and uncertainty
                # probabilities shape can be:
                #  - (N_cells, N_classes): per-class probabilities
                #  - (N_cells,): single max probability per cell (fallback)
                if probabilities is not None:
                    if probabilities.ndim == 2:
                        max_probs = np.max(probabilities, axis=1)
                    elif probabilities.ndim == 1:
                        # Treat as already max probability per cell
                        max_probs = probabilities
                    else:
                        logger.error(f"[AL] Invalid probabilities shape: {probabilities.shape}, expected (N_cells, N_classes) or (N_cells,)")
                        return {"success": False, "error": f"Invalid probabilities shape: {probabilities.shape}"}
                    
                    uncertainties = np.abs(max_probs - 0.5)
                
                # Find cells for active learning: predicted as target class OR saved to target class
                valid_candidates = []
                
                # Get IDs of cells that have been saved to this target class
                saved_cell_ids = set(int(cell["cell_id"]) for cell in saved_for_this_class)
                
                # Generate histogram from ALL predicted cells (regardless of threshold)
                # This gives user full visibility of probability distribution
                all_target_class_max_probs = max_probs[classifications == target_class_idx]
                if len(all_target_class_max_probs) > 0:
                    target_class_histogram, _ = np.histogram(all_target_class_max_probs, bins=20, range=(0.0, 1.0))
                    target_class_histogram = [int(x) for x in target_class_histogram.tolist()]
                else:
                    target_class_histogram = [0] * 20
                    logger.warning(f"[AL] No cells predicted as {class_name}, using empty histogram")
                
                for idx in range(len(classifications)):
                    predicted_class = int(classifications[idx])
                    max_prob = float(max_probs[idx])
                    uncertainty = float(uncertainties[idx])
                    
                    # Convert idx to string for set comparison
                    idx_str = str(idx)
                    
                    # Include cells if: 1) predicted as target class, OR 2) saved to target class
                    # BUT exclude cells that have been saved FROM this class
                    is_predicted = predicted_class == target_class_idx
                    is_saved_to = idx in saved_cell_ids
                    is_saved_from = idx_str in saved_from_this_class

                    should_include = (is_predicted or is_saved_to) and not is_saved_from
                    # exclude_saved: a cell already saved to this class is done —
                    # it must leave the regular "To Review" pool (a "Yes" cell is
                    # saved TO the current class, so is_saved_to alone would
                    # otherwise keep it visible after Save).
                    if exclude_saved and is_saved_to:
                        should_include = False

                    if should_include:
                        # Apply threshold based on side parameter
                        # SPECIAL HANDLING: Negative control class often has low probabilities by design
                        # Use a lower threshold (0.0) for NC to show all predicted NC cells
                        effective_threshold = 0.0 if class_name == "Negative control" else threshold
                        
                        # Filter by side: 'left' = prob < threshold, 'right' = prob >= threshold
                        if side == "right":
                            # Right side: prob >= threshold (high confidence)
                            if max_prob >= effective_threshold:
                                valid_candidates.append((idx, max_prob, uncertainty))
                        else:
                            # Left side: prob < threshold (low confidence, default behavior)
                            if max_prob < effective_threshold:
                                valid_candidates.append((idx, max_prob, uncertainty))
                
                # Sort by uncertainty (lowest uncertainty first = most uncertain cells)
                # uncertainty = |max_prob - 0.5|, where 0 = most uncertain, 0.5 = most certain
                # "asc" = Low to High uncertainty (most uncertain first), "desc" = High to Low uncertainty  
                reverse_sort = (sort_order == "desc")
                valid_candidates.sort(key=lambda x: x[2], reverse=reverse_sort)  # Sort by uncertainty (lower = more uncertain)
                
                # Apply spatial filtering: prefer ROI bbox/polygon over legacy cell_ids CSV
                if params.get("roi"):
                    valid_candidates = _filter_candidates_by_roi(
                        valid_candidates,
                        centroids,
                        params.get("roi"),
                        params.get("polygon_points"),
                    )
                elif params.get("cell_ids"):
                    try:
                        # Parse comma-separated cell IDs (legacy path)
                        allowed_cell_ids = set(int(cid.strip()) for cid in params.get("cell_ids").split(",") if cid.strip())
                        
                        id_filtered_candidates = []
                        for idx, max_prob, uncertainty in valid_candidates:
                            if idx in allowed_cell_ids:
                                id_filtered_candidates.append((idx, max_prob, uncertainty))
                        valid_candidates = id_filtered_candidates
                        
                    except (ValueError, AttributeError) as e:
                        logger.error(f"[AL] Error parsing cell_ids parameter: {e}", exc_info=e)
                else:
                    pass
                
                # Note: target_class_histogram is already generated above (before threshold filtering)
                # This ensures the histogram always shows the full distribution
            else:
                # No normal candidates - initialize empty data structures
                # (We'll only show saved cells)
                valid_candidates = []
                target_class_histogram = [0] * 20
            
            # Build candidate_data for all valid_candidates
            candidate_data = {}
            for cell_idx, max_prob, uncertainty in valid_candidates:
                candidate_data[str(cell_idx)] = {
                    'prob': float(max_prob),
                    'uncertainty': float(uncertainty),
                    'centroid': {'x': float(centroids[cell_idx, 0]), 'y': float(centroids[cell_idx, 1])}
                }
            
            # Build candidates_list from candidate_data
            candidates_list = list(candidate_data.items())
            
            # Cache filtered results for this instance
            request_cache["valid_candidates"] = valid_candidates
            request_cache["histogram"] = target_class_histogram
            request_cache["centroids"] = centroids
            request_cache["candidate_data"] = candidate_data
            request_cache["candidates_list"] = candidates_list
            # Last, because it is the flag readers test: the entry is shared
            # between concurrent requests for the same key, and setting it
            # first let a reader past the guard while the fields it guards
            # were still half-written.
            request_cache["key"] = cache_key
        else:
            # Use cached data
            candidate_data = request_cache["candidate_data"]
            candidates_list = request_cache["candidates_list"]
        
        # First, prepare saved items (these will always appear first)
        saved_items = []
        existing_cell_ids = set()
        
        for saved_cell in saved_for_this_class:
            try:
                # Ensure consistent string type for cell_id
                cell_id_str = str(saved_cell["cell_id"])
                cell_id = int(cell_id_str)
                
                # Skip if already processed (avoid duplicates)
                if cell_id_str in existing_cell_ids:
                    logger.warning(f"[AL] Skipping duplicate saved cell {cell_id_str}")
                    continue
                existing_cell_ids.add(cell_id_str)
                
                # Get cell data from Zarr file for the saved cell
                if cell_id in range(len(centroids)):
                    centroid = centroids[cell_id]
                    
                    # Saved-cell tiles are rendered later, for the visible
                    # page only (see the page loop below). Rendering a tile
                    # per saved cell here does not scale — a class with
                    # thousands of saved cells would hang the request.
                    try:
                        tile_data = {"success": False}
                        
                        if tile_data.get("success", False):
                            crop_data = tile_data.get("data", {})
                            image_b64 = crop_data.get("image")
                            bounds = crop_data.get("bounds", {"x": 0, "y": 0, "w": 128, "h": 128})
                            bbox = crop_data.get("bbox", {"x": 54, "y": 54, "w": 20, "h": 20})
                            contour_from_api = crop_data.get("contour", [])
                            # Z-stack info
                            is_zstack_recl = crop_data.get("is_zstack", False)
                            num_z_layers_recl = crop_data.get("num_z_layers", None)
                            image_format_recl = crop_data.get("image_format", "jpeg")
                        else:
                            logger.warning(f"[AL] Failed to get image for saved cell {cell_id}: {tile_data.get('error', 'unknown')}")
                            image_b64 = _placeholder_image(f"Cell {cell_id}\nImage Error")
                            bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                            bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                            contour_from_api = []
                            is_zstack_recl = False
                            num_z_layers_recl = None
                            image_format_recl = "jpeg"
                            
                    except Exception as img_error:
                        logger.warning(f"[AL] Failed to generate image for saved cell {cell_id}: {img_error}")
                        image_b64 = _placeholder_image(f"Saved\nCell {cell_id}")
                        bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                        bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                        contour_from_api = []
                        is_zstack_recl = False
                        num_z_layers_recl = None
                        image_format_recl = "jpeg"
                    
                    # Extract contour from Zarr data if available and API didn't provide it
                    contour_from_zarr = []
                    if not contour_from_api and contours is not None and cell_id < len(contours):
                        try:
                            cell_contour = contours[cell_id]
                            if cell_contour.size > 0 and cell_contour.ndim == 2 and cell_contour.shape[1] == 2:
                                contour_from_zarr = [{"x": float(pt[0]), "y": float(pt[1])} for pt in cell_contour]
                        except Exception as contour_error:
                            logger.warning(f"[AL] Error processing contour for saved cell {cell_id}: {contour_error}")
                    
                    # Use API contour if available, otherwise Zarr contour
                    final_contour = contour_from_api if contour_from_api else contour_from_zarr
                    
                    # Create candidate item for saved cell
                    saved_item = {
                        "cell_id": cell_id_str,
                        "prob": saved_cell["prob"],
                        "centroid": {"x": float(centroid[0]), "y": float(centroid[1])},
                        "label": None,  # No label yet for the new class
                        "saved": True,
                        "original_class": saved_cell["original_class"],
                        "crop": {
                            "image": image_b64,
                            "bbox": bbox,
                            "bounds": bounds,
                            "contour": final_contour,
                            # Z-stack metadata
                            "is_zstack": is_zstack_recl,
                            "num_z_layers": num_z_layers_recl,
                            "image_format": image_format_recl
                        }
                    }
                    saved_items.append(saved_item)
                    
            except Exception as e:
                logger.warning(f"[AL] Error processing saved cell {saved_cell['cell_id']}: {e}")
                continue
        
        # Reuse cached filtered data for this instance when available
        # Saved cells might change between requests, so check
        saved_cells_changed = (request_cache.get("saved_hash") != 
                              (len(saved_from_this_class), len(saved_to_this_class), len(saved_items)))
        
        if use_cache and not saved_cells_changed and request_cache.get("filtered_candidates"):
            # Use cached filtered and unified data
            filtered_candidates = request_cache["filtered_candidates"]
            all_items_data = request_cache["all_items_data"]
            total_candidates = request_cache["total_candidates"]
        else:
            # Filter out saved cells from candidates_list
            filtered_candidates = []
            excluded_count = 0
            for cell_idx_str, cell_data in candidates_list:
                if (cell_idx_str not in saved_from_this_class and 
                    cell_idx_str not in saved_to_this_class):
                    filtered_candidates.append((cell_idx_str, cell_data))
                else:
                    excluded_count += 1

            # Create the unified list. In saved_only mode, return just the cells
            # already saved (reviewed) for this class; otherwise saved
            # items first, then the regular candidates.
            if saved_only:
                total_candidates = len(saved_items)
                all_items_data = [('saved', item) for item in saved_items]
            else:
                total_candidates = len(filtered_candidates) + (0 if exclude_saved else len(saved_items))
                all_items_data = []
                # Add saved items first (always at the beginning, regardless of sort order)
                if not exclude_saved:
                    for item in saved_items:
                        all_items_data.append(('saved', item))
                # Add regular candidates (these will be sorted by probability)
                for cell_idx_str, cell_data in filtered_candidates:
                    all_items_data.append(('regular', (cell_idx_str, cell_data)))
            
            # Cache filtered and unified data for this instance
            if use_cache:
                request_cache["filtered_candidates"] = filtered_candidates
                request_cache["all_items_data"] = all_items_data
                request_cache["total_candidates"] = total_candidates
                request_cache["saved_hash"] = (len(saved_from_this_class), len(saved_to_this_class), len(saved_items))
        
        # Apply pagination to the unified list
        start_idx = offset
        end_idx = min(offset + limit, len(all_items_data))
        page_items_data = all_items_data[start_idx:end_idx]
        
        # Use the target class histogram we generated above
        hist = target_class_histogram if 'target_class_histogram' in locals() else [0] * 20
        
        # Generate final items list
        items = []
        for item_type, item_data in page_items_data:
            if item_type == 'saved':
                # Render the real tile now (the saved loop used a placeholder
                # so it would not render thousands of tiles up-front)
                cell_idx = int(str(item_data["cell_id"]))
                try:
                    tile = get_cell_review_tile_data({
                        "slide_id": params["slide_id"],
                        "cell_id": cell_idx,
                        "centroid": {
                            "x": float(centroids[cell_idx, 0]),
                            "y": float(centroids[cell_idx, 1])
                        },
                        "window_size_px": 128,
                        "target_fov_um": 20.0,
                        "padding_ratio": 0.1,
                        "return_contour": True
                    })
                    if tile.get("success", False):
                        td = tile.get("data", {})
                        if td.get("image"):
                            item_data["crop"]["image"] = td["image"]
                        if td.get("bounds"):
                            item_data["crop"]["bounds"] = td["bounds"]
                        if td.get("bbox"):
                            item_data["crop"]["bbox"] = td["bbox"]
                        if td.get("contour"):
                            item_data["crop"]["contour"] = td["contour"]
                        item_data["crop"]["is_zstack"] = td.get("is_zstack", False)
                        item_data["crop"]["num_z_layers"] = td.get("num_z_layers")
                        item_data["crop"]["image_format"] = td.get("image_format", "jpeg")
                except Exception as e:
                    logger.warning(f"[AL] Failed to render saved tile for cell {cell_idx}: {e}")
                items.append(item_data)
            else:
                # Process regular candidate
                cell_idx_str, cell_data = item_data
                cell_idx = int(cell_idx_str)
                
                # Extract centroid ONLY for this cell (not all 218k!)
                centroid_x = float(centroids[cell_idx, 0])
                centroid_y = float(centroids[cell_idx, 1])
                
                # Get cell image
                try:
                    cell_image_data = get_cell_review_tile_data({
                        "slide_id": params["slide_id"],
                        "cell_id": cell_idx,
                        "centroid": {
                            "x": centroid_x,
                            "y": centroid_y
                        },
                        "window_size_px": 128,
                        "target_fov_um": 20.0,  # Standard FOV for cell review
                        "padding_ratio": 0.1,   # Less padding to keep cell more centered
                        "return_contour": True
                    })
                    
                    if cell_image_data.get("success", False):
                        crop_data = cell_image_data.get("data", {})
                        image_b64 = crop_data.get("image")
                        bounds = crop_data.get("bounds", {"x": 0, "y": 0, "w": 128, "h": 128})
                        bbox = crop_data.get("bbox", {"x": 54, "y": 54, "w": 20, "h": 20})
                        contour = crop_data.get("contour", [])
                        # Z-stack info
                        is_zstack = crop_data.get("is_zstack", False)
                        num_z_layers = crop_data.get("num_z_layers", None)
                        image_format = crop_data.get("image_format", "jpeg")
                    else:
                        logger.warning(f"[AL] Failed to get image for cell {cell_idx}: {cell_image_data.get('error', 'unknown')}")
                        # Generate a placeholder image with error message
                        image_b64 = _placeholder_image(f"Cell {cell_idx}\nImage Error")
                        bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                        bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                        contour = []
                        is_zstack = False
                        num_z_layers = None
                        image_format = "jpeg"
                        
                except Exception as img_error:
                    logger.error(f"[AL] Error generating image for cell {cell_idx}: {img_error}", exc_info=img_error)
                    # Generate a placeholder image with error message
                    image_b64 = _placeholder_image(f"Cell {cell_idx}\nGeneration Error")
                    bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                    bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                    contour = []
                    is_zstack = False
                    num_z_layers = None
                    image_format = "jpeg"
                
                candidate_item = {
                    "cell_id": cell_idx_str,  # Keep as string for JSON
                    "prob": float(cell_data['prob']),
                    "centroid": {
                        "x": centroid_x,
                        "y": centroid_y
                    },
                    "saved": False,
                    "crop": {
                        "image": image_b64,
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
                        "contour": contour if contour else [],
                        # Z-stack metadata
                        "is_zstack": is_zstack,
                        "num_z_layers": num_z_layers,
                        "image_format": image_format
                    }
                }
                items.append(candidate_item)
        
        return {
            "success": True,
            "data": {
                "total": int(total_candidates),
                "hist": hist,  # Use actual histogram data
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
        cache_key = ("patch", zarr_path, class_name, threshold, sort_order,
                     exclude_saved, side, saved_only, _user_annotation_mtime(zarr_path))
        request_cache = _get_request_cache(cache_key)
        use_cache = (request_cache["key"] == cache_key and
                     request_cache["valid_candidates"] and
                     request_cache["centroids"] is not None)

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
            uncertainties = np.abs(max_probs - 0.5)

            # Histogram over ALL patches predicted as the target class
            tgt_probs = max_probs[classifications == target_idx]
            if len(tgt_probs) > 0:
                target_class_histogram = [int(x) for x in np.histogram(tgt_probs, bins=20, range=(0.0, 1.0))[0].tolist()]
            else:
                target_class_histogram = [0] * 20

            saved_cell_ids = set(int(c["cell_id"]) for c in saved_for_this_class)
            valid_candidates = []
            for idx in range(len(classifications)):
                idx_str = str(idx)
                is_predicted = int(classifications[idx]) == target_idx
                is_saved_to = idx in saved_cell_ids
                is_saved_from = idx_str in saved_from_this_class
                should_include = (is_predicted or is_saved_to) and not is_saved_from
                if exclude_saved and is_saved_to:
                    should_include = False  # already saved to this class -> not a candidate
                if not should_include:
                    continue
                max_prob = float(max_probs[idx])
                effective_threshold = 0.0 if class_name == "Negative control" else threshold
                if side == "right":
                    if max_prob >= effective_threshold:
                        valid_candidates.append((idx, max_prob, float(uncertainties[idx])))
                else:
                    if max_prob < effective_threshold:
                        valid_candidates.append((idx, max_prob, float(uncertainties[idx])))

            # Sort by uncertainty (lower = more uncertain = shown first for "asc")
            valid_candidates.sort(key=lambda x: x[2], reverse=(sort_order == "desc"))

            candidate_data = {str(i): {"prob": float(p), "uncertainty": float(u)}
                              for i, p, u in valid_candidates}
            candidates_list = list(candidate_data.items())

            request_cache["valid_candidates"] = valid_candidates
            request_cache["histogram"] = target_class_histogram
            request_cache["centroids"] = centroids
            request_cache["coordinates"] = coordinates
            request_cache["max_probs"] = max_probs
            request_cache["candidate_data"] = candidate_data
            request_cache["candidates_list"] = candidates_list
            # Published last — see the note in the cell-candidate path.
            request_cache["key"] = cache_key
        else:
            centroids = request_cache["centroids"]
            coordinates = request_cache["coordinates"]
            max_probs = request_cache["max_probs"]
            candidate_data = request_cache["candidate_data"]
            candidates_list = request_cache["candidates_list"]
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
        filtered_candidates = [(cid, cd) for cid, cd in candidates_list
                               if cid not in saved_from_this_class and cid not in saved_to_this_class]
        if saved_only:
            total_candidates = len(saved_for_this_class)
            all_items_data = [('saved', sc) for sc in saved_for_this_class]
        else:
            total_candidates = len(filtered_candidates) + (0 if exclude_saved else len(saved_for_this_class))
            all_items_data = []
            if not exclude_saved:
                for sc in saved_for_this_class:
                    all_items_data.append(('saved', sc))
            for cid, cd in filtered_candidates:
                all_items_data.append(('regular', (cid, cd)))

        # Paginate, then build tiles only for the visible page
        page_items = all_items_data[offset:min(offset + limit, len(all_items_data))]
        seen = set()
        items = []
        for item_type, item_data in page_items:
            if item_type == 'saved':
                pidx = int(str(item_data["cell_id"]))
                if str(pidx) in seen or pidx < 0 or pidx >= len(coordinates):
                    continue
                seen.add(str(pidx))
                items.append(_patch_item(pidx, True, item_data.get("original_class")))
            else:
                cid, cd = item_data
                pidx = int(cid)
                if pidx < 0 or pidx >= len(coordinates):
                    continue
                items.append(_patch_item(pidx, False))

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


def _filter_candidates_by_roi(valid_candidates, centroids, roi, polygon_points):
    """Keep candidates whose centroids fall in roi bbox (and optional polygon)."""
    if not roi or centroids is None or len(valid_candidates) == 0:
        return valid_candidates
    try:
        x1 = float(roi["x1"]); y1 = float(roi["y1"])
        x2 = float(roi["x2"]); y2 = float(roi["y2"])
    except Exception:
        return valid_candidates

    idxs = np.asarray([c[0] for c in valid_candidates], dtype=np.int64)
    # Guard out-of-range indices
    valid_mask = (idxs >= 0) & (idxs < len(centroids))
    idxs_safe = idxs[valid_mask]
    pts = np.asarray(centroids)[idxs_safe]
    in_bbox = (
        (x1 <= pts[:, 0]) & (pts[:, 0] <= x2) &
        (y1 <= pts[:, 1]) & (pts[:, 1] <= y2)
    )
    keep_local = in_bbox
    if polygon_points and isinstance(polygon_points, (list, tuple)) and len(polygon_points) >= 3:
        try:
            from matplotlib.path import Path
            poly = [
                (float(p[0]), float(p[1]))
                for p in polygon_points
                if isinstance(p, (list, tuple)) and len(p) >= 2
            ]
            if len(poly) >= 3:
                inside = Path(poly).contains_points(pts, radius=-1e-9)
                keep_local = in_bbox & inside
        except Exception as e:
            logger.warning(f"[AL] ROI polygon filter failed, using bbox only: {e}")

    allowed = set(int(i) for i in idxs_safe[keep_local])
    return [c for c in valid_candidates if int(c[0]) in allowed]


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
