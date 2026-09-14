import type { GeneratedWorkflowStep } from "@/components/imageViewer/sidebar/agent/chat/Chatbox"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { END_NODE_ID, NODE_W, START_NODE_ID, TERMINAL_SIZE } from "@/utils/agent/graph/constants"
import { buildGeneratedPanel, resolveGeneratedModelId } from "@/utils/agent/graph/panel"
import { createInitialSubStages, getInitialModelProgress, nodeHeight, nodeWidth } from "@/utils/agent/graph/graphNode"
import type { GraphConnection, GraphNode } from "@/types/graph.types"

export type GeneratedChainLayoutResult = {
  graphNodes: GraphNode[]
  graphConnections: GraphConnection[]
  generatedPanels: Record<string, WorkflowPanel>
  skippedSteps: string[]
}

/**
 * Re-position existing nodes as a tidy vertical chain: Start on top, model nodes
 * stacked in chain order (walked from START via connections, falling back to array
 * order for any unreached nodes), End at the bottom. Connections are untouched —
 * only x/y change. Used to auto-tidy after a node is added/spliced in.
 */
export function layoutChainVertically(
  nodes: GraphNode[],
  connections: GraphConnection[],
  options: { centerX: number; canvasClientHeight?: number; dockStripHeight: number }
): GraphNode[] {
  const { centerX, canvasClientHeight, dockStripHeight } = options
  const startNode = nodes.find((n) => n.kind === "start")
  const endNode = nodes.find((n) => n.kind === "end")
  const models = nodes.filter((n) => n.kind === "model")

  // Order models by walking the chain from START (first outgoing edge per node).
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const nextOf = new Map<string, string>()
  for (const c of connections) {
    if (!nextOf.has(c.fromId)) nextOf.set(c.fromId, c.toId)
  }
  const ordered: GraphNode[] = []
  const seen = new Set<string>()
  let cursor = startNode ? nextOf.get(startNode.id) : undefined
  while (cursor && !seen.has(cursor)) {
    const node = byId.get(cursor)
    if (node && node.kind === "model") {
      ordered.push(node)
      seen.add(cursor)
    }
    cursor = nextOf.get(cursor)
  }
  // Append models not reached by the walk, preserving their array order.
  for (const m of models) if (!seen.has(m.id)) ordered.push(m)

  const startY = 24
  let yCursor = startY + TERMINAL_SIZE + 48
  const laidModels = ordered.map((node) => {
    const laid = { ...node, x: Math.max(24, centerX - nodeWidth(node) / 2), y: yCursor }
    yCursor += nodeHeight(node) + 40
    return laid
  })

  const endYFromCanvas =
    canvasClientHeight != null ? canvasClientHeight - dockStripHeight - TERMINAL_SIZE - 24 : 360
  const endY = Math.max(yCursor + 8, endYFromCanvas)

  const result: GraphNode[] = []
  if (startNode) result.push({ ...startNode, x: Math.max(24, centerX - TERMINAL_SIZE / 2), y: startY })
  result.push(...laidModels)
  if (endNode) result.push({ ...endNode, x: Math.max(24, centerX - TERMINAL_SIZE / 2), y: endY })
  // Preserve any other node kinds unchanged (future-proofing).
  for (const n of nodes) if (n.kind !== "start" && n.kind !== "end" && n.kind !== "model") result.push(n)
  return result
}

/**
 * Re-position existing nodes as a tidy HORIZONTAL chain: Start on the left, model
 * nodes laid left→right in chain order, End on the right. Connections untouched —
 * only x/y change. Used by the "expand" detailed popup, where a wide layout reads
 * best. `centerY` is the vertical mid-line to center each row on.
 */
export function layoutChainHorizontally(
  nodes: GraphNode[],
  connections: GraphConnection[],
  options: { centerY: number; canvasClientWidth?: number }
): GraphNode[] {
  const { centerY, canvasClientWidth } = options
  const startNode = nodes.find((n) => n.kind === "start")
  const endNode = nodes.find((n) => n.kind === "end")
  const models = nodes.filter((n) => n.kind === "model")

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const nextOf = new Map<string, string>()
  for (const c of connections) {
    if (!nextOf.has(c.fromId)) nextOf.set(c.fromId, c.toId)
  }
  const ordered: GraphNode[] = []
  const seen = new Set<string>()
  let cursor = startNode ? nextOf.get(startNode.id) : undefined
  while (cursor && !seen.has(cursor)) {
    const node = byId.get(cursor)
    if (node && node.kind === "model") {
      ordered.push(node)
      seen.add(cursor)
    }
    cursor = nextOf.get(cursor)
  }
  for (const m of models) if (!seen.has(m.id)) ordered.push(m)

  const startX = 24
  const termY = Math.max(24, centerY - TERMINAL_SIZE / 2)
  // Pick a gap that fits Start + models + End inside the available width so End
  // stays visible without panning; clamp so it never crowds or over-spreads. When
  // there are too many models to fit even at the min gap, it overflows and the
  // canvas can be panned.
  const totalNodeW = TERMINAL_SIZE * 2 + ordered.reduce((s, n) => s + nodeWidth(n), 0)
  const gapSlots = ordered.length + 1 // gaps between Start, each model, and End
  const available = (canvasClientWidth ?? 900) - startX * 2
  let gap = gapSlots > 0 ? (available - totalNodeW) / gapSlots : 64
  gap = Math.max(28, Math.min(64, gap))

  let xCursor = startX + TERMINAL_SIZE + gap
  const laidModels = ordered.map((node) => {
    const laid = { ...node, x: xCursor, y: Math.max(24, centerY - nodeHeight(node) / 2) }
    xCursor += nodeWidth(node) + gap
    return laid
  })
  const endX = xCursor

  const result: GraphNode[] = []
  if (startNode) result.push({ ...startNode, x: startX, y: termY })
  result.push(...laidModels)
  if (endNode) result.push({ ...endNode, x: endX, y: termY })
  for (const n of nodes) if (n.kind !== "start" && n.kind !== "end" && n.kind !== "model") result.push(n)
  return result
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
