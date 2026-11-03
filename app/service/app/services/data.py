import asyncio
import os
import re
import json
import shutil
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple, Set

import numpy as np
import zarr

from app.config.zarr_compat import open_zarr, zarr_lock, create_array, is_zarr_store_path
from app.utils import resolve_path
from app.core.logger import logger
from app.utils.converter import (
    ConversionConfig,
    convert_h5_to_zarr,
    test_zarr_file,
)


class ZarrFileHandler:
    """Zarr file handler, based on Zarr 3.0 standard"""
    
    def __init__(self, file_path: str, *, auto_convert: bool = True,
                 include_disk_size: bool = True):
        self.file_path = file_path
        self.store = None
        self.root = None
        self._auto_convert = auto_convert
        self._include_disk_size = include_disk_size
        self._validate_file()
    
    def _validate_file(self):
        """Validate if file exists and is in Zarr format"""
        if not is_zarr_store_path(self.file_path):
            raise FileNotFoundError(f"File not found: {self.file_path}")
        
        try:
            # Single open — reused by ``__enter__`` / structure walks.
            self.root = open_zarr(self.file_path, mode='r', auto_convert=self._auto_convert)
            self.store = self.root
        except Exception as e:
            raise ValueError(f"Invalid Zarr file: {str(e)}")
    
    def __enter__(self):
        if self.root is None:
            self.root = open_zarr(self.file_path, mode='r', auto_convert=self._auto_convert)
            self.store = self.root
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
        """Recursively get file structure (opens the store once at depth 0)."""
        if current_depth == 0:
            with self:
                return self._get_structure_unlocked(path, include_attributes, max_depth, 0)
        return self._get_structure_unlocked(path, include_attributes, max_depth, current_depth)

    def _get_structure_unlocked(self, path: str = "/", include_attributes: bool = True,
                     max_depth: int = -1, current_depth: int = 0) -> Dict[str, Any]:
        """Inner structure walk — requires ``self.root`` already opened."""
        try:
            obj = self._get_object_by_path(path)
        except KeyError:
            return None
        
        result = {
            "name": path.split('/')[-1] if path != "/" else "/",
            "full_path": path,
            "type": "group" if isinstance(obj, zarr.Group) else "array"
        }
        
        if include_attributes:
            result["attributes"] = self._get_attributes(obj)
        
        if isinstance(obj, zarr.Group):
            result["children"] = []
            if max_depth == -1 or current_depth < max_depth:
                for key in obj.keys():
                    child_path = f"{path}/{key}" if path != "/" else f"/{key}"
                    child_info = self._get_structure_unlocked(
                        child_path, include_attributes, max_depth, current_depth + 1
                    )
                    if child_info:
                        result["children"].append(child_info)
                # Plain-file drawings live beside the group, not as a zarr array.
                normalized = path.strip("/")
                if normalized == "User-Annotations" or normalized.endswith("/User-Annotations"):
                    manual_fs = os.path.join(self.file_path, "User-Annotations", "manual.json")
                    if os.path.isfile(manual_fs):
                        child_names = {c.get("name") for c in result["children"]}
                        if "manual.json" not in child_names:
                            try:
                                size = os.path.getsize(manual_fs)
                            except OSError:
                                size = 0
                            result["children"].append({
                                "name": "manual.json",
                                "full_path": f"{normalized}/manual.json",
                                "type": "array",
                                "dtype": "json",
                                "shape": [],
                                "size": size,
                            })
                result["member_count"] = len(result["children"])
            else:
                # Truncated shallow walk — skip expensive nmembers().
                result["member_count"] = 0
        
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
                "member_count": group.nmembers()
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
                            "member_count": obj.nmembers()
                        })
                result["subgroups"] = subgroups
            
            return result
    
    def _get_manual_json_info(
        self,
        normalized_path: str,
        *,
        include_preview: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Info/preview for the plain-file User-Annotations/manual.json."""
        fs_path = os.path.join(self.file_path, "User-Annotations", "manual.json")
        if not os.path.isfile(fs_path):
            return None
        try:
            size = os.path.getsize(fs_path)
        except OSError:
            size = 0
        result: Dict[str, Any] = {
            "name": "manual.json",
            "full_path": normalized_path,
            "type": "array",
            "dtype": "json",
            "shape": [],
            "size": size,
            "attributes": {},
        }
        if include_preview:
            try:
                with open(fs_path, "r", encoding="utf-8") as f:
                    result["preview"] = json.load(f)
                result["preview_shape"] = []
            except Exception as e:
                result["preview"] = f"<Error reading preview: {e}>"
                result["preview_shape"] = []
        return result

    def get_array_info(self, array_path: str, include_preview: bool = False, 
                        preview_size: int = 10, page: Optional[int] = None, 
                        limit: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """Get detailed array information with optional pagination"""
        normalized_path = array_path.strip("/")
        if (
            normalized_path == "User-Annotations/manual.json"
            or normalized_path.endswith("/User-Annotations/manual.json")
        ):
            return self._get_manual_json_info(normalized_path, include_preview=include_preview)

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
            
            # Special handling for User-Annotations/cell and tissue_annotations
            # Check if this is the nuclei_annotations or tissue_annotations array in user_annotation group
            normalized_path = array_path.strip('/')
            is_nuclei_annotations = (
                normalized_path == 'User-Annotations/cell' or
                normalized_path.endswith('/User-Annotations/cell') or
                array_path.endswith('/nuclei_annotations') and 'User-Annotations' in array_path
            )
            is_tissue_annotations = (
                normalized_path == 'User-Annotations/patch' or
                normalized_path.endswith('/User-Annotations/patch') or
                array_path.endswith('/tissue_annotations') and 'User-Annotations' in array_path
            )
            
            # Get class_names for nuclei_annotations and tissue_annotations to include in response
            if is_nuclei_annotations or is_tissue_annotations:
                try:
                    parent_path = array_path.rsplit('/', 1)[0]
                    user_anno_group = self._get_object_by_path(parent_path)
                    if isinstance(user_anno_group, zarr.Group) and hasattr(user_anno_group, 'attrs'):
                        # The palette the marks index; legacy attrs on older stores.
                        palette = self._user_anno_class_names(array_path, 'patch' if is_tissue_annotations else 'cell')
                        if palette:
                            result["class_names"] = palette
                        attr_name = 'tissue_class_names' if is_tissue_annotations else 'class_names'
                        
                        if not palette and attr_name in user_anno_group.attrs:
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
    
    def _user_anno_class_names(self, array_path: Optional[str], kind: str) -> List[str]:
        """The class palette the marks of User-Annotations/<kind> index (the
        `<kind>_class_names` attrs on the group); [] when unknown."""
        if not array_path or 'User-Annotations' not in array_path:
            return []
        try:
            from app.config.zarr_config import read_user_anno_class_palette
            group = self._get_object_by_path(array_path.rsplit('/', 1)[0])
            if isinstance(group, zarr.Group):
                return [str(n) for n in read_user_anno_class_palette(group, kind)[0]]
        except Exception:
            pass
        return []

    @staticmethod
    def _mark_label(mark: int, class_names: List[str]) -> str:
        """A mark as the user made it: "Tumor" for "is class k" (k >= 0),
        "Not Tumor" for "not class k" (-(2 + k))."""
        k = mark if mark >= 0 else -(mark + 2)
        name = class_names[k] if 0 <= k < len(class_names) else str(k)
        return name if mark >= 0 else f"Not {name}"

    def _get_nuclei_annotations_preview_paginated(self, array, page: int, limit: int, array_path: str = None) -> Tuple[Any, List[int], int]:
        """Special handling for User-Annotations/cell structured array.
        
        Returns only the marked cells ("is" and "not" marks) in a simplified format:
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
            if 'class' not in array.dtype.names or 'color' not in array.dtype.names:
                # Missing required fields, fall back to regular handling
                return self._get_array_preview_paginated(array, page, limit)
            
            cell_class_ids = full_array['class']
            cell_color_data = full_array['color']
            # annotator (Firebase uid) — present on current arrays, absent on
            # legacy ones; surfaced as the 3rd preview column when available.
            annotator_data = full_array['annotator'] if 'annotator' in array.dtype.names else None

            # Every mark: "is class k" (k >= 0) and "not class k" (-(2 + k));
            # -1 is unmarked. Color is display only and may be unset.
            valid_mask = cell_class_ids != -1
            valid_indices = np.where(valid_mask)[0]
            valid_class_ids = cell_class_ids[valid_indices]
            
            # Calculate total items (only valid annotations)
            total_valid_items = len(valid_indices)

            if total_valid_items == 0:
                return [], [0, 3], 0
            
            class_names = self._user_anno_class_names(array_path, 'cell')
            
            # Calculate pagination indices for valid items
            start_idx = (page - 1) * limit
            end_idx = min(start_idx + limit, total_valid_items)
            
            if start_idx >= total_valid_items:
                return [], [0, 3], total_valid_items

            # Get the paginated slice of valid annotations
            paginated_indices = valid_indices[start_idx:end_idx]
            paginated_class_ids = valid_class_ids[start_idx:end_idx]
            
            # Convert to simplified format: [[cell_id, cell_class_name, annotator], ...]
            # Convert class_id to class_name if available, otherwise use class_id as string
            converted_data = []
            for cell_id, class_id in zip(paginated_indices, paginated_class_ids):
                # Convert numpy types to Python native types
                cell_id_int = int(cell_id)
                class_id_int = int(class_id)

                class_name = self._mark_label(class_id_int, class_names)

                # 3rd column: annotator (stored as the Firebase uid). Empty for
                # legacy arrays that predate the field.
                annotator_str = ""
                if annotator_data is not None:
                    raw = annotator_data[cell_id_int]
                    annotator_str = (raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)).strip()

                converted_data.append([cell_id_int, class_name, annotator_str])

            return converted_data, [len(converted_data), 3], total_valid_items
            
        except Exception as e:
            return f"<Error reading nuclei_annotations preview: {str(e)}>", [], 0
    
    def _get_tissue_annotations_preview_paginated(self, array, page: int, limit: int, array_path: str = None) -> Tuple[Any, List[int], int]:
        """Preview / paginate User-Annotations/patch (dense structured array).

        Rows where class == -1 are placeholders; we filter them out so the user
        only sees real annotations. Row format returned: [patch_id, class_name, annotator].
        ``class_name`` is resolved via patch.attrs.class_names (the per-patch
        ``class`` field is an int index).
        """
        try:
            patch_arr = array[:]
            if not (hasattr(patch_arr, 'dtype') and patch_arr.dtype.names and 'class' in patch_arr.dtype.names):
                return [], [0, 3], 0
            class_names = (self._user_anno_class_names(array_path, 'patch')
                           or [str(n) for n in (array.attrs.get('class_names') or [])])
            class_field = patch_arr['class']
            annotator_field = patch_arr['annotator'] if 'annotator' in patch_arr.dtype.names else None
            # "Not class k" marks (-(2 + k)) are marks too; -1 is unmarked.
            mask = class_field != -1
            valid_indices = np.where(mask)[0]
            total_valid_items = int(valid_indices.size)
            if total_valid_items == 0:
                return [], [0, 3], 0
            start_idx = (page - 1) * limit
            end_idx = min(start_idx + limit, total_valid_items)
            if start_idx >= total_valid_items:
                return [], [0, 3], total_valid_items
            page_indices = valid_indices[start_idx:end_idx]
            converted_data = []
            for i in page_indices:
                ci = int(class_field[i])
                cls_name = self._mark_label(ci, class_names)
                annotator = str(annotator_field[i]) if annotator_field is not None else ''
                converted_data.append([int(i), cls_name, annotator])
            return converted_data, [len(converted_data), 3], total_valid_items
        except Exception as e:
            print(f"[_get_tissue_annotations_preview_paginated] Error: {e}")
            traceback.print_exc()
            return f"<Error reading patch annotations preview: {e}>", [], 0

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
                normalized_path == 'User-Annotations/patch' or
                normalized_path.endswith('/User-Annotations/patch') or
                array_path.endswith('/tissue_annotations') and 'User-Annotations' in array_path
            )
            
            # Open zarr file in write mode for deletion
            with zarr_lock(self.file_path):
                zf = open_zarr(self.file_path, mode='a')
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
                    return self._delete_patch_annotation(zf, array, array_path, cell_id)
                
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
                if 'class' not in array.dtype.names or 'color' not in array.dtype.names:
                    return {"success": False, "message": "Missing required fields (cell_class, cell_color)"}
                
                # A cell is annotated when it carries a mark: "is class k" (k >= 0)
                # or "not class k" (-(2 + k)); -1 is unmarked. cell_color is only
                # a display attribute and may be unset, so it must not gate
                # deletion.
                if full_array['class'][cell_id] == -1:
                    return {"success": False, "message": f"Cell {cell_id} is not annotated (already deleted or never annotated)"}
                
                # Get the old class name before deleting (for updating counts)
                old_class_index = int(full_array['class'][cell_id])
                old_class_name = None
                
                # Get class_names from user_annotation group to find the class name
                if 'User-Annotations' in array_path:
                    parent_path = array_path.rsplit('/', 1)[0]
                    if parent_path.startswith('/'):
                        parent_path_clean = parent_path[1:]
                    else:
                        parent_path_clean = parent_path
                    
                    if parent_path_clean in zf:
                        user_anno_group = zf[parent_path_clean]
                        if isinstance(user_anno_group, zarr.Group):
                            # The marks index the cell palette pinned on the group.
                            from app.config.zarr_config import read_user_anno_class_palette
                            class_names, _ = read_user_anno_class_palette(user_anno_group, 'cell')
                            if class_names and 0 <= old_class_index < len(class_names):
                                old_class_name = class_names[old_class_index]
                
                # Delete the annotation by setting to -1
                full_array['class'][cell_id] = -1
                full_array['color'][cell_id] = -1
                
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
                # Drop the deleted cell's now-orphan selection-geometry entry.
                try:
                    from app.services.tasks import prune_orphan_selection_geometry
                    if 'User-Annotations' in array_path_clean:
                        prune_orphan_selection_geometry(
                            zf[array_path_clean.rsplit('/', 1)[0]], 'cell')
                except Exception:
                    pass

                # Update class_counts in user_annotation group (decrement count)
                if old_class_name and 'User-Annotations' in array_path:
                    try:
                        parent_path = array_path.rsplit('/', 1)[0]
                        if parent_path.startswith('/'):
                            parent_path_clean = parent_path[1:]
                        else:
                            parent_path_clean = parent_path
                        
                        if parent_path_clean in zf:
                            user_anno_group = zf[parent_path_clean]
                            if isinstance(user_anno_group, zarr.Group):
                                counts_ds_name = "cell_class_counts"
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
                                        create_array(user_anno_group, counts_ds_name, data=np.array(counts_bytes, dtype=f"S{max(1, len(counts_bytes))}"), overwrite=True)
                                else:
                                    create_array(user_anno_group, counts_ds_name, data=np.array(counts_bytes, dtype=f"S{max(1, len(counts_bytes))}"), overwrite=True)
                    except Exception as e:
                        # Log error but don't fail the delete - the annotation was already deleted
                        try:
                            logger.error(f"cell_class_counts update failed after delete: {e}", exc_info=True)
                        except Exception:
                            pass
                        pass

                # Every viewer of the slide shows the cell's prediction again and
                # recounts, as a region clear does.
                try:
                    from app.services.seg import SegmentationHandler, restore_predicted_class_ids
                    from app.services.seg_registry import iter_annotation_handlers
                    for _, bound in iter_annotation_handlers():
                        if bound is None or not getattr(bound, 'zarr_file', None) \
                                or not SegmentationHandler._same_zarr_path(bound.zarr_file, self.file_path):
                            continue
                        restore_predicted_class_ids(bound, zf, [cell_id])
                        bound.invalidate_user_counts_cache()
                except Exception as e:
                    print(f"[delete_nuclei_annotation] could not refresh the slide's viewers: {e}")

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
                normalized_path == 'User-Annotations/patch' or
                normalized_path.endswith('/User-Annotations/patch') or
                array_path.endswith('/tissue_annotations') and 'User-Annotations' in array_path
            )
            
            # Open zarr file in write mode for update
            with zarr_lock(self.file_path):
                zf = open_zarr(self.file_path, mode='a')
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
                
                # The marks index the cell palette pinned on the group.
                parent_path_clean = array_path_clean.rsplit('/', 1)[0] if '/' in array_path_clean else ''
                user_anno_group = zf[parent_path_clean] if parent_path_clean and parent_path_clean in zf else None
                class_names, class_colors = [], []
                if isinstance(user_anno_group, zarr.Group):
                    from app.config.zarr_config import read_user_anno_class_palette
                    class_names, class_colors = read_user_anno_class_palette(user_anno_group, 'cell')
                    class_names = [str(n) for n in class_names]
                if not class_names:
                    return {"success": False, "message": "Could not retrieve class names from metadata"}
                if new_class_name not in class_names:
                    return {"success": False, "message": f"Class name '{new_class_name}' not found in available classes"}
                new_class_index = class_names.index(new_class_name)

                if 'class' not in array.dtype.names or 'color' not in array.dtype.names:
                    return {"success": False, "message": "Missing required fields (cell_class, cell_color)"}
                row = array[cell_id:cell_id + 1]
                old_mark = int(row['class'][0])
                # Any mark can be changed ("not X" too: it becomes "is Y"); -1 is unmarked.
                if old_mark == -1:
                    return {"success": False, "message": f"Cell {cell_id} is not annotated (cannot update unannotated cell)"}
                if old_mark == new_class_index:
                    return {"success": True, "message": f"Annotation for cell {cell_id} is already '{new_class_name}'"}
                old_class_name = class_names[old_mark] if 0 <= old_mark < len(class_names) else None

                from app.services.tasks import _hex_color_to_int
                color = class_colors[new_class_index] if new_class_index < len(class_colors) else None
                color_int = _hex_color_to_int(str(color)) if color else -1
                row['class'][0] = new_class_index
                row['color'][0] = color_int if color_int >= 0 else _hex_color_to_int("#808080")
                array[cell_id:cell_id + 1] = row

                # The positive-mark counts: the old class loses one, the new gains one.
                try:
                    counts_ds_name = "cell_class_counts"
                    counts_dict = {}
                    if counts_ds_name in user_anno_group:
                        counts_raw = user_anno_group[counts_ds_name][()]
                        if counts_raw:
                            try:
                                counts_dict = json.loads(counts_raw.decode("utf-8") if isinstance(counts_raw, (bytes, np.bytes_)) else str(counts_raw))
                            except Exception:
                                counts_dict = {}
                    if old_class_name and old_class_name in counts_dict:
                        counts_dict[old_class_name] = max(0, int(counts_dict[old_class_name]) - 1)
                        if counts_dict[old_class_name] == 0:
                            del counts_dict[old_class_name]
                    counts_dict[new_class_name] = int(counts_dict.get(new_class_name, 0)) + 1
                    counts_bytes = json.dumps(counts_dict, ensure_ascii=False).encode("utf-8")
                    if counts_ds_name in user_anno_group:
                        del user_anno_group[counts_ds_name]
                    create_array(user_anno_group, counts_ds_name, data=np.array(counts_bytes, dtype=f"S{max(1, len(counts_bytes))}"), overwrite=True)
                except Exception as e:
                    try:
                        logger.error(f"cell_class_counts update failed after class change: {e}", exc_info=True)
                    except Exception:
                        pass

                # Every viewer of the slide shows the cell as the new class.
                try:
                    from app.services.seg import SegmentationHandler
                    from app.services.seg_registry import iter_annotation_handlers
                    for _, bound in iter_annotation_handlers():
                        if bound is None or not getattr(bound, 'zarr_file', None) \
                                or not SegmentationHandler._same_zarr_path(bound.zarr_file, self.file_path):
                            continue
                        bound.invalidate_user_counts_cache()
                        bound._apply_manual_nuclei_annotations(zf)
                        if hasattr(bound, '_viewport_cache'):
                            bound._viewport_cache.clear()
                except Exception as e:
                    print(f"[update_nuclei_annotation_class] could not refresh the slide's viewers: {e}")

                return {"success": True, "message": f"Annotation for cell {cell_id} updated to '{new_class_name}' successfully"}
            
        except Exception as e:
            return {"success": False, "message": f"Error updating annotation: {str(e)}"}
    
    def _update_tissue_annotation_class(self, zf, array, array_path: str, patch_id: int, new_class_name: str) -> Dict[str, Any]:
        """Change a patch mark ("is X" or "not X") into "is ``new_class_name``"
        in the structured User-Annotations/patch array, the way every patch-mark
        write goes (load .. save under the store's lock, only that row written),
        and show it in every viewer of the slide."""
        try:
            from app.config.zarr_config import read_user_anno_class_palette
            from app.services.tasks import load_patch_annotations, save_patch_annotations, _hex_color_to_int
            parent_path_clean = array_path.strip('/').rsplit('/', 1)[0]
            group = zf[parent_path_clean] if parent_path_clean in zf else None
            class_names, class_colors = (read_user_anno_class_palette(group, 'patch')
                                         if isinstance(group, zarr.Group) else ([], []))
            class_names = [str(n) for n in class_names]
            if new_class_name not in class_names:
                return {"success": False, "message": f"Class name '{new_class_name}' not found in available classes"}
            new_idx = class_names.index(new_class_name)

            with zarr_lock(self.file_path):
                marks = load_patch_annotations(self.file_path) or {}
                mark = marks.get(patch_id)
                if not mark:
                    return {"success": False, "message": f"Patch {patch_id} is not annotated (cannot update unannotated patch)"}
                old = int(mark.get('class', -1))
                if old == new_idx:
                    return {"success": True, "message": f"Annotation for patch {patch_id} is already '{new_class_name}'"}
                color = class_colors[new_idx] if new_idx < len(class_colors) else None
                color_int = _hex_color_to_int(str(color)) if color else -1
                marks[patch_id] = {**mark, 'class': new_idx,
                                   'color': color_int if color_int >= 0 else _hex_color_to_int("#808080")}
                saved = save_patch_annotations(self.file_path, marks, n_patches=int(array.shape[0]),
                                               changed_ids=[patch_id])

                from app.services.seg import SegmentationHandler
                from app.services.seg_registry import iter_annotation_handlers
                for _, h in iter_annotation_handlers():
                    if h is None or not getattr(h, 'zarr_file', None) \
                            or not SegmentationHandler._same_zarr_path(h.zarr_file, self.file_path):
                        continue
                    h.tissue_annotations = dict(saved) if isinstance(saved, dict) else load_patch_annotations(self.file_path)
                    h.invalidate_patch_counts_cache()
                    if hasattr(h, '_viewport_cache'):
                        try:
                            h._viewport_cache.clear()
                        except Exception:
                            pass

            old_label = self._mark_label(old, class_names)
            return {"success": True, "message": f"Updated annotation for patch {patch_id} from '{old_label}' to '{new_class_name}'"}

        except Exception as e:
            traceback.print_exc()
            return {"success": False, "message": f"Error updating tissue annotation: {str(e)}"}
    
    def _delete_patch_annotation(self, zf, array, array_path: str, patch_id: int) -> Dict[str, Any]:
        """Delete a single patch mark ("is class k" or "not class k") from the
        structured User-Annotations/patch array.

        Goes the way every patch-mark removal goes (``_drop_patch_marks``): the
        row is reset, its orphaned selection shape pruned, and every viewer of
        the slide drops the mark and shows the patch's prediction again. Patch
        counts are computed from the array, so they follow by themselves.
        """
        try:
            full_array = array[:]
            names = full_array.dtype.names or ()
            if 'class' not in names or 'color' not in names:
                return {"success": False, "message": "Not a structured patch array"}
            if patch_id < 0 or patch_id >= full_array.size:
                return {"success": False, "message": f"Patch ID {patch_id} out of range (0-{full_array.size - 1})"}
            # -1 is unmarked; k >= 0 is "is class k", -(2 + k) is "not class k".
            if int(full_array['class'][patch_id]) == -1:
                return {"success": False, "message": f"Patch {patch_id} is not annotated (already deleted or never annotated)"}

            from app.services.seg import SegmentationHandler, _drop_patch_marks
            from app.services.seg_registry import iter_annotation_handlers
            bound = [h for _, h in iter_annotation_handlers()
                     if h is not None and getattr(h, 'zarr_file', None)
                     and SegmentationHandler._same_zarr_path(h.zarr_file, self.file_path)]
            # Under the store's lock (held by the caller): the first viewer's
            # caches are updated by the drop, the others' right after.
            removed, _ = _drop_patch_marks(bound[0] if bound else None, self.file_path, lambda _m, _p: [patch_id])
            if not removed:
                return {"success": False, "message": f"Patch {patch_id} is not annotated (already deleted or never annotated)"}
            for h in bound[1:]:
                if isinstance(getattr(h, 'tissue_annotations', None), dict):
                    h.tissue_annotations.pop(patch_id, None)
                    h.tissue_annotations.pop(str(patch_id), None)
                h.invalidate_patch_counts_cache()
                if hasattr(h, '_viewport_cache'):
                    try:
                        h._viewport_cache.clear()
                    except Exception:
                        pass

            return {"success": True, "message": f"Annotation for patch {patch_id} deleted successfully"}

        except Exception as e:
            traceback.print_exc()
            return {"success": False, "message": f"Error deleting patch annotation: {str(e)}"}
    
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
                        obj_info["member_count"] = obj.nmembers()
                    
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
                if self._include_disk_size and array_path and hasattr(array, 'store'):
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
                # Try to get the base path from the store.
                # zarr v3 LocalStore exposes 'root'; legacy v2 DirectoryStore had 'path'.
                store_root = getattr(store, 'root', None)
                if store_root is None:
                    store_root = getattr(store, 'path', None)
                if store_root is not None:
                    base_path = Path(store_root)
                    # Convert zarr path (e.g., '/User-Annotations/cell') to file system path
                    # Remove leading '/' and replace '/' with path separator
                    rel_path = array_path.lstrip('/').replace('/', os.sep) if array_path else ''
                    array_dir = base_path / rel_path
                    
                    if array_dir.exists() and array_dir.is_dir():
                        # DirEntry carries the stat data from the directory
                        # read; rglob's classify + is_file + stat pays three
                        # syscalls per chunk file.
                        total_size = 0
                        stack = [str(array_dir)]
                        while stack:
                            current = stack.pop()
                            try:
                                with os.scandir(current) as entries:
                                    for entry in entries:
                                        try:
                                            if entry.is_file(follow_symlinks=False):
                                                total_size += entry.stat(
                                                    follow_symlinks=False).st_size
                                            elif entry.is_dir(follow_symlinks=False):
                                                stack.append(entry.path)
                                        except OSError:
                                            pass
                            except OSError:
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

            # Small arrays → preserve old behavior (full tolist). Recurse so that
            # byte-string dtypes (|S..) — whose tolist() yields bytes — get decoded.
            if size <= 20:
                return self._convert_zarr_value(value.tolist())

            # Medium/large arrays → summary mode (new optimization)
            return {
                "dtype": str(value.dtype),
                "shape": list(value.shape),
                "sample": self._convert_zarr_value(value.flat[:5].tolist()),
                "preview_only": True
            }

        # dict recursive
        if isinstance(value, dict):
            return {k: self._convert_zarr_value(v) for k, v in value.items()}

        # list/tuple recursive (tuple covers np.void.tolist() with byte fields)
        if isinstance(value, (list, tuple)):
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
        follower = _inflight.get(target_key)
        task = None
        if follower is None:
            task = asyncio.create_task(
                _execute_conversion(normalized_options, target_key)
            )
            _inflight[target_key] = task

    # Awaiting happens OUTSIDE the lock, in both branches.
    #
    # Holding _inflight_lock across the await deadlocked outright: the running
    # conversion reports `queued_tasks`, which calls _get_queue_depth(), which
    # takes this same lock — so the waiter held the lock the task needed to
    # finish, and the task held the completion the waiter was waiting for.
    # Even without that, a second request for one target blocked every other
    # target's request for the length of a conversion.
    if follower is not None:
        return await follower

    try:
        return await task
    finally:
        # Only the caller that created the task retires it.
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


# How long a finished conversion stays queryable by job id.
CONVERSION_JOB_TTL_SEC = 30 * 60

_JOB_ACTIVE_STATUSES = frozenset({"pending", "running"})


def purge_finished_conversion_jobs(
    ttl_sec: float = CONVERSION_JOB_TTL_SEC,
    now: Optional[float] = None,
) -> int:
    """Drop finished conversion records past their TTL. Returns how many went.

    ``_jobs`` was only ever added to, so every conversion the process had ever
    run stayed resident with its result payload — and the duplicate-target check
    below walks the whole dict, which meant enqueueing scanned the full history
    rather than the jobs actually in flight.

    ``finished_at`` is set in the worker's ``finally``, so an active job never
    carries one and can never be reclaimed here.
    """
    current = time.time() if now is None else now
    expired = [
        job_id
        for job_id, job in _jobs.items()
        if job.status not in _JOB_ACTIVE_STATUSES
        and job.finished_at is not None
        and current - job.finished_at >= ttl_sec
    ]
    for job_id in expired:
        _jobs.pop(job_id, None)
    return len(expired)


async def enqueue_h5_to_zarr_job(options: ConversionOptions) -> Dict[str, Any]:
    normalized = _prepare_paths(options)

    # Reclaim first so the duplicate scan below is proportional to what is
    # actually in flight, not to everything this process has ever converted.
    purge_finished_conversion_jobs()

    # Prevent duplicate active jobs for same target
    for job in _jobs.values():
        if (
            job.options.target_path == normalized.target_path
            and job.status in _JOB_ACTIVE_STATUSES
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


def _count_structure_nodes(node: Optional[Dict[str, Any]]) -> tuple[int, int]:
    """Count groups/arrays from an already-built structure tree (no extra zarr I/O)."""
    if not node or not isinstance(node, dict):
        return 0, 0
    node_type = node.get("type")
    children = node.get("children") or []
    if node_type == "array":
        return 0, 1
    groups = 1 if node_type == "group" else 0
    arrays = 0
    if isinstance(children, list):
        for child in children:
            g, a = _count_structure_nodes(child if isinstance(child, dict) else None)
            groups += g
            arrays += a
    return groups, arrays


# Service functions for API calls
def get_file_structure(file_path: str, path: Optional[str] = None,
                      include_attributes: bool = True, max_depth: int = -1,
                      include_disk_size: bool = False) -> Dict[str, Any]:
    """Get Zarr file structure.

    Stats are derived from the returned tree only. A previous full-store
    ``visit_all`` re-walked every group/array even for shallow badge reads
    (max_depth=1), which made WebFileManager zarr status feel very slow and
    had nothing to do with batch runtime.

    Read-only: ``auto_convert=False`` so badge/structure never triggers v2→v3
    migration (that belongs on real write/open paths).
    """
    try:
        handler = ZarrFileHandler(file_path, auto_convert=False,
                                  include_disk_size=include_disk_size)
        start_path = path if path else "/"

        structure = handler.get_structure(start_path, include_attributes, max_depth)

        if not structure:
            raise ValueError(f"Path not found: {start_path}")

        total_groups, total_arrays = _count_structure_nodes(structure)

        return {
            "root": structure,
            "total_groups": total_groups,
            "total_arrays": total_arrays
        }
    except Exception as e:
        raise ValueError(f"Error getting file structure: {str(e)}")



# Analysis result → the child that proves it was written. Group presence alone
# is not enough: ``write_node_userdata`` creates empty groups holding only
# userData. The file-list badges are drawn from this table.
ANALYSIS_GROUP_REQUIRED = {
    "Cell-Segmentation": "centroids",
    "Cell-Classification": "class_indices",
    "Patch-Segmentation": "embeddings",
    "Patch-Classification": "class_indices",
    "Tissue-Segmentation": "masks",
}

_NODE_METADATA = ("zarr.json", ".zgroup", ".zarray")   # v3, v2 group, v2 array


def get_analysis_groups(file_path: str) -> List[str]:
    """Analysis groups in ``ANALYSIS_GROUP_REQUIRED`` whose required child exists.

    Checks node metadata files instead of walking the store: a depth-2
    structure read opens every array under every group (annotation stores hold
    dozens), which cost 7-40 ms per store locally and most of the ~70 ms the
    badge reads took in prod, to answer ten yes/no questions.
    """
    def is_node(*parts: str) -> bool:
        node = os.path.join(file_path, *parts)
        return any(os.path.exists(os.path.join(node, meta)) for meta in _NODE_METADATA)

    return [
        group for group, child in ANALYSIS_GROUP_REQUIRED.items()
        if is_node(group) and is_node(group, child)
    ]


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
        array_path: Path to the nuclei_annotations array (e.g., 'User-Annotations/cell')
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
        array_path: Path to the nuclei_annotations array (e.g., 'User-Annotations/cell')
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
    """Validate if it's a readable Zarr store (v2 directory or v3).

    Uses ``auto_convert=False`` so a validation / security check does **not**
    trigger an in-place v2→v3 migration as a side effect. Migration still
    happens on real open/write via :func:`open_zarr` / :func:`ensure_v3`.
    """
    if not file_path:
        return False
    if not os.path.exists(file_path):
        return False
    # Plain files at ``*.zarr`` are never valid directory stores.
    if not os.path.isdir(file_path) and not str(file_path).lower().endswith(".zarr.zip"):
        return False
    try:
        open_zarr(file_path, mode="r", auto_convert=False)
        return True
    except Exception:
        # Legacy upload whose v2 metadata files lost their leading dot.
        if os.path.isdir(file_path) and _repair_zarr_dotfiles(file_path):
            try:
                open_zarr(file_path, mode="r", auto_convert=False)
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
        from app.services.seg import SegmentationHandler, get_classifications
        
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
                # Called without the handler until now, so this raised TypeError
                # every time and the analysis always reported no classifications.
                classifications = get_classifications(handler)
                segmentation_info["has_classifications"] = True
                segmentation_info["classification_count"] = len(classifications.get("class_indices", []))
            except (ValueError, AttributeError, KeyError, OSError):
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


def _root_is_group(store_path: str) -> bool:
    """True if the store root holds readable v3 or v2 group metadata."""
    for meta, is_group in (
        ("zarr.json", lambda doc: doc.get("zarr_format") == 3 and doc.get("node_type") == "group"),
        (".zgroup", lambda doc: doc.get("zarr_format") == 2),
    ):
        try:
            with open(os.path.join(store_path, meta), "r", encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(doc, dict) and is_group(doc):
            return True
    return False


def validate_file_path_and_security(file_path: str, open_store: bool = True) -> None:
    """Validate file path and perform security checks.

    ``open_store=False`` skips opening a store whose root metadata parses as a
    group. Opening goes through zarr's single event-loop thread, so it caps
    every thread of the service at ~2000 opens/s together — the batch badge
    read, which needs only metadata files, would queue on it. Anything else
    (no root metadata, unreadable or array metadata) is still opened, and
    legacy dotfiles repaired, as usual.
    """
    if not file_path:
        raise ValueError("No file path provided")

    real_file_path = resolve_path(file_path)

    dangerous_paths = ["/etc/", "/usr/bin/", "/bin/", "/sbin/", "/root/", "/boot/", "/sys/", "/proc/"]
    if any(real_file_path.startswith(dangerous) for dangerous in dangerous_paths):
        raise ValueError("File path not allowed")

    if not real_file_path.lower().endswith(('.zarr', '.zar')):
        raise ValueError("Invalid file type. Only Zarr files are allowed")

    if not is_zarr_store_path(real_file_path):
        raise ValueError("Zarr file not found")

    if not open_store and _root_is_group(real_file_path):
        return

    if not validate_zarr_file(real_file_path):
        raise ValueError("Invalid Zarr file")


def get_zarr_file_info_service(file_path: str) -> Dict[str, Any]:
    """Return basic information about a Zarr file."""
    handler = ZarrFileHandler(file_path)
    return handler.get_file_info()


def classify_annotation_array_path(array_path: str) -> Optional[str]:
    """Classify an annotation array path as 'nuclei' or 'tissue', or None if neither."""
    normalized_path = array_path.strip('/')
    is_nuclei = (
        normalized_path == 'User-Annotations/cell' or
        normalized_path.endswith('/User-Annotations/cell') or
        array_path.endswith('/nuclei_annotations') and 'User-Annotations' in array_path
    )
    if is_nuclei:
        return 'nuclei'
    is_tissue = (
        normalized_path == 'User-Annotations/patch' or
        normalized_path.endswith('/User-Annotations/patch') or
        array_path.endswith('/tissue_annotations') and 'User-Annotations' in array_path
    )
    if is_tissue:
        return 'tissue'
    return None


def ensure_annotation_array_path(array_path: str) -> str:
    """Normalize an annotation array path and verify it targets nuclei/tissue annotations.

    Returns the normalized path (with a leading slash). Raises ValueError otherwise.
    """
    if not array_path.startswith('/'):
        array_path = '/' + array_path
    if classify_annotation_array_path(array_path) is None:
        raise ValueError(
            "This endpoint only supports User-Annotations/cell "
            "or User-Annotations/patch"
        )
    return array_path


def apply_annotation_class_update_to_handler(handler, array_path: str, cell_id: int, new_class_name: str) -> None:
    """Sync an annotation class change into an instance handler's in-memory cache.

    Best-effort: never raises. The Zarr file is the source of truth and is already updated;
    this only keeps the handler's cache consistent so WebSocket reads return fresh colors.
    """
    try:
        kind = classify_annotation_array_path(array_path)
        if kind == 'nuclei':
            # For nuclei: update class_id in handler from the new class name
            if hasattr(handler, 'class_name') and handler.class_name is not None:
                class_names_list = list(handler.class_name)
                if new_class_name in class_names_list:
                    new_class_index = class_names_list.index(new_class_name)
                    if hasattr(handler, 'class_id') and handler.class_id is not None:
                        if cell_id < len(handler.class_id):
                            handler.class_id[cell_id] = new_class_index
        elif kind == 'tissue':
            # For tissue: update tissue_annotations dict in handler
            if hasattr(handler, 'patch'):
                handler.tissue_annotations[cell_id] = {'class': new_class_name}

        # Clear viewport cache to ensure fresh data is returned
        if hasattr(handler, '_viewport_cache'):
            handler._viewport_cache.clear()

        # Reset _needs_reload to prevent load_file from overwriting the in-memory update
        if hasattr(handler, '_needs_reload'):
            handler._needs_reload = False
    except Exception as cache_error:
        # Log but don't fail - the Zarr file was already updated
        print(f"[update_annotation] Warning: Failed to update handler cache: {cache_error}")

