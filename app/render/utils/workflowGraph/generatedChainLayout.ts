import type { GeneratedWorkflowStep } from "@/components/imageViewer/RightSidebar/Agent/Chatbox"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { END_NODE_ID, NODE_W, START_NODE_ID, TERMINAL_SIZE } from "@/utils/workflowGraph/constants"
import { buildGeneratedPanel, resolveGeneratedModelId } from "@/utils/workflowGraph/generatedPanel"
import { createInitialSubStages, getInitialModelProgress, nodeHeight, nodeWidth } from "@/utils/workflowGraph/graphNode"
import type { GraphConnection, GraphNode } from "@/utils/workflowGraph/types"

export type GeneratedChainLayoutResult = {
  graphNodes: GraphNode[]
  graphConnections: GraphConnection[]
  generatedPanels: Record<string, WorkflowPanel>
  skippedSteps: string[]
}

/**
 * Lay out chat-generated steps as a vertical chain: Start → models… → End, with sidecar panel map.
 */
export function buildGeneratedWorkflowChainLayout(
  generatedWorkflow: GeneratedWorkflowStep[],
  formattedPath: string,
  options: {
    centerX: number
    /** `canvasRef.getBoundingClientRect().height` when available */
    canvasClientHeight?: number
    dockStripHeight: number
    baseId?: number
  }
): GeneratedChainLayoutResult | null {
  const generatedNodes: GraphNode[] = []
  const generatedPanels: Record<string, WorkflowPanel> = {}
  const skippedSteps: string[] = []
  const startY = 24
  let yCursor = startY + TERMINAL_SIZE + 48
  const baseId = options.baseId ?? Date.now()
  const { centerX, canvasClientHeight, dockStripHeight } = options

  generatedWorkflow.forEach((step, index) => {
    const modelId = resolveGeneratedModelId(step)
    if (!modelId) {
      skippedSteps.push(step.model)
      return
    }

    const subStages = createInitialSubStages(modelId)
    const node: GraphNode = {
      id: `node-${baseId}-${index}`,
      kind: "model",
      modelId,
      x: Math.max(24, centerX - NODE_W / 2),
      y: yCursor,
      progress: getInitialModelProgress(modelId, subStages),
      subStages,
    }
    node.x = Math.max(24, centerX - nodeWidth(node) / 2)
    generatedNodes.push(node)

    const panel = buildGeneratedPanel(step, node.id, modelId, formattedPath)
    if (panel) generatedPanels[node.id] = panel

    yCursor += nodeHeight(node) + 40
  })

  if (generatedNodes.length === 0) return null

  const endYFromCanvas =
    canvasClientHeight != null ? canvasClientHeight - dockStripHeight - TERMINAL_SIZE - 24 : 360
  const endY = Math.max(yCursor + 8, endYFromCanvas)
  const startNode: GraphNode = {
    id: START_NODE_ID,
    kind: "start",
    x: Math.max(24, centerX - TERMINAL_SIZE / 2),
    y: startY,
  }
  const endNode: GraphNode = {
    id: END_NODE_ID,
    kind: "end",
    x: Math.max(24, centerX - TERMINAL_SIZE / 2),
    y: endY,
  }
  const graphNodes = [startNode, ...generatedNodes, endNode]
  const chainIds = graphNodes.map((node) => node.id)
  const graphConnections: GraphConnection[] = chainIds.slice(0, -1).map((fromId, index) => ({
    id: `conn-${baseId}-${index}`,
    fromId,
    toId: chainIds[index + 1],
    fromPort: "bottom" as const,
    toPort: "top" as const,
  }))

  return { graphNodes, graphConnections, generatedPanels, skippedSteps }
}
