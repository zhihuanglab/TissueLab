import {
  getContentStringValue,
  panelMap,
  upsertContentStringValue,
} from "@/components/imageViewer/RightSidebar/Agent/Workflow/constants"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { mergePanelContentWithFactoryDefaults } from "@/utils/workflow/codingAgentPolicy"
import { registryNodes } from "@/utils/workflowGraph/constants"
import type { GraphNode } from "@/utils/workflowGraph/types"

/** Redux workflow panels may use legacy type ids that differ from graph `modelId`. */
function reduxPanelTypeMatchesGraphModel(graphModelId: string, reduxType: string | undefined): boolean {
  if (!reduxType) return false
  if (reduxType === graphModelId) return true
  if (graphModelId === "PatchClassifier" && reduxType === "MuskClassification") return true
  return false
}

/** Default Workflow panel for a graph node from registry + `panelMap` (no Redux / local panel state). */
export function buildLegacyPanelFromNode(node: GraphNode): WorkflowPanel | null {
  if (!node.modelId) return null
  const meta = registryNodes[node.modelId]
  const factory = meta?.factory
  if (!factory) return null
  const cfg = (panelMap as Record<string, any>)[factory]
  if (!cfg) return null
  return {
    id: node.id,
    title: cfg.title,
    type: node.modelId,
    progress: node.progress ?? 0,
    content: cfg.defaultContent.map((c: any) => ({ ...c })),
    stepName: factory,
  }
}

/**
 * Resolve panel for configuration UI: prefer `panelStates[node.id]`, merge factory defaults when needed,
 * otherwise build from registry.
 */
export function resolveLegacyPanelForNode(
  node: GraphNode,
  panelStates: Record<string, WorkflowPanel | undefined>
): WorkflowPanel | null {
  const existing = panelStates[node.id]
  const meta = node.modelId ? registryNodes[node.modelId] : undefined
  const factory = meta?.factory as string | undefined
  if (existing) {
    let next: WorkflowPanel = existing
    if (node.modelId && existing.type !== node.modelId) {
      next = { ...existing, type: node.modelId }
    }
    if (factory && (panelMap as Record<string, { defaultContent?: unknown[] }>)[factory]?.defaultContent) {
      next = {
        ...next,
        content: mergePanelContentWithFactoryDefaults(next.content, factory) as typeof next.content,
      }
    }
    return next
  }
  return buildLegacyPanelFromNode(node)
}

/**
 * Graph `panelStates` often omits classifier paths that were set on the classic Workflow tab
 * or sent via annotation-triggered runs (Redux `workflow.panels`). Merge those paths so
 * graph Save / payload builders see the same sources as the rest of the app.
 */
export function mergeGraphPanelClassifierPathsFromRedux(
  node: GraphNode,
  panel: WorkflowPanel | null,
  reduxPanels: WorkflowPanel[],
  graphModelNodes: GraphNode[]
): WorkflowPanel | null {
  if (!panel || node.kind !== "model" || !node.modelId) return panel
  const meta = registryNodes[node.modelId]
  const factory = meta?.factory as string | undefined
  if (!factory) return panel
  const cfg = (panelMap as Record<string, { title?: string }>)[factory]
  const legacyTitle = cfg?.title
  if (!legacyTitle) return panel

  const matchingRedux = reduxPanels.filter(
    (p) => p.title === legacyTitle && reduxPanelTypeMatchesGraphModel(node.modelId!, p.type)
  )
  if (matchingRedux.length === 0) return panel

  const sameModelOnGraph = graphModelNodes.filter((n) => n.kind === "model" && n.modelId === node.modelId)
  const idx = Math.max(0, sameModelOnGraph.findIndex((n) => n.id === node.id))
  const reduxPanel = matchingRedux[idx] ?? matchingRedux[0]

  const loadR = getContentStringValue(reduxPanel.content, "classifier_path")?.trim()
  const saveR = getContentStringValue(reduxPanel.content, "save_classifier_path")?.trim()
  const loadP = getContentStringValue(panel.content, "classifier_path")?.trim()
  const saveP = getContentStringValue(panel.content, "save_classifier_path")?.trim()

  let nextContent = panel.content
  if (!loadP && loadR) nextContent = upsertContentStringValue(nextContent, "classifier_path", loadR)
  if (!saveP && saveR) nextContent = upsertContentStringValue(nextContent, "save_classifier_path", saveR)
  if (nextContent === panel.content) return panel
  return { ...panel, content: nextContent }
}
