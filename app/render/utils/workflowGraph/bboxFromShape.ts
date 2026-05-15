/** ROI bounds for `buildStartWorkflowPayload` — empty strings when no rectangle is drawn. */
export function workflowGraphBBoxStringsFromRectangle(
  rectangleCoords: { x1: number; y1: number; x2: number; y2: number } | null | undefined
): { x1: string; y1: string; x2: string; y2: string } {
  if (rectangleCoords) {
    return {
      x1: rectangleCoords.x1.toString(),
      y1: rectangleCoords.y1.toString(),
      x2: rectangleCoords.x2.toString(),
      y2: rectangleCoords.y2.toString(),
    }
  }
  return { x1: "", y1: "", x2: "", y2: "" }
}

/**
 * Bounds for **tissue** steps that still use ctx `x1`–`y2` in `buildStartWorkflowPayload`.
 * Nuclei segmentation ignores these for `bbox` and only sends a bbox when `shapeData.rectangleCoords` exists.
 */
export function workflowGraphPayloadBounds(
  rectangleCoords: { x1: number; y1: number; x2: number; y2: number } | null | undefined,
  slideDimensions: [number, number] | null | undefined
): { x1: string; y1: string; x2: string; y2: string } {
  if (rectangleCoords) {
    return workflowGraphBBoxStringsFromRectangle(rectangleCoords)
  }
  if (slideDimensions && slideDimensions.length === 2) {
    const [w, h] = slideDimensions
    return { x1: "0", y1: "0", x2: String(w), y2: String(h) }
  }
  return { x1: "", y1: "", x2: "", y2: "" }
}
