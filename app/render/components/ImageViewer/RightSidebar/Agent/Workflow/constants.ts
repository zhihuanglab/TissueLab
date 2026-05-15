import { PanelConfig } from "@/components/imageViewer/RightSidebar/Agent/Workflow/types";
import { ContentItem } from "@/store/slices/chat/workflowSlice";

export const getContentStringValue = (content: ContentItem[], key: string): string | null => {
  const value = content.find(item => item.key === key)?.value;
  return typeof value === "string" ? value : null;
};

/** True when graph / Load dialog set a non-empty display label (guards file-browser sync from wiping loaded paths). */
export const hasClassifierDisplayOverride = (content: ContentItem[]): boolean => {
  const v = getContentStringValue(content, "classifier_display_name");
  return v != null && v.trim() !== "";
};

export const removeClassifierPathContent = (content: ContentItem[]): ContentItem[] =>
  content.filter(
    (item) =>
      item.key !== "classifier_path" &&
      item.key !== "save_classifier_path" &&
      item.key !== "classifier_download_link"
  );

export const upsertContentStringValue = (
  content: ContentItem[],
  key: string,
  value: string
): ContentItem[] => {
  const index = content.findIndex(item => item.key === key);
  if (index > -1) {
    return content.map((item, itemIndex) => itemIndex === index ? { ...item, value } : item);
  }
  return [...content, { key, type: "input", value }];
};

export const panelMap: Record<string, PanelConfig> = {
    TissueClassify: {
      title: "Tissue Classification",
      defaultContent: [{ key: "prompt", type: "input", value: "" }],
      defaultType: "MuskClassification"
    },
    TissueSeg: {
      title: "Tissue Segmentation",
      defaultContent: [
        { key: "patch_size", type: "input", value: "" },
        { key: "level", type: "input", value: "" },
        { key: "tissue_threshold", type: "input", value: "" },
        { key: "batch_size", type: "input", value: "" },
      ],
      defaultType: "MuskEmbedding"
    },
    NucleiSeg: {
      title: "Cell Segmentation + Embedding",
      defaultContent: [
        { key: "prompt", type: "input", value: "" },
        { key: "target_mpp", type: "input", value: "", label: "Target MPP (µm/pixel)", placeholder: "e.g. 0.25" }
      ],
      defaultType: "SegmentationNode"
    },
    CodingAgent: {
      title: "Coding Agent",
      defaultContent: [
        { key: "prompt", type: "input", value: "" },
        { key: "script_run_policy", type: "input", value: "auto_bypass" },
        { key: "script_last_run_digest", type: "input", value: "" },
        { key: "script_last_run_raw", type: "input", value: "" },
        { key: "script_last_run_output", type: "input", value: "" },
      ],
      defaultType: "GPT-4o Agent"
    },
    NucleiClassify: {
      title: "Nuclei Classification",
      defaultContent: [{ key: "prompt", type: "input", value: "" }],
      defaultType: "ClassificationNode"
    },
    TaskSpecific: {
      title: "Task Specific Analysis",
      defaultContent: [{ key: "prompt", type: "input", value: "" }],
      defaultType: "Ark"
    },
    SpatialOmics: {
      title: "Spatial Omics Analysis",
      defaultContent: [{ key: "prompt", type: "input", value: "" }],
      defaultType: "CellCharter"
    }
  };

  export const MODEL_DEPENDENCIES: Record<string, {
    childPanelKey: string;
    childType: string;
    buttonLabel: string;
    defaultContent?: ContentItem[];
  }> = {
    MuskEmbedding: {
      childPanelKey: 'TissueClassify',
      childType: 'MuskClassification',
      buttonLabel: 'Import Classification',
    },
    MuskClassification: {
      childPanelKey: 'TissueSeg',
      childType: 'VISTA',
      buttonLabel: 'Import VISTA',
      defaultContent: [{ key: 'tissue_class', type: 'input', value: '' }],
    },
  };

  // Reverse lookup: child type → parent info (derived from MODEL_DEPENDENCIES)
  export const CHILD_TO_PARENT: Record<string, { parentType: string; parentPanelKey: string }> =
    Object.entries(MODEL_DEPENDENCIES).reduce((acc, [parentType, dep]) => {
      // Find the panelMap key whose defaultType matches parentType
      const parentPanelKey = Object.keys(panelMap).find(k => panelMap[k].defaultType === parentType) || '';
      acc[dep.childType] = { parentType, parentPanelKey };
      return acc;
    }, {} as Record<string, { parentType: string; parentPanelKey: string }>);

  export const cellTypeOptions = [
    'Adipocytes (Fat Cells)',
    'Astrocytes',
    'Basophils',
    'Cellular Debris',
    'Eosinophils',
    'Endothelial Cells',
    'Epithelial Cells',
    'Fibrin',
    'Fibroblasts',
    'Hemorrhage',
    'Lymphocytes',
    'Macrophages',
    'Mast Cells',
    'Microglia',
    'Neoplastic Cells',
    'Neurons',
    'Necrosis',
    'Neutrophils',
    'Oligodendrocytes',
    'Plasma Cells',
    'Smooth Muscle Cells',
    'Stromal Reaction (Desmoplasia)',
    'Tumor'
  ]; 
