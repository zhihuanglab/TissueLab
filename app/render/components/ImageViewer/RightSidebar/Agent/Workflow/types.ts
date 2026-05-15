import { WorkflowPanel, ContentItem } from "@/store/slices/chat/workflowSlice";

export interface ClassificationPromptContent {
  organ_type: string;
  nuclei_classes?: string[];
}

export interface PanelConfig {
  title: string;
  defaultContent: ContentItem[];
  defaultType: WorkflowPanel["type"];
}

// EditPanelDialogProps was used by the removed EditPanelDialog; replaced by VisualSchemaEditorDialog

export interface PanelActionButtonsProps {
  panel: WorkflowPanel;
  onContentChange: (id: string, updatedPanel: WorkflowPanel) => void;
  onDelete: (id: string) => void;
  onShowLogs?: () => void;
  logMetadata?: { logPath?: string; envName?: string; port?: number };
  compact?: boolean;
  /** Show Edit button in ellipsis dropdown (above Delete); onEditClick is called when clicked */
  showEditButton?: boolean;
  onEditClick?: () => void;
}

export interface ContentRendererProps {
  item: ContentItem;
  onChange: (value: string | any[]) => void;
}

export interface CustomPromptFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export interface ClassificationPanelContentProps {
  panel: WorkflowPanel;
  onContentChange: (id: string, updatedPanel: WorkflowPanel) => void;
  /** "cell" (default — NuClass) or "patch" (VISTA active-learning panels). */
  terminology?: "cell" | "patch";
  /** When true, omit the right-hand active-learning review panel (VISTA). */
  hideReviewPanel?: boolean;
  /**
   * Workflow graph: use hook-based `start_workflow` (opens get_status SSE) instead of a bare
   * `apiFetch`, so NuClass / patch runs stay wired to runtime progress like the main Run button.
   */
  graphStartWorkflow?: (payload: Record<string, unknown>) => Promise<unknown>;
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
  nodeProgress?: Record<string, number>;
  nodePortsInfo?: Record<string, { port: number, running: boolean }>;
  className?: string;
  zarrPath?: string;
  logMetadata?: { logPath?: string; envName?: string; port?: number };
  onShowLogs?: (panelId: string) => void;
  collapsed?: boolean;
}

export interface WorkflowStatusSummaryProps {
  panels: WorkflowPanel[];
  nodeStatus: Record<string, number>;
  nodeProgress?: Record<string, number>;
  setNodeStatus: (nodeStatus: Record<string, number>) => void;
  zarrPath?: string;
  workflowStatus?: 'idle' | 'queued' | 'running' | 'completed' | 'error';
  queuePosition?: number;
  queueTotal?: number;
  onCancel?: () => void;
} 