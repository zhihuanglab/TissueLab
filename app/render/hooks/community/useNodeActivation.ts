/**
 * Custom hook for managing node activation/deactivation logic
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { apiFetch, payloadFromAxiosAppResponse } from '@/utils/common/apiFetch'
import { ApiError, getErrorMessage } from '@/utils/common/apiResponse'
import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config'
import { getAuthToken } from '@/utils/common/authToken'
import { toast } from 'sonner'

type NodeInfo = {
  running?: boolean
  envName?: string
  port?: number
  logPath?: string
  servicePath?: string
  dependencyPath?: string
  pythonVersion?: string
  isRemote?: boolean
  remoteHost?: string
  mntPath?: string
}

type ActivationStatus = 'starting' | 'ready' | 'failed'

/**
 * Give up on an activation that has produced no ready/failed event for this long
 * (e.g. the event stream dropped while the result was sent). Without it the
 * card stayed on "Working..." forever.
 */
export const ACTIVATION_MAX_WAIT_MS = 10 * 60_000
const ACTIVATION_RECONNECT_BASE_MS = 800
const ACTIVATION_RECONNECT_MAX_MS = 8000
type BusyStatus = 'activating' | 'deactivating'
type ActivationMode = 'remote' | 'local'

function envNameForActivation(envName: string | undefined, nodeName: string): string | undefined {
  if (!envName) return undefined
  const marker = `::${nodeName}`
  if (envName.endsWith(marker)) {
    return envName.slice(0, -marker.length)
  }
  return envName.includes('::') ? envName.split('::')[0] : envName
}

export function useNodeActivation() {
  const [busy, setBusy] = useState<Record<string, BusyStatus>>({})
  const [activating, setActivating] = useState(false)
  const [activationStatus, setActivationStatus] = useState<Record<string, ActivationStatus>>({})
  const [activationMode, setActivationMode] = useState<Record<string, ActivationMode>>({})
  const [failedMeta, setFailedMeta] = useState<Record<string, { logPath?: string; env?: string; port?: number; message?: string }>>({})
  const [logsOpen, setLogsOpen] = useState(false)
  const [logsTarget, setLogsTarget] = useState<{ node: string; path: string; env?: string; port?: number } | null>(null)
  
  // Activation dialog state
  const [activateOpen, setActivateOpen] = useState(false)
  const [activateFactory, setActivateFactory] = useState<string>('')
  const [activateNode, setActivateNode] = useState<string>('')
  const [servicePath, setServicePath] = useState('')
  const [envName, setEnvName] = useState('')
  const [port, setPort] = useState('')
  // Remote deployment options
  const [enableRemote, setEnableRemote] = useState(false)
  const [remoteHost, setRemoteHost] = useState('')
  const [mntPath, setMntPath] = useState('')
  
  // Single EventSource connection for all nodes
  const activationStream = useRef<EventSource | null>(null)
  // Track which nodes we're subscribed to and their callbacks
  const subscribedNodes = useRef<Map<string, (success: boolean) => void>>(new Map())
  // Track manually activated nodes to avoid duplicate notifications
  const manuallyActivatedNodes = useRef<Set<string>>(new Set())
  // Track which nodes are remote for proper failure handling
  const remoteNodes = useRef<Set<string>>(new Set())
  // State to trigger effect when subscriptions change
  const [subscriptionTrigger, setSubscriptionTrigger] = useState(0)
  // Per-node time (ms epoch) after which a silent activation is marked failed
  const activationDeadlines = useRef<Map<string, number>>(new Map())
  // Backoff reconnect of the activation stream after it drops
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttempts = useRef(0)

  /** No ready/failed event arrived in time: end "Working..." with a clear failure. */
  const timeOutActivation = (modelName: string) => {
    activationDeadlines.current.delete(modelName)
    if (!subscribedNodes.current.has(modelName)) return
    const isRemote = remoteNodes.current.has(modelName)
    const minutes = Math.round(ACTIVATION_MAX_WAIT_MS / 60_000)
    const message = `No activation result from ${modelName} after ${minutes} minutes. Check the setup logs and try again.`
    toast.error(`Activation timed out for ${modelName}`, { description: message })
    setBusy((prev) => { const { [modelName]: _, ...rest } = prev; return rest })
    if (isRemote) {
      setActivationStatus((prev) => { const { [modelName]: _, ...rest } = prev; return rest })
      setFailedMeta((prev) => { const { [modelName]: _, ...rest } = prev; return rest })
      remoteNodes.current.delete(modelName)
    } else {
      setActivationStatus((prev) => ({ ...prev, [modelName]: 'failed' }))
      setFailedMeta((prev) => ({ ...prev, [modelName]: { ...prev[modelName], message } }))
    }
    manuallyActivatedNodes.current.delete(modelName)
    const callback = subscribedNodes.current.get(modelName)
    subscribedNodes.current.delete(modelName)
    if (subscribedNodes.current.size === 0) {
      setSubscriptionTrigger(prev => prev + 1)
    }
    if (callback) {
      callback(false)
    }
  }

  // Initialize single SSE connection
  useEffect(() => {
    // Fail activations that outlived their deadline before (re)opening the stream.
    const now = Date.now()
    for (const [name, deadline] of Array.from(activationDeadlines.current)) {
      if (now >= deadline) timeOutActivation(name)
    }

    // Only create connection if we have subscribed nodes
    if (subscribedNodes.current.size === 0) {
      // Close connection if no subscriptions
      if (activationStream.current) {
        try {
          activationStream.current.close()
        } catch {}
        activationStream.current = null
      }
      return
    }

    // Re-run this effect at the earliest deadline so a silent activation is timed out.
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const deadlines = Array.from(activationDeadlines.current.values())
    if (deadlines.length > 0) {
      watchdog = setTimeout(
        () => setSubscriptionTrigger(prev => prev + 1),
        Math.max(0, Math.min(...deadlines) - Date.now()) + 50,
      )
    }

    // If connection already exists, don't recreate it
    if (activationStream.current) {
      return () => {
        if (watchdog) clearTimeout(watchdog)
      }
    }

    let cancelled = false
    const openStream = async () => {
      const token = await getAuthToken()
      if (cancelled || activationStream.current || !token) return
      const url = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/activation/events?token=${encodeURIComponent(token)}`
      const es = new EventSource(url)
      activationStream.current = es

      es.onopen = () => {
        reconnectAttempts.current = 0
      }

      es.onmessage = async (ev) => {
      try {
        reconnectAttempts.current = 0
        const payload = JSON.parse(ev.data || '{}')
        if (payload?.heartbeat === true) return
        const modelName = payload?.model
        const status = payload?.status
        const data = payload?.data || {}

        if (!modelName) return

        // Only process updates for nodes we're subscribed to
        if (!subscribedNodes.current.has(modelName)) {
          return
        }

        if (status === 'starting') {
          // The service is working on it: restart the silence deadline.
          activationDeadlines.current.set(modelName, Date.now() + ACTIVATION_MAX_WAIT_MS)
          setActivationStatus((prev) => {
            const newStatus: Record<string, ActivationStatus> = { ...prev, [modelName]: 'starting' }
            return newStatus
          })
          // Show notification for auto-activation (manual activation already shows notification in submitActivate)
          const isManualActivation = manuallyActivatedNodes.current.has(modelName)
          if (!isManualActivation) {
            const logPath = data?.log_path
            toast.info(`Auto-activating ${modelName}...`, {
              description: 'This node is being activated automatically.',
              action: logPath ? {
                label: 'View logs',
                onClick: () => {
                  setLogsTarget({ node: modelName, path: logPath, env: data?.env_name, port: data?.port })
                  setLogsOpen(true)
                }
              } : undefined,
            } as any)
          }
        }

        if (status === 'failed') {
          const logPath = data?.log_path
          // Check if this is a remote node from our tracking or from the data
          const isRemote = remoteNodes.current.has(modelName) || !!(data?.is_remote)
          
          toast.error(`Activation failed for ${modelName}`, {
            description: data?.message || 'Registration failed. Check setup logs.',
            action: logPath ? {
              label: 'View logs',
              onClick: () => {
                setLogsTarget({ node: modelName, path: logPath, env: data?.env_name, port: data?.port })
                setLogsOpen(true)
              }
            } : undefined,
          } as any)
          setBusy((prev) => { const { [modelName]: _, ...rest } = prev; return rest })
          
          // For remote nodes, clear activation status so user can retry connection
          // For local nodes, set to 'failed' to show error state
          if (isRemote) {
            setActivationStatus((prev) => {
              const { [modelName]: _, ...rest } = prev
              return rest
            })
            setFailedMeta((prev) => {
              const { [modelName]: _, ...rest } = prev
              return rest
            })
            // Remove from remote nodes tracking
            remoteNodes.current.delete(modelName)
          } else {
            setActivationStatus((prev) => {
              const newStatus: Record<string, ActivationStatus> = { ...prev, [modelName]: 'failed' }
              return newStatus
            })
            setFailedMeta((prev) => ({ ...prev, [modelName]: { logPath, env: data?.env_name, port: data?.port, message: data?.message } }))
          }
          
          // Clean up manual activation tracking
          manuallyActivatedNodes.current.delete(modelName)
          activationDeadlines.current.delete(modelName)
          
          // Remove subscription first to prevent race conditions, then call callback
          const callback = subscribedNodes.current.get(modelName)
          subscribedNodes.current.delete(modelName)
          // Trigger effect to close connection if all subscriptions are cleared
          if (subscribedNodes.current.size === 0) {
            setSubscriptionTrigger(prev => prev + 1)
          }
          if (callback) {
            callback(false)
          }
        } else if (status === 'ready') {
          setBusy((prev) => {
            const { [modelName]: _, ...rest } = prev
            return rest
          })
          setActivationStatus((prev) => {
            const newStatus: Record<string, ActivationStatus> = { ...prev, [modelName]: 'ready' }
            return newStatus
          })
          
          // Clean up manual activation tracking
          manuallyActivatedNodes.current.delete(modelName)
          activationDeadlines.current.delete(modelName)
          
          // Show success notification
          toast.success(`${modelName} activated successfully`, {
            description: 'The task node is now ready to use.',
          })
          try {
            window.dispatchEvent(new CustomEvent('model-zoo-refresh', { detail: { model: modelName } }))
          } catch {}

          // Remove subscription first to prevent race conditions, then call callback
          const callback = subscribedNodes.current.get(modelName)
          subscribedNodes.current.delete(modelName)
          // Trigger effect to close connection if all subscriptions are cleared
          if (subscribedNodes.current.size === 0) {
            setSubscriptionTrigger(prev => prev + 1)
          }
          if (callback) {
            callback(true)
          }
        }
      } catch (err) {
        console.error('[Community] activation SSE parse error', err)
      }
      }

      es.onerror = (error) => {
        console.error('[Community] activation SSE connection error', error)
        // A native EventSource retry would reuse the same short-lived query
        // token. Close it and reopen with a fresh token after a backoff; the
        // deadline check above ends activations whose result was missed.
        try {
          es.onmessage = null
          es.onerror = null
          es.close()
        } catch {}
        if (activationStream.current === es) {
          activationStream.current = null
        }
        if (cancelled || subscribedNodes.current.size === 0 || reconnectTimer.current) return
        const attempt = reconnectAttempts.current + 1
        reconnectAttempts.current = attempt
        const delay = Math.min(ACTIVATION_RECONNECT_BASE_MS * Math.pow(2, attempt - 1), ACTIVATION_RECONNECT_MAX_MS)
        reconnectTimer.current = setTimeout(() => {
          reconnectTimer.current = null
          setSubscriptionTrigger(prev => prev + 1)
        }, delay)
      }
    }
    void openStream()

    // Cleanup on unmount
    return () => {
      cancelled = true
      if (watchdog) clearTimeout(watchdog)
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      if (activationStream.current) {
        try {
          activationStream.current.close()
        } catch {}
        activationStream.current = null
      }
    }
  }, [subscriptionTrigger]) // Re-evaluate when subscriptions change

  const subscribeActivation = useCallback((nodeName: string, onComplete?: (success: boolean) => void, isRemote?: boolean) => {
    try {
      // Warn if already subscribed (will overwrite previous callback)
      if (subscribedNodes.current.has(nodeName)) {
        console.warn(`[Community] Node ${nodeName} is already subscribed. Previous callback will be overwritten.`)
      }
      // Add to subscribed nodes
      subscribedNodes.current.set(nodeName, onComplete || (() => {}))
      activationDeadlines.current.set(nodeName, Date.now() + ACTIVATION_MAX_WAIT_MS)
      // Track if this is a remote node for proper failure handling
      if (isRemote) {
        remoteNodes.current.add(nodeName)
      } else {
        remoteNodes.current.delete(nodeName)
      }
      
      // Trigger effect to create connection if needed
      setSubscriptionTrigger(prev => prev + 1)
    } catch (err) {
      console.error('[Community] subscribeActivation error', err)
    }
  }, [])

  const quickActivate = async (
    factory: string, 
    node: string, 
    nodesExtended: any,
    nodeInfo: any,
    onComplete?: (success: boolean) => void
  ) => {
    const runtime = nodesExtended?.[node]?.runtime || {}
    const savedInfo = nodeInfo?.[node] || {}
    const sp = runtime?.service_path || savedInfo?.servicePath
    const env = envNameForActivation(runtime?.env_name || savedInfo?.envName, node)
    const dep = runtime?.dependency_path || savedInfo?.dependencyPath || ''
    const py = runtime?.python_version || savedInfo?.pythonVersion || '3.11'
    const prt = runtime?.port || savedInfo?.port
    const savedPort = savedInfo?.port
    // Remote deployment options from runtime
    const remoteHost = runtime?.remote_host || savedInfo?.remoteHost
    const mntPath = runtime?.mnt_path || savedInfo?.mntPath

    const isStoredPy = typeof sp === 'string' && sp.trim().toLowerCase().endsWith('.py')
    if (!sp || (isStoredPy && !(env || dep))) {
      if (savedPort || savedInfo?.envName || savedInfo?.logPath) {
        toast.error(`Cannot activate ${node}`, {
          description: 'Saved node state has a port but no service path. Open settings once to repair the saved runtime config.',
        } as any)
        openActivate(factory, node, nodesExtended, nodeInfo)
        return
      }
      openActivate(factory, node, nodesExtended, nodeInfo)
      return
    }

    // Check if remote node before setting busy state
    const isRemote = runtime?.is_remote === true || savedInfo?.isRemote === true
    
    try {
      setActivating(true)
      // Set busy state for both local and remote nodes to show consistent loading animation
      setBusy((prev) => {
        const newBusy: Record<string, BusyStatus> = { ...prev, [node]: 'activating' }
        return newBusy
      })
      setActivationMode((prev) => ({ ...prev, [node]: isRemote ? 'remote' : 'local' }))
      // Also set activation status to 'starting' for UI consistency
      setActivationStatus((prev) => {
        const newStatus: Record<string, ActivationStatus> = { ...prev, [node]: 'starting' }
        return newStatus
      })
      const body = {
        model_name: node,
        python_version: py,
        service_path: sp,
        dependency_path: dep,
        factory,
        description: undefined,
        env_name: env,
        port: prt,
        install_dependencies: false,
        // Remote deployment options
        is_remote: isRemote,
        remote_host: remoteHost || undefined,
        mnt_path: remoteHost ? mntPath : undefined,
      }
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/register_custom_node_async`, {
        method: 'POST',
        body: JSON.stringify(body),
        returnAxiosFormat: true,
      })
      const data = payloadFromAxiosAppResponse<{
        log_path?: string
        env_name?: string
        status?: string
        port?: number
        remote_host?: string
        message?: string
      }>(resp) ?? {}
      if (data?.log_path) {
        toast.info(isRemote ? `Connecting to ${node}...` : `Starting ${node}...`, {
          description: isRemote ? 'Checking remote node health...' : 'You can watch setup logs while it initializes.',
          action: {
            label: 'View logs',
            onClick: () => {
              setLogsTarget({ node, path: data.log_path!, env: data.env_name, port: prt || runtime?.port })
              setLogsOpen(true)
            }
          }
        } as any)
      }
      if (data && typeof data === 'object') {
        // For remote nodes, registration is synchronous and should be ready immediately
        if (isRemote) {
          const isAsyncResponse = data.status === 'starting'
          const hasConnectionInfo = !!(data.port || data.remote_host)
          
          // If async response, wait for activation events; if sync response without connection info, it failed
          if (!isAsyncResponse && !hasConnectionInfo) {
            // Health check failed - show error
            console.error(`[Community] Remote node ${node} connection failed:`, data.message)
            toast.error(`Failed to connect to ${node}`, {
              description: data.message || 'Health check failed. Please check the remote node is running and accessible.',
            })
            setBusy((prev) => {
              const { [node]: _, ...rest } = prev
              return rest
            })
            // Clear activation status so user can retry connection (don't set to 'failed' to avoid opening settings)
            setActivationStatus((prev) => {
              const { [node]: _, ...rest } = prev
              return rest
            })
            // Clear failed meta so it doesn't interfere with retry
            setFailedMeta((prev) => {
              const { [node]: _, ...rest } = prev
              return rest
            })
            if (onComplete) {
              try {
                await onComplete(false)
              } catch (err) {
                console.error(`[Community] Error in onComplete for ${node}:`, err)
              }
            }
            return
          }
          
          // If async response, subscribe to activation events to get the actual result
          if (isAsyncResponse) {
            subscribeActivation(node, onComplete, true) // Pass isRemote=true
            setActivationStatus((prev) => {
              const newStatus: Record<string, ActivationStatus> = { ...prev, [node]: 'starting' }
              return newStatus
            })
            return
          }
          
          // Remote nodes: set ready status immediately, ensure busy state is cleared
          setBusy((prev) => {
            const { [node]: _, ...rest } = prev
            return rest
          })
          setActivationStatus((prev) => {
            const newStatus: Record<string, ActivationStatus> = { ...prev, [node]: 'ready' }
            return newStatus
          })
          manuallyActivatedNodes.current.delete(node)
          // For remote nodes, refresh state immediately to update UI
          if (onComplete) {
            // Call onComplete to trigger state refresh
            try {
              await onComplete(true)
            } catch (err) {
              console.error(`[Community] Error in onComplete for ${node}:`, err)
            }
          }
          toast.success(`${node} connected successfully`, {
            description: 'The remote task node is now ready to use.',
          })
          try {
            window.dispatchEvent(new CustomEvent('model-zoo-refresh', { detail: { model: node } }))
          } catch {}
        } else {
          // For local nodes, subscribe to activation events
          subscribeActivation(node, onComplete, false) // Pass isRemote=false for local nodes
          setActivationStatus((prev) => {
            const newStatus: Record<string, ActivationStatus> = { ...prev, [node]: 'starting' }
            return newStatus
          })
          setFailedMeta((prev) => { const { [node]: _, ...rest } = prev; return rest })
        }
      }
    } catch (e) {
      console.error(e)
      toast.error(getErrorMessage(e, 'Activation failed'))
      setBusy((prev) => { const { [node]: _, ...rest } = prev; return rest })
      // Network/request failed before SSE subscription; clear transient state for all.
      setActivationStatus((prev) => {
        const { [node]: _, ...rest } = prev
        return rest
      })
      if (isRemote) {
        setFailedMeta((prev) => {
          const { [node]: _, ...rest } = prev
          return rest
        })
      }
      if (onComplete) {
        try {
          await onComplete(false)
        } catch (err) {
          console.error(`[Community] Error in onComplete for ${node}:`, err)
        }
      }
    } finally {
      setActivating(false)
    }
  }

  const openActivate = async (factory: string, node: string, nodesExtended: any, nodeInfo: any) => {
    setActivateFactory(factory)
    setActivateNode(node)
    
    // Get runtime config: try API first for latest data, fall back to cached data
    let runtime = nodesExtended?.[node]?.runtime || {}
    try {
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_nodes_extended`, {
        method: 'GET',
        returnAxiosFormat: true,
      })
      const apiNodes = payloadFromAxiosAppResponse<{ nodes?: Record<string, { runtime?: unknown }> }>(resp)?.nodes
      if (apiNodes?.[node]?.runtime) {
        runtime = apiNodes[node].runtime
      }
    } catch (e) {
      // Use cached data on API failure
      console.warn('[openActivate] Failed to fetch fresh node data, using cached data:', e)
    }
    
    const info = nodeInfo[node]
    setServicePath(runtime?.service_path || '')
    setEnvName(envNameForActivation(runtime?.env_name || nodeInfo?.[node]?.envName, node) || '')
    setPort(runtime?.port ? String(runtime.port) : (info?.port ? String(info.port) : ''))
    // Load remote deployment options from runtime
    const hasRemote = runtime?.is_remote === true
    setEnableRemote(hasRemote)
    setRemoteHost(runtime?.remote_host || '')
    setMntPath(runtime?.mnt_path || '')
    setActivateOpen(true)
  }

  const submitActivate = async (onComplete?: (success: boolean) => void) => {
    // Check if remote node before setting busy state
    const isRemote = !!enableRemote
    
    try {
      setActivating(true)
      setActivateOpen(false)
      // Set busy state for both local and remote nodes to show consistent loading animation
      setBusy((prev) => {
        const newBusy: Record<string, BusyStatus> = { ...prev, [activateNode]: 'activating' }
        return newBusy
      })
      setActivationMode((prev) => ({ ...prev, [activateNode]: isRemote ? 'remote' : 'local' }))
      // Also set activation status to 'starting' for UI consistency
      setActivationStatus((prev) => {
        const newStatus: Record<string, ActivationStatus> = { ...prev, [activateNode]: 'starting' }
        return newStatus
      })
      const body = {
        model_name: activateNode,
        python_version: '3.11',
        service_path: servicePath,
        dependency_path: '',
        factory: activateFactory,
        description: '',
        env_name: envNameForActivation(envName || undefined, activateNode),
        port: port ? Number(port) : undefined,
        install_dependencies: false,
        // Remote deployment options
        is_remote: enableRemote,
        remote_host: enableRemote && remoteHost ? remoteHost : undefined,
        mnt_path: enableRemote ? mntPath : undefined,
      }
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/register_custom_node_async`, {
        method: 'POST',
        body: JSON.stringify(body),
        returnAxiosFormat: true,
      })
      const data = payloadFromAxiosAppResponse<{
        log_path?: string
        env_name?: string
        status?: string
        port?: number
        remote_host?: string
        message?: string
      }>(resp) ?? {}
      if (data?.log_path) {
        toast.info(isRemote ? `Connecting to ${activateNode}...` : `Starting ${activateNode}...`, {
          description: isRemote ? 'Checking remote node health...' : 'You can watch setup logs while it initializes.',
          action: {
            label: 'View logs',
            onClick: () => {
              setLogsTarget({ node: activateNode, path: data.log_path!, env: data.env_name, port: body.port })
              setLogsOpen(true)
            }
          }
        } as any)
      }
      if (data && typeof data === 'object') {
        if (isRemote) {
          const isAsyncResponse = data.status === 'starting'
          const hasConnectionInfo = !!(data.port || data.remote_host)
          
          // If async response, wait for activation events; if sync response without connection info, it failed
          if (!isAsyncResponse && !hasConnectionInfo) {
            // Health check failed - show error
            console.error(`[Community] Remote node ${activateNode} connection failed:`, data.message)
            toast.error(`Failed to connect to ${activateNode}`, {
              description: data.message || 'Health check failed. Please check the remote node is running and accessible.',
            })
            setBusy((prev) => {
              const { [activateNode]: _, ...rest } = prev
              return rest
            })
            setActivationStatus((prev) => {
              const { [activateNode]: _, ...rest } = prev
              return rest
            })
            if (onComplete) {
              onComplete(false)
            }
            return
          }
          
          // If async response, subscribe to activation events to get the actual result
          if (isAsyncResponse) {
            manuallyActivatedNodes.current.add(activateNode)
            subscribeActivation(activateNode, onComplete, true) // Pass isRemote=true
            setActivationStatus((prev) => {
              const newStatus: Record<string, ActivationStatus> = { ...prev, [activateNode]: 'starting' }
              return newStatus
            })
            return
          }
          
          // Remote nodes: set ready status immediately, ensure busy state is cleared
          setBusy((prev) => {
            const { [activateNode]: _, ...rest } = prev
            return rest
          })
          setActivationStatus((prev) => {
            const newStatus: Record<string, ActivationStatus> = { ...prev, [activateNode]: 'ready' }
            return newStatus
          })
          manuallyActivatedNodes.current.delete(activateNode)
          if (onComplete) {
            onComplete(true)
          }
          toast.success(`${activateNode} connected successfully`, {
            description: 'The remote task node is now ready to use.',
          })
          try {
            window.dispatchEvent(new CustomEvent('model-zoo-refresh', { detail: { model: activateNode } }))
          } catch {}
        } else {
          // For local nodes, subscribe to activation events
          manuallyActivatedNodes.current.add(activateNode)
          subscribeActivation(activateNode, onComplete, false) // Pass isRemote=false for local nodes
          setActivationStatus((prev) => {
            const newStatus: Record<string, ActivationStatus> = { ...prev, [activateNode]: 'starting' }
            return newStatus
          })
          setFailedMeta((prev) => { const { [activateNode]: _, ...rest } = prev; return rest })
        }
      }
    } catch (e) { 
      console.error('[Community] submitActivate error:', e) 
      toast.error(getErrorMessage(e, 'Activation failed'))
      setBusy((prev) => { const { [activateNode]: _, ...rest } = prev; return rest })
      setActivationStatus((prev) => {
        const { [activateNode]: _, ...rest } = prev
        return rest
      })
      if (onComplete) {
        onComplete(false)
      }
    } finally {
      setActivating(false)
    }
  }

  const stopNode = async (nodeName: string, nodeInfo: any, nodesExtended: any, onComplete?: () => void) => {
    // Determine if remote node before try block so it's available in catch
    const runtime = nodesExtended?.[nodeName]?.runtime || {}
    const isRemote = runtime?.is_remote === true
    
    try {
      setBusy((prev) => {
        const newBusy: Record<string, BusyStatus> = { ...prev, [nodeName]: 'deactivating' }
        return newBusy
      })
      const info = nodeInfo[nodeName]
      
      // env_name from nodeInfo is already composite_key format (env_name::model_name) from list_node_ports
      // So we should use it directly, not add ::nodeName again
      const envNameFromInfo = info?.envName
      const envNameFromRuntime = runtime?.env_name
      
      // Try different key formats in order of preference
      let stopKey = envNameFromInfo // This is already composite_key from list_node_ports
      if (!stopKey) {
        // If envNameFromInfo is not available, construct from runtime
        if (envNameFromRuntime) {
          stopKey = `${envNameFromRuntime}::${nodeName}`
        } else {
          stopKey = `${nodeName}_tissuelab_ai_service_tasknode::${nodeName}`
        }
      }
      
      const tryStop = async (envKey: string): Promise<{ ok: true; body: unknown } | { ok: false; err: unknown }> => {
        try {
          const r = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/stop_node_process`, {
            method: 'POST',
            body: JSON.stringify({ env_name: envKey }),
            returnAxiosFormat: true,
          })
          return { ok: true, body: r.data }
        } catch (err) {
          return { ok: false, err }
        }
      }

      let data: unknown = null
      let lastErr: unknown = null

      if (isRemote) {
        let r = await tryStop(nodeName)
        if (r.ok) data = r.body
        else {
          lastErr = r.err
          if (stopKey !== nodeName) {
            r = await tryStop(stopKey)
            if (r.ok) {
              data = r.body
              lastErr = null
            } else {
              lastErr = r.err
            }
          }
        }
      } else {
        let r = await tryStop(stopKey)
        if (r.ok) data = r.body
        else {
          lastErr = r.err
          if (stopKey !== nodeName) {
            r = await tryStop(nodeName)
            if (r.ok) {
              data = r.body
              lastErr = null
            } else {
              lastErr = r.err
            }
          }
        }
      }

      const errMsg = getErrorMessage(lastErr, '')

      const msgLower = errMsg.toLowerCase()
      const isNotFoundError =
        !data &&
        !!errMsg &&
        (msgLower.includes('not found') ||
          msgLower.includes('no running process') ||
          msgLower.includes('already disconnected') ||
          msgLower.includes('already stopped'))

      if (data || isNotFoundError) {
        const message = isNotFoundError
          ? isRemote
            ? `${nodeName} was already disconnected`
            : `${nodeName} was already stopped`
          : isRemote
            ? `${nodeName} disconnected successfully`
            : `${nodeName} stopped successfully`
        toast.success(message)
        setActivationStatus((prev) => {
          const { [nodeName]: _, ...rest } = prev
          return rest
        })
        setFailedMeta((prev) => {
          const { [nodeName]: _, ...rest } = prev
          return rest
        })
        if (onComplete) {
          onComplete()
        }
      } else {
        console.error(`[stopNode] Stop failed for ${nodeName}:`, errMsg)
        toast.error(isRemote ? `Failed to disconnect ${nodeName}` : `Failed to stop ${nodeName}`, {
          description: errMsg || 'Failed to disconnect node',
        })
        if (onComplete) {
          onComplete()
        }
      }
    } catch (e) {
      console.error(`[stopNode] Error stopping node ${nodeName}:`, e)
      // Show error toast for network/API errors
      const errorMessage = getErrorMessage(e, 'Network error')
      toast.error(isRemote ? `Failed to disconnect ${nodeName}` : `Failed to stop ${nodeName}`, {
        description: errorMessage
      })
      // On error, still clear busy state
      if (onComplete) {
        onComplete()
      }
    } finally {
      setBusy((prev) => {
        const { [nodeName]: _, ...rest } = prev
        return rest
      })
    }
  }

  const clearNodeStatus = useCallback((nodeName: string) => {
    // Clear activation status and failed meta for a specific node
    setActivationStatus((prev) => {
      const { [nodeName]: _, ...rest } = prev
      return rest
    })
    setFailedMeta((prev) => {
      const { [nodeName]: _, ...rest } = prev
      return rest
    })
  }, [])

  const cleanup = () => {
    // Close single connection
    if (activationStream.current) {
      try {
        activationStream.current.close()
      } catch {}
      activationStream.current = null
    }
    // Clear all subscriptions
    subscribedNodes.current.clear()
    activationDeadlines.current.clear()
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
    // Reset subscription trigger
    setSubscriptionTrigger(0)
  }

  return {
    busy,
    activationMode,
    setBusy,
    activating,
    activationStatus,
    failedMeta,
    logsOpen,
    setLogsOpen,
    logsTarget,
    setLogsTarget,
    activateOpen,
    setActivateOpen,
    activateFactory,
    activateNode,
    servicePath,
    setServicePath,
    envName,
    setEnvName,
    port,
    setPort,
    enableRemote,
    setEnableRemote,
    remoteHost,
    setRemoteHost,
    mntPath,
    setMntPath,
    subscribeActivation,
    quickActivate,
    openActivate,
    submitActivate,
    stopNode,
    clearNodeStatus,
    cleanup,
  }
}
