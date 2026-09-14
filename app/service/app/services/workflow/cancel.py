"""
Agent-panel workflow cancel state machine.

States:
  queued | running -> cancelling -> cancelled

Events:
  CANCEL_REQUESTED  — user Stop / stop_batch
  CANCEL_SENT       — cooperative POST /cancel to TaskNodes (local + remote)
  TASK_SETTLED      — scheduler task leaves running (wakes waiters)
  FINALIZED         — no running tasks; release queue slot

Panel Stop: cooperative /cancel only — never kills TaskNode processes.
On wait timeout, force-finalize scheduler bookkeeping and cancel orphan
asyncio model runners so model_lock releases, the aiohttp /execute client
closes, and Stop can return. TaskNode may keep running until it honors
/cancel; that is an intentional product constraint (no process kill).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

import requests

from app.services.workflow.ui_state import user_workflow_status
from app.services.workflow.events import (
    notify_execution_update,
    register_execution_waiter,
    unregister_execution_waiter,
)
from app.services.workflow.queue import recalculate_all_queue_positions
from app.services.workflow.runtime import (
    model_current_task,
    model_runner_tasks,
    script_generation_tasks,
    user_active_executions,
    workflow_executions,
)
from app.services.workflow.status import (
    WorkflowStatus,
    is_active_status,
    is_cancelling_status,
    is_terminal_status,
)
from app.utils.workflow.model_store import model_store
from app.utils.workflow.register import CUSTOM_NODE_SERVICE_REGISTRY

logger = logging.getLogger(__name__)

CANCEL_HTTP_TIMEOUT_S = 2.0
# Keep total Stop wall time under the FE UI abort (90s).
CANCEL_WAIT_S = 80.0


def has_running_tasks(execution: Any) -> bool:
    if any(task.status == "running" for task in execution.tasks.values()):
        return True
    # Script-only / post-settle GPT-4o phase has no running TaskNode, but Stop
    # must wait until the background script Task settles (or is cancelled).
    runner = script_generation_tasks.get(getattr(execution, "execution_id", None))
    return bool(runner is not None and not runner.done())


def cancel_non_running_tasks(execution: Any, model_current_task_map: dict) -> None:
    """Mark pending/ready tasks cancelled and clear model ownership."""
    for task in execution.tasks.values():
        if task.status not in ("pending", "ready"):
            continue
        task.status = WorkflowStatus.CANCELLED
        task.completed_at = time.time()
        task.error = task.error or "Workflow was cancelled"
        if model_current_task_map.get(task.node_name) == task.task_id:
            model_current_task_map[task.node_name] = None


def resolve_tasknode_cancel_host_port(node_name: str) -> tuple[Optional[str], Optional[int]]:
    """Host + port for Model Zoo tasknode HTTP (POST /cancel). Local uses 127.0.0.1."""
    try:
        is_remote = False
        remote_host = None
        port = None
        for _registry_key, registry_data in CUSTOM_NODE_SERVICE_REGISTRY.items():
            if registry_data.get("model_name") == node_name:
                is_remote = registry_data.get("is_remote") is True
                remote_host = registry_data.get("remote_host")
                port = registry_data.get("port")
                break
        if port is None:
            nodes_extended = model_store.get_nodes_extended()
            if nodes_extended and node_name in nodes_extended:
                node_data = nodes_extended[node_name]
                runtime = node_data.get("runtime") or {}
                is_remote = runtime.get("is_remote") is True
                remote_host = remote_host or runtime.get("remote_host")
                port = port or runtime.get("port")
        if port is None:
            return None, None
        if is_remote and remote_host:
            return str(remote_host), int(port)
        return "127.0.0.1", int(port)
    except Exception as e:
        logger.warning(f"[CANCEL_WORKFLOW] Could not resolve host/port for {node_name}: {e}")
        return None, None


def post_tasknode_cancel(
    host: str,
    port: int,
    node_name: str,
    timeout: float = CANCEL_HTTP_TIMEOUT_S,
) -> None:
    cancel_url = f"http://{host}:{port}/cancel"
    try:
        response = requests.post(cancel_url, json={}, timeout=timeout)
        response.raise_for_status()
        logger.info(f"[CANCEL_WORKFLOW] /cancel accepted for {node_name}")
    except Exception as e:
        # Cooperative only — TaskNode may be mid-checkpoint; scheduler waits for /execute exit.
        logger.warning(f"[CANCEL_WORKFLOW] /cancel failed for {node_name}: {e}")


async def send_cooperative_cancels(running_tasks: list) -> None:
    """Fire parallel POST /cancel for running tasks (local + remote). Never kills processes."""
    cancel_jobs = []
    for task in running_tasks:
        host, port = resolve_tasknode_cancel_host_port(task.node_name)
        if not host or not port:
            logger.warning(
                f"[CANCEL_WORKFLOW] No HTTP /cancel endpoint for {task.node_name}; "
                f"waiting for /execute to finish"
            )
            continue
        cancel_jobs.append(
            asyncio.to_thread(post_tasknode_cancel, host, port, task.node_name, CANCEL_HTTP_TIMEOUT_S)
        )
    if cancel_jobs:
        await asyncio.gather(*cancel_jobs, return_exceptions=True)


def force_mark_running_tasks_cancelled(execution: Any, reason: str) -> None:
    """
    Last-resort scheduler bookkeeping when /cancel was sent but tasks never settled
    before the Stop wait deadline. Does not kill TaskNode processes.
    """
    for task in execution.tasks.values():
        if task.status != "running":
            continue
        task.status = WorkflowStatus.CANCELLED
        task.completed_at = time.time()
        task.error = reason
        if model_current_task.get(task.node_name) == task.task_id:
            model_current_task[task.node_name] = None


async def cancel_script_generation(execution_id: str) -> None:
    """Cancel in-flight GPT-4o / script generation for this execution (if any)."""
    runner = script_generation_tasks.get(execution_id)
    if runner is None or runner.done():
        return
    runner.cancel()
    await asyncio.gather(runner, return_exceptions=True)


async def cancel_orphan_model_runners(execution: Any) -> None:
    """
    Cancel in-flight _execute_task runners for this execution so async with
    model_lock can exit and the aiohttp /execute client closes. TaskNode may
    still run until it honors /cancel.
    """
    runners = []
    for task in execution.tasks.values():
        entry = model_runner_tasks.get(task.node_name)
        if not entry:
            continue
        task_id, runner = entry
        if task_id != task.task_id or runner.done():
            continue
        runner.cancel()
        runners.append(runner)
    if runners:
        await asyncio.gather(*runners, return_exceptions=True)


def try_finalize_cancelling_execution(execution_id: str) -> bool:
    """
    State-machine step: cancelling -> cancelled when no task is still running.

    Called from the scheduler when a task settles, and from stop_workflow itself.
    Returns True if the execution is now terminal cancelled.
    """
    execution = workflow_executions.get(execution_id)
    if execution is None:
        return True
    if execution.status == WorkflowStatus.CANCELLED:
        notify_execution_update(execution_id)
        return True
    if not is_cancelling_status(execution.status):
        return False
    if has_running_tasks(execution):
        # Still running — wait for scheduler settle notify. Do not notify here:
        # the stop waiter may be calling us and would busy-spin on its own Event.
        return False

    cancel_non_running_tasks(execution, model_current_task)
    for task in execution.tasks.values():
        if model_current_task.get(task.node_name) == task.task_id:
            model_current_task[task.node_name] = None

    if execution.uid in user_workflow_status:
        user_workflow_status[execution.uid]["status"] = WorkflowStatus.CANCELLED
        user_workflow_status[execution.uid]["is_generating"] = False

    execution.status = WorkflowStatus.CANCELLED
    if execution.uid in user_active_executions and user_active_executions.get(execution.uid) == execution_id:
        del user_active_executions[execution.uid]

    try:
        recalculate_all_queue_positions()
    except Exception as exc:
        logger.warning(f"[CANCEL_WORKFLOW] queue recalc failed: {exc}")

    notify_execution_update(execution_id)
    logger.info(f"[CANCEL_WORKFLOW] Execution {execution_id} -> cancelled (state machine)")
    return True


async def await_execution_cancelled(execution_id: str, timeout_s: float) -> bool:
    """
    Event-driven wait until execution leaves cancelling (no sleep polling).

    Returns True if cancelled/terminal within timeout_s, else False.
    Woken by notify_execution_update when tasks settle.
    """

    def _settled() -> bool:
        execution = workflow_executions.get(execution_id)
        if execution is None:
            return True
        st = getattr(execution, "status", None)
        # Terminal (cancelled/completed/error) means Stop can unlock.
        if is_terminal_status(st):
            return True
        # Still in cancel SM — try to finalize when nothing is running.
        if is_cancelling_status(st):
            return try_finalize_cancelling_execution(execution_id)
        # Dropped back to queued/running (or unknown): not a successful settle.
        # Keep waiting until timeout force path re-asserts cancelling.
        return False

    if _settled():
        return True

    deadline = time.monotonic() + max(0.0, float(timeout_s))
    wake = asyncio.Event()
    register_execution_waiter(execution_id, wake)
    try:
        while True:
            if _settled():
                return True

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False

            # clear() may drop a notify that raced between the checks above and wait().
            # Re-check immediately after clear so we never sleep on a terminal state.
            wake.clear()
            if _settled():
                return True

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            try:
                await asyncio.wait_for(wake.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                return try_finalize_cancelling_execution(execution_id)
    finally:
        unregister_execution_waiter(execution_id, wake)


def _enter_cancelling(execution: Any, status_by_uid: dict, model_current_task_map: dict) -> None:
    """Transition execution (+ UI status) to cancelling and drop pending/ready work."""
    if is_cancelling_status(execution.status):
        cancel_non_running_tasks(execution, model_current_task_map)
        notify_execution_update(execution.execution_id)
        return
    execution.status = WorkflowStatus.CANCELLING
    if execution.uid in status_by_uid:
        status_by_uid[execution.uid]["status"] = WorkflowStatus.CANCELLING
        status_by_uid[execution.uid]["is_generating"] = False
    cancel_non_running_tasks(execution, model_current_task_map)
    notify_execution_update(execution.execution_id)
    logger.info(f"[CANCEL_WORKFLOW] Execution {execution.execution_id} -> cancelling")


def _resolve_execution_id(uid: str = None, zarr_path: str = None) -> Optional[str]:
    """
    Prefer the user's active execution; for zarr, prefer active then newest.

    When uid is provided, only that user's executions are eligible — never
    stop another user's run by shared zarr_path alone.
    """
    if uid and uid in user_active_executions:
        return user_active_executions[uid]

    if not zarr_path:
        return None

    active_match = None
    newest_id = None
    newest_created = float("-inf")
    for exec_id, execution in workflow_executions.items():
        if execution.zarr_path != zarr_path:
            continue
        if uid and getattr(execution, "uid", None) != uid:
            continue
        created = float(getattr(execution, "created_at", 0) or 0)
        if created >= newest_created:
            newest_created = created
            newest_id = exec_id
        if is_active_status(execution.status):
            active_match = exec_id
    return active_match or newest_id


async def stop_workflow_by_scheduler(uid: str = None, zarr_path: str = None):
    """
    Stop a workflow via cooperative cancel only (agent/workflow panel).

    1) POST /cancel to local and remote TaskNodes (never kill processes)
    2) Event wait (bounded)
    3) If still unsettled: force-finalize scheduler bookkeeping so Stop returns
    """
    execution_id = _resolve_execution_id(uid=uid, zarr_path=zarr_path)

    if not execution_id or execution_id not in workflow_executions:
        return {"success": False, "error": "No running workflow found"}

    execution = workflow_executions[execution_id]
    if uid and getattr(execution, "uid", None) != uid:
        return {"success": False, "error": "No running workflow found", "code": 403}

    running = has_running_tasks(execution)

    if execution.status == WorkflowStatus.CANCELLED and not running:
        logger.info(f"Workflow {execution_id} is already cancelled")
        return {"success": True, "message": "Workflow is already cancelled"}

    if execution.status == WorkflowStatus.QUEUED and not running:
        _enter_cancelling(execution, user_workflow_status, model_current_task)
        try_finalize_cancelling_execution(execution_id)
        return {"success": True, "message": "Queued workflow cancelled"}

    if is_terminal_status(execution.status) and not running:
        return {"success": True, "message": "Workflow is not active"}

    _enter_cancelling(execution, user_workflow_status, model_current_task)

    # Script phase (no TaskNode /cancel) — cancel the asyncio runner so Stop can settle.
    await cancel_script_generation(execution_id)

    running_before = [t for t in execution.tasks.values() if t.status == "running"]
    if running_before:
        await send_cooperative_cancels(running_before)

    if await await_execution_cancelled(execution_id, CANCEL_WAIT_S):
        return {"success": True, "message": "Workflow cancelled", "status": WorkflowStatus.CANCELLED}

    logger.warning(
        "[CANCEL_WORKFLOW] /cancel wait timed out for %s; force-finalizing scheduler state "
        "(TaskNode processes are not killed)",
        execution_id,
    )
    # If status was revived out of cancelling, re-enter so try_finalize can commit.
    if not is_cancelling_status(execution.status) and not is_terminal_status(execution.status):
        _enter_cancelling(execution, user_workflow_status, model_current_task)

    force_mark_running_tasks_cancelled(
        execution,
        "Cancel wait timed out after /cancel; scheduler force-finalized (process not killed)",
    )
    # Release model_lock + close aiohttp /execute client held by orphaned runner.
    await cancel_orphan_model_runners(execution)
    # Script may have been spawned after the first cancel (race with scheduler tick).
    await cancel_script_generation(execution_id)
    try_finalize_cancelling_execution(execution_id)
    if execution.status == WorkflowStatus.CANCELLED:
        return {
            "success": True,
            "message": "Workflow force-cancelled after /cancel timeout",
            "status": WorkflowStatus.CANCELLED,
            "forced": True,
        }

    return {
        "success": False,
        "error": "Failed to cancel workflow before timeout",
        "status": getattr(execution, "status", None),
    }


async def stop_workflow_async(zarr_path: str, uid: str | None = None):
    """Async stop scoped to an authenticated user (uid required)."""
    if not uid:
        return {"success": False, "error": "Authentication required", "code": 401}
    return await stop_workflow_by_scheduler(uid=uid, zarr_path=zarr_path)