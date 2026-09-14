"""
Workflow queue position maintenance (shared by start + cancel).
"""

from __future__ import annotations

from app.services.workflow.ui_state import user_workflow_status
from app.services.workflow.status import WorkflowStatus, is_active_status, is_cancelling_status
from app.services.workflow.runtime import workflow_executions


def recalculate_all_queue_positions() -> None:
    """
    Recalculate queue positions for all active workflows.

    Call after cancel / force-override so remaining workflows get updated positions.
    Never overwrite a cancelling UI status — that belongs to the cancel state machine.
    """
    active_executions = [
        exec for exec in workflow_executions.values()
        if is_active_status(exec.status)
    ]

    active_executions.sort(key=lambda e: e.created_at)

    for execution in active_executions:
        uid = execution.uid
        if uid not in user_workflow_status:
            continue

        models_used = set(task.node_name for task in execution.tasks.values())

        queue_positions_by_model = {}
        for model_name in models_used:
            queue_position = 0
            for other_exec in active_executions:
                if other_exec.execution_id == execution.execution_id:
                    break
                for other_task in other_exec.tasks.values():
                    if other_task.node_name == model_name and other_task.status in [
                        "pending",
                        "ready",
                        "running",
                    ]:
                        queue_position += 1
                        break

            queue_positions_by_model[model_name] = queue_position

        max_queue_position = max(queue_positions_by_model.values()) if queue_positions_by_model else 0
        workflow_status = (
            WorkflowStatus.QUEUED if max_queue_position > 0 else WorkflowStatus.RUNNING
        )

        if uid in user_workflow_status:
            user_workflow_status[uid]["queue_positions_by_model"] = queue_positions_by_model
            user_workflow_status[uid]["overall_queue_position"] = max_queue_position
            current = user_workflow_status[uid]["status"]
            if is_cancelling_status(current):
                continue
            if current == WorkflowStatus.QUEUED and workflow_status == WorkflowStatus.RUNNING:
                user_workflow_status[uid]["status"] = WorkflowStatus.RUNNING
            elif current not in (
                WorkflowStatus.RUNNING,
                WorkflowStatus.COMPLETED,
                WorkflowStatus.ERROR,
                WorkflowStatus.CANCELLED,
            ):
                user_workflow_status[uid]["status"] = workflow_status
