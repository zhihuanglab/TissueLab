from fastapi import APIRouter, Request, HTTPException, Query, Body, UploadFile, File, Form
from typing import Optional, List
import asyncio
import os
import traceback
from app.core.response import permission_denied_response, success_response
from app.core.access import (
    assert_user_owned_path_or_response,
    assert_user_owned_path_or_response_async,
    authorize_read_or_response,
    authorize_read_or_response_async,
    guard_write_path,
    guard_write_path_async,
    sanitize_client_path,
)
from app.services.seg import get_file_path, SegmentationHandler
from app.utils import resolve_path
from app.config.zarr_compat import as_zarr_path
from app.services.seg_registry import iter_annotation_handlers
from app.core.executors import zarr_structure_executor
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
    get_zarr_file_info_service,
    ensure_annotation_array_path,
    apply_annotation_class_update_to_handler,
    list_zarr_contents_service,
    search_zarr_objects,
    analyze_zarr_file_service,
    validate_zarr_file_service,
    validate_zarr_replacement_service,
    apply_zarr_replacement_service,
    zarr_staging_base,
    find_zarr_root,
    cleanup_zarr_staging,
    write_staged_zarr_upload,
    resolve_staged_zarr_root,
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
async def convert_h5_to_zarr_endpoint(payload: H5ToZarrConversionRequest, request: Request):
    """Convert an H5/HDF5 file to Zarr format."""
    try:
        if payload.source_path:
            _, denied = await authorize_read_or_response_async(
                request, payload.source_path, operation="read conversion source"
            )
            if denied is not None:
                return denied
        write_path = payload.target_path or payload.source_path
        if write_path:
            _, denied = await guard_write_path_async(request, write_path, "convert data")
            if denied is not None:
                return denied
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
def get_conversion_status(job_id: str):
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
def get_zarr_file_info(request: Request):
    """Get information about the Zarr file"""
    try:
        file_path = get_file_path(request)
        _, denied = authorize_read_or_response(request, file_path, operation="inspect Zarr data")
        if denied is not None:
            return denied
        validate_file_path_and_security(file_path)
        info = get_zarr_file_info_service(file_path)
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
    max_depth: int = Query(-1, description="Maximum depth to traverse (-1 for unlimited)"),
    include_disk_size: bool = Query(
        False,
        description="Report each array's on-disk size. Off by default: it stats "
                    "every chunk file, which dominates the call.",
    )
):
    """Get Zarr file structure"""
    try:
        file_path = get_file_path(request)
        _, denied = await authorize_read_or_response_async(request, file_path, operation="read Zarr structure")
        if denied is not None:
            return denied
        validate_file_path_and_security(file_path)

        # Blocking zarr I/O — keep the async event loop free for concurrent badge reads.
        loop = asyncio.get_running_loop()
        structure = await loop.run_in_executor(
            zarr_structure_executor,
            lambda: get_file_structure(file_path, path, include_attributes,
                                       max_depth, include_disk_size),
        )

        return success_response(structure)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting structure: {str(e)}")


@data_router.get("/v1/groups/{group_path:path}")
def get_zarr_group_info(
    request: Request,
    group_path: str,
    include_arrays: bool = Query(True, description="Include arrays in group"),
    include_subgroups: bool = Query(True, description="Include subgroups")
):
    """Get group information"""
    try:
        file_path = get_file_path(request)
        _, denied = authorize_read_or_response(request, file_path, operation="read Zarr group")
        if denied is not None:
            return denied
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


# Registered BEFORE the generic ``/v1/arrays/{array_path:path}`` route: that
# ``:path`` converter is greedy and would otherwise swallow ``.../data`` (the
# request then looked up an array literally named ``<array>/data`` → 404).
@data_router.get("/v1/arrays/{array_path:path}/data")
def read_zarr_array_data(
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
        sliced = bool((start_indices or "").strip() and (end_indices or "").strip())
        if sliced:
            _, denied = authorize_read_or_response(
                request, file_path, operation="read Zarr array slice"
            )
        else:
            _, denied = guard_write_path(request, file_path, "extract Zarr array data")
        if denied is not None:
            return denied
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


@data_router.get("/v1/arrays/{array_path:path}")
def get_zarr_array_info(
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
        _, denied = authorize_read_or_response(request, file_path, operation="read Zarr array")
        if denied is not None:
            return denied
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
def delete_nuclei_annotation_endpoint(
    request: Request,
    array_path: str,
    cell_id: int
):
    """Delete a single nuclei annotation by cell_id"""
    try:
        file_path = get_file_path(request)
        _, denied = guard_write_path(request, file_path, "delete Zarr annotation")
        if denied is not None:
            return denied
        validate_file_path_and_security(file_path)

        array_path = ensure_annotation_array_path(array_path)

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
def update_nuclei_annotation_class_endpoint(
    request: Request,
    array_path: str,
    cell_id: int,
    new_class_name: str = Body(..., embed=True)
):
    """Update the cell_class for a single nuclei or tissue annotation"""
    try:
        file_path = get_file_path(request)
        _, denied = guard_write_path(request, file_path, "update Zarr annotation")
        if denied is not None:
            return denied
        validate_file_path_and_security(file_path)

        array_path = ensure_annotation_array_path(array_path)

        result = update_nuclei_annotation_class(file_path, array_path, cell_id, new_class_name)

        if not result.get("success", False):
            raise HTTPException(status_code=400, detail=result.get("message", "Failed to update annotation"))

        # Keep in-memory handlers consistent for WebSocket reads (path-keyed refresh).
        for _, handler in iter_annotation_handlers():
            if handler and SegmentationHandler._same_zarr_path(
                getattr(handler, "zarr_file", None), file_path
            ):
                apply_annotation_class_update_to_handler(handler, array_path, cell_id, new_class_name)

        return success_response(result)

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error updating annotation: {str(e)}")


@data_router.get("/v1/objects/{object_path:path}/attributes")
def get_zarr_object_attributes(
    request: Request,
    object_path: str,
    attribute_name: Optional[str] = Query(None, description="Specific attribute name")
):
    """Get object attributes"""
    try:
        file_path = get_file_path(request)
        _, denied = authorize_read_or_response(request, file_path, operation="read Zarr attributes")
        if denied is not None:
            return denied
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
def list_zarr_contents(
    request: Request,
    group_path: str = Query("/", description="Group path to list"),
    recursive: bool = Query(False, description="Recursive listing"),
    object_type: Optional[str] = Query(None, description="Filter by object type (group/array)")
):
    """List file contents"""
    try:
        file_path = get_file_path(request)
        _, denied = authorize_read_or_response(request, file_path, operation="list Zarr contents")
        if denied is not None:
            return denied
        validate_file_path_and_security(file_path)

        contents = list_zarr_contents_service(file_path, group_path, recursive, object_type)

        return success_response(contents)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error listing contents: {str(e)}")


@data_router.get("/v1/search")
def search_zarr_objects_endpoint(
    request: Request,
    query: str = Query(..., description="Search query"),
    object_type: Optional[str] = Query(None, description="Filter by object type (group/array)"),
    search_attributes: bool = Query(False, description="Search in attributes"),
    case_sensitive: bool = Query(False, description="Case sensitive search")
):
    """Search objects"""
    try:
        file_path = get_file_path(request)
        _, denied = authorize_read_or_response(request, file_path, operation="search Zarr data")
        if denied is not None:
            return denied
        validate_file_path_and_security(file_path)

        results = search_zarr_objects(file_path, query, object_type, search_attributes, case_sensitive)

        return success_response(results)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error searching objects: {str(e)}")


@data_router.get("/v1/analyze")
def analyze_zarr_file(
    request: Request,
    include_statistics: bool = Query(True, description="Include data statistics"),
    sample_size: int = Query(1000, description="Sample size for analysis")
):
    """Analyze Zarr file"""
    try:
        file_path = get_file_path(request)
        _, denied = authorize_read_or_response(request, file_path, operation="analyze Zarr data")
        if denied is not None:
            return denied
        validate_file_path_and_security(file_path)

        analysis = analyze_zarr_file_service(file_path, include_statistics, sample_size)

        return success_response(analysis)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error analyzing file: {str(e)}")


@data_router.get("/v1/validate")
def validate_zarr_file_endpoint(request: Request):
    """Validate Zarr file"""
    try:
        file_path = get_file_path(request)

        if not file_path:
            raise HTTPException(status_code=400, detail="No file path provided")

        _, denied = authorize_read_or_response(request, file_path, operation="validate Zarr data")
        if denied is not None:
            return denied
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


@data_router.post("/v1/zarr/validate_replacement")
async def validate_zarr_replacement_endpoint(request: Request):
    """Validate a user-supplied .zarr as a whole-sidecar replacement for a slide.

    Body: {candidate_path: str (the user's .zarr), target_slide_path: str (the WSI,
    used to read its pixel dimensions for the coordinate-bounds check)}.
    Returns {ok, errors[], warnings[], summary}. Errors block; warnings are advisory.
    """
    try:
        body = await request.json()
        candidate = (body.get("candidate_path") or "").strip()
        target_slide = (body.get("target_slide_path") or "").strip()
        if not candidate:
            raise HTTPException(status_code=400, detail="candidate_path is required")

        owned_candidate, denied = await assert_user_owned_path_or_response_async(
            request, candidate, "validate Zarr replacement"
        )
        if denied is not None:
            return denied
        if target_slide:
            _, denied = await guard_write_path_async(request, target_slide, "validate Zarr replacement")
            if denied is not None:
                return denied
        validate_file_path_and_security(owned_candidate)
        cand = owned_candidate
        # NB: the target is the SLIDE (.svs/.ndpi/…), not a .zarr — so we don't run
        # the zarr-only file check on it; we just resolve it to read its dimensions.
        slide = resolve_path(target_slide) if target_slide else None

        # Opens the candidate store — filesystem work, off the loop.
        result = await asyncio.to_thread(validate_zarr_replacement_service, cand, slide)
        return success_response(result)

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error validating replacement: {str(e)}")


@data_router.post("/v1/zarr/replace")
async def replace_zarr_endpoint(request: Request):
    """Replace a slide's sidecar .zarr with a user-supplied one (crash-safe swap).

    Body: {candidate_path: str, target_slide_path: str}. Re-validates first and
    refuses on any error, so the target is untouched unless the candidate is valid.
    The user's source is copied, never moved. Callers should reload the slide after.
    """
    try:
        body = await request.json()
        candidate = (body.get("candidate_path") or "").strip()
        target_slide = (body.get("target_slide_path") or "").strip()
        if not candidate or not target_slide:
            raise HTTPException(status_code=400, detail="candidate_path and target_slide_path are required")

        owned_candidate, denied = await assert_user_owned_path_or_response_async(
            request, candidate, "replace Zarr data"
        )
        if denied is not None:
            return denied
        _, denied = await guard_write_path_async(request, target_slide, "replace Zarr data")
        if denied is not None:
            return denied
        validate_file_path_and_security(owned_candidate)
        cand = owned_candidate
        # The target is the SLIDE (.svs/.ndpi/…), not a .zarr — so no zarr-only check.
        slide = resolve_path(target_slide)
        # Sidecar convention: "<slide>.zarr" (unless the path already ends in .zarr).
        target_zarr = as_zarr_path(slide)

        # Off the loop: this walks and rewrites the whole store on disk.
        result = await asyncio.to_thread(
            apply_zarr_replacement_service, cand, target_zarr, slide
        )
        return success_response(result)

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error replacing Zarr: {str(e)}")


@data_router.post("/v1/zarr/stage_candidate")
async def stage_zarr_candidate_endpoint(
    request: Request,
    files: List[UploadFile] = File(...),
    relative_paths: Optional[str] = Form(None),
    staging_id: Optional[str] = Form(None),
    finalize: Optional[str] = Form(None),
    target_path: Optional[str] = Form(None),
):
    """Receive an uploaded replacement candidate into a server staging dir. A .zip
    goes in one call. A dragged/selected folder is uploaded in BATCHES (a zarr has
    thousands of chunk files, over the per-request multipart limit): the first call
    omits staging_id and gets one back; later calls pass it to append; the last call
    passes finalize=true. Only the finalizing call resolves + returns staging_path.
    Caller must call cleanup_staging when done."""
    import uuid as _uuid
    import json as _json

    effective_target = target_path
    if not effective_target:
        try:
            from app.services.load import sessions, session_lock
            from app.utils.common.request import get_instance_id

            instance_id = get_instance_id(request)
            with session_lock:
                effective_target = (
                    sessions.get(instance_id, {}).get("current_file_path")
                    if instance_id else None
                )
        except Exception:
            effective_target = None
    if not effective_target:
        return permission_denied_response(
            access_mode="forbidden",
            operation="stage Zarr replacement",
            request_id=request.headers.get("X-Request-ID"),
            error_code="TARGET_CONTEXT_REQUIRED",
        )
    _, denied = await guard_write_path_async(request, effective_target, "stage Zarr replacement")
    if denied is not None:
        return denied
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    is_zip = len(files) == 1 and (files[0].filename or "").lower().endswith(".zip")
    do_finalize = is_zip or (str(finalize or "").lower() in ("1", "true", "yes"))

    sid = (staging_id or "").strip()
    created = False
    try:
        # Resolve staging dir: reuse across batches, or create a fresh one. Kept
        # inside the try so a non-writable storage root surfaces a real error
        # (not a CORS-less generic 500).
        base = zarr_staging_base()
        if sid:
            if os.sep in sid or sid in (".", ".."):
                raise HTTPException(status_code=400, detail="Invalid staging_id")
            staging_dir = os.path.join(base, sid)
            if not os.path.isdir(staging_dir):
                raise HTTPException(status_code=400, detail="Unknown staging_id (expired?)")
        else:
            sid = _uuid.uuid4().hex
            staging_dir = os.path.join(base, sid)
            os.makedirs(staging_dir, exist_ok=True)
            created = True

        rels: List[str] = []
        if not is_zip:
            rels = _json.loads(relative_paths) if relative_paths else []
            if len(rels) != len(files):
                rels = [f.filename or f"file_{i}" for i, f in enumerate(files)]

        # Writing the batch out (a zip expanded, or thousands of chunk files)
        # and the .DS_Store walk are both long blocking IO — a multi-GB candidate
        # would otherwise hold the event loop for the whole upload.
        search_root = await asyncio.to_thread(
            write_staged_zarr_upload, staging_dir, files, rels, is_zip=is_zip
        )

        # More batches coming — just acknowledge, don't resolve yet.
        if not do_finalize:
            return success_response({"staging_id": sid})

        zroot = await asyncio.to_thread(resolve_staged_zarr_root, search_root)
        if not zroot:
            await asyncio.to_thread(cleanup_zarr_staging, sid)
            raise HTTPException(status_code=400, detail="No Zarr store (zarr.json/.zgroup) found in the upload.")

        return success_response({"staging_id": sid, "staging_path": zroot})

    except HTTPException:
        raise
    except Exception as e:
        # Only tear down staging on the finalize call or if we created it now;
        # a mid-batch failure shouldn't discard earlier batches silently.
        if do_finalize or created:
            await asyncio.to_thread(cleanup_zarr_staging, sid)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error staging candidate: {str(e)}")


@data_router.post("/v1/zarr/cleanup_staging")
async def cleanup_zarr_staging_endpoint(request: Request):
    """Delete a staging dir created by stage_candidate. Body: {staging_id}."""
    try:
        body = await request.json()
        staging_id = (body.get("staging_id") or "").strip()
        if staging_id:
            # Off the loop: rmtree of a staging dir holding an uploaded zarr,
            # which is one file per chunk.
            await asyncio.to_thread(cleanup_zarr_staging, staging_id)
        return success_response({"ok": True})
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error cleaning staging: {str(e)}")


@data_router.get("/v1/version")
def get_zarr_version():
    """Get Zarr version information"""
    try:
        version_info = get_zarr_version_info()
        return success_response(version_info)

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting version info: {str(e)}")


##### Enhanced Analysis Endpoints #####

@data_router.get("/v1/enhanced/analysis")
def get_enhanced_file_analysis(request: Request):
    """Get enhanced file analysis combining segmentation and Zarr analysis"""
    try:
        file_path = get_file_path(request)
        _, denied = authorize_read_or_response(request, file_path, operation="analyze Zarr data")
        if denied is not None:
            return denied
        validate_file_path_and_security(file_path)

        analysis = enhanced_file_analysis_service(file_path)

        return success_response(analysis)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error getting enhanced analysis: {str(e)}")


@data_router.get("/v1/enhanced/search_arrays")
def search_segmentation_arrays(
    request: Request,
    query: str = Query(..., description="Search query"),
    include_segmentation: bool = Query(True, description="Include segmentation-related keywords")
):
    """Search for segmentation-related arrays"""
    try:
        file_path = get_file_path(request)
        _, denied = authorize_read_or_response(request, file_path, operation="search Zarr arrays")
        if denied is not None:
            return denied
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
def get_batch_array_info(
    request: Request,
    array_paths: List[str] = Body(..., description="List of array paths"),
    include_preview: bool = Body(False, description="Include preview for each array")
):
    """Get array information in batch"""
    try:
        file_path = get_file_path(request)
        if include_preview:
            _, denied = guard_write_path(
                request, file_path, "extract Zarr array previews in batch"
            )
        else:
            _, denied = authorize_read_or_response(
                request, file_path, operation="read Zarr array info in batch"
            )
        if denied is not None:
            return denied
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
def export_zarr_structure(
    request: Request,
    export_path: str = Body(..., description="Export file path"),
    format: str = Body("json", description="Export format (json/yaml)"),
    include_attributes: bool = Body(True, description="Include object attributes"),
    max_depth: int = Body(-1, description="Maximum depth to export (-1 for unlimited)")
):
    """Export Zarr file structure"""
    try:
        file_path = get_file_path(request)
        _, denied = guard_write_path(request, file_path, "export Zarr structure")
        if denied is not None:
            return denied
        owned_export, denied = assert_user_owned_path_or_response(
            request, export_path, "export Zarr structure"
        )
        if denied is not None:
            return denied
        validate_file_path_and_security(file_path)

        result = export_zarr_structure_service(
            file_path, owned_export, format, include_attributes, max_depth
        )
        if isinstance(result, dict) and result.get("export_path"):
            result = {**result, "export_path": sanitize_client_path(result.get("export_path"))}

        return success_response(result)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error exporting structure: {str(e)}")
