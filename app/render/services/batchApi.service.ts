/**
 * AI Service batch HTTP client + shared SSE EventSource bridge
 * (workflow / pre_run share one connection; fan-out filters by source).
 */
import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config'
import type { WorkflowBatchHistoryEntry, WorkflowBatchHistoryItem } from '@/utils/agent/graph/workflowBatchHistory'
import { apiFetch } from '@/utils/common/apiFetch'
import { getAuthToken } from '@/utils/common/authToken'

export type BatchSnapshot = {
  id: string
  source?: 'workflow' | 'pre_run' | string
  aggregateStatus: WorkflowBatchHistoryEntry['aggregateStatus']
  startedAt: number
  finishedAt?: number | null
  settings: {
    stopOnFirstError: boolean
  }
  progress: {
    currentIndex: number
    total: number
    currentPath: string | null
  }
  items: Array<{
    path: string
    zarrPath: string
    status: WorkflowBatchHistoryItem['status']
    executionId?: string | null
    errorMessage?: string | null
    errorPhase?: WorkflowBatchHistoryItem['errorPhase'] | null
    startedAt?: number | null
    finishedAt?: number | null
    durationMs?: number | null
    /** 0–100 from live workflow node_progress while item is running */
    progressPct?: number | null
  }>
  completedCount: number
  failedCount: number
  skippedCount: number
}

export type StartBatchItem = {
  path: string
  zarr_path: string
  payload: Record<string, unknown>
}

export type BatchSource = 'workflow' | 'pre_run'

export type BatchEventsInfo = { active: boolean; batch: BatchSnapshot | null }

export function mapBatchSnapshotToHistoryEntry(
  snap: BatchSnapshot,
  base?: Partial<WorkflowBatchHistoryEntry> | null
): WorkflowBatchHistoryEntry {
  return {
    id: snap.id,
    name: base?.name || `Batch ${new Date(snap.startedAt).toLocaleString()}`,
    startedAt: snap.startedAt,
    finishedAt: snap.finishedAt ?? undefined,
    sourceMode: base?.sourceMode || 'multi_select',
    settings: {
      stopOnFirstError: snap.settings?.stopOnFirstError ?? true,
    },
    progress: {
      currentIndex: snap.progress?.currentIndex ?? 0,
      total: snap.progress?.total ?? snap.items?.length ?? 0,
      currentPath: snap.progress?.currentPath ?? null,
    },
    items: (snap.items || []).map((item) => ({
      path: item.path,
      zarrPath: item.zarrPath,
      status: item.status,
      startedAt: item.startedAt ?? undefined,
      finishedAt: item.finishedAt ?? undefined,
      durationMs: item.durationMs ?? undefined,
      errorMessage: item.errorMessage ?? undefined,
      errorPhase: item.errorPhase ?? undefined,
    })),
    aggregateStatus: snap.aggregateStatus,
    completedCount: snap.completedCount ?? 0,
    failedCount: snap.failedCount ?? 0,
    skippedCount: snap.skippedCount ?? 0,
  }
}

export async function startBatch(params: {
  items: StartBatchItem[]
  stopOnFirstError: boolean
  source?: BatchSource
}): Promise<BatchSnapshot> {
  const data = (await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_batch`, {
    method: 'POST',
    body: JSON.stringify({
      items: params.items,
      stop_on_first_error: params.stopOnFirstError,
      source: params.source || 'workflow',
    }),
  })) as { batch?: BatchSnapshot } | null
  if (!data?.batch?.id) {
    throw new Error('Failed to start batch')
  }
  return data.batch
}

export async function appendBatch(params: {
  items: StartBatchItem[]
  source?: BatchSource
}): Promise<{ batch: BatchSnapshot; added: number }> {
  const data = (await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/batch/append`, {
    method: 'POST',
    body: JSON.stringify({
      items: params.items,
      source: params.source,
    }),
  })) as { batch?: BatchSnapshot; added?: number } | null
  if (!data?.batch?.id) {
    throw new Error('Failed to append to batch')
  }
  return { batch: data.batch, added: data.added ?? 0 }
}

export async function getActiveBatch(): Promise<{ active: boolean; batch: BatchSnapshot | null }> {
  const data = (await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/batch/active`, {
    method: 'GET',
  })) as { active?: boolean; batch?: BatchSnapshot | null } | null
  const batch = data?.batch ?? null
  return {
    active: Boolean(data?.active && batch),
    batch,
  }
}

export async function stopBatch(): Promise<BatchSnapshot | null> {
  const data = (await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/stop_batch`, {
    method: 'POST',
    body: JSON.stringify({}),
  })) as { batch?: BatchSnapshot | null } | null
  return data?.batch ?? null
}

function parseBatchSseData(raw: string): {
  kind: 'heartbeat' | 'ignore' | 'snapshot'
  active?: boolean
  batch?: BatchSnapshot | null
} {
  try {
    const payload = JSON.parse(raw || '{}') as {
      heartbeat?: boolean
      type?: string
      active?: boolean
      batch?: BatchSnapshot | null
    }
    if (payload.heartbeat === true) return { kind: 'heartbeat' }
    if (payload.type === 'snapshot' || payload.batch !== undefined || payload.active !== undefined) {
      return {
        kind: 'snapshot',
        active: Boolean(payload.active && payload.batch),
        batch: payload.batch ?? null,
      }
    }
    return { kind: 'ignore' }
  } catch {
    return { kind: 'ignore' }
  }
}

const SSE_BASE_RETRY_MS = 1000
const SSE_MAX_RETRY_MS = 30000

/**
 * Open `/tasks/v1/batch/events` SSE. Returns a closer.
 * Prefer {@link subscribeBatchEventsBridge} so workflow + pre_run share one connection.
 */
function openBatchEvents(
  onSnapshot: (info: BatchEventsInfo) => void,
  shouldReconnect: () => boolean = () => true
): () => void {
  if (typeof window === 'undefined') return () => {}

  let closed = false
  let source: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let retry = 0
  let generation = 0

  const clearReconnect = () => {
    if (!reconnectTimer) return
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const closeSource = () => {
    if (!source) return
    source.onopen = null
    source.onmessage = null
    source.onerror = null
    source.close()
    source = null
  }

  const scheduleReconnect = () => {
    if (closed || !shouldReconnect()) return
    clearReconnect()
    retry += 1
    const delay = Math.min(SSE_BASE_RETRY_MS * Math.pow(2, Math.min(retry - 1, 6)), SSE_MAX_RETRY_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  const connect = async () => {
    if (closed) return
    const gen = ++generation
    closeSource()
    let token: string | null = null
    try {
      token = await getAuthToken()
    } catch {
      token = null
    }
    if (closed || gen !== generation) return
    if (!token) {
      scheduleReconnect()
      return
    }
    const url = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/batch/events?token=${encodeURIComponent(token)}`
    const es = new EventSource(url)
    if (closed || gen !== generation) {
      es.close()
      return
    }
    source = es
    es.onopen = () => {
      if (closed || gen !== generation) return
      retry = 0
    }
    es.onmessage = (event) => {
      if (closed || gen !== generation) return
      const parsed = parseBatchSseData(event.data || '')
      if (parsed.kind !== 'snapshot') return
      onSnapshot({
        active: Boolean(parsed.active),
        batch: parsed.batch ?? null,
      })
    }
    es.onerror = () => {
      if (closed || gen !== generation) return
      closeSource()
      scheduleReconnect()
    }
  }

  void connect()

  return () => {
    closed = true
    generation += 1
    clearReconnect()
    closeSource()
  }
}

type BridgeConsumer = {
  onSnapshot: (info: BatchEventsInfo) => void
  shouldKeepAlive: () => boolean
}

const bridgeConsumers = new Set<BridgeConsumer>()
let stopBridgeConnection: (() => void) | null = null

function anyBridgeKeepAlive(): boolean {
  for (const c of bridgeConsumers) {
    if (c.shouldKeepAlive()) return true
  }
  return false
}

/** Register a runtime on the shared batch SSE. Unsub closes the socket when last consumer leaves. */
export function subscribeBatchEventsBridge(
  onSnapshot: (info: BatchEventsInfo) => void,
  shouldKeepAlive: () => boolean,
): () => void {
  const consumer: BridgeConsumer = { onSnapshot, shouldKeepAlive }
  bridgeConsumers.add(consumer)
  if (typeof window !== 'undefined' && !stopBridgeConnection) {
    stopBridgeConnection = openBatchEvents((info) => {
      for (const c of [...bridgeConsumers]) {
        try {
          c.onSnapshot(info)
        } catch {
          /* ignore */
        }
      }
    }, anyBridgeKeepAlive)
  }
  return () => {
    bridgeConsumers.delete(consumer)
    if (bridgeConsumers.size > 0) return
    stopBridgeConnection?.()
    stopBridgeConnection = null
  }
}

let restoreInFlight: Promise<void> | null = null

/** Wipe module-level batch UI + SSE (call on logout / account switch). */
export async function resetBatchClientState(): Promise<void> {
  const [{ resetWorkflowBatchRuntime }, { resetPreRunBatchRuntime }, history] = await Promise.all([
    import('@/services/workflowBatchRuntime.service'),
    import('@/services/preRunBatchRuntime.service'),
    import('@/utils/agent/graph/workflowBatchHistory'),
  ])
  resetWorkflowBatchRuntime()
  resetPreRunBatchRuntime()
  history.clearAllWorkflowBatchHistory()
  if (stopBridgeConnection) {
    stopBridgeConnection()
    stopBridgeConnection = null
  }
  bridgeConsumers.clear()
}

/** GET /batch/active and fan out to workflow + pre_run runtimes (mount / re-login). */
export async function restoreBatchRuntimesFromServer(): Promise<void> {
  if (restoreInFlight) return restoreInFlight
  restoreInFlight = (async () => {
    try {
      const info = await getActiveBatch()
      const [{ adoptWorkflowActiveBatch }, { adoptPreRunActiveBatch }] = await Promise.all([
        import('@/services/workflowBatchRuntime.service'),
        import('@/services/preRunBatchRuntime.service'),
      ])
      adoptWorkflowActiveBatch(info)
      adoptPreRunActiveBatch(info)
    } catch {
      /* best effort */
    } finally {
      restoreInFlight = null
    }
  })()
  return restoreInFlight
}
