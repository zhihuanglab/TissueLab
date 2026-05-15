"""HTTP auth middleware — no-op for the local desktop build.

Token verification happens on the remote ctrl service. This pass-through
preserves the middleware slot so existing registration in ``main.py`` keeps
working without conditional logic.
"""

from fastapi import Request


async def auth_middleware(request: Request, call_next):
    return await call_next(request)
