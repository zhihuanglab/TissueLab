import { createSlice, PayloadAction } from '@reduxjs/toolkit';

// Types
export type ContentItem = {
  key: string;
  type: string;
  value: string;
  label?: string;
  placeholder?: string;
};

export type WorkflowPanel = {
  id: string;
  title: string;
  type: string;
  progress: number;
  content: ContentItem[];
};

// This will be imported and used by the component directly
import { panelMap } from '@/components/ImageViewer/Sidebar/Chat/Workflow/constants'

export const generatePanelsFromWorkflow = (workflow: any[]): WorkflowPanel[] => {
  return workflow.map((step: any) => {
    const panelConfig = panelMap[step.model];
    return {
      id: step.step.toString(),
      title: panelConfig.title,
      type: (step.impl && typeof step.impl === 'string' && step.impl.trim()) ? step.impl : (step.type || panelConfig.defaultType),
      progress: 0,
      content: panelConfig.defaultContent.map((contentItem) => ({
        ...contentItem,
        value: Array.isArray(step.input) ? step.input.join(", ") : step.input,
      })),
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
  nodeLogsMeta: Record<string, { logPath?: string; envName?: string; port?: number }>;
  updateAfterEveryAnnotation: boolean;
  currentOrgan: string | null;
  updatePatchAfterEveryAnnotation: boolean;
  patchClassifierPath: string | null;
  patchClassifierSavePath: string | null;
  updateClassifier: boolean;
};

const initialState: WorkflowState = {
  panels: [],
  nodeStatus: {},
  nodePorts: {},
  isRunning: false,
  highestProgress: {},
  nodeProgress: {},
  nodeLogsMeta: {},
  updateAfterEveryAnnotation: false,
  currentOrgan: null,
  updatePatchAfterEveryAnnotation: false,
  patchClassifierPath: null,
  patchClassifierSavePath: null,
  updateClassifier: false,
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
        content: panel.type !== 'Scripts' && !panel.content.some((item: ContentItem) => item.key === 'path')
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

    // Reset only the workflow status information while preserving panels
    resetWorkflowStatus: (state) => {
      state.nodeStatus = {};
      state.nodePorts = {};
      state.isRunning = false;
      state.highestProgress = {};
      state.nodeProgress = {};
      state.nodeLogsMeta = {};
    },

    // Keep the original resetWorkflow for complete resets when needed
    resetWorkflow: (state) => {
      state.panels = [];
      state.nodeStatus = {};
      state.nodePorts = {};
      state.isRunning = false;
      state.highestProgress = {};
      state.nodeProgress = {};
      state.nodeLogsMeta = {};
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
      state.nodeProgress = action.payload;
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
  setUpdateAfterEveryAnnotation,
  setCurrentOrgan,
  setUpdatePatchAfterEveryAnnotation,
  setPatchClassifierPath,
  setPatchClassifierSavePath,
  setUpdateClassifier,
} = workflowSlice.actions;

export default workflowSlice.reducer; 