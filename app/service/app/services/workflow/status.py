"""
Shared workflow execution status vocabulary.

States (lifecycle):
  idle (UI only) | queued | running | cancelling | completed | error | cancelled

Keep this module dependency-free so importers cannot form cycles.
Frontend mirror: utils/agent/workflow/runtimeStatus.ts
"""

from __future__ import annotations

from typing import Optional


class WorkflowStatus:
    """String constants for execution / UI status (mirrors FE WorkflowStatus)."""

    IDLE = "idle"  # UI-only
    QUEUED = "queued"
    RUNNING = "running"
    CANCELLING = "cancelling"
    COMPLETED = "completed"
    ERROR = "error"
    CANCELLED = "cancelled"


ACTIVE_STATUSES = frozenset({
    WorkflowStatus.QUEUED,
    WorkflowStatus.RUNNING,
    WorkflowStatus.CANCELLING,
})
TERMINAL_STATUSES = frozenset({
    WorkflowStatus.COMPLETED,
    WorkflowStatus.ERROR,
    WorkflowStatus.CANCELLED,
})
CANCEL_OWNED_STATUSES = frozenset({
    WorkflowStatus.CANCELLING,
    WorkflowStatus.CANCELLED,
})


def is_active_status(status: Optional[str]) -> bool:
    return status in ACTIVE_STATUSES


def is_terminal_status(status: Optional[str]) -> bool:
    return status in TERMINAL_STATUSES


def is_cancelling_status(status: Optional[str]) -> bool:
    return status == WorkflowStatus.CANCELLING


def is_cancel_owned_status(status: Optional[str]) -> bool:
    """True when Stop owns the execution (cancelling or already cancelled)."""
    return status in CANCEL_OWNED_STATUSES
