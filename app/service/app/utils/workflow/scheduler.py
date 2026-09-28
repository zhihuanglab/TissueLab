"""
Task Scheduler Module

This module implements a model-based task scheduling system that allows
workflow tasks to execute concurrently while respecting dependencies.

Key Features:
- Tasks from different workflows can run simultaneously if using different models
- Dependencies within workflows are strictly respected (topological order)
- One task per model at a time (prevents GPU/resource conflicts)
- Backward compatible with existing UI and API endpoints
"""



import asyncio
import json
import logging
import os
import time
from typing import Dict, List, Optional, Set

import aiohttp

from app.config.zarr_compat import as_zarr_path
from app.services.workflow.events import notify_batch_progress, notify_execution_update
from app.services.workflow.ui_state import user_workflow_status
from app.services.workflow.runtime import (
    Task,
    WorkflowExecution,
    model_current_task,
    model_locks,
    model_runner_tasks,
    purge_finished_executions,
    release_user_active_execution,
    script_generation_tasks,
    user_active_executions,
    workflow_executions,
)
from app.services.workflow.status import WorkflowStatus, is_cancel_owned_status

# Re-export runtime symbols for existing `from ...scheduler import workflow_executions` callers.
_release_user_active_execution = release_user_active_execution

logger = logging.getLogger(__name__)


def _execution_owns_user_ui(uid: str, execution_id: str) -> bool:
    """True when writes to user_workflow_status[uid] still belong to this execution."""
    if user_active_executions.get(uid) == execution_id:
        return True
    snap = user_workflow_status.get(uid) or {}
    return snap.get("execution_id") == execution_id


def _is_stop_owned(execution: Optional["WorkflowExecution"], task: Optional["Task"] = None) -> bool:
    """True when Stop owns the execution and/or this task is already cancelled."""
    if task is not None and task.status == "cancelled":
        return True
    if execution is None:
        return False
    return is_cancel_owned_status(execution.status)


async def _derive_patch_masks(zarr_path: Optional[str]) -> None:
    """Best-effort, off the loop; a no-op unless Patch-Classification changed."""
    if not zarr_path:
        return
    try:
        from app.utils import resolve_path
        from app.services.patch_masks import ensure_patch_masks
        resolved = as_zarr_path(resolve_path(zarr_path))
        if not resolved or not os.path.exists(resolved):
            return
        result = await asyncio.to_thread(ensure_patch_masks, resolved)
        if result.get("status") == "written":
            logger.info(f"[patch_masks] after task: {result}")
    except Exception as exc:
        logger.warning(f"[patch_masks] derivation after task skipped: {exc}")


class TaskScheduler:
    """
    Central scheduler that dispatches tasks to available models.

    The scheduler continuously:
    1. Finds tasks that are ready to run (dependencies satisfied)
    2. Dispatches tasks to available models
    3. Checks for workflow completions

    This enables concurrent execution of tasks from different workflows
    while respecting intra-workflow dependencies.
    """

    #: How often the loop reclaims finished executions. Not every pass: the
    #: loop runs ten times a second and a sweep only has to keep the dict from
    #: growing without bound.
    PURGE_INTERVAL_SEC = 30.0

    def __init__(self):
        self.running = False
        self.scheduler_task = None
        self._last_purge_monotonic = 0.0

    async def start(self):
        """Start the scheduler background task"""
        if not self.running:
            self.running = True
            self.scheduler_task = asyncio.create_task(self._scheduler_loop())

    async def stop(self):
        """Stop the scheduler"""
        self.running = False
        if self.scheduler_task:
            self.scheduler_task.cancel()
            try:
                await self.scheduler_task
            except asyncio.CancelledError:
                pass

    async def _scheduler_loop(self):
        """
        Main scheduler loop - runs continuously.

        This loop repeatedly:
        1. Finds all tasks ready to run
        2. Tries to dispatch each ready task to its model
        3. Checks for completed workflows
        """
        while self.running:
            try:
                # 1. Find all tasks that are ready to run
                ready_tasks = self._find_ready_tasks()

                # 2. For each ready task, try to dispatch to its model
                for task in ready_tasks:
                    await self._try_dispatch_task(task)

                # 3. Check for completed workflows
                await self._check_workflow_completions()

                # 4. Reclaim finished executions so the two scans above stay
                #    proportional to what is active, not to everything this
                #    process has ever run.
                self._purge_finished_if_due()

                # 5. Sleep briefly to avoid tight loop
                await asyncio.sleep(0.1)

            except asyncio.CancelledError:
                logger.info("Scheduler loop cancelled")
                break
            except Exception as e:
                logger.error(f"Scheduler loop error: {e}", exc_info=True)
                await asyncio.sleep(1)

    def _purge_finished_if_due(self) -> int:
        """Run the terminal-execution sweep at most once per PURGE_INTERVAL_SEC."""
        now = time.monotonic()
        if now - self._last_purge_monotonic < self.PURGE_INTERVAL_SEC:
            return 0
        self._last_purge_monotonic = now
        try:
            purged = purge_finished_executions()
        except Exception as e:
            logger.warning("Finished-execution purge failed: %s", e, exc_info=True)
            return 0
        if purged:
            logger.info("Reclaimed %d finished workflow execution(s)", purged)
        return purged

    def _find_ready_tasks(self) -> List[Task]:
        """
        Find all tasks across all workflows that are ready to run.

        A task is ready if:
        1. Its status is 'pending'
        2. All its dependencies are completed
        3. No dependencies have failed
        4. Its model is not currently busy

        Returns:
            List of Task objects that are ready to execute
        """
        ready_tasks = []

        for execution in workflow_executions.values():
            # Skip workflows that aren't active
            if execution.status not in ['running', 'queued']:
                continue

            for task in execution.tasks.values():
                # Skip if already running, completed, failed, or cancelled
                # Include 'ready' tasks that weren't dispatched in previous loop
                if task.status not in ['pending', 'ready']:
                    continue

                # Check if all dependencies are completed
                deps_satisfied = all(
                    dep_node in execution.completed_tasks
                    for dep_node in task.dependencies
                )

                if not deps_satisfied:
                    continue

                # Check if any dependency failed
                deps_failed = any(
                    dep_node in execution.failed_tasks
                    for dep_node in task.dependencies
                )

                if deps_failed:
                    # Mark task as cancelled since dependency failed
                    task.status = 'cancelled'
                    task.error = "Dependency task failed"
                    logger.info(f"Task {task.task_id} cancelled - dependency failed")
                    continue

                # Check if model is available (including claimed / in-flight runners)
                model_name = task.node_name  # node name IS the model identifier
                runner_entry = model_runner_tasks.get(model_name)
                if runner_entry is not None and not runner_entry[1].done():
                    continue
                if model_current_task.get(model_name) is not None:
                    # Model is busy
                    continue

                # Task is ready!
                task.status = 'ready'
                ready_tasks.append(task)

        # Sort by creation time (FIFO within ready tasks)
        ready_tasks.sort(key=lambda t: t.created_at)
        return ready_tasks

    async def _try_dispatch_task(self, task: Task):
        """
        Try to dispatch a task to its model.
        Acquires model lock and starts task execution.

        Args:
            task: Task object to dispatch
        """
        model_name = task.node_name

        # Drop dispatches that cancel already settled (or is settling).
        execution = workflow_executions.get(task.execution_id)
        if execution is None or _is_stop_owned(execution, task):
            return

        # One in-flight runner per model. Claim model_current_task BEFORE
        # create_task so later dispatches in this tick cannot overwrite
        # model_runner_tasks or sneak a second runner past lock.locked().
        runner_entry = model_runner_tasks.get(model_name)
        if runner_entry is not None and not runner_entry[1].done():
            return
        if model_current_task.get(model_name) is not None:
            return

        if model_name not in model_locks:
            model_locks[model_name] = asyncio.Lock()
        lock = model_locks[model_name]

        model_current_task[model_name] = task.task_id
        runner = asyncio.create_task(self._execute_task(task, lock))
        model_runner_tasks[model_name] = (task.task_id, runner)

        def _clear_runner(done: asyncio.Task, name: str = model_name, tid: str = task.task_id) -> None:
            entry = model_runner_tasks.get(name)
            if entry and entry[0] == tid and entry[1] is done:
                model_runner_tasks.pop(name, None)

        runner.add_done_callback(_clear_runner)

    async def _monitor_task_progress(self, node_name: str, uid: str, execution_id: str):
        """
        Monitor task progress by subscribing to the node's /progress SSE endpoint.

        Args:
            node_name: Name of the node to monitor
            uid: User ID for updating user-specific progress
            execution_id: Owning execution — ignore writes after a newer run takes over
        """
        max_connect_failures = 10
        retry_delay = 3
        # After a successful stream drops mid-run (proxy idle kill while integer
        # progress is flat), reconnect instead of freezing the UI at the last %.
        reconnect_delay = 1.0
        connect_failures = 0

        while True:
            try:

                if not _execution_owns_user_ui(uid, execution_id):
                    return

                nodes = list_node_ports(skip_health_checks=True)
                if not nodes.get("success") or not nodes.get("nodes"):
                    connect_failures += 1
                    logger.warning(
                        f"[_monitor_task_progress] Could not get nodes list for {node_name} "
                        f"(connect failure {connect_failures}/{max_connect_failures})"
                    )
                    if connect_failures >= max_connect_failures:
                        return
                    await asyncio.sleep(retry_delay)
                    continue

                all_nodes = nodes["nodes"]
                if node_name not in all_nodes:
                    connect_failures += 1
                    logger.warning(
                        f"[_monitor_task_progress] Node {node_name} not found in nodes list "
                        f"(connect failure {connect_failures}/{max_connect_failures})"
                    )
                    if connect_failures >= max_connect_failures:
                        return
                    await asyncio.sleep(retry_delay)
                    continue

                port = all_nodes[node_name].get("port")
                if not isinstance(port, int):
                    connect_failures += 1
                    logger.warning(
                        f"[_monitor_task_progress] No valid port for {node_name} "
                        f"(connect failure {connect_failures}/{max_connect_failures})"
                    )
                    if connect_failures >= max_connect_failures:
                        return
                    await asyncio.sleep(retry_delay)
                    continue

                is_remote = all_nodes[node_name].get("is_remote")
                remote_host = all_nodes[node_name].get("remote_host")
                if is_remote is True and remote_host:
                    url = f"http://{remote_host}:{port}/progress"
                else:
                    url = f"http://127.0.0.1:{port}/progress"

                timeout = aiohttp.ClientTimeout(total=None, sock_connect=5, sock_read=None)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.get(url, headers={"Accept": "text/event-stream"}) as resp:
                        if resp.status != 200:
                            connect_failures += 1
                            logger.warning(
                                f"[_monitor_task_progress] Progress endpoint returned status {resp.status} "
                                f"(connect failure {connect_failures}/{max_connect_failures})"
                            )
                            if connect_failures >= max_connect_failures:
                                return
                            await asyncio.sleep(retry_delay)
                            continue

                        connect_failures = 0
                        # True once this stream delivered its terminal 100. The
                        # TaskNode closes the stream after that; reconnecting would
                        # hit clear_stale_if_idle() and push a fresh "0" over the
                        # finished bar until /execute returns.
                        saw_terminal = False
                        async for raw in resp.content:
                            try:
                                if not raw:
                                    continue
                                if not _execution_owns_user_ui(uid, execution_id):
                                    return
                                line = raw.decode(errors='ignore').strip()
                                if not line.startswith('data:'):
                                    continue
                                payload = line.split('data:', 1)[1].strip()

                                try:
                                    value = int(payload)
                                except Exception:
                                    try:
                                        obj = json.loads(payload)
                                        if isinstance(obj, dict) and 'data' in obj:
                                            value = int(str(obj['data']).strip())
                                        else:
                                            continue
                                    except Exception:
                                        continue

                                if value == -1:
                                    saw_terminal = False
                                    if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                                        if 'node_progress' not in user_workflow_status[uid]:
                                            user_workflow_status[uid]['node_progress'] = {}
                                        user_workflow_status[uid]['node_progress'][node_name] = 0
                                        notify_batch_progress(uid)
                                elif 0 <= value <= 100:
                                    saw_terminal = value >= 100
                                    if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                                        if 'node_progress' not in user_workflow_status[uid]:
                                            user_workflow_status[uid]['node_progress'] = {}
                                        user_workflow_status[uid]['node_progress'][node_name] = value
                                        notify_batch_progress(uid)
                            except Exception as e:
                                logger.debug(f"[_monitor_task_progress] Error parsing progress line: {e}")
                                continue

                        if saw_terminal:
                            # Finished on the TaskNode side; _execute_task publishes
                            # 100 / status 2 as soon as /execute returns.
                            logger.debug(
                                f"[_monitor_task_progress] {node_name} stream closed after 100%; not reconnecting"
                            )
                            return
                        still_running = (
                            uid in user_workflow_status
                            and _execution_owns_user_ui(uid, execution_id)
                            and user_workflow_status[uid].get('node_status', {}).get(node_name) == 1
                        )
                        if still_running:
                            logger.warning(
                                f"[_monitor_task_progress] Progress stream closed while {node_name} still running; reconnecting"
                            )
                            await asyncio.sleep(reconnect_delay)
                            continue
                        return

            except asyncio.CancelledError:
                logger.info(f"[_monitor_task_progress] Progress monitoring cancelled for {node_name}")
                raise
            except Exception as e:
                connect_failures += 1
                logger.warning(
                    f"[_monitor_task_progress] Failed to monitor progress for {node_name}: {e} "
                    f"(connect failure {connect_failures}/{max_connect_failures})"
                )
                if connect_failures >= max_connect_failures:
                    logger.error(
                        f"[_monitor_task_progress] Exhausted all {max_connect_failures} connect retries for {node_name}"
                    )
                    return
                await asyncio.sleep(retry_delay)

    async def _execute_task(self, task: Task, model_lock: asyncio.Lock):
        """
        Execute a single task (node execution).

        This wraps the existing 3-phase HTTP protocol:
        1. /init
        2. /read
        3. /execute

        Args:
            task: Task to execute
            model_lock: Lock for the model to ensure exclusive access
        """
        async with model_lock:
            try:
                execution_id = task.execution_id
                execution = workflow_executions.get(execution_id)

                if not execution:
                    logger.error(f"Execution not found for task {task.task_id}")
                    return

                # Refuse to start once cancel owns the execution. Re-check status
                # immediately before promoting to running so cancel_non_running_tasks
                # cannot be overwritten by a stale pending/ready dispatch.
                if _is_stop_owned(execution, task):
                    task.status = "cancelled"
                    task.completed_at = time.time()
                    task.error = "Workflow was cancelled before this task started"
                    logger.info(f"Task {task.task_id} skipped because workflow is cancelling/cancelled")
                    return

                if task.status not in ("pending", "ready"):
                    logger.info(
                        f"Task {task.task_id} not started; unexpected status={task.status}"
                    )
                    return

                # Mark task as running (model_current_task may already be claimed at dispatch)
                task.status = "running"
                task.started_at = time.time()
                model_current_task[task.node_name] = task.task_id

                # Update user_workflow_status for UI
                uid = execution.uid
                if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                    # Update workflow status to 'running' once any task starts executing
                    # Never clobber cancelling/cancelled.
                    if user_workflow_status[uid]["status"] == "queued":
                        user_workflow_status[uid]["status"] = "running"
                    user_workflow_status[uid]["node_status"][task.node_name] = 1  # Running
                
                # Also update execution.status to keep it in sync
                if execution.status == "queued":
                    execution.status = "running"

                # Start progress monitoring in background
                progress_task = asyncio.create_task(
                    self._monitor_task_progress(task.node_name, uid, execution_id)
                )

                result = None
                try:
                    # Write this node's userData to zarr right before execution so we avoid overwriting another node's params (e.g. MuskNode shared by MuskEmbedding and MuskClassification)
                    await asyncio.to_thread(
                        write_node_userdata,
                        task.zarr_path,
                        task.node_name,
                        task.node_inputs or {},
                    )
                    # Stop may have landed during userdata.
                    if _is_stop_owned(execution, task):
                        task.status = 'cancelled'
                        task.completed_at = time.time()
                        task.error = "Workflow was cancelled before /execute"
                        if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                            user_workflow_status[uid]['node_status'][task.node_name] = 0
                        logger.info(
                            f"Task {task.task_id} skipped /execute after cancel during userdata/prep"
                        )
                        return
                    # aiohttp path: cancelling this Task closes the /execute client
                    # connection (sync requests+to_thread could not).
                    result = await manager.execute_single_node(
                        task.node_name,
                        task.zarr_path,
                        task.dependencies,
                        task.node_inputs,
                    )
                finally:
                    # On success, publish 100%/status=2 BEFORE cancelling the TaskNode
                    # /progress watcher so get_status can push the final tick.
                    if (
                        result is not None
                        and uid in user_workflow_status
                        and _execution_owns_user_ui(uid, execution_id)
                        and not _is_stop_owned(execution, task)
                        and not (isinstance(result, dict) and result.get("status") in ("cancelled", "error"))
                    ):
                        user_workflow_status[uid]['node_status'][task.node_name] = 2
                        user_workflow_status[uid]['node_progress'][task.node_name] = 100
                    progress_task.cancel()
                    try:
                        await progress_task
                    except asyncio.CancelledError:
                        pass

                if _is_stop_owned(execution, task):
                    task.status = 'cancelled'
                    task.completed_at = time.time()
                    task.result = result
                    task.error = "Workflow was cancelled"
                    if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                        user_workflow_status[uid]['node_status'][task.node_name] = 0
                    logger.info(f"Task {task.task_id} returned after cancellation; preserving cancelled status")
                    return

                if isinstance(result, dict) and result.get("status") == "cancelled":
                    task.status = 'cancelled'
                    task.completed_at = time.time()
                    task.result = result
                    task.error = result.get("message", "Task was cancelled")
                    if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                        user_workflow_status[uid]['node_status'][task.node_name] = 0
                        user_workflow_status[uid]['node_progress'][task.node_name] = 0
                    logger.info(f"Task {task.task_id} cancelled cooperatively")
                    return

                # A node that caught its own exception and answered
                # {"status": "error", "message": ...} (HTTP 200) failed just as
                # surely as one that raised; treat it like the except-branch below
                # so the UI gets node_status -1 and the message, not a green 100%.
                if isinstance(result, dict) and result.get("status") == "error":
                    err_text = str(result.get("message") or f"{task.node_name} reported an error")
                    logger.error(f"Task {task.task_id} reported error: {err_text}")
                    task.status = 'failed'
                    task.error = err_text
                    task.completed_at = time.time()
                    task.result = result
                    if execution is not None:
                        execution.failed_tasks.add(task.node_name)
                    if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                        user_workflow_status[uid]['node_status'][task.node_name] = -1  # Failed
                        user_workflow_status[uid]['error'] = err_text
                    return

                # Mark task as completed
                task.status = 'completed'
                task.completed_at = time.time()
                task.result = result

                # Update workflow tracking
                execution.completed_tasks.add(task.node_name)

                # Fold this run's patch classification into Tissue-Segmentation
                # masks now, while Patch-Classification still holds it: the
                # next classification node overwrites that group, and the
                # masks are how results of several classifiers coexist.
                await _derive_patch_masks(task.zarr_path)

            except asyncio.CancelledError:
                # force-finalize cancels orphan runners; CancelledError is BaseException.
                if execution is not None:
                    uid = execution.uid
                    if _is_stop_owned(execution, task):
                        task.status = 'cancelled'
                        task.completed_at = time.time()
                        task.error = task.error or "Workflow was cancelled"
                        if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                            user_workflow_status[uid]['node_status'][task.node_name] = 0
                            user_workflow_status[uid]['node_progress'][task.node_name] = 0
                        logger.info(f"Task {task.task_id} runner cancelled during force-finalize")
                raise

            except Exception as e:
                uid = execution.uid if execution is not None else task.uid
                if execution is not None and _is_stop_owned(execution, task):
                    logger.info(f"Task {task.task_id} stopped during cancellation: {e}")
                    task.status = 'cancelled'
                    task.error = str(e) or "Workflow was cancelled"
                    task.completed_at = time.time()
                    if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                        user_workflow_status[uid]['node_status'][task.node_name] = 0
                        user_workflow_status[uid]['node_progress'][task.node_name] = 0
                else:
                    logger.error(f"Task {task.task_id} failed: {e}", exc_info=True)
                    task.status = 'failed'
                    task.error = str(e)
                    task.completed_at = time.time()

                    # Update workflow tracking
                    if execution is not None:
                        execution.failed_tasks.add(task.node_name)

                    # Update user_workflow_status for UI
                    if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                        user_workflow_status[uid]['node_status'][task.node_name] = -1  # Failed
                        user_workflow_status[uid]['error'] = str(e)

            finally:
                # Always release dispatch claim / runner slot (including early returns above).
                if model_current_task.get(task.node_name) == task.task_id:
                    model_current_task[task.node_name] = None
                entry = model_runner_tasks.get(task.node_name)
                if entry and entry[0] == task.task_id:
                    model_runner_tasks.pop(task.node_name, None)
                # Cancel state machine: task settled → maybe cancelling → cancelled.
                if execution is not None and is_cancel_owned_status(execution.status):
                    try:
                        try_finalize_cancelling_execution(execution_id)
                    except Exception as finalize_err:
                        logger.warning(
                            f"[CANCEL_WORKFLOW] finalize after task settle failed: {finalize_err}"
                        )
                        notify_execution_update(execution_id)

    async def _check_workflow_completions(self):
        """
        Check if any workflows have completed and update their status.

        A workflow is complete when all its tasks are done (completed, failed, or cancelled).
        """
        for execution_id, execution in list(workflow_executions.items()):
            # Cancelling: settle path (task finally / script done) owns finalize + notify.
            if execution.status == "cancelling":
                continue

            if execution.status not in ['running', 'queued']:
                continue

            # Provisional start reservation: empty tasks and no script_prompt yet.
            # all([]) is True, so without this guard the mid-start placeholder
            # would be marked completed (and Stop could see a false terminal).
            if not execution.tasks and not execution.script_prompt:
                continue

            # Check if all tasks are done
            all_tasks_done = all(
                task.status in ['completed', 'failed', 'cancelled']
                for task in execution.tasks.values()
            )

            if not all_tasks_done:
                continue

            # Workflow is done

            if execution.failed_tasks:
                execution.status = 'error'
                _release_user_active_execution(execution.uid, execution_id)
                if execution.uid in user_workflow_status and _execution_owns_user_ui(
                    execution.uid, execution_id
                ):
                    user_workflow_status[execution.uid]['status'] = 'error'
                notify_execution_update(execution_id)
            else:
                # Handle script generation if needed BEFORE marking as completed.
                # Spawn in background so Stop can cancel it and the scheduler loop
                # is not blocked on the Ctrl script stream.
                if execution.script_prompt:
                    if not execution.script_task_started:
                        execution.script_task_started = True
                        runner = asyncio.create_task(self._handle_script_generation(execution))
                        script_generation_tasks[execution_id] = runner

                        def _clear_script(
                            done: asyncio.Task, eid: str = execution_id
                        ) -> None:
                            if script_generation_tasks.get(eid) is done:
                                script_generation_tasks.pop(eid, None)
                            try:
                                try_finalize_cancelling_execution(eid)
                            except Exception:
                                pass
                            notify_execution_update(eid)

                        runner.add_done_callback(_clear_script)
                        continue
                    runner = script_generation_tasks.get(execution_id)
                    if runner is not None and not runner.done():
                        continue
                    # Script Task settled but left status non-terminal — avoid spinning.
                    if execution.status in ("running", "queued"):
                        execution.status = "error"
                        _release_user_active_execution(execution.uid, execution_id)
                        if execution.uid in user_workflow_status and _execution_owns_user_ui(
                            execution.uid, execution_id
                        ):
                            user_workflow_status[execution.uid]["status"] = "error"
                        notify_execution_update(execution_id)
                    else:
                        continue
                else:
                    execution.status = 'completed'
                    _release_user_active_execution(execution.uid, execution_id)
                    if execution.uid in user_workflow_status and _execution_owns_user_ui(
                        execution.uid, execution_id
                    ):
                        user_workflow_status[execution.uid]['status'] = 'completed'
                    notify_execution_update(execution_id)

            # Recalculate queue positions for remaining workflows after any completion
            recalculate_all_queue_positions()

    async def _handle_script_generation(self, execution: WorkflowExecution):
        """
        Handle GPT-4o Agent script generation after workflow completes.

        Runs as a background Task so Stop can cancel it without blocking the
        scheduler loop. Registers zarr + queue recalc here (completion sweep
        returns early while the script Task is in flight).
        """

        uid = execution.uid
        execution_id = execution.execution_id

        def _clear_script_ui() -> None:
            if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                user_workflow_status[uid]['node_status']['GPT-4o Agent'] = 0
                user_workflow_status[uid]['is_generating'] = False
                if is_cancel_owned_status(execution.status):
                    user_workflow_status[uid]['status'] = (
                        WorkflowStatus.CANCELLED
                        if execution.status == WorkflowStatus.CANCELLED
                        else WorkflowStatus.CANCELLING
                    )

        try:
            if is_cancel_owned_status(execution.status):
                logger.info(
                    f"Skip script generation for {execution_id}; execution already {execution.status}"
                )
                # Finalize happens in script done_callback once this Task leaves running.
                notify_execution_update(execution_id)
                return

            if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                user_workflow_status[uid]['node_status']['GPT-4o Agent'] = 1  # Running
                user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = 0

            # Define progress animation function for coding agent
            async def _animate_scripts_progress(duration_seconds: float = 30.0):
                """Generate pseudo progress updates for CodingAgent while awaiting completion."""
                start = 0
                target = 99  # Cap at 99 until actually complete
                if duration_seconds <= 0:
                    duration_seconds = 30.0
                steps = max(1, target - start)
                interval = duration_seconds / steps
                progress_value = start
                try:
                    while progress_value < target:
                        await asyncio.sleep(interval)
                        if is_cancel_owned_status(execution.status):
                            break
                        if not _execution_owns_user_ui(uid, execution_id):
                            break
                        if uid not in user_workflow_status:
                            break
                        scripts_status = user_workflow_status[uid].get('node_status', {}).get('GPT-4o Agent')
                        if scripts_status == 2:  # Already completed
                            break
                        progress_value = min(target, progress_value + 1)
                        if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                            user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = progress_value
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.debug(f"CodingAgent progress animation interrupted: {exc}")

            # Start progress animation in background
            script_animation_task = asyncio.create_task(_animate_scripts_progress())

            try:
                # Generate script
                result = await _generate_script_output(
                    execution.script_prompt,
                    execution.zarr_path,
                    auth_header=execution.auth_header,
                    uid=uid,
                )
            finally:
                # Cancel progress animation when script generation completes
                script_animation_task.cancel()
                try:
                    await script_animation_task
                except asyncio.CancelledError:
                    pass

            # Stop won the race — never promote cancelled → completed.
            if is_cancel_owned_status(execution.status):
                logger.info(
                    f"Script generation finished after cancel for {execution_id}; keeping {execution.status}"
                )
                _clear_script_ui()
                # Finalize in done_callback (this runner is still "running" until return).
                notify_execution_update(execution_id)
                return

            # Update execution status
            execution.status = 'completed'
            _release_user_active_execution(uid, execution_id)
            notify_execution_update(execution.execution_id)

            # Update status
            if uid in user_workflow_status and _execution_owns_user_ui(uid, execution_id):
                user_workflow_status[uid]['node_status']['GPT-4o Agent'] = 2  # Completed
                user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = 100
                user_workflow_status[uid]['result'] = result
                user_workflow_status[uid]['status'] = 'completed'

                # Store answer in user-specific state for frontend to display
                if result is not None:
                    if isinstance(result, dict) and "generated_script" in result:
                        user_workflow_status[uid]['cur_answer'] = result["generated_script"]
                    elif isinstance(result, dict) and "error" in result:
                        error_msg = result.get("error", "Unknown error")
                        user_workflow_status[uid]['cur_answer'] = f"[ERROR] Script generation failed: {error_msg}\n\nPlease check the backend logs for more details."
                    else:
                        user_workflow_status[uid]['cur_answer'] = json.dumps(result) if isinstance(result, dict) else str(result)
                else:
                    user_workflow_status[uid]['cur_answer'] = ""
                user_workflow_status[uid]['is_generating'] = False

        except asyncio.CancelledError:
            logger.info(f"Script generation cancelled for execution {execution_id}")
            _clear_script_ui()
            # Finalize in done_callback after this Task is marked done.
            notify_execution_update(execution_id)
            raise
        except Exception as e:
            logger.error(f"Script generation failed for execution {execution.execution_id}: {e}", exc_info=True)
            if is_cancel_owned_status(execution.status):
                notify_execution_update(execution.execution_id)
                return
            execution.status = 'error'
            _release_user_active_execution(uid, execution.execution_id)
            notify_execution_update(execution.execution_id)
            if uid in user_workflow_status and _execution_owns_user_ui(uid, execution.execution_id):
                user_workflow_status[uid]['node_status']['GPT-4o Agent'] = -1  # Failed
                user_workflow_status[uid]['error'] = str(e)
                user_workflow_status[uid]['status'] = 'error'
                user_workflow_status[uid]['is_generating'] = False
                user_workflow_status[uid]['cur_answer'] = f"Error: {str(e)}"
        finally:
            # Completion sweep skips while script Task runs; settle bookkeeping here.
            try:
                recalculate_all_queue_positions()
            except Exception as e:
                logger.warning(f"Failed to recalc queue after script: {e}")
            notify_execution_update(execution_id)


# Global scheduler instance
task_scheduler = TaskScheduler()

# Import after task_scheduler exists so `start` can import task_scheduler while
# tasks is still loading (tasks → start → scheduler) without hitting a partial
# module. cancel/queue import runtime (not scheduler), so these are safe here.
from app.services.tasks import (  # noqa: E402
    _generate_script_output,
    list_node_ports,
    manager,
    write_node_userdata,
)
from app.services.workflow.cancel import try_finalize_cancelling_execution  # noqa: E402
from app.services.workflow.queue import recalculate_all_queue_positions  # noqa: E402

