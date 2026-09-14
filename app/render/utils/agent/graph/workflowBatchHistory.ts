"use client"

import { toWorkflowZarrPath } from "@/utils/agent/workflow/pathNorm"

export type WorkflowBatchSourceMode = "folder_all" | "multi_select"
export type WorkflowBatchItemStatus = "queued" | "running" | "completed" | "error" | "skipped"
export type WorkflowBatchErrorPhase = "start" | "runtime" | "skipped"
export type WorkflowBatchAggregateStatus = "running" | "completed" | "partial_failure" | "aborted_by_user"

export interface WorkflowBatchFile {
  name: string
  path: string
}

export interface WorkflowBatchHistoryItem {
  path: string
  zarrPath: string
  status: WorkflowBatchItemStatus
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  errorMessage?: string
  errorPhase?: WorkflowBatchErrorPhase
}

export interface WorkflowBatchHistoryEntry {
  id: string
  name: string
  startedAt: number
  finishedAt?: number
  sourceMode: WorkflowBatchSourceMode
  settings: {
    stopOnFirstError: boolean
  }
  progress: {
    currentIndex: number
    total: number
    currentPath: string | null
  }
  items: WorkflowBatchHistoryItem[]
  aggregateStatus: WorkflowBatchAggregateStatus
  completedCount: number
  failedCount: number
  skippedCount: number
}

const STORAGE_KEY_PREFIX = "tissuelab_workflow_batch_history_v1"
const MAX_ENTRIES = 50

function generateId(): string {
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function resolveStorageKey(): string {
  if (typeof window === "undefined") return STORAGE_KEY_PREFIX
  try {
    const uid = window.localStorage.getItem("last_user_id")
    return uid ? `${STORAGE_KEY_PREFIX}:${uid}` : STORAGE_KEY_PREFIX
  } catch {
    return STORAGE_KEY_PREFIX
  }
}

export function workflowBatchBasename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function createWorkflowBatchHistoryEntry(params: {
  sourceMode: WorkflowBatchSourceMode
  files: WorkflowBatchFile[]
  settings: WorkflowBatchHistoryEntry["settings"]
}): WorkflowBatchHistoryEntry {
  const startedAt = Date.now()
  return {
    id: generateId(),
    name: `Batch ${new Date(startedAt).toLocaleString()}`,
    startedAt,
    sourceMode: params.sourceMode,
    settings: params.settings,
    progress: {
      currentIndex: 0,
      total: params.files.length,
      currentPath: null,
    },
    items: params.files.map((file) => ({
      path: file.path,
      zarrPath: toWorkflowZarrPath(file.path),
      status: "queued",
    })),
    aggregateStatus: "running",
    completedCount: 0,
    failedCount: 0,
    skippedCount: 0,
  }
}

export function loadWorkflowBatchHistory(): WorkflowBatchHistoryEntry[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(resolveStorageKey())
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveWorkflowBatchHistory(entries: WorkflowBatchHistoryEntry[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(resolveStorageKey(), JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    // Best effort only; batch execution should never fail because history storage is full.
  }
}

export function upsertWorkflowBatchHistoryEntry(
  entries: WorkflowBatchHistoryEntry[],
  entry: WorkflowBatchHistoryEntry
): WorkflowBatchHistoryEntry[] {
  return [entry, ...entries.filter((item) => item.id !== entry.id)].slice(0, MAX_ENTRIES)
}

export function clearWorkflowBatchHistory(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(resolveStorageKey())
  } catch {
    // ignore
  }
}

/** Remove legacy unscoped + all uid-scoped history keys (logout / account switch). */
export function clearAllWorkflowBatchHistory(): void {
  if (typeof window === "undefined") return
  try {
    const toRemove: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key && (key === STORAGE_KEY_PREFIX || key.startsWith(`${STORAGE_KEY_PREFIX}:`))) {
        toRemove.push(key)
      }
    }
    for (const key of toRemove) window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}
