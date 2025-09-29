from fastapi import APIRouter
from .segmentation_consumer import segmentation_endpoint
from .thumbnail_consumer import thumbnail_endpoint

# Create WebSocket router
ws_router = APIRouter()

# Register WebSocket endpoints
ws_router.add_api_websocket_route("/segment/", segmentation_endpoint)
ws_router.add_api_websocket_route("/thumbnail/{task_id}/", thumbnail_endpoint)
