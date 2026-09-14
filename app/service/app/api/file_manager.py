"""File manager HTTP API — thin routes over file_manager submodules.

Ported from the TissueLab control plane. Sharing / collaboration routes are
not part of the open edition (single local user).
"""
import os
import shutil
import threading
import asyncio
from fastapi import APIRouter, Form, Body, Query, File, UploadFile, Depends, Request, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Dict, Any, Optional

from app.core.auth import AuthUser, get_auth_user, get_optional_auth_user
from app.core.errors import AppError, AppErrors
from app.core.logger import logger
from app.services.file_manager.schemas import (
    CompressRequest,
    CopyToPersonalRequest,
    DecompressRequest,
    DeleteRequest,
    FileOperationRequest,
    MoveRequest,
    RefreshMetadataRequest,
)
from app.services.file_manager import files as fm_files
from app.services.file_manager import upload as fm_upload
from app.services.file_manager import tasks as fm_tasks
from app.services.file_manager.common import (
    assert_can_access_path_async,
    assert_can_write_path_async,
    assert_user_owned_path_async,
    gather_guards,
    normalize_rel_path,
    validate_user_access_to_path,
)
from app.config.path_config import is_public_read_only_path
from app.services import zarr_replace
from app.utils import resolve_path

file_manager_router = APIRouter()

@file_manager_router.get("/v1/config")
async def get_config(auth_user: AuthUser | None = Depends(get_optional_auth_user)):
    return await fm_files.get_config(auth_user)

@file_manager_router.get("/v1/files")
async def list_files(
    path: str = Query(""),
    offset: int = Query(0, ge=0, description="First row of the page (ignored without `limit`)."),
    limit: Optional[int] = Query(
        None,
        ge=0,
        le=5000,
        description=(
            "Page size. Set it to get {items, pagination} with filtering, zarr "
            "grouping, sorting and slicing already applied server-side. Omit it "
            "for a bare array of the whole directory — still the right call for "
            "consumers that need every row (upload conflict detection, the "
            "viewer's folder browsers), so it is a supported shape rather than a "
            "deprecated one."
        ),
    ),
    sort_by: str = Query("mtime", pattern="^(name|mtime|size|type)$"),
    sort_dir: str = Query("desc", pattern="^(asc|desc)$"),
    include_non_image: bool = Query(True, description="False keeps only folders, WSI and zarr rows."),
    group_zarr: bool = Query(False, description="Fold each .zarr store into its WSI row as attachedZarrPath."),
    dirs_only: bool = Query(False, description="Navigable folders only (move-to destination picker)."),
    auth_user: AuthUser | None = Depends(get_optional_auth_user),
):
    return await fm_files.list_files(
        path,
        auth_user,
        offset=offset,
        limit=limit,
        sort_by=sort_by,
        sort_dir=sort_dir,
        include_non_image=include_non_image,
        group_zarr=group_zarr,
        dirs_only=dirs_only,
    )

@file_manager_router.post("/v1/files/download-link")
async def create_download_link_endpoint(path: str = Query(..., description="Relative path from storage root"), auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_files.create_download_link_endpoint(path, auth_user)

@file_manager_router.post("/v1/files/view-link")
async def create_view_link_endpoint(
    path: str = Query(..., description="Relative path from storage root"),
    auth_user: AuthUser = Depends(get_auth_user),
):
    """In-viewer load token (read ACL). Radiology formats only — not an extract download."""
    return await fm_files.create_view_link_endpoint(path, auth_user)

@file_manager_router.get("/v1/files/download/{token}")
async def download_file_direct(token: str, request: Request):
    return await fm_files.download_file_direct(token, request)

@file_manager_router.get("/v1/files/search", response_model=List[Dict[str, Any]])
async def search_files(
    query: str = Query(..., description="The search term."),
    scope: Optional[str] = Query(
        None,
        description=(
            "Optional relative path the search is restricted to. When the "
            "user is browsing a subfolder the client passes that path here so "
            "results stay scoped to what's visible. Falls back to the broad "
            "accessible-paths search when omitted."
        ),
    ),
    auth_user: AuthUser | None = Depends(get_optional_auth_user),
):
    return await fm_files.search_files(query, scope, auth_user)

@file_manager_router.post("/v1/files/create")
async def create_item(req: FileOperationRequest, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_files.create_item(req, auth_user)

@file_manager_router.post("/v1/files/rename")
async def rename_item(req: FileOperationRequest, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_files.rename_item(req, auth_user)

@file_manager_router.post("/v1/files/delete")
async def delete_items(req: DeleteRequest, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_tasks.delete_items(req, auth_user)

@file_manager_router.post("/v1/files/move")
async def move_items(req: MoveRequest, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_files.move_items(req, auth_user)

@file_manager_router.post("/v1/files/copy-to-personal")
async def copy_file_to_personal(req: CopyToPersonalRequest, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_files.copy_file_to_personal(req, auth_user)

@file_manager_router.post("/v1/folders/copy-to-personal")
async def copy_folder_to_personal(req: CopyToPersonalRequest, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_files.copy_folder_to_personal(req, auth_user)

@file_manager_router.post("/v1/files/upload")
async def upload_files(
    path: str = Form(""),
    files: List[UploadFile] = File(...),
    overwrite: bool = Form(False),
    relative_paths: Optional[str] = Form(None),
    keep_both: bool = Form(False),
    auth_user: AuthUser = Depends(get_auth_user)
):
    return await fm_upload.upload_files(path, files, overwrite, relative_paths, keep_both, auth_user)

@file_manager_router.post("/v1/files/upload/manifest")
async def upload_manifest(
    payload: Dict[str, Any] = Body(...),
    auth_user: AuthUser = Depends(get_auth_user),
):
    return await fm_upload.upload_manifest(payload, auth_user)

@file_manager_router.post("/v1/files/upload/zarr-batch")
async def upload_zarr_batch(request: Request, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_upload.upload_zarr_batch(request, auth_user)

@file_manager_router.delete("/v1/files/upload/zarr-batch/{upload_id}")
async def cancel_zarr_batch_upload(upload_id: str, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_upload.cancel_zarr_batch_upload(upload_id, auth_user)

@file_manager_router.post("/v1/files/upload/init")
async def init_chunked_upload(
    filename: str = Form(...),
    total_size: int = Form(...),
    path: str = Form(""),
    chunk_size: int = Form(2 * 1024 * 1024),
    overwrite: bool = Form(False),
    relative_path: Optional[str] = Form(None),
    keep_both: bool = Form(False),
    auth_user: AuthUser = Depends(get_auth_user)
):
    return await fm_upload.init_chunked_upload(filename, total_size, path, chunk_size, overwrite, relative_path, keep_both, auth_user)

@file_manager_router.post("/v1/files/upload/chunk")
async def upload_chunk(
    upload_id: str = Form(...),
    chunk_index: int = Form(...),
    chunk_data: UploadFile = File(...),
    auth_user: AuthUser = Depends(get_auth_user)
):
    return await fm_upload.upload_chunk(upload_id, chunk_index, chunk_data, auth_user)

@file_manager_router.post("/v1/files/upload/complete")
async def complete_chunked_upload(
    request: Request,
    upload_id: Optional[str] = Form(None),
    auth_user: AuthUser = Depends(get_auth_user),
):
    """Finalize an upload session (dual-mode endpoint).

    **Mode 1 — regular chunked upload:** ``multipart/form-data`` with
    ``upload_id``. Merges all uploaded chunks into the destination file.

    **Mode 2 — zarr batch upload:** ``application/json`` body with
    ``upload_type: "zarr-batch"`` plus ``upload_id``, ``path``, and
    ``total_batches``. Validates all batches were received and finalizes the
    .zarr tree on disk.
    """
    return await fm_upload.complete_chunked_upload(request, upload_id, auth_user)

@file_manager_router.get("/v1/files/upload/status/{upload_id}")
async def get_upload_status(upload_id: str, auth_user: AuthUser = Depends(get_auth_user)):
    return await asyncio.to_thread(fm_upload.get_upload_status, upload_id, auth_user)

@file_manager_router.delete("/v1/files/upload/cancel/{upload_id}")
async def cancel_chunked_upload(upload_id: str, auth_user: AuthUser = Depends(get_auth_user)):
    return await asyncio.to_thread(fm_upload.cancel_chunked_upload, upload_id, auth_user)

@file_manager_router.get("/v1/files/access")
async def get_file_access(path: str = Query(...), auth_user: AuthUser = Depends(get_auth_user)):
    """Lightweight ACL peek for an open slide (``shareMode`` / ``readOnly``).

    There are no shares in the open edition, so ``shareMode`` is always ``None``
    and ``readOnly`` is true only for the public Samples area.
    """
    try:
        rel_path = normalize_rel_path(path)

        def _resolve():
            if not validate_user_access_to_path(auth_user, rel_path):
                raise AppErrors.USER_FORBIDDEN()
            return bool(is_public_read_only_path(rel_path))

        read_only = await asyncio.to_thread(_resolve)
        return JSONResponse(content={
            'path': rel_path,
            'shareMode': None,
            'readOnly': read_only,
        })
    except (HTTPException, AppError):
        raise
    except Exception as e:
        logger.error(f"Error getting file access for {path}: {e}", exc_info=True)
        raise AppErrors.SERVER_INTERNAL_ERROR()

@file_manager_router.post("/v1/files/compress")
async def compress_items(payload: CompressRequest, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_tasks.compress_items(payload, auth_user)

@file_manager_router.post("/v1/files/decompress")
async def decompress_zip(payload: DecompressRequest, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_tasks.decompress_zip(payload, auth_user)

@file_manager_router.get("/v1/files/task_status/{task_id}")
async def get_task_status(task_id: str, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_tasks.get_task_status(task_id, auth_user)

@file_manager_router.get("/v1/files/task_status/{task_id}/stream")
async def stream_task_status(task_id: str, request: Request):
    return await fm_tasks.stream_task_status(task_id, request)

@file_manager_router.post("/v1/files/refresh-metadata")
async def refresh_file_metadata(req: RefreshMetadataRequest, auth_user: AuthUser = Depends(get_auth_user)):
    return await fm_files.refresh_file_metadata(req, auth_user)


# ── Whole-.zarr replacement (upload your own preprocessing, incl. nuclei seg) ──
# The candidate is uploaded via /v1/files/upload into a staging folder under the
# user's own dir; these two routes validate it against the slide, then swap it in.

def _slide_wh_from_payload(payload: Dict[str, Any]):
    sw, sh = payload.get("slide_width"), payload.get("slide_height")
    try:
        if sw and sh:
            return (int(sw), int(sh))
    except (TypeError, ValueError):
        pass
    return None


def _rmtree_later(*paths: str) -> None:
    def _run():
        for p in paths:
            if p and os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
    threading.Thread(target=_run, daemon=True).start()


@file_manager_router.post("/v1/zarr/validate_replacement")
async def zarr_validate_replacement(
    payload: Dict[str, Any] = Body(...),
    auth_user: AuthUser = Depends(get_auth_user),
):
    """Validate a staged candidate .zarr against a slide before replacing.
    Body: {candidate_path (rel staging folder), target_slide_path (rel),
    slide_width, slide_height}.
    Returns {ok, errors[], warnings[], summary}."""
    candidate_rel = (payload.get("candidate_path") or "").strip()
    target_rel = (payload.get("target_slide_path") or "").strip()
    if not candidate_rel or not target_rel:
        raise AppErrors.PARAMS_ERROR("candidate_path and target_slide_path are required")
    await gather_guards(
        assert_user_owned_path_async(auth_user, candidate_rel, "zarr-validate-replacement"),
        assert_can_write_path_async(auth_user, target_rel, "zarr-validate-replacement"),
        assert_can_access_path_async(auth_user, candidate_rel, "zarr-validate-replacement"),
        assert_can_access_path_async(auth_user, target_rel, "zarr-validate-replacement"),
    )
    staging_abs = resolve_path(candidate_rel)
    if not os.path.isdir(staging_abs):
        raise HTTPException(status_code=404, detail="Staged upload not found")
    slide_abs = resolve_path(target_rel)
    target_zarr = slide_abs if slide_abs.endswith(".zarr") else slide_abs + ".zarr"
    slide_wh = _slide_wh_from_payload(payload)

    def _run():
        zarr_replace.recover_interrupted_swap(staging_abs, target_zarr, dispose=False)
        zroot = zarr_replace.prepare_candidate(staging_abs)
        if not zroot:
            raise ValueError("No Zarr store (zarr.json/.zgroup) found in the upload.")
        return zarr_replace.validate_replacement(zroot, slide_wh)

    try:
        return await asyncio.to_thread(_run)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@file_manager_router.post("/v1/zarr/replace")
async def zarr_replace_endpoint(
    payload: Dict[str, Any] = Body(...),
    auth_user: AuthUser = Depends(get_auth_user),
):
    """Replace a slide's sidecar .zarr with the staged candidate (crash-safe swap),
    then delete the staging folder. Body: {candidate_path (rel), target_slide_path
    (rel), slide_width, slide_height}."""
    candidate_rel = (payload.get("candidate_path") or "").strip()
    target_rel = (payload.get("target_slide_path") or "").strip()
    if not candidate_rel or not target_rel:
        raise AppErrors.PARAMS_ERROR("candidate_path and target_slide_path are required")
    await gather_guards(
        assert_user_owned_path_async(auth_user, candidate_rel, "zarr-replace"),
        assert_can_write_path_async(auth_user, target_rel, "zarr-replace"),
        assert_can_access_path_async(auth_user, candidate_rel, "zarr-replace"),
        assert_can_access_path_async(auth_user, target_rel, "zarr-replace"),
    )
    staging_abs = resolve_path(candidate_rel)
    if not os.path.isdir(staging_abs):
        raise HTTPException(status_code=404, detail="Staged upload not found")
    slide_abs = resolve_path(target_rel)
    target_zarr = slide_abs if slide_abs.endswith(".zarr") else slide_abs + ".zarr"
    slide_wh = _slide_wh_from_payload(payload)

    def _run():
        zarr_replace.recover_interrupted_swap(staging_abs, target_zarr)
        zroot = zarr_replace.prepare_candidate(staging_abs)
        if not zroot:
            raise ValueError("No Zarr store (zarr.json/.zgroup) found in the upload.")
        return zarr_replace.apply_replacement(zroot, target_zarr, slide_wh)

    try:
        result = await asyncio.to_thread(_run)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _rmtree_later(staging_abs)
    return result
