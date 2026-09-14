from fastapi import APIRouter, Request
from app.core import logger
from app.core.response import success_response, error_response, exception_response
from app.core.access import authorize_read_or_response
from app.services.review import get_review_candidates, get_patch_review_candidates, get_patch_tile_data
from app.api.schema.review import CandidatesRequest, PatchTileRequest

review_router = APIRouter()



@review_router.post("/v1/candidates/cell")
def get_cell_candidates(payload: CandidatesRequest, request: Request):
    """Active-learning candidates for nuclei (cell) classification."""
    try:
        slide_id, denied = authorize_read_or_response(
            request, payload.slide_id, operation="review candidates"
        )
        if denied is not None:
            return denied
        result = get_review_candidates(
            slide_id=slide_id,
            class_name=payload.class_name,
            threshold=payload.threshold,
            sort=payload.sort,
            limit=payload.limit,
            offset=payload.offset,
            cell_ids=payload.cell_ids,
            exclude_saved=payload.exclude_saved,
            side=payload.side,
            saved_only=payload.saved_only,
            roi=payload.roi.model_dump() if payload.roi else None,
            polygon_points=payload.polygon_points,
        )
        if result.get("success"):
            return success_response(result["data"])
        return error_response(result.get("error", "Failed to fetch candidates"), code=result.get("code", 500))
    except Exception as e:
        logger.error(f"Error in get_cell_candidates: {str(e)}", exc_info=e)
        return exception_response(e)


@review_router.post("/v1/candidates/patch")
def get_patch_candidates(payload: CandidatesRequest, request: Request):
    """Active-learning candidates for patch (MUSK) classification."""
    try:
        slide_id, denied = authorize_read_or_response(
            request, payload.slide_id, operation="review candidates"
        )
        if denied is not None:
            return denied
        result = get_patch_review_candidates(
            slide_id=slide_id,
            class_name=payload.class_name,
            threshold=payload.threshold,
            sort=payload.sort,
            limit=payload.limit,
            offset=payload.offset,
            exclude_saved=payload.exclude_saved,
            side=payload.side,
            saved_only=payload.saved_only,
        )
        if result.get("success"):
            return success_response(result["data"])
        return error_response(result.get("error", "Failed to fetch patch candidates"), code=result.get("code", 500))
    except Exception as e:
        logger.error(f"Error in get_patch_candidates: {str(e)}", exc_info=e)
        return exception_response(e)


@review_router.post("/v1/patch_tile")
def get_patch_tile(payload: PatchTileRequest, request: Request):
    """A single patch tile at an adjustable view size (Target Patch preview)."""
    try:
        slide_id, denied = authorize_read_or_response(
            request, payload.slide_id, operation="review tile"
        )
        if denied is not None:
            return denied
        result = get_patch_tile_data(
            slide_id=slide_id,
            patch_id=payload.patch_id,
            window_size_px=payload.window_size_px,
        )
        if result.get("success"):
            return success_response(result["data"])
        return error_response(result.get("error", "Failed to fetch patch tile"))
    except Exception as e:
        logger.error(f"Error in get_patch_tile: {str(e)}", exc_info=e)
        return exception_response(e)
