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
import time
import logging
import json
import aiohttp
from typing import Dict, List, Set, Optional
from dataclasses import dataclass, field
from collections import defaultdict

logger = logging.getLogger(__name__)


@dataclass
class Task:
    """
    Represents a single node execution within a workflow.
    """
    task_id: str  # Unique identifier: f"{execution_id}_{node_name}"
    workflow_id: int  # Workflow definition ID
    node_name: str  # Node name (also used as model identifier)
    uid: str  # User ID
    zarr_path: str  # Path to zarr file
    node_inputs: dict  # Input parameters for this node
    dependencies: List[str]  # List of node names this task depends on
    status: str = 'pending'  # 'pending', 'ready', 'running', 'completed', 'failed', 'cancelled'
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    result: Optional[dict] = None
    error: Optional[str] = None


@dataclass
class WorkflowExecution:
    """
    Tracks a single workflow execution instance.
    """
    execution_id: str  # Unique execution instance: f"{uid}_{workflow_id}_{timestamp}"
    workflow_id: int  # Workflow definition ID
    uid: str  # User ID
    zarr_path: str  # Path to zarr file
    auth_header: Optional[str]  # Authentication header
    tasks: Dict[str, Task]  # node_name -> Task
    task_dependency_graph: Dict[str, List[str]]  # node_name -> [dependent_node_names]
    completed_tasks: Set[str] = field(default_factory=set)  # Set of completed node names
    failed_tasks: Set[str] = field(default_factory=set)  # Set of failed node names
    status: str = 'queued'  # 'queued', 'running', 'completed', 'error', 'cancelled'
    script_prompt: Optional[str] = None  # GPT-4o Agent prompt (if any)
    created_at: float = field(default_factory=time.time)


# Global state tracking
workflow_executions: Dict[str, WorkflowExecution] = {}  # execution_id -> WorkflowExecution
user_active_executions: Dict[str, str] = {}  # uid -> execution_id
model_current_task: Dict[str, Optional[str]] = {}  # model_name -> task_id (currently running)
model_locks: Dict[str, asyncio.Lock] = {}  # model_name -> Lock


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

    def __init__(self):
        self.running = False
        self.scheduler_task = None

    async def start(self):
        """Start the scheduler background task"""
        if not self.running:
            self.running = True
            self.scheduler_task = asyncio.create_task(self._scheduler_loop())
            logger.info("TaskScheduler started")

    async def stop(self):
        """Stop the scheduler"""
        self.running = False
        if self.scheduler_task:
            self.scheduler_task.cancel()
            try:
                await self.scheduler_task
            except asyncio.CancelledError:
                pass
        logger.info("TaskScheduler stopped")

    async def _scheduler_loop(self):
        """
        Main scheduler loop - runs continuously.

        This loop repeatedly:
        1. Finds all tasks ready to run
        2. Tries to dispatch each ready task to its model
        3. Checks for completed workflows
        """
        logger.info("Scheduler loop started")

        while self.running:
            try:
                # 1. Find all tasks that are ready to run
                ready_tasks = self._find_ready_tasks()

                # 2. For each ready task, try to dispatch to its model
                for task in ready_tasks:
                    await self._try_dispatch_task(task)

                # 3. Check for completed workflows
                await self._check_workflow_completions()

                # 4. Sleep briefly to avoid tight loop
                await asyncio.sleep(0.1)

            except asyncio.CancelledError:
                logger.info("Scheduler loop cancelled")
                break
            except Exception as e:
                logger.error(f"Scheduler loop error: {e}", exc_info=True)
                await asyncio.sleep(1)

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

                # Check if model is available
                model_name = task.node_name  # node name IS the model identifier
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

        # Double-check model is available (race condition protection)
        if model_current_task.get(model_name) is not None:
            return

        # Acquire model lock
        if model_name not in model_locks:
            model_locks[model_name] = asyncio.Lock()

        lock = model_locks[model_name]

        if lock.locked():
            return

        # Start task execution in background
        asyncio.create_task(self._execute_task(task, lock))

    async def _monitor_task_progress(self, node_name: str, uid: str):
        """
        Monitor task progress by subscribing to the node's /progress SSE endpoint.

        Args:
            node_name: Name of the node to monitor
            uid: User ID for updating user-specific progress
        """
        max_retries = 10  # Retry up to 10 times (covers ~30 seconds of waiting)
        retry_delay = 3  # seconds between retries
        
        for attempt in range(max_retries):
            try:
                # Get node port (refresh on each attempt in case it changed)
                from app.services.tasks_service import list_node_ports, user_workflow_status

                nodes = list_node_ports(skip_health_checks=True)
                if not nodes.get("success") or not nodes.get("nodes"):
                    logger.warning(f"[_monitor_task_progress] Could not get nodes list for {node_name} (attempt {attempt + 1}/{max_retries})")
                    if attempt < max_retries - 1:
                        await asyncio.sleep(retry_delay)
                        continue
                    return

                all_nodes = nodes["nodes"]
                if node_name not in all_nodes:
                    logger.warning(f"[_monitor_task_progress] Node {node_name} not found in nodes list (attempt {attempt + 1}/{max_retries})")
                    if attempt < max_retries - 1:
                        await asyncio.sleep(retry_delay)
                        continue
                    return

                port = all_nodes[node_name].get("port")
                if not isinstance(port, int):
                    logger.warning(f"[_monitor_task_progress] No valid port for {node_name} (attempt {attempt + 1}/{max_retries})")
                    if attempt < max_retries - 1:
                        await asyncio.sleep(retry_delay)
                        continue
                    return

                # Decide remote vs local using is_remote.
                is_remote = all_nodes[node_name].get("is_remote")
                remote_host = all_nodes[node_name].get("remote_host")
                
                # Build URL based on node type
                if is_remote is True and remote_host:
                    url = f"http://{remote_host}:{port}/progress"
                else:
                    url = f"http://127.0.0.1:{port}/progress"
                logger.info(f"[_monitor_task_progress] Connecting to {url} for node {node_name} (attempt {attempt + 1}/{max_retries})")

                # Connect to progress endpoint
                timeout = aiohttp.ClientTimeout(total=None, sock_connect=5, sock_read=None)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.get(url, headers={"Accept": "text/event-stream"}) as resp:
                        if resp.status != 200:
                            logger.warning(f"[_monitor_task_progress] Progress endpoint returned status {resp.status} (attempt {attempt + 1}/{max_retries})")
                            if attempt < max_retries - 1:
                                await asyncio.sleep(retry_delay)
                                continue
                            return

                        logger.info(f"[_monitor_task_progress] Connected to progress endpoint for {node_name}")

                        async for raw in resp.content:
                            try:
                                if not raw:
                                    continue
                                line = raw.decode(errors='ignore').strip()
                                if not line.startswith('data:'):
                                    continue
                                payload = line.split('data:', 1)[1].strip()

                                # Parse progress value
                                try:
                                    value = int(payload)
                                except Exception:
                                    try:
                                        import json
                                        obj = json.loads(payload)
                                        if isinstance(obj, dict) and 'data' in obj:
                                            value = int(str(obj['data']).strip())
                                        else:
                                            continue
                                    except Exception:
                                        continue

                                # Update progress
                                if 0 <= value <= 100:
                                    if uid in user_workflow_status:
                                        if 'node_progress' not in user_workflow_status[uid]:
                                            user_workflow_status[uid]['node_progress'] = {}
                                        user_workflow_status[uid]['node_progress'][node_name] = value
                                        logger.debug(f"[_monitor_task_progress] Updated progress for {node_name}: {value}%")
                            except Exception as e:
                                logger.debug(f"[_monitor_task_progress] Error parsing progress line: {e}")
                                continue
                        
                        # If we get here, the connection was successful and we're done
                        return

            except asyncio.CancelledError:
                logger.info(f"[_monitor_task_progress] Progress monitoring cancelled for {node_name}")
                raise
            except Exception as e:
                logger.warning(f"[_monitor_task_progress] Failed to monitor progress for {node_name}: {e} (attempt {attempt + 1}/{max_retries})")
                if attempt < max_retries - 1:
                    await asyncio.sleep(retry_delay)
                    continue
        
        logger.error(f"[_monitor_task_progress] Exhausted all {max_retries} retries for {node_name}")

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
            # Derive execution_id directly from task_id to avoid timestamp precision issues
            execution_id = task.task_id.rsplit('_', 1)[0]
            execution = workflow_executions.get(execution_id)

            if not execution:
                logger.error(f"Execution not found for task {task.task_id}")
                return

            try:
                if execution.status in ['cancelling', 'cancelled'] or task.status == 'cancelled':
                    task.status = 'cancelled'
                    task.completed_at = time.time()
                    task.error = "Workflow was cancelled before this task started"
                    logger.info(f"Task {task.task_id} skipped because workflow is cancelling/cancelled")
                    return

                # Mark task as running
                task.status = 'running'
                task.started_at = time.time()
                model_current_task[task.node_name] = task.task_id

                # Update user_workflow_status for UI
                from app.services.tasks_service import user_workflow_status
                uid = execution.uid
                if uid in user_workflow_status:
                    # Update workflow status to 'running' once any task starts executing
                    if user_workflow_status[uid]['status'] == 'queued':
                        user_workflow_status[uid]['status'] = 'running'
                    user_workflow_status[uid]['node_status'][task.node_name] = 1  # Running
                
                # Also update execution.status to keep it in sync
                if execution.status == 'queued':
                    execution.status = 'running'

                logger.info(f"Executing task {task.task_id} (workflow {task.workflow_id}, user {task.uid}, node {task.node_name})")

                # Start progress monitoring in background
                progress_task = asyncio.create_task(
                    self._monitor_task_progress(task.node_name, uid)
                )

                try:
                    # Write this node's userData to zarr right before execution so we avoid overwriting another node's params (e.g. MuskNode shared by MuskEmbedding and MuskClassification)
                    from app.services.tasks_service import manager, write_node_userdata_to_zarr
                    await asyncio.to_thread(
                        write_node_userdata_to_zarr,
                        task.zarr_path,
                        task.node_name,
                        task.node_inputs or {},
                    )
                    # Execute the node using TaskNodeManager (node_inputs also passed in /read for redundancy)
                    result = await asyncio.to_thread(
                        manager.execute_single_node,
                        task.node_name,
                        task.zarr_path,
                        task.dependencies,
                        task.workflow_id,
                        task.node_inputs
                    )
                finally:
                    # Cancel progress monitoring when execution completes
                    progress_task.cancel()
                    try:
                        await progress_task
                    except asyncio.CancelledError:
                        pass

                if execution.status in ['cancelling', 'cancelled'] or task.status == 'cancelled':
                    task.status = 'cancelled'
                    task.completed_at = time.time()
                    task.result = result
                    task.error = "Workflow was cancelled"
                    if uid in user_workflow_status:
                        user_workflow_status[uid]['node_status'][task.node_name] = 0
                    logger.info(f"Task {task.task_id} returned after cancellation; preserving cancelled status")
                    return

                if isinstance(result, dict) and result.get("status") == "cancelled":
                    task.status = 'cancelled'
                    task.completed_at = time.time()
                    task.result = result
                    task.error = result.get("message", "Task was cancelled")
                    if uid in user_workflow_status:
                        user_workflow_status[uid]['node_status'][task.node_name] = 0
                        user_workflow_status[uid]['node_progress'][task.node_name] = 0
                    logger.info(f"Task {task.task_id} cancelled cooperatively")
                    return

                # Mark task as completed
                task.status = 'completed'
                task.completed_at = time.time()
                task.result = result

                # Update workflow tracking
                execution.completed_tasks.add(task.node_name)

                # Update user_workflow_status for UI
                if uid in user_workflow_status:
                    user_workflow_status[uid]['node_status'][task.node_name] = 2  # Completed
                    user_workflow_status[uid]['node_progress'][task.node_name] = 100

                logger.info(f"Task {task.task_id} completed successfully")

            except Exception as e:
                from app.services.tasks_service import user_workflow_status
                uid = execution.uid
                if execution.status in ['cancelling', 'cancelled'] or task.status == 'cancelled':
                    logger.info(f"Task {task.task_id} stopped during cancellation: {e}")
                    task.status = 'cancelled'
                    task.error = str(e) or "Workflow was cancelled"
                    task.completed_at = time.time()
                    if uid in user_workflow_status:
                        user_workflow_status[uid]['node_status'][task.node_name] = 0
                        user_workflow_status[uid]['node_progress'][task.node_name] = 0
                else:
                    logger.error(f"Task {task.task_id} failed: {e}", exc_info=True)
                    task.status = 'failed'
                    task.error = str(e)
                    task.completed_at = time.time()

                    # Update workflow tracking
                    execution.failed_tasks.add(task.node_name)

                    # Update user_workflow_status for UI
                    if uid in user_workflow_status:
                        user_workflow_status[uid]['node_status'][task.node_name] = -1  # Failed
                        user_workflow_status[uid]['error'] = str(e)

            finally:
                # Release model
                if model_current_task.get(task.node_name) == task.task_id:
                    model_current_task[task.node_name] = None

    async def _check_workflow_completions(self):
        """
        Check if any workflows have completed and update their status.

        A workflow is complete when all its tasks are done (completed, failed, or cancelled).
        """
        for execution_id, execution in list(workflow_executions.items()):
            if execution.status not in ['running', 'queued']:
                continue

            # Check if all tasks are done
            all_tasks_done = all(
                task.status in ['completed', 'failed', 'cancelled']
                for task in execution.tasks.values()
            )

            if not all_tasks_done:
                continue

            # Workflow is done
            from app.services.tasks_service import user_workflow_status, _recalculate_all_queue_positions
            
            if execution.failed_tasks:
                execution.status = 'error'
                if execution.uid in user_workflow_status:
                    user_workflow_status[execution.uid]['status'] = 'error'
                logger.info(f"Workflow execution {execution_id} completed with status {execution.status}")
            else:
                # Handle script generation if needed BEFORE marking as completed
                # This ensures SSE doesn't send 'completed' until script is ready
                if execution.script_prompt:
                    await self._handle_script_generation(execution)
                    # _handle_script_generation will set the final status
                else:
                    execution.status = 'completed'
                    if execution.uid in user_workflow_status:
                        user_workflow_status[execution.uid]['status'] = 'completed'
                    logger.info(f"Workflow execution {execution_id} completed with status {execution.status}")

            # Register any zarr outputs to metadata (regardless of success/failure)
            try:
                from app.utils import register_zarr_store
                import os
                zarr_path = execution.zarr_path
                effective_zarr = zarr_path if zarr_path.endswith('.zarr') else f"{zarr_path}.zarr"
                if execution.uid and effective_zarr and os.path.exists(effective_zarr):
                    register_zarr_store(execution.uid, effective_zarr)
                    logger.info(f"Registered zarr store for uid={execution.uid}: {effective_zarr}")
            except Exception as e:
                logger.warning(f"Failed to register zarr output: {e}")

            # Recalculate queue positions for remaining workflows after any completion
            _recalculate_all_queue_positions()

    async def _handle_script_generation(self, execution: WorkflowExecution):
        """
        Handle GPT-4o Agent script generation after workflow completes.

        Args:
            execution: WorkflowExecution that has completed
        """
        try:
            logger.info(f"Handling script generation for execution {execution.execution_id}")

            # Import the script generation function
            from app.services.tasks_service import _generate_script_output, user_workflow_status

            # Update node status for GPT-4o Agent
            uid = execution.uid
            if uid in user_workflow_status:
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
                        if uid not in user_workflow_status:
                            break
                        scripts_status = user_workflow_status[uid].get('node_status', {}).get('GPT-4o Agent')
                        if scripts_status == 2:  # Already completed
                            break
                        progress_value = min(target, progress_value + 1)
                        if uid in user_workflow_status:
                            user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = progress_value
                            logger.debug(f"[_handle_script_generation] GPT-4o Agent progress: {progress_value}%")
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

            # Update execution status
            execution.status = 'completed'
            
            # Update status
            if uid in user_workflow_status:
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

            logger.info(f"Script generation completed for execution {execution.execution_id}")

        except Exception as e:
            logger.error(f"Script generation failed for execution {execution.execution_id}: {e}", exc_info=True)
            execution.status = 'error'
            uid = execution.uid
            from app.services.tasks_service import user_workflow_status
            if uid in user_workflow_status:
                user_workflow_status[uid]['node_status']['GPT-4o Agent'] = -1  # Failed
                user_workflow_status[uid]['error'] = str(e)
                user_workflow_status[uid]['status'] = 'error'
                user_workflow_status[uid]['is_generating'] = False
                user_workflow_status[uid]['cur_answer'] = f"Error: {str(e)}"


# Global scheduler instance
task_scheduler = TaskScheduler()
