"""The single local principal.

The open edition authenticates nobody: every request and socket belongs to
one local user, the way Jupyter or Open WebUI with ``WEBUI_AUTH=false`` run.
The permission guards keep running against this principal; network exposure
is controlled by binding (127.0.0.1 by default), not by tokens.
"""
from dataclasses import dataclass
from typing import Optional

from app.core.settings import settings

LOCAL_USER_ID: str = settings.LOCAL_USER_ID


@dataclass
class AuthUser:
    """Principal attached to a request or websocket."""
    uid: str
    email: Optional[str]
    is_anonymous: bool
    provider_id: str


def local_user() -> AuthUser:
    return AuthUser(uid=LOCAL_USER_ID, email=None, is_anonymous=False, provider_id="local")


__all__ = ["AuthUser", "LOCAL_USER_ID", "local_user"]
