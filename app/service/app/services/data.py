import asyncio
import os
import re
import json
import shutil
import time
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Union, Tuple, Set

import numpy as np
import zarr
from zarr.sync import ThreadSynchronizer, ProcessSynchronizer

from app.utils import resolve_path
from app.utils.h5_to_zarr import (
    ConversionConfig,
    convert_h5_to_zarr,
    test_zarr_file,
)

# Global cache for synchronizers to ensure same file uses same instance
_synchronizer_cache: Dict[str, Union[ThreadSynchronizer, ProcessSynchronizer]] = {}
_synchronizer_cache_lock = threading.Lock()

def get_zarr_synchronizer(file_path: str, use_process_sync: bool = None):
    """Get or create a Zarr synchronizer for the given file path.
    
    This function caches synchronizer instances per file path to ensure that
    all operations on the same Zarr file use the same synchronizer instance,
    which is critical for proper thread-safe coordination.
    
    The implementation uses double-checked locking pattern to minimize lock
    contention and avoid deadlocks. The cache lock is held only briefly for
    cache lookup/creation, and is released before any zarr file operations.
    
    Args:
        file_path: Path to the Zarr file (will be normalized to absolute path)
        use_process_sync: If True, use ProcessSynchronizer for multi-process access.
                         If False, use ThreadSynchronizer for single-process multi-thread access.
                         If None, use the default from environment variable or False.
    
    Returns:
        ThreadSynchronizer or ProcessSynchronizer instance (cached per file path)
    """
    # Normalize file path to ensure consistent caching
    abs_file_path = os.path.abspath(os.path.normpath(file_path))
    
    # Check environment variable for default behavior
    if use_process_sync is None:
        use_process_sync = os.getenv('ZARR_USE_PROCESS_SYNC', 'false').lower() in ('true', '1', 'yes')
    
    if use_process_sync:
        # Use ProcessSynchronizer for multi-process access
        # Use a dedicated sync directory, separate from the Zarr file
        sync_dir = os.path.join(os.path.dirname(abs_file_path), ".zarr_sync")
        
        # Double-checked locking: check cache first without lock (fast path)
        if sync_dir in _synchronizer_cache:
            return _synchronizer_cache[sync_dir]
        
        # Create directory outside of lock to minimize lock hold time
        os.makedirs(sync_dir, exist_ok=True)
        
        # Acquire lock only for cache update (minimal lock hold time)
        with _synchronizer_cache_lock:
            # Check again inside lock (double-check)
            if sync_dir not in _synchronizer_cache:
                _synchronizer_cache[sync_dir] = ProcessSynchronizer(sync_dir)
            return _synchronizer_cache[sync_dir]
    else:
        # Use ThreadSynchronizer for single-process multi-thread access
        # Cache by file path to ensure same file uses same synchronizer
        
        # Double-checked locking: check cache first without lock (fast path)
        if abs_file_path in _synchronizer_cache:
            return _synchronizer_cache[abs_file_path]
        
        # Acquire lock only for cache update (minimal lock hold time)
        with _synchronizer_cache_lock:
            # Check again inside lock (double-check)
            if abs_file_path not in _synchronizer_cache:
                _synchronizer_cache[abs_file_path] = ThreadSynchronizer()
            return _synchronizer_cache[abs_file_path]


class ZarrFileHandler:
    """Zarr file handler, based on Zarr 3.0 standard"""
    
    def __init__(self, file_path: str):
        self.file_path = file_path
        self.store = None
        self.root = None
        self._validate_file()
    
    def _validate_file(self):
        """Validate if file exists and is in Zarr format"""
        if not Path(self.file_path).exists():
            raise FileNotFoundError(f"File not found: {self.file_path}")
        
        try:
            # Get synchronizer for thread-safe access
            synchronizer = get_zarr_synchronizer(self.file_path)
            # Open as Zarr store with synchronizer
            self.store = zarr.open(self.file_path, mode='r', synchronizer=synchronizer)
        except Exception as e:
            raise ValueError(f"Invalid Zarr file: {str(e)}")
    
    def __enter__(self):
        # Get synchronizer for thread-safe access
        synchronizer = get_zarr_synchronizer(self.file_path)
        # Open as Zarr store with synchronizer
        self.root = zarr.open(self.file_path, mode='r', synchronizer=synchronizer)
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.root:
            # Zarr handles cleanup automatically
            pass
    
    def _get_object_by_path(self, path: str):
        """Helper method to get object by path, handling root path '/'"""
        if path == "/":
            return self.root
        else:
            return self.root[path]
    
    def get_file_info(self) -> Dict[str, Any]:
        """Get basic file information"""
        with self:
            file_path_obj = Path(self.file_path)
            file_stats = file_path_obj.stat()
            
            # Calculate total disk size by recursively summing all files in the zarr directory
            def calculate_directory_size(directory: Path) -> int:
                """Recursively calculate total size of all files in a directory"""
                total_size = 0
                try:
                    if directory.is_file():
                        return directory.stat().st_size
                    elif directory.is_dir():
                        for item in directory.rglob('*'):
                            if item.is_file():
                                try:
                                    total_size += item.stat().st_size
                                except (OSError, PermissionError):
                                    # Skip files that can't be accessed
                                    pass
                except (OSError, PermissionError):
                    # If we can't access the directory, return 0
                    pass
                return total_size
            
            # Calculate actual disk size of zarr directory
            total_disk_size = calculate_directory_size(file_path_obj)
            
            # Count groups and arrays
            total_groups = 0
            total_arrays = 0
            
            def count_objects(obj, path=""):
                nonlocal total_groups, total_arrays
                if isinstance(obj, zarr.Group):
                    # It's a group
                    total_groups += 1
                    for key in obj.keys():
                        try:
                            child = obj[key]
                            if isinstance(child, zarr.Group):
                                count_objects(child, f"{path}/{key}")
                            elif isinstance(child, zarr.Array):
                                total_arrays += 1
                        except Exception as e:
                            print(f"[WARN] Error accessing child {path}/{key}: {e}")
                elif isinstance(obj, zarr.Array):
                    total_arrays += 1
            
            count_objects(self.root)
            
            # Get file attributes
            file_attrs = {}
            if hasattr(self.root, 'attrs'):
                for attr_name in self.root.attrs.keys():
                    try:
                        attr_value = self.root.attrs[attr_name]
                        file_attrs[attr_name] = self._convert_zarr_value(attr_value)
                    except:
                        file_attrs[attr_name] = "<unreadable>"
            
            return {
                "file_path": self.file_path,
                "file_size": total_disk_size if total_disk_size > 0 else file_stats.st_size,
                "zarr_version": zarr.__version__,
                "root_group_name": "/",
                "total_groups": total_groups,
                "total_arrays": total_arrays,
                "file_attributes": file_attrs,
                "last_modified": datetime.fromtimestamp(file_stats.st_mtime).isoformat()
            }
    
    def get_structure(self, path: str = "/", include_attributes: bool = True, 
                     max_depth: int = -1, current_depth: int = 0) -> Dict[str, Any]:
        """Recursively get file structure"""
        with self:
            try:
                obj = self._get_object_by_path(path)
            except KeyError:
                return None
            
            result = {
                "name": path.split('/')[-1] if path != "/" else "/",
                "full_path": path,
                "type": "group" if isinstance(obj, zarr.Group) else "array"
            }
            
            # Add attributes
            if include_attributes:
                result["attributes"] = self._get_attributes(obj)
            
            # If it's a group, add children
            if isinstance(obj, zarr.Group):
                result["children"] = []
                if max_depth == -1 or current_depth < max_depth:
                    for key in obj.keys():
                        child_path = f"{path}/{key}" if path != "/" else f"/{key}"
                        child_info = self.get_structure(
                            child_path, include_attributes, max_depth, current_depth + 1
                        )
                        if child_info:
                            result["children"].append(child_info)
                
                result["member_count"] = len(obj.keys())
            
            # If it's an array, add array information
            elif isinstance(obj, zarr.Array):
                result.update(self._get_array_info(obj, path))
            
            return result
    

    def get_group_info(self, group_path: str, include_arrays: bool = True, 
                      include_subgroups: bool = True) -> Optional[Dict[str, Any]]:
        """Get detailed group information"""
        with self:
            try:
                group = self._get_object_by_path(group_path)
                if not isinstance(group, zarr.Group):
                    return None
            except KeyError:
                return None
            
            result = {
                "name": group_path.split('/')[-1] if group_path != "/" else "/",
                "full_path": group_path,
                "type": "group",
                "attributes": self._get_attributes(group),
                "member_count": len(group.keys())
            }
            
            if include_arrays:
                arrays = []
                for key in group.keys():
                    obj = group[key]
                    if isinstance(obj, zarr.Array):
                        array_path = f"{group_path}/{key}" if group_path != "/" else f"/{key}"
                        array_info = {
                            "name": key,
                            "full_path": array_path,
                            "type": "array"
                        }
                        array_info.update(self._get_array_info(obj, array_path))
                        arrays.append(array_info)
                result["arrays"] = arrays
            
            if include_subgroups:
                subgroups = []
                for key in group.keys():
                    obj = group[key]
                    if isinstance(obj, zarr.Group):
                        subgroups.append({
                            "name": key,
                            "full_path": f"{group_path}/{key}" if group_path != "/" else f"/{key}",
                            "type": "group",
                            "member_count": len(obj.keys())
                        })
                result["subgroups"] = subgroups
            
            return result
    
    def get_array_info(self, array_path: str, include_preview: bool = False, 
                        preview_size: int = 10, page: Optional[int] = None, 
                        limit: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """Get detailed array information with optional pagination"""
        with self:
            try:
                array = self._get_object_by_path(array_path)
                if not isinstance(array, zarr.Array):
                    return None
            except KeyError:
                return None
            
            result = {
                "name": array_path.split('/')[-1],
                "full_path": array_path,
                "type": "array",
                "attributes": self._get_attributes(array)
            }
            
            result.update(self._get_array_info(array, array_path))
            
            # Special handling for user_annotation/nuclei_annotations and tissue_annotations
            # Check if this is the nuclei_annotations or tissue_annotations array in user_annotation group
            normalized_path = array_path.strip('/')
            is_nuclei_annotations = (
                normalized_path == 'user_annotation/nuclei_annotations' or
                normalized_path.endswith('/user_annotation/nuclei_annotations') or
                array_path.endswith('/nuclei_annotations') and 'user_annotation' in array_path
            )
            is_tissue_annotations = (
                normalized_path == 'user_annotation/tissue_annotations' or
                normalized_path.endswith('/user_annotation/tissue_annotations') or
                array_path.endswith('/tissue_annotations') and 'user_annotation' in array_path
            )
            
            # Get class_names for nuclei_annotations and tissue_annotations to include in response
            if is_nuclei_annotations or is_tissue_annotations:
                try:
                    parent_path = array_path.rsplit('/', 1)[0]
                    user_anno_group = self._get_object_by_path(parent_path)
                    if isinstance(user_anno_group, zarr.Group) and hasattr(user_anno_group, 'attrs'):
                        # For tissue_annotations, use tissue_class_names; for nuclei_annotations, use class_names
                        attr_name = 'tissue_class_names' if is_tissue_annotations else 'class_names'
                        
                        if attr_name in user_anno_group.attrs:
                            class_names_raw = user_anno_group.attrs[attr_name]
                            # Handle different formats
                            if isinstance(class_names_raw, (list, tuple)):
                                result["class_names"] = [str(name) for name in class_names_raw]
                            elif isinstance(class_names_raw, np.ndarray):
                                if class_names_raw.dtype.kind == 'S':
                                    result["class_names"] = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in class_names_raw]
                                else:
                                    result["class_names"] = [str(name) for name in class_names_raw]
                except Exception as e:
                    # If we can't get class_names, just continue without them
                    print(f"[get_array_info] Failed to get {attr_name if 'attr_name' in locals() else 'class_names'} for {array_path}: {e}")
                    pass
            
            if include_preview and array.size > 0:
                try:
                    if page is not None and limit is not None:
                        # Pagination mode
                        if is_nuclei_annotations:
                            # Special handling for nuclei_annotations: filter valid annotations and show simplified format
                            preview_data, preview_shape, total_items = self._get_nuclei_annotations_preview_paginated(array, page, limit, array_path)
                        elif is_tissue_annotations:
                            # Special handling for tissue_annotations: parse JSON format and show simplified format
                            preview_data, preview_shape, total_items = self._get_tissue_annotations_preview_paginated(array, page, limit, array_path)
                        else:
                            preview_data, preview_shape, total_items = self._get_array_preview_paginated(array, page, limit)
                        result["preview"] = preview_data
                        result["preview_shape"] = preview_shape
                        result["preview_total"] = total_items
                        result["preview_page"] = page
                        result["preview_limit"] = limit
                        result["preview_total_pages"] = (total_items + limit - 1) // limit  # Ceiling division
                    else:
                        # Legacy mode: use preview_size
                        if is_nuclei_annotations:
                            # For nuclei_annotations, still use pagination with default page size
                            preview_data, preview_shape, total_items = self._get_nuclei_annotations_preview_paginated(array, 1, preview_size, array_path)
                        elif is_tissue_annotations:
                            # For tissue_annotations, still use pagination with default page size
                            preview_data, preview_shape, total_items = self._get_tissue_annotations_preview_paginated(array, 1, preview_size, array_path)
                        else:
                            preview_data, preview_shape = self._get_array_preview(array, preview_size)
                        result["preview"] = preview_data
                        result["preview_shape"] = preview_shape
                        if is_nuclei_annotations or is_tissue_annotations:
                            result["preview_total"] = total_items
                except Exception as e:
                    result["preview"] = f"<Error reading preview: {str(e)}>"
                    result["preview_shape"] = []
            
            return result
    
    def _get_array_preview(self, array, preview_size: int = 10) -> Tuple[Any, List[int]]:
        """Get array preview data, handling different data types safely"""
        try:
            # Handle scalar arrays
            if array.shape == ():
                data = array[...]
                return self._convert_zarr_value(data), []
            
            # Handle empty arrays
            if array.size == 0:
                return [], list(array.shape)
            
            # For string arrays, handle specially
            if array.dtype.kind in ['S', 'U', 'O']:  # Byte string, Unicode string, Object
                return self._handle_string_array_preview(array, preview_size)
            
            # For numeric arrays
            if array.size <= preview_size:
                preview_data = array[...]
            else:
                # For multidimensional arrays, take first few elements
                if len(array.shape) == 1:
                    preview_data = array[:preview_size]
                else:
                    # For multidimensional case, take first few elements from first dimension
                    slices = [slice(None)] * len(array.shape)
                    slices[0] = slice(min(preview_size, array.shape[0]))
                    preview_data = array[tuple(slices)]
            
            return self._convert_zarr_value(preview_data), list(preview_data.shape) if hasattr(preview_data, 'shape') else []
            
        except Exception as e:
            # If all else fails, return error message
            return f"<Cannot preview: {str(e)}>", []
    
    def _handle_string_array_preview(self, array, preview_size: int) -> Tuple[Any, List[int]]:
        """Handle string array preview safely"""
        try:
            if array.size == 1:
                # Single string value
                data = array[...]
                if isinstance(data, bytes):
                    try:
                        data = data.decode('utf-8')
                    except:
                        data = str(data)
                return data, []
            
            # Multiple string values
            if array.size <= preview_size:
                data = array[...]
            else:
                if len(array.shape) == 1:
                    data = array[:preview_size]
                else:
                    slices = [slice(None)] * len(array.shape)
                    slices[0] = slice(min(preview_size, array.shape[0]))
                    data = array[tuple(slices)]
            
            # Convert bytes to strings if needed
            if isinstance(data, np.ndarray):
                if data.dtype.kind == 'S':  # Byte strings
                    try:
                        data = np.array([item.decode('utf-8') if isinstance(item, bytes) else str(item) for item in data.flat]).reshape(data.shape)
                    except:
                        data = np.array([str(item) for item in data.flat]).reshape(data.shape)
            
            return self._convert_zarr_value(data), list(data.shape) if hasattr(data, 'shape') else []
            
        except Exception as e:
            return f"<String preview error: {str(e)}>", []
    
    def _get_array_preview_paginated(self, array, page: int, limit: int) -> Tuple[Any, List[int], int]:
        """Get paginated array preview data, handling different data types safely
        
        Returns:
            Tuple of (preview_data, preview_shape, total_items)
        """
        try:
            # Handle scalar arrays
            if array.shape == ():
                data = array[...]
                return self._convert_zarr_value(data), [], 1
            
            # Handle empty arrays
            if array.size == 0:
                return [], list(array.shape), 0
            
            # Calculate total items (flattened size for 1D, first dimension size for multi-D)
            if len(array.shape) == 1:
                total_items = array.shape[0]
            else:
                total_items = array.shape[0]
            
            # Calculate pagination indices
            start_idx = (page - 1) * limit
            end_idx = min(start_idx + limit, total_items)
            
            if start_idx >= total_items:
                # Page beyond available data
                return [], list(array.shape), total_items
            
            # For string arrays, handle specially
            if array.dtype.kind in ['S', 'U', 'O']:  # Byte string, Unicode string, Object
                return self._handle_string_array_preview_paginated(array, start_idx, end_idx, total_items)
            
            # For numeric arrays
            if len(array.shape) == 1:
                # 1D array: simple slicing
                preview_data = array[start_idx:end_idx]
            else:
                # Multi-dimensional array: slice first dimension
                slices = [slice(None)] * len(array.shape)
                slices[0] = slice(start_idx, end_idx)
                preview_data = array[tuple(slices)]
            
            # Convert to list for pagination (always return actual data, not summary)
            if isinstance(preview_data, np.ndarray):
                converted_data = preview_data.tolist()
            else:
                converted_data = self._convert_zarr_value(preview_data)
            return converted_data, list(preview_data.shape) if hasattr(preview_data, 'shape') else [], total_items
            
        except Exception as e:
            return f"<Cannot preview: {str(e)}>", [], 0
    
    def _get_nuclei_annotations_preview_paginated(self, array, page: int, limit: int, array_path: str = None) -> Tuple[Any, List[int], int]:
        """Special handling for user_annotation/nuclei_annotations structured array.
        
        Returns only valid annotations (cell_class >= 0 and cell_color >= 0) in a simplified format:
        - Each row is [cell_id, cell_class_name] where cell_class_name is the class name string
        - Total count only includes valid annotations, not all cells
        
        This matches the display format of nuclei_class_id array.
        """
        try:
            # Check if this is a structured array
            if not (hasattr(array.dtype, 'names') and array.dtype.names is not None):
                # Not a structured array, fall back to regular handling
                return self._get_array_preview_paginated(array, page, limit)
            
            # Read the entire structured array to filter valid annotations
            # Note: For very large arrays, this might be memory-intensive, but necessary for filtering
            full_array = array[:]
            
            # Extract fields
            if 'cell_class' not in array.dtype.names or 'cell_color' not in array.dtype.names:
                # Missing required fields, fall back to regular handling
                return self._get_array_preview_paginated(array, page, limit)
            
            cell_class_ids = full_array['cell_class']
            cell_color_data = full_array['cell_color']
            
            # Filter valid annotations: cell_class >= 0 and cell_color >= 0
            valid_mask = (cell_class_ids >= 0) & (cell_color_data >= 0)
            valid_indices = np.where(valid_mask)[0]
            valid_class_ids = cell_class_ids[valid_indices]
            
            # Calculate total items (only valid annotations)
            total_valid_items = len(valid_indices)
            
            if total_valid_items == 0:
                return [], [0, 2], 0
            
            # Try to get class_names from user_annotation group attributes
            class_names = None
            if array_path:
                try:
                    # Extract parent group path (user_annotation)
                    if 'user_annotation' in array_path:
                        # Get the user_annotation group
                        parent_path = array_path.rsplit('/', 1)[0]  # Get path before /nuclei_annotations
                        if parent_path.endswith('/user_annotation') or parent_path == 'user_annotation':
                            user_anno_group = self._get_object_by_path(parent_path)
                            if isinstance(user_anno_group, zarr.Group) and hasattr(user_anno_group, 'attrs'):
                                if 'class_names' in user_anno_group.attrs:
                                    class_names_raw = user_anno_group.attrs['class_names']
                                    # Handle different formats: list, numpy array, bytes
                                    if isinstance(class_names_raw, (list, tuple)):
                                        class_names = [str(name) for name in class_names_raw]
                                    elif isinstance(class_names_raw, np.ndarray):
                                        # Handle string arrays (bytes) or regular arrays
                                        if class_names_raw.dtype.kind == 'S':  # String/bytes array
                                            class_names = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in class_names_raw]
                                        else:
                                            class_names = [str(name) for name in class_names_raw]
                                    elif isinstance(class_names_raw, bytes):
                                        # Try to decode as JSON or split by newline
                                        try:
                                            class_names = json.loads(class_names_raw.decode('utf-8'))
                                        except:
                                            class_names = [class_names_raw.decode('utf-8')]
                                    else:
                                        class_names = [str(class_names_raw)]
                except Exception as e:
                    # If we can't get class_names, continue with numeric IDs
                    pass
            
            # Calculate pagination indices for valid items
            start_idx = (page - 1) * limit
            end_idx = min(start_idx + limit, total_valid_items)
            
            if start_idx >= total_valid_items:
                return [], [0, 2], total_valid_items
            
            # Get the paginated slice of valid annotations
            paginated_indices = valid_indices[start_idx:end_idx]
            paginated_class_ids = valid_class_ids[start_idx:end_idx]
            
            # Convert to simplified format: [[cell_id, cell_class_name], ...]
            # Convert class_id to class_name if available, otherwise use class_id as string
            converted_data = []
            for cell_id, class_id in zip(paginated_indices, paginated_class_ids):
                # Convert numpy types to Python native types
                cell_id_int = int(cell_id)
                class_id_int = int(class_id)
                
                # Convert class_id to class_name if class_names is available
                if class_names and 0 <= class_id_int < len(class_names):
                    class_name = class_names[class_id_int]
                else:
                    # Fall back to numeric ID if class_names not available or out of range
                    class_name = str(class_id_int)
                
                converted_data.append([cell_id_int, class_name])
            
            return converted_data, [len(converted_data), 2], total_valid_items
            
        except Exception as e:
            return f"<Error reading nuclei_annotations preview: {str(e)}>", [], 0
    
    def _get_tissue_annotations_preview_paginated(self, array, page: int, limit: int, array_path: str = None) -> Tuple[Any, List[int], int]:
        """Special handling for user_annotation/tissue_annotations JSON format.
        
        tissue_annotations is stored as a JSON-encoded string (bytes), not a structured array.
        The format is: {"patch_ID": {"patch_ID": int, "tissue_class": str, "annotator": str, "datetime": str, "method": str}, ...}
        
        Returns only valid annotations in a simplified format:
        - Each row is [patch_id, tissue_class_name]
        - Total count only includes valid annotations
        """
        try:
            # Read the array data - tissue_annotations is stored as bytes (JSON string)
            # For debugging: print array info
            print(f"[_get_tissue_annotations_preview_paginated] Reading tissue_annotations, array shape: {array.shape if hasattr(array, 'shape') else 'N/A'}, dtype: {array.dtype if hasattr(array, 'dtype') else 'N/A'}")
            
            # Handle 0-dimensional (scalar) arrays - use [()] instead of [:]
            if hasattr(array, 'shape') and array.shape == ():
                # Scalar array - use [()] to read
                raw_data = array[()]
            else:
                # Regular array - use [:] to read all
                raw_data = array[:]
            
            print(f"[_get_tissue_annotations_preview_paginated] Raw data type: {type(raw_data)}, size: {len(raw_data) if hasattr(raw_data, '__len__') else 'N/A'}")
            
            json_str = None
            
            # Handle different data types - tissue_annotations is typically stored as bytes
            # When zarr stores bytes, reading array[:] might return:
            # 1. Direct bytes object
            # 2. NumPy array with dtype 'S' (string/bytes)
            # 3. NumPy array with dtype 'O' (object, containing bytes)
            
            if isinstance(raw_data, bytes):
                # Direct bytes - decode to string
                json_str = raw_data.decode('utf-8')
                print(f"[_get_tissue_annotations_preview_paginated] Found direct bytes, decoded length: {len(json_str)}")
            elif isinstance(raw_data, np.ndarray):
                # NumPy array - could be various types
                if raw_data.size == 0:
                    print(f"[_get_tissue_annotations_preview_paginated] Array is empty")
                    return [], [0, 2], 0
                
                print(f"[_get_tissue_annotations_preview_paginated] NumPy array dtype.kind: {raw_data.dtype.kind}, shape: {raw_data.shape}")
                
                # Check dtype to determine how to extract the string
                if raw_data.dtype.kind == 'S':  # String/bytes array
                    # For 'S' type, might be a scalar or array
                    if raw_data.ndim == 0:
                        # Scalar array
                        json_str = raw_data.item()
                        if isinstance(json_str, bytes):
                            json_str = json_str.decode('utf-8')
                        else:
                            json_str = str(json_str)
                    else:
                        # Array - get first element
                        json_str = raw_data.flat[0]
                        if isinstance(json_str, bytes):
                            json_str = json_str.decode('utf-8')
                        else:
                            json_str = str(json_str)
                elif raw_data.dtype.kind == 'U':  # Unicode array
                    if raw_data.ndim == 0:
                        json_str = str(raw_data.item())
                    else:
                        json_str = str(raw_data.flat[0])
                elif raw_data.dtype.kind == 'O':  # Object array (Python objects)
                    # Object array might contain bytes or strings
                    if raw_data.ndim == 0:
                        first_elem = raw_data.item()
                    else:
                        first_elem = raw_data.flat[0]
                    if isinstance(first_elem, bytes):
                        json_str = first_elem.decode('utf-8')
                    else:
                        json_str = str(first_elem)
                else:
                    # Try to convert to string (might be a scalar array)
                    if raw_data.ndim == 0:
                        json_str = str(raw_data.item())
                    else:
                        json_str = str(raw_data.flat[0]) if raw_data.size > 0 else '{}'
            elif isinstance(raw_data, str):
                json_str = raw_data
            else:
                # Try to convert to string
                json_str = str(raw_data)
            
            print(f"[_get_tissue_annotations_preview_paginated] Extracted JSON string, length: {len(json_str) if json_str else 0}, first 200 chars: {json_str[:200] if json_str else 'None'}")
            
            if not json_str or json_str.strip() == '':
                return [], [0, 2], 0
            
            # Parse JSON
            try:
                annotations_dict = json.loads(json_str)
            except (json.JSONDecodeError, TypeError) as e:
                # Log the error for debugging but return empty
                print(f"[_get_tissue_annotations_preview_paginated] Failed to parse JSON: {e}, json_str length: {len(json_str) if json_str else 0}, first 200 chars: {json_str[:200] if json_str else 'None'}")
                return [], [0, 2], 0
            
            if not isinstance(annotations_dict, dict):
                return [], [0, 2], 0
            
            # Filter valid annotations (those with tissue_class)
            valid_annotations = []
            for patch_id_str, annotation_data in annotations_dict.items():
                if isinstance(annotation_data, dict) and 'tissue_class' in annotation_data:
                    tissue_class = annotation_data.get('tissue_class')
                    # Check if tissue_class is not None and not empty
                    if tissue_class is not None and str(tissue_class).strip():
                        try:
                            patch_id = int(patch_id_str)
                            valid_annotations.append((patch_id, str(tissue_class).strip()))
                        except (ValueError, TypeError):
                            continue
            
            # Sort by patch_id for consistent ordering
            valid_annotations.sort(key=lambda x: x[0])
            
            total_valid_items = len(valid_annotations)
            
            if total_valid_items == 0:
                return [], [0, 2], 0
            
            # Calculate pagination indices
            start_idx = (page - 1) * limit
            end_idx = min(start_idx + limit, total_valid_items)
            
            if start_idx >= total_valid_items:
                return [], [0, 2], total_valid_items
            
            # Get the paginated slice
            paginated_annotations = valid_annotations[start_idx:end_idx]
            
            # Convert to simplified format: [[patch_id, tissue_class_name], ...]
            converted_data = [[patch_id, class_name] for patch_id, class_name in paginated_annotations]
            
            return converted_data, [len(converted_data), 2], total_valid_items
            
        except Exception as e:
            # Log the full error for debugging
            print(f"[_get_tissue_annotations_preview_paginated] Error: {str(e)}")
            import traceback
            traceback.print_exc()
            return f"<Error reading tissue_annotations preview: {str(e)}>", [], 0
    
    def delete_nuclei_annotation(self, array_path: str, cell_id: int) -> Dict[str, Any]:
        """Delete a single annotation by setting cell_class and cell_color to -1.
        
        Args:
            array_path: Path to the nuclei_annotations or tissue_annotations array
            cell_id: The cell/patch ID (index) to delete
            
        Returns:
            Dict with success status and message
        """
        try:
            # Check if this is tissue_annotations (JSON format) or nuclei_annotations (structured array)
            normalized_path = array_path.strip('/')
            is_tissue_annotations = (
                normalized_path == 'user_annotation/tissue_annotations' or
                normalized_path.endswith('/user_annotation/tissue_annotations') or
                array_path.endswith('/tissue_annotations') and 'user_annotation' in array_path
            )
            
            # Open zarr file in write mode for deletion
            synchronizer = get_zarr_synchronizer(self.file_path)
            with zarr.open(self.file_path, mode='a', synchronizer=synchronizer) as zf:
                # Get the array from the write-enabled zarr file
                if array_path.startswith('/'):
                    array_path_clean = array_path[1:]  # Remove leading slash
                else:
                    array_path_clean = array_path
                
                if array_path_clean not in zf:
                    return {"success": False, "message": "Array not found"}
                
                array = zf[array_path_clean]
                
                if not isinstance(array, zarr.Array):
                    return {"success": False, "message": "Path does not point to an array"}
                
                # Handle tissue_annotations (JSON format)
                if is_tissue_annotations:
                    return self._delete_tissue_annotation(zf, array, array_path, cell_id)
                
                # Handle nuclei_annotations (structured array format)
                # Check if this is a structured array
                if not (hasattr(array.dtype, 'names') and array.dtype.names is not None):
                    return {"success": False, "message": "Not a structured array"}
                
                # Check if cell_id is within bounds
                if cell_id < 0 or cell_id >= array.size:
                    return {"success": False, "message": f"Cell ID {cell_id} out of range (0-{array.size-1})"}
                
                # Read the structured array
                full_array = array[:]
                
                # Check required fields
                if 'cell_class' not in array.dtype.names or 'cell_color' not in array.dtype.names:
                    return {"success": False, "message": "Missing required fields (cell_class, cell_color)"}
                
                # Check if this cell is actually annotated (cell_class >= 0 and cell_color >= 0)
                if full_array['cell_class'][cell_id] < 0 or full_array['cell_color'][cell_id] < 0:
                    return {"success": False, "message": f"Cell {cell_id} is not annotated (already deleted or never annotated)"}
                
                # Get the old class name before deleting (for updating counts)
                old_class_index = int(full_array['cell_class'][cell_id])
                old_class_name = None
                
                # Get class_names from user_annotation group to find the class name
                if 'user_annotation' in array_path:
                    parent_path = array_path.rsplit('/', 1)[0]
                    if parent_path.startswith('/'):
                        parent_path_clean = parent_path[1:]
                    else:
                        parent_path_clean = parent_path
                    
                    if parent_path_clean in zf:
                        user_anno_group = zf[parent_path_clean]
                        if isinstance(user_anno_group, zarr.Group) and hasattr(user_anno_group, 'attrs'):
                            if 'class_names' in user_anno_group.attrs:
                                class_names_raw = user_anno_group.attrs['class_names']
                                # Handle different formats
                                if isinstance(class_names_raw, (list, tuple)):
                                    class_names = [str(name) for name in class_names_raw]
                                elif isinstance(class_names_raw, np.ndarray):
                                    if class_names_raw.dtype.kind == 'S':
                                        class_names = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in class_names_raw]
                                    else:
                                        class_names = [str(name) for name in class_names_raw]
                                
                                if class_names and 0 <= old_class_index < len(class_names):
                                    old_class_name = class_names[old_class_index]
                
                # Delete the annotation by setting to -1
                full_array['cell_class'][cell_id] = -1
                full_array['cell_color'][cell_id] = -1
                
                # Clear other annotation fields if they exist
                if 'annotator' in array.dtype.names:
                    full_array['annotator'][cell_id] = ''
                if 'datetime' in array.dtype.names:
                    if full_array['datetime'].dtype.kind in ['i', 'u']:
                        full_array['datetime'][cell_id] = 0
                if 'method' in array.dtype.names:
                    full_array['method'][cell_id] = ''
                if 'region_x1' in array.dtype.names:
                    full_array['region_x1'][cell_id] = -1
                    if 'region_y1' in array.dtype.names:
                        full_array['region_y1'][cell_id] = -1
                    if 'region_x2' in array.dtype.names:
                        full_array['region_x2'][cell_id] = -1
                    if 'region_y2' in array.dtype.names:
                        full_array['region_y2'][cell_id] = -1
                
                # Write back to zarr (now in write mode)
                array[:] = full_array
                
                # Update class_counts in user_annotation group (decrement count)
                if old_class_name and 'user_annotation' in array_path:
                    try:
                        parent_path = array_path.rsplit('/', 1)[0]
                        if parent_path.startswith('/'):
                            parent_path_clean = parent_path[1:]
                        else:
                            parent_path_clean = parent_path
                        
                        if parent_path_clean in zf:
                            user_anno_group = zf[parent_path_clean]
                            if isinstance(user_anno_group, zarr.Group):
                                counts_ds_name = "class_counts"
                                counts_dict = {}
                                
                                # Load existing counts
                                if counts_ds_name in user_anno_group:
                                    counts_raw = user_anno_group[counts_ds_name][()]
                                    if counts_raw:
                                        try:
                                            if isinstance(counts_raw, bytes):
                                                counts_dict = json.loads(counts_raw.decode("utf-8"))
                                            else:
                                                counts_dict = json.loads(counts_raw) if isinstance(counts_raw, str) else counts_raw
                                        except Exception:
                                            counts_dict = {}
                                
                                # Decrement old class count
                                if old_class_name in counts_dict:
                                    counts_dict[old_class_name] = max(0, counts_dict[old_class_name] - 1)
                                    if counts_dict[old_class_name] == 0:
                                        del counts_dict[old_class_name]
                                
                                # Save updated counts
                                counts_out_str = json.dumps(counts_dict, ensure_ascii=False)
                                counts_bytes = counts_out_str.encode("utf-8")
                                
                                if counts_ds_name in user_anno_group:
                                    existing_ds = user_anno_group[counts_ds_name]
                                    if existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                                        existing_ds[()] = counts_bytes
                                    else:
                                        del user_anno_group[counts_ds_name]
                                        user_anno_group.create_dataset(counts_ds_name, data=counts_bytes)
                                else:
                                    user_anno_group.create_dataset(counts_ds_name, data=counts_bytes)
                    except Exception:
                        # Log error but don't fail the delete - the annotation was already deleted
                        pass
                
                return {"success": True, "message": f"Annotation for cell {cell_id} deleted successfully"}
            
        except Exception as e:
            return {"success": False, "message": f"Error deleting annotation: {str(e)}"}
    
    def update_nuclei_annotation_class(self, array_path: str, cell_id: int, new_class_name: str) -> Dict[str, Any]:
        """Update the cell_class for a single annotation.
        
        Args:
            array_path: Path to the nuclei_annotations or tissue_annotations array
            cell_id: The cell/patch ID (index) to update
            new_class_name: The new class name to assign
            
        Returns:
            Dict with success status and message
        """
        try:
            # Check if this is tissue_annotations (JSON format) or nuclei_annotations (structured array)
            normalized_path = array_path.strip('/')
            is_tissue_annotations = (
                normalized_path == 'user_annotation/tissue_annotations' or
                normalized_path.endswith('/user_annotation/tissue_annotations') or
                array_path.endswith('/tissue_annotations') and 'user_annotation' in array_path
            )
            
            # Open zarr file in write mode for update
            synchronizer = get_zarr_synchronizer(self.file_path)
            with zarr.open(self.file_path, mode='a', synchronizer=synchronizer) as zf:
                # Get the array from the write-enabled zarr file
                if array_path.startswith('/'):
                    array_path_clean = array_path[1:]  # Remove leading slash
                else:
                    array_path_clean = array_path
                
                if array_path_clean not in zf:
                    return {"success": False, "message": "Array not found"}
                
                array = zf[array_path_clean]
                
                if not isinstance(array, zarr.Array):
                    return {"success": False, "message": "Path does not point to an array"}
                
                # Handle tissue_annotations (JSON format)
                if is_tissue_annotations:
                    return self._update_tissue_annotation_class(zf, array, array_path, cell_id, new_class_name)
                
                # Handle nuclei_annotations (structured array format)
                # Check if this is a structured array
                if not (hasattr(array.dtype, 'names') and array.dtype.names is not None):
                    return {"success": False, "message": "Not a structured array"}
                
                # Check if cell_id is within bounds
                if cell_id < 0 or cell_id >= array.size:
                    return {"success": False, "message": f"Cell ID {cell_id} out of range (0-{array.size-1})"}
                
                # Get class_names from user_annotation group to find the class index
                class_names = None
                if 'user_annotation' in array_path:
                    parent_path = array_path.rsplit('/', 1)[0]
                    if parent_path.startswith('/'):
                        parent_path_clean = parent_path[1:]
                    else:
                        parent_path_clean = parent_path
                    
                    if parent_path_clean in zf:
                        user_anno_group = zf[parent_path_clean]
                        if isinstance(user_anno_group, zarr.Group) and hasattr(user_anno_group, 'attrs'):
                            if 'class_names' in user_anno_group.attrs:
                                class_names_raw = user_anno_group.attrs['class_names']
                                # Handle different formats
                                if isinstance(class_names_raw, (list, tuple)):
                                    class_names = [str(name) for name in class_names_raw]
                                elif isinstance(class_names_raw, np.ndarray):
                                    if class_names_raw.dtype.kind == 'S':
                                        class_names = [name.decode('utf-8') if isinstance(name, bytes) else str(name) for name in class_names_raw]
                                    else:
                                        class_names = [str(name) for name in class_names_raw]
                
                if not class_names:
                    return {"success": False, "message": "Could not retrieve class names from metadata"}
                
                # Find the index of the new class name
                try:
                    new_class_index = class_names.index(new_class_name)
                except ValueError:
                    return {"success": False, "message": f"Class name '{new_class_name}' not found in available classes"}
                
                # Read the structured array
                full_array = array[:]
                
                # Check required fields
                if 'cell_class' not in array.dtype.names or 'cell_color' not in array.dtype.names:
                    return {"success": False, "message": "Missing required fields (cell_class, cell_color)"}
                
                # Check if this cell is actually annotated
                if full_array['cell_class'][cell_id] < 0 or full_array['cell_color'][cell_id] < 0:
                    return {"success": False, "message": f"Cell {cell_id} is not annotated (cannot update unannotated cell)"}
                
                # Get the old class index and name before updating
                old_class_index = int(full_array['cell_class'][cell_id])
                old_class_name = class_names[old_class_index] if 0 <= old_class_index < len(class_names) else None
                
                # Update the cell_class
                full_array['cell_class'][cell_id] = new_class_index
                
                # Write back to zarr
                array[:] = full_array
                
                # Update class_counts in user_annotation group
                try:
                    if parent_path_clean in zf:
                        user_anno_group = zf[parent_path_clean]
                        if isinstance(user_anno_group, zarr.Group):
                            counts_ds_name = "class_counts"
                            counts_dict = {}
                            
                            # Load existing counts
                            if counts_ds_name in user_anno_group:
                                counts_raw = user_anno_group[counts_ds_name][()]
                                if counts_raw:
                                    try:
                                        if isinstance(counts_raw, bytes):
                                            counts_dict = json.loads(counts_raw.decode("utf-8"))
                                        else:
                                            counts_dict = json.loads(counts_raw) if isinstance(counts_raw, str) else counts_raw
                                    except Exception as e:
                                        # If parsing fails, start fresh
                                        counts_dict = {}
                            
                            # Decrement old class count
                            if old_class_name:
                                if old_class_name in counts_dict:
                                    counts_dict[old_class_name] = max(0, counts_dict[old_class_name] - 1)
                                    if counts_dict[old_class_name] == 0:
                                        # Remove zero counts to keep dict clean
                                        del counts_dict[old_class_name]
                            
                            # Increment new class count
                            if new_class_name not in counts_dict:
                                counts_dict[new_class_name] = 0
                            counts_dict[new_class_name] = counts_dict[new_class_name] + 1
                            
                            # Save updated counts
                            counts_out_str = json.dumps(counts_dict, ensure_ascii=False)
                            counts_bytes = counts_out_str.encode("utf-8")
                            
                            if counts_ds_name in user_anno_group:
                                existing_ds = user_anno_group[counts_ds_name]
                                # Try to overwrite in-place if size allows
                                if existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                                    existing_ds[()] = counts_bytes
                                else:
                                    # Size mismatch - need to replace
                                    del user_anno_group[counts_ds_name]
                                    user_anno_group.create_dataset(counts_ds_name, data=counts_bytes)
                            else:
                                # Create new dataset
                                user_anno_group.create_dataset(counts_ds_name, data=counts_bytes)
                except Exception as e:
                    # Log error but don't fail the update - the annotation was already updated
                    # The counts will be recalculated on next save_annotation call
                    pass
                
                return {"success": True, "message": f"Annotation for cell {cell_id} updated to '{new_class_name}' successfully"}
            
        except Exception as e:
            return {"success": False, "message": f"Error updating annotation: {str(e)}"}
    
    def _update_tissue_annotation_class(self, zf, array, array_path: str, patch_id: int, new_class_name: str) -> Dict[str, Any]:
        """Update the tissue_class for a single tissue annotation (JSON format).
        
        Args:
            zf: Open Zarr file object
            array: The tissue_annotations array
            array_path: Path to the tissue_annotations array
            patch_id: The patch ID to update
            new_class_name: The new class name to assign
            
        Returns:
            Dict with success status and message
        """
        try:
            # Read the JSON data
            if hasattr(array, 'shape') and array.shape == ():
                # Scalar array - use [()] to read
                raw_data = array[()]
            else:
                raw_data = array[:]
            
            # Convert to JSON string
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
                    json_str = str(raw_data.flat[0]) if raw_data.size > 0 else '{}'
            elif isinstance(raw_data, str):
                json_str = raw_data
            else:
                json_str = str(raw_data)
            
            # Parse JSON
            try:
                annotations_dict = json.loads(json_str)
            except (json.JSONDecodeError, TypeError) as e:
                return {"success": False, "message": f"Failed to parse tissue_annotations JSON: {str(e)}"}
            
            if not isinstance(annotations_dict, dict):
                return {"success": False, "message": "tissue_annotations data is not a valid dictionary"}
            
            # Check if patch_id exists
            patch_id_str = str(patch_id)
            if patch_id_str not in annotations_dict:
                return {"success": False, "message": f"Patch ID {patch_id} not found in annotations"}
            
            annotation_data = annotations_dict[patch_id_str]
            if not isinstance(annotation_data, dict):
                return {"success": False, "message": f"Invalid annotation data for patch {patch_id}"}
            
            # Get old class name
            old_class_name = annotation_data.get('tissue_class', 'Unknown')
            
            # Update the tissue_class
            annotation_data['tissue_class'] = new_class_name
            
            # Update the dictionary
            annotations_dict[patch_id_str] = annotation_data
            
            # Convert back to JSON string
            updated_json_str = json.dumps(annotations_dict, ensure_ascii=False)
            
            # Write back to zarr array
            # For scalar arrays, we need to encode as bytes
            encoded_bytes = updated_json_str.encode('utf-8')
            
            if hasattr(array, 'shape') and array.shape == ():
                # Scalar array - encode and write
                # Check if it fits in the array's dtype
                if hasattr(array, 'dtype') and array.dtype.kind == 'S':
                    max_len = array.dtype.itemsize
                    if len(encoded_bytes) > max_len:
                        # Need to recreate the dataset with larger size
                        # Get the dataset name from the path
                        dataset_name = array_path.rsplit('/', 1)[-1]
                        parent_path = array_path.rsplit('/', 1)[0]
                        if parent_path.startswith('/'):
                            parent_path = parent_path[1:]
                        
                        if parent_path in zf:
                            parent_group = zf[parent_path]
                            # Delete old dataset and create new one with larger size
                            # Add 50% buffer for future growth
                            new_size = int(len(encoded_bytes) * 1.5)
                            del parent_group[dataset_name]
                            parent_group.create_dataset(
                                dataset_name, 
                                data=np.array(encoded_bytes, dtype=f'S{new_size}'),
                                shape=(),
                                dtype=f'S{new_size}'
                            )
                            print(f"[_update_tissue_annotation_class] Resized {dataset_name} from {max_len} to {new_size} bytes")
                        else:
                            return {"success": False, "message": f"Parent group not found: {parent_path}"}
                    else:
                        array[()] = encoded_bytes
                else:
                    array[()] = encoded_bytes
            else:
                # Regular array - encode and write
                array[:] = encoded_bytes
            
            # Update patch_class_counts in user_annotation group
            try:
                parent_path = array_path.rsplit('/', 1)[0]
                if parent_path.startswith('/'):
                    parent_path_clean = parent_path[1:]
                else:
                    parent_path_clean = parent_path
                
                if parent_path_clean in zf:
                    user_anno_group = zf[parent_path_clean]
                    if isinstance(user_anno_group, zarr.Group):
                        counts_ds_name = "patch_class_counts"
                        counts_dict = {}
                        
                        # Load existing counts
                        if counts_ds_name in user_anno_group:
                            counts_dataset = user_anno_group[counts_ds_name]
                            # Handle scalar array (0-dimensional)
                            if hasattr(counts_dataset, 'shape') and counts_dataset.shape == ():
                                counts_raw = counts_dataset[()]
                            else:
                                counts_raw = counts_dataset[:]
                            
                            if isinstance(counts_raw, bytes):
                                counts_dict = json.loads(counts_raw.decode('utf-8'))
                            elif isinstance(counts_raw, str):
                                counts_dict = json.loads(counts_raw)
                            elif isinstance(counts_raw, dict):
                                counts_dict = counts_raw
                            else:
                                # Try to decode if it's a numpy array
                                if isinstance(counts_raw, np.ndarray):
                                    if counts_raw.dtype.kind == 'S' or counts_raw.dtype.kind == 'U':
                                        if counts_raw.ndim == 0:
                                            json_str = str(counts_raw.item())
                                        else:
                                            json_str = str(counts_raw.flat[0])
                                        if isinstance(json_str, bytes):
                                            json_str = json_str.decode('utf-8')
                                        counts_dict = json.loads(json_str)
                                    else:
                                        counts_dict = {}
                                else:
                                    counts_dict = {}
                            
                            print(f"[_update_tissue_annotation_class] Loaded existing patch_class_counts: {counts_dict}")
                        else:
                            print(f"[_update_tissue_annotation_class] No existing patch_class_counts found, starting fresh")
                        
                        # Update counts: decrement old class, increment new class
                        if old_class_name and old_class_name in counts_dict:
                            old_count = counts_dict[old_class_name]
                            counts_dict[old_class_name] = max(0, old_count - 1)
                            print(f"[_update_tissue_annotation_class] Decremented '{old_class_name}': {old_count} -> {counts_dict[old_class_name]}")
                        
                        if new_class_name not in counts_dict:
                            counts_dict[new_class_name] = 0
                        old_new_count = counts_dict[new_class_name]
                        counts_dict[new_class_name] = counts_dict[new_class_name] + 1
                        print(f"[_update_tissue_annotation_class] Incremented '{new_class_name}': {old_new_count} -> {counts_dict[new_class_name]}")
                        
                        print(f"[_update_tissue_annotation_class] Updated patch_class_counts: {counts_dict}")
                        
                        # Save updated counts
                        counts_json = json.dumps(counts_dict, ensure_ascii=False)
                        counts_bytes = counts_json.encode('utf-8')
                        
                        if counts_ds_name in user_anno_group:
                            existing_ds = user_anno_group[counts_ds_name]
                            # Try to overwrite in-place if size allows (for scalar arrays)
                            if hasattr(existing_ds, 'shape') and existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                                existing_ds[()] = counts_bytes
                                print(f"[_update_tissue_annotation_class] Overwrote patch_class_counts in-place")
                            else:
                                # Size mismatch or not scalar - need to replace
                                del user_anno_group[counts_ds_name]
                                user_anno_group.create_dataset(counts_ds_name, data=counts_bytes)
                                print(f"[_update_tissue_annotation_class] Replaced patch_class_counts dataset")
                        else:
                            # Create new dataset
                            user_anno_group.create_dataset(counts_ds_name, data=counts_bytes)
                            print(f"[_update_tissue_annotation_class] Created new patch_class_counts dataset")
            except Exception as e:
                # Log but don't fail the update
                print(f"[_update_tissue_annotation_class] Warning: Failed to update patch_class_counts: {e}")
            
            return {"success": True, "message": f"Updated annotation for patch {patch_id} from '{old_class_name}' to '{new_class_name}'"}
            
        except Exception as e:
            return {"success": False, "message": f"Error updating tissue annotation: {str(e)}"}
    
    def _delete_tissue_annotation(self, zf, array, array_path: str, patch_id: int) -> Dict[str, Any]:
        """Delete a single tissue annotation (JSON format).
        
        Args:
            zf: Open Zarr file object
            array: The tissue_annotations array
            array_path: Path to the tissue_annotations array
            patch_id: The patch ID to delete
            
        Returns:
            Dict with success status and message
        """
        try:
            # Read the JSON data
            if hasattr(array, 'shape') and array.shape == ():
                # Scalar array - use [()] to read
                raw_data = array[()]
            else:
                raw_data = array[:]
            
            # Convert to JSON string
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
                    json_str = str(raw_data.flat[0]) if raw_data.size > 0 else '{}'
            elif isinstance(raw_data, str):
                json_str = raw_data
            else:
                json_str = str(raw_data)
            
            # Parse JSON
            try:
                annotations_dict = json.loads(json_str)
            except (json.JSONDecodeError, TypeError) as e:
                return {"success": False, "message": f"Failed to parse tissue_annotations JSON: {str(e)}"}
            
            if not isinstance(annotations_dict, dict):
                return {"success": False, "message": "tissue_annotations data is not a valid dictionary"}
            
            # Check if patch_id exists
            patch_id_str = str(patch_id)
            if patch_id_str not in annotations_dict:
                return {"success": False, "message": f"Patch ID {patch_id} not found in annotations"}
            
            annotation_data = annotations_dict[patch_id_str]
            if not isinstance(annotation_data, dict):
                return {"success": False, "message": f"Invalid annotation data for patch {patch_id}"}
            
            # Get old class name for updating counts
            old_class_name = annotation_data.get('tissue_class', 'Unknown')
            
            # Delete the annotation from the dictionary
            del annotations_dict[patch_id_str]
            print(f"[_delete_tissue_annotation] Deleted patch {patch_id} (class: {old_class_name})")
            
            # Convert back to JSON string
            updated_json_str = json.dumps(annotations_dict, ensure_ascii=False)
            
            # Write back to zarr array
            # For scalar arrays, we need to encode as bytes
            encoded_bytes = updated_json_str.encode('utf-8')
            
            if hasattr(array, 'shape') and array.shape == ():
                # Scalar array - encode and write
                # Check if it fits in the array's dtype (unlikely to be larger after deletion, but handle it)
                if hasattr(array, 'dtype') and array.dtype.kind == 'S':
                    max_len = array.dtype.itemsize
                    if len(encoded_bytes) > max_len:
                        # Need to recreate the dataset with larger size
                        dataset_name = array_path.rsplit('/', 1)[-1]
                        parent_path = array_path.rsplit('/', 1)[0]
                        if parent_path.startswith('/'):
                            parent_path = parent_path[1:]
                        
                        if parent_path in zf:
                            parent_group = zf[parent_path]
                            new_size = int(len(encoded_bytes) * 1.5)
                            del parent_group[dataset_name]
                            parent_group.create_dataset(
                                dataset_name, 
                                data=np.array(encoded_bytes, dtype=f'S{new_size}'),
                                shape=(),
                                dtype=f'S{new_size}'
                            )
                            print(f"[_delete_tissue_annotation] Resized {dataset_name} from {max_len} to {new_size} bytes")
                        else:
                            return {"success": False, "message": f"Parent group not found: {parent_path}"}
                    else:
                        array[()] = encoded_bytes
                else:
                    array[()] = encoded_bytes
            else:
                # Regular array - encode and write
                encoded_bytes = updated_json_str.encode('utf-8')
                array[:] = encoded_bytes
            
            # Update patch_class_counts in user_annotation group (decrement count)
            try:
                parent_path = array_path.rsplit('/', 1)[0]
                if parent_path.startswith('/'):
                    parent_path_clean = parent_path[1:]
                else:
                    parent_path_clean = parent_path
                
                if parent_path_clean in zf:
                    user_anno_group = zf[parent_path_clean]
                    if isinstance(user_anno_group, zarr.Group):
                        counts_ds_name = "patch_class_counts"
                        counts_dict = {}
                        
                        # Load existing counts
                        if counts_ds_name in user_anno_group:
                            counts_dataset = user_anno_group[counts_ds_name]
                            # Handle scalar array (0-dimensional)
                            if hasattr(counts_dataset, 'shape') and counts_dataset.shape == ():
                                counts_raw = counts_dataset[()]
                            else:
                                counts_raw = counts_dataset[:]
                            
                            if isinstance(counts_raw, bytes):
                                counts_dict = json.loads(counts_raw.decode('utf-8'))
                            elif isinstance(counts_raw, str):
                                counts_dict = json.loads(counts_raw)
                            elif isinstance(counts_raw, dict):
                                counts_dict = counts_raw
                            else:
                                # Try to decode if it's a numpy array
                                if isinstance(counts_raw, np.ndarray):
                                    if counts_raw.dtype.kind == 'S' or counts_raw.dtype.kind == 'U':
                                        if counts_raw.ndim == 0:
                                            json_str_counts = str(counts_raw.item())
                                        else:
                                            json_str_counts = str(counts_raw.flat[0])
                                        if isinstance(json_str_counts, bytes):
                                            json_str_counts = json_str_counts.decode('utf-8')
                                        counts_dict = json.loads(json_str_counts)
                                    else:
                                        counts_dict = {}
                                else:
                                    counts_dict = {}
                            
                            print(f"[_delete_tissue_annotation] Loaded existing patch_class_counts: {counts_dict}")
                        
                        # Decrement old class count
                        if old_class_name and old_class_name in counts_dict:
                            old_count = counts_dict[old_class_name]
                            counts_dict[old_class_name] = max(0, old_count - 1)
                            print(f"[_delete_tissue_annotation] Decremented '{old_class_name}': {old_count} -> {counts_dict[old_class_name]}")
                            # Remove class if count is 0
                            if counts_dict[old_class_name] == 0:
                                del counts_dict[old_class_name]
                                print(f"[_delete_tissue_annotation] Removed '{old_class_name}' from counts (count reached 0)")
                        
                        print(f"[_delete_tissue_annotation] Updated patch_class_counts: {counts_dict}")
                        
                        # Save updated counts
                        counts_json = json.dumps(counts_dict, ensure_ascii=False)
                        counts_bytes = counts_json.encode('utf-8')
                        
                        if counts_ds_name in user_anno_group:
                            existing_ds = user_anno_group[counts_ds_name]
                            # Try to overwrite in-place if size allows (for scalar arrays)
                            if hasattr(existing_ds, 'shape') and existing_ds.shape == () and len(counts_bytes) <= existing_ds.nbytes:
                                existing_ds[()] = counts_bytes
                                print(f"[_delete_tissue_annotation] Overwrote patch_class_counts in-place")
                            else:
                                # Size mismatch or not scalar - need to replace
                                del user_anno_group[counts_ds_name]
                                user_anno_group.create_dataset(counts_ds_name, data=counts_bytes)
                                print(f"[_delete_tissue_annotation] Replaced patch_class_counts dataset")
                        else:
                            # Create new dataset
                            user_anno_group.create_dataset(counts_ds_name, data=counts_bytes)
                            print(f"[_delete_tissue_annotation] Created new patch_class_counts dataset")
            except Exception as e:
                # Log but don't fail the delete
                print(f"[_delete_tissue_annotation] Warning: Failed to update patch_class_counts: {e}")
            
            return {"success": True, "message": f"Annotation for patch {patch_id} deleted successfully"}
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {"success": False, "message": f"Error updating tissue annotation: {str(e)}"}
    
    def _handle_string_array_preview_paginated(self, array, start_idx: int, end_idx: int, total_items: int) -> Tuple[Any, List[int], int]:
        """Handle paginated string array preview safely"""
        try:
            if array.size == 1:
                # Single string value
                data = array[...]
                if isinstance(data, bytes):
                    try:
                        data = data.decode('utf-8')
                    except:
                        data = str(data)
                return data, [], 1
            
            # Multiple string values
            if len(array.shape) == 1:
                # 1D array: simple slicing
                data = array[start_idx:end_idx]
            else:
                # Multi-dimensional array: slice first dimension
                slices = [slice(None)] * len(array.shape)
                slices[0] = slice(start_idx, end_idx)
                data = array[tuple(slices)]
            
            # Convert bytes to strings if needed
            if isinstance(data, np.ndarray):
                if data.dtype.kind == 'S':  # Byte strings
                    try:
                        data = np.array([item.decode('utf-8') if isinstance(item, bytes) else str(item) for item in data.flat]).reshape(data.shape)
                    except:
                        data = np.array([str(item) for item in data.flat]).reshape(data.shape)
            
            # Convert to list for pagination (always return actual data, not summary)
            if isinstance(data, np.ndarray):
                converted_data = data.tolist()
            else:
                converted_data = self._convert_zarr_value(data)
            return converted_data, list(data.shape) if hasattr(data, 'shape') else [], total_items
            
        except Exception as e:
            return f"<String preview error: {str(e)}>", [], total_items
    
    def read_array_data(self, array_path: str, start: Optional[List[int]] = None,
                         end: Optional[List[int]] = None, step: Optional[List[int]] = None,
                         flatten: bool = False, max_elements: int = 100000) -> Optional[Dict[str, Any]]:
        """Read array data with better error handling"""
        with self:
            try:
                array = self._get_object_by_path(array_path)
                if not isinstance(array, zarr.Array):
                    return None
            except KeyError:
                return None
            
            try:
                # Handle different data types
                if array.dtype.kind in ['S', 'U', 'O']:  # String types
                    return self._read_string_array(array, start, end, step, flatten, max_elements)
                else:
                    return self._read_numeric_array(array, start, end, step, flatten, max_elements)
                    
            except Exception as e:
                return {
                    "error": f"Error reading array: {str(e)}",
                    "shape": list(array.shape) if hasattr(array, 'shape') else [],
                    "dtype": str(array.dtype) if hasattr(array, 'dtype') else "unknown",
                    "original_shape": list(array.shape),
                    "original_size": int(array.size)
                }
    
    def _read_string_array(self, array, start, end, step, flatten, max_elements):
        """Read string array safely"""
        try:
            # Check array size for strings
            total_elements = array.size
            if total_elements > max_elements:
                if start is None and end is None:
                    if len(array.shape) == 1:
                        end = [min(max_elements, array.shape[0])]
                        start = [0]
                    else:
                        # For multidimensional case
                        ratio = max_elements / total_elements
                        first_dim_size = int(array.shape[0] * ratio**0.5)
                        first_dim_size = min(first_dim_size, array.shape[0])
                        end = [first_dim_size] + list(array.shape[1:])
                        start = [0] * len(array.shape)
            
            # Build slices
            if start is not None or end is not None or step is not None:
                slices = []
                for i in range(len(array.shape)):
                    s = start[i] if start and i < len(start) else 0
                    e = end[i] if end and i < len(end) else array.shape[i]
                    st = step[i] if step and i < len(step) else 1
                    slices.append(slice(s, e, st))
                
                data = array[tuple(slices)]
            else:
                data = array[...]
            
            # Convert bytes to strings if needed
            if isinstance(data, np.ndarray) and data.dtype.kind == 'S':
                try:
                    data = np.array([item.decode('utf-8') if isinstance(item, bytes) else str(item) for item in data.flat]).reshape(data.shape)
                except:
                    data = np.array([str(item) for item in data.flat]).reshape(data.shape)
            elif isinstance(data, bytes):
                try:
                    data = data.decode('utf-8')
                except:
                    data = str(data)
            
            # Check if truncated
            is_truncated = array.size > max_elements and (start is not None or end is not None)
            
            if flatten and hasattr(data, 'flatten'):
                data = data.flatten()
            
            return {
                "data": self._convert_zarr_value(data),
                "shape": list(data.shape) if hasattr(data, 'shape') else [],
                "dtype": str(data.dtype) if hasattr(data, 'dtype') else str(type(data)),
                "total_elements": int(data.size) if hasattr(data, 'size') else len(data) if hasattr(data, '__len__') else 1,
                "is_truncated": is_truncated,
                "original_shape": list(array.shape),
                "original_size": int(array.size)
            }
            
        except Exception as e:
            raise ValueError(f"Error reading string data: {str(e)}")
    
    def _read_numeric_array(self, array, start, end, step, flatten, max_elements):
        """Read numeric array safely"""
        # Check array size
        total_elements = array.size
        if total_elements > max_elements:
            # If no slice specified, automatically create a reasonable slice
            if start is None and end is None:
                # Calculate reasonable slice size
                if len(array.shape) == 1:
                    end = [min(max_elements, array.shape[0])]
                    start = [0]
                else:
                    # For multidimensional case, only read part of first dimension
                    ratio = max_elements / total_elements
                    first_dim_size = int(array.shape[0] * ratio**0.5)
                    first_dim_size = min(first_dim_size, array.shape[0])
                    end = [first_dim_size] + list(array.shape[1:])
                    start = [0] * len(array.shape)
        
        # Build slices
        if start is not None or end is not None or step is not None:
            slices = []
            for i in range(len(array.shape)):
                s = start[i] if start and i < len(start) else 0
                e = end[i] if end and i < len(end) else array.shape[i]
                st = step[i] if step and i < len(step) else 1
                slices.append(slice(s, e, st))
            
            data = array[tuple(slices)]
        else:
            data = array[...]
        
        # Check if truncated
        is_truncated = data.size > max_elements
        if is_truncated:
            # Truncate data
            flat_data = data.flatten()
            data = flat_data[:max_elements].reshape(-1) if flatten else flat_data[:max_elements]
        
        if flatten and not is_truncated:
            data = data.flatten()
        
        return {
            "data": self._convert_zarr_value(data),
            "shape": list(data.shape) if hasattr(data, 'shape') else [],
            "dtype": str(data.dtype) if hasattr(data, 'dtype') else str(type(data)),
            "total_elements": int(data.size) if hasattr(data, 'size') else len(data) if hasattr(data, '__len__') else 1,
            "is_truncated": is_truncated,
            "original_shape": list(array.shape),
            "original_size": int(array.size)
        }
    
    def get_object_attributes(self, object_path: str, attribute_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Get object attributes"""
        with self:
            try:
                obj = self._get_object_by_path(object_path)
            except KeyError:
                return None
            
            attrs = self._get_attributes(obj)
            
            if attribute_name:
                return {attribute_name: attrs.get(attribute_name)} if attribute_name in attrs else {}
            
            return attrs
    
    def list_contents(self, group_path: str = "/", recursive: bool = False, 
                     object_type: Optional[str] = None) -> List[Dict[str, Any]]:
        """List group contents"""
        with self:
            try:
                group = self._get_object_by_path(group_path)
                if not isinstance(group, zarr.Group):
                    return []
            except KeyError:
                return []
            
            contents = []
            
            def process_object(key, obj):
                try:
                    obj_path = f"{group_path}/{key}" if group_path != "/" else f"/{key}"
                    obj_info = {
                        "name": key,
                        "path": obj_path,
                        "type": "group" if isinstance(obj, zarr.Group) else "array"
                    }
                    
                    if isinstance(obj, zarr.Array):
                        obj_info.update(self._get_array_info(obj, obj_path))
                    elif isinstance(obj, zarr.Group):
                        obj_info["member_count"] = len(obj.keys())
                    
                    # Apply object type filter
                    if object_type is None or obj_info["type"] == object_type:
                        contents.append(obj_info)
                except Exception as e:
                    # Skip objects that can't be read
                    pass
            
            if recursive:
                def visit_all(obj, path=""):
                    for key in obj.keys():
                        child_obj = obj[key]
                        process_object(key, child_obj)
                        if isinstance(child_obj, zarr.Group):
                            visit_all(child_obj, f"{path}/{key}")
                
                visit_all(group)
            else:
                for key in group.keys():
                    obj = group[key]
                    process_object(key, obj)
            
            return contents
    
    def search_objects(self, query: str, object_type: Optional[str] = None,
                      search_attributes: bool = False, case_sensitive: bool = False) -> List[Dict[str, Any]]:
        """Search objects"""
        with self:
            results = []
            
            # Compile regular expression
            flags = 0 if case_sensitive else re.IGNORECASE
            pattern = re.compile(re.escape(query), flags)
            
            def search_visitor(key, obj, path=""):
                try:
                    obj_info = {
                        "path": f"{path}/{key}" if path else f"/{key}",
                        "name": key,
                        "type": "group" if isinstance(obj, zarr.Group) else "array",
                        "match_type": None
                    }
                    
                    # Apply object type filter
                    if object_type and obj_info["type"] != object_type:
                        return
                    
                    # Search object name
                    if pattern.search(obj_info["name"]):
                        obj_info["match_type"] = "name"
                        results.append(obj_info.copy())
                    
                    # Search attribute names
                    if search_attributes and hasattr(obj, 'attrs'):
                        for attr_name in obj.attrs.keys():
                            if pattern.search(attr_name):
                                attr_match_info = obj_info.copy()
                                attr_match_info["match_type"] = "attribute"
                                attr_match_info["matched_attribute"] = attr_name
                                results.append(attr_match_info)
                except Exception as e:
                    # Skip objects that can't be read
                    pass
            
            def visit_all(obj, path=""):
                for key in obj.keys():
                    child_obj = obj[key]
                    search_visitor(key, child_obj, path)
                    if isinstance(child_obj, zarr.Group):
                        visit_all(child_obj, f"{path}/{key}" if path else key)
            
            visit_all(self.root)
            return results
    
    def analyze_file(self, include_statistics: bool = True, sample_size: int = 1000) -> Dict[str, Any]:
        """Analyze Zarr file"""
        with self:
            analysis = {
                "file_summary": self.get_file_info(),
                "structure_analysis": {},
                "recommendations": []
            }
            
            # Structure analysis
            total_groups = 0
            total_arrays = 0
            max_depth = 0
            array_sizes = []
            array_types = {}
            
            def analyze_visitor(key, obj, depth=0):
                nonlocal total_groups, total_arrays, max_depth
                
                try:
                    max_depth = max(max_depth, depth)
                    
                    if isinstance(obj, zarr.Group):
                        total_groups += 1
                    elif isinstance(obj, zarr.Array):
                        total_arrays += 1
                        array_sizes.append(obj.size)
                        
                        dtype_str = str(obj.dtype)
                        array_types[dtype_str] = array_types.get(dtype_str, 0) + 1
                except Exception as e:
                    # Skip objects that can't be analyzed
                    pass
            
            def visit_all(obj, depth=0):
                for key in obj.keys():
                    child_obj = obj[key]
                    analyze_visitor(key, child_obj, depth)
                    if isinstance(child_obj, zarr.Group):
                        visit_all(child_obj, depth + 1)
            
            visit_all(self.root)
            
            analysis["structure_analysis"] = {
                "total_groups": total_groups,
                "total_arrays": total_arrays,
                "max_depth": max_depth,
                "array_types": array_types,
                "average_array_size": np.mean(array_sizes) if array_sizes else 0,
                "total_data_size": sum(array_sizes) if array_sizes else 0
            }
            
            # Data statistics
            if include_statistics and array_sizes:
                analysis["data_statistics"] = {
                    "array_count": len(array_sizes),
                    "min_array_size": min(array_sizes),
                    "max_array_size": max(array_sizes),
                    "median_array_size": np.median(array_sizes),
                    "std_array_size": np.std(array_sizes)
                }
            
            # Generate recommendations
            recommendations = []
            if max_depth > 10:
                recommendations.append("File structure is quite deep, consider simplifying hierarchy to improve access efficiency")
            
            if len(array_types) > 20:
                recommendations.append("Many data types present, consider standardizing data types")
            
            if analysis["structure_analysis"]["total_data_size"] > 1e9:  # 1GB
                recommendations.append("Large file size, consider using compression or chunked storage")
            
            analysis["recommendations"] = recommendations
            
            return analysis
    
    def _get_attributes(self, obj) -> Dict[str, Any]:
        """Get all attributes of an object"""
        attrs = {}
        if hasattr(obj, 'attrs'):
            for attr_name in obj.attrs.keys():
                try:
                    attr_value = obj.attrs[attr_name]
                    attrs[attr_name] = {
                        "value": self._convert_zarr_value(attr_value),
                        "dtype": str(type(attr_value).__name__),
                        "shape": list(attr_value.shape) if hasattr(attr_value, 'shape') else []
                    }
                except Exception as e:
                    attrs[attr_name] = {
                        "value": f"<Error reading attribute: {str(e)}>",
                        "dtype": "unknown",
                        "shape": []
                    }
        return attrs
    
    def _get_array_info(self, array, array_path: str = None) -> Dict[str, Any]:
        """Get basic array information with better error handling"""
        try:
            info = {
                "shape": list(array.shape),
                "dtype": str(array.dtype),
                "size": int(array.size),
            }
            
            # Try to get nbytes, but handle cases where it might fail
            try:
                info["nbytes"] = int(array.nbytes)
            except:
                info["nbytes"] = array.size * array.dtype.itemsize
            
            # Calculate actual disk size (compressed size on disk)
            try:
                if array_path and hasattr(array, 'store'):
                    # Get the actual file system path for this array
                    # For zarr, arrays are stored as directories with chunk files
                    array_disk_size = self._calculate_array_disk_size(array, array_path)
                    if array_disk_size is not None:
                        info["disk_size"] = array_disk_size
            except Exception as e:
                # If calculation fails, just don't include disk_size
                pass
            
            # Compression information
            try:
                if hasattr(array, 'compressor') and array.compressor:
                    info["compression"] = str(array.compressor)
            except:
                pass
            
            # Chunking information
            try:
                if hasattr(array, 'chunks') and array.chunks:
                    info["chunks"] = list(array.chunks)
            except:
                pass
            
            # Fill value
            try:
                if hasattr(array, 'fill_value') and array.fill_value is not None:
                    info["fillvalue"] = self._convert_zarr_value(array.fill_value)
            except:
                pass
            
            return info
            
        except Exception as e:
            # Return minimal info if there's an error
            return {
                "shape": [],
                "dtype": "unknown",
                "size": 0,
                "nbytes": 0,
                "error": str(e)
            }
    
    def _calculate_array_disk_size(self, array, array_path: str) -> Optional[int]:
        """Calculate the actual disk size of an array by summing all chunk files"""
        try:
            # Get the store path for this array
            # For DirectoryStore, the path is the zarr file path + array path
            if hasattr(array, 'store'):
                store = array.store
                # Try to get the base path from the store
                if hasattr(store, 'path'):
                    # DirectoryStore has a 'path' attribute
                    base_path = Path(store.path)
                    # Convert zarr path (e.g., '/user_annotation/nuclei_annotations') to file system path
                    # Remove leading '/' and replace '/' with path separator
                    rel_path = array_path.lstrip('/').replace('/', os.sep) if array_path else ''
                    array_dir = base_path / rel_path
                    
                    if array_dir.exists() and array_dir.is_dir():
                        # Sum all files in this directory recursively
                        total_size = 0
                        for item in array_dir.rglob('*'):
                            if item.is_file():
                                try:
                                    total_size += item.stat().st_size
                                except (OSError, PermissionError):
                                    pass
                        return total_size
        except Exception as e:
            # If calculation fails, return None
            pass
        return None
    
    def _convert_zarr_value(self, value):
        """
        Convert NumPy/Zarr attribute values into JSON-safe objects.
        Large arrays return a compact summary instead of full expansion.
        """

        # Basic scalar conversions
        if isinstance(value, (np.integer,)):
            return int(value)
        if isinstance(value, (np.floating,)):
            return float(value)
        if isinstance(value, (np.bool_)):
            return bool(value)
        if isinstance(value, (bytes, bytearray)):
            return value.decode("utf-8", "ignore")

        # Handle numpy void (structured element)
        if isinstance(value, np.void):
            try:
                return value.tolist()
            except:
                return str(value)

        # Handle numpy arrays
        if isinstance(value, np.ndarray):
            size = value.size

            # Small arrays → preserve old behavior (full tolist)
            if size <= 20:
                return value.tolist()

            # Medium/large arrays → summary mode (new optimization)
            return {
                "dtype": str(value.dtype),
                "shape": list(value.shape),
                "sample": value.flat[:5].tolist(),
                "preview_only": True
            }

        # dict recursive
        if isinstance(value, dict):
            return {k: self._convert_zarr_value(v) for k, v in value.items()}

        # list recursive
        if isinstance(value, list):
            return [self._convert_zarr_value(v) for v in value]

        # fallback
        return value


# ---------------------------------------------------------------------------
# Conversion task management


@dataclass(frozen=True)
class ConversionOptions:
    source_path: str
    target_path: Optional[str] = None
    compression: str = "gzip"
    chunk_size_mb: float = 64.0
    workers: int = 4
    skip_empty: bool = True
    skip_objects: bool = True
    overwrite: bool = False
    test: bool = False
    verbose: bool = False
    write_stats: bool = False


_ALLOWED_INPUT_SUFFIXES = {".h5", ".hdf5"}
_ALLOWED_COMPRESSIONS = {"", "none", "gzip", "lz4", "zstd", "blosc"}
_MAX_CONCURRENCY = max(1, int(os.getenv("H5_TO_ZARR_MAX_CONCURRENCY", "2")))
_THREADPOOL_SIZE = max(
    _MAX_CONCURRENCY, int(os.getenv("H5_TO_ZARR_THREADPOOL_SIZE", str(_MAX_CONCURRENCY * 2)))
)
_semaphore = asyncio.Semaphore(_MAX_CONCURRENCY)
_executor = ThreadPoolExecutor(max_workers=_THREADPOOL_SIZE, thread_name_prefix="h5zarr")
_inflight: Dict[str, asyncio.Future] = {}
_inflight_lock = asyncio.Lock()
_active_lock = asyncio.Lock()
_active_targets: Set[str] = set()
_job_queue: asyncio.Queue = asyncio.Queue()
_jobs: Dict[str, "ConversionJob"] = {}
_worker_tasks: List[asyncio.Task] = []
_worker_lock = asyncio.Lock()


@dataclass
class ConversionJob:
    job_id: str
    options: ConversionOptions
    status: str = "pending"
    error: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    enqueued_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None


def _is_supported_input(path: Path) -> bool:
    lower_name = path.name.lower()
    if lower_name.endswith(".svs.h5"):
        return True
    return path.suffix.lower() in _ALLOWED_INPUT_SUFFIXES


def _default_target_for(source: Path) -> Path:
    stem, _ = os.path.splitext(source.name)
    return source.parent / f"{stem}.zarr"


def _prepare_paths(options: ConversionOptions) -> ConversionOptions:
    resolved_source = Path(resolve_path(options.source_path))
    if not resolved_source.exists():
        raise FileNotFoundError(f"Source file not found: {resolved_source}")

    if not _is_supported_input(resolved_source):
        raise ValueError("Input file must be an H5/HDF5 file")

    if options.chunk_size_mb <= 0:
        raise ValueError("chunk_size_mb must be positive")
    if options.workers < 1 or options.workers > 64:
        raise ValueError("workers must be between 1 and 64")

    compression = (options.compression or "").lower()
    if compression not in _ALLOWED_COMPRESSIONS:
        raise ValueError(f"Unsupported compression: {options.compression}")
    if compression == "none":
        compression = ""

    target_path = options.target_path
    resolved_target = Path(resolve_path(target_path)) if target_path else _default_target_for(resolved_source)
    if target_path and not resolved_target.name.lower().endswith(".zarr"):
        resolved_target = resolved_target.parent / f"{resolved_target.name}.zarr"

    if resolved_target.exists():
        if options.overwrite:
            if resolved_target.is_dir():
                shutil.rmtree(resolved_target)
            else:
                resolved_target.unlink()
        else:
            raise FileExistsError(f"Target path already exists: {resolved_target}")

    resolved_target.parent.mkdir(parents=True, exist_ok=True)

    return ConversionOptions(
        source_path=str(resolved_source),
        target_path=str(resolved_target),
        compression=compression,
        chunk_size_mb=options.chunk_size_mb,
        workers=options.workers,
        skip_empty=options.skip_empty,
        skip_objects=options.skip_objects,
        overwrite=options.overwrite,
        test=options.test,
        verbose=options.verbose,
        write_stats=options.write_stats,
    )


async def convert_h5_to_zarr_async(options: ConversionOptions) -> Dict[str, object]:
    """
    Run conversion using a bounded executor with deduplication per target.
    """

    normalized_options = _prepare_paths(options)
    target_key = str(Path(normalized_options.target_path).resolve())

    async with _inflight_lock:
        existing = _inflight.get(target_key)
        if existing is not None:
            return await existing

        task = asyncio.create_task(_execute_conversion(normalized_options, target_key))
        _inflight[target_key] = task

    try:
        return await task
    finally:
        async with _inflight_lock:
            _inflight.pop(target_key, None)


async def _execute_conversion(options: ConversionOptions, target_key: str) -> Dict[str, object]:
    async with _semaphore:
        async with _active_lock:
            _active_targets.add(target_key)
        try:
            loop = asyncio.get_running_loop()
            start = time.monotonic()
            result = await loop.run_in_executor(_executor, _blocking_convert, options)
            elapsed = time.monotonic() - start
            result["elapsed_seconds"] = elapsed
            result["concurrency"] = {
                "max_concurrent_conversions": _MAX_CONCURRENCY,
                "active_conversions": await _get_active_count(),
                "queued_tasks": await _get_queue_depth(),
            }
            return result
        finally:
            async with _active_lock:
                _active_targets.discard(target_key)


def _blocking_convert(options: ConversionOptions) -> Dict[str, object]:
    config = ConversionConfig(
        compression=options.compression,
        chunk_size_mb=options.chunk_size_mb,
        max_workers=options.workers,
        verbose=options.verbose,
        skip_empty=options.skip_empty,
        skip_object_arrays=options.skip_objects,
        write_stats=options.write_stats,
    )

    result = convert_h5_to_zarr(
        options.source_path,
        options.target_path,
        config,
    )
    if not result.get("success"):
        raise RuntimeError(f"Conversion script reported failure: {result.get('error')}")

    test_result = None
    if options.test:
        test_result = test_zarr_file(options.target_path, verbose=options.verbose)
        if not test_result:
            raise RuntimeError("Converted Zarr file failed validation")

    return {
        "source_path": options.source_path,
        "target_path": options.target_path,
        "config": {
            "compression": options.compression or "none",
            "chunk_size_mb": options.chunk_size_mb,
            "workers": options.workers,
            "skip_empty": options.skip_empty,
            "skip_objects": options.skip_objects,
            "write_stats": options.write_stats,
            "run_test": options.test,
        },
        "test_passed": test_result,
    }


async def _get_active_count() -> int:
    async with _active_lock:
        return len(_active_targets)


async def _get_queue_depth() -> int:
    async with _inflight_lock:
        async with _active_lock:
            return max(0, len(_inflight) - len(_active_targets))


async def _ensure_workers() -> None:
    async with _worker_lock:
        if _worker_tasks:
            return
        loop = asyncio.get_running_loop()
        for idx in range(_MAX_CONCURRENCY):
            task = loop.create_task(_conversion_worker(idx))
            _worker_tasks.append(task)


async def _conversion_worker(worker_idx: int) -> None:
    while True:
        job: ConversionJob = await _job_queue.get()
        job.status = "running"
        job.started_at = time.time()
        try:
            result = await convert_h5_to_zarr_async(job.options)
            job.result = result
            job.status = "succeeded"
        except Exception as exc:
            job.error = str(exc)
            job.status = "failed"
        finally:
            job.finished_at = time.time()
            _job_queue.task_done()


def _job_to_dict(job: ConversionJob) -> Dict[str, Any]:
    return {
        "job_id": job.job_id,
        "status": job.status,
        "error": job.error,
        "result": job.result,
        "enqueued_at": job.enqueued_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "source_path": job.options.source_path,
        "target_path": job.options.target_path,
    }


async def enqueue_h5_to_zarr_job(options: ConversionOptions) -> Dict[str, Any]:
    normalized = _prepare_paths(options)

    # Prevent duplicate active jobs for same target
    for job in _jobs.values():
        if (
            job.options.target_path == normalized.target_path
            and job.status in {"pending", "running"}
        ):
            raise FileExistsError(f"Conversion already in progress for {normalized.target_path}")

    job_id = uuid.uuid4().hex
    job = ConversionJob(job_id=job_id, options=normalized)
    _jobs[job_id] = job

    await _ensure_workers()
    await _job_queue.put(job)
    return _job_to_dict(job)


def get_conversion_job(job_id: str) -> Dict[str, Any]:
    job = _jobs.get(job_id)
    if not job:
        raise KeyError(f"Conversion job not found: {job_id}")
    return _job_to_dict(job)


# Service functions for API calls
def get_file_structure(file_path: str, path: Optional[str] = None, 
                      include_attributes: bool = True, max_depth: int = -1) -> Dict[str, Any]:
    """Get Zarr file structure"""
    try:
        handler = ZarrFileHandler(file_path)
        start_path = path if path else "/"
        
        structure = handler.get_structure(start_path, include_attributes, max_depth)
        
        if not structure:
            raise ValueError(f"Path not found: {start_path}")
        
        # Add statistics information
        with handler:
            total_groups = 0
            total_arrays = 0
            
            def count_visitor(key, obj, depth=0):
                nonlocal total_groups, total_arrays
                try:
                    if isinstance(obj, zarr.Group):
                        total_groups += 1
                    elif isinstance(obj, zarr.Array):
                        total_arrays += 1
                except:
                    pass
            
            def visit_all(obj, depth=0):
                if isinstance(obj, zarr.Group):
                    for key in obj.keys():
                        child_obj = obj[key]
                        count_visitor(key, child_obj, depth)
                        if isinstance(child_obj, zarr.Group):
                            visit_all(child_obj, depth + 1)
                elif isinstance(obj, zarr.Array):
                    # For arrays, we don't need to visit children
                    pass
            
            visit_all(handler.root)
        
        return {
            "root": structure,
            "total_groups": total_groups,
            "total_arrays": total_arrays
        }
    except Exception as e:
        raise ValueError(f"Error getting file structure: {str(e)}")



def get_group_info(file_path: str, group_path: str, include_arrays: bool = True,
                  include_subgroups: bool = True) -> Optional[Dict[str, Any]]:
    """Get group information"""
    try:
        handler = ZarrFileHandler(file_path)
        return handler.get_group_info(group_path, include_arrays, include_subgroups)
    except Exception as e:
        raise ValueError(f"Error getting group info: {str(e)}")


def delete_nuclei_annotation(file_path: str, array_path: str, cell_id: int) -> Dict[str, Any]:
    """Delete a single nuclei annotation by cell_id.
    
    Args:
        file_path: Path to the zarr file
        array_path: Path to the nuclei_annotations array (e.g., 'user_annotation/nuclei_annotations')
        cell_id: The cell ID (index) to delete
        
    Returns:
        Dict with success status and message
    """
    with ZarrFileHandler(file_path) as handler:
        return handler.delete_nuclei_annotation(array_path, cell_id)

def update_nuclei_annotation_class(file_path: str, array_path: str, cell_id: int, new_class_name: str) -> Dict[str, Any]:
    """Update the cell_class for a single nuclei annotation.
    
    Args:
        file_path: Path to the zarr file
        array_path: Path to the nuclei_annotations array (e.g., 'user_annotation/nuclei_annotations')
        cell_id: The cell ID (index) to update
        new_class_name: The new class name to assign
        
    Returns:
        Dict with success status and message
    """
    with ZarrFileHandler(file_path) as handler:
        return handler.update_nuclei_annotation_class(array_path, cell_id, new_class_name)

def get_array_info(file_path: str, array_path: str, include_preview: bool = False,
                    preview_size: int = 10, page: Optional[int] = None, 
                    limit: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """Get array information with optional pagination"""
    try:
        handler = ZarrFileHandler(file_path)
        return handler.get_array_info(array_path, include_preview, preview_size, page, limit)
    except Exception as e:
        raise ValueError(f"Error getting array info: {str(e)}")


def read_array_data(file_path: str, array_path: str, start: Optional[List[int]] = None,
                     end: Optional[List[int]] = None, step: Optional[List[int]] = None,
                     flatten: bool = False, max_elements: int = 100000) -> Optional[Dict[str, Any]]:
    """Read array data"""
    try:
        handler = ZarrFileHandler(file_path)
        return handler.read_array_data(array_path, start, end, step, flatten, max_elements)
    except Exception as e:
        raise ValueError(f"Error reading array data: {str(e)}")


def get_object_attributes(file_path: str, object_path: str, 
                         attribute_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get object attributes"""
    try:
        handler = ZarrFileHandler(file_path)
        return handler.get_object_attributes(object_path, attribute_name)
    except Exception as e:
        raise ValueError(f"Error getting object attributes: {str(e)}")


def list_file_contents(file_path: str, group_path: str = "/", recursive: bool = False,
                      object_type: Optional[str] = None) -> List[Dict[str, Any]]:
    """List file contents"""
    try:
        handler = ZarrFileHandler(file_path)
        return handler.list_contents(group_path, recursive, object_type)
    except Exception as e:
        raise ValueError(f"Error listing file contents: {str(e)}")


# Utility functions
# Zarr v2 metadata files that may have been uploaded without leading dot (sanitize_filename bug)
_ZARR_META = ('zgroup', 'zarray', 'zattrs')


def _repair_zarr_dotfiles(root: str) -> bool:
    """Rename zgroup/zarray/zattrs to .zgroup/.zarray/.zattrs if missing. Returns True if any fix was applied."""
    fixed = False
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name in _ZARR_META:
                src = os.path.join(dirpath, name)
                dst = os.path.join(dirpath, f".{name}")
                if not os.path.exists(dst):
                    try:
                        os.rename(src, dst)
                        fixed = True
                    except OSError:
                        pass
    return fixed


def validate_zarr_file(file_path: str) -> bool:
    """Validate if it's a valid Zarr file (supports both v2 directory and v3 zip formats)"""
    if not file_path:
        return False
    if not os.path.exists(file_path):
        return False
    try:
        synchronizer = get_zarr_synchronizer(file_path)
        with zarr.open(file_path, mode='r', synchronizer=synchronizer) as f:
            return True
    except Exception:
        try:
            with zarr.open(file_path, mode='r') as f:
                return True
        except Exception:
            if os.path.isdir(file_path) and _repair_zarr_dotfiles(file_path):
                try:
                    with zarr.open(file_path, mode='r') as f:
                        return True
                except Exception:
                    return False
            return False


def get_zarr_version_info() -> Dict[str, str]:
    """Get Zarr version information"""
    return {
        "zarr_version": zarr.__version__,
        "numpy_version": np.__version__
    }


def search_zarr_objects(file_path: str, query: str, object_type: Optional[str] = None,
                       search_attributes: bool = False, case_sensitive: bool = False) -> Dict[str, Any]:
    """Search Zarr objects service"""
    try:
        if object_type and object_type not in ['group', 'array']:
            raise ValueError("object_type must be 'group' or 'array'")
        
        handler = ZarrFileHandler(file_path)
        results = handler.search_objects(query, object_type, search_attributes, case_sensitive)
        
        return {
            "results": results,
            "count": len(results),
            "query": query,
            "search_parameters": {
                "object_type": object_type,
                "search_attributes": search_attributes,
                "case_sensitive": case_sensitive
            }
        }
    except Exception as e:
        raise ValueError(f"Error searching objects: {str(e)}")


def analyze_zarr_file_service(file_path: str, include_statistics: bool = True, 
                             sample_size: int = 1000) -> Dict[str, Any]:
    """Analyze Zarr file service"""
    try:
        handler = ZarrFileHandler(file_path)
        analysis = handler.analyze_file(include_statistics, sample_size)
        return analysis
    except Exception as e:
        raise ValueError(f"Error analyzing file: {str(e)}")


def validate_zarr_file_service(file_path: str) -> Dict[str, Any]:
    """Validate Zarr file service"""
    try:
        is_valid = validate_zarr_file(file_path)
        return {
            "is_valid": is_valid,
            "file_path": file_path
        }
    except Exception as e:
        raise ValueError(f"Error validating file: {str(e)}")


def list_zarr_contents_service(file_path: str, group_path: str = "/", 
                              recursive: bool = False, object_type: Optional[str] = None) -> Dict[str, Any]:
    """List Zarr contents service"""
    try:
        if object_type and object_type not in ['group', 'array']:
            raise ValueError("object_type must be 'group' or 'array'")
        
        contents = list_file_contents(file_path, group_path, recursive, object_type)
        
        return {
            "contents": contents,
            "count": len(contents),
            "group_path": group_path,
            "recursive": recursive,
            "object_type": object_type
        }
    except Exception as e:
        raise ValueError(f"Error listing contents: {str(e)}")


def enhanced_file_analysis_service(file_path: str) -> Dict[str, Any]:
    """Enhanced file analysis service combining segmentation and Zarr analysis"""
    try:
        from datetime import datetime
        from app.services.seg_service import SegmentationHandler, get_classifications
        
        # Basic file information
        result = {
            "file_path": file_path,
            "analysis_timestamp": datetime.now().isoformat()
        }
        
        # Try segmentation data analysis
        try:
            handler = SegmentationHandler()
            handler.load_file(file_path)
            
            # Get segmentation-related information
            segmentation_info = {
                "has_nuclei": hasattr(handler, 'nuclei') and handler.nuclei is not None,
                "has_tissues": hasattr(handler, 'tissues') and handler.tissues is not None,
                "has_patches": hasattr(handler, '_patches') and handler._patches is not None,
            }
            
            # Try to get classification information
            try:
                classifications = get_classifications()
                segmentation_info["has_classifications"] = True
                segmentation_info["classification_count"] = len(classifications.get("nuclei_class_id", []))
            except:
                segmentation_info["has_classifications"] = False
            
            result["segmentation_analysis"] = segmentation_info
            
        except Exception as e:
            result["segmentation_analysis"] = {
                "error": f"Segmentation data analysis failed: {str(e)}"
            }
        
        # Try Zarr structure analysis
        try:
            if validate_zarr_file(file_path):
                zarr_handler = ZarrFileHandler(file_path)
                zarr_info = zarr_handler.get_file_info()
                
                # Get simplified structure information
                structure = get_file_structure(file_path, max_depth=2)
                
                result["zarr_analysis"] = {
                    "is_zarr": True,
                    "total_groups": zarr_info["total_groups"],
                    "total_arrays": zarr_info["total_arrays"],
                    "file_size": zarr_info["file_size"],
                    "structure_summary": structure
                }
            else:
                result["zarr_analysis"] = {
                    "is_zarr": False,
                    "message": "File is not a valid Zarr format"
                }
        
        except Exception as e:
            result["zarr_analysis"] = {
                "error": f"Zarr analysis failed: {str(e)}"
            }
        
        return result
    except Exception as e:
        raise ValueError(f"Enhanced analysis failed: {str(e)}")


def search_segmentation_arrays_service(file_path: str, query: str, 
                                        include_segmentation: bool = True) -> Dict[str, Any]:
    """Search for segmentation-related arrays service"""
    try:
        if not validate_zarr_file(file_path):
            raise ValueError("File is not a valid Zarr file")
        
        handler = ZarrFileHandler(file_path)
        
        # Search for related arrays
        search_results = handler.search_objects(query, object_type="array")
        
        # If segmentation-related search is enabled, add common segmentation array keywords
        if include_segmentation:
            segmentation_keywords = [
                "nuclei", "tissue", "patch", "annotation", "classification", 
                "segmentation", "mask", "label", "centroid", "boundary"
            ]
            
            for keyword in segmentation_keywords:
                if keyword.lower() in query.lower():
                    continue  # Avoid duplicate searches
                
                additional_results = handler.search_objects(keyword, object_type="array")
                search_results.extend(additional_results)
        
        # Remove duplicates and sort
        unique_results = []
        seen_paths = set()
        for result in search_results:
            if result["path"] not in seen_paths:
                unique_results.append(result)
                seen_paths.add(result["path"])
        
        # Add detailed information for each array
        detailed_results = []
        for result in unique_results[:20]:  # Limit return count
            try:
                array_info = get_array_info(file_path, result["path"])
                if array_info:
                    result["details"] = {
                        "shape": array_info["shape"],
                        "dtype": array_info["dtype"],
                        "size": array_info["size"]
                    }
            except:
                pass
            detailed_results.append(result)
        
        return {
            "results": detailed_results,
            "total_found": len(unique_results),
            "query": query,
            "include_segmentation": include_segmentation
        }
    except Exception as e:
        raise ValueError(f"Search failed: {str(e)}")


def get_batch_array_info_service(file_path: str, array_paths: List[str], 
                                  include_preview: bool = False) -> Dict[str, Any]:
    """Get array information in batch service"""
    try:
        results = {}
        errors = {}
        
        for array_path in array_paths:
            try:
                if not array_path.startswith('/'):
                    array_path = '/' + array_path
                
                array_info = get_array_info(file_path, array_path, include_preview)
                if array_info:
                    results[array_path] = array_info
                else:
                    errors[array_path] = "Array not found"
            
            except Exception as e:
                errors[array_path] = str(e)
        
        return {
            "results": results,
            "errors": errors,
            "requested_count": len(array_paths),
            "success_count": len(results),
            "error_count": len(errors)
        }
    except Exception as e:
        raise ValueError(f"Batch operation failed: {str(e)}")


def export_zarr_structure_service(file_path: str, export_path: str, format: str = "json",
                                 include_attributes: bool = True, max_depth: int = -1) -> Dict[str, Any]:
    """Export Zarr file structure service"""
    try:
        import os
        import json
        
        # Use real path to handle symlinks and normalize path
        real_export_path = resolve_path(export_path)
        
        # Security check: restrict export paths
        dangerous_export_paths = ["/etc/", "/usr/", "/bin/", "/sbin/", "/root/", "/boot/", "/sys/", "/proc/"]
        if any(real_export_path.startswith(dangerous) for dangerous in dangerous_export_paths):
            raise ValueError("Export path not allowed")
        
        # Prevent using ../ to access parent directories
        if ".." in real_export_path:
            raise ValueError("Path traversal not allowed")
        
        # Ensure export file extension is safe
        allowed_extensions = ['.json', '.yaml', '.yml']
        if not any(real_export_path.lower().endswith(ext) for ext in allowed_extensions):
            raise ValueError("Invalid export file type. Only JSON/YAML files are allowed")
        
        # Get file structure
        structure = get_file_structure(file_path, include_attributes=include_attributes, max_depth=max_depth)
        
        # Ensure export directory exists (use real path)
        os.makedirs(os.path.dirname(real_export_path), exist_ok=True)
        
        if format.lower() == "json":
            with open(real_export_path, 'w', encoding='utf-8') as f:
                json.dump(structure, f, indent=2, ensure_ascii=False)
        
        elif format.lower() == "yaml":
            try:
                import yaml
                with open(real_export_path, 'w', encoding='utf-8') as f:
                    yaml.dump(structure, f, default_flow_style=False, allow_unicode=True)
            except ImportError:
                raise ValueError("YAML library not available")
        
        else:
            raise ValueError("Unsupported format. Use 'json' or 'yaml'")
        
        return {
            "message": f"Zarr structure exported successfully to {real_export_path}",
            "export_path": real_export_path,
            "format": format,
            "total_groups": structure["total_groups"],
            "total_arrays": structure["total_arrays"]
        }
    except Exception as e:
        raise ValueError(f"Export failed: {str(e)}")


def validate_file_path_and_security(file_path: str) -> None:
    """Validate file path and perform security checks"""
    import os

    if not file_path:
        raise ValueError("No file path provided")

    real_file_path = resolve_path(file_path)

    dangerous_paths = ["/etc/", "/usr/bin/", "/bin/", "/sbin/", "/root/", "/boot/", "/sys/", "/proc/"]
    if any(real_file_path.startswith(dangerous) for dangerous in dangerous_paths):
        raise ValueError("File path not allowed")

    if not real_file_path.lower().endswith(('.zarr', '.zar')):
        raise ValueError("Invalid file type. Only Zarr files are allowed")

    if not os.path.exists(real_file_path):
        raise ValueError("Zarr file not found")

    if not validate_zarr_file(real_file_path):
        raise ValueError("Invalid Zarr file")

