import asyncio
from typing import Optional, Tuple

from fastapi import Request
from fastapi.responses import Response

from app.config.path_config import (
    STORAGE_ROOT,
    authorize_storage_read_path,
    get_restricted_access_mode,
    is_local_desktop_path,
)
from app.core.response import permission_denied_response
import os


def request_id(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    return request.headers.get("X-Request-ID")


def request_uid(request: Request) -> Optional[str]:
    user = getattr(request.state, "user", None)
    if isinstance(user, dict):
        return user.get("uid")
    return getattr(user, "uid", None)


def authorize_read_or_response(
    request: Request,
    path: str,
    operation: str = "read",
) -> Tuple[Optional[str], Optional[Response]]:
    """Authorize a read and return ``(abs_path, None)`` or ``(None, denial)``."""
    uid = request_uid(request) or ""
    try:
        return authorize_storage_read_path(path, uid), None
    except PermissionError:
        return None, permission_denied_response(
            access_mode=get_restricted_access_mode(path, uid) or "forbidden",
            operation=operation,
            request_id=request_id(request),
            error_code="READ_ACCESS_DENIED",
        )


def guard_write_path(
    request: Request,
    path: str,
    operation: str,
) -> Tuple[Optional[str], Optional[Response]]:
    """Block Viewer/Samples mutation, then enforce read ACL.

    Use for extract/write handlers. Read-only metadata stays on
    ``authorize_read_or_response`` alone.
    """
    mode = get_restricted_access_mode(path, request_uid(request) or "")
    if mode:
        return None, permission_denied_response(
            access_mode=mode,
            operation=operation,
            request_id=request_id(request),
        )
    return authorize_read_or_response(request, path, operation=operation)


def guard_instance_owner(
    request: Request,
    instance_id: Optional[str],
    operation: str,
    *,
    teardown: bool = False,
) -> Optional[Response]:
    """HTTP-200 denial unless the instance belongs to the caller.

    ``teardown=True`` for operations that release an instance. An absent session
    is then success, not a denial: the viewer's cleanup legitimately arrives
    after a backend restart wiped the in-memory table, after the idle sweeper
    took it, or after a sibling cleanup call already released it. Denying those
    stops the cleanup from running at all, which is the opposite of what the
    permission check is for.
    """
    from app.services.load import assert_session_deletable, assert_session_owner

    check = assert_session_deletable if teardown else assert_session_owner
    try:
        check(instance_id or "", request_uid(request) or "")
        return None
    except PermissionError:
        return permission_denied_response(
            access_mode="forbidden",
            operation=operation,
            request_id=request_id(request),
            error_code="INSTANCE_OWNER_MISMATCH",
        )


def assert_user_owned_path_or_response(
    request: Request,
    path: str,
    operation: str,
) -> Tuple[Optional[str], Optional[Response]]:
    """Require a destination the caller owns: their storage root, or their disk.

    "User-owned" exists to keep a write out of the read-only Samples area and
    out of another user's tree. A path outside the managed storage roots is
    neither — it is the local user's own filesystem (``docs/local-mode.md``),
    and refusing it turned "export this to the folder I picked" into
    USER_OWNED_PATH_REQUIRED for every folder on the machine.
    """
    uid = request_uid(request) or ""
    authorized, denied = authorize_read_or_response(request, path, operation=operation)
    if denied is not None:
        return None, denied
    abs_path = os.path.abspath(authorized or "")
    if is_local_desktop_path(abs_path):
        return abs_path, None
    storage = os.path.abspath(STORAGE_ROOT)
    try:
        rel = os.path.relpath(abs_path, storage).replace("\\", "/").strip("/")
    except ValueError:
        return None, permission_denied_response(
            access_mode="forbidden",
            operation=operation,
            request_id=request_id(request),
            error_code="USER_OWNED_PATH_REQUIRED",
        )
    parts = rel.split("/")
    if len(parts) < 2 or parts[0] != "users" or parts[1] != uid:
        return None, permission_denied_response(
            access_mode="forbidden",
            operation=operation,
            request_id=request_id(request),
            error_code="USER_OWNED_PATH_REQUIRED",
        )
    return abs_path, None


def sanitize_client_path(path: Optional[str]) -> Optional[str]:
    """Return a storage-relative path for clients; never leak absolute roots."""
    if not path:
        return path
    try:
        abs_path = os.path.abspath(path)
        storage = os.path.abspath(STORAGE_ROOT)
        if abs_path == storage or abs_path.startswith(storage + os.sep):
            return os.path.relpath(abs_path, storage).replace("\\", "/")
    except Exception:
        pass
    return os.path.basename(path.rstrip("/\\"))


# ---------------------------------------------------------------------------
# Coroutine-safe forms
#
# The guards above resolve share ACLs, and that walks the path's ancestors with
# a blocking Firestore lookup per level — measured at 250 ms median for a path
# under ``users/``. A `def` route pays that in its worker thread, where it
# delays only that request. An `async def` route pays it on the only event
# loop, where it stops every other request and every websocket message for the
# same 250 ms. Coroutine handlers must use these.
# ---------------------------------------------------------------------------


async def authorize_read_or_response_async(
    request: Request,
    path: str,
    operation: str = "read",
) -> Tuple[Optional[str], Optional[Response]]:
    """:func:`authorize_read_or_response` off the event loop."""
    return await asyncio.to_thread(
        authorize_read_or_response, request, path, operation
    )


async def guard_write_path_async(
    request: Request,
    path: str,
    operation: str,
) -> Tuple[Optional[str], Optional[Response]]:
    """:func:`guard_write_path` off the event loop."""
    return await asyncio.to_thread(guard_write_path, request, path, operation)


async def assert_user_owned_path_or_response_async(
    request: Request,
    path: str,
    operation: str,
) -> Tuple[Optional[str], Optional[Response]]:
    """:func:`assert_user_owned_path_or_response` off the event loop."""
    return await asyncio.to_thread(
        assert_user_owned_path_or_response, request, path, operation
    )
