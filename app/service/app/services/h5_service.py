import h5py
import numpy as np
from typing import Optional, List, Dict, Any, Union, Tuple
from pathlib import Path
import re
import json
from datetime import datetime
import traceback
from app.utils import resolve_path


class HDF5FileHandler:
    """HDF5 file handler, based on HDFView design pattern"""
    
    def __init__(self, file_path: str):
        self.file_path = file_path
        self.file = None
        self._validate_file()
    
    def _validate_file(self):
        """Validate if file exists and is in HDF5 format"""
        if not Path(self.file_path).exists():
            raise FileNotFoundError(f"File not found: {self.file_path}")
        
        try:
            with h5py.File(self.file_path, 'r') as f:
                pass  # Just test if it can be opened
        except Exception as e:
            raise ValueError(f"Invalid HDF5 file: {str(e)}")
    
    def __enter__(self):
        self.file = h5py.File(self.file_path, 'r')
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.file:
            self.file.close()
    
    def get_file_info(self) -> Dict[str, Any]:
        """Get basic file information"""
        with self:
            file_stats = Path(self.file_path).stat()
            
            # Count groups and datasets
            total_groups = 0
            total_datasets = 0
            
            def count_objects(name, obj):
                nonlocal total_groups, total_datasets
                if isinstance(obj, h5py.Group):
                    total_groups += 1
                elif isinstance(obj, h5py.Dataset):
                    total_datasets += 1
            
            self.file.visititems(count_objects)
            
            # Get file attributes
            file_attrs = {}
            for attr_name in self.file.attrs.keys():
                try:
                    attr_value = self.file.attrs[attr_name]
                    file_attrs[attr_name] = self._convert_hdf5_value(attr_value)
                except:
                    file_attrs[attr_name] = "<unreadable>"
            
            return {
                "file_path": self.file_path,
                "file_size": file_stats.st_size,
                "hdf5_version": h5py.version.hdf5_version,
                "h5py_version": h5py.version.version,
                "root_group_name": "/",
                "total_groups": total_groups,
                "total_datasets": total_datasets,
                "file_attributes": file_attrs,
                "last_modified": datetime.fromtimestamp(file_stats.st_mtime).isoformat()
            }
    
    def get_structure(self, path: str = "/", include_attributes: bool = True, 
                     max_depth: int = -1, current_depth: int = 0) -> Dict[str, Any]:
        """Recursively get file structure"""
        with self:
            try:
                obj = self.file[path]
            except KeyError:
                return None
            
            result = {
                "name": obj.name.split('/')[-1] if obj.name != '/' else "/",
                "full_path": obj.name,
                "type": "group" if isinstance(obj, h5py.Group) else "dataset"
            }
            
            # Add attributes
            if include_attributes:
                result["attributes"] = self._get_attributes(obj)
            
            # If it's a group, add children
            if isinstance(obj, h5py.Group):
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
            
            # If it's a dataset, add dataset information
            elif isinstance(obj, h5py.Dataset):
                result.update(self._get_dataset_info(obj))
            
            return result
    
    def get_group_info(self, group_path: str, include_datasets: bool = True, 
                      include_subgroups: bool = True) -> Optional[Dict[str, Any]]:
        """Get detailed group information"""
        with self:
            try:
                group = self.file[group_path]
                if not isinstance(group, h5py.Group):
                    return None
            except KeyError:
                return None
            
            result = {
                "name": group.name.split('/')[-1] if group.name != '/' else "/",
                "full_path": group.name,
                "type": "group",
                "attributes": self._get_attributes(group),
                "member_count": len(group.keys())
            }
            
            if include_datasets:
                datasets = []
                for key in group.keys():
                    obj = group[key]
                    if isinstance(obj, h5py.Dataset):
                        ds_info = {
                            "name": key,
                            "full_path": obj.name,
                            "type": "dataset"
                        }
                        ds_info.update(self._get_dataset_info(obj))
                        datasets.append(ds_info)
                result["datasets"] = datasets
            
            if include_subgroups:
                subgroups = []
                for key in group.keys():
                    obj = group[key]
                    if isinstance(obj, h5py.Group):
                        subgroups.append({
                            "name": key,
                            "full_path": obj.name,
                            "type": "group",
                            "member_count": len(obj.keys())
                        })
                result["subgroups"] = subgroups
            
            return result
    
    def get_dataset_info(self, dataset_path: str, include_preview: bool = False, 
                        preview_size: int = 10) -> Optional[Dict[str, Any]]:
        """Get detailed dataset information"""
        with self:
            try:
                dataset = self.file[dataset_path]
                if not isinstance(dataset, h5py.Dataset):
                    return None
            except KeyError:
                return None
            
            result = {
                "name": dataset.name.split('/')[-1],
                "full_path": dataset.name,
                "type": "dataset",
                "attributes": self._get_attributes(dataset)
            }
            
            result.update(self._get_dataset_info(dataset))
            
            if include_preview and dataset.size > 0:
                try:
                    preview_data, preview_shape = self._get_dataset_preview(dataset, preview_size)
                    result["preview"] = preview_data
                    result["preview_shape"] = preview_shape
                except Exception as e:
                    result["preview"] = f"<Error reading preview: {str(e)}>"
                    result["preview_shape"] = []
            
            return result
    
    def _get_dataset_preview(self, dataset, preview_size: int = 10) -> Tuple[Any, List[int]]:
        """Get dataset preview data, handling different data types safely"""
        try:
            # Handle scalar datasets
            if dataset.shape == ():
                data = dataset[()]
                return self._convert_hdf5_value(data), []
            
            # Handle empty datasets
            if dataset.size == 0:
                return [], list(dataset.shape)
            
            # For string datasets, handle specially
            if dataset.dtype.kind in ['S', 'U', 'O']:  # Byte string, Unicode string, Object
                return self._handle_string_dataset_preview(dataset, preview_size)
            
            # For numeric datasets
            if dataset.size <= preview_size:
                preview_data = dataset[...]
            else:
                # For multidimensional arrays, take first few elements
                if len(dataset.shape) == 1:
                    preview_data = dataset[:preview_size]
                else:
                    # For multidimensional case, take first few elements from first dimension
                    slices = [slice(None)] * len(dataset.shape)
                    slices[0] = slice(min(preview_size, dataset.shape[0]))
                    preview_data = dataset[tuple(slices)]
            
            return self._convert_hdf5_value(preview_data), list(preview_data.shape) if hasattr(preview_data, 'shape') else []
            
        except Exception as e:
            # If all else fails, return error message
            return f"<Cannot preview: {str(e)}>", []
    
    def _handle_string_dataset_preview(self, dataset, preview_size: int) -> Tuple[Any, List[int]]:
        """Handle string dataset preview safely"""
        try:
            if dataset.size == 1:
                # Single string value
                data = dataset[()]
                if isinstance(data, bytes):
                    try:
                        data = data.decode('utf-8')
                    except:
                        data = str(data)
                return data, []
            
            # Multiple string values
            if dataset.size <= preview_size:
                data = dataset[...]
            else:
                if len(dataset.shape) == 1:
                    data = dataset[:preview_size]
                else:
                    slices = [slice(None)] * len(dataset.shape)
                    slices[0] = slice(min(preview_size, dataset.shape[0]))
                    data = dataset[tuple(slices)]
            
            # Convert bytes to strings if needed
            if isinstance(data, np.ndarray):
                if data.dtype.kind == 'S':  # Byte strings
                    try:
                        data = np.array([item.decode('utf-8') if isinstance(item, bytes) else str(item) for item in data.flat]).reshape(data.shape)
                    except:
                        data = np.array([str(item) for item in data.flat]).reshape(data.shape)
            
            return self._convert_hdf5_value(data), list(data.shape) if hasattr(data, 'shape') else []
            
        except Exception as e:
            return f"<String preview error: {str(e)}>", []
    
    def read_dataset_data(self, dataset_path: str, start: Optional[List[int]] = None,
                         end: Optional[List[int]] = None, step: Optional[List[int]] = None,
                         flatten: bool = False, max_elements: int = 100000) -> Optional[Dict[str, Any]]:
        """Read dataset data with better error handling"""
        with self:
            try:
                dataset = self.file[dataset_path]
                if not isinstance(dataset, h5py.Dataset):
                    return None
            except KeyError:
                return None
            
            try:
                # Handle different data types
                if dataset.dtype.kind in ['S', 'U', 'O']:  # String types
                    return self._read_string_dataset(dataset, start, end, step, flatten, max_elements)
                else:
                    return self._read_numeric_dataset(dataset, start, end, step, flatten, max_elements)
                    
            except Exception as e:
                return {
                    "error": f"Error reading dataset: {str(e)}",
                    "shape": list(dataset.shape) if hasattr(dataset, 'shape') else [],
                    "dtype": str(dataset.dtype) if hasattr(dataset, 'dtype') else "unknown",
                    "original_shape": list(dataset.shape),
                    "original_size": int(dataset.size)
                }
    
    def _read_string_dataset(self, dataset, start, end, step, flatten, max_elements):
        """Read string dataset safely"""
        try:
            # Check dataset size for strings
            total_elements = dataset.size
            if total_elements > max_elements:
                if start is None and end is None:
                    if len(dataset.shape) == 1:
                        end = [min(max_elements, dataset.shape[0])]
                        start = [0]
                    else:
                        # For multidimensional case
                        ratio = max_elements / total_elements
                        first_dim_size = int(dataset.shape[0] * ratio**0.5)
                        first_dim_size = min(first_dim_size, dataset.shape[0])
                        end = [first_dim_size] + list(dataset.shape[1:])
                        start = [0] * len(dataset.shape)
            
            # Build slices
            if start is not None or end is not None or step is not None:
                slices = []
                for i in range(len(dataset.shape)):
                    s = start[i] if start and i < len(start) else 0
                    e = end[i] if end and i < len(end) else dataset.shape[i]
                    st = step[i] if step and i < len(step) else 1
                    slices.append(slice(s, e, st))
                
                data = dataset[tuple(slices)]
            else:
                data = dataset[...]
            
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
            is_truncated = dataset.size > max_elements and (start is not None or end is not None)
            
            if flatten and hasattr(data, 'flatten'):
                data = data.flatten()
            
            return {
                "data": self._convert_hdf5_value(data),
                "shape": list(data.shape) if hasattr(data, 'shape') else [],
                "dtype": str(data.dtype) if hasattr(data, 'dtype') else str(type(data)),
                "total_elements": int(data.size) if hasattr(data, 'size') else len(data) if hasattr(data, '__len__') else 1,
                "is_truncated": is_truncated,
                "original_shape": list(dataset.shape),
                "original_size": int(dataset.size)
            }
            
        except Exception as e:
            raise ValueError(f"Error reading string data: {str(e)}")
    
    def _read_numeric_dataset(self, dataset, start, end, step, flatten, max_elements):
        """Read numeric dataset safely"""
        # Check dataset size
        total_elements = dataset.size
        if total_elements > max_elements:
            # If no slice specified, automatically create a reasonable slice
            if start is None and end is None:
                # Calculate reasonable slice size
                if len(dataset.shape) == 1:
                    end = [min(max_elements, dataset.shape[0])]
                    start = [0]
                else:
                    # For multidimensional case, only read part of first dimension
                    ratio = max_elements / total_elements
                    first_dim_size = int(dataset.shape[0] * ratio**0.5)
                    first_dim_size = min(first_dim_size, dataset.shape[0])
                    end = [first_dim_size] + list(dataset.shape[1:])
                    start = [0] * len(dataset.shape)
        
        # Build slices
        if start is not None or end is not None or step is not None:
            slices = []
            for i in range(len(dataset.shape)):
                s = start[i] if start and i < len(start) else 0
                e = end[i] if end and i < len(end) else dataset.shape[i]
                st = step[i] if step and i < len(step) else 1
                slices.append(slice(s, e, st))
            
            data = dataset[tuple(slices)]
        else:
            data = dataset[...]
        
        # Check if truncated
        is_truncated = data.size > max_elements
        if is_truncated:
            # Truncate data
            flat_data = data.flatten()
            data = flat_data[:max_elements].reshape(-1) if flatten else flat_data[:max_elements]
        
        if flatten and not is_truncated:
            data = data.flatten()
        
        return {
            "data": self._convert_hdf5_value(data),
            "shape": list(data.shape) if hasattr(data, 'shape') else [],
            "dtype": str(data.dtype) if hasattr(data, 'dtype') else str(type(data)),
            "total_elements": int(data.size) if hasattr(data, 'size') else len(data) if hasattr(data, '__len__') else 1,
            "is_truncated": is_truncated,
            "original_shape": list(dataset.shape),
            "original_size": int(dataset.size)
        }
    
    def get_object_attributes(self, object_path: str, attribute_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Get object attributes"""
        with self:
            try:
                obj = self.file[object_path]
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
                group = self.file[group_path]
                if not isinstance(group, h5py.Group):
                    return []
            except KeyError:
                return []
            
            contents = []
            
            def process_object(name, obj):
                try:
                    obj_info = {
                        "name": name.split('/')[-1],
                        "path": obj.name,
                        "type": "group" if isinstance(obj, h5py.Group) else "dataset"
                    }
                    
                    if isinstance(obj, h5py.Dataset):
                        obj_info.update(self._get_dataset_info(obj))
                    elif isinstance(obj, h5py.Group):
                        obj_info["member_count"] = len(obj.keys())
                    
                    # Apply object type filter
                    if object_type is None or obj_info["type"] == object_type:
                        contents.append(obj_info)
                except Exception as e:
                    # Skip objects that can't be read
                    pass
            
            if recursive:
                group.visititems(process_object)
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
            
            def search_visitor(name, obj):
                try:
                    obj_info = {
                        "path": obj.name,
                        "name": name.split('/')[-1],
                        "type": "group" if isinstance(obj, h5py.Group) else "dataset",
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
                    if search_attributes:
                        for attr_name in obj.attrs.keys():
                            if pattern.search(attr_name):
                                attr_match_info = obj_info.copy()
                                attr_match_info["match_type"] = "attribute"
                                attr_match_info["matched_attribute"] = attr_name
                                results.append(attr_match_info)
                except Exception as e:
                    # Skip objects that can't be read
                    pass
            
            self.file.visititems(search_visitor)
            return results
    
    def analyze_file(self, include_statistics: bool = True, sample_size: int = 1000) -> Dict[str, Any]:
        """Analyze HDF5 file"""
        with self:
            analysis = {
                "file_summary": self.get_file_info(),
                "structure_analysis": {},
                "recommendations": []
            }
            
            # Structure analysis
            total_groups = 0
            total_datasets = 0
            max_depth = 0
            dataset_sizes = []
            dataset_types = {}
            
            def analyze_visitor(name, obj):
                nonlocal total_groups, total_datasets, max_depth
                
                try:
                    depth = name.count('/')
                    max_depth = max(max_depth, depth)
                    
                    if isinstance(obj, h5py.Group):
                        total_groups += 1
                    elif isinstance(obj, h5py.Dataset):
                        total_datasets += 1
                        dataset_sizes.append(obj.size)
                        
                        dtype_str = str(obj.dtype)
                        dataset_types[dtype_str] = dataset_types.get(dtype_str, 0) + 1
                except Exception as e:
                    # Skip objects that can't be analyzed
                    pass
            
            self.file.visititems(analyze_visitor)
            
            analysis["structure_analysis"] = {
                "total_groups": total_groups,
                "total_datasets": total_datasets,
                "max_depth": max_depth,
                "dataset_types": dataset_types,
                "average_dataset_size": np.mean(dataset_sizes) if dataset_sizes else 0,
                "total_data_size": sum(dataset_sizes) if dataset_sizes else 0
            }
            
            # Data statistics
            if include_statistics and dataset_sizes:
                analysis["data_statistics"] = {
                    "dataset_count": len(dataset_sizes),
                    "min_dataset_size": min(dataset_sizes),
                    "max_dataset_size": max(dataset_sizes),
                    "median_dataset_size": np.median(dataset_sizes),
                    "std_dataset_size": np.std(dataset_sizes)
                }
            
            # Generate recommendations
            recommendations = []
            if max_depth > 10:
                recommendations.append("File structure is quite deep, consider simplifying hierarchy to improve access efficiency")
            
            if len(dataset_types) > 20:
                recommendations.append("Many data types present, consider standardizing data types")
            
            if analysis["structure_analysis"]["total_data_size"] > 1e9:  # 1GB
                recommendations.append("Large file size, consider using compression or chunked storage")
            
            analysis["recommendations"] = recommendations
            
            return analysis
    
    def _get_attributes(self, obj) -> Dict[str, Any]:
        """Get all attributes of an object"""
        attrs = {}
        for attr_name in obj.attrs.keys():
            try:
                attr_value = obj.attrs[attr_name]
                attrs[attr_name] = {
                    "value": self._convert_hdf5_value(attr_value),
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
    
    def _get_dataset_info(self, dataset) -> Dict[str, Any]:
        """Get basic dataset information with better error handling"""
        try:
            info = {
                "shape": list(dataset.shape),
                "dtype": str(dataset.dtype),
                "size": int(dataset.size),
            }
            
            # Try to get nbytes, but handle cases where it might fail
            try:
                info["nbytes"] = int(dataset.nbytes)
            except:
                info["nbytes"] = dataset.size * dataset.dtype.itemsize
            
            # Compression information
            try:
                if dataset.compression:
                    info["compression"] = dataset.compression
                    if dataset.compression_opts:
                        info["compression_opts"] = dataset.compression_opts
            except:
                pass
            
            # Chunking information
            try:
                if dataset.chunks:
                    info["chunks"] = list(dataset.chunks)
            except:
                pass
            
            # Fill value
            try:
                if dataset.fillvalue is not None:
                    info["fillvalue"] = self._convert_hdf5_value(dataset.fillvalue)
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
    
    def _convert_hdf5_value(self, value):
        """Convert HDF5 value to Python native type with better error handling"""
        try:
            if isinstance(value, np.ndarray):
                if value.size == 0:
                    return []
                elif value.size == 1:
                    item = value.item()
                    # Handle byte strings
                    if isinstance(item, bytes):
                        try:
                            return item.decode('utf-8')
                        except:
                            return str(item)
                    return item
                elif value.size <= 100:  # Convert small arrays directly
                    # Handle string arrays
                    if value.dtype.kind == 'S':  # Byte strings
                        try:
                            return [item.decode('utf-8') if isinstance(item, bytes) else str(item) for item in value.flat]
                        except:
                            return [str(item) for item in value.flat]
                    elif value.dtype.kind == 'U':  # Unicode strings
                        return value.tolist()
                    else:
                        return value.tolist()
                else:
                    return f"<Array shape={value.shape}, dtype={value.dtype}>"
            elif isinstance(value, np.bytes_):
                try:
                    return value.decode('utf-8')
                except:
                    return str(value)
            elif isinstance(value, bytes):
                try:
                    return value.decode('utf-8')
                except:
                    return str(value)
            elif isinstance(value, (np.integer, np.floating)):
                return value.item()
            else:
                return value
        except Exception as e:
            return f"<Conversion error: {str(e)}>"


# Service functions for API calls
def get_file_structure(file_path: str, path: Optional[str] = None, 
                      include_attributes: bool = True, max_depth: int = -1) -> Dict[str, Any]:
    """Get HDF5 file structure"""
    try:
        handler = HDF5FileHandler(file_path)
        start_path = path if path else "/"
        
        structure = handler.get_structure(start_path, include_attributes, max_depth)
        
        if not structure:
            raise ValueError(f"Path not found: {start_path}")
        
        # Add statistics information
        with handler:
            total_groups = 0
            total_datasets = 0
            
            def count_visitor(name, obj):
                nonlocal total_groups, total_datasets
                try:
                    if isinstance(obj, h5py.Group):
                        total_groups += 1
                    elif isinstance(obj, h5py.Dataset):
                        total_datasets += 1
                except:
                    pass
            
            handler.file.visititems(count_visitor)
        
        return {
            "root": structure,
            "total_groups": total_groups,
            "total_datasets": total_datasets
        }
    except Exception as e:
        raise ValueError(f"Error getting file structure: {str(e)}")


def get_group_info(file_path: str, group_path: str, include_datasets: bool = True,
                  include_subgroups: bool = True) -> Optional[Dict[str, Any]]:
    """Get group information"""
    try:
        handler = HDF5FileHandler(file_path)
        return handler.get_group_info(group_path, include_datasets, include_subgroups)
    except Exception as e:
        raise ValueError(f"Error getting group info: {str(e)}")


def get_dataset_info(file_path: str, dataset_path: str, include_preview: bool = False,
                    preview_size: int = 10) -> Optional[Dict[str, Any]]:
    """Get dataset information"""
    try:
        handler = HDF5FileHandler(file_path)
        return handler.get_dataset_info(dataset_path, include_preview, preview_size)
    except Exception as e:
        raise ValueError(f"Error getting dataset info: {str(e)}")


def read_dataset_data(file_path: str, dataset_path: str, start: Optional[List[int]] = None,
                     end: Optional[List[int]] = None, step: Optional[List[int]] = None,
                     flatten: bool = False, max_elements: int = 100000) -> Optional[Dict[str, Any]]:
    """Read dataset data"""
    try:
        handler = HDF5FileHandler(file_path)
        return handler.read_dataset_data(dataset_path, start, end, step, flatten, max_elements)
    except Exception as e:
        raise ValueError(f"Error reading dataset data: {str(e)}")


def get_object_attributes(file_path: str, object_path: str, 
                         attribute_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get object attributes"""
    try:
        handler = HDF5FileHandler(file_path)
        return handler.get_object_attributes(object_path, attribute_name)
    except Exception as e:
        raise ValueError(f"Error getting object attributes: {str(e)}")


def list_file_contents(file_path: str, group_path: str = "/", recursive: bool = False,
                      object_type: Optional[str] = None) -> List[Dict[str, Any]]:
    """List file contents"""
    try:
        handler = HDF5FileHandler(file_path)
        return handler.list_contents(group_path, recursive, object_type)
    except Exception as e:
        raise ValueError(f"Error listing file contents: {str(e)}")


# Utility functions
def validate_hdf5_file(file_path: str) -> bool:
    """Validate if it's a valid HDF5 file"""
    try:
        with h5py.File(file_path, 'r') as f:
            return True
    except:
        return False


def get_hdf5_version_info() -> Dict[str, str]:
    """Get HDF5 version information"""
    return {
        "hdf5_version": h5py.version.hdf5_version,
        "h5py_version": h5py.version.version,
        "numpy_version": np.__version__
    }

def search_hdf5_objects(file_path: str, query: str, object_type: Optional[str] = None,
                       search_attributes: bool = False, case_sensitive: bool = False) -> Dict[str, Any]:
    """Search HDF5 objects service"""
    try:
        if object_type and object_type not in ['group', 'dataset']:
            raise ValueError("object_type must be 'group' or 'dataset'")
        
        handler = HDF5FileHandler(file_path)
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


def analyze_hdf5_file_service(file_path: str, include_statistics: bool = True, 
                             sample_size: int = 1000) -> Dict[str, Any]:
    """Analyze HDF5 file service"""
    try:
        handler = HDF5FileHandler(file_path)
        analysis = handler.analyze_file(include_statistics, sample_size)
        return analysis
    except Exception as e:
        raise ValueError(f"Error analyzing file: {str(e)}")


def validate_hdf5_file_service(file_path: str) -> Dict[str, Any]:
    """Validate HDF5 file service"""
    try:
        is_valid = validate_hdf5_file(file_path)
        return {
            "is_valid": is_valid,
            "file_path": file_path
        }
    except Exception as e:
        raise ValueError(f"Error validating file: {str(e)}")


def list_hdf5_contents_service(file_path: str, group_path: str = "/", 
                              recursive: bool = False, object_type: Optional[str] = None) -> Dict[str, Any]:
    """List HDF5 contents service"""
    try:
        if object_type and object_type not in ['group', 'dataset']:
            raise ValueError("object_type must be 'group' or 'dataset'")
        
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
    """Enhanced file analysis service combining segmentation and HDF5 analysis"""
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
        
        # Try HDF5 structure analysis
        try:
            if validate_hdf5_file(file_path):
                hdf5_handler = HDF5FileHandler(file_path)
                hdf5_info = hdf5_handler.get_file_info()
                
                # Get simplified structure information
                structure = get_file_structure(file_path, max_depth=2)
                
                result["hdf5_analysis"] = {
                    "is_hdf5": True,
                    "total_groups": hdf5_info["total_groups"],
                    "total_datasets": hdf5_info["total_datasets"],
                    "file_size": hdf5_info["file_size"],
                    "structure_summary": structure
                }
            else:
                result["hdf5_analysis"] = {
                    "is_hdf5": False,
                    "message": "File is not a valid HDF5 format"
                }
        
        except Exception as e:
            result["hdf5_analysis"] = {
                "error": f"HDF5 analysis failed: {str(e)}"
            }
        
        return result
    except Exception as e:
        raise ValueError(f"Enhanced analysis failed: {str(e)}")


def search_segmentation_datasets_service(file_path: str, query: str, 
                                        include_segmentation: bool = True) -> Dict[str, Any]:
    """Search for segmentation-related datasets service"""
    try:
        if not validate_hdf5_file(file_path):
            raise ValueError("File is not a valid HDF5 file")
        
        handler = HDF5FileHandler(file_path)
        
        # Search for related datasets
        search_results = handler.search_objects(query, object_type="dataset")
        
        # If segmentation-related search is enabled, add common segmentation dataset keywords
        if include_segmentation:
            segmentation_keywords = [
                "nuclei", "tissue", "patch", "annotation", "classification", 
                "segmentation", "mask", "label", "centroid", "boundary"
            ]
            
            for keyword in segmentation_keywords:
                if keyword.lower() in query.lower():
                    continue  # Avoid duplicate searches
                
                additional_results = handler.search_objects(keyword, object_type="dataset")
                search_results.extend(additional_results)
        
        # Remove duplicates and sort
        unique_results = []
        seen_paths = set()
        for result in search_results:
            if result["path"] not in seen_paths:
                unique_results.append(result)
                seen_paths.add(result["path"])
        
        # Add detailed information for each dataset
        detailed_results = []
        for result in unique_results[:20]:  # Limit return count
            try:
                dataset_info = get_dataset_info(file_path, result["path"])
                if dataset_info:
                    result["details"] = {
                        "shape": dataset_info["shape"],
                        "dtype": dataset_info["dtype"],
                        "size": dataset_info["size"]
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


def get_batch_dataset_info_service(file_path: str, dataset_paths: List[str], 
                                  include_preview: bool = False) -> Dict[str, Any]:
    """Get dataset information in batch service"""
    try:
        results = {}
        errors = {}
        
        for dataset_path in dataset_paths:
            try:
                if not dataset_path.startswith('/'):
                    dataset_path = '/' + dataset_path
                
                dataset_info = get_dataset_info(file_path, dataset_path, include_preview)
                if dataset_info:
                    results[dataset_path] = dataset_info
                else:
                    errors[dataset_path] = "Dataset not found"
            
            except Exception as e:
                errors[dataset_path] = str(e)
        
        return {
            "results": results,
            "errors": errors,
            "requested_count": len(dataset_paths),
            "success_count": len(results),
            "error_count": len(errors)
        }
    except Exception as e:
        raise ValueError(f"Batch operation failed: {str(e)}")


def export_hdf5_structure_service(file_path: str, export_path: str, format: str = "json",
                                 include_attributes: bool = True, max_depth: int = -1) -> Dict[str, Any]:
    """Export HDF5 file structure service"""
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
            "message": f"HDF5 structure exported successfully to {real_export_path}",
            "export_path": real_export_path,
            "format": format,
            "total_groups": structure["total_groups"],
            "total_datasets": structure["total_datasets"]
        }
    except Exception as e:
        raise ValueError(f"Export failed: {str(e)}")


def validate_file_path_and_security(file_path: str) -> None:
    """Validate file path and perform security checks"""
    import os
    
    if not file_path:
        raise ValueError("No file path provided")
    
    # Use real path to handle symlinks and normalize path
    real_file_path = resolve_path(file_path)
    
    # Security check: prevent access to system sensitive directories
    dangerous_paths = ["/etc/", "/usr/bin/", "/bin/", "/sbin/", "/root/", "/boot/", "/sys/", "/proc/"]
    if any(real_file_path.startswith(dangerous) for dangerous in dangerous_paths):
        raise ValueError("File path not allowed")
    
    # Ensure file extension is safe (case-insensitive)
    if not real_file_path.lower().endswith(('.h5', '.hdf5')):
        raise ValueError("Invalid file type. Only H5/HDF5 files are allowed")
    
    if not validate_hdf5_file(real_file_path):
        raise ValueError("Invalid HDF5 file")
