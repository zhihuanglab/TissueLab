"use client";

/**
 * When WorkflowContainer is mounted (e.g. chat sidebar with Workflow + Graph tabs),
 * it owns the tasks/v1/get_status EventSource. WorkflowGraph's hook must not open a
 * duplicate stream. Graph-only layouts (e.g. SidebarWorkflowGraphOnly) have no container
 * registration, so the hook opens SSE there.
 */
let workflowContainerRegisterCount = 0;

export function registerWorkflowSseContainer(): () => void {
  workflowContainerRegisterCount += 1;
  return () => {
    workflowContainerRegisterCount = Math.max(0, workflowContainerRegisterCount - 1);
  };
}

export function isWorkflowSseOwnedByContainer(): boolean {
  return workflowContainerRegisterCount > 0;
}
