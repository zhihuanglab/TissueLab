/**
 * Workflow runtime status vocabulary (agent panel).
 *
 * Must stay aligned with backend:
 *   TissueLab/app/service/app/services/workflow/status.py
 *
 * Backend: queued | running | cancelling | completed | error | cancelled
 * UI-only: idle (no active execution)
 */

/** Max time Stop stays in Stopping... before the UI unlocks for retry (backend may still settle). */
export const STOP_WORKFLOW_UI_TIMEOUT_MS = 90_000

/** Const-object enum (preferred over TS `enum` for string status wires). */
export const WorkflowStatus = {
  Idle: "idle",
  Queued: "queued",
  Running: "running",
  Cancelling: "cancelling",
  Completed: "completed",
  Error: "error",
  Cancelled: "cancelled",
} as const

export type WorkflowRuntimeStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus]

/** Backend/SSE statuses that may update Redux (everything except UI-only idle). */
export type WorkflowStatusUpdate = Exclude<WorkflowRuntimeStatus, typeof WorkflowStatus.Idle>

/** Matches backend ACTIVE_STATUSES / TERMINAL_STATUSES */
const ACTIVE = new Set<string>([
  WorkflowStatus.Queued,
  WorkflowStatus.Running,
  WorkflowStatus.Cancelling,
])
const TERMINAL = new Set<string>([
  WorkflowStatus.Completed,
  WorkflowStatus.Error,
  WorkflowStatus.Cancelled,
])
const STATUS_UPDATE = new Set<string>([...ACTIVE, ...TERMINAL])

export function isWorkflowRuntimeActive(
  status: WorkflowRuntimeStatus | string | null | undefined,
): boolean {
  return status != null && ACTIVE.has(status)
}

export function isWorkflowCancelling(
  status: WorkflowRuntimeStatus | string | null | undefined,
): boolean {
  return status === WorkflowStatus.Cancelling
}

export function isWorkflowTerminal(
  status: WorkflowRuntimeStatus | string | null | undefined,
): boolean {
  return status != null && TERMINAL.has(status)
}

/** True only for a successful finished run — cancelled must not promote nodes. */
export function isWorkflowSuccessfulCompletion(
  status: WorkflowRuntimeStatus | string | null | undefined,
): boolean {
  return status === WorkflowStatus.Completed
}

/** Whether an SSE / snapshot status string should update Redux workflowStatus. */
export function isWorkflowStatusUpdate(
  status: string | null | undefined,
): status is WorkflowStatusUpdate {
  return status != null && STATUS_UPDATE.has(status)
}
