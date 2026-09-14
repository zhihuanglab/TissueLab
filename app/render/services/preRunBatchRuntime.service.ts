/**
 * CellCast pre-run batch runtime (source=pre_run).
 * Mirrors backend queue via shared SSE bridge; survives dashboard navigations.
 */
import { toast } from 'sonner'

import {
  appendBatch,
  startBatch,
  subscribeBatchEventsBridge,
  type BatchSnapshot,
  type StartBatchItem,
} from '@/services/batchApi.service'
import type { FileTaskState } from '@/types/fileTask.types'
import { toWorkflowZarrPath } from '@/utils/agent/workflow/pathNorm'
import { ApiError, getErrorMessage } from '@/utils/common/apiResponse'

export type PreRunState = FileTaskState & { label?: string }
export type PreRunStateMap = Record<string, PreRunState>

export type PreRunBatchRuntimeSnapshot = {
  states: PreRunStateMap
  minimized: boolean
}

type Listener = (snap: PreRunBatchRuntimeSnapshot) => void

let states: PreRunStateMap = {}
let minimized = false
let unsubEvents: (() => void) | null = null
/** Serialize start/append so rapid enqueues cannot both call startBatch (409 race). */
let submitQueue: Promise<void> = Promise.resolve()
const listeners = new Set<Listener>()
/** Stable for useSyncExternalStore — must not allocate a new object on every getSnapshot. */
let cachedSnap: PreRunBatchRuntimeSnapshot = { states: {}, minimized: false }

function emit() {
  cachedSnap = { states: { ...states }, minimized }
  listeners.forEach((fn) => {
    try {
      fn(cachedSnap)
    } catch {
      /* ignore */
    }
  })
}

function mapPreRunBatchToStates(batch: BatchSnapshot, prev: PreRunStateMap = {}): PreRunStateMap {
  const next: PreRunStateMap = {}
  for (const item of batch.items || []) {
    const prevRow = prev[item.path]
    const livePct =
      typeof item.progressPct === 'number' && Number.isFinite(item.progressPct)
        ? Math.max(0, Math.min(100, Math.round(item.progressPct)))
        : null

    if (item.status === 'running') {
      next[item.path] = {
        status: 'running',
        progress: Math.max(prevRow?.progress ?? 0, livePct ?? 1),
        label: 'Processing…',
        error: null,
        startedAt: item.startedAt ?? prevRow?.startedAt,
        completedAt: prevRow?.completedAt,
      }
    } else if (item.status === 'completed') {
      next[item.path] = {
        status: 'completed',
        progress: 100,
        label: 'Done',
        error: null,
        startedAt: item.startedAt ?? prevRow?.startedAt,
        completedAt: item.finishedAt ?? prevRow?.completedAt,
      }
    } else if (item.status === 'error' || item.status === 'skipped') {
      next[item.path] = {
        status: 'error',
        progress: 0,
        label: item.status === 'skipped' ? 'Stopped' : 'Error',
        error: item.errorMessage || (item.status === 'skipped' ? 'skipped' : 'failed'),
        startedAt: item.startedAt ?? prevRow?.startedAt,
        completedAt: item.finishedAt ?? prevRow?.completedAt,
      }
    } else {
      next[item.path] = {
        status: 'queued',
        progress: 0,
        label: 'Queued',
        error: null,
        startedAt: prevRow?.startedAt,
      }
    }
  }
  return next
}

/** Keep optimistic local rows that aren't on the server yet (append in flight). */
function mergeOptimisticPreRunStates(prev: PreRunStateMap, mapped: PreRunStateMap): PreRunStateMap {
  const next = { ...mapped }
  for (const [path, st] of Object.entries(prev)) {
    if (next[path]) continue
    if (st.status === 'queued' || st.status === 'running') next[path] = st
  }
  return next
}

function cellCastPayload(path: string): StartBatchItem {
  const zarrPath = toWorkflowZarrPath(path)
  return {
    path,
    zarr_path: zarrPath,
    payload: {
      zarr_path: zarrPath,
      step1: { nodeId: 'CellCast', input: { prompt: '', target_mpp: '', path } },
      task_dependencies: { CellCast: [] },
    },
  }
}

function notifyCompleted(wsiPath: string) {
  if (typeof window === 'undefined') return
  const normalized = wsiPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const slash = normalized.lastIndexOf('/')
  const folder = slash >= 0 ? normalized.slice(0, slash) : normalized
  window.dispatchEvent(new CustomEvent('tissuelab:preRunCompleted', { detail: { path: folder } }))
}

function hasActivePreRunRows(): boolean {
  return Object.values(states).some((st) => st.status === 'queued' || st.status === 'running')
}

function applyPreRunBatch(batch: BatchSnapshot, opts?: { notifyCompleted?: boolean }) {
  const notify = opts?.notifyCompleted !== false
  const prev = states
  const mapped = mergeOptimisticPreRunStates(prev, mapPreRunBatchToStates(batch, prev))
  // Skip no-op progress frames (same statuses + same progress numbers).
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(mapped)
  if (
    prevKeys.length === nextKeys.length &&
    nextKeys.every((path) => {
      const a = prev[path]
      const b = mapped[path]
      return a && b && a.status === b.status && a.progress === b.progress && a.error === b.error
    })
  ) {
    return
  }
  states = mapped
  if (notify) {
    for (const [path, st] of Object.entries(states)) {
      if (st.status === 'completed' && prev[path]?.status !== 'completed') notifyCompleted(path)
    }
  }
  emit()
  if (!hasActivePreRunRows()) stopEvents()
}

function stopEvents() {
  if (!unsubEvents) return
  unsubEvents()
  unsubEvents = null
}

function startEvents() {
  if (typeof window === 'undefined' || unsubEvents) return
  unsubEvents = subscribeBatchEventsBridge(
    ({ batch }) => {
      if (batch?.source === 'pre_run') {
        applyPreRunBatch(batch)
        return
      }
      // Ignore idle/null frames (reconnect). Only stop if another source owns the user.
      if (!batch) return
      markStuckRowsStopped()
      stopEvents()
    },
    hasActivePreRunRows,
  )
}

function markStuckRowsStopped() {
  const next = { ...states }
  let changed = false
  for (const [path, st] of Object.entries(next)) {
    if (st.status !== 'queued' && st.status !== 'running') continue
    next[path] = {
      ...st,
      status: 'error',
      label: 'Stopped',
      error: 'batch no longer active',
      completedAt: Date.now(),
    }
    changed = true
  }
  if (!changed) return
  states = next
  emit()
}

export function getPreRunBatchRuntimeSnapshot(): PreRunBatchRuntimeSnapshot {
  return cachedSnap
}

/** Drop in-memory pre-run UI (logout / account switch). */
export function resetPreRunBatchRuntime(): void {
  states = {}
  minimized = false
  stopEvents()
  emit()
}

export function subscribePreRunBatchRuntime(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Apply an already-fetched batch/active payload (shared restore with workflow runtime). */
export function adoptPreRunActiveBatch(info: { active: boolean; batch: BatchSnapshot | null }): void {
  const { active, batch } = info
  // Only restore a running pre-run queue. Completed/dismissed UI must not come
  // back on refresh from a leftover finished server snapshot.
  if (!active || batch?.source !== 'pre_run') {
    if (Object.keys(states).length > 0) {
      states = {}
      minimized = false
      stopEvents()
      emit()
    }
    return
  }
  applyPreRunBatch(batch, { notifyCompleted: false })
  startEvents()
}

/** @returns number of newly queued paths (0 if all were already queued/running). */
export function enqueuePreRunBatch(paths: string[]): number {
  if (paths.length === 0) return 0
  const fresh = paths.filter((p) => {
    const st = states[p]?.status
    return st !== 'queued' && st !== 'running'
  })
  if (fresh.length === 0) return 0

  const nextStates = { ...states }
  for (const p of fresh) {
    nextStates[p] = { status: 'queued', progress: 0, label: 'Queued', error: null }
  }
  states = nextStates
  minimized = false
  emit()
  submitQueue = submitQueue.then(() => submitPreRunItems(fresh)).catch(() => {})
  return fresh.length
}

async function submitPreRunItems(paths: string[]) {
  const items = paths.map(cellCastPayload)
  try {
    if (unsubEvents) {
      const { batch: next } = await appendBatch({ items, source: 'pre_run' })
      applyPreRunBatch(next)
      return
    }
    try {
      const started = await startBatch({
        items,
        stopOnFirstError: false,
        source: 'pre_run',
      })
      applyPreRunBatch(started)
      startEvents()
    } catch (err: unknown) {
      // Lost the race to another in-flight start — join that batch instead.
      if (!(err instanceof ApiError && err.code === 409)) throw err
      const { batch: next } = await appendBatch({ items, source: 'pre_run' })
      applyPreRunBatch(next)
      startEvents()
    }
  } catch (err: unknown) {
    const msg = getErrorMessage(err, 'Failed to start pre-run batch')
    const conflict = err instanceof ApiError && err.code === 409
    toast.error(
      conflict
        ? 'Another batch is already running. Finish or stop it before pre-run.'
        : msg,
    )
    const next = { ...states }
    for (const p of paths) {
      next[p] = {
        status: 'error',
        progress: 0,
        label: 'Error',
        error: msg,
        completedAt: Date.now(),
      }
    }
    states = next
    emit()
  }
}

export function setPreRunMinimized(value: boolean) {
  minimized = value
  emit()
}

export function dismissPreRunBatch() {
  states = {}
  minimized = false
  stopEvents()
  emit()
}
