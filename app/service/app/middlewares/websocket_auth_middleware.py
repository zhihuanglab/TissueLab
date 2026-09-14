"""WebSocket identity helpers.

Every socket is owned by the local principal. The ``token`` query parameter
and ``Authorization`` header the renderer still sends are accepted and ignored.
"""
from typing import Optional

from fastapi import WebSocket

from app.core.identity import AuthUser, local_user


async def authenticate_websocket(websocket: WebSocket) -> Optional[AuthUser]:
    return local_user()


def get_device_id_from_websocket(websocket: WebSocket) -> Optional[str]:
    """Extract device ID from WebSocket connection."""
    device_id = websocket.query_params.get("device_id")
    if device_id:
        return device_id
    return websocket.headers.get("X-Device-Id") or websocket.headers.get("x-device-id")


async def websocket_auth_required(websocket: WebSocket) -> Optional[AuthUser]:
    return local_user()


async def websocket_auth_optional(websocket: WebSocket) -> Optional[AuthUser]:
    return local_user()
