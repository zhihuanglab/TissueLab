"""WebSocket auth helpers — no-op for the local desktop build.

The remote ctrl service is the only authority that verifies tokens; the local
backend accepts every connection and surfaces a default ``AuthUser``. The
``get_device_id_from_websocket`` helper is auth-independent and lives here for
historical reasons.
"""

from typing import Optional

from fastapi import WebSocket

from app.core.auth import AuthUser, get_auth_user


async def websocket_auth_required(websocket: WebSocket) -> Optional[AuthUser]:
    return get_auth_user()


async def websocket_auth_optional(websocket: WebSocket) -> Optional[AuthUser]:
    return get_auth_user()


def get_device_id_from_websocket(websocket: WebSocket) -> Optional[str]:
    device_id = websocket.query_params.get("device_id")
    if device_id:
        return device_id
    header = websocket.headers.get("x-device-id")
    return header
