/**
 * Custom hook for managing node installation logic
 */

import { useRef, useState } from 'react'
import { apiFetch, payloadFromAxiosAppResponse } from '@/utils/common/apiFetch'
import { getErrorMessage } from '@/utils/common/apiResponse'
import { getAuthToken } from '@/utils/common/authToken'
import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config'
import { toast } from 'sonner'
import type { InstallStep } from '@/types/community.types'
import { INSTALL_STEPS_INITIAL } from '@/constants/community.constants'

/** Soft ceiling so a stuck/invalid install_id cannot reconnect forever. */
const INSTALL_MAX_WALL_MS = 60 * 60 * 1000

export function useNodeInstallation() {
  const [installOpen, setInstallOpen] = useState(false)
  const [installSteps, setInstallSteps] = useState<InstallStep[]>(INSTALL_STEPS_INITIAL)
  const [installId, setInstallId] = useState<string | null>(null)
  const [installProgress, setInstallProgress] = useState({ percent: 0, text: '' })
  const [installing, setInstalling] = useState<Record<string, boolean>>({})
  const installEventSrc = useRef<EventSource | null>(null)
  const installReconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const installActiveId = useRef<string | null>(null)
  const installModelName = useRef<string | null>(null)
  const installOnComplete = useRef<(() => void) | undefined>(undefined)
  const installRetryCount = useRef(0)
  const installStartedAt = useRef(0)
  /** Reconnect replays the full event log — only toast/settle terminal once per install. */
  const installTerminalHandled = useRef(false)

  const resetInstallUI = () => {
    setInstallSteps(INSTALL_STEPS_INITIAL)
    setInstallProgress({ percent: 0, text: '' })
  }

  const openInstallModal = () => setInstallOpen(true)

  const clearInstallingModel = () => {
    const modelName = installModelName.current
    if (!modelName) return
    setInstalling((prev) => {
      const { [modelName]: _, ...rest } = prev
      return rest
    })
  }

  const closeInstallStream = () => {
    if (installReconnectTimer.current) {
      clearTimeout(installReconnectTimer.current)
      installReconnectTimer.current = null
    }
    if (installEventSrc.current) {
      try {
        installEventSrc.current.onmessage = null
        installEventSrc.current.onerror = null
        installEventSrc.current.close()
      } catch {}
      installEventSrc.current = null
    }
  }

  const failInstallWatch = (message: string) => {
    if (installTerminalHandled.current) {
      installActiveId.current = null
      closeInstallStream()
      return
    }
    installTerminalHandled.current = true
    toast.error('Installation failed', { description: message } as any)
    clearInstallingModel()
    installActiveId.current = null
    closeInstallStream()
  }

  const applyInstallPayload = (payload: any) => {
    if (payload?.heartbeat === true) return
    const step = payload?.step as string | undefined
    const status = payload?.status as string | undefined
    const rcv = Number(payload?.received_bytes || 0)
    const tot = Number(payload?.total_bytes || 0)

    if (step) {
      const order = ['sign', 'download', 'verify', 'unpack', 'persist', 'activate', 'ready']
      setInstallSteps((prev) =>
        prev.map((s) => {
          const si = order.indexOf(s.key)
          const ci = order.indexOf(step)
          if (si < ci) return { ...s, status: s.status === 'failed' ? 'failed' : 'done' }
          if (s.key === step)
            return {
              ...s,
              status: status === 'failed' ? 'failed' : status === 'done' ? 'done' : 'active',
            }
          return { ...s, status: s.status === 'failed' ? 'failed' : 'pending' }
        })
      )
    }

    if (step === 'download' && tot > 0) {
      const pct = Math.floor((rcv / tot) * 100)
      setInstallProgress({
        percent: pct,
        text: `${Math.floor(rcv / 1048576)} / ${Math.floor(tot / 1048576)} MB`,
      })
    }

    if (status === 'done') {
      if (installTerminalHandled.current) return
      installTerminalHandled.current = true
      toast.success('Installation complete')
      installOnComplete.current?.()
      clearInstallingModel()
      installActiveId.current = null
      closeInstallStream()
      return
    }

    if (status === 'failed') {
      if (installTerminalHandled.current) return
      installTerminalHandled.current = true
      toast.error('Installation failed', { description: payload?.message || 'Unknown error' } as any)
      clearInstallingModel()
      installActiveId.current = null
      closeInstallStream()
    }
  }

  const openInstallStream = (id: string) => {
    closeInstallStream()
    if (installActiveId.current !== id) return
    if (Date.now() - installStartedAt.current > INSTALL_MAX_WALL_MS) {
      failInstallWatch('Installation timed out waiting for status updates')
      return
    }

    void (async () => {
      const token = await getAuthToken()
      if (!token) {
        failInstallWatch('Authentication required to watch installation progress')
        return
      }
      if (installActiveId.current !== id) return

      const es = new EventSource(
        `${AI_SERVICE_API_ENDPOINT}/tasks/v1/bundles/install/events?install_id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`
      )
      installEventSrc.current = es

      es.onmessage = (ev) => {
        try {
          applyInstallPayload(JSON.parse(ev.data || '{}'))
          installRetryCount.current = 0
        } catch (err) {
          console.error('Install SSE parse error', err)
        }
      }

      es.onerror = () => {
        // Proxies may idle-kill during long unpack/activate; keep retrying while install is active.
        try {
          es.onmessage = null
          es.onerror = null
          es.close()
        } catch {}
        if (installEventSrc.current === es) {
          installEventSrc.current = null
        }
        if (!installActiveId.current || installActiveId.current !== id || installTerminalHandled.current) {
          return
        }
        if (Date.now() - installStartedAt.current > INSTALL_MAX_WALL_MS) {
          failInstallWatch('Installation timed out waiting for status updates')
          return
        }
        // Guard against EventSource firing onerror more than once before reconnect.
        if (installReconnectTimer.current) return
        const attempt = installRetryCount.current + 1
        installRetryCount.current = attempt
        const delay = Math.min(800 * Math.pow(2, Math.min(attempt - 1, 4)), 8000)
        console.warn(`[Community] install SSE disconnected; reconnecting in ${delay}ms (attempt ${attempt})`)
        installReconnectTimer.current = setTimeout(() => {
          installReconnectTimer.current = null
          if (installActiveId.current === id && !installTerminalHandled.current) {
            openInstallStream(id)
          }
        }, delay)
      }
    })()
  }

  const startInstall = async (bundle: any, onComplete?: () => void) => {
    const modelName = (bundle && bundle.model_name) || 'Tasknode'
    try {
      if (installing[modelName]) {
        toast.info('This tasknode is already being installed')
        return
      }
      setInstalling((prev) => ({ ...prev, [modelName]: true }))
      resetInstallUI()
      openInstallModal()

      const installName = (bundle && (bundle.display_name || bundle.model_name)) || 'Tasknode'
      toast.info(`Installing ${installName}`, {
        duration: Infinity,
        action: {
          label: 'View details',
          onClick: () => setInstallOpen(true),
        },
      } as any)

      const body = {
        model_name: (bundle && bundle.model_name) || 'Cell-Classification',
        gcs_uri: bundle?.gcs_uri,
        filename: bundle?.filename,
        entry_relative_path: (bundle && bundle.entry_relative_path) || 'main',
        size_bytes: (bundle && bundle.size_bytes) || null,
        sha256: (bundle && bundle.sha256) || null,
      }

      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/bundles/install`, {
        method: 'POST',
        body: JSON.stringify(body),
        returnAxiosFormat: true,
      })
      const data = payloadFromAxiosAppResponse<{ install_id?: string }>(resp) ?? {}
      const id = data.install_id
      if (!id) {
        toast.error('Failed to start install', { description: 'Missing install_id from server' } as any)
        setInstalling((prev) => {
          const { [modelName]: _, ...rest } = prev
          return rest
        })
        return
      }
      setInstallId(id)
      installActiveId.current = id
      installModelName.current = modelName
      installOnComplete.current = onComplete
      installRetryCount.current = 0
      installStartedAt.current = Date.now()
      installTerminalHandled.current = false
      openInstallStream(id)
    } catch (e) {
      console.error(e)
      toast.error(getErrorMessage(e, 'Failed to start install'))
      setInstalling((prev) => {
        const { [modelName]: _, ...rest } = prev
        return rest
      })
    }
  }

  const cleanup = () => {
    installActiveId.current = null
    installTerminalHandled.current = true
    closeInstallStream()
  }

  return {
    installOpen,
    setInstallOpen,
    installSteps,
    installProgress,
    installing,
    setInstalling,
    startInstall,
    cleanup,
  }
}
