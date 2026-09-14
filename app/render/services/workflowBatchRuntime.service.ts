/**
 * Backend-owned workflow batch queue mirror.
 * Survives WorkflowGraph unmount; mount restore + shared SSE bridge drive the banner UI.
 */
import { toast } from 'sonner'

import {
  mapBatchSnapshotToHistoryEntry,
  startBatch,
  stopBatch,
  subscribeBatchEventsBridge,
  type BatchSnapshot,
  type StartBatchItem,
} from '@/services/batchApi.service'
import { store } from '@/store'
import {
  loadWorkflowBatchHistory,
  saveWorkflowBatchHistory,
  upsertWorkflowBatchHistoryEntry,
  type WorkflowBatchHistoryEntry,
} from '@/utils/agent/graph/workflowBatchHistory'
import { stripZarrSuffix, workflowZarrPathsMatch } from '@/utils/agent/workflow/pathNorm'
import { STOP_WORKFLOW_UI_TIMEOUT_MS } from '@/utils/agent/workflow/runtimeStatus'
import eventBus from '@/utils/common/eventBus'
import { selectActiveSlidePath } from '@/utils/viewer/slidePath'

// ─── types ───────────────────────────────────────────────────────────

export type WorkflowBatchRuntimeSnapshot = {
  entry: WorkflowBatchHistoryEntry | null
  isRunning: boolean
  isStopping: boolean
}

type Listener = (snap: WorkflowBatchRuntimeSnapshot) => void

// ─── module state ────────────────────────────────────────────────────

let entry: WorkflowBatchHistoryEntry | null = null
let isStopping = false
let stopUnlockTimer: ReturnType<typeof setTimeout> | null = null
let unsubEvents: (() => void) | null = null
let lastPersistKey = ''
const listeners = new Set<Listener>()
/** Stable for useSyncExternalStore — must not allocate a new object on every getSnapshot. */
let cachedSnap: WorkflowBatchRuntimeSnapshot = {
  entry: null,
  isRunning: false,
  isStopping: false,
}

/**
 * While true, per-file workflow completion must not forceReload the viewer —
 * the batch settle path owns that single refresh.
 */
let batchHoldingViewerReload = false

// ─── private helpers ─────────────────────────────────────────────────

function isBatchRunning(): boolean {
  return entry?.aggregateStatus === 'running'
}

function emit() {
  cachedSnap = { entry, isRunning: isBatchRunning(), isStopping }
  listeners.forEach((fn) => {
    try {
      fn(cachedSnap)
    } catch {
      /* ignore */
    }
  })
}

function clearStopUnlockTimer() {
  if (stopUnlockTimer == null) return
  clearTimeout(stopUnlockTimer)
  stopUnlockTimer = null
}

/** Clear Stopping... flag and its unlock timer together. */
function endStopping() {
  isStopping = false
  clearStopUnlockTimer()
}

/** Skip localStorage writes on progressPct-only SSE frames. */
function batchPersistKey(snap: BatchSnapshot): string {
  const items = (snap.items || []).map((i) => `${i.path}:${i.status}`).join(',')
  return `${snap.id}:${snap.aggregateStatus}:${snap.progress?.currentIndex ?? 0}:${snap.progress?.currentPath ?? ''}:${snap.completedCount ?? 0}:${snap.failedCount ?? 0}:${snap.skippedCount ?? 0}:${items}`
}

function persistHistory(next: WorkflowBatchHistoryEntry) {
  entry = next
  saveWorkflowBatchHistory(upsertWorkflowBatchHistoryEntry(loadWorkflowBatchHistory(), next))
  emit()
  return next
}

/**
 * Release the viewer-reload hold. When ``batchEntry`` is set and the open slide
 * was in the batch, emit one WS forceReload first.
 */
function endBatchViewerReloadHold(batchEntry?: WorkflowBatchHistoryEntry | null) {
  try {
    if (!batchEntry) return
    const path = selectActiveSlidePath(store.getState())
    if (!path) return
    const inBatch = (batchEntry.items || []).some(
      (item) =>
        workflowZarrPathsMatch(item.path, path) || workflowZarrPathsMatch(item.zarrPath, path)
    )
    if (!inBatch) return
    eventBus.emit('refresh-websocket-path', {
      path: stripZarrSuffix(path),
      forceReload: true,
    })
  } finally {
    batchHoldingViewerReload = false
  }
}

function stopEvents() {
  if (!unsubEvents) return
  unsubEvents()
  unsubEvents = null
}

function startEvents() {
  if (typeof window === 'undefined' || unsubEvents) return
  unsubEvents = subscribeBatchEventsBridge(
    ({ active, batch }) => {
      if (batch && (batch.source || 'workflow') === 'workflow') {
        applyServerBatch(batch, !active)
        return
      }
      // Ignore idle/null reconnect frames; final workflow snapshot always carries batch.
      if (!batch) return
      if (isBatchRunning()) markAborted()
    },
    isBatchRunning,
  )
}

function markAborted() {
  if (!entry || entry.aggregateStatus !== 'running') {
    endStopping()
    stopEvents()
    endBatchViewerReloadHold()
    emit()
    return
  }
  endStopping()
  lastPersistKey = ''
  stopEvents()
  persistHistory({
    ...entry,
    finishedAt: entry.finishedAt || Date.now(),
    aggregateStatus: 'aborted_by_user',
    progress: { ...entry.progress, currentPath: null },
  })
  endBatchViewerReloadHold(entry)
}

function applyServerBatch(snap: BatchSnapshot, announceFinish = false) {
  const key = batchPersistKey(snap)
  if (key === lastPersistKey && !announceFinish) return
  lastPersistKey = key

  const prevStatus = entry?.aggregateStatus
  // Keep display name/sourceMode across FE-temp → server-id swap.
  const base =
    entry && (entry.id === snap.id || entry.aggregateStatus === 'running') ? entry : null
  const mapped = mapBatchSnapshotToHistoryEntry(snap, base)
  if (mapped.aggregateStatus !== 'running') {
    endStopping()
    stopEvents()
  }
  persistHistory(mapped)
  if (announceFinish && prevStatus === 'running' && mapped.aggregateStatus !== 'running') {
    if (mapped.aggregateStatus === 'completed') toast.success('Batch processing completed.')
    else if (mapped.aggregateStatus === 'aborted_by_user') toast.message('Batch processing stopped.')
    else toast.info('Batch processing finished with errors.')
    // Mid-batch completions skip forceReload; refresh once when the queue settles.
    endBatchViewerReloadHold(mapped)
  }
}

// ─── public API ──────────────────────────────────────────────────────

/** True while a workflow batch should suppress per-file completion forceReload. */
export function isBatchHoldingViewerReload(): boolean {
  return batchHoldingViewerReload
}

export function getWorkflowBatchRuntimeSnapshot(): WorkflowBatchRuntimeSnapshot {
  return cachedSnap
}

export function subscribeWorkflowBatchRuntime(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Drop in-memory batch UI (logout / account switch). Does not write history. */
export function resetWorkflowBatchRuntime(): void {
  stopEvents()
  entry = null
  endStopping()
  lastPersistKey = ''
  endBatchViewerReloadHold()
  emit()
}

/** Hide finished batch banner without deleting localStorage history. */
export function dismissWorkflowBatchRuntimeEntry(): void {
  if (isBatchRunning()) return
  entry = null
  endStopping()
  lastPersistKey = ''
  stopEvents()
  endBatchViewerReloadHold()
  emit()
}

/** Apply an already-fetched batch/active payload (shared restore with pre-run runtime). */
export function adoptWorkflowActiveBatch(info: { active: boolean; batch: BatchSnapshot | null }): void {
  const { active, batch } = info
  // Only rehydrate an in-progress batch. Finished snapshots must not revive the
  // completion banner after the user dismissed it / refreshed.
  if (active && batch && (batch.source || 'workflow') === 'workflow') {
    batchHoldingViewerReload = true
    applyServerBatch(batch, false)
    startEvents()
    return
  }
  if (isBatchRunning()) markAborted()
}

export async function submitWorkflowBatch(params: {
  items: StartBatchItem[]
  stopOnFirstError: boolean
  historyBase: WorkflowBatchHistoryEntry
}): Promise<WorkflowBatchHistoryEntry> {
  // In-memory only until the server assigns an id — avoids localStorage ghosts
  // from the FE-generated id when start_batch returns a different id.
  entry = { ...params.historyBase, aggregateStatus: 'running' }
  batchHoldingViewerReload = true
  emit()

  try {
    const batch = await startBatch({
      items: params.items,
      stopOnFirstError: params.stopOnFirstError,
      source: 'workflow',
    })
    applyServerBatch(batch, false)
    startEvents()
    return entry!
  } catch (error) {
    markAborted()
    throw error
  }
}

export async function requestStopWorkflowBatch(): Promise<void> {
  if (isStopping) return
  isStopping = true
  emit()
  clearStopUnlockTimer()
  stopUnlockTimer = setTimeout(() => {
    if (!isStopping) return
    endStopping()
    emit()
    toast.error('Batch stop timed out. You can try again.')
  }, STOP_WORKFLOW_UI_TIMEOUT_MS)
  try {
    const batch = await stopBatch()
    if (batch) {
      applyServerBatch(batch, false)
      // Still running + stopping: keep isStopping until SSE finishes or timer unlocks.
      return
    }
    // No batch payload — mark local done; SSE may still push a final frame if anything is finishing.
    markAborted()
  } catch (error) {
    endStopping()
    emit()
    throw error
  }
}
