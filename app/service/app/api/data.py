from fastapi import APIRouter, Request, HTTPException, Query, Body
from typing import Optional, List
import traceback
from app.core.response import success_response, error_response
from app.services.seg_service import get_file_path
from app.websocket.segmentation_consumer import device_annotation_handlers
from app.utils.request import get_device_id
from app.services.data import (
    get_file_structure,
    get_group_info,
    get_array_info,
    read_array_data,
    get_object_attributes,
    get_zarr_version_info,
    delete_nuclei_annotation,
    update_nuclei_annotation_class,
    # New service functions
    validate_file_path_and_security,
    list_zarr_contents_service,
    search_zarr_objects,
    analyze_zarr_file_service,
    validate_zarr_file_service,
    enhanced_file_analysis_service,
    search_segmentation_arrays_service,
    get_batch_array_info_service,
    export_zarr_structure_service,
    ConversionOptions,
    enqueue_h5_to_zarr_job,
    get_conversion_job,
)
from app.api.schema.data import H5ToZarrConversionRequest

data_router = APIRouter()

##### Basic Zarr File Handling Endpoints #####


@data_router.post("/v1/convert")
async def convert_h5_to_zarr_endpoint(payload: H5ToZarrConversionRequest):
    """Convert an H5/HDF5 file to Zarr format."""
    try:
        options = ConversionOptions(
            source_path=payload.source_path,
            target_path=payload.target_path,
            compression=payload.compression,
            chunk_size_mb=payload.chunk_size_mb,
            workers=payload.workers,
            skip_empty=payload.skip_empty,
            skip_objects=payload.skip_objects,
            overwrite=payload.overwrite,
            test=payload.test,
            verbose=payload.verbose,
            write_stats=payload.write_stats,
        )
        job_info = await enqueue_h5_to_zarr_job(options)
        return success_response(job_info)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Conversion failed: {str(e)}")


@data_router.get("/v1/convert/{job_id}")
async def get_conversion_status(job_id: str):
    """Get status of a queued conversion job."""
    try:
        job = get_conversion_job(job_id)
        return success_response(job)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to retrieve job status: {str(e)}")

@data_router.get("/v1/info")
async def get_zarr_file_info(request: Request):
    """Get information about the Zarr file"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        from app.services.data import ZarrFileHandler
        handler = ZarrFileHandler(file_path)
        info = handler.get_file_info()
        
        return success_response(info)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Zarr file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting file info: {str(e)}")


@data_router.get("/v1/structure")
async def get_zarr_structure(
    request: Request,
    path: Optional[str] = Query("/", description="Starting path in Zarr file"),
    include_attributes: bool = Query(True, description="Include object attributes"),
    max_depth: int = Query(-1, description="Maximum depth to traverse (-1 for unlimited)")
):
    """Get Zarr file structure"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        structure = get_file_structure(file_path, path, include_attributes, max_depth)
        
        return success_response(structure)
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting structure: {str(e)}")


@data_router.get("/v1/groups/{group_path:path}")
async def get_zarr_group_info(
    request: Request,
    group_path: str,
    include_arrays: bool = Query(True, description="Include arrays in group"),
    include_subgroups: bool = Query(True, description="Include subgroups")
):
    """Get group information"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        # Ensure group path starts with /
        if not group_path.startswith('/'):
            group_path = '/' + group_path
        
        group_info = get_group_info(file_path, group_path, include_arrays, include_subgroups)
        
        if not group_info:
            raise HTTPException(status_code=404, detail="Group not found")
        
        return success_response(group_info)
    
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting group info: {str(e)}")


@data_router.get("/v1/arrays/{array_path:path}")
async def get_zarr_array_info(
    request: Request,
    array_path: str,
    include_preview: bool = Query(False, description="Include array preview"),
    preview_size: int = Query(10, description="Preview size (deprecated, use page and limit)"),
    page: int = Query(None, description="Page number (1-indexed) for pagination"),
    limit: int = Query(None, description="Number of items per page for pagination")
):
    """Get array information with optional pagination"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        # Ensure array path starts with /
        if not array_path.startswith('/'):
            array_path = '/' + array_path
        
        # Use pagination parameters if provided, otherwise fall back to preview_size
        if page is not None and limit is not None:
            # Validate pagination parameters
            if page < 1:
                raise HTTPException(status_code=400, detail="Page number must be >= 1")
            if limit < 1:
                raise HTTPException(status_code=400, detail="Limit must be >= 1")
            if limit > 10000:  # Prevent excessive data requests
                raise HTTPException(status_code=400, detail="Limit cannot exceed 10000")
            array_info = get_array_info(file_path, array_path, include_preview, preview_size=None, page=page, limit=limit)
        else:
            # Legacy mode: use preview_size
            array_info = get_array_info(file_path, array_path, include_preview, preview_size)
        
        if not array_info:
            raise HTTPException(status_code=404, detail="Array not found")

        return success_response(array_info)
    
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting array info: {str(e)}")


@data_router.delete("/v1/arrays/{array_path:path}/annotations/{cell_id:int}")
async def delete_nuclei_annotation_endpoint(
    request: Request,
    array_path: str,
    cell_id: int
):
    """Delete a single nuclei annotation by cell_id"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        # Ensure array path starts with /
        if not array_path.startswith('/'):
            array_path = '/' + array_path
        
        # Validate that this is a nuclei_annotations or tissue_annotations array
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
        
        if not (is_nuclei_annotations or is_tissue_annotations):
            raise HTTPException(status_code=400, detail="This endpoint only supports user_annotation/nuclei_annotations or user_annotation/tissue_annotations")
        
        result = delete_nuclei_annotation(file_path, array_path, cell_id)
        
        if not result.get("success", False):
            raise HTTPException(status_code=400, detail=result.get("message", "Failed to delete annotation"))
        
        return success_response(result)
    
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error deleting annotation: {str(e)}")


@data_router.put("/v1/arrays/{array_path:path}/annotations/{cell_id:int}")
async def update_nuclei_annotation_class_endpoint(
    request: Request,
    array_path: str,
    cell_id: int,
    new_class_name: str = Body(..., embed=True)
):
    """Update the cell_class for a single nuclei or tissue annotation"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        # Ensure array path starts with /
        if not array_path.startswith('/'):
            array_path = '/' + array_path
        
        # Validate that this is a nuclei_annotations or tissue_annotations array
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
        
        if not (is_nuclei_annotations or is_tissue_annotations):
            raise HTTPException(status_code=400, detail="This endpoint only supports user_annotation/nuclei_annotations or user_annotation/tissue_annotations")
        
        result = update_nuclei_annotation_class(file_path, array_path, cell_id, new_class_name)
        
        if not result.get("success", False):
            raise HTTPException(status_code=400, detail=result.get("message", "Failed to update annotation"))
        
        # Update handler's in-memory cache to ensure WebSocket returns updated colors
        try:
            device_id = get_device_id(request)
            handler = device_annotation_handlers.get(device_id)
            if handler:
                if is_nuclei_annotations:
                    # For nuclei: update class_id in handler
                    # Find the new class index from class_name
                    if hasattr(handler, 'class_name') and handler.class_name is not None:
                        class_names_list = list(handler.class_name)
                        if new_class_name in class_names_list:
                            new_class_index = class_names_list.index(new_class_name)
                            if hasattr(handler, 'class_id') and handler.class_id is not None:
                                if cell_id < len(handler.class_id):
                                    handler.class_id[cell_id] = new_class_index
                                    print(f"[update_annotation] Updated handler.class_id[{cell_id}] = {new_class_index} ({new_class_name})")
                elif is_tissue_annotations:
                    # For tissue: update tissue_annotations dict in handler
                    if hasattr(handler, 'tissue_annotations'):
                        # Update or create the annotation entry
                        handler.tissue_annotations[cell_id] = {'tissue_class': new_class_name}
                        print(f"[update_annotation] Updated handler.tissue_annotations[{cell_id}] = {new_class_name}")
                
                # Clear viewport cache to ensure fresh data is returned
                if hasattr(handler, '_viewport_cache'):
                    handler._viewport_cache.clear()
                    print(f"[update_annotation] Cleared viewport cache")
                
                # IMPORTANT: Reset _needs_reload to prevent load_file from being called
                # which would overwrite our in-memory class_id update
                if hasattr(handler, '_needs_reload'):
                    handler._needs_reload = False
                    print(f"[update_annotation] Reset _needs_reload flag")
        except Exception as cache_error:
            # Log but don't fail the request - the Zarr file was already updated
            print(f"[update_annotation] Warning: Failed to update handler cache: {cache_error}")
        
        return success_response(result)
    
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error updating annotation: {str(e)}")


@data_router.get("/v1/arrays/{array_path:path}/data")
async def read_zarr_array_data(
    request: Request,
    array_path: str,
    start_indices: Optional[str] = Query(None, description="Start indices (comma-separated)"),
    end_indices: Optional[str] = Query(None, description="End indices (comma-separated)"),
    step_indices: Optional[str] = Query(None, description="Step indices (comma-separated)"),
    flatten: bool = Query(False, description="Flatten the array"),
    max_elements: int = Query(100000, description="Maximum elements to read")
):
    """Read array data"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        # Ensure array path starts with /
        if not array_path.startswith('/'):
            array_path = '/' + array_path
        
        # Parse indices
        start = None
        end = None
        step = None
        
        if start_indices:
            start = [int(x) for x in start_indices.split(',')]
        if end_indices:
            end = [int(x) for x in end_indices.split(',')]
        if step_indices:
            step = [int(x) for x in step_indices.split(',')]
        
        data = read_array_data(file_path, array_path, start, end, step, flatten, max_elements)
        
        if not data:
            raise HTTPException(status_code=404, detail="Array not found")
        
        return success_response(data)
    
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error reading array data: {str(e)}")


@data_router.get("/v1/objects/{object_path:path}/attributes")
async def get_zarr_object_attributes(
    request: Request,
    object_path: str,
    attribute_name: Optional[str] = Query(None, description="Specific attribute name")
):
    """Get object attributes"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        # Ensure object path starts with /
        if not object_path.startswith('/'):
            object_path = '/' + object_path
        
        attributes = get_object_attributes(file_path, object_path, attribute_name)
        
        if not attributes:
            raise HTTPException(status_code=404, detail="Object not found")
        
        return success_response(attributes)
    
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting object attributes: {str(e)}")


@data_router.get("/v1/contents")
async def list_zarr_contents(
    request: Request,
    group_path: str = Query("/", description="Group path to list"),
    recursive: bool = Query(False, description="Recursive listing"),
    object_type: Optional[str] = Query(None, description="Filter by object type (group/array)")
):
    """List file contents"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        contents = list_zarr_contents_service(file_path, group_path, recursive, object_type)
        
        return success_response(contents)
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error listing contents: {str(e)}")


@data_router.get("/v1/search")
async def search_zarr_objects_endpoint(
    request: Request,
    query: str = Query(..., description="Search query"),
    object_type: Optional[str] = Query(None, description="Filter by object type (group/array)"),
    search_attributes: bool = Query(False, description="Search in attributes"),
    case_sensitive: bool = Query(False, description="Case sensitive search")
):
    """Search objects"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        results = search_zarr_objects(file_path, query, object_type, search_attributes, case_sensitive)
        
        return success_response(results)
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error searching objects: {str(e)}")


@data_router.get("/v1/analyze")
async def analyze_zarr_file(
    request: Request,
    include_statistics: bool = Query(True, description="Include data statistics"),
    sample_size: int = Query(1000, description="Sample size for analysis")
):
    """Analyze Zarr file"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        analysis = analyze_zarr_file_service(file_path, include_statistics, sample_size)
        
        return success_response(analysis)
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error analyzing file: {str(e)}")


@data_router.get("/v1/validate")
async def validate_zarr_file_endpoint(request: Request):
    """Validate Zarr file"""
    try:
        file_path = get_file_path(request)
        
        if not file_path:
            raise HTTPException(status_code=400, detail="No file path provided")
        
        validate_file_path_and_security(file_path)
        validation = validate_zarr_file_service(file_path)
        
        return success_response(validation)
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException as e:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error validating file: {str(e)}")


@data_router.get("/v1/version")
async def get_zarr_version():
    """Get Zarr version information"""
    try:
        version_info = get_zarr_version_info()
        return success_response(version_info)
    
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting version info: {str(e)}")


##### Enhanced Analysis Endpoints #####

@data_router.get("/v1/enhanced/analysis")
async def get_enhanced_file_analysis(request: Request):
    """Get enhanced file analysis combining segmentation and Zarr analysis"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        analysis = enhanced_file_analysis_service(file_path)
        
        return success_response(analysis)
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting enhanced analysis: {str(e)}")


@data_router.get("/v1/enhanced/search_arrays")
async def search_segmentation_arrays(
    request: Request,
    query: str = Query(..., description="Search query"),
    include_segmentation: bool = Query(True, description="Include segmentation-related keywords")
):
    """Search for segmentation-related arrays"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        results = search_segmentation_arrays_service(file_path, query, include_segmentation)
        
        return success_response(results)
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error searching arrays: {str(e)}")


##### Batch Operations #####

@data_router.post("/v1/batch/array_info")
async def get_batch_array_info(
    request: Request,
    array_paths: List[str] = Body(..., description="List of array paths"),
    include_preview: bool = Body(False, description="Include preview for each array")
):
    """Get array information in batch"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        results = get_batch_array_info_service(file_path, array_paths, include_preview)
        
        return success_response(results)
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting batch array info: {str(e)}")


##### Export Operations #####

@data_router.post("/v1/export/structure")
async def export_zarr_structure(
    request: Request,
    export_path: str = Body(..., description="Export file path"),
    format: str = Body("json", description="Export format (json/yaml)"),
    include_attributes: bool = Body(True, description="Include object attributes"),
    max_depth: int = Body(-1, description="Maximum depth to export (-1 for unlimited)")
):
    """Export Zarr file structure"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        result = export_zarr_structure_service(file_path, export_path, format, include_attributes, max_depth)
        
        return success_response(result)
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error exporting structure: {str(e)}")
