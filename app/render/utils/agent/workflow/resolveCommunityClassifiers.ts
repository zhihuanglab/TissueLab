/**
 * Download every `community:<id>` classifier referenced by a workflow's
 * panel states and rewrite the panels in place to point at the freshly
 * written local copies. Pure utility — no React hooks, no Redux, no
 * viewer state — so it can be called from Cohort Analysis as well as
 * from the Image Viewer's WorkflowGraph (the Image Viewer keeps its
 * own resolver for now because it threads in viewer-specific toasts /
 * loading modals; behaviour matches one-to-one).
 *
 * Caller hands in:
 *   - panelStates + nodes from the chosen workflow
 *   - the destination folder where `.tlcls` files should land
 *
 * Returns the rewritten panel states plus counts so the caller can
 * tell the user "downloaded 3/4 classifiers — one failed". On
 * complete failure the original panel states are returned untouched
 * so the caller can decide to block the run or proceed with whatever
 * still resolves.
 */

import type { GraphNode } from "@/types/graph.types"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { classifiersService } from "@/services/classifier/community"
import { saveClassifierFileOnServer } from "@/services/classifier/storage"
import {
  extractClassifierPathRefs,
  rewriteCommunityRefsToLocalPaths,
  rewriteLoadedClassifierRefsToLocalInNodes,
} from "@/utils/agent/workflow/publishScan"
import { normalizePathForSegClassifierApi } from "@/utils/agent/graph/classifierExport"

export interface ResolveCommunityClassifiersOptions {
  panelStates: Record<string, WorkflowPanel>
  nodes: GraphNode[]
  /** Folder where downloaded `.tlcls` files are written. Storage-relative
   *  (`samples/...`) or absolute — same rules as the seg classifier
   *  API expects. The function joins `<folder>/<file>` itself. */
  destinationFolder: string
  /** When true, paths sent to the seg API are normalized via
   *  `normalizePathForSegClassifierApi` (web-mode convention). Defaults
   *  to true when `window.electron` is absent so the browser build
   *  works out of the box. */
  isWebMode?: boolean
  onProgress?: (done: number, total: number) => void
}

export interface ResolveCommunityClassifiersResult {
  /** Rewritten panel states — same identity as input when no refs were
   *  rewritten (zero matches or every download failed). */
  panelStates: Record<string, WorkflowPanel>
  /** Rewritten nodes — `loadedClassifier.path` updated to point at the
   *  freshly-downloaded UUID local copies so the audit snapshot matches
   *  what's on disk. Same identity as input when nothing was rewritten. */
  nodes: GraphNode[]
  /** Unique community refs successfully downloaded + rewritten. */
  downloaded: number
  /** Refs that errored. These are NOT rewritten and remain as
   *  `community:<id>` literals in the returned panel states. */
  failed: number
  /** Total unique community refs the function tried to resolve. */
  totalRefs: number
  /** Per-communityId failure messages, for surfacing in toasts. */
  errors: Record<string, string>
}

function detectWebMode(explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit
  if (typeof window === "undefined") return true
  return !(window as any).electron
}

function joinPath(folder: string, fileName: string): string {
  const sep = folder.includes("\\") ? "\\" : "/"
  const trimmed = folder.replace(/[/\\]+$/, "")
  return `${trimmed}${sep}${fileName}`
}

export async function resolveCommunityClassifiers(
  opts: ResolveCommunityClassifiersOptions,
): Promise<ResolveCommunityClassifiersResult> {
  const refs = extractClassifierPathRefs(opts.panelStates, opts.nodes || [])

  // Unique refs by raw path — the same shared classifier referenced by
  // multiple nodes should only download once.
  const refPathToId = new Map<string, string>()
  for (const r of refs) {
    if (r.kind !== "community" || !r.communityId) continue
    if (!refPathToId.has(r.path)) refPathToId.set(r.path, r.communityId)
  }
  const totalRefs = refPathToId.size
  if (totalRefs === 0) {
    return {
      panelStates: opts.panelStates,
      nodes: opts.nodes,
      downloaded: 0,
      failed: 0,
      totalRefs: 0,
      errors: {},
    }
  }

  const webMode = detectWebMode(opts.isWebMode)
  const errors: Record<string, string> = {}
  const refPathToLocalPath = new Map<string, string>()

  let done = 0
  for (const [refPath, communityId] of refPathToId.entries()) {
    done += 1
    opts.onProgress?.(done, totalRefs)
    try {
      const { bytes, fileName: cloudFileName } =
        await classifiersService.downloadClassifier(communityId)
      // Cloud filename wins. Legacy `download-link` responses without
      // file_name fall back to `<communityId>.tlcls` so re-downloads of
      // the same id are idempotent.
      const fileName =
        cloudFileName ||
        (communityId.toLowerCase().endsWith(".tlcls")
          ? communityId
          : `${communityId}.tlcls`)
      const destFull = joinPath(opts.destinationFolder, fileName)
      const apiPath = webMode
        ? normalizePathForSegClassifierApi(destFull)
        : destFull.replace(/\\/g, "/")

      // Base64-encode in chunks to avoid `Maximum call stack size`
      // when the classifier weights are large.
      let binary = ""
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      await saveClassifierFileOnServer(
        { path: apiPath, content_base64: btoa(binary) },
      )
      refPathToLocalPath.set(refPath, destFull)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors[communityId] = message
    }
  }

  if (refPathToLocalPath.size === 0) {
    return {
      panelStates: opts.panelStates,
      nodes: opts.nodes,
      downloaded: 0,
      failed: totalRefs,
      totalRefs,
      errors,
    }
  }

  const rewritten = rewriteCommunityRefsToLocalPaths(
    opts.panelStates,
    refPathToLocalPath,
  ) as unknown as Record<string, WorkflowPanel>
  const rewrittenNodes = rewriteLoadedClassifierRefsToLocalInNodes(
    opts.nodes,
    refPathToLocalPath,
  )

  return {
    panelStates: rewritten,
    nodes: rewrittenNodes,
    downloaded: refPathToLocalPath.size,
    failed: totalRefs - refPathToLocalPath.size,
    totalRefs,
    errors,
  }
}
