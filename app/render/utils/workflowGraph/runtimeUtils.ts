/** First finite numeric value in a list (e.g. runtime status map values). */
export function firstNumericRuntimeValue(vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = typeof v === "number" ? v : Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * SSE / Redux payloads sometimes nest maps under `node_status` / `node_progress`, sometimes flatten.
 */
export function normalizeWorkflowRuntimeMap(
  raw: unknown,
  nestedKey: "node_status" | "node_progress"
): Record<string, unknown> {
  if (raw && typeof raw === "object") {
    const nested = (raw as Record<string, unknown>)[nestedKey]
    if (nested && typeof nested === "object") return nested as Record<string, unknown>
    return raw as Record<string, unknown>
  }
  return {}
}
