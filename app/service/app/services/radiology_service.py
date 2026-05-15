"""
Radiology mask discovery and loading service
Provides intelligent search for segmentation masks in Zarr files for NII volumes
"""

import zarr
import numpy as np
from typing import Optional, List, Dict, Any
from pathlib import Path


class RadiologyMaskFinder:
    """Service for finding and loading segmentation masks from Zarr files for NII volumes"""
    
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
        """Find all datasets under any prefix/voxel_mask in Zarr file"""
        datasets = []
        
        try:
            with zarr.open(zarr_file_path, 'r') as f:
                
                # Search for any group that has voxel_mask as a subdirectory (recursively)
                def find_voxel_mask_groups(name, obj):
                    if isinstance(obj, zarr.Group):
                        # Check if this group has a voxel_mask subdirectory
                        if 'voxel_mask' in obj:
                            voxel_mask_group = obj['voxel_mask']
                            
                            def visit_func(dataset_name, dataset_obj):
                                if isinstance(dataset_obj, zarr.Array):
                                    # Create full path for the dataset
                                    full_path = f"{name}/voxel_mask/{dataset_name}"
                                    datasets.append({
                                        'path': full_path,
                                        'name': Path(dataset_name).name,
                                        'shape': dataset_obj.shape,
                                        'dtype': str(dataset_obj.dtype),
                                        'size': dataset_obj.size,
                                        'nbytes': dataset_obj.nbytes,
                                        'prefix': name.split('/')[-1] if '/' in name else name
                                    })
                            
                            voxel_mask_group.visititems(visit_func)
                        else:
                            # Recursively search in subdirectories
                            for key in obj.keys():
                                child = obj[key]
                                if isinstance(child, zarr.Group):
                                    # Recursively search in this subdirectory
                                    find_voxel_mask_groups(f"{name}/{key}" if name != '/' else f"/{key}", child)
                
                # Start the search from the root
                find_voxel_mask_groups('/', f)
                
                
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
            
            with zarr.open(zarr_file_path, 'r') as f:
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
            with zarr.open(zarr_file_path, 'r') as f:
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
                        'dataset_name': Path(dataset_path).name,
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
            'message': 'No radiology mask found in any prefix/voxel_mask'
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
    """Search for radiology mask datasets in Zarr file under any prefix/voxel_mask"""
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
