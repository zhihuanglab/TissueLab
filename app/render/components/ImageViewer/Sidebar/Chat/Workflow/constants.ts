import { PanelConfig } from "./types";

export const panelMap: Record<string, PanelConfig> = {
  TissueClassify: {
    title: "Tissue Classification",
    defaultContent: [
      { key: "prompt", type: "input", value: "" },
    ],
    defaultType: "MuskClassification"
  },
  TissueSeg: {
    title: "Tissue Segmentation",
    defaultContent: [
      { key: "patch_size", type: "input", value: "128" },
      { key: "level", type: "input", value: "1" },
      { key: "tissue_threshold", type: "input", value: "0.1" },
      { key: "batch_size", type: "input", value: "4" },
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
  Scripts: {
    title: "Code Calculation",
    defaultContent: [{ key: "prompt", type: "input", value: "" }],
    defaultType: "Scripts"
  },
  NucleiClassify: {
    title: "Nuclei Classification",
    defaultContent: [{ key: "prompt", type: "input", value: "" }],
    defaultType: "ClassificationNode"
  }
};

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
