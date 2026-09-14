"""
Start a workflow execution (agent / batch panel).

Owns queued|running entry into the shared workflow status vocabulary.
"""

from __future__ import annotations

import asyncio
import time
from typing import Dict, List, Optional

from app.services import tasks as tasks_svc
from app.services.workflow.cancel import stop_workflow_by_scheduler
from app.services.workflow.status import (
    WorkflowStatus,
    is_active_status,
    is_cancel_owned_status,
    is_cancelling_status,
)
from app.utils import resolve_path
from app.services.workflow.runtime import (
    Task,
    WorkflowExecution,
    model_current_task,
    user_active_executions,
    workflow_executions,
)
from app.utils.workflow.scheduler import task_scheduler


async def start_workflow_from_frontend(frontend_data: dict, uid: str = None, auth_header: str | None = None):
    """
    Start a workflow from frontend data with user isolation.

    Parameters:
    - frontend_data: Dictionary containing workflow configuration, including zarr_path and step information
    - uid: User ID for session isolation

    Returns:
    - On success: {"success": True, "message": "...", "workflow_id": id, "task_info": {...}}
    - On failure: {"success": False, "error": "error message"}
    """
    if not uid:
        return {"success": False, "error": "User ID (uid) is required for workflow execution"}
    
    if "zarr_path" not in frontend_data:
        return {"success": False, "error": "You must provide 'zarr_path'"}

    # Resolve zarr_path to absolute path using STORAGE_ROOT
    zarr_path = resolve_path(frontend_data["zarr_path"])
    force_override = frontend_data.get("force_override") is True

    async def _resolve_active_workflow_conflict(reason: str) -> Optional[dict]:
        """
        Reject or join cooperative cancel for an existing active workflow.

        Never silently bookkeeping-clear a live /execute — always POST /cancel
        via stop_workflow_by_scheduler when force_override is set.
        """
        ui_status = None
        if uid in tasks_svc.user_workflow_status:
            ui_status = tasks_svc.user_workflow_status[uid].get("status")
        existing_exec_id = user_active_executions.get(uid)
        existing_exec = workflow_executions.get(existing_exec_id) if existing_exec_id else None
        exec_status = getattr(existing_exec, "status", None) if existing_exec else None
        effective = exec_status or ui_status
        if not is_active_status(effective) and not is_active_status(ui_status):
            return None

        if not force_override:
            if is_cancelling_status(effective) or is_cancelling_status(ui_status):
                return {
                    "success": False,
                    "error": "Workflow is still cancelling. Wait for Stop to finish before starting a new run.",
                    "code": 409,
                }
            return {
                "success": False,
                "error": f"User {uid} already has a workflow running, queued, or cancelling",
                "code": 409,
            }

        tasks_svc.logger.warning(
            f"[FORCE_OVERRIDE] Joining cooperative cancel for user {uid}: {reason}"
        )
        stop_result = await stop_workflow_by_scheduler(uid=uid)
        if stop_result.get("success"):
            return None

        # Stale UI-only active status (no live execution) — clear bookkeeping so
        # force_override can proceed. Never do this while an execution still exists.
        err = str(stop_result.get("error") or "")
        still_live = user_active_executions.get(uid) in workflow_executions
        if (not still_live) and "no running workflow" in err.lower():
            if uid in tasks_svc.user_workflow_status and is_active_status(
                tasks_svc.user_workflow_status[uid].get("status")
            ):
                tasks_svc.user_workflow_status[uid]["status"] = WorkflowStatus.CANCELLED
                tasks_svc.user_workflow_status[uid]["is_generating"] = False
            tasks_svc.logger.warning(
                f"[FORCE_OVERRIDE] Cleared stale UI status for user {uid} (no live execution)"
            )
            return None

        return {
            "success": False,
            "error": stop_result.get("error")
            or "Failed to finish cancelling before starting a new run",
            "code": 409,
        }

    conflict = await _resolve_active_workflow_conflict("pre-start active check")
    if conflict is not None:
        return conflict

    # Reserve an active execution immediately so Stop during start prep can resolve it.
    provisional_id = f"{uid}_starting_{int(time.time() * 1000)}"
    provisional = WorkflowExecution(
        execution_id=provisional_id,
        workflow_id=0,
        uid=uid,
        zarr_path=zarr_path,
        auth_header=auth_header,
        tasks={},
        status=WorkflowStatus.QUEUED,
        created_at=time.time(),
    )
    workflow_executions[provisional_id] = provisional
    user_active_executions[uid] = provisional_id
    tasks_svc.user_workflow_status[uid] = {
        "status": WorkflowStatus.QUEUED,
        "execution_id": provisional_id,
        "node_status": {},
        "node_progress": {},
        "zarr_path": zarr_path,
        "auth_header": auth_header,
        "is_generating": False,
        "cur_answer": None,
    }

    def _start_was_cancelled() -> bool:
        """True if Stop already owns this provisional execution or its UI."""
        ex = workflow_executions.get(provisional_id)
        if ex is None or is_cancel_owned_status(getattr(ex, "status", None)):
            return True
        prev_ui = tasks_svc.user_workflow_status.get(uid) or {}
        return (
            prev_ui.get("execution_id") == provisional_id
            and is_cancel_owned_status(prev_ui.get("status"))
        )

    def _cancelled_during_start() -> dict:
        return {"success": False, "error": "Workflow was cancelled during start", "code": 409}

    def _abandon_provisional_if_ours() -> None:
        ex = workflow_executions.get(provisional_id)
        if ex is None or is_cancel_owned_status(ex.status):
            return
        ex.status = WorkflowStatus.CANCELLED
        if user_active_executions.get(uid) == provisional_id:
            user_active_executions.pop(uid, None)
        if uid in tasks_svc.user_workflow_status and tasks_svc.user_workflow_status[uid].get("execution_id") == provisional_id:
            tasks_svc.user_workflow_status[uid]["status"] = WorkflowStatus.CANCELLED
            tasks_svc.user_workflow_status[uid]["is_generating"] = False

    def _fail(result: dict) -> dict:
        _abandon_provisional_if_ours()
        return result

    # For simplicity, we'll use the global manager but ensure serial execution through queue
    # Clear any existing workflows in global manager
    tasks_svc.manager.clear_workflows()

    explicit_task_deps_raw = frontend_data.get("task_dependencies")
    explicit_task_deps: Optional[Dict[str, List[str]]] = None

    if isinstance(explicit_task_deps_raw, dict):
        explicit_task_deps = {
            str(k).strip(): [str(x).strip() for x in (v or [])]
            for k, v in explicit_task_deps_raw.items()
        }

    steps_data = {
        k: v
        for k, v in frontend_data.items()
        if k not in ("zarr_path", "task_dependencies", "force_override")
    }
    steps = list(steps_data.items())
    steps.sort(key=lambda x: x[0])  # sort step1, step2...

    node_names = []
    node_inputs = {}

    script_prompt = None  # store script prompt
    script_seen = False

    for stepKey, stepVal in steps:
        panel_type = stepVal["nodeId"] # This is TaskNodeManager registry node id from frontend
        userInput = stepVal.get("input", None)
        if userInput is None:
            userInput = {}

        # find the script model
        if panel_type == "GPT-4o Agent":
            raw_prompt = userInput.get("prompt", None)
            normalized_prompt = None
            if isinstance(raw_prompt, str):
                stripped = raw_prompt.strip()
                normalized_prompt = stripped if stripped else None
            elif raw_prompt not in (None, ""):
                normalized_prompt = raw_prompt

            script_prompt = normalized_prompt
            userInput["prompt"] = script_prompt
            if script_prompt is not None:
                script_seen = True
            else:
                try:
                    if hasattr(tasks_svc.update_node_progress, "node_progress"):
                        tasks_svc.update_node_progress.node_progress.pop("GPT-4o Agent", None)
                except Exception:
                    pass
            continue

        actual_node_name_for_zarr = panel_type.strip()

        if actual_node_name_for_zarr not in tasks_svc.manager.nodes:
            # Flow-order/config error (a prerequisite node was never created) — 409,
            # not a 500 bug, so it isn't auto-reported as a server-error ticket.
            return _fail({"success": False, "error": f"Node '{actual_node_name_for_zarr}' not found in tasks_svc.manager. Make sure it's already created & running.", "code": 409})

        node_names.append(actual_node_name_for_zarr) # Use the actual name for dependency chain
        node_inputs[actual_node_name_for_zarr] = userInput # Use actual name as key for Zarr writing

    # Special handling for CodingAgent-only workflow
    if len(node_names) == 0 and script_prompt is not None:
        # CodingAgent-only workflow: create a special workflow ID and skip TaskNodeManager
        wf_id = -1  # Special ID for CodingAgent-only workflows (negative to avoid collision)
        matching_wf_id = wf_id
    else:
        # Regular workflow with actual tasknodes
        if explicit_task_deps is not None:
            for target, deps in explicit_task_deps.items():
                if target not in node_names:
                    return _fail({"success": False, "error": f"task_dependencies key '{target}' is not in workflow nodes {node_names}"})
                for d in deps:
                    if d not in node_names:
                        return _fail({"success": False, "error": f"task_dependencies['{target}'] references unknown node '{d}'"})
                    dep_res = tasks_svc._add_dependency_internal(d, target)
                    if "error" in dep_res:
                        return _fail({"success": False, "error": dep_res["error"]})
        else:
            # add_dependency: linear chain from step order
            for i in range(len(node_names) - 1):
                fromN = node_names[i]
                toN = node_names[i + 1]
                dep_res = tasks_svc._add_dependency_internal(fromN, toN)
                if "error" in dep_res:
                    return _fail({"success": False, "error": dep_res["error"]})

        tasks_svc.manager.detect_workflows()

        # find the workflow that matches the requested nodes exactly
        requested_nodes_set = set(node_names)
        matching_wf_id = None

        for wf_id, wf_nodes in tasks_svc.manager.workflows.items():
            # check if the workflow contains all requested nodes and only the requested nodes
            if set(wf_nodes) == requested_nodes_set:
                matching_wf_id = wf_id
                break

        # if no exact match is found, but we only have one node, find the workflow that contains that node
        if matching_wf_id is None and len(node_names) == 1:
            for wf_id, wf_nodes in tasks_svc.manager.workflows.items():
                if node_names[0] in wf_nodes and len(wf_nodes) == 1:
                    matching_wf_id = wf_id
                    break

        if matching_wf_id is None and explicit_task_deps is not None and node_names:
            try:
                topo_order = tasks_svc._topological_sort_explicit_node_list(node_names, explicit_task_deps)
                synth = (max(tasks_svc.manager.workflows.keys(), default=0) + 1) if tasks_svc.manager.workflows else 1
                tasks_svc.manager.workflows[synth] = topo_order
                matching_wf_id = synth
            except ValueError as e:
                return _fail({"success": False, "error": str(e)})

        if matching_wf_id is None:
            return _fail({"success": False, "error": f"cannot find the workflow that matches the requested nodes: {node_names}"})

    # use the found matching workflow ID
    wf_id = matching_wf_id

    # Checkpoint before UI refresh / long IO: Stop during sync assembly is rare but this
    # is the last cheap gate before prepare_zarr / promote.
    if _start_was_cancelled():
        return _cancelled_during_start()

    # Keep provisional reservation; refresh UI fields without dropping execution_id.
    tasks_svc.user_workflow_status[uid] = {
        "status": WorkflowStatus.QUEUED,
        "wf_id": wf_id,
        "execution_id": provisional_id,
        "node_status": {},
        "node_progress": {},
        "zarr_path": zarr_path,
        "auth_header": auth_header,
        "is_generating": False,
        "cur_answer": None,
    }
    
    # Also prepare execution-time zarr_group mapping for this run
    try:
        nodes_meta = tasks_svc.model_store.get_nodes_extended()
        if isinstance(nodes_meta, dict) and hasattr(tasks_svc.manager, 'zarr_group_by_node'):
            for n in node_names:
                meta = nodes_meta.get(n, {}) if isinstance(nodes_meta, dict) else {}
                if isinstance(meta, dict) and meta.get('zarr_group'):
                    tasks_svc.manager.zarr_group_by_node[n] = meta.get('zarr_group')
    except Exception:
        pass

    # Prepare script prompt
    normalized_script_prompt = None
    if script_seen:
        trimmed_prompt = script_prompt.strip() if isinstance(script_prompt, str) else ""
        normalized_script_prompt = trimmed_prompt if trimmed_prompt != "" else " "

    script_requested = normalized_script_prompt is not None

    # Ensure scheduler is running
    if not task_scheduler.running:
        await task_scheduler.start()

    # Promote the provisional reservation into the real execution (same id so Stop mid-start still matches).
    execution_id = provisional_id

    # Create Task objects for each node
    tasks = {}
    for node_name in node_names:
        node = tasks_svc.manager.nodes[node_name]
        if explicit_task_deps is not None:
            raw_deps = explicit_task_deps.get(node_name) or []
            dep_list = [d for d in raw_deps if d in node_names]
        else:
            dep_list = node.dependencies.copy() if hasattr(node, 'dependencies') else []
        task = Task(
            task_id=f"{execution_id}_{node_name}",
            workflow_id=wf_id,
            node_name=node_name,
            uid=uid,
            zarr_path=zarr_path,
            node_inputs=node_inputs.get(node_name, {}),
            dependencies=dep_list,
            execution_id=execution_id,
            status='pending',
            created_at=time.time()
        )
        tasks[node_name] = task

    # Calculate queue position for this user BEFORE creating execution
    # Count how many tasks with the same model are already running or queued
    queue_positions_by_model = {}
    for node_name in node_names:
        queue_position = 0
        for other_exec in workflow_executions.values():
            if other_exec.execution_id == execution_id:
                continue
            if is_active_status(other_exec.status):
                # Check if this execution has a task using the same model
                for other_task in other_exec.tasks.values():
                    if other_task.node_name == node_name and other_task.status in ['pending', 'ready', 'running']:
                        queue_position += 1
                        break  # Only count each execution once per model
        queue_positions_by_model[node_name] = queue_position

    # Determine overall workflow status: if any task is queued, status is 'queued'
    max_queue_position = max(queue_positions_by_model.values()) if queue_positions_by_model else 0
    workflow_status = WorkflowStatus.QUEUED if max_queue_position > 0 else WorkflowStatus.RUNNING

    # Ensure zarr exists / migrate before the execution becomes dispatchable.
    # Run off the event loop so Stop can still progress during heavy IO.
    try:
        await asyncio.to_thread(tasks_svc.prepare_zarr_for_workflow, zarr_path)
    except Exception as e:
        tasks_svc.logger.error(f"Failed to prepare zarr for workflow: {e}", exc_info=e)
        return _fail({"success": False, "error": f"Failed to prepare zarr store: {str(e)}"})

    if _start_was_cancelled():
        return _cancelled_during_start()

    # Fill provisional execution in place (only after zarr is ready).
    provisional.workflow_id = wf_id
    provisional.tasks = tasks
    provisional.completed_tasks = set()
    provisional.failed_tasks = set()
    provisional.script_prompt = normalized_script_prompt
    provisional.auth_header = auth_header
    provisional.zarr_path = zarr_path

    # Commit promote status last; bail if Stop won mid-fill.
    if is_cancel_owned_status(provisional.status):
        return _cancelled_during_start()
    provisional.status = workflow_status
    user_active_executions[uid] = execution_id

    # Initialize UI only if Stop still does not own this provisional.
    if _start_was_cancelled():
        return _cancelled_during_start()

    tasks_svc.user_workflow_status[uid] = {
        "status": workflow_status,
        "wf_id": wf_id,
        "execution_id": execution_id,
        "node_status": {node_name: 0 for node_name in node_names},
        "node_progress": {node_name: 0 for node_name in node_names},
        "queue_positions_by_model": queue_positions_by_model,  # Add per-model queue info
        "overall_queue_position": max_queue_position,
        "zarr_path": zarr_path,
        "auth_header": auth_header,
        "is_generating": script_requested,  # Set to True if CodingAgent is requested
        "cur_answer": None  # Will be populated by _handle_script_generation
    }

    if script_requested:
        tasks_svc.user_workflow_status[uid]['node_status']['GPT-4o Agent'] = 0
        tasks_svc.user_workflow_status[uid]['node_progress']['GPT-4o Agent'] = 0

    # Scheduler will automatically pick up tasks and execute them

    return {
        "success": True,
        "message": f"Workflow '{wf_id}' submitted for execution",
        "workflow_id": wf_id,
        "execution_id": execution_id,
        "queue_position": max_queue_position,  # Add queue position info
        "task_info": {
            "wf_id": wf_id,
            "node_inputs": node_inputs,
            "script_prompt": normalized_script_prompt,
            "zarr_path": zarr_path
        }
    }

