from fastapi import APIRouter
from app.core.response import success_response, error_response
import asyncio


activation_router = APIRouter()


@activation_router.post("/v1/auto_activate_all", summary="Trigger async auto-activation of all TaskNodes")
async def trigger_auto_activation():
    """
    Start auto-activation of all TaskNodes in the background without blocking the API server.

    Returns immediately with a status payload. Use existing endpoints to observe progress
    (e.g., logs via /api/tasks/v1/logs/tail or custom SSE events if available).
    """
    try:
        from app.services.auto_activation_service import auto_activate_all_tasknodes

        loop = asyncio.get_running_loop()

        # Run the async auto-activation in a separate thread to avoid blocking the event loop
        # because the underlying implementation performs blocking subprocess operations.
        loop.run_in_executor(None, lambda: asyncio.run(auto_activate_all_tasknodes()))

        return success_response({
            "status": "starting",
            "message": "Auto-activation started in background"
        })
    except Exception as e:
        return error_response(f"Failed to trigger auto-activation: {e}")


@activation_router.get("/v1/status", summary="Get auto-activation configuration status")
def get_auto_activation_status():
    try:
        from app.services.auto_activation_service import get_activation_status_message, is_auto_activation_enabled
        return success_response({
            "enabled": bool(is_auto_activation_enabled()),
            "message": get_activation_status_message(),
        })
    except Exception as e:
        return error_response(f"Failed to get auto-activation status: {e}")


