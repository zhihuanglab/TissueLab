"use client";

import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import type { AppDispatch, RootState } from "@/store";
import { setIsGenerating } from "@/store/slices/chat/chatSlice";
import {
  clearWorkflowCompletionHints,
  removeExecutionFromWorkflowIdMap,
  setIsRunning,
  setNodeProgress,
  setNodeStatus,
  setWorkflowStageProgress,
  setQueueStatus,
  setRunningExecutionId,
  setPanels,
  setWorkflowStatus,
} from "@/store/slices/chat/workflowSlice";
import { apiFetch } from "@/utils/common/apiFetch";
import EventBus from "@/utils/EventBus";
import { mergePanelContentWithFactoryDefaults } from "@/utils/workflow/codingAgentPolicy";
import { persistCodingAgentGeneratedScript } from "@/utils/workflow/persistCodingAgentScript";

let completionLock = false;

/** Workflow Graph listens for this to merge generated Python into Coding node `panelStates` (no get_answer polling during GPT generation). */
export const WORKFLOW_CODING_SCRIPT_READY_EVENT = "workflow-coding-script-ready";

/**
 * Runs reload / canvas refresh / optional patch refresh / Coding Agent script fetch once per
 * workflow completion. Returns true if this invocation performed work; false if another
 * handler already finalized the same completion (duplicate SSE / dual subscribers).
 */
export async function runWorkflowCompletionShared(
  dispatch: AppDispatch,
  getState: () => RootState
): Promise<boolean> {
  if (completionLock) {
    return false;
  }
  completionLock = true;
  try {
    const state = getState().workflow;
    const outputPath =
      (state.runningWorkflowZarrPath && state.runningWorkflowZarrPath.length > 0
        ? state.runningWorkflowZarrPath
        : state.outputPath) || "";
    const hints = state.completionHints;
    const refreshTissuePatches =
      hints?.refreshTissuePatches ??
      state.panels.some((p) => p.title === "Tissue Classification");
    const executionId = state.runningExecutionId;

    try {
      if (outputPath) {
        // Only reload the viewer / handler when the completed workflow's zarr matches
        // the file currently open in the viewer. During batch processing the workflow
        // zarr path rotates through each file; blindly reloading would swap the viewer's
        // overlay to a different image.
        const currentPath = getState().svsPath?.currentPath ?? "";
        const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\.zarr$/i, "").toLowerCase();
        const isViewerFile = !!currentPath && norm(outputPath) === norm(currentPath);

        if (!isViewerFile) {
          console.log(
            `[WorkflowCompletion] Skipping handler reload — outputPath="${outputPath}" does not match viewer currentPath="${currentPath}"`
          );
        }

        if (isViewerFile) {
          await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/reload`, {
            method: "POST",
            body: JSON.stringify({ path: outputPath }),
            returnAxiosFormat: true,
          });
          EventBus.emit("refresh-websocket-path", {
            path: outputPath.replace(/\.(zarr)$/, ""),
            forceReload: true,
          });
        }
      }
      if (refreshTissuePatches) {
        EventBus.emit("refresh-patches");
      }
    } catch {
      /* best-effort refresh */
    }

    try {
      const answerResp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_answer`, {
        method: "GET",
        returnAxiosFormat: true,
      });
      const answerJson = answerResp.data as Record<string, unknown> | undefined;
      const answer = answerJson?.answer;
      const panels = getState().workflow.panels;
      if (typeof answer === "string" && answer.includes("def analyze_medical_image")) {
        const nextPanels = panels.map((p) => {
          if (p.type === "GPT-4o Agent") {
            const existing = p.content.find((c) => c.key === "generated_script");
            const newContent = existing
              ? p.content.map((c) => (c.key === "generated_script" ? { ...c, value: answer } : c))
              : [...p.content, { key: "generated_script", type: "text", value: answer } as any];
            return {
              ...p,
              content: mergePanelContentWithFactoryDefaults(newContent, "CodingAgent") as typeof p.content,
            };
          }
          return p;
        });
        dispatch(setPanels(nextPanels));
        if (outputPath) {
          persistCodingAgentGeneratedScript(outputPath, answer);
        }
        try {
          EventBus.emit(WORKFLOW_CODING_SCRIPT_READY_EVENT, answer);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* no script / not requested */
    }

    dispatch(setIsGenerating(false));
    dispatch(setIsRunning(false));
    dispatch(setWorkflowStatus("idle"));
    dispatch(setNodeStatus({}));
    dispatch(setNodeProgress({}));
    // NOTE: do NOT reset stageProgress here. It carries the zarr-derived
    // "this stage has finished" signal (segmentation/embedding/classification
    // = 100) that the WorkflowGraph uses to keep finished sub-bars filled
    // after the SSE stream closes. Wiping it makes the cell-classification
    // bar visually drop back to 0% the moment the run completes.
    // The next workflow run resets it explicitly via `resetWorkflowStatus`.
    dispatch(setQueueStatus({ position: 0, total: 0 }));
    if (executionId) {
      dispatch(removeExecutionFromWorkflowIdMap(executionId));
    }
    dispatch(setRunningExecutionId(null));
    dispatch(clearWorkflowCompletionHints());

    /** Let viewers restore toolbar overlay toggles to the state captured at workflow-graph-run-start. */
    EventBus.emit("workflow-graph-run-finished");

    return true;
  } finally {
    completionLock = false;
  }
}
