from fastapi import APIRouter
from app.core.response import success_response, error_response
from app.services.activation import (
    start_auto_activation_background,
    get_auto_activation_status,
)


activation_router = APIRouter()


@activation_router.post("/v1/auto_activate_all", summary="Trigger async auto-activation of all TaskNodes")
async def trigger_auto_activation():
    """
    Start auto-activation of all TaskNodes in the background without blocking the API server.

    Returns immediately with a status payload. Use existing endpoints to observe progress
    (e.g., logs via /api/tasks/v1/logs/tail or custom SSE events if available).
    """
    # Coroutine on purpose, though it never awaits: start_auto_activation_background
    # calls asyncio.get_running_loop(), and a plain `def` route runs in a worker
    # thread where there is no running loop.
    try:
        start_auto_activation_background()
        return success_response({
            "status": "starting",
            "message": "Auto-activation started in background"
        })
    except Exception as e:
        return error_response(f"Failed to trigger auto-activation: {e}")


@activation_router.get("/v1/status", summary="Get auto-activation configuration status")
def auto_activation_status():
    try:
        return success_response(get_auto_activation_status())
    except Exception as e:
        return error_response(f"Failed to get auto-activation status: {e}")
