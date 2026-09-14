"""Instance-scoped segmentation handler registry.

Handlers are keyed by viewer ``instance_id`` (session), not by browser
``device_id``. Device IDs remain for WebSocket connection multiplexing only.

Rules:
  - APIs that need in-memory segmentation state MUST send ``X-Instance-ID``.
  - Path-only APIs (read/write zarr by explicit path) must NOT look up handlers.
  - After out-of-band zarr writes (workflows, reset_*), refresh matching handlers
    by comparing ``handler.zarr_file`` to the written path.
  - Handler APIs must not rebind an existing handler to a different path via query;
    path bind happens only through WS ``set_path`` / ``ensure_file`` on the bound slide.
  - Idle handlers (no access for HANDLER_IDLE_TTL_SEC) are swept to free centroids/KDTree RAM.
"""

from __future__ import annotations

import threading
import time
from typing import Dict, Iterable, Optional, Tuple

from app.core.logger import logger
from app.core.settings import settings
from app.services.seg import SegmentationHandler

# Drop heavy in-memory worksets after this idle window. Frontend reconnect /
# delayed delete_instance is ~30–50s; keep a comfortable buffer for pan/zoom
# silence. The desktop build sets it to 0 — see settings.HANDLER_IDLE_TTL_SEC.
HANDLER_IDLE_TTL_SEC = settings.HANDLER_IDLE_TTL_SEC

# instance_id -> SegmentationHandler
instance_annotation_handlers: Dict[str, SegmentationHandler] = {}
# instance_id -> monotonic last-access timestamp
_handler_last_access: Dict[str, float] = {}
_registry_lock = threading.RLock()


def _release_export_pool(instance_id: str, handler) -> None:
    """Close a released handler's export thread pool.

    Dropping the registry's reference frees the handler's memory, but a
    ThreadPoolExecutor's workers are not reliably retired by garbage collection,
    so the one pool it owns is closed explicitly. This does NOT touch the
    handler's data, so a request still holding it keeps working — and its
    in-flight exports are allowed to finish.
    """
    if handler is None:
        return
    try:
        handler.release_export_pool()
    except Exception as e:
        logger.warning(f"Failed to release export pool for instance {instance_id}: {e}")


def _touch_unlocked(instance_id: str) -> None:
    _handler_last_access[instance_id] = time.monotonic()


def touch_annotation_handler(instance_id: Optional[str]) -> None:
    """Refresh last-access time so the idle sweeper keeps the handler."""
    if not instance_id:
        return
    with _registry_lock:
        if instance_id in instance_annotation_handlers:
            _touch_unlocked(instance_id)


def get_annotation_handler(instance_id: Optional[str]) -> Optional[SegmentationHandler]:
    if not instance_id:
        return None
    with _registry_lock:
        handler = instance_annotation_handlers.get(instance_id)
        if handler is not None:
            _touch_unlocked(instance_id)
        return handler


def require_annotation_handler(instance_id: Optional[str]) -> SegmentationHandler:
    handler = get_annotation_handler(instance_id)
    if handler is None:
        raise KeyError("No segmentation handler for instance")
    return handler


def get_or_create_annotation_handler(
    instance_id: str,
    file_path: Optional[str] = None,
    *,
    need_centroids: bool = False,
    need_patches: bool = False,
) -> SegmentationHandler:
    """Return the instance handler, creating it if absent.

    When ``file_path`` is provided, bind/ensure the handler to that zarr.
    """
    if not instance_id:
        raise ValueError("instance_id is required")

    with _registry_lock:
        handler = instance_annotation_handlers.get(instance_id)
        if handler is None:
            handler = SegmentationHandler()
            instance_annotation_handlers[instance_id] = handler
        _touch_unlocked(instance_id)

    if file_path:
        handler.ensure_file(
            file_path,
            need_centroids=need_centroids,
            need_patches=need_patches,
        )
    return handler


def set_annotation_handler(instance_id: str, handler: SegmentationHandler) -> None:
    if not instance_id:
        raise ValueError("instance_id is required")
    with _registry_lock:
        instance_annotation_handlers[instance_id] = handler
        _touch_unlocked(instance_id)


def pop_instance_handlers(instance_id: Optional[str]) -> None:
    """Drop the segmentation handler for an instance (session teardown)."""
    if not instance_id:
        return
    # Dropping the registry's reference IS the release. Deliberately not
    # handler.reset_data(): that closes the store and nulls centroids /
    # contours / KDTree in place, and callers hold plain references handed out
    # by get_annotation_handler — resetting one still being read wiped that
    # request's data mid-flight. Refcounting frees the same memory the moment
    # the last user finishes, and the store is a zarr LocalStore, which holds
    # no OS handle to close.
    with _registry_lock:
        handler = instance_annotation_handlers.pop(instance_id, None)
        _handler_last_access.pop(instance_id, None)
    _release_export_pool(instance_id, handler)


def iter_annotation_handlers() -> Iterable[Tuple[str, SegmentationHandler]]:
    with _registry_lock:
        return list(instance_annotation_handlers.items())


def reload_handlers_for_zarr_path(
    zarr_path: str,
    *,
    force_reload: bool = True,
    reload_segmentation_data: bool = True,
) -> int:
    """Reload every instance handler currently bound to ``zarr_path``. Returns count."""
    if not zarr_path:
        return 0
    reloaded = 0
    for instance_id, handler in iter_annotation_handlers():
        if handler is None or not getattr(handler, "zarr_file", None):
            continue
        if not SegmentationHandler._same_zarr_path(handler.zarr_file, zarr_path):
            continue
        try:
            if hasattr(handler, "invalidate_user_counts_cache"):
                handler.invalidate_user_counts_cache()
            handler.load_file(
                zarr_path,
                force_reload=force_reload,
                reload_segmentation_data=reload_segmentation_data,
            )
            touch_annotation_handler(instance_id)
            reloaded += 1
        except Exception as e:
            logger.warning(
                f"Failed to reload handler for instance {instance_id} path {zarr_path}: {e}"
            )
    return reloaded


def clear_all_instance_handlers() -> None:
    with _registry_lock:
        ids = list(instance_annotation_handlers.keys())
    for instance_id in ids:
        pop_instance_handlers(instance_id)


def sweep_idle_handlers(ttl_sec: float = HANDLER_IDLE_TTL_SEC) -> int:
    """Release handlers that have not been touched within ``ttl_sec``.

    Does not delete the slide ``sessions`` entry — tiles can keep working; the next
    WS ``set_path`` / viewport message recreates the handler.
    """
    if ttl_sec <= 0:
        return 0
    now = time.monotonic()
    swept: list[tuple[str, SegmentationHandler]] = []
    with _registry_lock:
        idle_ids = [
            iid
            for iid, last in list(_handler_last_access.items())
            if (now - last) >= ttl_sec and iid in instance_annotation_handlers
        ]
        for iid in idle_ids:
            # Re-check under the same lock so a concurrent touch cannot be swept.
            last = _handler_last_access.get(iid)
            if last is None or (now - last) < ttl_sec:
                continue
            handler = instance_annotation_handlers.pop(iid, None)
            if handler is not None:
                _handler_last_access.pop(iid, None)
                swept.append((iid, handler))

    # See pop_instance_handlers: dropping the reference is the release.
    for iid, handler in swept:
        logger.info(
            f"Sweeping idle segmentation handler for instance {iid} "
            f"(idle >= {ttl_sec:.0f}s)"
        )
        _release_export_pool(iid, handler)
    return len(swept)


def handler_registry_stats() -> Dict[str, int]:
    with _registry_lock:
        return {
            "handlers": len(instance_annotation_handlers),
            "tracked_access": len(_handler_last_access),
        }
