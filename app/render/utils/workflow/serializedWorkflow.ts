/**
 * Shared validation for localStorage / file workflow snapshots (Agentic AI graph + panelStates + chat).
 * Must stay aligned with {@link communityWorkflowsDefault} graph shape and WorkflowGraph save format.
 */

export const WORKFLOW_GRAPH_SAVED_STORAGE_KEY = "tl.workflowGraph.saved"

/** Same-tab listeners (storage event only fires across tabs). */
export const WORKFLOW_LOCAL_STORAGE_CHANGED_EVENT = "tl-workflow-local-storage-changed"

export function notifyWorkflowLocalStorageChanged(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(WORKFLOW_LOCAL_STORAGE_CHANGED_EVENT))
}

export type WriteSavedWorkflowsResult = { ok: true } | { ok: false; reason: "quota" | "unknown" }

/**
 * Loosely typed payload boundary: node/connection shapes are enforced at use sites (e.g. GraphNode).
 */
export interface SerializedWorkflow {
  name: string
  nodes: unknown[]
  connections: unknown[]
  savedAt: string
  panelStates: Record<string, unknown>
  chatMessages: unknown[]
  selectedId: string | null
  description?: string
  author?: string
  tags?: string[]
}

export function isSerializedWorkflow(x: unknown): x is SerializedWorkflow {
  if (!x || typeof x !== "object") return false
  const o = x as Record<string, unknown>
  if (typeof o.name !== "string" || typeof o.savedAt !== "string") return false
  if (!Array.isArray(o.nodes) || !Array.isArray(o.connections)) return false
  if (!o.panelStates || typeof o.panelStates !== "object" || Array.isArray(o.panelStates)) return false
  if (!Array.isArray(o.chatMessages)) return false
  if (!(o.selectedId === null || typeof o.selectedId === "string")) return false
  return true
}

export function loadAllSavedWorkflows(): Record<string, SerializedWorkflow> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(WORKFLOW_GRAPH_SAVED_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, SerializedWorkflow> = {}
    for (const [key, entry] of Object.entries(parsed)) {
      if (isSerializedWorkflow(entry)) out[key] = entry
    }
    return out
  } catch {
    return {}
  }
}

export function writeAllSavedWorkflows(data: Record<string, SerializedWorkflow>): WriteSavedWorkflowsResult {
  if (typeof window === "undefined") return { ok: false, reason: "unknown" }
  try {
    window.localStorage.setItem(WORKFLOW_GRAPH_SAVED_STORAGE_KEY, JSON.stringify(data))
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const quota = /quota|QuotaExceeded|NS_ERROR_DOM_QUOTA_REACHED/i.test(msg)
    return { ok: false, reason: quota ? "quota" : "unknown" }
  }
}

/** Library keys in `tl.workflowGraph.saved` match WorkflowGraph save names; avoid collisions on import. */
export function uniqueSavedWorkflowStorageKey(
  base: string,
  existing: Record<string, SerializedWorkflow>
): string {
  const trimmed = base.trim() || "Imported workflow"
  if (!existing[trimmed]) return trimmed
  let i = 2
  while (existing[`${trimmed} (${i})`]) i += 1
  return `${trimmed} (${i})`
}

export type ImportWorkflowToLibraryResult =
  | { ok: true; storageKey: string }
  | { ok: false; reason: "quota" | "unknown" }

/** Append a snapshot to the Agentic AI local library (`tl.workflowGraph.saved`). */
export function importWorkflowSnapshotToLocalLibrary(snapshot: SerializedWorkflow): ImportWorkflowToLibraryResult {
  const all = loadAllSavedWorkflows()
  const key = uniqueSavedWorkflowStorageKey(snapshot.name, all)
  /** Always stamp local time so the library shows import time, not the preset's original `savedAt`. */
  const entry: SerializedWorkflow = {
    ...snapshot,
    name: key,
    savedAt: new Date().toISOString(),
  }
  all[key] = entry
  const wrote = writeAllSavedWorkflows(all)
  if (!wrote.ok) return wrote
  notifyWorkflowLocalStorageChanged()
  return { ok: true, storageKey: key }
}

/** Current Agentic AI graph editing session (tab switch / in-app navigation; cleared when tab closes). */
export const WORKFLOW_GRAPH_SESSION_DRAFT_KEY = "tl.workflowGraph.sessionDraft"

export type WorkflowGraphSessionBottomMode = "none" | "chat" | "config"

export interface WorkflowGraphSessionDraftV1 {
  version: 1
  workflows: Array<{
    id: string
    name: string
    nodes: unknown[]
    connections: unknown[]
    selectedId: string | null
  }>
  activeWfId: string
  panelStates: Record<string, unknown>
  bottomMode: WorkflowGraphSessionBottomMode
  chatMessages: unknown[]
}

export function isWorkflowGraphSessionDraftV1(x: unknown): x is WorkflowGraphSessionDraftV1 {
  if (!x || typeof x !== "object") return false
  const o = x as Record<string, unknown>
  if (o.version !== 1) return false
  if (!Array.isArray(o.workflows) || o.workflows.length === 0) return false
  if (typeof o.activeWfId !== "string") return false
  if (!o.panelStates || typeof o.panelStates !== "object" || Array.isArray(o.panelStates)) return false
  if (o.bottomMode !== "none" && o.bottomMode !== "chat" && o.bottomMode !== "config") return false
  if (!Array.isArray(o.chatMessages)) return false
  for (const w of o.workflows as unknown[]) {
    if (!w || typeof w !== "object") return false
    const wf = w as Record<string, unknown>
    if (typeof wf.id !== "string" || typeof wf.name !== "string") return false
    if (!Array.isArray(wf.nodes) || !Array.isArray(wf.connections)) return false
    if (!(wf.selectedId === null || typeof wf.selectedId === "string")) return false
  }
  if (!(o.workflows as { id: string }[]).some((w) => w.id === o.activeWfId)) return false
  return true
}

export function readWorkflowGraphSessionDraft(): WorkflowGraphSessionDraftV1 | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(WORKFLOW_GRAPH_SESSION_DRAFT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isWorkflowGraphSessionDraftV1(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export function writeWorkflowGraphSessionDraft(draft: WorkflowGraphSessionDraftV1): void {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(WORKFLOW_GRAPH_SESSION_DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // Quota or private mode — ignore
  }
}
