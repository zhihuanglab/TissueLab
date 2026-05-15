import json
import asyncio
from typing import Dict, Any, Optional, Set
from fastapi import WebSocket, WebSocketDisconnect
from app.core.logger import logger
from app.middlewares.websocket_auth_middleware import get_device_id_from_websocket
from app.core.auth import AuthUser


class DeviceConnectionManager:
    """Manages WebSocket connections isolated by device ID"""
    
    def __init__(self):
        # Dictionary to store connections by device_id
        # Structure: {device_id: {connection_id: websocket}}
        self.device_connections: Dict[str, Dict[str, WebSocket]] = {}
        self.connection_lock = asyncio.Lock()
        self.connection_counter = 0
        self.connection_health: Dict[str, Dict[str, float]] = {}  # Track last ping time
        self.health_check_interval = 30  # seconds
        self.connection_timeout = 60  # seconds
        self.handler_cleanup_timeout = 300  # 5 minutes after disconnection for handler cleanup
        self.device_last_activity: Dict[str, float] = {}  # Track last activity time per device
    
    def _generate_connection_id(self) -> str:
        """Generate unique connection ID"""
        self.connection_counter += 1
        return f"conn_{self.connection_counter}"
    
    async def connect(self, websocket: WebSocket, device_id: str) -> str:
        """Connect a new WebSocket for a specific device"""
        await websocket.accept()
        connection_id = self._generate_connection_id()
        current_time = asyncio.get_event_loop().time()
        
        async with self.connection_lock:
            if device_id not in self.device_connections:
                self.device_connections[device_id] = {}
                self.connection_health[device_id] = {}
            
            # Clean up any existing connections for this device (reconnection scenario)
            if connection_id in self.device_connections[device_id]:
                logger.info(f"Replacing existing connection {connection_id} for device {device_id}")
                try:
                    old_websocket = self.device_connections[device_id][connection_id]
                    await old_websocket.close()
                except Exception as e:
                    logger.warning(f"Error closing old connection: {e}")
            
            self.device_connections[device_id][connection_id] = websocket
            self.connection_health[device_id][connection_id] = current_time
            self.device_last_activity[device_id] = current_time  # Update last activity time
        
        # Check if this is a reconnection and try to restore handlers
        await self._try_restore_handlers(device_id)
        
        logger.info(f"WebSocket connected for device {device_id} with connection {connection_id}")
        return connection_id
    
    async def disconnect(self, device_id: str, connection_id: str):
        """Disconnect specific WebSocket connection for a device"""
        async with self.connection_lock:
            if device_id in self.device_connections:
                if connection_id in self.device_connections[device_id]:
                    del self.device_connections[device_id][connection_id]
                    # Clean up health tracking
                    if device_id in self.connection_health and connection_id in self.connection_health[device_id]:
                        del self.connection_health[device_id][connection_id]
                    # Clean up empty device entries
                    if not self.device_connections[device_id]:
                        del self.device_connections[device_id]
                        # Update last activity time when device has no connections
                        self.device_last_activity[device_id] = asyncio.get_event_loop().time()
                    if device_id in self.connection_health and not self.connection_health[device_id]:
                        del self.connection_health[device_id]
        
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
    
    async def update_connection_health(self, device_id: str, connection_id: str):
        """Update the last ping time for a connection"""
        current_time = asyncio.get_event_loop().time()
        async with self.connection_lock:
            if device_id in self.connection_health:
                self.connection_health[device_id][connection_id] = current_time
                # Update device last activity time
                self.device_last_activity[device_id] = current_time
    
    async def cleanup_stale_connections(self):
        """Remove connections that haven't been pinged recently and are actually closed"""
        current_time = asyncio.get_event_loop().time()
        stale_connections = []
        
        async with self.connection_lock:
            for device_id, health_data in self.connection_health.items():
                for connection_id, last_ping in health_data.items():
                    # Check if connection is stale (no ping for timeout period)
                    if current_time - last_ping > self.connection_timeout:
                        # Check if the connection actually exists and is closed
                        if (device_id in self.device_connections and 
                            connection_id in self.device_connections[device_id]):
                            websocket = self.device_connections[device_id][connection_id]
                            # Only clean up if the WebSocket is actually closed
                            try:
                                if websocket.client_state.name == 'DISCONNECTED':
                                    stale_connections.append((device_id, connection_id))
                                    logger.warning(f"Found stale closed connection {connection_id} for device {device_id}")
                                else:
                                    # Connection is still open but no ping - this shouldn't happen with proper ping
                                    logger.warning(f"Connection {connection_id} for device {device_id} is open but hasn't pinged for {current_time - last_ping:.1f}s")
                                    # Don't clean up open connections, just log the warning
                            except Exception as e:
                                # If we can't check the state, assume it's stale
                                logger.warning(f"Could not check state of connection {connection_id} for device {device_id}: {e}")
                                stale_connections.append((device_id, connection_id))
        
        # Clean up stale connections
        for device_id, connection_id in stale_connections:
            logger.warning(f"Cleaning up stale connection {connection_id} for device {device_id}")
            await self.disconnect(device_id, connection_id)
    
    async def cleanup_inactive_handlers(self):
        """Clean up handlers for devices that have been disconnected for more than 5 minutes"""
        current_time = asyncio.get_event_loop().time()
        devices_to_cleanup = []
        
        async with self.connection_lock:
            for device_id, last_activity in self.device_last_activity.items():
                # Check if device has no active connections and has been disconnected for more than 5 minutes
                has_active_connections = device_id in self.device_connections and len(self.device_connections[device_id]) > 0
                if not has_active_connections and current_time - last_activity > self.handler_cleanup_timeout:
                    devices_to_cleanup.append(device_id)
        
        # Clean up handlers for disconnected devices
        for device_id in devices_to_cleanup:
            logger.info(f"Cleaning up handlers for disconnected device {device_id} (disconnected for {current_time - self.device_last_activity[device_id]:.1f}s)")
            await self._cleanup_device_handlers(device_id)
            # Remove from activity tracking
            if device_id in self.device_last_activity:
                del self.device_last_activity[device_id]
    
    async def _try_restore_handlers(self, device_id: str):
        """Try to restore handlers for a reconnected device"""
        try:
            # Import here to avoid circular imports
            from app.websocket.segmentation_consumer import (
                device_annotation_handlers, 
                device_type_manage_handlers,
                TypeManageHandler
            )
            
            # Check if handlers exist for this device
            has_annotation_handler = device_id in device_annotation_handlers
            has_type_handler = device_id in device_type_manage_handlers
            
            if not has_annotation_handler or not has_type_handler:
                logger.info(f"Restoring handlers for reconnected device {device_id}")
                
                # Initialize type manage handler if missing
                if not has_type_handler:
                    device_type_manage_handlers[device_id] = TypeManageHandler()
                    logger.info(f"Restored type manage handler for device {device_id}")
                
                # Note: Annotation handler will be restored when path is set
                # We can't restore it here without knowing the file path
                logger.info(f"Device {device_id} handlers initialized, annotation handler will be restored when path is set")
                
        except Exception as e:
            logger.error(f"Error restoring handlers for device {device_id}: {e}")
    
    async def _cleanup_device_handlers(self, device_id: str):
        """Clean up segmentation handlers for a specific device"""
        try:
            # Import here to avoid circular imports
            from app.websocket.segmentation_consumer import cleanup_device_resources
            cleanup_device_resources(device_id)
            logger.info(f"Successfully cleaned up handlers for device {device_id}")
        except Exception as e:
            logger.error(f"Error cleaning up handlers for device {device_id}: {e}")
    
    async def start_health_checker(self):
        """Start background task to clean up stale connections and inactive handlers"""
        while True:
            try:
                await asyncio.sleep(self.health_check_interval)
                # Clean up stale connections
                await self.cleanup_stale_connections()
                # Clean up handlers for disconnected devices (5 minutes after disconnection)
                await self.cleanup_inactive_handlers()
            except Exception as e:
                logger.error(f"Error in health checker: {e}")
                await asyncio.sleep(5)  # Wait before retrying


# Global connection manager instance
device_connection_manager = DeviceConnectionManager()


async def handle_device_websocket(websocket: WebSocket, user: Optional[AuthUser] = None):
    """
    Handle WebSocket connection with device isolation
    """
    # Extract device ID from WebSocket
    device_id = get_device_id_from_websocket(websocket)
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
                    # Update connection health on ping
                    await device_connection_manager.update_connection_health(device_id, connection_id)
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
                    # Update connection health on status request
                    await device_connection_manager.update_connection_health(device_id, connection_id)
                else:
                    # Forward all other messages to segmentation consumer
                    try:
                        parsed_data = json.loads(data)
                        # Forward to segmentation handler
                        from app.websocket.segmentation_consumer import handle_segmentation_message
                        await handle_segmentation_message(websocket, device_id, parsed_data, user=user)
                    except json.JSONDecodeError:
                        # If not JSON, treat as ping
                        await websocket.send_text("pong")
                    
                    # Update health for any other message
                    await device_connection_manager.update_connection_health(device_id, connection_id)
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


async def start_websocket_health_checker():
    """Start the WebSocket health checker background task"""
    asyncio.create_task(device_connection_manager.start_health_checker())
    logger.info("WebSocket health checker started")

