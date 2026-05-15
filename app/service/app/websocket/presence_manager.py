import json
import asyncio
from typing import Dict, Set, Any
from fastapi import WebSocket
from app.core.logger import logger

class PresenceManager:
    def __init__(self):
        # Key: file_path, Value: Set of WebSockets
        self.rooms: Dict[str, Set[WebSocket]] = {}
        # Key: WebSocket, Value: User Info (for quick lookups on disconnect)
        self.socket_owners: Dict[WebSocket, dict] = {}

    async def connect(self, websocket: WebSocket, file_path: str, user_info: dict):
        await websocket.accept()
        
        if file_path not in self.rooms:
            self.rooms[file_path] = set()
        
        self.rooms[file_path].add(websocket)
        self.socket_owners[websocket] = {
            "user": user_info,
            "room": file_path
        }
        
        logger.info(f"[PRESENCE] User {user_info.get('email')} joined room: {file_path}. Current room count is {len(self.rooms[file_path])}")
                
        # 1. SYNC: Send current room state to the new user
        current_users = [
            self.socket_owners[ws]["user"] 
            for ws in self.rooms[file_path] 
            if ws in self.socket_owners
        ]
        
        await websocket.send_json({
            "type": "sync_room",
            "users": current_users
        })

        # 2. BROADCAST: Tell everyone else a user joined
        await self.broadcast(file_path, {
            "type": "user_joined",
            "user": user_info
        }, exclude=websocket)

    async def disconnect(self, websocket: WebSocket):
        if websocket in self.socket_owners:
            info = self.socket_owners[websocket]
            file_path = info["room"]
            user_info = info["user"]
            
            # Remove from room
            if file_path in self.rooms:
                self.rooms[file_path].discard(websocket)
                if not self.rooms[file_path]:
                    del self.rooms[file_path]
            
            # Cleanup owner info
            del self.socket_owners[websocket]
            
            # 3. LEAVE: Broadcast to remaining users
            if file_path in self.rooms:
                await self.broadcast(file_path, {
                    "type": "user_left",
                    "user_id": user_info.get("uid")
                })
                
            logger.info(f"User {user_info.get('email')} left room: {file_path}")

    async def broadcast(self, file_path: str, message: dict, exclude: WebSocket = None):
        if file_path not in self.rooms:
            return
            
        failed_sockets = []
        
        for ws in self.rooms[file_path]:
            if ws == exclude:
                continue
            try:
                await ws.send_json(message)
            except Exception as e:
                logger.error(f"Error broadcasting presence: {e}")
                failed_sockets.append(ws)
        for ws in failed_sockets:
            await self.disconnect(ws)

presence_manager = PresenceManager()