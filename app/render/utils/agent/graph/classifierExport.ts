import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import type { GraphNode } from "@/types/graph.types"
import { isNucleiClassifyModelId, isTissueClassifyModelId } from "@/utils/agent/graph/constants"
import { getContentStringValue } from "@/utils/agent/workflow/panelContent"

/**
 * Normalize paths sent to AI `seg/v1/classifier_file/*`: trim, backslashes → `/`,
 * collapse runs of `/`. We deliberately KEEP the leading `/` — the server's
 * `resolve_path` already distinguishes absolute (`/Users/...`, `/home/...`)
 * from storage-relative (`users/abc/...`). Stripping `^/+` here used to corrupt
 * electron-mode absolute paths into "fake relative" paths that got reburied
 * under the AI service's own STORAGE_ROOT — leading to ghost classifier files
 * and false `fail_if_exists` 409s.
 */
export function normalizePathForSegClassifierApi(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+/g, "/")
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
): string | null {
  if (!modelId) return null
  if (isNucleiClassifyModelId(modelId) || isTissueClassifyModelId(modelId)) return modelId
  return null
}
