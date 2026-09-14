"""HTTP identity middleware.

Attaches the local principal to every ``/api`` request. There is no token
verification in the open edition; see ``app/core/identity.py`` for the model
and ``docs/local-mode.md`` for the reasoning.
"""
from fastapi import Request

from app.core.identity import LOCAL_USER_ID


async def auth_middleware(request: Request, call_next):
    if request.url.path.startswith("/api"):
        request.state.user = {"uid": LOCAL_USER_ID, "email": None, "provider_id": "local"}
    return await call_next(request)
