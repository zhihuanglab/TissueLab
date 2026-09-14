from fastapi import APIRouter, File, UploadFile, Query, Response, Request, Depends
from typing import Optional, Dict, Any
import asyncio
import traceback
import json
import urllib.parse
import hashlib

from app.core.response import success_response, error_response, permission_denied_response
from app.services.load import (
    load_uploaded_file_for_api,
    start_preprocess,
    get_current_progress,
    get_preprocess_result_for_api,
    convert_to_pyramidal_tiff,
    create_instance_from_path,
    delete_instance_and_cleanup,
    load_slide_from_path_for_api,
    get_folder_structure_for_api,
    get_loaded_slide_info,
    get_session_pyramid_info,
    get_session_properties_response,
    get_tile_for_api,
    get_cache_stats_response,
    clear_tile_cache_response,
    get_zstack_info_response,
    set_z_layer_for_api,
    get_slide_preview_by_path_service,
    assert_session_deletable,
    assert_session_owner,
    bind_session_owner,
)
from app.api.schema.load import TiffToPyramidRequest
from app.core.auth import AuthUser, get_auth_user
from app.core.access import (
    authorize_read_or_response,
    authorize_read_or_response_async,
    guard_write_path,
    request_uid,
)

# Create router
load_router = APIRouter()


async def _parse_json_body(request: Request) -> Dict[str, Any]:
    """Read and parse a JSON request body."""
    body = await request.body()
    body_text = body.decode('utf-8', errors='replace')
    return json.loads(body_text)


async def _parse_loose_request_data(request: Request) -> Dict[str, Any]:
    """Parse JSON/form/multipart/query data into a single loose dict."""
    data: Dict[str, Any] = {}
    headers = dict(request.headers)
    content_type = headers.get("content-type", "")
    body = await request.body()
    body_text = body.decode("utf-8", errors="replace")

    if "application/json" in content_type:
        try:
            parsed = json.loads(body_text)
            if isinstance(parsed, dict):
                data.update(parsed)
        except json.JSONDecodeError:
            pass
    elif "application/x-www-form-urlencoded" in content_type:
        for part in body_text.split("&"):
            if "=" in part:
                key, value = part.split("=", 1)
                data[key] = urllib.parse.unquote_plus(value)
    elif "multipart/form-data" in content_type:
        try:
            form = await request.form()
            data.update(dict(form))
        except Exception:
            pass
    else:
        try:
            parsed = json.loads(body_text)
            if isinstance(parsed, dict):
                data.update(parsed)
        except Exception:
            for part in body_text.split("&"):
                if "=" in part:
                    key, value = part.split("=", 1)
                    data[key] = urllib.parse.unquote_plus(value)
            if not data:
                try:
                    form = await request.form()
                    data.update(dict(form))
                except Exception:
                    pass

    for key, value in dict(request.query_params).items():
        data.setdefault(key, value)

    return data


def _first_present(data: Dict[str, Any], *keys: str, default: Any = "") -> Any:
    """Return the first non-empty value among the provided keys."""
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return default


def _legacy_session_id(request: Request) -> Optional[str]:
    """Map legacy routes to a per-user session; never share literal default."""
    uid = request_uid(request)
    if not uid:
        return None
    digest = hashlib.sha256(uid.encode("utf-8")).hexdigest()[:24]
    return f"legacy-{digest}"


def _instance_access_denied(request: Request, operation: str):
    return permission_denied_response(
        access_mode="forbidden",
        operation=operation,
        request_id=request.headers.get("X-Request-ID"),
        error_code="INSTANCE_OWNER_MISMATCH",
    )


def _guard_session(
    request: Request,
    session_id: str,
    operation: str,
    *,
    create: bool = False,
    teardown: bool = False,
):
    try:
        uid = request_uid(request) or ""
        if create:
            bind_session_owner(session_id, uid, create=True)
        elif teardown:
            # An already-absent session is not a permission failure — see
            # assert_session_deletable.
            assert_session_deletable(session_id, uid)
        else:
            assert_session_owner(session_id, uid)
        return None
    except PermissionError:
        return _instance_access_denied(request, operation)


def _secure_jpeg_response(image_bytes: bytes, extra_headers: Optional[Dict[str, str]] = None) -> Response:
    """Create a JPEG response with the shared security headers."""
    headers = {
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "Cross-Origin-Opener-Policy": "same-origin",
    }
    if extra_headers:
        headers.update(extra_headers)
    return Response(content=image_bytes, media_type="image/jpeg", headers=headers)


def _secure_png_response(image_bytes: bytes) -> Response:
    """Create a PNG response (transparent overlay tiles) with security headers."""
    headers = {
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "Cross-Origin-Opener-Policy": "same-origin",
    }
    return Response(content=image_bytes, media_type="image/png", headers=headers)

# Instance management endpoints
@load_router.post("/v1/create_instance")
async def create_instance(request: Request):
    """
    Create a new WSI instance and return instanceId
    """
    try:
        try:
            data = await _parse_json_body(request)
            file_path = data.get('file_path', '') or data.get('relative_path', '')
        except json.JSONDecodeError:
            return error_response("Invalid JSON format")

        authorized_path, denied = await authorize_read_or_response_async(
            request, file_path, operation="create viewer instance"
        )
        if denied is not None:
            return denied
        # Off the loop: creating an instance opens the slide, which is the
        # heaviest thing this service does. Inline it stopped every other
        # request and websocket message for the length of the open — measured
        # at 48 ms for a 1024x1024 test store, and a whole-slide image is
        # orders of magnitude larger.
        result = await asyncio.to_thread(
            create_instance_from_path, authorized_path, uid=request_uid(request)
        )
        if result["status"] == "error":
            return error_response(result["message"])

        return success_response(result)
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error creating instance: {str(e)}")

@load_router.delete("/v1/delete_instance")
async def delete_instance(request: Request):
    """
    Delete a WSI instance and clean up resources
    """
    try:
        try:
            data = await _parse_json_body(request)
            instance_id = data.get('instance_id', '')
        except json.JSONDecodeError:
            return error_response("Invalid JSON format")

        denied = _guard_session(
            request, instance_id, "delete viewer instance", teardown=True
        )
        if denied is not None:
            return denied
        # Off the loop: teardown closes the slide handle, and a handle another
        # thread is mid-read on can block inside the native library.
        result = await asyncio.to_thread(delete_instance_and_cleanup, instance_id)
        if result["status"] == "error":
            return error_response(result["message"])

        return success_response(result)
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error deleting instance: {str(e)}")

# File upload and processing endpoints
@load_router.post("/v1/upload")
async def upload_file(request: Request, file: UploadFile = File(...), auth_user: AuthUser = Depends(get_auth_user)):
    """
    Upload file to server and load as slide (legacy endpoint)
    """
    session_id = _legacy_session_id(request)
    if not session_id:
        return _instance_access_denied(request, "upload slide")
    return await upload_file_with_session(request, file, session_id=session_id, auth_user=auth_user)

@load_router.post("/v1/s{session_id}/upload")
async def upload_file_with_session(request: Request, file: UploadFile = File(...), session_id: str = "default", auth_user: AuthUser = Depends(get_auth_user)):
    """
    Upload file to server and load as slide with session support
    """
    try:
        denied = _guard_session(request, session_id, "upload slide", create=True)
        if denied is not None:
            return denied
        result = load_uploaded_file_for_api(file.filename, await file.read(), session_id)
        if result["status"] == "error":
            return error_response(result["message"])
        return success_response({k: v for k, v in result.items() if k != "status"})

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error uploading file: {str(e)}")

@load_router.post("/v1/upload_path")
async def upload_file_path_api(request: Request):
    """
    Load slide from file path (legacy endpoint)
    """
    session_id = _legacy_session_id(request)
    if not session_id:
        return _instance_access_denied(request, "load slide path")
    return await upload_file_path_api_with_session(request, session_id=session_id)

@load_router.post("/v1/s{session_id}/upload_path")
async def upload_file_path_api_with_session(request: Request, session_id: str = "default"):
    """
    Load slide from file path
    """
    try:
        denied = _guard_session(request, session_id, "load slide path", create=True)
        if denied is not None:
            return denied
        data = await _parse_loose_request_data(request)
        file_path = _first_present(data, "relative_path", "file_path", "filePath")
        authorized_path, denied = await authorize_read_or_response_async(
            request, file_path, operation="load slide path"
        )
        if denied is not None:
            return denied
        # Opens the slide — off the loop, same as create_instance.
        result = await asyncio.to_thread(
            load_slide_from_path_for_api,
            authorized_path, session_id, request_uid(request) or "",
        )
        if result["status"] == "error":
            return error_response(result["message"])
        return success_response(result)

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error loading file from path: {str(e)}")

@load_router.post("/v1/upload_folder")
async def upload_folder(request: Request, auth_user: AuthUser = Depends(get_auth_user)):
    """
    Upload folder and generate project structure
    """
    try:
        data = await _parse_loose_request_data(request)
        folder_path = _first_present(data, "relative_folder_path", "folder_path", "folderPath", default="")
        authorized_path, denied = await authorize_read_or_response_async(
            request, folder_path, operation="list folder structure"
        )
        if denied is not None:
            return denied
        result = await asyncio.to_thread(get_folder_structure_for_api, authorized_path)
        if result["status"] == "error":
            return error_response(result["message"])
        return success_response(result)

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error uploading folder: {str(e)}")

@load_router.get("/v1/load/{filename:path}")
def load_slide(filename: str, request: Request):
    """
    Load slide by filename (legacy endpoint)
    """
    session_id = _legacy_session_id(request)
    if not session_id:
        return _instance_access_denied(request, "read slide info")
    return load_slide_with_session(filename, request, session_id=session_id)

@load_router.get("/v1/s{session_id}/load/{filename:path}")
def load_slide_with_session(filename: str, request: Request, session_id: str = "default"):
    """
    Load slide by filename - returns currently loaded slide info without reloading
    """
    try:
        denied = _guard_session(request, session_id, "read slide info")
        if denied is not None:
            return denied
        result = get_loaded_slide_info(session_id)
        if result["status"] == "error":
            return error_response(result["message"])
        return success_response({
            "message": result["message"],
            "slideInfo": result["slideInfo"],
        })

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error accessing slide information: {str(e)}")

@load_router.get("/v1/slide/{level}/{col_row}")
async def get_tile_api(
    level: int,
    col_row: str,
    scale_factor: float = Query(1.0),
    color_mode: Optional[str] = Query(None),
    request: Request = None
):
    """
    Get specific tile from slide (legacy endpoint)
    """
    session_id = _legacy_session_id(request)
    if not session_id:
        return _instance_access_denied(request, "read slide tile")
    return await get_tile_api_with_session(level, col_row, scale_factor, color_mode, request, session_id=session_id)

@load_router.get("/v1/tile/{level}/{col_row}")
async def get_tile_api_with_header(
    level: int,
    col_row: str,
    scale_factor: float = Query(1.0),
    color_mode: Optional[str] = Query(None),
    instance_id: Optional[str] = Query(None, description="Instance ID for session management"),
    overlay: Optional[str] = Query(None, description="Overlay-only tile: 'cell' or 'patch' (transparent PNG)"),
    dot: int = Query(1, description="Cell-overlay dot radius in tile pixels (size slider)"),
    request: Request = None
):
    """
    Get specific tile from slide with instanceId from header or query parameter
    Format: /v1/tile/0/3_1.jpeg where 3 is column and 1 is row
    """
    # Get instanceId from header or query parameter
    instance_id_from_header = request.headers.get('X-Instance-ID')
    instance_id_final = instance_id or instance_id_from_header

    if not instance_id_final:
        return error_response("X-Instance-ID header or instance_id query parameter is required")

    denied = _guard_session(request, instance_id_final, "read slide tile")
    if denied is not None:
        return denied
    # Overlay request: return an overlay-only transparent PNG tile (cell/patch
    # classification colors) for the detail popup's second OSD layer.
    if overlay in ("cell", "patch"):
        from app.services.load import get_overlay_tile_for_api
        from app.core.executors import tile_executor
        # Opens the zarr and rasterises cells with PIL — same pool as base tiles.
        result = await asyncio.get_running_loop().run_in_executor(
            tile_executor,
            lambda: get_overlay_tile_for_api(
                level, col_row, overlay, session_id=instance_id_final, dot_radius=dot
            ),
        )
        if result["status"] == "error":
            return error_response(result["message"])
        return _secure_png_response(result["image_data"])

    return await get_tile_api_with_session(level, col_row, scale_factor, color_mode, request, session_id=instance_id_final)

@load_router.get("/v1/s{session_id}/slide/{level}/{col_row}")
async def get_tile_api_with_session(
    level: int,
    col_row: str,
    scale_factor: float = Query(1.0),
    color_mode: Optional[str] = Query(None),
    request: Request = None,
    session_id: str = "default"
):
    """
    Get specific tile from slide
    Format: /v1/slide/0/3_1.jpeg where 3 is column and 1 is row
    """
    try:
        denied = _guard_session(request, session_id, "read slide tile")
        if denied is not None:
            return denied

        # The viewer aborts outstanding tile XHRs when it opens another slide.
        # Checking here — before the read is queued — is the one place the abort
        # can still save work; once the job is on a pool thread it runs to
        # completion regardless.
        if await request.is_disconnected():
            return Response(status_code=499)

        result = await get_tile_for_api(
            level=level,
            col_row=col_row,
            scale_factor=scale_factor,
            color_mode=color_mode,
            query_params=request.query_params,
            session_id=session_id,
        )
        # Slide switched while this was queued. 409 rather than an error body:
        # nothing is wrong, the tile just belongs to a slide nobody is showing,
        # and the viewer discards it without logging a failure.
        if result["status"] == "stale":
            return Response(status_code=409)

        if result["status"] == "error":
            return error_response(result["message"])

        if "image_data" not in result or not result["image_data"]:
            return error_response("Empty image data returned")

        return _secure_jpeg_response(result["image_data"])

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting tile: {str(e)}")

@load_router.get("/v1/pyramid")
def get_pyramid(request: Request):
    """
    Get slide pyramid information (legacy endpoint)
    """
    session_id = _legacy_session_id(request)
    if not session_id:
        return _instance_access_denied(request, "read slide pyramid")
    return get_pyramid_with_session(request, session_id=session_id)

@load_router.get("/v1/s{session_id}/pyramid")
def get_pyramid_with_session(request: Request, session_id: str = "default"):
    """
    Get slide pyramid information
    """
    try:
        denied = _guard_session(request, session_id, "read slide pyramid")
        if denied is not None:
            return denied
        result = get_session_pyramid_info(session_id)
        if result["status"] == "error":
            return error_response(result["message"])
        return success_response(result["data"])

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting pyramid info: {str(e)}")

@load_router.get("/v1/properties")
def get_properties(request: Request):
    """
    Get slide properties (legacy endpoint)
    """
    session_id = _legacy_session_id(request)
    if not session_id:
        return _instance_access_denied(request, "read slide properties")
    return get_properties_with_session(request, session_id=session_id)

@load_router.get("/v1/s{session_id}/properties")
def get_properties_with_session(request: Request, session_id: str = "default"):
    """
    Get slide properties
    """
    try:
        denied = _guard_session(request, session_id, "read slide properties")
        if denied is not None:
            return denied
        result = get_session_properties_response(session_id)
        if result["status"] == "error":
            return error_response(result["message"])
        return success_response(result["data"])

    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting slide properties: {str(e)}")

@load_router.post("/v1/run-preprocess")
def run_preprocess(
    model: str = Query(..., description="Model type to be used in the process"),
    magnification: str = Query(..., description="Magnification setting")
):
    """
    Start preprocessing task
    
    Calls start_preprocess function in service layer to start background processing thread
    """
    try:
        result = start_preprocess(model, magnification)
        return success_response(result)
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error starting preprocess: {str(e)}")

@load_router.get("/v1/get-progress")
def get_progress():
    """
    Get preprocessing progress
    
    Calls get_current_progress function in service layer to get real-time progress
    """
    try:
        result = get_current_progress()
        return success_response(result)
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting progress: {str(e)}")

@load_router.get("/v1/get-result")
def get_result():
    """
    Get preprocessing result
    
    Calls get_process_result function in service layer to get processing result
    """
    try:
        result = get_preprocess_result_for_api()
        return success_response(result["data"])
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting result: {str(e)}")

@load_router.post("/convert-to-pyramidal-tiff", summary="Convert TIFF to pyramidal format")
def convert_to_pyramidal_tiff_api(body: TiffToPyramidRequest, request: Request):
    """
    Converts a standard TIFF file to a multi-level pyramidal TIFF using libvips.
    This is a preprocessing step to optimize large images for fast tiled access.
    """
    try:
        # Both ends are caller-supplied, and the destination is written to.
        input_path, denied = authorize_read_or_response(
            request, body.input_path, operation="convert to pyramidal TIFF"
        )
        if denied is not None:
            return denied
        output_path, denied = guard_write_path(
            request, body.output_path, "convert to pyramidal TIFF"
        )
        if denied is not None:
            return denied
        result = convert_to_pyramidal_tiff(input_path, output_path)
        if result["status"] == "success":
            return success_response(result)
        else:
            return error_response(message=result["message"], code=500)
    except Exception as e:
        traceback.print_exc()
        return error_response(message=f"Error processing request: {e}", code=500)

@load_router.get("/v1/slide/preview_by_path")
def get_slide_preview_by_path(
    request: Request,
    file_path: str = Query(..., description="File path to get preview from"),
    preview_type: str = Query("all", description="Preview type: thumbnail, macro, label, or all"),
    size: int = Query(200, description="Maximum image size"),
    request_id: str = Query(..., description="Unique request ID for tracking")
):
    """
    Get slide preview images by file path without affecting currently loaded slide
    """
    try:
        authorized_path, denied = authorize_read_or_response(
            request, file_path, operation="read slide preview"
        )
        if denied is not None:
            return denied
        result = get_slide_preview_by_path_service(authorized_path, preview_type, size, request_id)
        
        if result["status"] == "error":
            return error_response(result["message"])
        
        if result["response_type"] == "json":
            return success_response(result["data"])
        else:  # binary response
            headers = {
                "Cache-Control": "public, max-age=3600",
            }
            if request_id:
                headers["X-Request-ID"] = request_id
            return _secure_jpeg_response(result["image_bytes"], headers)
            
    except Exception as e:
        traceback.print_exc()
        return error_response("Error getting slide preview")

@load_router.get("/v1/cache/stats")
def get_cache_stats():
    """
    Get tile cache statistics
    """
    try:
        return get_cache_stats_response()
    except Exception as e:
        return error_response(f"Error getting cache stats: {str(e)}")

@load_router.post("/v1/cache/clear")
def clear_cache():
    """
    Clear all tile cache
    """
    try:
        return clear_tile_cache_response()
    except Exception as e:
        return error_response(f"Error clearing cache: {str(e)}")

# Z-Stack endpoints
@load_router.get("/v1/zstack-info")
def get_zstack_info(request: Request, session_id: str = Query("default", description="Session ID")):
    """
    Get z-stack information for current session
    """
    try:
        if session_id == "default":
            session_id = _legacy_session_id(request) or ""
        denied = _guard_session(request, session_id, "read z-stack info")
        if denied is not None:
            return denied
        result = get_zstack_info_response(session_id)
        if result["status"] == "error":
            return error_response(result["message"])
        return success_response(result["data"])
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting z-stack info: {str(e)}")

@load_router.post("/v1/set-z-layer")
async def set_z_layer_api(request: Request):
    """
    Set current z-layer for viewing
    """
    try:
        try:
            data = await _parse_json_body(request)
        except json.JSONDecodeError:
            return error_response("Invalid JSON format")

        session_id = data.get('session_id', 'default')
        if session_id == "default":
            session_id = _legacy_session_id(request) or ""
        denied = _guard_session(request, session_id, "set z-stack layer")
        if denied is not None:
            return denied
        z_layer = data.get('z_layer')
        if z_layer is None:
            return error_response("z_layer is required")

        result = set_z_layer_for_api(session_id, int(z_layer))
        if result["status"] == "error":
            return error_response(result["message"])
        return success_response(result["data"])
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error setting z-layer: {str(e)}")
