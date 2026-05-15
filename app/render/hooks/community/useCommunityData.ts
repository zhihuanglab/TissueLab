/**
 * Custom hooks for Community data fetching and management
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { apiFetch, payloadFromAxiosAppResponse } from '@/utils/common/apiFetch'
import { AI_SERVICE_API_ENDPOINT, CTRL_SERVICE_API_ENDPOINT } from '@/constants/config'
import { communityService } from '@/services/community.service'
import { classifiersService, ClassifierData as FirebaseClassifierData } from '@/services/classifiers.service'
import { toISOString } from '@/utils/community.utils'
import type { ClassifierData, NodeInfo, NodeExtended, SortOption, BackendNodeInfo } from '@/types/community.types'
import {
  factoryCategoriesFallback,
  factoryCategoryDisplayNamesFallback,
  factoryNodesExtendedFallback,
  factoryNodeInfoFallback,
  firebaseClassifiersFallback,
} from '@/constants/communityFallback'

/**
 * Hook for fetching and managing factory nodes data
 */
export function useFactoryNodes() {
  const [categories, setCategories] = useState<Record<string, string[]>>(factoryCategoriesFallback)
  const [nodeInfo, setNodeInfo] = useState<Record<string, NodeInfo>>(factoryNodeInfoFallback)
  const nodeInfoRef = useRef<Record<string, NodeInfo>>(factoryNodeInfoFallback)
  // Keep ref in sync with state so fetchRunning callback can access latest value without re-creating
  useEffect(() => { nodeInfoRef.current = nodeInfo }, [nodeInfo])
  const [nodesExtended, setNodesExtended] = useState<Record<string, NodeExtended>>(factoryNodesExtendedFallback)
  const [categoryDisplayNames, setCategoryDisplayNames] = useState<Record<string, string>>(factoryCategoryDisplayNamesFallback)
  const [nodeClassifierCounts, setNodeClassifierCounts] = useState<Record<string, number>>({})

  const fetchFactories = useCallback(async () => {
    try {
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_factory_models`, {
        method: 'GET',
        returnAxiosFormat: true,
      })
      const categoryMap = payloadFromAxiosAppResponse<Record<string, string[]>>(resp)
      if (categoryMap && typeof categoryMap === 'object' && !Array.isArray(categoryMap)) {
        setCategories(categoryMap)
      }
    } catch (e) {
      console.error(e)
    }
  }, [])

  const fetchRunning = useCallback(async (): Promise<Record<string, NodeInfo>> => {
    try {
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`, {
        method: 'GET',
        returnAxiosFormat: true,
      })
      const payload = payloadFromAxiosAppResponse<{ nodes?: Record<string, BackendNodeInfo> }>(resp) ?? {}

      if (!payload.nodes || typeof payload.nodes !== 'object') {
        console.warn('[fetchRunning] Missing nodes in response, preserving previous nodeInfo', payload)
        return nodeInfoRef.current
      }

      const nodes = payload.nodes
      const info: Record<string, NodeInfo> = {}
      Object.entries(nodes).forEach(([name, meta]) => {
        info[name] = {
          running: !!meta?.running,
          ready: meta?.ready,
          starting: !!meta?.starting,
          envName: meta?.env_name,
          port: meta?.port,
          logPath: meta?.log_path,
          servicePath: meta?.service_path,
          dependencyPath: meta?.dependency_path,
          pythonVersion: meta?.python_version,
          isRemote: meta?.is_remote,
          remoteHost: meta?.remote_host,
          mntPath: meta?.mnt_path,
        }
      })
      info['Scripts'] = { running: true }
      
      // Always update state - the comparison was preventing updates when nodes are removed
      setNodeInfo(info)
      return info
    } catch (e) {
      console.error('[fetchRunning] Network error, preserving previous nodeInfo', e)
      return nodeInfoRef.current
    }
  }, [])

  const fetchNodesExtended = useCallback(async () => {
    try {
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_nodes_extended`, {
        method: 'GET',
        returnAxiosFormat: true,
      })
      const data = resp.data
      const nodes = data?.data?.nodes || {}
      const catMap = data?.data?.category_map || {}
      const catNames = data?.data?.category_display_names || {}
      
      // Only update state if data actually changed to prevent unnecessary re-renders
      if (Object.keys(catMap).length) {
        setCategories((prev) => {
          const prevStr = JSON.stringify(prev)
          const newStr = JSON.stringify(catMap)
          if (prevStr !== newStr) {
            return catMap
          }
          return prev
        })
      }
      
      setNodesExtended((prev) => {
        const prevStr = JSON.stringify(prev)
        const newStr = JSON.stringify(nodes)
        if (prevStr !== newStr) {
          return nodes
        }
        return prev
      })
      
      setCategoryDisplayNames((prev) => {
        const prevStr = JSON.stringify(prev)
        const newStr = JSON.stringify(catNames)
        if (prevStr !== newStr) {
          return catNames
        }
        return prev
      })
      
      return nodes
    } catch (e) {
      console.error(e)
      return {}
    }
  }, [])

  const fetchNodeClassifierCounts = useCallback(async () => {
    try {
      const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_node_classifier_counts`, {
        method: 'GET',
        returnAxiosFormat: true,
      })
      const counts = payloadFromAxiosAppResponse<Record<string, number>>(resp) ?? {}
      if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
        setNodeClassifierCounts(counts)
        return
      }
      throw new Error(`HTTP ${resp.status}`)
    } catch (e) {
      setNodeClassifierCounts({})
    }
  }, [])

  return {
    categories,
    nodeInfo,
    nodesExtended,
    categoryDisplayNames,
    nodeClassifierCounts,
    fetchFactories,
    fetchRunning,
    fetchNodesExtended,
    fetchNodeClassifierCounts
  }
}

/**
 * Hook for fetching and managing classifiers data
 */
export function useClassifiers(userInfo?: any) {
  const [realClassifiers, setRealClassifiers] = useState<ClassifierData[]>([])
  const [userUploadedClassifiers, setUserUploadedClassifiers] = useState<ClassifierData[]>([])
  const [firebaseClassifiers, setFirebaseClassifiers] = useState<FirebaseClassifierData[]>(firebaseClassifiersFallback)
  const [loadingClassifiers, setLoadingClassifiers] = useState(false)
  const [loadingFirebaseClassifiers, setLoadingFirebaseClassifiers] = useState(false)

  // Load Firebase classifiers
  const loadFirebaseClassifiers = useCallback(async () => {
    try {
      setLoadingFirebaseClassifiers(true)
      const response = await classifiersService.getPublicClassifiers()
      if (response.success) {
        const baseList = response.classifiers || []
        try {
          const ownerIds = Array.from(new Set((baseList || []).map((x: any) => x.ownerId).filter(Boolean)))
          const ownerProfiles: Record<string, any> = {}
          
          await Promise.all(ownerIds.map(async (uid) => {
            try {
              const p = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/users/v1/public_profile/${uid}`, { method: 'GET' })
              ownerProfiles[uid] = p || {}
              if (p?.preferred_name) {
                try { 
                  const existing = localStorage.getItem(`preferred_name_${uid}`)
                  if (existing !== p.preferred_name) {
                    localStorage.setItem(`preferred_name_${uid}`, p.preferred_name)
                  }
                } catch {}
              }
              if (p?.avatar_url) {
                try { 
                  const existing = localStorage.getItem(`user_avatar_${uid}`)
                  if (existing !== p.avatar_url) {
                    localStorage.setItem(`user_avatar_${uid}`, p.avatar_url)
                  }
                } catch {}
              }
            } catch {}
          }))

          const detailed = await Promise.all(
            baseList.map(async (c: any) => {
              try {
                const detail = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${c.id}`, { method: 'GET' })
                const stars = detail?.star_count ?? c?.stats?.stars ?? 0
                const downloads = detail?.classifier?.stats?.downloads ?? c?.stats?.downloads ?? 0
                const isStarred = detail?.is_starred ?? false

                const profile = ownerProfiles[c.ownerId] || {}
                const preferredName = profile?.preferred_name
                const avatarUrl = profile?.avatar_url

                return {
                  ...c,
                  user_name: preferredName || c.user_name,
                  author_display: preferredName || undefined,
                  author_avatar_url: avatarUrl || undefined,
                  ...(detail.classifier?.model && { model: detail.classifier.model }),
                  stats: {
                    ...(c.stats || {}),
                    stars,
                    downloads,
                  },
                  is_starred: isStarred,
                }
              } catch (_) {
                const profile = ownerProfiles[c.ownerId] || {}
                return {
                  ...c,
                  author_display: profile?.preferred_name || undefined,
                  author_avatar_url: profile?.avatar_url || undefined,
                }
              }
            })
          )
          setFirebaseClassifiers(detailed)
          console.log(`Loaded ${detailed.length} public classifiers from Firebase`)
        } catch (_) {
          setFirebaseClassifiers(baseList)
          console.log(`Loaded ${baseList.length} public classifiers from Firebase`)
        }
      }
    } catch (error) {
      console.error('Failed to load Firebase classifiers:', error)
    } finally {
      setLoadingFirebaseClassifiers(false)
    }
  }, [])

  // Load user uploaded classifiers
  const loadUserUploadedClassifiers = useCallback(async () => {
    try {
      const savedClassifiers = localStorage.getItem('userUploadedClassifiers')
      if (savedClassifiers) {
        const parsedClassifiers = JSON.parse(savedClassifiers)
        const updatedClassifiers = []
        const removedIds: string[] = []

        for (const classifier of parsedClassifiers) {
          try {
            const details = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${classifier.id}`, {
              method: 'GET'
            })
            
            const updatedClassifier = {
              ...classifier,
              ...(details.classifier?.model && { model: details.classifier.model }),
              stats: {
                ...classifier.stats,
                downloads: details.classifier?.stats?.downloads || classifier.stats.downloads || 0,
                stars: (details.star_count !== undefined ? details.star_count : (details.classifier?.stats?.stars)) || classifier.stats.stars || 0,
              }
            }
            updatedClassifiers.push(updatedClassifier)
          } catch (error) {
            const status = (error as any)?.status
            if (status === 404) {
              const now = Date.now()
              const classifierAge = now - parseInt(classifier.id.replace('uploaded-', ''))
              const fiveMinutes = 5 * 60 * 1000
              
              if (classifierAge < fiveMinutes) {
                console.log(`Keeping recently uploaded classifier that's still syncing: ${classifier.id}`)
                updatedClassifiers.push(classifier)
              } else {
                console.log(`Cleaning up deleted classifier: ${classifier.id}`)
                removedIds.push(classifier.id)
                continue
              }
            } else {
              updatedClassifiers.push(classifier)
            }
          }
        }

        setUserUploadedClassifiers(updatedClassifiers)

        if (removedIds.length > 0) {
          console.log(`Cleaned up ${removedIds.length} deleted classifiers from localStorage`)
          const filtered = updatedClassifiers.filter((c: any) => !removedIds.includes(c.id))
          localStorage.setItem('userUploadedClassifiers', JSON.stringify(filtered))
          window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedClassifiers' } }))
        } else {
          // Only update localStorage if data actually changed to prevent unnecessary events
          const currentData = JSON.stringify(updatedClassifiers)
          const existingData = localStorage.getItem('userUploadedClassifiers')
          if (existingData !== currentData) {
            localStorage.setItem('userUploadedClassifiers', currentData)
          }
        }
      }
    } catch (error) {
      console.error('Error loading user uploaded classifiers:', error)
    }
  }, [])

  // Fetch real classifiers
  const fetchRealClassifiers = useCallback(async (silent = false) => {
    if (loadingClassifiers && !silent) {
      return
    }
    
    try {
      if (!silent) {
        setLoadingClassifiers(true)
      }
      
      const response = await communityService.getClassifiers({
        limit: 50,
        sort_by: 'updated_at',
        sort_order: 'desc'
      })
      
      if (response && response.classifiers && response.classifiers.length > 0) {
        const userIds = new Set<string>()
        response.classifiers.forEach((classifier: any) => {
          const userId = classifier.author?.user_id
          if (userId && userId !== 'anonymous') {
            userIds.add(userId)
          }
        })

        const userProfiles: Record<string, string> = {}
        if (userIds.size > 0) {
          try {
            userIds.forEach(userId => {
              const preferredName = localStorage.getItem(`preferred_name_${userId}`)
              if (preferredName && preferredName !== 'null' && preferredName !== '') {
                userProfiles[userId] = preferredName
              }
            })
          } catch (error) {
            console.warn('Failed to get user profiles from localStorage:', error)
          }
        }

        const transformedClassifiers: ClassifierData[] = response.classifiers.map((classifier: any) => {
          const userId = classifier.author?.user_id
          const currentPreferredName = userProfiles[userId]
          
          return {
            id: classifier.id,
            title: classifier.title,
            description: classifier.description,
            author: {
              name: currentPreferredName || classifier.author?.display_name || classifier.author?.username || 'Unknown Author',
              avatar: classifier.author?.avatar_url || '/avatars/default.jpg',
              user_id: classifier.author?.user_id || 'anonymous',
              username: classifier.author?.username || 'anonymous'
            },
            stats: {
              classes: classifier.classes || null,
              size: classifier.file_size ? `${(classifier.file_size / (1024 * 1024)).toFixed(2)} MB` : 'Unknown',
              downloads: classifier.stats?.downloads || 0,
              stars: classifier.stats?.stars || 0,
              updatedAt: classifier.stats?.updated_at?.split('T')[0] || new Date().toISOString().split('T')[0],
              createdAt: classifier.stats?.created_at || new Date().toISOString()
            },
            tags: classifier.tags || [],
            thumbnail: classifier.thumbnail_url || '/thumbnails/default.jpg',
            factory: classifier.factory || '',
            node: classifier.node || ''
          }
        })
        setRealClassifiers(transformedClassifiers)
      } else {
        setRealClassifiers([])
      }
    } catch (error) {
      if (!silent) {
        console.error('Failed to fetch classifiers:', error)
      }
      setRealClassifiers([])
    } finally {
      if (!silent) {
        setLoadingClassifiers(false)
      }
    }
  }, [loadingClassifiers])

  return {
    realClassifiers,
    userUploadedClassifiers,
    firebaseClassifiers,
    loadingClassifiers,
    loadingFirebaseClassifiers,
    setRealClassifiers,
    setUserUploadedClassifiers,
    setFirebaseClassifiers,
    loadFirebaseClassifiers,
    loadUserUploadedClassifiers,
    fetchRealClassifiers
  }
}

/**
 * Hook for managing classifier filtering and pagination
 */
export function useClassifierFilter(
  firebaseClassifiers: FirebaseClassifierData[],
  itemsPerPage: number
) {
  const [classifierSearch, setClassifierSearch] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [classifierSort, setClassifierSort] = useState<SortOption>('most_stars')
  const [currentPage, setCurrentPage] = useState(1)

  const getFilteredAndSortedClassifiers = useCallback((): ClassifierData[] => {
    // Convert Firebase classifiers to local ClassifierData format
    const convertedFirebaseClassifiers: ClassifierData[] = firebaseClassifiers.map(fc => ({
      id: fc.id,
      title: fc.title,
      description: fc.description,
      author: {
        name: classifiersService.getAuthorDisplay(fc),
        avatar: '/avatars/default.jpg',
        user_id: fc.ownerId,
        username: fc.ownerId
      },
      stats: {
        classes: (fc as any).classesCount || fc.stats?.classes || 0,
        size: classifiersService.formatFileSize((fc as any).fileSize || fc.stats?.size),
        downloads: fc.stats?.downloads || 0,
        stars: fc.stats?.stars || 0,
        updatedAt: toISOString((fc as any).updatedAt),
        createdAt: toISOString((fc as any).createdAt)
      },
      tags: fc.tags || [],
      thumbnail: '/thumbnails/default.jpg',
      filePath: (fc as any).localPath,
      downloadLink: fc.downloadLink,
      factory: fc.factory,
      model: fc.model || '',
      node: fc.model || ''
    }))

    const uniqueClassifiers = new Map<string, ClassifierData>()
    for (const item of convertedFirebaseClassifiers) {
      if (!item || !item.id) continue
      
      const normalized: ClassifierData = {
        ...item,
        stats: {
          ...item.stats,
          downloads: Number(item.stats.downloads || 0),
          stars: Number(item.stats.stars || 0),
          updatedAt: item.stats.updatedAt,
          createdAt: item.stats.createdAt,
          classes: item.stats.classes === null ? null : Number(item.stats.classes)
        }
      }
      
      if (!uniqueClassifiers.has(item.id)) {
        uniqueClassifiers.set(item.id, normalized)
      }
    }
    
    let filtered = Array.from(uniqueClassifiers.values())
    
    // Apply search filter
    if (classifierSearch.trim()) {
      const searchTerm = classifierSearch.toLowerCase()
      filtered = filtered.filter(classifier => 
        classifier.title.toLowerCase().includes(searchTerm) ||
        classifier.description.toLowerCase().includes(searchTerm) ||
        classifier.tags.some(tag => tag.toLowerCase().includes(searchTerm)) ||
        classifier.author?.name.toLowerCase().includes(searchTerm)
      )
    }
    
    // Apply tag filters
    if (selectedTags.length > 0) {
      const factoryCategories = [
        { id: 'tissue_segmentation', name: 'Tissue Segmentation' },
        { id: 'cell_segmentation', name: 'Cell Segmentation + Embedding' },
        { id: 'nuclei_classification', name: 'Nuclei Classification' },
        { id: 'code_calculation', name: 'Code Calculation' },
        { id: 'tissue_classification', name: 'Tissue Classification' }
      ]
      
      filtered = filtered.filter(classifier => {
        const factoryCategory = factoryCategories.find(f => f.id === classifier.factory)
        const factoryDisplayName = factoryCategory?.name || classifier.factory
        const nodeId = classifier.node
        
        return selectedTags.every(selectedTag => {
          if ((factoryDisplayName || classifier.factory || 'Unknown').toLowerCase() === selectedTag.toLowerCase()) {
            return true
          }
          if (nodeId && nodeId.toLowerCase() === selectedTag.toLowerCase()) {
            return true
          }
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
        case 'most_stars':
          return b.stats.stars - a.stats.stars
        case 'most_downloads':
          return b.stats.downloads - a.stats.downloads
        case 'recently_upload':
          const aCreated = new Date(a.stats.createdAt || a.stats.updatedAt).getTime()
          const bCreated = new Date(b.stats.createdAt || b.stats.updatedAt).getTime()
          return bCreated - aCreated
        default:
          return 0
      }
    })
    
    return filtered
  }, [firebaseClassifiers, classifierSearch, selectedTags, classifierSort])

  const getPaginatedClassifiers = useCallback(() => {
    const filtered = getFilteredAndSortedClassifiers()
    const startIndex = (currentPage - 1) * itemsPerPage
    const endIndex = startIndex + itemsPerPage
    return filtered.slice(startIndex, endIndex)
  }, [getFilteredAndSortedClassifiers, currentPage, itemsPerPage])

  const getTotalPages = useCallback(() => {
    const filtered = getFilteredAndSortedClassifiers()
    return Math.ceil(filtered.length / itemsPerPage)
  }, [getFilteredAndSortedClassifiers, itemsPerPage])

  return {
    classifierSearch,
    setClassifierSearch,
    selectedTags,
    setSelectedTags,
    classifierSort,
    setClassifierSort,
    currentPage,
    setCurrentPage,
    getFilteredAndSortedClassifiers,
    getPaginatedClassifiers,
    getTotalPages
  }
}

