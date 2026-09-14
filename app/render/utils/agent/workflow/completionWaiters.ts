/**
 * Event-driven waiters for the next workflow completion
 * (SSE / reconcile / stop). Kickoff arm-grace only — no run wall-clock timeout.
 */
import {
  WorkflowStatus,
  isWorkflowSuccessfulCompletion,
} from "./runtimeStatus"

export type WorkflowCompletionFinalStatus =
  | "completed"
  | "error"
  | "cancelled"
  | "unknown"

export type WorkflowCompletionResult = {
  success: boolean
  finalStatus: WorkflowCompletionFinalStatus
  nodeStatus?: Record<string, number>
  errorMessage?: string
}

type CompletionWaiter = {
  resolve: (result: WorkflowCompletionResult) => void
  reject: (error: Error) => void
  armed: boolean
  armGraceTimer?: ReturnType<typeof setTimeout>
}

const COMPLETION_ARM_GRACE_MS = 15_000

function failedNodeNames(nodeStatus?: Record<string, number>): string[] {
  if (!nodeStatus) return []
  return Object.entries(nodeStatus)
    .filter(([key, status]) => !key.startsWith("_") && status === -1)
    .map(([key]) => key)
}

function workflowFailureMessage(failedNodes: string[]) {
  return failedNodes.length > 0
    ? `Workflow failed at ${failedNodes.join(", ")}.`
    : "Workflow failed."
}

/** Build settle payload; cancelled never counts as success (no node promote). */
export function buildWorkflowCompletionResult(opts: {
  finalStatus?: string | null
  nodeStatus?: Record<string, number>
  /** The failed node's own message (backend `error`), preferred over the generic text. */
  errorText?: string | null
}): WorkflowCompletionResult {
  const rawFinal = opts.finalStatus
  const finalStatus =
    rawFinal === WorkflowStatus.Completed ||
    rawFinal === WorkflowStatus.Error ||
    rawFinal === WorkflowStatus.Cancelled
      ? rawFinal
      : "unknown"
  const failed = failedNodeNames(opts.nodeStatus)
  const success = isWorkflowSuccessfulCompletion(finalStatus) && failed.length === 0
  return {
    success,
    finalStatus,
    nodeStatus: opts.nodeStatus,
    errorMessage:
      finalStatus === WorkflowStatus.Error || failed.length > 0
        ? (opts.errorText?.trim() || workflowFailureMessage(failed))
        : undefined,
  }
}

export function createWorkflowCompletionWaiterRegistry(
  armGraceMs: number = COMPLETION_ARM_GRACE_MS,
) {
  let waiters: CompletionWaiter[] = []

  const clearArmTimer = (waiter: CompletionWaiter) => {
    if (waiter.armGraceTimer) {
      clearTimeout(waiter.armGraceTimer)
      waiter.armGraceTimer = undefined
    }
  }

  return {
    wait(isRunning: () => boolean = () => false) {
      return new Promise<WorkflowCompletionResult>((resolve, reject) => {
        const alreadyRunning = isRunning() === true
        const waiter: CompletionWaiter = { resolve, reject, armed: alreadyRunning }
        if (!alreadyRunning) {
          waiter.armGraceTimer = setTimeout(() => {
            waiter.armGraceTimer = undefined
            if (waiter.armed) return
            waiters = waiters.filter((w) => w !== waiter)
            reject(new Error("Workflow did not start."))
          }, armGraceMs)
        }
        waiters.push(waiter)
      })
    },

    settle(result: WorkflowCompletionResult) {
      const pending = waiters
      waiters = []
      for (const waiter of pending) {
        clearArmTimer(waiter)
        waiter.resolve(result)
      }
    },

    rejectAll(error: Error) {
      const pending = waiters
      waiters = []
      for (const waiter of pending) {
        clearArmTimer(waiter)
        waiter.reject(error)
      }
    },

    armAll() {
      for (const waiter of waiters) {
        if (waiter.armed) continue
        waiter.armed = true
        clearArmTimer(waiter)
      }
    },

    rejectUnarmed(error: Error) {
      const stuck = waiters.filter((w) => !w.armed)
      if (stuck.length === 0) return
      waiters = waiters.filter((w) => w.armed)
      for (const waiter of stuck) {
        clearArmTimer(waiter)
        waiter.reject(error)
      }
    },

    pendingCount() {
      return waiters.length
    },
  }
}
