"""
H5 repack service - Prevent H5 file bloat with copy-based repack functionality
"""

import h5py
import numpy as np
import os
import shutil
import time
from typing import Dict, Any, Optional, Tuple
import logging

logger = logging.getLogger(__name__)


class H5RepackService:
    """H5 file repack service, to prevent file bloat and fragmentation"""
    
    def __init__(self, compression: str = None, compression_opts: int = None, 
                 chunk_size: int = 1000, shuffle: bool = False):
        """
        Initialize repack service
        
        Args:
            compression: compression algorithm ('gzip', 'lzf', 'szip', None)
            compression_opts: compression level (1-9 for gzip)
            chunk_size: chunk size
            shuffle: whether to enable shuffle filter
        """
        self.compression = compression
        self.compression_opts = compression_opts
        self.chunk_size = chunk_size
        self.shuffle = shuffle
    
    def repack_file(self, input_path: str, output_path: Optional[str] = None, 
                   preserve_metadata: bool = True, optimize_datasets: bool = True) -> Dict[str, Any]:
        """
        Repack H5 file, eliminate fragmentation and optimize storage
        
        Args:
            input_path: input H5 file path
            output_path: output H5 file path, if None then overwrite original file
            preserve_metadata: whether to preserve metadata
            optimize_datasets: whether to optimize dataset storage parameters
            
        Returns:
            dictionary containing repack results
        """
        start_time = time.time()
        original_size = os.path.getsize(input_path)
        
        # if no output path specified, use temporary file
        if output_path is None:
            output_path = input_path
        
        temp_path = None
        try:
            # create temporary file
            temp_dir = os.path.dirname(input_path)
            temp_path = os.path.join(temp_dir, f"repack_temp_{int(time.time())}_{os.getpid()}.h5")
            
            logger.info(f"[H5Repack] Starting repack of {input_path}")
            logger.info(f"[H5Repack] Original file size: {original_size / (1024*1024):.2f} MB")
            
            # execute repack
            self._copy_and_optimize(input_path, temp_path, preserve_metadata, optimize_datasets)
            
            # validate repacked file
            if not self._validate_repacked_file(temp_path, input_path):
                raise RuntimeError("Repacked file validation failed")
            
            # replace original file
            if output_path == input_path:
                # backup original file
                backup_path = f"{input_path}.backup_{int(time.time())}"
                shutil.move(input_path, backup_path)
                logger.info(f"[H5Repack] Original file backed up to: {backup_path}")
                
                # move repacked file
                shutil.move(temp_path, input_path)
                temp_path = None  # prevent deletion
                
                # delete backup file
                try:
                    os.remove(backup_path)
                except Exception as e:
                    logger.warning(f"[H5Repack] Failed to remove backup file: {e}")
            else:
                shutil.move(temp_path, output_path)
                temp_path = None
            
            new_size = os.path.getsize(output_path)
            size_reduction = original_size - new_size
            reduction_percent = (size_reduction / original_size) * 100 if original_size > 0 else 0
            
            result = {
                "success": True,
                "input_path": input_path,
                "output_path": output_path,
                "original_size": original_size,
                "new_size": new_size,
                "size_reduction": size_reduction,
                "reduction_percent": reduction_percent,
                "processing_time": time.time() - start_time
            }
            
            logger.info(f"[H5Repack] Repack completed successfully")
            logger.info(f"[H5Repack] New file size: {new_size / (1024*1024):.2f} MB")
            logger.info(f"[H5Repack] Size reduction: {size_reduction / (1024*1024):.2f} MB ({reduction_percent:.2f}%)")
            
            return result
            
        except Exception as e:
            logger.error(f"[H5Repack] Repack failed: {e}", exc_info=True)
            return {
                "success": False,
                "error": str(e),
                "input_path": input_path,
                "output_path": output_path,
                "processing_time": time.time() - start_time
            }
        finally:
            # clean up temporary file
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception as e:
                    logger.warning(f"[H5Repack] Failed to remove temp file: {e}")
    
    def _copy_and_optimize(self, input_path: str, output_path: str, 
                          preserve_metadata: bool, optimize_datasets: bool):
        """copy and optimize H5 file"""
        
        with h5py.File(input_path, 'r') as src_file:
            with h5py.File(output_path, 'w', libver='latest') as dst_file:
                # copy file-level attributes
                if preserve_metadata:
                    self._copy_attributes(src_file, dst_file)
                
                # recursively copy all groups and datasets
                self._copy_group(src_file, dst_file, optimize_datasets)
    
    def _copy_group(self, src_group: h5py.Group, dst_group: h5py.Group, optimize_datasets: bool):
        """recursively copy groups and datasets"""
        
        for name in src_group.keys():
            src_obj = src_group[name]
            
            if isinstance(src_obj, h5py.Group):
                # create target group
                dst_obj = dst_group.create_group(name)
                
                # copy group attributes
                self._copy_attributes(src_obj, dst_obj)
                
                # recursively copy subgroups
                self._copy_group(src_obj, dst_obj, optimize_datasets)
                
            elif isinstance(src_obj, h5py.Dataset):
                # copy dataset
                self._copy_dataset(src_obj, dst_group, name, optimize_datasets)
    
    def _copy_dataset(self, src_dataset: h5py.Dataset, dst_group: h5py.Group, 
                     name: str, optimize_datasets: bool):
        """copy and optimize dataset"""
        
        try:
            # read source data
            data = src_dataset[...]
            
            # determine compression and chunk parameters
            compression, compression_opts, chunks = self._get_optimized_params(
                src_dataset, data, optimize_datasets
            )
            
            # for scalar dataset, use simple copy
            if data.shape == ():
                dst_dataset = dst_group.create_dataset(name, data=data)
            else:
                # create target dataset
                dst_dataset = dst_group.create_dataset(
                    name,
                    data=data,
                    compression=compression,
                    compression_opts=compression_opts,
                    chunks=chunks,
                    shuffle=self.shuffle
                )
            
            # copy dataset attributes
            self._copy_attributes(src_dataset, dst_dataset)
            
            logger.debug(f"[H5Repack] Copied dataset: {name} (shape: {data.shape}, dtype: {data.dtype})")
            
        except Exception as e:
            logger.error(f"[H5Repack] Failed to copy dataset {name}: {e}")
            # if copy fails, try direct copy
            try:
                dst_group.create_dataset(name, data=src_dataset[...])
                self._copy_attributes(src_dataset, dst_group[name])
            except Exception as e2:
                logger.error(f"[H5Repack] Failed to copy dataset {name} with fallback method: {e2}")
                raise
    
    def _get_optimized_params(self, src_dataset: h5py.Dataset, data: np.ndarray, 
                            optimize_datasets: bool) -> Tuple[Optional[str], Optional[int], Optional[Tuple]]:
        """get optimized storage parameters"""
        
        if not optimize_datasets:
            return None, None, None
        
        # for scalar dataset, do not apply compression and chunk
        if data.shape == ():
            return None, None, None
        
        # determine compression parameters based on data type and size
        compression = None
        compression_opts = None
        chunks = None
        
        # for string data, use gzip compression
        if data.dtype.kind in ['S', 'U', 'O']:
            compression = 'gzip'
            compression_opts = self.compression_opts
            # string data usually does not need chunking
            if data.size > self.chunk_size:
                chunks = (min(self.chunk_size, data.shape[0]),) + data.shape[1:]
        
        # for numeric data
        elif data.dtype.kind in ['f', 'i', 'u']:
            # determine whether to compress based on data size
            if data.nbytes > 1024 * 1024:  # greater than 1MB
                compression = self.compression
                compression_opts = self.compression_opts
                
                # set appropriate chunk size
                if len(data.shape) == 1:
                    chunks = (min(self.chunk_size, data.shape[0]),)
                elif len(data.shape) == 2:
                    chunks = (min(self.chunk_size, data.shape[0]), data.shape[1])
                else:
                    # multi-dimensional data, only chunk first dimension
                    first_dim = min(self.chunk_size, data.shape[0])
                    chunks = (first_dim,) + data.shape[1:]
        
        return compression, compression_opts, chunks
    
    def _copy_attributes(self, src_obj, dst_obj):
        """copy H5 object attributes"""
        try:
            for attr_name in src_obj.attrs.keys():
                attr_value = src_obj.attrs[attr_name]
                dst_obj.attrs[attr_name] = attr_value
        except Exception as e:
            logger.warning(f"[H5Repack] Failed to copy some attributes: {e}")
    
    def _validate_repacked_file(self, repacked_path: str, original_path: str) -> bool:
        """validate repacked file"""
        try:
            with h5py.File(repacked_path, 'r') as repacked_file:
                with h5py.File(original_path, 'r') as original_file:
                    # compare basic structure
                    if not self._compare_structure(original_file, repacked_file):
                        return False
                    
                    # compare key datasets
                    if not self._compare_key_datasets(original_file, repacked_file):
                        return False
            
            return True
            
        except Exception as e:
            logger.error(f"[H5Repack] Validation failed: {e}")
            return False
    
    def _compare_structure(self, file1: h5py.File, file2: h5py.File) -> bool:
        """compare two H5 files structure"""
        try:
            def get_structure(file_obj):
                structure = {}
                def visitor(name, obj):
                    structure[name] = {
                        'type': 'group' if isinstance(obj, h5py.Group) else 'dataset',
                        'shape': obj.shape if hasattr(obj, 'shape') else None,
                        'dtype': str(obj.dtype) if hasattr(obj, 'dtype') else None
                    }
                file_obj.visititems(visitor)
                return structure
            
            struct1 = get_structure(file1)
            struct2 = get_structure(file2)
            
            return struct1 == struct2
            
        except Exception as e:
            logger.error(f"[H5Repack] Structure comparison failed: {e}")
            return False
    
    def _compare_key_datasets(self, file1: h5py.File, file2: h5py.File) -> bool:
        """compare key datasets content"""
        try:
            # check key paths
            key_paths = [
                'SegmentationNode/centroids',
                'user_annotation/nuclei_annotations',
                'user_annotation/class_counts'
            ]
            
            for path in key_paths:
                if path in file1 and path in file2:
                    data1 = file1[path][...]
                    data2 = file2[path][...]
                    
                    if not np.array_equal(data1, data2):
                        logger.error(f"[H5Repack] Dataset {path} content mismatch")
                        return False
            
            return True
            
        except Exception as e:
            logger.error(f"[H5Repack] Key datasets comparison failed: {e}")
            return False


def repack_h5_file(input_path: str, output_path: Optional[str] = None, 
                  compression: str = None, compression_opts: int = None,
                  chunk_size: int = 1000, shuffle: bool = False,
                  preserve_metadata: bool = True, optimize_datasets: bool = False) -> Dict[str, Any]:
    """
    convenient function: repack H5 file
    
    Args:
        input_path: input H5 file path
        output_path: output H5 file path, if None then overwrite original file
        compression: compression algorithm
        compression_opts: compression level
        chunk_size: chunk size
        shuffle: whether to enable shuffle filter
        preserve_metadata: whether to preserve metadata
        optimize_datasets: whether to optimize dataset storage parameters
        
    Returns:
        dictionary containing repack results
    """
    service = H5RepackService(
        compression=compression,
        compression_opts=compression_opts,
        chunk_size=chunk_size,
        shuffle=shuffle
    )
    
    return service.repack_file(
        input_path=input_path,
        output_path=output_path,
        preserve_metadata=preserve_metadata,
        optimize_datasets=optimize_datasets
    )


def should_repack_file(file_path: str, size_threshold_mb: float = 100.0, 
                      fragmentation_threshold: float = 0.1) -> Dict[str, Any]:
    """
    check if file needs repack
    
    Args:
        file_path: H5 file path
        size_threshold_mb: file size threshold(MB)
        fragmentation_threshold: fragmentation threshold
        
    Returns:
        dictionary containing check results
    """
    try:
        file_size = os.path.getsize(file_path)
        file_size_mb = file_size / (1024 * 1024)
        
        # check file size
        needs_repack_by_size = file_size_mb > size_threshold_mb
        
        # check fragmentation degree (simple heuristic method)
        fragmentation_ratio = 0.0
        try:
            with h5py.File(file_path, 'r') as f:
                total_datasets = 0
                fragmented_datasets = 0
                
                def check_fragmentation(name, obj):
                    nonlocal total_datasets, fragmented_datasets
                    if isinstance(obj, h5py.Dataset):
                        total_datasets += 1
                        # simple check: if dataset is compressed but file is still large, it may be fragmented
                        if obj.compression and obj.nbytes > 1024 * 1024:
                            fragmented_datasets += 1
                
                f.visititems(check_fragmentation)
                
                if total_datasets > 0:
                    fragmentation_ratio = fragmented_datasets / total_datasets
        
        except Exception as e:
            logger.warning(f"[H5Repack] Failed to check fragmentation: {e}")
        
        needs_repack_by_fragmentation = fragmentation_ratio > fragmentation_threshold
        
        return {
            "file_path": file_path,
            "file_size_mb": file_size_mb,
            "needs_repack_by_size": needs_repack_by_size,
            "needs_repack_by_fragmentation": needs_repack_by_fragmentation,
            "fragmentation_ratio": fragmentation_ratio,
            "should_repack": needs_repack_by_size or needs_repack_by_fragmentation,
            "recommendation": "Repack recommended" if (needs_repack_by_size or needs_repack_by_fragmentation) else "No repack needed"
        }
        
    except Exception as e:
        return {
            "file_path": file_path,
            "error": str(e),
            "should_repack": False,
            "recommendation": "Cannot determine - file access error"
        }


def auto_repack_if_needed(file_path: str, **kwargs) -> Dict[str, Any]:
    """
    automatically check if file needs repack, if needed then execute repack
    
    Args:
        file_path: H5 file path
        **kwargs: parameters passed to repack function
        
    Returns:
        dictionary containing operation results
    """
    try:
        # check if file needs repack
        check_result = should_repack_file(file_path)
        
        if not check_result.get("should_repack", False):
            return {
                "action": "skipped",
                "reason": "File does not need repacking",
                "check_result": check_result
            }
        
        # execute repack
        repack_result = repack_h5_file(file_path, **kwargs)
        
        return {
            "action": "repacked",
            "check_result": check_result,
            "repack_result": repack_result
        }
        
    except Exception as e:
        return {
            "action": "error",
            "error": str(e),
            "file_path": file_path
        }
