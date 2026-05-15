import { nodeHeight, nodeWidth } from "@/utils/workflowGraph/graphNode"
import type { GraphNode, PortSide } from "@/utils/workflowGraph/types"

const DEFAULT_PAD = 24

/** Bounding box of all nodes + padding — drives inner wrapper size and vertical auto-scale. */
export function computeWorkflowContentBounds(nodes: GraphNode[], pad = DEFAULT_PAD): { w: number; h: number } {
  let maxX = 0
  let maxY = 0
  for (const n of nodes) {
    const w = nodeWidth(n)
    const h = nodeHeight(n)
    if (n.x + w > maxX) maxX = n.x + w
    if (n.y + h > maxY) maxY = n.y + h
  }
  return { w: maxX + pad, h: maxY + pad }
}

/** Vertical-only fit: compress Y positions when content is taller than the viewport. */
export function computeWorkflowYScale(wrapperH: number, canvasH: number): number {
  return canvasH > 0 ? Math.min(1, canvasH / wrapperH) : 1
}

/**
 * Port anchor in the same visual space as the SVG (Y uses `yScale` so edges match drawn cards).
 * Card heights are unscaled; only logical Y is multiplied by `yScale`.
 */
export function getWorkflowGraphPortPosition(
  node: GraphNode,
  side: PortSide,
  yScale: number
): { x: number; y: number } {
  const w = nodeWidth(node)
  const h = nodeHeight(node)
  const visY = node.y * yScale
  switch (side) {
    case "right":
      return { x: node.x + w, y: visY + h / 2 }
    case "left":
      return { x: node.x, y: visY + h / 2 }
    case "top":
      return { x: node.x + w / 2, y: visY }
    case "bottom":
      return { x: node.x + w / 2, y: visY + h }
  }
}

/**
 * Screen client coords → logical canvas coords. X unscaled; Y divided by `yScale` to match stored `node.y`.
 */
export function screenPointToLogicalCanvas(
  clientX: number,
  clientY: number,
  rect: DOMRect | undefined | null,
  pan: { x: number; y: number },
  yScale: number
): { x: number; y: number } {
  const sy = yScale || 1
  if (!rect) return { x: 0, y: 0 }
  return {
    x: clientX - rect.left - pan.x,
    y: (clientY - rect.top - pan.y) / sy,
  }
}
