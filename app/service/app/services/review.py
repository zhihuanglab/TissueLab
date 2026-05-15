import zarr
import numpy as np
import json
import logging
import traceback
import time
from typing import Dict, List, Optional, Tuple
import os
import base64
import random
from io import BytesIO
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont
from app.utils import resolve_path
from app.services.tasks_service import (
    get_cell_review_tile_data, 
    _int_color_to_hex,
    _get_annotation_dtype,
    _hex_color_to_int,
    _truncate_field,
    _safe_replace_dataset
)
from app.services.seg_service import SegmentationHandler
from app.config.zarr_config import ZarrGroups, ZarrDatasets, ZarrPaths, find_segmentation_group

logger = logging.getLogger(__name__)

# ==================== MULTI-USER ISOLATION ====================
# ALL global storage MUST be organized by instance_id to prevent cross-user contamination
# Structure: {instance_id: {slide_path: {cell_id: data}}}
# 
# CRITICAL: Without instance_id isolation:
#   - User A's reclassifications will appear in User B's session
#   - User A's cache will be served to User B
#   - User A can overwrite User B's temporary cells
# ============================================================

_reclassified_cells = {}  # {instance_id: {slide_path: {cell_id: data}}}
_temporary_cells = {}     # {instance_id: {slide_path: {cell_id: data}}}
_last_request_cache = {}  # {instance_id: {key: ..., valid_candidates: [], ...}}
# Global cache for loaded reclassifications from Zarr (shared across instances for same file)
# Structure: {zarr_path: {data: Dict, mtime: float}}
_zarr_reclassifications_cache = {}  # {zarr_path: {data: Dict, mtime: float}}


def _get_instance_id(params: Dict) -> str:
    """
    Extract instance_id from params for multi-user isolation.
    REQUIRED: instance_id must be provided to prevent data mixing between users/sessions.
    
    Args:
        params: Request parameters dict
        
    Returns:
        instance_id string
        
    Raises:
        ValueError: If instance_id is missing or empty
    """
    instance_id = params.get("instance_id")
    if not instance_id or instance_id.strip() == "":
        raise ValueError(
            "instance_id is required for multi-user isolation. "
            "Frontend must provide X-Instance-ID header with a unique session identifier."
        )
    return instance_id


def _get_reclassified_cells(instance_id: str, zarr_path: str) -> Dict:
    """
    Get reclassified cells for specific instance and slide.
    Ensures proper nested dict structure and loads from Zarr if not in memory.
    Uses global cache to avoid repeated Zarr reads for the same file.
    
    Args:
        instance_id: User instance identifier
        zarr_path: Path to zarr file
        
    Returns:
        Dict of reclassified cells for this instance+slide
    """
    if instance_id not in _reclassified_cells:
        _reclassified_cells[instance_id] = {}
    if zarr_path not in _reclassified_cells[instance_id]:
        # Only initialize if key doesn't exist
        _reclassified_cells[instance_id][zarr_path] = {}
    
    # Check if we already have data in memory (fast path)
    if len(_reclassified_cells[instance_id][zarr_path]) > 0:
        return _reclassified_cells[instance_id][zarr_path]
    
    # Check global cache first (shared across instances for same file)
    # This avoids reading Zarr file if another instance already loaded it
    if zarr_path in _zarr_reclassifications_cache:
        cache_entry = _zarr_reclassifications_cache[zarr_path]
        try:
            current_mtime = os.path.getmtime(zarr_path)
            if cache_entry.get('mtime') == current_mtime:
                # Use cached data for this instance
                _reclassified_cells[instance_id][zarr_path] = cache_entry['data'].copy()
                return _reclassified_cells[instance_id][zarr_path]
        except (OSError, KeyError):
            pass  # File doesn't exist or cache is invalid, continue to load
    
    # Only auto-load from Zarr if the dict is completely empty (not initialized yet)
    # Don't reload if there's already data in memory (to avoid overwriting recent changes)
    try:
        # Use global cache to avoid repeated Zarr reads
        loaded_cells = _load_reclassifications_from_zarr(zarr_path)
        if loaded_cells:
            _reclassified_cells[instance_id][zarr_path] = loaded_cells
    except Exception as e:
        pass  # Silently ignore if auto-load fails
    
    return _reclassified_cells[instance_id][zarr_path]


def _get_temporary_cells(instance_id: str, zarr_path: str) -> Dict:
    """
    Get temporary cells for specific instance and slide.
    Ensures proper nested dict structure.
    
    Args:
        instance_id: User instance identifier
        zarr_path: Path to zarr file
        
    Returns:
        Dict of temporary cells for this instance+slide
    """
    if instance_id not in _temporary_cells:
        _temporary_cells[instance_id] = {}
    if zarr_path not in _temporary_cells[instance_id]:
        _temporary_cells[instance_id][zarr_path] = {}
    return _temporary_cells[instance_id][zarr_path]


def _get_request_cache(instance_id: str) -> Dict:
    """
    Get request cache for specific instance.
    Ensures proper cache structure.
    
    Args:
        instance_id: User instance identifier
        
    Returns:
        Dict cache for this instance
    """
    if instance_id not in _last_request_cache:
        _last_request_cache[instance_id] = {
            "key": None,
            "valid_candidates": [],
            "histogram": [],
            "centroids": None,
            "candidate_data": {},
            "candidates_list": [],
            "filtered_candidates": []
        }
    return _last_request_cache[instance_id]


def cleanup_instance_data(instance_id: str) -> Dict:
    """
    Clean up all data associated with an instance when it's deleted.
    Should be called when instance is deleted or expired.
    
    Args:
        instance_id: User instance identifier to clean up
        
    Returns:
        Dict with cleanup statistics
    """
    try:
        stats = {
            "reclassified_slides_cleared": 0,
            "temporary_slides_cleared": 0,
            "cache_cleared": False
        }
        
        # Clear reclassified cells for this instance
        if instance_id in _reclassified_cells:
            stats["reclassified_slides_cleared"] = len(_reclassified_cells[instance_id])
            del _reclassified_cells[instance_id]
        
        # Clear temporary cells for this instance
        if instance_id in _temporary_cells:
            stats["temporary_slides_cleared"] = len(_temporary_cells[instance_id])
            del _temporary_cells[instance_id]
        
        # Clear request cache for this instance
        if instance_id in _last_request_cache:
            del _last_request_cache[instance_id]
            stats["cache_cleared"] = True
        
        logger.info(f"[AL Cleanup] Cleaned up instance {instance_id}: {stats}")
        
        return {
            "success": True,
            "instance_id": instance_id,
            "stats": stats
        }
    except Exception as e:
        logger.error(f"[AL Cleanup] Error cleaning up instance {instance_id}: {e}")
        return {
            "success": False,
            "error": str(e)
        }


def _handle_special_class_candidates(params: Dict, reclassified_for_this_class: List, slide_path: str) -> Dict:
    try:
        items = []
        existing_cell_ids = set()  # Track to avoid duplicates
        
        # Load Zarr file to get basic data for reclassified cells
        zarr_path = slide_path + '.zarr' if not slide_path.endswith('.zarr') else slide_path
        
        with zarr.open(zarr_path, 'r') as zf:
            # Find morphology data using centralized config
            seg_group = find_segmentation_group(zf)
            
            if seg_group is None or ZarrDatasets.CENTROIDS not in seg_group:
                logger.error(f"[AL] No morphology data found for special class")
                return {"success": True, "data": {"total": 0, "hist": [0]*20, "items": []}}
            
            centroids = seg_group[ZarrDatasets.CENTROIDS][:]
            contours = seg_group.get(ZarrDatasets.CONTOURS, None)
            
            # Process each reclassified cell
            for reclassified_cell in reclassified_for_this_class:
                try:
                    # Ensure consistent string type for cell_id
                    cell_id_str = str(reclassified_cell["cell_id"])
                    cell_id = int(cell_id_str)
                    
                    # Skip if already processed (avoid duplicates)
                    if cell_id_str in existing_cell_ids:
                        logger.warning(f"[AL] Skipping duplicate special class cell {cell_id_str}")
                        continue
                    existing_cell_ids.add(cell_id_str)
                    
                    # Get cell data from Zarr file
                    if cell_id >= len(centroids):
                        logger.warning(f"[AL] Cell {cell_id} index out of range for centroids")
                        continue
                        
                    centroid = centroids[cell_id]
                    
                    # Generate image for reclassified cell
                    try:
                        tile_data = get_cell_review_tile_data({
                            "slide_id": params["slide_id"],
                            "cell_id": cell_id,
                            "centroid": {
                                "x": float(centroid[0]),
                                "y": float(centroid[1])
                            },
                            "window_size_px": 128,
                            "target_fov_um": 20.0,  # Standard FOV for cell review
                            "padding_ratio": 0.1,
                            "return_contour": True
                        })
                        
                        if tile_data.get("success", False):
                            crop_data = tile_data.get("data", {})
                            image_b64 = crop_data.get("image")
                            bounds = crop_data.get("bounds", {"x": 0, "y": 0, "w": 128, "h": 128})
                            bbox = crop_data.get("bbox", {"x": 54, "y": 54, "w": 20, "h": 20})
                            contour_from_api = crop_data.get("contour", [])
                            # Z-stack info
                            is_zstack_special = crop_data.get("is_zstack", False)
                            num_z_layers_special = crop_data.get("num_z_layers", None)
                            image_format_special = crop_data.get("image_format", "jpeg")
                        else:
                            logger.warning(f"[AL] Failed to get image for reclassified cell {cell_id}: {tile_data.get('error', 'unknown')}")
                            image_b64 = _generate_error_placeholder_image(f"Cell {cell_id}\nImage Error")
                            bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                            bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                            contour_from_api = []
                            is_zstack_special = False
                            num_z_layers_special = None
                            image_format_special = "jpeg"
                            
                    except Exception as img_error:
                        logger.warning(f"[AL] Failed to generate image for special class cell {cell_id}: {img_error}")
                        image_b64 = _generate_error_placeholder_image(f"Reclassified\nCell {cell_id}")
                        bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                        bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                        contour_from_api = []
                        is_zstack_special = False
                        num_z_layers_special = None
                        image_format_special = "jpeg"
                    
                    # Extract contour from Zarr data if available and API didn't provide it
                    contour_from_zarr = []
                    if not contour_from_api and contours is not None and cell_id < len(contours):
                        try:
                            cell_contour = contours[cell_id]
                            if cell_contour.size > 0 and cell_contour.ndim == 2 and cell_contour.shape[1] == 2:
                                contour_from_zarr = [{"x": float(pt[0]), "y": float(pt[1])} for pt in cell_contour]
                        except Exception as contour_error:
                            logger.warning(f"[AL] Error processing contour for special class cell {cell_id}: {contour_error}")
                    
                    # Use API contour if available, otherwise Zarr contour
                    final_contour = contour_from_api if contour_from_api else contour_from_zarr
                    
                    # Create candidate item for special class
                    candidate_item = {
                        "cell_id": str(cell_id),
                        "prob": reclassified_cell["prob"],  # Keep original probability for reference
                        "centroid": {"x": float(centroid[0]), "y": float(centroid[1])},
                        "label": None,  # No label for special classes
                        "reclassified": True,
                        "original_class": reclassified_cell["original_class"],
                        "crop": {
                            "image": image_b64,
                            "bbox": bbox,
                            "bounds": bounds,
                            "contour": final_contour,
                            # Z-stack metadata
                            "is_zstack": is_zstack_special,
                            "num_z_layers": num_z_layers_special,
                            "image_format": image_format_special
                        }
                    }
                    items.append(candidate_item)
                    
                except Exception as e:
                    logger.warning(f"[AL] Error processing special class cell {reclassified_cell['cell_id']}: {e}")
                    continue
        
        # Return results for special class
        total_count = len(items)
        
        return {
            "success": True,
            "data": {
                "total": total_count,
                "hist": [0] * 20,  # No histogram for special classes
                "items": items
            }
        }
        
    except Exception as e:
        logger.error(f"[AL] Error handling special class: {str(e)}")
        return {"success": False, "error": f"Error handling special class: {str(e)}"}




def _load_reclassifications_from_zarr(zarr_path: str) -> Dict:
    """
    Load reclassifications from Zarr file with caching.
    Uses global cache to avoid repeated reads of the same file.
    """
    try:
        # Check global cache first (shared across instances for same file)
        if zarr_path in _zarr_reclassifications_cache:
            cache_entry = _zarr_reclassifications_cache[zarr_path]
            # Check if file modification time matches (simple cache invalidation)
            try:
                current_mtime = os.path.getmtime(zarr_path)
                if cache_entry.get('mtime') == current_mtime:
                    return cache_entry['data'].copy()  # Return copy to avoid mutations
            except (OSError, KeyError):
                pass  # File doesn't exist or cache is invalid, continue to load
        
        if not os.path.exists(zarr_path):
            logger.debug(f"[AL Load] Zarr file not found: {zarr_path}")
            return {}
        
        reclassified_data = {}
        
        # Use seg_service.py's pattern for loading manual annotations
        with zarr.open(zarr_path, 'r') as zarr_file:
            # Follow seg_service.py's _apply_manual_nuclei_annotations pattern
            if ZarrGroups.USER_ANNOTATION not in zarr_file:
                logger.debug(f"[AL Load] No user_annotation group found in Zarr file: {zarr_path}")
                return {}

            user_annotation_group = zarr_file[ZarrGroups.USER_ANNOTATION]
            base_name = ZarrDatasets.NUCLEI_ANNOTATIONS
            
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
                
                # CRITICAL OPTIMIZATION: Check for reclassifications using chunked reading
                # This avoids loading the entire method array into memory for very large datasets
                # when there are no reclassifications
                method_dataset = annotations_dataset['method']
                total_size = method_dataset.shape[0] if hasattr(method_dataset, 'shape') else len(method_dataset)
                
                # For small datasets, read the full array (more efficient than chunking)
                # For large datasets, use chunked reading to check for reclassifications first
                CHUNK_SIZE = 100000  # Check 100k elements at a time
                has_reclassifications = False
                method_data = None
                reclassification_mask = None
                
                if total_size <= CHUNK_SIZE:
                    # Small dataset: read full array directly
                    method_data = method_dataset[:]
                    reclassification_mask = method_data == 'reclassification'
                    has_reclassifications = np.any(reclassification_mask)
                else:
                    # Large dataset: check chunks first to avoid loading everything if no reclassifications exist
                    for start_idx in range(0, total_size, CHUNK_SIZE):
                        end_idx = min(start_idx + CHUNK_SIZE, total_size)
                        chunk_data = method_dataset[start_idx:end_idx]
                        if np.any(chunk_data == 'reclassification'):
                            has_reclassifications = True
                            break
                    
                    # If reclassifications found, read full array to get all indices
                    if has_reclassifications:
                        method_data = method_dataset[:]
                        reclassification_mask = method_data == 'reclassification'
                
                # Early return if no reclassifications found (handles both small and large datasets)
                if not has_reclassifications:
                    # Cache empty result to avoid repeated checks
                    try:
                        mtime = os.path.getmtime(zarr_path)
                        _zarr_reclassifications_cache[zarr_path] = {'data': {}, 'mtime': mtime}
                    except OSError:
                        # File may not exist or be inaccessible; safe to ignore for cache update
                        pass
                    logger.debug(f"[AL Load] No reclassification annotations found (checked {total_size} elements)")
                    return {}
                
                # Only read cell_class for indices that have reclassifications
                # This is much faster than reading the entire array
                valid_indices = np.where(reclassification_mask)[0]
                
                if len(valid_indices) == 0:
                    return {}
                
                # Read only the cell_class data for reclassified cells
                # This is a huge optimization when there are few reclassifications
                cell_class_ids = annotations_dataset['cell_class'][valid_indices]
                
                # Filter out unclassified cells (new format: -1 = unclassified, 0+ = class index)
                non_empty_mask = cell_class_ids >= 0
                if not np.any(non_empty_mask):
                    # Cache empty result
                    try:
                        mtime = os.path.getmtime(zarr_path)
                        _zarr_reclassifications_cache[zarr_path] = {'data': {}, 'mtime': mtime}
                    except OSError:
                        # File may not exist or be accessible; safe to ignore for cache update
                        pass
                    logger.debug(f"[AL Load] No non-empty reclassifications found")
                    return {}
                
                # Update valid_indices to only include non-empty ones
                valid_indices = valid_indices[non_empty_mask]
                cell_class_ids = cell_class_ids[non_empty_mask]
                
                # Get class_names from metadata to convert IDs to names
                class_names = None
                if 'class_names' in user_annotation_group.attrs:
                    class_names = user_annotation_group.attrs.get('class_names', [])
                
                logger.debug(f"[AL Load] Found {len(valid_indices)} reclassifications to process")
            except Exception as e:
                logger.warning(f"[AL Load] Failed to load structured array format annotations: {e}")
                return {}
            
            # Define temporary/special classes that should NOT be loaded
            TEMPORARY_CLASSES = {"Other", "Not Sure", "Incorrect Segmentation"}
            
            # Optimize: batch read cell_color and datetime for all valid indices at once
            # This is much faster than reading one by one
            cell_color_data = annotations_dataset['cell_color'][valid_indices]
            datetime_data = annotations_dataset['datetime'][valid_indices]
            
            reclassified_data = {}
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
                
                # Skip temporary classes - don't load them into memory
                if new_class in TEMPORARY_CLASSES:
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
                
                reclassified_data[cell_id_str] = {
                        "original_class": original_class,
                        "new_class": new_class,
                        "prob": 0.0,  # Not stored in structured array
                        "timestamp": datetime_str,
                        # Maintain original_original_class for multi-step reclassification tracking
                        "original_original_class": original_class,  # Keep as-is, even if None
                        # Load centroid and color from zarr if present
                        "centroid_x": None,  # Not stored in structured array (can be computed from centroids)
                        "centroid_y": None,  # Not stored in structured array (can be computed from centroids)
                        "cell_color": cell_color
                    }
            
            if reclassified_data:
                logger.info(f"[AL Load] Loaded {len(reclassified_data)} persistent reclassifications from Zarr")
            if filtered_count > 0:
                logger.info(f"[AL Load] Filtered out {filtered_count} temporary class reclassifications")
        
        # Cache the result with file modification time
        try:
            mtime = os.path.getmtime(zarr_path)
            _zarr_reclassifications_cache[zarr_path] = {
                'data': reclassified_data,
                'mtime': mtime
            }
        except OSError:
            pass  # Can't get mtime, don't cache
        
        return reclassified_data
        
    except Exception as e:
        logger.error(f"[AL Load] Error loading reclassifications from Zarr: {str(e)}")
        return {}


def _generate_error_placeholder_image(error_text: str = "Image Error") -> str:
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
        logger.error(f"Error generating placeholder image: {e}")
        # Return a minimal base64 image as fallback
        return "data:image/svg+xml;base64," + base64.b64encode(
            b'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#f0f0f0"/></svg>'
        ).decode('utf-8')

def get_candidates_data(params: Dict) -> Dict:
    try:
        # MULTI-USER: Extract instance_id FIRST
        instance_id = _get_instance_id(params)
        logger.info(f"[AL] Processing request for instance_id: {instance_id}")
        
        slide_path = resolve_path(params["slide_id"])
        zarr_path = slide_path + '.zarr' if not slide_path.endswith('.zarr') else slide_path
        if os.path.exists(zarr_path):
            logger.info(f"[AL] Using Zarr file: {zarr_path}")
        else:
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}
        
        # Check if this is a z-stack request
        z_layer = params.get("z_layer")  # Optional: specific z-layer to show candidates from
        show_all_layers = params.get("show_all_layers", False)  # Show candidates from all layers
        
        if z_layer is not None or show_all_layers:
            logger.info(f"[AL Z-Stack] Processing z-stack candidates: z_layer={z_layer}, show_all={show_all_layers}")
        
        # MULTI-USER: Get instance-specific reclassified cells
        reclassified_cells_for_instance = _get_reclassified_cells(instance_id, zarr_path)
        
        # Auto-load reclassifications from Zarr file using seg_service.py pattern
        if not reclassified_cells_for_instance:
            logger.info(f"[AL Load] Attempting to load reclassifications from Zarr: {zarr_path}")
            loaded_reclassifications = _load_reclassifications_from_zarr(zarr_path)
            if loaded_reclassifications:
                # Store in instance-specific location
                _reclassified_cells[instance_id][zarr_path] = loaded_reclassifications
                reclassified_cells_for_instance = loaded_reclassifications
                logger.info(f"[AL Load] Loaded {len(loaded_reclassifications)} reclassifications with centroid data")
                # Log first item to verify
                first_key = next(iter(loaded_reclassifications))
                first_data = loaded_reclassifications[first_key]
                logger.info(f"[AL Load] Sample data - Cell {first_key}: centroid_x={first_data.get('centroid_x')}, centroid_y={first_data.get('centroid_y')}, color={first_data.get('cell_color')}")
            else:
                logger.info(f"[AL Load] No reclassifications found in Zarr")
        
        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"File not found: {zarr_path}"}
        
        class_name = params.get("class_name")
        threshold = params.get("threshold", 0.5)
        sort_order = params.get("sort", "asc")  # "asc" = Low to High, "desc" = High to Low
        limit = params.get("limit", 80)
        offset = params.get("offset", 0)
        exclude_reclassified = params.get("exclude_reclassified", False)  # New parameter
        side = params.get("side", "left")  # "left" = prob < threshold, "right" = prob >= threshold
        
        # MULTI-USER: Get instance-specific cache
        request_cache = _get_request_cache(instance_id)
        
        # CHECK CACHE: Check if we can use cached candidate list
        # Include exclude_reclassified and side in key to handle "Show reclassified" toggle and side selection
        cache_key = (zarr_path, class_name, threshold, sort_order, exclude_reclassified, side)
        use_cache = (request_cache["key"] == cache_key and 
                     request_cache["valid_candidates"] and
                     request_cache["centroids"] is not None)
        
        if use_cache:
            logger.info(f"[AL Cache] Using cached data for instance {instance_id}")
            valid_candidates = request_cache["valid_candidates"]
            target_class_histogram = request_cache["histogram"]
            centroids = request_cache["centroids"]
        
        # Special classes that don't use probability-based filtering
        special_classes = {"Other", "Not Sure", "Incorrect Segmentation"}
        is_special_class = class_name in special_classes
        
        # Check for reclassified cells (both persistent and temporary)
        reclassified_for_this_class = []
        reclassified_from_this_class = set()  # Cells to exclude from this class
        reclassified_to_this_class = set()    # Cells reclassified TO this class (also exclude from regular candidates)
        
        # MULTI-USER: Combine persistent and temporary reclassifications for THIS INSTANCE ONLY
        all_reclassified = {}
        instance_reclassified = _get_reclassified_cells(instance_id, zarr_path)
        instance_temporary = _get_temporary_cells(instance_id, zarr_path)
        all_reclassified.update(instance_reclassified)
        all_reclassified.update(instance_temporary)
        
        if all_reclassified:
            for cell_id, reclassify_data in all_reclassified.items():
                # Ensure cell_id is always stored as string for consistent comparison
                cell_id_str = str(cell_id)
                
                if reclassify_data["new_class"] == class_name:
                    # This cell was reclassified TO this class
                    reclassified_for_this_class.append({
                        "cell_id": cell_id_str,
                        "prob": reclassify_data["prob"],
                        "reclassified": True,
                        "original_class": reclassify_data.get("original_original_class", reclassify_data["original_class"])  # Use true original class
                    })
                    # Also add to the exclusion set to prevent duplicates in regular candidates
                    # Use string type for consistent comparison
                    reclassified_to_this_class.add(cell_id_str)
                    logger.debug(f"[AL Debug] Cell {cell_id_str} reclassified TO '{class_name}' from '{reclassify_data.get('original_original_class', reclassify_data['original_class'])}'")
                
                # Exclude cells that are currently reclassified FROM this class
                # This prevents cells from appearing in both their new class AND original class
                original_original_class = reclassify_data.get("original_original_class", reclassify_data["original_class"])
                
                # Special handling for cells with None original_class (from buggy old data)
                # These cells should be excluded from ALL classes except their new_class
                if original_original_class is None:
                    # If this cell's new_class is NOT the current class, exclude it
                    if reclassify_data["new_class"] != class_name:
                        reclassified_from_this_class.add(cell_id_str)
                        logger.debug(f"[AL Debug] Cell {cell_id_str} has None original_class, new_class='{reclassify_data['new_class']}', excluding from '{class_name}' candidates")
                else:
                    # Normal case: check if original matches current class AND new is different
                    if original_original_class == class_name and reclassify_data["new_class"] != class_name:
                        # This cell's TRUE original class is this class AND it's currently reclassified to a different class
                        # Exclude it from probability candidates to prevent duplicates
                        reclassified_from_this_class.add(cell_id_str)
                        logger.debug(f"[AL Debug] Cell {cell_id_str} reclassified FROM '{class_name}' to '{reclassify_data['new_class']}'")
        
        
        # Handle special classes differently - they only show reclassified cells
        if is_special_class:
            return _handle_special_class_candidates(params, reclassified_for_this_class, slide_path)
        
        # SKIP EXPENSIVE OPERATIONS IF CACHE HIT
        if not use_cache:
            with zarr.open(zarr_path, 'r') as zf:
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
                
                if ZarrGroups.CLASSIFICATION_NODE in zf:
                    classification_group = zf[ZarrGroups.CLASSIFICATION_NODE]
                    # Read classification results
                    classifications = classification_group[ZarrDatasets.NUCLEI_CLASS_ID][:] if ZarrDatasets.NUCLEI_CLASS_ID in classification_group else None
                    if ZarrDatasets.NUCLEI_CLASS_NAME in classification_group:
                        class_names = [name.decode() if isinstance(name, bytes) else name for name in classification_group[ZarrDatasets.NUCLEI_CLASS_NAME][:]]
                
                # If no classification data exists, but we have reclassified cells for this class, we can still show them
                has_classification_data = classifications is not None and class_names is not None
                has_reclassified_cells = len(reclassified_for_this_class) > 0
                
                if not has_classification_data and not has_reclassified_cells:
                    logger.error(f"[AL] No ClassificationNode found and no reclassified cells - classification must be run first")
                    return {"success": False, "error": "No ClassificationNode found - please run classification first"}
                
                # Read probabilities - check multiple sources (only if classification group exists)
                probabilities = None
                
                if classification_group is not None:
                    if ZarrDatasets.NUCLEI_CLASS_PROBABILITIES in classification_group:
                        probabilities = classification_group[ZarrDatasets.NUCLEI_CLASS_PROBABILITIES][:]
                    elif ZarrDatasets.PROBABILITY in seg_group:
                        probabilities = seg_group[ZarrDatasets.PROBABILITY][:]
                
                # Only return error if we have no probabilities AND no reclassified cells
                if probabilities is None and not has_reclassified_cells:
                    logger.warning(f"[AL] No probability data found and no reclassified cells")
                    return {"success": False, "error": "No probability data found - please run segmentation or classification"}
            
            # Filter by target class and apply threshold and sorting  
            candidate_data = {}
            
            # Check if we can process normal candidates (from classification data)
            can_process_normal_candidates = (probabilities is not None and class_name and 
                                            classifications is not None and class_names is not None and 
                                            class_name in class_names)
            
            if can_process_normal_candidates:
                target_class_idx = class_names.index(class_name)
            elif not has_reclassified_cells:
                # No normal candidates AND no reclassified cells - return error
                if class_names is not None and class_name not in class_names:
                    logger.warning(f"[AL] Target class '{class_name}' not found in available classes: {class_names}")
                    return {"success": False, "error": f"Target class '{class_name}' not found in classification data"}
                else:
                    logger.warning(f"[AL] No classification data available for class '{class_name}'")
                    return {"success": False, "error": "No classification data available"}
            else:
                # No normal candidates BUT we have reclassified cells - continue with only reclassified cells
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
                
                # Find cells for active learning: predicted as target class OR reclassified to target class
                valid_candidates = []
                
                # Get IDs of cells that have been reclassified to this target class
                reclassified_cell_ids = set(int(cell["cell_id"]) for cell in reclassified_for_this_class)
                
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
                    
                    # Include cells if: 1) predicted as target class, OR 2) reclassified to target class
                    # BUT exclude cells that have been reclassified FROM this class
                    is_predicted = predicted_class == target_class_idx
                    is_reclassified_to = idx in reclassified_cell_ids
                    is_reclassified_from = idx_str in reclassified_from_this_class
                    
                    should_include = (is_predicted or is_reclassified_to) and not is_reclassified_from
                    
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
                                logger.debug(f"[AL] Filtered out cell {idx} with max_prob {max_prob:.3f} < threshold {effective_threshold} (right side)")
                        else:
                            # Left side: prob < threshold (low confidence, default behavior)
                            if max_prob < effective_threshold:
                                valid_candidates.append((idx, max_prob, uncertainty))
                            else:
                                logger.debug(f"[AL] Filtered out cell {idx} with max_prob {max_prob:.3f} >= threshold {effective_threshold} (left side)")
                
                # Sort by uncertainty (lowest uncertainty first = most uncertain cells)
                # uncertainty = |max_prob - 0.5|, where 0 = most uncertain, 0.5 = most certain
                # "asc" = Low to High uncertainty (most uncertain first), "desc" = High to Low uncertainty  
                reverse_sort = (sort_order == "desc")
                valid_candidates.sort(key=lambda x: x[2], reverse=reverse_sort)  # Sort by uncertainty (lower = more uncertain)
                
                # Apply cell ID filtering if specified (for ROI support)
                if params.get("cell_ids"):
                    try:
                        # Parse comma-separated cell IDs
                        allowed_cell_ids = set(int(cid.strip()) for cid in params.get("cell_ids").split(",") if cid.strip())
                        
                        id_filtered_candidates = []
                        for idx, max_prob, uncertainty in valid_candidates:
                            if idx in allowed_cell_ids:
                                id_filtered_candidates.append((idx, max_prob, uncertainty))
                        valid_candidates = id_filtered_candidates
                        
                    except (ValueError, AttributeError) as e:
                        logger.error(f"[AL] Error parsing cell_ids parameter: {e}")
                else:
                    pass
                
                # Note: target_class_histogram is already generated above (before threshold filtering)
                # This ensures the histogram always shows the full distribution
            else:
                # No normal candidates - initialize empty data structures
                # (We'll only show reclassified cells)
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
            
            # MULTI-USER: Save to instance-specific cache for next request
            request_cache["key"] = cache_key
            request_cache["valid_candidates"] = valid_candidates
            request_cache["histogram"] = target_class_histogram
            request_cache["centroids"] = centroids
            request_cache["candidate_data"] = candidate_data
            request_cache["candidates_list"] = candidates_list
            logger.info(f"[AL Cache] Saved cache for instance {instance_id}")
        else:
            # Use cached data
            candidate_data = request_cache["candidate_data"]
            candidates_list = request_cache["candidates_list"]
        
        # First, prepare reclassified items (these will always appear first)
        reclassified_items = []
        existing_cell_ids = set()
        
        for reclassified_cell in reclassified_for_this_class:
            try:
                # Ensure consistent string type for cell_id
                cell_id_str = str(reclassified_cell["cell_id"])
                cell_id = int(cell_id_str)
                
                # Skip if already processed (avoid duplicates)
                if cell_id_str in existing_cell_ids:
                    logger.warning(f"[AL] Skipping duplicate reclassified cell {cell_id_str}")
                    continue
                existing_cell_ids.add(cell_id_str)
                
                # Get cell data from Zarr file for the reclassified cell
                if cell_id in range(len(centroids)):
                    centroid = centroids[cell_id]
                    
                    # Generate image for reclassified cell
                    try:
                        tile_data = get_cell_review_tile_data({
                            "slide_id": params["slide_id"],
                            "cell_id": cell_id,
                            "centroid": {
                                "x": float(centroid[0]),
                                "y": float(centroid[1])
                            },
                            "window_size_px": 128,
                            "target_fov_um": 20.0,  # Standard FOV for cell review
                            "padding_ratio": 0.1,
                            "return_contour": True
                        })
                        
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
                            logger.warning(f"[AL] Failed to get image for reclassified cell {cell_id}: {tile_data.get('error', 'unknown')}")
                            image_b64 = _generate_error_placeholder_image(f"Cell {cell_id}\nImage Error")
                            bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                            bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                            contour_from_api = []
                            is_zstack_recl = False
                            num_z_layers_recl = None
                            image_format_recl = "jpeg"
                            
                    except Exception as img_error:
                        logger.warning(f"[AL] Failed to generate image for reclassified cell {cell_id}: {img_error}")
                        image_b64 = _generate_error_placeholder_image(f"Reclassified\nCell {cell_id}")
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
                            logger.warning(f"[AL] Error processing contour for reclassified cell {cell_id}: {contour_error}")
                    
                    # Use API contour if available, otherwise Zarr contour
                    final_contour = contour_from_api if contour_from_api else contour_from_zarr
                    
                    # Create candidate item for reclassified cell
                    reclassified_item = {
                        "cell_id": cell_id_str,
                        "prob": reclassified_cell["prob"],
                        "centroid": {"x": float(centroid[0]), "y": float(centroid[1])},
                        "label": None,  # No label yet for the new class
                        "reclassified": True,
                        "original_class": reclassified_cell["original_class"],
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
                    reclassified_items.append(reclassified_item)
                    
            except Exception as e:
                logger.warning(f"[AL] Error processing reclassified cell {reclassified_cell['cell_id']}: {e}")
                continue
        
        # MULTI-USER: Check if we can use cached filtered data
        # Reclassified cells might change between requests, so check
        recl_cells_changed = (request_cache.get("reclassified_hash") != 
                              (len(reclassified_from_this_class), len(reclassified_to_this_class), len(reclassified_items)))
        
        if use_cache and not recl_cells_changed and request_cache.get("filtered_candidates"):
            # Use cached filtered and unified data
            filtered_candidates = request_cache["filtered_candidates"]
            all_items_data = request_cache["all_items_data"]
            total_candidates = request_cache["total_candidates"]
            logger.info(f"[AL Cache] Using cached filtered data for instance {instance_id}")
        else:
            # Filter out reclassified cells from candidates_list
            filtered_candidates = []
            excluded_count = 0
            for cell_idx_str, cell_data in candidates_list:
                if (cell_idx_str not in reclassified_from_this_class and 
                    cell_idx_str not in reclassified_to_this_class):
                    filtered_candidates.append((cell_idx_str, cell_data))
                else:
                    excluded_count += 1
            
            # Log deduplication statistics
            if excluded_count > 0:
                logger.debug(f"[AL Dedup] Class '{class_name}': excluded {excluded_count} duplicate cells "
                           f"(from_class: {len(reclassified_from_this_class)}, to_class: {len(reclassified_to_this_class)})")
            
            # Create unified list: reclassified items FIRST, then regular candidates
            total_candidates = len(filtered_candidates) + (0 if exclude_reclassified else len(reclassified_items))
            all_items_data = []
            
            # Add reclassified items first (always at the beginning, regardless of sort order)
            if not exclude_reclassified:
                for item in reclassified_items:
                    all_items_data.append(('reclassified', item))
            
            # Add regular candidates (these will be sorted by probability)
            for cell_idx_str, cell_data in filtered_candidates:
                all_items_data.append(('regular', (cell_idx_str, cell_data)))
            
            # MULTI-USER: Cache filtered and unified data for this instance
            if use_cache:
                request_cache["filtered_candidates"] = filtered_candidates
                request_cache["all_items_data"] = all_items_data
                request_cache["total_candidates"] = total_candidates
                request_cache["reclassified_hash"] = (len(reclassified_from_this_class), len(reclassified_to_this_class), len(reclassified_items))
        
        # Apply pagination to the unified list
        start_idx = offset
        end_idx = min(offset + limit, len(all_items_data))
        page_items_data = all_items_data[start_idx:end_idx]
        
        # Use the target class histogram we generated above
        hist = target_class_histogram if 'target_class_histogram' in locals() else [0] * 20
        
        # Generate final items list
        items = []
        for item_type, item_data in page_items_data:
            if item_type == 'reclassified':
                # Already processed reclassified item
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
                        image_b64 = _generate_error_placeholder_image(f"Cell {cell_idx}\nImage Error")
                        bounds = {"x": 0, "y": 0, "w": 128, "h": 128}
                        bbox = {"x": 54, "y": 54, "w": 20, "h": 20}
                        contour = []
                        is_zstack = False
                        num_z_layers = None
                        image_format = "jpeg"
                        
                except Exception as img_error:
                    logger.error(f"[AL] Error generating image for cell {cell_idx}: {img_error}")
                    # Generate a placeholder image with error message
                    image_b64 = _generate_error_placeholder_image(f"Cell {cell_idx}\nGeneration Error")
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
                    "reclassified": False,
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
        logger.error(f"Error in get_candidates_data: {str(e)}")
        return {"success": False, "error": f"Error fetching candidates: {str(e)}"}


def get_shuffle_low_prob_candidates(params: Dict) -> Dict:
    """
    Randomly sample cells (across classes) whose probability is below the given threshold.
    Ensures each class contributes at most one cell before filling the remaining slots.
    """
    try:
        instance_id = _get_instance_id(params)
        slide_path = resolve_path(params["slide_id"])
        zarr_path = slide_path + '.zarr' if not slide_path.endswith('.zarr') else slide_path
        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}

        threshold = params.get("threshold", 0.5)
        try:
            limit = int(params.get("limit", 80))
        except (TypeError, ValueError):
            limit = 80
        limit = max(1, min(limit, 1000))

        allowed_class_names = params.get("class_names")
        if allowed_class_names:
            allowed_class_names = set(allowed_class_names)
            if "*" in allowed_class_names:
                allowed_class_names = None

        exclude_flag = params.get("exclude", True)
        excluded_cell_ids = set()

        def _load_json_blob(value):
            try:
                if isinstance(value, (bytes, bytearray)):
                    value = value.decode("utf-8")
                if isinstance(value, str):
                    return json.loads(value)
            except Exception as json_err:
                logger.warning(f"[AL Random] Failed to parse user annotation blob: {json_err}")
            return {}

        with zarr.open(zarr_path, 'r') as zf:
            classification_group = zf.get(ZarrGroups.CLASSIFICATION_NODE)
            if classification_group is None:
                return {"success": False, "error": "ClassificationNode not found - please run classification first"}

            if ZarrDatasets.NUCLEI_CLASS_ID not in classification_group or ZarrDatasets.NUCLEI_CLASS_NAME not in classification_group:
                return {"success": False, "error": "Classification data incomplete - missing class IDs or names"}

            classifications = classification_group[ZarrDatasets.NUCLEI_CLASS_ID][:]
            class_names_raw = classification_group[ZarrDatasets.NUCLEI_CLASS_NAME][:]
            class_names = [name.decode() if isinstance(name, (bytes, bytearray)) else name for name in class_names_raw]

            probabilities = None
            if ZarrDatasets.NUCLEI_CLASS_PROBABILITIES in classification_group:
                probabilities = classification_group[ZarrDatasets.NUCLEI_CLASS_PROBABILITIES][:]
            else:
                seg_group = find_segmentation_group(zf)
                if seg_group is not None and ZarrDatasets.PROBABILITY in seg_group:
                    probabilities = seg_group[ZarrDatasets.PROBABILITY][:]

            if probabilities is None:
                return {"success": False, "error": "No probability data found - please run segmentation or classification"}

            if exclude_flag:
                user_group = zf.get(ZarrGroups.USER_ANNOTATION)
                if user_group is not None:
                    if ZarrDatasets.NUCLEI_ANNOTATIONS in user_group:
                        annotations_raw = user_group[ZarrDatasets.NUCLEI_ANNOTATIONS][()]
                        annotations = _load_json_blob(annotations_raw) or {}
                        if isinstance(annotations, dict):
                            excluded_cell_ids.update(str(cell_id) for cell_id in annotations.keys())
                    if ZarrDatasets.RECLASSIFICATION_METADATA in user_group:
                        reclass_raw = user_group[ZarrDatasets.RECLASSIFICATION_METADATA][()]
                        reclass_data = _load_json_blob(reclass_raw) or {}
                        if isinstance(reclass_data, dict):
                            excluded_cell_ids.update(str(cell_id) for cell_id in reclass_data.keys())

        probabilities = np.asarray(probabilities)
        classifications = np.asarray(classifications)

        if probabilities.ndim == 2:
            max_probs = np.max(probabilities, axis=1)
        elif probabilities.ndim == 1:
            max_probs = probabilities
        else:
            return {"success": False, "error": f"Invalid probabilities shape: {probabilities.shape}"}

        if exclude_flag:
            all_reclassified = {}
            instance_reclassified = _get_reclassified_cells(instance_id, zarr_path)
            instance_temporary = _get_temporary_cells(instance_id, zarr_path)
            all_reclassified.update(instance_reclassified)
            all_reclassified.update(instance_temporary)

            for cell_id in all_reclassified.keys():
                excluded_cell_ids.add(str(cell_id))

        candidates_by_class: Dict[int, List[Dict]] = {}
        available_by_class: Dict[str, int] = {}

        for idx in range(len(classifications)):
            predicted_class = int(classifications[idx])
            if predicted_class < 0 or predicted_class >= len(class_names):
                continue

            class_name = class_names[predicted_class]
            if allowed_class_names and class_name not in allowed_class_names:
                continue

            idx_str = str(idx)
            if idx_str in excluded_cell_ids:
                continue

            prob = float(max_probs[idx])
            # All classes use the same threshold logic now (user controls the threshold)
            if prob >= threshold:
                continue

            candidates_by_class.setdefault(predicted_class, []).append({
                "cell_id": idx_str,
                "prob": prob,
                "class_id": predicted_class,
                "class_name": class_name
            })

        for class_id, entries in candidates_by_class.items():
            random.shuffle(entries)
            available_by_class[class_names[class_id]] = len(entries)

        selected: List[Dict] = []
        class_ids = list(candidates_by_class.keys())
        random.shuffle(class_ids)

        # Ensure at least one per class when possible
        for class_id in class_ids:
            entries = candidates_by_class[class_id]
            if entries:
                selected.append(entries.pop())
                if len(selected) >= limit:
                    break

        if len(selected) < limit:
            remaining: List[Dict] = []
            for entries in candidates_by_class.values():
                remaining.extend(entries)
            random.shuffle(remaining)
            needed = limit - len(selected)
            selected.extend(remaining[:needed])

        random.shuffle(selected)

        # Generate and save images for each selected cell
        items_with_images = []
        # Create output directory for images (same directory as slide file)
        slide_dir = os.path.dirname(slide_path)
        output_dir = os.path.join(slide_dir, "tmp")
        os.makedirs(output_dir, exist_ok=True)
        
        # Load centroids for image generation
        centroids = None
        with zarr.open(zarr_path, 'r') as zf:
            seg_group = find_segmentation_group(zf)
            if seg_group is not None and ZarrDatasets.CENTROIDS in seg_group:
                centroids = seg_group[ZarrDatasets.CENTROIDS][:]
        
        for idx, item in enumerate(selected):
            cell_id = item["cell_id"]
            cell_idx = int(cell_id)
            
            # Get centroid for image generation
            centroid_x = None
            centroid_y = None
            if centroids is not None and cell_idx < len(centroids):
                centroid_x = float(centroids[cell_idx, 0])
                centroid_y = float(centroids[cell_idx, 1])
            
            # Generate cell images with contour overlay in two sizes: 256px (detail) and 512px (context)
            image_path = None
            image_path_256 = None
            image_path_512 = None
            
            if centroid_x is not None and centroid_y is not None:
                class_name_safe = item.get('class_name', 'unknown').replace(' ', '_')
                
                # Generate both 256px and 512px images
                for window_size in [256, 512]:
                    try:
                        cell_image_data = get_cell_review_tile_data({
                            "slide_id": params["slide_id"],
                            "cell_id": cell_id,
                            "centroid": {
                                "x": centroid_x,
                                "y": centroid_y
                            },
                            "window_size_px": window_size,
                            "target_fov_um": 20.0,
                            "padding_ratio": 0.1,
                            "return_contour": True,
                            "contour_type": "polygon"
                        })
                        
                        if cell_image_data.get("success", False):
                            crop_data = cell_image_data.get("data", {})
                            image_b64 = crop_data.get("image")
                            
                            if image_b64:
                                # Decode base64 image
                                import base64
                                # Remove data URL prefix if present
                                if ',' in image_b64:
                                    image_b64 = image_b64.split(',')[1]
                                
                                image_bytes = base64.b64decode(image_b64)
                                
                                # Save as JPEG file (format: {id}_{class_name}_{size}.jpeg)
                                image_filename = f"{cell_id}_{class_name_safe}_{window_size}.jpeg"
                                current_image_path = os.path.join(output_dir, image_filename)
                                
                                # Load image from bytes and convert to JPEG
                                from PIL import Image
                                img = Image.open(BytesIO(image_bytes))
                                # Convert to RGB if needed (for PNG with transparency)
                                if img.mode in ('RGBA', 'LA', 'P'):
                                    rgb_img = Image.new('RGB', img.size, (255, 255, 255))
                                    rgb_img.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                                    img = rgb_img
                                
                                # Save as JPEG
                                img.save(current_image_path, "JPEG", quality=95)
                                logger.info(f"[Shuffle] Saved {window_size}px image for cell {cell_id} to {current_image_path}")
                                
                                # Store paths
                                if window_size == 256:
                                    image_path_256 = current_image_path
                                elif window_size == 512:
                                    image_path_512 = current_image_path
                                    image_path = current_image_path  # Main path for backward compatibility
                                
                    except Exception as img_error:
                        logger.error(f"[Shuffle] Error generating/saving {window_size}px image for cell {cell_id}: {img_error}")
                        import traceback
                        logger.error(traceback.format_exc())
            
            # Add image paths to item
            item_with_image = {
                **item,
                "centroid": {
                    "x": centroid_x if centroid_x is not None else 0,
                    "y": centroid_y if centroid_y is not None else 0
                },
                "image_path": image_path,  # Main path (512px) for backward compatibility
                "image_path_256": image_path_256,  # 256px image path (detail)
                "image_path_512": image_path_512   # 512px image path (context)
            }
            items_with_images.append(item_with_image)

        return {
            "success": True,
            "data": {
                "sampled": len(items_with_images),
                "limit": limit,
                "threshold": threshold,
                "per_class_available": available_by_class,
                "output_dir": output_dir,  # Directory where images are saved
                "items": items_with_images
            }
        }

    except Exception as e:
        logger.error(f"Error in get_random_low_prob_candidates: {str(e)}")
        return {"success": False, "error": f"Error fetching random candidates: {str(e)}"}


def label_candidate_cell(params: Dict) -> Dict:
    try:
        # MULTI-USER: Extract instance_id
        instance_id = _get_instance_id(params)
        
        slide_path = resolve_path(params["slide_id"])
        zarr_path = slide_path + '.zarr' if not slide_path.endswith('.zarr') else slide_path
        
        # Prefer Zarr over H5
        if os.path.exists(zarr_path):
            logger.info(f"[AL] Using Zarr file: {zarr_path}")
        else:
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}
        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"File not found: {zarr_path}"}
        
        # Ensure cell_id is always stored as string for consistent comparison
        cell_id = str(params["cell_id"])
        class_name = params.get("class_name")
        label = params["label"]
        prob = params["prob"]
        
        # Determine if the original class is from user annotation (manual or reclassification)
        # Check if this cell exists in user_annotation/nuclei_annotations
        # If it exists, it means it's a user annotation (shown in annotation panel) and count should be decremented
        is_original_manual = False
        try:
            with zarr.open(zarr_path, 'r') as zf:
                if ZarrGroups.USER_ANNOTATION in zf and ZarrDatasets.NUCLEI_ANNOTATIONS in zf[ZarrGroups.USER_ANNOTATION]:
                    raw_bytes = zf[ZarrPaths.USER_ANNOTATION_NUCLEI_ANNOTATIONS][()]
                    manual_annotations = json.loads(raw_bytes.decode("utf-8"))
                    # If cell exists in user annotations, it should be counted (regardless of method)
                    is_original_manual = (cell_id in manual_annotations)
        except Exception as e:
            logger.warning(f"[AL] Could not check if cell {cell_id} is in user annotations: {e}")
        
        # ⚠️ CRITICAL FIX: Invalidate instance-specific cache when labeling
        # This ensures that after user labels cells, the next AL request shows updated data
        request_cache = _get_request_cache(instance_id)
        if request_cache["key"] and request_cache["key"][0] == zarr_path:
            request_cache.update({
                "key": None,
                "valid_candidates": [],
                "histogram": [],
                "centroids": None,
                "candidate_data": {},
                "candidates_list": [],
                "filtered_candidates": []
            })
            logger.info(f"[AL] Invalidated cache for instance {instance_id} after labeling cell {cell_id} in class '{class_name}' (label={label})")
        
        return {"success": True, "is_original_manual": is_original_manual}
        
    except Exception as e:
        logger.error(f"Error in label_candidate_cell: {str(e)}")
        return {"success": False, "error": f"Error labeling candidate: {str(e)}"}


def reclassify_candidate_cell(handler: "SegmentationHandler", params: Dict) -> Dict:
    try:
        # MULTI-USER: Extract instance_id FIRST
        instance_id = _get_instance_id(params)
        logger.info(f"[AL Reclassify] Processing for instance_id: {instance_id}")
        
        slide_path = resolve_path(params["slide_id"])
        zarr_path = slide_path + '.zarr' if not slide_path.endswith('.zarr') else slide_path
        
        # MULTI-USER: Invalidate instance-specific cache when reclassifying
        request_cache = _get_request_cache(instance_id)
        if request_cache["key"] and request_cache["key"][0] == zarr_path:
            request_cache.update({
                "key": None,
                "valid_candidates": [],
                "histogram": [],
                "centroids": None,
                "candidate_data": {},
                "candidates_list": [],
                "filtered_candidates": []
            })
            logger.info(f"[AL Cache] Invalidated cache for instance {instance_id}")
        
        if os.path.exists(zarr_path):
            logger.info(f"[AL] Using Zarr file: {zarr_path}")
        else:
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}
        
        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"File not found: {zarr_path}"}
        
        # Ensure cell_id is always stored as string for consistent comparison
        cell_id = str(params["cell_id"])
        original_class = params["original_class"]
        new_class = params["new_class"]
        prob = params["prob"]
        
        # Get centroid and color from frontend if provided (avoids reading zarr)
        frontend_centroid_x = params.get("centroid_x")
        frontend_centroid_y = params.get("centroid_y")
        frontend_cell_color = params.get("cell_color")
        
        # Define temporary/special classes that should NOT be saved to Zarr
        TEMPORARY_CLASSES = {"Other", "Not Sure", "Incorrect Segmentation"}
        
        # Determine if the original class is from user annotation (manual or reclassification)
        # Check if this cell exists in user_annotation/nuclei_annotations
        # If it exists, it means it's a user annotation (shown in annotation panel) and count should be decremented
        is_original_manual = False
        try:
            with zarr.open(zarr_path, 'r') as zf:
                if ZarrGroups.USER_ANNOTATION in zf and ZarrDatasets.NUCLEI_ANNOTATIONS in zf[ZarrGroups.USER_ANNOTATION]:
                    raw_bytes = zf[ZarrPaths.USER_ANNOTATION_NUCLEI_ANNOTATIONS][()]
                    manual_annotations = json.loads(raw_bytes.decode("utf-8"))
                    # If cell exists in user annotations, it should be counted (regardless of method)
                    is_original_manual = (cell_id in manual_annotations)
        except Exception as e:
            logger.warning(f"[AL] Could not check if cell {cell_id} is in user annotations: {e}")
        
        # Handle reclassification with proper cleanup
        zarr_path = slide_path + '.zarr' if not slide_path.endswith('.zarr') else slide_path
        
        if os.path.exists(zarr_path):
            logger.info(f"[AL] Using Zarr file: {zarr_path}")
        else:
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}
        
        # MULTI-USER: Get instance-specific storage
        reclassified_cells = _get_reclassified_cells(instance_id, zarr_path)
        temporary_cells = _get_temporary_cells(instance_id, zarr_path)
        
        # Check if this cell was already reclassified
        existing_record = reclassified_cells.get(cell_id)
        
        if existing_record:
            # Cell was already reclassified before
            original_original_class = existing_record.get("original_original_class", existing_record["original_class"])
            
            # Fallback: If original_original_class is None (from old buggy data), 
            # use the frontend's original_class (current displayed class)
            if not original_original_class:
                original_original_class = original_class
                logger.info(f"[AL] Cell {cell_id}: original_original_class was None, using frontend original_class '{original_class}'")
            
            # Check if moving back to the true original class
            if new_class == original_original_class:
                # Moving back to original class - completely remove from reclassified records
                if cell_id in reclassified_cells:
                    del reclassified_cells[cell_id]
                    logger.info(f"[AL] Cell {cell_id} moved back to original class '{new_class}' for instance {instance_id}")
                
                # Update Zarr file when returning to original class
                try:
                    update_result = save_reclassifications_via_existing_api({
                        "slide_id": params["slide_id"],
                        "instance_id": instance_id  # MULTI-USER: Pass instance_id to save
                    })
                    if update_result.get("success", False):
                        pass
                    else:
                        logger.warning(f"[AL] Failed to update Zarr file: {update_result.get('error', 'unknown')}")
                except Exception as e:
                    logger.error(f"[AL] Error updating Zarr file: {e}")
                    
            else:
                # Moving to a different new class
                if new_class in TEMPORARY_CLASSES:
                    # Remove from persistent storage, add to temporary storage
                    if cell_id in reclassified_cells:
                        del reclassified_cells[cell_id]
                    
                    temporary_cells[cell_id] = {
                        "original_class": original_original_class,  # Keep the TRUE original class
                        "new_class": new_class,
                        "prob": prob,
                        "original_original_class": original_original_class,
                        "timestamp": datetime.now().isoformat(),
                        "is_original_manual": existing_record.get("is_original_manual", is_original_manual)
                    }
                    logger.info(f"[AL] Cell {cell_id} moved to temporary class '{new_class}' for instance {instance_id} (session-only)")
                    # Don't save to Zarr or invalidate cache
                    return {"success": True, "is_temporary": True}
                else:
                    # Moving to a persistent class - update record but keep original_original_class
                    reclassified_cells[cell_id] = {
                        "original_class": original_class,  # ← 修复：用当前来源class（前端传来的）
                        "new_class": new_class,            # The class it's moving TO now
                        "prob": prob,
                        "original_original_class": original_original_class,  # The true original class (from initial model prediction)
                        "timestamp": datetime.now().isoformat(),
                        "is_original_manual": existing_record.get("is_original_manual", is_original_manual),
                        "centroid_x": frontend_centroid_x,
                        "centroid_y": frontend_centroid_y,
                        "cell_color": frontend_cell_color
                    }
                    logger.info(f"[AL] Cell {cell_id} re-reclassified from '{original_class}' to '{new_class}' (true original: '{original_original_class}') for instance {instance_id}")
        else:
            # First time reclassification
            if original_class == new_class:
                # Should not happen, but handle gracefully
                logger.warning(f"[AL] Attempting to reclassify cell {cell_id} to same class '{original_class}'")
                return {"success": True, "is_original_manual": is_original_manual}  # No-op
            
            # Store in temporary or persistent storage based on class type
            if new_class in TEMPORARY_CLASSES:
                # Store in instance-specific temporary storage
                temporary_cells[cell_id] = {
                    "original_class": original_class,
                    "new_class": new_class,
                    "prob": prob,
                    "original_original_class": original_class,
                    "timestamp": datetime.now().isoformat(),
                    "is_original_manual": is_original_manual
                }
                logger.info(f"[AL] Cell {cell_id} moved to temporary class '{new_class}' for instance {instance_id} (session-only)")
                # Don't save to Zarr or invalidate cache
                return {"success": True, "is_temporary": True}
            else:
                # Store in instance-specific persistent storage
                reclassified_cells[cell_id] = {
                    "original_class": original_class,
                    "new_class": new_class,
                    "prob": prob,
                    "original_original_class": original_class,
                    "timestamp": datetime.now().isoformat(),
                    "is_original_manual": is_original_manual,
                    "centroid_x": frontend_centroid_x,
                    "centroid_y": frontend_centroid_y,
                    "cell_color": frontend_cell_color
                }
                logger.info(f"[AL] First reclassification of cell {cell_id} to '{new_class}' for instance {instance_id}")

        # Only save and invalidate cache for non-temporary classes
        if new_class not in TEMPORARY_CLASSES:
            # Try to save reclassifications to Zarr file but don't fail the operation if it doesn't work
            # The reclassifications are still stored in memory and will work for the current session
            try:
                # handler is already passed as first parameter to reclassify_candidate_cell
                save_result = save_reclassifications_via_existing_api(handler, {
                    "slide_id": params["slide_id"],
                    "instance_id": instance_id  # MULTI-USER: Pass instance_id to save
                })
                if not save_result.get("success", False):
                    error_msg = save_result.get('error', 'unknown error')
                    logger.error(f"[AL] FAILED to save reclassifications to Zarr: {error_msg}")
                    logger.error(f"[AL] This means data will be LOST after backend restart!")
            except Exception as e:
                logger.error(f"[AL] Exception saving reclassifications to Zarr: {e}")
                logger.error(f"[AL] Traceback: {traceback.format_exc()}")

            # Invalidate global counts cache to ensure fresh data is returned
            try:
                handler.load_file(zarr_path, force_reload=False)
                print(f"[AL] Reloaded Zarr file: {zarr_path} for active learning")
            except Exception as e:
                print(f"[AL] Failed to reload Zarr file: {e} for active learning")

        return {"success": True, "is_original_manual": is_original_manual}
        
    except Exception as e:
        logger.error(f"Error in reclassify_candidate_cell: {str(e)}")
        return {"success": False, "error": f"Error reclassifying candidate: {str(e)}"}


def get_manual_counts_with_reclassifications(handler, base_data: Dict, instance_id: str) -> Dict:
    """
    Get manual annotation counts including reclassifications.
    Reclassifications are considered manual annotations.
    
    Args:
        handler: SegmentationHandler instance
        base_data: Base manual annotation counts from get_all_nuclei_counts
        instance_id: Required instance identifier for multi-user isolation

    Returns:
        Dict with updated counts including reclassifications
    """
    try:
        zarr_path = handler.get_current_file_path()

        # Start with base manual annotation counts
        class_counts = base_data.get('class_counts_by_id', {})
        class_names = base_data.get('dynamic_class_names', [])

        # MULTI-USER: Get instance-specific reclassified cells
        reclassified_data = _get_reclassified_cells(instance_id, zarr_path)
        
        if reclassified_data:
            # Create name to ID mapping
            name_to_id = {name: str(idx) for idx, name in enumerate(class_names)}

            # Count reclassifications per class
            reclassify_counts = {}
            for cell_id_str, reclassify_info in reclassified_data.items():
                new_class = reclassify_info.get("new_class")
                if new_class in name_to_id:
                    class_id = name_to_id[new_class]
                    reclassify_counts[class_id] = reclassify_counts.get(class_id, 0) + 1

            # Add reclassification counts to manual counts
            for class_id, count in reclassify_counts.items():
                class_counts[class_id] = class_counts.get(class_id, 0) + count

        return {
            'class_counts_by_id': class_counts,
            'dynamic_class_names': class_names
        }
    except Exception as e:
        logger.error(f"Error in get_manual_counts_with_reclassifications: {e}")
        return base_data


def clear_tmp_overlay_images(slide_id: str) -> Dict:
    """
    Clear all overlay images in the tmp directory for a slide.
    Deletes the entire tmp folder and all its contents.
    
    Args:
        slide_id: Slide ID or file path
        
    Returns:
        Dict with success status and count of deleted files
    """
    try:
        slide_path = resolve_path(slide_id)
        slide_dir = os.path.dirname(slide_path)
        tmp_dir = os.path.join(slide_dir, "tmp")
        
        if not os.path.exists(tmp_dir):
            return {
                "success": True,
                "count": 0,
                "message": "tmp directory does not exist"
            }
        
        # Count files before deletion
        file_count = 0
        for root, dirs, files in os.walk(tmp_dir):
            file_count += len(files)
        
        # Delete the entire tmp directory
        import shutil
        shutil.rmtree(tmp_dir)
        
        logger.info(f"[Shuffle] Deleted tmp directory with {file_count} files: {tmp_dir}")
        
        return {
            "success": True,
            "count": file_count,
            "message": f"Deleted {file_count} files from tmp directory"
        }
        
    except Exception as e:
        logger.error(f"Error in clear_tmp_overlay_images: {str(e)}")
        return {"success": False, "error": str(e)}


def clear_temporary_cells(slide_id: str, instance_id: str) -> Dict:
    """
    Clear all temporary class cells (Other, Not Sure, Incorrect Segmentation) from memory.
    Called when review panel is closed.
    
    Args:
        slide_id: Slide ID or file path
        instance_id: Required instance identifier for multi-user isolation
        
    Returns:
        Dict with success status and count of cleared cells
    """
    try:
        slide_path = resolve_path(slide_id)
        zarr_path = slide_path + '.zarr' if not slide_path.endswith('.zarr') else slide_path
        
        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}
        
        # MULTI-USER: Clear instance-specific temporary cells
        temporary_cells = _get_temporary_cells(instance_id, zarr_path)
        cleared_count = len(temporary_cells)
        temporary_cells.clear()
        logger.info(f"[AL] Cleared {cleared_count} temporary class cells for instance {instance_id}, slide {zarr_path}")
        
        return {
            "success": True,
            "count": cleared_count,
            "message": f"Cleared {cleared_count} temporary class cells"
        }
        
    except Exception as e:
        logger.error(f"Error in clear_temporary_cells: {str(e)}")
        return {"success": False, "error": str(e)}


def clear_all_reclassifications(slide_id: str, instance_id: str) -> Dict:
    """
    Clear all reclassifications (both persistent and temporary) from memory for a slide.
    Called during reset operation to ensure clean state.
    
    Args:
        slide_id: Slide ID or file path
        instance_id: Required instance identifier for multi-user isolation
        
    Returns:
        Dict with success status and counts of cleared cells
    """
    try:
        slide_path = resolve_path(slide_id)
        zarr_path = slide_path + '.zarr' if not slide_path.endswith('.zarr') else slide_path
        
        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}
        
        # MULTI-USER: Clear instance-specific cells
        reclassified_cells = _get_reclassified_cells(instance_id, zarr_path)
        temporary_cells = _get_temporary_cells(instance_id, zarr_path)
        
        persistent_count = len(reclassified_cells)
        temporary_count = len(temporary_cells)
        
        # Clear both storage types
        reclassified_cells.clear()
        temporary_cells.clear()
        
        # Invalidate the request cache to prevent stale data
        request_cache = _get_request_cache(instance_id)
        if request_cache["key"] and request_cache["key"][0] == zarr_path:
            request_cache.update({
                "key": None,
                "valid_candidates": [],
                "histogram": [],
                "centroids": None,
                "candidate_data": {},
                "candidates_list": [],
                "filtered_candidates": []
            })
            logger.info(f"[AL Reset] Invalidated request cache for instance {instance_id}, slide {zarr_path}")
        
        logger.info(f"[AL Reset] Cleared {persistent_count} persistent + {temporary_count} temporary cells for instance {instance_id}, slide {zarr_path}")
        
        total_count = persistent_count + temporary_count
        return {
            "success": True,
            "persistent_count": persistent_count,
            "temporary_count": temporary_count,
            "total_count": total_count,
            "message": f"Cleared {total_count} reclassified cells ({persistent_count} persistent + {temporary_count} temporary)"
        }
        
    except Exception as e:
        logger.error(f"[AL Reset] Error clearing reclassifications: {str(e)}")
        return {"success": False, "error": str(e)}


def save_reclassifications_via_existing_api(handler: SegmentationHandler, params: Dict) -> Dict:
    """
    Save reclassifications using the same structured array format as save_annotation.
    This ensures consistency with the segmentation save annotation API.
    
    Args:
        handler: SegmentationHandler instance for the current file
        params: Dict containing slide_id and instance_id
        
    Returns:
        Dict with success status, file_path, count, etc.
    """
    try:
        # MULTI-USER: Extract instance_id
        instance_id = _get_instance_id(params)
        
        slide_path = resolve_path(params["slide_id"])
        zarr_path = slide_path + '.zarr' if not slide_path.endswith('.zarr') else slide_path
        
        if not os.path.exists(zarr_path):
            return {"success": False, "error": f"Zarr file not found: {zarr_path}"}

        logger.info(f"[AL Save] Starting save_reclassifications for instance {instance_id}: {zarr_path}")

        # MULTI-USER: Get instance-specific reclassifications
        reclassified_data = _get_reclassified_cells(instance_id, zarr_path)

        # If no reclassifications to save, return success
        if not reclassified_data:
            logger.info(f"[AL Save] No reclassifications to save for {zarr_path}")
            return {
                "success": True,
                "file_path": zarr_path,
                "count": 0,
                "new_count": 0,
                "message": "No reclassifications to save"
            }

        logger.info(f"[AL Save] Saving {len(reclassified_data)} reclassifications")

        # Get class names and colors from handler or zarr file
        ui_nuclei_classes = None
        ui_nuclei_colors = None
        
        if handler and hasattr(handler, 'class_name') and handler.class_name is not None:
            class_name_data = handler.class_name
            # Handle both list and numpy array
            if isinstance(class_name_data, (list, np.ndarray)) and len(class_name_data) > 0:
                ui_nuclei_classes = list(class_name_data)
            elif class_name_data:  # For non-array types
                ui_nuclei_classes = list(class_name_data)
            
            if hasattr(handler, 'class_hex_color') and handler.class_hex_color is not None:
                class_color_data = handler.class_hex_color
                # Handle both list and numpy array
                if isinstance(class_color_data, (list, np.ndarray)) and len(class_color_data) > 0:
                    ui_nuclei_colors = list(class_color_data)
                elif class_color_data:  # For non-array types
                    ui_nuclei_colors = list(class_color_data)
        
        # If handler doesn't have class info, try to load from zarr
        if ui_nuclei_classes is None or len(ui_nuclei_classes) == 0 or ui_nuclei_colors is None or len(ui_nuclei_colors) == 0:
            try:
                from app.services.data import get_zarr_synchronizer
                synchronizer = get_zarr_synchronizer(zarr_path)
                with zarr.open(zarr_path, 'r', synchronizer=synchronizer) as zf:
                    # Try to get from user_annotation metadata first (most up-to-date)
                    if ZarrGroups.USER_ANNOTATION in zf:
                        user_anno_group = zf[ZarrGroups.USER_ANNOTATION]
                        if 'class_names' in user_anno_group.attrs and 'class_colors' in user_anno_group.attrs:
                            ui_nuclei_classes = list(user_anno_group.attrs['class_names'])
                            ui_nuclei_colors = list(user_anno_group.attrs['class_colors'])
                    
                    # Fallback to ClassificationNode
                    if ((ui_nuclei_classes is None or len(ui_nuclei_classes) == 0 or 
                         ui_nuclei_colors is None or len(ui_nuclei_colors) == 0) and 
                        ZarrGroups.CLASSIFICATION_NODE in zf):
                        classification_node = zf[ZarrGroups.CLASSIFICATION_NODE]
                        if ZarrDatasets.USER_DATA in classification_node:
                            user_data_group = classification_node[ZarrDatasets.USER_DATA]
                            if ZarrDatasets.NUCLEI_CLASSES in user_data_group and ZarrDatasets.NUCLEI_COLORS in user_data_group:
                                classes_raw = user_data_group[ZarrDatasets.NUCLEI_CLASSES][()]
                                colors_raw = user_data_group[ZarrDatasets.NUCLEI_COLORS][()]
                                ui_nuclei_classes = json.loads(classes_raw.decode('utf-8') if isinstance(classes_raw, bytes) else classes_raw)
                                ui_nuclei_colors = json.loads(colors_raw.decode('utf-8') if isinstance(colors_raw, bytes) else colors_raw)
            except Exception as e:
                logger.warning(f"[AL Save] Failed to load class names/colors from zarr: {e}")
        
        # Get centroids length - use handler's cached data if available
        if handler and handler.centroids is not None:
            centroids_len = len(handler.centroids)
            logger.info(f"[AL Save] Using cached centroids length: {centroids_len}")
        else:
            # Fallback: read from Zarr
            try:
                from app.services.data import get_zarr_synchronizer
                synchronizer = get_zarr_synchronizer(zarr_path)
                with zarr.open(zarr_path, 'r', synchronizer=synchronizer) as zf:
                    seg_group = find_segmentation_group(zf)
                    if seg_group and ZarrDatasets.CENTROIDS in seg_group:
                        centroids_dataset = seg_group[ZarrDatasets.CENTROIDS]
                        if centroids_dataset.shape == ():
                            # Scalar dataset - not a valid centroids array
                            logger.error(f"[AL Save] Centroids dataset is scalar, not an array")
                            return {"success": False, "error": "Centroids dataset is scalar, not an array"}
                        else:
                            centroids = centroids_dataset[:]
                            # Ensure centroids is a numpy array
                            if isinstance(centroids, np.ndarray):
                                centroids_len = len(centroids)
                            else:
                                logger.error(f"[AL Save] Centroids is not a numpy array: {type(centroids)}")
                                return {"success": False, "error": f"Centroids is not a numpy array: {type(centroids)}"}
                    else:
                        logger.error(f"[AL Save] No centroids found in Zarr file")
                        return {"success": False, "error": "No centroids found in Zarr file"}
            except Exception as e:
                logger.error(f"[AL Save] Failed to load centroids: {e}")
                return {"success": False, "error": f"Failed to load centroids: {str(e)}"}

        # Filter out temporary classes and prepare data for batch update
        TEMPORARY_CLASSES = {"Other", "Not Sure", "Incorrect Segmentation"}
        matching_indices = []
        classifications = []
        colors = []
        region_geometries = []
        
        for cell_id_str, cell_data in reclassified_data.items():
            new_class = cell_data.get("new_class")
            
            # Skip temporary classes
            if new_class in TEMPORARY_CLASSES:
                continue
            
            try:
                cell_idx = int(cell_id_str)
                if cell_idx < 0 or cell_idx >= centroids_len:
                    logger.warning(f"[AL Save] Invalid cell index {cell_idx}, skipping")
                    continue
                
                matching_indices.append(cell_idx)
                classifications.append(new_class)
                
                # Get color - prioritize frontend, then class color map, then default
                frontend_color = cell_data.get("cell_color")
                if frontend_color:
                    colors.append(frontend_color)
                elif (ui_nuclei_colors is not None and len(ui_nuclei_colors) > 0 and 
                      ui_nuclei_classes is not None and len(ui_nuclei_classes) > 0 and 
                      new_class in ui_nuclei_classes):
                    class_idx = ui_nuclei_classes.index(new_class)
                    if class_idx < len(ui_nuclei_colors):
                        colors.append(ui_nuclei_colors[class_idx])
                    else:
                        colors.append("#aaaaaa")  # Default color (same as Negative control)
                else:
                    colors.append("#aaaaaa")  # Default color (same as Negative control)
                
                # Get centroid for region_geometry
                frontend_cx = cell_data.get("centroid_x")
                frontend_cy = cell_data.get("centroid_y")
                
                if frontend_cx is not None and frontend_cy is not None:
                    # Use frontend data (already in level 0 coordinates)
                    region_geometries.append({
                        "x1": int(frontend_cx),
                        "y1": int(frontend_cy),
                        "x2": int(frontend_cx),
                        "y2": int(frontend_cy)
                    })
                elif handler and handler.centroids is not None and cell_idx < len(handler.centroids):
                    # Handler centroids are already in level 0 (real pixel) coordinates
                    cx = int(handler.centroids[cell_idx][0])
                    cy = int(handler.centroids[cell_idx][1])
                    region_geometries.append({
                        "x1": cx,
                        "y1": cy,
                        "x2": cx,
                        "y2": cy
                    })
                else:
                    # Fallback: read from zarr
                    try:
                        from app.services.data import get_zarr_synchronizer
                        synchronizer = get_zarr_synchronizer(zarr_path)
                        with zarr.open(zarr_path, 'r', synchronizer=synchronizer) as zf:
                            seg_group = find_segmentation_group(zf)
                            if seg_group and ZarrDatasets.CENTROIDS in seg_group:
                                centroids_dataset = seg_group[ZarrDatasets.CENTROIDS]
                                if centroids_dataset.shape == ():
                                    # Scalar dataset - skip this cell
                                    logger.warning(f"[AL Save] Centroids dataset is scalar for cell {cell_idx}, skipping")
                                    matching_indices.pop()
                                    classifications.pop()
                                    colors.pop()
                                    continue
                                else:
                                    centroids = centroids_dataset[:]
                                    # Ensure centroids is a numpy array and has valid shape
                                    if not isinstance(centroids, np.ndarray):
                                        logger.warning(f"[AL Save] Centroids is not a numpy array for cell {cell_idx}, skipping")
                                        matching_indices.pop()
                                        classifications.pop()
                                        colors.pop()
                                        continue
                                    
                                    centroids_len = len(centroids)
                                    if centroids_len == 0 or cell_idx >= centroids_len:
                                        logger.warning(f"[AL Save] Invalid centroids length for cell {cell_idx}, skipping")
                                        matching_indices.pop()
                                        classifications.pop()
                                        colors.pop()
                                        continue
                                    
                                    centroid_item = centroids[cell_idx]
                                    # Handle both 1D and 2D array cases
                                    try:
                                        if isinstance(centroid_item, np.ndarray):
                                            if centroid_item.size >= 2:
                                                cx = int(centroid_item[0])
                                                cy = int(centroid_item[1])
                                            else:
                                                logger.warning(f"[AL Save] Centroid item size < 2 for cell {cell_idx}, skipping")
                                                matching_indices.pop()
                                                classifications.pop()
                                                colors.pop()
                                                continue
                                        elif hasattr(centroid_item, '__len__'):
                                            centroid_len = len(centroid_item)
                                            if centroid_len >= 2:
                                                cx = int(centroid_item[0])
                                                cy = int(centroid_item[1])
                                            else:
                                                logger.warning(f"[AL Save] Centroid item length < 2 for cell {cell_idx}, skipping")
                                                matching_indices.pop()
                                                classifications.pop()
                                                colors.pop()
                                                continue
                                        else:
                                            logger.warning(f"[AL Save] Centroid item has no length for cell {cell_idx}, skipping")
                                            matching_indices.pop()
                                            classifications.pop()
                                            colors.pop()
                                            continue
                                        
                                        region_geometries.append({
                                            "x1": cx,
                                            "y1": cy,
                                            "x2": cx,
                                            "y2": cy
                                        })
                                    except (IndexError, TypeError, ValueError) as e:
                                        logger.warning(f"[AL Save] Error accessing centroid for cell {cell_idx}: {e}, skipping")
                                        matching_indices.pop()
                                        classifications.pop()
                                        colors.pop()
                                        continue
                            else:
                                # seg_group doesn't exist or CENTROIDS not in seg_group
                                logger.warning(f"[AL Save] Could not get centroid for cell {cell_idx} (no centroids in zarr), skipping")
                                matching_indices.pop()
                                classifications.pop()
                                colors.pop()
                                continue
                    except Exception as e:
                        logger.warning(f"[AL Save] Failed to get centroid for cell {cell_idx}: {e}, skipping")
                        matching_indices.pop()
                        classifications.pop()
                        colors.pop()
                        continue
                
            except (ValueError, TypeError) as e:
                logger.warning(f"[AL Save] Invalid cell_id '{cell_id_str}': {e}, skipping")
                continue
        
        if not matching_indices:
            logger.info(f"[AL Save] No valid reclassifications to save after filtering")
            return {
                "success": True,
                "file_path": zarr_path,
                "count": 0,
                "new_count": 0,
                "message": "No valid reclassifications to save"
            }
        
        # Now save using the same format as save_annotation
        # We'll batch process all reclassifications together
        from app.services.data import get_zarr_synchronizer
        synchronizer = get_zarr_synchronizer(zarr_path)
        
        with zarr.open(zarr_path, "a", synchronizer=synchronizer) as zf:
            ann_group_path = ZarrGroups.USER_ANNOTATION
            if ann_group_path not in zf:
                group_anno = zf.create_group(ann_group_path)
            else:
                group_anno = zf[ann_group_path]
            
            # Use structured array format (same as save_annotation)
            ds_name = ZarrDatasets.NUCLEI_ANNOTATIONS
            annotation_dtype = _get_annotation_dtype()
            
            # Check if dataset exists and is in correct format
            needs_replacement = False
            if ds_name in group_anno:
                if group_anno.attrs.get('annotation_format') != 'structured':
                    logger.warning(f"[AL Save] Dataset exists but format is not 'structured'. Will use structured format.")
                    needs_replacement = True
            
            # Create structured array if it doesn't exist
            if ds_name not in group_anno or needs_replacement:
                from numcodecs import LZ4
                element_size = annotation_dtype.itemsize
                target_chunk_size = 8 * 1024 * 1024  # 8MB target
                optimal_chunk_size = max(1000, min(centroids_len, target_chunk_size // element_size))
                compressor = LZ4()
                
                if needs_replacement:
                    # Use safe atomic replacement
                    annotations_arr = np.zeros(centroids_len, dtype=annotation_dtype)
                    for field in ['cell_class', 'cell_color', 'region_x1', 'region_y1', 'region_x2', 'region_y2']:
                        annotations_arr[field] = -1
                    
                    annotations_dataset = _safe_replace_dataset(
                        group_anno,
                        ds_name,
                        data=annotations_arr,
                        dtype=annotation_dtype,
                        chunks=(optimal_chunk_size,),
                        compressor=compressor
                    )
                    annotations_dataset.attrs['annotation_format'] = 'structured'
                else:
                    # Create new dataset
                    annotations_arr = np.zeros(centroids_len, dtype=annotation_dtype)
                    for field in ['cell_class', 'cell_color', 'region_x1', 'region_y1', 'region_x2', 'region_y2']:
                        annotations_arr[field] = -1
                    
                    annotations_dataset = group_anno.create_dataset(
                        ds_name,
                        data=annotations_arr,
                        dtype=annotation_dtype,
                        chunks=(optimal_chunk_size,),
                        compressor=compressor
                    )
                    annotations_dataset.attrs['annotation_format'] = 'structured'
                    group_anno.attrs['annotation_format'] = 'structured'
            else:
                annotations_dataset = group_anno[ds_name]
            
            # Prepare batch update data
            now_timestamp = int(datetime.now().timestamp() * 1000)  # milliseconds
            method = "reclassification"
            annotator = "Unknown"
            
            # Convert matching_indices to numpy array for efficient operations
            matching_array = np.array(matching_indices, dtype=np.int64)
            valid_mask = (matching_array >= 0) & (matching_array < centroids_len)
            valid_indices = np.unique(matching_array[valid_mask])
            
            if len(valid_indices) == 0:
                logger.warning(f"[AL Save] No valid indices after validation")
                return {
                    "success": True,
                    "file_path": zarr_path,
                    "count": 0,
                    "new_count": 0,
                    "message": "No valid reclassifications to save"
                }
            
            # Create mapping from cell_idx to classification/color/geometry
            # Convert valid_indices to set for O(1) lookup
            valid_indices_set = set(valid_indices.tolist() if isinstance(valid_indices, np.ndarray) else valid_indices)
            idx_to_data = {}
            for i, cell_idx in enumerate(matching_indices):
                if cell_idx in valid_indices_set:
                    idx_to_data[cell_idx] = {
                        'classification': classifications[i],
                        'color': colors[i],
                        'region_geometry': region_geometries[i] if i < len(region_geometries) else None
                    }
            
            # Build class name to ID mapping
            # Get unique classes and their colors from reclassifications
            class_to_color = {}
            for cell_idx in valid_indices:
                # Convert numpy scalar to Python int for dict key
                cell_idx_int = int(cell_idx) if isinstance(cell_idx, (np.integer, np.ndarray)) else cell_idx
                if cell_idx_int in idx_to_data:
                    data = idx_to_data[cell_idx_int]
                    class_name = data['classification']
                    color = data['color']
                    if class_name not in class_to_color:
                        class_to_color[class_name] = color
            
            if not ui_nuclei_classes:
                # Extract unique classes from reclassifications
                ui_nuclei_classes = list(class_to_color.keys())
                ui_nuclei_colors = [class_to_color[cls] for cls in ui_nuclei_classes]
            
            # Ensure 'Negative control' exists and is first
            if 'Negative control' not in ui_nuclei_classes:
                ui_nuclei_classes = ['Negative control'] + ui_nuclei_classes
                ui_nuclei_colors = ['#aaaaaa'] + ui_nuclei_colors
            elif ui_nuclei_classes[0] != 'Negative control':
                nc_index = ui_nuclei_classes.index('Negative control')
                nc_color = ui_nuclei_colors[nc_index] if nc_index < len(ui_nuclei_colors) else '#aaaaaa'
                ui_nuclei_classes = ['Negative control'] + [n for n in ui_nuclei_classes if n != 'Negative control']
                ui_nuclei_colors = [nc_color] + [c for i, c in enumerate(ui_nuclei_colors) if i != nc_index]
            
            # Update handler's class definitions if available
            if (handler is not None and 
                ui_nuclei_classes is not None and len(ui_nuclei_classes) > 0 and
                ui_nuclei_colors is not None and len(ui_nuclei_colors) > 0):
                handler.update_class_definitions(ui_nuclei_classes, ui_nuclei_colors)
            
            # Store class names and colors in metadata
            group_anno.attrs['class_names'] = ui_nuclei_classes
            group_anno.attrs['class_colors'] = ui_nuclei_colors
            
            # Prepare structured array data for batch update
            num_updates = len(valid_indices)
            new_data = np.empty(num_updates, dtype=annotation_dtype)
            
            for i, cell_idx in enumerate(valid_indices):
                # Convert numpy scalar to Python int for dict key
                cell_idx_int = int(cell_idx) if isinstance(cell_idx, (np.integer, np.ndarray)) else cell_idx
                data = idx_to_data[cell_idx_int]
                classification = data['classification']
                color = data['color']
                region_geometry = data.get('region_geometry', {})
                
                # Convert class name to ID
                class_id = -1
                if classification in ui_nuclei_classes:
                    class_id = ui_nuclei_classes.index(classification)
                else:
                    # Add dynamically
                    ui_nuclei_classes.append(classification)
                    ui_nuclei_colors.append(color if color else '#aaaaaa')  # Default color (same as Negative control)
                    class_id = len(ui_nuclei_classes) - 1
                    logger.info(f"[AL Save] Class '{classification}' not found, added dynamically with index {class_id}")
                
                # Convert color to integer
                color_int = _hex_color_to_int(color) if color else -1
                
                # Parse region_geometry
                region_x1 = region_x2 = region_y1 = region_y2 = -1
                if region_geometry and isinstance(region_geometry, dict):
                    region_x1 = int(region_geometry.get('x1', -1))
                    region_y1 = int(region_geometry.get('y1', -1))
                    region_x2 = int(region_geometry.get('x2', -1))
                    region_y2 = int(region_geometry.get('y2', -1))
                
                # Fill structured array
                new_data[i]['cell_class'] = class_id
                new_data[i]['cell_color'] = color_int
                new_data[i]['annotator'] = _truncate_field(annotator, 64, 'annotator')
                new_data[i]['datetime'] = now_timestamp
                new_data[i]['method'] = _truncate_field(method, 32, 'method')
                new_data[i]['region_x1'] = region_x1
                new_data[i]['region_y1'] = region_y1
                new_data[i]['region_x2'] = region_x2
                new_data[i]['region_y2'] = region_y2
            
            # Read OLD cell_class values BEFORE overwriting to track class count changes
            old_class_ids = None
            try:
                old_class_ids = annotations_dataset['cell_class'][valid_indices].copy()
            except Exception as e:
                logger.warning(f"[AL Save] Could not read old cell_class values: {e}")
            
            # Update annotations dataset
            annotations_dataset[valid_indices] = new_data
            
            # Update class_counts (same as save_annotation)
            counts_ds_name = "class_counts"
            counts_dict = {}
            if counts_ds_name in group_anno:
                counts_raw = group_anno[counts_ds_name][()]
                if counts_raw:
                    try:
                        counts_dict = json.loads(counts_raw.decode("utf-8"))
                    except Exception:
                        counts_dict = {}
            
            # Properly track class count changes:
            # CRITICAL: Process decrements AND increments together in the same loop
            # to correctly handle re-saved data from Zarr (where old_class == new_class)
            #
            # Logic:
            # - old_id == -1 (not previously annotated): new_class +1
            # - old_id >= 0 and old_id != new_class_id (changed class): old_class -1, new_class +1
            # - old_id >= 0 and old_id == new_class_id (same class, already saved): NO CHANGE
            decremented_classes = {}
            incremented_classes = {}
            
            if old_class_ids is not None and ui_nuclei_classes:
                for i, old_id in enumerate(old_class_ids):
                    old_id_int = int(old_id)
                    new_class = classifications[i]
                    new_class_id = ui_nuclei_classes.index(new_class) if new_class in ui_nuclei_classes else -1
                    
                    # Skip if already has the same class (no change needed - data already saved)
                    if old_id_int >= 0 and old_id_int == new_class_id:
                        continue
                    
                    # Decrement old class count if cell was previously manually annotated
                    if old_id_int >= 0 and old_id_int < len(ui_nuclei_classes):
                        old_class_name = ui_nuclei_classes[old_id_int]
                        if old_class_name in counts_dict and counts_dict[old_class_name] > 0:
                            counts_dict[old_class_name] -= 1
                            decremented_classes[old_class_name] = decremented_classes.get(old_class_name, 0) + 1
                    
                    # Increment new class count
                    if new_class:
                        if new_class not in counts_dict:
                            counts_dict[new_class] = 0
                        counts_dict[new_class] += 1
                        incremented_classes[new_class] = incremented_classes.get(new_class, 0) + 1
            else:
                # Fallback: if old_class_ids not available, just increment all (first-time save)
                logger.warning(f"[AL Save] old_class_ids not available, incrementing all classifications")
                for classification in set(classifications):
                    if classification not in counts_dict:
                        counts_dict[classification] = 0
                    counts_dict[classification] += classifications.count(classification)
                    incremented_classes[classification] = classifications.count(classification)
            
            counts_out_str = json.dumps(counts_dict, ensure_ascii=False)
            counts_bytes = counts_out_str.encode("utf-8")
            
            if counts_ds_name in group_anno:
                existing_ds = group_anno[counts_ds_name]
                if existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                    existing_ds[()] = counts_bytes
                else:
                    _safe_replace_dataset(group_anno, counts_ds_name, data=counts_bytes)
            else:
                group_anno.create_dataset(counts_ds_name, data=counts_bytes)
            
            # Update metadata
            group_anno.attrs['class_names'] = ui_nuclei_classes
            group_anno.attrs['class_colors'] = ui_nuclei_colors
        
        # CRITICAL: Clear in-memory reclassifications after successful save to Zarr
        # This prevents double-counting in get_all_nuclei_counts() which would otherwise
        # read the saved counts from Zarr AND add the in-memory reclassifications again
        if instance_id in _reclassified_cells and zarr_path in _reclassified_cells[instance_id]:
            _reclassified_cells[instance_id][zarr_path].clear()
        
        # Also clear the global Zarr cache to force re-read on next access
        if zarr_path in _zarr_reclassifications_cache:
            del _zarr_reclassifications_cache[zarr_path]
        
        # Invalidate handler cache
        if handler:
            handler.invalidate_user_counts_cache()
            try:
                if handler.zarr_file and os.path.exists(handler.zarr_file):
                    from app.services.data import get_zarr_synchronizer
                    if handler._zarr_synchronizer is None:
                        handler._zarr_synchronizer = get_zarr_synchronizer(handler.zarr_file)
                    
                    with zarr.open(handler.zarr_file, 'r', synchronizer=handler._zarr_synchronizer) as zarr_file:
                        handler._apply_manual_nuclei_annotations(zarr_file)
                    
                    handler._zarr_file_obj = zarr.open(handler.zarr_file, 'r', synchronizer=handler._zarr_synchronizer)
            except Exception as e:
                logger.warning(f"[AL Save] Failed to refresh handler state: {e}")
        
        logger.info(f"[AL Save] Successfully saved {len(valid_indices)} reclassifications using structured array format: {zarr_path}")
        
        return {
            "success": True,
            "file_path": zarr_path,
            "count": len(valid_indices),
            "new_count": len(valid_indices),
            "message": f"Saved {len(valid_indices)} reclassifications"
        }
        
    except Exception as e:
        logger.error(f"[AL Save] Error saving reclassifications: {str(e)}", exc_info=True)
        return {
            "success": False, 
            "error": f"Error saving reclassifications: {str(e)}",
            "file_path": None,
            "count": 0
        }


