import modelRegistryFallback from "@/constants/modelRegistryFallback.json"
import type { CommunityClassifierOption } from "@/types/graph.types"

/** Cell / nuclei segmentation nodes: SSE `node_progress` 0–100 → first 50% segmentation, second 50% embedding. */
const CELL_SEG_PIPELINE_SUBSTAGES: Array<{
  key: string
  label: string
  description?: string
  preProcessed?: boolean
  rerunnable?: boolean
  autoRunNext?: boolean
}> = [
  {
    key: "segmentation",
    label: "Segmentation",
    description: "Segmentation phase (first half of overall progress).",
  },
  {
    key: "embedding",
    label: "Embedding",
    description: "Embedding phase (second half of overall progress).",
  },
]

/**
 * Models composed of multiple sequential stages. Each stage renders its own progress bar,
 * and steps marked rerunnable get a Re-run button in the configuration view. When a stage is
 * marked autoRunNext the runner immediately fires the following stage on completion.
 */
export const MODEL_SUBSTAGES: Record<
  string,
  Array<{
    key: string
    label: string
    description?: string
    preProcessed?: boolean
    rerunnable?: boolean
    autoRunNext?: boolean
  }>
> = {
  NuClass: [
    {
      key: "segmentation",
      label: "Cell Segmentation",
      description: "Detect every nucleus / cell. Pre-computed once per slide.",
      preProcessed: true,
    },
    {
      key: "embedding",
      label: "Embedding",
      description: "Compute per-cell feature embeddings. Pre-computed once per slide.",
      preProcessed: true,
    },
    {
      key: "classification",
      label: "NuClass",
      description: "Assign each cell a class. Re-run any time you update labels or class definitions.",
      rerunnable: true,
    },
  ],
  // Same 3-bar pipeline as NuClass; the only difference is the organ input.
  CytoformerClassification: [
    {
      key: "segmentation",
      label: "Cell Segmentation",
      description: "Detect every nucleus / cell (Cytoformer seg). Pre-computed once per slide.",
      preProcessed: true,
    },
    {
      key: "embedding",
      label: "Embedding",
      description: "H-optimus-0 per-cell embeddings [N,1536]. Pre-computed once per slide.",
      preProcessed: true,
    },
    {
      key: "classification",
      label: "Cytoformer Classification",
      description: "Select an organ to pick the zero-shot head. Re-run any time you update labels or class definitions.",
      rerunnable: true,
    },
  ],
  MuskClassification: [
    {
      key: "embedding",
      label: "Embedding",
      description: "MUSK patch embeddings in Patch-Segmentation. Pre-computed once per slide (run Patch Embedding node first).",
      preProcessed: true,
    },
    {
      key: "classification",
      label: "MUSK Classification",
      description: "Assign each patch a class. Re-run any time you update labels or class definitions.",
      rerunnable: true,
    },
  ],
  MuskEmbedding: [
    {
      key: "embedding",
      label: "Patch embedding",
      description: "Compute MUSK patch embeddings and store under Patch-Segmentation.",
      rerunnable: true,
    },
  ],
  // H-optimus-0 — same patch embedding/classification UI as MUSK (1536-d).
  HOptimusClassification: [
    {
      key: "embedding",
      label: "Embedding",
      description: "H-optimus-0 patch embeddings in Patch-Segmentation. Pre-computed once per slide (run Patch Embedding node first).",
      preProcessed: true,
    },
    {
      key: "classification",
      label: "H-optimus-0 Classification",
      description: "Assign each patch a class. Re-run any time you update labels or class definitions.",
      rerunnable: true,
    },
  ],
  HOptimusEmbedding: [
    {
      key: "embedding",
      label: "Patch embedding",
      description: "Compute H-optimus-0 patch embeddings and store under Patch-Segmentation.",
      rerunnable: true,
    },
  ],
  // Virchow — same patch embedding/classification UI as MUSK (2560-d).
  VirchowClassification: [
    {
      key: "embedding",
      label: "Embedding",
      description: "Virchow patch embeddings in Patch-Segmentation. Pre-computed once per slide (run Patch Embedding node first).",
      preProcessed: true,
    },
    {
      key: "classification",
      label: "Virchow Classification",
      description: "Assign each patch a class. Re-run any time you update labels or class definitions.",
      rerunnable: true,
    },
  ],
  VirchowEmbedding: [
    {
      key: "embedding",
      label: "Patch embedding",
      description: "Compute Virchow patch embeddings and store under Patch-Segmentation.",
      rerunnable: true,
    },
  ],
  VISTA: [
    {
      key: "embedding",
      label: "Patch embedding",
      description: "MUSK patch embeddings in Patch-Segmentation. Pre-computed once per slide (run Patch Embedding first).",
      preProcessed: true,
    },
    {
      key: "classification",
      label: "Patch Classification",
      description: "Assign each patch a tissue class. Pre-computed (run Patch Classification first).",
      preProcessed: true,
    },
    {
      key: "segmentation",
      label: "VISTA Tissue Segmentation",
      description: "Connect classified patches into dense tissue masks. Re-run any time you change classes/colors.",
      rerunnable: true,
    },
  ],
  StarDist: CELL_SEG_PIPELINE_SUBSTAGES,
  InstanSegNode: CELL_SEG_PIPELINE_SUBSTAGES,
  CellCast: CELL_SEG_PIPELINE_SUBSTAGES,
}

/**
 * Multi-stage models whose runtime bars must start from the template at 0%
 * (saved `subStages` often still show 100% from a prior run).
 */
export const RUNTIME_SUBSTAGE_FROM_TEMPLATE_IDS = new Set<string>(Object.keys(MODEL_SUBSTAGES))

/** Models that benefit from active learning loops — get a wider card with an AL trigger button.
 *  NucleiClassify / TissueClassify come from the registry; VISTA is TissueSeg but still AL. */
export const ACTIVE_LEARNING_MODEL_IDS = new Set<string>(["VISTA"])

export const NODE_W = 140
export const NODE_W_WIDE = 196
export const NODE_W_MAX = 300
/** Slightly wider/taller than default so status text (e.g. “Running…”) fits on the canvas card. */
export const NODE_W_CODING = 176
export const NODE_H = 64
export const NODE_H_CODING = 72
export const TERMINAL_SIZE = 56

export const CODING_GRAPH_MODEL_ID = "GPT-4o Agent"

export const PROGRESS_BAR_H = 18

export const START_NODE_ID = "__start__"
export const END_NODE_ID = "__end__"

export const registryNodes = modelRegistryFallback.nodes as Record<
  string,
  {
    displayName?: string
    icon?: string
    factory?: string
    panel?: Array<{
      key: string
      type: string
      value?: unknown
      label?: string
      placeholder?: string
      readOnly?: boolean
    }>
  }
>
export const registryCategoryNames = modelRegistryFallback.category_display_names as Record<string, string>

/** Same node names as backend `node_status` / `stage_progress`; values are grouped per registry category (not factory strings). */
export const registryCategoryMap = (
  modelRegistryFallback as { category_map?: Record<string, string[]> }
).category_map ?? {}

/** True for ANY cell-segmentation node (registry factory "NucleiSeg") — StarDist,
 *  InstanSeg, CellCast, Cytoformer, and any future one. Seg-node UI/logic keys off the
 *  FACTORY, not a hardcoded modelId list, so every cell-seg model is treated identically. */
export const isCellSegModelId = (modelId?: string | null): boolean =>
  !!modelId && registryNodes[modelId]?.factory === "NucleiSeg"

/** NuClass + CytoformerClassification. Factory matches the cell-classifier pipeline. */
export const isNucleiClassifyModelId = (modelId?: string | null): boolean =>
  !!modelId && registryNodes[modelId]?.factory === "NucleiClassify"

/** Pathology patch classifiers (MUSK / H-optimus-0 / Virchow).
 *  Factory "TissueClassify" also contains radiology (BiomedParse, TotalSegmentator);
 *  those have no patch substages and must not use the .tlcls / patch-overlay path. */
export const isTissueClassifyModelId = (modelId?: string | null): boolean =>
  !!modelId &&
  registryNodes[modelId]?.factory === "TissueClassify" &&
  !!MODEL_SUBSTAGES[modelId]

// Every cell-segmentation node shares the same two-bar substage pipeline
// (segmentation + embedding). Register it from the registry by factory so a new seg
// model (e.g. Cytoformer) shows the identical bars without editing MODEL_SUBSTAGES.
for (const [id, meta] of Object.entries(registryNodes)) {
  if (meta?.factory === "NucleiSeg" && !MODEL_SUBSTAGES[id]) {
    MODEL_SUBSTAGES[id] = CELL_SEG_PIPELINE_SUBSTAGES
    RUNTIME_SUBSTAGE_FROM_TEMPLATE_IDS.add(id)
  }
  if (isNucleiClassifyModelId(id) || isTissueClassifyModelId(id)) {
    ACTIVE_LEARNING_MODEL_IDS.add(id)
  }
}

// Community classifiers shown in the Load Classifier dialog while offline.
export const COMMUNITY_CLASSIFIERS_FALLBACK: CommunityClassifierOption[] = [
  {
    id: "comm-clf-tumor-lymph",
    name: "Tumor vs Lymphocyte (Pan-cancer)",
    description: "Per-cell classifier distinguishing tumor cells from lymphocytes across pan-cancer H&E.",
    author: "TissueLab Team",
    modelId: "NuClass",
    tags: ["pathology", "nuclei", "tumor"],
  },
  {
    id: "comm-clf-her2-patch",
    name: "HER2 Status — Patch (BRCA)",
    description: "Patch-level HER2 IHC scoring across 4 classes, trained on BRCA cases.",
    author: "TissueLab Team",
    modelId: "MuskClassification",
    tags: ["pathology", "her2", "patch"],
  },
  {
    id: "comm-clf-vista-prostate",
    name: "VISTA — Prostate gland boundaries",
    description: "VISTA-PATH model fine-tuned to delineate prostate gland boundaries.",
    author: "Demo User",
    modelId: "VISTA",
    tags: ["pathology", "prostate", "vista"],
  },
  {
    id: "comm-clf-nuclei-breast",
    name: "Breast — Nuclei subtype panel",
    description: "5-class per-cell classifier for breast tumor microenvironment review.",
    author: "Demo User",
    modelId: "NuClass",
    tags: ["pathology", "breast", "nuclei"],
  },
]

export const SAVED_CLASSIFIERS_KEY = "tl.workflowGraph.classifiers.saved"
