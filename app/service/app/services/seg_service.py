import math
import zarr
from zarr.sync import ThreadSynchronizer, ProcessSynchronizer
import json
import orjson
from datetime import datetime
from scipy.spatial import KDTree, Delaunay
import numpy as np
import time
import os
from typing import Dict, List, Optional, Any, Tuple
from collections import OrderedDict
import cv2
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from app.utils import resolve_path
from app.core.logger import logger
from app.config.zarr_config import ZarrGroups, ZarrDatasets, find_segmentation_group

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
        with zarr.open(file_path, 'r') as _:
            return False
    except:
        return True

def get_file_path(request_or_params):
    """Extract file path from request parameters - Zarr only"""
    current_file_path = None
    
    # Extract parameters from request object or dict
    if hasattr(request_or_params, 'query_params'):
        # FastAPI Request object
        query_params = request_or_params.query_params
    elif isinstance(request_or_params, dict):
        # Dictionary of parameters
        query_params = request_or_params
    else:
        return None
    
    # Try to get relative_path first, then fall back to file_path for compatibility
    file_path = query_params.get('relative_path') or query_params.get('file_path')
    if file_path:
        # Resolve virtual path aliases first (e.g., 'samples/Data' -> '/data/public')
        from app.config.path_config import resolve_virtual_path
        file_path = resolve_virtual_path(file_path)
        if not file_path:
            return None  # Invalid path alias
        file_path = resolve_path(file_path)
    
    # If we have a file path, resolve it to an absolute path
    if file_path:
        # Get storage root from centralized path configuration
        from app.config.path_config import STORAGE_ROOT
        
        # Check if the provided path is already absolute
        if os.path.isabs(file_path):
            full_file_path = os.path.normpath(file_path)
        else:
            # If relative, join it with the storage root
            full_file_path = os.path.join(STORAGE_ROOT, file_path.lstrip('/\\'))
            full_file_path = os.path.normpath(full_file_path)
        
        # Security check: Ensure the final path is still within the storage root
        # This is important even for absolute paths to prevent directory traversal
        if not full_file_path.startswith(os.path.normpath(STORAGE_ROOT)):
             # Allow absolute paths outside storage root for local development if they exist
            if os.path.isabs(file_path) and os.path.exists(file_path):
                 pass # Allow it
            else:
                return ''
        
        file_path = full_file_path
    
    if not file_path:
        # try to get the current loaded file path from load_service
        try:
            from app.services.load_service import current_file_path
            if current_file_path:
                file_path = current_file_path
        except (ImportError, AttributeError):
            pass
    
    current_file_path = file_path
    
    # Check if the file is a zarr file or needs zarr extension
    if current_file_path and not current_file_path.endswith('.zarr'):
        zarr_path = f"{current_file_path}.zarr"
        if os.path.exists(zarr_path):
            current_file_path = zarr_path
    
    # Additional check: if the file doesn't exist, try to add the .zarr extension
    if current_file_path and not os.path.exists(current_file_path):
        # try to add the .zarr extension
        zarr_path = f"{current_file_path}.zarr"
        if os.path.exists(zarr_path):
            current_file_path = zarr_path

    return current_file_path


def get_user_annotation_indices(file_path: str) -> Dict[str, List[int]]:
    """Return indices of user-annotated (ground truth) nuclei and tissue from zarr.
    Data format follows save_tissue / save_annotation (user_annotation/nuclei_annotations
    and user_annotation/tissue_annotations).
    Returns:
        {"nuclei_indices": [int, ...], "tissue_indices": [int, ...]}
    """
    result = {"nuclei_indices": [], "tissue_indices": []}
    if not file_path or not os.path.exists(file_path):
        return result
    try:
        with zarr.open(file_path, mode='r') as zf:
            # Nuclei: user_annotation/nuclei_annotations structured array; cell_class >= 0 means user-annotated
            if 'user_annotation' in zf and 'nuclei_annotations' in zf['user_annotation']:
                arr = zf['user_annotation/nuclei_annotations']
                if hasattr(arr.dtype, 'names') and arr.dtype.names is not None and 'cell_class' in arr.dtype.names:
                    full = arr[:]
                    for i in range(len(full)):
                        if full['cell_class'][i] >= 0:
                            result["nuclei_indices"].append(i)
            # Tissue: user_annotation/tissue_annotations JSON; keys are patch indices (strings)
            if 'user_annotation' in zf and 'tissue_annotations' in zf['user_annotation']:
                array = zf['user_annotation/tissue_annotations']
                raw_data = array[()] if array.shape == () else array[:]
                if isinstance(raw_data, bytes):
                    json_str = raw_data.decode('utf-8')
                elif isinstance(raw_data, np.ndarray):
                    if raw_data.dtype.kind in ('S', 'U'):
                        json_str = str(raw_data.item() if raw_data.ndim == 0 else raw_data.flat[0])
                        if isinstance(json_str, bytes):
                            json_str = json_str.decode('utf-8')
                    else:
                        json_str = '{}'
                elif isinstance(raw_data, str):
                    json_str = raw_data
                else:
                    json_str = '{}'
                try:
                    annotations_dict = json.loads(json_str)
                    if isinstance(annotations_dict, dict):
                        for k in annotations_dict.keys():
                            try:
                                result["tissue_indices"].append(int(k))
                            except (ValueError, TypeError):
                                pass
                except (json.JSONDecodeError, TypeError):
                    pass
    except Exception as e:
        logger.warning(f"get_user_annotation_indices failed for {file_path}: {e}")
    return result


def clear_all_caches_and_reset_handler():
    """clear all caches and reset handler singleton"""
    global _annotations_data

    _annotations_data = {}

    # No Zarr cache to clear

    try:
        handler = SegmentationHandler()
        handler.reset_data()
    except Exception as e:
        print(f"[WARN] Exception while trying to reset SegmentationHandler singleton: {e}")

    print("[DEBUG] All seg_service caches and the SegmentationHandler have been forcefully reset.")
    return {"status": "success", "message": "All caches cleared and handler reset."}

# Removed zarr cache related functions

# Removed force_release_all_zarr_files function

# Removed force_release_all_file_locks function

# Removed all cache-related functions

def query_viewport(handler: "SegmentationHandler",
                  x1: float, y1: float, x2: float, y2: float,
                  polygon_points: Optional[List[Tuple[float, float]]] = None, # Received in RAW frontend/OSD coordinates
                  class_name: Optional[str] = None, color: Optional[str] = None,
                  file_path: Optional[str] = None) -> Dict:
    """
    Query nuclei within viewport, optionally filtering points strictly inside the provided polygon.
    Coordinates (x1, y1, x2, y2, polygon_points) and handler centroids are expected in the same frontend/OSD image coordinate system.
    """

    # Use handler's already loaded data instead of reading from file
    if handler.centroids is None or len(handler.centroids) == 0:
        raise ValueError("Centroids data not loaded in handler")
    
    # Use the centroids data from handler
    centroids_data = handler.centroids

    query_start = time.time()
    centroids_arr = np.array(centroids_data)
    total_centroids = len(centroids_arr)
    matching_indices = []

    if total_centroids > 0:
        # Same coordinate system as x1,y1,x2,y2 and frontend OSD image space
        centroids_x = centroids_arr[:, 0]
        centroids_y = centroids_arr[:, 1]

        # 1. Filter by Bounding Box using backend centroids and frontend bbox
        in_bbox_mask = (
            (x1 <= centroids_x) & (centroids_x <= x2) &
            (y1 <= centroids_y) & (centroids_y <= y2)
        )
        indices_in_bbox = np.where(in_bbox_mask)[0]

        if len(indices_in_bbox) > 0:
            # 2. If Polygon points provided, perform PIP test using backend centroids and frontend polygon
            if polygon_points and MATPLOTLIB_AVAILABLE:
                # Get the coordinates of points within the bbox
                points_to_test = centroids_arr[indices_in_bbox]

                try:
                    polygon_path = Path(polygon_points)
                    tolerance_radius = -1e-9
                    is_inside = polygon_path.contains_points(points_to_test, radius=tolerance_radius)
                    final_indices_mask = np.where(is_inside)[0]
                    matching_indices = indices_in_bbox[final_indices_mask].tolist() # Get original indices
                except Exception as pip_error:
                    print(f"[ERROR] query_viewport - Error during PIP test: {pip_error}")
                    traceback.print_exc()
                    matching_indices = indices_in_bbox.tolist() # Fallback to BBox
                    print("[WARN] query_viewport - Falling back to BBox results due to PIP error.")

            else: # Rectangle or no matplotlib
                if polygon_points and not MATPLOTLIB_AVAILABLE:
                    print("[WARN] query_viewport - Matplotlib not found. Returning all points within bounding box.")
                matching_indices = indices_in_bbox.tolist()
        # else: BBox empty, matching_indices remains []
    # else: No centroids, matching_indices remains []


    # Store annotation colors based on the FINAL matching indices (indices into centroids array)
    if class_name and color and len(matching_indices) > 0:
        handler.store_annotation_color(matching_indices, class_name, color)

    return {
        "viewport": {"x1": x1, "y1": y1, "x2": x2, "y2": y2}, # Return original request bbox
        "matching_indices": matching_indices,
        "count": len(matching_indices)
    }


def list_mask_options(file_path: Optional[str] = None) -> Dict:
    """
    List available mask datasets from SegmentationNode only.
    All 2D arrays named 'mask' or 'mask_*' (e.g. mask, mask_gland, mask_tumor).
    Key 'mask' -> label "Default"; key 'mask_xxx' -> label "Xxx".
    """
    if not file_path or not os.path.exists(file_path):
        return {"success": False, "error": "Zarr file not found", "options": []}
    try:
        with zarr.open(file_path, 'r') as zarr_file:
            options = []
            if 'SegmentationNode' not in zarr_file:
                return {"success": True, "options": options}
            sn = zarr_file['SegmentationNode']
            for key in sorted(sn.keys()):
                if key != 'mask' and not key.startswith('mask_'):
                    continue
                try:
                    obj = sn[key]
                    if not hasattr(obj, 'shape') or len(obj.shape) != 2:
                        continue
                    if hasattr(obj, 'keys'):
                        continue
                    if key == 'mask':
                        label = 'Default'
                    else:
                        suffix = key[5:] if len(key) > 5 else key
                        label = suffix.capitalize() if suffix else key
                    options.append({"key": key, "label": label})
                except Exception:
                    continue
            return {"success": True, "options": options}
    except Exception as e:
        logger.exception(f"[Mask] list_mask_options failed: {e}")
        return {"success": False, "error": str(e), "options": []}


def get_segmentation_mask(handler: "SegmentationHandler",
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
        file_path = handler.get_current_file_path()
    
    if not file_path or not os.path.exists(file_path):
        raise ValueError(f"Zarr file not found: {file_path}")
    
    step_elapsed = time.time() - step_start
    logger.info(f"[Mask] Step 1 - Get file path: {step_elapsed*1000:.2f}ms")
    
    try:
        # Step 2: Open Zarr file
        step_start = time.time()
        with zarr.open(file_path, 'r') as zarr_file:
            step_elapsed = time.time() - step_start
            logger.info(f"[Mask] Step 2 - Open Zarr file: {step_elapsed*1000:.2f}ms")
            
            # Step 3: Resolve mask source from SegmentationNode only (mask, mask_gland, mask_tumor)
            step_start = time.time()
            if 'SegmentationNode' not in zarr_file:
                return {"success": False, "error": "SegmentationNode group not found"}
            seg_group = zarr_file['SegmentationNode']
            mask_dataset = None
            tissue_class = None
            if mask_key and mask_key.strip():
                if mask_key in seg_group and hasattr(seg_group[mask_key], 'shape') and len(seg_group[mask_key].shape) == 2:
                    mask_dataset = seg_group[mask_key]
                    tissue_class = mask_key[5:] if mask_key.startswith('mask_') and len(mask_key) > 5 else mask_key
            if mask_dataset is None:
                if 'mask' in seg_group and hasattr(seg_group['mask'], 'shape') and len(seg_group['mask'].shape) == 2:
                    mask_dataset = seg_group['mask']
                else:
                    return {"success": False, "error": "Mask dataset not found in SegmentationNode"}
            
            step_elapsed = time.time() - step_start
            logger.info(f"[Mask] Step 3 - Resolve mask source: {step_elapsed*1000:.2f}ms")
            
            # Step 4: Get full mask shape
            step_start = time.time()
            mask_shape = mask_dataset.shape
            if len(mask_shape) != 2:
                return {"success": False, "error": f"Expected 2D mask, got shape {mask_shape}"}
            mask_height, mask_width = mask_shape
            step_elapsed = time.time() - step_start
            logger.info(f"[Mask] Step 4 - Find mask dataset (shape: {mask_height}x{mask_width}): {step_elapsed*1000:.2f}ms")
            
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
                
                if use_stride_reading:
                    logger.info(f"[Mask] Using stride reading optimization: stride_x={stride_x}, stride_y={stride_y}, "
                              f"will read ~{actual_width//stride_x}x{actual_height//stride_y} instead of {actual_width}x{actual_height}")
            
            # Update actual_mask_width/height to reflect what will be read
            actual_mask_width = read_x1 - read_x0
            actual_mask_height = read_y1 - read_y0
            step_elapsed = time.time() - step_start
            logger.info(f"[Mask] Step 5 - Calculate coordinates (region: {actual_width}x{actual_height}): {step_elapsed*1000:.2f}ms")
            
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
                logger.info(f"[Mask] Read with stride: {actual_width}x{actual_height} (represents {actual_mask_width}x{actual_mask_height} in original)")
            else:
                # Read full resolution (for cases without target dimensions or when stride not beneficial)
                mask_subset = mask_dataset[read_y0:read_y1, read_x0:read_x1]
                actual_mask_width = actual_width
                actual_mask_height = actual_height
            step_elapsed = time.time() - step_start
            logger.info(f"[Mask] Step 6 - Read mask data from Zarr ({mask_subset.shape[1]}x{mask_subset.shape[0]}): {step_elapsed*1000:.2f}ms")
            
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
            if step_elapsed > 0.001:  # Only log if padding took significant time
                logger.info(f"[Mask] Step 7 - Padding: {step_elapsed*1000:.2f}ms")
            
            # Step 8: Convert to binary (ensure uint8)
            step_start = time.time()
            if mask_subset.dtype != np.uint8:
                mask_subset = (mask_subset > 0).astype(np.uint8) * 255
            else:
                # Ensure binary: 0 or 255
                mask_subset = (mask_subset > 0).astype(np.uint8) * 255
            step_elapsed = time.time() - step_start
            logger.info(f"[Mask] Step 8 - Convert to binary: {step_elapsed*1000:.2f}ms")
            
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
                    
                    # Use cv2.resize with INTER_NEAREST to preserve binary nature
                    # cv2.resize expects (width, height) order
                    mask_subset = cv2.resize(mask_subset, (final_width, final_height), interpolation=cv2.INTER_NEAREST)
                else:
                    # Already close to target size, no need to resize
                    logger.info(f"[Mask] Skipping resize - already close to target size ({viewport_width}x{viewport_height} vs {final_width}x{final_height})")
            step_elapsed = time.time() - step_start
            if step_elapsed > 0.001:  # Only log if downsampling took significant time
                logger.info(f"[Mask] Step 9 - Downsampling ({viewport_width}x{viewport_height} -> {final_width}x{final_height}): {step_elapsed*1000:.2f}ms")
            
            # Step 10: Try to read tissue_class if it exists (skip when mask_key was used; we already set it from key)
            step_start = time.time()
            if not mask_key or not str(mask_key).strip():
                tissue_class = None
            if (not mask_key or not str(mask_key).strip()) and 'tissue_class' in seg_group:
                try:
                    tissue_class_dataset = seg_group['tissue_class']
                    dataset_dtype = getattr(tissue_class_dataset, 'dtype', None)
                    
                    # Check dtype first to determine how to read
                    if dataset_dtype is not None:
                        dtype_kind = dataset_dtype.kind
                        if dtype_kind == 'S':  # String/bytes array (S1, S10, etc.)
                            # Read as bytes and decode
                            tissue_class_value = tissue_class_dataset[()]
                            if isinstance(tissue_class_value, np.ndarray):
                                if tissue_class_value.size == 0:
                                    tissue_class = None
                                else:
                                    val = tissue_class_value.item() if tissue_class_value.size == 1 else tissue_class_value.flat[0]
                                    if isinstance(val, bytes):
                                        tissue_class = val.decode('utf-8')
                                    else:
                                        # numpy string array, decode
                                        tissue_class = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
                            elif isinstance(tissue_class_value, bytes):
                                tissue_class = tissue_class_value.decode('utf-8')
                            else:
                                tissue_class = str(tissue_class_value)
                        elif dtype_kind == 'U':  # Unicode string array
                            tissue_class_value = tissue_class_dataset[()]
                            if isinstance(tissue_class_value, np.ndarray):
                                if tissue_class_value.size == 0:
                                    tissue_class = None
                                else:
                                    tissue_class = str(tissue_class_value.item() if tissue_class_value.size == 1 else tissue_class_value.flat[0])
                            else:
                                tissue_class = str(tissue_class_value)
                        else:
                            # Other dtype, read and convert
                            tissue_class_value = tissue_class_dataset[()]
                            if isinstance(tissue_class_value, bytes):
                                tissue_class = tissue_class_value.decode('utf-8')
                            elif isinstance(tissue_class_value, str):
                                tissue_class = tissue_class_value
                            elif isinstance(tissue_class_value, np.ndarray):
                                if tissue_class_value.size == 0:
                                    tissue_class = None
                                else:
                                    val = tissue_class_value.item() if tissue_class_value.size == 1 else tissue_class_value.flat[0]
                                    if isinstance(val, bytes):
                                        tissue_class = val.decode('utf-8')
                                    else:
                                        tissue_class = str(val)
                            else:
                                tissue_class = str(tissue_class_value)
                    else:
                        # No dtype info, try reading directly
                        tissue_class_value = tissue_class_dataset[()]
                        if isinstance(tissue_class_value, bytes):
                            tissue_class = tissue_class_value.decode('utf-8')
                        elif isinstance(tissue_class_value, str):
                            tissue_class = tissue_class_value
                        elif isinstance(tissue_class_value, np.ndarray):
                            if tissue_class_value.size == 0:
                                tissue_class = None
                            else:
                                val = tissue_class_value.item() if tissue_class_value.size == 1 else tissue_class_value.flat[0]
                                if isinstance(val, bytes):
                                    tissue_class = val.decode('utf-8')
                                else:
                                    tissue_class = str(val)
                        else:
                            tissue_class = str(tissue_class_value)
                    
                    # Final cleanup: if somehow we got a string representation of bytes, fix it
                    if tissue_class and isinstance(tissue_class, str):
                        if tissue_class.startswith("b'") and tissue_class.endswith("'"):
                            # Remove b'...' wrapper
                            inner = tissue_class[2:-1]
                            # Handle Python string escape sequences
                            try:
                                tissue_class = inner.encode('latin-1').decode('unicode_escape')
                            except:
                                tissue_class = inner
                        elif tissue_class.startswith('b"') and tissue_class.endswith('"'):
                            # Remove b"..."
                            inner = tissue_class[2:-1]
                            try:
                                tissue_class = inner.encode('latin-1').decode('unicode_escape')
                            except:
                                tissue_class = inner
                    
                except Exception as e:
                    import traceback
                    traceback.print_exc()
            step_elapsed = time.time() - step_start
            if step_elapsed > 0.001:  # Only log if reading tissue_class took significant time
                logger.info(f"[Mask] Step 10 - Read tissue_class: {step_elapsed*1000:.2f}ms")
            
            # Step 11: Convert to bytes
            step_start = time.time()
            result = {
                "success": True,
                "data": mask_subset.tobytes(),
                "shape": [final_height, final_width],
                "dtype": "uint8",
                "offset": [int(x1), int(y1)],  # Original requested offset in RAW coordinates (may be negative)
                "full_shape": [mask_height, mask_width],
                "region_size": [actual_mask_width, actual_mask_height]  # Actual mask data size in RAW coordinates (before padding, before downsampling)
            }
            
            if tissue_class:
                result["tissue_class"] = tissue_class
            
            step_elapsed = time.time() - step_start
            logger.info(f"[Mask] Step 11 - Convert to bytes: {step_elapsed*1000:.2f}ms")
            
            # Total time
            total_elapsed = time.time() - start_time
            logger.info(f"[Mask] Total processing time: {total_elapsed*1000:.2f}ms (requested: {requested_width}x{requested_height}, final: {final_width}x{final_height})")
            
            return result
    except Exception as e:
        total_elapsed = time.time() - start_time
        logger.error(f"[Mask] Error after {total_elapsed*1000:.2f}ms: {str(e)}")
        traceback.print_exc()
        return {"success": False, "error": str(e)}


def query_patches_in_viewport(handler: "SegmentationHandler",
                             x1: float, y1: float, x2: float, y2: float,
                             polygon_points: Optional[List[Tuple[float, float]]] = None,
                             file_path: Optional[str] = None) -> Dict:
    """
    Query patches whose centroids fall within the viewport or polygon.
    All coordinates are expected in RAW frontend/OSD coordinate system.
    """
    print(f"[DEBUG] query_patches_in_viewport - Service function called.")
    print(f"[DEBUG] query_patches_in_viewport - BBox parameters (raw OSD coords): x1={x1}, y1={y1}, x2={x2}, y2={y2}")
    if polygon_points:
        print(f"[DEBUG] query_patches_in_viewport - Polygon points received (raw OSD coords): {len(polygon_points)} vertices")

    if not file_path:
        raise ValueError("No file path provided for query_patches_in_viewport")

    if not os.path.exists(file_path):
        raise ValueError(f"Zarr file not found: {file_path}")

    # Read patch coordinates directly from Zarr file
    try:
        with zarr.open(file_path, 'r') as zarr_file:
            # Look for patch coordinates in different possible locations
            patch_coords_data = None
            
            # First try root level keys
            for key in ['patch_coordinates', 'patch_coords', 'patches']:
                if key in zarr_file:
                    patch_coords_data = zarr_file[key]
                    break
            
            # If not found, try MuskNode group (common location for patch data)
            if patch_coords_data is None and 'MuskNode' in zarr_file:
                musk_node = zarr_file['MuskNode']
                if 'coordinates' in musk_node:
                    patch_coords_data = musk_node['coordinates']
                    print(f"[DEBUG] query_patches_in_viewport - Found patch coordinates in MuskNode/coordinates")
            
            # If still not found, try other possible group locations
            if patch_coords_data is None:
                for group_name in ['PatchNode', 'PatchData', 'patches']:
                    if group_name in zarr_file:
                        group = zarr_file[group_name]
                        for coord_key in ['coordinates', 'coords', 'patch_coordinates']:
                            if coord_key in group:
                                patch_coords_data = group[coord_key]
                                print(f"[DEBUG] query_patches_in_viewport - Found patch coordinates in {group_name}/{coord_key}")
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
                            print(f"[DEBUG] query_patches_in_viewport - After polygon filter: {len(matching_indices)} patch centroids inside polygon.")
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
            print(f"[DEBUG] query_patches_in_viewport - Found final matching patches: {len(matching_indices)}/{total_patches}, time: {query_end - query_start:.2f} seconds")

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
                "tissue_annotations": {},
                "count": 0
            }
    
    tissues = handler.tissues
    tissue_annotations = handler.get_all_tissue_annotations()
    
    return {
        "tissues": tissues,
        "tissue_annotations": tissue_annotations,
        "count": len(tissues)
    }

def reload_segmentation_data(handler: "SegmentationHandler", path: Optional[str] = None) -> Dict:
    """Reload segmentation data"""
    import os
    
    if path:
        # Convert path to zarr file path if needed
        zarr_path = path if path.endswith('.zarr') else f"{path}.zarr"
        
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
                    logger.error(f"Failed to load zarr file {zarr_path}: {e}")
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
                    logger.error(f"Failed to reload zarr file {zarr_path}: {e}")
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
                logger.error(f"Failed to reload zarr file {current_path}: {e}")
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
    print(f"tissue_type: {tissue_type}, nuclei_type: {nuclei_type}, patch_type: {patch_type}")
    print(f"handler: {handler}")
    
    if tissue_type:
        handler.set_tissue_segmentation_prefix(tissue_type)
        print(f"handler.set_tissue_segmentation_prefix: {handler.set_tissue_segmentation_prefix}")
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
    
    # Only load file if not already loaded or path changed
    current_path = getattr(handler, 'zarr_file', None)
    if current_path != file_path or handler.centroids is None:
        handler.load_file(file_path, force_reload=False)
    
    handler.update_class_color_in_zarr(class_name, new_color)
    return {"message": f"Successfully updated color for class '{class_name}' to '{new_color}'."}

def update_patch_class_color_service(handler: "SegmentationHandler", class_name: str, new_color: str, file_path: str):
    """Service function to update a patch classification class color in MuskNode."""
    
    # Only load file if not already loaded or path changed
    current_path = getattr(handler, 'zarr_file', None)
    if current_path != file_path or handler.centroids is None:
        handler.load_file(file_path, force_reload=False)
    
    handler.update_patch_class_color_in_zarr(class_name, new_color)
    return {"message": f"Successfully updated patch classification color for class '{class_name}' to '{new_color}'."}


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
    import json
    
    print(f"[clear_nuclei_annotations] Starting - bbox: ({x1}, {y1}) to ({x2}, {y2})")
    print(f"[clear_nuclei_annotations] Handler exists: {handler is not None}")
    
    # Ensure file is loaded
    if handler:
        current_path = getattr(handler, 'zarr_file', None)
        print(f"[clear_nuclei_annotations] Handler current path: {current_path}, target: {file_path}")
        if current_path != file_path or handler.centroids is None:
            print(f"[clear_nuclei_annotations] Loading file...")
            handler.load_file(file_path, force_reload=False)
        print(f"[clear_nuclei_annotations] Handler centroids: {handler.centroids is not None}, count: {len(handler.centroids) if handler.centroids is not None else 0}")
    
    cleared_count = 0
    cleared_classes = {}  # Track how many of each class were cleared
    
    try:
        with zarr.open(file_path, mode='a') as zf:
            if 'user_annotation' not in zf or 'nuclei_annotations' not in zf['user_annotation']:
                print(f"[clear_nuclei_annotations] No nuclei_annotations found in zarr")
                return {"cleared_count": 0, "message": "No nuclei annotations found"}
            
            array = zf['user_annotation/nuclei_annotations']
            print(f"[clear_nuclei_annotations] Array dtype: {array.dtype}, shape: {array.shape}")
            
            # Check if this is a structured array
            if not (hasattr(array.dtype, 'names') and array.dtype.names is not None):
                print(f"[clear_nuclei_annotations] Not a structured array")
                return {"cleared_count": 0, "message": "Invalid annotation format"}
            
            print(f"[clear_nuclei_annotations] Array dtype names: {array.dtype.names}")
            
            # Read the full array
            full_array = array[:]
            print(f"[clear_nuclei_annotations] Full array length: {len(full_array)}")
            
            # Get class names for tracking
            class_names = []
            user_anno_group = zf['user_annotation']
            if hasattr(user_anno_group, 'attrs') and 'class_names' in user_anno_group.attrs:
                class_names_raw = user_anno_group.attrs['class_names']
                if isinstance(class_names_raw, (list, tuple)):
                    class_names = [str(name) for name in class_names_raw]
                elif isinstance(class_names_raw, np.ndarray):
                    class_names = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in class_names_raw]
            print(f"[clear_nuclei_annotations] Class names: {class_names}")
            
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
                print(f"[clear_nuclei_annotations] Handler centroids not available, trying to load from zarr...")
                # Look for SegmentationNode centroids
                for key in zf.keys():
                    if 'SegmentationNode' in key or 'segmentation' in key.lower():
                        seg_group = zf[key]
                        if 'centroids' in seg_group:
                            centroids = seg_group['centroids'][:]
                            print(f"[clear_nuclei_annotations] Loaded centroids from {key}/centroids, count: {len(centroids)}")
                            break
            
            if centroids is None:
                print(f"[clear_nuclei_annotations] ERROR: No centroids available!")
                return {"cleared_count": 0, "message": "Cannot find cell centroids"}
            
            # Input bbox (x1, y1, x2, y2), polygon_points, and handler centroids use the same image coordinate space.
            
            # Count annotated cells first and show some sample coordinates
            annotated_count = 0
            sample_annotated_coords = []
            if 'cell_class' in array.dtype.names:
                for cell_id in range(len(full_array)):
                    if full_array['cell_class'][cell_id] >= 0:
                        annotated_count += 1
                        if len(sample_annotated_coords) < 5 and cell_id < len(centroids):
                            cx, cy = centroids[cell_id]
                            sample_annotated_coords.append((cell_id, cx, cy))
            print(f"[clear_nuclei_annotations] Total annotated cells: {annotated_count}")
            print(f"[clear_nuclei_annotations] Input bbox: ({x1}, {y1}) to ({x2}, {y2})")
            if sample_annotated_coords:
                print(f"[clear_nuclei_annotations] Sample annotated cell coords (cell_id, x, y):")
                for sample in sample_annotated_coords:
                    print(f"  Cell {sample[0]}: ({sample[1]:.2f}, {sample[2]:.2f})")
            
            # Find cells in region
            cells_in_bbox = 0
            cleared_cell_ids = []  # Track which cells were cleared for handler update
            for cell_id in range(min(len(full_array), len(centroids))):
                # Check if this cell is annotated
                if 'cell_class' not in array.dtype.names:
                    continue
                if full_array['cell_class'][cell_id] < 0:
                    continue  # Not annotated
                
                # Get centroid for this cell (same coordinate space as input bbox)
                cx, cy = centroids[cell_id]
                
                # Check if centroid is in bounding box
                if x1 <= cx <= x2 and y1 <= cy <= y2:
                    cells_in_bbox += 1
                    
                    # Check polygon if provided
                    if polygon_points and not is_point_in_polygon(cx, cy, polygon_points):
                        continue
                    
                    # Get old class name for tracking
                    old_class_index = int(full_array['cell_class'][cell_id])
                    old_class_name = class_names[old_class_index] if 0 <= old_class_index < len(class_names) else 'Unknown'
                    
                    # Clear the annotation
                    full_array['cell_class'][cell_id] = -1
                    full_array['cell_color'][cell_id] = -1
                    
                    # Clear other fields if they exist
                    if 'annotator' in array.dtype.names:
                        full_array['annotator'][cell_id] = ''
                    if 'method' in array.dtype.names:
                        full_array['method'][cell_id] = ''
                    
                    cleared_count += 1
                    cleared_cell_ids.append(cell_id)
                    cleared_classes[old_class_name] = cleared_classes.get(old_class_name, 0) + 1
            
            print(f"[clear_nuclei_annotations] Annotated cells in bbox: {cells_in_bbox}, cleared: {cleared_count}")
            
            if cleared_count > 0:
                # Write back to zarr
                array[:] = full_array
                print(f"[clear_nuclei_annotations] Written updated array to zarr")
                
                # IMPORTANT: Also update handler's in-memory class_id cache
                # This ensures WebSocket returns updated colors immediately
                if handler and hasattr(handler, 'class_id') and handler.class_id is not None:
                    for cell_id in cleared_cell_ids:
                        if cell_id < len(handler.class_id):
                            handler.class_id[cell_id] = -1
                    print(f"[clear_nuclei_annotations] Updated handler.class_id cache for {len(cleared_cell_ids)} cells")
                    
                    # CRITICAL: Clear viewport cache to ensure fresh data is returned
                    # Without this, cached annotation data with old class_ids would be returned
                    if hasattr(handler, '_viewport_cache'):
                        handler._viewport_cache.clear()
                        print(f"[clear_nuclei_annotations] Cleared viewport cache")
                
                # Update class_counts
                if 'class_counts' in user_anno_group:
                    try:
                        counts_raw = user_anno_group['class_counts'][()]
                        if isinstance(counts_raw, bytes):
                            counts_dict = json.loads(counts_raw.decode('utf-8'))
                        elif isinstance(counts_raw, str):
                            counts_dict = json.loads(counts_raw)
                        else:
                            counts_dict = {}
                        
                        print(f"[clear_nuclei_annotations] Old class_counts: {counts_dict}")
                        
                        # Decrement counts for cleared classes
                        for class_name, count in cleared_classes.items():
                            if class_name in counts_dict:
                                counts_dict[class_name] = max(0, counts_dict[class_name] - count)
                                if counts_dict[class_name] == 0:
                                    del counts_dict[class_name]
                        
                        print(f"[clear_nuclei_annotations] New class_counts: {counts_dict}")
                        
                        # Save updated counts
                        counts_bytes = json.dumps(counts_dict, ensure_ascii=False).encode('utf-8')
                        existing_ds = user_anno_group['class_counts']
                        if existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                            existing_ds[()] = counts_bytes
                        else:
                            del user_anno_group['class_counts']
                            user_anno_group.create_dataset('class_counts', data=counts_bytes)
                    except Exception as e:
                        print(f"[clear_nuclei_annotations] Warning: Failed to update class_counts: {e}")
        
        print(f"[clear_nuclei_annotations] Done - cleared {cleared_count} annotations")
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
    cell_indices: Optional[List[int]] = None
) -> Dict:
    """Mark AI-predicted nuclei annotations in the specified region as ground truth (user annotations).
    
    This function finds cells in the region that have AI predictions (from ClassificationNode)
    but are NOT yet in user_annotation/nuclei_annotations, and saves them as user annotations.
    This effectively "promotes" AI predictions to ground truth annotations.
    
    When cell_indices is provided, only those cell ids are considered (bbox/polygon check skipped).
    
    Args:
        handler: SegmentationHandler instance
        file_path: Path to the zarr file
        x1, y1, x2, y2: Bounding box in the same image coordinate system as handler centroids (frontend/OSD)
        polygon_points: Optional polygon vertices for more precise selection
        cell_indices: Optional list of cell ids to mark; when set, only these ids are considered
        
    Returns:
        Dict with marked_count and success status
    """
    import zarr
    import json
    from datetime import datetime
    
    print(f"[mark_nuclei_as_ground_truth] Starting - bbox: ({x1}, {y1}) to ({x2}, {y2})")
    
    # Ensure file is loaded
    if handler:
        current_path = getattr(handler, 'zarr_file', None)
        if current_path != file_path or handler.centroids is None or handler.class_id is None:
            print(f"[mark_nuclei_as_ground_truth] Loading file...")
            handler.load_file(file_path, force_reload=False)
        print(f"[mark_nuclei_as_ground_truth] Handler centroids: {handler.centroids is not None}, class_id: {handler.class_id is not None}")
    
    if handler.class_id is None or handler.class_name is None:
        return {"marked_count": 0, "message": "No AI predictions found (ClassificationNode not loaded)"}
    
    marked_count = 0
    marked_classes = {}  # Track how many of each class were marked
    
    try:
        with zarr.open(file_path, mode='a') as zf:
            # Ensure user_annotation group exists
            if 'user_annotation' not in zf:
                zf.create_group('user_annotation')
            
            user_anno_group = zf['user_annotation']
            
            # Get or create nuclei_annotations array
            from app.services.tasks_service import _get_annotation_dtype
            annotation_dtype = _get_annotation_dtype()
            
            centroids_len = len(handler.centroids) if handler.centroids is not None else 0
            if centroids_len == 0:
                return {"marked_count": 0, "message": "No centroids found"}
            
            # Create or get existing annotations array
            if 'nuclei_annotations' not in user_anno_group:
                # Create new array
                from numcodecs import LZ4
                optimal_chunk_size = max(1000, min(centroids_len, (8 * 1024 * 1024) // annotation_dtype.itemsize))
                annotations_array = user_anno_group.create_dataset(
                    'nuclei_annotations',
                    shape=(centroids_len,),
                    dtype=annotation_dtype,
                    chunks=(optimal_chunk_size,),
                    compressor=LZ4(),
                    fill_value=None
                )
                annotations_array.attrs['annotation_format'] = 'structured'
                # Initialize with -1 (unclassified)
                full_array = np.zeros(centroids_len, dtype=annotation_dtype)
                for field in ['cell_class', 'cell_color', 'region_x1', 'region_y1', 'region_x2', 'region_y2']:
                    full_array[field] = -1
                annotations_array[:] = full_array
            else:
                annotations_array = user_anno_group['nuclei_annotations']
                full_array = annotations_array[:]
            
            # Get class names from handler or user_annotation metadata
            class_names = []
            if handler.class_name is not None:
                class_names = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in handler.class_name]
            elif hasattr(user_anno_group, 'attrs') and 'class_names' in user_anno_group.attrs:
                class_names_raw = user_anno_group.attrs['class_names']
                if isinstance(class_names_raw, (list, tuple)):
                    class_names = [str(name) for name in class_names_raw]
                elif isinstance(class_names_raw, np.ndarray):
                    class_names = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in class_names_raw]
            
            if not class_names:
                return {"marked_count": 0, "message": "No class names found"}
            
            # Get class colors
            class_colors = []
            if handler.class_hex_color is not None:
                class_colors = [color.decode('utf-8') if isinstance(color, bytes) else str(color) for color in handler.class_hex_color]
            elif hasattr(user_anno_group, 'attrs') and 'class_colors' in user_anno_group.attrs:
                class_colors_raw = user_anno_group.attrs['class_colors']
                if isinstance(class_colors_raw, (list, tuple)):
                    class_colors = [str(color) for color in class_colors_raw]
            
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
                candidate_ids = list(range(n_cells))
            
            marked_cell_ids = []
            for cell_id in candidate_ids:
                # Check if this cell has AI prediction (class_id >= 0)
                ai_class_id = handler.class_id[cell_id]
                if ai_class_id < 0:
                    continue  # No AI prediction
                
                # Check if this cell is already a user annotation
                if full_array['cell_class'][cell_id] >= 0:
                    continue  # Already a user annotation, skip
                
                # When not using cell_indices, filter by region
                if cell_indices is None:
                    cx, cy = centroids[cell_id]
                    if not (x1 <= cx <= x2 and y1 <= cy <= y2):
                        continue
                    if polygon_points and not is_point_in_polygon(cx, cy, polygon_points):
                        continue
                
                # Mark as ground truth: save AI prediction as user annotation
                class_name = class_names[ai_class_id] if 0 <= ai_class_id < len(class_names) else 'Unknown'
                class_color_hex = class_colors[ai_class_id] if 0 <= ai_class_id < len(class_colors) else '#808080'
                class_color_int = hex_to_rgb_int(class_color_hex)
                
                # Update the annotation array
                full_array['cell_class'][cell_id] = ai_class_id
                full_array['cell_color'][cell_id] = class_color_int
                
                # Set metadata fields
                if 'annotator' in full_array.dtype.names:
                    full_array['annotator'][cell_id] = 'ground_truth'
                if 'datetime' in full_array.dtype.names:
                    full_array['datetime'][cell_id] = int(datetime.now().timestamp() * 1000)
                if 'method' in full_array.dtype.names:
                    full_array['method'][cell_id] = 'mark_as_ground_truth'
                if 'region_x1' in full_array.dtype.names:
                    full_array['region_x1'][cell_id] = int(x1)
                    full_array['region_y1'][cell_id] = int(y1)
                    full_array['region_x2'][cell_id] = int(x2)
                    full_array['region_y2'][cell_id] = int(y2)
                
                marked_count += 1
                marked_cell_ids.append(cell_id)
                marked_classes[class_name] = marked_classes.get(class_name, 0) + 1
            
            print(f"[mark_nuclei_as_ground_truth] Found {marked_count} AI-predicted cells to mark as ground truth")
            
            if marked_count > 0:
                # Write back to zarr
                annotations_array[:] = full_array
                print(f"[mark_nuclei_as_ground_truth] Written updated array to zarr")
                
                # Set user_annotation.attrs class_names and class_colors (same as non-batch save_annotation)
                # so downstream _apply_manual_nuclei_annotations / supervised classification can use them
                if class_names:
                    user_anno_group.attrs['class_names'] = [str(n) for n in class_names]
                if class_colors:
                    user_anno_group.attrs['class_colors'] = [str(c) for c in class_colors]
                
                # Update handler's in-memory class_id cache (no change needed, already correct)
                # But clear viewport cache to ensure fresh data
                if hasattr(handler, '_viewport_cache'):
                    handler._viewport_cache.clear()
                    print(f"[mark_nuclei_as_ground_truth] Cleared viewport cache")
                # Invalidate nuclei counts caches so API/UI get fresh counts after ground truth update
                if hasattr(handler, 'invalidate_user_counts_cache') and callable(handler.invalidate_user_counts_cache):
                    handler.invalidate_user_counts_cache()
                    print(f"[mark_nuclei_as_ground_truth] Invalidated user counts cache")
                else:
                    if hasattr(handler, '_user_annotation_counts_cache'):
                        handler._user_annotation_counts_cache = None
                    if hasattr(handler, '_global_label_counts_cache'):
                        handler._global_label_counts_cache = None
                    print(f"[mark_nuclei_as_ground_truth] Cleared counts caches (fallback)")
                
                # Update class_counts
                try:
                    if 'class_counts' in user_anno_group:
                        counts_raw = user_anno_group['class_counts'][()]
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
                    
                    print(f"[mark_nuclei_as_ground_truth] Updated class_counts: {counts_dict}")
                    
                    # Save updated counts
                    counts_bytes = json.dumps(counts_dict, ensure_ascii=False).encode('utf-8')
                    if 'class_counts' in user_anno_group:
                        existing_ds = user_anno_group['class_counts']
                        if existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                            existing_ds[()] = counts_bytes
                        else:
                            del user_anno_group['class_counts']
                            user_anno_group.create_dataset('class_counts', data=counts_bytes)
                    else:
                        user_anno_group.create_dataset('class_counts', data=counts_bytes)
                except Exception as e:
                    print(f"[mark_nuclei_as_ground_truth] Warning: Failed to update class_counts: {e}")
        
        print(f"[mark_nuclei_as_ground_truth] Done - marked {marked_count} annotations as ground truth")
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
    import json
    
    # Ensure file is loaded
    if handler:
        current_path = getattr(handler, 'zarr_file', None)
        if current_path != file_path or handler.centroids is None:
            handler.load_file(file_path, force_reload=False)
    
    cleared_count = 0
    cleared_classes = {}  # Track how many of each class were cleared
    
    try:
        with zarr.open(file_path, mode='a') as zf:
            if 'user_annotation' not in zf or 'tissue_annotations' not in zf['user_annotation']:
                return {"cleared_count": 0, "message": "No tissue annotations found"}
            
            array = zf['user_annotation/tissue_annotations']
            
            # Read the JSON data
            if hasattr(array, 'shape') and array.shape == ():
                raw_data = array[()]
            else:
                raw_data = array[:]
            
            # Parse JSON
            if isinstance(raw_data, bytes):
                json_str = raw_data.decode('utf-8')
            elif isinstance(raw_data, np.ndarray):
                if raw_data.dtype.kind == 'S' or raw_data.dtype.kind == 'U':
                    if raw_data.ndim == 0:
                        json_str = str(raw_data.item())
                    else:
                        json_str = str(raw_data.flat[0])
                    if isinstance(json_str, bytes):
                        json_str = json_str.decode('utf-8')
                else:
                    json_str = '{}'
            elif isinstance(raw_data, str):
                json_str = raw_data
            else:
                json_str = str(raw_data)
            
            try:
                annotations_dict = json.loads(json_str)
            except (json.JSONDecodeError, TypeError):
                return {"cleared_count": 0, "message": "Invalid annotation format"}
            
            if not isinstance(annotations_dict, dict):
                return {"cleared_count": 0, "message": "Invalid annotation format"}
            
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
            
            # Input bbox, polygon_points, and handler patch_coordinates share the same image coordinate space.
            
            # Get patch centroids from handler
            # NOTE: patch_coordinates format is [x1, y1, x2, y2] (top-left and bottom-right corners)
            # NOT [x, y, width, height]!
            patch_centroids = {}
            if handler and handler.patch_coordinates is not None:
                patch_coords = handler.patch_coordinates
                for i in range(len(patch_coords)):
                    if len(patch_coords[i]) == 4:
                        # Format is [x1, y1, x2, y2] - top-left and bottom-right corners
                        px1, py1, px2, py2 = patch_coords[i]
                        cx = (px1 + px2) / 2
                        cy = (py1 + py2) / 2
                        patch_centroids[i] = (cx, cy)
            
            print(f"[clear_tissue_annotations] Input bbox: ({x1}, {y1}) to ({x2}, {y2})")
            print(f"[clear_tissue_annotations] Total patches with coordinates: {len(patch_centroids)}")
            print(f"[clear_tissue_annotations] Total annotations in file: {len(annotations_dict)}")
            
            # Show sample patch coordinates for debugging
            if patch_centroids:
                sample_patches = list(patch_centroids.items())[:3]
                print(f"[clear_tissue_annotations] Sample patch centroids: {sample_patches}")
            
            # Show annotated patch IDs
            annotated_patch_ids = list(annotations_dict.keys())
            print(f"[clear_tissue_annotations] Annotated patch IDs: {annotated_patch_ids}")
            
            # Find patches to clear
            patches_to_clear = []
            for patch_id_str, annotation_data in list(annotations_dict.items()):
                if not isinstance(annotation_data, dict):
                    continue
                
                # Resolve patch id and centroid (same coordinate space as input bbox)
                patch_id = int(patch_id_str)
                
                # Get centroid from our pre-calculated dict
                if patch_id not in patch_centroids:
                    print(f"[clear_tissue_annotations] Warning: patch {patch_id} not found in coordinates, skipping")
                    continue
                
                patch_x, patch_y = patch_centroids[patch_id]
                print(f"[clear_tissue_annotations] Checking patch {patch_id}: centroid=({patch_x:.2f}, {patch_y:.2f}), in_bbox={x1 <= patch_x <= x2 and y1 <= patch_y <= y2}")
                
                # Check if patch is in bounding box
                if not (x1 <= patch_x <= x2 and y1 <= patch_y <= y2):
                    continue
                
                # Check polygon if provided
                if polygon_points and not is_point_in_polygon(patch_x, patch_y, polygon_points):
                    continue
                
                patches_to_clear.append(patch_id_str)
                
                # Track cleared class
                old_class_name = annotation_data.get('tissue_class', 'Unknown')
                cleared_classes[old_class_name] = cleared_classes.get(old_class_name, 0) + 1
            
            # Clear the patches
            for patch_id_str in patches_to_clear:
                del annotations_dict[patch_id_str]
                cleared_count += 1
            
            if cleared_count > 0:
                # Write back to zarr
                updated_json_str = json.dumps(annotations_dict, ensure_ascii=False)
                encoded_bytes = updated_json_str.encode('utf-8')
                
                if hasattr(array, 'shape') and array.shape == ():
                    array[()] = encoded_bytes
                else:
                    array[:] = encoded_bytes
                
                # Update patch_class_counts
                user_anno_group = zf['user_annotation']
                if 'patch_class_counts' in user_anno_group:
                    try:
                        counts_dataset = user_anno_group['patch_class_counts']
                        if hasattr(counts_dataset, 'shape') and counts_dataset.shape == ():
                            counts_raw = counts_dataset[()]
                        else:
                            counts_raw = counts_dataset[:]
                        
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
                        
                        print(f"[clear_tissue_annotations] Updated patch_class_counts: {counts_dict}")
                        
                        # Save updated counts
                        counts_bytes = json.dumps(counts_dict, ensure_ascii=False).encode('utf-8')
                        existing_ds = user_anno_group['patch_class_counts']
                        if existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                            existing_ds[()] = counts_bytes
                        else:
                            del user_anno_group['patch_class_counts']
                            user_anno_group.create_dataset('patch_class_counts', data=counts_bytes)
                    except Exception as e:
                        print(f"[clear_tissue_annotations] Warning: Failed to update patch_class_counts: {e}")
                
                # Also update handler's tissue_annotations cache and patch_class_id
                if handler:
                    for patch_id_str in patches_to_clear:
                        patch_id = int(patch_id_str)
                        # Remove from tissue_annotations dict
                        if patch_id in handler.tissue_annotations:
                            del handler.tissue_annotations[patch_id]
                        # Also reset patch_class_id to -1 (unclassified)
                        if hasattr(handler, 'patch_class_id') and handler.patch_class_id is not None:
                            if patch_id < len(handler.patch_class_id):
                                handler.patch_class_id[patch_id] = -1
                    
                    print(f"[clear_tissue_annotations] Updated handler caches for {len(patches_to_clear)} patches")
                    
                    # Clear viewport cache to ensure fresh data is returned
                    if hasattr(handler, '_viewport_cache'):
                        handler._viewport_cache.clear()
                        print(f"[clear_tissue_annotations] Cleared viewport cache")
        
        return {"cleared_count": cleared_count, "cleared_classes": cleared_classes}
    
    except Exception as e:
        print(f"[clear_tissue_annotations] Error: {e}")
        traceback.print_exc()
        raise ValueError(f"Failed to clear tissue annotations: {str(e)}")


def mark_tissue_as_ground_truth_in_region(
    handler: "SegmentationHandler",
    file_path: str,
    x1: float, y1: float, x2: float, y2: float,
    polygon_points: Optional[List[List[float]]] = None
) -> Dict:
    """Mark AI-predicted tissue annotations in the specified region as ground truth (user annotations).
    
    This function finds patches in the region that have AI predictions (from patch classification model)
    but are NOT yet in user_annotation/tissue_annotations, and saves them as user annotations.
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
    import json
    from datetime import datetime
    
    print(f"[mark_tissue_as_ground_truth] Starting - bbox: ({x1}, {y1}) to ({x2}, {y2})")
    
    # Ensure file is loaded
    if handler:
        current_path = getattr(handler, 'zarr_file', None)
        if current_path != file_path or handler.patch_coordinates is None:
            print(f"[mark_tissue_as_ground_truth] Loading file...")
            handler.load_file(file_path, force_reload=False)
        print(f"[mark_tissue_as_ground_truth] Handler patch_coordinates: {handler.patch_coordinates is not None}")
    
    if handler.patch_coordinates is None:
        return {"marked_count": 0, "message": "No patch coordinates found"}
    
    if not hasattr(handler, 'patch_class_id') or handler.patch_class_id is None:
        return {"marked_count": 0, "message": "No AI predictions found (patch classification not loaded)"}
    
    marked_count = 0
    marked_classes = {}  # Track how many of each class were marked
    
    try:
        with zarr.open(file_path, mode='a') as zf:
            # Ensure user_annotation group exists
            if 'user_annotation' not in zf:
                zf.create_group('user_annotation')
            
            user_anno_group = zf['user_annotation']
            
            # Get or create tissue_annotations (JSON format)
            if 'tissue_annotations' not in user_anno_group:
                # Create new scalar array for JSON
                annotations_dict = {}
                json_str = json.dumps(annotations_dict, ensure_ascii=False)
                encoded_bytes = json_str.encode('utf-8')
                # Create with initial size (will be resized if needed)
                initial_size = max(len(encoded_bytes) * 2, 1024)
                user_anno_group.create_dataset(
                    'tissue_annotations',
                    data=np.array(encoded_bytes, dtype=f'S{initial_size}'),
                    shape=(),
                    dtype=f'S{initial_size}'
                )
                array = user_anno_group['tissue_annotations']
            else:
                array = user_anno_group['tissue_annotations']
                # Read existing JSON
                if hasattr(array, 'shape') and array.shape == ():
                    raw_data = array[()]
                else:
                    raw_data = array[:]
                
                if isinstance(raw_data, bytes):
                    json_str = raw_data.decode('utf-8')
                elif isinstance(raw_data, np.ndarray):
                    if raw_data.dtype.kind == 'S' or raw_data.dtype.kind == 'U':
                        if raw_data.ndim == 0:
                            json_str = str(raw_data.item())
                        else:
                            json_str = str(raw_data.flat[0])
                        if isinstance(json_str, bytes):
                            json_str = json_str.decode('utf-8')
                    else:
                        json_str = '{}'
                elif isinstance(raw_data, str):
                    json_str = raw_data
                else:
                    json_str = str(raw_data)
                
                try:
                    annotations_dict = json.loads(json_str)
                except (json.JSONDecodeError, TypeError):
                    annotations_dict = {}
            
            if not isinstance(annotations_dict, dict):
                annotations_dict = {}
            
            # Get class names from handler or user_annotation metadata
            class_names = []
            if hasattr(handler, 'patch_class_name') and handler.patch_class_name is not None:
                class_names = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in handler.patch_class_name]
            elif hasattr(user_anno_group, 'attrs') and 'tissue_class_names' in user_anno_group.attrs:
                class_names_raw = user_anno_group.attrs['tissue_class_names']
                if isinstance(class_names_raw, (list, tuple)):
                    class_names = [str(name) for name in class_names_raw]
                elif isinstance(class_names_raw, np.ndarray):
                    class_names = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in class_names_raw]
            
            if not class_names:
                return {"marked_count": 0, "message": "No patch class names found"}
            
            # Get class colors (same as non-batch save_tissue: handler or user_annotation.attrs)
            class_colors = []
            if hasattr(handler, 'patch_class_hex_color') and handler.patch_class_hex_color is not None:
                class_colors = [c.decode('utf-8') if isinstance(c, bytes) else str(c) for c in handler.patch_class_hex_color]
            elif hasattr(user_anno_group, 'attrs') and 'tissue_class_colors' in user_anno_group.attrs:
                class_colors_raw = user_anno_group.attrs['tissue_class_colors']
                if isinstance(class_colors_raw, (list, tuple)):
                    class_colors = [str(c) for c in class_colors_raw]
            
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
            
            # Input bbox, polygon_points, and handler patch_coordinates share the same image coordinate space.
            
            # Get patch centroids from handler
            # NOTE: patch_coordinates format is [x1, y1, x2, y2] (top-left and bottom-right corners)
            patch_coords = handler.patch_coordinates
            patch_centroids = {}
            for i in range(len(patch_coords)):
                if len(patch_coords[i]) == 4:
                    px1, py1, px2, py2 = patch_coords[i]
                    cx = (px1 + px2) / 2
                    cy = (py1 + py2) / 2
                    patch_centroids[i] = (cx, cy)
            
            print(f"[mark_tissue_as_ground_truth] Input bbox: ({x1}, {y1}) to ({x2}, {y2})")
            print(f"[mark_tissue_as_ground_truth] Total patches: {len(patch_coords)}, with AI predictions: {np.sum(handler.patch_class_id >= 0)}")
            print(f"[mark_tissue_as_ground_truth] Existing user annotations: {len(annotations_dict)}")
            
            # Find patches in region that have AI predictions but are not yet user annotations
            patches_to_mark = []
            for patch_id in range(min(len(patch_coords), len(handler.patch_class_id))):
                # Check if this patch has AI prediction (patch_class_id >= 0)
                ai_class_id = handler.patch_class_id[patch_id]
                if ai_class_id < 0:
                    continue  # No AI prediction
                
                # Check if this patch is already a user annotation
                patch_id_str = str(patch_id)
                if patch_id_str in annotations_dict:
                    continue  # Already a user annotation, skip
                
                # Get patch centroid and check if in region
                if patch_id not in patch_centroids:
                    continue
                
                patch_x, patch_y = patch_centroids[patch_id]
                
                # Check if patch is in bounding box
                if not (x1 <= patch_x <= x2 and y1 <= patch_y <= y2):
                    continue
                
                # Check polygon if provided
                if polygon_points and not is_point_in_polygon(patch_x, patch_y, polygon_points):
                    continue
                
                # Mark as ground truth: save AI prediction as user annotation
                class_name = class_names[ai_class_id] if 0 <= ai_class_id < len(class_names) else 'Unknown'
                
                # Create annotation entry
                # IMPORTANT: Must include patch_ID field for training code to work
                # The training code expects annotations DataFrame to have a 'patch_ID' column
                # See: musk_classification_tasknode.py line 512: cell_indices = annotations['patch_ID'].astype(int).values
                # Format should match save_tissue() function for consistency
                now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                annotation_entry = {
                    'patch_ID': int(patch_id),  # CRITICAL: Required for training code
                    'tissue_class': class_name,
                    'annotator': 'ground_truth',  # Match save_tissue format
                    'datetime': now_str,  # Use same format as save_tissue (not isoformat)
                    'method': 'mark_as_ground_truth',
                    'region_geometry': {
                        'x1': int(x1),
                        'y1': int(y1),
                        'x2': int(x2),
                        'y2': int(y2)
                    }
                }
                
                annotations_dict[patch_id_str] = annotation_entry
                patches_to_mark.append(patch_id)
                marked_count += 1
                marked_classes[class_name] = marked_classes.get(class_name, 0) + 1
            
            print(f"[mark_tissue_as_ground_truth] Found {marked_count} AI-predicted patches to mark as ground truth")
            
            if marked_count > 0:
                # Write back to zarr (handle size expansion if needed)
                updated_json_str = json.dumps(annotations_dict, ensure_ascii=False)
                encoded_bytes = updated_json_str.encode('utf-8')
                
                if hasattr(array, 'shape') and array.shape == ():
                    # Scalar array - check if it fits
                    if hasattr(array, 'dtype') and array.dtype.kind == 'S':
                        max_len = array.dtype.itemsize
                        if len(encoded_bytes) > max_len:
                            # Need to resize
                            dataset_name = 'tissue_annotations'
                            new_size = int(len(encoded_bytes) * 1.5)
                            del user_anno_group[dataset_name]
                            user_anno_group.create_dataset(
                                dataset_name,
                                data=np.array(encoded_bytes, dtype=f'S{new_size}'),
                                shape=(),
                                dtype=f'S{new_size}'
                            )
                            print(f"[mark_tissue_as_ground_truth] Resized tissue_annotations from {max_len} to {new_size} bytes")
                        else:
                            array[()] = encoded_bytes
                    else:
                        array[()] = encoded_bytes
                else:
                    array[:] = encoded_bytes
                
                print(f"[mark_tissue_as_ground_truth] Written updated annotations to zarr")
                
                # Set user_annotation.attrs tissue_class_names and tissue_class_colors (same as non-batch save_tissue)
                # so downstream can use them (e.g. get_patch_classification, colormap)
                if class_names:
                    user_anno_group.attrs['tissue_class_names'] = [str(n) for n in class_names]
                if class_colors:
                    user_anno_group.attrs['tissue_class_colors'] = [str(c) for c in class_colors]
                
                # Update handler's tissue_annotations cache
                if handler:
                    for patch_id in patches_to_mark:
                        patch_id_str = str(patch_id)
                        if patch_id_str in annotations_dict:
                            handler.tissue_annotations[patch_id] = annotations_dict[patch_id_str]
                    
                    print(f"[mark_tissue_as_ground_truth] Updated handler.tissue_annotations cache for {len(patches_to_mark)} patches")
                    
                    # Clear viewport cache to ensure fresh data
                    if hasattr(handler, '_viewport_cache'):
                        handler._viewport_cache.clear()
                        print(f"[mark_tissue_as_ground_truth] Cleared viewport cache")
                
                # Update patch_class_counts
                try:
                    if 'patch_class_counts' in user_anno_group:
                        counts_dataset = user_anno_group['patch_class_counts']
                        if hasattr(counts_dataset, 'shape') and counts_dataset.shape == ():
                            counts_raw = counts_dataset[()]
                        else:
                            counts_raw = counts_dataset[:]
                        
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
                    
                    print(f"[mark_tissue_as_ground_truth] Updated patch_class_counts: {counts_dict}")
                    
                    # Save updated counts
                    counts_bytes = json.dumps(counts_dict, ensure_ascii=False).encode('utf-8')
                    if 'patch_class_counts' in user_anno_group:
                        existing_ds = user_anno_group['patch_class_counts']
                        if existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                            existing_ds[()] = counts_bytes
                        else:
                            del user_anno_group['patch_class_counts']
                            user_anno_group.create_dataset('patch_class_counts', data=counts_bytes)
                    else:
                        user_anno_group.create_dataset('patch_class_counts', data=counts_bytes)
                except Exception as e:
                    print(f"[mark_tissue_as_ground_truth] Warning: Failed to update patch_class_counts: {e}")
        
        print(f"[mark_tissue_as_ground_truth] Done - marked {marked_count} patches as ground truth")
        return {"marked_count": marked_count, "marked_classes": marked_classes}
    
    except Exception as e:
        print(f"[mark_tissue_as_ground_truth] Error: {e}")
        traceback.print_exc()
        raise ValueError(f"Failed to mark tissue as ground truth: {str(e)}")


class SegmentationHandler:
    BUFFER = 200

    def __init__(self, zarr_file_path=None):
        self.zarr_file = None
        self._zarr_file_obj = None  # Keep Zarr file object open for reuse
        self._zarr_synchronizer = None  # Keep synchronizer for reuse
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

        # Cache for viewport annotation results (OrderedDict for FIFO)
        self._viewport_cache = OrderedDict()
        self._cache_max_size = 100

        # Removed unnecessary caches for Zarr files
        self.annotation_colors = {
            "class_id": [],
            "class_name": [],
            "class_hex_color": []
        }
        self.nuclei_model_timestamp = None
        self.patch_model_timestamp = None

        # prefix
        self._nuclei_segmentation_prefix = "SegmentationNode"
        self._tissue_segmentation_prefix = "BiomedParseNode"
        self._classification_prefix = 'ClassificationNode'
        self._patch_classification_prefix = 'MuskNode'

        # Debounce reloads to avoid thrashing on rapid requests
        self._last_load_time = 0.0
        self._min_reload_interval = 0.2
        
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

    def reset_data(self):
        """Reset all data when switching to a new image."""
        # Save current file path before resetting
        current_file_path = self.zarr_file
        
        # Reset all attributes
        self.zarr_file = None
        # Clear viewport cache when resetting data
        self._viewport_cache.clear()
        self.centroids = None
        self.contours = None
        self.tissues = None
        self.probabilities = None
        self.annotations_data = {}
        self.tissue_annotations = {}
        self.patch_coordinates = None
        self.kd_tree = None
        self.class_id = None
        self.class_name = None
        self.class_hex_color = None
        self.annotation_colors = {
            "class_id": [],
            "class_name": [],
            "class_hex_color": []
        }
        
        # Clear caches
        self._user_annotation_counts_cache = None
        self._last_load_time = 0.0
        
        # If there was a file path, reload the data after reset
        if current_file_path and os.path.exists(current_file_path):
            try:
                print(f"[Debug] reset_data => Reloading data from {current_file_path} after reset")
                self.load_file(current_file_path, force_reload=True, reload_segmentation_data=True)
            except Exception as e:
                print(f"[Warning] reset_data => Failed to reload data after reset: {e}")
        
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
            print(f"[Debug] _normalize_class_id_length => normalized class_id from {current_len} to {num_cells}")
        except Exception as e:
            print(f"[Warn] _normalize_class_id_length => {e}")

        # Reset patch-related attributes
        self.patch_coordinates = None
        self.patch_centroids = None
        self.patch_class_id = None
        self.patch_class_name = None
        self.patch_class_hex_color = None
        self._whole_slide_counts_cache = None
        self._patch_annotation_counts_cache = None
        
        # No cache to clear

    def _create_zarr_synchronizer(self, zarr_file_path: str = None):
        """
        Create or get a cached thread-safe synchronizer for Zarr file operations.
        Uses cached synchronizer to ensure same file uses same instance.
        
        Args:
            zarr_file_path: Path to the Zarr file. If None, uses self.zarr_file.
        
        Returns:
            ThreadSynchronizer or ProcessSynchronizer instance (cached per file path)
        """
        from app.services.data import get_zarr_synchronizer
        file_path = zarr_file_path or self.zarr_file
        if file_path:
            return get_zarr_synchronizer(file_path)
        else:
            # Fallback if no file path available
            return ThreadSynchronizer()

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
                    print(f"[Debug] update_class_definitions => Updated color for class '{name}': {ui_colors[i]}")

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
        # This avoids unnecessary reloads when:
        # 1. Same file is already loaded
        # 2. We don't need to reload segmentation data (centroids/contours)
        # 3. File hasn't been modified (no force_reload flag)
        if self.zarr_file == zarr_file_path:
            # If we don't need to reload segmentation data and file is already loaded, skip
            if not reload_segmentation_data and not force_reload:
                # Check if we have the minimum required data (zarr_file is set and file exists)
                if (self._zarr_file_obj is not None) or (self.zarr_file and os.path.exists(self.zarr_file)):
                    return
            
            # Throttle rapid consecutive reload requests
            now = time.time()
            last = getattr(self, '_last_load_time', 0.0)
            min_interval = getattr(self, '_min_reload_interval', 0.2)
            needs_reload = getattr(self, '_needs_reload', False)
            if (now - last) < min_interval and not needs_reload and not reload_segmentation_data and not force_reload:
                return

        # Clear caches
        # Removed unnecessary caches for Zarr files
        self._user_annotation_counts_cache = None
        # IMPORTANT: Also clear global label counts cache to ensure fresh data after reload
        self._global_label_counts_cache = None

        # Close old Zarr file if switching to a new file
        if self.zarr_file != zarr_file_path and self._zarr_file_obj is not None:
            try:
                # Zarr files don't need explicit close, but we should clear the reference
                self._zarr_file_obj = None
                self._zarr_synchronizer = None
            except Exception as e:
                logger.warning(f"Exception occurred while clearing Zarr file references: {e}")

        self.zarr_file = zarr_file_path
        
        # Load data directly from Zarr file - no cache needed
        if not os.path.exists(zarr_file_path):
            raise FileNotFoundError(f"Zarr file not found: {zarr_file_path}")
        
        # Check file permissions
        if not os.access(zarr_file_path, os.R_OK):
            error_msg = f"Zarr file is not readable (permission denied): {zarr_file_path}"
            print(f"[ERROR] load_file => {error_msg}")
            print(f"[ERROR] load_file => File permissions: {oct(os.stat(zarr_file_path).st_mode)}")
            raise PermissionError(error_msg)
        
        # Open Zarr file and keep it open for reuse (read-only mode is safe to keep open)
        if self._zarr_synchronizer is None:
            from app.services.data import get_zarr_synchronizer
            self._zarr_synchronizer = get_zarr_synchronizer(zarr_file_path)
        
        # Open file and keep reference (read-only mode, safe to keep open)
        if self._zarr_file_obj is None or self.zarr_file != zarr_file_path:
            self._zarr_file_obj = zarr.open(zarr_file_path, 'r', synchronizer=self._zarr_synchronizer)
        
        try:
            zarr_file = self._zarr_file_obj
            
            # Get prefixes for data organization
            classification_prefix = self.get_classification_prefix()
            patch_prefix = self.get_patch_classification_prefix()

            # Only reload centroids and contours if reload_segmentation_data is True
            if reload_segmentation_data:
                # Check SegmentationNode group structure
                if 'SegmentationNode' in zarr_file:
                    seg_group = zarr_file['SegmentationNode']
                    
                    # Look for centroids and contours in SegmentationNode group
                    if 'centroids' in seg_group:
                        self.centroids = np.array(seg_group['centroids'])
                    else:
                        self.centroids = None
                    
                    # Look for contours with lazy loading optimization
                    if 'contours' in seg_group:
                        # Don't load all contours into memory for large datasets (>50k cells)
                        # Keep zarr reference for lazy loading
                        contour_shape = seg_group['contours'].shape
                        
                        if contour_shape[0] > 50000:
                            # Large dataset: keep zarr reference for lazy loading
                            self.contours = seg_group['contours']  # Keep zarr array reference
                        else:
                            # Small dataset: load into memory
                            self.contours = np.array(seg_group['contours'])
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

                    # Prefer metadata attributes (current format) over datasets (legacy format)
                    loaded_from_metadata = False
                    if metadata_class_names and metadata_class_colors:
                        self.class_name = np.array(metadata_class_names)
                        self.class_hex_color = np.array(metadata_class_colors)
                        loaded_from_metadata = True

                        # Prepare nuclei_class_id with default; will try to populate from group datasets next
                        # BUT: If class_id already exists and is populated (not all -1), preserve it
                        # This prevents overwriting annotations that were just applied
                        if self.class_id is None or (self.centroids is not None and len(self.class_id) != len(self.centroids)):
                            # Need to initialize or resize
                            if self.centroids is not None:
                                self.class_id = np.full(len(self.centroids), -1, dtype=int)
                            else:
                                self.class_id = np.array([-1])
                        elif self.centroids is not None and np.any(self.class_id >= 0):
                            # class_id exists and is populated, don't overwrite it
                            print(f"[Debug] load_file => Preserving existing class_id (has {np.sum(self.class_id >= 0)} annotations)")
                        # If class_id exists and is all -1, we'll try to populate from datasets below

                        # Even when using metadata for classes, attempt to load per-cell assignments from datasets
                        # BUT: Only load if class_id is not already populated (all -1)
                        try:
                            # Check if class_id needs to be populated
                            needs_population = (self.class_id is None or 
                                              (self.centroids is not None and len(self.class_id) == len(self.centroids) and 
                                               not np.any(self.class_id >= 0)))
                            
                            if needs_population:
                                # Prefer numeric IDs if available
                                if 'nuclei_class_id' in group:
                                    self.class_id = np.array(group['nuclei_class_id'][:], dtype=int)
                                else:
                                    # Fallbacks: try string label datasets then map via metadata class_names
                                    for label_key in ['nuclei_class', 'labels', 'cell_class', 'nucleus_class', 'nuclei_labels']:
                                        if label_key in group:
                                            raw_labels = group[label_key][:]
                                            labels = [lbl.decode('utf-8') if isinstance(lbl, (bytes, bytearray)) else str(lbl) for lbl in raw_labels]
                                            name_to_idx = {name: i for i, name in enumerate(self.class_name)}
                                            self.class_id = np.array([name_to_idx.get(label, -1) for label in labels], dtype=int)
                                            break
                            else:
                                print(f"[Debug] load_file => Skipping ClassificationNode dataset load, class_id already populated")
                        except Exception as e:
                            print(f"[Warn] load_file => Failed populating nuclei_class_id from ClassificationNode datasets: {e}")
                        # Ensure length alignment
                        self._normalize_class_id_length()

                    # Fallback: Check for legacy dataset format only if metadata is not available
                    try:
                        if 'nuclei_class_name' in group:
                            raw_names = group['nuclei_class_name'][:]
                            self.class_name = np.array([n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n) for n in raw_names])
                        if 'nuclei_class_HEX_color' in group:
                            raw_colors = group['nuclei_class_HEX_color'][:]
                            self.class_hex_color = np.array([c.decode('utf-8') if isinstance(c, (bytes, bytearray)) else str(c) for c in raw_colors])
                        if 'nuclei_class_id' in group:
                            self.class_id = np.array(group['nuclei_class_id'][:])
                    except Exception as e:
                        print(f"[Warn] load_file => Failed reading classification datasets: {e}")

                    # Decide whether we should skip root-level dataset loading.
                    # If we successfully loaded from metadata OR from group datasets,
                    # do not attempt root-level (flattened) keys to avoid overwriting.
                    loaded_from_group_datasets = (
                        ('nuclei_class_name' in group) or
                        ('nuclei_class_HEX_color' in group) or
                        ('nuclei_class_id' in group)
                    )

                    if loaded_from_metadata:
                        skip_dataset_loading = True
                    elif loaded_from_group_datasets or (self.class_id is not None and self.class_name is not None):
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
                        if 'user_annotation' in zarr_file:
                            user_ann_group = zarr_file['user_annotation']
                            
                            # Check if nuclei_annotations contains class_id information
                            if 'nuclei_annotations' in user_ann_group:
                                try:
                                    nuclei_ann_data = user_ann_group['nuclei_annotations'][()]
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
                                                        cell_class = annotation_data.get('cell_class')
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
            
            # Load patch data
            patch_coords_key = f'{patch_prefix}_coordinates'
            if patch_coords_key in zarr_file:
                self.patch_coordinates = np.array(zarr_file[patch_coords_key])
            elif patch_prefix in zarr_file and 'coordinates' in zarr_file[patch_prefix]:
                # Try loading from group structure (e.g., MuskNode/coordinates)
                self.patch_coordinates = np.array(zarr_file[patch_prefix]['coordinates'])
                
                # Also load patch classification data from the same group
                # Check attributes first (new format), then fallback to datasets (old format)
                if patch_prefix in zarr_file:
                    patch_group = zarr_file[patch_prefix]
                    # Check attributes format first
                    if hasattr(patch_group, 'attrs') and 'tissue_class_name' in patch_group.attrs:
                        self.patch_class_name = np.array(patch_group.attrs.get('tissue_class_name', []))
                        # Try to get colors from attrs first
                        if 'tissue_class_HEX_color' in patch_group.attrs:
                            self.patch_class_hex_color = np.array(patch_group.attrs.get('tissue_class_HEX_color', []))
                        # Fallback: try to load colors from userData if not in attrs
                        elif 'userData' in patch_group and 'tissue_colors' in patch_group['userData']:
                            try:
                                tissue_colors_raw = patch_group['userData']['tissue_colors'][()]
                                if isinstance(tissue_colors_raw, bytes):
                                    tissue_colors = json.loads(tissue_colors_raw.decode('utf-8'))
                                else:
                                    tissue_colors = json.loads(tissue_colors_raw) if isinstance(tissue_colors_raw, str) else tissue_colors_raw
                                self.patch_class_hex_color = np.array(tissue_colors) if isinstance(tissue_colors, list) else np.array([tissue_colors])
                                print(f"[Debug] Loaded patch colors from userData: {self.patch_class_hex_color}")
                            except Exception as e:
                                print(f"[Warning] Failed to load colors from userData: {e}")
                                self.patch_class_hex_color = None
                        else:
                            self.patch_class_hex_color = None
                        
                        if 'tissue_class_id' in patch_group.attrs:
                            self.patch_class_id = np.array(patch_group.attrs.get('tissue_class_id', []))
                        elif len(self.patch_class_name) > 0:
                            # Generate IDs from indices if not present
                            self.patch_class_id = np.array(list(range(len(self.patch_class_name))))
                    # Fallback to dataset format
                    elif 'tissue_class_name' in patch_group and 'tissue_class_HEX_color' in patch_group and 'tissue_class_id' in patch_group:
                        self.patch_class_name = np.array([name.decode('utf-8') if isinstance(name, (bytes, bytearray)) else str(name) for name in patch_group['tissue_class_name'][:]])
                        self.patch_class_hex_color = np.array([color.decode('utf-8') if isinstance(color, (bytes, bytearray)) else str(color) for color in patch_group['tissue_class_HEX_color'][:]])
                        self.patch_class_id = np.array(patch_group['tissue_class_id'][:])
            else:
                # Try alternative key names
                for alt_key in ['patch_coordinates', 'patch_coords', 'patches']:
                    if alt_key in zarr_file:
                        self.patch_coordinates = np.array(zarr_file[alt_key])
                        break
                else:
                    self.patch_coordinates = None
            
            # Load other data
            if 'tissues' in zarr_file:
                self.tissues = np.array(zarr_file['tissues']).tolist()
            else:
                self.tissues = []
            
            if 'annotations_data' in zarr_file:
                self.annotations_data = dict(zarr_file['annotations_data'])
            else:
                self.annotations_data = {}
            
            if 'tissue_annotations' in zarr_file:
                self.tissue_annotations = dict(zarr_file['tissue_annotations'])
            else:
                self.tissue_annotations = {}
            
            # Build KD tree if centroids and contours are available (only if reload_segmentation_data is True)
            if reload_segmentation_data:
                if self.centroids is not None and self.contours is not None:
                    try:
                        # Ensure centroids is a numpy array with correct shape
                        if not isinstance(self.centroids, np.ndarray):
                            self.centroids = np.array(self.centroids)
                        
                        # Check if centroids has the right shape (N, 2)
                        if len(self.centroids.shape) != 2 or self.centroids.shape[1] != 2:
                            print(f"[Error] load_file => Invalid centroids shape: {self.centroids.shape}, expected (N, 2)")
                            self.kd_tree = None
                        else:
                            # Check for any NaN or infinite values
                            if np.any(np.isnan(self.centroids)) or np.any(np.isinf(self.centroids)):
                                print(f"[Error] load_file => Centroids contain NaN or infinite values")
                                self.kd_tree = None
                            else:
                                self.kd_tree = KDTree(self.centroids)
                    except Exception as e:
                        print(f"[Error] load_file => Failed to build KD tree: {e}")
                        print(f"[Error] load_file => Centroids info - shape: {self.centroids.shape if hasattr(self.centroids, 'shape') else 'no shape'}, dtype: {self.centroids.dtype if hasattr(self.centroids, 'dtype') else 'no dtype'}")
                        print(f"[Error] load_file => Traceback: {traceback.format_exc()}")
                        self.kd_tree = None
                else:
                    self.kd_tree = None
            else:
                # Ensure KD tree exists if centroids are available
                if self.kd_tree is None and self.centroids is not None:
                    try:
                        if not isinstance(self.centroids, np.ndarray):
                            self.centroids = np.array(self.centroids)
                        if len(self.centroids.shape) == 2 and self.centroids.shape[1] == 2:
                            if not (np.any(np.isnan(self.centroids)) or np.any(np.isinf(self.centroids))):
                                self.kd_tree = KDTree(self.centroids)
                    except Exception as e:
                        print(f"[Warning] load_file => Failed to build KD tree from existing centroids: {e}")
            
            # Manual nuclei annotations are now applied earlier in the method
            
            # Update annotation colors if classification data is available
            if self.class_id is not None and self.class_name is not None and self.class_hex_color is not None:
                self.annotation_colors = {
                    "class_id": self.class_id.tolist() if hasattr(self.class_id, 'tolist') else self.class_id,
                    "class_name": self.class_name.tolist() if hasattr(self.class_name, 'tolist') else self.class_name,
                    "class_hex_color": self.class_hex_color.tolist() if hasattr(self.class_hex_color, 'tolist') else self.class_hex_color
                }
            
            # Load manual tissue annotations if they exist
            self._apply_manual_patch_annotations(zarr_file)
            
            # Update last load time
            self._last_load_time = time.time()

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
        
        print(f"[Debug] refresh_annotations => Refreshing annotations only (skipping centroids/contours)")
        # Clear annotation cache
        self._user_annotation_counts_cache = None
        
        try:
            # Only reload annotations-related data, not centroids/contours
            # Set _needs_reload=True to ensure annotations are applied even if class_id is None
            # Use force_reload=False to respect debounce interval (0.2s) for rapid consecutive calls
            # This prevents performance issues when refresh_annotations is called multiple times quickly
            self._needs_reload = True
            self.load_file(self.zarr_file, force_reload=False, reload_segmentation_data=False)
            print(f"[Debug] refresh_annotations => Successfully refreshed annotations")
        except Exception as e:
            print(f"[ERROR] refresh_annotations => Error refreshing annotations: {e}")
            print(f"[ERROR] refresh_annotations => Full traceback: {traceback.format_exc()}")
            raise
    def _apply_manual_patch_annotations(self, zarr_file):
        print("[Debug] Applying manual patch annotations...")
        if 'user_annotation' not in zarr_file or 'tissue_annotations' not in zarr_file['user_annotation']:
            print("[Debug] No manual tissue annotations found in Zarr file.")
            return

        try:
            raw_bytes = zarr_file['user_annotation/tissue_annotations'][()]
            manual_annotations = json.loads(raw_bytes.decode("utf-8"))
        except Exception as e:
            print(f"[Error] Failed to load or parse manual annotations: {e}")
            return
            
        if not manual_annotations:
            print("[Debug] Manual annotations are empty.")
            return

        # Scenario 1: No model data exists, initialize everything from manual annotations
        if self.patch_class_name is None:
            print("[Debug] No model classification found. Initializing from manual annotations.")
            
            if self.patch_coordinates is None:
                print("[Error] Cannot apply manual annotations without patch coordinates. Aborting.")
                return

            # Create a mapping from class name to a new integer ID (exclude negative selection entries with tissue_class None)
            all_manual_classes = sorted(list(set(item['tissue_class'] for item in manual_annotations.values() if item.get('tissue_class') is not None)))
            
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

            print(f"[Debug] Initialized with classes: {self.patch_class_name}")
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

            class_name = annotation.get("tissue_class")

            if class_name is None:
                continue

            # Check if the manually annotated class exists in our current list.
            if class_name not in class_to_id_map:
                print(f"[Debug] New class '{class_name}' found in manual annotations. Adding to list.")
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
                # print(f"[Debug] Overrode patch {patch_id} with class '{class_name}' (ID: {target_class_id})")
            else:
                print(f"[Warning] Manual annotation patch_ID {patch_id} is out of bounds.")
        
        # Update self.tissue_annotations with the loaded manual annotations
        self.tissue_annotations = manual_annotations
        print(f"[Debug] Updated self.tissue_annotations with {len(manual_annotations)} manual annotations.")
        
        print("[Debug] Finished applying manual patch annotations.")
        
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
        if 'user_annotation' not in zarr_file:
            return None if not return_non_empty_indices else (None, None)
        
        user_annotation_group = zarr_file['user_annotation']
        base_name = 'nuclei_annotations'
        
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
                
                # Optimized loading for large arrays
                # For large arrays, minimize memory operations and use direct field access
                # Zarr's field access [:] already returns numpy array, no need for np.asarray
                result = np.empty(array_size, dtype=dtype_list)
                for field in fields:
                    if field in annotations_dataset.dtype.names:
                        # Direct field access - Zarr only loads this field's chunks
                        # For large arrays, Zarr handles chunking, decompression, and caching efficiently
                        # Using [:] triggers optimized full-array read in Zarr
                        # Direct assignment avoids intermediate copies
                        result[field] = annotations_dataset[field][:]
                
                return result if not return_non_empty_indices else (result, None)
            else:
                # Load entire structured array (slower but complete)
                manual_annotations = np.array(annotations_dataset[:])
                return manual_annotations if not return_non_empty_indices else (manual_annotations, None)
        except Exception as e:
            print(f"[Error] Failed to load structured array format annotations: {e}")
            return None if not return_non_empty_indices else (None, None)
    
    def _apply_manual_nuclei_annotations(self, zarr_file):
        # Always apply manual annotations to ensure handler state is synchronized with Zarr file
            
        if 'user_annotation' not in zarr_file:
            print("[Debug] No user_annotation group found in Zarr file.")
            return
        
        # Load structured array directly (no dict conversion for performance)
        # Load both cell_class and cell_color to check for unclassified cells (cell_class=0 with empty color)
        load_result = self._load_annotations_array(zarr_file, fields=['cell_class', 'cell_color'], return_non_empty_indices=True)
        if isinstance(load_result, tuple):
            manual_annotations, original_indices = load_result
        else:
            manual_annotations = load_result
            original_indices = None
        
        if manual_annotations is None or len(manual_annotations) == 0:
            print("[Debug] No manual annotations found.")
            # Initialize default classification data if none exists
            if self.class_name is None and self.centroids is not None:
                print("[Debug] Initializing default classification data.")
                self.class_name = ["Negative control"]
                self.class_hex_color = ["#aaaaaa"]
                self.class_id = np.full(len(self.centroids), -1, dtype=int)
                print(f"[Debug] Initialized with default classes: {self.class_name}")
            return

        # Get cell class data (direct field access, no copy)
        # For structured arrays, field access is O(1) and doesn't copy data
        cell_class_data = manual_annotations['cell_class']
        
        # Also check cell_color to ensure we only count cells with actual annotations
        # A cell with cell_class=0 but empty cell_color should be treated as unclassified (-1)
        cell_color_data = None
        if 'cell_color' in manual_annotations.dtype.names:
            cell_color_data = manual_annotations['cell_color']
        
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
        class_names_from_metadata = None
        if 'user_annotation' in zarr_file:
            user_annotation_group = zarr_file['user_annotation']
            if 'class_names' in user_annotation_group.attrs:
                class_names_from_metadata = user_annotation_group.attrs.get('class_names', [])
        
        if not np.any(non_empty_mask):
            print("[Debug] No non-empty annotations found.")
            if self.class_name is None and self.centroids is not None:
                self.class_name = ["Negative control"]
                self.class_hex_color = ["#aaaaaa"]
                self.class_id = np.full(len(self.centroids), -1, dtype=int)
            return

        # Scenario 1: No model data exists, initialize everything from manual annotations
        # OR: class_name exists but class_id is not properly initialized (e.g., after reset)
        if self.class_name is None or self.class_id is None or (self.centroids is not None and len(self.class_id) != len(self.centroids)):
            if self.class_name is None:
                print("[Debug] No model classification found. Initializing from manual annotations.")
            else:
                print(f"[Debug] class_name exists but class_id not properly initialized (class_id={self.class_id is not None}, len={len(self.class_id) if self.class_id is not None else 0}, centroids_len={len(self.centroids) if self.centroids is not None else 0}). Initializing class_id.")
            
            if self.centroids is None:
                print("[Error] Cannot apply manual annotations without centroids data. Aborting.")
                return

            # If class_name already exists (from ClassificationNode), use it; otherwise extract from annotations
            if self.class_name is None:
                # Use class_names from metadata
                if class_names_from_metadata:
                    self.class_name = ["Negative control"] + [name for name in class_names_from_metadata if name != "Negative control"]
                    # Get colors from metadata
                    if 'user_annotation' in zarr_file:
                        user_annotation_group = zarr_file['user_annotation']
                        if 'class_colors' in user_annotation_group.attrs:
                            class_colors_from_metadata = user_annotation_group.attrs.get('class_colors', [])
                            # Map colors to class names
                            color_map = dict(zip(class_names_from_metadata, class_colors_from_metadata))
                            self.class_hex_color = ["#aaaaaa"]  # Negative control color
                            for name in class_names_from_metadata:
                                if name != "Negative control":
                                    self.class_hex_color.append(color_map.get(name, "#808080"))
                        else:
                            self.class_hex_color = ["#aaaaaa"] + ["#808080"] * (len(self.class_name) - 1)
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
                    print(f"[Debug] Initializing class_hex_color to match class_name (len={len(self.class_name)})")
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
                    
                    # Get colors from metadata for new classes
                    class_colors_from_metadata = []
                    if 'user_annotation' in zarr_file:
                        user_annotation_group = zarr_file['user_annotation']
                        if 'class_colors' in user_annotation_group.attrs:
                            class_colors_from_metadata = user_annotation_group.attrs.get('class_colors', [])
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
                        print(f"[Debug] Merged user-added classes from metadata: {classes_added}")

            # Default all nuclei to UNCLASSIFIED (-1) until explicitly annotated
            self.class_id = np.full(len(self.centroids), -1, dtype=int)
            
            print(f"[Debug] Initialized class_id with length {len(self.class_id)} to match centroids")
        else:
            # Scenario 2: Both class_name and class_id exist with correct lengths
            # Still need to merge user-added classes from metadata to ensure consistency
            if class_names_from_metadata:
                current_names = list(self.class_name)
                current_colors = list(self.class_hex_color) if self.class_hex_color is not None else []
                
                # Get colors from metadata for new classes
                class_colors_from_metadata = []
                if 'user_annotation' in zarr_file:
                    user_annotation_group = zarr_file['user_annotation']
                    if 'class_colors' in user_annotation_group.attrs:
                        class_colors_from_metadata = user_annotation_group.attrs.get('class_colors', [])
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
                    print(f"[Debug] Merged user-added classes from metadata (existing model data): {classes_added}")

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
                print(f"[Debug] Reset detected: original_indices size={len(original_indices)}, valid_indices max={valid_indices.max() if len(valid_indices) > 0 else 0}. Recalculating valid_indices.")
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
                    print(f"[Debug] Filtered out {np.sum(~valid_mask)} out-of-bounds indices")
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
            if 'user_annotation' in zarr_file:
                user_annotation_group = zarr_file['user_annotation']
                if 'nuclei_annotations' in user_annotation_group:
                    try:
                        datetime_data = user_annotation_group['nuclei_annotations']['datetime'][:]
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
                    print(f"[Debug] Metadata has no 'Negative control' but handler does. Offsetting class_ids by +1")
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
        
        # Negative selection ("No" type): cell_class <= -2 means exclude from that class.
        # Do not change class_id for those cells — keep original color; prediction will update when model runs.

        # Convert back to numpy arrays
        self.class_name = np.array(class_name_list)
        self.class_hex_color = np.array(class_hex_color_list)
        
        # Cache mechanism removed - always process annotations
        
        # Auto-create ClassificationNode if it doesn't exist and we have classification data
        print(f"[Debug] Checking if ClassificationNode should be created: class_name={self.class_name is not None}, class_hex_color={self.class_hex_color is not None}, len={len(self.class_name) if self.class_name is not None else 0}")
        
        if self.class_name is not None and self.class_hex_color is not None and len(self.class_name) > 0:
            try:
                zarr_file_path = self.get_current_file_path()
                print(f"[Debug] Attempting to create ClassificationNode in: {zarr_file_path}")
                
                # Create synchronizer for thread-safe access (use cached synchronizer)
                synchronizer = self._create_zarr_synchronizer(zarr_file_path)
                
                with zarr.open(zarr_file_path, 'a', synchronizer=synchronizer) as zf:
                    if 'ClassificationNode' not in zf:
                        print("[Debug] Creating ClassificationNode from manual annotations")
                        classification_group = zf.create_group('ClassificationNode')
                        
                        # Store class information as group attributes
                        classification_group.attrs['class_names'] = [str(name) for name in self.class_name]
                        classification_group.attrs['class_colors'] = [str(color) for color in self.class_hex_color]
                        classification_group.attrs['path'] = str(zarr_file_path)
                        classification_group.attrs['last_updated'] = time.time()
                        
                        # nuclei_class_id is not stored in ClassificationNode attributes
                        # It is dynamically extracted from user_annotation/nuclei_annotations when needed
                        
                        print(f"[Debug] Created ClassificationNode with {len(self.class_name)} classes: {self.class_name}")
                        print(f"[Debug] Created ClassificationNode with colors: {self.class_hex_color}")
                    else:
                        print("[Debug] ClassificationNode already exists")
            except Exception as e:
                print(f"[Debug] Failed to create ClassificationNode: {e}")
                traceback.print_exc()
        else:
            print("[Debug] ClassificationNode creation skipped - missing classification data")
        
        print("[Debug] Finished applying manual nuclei annotations.")

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
        """get patch classification result"""
        patch_class_id_instances = getattr(self, 'patch_class_id', None)
        patch_class_name = getattr(self, 'patch_class_name', None)
        patch_class_hex_color = getattr(self, 'patch_class_hex_color', None)

        processed_class_name = patch_class_name
        processed_class_hex_color = patch_class_hex_color

        if processed_class_name is not None:
            if hasattr(processed_class_name, 'tolist'):
                processed_class_name = processed_class_name.tolist()
            if isinstance(processed_class_name, list):
                # Decode bytes to utf-8 if necessary
                processed_class_name = [item.decode('utf-8') if isinstance(item, bytes) else str(item) for item in processed_class_name]
            elif isinstance(processed_class_name, bytes):
                processed_class_name = [processed_class_name.decode('utf-8')]
            else:
                processed_class_name = [str(processed_class_name)]
        else:
            processed_class_name = []

        if processed_class_hex_color is not None:
            if hasattr(processed_class_hex_color, 'tolist'):
                processed_class_hex_color = processed_class_hex_color.tolist()
            if isinstance(processed_class_hex_color, list):
                # Decode bytes to utf-8 if necessary
                processed_class_hex_color = [item.decode('utf-8') if isinstance(item, bytes) else str(item) for item in processed_class_hex_color]
            elif isinstance(processed_class_hex_color, bytes):
                processed_class_hex_color = [processed_class_hex_color.decode('utf-8')]
            else:
                processed_class_hex_color = [str(processed_class_hex_color)]
        else:
            processed_class_hex_color = []

        # The defined class IDs are the indices of the class name array
        defined_class_ids = list(range(len(processed_class_name)))

        # Load counts and colors from user_annotation (priority source)
        class_counts = [0] * len(processed_class_name)
        try:
            # Direct loading from Zarr file (no cache)
            if self.zarr_file and os.path.exists(self.zarr_file):
                with zarr.open(self.zarr_file, 'r') as zarr_file:
                    if 'user_annotation' in zarr_file:
                        user_anno_group = zarr_file['user_annotation']
                        
                        # Priority: Load colors from user_annotation.attrs['tissue_class_colors']
                        if 'tissue_class_colors' in user_anno_group.attrs and 'tissue_class_names' in user_anno_group.attrs:
                            user_tissue_class_names = list(user_anno_group.attrs.get('tissue_class_names', []))
                            user_tissue_colors = list(user_anno_group.attrs.get('tissue_class_colors', []))
                            
                            # Create a mapping from class name to color
                            name_to_color = {
                                (name.decode('utf-8') if isinstance(name, bytes) else str(name)): 
                                (color.decode('utf-8') if isinstance(color, bytes) else str(color))
                                for name, color in zip(user_tissue_class_names, user_tissue_colors)
                            }
                            
                            # Update processed_class_hex_color with colors from user_annotation
                            # Match by class name
                            updated_colors = []
                            for idx, class_name in enumerate(processed_class_name):
                                if class_name in name_to_color:
                                    updated_colors.append(name_to_color[class_name])
                                else:
                                    # Keep existing color if not found in user_annotation
                                    if idx < len(processed_class_hex_color):
                                        updated_colors.append(processed_class_hex_color[idx])
                                    else:
                                        updated_colors.append("#aaaaaa")
                            
                            if len(updated_colors) == len(processed_class_name):
                                processed_class_hex_color = updated_colors
                                print(f"[get_patch_classification] Loaded {len(updated_colors)} colors from user_annotation.attrs")
                        
                        # Load counts from patch_class_counts
                        if 'patch_class_counts' in user_anno_group:
                            counts_dataset = user_anno_group['patch_class_counts']
                            # Handle scalar array (0-dimensional)
                            if hasattr(counts_dataset, 'shape') and counts_dataset.shape == ():
                                raw_data = counts_dataset[()]
                            else:
                                raw_data = counts_dataset[:]
                            
                            if isinstance(raw_data, bytes):
                                counts_dict = json.loads(raw_data.decode('utf-8'))
                            elif isinstance(raw_data, str):
                                counts_dict = json.loads(raw_data)
                            elif isinstance(raw_data, dict):
                                counts_dict = raw_data
                            else:
                                # Try to decode if it's a numpy array
                                if isinstance(raw_data, np.ndarray):
                                    if raw_data.dtype.kind == 'S' or raw_data.dtype.kind == 'U':
                                        if raw_data.ndim == 0:
                                            json_str = str(raw_data.item())
                                        else:
                                            json_str = str(raw_data.flat[0])
                                        if isinstance(json_str, bytes):
                                            json_str = json_str.decode('utf-8')
                                        counts_dict = json.loads(json_str)
                                    else:
                                        counts_dict = {}
                                else:
                                    counts_dict = {}

                            print(f"[get_patch_classification] Loaded patch_class_counts dict: {counts_dict}")
                            name_to_id = {name: i for i, name in enumerate(processed_class_name)}
                            for name, count in counts_dict.items():
                                if name in name_to_id:
                                    class_counts[name_to_id[name]] = int(count) if isinstance(count, (int, float)) else 0
                                    print(f"[get_patch_classification] Mapped '{name}' (count={count}) to index {name_to_id[name]}")
                            print(f"[get_patch_classification] Final class_counts array: {class_counts}")
        except Exception as e:
            print(f"Could not load patch_class_counts or colors from user_annotation, using defaults. Error: {e}")
            traceback.print_exc()
            # Fallback to defaults is the default behavior now

        # Final check to ensure all lists have same length as class_name list
        # This can happen if Zarr file is inconsistent
        num_classes = len(processed_class_name)
        if len(defined_class_ids) != num_classes: defined_class_ids = list(range(num_classes))
        if len(processed_class_hex_color) != num_classes: processed_class_hex_color = ["#aaaaaa"] * num_classes
        if len(class_counts) != num_classes: class_counts = [0] * num_classes

        return defined_class_ids, processed_class_name, processed_class_hex_color, class_counts
    
    def get_current_file_path(self):
        if self.zarr_file:
            return self.zarr_file
        return None

    def clear_annotations_cache(self):
        self.annotations_data = {}
        self.tissue_annotations = {}
    
    #   classification
    def get_cell_classification_data(self):
        # Only load if handler doesn't have data
        if self.centroids is None or self.zarr_file is None:
            self.load_file(self.get_current_file_path(), force_reload=False, reload_segmentation_data=False)

        # If there are no base classifications from the Zarr file, there's nothing to return.
        if self.class_id is None or self.class_name is None or self.class_hex_color is None:
            return None

        effective_class_ids = np.copy(self.class_id)

        # Apply active learning reclassifications if available
        try:
            from app.services.review import _reclassified_cells
            zarr_path = self.get_current_file_path()
            
            if zarr_path in _reclassified_cells:
                reclassified_data = _reclassified_cells[zarr_path]

                # Convert class names to IDs for reclassification
                class_name_to_id = {name: idx for idx, name in enumerate(self.class_name)}

                for cell_id_str, reclassify_info in reclassified_data.items():
                    try:
                        cell_id = int(cell_id_str)
                        new_class_name = reclassify_info["new_class"]

                        if cell_id < len(effective_class_ids) and new_class_name in class_name_to_id:
                            new_class_id = class_name_to_id[new_class_name]
                            old_class_id = effective_class_ids[cell_id]
                            effective_class_ids[cell_id] = new_class_id
                    except (ValueError, KeyError) as e:
                        continue
        except Exception as e:
            logger.error(f"Error applying active learning reclassifications: {e}", exc_info=True)

        # Build names and colors
        # Priority: user_annotation.attrs['class_names'] and ['class_colors'] (most up-to-date, updated by delete_class) 
        # > self.class_name and self.class_hex_color (loaded from file, may be stale)
        # > ClassificationNode.attrs['class_colors'] (from task node)
        names_out = [str(name) for name in self.class_name] if self.class_name is not None else []
        colors_out = [str(color) for color in self.class_hex_color] if self.class_hex_color is not None else []
        
        # Try to get names and colors from user_annotation metadata first (most up-to-date, includes deletions)
        try:
            if self._zarr_file_obj is not None:
                zarr_file = self._zarr_file_obj
            elif self.zarr_file and os.path.exists(self.zarr_file):
                if self._zarr_synchronizer is None:
                    from app.services.data import get_zarr_synchronizer
                    self._zarr_synchronizer = get_zarr_synchronizer(self.zarr_file)
                zarr_file = zarr.open(self.zarr_file, 'r', synchronizer=self._zarr_synchronizer)
                self._zarr_file_obj = zarr_file
            else:
                zarr_file = None
            
            if zarr_file is not None and 'user_annotation' in zarr_file:
                user_anno = zarr_file['user_annotation']
                if hasattr(user_anno, 'attrs') and 'class_names' in user_anno.attrs and 'class_colors' in user_anno.attrs:
                    # Use names and colors from user_annotation metadata (most up-to-date, reflects deletions)
                    user_anno_names = user_anno.attrs.get('class_names', [])
                    user_anno_colors = user_anno.attrs.get('class_colors', [])
                    
                    # If user_annotation has class names, use them (they reflect the latest state including deletions)
                    if user_anno_names and len(user_anno_names) == len(user_anno_colors):
                        names_out = [str(name) for name in user_anno_names]
                        colors_out = [str(color) for color in user_anno_colors]
                        # Also update handler's memory to keep it in sync
                        self.class_name = np.array(user_anno_names)
                        self.class_hex_color = np.array(user_anno_colors)
        except Exception as e:
            logger.warning(f"Failed to read user_annotation metadata for class names and colors: {e}")

        result = {
            "nuclei_class_id": effective_class_ids.tolist(),
            "nuclei_class_name": names_out,
            "nuclei_class_HEX_color": colors_out
        }
        
        return result

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
        """Get the color for the given index."""
        try:
            if 0 <= index < len(self.annotation_colors["class_id"]) and index in self.annotation_colors["class_id"]:
                idx = self.annotation_colors["class_id"].index(index)
                if 0 <= idx < len(self.annotation_colors["class_name"]) and 0 <= idx < len(self.annotation_colors["class_hex_color"]):
                    return {
                        "class_name": self.annotation_colors["class_name"][idx],
                        "class_hex_color": self.annotation_colors["class_hex_color"][idx]
                    }
        except (ValueError, IndexError) as e:
            print(f"[Debug] Error getting annotation color for index {index}: {str(e)}")
        return None
    
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
            print("No tissue polygons loaded.")
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

    def get_annotations_in_viewport(self, x1, y1, x2, y2, use_classification=False, simplified=False):
        # Check if we have the required data, try to reload if missing
        if self.centroids is None or self.contours is None or self.kd_tree is None:
            print(f"[Warning] get_annotations_in_viewport => Missing required data - attempting reload")
            if self.zarr_file and os.path.exists(self.zarr_file):
                try:
                    # Only reload segmentation data if it's missing
                    self.load_file(self.zarr_file, force_reload=True, reload_segmentation_data=True)
                    print(f"[Warning] get_annotations_in_viewport => Reload completed - centroids: {self.centroids is not None}, contours: {self.contours is not None}, kd_tree: {self.kd_tree is not None}")
                except Exception as e:
                    print(f"[ERROR] get_annotations_in_viewport => Failed to reload data: {e}")
                    return [], {}

        center_x = (x1 + x2) / 2
        center_y = (y1 + y2) / 2
        radius = max(x2 - x1, y2 - y1) / 2
        radius = radius * 1.2 # add 20% buffer
        points_in_view = self.kd_tree.query_ball_point([center_x, center_y], r=radius) if self.kd_tree else []
        sorted_points = tuple(sorted(points_in_view))

        # Check cache for simplified annotations
        if simplified:
            cache_key = (x1, y1, x2, y2, use_classification, sorted_points)
            if cache_key in self._viewport_cache:
                cached_result, cached_counts = self._viewport_cache[cache_key]
                return cached_result, cached_counts

            # Manage cache size
            if len(self._viewport_cache) >= self._cache_max_size:
                # Remove oldest entry (true FIFO using OrderedDict)
                self._viewport_cache.popitem(last=False)  # last=False removes oldest

        if simplified:
            # Optimized simplified annotation data for frontend rendering
            if not points_in_view:
                counts = self.get_all_nuclei_counts()
                if counts is None:
                    counts = {'class_counts_by_id': {}, 'dynamic_class_names': []}
                return [], counts

            # Step 4: Color mapping (optimized with vectorized operations)
            color_map = {}
            default_color = "#808080"
            
            # Pre-build lookup dictionaries for O(1) access instead of O(n) .index() calls
            annotation_color_lookup = {}
            if isinstance(self.annotation_colors.get("class_id"), list):
                for i, cid in enumerate(self.annotation_colors["class_id"]):
                    if i < len(self.annotation_colors.get("class_hex_color", [])):
                        color = self.annotation_colors["class_hex_color"][i]
                        if isinstance(color, bytes):
                            color = color.decode('utf-8')
                        annotation_color_lookup[cid] = color

            if not use_classification:
                # Non-classification mode: use stored colors
                for idx in points_in_view:
                    color_map[idx] = annotation_color_lookup.get(idx, default_color)
            else:
                # Classification mode: use class colors with fallback (vectorized)
                if (self.class_id is not None and self.class_name is not None and
                    self.class_hex_color is not None):
                    # Vectorized color mapping for better performance
                    indices_array = np.array(points_in_view, dtype=np.int32)
                    valid_mask = (indices_array >= 0) & (indices_array < len(self.class_id))
                    
                    # Initialize all with default color
                    for idx in points_in_view:
                        color_map[idx] = default_color
                    
                    # Vectorized assignment for valid indices
                    if np.any(valid_mask):
                        valid_indices = indices_array[valid_mask]
                        class_ids = self.class_id[valid_indices]
                        
                        # Handle -1 (unclassified) and valid class_ids
                        valid_class_mask = (class_ids >= 0) & (class_ids < len(self.class_hex_color))
                        valid_class_indices = valid_indices[valid_class_mask]
                        valid_class_ids = class_ids[valid_class_mask]
                        
                        # Assign colors using vectorized indexing
                        for idx, class_id_val in zip(valid_class_indices, valid_class_ids):
                            color = self.class_hex_color[class_id_val]
                            if isinstance(color, bytes):
                                color = color.decode('utf-8')
                            color_map[int(idx)] = color
                    
                    # Fallback to annotation_colors for any remaining
                    for idx in points_in_view:
                        if color_map.get(idx) == default_color and idx in annotation_color_lookup:
                            color_map[idx] = annotation_color_lookup[idx]
                else:
                    # Fallback: use annotation colors
                    for idx in points_in_view:
                        color_map[idx] = annotation_color_lookup.get(idx, default_color)

            # Step 5: Contour validation and processing (optimized with batch loading)
            contour_start = time.time()
            valid_contours = []
            valid_indices = []
            valid_colors = []
            
            # Check if contours is a zarr array (lazy loading) - need optimized loading
            is_zarr_array = hasattr(self.contours, 'shape') and not isinstance(self.contours, np.ndarray)
            
            if is_zarr_array and len(points_in_view) > 0:
                # Zarr array: try batch reading first, fallback to parallel loading
                try:
                    
                    # Sort indices for better cache locality
                    sorted_indices = sorted(points_in_view)
                    num_indices = len(sorted_indices)
                    
                    load_start = time.time()
                    all_contours_batch = []
                    
                    # Try batch reading using zarr's slice and fancy indexing (much faster than individual access)
                    try:
                        if num_indices > 0:
                            min_idx = sorted_indices[0]
                            max_idx = sorted_indices[-1]
                            range_size = max_idx - min_idx + 1
                            
                            # Strategy 1: If range is small enough, read entire slice (fastest)
                            # This is much faster than individual access even if we only need a subset
                            if range_size < 50000 or range_size < num_indices * 3:
                                # Read entire range as slice (single I/O operation)
                                try:
                                    slice_contours = self.contours[min_idx:max_idx+1]
                                    # Convert to list/array for faster access
                                    if hasattr(slice_contours, '__iter__'):
                                        # Create a list for O(1) access
                                        slice_list = list(slice_contours) if not isinstance(slice_contours, np.ndarray) else slice_contours
                                        
                                        # Extract only needed indices
                                        for idx in sorted_indices:
                                            try:
                                                local_idx = idx - min_idx
                                                if 0 <= local_idx < len(slice_list):
                                                    contour = slice_list[local_idx]
                                                    if not isinstance(contour, np.ndarray):
                                                        contour = np.array(contour)
                                                    all_contours_batch.append((idx, contour))
                                            except Exception as e:
                                                print(f"[get_annotations_in_viewport] Warning: Error accessing contour {idx} from slice: {e}")
                                                continue
                                except Exception as slice_error:
                                    raise
                            
                            # Strategy 2: Try fancy indexing with numpy array (if slice failed or not applicable)
                            if len(all_contours_batch) == 0:
                                try:
                                    # Try fancy indexing - zarr may support this for object arrays
                                    indices_array = np.array(sorted_indices, dtype=np.int64)
                                    
                                    # Try direct fancy indexing
                                    try:
                                        batch_contours = self.contours[indices_array]
                                        # Process results
                                        if hasattr(batch_contours, '__len__'):
                                            for i, idx in enumerate(sorted_indices):
                                                try:
                                                    if i < len(batch_contours):
                                                        contour = batch_contours[i]
                                                        if not isinstance(contour, np.ndarray):
                                                            contour = np.array(contour)
                                                        all_contours_batch.append((idx, contour))
                                                except Exception as e:
                                                    print(f"[get_annotations_in_viewport] Warning: Error processing batch contour {idx}: {e}")
                                                    continue
                                    except (IndexError, TypeError, ValueError, NotImplementedError):
                                        # Fancy indexing not supported for this array type
                                        raise
                                        
                                except Exception as fancy_error:
                                    # Both batch methods failed, will fall through to parallel loading
                                    raise
                        else:
                            all_contours_batch = []
                            
                    except Exception as batch_error:
                        # Batch reading failed, fall back to parallel loading
                        all_contours_batch = []
                        
                        # Use thread pool for parallel loading (zarr I/O is thread-safe)
                        load_start = time.time()
                        # Increase thread count for large datasets
                        if num_indices > 10000:
                            max_workers = min(32, num_indices // 500)
                        elif num_indices > 1000:
                            max_workers = min(16, num_indices // 200)
                        else:
                            max_workers = min(8, num_indices)
                        
                        def load_contour(idx):
                            try:
                                contour = self.contours[idx]
                                if not isinstance(contour, np.ndarray):
                                    contour = np.array(contour)
                                return (idx, contour)
                            except Exception as e:
                                print(f"[get_annotations_in_viewport] Warning: Error loading contour {idx}: {e}")
                                return None
                        
                        if len(sorted_indices) > 50:
                            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                                future_to_idx = {executor.submit(load_contour, idx): idx for idx in sorted_indices}
                                
                                completed = 0
                                for future in as_completed(future_to_idx):
                                    result = future.result()
                                    if result is not None:
                                        all_contours_batch.append(result)
                                    completed += 1
                                    if completed % 1000 == 0:
                                        elapsed = time.time() - load_start
                                        rate = completed / elapsed if elapsed > 0 else 0
                        else:
                            all_contours_batch = [load_contour(idx) for idx in sorted_indices]
                            all_contours_batch = [r for r in all_contours_batch if r is not None]
                    
                    # Process loaded contours
                    for idx, contour in all_contours_batch:
                        try:
                            # Convert to numpy array
                            if not isinstance(contour, np.ndarray):
                                contour = np.array(contour)
                            
                            # Handle legacy (2, K) format
                            if contour.ndim == 2 and contour.shape[0] == 2:
                                contour = contour.T
                            
                            # Validate contour shape
                            if contour.ndim == 2 and contour.shape[1] == 2 and contour.shape[0] >= 3:
                                valid_contours.append(contour)
                                valid_indices.append(idx)
                                valid_colors.append(color_map.get(idx, default_color))
                        except (ValueError, IndexError, TypeError) as e:
                            print(f"[get_annotations_in_viewport] Warning: Error processing contour {idx}: {e}")
                            continue
                            
                except ImportError:
                    # ThreadPoolExecutor not available, fall back to sequential
                    print(f"[get_annotations_in_viewport] Warning: ThreadPoolExecutor not available, using sequential loading")
                    is_zarr_array = False
                except Exception as e:
                    print(f"[get_annotations_in_viewport] Warning: Parallel loading failed: {e}, falling back to sequential")
                    print(f"Traceback: {traceback.format_exc()}")
                    # Fall through to individual processing
                    is_zarr_array = False
            
            # Individual processing (for numpy arrays or fallback)
            if not is_zarr_array or len(valid_contours) == 0:
                for idx in points_in_view:
                    try:
                        contour = self.contours[idx]
                        
                        # Convert to numpy array
                        if not isinstance(contour, np.ndarray):
                            contour = np.array(contour)
                        
                        # Handle legacy (2, K) format
                        if contour.ndim == 2 and contour.shape[0] == 2:
                            contour = contour.T
                        
                        # Validate contour shape
                        if contour.ndim == 2 and contour.shape[1] == 2 and contour.shape[0] >= 3:
                            valid_contours.append(contour)
                            valid_indices.append(idx)
                            valid_colors.append(color_map.get(idx, default_color))
                    except (IndexError, KeyError, TypeError) as e:
                        print(f"[get_annotations_in_viewport] Warning: Error accessing contour {idx}: {e}")
                        continue
            
            if not valid_contours:
                counts = self.get_all_nuclei_counts()
                if counts is None:
                    counts = {'class_counts_by_id': {}, 'dynamic_class_names': []}
                return [], counts

            # Step 6: Stack all valid contours (viewport / level coordinates; no extra scale step)
            stacked_contours = np.stack(valid_contours)  # Shape: (n_contours, n_points, 2)

            # Step 7: Build simplified annotations
            # Keep points as numpy arrays for better performance in binary packing
            simplified_annotations = []
            for i, idx in enumerate(valid_indices):
                # Get the i-th contour from the stacked array
                stacked_contour = stacked_contours[i]
                # Keep as numpy array instead of converting to list
                points = stacked_contour.astype(np.float64)

                # Get class_id for this nucleus (same logic as get_centroids_in_viewport)
                effective_class_id = -1  # Default to unclassified
                if self.class_id is not None and idx < len(self.class_id):
                    effective_class_id = self.class_id[idx]

                simplified_annotation = {
                    "id": idx,  # Keep as int for binary packing
                    "points": points,  # Keep as numpy array
                    "class_id": int(effective_class_id)  # Let frontend determine color based on class_id
                }
                simplified_annotations.append(simplified_annotation)

            # Step 8: Get counts and cache results
            counts = self.get_all_nuclei_counts()
            
            if counts is None:
                counts = {'class_counts_by_id': {}, 'dynamic_class_names': []}

            # Add color information to the response (same as get_centroids_in_viewport)
            result = counts.copy()
            if self.class_name is not None and self.class_hex_color is not None:
                result['class_names'] = self.class_name.tolist() if hasattr(self.class_name, 'tolist') else list(self.class_name)
                result['class_colors'] = self.class_hex_color.tolist() if hasattr(self.class_hex_color, 'tolist') else list(self.class_hex_color)
                print(f"[Debug] get_annotations_in_viewport => Added color info: class_names={result['class_names']}, class_colors={result['class_colors']}")

            # Cache the result for future use (OrderedDict automatically moves to end)
            self._viewport_cache[cache_key] = (simplified_annotations, result)
            

            return simplified_annotations, result
        else:
            # Create full annotation data for integration with user annotations
            annotations = []
            for idx in points_in_view:
                contour = self.contours[idx]

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
        radius = max(x2 - x1, y2 - y1) / 2 + self.BUFFER
        indices_in_view = self.kd_tree.query_ball_point([center_x, center_y], r=radius) if self.kd_tree else []
        points = self.centroids[indices_in_view].tolist()
        return points

    def get_centroids_in_viewport(self, x1, y1, x2, y2):
        # Check if handler needs reload due to file change
        if hasattr(self, '_needs_reload') and self._needs_reload:
            print(f"[DEBUG] SegmentationHandler - Reloading data due to file change")
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
                print(f"[DEBUG] SegmentationHandler - Reload completed, centroids shape: {self.centroids.shape if self.centroids is not None else 'None'}, kd_tree: {self.kd_tree is not None}")
            except Exception as e:
                print(f"[ERROR] SegmentationHandler - Failed to reload data: {e}")
                # Don't reset the flag if reload failed, so it will try again next time
        
        # return points
        if self.centroids is None or self.contours is None or self.kd_tree is None:
            print(f"[Warning] get_centroids_in_viewport => Missing required data - centroids: {self.centroids is not None}, contours: {self.contours is not None}, kd_tree: {self.kd_tree is not None}")
            print(f"[Warning] get_centroids_in_viewport => zarr_file: {self.zarr_file}")

            # Try to reload data if file exists but data is missing
            if self.zarr_file and os.path.exists(self.zarr_file):
                print(f"[Warning] get_centroids_in_viewport => Attempting to reload data from {self.zarr_file}")
                try:
                    # Only reload segmentation data if it's missing
                    self.load_file(self.zarr_file, force_reload=True, reload_segmentation_data=True)
                    print(f"[Warning] get_centroids_in_viewport => Reload completed - centroids: {self.centroids is not None}, contours: {self.contours is not None}, kd_tree: {self.kd_tree is not None}")

                    # Check again after reload
                    if self.centroids is None or self.contours is None or self.kd_tree is None:
                        print(f"[ERROR] get_centroids_in_viewport => Data still missing after reload")
                        # If we have centroids but no KD-tree, try to build it manually
                        if self.centroids is not None and self.contours is not None and self.kd_tree is None:
                            print(f"[Warning] get_centroids_in_viewport => Attempting to build KD-tree manually")
                            try:
                                self.kd_tree = KDTree(self.centroids)
                                print(f"[Debug] get_centroids_in_viewport => Successfully built KD-tree manually")
                            except Exception as e:
                                print(f"[Error] get_centroids_in_viewport => Failed to build KD-tree manually: {e}")
                                return [], {}
                        else:
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
        
        # Use KD-tree if available, otherwise fall back to bounding box filtering
        if self.kd_tree is not None:
            indices_in_view = self.kd_tree.query_ball_point([center_x, center_y], r=radius)
        else:
            # Fallback: use bounding box filtering
            in_bbox_mask = (
                (x1 <= self.centroids[:, 0]) & (self.centroids[:, 0] <= x2) &
                (y1 <= self.centroids[:, 1]) & (self.centroids[:, 1] <= y2)
            )
            indices_in_view = np.where(in_bbox_mask)[0]
        
        # Vectorized processing for better performance
        if len(indices_in_view) == 0:
            # Return empty numpy array with correct shape for consistency
            points = np.empty((0, 4), dtype=np.float64)
        else:
            # Convert indices_in_view to numpy array for vectorized indexing
            indices_array = np.asarray(indices_in_view)
            
            # Vectorized coordinate extraction
            centroids_in_view = self.centroids[indices_array]
            scaled_coords = centroids_in_view
            
            # Vectorized class_id extraction
            if self.class_id is not None:
                # Create a mask for valid indices
                valid_mask = indices_array < len(self.class_id)
                # Initialize with -1 (unclassified)
                effective_class_ids = np.full(len(indices_array), -1, dtype=np.int32)
                # Fill valid indices with actual class_id values
                effective_class_ids[valid_mask] = self.class_id[indices_array[valid_mask]].astype(np.int32)
            else:
                effective_class_ids = np.full(len(indices_array), -1, dtype=np.int32)
            
            # Build points array using vectorized operations
            # Stack: [indices, x_coords, y_coords, class_ids]
            # Keep as numpy array for better performance in binary packing
            points = np.column_stack([
                indices_array,
                scaled_coords[:, 0].astype(np.float64),
                scaled_coords[:, 1].astype(np.float64),
                effective_class_ids
            ])
                
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
                    if self._zarr_synchronizer is None:
                        from app.services.data import get_zarr_synchronizer
                        self._zarr_synchronizer = get_zarr_synchronizer(self.zarr_file)
                    zarr_file = zarr.open(self.zarr_file, 'r', synchronizer=self._zarr_synchronizer)
                    self._zarr_file_obj = zarr_file
                
                if 'user_annotation' in zarr_file:
                    user_anno = zarr_file['user_annotation']
                    if hasattr(user_anno, 'attrs') and 'class_colors' in user_anno.attrs:
                        # Use colors from user_annotation metadata (user's manual annotation colors)
                        user_anno_colors = user_anno.attrs['class_colors']
                        user_anno_names = user_anno.attrs.get('class_names', [])
                        
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
            with zarr.open(self.zarr_file, "r") as zf:
                probabilities = None
                classification_group = zf.get(ZarrGroups.CLASSIFICATION_NODE)
                if classification_group is not None and ZarrDatasets.NUCLEI_CLASS_PROBABILITIES in classification_group:
                    probabilities = classification_group[ZarrDatasets.NUCLEI_CLASS_PROBABILITIES][:]
                if probabilities is None:
                    seg_group = find_segmentation_group(zf)
                    if seg_group is not None and ZarrDatasets.PROBABILITY in seg_group:
                        probabilities = seg_group[ZarrDatasets.PROBABILITY][:]
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
                if ZarrDatasets.NUCLEI_CLASS_ID in classification_group:
                    classifications = np.array(classification_group[ZarrDatasets.NUCLEI_CLASS_ID][:])
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

        indices_in_view = self.kd_tree.query_ball_point([center_x, center_y], r=radius) if self.kd_tree else []
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

        print(f"[Debug] offset: {offset}, type: {type(offset)}")
        print(f"[Debug] limit: {limit}, tyoe: {type(limit)}")
        
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
            print(len(self.centroids))
            if limit is None:
                print(f"[Debug] limit is None")
                end_idx = len(self.centroids)
            else:
                print(f"[Debug] limit is not None") 
                try:
                    # Make sure limit is an integer
                    limit = int(limit)
                    end_idx = offset + limit
                except (ValueError, TypeError):
                    print(f"[Debug] limit is not a valid number, using default value")
                    end_idx = len(self.centroids)
            
            print(f"[Debug] end_idx={end_idx}")
            print(f"[Debug] get_annotations => offset={offset}, limit={limit}, end_idx={end_idx}")
            
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
                    print(f"[Debug] Created annotation for idx={idx}")


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
        import time
        from datetime import datetime

        # Add metadata as comments (CSV readers will ignore lines starting with #)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        total_count = len(self.centroids) if self.centroids is not None else 0

        yield f"# Cell Classification Overview Export\n"
        yield f"# Generated: {timestamp}\n"
        yield f"# Total Cells in Zarr: {total_count}\n"
        yield f"# Batch Size: {batch_size}\n"

        # Yield CSV header
        yield "ID,Centroid_X,Centroid_Y,MinX,MinY,MaxX,MaxY,Contours\n"

        if total_count == 0 or self.centroids is None or self.contours is None:
            # Empty dataset - only header
            return

        print(f"[CSV Export] Starting export of {total_count} cells with batch_size={batch_size}")

        # Escape CSV helper - defined once outside loop
        def escape_csv(value):
            if value == "" or value is None:
                return ""
            str_value = str(value)
            # Only escape if necessary (most values won't need it)
            if "," in str_value or '"' in str_value or "\n" in str_value or ";" in str_value:
                return f'"{str_value.replace(chr(34), chr(34)+chr(34))}"'
            return str_value

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

                    # Build CSV row - minimize string operations
                    # Most numeric values don't need escaping
                    row = f"{idx},{centroid_x},{centroid_y},{min_x},{min_y},{max_x},{max_y},{escape_csv(contours_str)}"
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
                print(f"[CSV Export] Processed batch {batch_start}-{batch_end} ({len(batch_rows)} rows) in {batch_time:.2f}s")
                yield batch_csv

        # Final summary with verification
        unique_ids_count = len(generated_ids)
        print(f"[CSV Export] Complete:")
        print(f"  - Generated rows: {total_rows_generated}")
        print(f"  - Unique IDs: {unique_ids_count}")
        print(f"  - Skipped cells: {total_skipped}")
        print(f"  - Expected total: {total_count}")

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

        # Drop non-finite coordinates only for floating-point contours.
        if arr.dtype.kind == 'f':
            finite_mask = np.isfinite(arr).all(axis=1)
            arr = arr[finite_mask]
            if arr.shape[0] < 3:
                return None

        # Remove consecutive duplicate points.
        if arr.shape[0] > 1:
            keep = np.ones(arr.shape[0], dtype=bool)
            keep[1:] = np.any(np.diff(arr, axis=0) != 0, axis=1)
            arr = arr[keep]
        if arr.shape[0] < 3:
            return None

        # Close ring.
        if not np.array_equal(arr[0], arr[-1]):
            arr = np.vstack((arr, arr[0]))

        open_arr = arr[:-1]
        if open_arr.shape[0] < 3:
            return None

        open_pts = np.ascontiguousarray(open_arr.reshape((-1, 1, 2)), dtype=np.float32)

        # Use OpenCV area check (C++ path) instead of Python-side unique operations.
        try:
            area = abs(float(cv2.contourArea(open_pts)))
        except Exception:
            return None
        if area <= 1e-6:
            return None

        # Keep a simple, robust path: use OpenCV convexity check and only fall back to hull
        # when the contour is non-convex. This avoids expensive custom intersection logic.
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

        # Prepare manual annotations for color overrides
        manual_annots = {}
        if getattr(self, 'tissue_annotations', None):
            manual_annots = self.tissue_annotations
        else:
            # Direct loading from Zarr file (no cache)
            try:
                if self.zarr_file and os.path.exists(self.zarr_file):
                    with zarr.open(self.zarr_file, 'r') as zarr_file:
                        if 'tissue_annotations' in zarr_file:
                            raw = zarr_file['tissue_annotations'][()]
                            if isinstance(raw, (bytes, bytearray)):
                                manual_annots = json.loads(raw.decode('utf-8'))
                            else:
                                manual_annots = json.loads(raw)
            except Exception as e:
                print(f"[PATCHES] Failed to read manual tissue_annotations for override: {e}")

        # Get colors for each patch using colormap (similar to nuclei)
        colors = []
        
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
                    print(f"[PATCHES] Using patch group colormap from handler: {len(user_tissue_colormap)} classes")
            except Exception as e:
                print(f"[PATCHES] Failed to build colormap from handler data: {e}")
        
        # Fallback: try to merge user_annotation colors (for manual annotations)
        # But don't replace the base colormap, just update colors for classes that exist
        if user_tissue_colormap is not None:
            try:
                if self.zarr_file and os.path.exists(self.zarr_file):
                    with zarr.open(self.zarr_file, 'r') as zarr_file:
                        if 'user_annotation' in zarr_file:
                            user_anno_group = zarr_file['user_annotation']
                            if 'tissue_class_colors' in user_anno_group.attrs and 'tissue_class_names' in user_anno_group.attrs:
                                user_tissue_class_names = list(user_anno_group.attrs.get('tissue_class_names', []))
                                user_tissue_colors_raw = user_anno_group.attrs.get('tissue_class_colors', [])
                                
                                # Update colors for classes that exist in base colormap
                                for name, color in zip(user_tissue_class_names, user_tissue_colors_raw):
                                    decoded_color = color.decode('utf-8') if isinstance(color, bytes) else str(color)
                                    if name in user_tissue_colormap:
                                        user_tissue_colormap[name] = decoded_color
                                        print(f"[PATCHES] Updated color for '{name}' from user_annotation: {decoded_color}")
            except Exception as e:
                print(f"[PATCHES] Failed to merge user_annotation colors: {e}")
        
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
                    manual_class_name = manual.get('tissue_class')
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
                    if len(colors) <= 3:
                        excl = manual_negative.get('exclude_classes', [])
                        print(f"[PATCHES] Patch {idx_in_view} negative (not {excl}), showing prediction '{pred_class_name}' color '{color_to_use}'")
                else:
                    color_to_use = manual_negative.get('tissue_color') or '#aaaaaa'
                    colors.append(color_to_use)
                    if len(colors) <= 3:
                        excl = manual_negative.get('exclude_classes', [])
                        print(f"[PATCHES] Patch {idx_in_view} negative (not {excl}), no prediction, color '{color_to_use}'")
            elif class_name_to_use and user_tissue_colormap and class_name_to_use in user_tissue_colormap:
                color_to_use = user_tissue_colormap[class_name_to_use]
                colors.append(color_to_use)
                if len(colors) <= 3:
                    print(f"[PATCHES] Assigning color for patch {idx_in_view} (class='{class_name_to_use}'): '{color_to_use}' from colormap")
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
            class_id = int(patch_class_ids_in_view[i]) if i < len(patch_class_ids_in_view) else -1
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
            print("[Debug] No patch data to merge")
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
            print(f"[Debug] No patches found in viewport ({x1}, {y1}, {x2}, {y2})")
            return
        
        print(f"[Debug] Found {len(viewport_indices)} patches in viewport")
        
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
            """Get pixel-style contour points for a group of patches"""
            if not patches:
                return []
            
            coords = self.patch_coordinates[patches]
            min_x = np.min(coords[:, 0])
            min_y = np.min(coords[:, 1])
            max_x = np.max(coords[:, 2])
            max_y = np.max(coords[:, 3])
            
            # Create mask image (using relative coordinates to save memory)
            width = int(max_x - min_x + 1)
            height = int(max_y - min_y + 1)
            mask = np.zeros((height, width), dtype=np.uint8)
            
            # Fill patch areas
            for patch_idx in patches:
                coords = self.patch_coordinates[patch_idx]
                x1, y1, x2, y2 = coords
                # Convert to relative coordinates
                x1_rel = int(x1 - min_x)
                y1_rel = int(y1 - min_y)
                x2_rel = int(x2 - min_x)
                y2_rel = int(y2 - min_y)
                mask[y1_rel:y2_rel+1, x1_rel:x2_rel+1] = 1
            
            try:
                contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                
                if not contours:
                    return []
                
                largest_contour = max(contours, key=cv2.contourArea)
                
                # Convert back to original coordinate system
                points = []
                for point in largest_contour:
                    x = float(point[0][0] + min_x)
                    y = float(point[0][1] + min_y)
                    points.append([x, y])
                
                if points and points[0] != points[-1]:
                    points.append(points[0])
                
                return points
            
            except ImportError:
                print("[Warning] OpenCV not found, falling back to simple boundary")
                vertices = np.array([[float(coords[0]), float(coords[1])] for coords in self.patch_coordinates[patches]])
                min_coords = np.min(vertices, axis=0)
                max_coords = np.max(vertices, axis=0)
                
                return [
                    [float(min_coords[0]), float(min_coords[1])],
                    [float(max_coords[0]), float(min_coords[1])],
                    [float(max_coords[0]), float(max_coords[1])],
                    [float(min_coords[0]), float(max_coords[1])],
                    [float(min_coords[0]), float(min_coords[1])]
                ]

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
        
        print(f"[Debug] Created {len(merged_patch_annotations)} merged patch annotations")
        return merged_patch_annotations

    def process_and_store_merged_patches(self):
        """
        process all patches and store the merged patches in cache
        """
        print(f"[Debug] process_and_store_merged_patches - Processing file: {self.get_current_file_path()}")
        if not hasattr(self, 'patch_coordinates') or self.patch_coordinates is None:
            print("[Debug] No patch data to process")
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
            if not patches:
                return []
            
            coords = self.patch_coordinates[patches]
            min_x = np.min(coords[:, 0])
            min_y = np.min(coords[:, 1])
            max_x = np.max(coords[:, 2])
            max_y = np.max(coords[:, 3])
            
            width = int(max_x - min_x + 1)
            height = int(max_y - min_y + 1)
            mask = np.zeros((height, width), dtype=np.uint8)
            
            for patch_idx in patches:
                coords = self.patch_coordinates[patch_idx]
                x1, y1, x2, y2 = coords
                x1_rel = int(x1 - min_x)
                y1_rel = int(y1 - min_y)
                x2_rel = int(x2 - min_x)
                y2_rel = int(y2 - min_y)
                mask[y1_rel:y2_rel+1, x1_rel:x2_rel+1] = 1
            
            try:
                contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                if not contours:
                    return []
                
                largest_contour = max(contours, key=cv2.contourArea)
                points = []
                for point in largest_contour:
                    x = float(point[0][0] + min_x)
                    y = float(point[0][1] + min_y)
                    points.append([x, y])
                
                if points and points[0] != points[-1]:
                    points.append(points[0])
                
                return points
            except ImportError:
                print("[Warning] OpenCV not found, falling back to simple boundary")
                vertices = np.array([[float(coords[0]), float(coords[1])] for coords in self.patch_coordinates[patches]])
                min_coords = np.min(vertices, axis=0)
                max_coords = np.max(vertices, axis=0)
                return [
                    [float(min_coords[0]), float(min_coords[1])],
                    [float(max_coords[0]), float(min_coords[1])],
                    [float(max_coords[0]), float(max_coords[1])],
                    [float(min_coords[0]), float(max_coords[1])],
                    [float(min_coords[0]), float(min_coords[1])]
                ]

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
        
        print(f"[Debug] Processed and stored {len(self._merged_patches_cache)} merged patch annotations")

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
        
        print(f"[Debug] Found {len(result)} merged patches in viewport")
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
        print(f"[Debug] get_patches => offset: {offset}, limit: {limit}")
        
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
            print("[Debug] get_patches => No patch data available")
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
            
            # Get class information for the patch
            patch_specific_color = "#ff0000"  # Default color
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
            
        print(f"[Debug] get_patches => Returning {len(patches_list)} patches out of {total_count}")
        return patches_list, total_count

    def get_all_nuclei_counts(self, instance_id: str = None) -> Dict[str, Any]:
        """
        Returns the persisted class counts from /user_annotation/class_counts in Zarr.
        Maps to ID-based if possible. Uses cache to avoid repeated file I/O.

        Args:
            instance_id: Optional instance identifier for multi-user isolation.
                        If None, Active Learning reclassifications will not be applied.
            
        Returns:
            Dict with class counts and related data
        """
        zarr_path = self.get_current_file_path()
        cache_key = (zarr_path, instance_id)

        # Check cache first (now includes instance_id for multi-user isolation)
        # IMPORTANT: If cache key doesn't match exactly, we must recompute to avoid stale data
        # This is especially critical after reset operations
        if self._user_annotation_counts_cache is not None:
            cached_key, cache_result = self._user_annotation_counts_cache
            if cached_key == cache_key:
                print(f"[get_all_nuclei_counts] Using cached result for key {cache_key}: {cache_result}")
                return cache_result
            else:
                print(f"[get_all_nuclei_counts] Cache key mismatch: cached={cached_key}, current={cache_key}, will recompute")
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

        try:
            with zarr.open(zarr_path, 'r') as zarr_file:
                # Look for class counts in user_annotation group
                if 'user_annotation' in zarr_file:
                    user_anno_group = zarr_file['user_annotation']
                    
                    if 'class_counts' in user_anno_group:
                        raw_data = user_anno_group['class_counts'][()]
                        try:
                            if isinstance(raw_data, bytes):
                                counts_dict = json.loads(raw_data.decode('utf-8'))
                            else:
                                counts_dict = json.loads(raw_data)
                            print(f"[get_all_nuclei_counts] Loaded class_counts from Zarr: {counts_dict}")
                        except (json.JSONDecodeError, UnicodeDecodeError) as e:
                            print(f"[WARN] get_all_nuclei_counts => Failed to parse counts data: {e}")
                            counts_dict = {}
                    else:
                        print(f"[get_all_nuclei_counts] class_counts not found in user_annotation, will compute from annotations")
                else:
                    print(f"[get_all_nuclei_counts] user_annotation group not found, will compute from annotations")
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

        # Step 4: Fallback computation only if absolutely necessary
        if not counts_dict:
            print(f"[get_all_nuclei_counts] class_counts not found, computing from manual annotations")
            counts_dict = self._compute_counts_from_manual_annotations()
            print(f"[get_all_nuclei_counts] Computed counts from annotations: {counts_dict}")

        # Build and return result
        if counts_dict:
            result = self._build_id_based_counts(counts_dict)
            # Cache the result (now includes instance_id in cache key)
            # IMPORTANT: Always update cache with current key to prevent stale data
            self._user_annotation_counts_cache = (cache_key, result)
            print(f"[get_all_nuclei_counts] Final result (before ID mapping): {counts_dict}, cached for key {cache_key}")
        else:
            # No data available, return empty result
            result = {'class_counts_by_id': {}, 'dynamic_class_names': []}
            # Cache the empty result too
            # IMPORTANT: Always update cache with current key to prevent stale data
            self._user_annotation_counts_cache = (cache_key, result)
            print(f"[get_all_nuclei_counts] No counts found, returning empty result")
        
        return result

    def _compute_counts_from_manual_annotations(self) -> Dict[str, int]:
        """Compute counts from manual annotations as fallback (optimized version)"""
        try:
            # Read directly from Zarr file - no cache needed
            if not self.zarr_file or not os.path.exists(self.zarr_file):
                print(f"[WARN] _compute_counts_from_manual_annotations => Zarr file not found: {self.zarr_file}")
                return {}
            
            with zarr.open(self.zarr_file, 'r') as zarr_file:
                if 'user_annotation' in zarr_file:
                    user_anno_group = zarr_file['user_annotation']
                    
                    # Get class_names from metadata first (needed for ID to name conversion)
                    class_names = None
                    if 'class_names' in user_anno_group.attrs:
                        class_names = user_anno_group.attrs.get('class_names', [])
                        # Decode bytes if needed
                        if isinstance(class_names, (list, tuple)) and len(class_names) > 0:
                            if isinstance(class_names[0], bytes):
                                class_names = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in class_names]
                            else:
                                class_names = [str(name) for name in class_names]
                        elif isinstance(class_names, np.ndarray):
                            class_names = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in class_names]
                    
                    if not class_names:
                        # No metadata, can't convert IDs to names
                        print(f"[_compute_counts_from_manual_annotations] No class_names in metadata, cannot compute counts")
                        return {}
                    
                    print(f"[_compute_counts_from_manual_annotations] Found class_names: {class_names}")
                    
                    # Load only cell_class field (much faster than loading entire array)
                    manual_annotations = self._load_annotations_array(zarr_file, fields=['cell_class'])
                    if manual_annotations is not None:
                        # Use numpy operations for much better performance
                        cell_class_ids = manual_annotations['cell_class']
                        # New format: -1 = unclassified, 0+ = class index
                        non_empty_mask = cell_class_ids >= 0
                        
                        annotated_count = np.sum(non_empty_mask)
                        print(f"[_compute_counts_from_manual_annotations] Found {annotated_count} annotated cells")
                        
                        if np.any(non_empty_mask):
                            # Convert IDs to class names
                            valid_class_ids = cell_class_ids[non_empty_mask]
                            # Filter out invalid indices before conversion
                            valid_indices_mask = (valid_class_ids >= 0) & (valid_class_ids < len(class_names))
                            valid_classes = np.array([class_names[cid] for cid in valid_class_ids[valid_indices_mask]])
                            print(f"[_compute_counts_from_manual_annotations] Valid classes count: {len(valid_classes)}")
                        else:
                            print(f"[_compute_counts_from_manual_annotations] No annotated cells found")
                            return {}
                    else:
                        print(f"[_compute_counts_from_manual_annotations] Failed to load annotations array")
                        return {}
                else:
                    print(f"[_compute_counts_from_manual_annotations] user_annotation group not found")
                    return {}

            # Optimized counting with pre-filtering using numpy
            TEMPORARY_CLASSES = {"Other", "Not Sure", "Incorrect Segmentation"}
            name_counts = {}

            # Get reclassified data only if needed
            reclassified_data = {}
            try:
                from app.services.review import _reclassified_cells
                zarr_path = self.get_current_file_path()
                reclassified_data = _reclassified_cells.get(zarr_path, {})
            except Exception as e:
                logger.warning(f"Failed to import or access reclassified_cells: {e}")

            # Filter out temporary classes using numpy
            non_temp_mask = ~np.isin(valid_classes, list(TEMPORARY_CLASSES))
            filtered_classes = valid_classes[non_temp_mask]
            
            # Count classes using numpy (much faster)
            if len(filtered_classes) > 0:
                unique_classes, counts = np.unique(filtered_classes, return_counts=True)
                name_counts = {str(cls): int(count) for cls, count in zip(unique_classes, counts) if cls}
            
            # Apply reclassifications if any
            for cell_id_str, reclass_info in reclassified_data.items():
                try:
                    cell_id = int(cell_id_str)
                    if 0 <= cell_id < len(manual_annotations):
                        # New format: cell_class is integer ID, need to convert to class name
                        class_id = int(manual_annotations['cell_class'][cell_id])
                        if class_id < 0:
                            continue  # Unclassified
                        
                        # Get class name from metadata
                        original_class_name = class_names[class_id]
                        
                        if original_class_name in TEMPORARY_CLASSES:
                            continue
                        
                        new_class = reclass_info.get("new_class")
                        if not new_class:
                            continue

                        # Only adjust counts if original was NOT a manual annotation
                        is_original_manual = reclass_info.get("is_original_manual", False)
                        if not is_original_manual:
                            # Decrement original class
                            if original_class_name in name_counts and name_counts[original_class_name] > 0:
                                name_counts[original_class_name] -= 1
                            # Increment new class
                            if new_class not in name_counts:
                                name_counts[new_class] = 0
                            name_counts[new_class] += 1
                except (ValueError, KeyError, IndexError):
                    continue

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
        dynamic_class_names = list(self.class_name)
        dynamic_class_names = [
            n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n)
            for n in dynamic_class_names
        ]

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
        # Check for active learning reclassifications and clear cache if they exist
        try:
            from app.services.review import _reclassified_cells
            zarr_path = self.get_current_file_path()
            if zarr_path in _reclassified_cells and _reclassified_cells[zarr_path]:
                # Clear cache when active learning data exists to ensure fresh calculation
                self._global_label_counts_cache = None
        except Exception as e:
            logger.error(f"Error checking for active learning reclassifications in get_global_nuclei_label_counts: {e}")
        
        # Use caching for performance - total_counts is called frequently
        # Check cache first to avoid expensive recalculations
        if hasattr(self, '_global_label_counts_cache') and self._global_label_counts_cache is not None:
            # Check if cache is still valid (file hasn't changed)
            current_file = self.get_current_file_path()
            cached_file, cached_result = self._global_label_counts_cache
            if cached_file == current_file:
                return cached_result

        # Only load if handler doesn't have zarr_file set
        # Note: centroids check is done later only if needed for total_cells calculation
        if self.zarr_file is None:
            self.load_file(self.get_current_file_path(), force_reload=False, reload_segmentation_data=False)
        
        # Load centroids only if needed for total_cells (lazy loading)
        if self.centroids is None and self.zarr_file is not None:
            # Only reload segmentation data if we need centroids for total_cells
            self.load_file(self.get_current_file_path(), force_reload=False, reload_segmentation_data=True)

        # IMPORTANT: Ensure manual annotations are applied before calculating counts
        # This is critical because save_annotation may have updated the Zarr file,
        # but the handler's in-memory class_id may not reflect the latest changes
        # until _apply_manual_nuclei_annotations is called
        if self.zarr_file is not None and os.path.exists(self.zarr_file):
            try:
                if self._zarr_file_obj is not None:
                    zarr_file = self._zarr_file_obj
                else:
                    if self._zarr_synchronizer is None:
                        from app.services.data import get_zarr_synchronizer
                        self._zarr_synchronizer = get_zarr_synchronizer(self.zarr_file)
                    zarr_file = zarr.open(self.zarr_file, 'r', synchronizer=self._zarr_synchronizer)
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

        # Convert to numpy arrays if needed and apply active learning reclassifications
        try:
            class_ids = np.array(self.class_id)
        except Exception:
            class_ids = self.class_id

        # Apply active learning reclassifications to class_ids for accurate counts
        try:
            from app.services.review import _reclassified_cells, _load_reclassifications_from_zarr, _zarr_reclassifications_cache
            zarr_path = self.get_current_file_path()

            # Define temporary classes that should be filtered out
            TEMPORARY_CLASSES = {"Other", "Not Sure", "Incorrect Segmentation"}

            # Optimize: Check Zarr cache first to avoid file I/O if already loaded
            # Cache safety: 
            # - Cache keys are based on zarr_path, so switching files uses different keys (auto-invalidates)
            # - _zarr_reclassifications_cache uses mtime to detect file modifications (auto-invalidates on save)
            # - _global_label_counts_cache checks current_file == cached_file (auto-invalidates on file switch)
            reclassified_data = None
            
            # First check in-memory cache (check if key exists, even if empty dict)
            # Note: Empty dict means we've already checked and confirmed no reclassifications exist
            if zarr_path in _reclassified_cells:
                # Key exists means we've already checked (even if empty dict)
                reclassified_data = _reclassified_cells[zarr_path]
            else:
                # Check Zarr file cache (avoids file I/O if already loaded)
                # This cache is shared across instances and uses mtime for invalidation
                if zarr_path in _zarr_reclassifications_cache:
                    cache_entry = _zarr_reclassifications_cache[zarr_path]
                    try:
                        current_mtime = os.path.getmtime(zarr_path)
                        if cache_entry.get('mtime') == current_mtime:
                            # Cache hit - use cached data (file hasn't been modified)
                            reclassified_data = cache_entry['data']
                            # Also update in-memory cache for faster future access
                            _reclassified_cells[zarr_path] = reclassified_data.copy() if reclassified_data else {}
                        else:
                            # Cache invalid - file was modified (mtime changed), need to reload
                            reclassified_data = None
                    except (OSError, KeyError):
                        # File doesn't exist or cache is invalid
                        reclassified_data = None
                
                # Only load from Zarr if not in cache
                if reclassified_data is None:
                    logger.info(f"[Total Counts] Attempting to load reclassifications from Zarr: {zarr_path}")
                    loaded_reclassifications = _load_reclassifications_from_zarr(zarr_path)
                    if loaded_reclassifications:
                        reclassified_data = loaded_reclassifications
                        _reclassified_cells[zarr_path] = loaded_reclassifications
                        logger.info(f"[Total Counts] Loaded {len(loaded_reclassifications)} reclassifications from Zarr")
                    else:
                        # Cache empty result to avoid repeated Zarr checks for files with no reclassifications
                        reclassified_data = {}
                        _reclassified_cells[zarr_path] = {}
                        logger.info(f"[Total Counts] No reclassifications found in Zarr")

            # Apply reclassifications if any exist
            if reclassified_data:
                # Convert class names to IDs for reclassification (create once)
                class_name_to_id = {name: idx for idx, name in enumerate(self.class_name)}
                
                # Optimize: use vectorized operations instead of loop
                # Collect all valid updates first
                valid_updates = []
                for cell_id_str, reclassify_info in reclassified_data.items():
                    try:
                        cell_id = int(cell_id_str)
                        new_class_name = reclassify_info["new_class"]
                        
                        # Skip temporary classes
                        if new_class_name in TEMPORARY_CLASSES:
                            continue
                        
                        if cell_id < len(class_ids) and new_class_name in class_name_to_id:
                            new_class_id = class_name_to_id[new_class_name]
                            valid_updates.append((cell_id, new_class_id))
                    except (ValueError, KeyError):
                        continue
                
                # Apply updates in batch using vectorized operations
                if valid_updates:
                    # Only create copy if we have updates to apply
                    if not isinstance(class_ids, np.ndarray):
                        class_ids = np.array(class_ids)
                    else:
                        # Use view instead of copy when possible, only copy if needed
                        class_ids = class_ids.copy()
                    
                    # Vectorized update: convert to arrays and update in one operation
                    update_indices = np.array([uid for uid, _ in valid_updates], dtype=np.int64)
                    update_values = np.array([val for _, val in valid_updates], dtype=class_ids.dtype)
                    
                    # Apply updates (much faster than loop)
                    class_ids[update_indices] = update_values
        except Exception as e:
            logger.error(f"Error applying reclassifications: {e}")
            logger.debug(traceback.format_exc())

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
                if self._zarr_synchronizer is None:
                    from app.services.data import get_zarr_synchronizer
                    self._zarr_synchronizer = get_zarr_synchronizer(self.zarr_file)
                zarr_file = zarr.open(self.zarr_file, 'r', synchronizer=self._zarr_synchronizer)
                self._zarr_file_obj = zarr_file
            else:
                zarr_file = None
            
            if zarr_file is not None and 'user_annotation' in zarr_file:
                user_anno = zarr_file['user_annotation']
                if hasattr(user_anno, 'attrs') and 'class_colors' in user_anno.attrs:
                    # Use colors from user_annotation metadata (user's manual annotation colors)
                    user_anno_colors = user_anno.attrs['class_colors']
                    user_anno_names = user_anno.attrs.get('class_names', [])
                    
                    # Build color map from user_annotation metadata
                    if user_anno_names and len(user_anno_names) == len(user_anno_colors):
                        color_map = {name: color for name, color in zip(user_anno_names, user_anno_colors)}
                        # Update colors_list based on names_list
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
        """
        Returns the persisted patch class counts from /user_annotation/patch_class_counts in Zarr.
        Maps to ID-based if possible.
        """
        # Zarr files are efficient, no need for caching

        counts_dict = {}
        manual_annotations = {}
        model_class_names: List[str] = []
        manual_class_names: List[str] = []
        try:
            # Direct loading from Zarr file (no cache)
            if self.zarr_file and os.path.exists(self.zarr_file):
                with zarr.open(self.zarr_file, 'r') as zarr_file:
                    # Get patch class counts
                    if 'user_annotation' in zarr_file and 'patch_class_counts' in zarr_file['user_annotation']:
                        raw_data = zarr_file['user_annotation/patch_class_counts'][()]
                        counts_dict = json.loads(raw_data.decode('utf-8'))

                    # Get tissue annotations
                    if 'user_annotation' in zarr_file and 'tissue_annotations' in zarr_file['user_annotation']:
                        raw_bytes = zarr_file['user_annotation/tissue_annotations'][()]
                        manual_annotations = json.loads(raw_bytes.decode('utf-8'))
                        for ann in manual_annotations.values():
                            name = ann.get('tissue_class')
                            if isinstance(name, str):
                                manual_class_names.append(name)

                    # Get model class names
                    patch_prefix = self.get_patch_classification_prefix()
                    if (self.patch_class_name is None or len(self.patch_class_name) == 0) and patch_prefix in zarr_file and 'tissue_class_name' in zarr_file[patch_prefix]:
                        try:
                            raw_names = safe_load_zarr_dataset(zarr_file[patch_prefix]['tissue_class_name'])
                            if raw_names is not None:
                                model_class_names = [n.decode('utf-8') for n in raw_names]
                            else:
                                model_class_names = []
                        except Exception:
                            # Fallback for scalar/other edge cases
                            raw = zarr_file[patch_prefix]['tissue_class_name'][()]
                            if isinstance(raw, (bytes, bytearray)):
                                model_class_names = [raw.decode('utf-8')]
                            else:
                                model_class_names = []
        
        except Exception as e:
            print(f"[ERROR] get_all_patch_counts: Failed to load patch_class_counts: {e}")
            counts_dict = {}

        # Fallback for old files: if patch_class_counts dataset does not exist, compute from manual annotations.
        if not counts_dict:
            print("[Debug] patch_class_counts not found in Zarr. Computing from manual annotations for backward compatibility.")
            name_counts = {}
            if manual_annotations:
                for _patch_id, annotation in manual_annotations.items():
                    class_name = annotation.get("tissue_class")
                    if class_name:
                        name_counts[class_name] = name_counts.get(class_name, 0) + 1
            counts_dict = name_counts

            # Persist the computed counts back to the Zarr file for future use
            if counts_dict:
                try:
                    with zarr.open(self.zarr_file, 'r+') as zarr_file:
                        user_group = zarr_file.require_group('user_annotation')
                        if 'patch_class_counts' in user_group:
                            del user_group['patch_class_counts']
                        user_group.create_dataset('patch_class_counts', data=json.dumps(counts_dict).encode('utf-8'))
                    print("[Debug] Persisted newly computed patch counts to Zarr file.")
                except Exception as e:
                    print(f"[Warning] Could not persist computed patch counts to Zarr file: {e}")

        # Build a robust class list: prefer in-memory model names, else Zarr model names, union with manual names, ensure 'Negative control'
        base_names: List[str] = []
        if self.patch_class_name is not None and isinstance(self.patch_class_name, list) and len(self.patch_class_name) > 0:
            base_names = list(self.patch_class_name)
        elif model_class_names:
            base_names = list(model_class_names)

        # Normalize and deduplicate base names
        base_names = [n.decode('utf-8') if isinstance(n, (bytes, bytearray)) else str(n) for n in base_names]
        _seen_names = set()
        base_names = [n for n in base_names if not (n in _seen_names or _seen_names.add(n))]

        # Union with manual names (preserve order)
        for n in manual_class_names:
            if n not in base_names:
                base_names.append(n)

        # Ensure 'Negative control' exists and is first
        if 'Negative control' not in base_names:
            base_names = ['Negative control'] + base_names
        else:
            # Move to front if not already
            if base_names[0] != 'Negative control':
                base_names = ['Negative control'] + [n for n in base_names if n != 'Negative control']

        dynamic_class_names = base_names
        name_to_id = {name: str(i) for i, name in enumerate(dynamic_class_names)}
        class_counts_by_id = {str(i): 0 for i in range(len(dynamic_class_names))}
        for name, count in counts_dict.items():
            if name in name_to_id:
                class_counts_by_id[name_to_id[name]] = count

        result = {'class_counts_by_id': class_counts_by_id, 'dynamic_class_names': dynamic_class_names}
        return result

    def invalidate_patch_counts_cache(self):
        # No caching needed for Zarr files
        pass

    def save_class_metadata_to_zarr(self, class_names: list, class_colors: list, zarr_file_path: str):
        """
        Save class names and colors as metadata in Zarr file using group attributes.
        This is more efficient than storing as datasets.
        """
        try:
            # Create synchronizer for thread-safe access (use cached synchronizer)
            synchronizer = self._create_zarr_synchronizer(zarr_file_path)
            
            with zarr.open(zarr_file_path, 'a', synchronizer=synchronizer) as zarr_file:
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
                
                print(f"[Debug] save_class_metadata_to_zarr => Saved {len(class_names)} classes to Zarr metadata")
                
        except Exception as e:
            print(f"[ERROR] save_class_metadata_to_zarr => Failed to save metadata: {e}")
            raise

    def load_class_metadata_from_zarr(self, zarr_file_path: str):
        """
        Load class names and colors from Zarr file metadata.
        """
        try:
            with zarr.open(zarr_file_path, 'r') as zarr_file:
                classification_prefix = self.get_classification_prefix()
                
                if classification_prefix in zarr_file:
                    group = zarr_file[classification_prefix]
                    
                    # Load from group attributes
                    if hasattr(group, 'attrs'):
                        class_names = group.attrs.get('class_names', [])
                        class_colors = group.attrs.get('class_colors', [])
                        
                        if class_names and class_colors:
                            print(f"[Debug] load_class_metadata_from_zarr => Loaded {len(class_names)} classes from metadata")
                            return class_names, class_colors
                
                print(f"[Debug] load_class_metadata_from_zarr => No class metadata found")
                return [], []
                
        except Exception as e:
            print(f"[ERROR] load_class_metadata_from_zarr => Failed to load metadata: {e}")
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

        with zarr.open(self.zarr_file, 'r+') as zarr_file:
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
                        
                        print(f"Updated color in ClassificationNode attributes for '{class_name}' to '{new_color}'.")
                    else:
                        print(f"Warning: Class '{class_name}' not found in ClassificationNode attributes")
                
                # Fallback: Check for old dataset format (legacy)
                elif 'nuclei_class_name' in group and 'nuclei_class_HEX_color' in group:
                    raw_names = safe_load_zarr_dataset(group['nuclei_class_name'])
                    if raw_names is not None:
                        class_names = [name.decode('utf-8') for name in raw_names]
                        if class_name in class_names:
                            class_index = class_names.index(class_name)
                            color_dataset = group['nuclei_class_HEX_color']
                            
                            # Ensure dataset is writeable
                            if color_dataset.dtype.kind == 'S':
                                color_dataset[class_index] = new_color.encode('utf-8')
                                print(f"Updated color in ClassificationNode dataset for '{class_name}'.")
                            else:
                                 print(f"Warning: Color dataset in ClassificationNode is not of string type.")
                    else:
                        print(f"Warning: Failed to load nuclei_class_name from ClassificationNode")

            else:
                print(f"Info: ClassificationNode does not exist. Skipping update of model colors.")

            # --- 2. Update Manual Nuclei Annotations colormap (structured array format) ---
            # Note: We only update the colormap, not individual cell_color fields.
            # The frontend reads colors from the colormap (nucleiClasses[class_id].color),
            # so updating cell_color is redundant and slow for large datasets.
            user_annot_group_path = 'user_annotation'
            if user_annot_group_path in zarr_file:
                user_anno_group = zarr_file[user_annot_group_path]
                
                # Update user_annotation.attrs['class_colors'] if it exists (this is the colormap)
                if 'class_colors' in user_anno_group.attrs and 'class_names' in user_anno_group.attrs:
                    user_class_names = user_anno_group.attrs.get('class_names', [])
                    user_class_colors = user_anno_group.attrs.get('class_colors', [])
                    
                    # Directly modify the list (attrs are mutable)
                    if class_name in user_class_names:
                        class_index = user_class_names.index(class_name)
                        user_class_colors[class_index] = new_color
                        # Ensure it's saved (list is already modified)
                        user_anno_group.attrs['class_colors'] = user_class_colors
                        print(f"Updated color in user_annotation.attrs['class_colors'] for class '{class_name}'.")
                    else:
                        print(f"Info: Class '{class_name}' not found in user_annotation.attrs['class_names'].")

            # --- 3. Update Manual Tissue/Patch Annotations (skip if not needed) ---
            # Note: Tissue annotations use JSON format, updating requires full load/save which is slow.
            # Since frontend reads from colormap, we can skip this for performance.
            # Only update if tissue_annotations exists and is small (quick check)
            tissue_annots_path = f"{user_annot_group_path}/tissue_annotations"
            if tissue_annots_path in zarr_file:
                try:
                    # Quick size check - only update if dataset is reasonably small
                    dataset = zarr_file[tissue_annots_path]
                    if hasattr(dataset, 'size') and dataset.size < 100000:  # Skip if too large
                        raw_bytes = dataset[()]
                        manual_tissue_annotations = json.loads(raw_bytes.decode("utf-8"))

                        updated = False
                        for patch_id, annotation in manual_tissue_annotations.items():
                            if annotation.get("tissue_class") == class_name:
                                annotation["tissue_color"] = new_color
                                updated = True

                        if updated:
                            del zarr_file[tissue_annots_path]
                            zarr_file.create_dataset(tissue_annots_path, data=json.dumps(manual_tissue_annotations).encode('utf-8'))
                            print(f"Updated denormalized colors in user_annotation/tissue_annotations.")
                except Exception as e:
                    # Skip if update fails (e.g., large dataset) - colormap update is sufficient
                    print(f"Info: Skipped tissue_annotations update (performance): {e}")

            # Zarr files don't need explicit flush - changes are automatically persisted

        # --- 4. Invalidate Cache and Update In-Memory State ---
        print(f"Updated colors in {self.zarr_file}.")
        # Clear caches only (no need to reload file, we've already updated Zarr and memory)

    def update_patch_class_color_in_zarr(self, class_name: str, new_color: str):
        """
        Updates the color for a given patch classification class name in the Zarr file.
        
        This method updates the colormap in MuskNode:
        1. Updates the canonical color in `/MuskNode/tissue_class_HEX_color` (attributes or dataset format).
        2. Updates the colormap in `/user_annotation/` group attributes if applicable.
        """
        if not self.zarr_file or not os.path.exists(self.zarr_file):
            raise ValueError("A valid Zarr file is not loaded.")

        with zarr.open(self.zarr_file, 'r+') as zarr_file:
            # Update patch classification colors in MuskNode
            patch_classification_prefix = self.get_patch_classification_prefix()
            
            if patch_classification_prefix in zarr_file:
                patch_group = zarr_file[patch_classification_prefix]
                
                # Check if data is stored as attributes (current format)
                if hasattr(patch_group, 'attrs') and 'tissue_class_name' in patch_group.attrs and 'tissue_class_HEX_color' in patch_group.attrs:
                    patch_class_names = patch_group.attrs.get('tissue_class_name', [])
                    patch_class_colors = patch_group.attrs.get('tissue_class_HEX_color', [])
                    
                    # Directly modify the list (attrs are mutable)
                    if class_name in patch_class_names:
                        patch_class_index = patch_class_names.index(class_name)
                        patch_class_colors[patch_class_index] = new_color
                        
                        # Update attributes (list is already modified, but ensure it's saved)
                        patch_group.attrs['tissue_class_HEX_color'] = patch_class_colors
                        patch_group.attrs['last_updated'] = time.time()
                    else:
                        print(f"Warning: Class '{class_name}' not found in {patch_classification_prefix} attributes. Available classes: {patch_class_names}")
                
                # Fallback: Check for old dataset format (legacy)
                elif 'tissue_class_name' in patch_group and 'tissue_class_HEX_color' in patch_group:
                    raw_patch_names = safe_load_zarr_dataset(patch_group['tissue_class_name'])
                    if raw_patch_names is not None:
                        patch_class_names = [name.decode('utf-8') if isinstance(name, (bytes, bytearray)) else str(name) for name in raw_patch_names]
                        if class_name in patch_class_names:
                            patch_class_index = patch_class_names.index(class_name)
                            patch_color_dataset = patch_group['tissue_class_HEX_color']
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

            # Update user_annotation colormap if applicable
            user_annot_group_path = 'user_annotation'
            if user_annot_group_path in zarr_file:
                user_anno_group = zarr_file[user_annot_group_path]
                
                # Update patch classification colormap in user_annotation if it exists
                if 'tissue_class_colors' in user_anno_group.attrs and 'tissue_class_names' in user_anno_group.attrs:
                    user_tissue_class_names = user_anno_group.attrs.get('tissue_class_names', [])
                    user_tissue_class_colors = user_anno_group.attrs.get('tissue_class_colors', [])
                    
                    if class_name in user_tissue_class_names:
                        user_tissue_index = user_tissue_class_names.index(class_name)
                        user_tissue_class_colors[user_tissue_index] = new_color
                        user_anno_group.attrs['tissue_class_colors'] = user_tissue_class_colors
                        user_anno_group.attrs['last_updated'] = time.time()

        # Invalidate cache
        self._user_annotation_counts_cache = None
        self._global_label_counts_cache = None  # Clear cell distribution cache
        
        # Force reload on next patch request to ensure updated colors are used
        # This ensures get_patch_centroids_in_viewport will see the updated colors
        print(f"[DEBUG] update_patch_class_color_in_zarr: Colors updated, memory state should reflect new colors")
        
        # Update in-memory patch_class_hex_color to reflect the new color
        # This ensures get_patch_centroids_in_viewport and other functions see the updated color immediately
        if self.patch_class_name is not None:
            # Convert to list for easier manipulation
            patch_class_name_list = list(self.patch_class_name) if hasattr(self.patch_class_name, '__iter__') else []
            if class_name in patch_class_name_list:
                patch_class_index = patch_class_name_list.index(class_name)
                print(f"[DEBUG] update_patch_class_color_in_zarr: Found class '{class_name}' at index {patch_class_index}")
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
                    
                    print(f"[DEBUG] update_patch_class_color_in_zarr: Updated in-memory color from '{old_color}' to '{new_color}' at index {patch_class_index}")
                    print(f"[DEBUG] update_patch_class_color_in_zarr: Current patch_class_hex_color type: {type(self.patch_class_hex_color)}, length: {len(self.patch_class_hex_color) if hasattr(self.patch_class_hex_color, '__len__') else 'N/A'}")
                    if hasattr(self.patch_class_hex_color, '__len__') and len(self.patch_class_hex_color) > 0:
                        print(f"[DEBUG] update_patch_class_color_in_zarr: First few colors: {list(self.patch_class_hex_color[:min(3, len(self.patch_class_hex_color))])}")
                else:
                    print(f"[DEBUG] update_patch_class_color_in_zarr: patch_class_hex_color is None, cannot update")
            else:
                print(f"[DEBUG] update_patch_class_color_in_zarr: Class '{class_name}' not found in patch_class_name: {patch_class_name_list}")


    def delete_class_in_zarr(self, class_name: str, reassign_to: str = "Negative control") -> Dict[str, Any]:
        """
        Persistently delete a nuclei class from the Zarr file.

        Steps:
        - Remove the deleted class from name/color arrays.
        - Remap nuclei_class_id: nuclei of the deleted class -> UNCLASSIFIED (-1), and shift indices above the deleted index down by 1.
        - Remove manual nuclei annotations for this class and persist updated counts.
        - Invalidate caches so future reads reflect changes.
        """
        if not self.zarr_file or not os.path.exists(self.zarr_file):
            raise ValueError("A valid Zarr file is not loaded.")

        if class_name == "Negative control":
            raise ValueError("Cannot delete 'Negative control' class.")

        affected = 0
        reassigned_to_name = None

        with zarr.open(self.zarr_file, 'r+') as zarr_file:
            # Only process data stored in user_annotation (current format)
            if 'user_annotation' not in zarr_file:
                print(f"No user_annotation group found in Zarr file. Nothing to delete.")
                return {"message": "Success", "affected_nuclei": 0, "reassigned_to": None}
            
            user_annotation_group = zarr_file['user_annotation']
            base_name = 'nuclei_annotations'
            
            # Only support structured array format
            if base_name not in user_annotation_group:
                logger.info(f"[delete_class] No nuclei_annotations found in user_annotation group. Nothing to delete.")
                return {"message": "Success", "affected_nuclei": 0, "reassigned_to": None}
            
            try:
                # Load structured array
                manual_annotations = np.array(user_annotation_group[base_name][:])
                cell_class_ids = manual_annotations['cell_class']
                
                # Get class_names from metadata to find class index
                class_names = None
                if 'class_names' in user_annotation_group.attrs:
                    class_names = user_annotation_group.attrs.get('class_names', [])
                
                if not class_names:
                    return {"message": "Error", "error": "No class_names found in metadata"}
                
                # Find class index
                try:
                    class_index = class_names.index(class_name)
                except ValueError:
                    print(f"Class '{class_name}' not found in class_names")
                    return {"message": "Success", "affected_nuclei": 0, "reassigned_to": None}
                
                # Remove the deleted class from class_names and class_colors in metadata
                # This ensures the colormap is updated immediately
                if 'class_colors' in user_annotation_group.attrs:
                    class_colors = user_annotation_group.attrs.get('class_colors', [])
                    if class_index < len(class_colors):
                        # Remove the deleted class from both lists
                        updated_class_names = [name for i, name in enumerate(class_names) if i != class_index]
                        updated_class_colors = [color for i, color in enumerate(class_colors) if i != class_index]
                        user_annotation_group.attrs['class_names'] = updated_class_names
                        user_annotation_group.attrs['class_colors'] = updated_class_colors
                        print(f"Removed '{class_name}' from user_annotation.attrs['class_names'] and ['class_colors']")
                        # Update class_names variable for subsequent processing
                        class_names = updated_class_names
                
                # Count affected nuclei
                affected = np.sum(cell_class_ids == class_index)
                
                if affected == 0:
                    print(f"Class '{class_name}' (index {class_index}) not found in user_annotation")
                    return {"message": "Success", "affected_nuclei": 0, "reassigned_to": None}
                
                # Clear annotations for this class (set to -1 = unclassified)
                mask = cell_class_ids == class_index
                manual_annotations['cell_class'][mask] = -1
                manual_annotations['cell_color'][mask] = -1  # -1 means not set (0 = black is a valid color)
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
                
            except Exception as e:
                print(f"[Error] Failed to delete class from structured array format: {e}")
                return {"message": f"Error: {str(e)}", "affected_nuclei": 0, "reassigned_to": None}
            
            # Update class_counts
            if 'class_counts' in user_annotation_group:
                try:
                    raw_counts = user_annotation_group['class_counts'][()]
                    counts_dict = json.loads(raw_counts.decode('utf-8') if isinstance(raw_counts, (bytes, bytearray)) else raw_counts)
                    counts_dict.pop(class_name, None)  # Remove the deleted class
                    
                    del user_annotation_group['class_counts']
                    user_annotation_group.create_dataset('class_counts', 
                                                       data=json.dumps(counts_dict).encode('utf-8'))
                except Exception as e:
                    print(f"Warning: Failed to update class_counts: {e}")
            
            # Update user_annotation.attrs and ClassificationNode with remaining class information
            try:
                # Extract remaining class names and colors from structured array
                remaining_classes = {}
                manual_annotations = np.array(user_annotation_group[base_name][:])
                cell_class_ids = manual_annotations['cell_class']
                cell_color_data = manual_annotations['cell_color']
                
                # Get class_names from metadata
                class_names = None
                if 'class_names' in user_annotation_group.attrs:
                    class_names = user_annotation_group.attrs.get('class_names', [])
                
                if class_names:
                    # Find all non-empty annotations (new format: -1 = unclassified, 0+ = class index)
                    # cell_color is now int32 (-1 = not set, 0 = black is valid)
                    non_empty_mask = (cell_class_ids >= 0) & (cell_color_data >= 0)
                    if np.any(non_empty_mask):
                        valid_class_ids = cell_class_ids[non_empty_mask]
                        valid_colors_int = cell_color_data[non_empty_mask]
                        # Convert integer colors to hex strings for processing
                        from app.services.tasks_service import _int_color_to_hex
                        valid_colors = [_int_color_to_hex(c) for c in valid_colors_int]
                        # Get unique class IDs
                        unique_class_ids = np.unique(valid_class_ids)
                        for class_id in unique_class_ids:
                            if 0 <= class_id < len(class_names):
                                cls_name = class_names[class_id]
                                # Find first occurrence of this class to get its color
                                first_idx = np.where(valid_class_ids == class_id)[0]
                                if len(first_idx) > 0:
                                    cls_color = valid_colors[first_idx[0]]
                                    if cls_color:
                                        remaining_classes[cls_name] = cls_color
                
                if remaining_classes:
                    # Update user_annotation.attrs with remaining classes (this is the primary colormap)
                    remaining_class_names = list(remaining_classes.keys())
                    remaining_class_colors = list(remaining_classes.values())
                    
                    user_annotation_group.attrs['class_names'] = remaining_class_names
                    user_annotation_group.attrs['class_colors'] = remaining_class_colors
                    
                    print(f"Updated user_annotation.attrs with {len(remaining_class_names)} remaining classes: {remaining_class_names}")
                    
                    # Also update ClassificationNode attributes with remaining classes
                    if 'ClassificationNode' in zarr_file:
                        classification_group = zarr_file['ClassificationNode']
                        classification_group.attrs['class_names'] = remaining_class_names
                        classification_group.attrs['class_colors'] = remaining_class_colors
                        classification_group.attrs['last_updated'] = time.time()
                        
                        print(f"Updated ClassificationNode with {len(remaining_class_names)} remaining classes: {remaining_class_names}")
                else:
                    print("No remaining classes found, user_annotation.attrs and ClassificationNode not updated")
                        
            except Exception as e:
                print(f"Warning: Failed to update user_annotation.attrs and ClassificationNode: {e}")
            
            print(f"Removed class '{class_name}' from user_annotation: {affected} nuclei affected")
            
            # Invalidate caches so future reads reflect changes
            self.invalidate_user_counts_cache()
            
            return {"message": "Success", "affected_nuclei": affected, "reassigned_to": reassigned_to_name}
