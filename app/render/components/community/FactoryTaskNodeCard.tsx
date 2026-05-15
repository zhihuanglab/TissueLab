import React from 'react'
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Settings, SquareTerminal, Trash2 } from "lucide-react"
import { toast } from 'sonner'
import type { ClassifierData, NodeInfo, NodeExtended } from '@/types/community.types'
import type { ClassifierData as FirebaseClassifierData } from '@/services/classifiers.service'
import { CATEGORY_TO_FACTORY_MAP } from '@/constants/community.constants'

interface FactoryTaskNodeCardProps {
  factory: string
  nodes: string[]
  nodeInfo: Record<string, NodeInfo>
  nodesExtended: Record<string, NodeExtended>
  busy: Record<string, 'activating' | 'deactivating'>
  activationMode?: Record<string, 'remote' | 'local'>
  onActivate?: (factory: string, node: string) => void
  onDeactivate?: (node: string) => void
  onViewClassifiers?: (factory: string, node: string) => void
  onOpenActivate?: (factory: string, node: string) => void
  displayName: string
  nodeClassifierCounts: Record<string, number>
  userUploadedClassifiers: ClassifierData[]
  realClassifiers: ClassifierData[]
  firebaseClassifiers: FirebaseClassifierData[]
  categoryDisplayNames: Record<string, string>
  activationStatus: Record<string, 'starting' | 'ready' | 'failed'>
  failedMeta: Record<string, { logPath?: string; env?: string; port?: number; message?: string }>
  onShowLogs?: (node: string, meta: { logPath?: string; env?: string; port?: number }) => void
  isElectron: boolean
  onDownload?: (node: string) => void
  installing: Record<string, boolean>
  activating: boolean
  onDelete?: (node: string) => void
  hasPermission?: boolean
  showPermissionError?: () => void
  getPermissionTooltip?: () => string
  userInfo?: any
}

export default function FactoryTaskNodeCard({
  factory,
  nodes,
  nodeInfo,
  nodesExtended,
  busy,
  activationMode,
  onActivate,
  onDeactivate,
  onViewClassifiers,
  onOpenActivate,
  displayName,
  nodeClassifierCounts,
  userUploadedClassifiers,
  realClassifiers,
  firebaseClassifiers,
  categoryDisplayNames,
  activationStatus,
  failedMeta,
  onShowLogs,
  isElectron,
  onDownload,
  installing,
  activating,
  onDelete,
  hasPermission = true,
  showPermissionError,
  getPermissionTooltip,
  userInfo
}: FactoryTaskNodeCardProps) {
  
  // Calculate classifier count based on actual matching classifiers
  const getClassifierCount = (factoryType: string, node: string) => {
    // Prefer publicly visible classifiers from Firebase; fallback to local lists if empty
    let sourceList: any[]
    if (firebaseClassifiers && firebaseClassifiers.length > 0) {
      sourceList = firebaseClassifiers
    } else {
      sourceList = [...userUploadedClassifiers, ...realClassifiers]
    }

    // Normalize to array to avoid union-type filter signature issues
    const sourceListArray: any[] = Array.isArray(sourceList) ? sourceList : []

    // Deduplicate by id to avoid double counting between sources
    const seenIds = new Set<string>()

    const allClassifiers = sourceListArray.filter((c: any) => {
      if (!c?.id) return false
      if (seenIds.has(c.id)) return false
      seenIds.add(c.id)
      return true
    })
    
    const factoryId = CATEGORY_TO_FACTORY_MAP[factoryType] || factoryType
    const factoryDisplayName = categoryDisplayNames[factoryType] || factoryType
    
    const matchingClassifiers = allClassifiers.filter((classifier: any) => {
      const matches = classifier.factory === factoryId
      // Check both 'model' and 'node' fields for compatibility
      const modelField = classifier.model || classifier.node
      const hasModel = modelField && modelField !== 'undefined' && modelField !== ''
      const modelMatches = hasModel ? modelField === node : false
      
      // If model is undefined/empty, fall back to factory-only matching for backward compatibility
      if (!hasModel) {
        return matches
      }
      // Otherwise, require both factory and model match
      return matches && modelMatches
    })
    
    return matchingClassifiers.length
  }
  
  return (
    <div className={`rounded-lg border border-border bg-card p-3 shadow-sm ${!hasPermission ? 'opacity-75' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-primary">
          {displayName}
        </div>
        {!hasPermission && (
          <div className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
            Read Only
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {nodes.map((node) => {
          const info = nodeInfo[node]
          const isActive = !!info
          const isRunning = !!info?.running
          const stored: NodeExtended['runtime'] = nodesExtended?.[node]?.runtime || {}
          const isRemote = stored?.is_remote === true
          // Use busy state for both local and remote nodes to show consistent loading animation
          const isBusy = !!busy[node]
          const status = activationStatus[node]
          // Starting UI should only depend on backend "starting" when node is actually running.
          // This avoids stale starting flags leaving cards stuck on "Working...".
          const isStarting = (isRunning && !!info?.starting) || status === 'starting'
          const isBusyRemote = activationMode?.[node] === 'remote'
          const displayRemote = (isBusy || isStarting) ? isBusyRemote : isRemote
          const hasRuntimeConfig = !!(
            stored?.service_path ||
            stored?.env_name ||
            stored?.port ||
            stored?.is_remote === true ||
            stored?.remote_host ||
            stored?.mnt_path ||
            stored?.log_path ||
            stored?.bundle_exists === true ||
            info?.port ||
            info?.envName ||
            info?.logPath ||
            info?.servicePath ||
            info?.dependencyPath ||
            info?.pythonVersion ||
            info?.isRemote === true ||
            info?.remoteHost ||
            info?.mntPath
          )
          const hasPreset = hasRuntimeConfig
          const portDisp = info?.port || stored?.port
          const initials = node.split(/(?=[A-Z0-9])|[\s_-]/).filter(Boolean).map(w=>w[0]).join('').toUpperCase()
          
          const statusLabel = status === 'failed'
            ? 'Failed'
            : (isBusy || isStarting
              ? (displayRemote ? 'Connecting' : 'Starting')
              : (isActive ? (isRunning ? 'Running' : 'Active') : 'Inactive'))
          const statusClass =
            status === 'failed'
              ? 'bg-destructive/10 text-destructive'
              : isBusy || isStarting
                ? 'bg-accent/10 text-accent-foreground'
                : isActive
                  ? isRunning
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
                  : 'bg-muted text-muted-foreground'
          const failureMeta = failedMeta[node]
          
          const classifierCount = getClassifierCount(factory, node)
          
          return (
            <div key={node} className="flex items-center justify-between rounded-md border border-border bg-card p-2 transition-colors hover:bg-accent/40">
              <div className="flex items-center gap-2" style={{opacity: isActive ? 1 : 0.5}}>
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-sm font-medium text-primary">
                  {initials}
                </span>
                <div className="flex flex-col">
                  <div className="text-sm font-medium">{node}</div>
                  <div className="flex items-center gap-1">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${statusClass}`}>
                      {statusLabel}
                    </span>
                    {portDisp ? (
                      <span className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground">{`localhost:${portDisp}`}</span>
                    ) : null}
                  </div>
                  
                  {/* Always show "Shared classifiers" link for all nodes */}
                  <div className="mt-1 text-xs">
                    <button 
                      onClick={() => {
                        if (!hasPermission) {
                          if (!userInfo?.user_id) {
                            toast.error("Please login to view this factory's classifiers")
                          } else {
                            toast.error("You don't have permission to view this factory's classifiers")
                          }
                          return
                        }
                        onViewClassifiers?.(factory, node)
                      }}
                      className={`${!hasPermission ? 'cursor-not-allowed text-muted-foreground' : 'text-primary underline-offset-2 hover:text-primary/80 hover:underline'}`}
                      disabled={!hasPermission}
                      title={!hasPermission ? (!userInfo?.user_id ? "Please login to view this factory's classifiers" : "You don't have permission to view this factory's classifiers") : ""}
                    >
                      Shared classifiers: {classifierCount} - Click to see all
                    </button>
                  </div>
                </div>
              </div>
              {(isBusy || isStarting) ? (
                <Button variant="outline" size="sm" disabled className="bg-primary/10">
                  <div className="mr-2 h-3 w-3 animate-spin rounded-full border-b-2 border-primary"></div>
                  {displayRemote ? 'Connecting...' : 'Working...'}
                </Button>
              ) : isRunning ? (
                // Show disconnect button if node is running
                node === 'Scripts' ? null : (
                  <div className="flex items-center gap-2">
                    <Button 
                      variant="destructive" 
                      size="sm" 
                      onClick={() => {
                        if (!hasPermission) {
                          showPermissionError?.()
                          return
                        }
                        onDeactivate?.(node)
                      }}
                      disabled={!hasPermission}
                      title={!hasPermission ? getPermissionTooltip?.() : ""}
                    >
                      {(() => {
                        const runtime = (nodesExtended?.[node]?.runtime || {}) as { is_remote?: boolean }
                        const isRemote = runtime?.is_remote === true
                        return isRemote ? 'Disconnect' : 'Deactivate'
                      })()}
                    </Button>
                    {(() => {
                      // Try to get logPath from nodeInfo first, then fallback to nodesExtended
                      // This ensures log button shows even when remote node is unreachable
                      const logPath = info?.logPath || stored?.log_path
                      const envName = info?.envName || stored?.env_name
                      const port = info?.port || stored?.port
                      
                      return logPath ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="View Logs"
                          onClick={() => onShowLogs?.(node, { logPath, env: envName, port })}
                        >
                          <SquareTerminal className="h-4 w-4" />
                        </Button>
                      ) : null
                    })()}
                  </div>
                )
              ) : (
                <div className="flex items-center gap-2">
                  {hasPreset ? (
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={() => {
                        if (!hasPermission) {
                          showPermissionError?.()
                          return
                        }
                        // For remote nodes, always retry connection instead of opening settings
                        // For local nodes, open settings if failed
                        const runtime = (nodesExtended?.[node]?.runtime || {}) as { is_remote?: boolean }
                        const isRemote = runtime?.is_remote === true
                        if (activationStatus[node] === 'failed' && !isRemote) {
                          onOpenActivate?.(factory, node)
                        } else {
                          onActivate?.(factory, node)
                        }
                      }} 
                      disabled={!hasPermission || activating || !!busy[node]}
                      className="bg-primary text-primary-foreground hover:bg-primary/90"
                      title={!hasPermission ? getPermissionTooltip?.() : ""}
                    >
                      {(() => {
                        const runtime = (nodesExtended?.[node]?.runtime || {}) as { is_remote?: boolean }
                        const isRemote = runtime?.is_remote === true
                        const actionText = isRemote ? 'Connect' : 'Activate'
                        return isBusy || isStarting ? 'Loading...' : actionText
                      })()}
                    </Button>
                  ) : (
                    isElectron ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (!hasPermission) {
                            showPermissionError?.()
                            return
                          }
                          onDownload?.(node)
                        }}
                        disabled={!hasPermission || !!busy[node] || !!installing[node]}
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                        title={!hasPermission ? getPermissionTooltip?.() : "Download prebuilt bundle"}
                      >
                        {installing[node] ? 'Installing...' : 'Download'}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (!hasPermission) {
                            showPermissionError?.()
                            return
                          }
                          onOpenActivate?.(factory, node)
                        }}
                        disabled={!hasPermission || activating || !!busy[node]}
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                        title={!hasPermission ? getPermissionTooltip?.() : (() => {
                          const runtime = (nodesExtended?.[node]?.runtime || {}) as { is_remote?: boolean }
                          const isRemote = runtime?.is_remote === true
                          return isRemote ? "Provide runtime to connect" : "Provide runtime to activate"
                        })()}
                      >
                        {(() => {
                          const runtime = (nodesExtended?.[node]?.runtime || {}) as { is_remote?: boolean }
                          const isRemote = runtime?.is_remote === true
                          return isRemote ? 'Connect' : 'Activate'
                        })()}
                      </Button>
                    )
                  )}
                  <div className="flex items-center gap-0">
                    <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" title="Settings" disabled={node === 'Scripts'}>
                      <Settings className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {node !== 'Scripts' && (
                          <>
                            {(() => {
                              // Only show reset option if bundle actually exists (has been downloaded and is executable)
                              const runtime = (nodesExtended?.[node]?.runtime || {})
                              const hasDownloadedBundle = runtime.bundle_exists === true
                              const resetLabel = hasDownloadedBundle ? 'Reinstall prebuilt bundle' : 'Reset to prebuilt bundle'
                              return isElectron && hasDownloadedBundle ? (
                                <DropdownMenuItem
                                  onSelect={(e) => {
                                    setTimeout(() => {
                                      if (!hasPermission) {
                                        showPermissionError?.()
                                        return
                                      }
                                      onDownload?.(node)
                                    }, 50)
                                  }}
                                  disabled={!hasPermission || !!busy[node] || !!installing[node]}
                                >
                                  {installing[node] ? 'Installing...' : resetLabel}
                                </DropdownMenuItem>
                              ) : null
                            })()}
                            {hasPreset ? (
                              <DropdownMenuItem 
                                onSelect={(e) => {
                                  setTimeout(() => {
                                    if (!hasPermission) {
                                      showPermissionError?.()
                                      return
                                    }
                                    onOpenActivate?.(factory, node)
                                  }, 50)
                                }}
                                disabled={!hasPermission}
                              >
                                Edit
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem 
                                onSelect={(e) => {
                                  setTimeout(() => {
                                    if (!hasPermission) {
                                      showPermissionError?.()
                                      return
                                    }
                                    onOpenActivate?.(factory, node)
                                  }, 50)
                                }}
                                disabled={!hasPermission}
                              >
                                {(() => {
                                  const runtime = (nodesExtended?.[node]?.runtime || {}) as { is_remote?: boolean }
                                  const isRemote = runtime?.is_remote === true
                                  return isRemote ? 'Connect manually' : 'Activate manually'
                                })()}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem 
                              onSelect={(e) => {
                                setTimeout(() => {
                                  if (!hasPermission) {
                                    toast.error("You do not have permission to operate this factory")
                                    return
                                  }
                                  onDelete?.(node)
                                }, 50)
                              }} 
                              disabled={!hasPermission}
                              className="text-destructive focus:text-destructive"
                            >
                              Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {activationStatus[node]==='failed' && failureMeta?.logPath ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="View Logs"
                        onClick={() => onShowLogs?.(node, { logPath: failureMeta.logPath!, env: failureMeta.env, port: failureMeta.port })}
                      >
                        <SquareTerminal className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

