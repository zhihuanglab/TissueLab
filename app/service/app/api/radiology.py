"""
Radiology mask API endpoints — thin forwarding layer.

Routing + HTTP response shaping only; all discovery/loading logic lives in
app.services.radiology.
"""

from fastapi import APIRouter, Request, Response, HTTPException, Query, Body
import zstandard as zstd
import struct
from app.core.access import authorize_read_or_response
from app.core.response import success_response
from app.services.radiology import (
    find_radiology_mask_service,
    load_radiology_mask_by_path_service,
    search_radiology_mask_datasets_service,
    auto_find_and_load_radiology_mask_service,
    list_zarr_files_service,
)

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
def find_radiology_mask(
    request: Request,
    base_path: str = Query(..., description="Base path to search for Zarr files")
):
    """Find radiology mask for a given base path"""
    try:
        authorized, denied = authorize_read_or_response(request, base_path, operation="find radiology mask")
        if denied is not None:
            return denied
        return success_response(find_radiology_mask_service(authorized))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Base path not found")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid radiology mask request")
    except Exception:
        raise HTTPException(status_code=500, detail="Error finding radiology mask")


@radiology_router.get("/v1/load_mask_data")
def load_radiology_mask_data(
    request: Request,
    zarr_file_path: str = Query(..., description="Path to Zarr file"),
):
    """Load radiology mask data from Zarr file (automatically detects and merges multiple datasets if found)"""
    try:
        authorized, denied = authorize_read_or_response(request, zarr_file_path, operation="load radiology mask")
        if denied is not None:
            return denied
        result = load_radiology_mask_by_path_service(authorized)
        if not result['success']:
            return create_error_binary_response()
        return create_success_binary_response(result)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Zarr file not found")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid radiology mask request")
    except Exception:
        raise HTTPException(status_code=500, detail="Error loading radiology mask data")


@radiology_router.get("/v1/search_datasets")
def search_radiology_mask_datasets(
    request: Request,
    zarr_file_path: str = Query(..., description="Path to Zarr file"),
    query: str = Query("", description="Search query for dataset names"),
    include_segmentation: bool = Query(True, description="Include segmentation-related datasets")
):
    """Search for radiology mask datasets in Zarr file"""
    try:
        authorized, denied = authorize_read_or_response(request, zarr_file_path, operation="search radiology mask datasets")
        if denied is not None:
            return denied
        result = search_radiology_mask_datasets_service(
            authorized, query, include_segmentation
        )
        return success_response(result)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Zarr file not found")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid radiology mask request")
    except Exception:
        raise HTTPException(status_code=500, detail="Error searching radiology mask datasets")


@radiology_router.post("/v1/auto_find_and_load")
def auto_find_and_load_radiology_mask(
    request: Request,
    base_path: str = Body(..., embed=True, description="Base path to search for Zarr files"),
):
    """Automatically find and load the best radiology mask"""
    try:
        authorized, denied = authorize_read_or_response(request, base_path, operation="auto find radiology mask")
        if denied is not None:
            return denied
        result = auto_find_and_load_radiology_mask_service(authorized)
        if result is None or not result['success']:
            return create_error_binary_response()
        return create_success_binary_response(result)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Base path not found")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid radiology mask request")
    except Exception:
        raise HTTPException(status_code=500, detail="Error in auto find and load radiology mask")


@radiology_router.get("/v1/list_zarr_files")
def list_potential_zarr_files(
    request: Request,
    base_path: str = Query(..., description="Base path to search for Zarr files")
):
    """List potential Zarr files for radiology masks"""
    try:
        authorized, denied = authorize_read_or_response(request, base_path, operation="list radiology Zarr files")
        if denied is not None:
            return denied
        return success_response(list_zarr_files_service(authorized))
    except Exception:
        raise HTTPException(status_code=500, detail="Error listing Zarr files for radiology masks")
