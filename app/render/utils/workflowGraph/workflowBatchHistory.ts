"use client"

import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"

export type WorkflowBatchSourceMode = "folder_all" | "multi_select"
export type WorkflowBatchItemStatus = "queued" | "running" | "completed" | "error" | "skipped"
export type WorkflowBatchErrorPhase = "start" | "runtime" | "timeout" | "skipped"
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
  retryCount?: number
  errorMessage?: string
  errorPhase?: WorkflowBatchErrorPhase
  httpStatus?: number
  stepHint?: string
}

export interface WorkflowBatchHistoryEntry {
  id: string
  name: string
  startedAt: number
  finishedAt?: number
  sourceMode: WorkflowBatchSourceMode
  folderSnapshot?: string
  workflowFingerprint: string
  panelsSnapshot: WorkflowPanel[]
  roiSummary: { mode: "viewer_roi" | "whole_slide"; bbox?: number[] | string | null }
  settings: {
    stopOnFirstError: boolean
    skipMissingZarr: boolean
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

const STORAGE_KEY = "tissuelab_workflow_batch_history_v1"
const MAX_ENTRIES = 50

function generateId(): string {
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function workflowBatchBasename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function workflowBatchZarrPath(path: string): string {
  return path.toLowerCase().endsWith(".zarr") ? path : `${path}.zarr`
}

export function createWorkflowBatchHistoryEntry(params: {
  sourceMode: WorkflowBatchSourceMode
  folderSnapshot?: string
  files: WorkflowBatchFile[]
  panelsSnapshot: WorkflowPanel[]
  workflowFingerprint: string
  roiSummary: WorkflowBatchHistoryEntry["roiSummary"]
  settings: WorkflowBatchHistoryEntry["settings"]
}): WorkflowBatchHistoryEntry {
  const startedAt = Date.now()
  return {
    id: generateId(),
    name: `Batch ${new Date(startedAt).toLocaleString()}`,
    startedAt,
    sourceMode: params.sourceMode,
    folderSnapshot: params.folderSnapshot,
    workflowFingerprint: params.workflowFingerprint,
    panelsSnapshot: params.panelsSnapshot,
    roiSummary: params.roiSummary,
    settings: params.settings,
    progress: {
      currentIndex: 0,
      total: params.files.length,
      currentPath: null,
    },
    items: params.files.map((file) => ({
      path: file.path,
      zarrPath: workflowBatchZarrPath(file.path),
      status: "queued",
    })),
    aggregateStatus: "running",
    completedCount: 0,
    failedCount: 0,
    skippedCount: 0,
  }
}

export function summarizeWorkflowBatchEntry(entry: WorkflowBatchHistoryEntry): WorkflowBatchHistoryEntry {
  const completedCount = entry.items.filter((item) => item.status === "completed").length
  const failedCount = entry.items.filter((item) => item.status === "error").length
  const skippedCount = entry.items.filter((item) => item.status === "skipped").length
  return {
    ...entry,
    completedCount,
    failedCount,
    skippedCount,
  }
}

export function loadWorkflowBatchHistory(): WorkflowBatchHistoryEntry[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    // Best effort only; batch execution should never fail because history storage is full.
  }
}

export function upsertWorkflowBatchHistoryEntry(
  entries: WorkflowBatchHistoryEntry[],
  entry: WorkflowBatchHistoryEntry
): WorkflowBatchHistoryEntry[] {
  const next = [entry, ...entries.filter((item) => item.id !== entry.id)]
  return next.slice(0, MAX_ENTRIES)
}

export function clearWorkflowBatchHistory(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
