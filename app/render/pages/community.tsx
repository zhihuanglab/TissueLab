"use client";
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import Image from 'next/image'
import { useUserInfo } from '@/provider/UserInfoProvider'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Avatar } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { 
  Search, 
  Filter, 
  Star, 
  Download, 
  Eye, 
  Calendar,
  User,
  ChevronRight,
  Heart,
  Bookmark,
  TrendingUp,
  Clock,
  Plus,
  Upload,
  X,
  Trash2,
  MoreHorizontal,
  ArrowLeft,
  Settings,
  Database,
  Home,
  Boxes,
  CheckCircle,
  FileText,
  ArrowUpDown,
  ChevronLeft,
  SquareTerminal
} from "lucide-react"
import { useRouter } from 'next/router'
import http from '@/utils/http';
import { AI_SERVICE_API_ENDPOINT, CTRL_SERVICE_API_ENDPOINT } from '@/constants/config'
import { apiFetch } from '@/utils/apiFetch'
import CustomNodeDialog from '@/components/AgentZoo/CustomNodeDialog'
import { communityService } from '@/services/community.service'
import { classifiersService, ClassifierData as FirebaseClassifierData } from '@/services/classifiers.service'
import NotificationToast from '@/components/ui/NotificationToast'
import NodeLogsDialog from '@/components/AgentZoo/NodeLogsDialog'
import { toast } from 'sonner'
import { downloadCommunityClassifier } from '@/utils/fileManager.service'
import { uploadFiles } from '@/utils/fileManager.service'

interface ClassifierData {
  id: string
  title: string
  description: string
  author: {
    name: string
    avatar: string
    user_id?: string
    username?: string
  }
  stats: {
    classes: number | null
    size: string
    downloads: number
    stars: number
    updatedAt: string
    createdAt: string
  }
  tags: string[]
  thumbnail: string
  filePath?: string
  downloadLink?: string
  factory?: string
  model?: string
  node?: string
  is_starred?: boolean  
}

interface TaskNodeData {
  id: string
  name: string
  category: string
  models: ModelData[]
  classifiers: ClassifierData[]
  description?: string
  tags: string[]
}

interface ModelData {
  id: string
  name: string
  size: string
  status: 'downloaded' | 'available' | 'installing'
  classifiers?: number
  isDefault?: boolean
}

interface DatasetData {
  id: string
  title: string
  description: string
  author: {
    name: string
    avatar: string
    user_id?: string
    username?: string
  }
  stats: {
    size: string
    samples: number
    downloads: number
    stars: number
    updatedAt: string
  }
  tags: string[]
  thumbnail: string
}

// No mock classifiers - will use real data from backend or show empty state


const mockDatasets: DatasetData[] = [
  {
    id: '1',
    title: 'TCGA Breast Cancer Dataset',
    description: 'Comprehensive breast cancer histopathology images from TCGA database',
    author: {
      name: 'TCGA Research Network',
      avatar: '/avatars/tcga.jpg'
    },
    stats: {
      size: '45.2 GB',
      samples: 15420,
      downloads: 892,
      stars: 2,
      updatedAt: '2025-09-01'
    },
    tags: ['Breast Cancer', 'Histopathology', 'TCGA', 'WSI'],
    thumbnail: '/thumbnails/tcga-breast.jpg'
  },
  {
    id: '2',
    title: 'Multi-organ Histology Atlas',
    description: 'Large-scale multi-organ histology dataset with expert annotations',
    author: {
      name: 'NIH Research Team',
      avatar: '/avatars/nih.jpg'
    },
    stats: {
      size: '78.5 GB',
      samples: 28934,
      downloads: 567,
      stars: 2,
      updatedAt: '2025-08-28'
    },
    tags: ['Multi-organ', 'Histology', 'Atlas', 'Annotations'],
    thumbnail: '/thumbnails/multi-organ-atlas.jpg'
  },
  {
    id: '3',
    title: 'Kidney Pathology Collection',
    description: 'Specialized kidney pathology dataset with detailed diagnostic labels',
    author: {
      name: 'Mayo Clinic',
      avatar: '/avatars/mayo.jpg'
    },
    stats: {
      size: '23.1 GB',
      samples: 8765,
      downloads: 334,
      stars: 2,
      updatedAt: '2025-08-25'
    },
    tags: ['Kidney', 'Pathology', 'Diagnostics', 'Medical'],
    thumbnail: '/thumbnails/kidney-pathology.jpg'
  },
  {
    id: '4',
    title: 'Neural Tissue Morphology DB',
    description: 'Comprehensive neural tissue morphology database for research',
    author: {
      name: 'Stanford NeuroLab',
      avatar: '/avatars/stanford.jpg'
    },
    stats: {
      size: '34.7 GB',
      samples: 12456,
      downloads: 445,
      stars: 2,
      updatedAt: '2025-08-20'
    },
    tags: ['Neural Tissue', 'Morphology', 'Neuroscience', 'Research'],
    thumbnail: '/thumbnails/neural-morphology.jpg'
  },
  {
    id: '5',
    title: 'Prostate Cancer WSI Collection',
    description: 'Large-scale prostate cancer whole slide image dataset with Gleason scoring',
    author: {
      name: 'Johns Hopkins',
      avatar: '/avatars/johns-hopkins.jpg'
    },
    stats: {
      size: '52.3 GB',
      samples: 18934,
      downloads: 623,
      stars: 2,
      updatedAt: '2025-08-15'
    },
    tags: ['Prostate Cancer', 'WSI', 'Gleason Score', 'Pathology'],
    thumbnail: '/thumbnails/prostate-wsi.jpg'
  },
  {
    id: '6',
    title: 'Skin Lesion Classification Dataset',
    description: 'Dermatological dataset for melanoma and skin lesion classification',
    author: {
      name: 'ISIC Archive',
      avatar: '/avatars/isic.jpg'
    },
    stats: {
      size: '28.9 GB',
      samples: 11245,
      downloads: 758,
      stars: 2,
      updatedAt: '2025-08-12'
    },
    tags: ['Skin Lesion', 'Melanoma', 'Dermatology', 'Classification'],
    thumbnail: '/thumbnails/skin-lesion.jpg'
  },
  {
    id: '7',
    title: 'Liver Pathology Atlas',
    description: 'Comprehensive liver pathology dataset with fibrosis staging annotations',
    author: {
      name: 'European Liver Consortium',
      avatar: '/avatars/elc.jpg'
    },
    stats: {
      size: '41.6 GB',
      samples: 14567,
      downloads: 412,
      stars: 2,
      updatedAt: '2025-08-10'
    },
    tags: ['Liver', 'Pathology', 'Fibrosis', 'Staging'],
    thumbnail: '/thumbnails/liver-atlas.jpg'
  },
  {
    id: '8',
    title: 'Colon Cancer Histopathology',
    description: 'Colorectal cancer histopathology images with detailed annotations',
    author: {
      name: 'Cancer Research UK',
      avatar: '/avatars/cruk.jpg'
    },
    stats: {
      size: '37.2 GB',
      samples: 16789,
      downloads: 534,
      stars: 2,
      updatedAt: '2025-08-08'
    },
    tags: ['Colon Cancer', 'Histopathology', 'Colorectal', 'Annotations'],
    thumbnail: '/thumbnails/colon-cancer.jpg'
  },
  {
    id: '9',
    title: 'Lung Adenocarcinoma Dataset',
    description: 'High-resolution lung adenocarcinoma tissue microarray dataset',
    author: {
      name: 'MD Anderson',
      avatar: '/avatars/mdanderson.jpg'
    },
    stats: {
      size: '29.4 GB',
      samples: 9876,
      downloads: 389,
      stars: 2,
      updatedAt: '2025-08-05'
    },
    tags: ['Lung Cancer', 'Adenocarcinoma', 'Microarray', 'Oncology'],
    thumbnail: '/thumbnails/lung-adeno.jpg'
  }
]

// Utility function to format file size
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function readXGBClasses(filePath: string): Promise<number | null> {
  try {
    
    // Call backend API to analyze the XGB/pickle file and extract classes
    const response = await http.post(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/analyze-file`, {
      file_path: filePath
    });

    if (response.status !== 200) {
      throw new Error(`Analysis API failed: ${response.status}`);
    }

    const result = response.data;
    
    const classesCount = result.analysis?.classes;
    if (classesCount && typeof classesCount === 'number') {
      return classesCount;
    }
    
    console.warn('No classes information found in file analysis');
    return null;
  } catch (error) {
    console.warn('Failed to read XGB classes:', error);
    return null;
  }
}


function ClassifierCard({ classifier, compact = false, onDelete, canDelete = false, onTagClick, onStatsUpdate }: {
  classifier: ClassifierData;
  compact?: boolean;
  onDelete?: (classifierId: string) => void;
  canDelete?: boolean;
  onTagClick?: (tag: string) => void;
  onStatsUpdate?: (classifierId: string, stats: { downloads?: number; stars?: number }) => void;
}) {
  const router = useRouter()
  const [isStarred, setIsStarred] = useState(false)
  const [starCount, setStarCount] = useState(classifier.stats.stars || 0)
  const [downloadCount, setDownloadCount] = useState(classifier.stats.downloads || 0)
  const [isStarring, setIsStarring] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [authorAvatar, setAuthorAvatar] = useState<string | null>(null)
  const [showAllTags, setShowAllTags] = useState(false)
  const [showSuccessToast, setShowSuccessToast] = useState(false)
  const [toastMessage, setToastMessage] = useState({ title: '', message: '' })
  const [showClassifierDetail, setShowClassifierDetail] = useState(false)

  // get latest data from Firebase
  const fetchLatestData = async () => {
    try {
      const response = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${classifier.id}`, {
        method: 'GET'
      });
      
      console.log(`[FIREBASE] Latest data for ${classifier.id}:`, response);
      
      // directly use Firebase returned latest data
      if (response.star_count !== undefined) {
        setStarCount(response.star_count);
      }
      if (response.is_starred !== undefined) {
        setIsStarred(response.is_starred);
      }
      if (response.classifier?.stats?.downloads !== undefined) {
        setDownloadCount(response.classifier.stats.downloads);
      }
      
      // note: here we do not need to update createdAt, because it will not change
    } catch (error) {
      console.warn('Failed to fetch latest data:', error);
    }
  };

  // get data when initializing
  useEffect(() => {
    fetchLatestData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifier.id]);

  // Load author avatar from localStorage
  useEffect(() => {
    const loadAuthorAvatar = () => {
      if (classifier.author.user_id) {
        const savedAvatar = localStorage.getItem(`user_avatar_${classifier.author.user_id}`)
        setAuthorAvatar(savedAvatar)
      }
    }
    loadAuthorAvatar()

    // Listen for localStorage changes
    const handleStorageChange = () => {
      loadAuthorAvatar()
    }
    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('localStorageChanged', handleStorageChange)

    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('localStorageChanged', handleStorageChange)
    }
  }, [classifier.author.user_id])

  // Listen for SSE-driven stats updates
  useEffect(() => {
    const handleStatsUpdate = (event: CustomEvent) => {
      const { classifierId, stats } = event.detail;
      if (classifierId === classifier.id) {
        if (stats.downloads !== undefined) {
          setDownloadCount(stats.downloads);
        }
        if (stats.stars !== undefined) {
          setStarCount(stats.stars);
        }
        // Notify parent component of the update
        if (onStatsUpdate) {
          onStatsUpdate(classifierId, stats);
        }
      }
    };

    window.addEventListener('classifierStatsUpdated', handleStatsUpdate as EventListener);
    
    return () => {
      window.removeEventListener('classifierStatsUpdated', handleStatsUpdate as EventListener);
    };
  }, [classifier.id, onStatsUpdate])

  // Handle star toggle
  const handleStarToggle = async () => {
    if (isStarring) return;

    try {
      setIsStarring(true);
      const newIsStarred = !isStarred;

      console.log(`[STAR] ${newIsStarred ? 'Starring' : 'Unstarring'} classifier ${classifier.id}`);

      // Call API
      const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${classifier.id}/star`, {
        method: newIsStarred ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });

      console.log(`[STAR] API result:`, result);

      if (result.success) {
        // After API succeeds, fetch latest data directly from Firebase
        await fetchLatestData();
        
        // Simplified: no complex localStorage sync needed since data comes directly from Firebase
        
        // Notify parent component to update state
        if (onStatsUpdate) {
          onStatsUpdate(classifier.id, { stars: result.starCount || 0 });
        }
        
        console.log(`[STAR] ✅ Operation completed successfully`);
      } else {
        throw new Error(result.message || 'Star operation failed');
      }
    } catch (error) {
      console.error('[STAR] ❌ Operation failed:', error);
      // On error, also refetch to ensure correct state
      await fetchLatestData();
    } finally {
      setIsStarring(false);
    }
  };

  const handleAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    const username = classifier.author.username || classifier.author.user_id || ''
    if (username) {
      router.push(`/profile/${username}`)
    }
  }

  // Download = Load from community + Save to local file (like nuclei classification save)
  const handleDownloadClassifier = async () => {
    try {
      setIsDownloading(true);
      
      // Show loading state but don't do optimistic update to avoid concurrency issues
      // Let backend handle the real count and fetch it after download
      
      // Use token-based direct download with Electron/browser integration
      const filename = `${classifier.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.tlcls`;
      await downloadCommunityClassifier(classifier.id, filename);
      
      // Polling: fetch detail until downloads increases or timeout
      try {
        const baseline = Number(downloadCount || 0);
        const startedAt = Date.now();
        const timeoutMs = 5000;
        const intervalMs = 300;
        let latest = baseline;
        while (Date.now() - startedAt < timeoutMs) {
          try {
            const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${classifier.id}`, { method: 'GET' });
            latest = Number(result?.classifier?.stats?.downloads ?? latest);
            if (latest > baseline) {
              setDownloadCount(latest);
              // Sync localStorage for user uploads
              if (classifier.id.startsWith('uploaded-')) {
                try {
                  const saved = JSON.parse(localStorage.getItem('userUploadedClassifiers') || '[]');
                  const updated = saved.map((c: any) => c.id === classifier.id ? { ...c, stats: { ...c.stats, downloads: latest } } : c);
                  localStorage.setItem('userUploadedClassifiers', JSON.stringify(updated));
                } catch {}
              }
              if (onStatsUpdate) onStatsUpdate(classifier.id, { downloads: latest });
              break;
            }
          } catch {}
          await new Promise(res => setTimeout(res, intervalMs));
        }
        // If timeout without increase, still set to latest fetched value
        if (latest !== baseline) {
          setDownloadCount(latest);
          if (onStatsUpdate) onStatsUpdate(classifier.id, { downloads: latest });
        }
      } catch (error) {
        console.warn('Download count polling failed:', error);
      }

      // Success notification: rely on existing green download toast from progress handler
      // to avoid duplicate success toasts.

    } catch (e) {
      console.error('Download error:', e);
      
      // If classifier is not found (404), check the specific error
      const status = (e as any)?.status;
      const errorMessage = (e as any)?.message || '';
      
      if (status === 404) {
        if (errorMessage.includes('No download mapping found') || errorMessage.includes('Classifier file not found on disk')) {
          setToastMessage({
            title: 'Download Failed',
            message: `This classifier cannot be downloaded because the file is missing from the server.\n\nPlease contact the classifier owner or try again later.`
          });
        } else if (errorMessage.includes('not found') && canDelete) {
          // Only treat as "deleted" and remove from UI if this is the user's own classifier
          setToastMessage({
            title: 'Classifier Not Found',
            message: `This classifier has been deleted and will be removed from your list.`
          });
          
          // Remove from UI by calling onDelete only for own classifiers
          if (onDelete) {
            onDelete(classifier.id);
          }
        } else {
          setToastMessage({
            title: 'Download Failed',
            message: `This classifier is not available for download.\n\nError: ${errorMessage}`
          });
        }
        setShowSuccessToast(true);
      } else {
        setToastMessage({
          title: 'Download Failed',
          message: `Download failed: ${e instanceof Error ? e.message : 'Unknown error'}\n\nPlease try again later.`
        });
        setShowSuccessToast(true);
      }
    } finally {
      setIsDownloading(false);
    }
  };

  // Delete classifier function
  const handleDeleteClassifier = async () => {
    try {
      setIsDeleting(true);
      
      // Only call the parent onDelete function - let the parent handle backend deletion
      if (onDelete) {
        await onDelete(classifier.id);
      }
      
      setShowDeleteDialog(false);
      
    } catch (error: any) {
      console.error('Delete error:', error);
        toast.error(`Delete failed: ${error.message || 'Unknown error'}\n\nPlease try again later.`);
    } finally {
      setIsDeleting(false);
    }
  };
  
  return (
    <Card className="group hover:shadow-lg transition-all duration-200 cursor-pointer bg-white rounded-lg">
      <CardHeader className={compact ? "p-3" : "p-4"}>
        <CardTitle
          className={`${compact ? 'text-base' : 'text-lg'} font-semibold line-clamp-2 group-hover:text-[#6352a3] transition-colors cursor-pointer`}
          onClick={(e) => {
            e.stopPropagation();
            setShowClassifierDetail(true);
          }}
        >
          {classifier.title}
        </CardTitle>
        <p className={`${compact ? 'text-xs' : 'text-sm'} text-gray-600 line-clamp-2`}>
          {classifier.description}
        </p>
      </CardHeader>
      <CardContent className={compact ? "p-3 pt-0" : "p-4 pt-0"}>
        <div className="flex items-start gap-2 mb-3">
          <Avatar
            onClick={handleAuthorClick}
            className={`${compact ? 'w-5 h-5' : 'w-6 h-6'} cursor-pointer hover:ring-2 hover:ring-[#6352a3] transition-all flex-shrink-0`}
          >
            {authorAvatar ? (
              <Image
                src={authorAvatar}
                alt={classifier.author.name}
                width={24}
                height={24}
                className="w-full h-full object-cover rounded-full"
                onError={() => setAuthorAvatar(null)}
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-[#8275b5] to-blue-500 rounded-full flex items-center justify-center">
                <User className={`${compact ? 'w-2 h-2' : 'w-3 h-3'} text-white`} />
              </div>
            )}
          </Avatar>
          <span
            onClick={handleAuthorClick}
            className={`${compact ? 'text-xs' : 'text-sm'} font-medium cursor-pointer hover:text-[#6352a3] transition-colors break-words min-w-0 flex-1`}
          >
            {classifier.author.name}
          </span>
        </div>
        
        <div className={`flex items-center justify-between ${compact ? 'text-xs' : 'text-xs'} text-gray-500 mb-3`}>
          <div className="flex items-center gap-3">
            {/* <div className="flex items-center gap-1">
              <span className="font-medium">Classes:</span>
              <span>{classifier.stats.classes ?? 'null'}</span>
            </div> */}
            <div className="flex items-center gap-1">
              <span className="font-medium">Size:</span>
              <span>{classifier.stats.size}</span>
            </div>
            <div className="flex items-center gap-1">
              <Download className="w-3 h-3" />
              <span>{downloadCount}</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={handleStarToggle}
            disabled={isStarring}
            className="flex items-center gap-1 hover:bg-yellow-50 rounded-md p-1 -ml-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={isStarred ? 'Remove star' : 'Add star'}
          >
            <Star
              className={`w-4 h-4 transition-colors ${
                isStarred
                  ? 'text-yellow-400 fill-yellow-400'
                  : 'text-gray-400 hover:text-yellow-400'
              } ${isStarring ? 'animate-pulse' : ''}`}
            />
            <span className="text-sm font-medium">
              Stars: {starCount}
              {isStarring && <span className="ml-1 text-xs text-gray-400">...</span>}
            </span>
          </button>
          <div className="text-xs text-gray-500">
            {new Date(classifier.stats.updatedAt).toLocaleDateString()}
          </div>
        </div>
        
        <div className="flex flex-wrap gap-1 mb-3">
          {(() => {
            // Define factory categories locally
            const factoryCategories = [
              { id: 'tissue_segmentation', name: 'Tissue Segmentation' },
              { id: 'cell_segmentation', name: 'Cell Segmentation + Embedding' },
              { id: 'nuclei_classification', name: 'Nuclei Classification' },
              { id: 'code_calculation', name: 'Code Calculation' },
              { id: 'tissue_classification', name: 'Tissue Classification' }
            ];
            
            const modalityTags = ['pathology', 'radiology', 'spatial transcriptomics'];
            
            // Get factory and node info from classifier
            const factoryId = classifier.factory;
            const nodeId = classifier.node;
            
            // Find factory category display name
            const factoryCategory = factoryCategories.find(f => f.id === factoryId);
            const factoryDisplayName = factoryCategory?.name || factoryId;
            
            // Create display tags array - factory first, then node if exists
            const displayTags: Array<{text: string, isFactory: boolean, originalTag: string}> = [];
            
            // Add factory tag (main class)
            displayTags.push({
              text: factoryDisplayName || factoryId || 'Unknown',
              isFactory: true,
              originalTag: factoryDisplayName || factoryId || 'Unknown'
            });

            // Add node tag if exists (sub class)
            if (nodeId && nodeId !== 'undefined' && nodeId !== '' && !(factoryDisplayName || factoryId || 'Unknown').toLowerCase().includes(nodeId.toLowerCase())) {
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
              
              // Factory categories with hierarchical colors
              if (isFactory) {
                if (factoryName.toLowerCase().includes('tissue segmentation')) {
                  return 'bg-blue-100 text-blue-700';
                }
                if (factoryName.toLowerCase().includes('cell segmentation')) {
                  return 'bg-yellow-100 text-yellow-700';
                }
                if (factoryName.toLowerCase().includes('nuclei classification')) {
                  return 'bg-green-100 text-green-700';
                }
                if (factoryName.toLowerCase().includes('code calculation')) {
                  return 'bg-orange-100 text-orange-700';
                }
                if (factoryName.toLowerCase().includes('tissue classification')) {
                  return 'bg-teal-100 text-teal-700';
                }
              } else {
                // Sub-classes with fixed hex colors and transparency

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
            
            const tagsToShow = showAllTags ? displayTags : displayTags.slice(0, compact ? 2 : 3);

            return tagsToShow.map((displayTag, displayIndex) => {
              const colorClass = getHierarchicalColor(displayTag.text, displayTag.isFactory, factoryDisplayName || factoryId || 'Unknown');
              
              return (
                <Badge 
                  key={`classifier-${displayIndex}`}
                  className={`text-xs px-2 py-1 cursor-pointer hover:opacity-80 transition-opacity ${colorClass}`}
                  onClick={() => onTagClick?.(displayTag.text)} // Use individual tag text for filtering
                >
                  {displayTag.text}
                </Badge>
              );
            });
          })()}
          {(() => {
            // Calculate total display tags to show the "+N" badge correctly
            const factoryId = classifier.factory;
            const nodeId = classifier.node;
            const modalityTags = ['pathology', 'radiology', 'spatial transcriptomics'];

            let totalTags = 0;
            if (factoryId && factoryId !== 'undefined') totalTags++;
            if (nodeId && nodeId !== 'undefined' && nodeId !== '') totalTags++;
            totalTags += classifier.tags.filter(t => modalityTags.includes(t.toLowerCase())).length;

            const maxTags = compact ? 2 : 3;

            return totalTags > maxTags && !showAllTags ? (
              <Badge
                variant="outline"
                className="text-xs cursor-pointer hover:bg-gray-100 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAllTags(true);
                }}
              >
                +{totalTags - maxTags}
              </Badge>
            ) : showAllTags && totalTags > maxTags ? (
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
            className="flex-1"
            variant="outline"
            onClick={handleDownloadClassifier}
            disabled={isDownloading}
          >
            {isDownloading ? (
              <>
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white mr-1"></div>
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
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white"></div>
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
                    <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white mr-1"></div>
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
              {/* <div className="text-sm text-gray-500">
                <span className="font-medium">Classes:</span> {classifier.stats.classes ?? 'null'}
              </div> */}
              <div className="text-sm text-gray-500">
                <span className="font-medium">Size:</span> {classifier.stats.size}
              </div>
              <div className="text-sm text-gray-500">
                <span className="font-medium">Author:</span> {classifier.author.name}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Success Toast */}
      <NotificationToast
        isVisible={showSuccessToast}
        title={toastMessage.title}
        message={toastMessage.message}
        onDismiss={() => setShowSuccessToast(false)}
      />
    </Card>
  )
}

function DatasetCard({ dataset }: { dataset: DatasetData }) {
  const router = useRouter()
  const [isStarred, setIsStarred] = useState(false)
  const [starCount, setStarCount] = useState(dataset.stats.stars || 0)
  const [isStarring, setIsStarring] = useState(false)
  const [authorAvatar, setAuthorAvatar] = useState<string | null>(null)

  const handleDatasetStarToggle = async () => {
    if (isStarring) return;

    try {
      setIsStarring(true);
      const newIsStarred = !isStarred;
      const newStarCount = newIsStarred ? starCount + 1 : starCount - 1;

      // Optimistic update
      setIsStarred(newIsStarred);
      setStarCount(newStarCount);

      // Call API
      const result = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/datasets/${dataset.id}/star`, {
        method: newIsStarred ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });

      // Update actual count
      if (result.starCount !== undefined) {
        setStarCount(result.starCount);
      }
    } catch (error) {
      console.error('Dataset star toggle failed:', error);
      // Roll back state
      setIsStarred(isStarred);
      setStarCount(starCount);
    } finally {
      setIsStarring(false);
    }
  };

  // Load author avatar from localStorage
  useEffect(() => {
    const loadAuthorAvatar = () => {
      if (dataset.author.user_id) {
        const savedAvatar = localStorage.getItem(`user_avatar_${dataset.author.user_id}`)
        setAuthorAvatar(savedAvatar)
      }
    }
    loadAuthorAvatar()

    // Listen for localStorage changes
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

  return (
    <Card className="group hover:shadow-lg transition-all duration-200 cursor-pointer bg-white rounded-lg">
      <CardHeader className="p-4">
        <CardTitle className="text-lg font-semibold line-clamp-2 group-hover:text-[#6352a3] transition-colors">
          {dataset.title}
        </CardTitle>
        <p className="text-sm text-gray-600 line-clamp-2">
          {dataset.description}
        </p>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="flex items-center gap-2 mb-3">
          <Avatar
            onClick={handleAuthorClick}
            className="w-6 h-6 cursor-pointer hover:ring-2 hover:ring-[#6352a3] transition-all"
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
              <div className="w-full h-full bg-gradient-to-br from-green-400 to-[#7363ac] rounded-full flex items-center justify-center">
                <Database className="w-3 h-3 text-white" />
              </div>
            )}
          </Avatar>
          <span
            onClick={handleAuthorClick}
            className="text-sm font-medium cursor-pointer hover:text-[#6352a3] transition-colors"
          >
            {dataset.author.name}
          </span>
        </div>
        
        <div className="flex items-center justify-between text-xs text-gray-500 mb-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="font-medium">Size:</span>
              <span>{dataset.stats.size}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="font-medium">Samples:</span>
              <span>{dataset.stats.samples.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-1">
              <Download className="w-3 h-3" />
              <span>{dataset.stats.downloads}</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={handleDatasetStarToggle}
            disabled={isStarring}
            className="flex items-center gap-1 hover:bg-yellow-50 rounded-md p-1 -ml-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={isStarred ? 'Remove star' : 'Add star'}
          >
            <Star
              className={`w-4 h-4 transition-colors ${
                isStarred
                  ? 'text-yellow-400 fill-yellow-400'
                  : 'text-gray-400 hover:text-yellow-400'
              } ${isStarring ? 'animate-pulse' : ''}`}
            />
            <span className="text-sm font-medium">Stars: {starCount}</span>
          </button>
          <div className="text-xs text-gray-500">
            {new Date(dataset.stats.updatedAt).toLocaleDateString()}
          </div>
        </div>
        
        <div className="flex flex-wrap gap-1 mb-3">
          {dataset.tags.slice(0, 3).map((tag, tagIndex) => {
            // Function to get hierarchical colors based on tag content
            const getHierarchicalColor = (displayTag: string) => {
              // Factory categories
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
              
              // Modality tags - purple family with different intensities
              if (displayTag.toLowerCase() === 'pathology') {
                return 'bg-purple-100 text-purple-700';
              }
              if (displayTag.toLowerCase() === 'radiology') {
                return 'bg-purple-200 text-purple-800';
              }
              if (displayTag.toLowerCase() === 'spatial transcriptomics') {
                return 'bg-purple-50 text-purple-600';
              }
              
              // Default for other tags
              return 'bg-gray-100 text-gray-600';
            };
            
            const colorClass = getHierarchicalColor(tag);
            
            return (
              <Badge 
                key={tagIndex}
                className={`text-xs px-2 py-1 ${colorClass}`}
              >
                {tag}
              </Badge>
            )
          })}
          {dataset.tags.length > 3 && (
            <Badge variant="outline" className="text-xs">
              +{dataset.tags.length - 3}
            </Badge>
          )}
        </div>
        
      </CardContent>
    </Card>
  )
}

function FactoryTaskNodeCard({ 
  factory, 
  nodes, 
  nodeInfo, 
  nodesExtended, 
  busy, 
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
  onDelete
}: { 
  factory: string;
  nodes: string[];
  nodeInfo: Record<string, { running: boolean; envName?: string; port?: number; logPath?: string }>;
  nodesExtended: Record<string, any>;
  busy: Record<string, 'activating' | 'deactivating'>;
  onActivate?: (factory: string, node: string) => void;
  onDeactivate?: (node: string) => void;
  onViewClassifiers?: (factory: string, node: string) => void;
  onOpenActivate?: (factory: string, node: string) => void;
  displayName: string;
  nodeClassifierCounts: Record<string, number>;
  userUploadedClassifiers: ClassifierData[];
  realClassifiers: ClassifierData[];
  firebaseClassifiers: FirebaseClassifierData[];
  categoryDisplayNames: Record<string, string>;
  activationStatus: Record<string, 'starting' | 'ready' | 'failed'>;
  failedMeta: Record<string, { logPath?: string; env?: string; port?: number; message?: string }>;
  onShowLogs?: (node: string, meta: { logPath?: string; env?: string; port?: number }) => void;
  isElectron: boolean;
  onDownload?: (node: string) => void;
  installing: boolean;
  activating: boolean;
  onDelete?: (node: string) => void;
}) {
  return (
    <div className="rounded-lg border bg-white p-3 shadow-sm">
      <div className="font-semibold mb-2 text-[#594a93]">
        {displayName}
      </div>
      <div className="flex flex-col gap-2">
        {nodes.map((node) => {
          const info = nodeInfo[node];
          const isActive = !!info;
          const isRunning = !!info?.running;
          const isBusy = !!busy[node];
          const status = activationStatus[node];
          const isStarting = status === 'starting' && !isRunning;
          const stored = nodesExtended?.[node]?.runtime || {};
          const hasPreset = !!(stored?.service_path || stored?.env_name || stored?.port);
          const portDisp = info?.port || stored?.port;
          const initials = node.split(/(?=[A-Z0-9])|[\s_-]/).filter(Boolean).map(w=>w[0]).join('').toUpperCase();
          const statusLabel = status === 'failed'
            ? 'Failed'
            : (isBusy || isStarting
              ? 'Starting'
              : (isActive ? (isRunning ? 'Running' : 'Active') : 'Inactive'));
          const statusClass = status === 'failed'
            ? 'bg-red-100 text-red-700'
            : (isBusy || isStarting
              ? 'bg-amber-100 text-amber-700'
              : (isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'));
          const failureMeta = failedMeta[node];

          // Calculate classifier count based on actual matching classifiers
          const getClassifierCount = (factoryType: string) => {
            // Prefer publicly visible classifiers from Firebase; fallback to local lists if empty
            let sourceList: any[];
            if (firebaseClassifiers && firebaseClassifiers.length > 0) {
              sourceList = firebaseClassifiers;
            } else {
              sourceList = [...userUploadedClassifiers, ...realClassifiers];
            }

            // Normalize to array to avoid union-type filter signature issues
            const sourceListArray: any[] = Array.isArray(sourceList) ? sourceList : [];

            // Deduplicate by id to avoid double counting between sources
            const seenIds = new Set<string>();

            const allClassifiers = sourceListArray.filter((c: any) => {
              if (!c?.id) return false;
              if (seenIds.has(c.id)) return false;
              seenIds.add(c.id);
              return true;
            });
            
            // Map category keys back to factory IDs for matching
            const categoryToFactoryMap: Record<string, string> = {
              'TissueSeg': 'tissue_segmentation',
              'NucleiSeg': 'cell_segmentation', 
              'NucleiClassify': 'nuclei_classification',
              'TissueClassify': 'tissue_classification',
              'Scripts': 'code_calculation'
            };
            
            const factoryId = categoryToFactoryMap[factoryType] || factoryType;
            const factoryDisplayName = categoryDisplayNames[factoryType] || factoryType;
            
            const matchingClassifiers = allClassifiers.filter((classifier: any) => {
              // If node is undefined/empty, fall back to factory-only matching for backward compatibility
              if (!classifier.node || classifier.node === 'undefined' || classifier.node === '') {
                return classifier.factory === factoryId;
              }
              // Otherwise, require both factory and node match
              return classifier.factory === factoryId && classifier.node === node;
            });
            
            return matchingClassifiers.length;
          };
          
          const classifierCount = getClassifierCount(factory);
          
          return (
            <div key={node} className="flex items-center justify-between rounded-md border p-2 bg-white hover:bg-gray-50">
              <div className="flex items-center gap-2" style={{opacity: isActive ? 1 : 0.5}}>
                <span className="inline-flex items-center justify-center h-8 w-8 rounded-md bg-[#6352a3]/10 text-sm font-medium text-[#6352a3]">
                  {initials}
                </span>
                <div className="flex flex-col">
                  <div className="text-sm font-medium">{node}</div>
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusClass}`}>
                      {statusLabel}
                    </span>
                    {portDisp ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">{`localhost:${portDisp}`}</span>
                    ) : null}
                  </div>
                  
                  {/* Always show "Shared classifiers" link for all nodes */}
                  <div className="text-xs mt-1">
                    <button 
                      onClick={() => onViewClassifiers?.(factory, node)}
                      className="text-blue-600 hover:text-blue-700 hover:underline"
                    >
                      Shared classifiers: {classifierCount} - Click to see all
                    </button>
                  </div>
                </div>
              </div>
              {isBusy ? (
                <Button variant="outline" size="sm" disabled className="bg-[#6352a3]/5">
                  <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-[#6352a3] mr-2"></div>
                  Working...
                </Button>
              ) : isRunning ? (
                <div className="flex items-center gap-2">
                  <Button variant="destructive" size="sm" onClick={() => onDeactivate?.(node)}>
                    Deactivate
                  </Button>
                  {(info?.logPath) ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      title="View Logs"
                      onClick={() => onShowLogs?.(node, { logPath: info.logPath, env: info?.envName, port: info?.port })}
                    >
                      <SquareTerminal className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {hasPreset ? (
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={() => {
                        if (activationStatus[node] === 'failed') {
                          onOpenActivate?.(factory, node);
                        } else {
                          onActivate?.(factory, node);
                        }
                      }} 
                      disabled={activating || !!busy[node]}
                      className="bg-[#6352a3] text-white hover:bg-[#594a93]"
                    >
                      {busy[node] === 'activating' || status === 'starting' ? 'Loading...' : 'Activate'}
                    </Button>
                  ) : (
                    isElectron ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onDownload?.(node)}
                        disabled={!!busy[node] || installing}
                        className="bg-[#6352a3] text-white hover:bg-[#594a93]"
                        title="Download prebuilt bundle"
                      >
                        {installing ? 'Installing...' : 'Download'}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenActivate?.(factory, node)}
                        disabled={activating || !!busy[node]}
                        className="bg-[#6352a3] text-white hover:bg-[#594a93]"
                        title="Provide runtime to activate"
                      >
                        Activate
                      </Button>
                    )
                  )}
                  <div className="flex items-center gap-0">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" title="Settings">
                          <Settings className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {(() => {
                          // Only show reset option if bundle actually exists (has been downloaded and is executable)
                          const runtime = (nodesExtended?.[node]?.runtime || {});
                          const hasDownloadedBundle = runtime.bundle_exists === true;
                          const resetLabel = hasDownloadedBundle ? 'Reinstall prebuilt bundle' : 'Reset to prebuilt bundle';
                          return isElectron && hasDownloadedBundle ? (
                            <DropdownMenuItem
                              onClick={() => onDownload?.(node)}
                              disabled={!!busy[node] || installing}
                            >
                              {installing ? 'Installing...' : resetLabel}
                            </DropdownMenuItem>
                          ) : null;
                        })()}
                        {hasPreset ? (
                          <DropdownMenuItem onClick={() => onOpenActivate?.(factory, node)}>
                            Edit
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => onOpenActivate?.(factory, node)}>
                            Activate manually
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => onDelete?.(node)} className="text-red-600 focus:text-red-600">
                          Delete
                        </DropdownMenuItem>
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
          );
        })}
      </div>
    </div>
  )
}

function FactoryClassifierDetail({
  factory,
  node,
  onBack,
  allClassifiers,
  categoryDisplayNames,
  onDeleteClassifier,
  userUploadedClassifiers,
  onStatsUpdate
}: {
  factory: string;
  node: string;
  onBack: () => void;
  allClassifiers: ClassifierData[];
  categoryDisplayNames: Record<string, string>;
  onDeleteClassifier?: (classifierId: string) => void;
  userUploadedClassifiers: ClassifierData[];
  onStatsUpdate?: (classifierId: string, stats: { downloads?: number; stars?: number }) => void;
}) {
  // Search and filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedModalityTags, setSelectedModalityTags] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<'most_stars' | 'most_downloads' | 'recently_upload'>('most_stars');
  const [currentPage, setCurrentPage] = useState(1);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const itemsPerPage = 8;

  // Filter classifiers by factory with correct mapping
  const categoryToFactoryMap: Record<string, string> = {
    'TissueSeg': 'tissue_segmentation',
    'NucleiSeg': 'cell_segmentation',
    'NucleiClassify': 'nuclei_classification',
    'TissueClassify': 'tissue_classification',
    'Scripts': 'code_calculation'
  };

  const factoryId = categoryToFactoryMap[factory] || factory;
  const factoryDisplayName = categoryDisplayNames[factory] || factory;

  // Modality tags for filtering
  const modalityTags = ['Pathology', 'Radiology', 'Spatial Transcriptomics'];

  // Base classifiers filtered by factory/node
  const baseNodeClassifiers = allClassifiers.filter(classifier => {
    // If node is undefined/empty, fall back to factory-only matching for backward compatibility
    if (!classifier.node || classifier.node === 'undefined' || classifier.node === '') {
      return classifier.factory === factoryId;
    }
    // Otherwise, require both factory and node match
    return classifier.factory === factoryId && classifier.node === node;
  });

  // Apply search and tag filters
  const filteredClassifiers = baseNodeClassifiers.filter(classifier => {
    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const matchesSearch =
        classifier.title.toLowerCase().includes(query) ||
        classifier.description.toLowerCase().includes(query) ||
        classifier.author.name.toLowerCase().includes(query);
      if (!matchesSearch) return false;
    }

    // Modality tag filter
    if (selectedModalityTags.length > 0) {
      const hasMatchingTag = selectedModalityTags.some(selectedTag =>
        classifier.tags.some(tag => tag.toLowerCase() === selectedTag.toLowerCase())
      );
      if (!hasMatchingTag) return false;
    }

    return true;
  });

  // Sort classifiers
  const sortedClassifiers = [...filteredClassifiers].sort((a, b) => {
    switch (sortBy) {
      case 'most_stars':
        return (b.stats.stars || 0) - (a.stats.stars || 0);
      case 'most_downloads':
        return (b.stats.downloads || 0) - (a.stats.downloads || 0);
      case 'recently_upload':
        return new Date(b.stats.updatedAt).getTime() - new Date(a.stats.updatedAt).getTime();
      default:
        return 0;
    }
  });

  // Pagination
  const totalPages = Math.ceil(sortedClassifiers.length / itemsPerPage);
  const paginatedClassifiers = sortedClassifiers.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  // Handle tag click
  const handleTagClick = (tag: string) => {
    setSelectedModalityTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
    setCurrentPage(1);
  };

  // Handle clear filters
  const clearFilters = () => {
    setSearchQuery('');
    setSelectedModalityTags([]);
    setCurrentPage(1);
  };

  return (
    <div className="bg-gray-50 h-full overflow-y-auto">
      <div className="container mx-auto px-4 py-6 max-w-7xl">
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold text-gray-900">{node}</h1>
              <div className="flex gap-2">
                <Badge className="bg-blue-100 text-blue-700">
                  {factoryDisplayName}
                </Badge>
              </div>
            </div>
            <Button
              onClick={onBack}
              className="bg-[#6352a3] hover:bg-[#594a93] text-white"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
          </div>
        </div>

        {/* Search and Filter Section */}
        <div className="bg-gray-100 rounded-lg border p-4 mb-6">
          {/* Search Bar */}
          <div className="flex gap-4 mb-4">
            <div className="flex-1">
              <div className="relative w-full">
                <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
                  <Search className="h-4 w-4 text-gray-400" />
                </div>
                <input
                  type="text"
                  placeholder="Search classifiers..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="w-full h-9 py-1.5 pl-10 pr-3 bg-white border border-gray-200 rounded-md text-sm placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-[#6352a3] focus:border-transparent"
                />
              </div>
            </div>

            {/* Sort Dropdown */}
            <div className="relative">
              <Button
                variant="outline"
                onClick={() => setSortMenuOpen(!sortMenuOpen)}
                className="min-w-[160px] justify-between"
              >
                <div className="flex items-center">
                  <ArrowUpDown className="w-4 h-4 mr-2" />
                  {sortBy === 'most_stars' ? 'Most Stars' :
                   sortBy === 'most_downloads' ? 'Most Downloads' : 'Recently Upload'}
                </div>
                <ChevronRight className={`w-4 h-4 transition-transform ${sortMenuOpen ? 'rotate-90' : ''}`} />
              </Button>
              {sortMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-white border rounded-md shadow-lg z-10">
                  {[
                    { value: 'most_stars', label: 'Most Stars' },
                    { value: 'most_downloads', label: 'Most Downloads' },
                    { value: 'recently_upload', label: 'Recently Upload' }
                  ].map((option) => (
                    <button
                      key={option.value}
                      className="block w-full px-4 py-2 text-left hover:bg-gray-50 text-sm"
                      onClick={() => {
                        setSortBy(option.value as any);
                        setSortMenuOpen(false);
                        setCurrentPage(1);
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Modality Tags Filter */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-gray-700">Filter by modality:</span>
            {modalityTags.map((tag) => (
              <button
                key={tag}
                onClick={() => handleTagClick(tag)}
                className={`px-3 py-1 rounded-md text-sm border transition-colors ${
                  selectedModalityTags.includes(tag)
                    ? 'bg-[#6352a3] text-white border-[#6352a3]'
                    : 'bg-white text-gray-700 border-gray-300 hover:border-[#6352a3]'
                }`}
              >
                {tag}
              </button>
            ))}
            {(searchQuery || selectedModalityTags.length > 0) && (
              <button
                onClick={clearFilters}
                className="px-3 py-1 text-sm text-gray-500 hover:text-gray-700"
              >
                Clear all filters
              </button>
            )}
          </div>
        </div>

        {/* Results Summary */}
        <div className="mb-4">
          <p className="text-sm text-gray-600">
            {filteredClassifiers.length === baseNodeClassifiers.length ? (
              `Showing all ${filteredClassifiers.length} classifiers`
            ) : (
              `Showing ${filteredClassifiers.length} of ${baseNodeClassifiers.length} classifiers`
            )}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {paginatedClassifiers.length > 0 ? paginatedClassifiers.map((classifier) => (
            <ClassifierCard
              key={classifier.id}
              classifier={classifier}
              onDelete={onDeleteClassifier}
              canDelete={userUploadedClassifiers.some(c => c.id === classifier.id)}
              onStatsUpdate={onStatsUpdate}
              onTagClick={handleTagClick}
            />
          )) : (
            <div className="col-span-full text-center py-12">
              <Database className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-gray-600 mb-2">
                {baseNodeClassifiers.length === 0 ? 'No classifiers available' : 'No matching classifiers'}
              </h3>
              <p className="text-gray-500">
                {baseNodeClassifiers.length === 0
                  ? 'No classifiers have been uploaded for this node yet.'
                  : 'Try adjusting your search or filter criteria.'
                }
              </p>
              {(searchQuery || selectedModalityTags.length > 0) && (
                <Button
                  onClick={clearFilters}
                  variant="outline"
                  className="mt-4"
                >
                  Clear Filters
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center mt-8 gap-1">
            {/* Previous Button */}
            <button
              onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
              Previous
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
            {currentPage > 4 && totalPages > 6 && (
              <span className="rounded-lg px-2.5 py-1 text-sm text-gray-400 pointer-events-none cursor-default">
                ...
              </span>
            )}

            {/* Pages around current */}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(pageNum => {
                if (pageNum === 1 || pageNum === totalPages) return false;
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
            {currentPage < totalPages - 3 && totalPages > 6 && (
              <span className="rounded-lg px-2.5 py-1 text-sm text-gray-400 pointer-events-none cursor-default">
                ...
              </span>
            )}

            {/* Last page */}
            {totalPages > 1 && (
              <button
                onClick={() => setCurrentPage(totalPages)}
                className={`rounded-lg px-2.5 py-1 text-sm ${
                  currentPage === totalPages
                    ? 'bg-gray-50 font-semibold ring-1 ring-inset ring-gray-200'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {totalPages}
              </button>
            )}

            {/* Next Button */}
            <button
              onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage === totalPages}
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Community() {
  const { userInfo } = useUserInfo();
  const [activeTab, setActiveTab] = useState<'home' | 'factories' | 'datasets'>('home')
  const [selectedTaskNode, setSelectedTaskNode] = useState<TaskNodeData | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(false)
  
  // Factories view state - two levels: 'list' (tasknode list) or 'detail' (classifier detail)
  const [factoriesView, setFactoriesView] = useState<'list' | 'detail'>('list')
  const [selectedFactoryNode, setSelectedFactoryNode] = useState<string>('')
  
  // Real data from backend
  const [categories, setCategories] = useState<Record<string, string[]>>({});
  const [nodeInfo, setNodeInfo] = useState<Record<string, { running: boolean; envName?: string; port?: number; logPath?: string }>>({});
  const [nodesExtended, setNodesExtended] = useState<Record<string, any>>({});
  const [categoryDisplayNames, setCategoryDisplayNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, 'activating' | 'deactivating'>>({});
  const [activating, setActivating] = useState(false);
  const [nodeClassifierCounts, setNodeClassifierCounts] = useState<Record<string, number>>({});
  const [activationStatus, setActivationStatus] = useState<Record<string, 'starting' | 'ready' | 'failed'>>({});
  const [failedMeta, setFailedMeta] = useState<Record<string, { logPath?: string; env?: string; port?: number; message?: string }>>({});
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsTarget, setLogsTarget] = useState<{ node: string; path: string; env?: string; port?: number } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [installSteps, setInstallSteps] = useState<Array<{ key: string; label: string; status: 'pending'|'active'|'done'|'failed'; meta?: any }>>([
    { key: 'sign', label: 'Authenticate', status: 'pending' },
    { key: 'download', label: 'Download tasknode', status: 'pending' },
    { key: 'verify', label: 'Verify tasknode', status: 'pending' },
    { key: 'unpack', label: 'Unpack to storage', status: 'pending' },
    { key: 'persist', label: 'Persist tasknode', status: 'pending' },
    { key: 'activate', label: 'Activate tasknode', status: 'pending' },
    { key: 'ready', label: 'Ready', status: 'pending' },
  ]);
  const [installId, setInstallId] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState({ percent: 0, text: '' });
  const [installing, setInstalling] = useState(false);
  const installEventSrc = useRef<EventSource | null>(null);
  const activationStreams = useRef<Record<string, EventSource | null>>({});
  const downloadToastIdRef = useRef<string | null>(null);
  const downloadStateRef = useRef<{ received: number; total: number; url?: string }>({ received: 0, total: 0 });
  
  // Upload classifier states
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadDescription, setUploadDescription] = useState('');
  const [uploadFilePath, setUploadFilePath] = useState('');
  const [uploadingClassifier, setUploadingClassifier] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [selectedFactory, setSelectedFactory] = useState<string>('');
  const [selectedSubCategory, setSelectedSubCategory] = useState<string>('');
  const [selectedUploadModalityTags, setSelectedUploadModalityTags] = useState<string[]>([]);
  const [uploadFile_, setUploadFile_] = useState<File | null>(null);
  
  
  // Real classifiers state
  const [realClassifiers, setRealClassifiers] = useState<ClassifierData[]>([]);
  const [userUploadedClassifiers, setUserUploadedClassifiers] = useState<ClassifierData[]>([]);
  const [firebaseClassifiers, setFirebaseClassifiers] = useState<FirebaseClassifierData[]>([]);
  const [loadingClassifiers, setLoadingClassifiers] = useState(false);
  const [loadingFirebaseClassifiers, setLoadingFirebaseClassifiers] = useState(false);
  
  // Factory categories for classifier tagging
  const factoryCategories = [
    { id: 'tissue_segmentation', name: 'Tissue Segmentation', description: 'Advanced tissue segmentation tools and models' },
    { id: 'cell_segmentation', name: 'Cell Segmentation + Embedding', description: 'Cell-level segmentation with embedding generation' },
    { id: 'nuclei_classification', name: 'Nuclei Classification', description: 'Nuclei classification and analysis tools' },
    { id: 'code_calculation', name: 'Code Calculation', description: 'Code-based calculation and analysis tools' },
    { id: 'tissue_classification', name: 'Tissue Classification', description: 'Multi-organ tissue classification systems' }
  ];

  // Modality tags
  const modalityTags = [
    'Pathology',
    'Radiology',
    'Spatial Transcriptomics'
  ];
  
  // Classifiers search and sort states
  const [classifierSearch, setClassifierSearch] = useState('');
  const [downloadUI, setDownloadUI] = useState<{ active: boolean; receivedBytes: number; totalBytes: number; percent: number; state: string; filePath?: string; url?: string }>({
    active: false,
    receivedBytes: 0,
    totalBytes: 0,
    percent: 0,
    state: '',
    filePath: undefined,
    url: undefined,
  });
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [classifierSort, setClassifierSort] = useState<'most_stars' | 'most_downloads' | 'recently_upload'>('most_stars');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  
  // Datasets search and sort states
  const [datasetSearch, setDatasetSearch] = useState('');

  // Tag handling functions
  const handleTagClick = (tag: string) => {
    setSelectedTags(prev => 
      prev.includes(tag) 
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    );
    setCurrentPage(1);
  };

  const handleUploadModalityTagClick = (tag: string) => {
    setSelectedUploadModalityTags(prev => 
      prev.includes(tag) 
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    );
  };

  const [datasetSort, setDatasetSort] = useState<'most_stars' | 'most_downloads' | 'recently_upload'>('most_stars');
  
  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(8); // Show 8 per page
  const [datasetCurrentPage, setDatasetCurrentPage] = useState(1);
  
  // Activation dialog state (migrated from AIModelZoo)
  const [activateOpen, setActivateOpen] = useState(false);
  const [activateFactory, setActivateFactory] = useState<string>('');
  const [activateNode, setActivateNode] = useState<string>('');
  const [servicePath, setServicePath] = useState('');
  const [envName, setEnvName] = useState('');
  const [envOptions, setEnvOptions] = useState<string[]>([]);
  const [port, setPort] = useState('');
  const [desc, setDesc] = useState('');

  // Backend API functions
  const fetchFactories = async () => {
    try {
      const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_factory_models`);
      const data = resp.data;
      if (data.code === 0) setCategories(data.data || {});
    } catch (e) { console.error(e); }
  };

  const fetchRunning = async (): Promise<Record<string, { running: boolean; envName?: string; port?: number; logPath?: string }>> => {
    try {
      const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`);
      const data = resp.data;
      const nodes = data?.data?.nodes || {};
      const info: Record<string, { running: boolean; envName?: string; port?: number; logPath?: string }> = {};
      Object.entries(nodes).forEach(([name, meta]: any) => {
        info[name] = { running: !!meta?.running, envName: meta?.env_name, port: meta?.port, logPath: meta?.log_path };
      });
      setNodeInfo(info);
      return info;
    } catch (e) { console.error(e); return {}; }
  };

  const fetchNodesExtended = async () => {
    try {
      const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_nodes_extended`);
      const data = resp.data;
      const nodes = data?.data?.nodes || {};
      const catMap = data?.data?.category_map || {};
      const catNames = data?.data?.category_display_names || {};
      if (Object.keys(catMap).length) setCategories(catMap);
      setNodesExtended(nodes);
      setCategoryDisplayNames(catNames);
    } catch (e) { console.error(e); }
  };

  const fetchNodeClassifierCounts = async () => {
    try {
      const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_node_classifier_counts`);
      const data = resp.data;
      if (data.code === 0 && data.data) {
        setNodeClassifierCounts(data.data);
        return;
      }
      throw new Error(`HTTP ${resp.status}`);
    } catch (e) { 
      // Fallback to mock data if API doesn't exist yet
      setNodeClassifierCounts({});
    }
  };

  const fetchBundlesCatalog = async () => {
    try {
      const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/bundles/catalog`);
      const data = resp.data;
      return (data?.data?.bundles || []) as Array<any>;
    } catch (e) {
      console.error(e);
      return [];
    }
  };

  const openInstallModal = () => setInstallOpen(true);

  const resetInstallUI = () => {
    setInstallSteps([
      { key: 'sign', label: 'Authenticate', status: 'pending' },
      { key: 'download', label: 'Download tasknode', status: 'pending' },
      { key: 'verify', label: 'Verify tasknode', status: 'pending' },
      { key: 'unpack', label: 'Unpack to storage', status: 'pending' },
      { key: 'persist', label: 'Persist tasknode', status: 'pending' },
      { key: 'activate', label: 'Activate tasknode', status: 'pending' },
      { key: 'ready', label: 'Ready', status: 'pending' },
    ]);
    setInstallProgress({ percent: 0, text: '' });
  };

  const startInstall = async (bundle: any) => {
    try {
      if (installing) {
        toast.info('Another installation is already in progress');
        return;
      }
      setInstalling(true);
      resetInstallUI();
      openInstallModal();
      // Guard against undefined bundle fields
      const installName = (bundle && (bundle.display_name || bundle.model_name)) || 'Tasknode';
      toast.info(`Installing ${installName}`, {
        duration: Infinity,
        action: {
          label: 'View details',
          onClick: () => setInstallOpen(true),
        }
      } as any);
      const body = {
        model_name: (bundle && bundle.model_name) || 'ClassificationNode',
        gcs_uri: bundle?.gcs_uri,
        filename: bundle?.filename,
        entry_relative_path: (bundle && bundle.entry_relative_path) || 'main',
        size_bytes: (bundle && bundle.size_bytes) || null,
        sha256: (bundle && bundle.sha256) || null,
      };
      const resp = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/bundles/install`, body);
      const data = resp.data;
      if (data?.code !== 0) {
        toast.error('Failed to start install', { description: data?.message || 'Unknown error' } as any);
        setInstalling(false);
        return;
      }
      const id = data?.data?.install_id as string;
      setInstallId(id);
      if (installEventSrc.current) {
        try { installEventSrc.current.close(); } catch {}
        installEventSrc.current = null;
      }
      const es = new EventSource(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/bundles/install/events?install_id=${encodeURIComponent(id)}`);
      installEventSrc.current = es;
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data || '{}');
          const step = payload?.step as string | undefined;
          const status = payload?.status as string | undefined;
          const rcv = Number(payload?.received_bytes || 0);
          const tot = Number(payload?.total_bytes || 0);
          if (step) {
            const order = ['sign','download','verify','unpack','persist','activate','ready'];
            setInstallSteps(prev => prev.map(s => {
              const si = order.indexOf(s.key);
              const ci = order.indexOf(step);
              if (si < ci) return { ...s, status: s.status === 'failed' ? 'failed' : 'done' };
              if (s.key === step) return { ...s, status: status === 'failed' ? 'failed' : (status === 'done' ? 'done' : 'active') };
              return { ...s, status: s.status === 'failed' ? 'failed' : 'pending' };
            }));
          }
          if (step === 'download' && tot > 0) {
            const pct = Math.floor((rcv / tot) * 100);
            setInstallProgress({ percent: pct, text: `${Math.floor(rcv/1048576)} / ${Math.floor(tot/1048576)} MB` });
          }
          if (status === 'done') {
            toast.success('Installation complete');
            fetchRunning();
            fetchNodesExtended();
            setInstalling(false);
            try { es.close(); } catch {}
            installEventSrc.current = null;
          }
          if (status === 'failed') {
            toast.error('Installation failed', { description: payload?.message || 'Unknown error' } as any);
            setInstalling(false);
            try { es.close(); } catch {}
            installEventSrc.current = null;
          }
        } catch (err) {
          console.error('Install SSE parse error', err);
        }
      };
      es.onerror = () => {
        try { es.close(); } catch {}
        installEventSrc.current = null;
        setInstalling(false);
      };
    } catch (e) {
      console.error(e);
      toast.error('Failed to start install');
      setInstalling(false);
    }
  };

  const subscribeActivation = (nodeName: string) => {
    try {
      const existing = activationStreams.current[nodeName];
      if (existing) {
        try { existing.close(); } catch {}
        delete activationStreams.current[nodeName];
      }
      const url = `${AI_SERVICE_API_ENDPOINT}/tasks/v1/activation/events?model=${encodeURIComponent(nodeName)}`;
      const es = new EventSource(url);
      activationStreams.current[nodeName] = es;
      es.onmessage = async (ev) => {
        try {
          const payload = JSON.parse(ev.data || '{}');
          const status = payload?.status;
          const data = payload?.data || {};
          if (status === 'starting') {
            setActivationStatus((prev) => ({ ...prev, [nodeName]: 'starting' }));
          }
          if (status === 'failed') {
            const logPath = data?.log_path;
            toast.error(`Activation failed for ${nodeName}`, {
              description: data?.message || 'Registration failed. Check setup logs.',
              action: logPath ? {
                label: 'View logs',
                onClick: () => {
                  setLogsTarget({ node: nodeName, path: logPath, env: data?.env_name, port: data?.port });
                  setLogsOpen(true);
                }
              } : undefined,
            } as any);
            await fetchRunning();
            setBusy((prev) => { const { [nodeName]: _, ...rest } = prev; return rest; });
            setActivationStatus((prev) => ({ ...prev, [nodeName]: 'failed' }));
            setFailedMeta((prev) => ({ ...prev, [nodeName]: { logPath, env: data?.env_name, port: data?.port, message: data?.message } }));
            try { es.close(); } catch {}
            delete activationStreams.current[nodeName];
          } else if (status === 'ready') {
            await fetchRunning();
            await fetchNodesExtended();
            setBusy((prev) => { const { [nodeName]: _, ...rest } = prev; return rest; });
            setActivationStatus((prev) => ({ ...prev, [nodeName]: 'ready' }));
            try { es.close(); } catch {}
            delete activationStreams.current[nodeName];
          }
        } catch (err) {
          console.error('[Community] activation SSE parse error', err);
        }
      };
      es.onerror = () => {
        try { es.close(); } catch {}
        delete activationStreams.current[nodeName];
      };
    } catch (err) {
      console.error('[Community] subscribeActivation error', err);
    }
  };

  useEffect(() => {
    const handler = (payload: any) => {
      try {
        if (!payload) return;
        const { state, receivedBytes, totalBytes, url, filePath } = payload || {};
        if (state === 'progressing') {
          const percent = totalBytes ? Math.floor((receivedBytes / totalBytes) * 100) : 0;
          setDownloadUI({ active: true, receivedBytes: receivedBytes || 0, totalBytes: totalBytes || 0, percent, state: 'progressing', url });
        }
        if (state === 'completed') {
          setDownloadUI(prev => ({ ...prev, active: false, state: 'completed', filePath }));
          toast.success('Download completed', { description: filePath ? `Saved to: ${filePath}` : undefined } as any);
        }
        if (state === 'interrupted' || state === 'cancelled' || state === 'failed') {
          setDownloadUI(prev => ({ ...prev, active: false, state: String(state || '') }));
          toast.error('Download interrupted');
        }
      } catch (err) {
        console.error('Download progress handler error', err);
      }
    };
    (window as any).electron?.on?.('download-progress', handler);
    return () => {
      try { (window as any).electron?.off?.('download-progress', handler); } catch {}
    };
  }, []);


  useEffect(() => {
    const onRefresh = () => {
      fetchFactories();
      fetchNodesExtended();
      fetchRunning();
    };
    window.addEventListener('model-zoo-refresh', onRefresh as any);
    return () => window.removeEventListener('model-zoo-refresh', onRefresh as any);
  }, []);

  useEffect(() => {
    return () => {
      Object.values(activationStreams.current).forEach((es) => { try { es?.close(); } catch {} });
      activationStreams.current = {};
      if (installEventSrc.current) {
        try { installEventSrc.current.close(); } catch {}
        installEventSrc.current = null;
      }
    };
  }, []);

  // Load public classifiers from Firebase
  const loadFirebaseClassifiers = async () => {
    try {
      setLoadingFirebaseClassifiers(true);
      const response = await classifiersService.getPublicClassifiers();
      if (response.success) {
        // Dashboard page
        const baseList = response.classifiers || [];
        try {
          // 1) Fetch a de-duplicated set of author IDs
          const ownerIds = Array.from(new Set((baseList || []).map((x: any) => x.ownerId).filter(Boolean)));
          // 2) Request public profiles in parallel (prefer name, avatar, organization)
          const ownerProfiles: Record<string, any> = {};
          await Promise.all(ownerIds.map(async (uid) => {
            try {
              const p = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/users/v1/public_profile/${uid}`, { method: 'GET' });
              ownerProfiles[uid] = p || {};
              // Persist preferred name and avatar to localStorage for immediate card/other-page reads
              if (p?.preferred_name) {
                try { localStorage.setItem(`preferred_name_${uid}`, p.preferred_name); } catch {}
              }
              if (p?.avatar_url) {
                try { localStorage.setItem(`user_avatar_${uid}`, p.avatar_url); } catch {}
              }
            } catch {}
          }));

          // 3) Fetch classifier details (stars/downloads)
          const detailed = await Promise.all(
            baseList.map(async (c: any) => {
              try {
                const detail = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${c.id}`, { method: 'GET' });
                const stars = detail?.star_count ?? c?.stats?.stars ?? 0;
                const downloads = detail?.classifier?.stats?.downloads ?? c?.stats?.downloads ?? 0;
                const isStarred = detail?.is_starred ?? false;

                const profile = ownerProfiles[c.ownerId] || {};
                const preferredName = profile?.preferred_name;
                const avatarUrl = profile?.avatar_url;

                return {
                  ...c,
                  // Enhanced author display
                  user_name: preferredName || c.user_name,
                  author_display: preferredName || undefined,
                  author_avatar_url: avatarUrl || undefined,
                  // Sync model field from detailed response if it exists
                  ...(detail.classifier?.model && { model: detail.classifier.model }),
                  stats: {
                    ...(c.stats || {}),
                    stars,
                    downloads,
                  },
                  // Add user star status
                  is_starred: isStarred,
                };
              } catch (_) {
                const profile = ownerProfiles[c.ownerId] || {};
                return {
                  ...c,
                  author_display: profile?.preferred_name || undefined,
                  author_avatar_url: profile?.avatar_url || undefined,
                };
              }
            })
          );
          setFirebaseClassifiers(detailed);
          console.log(`Loaded ${detailed.length} public classifiers from Firebase (with user profiles)`);
        } catch (_) {
          setFirebaseClassifiers(baseList);
          console.log(`Loaded ${baseList.length} public classifiers from Firebase`);
        }
      }
    } catch (error) {
      console.error('Failed to load Firebase classifiers:', error);
    } finally {
      setLoadingFirebaseClassifiers(false);
    }
  };


  useEffect(() => {
    setLoading(true);
    fetchFactories();
    fetchRunning();
    fetchNodesExtended();
    fetchNodeClassifierCounts();
    fetchRealClassifiers();
    loadUserUploadedClassifiers();
    loadFirebaseClassifiers();
    fetchBundlesCatalog();
    
    // Simple loading timeout since we can't easily track all async operations
    setTimeout(() => setLoading(false), 2000);
    
    // fetch conda envs
    (async () => {
      try {
        const resp = await http.get(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_conda_envs`);
        const data = resp.data;
        const envs = data?.data?.envs || [];
        setEnvOptions(envs);
      } catch (e) { console.error(e); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to backend SSE for real-time community updates
  useEffect(() => {
    try {
      // Attach auth token via query string for SSE (since EventSource can't set headers)
      (async () => {
        try {
          const { getAuthToken } = await import('@/utils/authToken');
          const token = await getAuthToken();
          const url = `${CTRL_SERVICE_API_ENDPOINT}/community/v1/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
          const es = new EventSource(url);

      const handleCreated = (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          console.log('SSE: Classifier created', payload);
          loadFirebaseClassifiers();
          loadUserUploadedClassifiers(); // Refresh user classifiers too
        } catch (error) {
          console.warn('SSE create event handling error:', error);
          loadFirebaseClassifiers();
        }
      };
      const handleUpdated = (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          console.log('SSE: Classifier updated', payload);
          loadFirebaseClassifiers();
          loadUserUploadedClassifiers(); // Refresh user classifiers too
        } catch (error) {
          console.warn('SSE update event handling error:', error);
          loadFirebaseClassifiers();
        }
      };
      const handleDeleted = (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          const deletedId = payload?.id;
          
          if (deletedId) {
            console.log(`SSE: Classifier ${deletedId} was deleted, syncing states`);
            
            // Remove from all classifier states immediately
            setUserUploadedClassifiers(prev => prev.filter(c => c.id !== deletedId));
            setRealClassifiers(prev => prev.filter(c => c.id !== deletedId));
            setFirebaseClassifiers(prev => prev.filter(c => c.id !== deletedId));
            
            // Update localStorage
            const currentClassifiers = JSON.parse(localStorage.getItem('userUploadedClassifiers') || '[]');
            const updatedClassifiers = currentClassifiers.filter((c: any) => c.id !== deletedId);
            localStorage.setItem('userUploadedClassifiers', JSON.stringify(updatedClassifiers));
            window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedClassifiers' } }));
          }
          
          // Also refresh Firebase list to be safe
          loadFirebaseClassifiers();
        } catch (error) {
          console.warn('SSE delete event handling error:', error);
          // Fallback to full reload
          loadFirebaseClassifiers();
          loadUserUploadedClassifiers();
        }
      };
      const handleDownloaded = (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          const { id: classifierId, downloads: newDownloadCount } = payload;
          
          if (classifierId && typeof newDownloadCount === 'number') {
            console.log(`SSE: Classifier ${classifierId} downloaded, new count: ${newDownloadCount}`);
            
            // Update Firebase classifiers state
            setFirebaseClassifiers(prev => 
              prev.map(c => 
                c.id === classifierId 
                  ? { ...c, stats: { ...c.stats, downloads: newDownloadCount } }
                  : c
              )
            );
            
            // Update user uploaded classifiers state
            setUserUploadedClassifiers(prev => 
              prev.map(c => 
                c.id === classifierId 
                  ? { ...c, stats: { ...c.stats, downloads: newDownloadCount } }
                  : c
              )
            );
            
            // Update localStorage for user uploads
            if (classifierId.startsWith('uploaded-')) {
              try {
                const saved = JSON.parse(localStorage.getItem('userUploadedClassifiers') || '[]');
                const updated = saved.map((c: any) => 
                  c.id === classifierId 
                    ? { ...c, stats: { ...c.stats, downloads: newDownloadCount } } 
                    : c
                );
                localStorage.setItem('userUploadedClassifiers', JSON.stringify(updated));
              } catch (err) {
                console.warn('Failed to update localStorage for download count:', err);
              }
            }
            
            // Trigger onStatsUpdate callback if available
            // This is a bit tricky since we don't have direct access to the callback here
            // We'll use a custom event as a workaround
            window.dispatchEvent(new CustomEvent('classifierStatsUpdated', { 
              detail: { classifierId, stats: { downloads: newDownloadCount } }
            }));
          }
        } catch (error) {
          console.warn('SSE download event handling error:', error);
        }
      };
      const handleError = () => {
        // Let EventSource auto-reconnect; optional logging only
      };

          es.addEventListener('classifier.created', handleCreated as any);
          es.addEventListener('classifier.updated', handleUpdated as any);
          es.addEventListener('classifier.deleted', handleDeleted as any);
          es.addEventListener('classifier.downloaded', handleDownloaded as any);
          es.addEventListener('error', handleError as any);

          const cleanup = () => {
            try { es.close(); } catch {}
          };
          // Store cleanup on window symbol to ensure we can close on unmount
          (window as any).__community_sse_cleanup__ = cleanup;
        } catch {}
      })();

      return () => {
        try {
          const cleanup = (window as any).__community_sse_cleanup__;
          if (typeof cleanup === 'function') cleanup();
        } catch {}
      };
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Monitor user info changes and refresh classifiers when profile is updated
  useEffect(() => {
    if (userInfo) {
      loadUserUploadedClassifiers(); // Reload localStorage data which should now have updated names
    }
  }, [userInfo]);

  // Load user uploaded classifiers from localStorage
  const loadUserUploadedClassifiers = async () => {
    try {
      const savedClassifiers = localStorage.getItem('userUploadedClassifiers');
      if (savedClassifiers) {
        const parsedClassifiers = JSON.parse(savedClassifiers);

        // Update classifiers with latest stats from backend
        const { communityService } = await import('@/services/community.service');
        const { CTRL_SERVICE_API_ENDPOINT } = await import('@/constants/config');
        const { apiFetch } = await import('@/utils/apiFetch');
        const updatedClassifiers = [];
        const removedIds: string[] = [];

        for (const classifier of parsedClassifiers) {
          try {
            // Use apiFetch with proper authentication
            const details = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/${classifier.id}`, {
              method: 'GET'
            });
            
            const updatedClassifier = {
              ...classifier,
              // Sync model field from Firebase if it exists
              ...(details.classifier?.model && { model: details.classifier.model }),
              stats: {
                ...classifier.stats,
                downloads: details.classifier?.stats?.downloads || classifier.stats.downloads || 0,
                // Prefer Firebase star_count to ensure accurate, up-to-date stars
                stars: (details.star_count !== undefined ? details.star_count : (details.classifier?.stats?.stars)) || classifier.stats.stars || 0,
              }
            };
            updatedClassifiers.push(updatedClassifier);
          } catch (error) {
            const status = (error as any)?.status;
            if (status === 404) {
              // Check if this is a recently uploaded classifier (within last 5 minutes)
              const now = Date.now();
              const classifierAge = now - parseInt(classifier.id.replace('uploaded-', ''));
              const fiveMinutes = 5 * 60 * 1000;
              
              if (classifierAge < fiveMinutes) {
                // Recently uploaded, might still be syncing to Firebase - keep it
                console.log(`Keeping recently uploaded classifier that's still syncing: ${classifier.id}`);
                updatedClassifiers.push(classifier);
              } else {
                // Old classifier that's genuinely deleted - remove it
                console.log(`Cleaning up deleted classifier: ${classifier.id}`);
                removedIds.push(classifier.id);
                continue; // skip adding
              }
            } else {
              // Other errors, keep the classifier with original stats
              updatedClassifiers.push(classifier);
            }
          }
        }

        setUserUploadedClassifiers(updatedClassifiers);

        // Update localStorage: remove 404 items, then save
        if (removedIds.length > 0) {
          console.log(`Cleaned up ${removedIds.length} deleted classifiers from localStorage`);
          const filtered = updatedClassifiers.filter((c: any) => !removedIds.includes(c.id));
          localStorage.setItem('userUploadedClassifiers', JSON.stringify(filtered));
          window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedClassifiers' } }));
        } else {
          // Update localStorage with latest stats
          localStorage.setItem('userUploadedClassifiers', JSON.stringify(updatedClassifiers));
        }

      }
    } catch (error) {
      console.error('Error loading user uploaded classifiers:', error);
    }
  };
  
  // Listen localStorage changes to auto-sync user uploaded classifiers
  // Fetch real classifiers from backend
  const fetchRealClassifiers = useCallback(async (silent = false) => {
    // Prevent multiple concurrent calls
    if (loadingClassifiers && !silent) {
      return;
    }
    
    try {
      if (!silent) {
        setLoadingClassifiers(true);
      }
      
      const response = await communityService.getClassifiers({
        limit: 50, // Get more to have enough for pagination
        sort_by: 'updated_at',
        sort_order: 'desc'
      });
      
      if (response && response.classifiers && response.classifiers.length > 0) {
        // Collect all unique user IDs to fetch their current profiles
        const userIds = new Set<string>();
        response.classifiers.forEach((classifier: any) => {
          const userId = classifier.author?.user_id;
          if (userId && userId !== 'anonymous') {
            userIds.add(userId);
          }
        });

        // Fetch current user profiles to get latest preferred_name
        const userProfiles: Record<string, string> = {};
        if (userIds.size > 0) {
          try {
            // Get user profiles from localStorage (which should have the latest preferred_name)
            userIds.forEach(userId => {
              const preferredName = localStorage.getItem(`preferred_name_${userId}`);
              if (preferredName && preferredName !== 'null' && preferredName !== '') {
                userProfiles[userId] = preferredName;
              }
            });
          } catch (error) {
            console.warn('Failed to get user profiles from localStorage:', error);
          }
        }

        // Transform backend format to frontend format
        const transformedClassifiers: ClassifierData[] = response.classifiers.map((classifier: any) => {
          const userId = classifier.author?.user_id;
          const currentPreferredName = userProfiles[userId];
          
          return {
            id: classifier.id,
            title: classifier.title,
            description: classifier.description,
            author: {
              name: currentPreferredName || classifier.author?.display_name || classifier.author?.username || 'Unknown Author',
              avatar: classifier.author?.avatar_url || '/avatars/default.jpg',
              user_id: classifier.author?.user_id || '',
              username: classifier.author?.username || ''
              },
            stats: {
              classes: classifier.classes || null,
              size: classifier.file_size ? `${(classifier.file_size / (1024 * 1024)).toFixed(2)} MB` : 'Unknown',
              downloads: classifier.stats?.downloads || 0,
              stars: classifier.stats?.stars || 0,
              updatedAt: classifier.stats?.updated_at?.split('T')[0] || new Date().toISOString().split('T')[0]
            },
            tags: classifier.tags || [],
            thumbnail: classifier.thumbnail_url || '/thumbnails/default.jpg',
            factory: classifier.factory || '',
            node: classifier.node || ''
          };
        });
        setRealClassifiers(transformedClassifiers);
      } else {
        setRealClassifiers([]);
      }
    } catch (error) {
      if (!silent) {
        console.error('Failed to fetch classifiers:', error);
      }
      // Use empty array instead of mock data to show the upload prompt
      setRealClassifiers([]);
    } finally {
      if (!silent) {
        setLoadingClassifiers(false);
      }
    }
  }, [loadingClassifiers]);

  // Listen localStorage changes to auto-sync user uploaded classifiers
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      try {
        if (!e || e.key === 'userUploadedClassifiers' || (e.key && e.key.startsWith('preferred_name_'))) {
          loadUserUploadedClassifiers();
          // Also refresh real classifiers to update author names
          fetchRealClassifiers(true); // silent refresh
          loadFirebaseClassifiers();
        }
      } catch {}
    };
    const onLocalStorageChanged = (e: any) => {
      try {
        const key = e?.detail?.key;
        if (!key || key === 'userUploadedClassifiers' || (key && key.startsWith('preferred_name_'))) {
          loadUserUploadedClassifiers();
          // Also refresh real classifiers to update author names
          fetchRealClassifiers(true); // silent refresh
          loadFirebaseClassifiers();
        }
      } catch {}
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('localStorageChanged', onLocalStorageChanged);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('localStorageChanged', onLocalStorageChanged);
    };
  }, [fetchRealClassifiers]);

  // Convert real backend data to UI format
  const convertToTaskNodes = (): TaskNodeData[] => {
    const taskNodes: TaskNodeData[] = [];
    
    Object.entries(categories).forEach(([factory, nodes]) => {
      const displayName = categoryDisplayNames[factory] || factory;
      
      const models: ModelData[] = nodes.map(nodeName => {
        const info = nodeInfo[nodeName];
        const extended = nodesExtended[nodeName];
        const runtime = extended?.runtime || {};
        
        let status: 'downloaded' | 'available' | 'installing' = 'available';
        if (busy[nodeName]) {
          status = busy[nodeName] === 'activating' ? 'installing' : 'available';
        } else if (info?.running) {
          status = 'downloaded';
        } else if (runtime?.service_path || runtime?.env_name) {
          status = 'downloaded';
        }

        return {
          id: nodeName,
          name: nodeName,
          size: '2.1 GB', // Placeholder - could be fetched from backend if available
          status,
          classifiers: Math.floor(Math.random() * 5) + 1, // Mock data for now
          isDefault: nodeName.includes('default') || nodeName === nodes[0]
        };
      });

      const taskNodeClassifiers: ClassifierData[] = []; // No mock classifiers

      taskNodes.push({
        id: factory,
        name: displayName,
        category: factory.includes('segment') ? 'Segmentation' : 
                 factory.includes('class') ? 'Classification' : 
                 factory.includes('detect') ? 'Detection' : 'Analysis',
        description: `${displayName} tools and models for tissue analysis`,
        tags: [factory.charAt(0).toUpperCase() + factory.slice(1), 'AI Models'],
        models,
        classifiers: taskNodeClassifiers
      });
    });

    return taskNodes;
  };

  const realTaskNodes = convertToTaskNodes();

  const handleViewClassifiers = (taskNode: TaskNodeData) => {
    setSelectedTaskNode(taskNode)
  }

  const handleBackToFactories = () => {
    setSelectedTaskNode(null)
  }

  const handleViewFactoryClassifiers = (factory: string, node: string) => {
    setSelectedFactoryNode(node)
    setFactoriesView('detail')
  }

  const handleBackToFactoryList = () => {
    setFactoriesView('list')
    setSelectedFactoryNode('')
  }

  const isElectron = typeof window !== 'undefined' && !!(window as any).electron;
  const isPyService = (servicePath || '').trim().toLowerCase().endsWith('.py');
  const hasServicePath = !!(servicePath || '').trim();

  const quickActivate = async (factory: string, node: string) => {
    // One-click activate using stored runtime; fallback to modal if missing
    const runtime = nodesExtended?.[node]?.runtime || {};
    const sp = runtime?.service_path;
    const env = runtime?.env_name;
    const dep = runtime?.dependency_path || '';
    const py = runtime?.python_version || '3.9';
    const prt = runtime?.port;

    const isStoredPy = typeof sp === 'string' && sp.trim().toLowerCase().endsWith('.py');
    if (!sp || (isStoredPy && !(env || dep))) {
      openActivate(factory, node);
      return;
    }

    try {
      setActivating(true);
      setBusy((prev) => ({ ...prev, [node]: 'activating' }));
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
      };
      const resp = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/register_custom_node_async`, body);
      const data = resp.data;
      if (data?.code === 0 && data?.data?.log_path) {
        toast.info(`Starting ${node}...`, {
          description: 'You can watch setup logs while it initializes.',
          action: {
            label: 'View logs',
            onClick: () => {
              setLogsTarget({ node, path: data.data.log_path, env: data.data.env_name, port: prt || runtime?.port });
              setLogsOpen(true);
            }
          }
        } as any);
      }
      if (data.code === 0) {
        subscribeActivation(node);
        setActivationStatus((prev) => ({ ...prev, [node]: 'starting' }));
        setFailedMeta((prev) => { const { [node]: _, ...rest } = prev; return rest; });
        fetchRunning();
      } else {
        console.error('Activation failed:', data.message);
        toast.error(`Activation failed: ${data.message || 'Unknown error'}`);
        setBusy((prev) => { const { [node]: _, ...rest } = prev; return rest; });
      }
    } catch (e) {
      console.error(e);
      toast.error('Activation failed');
      setBusy((prev) => { const { [node]: _, ...rest } = prev; return rest; });
    } finally {
      setActivating(false);
    }
  };

  const openActivate = (factory: string, node: string) => {
    setActivateFactory(factory);
    setActivateNode(node);
    // Prefill from stored runtime when available
    const runtime = nodesExtended?.[node]?.runtime || {};
    const info = nodeInfo[node];
    setServicePath(runtime?.service_path || '');
    setEnvName(runtime?.env_name || '');
    setPort(runtime?.port ? String(runtime.port) : (info?.port ? String(info.port) : ''));
    setDesc('');
    setActivateOpen(true);
  };

  const submitActivate = async () => {
    try {
      setActivating(true);
      setBusy((prev) => ({ ...prev, [activateNode]: 'activating' }));
      setActivateOpen(false);
      const body = {
        model_name: activateNode,
        python_version: '3.9',
        service_path: servicePath,
        dependency_path: '',
        factory: activateFactory,
        description: desc || undefined,
        env_name: envName || undefined,
        port: port ? Number(port) : undefined,
        install_dependencies: false,
      };
      const resp = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/register_custom_node_async`, body);
      const data = resp.data;
      if (data?.code === 0 && data?.data?.log_path) {
        toast.info(`Starting ${activateNode}...`, {
          description: 'You can watch setup logs while it initializes.',
          action: {
            label: 'View logs',
            onClick: () => {
              setLogsTarget({ node: activateNode, path: data.data.log_path, env: data.data.env_name, port: body.port });
              setLogsOpen(true);
            }
          }
        } as any);
      }
      if (data.code === 0) {
        subscribeActivation(activateNode);
        setActivationStatus((prev) => ({ ...prev, [activateNode]: 'starting' }));
        setFailedMeta((prev) => { const { [activateNode]: _, ...rest } = prev; return rest; });
        fetchRunning();
      } else {
        console.error('Activation failed:', data.message);
        toast.error(`Activation failed: ${data.message || 'Unknown error'}`);
        setBusy((prev) => { const { [activateNode]: _, ...rest } = prev; return rest; });
      }
    } catch (e) { 
      console.error('[Community] submitActivate error:', e); 
      toast.error(`Activation failed: ${e instanceof Error ? e.message : 'Network error'}`);
      setBusy((prev) => { const { [activateNode]: _, ...rest } = prev; return rest; });
    } finally {
      setActivating(false);
    }
  };

  const stopNode = async (nodeName: string) => {
    try {
      setBusy((prev) => ({ ...prev, [nodeName]: 'deactivating' }));
      // Derive env name: prefer nodeInfo mapping, else runtime env, else fall back to model_name-derived default
      const info = nodeInfo[nodeName];
      const runtime = nodesExtended?.[nodeName]?.runtime || {};
      const derivedEnv = info?.envName || runtime?.env_name || `${nodeName}_tissuelab_ai_service_tasknode`;
      const resp = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/stop_node_process`, { env_name: derivedEnv });
      const data = resp.data;
      if (data.code === 0) {
        // Poll until node disappears (backend hides stopped nodes)
        const start = Date.now();
        const timeoutMs = 15000;
        while (Date.now() - start < timeoutMs) {
          const latest = await fetchRunning();
          if (!latest[nodeName]) {
            break;
          }
          await new Promise(res => setTimeout(res, 400));
        }
      } else {
        console.error('Stop failed:', data.message);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setBusy((prev) => {
        const { [nodeName]: _, ...rest } = prev;
        return rest;
      });
    }
  };

  const deleteNode = async (nodeName: string) => {
    try {
      setBusy((prev) => ({ ...prev, [nodeName]: 'deactivating' }));
      const resp = await http.post(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/delete_node`, { model_name: nodeName });
      const data = resp.data;
      if (data.code === 0) {
        await fetchFactories();
        await fetchNodesExtended();
        await fetchRunning();
      } else {
        console.error('Delete failed:', data.message);
        toast.error(`Delete failed: ${data.message || 'Unknown error'}`);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setBusy((prev) => {
        const { [nodeName]: _, ...rest } = prev; return rest;
      });
    }
  };

  const handleDownload = async (node: string) => {
    try {
      if (!isElectron) {
        toast.error('Download is only available in the desktop app');
        return;
      }
      // Directly request a signed download URL from ctrl.vlm.ai
      const apiUrl = 'https://ctrl.vlm.ai/api/community/v1/tasknodes/signed-url';
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      const platform = ua.includes('Mac') ? 'darwin' : (ua.includes('Windows') ? 'win' : 'linux');
      const payload = { model_name: node, platform };
      const r = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (r.status === 404) {
        toast.info('No bundle available for your platform yet');
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j?.success || !j?.download_url) {
        throw new Error(j?.message || 'Failed to get signed URL');
      }
      const filename = j?.filename || 'tasknode.tar.gz';
      const url = j.download_url as string;

      // Use Electron to download to Downloads folder automatically
      toast.info('begin to download tasknode...', { duration: 3000 } as any);
      try {
        await (window as any).electron.invoke('download-signed-url', {
          url,
          filename
        });
        toast.success('download started. please unzip the package and click the activate button in the panel to activate.', { duration: 8000 } as any);
      } catch (err) {
        console.error('Electron download failed, fallback to opening URL:', err);
        try {
          window.open(url, '_blank');
          toast.success('download link opened. please unzip the package and click the activate button in the panel to activate.', { duration: 8000 } as any);
        } catch (e2) {
          throw err;
        }
      }
    } catch (e) {
      console.error(e);
      toast.error('Download failed');
    }
  };

  // Upload classifier functions
  const handleSelectClassifierFile = async () => {
    try {
      const isElectron = typeof window !== 'undefined' && (window as any).electron;
      if (isElectron) {
        const result = await (window as any).electron.invoke('open-file-dialog', {
          title: 'Select classifier file to upload',
          filters: [
            { name: 'Classifier Files', extensions: ['tlcls'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        });
        if (result?.filePaths?.length) {
          const filePath = result.filePaths[0];
          setUploadFilePath(filePath);
          try {
          const fileBuffer = await (window as any).electron.invoke('read-file', filePath);
          const fileName = filePath.split(/[\\/]/).pop() || 'classifier';
            const file = new File([fileBuffer], fileName, { type: 'application/octet-stream' });
            setUploadFile_(file);
          } catch (readError) {
            console.error('Error reading file:', readError);
            setUploadFile_(null);
          }
        }
      } else {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.tlcls';
        input.style.display = 'none';
        input.onchange = (e: Event) => {
          const target = e.target as HTMLInputElement;
          const file = target.files?.[0];
          if (file) {
            setUploadFilePath(file.name);
            setUploadFile_(file);
          }
        };
        document.body.appendChild(input);
        input.click();
        document.body.removeChild(input);
      }
    } catch (e) {
      console.error('File selection error:', e);
    }
  };

  const handleUploadClassifier = async () => {
    if (!uploadTitle || !uploadFile_ || !selectedFactory) {
      toast.error('Please provide a title, select a factory category, and choose a classifier file.');
      return;
    }

    try {
      setUploadingClassifier(true);
      
      
      // Step 1: Upload file to storage/classifiers using existing uploadFiles helper
      let filePath: string;
      try {
        const dt = new DataTransfer();
        dt.items.add(uploadFile_);
        const files = dt.files;
        // Use 'classifiers' instead of '../classifiers' to upload to storage/classifiers
        const uploadResponse = await uploadFiles('classifiers', files, () => {} , false);
        const originalFileName = uploadFile_.name.split('\\').pop()?.split('/').pop() || uploadFile_.name;
        
        // Get the actual filename from upload response (UUID-based for classifiers)
        let actualFileName = originalFileName;
        if (uploadResponse?.uploaded_files?.length > 0) {
          actualFileName = uploadResponse.uploaded_files[0].actual_name;
        }
        
        filePath = `classifiers/${actualFileName}`;
      } catch (uploadError: any) {
        console.error('File manager upload error:', uploadError);
        throw new Error(`File upload failed: ${uploadError?.message || 'Unknown error'}`);
      }
      
      // Step 2: Read classes from XGB file
      let classesCount = null;
      try {
        classesCount = await readXGBClasses(filePath);
      } catch (error) {
        console.warn('Could not read classes from XGB file:', error);
      }

      // Step 3: Generate random download_link and save classifier metadata
      const generateDownloadLink = () => {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      };
      
      const downloadLink = generateDownloadLink();
      const factoryCategory = factoryCategories.find(f => f.id === selectedFactory);
      
      // Get preferred name from localStorage
      const preferredName = userInfo?.user_id ? 
        localStorage.getItem(`preferred_name_${userInfo.user_id}`) : null;
      
      // Capitalize first letter of title
      const capitalizedTitle = uploadTitle.charAt(0).toUpperCase() + uploadTitle.slice(1);
      
      // Get user's custom avatar from localStorage
      const userCustomAvatar = userInfo?.user_id
        ? localStorage.getItem(`user_avatar_${userInfo.user_id}`)
        : null;


      const newClassifier: ClassifierData = {
        id: `uploaded-${Date.now()}`,
        title: capitalizedTitle,
        description: uploadDescription || 'User uploaded classifier',
        author: {
          name: preferredName || userInfo?.user_id || 'Anonymous User',
          avatar: userCustomAvatar || '/avatars/default.jpg',
          user_id: userInfo?.user_id || 'anonymous',
          username: userInfo?.user_id || 'anonymous'
        },
        stats: {
          classes: classesCount,
          size: formatFileSize(uploadFile_.size),
          downloads: 0,
          stars: 0,
          updatedAt: new Date().toISOString(),  // Use full ISO timestamp
          createdAt: new Date().toISOString()   // Add creation time
        },
        tags: [...selectedUploadModalityTags],
        thumbnail: '/thumbnails/default.jpg',
        filePath: filePath,
        downloadLink: downloadLink,
        factory: selectedFactory,
        model: selectedSubCategory || '',  // Add explicit model field
        node: selectedSubCategory || ''  // This is the model
      };
      
      // Step 4: Save classifier to Firebase backend
      try {
        const originalFileName = uploadFile_.name.split('\\').pop()?.split('/').pop() || uploadFile_.name;
        const actualFileName = filePath.split('/').pop() || originalFileName; // Extract actual filename from filePath
        
        const mappingResponse = await apiFetch(`${CTRL_SERVICE_API_ENDPOINT}/community/v1/classifiers/register`, {
          method: 'POST',
          body: JSON.stringify({
            classifier_id: newClassifier.id,
            download_link: downloadLink,
            file_name: actualFileName, // Use the actual UUID-based filename
            original_file_name: originalFileName, // Pass the original filename separately
            file_path: filePath,
            title: capitalizedTitle,
            description: uploadDescription || 'User uploaded classifier',
            tags: selectedUploadModalityTags,
            classes_count: classesCount,
            file_size: uploadFile_.size,
            user_id: userInfo?.user_id || 'anonymous',
            factory: selectedFactory,
            model: selectedSubCategory || ''  // Add the model field
          })
        });
        
        if (mappingResponse?.success) {
          console.log('Classifier successfully saved to Firebase');
        } else {
          console.warn('Failed to save classifier to Firebase:', mappingResponse);
        }
      } catch (error) {
        console.warn('Failed to register classifier to Firebase:', error);
        // Don't throw error here as the file upload was successful
      }
      
      // Add to user uploaded classifiers (persistent)
      setUserUploadedClassifiers(prev => [newClassifier, ...prev]);
      
      // Save to localStorage for persistence across sessions
      const savedClassifiers = JSON.parse(localStorage.getItem('userUploadedClassifiers') || '[]');
      savedClassifiers.unshift(newClassifier);
      localStorage.setItem('userUploadedClassifiers', JSON.stringify(savedClassifiers));
      window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedClassifiers' } }));
      
      
      
      // Reset form and close dialog
      setUploadTitle('');
      setUploadDescription('');
      setUploadFilePath('');
      setSelectedFactory('');
      setSelectedSubCategory('');
      setSelectedUploadModalityTags([]);
      setUploadFile_(null);
      setUploadDialogOpen(false);
      
    } catch (e) {
      console.error('Upload error:', e);
      toast.error(`Upload failed: ${e instanceof Error ? e.message : 'Unknown error'}\n\nPlease ensure the classifier file is valid and try again.`);
    } finally {
      setUploadingClassifier(false);
    }
  };

  // Delete classifier function
  const handleDeleteClassifier = async (classifierId: string) => {
    try {
      // Try to delete from Firebase first (for uploaded classifiers)
      if (classifierId.startsWith('uploaded-')) {
        try {
          const deleteResponse = await classifiersService.deleteClassifier(classifierId);
          
          if (deleteResponse.success) {
            console.log('Classifier deleted from Firebase successfully');
            
            // Remove from Firebase classifiers state
            setFirebaseClassifiers(prev => prev.filter(c => c.id !== classifierId));
          } else {
            console.warn('Firebase deletion returned success=false');
            toast.warning('Firebase deletion completed but may not have been successful.');
          }
        } catch (error) {
          console.error('Firebase delete error:', error);
          toast.warning(`Firebase deletion failed: ${error instanceof Error ? error.message : 'Unknown error'}\nThe classifier will still be removed from the local list.`);
        }
      }
      
      // Remove from ALL classifier states to ensure UI consistency
      setUserUploadedClassifiers(prev => prev.filter(c => c.id !== classifierId));
      setRealClassifiers(prev => prev.filter(c => c.id !== classifierId));
      setFirebaseClassifiers(prev => prev.filter(c => c.id !== classifierId));
      
      // Update localStorage
      const updatedUserClassifiers = userUploadedClassifiers.filter(c => c.id !== classifierId);
      localStorage.setItem('userUploadedClassifiers', JSON.stringify(updatedUserClassifiers));
      window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedClassifiers' } }));
      
      console.log(`Classifier ${classifierId} removed from local storage and Firebase`);
      
    } catch (error) {
      console.error('Error in handleDeleteClassifier:', error);
      toast.error('Error occurred while deleting classifier.');
    }
  };

  // Handle stats update from ClassifierCard
  const handleStatsUpdate = (classifierId: string, stats: { downloads?: number; stars?: number }) => {
    // Update user uploaded classifiers
    setUserUploadedClassifiers(prev =>
      prev.map(classifier =>
        classifier.id === classifierId
          ? {
              ...classifier,
              stats: {
                ...classifier.stats,
                ...(stats.downloads !== undefined && { downloads: stats.downloads }),
                ...(stats.stars !== undefined && { stars: stats.stars })
              }
            }
          : classifier
      )
    );
    
    // Also update Firebase classifiers to ensure sorting works correctly
    setFirebaseClassifiers(prev =>
      prev.map(classifier =>
        classifier.id === classifierId
          ? {
              ...classifier,
              stats: {
                ...classifier.stats,
                ...(stats.downloads !== undefined && { downloads: stats.downloads }),
                ...(stats.stars !== undefined && { stars: stats.stars })
              }
            }
          : classifier
      )
    );
  };

  // Filter and sort classifiers based on search and sort criteria
  const getFilteredAndSortedClassifiers = () => {
    const toDateString = (v: any) => {
      try {
        if (!v) return new Date().toISOString();
        if (typeof v === 'object') {
          if (typeof v.seconds === 'number') return new Date(v.seconds * 1000).toISOString();
          if (typeof v._seconds === 'number') return new Date(v._seconds * 1000).toISOString();
          if (typeof v.toDate === 'function') return v.toDate().toISOString();
        }
        const d = new Date(typeof v === 'number' ? v : String(v));
        if (isNaN(d.getTime())) return new Date().toISOString();
        return d.toISOString(); // Return full ISO timestamp, not just the date
      } catch {
        return new Date().toISOString();
      }
    };

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
        classes: fc.classesCount || fc.stats?.classes || 0,
        size: classifiersService.formatFileSize(fc.fileSize || fc.stats?.size),
        downloads: fc.stats?.downloads || 0,
        stars: fc.stats?.stars || 0,
        updatedAt: toDateString(fc.updatedAt),
        createdAt: toDateString(fc.createdAt)  // Add creation time
      },
      tags: fc.tags || [],
      thumbnail: '/thumbnails/default.jpg',
      filePath: fc.localPath,
      downloadLink: fc.downloadLink,
      factory: fc.factory,
      model: fc.model || '', // Include model field from Firebase
      node: fc.model || '' // Use model as node for compatibility
    }));

    // Use only Firebase classifiers to avoid data source conflicts
    // This ensures consistent display names and avoids duplicate/conflicting data
    const sources = [
      ...convertedFirebaseClassifiers
    ];
    // Since we're only using Firebase data, no need for complex merging
    // Just normalize the data and remove duplicates by id
    const uniqueClassifiers = new Map<string, ClassifierData>();
    for (const item of sources) {
      if (!item || !item.id) continue;
      
      // Normalize numeric fields defensively
      const normalized: ClassifierData = {
        ...item,
        stats: {
          ...item.stats,
          downloads: Number(item.stats.downloads || 0),
          stars: Number(item.stats.stars || 0),
          updatedAt: item.stats.updatedAt,
          classes: item.stats.classes === null ? null : Number(item.stats.classes)
        }
      };
      
      // Only keep the first occurrence (Firebase data is already the most up-to-date)
      if (!uniqueClassifiers.has(item.id)) {
        uniqueClassifiers.set(item.id, normalized);
      }
    }
    const allClassifiers = Array.from(uniqueClassifiers.values());
    let filtered = [...allClassifiers];
    
    // Apply search filter
    if (classifierSearch.trim()) {
      const searchTerm = classifierSearch.toLowerCase();
      filtered = filtered.filter(classifier => 
        classifier.title.toLowerCase().includes(searchTerm) ||
        classifier.description.toLowerCase().includes(searchTerm) ||
        classifier.tags.some(tag => tag.toLowerCase().includes(searchTerm)) ||
        classifier.author.name.toLowerCase().includes(searchTerm)
      );
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
        ];
        
        const factoryCategory = factoryCategories.find(f => f.id === classifier.factory);
        const factoryDisplayName = factoryCategory?.name || classifier.factory;
        const nodeId = classifier.node;
        
        return selectedTags.every(selectedTag => {
          // Check if the selected tag matches factory name
          if ((factoryDisplayName || classifier.factory || 'Unknown').toLowerCase() === selectedTag.toLowerCase()) {
            return true;
          }
          
          // Check if the selected tag matches node name
          if (nodeId && nodeId.toLowerCase() === selectedTag.toLowerCase()) {
            return true;
          }
          
          // Check if the selected tag matches any of the classifier's tags
          if (classifier.tags.some(tag => tag.toLowerCase() === selectedTag.toLowerCase())) {
            return true;
          }
          
          return false;
        });
      });
    }
    
    // Apply sorting
    filtered.sort((a, b) => {
      switch (classifierSort) {
        case 'most_stars':
          return b.stats.stars - a.stats.stars; // Higher stars first
        case 'most_downloads':
          return b.stats.downloads - a.stats.downloads; // More downloads first
        case 'recently_upload':
          // Use createdAt instead of updatedAt to sort most recently uploaded classifiers
          const aCreated = new Date(a.stats.createdAt || a.stats.updatedAt).getTime();
          const bCreated = new Date(b.stats.createdAt || b.stats.updatedAt).getTime();
          return bCreated - aCreated; // More recent first
        default:
          return 0;
      }
    });
    
    return filtered;
  };

  // Get paginated classifiers
  const getPaginatedClassifiers = () => {
    const filtered = getFilteredAndSortedClassifiers();
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return filtered.slice(startIndex, endIndex);
  };

  // Calculate total pages
  const getTotalPages = () => {
    const filtered = getFilteredAndSortedClassifiers();
    return Math.ceil(filtered.length / itemsPerPage);
  };

  // Get sort option display text
  const getSortDisplayText = () => {
    switch (classifierSort) {
      case 'most_stars':
        return 'Most stars';
      case 'most_downloads':
        return 'Most downloads';
      case 'recently_upload':
        return 'Recently upload';
      default:
        return 'Most stars';
    }
  };

  // Filter and sort datasets based on search and sort criteria
  const getFilteredAndSortedDatasets = () => {
    let filtered = [...mockDatasets];
    // Apply search filter
    if (datasetSearch.trim()) {
      const searchTerm = datasetSearch.toLowerCase();
      filtered = filtered.filter(dataset => 
        dataset.title.toLowerCase().includes(searchTerm) ||
        dataset.description.toLowerCase().includes(searchTerm) ||
        dataset.tags.some(tag => tag.toLowerCase().includes(searchTerm)) ||
        dataset.author.name.toLowerCase().includes(searchTerm)
      );
    }
    
    // Apply sorting
    filtered.sort((a, b) => {
      switch (datasetSort) {
        case 'most_stars':
          return b.stats.stars - a.stats.stars; // Higher stars first
        case 'most_downloads':
          return b.stats.downloads - a.stats.downloads; // More downloads first
        case 'recently_upload':
          return new Date(b.stats.updatedAt).getTime() - new Date(a.stats.updatedAt).getTime(); // More recent first
        default:
          return 0;
      }
    });
    
    return filtered;
  };

  // Get paginated datasets
  const getPaginatedDatasets = () => {
    const filtered = getFilteredAndSortedDatasets();
    const startIndex = (datasetCurrentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return filtered.slice(startIndex, endIndex);
  };

  // Calculate total pages for datasets
  const getDatasetTotalPages = () => {
    const filtered = getFilteredAndSortedDatasets();
    return Math.ceil(filtered.length / itemsPerPage);
  };

  // Build unified classifiers list for Factories detail view (prefer public Firebase data)
  const allClassifiersForFactories: ClassifierData[] = React.useMemo(() => {
    const safeToIso = (v: any) => {
      try {
        if (!v) return new Date().toISOString();
        if (typeof v === 'object') {
          const t = (v as any).seconds || (v as any)._seconds;
          if (typeof t === 'number') return new Date(t * 1000).toISOString();
        }
        const d = new Date(typeof v === 'number' ? v : String(v));
        if (isNaN(d.getTime())) return new Date().toISOString();
        return d.toISOString();
      } catch {
        return new Date().toISOString();
      }
    };

    // Convert Firebase docs to local ClassifierData format
    const fb: ClassifierData[] = (firebaseClassifiers || []).map((fc) => ({
      id: fc.id,
      title: fc.title,
      description: fc.description,
      author: {
        name: classifiersService.getAuthorDisplay(fc),
        avatar: '/avatars/default.jpg',
        user_id: fc.ownerId,
        username: fc.ownerId,
      },
      stats: {
        classes: (fc as any).classesCount || fc.stats?.classes || 0,
        size: classifiersService.formatFileSize((fc as any).fileSize || fc.stats?.size),
        downloads: fc.stats?.downloads || 0,
        stars: fc.stats?.stars || 0,
        updatedAt: safeToIso((fc as any).updatedAt),
        createdAt: safeToIso((fc as any).createdAt),
      },
      tags: fc.tags || [],
      thumbnail: '/thumbnails/default.jpg',
      filePath: (fc as any).localPath,
      downloadLink: fc.downloadLink,
      factory: fc.factory,
      model: fc.model || '',
      node: fc.model || '',
    }));

    // Merge with local sources and deduplicate by id (prefer Firebase first)
    const merged = [...fb, ...userUploadedClassifiers, ...realClassifiers];
    const byId = new Map<string, ClassifierData>();
    for (const c of merged) {
      if (!c || !c.id) continue;
      if (!byId.has(c.id)) byId.set(c.id, c);
    }
    return Array.from(byId.values());
  }, [firebaseClassifiers, userUploadedClassifiers, realClassifiers]);

  return (
    <div className="bg-gray-50 min-h-screen">
      {/* Fixed Download Panel (bottom-right) */}
      {downloadUI.active && (
        <div className="fixed bottom-4 right-4 z-50 w-[340px] bg-white border border-gray-200 rounded-xl shadow-lg p-4">
          <div className="text-sm font-semibold text-gray-900 mb-1">Downloading bundle…</div>
          <div className="text-xs text-gray-500 mb-2">
            {Math.floor((downloadUI.receivedBytes || 0) / (1024 * 1024))} MB / {Math.max(1, Math.floor((downloadUI.totalBytes || 0) / (1024 * 1024)))} MB
          </div>
          <Progress value={downloadUI.percent} />
        </div>
      )}
      <div className="container mx-auto px-4 py-6 pb-12 max-w-7xl h-full">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Community</h1>
        </div>

        {/* Main Navigation Tabs */}
        <Tabs value={activeTab} onValueChange={(value: any) => setActiveTab(value)} className="h-full">
          <TabsList className="grid w-full max-w-md grid-cols-3 mb-6">
            <TabsTrigger value="home" className="flex items-center gap-2">
              <Home className="w-4 h-4" />
              Home
            </TabsTrigger>
            <TabsTrigger value="factories" className="flex items-center gap-2">
              <Boxes className="w-4 h-4" />
              Factories
            </TabsTrigger>
            <TabsTrigger value="datasets" className="flex items-center gap-2">
              <Database className="w-4 h-4" />
              Datasets
            </TabsTrigger>
          </TabsList>

          {/* Home Tab */}
          <TabsContent value="home" className="h-[calc(100%-120px)] bg-gray-50">
            <div className="space-y-12 pb-16">
              
              {/* Classifiers Section */}
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Star className="w-5 h-5 text-[#6352a3]" />
                    <h2 className="text-xl font-semibold">Classifiers</h2>
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
                          setClassifierSearch(e.target.value);
                          setCurrentPage(1); // Reset to first page when searching
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
                              
                              // For nodes (sub-classes), we need to determine which factory they belong to
                              // Since we don't have that info here, we'll use a smarter approach
                              // Check all classifiers to find which factory this node belongs to
                              const allClassifiersForTagColor = getFilteredAndSortedClassifiers();
                              const matchingClassifier = allClassifiersForTagColor.find(c => c.node === tagText);
                              
                              if (matchingClassifier) {
                                const factoryCategories = [
                                  { id: 'tissue_segmentation', name: 'Tissue Segmentation' },
                                  { id: 'cell_segmentation', name: 'Cell Segmentation + Embedding' },
                                  { id: 'nuclei_classification', name: 'Nuclei Classification' },
                                  { id: 'code_calculation', name: 'Code Calculation' },
                                  { id: 'tissue_classification', name: 'Tissue Classification' }
                                ];
                                
                                const factoryCategory = factoryCategories.find(f => f.id === matchingClassifier.factory);
                                const factoryName = factoryCategory?.name || matchingClassifier.factory;
                                
                                // Return sub-class colors based on factory with fixed hex colors and transparency

                                // Tissue Segmentation nodes - base color #dbe9fe
                                if (factoryName && factoryName.toLowerCase().includes('tissue segmentation')) {
                                  if (tagText === 'MuskEmbedding') return 'bg-[#dbe9fe]/30 text-[#1e40af] border-[#dbe9fe]/50';
                                  if (tagText === 'BiomedParseNode') return 'bg-[#dbe9fe]/60 text-[#1e40af] border-[#dbe9fe]/80';
                                  return 'bg-[#dbe9fe]/90 text-[#1e40af] border-[#dbe9fe]'; // fallback for other nodes
                                }

                                // Cell Segmentation nodes - base color #fef9c3
                                if (factoryName && factoryName.toLowerCase().includes('cell segmentation')) {
                                  if (tagText === 'SegmentationNode') return 'bg-[#fef9c3]/40 text-[#a16207] border-[#fef9c3]/60';
                                  return 'bg-[#fef9c3]/70 text-[#a16207] border-[#fef9c3]/90'; // fallback for other nodes
                                }

                                // Nuclei Classification nodes - base color #d9f9e4
                                if (factoryName && factoryName.toLowerCase().includes('nuclei classification')) {
                                  if (tagText === 'ClassificationNode') return 'bg-[#d9f9e4]/40 text-[#166534] border-[#d9f9e4]/60';
                                  return 'bg-[#d9f9e4]/70 text-[#166534] border-[#d9f9e4]/90'; // fallback for other nodes
                                }

                                // Code Calculation nodes - base color #f5e4cd
                                if (factoryName && factoryName.toLowerCase().includes('code calculation')) {
                                  return 'bg-[#f5e4cd]/40 text-[#c2410c] border-[#f5e4cd]/60'; // fallback for nodes
                                }

                                // Tissue Classification nodes - base color #cbfbf1
                                if (factoryName && factoryName.toLowerCase().includes('tissue classification')) {
                                  return 'bg-[#cbfbf1]/40 text-[#0f766e] border-[#cbfbf1]/60'; // fallback for nodes
                                }
                              }
                              
                              // Default for unknown tags
                              return 'bg-gray-100 text-gray-700 border-gray-200';
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
                      setClassifierSort(value);
                      setCurrentPage(1); // Reset to first page when sorting changes
                    }}>
                      <SelectTrigger className="w-48 bg-white border border-gray-200 rounded-lg shadow-none">
                        <div className="flex items-center gap-2">
                          <ArrowUpDown className="w-4 h-4" />
                          <SelectValue />
                        </div>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="most_stars">Most Stars</SelectItem>
                        <SelectItem value="most_downloads">Most Downloads</SelectItem>
                        <SelectItem value="recently_upload">Recently Upload</SelectItem>
                      </SelectContent>
                    </Select>
                    {/* Upload Button */}
                    <Dialog 
                      open={uploadDialogOpen} 
                      onOpenChange={setUploadDialogOpen}
                    >
                      <DialogTrigger asChild>
                        <Button 
                          size="sm" 
                          className="bg-[#6352a3] hover:bg-[#594a93] text-white"
                        >
                          <Upload className="w-4 h-4 mr-2" />
                          Upload
                        </Button>
                      </DialogTrigger>
                    <DialogContent 
                      className="sm:max-w-[500px]"
                      onOpenAutoFocus={(e) => {
                        e.preventDefault();
                        const titleInput = document.getElementById('title');
                        if (titleInput) {
                          titleInput.focus();
                        }
                      }}
                    >
                      <DialogHeader>
                        <DialogTitle>Upload Classifier</DialogTitle>
                        <DialogDescription>
                          Share your trained TissueLab classifier (.tlcls file) with the community.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="grid gap-4 py-4">
                        <div className="grid grid-cols-4 items-center gap-4">
                          <Label htmlFor="title" className="text-right">
                            Title <span className="text-red-500">*</span>
                          </Label>
                          <Input
                            id="title"
                            className="col-span-3"
                            value={uploadTitle}
                            onChange={(e) => setUploadTitle(e.target.value)}
                            placeholder="e.g., Breast Cancer Nuclei Classifier"
                            disabled={uploadingClassifier}
                          />
                        </div>
                        <div className="grid grid-cols-4 items-center gap-4">
                          <Label htmlFor="factory" className="text-right">
                            Factory <span className="text-red-500">*</span>
                          </Label>
                          <Select value={selectedFactory} onValueChange={setSelectedFactory}>
                            <SelectTrigger className="col-span-3">
                              <SelectValue placeholder="Select factory category" />
                            </SelectTrigger>
                            <SelectContent>
                              {factoryCategories.map((factory) => (
                                <SelectItem key={factory.id} value={factory.id}>
                                  {factory.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid grid-cols-4 items-center gap-4">
                          <Label htmlFor="subcategory" className="text-right text-sm">
                            Model <span className="text-red-500">*</span>
                          </Label>
                          <Select value={selectedSubCategory} onValueChange={setSelectedSubCategory}>
                            <SelectTrigger className="col-span-3">
                              <SelectValue placeholder="Select specific type" />
                            </SelectTrigger>
                              <SelectContent>
                                {(() => {
                                  // Map factory IDs to category keys
                                  const factoryToCategoryMap: Record<string, string> = {
                                    'tissue_segmentation': 'TissueSeg',
                                    'cell_segmentation': 'NucleiSeg',
                                    'nuclei_classification': 'NucleiClassify', 
                                    'tissue_classification': 'TissueClassify',
                                    'code_calculation': 'Scripts'
                                  };
                                  
                                  const categoryKey = factoryToCategoryMap[selectedFactory];
                                  const nodes = categoryKey ? categories[categoryKey] : undefined;
                                  
                                  if (nodes && nodes.length > 0) {
                                    return nodes.map((node) => (
                                      <SelectItem key={node} value={node}>
                                        {node}
                                      </SelectItem>
                                    ));
                                  } else {
                                    return <SelectItem value="general">General</SelectItem>;
                                  }
                                })()}
                              </SelectContent>
                            </Select>
                          </div>
                        <div className="grid grid-cols-4 items-center gap-4">
                          <Label htmlFor="file" className="text-right">
                            File <span className="text-red-500">*</span>
                          </Label>
                          <div className="col-span-3 flex gap-2">
                            <Input
                              id="file"
                              className="flex-1"
                              value={uploadFilePath}
                              placeholder="Select .tlcls file"
                              readOnly
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={handleSelectClassifierFile}
                            >
                              Browse
                            </Button>
                          </div>
                        </div>
                        <div className="grid grid-cols-4 items-start gap-4">
                          <Label htmlFor="description" className="text-right pt-2">
                            Description
                          </Label>
                          <Textarea
                            id="description"
                            className="col-span-3"
                            value={uploadDescription}
                            onChange={(e) => setUploadDescription(e.target.value)}
                            placeholder="Describe your classifier's purpose, training data, and performance"
                            rows={3}
                          />
                        </div>
                        <div className="grid grid-cols-4 items-start gap-4">
                          <Label className="text-right pt-2">
                            Modality Tags
                          </Label>
                          <div className="col-span-3">
                            <div className="flex flex-wrap gap-2">
                              {modalityTags.map((tag) => (
                                <button
                                  key={tag}
                                  type="button"
                                  onClick={() => handleUploadModalityTagClick(tag)}
                                  className={`px-3 py-1 rounded-md text-sm border transition-colors ${
                                    selectedUploadModalityTags.includes(tag)
                                      ? 'bg-blue-500 text-white border-blue-500'
                                      : 'bg-white text-gray-700 border-gray-300 hover:border-blue-300'
                                  }`}
                                >
                                  {tag}
                                </button>
                              ))}
                            </div>
                            <p className="text-xs text-gray-500 mt-1 mb-0">Select modality types that apply to your classifier</p>
                          </div>
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          onClick={() => setUploadDialogOpen(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          onClick={handleUploadClassifier}
                          disabled={!uploadTitle || !uploadFilePath || !selectedFactory || !selectedSubCategory || uploadingClassifier}
                          className="bg-[#6352a3] hover:bg-[#594a93] text-white"
                        >
                          {uploadingClassifier ? (
                            <>
                              <Upload className="w-4 h-4 mr-2 animate-spin" />
                              Uploading...
                            </>
                          ) : (
                            <>
                              <Upload className="w-4 h-4 mr-2" />
                              Upload
                            </>
                          )}
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                  </div>
                </div>
                
                {loadingClassifiers ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {[...Array(8)].map((_, i) => (
                      <div key={i} className="bg-white rounded-lg border p-4 animate-pulse">
                        <div className="h-4 bg-gray-200 rounded mb-2"></div>
                        <div className="h-3 bg-gray-200 rounded mb-3"></div>
                        <div className="flex items-center gap-2 mb-3">
                          <div className="w-6 h-6 bg-gray-200 rounded-full"></div>
                          <div className="h-3 bg-gray-200 rounded w-20"></div>
                        </div>
                        <div className="flex gap-1 mb-3">
                          <div className="h-5 bg-gray-200 rounded w-16"></div>
                          <div className="h-5 bg-gray-200 rounded w-12"></div>
                        </div>
                        <div className="h-8 bg-gray-200 rounded"></div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {getPaginatedClassifiers().length > 0 ? (
                      getPaginatedClassifiers().map((classifier) => (
                        <ClassifierCard
                          key={classifier.id}
                          classifier={classifier}
                          onDelete={handleDeleteClassifier}
                          canDelete={
                            !!userInfo?.user_id && (
                              firebaseClassifiers.some(c => c.id === classifier.id && c.ownerId === userInfo.user_id) ||
                              userUploadedClassifiers.some(c => c.id === classifier.id && c.author?.user_id === userInfo.user_id)
                            )
                          }
                          onTagClick={(tag) => {
                            handleTagClick(tag);
                            setClassifierSearch('');
                          }}
                          onStatsUpdate={handleStatsUpdate}
                        />
                      ))
                    ) : (
                      <div className="col-span-full text-center py-12">
                        <Database className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                        <h3 className="text-xl font-semibold text-gray-600 mb-2">No classifiers found</h3>
                        <p className="text-gray-500 mb-4">
                          {classifierSearch.trim() 
                            ? 'No classifiers match your search criteria.'
                            : 'Be the first to upload a classifier to the community!'}
                        </p>
                        <Button 
                          onClick={() => setUploadDialogOpen(true)}
                          className="bg-[#6352a3] hover:bg-[#594a93] text-white"
                        >
                          <Upload className="w-4 h-4 mr-2" />
                          Upload Classifier
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                
                {/* Pagination */}
                {getTotalPages() >= 1 && (
                  <div className="flex items-center justify-center mt-8 gap-1">
                    {/* Previous Button */}
                    <button
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                      className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      Previous
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
                    
                    {/* Pages around current */}
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
              </div>

              {/* Datasets Section */}
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Database className="w-5 h-5 text-[#6352a3]" />
                    <h2 className="text-xl font-semibold">Datasets (cloud)</h2>
                  </div>
                  <div className="flex items-center gap-3">
                    {/* Search */}
                    <div className="flex items-center w-48 bg-white border border-gray-200 rounded-lg px-3 py-2">
                      <Search className="w-4 h-4 text-gray-400 mr-2 flex-shrink-0" />
                      <input
                        className="flex-1 border-none outline-none bg-transparent text-sm text-gray-900 placeholder-gray-400 min-w-0"
                        placeholder="Full-text search"
                        value={datasetSearch}
                        onChange={(e) => {
                          setDatasetSearch(e.target.value);
                          setDatasetCurrentPage(1); // Reset to first page when searching
                        }}
                      />
                    </div>
                    {/* Sort */}
                    <Select value={datasetSort} onValueChange={(value: any) => {
                      setDatasetSort(value);
                      setDatasetCurrentPage(1); // Reset to first page when sorting changes
                    }}>
                      <SelectTrigger className="w-48 bg-white border border-gray-200 rounded-lg shadow-none">
                        <div className="flex items-center gap-2">
                          <ArrowUpDown className="w-4 h-4" />
                          <SelectValue />
                        </div>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="most_stars">Most Stars</SelectItem>
                        <SelectItem value="most_downloads">Most Downloads</SelectItem>
                        <SelectItem value="recently_upload">Recently Upload</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {getPaginatedDatasets().map((dataset) => (
                    <DatasetCard key={dataset.id} dataset={dataset} />
                  ))}
                </div>
                
                {/* Datasets Pagination */}
                {getDatasetTotalPages() >= 1 && (
                  <div className="flex items-center justify-center mt-8 gap-1">
                    {/* Previous Button */}
                    <button
                      onClick={() => setDatasetCurrentPage(Math.max(1, datasetCurrentPage - 1))}
                      disabled={datasetCurrentPage === 1}
                      className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      Previous
                    </button>
                    
                    {/* Page 1 */}
                    <button
                      onClick={() => setDatasetCurrentPage(1)}
                      className={`rounded-lg px-2.5 py-1 text-sm ${
                        datasetCurrentPage === 1
                          ? 'bg-gray-50 font-semibold ring-1 ring-inset ring-gray-200'
                          : 'text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      1
                    </button>
                    
                    {/* Early ellipsis */}
                    {datasetCurrentPage > 4 && getDatasetTotalPages() > 6 && (
                      <span className="rounded-lg px-2.5 py-1 text-sm text-gray-400 pointer-events-none cursor-default">
                        ...
                      </span>
                    )}
                    
                    {/* Pages around current */}
                    {Array.from({ length: getDatasetTotalPages() }, (_, i) => i + 1)
                      .filter(pageNum => {
                        if (pageNum === 1 || pageNum === getDatasetTotalPages()) return false;
                        return Math.abs(pageNum - datasetCurrentPage) <= 1;
                      })
                      .map(pageNum => (
                        <button
                          key={pageNum}
                          onClick={() => setDatasetCurrentPage(pageNum)}
                          className={`rounded-lg px-2.5 py-1 text-sm ${
                            datasetCurrentPage === pageNum
                              ? 'bg-gray-50 font-semibold ring-1 ring-inset ring-gray-200'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          {pageNum}
                        </button>
                      ))}
                    
                    {/* Late ellipsis */}
                    {datasetCurrentPage < getDatasetTotalPages() - 3 && getDatasetTotalPages() > 6 && (
                      <span className="rounded-lg px-2.5 py-1 text-sm text-gray-400 pointer-events-none cursor-default">
                        ...
                      </span>
                    )}
                    
                    {/* Last page */}
                    {getDatasetTotalPages() > 1 && (
                      <button
                        onClick={() => setDatasetCurrentPage(getDatasetTotalPages())}
                        className={`rounded-lg px-2.5 py-1 text-sm ${
                          datasetCurrentPage === getDatasetTotalPages()
                            ? 'bg-gray-50 font-semibold ring-1 ring-inset ring-gray-200'
                            : 'text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {getDatasetTotalPages()}
                      </button>
                    )}
                    
                    {/* Next Button */}
                    <button
                      onClick={() => setDatasetCurrentPage(Math.min(getDatasetTotalPages(), datasetCurrentPage + 1))}
                      disabled={datasetCurrentPage === getDatasetTotalPages()}
                      className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm text-gray-600 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
                    >
                      Next
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          {/* Factories Tab - Two-level structure */}
          <TabsContent value="factories" className="h-[calc(100%-120px)] bg-gray-50">
            {factoriesView === 'detail' ? (
              <FactoryClassifierDetail
                factory={Object.keys(categories).find(f =>
                  categories[f].includes(selectedFactoryNode)
                ) || ""}
                node={selectedFactoryNode}
                onBack={handleBackToFactoryList}
                allClassifiers={allClassifiersForFactories}
                categoryDisplayNames={categoryDisplayNames}
                onDeleteClassifier={handleDeleteClassifier}
                userUploadedClassifiers={userUploadedClassifiers}
                onStatsUpdate={handleStatsUpdate}
              />
            ) : (
              <>
                <div className="mb-4">
                  <div className="flex items-center justify-between pb-2">
                    <div>
                      <h2 className="text-2xl font-semibold">Factories</h2>
                    </div>
                    <CustomNodeDialog/>
                  </div>
                </div>
                
                {loading ? (
                  <div className="flex justify-center items-center py-12">
                    <div className="text-center">
                      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#6352a3] mx-auto mb-4"></div>
                      <p className="text-gray-600">Loading task nodes...</p>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {Object.entries(categories).map(([factory, nodes]) => (
                      <FactoryTaskNodeCard
                        key={factory}
                        factory={factory}
                        nodes={nodes}
                        nodeInfo={nodeInfo}
                        nodesExtended={nodesExtended}
                        busy={busy}
                        onActivate={quickActivate}
                        onDeactivate={stopNode}
                        onViewClassifiers={handleViewFactoryClassifiers}
                        onOpenActivate={openActivate}
                        displayName={categoryDisplayNames[factory] || factory}
                        nodeClassifierCounts={nodeClassifierCounts}
                        userUploadedClassifiers={userUploadedClassifiers}
                        realClassifiers={realClassifiers}
                        firebaseClassifiers={firebaseClassifiers}
                        categoryDisplayNames={categoryDisplayNames}
                        activationStatus={activationStatus}
                        failedMeta={failedMeta}
                        isElectron={isElectron}
                        onDownload={handleDownload}
                        installing={installing}
                        activating={activating}
                        onDelete={(nodeName) => {
                          setConfirmTarget(nodeName);
                          setConfirmOpen(true);
                        }}
                        onShowLogs={(nodeName, meta) => {
                          if (!meta.logPath) return;
                          setLogsTarget({ node: nodeName, path: meta.logPath, env: meta.env, port: meta.port });
                          setLogsOpen(true);
                        }}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </TabsContent>

          {/* Datasets Tab */}
          <TabsContent value="datasets" className="h-[calc(100%-120px)] bg-gray-50">
            <div className="text-center py-12">
              <Database className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-gray-600 mb-2">Datasets Coming Soon</h3>
              <p className="text-gray-500">
                We&apos;re working on building a comprehensive dataset hub. Stay tuned for updates!
              </p>
            </div>
          </TabsContent>
        </Tabs>

        {/* Activation Dialog (migrated from AIModelZoo) */}
        <Dialog open={activateOpen} onOpenChange={setActivateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Activate {activateNode} ({activateFactory})</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid grid-cols-4 items-center gap-2">
                <Label className="text-right">Service File <span className="text-red-500">*</span></Label>
                <div className="col-span-3 flex gap-2 items-center">
                  <Input className="flex-1" value={servicePath} onChange={(e)=>setServicePath(e.target.value)} placeholder="Enter .py or binary file path" />
                  <Button type="button" variant="outline" size="sm" onClick={async ()=>{
                    try {
                      const result = await (window as any).electron.invoke('open-file-dialog');
                      if (result?.filePaths?.length) setServicePath(result.filePaths[0]);
                    } catch (e) { console.error(e); }
                  }}>Browse</Button>
                </div>
              </div>
              <div className={`transition-all duration-300 overflow-hidden ${isPyService ? 'max-h-32 mt-2' : 'max-h-0 hidden'}`}>
                <div className="grid grid-cols-4 items-center gap-2">
                  <Label className="text-right">Conda Env <span className="text-red-500">*</span></Label>
                  <div className="col-span-3">
                    <Select value={envName} onValueChange={setEnvName}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select existing env" />
                      </SelectTrigger>
                      <SelectContent>
                        {envOptions.map((n) => (
                          <SelectItem key={n} value={n}>{n}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              <div className={`transition-all duration-300 overflow-hidden ${hasServicePath ? 'max-h-20 opacity-100 mt-2' : 'max-h-0 opacity-0'}`}>
                <div className="grid grid-cols-4 items-center gap-2">
                  <Label className="text-right">Port</Label>
                  <Input className="col-span-3" value={port} onChange={(e)=>setPort(e.target.value.replace(/[^0-9]/g,''))} placeholder="optional" />
                </div>
              </div>
              <div className="flex justify-end">
                <Button disabled={!servicePath || (isPyService && !envName) || activating} onClick={submitActivate} className="bg-[#6352a3] hover:bg-[#594a93] text-white">
                  {activating ? 'Activating...' : 'Activate'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <NodeLogsDialog
          open={logsOpen}
          onOpenChange={setLogsOpen}
          env={logsTarget?.env}
          port={logsTarget?.port}
          logPath={logsTarget?.path}
          pollMs={2000}
        />

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {confirmTarget}?</DialogTitle>
            </DialogHeader>
            <div className="text-sm text-slate-600">
              This removes the node from the registry. It does not uninstall its Conda environment.
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <Button variant="outline" onClick={() => { setConfirmOpen(false); setConfirmTarget(null); }}>Cancel</Button>
              <Button className="bg-red-600 hover:bg-red-700" onClick={async () => {
                if (confirmTarget) {
                  const target = confirmTarget;
                  setConfirmOpen(false);
                  setConfirmTarget(null);
                  await deleteNode(target);
                }
              }}>Delete</Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={installOpen} onOpenChange={setInstallOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Installing bundle</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="relative pl-6">
                <div className="absolute left-2 top-1 bottom-1 w-[2px] bg-gray-200" />
                <div className="space-y-3">
                  {installSteps.map((s) => (
                    <div key={s.key} className="relative">
                      {s.status === 'active' && (
                        <div className="absolute -left-[21px] top-[4px] z-10 w-3 h-3 rounded-full bg-blue-500 opacity-60 animate-ping" />
                      )}
                      <div className={`absolute -left-[21px] top-[4px] z-20 w-3 h-3 rounded-full ${s.status === 'done' ? 'bg-gray-600' : s.status === 'active' ? 'bg-blue-500' : s.status === 'failed' ? 'bg-red-500' : 'bg-gray-300'}`} />
                      <div className="text-sm">
                        <span className="font-medium">{s.label}</span>
                        {s.key === 'download' && installProgress.percent > 0 && (
                          <div className="mt-2">
                            <Progress value={installProgress.percent} />
                            <div className="text-xs text-gray-500 mt-1">{installProgress.text}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
