"use client";

import { useCallback, useEffect, useRef } from "react";
import { AI_SERVICE_API_ENDPOINT } from "@/config/api.config";
import { AppDispatch, RootState, store } from "@/store";
import {
  removeExecutionFromWorkflowIdMap,
  setIsRunning,
  setNodeProgress,
  setNodeStatus,
  setWorkflowStageProgress,
  setQueueStatus,
  setRunningExecutionId,
  setRunningWorkflowZarrPath,
  setWorkflowStatus,
  updateExecutionToWorkflowIdMap,
  clearWorkflowCompletionHints,
} from "@/store/slices/chat/workflowSlice";
import { runWorkflowCompletionShared } from "@/utils/agent/workflow/completionSideEffects";
import {
  buildWorkflowCompletionResult,
  createWorkflowCompletionWaiterRegistry,
  type WorkflowCompletionResult,
} from "@/utils/agent/workflow/completionWaiters";
import {
  isWorkflowCancelling,
  isWorkflowRuntimeActive,
  isWorkflowStatusUpdate,
  isWorkflowTerminal,
  STOP_WORKFLOW_UI_TIMEOUT_MS,
  WorkflowStatus,
} from "@/utils/agent/workflow/runtimeStatus";
import { getAuthToken } from "@/utils/common/authToken";
import { apiFetch } from "@/utils/common/apiFetch";
import eventBus from "@/utils/common/eventBus";
import { toast } from "sonner";
import { useDispatch, useSelector } from "react-redux";

export type { WorkflowCompletionResult };

type WorkflowStep = { model: string };

/** Double-Stop / already-settled backend message → unlock optimistic Cancelling. */
function isAlreadyIdleStopError(message: unknown) {
  return /no running workflow/i.test(String(message ?? ""));
}

/**
 * apiFetch may already unwrap `{ code, data }` → `data`. Reading `.data` again
 * makes reconcile think a live run vanished.
 */
function workflowStatusSnapshot(resp: unknown): Record<string, unknown> | null {
  if (!resp || typeof resp !== "object") return null;
  const r = resp as Record<string, unknown>;
  if (typeof r.active === "boolean") return r;
  const nested = r.data;
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).active === "boolean") {
    return nested as Record<string, unknown>;
  }
  return (nested as Record<string, unknown> | undefined) ?? r;
}

export const useWorkflowRuntimeStatus = () => {
  const dispatch = useDispatch<AppDispatch>();
  const nodeStatus = useSelector((state: RootState) => state.workflow.nodeStatus);
  const nodeProgress = useSelector((state: RootState) => state.workflow.nodeProgress);
  const workflowStatus = useSelector((state: RootState) => state.workflow.workflowStatus);
  const isRunning = useSelector((state: RootState) => state.workflow.isRunning);
  const eventSourceRef = useRef<EventSource | null>(null);
  const completionWaitersRef = useRef(createWorkflowCompletionWaiterRegistry());
  const sseRetryCountRef = useRef(0);
  const sseReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumps on every open/close so a stale onerror cannot schedule a reconnect after a newer stream. */
  const sseGenerationRef = useRef(0);
  /** Bumps per Stop attempt so a timed-out request cannot unlock/mutate after a newer Stop. */
  const stopGenerationRef = useRef(0);
  // Keep reconnecting for the whole run — a hard 3-try limit left the UI
  // permanently disconnected while the backend task was still running.
  const SSE_BASE_RETRY_MS = 800;
  const SSE_MAX_RETRY_MS = 15000;
  // Completion reconciliation: the get_status SSE ownership is racy (see the note
  // in startWorkflow) and can leave the graph stuck at "Pending" even after the
  // backend finished — especially after a reset or an interrupted run. While a run
  // is active we poll current_workflow_status as a safety net and force the
  // completion side-effects when the backend no longer has an active execution.
  const reconcileObservedActiveRef = useRef(false);
  const reconcileStartedAtRef = useRef(0);
  const reconcileFiredRef = useRef(false);

  const applyWorkflowSnapshot = useCallback(
    (snapshot: any) => {
      if (!snapshot) return;
      if (snapshot.execution_id) {
        dispatch(setRunningExecutionId(snapshot.execution_id));
        dispatch(updateExecutionToWorkflowIdMap({ executionId: snapshot.execution_id, workflowId: null }));
      }
      if (snapshot.zarr_path) {
        dispatch(setRunningWorkflowZarrPath(snapshot.zarr_path));
      }
      if (isWorkflowStatusUpdate(snapshot.status)) {
        // Keep cancelling distinct so the panel can show Stopping... instead of Running.
        // Also accept terminal statuses from reconcile / restore snapshots.
        dispatch(setWorkflowStatus(snapshot.status));
      }
      if (snapshot.node_status) dispatch(setNodeStatus(snapshot.node_status));
      if (snapshot.node_progress) dispatch(setNodeProgress(snapshot.node_progress));
      if (snapshot.queue_position !== undefined && snapshot.queue_total !== undefined) {
        dispatch(setQueueStatus({ position: snapshot.queue_position, total: snapshot.queue_total }));
      }
    },
    [dispatch]
  );

  const settleCompletionWaiters = useCallback((result: WorkflowCompletionResult) => {
    completionWaitersRef.current.settle(result);
  }, []);

  const closeStatusStream = useCallback(() => {
    sseGenerationRef.current += 1;
    if (eventSourceRef.current) {
      // Detach handlers before close so the browser's close-induced onerror
      // does not re-enter completion / retry logic (and settle waiters early).
      eventSourceRef.current.onopen = null;
      eventSourceRef.current.onmessage = null;
      eventSourceRef.current.onerror = null;
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (sseReconnectTimerRef.current) {
      clearTimeout(sseReconnectTimerRef.current);
      sseReconnectTimerRef.current = null;
    }
  }, []);

  const openStatusStream = useCallback(async () => {
    closeStatusStream();
    const generation = sseGenerationRef.current;
    const token = await getAuthToken();
    if (generation !== sseGenerationRef.current) return;
    if (!token) {
      // Auth briefly unavailable — keep trying while a run is in flight.
      if (store.getState().workflow.isRunning) {
        const attempt = sseRetryCountRef.current + 1;
        sseRetryCountRef.current = attempt;
        const delay = Math.min(SSE_BASE_RETRY_MS * Math.pow(2, Math.min(attempt - 1, 6)), SSE_MAX_RETRY_MS);
        sseReconnectTimerRef.current = setTimeout(() => {
          sseReconnectTimerRef.current = null;
          if (generation !== sseGenerationRef.current) return;
          void openStatusStream();
        }, delay);
      }
      return;
    }
    const url = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_status?token=${encodeURIComponent(token)}`;
    const source = new EventSource(url);
    if (generation !== sseGenerationRef.current) {
      try {
        source.close();
      } catch {
        /* ignore */
      }
      return;
    }
    eventSourceRef.current = source;

    source.onopen = () => {
      if (generation !== sseGenerationRef.current) return;
      sseRetryCountRef.current = 0;
      // Catch up progress that arrived while the stream was down.
      void (async () => {
        try {
          const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/current_workflow_status`, {
            method: "GET",
          });
          const snapshot = workflowStatusSnapshot(response);
          if (generation !== sseGenerationRef.current) return;
          if (snapshot?.active && store.getState().workflow.isRunning) {
            applyWorkflowSnapshot(snapshot);
          }
        } catch {
          /* best effort */
        }
      })();
    };

    source.onmessage = (event) => {
      if (generation !== sseGenerationRef.current) return;
      try {
        const payload = JSON.parse(event.data || "{}");
        // Backend keepalive — ignore; keeps proxies from idle-killing the stream.
        if (payload.heartbeat === true) return;
        if (payload.node_status) {
          dispatch(setNodeStatus(payload.node_status));
          const wfStatus = payload.node_status._workflow_status;
          if (isWorkflowStatusUpdate(wfStatus)) {
            dispatch(setWorkflowStatus(wfStatus));
          }
          if (
            payload.node_status._queue_position !== undefined &&
            payload.node_status._queue_total !== undefined
          ) {
            dispatch(
              setQueueStatus({
                position: payload.node_status._queue_position,
                total: payload.node_status._queue_total,
              })
            );
          }
        }
        if (isWorkflowStatusUpdate(payload.workflow_status)) {
          dispatch(setWorkflowStatus(payload.workflow_status));
        }
        if (payload.node_progress) {
          dispatch(setNodeProgress(payload.node_progress));
        }
        if (payload.stage_progress && typeof payload.stage_progress === "object") {
          dispatch(setWorkflowStageProgress(payload.stage_progress as Record<string, Record<string, number>>));
        }
        if (payload.workflow_complete === true) {
          sseRetryCountRef.current = 0;
          const nodeStatus =
            payload.node_status && typeof payload.node_status === "object"
              ? (payload.node_status as Record<string, number>)
              : undefined;
          // The backend already ships the failed node's message as
          // node_status._error on the terminal frame; nothing read it before.
          const errorText = (nodeStatus as Record<string, unknown> | undefined)?._error;
          const result = buildWorkflowCompletionResult({
            finalStatus: payload.final_status,
            nodeStatus,
            errorText: typeof errorText === "string" ? errorText : undefined,
          });
          // Surface runtime failures for direct (non-batch) runs. Batch and other
          // callers register a completion waiter via waitForWorkflowCompleteSignal and
          // report their own aggregated feedback, so we only toast when nobody is waiting.
          if (
            result.finalStatus === WorkflowStatus.Error &&
            !result.success &&
            completionWaitersRef.current.pendingCount() === 0
          ) {
            toast.error(result.errorMessage || "Workflow failed.");
          }
          closeStatusStream();
          void (async () => {
            const didRun = await runWorkflowCompletionShared(dispatch, store.getState, {
              success: result.success,
            });
            // Only the invocation that actually finalized completion may settle
            // waiters — a racing onerror/reconcile that lost the lock must not
            // release batch waiters before reload finishes.
            if (didRun) {
              settleCompletionWaiters(result);
            }
          })();
        }
      } catch (err) {
        console.warn("[WorkflowRuntime] malformed get_status SSE message", err);
      }
    };

    source.onerror = (err) => {
      if (generation !== sseGenerationRef.current) return;
      console.warn("[WorkflowRuntime] get_status SSE error", err);
      closeStatusStream();
      const wf = store.getState().workflow;
      if (!wf.isRunning) return;
      const snap = wf.nodeStatus;
      const nodeEntries = Object.entries(snap).filter(([key]) => !key.startsWith("_"));
      const allNodesFinished =
        nodeEntries.length > 0 &&
        nodeEntries.every(([, status]) => status === 2 || status === -1);
      if (allNodesFinished) {
        sseRetryCountRef.current = 0;
        const failedNodes = nodeEntries
          .filter(([, status]) => status === -1)
          .map(([key]) => key);
        // Same as the primary completion path: only toast for direct (non-batch)
        // runs, where no completion waiter is registered to report failures itself.
        const result = buildWorkflowCompletionResult({
          finalStatus: failedNodes.length === 0 ? WorkflowStatus.Completed : WorkflowStatus.Error,
          nodeStatus: snap,
        });
        if (!result.success && completionWaitersRef.current.pendingCount() === 0) {
          toast.error(result.errorMessage || "Workflow failed.");
        }
        void (async () => {
          const didRun = await runWorkflowCompletionShared(dispatch, store.getState, {
            success: result.success,
          });
          if (didRun) {
            settleCompletionWaiters(result);
          }
        })();
        return;
      }

      // Run still in flight — keep reconnecting with capped backoff. Do NOT reject
      // waiters: the backend task may still finish and reconcile / a later SSE
      // will settle them.
      const attempt = sseRetryCountRef.current + 1;
      sseRetryCountRef.current = attempt;
      const delay = Math.min(SSE_BASE_RETRY_MS * Math.pow(2, Math.min(attempt - 1, 6)), SSE_MAX_RETRY_MS);
      console.warn(
        `[WorkflowRuntime] get_status SSE disconnected while running; reconnecting in ${delay}ms (attempt ${attempt})`
      );
      const reconnectGen = sseGenerationRef.current;
      sseReconnectTimerRef.current = setTimeout(() => {
        sseReconnectTimerRef.current = null;
        if (reconnectGen !== sseGenerationRef.current) return;
        if (!store.getState().workflow.isRunning) return;
        void openStatusStream();
      }, delay);
    };
  }, [applyWorkflowSnapshot, closeStatusStream, dispatch, settleCompletionWaiters]);

  const restoreCurrentWorkflowStatus = useCallback(async () => {
    try {
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/current_workflow_status`, {
        method: "GET",
      });
      const snapshot = workflowStatusSnapshot(response);
      if (!snapshot?.active || !snapshot?.execution_id) return;

      dispatch(setIsRunning(true));
      applyWorkflowSnapshot(snapshot);
      await openStatusStream();
    } catch {
      // best effort restore
    }
  }, [applyWorkflowSnapshot, dispatch, openStatusStream]);

  const startWorkflow = useCallback(
    async (payload: Record<string, any>) => {
      /** OpenSeadragonContainer snapshots viewer overlay toggles so it can restore after this run completes. */
      eventBus.emit("workflow-graph-run-start");
      const localStatus = store.getState().workflow.workflowStatus;
      if (isWorkflowCancelling(localStatus)) {
        eventBus.emit("workflow-graph-run-aborted");
        dispatch(clearWorkflowCompletionHints());
        throw new Error(
          "Workflow is still cancelling. Wait for Stop to finish before starting a new run.",
        );
      }
      // Optimistic active so Stop can show/work while the start request is in flight.
      dispatch(setIsRunning(true));
      dispatch(setWorkflowStatus(WorkflowStatus.Queued));
      const post = async (body: Record<string, any>) => {
        const r = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, {
          method: "POST",
          body: JSON.stringify(body),
          returnAxiosFormat: true,
        });
        const rawCode = r?.data?.code;
        const hasAppCode = rawCode !== undefined && rawCode !== null;
        const code = Number(rawCode);
        const ok =
          r?.status === 200 &&
          r?.data?.success !== false &&
          (!hasAppCode || (Number.isFinite(code) && code === 0));
        const conflict = code === 409 || r?.status === 409;
        return { resp: r, ok, conflict };
      };
      let attempt: { resp: Awaited<ReturnType<typeof apiFetch>>; ok: boolean; conflict: boolean };
      try {
        attempt = await post(payload);
        // 409 = another execution owns this user. Do not auto force_override —
        // that would silently Stop a live run (other tab / stale UI). Callers that
        // need override pass force_override (batch) or confirm via dialog (WorkflowGraph).
        if (!attempt.ok && attempt.conflict && payload.force_override !== true) {
          const conflictMessage =
            typeof attempt.resp?.data === "string"
              ? attempt.resp.data
              : attempt.resp?.data?.error || attempt.resp?.data?.message || "";
          eventBus.emit("workflow-graph-run-aborted");
          dispatch(clearWorkflowCompletionHints());
          if (
            /cancell/i.test(String(conflictMessage)) ||
            isWorkflowCancelling(store.getState().workflow.workflowStatus)
          ) {
            throw new Error(
              String(conflictMessage) ||
                "Workflow is still cancelling. Wait for Stop to finish before starting a new run.",
            );
          }
          if (!isWorkflowCancelling(store.getState().workflow.workflowStatus)) {
            dispatch(setIsRunning(false));
            dispatch(setWorkflowStatus(WorkflowStatus.Idle));
          }
          throw new Error(
            String(conflictMessage) || "Another workflow is already running for this user.",
          );
        }
      } catch (err) {
        eventBus.emit("workflow-graph-run-aborted");
        dispatch(clearWorkflowCompletionHints());
        if (!isWorkflowCancelling(store.getState().workflow.workflowStatus)) {
          dispatch(setIsRunning(false));
          dispatch(setWorkflowStatus(WorkflowStatus.Idle));
        }
        throw err instanceof Error ? err : new Error("Failed to start workflow");
      }
      const resp = attempt.resp;
      if (!attempt.ok) {
        eventBus.emit("workflow-graph-run-aborted");
        dispatch(clearWorkflowCompletionHints());
        if (!isWorkflowCancelling(store.getState().workflow.workflowStatus)) {
          dispatch(setIsRunning(false));
          dispatch(setWorkflowStatus(WorkflowStatus.Idle));
        }
        const message =
          typeof resp?.data === "string"
            ? resp.data
            : resp?.data?.error || resp?.data?.message || "Failed to start workflow";
        throw new Error(message);
      }
      {
        // Stop may have won while start was in flight — keep cancelling, don't re-queue.
        if (isWorkflowCancelling(store.getState().workflow.workflowStatus)) {
          eventBus.emit("workflow-graph-run-aborted");
          return resp;
        }
        const executionId = resp?.data?.data?.execution_id || resp?.data?.execution_id;
        dispatch(setIsRunning(true));
        dispatch(setWorkflowStatus(WorkflowStatus.Queued));
        if (executionId) {
          dispatch(setRunningExecutionId(executionId));
          dispatch(updateExecutionToWorkflowIdMap({ executionId, workflowId: null }));
        }
        dispatch(setRunningWorkflowZarrPath(payload.zarr_path ?? null));
        // WorkflowGraph must own a live status stream for its run. Relying on a hidden
        // WorkflowContainer via eventBus is racy and can leave the graph stuck at Pending.
        await openStatusStream();
      }
      return resp;
    },
    [dispatch, openStatusStream]
  );

  const stopWorkflow = useCallback(
    async (zarrPath: string) => {
      const wf = store.getState().workflow;
      if (!wf.isRunning && isWorkflowTerminal(wf.workflowStatus)) {
        return;
      }
      const stopGen = ++stopGenerationRef.current;
      // Optimistic cancelling so Stopping... shows before the request returns.
      dispatch(setWorkflowStatus(WorkflowStatus.Cancelling));

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), STOP_WORKFLOW_UI_TIMEOUT_MS);

      const settleStoppedUi = async () => {
        // Backend waited until cancelled (or already idle) — unlock without inventing cancelled.
        closeStatusStream();
        const didRun = await runWorkflowCompletionShared(dispatch, store.getState, {
          success: false,
        });
        if (stopGen !== stopGenerationRef.current) return;
        settleCompletionWaiters({
          success: false,
          finalStatus: WorkflowStatus.Cancelled,
          errorMessage: "Workflow was stopped.",
        });
        if (!didRun && store.getState().workflow.isRunning) {
          dispatch(setIsRunning(false));
          dispatch(setWorkflowStatus(WorkflowStatus.Idle));
        }
        dispatch(setQueueStatus({ position: 0, total: 0 }));
        const rid = store.getState().workflow.runningExecutionId;
        if (rid) {
          dispatch(removeExecutionFromWorkflowIdMap(rid));
          dispatch(setRunningExecutionId(null));
        }
        dispatch(setRunningWorkflowZarrPath(null));
        eventBus.emit("workflow-graph-run-aborted");
      };

      try {
        const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/stop_workflow`, {
          method: "POST",
          body: JSON.stringify({ zarr_path: zarrPath }),
          returnAxiosFormat: true,
          signal: controller.signal,
        });
        if (stopGen !== stopGenerationRef.current) return;

        // Same envelope semantics as startWorkflow: on success, apiFetch unwraps `data.data` so there is often no `code` on `resp.data`.
        const rawCode = resp?.data?.code;
        const hasAppCode = rawCode !== undefined && rawCode !== null;
        const code = Number(rawCode);
        const ok =
          resp?.status === 200 &&
          resp?.data?.success !== false &&
          (!hasAppCode || (Number.isFinite(code) && code === 0));
        const message =
          typeof resp?.data === "string"
            ? resp.data
            : resp?.data?.error || resp?.data?.message || "Failed to stop workflow";
        if (ok || isAlreadyIdleStopError(message)) {
          await settleStoppedUi();
          return ok ? resp : undefined;
        }
        throw new Error(message);
      } catch (err) {
        if (stopGen !== stopGenerationRef.current) return;
        const aborted =
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError") ||
          (err instanceof Error && /abort/i.test(err.message));
        if (aborted) {
          // SSE/reconcile may have already settled while Stop HTTP hung.
          // Do not re-lock Run into cancelling after a terminal/idle settle.
          const current = store.getState().workflow;
          if (!current.isRunning || !isWorkflowRuntimeActive(current.workflowStatus)) {
            return;
          }
          // Keep cancelling + isRunning so Run stays blocked; only Stopping unlocks for retry.
          // Backend may still be settling after /cancel — do not force-clear or start a new run.
          dispatch(setWorkflowStatus(WorkflowStatus.Cancelling));
          throw new Error(
            "Stop timed out. Workflow is still cancelling — press Stop again, do not start a new run yet.",
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        if (isAlreadyIdleStopError(message)) {
          await settleStoppedUi();
          return;
        }
        throw err;
      } finally {
        window.clearTimeout(timeoutId);
      }
    },
    [closeStatusStream, dispatch, settleCompletionWaiters]
  );

  const fetchWorkflowStageStatus = useCallback(async (zarrPath: string, steps: WorkflowStep[]) => {
    const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/workflow_stage_status`, {
      method: "POST",
      body: JSON.stringify({ zarr_path: zarrPath, steps }),
      returnAxiosFormat: true,
    });
    return resp?.data?.data || resp?.data || {};
  }, []);

  /**
   * Event-driven wait for the next workflow completion (SSE / reconcile / stop).
   * No wall-clock timeout for the run itself — only a short grace if kickoff never
   * sets isRunning (so publish-after-train cannot hang forever on a failed start).
   * Register before kickoff so a fast finish is not missed.
   */
  const waitForWorkflowCompleteSignal = useCallback(() => {
    return completionWaitersRef.current.wait(() => store.getState().workflow.isRunning === true);
  }, []);

  // Force the shared completion side-effects (overlay refresh + isRunning reset +
  // settle waiters) from the reconciliation path. runWorkflowCompletionShared holds
  // an internal lock, so this is a harmless no-op if the SSE already completed the run.
  const forceCompleteFromReconcile = useCallback((
    finalStatus?: typeof WorkflowStatus.Completed | typeof WorkflowStatus.Error | typeof WorkflowStatus.Cancelled,
  ) => {
    if (reconcileFiredRef.current) return;
    reconcileFiredRef.current = true;
    closeStatusStream();
    const snap = store.getState().workflow.nodeStatus as Record<string, number>;
    const inferredOk =
      !Object.entries(snap).some(([key, status]) => !key.startsWith("_") && status === -1);
    const result = buildWorkflowCompletionResult({
      finalStatus: finalStatus ?? (inferredOk ? WorkflowStatus.Completed : WorkflowStatus.Error),
      nodeStatus: snap,
    });
    if (result.finalStatus === WorkflowStatus.Error && !result.success && completionWaitersRef.current.pendingCount() === 0) {
      toast.error(result.errorMessage || "Workflow failed.");
    }
    void (async () => {
      const didRun = await runWorkflowCompletionShared(dispatch, store.getState, {
        success: result.success,
      });
      if (didRun) {
        settleCompletionWaiters(result);
      } else if (store.getState().workflow.isRunning) {
        // Primary path still holds the lock — allow another reconcile tick later.
        reconcileFiredRef.current = false;
      }
    })();
  }, [closeStatusStream, dispatch, settleCompletionWaiters]);

  // While a run is in flight, poll current_workflow_status as a safety net against a
  // dropped/racy get_status SSE that never delivers workflow_complete (the failure
  // that leaves the progress bar stuck at Pending and the overlay unrefreshed after a
  // reset or interrupt). When the backend reports the run finished — or no longer has
  // an active execution for this user — self-heal by running the completion effects.
  useEffect(() => {
    if (!isRunning) {
      reconcileObservedActiveRef.current = false;
      reconcileFiredRef.current = false;
      reconcileStartedAtRef.current = 0;
      return;
    }
    reconcileStartedAtRef.current = Date.now();
    reconcileObservedActiveRef.current = false;
    reconcileFiredRef.current = false;
    const POLL_MS = 4000;
    const GRACE_MS = 15000; // let the backend register the run before we call it "gone"
    const interval = setInterval(async () => {
      if (!store.getState().workflow.isRunning) return; // SSE finished it in the meantime
      let snap: Record<string, unknown> | null;
      try {
        const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/current_workflow_status`, {
          method: "GET",
        });
        snap = workflowStatusSnapshot(resp);
      } catch {
        return; // transient error — retry next tick
      }
      if (!store.getState().workflow.isRunning) return;
      const status = snap?.status;
      if (typeof status === "string" && isWorkflowTerminal(status)) {
        // Apply terminal snapshot first so Redux has 2/100 before completion side-effects.
        applyWorkflowSnapshot(snap);
        forceCompleteFromReconcile(
          status as typeof WorkflowStatus.Completed | typeof WorkflowStatus.Error | typeof WorkflowStatus.Cancelled,
        );
        return;
      }
      if (snap?.active === true) {
        // Includes queued (the execution exists, just waiting) — keep waiting.
        // Also apply progress so the UI keeps moving when SSE is temporarily down.
        reconcileObservedActiveRef.current = true;
        applyWorkflowSnapshot(snap);
        // If the status stream is gone, keep trying to reopen it.
        if (!eventSourceRef.current && !sseReconnectTimerRef.current) {
          void openStatusStream();
        }
        return;
      }
      // No active execution for this user: finished (or vanished). Heal once we've
      // either seen it active or waited past the registration grace period.
      const elapsed = Date.now() - reconcileStartedAtRef.current;
      if (reconcileObservedActiveRef.current || elapsed > GRACE_MS) {
        forceCompleteFromReconcile();
      }
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [isRunning, forceCompleteFromReconcile, applyWorkflowSnapshot, openStatusStream]);

  // Once a run becomes active, cancel kickoff-grace timers — completion is then
  // purely event-driven (SSE / reconcile poll / stopWorkflow).
  useEffect(() => {
    if (isRunning) completionWaitersRef.current.armAll();
  }, [isRunning]);

  useEffect(() => {
    restoreCurrentWorkflowStatus();
    const onCloseSse = () => {
      closeStatusStream();
      sseRetryCountRef.current = 0;
    };
    // startWorkflow emits this on failed kickoff (before isRunning). stopWorkflow
    // settles waiters first, so only unarmed waiters remain here.
    const onRunAborted = () => {
      completionWaitersRef.current.rejectUnarmed(new Error("Workflow did not start."));
    };
    eventBus.on("close-sse-connection", onCloseSse);
    eventBus.on("workflow-graph-run-aborted", onRunAborted);
    return () => {
      eventBus.off("close-sse-connection", onCloseSse);
      eventBus.off("workflow-graph-run-aborted", onRunAborted);
      closeStatusStream();
      sseRetryCountRef.current = 0;
      completionWaitersRef.current.rejectAll(new Error("Workflow runtime unmounted."));
    };
  }, [restoreCurrentWorkflowStatus, closeStatusStream]);

  return {
    nodeStatus,
    nodeProgress,
    workflowStatus,
    isRunning,
    startWorkflow,
    stopWorkflow,
    fetchWorkflowStageStatus,
    restoreCurrentWorkflowStatus,
    waitForWorkflowCompleteSignal,
  };
};

