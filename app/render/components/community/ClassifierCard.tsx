import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ColorTag, getTagColor } from "@/components/ui/color-tag"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FACTORY_CATEGORIES } from '@/constants/community.constants'
import { COMMUNITY_API_ENDPOINT } from '@/config/api.config'
import type { ClassifierData } from '@/types/community.types'
import { apiFetch } from '@/utils/common/apiFetch'
import { getErrorMessage } from '@/utils/common/apiResponse'
import { downloadCommunityClassifier } from '@/services/fileManager.service'
import { getWorkflowsReferencingClassifier } from '@/services/communityWorkflows.service'
import { useAuthorProfile } from '@/hooks/community/useAuthorProfile'
import { Download, Star, Trash2, User } from "lucide-react"
import Image from 'next/image'
import { useRouter } from 'next/router'
import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'

interface ClassifierCardProps {
  classifier: ClassifierData
  compact?: boolean
  onDelete?: (classifierId: string) => void
  canDelete?: boolean
  onTagClick?: (tag: string) => void
  onStatsUpdate?: (classifierId: string, stats: { downloads?: number; stars?: number }) => void
}

type ReferencingWorkflow = { id: string; name: string; author?: string }

export default function ClassifierCard({
  classifier,
  compact = false,
  onDelete,
  canDelete = false,
  onTagClick,
  onStatsUpdate,
}: ClassifierCardProps) {
  const router = useRouter()
  const [isStarred, setIsStarred] = useState(false)
  const [starCount, setStarCount] = useState(classifier.stats.stars || 0)
  const [downloadCount, setDownloadCount] = useState(classifier.stats.downloads || 0)
  const [isStarring, setIsStarring] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  // Lazy-loaded reference list shown inline in the delete dialog. null until the
  // first fetch completes; only `uploaded-*` classifiers are indexed server-side.
  const [referencingWorkflows, setReferencingWorkflows] = useState<ReferencingWorkflow[] | null>(null)
  const [referencingLoading, setReferencingLoading] = useState(false)

  // Re-fetch every time the dialog opens — the list could have changed since
  // the last open (someone might have published a workflow that uses this).
  useEffect(() => {
    if (!showDeleteDialog) {
      setReferencingWorkflows(null)
      setReferencingLoading(false)
      return
    }
    if (!classifier.id.startsWith("uploaded-")) return
    let cancelled = false
    setReferencingLoading(true)
    getWorkflowsReferencingClassifier(classifier.id)
      .then((resp) => {
        if (cancelled) return
        if (resp?.success && Array.isArray(resp.workflows)) {
          setReferencingWorkflows(
            resp.workflows.map((w) => ({ id: w.id, name: w.name, author: w.author }))
          )
        } else {
          setReferencingWorkflows([])
        }
      })
      .catch(() => {
        // Reference fetch is advisory; failure shouldn't block the user from deleting.
        if (!cancelled) setReferencingWorkflows([])
      })
      .finally(() => {
        if (!cancelled) setReferencingLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [showDeleteDialog, classifier.id])
  // Author's display name + avatar resolved per-uid via the stateless
  // /community/v1/users/{uid}/public-profile endpoint. Browser HTTP cache and
  // module-level dedupe inside the hook keep this off the wire after the
  // first card resolves a given uid on the page.
  const ownerId = classifier.author?.user_id || null
  const authorProfile = useAuthorProfile(ownerId)
  const [authorAvatar, setAuthorAvatar] = useState<string | null>(null)
  const [showAllTags, setShowAllTags] = useState(false)
  const [showClassifierDetail, setShowClassifierDetail] = useState(false)

  // Fetch latest data from Firebase
  const fetchLatestData = async () => {
    try {
      const response = await apiFetch(`${COMMUNITY_API_ENDPOINT}/community/v1/classifiers/${classifier.id}`, {
        method: 'GET'
      })
      
      if (response.star_count !== undefined) {
        setStarCount(response.star_count)
      }
      if (response.is_starred !== undefined) {
        setIsStarred(response.is_starred)
      }
      if (response.classifier?.stats?.downloads !== undefined) {
        setDownloadCount(response.classifier.stats.downloads)
      }
    } catch (error) {
      console.warn('Failed to fetch latest data:', error)
    }
  }

  // Get data when initializing
  useEffect(() => {
    fetchLatestData()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifier.id])

  // Reconcile the displayed avatar from two sources:
  //   1. Backend public profile (works for every viewer).
  //   2. localStorage `user_avatar_<uid>` — only ever populated for the
  //      current user's own avatar, so it acts as a freshness boost for the
  //      owner (newly uploaded avatars appear before HTTP cache expires).
  // The displayed value is held in component state so `<img onError>` can
  // null it and fall back to the gradient placeholder if the URL 404s.
  useEffect(() => {
    const reconcile = () => {
      let next: string | null = authorProfile?.avatarUrl || null
      if (typeof window !== 'undefined' && ownerId) {
        const ownOverride = localStorage.getItem(`user_avatar_${ownerId}`)
        if (ownOverride) next = ownOverride
      }
      setAuthorAvatar(next)
    }
    reconcile()
    if (typeof window === 'undefined') return
    window.addEventListener('storage', reconcile)
    window.addEventListener('localStorageChanged', reconcile)
    return () => {
      window.removeEventListener('storage', reconcile)
      window.removeEventListener('localStorageChanged', reconcile)
    }
  }, [ownerId, authorProfile?.avatarUrl])

  // Listen for SSE-driven stats updates
  useEffect(() => {
    const handleStatsUpdate = (event: CustomEvent) => {
      const { classifierId, stats } = event.detail
      if (classifierId === classifier.id) {
        if (stats.downloads !== undefined) {
          setDownloadCount(stats.downloads)
        }
        if (stats.stars !== undefined) {
          setStarCount(stats.stars)
        }
        if (onStatsUpdate) {
          onStatsUpdate(classifierId, stats)
        }
      }
    }

    window.addEventListener('classifierStatsUpdated', handleStatsUpdate as EventListener)
    
    return () => {
      window.removeEventListener('classifierStatsUpdated', handleStatsUpdate as EventListener)
    }
  }, [classifier.id, onStatsUpdate])

  // Handle star toggle
  const handleStarToggle = async () => {
    if (isStarring) return

    try {
      setIsStarring(true)
      const newIsStarred = !isStarred

      const result = await apiFetch(`${COMMUNITY_API_ENDPOINT}/community/v1/classifiers/${classifier.id}/star`, {
        method: newIsStarred ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      })

      if (result.success) {
        await fetchLatestData()
        
        if (onStatsUpdate) {
          onStatsUpdate(classifier.id, { stars: result.starCount || 0 })
        }
      } else {
        throw new Error(result.message || 'Star operation failed')
      }
    } catch (error) {
      console.error('Star operation failed:', error)
      await fetchLatestData()
    } finally {
      setIsStarring(false)
    }
  }

  const handleAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    const username = classifier.author?.username || classifier.author?.user_id || ''
    if (username) {
      router.push(`/profile/${username}`)
    }
  }

  const handleDownloadClassifier = async () => {
    try {
      setIsDownloading(true)
      
      const filename = `${classifier.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.tlcls`
      
      await downloadCommunityClassifier(classifier.id, filename, (progress) => {
        // Progress callback can be used for future enhancements
        if (progress.state === 'completed') {
          // Download completed
        }
      })
      
      // Polling: fetch detail until downloads increases or timeout
      try {
        const baseline = Number(downloadCount || 0)
        const startedAt = Date.now()
        const timeoutMs = 5000
        const intervalMs = 300
        let latest = baseline
        
        while (Date.now() - startedAt < timeoutMs) {
          try {
            const result = await apiFetch(`${COMMUNITY_API_ENDPOINT}/community/v1/classifiers/${classifier.id}`, { method: 'GET' })
            latest = Number(result?.classifier?.stats?.downloads ?? latest)
            if (latest > baseline) {
              setDownloadCount(latest)
              
              if (classifier.id.startsWith('uploaded-')) {
                try {
                  const saved = JSON.parse(localStorage.getItem('userUploadedClassifiers') || '[]')
                  const updated = saved.map((c: any) => c.id === classifier.id ? { ...c, stats: { ...c.stats, downloads: latest } } : c)
                  localStorage.setItem('userUploadedClassifiers', JSON.stringify(updated))
                } catch {}
              }
              if (onStatsUpdate) onStatsUpdate(classifier.id, { downloads: latest })
              break
            }
          } catch {}
          await new Promise(res => setTimeout(res, intervalMs))
        }
        
        if (latest !== baseline) {
          setDownloadCount(latest)
          if (onStatsUpdate) onStatsUpdate(classifier.id, { downloads: latest })
        }
      } catch (error) {
        console.warn('Download count polling failed:', error)
      }
    } catch (e) {
      console.error('Download error:', e)
      if ((e as any)?.status === 404 && (e as any)?.message?.includes('not found') && canDelete) {
        if (onDelete) onDelete(classifier.id)
      }
      toast.error(getErrorMessage(e, 'Download failed'))
      
    } finally {
      setIsDownloading(false)
    }
  }

  const handleDeleteClassifier = async () => {
    try {
      setIsDeleting(true)
      
      if (onDelete) {
        await onDelete(classifier.id)
      }
      
      setShowDeleteDialog(false)
    } catch (error: any) {
      console.error('Delete error:', error)
      toast.error(getErrorMessage(error, 'Delete failed'))
    } finally {
      setIsDeleting(false)
    }
  }
  
  // Build display tags
  const modalityTags = ['pathology', 'radiology', 'spatial transcriptomics']
  const factoryId = classifier.factory
  const nodeId = classifier.node
  const factoryCategory = FACTORY_CATEGORIES.find(f => f.id === factoryId)
  const factoryDisplayName = factoryCategory?.name || factoryId
  
  const displayTags: Array<{text: string, isFactory: boolean, originalTag: string}> = []
  
  // Add factory tag (main class)
  displayTags.push({
    text: factoryDisplayName || factoryId || 'Unknown',
    isFactory: true,
    originalTag: factoryDisplayName || factoryId || 'Unknown'
  })

  // Add node tag if exists (sub class)
  if (nodeId && nodeId !== 'undefined' && nodeId !== '' && !(factoryDisplayName || factoryId || 'Unknown').toLowerCase().includes(nodeId.toLowerCase())) {
    displayTags.push({
      text: nodeId,
      isFactory: false,
      originalTag: nodeId
    })
  }
  
  // Add modality tags (if any)
  classifier.tags.forEach(t => {
    if (modalityTags.includes(t.toLowerCase())) {
      displayTags.push({
        text: t,
        isFactory: false,
        originalTag: t
      })
    }
  })
  
  const tagsToShow = showAllTags ? displayTags : displayTags.slice(0, compact ? 2 : 3)
  const totalTags = displayTags.length
  const maxTags = compact ? 2 : 3
  
  return (
    <Card className="group cursor-pointer rounded-lg border border-border bg-card transition-all duration-200 hover:shadow-md">
      <CardHeader className={compact ? "p-3" : "p-4"}>
        <CardTitle
          className={`${compact ? 'text-base' : 'text-lg'} flex items-start gap-2 cursor-pointer font-semibold leading-snug transition-colors text-foreground group-hover:text-primary`}
          onClick={(e) => {
            e.stopPropagation()
            setShowClassifierDetail(true)
          }}
        >
          {/* Equilateral triangle (outline only) marks this as a classifier — matches the workflow legend. */}
          <svg aria-hidden width="12" height="10" viewBox="0 0 12 10" className="mt-[5px] shrink-0">
            <polygon
              points="6,1 1,9 11,9"
              className="fill-none stroke-gray-500 dark:stroke-gray-400"
              strokeWidth={1.2}
              strokeLinejoin="round"
            />
          </svg>
          <span className="min-w-0">{classifier.title}</span>
        </CardTitle>
        <p className={`${compact ? 'text-xs' : 'text-sm'} text-muted-foreground line-clamp-2`}>
          {classifier.description}
        </p>
      </CardHeader>
      <CardContent className={compact ? "p-3 pt-0" : "p-4 pt-0"}>
        <div className="flex items-start gap-2 mb-3">
          <Avatar
            onClick={handleAuthorClick}
            className={`${compact ? 'h-5 w-5' : 'h-6 w-6'} shrink-0 cursor-pointer transition-all hover:ring-2 hover:ring-primary/40`}
          >
            {authorAvatar ? (
              <Image
                src={authorAvatar}
                alt={authorProfile?.displayName || classifier.author?.name || 'Unknown Author'}
                width={24}
                height={24}
                className="w-full h-full object-cover rounded-full"
                onError={() => setAuthorAvatar(null)}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center rounded-full bg-linear-to-br from-primary/20 via-primary/30 to-primary/40">
                <User className={`${compact ? 'h-2 w-2' : 'h-3 w-3'} text-primary-foreground`} />
              </div>
            )}
          </Avatar>
          <span
            onClick={handleAuthorClick}
            className={`${compact ? 'text-xs' : 'text-sm'} min-w-0 flex-1 break-words cursor-pointer font-medium transition-colors text-foreground hover:text-primary`}
          >
            {authorProfile?.displayName || classifier.author?.name || 'Unknown Author'}
          </span>
        </div>
        
        <div className={`mb-3 flex items-center justify-between ${compact ? 'text-xs' : 'text-xs'} text-muted-foreground`}>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="font-medium text-foreground">Size:</span>
              <span>{classifier.stats.size}</span>
            </div>
            <div className="flex items-center gap-1">
              <Download className="h-3 w-3" />
              <span>{downloadCount}</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={handleStarToggle}
            disabled={isStarring}
            className="-ml-1 flex items-center gap-1 rounded-md p-1 transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            title={isStarred ? 'Remove star' : 'Add star'}
          >
            <Star
              className={`h-4 w-4 transition-colors ${
                isStarred
                  ? 'fill-primary text-primary'
                  : 'text-muted-foreground hover:text-primary'
              } ${isStarring ? 'animate-pulse' : ''}`}
            />
            <span className="text-sm font-medium">
              Stars: {starCount}
              {isStarring && <span className="ml-1 text-xs text-muted-foreground">...</span>}
            </span>
          </button>
          <div className="text-xs text-muted-foreground">
            {(() => {
              try {
                const date = new Date(classifier.stats.updatedAt)
                return isNaN(date.getTime()) ? 'Recent' : date.toLocaleDateString()
              } catch {
                return 'Recent'
              }
            })()}
          </div>
        </div>
        
        <div className="flex flex-wrap gap-1 mb-3">
          {tagsToShow.map((displayTag, displayIndex) => {
            const tagColor = getTagColor(displayTag.text, displayTag.isFactory, factoryDisplayName || factoryId || 'Unknown')
            
            return (
              <ColorTag 
                key={`classifier-${displayIndex}`}
                color={tagColor}
                onClick={() => onTagClick?.(displayTag.text)}
              >
                {displayTag.text}
              </ColorTag>
            )
          })}
          {totalTags > maxTags && !showAllTags ? (
            <ColorTag
              color="default"
              onClick={(e) => {
                e.stopPropagation()
                setShowAllTags(true)
              }}
            >
              +{totalTags - maxTags}
            </ColorTag>
          ) : showAllTags && totalTags > maxTags ? (
            <ColorTag
              color="default"
              onClick={(e) => {
                e.stopPropagation()
                setShowAllTags(false)
              }}
            >
              Show Less
            </ColorTag>
          ) : null}
        </div>
        
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="flex-1"
            variant="outline"
            onClick={handleDownloadClassifier}
            disabled={isDownloading}
          >
            {isDownloading ? (
              <>
                <div className="mr-1 h-3 w-3 animate-spin rounded-full border-b-2 border-current"></div>
                Downloading...
              </>
            ) : (
              <>
                <Download className="w-3 h-3 mr-1" />
                Download
              </>
            )}
          </Button>
          
          {canDelete && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setShowDeleteDialog(true)}
              disabled={isDownloading || isDeleting}
              className="shrink-0"
            >
              {isDeleting ? (
                <div className="h-3 w-3 animate-spin rounded-full border-b-2 border-current"></div>
              ) : (
                <Trash2 className="w-3 h-3" />
              )}
            </Button>
          )}
        </div>
        
        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Classifier</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete &quot;{classifier.title}&quot;? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {/* Inline reference warning — replaces the prior standalone "delete anyway?" dialog. */}
            {referencingLoading && (
              <div className="mt-3 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Checking which community workflows use this classifier…
              </div>
            )}
            {!referencingLoading && referencingWorkflows && referencingWorkflows.length > 0 && (
              <div className="mt-3 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
                <div className="font-medium text-destructive">
                  Used by {referencingWorkflows.length} community workflow{referencingWorkflows.length === 1 ? "" : "s"} —
                  importers will see a broken classifier link until they manually load a replacement.
                </div>
                <ul className="max-h-32 space-y-0.5 overflow-y-auto pl-4 text-muted-foreground">
                  {referencingWorkflows.map((w) => (
                    <li key={w.id} className="list-disc">
                      <span className="font-medium text-foreground">{w.name || w.id}</span>
                      {w.author && <span> — {w.author}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <Button
                variant="outline"
                onClick={() => setShowDeleteDialog(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeleteClassifier}
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <>
                    <div className="mr-1 h-3 w-3 animate-spin rounded-full border-b-2 border-current"></div>
                    Deleting...
                  </>
                ) : referencingWorkflows && referencingWorkflows.length > 0 ? (
                  'Delete anyway'
                ) : (
                  'Delete'
                )}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>

      {/* Classifier Detail Dialog */}
      <Dialog open={showClassifierDetail} onOpenChange={setShowClassifierDetail}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-primary">
              {classifier.title}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Classifier details and description
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <h3 className="mb-2 text-base font-semibold text-foreground">About Classifier</h3>
              <div className="text-sm leading-relaxed text-muted-foreground break-words overflow-wrap-anywhere">
                {classifier.description}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 pt-4 border-t">
              <div className="text-sm text-muted-foreground">
                <span className="font-medium">Size:</span> {classifier.stats.size}
              </div>
              <div className="text-sm text-muted-foreground">
                <span className="font-medium">Author:</span> {authorProfile?.displayName || classifier.author?.name || 'Unknown Author'}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </Card>
  )
}
