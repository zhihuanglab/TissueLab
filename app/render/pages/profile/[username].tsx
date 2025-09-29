"use client";
import React, { useState, useEffect, useCallback } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '@/store'
import { useRouter } from 'next/router'
import Image from 'next/image'
import { communityService } from '@/services/community.service'
import { classifiersService } from '@/services/classifiers.service'
import { usersService, UserProfile as APIUserProfile } from '@/services/users.service'
import { apiFetch } from '@/utils/apiFetch'
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
import { downloadCommunityClassifier } from '@/utils/fileManager.service'
import { toast } from 'sonner'
import {
  User,
  Calendar,
  MapPin,
  Link as LinkIcon,
  Mail,
  Star,
  Download,
  Eye,
  Settings,
  Share2,
  Clock,
  Award,
  TrendingUp,
  Heart,
  Bookmark,
  ArrowLeft,
  Users,
  Trash2,
  ChevronRight,
  ChevronLeft,
  Building2,
  Search,
  ArrowUpDown
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
        'code_calculation': 'Code Calculation',
        'tissue_classification': 'Tissue Classification',
      };

      const tags: string[] = [];
      const factoryDisplay = factoryId ? (categoryDisplay[factoryId] || factoryId) : '';
      if (factoryDisplay) tags.push(factoryDisplay);
      if (nodeId && (!factoryDisplay || !factoryDisplay.toLowerCase().includes(String(nodeId).toLowerCase()))) tags.push(nodeId);
      for (const t of modalityTags) if (typeof t === 'string') tags.push(t);

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
        tags,
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
      toast.error(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
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
            toast.warning(`Backend deletion failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
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
        toast.error('Error occurred while deleting classifier')
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
        <p className="text-sm text-gray-600 line-clamp-2">
          {classifier.description}
        </p>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="flex items-center justify-between text-xs text-gray-500 mb-3">
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
              { id: 'code_calculation', name: 'Code Calculation' },
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

            // Function to get hierarchical colors
            const getHierarchicalColor = (displayTag: string, isFactory: boolean, factoryName: string) => {
              // Modality tags - brand purple family with different intensities
              if (displayTag.toLowerCase() === 'pathology') {
                return 'bg-[#6352a3]/10 text-[#594a93]';
              }
              if (displayTag.toLowerCase() === 'radiology') {
                return 'bg-[#6352a3]/15 text-[#594a93]';
              }
              if (displayTag.toLowerCase() === 'spatial transcriptomics') {
                return 'bg-[#6352a3]/5 text-[#594a93]';
              }

              // Factory categories (main classes) - use exact same colors as community page
              if (isFactory) {
                if (displayTag.toLowerCase().includes('tissue segmentation')) {
                  return 'bg-blue-100 text-blue-700';
                }
                if (displayTag.toLowerCase().includes('cell segmentation')) {
                  return 'bg-yellow-100 text-yellow-700';
                }
                if (displayTag.toLowerCase().includes('nuclei classification')) {
                  return 'bg-green-100 text-green-700';
                }
                if (displayTag.toLowerCase().includes('code calculation')) {
                  return 'bg-orange-100 text-orange-700';
                }
                if (displayTag.toLowerCase().includes('tissue classification')) {
                  return 'bg-teal-100 text-teal-700';
                }
              } else {
                // Node-level (sub-class) colors based on factory context
                // Tissue Segmentation nodes - base color #dbe9fe
                if (factoryName.toLowerCase().includes('tissue segmentation')) {
                  if (displayTag === 'MuskEmbedding') return 'bg-[#dbe9fe]/30 text-[#1e40af]';
                  if (displayTag === 'BiomedParseNode') return 'bg-[#dbe9fe]/60 text-[#1e40af]';
                  return 'bg-[#dbe9fe]/90 text-[#1e40af]'; // fallback for other nodes
                }

                // Cell Segmentation nodes - base color #fef9c3
                if (factoryName.toLowerCase().includes('cell segmentation')) {
                  if (displayTag === 'SegmentationNode') return 'bg-[#fef9c3]/40 text-[#a16207]';
                  return 'bg-[#fef9c3]/70 text-[#a16207]'; // fallback for other nodes
                }

                // Nuclei Classification nodes - base color #d9f9e4
                if (factoryName.toLowerCase().includes('nuclei classification')) {
                  if (displayTag === 'ClassificationNode') return 'bg-[#d9f9e4]/40 text-[#166534]';
                  return 'bg-[#d9f9e4]/70 text-[#166534]'; // fallback for other nodes
                }

                // Code Calculation nodes - base color #f5e4cd
                if (factoryName.toLowerCase().includes('code calculation')) {
                  return 'bg-[#f5e4cd]/40 text-[#c2410c]'; // fallback for nodes
                }

                // Tissue Classification nodes - base color #cbfbf1
                if (factoryName.toLowerCase().includes('tissue classification')) {
                  return 'bg-[#cbfbf1]/40 text-[#0f766e]'; // fallback for nodes
                }
              }

              // Default for other tags
              return 'bg-gray-100 text-gray-600';
            };

            const tagsToShow = showAllTags ? displayTags : displayTags.slice(0, 2);

            return tagsToShow.map((displayTag, displayIndex) => {
              const colorClass = getHierarchicalColor(displayTag.text, displayTag.isFactory, factoryDisplayName || '');

              return (
                <Badge
                  key={`classifier-${displayIndex}`}
                  className={`text-xs px-2 py-1 cursor-pointer hover:opacity-80 transition-opacity ${colorClass}`}
                  onClick={onTagClick ? () => onTagClick(displayTag.text) : undefined}
                >
                  {displayTag.text}
                </Badge>
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
              <Badge
                variant="outline"
                className="text-xs cursor-pointer hover:bg-gray-100 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAllTags(true);
                }}
              >
                +{totalTags - 2}
              </Badge>
            ) : showAllTags && totalTags > 2 ? (
              <Badge
                variant="outline"
                className="text-xs cursor-pointer hover:bg-gray-100 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAllTags(false);
                }}
              >
                Show Less
              </Badge>
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
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-600 mr-1"></div>
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
            <DialogTitle className="text-2xl font-bold text-[#6352a3]">
              {classifier.title}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Classifier details and description
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <h3 className="text-base font-semibold text-gray-800 mb-2">About Classifier</h3>
              <div className="text-sm text-gray-600 leading-relaxed break-words overflow-wrap-anywhere">
                {classifier.description}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 pt-4 border-t">
              <div className="text-sm text-gray-500">
                <span className="font-medium">Classes:</span> {classifier.stats.classes ?? 'null'}
              </div>
              <div className="text-sm text-gray-500">
                <span className="font-medium">Size:</span> {classifier.stats.size}
              </div>
              <div className="text-sm text-gray-500">
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
      className={`text-center p-3 ${onClick ? 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors' : ''}`}
      onClick={onClick}
    >
      <Icon className="w-6 h-6 mx-auto mb-2 text-blue-600" />
      {loading ? (
        <div className="text-2xl font-bold text-gray-900 dark:text-white">
          <div className="w-8 h-8 bg-gray-200 dark:bg-gray-700 rounded animate-pulse mx-auto"></div>
        </div>
      ) : (
        <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
      )}
      <div className="text-sm text-gray-600 dark:text-gray-400">{label}</div>
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

  // Search, filter, and sort states
  const [classifierSearch, setClassifierSearch] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [classifierSort, setClassifierSort] = useState<'most_likes' | 'most_downloads' | 'recently_upload'>('most_likes')

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1)
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
          { id: 'code_calculation', name: 'Code Calculation' },
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
          
          // Calculate classifier stats but don't update profile yet
          let updatedProfileData = profileData
          if (profileData && allClassifiers.length > 0) {
            updatedProfileData = {
              ...profileData,
              stats: {
                ...profileData.stats,
                totalClassifiers: allClassifiers.length,
                totalStars: allClassifiers.reduce((sum, c) => sum + (c.stats.stars || 0), 0),
                totalDownloads: allClassifiers.reduce((sum, c) => sum + (c.stats.downloads || 0), 0)
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
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading profile...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gray-50 dark:bg-gray-900 min-h-screen">
      <div className="container mx-auto px-4 py-6 max-w-7xl">
        {/* Back to Community Button */}
        <div className="mb-6">
          <button
            onClick={() => router.push('/community')}
            className="px-4 py-1.5 rounded-lg hover:opacity-90 transition-all duration-200 flex items-center text-sm"
            style={{
              backgroundColor: '#6352a3',
              borderColor: '#6352a3',
              color: 'white',
              border: '1px solid #6352a3',
              cursor: 'pointer'
            }}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Community
          </button>
        </div>
        {/* Profile Header */}
        <Card className="mb-6">
          <CardContent className="p-6">
            <div className="flex flex-col md:flex-row gap-6">
              {/* Left: Avatar and basic info */}
              <div className="flex flex-col items-center md:items-start">
                <Avatar className="w-24 h-24 mb-4">
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
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-1">
                  {userProfile.displayName}
                </h1>
                <p className="text-gray-600 dark:text-gray-400 mb-4">@{userProfile.username}</p>
                
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm text-gray-600 dark:text-gray-400 mb-6">
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
                    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                      <Mail className="w-4 h-4" />
                      {showEmail ? (
                        <a
                          href={`mailto:${userProfile.email}`}
                          className="text-blue-600 hover:underline"
                        >
                          {userProfile.email}
                        </a>
                      ) : (
                        <span className="text-gray-500">Email hidden from public</span>
                      )}
                    </div>
                    {isCurrentUser && (
                      <button
                        onClick={() => setShowEmail(!showEmail)}
                        className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                        title={showEmail ? 'Make email private' : 'Make email public'}
                      >
                        {showEmail ? 'Make Private' : 'Make Public'}
                      </button>
                    )}
                  </div>
                )}

                {/* Stats */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                  <StatCard
                    icon={Eye}
                    label="Classifiers"
                    value={userProfile.stats.totalClassifiers}
                    onClick={() => setActiveTab('classifiers')}
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
          <TabsList className="grid w-full grid-cols-1 mb-6">
            <TabsTrigger value="classifiers">Classifiers</TabsTrigger>
            {/* Followers and Following tabs temporarily commented out */}
            {/* <TabsTrigger value="followers">Followers</TabsTrigger>
            <TabsTrigger value="following">Following</TabsTrigger> */}
          </TabsList>

          <TabsContent value="classifiers" className="space-y-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Star className="w-5 h-5 text-[#6352a3]" />
                <h2 className="text-xl font-semibold">
                  Classifiers ({getFilteredAndSortedClassifiers().length})
                </h2>
              </div>
              <div className="flex items-center gap-3">
                {/* Search */}
                <div className="flex items-center w-48 bg-white border border-gray-200 rounded-lg px-3 py-2">
                  <Search className="w-4 h-4 text-gray-400 mr-2 flex-shrink-0" />
                  <input
                    className="flex-1 border-none outline-none bg-transparent text-sm text-gray-900 placeholder-gray-400 min-w-0"
                    placeholder="Full-text search"
                    value={classifierSearch}
                    onChange={(e) => {
                      setClassifierSearch(e.target.value)
                      setCurrentPage(1) // Reset to first page when searching
                    }}
                  />
                </div>
                {/* Selected Tags Display */}
                {selectedTags.length > 0 && (
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    <span className="text-sm text-[#594a93] font-medium whitespace-nowrap">Tags:</span>
                    <div className="flex items-center gap-2 min-w-0">
                      {selectedTags.map((tag) => {
                        // Function to get tag color for filter display
                        const getFilterTagColor = (tagText: string) => {
                          // Factory categories (main classes)
                          if (tagText.toLowerCase().includes('tissue segmentation')) {
                            return 'bg-blue-100 text-blue-700 border-blue-200';
                          }
                          if (tagText.toLowerCase().includes('cell segmentation')) {
                            return 'bg-yellow-100 text-yellow-700 border-yellow-200';
                          }
                          if (tagText.toLowerCase().includes('nuclei classification')) {
                            return 'bg-green-100 text-green-700 border-green-200';
                          }
                          if (tagText.toLowerCase().includes('code calculation')) {
                            return 'bg-orange-100 text-orange-700 border-orange-200';
                          }
                          if (tagText.toLowerCase().includes('tissue classification')) {
                            return 'bg-teal-100 text-teal-700 border-teal-200';
                          }

                          // Modality tags
                          if (tagText.toLowerCase() === 'pathology') {
                            return 'bg-[#6352a3]/10 text-[#594a93] border-[#6352a3]/30';
                          }
                          if (tagText.toLowerCase() === 'radiology') {
                            return 'bg-[#6352a3]/15 text-[#594a93] border-[#6352a3]/30';
                          }
                          if (tagText.toLowerCase() === 'spatial transcriptomics') {
                            return 'bg-[#6352a3]/5 text-[#594a93] border-[#6352a3]/20';
                          }

                          // Default for other tags
                          return 'bg-gray-100 text-gray-600 border-gray-300';
                        };

                        const colorClass = getFilterTagColor(tag);

                        return (
                          <div key={tag} className={`flex items-center gap-1 rounded-lg px-2 py-1 whitespace-nowrap flex-shrink-0 border ${colorClass}`}>
                            <span className="text-xs">{tag}</span>
                            <button
                              onClick={() => handleTagClick(tag)}
                              className="hover:opacity-70 transition-opacity ml-1"
                              title="Remove tag filter"
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* Sort */}
                <Select value={classifierSort} onValueChange={(value: any) => {
                  setClassifierSort(value)
                  setCurrentPage(1) // Reset to first page when sorting changes
                }}>
                  <SelectTrigger className="w-48 bg-white border border-gray-200 rounded-lg shadow-none">
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

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
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
              <div className="flex items-center justify-center mt-8 gap-1">
                {/* Previous Button */}
                <button
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Prev
                </button>

                {/* Page 1 */}
                <button
                  onClick={() => setCurrentPage(1)}
                  className={`rounded-lg px-2.5 py-1 text-sm ${
                    currentPage === 1
                      ? 'bg-gray-50 font-semibold ring-1 ring-inset ring-gray-200'
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  1
                </button>

                {/* Early ellipsis */}
                {currentPage > 4 && getTotalPages() > 6 && (
                  <span className="rounded-lg px-2.5 py-1 text-sm text-gray-400 pointer-events-none cursor-default">
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
                          ? 'bg-gray-50 font-semibold ring-1 ring-inset ring-gray-200'
                          : 'text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      {pageNum}
                    </button>
                  ))}

                {/* Late ellipsis */}
                {currentPage < getTotalPages() - 3 && getTotalPages() > 6 && (
                  <span className="rounded-lg px-2.5 py-1 text-sm text-gray-400 pointer-events-none cursor-default">
                    ...
                  </span>
                )}

                {/* Last page */}
                {getTotalPages() > 1 && (
                  <button
                    onClick={() => setCurrentPage(getTotalPages())}
                    className={`rounded-lg px-2.5 py-1 text-sm ${
                      currentPage === getTotalPages()
                        ? 'bg-gray-50 font-semibold ring-1 ring-inset ring-gray-200'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {getTotalPages()}
                  </button>
                )}

                {/* Next Button */}
                <button
                  onClick={() => setCurrentPage(Math.min(getTotalPages(), currentPage + 1))}
                  disabled={currentPage === getTotalPages()}
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
                >
                  Next
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
                    <p className="text-gray-500">Loading followers...</p>
                  </div>
                ) : followers.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <Users className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>No followers yet</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {followers.map((follower) => (
                      <div key={follower.user_id} className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
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
                    <p className="text-gray-500">Loading following...</p>
                  </div>
                ) : following.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <Heart className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>Not following anyone yet</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {following.map((followingUser) => (
                      <div key={followingUser.user_id} className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
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
