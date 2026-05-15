import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Image from 'next/image';
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { ChevronRight, ChevronLeft,
        Folder, X, Search, FolderOpen, Grid, List, Image as ImageIcon, Info, ChevronsLeft, ChevronsRight, RefreshCw } from 'lucide-react';
import AssociatedModelsSection from '@/components/imageViewer/LeftSidebar/AssociatedModelsSection';
import { InlineSpinner } from '@/components/assets/PageLoading';

import { useDispatch, useSelector } from 'react-redux';
import { updateInstanceWSIInfo, replaceCurrentInstance, resetWSIState } from '@/store/slices/wsiSlice';
import { setCurrentPath, setSlideInfo, resetSvsPath } from '@/store/slices/svsPathSlice';
import { setOutputPath } from '@/store/slices/chat/workflowSlice';
import { PayloadAction } from '@reduxjs/toolkit';
import { setImageLoaded } from '@/store/slices/layoutSlice';
import { RootState } from '@/store';
import {
  setSelectedFolder,
  setFileList,
  setIsLoading,
  setError,
  setSearchTerm,
  setIsMinimized,
  setViewMode,
  setAssociatedModels,
  setCurrentImagePath,
} from '@/store/slices/fileManagerSlice';
import { useRouter } from 'next/router';
import { uploadFilePath, loadFileData, createInstance, getPreviewAsync } from '@/services/file.service';
import { useAnnotatorInstance } from '@/contexts/AnnotatorContext';
import { listFiles, listSharedFiles, getConfig } from '@/utils/dashboard/fileManager.service';
import { getErrorMessage } from '@/utils/common/apiResponse';
import { isZarr } from '@/utils/dashboard/fileTypeUtils';
import { shortHashFromString } from '@/utils/string.utils';
import { getAuth } from 'firebase/auth';
import { app } from '@/config/firebaseConfig';
import { useUserInfo } from '@/provider/UserInfoProvider';
import { selectSelectedModelForPath, setAvailableModelsForPath, setSelectedModelForPath, validateAllSelections } from '@/store/slices/chat/modelSelectionSlice';
import type { FileTaskState, FileTaskStatus } from '@/components/imageViewer/fileTaskTypes';
import { PaginationState } from '@/components/dashboard/FileManager/FileManagerPagination';

const truncateFileName = (fileName: string, maxLength: number = 25) => {
  if (fileName.length <= maxLength) return fileName;
  const extension = fileName.split('.').pop() || '';
  const nameWithoutExt = fileName.slice(0, fileName.length - extension.length - 1);
  if (nameWithoutExt.length <= maxLength - 5) return fileName;
  const endChars = 3;
  const truncatedLength = maxLength - extension.length - endChars - 6;
  if (truncatedLength < 3) {
    const start = nameWithoutExt.slice(0, maxLength - extension.length - 4);
    return `${start}...${extension ? `.${extension}` : ''}`;
  }
  const start = nameWithoutExt.slice(0, truncatedLength);
  const end = nameWithoutExt.slice(-endChars);
  return `${start}...${end}${extension ? `.${extension}` : ''}`;
};

const TASK_STATUS_LABELS: Record<FileTaskStatus, string> = {
  idle: 'Idle',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  error: 'Failed',
};

const ImagePreviewCellComponent: React.FC<{ 
  fileName: string; 
  fullPath: string; 
  imageType: 'thumbnail' | 'label' | 'macro' 
}> = ({
  fileName,
  fullPath,
  imageType
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

    // Check cache first
    const cacheKey = fullPath;
    const cachedData = previewCache.get(cacheKey);
    
    if (cachedData) {
      // Update timestamp for recently accessed items
      cachedData.timestamp = Date.now();
      previewCache.set(cacheKey, cachedData);
      
      // Remove timestamp before setting to component state
      const { timestamp, ...dataWithoutTimestamp } = cachedData;
      setPreviewData(dataWithoutTimestamp);
      return;
    }

    // Check if this file is already being loaded by another component
    const existingPromise = loadingFiles.get(cacheKey);
    if (existingPromise) {
      // Wait for the existing request to complete
      try {
        const data = await existingPromise;
        setPreviewData(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load preview');
        setPreviewData({
          thumbnail: null,
          macro: null,
          label: null,
          filename: fileName,
          available: [],
          source_file: fullPath
        });
      }
      return;
    }

    loadingRef.current = true;
    setIsLoading(true);
    setError(null);

    // Create a promise for this request and store it globally
    const loadPromise = (async () => {
      try {
        // Generate a unique request ID
        const timestamp = Date.now();
        const randomId = Math.random().toString(36).substr(2, 9);
        const pathHash = shortHashFromString(fullPath, 8);
        const requestId = `preview_${pathHash}_${timestamp}_${randomId}`;
        
        // Fetch all preview types - we need all types to display different previews
        const data = await getPreviewAsync(fullPath, 'all', 100, requestId);
        
        // Store in cache with timestamp
        const cacheData = { ...data, timestamp: Date.now() };
        previewCache.set(cacheKey, cacheData);
        cleanupCache(); // Clean up old entries if needed
        
        return data;
      } catch (err) {
        const fallbackData = {
          thumbnail: null,
          macro: null,
          label: null,
          filename: fileName,
          available: [],
          source_file: fullPath,
          timestamp: Date.now()
        };
        
        // Cache the fallback data to avoid repeated failed requests
        previewCache.set(cacheKey, fallbackData);
        cleanupCache(); // Clean up old entries if needed
        
        throw err;
      } finally {
        // Remove from loading tracker
        loadingFiles.delete(cacheKey);
      }
    })();

    // Store the promise so other components can wait for it
    loadingFiles.set(cacheKey, loadPromise);

    try {
      const data = await loadPromise;
      setPreviewData(data);
    } catch (err) {
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
  }, [fileName, fullPath, isLoading, previewData]);

  const [elementRef, setElementRef] = useState<HTMLDivElement | null>(null);
  
  // Memoize the intersection observer to avoid recreating it
  const observer = useMemo(() => new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !previewData && !isLoading && !loadingRef.current) {
          const delay = Math.random() * 200 + 50;
          setTimeout(() => {
            if (!loadingRef.current && !previewData) {
              loadPreviewData();
            }
          }, delay);
        }
      });
    },
    { threshold: 0.1, rootMargin: '20px' }
  ), [loadPreviewData, previewData, isLoading]);

  useEffect(() => {
    if (!elementRef || !observer) return;

    observer.observe(elementRef);
    return () => observer.unobserve(elementRef);
  }, [elementRef, observer]);

  useEffect(() => {
    setPreviewData(null);
    setError(null);
    loadingRef.current = false;
  }, [fullPath]);

  const currentImage = previewData?.[imageType] || null;

  if (isLoading) {
    return (
      <div 
        ref={setElementRef}
        className="w-full h-full bg-muted rounded flex items-center justify-center"
      >
        <InlineSpinner size={12} color="var(--primary)" />
      </div>
    );
  }

  return (
    <div 
      ref={setElementRef}
      className="w-full h-full flex items-center justify-center"
    >
      {currentImage ? (
        <div className="relative w-full h-full">
          <Image
            src={currentImage}
            alt={`${fileName} ${imageType}`}
            fill
            className="object-contain rounded"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        </div>
      ) : (
        <div className="w-full h-full bg-muted rounded flex items-center justify-center">
          <ImageIcon className="h-3 w-3 text-muted-foreground" />
        </div>
      )}
    </div>
  );
};

// Memoized version to prevent unnecessary re-renders
const ImagePreviewCell = React.memo(ImagePreviewCellComponent, (prevProps, nextProps) => {
  return prevProps.fileName === nextProps.fileName && 
         prevProps.fullPath === nextProps.fullPath && 
         prevProps.imageType === nextProps.imageType;
});

interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
}

const isWSI = (fileName: string) => {
    const supportedExtensions = ['.svs', '.qptiff', '.tif', '.ndpi', '.tiff', '.jpeg', '.png', '.jpg', '.dcm', '.bmp', '.czi', '.nii', '.nii.gz', '.btf', '.isyntax'];
    return supportedExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
};

// Global cache for preview data to avoid re-fetching
const previewCache = new Map<string, {
  thumbnail: string | null;
  macro: string | null;
  label: string | null;
  filename: string;
  available: string[];
  source_file?: string;
  timestamp: number; // Add timestamp for cache cleanup
}>();

// Global loading tracker to prevent duplicate requests for the same file
const loadingFiles = new Map<string, Promise<{
  thumbnail: string | null;
  macro: string | null;
  label: string | null;
  filename: string;
  available: string[];
  source_file?: string;
}>>();

// Cache management
const MAX_CACHE_SIZE = 100;
const cleanupCache = () => {
  if (previewCache.size > MAX_CACHE_SIZE) {
    // Convert to array and sort by timestamp
    const entries = Array.from(previewCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    // Remove oldest half of entries
    const entriesToRemove = entries.slice(0, Math.floor(entries.length / 2));
    entriesToRemove.forEach(([key]) => previewCache.delete(key));
  }
};

// Helper function to find tlcls files in the current directory
const findTlclsFiles = (fileList: FileItem[]): string[] => {
  return fileList
    .filter(file => !file.is_dir && file.name.toLowerCase().endsWith('.tlcls'))
    .map(file => file.name);
};

const normalizeChildPath = (basePath: string, item: FileItem): FileItem => {
  const normalizedBase = (basePath || '').replace(/\\/g, '/').replace(/\/+$/g, '');
  const rawPath = (item.path || '').replace(/\\/g, '/').replace(/^\/+/g, '');
  const fallbackName = (item.name || '').replace(/\\/g, '/').replace(/^\/+/g, '');

  if (!normalizedBase) {
    return {
      ...item,
      path: rawPath || fallbackName,
    };
  }

  if (rawPath.startsWith(`${normalizedBase}/`) || rawPath === normalizedBase) {
    return item;
  }

  if (rawPath.startsWith('samples/') || rawPath.startsWith('users/') || rawPath === 'samples') {
    return item;
  }

  const relativePath = rawPath || fallbackName;
  return {
    ...item,
    path: relativePath ? `${normalizedBase}/${relativePath}` : normalizedBase,
  };
};


const FileBrowserSidebar: React.FC = () => {
  const dispatch = useDispatch();
  const router = useRouter();
  const { setInstanceId, setAnnotatorInstance, setViewerInstance } = useAnnotatorInstance();
  const { userInfo, userIdentity, isLoadingUser, signInAnonymous } = useUserInfo();
  const {
    selectedFolder,
    fileList,
    isLoading,
    error,
    searchTerm,
    isMinimized,
    viewMode,
  } = useSelector((state: RootState) => state.fileManager);
  
  const currentImagePath = useSelector((state: RootState) => state.fileManager.currentImagePath);
  
  // Local Electron-only build: web mode is permanently disabled.
  const isWebMode = false;
  
  // Check if user is anonymous
  const isAnonymousUser = userIdentity === 2 || (userInfo?.is_anonymous === true);
  
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  
  const isActiveFile = useCallback((p: string) => {
    return currentImagePath === p;
  }, [currentImagePath]);

  // Get selected model for current path
  const selectedModelForCurrentPath = useSelector((state: RootState) => {
    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }
    return selectSelectedModelForPath(state, targetPath);
  });
  
  const [electron, setElectron] = useState<any>(null);
  const [webDefaultPath, setWebDefaultPath] = useState<string>('');
  const [isMacElectron, setIsMacElectron] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastFetchedPathRef = useRef<string | null>(null);
  const inFlightPathRef = useRef<string | null>(null);
  const suppressAutoNavigateRef = useRef<boolean>(false);
  const [fileTaskStates, setFileTaskStates] = useState<Record<string, FileTaskState>>({});
  const prevUserIdentityRef = useRef<number | undefined>(undefined);
  
  // Pagination state
  const [pagination, setPagination] = useState<PaginationState>({
    offset: 0,
    limit: 10, // Default page size for FileBrowserSidebar
    total: 0,
    hasMore: false,
  });
  const currentDirectoryRef = useRef<string>('');
  const prevSearchTermRef = useRef<string>('');

  // Shared browsing context (restored from WebFileManager via sessionStorage)
  const sharedBrowseModeRef = useRef<boolean>(false);
  const sharedScopeRef = useRef<string | null>(null);
  const sharedContextRestoredRef = useRef<boolean>(false);

  const restoreSharedContextFromSession = useCallback(() => {
    if (typeof window === 'undefined') return null;
    try {
      const saved = window.sessionStorage.getItem('tissuelab_shared_context');
      if (!saved) return null;
      const context = JSON.parse(saved);
      const isRecent = (Date.now() - context.timestamp) < 3600000; // 1 hour
      if (isRecent && context.sharedBrowseMode) {
        sharedBrowseModeRef.current = !!context.sharedBrowseMode;
        sharedScopeRef.current = context.sharedScope || null;
        return context;
      }
    } catch (e) {
      // ignore
    }
    return null;
  }, []);

  const clampToSharedScope = useCallback((targetPath: string | null | undefined): string => {
    const scope = sharedScopeRef.current;
    const p = (targetPath || '').replace(/\\/g, '/');
    if (!sharedBrowseModeRef.current || !scope) return p;
    if (p.startsWith(scope)) return p;
    return scope; // clamp to scope root if navigating outside
  }, []);

  const clearViewerState = useCallback(() => {
    setAnnotatorInstance(null);
    setViewerInstance(null);
    setInstanceId(null);
    dispatch(resetWSIState());
    dispatch(resetSvsPath());
    dispatch(setOutputPath(''));
    dispatch(setCurrentImagePath(null));
    dispatch(setImageLoaded(false));
  }, [dispatch, setAnnotatorInstance, setInstanceId, setViewerInstance]);

  const resetGuestFileBrowserState = useCallback(() => {
    dispatch(setFileList([]));
    dispatch(setAssociatedModels([]));
    dispatch(setSearchTerm(''));
    dispatch(setError(null));
    dispatch(setIsLoading(false));
  }, [dispatch]);


  const handleModelClick = useCallback((modelName: string) => {
    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }
    
    if (!isWebMode && !targetPath) return;
    
    const newSelection = selectedModelForCurrentPath === modelName ? null : modelName;
    dispatch(setSelectedModelForPath({ path: targetPath, modelName: newSelection }));
  }, [selectedFolder, currentPath, selectedModelForCurrentPath, dispatch, isWebMode]);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electron) {
      setElectron(window.electron);
    }
  }, []);

  useEffect(() => {
    if (!isWebMode) return;
    getConfig()
      .then(cfg => setWebDefaultPath((cfg?.defaultPath || '').replace(/\\/g, '/')))
      .catch(() => {});
  }, [isWebMode]);


  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
      }
    };
  }, []);

  const fetchFiles = useCallback(async (path: string) => {
    if (isWebMode && isLoadingUser) return;

    try {
      let result: FileItem[] = [];
      let effectivePath = path || '';
      if (sharedBrowseModeRef.current && sharedScopeRef.current) {
        effectivePath = clampToSharedScope(effectivePath);
      }

      if (isWebMode && isAnonymousUser) {
        if (effectivePath.startsWith('users/')) {
          dispatch(setError('Access denied: Anonymous users can only access samples folder'));
          dispatch(setFileList([]));
          dispatch(setIsLoading(false));
          return;
        }
        if (effectivePath === '' || effectivePath.trim() === '') {
          effectivePath = 'samples';
        } else if (effectivePath !== 'samples' && !effectivePath.startsWith('samples/')) {
          effectivePath = 'samples';
        }
      }

      const normalizedPath = effectivePath || '';
      if (inFlightPathRef.current === normalizedPath) {
        return;
      }

      inFlightPathRef.current = normalizedPath;
      dispatch(setIsLoading(true));
      dispatch(setError(null));

      if (isWebMode) {
        if (sharedBrowseModeRef.current && !sharedScopeRef.current) {
          try {
            const list = await listSharedFiles();
            result = (list || []).map((doc: any) => {
              let mtime = 0;
              if (doc.updatedAt) {
                if (typeof doc.updatedAt === 'number') mtime = doc.updatedAt;
                else if (typeof doc.updatedAt === 'string') {
                  const d = new Date(doc.updatedAt);
                  mtime = isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
                }
              }

              const ownerId: string | undefined = doc.ownerId || doc.owner?.id || doc.owner;
              const localPath: string = (doc.localPath || '').replace(/^\/+|^\\+/, '');
              let normalizedPath = localPath || '';
              if (ownerId) {
                const prefix = `users/${ownerId}`;
                normalizedPath = normalizedPath.startsWith(prefix) ? normalizedPath : (normalizedPath ? `${prefix}/${normalizedPath}` : prefix);
              }

              return {
                name: doc.fileName || (localPath ? localPath.split('/').pop() : 'file'),
                path: normalizedPath,
                is_dir: !!doc.isDir,
                size: doc.fileSize || 0,
                mtime: mtime,
              } as FileItem;
            });
          } catch (e) {
            result = [];
          }
        } else {
          result = await listFiles(normalizedPath);
        }
      } else if (electron) {
        result = await electron.listLocalFiles(normalizedPath);
      } else {
        inFlightPathRef.current = null;
        dispatch(setIsLoading(false));
        return;
      }

      if (isWebMode && normalizedPath) {
        result = result.map((item) => normalizeChildPath(normalizedPath, item));
      }

      const sortedFiles = result.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return b.mtime - a.mtime;
      });
      // Track last fetched path to avoid loops
      lastFetchedPathRef.current = normalizedPath;
      dispatch(setFileList(sortedFiles));
      
      // Reset pagination offset when navigating to a new directory
      // (total and hasMore will be updated by useEffect based on filteredImageFiles)
      const previousDirectory = currentDirectoryRef.current;
      const shouldResetPagination = previousDirectory !== normalizedPath;
      currentDirectoryRef.current = normalizedPath;
      
      if (shouldResetPagination) {
        setPagination(prev => ({
          ...prev,
          offset: 0,
        }));
      }
      
      // Find and update associated tlcls models
      const tlclsFiles = findTlclsFiles(sortedFiles);
      dispatch(setAssociatedModels(tlclsFiles));
      
      // Update available models for this path
      dispatch(setAvailableModelsForPath({ path: normalizedPath, models: tlclsFiles }));
      
      // Validate existing selections
      dispatch(validateAllSelections());
      
      // Do not auto-select any model by default
    } catch (err: any) {
      const notAuth = err && (err.status === 401 || err.status === 403);
      const isSamplesPath = (selectedFolder || '').startsWith('samples');
      const shouldShowLoginError = notAuth && !(isAnonymousUser && isSamplesPath);
      const errorMessage = shouldShowLoginError ? 'Please login to browse cloud storage' : getErrorMessage(err, 'Failed to fetch files');
      dispatch(setError(errorMessage));
      dispatch(setFileList([]));
    } finally {
      inFlightPathRef.current = null;
      dispatch(setIsLoading(false));
    }
  }, [electron, dispatch, isWebMode, clampToSharedScope, selectedFolder, isAnonymousUser, isLoadingUser]);

  // Function to refresh file list (folder contents)
  const refreshFileList = useCallback(async () => {
    const currentPath = selectedFolder || '';
    await fetchFiles(currentPath);
  }, [selectedFolder, fetchFiles]);

  // Note: Multi-window sync removed after migration to fileManagerSlice
  // State is now managed globally through fileManagerSlice

  useEffect(() => {
    if (!isWebMode || isLoadingUser) return;
    let folderRaw = selectedFolder || '';
    if (isAnonymousUser && (folderRaw === '' || folderRaw.trim() === '')) {
      folderRaw = 'samples';
    }
    const folder = sharedBrowseModeRef.current ? clampToSharedScope(folderRaw) : folderRaw;
    if (lastFetchedPathRef.current !== folder) {
      fetchFiles(folder);
    }
  }, [isWebMode, selectedFolder, fetchFiles, clampToSharedScope, isLoadingUser, isAnonymousUser]);

  // Local/Electron: refresh folder list on mount when entering from dashboard (web useEffects skip when !isWebMode)
  useEffect(() => {
    if (isWebMode || !electron) return;
    const folder = selectedFolder || '';
    if (folder && lastFetchedPathRef.current !== folder) {
      fetchFiles(folder);
    }
  }, [isWebMode, electron, selectedFolder, fetchFiles]);

  useEffect(() => {
    if (!isWebMode) {
      prevUserIdentityRef.current = userIdentity;
      return;
    }

    const prevIdentity = prevUserIdentityRef.current;
    const currentIdentity = userIdentity;

    if (prevIdentity === undefined) {
      prevUserIdentityRef.current = currentIdentity;
      return;
    }

    if (prevIdentity !== currentIdentity) {
      if (prevIdentity === 2 && currentIdentity === 3) {
        const currentFolder = selectedFolder || '';
        lastFetchedPathRef.current = null;
        inFlightPathRef.current = null;
        if (currentFolder === 'samples' || currentFolder.startsWith('samples/')) {
          dispatch(setSelectedFolder(webDefaultPath || ''));
          fetchFiles(webDefaultPath || '').catch(() => {});
        } else if (currentFolder === '') {
          if (webDefaultPath) {
            dispatch(setSelectedFolder(webDefaultPath));
            fetchFiles(webDefaultPath).catch(() => {});
          } else {
            fetchFiles('').catch(() => {});
          }
        } else {
          fetchFiles(currentFolder).catch(() => {});
        }
      } else if (prevIdentity === 3 && currentIdentity === 2) {
        sharedBrowseModeRef.current = false;
        sharedScopeRef.current = null;
        lastFetchedPathRef.current = null;
        inFlightPathRef.current = null;
        clearViewerState();
        resetGuestFileBrowserState();
        const currentFolder = selectedFolder || '';
        if (currentFolder !== 'samples' && !currentFolder.startsWith('samples/')) {
          dispatch(setSelectedFolder('samples'));
          fetchFiles('samples').catch(() => {});
        } else {
          fetchFiles(currentFolder).catch(() => {});
        }
      }
      prevUserIdentityRef.current = currentIdentity;
    }
  }, [isWebMode, userIdentity, selectedFolder, dispatch, fetchFiles, webDefaultPath, clearViewerState, resetGuestFileBrowserState]);

  useEffect(() => {
    if (!isWebMode) return;
    const auth = getAuth(app);
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (user && !user.isAnonymous) {
        try {
          await auth.authStateReady();
          const folder = selectedFolder || '';
          const userId = user.uid;
          const lastUserId = sessionStorage.getItem('tl_last_user_id');
          
          if (lastUserId !== userId) {
            sessionStorage.setItem('tl_last_user_id', userId);
            if (prevUserIdentityRef.current === userIdentity) {
              await fetchFiles(folder);
            }
          }
        } catch (e) {
          // Silent fail
        }
      } else if (user?.isAnonymous) {
        sessionStorage.removeItem('tl_last_user_id');
        sharedBrowseModeRef.current = false;
        sharedScopeRef.current = null;
        lastFetchedPathRef.current = null;
        inFlightPathRef.current = null;

        const activePath = currentPath || '';
        const currentFolder = selectedFolder || '';
        let guestFolder = 'samples';

        if (currentFolder === 'samples' || currentFolder.startsWith('samples/')) {
          guestFolder = currentFolder;
        } else if (activePath.startsWith('samples/')) {
          const lastSlash = activePath.lastIndexOf('/');
          guestFolder = lastSlash > 0 ? activePath.substring(0, lastSlash) : 'samples';
        }

        resetGuestFileBrowserState();
        dispatch(setSelectedFolder(guestFolder));
        dispatch(setError(null));
        await fetchFiles(guestFolder);
      } else {
        sessionStorage.removeItem('tl_last_user_id');
        sharedBrowseModeRef.current = false;
        sharedScopeRef.current = null;
        lastFetchedPathRef.current = null;
        inFlightPathRef.current = null;
        clearViewerState();
        resetGuestFileBrowserState();
        dispatch(setSelectedFolder('samples'));
        dispatch(setError(null));
        await fetchFiles('samples');
      }
    });
    return () => unsubscribe();
  }, [isWebMode, fetchFiles, selectedFolder, userIdentity, clearViewerState, dispatch, resetGuestFileBrowserState, currentPath]);

  const handleFolderSelect = async () => {
    if (isWebMode) {
      dispatch(setError('Folder selection is only available in local mode.'));
      dispatch(setError('Folder selection is only available in local mode.'));
      return;
    }
    if (!electron) return;
    try {
      const result = await electron.invoke('open-folder-dialog');
      if (result && result.filePaths && result.filePaths[0]) {
        suppressAutoNavigateRef.current = true;
        dispatch(setSelectedFolder(result.filePaths[0]));
        dispatch(setSelectedFolder(result.filePaths[0]));
        await fetchFiles(result.filePaths[0]);
        dispatch(setIsMinimized(false));
      }
    } catch (err) {
      dispatch(setError('Failed to open folder.'));
      dispatch(setError('Failed to open folder.'));
    }
  };

  const handleWsiUpload = useCallback(async (absolutePath: string) => {
    if (isFileLoading) return;
    
    setIsFileLoading(true);
    setLoadingFile(absolutePath);
    
    try {
      if (isWebMode) {
        const auth = getAuth(app);
        await auth.authStateReady().catch(() => {});
        if (!auth.currentUser) {
          await signInAnonymous('viewer-open-sample');
          await auth.authStateReady().catch(() => {});
        }
      }

      const uploadData = await uploadFilePath(absolutePath);
      const instanceData = await createInstance(uploadData.filePath ?? uploadData.fileName);
      const loadData = await loadFileData(uploadData.fileName);
      
      dispatch(updateInstanceWSIInfo(loadData));
      dispatch(setCurrentPath({ path: absolutePath }) as PayloadAction<{ path: string | null }>);
      dispatch(setOutputPath(absolutePath ? absolutePath + '.zarr' : ''));
      dispatch(setSlideInfo({
        dimensions: (uploadData.slideInfo.dimensions ?? null) as [number, number] | null,
        fileSize: uploadData.fileSize ?? null,
        mpp: uploadData.slideInfo.mpp ?? null,
        magnification: uploadData.slideInfo.magnification ?? null,
      }));
      
      dispatch(replaceCurrentInstance({
        instanceId: instanceData.instanceId,
        wsiInfo: {
          ...loadData,
          instanceId: instanceData.instanceId
        },
        fileInfo: {
          fileName: absolutePath.split(/[\\/]/).pop() || '',
          filePath: absolutePath,
          source: isWebMode ? 'web' : 'local'
        }
      }));
      
      dispatch(setCurrentImagePath(absolutePath));
      dispatch(setImageLoaded(true));
      setInstanceId(instanceData.instanceId);

      if (isWebMode) {
        await fetchFiles(selectedFolder || '');
      }
    } catch (err) {
      dispatch(setError(getErrorMessage(err, "Failed to load WSI file.")));
    } finally {
      setIsFileLoading(false);
      setLoadingFile(null);
    }
  }, [isFileLoading, dispatch, setInstanceId, isWebMode, fetchFiles, selectedFolder, signInAnonymous]);

  const handleItemClick = useCallback((item: FileItem) => {
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
    }
    
    clickTimeoutRef.current = setTimeout(() => {
      if (item.is_dir) {
        suppressAutoNavigateRef.current = true;
        const nextPath = sharedBrowseModeRef.current ? clampToSharedScope(item.path) : item.path;
        fetchFiles(nextPath);
        dispatch(setSelectedFolder(nextPath));
        dispatch(setSelectedFolder(nextPath));
      } else if (isWSI(item.name)) {
        handleWsiUpload(item.path);
      }
    }, 300);
  }, [fetchFiles, dispatch, handleWsiUpload, clampToSharedScope]);

  // Restore shared context from dashboard (sessionStorage) and sync folder so list refreshes when entering from dashboard
  useEffect(() => {
    if (!sharedContextRestoredRef.current) {
      const restored = restoreSharedContextFromSession();
      if (restored) {
        sharedContextRestoredRef.current = true;
        const dir = restored.currentDirectory;
        if (typeof dir === 'string' && dir !== '' && isWebMode) {
          dispatch(setSelectedFolder(dir));
          lastFetchedPathRef.current = null;
          fetchFiles(dir).catch(() => {});
        }
      }
    }
  }, [dispatch, fetchFiles, isWebMode]);

  // Auto-navigate to the folder containing the opened image
  useEffect(() => {
    if (!currentPath) return;
    if (suppressAutoNavigateRef.current) {
      suppressAutoNavigateRef.current = false;
      return;
    }
    if (!isWebMode && !electron) return;
    if (isWebMode && isLoadingUser) return;

    const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
    const lastIndex = currentPath.lastIndexOf(separator);
    let parentDir = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);

    if (sharedBrowseModeRef.current && sharedScopeRef.current) {
      parentDir = clampToSharedScope(parentDir);
    }

    if (isWebMode && isAnonymousUser) {
      if (parentDir !== 'samples' && !parentDir.startsWith('samples/')) {
        if (currentPath.startsWith('samples/')) {
          parentDir = 'samples';
        } else {
          return;
        }
      }
      if (parentDir.startsWith('users/')) {
        if (currentPath.startsWith('samples/')) {
          parentDir = 'samples';
        } else {
          return;
        }
      }
    }

    const shouldUpdate = isWebMode ? selectedFolder !== parentDir : (parentDir && parentDir !== selectedFolder);
    if (shouldUpdate) {
      dispatch(setSelectedFolder(parentDir));
      dispatch(setSelectedFolder(parentDir));
      fetchFiles(parentDir);
      dispatch(setIsMinimized(false));
    }
  }, [currentPath, dispatch, fetchFiles, selectedFolder, isWebMode, electron, clampToSharedScope, isAnonymousUser, isLoadingUser]);

  const filteredFiles = fileList.filter(file =>
    file.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const viewerVisibleFiles = useMemo(() => {
    return filteredFiles.filter(file => !isZarr(file.name));
  }, [filteredFiles]);

  const folderFiles = useMemo(() => {
    return viewerVisibleFiles.filter(file => file.is_dir);
  }, [viewerVisibleFiles]);

  // Filter image files from filtered files
  const filteredImageFiles = useMemo(() => {
    return viewerVisibleFiles.filter(file => !file.is_dir && isWSI(file.name));
  }, [viewerVisibleFiles]);

  // Apply pagination to filtered image files
  const imageFiles = useMemo(() => {
    if (pagination.limit === null) {
      // Show all filtered image files if limit is null
      return filteredImageFiles;
    }
    // Apply pagination
    const { offset, limit } = pagination;
    const startIndex = Math.max(0, offset);
    const endIndex = Math.min(filteredImageFiles.length, offset + limit);
    return filteredImageFiles.slice(startIndex, endIndex);
  }, [filteredImageFiles, pagination]);

  // Update pagination when filtered image files change (due to search or folder change)
  useEffect(() => {
    const filteredTotal = filteredImageFiles.length;
    const searchTermChanged = prevSearchTermRef.current !== searchTerm;
    
    if (!searchTermChanged && pagination.total === filteredTotal) {
      return;
    }
    
    prevSearchTermRef.current = searchTerm;
    
    setPagination(prev => {
      const shouldReset = searchTermChanged || prev.offset >= filteredTotal;
      const newHasMore = prev.limit !== null && (shouldReset ? filteredTotal > prev.limit : prev.offset + (prev.limit || 0) < filteredTotal);
      
      if (prev.total === filteredTotal && prev.hasMore === newHasMore && !shouldReset && prev.offset < filteredTotal) {
        return prev;
      }
      
      return {
        offset: shouldReset ? 0 : prev.offset,
        limit: prev.limit,
        total: filteredTotal,
        hasMore: newHasMore,
      };
    });
  }, [filteredImageFiles.length, searchTerm, pagination.total, pagination.offset, pagination.limit]);

  useEffect(() => {
    const validPaths = new Set(imageFiles.map(file => file.path));
    setFileTaskStates(prev => {
      const entries = Object.entries(prev).filter(([path]) => validPaths.has(path));
      if (entries.length === Object.keys(prev).length) {
        return prev;
      }

      const next: Record<string, FileTaskState> = {};
      for (const [path, state] of entries) {
        next[path] = state;
      }
      return next;
    });
  }, [imageFiles]);

  // Pagination handlers
  const handlePreviousPage = useCallback(() => {
    if (pagination.offset > 0 && pagination.limit !== null) {
      const newOffset = Math.max(0, pagination.offset - pagination.limit);
      setPagination(prev => ({ 
        ...prev, 
        offset: newOffset,
        hasMore: newOffset + prev.limit! < prev.total
      }));
    }
  }, [pagination.offset, pagination.limit, pagination.total]);

  const handleNextPage = useCallback(() => {
    if (pagination.hasMore && pagination.limit !== null) {
      const newOffset = pagination.offset + pagination.limit;
      setPagination(prev => ({ 
        ...prev, 
        offset: newOffset,
        hasMore: newOffset + prev.limit! < prev.total
      }));
    }
  }, [pagination]);

  const handlePageClick = useCallback((page: number) => {
    if (pagination.limit !== null) {
      const newOffset = (page - 1) * pagination.limit;
      setPagination(prev => ({ 
        ...prev, 
        offset: newOffset,
        hasMore: newOffset + prev.limit! < prev.total
      }));
    }
  }, [pagination.limit, pagination.total]);

  const renderPagination = () => {
    if (pagination.limit === null || pagination.total === 0) {
      return null;
    }

    const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
    const totalPages = Math.ceil(pagination.total / pagination.limit);
    const startItem = pagination.total > 0 ? pagination.offset + 1 : 0;
    const endItem = Math.min(pagination.offset + pagination.limit, pagination.total);

    // Generate page numbers to display
    const getPageNumbers = (): (number | 'ellipsis')[] => {
      const pages: (number | 'ellipsis')[] = [];
      const maxVisiblePages = 5;
      
      if (totalPages <= maxVisiblePages) {
        for (let i = 1; i <= totalPages; i++) {
          pages.push(i);
        }
      } else {
        pages.push(1);
        if (currentPage > 3) pages.push('ellipsis');
        
        const start = Math.max(2, currentPage - 1);
        const end = Math.min(totalPages - 1, currentPage + 1);
        for (let i = start; i <= end; i++) {
          if (i !== 1 && i !== totalPages) {
            pages.push(i);
          }
        }
        
        if (currentPage < totalPages - 2) pages.push('ellipsis');
        if (totalPages > 1) pages.push(totalPages);
      }
      
      return pages;
    };

    const pageNumbers = getPageNumbers();

    return (
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pl-4 pr-5 py-2 bg-muted">
        <div className="text-xs text-muted-foreground">
          Showing {startItem}-{endItem} of {pagination.total}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (currentPage > 1 && !isLoading) {
                handlePageClick(1);
              }
            }}
            disabled={currentPage <= 1 || isLoading}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-30"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (pagination.offset > 0 && !isLoading) {
                handlePreviousPage();
              }
            }}
            disabled={pagination.offset === 0 || isLoading}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          
          {pageNumbers.map((page, index) => (
            <React.Fragment key={index}>
              {page === 'ellipsis' ? (
                <span className="px-2 text-muted-foreground">...</span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (page !== currentPage && !isLoading) {
                      handlePageClick(page);
                    }
                  }}
                  disabled={isLoading}
                  className={`h-7 min-w-7 px-2 text-xs ${
                    page === currentPage
                      ? 'bg-accent/40 text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
                  }`}
                >
                  {page}
                </Button>
              )}
            </React.Fragment>
          ))}
          
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (pagination.hasMore && !isLoading) {
                handleNextPage();
              }
            }}
            disabled={!pagination.hasMore || isLoading}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!isLoading && pagination.limit !== null && currentPage < totalPages) {
                handlePageClick(totalPages);
              }
            }}
            disabled={currentPage >= totalPages || isLoading}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-30"
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  };
  useEffect(() => {
    try {
      const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent || '');
      const isElectron = typeof window !== 'undefined' && !!(window as any).electron;
      setIsMacElectron(Boolean(isMac && isElectron));
    } catch {}
  }, []);

  // Minimized state - hide the sidebar completely, expand button is now in ViewerToolbar
  if (isMinimized) {
    return null;
  }

  return (
    <div className="w-80 bg-card border-r border-border flex flex-col h-full transition-all duration-300 ease-in-out">
      {isMacElectron && <div className="w-full h-2 bg-muted" />}
      {/* Header */}
      <div className="bg-muted border-b border-border p-3 electron-drag">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 flex-1 min-w-0 electron-no-drag">
            <FolderOpen className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span className="text-sm font-medium text-foreground truncate">
              {(() => {
                if (!isWebMode) {
                  return selectedFolder
                    ? truncateFileName(selectedFolder.split(/[\\/]/).pop() || selectedFolder, 20)
                    : 'File Browser';
                }

                // Web mode logic
                // Shared root: show label explicitly
                if (sharedBrowseModeRef.current && !sharedScopeRef.current) return 'Shared with me';
                if (selectedFolder === '') return 'Root';
                if (selectedFolder === 'samples') return 'Samples';
                
                // Handle Personal folder and its subfolders
                if (webDefaultPath && webDefaultPath !== 'samples') {
                  if (selectedFolder === webDefaultPath) {
                    return 'Personal';
                  }
                  
                  if (selectedFolder.startsWith(webDefaultPath + '/')) {
                    // Show the current directory name (last part of the path)
                    const currentDirName = selectedFolder.split('/').pop() || selectedFolder;
                    return truncateFileName(currentDirName, 20);
                  }
                }
                
                // Handle loading state - show Personal if currentPath is in Personal folder
                if (webDefaultPath && currentPath && currentPath.startsWith(webDefaultPath + '/') && webDefaultPath !== 'samples') {
                  return 'Personal';
                }
                
                // Default: show folder name
                return truncateFileName(selectedFolder.split('/').pop() || selectedFolder, 20);
              })()}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dispatch(setIsMinimized(true))}
            className="h-6 px-2 text-muted-foreground hover:text-foreground hover:bg-accent/40 flex-shrink-0 flex items-center gap-1 transition-all duration-200 electron-no-drag"
          >
            <ChevronLeft className="h-3 w-3" />
            <span className="text-xs">Minimize</span>
          </Button>
        </div>
        
         {/* Search Bar */}
         <div className="relative electron-no-drag">
           <div className="flex items-center gap-2 w-full">
           <div className="flex items-center flex-1 h-8 rounded-sm bg-muted">
               <div className="flex items-center justify-center w-8 h-8">
               <Search className="h-3 w-3 text-muted-foreground" />
               </div>
               <input
                 type="text"
                 placeholder="Search files..."
                 value={searchTerm}
                 onChange={(e) => dispatch(setSearchTerm(e.target.value))}
               className="flex-1 h-full bg-transparent border-0 outline-none text-xs px-1 text-foreground placeholder:text-muted-foreground"
               />
               {searchTerm && (
                 <button
                   onClick={() => dispatch(setSearchTerm(''))}
                 className="flex items-center justify-center w-8 h-8 text-muted-foreground hover:text-foreground"
                 >
                   <X className="h-3 w-3" />
                 </button>
               )}
             </div>
             <div className="flex items-center">
               <Button
                 variant="outline" 
                 size="sm"
                 onClick={refreshFileList}
                 disabled={isLoading}
                 className="h-8 w-8 p-0 flex-shrink-0 rounded-l-sm border-r-0 border border-transparent bg-muted text-foreground hover:bg-accent/40 electron-no-drag"
                 title="Refresh file list"
               >
                 <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
               </Button>
               <Button
                 variant="outline" 
                 size="sm"
                 onClick={() => dispatch(setViewMode(viewMode === 'full' ? 'nameOnly' : 'full'))}
                 className="h-8 w-8 p-0 flex-shrink-0 rounded-r-sm border border-transparent bg-muted text-foreground hover:bg-accent/40 electron-no-drag"
                 title={viewMode === 'full' ? 'Switch to name-only view' : 'Switch to full view'}
               >
                 {viewMode === 'full' ? <List className="h-4 w-4" /> : <Grid className="h-4 w-4" />}
               </Button>
             </div>
           </div>
         </div>

        {/* Select Folder */}
        <div className="flex gap-2 mt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleFolderSelect}
            className="flex-1 h-7 text-xs rounded-sm bg-primary text-primary-foreground hover:bg-primary/90 border border-transparent electron-no-drag"
          >
            <Folder className="h-3 w-3 mr-1" />
            Select Folder
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col min-h-0">
        <ScrollArea className="flex-1">
          {isLoading && (
            <div className="p-4 text-center text-muted-foreground">
              <InlineSpinner size={24} color="var(--primary)" className="mx-auto" />
              <div className="text-xs mt-2">Loading...</div>
            </div>
          )}
          
          {error && (
            <div className="px-3 py-2">
              <div className="mx-auto max-w-[260px] p-2 rounded border bg-primary/10 border-primary/20 text-primary text-[11px] flex items-center justify-center gap-1">
                <Info className="w-3 h-3" />
                <span>{error}</span>
              </div>
            </div>
          )}
          
          {/* Empty hints */}
          {!isLoading && !error && !isWebMode && !selectedFolder && (
            <div className="p-4 text-center text-muted-foreground text-xs">
              Select a folder to browse files
            </div>
          )}
          {!isLoading && !error && isWebMode && selectedFolder === '' && viewerVisibleFiles.length === 0 && (
            <div className="p-4 text-center text-muted-foreground text-xs">No files found</div>
          )}
          {!isLoading && !error && selectedFolder && viewerVisibleFiles.length === 0 && (
            <div className="p-4 text-center text-muted-foreground text-xs">No files found</div>
          )}
          {!isLoading && !error && selectedFolder && imageFiles.length === 0 && folderFiles.length === 0 && (
            <div className="p-4 text-center text-muted-foreground text-xs">No image files found in this folder</div>
          )}

          {!isLoading && !error && ((isWebMode && selectedFolder === '') || selectedFolder) && folderFiles.length > 0 && (
            <div className="w-full border-b border-border/60">
              <div className="p-2 bg-muted border-b border-border text-xs font-medium text-muted-foreground">
                <div className="text-left">Folders</div>
              </div>
              <div>
                {folderFiles.map((folder, index) => (
                  <div
                    key={`${folder.path}-${index}`}
                    className="flex items-center gap-3 p-3 border-b border-border transition-colors duration-200 hover:bg-accent/40 cursor-pointer"
                    onClick={() => handleItemClick(folder)}
                  >
                    <Folder className="h-4 w-4 text-primary flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-foreground truncate leading-tight">
                        {truncateFileName(folder.name, 35)}
                      </div>
                      <div className="text-xs text-muted-foreground truncate mt-1">
                        Folder
                      </div>
                    </div>
                    <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* File List */}
          {!isLoading && !error && ((isWebMode && selectedFolder === '') || selectedFolder) && filteredImageFiles.length > 0 && (
            <div className="w-full transition-all duration-300 ease-in-out">
              {viewMode === 'full' ? (
                <>
                  {/* Header - Full View */}
                  <div 
                    className="grid gap-1 p-2 bg-muted border-b border-border text-xs font-medium text-muted-foreground"
                    style={{ gridTemplateColumns: '1fr 1fr 1.2fr' }}
                  >
                    <div className="text-center">Label</div>
                    <div className="text-center">Thumb</div>
                    <div className="text-left">Item</div>
                  </div>

                  {/* File Rows - Full View */}
                  <div>
                    {imageFiles.map((file, index) => {
                      const taskState = fileTaskStates[file.path];
                      const showProgress = taskState && taskState.status !== 'idle';
                      const isError = taskState?.status === 'error';
                      
                      // Calculate queue position for queued files
                      let statusLabel = taskState
                        ? (isError && taskState.error ? taskState.error : TASK_STATUS_LABELS[taskState.status])
                        : '';
                      
                      if (taskState?.status === 'queued') {
                        // Use queue position from SSE data if available
                        if (taskState.queuePosition && taskState.queuePosition > 1) {
                          const ahead = taskState.queuePosition - 1;
                          statusLabel = `${ahead} people ahead`;
                        } else {
                          statusLabel = 'Next';
                        }
                      }
                      
                      const progressValue = taskState ? Math.max(0, Math.min(100, Math.round(taskState.progress))) : 0;

                      return (
                        <div 
                          key={`${file.path}-${index}`} 
                          className={`relative grid gap-1 p-2 border-b border-border items-center transition-colors duration-200 ${
                            isFileLoading && loadingFile === file.path 
                              ? 'bg-muted cursor-wait' 
                              : (isActiveFile(file.path)
                                  ? 'bg-primary/10 cursor-pointer'
                                  : 'hover:bg-accent/40 cursor-pointer')
                          }`}
                          style={{ gridTemplateColumns: '1fr 1fr 1.2fr', minHeight: '60px' }}
                          onClick={() => handleItemClick(file)}
                          aria-selected={isActiveFile(file.path)}
                        >
                          {isActiveFile(file.path) && (
                            <span className="absolute left-0 top-0 h-full w-0.5 bg-primary" />
                          )}
                          {/* Label Column */}
                          <div className="flex justify-center">
                            <div className="w-12 h-9 border border-border rounded-sm bg-muted shadow-sm">
                              <ImagePreviewCell 
                                fileName={file.name} 
                                fullPath={file.path}
                                imageType="label"
                              />
                            </div>
                          </div>

                          {/* Thumbnail Column */}
                          <div className="flex justify-center">
                            <div className="w-12 h-9 border border-border rounded-sm bg-muted shadow-sm">
                              <ImagePreviewCell 
                                fileName={file.name} 
                                fullPath={file.path}
                                imageType="thumbnail"
                              />
                            </div>
                          </div>

                          {/* Item Column */}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="flex-1">
                                <div className="text-xs font-medium text-foreground hover:text-foreground/80 hover:underline truncate leading-tight">
                                  {truncateFileName(file.name, 18)}
                                </div>
                                <div className="text-xs text-muted-foreground truncate">
                                  {new Date(file.mtime * 1000).toLocaleDateString()}
                                </div>
                              </div>
                              {isFileLoading && loadingFile === file.path && (
                                <InlineSpinner size={12} color="var(--primary)" className="flex-shrink-0" />
                              )}
                              {isError && (
                                <X className="h-4 w-4 text-destructive flex-shrink-0" />
                              )}
                              {isActiveFile(file.path) && (
                                <span className="h-2 w-2 rounded-full bg-primary flex-shrink-0"></span>
                              )}
                            </div>
                            {showProgress && (
                              <div className="mt-2">
                                <Progress value={progressValue} className="h-1.5 bg-muted" />
                                <div className={`flex items-center justify-between text-[10px] mt-1 ${isError ? 'text-destructive' : 'text-muted-foreground'}`}>
                                  <span className="truncate pr-2">{statusLabel}</span>
                                  <span>{progressValue}%</span>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  {/* Header - Name Only View */}
                  <div className="p-2 bg-muted border-b border-border text-xs font-medium text-muted-foreground">
                    <div className="text-left">Files</div>
                  </div>
                  <div>
                    {imageFiles.map((file, index) => {
                      const taskState = fileTaskStates[file.path];
                      const showProgress = taskState && taskState.status !== 'idle';
                      const isError = taskState?.status === 'error';
                      
                      // Calculate queue position for queued files
                      let statusLabel = taskState
                        ? (isError && taskState.error ? taskState.error : TASK_STATUS_LABELS[taskState.status])
                        : '';
                      
                      if (taskState?.status === 'queued') {
                        // Use queue position from SSE data if available
                        if (taskState.queuePosition && taskState.queuePosition > 1) {
                          const ahead = taskState.queuePosition - 1;
                          statusLabel = `${ahead} people ahead`;
                        } else {
                          statusLabel = 'Next';
                        }
                      }
                      
                      const progressValue = taskState ? Math.max(0, Math.min(100, Math.round(taskState.progress))) : 0;

                      return (
                        <div 
                          key={`${file.path}-${index}`} 
                          className={`relative p-3 border-b border-border transition-colors duration-200 ${
                            isFileLoading && loadingFile === file.path 
                              ? 'bg-muted cursor-wait' 
                              : (isActiveFile(file.path)
                                  ? 'bg-primary/10 cursor-pointer'
                                  : 'hover:bg-accent/40 cursor-pointer')
                          }`}
                          aria-selected={isActiveFile(file.path)}
                          onClick={() => handleItemClick(file)}
                        >
                          {isActiveFile(file.path) && (
                            <span className="absolute left-0 top-0 h-full w-0.5 bg-primary" />
                          )}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="flex-1">
                                <div className="text-xs font-medium text-foreground hover:text-foreground/80 hover:underline truncate leading-tight">
                                  {truncateFileName(file.name, 35)}
                                </div>
                                <div className="text-xs text-muted-foreground truncate mt-1">
                                  {new Date(file.mtime * 1000).toLocaleDateString()}
                                </div>
                              </div>
                              {isFileLoading && loadingFile === file.path && (
                                <InlineSpinner size={12} color="var(--primary)" className="flex-shrink-0" />
                              )}
                              {isError && (
                                <X className="h-4 w-4 text-destructive flex-shrink-0" />
                              )}
                              {isActiveFile(file.path) && (
                                <span className="h-2 w-2 rounded-full bg-primary flex-shrink-0"></span>
                              )}
                            </div>
                            {showProgress && (
                              <div className="mt-2">
                                <Progress value={progressValue} className="h-1.5 bg-muted" />
                                <div className={`flex items-center justify-between text-[10px] mt-1 ${isError ? 'text-destructive' : 'text-muted-foreground'}`}>
                                  <span className="truncate pr-2">{statusLabel}</span>
                                  <span>{progressValue}%</span>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </ScrollArea>

        {/* Pagination */}
        {filteredImageFiles.length > 0 && (
          <div className="border-t border-border">
            {renderPagination()}
          </div>
        )}

        {/* Associated Models Section */}
        <AssociatedModelsSection
          selectedFolder={selectedFolder}
          electron={electron}
          imageFiles={filteredImageFiles}
          fileTaskStates={fileTaskStates}
          setFileTaskStates={setFileTaskStates}
        />
      </div>
    </div>
  );
};

export default FileBrowserSidebar;
