# app/websocket/presence_consumer.py
from fastapi import WebSocket, WebSocketDisconnect
from .presence_manager import presence_manager
from app.middlewares.websocket_auth_middleware import websocket_auth_required
from app.core.logger import logger
from app.core.auth import AuthUser
from typing import Optional

async def presence_endpoint(websocket: WebSocket):
    # 1. OPTIONAL Authentication
    # The middleware kills the connection if it fails, so we MUST NOT call it
    # unless we see a token (which indicates an attempt to authenticate).
    user: Optional[AuthUser] = None
    token_present = "token" in websocket.query_params
    
    if token_present:
        try:
            # Only call strict auth if user actually sent a token
            user = await websocket_auth_required(websocket)
            if user:
                logger.info(f"[PRESENCE] Authenticated connection: {user.uid} ({user.email})")
        except WebSocketDisconnect:
            # Token was invalid or expired -> connection closed by middleware
            logger.warning("[PRESENCE] Auth failed (invalid token), connection closed.")
            return
        except Exception as e:
            logger.error(f"[PRESENCE] Auth error: {e}")
            # If it wasn't a disconnect, we might still be alive, but unsafe to assume identity
    else:
        # No token provided -> Explicit Guest Mode (Local Strategy)
        logger.info("[PRESENCE] No token provided, proceeding as Guest.")

    # 2. Extract params (Guest Fallback)
    # If user is authenticated, use their real ID. 
    # If not (Guest), trust the query params from localStorage.
    file_path = websocket.query_params.get("file_path")
    
    # Priority: Authenticated User > Query Param > None
    uid = user.uid if user else websocket.query_params.get("uid")
    
    # Priority: Authenticated Name > Query Param > Guest
    name_param = websocket.query_params.get("name")
    if user:
        name = getattr(user, 'display_name', None) or getattr(user, 'name', None) or name_param
    else:
        name = name_param or "Guest"

    email = user.email if user else "local@user"

    # 3. Validation
    if not file_path or not uid:
        logger.warning(f"[PRESENCE] Rejected: Missing file_path or uid (User: {user})")
        # Ensure we close with a policy violation code if we haven't already
        if websocket.client_state.name == "CONNECTED":
            await websocket.close(code=1008)
        return

    # 4. Construct User Info
    user_info = {
        "uid": uid,
        "name": name,
        "email": email, 
        "color": "#585191" 
    }

    # 5. Connect & Loop
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
                logger.error(f"[PRESENCE] Loop error for {uid}: {e}")
                break
    except Exception as e:
        logger.error(f"[PRESENCE] Connection error for {uid}: {e}")
    finally:
        await presence_manager.disconnect(websocket)