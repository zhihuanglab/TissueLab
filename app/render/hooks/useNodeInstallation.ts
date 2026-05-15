/**
 * Custom hook for managing node installation logic
 */

import { useState, useRef } from 'react'
import { apiFetch, payloadFromAxiosAppResponse } from '@/utils/common/apiFetch'
import { getErrorMessage } from '@/utils/common/apiResponse'
import { AI_SERVICE_API_ENDPOINT } from '@/constants/config'
import { toast } from 'sonner'
import type { InstallStep } from '@/types/community.types'
import { INSTALL_STEPS_INITIAL } from '@/constants/community.constants'

export function useNodeInstallation() {
  const [installOpen, setInstallOpen] = useState(false)
  const [installSteps, setInstallSteps] = useState<InstallStep[]>(INSTALL_STEPS_INITIAL)
  const [installId, setInstallId] = useState<string | null>(null)
  const [installProgress, setInstallProgress] = useState({ percent: 0, text: '' })
  const [installing, setInstalling] = useState<Record<string, boolean>>({})
  const installEventSrc = useRef<EventSource | null>(null)

  const resetInstallUI = () => {
    setInstallSteps(INSTALL_STEPS_INITIAL)
    setInstallProgress({ percent: 0, text: '' })
  }

  const openInstallModal = () => setInstallOpen(true)

  const startInstall = async (bundle: any, onComplete?: () => void) => {
    const modelName = (bundle && bundle.model_name) || 'Tasknode'
    try {
      if (installing[modelName]) {
        toast.info('This tasknode is already being installed')
        return
      }
      setInstalling(prev => ({ ...prev, [modelName]: true }))
      resetInstallUI()
      openInstallModal()
      
      const installName = (bundle && (bundle.display_name || bundle.model_name)) || 'Tasknode'
      toast.info(`Installing ${installName}`, {
        duration: Infinity,
        action: {
          label: 'View details',
          onClick: () => setInstallOpen(true),
        }
      } as any)
      
      const body = {
        model_name: (bundle && bundle.model_name) || 'ClassificationNode',
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
        setInstalling(prev => { const { [modelName]: _, ...rest } = prev; return rest })
        return
      }
      setInstallId(id)
      
      if (installEventSrc.current) {
        try { installEventSrc.current.close() } catch {}
        installEventSrc.current = null
      }
      
      const es = new EventSource(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/bundles/install/events?install_id=${encodeURIComponent(id)}`)
      installEventSrc.current = es
      
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data || '{}')
          const step = payload?.step as string | undefined
          const status = payload?.status as string | undefined
          const rcv = Number(payload?.received_bytes || 0)
          const tot = Number(payload?.total_bytes || 0)
          
          if (step) {
            const order = ['sign','download','verify','unpack','persist','activate','ready']
            setInstallSteps(prev => prev.map(s => {
              const si = order.indexOf(s.key)
              const ci = order.indexOf(step)
              if (si < ci) return { ...s, status: s.status === 'failed' ? 'failed' : 'done' }
              if (s.key === step) return { ...s, status: status === 'failed' ? 'failed' : (status === 'done' ? 'done' : 'active') }
              return { ...s, status: s.status === 'failed' ? 'failed' : 'pending' }
            }))
          }
          
          if (step === 'download' && tot > 0) {
            const pct = Math.floor((rcv / tot) * 100)
            setInstallProgress({ percent: pct, text: `${Math.floor(rcv/1048576)} / ${Math.floor(tot/1048576)} MB` })
          }
          
          if (status === 'done') {
            toast.success('Installation complete')
            if (onComplete) onComplete()
            setInstalling(prev => { const { [modelName]: _, ...rest } = prev; return rest })
            try { es.close() } catch {}
            installEventSrc.current = null
          }
          
          if (status === 'failed') {
            toast.error('Installation failed', { description: payload?.message || 'Unknown error' } as any)
            setInstalling(prev => { const { [modelName]: _, ...rest } = prev; return rest })
            try { es.close() } catch {}
            installEventSrc.current = null
          }
        } catch (err) {
          console.error('Install SSE parse error', err)
        }
      }
      
      es.onerror = () => {
        try { es.close() } catch {}
        installEventSrc.current = null
        setInstalling(prev => { const { [modelName]: _, ...rest } = prev; return rest })
      }
    } catch (e) {
      console.error(e)
      toast.error(getErrorMessage(e, 'Failed to start install'))
      setInstalling(prev => { const { [modelName]: _, ...rest } = prev; return rest })
    }
  }

  const cleanup = () => {
    if (installEventSrc.current) {
      try { installEventSrc.current.close() } catch {}
      installEventSrc.current = null
    }
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
