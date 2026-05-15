import type { ClassifierData as RemoteClassifierData } from "@/services/classifiers.service"
import { classifiersService } from "@/services/classifiers.service"
import { registryNodes, SAVED_CLASSIFIERS_KEY } from "@/utils/workflowGraph/constants"
import { modelIdFromClassifierFactory } from "@/utils/workflowGraph/registryRuntime"
import { formatPath } from "@/utils/pathUtils"
import type { CommunityClassifierOption, FolderClassifierOption, GraphNode, SerializedClassifier } from "@/utils/workflowGraph/types"

export const loadAllClassifiers = (): Record<string, SerializedClassifier> => {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(SAVED_CLASSIFIERS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, SerializedClassifier>) : {}
  } catch {
    return {}
  }
}

export const writeAllClassifiers = (data: Record<string, SerializedClassifier>) => {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(SAVED_CLASSIFIERS_KEY, JSON.stringify(data))
  } catch {
    /* ignore quota/permission errors */
  }
}

export const remoteClassifierToOption = (classifier: RemoteClassifierData): CommunityClassifierOption => ({
  id: classifier.id,
  name: classifier.title || classifier.fileName || "Untitled classifier",
  description: classifier.description || "",
  author: classifiersService.getAuthorDisplay(classifier),
  modelId: modelIdFromClassifierFactory(classifier.factory, classifier.model),
  factory: classifier.factory,
  path: classifier.localPath,
  tags: classifier.tags || [],
  savedAt: (() => {
    const createdAt = classifier.createdAt
    try {
      if (!createdAt) return undefined
      if (typeof createdAt === "object" && typeof createdAt.seconds === "number") {
        return new Date(createdAt.seconds * 1000).toISOString()
      }
      const date = new Date(createdAt)
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
    } catch {
      return undefined
    }
  })(),
})

export const classifierMatchesNode = (
  classifier: Pick<CommunityClassifierOption, "modelId" | "factory">,
  node?: GraphNode | null
) => {
  if (!node?.modelId) return true
  if (classifier.modelId === node.modelId) return true
  const nodeFactory = registryNodes[node.modelId]?.factory
  return Boolean(nodeFactory && (classifier.factory === nodeFactory || classifier.modelId === nodeFactory))
}

function looksLikeStorageRelativePath(p: string): boolean {
  const s = p.replace(/\\/g, "/").trim()
  if (!s) return false
  if (s.startsWith("users/") || s.startsWith("samples/") || s.startsWith("shared/")) return true
  return s.includes("/") || s.includes("\\")
}

function joinFolderAndClassifierFile(folder: string, fileName: string): string {
  const f = folder.replace(/[/\\]+$/, "").trim()
  const name = fileName.replace(/^[/\\]+/, "")
  if (!f) {
    return formatPath(name)
  }
  return formatPath(`${f}${f.includes("\\") ? "\\" : "/"}${name}`)
}

/**
 * Build loadable classifier rows from the file manager listing (`.tlcls` only),
 * using the same folder inference as the classification panel when `selectedFolder` is empty.
 */
export function folderClassifierOptionsFromFileList(
  fileList: Array<{ name: string; path?: string; is_dir: boolean }>,
  listingFolder: string
): FolderClassifierOption[] {
  const out: FolderClassifierOption[] = []
  const seenPaths = new Set<string>()
  for (const file of fileList) {
    if (file.is_dir) continue
    if (!file.name.toLowerCase().endsWith(".tlcls")) continue
    /** Full filename (with extension) for list title and panel display name. */
    const displayName = file.name.trim() || "classifier.tlcls"
    const raw = (file.path || "").trim()
    let fullPath = ""
    if (raw && looksLikeStorageRelativePath(raw)) {
      fullPath = formatPath(raw)
    } else {
      fullPath = joinFolderAndClassifierFile(listingFolder, file.name)
    }
    const normKey = fullPath.replace(/\\/g, "/").toLowerCase()
    if (seenPaths.has(normKey)) continue
    seenPaths.add(normKey)
    out.push({ id: fullPath, name: displayName, path: fullPath })
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  return out
}
