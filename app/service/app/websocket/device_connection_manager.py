import json
import asyncio
from contextlib import contextmanager
from typing import Dict, Any, Set, List, Tuple, Iterator
from fastapi import WebSocket
from starlette.websockets import WebSocketState
from app.core.background import track_background_task
from app.core.logger import logger


class DeviceConnectionManager:
    """Manages WebSocket connections isolated by device ID.

    Multiple CONNECTED sockets per device are allowed (multi-tab). On connect,
    already-dead sockets for that device are removed. A health checker closes
    connections that miss the ping window.
    """

    def __init__(self):
        # Structure: {device_id: {connection_id: websocket}}
        self.device_connections: Dict[str, Dict[str, WebSocket]] = {}
        self.connection_lock = asyncio.Lock()
        self.connection_counter = 0
        self.connection_health: Dict[str, Dict[str, float]] = {}  # last ping time
        # Connections currently handling a long request (may miss pings during
        # set_path). Counted, not a set: a bind task and an inline viewport
        # request overlap on the same connection during a slide switch, and
        # whichever finished first used to clear the flag out from under the
        # other, exposing it to the stale sweeper mid-request.
        self.handling_connections: Dict[Tuple[str, str], int] = {}
        self.health_check_interval = 30  # seconds
        self.connection_timeout = 60  # seconds

    # ── lifecycle ─────────────────────────────────────────────────────

    def _generate_connection_id(self) -> str:
        self.connection_counter += 1
        return f"conn_{self.connection_counter}"

    @staticmethod
    def _is_disconnected(websocket: WebSocket) -> bool:
        try:
            return websocket.client_state != WebSocketState.CONNECTED
        except Exception:
            return True

    async def _close_quietly(self, websocket: WebSocket) -> None:
        """Close with 1001 (Going Away) so clients treat it as recoverable.

        Prefer 1001 over Starlette's default 1000 so reconnect logic is not
        confused with an intentional client teardown.
        """
        try:
            if not self._is_disconnected(websocket):
                await websocket.close(code=1001)
        except Exception as e:
            logger.warning(f"Error closing WebSocket: {e}")

    async def connect(self, websocket: WebSocket, device_id: str) -> str:
        """Connect a new WebSocket for a specific device.

        Cleans up already-dead sockets for this device (true reconnect), but
        leaves other still-CONNECTED sockets alone so multiple tabs can share
        the same ``device_id``.
        """
        await websocket.accept()
        connection_id = self._generate_connection_id()
        current_time = asyncio.get_event_loop().time()
        stale_to_close: List[WebSocket] = []

        async with self.connection_lock:
            if device_id not in self.device_connections:
                self.device_connections[device_id] = {}
                self.connection_health[device_id] = {}

            for old_conn_id, old_websocket in list(self.device_connections[device_id].items()):
                if self._is_disconnected(old_websocket):
                    logger.info(
                        f"Removing dead connection {old_conn_id} for device {device_id} "
                        f"on reconnect ({connection_id})"
                    )
                    stale_to_close.append(old_websocket)
                    self.device_connections[device_id].pop(old_conn_id, None)
                    self.handling_connections.pop((device_id, old_conn_id), None)
                    if device_id in self.connection_health:
                        self.connection_health[device_id].pop(old_conn_id, None)

            self.device_connections[device_id][connection_id] = websocket
            self.connection_health[device_id][connection_id] = current_time

        for old_websocket in stale_to_close:
            await self._close_quietly(old_websocket)

        return connection_id

    async def disconnect(self, device_id: str, connection_id: str):
        """Disconnect specific WebSocket connection for a device"""
        self.handling_connections.pop((device_id, connection_id), None)
        async with self.connection_lock:
            if device_id in self.device_connections:
                if connection_id in self.device_connections[device_id]:
                    del self.device_connections[device_id][connection_id]
                if device_id in self.connection_health and connection_id in self.connection_health[device_id]:
                    del self.connection_health[device_id][connection_id]
                if not self.device_connections.get(device_id):
                    self.device_connections.pop(device_id, None)
                if device_id in self.connection_health and not self.connection_health[device_id]:
                    del self.connection_health[device_id]

    async def disconnect_device(self, device_id: str):
        """Disconnect all WebSocket connections for a specific device"""
        to_close: List[WebSocket] = []
        async with self.connection_lock:
            if device_id in self.device_connections:
                for connection_id, websocket in list(self.device_connections[device_id].items()):
                    self.handling_connections.pop((device_id, connection_id), None)
                    to_close.append(websocket)
                del self.device_connections[device_id]
            self.connection_health.pop(device_id, None)

        for websocket in to_close:
            try:
                await websocket.close(code=1001)
            except Exception as e:
                logger.error(
                    f"Error closing WebSocket for device {device_id}: {str(e)}",
                    exc_info=e,
                )

    # ── messaging ─────────────────────────────────────────────────────

    async def _send_one(
        self, device_id: str, connection_id: str, websocket: WebSocket, payload: str
    ) -> None:
        try:
            await websocket.send_text(payload)
        except Exception as e:
            logger.error(
                f"Error sending data to device {device_id}, connection {connection_id}: {str(e)}",
                exc_info=e,
            )
            await self.disconnect(device_id, connection_id)

    async def _fan_out(self, targets: List[Tuple[str, str, WebSocket]], data: Dict[str, Any]) -> None:
        """Send to every target concurrently.

        Sending in a loop meant one slow consumer — a client whose socket buffer
        is full — blocked delivery to everyone behind it in the list. With
        overlay frames on this path that showed up as the whole session stalling
        because a single tab was busy. Serialize the payload once while we are
        at it; it was identical for every recipient.
        """
        if not targets:
            return
        payload = json.dumps(data)
        await asyncio.gather(
            *(
                self._send_one(device_id, connection_id, websocket, payload)
                for device_id, connection_id, websocket in targets
            ),
            return_exceptions=True,
        )

    async def send_to_device(self, device_id: str, data: Dict[str, Any]):
        """Send data to all WebSocket connections for a specific device"""
        async with self.connection_lock:
            if device_id not in self.device_connections:
                logger.warning(f"No connections found for device {device_id}")
                return

            targets = [
                (device_id, connection_id, websocket)
                for connection_id, websocket in self.device_connections[device_id].items()
            ]

        await self._fan_out(targets, data)

    async def send_to_all_devices(self, data: Dict[str, Any]):
        """Send data to all WebSocket connections across all devices"""
        async with self.connection_lock:
            targets = [
                (device_id, connection_id, websocket)
                for device_id, connections in self.device_connections.items()
                for connection_id, websocket in connections.items()
            ]

        await self._fan_out(targets, data)

    # ── queries ───────────────────────────────────────────────────────

    def get_device_connection_count(self, device_id: str) -> int:
        if device_id in self.device_connections:
            return len(self.device_connections[device_id])
        return 0

    def get_all_devices(self) -> Set[str]:
        return set(self.device_connections.keys())

    def get_total_connection_count(self) -> int:
        total = 0
        for connections in self.device_connections.values():
            total += len(connections)
        return total

    # ── health / long-request protection ──────────────────────────────

    @contextmanager
    def handling(self, device_id: str, connection_id: str) -> Iterator[None]:
        """Skip stale-sweep while this connection is in a long request. Reentrant."""
        key = (device_id, connection_id)
        self.handling_connections[key] = self.handling_connections.get(key, 0) + 1
        try:
            yield
        finally:
            remaining = self.handling_connections.get(key, 1) - 1
            if remaining > 0:
                self.handling_connections[key] = remaining
            else:
                self.handling_connections.pop(key, None)

    async def update_connection_health(self, device_id: str, connection_id: str):
        """Update the last ping time for a connection"""
        current_time = asyncio.get_event_loop().time()
        async with self.connection_lock:
            if device_id not in self.connection_health:
                self.connection_health[device_id] = {}
            self.connection_health[device_id][connection_id] = current_time

    async def cleanup_stale_connections(self):
        """Close and remove connections that missed the ping/pong window."""
        current_time = asyncio.get_event_loop().time()
        stale: List[Tuple[str, str, WebSocket]] = []

        async with self.connection_lock:
            for device_id, health_data in list(self.connection_health.items()):
                for connection_id, last_ping in list(health_data.items()):
                    if current_time - last_ping <= self.connection_timeout:
                        continue
                    if (device_id, connection_id) in self.handling_connections:
                        # Actively handling a long request (e.g. forceReload) —
                        # don't treat unread pings as a dead socket.
                        continue
                    websocket = None
                    if (
                        device_id in self.device_connections
                        and connection_id in self.device_connections[device_id]
                    ):
                        websocket = self.device_connections[device_id][connection_id]
                    age = current_time - last_ping
                    if websocket is None:
                        health_data.pop(connection_id, None)
                        logger.warning(
                            f"Removing orphan health entry {connection_id} for device {device_id}"
                        )
                        continue
                    logger.warning(
                        f"Connection {connection_id} for device {device_id} "
                        f"stale for {age:.1f}s — closing"
                    )
                    stale.append((device_id, connection_id, websocket))

            for device_id in [
                d for d, h in self.connection_health.items() if not h
            ]:
                self.connection_health.pop(device_id, None)

        for device_id, connection_id, websocket in stale:
            await self._close_quietly(websocket)
            await self.disconnect(device_id, connection_id)

    async def start_health_checker(self):
        """Start background task to clean up stale WebSocket connections"""
        while True:
            try:
                await asyncio.sleep(self.health_check_interval)
                await self.cleanup_stale_connections()
                # Both sweeps below run in a worker thread, never inline.
                #
                # This coroutine is on the service's only event loop, and the
                # sweeps are emphatically not cheap: they take locks the request
                # path also takes, drop handlers holding centroids/contours/KDTree,
                # close WSI handles, and finish with a full gc.collect(). With a
                # heap full of decoder state and large arrays that collection
                # alone runs for seconds — and every HTTP request and WebSocket
                # message on the service is frozen for exactly that long. Tidying
                # up must never be visible to someone opening a slide.
                try:
                    from app.services.seg_registry import sweep_idle_handlers

                    swept = await asyncio.to_thread(sweep_idle_handlers)
                    if swept:
                        logger.info(f"Swept {swept} idle segmentation handler(s)")
                except Exception as sweep_err:
                    logger.warning(f"Idle handler sweep failed: {sweep_err}")
                # ...and the open WSI handles behind abandoned viewer sessions.
                # Only DELETE /v1/delete_instance used to free these, so any tab
                # that closed without a clean unmount leaked a file descriptor.
                try:
                    from app.services.load import release_idle_slides

                    released = await asyncio.to_thread(release_idle_slides)
                    if released:
                        logger.info(f"Released {released} idle slide handle(s)")
                except Exception as release_err:
                    logger.warning(f"Idle slide release failed: {release_err}")
            except Exception as e:
                logger.error(f"Error in health checker: {e}", exc_info=e)
                await asyncio.sleep(5)


# Global connection manager instance
device_connection_manager = DeviceConnectionManager()


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
    """Start the WebSocket health checker background task.

    Tracked, not detached: this loop is the only thing that closes dead sockets
    and reclaims idle segmentation handlers and slide handles, and asyncio keeps
    only weak references to tasks.
    """
    track_background_task(
        asyncio.create_task(device_connection_manager.start_health_checker()),
        "websocket health checker",
    )
