import React, { useState, useEffect } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/router'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar } from "@/components/ui/avatar"
import { Star, Download, Database } from "lucide-react"
import { apiFetch } from '@/utils/common/apiFetch'
import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config'
import type { DatasetData } from '@/types/community.types'

interface DatasetCardProps {
  dataset: DatasetData
}

export default function DatasetCard({ dataset }: DatasetCardProps) {
  const router = useRouter()
  const [isStarred, setIsStarred] = useState(false)
  const [starCount, setStarCount] = useState(dataset.stats.stars || 0)
  const [isStarring, setIsStarring] = useState(false)
  const [authorAvatar, setAuthorAvatar] = useState<string | null>(null)

  const handleDatasetStarToggle = async () => {
    if (isStarring) return

    try {
      setIsStarring(true)
      const newIsStarred = !isStarred
      const newStarCount = newIsStarred ? starCount + 1 : starCount - 1

      // Optimistic update
      setIsStarred(newIsStarred)
      setStarCount(newStarCount)

      // Call API
      const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/datasets/${dataset.id}/star`, {
        method: newIsStarred ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      })

      // Update actual count
      if (result.starCount !== undefined) {
        setStarCount(result.starCount)
      }
    } catch (error) {
      console.error('Dataset star toggle failed:', error)
      // Roll back state
      setIsStarred(isStarred)
      setStarCount(starCount)
    } finally {
      setIsStarring(false)
    }
  }

  // Load author avatar from localStorage
  useEffect(() => {
    const loadAuthorAvatar = () => {
      if (dataset.author.user_id) {
        const savedAvatar = localStorage.getItem(`user_avatar_${dataset.author.user_id}`)
        setAuthorAvatar(savedAvatar)
      }
    }
    loadAuthorAvatar()

    const handleStorageChange = () => {
      loadAuthorAvatar()
    }
    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('localStorageChanged', handleStorageChange)

    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('localStorageChanged', handleStorageChange)
    }
  }, [dataset.author.user_id])

  const handleAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    const username = dataset.author.username || dataset.author.user_id || ''
    if (username) {
      router.push(`/profile/${username}`)
    }
  }

  // Function to get hierarchical colors based on tag content
  const getHierarchicalColor = (displayTag: string) => {
    const tag = displayTag.toLowerCase()

    if (tag.includes('tissue segmentation')) {
      return 'border border-primary/30 bg-primary/10 text-primary'
    }
    if (tag.includes('cell segmentation')) {
      return 'border border-secondary/40 bg-secondary/15 text-secondary-foreground'
    }
    if (tag.includes('nuclei classification')) {
      return 'border border-accent/40 bg-accent/15 text-accent-foreground'
    }
    if (tag.includes('code calculation')) {
      return 'border border-border bg-muted text-muted-foreground'
    }
    if (tag.includes('tissue classification')) {
      return 'border border-primary/30 bg-primary/5 text-primary'
    }

    if (tag === 'pathology') {
      return 'border border-primary/30 bg-primary/10 text-primary'
    }
    if (tag === 'radiology') {
      return 'border border-accent/30 bg-accent/10 text-accent-foreground'
    }
    if (tag === 'spatial transcriptomics') {
      return 'border border-secondary/30 bg-secondary/15 text-secondary-foreground'
    }

    return 'border border-border bg-muted text-muted-foreground'
  }

  return (
    <Card className="group cursor-pointer rounded-lg border border-border bg-card transition-all duration-200 hover:shadow-md">
      <CardHeader className="p-4">
        <CardTitle className="line-clamp-2 text-lg font-semibold transition-colors text-foreground group-hover:text-primary">
          {dataset.title}
        </CardTitle>
        <p className="text-sm text-muted-foreground line-clamp-2">
          {dataset.description}
        </p>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="mb-3 flex items-center gap-2">
          <Avatar
            onClick={handleAuthorClick}
            className="h-6 w-6 cursor-pointer transition-all hover:ring-2 hover:ring-primary/40"
          >
            {authorAvatar ? (
              <Image
                src={authorAvatar}
                alt={dataset.author.name}
                width={24}
                height={24}
                className="w-full h-full object-cover rounded-full"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-primary/20 via-primary/30 to-primary/40">
                <Database className="h-3 w-3 text-primary-foreground" />
              </div>
            )}
          </Avatar>
          <span
            onClick={handleAuthorClick}
            className="cursor-pointer text-sm font-medium transition-colors text-foreground hover:text-primary"
          >
            {dataset.author.name}
          </span>
        </div>
        
        <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="font-medium text-foreground">Size:</span>
              <span>{dataset.stats.size}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="font-medium text-foreground">Samples:</span>
              <span>{dataset.stats.samples.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-1">
              <Download className="h-3 w-3" />
              <span>{dataset.stats.downloads}</span>
            </div>
          </div>
        </div>
        
        <div className="mb-3 flex items-center justify-between">
          <button
            onClick={handleDatasetStarToggle}
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
            <span className="text-sm font-medium text-foreground">Stars: {starCount}</span>
          </button>
          <div className="text-xs text-muted-foreground">
            {new Date(dataset.stats.updatedAt).toLocaleDateString()}
          </div>
        </div>
        
        <div className="flex flex-wrap gap-1 mb-3">
          {dataset.tags.slice(0, 3).map((tag, tagIndex) => {
            const colorClass = getHierarchicalColor(tag)

            return (
              <Badge 
                key={tagIndex}
                className={`px-2 py-1 text-xs ${colorClass}`}
              >
                {tag}
              </Badge>
            )
          })}
          {dataset.tags.length > 3 && (
            <Badge variant="outline" className="border-border text-xs">
              +{dataset.tags.length - 3}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

