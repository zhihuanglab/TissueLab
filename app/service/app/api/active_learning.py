from fastapi import APIRouter, Request, HTTPException
from app.core import logger
from app.core.response import success_response, error_response
from pydantic import BaseModel, ConfigDict
from typing import List, Dict, Optional, Literal
import json
import numpy as np
from app.services.active_learning_service import (
    get_candidates_data,
    label_candidate_cell,
    reclassify_candidate_cell,
    save_reclassifications_via_existing_api as service_save_reclassifications
)
from app.utils.request import get_device_id
from app.websocket.segmentation_consumer import device_annotation_handlers
from app.api.schema.active_learning import LabelRequest, RemoveRequest, ReclassifyRequest, \
    SaveReclassificationsRequest, CandidatesRequest

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

al_router = APIRouter()

@al_router.post("/v1/candidates")
async def get_candidates(request: CandidatesRequest):
    """
    Get candidate cells for active learning based on class and probability threshold.
    Follows teacher's nuclei.io approach - candidates are filtered by target class.
    
    Args:
        slide_id: Path to the slide file
        class_name: Target class name for active learning (e.g. "Macrophages")
        threshold: Probability threshold - cells above this are candidates (default: 0.5)
        sort: Sort order - "asc" for Low→High, "desc" for High→Low (default: "asc")
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

@al_router.post("/v1/label")
async def label_candidate(request: LabelRequest):
    """
    Label a candidate cell as Yes (1) or No (0) for active learning.
    
    Args:
        request: LabelRequest containing slide_id, class_name, cell_id, label, prob
        
    Returns:
        {"ok": true} on success
    """
    try:
        result = label_candidate_cell({
            "slide_id": request.slide_id,
            "cell_id": request.cell_id,
            "class_name": request.class_name,
            "label": request.label,
            "prob": request.prob
        })
        
        if result.get("success", False):
            return success_response({"ok": True})
        else:
            return error_response(result.get("error", "Failed to label candidate"))
            
    except Exception as e:
        logger.error(f"Error in label_candidate: {str(e)}")
        return error_response(f"Error labeling candidate: {str(e)}")

@al_router.post("/v1/reclassify")
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
        device_id = get_device_id(http_request)
        handler = device_annotation_handlers.get(device_id)
        if not handler:
            return error_response("No handler found for device")
        result = reclassify_candidate_cell(handler, {
            "slide_id": request.slide_id,
            "cell_id": request.cell_id,
            "original_class": request.original_class,
            "new_class": request.new_class,
            "prob": request.prob
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

@al_router.get("/v1/reclassified")
async def get_reclassified_cells(slide_id: str):
    """
    Get current reclassified cells for debugging.
    
    Args:
        slide_id: Path to slide file
        
    Returns:
        Dictionary with reclassified cells data
    """
    try:
        from app.services.active_learning_service import _reclassified_cells
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

@al_router.post("/v1/remove")
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

@al_router.post("/v1/save-reclassifications-via-existing-api")
async def save_reclassifications_via_existing_api(request: SaveReclassificationsRequest):
    """
    Save current reclassifications using the existing save_annotation API.
    This reuses proven H5 operations instead of duplicating code.
    
    Args:
        request: SaveReclassificationsRequest containing slide_id
        
    Returns:
        {"success": true, "file_path": "path", "count": N} on success
    """
    try:
        result = service_save_reclassifications({
            "slide_id": request.slide_id
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

