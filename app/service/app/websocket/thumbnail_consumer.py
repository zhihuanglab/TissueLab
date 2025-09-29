import json
import asyncio
from typing import Dict, Any
from fastapi import WebSocket, WebSocketDisconnect
from app.core import logger
# Auth removed for open source
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
                logger.error(f"Error sending update to task {task_id}: {str(e)}")
                # Remove broken connection
                await self.disconnect(task_id)

# Global connection manager
thumbnail_manager = ThumbnailConnectionManager()

async def thumbnail_endpoint(websocket: WebSocket, task_id: str):
    """WebSocket endpoint for thumbnail task updates"""
    # Auth removed for open source - direct connection without authentication
    try:
        logger.info(f"WebSocket connected for task: {task_id}")
    except WebSocketDisconnect:
        return  # Connection closed due to auth failure
    
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
                logger.error(f"WebSocket error for task {task_id}: {str(e)}")
                break
                
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for task {task_id}")
    except Exception as e:
        logger.error(f"Error in thumbnail WebSocket for task {task_id}: {str(e)}")
    finally:
        await thumbnail_manager.disconnect(task_id)

# Function to be called from Celery service
async def notify_thumbnail_update(data: Dict[str, Any]):
    """Notify WebSocket clients about thumbnail task updates"""
    task_id = data.get('task_id')
    if task_id:
        await thumbnail_manager.send_task_update(task_id, data)


