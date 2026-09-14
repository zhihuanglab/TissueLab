export { toWorkflowZarrPath as getDefaultOutputPath } from "@/utils/agent/workflow/pathNorm";
import { setIsGenerating as setIsChatGenerating } from "@/store/slices/chat/chatSlice";
import {
  clearWorkflowCompletionHints,
  resetWorkflowStatus,
  setIsRunning,
  setNodeProgress,
  setWorkflowCompletionHints,
} from "@/store/slices/chat/workflowSlice";
import { AppDispatch, store } from "@/store";
import eventBus from "@/utils/common/eventBus";

/**
 * Resets workflow state and closes SSE connection before starting a new workflow.
 * Emits `close-sse-connection` so `useWorkflowRuntimeStatus` can drop the prior EventSource
 * before a new get_status stream is opened. Emit is synchronous — no macrotask delay needed.
 */
export const resetWorkflowBeforeStart = async (dispatch: AppDispatch): Promise<void> => {
  dispatch(resetWorkflowStatus());
  dispatch(setNodeProgress({}));
  eventBus.emit("close-sse-connection");
};

export type StartClassificationWorkflowOptions = {
  dispatch: AppDispatch;
  /** Graph-injected or hook `startWorkflow` (opens get_status SSE). */
  startWorkflow: (payload: Record<string, unknown>) => Promise<unknown>;
  payload: Record<string, unknown>;
  refreshTissuePatches: boolean;
  /** ClassificationPanel sets chat "generating" around the start POST; Graph auto-update does not. */
  trackChatGenerating?: boolean;
};

/**
 * Shared reset → hints → startWorkflow → cleanup for Cell/Tissue classification updates.
 * Does not build the payload (OvR / class_operations stay at the call site).
 */
export async function prepareAndStartClassificationWorkflow(
  options: StartClassificationWorkflowOptions
): Promise<void> {
  const {
    dispatch,
    startWorkflow,
    payload,
    refreshTissuePatches,
    trackChatGenerating = false,
  } = options;

  await resetWorkflowBeforeStart(dispatch);
  if (trackChatGenerating) {
    dispatch(setIsChatGenerating(true));
  }
  dispatch(setWorkflowCompletionHints({ refreshTissuePatches }));

  try {
    await startWorkflow(payload);
    if (trackChatGenerating) {
      dispatch(setIsChatGenerating(false));
    }
  } catch (error) {
    eventBus.emit("workflow-graph-run-aborted");
    if (trackChatGenerating) {
      dispatch(setIsChatGenerating(false));
    }
    dispatch(setIsRunning(false));
    dispatch(clearWorkflowCompletionHints());
    throw error;
  }
}

/** Pending rename/add ops from classification panels, for Graph-owned auto-update. */
export type PendingClassOperations = {
  renames: Array<{ from: string; to: string }>;
  adds: Array<{ name: string; color?: string }>;
};

type OpsProvider = () => PendingClassOperations;

let nucleiOpsProvider: OpsProvider | null = null;
let patchOpsProvider: OpsProvider | null = null;
let nucleiClear: (() => void) | null = null;
let patchClear: (() => void) | null = null;

export function registerNucleiClassOperationsBridge(
  provider: OpsProvider | null,
  clear?: (() => void) | null
): void {
  nucleiOpsProvider = provider;
  nucleiClear = clear ?? null;
}

export function registerPatchClassOperationsBridge(
  provider: OpsProvider | null,
  clear?: (() => void) | null
): void {
  patchOpsProvider = provider;
  patchClear = clear ?? null;
}

/** Normalize/filter pending rename+add ops (shared by panels and Graph auto-update). */
export function normalizePendingClassOperations(
  ops: PendingClassOperations | null | undefined
): PendingClassOperations | null {
  if (!ops) return null;
  const renames = (ops.renames || [])
    .map((op) => ({ from: String(op.from || "").trim(), to: String(op.to || "").trim() }))
    .filter((op) => op.from && op.to && op.from !== op.to);
  const adds = (ops.adds || [])
    .map((op) => ({ name: String(op.name || "").trim(), color: op.color }))
    .filter((op) => op.name);
  if (!renames.length && !adds.length) return null;
  return { renames, adds };
}

export function peekNucleiClassOperations(): PendingClassOperations | null {
  return normalizePendingClassOperations(nucleiOpsProvider?.() ?? null);
}

export function peekPatchClassOperations(): PendingClassOperations | null {
  return normalizePendingClassOperations(patchOpsProvider?.() ?? null);
}

export function clearNucleiClassOperations(): void {
  nucleiClear?.();
}

export function clearPatchClassOperations(): void {
  patchClear?.();
}

/** Minimal args for coalesced auto-update; Graph builds the full start payload. */
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
        eventBus.emit("trigger-nuclei-update", {
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
        eventBus.emit("trigger-patch-update", {
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
  eventBus.on("workflow-graph-run-finished", flushCoalescedWorkflowFollowupsAfterRun);
  eventBus.on("workflow-graph-run-aborted", flushCoalescedWorkflowFollowupsAfterRun);
}

/**
 * Nuclei: if a workflow is already running, defer a single follow-up; otherwise emit
 * `trigger-nuclei-update` for WorkflowGraph to start the same classification update path.
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
    eventBus.emit("trigger-nuclei-update", {
      zarrPath: params.zarrPath,
      source: params.source ?? "coalesced-nuclei",
    });
    return;
  }

  pendingCoalescedNucleiClassification = true;
}

/**
 * Patch/tissue: same coalescing as nuclei, emits `trigger-patch-update` for WorkflowGraph.
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
    eventBus.emit("trigger-patch-update", {
      zarrPath: params.zarrPath,
      source: params.source ?? "coalesced-patch",
    });
    return;
  }

  pendingCoalescedPatchClassification = true;
}

/**
 * Race-free injection of classifier save paths into a start_workflow payload.
 * Used so kickoff can emit synchronously without waiting for panel sync effects.
 */
export type ClassifierSaveInjectOptions = {
  /** One-vs-rest: { className: absolutePath } */
  ovrSavePaths?: Record<string, string> | null;
  /** Single-file save destination */
  saveClassifierPath?: string | null;
  /** When false, force-clear save_classifier_path (matches Redux updateClassifier). */
  updateClassifier?: boolean;
};

export function injectClassifierSaveIntoPayload(
  payload: Record<string, any>,
  options: ClassifierSaveInjectOptions
): Record<string, any> {
  const ovr = options.ovrSavePaths;
  if (ovr && Object.keys(ovr).length > 0) {
    for (const key of Object.keys(payload)) {
      if (key.startsWith("step") && payload[key]?.input) {
        payload[key].input.classifier_mode = "one-vs-rest";
        payload[key].input.save_classifier_paths = JSON.stringify(ovr);
      }
    }
  }

  const single = options.saveClassifierPath?.trim();
  if (single) {
    for (const key of Object.keys(payload)) {
      if (key.startsWith("step") && payload[key]?.input) {
        payload[key].input.save_classifier_path = single;
      }
    }
  }

  if (options.updateClassifier === false) {
    for (const key of Object.keys(payload)) {
      if (key.startsWith("step") && payload[key]?.input) {
        payload[key].input.save_classifier_path = null;
        // The per-class OvR map is a save destination too, and it reaches the
        // payload straight from panel.content — without dropping it here, "don't
        // update the classifier" still let every annotation retrain and overwrite
        // each .tlcls.
        delete payload[key].input.save_classifier_paths;
      }
    }
  }

  return payload;
}
