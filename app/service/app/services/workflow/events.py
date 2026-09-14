"""
Execution-level wake events for Stop / batch waiters.

Dependency-free: no imports from cancel, queue, start, scheduler, batch, or tasks.
"""

from __future__ import annotations

import asyncio
from typing import Dict, Optional, Set

# execution_id -> waiters woken when the execution leaves active statuses
# OR when a task settles during cancelling (state-machine progress).
_execution_waiters: Dict[str, Set[asyncio.Event]] = {}


def notify_execution_update(execution_id: Optional[str]) -> None:
    """Wake stop/batch waiters on cancel-state progress or terminal settle."""
    if not execution_id:
        return
    for ev in list(_execution_waiters.get(execution_id) or ()):
        ev.set()


def register_execution_waiter(execution_id: str, ev: asyncio.Event) -> None:
    _execution_waiters.setdefault(execution_id, set()).add(ev)


def unregister_execution_waiter(execution_id: str, ev: asyncio.Event) -> None:
    waiters = _execution_waiters.get(execution_id)
    if not waiters:
        return
    waiters.discard(ev)
    if not waiters:
        _execution_waiters.pop(execution_id, None)


# Optional hook so scheduler can wake batch SSE without importing batch_orchestrator
# (batch_orchestrator → start → scheduler would otherwise cycle).
_batch_progress_notifier = None


def register_batch_progress_notifier(fn) -> None:
    global _batch_progress_notifier
    _batch_progress_notifier = fn


def notify_batch_progress(uid: Optional[str]) -> None:
    """Wake pre_run batch SSE on node progress; no-op until batch registers."""
    fn = _batch_progress_notifier
    if fn is not None:
        fn(uid)

