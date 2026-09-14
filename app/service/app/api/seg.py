from fastapi import APIRouter, Query, Body, Request, HTTPException
from fastapi.responses import StreamingResponse, FileResponse, Response
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

from app.core.response import success_response, error_response, permission_denied_response
from app.core.executors import slide_metadata_executor
from app.core.access import (
    authorize_read_or_response,
    guard_instance_owner,
    guard_write_path,
    guard_write_path_async,
    sanitize_client_path,
)
from app.config.zarr_compat import as_zarr_path

logger = logging.getLogger(__name__)

# Create a dedicated thread pool executor for mask processing
# This prevents mask processing from blocking other API requests
_MASK_EXECUTOR = ThreadPoolExecutor(
    max_workers=max(4, min(16, os.cpu_count() or 4)),
    thread_name_prefix="MaskWorker"
)
from app.services.seg import (
    get_file_path,
    get_user_annotation_indices,
    query_viewport,
    reload_segmentation_data,
    set_segmentation_types,
    update_class_color_service,
    update_patch_class_color_service,
    query_patches_in_viewport,
    get_segmentation_mask,
    list_mask_options,
    clear_nuclei_annotations_in_region,
    clear_tissue_annotations_in_region,
    mark_patches_as_ground_truth,
    remove_patch_annotations,
    build_mask_binary_response,
    save_annotation_batch_service,
    resolve_classifier_tasknode_url,
    SegmentationHandler,
)
from app.utils import resolve_path
from app.utils.common.request import get_instance_id
from app.services.seg_registry import (
    get_annotation_handler,
    pop_instance_handlers,
)

# Create router
seg_router = APIRouter()


_SLIDE_FILE_EXTS = (
    '.zarr.zip', '.zarr', '.svs', '.tiff', '.tif', '.ndpi', '.mrxs',
    '.scn', '.bif', '.czi', '.dcm', '.vsi', '.qptiff',
)


def _slide_stem_for_filename(file_path: Optional[str]) -> str:
    """Derive a short, filename-safe slide name from the handler's current
    file path — drops directory + known slide extension so exports land as
    `<slide>_<kind>_<timestamp>.csv`. Returns 'slide' as a generic fallback
    when no path is available."""
    import re
    if not file_path:
        return 'slide'
    base = os.path.basename(file_path.rstrip('/').rstrip('\\'))
    base_lower = base.lower()
    for ext in _SLIDE_FILE_EXTS:
        if base_lower.endswith(ext):
            base = base[:-len(ext)]
            break
    base = re.sub(r'[^A-Za-z0-9._-]', '_', base).strip('_')
    return base or 'slide'


def _require_instance_id(request: Request) -> str:
    """Handler-backed endpoints must identify the viewer session."""
    instance_id = get_instance_id(request)
    if not instance_id:
        raise HTTPException(
            status_code=400,
            detail="X-Instance-ID header is required for segmentation handler APIs",
        )
    return instance_id


def _get_owned_handler(request: Request, operation: str = "access segmentation instance"):
    """Return ``(handler, None)`` or ``(None, denial_response)``."""
    instance_id = get_instance_id(request)
    if not instance_id:
        return None, error_response(
            "X-Instance-ID header is required for segmentation handler APIs",
            code=400,
        )
    denied = guard_instance_owner(request, instance_id, operation)
    if denied is not None:
        return None, denied
    handler = get_annotation_handler(instance_id)
    if handler is None:
        return None, error_response(
            "No segmentation handler for this instance. Open a slide first.",
            code=404,
        )
    return handler, None


def _same_slide_path(a: Optional[str], b: Optional[str]) -> bool:
    """True when two paths refer to the same slide (tolerates missing ``.zarr`` suffix)."""
    if not a or not b:
        return False
    if SegmentationHandler._same_zarr_path(a, b):
        return True

    def _stem(path: str) -> str:
        try:
            p = os.path.normcase(os.path.normpath(os.path.abspath(path)))
        except Exception:
            p = path
        p = p.rstrip("/\\")
        lower = p.lower()
        if lower.endswith(".zarr.zip"):
            return p[:-9]
        if lower.endswith(".zarr"):
            return p[:-5]
        return p

    try:
        return _stem(a) == _stem(b)
    except Exception:
        return False


def _ensure_handler_bound(
    handler: SegmentationHandler,
    file_path: Optional[str],
    *,
    need_centroids: bool = False,
    need_patches: bool = False,
) -> None:
    """Load missing in-memory data for the handler's *already bound* slide.

    Does not rebind to a different path. If ``file_path`` is provided and
    refers to a different slide than ``handler.zarr_file``, raise HTTP 409.
    """
    bound = getattr(handler, 'zarr_file', None)
    if file_path and bound and not _same_slide_path(bound, file_path):
        raise ValueError(
            "Request file_path does not match the instance handler's bound slide. "
            "Re-bind via set_path for this instance first."
        )
    target = bound or file_path
    if not target:
        return
    try:
        handler.ensure_file(
            target,
            need_centroids=need_centroids,
            need_patches=need_patches,
        )
    except (NotADirectoryError, PermissionError) as e:
        # Normalize store-unavailable errors so callers that only catch
        # FileNotFoundError (viewport query, etc.) degrade to 404 instead of 500.
        raise FileNotFoundError(str(e)) from e


def _parse_polygon_points(polygon_points_json: Optional[str]) -> Optional[List[Tuple[float, float]]]:
    """Parse a JSON string of polygon vertices into a list of (x, y) tuples.

    Returns None for missing or malformed input (lenient: filtering simply does not apply).
    """
    if not polygon_points_json:
        return None
    try:
        parsed_points = json.loads(polygon_points_json)
    except json.JSONDecodeError:
        print(f"[WARN] Failed to decode polygon_points JSON: {polygon_points_json}")
        return None
    if isinstance(parsed_points, list) and all(
        isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(coord, (int, float)) for coord in p)
        for p in parsed_points
    ):
        return [(float(p[0]), float(p[1])) for p in parsed_points]
    print(f"[WARN] Invalid format received for polygon_points: {polygon_points_json}")
    return None


@seg_router.get("/v1/query")
def query(
    request: Request,
    x1: float = Query(..., description="Raw BBox Top-left x"),
    y1: float = Query(..., description="Raw BBox Top-left y"),
    x2: float = Query(..., description="Raw BBox Bottom-right x"),
    y2: float = Query(..., description="Raw BBox Bottom-right y"),
    polygon_points_json: Optional[str] = Query(None, alias="polygon_points", description="JSON string of polygon vertices [[x,y],...] in raw coordinates"),
    class_name: Optional[str] = Query(None, description="Class name"),
    color: Optional[str] = Query(None, description="Color"),
    with_classes: bool = Query(
        False,
        description=(
            "Also return each matching cell's current class as `matching_class_ids` "
            "(indices into the returned `class_names`; -1 = unclassified). Off by "
            "default: the result set is unbounded and plain viewport refreshes do "
            "not need it."
        ),
    ),
):
    """Query nuclei within viewport, optionally filtered by polygon"""
    try:
        file_path = get_file_path(request)
        if not file_path:
            raise HTTPException(status_code=400, detail="No file path provided")

        polygon_points = _parse_polygon_points(polygon_points_json)
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _ensure_handler_bound(handler, file_path, need_centroids=True)
        result = query_viewport(
            handler, x1, y1, x2, y2, polygon_points, class_name, color, file_path,
            with_classes=with_classes,
        )

        return success_response(result)

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error querying data: {str(e)}")


@seg_router.get("/v1/user_annotation_indices")
def user_annotation_indices(request: Request):
    """Return indices of user-annotated (ground truth) nuclei and tissue for the current image.

    Sync on purpose. This opens the sidecar store and reads the whole
    User-Annotations/cell array; FastAPI runs a plain ``def`` route in a
    worker thread, so neither that read nor the path authorization ahead of
    it holds the event loop. As ``async def`` it froze every other request
    and websocket message for the length of the read.
    """
    try:
        file_path = get_file_path(request)
        if not file_path:
            raise HTTPException(status_code=400, detail="No file path provided")
        authorized_path, denied = authorize_read_or_response(
            request, file_path, operation="read annotation indices"
        )
        if denied is not None:
            return denied
        result = get_user_annotation_indices(authorized_path)
        return success_response(result)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Error reading annotation indices")


@seg_router.get("/v1/query_patches")
def query_patches(
    request: Request,
    x1: float = Query(..., description="Raw BBox Top-left x"),
    y1: float = Query(..., description="Raw BBox Top-left y"),
    x2: float = Query(..., description="Raw BBox Bottom-right x"),
    y2: float = Query(..., description="Raw BBox Bottom-right y"),
    polygon_points_json: Optional[str] = Query(None, alias="polygon_points", description="JSON string of polygon vertices [[x,y],...] in raw coordinates"),
):
    """Query patches overlapping the viewport, optionally filtering by polygon containment of patch centroid."""
    try:
        file_path = get_file_path(request)
        if not file_path:
            raise HTTPException(status_code=400, detail="No file path provided")
        authorized_path, denied = authorize_read_or_response(
            request, file_path, operation="query patches"
        )
        if denied is not None:
            return denied

        polygon_points = _parse_polygon_points(polygon_points_json)

        # Path-only: reads patch coordinates directly from zarr (no in-memory handler).
        result = query_patches_in_viewport(None, x1, y1, x2, y2, polygon_points, authorized_path)

        return success_response(result)  # Contains matching_patch_indices

    except HTTPException:
        raise
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Patch data not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Error querying patch data")


@seg_router.get("/v1/tissues")
def tissues(request: Request):
    """Get tissue data"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        file_path = handler.get_current_file_path()
        # Only load if handler doesn't have data
        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)
        tissues = handler.tissues
        tissue_annotations = handler.get_all_tissue_annotations()
        return success_response({
            "tissues": tissues,
            "patch": tissue_annotations,
            "count": len(tissues)
        })
    except ValueError as e:
        return error_response(str(e), code=404)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.post("/v1/reload")
async def reload(request: Request):
    """Reload segmentation data"""
    try:
        body_bytes = await request.body()
        body_str = body_bytes.decode()

        try:
            body = await request.json()
            path = body.get("path")
        except:
            path = body_str.strip()

        if not path:
            return error_response("No path provided", code=400)

        abs_path = resolve_path(path)
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        # load_file is sync/IO — don't block the event loop (WS pings share it).
        result = await asyncio.get_running_loop().run_in_executor(
            slide_metadata_executor, reload_segmentation_data, handler, abs_path
        )

        return success_response(result)

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error reloading data: {str(e)}")


@seg_router.get("/v1/output_path")
def get_output_path(request: Request):
    """Get output path"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        file_path = handler.get_current_file_path()
        return success_response(sanitize_client_path(file_path))
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response("Error reading output path")


@seg_router.post("/v1/reset")
def reset(request: Request):
    """Drop the instance segmentation handler (e.g. leaving the viewer)."""
    try:
        instance_id = _require_instance_id(request)
        # Teardown: releasing a handler that is already gone is the goal, not a
        # violation. Denying it left the handler registered for a viewer that
        # had closed.
        denied = guard_instance_owner(
            request, instance_id, "reset segmentation", teardown=True
        )
        if denied is not None:
            return denied
        pop_instance_handlers(instance_id)
        return success_response({"message": "Segmentation handler cleared for instance"})

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response("Error resetting segmentation handler")


@seg_router.post("/v1/set_types")
def set_types(
    request: Request,
    tissue: Optional[str] = Body(None, description="Tissue segmentation type"),
    nuclei: Optional[str] = Body(None, description="Nuclei segmentation type"),
    patch: Optional[str] = Body(None, description="Patch segmentation type")
):
    """Set segmentation types"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        result = set_segmentation_types(handler, tissue, nuclei, patch)
        return success_response(result)

    except ValueError as e:
        return error_response(str(e), code=400)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/classifications")
def classifications(request: Request):
    """
    Get cell classification data

    Returns:
      {
        "class_indices": [...],
        "class_names": [...],
        "class_colors": [...]
      }
    """
    try:
        # Use instance-scoped handler and ensure file is loaded if provided
        try:
            file_path = get_file_path(request)
        except Exception:
            file_path = None

        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied

        # The viewer only needs the palette here: the overlay frames already
        # carry each cell's class_id. Asking for the per-cell class_indices as
        # well forced a full segmentation-data load — every centroid plus the
        # KD-tree, measured at 1455 ms on a fresh handler, right in the middle
        # of a slide switch.
        #
        # Sync endpoint on purpose: FastAPI runs it on its own worker threads,
        # off the event loop and out of the pool the tile reads use.
        try:
            _ensure_handler_bound(handler, file_path, need_centroids=False)
            data = handler.get_cell_classification_palette()
            if data is None:
                # Store layouts where the palette only materializes once the
                # segmentation arrays are read. Pay the full load, but only for
                # those — not on every slide switch.
                _ensure_handler_bound(handler, file_path, need_centroids=True)
                data = handler.get_cell_classification_palette()
        except (FileNotFoundError, NotADirectoryError, PermissionError) as e:
            # No companion .zarr yet (or a stray non-directory at that path) —
            # not an internal error; mirror the empty/missing-data response.
            logger.warning("classifications: store unavailable: %s", e)
            return error_response("No classification data in zarr", code=404)

        if data is None:
            return error_response("No classification data in zarr", code=404)

        return success_response(data)

    except ValueError as e:
        return error_response("No classification data in zarr", code=404)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/total_counts")
def total_counts(request: Request):
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
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        try:
            _ensure_handler_bound(handler, file_path)
        except (FileNotFoundError, NotADirectoryError, PermissionError) as e:
            logger.warning("total_counts: store unavailable: %s", e)
            return error_response("No classification data in zarr", code=404)
        data = handler.get_global_nuclei_label_counts()
        return success_response(data)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/region_probability_histogram")
def region_probability_histogram(
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
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        try:
            _ensure_handler_bound(handler, file_path)
        except (FileNotFoundError, NotADirectoryError, PermissionError) as e:
            logger.warning("region_probability_histogram: store unavailable: %s", e)
            return error_response("No classification data in zarr", code=404)
        data = handler.get_region_probability_histogram(start_x, start_y, end_x, end_y, class_id)
        return success_response(data)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/manual_annotation_counts")
def manual_annotation_counts(request: Request):
    """
    Get manual annotation counts only (not including model predictions).

    Returns:
      {
        "class_counts_by_id": {"0": int, ...},           # cells labelled as the class
        "negative_class_counts_by_id": {"0": int, ...},  # cells marked "not this type"
        "dynamic_class_names": [str, ...]
      }
    """
    try:
        try:
            file_path = get_file_path(request)
        except Exception:
            file_path = None
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        # Read-only counts: bind path if provided; missing store → empty counts.
        if file_path:
            try:
                _ensure_handler_bound(handler, file_path)
            except (FileNotFoundError, NotADirectoryError, PermissionError, ValueError) as e:
                logger.warning(f"manual_annotation_counts: store unavailable, returning empty counts: {e}")
                return success_response({"class_counts_by_id": {},
                                         "negative_class_counts_by_id": {},
                                         "dynamic_class_names": []})

        # get_all_nuclei_counts() includes AL reclassifications per instance
        data = handler.get_all_nuclei_counts(instance_id=get_instance_id(request))

        return success_response(data)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/annotation_colors")
def annotation_colors(request: Request):
    """Get annotation colors"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        colors = handler.get_annotation_colors()
        return success_response(colors)

    except HTTPException:
        raise
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

        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _, denied = await guard_write_path_async(request, file_path, "update class color")
        if denied is not None:
            return denied
        # zarr write under zarr_lock — off the loop, like delete_class.
        result = await asyncio.to_thread(
            update_class_color_service, handler, class_name, new_color, file_path
        )
        return success_response(result)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
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

        if not file_path:
            raise HTTPException(status_code=400, detail="File path is required.")

        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _, denied = await guard_write_path_async(request, file_path, "update patch class color")
        if denied is not None:
            return denied
        result = await asyncio.to_thread(
            update_patch_class_color_service, handler, class_name, new_color, file_path
        )
        return success_response(result)
    except FileNotFoundError as e:
        logger.error(f"[API] update-patch-class-color FileNotFoundError: {e}", exc_info=e)
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        logger.error(f"[API] update-patch-class-color ValueError: {e}", exc_info=e)
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[API] update-patch-class-color Exception: {e}", exc_info=e)
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

        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _, denied = await guard_write_path_async(request, file_path, "delete class")
        if denied is not None:
            return denied
        # Binding loads every centroid and the rewrite walks the store. This one
        # keeps `await request.json()`, so it cannot become a sync endpoint like
        # its neighbours — hand the blocking part to the slide pool instead.
        def _delete_class():
            _ensure_handler_bound(handler, file_path, need_centroids=True)
            result = handler.delete_class_in_zarr(class_name, reassign_to or "Negative control")
            # Clear cached class data so the next read reloads from the zarr.
            handler.class_name = None
            handler.class_hex_color = None
            handler.invalidate_user_counts_cache()
            return result

        result = await asyncio.get_running_loop().run_in_executor(
            slide_metadata_executor, _delete_class
        )
        return success_response(result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error deleting class: {str(e)}")


@seg_router.get("/v1/annotations")
def annotations(
    request: Request,
    offset: int = Query(0, description="Start index of annotations"),
    limit: Optional[int] = Query(None, description="Maximum number of annotations to return")
):
    """Get annotations with pagination"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        # Read ACL only (Viewer/Samples hydrate/sidebar). Export routes use guard_write_path.
        path = handler.get_current_file_path() or ""
        _, denied = authorize_read_or_response(request, path, operation="list annotations")
        if denied is not None:
            return denied
        file_path = handler.get_current_file_path()
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
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/annotations/export/csv")
def export_annotations_csv(request: Request):
    """
    Export all cell annotations as CSV in streaming fashion.
    Optimized for large datasets (300k+ cells) by streaming data in batches.
    """
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _, denied = guard_write_path(request, handler.get_current_file_path() or "", "export annotations")
        if denied is not None:
            return denied

        file_path = handler.get_current_file_path()

        # Only load if handler doesn't have data
        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)

        # Check if we have data to export
        if handler.centroids is None or len(handler.centroids) == 0:
            raise HTTPException(status_code=404, detail="No annotation data available")

        total_cells = len(handler.centroids)

        # Use the streaming generator from handler
        csv_generator = handler.generate_annotations_csv_stream(batch_size=5000)

        # Generate unique filename with timestamp to avoid browser caching issues.
        # Slide stem in front so multiple exports from different slides sort together.
        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = _slide_stem_for_filename(file_path)
        filename = f"{stem}_Cell_{timestamp}.csv"

        return StreamingResponse(
            csv_generator,
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename={filename}",
                "Cache-Control": "no-cache",
                "X-Total-Cells": str(total_cells)
            }
        )

    except HTTPException:
        raise
    except ValueError as e:
        logger.error(f"[API] export_annotations_csv ValueError: {e}", exc_info=e)
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"[API] export_annotations_csv Exception: {e}", exc_info=e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error exporting CSV: {str(e)}")


@seg_router.get("/v1/annotations/export/geojson")
def export_annotations_geojson(
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
    """
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _, denied = guard_write_path(request, handler.get_current_file_path() or "", "export annotations")
        if denied is not None:
            return denied

        file_path = handler.get_current_file_path()

        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)

        if handler.centroids is None or len(handler.centroids) == 0:
            raise HTTPException(status_code=404, detail="No annotation data available")

        total_cells = len(handler.centroids)

        geojson_generator = handler.generate_annotations_geojson_stream(
            batch_size=batch_size,
        )

        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = _slide_stem_for_filename(file_path)
        filename = f"{stem}_Cell_{timestamp}.geojson"

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
        logger.error(f"[API] export_annotations_geojson ValueError: {e}", exc_info=e)
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"[API] export_annotations_geojson Exception: {e}", exc_info=e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error exporting GeoJSON: {str(e)}")


@seg_router.get("/v1/annotations/export/user/csv")
def export_user_annotations_csv(request: Request):
    """Export USER-set annotations only — manually reclassified nuclei +
    user-drawn tissue polygons — as CSV. Differs from /export/csv which
    streams the full cell-classification segmentation output."""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _, denied = guard_write_path(request, handler.get_current_file_path() or "", "export annotations")
        if denied is not None:
            return denied

        file_path = handler.get_current_file_path()
        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)

        csv_generator = handler.generate_user_annotations_csv_stream(batch_size=5000)

        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = _slide_stem_for_filename(file_path)
        filename = f"{stem}_User_Annotations_{timestamp}.csv"
        return StreamingResponse(
            csv_generator,
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename={filename}",
                "Cache-Control": "no-cache",
            },
        )
    except HTTPException:
        raise
    except ValueError as e:
        logger.error(f"[API] export_user_annotations_csv ValueError: {e}", exc_info=e)
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"[API] export_user_annotations_csv Exception: {e}", exc_info=e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error exporting user CSV: {str(e)}")


@seg_router.get("/v1/annotations/export/user/geojson")
def export_user_annotations_geojson(
    request: Request,
    batch_size: int = Query(
        5000,
        ge=500,
        le=20000,
        description="GeoJSON streaming batch size (features per chunk)",
    ),
):
    """Export USER-set annotations as GeoJSON. Features carry a QuPath-style
    `properties.classification` and a `properties.kind` ('cell' or 'polygon')
    so the file can be split downstream if needed."""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _, denied = guard_write_path(request, handler.get_current_file_path() or "", "export annotations")
        if denied is not None:
            return denied

        file_path = handler.get_current_file_path()
        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)

        geojson_generator = handler.generate_user_annotations_geojson_stream(batch_size=batch_size)

        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = _slide_stem_for_filename(file_path)
        filename = f"{stem}_User_Annotations_{timestamp}.geojson"
        return StreamingResponse(
            geojson_generator,
            media_type="application/geo+json",
            headers={
                "Content-Disposition": f"attachment; filename={filename}",
                "Cache-Control": "no-cache",
            },
        )
    except HTTPException:
        raise
    except ValueError as e:
        logger.error(f"[API] export_user_annotations_geojson ValueError: {e}", exc_info=e)
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"[API] export_user_annotations_geojson Exception: {e}", exc_info=e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error exporting user GeoJSON: {str(e)}")


@seg_router.get("/v1/annotations/user/list")
def list_user_annotations(request: Request):
    """Return the user's saved annotations as JSON — one entry per save event
    (cell + patch), same source as the CSV/GeoJSON export. For the sidebar
    panel to display the real saved annotations (class / method / datetime)."""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        path = handler.get_current_file_path() or ""
        _, denied = authorize_read_or_response(request, path, operation="list annotations")
        if denied is not None:
            return denied
        file_path = handler.get_current_file_path()
        if getattr(handler, 'centroids', None) is None:
            try:
                handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)
            except Exception:
                pass
        events = handler._collect_user_annotation_save_events()
        return success_response({"annotations": events, "total": len(events)})
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[API] list_user_annotations Exception: {e}", exc_info=e)
        traceback.print_exc()
        return error_response(f"Error listing user annotations: {str(e)}", code=500)


@seg_router.get("/v1/classification/metadata")
def classification_metadata(request: Request):
    """Return each classifier's last run time — the model-zoo tasknodes write
    `created_at` (and training/testing times) under
    `<Cell|Patch-Classification>/metadata.attrs`, refreshed every run. Used by
    the sidebar to show the most-recent classification time per layer."""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        file_path = handler.get_current_file_path()
        result = {"cell": None, "patch": None}
        try:
            from app.config.zarr_compat import open_zarr
            zf = open_zarr(file_path, mode='r')
            for key, grp in (("cell", "Cell-Classification"), ("patch", "Patch-Classification")):
                try:
                    if grp in zf and 'metadata' in zf[grp]:
                        meta = dict(zf[grp]['metadata'].attrs)
                        result[key] = {
                            "created_at": meta.get("created_at"),
                            "training_time_sec": meta.get("training_time_sec"),
                            "testing_time_sec": meta.get("testing_time_sec"),
                        }
                except Exception:
                    pass
        except Exception as e:
            try:
                logger.error(f"classification_metadata read failed: {e}", exc_info=True)
            except Exception:
                pass
        return success_response(result)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[API] classification_metadata Exception: {e}", exc_info=e)
        traceback.print_exc()
        return error_response(f"Error reading classification metadata: {str(e)}", code=500)


@seg_router.get("/v1/annotations/export/patch/csv")
def export_patch_classification_csv(request: Request):
    """Export per-patch AI classification results as CSV — the patch
    counterpart of /export/csv (cell classification)."""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _, denied = guard_write_path(request, handler.get_current_file_path() or "", "export annotations")
        if denied is not None:
            return denied

        file_path = handler.get_current_file_path()
        if getattr(handler, 'patch_coordinates', None) is None:
            handler.load_file(file_path, force_reload=False)
        csv_generator = handler.generate_patch_classification_csv_stream(batch_size=5000)

        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = _slide_stem_for_filename(file_path)
        filename = f"{stem}_Patch_Classification_{timestamp}.csv"
        return StreamingResponse(
            csv_generator,
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename={filename}",
                "Cache-Control": "no-cache",
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[API] export_patch_classification_csv Exception: {e}", exc_info=e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error exporting patch CSV: {str(e)}")


@seg_router.get("/v1/annotations/export/patch/geojson")
def export_patch_classification_geojson(
    request: Request,
    batch_size: int = Query(5000, ge=500, le=20000,
                            description="GeoJSON streaming batch size (features per chunk)"),
):
    """Export per-patch AI classification results as GeoJSON (one rectangle
    feature per classified patch)."""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _, denied = guard_write_path(request, handler.get_current_file_path() or "", "export annotations")
        if denied is not None:
            return denied

        file_path = handler.get_current_file_path()
        if getattr(handler, 'patch_coordinates', None) is None:
            handler.load_file(file_path, force_reload=False)
        geojson_generator = handler.generate_patch_classification_geojson_stream(batch_size=batch_size)

        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = _slide_stem_for_filename(file_path)
        filename = f"{stem}_Patch_Classification_{timestamp}.geojson"
        return StreamingResponse(
            geojson_generator,
            media_type="application/geo+json",
            headers={
                "Content-Disposition": f"attachment; filename={filename}",
                "Cache-Control": "no-cache",
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[API] export_patch_classification_geojson Exception: {e}", exc_info=e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error exporting patch GeoJSON: {str(e)}")


@seg_router.get("/v1/patch_classification")
def patch_classification(request: Request):
    """Get patch classification data"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        class_id, class_name, class_hex_color, class_counts = handler.get_patch_classification()

        # The data needs to be wrapped in a 'data' key for the frontend
        response_data = {
            "class_id": class_id,
            "class_name": class_name,
            "class_hex_color": class_hex_color,
            "class_counts": class_counts
        }
        return success_response(response_data)

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.post("/v1/export/classifications")
def export_classifications(
    request: Request,
    format_data: dict = Body({"format": "json"}, description="Export format, supports json or csv")
):
    """Export classification data and return it directly"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _, denied = guard_write_path(request, handler.get_current_file_path() or "", "export classifications")
        if denied is not None:
            return denied

        # Get classification data
        classification_data = handler.get_cell_classification_data()
        if not classification_data:
            return error_response("No classification data available", code=404)

        format = format_data.get("format", "json")

        if format.lower() == "json":
            return success_response(classification_data)
        else:
            return error_response("Unsupported format. Only 'json' format is supported for complex annotation data", code=400)

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        error_trace = traceback.format_exc()
        return error_response({
            "message": f"Error exporting classifications: {str(e)}",
            "details": error_trace
        }, code=500)


@seg_router.post("/v1/export/patch_classification")
def export_patch_classification(
    request: Request,
    format_data: dict = Body({"format": "json"}, description="Export format, supports json or csv")
):
    """Export patch classification data and return it directly"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _, denied = guard_write_path(request, handler.get_current_file_path() or "", "export classifications")
        if denied is not None:
            return denied

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

    except HTTPException:
        raise
    except Exception as e:
        error_trace = traceback.format_exc()
        return error_response({
            "message": f"Error exporting patch classification: {str(e)}",
            "details": error_trace
        }, code=500)


@seg_router.get("/v1/merged_patches")
def merged_patches(
    request: Request,
    x1: float = Query(..., description="Viewport top left x coordinate"),
    y1: float = Query(..., description="Viewport top left y coordinate"),
    x2: float = Query(..., description="Viewport bottom right x coordinate"),
    y2: float = Query(..., description="Viewport bottom right y coordinate")
):
    """get the merged patches annotations in viewport"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        # get and load the current file
        file_path = handler.get_current_file_path()
        if not file_path:
            return error_response("No file path available", code=404)

        # Only load if handler doesn't have data
        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)

        merged_annotations = handler.merge_patches_in_viewport(x1, y1, x2, y2)
        if merged_annotations is None:
            return error_response("No patch data available", code=404)

        return success_response({
            "annotations": list(merged_annotations.values()),
            "count": len(merged_annotations)
        })
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/merged_patches/query")
def patches(
    request: Request,
    x1: float = Query(..., description="Viewport top left x coordinate"),
    y1: float = Query(..., description="Viewport top left y coordinate"),
    x2: float = Query(..., description="Viewport bottom right x coordinate"),
    y2: float = Query(..., description="Viewport bottom right y coordinate")
):
    """get the merged patches in viewport"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        file_path = handler.get_current_file_path()
        if not file_path:
            return error_response("No file path available", code=404)

        # Only load if handler doesn't have data
        if handler.centroids is None:
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
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.post("/v1/merged_patches/process")
def process_patches(request: Request):
    """process all patches and store the merged patches in cache"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        file_path = handler.get_current_file_path()
        if not file_path:
            return error_response("No file path available", code=404)

        handler.process_and_store_merged_patches()

        cache_size = len(handler._merged_patches_cache) if hasattr(handler, '_merged_patches_cache') else 0
        return success_response({
            "message": "Successfully processed and cached patches",
            "cache_size": cache_size
        })
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/patches")
def patches(
    request: Request,
    offset: int = Query(0, description="Start index of patch annotations"),
    limit: Optional[int] = Query(
        None, description="Maximum number of patch annotations to return")):
    """Get patch annotations with pagination"""
    try:
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        path = handler.get_current_file_path() or ""
        _, denied = authorize_read_or_response(request, path, operation="list annotations")
        if denied is not None:
            return denied
        file_path = handler.get_current_file_path()
        # Only load if handler doesn't have data
        if handler.centroids is None:
            handler.load_file(file_path, force_reload=False, reload_segmentation_data=False)
        annotations, total_count = handler.get_patches(offset, limit)
        return success_response({
            "annotations": annotations,
            "count": total_count
        })
    except ValueError as e:
        return error_response(str(e), code=404)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(str(e))


@seg_router.get("/v1/mask_options")
def get_mask_options(request: Request):
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

        # Path-only: mask is read from zarr by file_path (handler unused when path set).
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            _MASK_EXECUTOR,
            get_segmentation_mask,
            None, x1, y1, x2, y2, file_path, target_width, target_height, mask_key
        )

        if not result.get("success"):
            raise HTTPException(status_code=404, detail=result.get("error", "Failed to load mask"))

        # Pack the mask into a binary response (header + data + tissue_class)
        content, response_headers = build_mask_binary_response(result)
        return Response(
            content=content,
            media_type="application/octet-stream",
            headers=response_headers
        )
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error loading mask: {str(e)}")


@seg_router.post("/v1/clear_nuclei_annotations")
def clear_nuclei_annotations(
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
        abs_path = resolve_path(path)
        _, denied = guard_write_path(request, path, "clear annotations")
        if denied is not None:
            return denied
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _ensure_handler_bound(handler, abs_path, need_centroids=True)

        result = clear_nuclei_annotations_in_region(
            handler=handler,
            file_path=abs_path,
            x1=x1, y1=y1, x2=x2, y2=y2,
            polygon_points=polygon_points
        )

        return success_response(result)
    except ValueError as e:
        return error_response(str(e), code=400)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error clearing nuclei annotations: {str(e)}")


@seg_router.post("/v1/clear_tissue_annotations")
def clear_tissue_annotations(
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
        abs_path = resolve_path(path)
        _, denied = guard_write_path(request, path, "clear annotations")
        if denied is not None:
            return denied
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _ensure_handler_bound(handler, abs_path, need_patches=True)

        result = clear_tissue_annotations_in_region(
            handler=handler,
            file_path=abs_path,
            x1=x1, y1=y1, x2=x2, y2=y2,
            polygon_points=polygon_points
        )

        return success_response(result)
    except ValueError as e:
        return error_response(str(e), code=400)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error clearing tissue annotations: {str(e)}")


@seg_router.post("/v1/save_annotation/batch")
def save_annotation_batch(req: dict, request: Request):
    """Batch-mark nuclei/tissue as ground truth; delegates to the seg service
    (mark_nuclei / mark_patches_as_ground_truth_in_region).

    Request body:
      - path: zarr file path
      - annotation_type: 'nuclei' | 'tissue'
      - Region selection: x1, y1, x2, y2 (+ optional polygon_points) — marks
        everything inside the bbox / polygon.
      - Explicit-id selection (nuclei only): cell_indices [int] marks just
        those cells; optional cell_classes {cell_id: class_name} overrides the
        AI prediction for listed cells. This is the path the review panel uses
        — when cell_indices is given the bounding box is unused and not
        required.
    Header: X-Instance-ID (required).
    """
    path = req.get("path", "")
    _, denied = guard_write_path(request, path, "annotate")
    if denied is not None:
        return denied
    instance_id = get_instance_id(request)
    if not instance_id:
        return error_response("X-Instance-ID header is required")
    # guard_write_path covers the path; this covers the session it runs through.
    denied = guard_instance_owner(request, instance_id, "save batch annotation")
    if denied is not None:
        return denied
    try:
        result = save_annotation_batch_service(instance_id, req)
        return success_response(result)
    except ValueError as e:
        return error_response(str(e))


@seg_router.post("/v1/save_patch_annotations")
def save_patch_annotations(
    request: Request,
    path: str = Body(..., description="Path to the zarr file"),
    patch_indices: List[int] = Body(..., description="Patch ids to mark as ground truth"),
    patch_classes: Optional[dict] = Body(None, description="{patch_id: class_name} explicit-class overrides (review 'No')"),
    annotator: str = Body("Unknown", description="The user who marked these patches"),
):
    """Mark specific patches as ground-truth user annotations (patch review save)."""
    try:
        _, denied = guard_write_path(request, path, "annotate")
        if denied is not None:
            return denied
        abs_path = as_zarr_path(resolve_path(path))
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _ensure_handler_bound(handler, abs_path, need_patches=True)
        result = mark_patches_as_ground_truth(
            handler=handler,
            annotator=annotator,
            file_path=abs_path,
            patch_indices=patch_indices,
            patch_classes=patch_classes,
        )
        return success_response(result)
    except ValueError as e:
        return error_response(str(e), code=400)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error saving patch annotations: {str(e)}")


@seg_router.post("/v1/remove_patch_annotations")
def remove_patch_annotations_endpoint(
    request: Request,
    path: str = Body(..., description="Path to the zarr file"),
    patch_indices: List[int] = Body(..., description="Patch ids to remove"),
):
    """Remove specific patches' user annotations (patch review remove)."""
    try:
        _, denied = guard_write_path(request, path, "annotate")
        if denied is not None:
            return denied
        abs_path = as_zarr_path(resolve_path(path))
        handler, denied = _get_owned_handler(request)
        if denied is not None:
            return denied
        _ensure_handler_bound(handler, abs_path, need_patches=True)
        result = remove_patch_annotations(
            handler=handler,
            file_path=abs_path,
            patch_indices=patch_indices,
        )
        return success_response(result)
    except ValueError as e:
        return error_response(str(e), code=400)
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error removing patch annotations: {str(e)}")


def _classifier_file_guard_write(request: Request, path_raw: str):
    if not path_raw or not str(path_raw).strip():
        return error_response("path is required", code=400)
    _, denied = guard_write_path(request, path_raw, "write classifier")
    if denied is not None:
        return denied
    return None


@seg_router.get("/v1/classifier_file/load")
def load_classifier_file(
    request: Request,
    file_path: str = Query(..., description="Classifier file path (storage-relative or absolute); resolved via resolve_path"),
):
    """
    Load classifier file bytes from server storage (stepwise workflows; no JSON metadata).
    Returns raw bytes as application/octet-stream. 404 if file does not exist.

    Read ACL only — Viewer/Samples shared workflows must still be able to open
    an already-bound ``.tlcls``. Saving back to a shared path stays on
    ``guard_write_path``.
    """
    if not file_path or not str(file_path).strip():
        return error_response("file_path is required", code=400)
    abs_path, denied = authorize_read_or_response(request, file_path, operation="load classifier")
    if denied is not None:
        return denied
    if not os.path.isfile(abs_path):
        return error_response("Classifier file not found", code=404)
    return FileResponse(
        abs_path,
        filename=os.path.basename(abs_path),
        media_type="application/octet-stream",
    )


@seg_router.post("/v1/classifier_file/save")
def save_classifier_file(request: Request, body: dict = Body(...)):
    """
    Save classifier file on the server (stepwise workflows; no JSON sidecar).

    Body (JSON):
      - path | dest_path | classifier_path: destination file path (required)
      - copy_from_path (optional): if set, copy this server-side path to destination.
      - content_base64 (optional): raw file bytes; used only when copy_from_path is absent.
      - fail_if_exists (optional): if true, return wrapped error code 409 instead of overwriting.

    Parent directories are created as needed.
    """
    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    dest_raw = body.get("path") or body.get("dest_path") or body.get("classifier_path")
    err = _classifier_file_guard_write(request, dest_raw or "")
    if err is not None:
        return err

    dest_abs = resolve_path(dest_raw)
    if body.get("fail_if_exists") and os.path.isfile(dest_abs):
        # An empty 0-byte file is the placeholder this same endpoint writes when
        # the Save flow gets interrupted before training writes the real model.
        # Treat it as "not there" — the user clicking Save again should be able
        # to reclaim that name rather than suffixing.
        try:
            existing_size = os.path.getsize(dest_abs)
        except OSError:
            existing_size = -1
        if existing_size > 0:
            # Name taken by a real file: auto-suffix "name(1).tlcls", "name(2)…"
            # (mirrors the file-upload dedupe) instead of failing. Reflect the
            # chosen name back into dest_raw so the caller records the real path.
            base_abs, ext = os.path.splitext(dest_abs)
            counter = 1
            while True:
                cand = f"{base_abs}({counter}){ext}"
                try:
                    if (not os.path.isfile(cand)) or os.path.getsize(cand) == 0:
                        break
                except OSError:
                    break
                counter += 1
            dest_abs = cand
            _parent = os.path.dirname(dest_raw)
            _newname = os.path.basename(dest_abs)
            dest_raw = f"{_parent}/{_newname}" if _parent else _newname
    parent = os.path.dirname(dest_abs)
    os.makedirs(parent, exist_ok=True)

    copy_from = body.get("copy_from_path") or body.get("source_path")
    empty_if_missing = body.get("empty_if_missing_source", True)
    if copy_from:
        _, denied = authorize_read_or_response(
            request, str(copy_from), operation="read classifier"
        )
        if denied is not None:
            return denied
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
    except HTTPException:
        raise
    except Exception as e:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except Exception:
            pass
        logger.exception("classifier_file save failed")
        return error_response(f"Failed to write classifier file: {e}", code=500)

    return success_response({"path": dest_raw, "size": len(data), "mode": "bytes"})


@seg_router.post("/v1/classifier_file/model_names")
def classifier_file_model_names(request: Request, body: dict = Body(...)):
    """Read the `model_name` booster attribute from one or more .tlcls files so
    the UI can filter local classifiers by the model they were trained on
    (MuskClassification / HOptimusClassification / VirchowClassification / …).
    Untagged, empty, or unreadable files map to "" — callers treat that as a
    placeholder that's loadable on any node.

    Also reads the `inherit_from` attribute (stamped by ctrl-service when a
    community classifier is downloaded, and preserved across retrain by the
    tasknodes' save_classifier_params). Surfaced so the UI can recognize a
    locally-loaded / shared .tlcls as descending from a community model and
    offer republish — even when it was never loaded through the community list.

    Body:    {"paths": ["users/.../a.tlcls", ...]}
    Returns: {"models":  {"<path>": "<model_name or ''>", ...},
              "inherit": {"<path>": {"community_id": "...", ...} | None, ...}}
    """
    paths = body.get("paths")
    if not isinstance(paths, list):
        return error_response("paths must be a list", code=400)
    out: dict = {}
    inherit: dict = {}
    for p in paths:
        if not isinstance(p, str) or not p.strip():
            continue
        _, denied = authorize_read_or_response(request, p, operation="load classifier")
        if denied is not None:
            return denied
        model_name = ""
        inherit_from = None
        try:
            if p.lower().endswith(".tlcls"):
                abs_path = resolve_path(p)
                if (
                    os.path.isfile(abs_path)
                    and 0 < os.path.getsize(abs_path) <= 50 * 1024 * 1024
                ):
                    import xgboost as xgb
                    clf = xgb.XGBClassifier()
                    clf.load_model(abs_path)
                    _booster = clf.get_booster()
                    model_name = (_booster.attr("model_name") or "").strip()
                    _inh = _booster.attr("inherit_from")
                    if _inh:
                        try:
                            inherit_from = json.loads(_inh)
                        except Exception:
                            inherit_from = None
        except Exception:
            model_name = ""  # untagged / unreadable → treat as placeholder
            inherit_from = None
        out[p] = model_name
        inherit[p] = inherit_from
    return success_response({"models": out, "inherit": inherit})


@seg_router.post("/v1/classifier_tasknode_save")
def classifier_tasknode_save(request: Request, body: dict = Body(...)):
    """
    Ask the NuClass or MUSK tasknode to save its last in-memory trained classifier to disk.

    Body JSON:
      - node_name: "Cell-Classification" | "MuskClassification" (required)
      - dest_path | path: destination path, resolved via resolve_path (required)
    """
    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    node_name = (body.get("node_name") or "").strip()
    dest_raw = body.get("dest_path") or body.get("path")
    if node_name not in ("Cell-Classification", "MuskClassification"):
        return error_response("node_name must be ClassificationNode or MuskClassification", code=400)
    err = _classifier_file_guard_write(request, dest_raw or "")
    if err is not None:
        return err
    dest_abs = resolve_path(dest_raw)
    parent = os.path.dirname(dest_abs)
    if parent:
        os.makedirs(parent, exist_ok=True)

    base_url = resolve_classifier_tasknode_url(node_name)
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
