import { registryCategoryMap, registryNodes } from "@/utils/workflowGraph/constants"

/**
 * Expand graph `modelId` to all backend task **node names** that may appear in SSE for the same logical model family.
 * Uses `category_map` name groups only — never `factory` (e.g. never add `NucleiSeg` as a runtime status key).
 */
export function expandRuntimeStatusNodeKeys(modelId: string): string[] {
  const keys = new Set<string>([modelId])
  for (const group of Object.values(registryCategoryMap)) {
    if (!Array.isArray(group)) continue
    if (group.includes(modelId)) {
      for (const n of group) {
        if (typeof n === "string" && n.trim()) keys.add(n.trim())
      }
    }
  }
  for (const [catKey, group] of Object.entries(registryCategoryMap)) {
    if (catKey === modelId && Array.isArray(group)) {
      for (const n of group) {
        if (typeof n === "string" && n.trim()) keys.add(n.trim())
      }
    }
  }
  const legacyNameAliases: Record<string, readonly string[]> = {
    NucSegNode: ["SegmentationNode"],
    SegmentationNode: ["NucSegNode"],
  }
  for (const alt of legacyNameAliases[modelId] ?? []) keys.add(alt)
  for (const [legacyId, alts] of Object.entries(legacyNameAliases)) {
    if (alts.includes(modelId)) keys.add(legacyId)
  }
  return Array.from(keys)
}

export const modelIdFromClassifierFactory = (factory?: string, model?: string) => {
  if (model && registryNodes[model]) return model
  if (factory === "NucleiClassify") return "ClassificationNode"
  if (factory === "TissueClassify") return "PatchClassifier"
  return model || factory || "ClassificationNode"
}
