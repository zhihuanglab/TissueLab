import { PanelConfig } from "@/types/workflow.types";
import { ContentItem } from "@/store/slices/chat/workflowSlice";

export const panelMap: Record<string, PanelConfig> = {
    TissueClassify: {
      title: "Tissue Classification",
      defaultContent: [{ key: "prompt", type: "input", value: "" }],
      defaultType: "MuskClassification"
    },
    TissueSeg: {
      title: "Tissue Segmentation",
      // Patch-embedding params are the SAME for every model in this factory
      // (MUSK / H-optimus-0 / Virchow …) — one shared default set. Values match
      // the backend task-node defaults so the form shows them filled and
      // editable instead of blank.
      defaultContent: [
        { key: "patch_size", type: "input", value: "224", label: "Patch size (px)", placeholder: "e.g. 224" },
        { key: "level", type: "input", value: "0", label: "Level", placeholder: "0 = full resolution" },
        { key: "tissue_threshold", type: "input", value: "0.1", label: "Tissue threshold", placeholder: "0–1, e.g. 0.1" },
        { key: "batch_size", type: "input", value: "2", label: "Batch size", placeholder: "e.g. 2", readOnly: true },
      ],
      defaultType: "MuskEmbedding"
    },
    NucleiSeg: {
      title: "Cell Segmentation + Embedding",
      defaultContent: [
        { key: "prompt", type: "input", value: "" },
        { key: "target_mpp", type: "input", value: "", label: "Target MPP (µm/pixel)", placeholder: "e.g. 0.25" }
      ],
      defaultType: "CellCast"
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
      defaultType: "NuClass"
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

  // Parent `modelId` → child panel info. Two canonical model dependencies:
  //   MuskEmbedding (TissueSeg panel) → MuskClassification (TissueClassify panel)
  //   CellCast      (NucleiSeg panel) → NuClass            (NucleiClassify panel)
  // Used by the bottom-dock "Run all" runner via CHILD_TO_PARENT to synthesize the
  // prerequisite panel (cell seg + embedding live on a separate backend node).
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
    HOptimusEmbedding: {
      childPanelKey: 'TissueClassify',
      childType: 'HOptimusClassification',
      buttonLabel: 'Import Classification',
    },
    VirchowEmbedding: {
      childPanelKey: 'TissueClassify',
      childType: 'VirchowClassification',
      buttonLabel: 'Import Classification',
    },
    CellCast: {
      childPanelKey: 'NucleiClassify',
      childType: 'NuClass',
      buttonLabel: 'Import Cell Classification',
    },
    // CytoformerClassification needs Cytoformer seg + H-optimus-0 embeddings (not CellCast/PLIP).
    Cytoformer: {
      childPanelKey: 'NucleiClassify',
      childType: 'CytoformerClassification',
      buttonLabel: 'Import Cell Classification',
    },
    // VISTA (tissue segmentation) is the 3rd step of the patch pipeline: it consumes the
    // patch classification result. So its prerequisite is MuskClassification, which in
    // turn chains to MuskEmbedding above — "Run all" on VISTA walks CHILD_TO_PARENT and
    // synthesizes MuskEmbedding → MuskClassification → VISTA.
    MuskClassification: {
      childPanelKey: 'TissueSeg',
      childType: 'VISTA',
      buttonLabel: 'Import Tissue Segmentation',
    },
  };

  // Reverse lookup: child type → parent info (derived from MODEL_DEPENDENCIES)
  export const CHILD_TO_PARENT: Record<string, { parentType: string; parentPanelKey: string }> =
    Object.entries(MODEL_DEPENDENCIES).reduce((acc, [parentType, dep]) => {
      // Prefer panelMap whose defaultType matches parentType. Cytoformer shares the
      // NucleiSeg panel shape but is not the factory defaultType (CellCast is), so
      // fall back explicitly for that parent.
      const parentPanelKey =
        Object.keys(panelMap).find((k) => panelMap[k].defaultType === parentType) ||
        (parentType === "Cytoformer" ? "NucleiSeg" : "") ||
        "";
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
