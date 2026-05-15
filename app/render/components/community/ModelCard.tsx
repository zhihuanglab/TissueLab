'use client'

import React, { useState, useEffect } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/router'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ColorTag, getTagColor } from "@/components/ui/color-tag"
import { Avatar } from "@/components/ui/avatar"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Star, Download, User, Trash2 } from "lucide-react"
import { toast } from 'sonner'
import { apiFetch } from '@/utils/common/apiFetch'
import { getErrorMessage } from '@/utils/common/apiResponse'
import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config'
import { downloadCommunityModel } from '@/utils/dashboard/fileManager.service'
import { FACTORY_CATEGORIES } from '@/constants/community.constants'
import type { ModelData } from '@/types/community.types'

interface ModelCardProps {
  model: ModelData
  compact?: boolean
  onDelete?: (modelId: string) => void
  canDelete?: boolean
  onTagClick?: (tag: string) => void
  onStatsUpdate?: (modelId: string, stats: { downloads?: number; stars?: number }) => void
}

export default function ModelCard({ 
  model, 
  compact = false, 
  onDelete, 
  canDelete = false, 
  onTagClick, 
  onStatsUpdate 
}: ModelCardProps) {
  const router = useRouter()
  const [isStarred, setIsStarred] = useState(false)
  const [starCount, setStarCount] = useState(model.stats.stars || 0)
  const [downloadCount, setDownloadCount] = useState(model.stats.downloads || 0)
  const [isStarring, setIsStarring] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [authorAvatar, setAuthorAvatar] = useState<string | null>(null)
  const [showAllTags, setShowAllTags] = useState(false)
  const [showModelDetail, setShowModelDetail] = useState(false)

  // Fetch latest data from Firebase
  const fetchLatestData = async () => {
    try {
      const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/models/${model.id}`, {
        method: 'GET'
      })
      
      if (response.star_count !== undefined) {
        setStarCount(response.star_count)
      }
      if (response.is_starred !== undefined) {
        setIsStarred(response.is_starred)
      }
      if (response.model?.stats?.downloads !== undefined) {
        setDownloadCount(response.model.stats.downloads)
      }
    } catch (error) {
      console.warn('Failed to fetch latest data:', error)
    }
  }

  // Get data when initializing
  useEffect(() => {
    fetchLatestData()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.id])

  // Load author avatar from localStorage
  useEffect(() => {
    const loadAuthorAvatar = () => {
      if (typeof window !== 'undefined' && model.author?.user_id) {
        const savedAvatar = localStorage.getItem(`user_avatar_${model.author.user_id}`)
        setAuthorAvatar(savedAvatar)
      }
    }
    loadAuthorAvatar()

    const handleStorageChange = () => {
      loadAuthorAvatar()
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', handleStorageChange)
      window.addEventListener('localStorageChanged', handleStorageChange)
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', handleStorageChange)
        window.removeEventListener('localStorageChanged', handleStorageChange)
      }
    }
  }, [model.author?.user_id])

  // Listen for SSE-driven stats updates
  useEffect(() => {
    const handleStatsUpdate = (event: CustomEvent) => {
      const { modelId, stats } = event.detail
      if (modelId === model.id) {
        if (stats.downloads !== undefined) {
          setDownloadCount(stats.downloads)
        }
        if (stats.stars !== undefined) {
          setStarCount(stats.stars)
        }
        if (onStatsUpdate) {
          onStatsUpdate(modelId, stats)
        }
      }
    }

    window.addEventListener('modelStatsUpdated', handleStatsUpdate as EventListener)
    
    return () => {
      window.removeEventListener('modelStatsUpdated', handleStatsUpdate as EventListener)
    }
  }, [model.id, onStatsUpdate])

  // Handle star toggle
  const handleStarToggle = async () => {
    if (isStarring) return

    try {
      setIsStarring(true)
      const newIsStarred = !isStarred

      const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/models/${model.id}/star`, {
        method: newIsStarred ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      })

      if (result.success) {
        await fetchLatestData()
        
        if (onStatsUpdate) {
          onStatsUpdate(model.id, { stars: result.starCount || 0 })
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
    const username = model.author?.username || model.author?.user_id || ''
    if (username) {
      router.push(`/profile/${username}`)
    }
  }

  const handleDownloadModel = async () => {
    try {
      setIsDownloading(true)
      
      const filename = `${model.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.zip`
      
      await downloadCommunityModel(model.id, filename, (progress) => {
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
            const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/models/${model.id}`, { method: 'GET' })
            latest = Number(result?.model?.stats?.downloads ?? latest)
            if (latest > baseline) {
              setDownloadCount(latest)
              
              if (model.id.startsWith('uploaded-')) {
                try {
                  const saved = JSON.parse(localStorage.getItem('userUploadedModels') || '[]')
                  const updated = saved.map((m: any) => m.id === model.id ? { ...m, stats: { ...m.stats, downloads: latest } } : m)
                  localStorage.setItem('userUploadedModels', JSON.stringify(updated))
                } catch {}
              }
              if (onStatsUpdate) onStatsUpdate(model.id, { downloads: latest })
              break
            }
          } catch {}
          await new Promise(res => setTimeout(res, intervalMs))
        }
        
        if (latest !== baseline) {
          setDownloadCount(latest)
          if (onStatsUpdate) onStatsUpdate(model.id, { downloads: latest })
        }
      } catch (error) {
        console.warn('Download count polling failed:', error)
      }
    } catch (e) {
      console.error('Download error:', e)
      if ((e as any)?.status === 404 && (e as any)?.message?.includes('not found') && canDelete) {
        if (onDelete) onDelete(model.id)
      }
      toast.error(getErrorMessage(e, 'Download failed'))
    
    } finally {
      setIsDownloading(false)
    }
  }

  const handleDeleteModel = async () => {
    try {
      setIsDeleting(true)
      
      if (onDelete) {
        await onDelete(model.id)
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
  const factoryId = model.factory
  const nodeId = model.node
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
  model.tags.forEach(t => {
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
          className={`${compact ? 'text-base' : 'text-lg'} cursor-pointer font-semibold leading-snug transition-colors group-hover:text-primary`}
          onClick={(e) => {
            e.stopPropagation()
            setShowModelDetail(true)
          }}
        >
          {model.title}
        </CardTitle>
        <p className={`${compact ? 'text-xs' : 'text-sm'} text-muted-foreground line-clamp-2`}>
          {model.description}
        </p>
      </CardHeader>
      <CardContent className={compact ? "p-3 pt-0" : "p-4 pt-0"}>
        <div className="flex items-start gap-2 mb-3">
          <Avatar
            onClick={handleAuthorClick}
            className={`${compact ? 'h-5 w-5' : 'h-6 w-6'} flex-shrink-0 cursor-pointer transition-all hover:ring-2 hover:ring-primary/40`}
          >
            {authorAvatar ? (
              <Image
                src={authorAvatar}
                alt={model.author?.name || 'Unknown Author'}
                width={24}
                height={24}
                className="w-full h-full object-cover rounded-full"
                onError={() => setAuthorAvatar(null)}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-primary/20 via-primary/30 to-primary/40">
                <User className={`${compact ? 'h-2 w-2' : 'h-3 w-3'} text-primary-foreground`} />
              </div>
            )}
          </Avatar>
          <span
            onClick={handleAuthorClick}
            className={`${compact ? 'text-xs' : 'text-sm'} min-w-0 flex-1 break-words cursor-pointer font-medium transition-colors hover:text-primary`}
          >
            {model.author?.name || 'Unknown Author'}
          </span>
        </div>
        
        <div className={`mb-3 flex items-center justify-between ${compact ? 'text-xs' : 'text-xs'} text-muted-foreground`}>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="font-medium text-foreground">Size:</span>
              <span>{model.stats.size}</span>
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
                const date = new Date(model.stats.updatedAt)
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
                key={`model-${displayIndex}`}
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
            onClick={handleDownloadModel}
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
              className="flex-shrink-0"
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
              <DialogTitle>Delete Model</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete &quot;{model.title}&quot;? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
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
                onClick={handleDeleteModel}
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <>
                    <div className="mr-1 h-3 w-3 animate-spin rounded-full border-b-2 border-current"></div>
                    Deleting...
                  </>
                ) : (
                  'Delete'
                )}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>

      {/* Model Detail Dialog */}
      <Dialog open={showModelDetail} onOpenChange={setShowModelDetail}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-primary">
              {model.title}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Model details and description
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <h3 className="mb-2 text-base font-semibold text-foreground">About Model</h3>
              <div className="text-sm leading-relaxed text-muted-foreground break-words overflow-wrap-anywhere">
                {model.description}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 pt-4 border-t">
              <div className="text-sm text-muted-foreground">
                <span className="font-medium">Size:</span> {model.stats.size}
              </div>
              <div className="text-sm text-muted-foreground">
                <span className="font-medium">Author:</span> {model.author?.name || 'Unknown Author'}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </Card>
  )
}



