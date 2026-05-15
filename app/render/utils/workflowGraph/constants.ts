import modelRegistryFallback from "@/constants/modelRegistryFallback.json"
import type { CommunityClassifierOption } from "@/utils/workflowGraph/types"

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
  ClassificationNode: [
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
  PatchClassifier: [
    {
      key: "embedding",
      label: "Embedding",
      description: "Compute per-patch feature embeddings. Pre-computed once per slide.",
      preProcessed: true,
    },
    {
      key: "classification",
      label: "Patch Classification",
      description: "Assign each patch a class. Re-run any time you update labels or class definitions.",
      rerunnable: true,
    },
  ],
  MuskClassification: [
    {
      key: "embedding",
      label: "Embedding",
      description: "MUSK patch embeddings in MuskNode. Pre-computed once per slide (run Patch Embedding node first).",
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
      description: "Compute MUSK patch embeddings and store under MuskNode.",
      rerunnable: true,
    },
  ],
  VISTA: [
    {
      key: "embedding",
      label: "Embedding",
      description: "Compute patch-level feature embeddings. Pre-computed once per slide.",
      preProcessed: true,
    },
    {
      key: "al-patches",
      label: "Active Learning (patches)",
      description: "Iteratively refine on uncertain patches. Re-run as you label more.",
      rerunnable: true,
      autoRunNext: true,
    },
    {
      key: "pixel-seg",
      label: "Pixel Segmentation",
      description: "Lifts patch predictions to pixel-level masks. Runs automatically after Step 2.",
    },
  ],
  SegmentationNode: CELL_SEG_PIPELINE_SUBSTAGES,
  InstanSegNode: CELL_SEG_PIPELINE_SUBSTAGES,
  NucSegNode: CELL_SEG_PIPELINE_SUBSTAGES,
}

/** Models that benefit from active learning loops — get a wider card with an AL trigger button. */
export const ACTIVE_LEARNING_MODEL_IDS = new Set<string>([
  "ClassificationNode",
  "VISTA",
  "MuskClassification",
  "PatchClassifier",
])

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
  { displayName?: string; icon?: string; factory?: string }
>
export const registryCategoryNames = modelRegistryFallback.category_display_names as Record<string, string>

/** Same node names as backend `node_status` / `stage_progress`; values are grouped per registry category (not factory strings). */
export const registryCategoryMap = (
  modelRegistryFallback as { category_map?: Record<string, string[]> }
).category_map ?? {}

// Community classifiers shown in the Load Classifier dialog while offline.
export const COMMUNITY_CLASSIFIERS_FALLBACK: CommunityClassifierOption[] = [
  {
    id: "comm-clf-tumor-lymph",
    name: "Tumor vs Lymphocyte (Pan-cancer)",
    description: "Per-cell classifier distinguishing tumor cells from lymphocytes across pan-cancer H&E.",
    author: "TissueLab Team",
    modelId: "ClassificationNode",
    tags: ["pathology", "nuclei", "tumor"],
  },
  {
    id: "comm-clf-her2-patch",
    name: "HER2 Status — Patch (BRCA)",
    description: "Patch-level HER2 IHC scoring across 4 classes, trained on BRCA cases.",
    author: "TissueLab Team",
    modelId: "PatchClassifier",
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
    modelId: "ClassificationNode",
    tags: ["pathology", "breast", "nuclei"],
  },
]

export const SAVED_CLASSIFIERS_KEY = "tl.workflowGraph.classifiers.saved"
