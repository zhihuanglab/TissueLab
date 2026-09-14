"""
In-process multi-file workflow batch orchestrator.

Frontend submits per-file start_workflow payloads once; this module runs them
serially so closing the browser tab does not stop the queue.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional, Set

from app.services.workflow.events import (
    notify_execution_update,
    register_batch_progress_notifier,
    register_execution_waiter,
    unregister_execution_waiter,
)
from app.services.workflow.runtime import workflow_executions
from app.services.workflow.status import ACTIVE_STATUSES, TERMINAL_STATUSES, is_active_status
from app.services.workflow.ui_state import user_workflow_status

logger = logging.getLogger(__name__)

# Short timeout for event-wait fallback (not a poll loop).
WAIT_POLL_SECONDS = 0.5
# How long a finished job stays in `_active_by_uid` so the final SSE frame
# can still be built; GET /batch/active already ignores non-running jobs.
FINISHED_RETENTION_SECONDS = 5.0
# SSE idle keepalive (progress wakes via notify_batch_progress, not a poll loop).
SSE_HEARTBEAT_SECONDS = 15.0

# All mutable state is keyed by uid — users never share a BatchJob or SSE set.
_active_by_uid: Dict[str, "BatchJob"] = {}
# Per-uid locks so start/append for user A never blocks user B.
_locks_by_uid: Dict[str, asyncio.Lock] = {}
# Per-uid SSE subscribers (asyncio.Queue); notify wakes them to push a snapshot.
_subscribers: Dict[str, Set[asyncio.Queue]] = {}

def _uid_lock(uid: str) -> asyncio.Lock:
    lock = _locks_by_uid.get(uid)
    if lock is None:
        lock = asyncio.Lock()
        _locks_by_uid[uid] = lock
    return lock




@dataclass
class BatchItem:
    path: str
    zarr_path: str
    status: str = "queued"  # queued | running | completed | error | skipped
    execution_id: Optional[str] = None
    error_message: Optional[str] = None
    error_phase: Optional[str] = None  # start | runtime | skipped
    started_at: Optional[float] = None
    finished_at: Optional[float] = None


@dataclass
class BatchJob:
    id: str
    uid: str
    items: List[BatchItem]
    payloads: List[Optional[Dict[str, Any]]]
    stop_on_first_error: bool = True
    source: str = "workflow"  # "workflow" | "pre_run"
    aggregate_status: str = "running"  # running | completed | partial_failure | aborted_by_user
    current_index: int = 0
    current_path: Optional[str] = None
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    auth_header: Optional[str] = None
    abort_requested: bool = False
    worker_task: Optional[asyncio.Task] = field(default=None, repr=False)


def subscribe_batch_events(uid: str) -> asyncio.Queue:
    """Register an SSE listener wake-queue for ``uid``. Caller must unsubscribe.

    maxsize=1: entries are wake signals only; snapshots are always rebuilt from
    current state, so extra notifies coalesce via QueueFull.
    """
    q: asyncio.Queue = asyncio.Queue(maxsize=1)
    _subscribers.setdefault(uid, set()).add(q)
    return q


def unsubscribe_batch_events(uid: str, q: asyncio.Queue) -> None:
    subs = _subscribers.get(uid)
    if not subs:
        return
    subs.discard(q)
    if not subs:
        _subscribers.pop(uid, None)


def notify_batch(uid: str) -> None:
    """Wake SSE listeners so they push a fresh snapshot (best-effort, non-blocking)."""
    for q in list(_subscribers.get(uid) or ()):
        try:
            q.put_nowait(True)
        except asyncio.QueueFull:
            # Already pending a wake — coalesced.
            pass


def notify_batch_progress(uid: Optional[str]) -> None:
    """Wake batch SSE on node_progress changes — only for pre_run (progress bar).

    Workflow FE ignores progressPct frames via persist-key; waking it on every
    tick is wasted work. Also registered on workflow.events so scheduler does
    not import this module.
    """
    if not uid:
        return
    job = get_active_batch(uid)
    if job and job.source == "pre_run":
        notify_batch(uid)


register_batch_progress_notifier(notify_batch_progress)


def _batch_event_payload(uid: str) -> Dict[str, Any]:
    job = get_batch_for_uid(uid)
    if not job:
        return {"type": "snapshot", "active": False, "batch": None}
    return {
        "type": "snapshot",
        "active": job.aggregate_status == "running",
        "batch": batch_job_snapshot(job),
    }


async def generate_batch_events(uid: str) -> AsyncIterator[str]:
    """SSE generator: snapshot on connect / notify; heartbeat keepalive."""
    q = subscribe_batch_events(uid)
    try:
        yield f"data: {json.dumps(_batch_event_payload(uid), ensure_ascii=False, default=str)}\n\n"
        while True:
            try:
                await asyncio.wait_for(q.get(), timeout=SSE_HEARTBEAT_SECONDS)
                while True:
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                yield f"data: {json.dumps(_batch_event_payload(uid), ensure_ascii=False, default=str)}\n\n"
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'heartbeat': True, 'ts': int(time.time())})}\n\n"
    finally:
        unsubscribe_batch_events(uid, q)


def has_active_batch(uid: str) -> bool:
    job = _active_by_uid.get(uid)
    return bool(job and job.aggregate_status == "running")


def get_active_batch(uid: str) -> Optional[BatchJob]:
    """Return the in-progress batch only (aggregate_status == running)."""
    job = _active_by_uid.get(uid)
    if job and job.aggregate_status == "running":
        return job
    return None


def get_batch_for_uid(uid: str) -> Optional[BatchJob]:
    """Return the user's current or most recently finished batch (until replaced)."""
    return _active_by_uid.get(uid)


def _counts(job: BatchJob) -> Dict[str, int]:
    return {
        "completedCount": sum(1 for i in job.items if i.status == "completed"),
        "failedCount": sum(1 for i in job.items if i.status == "error"),
        "skippedCount": sum(1 for i in job.items if i.status == "skipped"),
    }


def _running_progress_pct(uid: str) -> Optional[int]:
    """Best-effort node progress for the user's active workflow (for batch UI)."""
    try:
        user_status = user_workflow_status.get(uid) or {}
        if not is_active_status(user_status.get("status")):
            return None
        node_progress = user_status.get("node_progress") or {}
        if not isinstance(node_progress, dict) or not node_progress:
            return None
        if "CellCast" in node_progress:
            return int(max(0, min(100, float(node_progress["CellCast"]))))
        vals = [float(v) for v in node_progress.values() if isinstance(v, (int, float))]
        if not vals:
            return None
        return int(max(0, min(100, max(vals))))
    except Exception:
        return None


def batch_job_snapshot(job: BatchJob) -> Dict[str, Any]:
    counts = _counts(job)
    # Live % is only consumed by pre_run UI; skip the lookup for workflow batches.
    live_pct = (
        _running_progress_pct(job.uid)
        if job.aggregate_status == "running" and job.source == "pre_run"
        else None
    )
    items_out = []
    for item in job.items:
        entry = {
            "path": item.path,
            "zarrPath": item.zarr_path,
            "status": item.status,
            "executionId": item.execution_id,
            "errorMessage": item.error_message,
            "errorPhase": item.error_phase,
            "startedAt": int(item.started_at * 1000) if item.started_at else None,
            "finishedAt": int(item.finished_at * 1000) if item.finished_at else None,
            "durationMs": (
                int((item.finished_at - item.started_at) * 1000)
                if item.started_at and item.finished_at
                else None
            ),
        }
        if item.status == "running" and live_pct is not None:
            entry["progressPct"] = live_pct
        elif item.status == "completed":
            entry["progressPct"] = 100
        items_out.append(entry)

    return {
        "id": job.id,
        "source": job.source,
        "aggregateStatus": job.aggregate_status,
        "startedAt": int(job.started_at * 1000),
        "finishedAt": int(job.finished_at * 1000) if job.finished_at else None,
        "settings": {
            "stopOnFirstError": job.stop_on_first_error,
        },
        "progress": {
            "currentIndex": job.current_index,
            "total": len(job.items),
            "currentPath": job.current_path,
        },
        "items": items_out,
        "completedCount": counts["completedCount"],
        "failedCount": counts["failedCount"],
        "skippedCount": counts["skippedCount"],
    }


def _skip_remaining(job: BatchJob, message: str = "Stopped by user.") -> None:
    for item in job.items:
        if item.status == "queued":
            item.status = "skipped"
            item.error_phase = "skipped"
            item.error_message = message
            item.finished_at = time.time()


def _fail_item(
    job: BatchJob,
    item: BatchItem,
    *,
    phase: str,
    message: str,
) -> bool:
    """Mark item failed. Returns True if the batch loop should stop."""
    item.status = "error"
    item.error_phase = phase
    item.error_message = message
    item.finished_at = time.time()
    if job.abort_requested:
        _skip_remaining(job)
        return True
    if job.stop_on_first_error:
        _skip_remaining(job, "Skipped after earlier failure.")
        return True
    return False


def _mark_running(job: BatchJob, index: int, item: BatchItem) -> None:
    """Flip item to running and push immediately so UI updates before the long wait."""
    job.current_index = index + 1
    job.current_path = item.path
    item.status = "running"
    item.started_at = time.time()
    item.error_message = None
    item.error_phase = None
    notify_batch(job.uid)


def _finalize(job: BatchJob) -> None:
    counts = _counts(job)
    if job.abort_requested:
        job.aggregate_status = "aborted_by_user"
    elif counts["failedCount"] > 0 or counts["skippedCount"] > 0:
        job.aggregate_status = "partial_failure"
    else:
        job.aggregate_status = "completed"
    job.finished_at = time.time()
    job.current_path = None
    logger.info(
        "[batch] finalized %s uid=%s status=%s completed=%s failed=%s skipped=%s",
        job.id,
        job.uid,
        job.aggregate_status,
        counts["completedCount"],
        counts["failedCount"],
        counts["skippedCount"],
    )
    notify_batch(job.uid)
    try:
        asyncio.get_running_loop().create_task(_expire_finished_job(job))
    except RuntimeError:
        # No running loop (unlikely in production worker path).
        if _active_by_uid.get(job.uid) is job:
            _active_by_uid.pop(job.uid, None)


async def _expire_finished_job(job: BatchJob) -> None:
    """Drop finished jobs after a short retention so final SSE can flush."""
    try:
        await asyncio.sleep(FINISHED_RETENTION_SECONDS)
    except asyncio.CancelledError:
        return
    if _active_by_uid.get(job.uid) is job and job.aggregate_status != "running":
        _active_by_uid.pop(job.uid, None)


async def _call_start_workflow(body: dict, uid: str, auth_header: Optional[str]) -> dict:
    # Function-level: start imports tasks at top; tasks late-imports start.
    # Loading start before tasks finishes raises a partial-import error.
    from app.services.workflow.start import start_workflow_from_frontend

    return await start_workflow_from_frontend(body, uid, auth_header=auth_header)


async def _call_stop_workflow(uid: str) -> dict:
    from app.services.workflow.cancel import stop_workflow_by_scheduler

    return await stop_workflow_by_scheduler(uid=uid)


def _get_workflow_executions() -> Dict[str, Any]:
    return workflow_executions


async def _wait_execution_terminal(execution_id: str, job: BatchJob) -> str:
    """Wait until the execution leaves queued/running/cancelling. Returns terminal status.

    Prefers event wakeups from ``notify_execution_update``; falls back to a
    short poll so we still converge if a status write misses a notify.
    """
    wake = asyncio.Event()
    register_execution_waiter(execution_id, wake)
    try:
        while True:
            executions = _get_workflow_executions()
            execution = executions.get(execution_id)
            if execution is None:
                return "error"
            # Guard against accidental cross-user wait if ids ever collide / leak.
            exec_uid = getattr(execution, "uid", None)
            if exec_uid and exec_uid != job.uid:
                logger.error(
                    "[batch] execution %s uid=%s does not match batch uid=%s",
                    execution_id,
                    exec_uid,
                    job.uid,
                )
                return "error"
            status = getattr(execution, "status", None)
            if status not in ACTIVE_STATUSES:
                return status if status in TERMINAL_STATUSES else "error"
            try:
                await asyncio.wait_for(wake.wait(), timeout=WAIT_POLL_SECONDS)
            except asyncio.TimeoutError:
                pass
            else:
                wake.clear()
    finally:
        unregister_execution_waiter(execution_id, wake)


async def _run_batch(job: BatchJob) -> None:
    try:
        # while + next-queued so append_batch can add items mid-run.
        while True:
            if job.abort_requested:
                _skip_remaining(job)
                break

            index = next((i for i, it in enumerate(job.items) if it.status == "queued"), None)
            if index is None:
                break

            item = job.items[index]
            payload = job.payloads[index] if index < len(job.payloads) else None
            _mark_running(job, index, item)

            # After settle: next _mark_running (continue) or _finalize (break)
            # wakes SSE — no extra notify here.
            if not isinstance(payload, dict):
                if _fail_item(
                    job, item, phase="start", message="Missing workflow payload for this file."
                ):
                    break
                continue

            try:
                body = dict(payload)
                body.pop("force_override", None)
                result = await _call_start_workflow(body, job.uid, job.auth_header)
                # Conflict with a leftover active/cancelling run: join cancel once, then retry.
                err_msg = str(result.get("error") or "")
                if (
                    not result.get("success")
                    and result.get("code") == 409
                    and not job.abort_requested
                    and "cancelled during start" not in err_msg.lower()
                    and (
                        "already has a workflow" in err_msg.lower()
                        or "still cancelling" in err_msg.lower()
                    )
                ):
                    result = await _call_start_workflow(
                        {**body, "force_override": True},
                        job.uid,
                        job.auth_header,
                    )
            except Exception as exc:
                logger.exception("[batch] start_workflow raised for %s: %s", item.path, exc)
                if _fail_item(
                    job, item, phase="start", message=str(exc) or "Failed to start workflow."
                ):
                    break
                continue

            if not result.get("success"):
                err_msg = result.get("error") or "Failed to start workflow."
                cancelled_during_start = (
                    job.abort_requested
                    or result.get("code") == 409
                    or "cancelled during start" in str(err_msg).lower()
                )
                if cancelled_during_start:
                    item.status = "skipped"
                    item.error_phase = "skipped"
                    item.error_message = "Stopped by user."
                    item.finished_at = time.time()
                    _skip_remaining(job)
                    break
                if _fail_item(
                    job,
                    item,
                    phase="start",
                    message=err_msg,
                ):
                    break
                continue

            execution_id = result.get("execution_id")
            item.execution_id = execution_id
            if not execution_id:
                if _fail_item(
                    job, item, phase="start", message="Workflow started without execution_id."
                ):
                    break
                continue

            # Stop may have landed during start_workflow (before user_active_executions
            # existed). Re-issue stop so wait can observe cancelled.
            if job.abort_requested:
                try:
                    await _call_stop_workflow(job.uid)
                except Exception:
                    pass

            try:
                terminal = await _wait_execution_terminal(execution_id, job)
            except Exception as exc:
                logger.exception("[batch] wait failed for %s: %s", execution_id, exc)
                terminal = "error"

            item.finished_at = time.time()
            # Prefer real terminal outcome over a late abort flag (e.g. stop after
            # the workflow already completed).
            if terminal == "completed":
                item.status = "completed"
                if job.abort_requested:
                    _skip_remaining(job)
                    break
            elif job.abort_requested or terminal == "cancelled":
                item.status = "skipped"
                item.error_phase = "skipped"
                item.error_message = "Stopped by user."
                _skip_remaining(job)
                break
            elif _fail_item(
                job,
                item,
                phase="runtime",
                message=f"Workflow ended with status '{terminal}'.",
            ):
                break

        if job.abort_requested:
            _skip_remaining(job)
            # stop_batch already issued stop_workflow; only push skipped state here.
            notify_batch(job.uid)
    except Exception as exc:
        logger.exception("[batch] worker crashed for %s: %s", job.id, exc)
        for item in job.items:
            if item.status in ("queued", "running"):
                item.status = "error"
                item.error_phase = "runtime"
                item.error_message = f"Batch worker error: {exc}"
                item.finished_at = time.time()
        # Best-effort: don't leave an orphan running workflow after worker crash.
        try:
            await _call_stop_workflow(job.uid)
        except Exception:
            pass
    finally:
        _finalize(job)


def _parse_items(
    items: List[Dict[str, Any]],
) -> tuple[
    Optional[List[BatchItem]],
    Optional[List[Optional[Dict[str, Any]]]],
    Optional[Dict[str, Any]],
]:
    batch_items: List[BatchItem] = []
    payloads: List[Optional[Dict[str, Any]]] = []
    for raw in items:
        if not isinstance(raw, dict):
            return None, None, {"success": False, "error": "Invalid batch item", "code": 400}
        path = str(raw.get("path") or "").strip()
        zarr_path = str(raw.get("zarr_path") or raw.get("zarrPath") or "").strip()
        payload = raw.get("payload")
        if not path:
            return None, None, {"success": False, "error": "Each item requires path", "code": 400}
        if not zarr_path:
            zarr_path = path if path.lower().endswith(".zarr") else f"{path}.zarr"
        if payload is not None and not isinstance(payload, dict):
            return None, None, {"success": False, "error": f"Invalid payload for {path}", "code": 400}
        batch_items.append(BatchItem(path=path, zarr_path=zarr_path))
        payloads.append(payload if isinstance(payload, dict) else None)
    if not any(p is not None for p in payloads):
        return None, None, {"success": False, "error": "No runnable payloads in batch", "code": 400}
    return batch_items, payloads, None


async def start_batch(
    uid: str,
    items: List[Dict[str, Any]],
    stop_on_first_error: bool = True,
    auth_header: Optional[str] = None,
    source: str = "workflow",
) -> Dict[str, Any]:
    """
    Create and start a batch job.

    Returns:
      {"success": True, "batch": snapshot} or {"success": False, "error": ..., "code": ...}
    """
    if not uid:
        return {"success": False, "error": "User ID is required", "code": 400}
    if not items:
        return {"success": False, "error": "No items provided for batch", "code": 400}

    source_norm = (source or "workflow").strip() or "workflow"
    if source_norm not in ("workflow", "pre_run"):
        return {"success": False, "error": "Invalid batch source", "code": 400}

    async with _uid_lock(uid):
        if has_active_batch(uid):
            return {
                "success": False,
                "error": "Batch processing already in progress",
                "code": 409,
            }

        batch_items, payloads, err = _parse_items(items)
        if err:
            return err

        job = BatchJob(
            id=f"batch-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}",
            uid=uid,
            items=batch_items or [],
            payloads=payloads or [],
            stop_on_first_error=bool(stop_on_first_error),
            source=source_norm,
            auth_header=auth_header,
        )
        _active_by_uid[uid] = job
        job.worker_task = asyncio.create_task(_run_batch(job))
        logger.info(
            "[batch] started %s uid=%s source=%s items=%s",
            job.id,
            uid,
            source_norm,
            len(job.items),
        )
        notify_batch(uid)
        return {"success": True, "batch": batch_job_snapshot(job)}


async def append_batch(
    uid: str,
    items: List[Dict[str, Any]],
    source: Optional[str] = None,
) -> Dict[str, Any]:
    """Append items to the user's active batch (same source)."""
    if not uid:
        return {"success": False, "error": "User ID is required", "code": 400}
    if not items:
        return {"success": False, "error": "No items provided", "code": 400}

    async with _uid_lock(uid):
        job = get_active_batch(uid)
        if not job:
            return {"success": False, "error": "No active batch to append to", "code": 409}
        if job.abort_requested:
            return {"success": False, "error": "Batch is stopping", "code": 409}
        if source and source != job.source:
            return {
                "success": False,
                "error": f"Active batch source is '{job.source}', cannot append '{source}'",
                "code": 409,
            }

        batch_items, payloads, err = _parse_items(items)
        if err:
            return err

        existing_paths = {it.path for it in job.items if it.status in ("queued", "running")}
        added = 0
        for item, payload in zip(batch_items or [], payloads or []):
            if item.path in existing_paths:
                continue
            job.items.append(item)
            job.payloads.append(payload)
            existing_paths.add(item.path)
            added += 1

        if added == 0:
            return {"success": True, "batch": batch_job_snapshot(job), "added": 0}

        logger.info("[batch] append %s uid=%s added=%s total=%s", job.id, uid, added, len(job.items))
        notify_batch(uid)
        return {"success": True, "batch": batch_job_snapshot(job), "added": added}


async def stop_batch(uid: str) -> Dict[str, Any]:
    job = get_active_batch(uid)
    if not job:
        return {"success": True, "message": "No active batch", "batch": None}

    job.abort_requested = True
    # Cancel the in-flight execution here (single place). The worker only
    # settles item statuses after wait returns — it must not stop again.
    # Abort is accepted as soon as abort_requested is set; in-flight cancel
    # outcome is informational only (do not 500 the batch stop).
    stop_result: Dict[str, Any] = {"success": True}
    try:
        stop_result = await _call_stop_workflow(uid) or {"success": True}
        err = str(stop_result.get("error") or "")
        # Abort already requested — no live execution is success, not failure.
        if stop_result.get("success") is False and "no running workflow" in err.lower():
            stop_result = {
                "success": True,
                "message": "Batch abort requested; no in-flight workflow to cancel",
            }
        elif stop_result.get("success") is False:
            logger.warning(
                "[batch] stop_workflow during stop_batch returned failure (abort still accepted): %s",
                stop_result.get("error") or stop_result,
            )
    except Exception as exc:
        logger.warning("[batch] stop_workflow during stop_batch failed (abort still accepted): %s", exc)
        stop_result = {"success": False, "error": str(exc)}

    notify_batch(uid)
    warning = None
    if stop_result.get("success") is False:
        warning = stop_result.get("error") or "In-flight cancel did not finish"
    return {
        "success": True,
        "message": "Batch stop requested",
        "batch": batch_job_snapshot(job),
        "stop_result": stop_result,
        "warning": warning,
    }
