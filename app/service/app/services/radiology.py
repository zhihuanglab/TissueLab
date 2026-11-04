"""
Radiology mask discovery and loading service
Provides intelligent search for segmentation masks in Zarr files for NII volumes
"""

import zarr
from app.config.zarr_compat import open_zarr, open_zarr_cm
import numpy as np
from typing import Optional, List, Dict, Any
from pathlib import Path

from app.utils import resolve_path


class RadiologyMaskFinder:
    """Service for finding and loading segmentation masks from Zarr files for NII volumes"""

    # Two mask layouts are recognised:
    #   <prefix>/voxel_mask/<name>              legacy radiology nodes (one array per label)
    #   <group>/masks/<organ>/mask (3D bool)    VISTA-style layout written by radiology
    #                                           segmentation task nodes such as
    #                                           TotalSegmentator (Tissue-Segmentation group,
    #                                           next to classes/{name,color} and an HU "image")
    VOXEL_MASK_KEY = 'voxel_mask'
    TISSUE_MASKS_KEY = 'masks'
    MASK_ARRAY_KEY = 'mask'

    @classmethod
    def dataset_display_name(cls, dataset_path: str) -> str:
        """Label for a mask dataset path: the array name, or the parent group for
        ``.../masks/<organ>/mask`` where every array is called ``mask``."""
        parts = [p for p in str(dataset_path).split('/') if p]
        if not parts:
            return str(dataset_path)
        if parts[-1] == cls.MASK_ARRAY_KEY and len(parts) >= 2:
            return parts[-2]
        return parts[-1]

    def find_zarr_files(self, base_path: str) -> List[str]:
        """Find potential Zarr files based on base path"""
        base_path = Path(base_path)

        results: List[str] = []

        # Fixed naming: if input is a file, only accept "<filename>.zarr" in the same directory
        if base_path.is_file():
            exact = base_path.parent / f"{base_path.name}.zarr"
            if exact.exists():
                results.append(str(exact))

        # If input is a directory, list all .zarr files directly under it
        elif base_path.is_dir():
            for zarr_file in base_path.glob("*.zarr"):
                results.append(str(zarr_file))

        return results
    
    def find_datasets(self, zarr_file_path: str) -> List[Dict[str, Any]]:
        """Find all mask datasets in a Zarr file.

        Searches every group for a ``voxel_mask`` subgroup (legacy layout) and for a
        ``masks`` subgroup holding ``<organ>/mask`` 3D arrays (VISTA-style layout).
        2D ``masks/*/mask`` rasters belong to pathology slides and are skipped.
        """
        datasets = []

        def _entry(full_path: str, name: str, arr: zarr.Array, prefix: str) -> Dict[str, Any]:
            return {
                'path': full_path,
                'name': name,
                'shape': arr.shape,
                'dtype': str(arr.dtype),
                'size': arr.size,
                'nbytes': arr.nbytes,
                'prefix': prefix,
            }

        try:
            with open_zarr_cm(zarr_file_path, 'r') as f:

                def collect_voxel_masks(name, voxel_mask_group):
                    prefix = name.split('/')[-1] if '/' in name else name

                    # zarr v3 removed Group.visititems(); walk descendants
                    # manually, passing each node's path relative to the
                    # group (matching the old visititems contract).
                    def _walk(group, rel_prefix=""):
                        for key in group.keys():
                            child = group[key]
                            child_path = f"{rel_prefix}/{key}" if rel_prefix else key
                            if isinstance(child, zarr.Array):
                                full_path = f"{name}/{self.VOXEL_MASK_KEY}/{child_path}"
                                datasets.append(_entry(full_path, Path(child_path).name, child, prefix))
                            elif isinstance(child, zarr.Group):
                                _walk(child, child_path)

                    _walk(voxel_mask_group)

                def collect_tissue_masks(name, masks_group) -> bool:
                    """``masks/<organ>/mask`` 3D arrays; returns True if any were found."""
                    prefix = name.split('/')[-1] if '/' in name else name
                    found = False
                    for organ in masks_group.keys():
                        organ_group = masks_group[organ]
                        if not isinstance(organ_group, zarr.Group) or self.MASK_ARRAY_KEY not in organ_group:
                            continue
                        arr = organ_group[self.MASK_ARRAY_KEY]
                        if not isinstance(arr, zarr.Array) or arr.ndim != 3:
                            continue
                        full_path = f"{name}/{self.TISSUE_MASKS_KEY}/{organ}/{self.MASK_ARRAY_KEY}"
                        entry = _entry(full_path, organ, arr, prefix)
                        try:
                            entry['organ_name'] = organ_group.attrs.get('organ_name', organ)
                        except Exception:
                            entry['organ_name'] = organ
                        datasets.append(entry)
                        found = True
                    return found

                # Search for any group that carries masks (recursively)
                def find_mask_groups(name, obj):
                    if not isinstance(obj, zarr.Group):
                        return
                    handled = False
                    if self.VOXEL_MASK_KEY in obj and isinstance(obj[self.VOXEL_MASK_KEY], zarr.Group):
                        collect_voxel_masks(name, obj[self.VOXEL_MASK_KEY])
                        handled = True
                    if self.TISSUE_MASKS_KEY in obj and isinstance(obj[self.TISSUE_MASKS_KEY], zarr.Group):
                        handled = collect_tissue_masks(name, obj[self.TISSUE_MASKS_KEY]) or handled
                    if handled:
                        return
                    # Recursively search in subdirectories
                    for key in obj.keys():
                        child = obj[key]
                        if isinstance(child, zarr.Group):
                            find_mask_groups(f"{name}/{key}" if name != '/' else f"/{key}", child)

                # Start the search from the root
                find_mask_groups('/', f)

        except Exception as e:
            print(f"Error reading Zarr file {zarr_file_path}: {str(e)}")
            return []

        return datasets


    def find_radiology_mask(self, base_path: str) -> Optional[Dict[str, Any]]:
        """Find radiology mask(s) for a given base path, automatically merge if multiple datasets found"""
        # Find potential Zarr files
        zarr_files = self.find_zarr_files(base_path)
        
        if not zarr_files:
            return None
        
        # Try each Zarr file
        for zarr_file in zarr_files:
            try:
                # Get all available datasets
                all_datasets = self.find_datasets(zarr_file)
                
                if not all_datasets:
                    continue
                
                # If only one dataset, return it directly
                if len(all_datasets) == 1:
                    dataset = all_datasets[0]
                    dataset['zarr_file'] = zarr_file
                    dataset['is_merged'] = False
                    return dataset
                
                # If multiple datasets, create merged info
                merged_info = {
                    'zarr_file': zarr_file,
                    'is_merged': True,
                    'num_datasets': len(all_datasets),
                    'datasets': all_datasets,
                    'merged_path': 'auto_merged',  # Special identifier for merged data
                    'shape': all_datasets[0]['shape'] if all_datasets else None,
                    'dtype': all_datasets[0]['dtype'] if all_datasets else None
                }
                return merged_info
                
            except Exception as e:
                print(f"Error finding datasets in {zarr_file}: {str(e)}")
                continue
        
        return None

    def _convert_to_binary_mask(self, data: np.ndarray, orig_dtype: str) -> np.ndarray:
        """Convert data to binary mask uint8 (0/255) efficiently
        
        Args:
            data: Input array to convert
            orig_dtype: Original data type as string
            
        Returns:
            Binary mask as uint8 array with values 0 or 255
        """
        if orig_dtype == 'uint8':
            # Data is already uint8 - use fast sampling to check format
            sample_size = min(10000, data.size)
            sample = data.flat[:sample_size]
            max_val = np.max(sample)
            
            if max_val <= 1:
                # Binary 0/1 format, multiply by 255 efficiently
                return data * np.uint8(255)
            elif max_val == 255:
                # Already in 0/255 format, use as-is
                return data
            else:
                # Has other values, convert non-zero to 255
                mask_uint8 = np.zeros_like(data, dtype=np.uint8)
                mask_uint8[data != 0] = 255
                return mask_uint8
        else:
            # Non-uint8 data, convert to binary mask efficiently
            mask_uint8 = np.zeros(data.shape, dtype=np.uint8)
            mask_uint8[data != 0] = 255
            return mask_uint8
    
    def _count_nonzero(self, data: np.ndarray, mask_uint8: np.ndarray, orig_dtype: str) -> int:
        """Count non-zero voxels efficiently
        
        Args:
            data: Original data array
            mask_uint8: Converted binary mask
            orig_dtype: Original data type as string
            
        Returns:
            Count of non-zero voxels
        """
        try:
            if orig_dtype == 'uint8':
                # For uint8 data, count non-zero elements directly from original data
                return int(np.sum(data != 0))
            else:
                # For other data types, count from converted mask
                return int(np.count_nonzero(mask_uint8))
        except Exception:
            return -1
    
    def load_radiology_mask_data(self, zarr_file_path: str, dataset_path_or_info) -> Optional[Dict[str, Any]]:
        """Load radiology mask data from Zarr file (single dataset or auto-merged multiple datasets)"""
        try:
            # Check if this is auto-merged data
            if isinstance(dataset_path_or_info, dict) and dataset_path_or_info.get('is_merged', False):
                dataset_paths = [d['path'] for d in dataset_path_or_info.get('datasets', [])]
                return self.load_merged_radiology_mask_data(zarr_file_path, dataset_paths)
            
            # Single dataset - extract path
            dataset_path = (dataset_path_or_info if isinstance(dataset_path_or_info, str) 
                          else dataset_path_or_info.get('path', ''))
            
            with open_zarr_cm(zarr_file_path, 'r') as f:
                dataset = f[dataset_path]
                shape = dataset.shape
                orig_dtype = str(dataset.dtype)
                data = dataset[:]
                
                # Convert to binary mask (0/255)
                mask_uint8 = self._convert_to_binary_mask(data, orig_dtype)
                
                # Count non-zero voxels
                nonzero_count = self._count_nonzero(data, mask_uint8, orig_dtype)
                
                return {
                    'data': mask_uint8.tobytes(),
                    'shape': shape,
                    'dtype': 'uint8',
                    'is_subset': False,
                    'original_size': dataset.size,
                    'nonzero_count': nonzero_count,
                    'all_zero': (nonzero_count == 0),
                    'is_merged': False
                }
                    
        except Exception as e:
            print(f"Error loading radiology mask data from {zarr_file_path}: {str(e)}")
            return None

    def load_merged_radiology_mask_data(self, zarr_file_path: str, dataset_paths: List[str]) -> Optional[Dict[str, Any]]:
        """Load and merge multiple radiology mask datasets into a single labelmap
        
        This function merges multiple segmentation datasets into a single labelmap where:
        - Class 1 mask values = 1
        - Class 2 mask values = 2
        - Class 3 mask values = 3
        - etc.
        
        Args:
            zarr_file_path: Path to the Zarr file
            dataset_paths: List of dataset paths to merge (e.g., ['/prefix1/voxel_mask/liver', '/prefix2/voxel_mask/kidney'])
            
        Returns:
            Dictionary containing merged data with class information
        """
        try:
            with open_zarr_cm(zarr_file_path, 'r') as f:
                merged_data = None
                shape = None
                class_info = []
                
                for i, dataset_path in enumerate(dataset_paths):
                    if dataset_path not in f:
                        print(f"Warning: Dataset {dataset_path} not found in Zarr file")
                        continue
                    
                    dataset = f[dataset_path]
                    data = dataset[:]
                    
                    if shape is None:
                        shape = data.shape
                        merged_data = np.zeros(shape, dtype=np.uint8)
                    elif data.shape != shape:
                        print(f"Warning: Dataset {dataset_path} has different shape {data.shape} than expected {shape}")
                        continue
                    
                    # Optimized: Direct boolean indexing without intermediate conversion
                    # This avoids creating a temporary boolean array copy
                    class_label = i + 1
                    
                    # Use direct comparison for indexing - much faster than creating astype(bool)
                    nonzero_mask = (data != 0)
                    merged_data[nonzero_mask] = class_label
                    
                    # Count non-zero voxels efficiently
                    # Use np.sum on boolean array which is faster than count_nonzero
                    nonzero_count = int(np.sum(nonzero_mask))
                    
                    class_info.append({
                        'class_id': class_label,
                        'dataset_path': dataset_path,
                        'dataset_name': self.dataset_display_name(dataset_path),
                        'nonzero_count': nonzero_count
                    })
                
                if merged_data is None:
                    return None
                
                # No need for additional conversion - merged_data is already uint8
                # Just compute stats and convert to bytes
                total_nonzero_count = int(np.sum(merged_data != 0))
                data_bytes = merged_data.tobytes()
                
                return {
                    'data': data_bytes,
                    'shape': shape,
                    'dtype': 'uint8',
                    'is_subset': False,
                    'original_size': merged_data.size,
                    'nonzero_count': total_nonzero_count,
                    'all_zero': (total_nonzero_count == 0),
                    'is_merged': True,
                    'class_info': class_info,
                    'num_classes': len(class_info)
                }
                
        except Exception as e:
            print(f"Error loading merged radiology mask data from {zarr_file_path}: {str(e)}")
            return None


# Service functions for API endpoints
def find_radiology_mask_service(base_path: str) -> Dict[str, Any]:
    """Find radiology mask for a given base path (auto-merge if multiple datasets found)"""
    base_path = resolve_path(base_path)
    finder = RadiologyMaskFinder()
    result = finder.find_radiology_mask(base_path)
    
    if result:
        if result.get('is_merged', False):
            # Multiple datasets found, return merged info
            return {
                'found': True,
                'zarr_file': result['zarr_file'],
                'is_merged': True,
                'num_datasets': result['num_datasets'],
                'datasets': result['datasets'],
                'shape': result['shape'],
                'dtype': result['dtype'],
                'message': f'Found {result["num_datasets"]} datasets, will be auto-merged'
            }
        else:
            # Single dataset found
            return {
                'found': True,
                'zarr_file': result['zarr_file'],
                'dataset_path': result['path'],
                'dataset_name': result['name'],
                'shape': result['shape'],
                'dtype': result['dtype'],
                'size': result['size'],
                'nbytes': result['nbytes'],
                'is_merged': False
            }
    else:
        return {
            'found': False,
            'message': 'No radiology mask found (looked for <prefix>/voxel_mask/* and <group>/masks/<organ>/mask)'
        }


def load_radiology_mask_data_service(zarr_file_path: str, dataset_path_or_info) -> Dict[str, Any]:
    """Load radiology mask data (single dataset or auto-merged multiple datasets)"""
    finder = RadiologyMaskFinder()
    result = finder.load_radiology_mask_data(zarr_file_path, dataset_path_or_info)
    
    if result:
        success = not bool(result.get('all_zero', False))
        response = {
            'success': success,
            'data': result['data'],  # Keep as bytes for binary response
            'shape': result['shape'],
            'dtype': result['dtype'],
            'is_subset': result['is_subset'],
            'original_size': result['original_size'],
            'nonzero_count': result.get('nonzero_count'),
            'all_zero': result.get('all_zero', False),
            'is_merged': result.get('is_merged', False),
            'message': None if success else 'Mask is all zeros'
        }
        
        # Add merge-specific fields if this is a merged dataset
        if result.get('is_merged', False):
            response.update({
                'class_info': result.get('class_info', []),
                'num_classes': result.get('num_classes', 0)
            })
        
        return response
    else:
        return {
            'success': False,
            'message': 'Failed to load radiology mask data'
        }


def search_radiology_mask_datasets_service(zarr_file_path: str, query: str = "", 
                                   include_segmentation: bool = True) -> Dict[str, Any]:
    """Search for radiology mask datasets in Zarr file (voxel_mask/* or masks/<organ>/mask)"""
    zarr_file_path = resolve_path(zarr_file_path)
    finder = RadiologyMaskFinder()
    datasets = finder.find_datasets(zarr_file_path)
    
    # Filter by query if provided
    if query:
        query_lower = query.lower()
        datasets = [d for d in datasets if query_lower in d['name'].lower() or query_lower in d['path'].lower()]
    
    return {
        'datasets': datasets,
        'count': len(datasets),
        'query': query,
        'zarr_file': zarr_file_path
    }


def load_radiology_mask_by_path_service(zarr_file_path: str) -> Dict[str, Any]:
    """Resolve a user-supplied path, locate its mask dataset(s), and load the mask data.

    Accepts either a direct .zarr file path or an original volume path. Raises
    FileNotFoundError when no datasets can be located.
    """
    resolved_path = resolve_path(zarr_file_path)
    finder = RadiologyMaskFinder()

    if resolved_path.endswith('.zarr'):
        # Direct Zarr file path - find datasets in this file
        datasets = finder.find_datasets(resolved_path)
        if not datasets:
            raise FileNotFoundError("No datasets found")

        if len(datasets) == 1:
            mask_info = datasets[0]
            mask_info['zarr_file'] = resolved_path
            mask_info['is_merged'] = False
        else:
            mask_info = {
                'zarr_file': resolved_path,
                'is_merged': True,
                'num_datasets': len(datasets),
                'datasets': datasets,
                'merged_path': 'auto_merged',
                'shape': datasets[0]['shape'] if datasets else None,
                'dtype': datasets[0]['dtype'] if datasets else None
            }
    else:
        # Original file path - find corresponding Zarr file
        mask_info = finder.find_radiology_mask(resolved_path)
        if not mask_info:
            raise FileNotFoundError("No datasets found")

    return load_radiology_mask_data_service(mask_info['zarr_file'], mask_info)


def auto_find_and_load_radiology_mask_service(base_path: str) -> Optional[Dict[str, Any]]:
    """Find the best radiology mask under base_path and load its data.

    Returns None when no mask is found.
    """
    find_result = find_radiology_mask_service(base_path)
    if not find_result['found']:
        return None
    return load_radiology_mask_data_service(find_result['zarr_file'], find_result['dataset_path'])


def list_zarr_files_service(base_path: str) -> Dict[str, Any]:
    """List potential Zarr files under base_path, with each file's segmentation dataset info."""
    resolved_path = resolve_path(base_path)
    finder = RadiologyMaskFinder()
    zarr_files = finder.find_zarr_files(resolved_path)

    # Check which files actually exist and have segmentation data
    file_info = []
    for zarr_file in zarr_files:
        try:
            datasets = finder.find_datasets(zarr_file)
            file_info.append({
                'path': zarr_file,
                'exists': True,
                'segmentation_datasets_count': len(datasets),
                'datasets': datasets
            })
        except Exception as e:
            file_info.append({
                'path': zarr_file,
                'exists': False,
                'error': str(e)
            })

    return {
        'base_path': resolved_path,
        'zarr_files': file_info,
        'total_found': len(zarr_files)
    }
