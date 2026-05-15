import { getContentStringValue } from "@/components/imageViewer/RightSidebar/Agent/Workflow/constants"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import type { GraphNode } from "@/utils/workflowGraph/types"

/**
 * Normalize paths sent to AI `seg/v1/classifier_file/*`: trim, backslashes → `/`, collapse runs of `/`,
 * then strip leading `/` so values look like storage-relative paths (same shape helps server resolve_path).
 * If some future API ever required a leading slash, tighten here instead of at call sites.
 */
export function normalizePathForSegClassifierApi(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "")
}

/** Classification / patch pipeline has finished the trainable step (NuClass / Patch clf stage). */
export function graphClassificationStageDone(node: GraphNode): boolean {
  const subs = node.subStages
  if (subs && subs.length > 0) {
    const clf = subs.find((s) => s.key === "classification")
    if (clf) return clf.progress >= 99.5
    return subs.every((s) => s.progress >= 99.5)
  }
  return (node.progress ?? 0) >= 99.5
}

/** There is a server-visible path to copy from (save path after run, load path, or graph Load). */
export function graphClassifierHasExportableSource(node: GraphNode, panel: WorkflowPanel): boolean {
  const pick = (key: string) => getContentStringValue(panel.content, key)?.trim()
  return Boolean(
    pick("save_classifier_path") ||
      pick("classifier_path") ||
      (node.loadedClassifier?.path && String(node.loadedClassifier.path).trim())
  )
}

/** Prefer trained output path, then load path, then graph-loaded ref. */
export function graphClassifierPrimarySourcePath(node: GraphNode, panel: WorkflowPanel): string {
  const pick = (key: string) => getContentStringValue(panel.content, key)?.trim() || ""
  return (
    pick("save_classifier_path") ||
    pick("classifier_path") ||
    (node.loadedClassifier?.path && String(node.loadedClassifier.path).trim()) ||
    ""
  )
}

/** TaskNode `model_name` for seg `/v1/classifier_tasknode_save` (port resolution). */
export function graphClassifierTasknodePersistModelName(
  modelId: string | undefined
): "ClassificationNode" | "MuskClassification" | null {
  if (!modelId) return null
  if (modelId === "MuskClassification" || modelId === "PatchClassifier") return "MuskClassification"
  if (modelId === "ClassificationNode") return "ClassificationNode"
  return null
}
