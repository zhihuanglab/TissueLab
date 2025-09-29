from fastapi import APIRouter, Request, HTTPException, Query, Body
from typing import Optional, List
import traceback
from app.core.response import success_response, error_response
from app.services.seg_service import get_file_path
from app.services.h5_service import (
    get_file_structure,
    get_group_info,
    get_dataset_info,
    read_dataset_data,
    get_object_attributes,
    get_hdf5_version_info,
    # New service functions
    validate_file_path_and_security,
    list_hdf5_contents_service,
    search_hdf5_objects,
    analyze_hdf5_file_service,
    validate_hdf5_file_service,
    enhanced_file_analysis_service,
    search_segmentation_datasets_service,
    get_batch_dataset_info_service,
    export_hdf5_structure_service
)

h5_router = APIRouter()

##### Basic HDF5 File Handling Endpoints #####

@h5_router.get("/v1/info")
async def get_hdf5_file_info(request: Request):
    """Get information about the H5 file"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        from app.services.h5_service import HDF5FileHandler
        handler = HDF5FileHandler(file_path)
        info = handler.get_file_info()
        
        return success_response(info)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting file info: {str(e)}")


@h5_router.get("/v1/structure")
async def get_hdf5_structure(
    request: Request,
    path: Optional[str] = Query("/", description="Starting path in HDF5 file"),
    include_attributes: bool = Query(True, description="Include object attributes"),
    max_depth: int = Query(-1, description="Maximum depth to traverse (-1 for unlimited)")
):
    """Get the structure of the H5 file"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        structure = get_file_structure(file_path, path, include_attributes, max_depth)
        return success_response(structure)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting file structure: {str(e)}")


@h5_router.get("/v1/groups/{group_path:path}")
async def get_hdf5_group_info(
    request: Request,
    group_path: str,
    include_datasets: bool = Query(True, description="Include dataset information"),
    include_subgroups: bool = Query(True, description="Include subgroup information")
):
    """Get detailed information about an H5 group"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        # Ensure the group path starts with '/'
        if not group_path.startswith('/'):
            group_path = '/' + group_path
        
        group_info = get_group_info(file_path, group_path, include_datasets, include_subgroups)
        
        if group_info is None:
            raise HTTPException(status_code=404, detail=f"Group not found: {group_path}")
        
        return success_response(group_info)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting group info: {str(e)}")


@h5_router.get("/v1/datasets/{dataset_path:path}")
async def get_hdf5_dataset_info(
    request: Request,
    dataset_path: str,
    include_preview: bool = Query(False, description="Include data preview"),
    preview_size: int = Query(10, description="Number of elements in preview")
):
    """Get details about an H5 dataset"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        # Ensure the dataset path starts with '/'
        if not dataset_path.startswith('/'):
            dataset_path = '/' + dataset_path
        
        dataset_info = get_dataset_info(file_path, dataset_path, include_preview, preview_size)
        
        if dataset_info is None:
            raise HTTPException(status_code=404, detail=f"Dataset not found: {dataset_path}")
        
        return success_response(dataset_info)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting dataset info: {str(e)}")


@h5_router.get("/v1/datasets/{dataset_path:path}/data")
async def read_hdf5_dataset_data(
    request: Request,
    dataset_path: str,
    start_indices: Optional[str] = Query(None, description="Start indices (comma-separated)"),
    end_indices: Optional[str] = Query(None, description="End indices (comma-separated)"),
    step_indices: Optional[str] = Query(None, description="Step indices (comma-separated)"),
    flatten: bool = Query(False, description="Flatten the result array"),
    max_elements: int = Query(100000, description="Maximum number of elements to read")
):
    """Get data from an H5 dataset"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        if not dataset_path.startswith('/'):
            dataset_path = '/' + dataset_path
        
        # Parse indices
        start = None
        if start_indices:
            try:
                start = [int(x.strip()) for x in start_indices.split(',')]
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid start_indices format")
        
        end = None
        if end_indices:
            try:
                end = [int(x.strip()) for x in end_indices.split(',')]
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid end_indices format")
        
        step = None
        if step_indices:
            try:
                step = [int(x.strip()) for x in step_indices.split(',')]
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid step_indices format")
        
        data = read_dataset_data(file_path, dataset_path, start, end, step, flatten, max_elements)
        
        if data is None:
            raise HTTPException(status_code=404, detail=f"Dataset not found: {dataset_path}")
        
        return success_response(data)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error reading dataset data: {str(e)}")


@h5_router.get("/v1/objects/{object_path:path}/attributes")
async def get_hdf5_object_attributes(
    request: Request,
    object_path: str,
    attribute_name: Optional[str] = Query(None, description="Specific attribute name")
):
    """Get attributes of H5 object"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        if not object_path.startswith('/'):
            object_path = '/' + object_path
        
        attributes = get_object_attributes(file_path, object_path, attribute_name)
        
        if attributes is None:
            raise HTTPException(status_code=404, detail=f"Object not found: {object_path}")
        
        return success_response(attributes)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting object attributes: {str(e)}")


##### Utility Endpoints #####

@h5_router.get("/v1/contents")
async def list_hdf5_contents(
    request: Request,
    group_path: str = Query("/", description="Group path to list"),
    recursive: bool = Query(False, description="List contents recursively"),
    object_type: Optional[str] = Query(None, description="Filter by object type (group/dataset)")
):
    """List contents of an HDF5 file"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        result = list_hdf5_contents_service(file_path, group_path, recursive, object_type)
        return success_response(result)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error listing contents: {str(e)}")


@h5_router.get("/v1/search")
async def search_hdf5_objects_endpoint(
    request: Request,
    query: str = Query(..., description="Search query"),
    object_type: Optional[str] = Query(None, description="Filter by object type (group/dataset)"),
    search_attributes: bool = Query(False, description="Also search in attribute names"),
    case_sensitive: bool = Query(False, description="Case sensitive search")
):
    """Search h5 objects"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        result = search_hdf5_objects(file_path, query, object_type, search_attributes, case_sensitive)
        return success_response(result)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error searching objects: {str(e)}")


@h5_router.get("/v1/analyze")
async def analyze_hdf5_file(
    request: Request,
    include_statistics: bool = Query(True, description="Include data statistics"),
    sample_size: int = Query(1000, description="Sample size for analysis")
):
    """Analyze H5 file"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        analysis = analyze_hdf5_file_service(file_path, include_statistics, sample_size)
        return success_response(analysis)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error analyzing file: {str(e)}")


@h5_router.get("/v1/validate")
async def validate_hdf5_file_endpoint(request: Request):
    """Check if the file is a valid HDF5 file"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        result = validate_hdf5_file_service(file_path)
        return success_response(result)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error validating file: {str(e)}")


@h5_router.get("/v1/version")
async def get_hdf5_version():
    """Get HDF5 version information"""
    try:
        version_info = get_hdf5_version_info()
        return success_response(version_info)
    
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting version info: {str(e)}")


##### Enhanced Endpoints #####

@h5_router.get("/v1/enhanced/file_analysis")
async def enhanced_file_analysis(request: Request):
    """Enhanced file analysis, combining segmentation data and HDF5 structure analysis"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        result = enhanced_file_analysis_service(file_path)
        return success_response(result)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Enhanced analysis failed: {str(e)}")


@h5_router.get("/v1/enhanced/search_datasets")
async def search_segmentation_datasets(
    request: Request,
    query: str = Query(..., description="Search keywords"),
    include_segmentation: bool = Query(True, description="Include segmentation-related datasets")
):
    """Search for segmentation-related datasets"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        result = search_segmentation_datasets_service(file_path, query, include_segmentation)
        return success_response(result)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")


##### Batch Operations #####

@h5_router.post("/v1/batch/dataset_info")
async def get_batch_dataset_info(
    request: Request,
    dataset_paths: List[str] = Body(..., description="List of dataset paths"),
    include_preview: bool = Body(False, description="Include data preview")
):
    """Get dataset information in batch"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        result = get_batch_dataset_info_service(file_path, dataset_paths, include_preview)
        return success_response(result)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Batch operation failed: {str(e)}")


##### Export Operations #####
@h5_router.post("/v1/export/hdf5_structure")
async def export_hdf5_structure(
    request: Request,
    export_path: str = Body(..., description="Export file path"),
    format: str = Body("json", description="Export format (json/yaml)"),
    include_attributes: bool = Body(True, description="Include attribute information"),
    max_depth: int = Body(-1, description="Maximum depth")
):
    """Export HDF5 file structure"""
    try:
        file_path = get_file_path(request)
        validate_file_path_and_security(file_path)
        
        result = export_hdf5_structure_service(file_path, export_path, format, include_attributes, max_depth)
        return success_response(result)
    
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="HDF5 file not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


##### Error Handling Utilities #####

def handle_hdf5_errors(func):
    """Error handling decorator"""
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except FileNotFoundError:
            return error_response("HDF5 file not found", code=404)
        except ValueError as e:
            return error_response(f"Invalid HDF5 file or parameter: {str(e)}", code=400)
        except PermissionError:
            return error_response("No permission to access the file", code=403)
        except Exception as e:
            import traceback
            error_trace = traceback.format_exc()
            print(f"HDF5 operation error: {error_trace}")
            return error_response(
                f"HDF5 operation failed: {str(e)}", 
                code=500,
                details={"error_type": type(e).__name__}
            )
    return wrapper