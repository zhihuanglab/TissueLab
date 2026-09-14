"""Keeping detached background work alive, and its failures visible.

asyncio holds only WEAK references to tasks, so a task nobody keeps a name for
can be collected mid-flight; and a task nobody awaits swallows its exception
into an "exception was never retrieved" line at GC time, if that. Both apply to
every fire-and-forget spawn in this service — tasknode registration, thumbnail
notifications, the WebSocket health checker, slide bookkeeping.
"""

from __future__ import annotations

from typing import Any, Set

from app.core.logger import logger

# Strong references to in-flight detached work, dropped as each one settles.
_background: Set[Any] = set()


def track_background_task(task: Any, description: str) -> Any:
    """Hold *task* until it settles, and log a failure instead of losing it.

    Accepts anything with the asyncio Future interface — an ``asyncio.Task`` or
    the future returned by ``loop.run_in_executor``. Returns *task* so it can
    wrap a ``create_task`` call inline.
    """
    _background.add(task)

    def _done(finished: Any) -> None:
        _background.discard(finished)
        if finished.cancelled():
            return
        exc = finished.exception()
        if exc is not None:
            logger.warning(
                "Background task failed: %s: %s", description, exc, exc_info=exc
            )

    task.add_done_callback(_done)
    return task

