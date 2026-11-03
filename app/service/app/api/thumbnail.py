from fastapi import APIRouter, Body, Query, Request
from typing import Dict, Any
import asyncio
import traceback

from app.core.response import success_response, error_response, permission_denied_response
from app.core.access import (
    authorize_read_or_response,
    authorize_read_or_response_async,
    guard_instance_owner,
    request_uid,
)
from app.services.thumbnail import thumbnail_worker, start_thumbnail_worker
from app.api.schema.thumbnail import PreviewBatchRequest, TaskIdsRequest

# Create router
thumbnail_router = APIRouter()


@thumbnail_router.on_event("startup")
async def startup_thumbnail_worker():
    """Ensure the thumbnail worker is running when the API router starts."""
    try:
        start_thumbnail_worker()
        print("[INFO] Thumbnail worker started for /api/thumbnail routes")
    except Exception:
        traceback.print_exc()


@thumbnail_router.on_event("shutdown")
async def shutdown_thumbnail_worker():
    """Shutdown the thumbnail worker when the API router stops."""
    try:
        thumbnail_worker.shutdown()
        print("[INFO] Thumbnail worker shutdown for /api/thumbnail routes")
    except Exception:
        traceback.print_exc()


@thumbnail_router.post("/v1/thumbnails")
async def submit_thumbnail_task(http_request: Request, request: Dict[str, Any] = Body(...)):
    """
    Submit thumbnail generation task to the background thumbnail task queue
    Returns task ID immediately, thumbnail can be retrieved later
    """
    try:
        session_id = request.get('session_id')
        size = request.get('size', 200)
        request_id = request.get('request_id')

        if not session_id:
            return error_response("session_id is required")
        if not request_id:
            return error_response("request_id is required")
        denied = guard_instance_owner(http_request, session_id, "generate thumbnail")
        if denied is not None:
            return denied

        task_id = await thumbnail_worker.submit_thumbnail_task(
            session_id,
            size,
            request_id,
            owner_uid=request_uid(http_request) or "",
        )

        return success_response({
            "task_id": task_id,
            "request_id": request_id,
            "message": "Thumbnail generation task submitted successfully",
            "status": "accepted"
        })
    except Exception as e:
        traceback.print_exc()
        return error_response("Error submitting thumbnail task")


@thumbnail_router.get("/v1/overlay_available")
def overlay_available(
    request: Request,
    file_path: str = Query(..., description="WSI file path (storage-relative)"),
):
    """Report which classification overlays a slide has, for the gallery's
    per-tile Cell/Patch toggle buttons. Cheap array-path check, no slide load."""
    try:
        from app.services.thumbnail.overlay import overlay_available as _avail
        authorized_path, denied = authorize_read_or_response(
            request, file_path, operation="check overlay availability"
        )
        if denied is not None:
            return denied
        return success_response(_avail(authorized_path))
    except Exception as e:
        traceback.print_exc()
        return error_response("Error checking overlay availability")


@thumbnail_router.post("/v1/previews")
async def submit_preview_task(http_request: Request, request: Dict[str, Any] = Body(...)):
    """
    Submit preview generation task to the background thumbnail task queue
    Returns task ID immediately, preview can be retrieved later
    """
    try:
        session_id = request.get('session_id')
        file_path = request.get('file_path')
        preview_type = request.get('preview_type')
        size = request.get('size', 200)
        request_id = request.get('request_id')

        if not session_id and not file_path:
            return error_response("Either session_id or file_path is required")
        if not preview_type:
            return error_response("preview_type is required")
        if not request_id:
            return error_response("request_id is required")

        if session_id:
            denied = guard_instance_owner(http_request, session_id, "generate preview")
            if denied is not None:
                return denied
        authorized_path = file_path
        if file_path:
            authorized_path, denied = await authorize_read_or_response_async(
                http_request, file_path, operation="generate preview"
            )
            if denied is not None:
                return denied

        task_id = await thumbnail_worker.submit_preview_task(
            session_id=session_id,
            preview_type=preview_type,
            size=size,
            file_path=authorized_path,
            request_id=request_id,
            owner_uid=request_uid(http_request) or "",
        )

        return success_response({
            "task_id": task_id,
            "request_id": request_id,
            "message": "Preview generation task submitted successfully",
            "status": "accepted"
        })
    except Exception as e:
        traceback.print_exc()
        return error_response("Error submitting preview task")


def _cached_or_authorized(http_request: Request, file_path: str, preview_type: str, size: int):
    """One slide of a preview batch: ``(authorized_path, cached_result, error)``."""
    try:
        authorized_path, denied = authorize_read_or_response(
            http_request, file_path, operation="generate preview"
        )
        if denied is not None:
            return None, None, "READ_ACCESS_DENIED"
        return authorized_path, thumbnail_worker.cached_preview(authorized_path, preview_type, size), None
    except Exception:
        traceback.print_exc()
        return None, None, "PREVIEW_FAILED"


@thumbnail_router.post("/v1/previews/batch")
async def submit_preview_batch(http_request: Request, payload: PreviewBatchRequest):
    """Previews for a screenful of slides in one call.

    A slide whose preview is already cached comes back with its result; the
    rest get a task id to poll with ``/v1/status/batch``. Each slide is checked
    on its own, and a denied or broken one carries an error code instead of
    failing the batch. Results are keyed by the path as sent.
    """
    paths = list(dict.fromkeys(payload.file_paths))
    checked = await asyncio.gather(*(
        asyncio.to_thread(_cached_or_authorized, http_request, path, payload.preview_type, payload.size)
        for path in paths
    ))
    owner_uid = request_uid(http_request) or ""
    batch_seq = thumbnail_worker.next_batch_seq()
    results = {}
    for index, (path, (authorized_path, cached, error)) in enumerate(zip(paths, checked)):
        if error:
            results[path] = {"error": error}
        elif cached:
            results[path] = {"result": cached}
        else:
            task_id = await thumbnail_worker.submit_preview_task(
                preview_type=payload.preview_type,
                size=payload.size,
                file_path=authorized_path,
                owner_uid=owner_uid,
                batch=(batch_seq, index),
            )
            results[path] = {"task_id": task_id}
    return success_response({"results": results})


@thumbnail_router.post("/v1/status/batch")
async def get_tasks_status_batch(http_request: Request, payload: TaskIdsRequest):
    """Status of several of the caller's tasks, keyed by task id. A task that
    is gone or not the caller's carries an error code."""
    return success_response({
        "statuses": thumbnail_worker.get_tasks_status(
            payload.task_ids, owner_uid=request_uid(http_request) or ""
        )
    })


@thumbnail_router.post("/v1/cancel")
async def cancel_tasks(http_request: Request, payload: TaskIdsRequest):
    """Drop the caller's tasks that have not started — rows scrolled away."""
    return success_response({
        "cancelled": thumbnail_worker.cancel_tasks(
            payload.task_ids, owner_uid=request_uid(http_request) or ""
        )
    })


@thumbnail_router.get("/v1/status/{task_id}")
async def get_task_status(http_request: Request, task_id: str):
    """
    Get the status of a submitted task (caller must own the task).
    """
    try:
        status = await thumbnail_worker.get_task_status(
            task_id,
            owner_uid=request_uid(http_request) or "",
        )

        if status.get("error") == "Task access denied":
            return permission_denied_response(
                access_mode="forbidden",
                operation="read thumbnail status",
                request_id=http_request.headers.get("X-Request-ID"),
                error_code="TASK_OWNER_MISMATCH",
            )

        if "error" in status:
            return error_response(status["error"])

        return success_response(status)
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting task status: {str(e)}")


@thumbnail_router.post("/v1/batch/thumbnails")
async def submit_batch_thumbnail_tasks(http_request: Request, request: Dict[str, Any] = Body(...)):
    """
    Submit multiple thumbnail generation tasks to the background thumbnail task queue
    """
    try:
        session_ids = request.get('session_ids', [])
        size = request.get('size', 200)

        if not session_ids:
            return error_response("session_ids is required")

        for session_id in session_ids:
            denied = guard_instance_owner(http_request, session_id, "generate thumbnail")
            if denied is not None:
                return denied

        task_ids = await thumbnail_worker.submit_batch_thumbnail_tasks(
            session_ids,
            size,
            owner_uid=request_uid(http_request) or "",
        )

        return success_response({
            "task_ids": task_ids,
            "message": f"Submitted {len(task_ids)} thumbnail generation tasks",
            "status": "accepted"
        })
    except Exception as e:
        traceback.print_exc()
        return error_response("Error submitting batch thumbnail tasks")


@thumbnail_router.post("/v1/batch/previews")
async def submit_batch_preview_tasks(http_request: Request, request: Dict[str, Any] = Body(...)):
    """
    Submit multiple preview generation tasks to the background thumbnail task queue
    """
    try:
        requests_data = request.get('requests', [])  # List of {session_id, preview_type, size}

        if not requests_data:
            return error_response("requests is required")

        authorized_requests = []
        for item in requests_data:
            session_id = item.get("session_id")
            file_path = item.get("file_path")
            if session_id:
                denied = guard_instance_owner(http_request, session_id, "generate preview")
                if denied is not None:
                    return denied
            authorized_item = dict(item)
            if file_path:
                authorized_path, denied = await authorize_read_or_response_async(
                    http_request, file_path, operation="generate preview"
                )
                if denied is not None:
                    return denied
                authorized_item["file_path"] = authorized_path
            authorized_requests.append(authorized_item)

        task_ids = await thumbnail_worker.submit_batch_preview_tasks(
            authorized_requests,
            owner_uid=request_uid(http_request) or "",
        )

        return success_response({
            "task_ids": task_ids,
            "message": f"Submitted {len(task_ids)} preview generation tasks",
            "status": "accepted"
        })
    except Exception as e:
        traceback.print_exc()
        return error_response("Error submitting batch preview tasks")


@thumbnail_router.get("/v1/health")
def get_service_health():
    """
    Check the health status of the thumbnail task service
    """
    try:
        return success_response({
            "status": "healthy",
            "service": "ThumbnailWorker",
            "message": "Service is running"
        })
    except Exception as e:
        return error_response(f"Service health check failed: {str(e)}")
