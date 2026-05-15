"""
Radiology mask API endpoints
Provides endpoints for finding and loading segmentation masks from Zarr files for NII volumes
"""

from fastapi import APIRouter, Request, Response, HTTPException, Query, Body
import zstandard as zstd
import struct
from app.core.response import success_response
from app.services.radiology_service import (
    find_radiology_mask_service,
    load_radiology_mask_data_service,
    search_radiology_mask_datasets_service,
    RadiologyMaskFinder
)
from app.utils import resolve_path

radiology_router = APIRouter()


def create_error_binary_response():
    """Create a structured binary response for error cases"""
    metadata = struct.pack('<IIIIIIII',
        0,  # success = False
        0,  # found = False
        0,  # shape[0] = 0
        0,  # shape[1] = 0
        0,  # shape[2] = 0
        0,  # is_subset = False
        0,  # original_size = 0
        0   # dtype_length = 0
    )
    return Response(content=metadata, media_type='application/octet-stream')


def create_success_binary_response(result: dict):
    """Create a structured binary response for success cases with zstd compression"""
    # Create metadata header (fixed size: 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 = 32 bytes)
    # Format: success(4) + found(4) + shape[0](4) + shape[1](4) + shape[2](4) + is_subset(4) + original_size(4) + dtype_len(4)
    # Use little-endian format for consistency with JavaScript
    metadata = struct.pack('<IIIIIIII',
        1 if result['success'] else 0,  # success (4 bytes)
        1,                              # found (4 bytes) - always true if we reach here
        result['shape'][0],             # shape[0] (4 bytes)
        result['shape'][1],             # shape[1] (4 bytes)
        result['shape'][2],             # shape[2] (4 bytes)
        0,                              # is_subset (4 bytes) always 0 now
        result['original_size'],        # original_size (4 bytes)
        len(result['dtype'])            # dtype length (4 bytes)
    )
    
    # Add dtype string
    dtype_bytes = result['dtype'].encode('utf-8')
    
    # Combine metadata + dtype + data
    response_data = metadata + dtype_bytes + result['data']
    
    # Compress with zstd
    cctx = zstd.ZstdCompressor(level=1)
    compressed_data = cctx.compress(response_data)
    
    return Response(
        content=compressed_data,
        media_type='application/octet-stream',
        headers={
            'Content-Encoding': 'zstd',
            'Content-Length': str(len(compressed_data))
        }
    )


@radiology_router.get("/v1/find_mask")
async def find_radiology_mask(
    request: Request,
    base_path: str = Query(..., description="Base path to search for Zarr files")
):
    """Find radiology mask for a given base path"""
    try:
        # Resolve the base path
        resolved_path = resolve_path(base_path)
        
        result = find_radiology_mask_service(resolved_path)
        return success_response(result)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Base path not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error finding radiology mask: {str(e)}")


@radiology_router.get("/v1/load_mask_data")
async def load_radiology_mask_data(
    request: Request,
    zarr_file_path: str = Query(..., description="Path to Zarr file"),
):
    """Load radiology mask data from Zarr file (automatically detects and merges multiple datasets if found)"""
    try:
        # Resolve the Zarr file path
        resolved_path = resolve_path(zarr_file_path)
        
        # Check if the path is already an Zarr file
        if resolved_path.endswith('.zarr'):
            # Direct Zarr file path - find datasets in this file
            finder = RadiologyMaskFinder()
            datasets = finder.find_datasets(resolved_path)
            if not datasets:
                raise HTTPException(status_code=404, detail="No datasets found")
            
            # Create mask_info for direct Zarr file
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
            finder = RadiologyMaskFinder()
            mask_info = finder.find_radiology_mask(resolved_path)
            if not mask_info:
                raise HTTPException(status_code=404, detail="No datasets found")
        
        result = load_radiology_mask_data_service(mask_info['zarr_file'], mask_info)
        
        if not result['success']:
            return create_error_binary_response()
        
        
        return create_success_binary_response(result)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Zarr file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error loading radiology mask data: {str(e)}")


@radiology_router.get("/v1/search_datasets")
async def search_radiology_mask_datasets(
    request: Request,
    zarr_file_path: str = Query(..., description="Path to Zarr file"),
    query: str = Query("", description="Search query for dataset names"),
    include_segmentation: bool = Query(True, description="Include segmentation-related datasets")
):
    """Search for radiology mask datasets in Zarr file"""
    try:
        # Resolve the Zarr file path
        resolved_path = resolve_path(zarr_file_path)
        
        result = search_radiology_mask_datasets_service(resolved_path, query, include_segmentation)
        return success_response(result)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Zarr file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error searching radiology mask datasets: {str(e)}")


@radiology_router.post("/v1/auto_find_and_load")
async def auto_find_and_load_radiology_mask(
    request: Request,
    base_path: str = Body(..., embed=True, description="Base path to search for Zarr files"),
):
    """Automatically find and load the best radiology mask"""
    try:
        # Resolve the base path
        resolved_path = resolve_path(base_path)
        
        # First, find the radiology mask
        find_result = find_radiology_mask_service(resolved_path)
        
        if not find_result['found']:
            return create_error_binary_response()
        
        # Load the data for the selected dataset
        load_result = load_radiology_mask_data_service(
            find_result['zarr_file'],
            find_result['dataset_path']
        )
        
        if not load_result['success']:
            return create_error_binary_response()
        
        return create_success_binary_response(load_result)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Base path not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error in auto find and load radiology mask: {str(e)}")


@radiology_router.get("/v1/list_zarr_files")
async def list_potential_zarr_files(
    request: Request,
    base_path: str = Query(..., description="Base path to search for Zarr files")
):
    """List potential Zarr files for radiology masks"""
    try:
        from app.services.radiology_service import RadiologyMaskFinder
        
        # Resolve the base path
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
        
        return success_response({
            'base_path': resolved_path,
            'zarr_files': file_info,
            'total_found': len(zarr_files)
        })
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error listing Zarr files for radiology masks: {str(e)}")
