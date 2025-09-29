"use client";
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  listFiles as apiListFiles,
  getConfig,
  createFolder as apiCreateFolder,
  renameFile as apiRenameFile,
  deleteFiles as apiDeleteFiles,
  moveFiles as apiMoveFiles,
  uploadFiles as apiUploadFiles,
  searchFiles as apiSearchFiles,
  listSharedFiles as apiListSharedFiles,
  getUsersBasicInfo,
  ChunkedUploadManager,
  downloadFile
} from '@/utils/fileManager.service';
import { CTRL_SERVICE_API_ENDPOINT } from '@/constants/config';
import { uploadFilePath, loadFileData, getPreviewAsync, createInstance } from '@/utils/file.service';
import { useDispatch, useSelector } from "react-redux";
import { ChevronRight, Folder, File, X, MoreVertical, 
          Edit, Trash2, ArrowUp, FolderPlus, FilePlus,
          ChevronDown, ArrowDown, DownloadCloud, Search,
          Grid, List, Image as ImageIcon, RefreshCw, Info, Share2 } from 'lucide-react';
import Breadcrumbs from './Breadcrumbs';
import { VIRTUAL_ROOT, SHARED_ROOT } from '../../constants/fm.constants';
import { setImageLoaded } from '@/store/slices/sidebarSlice';
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogFooter,
    DialogTitle,
    DialogDescription,
    DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { setCurrentPath, setSlideInfo } from '@/store/slices/svsPathSlice';
import { updateInstanceWSIInfo, replaceCurrentInstance } from '@/store/slices/wsiSlice';
import { updateWindowImage } from '@/store/slices/multiWindowSlice';
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@radix-ui/react-hover-card";
import { PayloadAction } from '@reduxjs/toolkit';
import { UploadDialog } from './UploadDialog';
import ShareDialog from './ShareDialog';
import { message } from 'antd';
import ChunkedUploadProgress from './ChunkedUploadProgress';
import { 
  setCurrentDirectory, 
  setFileTree, 
  setSortConfig, 
  setTableViewMode, 
  setShowNonImageFiles,
  setSearchTerm,
  setIsLoading,
  setError,
  setUploadSettings,
  resetWebFileManager
} from '@/store/slices/webFileManagerSlice';
import { setTotalChannels } from '@/store/slices/svsPathSlice';
import { shortHashFromString } from '@/utils/string.utils';
import { RootState } from '@/store/index';
import { useFileManagerPreservation } from '@/hooks/useFileManagerPreservation';
import Image from 'next/image';
import { getAuth } from 'firebase/auth';
import { app } from '@/config/firebaseConfig';

// Keep SlideHoverCard and utility functions from the original file as they are useful.
const truncateFileName = (fileName: string, maxLength: number = 80) => {
  if (fileName.length <= maxLength) return fileName;
  const extension = fileName.split('.').pop() || '';
  const nameWithoutExt = fileName.slice(0, fileName.length - extension.length - 1);
  if (nameWithoutExt.length <= maxLength - 5) return fileName;
  const endChars = 5;
  const truncatedLength = maxLength - extension.length - endChars - 8;
  if (truncatedLength < 5) {
    const start = nameWithoutExt.slice(0, maxLength - extension.length - 4);
    return `${start}...${extension ? `.${extension}` : ''}`;
  }
  const start = nameWithoutExt.slice(0, truncatedLength);
  const end = nameWithoutExt.slice(-endChars);
  return `${start}...${end}${extension ? `.${extension}` : ''}`;
};
   
const formatBytes = (bytes: number, decimals = 2) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const SlideHoverCard: React.FC<{ fileName: string; relativePath: string; maxLength?: number }> = ({
  fileName,
  relativePath,
  maxLength = 60,
}) => {
  const [previewData, setPreviewData] = useState<{ thumbnail: string | null; macro: string | null; label: string | null; filename: string; available: string[]; } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreviewData = async () => {
    if (previewData || isLoading) return;
    setIsLoading(true);
    setError(null);
    try {
      await uploadFilePath(relativePath); 
      
      // Generate a unique request ID
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substr(2, 9);
      const pathHash = shortHashFromString(relativePath, 8);
      const requestId = `preview_${pathHash}_${timestamp}_${randomId}`;
      
      const data = await getPreviewAsync(relativePath, 'all', 200, requestId);
      setPreviewData(data);
    } catch (err) {
      console.error('Error fetching slide preview:', err);
      setError(err instanceof Error ? err.message : 'Failed to load preview');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <HoverCard openDelay={250}>
      <HoverCardTrigger asChild>
        <span className="flex items-center cursor-pointer group" onMouseEnter={loadPreviewData}>
          <ImageIcon className="h-4 w-4 mr-2 text-rose-500" />
          <span className="break-words text-sm flex-1 leading-tight" title={fileName} style={{ wordBreak: 'break-all' }}>
            {truncateFileName(fileName, maxLength)}
          </span>
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="w-80 rounded-lg shadow-xl border bg-white p-4 space-y-3 z-50" sideOffset={5}>
        <div className="text-sm font-bold text-gray-800 border-b pb-2 truncate">{fileName}</div>
        {isLoading && <div className="text-center py-8"><p className="text-sm text-gray-500">Loading preview...</p></div>}
        {error && <div className="text-center py-4"><p className="text-sm text-red-500">{error}</p></div>}
      </HoverCardContent>
    </HoverCard>
  );
};

const ImagePreviewCell: React.FC<{ 
  fileName: string; 
  fullPath: string; 
  imageType: 'thumbnail' | 'label' | 'macro';
}> = ({
  fileName,
  fullPath,
  imageType,
}) => {
  const [previewData, setPreviewData] = useState<{
    thumbnail: string | null;
    macro: string | null;
    label: string | null;
    filename: string;
    available: string[];
    source_file?: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const loadPreviewData = useCallback(async () => {
    if (previewData || isLoading || loadingRef.current) return;

    loadingRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      console.log('Loading preview for:', fileName, 'at path:', fullPath);
      
      // Generate a unique request ID
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substr(2, 9);
      const pathHash = shortHashFromString(fullPath, 8);
      const requestId = `preview_${pathHash}_${timestamp}_${randomId}`;
      
      const data = await getPreviewAsync(fullPath, 'all', 200, requestId);
      
      console.log('Preview data for', fileName, ':', data);
      setPreviewData(data);
      
    } catch (err) {
      console.error('Error fetching slide preview for', fileName, ':', err);
      setError(err instanceof Error ? err.message : 'Failed to load preview');
      
      setPreviewData({
        thumbnail: null,
        macro: null,
        label: null,
        filename: fileName,
        available: [],
        source_file: fullPath
      });
    } finally {
      setIsLoading(false);
      loadingRef.current = false;
    }
  }, [fileName, fullPath, previewData, isLoading]);

  const [elementRef, setElementRef] = useState<HTMLDivElement | null>(null);
  
  useEffect(() => {
    if (!elementRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !previewData && !isLoading && !loadingRef.current) {
            // add little delay to avoid too many requests
            const delay = Math.random() * 300 + 100; // 100-400ms random delay
            setTimeout(() => {
              if (!loadingRef.current && !previewData) {
                loadPreviewData();
              }
            }, delay);
          }
        });
      },
      { 
        threshold: 0.1,
        rootMargin: '50px' // start loading 50px before the element comes into view
      }
    );

    observer.observe(elementRef);
    return () => observer.disconnect();
  }, [elementRef, loadPreviewData, previewData, isLoading]);

  useEffect(() => {
    setPreviewData(null);
    setError(null);
    loadingRef.current = false;
  }, [fullPath, imageType]); // Add imageType to dependencies to reset when type changes

  const getCurrentImage = () => {
    if (!previewData) return null;
    // Ensure we're getting the correct image type
    const imageData = previewData[imageType];
    
    // Additional validation to prevent cross-contamination
    if (imageData && typeof imageData === 'string' && imageData.startsWith('data:image/')) {
      return imageData;
    }
    
    return null;
  };

  if (isLoading) {
    return (
      <div 
        ref={setElementRef}
        className="w-full h-full bg-gray-100 rounded flex items-center justify-center"
      >
        <div className="flex flex-col items-center">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent"></div>
          <div className="text-xs text-gray-500 mt-1 text-center px-1">
            Loading...
          </div>
        </div>
      </div>
    );
  }

  if (error && !previewData) {
    return (
      <div 
        ref={setElementRef}
        className="w-full h-full bg-red-50 rounded flex items-center justify-center"
      >
        <div className="text-center p-1">
          <div className="text-xs text-red-500 mb-1">Error</div>
          <button 
            onClick={() => {
              setError(null);
              setPreviewData(null);
              loadingRef.current = false;
              loadPreviewData();
            }}
            className="text-xs text-blue-500 hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const currentImage = getCurrentImage();

  return (
    <div 
      ref={setElementRef}
      className="w-full h-full flex items-center justify-center p-1"
    >
      {currentImage ? (
        <div className="relative w-full h-full">
          <Image
            src={currentImage}
            alt={`${fileName} ${imageType}`}
            fill
            className="object-contain rounded"
            onError={(e) => {
              console.error('Image load error for:', fileName, imageType);
              e.currentTarget.style.display = 'none';
            }}
          />
        </div>
      ) : (
        <div className="w-full h-full bg-gray-100 rounded flex items-center justify-center">
          <div className="text-center">
            <ImageIcon className="h-6 w-6 text-gray-400 mx-auto mb-1" />
            <div className="text-xs text-gray-400">No {imageType}</div>
          </div>
        </div>
      )}
    </div>
  );
};

interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
  source?: 'local' | 'web';
  // Shared file metadata
  sharedBy?: string;
  sharedAt?: number;
  isShared?: boolean;
}

interface FileTreeNode extends FileItem {
    children?: FileTreeNode[];
    isExpanded?: boolean;
    isLoading?: boolean;
    depth: number;
}

const isWSI = (fileName: string) => {
    const supportedExtensions = ['.svs', '.qptiff', '.tif', '.ndpi', '.tiff', '.jpeg', '.png', '.jpg', '.dcm', '.bmp', '.czi', '.nii', '.nii.gz', '.btf', '.isyntax'];
    return supportedExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
};

const isH5 = (fileName: string) => {
    return fileName.toLowerCase().endsWith('.h5');
};

const getWSIBaseName = (fileName: string) => {
    // For H5 files that follow pattern: wsi_name.ext.h5
    if (isH5(fileName)) {
        return fileName.replace(/\.h5$/, ''); // Remove .h5 extension properly
    }
    return fileName;
};

const groupWSIAndH5Files = (files: FileTreeNode[]): FileTreeNode[] => {
    const grouped: FileTreeNode[] = [];
    const wsiFiles: FileTreeNode[] = [];
    const h5Files: FileTreeNode[] = [];
    const otherFiles: FileTreeNode[] = [];

    // Separate files by type
    files.forEach(file => {
        if (file.is_dir) {
            otherFiles.push(file);
        } else if (isWSI(file.name)) {
            wsiFiles.push(file);
        } else if (isH5(file.name)) {
            h5Files.push(file);
        } else {
            otherFiles.push(file);
        }
    });

    // Group H5 files with their corresponding WSI files
    const wsiMap = new Map<string, FileTreeNode>();
    
    // Add WSI files as parents
    wsiFiles.forEach(wsi => {
        const groupedWSI: FileTreeNode = {
            ...wsi,
            children: [],
        };
        wsiMap.set(wsi.name, groupedWSI);
        grouped.push(groupedWSI);
    });

    // Group H5 files under their corresponding WSI files
    h5Files.forEach(h5 => {
        const h5BaseName = getWSIBaseName(h5.name);
        let parentWSI = wsiMap.get(h5BaseName);
        
        if (!parentWSI) {
            // Try to find WSI by checking if H5 filename starts with WSI filename
            const wsiEntries = Array.from(wsiMap.entries());
            for (const [wsiName, wsiItem] of wsiEntries) {
                if (h5.name.startsWith(wsiName)) {
                    parentWSI = wsiItem;
                    break;
                }
            }
        }

        if (parentWSI) {
            // Add H5 as child of WSI with increased depth
            const groupedH5: FileTreeNode = {
                ...h5,
                depth: parentWSI.depth + 1
            };
            parentWSI.children!.push(groupedH5);
        } else {
            // If no matching WSI found, add H5 as standalone file
            grouped.push(h5);
        }
    });

    // Add other files (directories and non-WSI/H5 files)
    otherFiles.forEach(file => {
        grouped.push(file);
    });

    return grouped;
};

// Main WebFileManager Component
const WebFileManager = () => {

  const dispatch = useDispatch();
  const router = useRouter();
  
  // Generate a stable key prefix for this component instance
  const [keyPrefix, setKeyPrefix] = useState(() => `wfm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  // Track auth user ID to forcefully remount breadcrumb on auth changes
  const [authUserId, setAuthUserId] = useState<string>('guest');
  
  // Get active window for multi-window state updates
  const { activeWindow } = useSelector((state: RootState) => state.multiWindow);

  // Use the preservation hook to get and save state
  const {
    currentDirectory,
    fileTree,
    searchTerm,
    sortConfig,
    showNonImageFiles,
    tableViewMode,
    expandedFolders,
    lastVisitedPath
  } = useFileManagerPreservation();
  
  // Quota state
  const [storageUsage, setStorageUsage] = useState<number>(0);
  const [storageQuota, setStorageQuota] = useState<number | null>(null);
  const refreshQuota = useCallback(async () => {
    try {
      const cfg = await getConfig();
      if (typeof cfg?.storageUsage === 'number') setStorageUsage(cfg.storageUsage);
      if (typeof cfg?.storageQuota === 'number' || cfg?.storageQuota === null) setStorageQuota(cfg.storageQuota ?? null);
    } catch (e) {
      // ignore; backend will enforce
    }
  }, []);
  
  const flattenTree = useCallback((nodes: FileTreeNode[]): FileTreeNode[] => {
      let flat: FileTreeNode[] = [];
      nodes.forEach(node => {
          // Apply the same filter logic as in renderFileTreeRows
          if (!showNonImageFiles && !node.is_dir && !isWSI(node.name) && !isH5(node.name)) {
              // Skip non-image files when showNonImageFiles is false, but still process children
              if (node.children && node.children.length > 0) {
                  flat = flat.concat(flattenTree(node.children));
              }
              return;
          }
          
          flat.push(node);
          // Process children (including H5 files grouped under WSI files)
          if (node.children && node.children.length > 0) {
              flat = flat.concat(flattenTree(node.children));
          }
      });
      return flat;
  }, [showNonImageFiles]);
  

  // Get other state from Redux
  const {
    isLoading,
    error,
    uploadSettings
  } = useSelector((state: RootState) => state.webFileManager);

  // Local state for drag and drop and upload management
  const [draggingItem, setDraggingItem] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [chunkedUploadManagers, setChunkedUploadManagers] = useState<Map<string, ChunkedUploadManager>>(new Map());
  const [uploadStatus, setUploadStatus] = useState<Map<string, { 
    progress: number; 
    status: 'Uploading' | 'Paused' | 'Completed' | 'Error' | 'Cancelled'; 
    error?: string;
    uploadTime?: number;
    estimatedTimeRemaining?: number;
    retryCount?: number;
    startTime?: number;
    fileSize?: number;
    fileName?: string; // Add fileName field to store the complete filename
  }>>(new Map());
  const [isSearching, setIsSearching] = useState(false);
  const [uploadInterrupted, setUploadInterrupted] = useState(false);
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false);
  const [overwriteFiles, setOverwriteFiles] = useState<File[]>([]);
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[]>([]);
  const overwriteResolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  // Event-driven upload completion tracker
  const uploadCompletionTracker = useRef({
    activeUploads: new Map<string, { resolve: () => void }>(),
    add: (fileId: string) => {
      return new Promise<void>((resolve) => {
        uploadCompletionTracker.current.activeUploads.set(fileId, { resolve });
      });
    },
    complete: (fileId: string) => {
      const upload = uploadCompletionTracker.current.activeUploads.get(fileId);
      if (upload) {
        upload.resolve();
        uploadCompletionTracker.current.activeUploads.delete(fileId);
      }
    },
    waitForAll: () => {
      const promises = Array.from(uploadCompletionTracker.current.activeUploads.values()).map(({ resolve }) => {
        return new Promise<void>((resolvePromise) => {
          resolvePromise();
        });
      });
      return Promise.all(promises);
    },
    hasActiveUploads: () => {
      return uploadCompletionTracker.current.activeUploads.size > 0;
    }
  });

  const uploadStatusRef = useRef(uploadStatus);

  useEffect(() => {
    uploadStatusRef.current = uploadStatus;
  }, [uploadStatus]);

  // Event-driven upload status manager
  const uploadStatusManager = useRef({
    subscribers: new Set<() => void>(),
    isRunning: false,
    lastUpdateTime: 0,

    // Subscribe to status updates
    subscribe: (callback: () => void) => {
      uploadStatusManager.current.subscribers.add(callback);
      uploadStatusManager.current.start();
      return () => {
        uploadStatusManager.current.subscribers.delete(callback);
        if (uploadStatusManager.current.subscribers.size === 0) {
          uploadStatusManager.current.stop();
        }
      };
    },

    // Start the event-driven update loop
    start: () => {
      if (uploadStatusManager.current.isRunning) return;

      uploadStatusManager.current.isRunning = true;

      const updateLoop = () => {
        if (!uploadStatusManager.current.isRunning) return;

        const currentTime = Date.now();
        const timeSinceLastUpdate = currentTime - uploadStatusManager.current.lastUpdateTime;

        // Only update if at least 1 second has passed or if there are active uploads
        if (timeSinceLastUpdate >= 1000 || uploadStatusManager.current.hasActiveUploads()) {
          uploadStatusManager.current.updateStatus();
          uploadStatusManager.current.lastUpdateTime = currentTime;
        }

        // Schedule next update based on whether there are active uploads
        const delay = uploadStatusManager.current.hasActiveUploads() ? 500 : 1000;
        setTimeout(updateLoop, delay);
      };

      updateLoop();
    },

    // Stop the update loop
    stop: () => {
      uploadStatusManager.current.isRunning = false;
    },

    // Check if there are active uploads
    hasActiveUploads: () => {
      return Array.from(uploadStatusRef.current.values()).some(status =>
        status.status === 'Uploading' || status.status === 'Paused'
      );
    },

    // Update upload status
    updateStatus: () => {
      setUploadStatus(prev => {
        const newStatus = new Map(prev);
        let hasChanges = false;

        newStatus.forEach((status, fileId) => {
          if (status.status === 'Uploading' && status.startTime) {
            const currentTime = Date.now();
            const elapsedTime = currentTime - status.startTime;
            const newEstimatedTime = status.progress > 0 ? (elapsedTime / status.progress) * (100 - status.progress) : undefined;

            if (status.uploadTime !== elapsedTime || status.estimatedTimeRemaining !== newEstimatedTime) {
              newStatus.set(fileId, {
                ...status,
                uploadTime: elapsedTime,
                estimatedTimeRemaining: newEstimatedTime
              });
              hasChanges = true;
            }
          }
        });

        return hasChanges ? newStatus : prev;
      });
    }
  });

  // Start/stop upload status updates based on upload activity
  useEffect(() => {
    const hasActiveUploads = uploadStatusManager.current.hasActiveUploads();

    if (hasActiveUploads && !uploadStatusManager.current.isRunning) {
      uploadStatusManager.current.start();
    } else if (!hasActiveUploads && uploadStatusManager.current.isRunning) {
      // Delay stopping to avoid flickering when uploads finish
      setTimeout(() => {
        if (!uploadStatusManager.current.hasActiveUploads()) {
          uploadStatusManager.current.stop();
        }
      }, 2000);
    }
  }, [uploadStatus]);

  const [dialog, setDialog] = useState<
    { type: 'create-folder' | 'rename'; path?: string; } |
    { type: 'delete'; path: string } |
    { type: 'share'; path: string } |
    null
  >(null);
  
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const defaultPathRef = useRef<string>('');
  // constants moved to fm.constants
  const isSamplesPath = (p: string | null | undefined) => {
    if (!p) return false;
    return p === 'samples' || p.startsWith('samples/');
  };
  const isPersonalRootPath = (p: string | null | undefined) => {
    if (!p) return false;
    const personal = (defaultPathRef.current || '').replace(/\\/g, '/');
    return personal !== '' && (p === personal || p.startsWith(personal + '/'));
  };

  // Ensure shared context state stays in sync when navigating via virtual paths
  const computeSharedScopeRoot = (p: string) => {
    if (!p || !p.startsWith('users/')) return null;
    const parts = p.split('/');
    // users/<uid>/<top-folder> as minimal scope when possible
    if (parts.length >= 3) return parts.slice(0, 3).join('/');
    if (parts.length >= 2) return parts.slice(0, 2).join('/');
    return null;
  };

  const ensureSharedContextForPath = useCallback((p: string) => {
    const auth = getAuth(app);
    const isLoggedIn = !!auth.currentUser;
    if (!isLoggedIn) return;

    if (p === SHARED_ROOT) {
      sharedBrowseModeRef.current = true;
      sharedScopeRef.current = null;
      return;
    }

    if (p && p.startsWith('users/')) {
      const myUid = auth.currentUser?.uid || '';
      const parts = p.split('/');
      const ownerId = parts.length > 1 ? parts[1] : '';
      const scope = computeSharedScopeRoot(p);
      if (ownerId && ownerId !== myUid) {
        // enter others users space
        sharedBrowseModeRef.current = true;
        if (scope) sharedScopeRef.current = scope;
      } else if (ownerId && ownerId === myUid) {
        // enter self space: if from Shared entry, keep shared mode; otherwise view as personal space
        if (sharedBrowseModeRef.current) {
          if (scope) sharedScopeRef.current = scope;
        } else {
          sharedScopeRef.current = null;
        }
      }
    }
  }, []);

  // Helper to check if we're in shared context
  const isInSharedContext = (path: string): boolean => {
    const auth = getAuth(app);
    const isLoggedIn = !!auth.currentUser;
    if (!isLoggedIn) return false;

    const myUid = auth.currentUser?.uid || '';
    const isUnderUsers = path.startsWith('users/') && path.split('/').length >= 2;
    const ownerId = isUnderUsers ? path.split('/')[1] : '';

      // Shared context when:
      // - At shared root
    // - Under another user's users/<uid>/... path
    // - or: in shared browsing mode, enter your own users/<myUid>/... (via Shared entry)
    const inShared = Boolean(
      path === SHARED_ROOT ||
      (isUnderUsers && !!ownerId && ownerId !== myUid) ||
      (sharedBrowseModeRef.current === true && isUnderUsers && !!ownerId && ownerId === myUid)
    );
    return inShared;
  };

  // Helper to get parent path
  const getParentPath = (path: string) => {
    if (path === SHARED_ROOT) return SHARED_ROOT;
    const parts = path.split('/').filter(p => p);
    if (parts.length <= 1) return SHARED_ROOT;
    // For shared namespace, users/<uid> should go back to shared root
    if (parts[0] === 'users' && parts.length <= 2) return SHARED_ROOT;
    return parts.slice(0, -1).join('/');
  };

  // Unified permission helper based on a simple blacklist policy
  const computeFsPermissions = (currentDir: string) => {
    const isLoggedIn = !!getAuth(app).currentUser;
    const inVirtualRoot = isLoggedIn && currentDir === VIRTUAL_ROOT;
    const inSharedRoot = isLoggedIn && currentDir === SHARED_ROOT;
    const inSharedContext = isLoggedIn && isInSharedContext(currentDir);
    const inSamples = isSamplesPath(currentDir); // apply to both guests and logged-in users
    const inPersonalRoot = isLoggedIn && isPersonalRootPath(currentDir);

    const canCreate = isLoggedIn && !inVirtualRoot && !inSharedContext && !inSamples; // create folder/file
    const canUpload = canCreate; // same rule
    const canMoveTo = (dest: string) => {
      if (isSamplesPath(dest)) return false; // never move into samples
      if (isLoggedIn && dest === VIRTUAL_ROOT) return false;
      if (isLoggedIn && isInSharedContext(dest)) return false;
      return true;
    };
    const canDropToCurrent = !(inVirtualRoot || inSharedContext || inSamples); // disallow drops in samples/shared for everyone
    const isContextDisabledForItem = (itemPath: string) =>
      isSamplesPath(itemPath)
      || inSamples
      || inSharedContext
      || (inVirtualRoot && (isPersonalRootPath(itemPath) || isInSharedContext(itemPath)));

    return {
      isLoggedIn,
      inVirtualRoot,
      inSharedRoot,
      inSharedContext,
      inSamples,
      inPersonalRoot,
      canCreate,
      canUpload,
      canMoveTo,
      canDropToCurrent,
      isContextDisabledForItem,
    };
  };

  const isFetchingRef = useRef(false);
  const lastFetchedPathRef = useRef<string>('');
  // Track whether user is navigating under "Shared with me" context (including self-shared folders)
  const sharedBrowseModeRef = useRef<boolean>(false);
  // Restrict navigation within the selected shared folder scope
  const sharedScopeRef = useRef<string | null>(null);

  // Save shared context to sessionStorage
  const saveSharedContextToSession = useCallback(() => {
    if (typeof window !== 'undefined') {
      const sharedContext = {
        sharedBrowseMode: sharedBrowseModeRef.current,
        sharedScope: sharedScopeRef.current,
        currentDirectory: currentDirectory,
        timestamp: Date.now()
      };
      sessionStorage.setItem('tissuelab_shared_context', JSON.stringify(sharedContext));
    }
  }, [currentDirectory]);

  // Restore shared context from sessionStorage
  const restoreSharedContextFromSession = useCallback(() => {
    if (typeof window !== 'undefined') {
      try {
        const savedContext = sessionStorage.getItem('tissuelab_shared_context');
        if (savedContext) {
          const context = JSON.parse(savedContext);
          // Only restore if saved recently (within 1 hour)
          const isRecent = (Date.now() - context.timestamp) < 3600000;
          if (isRecent && context.sharedBrowseMode) {
            sharedBrowseModeRef.current = context.sharedBrowseMode;
            sharedScopeRef.current = context.sharedScope;
            return context;
          }
        }
      } catch (error) {
        console.error('Failed to restore shared context from session:', error);
      }
    }
    return null;
  }, []);

  // Clear shared context from sessionStorage
  const clearSharedContextFromSession = useCallback(() => {
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('tissuelab_shared_context');
    }
  }, []);
  // Cache ownerId -> preferred display name
  const ownerNameCacheRef = useRef<Map<string, string>>(new Map());

  // Check for saved shared context on component mount/remount (when returning from ImageViewer)
  // Moved below fetchFiles and stabilized dependencies to satisfy exhaustive-deps

  const fetchFiles = useCallback(async (path: string, depth = 0) => {
    if (isFetchingRef.current) {
      console.log('fetchFiles already in progress, skipping:', path);
      return;
    }

    if (lastFetchedPathRef.current === path && isFetchingRef.current) {
      console.log('Same path already being fetched, skipping:', path);
      return;
    }

    isFetchingRef.current = true;
    lastFetchedPathRef.current = path;

    dispatch(setIsLoading(true));
    dispatch(setError(null));
    try {
      const auth = getAuth(app);
      const isLoggedIn = !!auth.currentUser;

      // If launching navigation from virtual root to personal, exit shared mode
      if (isLoggedIn && currentDirectory === VIRTUAL_ROOT) {
        const personalPathFromRoot = (defaultPathRef.current || '');
        if (path === personalPathFromRoot || (personalPathFromRoot && path.startsWith(personalPathFromRoot + '/'))) {
          sharedBrowseModeRef.current = false;
        }
      }

      // Reset shared mode when back to virtual root or samples
      if (path === VIRTUAL_ROOT || path === 'samples') {
        sharedBrowseModeRef.current = false;
        sharedScopeRef.current = null;
      }

      // Normalize shared context flags based on target path (deep-link & restore-safe)
      ensureSharedContextForPath(path);

      // Never forward virtual root to backend. Handle it here.
      if (path === VIRTUAL_ROOT) {
        // Logged-in: render virtual root (Personal + Samples) locally
        if (isLoggedIn) {
          const personalPath = defaultPathRef.current || '';
          const samplesPath = 'samples';
          const virtualItems: FileItem[] = [
            { name: 'Personal', path: personalPath, is_dir: true, size: 0, mtime: 0 },
            { name: 'Shared with me', path: SHARED_ROOT, is_dir: true, size: 0, mtime: 0 },
            { name: 'Samples', path: samplesPath, is_dir: true, size: 0, mtime: 0 },
          ];
          const treeNodes: FileTreeNode[] = virtualItems.map(f => ({ ...f, depth, children: [], source: 'web' as const }));
          dispatch(setFileTree(treeNodes));
          dispatch(setCurrentDirectory(VIRTUAL_ROOT));
          return;
        }
        // Guest: normalize to samples root
        path = 'samples';
      }

      // Virtual root for logged-in: show personal and samples side-by-side without API call (redundant guard)
      if (isLoggedIn && path === VIRTUAL_ROOT) {
        const personalPath = defaultPathRef.current || '';
        const samplesPath = 'samples';
        const virtualItems: FileItem[] = [
          { name: 'Personal', path: personalPath, is_dir: true, size: 0, mtime: 0 },
          { name: 'Shared with me', path: SHARED_ROOT, is_dir: true, size: 0, mtime: 0 },
          { name: 'Samples', path: samplesPath, is_dir: true, size: 0, mtime: 0 },
        ];
        const treeNodes: FileTreeNode[] = virtualItems.map(f => ({ ...f, depth, children: [], source: 'web' as const }));
        dispatch(setFileTree(treeNodes));
        dispatch(setCurrentDirectory(VIRTUAL_ROOT));
        return;
      }

      // Shared with me virtual directory
      if (isLoggedIn && path === SHARED_ROOT) {
        // Enter shared browsing mode
        sharedBrowseModeRef.current = true;
        // Reset scope at shared root
        sharedScopeRef.current = null;
        dispatch(setIsLoading(true));
        try {
          const list = await apiListSharedFiles();
          // Adapt shared docs to FileItem list
          const items: FileItem[] = (list || []).map((doc: any) => {
            // Convert ISO date string to timestamp for mtime (in seconds)
            let mtime = 0;
            if (doc.updatedAt) {
              if (typeof doc.updatedAt === 'number') {
                mtime = doc.updatedAt;
              } else if (typeof doc.updatedAt === 'string') {
                const date = new Date(doc.updatedAt);
                mtime = isNaN(date.getTime()) ? 0 : Math.floor(date.getTime() / 1000);
              }
            }

            // Convert sharedAt to timestamp as well (in seconds)
            let sharedAt = 0;
            if (doc.sharedAt || doc.createdAt || doc.updatedAt) {
              const dateStr = doc.sharedAt || doc.createdAt || doc.updatedAt;
              if (typeof dateStr === 'number') {
                sharedAt = dateStr;
              } else if (typeof dateStr === 'string') {
                const date = new Date(dateStr);
                sharedAt = isNaN(date.getTime()) ? 0 : Math.floor(date.getTime() / 1000);
              }
            }

            // Normalize localPath and prefix with users/<ownerId>/ for proper shared context routing
            const ownerId: string | undefined = doc.ownerId || doc.owner?.id || doc.owner;
            const localPath: string = (doc.localPath || '').replace(/^\/+|^\\+/, '');
            let normalizedPath = localPath || '';
            if (ownerId) {
              const prefix = `users/${ownerId}`;
              normalizedPath = normalizedPath.startsWith(prefix) ? normalizedPath : (normalizedPath ? `${prefix}/${normalizedPath}` : prefix);
            }

            const ownerDisplay = (doc.ownerName || doc.sharedBy || (ownerId ? ownerId.substring(0, 8) : undefined)) as string | undefined;
            if (ownerId && ownerDisplay) {
              ownerNameCacheRef.current.set(ownerId, ownerDisplay);
            }

            return {
              name: doc.fileName || (localPath ? localPath.split('/').pop() : 'file'),
              path: normalizedPath,
              is_dir: !!doc.isDir,
              size: doc.fileSize || 0,
              mtime: mtime,
              source: 'web' as const,
              // Add shared file metadata - prioritize ownerName over ownerId
              sharedBy: ownerDisplay || 'Unknown',
              sharedAt: sharedAt,
              isShared: true,
            };
          });

          // For shared files, display them directly without tree structure
          // Convert FileItem to FileTreeNode with depth 0 for flat display
          const treeNodes: FileTreeNode[] = items.map(item => ({
            ...item,
            depth: 0, // All files at root level
            children: [],
            source: 'web' as const,
          }));

          // Prepend a synthetic parent to go back to virtual root
          const upNode: FileTreeNode = {
            name: '..',
            path: VIRTUAL_ROOT,
            is_dir: true,
            size: 0,
            mtime: 0,
            depth: 0,
            source: 'web' as const,
            isParentLink: true
          } as FileTreeNode;

          const finalTree = [upNode, ...treeNodes];
          dispatch(setFileTree(finalTree));
          dispatch(setCurrentDirectory(SHARED_ROOT));
        } catch (err: any) {
          console.error('Error fetching shared files:', err);
          console.error('Error details:', {
            message: err?.message,
            status: err?.status,
            response: err?.response,
            stack: err?.stack
          });
          const errorMessage = err?.message || 'Failed to fetch shared files';
          dispatch(setError(`Unable to load shared files: ${errorMessage}`));
          dispatch(setFileTree([]));
        } finally {
          dispatch(setIsLoading(false));
        }
        return;
      }

      // Handle shared folder navigation (when navigating TO a shared path)
      if (isLoggedIn && isInSharedContext(path)) {
        // We're navigating within shared context
        try {
          // Establish or enforce shared scope based on TARGET path
          if (!sharedScopeRef.current) {
            const inferred = computeSharedScopeRoot(path);
            sharedScopeRef.current = inferred || (path.startsWith('users/') ? path : null);
          }
          const scope = sharedScopeRef.current;
          if (scope) {
            if (!path.startsWith(scope)) {
              // If trying to navigate above the scope, go back to shared root
              const goingUpBeyondScope = scope.startsWith(path + '/') || scope === path;
              if (goingUpBeyondScope) {
                sharedScopeRef.current = null;
                await fetchFiles(SHARED_ROOT);
                return;
              } else {
                // Prevent switching to a different subtree while inside a scoped shared folder
                dispatch(setError('Access denied: outside shared scope'));
                dispatch(setIsLoading(false));
                isFetchingRef.current = false;
                return;
              }
            }
          }

          const result: FileItem[] = await apiListFiles(path);
          const sortedFiles = result.sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            return b.mtime - a.mtime; // Sort by last modified time in descending order
          });

          // Derive sharedBy from shared scope ownerId (prefer cached display name)
          let sharedByOwnerShort: string | undefined = undefined;
          let sharedByDisplay: string | undefined = undefined;
          if (scope) {
            const parts = scope.split('/');
            if (parts.length >= 2 && parts[0] === 'users') {
              const ownerId = parts[1];
              sharedByOwnerShort = ownerId ? ownerId.substring(0, 8) : undefined;
              sharedByDisplay = ownerNameCacheRef.current.get(ownerId);
              if (!sharedByDisplay) {
                try {
                  const info: any = await getUsersBasicInfo([ownerId]);
                  const user = (info?.users && Array.isArray(info.users)) ? info.users[0] : (info?.[ownerId] || {});
                  const name = user?.displayName || user?.preferredName || user?.name || null;
                  if (name) {
                    ownerNameCacheRef.current.set(ownerId, name);
                    sharedByDisplay = name;
                  }
                } catch (e) {
                  // ignore
                }
              }
            }
          }

          // Force children to use virtual paths under current shared path
          const sanitizedBase = (path || '').replace(/\\/g, '/').replace(/\/+$/g, '');
          const treeNodes: FileTreeNode[] = sortedFiles.map(file => {
            const nameOnly = file.name || (file.path ? file.path.split('/').pop() || '' : '');
            const childVirtualPath = sanitizedBase ? `${sanitizedBase}/${nameOnly}` : nameOnly;
            return {
              name: nameOnly,
              path: childVirtualPath,
              is_dir: !!file.is_dir,
              size: file.size || 0,
              mtime: file.mtime || 0,
              depth: 0,
              children: file.is_dir ? [] : undefined, // Folders have children array
              source: 'web' as const,
              isShared: true, // Mark as shared
              sharedBy: (sharedByDisplay || sharedByOwnerShort),
            } as FileTreeNode;
          });

          // Add parent link to go back to shared root or parent, respecting scope
          // In shared context: if inside scope and not at scope root, go to parent; else back to Shared Root
          const scopeNow = sharedScopeRef.current;
          let parentForUp = SHARED_ROOT;
          if (scopeNow && path.startsWith(scopeNow) && path !== scopeNow) {
            const parentRaw = getParentPath(path);
            parentForUp = parentRaw.startsWith(scopeNow) ? parentRaw : scopeNow;
          }

          const upNode: FileTreeNode = {
            name: '..',
            path: parentForUp,
            is_dir: true,
            size: 0,
            mtime: 0,
            depth: 0,
            source: 'web' as const,
            isParentLink: true
          } as FileTreeNode;

          treeNodes.unshift(upNode);

          // Group WSI and H5 files
          const groupedTreeNodes = groupWSIAndH5Files(treeNodes);

          dispatch(setFileTree(groupedTreeNodes));
          dispatch(setCurrentDirectory(path));
        } catch (err: any) {
          const errorMessage = err?.message || 'Failed to fetch shared folder contents';
          dispatch(setError(`Unable to load shared folder: ${errorMessage}`));
          dispatch(setFileTree([]));
        } finally {
          dispatch(setIsLoading(false));
        }
        return;
      }

      // prevent empty-path requests from frontend
      let effectivePath = (path || '').trim();
      if (!effectivePath) {
        effectivePath = defaultPathRef.current;
        if (!effectivePath) {
          try {
            const cfg = await getConfig();
            effectivePath = (cfg?.defaultPath || '').replace(/\\/g, '/');
            defaultPathRef.current = effectivePath;
          } catch (e) {
            effectivePath = '';
          }
        }
      }

      const result: FileItem[] = await apiListFiles(effectivePath);
      const sortedFiles = result.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return b.mtime - a.mtime; // Sort by last modified time in descending order
      });

      let treeNodes: FileTreeNode[] = sortedFiles.map(file => ({
          ...file,
          depth,
          children: file.is_dir ? [] : undefined, // Folders have children array
          source: 'web' as const,
      }));

      if (effectivePath) {
        const auth = getAuth(app);
        const isLoggedIn = !!auth.currentUser;
        let parentPath = '';
        if (isLoggedIn) {
          const personalRoot = defaultPathRef.current || '';
          const isSharedTop = /^users\/[^/]+$/.test(effectivePath) && effectivePath !== personalRoot;
          if (effectivePath === personalRoot || effectivePath === 'samples' || effectivePath === SHARED_ROOT || isSharedTop) {
            parentPath = VIRTUAL_ROOT;
          } else {
            parentPath = effectivePath.includes('/') ? effectivePath.substring(0, effectivePath.lastIndexOf('/')) : VIRTUAL_ROOT;
          }
        } else {
          // guest: at 'samples' root there should be no parent node
          parentPath = effectivePath.includes('/') ? effectivePath.substring(0, effectivePath.lastIndexOf('/')) : '';
          if (!parentPath) {
            // do not show parent link at samples root
            parentPath = '';
          }
        }
        const upNode: FileTreeNode = {
            name: '..',
            path: parentPath,
            is_dir: true,
            size: 0,
            mtime: 0,
            depth,
            source: 'web' as const,
            // @ts-ignore
            isParentLink: true,
        };
        if (isLoggedIn || parentPath) {
          treeNodes.unshift(upNode);
        }
      }

      // Group WSI and H5 files
      const groupedTreeNodes = groupWSIAndH5Files(treeNodes);
      
      dispatch(setFileTree(groupedTreeNodes));
      dispatch(setCurrentDirectory(effectivePath));
    } catch (err: any) {
      const notAuth = err && (err.status === 401 || err.status === 403);
      const errorMessage = notAuth ? 'Please login to browse cloud storage' : (err.message || 'Failed to fetch files');
      dispatch(setError(errorMessage));
      dispatch(setFileTree([]));
    } finally {
      dispatch(setIsLoading(false));
      isFetchingRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  // Check for saved shared context on component mount/remount (when returning from ImageViewer)
  useEffect(() => {
    const restoredContext = restoreSharedContextFromSession();
    if (restoredContext && restoredContext.sharedBrowseMode) {
      // Restore shared context state
      sharedBrowseModeRef.current = restoredContext.sharedBrowseMode;
      sharedScopeRef.current = restoredContext.sharedScope;

      // Ensure shared context is properly activated
      if (restoredContext.currentDirectory) {
        ensureSharedContextForPath(restoredContext.currentDirectory);
      }

      // Navigate back to the shared directory
      if (restoredContext.currentDirectory) {
        fetchFiles(restoredContext.currentDirectory);
      }

      // Clear the session storage after restoring
      clearSharedContextFromSession();
    }
  }, [restoreSharedContextFromSession, ensureSharedContextForPath, fetchFiles, clearSharedContextFromSession]);

  const handleSearch = async (query: string) => {
    dispatch(setSearchTerm(query));
    if (!query) {
      setIsSearching(false);
      fetchFiles(currentDirectory); // Or clear and show root
      return;
    }
    setIsSearching(true);
    dispatch(setIsLoading(true));
    try {
      const results: FileItem[] = await apiSearchFiles(query);
      const tree = buildTreeFromFlatList(results);
      dispatch(setFileTree(tree));
    } catch (err: any) {
      dispatch(setError(err.message));
      dispatch(setFileTree([]));
    } finally {
      dispatch(setIsLoading(false));
    }
  };

  // Helper to build a tree from a flat list of paths
  const buildTreeFromFlatList = (files: FileItem[]): FileTreeNode[] => {
    const nodes: { [path: string]: FileTreeNode } = {};

    files.forEach(file => {
      // Create node for the file itself
      if (!nodes[file.path]) {
        nodes[file.path] = {
          ...file,
          depth: file.path.split('/').filter(p => p).length - 1,
          children: file.is_dir ? [] : undefined,
          isExpanded: file.is_dir,
        };
      }

      // Create nodes for parent directories
      let currentPath = file.path;
      while (currentPath.includes('/')) {
        const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
        if (!parentPath) break; // Reached root

        if (!nodes[parentPath]) {
          nodes[parentPath] = {
            name: parentPath.split('/').pop()!,
            path: parentPath,
            is_dir: true,
            size: 0,
            mtime: 0,
            depth: parentPath.split('/').filter(p => p).length -1,
            children: [],
            isExpanded: true, // Expand directories containing search results
            isLoading: false,
          };
        } else {
            // Ensure existing parent directories are expanded
            if(nodes[parentPath].is_dir){
              nodes[parentPath].isExpanded = true;
            }
        }
        currentPath = parentPath;
      }
    });
    
    const tree: FileTreeNode[] = [];
    Object.values(nodes).forEach(node => {
      const parentPath = node.path.substring(0, node.path.lastIndexOf('/'));
      if (nodes[parentPath] && nodes[parentPath].children) {
          if (!nodes[parentPath].children!.some(child => child.path === node.path)) {
            nodes[parentPath].children!.push(node);
          }
      } else {
        tree.push(node);
      }
    });

    // Sort children at each level
    const sortChildren = (node: FileTreeNode) => {
        if (node.children) {
            node.children.sort((a, b) => {
                if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
                return b.mtime - a.mtime; // Sort by last modified time in descending order
            });
            node.children.forEach(sortChildren);
        }
    };
    tree.forEach(sortChildren);
    tree.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return b.mtime - a.mtime; // Sort by last modified time in descending order
    });

    // Group WSI and H5 files
    return groupWSIAndH5Files(tree);
  };

  // Helper function to recursively find and update a node in the tree
  const updateNodeByPath = (nodes: FileTreeNode[], path: string, updates: Partial<FileTreeNode>): FileTreeNode[] => {
      return nodes.map(node => {
          if (node.path === path) {
              return { ...node, ...updates };
          }
          if (node.children) {
              return { ...node, children: updateNodeByPath(node.children, path, updates) };
          }
          return node;
    });
  };

  const toggleFolder = async (nodeToToggle: FileTreeNode) => {
      // If folder is already expanded, just collapse it
      if (nodeToToggle.isExpanded) {
          const updatedTree = updateNodeByPath(fileTree, nodeToToggle.path, { isExpanded: false });
          dispatch(setFileTree(updatedTree));
          return;
      }

      // If it has children already, just expand
      if (nodeToToggle.children && nodeToToggle.children.length > 0) {
          const updatedTree = updateNodeByPath(fileTree, nodeToToggle.path, { isExpanded: true });
          dispatch(setFileTree(updatedTree));
          return;
      }

      // Otherwise, fetch children
      const updatedTree = updateNodeByPath(fileTree, nodeToToggle.path, { isLoading: true });
      dispatch(setFileTree(updatedTree));
      try {
          const childrenItems: FileItem[] = await apiListFiles(nodeToToggle.path);
          const sortedChildren = childrenItems.sort((a, b) => {
              if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
              return b.mtime - a.mtime; // Sort by last modified time in descending order
          });
          
          // If current directory is within shared scope, propagate shared flags and owner display
          let sharedByOwnerShort: string | undefined = undefined;
          if (sharedScopeRef.current) {
            const parts = sharedScopeRef.current.split('/');
            if (parts.length >= 2 && parts[0] === 'users') {
              const ownerId = parts[1];
              sharedByOwnerShort = ownerId ? ownerId.substring(0, 8) : undefined;
            }
          }

          const childrenNodes: FileTreeNode[] = sortedChildren.map(child => ({
              ...child,
              depth: nodeToToggle.depth + 1,
              children: child.is_dir ? [] : undefined,
              ...(sharedByOwnerShort ? { isShared: true as const, sharedBy: sharedByOwnerShort } : {}),
          }));

          // Group WSI and H5 files in children
          const groupedChildren = groupWSIAndH5Files(childrenNodes);
          
          const finalTree = updateNodeByPath(fileTree, nodeToToggle.path, {
              isExpanded: true,
              isLoading: false,
              children: groupedChildren,
          });
          dispatch(setFileTree(finalTree));

      } catch (err: any) {
          dispatch(setError(`Failed to load folder: ${nodeToToggle.name}`));
          const errorTree = updateNodeByPath(fileTree, nodeToToggle.path, { isLoading: false });
          dispatch(setFileTree(errorTree));
      }
  };

  const requestSort = (key: 'name' | 'mtime' | 'size' | 'type') => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    dispatch(setSortConfig({ key, direction }));
  };


  useEffect(() => {
    // Load the last visited directory or defaultPath on mount.
    const initialize = async () => {
        try {
            if (!defaultPathRef.current) {
              const cfg = await getConfig();
              defaultPathRef.current = (cfg?.defaultPath || '').replace(/\\/g, '/');
            }
            // Fetch initial quota
            await refreshQuota();
            const auth = getAuth(app);
            
            // Use currentDirectory from Redux state, fallback to default paths
            let initialPath = currentDirectory;
            if (!initialPath) {
              initialPath = auth.currentUser ? VIRTUAL_ROOT : 'samples';
            }
            
            await fetchFiles(initialPath);
        } catch (err: any) {
            dispatch(setError("Failed to load server configuration. Please check the backend connection."));
        }
    };
    initialize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, refreshQuota, fetchFiles]);

  // Listen to LocalFileManager upload-complete event to refresh list + quota
  useEffect(() => {
    const handler = (e: any) => {
      const nextPath = e?.detail?.path || currentDirectory;
      // Soft refresh current directory
      fetchFiles(nextPath);
      refreshQuota();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('tissuelab:cloudUploadCompleted', handler);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('tissuelab:cloudUploadCompleted', handler);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshQuota, fetchFiles]);

  // Refresh quota after uploads complete
  useEffect(() => {
    if (!uploadSettings?.isUploading) {
      refreshQuota();
    }
  }, [uploadSettings?.isUploading, refreshQuota]);

  // Reset state when user transitions from guest -> logged-in
  useEffect(() => {
    const auth = getAuth(app);
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      // Update authUserId for breadcrumb remounting
      setAuthUserId(user ? user.uid : 'guest');
      if (typeof window === 'undefined') return;
      
      if (user) {
        const userId = user.uid;
        const lastUserId = sessionStorage.getItem('tl_last_user_id');
        
        // Only reset if different user logged in (user switched)
        if (lastUserId !== userId) {
          try { 
            await auth.authStateReady(); 
          } catch {}
          
          sessionStorage.setItem('tl_last_user_id', userId);
          
          // Reset Redux state instead of page reload
          dispatch(resetWebFileManager());
          
          // Force component re-render with new key prefix
          setKeyPrefix(`wfm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);

          // Refresh personal root path for the logged-in user
          try {
            const cfg = await getConfig();
            defaultPathRef.current = (cfg?.defaultPath || '').replace(/\\/g, '/');
          } catch (e) {
            // Fallback to empty; subsequent calls will resolve as needed
            defaultPathRef.current = '';
          }
          
          // Re-fetch files for the new user
          const initialPath = user ? VIRTUAL_ROOT : 'samples';
          await fetchFiles(initialPath);
          
          // Refresh quota for the new user
          await refreshQuota();
        }
      } else {
        // clear user ID on logout
        sessionStorage.removeItem('tl_last_user_id');
        
        // Reset to guest state
        dispatch(resetWebFileManager());
        
        // Force component re-render with new key prefix
        setKeyPrefix(`wfm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
        
        // Clear personal root path so guest defaults to samples via config
        defaultPathRef.current = '';
        
        // Refresh file list for guest state
        const guestPath = 'samples';
        await fetchFiles(guestPath);
      }
    });
    return () => unsubscribe();
  }, [dispatch, refreshQuota, fetchFiles]);

  useEffect(() => {
    if (dialog?.type === 'create-folder' || dialog?.type === 'rename') {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [dialog]);

  const handleFolderSelect = async () => {
    // This function is now only for creating a new root selection, which is not applicable
    // in the web-style architecture. Could be re-purposed for other uploads later.
    alert("The file manager is now operating in a secure web-based mode. The root directory is fixed on the server.");
  };

  const handleItemClick = (item: FileTreeNode, e: React.MouseEvent) => {
    // @ts-ignore
    if (item.isParentLink) {
      // Respect the up-node target path directly to avoid being stuck in shared root
      const target = item.path;
      if (target === VIRTUAL_ROOT) {
        sharedScopeRef.current = null;
        sharedBrowseModeRef.current = false;
      } else if (target === SHARED_ROOT) {
        // Reset scope when going back to shared root
        sharedScopeRef.current = null;
        sharedBrowseModeRef.current = true;
      }
      fetchFiles(target);
      return;
    }
    
    if (item.is_dir) {
      // Check if we're in shared context
      const { inSharedContext } = computeFsPermissions(currentDirectory);
      if (inSharedContext) {
        // If in shared context, clicking a folder should navigate within shared context
        fetchFiles(item.path);
      } else {
        fetchFiles(item.path);
      }
    } else if (isWSI(item.name)) {
      handleWsiUpload(item.path);
    } else if (isH5(item.name)) {
      // For H5 files, try to find and open the corresponding WSI file
      const h5BaseName = getWSIBaseName(item.name);
      const parentDir = item.path.substring(0, item.path.lastIndexOf('/'));
      // Try to find the corresponding WSI file in the same directory
      const wsiFile = fileTree.find(file =>
        !file.is_dir &&
        isWSI(file.name) &&
        file.name.startsWith(h5BaseName) &&
        file.path.startsWith(parentDir)
      );
      if (wsiFile) {
        handleWsiUpload(wsiFile.path);
      } else {
        console.log("No corresponding WSI file found for H5 file:", item.path);
      }
    } else {
      console.log("Opening non-WSI file:", item.path);
      // Add logic for other file types if needed
    }
  };

  const handleItemDoubleClick = (item: FileTreeNode) => {
    if (item.is_dir) {
      // Check if we're in shared context
      const { inSharedContext } = computeFsPermissions(currentDirectory);
      if (inSharedContext) {
        // If in shared context, double-clicking a folder should navigate within shared context
        fetchFiles(item.path);
      } else {
        fetchFiles(item.path);
      }
    } else if (isWSI(item.name)) {
      handleWsiUpload(item.path);
    } else if (isH5(item.name)) {
      // Do nothing for H5 double-click
      console.log("H5 file double-clicked (no action):", item.path);
    } else {
      console.log("Opening non-WSI file:", item.path);
      // Add logic for other file types if needed
    }
  };
  
  const handleWsiUpload = async (relativePath: string) => {
    try {
      console.log('FileManager: Starting WSI upload for:', relativePath);
      
      // Save shared context before navigating to ImageViewer
      if (sharedBrowseModeRef.current || sharedScopeRef.current) {
        saveSharedContextToSession();
      }
      
      // Step 1: Upload file path
      const uploadData = await uploadFilePath(relativePath);
      console.log('FileManager: uploadData:', uploadData);
      
      // Step 2: Create instance (this is the missing step!)
      const instanceData = await createInstance(uploadData.filePath || uploadData.file_path || uploadData.filename);
      console.log('FileManager: instanceData:', instanceData);
      
      // Step 3: Load file data
      const loadData = await loadFileData(uploadData.filename);
      console.log('FileManager: loadData:', loadData);
      
      // Step 4: Set all the necessary data in Redux
      dispatch(updateInstanceWSIInfo(loadData));
      dispatch(setCurrentPath({ path: relativePath }) as PayloadAction<{ path: string | null }>);
      dispatch(setSlideInfo({
        dimensions: uploadData.dimensions,
        fileSize: uploadData.file_size,
        mpp: uploadData.mpp,
        magnification: uploadData.magnification,
        imageType: uploadData.image_type || (uploadData.file_format === 'qptiff' && uploadData.total_channels && uploadData.total_channels > 3) ? 'Multiplex Immunofluorescent' : 'Brightfield H&E'
      }));
      if (uploadData.total_channels) {
        dispatch(setTotalChannels(uploadData.total_channels));
      }
      
      // Step 5: Replace current instance with new WSI data (overwrite current window)
      dispatch(replaceCurrentInstance({
        instanceId: instanceData.instanceId,
        wsiInfo: {
          ...loadData,
          instanceId: instanceData.instanceId
        },
        fileInfo: {
          fileName: relativePath.split(/[\\/]/).pop() || '',
          filePath: relativePath,
          source: 'web'
        }
      }));
      
      console.log('FileManager: Instance created successfully with ID:', instanceData.instanceId);
      
      // Update multi-window state to ensure proper highlighting
      dispatch(updateWindowImage({ windowId: activeWindow, imagePath: relativePath }));
      
      dispatch(setImageLoaded(true));
      router.push('/imageViewer');
    } catch(err) {
        console.error("Error processing WSI file:", err);
        dispatch(setError("Failed to load WSI file."));
    }
  }

  const getAllImageFiles = useCallback(() => {
    const imageFiles: Array<{
      name: string;
      path: string;
      fullPath: string;
      size: number;
      mtime: number;
      isH5: boolean;
    }> = [];
    
    const extractImages = (nodes: FileTreeNode[], basePath: string = '') => {
      nodes.forEach(node => {
        if (node.is_dir && node.children) {
          extractImages(node.children, basePath ? `${basePath}/${node.name}` : node.name);
        } else if (!node.is_dir && (isWSI(node.name) || isH5(node.name))) {
          imageFiles.push({
            name: node.name,
            path: node.path,
            fullPath: node.path,
            size: node.size,
            mtime: node.mtime,
            isH5: isH5(node.name)
          });
        }
      });
    };
    
    extractImages(fileTree);
    return imageFiles;
  }, [fileTree]);

  const renderImageTable = () => {
    const imageFiles = getAllImageFiles();
    
    if (imageFiles.length === 0) {
      return (
        <div className="text-gray-500 text-center py-8">
          No image files found in the current directory.
        </div>
      );
    }

    return (
      <div className="w-full">
        {/* Header */}
        <div 
          className="grid gap-2 p-3 bg-gray-50 border-b font-medium text-sm"
          style={{ gridTemplateColumns: '0.5fr 2fr 1.8fr 1.2fr 2fr 1.2fr' }}
        >
          <div className="text-center">#</div>
          <div className="text-left">Filename</div>
          <div className="text-center">Thumbnail</div>
          <div className="text-center">Label</div>
          <div className="text-center">Macro</div>
          <div className="text-center">Actions</div>
        </div>

        {/* Table Body */}
        <div className="divide-y divide-gray-200">
          {imageFiles
            .sort((a, b) => {
              if (sortConfig.key === 'name') {
                return sortConfig.direction === 'asc' 
                  ? a.name.localeCompare(b.name)
                  : b.name.localeCompare(a.name);
              }
              if (sortConfig.key === 'mtime') {
                return sortConfig.direction === 'asc'
                  ? a.mtime - b.mtime
                  : b.mtime - a.mtime;
              }
              if (sortConfig.key === 'size') {
                return sortConfig.direction === 'asc'
                  ? a.size - b.size
                  : b.size - a.size;
              }
              return 0;
            })
            .map((file, index) => (
              <div 
                key={`card:${file.path || file.name}-${index}`} 
                className="grid gap-2 p-3 hover:bg-gray-50 border-b items-center min-h-[120px]"
                style={{ gridTemplateColumns: '0.5fr 2fr 1.8fr 1.2fr 2fr 1.2fr' }}
              >
                {/* Row Number */}
                <div className="text-center text-sm font-medium text-gray-600">
                  {index + 1}
                </div>

                {/* Filename */}
                <div className="flex flex-col justify-center min-h-[80px] pr-2">
                  <button
                    className="text-blue-600 hover:underline text-left text-sm font-medium leading-tight break-words"
                    onClick={() => {
                      if (file.isH5) {
                        // For H5 files, try to find and open the corresponding WSI file
                        const h5BaseName = getWSIBaseName(file.name);
                        const parentDir = file.path.substring(0, file.path.lastIndexOf('/'));
                        // Try to find the corresponding WSI file in the same directory
                        const wsiFile = fileTree.find(treeFile => 
                          !treeFile.is_dir && 
                          isWSI(treeFile.name) && 
                          treeFile.name.startsWith(h5BaseName) &&
                          treeFile.path.startsWith(parentDir)
                        );
                        if (wsiFile) {
                          handleWsiUpload(wsiFile.path);
                        } else {
                          console.log("No corresponding WSI file found for H5 file:", file.path);
                          message.warning("No corresponding WSI file found for this H5 file");
                        }
                      } else {
                        handleWsiUpload(file.path);
                      }
                    }}
                    title={file.fullPath}
                    style={{ wordBreak: 'break-all', lineHeight: '1.2' }}
                  >
                    {file.name}
                  </button>
                  <div className="text-xs text-gray-500 mt-1">
                    Size: {formatBytes(file.size)}
                  </div>
                  <div className="text-xs text-gray-500">
                    Modified: {new Date(file.mtime * 1000).toLocaleDateString()}
                  </div>
                </div>

                {/* Thumbnail */}
                <div className="flex justify-center">
                  <div className="w-full max-w-[140px] aspect-[4/3] border rounded bg-white shadow-sm">
                    {file.isH5 ? (
                      <div className="w-full h-full flex items-center justify-center bg-orange-50">
                        <div className="text-center">
                          <File className="h-8 w-8 text-orange-500 mx-auto mb-1" />
                          <div className="text-xs text-orange-600">H5 File</div>
                        </div>
                      </div>
                    ) : (
                      <ImagePreviewCell 
                        fileName={file.name} 
                        fullPath={file.fullPath}
                        imageType="thumbnail"
                      />
                    )}
                  </div>
                </div>

                {/* Label */}
                <div className="flex justify-center">
                  <div className="w-full max-w-[100px] aspect-[4/3] border rounded bg-white shadow-sm">
                    {file.isH5 ? (
                      <div className="w-full h-full flex items-center justify-center bg-orange-50">
                        <div className="text-center">
                          <File className="h-6 w-6 text-orange-500 mx-auto mb-1" />
                          <div className="text-xs text-orange-600">H5</div>
                        </div>
                      </div>
                    ) : (
                      <ImagePreviewCell 
                        fileName={file.name} 
                        fullPath={file.fullPath}
                        imageType="label"
                      />
                    )}
                  </div>
                </div>

                {/* Macro */}
                <div className="flex justify-center">
                  <div className="w-full max-w-[160px] aspect-[4/3] border rounded bg-white shadow-sm">
                    {file.isH5 ? (
                      <div className="w-full h-full flex items-center justify-center bg-orange-50">
                        <div className="text-center">
                          <File className="h-6 w-6 text-orange-500 mx-auto mb-1" />
                          <div className="text-xs text-orange-600">H5</div>
                        </div>
                      </div>
                    ) : (
                      <ImagePreviewCell 
                        fileName={file.name} 
                        fullPath={file.fullPath}
                        imageType="macro"
                      />
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex justify-center">
                  <Button
                    size="sm"
                    className="bg-blue-500 hover:bg-blue-600 text-white text-xs px-3 py-1"
                    onClick={() => {
                      if (file.isH5) {
                        // For H5 files, try to find and open the corresponding WSI file
                        const h5BaseName = getWSIBaseName(file.name);
                        const parentDir = file.path.substring(0, file.path.lastIndexOf('/'));
                        // Try to find the corresponding WSI file in the same directory
                        const wsiFile = fileTree.find(treeFile => 
                          !treeFile.is_dir && 
                          isWSI(treeFile.name) && 
                          treeFile.name.startsWith(h5BaseName) &&
                          treeFile.path.startsWith(parentDir)
                        );
                        if (wsiFile) {
                          handleWsiUpload(wsiFile.path);
                        } else {
                          console.log("No corresponding WSI file found for H5 file:", file.path);
                          message.warning("No corresponding WSI file found for this H5 file");
                        }
                      } else {
                        handleWsiUpload(file.path);
                      }
                    }}
                  >
                    Open
                  </Button>
                </div>
              </div>
            ))}
        </div>
      </div>
    );
  };

  const handleGoUp = () => {
    const auth = getAuth(app);
    const isLoggedIn = !!auth.currentUser;
    
    if (isLoggedIn) {
      // If currently at shared root, go back to virtual root (Root)
      if (currentDirectory === SHARED_ROOT) {
        sharedScopeRef.current = null;
        sharedBrowseModeRef.current = false;
        fetchFiles(VIRTUAL_ROOT);
        return;
      }
      
      // In shared context: go up within scope; when at scope top, return to shared root
      const { inSharedContext } = computeFsPermissions(currentDirectory);
      
      if (inSharedContext) {
        const scope = sharedScopeRef.current;
        
        if (scope && currentDirectory.startsWith(scope) && currentDirectory !== scope) {
          const parentPathRaw = getParentPath(currentDirectory);
          const parentPath = parentPathRaw.startsWith(scope) ? parentPathRaw : scope;
          fetchFiles(parentPath);
          return;
        }
        // at the top of scope or scope is unknown => back to shared root
        sharedScopeRef.current = null;
        fetchFiles(SHARED_ROOT);
        return;
      }
      
      if (currentDirectory === VIRTUAL_ROOT) {
        return; // already at top
      }
      const personalRoot = defaultPathRef.current || '';
      // For shared namespace: users/<uid> should go back to SHARED_ROOT
      const parts = (currentDirectory || '').split('/').filter(p => p);
      const isAtSharedUserTop = parts.length === 2 && parts[0] === 'users';
      
      if (currentDirectory === personalRoot || currentDirectory === 'samples' || currentDirectory === SHARED_ROOT) {
        fetchFiles(VIRTUAL_ROOT);
        return;
      }
      if (isAtSharedUserTop) {
        // Leaving scoped folder: clear scope and go back to shared root
        sharedScopeRef.current = null;
        fetchFiles(SHARED_ROOT);
        return;
      }
      const parentPath = currentDirectory.includes('/') ? currentDirectory.substring(0, currentDirectory.lastIndexOf('/')) : VIRTUAL_ROOT;
      // Respect shared scope when navigating up
      const scope = sharedScopeRef.current;
      if (scope && !parentPath.startsWith(scope)) {
        sharedScopeRef.current = null;
        fetchFiles(SHARED_ROOT);
        return;
      }
      fetchFiles(parentPath);
    } else {
      // guest: samples is the top
      if (!currentDirectory || currentDirectory === 'samples') {
        return;
      }
      const parentPath = currentDirectory.includes('/') ? currentDirectory.substring(0, currentDirectory.lastIndexOf('/')) : 'samples';
      fetchFiles(parentPath);
    }
  };
  
  // --- Drag and Drop Handlers ---
  const handleDragStart = (e: React.DragEvent, itemPath: string) => {
    setDraggingItem(itemPath);
    setDragOverTarget(null); // Clear any previous drag over target
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    setDraggingItem(null);
    setDragOverTarget(null);
  };

  const handleDragOver = (e: React.DragEvent, targetPath?: string) => {
    e.preventDefault(); // Necessary to allow dropping
    e.dataTransfer.dropEffect = 'move';
    if (targetPath !== undefined && draggingItem) {
      setDragOverTarget(targetPath);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Clear drag over target when leaving, but with a small delay to prevent flickering
    const relatedTarget = e.relatedTarget as Node;
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
      setTimeout(() => {
        setDragOverTarget(null);
      }, 10);
    }
  };

  const handleDrop = async (e: React.DragEvent, targetFolder: FileTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    // @ts-ignore
    const isParentLink = !!targetFolder.isParentLink;
    if (!draggingItem || !targetFolder.is_dir) return;

    let destinationPath = targetFolder.path;

    const { canMoveTo } = computeFsPermissions(currentDirectory);
    if (!canMoveTo(destinationPath)) {
      setDraggingItem(null);
      return;
    }

    // If dropping on the ".." parent link, move to parent directory
    if (isParentLink) {
        destinationPath = targetFolder.path;
    }

    // Get the source parent path of the dragged item
    const sourceParentPath = draggingItem.substring(0, draggingItem.lastIndexOf('/')) || '';
    
    // Only allow moving if we're dropping on a different directory level
    // This prevents moving files within the same expanded directory
    if (sourceParentPath === destinationPath) {
        setDraggingItem(null);
        return; // It's a no-op, we're not moving anywhere.
    }
    
    // Prevent moving a folder into itself or one of its own subdirectories
    const flatTree = flattenTree(fileTree);
    const itemNode = flatTree.find(node => node.path === draggingItem);
    if (itemNode && itemNode.is_dir) {
         if (destinationPath === draggingItem || destinationPath.startsWith(draggingItem + '/')) {
            dispatch(setError("Cannot move a folder into itself."));
            setDraggingItem(null);
            return;
        }
    }

    try {
        await apiMoveFiles([draggingItem], destinationPath);
        // Refresh the current directory but try to preserve the expanded state
        await fetchFiles(currentDirectory); 
    } catch (err: any) {
        // Check if it's a 403 permission error
        if (err.status === 403) {
            message.error('Permission denied. You may need administrator privileges to move files here.');
        } else if (err.message && err.message.includes('currently in use')) {
            message.warning(err.message);
        } else {
            dispatch(setError(err.message));
        }
    }
    setDraggingItem(null);
    setDragOverTarget(null);
  };

  const handleDropOnCurrentDirectory = async (e: React.DragEvent) => {
    e.preventDefault();
    const { canDropToCurrent } = computeFsPermissions(currentDirectory);
    if (!canDropToCurrent) {
      setDraggingItem(null);
      setDragOverTarget(null);
      return;
    }
    if (!draggingItem) {
      setDraggingItem(null);
      setDragOverTarget(null);
      return;
    }

    // Get the source parent path of the dragged item
    const sourceParentPath = draggingItem.includes('/') ? draggingItem.substring(0, draggingItem.lastIndexOf('/')) : '';
    
    // Only allow moving if we're dropping on a different directory level
    // This prevents moving files within the same expanded directory
    if (sourceParentPath === currentDirectory) {
      setDraggingItem(null);
      setDragOverTarget(null);
      return;
    }

    // Move file to the current directory being viewed
    const destinationPath = currentDirectory;

    try {
      await apiMoveFiles([draggingItem], destinationPath);
      await fetchFiles(currentDirectory);
    } catch (err: any) {
      // Check if it's a 403 permission error
      if (err.status === 403) {
          message.error('Permission denied. You may need administrator privileges to move files here.');
      } else if (err.message && err.message.includes('currently in use')) {
          message.warning(err.message);
      } else {
          dispatch(setError(err.message));
      }
    }
    setDraggingItem(null);
    setDragOverTarget(null);
  };


  // --- File Upload Handler ---
  const handleFileUpload = async (files: FileList | null, forceOverwrite: boolean = false) => {
    if (!files || files.length === 0) return;
    const { canUpload } = computeFsPermissions(currentDirectory);
    if (!canUpload) {
      message.warning('Please open Personal or its subfolder to upload files.');
      return;
    }
    
    const fileArray = Array.from(files);

    
    // Validate files
    const validFiles = fileArray.filter(file => {
      if (file.size === 0) {
        console.warn(`Skipping empty file: ${file.name}`);
        return false;
      }
      if (!file.name || file.name.trim() === '') {
        console.warn(`Skipping file with empty name`);
        return false;
      }
      return true;
    });
    
    if (validFiles.length === 0) {
      message.warning('No valid files to upload.');
      return;
    }
    
    if (validFiles.length !== fileArray.length) {
      console.log(`Filtered out ${fileArray.length - validFiles.length} invalid files`);
    }
    
    // Check for existing files and prompt for overwrite (unless forceOverwrite is true)
    let hasConflicts = false;
    if (!forceOverwrite) {
      try {
        const listing = await apiListFiles(currentDirectory);
        const filesArr: any[] = Array.isArray(listing)
          ? listing
          : (listing?.files || listing?.items || []);
        
        const existingFiles = validFiles.filter(file => 
          filesArr.some((f: any) => (f?.name || f?.filename) === file.name)
        );
        
        if (existingFiles.length > 0) {
          hasConflicts = true;
          const confirmed = await new Promise<boolean>((resolve) => {
            overwriteResolverRef.current = resolve;
            setOverwriteFiles(existingFiles);
            setPendingUploadFiles(validFiles);
            setOverwriteDialogOpen(true);
          });
          
          if (!confirmed) {
            message.info('Upload cancelled due to file conflicts');
            return;
          }
          // If confirmed, continue with overwrite=true for all files
        }
      } catch (e) {
        console.warn('Failed to check for existing files:', e);
        // Continue with upload if check fails
      }
    } else {
      hasConflicts = true; // Force overwrite mode
    }
    
    // Reset upload state
    dispatch(setUploadSettings({ isUploading: true, uploadProgress: 0 }));
    setUploadInterrupted(false);
    
    // Separate files by size
    const smallFiles = validFiles.filter(file => file.size < 50 * 1024 * 1024); // 50MB threshold
    const largeFiles = validFiles.filter(file => file.size >= 50 * 1024 * 1024);
    
    // Track upload results
    const uploadResults = {
      successful: 0,
      cancelled: 0,
      failed: 0,
      total: validFiles.length
    };
    
    try {
      // Upload small files first
      if (smallFiles.length > 0) {
        const smallFileResults = await uploadSmallFiles(smallFiles, hasConflicts);
        uploadResults.successful += smallFileResults.successful;
        uploadResults.cancelled += smallFileResults.cancelled;
        uploadResults.failed += smallFileResults.failed;
      }
      
      // Upload large files
      if (largeFiles.length > 0) {
        const largeFileResults = await uploadLargeFiles(largeFiles, hasConflicts);
        uploadResults.successful += largeFileResults.successful;
        uploadResults.cancelled += largeFileResults.cancelled;
        uploadResults.failed += largeFileResults.failed;
      }
      
      // Show appropriate message based on results
      await showUploadResults(uploadResults);
      
      // Final progress update after all uploads complete with a small delay
      setTimeout(() => {
        safeUpdateOverallProgress();
      }, 100);
      
    } catch (error: any) {
      console.error('Upload process failed:', error);
      
      // Check if it's a cancellation error
      if (error.message && error.message.includes('cancelled')) {
        setUploadInterrupted(true);
        message.warning('Upload was interrupted. Some files may not have been uploaded completely.');
      } else {
        message.error(`Upload failed: ${error.message}`);
      }
    } finally {
      // Only clean up upload state if all uploads are truly complete
      // Check if there are any ongoing uploads
      const hasOngoingUploads = Array.from(uploadStatus.values()).some(
        status => status.status === 'Uploading' || status.status === 'Paused'
      );

      if (!hasOngoingUploads) {
        // Clean up upload state only when no uploads are ongoing
        dispatch(setUploadSettings({ isUploading: false, uploadProgress: 0 }));

        // Event-driven approach: Wait for all tracked uploads to complete
        const waitForAllUploadsToComplete = async () => {
          if (uploadCompletionTracker.current.hasActiveUploads()) {
            await uploadCompletionTracker.current.waitForAll();
          }

          // Give one final progress update to show completion
          safeUpdateOverallProgress();

          // Small delay for smooth UI transition
          await new Promise(resolve => setTimeout(resolve, 100));

          cleanupUploadState();
        };

        waitForAllUploadsToComplete();
      } else {
        // Still have ongoing uploads, just mark as not uploading
        dispatch(setUploadSettings({ isUploading: false }));

      }
    }
  };

    // Handle small file uploads (simple, direct upload)
  const uploadSmallFiles = async (files: File[], hasConflicts: boolean = false): Promise<{ successful: number; cancelled: number; failed: number }> => {
    if (files.length === 0) return { successful: 0, cancelled: 0, failed: 0 };

    // Create individual upload promises for each file
    const uploadPromises = files.map(file => {
      const fileId = `small_${file.name}_${file.size}_${Date.now()}`;
      const uploadPromise = (async () => {
        try {
          const fileList = new DataTransfer();
          fileList.items.add(file);
          await apiUploadFiles(currentDirectory, fileList.files, (percent) => {
            const updatedStatus = updateFileUploadStatus(fileId, file, percent, 'Uploading', Date.now());
            safeUpdateOverallProgress();
          }, hasConflicts); // Use overwrite only if there were conflicts and user confirmed
          return { successful: 1, cancelled: 0, failed: 0 };
        } catch (error: any) {
          console.error('Small files upload failed:', error);
          if (error.message && error.message.includes('cancelled')) {
            return { successful: 0, cancelled: 1, failed: 0 };
          } else {
            return { successful: 0, cancelled: 0, failed: 1 };
          }
        }
      })();

      // Track this upload in the completion tracker
      uploadCompletionTracker.current.add(fileId);
      uploadPromise.finally(() => {
        uploadCompletionTracker.current.complete(fileId);
      });
      return uploadPromise;
    });

    try {
      const results = await Promise.all(uploadPromises);

      // Aggregate results
      return results.reduce((acc, result) => ({
        successful: acc.successful + result.successful,
        cancelled: acc.cancelled + result.cancelled,
        failed: acc.failed + result.failed
      }), { successful: 0, cancelled: 0, failed: 0 });

    } catch (error) {
      console.error('Small files upload process failed:', error);
      return { successful: 0, cancelled: 0, failed: files.length };
    }
  };

  // Handle large file uploads (chunked upload)
  const uploadLargeFiles = async (files: File[], hasConflicts: boolean = false): Promise<{ successful: number; cancelled: number; failed: number }> => {
    if (files.length === 0) return { successful: 0, cancelled: 0, failed: 0 };

    const results = {
      successful: 0,
      cancelled: 0,
      failed: 0
    };

    const uploadPromises = files.map(file => uploadSingleLargeFile(file, hasConflicts));

    try {
      const settledResults = await Promise.allSettled(uploadPromises);

      settledResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const fileResult = result.value;
          results.successful += fileResult.successful;
          results.cancelled += fileResult.cancelled;
          results.failed += fileResult.failed;
        } else {
          results.failed++;
          const fileName = files[index]?.name || `File ${index}`;
          console.error(`Upload failed for ${fileName}:`, result.reason);
        }
      });



      setTimeout(() => {
        safeUpdateOverallProgress();
      }, 100);

      await new Promise(resolve => setTimeout(resolve, 100));

      return results;

    } catch (error) {
      console.error('Large files upload process failed:', error);
      const remainingFiles = files.length - results.successful - results.cancelled - results.failed;
      results.failed += remainingFiles;
      return results;
    }
  };

  // Upload a single large file
  const uploadSingleLargeFile = async (file: File, hasConflicts: boolean = false): Promise<{ successful: number; cancelled: number; failed: number }> => {
    const fileId = `${file.name}_${file.size}_${Date.now()}`;
    const startTime = Date.now();

    // Track this upload in the completion tracker
    const uploadPromise = uploadCompletionTracker.current.add(fileId);

    let localStatus: { progress: number; status: 'Uploading' | 'Paused' | 'Cancelled' | 'Error' | 'Completed'; error?: string; uploadTime?: number; estimatedTimeRemaining?: number; retryCount?: number; startTime?: number; fileSize?: number; fileName?: string } | null = null;

    console.log(`Starting chunked upload for ${file.name}`);

    try {
      const manager = new ChunkedUploadManager(
        file.name,
        file,
        currentDirectory,
        (progress) => {
          const updatedStatus = updateFileUploadStatus(fileId, file, progress, 'Uploading', startTime);
          localStatus = updatedStatus;
          safeUpdateOverallProgress();
        },
        (error) => {
          console.error(`Upload failed for ${file.name}:`, error);
          const errorMessage = error && typeof error === 'object' && 'message' in error ? (error as Error).message : String(error);
          // More robust cancellation detection
          const isCancelled = errorMessage.toLowerCase().includes('cancel') ||
                             errorMessage.toLowerCase().includes('abort') ||
                             errorMessage.toLowerCase().includes('user cancelled');
          const status = isCancelled ? 'Cancelled' : 'Error';
          const updatedStatus = updateFileUploadStatus(fileId, file, 0, status, startTime, errorMessage);
          localStatus = updatedStatus;
          safeUpdateOverallProgress();
        },
        (result) => {
          console.log(`Upload completed for ${file.name}`);
          const completedStatus = updateFileUploadStatus(fileId, file, 100, 'Completed', startTime);
          localStatus = completedStatus;
          safeUpdateOverallProgress();
        },
        (status) => {
          console.log(`Status change for ${file.name}: ${status}`);
          let statusValue: 'Uploading' | 'Paused' | 'Cancelled' | 'Error' | 'Completed';

          switch (status) {
            case 'uploading':
              statusValue = 'Uploading';
              break;
            case 'paused':
              statusValue = 'Paused';
              break;
            case 'cancelled':
              statusValue = 'Cancelled';
              break;
            case 'error':
              statusValue = 'Error';
              break;
            case 'completed':
              statusValue = 'Completed';
              break;
            default:
              statusValue = 'Uploading';
          }

          const currentStatus = uploadStatus.get(fileId);
          const currentProgress = currentStatus ? currentStatus.progress : 0;
          const updatedStatus = updateFileUploadStatus(fileId, file, currentProgress, statusValue, startTime);

          localStatus = updatedStatus;

          setTimeout(() => {
            safeUpdateOverallProgress();
          }, 50);
        },
        hasConflicts // Use overwrite only if there were conflicts and user confirmed
      );

      setChunkedUploadManagers(prev => new Map(prev).set(fileId, manager));

      const uploadPromise = manager.start();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Upload timeout - no response from server')), 300000);
      });

      await Promise.race([uploadPromise, timeoutPromise]);

      // Wait a bit for any pending status updates to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      const finalStatus = localStatus || uploadStatus.get(fileId);


      // Determine result based on final status with consistent logic
      if (finalStatus) {
        if (finalStatus.status === 'Completed' || finalStatus.progress === 100) {

          return { successful: 1, cancelled: 0, failed: 0 };
        } else if (finalStatus.status === 'Cancelled' || (finalStatus.error && finalStatus.error.toLowerCase().includes('cancelled'))) {

          return { successful: 0, cancelled: 1, failed: 0 };
        } else if (finalStatus.status === 'Error' || finalStatus.error) {
          console.log(`File ${file.name} upload failed with error: ${finalStatus.error}`);
          return { successful: 0, cancelled: 0, failed: 1 };
        } else {

          // If we can't determine the status clearly, treat as failed to be safe
          return { successful: 0, cancelled: 0, failed: 1 };
        }
      } else {

        return { successful: 0, cancelled: 0, failed: 1 };
      }

    } catch (error: any) {
      console.error(`Upload error for ${file.name}:`, error);

      setChunkedUploadManagers(prev => {
        const newMap = new Map(prev);
        newMap.delete(fileId);
        return newMap;
      });

      if (error.message && error.message.includes('cancelled')) {
        updateFileUploadStatus(fileId, file, 0, 'Cancelled', startTime, 'Upload cancelled');
        return { successful: 0, cancelled: 1, failed: 0 };
      } else if (error.message && error.message.includes('timeout')) {
        updateFileUploadStatus(fileId, file, 0, 'Error', startTime, 'Upload timeout - server not responding');
        return { successful: 0, cancelled: 0, failed: 1 };
      } else {
        updateFileUploadStatus(fileId, file, 0, 'Error', startTime, error.message || 'Upload failed');
        const result = { successful: 0, cancelled: 0, failed: 1 };
        // Mark upload as completed
        uploadCompletionTracker.current.complete(fileId);
        return result;
      }
    }

    // Mark upload as completed for successful cases
    uploadCompletionTracker.current.complete(fileId);
  };

  // Update individual file upload status
  const updateFileUploadStatus = (
    fileId: string, 
    file: File, 
    progress: number, 
    status: 'Uploading' | 'Paused' | 'Cancelled' | 'Error' | 'Completed',
    startTime: number,
    error?: string
  ) => {
    const currentTime = Date.now();
    const elapsedTime = currentTime - startTime;
    
    const newStatus = {
      progress,
      status,
      uploadTime: elapsedTime,
      estimatedTimeRemaining: progress > 0 ? (elapsedTime / progress) * (100 - progress) : undefined,
      retryCount: 0,
      startTime,
      fileSize: file.size,
      fileName: file.name,
      error: error || undefined
    };
    
    // Update status synchronously to avoid race conditions
    setUploadStatus(prev => {
      const newMap = new Map(prev);
      newMap.set(fileId, newStatus);
      return newMap;
    });
    
    console.log(`Updated status for ${file.name}:`, newStatus);
    
    // Also update the local reference immediately for immediate access
    return newStatus;
  };

  // Update overall upload progress
  const updateOverallProgress = useCallback(() => {
    const allStatuses = Array.from(uploadStatusRef.current.values());

    if (allStatuses.length === 0) {
      console.log('No uploads, setting progress to 0');
      dispatch(setUploadSettings({ uploadProgress: 0 }));
      return;
    }

    const activeStatuses = allStatuses.filter(status => 
      status.status === 'Uploading' || status.status === 'Paused'
    );
    const completedStatuses = allStatuses.filter(status => status.status === 'Completed');
    const cancelledStatuses = allStatuses.filter(status => status.status === 'Cancelled');
    const errorStatuses = allStatuses.filter(status => status.status === 'Error');



    let totalProgress = 0;

    if (activeStatuses.length > 0 || completedStatuses.length > 0) {
      totalProgress = allStatuses.reduce((sum, status) => {
        if (status.status === 'Completed') {
          return sum + 100;
        } else if (status.status === 'Uploading' || status.status === 'Paused') {
          return sum + status.progress;
        } else if (status.status === 'Cancelled') {
          return sum + 0; // Cancelled uploads count as 0%
        } else {
          return sum + 0; // Error uploads count as 0%
        }
      }, 0) / (allStatuses.length - cancelledStatuses.length);


      dispatch(setUploadSettings({ uploadProgress: Number(totalProgress.toFixed(2)) }));
    } else if (cancelledStatuses.length === allStatuses.length) {
      dispatch(setUploadSettings({ uploadProgress: 0 }));
    } else if (errorStatuses.length === allStatuses.length) {
      dispatch(setUploadSettings({ uploadProgress: 0 }));
    } else {
      dispatch(setUploadSettings({ uploadProgress: 0 }));
    }
  }, [dispatch]);

  // Safe update overall progress - check if state is available
  const safeUpdateOverallProgress = useCallback(() => {
    // Only update if state hasn't been cleaned up
    if (uploadStatusRef.current.size > 0) {
      updateOverallProgress();
    }
  }, [updateOverallProgress]);

  // Event-driven progress update manager
  const progressUpdateManager = useRef({
    isRunning: false,
    updateQueue: [] as Array<{ timestamp: number; callback: () => void }>,
    lastUpdateTime: 0,

    // Start event-driven progress updates
    start: () => {
      if (progressUpdateManager.current.isRunning) return;
      progressUpdateManager.current.isRunning = true;
      progressUpdateManager.current.scheduleUpdate();
    },

    // Stop progress updates
    stop: () => {
      progressUpdateManager.current.isRunning = false;
      progressUpdateManager.current.updateQueue = [];
    },

    // Schedule the next progress update
    scheduleUpdate: () => {
      if (!progressUpdateManager.current.isRunning) return;

      const currentTime = Date.now();

      // Check if we have uploads and need to update progress
      if (uploadStatusRef.current.size > 0) {
        const timeSinceLastUpdate = currentTime - progressUpdateManager.current.lastUpdateTime;

        // Update more frequently during active uploads, less frequently when idle
        const updateInterval = progressUpdateManager.current.hasActiveUploads() ? 200 : 500;

        if (timeSinceLastUpdate >= updateInterval) {
          progressUpdateManager.current.lastUpdateTime = currentTime;
          safeUpdateOverallProgress();
        }

        // Schedule next update
        setTimeout(() => {
          progressUpdateManager.current.scheduleUpdate();
        }, Math.max(50, updateInterval - timeSinceLastUpdate));
      } else {
        // No uploads, check again in 1 second
        setTimeout(() => {
          progressUpdateManager.current.scheduleUpdate();
        }, 1000);
      }
    },

    // Check if there are active uploads that need progress tracking
    hasActiveUploads: () => {
      return Array.from(uploadStatusRef.current.values()).some(status =>
        status.status === 'Uploading' || status.status === 'Paused'
      );
    }
  });

  // Manage progress updates based on upload activity
  useEffect(() => {
    const hasUploads = uploadStatusRef.current.size > 0;
    const hasActiveUploads = progressUpdateManager.current.hasActiveUploads();

    if (hasUploads && !progressUpdateManager.current.isRunning) {
      progressUpdateManager.current.start();
    } else if (!hasUploads && progressUpdateManager.current.isRunning) {
      // Delay stopping to ensure final updates are processed
      setTimeout(() => {
        if (uploadStatusRef.current.size === 0) {
          progressUpdateManager.current.stop();
        }
      }, 1000);
    }
  }, [uploadStatus, safeUpdateOverallProgress]);

  // Show upload results and appropriate messages
  const showUploadResults = async (results: { successful: number; cancelled: number; failed: number; total: number }) => {
    console.log('Upload results:', results);

    // Refresh file list to show uploaded files
    if (results.successful > 0) {
      await fetchFiles(currentDirectory);
    }

    // Show single, clear message based on results
    if (results.successful === results.total && results.successful > 0) {
      // All files successful - simple success message
      message.success(`Successfully uploaded ${results.successful} file${results.successful === 1 ? '' : 's'}`);
    } else if (results.successful > 0) {
      // Partial success - show summary
      const parts = [];
      if (results.successful > 0) parts.push(`${results.successful} uploaded`);
      if (results.failed > 0) parts.push(`${results.failed} failed`);
      if (results.cancelled > 0) parts.push(`${results.cancelled} cancelled`);
      message.warning(`Upload completed: ${parts.join(', ')}`);
    } else if (results.cancelled === results.total) {
      // All cancelled
      message.info('Upload cancelled');
    } else if (results.failed === results.total) {
      // All failed
      message.error('Upload failed');
    } else {
      // No results or unexpected state
      message.info('Upload completed');
    }
  };

  // Clean up upload state
  const cleanupUploadState = () => {
    // Clear upload managers
    setChunkedUploadManagers(new Map());
    // Clear upload statuses
    setUploadStatus(new Map());
    // Reset upload interrupted flag
    setUploadInterrupted(false);
    // Reset overall progress to 0 after cleanup
    dispatch(setUploadSettings({ uploadProgress: 0 }));
  };

  // Cancel chunked upload
  const cancelChunkedUpload = async (fileId: string) => {
    const manager = chunkedUploadManagers.get(fileId);
    if (manager) {
      try {
        await manager.cancel();
        console.log(`Upload cancelled for file: ${fileId}`);
        
        // Update status to cancelled
        setUploadStatus(prev => {
          const newMap = new Map(prev);
          const currentStatus = newMap.get(fileId);
          if (currentStatus) {
            newMap.set(fileId, {
              ...currentStatus,
              status: 'Cancelled',
              error: 'Upload cancelled',
              progress: 0
            });
          }
          return newMap;
        });
        
        // Set upload interrupted flag
        setUploadInterrupted(true);
        
        // Recalculate overall progress after cancellation with a small delay
        setTimeout(() => {
          safeUpdateOverallProgress();
        }, 50);
        
      } catch (error) {
        console.error(`Failed to cancel upload for ${fileId}:`, error);
      }
    }
  };

  // Pause chunked upload
  const pauseChunkedUpload = async (fileId: string) => {

    const manager = chunkedUploadManagers.get(fileId);
    if (manager) {
      try {
        await manager.pause();
        // Update status to show paused state
        setUploadStatus(prev => {
          const current = prev.get(fileId);
          if (current) {
            console.log(`Updating status to Paused for: ${fileId}`);
            return new Map(prev).set(fileId, {
              ...current,
              status: 'Paused'
            });
          }
          return prev;
        });
        
        // Recalculate overall progress after pause with a small delay
        setTimeout(() => {
          safeUpdateOverallProgress();
        }, 50);
      } catch (error) {
        console.error(`Failed to pause upload for ${fileId}:`, error);
      }
    } else {
      console.warn(`No manager found for fileId: ${fileId}`);
    }
  };

  // Resume chunked upload
  const resumeChunkedUpload = async (fileId: string) => {
    console.log(`Attempting to resume upload for: ${fileId}`);
    const manager = chunkedUploadManagers.get(fileId);
    if (manager) {
      try {
        console.log(`Found manager, calling resume()...`);
        await manager.resume();
        console.log(`Upload resumed for file: ${fileId}`);
        
        // Update status to show uploading state
        setUploadStatus(prev => {
          const current = prev.get(fileId);
          if (current) {
            console.log(`Updating status to Uploading for: ${fileId}`);
            return new Map(prev).set(fileId, {
              ...current,
              status: 'Uploading'
            });
          }
          return prev;
        });
        
        // Recalculate overall progress after resume with a small delay
        setTimeout(() => {
          safeUpdateOverallProgress();
        }, 50);
      } catch (error) {
        console.error(`Failed to resume upload for ${fileId}:`, error);
      }
    } else {
      console.warn(`No manager found for fileId: ${fileId}`);
    }
  };





  // Cancel all ongoing uploads
  const cancelAllUploads = async () => {
    // Set upload interrupted flag to prevent success message
    setUploadInterrupted(true);
    
    const cancelPromises = Array.from(chunkedUploadManagers.keys()).map(fileId => 
      cancelChunkedUpload(fileId)
    );
    
    try {
      await Promise.all(cancelPromises);
      message.info('All uploads have been cancelled');
      
      // Recalculate overall progress after all cancellations
      setTimeout(() => updateOverallProgress(), 100);
    } catch (error) {
      console.error('Failed to cancel all uploads:', error);
      message.error('Failed to cancel some uploads');
      
      // Still recalculate progress even if some cancellations failed
      setTimeout(() => updateOverallProgress(), 100);
    }
  };

  // --- CRUD Operations ---
  const handleCreateFolder = async (folderName: string) => {
    if (!folderName) return;
    // Append to current relative path
    const newPath = currentDirectory ? `${currentDirectory}/${folderName}/` : `${folderName}/`;
    try {
      await apiCreateFolder(newPath);
      await fetchFiles(currentDirectory); // Refresh
      message.success('Folder created successfully');
    } catch(err: any) { 
      if (err.status === 403) {
        message.error('Permission denied. You may need administrator privileges to create folders here.');
      } else if (err.status === 400 && err.message.includes('already exists')) {
        message.error('A folder with this name already exists. Please choose a different name.');
      } else {
        message.error(err.message || 'Failed to create folder');
        dispatch(setError(err.message || 'Failed to create folder'));
      }
    }
    finally { setDialog(null); }
  };

  const handleRename = async (newName: string) => {
    if (!newName || !dialog || dialog.type !== 'rename' || !dialog.path) return;
    const oldPath = dialog.path;
    const dir = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/')) : '';
    const newPath = dir ? `${dir}/${newName}` : newName;
    try {
        await apiRenameFile(oldPath, newPath);
        await fetchFiles(currentDirectory);
        message.success('Item renamed successfully');
    } catch(err: any) { 
        // Handle different types of errors with appropriate user feedback
        if (err.status === 403) {
            message.error('Permission denied. You may need administrator privileges to rename this item.');
        } else if (err.status === 409) {
            message.warning(err.message); // File in use messages
        } else if (err.status === 400 && err.message.includes('already exists')) {
            message.error('An item with this name already exists. Please choose a different name.');
        } else if (err.status === 404) {
            message.error('The item could not be found. It may have been moved or deleted.');
            await fetchFiles(currentDirectory); // Refresh to sync with actual state
        } else {
            // For any other errors, show the detailed message and also set the general error
            message.error(err.message || 'Failed to rename item');
            dispatch(setError(err.message || 'Failed to rename item'));
        }
    }
    finally { setDialog(null); }
  };

  const handleDelete = async () => {
    if (!dialog || dialog.type !== 'delete' || !dialog.path) return;
    try {
        await apiDeleteFiles([dialog.path]);
        await fetchFiles(currentDirectory);
        await refreshQuota();
        message.success('Item deleted successfully');
    } catch(err: any) { 
        // Handle different types of errors with appropriate user feedback
        if (err.status === 403) {
            message.error('Permission denied. You may need administrator privileges to delete this item.');
        } else if (err.status === 409) {
            message.warning(err.message); // File in use messages
        } else if (err.status === 404) {
            message.error('The item could not be found. It may have been already deleted.');
            await fetchFiles(currentDirectory); // Refresh to sync with actual state
        } else {
            message.error(err.message || 'Failed to delete item');
            dispatch(setError(err.message || 'Failed to delete item'));
        }
    }
    finally { setDialog(null); }
  };
  
  const sortData = (data: FileTreeNode[], config: typeof sortConfig) => {
    return [...data].sort((a, b) => {
      // Always keep ".." parent link on top regardless of sort
      // @ts-ignore
      const aIsParent = !!a.isParentLink;
      // @ts-ignore
      const bIsParent = !!b.isParentLink;
      if (aIsParent !== bIsParent) return aIsParent ? -1 : 1;

      let aValue, bValue;
      if (config.key === 'type') {
        aValue = a.is_dir ? 'folder' : formatFileType(a.name);
        bValue = b.is_dir ? 'folder' : formatFileType(b.name);
      } else {
        aValue = a[config.key as keyof FileItem];
        bValue = b[config.key as keyof FileItem];
      }

      if ((aValue ?? '') < (bValue ?? '')) return config.direction === 'asc' ? -1 : 1;
      if ((aValue ?? '') > (bValue ?? '')) return config.direction === 'asc' ? 1 : -1;
      return 0;
    });
  };

  const filesToRender = fileTree;

  const renderBreadcrumbs = () => {
    const auth = getAuth(app);
    const isLoggedIn = !!auth.currentUser;
    const personalRoot = (defaultPathRef.current || '');
    return (
      <Breadcrumbs
        currentDirectory={currentDirectory}
        personalRoot={personalRoot}
        isLoggedIn={isLoggedIn}
        isInSharedContext={isInSharedContext}
        onNavigate={(p) => fetchFiles(p)}
      />
    );
  };



  const renderToolbar = () => {
    const { isLoggedIn, inVirtualRoot, inSamples, canCreate, canUpload } = computeFsPermissions(currentDirectory);
    const isUserLoggedIn = isLoggedIn; // alias for readability
    const upButtonDisabled = (isLoggedIn ? currentDirectory === VIRTUAL_ROOT : currentDirectory === 'samples' || currentDirectory === '' || !currentDirectory);
    
    return (
      <div className="flex items-center justify-between p-2 border-b">
        <div className="flex items-center gap-2">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleGoUp} 
            disabled={upButtonDisabled}
          >
            <ArrowUp className="h-4 w-4 mr-2" /> Up
          </Button>
          <Button variant="outline" size="sm" onClick={() => setDialog({ type: 'create-folder' })} disabled={!!error || !isUserLoggedIn || !canCreate}>
            <FolderPlus className="h-4 w-4 mr-2" /> New Folder
          </Button>
          <Button variant="outline" size="sm" onClick={() => dispatch(setUploadSettings({ isUploadDialogOpen: true }))} disabled={uploadSettings.isUploading || !!error || !isUserLoggedIn || !canUpload}>
            <FilePlus className="h-4 w-4 mr-2" /> Upload Files
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={async () => {
              await fetchFiles(currentDirectory);
              await refreshQuota();
            }}
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <List className={`h-4 w-4 ${tableViewMode === 'tree' ? 'text-blue-500' : 'text-gray-400'}`} />
              <Switch 
                checked={tableViewMode === 'table'} 
                onCheckedChange={(checked) => dispatch(setTableViewMode(checked ? 'table' : 'tree'))} 
              />
              <Grid className={`h-4 w-4 ${tableViewMode === 'table' ? 'text-blue-500' : 'text-gray-400'}`} />
              <span className="text-sm text-gray-600 dark:text-gray-400">Table View</span>
            </div>
            <div className="flex items-center gap-2">
                <Switch 
                    checked={showNonImageFiles}
                    onCheckedChange={(checked) => dispatch(setShowNonImageFiles(checked))}
                />
                <span className="text-sm text-gray-600 dark:text-gray-400">Show non-image files</span>
            </div>

        </div>
      </div>
    );
  }

  const renderItemContextMenu = (item: FileTreeNode) => {
    const { inSharedRoot, isContextDisabledForItem, inVirtualRoot, inPersonalRoot } = computeFsPermissions(currentDirectory);
    const disabledAll: boolean = Boolean(inSharedRoot || isContextDisabledForItem(item.path));
    // Allow opening menu for files even in Samples/Shared to enable Download
    const triggerDisabled = disabledAll && item.is_dir;
    const onDownload = async () => {
      try {
        const key = `dl_${Math.random().toString(36).slice(2)}`;
        message.open({ key, type: 'loading', content: 'Preparing download...', duration: 0 });
        
        await downloadFile(item.path, item.name || 'download', (progress) => {
          if (progress.state === 'progressing' && progress.percent !== undefined) {
            message.open({ key, type: 'loading', content: `Downloading ${progress.percent}%`, duration: 0 });
          } else if (progress.state === 'completed') {
            message.open({ key, type: 'success', content: 'Download completed', duration: 2 });
          } else if (progress.state === 'interrupted' || progress.state === 'cancelled' || progress.state === 'failed') {
            message.open({ key, type: 'error', content: 'Download Failed', duration: 2 });
          }
        });
        
        message.destroy(key);
      } catch (e: any) {
        message.error(e?.message || 'Download failed');
      }
    };
    return (
      <DropdownMenu>
          <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className={`h-8 w-8 ${triggerDisabled ? 'opacity-60' : ''}`} disabled={triggerDisabled}>
                  <MoreVertical className="h-4 w-4" />
              </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
              {!item.is_dir && (
                <DropdownMenuItem onSelect={onDownload} disabled={false}>
                    <DownloadCloud className="h-4 w-4 mr-2" /> Download
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setDialog({ type: 'rename', path: item.path })} disabled={disabledAll}>
                  <Edit className="h-4 w-4 mr-2" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog({ type: 'delete', path: item.path })} className="text-red-500" disabled={disabledAll}>
                  <Trash2 className="h-4 w-4 mr-2" /> Delete
              </DropdownMenuItem>
              {/* Share for files and folders under Personal tree */}
              <DropdownMenuItem 
                onSelect={() => setDialog({ type: 'share', path: item.path })}
                disabled={Boolean(disabledAll || !isPersonalRootPath(item.path))}
              >
                <Share2 className="h-4 w-4 mr-2" /> Share
              </DropdownMenuItem>
          </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const formatFileType = (fileName: string) => {
    const extension = fileName.split('.').pop();
    if (extension) {
        if (isWSI(fileName)) return 'WSI';
        if (isH5(fileName)) return 'H5';
        return extension.toUpperCase();
    }
    return 'File';
  };

  const renderFileTreeRows = (nodes: FileTreeNode[], baseIndex: number = 0, showDashForMtime: boolean = false, inSharedContextFlag: boolean = false): React.ReactNode[] => {
    let rows: React.ReactNode[] = [];
    const sortedNodes = sortData(nodes, sortConfig);

    sortedNodes.forEach((item, index) => {
        const globalIndex = baseIndex + index;
        // @ts-ignore
        if (item.isParentLink) {
            rows.push(
                <TableRow
                    key={`${keyPrefix}:parent:${item.path || currentDirectory}:${globalIndex}`}
                    onDragOver={(e) => handleDragOver(e, item.path)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, item)}
                    onClick={(e) => handleItemClick(item, e)}
                    onDoubleClick={() => handleItemClick(item, {} as React.MouseEvent)}
                    className="cursor-pointer transition-colors align-top hover:bg-gray-100 dark:hover:bg-gray-700 mx-2 rounded-lg bg-white dark:bg-gray-900"
                >
                    <TableCell className="px-3">
                         <div style={{ paddingLeft: `${item.depth * 24}px` }} className="flex items-start gap-2">
                            <ArrowUp className="h-5 w-5 mt-0.5 text-gray-500 flex-shrink-0" />
                            <span className="break-all leading-tight">{item.name}</span>
                         </div>
                    </TableCell>
                    <TableCell className="text-right px-3">Parent Directory</TableCell>
                    <TableCell className="text-right px-3">—</TableCell>
                    <TableCell className="text-right px-3">—</TableCell>
                    <TableCell className="text-right px-3"></TableCell>
                </TableRow>
            );
            return;
        }

        // Filter files based on showNonImageFiles setting
        if (!showNonImageFiles && !item.is_dir && !isWSI(item.name) && !isH5(item.name)) {
            // Skip non-image files when showNonImageFiles is false, but still process children
            if (item.children && item.children.length > 0) {
                rows = rows.concat(renderFileTreeRows(item.children, 0, showDashForMtime, inSharedContextFlag));
            }
            return;
        }

        rows.push(
            <TableRow 
                key={`${keyPrefix}:node:${currentDirectory}:${item.path}:${globalIndex}`} 
                draggable
                onDragStart={(e) => handleDragStart(e, item.path)}
                onDragEnd={handleDragEnd}
                onDragOver={item.is_dir ? (e) => handleDragOver(e, item.path) : undefined}
                onDragLeave={item.is_dir ? handleDragLeave : undefined}
                onDrop={item.is_dir ? (e) => handleDrop(e, item) : (e) => e.preventDefault()}
                onClick={(e) => handleItemClick(item, e)}
                onDoubleClick={() => handleItemDoubleClick(item)} 
                className="cursor-pointer transition-colors align-top rounded-lg mx-2 bg-white dark:bg-gray-900 hover:!bg-gray-100 dark:hover:!bg-gray-700"
            >
                <TableCell className="px-3">
                    <div style={{ paddingLeft: `${item.depth * 24}px` }} className="flex items-start gap-3">
                        {item.is_dir && (
                            <span onClick={(e) => { e.stopPropagation(); toggleFolder(item); }} className="cursor-pointer mt-1">
                                {item.isLoading 
                                    ? <div className="h-4 w-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div> 
                                    : item.isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </span>
                        )}

                        {item.is_dir 
                            ? <Folder className="h-5 w-5 text-blue-500 flex-shrink-0" /> 
                            : isWSI(item.name) 
                                ? <ImageIcon className="h-5 w-5 text-rose-500 flex-shrink-0" /> 
                                : isH5(item.name)
                                    ? <File className="h-4 w-4 text-orange-500 flex-shrink-0" />
                                    : <File className="h-5 w-5 text-gray-500 flex-shrink-0" />}
                        <span className="break-all leading-tight">{item.name}</span>
                    </div>
                </TableCell>
                <TableCell className="text-right px-3">{item.is_dir ? 'Folder' : formatFileType(item.name)}</TableCell>
                <TableCell className="text-right px-3">{item.is_dir ? '—' : formatBytes(item.size)}</TableCell>
                <TableCell className="text-right px-3">
                    {(showDashForMtime && item.depth === 0) ? '—' : 
                     (inSharedContextFlag && item.isShared && item.sharedAt) ? 
                     new Date(item.sharedAt * 1000).toLocaleString() : 
                     new Date(item.mtime * 1000).toLocaleString()}
                </TableCell>
                {inSharedContextFlag && (
                    <TableCell className="text-right px-3 text-sm text-gray-600">
                        {item.isShared && item.sharedBy ? item.sharedBy : '—'}
                    </TableCell>
                )}
                <TableCell className="text-right px-3" onClick={(e) => e.stopPropagation()}>
                    {renderItemContextMenu(item)}
                </TableCell>
            </TableRow>
        );

        // Show children if folder is expanded OR if it's a WSI file with H5 children
        if (item.children && item.children.length > 0 && (item.isExpanded || (!item.is_dir && isWSI(item.name)))) {
            const childRows = renderFileTreeRows(item.children, globalIndex + 1, showDashForMtime, inSharedContextFlag);
            rows = rows.concat(childRows);
        }
    });
    return rows;
  };

  const renderFileTable = () => {
    const flatVisibleFiles = flattenTree(filesToRender);
    const { inVirtualRoot, inSharedContext } = computeFsPermissions(currentDirectory);
    
    return (
      <Table 
        onDragOver={(e) => handleDragOver(e, currentDirectory)} 
        onDragLeave={handleDragLeave}
        onDragEnd={handleDragEnd}
        onDrop={handleDropOnCurrentDirectory}
      >
        <TableHeader>
          <TableRow className="rounded-lg mx-2 bg-gray-100 dark:bg-gray-800">
            <TableHead className="px-3">
                <div className="flex items-center gap-3">
                    <span className="cursor-pointer" onClick={() => requestSort('name')}>
                        Name {sortConfig.key === 'name' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-4 w-4" /> : <ArrowDown className="inline h-4 w-4" />)}
                    </span>
                </div>
            </TableHead>
            <TableHead className="text-right cursor-pointer px-3" onClick={() => requestSort('type')}>
                Type {sortConfig.key === 'type' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-4 w-4" /> : <ArrowDown className="inline h-4 w-4" />)}
            </TableHead>
            <TableHead className="text-right cursor-pointer px-3" onClick={() => requestSort('size')}>
                Size {sortConfig.key === 'size' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-4 w-4" /> : <ArrowDown className="inline h-4 w-4" />)}
            </TableHead>
            <TableHead className="text-right cursor-pointer px-3" onClick={() => requestSort('mtime')}>
                {inSharedContext ? 'Shared At' : 'Last Modified'} {sortConfig.key === 'mtime' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-4 w-4" /> : <ArrowDown className="inline h-4 w-4" />)}
            </TableHead>
            {inSharedContext && (
                <TableHead className="text-right px-3">Shared By</TableHead>
            )}
            <TableHead className="w-20 text-right px-3">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {renderFileTreeRows(filesToRender, 0, !!inVirtualRoot, !!inSharedContext)}
        </TableBody>
      </Table>
    );
  }

  const renderDialog = () => {
    if (!dialog) return null;

    if (dialog.type === 'create-folder' || dialog.type === 'rename') {
        const isRename = dialog.type === 'rename';
        const defaultValue = isRename ? dialog.path?.split('/').pop() : '';
        return (
            <Dialog open onOpenChange={() => setDialog(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{isRename ? 'Rename Item' : 'Create New Folder'}</DialogTitle>
                        <DialogDescription>
                            <Input 
                                ref={inputRef}
                                defaultValue={defaultValue}
                                placeholder={isRename ? "Enter new name" : "Enter folder name"}
                                className="mt-4"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        if (isRename) handleRename(inputRef.current?.value || '');
                                        else handleCreateFolder(inputRef.current?.value || '');
                                    }
                                }}
                            />
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button variant="outline">Cancel</Button>
                        </DialogClose>
                        <Button onClick={() => {
                            if (isRename) handleRename(inputRef.current?.value || '');
                            else handleCreateFolder(inputRef.current?.value || '');
                        }}>{isRename ? 'Rename' : 'Create'}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        )
    }

    if (dialog.type === 'delete') {
      return (
        <Dialog open onOpenChange={() => setDialog(null)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Are you sure?</DialogTitle>
                    <DialogDescription>
                        This will permanently delete this item. This action cannot be undone.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                     <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                    </DialogClose>
                    <Button onClick={handleDelete} variant="destructive">Delete</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
      )
    }

    if (dialog.type === 'share') {
      const path = dialog.path;
      return (
        <ShareDialog path={path!} onClose={() => setDialog(null)} />
      );
    }
  }

  return (
    <div className="h-full w-full flex flex-col">
      
      <Card className="flex-grow">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle>TissueLab Cloud Storage</CardTitle>
            {(() => {
              const isLoggedIn = !!getAuth(app).currentUser;
              
              // Only show storage usage for logged-in users
              if (!isLoggedIn) {
                return null;
              }
              
              const hasQuota = typeof storageQuota === 'number' && storageQuota! > 0;
              const percent = hasQuota ? Math.min(100, Math.round((storageUsage / (storageQuota as number)) * 100)) : 0;
              const toGB = (n: number) => (n / (1024 * 1024 * 1024)).toFixed(2);
              const label = hasQuota
                ? `${toGB(storageUsage)} GB of ${toGB(storageQuota as number)} GB used (${percent}%)`
                : 'Storage usage';
              return (
                <div className="flex flex-col items-end gap-1" title={hasQuota ? `${label}` : "Unlimited or unavailable"}>
                  <div className="w-40 h-2 rounded-full bg-gray-200/80 dark:bg-gray-700/80 overflow-hidden">
                    <div
                      className={`${percent > 90 ? 'bg-red-400' : percent > 75 ? 'bg-yellow-400' : 'bg-blue-400'} h-2`}
                      style={{ width: `${hasQuota ? percent : 0}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{label}</span>
                </div>
              );
            })()}
          </div>
          <div className="flex items-center justify-between">
            {renderBreadcrumbs()}
            <div className="relative w-96">
              <div className="flex items-center w-full h-9 border border-gray-300 rounded-md bg-white focus-within:border-gray-400 focus-within:ring-1 focus-within:ring-gray-400 transition-all">
                <div className="flex items-center justify-center w-9 h-9">
                  <Search className="h-4 w-4 text-gray-400" />
                </div>
                <input
                  type="text"
                  placeholder="Search all files..."
                  value={searchTerm}
                  onChange={(e) => handleSearch(e.target.value)}
                  className="flex-1 h-full bg-transparent border-0 outline-none focus:outline-none text-sm px-2"
                />
                {searchTerm && (
                  <button
                    onClick={() => handleSearch('')}
                    className="flex items-center justify-center w-9 h-9 text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
          </CardHeader>
        <CardContent className="p-0">
          {renderToolbar()}
          <ScrollArea className="h-[600px]">
            {isLoading && <div className="p-4 text-center">Loading...</div>}
            {error && (
                <div className="px-3">
                  <div className="mx-auto max-w-xl p-3 rounded-md border bg-blue-50 border-blue-200 text-blue-700 text-sm flex items-center justify-center gap-2">
                    <Info className="w-4 h-4" />
                    <span>{error}</span>
                  </div>
                </div>
            )}
            {!isLoading && !error && filesToRender.length === 0 && (
                <div className="p-4 text-center text-gray-500">
                    {searchTerm ? `No files found for "${searchTerm}"` : "This folder is empty."}
              </div>
                )}
            {!isLoading && !error && filesToRender.length > 0 && (
                <div className="min-h-full">
                  {tableViewMode === 'table' ? (
                    <div className="p-2">
                      {renderImageTable()}
                    </div>
                  ) : (
                    <>
                      {renderFileTable()}
                      {/* Empty drop zone for better UX */}
                      <div 
                        className="min-h-[200px] w-full"
                        onDragOver={(e) => {
                          handleDragOver(e, currentDirectory);
                        }}
                        onDragLeave={handleDragLeave}
                        onDragEnd={handleDragEnd}
                        onDrop={handleDropOnCurrentDirectory}
                      >
                      </div>
                    </>
                  )}
                </div>
            )}
            </ScrollArea>
          </CardContent>
        </Card>
      {renderDialog()}
      <UploadDialog 
        isOpen={uploadSettings.isUploadDialogOpen}
        onClose={() => {
          // Only cancel uploads if they are actually ongoing
          const ongoingUploads = Array.from(uploadStatus.entries())
            .filter(([_, status]) => status.status === 'Uploading' || status.status === 'Paused');
          
          if (ongoingUploads.length > 0) {
            // Set upload interrupted flag to prevent success message
            setUploadInterrupted(true);
            
            // Cancel only ongoing uploads
            ongoingUploads.forEach(([fileId, _]) => {
              cancelChunkedUpload(fileId);
            });
            
            console.log(`Cancelled ${ongoingUploads.length} ongoing upload(s) when dialog closed`);
          } else {
            console.log('No ongoing uploads to cancel when dialog closed');
          }
          
          // Don't clean up status here - let the upload completion logic handle it
          // This prevents premature cleanup that could interfere with statistics
          console.log('Dialog closing - status cleanup will be handled by upload completion logic');
          
          // Close dialog and reset all upload states
          dispatch(setUploadSettings({ 
            isUploadDialogOpen: false,
            isUploading: false,
            uploadProgress: 0
          }));
        }}
        onUpload={handleFileUpload}
        isUploading={uploadSettings.isUploading}
        uploadProgress={uploadSettings.uploadProgress}
        uploadStatus={uploadStatus}
        onCancelChunkedUpload={cancelChunkedUpload}
      />
      
      {/* Overwrite confirmation dialog */}
      <Dialog open={overwriteDialogOpen} onOpenChange={(open) => {
        setOverwriteDialogOpen(open);
        if (!open && overwriteResolverRef.current) {
          // Default cancel
          overwriteResolverRef.current(false);
          overwriteResolverRef.current = null;
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Overwrite Confirmation</DialogTitle>
            <DialogDescription className="break-all">
              {`The following files already exist: ${overwriteFiles.map(f => f.name).join(', ')}`}
              <br />
              {'Upload will be cancelled unless you choose to overwrite these files.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button
                variant="outline"
                onClick={() => {
                  if (overwriteResolverRef.current) {
                    overwriteResolverRef.current(false);
                    overwriteResolverRef.current = null;
                  }
                  setOverwriteDialogOpen(false);
                }}
              >
                Cancel Upload
              </Button>
            </DialogClose>
            <Button
              onClick={() => {
                if (overwriteResolverRef.current) {
                  overwriteResolverRef.current(true);
                  overwriteResolverRef.current = null;
                }
                setOverwriteDialogOpen(false);
                // Continue with upload after confirmation
                handleFileUpload(pendingUploadFiles as any, true);
              }}
            >
              Overwrite & Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      <ChunkedUploadProgress
          uploadStatus={uploadStatus}
          onCancel={cancelChunkedUpload}
          onPause={pauseChunkedUpload}
          onResume={resumeChunkedUpload}
        />
    </div>
  );
};

export default WebFileManager;
