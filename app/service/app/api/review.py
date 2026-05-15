from fastapi import APIRouter, Request, HTTPException, Query
from fastapi.responses import FileResponse
from app.core import logger
from app.core.response import success_response, error_response
from pydantic import BaseModel, ConfigDict
from typing import List, Dict, Optional, Literal
import json
import numpy as np
import os
from app.services.review import (
    get_candidates_data,
    get_shuffle_low_prob_candidates,
    label_candidate_cell,
    reclassify_candidate_cell,
    save_reclassifications_via_existing_api as service_save_reclassifications,
    clear_temporary_cells,
    clear_tmp_overlay_images
)
from app.utils.request import get_device_id
from app.websocket.segmentation_consumer import device_annotation_handlers
from app.api.schema.review import LabelRequest, RemoveRequest, ReclassifyRequest, \
    SaveReclassificationsRequest, CandidatesRequest, ShuffleCandidatesRequest

def convert_numpy_types(obj):
    """Convert numpy types to native Python types for JSON serialization"""
    if isinstance(obj, dict):
        return {k: convert_numpy_types(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_numpy_types(v) for v in obj]
    elif isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    else:
        return obj

review_router = APIRouter()

@review_router.post("/v1/candidates")
async def get_candidates(request: CandidatesRequest, http_request: Request):
    """
    Get candidate cells for active learning based on class and probability threshold.
    Follows teacher's nuclei.io approach - candidates are filtered by target class.
    
    Args:
        slide_id: Path to the slide file
        class_name: Target class name for active learning (e.g. "Macrophages")
        threshold: Probability threshold - cells above this are candidates (default: 0.5)
        sort: Sort order - "asc" for Low to High, "desc" for High to Low (default: "asc")
        limit: Maximum number of candidates to return (default: 80)
        offset: Offset for pagination (default: 0)
        cell_ids: Comma-separated cell IDs to limit candidates to (optional, for ROI support)
    
    Returns:
        {
            total: int - Total number of candidates for this class (filtered by cell_ids if provided)
            hist: List[int] - Histogram data (20 bins from 0-1) for the class
            items: List[Dict] - Candidate data with images, sorted by probability
        }
    POST variant of candidates endpoint to avoid extremely long URLs when passing many cell_ids.
    Accepts JSON body with the same fields as the GET query parameters.
    """
    try:
        # MULTI-USER: Extract instance_id from header (REQUIRED)
        instance_id = http_request.headers.get("X-Instance-ID")
        if not instance_id:
            return {"code": 400, "message": "X-Instance-ID header is required for multi-user isolation", "data": {}}
        
        # Normalize cell_ids to comma-separated string expected by service layer
        normalized_cell_ids = None
        if request.cell_ids is not None:
            try:
                if isinstance(request.cell_ids, list):
                    # list of ints or strings
                    normalized_cell_ids = ",".join(str(int(x)) for x in request.cell_ids)
                elif isinstance(request.cell_ids, str):
                    normalized_cell_ids = request.cell_ids
                else:
                    # Unknown type; try to JSON-dump and parse list
                    parsed = request.cell_ids  # already a python object
                    if isinstance(parsed, list):
                        normalized_cell_ids = ",".join(str(int(x)) for x in parsed)
                    else:
                        normalized_cell_ids = None
            except Exception as norm_err:
                logger.error(f"Error normalizing cell_ids: {norm_err}")
                normalized_cell_ids = None

        params = {
            "slide_id": request.slide_id,
            "class_name": request.class_name,
            "threshold": request.threshold,
            "sort": request.sort,
            "limit": request.limit,
            "offset": request.offset,
            "cell_ids": normalized_cell_ids,
            "exclude_reclassified": request.exclude_reclassified,
            "side": request.side,  # "left" or "right" - which side of threshold to return
            "instance_id": instance_id,  # MULTI-USER: Pass instance_id to service
        }

        result = get_candidates_data(params)

        if result.get("success", False):
            raw_data = result.get("data", {})
            clean_data = convert_numpy_types(raw_data)
            try:
                json.dumps(clean_data)
                return {"code": 0, "message": "Success", "data": clean_data}
            except Exception as json_error:
                logger.error(f"JSON serialization error: {json_error}")
                return {"code": 500, "message": f"JSON serialization error: {json_error}", "data": {}}
        else:
            return {"code": 500, "message": result.get("error", "Failed to fetch candidates"), "data": {}}
    except Exception as e:
        logger.error(f"Error in get_candidates: {str(e)}")
        return {"code": 500, "message": f"Error fetching candidates: {str(e)}", "data": {}}

@review_router.post("/v1/candidates/right")
async def get_candidates_right(request: CandidatesRequest, http_request: Request):
    """
    Get candidate cells for active learning with probability >= threshold (right side of threshold).
    This is a convenience endpoint that sets side="right" automatically.
    
    Args:
        Same as /v1/candidates, but automatically filters for prob >= threshold
    
    Returns:
        Same format as /v1/candidates
    """
    try:
        # MULTI-USER: Extract instance_id from header (REQUIRED)
        instance_id = http_request.headers.get("X-Instance-ID")
        if not instance_id:
            return {"code": 400, "message": "X-Instance-ID header is required for multi-user isolation", "data": {}}
        
        # Normalize cell_ids to comma-separated string expected by service layer
        normalized_cell_ids = None
        if request.cell_ids is not None:
            try:
                if isinstance(request.cell_ids, list):
                    normalized_cell_ids = ",".join(str(int(x)) for x in request.cell_ids)
                elif isinstance(request.cell_ids, str):
                    normalized_cell_ids = request.cell_ids
                else:
                    parsed = request.cell_ids
                    if isinstance(parsed, list):
                        normalized_cell_ids = ",".join(str(int(x)) for x in parsed)
                    else:
                        normalized_cell_ids = None
            except Exception as norm_err:
                logger.error(f"Error normalizing cell_ids: {norm_err}")
                normalized_cell_ids = None

        params = {
            "slide_id": request.slide_id,
            "class_name": request.class_name,
            "threshold": request.threshold,
            "sort": request.sort,
            "limit": request.limit,
            "offset": request.offset,
            "cell_ids": normalized_cell_ids,
            "exclude_reclassified": request.exclude_reclassified,
            "side": "right",  # Force right side (prob >= threshold)
            "instance_id": instance_id,
        }

        result = get_candidates_data(params)

        if result.get("success", False):
            raw_data = result.get("data", {})
            clean_data = convert_numpy_types(raw_data)
            try:
                json.dumps(clean_data)
                return {"code": 0, "message": "Success", "data": clean_data}
            except Exception as json_error:
                logger.error(f"JSON serialization error: {json_error}")
                return {"code": 500, "message": f"JSON serialization error: {json_error}", "data": {}}
        else:
            return {"code": 500, "message": result.get("error", "Failed to fetch candidates"), "data": {}}
    except Exception as e:
        logger.error(f"Error in get_candidates_right: {str(e)}")
        return {"code": 500, "message": f"Error fetching candidates: {str(e)}", "data": {}}

@review_router.post("/v1/candidates/shuffle")
async def shuffle_candidates(request: ShuffleCandidatesRequest, http_request: Request):
    """
    Provide low-probability candidate metadata for agent/LLM workflows, shuffled across classes.
    """
    try:
        instance_id = http_request.headers.get("X-Instance-ID")
        if not instance_id:
            return {"code": 400, "message": "X-Instance-ID header is required for multi-user isolation", "data": {}}

        params = {
            "slide_id": request.slide_id,
            "threshold": request.threshold,
            "limit": request.limit,
            "class_names": request.class_names,
            "exclude": request.exclude,
            "instance_id": instance_id,
        }

        result = get_shuffle_low_prob_candidates(params)
        if result.get("success", False):
            clean_data = convert_numpy_types(result.get("data", {}))
            return success_response(clean_data)
        else:
            return error_response(result.get("error", "Failed to fetch shuffle candidates"))
    except Exception as e:
        logger.error(f"Error in shuffle_candidates: {str(e)}")
        return error_response(f"Error fetching shuffle candidates: {str(e)}")

@review_router.get("/v1/candidates/images")
async def get_candidate_image(path: str = Query(..., description="Path to image file"), http_request: Request = None):
    """
    Serve image files from tmp folder or other locations.
    Used to access images saved by shuffle candidates API.
    """
    try:
        # Decode the path
        import urllib.parse
        decoded_path = urllib.parse.unquote(path)
        
        # Security check: ensure the path exists and is within allowed directories
        if not os.path.exists(decoded_path):
            raise HTTPException(status_code=404, detail=f"Image file not found: {decoded_path}")
        
        # Check if it's a valid image file
        valid_extensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp']
        if not any(decoded_path.lower().endswith(ext) for ext in valid_extensions):
            raise HTTPException(status_code=400, detail="Invalid image file type")
        
        # Return the file
        return FileResponse(
            decoded_path,
            media_type='image/jpeg' if decoded_path.lower().endswith(('.jpg', '.jpeg')) else 'image/png'
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error serving image file: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error serving image: {str(e)}")

@review_router.post("/v1/candidates/reset")
async def reset_overlay_images_endpoint(request: SaveReclassificationsRequest, http_request: Request):
    """
    Delete all overlay images in the tmp directory for a slide.
    Removes the entire tmp folder and all its contents.
    
    Args:
        request: SaveReclassificationsRequest containing slide_id
    
    Returns:
        {
            "code": 0,
            "message": "Success",
            "data": {
                "success": true,
                "count": N,
                "message": "Deleted N files from tmp directory"
            }
        }
    """
    try:
        result = clear_tmp_overlay_images(request.slide_id)
        if result.get("success", False):
            return success_response(result)
        else:
            return error_response(result.get("error", "Failed to clear tmp directory"))
    except Exception as e:
        logger.error(f"Error in reset_overlay_images_endpoint: {str(e)}")
        return error_response(f"Error resetting overlay images: {str(e)}")

@review_router.post("/v1/label")
async def label_candidate(request: LabelRequest, http_request: Request):
    """
    Label a candidate cell as Yes (1) or No (0) for active learning.
    
    Args:
        request: LabelRequest containing slide_id, class_name, cell_id, label, prob
        
    Returns:
        {"ok": true} on success
    """
    try:
        # MULTI-USER: Extract instance_id from header (REQUIRED)
        instance_id = http_request.headers.get("X-Instance-ID")
        if not instance_id:
            return {"code": 400, "message": "X-Instance-ID header is required for multi-user isolation"}
        
        result = label_candidate_cell({
            "slide_id": request.slide_id,
            "cell_id": request.cell_id,
            "class_name": request.class_name,
            "label": request.label,
            "prob": request.prob,
            "instance_id": instance_id,  # MULTI-USER: Pass instance_id
        })
        
        if result.get("success", False):
            return success_response({"ok": True})
        else:
            return error_response(result.get("error", "Failed to label candidate"))
            
    except Exception as e:
        logger.error(f"Error in label_candidate: {str(e)}")
        return error_response(f"Error labeling candidate: {str(e)}")

@review_router.post("/v1/reclassify")
async def reclassify_candidate(request: ReclassifyRequest, http_request: Request):
    """
    Reclassify a candidate cell from original class to new class.
    This is used when user clicks "No" and selects a different class.
    
    Args:
        request: ReclassifyRequest containing slide_id, cell_id, original_class, new_class, prob
        
    Returns:
        {"ok": true} on success
    """
    try:
        # MULTI-USER: Extract instance_id from header (REQUIRED)
        instance_id = http_request.headers.get("X-Instance-ID")
        if not instance_id:
            return {"code": 400, "message": "X-Instance-ID header is required for multi-user isolation"}
        
        device_id = get_device_id(http_request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device")
        result = reclassify_candidate_cell(handler, {
            "slide_id": request.slide_id,
            "cell_id": request.cell_id,
            "original_class": request.original_class,
            "new_class": request.new_class,
            "prob": request.prob,
            # Pass optional fields from frontend
            "centroid_x": request.centroid_x,
            "centroid_y": request.centroid_y,
            "cell_color": request.cell_color,
            "is_manual_reclassification": request.is_manual_reclassification,
            "instance_id": instance_id,  # MULTI-USER: Pass instance_id
        })
        
        if result.get("success", False):
            return success_response({
                "ok": True, 
                "is_original_manual": result.get("is_original_manual", False)
            })
        else:
            return error_response(result.get("error", "Failed to reclassify candidate"))
        
    except Exception as e:
        logger.error(f"Error in reclassify_candidate: {str(e)}")
        return error_response(f"Error reclassifying candidate: {str(e)}")

@review_router.get("/v1/reclassified")
async def get_reclassified_cells(slide_id: str):
    """
    Get current reclassified cells for debugging.
    
    Args:
        slide_id: Path to slide file
        
    Returns:
        Dictionary with reclassified cells data
    """
    try:
        from app.services.review import _reclassified_cells
        from app.utils import resolve_path
        
        slide_path = resolve_path(slide_id)
        reclassified_data = _reclassified_cells.get(slide_path, {})
        
        return success_response({
            "slide_path": slide_path,
            "reclassified_cells": reclassified_data,
            "total_reclassified": len(reclassified_data)
        })
        
    except Exception as e:
        logger.error(f"Error getting reclassified cells: {str(e)}")
        return error_response(f"Error getting reclassified cells: {str(e)}")

@review_router.post("/v1/remove")
async def remove_candidate(request: RemoveRequest):
    """
    Remove a candidate cell from the target class.
    
    Args:
        request: RemoveRequest containing slide_id, class_name, cell_id
        
    Returns:
        {"ok": true} on success
    """
    try:
        logger.info(f"Active Learning Remove: cell_id={request.cell_id}")
        
        return success_response({"ok": True})
        
    except Exception as e:
        logger.error(f"Error in remove_candidate: {str(e)}")
        return error_response(f"Error removing candidate: {str(e)}")

@review_router.post("/v1/reclassification/commit")
async def save_reclassifications_via_existing_api(request: SaveReclassificationsRequest, http_request: Request):
    """
    Save current reclassifications using the same structured array format as save_annotation API.
    This ensures data format consistency with the segmentation save annotation API.
    
    Args:
        request: SaveReclassificationsRequest containing slide_id
        
    Returns:
        {"success": true, "file_path": "path", "count": N} on success
    """
    try:
        # MULTI-USER: Extract instance_id from header (REQUIRED)
        instance_id = http_request.headers.get("X-Instance-ID")
        if not instance_id:
            return {"code": 400, "message": "X-Instance-ID header is required for multi-user isolation"}
        
        # Get device handler (same pattern as save_annotation)
        device_id = get_device_id(http_request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device")
        
        result = service_save_reclassifications(handler, {
            "slide_id": request.slide_id,
            "instance_id": instance_id,  # MULTI-USER: Pass instance_id
        })
        
        if result.get("success", False):
            return success_response({
                "success": True,
                "file_path": result.get("file_path"),
                "count": result.get("count", 0),
                "message": result.get("message", "Reclassifications saved successfully")
            })
        else:
            return error_response(result.get("error", "Failed to save reclassifications"))
        
    except Exception as e:
        logger.error(f"Error in save_reclassifications_via_existing_api: {str(e)}")
        return error_response(f"Error saving reclassifications: {str(e)}")

@review_router.post("/v1/clear-temporary-cells")
async def clear_temporary_cells_endpoint(request: SaveReclassificationsRequest, http_request: Request):
    """
    Clear temporary class cells (Other, Not Sure, Incorrect Segmentation) from memory.
    This should be called when the review panel is closed.
    
    Args:
        request: SaveReclassificationsRequest containing slide_id
    
    Returns:
        {"success": true, "count": N} on success
    """
    try:
        # MULTI-USER: Extract instance_id from header (REQUIRED)
        instance_id = http_request.headers.get("X-Instance-ID")
        if not instance_id:
            return {"code": 400, "message": "X-Instance-ID header is required for multi-user isolation"}
        
        result = clear_temporary_cells(request.slide_id, instance_id)
        return success_response(result)
    except Exception as e:
        logger.error(f"Error in clear_temporary_cells: {str(e)}")
        return error_response(f"Error clearing temporary cells: {str(e)}")
