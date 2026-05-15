"use client";

import { useCallback, useEffect, useRef } from "react";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
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
} from "@/store/slices/chat/workflowSlice";
import { runWorkflowCompletionShared } from "@/utils/workflow/workflowCompletionSideEffects";
import { isWorkflowSseOwnedByContainer } from "@/utils/workflow/workflowSseCoordinator";
import { getAuthToken } from "@/utils/common/authToken";
import { apiFetch } from "@/utils/common/apiFetch";
import EventBus from "@/utils/EventBus";
import { useDispatch, useSelector } from "react-redux";

type WorkflowStep = { model: string };

export type WorkflowCompletionResult = {
  success: boolean;
  finalStatus: "completed" | "error" | "stopped" | "unknown";
  nodeStatus?: Record<string, number>;
  errorMessage?: string;
};

type CompletionWaiter = {
  resolve: (result: WorkflowCompletionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export const useWorkflowRuntimeStatus = () => {
  const dispatch = useDispatch<AppDispatch>();
  const nodeStatus = useSelector((state: RootState) => state.workflow.nodeStatus);
  const nodeProgress = useSelector((state: RootState) => state.workflow.nodeProgress);
  const workflowStatus = useSelector((state: RootState) => state.workflow.workflowStatus);
  const isRunning = useSelector((state: RootState) => state.workflow.isRunning);
  const eventSourceRef = useRef<EventSource | null>(null);
  const completionWaitersRef = useRef<CompletionWaiter[]>([]);
  const sseRetryCountRef = useRef(0);
  const sseReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SSE_MAX_RETRIES = 3;
  const SSE_BASE_RETRY_MS = 800;

  const settleCompletionWaiters = useCallback((result: WorkflowCompletionResult) => {
    const waiters = completionWaitersRef.current;
    completionWaitersRef.current = [];
    waiters.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    });
  }, []);

  const rejectCompletionWaiters = useCallback((error: Error) => {
    const waiters = completionWaitersRef.current;
    completionWaitersRef.current = [];
    waiters.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
  }, []);

  const closeStatusStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (sseReconnectTimerRef.current) {
      clearTimeout(sseReconnectTimerRef.current);
      sseReconnectTimerRef.current = null;
    }
  }, []);

  const openStatusStream = useCallback(async () => {
    const containerOwnsStream = isWorkflowSseOwnedByContainer();
    closeStatusStream();
    // Local-only build: backend resolves uid server-side, no token required.
    const token = await getAuthToken().catch(() => null);
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_status${qs}`;
    const source = new EventSource(url);
    eventSourceRef.current = source;

    source.onopen = () => {
      sseRetryCountRef.current = 0;
    };

    // Even when WorkflowContainer owns the primary SSE stream, this hook still
    // dispatches node_progress / node_status / stage_progress so that WorkflowGraph
    // receives live updates regardless of Container isolation or timing issues.

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data || "{}");
        if (payload.node_status) {
          dispatch(setNodeStatus(payload.node_status));
          const wfStatus = payload.node_status._workflow_status;
          if (wfStatus === "queued" || wfStatus === "running" || wfStatus === "completed" || wfStatus === "error") {
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
        if (
          payload.workflow_status === "queued" ||
          payload.workflow_status === "running" ||
          payload.workflow_status === "completed" ||
          payload.workflow_status === "error"
        ) {
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
          const finalStatus =
            payload.final_status === "completed" || payload.final_status === "error" || payload.final_status === "stopped"
              ? payload.final_status
              : "unknown";
          const nodeStatus =
            payload.node_status && typeof payload.node_status === "object"
              ? (payload.node_status as Record<string, number>)
              : undefined;
          const failedNodes = nodeStatus
            ? Object.entries(nodeStatus)
                .filter(([key, status]) => !key.startsWith("_") && status === -1)
                .map(([key]) => key)
            : [];
          const result: WorkflowCompletionResult = {
            success: finalStatus !== "error" && failedNodes.length === 0,
            finalStatus,
            nodeStatus,
            errorMessage:
              finalStatus === "error" || failedNodes.length > 0
                ? failedNodes.length > 0
                  ? `Workflow failed at ${failedNodes.join(", ")}.`
                  : "Workflow failed."
                : undefined,
          };
          closeStatusStream();
          void (async () => {
            await runWorkflowCompletionShared(dispatch, store.getState);
            settleCompletionWaiters(result);
          })();
        }
      } catch (err) {
        console.warn("[WorkflowRuntime] malformed get_status SSE message", err);
      }
    };

    source.onerror = (err) => {
      console.warn("[WorkflowRuntime] get_status SSE error", err);
      closeStatusStream();
      const wf = store.getState().workflow;
      if (!wf.isRunning) return;
      const snap = wf.nodeStatus;
      const allNodesFinished =
        Object.keys(snap).length > 0 &&
        Object.values(snap).every((status) => status === 2 || status === -1);
      if (allNodesFinished) {
        sseRetryCountRef.current = 0;
        const failedNodes = Object.entries(snap)
          .filter(([key, status]) => !key.startsWith("_") && status === -1)
          .map(([key]) => key);
        void (async () => {
          await runWorkflowCompletionShared(dispatch, store.getState);
          settleCompletionWaiters({
            success: failedNodes.length === 0,
            finalStatus: failedNodes.length > 0 ? "error" : "completed",
            nodeStatus: snap,
            errorMessage: failedNodes.length > 0 ? `Workflow failed at ${failedNodes.join(", ")}.` : undefined,
          });
        })();
      } else {
        if (isWorkflowSseOwnedByContainer()) {
          // Container stream can keep runtime status alive; do not spin retries here.
          return;
        }
        if (sseRetryCountRef.current < SSE_MAX_RETRIES) {
          const attempt = sseRetryCountRef.current + 1;
          sseRetryCountRef.current = attempt;
          const delay = SSE_BASE_RETRY_MS * Math.pow(2, attempt - 1);
          console.warn(
            `[WorkflowRuntime] get_status SSE disconnected; retrying (${attempt}/${SSE_MAX_RETRIES}) in ${delay}ms`
          );
          sseReconnectTimerRef.current = setTimeout(() => {
            sseReconnectTimerRef.current = null;
            void openStatusStream();
          }, delay);
          return;
        }
        rejectCompletionWaiters(new Error("Workflow status stream disconnected before completion."));
      }
    };
  }, [closeStatusStream, dispatch, rejectCompletionWaiters, settleCompletionWaiters]);

  const restoreCurrentWorkflowStatus = useCallback(async () => {
    try {
      const response = (await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/current_workflow_status`, {
        method: "GET",
      })) as any;
      const snapshot = response?.data;
      if (!snapshot?.active || !snapshot?.execution_id) return;

      dispatch(setRunningExecutionId(snapshot.execution_id));
      dispatch(setRunningWorkflowZarrPath(snapshot.zarr_path ?? null));
      dispatch(updateExecutionToWorkflowIdMap({ executionId: snapshot.execution_id, workflowId: null }));
      dispatch(setIsRunning(true));
      dispatch(setWorkflowStatus(snapshot.status === "queued" ? "queued" : "running"));
      if (snapshot.node_status) dispatch(setNodeStatus(snapshot.node_status));
      if (snapshot.node_progress) dispatch(setNodeProgress(snapshot.node_progress));
      if (snapshot.queue_position !== undefined && snapshot.queue_total !== undefined) {
        dispatch(setQueueStatus({ position: snapshot.queue_position, total: snapshot.queue_total }));
      }
      await openStatusStream();
    } catch {
      // best effort restore
    }
  }, [dispatch, openStatusStream]);

  const startWorkflow = useCallback(
    async (payload: Record<string, any>) => {
      /** OpenSeadragonContainer snapshots viewer overlay toggles so it can restore after this run completes. */
      EventBus.emit("workflow-graph-run-start");
      let resp: Awaited<ReturnType<typeof apiFetch>>;
      try {
        resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, {
          method: "POST",
          body: JSON.stringify(payload),
          returnAxiosFormat: true,
        });
      } catch (err) {
        EventBus.emit("workflow-graph-run-aborted");
        throw err instanceof Error ? err : new Error("Failed to start workflow");
      }
      const rawCode = resp?.data?.code;
      const hasAppCode = rawCode !== undefined && rawCode !== null;
      const code = Number(rawCode);
      const ok =
        resp?.status === 200 &&
        resp?.data?.success !== false &&
        (!hasAppCode || (Number.isFinite(code) && code === 0));
      if (!ok) {
        EventBus.emit("workflow-graph-run-aborted");
        const message =
          typeof resp?.data === "string"
            ? resp.data
            : resp?.data?.error || resp?.data?.message || "Failed to start workflow";
        throw new Error(message);
      }
      if (ok) {
        const executionId = resp?.data?.data?.execution_id || resp?.data?.execution_id;
        dispatch(setIsRunning(true));
        dispatch(setWorkflowStatus("queued"));
        if (executionId) {
          dispatch(setRunningExecutionId(executionId));
          dispatch(updateExecutionToWorkflowIdMap({ executionId, workflowId: null }));
        }
        dispatch(setRunningWorkflowZarrPath(payload.zarr_path ?? null));
        // WorkflowGraph must own a live status stream for its run. Relying on a hidden
        // WorkflowContainer via EventBus is racy and can leave the graph stuck at Pending.
        await openStatusStream();
      }
      return resp;
    },
    [dispatch, openStatusStream]
  );

  const stopWorkflow = useCallback(
    async (zarrPath: string) => {
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/stop_workflow`, {
        method: "POST",
        body: JSON.stringify({ zarr_path: zarrPath }),
        returnAxiosFormat: true,
      });
      // Same envelope semantics as startWorkflow: on success, apiFetch unwraps `data.data` so there is often no `code` on `resp.data`.
      const rawCode = resp?.data?.code;
      const hasAppCode = rawCode !== undefined && rawCode !== null;
      const code = Number(rawCode);
      const ok =
        resp?.status === 200 &&
        resp?.data?.success !== false &&
        (!hasAppCode || (Number.isFinite(code) && code === 0));
      if (!ok) {
        const message =
          typeof resp?.data === "string"
            ? resp.data
            : resp?.data?.error || resp?.data?.message || "Failed to stop workflow";
        throw new Error(message);
      }
      closeStatusStream();
      settleCompletionWaiters({ success: false, finalStatus: "stopped", errorMessage: "Workflow was stopped." });
      dispatch(setIsRunning(false));
      dispatch(setWorkflowStatus("idle"));
      dispatch(setNodeStatus({}));
      dispatch(setNodeProgress({}));
      dispatch(setWorkflowStageProgress({}));
      dispatch(setQueueStatus({ position: 0, total: 0 }));
      const rid = store.getState().workflow.runningExecutionId;
      if (rid) {
        dispatch(removeExecutionFromWorkflowIdMap(rid));
        dispatch(setRunningExecutionId(null));
      }
      dispatch(setRunningWorkflowZarrPath(null));
      EventBus.emit("workflow-graph-run-aborted");
      return resp;
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

  const waitForWorkflowCompleteSignal = useCallback((timeoutMs = 30 * 60 * 1000) => {
    return new Promise<WorkflowCompletionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        completionWaitersRef.current = completionWaitersRef.current.filter((waiter) => waiter.timer !== timer);
        reject(new Error("Timed out waiting for workflow completion."));
      }, timeoutMs);
      completionWaitersRef.current.push({ resolve, reject, timer });
    });
  }, []);

  useEffect(() => {
    restoreCurrentWorkflowStatus();
    return () => {
      closeStatusStream();
      sseRetryCountRef.current = 0;
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

