"use client";

import { AI_SERVICE_API_ENDPOINT } from "@/config/api.config";
import { isBatchHoldingViewerReload } from "@/services/workflowBatchRuntime.service";
import type { AppDispatch, RootState } from "@/store";
import { setIsGenerating } from "@/store/slices/chat/chatSlice";
import {
  clearWorkflowCompletionHints,
  removeExecutionFromWorkflowIdMap,
  setIsRunning,
  setNodeProgress,
  setNodeStatus,
  setPanels,
  setQueueStatus,
  setRunningExecutionId,
  setWorkflowStatus,
} from "@/store/slices/chat/workflowSlice";
import { markParticipatingNodesDone } from "@/utils/agent/graph/runtime.utils";
import { mergePanelContentWithFactoryDefaults } from "@/utils/agent/workflow/codingPolicy";
import { stripZarrSuffix, workflowZarrPathsMatch } from "@/utils/agent/workflow/pathNorm";
import { annotationTypeStore } from "@/store/zustand/slice/annotationTypesStore";
import { persistCodingAgentGeneratedScript } from "@/utils/agent/workflow/persistScript";
import { WorkflowStatus } from "@/utils/agent/workflow/runtimeStatus";
import { apiFetch } from "@/utils/common/apiFetch";
import eventBus from "@/utils/common/eventBus";
import { selectActiveSlidePath } from "@/utils/viewer/slidePath";

/** Workflow Graph listens for this to merge generated Python into Coding node `panelStates`. */
export const WORKFLOW_CODING_SCRIPT_READY_EVENT = "workflow-coding-script-ready";

/**
 * Payload of `workflow-graph-run-finished` — see the emit at the end of
 * {@link runWorkflowCompletionShared}. Viewers use it to tell "my slide's zarr was
 * rewritten and nobody asked my handler to re-read it" apart from "a reload is on
 * its way", without waiting to find out which.
 */
export type WorkflowRunFinishedPayload = {
  /** Zarr this run wrote, `.zarr` stripped; "" when the completion had no path. */
  outputPath: string;
  /** A forceReload path refresh went out for it. */
  reloadEmitted: boolean;
  /** Batch runtime is holding the refresh on purpose — it owns the single reload. */
  deferred: boolean;
};

/**
 * Does a viewer have to ask for a handler reload itself?
 *
 * Lives with the payload because it is the other half of the same contract. If
 * the completion emitted a path refresh, the ack path owns everything that
 * follows and nobody else should touch it. This covers the opposite case: the
 * completion decided not to emit one — it compares against the *active* slide,
 * so a second pane holding the run's slide is simply missed — and then nothing
 * has re-read the new data and nothing ever will, leaving that viewer painting
 * the pre-run result. Reported synchronously, so this is a decision rather than
 * a wall-clock guess about whether a reload is merely late.
 *
 * Callers must ask this BEFORE any "am I the active pane?" guard: the inactive
 * pane is the whole point, and for the active one the answer is always false
 * anyway — the completion compared `outputPath` against the same
 * `instances[active].filePath` with the same matcher, so it cannot disagree.
 */
export function needsSelfServiceReload(opts: {
  /** `workflow-graph-run-finished` payload; older emitters send none. */
  payload?: WorkflowRunFinishedPayload;
  /** This viewer's slide path. */
  viewerPath: string | null | undefined;
  /** A reload already landed for this run — nothing to do. */
  handlerRebuilt: boolean;
  /**
   * A set_path is already outstanding for this viewer. `refresh-websocket-path`
   * is a broadcast, so the first viewer to ask rebinds every pane holding that
   * slide — including this one. Without this, two panes on the same slide each
   * see the other's rebind start and ask again: N panes, N² binds.
   */
  reloadInFlight: boolean;
}): boolean {
  const { payload, viewerPath, handlerRebuilt, reloadInFlight } = opts;
  if (!payload) return false;
  // A reload is on its way; asking again would only double the rebind.
  if (payload.reloadEmitted !== false) return false;
  // The batch runtime is holding the refresh on purpose and owns the single
  // reload once its queue settles — one per slide in the batch is not wanted.
  if (payload.deferred) return false;
  if (handlerRebuilt || reloadInFlight) return false;
  if (!payload.outputPath || !viewerPath) return false;
  // The run has to have written *our* slide. Same matcher the emitters use, so
  // `.zarr` suffixes and `\` vs `/` spellings do not decide this.
  return workflowZarrPathsMatch(payload.outputPath, viewerPath);
}

let completionLock = false;

/**
 * Runs reload / canvas refresh / optional patch refresh / Coding Agent script fetch once per
 * workflow completion. Returns true if this invocation performed work; false if another
 * handler already finalized the same completion (duplicate SSE / dual subscribers).
 *
 * Pass `success: true` so unfinished nodes snap to status=2 / progress=100 before idle —
 * otherwise a dropped final SSE frame leaves bars frozen at the last live tick (e.g. 70%).
 */
export async function runWorkflowCompletionShared(
  dispatch: AppDispatch,
  getState: () => RootState,
  options?: { success?: boolean }
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
    // Prefer explicit per-run hints. When missing, do NOT infer from the full
    // panel list (a Cell-only Update must not refresh tissue patches just because
    // a Tissue Classification panel exists elsewhere on the graph).
    const refreshTissuePatches = hints?.refreshTissuePatches ?? false;
    const executionId = state.runningExecutionId;
    // Mid-batch: batch runtime owns the single viewer refresh after the queue settles.
    const deferViewerReload = isBatchHoldingViewerReload();

    // Whether a reload actually went out for this completion. Reported on the
    // run-finished event: a viewer holding the run's slide can then tell, with no
    // waiting and no guessing, that the zarr under it was rewritten and nobody
    // asked its handler to re-read — which is otherwise indistinguishable from a
    // reload still in flight.
    let reloadEmitted = false;
    try {
      if (outputPath) {
        // Only reload when the completed workflow's zarr matches the open viewer slide.
        const currentPath = selectActiveSlidePath(getState()) ?? "";
        const isViewerFile = !!currentPath && workflowZarrPathsMatch(outputPath, currentPath);

        if (!isViewerFile) {
          console.log(
            `[WorkflowCompletion] Skipping handler reload — outputPath="${outputPath}" does not match viewer currentPath="${currentPath}"`
          );
        } else if (deferViewerReload) {
          console.log(
            `[WorkflowCompletion] Deferring handler reload — batch owns viewer refresh (viewer="${currentPath}")`
          );
        } else {
          // Optimistic per-cell colour overrides have no expiry, so once the
          // run's output is authoritative they would keep painting the pre-run
          // colour over the fresh prediction — most visibly for a negative
          // ("No") mark, whose whole premise is that the model reclassifies.
          annotationTypeStore.getState().clear();
          eventBus.emit("refresh-websocket-path", {
            path: stripZarrSuffix(outputPath),
            forceReload: true,
          });
          reloadEmitted = true;
        }
      }
      if (refreshTissuePatches && !deferViewerReload) {
        eventBus.emit("refresh-patches");
      }
    } catch (err) {
      console.warn("[WorkflowCompletion] Viewer refresh side-effects failed:", err);
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
          eventBus.emit(WORKFLOW_CODING_SCRIPT_READY_EVENT, answer);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* no script / not requested */
    }

    dispatch(setIsGenerating(false));
    // Success: promote participants to 2/100 before idle so graph substages snap via
    // the single idle heal (status===2 || progress===100 → all bars 100%).
    if (options?.success === true) {
      const { nodeStatus, nodeProgress, statusChanged, progressChanged } = markParticipatingNodesDone(
        getState().workflow.nodeStatus || {},
        getState().workflow.nodeProgress || {}
      );
      if (statusChanged) dispatch(setNodeStatus(nodeStatus));
      if (progressChanged) dispatch(setNodeProgress(nodeProgress));
    }
    dispatch(setIsRunning(false));
    dispatch(setWorkflowStatus(WorkflowStatus.Idle));
    // Keep terminal nodeStatus / nodeProgress / workflowStageProgress; next run resets
    // via resetWorkflowStatus / resetAllGraphProgress.
    dispatch(setQueueStatus({ position: 0, total: 0 }));
    if (executionId) {
      dispatch(removeExecutionFromWorkflowIdMap(executionId));
    }
    dispatch(setRunningExecutionId(null));
    dispatch(clearWorkflowCompletionHints());

    /**
     * Let viewers restore toolbar overlay toggles to the state captured at
     * workflow-graph-run-start — and tell them what this completion did about the
     * handler reload, so a viewer nobody addressed can ask for one itself.
     * `deferred`: the batch runtime owns the refresh, so viewers must not.
     */
    eventBus.emit("workflow-graph-run-finished", {
      outputPath: outputPath ? stripZarrSuffix(outputPath) : "",
      reloadEmitted,
      deferred: deferViewerReload,
    });

    return true;
  } finally {
    completionLock = false;
  }
}
