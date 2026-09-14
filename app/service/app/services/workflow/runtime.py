"""
Shared in-process workflow runtime state.

Dependency-free on purpose: cancel / queue / start / scheduler / batch all
import from here so they do not need to import each other just for globals.

Do not import cancel, queue, start, scheduler, batch, or tasks from this module.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from app.services.workflow.status import is_terminal_status


@dataclass
class Task:
    """Single node execution within a workflow."""

    task_id: str  # f"{execution_id}_{node_name}"
    workflow_id: int
    node_name: str
    uid: str
    zarr_path: str
    node_inputs: dict
    dependencies: List[str]
    execution_id: str
    status: str = "pending"  # pending | ready | running | completed | failed | cancelled
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    result: Optional[dict] = None
    error: Optional[str] = None


@dataclass
class WorkflowExecution:
    """Tracks a single workflow execution instance."""

    execution_id: str  # f"{uid}_{workflow_id}_{timestamp}"
    workflow_id: int
    uid: str
    zarr_path: str
    auth_header: Optional[str]
    tasks: Dict[str, Task]
    completed_tasks: Set[str] = field(default_factory=set)
    failed_tasks: Set[str] = field(default_factory=set)
    status: str = "queued"  # queued | running | cancelling | completed | error | cancelled
    script_prompt: Optional[str] = None
    script_task_started: bool = False
    created_at: float = field(default_factory=time.time)
    # Stamped by purge_finished_executions, not at the status assignment sites.
    finished_at: Optional[float] = None


# execution_id -> WorkflowExecution
workflow_executions: Dict[str, WorkflowExecution] = {}
# uid -> execution_id
user_active_executions: Dict[str, str] = {}
# model_name -> task_id currently claimed / running
model_current_task: Dict[str, Optional[str]] = {}
# model_name -> Lock
model_locks: Dict[str, asyncio.Lock] = {}
# model_name -> (task_id, asyncio.Task) for in-flight _execute_task runners
model_runner_tasks: Dict[str, tuple] = {}
# execution_id -> in-flight GPT-4o / script generation Task
script_generation_tasks: Dict[str, asyncio.Task] = {}


# How long a finished execution stays queryable before it is reclaimed. Long
# enough that a batch waiter or a status poll always sees the terminal result;
# short enough that the scheduler never walks yesterday's workflows.
FINISHED_EXECUTION_TTL_SEC = 5 * 60


def purge_finished_executions(
    ttl_sec: float = FINISHED_EXECUTION_TTL_SEC,
    now: Optional[float] = None,
) -> int:
    """Drop terminal executions nothing needs any more. Returns how many went.

    ``workflow_executions`` was only ever added to. Every workflow the process
    had ever run stayed resident — together with each task's ``result`` payload
    — and the scheduler loop, which runs ten times a second, walked the whole
    dict twice per pass. The cost of scheduling therefore grew with the number
    of workflows ever run rather than with how many were active.

    ``finished_at`` is stamped here rather than at each ``execution.status =
    ...`` site: there are a dozen of those across scheduler / cancel / start,
    and an index maintained by hand is an invariant waiting to be broken. The
    cost is that an execution lives at most one extra sweep interval.

    Terminal records are safe to drop: ``user_active_executions`` is already
    cleared on terminal, the status endpoint answers ``active: False`` for a
    missing id, and cancel checks membership before indexing.
    """
    current = time.time() if now is None else now
    expired = []
    for execution_id, execution in workflow_executions.items():
        if not is_terminal_status(execution.status):
            # A record that goes back to active (retry) must lose its stamp, or
            # it would be swept mid-run once the old deadline passed.
            execution.finished_at = None
            continue
        if execution.finished_at is None:
            execution.finished_at = current
            continue
        if current - execution.finished_at >= ttl_sec:
            expired.append(execution_id)

    for execution_id in expired:
        execution = workflow_executions.pop(execution_id, None)
        if execution is not None:
            release_user_active_execution(execution.uid, execution_id)
            script_generation_tasks.pop(execution_id, None)
    return len(expired)


def release_user_active_execution(uid: str, execution_id: str) -> None:
    """Drop per-user active pointer when this execution reaches a terminal status."""
    if user_active_executions.get(uid) == execution_id:
        user_active_executions.pop(uid, None)
