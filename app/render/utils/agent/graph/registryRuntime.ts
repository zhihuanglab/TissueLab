import { registryCategoryMap, registryNodes } from "@/utils/agent/graph/constants"

/**
 * Expand graph `modelId` to backend task node names that may appear in SSE.
 * Uses `category_map` only when `modelId` itself is a category key
 * (e.g. "NucleiClassify"). Never add sibling models — CytoformerClassification
 * must not read NuClass progress, and Cytoformer must not read CellCast.
 */
export function expandRuntimeStatusNodeKeys(modelId: string): string[] {
  const keys = new Set<string>([modelId])
  const group = registryCategoryMap[modelId]
  if (Array.isArray(group)) {
    for (const n of group) {
      if (typeof n === "string" && n.trim()) keys.add(n.trim())
    }
  }
  return Array.from(keys)
}

export const modelIdFromClassifierFactory = (factory?: string, model?: string) => {
  if (model && registryNodes[model]) return model
  if (factory === "NucleiClassify") return "NuClass"
  if (factory === "TissueClassify") return "MuskClassification"
  return model || factory || "NuClass"
}
