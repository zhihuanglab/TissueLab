import { WorkflowPanel, ContentItem } from "@/store/slices/workflowSlice";

export interface ClassificationPromptContent {
  organ_type: string;
  nuclei_classes?: string[];
}

export interface PanelConfig {
  title: string;
  defaultContent: ContentItem[];
  defaultType: WorkflowPanel["type"];
}

export interface EditPanelDialogProps {
  panel: WorkflowPanel;
  onSave: (updatedPanel: WorkflowPanel) => void;
}

export interface PanelActionButtonsProps {
  panel: WorkflowPanel;
  onContentChange: (id: string, updatedPanel: WorkflowPanel) => void;
  onDelete: (id: string) => void;
  onShowLogs?: () => void;
  logMetadata?: { logPath?: string; envName?: string; port?: number };
}

export interface ContentRendererProps {
  item: ContentItem;
  onChange: (value: string) => void;
}

export interface CustomPromptFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export interface ClassificationPanelContentProps {
  panel: WorkflowPanel;
  onContentChange: (id: string, updatedPanel: WorkflowPanel) => void;
}

export interface PatchClassificationPanelProps {
  panel: WorkflowPanel;
  onContentChange: (id: string, updatedPanel: WorkflowPanel) => void;
}

export interface CoordinateBoxProps {
  x1: string;
  y1: string;
  x2: string;
  y2: string;
  onX1Change: (value: string) => void;
  onY1Change: (value: string) => void;
  onX2Change: (value: string) => void;
  onY2Change: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
}

export interface SortablePanelProps {
  panel: WorkflowPanel;
  onContentChange: (id: string, updatedPanel: WorkflowPanel) => void;
  onDelete: (id: string) => void;
  nodeStatus?: Record<string, number>;
  nodePortsInfo?: Record<string, { port: number, running: boolean }>;
  className?: string;
  h5Path?: string;
  logMetadata?: { logPath?: string; envName?: string; port?: number };
  onShowLogs?: (panelId: string) => void;
}

export interface WorkflowStatusSummaryProps {
  panels: WorkflowPanel[];
  nodeStatus: Record<string, number>;
  nodeProgress?: Record<string, number>;
  setNodeStatus: (nodeStatus: Record<string, number>) => void;
  onStopWorkflow?: () => void;
  h5Path?: string;
} 