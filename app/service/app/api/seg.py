from fastapi import APIRouter, Query, Body, Request, HTTPException
from typing import Optional, List, Tuple
import traceback
import json

from app.core.response import success_response, error_response
from app.services.seg_service import (
    get_file_path,
    query_viewport,
    reload_segmentation_data,
    reset_segmentation_data,
    set_segmentation_types,
    update_class_color_service,
    query_patches_in_viewport,
)
from app.utils import resolve_path
from app.utils.request import get_device_id
from app.websocket.segmentation_consumer import device_annotation_handlers

# Create router
seg_router = APIRouter()


@seg_router.get("/v1/query")
async def query(
    request: Request,
    x1: float = Query(..., description="Raw BBox Top-left x"),
    y1: float = Query(..., description="Raw BBox Top-left y"),
    x2: float = Query(..., description="Raw BBox Bottom-right x"),
    y2: float = Query(..., description="Raw BBox Bottom-right y"),
    # Use alias to match potential frontend param name, receive as JSON string
    polygon_points_json: Optional[str] = Query(None, alias="polygon_points", description="JSON string of polygon vertices [[x,y],...] in raw coordinates"),
    class_name: Optional[str] = Query(None, description="Class name"),
    color: Optional[str] = Query(None, description="Color")
):
    """Query nuclei within viewport, optionally filtered by polygon"""
    try:
        # Get file path using service function
        # Make sure get_file_path correctly handles the request object or its params
        file_path = get_file_path(request)
        print(f"Debug - query endpoint - Got file path: {file_path}")

        if not file_path:
            # Use HTTPException for standard FastAPI error handling
            raise HTTPException(status_code=400, detail="No file path provided")

        # Parse polygon_points_json if provided
        polygon_points: Optional[List[Tuple[float, float]]] = None
        if polygon_points_json:
            try:
                parsed_points = json.loads(polygon_points_json)
                # Validate format: list of lists/tuples with 2 numbers
                if isinstance(parsed_points, list) and all(
                    isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(coord, (int, float)) for coord in p)
                    for p in parsed_points
                ):
                    polygon_points = [(float(p[0]), float(p[1])) for p in parsed_points]
                    print(f"Debug - query endpoint - Parsed {len(polygon_points)} polygon vertices.")
                else:
                    print(f"[WARN] Invalid format received for polygon_points: {polygon_points_json}")
                    # Optionally raise an error or proceed without polygon filtering
                    # raise HTTPException(status_code=400, detail="Invalid format for polygon_points parameter.")
            except json.JSONDecodeError:
                print(f"[WARN] Failed to decode polygon_points JSON: {polygon_points_json}")

        # Resolve device-scoped handler and call service with handler first
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            raise HTTPException(status_code=404, detail="No handler found for device")
        result = query_viewport(handler, x1, y1, x2, y2, polygon_points, class_name, color, file_path)

        return success_response(result)

    # Let the service layer raise specific exceptions like FileNotFoundError, ValueError
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        # Use 400 for bad request data/logic errors, 404 if specifically file/resource not found by ID etc.
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        # Use 500 for unexpected server errors
        raise HTTPException(status_code=500, detail=f"Error querying data: {str(e)}")

@seg_router.get("/v1/query_patches")
async def query_patches(
    request: Request,
    x1: float = Query(..., description="Raw BBox Top-left x"),
    y1: float = Query(..., description="Raw BBox Top-left y"),
    x2: float = Query(..., description="Raw BBox Bottom-right x"),
    y2: float = Query(..., description="Raw BBox Bottom-right y"),
    polygon_points_json: Optional[str] = Query(None, alias="polygon_points", description="JSON string of polygon vertices [[x,y],...] in raw coordinates"),
    # Add other potential query params for patches if needed (e.g., class_name)
):
    """Query patches overlapping the viewport, optionally filtering by polygon containment of patch centroid."""
    try:
        file_path = get_file_path(request)
        print(f"Debug - query_patches endpoint - Got file path: {file_path}")
        if not file_path:
            raise HTTPException(status_code=400, detail="No file path provided")

        polygon_points: Optional[List[Tuple[float, float]]] = None
        if polygon_points_json:
            try:
                parsed_points = json.loads(polygon_points_json)
                if isinstance(parsed_points, list) and all(
                    isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(coord, (int, float)) for coord in p)
                    for p in parsed_points
                ):
                    polygon_points = [(float(p[0]), float(p[1])) for p in parsed_points]
                    print(f"Debug - query_patches endpoint - Parsed {len(polygon_points)} polygon vertices.")
                else:
                    print(f"[WARN] Invalid format received for polygon_points: {polygon_points_json}")
            except json.JSONDecodeError:
                print(f"[WARN] Failed to decode polygon_points JSON: {polygon_points_json}")

        # Resolve device-scoped handler and call service with handler first
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            raise HTTPException(status_code=404, detail="No handler found for device")
        result = query_patches_in_viewport(handler, x1, y1, x2, y2, polygon_points, file_path)

        return success_response(result) # Contains matching_patch_indices

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error querying patch data: {str(e)}")

@seg_router.get("/v1/tissues")
async def tissues(request: Request):
    """Get tissue data"""
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        file_path = handler.get_current_file_path()
        handler.ensure_file_loaded_in_cache(file_path) # Use cached read
        tissues = handler.tissues
        tissue_annotations = handler.get_all_tissue_annotations()
        return success_response({
            "tissues": tissues,
            "tissue_annotations": tissue_annotations,
            "count": len(tissues)
        })
    except ValueError as e:
        return error_response(str(e), code=404)
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))

@seg_router.post("/v1/reload")
async def reload(
    request: Request
):
    """Reload segmentation data"""
    try:
        body_bytes = await request.body()
        body_str = body_bytes.decode()

        try:
            body = await request.json()
            path = body.get("path")
        except:
            path = body_str.strip()

        print(f"Debug - reload - Path: {path}")

        if not path:
            return error_response("No path provided", code=400)

        # Concatenate to absolute path and verify
        abs_path = resolve_path(path)
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        result = reload_segmentation_data(handler, abs_path)

        return success_response(result)

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error reloading data: {str(e)}")

@seg_router.get("/v1/output_path")
async def get_output_path(request: Request):
    """Get output path"""
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        file_path = handler.get_current_file_path()
        return success_response(file_path)
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))

@seg_router.post("/v1/reset")
async def reset(request: Request):
    """Reset all segmentation data when switching images"""
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        result = reset_segmentation_data(handler)
        return success_response(result)

    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))

@seg_router.post("/v1/set_types")
async def set_types(
    request: Request,
    tissue: Optional[str] = Body(None, description="Tissue segmentation type"),
    nuclei: Optional[str] = Body(None, description="Nuclei segmentation type"),
    patch: Optional[str] = Body(None, description="Patch segmentation type")
):
    """Set segmentation types"""
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        result = set_segmentation_types(handler, tissue, nuclei, patch)
        return success_response(result)

    except ValueError as e:
        return error_response(str(e), code=400)
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/classifications")
async def classifications(request: Request):
    """
    Get cell classification data
    
    Returns:
      {
        "nuclei_class_id": [...],
        "nuclei_class_name": [...],
        "nuclei_class_HEX_color": [...]
      }
    """
    try:
        # Use device-scoped handler and ensure file is loaded if provided
        try:
            file_path = get_file_path(request)
        except Exception:
            file_path = None

        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        if file_path:
            handler.ensure_file_loaded_in_cache(file_path)

        data = handler.get_cell_classification_data()
        return success_response(data)

    except ValueError as e:
        return error_response("No classification data in h5", code=404)
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))

@seg_router.get("/v1/total_counts")
async def total_counts(request: Request):
    """
    Get global nuclei label counts across the whole slide.

    Returns:
      {
        "total_cells": int,
        "class_counts_by_id": {"0": int, ...},
        "dynamic_class_names": [str, ...],
        "class_hex_colors": [str, ...]
      }
    """
    try:
        # Respect optional file_path param
        try:
            file_path = get_file_path(request)
        except Exception:
            file_path = None
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        if file_path:
            handler.ensure_file_loaded_in_cache(file_path)
        data = handler.get_global_nuclei_label_counts()
        return success_response(data)
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))

@seg_router.get("/v1/manual_annotation_counts")
async def manual_annotation_counts(request: Request):
    """
    Get manual annotation counts only (not including model predictions).

    Returns:
      {
        "class_counts_by_id": {"0": int, ...},
        "dynamic_class_names": [str, ...]
      }
    """
    try:
        try:
            file_path = get_file_path(request)
        except Exception:
            file_path = None
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        if file_path:
            handler.ensure_file_loaded_in_cache(file_path)

        # Get manual annotation counts from user_annotation/class_counts
        data = handler.get_all_nuclei_counts()

        # Also include reclassifications as they are manual annotations
        from app.services.active_learning_service import get_manual_counts_with_reclassifications
        data = get_manual_counts_with_reclassifications(handler, data)

        return success_response(data)
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))

@seg_router.get("/v1/annotation_colors")
async def annotation_colors(request: Request):
    """Get annotation colors"""
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        colors = handler.get_annotation_colors()
        return success_response(colors)

    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))

@seg_router.post("/v1/update-class-color")
async def update_class_color(
    request: Request,
    class_name: str = Body(..., description="The name of the class to update"),
    new_color: str = Body(..., description="The new HEX color"),
):
    """Update the color for a specific class."""
    try:
        file_path = get_file_path(await request.json())
        if not file_path:
             raise HTTPException(status_code=400, detail="File path is required.")
        
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            raise HTTPException(status_code=404, detail="No handler found for device")
        result = update_class_color_service(handler, class_name, new_color, file_path)
        return success_response(result)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error updating class color: {str(e)}")


@seg_router.post("/v1/delete-class")
async def delete_class(
    request: Request,
    class_name: str = Body(..., description="The name of the class to delete"),
    reassign_to: Optional[str] = Body("Negative control", description="Target class to reassign nuclei to"),
):
    """Delete a nuclei class from the H5 and reassign nuclei to a target class (default Negative control)."""
    try:
        params = await request.json()
        file_path = get_file_path(params)
        if not file_path:
            raise HTTPException(status_code=400, detail="File path is required.")

        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            raise HTTPException(status_code=404, detail="No handler found for device")
        handler.ensure_file_loaded_in_cache(file_path)
        result = handler.delete_class_in_h5(class_name, reassign_to or "Negative control")
        return success_response(result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error deleting class: {str(e)}")

@seg_router.get("/v1/annotations")
async def annotations(
    request: Request,
    offset: int = Query(0, description="Start index of annotations"),
    limit: Optional[int] = Query(None, description="Maximum number of annotations to return")
):
    """
    Get annotations with pagination
    """
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        file_path = handler.get_current_file_path()
        print(f"[Debug] annotations - file_path: {file_path}")
        handler.ensure_file_loaded_in_cache(file_path) # Use cached read
        annotations, total_count = handler.get_annotations(offset, limit)
        return success_response({
            "annotations": annotations,
            "count": total_count
        })
    except ValueError as e:
        return error_response(str(e), code=404)
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))

@seg_router.get("/v1/patch_classification")
async def patch_classification(request: Request):
    """Get patch classification data"""
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        class_id, class_name, class_hex_color, class_counts = handler.get_patch_classification()
        print("get patch classification data")
        print(f"class_id: {class_id}, class_name: {class_name}, class_hex_color: {class_hex_color}, class_counts: {class_counts}")
        
        # The data needs to be wrapped in a 'data' key for the frontend
        response_data = {
            "class_id": class_id,
            "class_name": class_name,
            "class_hex_color": class_hex_color,
            "class_counts": class_counts # Corrected key
        }
        return success_response(response_data)
        
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))

@seg_router.post("/v1/export/classifications")
async def export_classifications(
    request: Request,
    format_data: dict = Body({"format": "json"}, description="Export format, supports json or csv")
):
    """Export classification data and return it directly"""
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        
        # Get classification data
        classification_data = handler.get_cell_classification_data()
        if not classification_data:
            return error_response("No classification data available", code=404)
        
        format = format_data.get("format", "json")
        
        if format.lower() == "json":
            return success_response(classification_data)
        else:
            return error_response("Unsupported format. Only 'json' format is supported for complex annotation data", code=400)
            
    except Exception as e:
        traceback.print_exc()
        import traceback
        error_trace = traceback.format_exc()
        return error_response({
            "message": f"Error exporting classifications: {str(e)}",
            "details": error_trace
        }, code=500)

@seg_router.post("/v1/export/patch_classification")
async def export_patch_classification(
    request: Request,
    format_data: dict = Body({"format": "json"}, description="Export format, supports json or csv")
):
    """Export patch classification data and return it directly"""
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        
        # Get patch classification data
        class_id, class_name, class_hex_color, class_counts = handler.get_patch_classification()
        
        # Format the data
        patch_data = {
            "class_id": class_id,
            "class_name": class_name,
            "class_hex_color": class_hex_color,
            "class_counts": class_counts
        }
        
        format = format_data.get("format", "json")
        
        if format.lower() == "json":
            return success_response(patch_data)
        else:
            return error_response("Unsupported format. Only 'json' format is supported for complex annotation data", code=400)
            
    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        return error_response({
            "message": f"Error exporting patch classification: {str(e)}",
            "details": error_trace
        }, code=500)

@seg_router.get("/v1/merged_patches")
async def merged_patches(
    request: Request,
    x1: float = Query(..., description="Viewport top left x coordinate"),
    y1: float = Query(..., description="Viewport top left y coordinate"),
    x2: float = Query(..., description="Viewport bottom right x coordinate"),
    y2: float = Query(..., description="Viewport bottom right y coordinate")
):
    """get the merged patches annotations in viewport"""
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        # get and load the current file
        file_path = handler.get_current_file_path()
        if not file_path:
            return error_response("No file path available", code=404)

        print(f"[Debug] merged_patches - Loading file: {file_path}")
        handler.ensure_file_loaded_in_cache(file_path) # Use cached read

        merged_annotations = handler.merge_patches_in_viewport(x1, y1, x2, y2)
        if merged_annotations is None:
            return error_response("No patch data available", code=404)

        return success_response({
            "annotations": list(merged_annotations.values()),
            "count": len(merged_annotations)
        })
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))

@seg_router.get("/v1/merged_patches/query")
async def patches(
    request: Request,
    x1: float = Query(..., description="Viewport top left x coordinate"),
    y1: float = Query(..., description="Viewport top left y coordinate"),
    x2: float = Query(..., description="Viewport bottom right x coordinate"),
    y2: float = Query(..., description="Viewport bottom right y coordinate")
):
    """get the merged patches in viewport"""
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        file_path = handler.get_current_file_path()
        if not file_path:
            return error_response("No file path available", code=404)

        print(f"[Debug] patches - Loading file: {file_path}")
        handler.ensure_file_loaded_in_cache(file_path) # Use cached read

        merged_annotations = handler.get_merged_patches_in_viewport(x1, y1, x2, y2)
        if not merged_annotations:
            return success_response({
                "annotations": [],
                "count": 0
            })

        return success_response({
            "annotations": list(merged_annotations.values()),
            "count": len(merged_annotations)
        })
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))

@seg_router.post("/v1/merged_patches/process")
async def process_patches(request: Request):
    """process all patches and store the merged patches in cache"""
    try:
        print(f"[Debug] process_patches - Called")
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        file_path = handler.get_current_file_path()
        if not file_path:
            return error_response("No file path available", code=404)

        print(f"[Debug] process_patches - Processing file: {file_path}")
        handler.process_and_store_merged_patches()

        cache_size = len(handler._merged_patches_cache) if hasattr(handler, '_merged_patches_cache') else 0
        print(f"[Debug] process_patches - Cache size: {cache_size}")
        return success_response({
            "message": "Successfully processed and cached patches",
            "cache_size": cache_size
        })
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/patches")
async def patches(
    request: Request,
    offset: int = Query(0, description="Start index of patch annotations"),
    limit: Optional[int] = Query(
        None, description="Maximum number of patch annotations to return")):
    """
    Get patch annotations with pagination
    """
    print(f"[Debug] patches is called, offset: {offset}, limit: {limit}")
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device", code=404)
        file_path = handler.get_current_file_path()
        #print(f"[Debug] patches - file_path: {file_path}")
        handler.ensure_file_loaded_in_cache(file_path) # Use cached read
        annotations, total_count = handler.get_patches(offset, limit)
        #print(f"[Debug] patches - annotations: {annotations[0]}, total_count: {total_count}")
        return success_response({
            "annotations": annotations,
            "count": total_count
        })
    except ValueError as e:
        return error_response(str(e), code=404)
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))
 