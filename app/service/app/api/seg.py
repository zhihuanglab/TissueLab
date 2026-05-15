from fastapi import APIRouter, Query, Body, Request, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from typing import Optional, List, Tuple
import traceback
import json
import logging
import asyncio
import os
import base64
import shutil

import requests
from concurrent.futures import ThreadPoolExecutor

from app.core.response import success_response, error_response

logger = logging.getLogger(__name__)

# Create a dedicated thread pool executor for mask processing
# This prevents mask processing from blocking other API requests
_MASK_EXECUTOR = ThreadPoolExecutor(
    max_workers=max(4, min(16, os.cpu_count() or 4)),
    thread_name_prefix="MaskWorker"
)
from app.services.seg_service import (
    get_file_path,
    get_user_annotation_indices,
    query_viewport,
    reload_segmentation_data,
    reset_segmentation_data,
    set_segmentation_types,
    update_class_color_service,
    update_patch_class_color_service,
    query_patches_in_viewport,
    get_segmentation_mask,
    list_mask_options,
    SegmentationHandler,
)
from app.utils import resolve_path
from app.utils.request import get_device_id
from app.websocket.segmentation_consumer import device_annotation_handlers
from app.config.path_config import is_public_read_only_path

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
            # Auto-create handler if not exists (e.g., after backend restart)
            print(f"[query] No handler found for device {device_id}, creating one for file: {file_path}")
            handler = SegmentationHandler()
            handler.load_file(file_path)
            device_annotation_handlers[device_id] = handler
            print(f"[query] Handler created and cached for device {device_id}")
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


@seg_router.get("/v1/user_annotation_indices")
async def user_annotation_indices(request: Request):
    """Return indices of user-annotated (ground truth) nuclei and tissue for the current image.
    Used when preference 'highlight user annotations (GT)' is on to always highlight these indices.
    Query params: relative_path or file_path (same as other seg APIs).
    """
    try:
        file_path = get_file_path(request)
        if not file_path:
            raise HTTPException(status_code=400, detail="No file path provided")
        result = get_user_annotation_indices(file_path)
        return success_response(result)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


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
        # Only load if handler doesn't have data
        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)
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
        
        # Only load file if handler doesn't have data or file path changed
        if file_path:
            current_path = getattr(handler, 'zarr_file', None)
            if current_path != file_path or handler.centroids is None:
                handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)

        data = handler.get_cell_classification_data()
        
        return success_response(data)

    except ValueError as e:
        return error_response("No classification data in zarr", code=404)
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
        # Only load file if file path changed (centroids check is done inside get_global_nuclei_label_counts if needed)
        if file_path:
            current_path = getattr(handler, 'zarr_file', None)
            if current_path != file_path:
                handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)
        data = handler.get_global_nuclei_label_counts()
        return success_response(data)
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/region_probability_histogram")
async def region_probability_histogram(
    request: Request,
    start_x: float = Query(..., description="BBox left (RAW scale)"),
    start_y: float = Query(..., description="BBox top (RAW scale)"),
    end_x: float = Query(..., description="BBox right (RAW scale)"),
    end_y: float = Query(..., description="BBox bottom (RAW scale)"),
    class_id: int = Query(..., description="Class index (-1 = all classes, use max prob per cell)"),
):
    """
    Get probability distribution for cells in bbox. class_id >= 0: only cells predicted as that class; class_id == -1: all cells, prob = max over classes.
    BBox in real pixel coordinates (level0).
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
            current_path = getattr(handler, 'zarr_file', None)
            if current_path != file_path:
                handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)
        data = handler.get_region_probability_histogram(start_x, start_y, end_x, end_y, class_id)
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
        # Only load file if file path changed (centroids not needed for class_counts)
        if file_path:
            current_path = getattr(handler, 'zarr_file', None)
            if current_path != file_path:
                handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)

        # MULTI-USER: Extract instance_id from header for AL reclassifications (REQUIRED)
        instance_id = request.headers.get("X-Instance-ID")
        if not instance_id:
            return error_response("X-Instance-ID header is required for multi-user isolation", code=400)
        
        # Get manual annotation counts from user_annotation/class_counts
        # get_all_nuclei_counts() includes AL reclassifications per instance
        data = handler.get_all_nuclei_counts(instance_id=instance_id)

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
    """Update the color for a specific class in ClassificationNode."""
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


@seg_router.post("/v1/update-patch-class-color")
async def update_patch_class_color(
    request: Request,
    class_name: str = Body(..., description="The name of the patch class to update"),
    new_color: str = Body(..., description="The new HEX color"),
):
    """Update the color for a specific patch classification class in MuskNode."""
    try:
        request_data = await request.json()
        file_path = get_file_path(request_data)
        logger.info(f"[API] update-patch-class-color called: class_name='{class_name}', new_color='{new_color}', file_path='{file_path}'")
        
        if not file_path:
             raise HTTPException(status_code=400, detail="File path is required.")
        
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            raise HTTPException(status_code=404, detail="No handler found for device")
        result = update_patch_class_color_service(handler, class_name, new_color, file_path)
        logger.info(f"[API] update-patch-class-color success: {result}")
        return success_response(result)
    except FileNotFoundError as e:
        logger.error(f"[API] update-patch-class-color FileNotFoundError: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        logger.error(f"[API] update-patch-class-color ValueError: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[API] update-patch-class-color Exception: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error updating patch class color: {str(e)}")


@seg_router.post("/v1/delete-class")
async def delete_class(
    request: Request,
    class_name: str = Body(..., description="The name of the class to delete"),
    reassign_to: Optional[str] = Body("Negative control", description="Target class to reassign nuclei to"),
):
    """Delete a nuclei class from the Zarr and reassign nuclei to a target class (default Negative control)."""
    try:
        params = await request.json()
        file_path = get_file_path(params)
        if not file_path:
            raise HTTPException(status_code=400, detail="File path is required.")

        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            raise HTTPException(status_code=404, detail="No handler found for device")
        # Only load file if handler doesn't have data or file path changed
        current_path = getattr(handler, 'zarr_file', None)
        if current_path != file_path or handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)
        result = handler.delete_class_in_zarr(class_name, reassign_to or "Negative control")
        # After deletion, clear handler's cached class data to force reload from zarr file
        # This ensures get_cell_classification_data() will read the updated colormap
        handler.class_name = None
        handler.class_hex_color = None
        handler.invalidate_user_counts_cache()
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
        # Only load if handler doesn't have data
        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)
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

@seg_router.get("/v1/annotations/export/csv")
async def export_annotations_csv(request: Request):
    """
    Export all cell annotations as CSV in streaming fashion.
    Optimized for large datasets (300k+ cells) by streaming data in batches.

    Returns:
        StreamingResponse: CSV file with columns: ID, Centroid_X, Centroid_Y, MinX, MinY, MaxX, MaxY, Contours
    """
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            raise HTTPException(status_code=404, detail="No handler found for device")

        file_path = handler.get_current_file_path()
        logger.info(f"[API] export_annotations_csv - file_path: {file_path}")

        # Only load if handler doesn't have data
        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)

        # Check if we have data to export
        if handler.centroids is None or len(handler.centroids) == 0:
            raise HTTPException(status_code=404, detail="No annotation data available")

        total_cells = len(handler.centroids)
        logger.info(f"[API] Starting CSV export for {total_cells} cells")

        # Use the streaming generator from handler
        csv_generator = handler.generate_annotations_csv_stream(batch_size=5000)

        # Generate unique filename with timestamp to avoid browser caching issues
        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"Cell_Classification_Overview_{timestamp}.csv"

        return StreamingResponse(
            csv_generator,
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename={filename}",
                "Cache-Control": "no-cache",
                "X-Total-Cells": str(total_cells)  # Add total count to header for verification
            }
        )

    except HTTPException:
        raise
    except ValueError as e:
        logger.error(f"[API] export_annotations_csv ValueError: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"[API] export_annotations_csv Exception: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error exporting CSV: {str(e)}")


@seg_router.get("/v1/annotations/export/geojson")
async def export_annotations_geojson(
    request: Request,
    batch_size: int = Query(
        31523,
        ge=1000,
        le=50000,
        description="GeoJSON streaming batch size (cells per chunk)",
    ),
):
    """
    Export all cell segmentation/classification annotations as GeoJSON.

    Returns:
        StreamingResponse: GeoJSON FeatureCollection (QuPath-compatible properties)
    """
    try:
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            raise HTTPException(status_code=404, detail="No handler found for device")

        file_path = handler.get_current_file_path()
        logger.info(f"[API] export_annotations_geojson - file_path: {file_path}")

        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)

        if handler.centroids is None or len(handler.centroids) == 0:
            raise HTTPException(status_code=404, detail="No annotation data available")

        total_cells = len(handler.centroids)
        logger.info(f"[API] Starting GeoJSON export for {total_cells} cells")

        geojson_generator = handler.generate_annotations_geojson_stream(
            batch_size=batch_size,
        )

        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"Cell_Segmentation_Classification_{timestamp}.geojson"

        return StreamingResponse(
            geojson_generator,
            media_type="application/geo+json",
            headers={
                "Content-Disposition": f"attachment; filename={filename}",
                "Cache-Control": "no-cache",
                "X-Total-Cells": str(total_cells),
            },
        )

    except HTTPException:
        raise
    except ValueError as e:
        logger.error(f"[API] export_annotations_geojson ValueError: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"[API] export_annotations_geojson Exception: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error exporting GeoJSON: {str(e)}")

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

        # Only load if handler doesn't have data
        if handler.centroids is None:
            print(f"[Debug] merged_patches - Loading file: {file_path}")
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)

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

        # Only load if handler doesn't have data
        if handler.centroids is None:
            print(f"[Debug] patches - Loading file: {file_path}")
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)

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
        # Only load if handler doesn't have data
        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)
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

@seg_router.get("/v1/mask_options")
async def get_mask_options(request: Request):
    """List available mask datasets for overlay (e.g. Segmentation/mask_tissuename or default)."""
    try:
        file_path = get_file_path(request)
        if not file_path:
            raise HTTPException(status_code=400, detail="No file path provided")
        out = list_mask_options(file_path)
        if not out.get("success"):
            raise HTTPException(status_code=404, detail=out.get("error", "Failed to list mask options"))
        return success_response({"options": out.get("options", [])})

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@seg_router.get("/v1/mask")
async def get_mask(
    request: Request,
    x1: float = Query(..., description="Raw BBox Top-left x"),
    y1: float = Query(..., description="Raw BBox Top-left y"),
    x2: float = Query(..., description="Raw BBox Bottom-right x"),
    y2: float = Query(..., description="Raw BBox Bottom-right y"),
    target_width: Optional[int] = Query(None, description="Target width for downsampling"),
    target_height: Optional[int] = Query(None, description="Target height for downsampling"),
    mask_key: Optional[str] = Query(None, description="Which mask to load, e.g. mask_Stroma (from Segmentation/mask_xxx)")
):
    """Get binary mask for the given viewport. If mask_key is set, read from Segmentation/mask_key."""
    try:
        file_path = get_file_path(request)
        if not file_path:
            raise HTTPException(status_code=400, detail="No file path provided")
        
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            raise HTTPException(status_code=404, detail="No handler found for device")
        
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            _MASK_EXECUTOR,
            get_segmentation_mask,
            handler, x1, y1, x2, y2, file_path, target_width, target_height, mask_key
        )
        
        if not result.get("success"):
            raise HTTPException(status_code=404, detail=result.get("error", "Failed to load mask"))
        
        # Return binary response similar to radiology mask endpoint
        from fastapi.responses import Response
        import struct
        
        # Create binary response with metadata header
        data_bytes = result["data"]
        shape = result["shape"]
        offset = result.get("offset", [0, 0])
        full_shape = result.get("full_shape", shape)
        tissue_class = result.get("tissue_class")
        
        # Encode tissue_class if present
        tissue_class_bytes = b""
        if tissue_class:
            tissue_class_bytes = tissue_class.encode('utf-8')
        
        # Header: success(4) + shape0(4) + shape1(4) + offset_x(4) + offset_y(4) + full_shape0(4) + full_shape1(4) + data_len(4) + tissue_class_len(4) = 36 bytes
        header = struct.pack('<IIIIIIIII',
            1,  # success
            shape[0],  # height
            shape[1],  # width
            offset[0],  # offset_x
            offset[1],  # offset_y
            full_shape[0],  # full_height
            full_shape[1],  # full_width
            len(data_bytes),  # data length
            len(tissue_class_bytes)  # tissue_class length
        )
        
        response_content = header + data_bytes + tissue_class_bytes
        
        # Get region_size from result if available (actual region size before downsampling)
        region_size = result.get("region_size", None)
        
        response_headers = {
            "X-Mask-Shape": f"{shape[0]},{shape[1]}",
            "X-Mask-Offset": f"{offset[0]},{offset[1]}",
            "X-Mask-Full-Shape": f"{full_shape[0]},{full_shape[1]}"
        }
        
        if region_size:
            response_headers["X-Mask-Region-Size"] = f"{region_size[0]},{region_size[1]}"
        
        if tissue_class:
            response_headers["X-Tissue-Class"] = tissue_class
        
        return Response(
            content=response_content,
            media_type="application/octet-stream",
            headers=response_headers
        )
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error loading mask: {str(e)}")


@seg_router.post("/v1/clear_nuclei_annotations")
async def clear_nuclei_annotations(
    request: Request,
    path: str = Body(..., description="Path to the zarr file"),
    x1: float = Body(..., description="Bounding box x1"),
    y1: float = Body(..., description="Bounding box y1"),
    x2: float = Body(..., description="Bounding box x2"),
    y2: float = Body(..., description="Bounding box y2"),
    polygon_points: Optional[List[List[float]]] = Body(None, description="Polygon vertices [[x,y],...]")
):
    """Clear all nuclei annotations within the specified region"""
    try:
        from app.services.seg_service import clear_nuclei_annotations_in_region
        
        abs_path = resolve_path(path)
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        
        # Auto-create handler if not exists (e.g., after backend restart)
        if not handler:
            print(f"[clear_nuclei_annotations] No handler found for device {device_id}, creating one for file: {abs_path}")
            handler = SegmentationHandler()
            handler.load_file(abs_path)
            device_annotation_handlers[device_id] = handler
            print(f"[clear_nuclei_annotations] Handler created and cached for device {device_id}")
        
        result = clear_nuclei_annotations_in_region(
            handler=handler,
            file_path=abs_path,
            x1=x1, y1=y1, x2=x2, y2=y2,
            polygon_points=polygon_points
        )
        
        return success_response(result)
    except ValueError as e:
        return error_response(str(e), code=400)
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error clearing nuclei annotations: {str(e)}")


@seg_router.post("/v1/clear_tissue_annotations")
async def clear_tissue_annotations(
    request: Request,
    path: str = Body(..., description="Path to the zarr file"),
    x1: float = Body(..., description="Bounding box x1"),
    y1: float = Body(..., description="Bounding box y1"),
    x2: float = Body(..., description="Bounding box x2"),
    y2: float = Body(..., description="Bounding box y2"),
    polygon_points: Optional[List[List[float]]] = Body(None, description="Polygon vertices [[x,y],...]")
):
    """Clear all tissue annotations within the specified region"""
    try:
        from app.services.seg_service import clear_tissue_annotations_in_region
        
        abs_path = resolve_path(path)
        device_id = get_device_id(request)
        handler = device_annotation_handlers.get(device_id)
        
        # Auto-create handler if not exists (e.g., after backend restart)
        if not handler:
            print(f"[clear_tissue_annotations] No handler found for device {device_id}, creating one for file: {abs_path}")
            handler = SegmentationHandler()
            handler.load_file(abs_path)
            device_annotation_handlers[device_id] = handler
            print(f"[clear_tissue_annotations] Handler created and cached for device {device_id}")
        
        result = clear_tissue_annotations_in_region(
            handler=handler,
            file_path=abs_path,
            x1=x1, y1=y1, x2=x2, y2=y2,
            polygon_points=polygon_points
        )
        
        return success_response(result)
    except ValueError as e:
        return error_response(str(e), code=400)
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error clearing tissue annotations: {str(e)}")


@seg_router.post("/v1/save_annotation/batch")
def save_annotation_batch(req: dict, request: Request):
    """
    Batch save annotations (mark as ground truth). Calls seg_service mark_*_in_region.
    Request body: path, annotation_type ('nuclei'|'tissue'), x1, y1, x2, y2, optional polygon_points.
    Header: X-Instance-ID.
    """
    path = req.get("path", "")
    if is_public_read_only_path(path):
        return error_response("Cannot annotate in sample or data directories. Please use your personal workspace instead.", code=403)
    instance_id = request.headers.get("X-Instance-ID")
    if not instance_id:
        return error_response("X-Instance-ID header is required")
    device_id = get_device_id(request)
    for key in ["path", "zarr_path", "file_path"]:
        if key in req and isinstance(req.get(key), str):
            req[key] = resolve_path(req[key])
    req["instance_id"] = instance_id

    handler = device_annotation_handlers.get(device_id)
    if not handler:
        abs_path = req.get("path") or resolve_path(path)
        handler = SegmentationHandler()
        handler.load_file(abs_path)
        device_annotation_handlers[device_id] = handler

    from app.services.load_service import get_session_data
    session_data = get_session_data(instance_id)
    session_path_raw = session_data.get("current_file_path")
    request_path_raw = req.get("path")
    if session_path_raw and request_path_raw:
        session_zarr = session_path_raw if str(session_path_raw).lower().endswith(".zarr") else f"{session_path_raw}.zarr"
        request_resolved = resolve_path(request_path_raw)
        request_zarr = request_resolved if str(request_resolved).lower().endswith(".zarr") else f"{request_resolved}.zarr"
        session_abs = os.path.realpath(resolve_path(session_zarr))
        request_abs = os.path.realpath(resolve_path(request_zarr))
        if session_abs != request_abs:
            return error_response("Session file path and request path must point to the same Zarr file")

    if session_path_raw:
        wsi_path = session_path_raw
        zarr_path = wsi_path if str(wsi_path).lower().endswith(".zarr") else f"{wsi_path}.zarr"
        zarr_path = resolve_path(zarr_path)
    else:
        zarr_path = resolve_path(request_path_raw) if request_path_raw else None
    if not zarr_path or not os.path.exists(zarr_path):
        return error_response("No Zarr path available or file not found")

    annotation_type = req.get("annotation_type", "nuclei")
    x1, y1, x2, y2 = req.get("x1"), req.get("y1"), req.get("x2"), req.get("y2")
    polygon_points = req.get("polygon_points")
    if x1 is None or y1 is None or x2 is None or y2 is None:
        return error_response("Bounding box coordinates (x1, y1, x2, y2) are required")

    if annotation_type == "nuclei":
        from app.services.seg_service import mark_nuclei_as_ground_truth_in_region
        cell_indices = req.get("cell_indices")  # optional: only mark these cell ids (e.g. filter highlight)
        result = mark_nuclei_as_ground_truth_in_region(
            handler=handler, file_path=zarr_path,
            x1=x1, y1=y1, x2=x2, y2=y2, polygon_points=polygon_points,
            cell_indices=cell_indices if isinstance(cell_indices, list) else None
        )
    elif annotation_type == "tissue":
        from app.services.seg_service import mark_tissue_as_ground_truth_in_region
        result = mark_tissue_as_ground_truth_in_region(
            handler=handler, file_path=zarr_path,
            x1=x1, y1=y1, x2=x2, y2=y2, polygon_points=polygon_points
        )
    else:
        return error_response(f"Invalid annotation_type: {annotation_type}. Must be 'nuclei' or 'tissue'")

    return success_response({
        "message": result.get("message", "Batch annotation saved"),
        "marked_count": result.get("marked_count", 0),
        "marked_classes": result.get("marked_classes", {}),
    })


def _classifier_file_guard_write(path_raw: str):
    if not path_raw or not str(path_raw).strip():
        return error_response("path is required", code=400)
    if is_public_read_only_path(path_raw):
        return error_response(
            "Cannot write classifier into sample or public read-only paths. Use your workspace.",
            code=403,
        )
    return None


@seg_router.get("/v1/classifier_file/load")
def load_classifier_file(
    file_path: str = Query(..., description="Classifier file path (storage-relative or absolute); resolved via resolve_path"),
):
    """
    Load classifier file bytes from server storage (stepwise workflows; no JSON metadata).
    Returns raw bytes as application/octet-stream. 404 if file does not exist.
    """
    if not file_path or not str(file_path).strip():
        return error_response("file_path is required", code=400)
    abs_path = resolve_path(file_path)
    if not os.path.isfile(abs_path):
        return error_response("Classifier file not found", code=404)
    return FileResponse(
        abs_path,
        filename=os.path.basename(abs_path),
        media_type="application/octet-stream",
    )


@seg_router.post("/v1/classifier_file/save")
def save_classifier_file(body: dict = Body(...)):
    """
    Save classifier file on the server (stepwise workflows; no JSON sidecar).

    Body (JSON):
      - path | dest_path | classifier_path: destination file path (required)
      - copy_from_path (optional): if set, copy this server-side path to destination.
          If the source file is missing, creates an empty destination file when
          empty_if_missing_source is true (default true).
      - content_base64 (optional): raw file bytes; used only when copy_from_path is absent.
          If null / missing / empty string and no copy_from_path, writes an empty (0-byte) file.

    Parent directories are created as needed.
    """
    dest_raw = body.get("path") or body.get("dest_path") or body.get("classifier_path")
    err = _classifier_file_guard_write(dest_raw or "")
    if err is not None:
        return err

    dest_abs = resolve_path(dest_raw)
    parent = os.path.dirname(dest_abs)
    os.makedirs(parent, exist_ok=True)

    copy_from = body.get("copy_from_path") or body.get("source_path")
    empty_if_missing = body.get("empty_if_missing_source", True)
    if copy_from:
        src_abs = resolve_path(str(copy_from))
        if os.path.isfile(src_abs):
            shutil.copy2(src_abs, dest_abs)
            size = os.path.getsize(dest_abs)
        else:
            if not empty_if_missing:
                return error_response("copy_from_path does not exist", code=404)
            with open(dest_abs, "wb") as out:
                pass
            size = 0
        return success_response({"path": dest_raw, "size": size, "mode": "copy"})

    b64 = body.get("content_base64")
    if b64 is None or b64 == "":
        data = b""
    else:
        if not isinstance(b64, str):
            return error_response("content_base64 must be a string when provided", code=400)
        try:
            data = base64.b64decode(b64, validate=True)
        except Exception:
            return error_response("Invalid base64 in content_base64", code=400)

    tmp = f"{dest_abs}.tmp.{os.getpid()}"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, dest_abs)
    except Exception as e:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except Exception:
            pass
        logger.exception("classifier_file save failed")
        return error_response(f"Failed to write classifier file: {e}", code=500)

    return success_response({"path": dest_raw, "size": len(data), "mode": "bytes"})


def _tasknode_base_url_for_classifier_save(model_name: str) -> Optional[str]:
    """HTTP base URL for NuClass (ClassificationNode) or MUSK (MuskClassification) tasknode."""
    node_port = None
    node_remote_host = None
    try:
        from app.services.tasks_service import manager

        if model_name in manager.nodes:
            node = manager.nodes[model_name]
            node_port = getattr(node, "port", None)
            if node_port is not None:
                is_remote, remote_host, _mnt = manager._is_remote_node(model_name)
                if is_remote:
                    node_remote_host = remote_host
    except Exception as e:
        logger.warning("classifier_tasknode_save: manager lookup failed: %s", e)

    if node_port is None:
        try:
            from app.services.tasks_service import list_node_ports

            snap = list_node_ports(skip_health_checks=True) or {}
            nodes = snap.get("nodes") or {}
            info = nodes.get(model_name)
            if not info and isinstance(nodes, dict):
                for _k, v in nodes.items():
                    if isinstance(v, dict) and v.get("model_name") == model_name:
                        info = v
                        break
            if isinstance(info, dict):
                node_port = info.get("port")
                if not node_remote_host:
                    node_remote_host = info.get("remote_host")
        except Exception as e:
            logger.warning("classifier_tasknode_save: list_node_ports failed: %s", e)

    if node_port is None:
        node_port = 8006
        logger.warning("classifier_tasknode_save: defaulting to port %s for %s", node_port, model_name)

    host = node_remote_host or "127.0.0.1"
    return f"http://{host}:{node_port}"


@seg_router.post("/v1/classifier_tasknode_save")
def classifier_tasknode_save(body: dict = Body(...)):
    """
    Ask the NuClass or MUSK tasknode to save its last in-memory trained classifier to disk
    (POST /classifier/save with mode=save_trained → save_classifier_params / clf.save_model).

    Body JSON:
      - node_name: "ClassificationNode" | "MuskClassification" (required)
      - dest_path | path: destination path, resolved via resolve_path (required)
    """
    node_name = (body.get("node_name") or "").strip()
    dest_raw = body.get("dest_path") or body.get("path")
    if node_name not in ("ClassificationNode", "MuskClassification"):
        return error_response("node_name must be ClassificationNode or MuskClassification", code=400)
    err = _classifier_file_guard_write(dest_raw or "")
    if err is not None:
        return err
    dest_abs = resolve_path(dest_raw)
    parent = os.path.dirname(dest_abs)
    if parent:
        os.makedirs(parent, exist_ok=True)

    base_url = _tasknode_base_url_for_classifier_save(node_name)
    if not base_url:
        return error_response("Could not resolve tasknode base URL", code=503)

    url = f"{base_url.rstrip('/')}/classifier/save"
    try:
        r = requests.post(
            url,
            json={"mode": "save_trained", "dest_path": dest_abs},
            timeout=600,
        )
    except requests.RequestException as e:
        logger.exception("classifier_tasknode_save: tasknode request failed")
        return error_response(f"Tasknode unreachable: {e}", code=502)

    try:
        payload = r.json()
    except Exception:
        return error_response(f"Invalid JSON from tasknode (HTTP {r.status_code})", code=502)

    if not isinstance(payload, dict) or payload.get("status") != "ok":
        msg = payload.get("message") if isinstance(payload, dict) else str(payload)
        return error_response(msg or f"Tasknode error (HTTP {r.status_code})", code=502)

    if not os.path.isfile(dest_abs):
        return error_response("Classifier file was not written on storage", code=500)

    return success_response(
        {"path": dest_raw, "size": os.path.getsize(dest_abs), "node_name": node_name}
    )

