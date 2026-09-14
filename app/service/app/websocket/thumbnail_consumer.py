import json
import asyncio
from typing import Dict, Any
from fastapi import WebSocket, WebSocketDisconnect
from app.core import logger
from app.middlewares.websocket_auth_middleware import websocket_auth_required
from app.core.auth import AuthUser
from typing import Optional

class ThumbnailConnectionManager:
    """Manages WebSocket connections for thumbnail task updates"""
    
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.connection_lock = asyncio.Lock()
    
    async def connect(self, websocket: WebSocket, task_id: str):
        """Connect a new WebSocket for a specific task"""
        await websocket.accept()
        async with self.connection_lock:
            self.active_connections[task_id] = websocket
        logger.info(f"WebSocket connected for task {task_id}")
    
    async def disconnect(self, task_id: str):
        """Disconnect WebSocket for a specific task"""
        async with self.connection_lock:
            if task_id in self.active_connections:
                del self.active_connections[task_id]
        logger.info(f"WebSocket disconnected for task {task_id}")
    
    async def send_task_update(self, task_id: str, data: Dict[str, Any]):
        """Send task update to connected WebSocket"""
        async with self.connection_lock:
            websocket = self.active_connections.get(task_id)
        
        if websocket:
            try:
                await websocket.send_text(json.dumps(data))
                logger.info(f"Sent update to task {task_id}: {data.get('status')}")
            except Exception as e:
                logger.error(f"Error sending update to task {task_id}: {str(e)}", exc_info=e)
                # Remove broken connection
                await self.disconnect(task_id)

# Global connection manager
thumbnail_manager = ThumbnailConnectionManager()

async def _owns_task(task_id: str, uid: str) -> bool:
    """True when *uid* owns *task_id*. Fail-closed, same rule as the status route."""
    if not task_id or not uid:
        return False
    try:
        from app.services.thumbnail import thumbnail_worker

        status = await thumbnail_worker.get_task_status(task_id, owner_uid=uid)
    except Exception as e:
        logger.error(f"WebSocket: task ownership check failed for {task_id}: {e}", exc_info=e)
        return False
    return "error" not in status


async def thumbnail_endpoint(websocket: WebSocket, task_id: str):
    """WebSocket endpoint for thumbnail task updates"""
    # Authenticate WebSocket connection
    try:
        user: Optional[AuthUser] = await websocket_auth_required(websocket)
        if user:
            logger.info(f"WebSocket connected for user: {user.uid} ({user.email}) for task: {task_id}")
        else:
            logger.info(f"WebSocket connected (authentication skipped for excluded path) for task: {task_id}")
    except WebSocketDisconnect:
        return  # Connection closed due to auth failure

    # task_id comes straight off the URL, and connecting *replaces* whoever held
    # it in the manager. Same owner rule as GET /thumbnail/v1/status/{task_id}.
    uid = getattr(user, "uid", "") or ""
    if not await _owns_task(task_id, uid):
        logger.warning(f"WebSocket: task {task_id} does not belong to {uid or '<anonymous>'}")
        await websocket.close(code=1008, reason="Task access denied")
        return

    try:
        await thumbnail_manager.connect(websocket, task_id)
        
        # Keep connection alive and handle incoming messages
        while True:
            try:
                # Wait for any message from client (ping/pong)
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_text("pong")
            except WebSocketDisconnect:
                break
            except Exception as e:
                logger.error(f"WebSocket error for task {task_id}: {str(e)}", exc_info=e)
                break
                
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for task {task_id}")
    except Exception as e:
        logger.error(f"Error in thumbnail WebSocket for task {task_id}: {str(e)}", exc_info=e)
    finally:
        await thumbnail_manager.disconnect(task_id)

# Function to be called from Celery service
async def notify_thumbnail_update(data: Dict[str, Any]):
    """Notify WebSocket clients about thumbnail task updates"""
    task_id = data.get('task_id')
    if task_id:
        await thumbnail_manager.send_task_update(task_id, data)


