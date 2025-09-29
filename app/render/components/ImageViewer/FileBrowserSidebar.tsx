import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Image from 'next/image';
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { ChevronRight, ChevronLeft,
        Folder, X, Search, FolderOpen, Grid, List, Image as ImageIcon, Info } from 'lucide-react';
import AssociatedModelsSection from './AssociatedModelsSection';

import { useDispatch, useSelector } from 'react-redux';
import { updateInstanceWSIInfo, replaceCurrentInstance } from '@/store/slices/wsiSlice';
import { setCurrentPath, setSlideInfo } from '@/store/slices/svsPathSlice';
import { PayloadAction } from '@reduxjs/toolkit';
import { setImageLoaded } from '@/store/slices/sidebarSlice';
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
} from '@/store/slices/webFileManagerSlice';
import {
  updateWindowFolder,
  updateWindowFileList,
  updateWindowImage,
  setWindowLoading,
  setWindowError,
} from '@/store/slices/multiWindowSlice';
import { useRouter } from 'next/router';
import { uploadFilePath, loadFileData, createInstance, getPreviewAsync } from '@/utils/file.service';
import { useAnnotatorInstance } from '@/contexts/AnnotatorContext';
import { listFiles, listSharedFiles, getConfig } from '@/utils/fileManager.service';
import { shortHashFromString } from '@/utils/string.utils';
import { getAuth } from 'firebase/auth';
import { app } from '@/config/firebaseConfig';
import { autoSelectFirstModel, selectSelectedModelForPath, setAvailableModelsForPath, setSelectedModelForPath, validateAllSelections } from '@/store/slices/modelSelectionSlice';
import type { FileTaskState, FileTaskStatus } from './fileTaskTypes';

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

    loadingRef.current = true;
    setIsLoading(true);
    setError(null);

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
      
      setPreviewData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load preview');
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

  const getCurrentImage = () => {
    if (!previewData) return null;
    return previewData[imageType];
  };

  if (isLoading) {
    return (
      <div 
        ref={setElementRef}
        className="w-full h-full bg-gray-100 rounded flex items-center justify-center"
      >
        <div className="animate-spin rounded-full h-3 w-3 border border-blue-500 border-t-transparent"></div>
      </div>
    );
  }

  const currentImage = getCurrentImage();


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
        <div className="w-full h-full bg-gray-100 rounded flex items-center justify-center">
          <ImageIcon className="h-3 w-3 text-gray-400" />
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


const FileBrowserSidebar: React.FC = () => {
  const dispatch = useDispatch();
  const router = useRouter();
  const { setInstanceId } = useAnnotatorInstance();
  const {
    selectedFolder,
    fileList,
    isLoading,
    error,
    searchTerm,
    isMinimized,
    viewMode,
  } = useSelector((state: RootState) => state.webFileManager);
  
  const { activeWindow, windows } = useSelector((state: RootState) => state.multiWindow);
  const { activeInstanceId, instances } = useSelector((state: RootState) => state.wsi);
  const isWebMode = useMemo(() => {
    const activeInstance = activeInstanceId ? instances[activeInstanceId] : undefined;
    const source = activeInstance?.fileInfo?.source as string | undefined;
    return source === 'web';
  }, [activeInstanceId, instances]);
  const currentWindow = windows[activeWindow];
  // Get current path from Redux store to auto-navigate to the folder containing the opened image
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  
  const isActiveFile = useCallback((p: string) => {
    // Only use currentWindow.currentImagePath for highlighting
    return currentWindow && currentWindow.currentImagePath === p;
  }, [currentWindow]);
  
  // (moved up) currentPath selector used for active item highlight and auto-navigation

  // Get selected model for current path
  const selectedModelForCurrentPath = useSelector((state: RootState) => {
    // Use selectedFolder if available, otherwise try to get parent directory from currentPath
    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }
    // In web mode, empty string means root directory
    if (isWebMode && targetPath === '') {
      targetPath = '';
    }
    return selectSelectedModelForPath(state, targetPath);
  });
  
  const [electron, setElectron] = useState<any>(null);
  const [webDefaultPath, setWebDefaultPath] = useState<string>('');
  const [modelsMinimized, setModelsMinimized] = useState(true);
  const [isMacElectron, setIsMacElectron] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastFetchedPathRef = useRef<string | null>(null);
  const suppressAutoNavigateRef = useRef<boolean>(false);
  const [fileTaskStates, setFileTaskStates] = useState<Record<string, FileTaskState>>({});

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

  // Function to refresh associated models for current folder
  const refreshAssociatedModels = useCallback(async () => {
    const currentPath = selectedFolder || '';
    // In web mode, empty string means root directory, so it's valid
    if (!isWebMode && !currentPath) return;

    try {
      let result: FileItem[] = [];
      
      if (isWebMode) {
        result = await listFiles(currentPath);
      } else if (electron) {
        result = await electron.listLocalFiles(currentPath);
      } else {
        return;
      }

      // Find and update associated tlcls models
      const tlclsFiles = findTlclsFiles(result);
      dispatch(setAssociatedModels(tlclsFiles));
      
      // Update available models for this path
      dispatch(setAvailableModelsForPath({ path: currentPath, models: tlclsFiles }));
      
      // Validate existing selections
      dispatch(validateAllSelections());
      
      // Auto-select first model if none selected (only if no current selection)
      const currentSelection = selectedModelForCurrentPath;
      if (!currentSelection && tlclsFiles.length > 0) {
        dispatch(autoSelectFirstModel(currentPath));
      }
    } catch (err: any) {
      console.error('Error refreshing associated models:', err);
      dispatch(setAssociatedModels([]));
      dispatch(setAvailableModelsForPath({ path: currentPath, models: [] }));
    }
  }, [selectedFolder, isWebMode, electron, dispatch, selectedModelForCurrentPath]);

  // Handle expand button click
  const handleModelsExpandClick = useCallback(() => {
    const newMinimizedState = !modelsMinimized;
    setModelsMinimized(newMinimizedState);
    
    // If expanding, refresh associated models
    if (newMinimizedState === false) {
      refreshAssociatedModels();
    }
  }, [modelsMinimized, refreshAssociatedModels]);

  // Handle model selection
  const handleModelClick = useCallback((modelName: string) => {
    // Use selectedFolder if available, otherwise try to get parent directory from currentPath
    let targetPath = selectedFolder || '';
    if (!targetPath && currentPath) {
      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);
    }
    
    // In web mode, empty string means root directory, so it's valid
    if (!isWebMode && !targetPath) {
      console.warn('No target path, returning');
      return;
    }
    
    // Toggle selection using the pre-fetched selected model
    const newSelection = selectedModelForCurrentPath === modelName ? null : modelName;
    dispatch(setSelectedModelForPath({ path: targetPath, modelName: newSelection }));
  }, [selectedFolder, currentPath, selectedModelForCurrentPath, dispatch, isWebMode]);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electron) {
      setElectron(window.electron);
    }
  }, []);

  // Load web defaultPath for labeling "Personal" at root of user's folder
  useEffect(() => {
    const loadDefault = async () => {
      if (!isWebMode) return;
      try {
        const cfg = await getConfig();
        setWebDefaultPath((cfg?.defaultPath || '').replace(/\\/g, '/'));
      } catch (e) {
        // no-op
      }
    };
    loadDefault();
  }, [isWebMode]);


  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
      }
    };
  }, []);

  const fetchFiles = useCallback(async (path: string) => {
    dispatch(setIsLoading(true));
    dispatch(setError(null));
    dispatch(setWindowLoading({ windowId: activeWindow, isLoading: true }));
    dispatch(setWindowError({ windowId: activeWindow, error: null }));

    try {
      let result: FileItem[] = [];
      let effectivePath = (path || '');
      // If we are in shared mode, clamp to shared scope
      if (sharedBrowseModeRef.current && sharedScopeRef.current) {
        effectivePath = clampToSharedScope(effectivePath);
      }

      if (isWebMode) {
        // Shared root: list all shared files (flat)
        if (sharedBrowseModeRef.current && !sharedScopeRef.current) {
          try {
            const list = await listSharedFiles();
            result = (list || []).map((doc: any) => {
              // Timestamps to seconds
              let mtime = 0;
              if (doc.updatedAt) {
                if (typeof doc.updatedAt === 'number') mtime = doc.updatedAt;
                else if (typeof doc.updatedAt === 'string') {
                  const d = new Date(doc.updatedAt); mtime = isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
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
          result = await listFiles(effectivePath || '');
        }
      } else if (electron) {
        result = await electron.listLocalFiles(effectivePath);
      } else {
        // Local mode but Electron not ready yet; defer without error
        dispatch(setIsLoading(false));
        dispatch(setWindowLoading({ windowId: activeWindow, isLoading: false }));
        return;
      }

      const sortedFiles = result.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return b.mtime - a.mtime; // Sort by last modified time in descending order
      });
      // Track last fetched path to avoid loops
      lastFetchedPathRef.current = effectivePath || '';
      dispatch(setFileList(sortedFiles));
      dispatch(updateWindowFileList({ windowId: activeWindow, fileList: sortedFiles }));
      
      // Find and update associated tlcls models
      const tlclsFiles = findTlclsFiles(sortedFiles);
      dispatch(setAssociatedModels(tlclsFiles));
      
      // Update available models for this path
      dispatch(setAvailableModelsForPath({ path: effectivePath || '', models: tlclsFiles }));
      
      // Validate existing selections
      dispatch(validateAllSelections());
      
      // Auto-select first model if none selected (only if no current selection)
      // Note: We'll let the component's useEffect handle auto-selection to avoid stale closure issues
      if (tlclsFiles.length > 0) {
        dispatch(autoSelectFirstModel(effectivePath || ''));
      }
    } catch (err: any) {
      const notAuth = err && (err.status === 401 || err.status === 403);
      const errorMessage = notAuth ? 'Please login to browse cloud storage' : (err.message || 'Failed to fetch files');
      dispatch(setError(errorMessage));
      dispatch(setFileList([]));
      dispatch(setWindowError({ windowId: activeWindow, error: errorMessage }));
      dispatch(updateWindowFileList({ windowId: activeWindow, fileList: [] }));
    } finally {
      dispatch(setIsLoading(false));
      dispatch(setWindowLoading({ windowId: activeWindow, isLoading: false }));
    }
  }, [electron, dispatch, activeWindow, isWebMode, clampToSharedScope]);

  // Sync when active window changes; for web mode, fetch remote list once; for local, copy window data
  useEffect(() => {
    if (!currentWindow) return;
    dispatch(setSelectedFolder(currentWindow.selectedFolder));
    if (!isWebMode) {
      // Local mode: reflect current window's cached state
      dispatch(setFileList(currentWindow.fileList));
      dispatch(setIsLoading(currentWindow.isLoading));
      dispatch(setError(currentWindow.error));
    } else {
      const folderRaw = currentWindow.selectedFolder || '';
      const folder = sharedBrowseModeRef.current ? clampToSharedScope(folderRaw) : folderRaw;
      if (lastFetchedPathRef.current !== folder) {
        fetchFiles(folder);
      }
    }
  }, [activeWindow, currentWindow, dispatch, fetchFiles, isWebMode, clampToSharedScope]);

  // On mount or when switching to web mode, refresh list from server
  useEffect(() => {
    if (isWebMode) {
      const folderRaw = selectedFolder || '';
      const folder = sharedBrowseModeRef.current ? clampToSharedScope(folderRaw) : folderRaw;
      if (lastFetchedPathRef.current !== folder) {
        fetchFiles(folder);
      }
    }
  }, [isWebMode, selectedFolder, fetchFiles, clampToSharedScope]);

  // Refresh file list when user logs in
  useEffect(() => {
    if (!isWebMode) return;
    const auth = getAuth(app);
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (user) {
        try {
          await auth.authStateReady();
          const folder = selectedFolder || '';
          const userId = user.uid;
          const lastUserId = sessionStorage.getItem('tl_last_user_id');
          
          // Only fetch if different user logged in
          if (lastUserId !== userId) {
            sessionStorage.setItem('tl_last_user_id', userId);
            await fetchFiles(folder);
          }
        } catch (e) {
          console.error('Error fetching files after login:', e);
        }
      } else {
        // Clear user ID on logout
        sessionStorage.removeItem('tl_last_user_id');
        
        // Refresh file list for guest state
        const folder = selectedFolder || '';
        await fetchFiles(folder);
      }
    });
    return () => unsubscribe();
  }, [isWebMode, fetchFiles, selectedFolder]);

  const handleFolderSelect = async () => {
    if (isWebMode) {
      dispatch(setError('Folder selection is only available in local mode.'));
      dispatch(setWindowError({ windowId: activeWindow, error: 'Folder selection is only available in local mode.' }));
      return;
    }
    if (!electron) return;
    try {
      const result = await electron.invoke('open-folder-dialog');
      if (result && result.filePaths && result.filePaths[0]) {
        suppressAutoNavigateRef.current = true;
        dispatch(setSelectedFolder(result.filePaths[0]));
        dispatch(updateWindowFolder({ windowId: activeWindow, folder: result.filePaths[0] }));
        await fetchFiles(result.filePaths[0]);
        dispatch(setIsMinimized(false));
      }
    } catch (err) {
      dispatch(setError('Failed to open folder.'));
      dispatch(setWindowError({ windowId: activeWindow, error: 'Failed to open folder.' }));
    }
  };

  const handleWsiUpload = useCallback(async (absolutePath: string) => {
    if (isFileLoading) return; // Prevent multiple simultaneous uploads
    
    setIsFileLoading(true);
    setLoadingFile(absolutePath);
    
    try {
      console.log('FileBrowserSidebar: Starting WSI upload for:', absolutePath);
      
      // Step 1: Upload file path (same as LocalFileManager)
      const uploadData = await uploadFilePath(absolutePath);
      console.log('FileBrowserSidebar: uploadData:', uploadData);
      
      // Step 2: Create instance (same as LocalFileManager)
      const instanceData = await createInstance(uploadData.filePath || uploadData.file_path || uploadData.filename);
      console.log('FileBrowserSidebar: instanceData:', instanceData);
      
      // Step 3: Load file data (same as LocalFileManager)
      const loadData = await loadFileData(uploadData.filename);
      console.log('FileBrowserSidebar: loadData:', loadData);
      
      // Step 4: Set all the necessary data in Redux (same as LocalFileManager)
      dispatch(updateInstanceWSIInfo(loadData));
      dispatch(setCurrentPath({ path: absolutePath }) as PayloadAction<{ path: string | null }>);
      dispatch(setSlideInfo({
        dimensions: uploadData.dimensions,
        fileSize: uploadData.file_size,
        mpp: uploadData.mpp,
        magnification: uploadData.magnification,
      }));
      
      // Step 5: Replace current instance with new WSI data (same as LocalFileManager)
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
      
      console.log('FileBrowserSidebar: Instance created successfully with ID:', instanceData.instanceId);
      dispatch(updateWindowImage({ windowId: activeWindow, imagePath: absolutePath }));
      dispatch(setImageLoaded(true));
      
      // Update the AnnotatorContext instanceId to trigger OpenSeadragonContainer reload
      setInstanceId(instanceData.instanceId);

      // Refresh file list in web mode after successful load
      if (isWebMode) {
        await fetchFiles(selectedFolder || '');
      }
    } catch (err) {
      console.error("Error processing WSI file:", err);
      const errorMessage = err instanceof Error ? err.message : "Failed to load WSI file.";
      dispatch(setError(`Failed to load WSI file: ${errorMessage}`));
      dispatch(setWindowError({ windowId: activeWindow, error: `Failed to load WSI file: ${errorMessage}` }));
    } finally {
      setIsFileLoading(false);
      setLoadingFile(null);
    }
  }, [isFileLoading, dispatch, activeWindow, setInstanceId, isWebMode, fetchFiles, selectedFolder]);

  const handleItemClick = useCallback((item: FileItem) => {
    // Clear any existing timeout
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
    }
    
    // Debounce the click to prevent rapid successive clicks
    clickTimeoutRef.current = setTimeout(() => {
      if (item.is_dir) {
        suppressAutoNavigateRef.current = true;
        const nextPath = sharedBrowseModeRef.current ? clampToSharedScope(item.path) : item.path;
        fetchFiles(nextPath);
        dispatch(setSelectedFolder(nextPath));
        dispatch(updateWindowFolder({ windowId: activeWindow, folder: nextPath }));
      } else if (isWSI(item.name)) {
        handleWsiUpload(item.path);
      }
    }, 300); // 300ms debounce
  }, [fetchFiles, dispatch, activeWindow, handleWsiUpload, clampToSharedScope]);

  // Auto-navigate to the folder containing the opened image
  useEffect(() => {
    // Restore shared context once when auto-navigating the first time
    if (!sharedContextRestoredRef.current) {
      const restored = restoreSharedContextFromSession();
      if (restored) {
        sharedContextRestoredRef.current = true;
      }
    }

    if (currentPath) {
      if (suppressAutoNavigateRef.current) {
        // Skip once after manual navigation (folder select or dir click)
        suppressAutoNavigateRef.current = false;
        return;
      }
      if (!isWebMode && !electron) return; // wait for Electron in local mode

      const separator = isWebMode ? '/' : (currentPath.includes('\\') ? '\\' : '/');
      const lastIndex = currentPath.lastIndexOf(separator);
      let parentDir = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : (isWebMode ? '' : currentPath);

      // Clamp parentDir within shared scope when in shared mode
      if (sharedBrowseModeRef.current && sharedScopeRef.current) {
        parentDir = clampToSharedScope(parentDir);
      }

      const shouldUpdate = isWebMode ? selectedFolder !== parentDir : (parentDir && parentDir !== selectedFolder);
      if (shouldUpdate) {
        dispatch(setSelectedFolder(parentDir));
        dispatch(updateWindowFolder({ windowId: activeWindow, folder: parentDir }));
        fetchFiles(parentDir);
        dispatch(setIsMinimized(false));
      }
    }
  }, [currentPath, dispatch, activeWindow, fetchFiles, selectedFolder, isWebMode, electron, restoreSharedContextFromSession, clampToSharedScope]);

  const filteredFiles = fileList.filter(file =>
    file.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const imageFiles = filteredFiles.filter(file => !file.is_dir && isWSI(file.name));

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
  // Detect macOS + Electron to adjust vertical offset for titlebar aesthetics
  useEffect(() => {
    try {
      const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent || '');
      const isElectron = typeof window !== 'undefined' && !!(window as any).electron;
      setIsMacElectron(Boolean(isMac && isElectron));
    } catch {}
  }, []);

  // Minimized state
  if (isMinimized) {
    return (
      <div className="w-12 bg-gray-800 border-r border-gray-700 flex flex-col items-center py-4 transition-all duration-300 ease-in-out electron-drag">
        {isMacElectron && <div className="w-full h-2 bg-gray-800" />}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatch(setIsMinimized(false))}
          className="w-8 h-8 p-0 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors duration-200 electron-no-drag"
          title="Expand file browser"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <FolderOpen className="h-5 w-5 text-gray-400 mt-2" />
      </div>
    );
  }

  return (
    <div className="w-80 bg-gray-800 border-r border-gray-700 flex flex-col h-full transition-all duration-300 ease-in-out">
      {isMacElectron && <div className="w-full h-2 bg-gray-900" />}
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-700 p-3 electron-drag">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 flex-1 min-w-0 electron-no-drag">
            <FolderOpen className="h-4 w-4 text-gray-300 flex-shrink-0" />
            <span className="text-sm font-medium text-gray-100 truncate">
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
            className="h-6 px-2 text-gray-400 hover:text-white hover:bg-gray-700 flex-shrink-0 flex items-center gap-1 transition-all duration-200 electron-no-drag"
          >
            <ChevronLeft className="h-3 w-3" />
            <span className="text-xs">Minimize</span>
          </Button>
        </div>
        
        {/* Search Bar */}
        <div className="relative electron-no-drag">
          <div className="flex items-center gap-2 w-full">
            <div className="flex items-center flex-1 h-8 rounded-sm bg-gray-700">
              <div className="flex items-center justify-center w-8 h-8">
                <Search className="h-3 w-3 text-gray-400" />
              </div>
              <input
                type="text"
                placeholder="Search files..."
                value={searchTerm}
                onChange={(e) => dispatch(setSearchTerm(e.target.value))}
                className="flex-1 h-full bg-transparent border-0 outline-none text-xs px-1 text-gray-100 placeholder-gray-400"
              />
              {searchTerm && (
                <button
                  onClick={() => dispatch(setSearchTerm(''))}
                  className="flex items-center justify-center w-8 h-8 text-gray-400 hover:text-gray-200"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <Button
              variant="outline" 
              size="sm"
              onClick={() => dispatch(setViewMode(viewMode === 'full' ? 'nameOnly' : 'full'))}
              className="h-8 px-3 text-xs flex-shrink-0 rounded-sm border-0 bg-gray-700 text-gray-200 hover:bg-gray-600 hover:text-white electron-no-drag"
              title={viewMode === 'full' ? 'Switch to name-only view' : 'Switch to full view'}
            >
              {viewMode === 'full' ? <List className="h-4 w-4" /> : <Grid className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* Select Folder (local mode only) */}
        <div className="flex gap-2 mt-2">
          {!isWebMode && (
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleFolderSelect}
              className="flex-1 h-7 text-xs rounded-sm border-0 text-white hover:opacity-90 electron-no-drag"
              style={{ backgroundColor: '#8879B0' }}
            >
              <Folder className="h-3 w-3 mr-1" /> 
              Select Folder
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col min-h-0">
        <ScrollArea className="flex-1">
          {isLoading && (
            <div className="p-4 text-center">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-400 border-t-transparent mx-auto"></div>
              <div className="text-xs text-gray-300 mt-2">Loading...</div>
            </div>
          )}
          
          {error && (
            <div className="px-3 py-2">
              <div className="mx-auto max-w-[260px] p-2 rounded border bg-blue-50 border-blue-200 text-blue-700 text-[11px] flex items-center justify-center gap-1">
                <Info className="w-3 h-3" />
                <span>{error}</span>
              </div>
            </div>
          )}
          
          {/* Empty hints */}
          {!isLoading && !error && !isWebMode && !selectedFolder && (
            <div className="p-4 text-center text-gray-300 text-xs">
              Select a folder to browse files
            </div>
          )}
          {!isLoading && !error && isWebMode && selectedFolder === '' && filteredFiles.length === 0 && (
            <div className="p-4 text-center text-gray-300 text-xs">No files found</div>
          )}
          {!isLoading && !error && selectedFolder && filteredFiles.length === 0 && (
            <div className="p-4 text-center text-gray-300 text-xs">No files found</div>
          )}
          {!isLoading && !error && selectedFolder && imageFiles.length === 0 && (
            <div className="p-4 text-center text-gray-300 text-xs">No image files found in this folder</div>
          )}
          
          {/* File List */}
          {!isLoading && !error && ((isWebMode && selectedFolder === '') || selectedFolder) && imageFiles.length > 0 && (
            <div className="w-full transition-all duration-300 ease-in-out">
              {viewMode === 'full' ? (
                <>
                  {/* Header - Full View */}
                  <div 
                    className="grid gap-1 p-2 bg-gray-700 border-b border-gray-600 text-xs font-medium text-gray-200"
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
                      const statusLabel = taskState
                        ? (isError && taskState.error ? taskState.error : TASK_STATUS_LABELS[taskState.status])
                        : '';
                      const progressValue = taskState ? Math.max(0, Math.min(100, Math.round(taskState.progress))) : 0;

                      return (
                        <div 
                          key={`${file.path}-${index}`} 
                          className={`relative grid gap-1 p-2 border-b border-gray-600 items-center transition-colors duration-200 ${
                            isFileLoading && loadingFile === file.path 
                              ? 'bg-gray-600 cursor-wait' 
                              : (isActiveFile(file.path)
                                  ? 'bg-blue-500/10 cursor-pointer'
                                  : 'hover:bg-gray-700 cursor-pointer')
                          }`}
                          style={{ gridTemplateColumns: '1fr 1fr 1.2fr', minHeight: '60px' }}
                          onClick={() => handleItemClick(file)}
                          aria-selected={isActiveFile(file.path)}
                        >
                          {isActiveFile(file.path) && (
                            <span className="absolute left-0 top-0 h-full w-0.5 bg-blue-400" />
                          )}
                          {/* Label Column */}
                          <div className="flex justify-center">
                            <div className="w-12 h-9 border border-gray-500 rounded-sm bg-gray-600 shadow-sm">
                              <ImagePreviewCell 
                                fileName={file.name} 
                                fullPath={file.path}
                                imageType="label"
                              />
                            </div>
                          </div>

                          {/* Thumbnail Column */}
                          <div className="flex justify-center">
                            <div className="w-12 h-9 border border-gray-500 rounded-sm bg-gray-600 shadow-sm">
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
                                <div className="text-xs font-medium text-white hover:text-gray-200 hover:underline truncate leading-tight">
                                  {truncateFileName(file.name, 18)}
                                </div>
                                <div className="text-xs text-gray-300 truncate">
                                  {new Date(file.mtime * 1000).toLocaleDateString()}
                                </div>
                              </div>
                              {isFileLoading && loadingFile === file.path && (
                                <div className="animate-spin rounded-full h-3 w-3 border border-blue-400 border-t-transparent flex-shrink-0"></div>
                              )}
                              {isError && (
                                <X className="h-4 w-4 text-red-400 flex-shrink-0" />
                              )}
                              {isActiveFile(file.path) && (
                                <span className="h-2 w-2 rounded-full bg-blue-400 flex-shrink-0"></span>
                              )}
                            </div>
                            {showProgress && (
                              <div className="mt-2">
                                <Progress value={progressValue} className="h-1.5 bg-gray-700" />
                                <div className={`flex items-center justify-between text-[10px] mt-1 ${isError ? 'text-red-400' : 'text-gray-400'}`}>
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
                  <div className="p-2 bg-gray-700 border-b border-gray-600 text-xs font-medium text-gray-200">
                    <div className="text-left">Files</div>
                  </div>

                  {/* File Rows - Name Only View */}
                  <div>
                    {imageFiles.map((file, index) => {
                      const taskState = fileTaskStates[file.path];
                      const showProgress = taskState && taskState.status !== 'idle';
                      const isError = taskState?.status === 'error';
                      const statusLabel = taskState
                        ? (isError && taskState.error ? taskState.error : TASK_STATUS_LABELS[taskState.status])
                        : '';
                      const progressValue = taskState ? Math.max(0, Math.min(100, Math.round(taskState.progress))) : 0;

                      return (
                        <div 
                          key={`${file.path}-${index}`} 
                          className={`relative p-3 border-b border-gray-600 transition-colors duration-200 ${
                            isFileLoading && loadingFile === file.path 
                              ? 'bg-gray-600 cursor-wait' 
                              : (isActiveFile(file.path)
                                  ? 'bg-blue-500/10 cursor-pointer'
                                  : 'hover:bg-gray-700 cursor-pointer')
                          }`}
                          aria-selected={isActiveFile(file.path)}
                          onClick={() => handleItemClick(file)}
                        >
                          {isActiveFile(file.path) && (
                            <span className="absolute left-0 top-0 h-full w-0.5 bg-blue-400" />
                          )}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="flex-1">
                                <div className="text-xs font-medium text-white hover:text-gray-200 hover:underline truncate leading-tight">
                                  {truncateFileName(file.name, 35)}
                                </div>
                                <div className="text-xs text-gray-300 truncate mt-1">
                                  {new Date(file.mtime * 1000).toLocaleDateString()}
                                </div>
                              </div>
                              {isFileLoading && loadingFile === file.path && (
                                <div className="animate-spin rounded-full h-3 w-3 border border-blue-400 border-t-transparent flex-shrink-0"></div>
                              )}
                              {isError && (
                                <X className="h-4 w-4 text-red-400 flex-shrink-0" />
                              )}
                              {isActiveFile(file.path) && (
                                <span className="h-2 w-2 rounded-full bg-blue-400 flex-shrink-0"></span>
                              )}
                            </div>
                            {showProgress && (
                              <div className="mt-2">
                                <Progress value={progressValue} className="h-1.5 bg-gray-700" />
                                <div className={`flex items-center justify-between text-[10px] mt-1 ${isError ? 'text-red-400' : 'text-gray-400'}`}>
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

        {/* Associated Models Section */}
        <AssociatedModelsSection 
          selectedFolder={selectedFolder}
          isWebMode={isWebMode}
          electron={electron}
          imageFiles={imageFiles}
          fileTaskStates={fileTaskStates}
          setFileTaskStates={setFileTaskStates}
        />
      </div>
    </div>
  );
};

export default FileBrowserSidebar;
