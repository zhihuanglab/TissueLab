import {
  ACTIVE_LEARNING_MODEL_IDS,
  CODING_GRAPH_MODEL_ID,
  END_NODE_ID,
  MODEL_SUBSTAGES,
  NODE_H,
  NODE_H_CODING,
  NODE_W,
  NODE_W_CODING,
  NODE_W_MAX,
  NODE_W_WIDE,
  PROGRESS_BAR_H,
  START_NODE_ID,
  TERMINAL_SIZE,
  registryCategoryNames,
  registryNodes,
} from "@/utils/workflowGraph/constants"
import type { GraphNode, SubStage, Workflow } from "@/utils/workflowGraph/types"

export const isTerminal = (n: GraphNode) => n.kind !== "model"

export const isActiveLearning = (n: GraphNode) =>
  n.kind === "model" && !!n.modelId && ACTIVE_LEARNING_MODEL_IDS.has(n.modelId)

export const isCodingAgentGraphNode = (n: GraphNode) =>
  n.kind === "model" && n.modelId === CODING_GRAPH_MODEL_ID

const MODEL_CARD_CHROME_W = 96
const MODEL_LABEL_AVG_CHAR_W = 6.6
const MODEL_CATEGORY_AVG_CHAR_W = 5.2

const clampNodeWidth = (width: number, minWidth: number) =>
  Math.min(NODE_W_MAX, Math.max(minWidth, Math.ceil(width)))

const modelNodeLabelWidth = (n: GraphNode) => {
  const meta = n.modelId ? registryNodes[n.modelId] : undefined
  const label = n.label || meta?.displayName || n.modelId || "Node"
  const category = meta?.factory ? registryCategoryNames[meta.factory] || meta.factory : ""

  return Math.max(
    label.length * MODEL_LABEL_AVG_CHAR_W,
    category.length * MODEL_CATEGORY_AVG_CHAR_W
  )
}

export const nodeWidth = (n: GraphNode) => {
  if (isTerminal(n)) return TERMINAL_SIZE
  if (isCodingAgentGraphNode(n)) return NODE_W_CODING

  const minWidth = isActiveLearning(n) ? NODE_W_WIDE : NODE_W
  return clampNodeWidth(MODEL_CARD_CHROME_W + modelNodeLabelWidth(n), minWidth)
}

export const nodeHeight = (n: GraphNode) => {
  if (isTerminal(n)) return TERMINAL_SIZE
  const base = isCodingAgentGraphNode(n) ? NODE_H_CODING : NODE_H
  const stages = n.subStages?.length ?? 1
  return base + (stages - 1) * PROGRESS_BAR_H
}

export const initialNodes = (): GraphNode[] => [
  { id: START_NODE_ID, kind: "start", x: 120, y: 24 },
  { id: END_NODE_ID, kind: "end", x: 120, y: 360 },
]

export const newWorkflow = (name: string): Workflow => ({
  id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  name,
  nodes: initialNodes(),
  connections: [],
  selectedId: null,
})

export const createInitialSubStages = (modelId: string): SubStage[] | undefined => {
  const stagesDef = MODEL_SUBSTAGES[modelId]
  return stagesDef?.map((stage) => ({
    key: stage.key,
    label: stage.label,
    // Default to pending; real processed state is derived from zarr stage status / SSE.
    progress: 0,
  }))
}

export const getInitialModelProgress = (modelId: string, subStages?: SubStage[]) =>
  // Default to pending; real processed state is derived from zarr stage status / SSE.
  subStages ? undefined : 0

/** SSE `node_progress` 0–100: first half → segmentation bar, second half → embedding bar. */
export function sseOverallToSegEmbBars(overall: number): { seg: number; emb: number } {
  const p = Math.max(0, Math.min(100, overall))
  return {
    seg: Math.min(100, p * 2),
    emb: Math.max(0, Math.min(100, (p - 50) * 2)),
  }
}

/** Align saved/imported graph nodes with current `MODEL_SUBSTAGES` (e.g. cell seg gained two bars). */
export function normalizeGraphNodeSubStages(node: GraphNode): GraphNode {
  if (node.kind !== "model" || !node.modelId) return node
  const template = MODEL_SUBSTAGES[node.modelId]
  if (!template?.length) {
    // Runtime progress is derived from SSE / zarr status; persisted graph snapshots should start pending.
    if (typeof node.progress === "number" && node.progress !== 0) {
      return { ...node, progress: 0 }
    }
    return node
  }
  const existing = node.subStages ?? []
  const keysMatch =
    existing.length === template.length && template.every((t, i) => existing[i]?.key === t.key)
  if (keysMatch) {
    const hasNonZero = existing.some((s) => Number(s.progress || 0) > 0)
    if (!hasNonZero && (node.progress == null || node.progress === 0)) return node
    return {
      ...node,
      progress: undefined,
      subStages: template.map((t) => ({
        key: t.key,
        label: t.label,
        progress: 0,
      })),
    }
  }
  const prevByKey = new Map(existing.map((s) => [s.key, s.progress]))
  const cellSegIds =
    node.modelId === "SegmentationNode" ||
    node.modelId === "InstanSegNode" ||
    node.modelId === "NucSegNode"
  const legacyDone =
    cellSegIds && existing.length === 0 && (node.progress ?? 0) >= 100 ? 100 : undefined
  return {
    ...node,
    progress: undefined,
    subStages: template.map((t) => ({
      key: t.key,
      label: t.label,
      progress: Math.min(
        100,
        Math.max(0, legacyDone ?? prevByKey.get(t.key) ?? 0)
      ),
    })),
  }
}

export function normalizeWorkflowGraphNodes(nodes: GraphNode[]): GraphNode[] {
  return nodes.map(normalizeGraphNodeSubStages)
}
