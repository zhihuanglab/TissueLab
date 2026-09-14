import { WorkflowPanel, ContentItem } from "@/store/slices/chat/workflowSlice";

export interface PanelConfig {
  title: string;
  defaultContent: ContentItem[];
  defaultType: WorkflowPanel["type"];
}

export interface ContentRendererProps {
  item: ContentItem;
  onChange: (value: string | any[]) => void;
}

export interface CustomPromptFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export interface ClassificationPanelProps {
  panel: WorkflowPanel;
  onContentChange: (id: string, updatedPanel: WorkflowPanel) => void;
  /** "cell" (default — NuClass) or "patch" (VISTA active-learning panels). */
  terminology?: "cell" | "patch";
  /** When true, omit the right-hand active-learning review panel (VISTA). */
  hideReviewPanel?: boolean;
  /**
   * Workflow graph: required `start_workflow` (opens get_status SSE) so NuClass /
   * patch runs stay wired to runtime progress like the main Run button.
   */
  graphStartWorkflow?: (payload: Record<string, unknown>) => Promise<unknown>;
  /** Per-classifier strategy: one softmax head ("multiclass") vs N independent
   *  one-vs-rest binaries ("one-vs-rest"). Sent to the tasknode as `classifier_mode`. */
  classifierMode?: "multiclass" | "one-vs-rest";
  /** One-vs-rest: open the classifier Load dialog bound to a single cell type so
   *  the chosen .tlcls is attached to just that class (not the node's single model). */
  onOvrLoadClass?: (className: string) => void;
  /** Workflow graph: also drop `node.loadedClassifier` when the banner's clear
   *  button runs, so the dock's "Loaded: …" chip disappears with the banner. */
  onClearLoadedClassifier?: () => void;
}

export interface PatchClassificationPanelProps {
  panel: WorkflowPanel;
  onContentChange: (id: string, updatedPanel: WorkflowPanel) => void;
  /** Backend node id of the active patch classifier (MuskClassification /
   *  HOptimusClassification / VirchowClassification). The "Update" run is
   *  routed to this node; defaults to MUSK when absent. */
  modelId?: string;
  /** When true (VISTA reuses this panel), Reset also clears the downstream
   *  Tissue-Segmentation group in addition to the patch classification. */
  clearTissueSegmentationOnReset?: boolean;
  /**
   * Workflow graph: required `start_workflow` (opens get_status SSE) so Tissue Update
   * stays wired to the same SSE owner as Run.
   */
  graphStartWorkflow?: (payload: Record<string, unknown>) => Promise<unknown>;
  /** OvR vs multiclass toggle (mirrors the cell panel). Drives classifier_mode +
   *  per-class save_classifier_paths in the run payload. */
  classifierMode?: "multiclass" | "one-vs-rest";
  /** OvR: open the Load dialog bound to a specific class (per-class .tlcls attach). */
  onOvrLoadClass?: (className: string) => void;
  /** Workflow graph: also drop `node.loadedClassifier` when the banner's clear
   *  button runs, so the dock's "Loaded: …" chip disappears with the banner. */
  onClearLoadedClassifier?: () => void;
}
