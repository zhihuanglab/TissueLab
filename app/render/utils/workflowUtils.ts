import { apiFetch } from '@/utils/common/apiFetch';
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import { setIsRunning, resetWorkflowStatus, setNodeProgress } from "@/store/slices/chat/workflowSlice";
import { setIsGenerating as setIsChatGenerating } from "@/store/slices/chat/chatSlice";
import { AppDispatch, store } from "@/store";
import EventBus from "@/utils/EventBus";

/**
 * Generates the .zarr output path from a given file path.
 * @param path The input file path.
 * @returns The path with .zarr appended, or the original path if it already ends with .zarr.
 */
export const getDefaultOutputPath = (path: string | null): string => {
  if (!path) return "";
  return path.endsWith('.zarr') ? path : path + '.zarr';
};

/**
 * Resets workflow state and closes SSE connection before starting a new workflow.
 * This is a shared utility function to ensure consistent workflow reset behavior.
 * @param dispatch Redux AppDispatch instance.
 */
export const resetWorkflowBeforeStart = async (dispatch: AppDispatch): Promise<void> => {
  // Reset workflow status (clears nodeStatus, nodeProgress, etc.)
  dispatch(resetWorkflowStatus());
  
  // Force clear progress to prevent showing old 100% progress
  // This ensures progress starts from 0% even if old SSE messages arrive
  dispatch(setNodeProgress({}));
  
  // Close old SSE connection before starting new workflow
  // This prevents old progress messages from being received
  // Note: setupNodeStatusTracking will also close any existing connection
  EventBus.emit('close-sse-connection');
  
  // Wait a brief moment to ensure the close event is processed synchronously
  // EventBus.emit is synchronous, but setTimeout(0) ensures event loop processes it
  await new Promise(resolve => setTimeout(resolve, 0));
};

/**
 * Triggers the patch classification workflow.
 * @param dispatch Redux AppDispatch instance.
 * @param zarrPath The full path to the Zarr file.
 * @param patchClassificationData Object containing patch classification data.
 */
export const triggerPatchClassificationWorkflow = async (
  dispatch: AppDispatch,
  zarrPath: string,
  patchClassificationData: { class_name: string[], class_hex_color: string[] },
  classifierPath: string | null,
  classifierSavePath: string | null,
  classOperations?: {
    renames?: Array<{ from: string; to: string }>;
    adds?: Array<{ name: string; color?: string }>;
  }
): Promise<void> => {
  if (!zarrPath || !patchClassificationData || patchClassificationData.class_name.length === 0) {
    console.warn("Cannot trigger patch workflow: Missing Zarr path or patch classification data.");
    return;
  }

  const payload = {
    zarr_path: zarrPath,
    step1: {
      nodeId: "MuskClassification",
      input: {
        tissue_classes: patchClassificationData.class_name,
        tissue_colors: patchClassificationData.class_hex_color,
        classifier_path: classifierPath,
        save_classifier_path: classifierSavePath,
        ...(classOperations ? { class_operations: classOperations } : {}),
      }
    }
  };

  // Reset workflow state and close SSE connection before starting
  // Use shared utility function for consistent behavior
  await resetWorkflowBeforeStart(dispatch);

  EventBus.emit("workflow-graph-run-start");

  dispatch(setIsChatGenerating(true));
  dispatch(setIsRunning(true));

  try {
    console.log("[triggerPatchClassificationWorkflow] Workflow payload:", payload);
    const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, {
      method: 'POST',
      body: JSON.stringify(payload),
      returnAxiosFormat: true,
    });
    console.log("[triggerPatchClassificationWorkflow] Workflow started successfully:", response.data);
    
    // ✅ Keep isRunning = true, let WorkflowContainer SSE handle completion
    // ✅ Only clear isChatGenerating after successful start
    dispatch(setIsChatGenerating(false));
    
  } catch (wfError) {
    console.error("[triggerPatchClassificationWorkflow] Error starting workflow:", wfError);
    EventBus.emit("workflow-graph-run-aborted");
    // ❌ Only on error, reset both states
    dispatch(setIsChatGenerating(false));
    dispatch(setIsRunning(false));
  }
};

/** Minimal args for coalesced auto-update; panel handlers supply full payload (incl. class_operations). */
export type CoalescedWorkflowTriggerParams = {
  zarrPath: string;
  source?: string;
};

let pendingCoalescedNucleiClassification = false;
let pendingCoalescedPatchClassification = false;
let latestCoalescedNucleiGetParams: (() => CoalescedWorkflowTriggerParams | null) | null = null;
let latestCoalescedPatchGetParams: (() => CoalescedWorkflowTriggerParams | null) | null = null;
let coalescedWorkflowFollowupListenerInstalled = false;

function flushCoalescedWorkflowFollowupsAfterRun(): void {
  const st = store.getState();

  if (pendingCoalescedNucleiClassification) {
    pendingCoalescedNucleiClassification = false;
    if (st.workflow.updateAfterEveryAnnotation && st.annotations.nucleiClasses?.length) {
      const p = latestCoalescedNucleiGetParams?.();
      if (p?.zarrPath) {
        EventBus.emit("trigger-nuclei-update", {
          zarrPath: p.zarrPath,
          source: p.source ?? "coalesced-nuclei-follow-up",
        });
      }
    }
  }

  if (pendingCoalescedPatchClassification) {
    pendingCoalescedPatchClassification = false;
    if (st.workflow.updatePatchAfterEveryAnnotation) {
      const p = latestCoalescedPatchGetParams?.();
      if (p?.zarrPath) {
        EventBus.emit("trigger-patch-update", {
          zarrPath: p.zarrPath,
          source: p.source ?? "coalesced-patch-follow-up",
        });
      }
    }
  }
}

function ensureCoalescedWorkflowFollowupListener(): void {
  if (coalescedWorkflowFollowupListenerInstalled) return;
  coalescedWorkflowFollowupListenerInstalled = true;
  EventBus.on("workflow-graph-run-finished", flushCoalescedWorkflowFollowupsAfterRun);
  EventBus.on("workflow-graph-run-aborted", flushCoalescedWorkflowFollowupsAfterRun);
}

/**
 * Nuclei: if a workflow is already running, defer a single follow-up; otherwise emit `trigger-nuclei-update`
 * so the Nuclei panel runs the same path as manual Update (incl. class_operations).
 */
export function scheduleCoalescedClassificationAfterAnnotation(
  getParams: () => CoalescedWorkflowTriggerParams | null
): void {
  latestCoalescedNucleiGetParams = getParams;
  const params = getParams();
  if (!params?.zarrPath) return;
  if (!store.getState().workflow.updateAfterEveryAnnotation) return;
  if (!store.getState().annotations.nucleiClasses?.length) return;

  ensureCoalescedWorkflowFollowupListener();

  if (!store.getState().workflow.isRunning) {
    pendingCoalescedNucleiClassification = false;
    EventBus.emit("trigger-nuclei-update", {
      zarrPath: params.zarrPath,
      source: params.source ?? "coalesced-nuclei",
    });
    return;
  }

  pendingCoalescedNucleiClassification = true;
}

/**
 * Patch/tissue: same coalescing semantics as nuclei, but emits `trigger-patch-update` for panel parity.
 */
export function scheduleCoalescedPatchClassificationAfterAnnotation(
  getParams: () => CoalescedWorkflowTriggerParams | null
): void {
  latestCoalescedPatchGetParams = getParams;
  const params = getParams();
  if (!params?.zarrPath) return;
  if (!store.getState().workflow.updatePatchAfterEveryAnnotation) return;

  ensureCoalescedWorkflowFollowupListener();

  if (!store.getState().workflow.isRunning) {
    pendingCoalescedPatchClassification = false;
    EventBus.emit("trigger-patch-update", {
      zarrPath: params.zarrPath,
      source: params.source ?? "coalesced-patch",
    });
    return;
  }

  pendingCoalescedPatchClassification = true;
}
