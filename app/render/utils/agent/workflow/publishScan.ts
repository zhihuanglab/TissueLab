/**
 * Helpers for "Publish workflow to community":
 *  - find every classifier_path referenced by panelStates
 *  - classify each as already-published (carry the community id) vs local file
 *    that needs uploading first
 *  - after upload, rewrite local paths to `community:<id>` refs in a clone
 */

import type { GraphNode, LoadedClassifierRef } from "@/types/graph.types"
import type { WorkflowPanel, ContentItem } from "@/store/slices/chat/workflowSlice"

export const COMMUNITY_CLASSIFIER_REF_PREFIX = "community:"

export interface ClassifierPathRef {
  /** panelStates key (== node id for graph nodes) */
  nodeId: string
  /** Raw classifier_path value as found in panel content. */
  path: string
  /** Pretty name for the confirmation dialog — falls back to file basename. */
  displayName: string
  /** "community" when this is already a community ref or maps to a known communityId on the node.
   *  "local" otherwise (a local file that has to be uploaded before publish). */
  kind: "community" | "local"
  /** Set when kind === "community" */
  communityId?: string
}

const isString = (v: unknown): v is string => typeof v === "string"

const fileBasename = (p: string): string => {
  const normalized = p.replace(/\\/g, "/")
  const idx = normalized.lastIndexOf("/")
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

/** Parse "community:uploaded-12345" → "uploaded-12345"; null otherwise. */
export function parseCommunityRef(path: string): string | null {
  if (!path.startsWith(COMMUNITY_CLASSIFIER_REF_PREFIX)) return null
  const rest = path.slice(COMMUNITY_CLASSIFIER_REF_PREFIX.length).trim()
  return rest || null
}

function findClassifierPathItem(content: ContentItem[]): ContentItem | undefined {
  return content.find((c) => c.key === "classifier_path")
}

function findDisplayNameItem(content: ContentItem[]): ContentItem | undefined {
  return content.find((c) => c.key === "classifier_display_name")
}

/**
 * Walk every panelState entry, return one descriptor per node that has a
 * non-empty `classifier_path`. Nodes with no classifier_path are skipped —
 * an unconfigured model node is publishable, the importer will set their own.
 */
export function extractClassifierPathRefs(
  panelStates: Record<string, WorkflowPanel>,
  nodes: GraphNode[]
): ClassifierPathRef[] {
  const nodeById = new Map<string, GraphNode>()
  for (const n of nodes) nodeById.set(n.id, n)

  const refs: ClassifierPathRef[] = []
  for (const [nodeId, panel] of Object.entries(panelStates)) {
    const content = Array.isArray(panel?.content) ? panel.content : []
    const pathItem = findClassifierPathItem(content)
    const rawPath = pathItem && isString(pathItem.value) ? pathItem.value.trim() : ""
    if (!rawPath) continue

    const displayItem = findDisplayNameItem(content)
    const displayName =
      (displayItem && isString(displayItem.value) && displayItem.value.trim()) ||
      fileBasename(rawPath)

    const communityRefId = parseCommunityRef(rawPath)
    if (communityRefId) {
      refs.push({ nodeId, path: rawPath, displayName, kind: "community", communityId: communityRefId })
      continue
    }

    const node = nodeById.get(nodeId)
    const loaded: LoadedClassifierRef | undefined = node?.loadedClassifier
    if (loaded?.source === "community" && loaded.communityId && loaded.path === rawPath) {
      refs.push({ nodeId, path: rawPath, displayName, kind: "community", communityId: loaded.communityId })
      continue
    }

    refs.push({ nodeId, path: rawPath, displayName, kind: "local" })
  }
  return refs
}

/**
 * Apply `localPath → community:<id>` substitutions to a CLONE of panelStates.
 * Does not mutate the input. Refs already in `community:` form are left as-is.
 */
export function rewriteClassifierPathsInPanelStates(
  panelStates: Record<string, WorkflowPanel>,
  pathToCommunityId: Map<string, string>
): Record<string, WorkflowPanel> {
  return rewriteClassifierPathsWith(panelStates, (current) => {
    const id = pathToCommunityId.get(current)
    return id ? `${COMMUNITY_CLASSIFIER_REF_PREFIX}${id}` : null
  })
}

/**
 * Apply `community:<id> → /local/path` substitutions on import. Mirror of the
 * publish-side rewrite — accepts pre-resolved local paths keyed by community ref
 * (NOT by id alone, so that "community:" prefix doesn't leak elsewhere).
 */
export function rewriteCommunityRefsToLocalPaths(
  panelStates: Record<string, WorkflowPanel>,
  communityRefToLocalPath: Map<string, string>
): Record<string, WorkflowPanel> {
  return rewriteClassifierPathsWith(panelStates, (current) => communityRefToLocalPath.get(current) ?? null)
}

/**
 * Mirror of `rewriteClassifierPathsInPanelStates` for graph nodes' audit
 * snapshot. Without this the published workflow doc still carries the
 * original author's local file path inside `loadedClassifier.path` — a
 * personal detail that's meaningless to importers and surprises owners who
 * inspect the Firestore doc. Clones nodes; does not mutate input.
 */
export function rewriteLoadedClassifierPathsInNodes(
  nodes: GraphNode[],
  pathToCommunityId: Map<string, string>
): GraphNode[] {
  return nodes.map((n) => {
    const loaded: LoadedClassifierRef | undefined = n.loadedClassifier
    if (!loaded || !isString(loaded.path)) return n
    const trimmed = loaded.path.trim()
    const id = pathToCommunityId.get(trimmed)
    if (!id) return n
    return {
      ...n,
      loadedClassifier: {
        ...loaded,
        path: `${COMMUNITY_CLASSIFIER_REF_PREFIX}${id}`,
      },
    }
  })
}

/**
 * Mirror of `rewriteCommunityRefsToLocalPaths` for graph nodes' audit
 * snapshot. Used on import so the freshly-downloaded UUID local path also
 * lands in `loadedClassifier.path`, not just in `panelStates`'s
 * `classifier_path` content item. Clones nodes; does not mutate input.
 */
export function rewriteLoadedClassifierRefsToLocalInNodes(
  nodes: GraphNode[],
  communityRefToLocalPath: Map<string, string>
): GraphNode[] {
  return nodes.map((n) => {
    const loaded: LoadedClassifierRef | undefined = n.loadedClassifier
    if (!loaded || !isString(loaded.path)) return n
    const local = communityRefToLocalPath.get(loaded.path.trim())
    if (!local) return n
    return {
      ...n,
      loadedClassifier: {
        ...loaded,
        path: local,
      },
    }
  })
}

/**
 * Pre-Run check: collect every panel whose `classifier_path` is still a raw
 * `community:<id>` ref. This means the import auto-download failed (or the
 * classifier was deleted from community after the workflow was published).
 * Running with a `community:` literal would just blow up server-side, so the
 * caller should block Run and ask the user to load a replacement.
 */
export function findUnresolvedCommunityClassifierRefs(
  panels: ReadonlyArray<WorkflowPanel>
): { panelId: string; displayName: string; communityId: string }[] {
  const out: { panelId: string; displayName: string; communityId: string }[] = []
  for (const panel of panels) {
    const content = Array.isArray(panel?.content) ? panel.content : []
    const pathItem = content.find((c) => c.key === "classifier_path")
    const rawPath = pathItem && typeof pathItem.value === "string" ? pathItem.value.trim() : ""
    if (!rawPath) continue
    const communityId = parseCommunityRef(rawPath)
    if (!communityId) continue
    const displayItem = content.find((c) => c.key === "classifier_display_name")
    const displayName =
      (displayItem && typeof displayItem.value === "string" && displayItem.value.trim()) ||
      `community:${communityId}`
    out.push({ panelId: panel.id, displayName, communityId })
  }
  return out
}

/**
 * Drop personal/user-specific content keys from every panel before publishing.
 * Returns a clone; does not mutate input.
 *
 * Currently called with at least:
 *  - `save_classifier_path` — a WRITE destination on the original author's disk
 *  - `path` — the absolute slide path the author had open (the runtime injects
 *    `currentPath` per-importer, so this baked-in value would just leak)
 */
export function stripContentKeysInPanelStates(
  panelStates: Record<string, WorkflowPanel>,
  keysToRemove: ReadonlyArray<string>
): Record<string, WorkflowPanel> {
  const removeSet = new Set(keysToRemove)
  const out: Record<string, WorkflowPanel> = {}
  for (const [nodeId, panel] of Object.entries(panelStates)) {
    const clonedPanel = JSON.parse(JSON.stringify(panel)) as WorkflowPanel
    if (Array.isArray(clonedPanel.content)) {
      clonedPanel.content = clonedPanel.content.filter((item) => !removeSet.has(item.key))
    }
    out[nodeId] = clonedPanel
  }
  return out
}

/**
 * Generic walker — clones panelStates and lets the caller rewrite each
 * classifier_path value. Returning null leaves the value untouched.
 */
function rewriteClassifierPathsWith(
  panelStates: Record<string, WorkflowPanel>,
  rewrite: (currentValue: string) => string | null
): Record<string, WorkflowPanel> {
  const out: Record<string, WorkflowPanel> = {}
  for (const [nodeId, panel] of Object.entries(panelStates)) {
    const clonedPanel = JSON.parse(JSON.stringify(panel)) as WorkflowPanel
    if (Array.isArray(clonedPanel.content)) {
      clonedPanel.content = clonedPanel.content.map((item) => {
        if (item.key !== "classifier_path" || !isString(item.value)) return item
        const next = rewrite(item.value.trim())
        return next == null ? item : { ...item, value: next }
      })
    }
    out[nodeId] = clonedPanel
  }
  return out
}
