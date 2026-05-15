"use client";
import React, { useState, useEffect, useCallback } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '@/store'
import { useRouter } from 'next/router'
import Image from 'next/image'
import { communityService } from '@/services/community.service'
import { classifiersService } from '@/services/classifiers.service'
import { usersService, UserProfile as APIUserProfile } from '@/services/users.service'
import { apiFetch } from '@/utils/common/apiFetch'
import { getErrorMessage } from '@/utils/common/apiResponse'
import { InlineSpinner } from '@/components/assets/PageLoading'
import { ClassifiersHeader } from '@/components/community/Classifiers-Header'
import { ColorTag, getTagColor } from '@/components/ui/color-tag'
import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config'
import { useUserInfo } from '@/provider/UserInfoProvider'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { downloadCommunityClassifier, downloadCommunityModel } from '@/utils/dashboard/fileManager.service'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Award,
  Building2,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Eye,
  Link as LinkIcon,
  Mail,
  MapPin,
  Search,
  ArrowUpDown,
  Package,
  Share2,
  Star,
  Trash2,
  User
} from "lucide-react"

interface UserProfile {
  username: string
  displayName: string
  avatar: string
  joinDate: string
  lastActive: string
  location?: string
  organization?: string
  website?: string
  email?: string
  bio: string
  stats: {
    totalClassifiers: number
    totalModels: number
    totalStars: number
    totalDownloads: number
    followers: number
    following: number
  }
}

interface UserClassifier {
  id: string
  title: string
  description: string
  stats: {
    classes: number | null
    size: string
    stars: number
    downloads: number
    updatedAt: string
  }
  tags: string[]
  thumbnail: string
  factory?: string
  model?: string
  node?: string
}

interface UserModel {
  id: string
  title: string
  description: string
  stats: {
    size: string
    stars: number
    downloads: number
    updatedAt: string
  }
  tags: string[]
  thumbnail: string
  factory?: string
  model?: string
  node?: string
}




const convertAPIProfileToUserProfile = (apiProfile: APIUserProfile, username: string): UserProfile => {

  // Get preferred name and avatar from localStorage as fallback
  const localPreferredName = typeof window !== 'undefined'
    ? localStorage.getItem(`preferred_name_${username}`)
    : null;

  // Try to get avatar from localStorage as fallback
  const localUserAvatar = typeof window !== 'undefined'
    ? localStorage.getItem(`user_avatar_${username}`)
    : null;

  // Get cached stats from localStorage to prevent flicker
  const cachedStats = typeof window !== 'undefined'
    ? JSON.parse(localStorage.getItem(`user_stats_${username}`) || '{}')
    : {};

  return {
    username: username,
    displayName: apiProfile.preferred_name || localPreferredName || apiProfile.email?.split('@')[0] || `User ${username.substring(0, 8)}`,
    avatar: apiProfile.avatar_url || localUserAvatar || '/avatars/default.jpg',
    joinDate: apiProfile.registered_at ? new Date(apiProfile.registered_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
    lastActive: new Date().toISOString().split('T')[0], // Today
    location: undefined, // We'll set this separately if needed
    organization: apiProfile.organization,
    email: apiProfile.email,
    bio: apiProfile.custom_title || `Community member with email ${apiProfile.email}. This user has uploaded classifiers to share with the TissueLab community.`,
    stats: {
      totalClassifiers: cachedStats.totalClassifiers ?? 1,
      totalModels: cachedStats.totalModels ?? 0,
      totalStars: cachedStats.totalStars ?? 0,
      totalDownloads: cachedStats.totalDownloads ?? 0,
      followers: cachedStats.followers ?? 0,
      following: cachedStats.following ?? 0
    }
  }
}


const fetchUserClassifiersFromAPI = async (username: string): Promise<UserClassifier[]> => {
  try {
    // Prefer fetching from Firebase public list (includes factory/model fields)
    const response = await classifiersService.getPublicClassifiers({ limit: 200 });
    const baseList = response.classifiers || [];

    const userClassifiers = baseList.filter((c: any) => c.ownerId === username);

    const toIso = (v: any) => {
      try {
        if (!v) return new Date().toISOString();
        if (typeof v === 'object' && typeof v.seconds === 'number') return new Date(v.seconds * 1000).toISOString();
        const d = new Date(v);
        return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
      } catch { return new Date().toISOString(); }
    };

    // Convert to UserClassifier format with modality + factory/model tags
    return userClassifiers.map((fc: any) => {
      const factoryId = fc.factory;
      const nodeId = fc.model || fc.node;
      const modalityTags = Array.isArray(fc.tags) ? fc.tags : [];

      const categoryDisplay: Record<string, string> = {
        'tissue_segmentation': 'Tissue Segmentation',
        'cell_segmentation': 'Cell Segmentation + Embedding',
        'nuclei_classification': 'Nuclei Classification',
        'code_calculation': 'Coding Agent',
        'tissue_classification': 'Tissue Classification',
      };

      const tags: string[] = [];
      const factoryDisplay = factoryId ? (categoryDisplay[factoryId] || factoryId) : '';
      if (factoryDisplay) tags.push(factoryDisplay);
      if (nodeId && (!factoryDisplay || !factoryDisplay.toLowerCase().includes(String(nodeId).toLowerCase()))) tags.push(nodeId);
      for (const t of modalityTags) if (typeof t === 'string') tags.push(t);
      
      // Remove duplicates (case-insensitive)
      const uniqueTags = tags.filter((tag, index, self) => 
        index === self.findIndex((t) => t.toLowerCase() === tag.toLowerCase())
      );

      const fileSize = fc.fileSize || fc.stats?.size || 0;
      const downloads = fc.stats?.downloads || 0;
      const stars = fc.stats?.stars || 0;

      return {
        id: fc.id,
        title: fc.title,
        description: fc.description || 'User uploaded classifier',
        stats: {
          classes: fc.classesCount ?? fc.stats?.classes ?? null,
          size: typeof fileSize === 'number' ? `${(fileSize / (1024 * 1024)).toFixed(2)} MB` : String(fileSize),
          stars,
          downloads,
          updatedAt: toIso(fc.updatedAt || fc.stats?.updatedAt),
        },
        tags: uniqueTags,
        thumbnail: '/thumbnails/default.jpg',
        factory: factoryId,
        model: fc.model || '',
        node: fc.model || ''
      } as UserClassifier;
    });
  } catch (error) {
    console.error('Failed to fetch user classifiers from API:', error);
    return [];
  }
}

// Helper function to format file size to MB
const formatSizeToMB = (size: any): string => {
  if (typeof size === 'string') {
    // If already formatted (contains MB/GB), return as-is
    if (size.toLowerCase().includes('mb') || size.toLowerCase().includes('gb')) {
      return size;
    }
    // Try to parse as number (bytes)
    const numSize = parseFloat(size);
    if (!isNaN(numSize) && numSize > 0) {
      return `${(numSize / (1024 * 1024)).toFixed(2)} MB`;
    }
  } else if (typeof size === 'number' && size > 0) {
    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  }
  return 'Unknown';
};

const fetchUserModelsFromAPI = async (username: string): Promise<UserModel[]> => {
  try {
    // Fetch from Firebase models public list
    const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/models/public`, {
      method: 'GET'
    });
    const baseList = response?.models || [];

    const userModels = baseList.filter((m: any) => m.ownerId === username);

    const toIso = (v: any) => {
      try {
        if (!v) return new Date().toISOString();
        if (typeof v === 'object' && typeof v.seconds === 'number') return new Date(v.seconds * 1000).toISOString();
        const d = new Date(v);
        return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
      } catch { return new Date().toISOString(); }
    };

    // Convert to UserModel format with modality + factory/model tags
    return userModels.map((fm: any) => {
      const factoryId = fm.factory;
      const nodeId = fm.model || fm.node;
      const modalityTags = Array.isArray(fm.tags) ? fm.tags : [];

      const categoryDisplay: Record<string, string> = {
        'tissue_segmentation': 'Tissue Segmentation',
        'cell_segmentation': 'Cell Segmentation + Embedding',
        'nuclei_classification': 'Nuclei Classification',
        'code_calculation': 'Coding Agent',
        'tissue_classification': 'Tissue Classification',
      };

      const tags: string[] = [];
      const factoryDisplay = factoryId ? (categoryDisplay[factoryId] || factoryId) : '';
      if (factoryDisplay) tags.push(factoryDisplay);
      if (nodeId && (!factoryDisplay || !factoryDisplay.toLowerCase().includes(String(nodeId).toLowerCase()))) tags.push(nodeId);
      for (const t of modalityTags) if (typeof t === 'string') tags.push(t);
      
      // Remove duplicates (case-insensitive)
      const uniqueTags = tags.filter((tag, index, self) => 
        index === self.findIndex((t) => t.toLowerCase() === tag.toLowerCase())
      );

      // Try multiple possible size field names
      const fileSize = fm.fileSize || fm.file_size || fm.size || fm.stats?.size || fm.stats?.fileSize || 0;
      const downloads = fm.stats?.downloads || 0;
      const stars = fm.stats?.stars || 0;

      return {
        id: fm.id,
        title: fm.title,
        description: fm.description || 'User uploaded model',
        stats: {
          size: formatSizeToMB(fileSize),
          stars,
          downloads,
          updatedAt: toIso(fm.updatedAt || fm.stats?.updatedAt),
        },
        tags: uniqueTags,
        thumbnail: '/thumbnails/default.jpg',
        factory: factoryId,
        model: fm.model || '',
        node: fm.model || ''
      } as UserModel;
    });
  } catch (error) {
    console.error('Failed to fetch user models from API:', error);
    return [];
  }
}

const UserModelCard = React.memo(function UserModelCard({ model, isCurrentUser, onTagClick, userProfile }: { model: UserModel, isCurrentUser: boolean, onTagClick?: (tag: string) => void, userProfile?: UserProfile }) {
  const [isDownloading, setIsDownloading] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  const [isStarred, setIsStarred] = useState(false)
  const [starCount, setStarCount] = useState(model.stats.stars || 0)
  const [downloadCount, setDownloadCount] = useState(model.stats.downloads || 0)
  const [isStarring, setIsStarring] = useState(false)

  // Initialize star status
  useEffect(() => {
    const initializeStarStatus = async () => {
      try {
        const userStars = JSON.parse(localStorage.getItem('user_model_stars') || '{}')
        if (userStars[model.id] !== undefined) {
          setIsStarred(userStars[model.id])
        }
      } catch (error) {
        console.warn('Failed to load star status from localStorage:', error)
      }

      try {
        const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/models/${model.id}`, {
          method: 'GET'
        })

        if (result) {
          const apiIsStarred = result.is_starred || false
          const apiStarCount = result.model?.stats?.stars || model.stats.stars || 0

          setIsStarred(apiIsStarred)
          setStarCount(apiStarCount)

          try {
            const userStars = JSON.parse(localStorage.getItem('user_model_stars') || '{}')
            userStars[model.id] = apiIsStarred
            localStorage.setItem('user_model_stars', JSON.stringify(userStars))
          } catch (error) {
            console.warn('Failed to save star status to localStorage:', error)
          }
        }
      } catch (error) {
        console.warn('Failed to fetch star status from API:', error)
      }
    }

    initializeStarStatus()
  }, [model.id, model.stats.stars])

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      setIsDownloading(true)

      const filename = `${model.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.zip`
      await downloadCommunityModel(model.id, filename)
      
      try {
        const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/models/${model.id}`, {
          method: 'GET',
        });
        
        if (result && result.model?.stats?.downloads !== undefined) {
          const newDownloadCount = result.model.stats.downloads;
          setDownloadCount(newDownloadCount);
        }
      } catch (error) {
        console.warn('Failed to fetch updated download count:', error);
      }

      toast.success('Model downloaded', { description: `${model.title} → ${filename}` } as any)
    } catch (error) {
      console.error('Download error:', error)
      toast.error(getErrorMessage(error, 'Download failed'))
    } finally {
      setIsDownloading(false)
    }
  }
  
  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm(`Are you sure you want to delete "${model.title}"?`)) {
      try {
        // Always try to delete from backend (for both Firebase and localStorage)
        try {
          const deleteUrl = `${CTRL_SERVICE_API_ENDPOINT}/community/v1/models/${model.id}`
          const deleteResponse = await apiFetch(deleteUrl, {
            method: 'DELETE'
          })

          if (deleteResponse?.success) {
            console.log('Model deleted from backend and Firebase successfully')
          } else {
            console.warn('Backend deletion returned success=false')
            throw new Error('Backend deletion failed')
          }
        } catch (error) {
          console.error('Backend delete error:', error)
          toast.error(getErrorMessage(error, 'Failed to delete from server'))
          return // Don't proceed if backend deletion failed
        }

        // Remove from localStorage
        const savedModels = JSON.parse(localStorage.getItem('userUploadedModels') || '[]')
        const updatedModels = savedModels.filter((m: any) => m.id !== model.id)
        localStorage.setItem('userUploadedModels', JSON.stringify(updatedModels))
        
        // Trigger localStorage change event for other pages/tabs
        window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedModels' } }))
        
        toast.success('Model deleted successfully')
        
        // Reload the page to refresh data
        window.location.reload()
      } catch (error) {
        console.error('Error in handleDelete:', error)
        toast.error(getErrorMessage(error, 'Error occurred while deleting model'))
      }
    }
  }

  const handleStarToggle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isStarring) return

    try {
      setIsStarring(true)
      const newIsStarred = !isStarred
      const newStarCount = newIsStarred ? starCount + 1 : starCount - 1

      setIsStarred(newIsStarred)
      setStarCount(newStarCount)

      const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/models/${model.id}/star`, {
        method: newIsStarred ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      })

      if (result.starCount !== undefined) {
        setStarCount(result.starCount)

        try {
          const savedModels = JSON.parse(localStorage.getItem('userUploadedModels') || '[]')
          const updatedModels = savedModels.map((m: any) =>
            m.id === model.id
              ? { ...m, stats: { ...m.stats, stars: result.starCount } }
              : m
          )
          localStorage.setItem('userUploadedModels', JSON.stringify(updatedModels))
          window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedModels' } }))
        } catch (error) {
          console.warn('Failed to sync star count to localStorage:', error)
        }
      }

      const userStars = JSON.parse(localStorage.getItem('user_model_stars') || '{}')
      userStars[model.id] = newIsStarred
      localStorage.setItem('user_model_stars', JSON.stringify(userStars))
    } catch (error) {
      console.error('Star toggle failed:', error)
      setIsStarred(isStarred)
      setStarCount(starCount)
    } finally {
      setIsStarring(false)
    }
  }
  
  return (
    <Card className="group hover:shadow-lg transition-all duration-200 cursor-pointer">
      <CardHeader className="p-4">
        <CardTitle className="text-lg font-semibold line-clamp-2">
          {model.title}
        </CardTitle>
        <p className="text-sm text-gray-600 line-clamp-2">
          {model.description}
        </p>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="flex items-center justify-between text-xs text-gray-500 mb-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span>Size:</span>
              <span>{model.stats.size}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-gray-500 mb-3">
          <div className="flex items-center gap-3">
            <button
              onClick={handleStarToggle}
              disabled={isStarring}
              className="flex items-center gap-1 hover:bg-yellow-50 rounded-md p-1 -ml-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={isStarred ? 'Remove star' : 'Add star'}
            >
              <Star
                className={`w-3 h-3 transition-colors ${
                  isStarred
                    ? 'text-yellow-400 fill-yellow-400'
                    : 'text-gray-400 hover:text-yellow-400'
                } ${isStarring ? 'animate-pulse' : ''}`}
              />
              <span>{starCount}</span>
            </button>
            <div className="flex items-center gap-1">
              <Download className="w-3 h-3" />
              <span>{downloadCount}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            <span>{new Date(model.stats.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>
        
        <div className="flex flex-wrap gap-1 mb-3">
          {model.tags.slice(0, showAllTags ? model.tags.length : 2).map((tag, index) => (
            <Badge
              key={index}
              className="text-xs px-2 py-1 cursor-pointer hover:opacity-80 transition-opacity bg-gray-100 text-gray-600"
              onClick={onTagClick ? () => onTagClick(tag) : undefined}
            >
              {tag}
            </Badge>
          ))}
          {model.tags.length > 2 && (
            <Badge
              variant="outline"
              className="text-xs cursor-pointer hover:bg-gray-100 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                setShowAllTags(!showAllTags);
              }}
            >
              {showAllTags ? 'Show Less' : `+${model.tags.length - 2}`}
            </Badge>
          )}
        </div>
        
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleDownload}
            disabled={isDownloading}
            className="flex-1"
          >
            {isDownloading ? (
              <>
                <InlineSpinner size={12} color="#6352a3" className="mr-1" />
                Downloading...
              </>
            ) : (
              <>
                <Download className="w-3 h-3 mr-1" />
                Download
              </>
            )}
          </Button>
          {isCurrentUser && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleDelete}
              className="border-red-200 text-red-600 hover:bg-red-50"
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
})

const UserClassifierCard = React.memo(function UserClassifierCard({ classifier, isCurrentUser, onTagClick, userProfile }: { classifier: UserClassifier, isCurrentUser: boolean, onTagClick?: (tag: string) => void, userProfile?: UserProfile }) {
  const [isDownloading, setIsDownloading] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  const [isStarred, setIsStarred] = useState(false)
  const [starCount, setStarCount] = useState(classifier.stats.stars || 0)
  const [downloadCount, setDownloadCount] = useState(classifier.stats.downloads || 0)
  const [isStarring, setIsStarring] = useState(false)
  const [showClassifierDetail, setShowClassifierDetail] = useState(false)

  // Initialize star status
  useEffect(() => {
    const initializeStarStatus = async () => {
      // First, load from localStorage for immediate display
      try {
        const userStars = JSON.parse(localStorage.getItem('user_stars') || '{}')
        if (userStars[classifier.id] !== undefined) {
          setIsStarred(userStars[classifier.id])
        }
      } catch (error) {
        console.warn('Failed to load star status from localStorage:', error)
      }

      // Then try to get fresh data from API
      try {
        const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${classifier.id}`, {
          method: 'GET'
        })

        if (result) {
          const apiIsStarred = result.is_starred || false
          const apiStarCount = result.classifier?.stats?.stars || classifier.stats.stars || 0

          setIsStarred(apiIsStarred)
          setStarCount(apiStarCount)

          // Update localStorage with fresh API data
          try {
            const userStars = JSON.parse(localStorage.getItem('user_stars') || '{}')
            userStars[classifier.id] = apiIsStarred
            localStorage.setItem('user_stars', JSON.stringify(userStars))
          } catch (error) {
            console.warn('Failed to save star status to localStorage:', error)
          }
        }
      } catch (error) {
        console.warn('Failed to fetch star status from API:', error)
        // If API fails, keep the localStorage value or the current state
      }
    }

    initializeStarStatus()
  }, [classifier.id, classifier.stats.stars])

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      setIsDownloading(true)

      const filename = `${classifier.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.tlcls`
      await downloadCommunityClassifier(classifier.id, filename)
      
      // Fetch updated download count from backend after successful download
      try {
        const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${classifier.id}`, {
          method: 'GET',
        });
        
        if (result && result.classifier?.stats?.downloads !== undefined) {
          const newDownloadCount = result.classifier.stats.downloads;
          setDownloadCount(newDownloadCount);
        }
      } catch (error) {
        console.warn('Failed to fetch updated download count:', error);
        // Still show success message even if count update fails
      }

      toast.success('Classifier downloaded', { description: `${classifier.title} → ${filename}` } as any)
    } catch (error) {
      console.error('Download error:', error)
      toast.error(getErrorMessage(error, 'Download failed'))
    } finally {
      setIsDownloading(false)
    }
  }
  
  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm(`Are you sure you want to delete "${classifier.title}"?`)) {

      try {
        // Call backend to delete classifier and associated files

        if (classifier.id.startsWith('uploaded-')) {
          try {
            const deleteUrl = `${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${classifier.id}`

            const deleteResponse = await apiFetch(deleteUrl, {
              method: 'DELETE'
            })


            if (deleteResponse.success) {
            } else {
              console.warn('Backend deletion returned success=false')
              toast.warning('Deletion completed but may not have succeeded')
            }
          } catch (error) {
            console.error('Backend delete error:', error)
            toast.warning(getErrorMessage(error, 'Backend deletion failed'))
          }
        } else {
        }

        // Remove from localStorage
        const savedClassifiers = JSON.parse(localStorage.getItem('userUploadedClassifiers') || '[]')
        const updatedClassifiers = savedClassifiers.filter((c: any) => c.id !== classifier.id)
        localStorage.setItem('userUploadedClassifiers', JSON.stringify(updatedClassifiers))
        window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedClassifiers' } }))
        toast.success('Classifier deleted successfully')
        // Force a hard refresh to reload the profile page
        window.location.reload()
      } catch (error) {
        console.error('Error in handleDelete:', error)
        toast.error(getErrorMessage(error, 'Error occurred while deleting classifier'))
      }
    }
  }
  

  const handleStarToggle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isStarring) return

    try {
      setIsStarring(true)
      const newIsStarred = !isStarred
      const newStarCount = newIsStarred ? starCount + 1 : starCount - 1

      // optimistic update
      setIsStarred(newIsStarred)
      setStarCount(newStarCount)

      const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${classifier.id}/star`, {
        method: newIsStarred ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      })

      // update actual count
      if (result.starCount !== undefined) {
        setStarCount(result.starCount)

        // update userUploadedClassifiers in localStorage
        try {
          const savedClassifiers = JSON.parse(localStorage.getItem('userUploadedClassifiers') || '[]')
          const updatedClassifiers = savedClassifiers.map((c: any) =>
            c.id === classifier.id
              ? { ...c, stats: { ...c.stats, stars: result.starCount } }
              : c
          )
          localStorage.setItem('userUploadedClassifiers', JSON.stringify(updatedClassifiers))
          window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedClassifiers' } }))
        } catch (error) {
          console.warn('Failed to sync star count to localStorage:', error)
        }
      }

      // Update localStorage for star status persistence
      const userStars = JSON.parse(localStorage.getItem('user_stars') || '{}')
      userStars[classifier.id] = newIsStarred
      localStorage.setItem('user_stars', JSON.stringify(userStars))
    } catch (error) {
      console.error('Star toggle failed:', error)
      // roll back state
      setIsStarred(isStarred)
      setStarCount(starCount)
    } finally {
      setIsStarring(false)
    }
  }
  
  return (
    <Card className="group hover:shadow-lg transition-all duration-200 cursor-pointer">
      <CardHeader className="p-4">
        <CardTitle
          className="text-lg font-semibold line-clamp-2 group-hover:text-blue-600 transition-colors cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            setShowClassifierDetail(true);
          }}
        >
          {classifier.title}
        </CardTitle>
        <p className="text-sm text-muted-foreground line-clamp-2">
          {classifier.description}
        </p>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="flex items-center justify-between text-xs text-muted-foreground mb-3">
          <div className="flex items-center gap-3">
            {classifier.stats.classes && (
              <div className="flex items-center gap-1">
                <span>Classes:</span>
                <span>{classifier.stats.classes}</span>
              </div>
            )}
            <div className="flex items-center gap-1">
              <span>Size:</span>
              <span>{classifier.stats.size}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground mb-3">
          <div className="flex items-center gap-3">
            <button
              onClick={handleStarToggle}
              disabled={isStarring}
              className="flex items-center gap-1 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 rounded-md p-1 -ml-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={isStarred ? 'Remove star' : 'Add star'}
            >
              <Star
                className={`w-3 h-3 transition-colors ${
                  isStarred
                    ? 'text-yellow-400 fill-yellow-400'
                    : 'text-muted-foreground hover:text-yellow-400'
                } ${isStarring ? 'animate-pulse' : ''}`}
              />
              <span>{starCount}</span>
            </button>
            <div className="flex items-center gap-1">
              <Download className="w-3 h-3" />
              <span>{downloadCount}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            <span>{new Date(classifier.stats.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>
        
        <div className="flex flex-wrap gap-1 mb-3">
          {(() => {
            // Factory categories for tag processing
            const factoryCategories = [
              { id: 'tissue_segmentation', name: 'Tissue Segmentation' },
              { id: 'cell_segmentation', name: 'Cell Segmentation + Embedding' },
              { id: 'nuclei_classification', name: 'Nuclei Classification' },
              { id: 'code_calculation', name: 'Coding Agent' },
              { id: 'tissue_classification', name: 'Tissue Classification' }
            ];

            const modalityTags = ['pathology', 'radiology', 'spatial transcriptomics'];

            // Get factory and node info from classifier
            const factoryId = (classifier as any).factory;
            const nodeId = (classifier as any).node;

            // Find factory category display name
            const factoryCategory = factoryCategories.find(f => f.id === factoryId);
            const factoryDisplayName = factoryCategory?.name || factoryId;

            // Create display tags array - factory first, then node if exists
            const displayTags: Array<{text: string, isFactory: boolean, originalTag: string}> = [];

            // Add factory tag (main class)
            if (factoryDisplayName && factoryDisplayName !== 'undefined') {
              displayTags.push({
                text: factoryDisplayName,
                isFactory: true,
                originalTag: factoryDisplayName
              });
            }

            // Add node tag if exists (sub class)
            if (nodeId && nodeId !== 'undefined' && nodeId !== '' && !factoryDisplayName?.toLowerCase().includes(nodeId.toLowerCase())) {
              displayTags.push({
                text: nodeId,
                isFactory: false,
                originalTag: nodeId
              });
            }

            // Add modality tags (if any)
            classifier.tags.forEach(t => {
              if (modalityTags.includes(t.toLowerCase())) {
                displayTags.push({
                  text: t,
                  isFactory: false,
                  originalTag: t
                });
              }
            });

            const tagsToShow = showAllTags ? displayTags : displayTags.slice(0, 2);

            return tagsToShow.map((displayTag, displayIndex) => {
              const tagColor = getTagColor(displayTag.text, displayTag.isFactory, factoryDisplayName || '');

              return (
                <ColorTag
                  key={`classifier-${displayIndex}`}
                  color={tagColor}
                  onClick={onTagClick ? () => onTagClick(displayTag.text) : undefined}
                >
                  {displayTag.text}
                </ColorTag>
              );
            });
          })()}
          {(() => {
            // Calculate total display tags to show the "+N" badge correctly
            const factoryId = (classifier as any).factory;
            const nodeId = (classifier as any).node;
            const modalityTags = ['pathology', 'radiology', 'spatial transcriptomics'];

            let totalTags = 0;
            if (factoryId && factoryId !== 'undefined') totalTags++;
            if (nodeId && nodeId !== 'undefined' && nodeId !== '') totalTags++;
            totalTags += classifier.tags.filter(t => modalityTags.includes(t.toLowerCase())).length;

            return totalTags > 2 && !showAllTags ? (
              <ColorTag
                color="default"
                className="text-xs cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAllTags(true);
                }}
              >
                +{totalTags - 2}
              </ColorTag>
            ) : showAllTags && totalTags > 2 ? (
              <ColorTag
                color="default"
                className="text-xs cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAllTags(false);
                }}
              >
                Show Less
              </ColorTag>
            ) : null;
          })()}
        </div>
        
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleDownload}
            disabled={isDownloading}
            className="flex-1"
          >
            {isDownloading ? (
              <>
                <InlineSpinner size={12} color="#6352a3" className="mr-1" />
                Downloading...
              </>
            ) : (
              <>
                <Download className="w-3 h-3 mr-1" />
                Download
              </>
            )}
          </Button>
          {isCurrentUser && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleDelete}
              className="text-red-600 hover:text-red-700 hover:border-red-300 flex-shrink-0"
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          )}
        </div>
      </CardContent>

      {/* Classifier Detail Dialog */}
      <Dialog open={showClassifierDetail} onOpenChange={setShowClassifierDetail}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-purple-600 dark:text-purple-400">
              {classifier.title}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Classifier details and description
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <h3 className="text-base font-semibold text-foreground mb-2">About Classifier</h3>
              <div className="text-sm text-muted-foreground leading-relaxed break-words overflow-wrap-anywhere">
                {classifier.description}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 pt-4 border-t border-border">
              <div className="text-sm text-muted-foreground">
                <span className="font-medium">Classes:</span> {classifier.stats.classes ?? 'null'}
              </div>
              <div className="text-sm text-muted-foreground">
                <span className="font-medium">Size:</span> {classifier.stats.size}
              </div>
              <div className="text-sm text-muted-foreground">
                <span className="font-medium">Author:</span> {userProfile?.displayName || 'Unknown'}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
})

function StatCard({ icon: Icon, label, value, onClick, loading }: {
  icon: React.ElementType,
  label: string,
  value: string | number,
  onClick?: () => void,
  loading?: boolean
}) {
  return (
    <div
      className={`text-center p-3 ${onClick ? 'cursor-pointer hover:bg-accent rounded-lg transition-colors' : ''}`}
      onClick={onClick}
    >
      <Icon className="w-6 h-6 mx-auto mb-2 text-blue-600" />
      {loading ? (
        <div className="text-2xl font-bold text-foreground">
          <div className="w-8 h-8 bg-muted rounded animate-pulse mx-auto"></div>
        </div>
      ) : (
        <div className="text-2xl font-bold text-foreground">{value}</div>
      )}
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  )
}

export default function UserProfile() {
  const router = useRouter()
  const { username } = router.query
  const { userInfo } = useUserInfo()
  const globalAvatarUrl = useSelector((state: RootState) => state.user.avatarUrl)
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [classifiers, setClassifiers] = useState<UserClassifier[]>([])
  const [models, setModels] = useState<UserModel[]>([])
  const [activeTab, setActiveTab] = useState('classifiers')

  // Handle tab changes to load data
  const handleTabChange = (newTab: string) => {
    setActiveTab(newTab)
    if (newTab === 'followers' && followers.length === 0 && !loadingFollowers) {
      loadFollowers()
    } else if (newTab === 'following' && following.length === 0 && !loadingFollowing) {
      loadFollowing()
    }
  }
  const [isCurrentUser, setIsCurrentUser] = useState(false)
  const [isFollowing, setIsFollowing] = useState(false)
  const [isFollowingLoading, setIsFollowingLoading] = useState(false)
  const [showEmail, setShowEmail] = useState(true)
  const [followers, setFollowers] = useState<any[]>([])
  const [following, setFollowing] = useState<any[]>([])
  const [loadingFollowers, setLoadingFollowers] = useState(false)
  const [loadingFollowing, setLoadingFollowing] = useState(false)
  const [loadingFollowStats, setLoadingFollowStats] = useState(true)

  // Search, filter, and sort states for classifiers
  const [classifierSearch, setClassifierSearch] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [classifierSort, setClassifierSort] = useState<'most_likes' | 'most_downloads' | 'recently_upload'>('most_likes')

  // Search, filter, and sort states for models
  const [modelSearch, setModelSearch] = useState('')
  const [selectedModelTags, setSelectedModelTags] = useState<string[]>([])
  const [modelSort, setModelSort] = useState<'most_likes' | 'most_downloads' | 'recently_upload'>('most_likes')

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1)
  const [modelCurrentPage, setModelCurrentPage] = useState(1)
  const [itemsPerPage] = useState(8) // Show 8 per page

  // Tag handling functions
  const handleTagClick = useCallback((tag: string) => {
    setSelectedTags(prev =>
      prev.includes(tag)
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    )
    setCurrentPage(1) // Reset to first page when tags change
  }, [])

  // Tag handling function for models
  const handleModelTagClick = useCallback((tag: string) => {
    setSelectedModelTags(prev =>
      prev.includes(tag)
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    )
    setModelCurrentPage(1) // Reset to first page when tags change
  }, [])

  // Get filtered and sorted classifiers
  const getFilteredAndSortedClassifiers = useCallback(() => {
    let filtered = [...classifiers]

    // Apply search filter
    if (classifierSearch.trim()) {
      const searchTerm = classifierSearch.toLowerCase()
      filtered = filtered.filter(classifier =>
        classifier.title.toLowerCase().includes(searchTerm) ||
        classifier.description.toLowerCase().includes(searchTerm) ||
        classifier.tags.some(tag => tag.toLowerCase().includes(searchTerm))
      )
    }

    // Apply tag filters - match against factory, node, and tags
    if (selectedTags.length > 0) {
      filtered = filtered.filter(classifier => {
        const factoryCategories = [
          { id: 'tissue_segmentation', name: 'Tissue Segmentation' },
          { id: 'cell_segmentation', name: 'Cell Segmentation + Embedding' },
          { id: 'nuclei_classification', name: 'Nuclei Classification' },
          { id: 'code_calculation', name: 'Coding Agent' },
          { id: 'tissue_classification', name: 'Tissue Classification' }
        ]

        const factoryCategory = factoryCategories.find(f => f.id === (classifier as any).factory)
        const factoryDisplayName = factoryCategory?.name || (classifier as any).factory
        const nodeId = (classifier as any).node

        return selectedTags.every(selectedTag => {
          // Check if the selected tag matches factory name
          if (factoryDisplayName && factoryDisplayName.toLowerCase() === selectedTag.toLowerCase()) {
            return true
          }

          // Check if the selected tag matches node name
          if (nodeId && nodeId.toLowerCase() === selectedTag.toLowerCase()) {
            return true
          }

          // Check if the selected tag matches any of the classifier's tags
          if (classifier.tags.some(tag => tag.toLowerCase() === selectedTag.toLowerCase())) {
            return true
          }

          return false
        })
      })
    }

    // Apply sorting
    filtered.sort((a, b) => {
      switch (classifierSort) {
        case 'most_likes':
          return (b.stats.stars || 0) - (a.stats.stars || 0)
        case 'most_downloads':
          return (b.stats.downloads || 0) - (a.stats.downloads || 0)
        case 'recently_upload':
          return new Date(b.stats.updatedAt).getTime() - new Date(a.stats.updatedAt).getTime()
        default:
          return 0
      }
    })

    return filtered
  }, [classifiers, classifierSearch, selectedTags, classifierSort])

  // Get paginated classifiers
  const getPaginatedClassifiers = () => {
    const filtered = getFilteredAndSortedClassifiers()
    const startIndex = (currentPage - 1) * itemsPerPage
    const endIndex = startIndex + itemsPerPage
    return filtered.slice(startIndex, endIndex)
  }

  // Calculate total pages
  const getTotalPages = () => {
    const filtered = getFilteredAndSortedClassifiers()
    return Math.ceil(filtered.length / itemsPerPage)
  }

  // Get filtered and sorted models
  const getFilteredAndSortedModels = useCallback(() => {
    let filtered = [...models]

    // Apply search filter
    if (modelSearch.trim()) {
      const searchTerm = modelSearch.toLowerCase()
      filtered = filtered.filter(model =>
        model.title.toLowerCase().includes(searchTerm) ||
        model.description.toLowerCase().includes(searchTerm) ||
        model.tags.some(tag => tag.toLowerCase().includes(searchTerm))
      )
    }

    // Apply tag filters
    if (selectedModelTags.length > 0) {
      filtered = filtered.filter(model => {
        const factoryCategories = [
          { id: 'tissue_segmentation', name: 'Tissue Segmentation' },
          { id: 'cell_segmentation', name: 'Cell Segmentation + Embedding' },
          { id: 'nuclei_classification', name: 'Nuclei Classification' },
          { id: 'code_calculation', name: 'Coding Agent' },
          { id: 'tissue_classification', name: 'Tissue Classification' }
        ]

        const factoryCategory = factoryCategories.find(f => f.id === (model as any).factory)
        const factoryDisplayName = factoryCategory?.name || (model as any).factory
        const nodeId = (model as any).node

        return selectedModelTags.every(selectedTag => {
          if (factoryDisplayName && factoryDisplayName.toLowerCase() === selectedTag.toLowerCase()) {
            return true
          }
          if (nodeId && nodeId.toLowerCase() === selectedTag.toLowerCase()) {
            return true
          }
          if (model.tags.some(tag => tag.toLowerCase() === selectedTag.toLowerCase())) {
            return true
          }
          return false
        })
      })
    }

    // Apply sorting
    filtered.sort((a, b) => {
      switch (modelSort) {
        case 'most_likes':
          return (b.stats.stars || 0) - (a.stats.stars || 0)
        case 'most_downloads':
          return (b.stats.downloads || 0) - (a.stats.downloads || 0)
        case 'recently_upload':
          return new Date(b.stats.updatedAt).getTime() - new Date(a.stats.updatedAt).getTime()
        default:
          return 0
      }
    })

    return filtered
  }, [models, modelSearch, selectedModelTags, modelSort])

  // Get paginated models
  const getPaginatedModels = () => {
    const filtered = getFilteredAndSortedModels()
    const startIndex = (modelCurrentPage - 1) * itemsPerPage
    const endIndex = startIndex + itemsPerPage
    return filtered.slice(startIndex, endIndex)
  }

  // Calculate total model pages
  const getModelTotalPages = () => {
    const filtered = getFilteredAndSortedModels()
    return Math.ceil(filtered.length / itemsPerPage)
  }

  // Function to enhance user data with localStorage info
  const enhanceUserWithLocalStorage = useCallback((user: any) => {
    if (typeof window === 'undefined') return user

    const localPreferredName = localStorage.getItem(`preferred_name_${user.user_id}`)
    const localAvatar = localStorage.getItem(`user_avatar_${user.user_id}`)

    return {
      ...user,
      preferred_name: localPreferredName || user.preferred_name,
      avatar_url: localAvatar || user.avatar_url
    }
  }, [])

  // Function to refresh follower/following lists with updated localStorage data
  const refreshFollowLists = useCallback(() => {
    if (followers.length > 0) {
      const refreshedFollowers = followers.map(enhanceUserWithLocalStorage)
      setFollowers(refreshedFollowers)
    }
    if (following.length > 0) {
      const refreshedFollowing = following.map(enhanceUserWithLocalStorage)
      setFollowing(refreshedFollowing)
    }
  }, [followers, following, enhanceUserWithLocalStorage])

  // Handle follow/unfollow
  const handleFollowToggle = async () => {
    if (isFollowingLoading || !userProfile) return

    try {
      setIsFollowingLoading(true)
      const newFollowState = !isFollowing

      // Optimistic update
      setIsFollowing(newFollowState)
      const followersCountUpdate = newFollowState ? 1 : -1
      const followingCountUpdate = newFollowState ? 1 : -1

      setUserProfile(prev => prev ? {
        ...prev,
        stats: {
          ...prev.stats,
          followers: prev.stats.followers + followersCountUpdate,
          // If viewing current user's own profile, also update following count
          following: (userInfo && userInfo.user_id === userProfile.username) ? prev.stats.following + followingCountUpdate : prev.stats.following
        }
      } : null)

      // API call to follow/unfollow
      const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/users/v1/${newFollowState ? 'follow' : 'unfollow'}`, {
        method: 'POST',
        body: JSON.stringify({ target_user_id: userProfile.username }),
        headers: { 'Content-Type': 'application/json' }
      })

      // Update followers count from API response if available
      if (result.followers_count !== undefined || result.following_count !== undefined) {
        const newFollowersCount = result.followers_count ?? userProfile.stats.followers
        const newFollowingCount = (userInfo && userInfo.user_id === userProfile.username) && result.following_count !== undefined
          ? result.following_count
          : userProfile.stats.following

        setUserProfile(prev => prev ? {
          ...prev,
          stats: {
            ...prev.stats,
            followers: newFollowersCount,
            following: newFollowingCount
          }
        } : null)

        // Cache updated stats (preserve existing classifier stats)
        if (typeof window !== 'undefined') {
          const existingStats = JSON.parse(localStorage.getItem(`user_stats_${userProfile.username}`) || '{}')
          const statsToCache = {
            ...existingStats,
            followers: newFollowersCount,
            following: newFollowingCount,
            lastUpdated: Date.now()
          }
          localStorage.setItem(`user_stats_${userProfile.username}`, JSON.stringify(statsToCache))
        }
      }

      // Update localStorage for persistence
      const followData = JSON.parse(localStorage.getItem('user_follows') || '{}')
      if (newFollowState) {
        followData[userProfile.username] = true
      } else {
        delete followData[userProfile.username]
      }
      localStorage.setItem('user_follows', JSON.stringify(followData))

      // Update followers/following lists in real-time
      if (userInfo) {
        if (newFollowState) {
          // User just followed this profile
          if (activeTab === 'followers') {
            // Add current user to followers list
            const currentUserData = {
              user_id: userInfo.user_id,
              preferred_name: localStorage.getItem(`preferred_name_${userInfo.user_id}`) || `User ${userInfo.user_id.substring(0, 8)}`,
              avatar_url: localStorage.getItem(`user_avatar_${userInfo.user_id}`) || null
            }
            setFollowers(prev => [currentUserData, ...prev])
          } else if (activeTab === 'following' && userInfo.user_id === userProfile.username) {
            // If user is viewing their own profile's following tab, add the followed user
            const followedUserData = {
              user_id: userProfile.username,
              preferred_name: userProfile.displayName,
              avatar_url: userProfile.avatar !== '/avatars/default.jpg' ? userProfile.avatar : null
            }
            setFollowing(prev => [followedUserData, ...prev])
          }
        } else {
          // User just unfollowed this profile
          if (activeTab === 'followers') {
            // Remove current user from followers list
            setFollowers(prev => prev.filter(f => f.user_id !== userInfo.user_id))
          } else if (activeTab === 'following' && userInfo.user_id === userProfile.username) {
            // If user is viewing their own profile's following tab, remove the unfollowed user
            setFollowing(prev => prev.filter(f => f.user_id !== userProfile.username))
          }
        }
      }

    } catch (error) {
      console.error('Follow toggle failed:', error)

      // Revert optimistic updates
      setIsFollowing(isFollowing)
      const followersCountRevert = isFollowing ? 1 : -1
      const followingCountRevert = isFollowing ? 1 : -1
      setUserProfile(prev => prev ? {
        ...prev,
        stats: {
          ...prev.stats,
          followers: prev.stats.followers + followersCountRevert,
          following: (userInfo && userInfo.user_id === userProfile.username) ? prev.stats.following + followingCountRevert : prev.stats.following
        }
      } : null)
    } finally {
      setIsFollowingLoading(false)
    }
  }

  // Load followers data
  const loadFollowers = useCallback(async () => {
    if (!userProfile || loadingFollowers) return

    try {
      setLoadingFollowers(true)
      const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/users/v1/followers`, {
        method: 'POST',
        body: JSON.stringify({ target_user_id: userProfile.username }),
        headers: { 'Content-Type': 'application/json' }
      })

      // Enhance followers data with localStorage info
      const enhancedFollowers = (result.followers || []).map(enhanceUserWithLocalStorage)
      setFollowers(enhancedFollowers)
    } catch (error) {
      console.error('Failed to load followers:', error)
    } finally {
      setLoadingFollowers(false)
    }
  }, [userProfile, loadingFollowers, enhanceUserWithLocalStorage])

  // Load following data
  const loadFollowing = useCallback(async () => {
    if (!userProfile || loadingFollowing) return

    try {
      setLoadingFollowing(true)
      const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/users/v1/following`, {
        method: 'POST',
        body: JSON.stringify({ target_user_id: userProfile.username }),
        headers: { 'Content-Type': 'application/json' }
      })

      // Enhance following data with localStorage info
      const enhancedFollowing = (result.following || []).map(enhanceUserWithLocalStorage)
      setFollowing(enhancedFollowing)
    } catch (error) {
      console.error('Failed to load following:', error)
    } finally {
      setLoadingFollowing(false)
    }
  }, [userProfile, loadingFollowing, enhanceUserWithLocalStorage])

  // Handle share profile
  const handleShare = async () => {
    try {
      const profileUrl = `${window.location.origin}/profile/${username}`

      if (navigator.share) {
        await navigator.share({
          title: `${userProfile?.displayName}'s Profile - TissueLab`,
          text: `Check out ${userProfile?.displayName}'s profile on TissueLab`,
          url: profileUrl
        })
        toast.success('Profile link shared')
      } else {
        // Fallback to clipboard
        await navigator.clipboard.writeText(profileUrl)
        toast.success('Profile URL copied to clipboard')
      }
    } catch (error) {
      console.error('Share failed:', error)
      toast.error('Failed to share profile link')
    }
  }

  useEffect(() => {
    const fetchUserProfile = async () => {
      if (username) {
        try {
          let profileData: UserProfile | null = null

          // Try to fetch real user data from API
          try {
            const apiProfile = await usersService.getCurrentUser()

            if (apiProfile) {
              // Check if the current user matches the profile being viewed
              if (apiProfile.user_id === (username as string)) {
                // Convert API profile to local UserProfile format
                profileData = convertAPIProfileToUserProfile(apiProfile, username as string)
                setIsCurrentUser(true)
              }
            }
          } catch (apiError) {
          }

          // If viewing other user's profile or API current-user call failed, fetch public profile
          if (!profileData) {
            try {
              const publicProfile = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/users/v1/public_profile/${username}`, { method: 'GET' })
              if (publicProfile && publicProfile.found) {
                const displayName = publicProfile.preferred_name || `User ${(username as string).substring(0, 8)}`
                const joinDate = publicProfile.registered_at ? new Date(publicProfile.registered_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
                profileData = {
                  username: username as string,
                  displayName,
                  avatar: publicProfile.avatar_url || '/avatars/default.jpg',
                  joinDate: joinDate,
                  lastActive: new Date().toISOString().split('T')[0],
                  organization: publicProfile.organization && String(publicProfile.organization).trim() !== '' ? publicProfile.organization : undefined,
                  email: publicProfile.email || undefined,
                  bio: publicProfile.custom_title || `Community Member ${displayName}. This User Has Uploaded Classifiers To Share With The TissueLab Community.`,
                  stats: {
                    totalClassifiers: 0,
                    totalModels: 0,
                    totalStars: 0,
                    totalDownloads: 0,
                    followers: 0,
                    following: 0
                  }
                }
              }
            } catch (e) {
              // ignore and fallback to localStorage
            }
          }

          // If API/public fetch failed, create basic profile from localStorage data
          if (!profileData) {
            const preferredName = typeof window !== 'undefined'
              ? localStorage.getItem(`preferred_name_${username}`)
              : null;

            const userAvatar = typeof window !== 'undefined'
              ? localStorage.getItem(`user_avatar_${username}`)
              : null;

            const cachedStats = typeof window !== 'undefined'
              ? JSON.parse(localStorage.getItem(`user_stats_${username}`) || '{}')
              : {};

            const displayName = preferredName || `User ${(username as string).substring(0, 8)}`;

            profileData = {
              username: username as string,
              displayName: displayName,
              avatar: userAvatar || '/avatars/default.jpg',
              joinDate: new Date().toISOString().split('T')[0],
              lastActive: new Date().toISOString().split('T')[0],
              bio: `Community member ${preferredName || (username as string).substring(0, 8)}. This user has uploaded classifiers to share with the TissueLab community.`,
              stats: {
                totalClassifiers: cachedStats.totalClassifiers ?? 0,
                totalModels: cachedStats.totalModels ?? 0,
                totalStars: cachedStats.totalStars ?? 0,
                totalDownloads: cachedStats.totalDownloads ?? 0,
                followers: cachedStats.followers ?? 0,
                following: cachedStats.following ?? 0
              }
            }
          }
          
          if (!profileData) {
            // User not found, redirect to community
            console.warn(`User ${username} not found`)
            router.push('/community')
            return
          }
          
          setUserProfile(profileData)


          // Fetch user's classifiers from API
          const apiClassifiers = await fetchUserClassifiersFromAPI(username as string)

          // Get user's uploaded classifiers from localStorage
          const localStorageClassifiers: UserClassifier[] = []
          if (typeof window !== 'undefined') {
            try {
              const uploadedClassifiers = JSON.parse(localStorage.getItem('userUploadedClassifiers') || '[]')
              const userLocalClassifiers = uploadedClassifiers
                .filter((c: any) => c.author.user_id === username)
                .map((c: any) => ({
                  id: c.id,
                  title: c.title,
                  description: c.description,
                  stats: {
                    classes: c.stats?.classes || null,
                    size: c.stats?.size || 'Unknown',
                    stars: c.stats?.stars || 0,
                    downloads: c.stats?.downloads || 0,
                    updatedAt: c.stats?.updatedAt || new Date().toISOString().split('T')[0]
                  },
                  tags: c.tags || [],
                  thumbnail: c.thumbnail || '/thumbnails/default.jpg',
                  factory: c.factory,
                  model: c.model,
                  node: c.node
                }))
              localStorageClassifiers.push(...userLocalClassifiers)
            } catch (error) {
              console.warn('Failed to parse userUploadedClassifiers:', error)
            }
          }

          // Combine all classifiers and remove duplicates (localStorage first, then API, then mock)
          const combinedClassifiers = [...localStorageClassifiers, ...apiClassifiers]
          const uniqueClassifiers = combinedClassifiers.filter((classifier, index, arr) =>
            arr.findIndex(c => c.id === classifier.id) === index
          )
          const allClassifiers = uniqueClassifiers
          setClassifiers(allClassifiers)
          
          // Fetch user's models from API
          const apiModels = await fetchUserModelsFromAPI(username as string)

          // Get user's uploaded models from localStorage
          const localStorageModels: UserModel[] = []
          if (typeof window !== 'undefined') {
            try {
              const uploadedModels = JSON.parse(localStorage.getItem('userUploadedModels') || '[]')
              const userLocalModels = uploadedModels
                .filter((m: any) => m.author?.user_id === username)
                .map((m: any) => ({
                  id: m.id,
                  title: m.title,
                  description: m.description,
                  stats: {
                    size: formatSizeToMB(m.stats?.size),
                    stars: m.stats?.stars || 0,
                    downloads: m.stats?.downloads || 0,
                    updatedAt: m.stats?.updatedAt || new Date().toISOString()
                  },
                  tags: m.tags || [],
                  thumbnail: m.thumbnail || '/thumbnails/default.jpg',
                  factory: m.factory,
                  model: m.model,
                  node: m.node
                }))
              localStorageModels.push(...userLocalModels)
            } catch (error) {
              console.warn('Failed to parse userUploadedModels:', error)
            }
          }

          // Combine all models and remove duplicates
          const combinedModels = [...localStorageModels, ...apiModels]
          const uniqueModels = combinedModels.filter((model, index, arr) =>
            arr.findIndex(m => m.id === model.id) === index
          )
          setModels(uniqueModels)
          
          // Calculate classifier and model stats
          let updatedProfileData = profileData
          if (profileData && (allClassifiers.length > 0 || uniqueModels.length > 0)) {
            updatedProfileData = {
              ...profileData,
              stats: {
                ...profileData.stats,
                totalClassifiers: allClassifiers.length,
                totalModels: uniqueModels.length,
                totalStars: allClassifiers.reduce((sum, c) => sum + (c.stats.stars || 0), 0) + uniqueModels.reduce((sum, m) => sum + (m.stats.stars || 0), 0),
                totalDownloads: allClassifiers.reduce((sum, c) => sum + (c.stats.downloads || 0), 0) + uniqueModels.reduce((sum, m) => sum + (m.stats.downloads || 0), 0)
              }
            }
          }

          // Initialize follow state from API
          try {
            const followStatusResult = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/users/v1/follow_status`, {
              method: 'POST',
              body: JSON.stringify({ target_user_id: username }),
              headers: { 'Content-Type': 'application/json' }
            })

            setIsFollowing(followStatusResult.is_following)

            // Update profile with real follow counts from API if available
            if (updatedProfileData && (followStatusResult.followers_count !== undefined || followStatusResult.following_count !== undefined)) {
              updatedProfileData = {
                ...updatedProfileData,
                stats: {
                  ...updatedProfileData.stats,
                  followers: followStatusResult.followers_count ?? updatedProfileData.stats.followers,
                  following: (userInfo && userInfo.user_id === username)
                    ? (followStatusResult.following_count ?? updatedProfileData.stats.following)
                    : updatedProfileData.stats.following
                }
              }

              // Cache all stats in localStorage to prevent future flicker
              if (typeof window !== 'undefined') {
                const statsToCache = {
                  totalClassifiers: updatedProfileData.stats.totalClassifiers,
                  totalModels: updatedProfileData.stats.totalModels,
                  totalStars: updatedProfileData.stats.totalStars,
                  totalDownloads: updatedProfileData.stats.totalDownloads,
                  followers: updatedProfileData.stats.followers,
                  following: updatedProfileData.stats.following,
                  lastUpdated: Date.now()
                }
                localStorage.setItem(`user_stats_${username}`, JSON.stringify(statsToCache))
              }
            }

            // Update profile with all stats at once (classifiers + follow counts)
            setUserProfile({...updatedProfileData})

            // Mark follow stats as loaded regardless of whether we got them from API
            setLoadingFollowStats(false)
          } catch (error) {
            console.warn('Failed to get follow status from API, using localStorage:', error)
            // Fallback to localStorage
            if (typeof window !== 'undefined') {
              const followData = JSON.parse(localStorage.getItem('user_follows') || '{}')
              setIsFollowing(!!followData[Array.isArray(username) ? username[0] : username])
            }

            // Still update profile with classifier stats even if follow API failed
            setUserProfile({...updatedProfileData})

            // Even on error, mark follow stats as loaded
            setLoadingFollowStats(false)
          }
        } catch (error) {
          console.error('Failed to fetch user profile:', error)
          router.push('/community') // Redirect to community if error occurs
        }
      }
    }
    
    fetchUserProfile()
  }, [username, router, userInfo])

  // If viewing current user's profile, keep avatar in sync with Redux immediately
  useEffect(() => {
    if (!userProfile || !username) return
    if (Array.isArray(username)) return
    // Only normalize for current user's own profile card
    if (userInfo && userInfo.user_id === username) {
      const nextAvatar = globalAvatarUrl || (typeof window !== 'undefined' ? localStorage.getItem(`user_avatar_${username}`) || '' : '')
      const normalized = nextAvatar || '/avatars/default.jpg'
      if (normalized !== userProfile.avatar) {
        setUserProfile(prev => prev ? { ...prev, avatar: normalized } : prev)
      }
    }
  }, [globalAvatarUrl, userInfo, username, userProfile])

  // Listen for localStorage changes to update prefer name and avatar; also react to Redux avatar changes
  useEffect(() => {
    const handleStorageChange = () => {
      if (username && userProfile) {
        const preferredName = localStorage.getItem(`preferred_name_${username}`)
        const userAvatar = localStorage.getItem(`user_avatar_${username}`)

        let needsUpdate = false
        const updates: Partial<UserProfile> = {}

        if (preferredName && preferredName !== userProfile.displayName) {
          updates.displayName = preferredName
          needsUpdate = true
        }

        // Prefer Redux avatar when available; fallback to localStorage value
        const nextAvatar = globalAvatarUrl || userAvatar || ''
        if ((nextAvatar || '') !== (userProfile.avatar || '')) {
          updates.avatar = nextAvatar || '/avatars/default.jpg'
          needsUpdate = true
        }

        if (needsUpdate) {
          setUserProfile(prev => prev ? {
            ...prev,
            ...updates
          } : null)

          // Also refresh follower/following lists to update display names
          // Use refreshFollowLists for efficiency instead of reloading from API
          refreshFollowLists()
        }
      }
    }

    // Listen for storage events (cross-tab changes)
    window.addEventListener('storage', handleStorageChange)

    // Listen for custom events (same-tab changes)
    window.addEventListener('localStorageChanged', handleStorageChange)

    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('localStorageChanged', handleStorageChange)
    }
  }, [username, userProfile, refreshFollowLists, globalAvatarUrl])

  if (!userProfile) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading profile...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-background">
      <div className="container mx-auto px-2 sm:px-4 py-4 sm:py-6 max-w-7xl">
        {/* Back Button */}
        <div className="mb-4 sm:mb-6 sticky top-0 z-10 bg-background pt-2 -mt-2 pb-2">
          <button
            onClick={() => router.push('/community')}
            className="flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            <span>Back</span>
          </button>
        </div>
        {/* Profile Header */}
        <Card className="mb-4 sm:mb-6">
          <CardContent className="p-4 sm:p-6">
            <div className="flex flex-col md:flex-row gap-4 sm:gap-6">
              {/* Left: Avatar and basic info */}
              <div className="flex flex-col items-center md:items-start">
                <Avatar className="w-20 h-20 sm:w-24 sm:h-24 mb-4">
                  {userProfile.avatar && userProfile.avatar !== '/avatars/default.jpg' ? (
                    <Image
                      src={userProfile.avatar}
                      alt={userProfile.displayName}
                      width={96}
                      height={96}
                      className="w-full h-full object-cover rounded-full"
                    />
                  ) : (
                    <div className="w-full h-full bg-gradient-to-br from-green-400 to-blue-500 rounded-full flex items-center justify-center">
                      <User className="w-12 h-12 text-white" />
                    </div>
                  )}
                </Avatar>
                <h1 className="text-xl sm:text-2xl font-bold text-foreground mb-1">
                  {userProfile.displayName}
                </h1>
                <p className="text-sm sm:text-base text-muted-foreground mb-4">@{userProfile.username}</p>
                
                <div className="flex gap-2 mb-4">
                  {/* Follow button temporarily commented out */}
                  {/* <button
                    onClick={handleFollowToggle}
                    disabled={isFollowingLoading}
                    className="px-3 py-1 rounded text-sm flex items-center transition-opacity"
                    style={isFollowing ? {
                      backgroundColor: '#6352a3',
                      borderColor: '#6352a3',
                      color: 'white',
                      border: '1px solid #6352a3',
                      cursor: 'pointer'
                    } : {
                      backgroundColor: 'transparent',
                      borderColor: '#6352a3',
                      color: '#6352a3',
                      border: '1px solid #6352a3',
                      cursor: 'pointer'
                    }}
                  >
                    {isFollowingLoading ? (
                      <div className="w-4 h-4 mr-2 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Heart className={`w-4 h-4 mr-2 ${isFollowing ? 'fill-current' : ''}`} />
                    )}
                    {isFollowing ? 'Following' : 'Follow'}
                  </button> */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleShare}
                  >
                    <Share2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Center: Details */}
              <div className="flex-1">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-muted-foreground mb-6">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4" />
                    <span>Joined {new Date(userProfile.joinDate).toLocaleDateString()}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    <span>Last active {new Date(userProfile.lastActive).toLocaleDateString()}</span>
                  </div>
                  {userProfile.bio !== `Community member with email ${userProfile.email}. This user has uploaded classifiers to share with the TissueLab community.` && (
                    <div className="flex items-center gap-2">
                      <Award className="w-4 h-4" />
                      <span className="capitalize">{userProfile.bio}</span>
                    </div>
                  )}
                  {userProfile.organization && (
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4" />
                      <span className="capitalize">{userProfile.organization}</span>
                    </div>
                  )}
                  {userProfile.location && (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4" />
                      <span>{userProfile.location}</span>
                    </div>
                  )}
                  {userProfile.website && (
                    <div className="flex items-center gap-2">
                      <LinkIcon className="w-4 h-4" />
                      <a
                        href={userProfile.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        Website
                      </a>
                    </div>
                  )}
                </div>

                {/* Email with privacy toggle */}
                {userProfile.email && (
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Mail className="w-4 h-4" />
                      {showEmail ? (
                        <a
                          href={`mailto:${userProfile.email}`}
                          className="text-blue-600 hover:underline"
                        >
                          {userProfile.email}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">Email hidden from public</span>
                      )}
                    </div>
                    {isCurrentUser && (
                      <button
                        onClick={() => setShowEmail(!showEmail)}
                        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 px-2 py-1 rounded hover:bg-accent"
                        title={showEmail ? 'Make email private' : 'Make email public'}
                      >
                        {showEmail ? 'Make Private' : 'Make Public'}
                      </button>
                    )}
                  </div>
                )}

                {/* Stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 md:gap-4 bg-gray-50 dark:bg-gray-800 rounded-lg p-3 sm:p-4">
                  <StatCard
                    icon={Eye}
                    label="Classifiers"
                    value={userProfile.stats.totalClassifiers}
                    onClick={() => setActiveTab('classifiers')}
                  />
                  <StatCard
                    icon={Package}
                    label="Models"
                    value={userProfile.stats.totalModels}
                    onClick={() => setActiveTab('models')}
                  />
                  <StatCard
                    icon={Star}
                    label="Total Stars"
                    value={userProfile.stats.totalStars}
                    onClick={() => setActiveTab('classifiers')}
                  />
                  <StatCard
                    icon={Download}
                    label="Downloads"
                    value={userProfile.stats.totalDownloads}
                    onClick={() => setActiveTab('classifiers')}
                  />
                  {/* Followers and Following stats temporarily commented out */}
                  {/* <StatCard
                    icon={Users}
                    label="Followers"
                    value={userProfile.stats.followers}
                    onClick={() => handleTabChange('followers')}
                    loading={loadingFollowStats}
                  />
                  <StatCard
                    icon={Heart}
                    label="Following"
                    value={userProfile.stats.following}
                    onClick={() => handleTabChange('following')}
                    loading={loadingFollowStats}
                  /> */}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Content Tabs */}
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-4 sm:mb-6">
            <TabsTrigger value="classifiers">Classifiers</TabsTrigger>
            <TabsTrigger value="models">Models</TabsTrigger>
            {/* Followers and Following tabs temporarily commented out */}
            {/* <TabsTrigger value="followers">Followers</TabsTrigger>
            <TabsTrigger value="following">Following</TabsTrigger> */}
          </TabsList>

          <TabsContent value="classifiers" className="space-y-4">
            <ClassifiersHeader
              title={
                <h2 className="text-xl font-semibold text-foreground">
                  Classifiers ({getFilteredAndSortedClassifiers().length})
                </h2>
              }
              titleIcon={<Star className="w-5 h-5 text-purple-600 dark:text-purple-400" />}
              search={classifierSearch}
              onSearchChange={(value) => {
                setClassifierSearch(value)
                setCurrentPage(1) // Reset to first page when searching
              }}
              selectedTags={selectedTags}
              onTagClick={handleTagClick}
              useSimpleTagColor={true}
              sort={classifierSort as any}
              onSortChange={(value: any) => {
                setClassifierSort(value === 'most_stars' ? 'most_likes' : value as any)
                setCurrentPage(1) // Reset to first page when sorting changes
              }}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
              {getPaginatedClassifiers().map((classifier) => (
                <UserClassifierCard
                  key={classifier.id}
                  classifier={classifier}
                  isCurrentUser={isCurrentUser}
                  onTagClick={handleTagClick}
                  userProfile={userProfile}
                />
              ))}
            </div>

            {/* Pagination */}
            {getTotalPages() > 1 && (
              <div className="flex flex-wrap items-center justify-center mt-8 gap-1">
                {/* Previous Button */}
                <button
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-muted-foreground hover:bg-accent disabled:text-muted-foreground/50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span className="hidden sm:inline">Prev</span>
                </button>

                {/* Page 1 */}
                <button
                  onClick={() => setCurrentPage(1)}
                  className={`rounded-lg px-2.5 py-1 text-sm ${
                    currentPage === 1
                      ? 'bg-accent font-semibold ring-1 ring-inset ring-border'
                      : 'text-muted-foreground hover:bg-accent'
                  }`}
                >
                  1
                </button>

                {/* Early ellipsis */}
                {currentPage > 4 && getTotalPages() > 6 && (
                  <span className="rounded-lg px-2.5 py-1 text-sm text-muted-foreground/50 pointer-events-none cursor-default">
                    ...
                  </span>
                )}

                {/* Middle pages */}
                {Array.from({ length: getTotalPages() }, (_, i) => i + 1)
                  .filter(pageNum => {
                    if (pageNum === 1 || pageNum === getTotalPages()) return false;
                    return Math.abs(pageNum - currentPage) <= 1;
                  })
                  .map(pageNum => (
                    <button
                      key={pageNum}
                      onClick={() => setCurrentPage(pageNum)}
                      className={`rounded-lg px-2.5 py-1 text-sm ${
                        currentPage === pageNum
                          ? 'bg-accent font-semibold ring-1 ring-inset ring-border'
                          : 'text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      {pageNum}
                    </button>
                  ))}

                {/* Late ellipsis */}
                {currentPage < getTotalPages() - 3 && getTotalPages() > 6 && (
                  <span className="rounded-lg px-2.5 py-1 text-sm text-muted-foreground/50 pointer-events-none cursor-default">
                    ...
                  </span>
                )}

                {/* Last page */}
                {getTotalPages() > 1 && (
                  <button
                    onClick={() => setCurrentPage(getTotalPages())}
                    className={`rounded-lg px-2.5 py-1 text-sm ${
                      currentPage === getTotalPages()
                        ? 'bg-accent font-semibold ring-1 ring-inset ring-border'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {getTotalPages()}
                  </button>
                )}

                {/* Next Button */}
                <button
                  onClick={() => setCurrentPage(Math.min(getTotalPages(), currentPage + 1))}
                  disabled={currentPage === getTotalPages()}
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-muted-foreground hover:bg-accent disabled:text-muted-foreground/50 disabled:cursor-not-allowed"
                >
                  <span className="hidden sm:inline">Next</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </TabsContent>

          <TabsContent value="models" className="space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                <Package className="w-5 h-5 text-[#6352a3]" />
                <h2 className="text-xl font-semibold">
                  Models ({getFilteredAndSortedModels().length})
                </h2>
              </div>
              <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-2 lg:gap-3">
                {/* Search */}
                <div className="flex items-center w-full lg:w-48 bg-white border border-gray-200 rounded-lg px-3 py-2">
                  <Search className="w-4 h-4 text-gray-400 mr-2 flex-shrink-0" />
                  <input
                    className="flex-1 border-none outline-none bg-transparent text-sm text-gray-900 placeholder-gray-400 min-w-0"
                    placeholder="Full-text search"
                    value={modelSearch}
                    onChange={(e) => {
                      setModelSearch(e.target.value)
                      setModelCurrentPage(1)
                    }}
                  />
                </div>
                {/* Selected Tags Display */}
                {selectedModelTags.length > 0 && (
                  <div className="flex items-center gap-2 overflow-x-auto pb-1 w-full lg:w-auto lg:max-w-[400px]">
                    <span className="text-sm text-[#594a93] font-medium whitespace-nowrap flex-shrink-0">Tags:</span>
                    <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
                      {selectedModelTags.map((tag) => (
                        <div key={tag} className="flex items-center gap-1 rounded-lg px-2 py-1 whitespace-nowrap flex-shrink-0 border bg-gray-100 text-gray-600 border-gray-300">
                          <span className="text-xs">{tag}</span>
                          <button
                            onClick={() => handleModelTagClick(tag)}
                            className="hover:opacity-70 transition-opacity ml-1"
                            title="Remove tag filter"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Sort */}
                <Select value={modelSort} onValueChange={(value: any) => {
                  setModelSort(value)
                  setModelCurrentPage(1)
                }}>
                  <SelectTrigger className="w-full lg:w-48 bg-white border border-gray-200 rounded-lg shadow-none">
                    <div className="flex items-center gap-2">
                      <ArrowUpDown className="w-4 h-4" />
                      <SelectValue />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="most_likes">Most Stars</SelectItem>
                    <SelectItem value="most_downloads">Most Downloads</SelectItem>
                    <SelectItem value="recently_upload">Recently Upload</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
              {getPaginatedModels().length > 0 ? (
                getPaginatedModels().map((model) => (
                  <UserModelCard
                    key={model.id}
                    model={model}
                    isCurrentUser={isCurrentUser}
                    onTagClick={handleModelTagClick}
                    userProfile={userProfile}
                  />
                ))
              ) : (
                <div className="col-span-full text-center py-16">
                  <Package className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                  <p className="text-gray-500 mb-2">No models found</p>
                  <p className="text-sm text-gray-400">Try adjusting your search or filters</p>
                </div>
              )}
            </div>

            {/* Pagination */}
            {getModelTotalPages() > 1 && (
              <div className="flex flex-wrap items-center justify-center mt-8 gap-1">
                {/* Previous Button */}
                <button
                  onClick={() => setModelCurrentPage(Math.max(1, modelCurrentPage - 1))}
                  disabled={modelCurrentPage === 1}
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span className="hidden sm:inline">Prev</span>
                </button>

                {/* Page 1 */}
                <button
                  onClick={() => setModelCurrentPage(1)}
                  className={`rounded-lg px-2.5 py-1 text-sm ${
                    modelCurrentPage === 1
                      ? 'bg-gray-50 font-semibold ring-1 ring-inset ring-gray-200'
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  1
                </button>

                {/* Early ellipsis */}
                {modelCurrentPage > 4 && getModelTotalPages() > 6 && (
                  <span className="rounded-lg px-2.5 py-1 text-sm text-gray-400 pointer-events-none cursor-default">
                    ...
                  </span>
                )}

                {/* Middle pages */}
                {Array.from({ length: getModelTotalPages() }, (_, i) => i + 1)
                  .filter(pageNum => {
                    if (pageNum === 1 || pageNum === getModelTotalPages()) return false;
                    return Math.abs(pageNum - modelCurrentPage) <= 1;
                  })
                  .map(pageNum => (
                    <button
                      key={pageNum}
                      onClick={() => setModelCurrentPage(pageNum)}
                      className={`rounded-lg px-2.5 py-1 text-sm ${
                        modelCurrentPage === pageNum
                          ? 'bg-gray-50 font-semibold ring-1 ring-inset ring-gray-200'
                          : 'text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {pageNum}
                    </button>
                  ))}

                {/* Late ellipsis */}
                {modelCurrentPage < getModelTotalPages() - 3 && getModelTotalPages() > 6 && (
                  <span className="rounded-lg px-2.5 py-1 text-sm text-gray-400 pointer-events-none cursor-default">
                    ...
                  </span>
                )}

                {/* Last page */}
                {getModelTotalPages() > 1 && (
                  <button
                    onClick={() => setModelCurrentPage(getModelTotalPages())}
                    className={`rounded-lg px-2.5 py-1 text-sm ${
                      modelCurrentPage === getModelTotalPages()
                        ? 'bg-gray-50 font-semibold ring-1 ring-inset ring-gray-200'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {getModelTotalPages()}
                  </button>
                )}

                {/* Next Button */}
                <button
                  onClick={() => setModelCurrentPage(Math.min(getModelTotalPages(), modelCurrentPage + 1))}
                  disabled={modelCurrentPage === getModelTotalPages()}
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
                >
                  <span className="hidden sm:inline">Next</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </TabsContent>

          {/* Followers tab content temporarily commented out */}
          {/* <TabsContent value="followers" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="w-5 h-5" />
                  Followers ({userProfile.stats.followers})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {loadingFollowers ? (
                  <div className="text-center py-8">
                    <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-muted-foreground">Loading followers...</p>
                  </div>
                ) : followers.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Users className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>No followers yet</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {followers.map((follower) => (
                      <div key={follower.user_id} className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent">
                        <Avatar className="w-10 h-10">
                          {follower.avatar_url ? (
                            <Image
                              src={follower.avatar_url}
                              alt={follower.preferred_name}
                              width={40}
                              height={40}
                              className="w-full h-full object-cover rounded-full"
                            />
                          ) : (
                            <div className="w-full h-full bg-gradient-to-br from-blue-400 to-purple-500 rounded-full flex items-center justify-center">
                              <User className="w-5 h-5 text-white" />
                            </div>
                          )}
                        </Avatar>
                        <div className="flex-1 flex items-center">
                          <p className="font-medium text-sm leading-none flex items-center m-0" style={{lineHeight: '1'}}>{follower.preferred_name || `User ${follower.user_id.substring(0, 8)}`}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs"
                          onClick={() => router.push(`/profile/${follower.user_id}`)}
                        >
                          View
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent> */}

          {/* Following tab content temporarily commented out */}
          {/* <TabsContent value="following" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Heart className="w-5 h-5" />
                  Following ({userProfile.stats.following})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {loadingFollowing ? (
                  <div className="text-center py-8">
                    <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-muted-foreground">Loading following...</p>
                  </div>
                ) : following.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Heart className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>Not following anyone yet</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {following.map((followingUser) => (
                      <div key={followingUser.user_id} className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent">
                        <Avatar className="w-10 h-10">
                          {followingUser.avatar_url ? (
                            <Image
                              src={followingUser.avatar_url}
                              alt={followingUser.preferred_name}
                              width={40}
                              height={40}
                              className="w-full h-full object-cover rounded-full"
                            />
                          ) : (
                            <div className="w-full h-full bg-gradient-to-br from-red-400 to-pink-500 rounded-full flex items-center justify-center">
                              <User className="w-5 h-5 text-white" />
                            </div>
                          )}
                        </Avatar>
                        <div className="flex-1 flex items-center">
                          <p className="font-medium text-sm leading-none flex items-center m-0" style={{lineHeight: '1'}}>{followingUser.preferred_name || `User ${followingUser.user_id.substring(0, 8)}`}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs"
                          onClick={() => router.push(`/profile/${followingUser.user_id}`)}
                        >
                          View
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent> */}
        </Tabs>
      </div>
    </div>
  )
}
