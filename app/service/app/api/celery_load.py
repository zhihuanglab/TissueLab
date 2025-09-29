from fastapi import APIRouter, Query, Body
from fastapi.responses import JSONResponse
from typing import List, Dict, Any
import traceback

from app.core.response import success_response, error_response
from app.services.celery_thumbnail_service import celery_thumbnail_service

# Create router
celery_load_router = APIRouter()

@celery_load_router.post("/v1/celery/thumbnails")
async def submit_thumbnail_task(request: Dict[str, Any] = Body(...)):
    """
    Submit thumbnail generation task to Celery queue
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
        
        # Submit task to Celery service
        task_id = await celery_thumbnail_service.submit_thumbnail_task(session_id, size, request_id)
        
        return success_response({
            "task_id": task_id,
            "request_id": request_id,
            "message": "Thumbnail generation task submitted successfully",
            "status": "accepted"
        })
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error submitting thumbnail task: {str(e)}")

@celery_load_router.post("/v1/celery/previews")
async def submit_preview_task(request: Dict[str, Any] = Body(...)):
    """
    Submit preview generation task to Celery queue
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
        
        # Submit task to Celery service
        task_id = await celery_thumbnail_service.submit_preview_task(
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

@celery_load_router.get("/v1/celery/status/{task_id}")
async def get_task_status(task_id: str):
    """
    Get the status of a submitted task
    """
    try:
        status = await celery_thumbnail_service.get_task_status(task_id)
        
        if 'error' in status:
            return error_response(status['error'])
        
        return success_response(status)
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error getting task status: {str(e)}")

@celery_load_router.post("/v1/celery/batch/thumbnails")
async def submit_batch_thumbnail_tasks(request: Dict[str, Any] = Body(...)):
    """
    Submit multiple thumbnail generation tasks to Celery queue
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
            task_id = await celery_thumbnail_service.submit_thumbnail_task(session_id, size, request_id)
            task_ids.append(task_id)
        
        return success_response({
            "task_ids": task_ids,
            "message": f"Submitted {len(task_ids)} thumbnail generation tasks",
            "status": "accepted"
        })
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error submitting batch thumbnail tasks: {str(e)}")

@celery_load_router.post("/v1/celery/batch/previews")
async def submit_batch_preview_tasks(request: Dict[str, Any] = Body(...)):
    """
    Submit multiple preview generation tasks to Celery queue
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
                
            task_id = await celery_thumbnail_service.submit_preview_task(session_id, preview_type, size, None, request_id)
            task_ids.append(task_id)
        
        return success_response({
            "task_ids": task_ids,
            "message": f"Submitted {len(task_ids)} preview generation tasks",
            "status": "accepted"
        })
        
    except Exception as e:
        traceback.print_exc()
        return error_response(f"Error submitting batch preview tasks: {str(e)}")

@celery_load_router.get("/v1/celery/health")
async def get_service_health():
    """
    Check the health status of the Celery thumbnail service
    """
    try:
        # Simple health check
        return success_response({
            "status": "healthy",
            "service": "CeleryThumbnailService",
            "message": "Service is running"
        })
        
    except Exception as e:
        return error_response(f"Service health check failed: {str(e)}")

