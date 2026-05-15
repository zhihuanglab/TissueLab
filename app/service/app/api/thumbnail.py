from fastapi import APIRouter, Query, Body
from fastapi.responses import JSONResponse
from typing import List, Dict, Any
import traceback

from app.core.response import success_response, error_response
from app.services.thumbnail import thumbnail_worker

# Create router
thumbnail_router = APIRouter()


@thumbnail_router.on_event("startup")
async def startup_thumbnail_worker():
    """Ensure the thumbnail worker is running when the API router starts."""
    try:
        thumbnail_worker.start_worker()
        from app.websocket.thumbnail_consumer import notify_thumbnail_update

        thumbnail_worker.set_ws_notifier(notify_thumbnail_update)
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
async def submit_thumbnail_task(request: Dict[str, Any] = Body(...)):
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
        
        # Submit task to thumbnail task service
        task_id = await thumbnail_worker.submit_thumbnail_task(session_id, size, request_id)
        
        return success_response({
            "task_id": task_id,
            "request_id": request_id,
            "message": "Thumbnail generation task submitted successfully",
            "status": "accepted"
        })
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error submitting thumbnail task: {str(e)}")

@thumbnail_router.post("/v1/previews")
async def submit_preview_task(request: Dict[str, Any] = Body(...)):
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
        
        # Submit task to thumbnail task service
        task_id = await thumbnail_worker.submit_preview_task(
            session_id=session_id, 
            preview_type=preview_type, 
            size=size,
            file_path=file_path,
            request_id=request_id
        )
        
        return success_response({
            "task_id": task_id,
            "request_id": request_id,
            "message": "Preview generation task submitted successfully",
            "status": "accepted"
        })
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error submitting preview task: {str(e)}")

@thumbnail_router.get("/v1/status/{task_id}")
async def get_task_status(task_id: str):
    """
    Get the status of a submitted task
    """
    try:
        status = await thumbnail_worker.get_task_status(task_id)
        
        if 'error' in status:
            return error_response(status['error'])
        
        return success_response(status)
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting task status: {str(e)}")

@thumbnail_router.post("/v1/batch/thumbnails")
async def submit_batch_thumbnail_tasks(request: Dict[str, Any] = Body(...)):
    """
    Submit multiple thumbnail generation tasks to the background thumbnail task queue
    """
    try:
        session_ids = request.get('session_ids', [])
        size = request.get('size', 200)
        
        if not session_ids:
            return error_response("session_ids is required")
        
        # Submit all tasks
        task_ids = []
        for session_id in session_ids:
            # Generate unique request ID for each task
            import uuid
            request_id = f"batch_thumb_{session_id}_{uuid.uuid4().hex[:8]}"
            task_id = await thumbnail_worker.submit_thumbnail_task(session_id, size, request_id)
            task_ids.append(task_id)
        
        return success_response({
            "task_ids": task_ids,
            "message": f"Submitted {len(task_ids)} thumbnail generation tasks",
            "status": "accepted"
        })
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error submitting batch thumbnail tasks: {str(e)}")

@thumbnail_router.post("/v1/batch/previews")
async def submit_batch_preview_tasks(request: Dict[str, Any] = Body(...)):
    """
    Submit multiple preview generation tasks to the background thumbnail task queue
    """
    try:
        requests_data = request.get('requests', [])  # List of {session_id, preview_type, size}
        
        if not requests_data:
            return error_response("requests is required")
        
        # Submit all tasks
        task_ids = []
        for req in requests_data:
            session_id = req.get('session_id')
            preview_type = req.get('preview_type')
            size = req.get('size', 200)
            request_id = req.get('request_id')
            
            if not session_id or not preview_type:
                continue
            
            # Generate request_id if not provided
            if not request_id:
                import uuid
                request_id = f"batch_preview_{session_id}_{preview_type}_{uuid.uuid4().hex[:8]}"
                
            task_id = await thumbnail_worker.submit_preview_task(session_id, preview_type, size, None, request_id)
            task_ids.append(task_id)
        
        return success_response({
            "task_ids": task_ids,
            "message": f"Submitted {len(task_ids)} preview generation tasks",
            "status": "accepted"
        })
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error submitting batch preview tasks: {str(e)}")

@thumbnail_router.get("/v1/health")
async def get_service_health():
    """
    Check the health status of the thumbnail task service
    """
    try:
        # Simple health check
        return success_response({
            "status": "healthy",
            "service": "ThumbnailWorker",
            "message": "Service is running"
        })
        
    except Exception as e:
        return error_response(f"Service health check failed: {str(e)}")

