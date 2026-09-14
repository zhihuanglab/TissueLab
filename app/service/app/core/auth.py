"""Route-level auth dependencies.

Both dependencies resolve to the local principal (see ``app.core.identity``).
They keep the same names and return type as the hosted edition so route
handlers are unchanged.
"""
from typing import Optional

from fastapi import Request

from app.core.identity import AuthUser, local_user


def get_auth_user(request: Request) -> AuthUser:
    """Current user — always the local principal."""
    user = getattr(request.state, "user", None)
    if isinstance(user, dict) and user.get("uid"):
        return AuthUser(
            uid=user["uid"],
            email=user.get("email"),
            is_anonymous=False,
            provider_id=user.get("provider_id", "local"),
        )
    return local_user()


def get_optional_auth_user(request: Request) -> Optional[AuthUser]:
    """Best-effort variant kept for signature compatibility."""
    return get_auth_user(request)


__all__ = ["AuthUser", "get_auth_user", "get_optional_auth_user"]
