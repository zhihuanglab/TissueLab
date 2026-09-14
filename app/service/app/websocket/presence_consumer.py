# app/websocket/presence_consumer.py
from fastapi import WebSocket, WebSocketDisconnect
from .presence_manager import presence_manager
from app.middlewares.websocket_auth_middleware import websocket_auth_required
from app.core.logger import logger
from app.config.path_config import authorize_storage_read_path


async def _reject(websocket: WebSocket, reason: str = "") -> None:
    """Close a connection that was never accepted.

    ``accept()`` happens inside ``presence_manager.connect()``, below every
    check here, so ``client_state`` is still CONNECTING at this point. Guarding
    the close with ``client_state.name == "CONNECTED"`` therefore skipped it
    every time: the endpoint logged the rejection and returned without sending
    anything, and the browser sat on a socket that was never going to open.
    Starlette turns a close before accept into a refused handshake, which is
    what the client is waiting to hear.
    """
    try:
        await websocket.close(code=1008, reason=reason)
    except RuntimeError:
        pass  # client already gone


async def presence_endpoint(websocket: WebSocket):
    # Require authentication — do not accept forged Guest uids.
    try:
        user = await websocket_auth_required(websocket)
    except WebSocketDisconnect:
        logger.warning("[PRESENCE] Auth failed (invalid token), connection closed.")
        return
    except Exception as e:
        logger.error(f"[PRESENCE] Auth error: {e}", exc_info=e)
        await _reject(websocket)
        return

    if user is None or not getattr(user, "uid", None):
        await _reject(websocket, "Authentication required")
        return

    file_path = websocket.query_params.get("file_path")
    if not file_path:
        logger.warning(f"[PRESENCE] Rejected: Missing file_path (User: {user.uid})")
        await _reject(websocket)
        return

    try:
        authorize_storage_read_path(file_path, user.uid)
    except PermissionError:
        logger.warning(f"[PRESENCE] Rejected: path access denied for {user.uid}")
        await _reject(websocket, "Path access denied")
        return

    name_param = websocket.query_params.get("name")
    name = getattr(user, "display_name", None) or getattr(user, "name", None) or name_param or user.uid
    email = user.email or "unknown@user"

    user_info = {
        "uid": user.uid,
        "name": name,
        "email": email,
        "color": "#585191",
    }

    try:
        await presence_manager.connect(websocket, file_path, user_info)
        while True:
            try:
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_text("pong")
            except WebSocketDisconnect:
                break
            except Exception as e:
                logger.error(f"[PRESENCE] Loop error for {user.uid}: {e}", exc_info=e)
                break
    except Exception as e:
        logger.error(f"[PRESENCE] Connection error for {user.uid}: {e}", exc_info=e)
    finally:
        try:
            await presence_manager.disconnect(websocket)
        except Exception:
            pass
