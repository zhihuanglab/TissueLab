import { createSlice, PayloadAction } from '@reduxjs/toolkit';

const sameNumberRecord = (a: Record<string, number>, b: Record<string, number>) => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
};

const sameStageProgressRecord = (
  a: Record<string, Record<string, number>>,
  b: Record<string, Record<string, number>>
) => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const aInner = a[key] || {};
    const bInner = b[key] || {};
    if (!sameNumberRecord(aInner, bInner)) return false;
  }
  return true;
};

// Types
export type ContentItem = {
  key: string;
  type: string;
  value: string | any[];
  label?: string;
  placeholder?: string;
};

export type WorkflowPanel = {
  id: string;
  title: string;
  type: string;
  progress: number;
  content: ContentItem[];
  ui?: Record<string, any> | null;
  stepName?: string; // Step name from workflow (e.g., "NucleiSeg", "NucleiClassify") for factory matching
};

/** Viewer toolbar overlay toggles captured at `workflow-graph-run-start`, restored on finish/abort. */
export type GraphWorkflowOverlaySnapshot = {
  showBackendAnnotations: boolean;
  showPatches: boolean;
  showMask: boolean;
  showUserAnnotations: boolean;
};

// This will be imported and used by the component directly
import { panelMap } from '@/components/imageViewer/RightSidebar/Agent/Workflow/constants'

export const generatePanelsFromWorkflow = (workflow: any[]): WorkflowPanel[] => {
  return workflow.map((step: any) => {
    const panelConfig = panelMap[step.model];
    const joinedValue = Array.isArray(step.input) ? step.input.join(", ") : step.input;
    
    return {
      id: step.step.toString(),
      title: panelConfig.title,
      type: (step.impl && typeof step.impl === 'string' && step.impl.trim()) ? step.impl : (step.type || panelConfig.defaultType),
      progress: 0,
      content: panelConfig.defaultContent.map((contentItem) => ({
        ...contentItem,
        value: joinedValue,
      })),
      ui: (step?.ui && typeof step.ui === 'object') ? step.ui : null,
      stepName: step.model, // Save step name (e.g., "NucleiSeg") for factory matching
    };
  });
};

type WorkflowState = {
  panels: WorkflowPanel[];
  nodeStatus: Record<string, number>; // 0=not started, 1=running, 2=complete, -1=failed, -2=stopped
  nodePorts: Record<string, { port: number; running: boolean }>;
  isRunning: boolean;
  // Store the highest progress value for each node type
  highestProgress: Record<string, number>;
  // Store current progress for each node (0-100)
  nodeProgress: Record<string, number>;
  /**
   * Per-backend-node sub-stage progress (segmentation / embedding / …), same shape as
   * POST /workflow_stage_status `stage_progress`; streamed over SSE so the graph need not poll.
   */
  workflowStageProgress: Record<string, Record<string, number>>;
  nodeLogsMeta: Record<string, { logPath?: string; envName?: string; port?: number }>;
  updateAfterEveryAnnotation: boolean;
  currentOrgan: string | null;
  updatePatchAfterEveryAnnotation: boolean;
  patchClassifierPath: string | null;
  patchClassifierSavePath: string | null;
  // Queue status
  workflowStatus: 'idle' | 'queued' | 'running' | 'completed' | 'error';
  queuePosition: number;
  queueTotal: number;
  updateClassifier: boolean;
  // Workflow output path (the .zarr file path)
  outputPath: string;
  // Current running workflow execution ID (for isolation)
  runningExecutionId: string | null;
  // Zarr path of the workflow that is currently running/queued (so UI shows correct filename after refresh or image switch)
  runningWorkflowZarrPath: string | null;
  // Mapping: execution_id -> workflow identifier (selectedHistoryId or null for current panels)
  executionToWorkflowIdMap: Record<string, string | null>;
  // Whether initial workflow restore check has completed in current app session
  hasCheckedInitialRestore: boolean;
  /** Set before start_workflow so completion handlers can refresh patches / UI for graph runs */
  completionHints: { refreshTissuePatches: boolean } | null;
  /**
   * Viewer overlay toggles at `workflow-graph-run-start`; consumed on `workflow-graph-run-finished` / abort.
   * Redux survives ref timing / instance edge cases; null = no pending restore.
   */
  pendingGraphOverlayRestore: GraphWorkflowOverlaySnapshot | null;
};

const initialState: WorkflowState = {
  panels: [],
  nodeStatus: {},
  nodePorts: {},
  isRunning: false,
  highestProgress: {},
  nodeProgress: {},
  workflowStageProgress: {},
  nodeLogsMeta: {},
  updateAfterEveryAnnotation: false,
  currentOrgan: null,
  updatePatchAfterEveryAnnotation: true,
  patchClassifierPath: null,
  patchClassifierSavePath: null,
  // Queue status
  workflowStatus: 'idle',
  queuePosition: 0,
  queueTotal: 0,
  updateClassifier: false,
  // Workflow output path
  outputPath: '',
  // Current running workflow execution ID
  runningExecutionId: null,
  // Zarr path of the workflow currently running/queued (for status display)
  runningWorkflowZarrPath: null,
  // Execution to workflow ID mapping
  executionToWorkflowIdMap: {},
  hasCheckedInitialRestore: false,
  completionHints: null,
  pendingGraphOverlayRestore: null,
};

const workflowSlice = createSlice({
  name: 'workflow',
  initialState,
  reducers: {
    // Set the entire panels array
    setPanels: (state, action: PayloadAction<WorkflowPanel[]>) => {
      state.panels = action.payload;
    },

    // Initialize panels from workflow config
    initPanelsFromWorkflow: (state, action: PayloadAction<{ workflow: any[]; formattedPath: string }>) => {
      const { workflow, formattedPath } = action.payload;
      if (!workflow || !workflow.length) return;

      state.panels = generatePanelsFromWorkflow(workflow).map((panel: WorkflowPanel) => ({
        ...panel,
        content: panel.type !== 'CodingAgent' && !panel.content.some((item: ContentItem) => item.key === 'path')
          ? [...panel.content, { key: 'path', type: 'input', value: formattedPath ?? "" }]
          : panel.content
      }));
    },

    // Update a specific panel
    updatePanel: (state, action: PayloadAction<{ id: string; updatedPanel: WorkflowPanel }>) => {
      const { id, updatedPanel } = action.payload;
      const index = state.panels.findIndex(panel => panel.id === id);
      if (index !== -1) {
        state.panels[index] = updatedPanel;
      }
    },

    // Delete a panel
    deletePanel: (state, action: PayloadAction<string>) => {
      state.panels = state.panels.filter(panel => panel.id !== action.payload)
        .map((panel, index) => ({
          ...panel,
          id: (index + 1).toString(),
        }));
    },

    // Add a new panel
    addPanel: (state, action: PayloadAction<WorkflowPanel>) => {
      state.panels.push(action.payload);
    },

    // Reorder panels
    reorderPanels: (state, action: PayloadAction<{ oldIndex: number; newIndex: number }>) => {
      const { oldIndex, newIndex } = action.payload;
      const panel = state.panels[oldIndex];
      
      // Remove from old position
      state.panels.splice(oldIndex, 1);
      
      // Insert at new position
      state.panels.splice(newIndex, 0, panel);
      
      // Update IDs to reflect new order
      state.panels = state.panels.map((p, i) => ({
        ...p,
        id: (i + 1).toString(),
      }));
    },

    // Update node status
    setNodeStatus: (state, action: PayloadAction<Record<string, number>>) => {
      if (sameNumberRecord(state.nodeStatus, action.payload)) return;
      state.nodeStatus = action.payload;
    },

    // Update node ports
    setNodePorts: (state, action: PayloadAction<Record<string, { port: number; running: boolean }>>) => {
      state.nodePorts = action.payload;
    },

    setNodeLogsMeta: (state, action: PayloadAction<Record<string, { logPath?: string; envName?: string; port?: number }>>) => {
      state.nodeLogsMeta = action.payload;
    },

    // Set workflow running state
    setIsRunning: (state, action: PayloadAction<boolean>) => {
      state.isRunning = action.payload;
    },

    // Reset only the workflow status information while preserving panels and log metadata
    resetWorkflowStatus: (state) => {
      state.nodeStatus = {};
      // Don't clear nodePorts - they are static node information and shouldn't be reset
      // state.nodePorts = {};
      // Don't clear nodeLogsMeta - static node info (log paths, ports) and needed for viewing logs after cancellation
      // state.nodeLogsMeta = {};
      state.isRunning = false;
      state.highestProgress = {};
      state.nodeProgress = {};
      state.workflowStageProgress = {};
      state.runningWorkflowZarrPath = null;
      state.completionHints = null;
      // Avoid stale execution_id + workflowId map causing SSE handlers to drop all frames until refs catch up.
      state.runningExecutionId = null;
      state.executionToWorkflowIdMap = {};
      state.pendingGraphOverlayRestore = null;
    },

    // Keep the original resetWorkflow for complete resets when needed
    resetWorkflow: (state) => {
      state.panels = [];
      state.nodeStatus = {};
      state.nodePorts = {};
      state.isRunning = false;
      state.highestProgress = {};
      state.nodeProgress = {};
      state.workflowStageProgress = {};
      state.nodeLogsMeta = {};
      state.pendingGraphOverlayRestore = null;
    },

    setPendingGraphOverlayRestore: (state, action: PayloadAction<GraphWorkflowOverlaySnapshot | null>) => {
      state.pendingGraphOverlayRestore = action.payload;
    },

    // Add this new reducer
    setNodeHighestProgress: (state, action: PayloadAction<{ nodeType: string; progress: number }>) => {
      const { nodeType, progress } = action.payload;
      // Only update if new progress is higher than stored progress
      if (!state.highestProgress[nodeType] || progress > state.highestProgress[nodeType]) {
        state.highestProgress[nodeType] = progress;
      } else if (progress == -1) {
        state.highestProgress[nodeType] = 0;
      }
    },

    // Set node progress
    setNodeProgress: (state, action: PayloadAction<Record<string, number>>) => {
      if (sameNumberRecord(state.nodeProgress, action.payload)) return;
      state.nodeProgress = action.payload;
    },

    setWorkflowStageProgress: (state, action: PayloadAction<Record<string, Record<string, number>>>) => {
      // Shallow-merge by node key so a frame that omits some models does not wipe others.
      const merged = { ...state.workflowStageProgress, ...action.payload };
      if (sameStageProgressRecord(state.workflowStageProgress, merged)) return;
      state.workflowStageProgress = merged;
    },

    setUpdateAfterEveryAnnotation: (state, action: PayloadAction<boolean>) => {
      state.updateAfterEveryAnnotation = action.payload;
    },

    setUpdatePatchAfterEveryAnnotation: (state, action: PayloadAction<boolean>) => {
      state.updatePatchAfterEveryAnnotation = action.payload;
    },

    setPatchClassifierPath: (state, action: PayloadAction<string | null>) => {
      state.patchClassifierPath = action.payload;
    },

    setPatchClassifierSavePath: (state, action: PayloadAction<string | null>) => {
      state.patchClassifierSavePath = action.payload;
    },

    setUpdateClassifier: (state, action: PayloadAction<boolean>) => {
      state.updateClassifier = action.payload;
    },

    // Added reducer for currentOrgan
    setCurrentOrgan: (state, action: PayloadAction<string | null>) => {
      state.currentOrgan = action.payload;
    },

    // Queue status reducers
    setWorkflowStatus: (state, action: PayloadAction<'idle' | 'queued' | 'running' | 'completed' | 'error'>) => {
      state.workflowStatus = action.payload;
    },

    setQueuePosition: (state, action: PayloadAction<number>) => {
      state.queuePosition = action.payload;
    },

    setQueueTotal: (state, action: PayloadAction<number>) => {
      state.queueTotal = action.payload;
    },

    setQueueStatus: (state, action: PayloadAction<{ position: number; total: number }>) => {
      state.queuePosition = action.payload.position;
      state.queueTotal = action.payload.total;
    },

    setOutputPath: (state, action: PayloadAction<string>) => {
      state.outputPath = action.payload;
    },

    // Set the current running workflow execution ID
    setRunningExecutionId: (state, action: PayloadAction<string | null>) => {
      state.runningExecutionId = action.payload;
    },

    // Set zarr path of the workflow currently running/queued (for status display after refresh or image switch)
    setRunningWorkflowZarrPath: (state, action: PayloadAction<string | null>) => {
      state.runningWorkflowZarrPath = action.payload;
    },

    // Set execution to workflow ID mapping
    setExecutionToWorkflowIdMap: (state, action: PayloadAction<Record<string, string | null>>) => {
      state.executionToWorkflowIdMap = action.payload;
    },

    setHasCheckedInitialRestore: (state, action: PayloadAction<boolean>) => {
      state.hasCheckedInitialRestore = action.payload;
    },

    // Update execution to workflow ID mapping (add or update a single entry)
    updateExecutionToWorkflowIdMap: (state, action: PayloadAction<{ executionId: string; workflowId: string | null }>) => {
      state.executionToWorkflowIdMap[action.payload.executionId] = action.payload.workflowId;
    },

    // Remove execution from workflow ID mapping
    removeExecutionFromWorkflowIdMap: (state, action: PayloadAction<string>) => {
      const { [action.payload]: _, ...rest } = state.executionToWorkflowIdMap;
      state.executionToWorkflowIdMap = rest;
    },

    setWorkflowCompletionHints: (state, action: PayloadAction<{ refreshTissuePatches: boolean }>) => {
      state.completionHints = action.payload;
    },

    clearWorkflowCompletionHints: (state) => {
      state.completionHints = null;
    },
  },
});

export const {
  setPanels,
  initPanelsFromWorkflow,
  updatePanel,
  deletePanel,
  addPanel,
  reorderPanels,
  setNodeStatus,
  setNodePorts,
  setNodeLogsMeta,
  setIsRunning,
  resetWorkflow,
  resetWorkflowStatus,
  setNodeHighestProgress,
  setNodeProgress,
  setWorkflowStageProgress,
  setUpdateAfterEveryAnnotation,
  setCurrentOrgan,
  setUpdatePatchAfterEveryAnnotation,
  setPatchClassifierPath,
  setPatchClassifierSavePath,
  setWorkflowStatus,
  setQueuePosition,
  setQueueTotal,
  setQueueStatus,
  setUpdateClassifier,
  setOutputPath,
  setRunningExecutionId,
  setRunningWorkflowZarrPath,
  setExecutionToWorkflowIdMap,
  setHasCheckedInitialRestore,
  updateExecutionToWorkflowIdMap,
  removeExecutionFromWorkflowIdMap,
  setWorkflowCompletionHints,
  clearWorkflowCompletionHints,
  setPendingGraphOverlayRestore,
} = workflowSlice.actions;

export default workflowSlice.reducer; 