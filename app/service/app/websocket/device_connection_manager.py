import json
import asyncio
from typing import Dict, Any, Optional, Set
from fastapi import WebSocket, WebSocketDisconnect
from app.core.logger import logger
# Auth removed for open source
# AuthUser removed for open source


class DeviceConnectionManager:
    """Manages WebSocket connections isolated by device ID"""
    
    def __init__(self):
        # Dictionary to store connections by device_id
        # Structure: {device_id: {connection_id: websocket}}
        self.device_connections: Dict[str, Dict[str, WebSocket]] = {}
        self.connection_lock = asyncio.Lock()
        self.connection_counter = 0
    
    def _generate_connection_id(self) -> str:
        """Generate unique connection ID"""
        self.connection_counter += 1
        return f"conn_{self.connection_counter}"
    
    async def connect(self, websocket: WebSocket, device_id: str) -> str:
        """Connect a new WebSocket for a specific device"""
        await websocket.accept()
        connection_id = self._generate_connection_id()
        
        async with self.connection_lock:
            if device_id not in self.device_connections:
                self.device_connections[device_id] = {}
            self.device_connections[device_id][connection_id] = websocket
        
        logger.info(f"WebSocket connected for device {device_id} with connection {connection_id}")
        return connection_id
    
    async def disconnect(self, device_id: str, connection_id: str):
        """Disconnect specific WebSocket connection for a device"""
        async with self.connection_lock:
            if device_id in self.device_connections:
                if connection_id in self.device_connections[device_id]:
                    del self.device_connections[device_id][connection_id]
                    # Clean up empty device entries
                    if not self.device_connections[device_id]:
                        del self.device_connections[device_id]
        
        logger.info(f"WebSocket disconnected for device {device_id}, connection {connection_id}")
    
    async def disconnect_device(self, device_id: str):
        """Disconnect all WebSocket connections for a specific device"""
        async with self.connection_lock:
            if device_id in self.device_connections:
                connections = list(self.device_connections[device_id].keys())
                for connection_id in connections:
                    try:
                        websocket = self.device_connections[device_id][connection_id]
                        await websocket.close()
                    except Exception as e:
                        logger.error(f"Error closing WebSocket for device {device_id}, connection {connection_id}: {str(e)}")
                del self.device_connections[device_id]
        
        logger.info(f"All WebSocket connections disconnected for device {device_id}")
    
    async def send_to_device(self, device_id: str, data: Dict[str, Any]):
        """Send data to all WebSocket connections for a specific device"""
        async with self.connection_lock:
            if device_id not in self.device_connections:
                logger.warning(f"No connections found for device {device_id}")
                return
            
            connections = list(self.device_connections[device_id].items())
        
        # Send to all connections for this device
        for connection_id, websocket in connections:
            try:
                await websocket.send_text(json.dumps(data))
                logger.info(f"Sent data to device {device_id}, connection {connection_id}")
            except Exception as e:
                logger.error(f"Error sending data to device {device_id}, connection {connection_id}: {str(e)}")
                # Remove broken connection
                await self.disconnect(device_id, connection_id)
    
    async def send_to_all_devices(self, data: Dict[str, Any]):
        """Send data to all WebSocket connections across all devices"""
        async with self.connection_lock:
            all_connections = []
            for device_id, connections in self.device_connections.items():
                for connection_id, websocket in connections.items():
                    all_connections.append((device_id, connection_id, websocket))
        
        # Send to all connections
        for device_id, connection_id, websocket in all_connections:
            try:
                await websocket.send_text(json.dumps(data))
                logger.info(f"Sent data to device {device_id}, connection {connection_id}")
            except Exception as e:
                logger.error(f"Error sending data to device {device_id}, connection {connection_id}: {str(e)}")
                # Remove broken connection
                await self.disconnect(device_id, connection_id)
    
    def get_device_connection_count(self, device_id: str) -> int:
        """Get the number of active connections for a specific device"""
        if device_id in self.device_connections:
            return len(self.device_connections[device_id])
        return 0
    
    def get_all_devices(self) -> Set[str]:
        """Get all device IDs with active connections"""
        return set(self.device_connections.keys())
    
    def get_total_connection_count(self) -> int:
        """Get total number of active connections across all devices"""
        total = 0
        for connections in self.device_connections.values():
            total += len(connections)
        return total


# Global connection manager instance
device_connection_manager = DeviceConnectionManager()


async def handle_device_websocket(websocket: WebSocket, user: Optional[str] = None):
    """
    Handle WebSocket connection with device isolation
    """
    # Extract device ID from WebSocket
    # Auth removed for open source - get device_id from query params or use default
    device_id = websocket.query_params.get("device_id", "default_device")
    if not device_id:
        logger.warning("WebSocket: No device ID provided, closing connection")
        await websocket.close(code=1008, reason="Device ID required")
        return
    
    connection_id = None
    try:
        # Connect to device-specific connection manager
        connection_id = await device_connection_manager.connect(websocket, device_id)
        
        # Log connection info
        if user:
            logger.info(f"WebSocket connected for user: {user.uid} ({user.email}) on device: {device_id}")
        else:
            logger.info(f"WebSocket connected (no auth) on device: {device_id}")
        
        # Keep connection alive and handle incoming messages
        while True:
            try:
                # Wait for any message from client
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_text("pong")
                elif data == "get_status":
                    # Send connection status
                    status = {
                        "type": "status",
                        "device_id": device_id,
                        "connection_id": connection_id,
                        "total_connections_for_device": device_connection_manager.get_device_connection_count(device_id),
                        "total_devices": len(device_connection_manager.get_all_devices()),
                        "total_connections": device_connection_manager.get_total_connection_count()
                    }
                    await websocket.send_text(json.dumps(status))
            except WebSocketDisconnect:
                break
            except Exception as e:
                logger.error(f"WebSocket error for device {device_id}: {str(e)}")
                break
                
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for device {device_id}")
    except Exception as e:
        logger.error(f"Error in WebSocket for device {device_id}: {str(e)}")
    finally:
        if connection_id:
            await device_connection_manager.disconnect(device_id, connection_id)


async def send_to_device(device_id: str, data: Dict[str, Any]):
    """Send data to all connections for a specific device"""
    await device_connection_manager.send_to_device(device_id, data)


async def send_to_all_devices(data: Dict[str, Any]):
    """Send data to all connections across all devices"""
    await device_connection_manager.send_to_all_devices(data)


async def disconnect_device(device_id: str):
    """Disconnect all connections for a specific device"""
    await device_connection_manager.disconnect_device(device_id)
