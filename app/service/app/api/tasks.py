import asyncio
import json
import os
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import aiohttp
from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict

from app.config.zarr_compat import as_zarr_path, open_zarr_cm
from app.core import logger
from app.core.background import track_background_task
from app.core.auth import AuthUser, get_auth_user, get_optional_auth_user
from app.core.access import (
    authorize_read_or_response,
    authorize_read_or_response_async,
    guard_instance_owner,
    guard_write_path,
    guard_write_path_async,
    sanitize_client_path,
)
from app.core.response import error_response, success_response
from app.config.path_config import SERVICE_STORAGE_DIR
from app.core.identity import LOCAL_USER_ID
from app.core.settings import settings
from app.services.batch_orchestrator import (
    append_batch as service_append_batch,
    batch_job_snapshot,
    generate_batch_events,
    get_active_batch as service_get_active_batch,
    has_active_batch,
    start_batch as service_start_batch,
    stop_batch as service_stop_batch,
)
from app.services.tasks import (
    _generate_simple_summary,
    _process_node_h5,
    begin_script_summary_wait,
    convert_for_json,
    end_script_summary_wait,
    manager,
    post_answer,
    process_node,
    recommend_viewport,
)
from app.services.manual_annotations import (
    delete_manual_annotation as service_delete_manual_annotation,
    load_manual_annotations,
    save_manual_annotation as service_save_manual_annotation,
)
from app.utils import resolve_path
from app.utils.bundle import filter_catalog_for_current_platform as service_filter_catalog
from app.utils.bundle import generate_install_events as service_generate_install_events
from app.utils.bundle import resolve_download_url as service_resolve_download_url
from app.utils.bundle import find_bundle as service_find_bundle
from app.utils.bundle import assert_gcs_uri_in_catalog as service_assert_gcs_uri_in_catalog
from app.utils.bundle import load_catalog as service_load_catalog
from app.utils.bundle import start_bundle_install as service_start_bundle_install
from app.utils.common.request import get_client_ip
from app.utils.workflow.model_store import model_store
from app.utils.workflow.register import (
    list_available_conda_envs,
    stop_custom_node_env,
    stop_custom_node_process,
)

try:
    import resource
except ImportError:
    resource = None
try:
    import psutil
except ImportError:
    psutil = None
try:
    import h5py
except ImportError:
    h5py = None


# ── codeexec concurrency gate ─────────────────────────────────────────────────
# Serialize sandboxed code runs so concurrent users don't exhaust the host.
# N=1 (default) = strictly one at a time; raise CODEEXEC_MAX_CONCURRENCY for more.
# Dedicated thread pool so sandbox runs don't compete with the app's default executor.
_CODEEXEC_MAX_CONCURRENCY = max(1, int(os.getenv("CODEEXEC_MAX_CONCURRENCY", "1")))
_codeexec_executor = ThreadPoolExecutor(
    max_workers=_CODEEXEC_MAX_CONCURRENCY, thread_name_prefix="codeexec")
_codeexec_semaphore = None


def _get_codeexec_semaphore():
    """Lazily create the semaphore inside the running event loop so it binds to it."""
    global _codeexec_semaphore
    if _codeexec_semaphore is None:
        _codeexec_semaphore = asyncio.Semaphore(_CODEEXEC_MAX_CONCURRENCY)
    return _codeexec_semaphore


tasks_router = APIRouter()



def _is_electron_client(request: Request) -> bool:
    """True when the desktop shell marks the request with ``X-Client-Type: electron``.

    The open edition is single-user and local, so the marker is trusted in every
    environment (the hosted service only trusted it outside production because
    it disables output sandboxing for other users' data — there are none here).
    """
    client_type = (
        request.headers.get("X-Client-Type", "")
        or request.headers.get("x-client-type", "")
    ).lower()
    return client_type == "electron"


def _authenticate_sse_query(request: Request) -> str:
    """EventSource cannot set headers; the open edition has one principal anyway."""
    return LOCAL_USER_ID














@tasks_router.get("/v1/activation/events")
def activation_events(request: Request):
    """Server-Sent Events stream for all models' activation status."""
    from app.services.tasks import generate_all_activation_events
    _authenticate_sse_query(request)
    try:
        return StreamingResponse(
            generate_all_activation_events(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    except Exception as e:
        return error_response(f"Failed to start activation stream: {e}")

@tasks_router.get("/v1/recommend_viewport")
def recommend_viewport_endpoint(
    request: Request,
    target_class: int = Query(0, description="Target class index for ROI recommendation"),
    selection_mode: str = Query("high_confidence", description="high_confidence | low_confidence"),
):
    """
    Recommend next viewport (ROI) for filter/annotation. Uses tasks_service only (no seg dependency).
    Returns bbox in level0 pixels { x, y, width, height } for frontend fitBounds.
    """
    try:
        file_path = request.query_params.get("relative_path") or request.query_params.get("file_path")
        if not file_path:
            return error_response("No file path provided", code=400)
        authorized_path, denied = authorize_read_or_response(
            request, file_path, operation="recommend viewport"
        )
        if denied is not None:
            return denied
        zarr_path = as_zarr_path(authorized_path)
        if not os.path.exists(zarr_path):
            return error_response("Zarr file not found", code=400)
        data = recommend_viewport(zarr_path, target_class=target_class, selection_mode=selection_mode)
        return success_response(data)
    except Exception as e:
        traceback.print_exc()
        return error_response("Error recommending viewport")


@tasks_router.get("/v1/bundles/catalog")
def get_bundles_catalog():
    try:
        catalog = service_load_catalog()
        filtered = service_filter_catalog(catalog)
        return success_response({"bundles": filtered})
    except Exception as e:
        return error_response(f"Failed to load bundles catalog: {e}")

@tasks_router.post("/v1/bundles/signed_url")
def get_bundle_signed_url(payload: dict = Body(...)):
    """Resolve a catalog bundle URI to its public download URL.

    The route name is kept for the renderer; there is no signing in the open
    edition, the bundle host serves the archives over plain HTTPS.
    """
    try:
        gcs_uri = payload.get("gcs_uri")
        filename = payload.get("filename")
        if not gcs_uri:
            raise HTTPException(status_code=400, detail="Missing gcs_uri")
        denied_reason = service_assert_gcs_uri_in_catalog(gcs_uri)
        if denied_reason:
            return error_response(denied_reason, code=403, error_code="BUNDLE_URI_NOT_ALLOWED")
        res = service_resolve_download_url(gcs_uri, filename=filename)
        if res.get("status") != "success":
            raise HTTPException(status_code=500, detail=res.get("message", "Failed to resolve URL"))
        return success_response(res)
    except HTTPException:
        raise
    except Exception as e:
        return error_response(f"Failed to resolve bundle URL: {e}")


@tasks_router.post("/v1/bundles/download_url")
def get_bundle_download_url(payload: dict = Body(...)):
    """Electron download helper: ``{model_name, platform}`` → ``{success, download_url, filename}``.

    Plain JSON (not the app envelope) — the renderer's node installer reads
    ``download_url`` straight off the body; HTTP 404 when the catalog has no
    bundle for that platform.
    """
    model_name = (payload.get("model_name") or "").strip()
    platform = (payload.get("platform") or "").strip()
    if not model_name or not platform:
        return JSONResponse(status_code=400, content={"success": False, "message": "model_name and platform are required"})
    bundle = service_find_bundle(model_name, platform)
    if not bundle:
        return JSONResponse(status_code=404, content={"success": False, "message": "No bundle available for your platform yet"})
    res = service_resolve_download_url(bundle.get("gcs_uri", ""), filename=bundle.get("filename"))
    if res.get("status") != "success":
        return JSONResponse(status_code=500, content={"success": False, "message": res.get("message", "Failed to resolve URL")})
    return JSONResponse(content={
        "success": True,
        "download_url": res["signed_url"],
        "filename": bundle.get("filename"),
        "model_name": model_name,
        "platform": platform,
    })


class InstallBundleRequest(BaseModel):
    model_config = ConfigDict(extra='ignore')
    model_name: str
    gcs_uri: str
    filename: str | None = None
    entry_relative_path: str
    size_bytes: int | None = None
    sha256: str | None = None

@tasks_router.post("/v1/bundles/install")
def install_bundle(payload: InstallBundleRequest):
    try:
        denied_reason = service_assert_gcs_uri_in_catalog(payload.gcs_uri)
        if denied_reason:
            return error_response(denied_reason, code=403, error_code="BUNDLE_URI_NOT_ALLOWED")
        install_id = service_start_bundle_install(
            model_name=payload.model_name,
            gcs_uri=payload.gcs_uri,
            filename=payload.filename,
            entry_relative_path=payload.entry_relative_path,
            expected_size=payload.size_bytes,
            expected_sha256=payload.sha256,
        )
        return success_response({"install_id": install_id})
    except Exception as e:
        return error_response(f"Failed to start install: {e}")

@tasks_router.get("/v1/bundles/install/events")
def install_events(install_id: str, request: Request):
    _authenticate_sse_query(request)
    try:
        return StreamingResponse(
            service_generate_install_events(install_id),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    except Exception as e:
        return error_response(f"Failed to start install stream: {e}")

@tasks_router.get("/v1/logs/tail")
def get_log_tail(path: Optional[str] = None, model_name: Optional[str] = None, n: int = 200):
    """
    Return the last n lines of a log file. n defaults to 200.
    Either path (log file path under tasknode_logs) or model_name (e.g. InstanSegNode) must be provided.
    Frontend sends model_name; path is for direct use when log_path is known.
    For remote nodes, logs are fetched from the remote node's logs API.
    """
    from app.services.tasks import get_log_tail_service
    try:
        if path:
            base_dir = os.path.abspath(
                os.path.join(
                    os.path.dirname(os.path.dirname(__file__)),
                    "..",
                    "storage",
                    "tasknode_logs",
                )
            )
            candidate = path if os.path.isabs(path) else os.path.join(base_dir, path)
            abs_path = os.path.abspath(candidate)
            if not (abs_path == base_dir or abs_path.startswith(base_dir + os.sep)):
                raise HTTPException(status_code=403, detail="Forbidden path")
            path = abs_path
        result = get_log_tail_service(path, model_name, n)
        if isinstance(result, dict) and result.get("path"):
            # Prefer tasknode_logs-relative path; never leak absolute roots.
            raw = result.get("path") or ""
            try:
                base_dir = os.path.abspath(
                    os.path.join(
                        os.path.dirname(os.path.dirname(__file__)),
                        "..",
                        "storage",
                        "tasknode_logs",
                    )
                )
                abs_raw = os.path.abspath(raw)
                if abs_raw == base_dir or abs_raw.startswith(base_dir + os.sep):
                    result = {
                        **result,
                        "path": os.path.relpath(abs_raw, base_dir).replace("\\", "/"),
                    }
                else:
                    result = {**result, "path": sanitize_client_path(raw)}
            except Exception:
                result = {**result, "path": sanitize_client_path(raw)}
        return success_response(result)
    except RuntimeError:
        return error_response("Failed to fetch remote logs")
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid log request")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Log file not found")
    except PermissionError:
        raise HTTPException(status_code=403, detail="Forbidden path")
    except HTTPException:
        raise
    except Exception:
        return error_response("Failed to read log")

# Only keep the API model classes needed for request validation
class RegisterCustomNodeRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    
    model_name: str
    python_version: str
    service_path: str
    dependency_path: str
    factory: str
    description: str | None = None
    port: int | None = None
    env_name: str | None = None
    install_dependencies: bool = True
    # Optional I/O specifications for better chaining in Model Zoo/Agent (list or natural language string)
    inputs: str | None = None
    outputs: str | None = None
    # Remote deployment options (keep in sync with RegisterCustomNodeAsyncRequest)
    is_remote: bool = False
    remote_host: str | None = None
    mnt_path: str | None = None

class CreateNodeRequest(BaseModel):
    service_name: str
    file_path: str
    port: Optional[int] = 8001

class DependencyBody(BaseModel):
    from_node: str
    to_node: str

class ClearWorkflowRequest(BaseModel):
    workflow_id: Optional[int] = None

def _patch_dict_paths(req: dict):
    for key in ["zarr_path", "file_path", "path", "classifier_path", "save_classifier_path"]:
        if key in req and isinstance(req[key], str):
            req[key] = resolve_path(req[key])
    return req

# function to patch paths recursively

def patch_paths_recursive(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ["zarr_path", "file_path", "path", "classifier_path", "save_classifier_path"] and isinstance(v, str):
                obj[k] = resolve_path(v)
            else:
                patch_paths_recursive(v)
    elif isinstance(obj, list):
        for item in obj:
            patch_paths_recursive(item)
    return obj


def _patch_batch_items(raw_items: list, request: Request):
    """Validate + path-patch start/append batch items. Returns (patched_list, error_response_or_None)."""
    patched_items = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            return None, error_response("Each batch item must be an object", code=400)
        path = raw.get("path", "")
        zarr_path = raw.get("zarr_path") or raw.get("zarrPath") or ""
        _, denied = guard_write_path(
            request, path or zarr_path, "batch process workflow"
        )
        if denied is not None:
            return None, denied
        payload = raw.get("payload")
        if isinstance(payload, dict):
            payload = patch_paths_recursive(payload)
        patched_items.append({"path": path, "zarr_path": zarr_path, "payload": payload})
    return patched_items, None


@tasks_router.post("/v1/start_service/{service_name}")
def start_service(service_name: str):
    """
    Start single node service
    """
    try:
        # Call service layer's start_service function
        from app.services.tasks import start_service as service_start_service
        
        result = service_start_service(service_name)
        
        # Handle result
        if "error" in result:
            return error_response(result["error"])
        else:
            return success_response({"message": result.get("message", f"Service {service_name} started successfully")})
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.post("/v1/stop_service/{service_name}")
def stop_service(service_name: str):
    """
    Close node server
    """
    try:
        # Call service layer's stop_service function
        from app.services.tasks import stop_service as service_stop_service
        
        result = service_stop_service(service_name)
        
        # Handle result
        if not isinstance(result, dict):
            return error_response(f"Failed to stop service {service_name}")
        if "error" in result:
            return error_response(result["error"])
        return success_response({"message": result.get("message", f"Service {service_name} stopped successfully")})
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.post("/v1/start_all_services")
def start_all_services():
    """
    Start all nodes from nodeA to nodeE
    """
    try:
        # Call service layer's start_all_services function
        from app.services.tasks import start_all_services as service_start_all_services
        
        result = service_start_all_services()
        
        # Return results
        return success_response({"results": result.get("results", {})})
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.post("/v1/stop_all_services")
def stop_all_services():
    """
    Close all nodes from nodeA to nodeE
    """
    try:
        # Call service layer's stop_all_services function
        from app.services.tasks import stop_all_services as service_stop_all_services
        
        result = service_stop_all_services()
        
        # Return results
        return success_response({"results": result.get("results", {})})
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.post("/v1/create_node")
def create_node(req: CreateNodeRequest):
    """
    Example:
    {
      "service_name": "MyNodeA",
      "file_path": "app/core/tasks/current_tasks/node_A.py",
      "port": 9001
    }
    """
    try:
        # Call service layer's create_node function
        from app.services.tasks import create_node as service_create_node
        
        # Resolve virtual path aliases first (e.g., 'samples/Data' -> '/data/public')
        from app.config.path_config import resolve_virtual_path
        resolved_file_path = resolve_virtual_path(req.file_path)
        if not resolved_file_path:
            return error_response("Invalid path alias", code=400)
        result = service_create_node(
            service_name=req.service_name,
            file_path=resolve_path(resolved_file_path),
            port=req.port
        )
        
        # Handle result
        if "error" in result:
            return error_response(result["error"])
        else:
            return success_response({
                "message": result.get("message", f"Node '{req.service_name}' registered"),
                "service_info": result.get("service_info", {})
            })
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.post("/v1/add_dependency")
def add_dependency(data: DependencyBody):
    """
    data example:
    {
      "from_node": "nodeA",
      "to_node": "nodeB"
    }
    """
    try:
        # Call service layer's _add_dependency_internal function
        from app.services.tasks import _add_dependency_internal as service_add_dependency
        
        result = service_add_dependency(data.from_node, data.to_node)
        
        # Handle result
        if "error" in result:
            return error_response(result["error"])
        else:
            return success_response({"message": result.get("message", f"Dependency added: {data.from_node} -> {data.to_node}")})
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.get("/v1/list_workflows")
def list_current_workflows():
    wf_ids = manager.list_workflows()
    workflow_map = manager.workflows
    display_list = []
    for wf_id in wf_ids:
        # workflow_map[wf_id] example: ["nodeA","nodeC","nodeD"]
        nodes = workflow_map.get(wf_id, [])
        path_str = "->".join(nodes)
        display_list.append(f"{wf_id}: {path_str}")

    return success_response({"workflows": display_list})

@tasks_router.get("/v1/get_answer")
def get_answer(auth_user: AuthUser = Depends(get_auth_user)):
    """
    Get workflow answer for the authenticated user.
    Returns user-specific workflow results to prevent collision across concurrent sessions.
    """
    from app.services.tasks import user_workflow_status
    
    uid = auth_user.uid
    
    # Check if user has a workflow status entry
    if uid not in user_workflow_status:
        return success_response({
            "message": "no_workflow",
            "answer": ""
        })
    
    user_status = user_workflow_status[uid]
    is_generating = user_status.get('is_generating', False)
    script_error_code = user_status.get("script_error_code")
    script_error_message = user_status.get("script_error_message")
    
    if is_generating:
        partial = user_status.get("cur_answer")
        answer_wait = partial if isinstance(partial, str) else ""
        return success_response({
            "message": "wait",
            "answer": answer_wait,
            "state_code": 1000,
        })
    if isinstance(script_error_code, int) and script_error_code != 0:
        data = {
            "message": "error",
            "answer": "",
            "state_code": script_error_code,
            "error": script_error_message or "Script execution failed",
        }
        user_workflow_status[uid]["script_error_code"] = None
        user_workflow_status[uid]["script_error_message"] = None
        user_workflow_status[uid]["cur_answer"] = None
        return success_response(data)
    else:
        cur_answer = user_status.get('cur_answer', '')
        data = {
            "message": "done",
            "answer": cur_answer,
            "state_code": 0,
        }
        # Reset cur_answer for this user
        user_workflow_status[uid]['cur_answer'] = None
        return success_response(data)


@tasks_router.get("/v1/current_workflow_status")
def current_workflow_status(auth_user: AuthUser = Depends(get_auth_user)):
    """
    Return current user's workflow status snapshot (for frontend restore after page refresh).
    If user has a running or queued workflow, returns execution_id, status, node_status,
    node_progress, queue_position, queue_total. Otherwise returns active=False.
    """
    from app.services.tasks import get_current_workflow_status as service_get_current
    snapshot = service_get_current(auth_user.uid)
    return success_response(snapshot)


@tasks_router.post("/v1/start_batch")
async def start_batch(frontend_data: dict, request: Request, auth_user: AuthUser = Depends(get_auth_user)):
    """
    Start a multi-file workflow batch. Frontend pre-builds per-file start_workflow payloads;
    the backend runs them serially so closing the browser does not stop the queue.
    """
    uid = auth_user.uid
    raw_items = frontend_data.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        return error_response("items must be a non-empty list", code=400)

    patched_items, err = _patch_batch_items(raw_items, request)
    if err is not None:
        return err

    stop_on_first_error = frontend_data.get("stop_on_first_error")
    if stop_on_first_error is None:
        stop_on_first_error = frontend_data.get("stopOnFirstError", True)

    source = frontend_data.get("source") or "workflow"

    auth_header = request.headers.get("Authorization")
    result = await service_start_batch(
        uid=uid,
        items=patched_items,
        stop_on_first_error=bool(stop_on_first_error),
        auth_header=auth_header,
        source=str(source),
    )
    if not result.get("success"):
        return error_response(result.get("error", "Failed to start batch"), code=result.get("code", 500))
    return success_response({"batch": result.get("batch")})


@tasks_router.post("/v1/batch/append")
async def append_batch(frontend_data: dict, request: Request, auth_user: AuthUser = Depends(get_auth_user)):
    """Append files to the current user's active batch (e.g. more CellCast pre-runs)."""
    raw_items = frontend_data.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        return error_response("items must be a non-empty list", code=400)

    patched_items, err = _patch_batch_items(raw_items, request)
    if err is not None:
        return err

    source = frontend_data.get("source")
    result = await service_append_batch(
        uid=auth_user.uid,
        items=patched_items,
        source=str(source) if source else None,
    )
    if not result.get("success"):
        return error_response(result.get("error", "Failed to append to batch"), code=result.get("code", 500))
    return success_response({"batch": result.get("batch"), "added": result.get("added", 0)})


@tasks_router.get("/v1/batch/active")
def get_active_batch(auth_user: AuthUser = Depends(get_auth_user)):
    """Return the current user's *running* batch snapshot (tab reopen / re-login).

    Finished batches are not returned — the client dismisses completion UI
    intentionally; refresh must not resurrect it.
    """
    job = service_get_active_batch(auth_user.uid)
    if not job:
        return success_response({"active": False, "batch": None})
    return success_response({"active": True, "batch": batch_job_snapshot(job)})


@tasks_router.get("/v1/batch/events")
def batch_events(request: Request):
    """Push batch snapshots as Server-Sent Events (token query auth, same as get_status)."""
    uid = _authenticate_sse_query(request)

    return StreamingResponse(
        generate_batch_events(uid),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@tasks_router.post("/v1/stop_batch")
async def stop_batch(auth_user: AuthUser = Depends(get_auth_user)):
    """Stop the current user's active batch (current file + remaining queue)."""
    result = await service_stop_batch(auth_user.uid)
    if not result.get("success"):
        return error_response(result.get("error", "Failed to stop batch"), code=result.get("code", 500))
    return success_response({
        "message": result.get("message", "Batch stop requested"),
        "batch": result.get("batch"),
        **({"warning": result["warning"]} if result.get("warning") else {}),
    })


@tasks_router.post("/v1/start_workflow")
async def start_workflow_from_frontend(frontend_data: dict, background_tasks: BackgroundTasks, request: Request, auth_user: AuthUser = Depends(get_auth_user)):
    """
    Start workflow from frontend with user isolation
    
    frontend_data format example:
    "zarr_path": "/Users/xxx/Desktop/my_workflow_data.zarr",
      "step1": {
        "model": "Cell-Segmentation",
        "input": {
          "path": "/Users/xxx/Desktop/example_WSI/CMU-1.svs",
          "read_image_method": "tiffslide",
          "stardist_pretrain": "2D_versatile_he",
          "calculate_features": true
        }
      }
    """
    uid = auth_user.uid

    # Block manual single-file starts while a backend batch queue owns this user.
    if has_active_batch(uid):
        return error_response("Batch processing in progress", code=409)

    # Check public read-only directory restriction BEFORE path processing
    zarr_path = frontend_data.get("zarr_path", "")
    _, denied = await guard_write_path_async(request, zarr_path, "run workflow")
    if denied is not None:
        return denied
    
    frontend_data = patch_paths_recursive(frontend_data)
    
    # Call service layer's start_workflow_from_frontend function with uid
    from app.services.tasks import start_workflow_from_frontend as service_start_workflow
    
    auth_header = request.headers.get("Authorization")
    result = await service_start_workflow(frontend_data, uid, auth_header=auth_header)
    
    if not result.get("success", False):
        # Honor a service-supplied status code (e.g. 409 for "already running")
        # so expected business conflicts aren't auto-reported as 500 tickets.
        return error_response(result.get("error", "Unknown error occurred when starting workflow"), code=result.get("code", 500))
    
    # Get task information
    task_info = result.get("task_info", {})
    wf_id = task_info.get("wf_id")
    execution_id = result.get("execution_id")  # Get execution_id from service layer
    queue_position = result.get("queue_position", 0)
    
    logger.info(f"  Workflow {wf_id} queued for user {uid} at position {queue_position}, execution_id: {execution_id}")
    
    return success_response({
        "message": result.get("message", f"Workflow '{wf_id}' queued for execution"),
        "workflow_id": wf_id,
        "execution_id": execution_id,  # Return execution_id to frontend
        "queue_position": queue_position,
        "user_id": uid
    })

@tasks_router.post("/v1/register_custom_node")
def register_custom_node_endpoint(req: RegisterCustomNodeRequest):
    """
    When the frontend calls this interface, it needs to pass in:
    - model_name: The name of the custom node
    - python_version: The Python version used to create or reuse the conda environment (e.g., 3.11)
    - service_path: The entry point for starting the node service (e.g., 'custom_node:app')
    - dependency_path: The absolute path of the node dependency file requirements.txt
    - factory: The factory to which the node belongs (e.g., 'TissueClassify/NucleiSeg/Custom/...')

    Process:
      1. If a Node named req.model_name already exists in the system, stop and remove the old environment first
      2. Call register_custom_node(...) to start the new service
      3. If the startup is successful, use the returned port to create a CustomNodeWrapper and register it to TaskNodeManager
    """
    try:
        # Call service layer's register_custom_node_endpoint function
        from app.services.tasks import register_custom_node_endpoint as service_register_custom_node_endpoint
        
        result = service_register_custom_node_endpoint(
            model_name=req.model_name,
            python_version=req.python_version,
            service_path=req.service_path,
            dependency_path=resolve_path(req.dependency_path),
            factory=req.factory,
            description=req.description,
            port=req.port,
            env_name=req.env_name,
            install_dependencies=req.install_dependencies,
            io_specs={
                "inputs": req.inputs,
                "outputs": req.outputs,
            } if (req.inputs is not None or req.outputs is not None) else None,
            is_remote=req.is_remote,
            remote_host=req.remote_host,
            mnt_path=req.mnt_path,
        )
        
        # Check result format and return appropriate response
        if "code" in result:
            if result["code"] == 0:
                return {"code": 0, "data": result["data"]}
            else:
                # Include log_path if present to help frontend stream logs
                payload = {"code": 1, "message": result.get("message", "Registration failed")}
                try:
                    if isinstance(result.get("data"), dict) and result["data"].get("log_path"):
                        payload["data"] = {"log_path": result["data"]["log_path"]}
                except Exception:
                    pass
                return payload
        else:
            if "error" in result:
                return error_response(result["error"])
            else:
                return success_response(result)
    except Exception as e:
        return error_response(f"API Error: {str(e)}")


class RegisterCustomNodeAsyncRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    model_name: str
    python_version: str
    service_path: str
    dependency_path: str
    factory: str
    description: str | None = None
    port: int | None = None
    env_name: str | None = None
    install_dependencies: bool = True
    # Optional I/O specifications for better chaining in Model Zoo/Agent
    inputs: str | None = None
    outputs: str | None = None
    # Remote deployment options
    is_remote: bool = False
    remote_host: str | None = None
    mnt_path: str | None = None


class WorkflowStageStatusRequest(BaseModel):
    zarr_path: str
    steps: Optional[list[dict]] = None


@tasks_router.post("/v1/workflow_stage_status")
def workflow_stage_status(
    req: WorkflowStageStatusRequest,
    request: Request,
    auth_user: AuthUser = Depends(get_auth_user),
):
    """Return stage-level workflow status from zarr + runtime overrides."""
    from app.services.tasks import get_workflow_stage_status as service_get_workflow_stage_status

    resolved_path, denied = authorize_read_or_response(
        request, req.zarr_path, operation="read workflow stage status"
    )
    if denied is not None:
        return denied
    result = service_get_workflow_stage_status(
        uid=auth_user.uid,
        zarr_path=resolved_path,
        steps=req.steps,
    )
    return success_response(result)


@tasks_router.post("/v1/register_custom_node_async")
async def register_custom_node_async(req: RegisterCustomNodeAsyncRequest):
    """
    Immediately create a log file and return its path, then run registration in background.
    """
    # Coroutine on purpose, though it never awaits: it schedules the registration
    # on the event loop with create_task, and a plain `def` route runs in a worker
    # thread where there is no running loop to schedule onto.
    try:
        # Pre-create a log file name to stream logs immediately
        from app.utils.workflow.register import _resolve_log_path  # type: ignore
        env_name = req.env_name or f"{req.model_name}_tissuelab_ai_service_tasknode"
        log_path = _resolve_log_path(req.model_name, env_name)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        with open(log_path, "a") as f:
            f.write(f"[Async Register] Allocated log for model={req.model_name} env={env_name} at {ts}\n")
            f.flush()

        # Run registration in background on a thread to avoid blocking the event loop/worker
        async def _run():
            try:
                from app.services.tasks import register_custom_node_endpoint as service_register_custom_node_endpoint
                res = await asyncio.to_thread(
                    service_register_custom_node_endpoint,
                    model_name=req.model_name,
                    python_version=req.python_version,
                    service_path=resolve_path(req.service_path),
                    dependency_path=resolve_path(req.dependency_path),
                    factory=req.factory,
                    description=req.description,
                    port=req.port,
                    env_name=req.env_name,
                    install_dependencies=req.install_dependencies,
                    io_specs={
                        "inputs": req.inputs,
                        "outputs": req.outputs,
                    } if (req.inputs is not None or req.outputs is not None) else None,
                    log_path=log_path,
                    is_remote=req.is_remote,
                    remote_host=req.remote_host,
                    mnt_path=req.mnt_path,
                )
                # Append result to log for visibility
                try:
                    with open(log_path, "a") as lf:
                        lf.write(f"\n[Async Register] Result: {res}\n")
                        lf.flush()
                except Exception:
                    pass
            except Exception as e:
                try:
                    with open(log_path, "a") as lf:
                        lf.write(f"\n[Async Register] Error: {e}\n")
                        lf.flush()
                except Exception:
                    pass

        track_background_task(
            asyncio.create_task(_run()), f"register_tasknode({req.model_name})"
        )

        return success_response({
            "status": "starting",
            "model_name": req.model_name,
            "env_name": env_name,
            "log_path": log_path,
        })
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.get("/v1/list_factory_models")
def list_factory_models():
    try:
        
        # data = model_store.get_registry_or_preset()
        category_map = model_store.get_category_map() or {}
        return success_response(category_map)

    except Exception as e:
        logger.exception("[list_factory_models] failed")
        return error_response(f"API Error: {str(e)}")

@tasks_router.get("/v1/get_status")
def get_status(request: Request):
    """
    Return the status of each node in the current workflow as Server-Sent Events (SSE).
    
    Status codes:
        0 - Not started
        1 - Running
        2 - Completed
    
    This endpoint uses SSE to continuously send status updates to the client.
    Status is tracked per user id.
    """
    uid = _authenticate_sse_query(request)
    
    # Import the event generator from the service layer
    from app.services.tasks import generate_node_status_events
    
    # Return a streaming response using the service layer's event generator
    return StreamingResponse(
        generate_node_status_events(uid),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"  # Needed for some Nginx setups
        }
    )

@tasks_router.post("/v1/save_annotation")
def save_annotation(req: dict, background_tasks: BackgroundTasks, request: Request):
    """
    Receive annotation data and save to Zarr file
    """
    # Check samples and data directory restriction BEFORE path processing
    path = req.get("path", "")
    _, denied = guard_write_path(request, path, "annotate")
    if denied is not None:
        return denied
    
    # Get instanceId from header
    from app.utils.common.request import get_instance_id
    instance_id = get_instance_id(request)
    if not instance_id:
        return error_response("X-Instance-ID header is required")
    # The path ACL says nothing about the session: without this a caller could
    # drive another viewer's handler (and its caches) with their own path.
    denied = guard_instance_owner(request, instance_id, "save annotation")
    if denied is not None:
        return denied

    req = _patch_dict_paths(req)
    # Add instanceId to request for service layer
    req['instance_id'] = instance_id
    
    # Call service layer's save_annotation function
    from app.services.tasks import save_annotation as service_save_annotation
    
    # Resolve instance handler (required for annotation writes that update in-memory state)
    from app.services.seg_registry import get_annotation_handler
    handler = get_annotation_handler(instance_id)
    if not handler:
        return error_response("No segmentation handler for instance; open the slide first")
    result = service_save_annotation(handler, req, background_tasks)
    
    # Construct API response based on service layer result
    if result.get("success", False):
        return success_response({"message": result.get("message", "Annotation saved")})
    else:
        return error_response(result.get("error", "Unknown error occurred while saving annotation"))


@tasks_router.post("/v1/save_manual_annotation")
def save_manual_annotation_endpoint(req: dict, request: Request):
    """Persist one freeform Annotorious drawing into User-Annotations/manual.json."""
    path = req.get("path", "")
    _, denied = guard_write_path(request, path, "annotate")
    if denied is not None:
        return denied

    req = _patch_dict_paths(req)
    result = service_save_manual_annotation(req.get("path", ""), req)
    if result.get("success"):
        return success_response({
            "message": result.get("message", "Manual annotation saved"),
            "id": result.get("id"),
        })
    return error_response(result.get("error", "Failed to save manual annotation"))


@tasks_router.get("/v1/list_manual_annotations")
def list_manual_annotations_endpoint(request: Request):
    """List freeform drawings from User-Annotations/manual.json for a slide sidecar."""
    path = request.query_params.get("path", "")
    if not path:
        return error_response("path is required")
    # Read ACL only. Viewer hydrate still needs this list.
    resolved_path, denied = authorize_read_or_response(
        request, path, operation="list annotations"
    )
    if denied is not None:
        return denied
    patched = _patch_dict_paths({"path": resolved_path or path})
    try:
        # Corrupt manual.json must error — hydrate must not wipe the canvas
        # by treating a parse failure as an empty list.
        annotations = load_manual_annotations(patched.get("path", resolved_path or path))
    except Exception as e:
        return error_response(f"Failed to read manual annotations: {e}")
    return success_response({"annotations": annotations, "total": len(annotations)})


@tasks_router.post("/v1/delete_manual_annotation")
def delete_manual_annotation_endpoint(req: dict, request: Request):
    """Delete one freeform drawing from User-Annotations/manual.json by id."""
    path = req.get("path", "")
    _, denied = guard_write_path(request, path, "annotate")
    if denied is not None:
        return denied

    req = _patch_dict_paths(req)
    result = service_delete_manual_annotation(req.get("path", ""), req.get("id", ""))
    if result.get("success"):
        return success_response({
            "message": result.get("message", "Manual annotation deleted"),
            "id": result.get("id"),
        })
    return error_response(result.get("error", "Failed to delete manual annotation"))


@tasks_router.post("/v1/save_patch")
# Keep req: dict if frontend sends polygon_points inside the body
# Alternatively, define a Pydantic model for the body
# async def save_patch(tissue_data: TissueSaveRequest, background_tasks: BackgroundTasks):
def save_patch(req: dict, background_tasks: BackgroundTasks, request: Request):
    """
    Receive tissue area coordinates (BBox) and optional polygon points in request body,
    find precise matching patches, and save classification to Zarr file.
    """
    # Check samples and data directory restriction BEFORE path processing
    path = req.get("path", "")
    _, denied = guard_write_path(request, path, "annotate tissue")
    if denied is not None:
        return denied
    
    req = _patch_dict_paths(req)
    from app.utils.common.request import get_instance_id
    instance_id = get_instance_id(request)
    if not instance_id:
        return error_response("X-Instance-ID header is required")
    # See save_annotation: the path ACL does not cover session ownership.
    denied = guard_instance_owner(request, instance_id, "save tissue annotation")
    if denied is not None:
        return denied
    req['instance_id'] = instance_id

    from app.services.tasks import save_patch as service_save_patch
    from app.services.seg_registry import get_annotation_handler
    handler = get_annotation_handler(instance_id)
    if not handler:
        return error_response("No segmentation handler for instance; open the slide first")
    result = service_save_patch(handler, req, background_tasks)

    # Construct API response based on service layer result
    if result.get("success", False):
        return success_response({
            "message": result.get("message", "Tissue annotation saved"),
            # Return the precise indices found
            "matching_indices": result.get("matching_indices", [])
        })
    else:
        # Consider returning appropriate HTTP status codes based on error type
        return error_response(result.get("error", "Unknown error occurred"), code=400 if "coordinate" in result.get("error", "").lower() else 500)

@tasks_router.post("/v1/classification")
def run_classification(req: dict, request: Request):
    """ Run classification operation """
    path = req.get("path") or req.get("zarr_path") or ""
    _, denied = guard_write_path(request, path, "run classification")
    if denied is not None:
        return denied
    req = _patch_dict_paths(req)
    # Call service layer's run_classification function
    from app.services.tasks import run_classification as service_run_classification
    
    result = service_run_classification(req)
    
    # Construct API response based on service layer result
    if result.get("success", False):
        return success_response({
            "message": result.get("message", "Classification operation completed successfully"),
            "result": result.get("result", {})
        })
    else:
        return error_response(result.get("error", "Unknown error occurred during classification"))

@tasks_router.post("/v1/nuclei_classification/cell_review_tile")
async def get_cell_review_tile(request: Request):
    """
    Get 40x magnification tile crop centered on a specific cell for review.
    Returns cropped image and optional contour data.

    Read ACL only — Viewer/Samples can browse Review tiles. Yes/No persist
    still goes through write-gated annotation endpoints.
    """
    from app.services.tasks import get_cell_review_tile_data
    data = await request.json()
    _, denied = await authorize_read_or_response_async(
        request, data.get("slide_id", ""), operation="review tile"
    )
    if denied is not None:
        return denied
    
    # Validate required fields
    required_fields = ["slide_id", "cell_id", "centroid"]
    for field in required_fields:
        if field not in data:
            return error_response(f"Missing required field: {field}")
    
    # Set default values for optional parameters
    data.setdefault("window_size_px", 512)
    data.setdefault("padding_ratio", 0.2)
    data.setdefault("magnification", 40)
    data.setdefault("return_contour", True)
    data.setdefault("contour_type", None)  # None: no contour, 'polygon': precise contour, 'rect': bbox contour
    
    # Patch paths
    data = _patch_dict_paths(data)

    result = await asyncio.to_thread(get_cell_review_tile_data, data)

    if result.get("success", False):
        return success_response(result.get("data", {}))
    else:
        return error_response(result.get("error", "Unknown error occurred during cell review tile generation"))

@tasks_router.post("/v1/reset_classification", summary="Reset classification and annotation data in Zarr file")
async def reset_classification_data_endpoint(request: Request):
    """
    Resets classification results and user annotations in the specified Zarr file.
    This involves deleting the 'Cell-Classification' and 'User-Annotations' groups.
    """
    from app.services.tasks import reset_zarr_classification_data
    data = await request.json()
    zarr_path = data.get("zarr_path")
    if not zarr_path:
        return error_response("zarr_path is required")
    _, denied = await guard_write_path_async(request, zarr_path, "reset classification")
    if denied is not None:
        return denied

    # Off the loop: this opens the store for write, so it waits on zarr_lock
    # (120s timeout) and then deletes a whole classification group — thousands
    # of chunk files on a real slide. Inline it froze every other request and
    # websocket message for that entire time.
    result = await asyncio.to_thread(
        reset_zarr_classification_data, resolve_path(zarr_path)
    )

    if result["status"] == "error":
        return error_response(result["message"])
        
    return success_response(result)

@tasks_router.post("/v1/reset_patch_classification", summary="Reset patch classification (tissue_*) and user annotations in Zarr file, preserving MuskNode embeddings")
async def reset_patch_classification_endpoint(request: Request):
    from app.services.tasks import reset_patch_classification_data
    data = await request.json()
    zarr_path = data.get("zarr_path")
    if not zarr_path:
        return error_response("zarr_path is required")
    _, denied = await guard_write_path_async(request, zarr_path, "reset patch classification")
    if denied is not None:
        return denied
    # Off the loop — same write-mode zarr_lock and group delete as above.
    result = await asyncio.to_thread(
        reset_patch_classification_data, resolve_path(zarr_path)
    )
    if result.get("status") != "success":
        return error_response(result.get("message", "Failed to reset patch classification"))
    return success_response(result)

@tasks_router.post("/v1/reset_tissue_segmentation", summary="Remove VISTA's Tissue-Segmentation group (downstream of patch classification)")
async def reset_tissue_segmentation_endpoint(request: Request):
    from app.services.tasks import reset_tissue_segmentation_data
    data = await request.json()
    zarr_path = data.get("zarr_path")
    if not zarr_path:
        return error_response("zarr_path is required")
    _, denied = await guard_write_path_async(request, zarr_path, "reset tissue segmentation")
    if denied is not None:
        return denied
    # Off the loop — opens the store for write and deletes a group.
    result = await asyncio.to_thread(
        reset_tissue_segmentation_data, resolve_path(zarr_path)
    )
    if result.get("status") == "error":
        return error_response(result.get("message", "Failed to reset tissue segmentation"))
    return success_response(result)

@tasks_router.post("/v1/clear_workflow")
def clear_workflow(
    req: ClearWorkflowRequest,
    auth_user: Optional[AuthUser] = Depends(get_optional_auth_user),
):
    """
    Clear TaskNodeManager workflow graph (optional workflow_id).
    When clearing all, only resets the authenticated user's script flags.
    """
    try:
        # Call service layer's clear_workflow function
        from app.services.tasks import clear_workflow as service_clear_workflow
        
        workflow_id = req.workflow_id
        uid = getattr(auth_user, "uid", None) if auth_user else None
        result = service_clear_workflow(workflow_id, uid=uid)
        
        # Get result fields
        success = result.get("success", False)
        cleared = result.get("cleared", [])
        reset_only = result.get("reset_only", False)
        error_msg = result.get("error", "Unknown error when clearing workflow")
        
        # Construct API response based on service layer result
        if success:
            return success_response({
                "cleared": cleared,
                "reset_only": reset_only
            })
        else:
            return error_response(error_msg)
    except Exception as e:
        return error_response(f"API Error: {str(e)}")

@tasks_router.get("/v1/list_node_ports")
def list_node_ports(skip_health_checks: bool = False):
    """
    List all TaskNodes and their port numbers.
    
    This endpoint collects port information from:
    1. The services dictionary
    2. The TaskNodeManager nodes
    3. Custom nodes from the custom node registry
    
    Args:
        skip_health_checks: Query parameter to skip health checks for remote nodes
    
    Returns:
    - A dictionary with node names as keys and port numbers as values
    - Additional metadata about the nodes where available (e.g., running status, factory)
    """
    try:
        # Call service layer's list_node_ports function
        from app.services.tasks import list_node_ports as service_list_node_ports
        
        result = service_list_node_ports(skip_health_checks=skip_health_checks)
        
        # Get result fields
        success = result.get("success", False)
        nodes = result.get("nodes", {})
        error_msg = result.get("error", "Unknown error listing node ports")
        
        # Construct API response based on service layer result
        if success:
            # Enrich with runtime config stored in ModelStore (env_name, service_path, dependency_path, python_version)
            try:
                store_nodes = model_store.get_nodes_extended()
                for name, info in nodes.items():
                    runtime = store_nodes.get(name, {}).get("runtime")
                    if isinstance(runtime, dict):
                        # only set fields if not already present
                        for k in ["env_name", "service_path", "dependency_path", "python_version", "port"]:
                            if k in runtime and runtime[k] is not None and not info.get(k):
                                info[k] = runtime[k]
            except Exception:
                pass
            return success_response({"nodes": nodes})
        else:
            return error_response(error_msg)
    except Exception as e:
        logger.error(f"Error listing node ports: {str(e)}", exc_info=e)
        return error_response(f"Error listing node ports: {str(e)}")


@tasks_router.get("/v1/list_conda_envs")
def list_conda_envs():
    try:
        result = list_available_conda_envs()
        if result.get("status") == "success":
            return success_response({"envs": result.get("envs", [])})
        else:
            msg = result.get("message", "Failed to list conda envs")
            logger.error(f"list_conda_envs error: {msg}")
            return error_response(msg)
    except Exception as e:
        # No local `from app.core import logger`: the module imports it, and a
        # local import binds the name for the whole function, so the
        # logger.error above raised UnboundLocalError and this handler reported
        # that instead of why listing the envs actually failed.
        logger.exception(f"Unhandled error in list_conda_envs: {e}")
        return error_response(f"Error listing conda envs: {str(e)}")

@tasks_router.get("/v1/list_nodes_extended")
def list_nodes_extended():
    try:
        model_store.reload()

        nodes = model_store.get_nodes_extended() or {}
        category_map = model_store.get_category_map() or {}
        category_display_names = model_store.get_category_display_names() or {}

        for node_name, node_data in nodes.items():
            if isinstance(node_data, dict) and "runtime" in node_data:
                runtime = node_data.get("runtime", {})
                if isinstance(runtime, dict) and "service_path" in runtime:
                    service_path = runtime.get("service_path")
                    if isinstance(service_path, str):
                        exists = os.path.exists(service_path)
                        is_executable = exists and os.access(service_path, os.X_OK)
                        runtime["bundle_exists"] = exists and is_executable

        return success_response({
            "nodes": nodes,
            "category_map": category_map,
            "category_display_names": category_display_names,
        })
    except Exception as e:
        return error_response(f"Error listing nodes: {str(e)}")

@tasks_router.post("/v1/reload_model_registry")
def reload_model_registry():
    """
    Force reload the model registry from disk.
    Use this after external processes (like Electron) modify the registry file.
    """
    try:
        model_store.reload()
        return success_response({"message": "Model registry reloaded successfully"})
    except Exception as e:
        logger.error(f"Error reloading model registry: {str(e)}", exc_info=e)
        return error_response(f"Error reloading model registry: {str(e)}")
    
class DeleteNodeRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    model_name: str


@tasks_router.post("/v1/delete_node")
def delete_node(req: DeleteNodeRequest):
    try:
        removed = model_store.delete_node(req.model_name)
        if removed:
            return success_response({"message": f"Node '{req.model_name}' deleted"})
        else:
            return error_response(f"Node '{req.model_name}' not found")
    except Exception as e:
        return error_response(f"Error deleting node: {str(e)}")


class StopNodeRequest(BaseModel):
    env_name: str


@tasks_router.post("/v1/stop_node")
def stop_node(req: StopNodeRequest):
    try:
        result = stop_custom_node_env(req.env_name)
        if result.get("status") == "success":
            return success_response({"message": result.get("message", "Stopped")})
        else:
            return error_response(result.get("message", "Failed to stop node"))
    except Exception as e:
        return error_response(f"Error stopping node: {str(e)}")


@tasks_router.post("/v1/stop_node_process")
def stop_node_process(req: StopNodeRequest):
    try:
        logger.debug(f"[stop_node_process] request env_name={req.env_name}")
        # Now env_name may be a composite key or an env; accept both
        result = stop_custom_node_process(req.env_name)
        logger.debug(f"[stop_node_process] result={result}")
        if result.get("status") == "success":
            return success_response({"message": result.get("message", "Stopped process")})
        else:
            return error_response(result.get("message", "Failed to stop process"))
    except Exception as e:
        logger.exception(f"[stop_node_process] error: {e}")
        return error_response(f"Error stopping node process: {str(e)}")

@tasks_router.get("/v1/get_node_classifier_counts")
def get_node_classifier_counts():
    """
    Get classifier counts for each node
    """
    try:
        # Return mock data or implement actual counting logic
        classifier_counts = {
            'MUSK': 0,
            'BiomedParse': 0, 
            'TotalSegmentator': 0,
            'CellViT': 0,
            'HoverNet': 0,
            'UNI': 0
        }
        return success_response(classifier_counts)
    except Exception as e:
        logger.error(f"Error getting node classifier counts: {str(e)}", exc_info=e)
        return error_response(f"Error getting node classifier counts: {str(e)}")

class StopWorkflowRequest(BaseModel):
    zarr_path: str

@tasks_router.post("/v1/stop_workflow")
async def stop_workflow(req: StopWorkflowRequest, auth_user: AuthUser = Depends(get_auth_user)):
    """
    Stop the authenticated user's current workflow (cooperative /cancel only).
    """
    try:
        from app.services.tasks import stop_workflow_async

        result = await stop_workflow_async(
            resolve_path(req.zarr_path),
            uid=auth_user.uid,
        )

        # Handle result
        if result.get("success", False):
            payload = {
                "message": result.get("message", "Workflow stopped successfully"),
            }
            if result.get("status") is not None:
                payload["status"] = result.get("status")
            if result.get("forced") is not None:
                payload["forced"] = result.get("forced")
            return success_response(payload)
        else:
            err = result.get("error", "Failed to stop workflow")
            code = result.get("code")
            if code is None:
                # Prefer 404 for missing run over internal 500.
                code = 404 if "no running workflow" in str(err).lower() else 409
            return error_response(err, code=int(code))
    except Exception as e:
        logger.exception(f"[stop_workflow] error: {e}")
        return error_response(f"Error stopping workflow: {str(e)}")

class UpdateProgressRequest(BaseModel):
    node_name: str
    progress: int

@tasks_router.post("/v1/update_progress")
def update_progress(req: UpdateProgressRequest):
    """
    Update the progress of a specific node
    """
    try:
        from app.services.tasks import update_node_progress
        
        # Validate progress value
        if not (0 <= req.progress <= 100):
            return error_response("Progress must be between 0 and 100")
        
        update_node_progress(req.node_name, req.progress)
        
        return success_response({
            "message": f"Progress updated for {req.node_name}: {req.progress}%"
        })
    except Exception as e:
        logger.exception(f"[update_progress] error: {e}")
        return error_response(f"Error updating progress: {str(e)}")

# Panel configuration management
@tasks_router.post("/v1/save_panel_config")
def save_panel_config(req: dict):
    """
    Save custom panel configuration for a model
    """
    try:
        model_name = req.get("model_name")
        panel_config = req.get("panel_config")
        
        if not model_name or not panel_config:
            return error_response("model_name and panel_config are required")
        
        # Save panel configuration using ModelStore
        success = model_store.save_panel_config(model_name, panel_config)
        
        if success:
            return success_response({
                "message": f"Panel configuration saved for {model_name}",
                "model_name": model_name
            })
        else:
            return error_response(f"Model {model_name} not found or failed to save")
            
    except Exception as e:
        logger.exception(f"[save_panel_config] error: {e}")
        return error_response(f"Error saving panel configuration: {str(e)}")

@tasks_router.get("/v1/get_panel_config/{model_name}")
def get_panel_config(model_name: str):
    """
    Get custom panel configuration for a model
    """
    try:
        panel_config = model_store.get_panel_config(model_name)
        
        if panel_config is not None:
            return success_response({
                "model_name": model_name,
                "panel_config": panel_config
            })
        else:
            return error_response(f"Panel configuration not found for {model_name}")
            
    except Exception as e:
        logger.exception(f"[get_panel_config] error: {e}")
        return error_response(f"Error getting panel configuration: {str(e)}")

@tasks_router.get("/v1/get_all_panel_configs")
def get_all_panel_configs():
    """
    Get all panel configurations
    """
    try:
        panel_configs = model_store.get_all_panel_configs()
        return success_response(panel_configs)
    except Exception as e:
        logger.exception(f"[get_all_panel_configs] error: {e}")
        return error_response(f"Error getting all panel configurations: {str(e)}")

@tasks_router.get("/v1/list_all_panel_configs")
def list_all_panel_configs():
    """
    Get all custom panel configurations
    """
    try:
        panel_configs = model_store.get_all_panel_configs()
        
        return success_response({
            "panel_configs": panel_configs
        })
        
    except Exception as e:
        logger.exception(f"[list_all_panel_configs] error: {e}")
        return error_response(f"Error listing panel configurations: {str(e)}")


class GetZarrStructureRequest(BaseModel):
    zarr_path: str


class GetH5StructureRequest(BaseModel):
    h5_path: str


@tasks_router.post("/v1/get_h5_structure")
def get_h5_structure_api(payload: GetH5StructureRequest, request: Request):
    """Retrieve the structure of an HDF5 file."""
    if h5py is None:
        return error_response("h5py is not installed")
    h5_path = payload.h5_path or ""
    if not h5_path:
        return error_response("h5_path is required")
    resolved_path, denied = authorize_read_or_response(
        request, h5_path, operation="read H5 structure"
    )
    if denied is not None:
        return denied
    try:
        if not os.path.exists(resolved_path):
            return error_response(f"H5 file not found: {h5_path}")
        with h5py.File(resolved_path, "r") as h5_file:
            logger.info(f"read h5 file {resolved_path} successfully")
            structure = _process_node_h5("/", h5_file)
            return success_response(structure)
    except Exception as e:
        logger.exception(f"[get_h5_structure] error: {e}")
        return error_response(f"Error getting H5 structure: {str(e)}")


@tasks_router.post("/v1/get_zarr_structure")
def get_zarr_structure_api(payload: GetZarrStructureRequest, request: Request):
    """
    Retrieve the structure of a Zarr file and return it as a nested dictionary,
    including the names of groups and datasets.
    
    Request body:
    {
        "zarr_path": "path/to/workflow_data.zarr"
    }
    """
    try:
        # Resolve the path to absolute path
        resolved_zarr_path, denied = authorize_read_or_response(
            request, payload.zarr_path, operation="read Zarr structure"
        )
        if denied is not None:
            return denied
        
        # Verify file exists
        if not os.path.exists(resolved_zarr_path):
            return error_response(f"Zarr file not found: {payload.zarr_path}")
        
        # Open the Zarr file and retrieve its structure
        try:
            with open_zarr_cm(resolved_zarr_path, 'r') as zarr_file:
                logger.info(f"read zarr file {resolved_zarr_path} successfully")
                structure = process_node("/", zarr_file)
                return success_response(structure)
        except Exception as e:
            logger.error(f"failed to get zarr structure: {str(e)}", exc_info=e)
            return error_response(f"failed to get zarr structure: {str(e)}")
    except Exception as e:
        logger.exception(f"[get_zarr_structure] error: {e}")
        return error_response(f"Error getting Zarr structure: {str(e)}")


class ExecuteScriptRequest(BaseModel):
    zarr_path: str
    code_str: str


class GenerateScriptRequest(BaseModel):
    zarr_path: str
    prompt: str


@tasks_router.post("/v1/generate_script")
async def generate_script(
    request: GenerateScriptRequest,
    http_request: Request,
    auth_user: Optional[AuthUser] = Depends(get_optional_auth_user),
):
    """Generate a Python analysis script from a prompt.

    Forwards to the Control Service coding agent (/agent/v1/process_script) via the
    existing `_generate_script_output`. Standalone — does NOT run the workflow
    graph; pairs with the standalone /execute_script run.
    """
    from app.services.tasks import _generate_script_output
    resolved_path, denied = await authorize_read_or_response_async(
        http_request, request.zarr_path, operation="generate script"
    )
    if denied is not None:
        return denied
    result = await _generate_script_output(
        request.prompt,
        resolved_path,
        auth_header=http_request.headers.get("Authorization"),
        uid=getattr(auth_user, "uid", None),
    )
    if result.get("error"):
        return error_response(result["error"])
    return success_response({"generated_script": result.get("generated_script", "")})


class SummaryAnswerRequest(BaseModel):
    agent_id: str
    prompt: str
    parameters: Optional[Dict[str, Any]] = None


@tasks_router.post("/v1/execute_script")
async def execute_script(
    request: ExecuteScriptRequest,
    http_request: Request,
    auth_user: Optional[AuthUser] = Depends(get_optional_auth_user),
):
    """
    Execute a custom analysis script
    Sets TL_EXPORT_DIR for authenticated web users to route outputs to their personal folder.
    Request example:
    {
        "zarr_path": "path/to/data.zarr",
        "code_str": "def analyze_medical_image(path):\n    ..."
    }
    """
    script_answer_wait_active = False
    _exec_uid: Optional[str] = None
    try:
        # For authenticated web users (not Electron), prepend TL_EXPORT_DIR to route outputs to their personal folder
        # The codeexec sandbox mounts the user's own outputs folder
        # (users/{uid}/outputs) read-write at its real path and points TL_EXPORT_DIR
        # there — the one place generated code may write. The user's own folder
        # (users/{uid}) + the shared public data are mounted read-only (read your own
        # uploads for reference); OTHER users' data is NOT mounted. The input zarr is
        # read-only too. So the code reads only its own + shared data and writes only
        # its own outputs.
        code_to_execute = request.code_str
        user_export_dir = None
        absolute_export_path = None
        if auth_user and getattr(auth_user, 'uid', None) and not _is_electron_client(http_request):
            user_export_dir = f"users/{auth_user.uid}/outputs"
            absolute_export_path = resolve_path(user_export_dir)
        
        # Convert relative path to absolute path using storage root
        resolved_zarr_path, denied = await guard_write_path_async(
            http_request, request.zarr_path, "execute script"
        )
        if denied is not None:
            return denied
        
        # Verify file exists before attempting execution
        if not os.path.exists(resolved_zarr_path):
            return error_response("Zarr file not found")

        _exec_uid = auth_user.uid if auth_user and getattr(auth_user, "uid", None) else None
        
        # Prepare a timestamped log file under storage/tasknode_logs (same as task nodes)
        try:
            # logs_dir relative to this file: app/api/ -> go to project root and into storage/tasknode_logs
            logs_base_dir = os.path.join(SERVICE_STORAGE_DIR, "tasknode_logs")
            os.makedirs(logs_base_dir, exist_ok=True)
            
            # Create date-based subdirectory (e.g., 2025-10-09) to match other task node logs
            today_stamp = datetime.now().strftime("%Y-%m-%d")
            day_dir = os.path.join(logs_base_dir, today_stamp)
            os.makedirs(day_dir, exist_ok=True)
            
            zarr_base = os.path.splitext(os.path.basename(resolved_zarr_path))[0]
            safe_zarr = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in zarr_base)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_path = os.path.join(day_dir, f"CodeScript__{safe_zarr}__{ts}.log")
        except Exception:
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_path = os.path.abspath(f"CodeScript__{ts}.log")

        with open(log_path, "w", encoding="utf-8") as lf:
            # Write header and script snapshot
            try:
                lf.write(f"[Code Run] {datetime.now().isoformat()}\n")
                lf.write(f"Zarr Path (original): {request.zarr_path}\n")
                lf.write(f"Zarr Path (resolved): {resolved_zarr_path}\n")
                if auth_user and getattr(auth_user, 'uid', None):
                    lf.write(f"User: {auth_user.uid}\n")
                    if user_export_dir:
                        lf.write(f"Export Directory: {user_export_dir}\n")
                    else:
                        lf.write(f"Export Directory: N/A (Electron client or not configured)\n")
                lf.write("--- Begin Script ---\n")
                lf.write(code_to_execute)
                lf.write("\n--- End Script ---\n\n")
                lf.flush()
            except Exception:
                pass

            # Run the user/agent code through the codeexec pipeline:
            #   guard (static) -> LLM review -> sandbox (Docker / subprocess fallback).
            # The sandbox owns per-user isolation, resource limits and timeout.
            begin_script_summary_wait(_exec_uid)
            script_answer_wait_active = True
            lf.write("--- Execution Started ---\n")
            lf.write(f"Start time: {datetime.now().isoformat()}\n")
            lf.flush()
            execution_start = datetime.now()

            from app.services.codeexec import run_user_code, ExecRequest
            from app.config.path_config import PUBLIC_DATA_PATH
            # Read-only mounts: the user's OWN folder (their uploaded data, for
            # reference) + the shared public-data root (samples are symlinked out to
            # it). NOT other users' data. The code can READ these but only WRITE the
            # user's own output dir. The input zarr is mounted separately (read-only),
            # so an opened sample/shared zarr is still readable even if outside these.
            read_roots = []
            if absolute_export_path:
                _user_root = os.path.dirname(absolute_export_path.rstrip("/"))  # users/{uid}
                if os.path.isdir(_user_root):
                    read_roots.append(_user_root)
            if PUBLIC_DATA_PATH and os.path.isdir(PUBLIC_DATA_PATH):
                read_roots.append(PUBLIC_DATA_PATH)
            loop = asyncio.get_event_loop()
            # Concurrency gate: at most CODEEXEC_MAX_CONCURRENCY sandboxes run at once
            # (default 1 = strictly one at a time); the rest await here, FIFO.
            async with _get_codeexec_semaphore():
                exec_result = await loop.run_in_executor(
                    _codeexec_executor,
                    run_user_code,
                    ExecRequest(
                        code=code_to_execute,
                        zarr_path=resolved_zarr_path,
                        output_dir=absolute_export_path,
                        read_roots=read_roots,
                        uid=_exec_uid,
                    ),
                )

            duration = (datetime.now() - execution_start).total_seconds()
            lf.write(f"\nDuration: {duration:.2f}s  backend={exec_result.backend or 'rejected'}\n")
            if exec_result.rejected_by:
                lf.write(f"--- BLOCKED by {exec_result.rejected_by}: {exec_result.reject_reason} ---\n")
            lf.write("\n--- Execution Result ---\n")
            try:
                lf.write(json.dumps(exec_result.to_payload(), indent=2, default=str))
            except Exception:
                lf.write(str(exec_result.to_payload()))
            lf.write("\n--- Execution Complete ---\n")
            lf.flush()

        # A safety layer (guard / LLM review) blocked the code -> clear error.
        if exec_result.rejected_by:
            if script_answer_wait_active:
                end_script_summary_wait(
                    _exec_uid,
                    error_code=4403,
                    error_message=f"Blocked by {exec_result.rejected_by}: {exec_result.reject_reason}",
                )
                script_answer_wait_active = False
            return error_response(
                f"Code was blocked by the {exec_result.rejected_by} safety check: {exec_result.reject_reason}"
            )

        # JSON-safe payload (already JSON-able from the sandbox); include log path.
        safe_log_path = sanitize_client_path(log_path)
        try:
            logs_base = os.path.abspath(
                os.path.join(
                    os.path.dirname(os.path.dirname(__file__)),
                    "..",
                    "storage",
                    "tasknode_logs",
                )
            )
            abs_log = os.path.abspath(log_path)
            if abs_log == logs_base or abs_log.startswith(logs_base + os.sep):
                safe_log_path = os.path.relpath(abs_log, logs_base).replace("\\", "/")
        except Exception:
            pass
        execution_payload = {
            **convert_for_json(exec_result.to_payload()),
            "log_path": safe_log_path,
        }

        return success_response({
            "zarr_path": sanitize_client_path(resolved_zarr_path),
            "execution_result": execution_payload
        })
    except Exception as e:
        if script_answer_wait_active:
            try:
                end_script_summary_wait(
                    _exec_uid,
                    error_code=4500,
                    error_message=f"Execution failed: {str(e)}",
                )
            except Exception:
                pass
            script_answer_wait_active = False
        # Append error/traceback to log file when possible
        try:
            fallback_logs_base_dir = os.path.join(SERVICE_STORAGE_DIR, "tasknode_logs")
            os.makedirs(fallback_logs_base_dir, exist_ok=True)
            
            # Use date-based subdirectory for error logs too
            today_stamp = datetime.now().strftime("%Y-%m-%d")
            fallback_day_dir = os.path.join(fallback_logs_base_dir, today_stamp)
            os.makedirs(fallback_day_dir, exist_ok=True)
            
            fallback_error_log = os.path.join(fallback_day_dir, "CodeScript__error.log")
            with open(locals().get("log_path", fallback_error_log), "a", encoding="utf-8") as lf:
                lf.write("\n--- Error ---\n")
                lf.write(str(e) + "\n")
                lf.write(traceback.format_exc() + "\n")
        except Exception:
            pass
        return error_response("Execution failed")


@tasks_router.post("/v1/summary_answer")
async def agent_summary(
    request: SummaryAnswerRequest,
    http_request: Request,
    auth_user: Optional[AuthUser] = Depends(get_optional_auth_user),
):
    """
    Return natural language summary of the answer via the in-process agent,
    falling back to a template summary when the agent is not configured.
    """
    try:
        question = request.prompt
        parameters = request.parameters or {}
        answer = parameters.get("answer")
        if answer is None:
            raise ValueError("Missing 'answer' in parameters")

        response_text: Optional[str] = None
        ctrl_error: Optional[str] = None

        # In-process LLM agent (formerly a round trip to the control plane)
        try:
            from app.services.agent.workflow_agent import get_workflow_agent
            response_text = await get_workflow_agent().summary_answer(question, answer)
        except Exception as exc:
            ctrl_error = str(exc)

        # Fallback to a local template summary if the agent is unavailable
        if not response_text:
            try:
                # Simple local fallback: generate a basic summary from the answer
                response_text = _generate_simple_summary(question, answer)
                logger.warning(f"[summary_answer] agent failed ({ctrl_error}), using local fallback")
            except Exception as fallback_exc:
                # If fallback also fails, set response_text to empty string (matching original behavior)
                # Original implementation would set response_text = "" and still call post_answer
                fallback_error = str(fallback_exc)
                if not ctrl_error:
                    ctrl_error = fallback_error
                else:
                    # Include both errors in ctrl_error for logging
                    ctrl_error = f"{ctrl_error}. Local fallback also failed: {fallback_error}"
                response_text = ""  # Empty string, matching original behavior
                logger.warning(f"[summary_answer] Both agent and fallback failed: {ctrl_error}")

        # Ensure Chatbox poller receives the summary (with user-specific state)
        # Always call post_answer, even if response_text is empty (matching original behavior)
        # This ensures the Chatbox polling system receives an update and stops waiting
        try:
            uid = auth_user.uid if auth_user else None
            post_answer(response_text or "", uid=uid)
        except Exception:
            pass

        response = {
            "agent_id": request.agent_id,
            "response": response_text,
            "parameters": request.parameters,
            "control_error": ctrl_error,
        }

        # Always return success_response, matching original behavior
        # This ensures the frontend receives a response and can handle empty response_text appropriately
        return success_response(response)
    except Exception as e:
        return error_response(str(e))
