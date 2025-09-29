"use client";
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
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
import { ChevronRight, Folder, File as FileIcon, X, MoreVertical, 
         Edit, FolderPlus, FilePlus, ChevronDown, ArrowDown,
         Search, ArrowUp, Grid, List, Image as ImageIcon, UploadCloud, RefreshCw } from 'lucide-react';

import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '@/store';
import { addWSIInstance, updateInstanceWSIInfo, replaceCurrentInstance } from '@/store/slices/wsiSlice';
import { setSlideInfo, setCurrentPath, setTotalChannels } from '@/store/slices/svsPathSlice';
import { updateWindowImage } from '@/store/slices/multiWindowSlice';
import { PayloadAction } from '@reduxjs/toolkit';
import { setImageLoaded } from '@/store/slices/sidebarSlice'
import { useRouter } from 'next/router';
import { uploadFolderPath, uploadFilePath, loadFileData, getPreviewAsync, createInstance } from '@/utils/file.service';
import { uploadFiles as apiUploadFiles, listFiles as apiListFiles } from '@/utils/fileManager.service';
import { UploadDialog } from './UploadDialog';
import { message } from 'antd';
import { app } from '@/config/firebaseConfig';
import { getAuth } from 'firebase/auth';
import { shortHashFromString } from '@/utils/string.utils';


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

const ImagePreviewCell: React.FC<{ 
  fileName: string; 
  fullPath: string; 
  imageType: 'thumbnail' | 'label' | 'macro';
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
}

interface FileTreeNode extends FileItem {
    children?: FileTreeNode[];
    isExpanded?: boolean;
    isLoading?: boolean;
    depth: number;
    isParentLink?: boolean;
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

const LocalFileManager = () => {
  const dispatch = useDispatch();
  const router = useRouter();
  
  // Get active window for multi-window state updates
  const { activeWindow } = useSelector((state: RootState) => state.multiWindow);
  const [rootFolder, setRootFolder] = useState<string>('');
  const [currentDirectory, setCurrentDirectory] = useState<string>('');
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sortConfig, setSortConfig] = useState<{ key: keyof FileTreeNode | 'type'; direction: 'asc' | 'desc' }>({ key: 'mtime', direction: 'desc' });
  const [showNonImageFiles, setShowNonImageFiles] = useState(false);
  const [viewMode, setViewMode] = useState<'tree' | 'table'>('tree');
  const [dialog, setDialog] = useState<
    { type: 'create-folder' | 'rename'; path?: string; } |
    null
  >(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [electron, setElectron] = useState<any>(null);
  const [isUploadingToCloud, setIsUploadingToCloud] = useState(false);
  const webCurrentDirectory = useSelector((state: RootState) => state.webFileManager.currentDirectory);
  const [uploadStatus, setUploadStatus] = useState<Map<string, { 
    progress: number; 
    status: 'Uploading' | 'Paused' | 'Completed' | 'Error' | 'Cancelled'; 
    error?: string;
    uploadTime?: number;
    estimatedTimeRemaining?: number;
    retryCount?: number;
    startTime?: number;
    fileSize?: number;
    fileName?: string;
  }>>(new Map());
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [overallUploading, setOverallUploading] = useState(false);
  const [overallProgress, setOverallProgress] = useState(0);
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false);
  const [overwriteFileName, setOverwriteFileName] = useState<string | null>(null);
  const overwriteResolverRef = useRef<((ok: boolean) => void) | null>(null);

  const VIRTUAL_ROOT = '__root__';
  const isSamplesPath = (p: string | null | undefined) => {
    if (!p) return false;
    return p === 'samples' || p.startsWith('samples/');
  };
  
  const isPersonalRootPath = (p: string | null | undefined) => {
    if (!p) return false;
    // Use webCurrentDirectory as the source of truth
    const personal = webCurrentDirectory || '';
    return personal !== '' && personal !== VIRTUAL_ROOT && (p === personal || p.startsWith(personal + '/'));
  };

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electron) {
      setElectron(window.electron);
    }
  }, []);

  // Auto reload last rootFolder
  useEffect(() => {
    if (electron && typeof window !== 'undefined') {
      const lastRoot = window.localStorage.getItem('tissuelab_local_root_folder');
      if (lastRoot) {
        setRootFolder(lastRoot);
      }
    }
  }, [electron]);

  const fetchFiles = useCallback(async (path: string) => {
    if (!electron) return;
    setIsLoading(true);
    setError(null);
    try {
      const result: FileItem[] = await electron.listLocalFiles(path);
      const sortedFiles = result.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return b.mtime - a.mtime; // Sort by last modified time in descending order
      });
      let treeNodes: FileTreeNode[] = sortedFiles.map(file => ({
        ...file,
        depth: 0,
        children: file.is_dir ? [] : undefined,
        source: 'local' as const,
      }));

      // Apply WSI-H5 grouping
      treeNodes = groupWSIAndH5Files(treeNodes);
      
      if (rootFolder && path && path !== rootFolder) {
        // Handle both Windows and Unix path separators for parent path calculation
        const normalizedPath = path.replace(/\\/g, '/');
        const lastSlashIndex = normalizedPath.lastIndexOf('/');
        
        if (lastSlashIndex !== -1) {
          const parentPath = path.substring(0, lastSlashIndex);
          // Ensure we don't go above the root folder
          if (parentPath.length >= rootFolder.length) {
            const upNode: FileTreeNode = {
              name: '..',
              path: parentPath,
              is_dir: true,
              size: 0,
              mtime: 0,
              depth: 0,
              source: 'local' as const,
              isParentLink: true,
            };
            treeNodes.unshift(upNode);
          }
        }
      }
      setFileTree(treeNodes);
      setCurrentDirectory(path);

    } catch (err: any) {
      setError(err.message);
      setFileTree([]);
      // If loading fails during initialization, clear localStorage
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('tissuelab_local_root_folder');
      }
    } finally {
      setIsLoading(false);
    }
  }, [electron, rootFolder]);

  // Upload completed automatically close dialog and reset
  useEffect(() => {
    if (!isUploadDialogOpen) return;
    if (overallUploading) return;
    if (overallProgress !== 100) return;

    // All files are completed or cancelled and no error/pause
    const statuses = Array.from(uploadStatus.values());
    const hasActive = statuses.some(s => s.status === 'Uploading' || s.status === 'Paused');
    const hasError = statuses.some(s => s.status === 'Error');
    if (!hasActive && !hasError) {
      const timer = setTimeout(() => {
        setIsUploadDialogOpen(false);
        setOverallUploading(false);
        setOverallProgress(0);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [isUploadDialogOpen, overallUploading, overallProgress, uploadStatus]);

  useEffect(() => {
    if (dialog?.type === 'create-folder' || dialog?.type === 'rename') {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [dialog]);

  const handleOpenRootFolder = async () => {
    if (!electron) return;
    try {
      const result = await electron.invoke('open-folder-dialog');
      if (result && result.filePaths && result.filePaths[0]) {
        setRootFolder(result.filePaths[0]);
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('tissuelab_local_root_folder', result.filePaths[0]);
        }
      }
    } catch (err) {
      setError('Failed to open folder.');
    }
  };
  
  useEffect(() => {
    if (rootFolder) {
        fetchFiles(rootFolder);
    }
  }, [rootFolder, fetchFiles]);

  const handleWsiUpload = async (absolutePath: string) => {
    try {
      console.log('LocalFileManager: Starting WSI upload for:', absolutePath);
      
      // Step 1: Upload file path
      const uploadData = await uploadFilePath(absolutePath);
      console.log('LocalFileManager: uploadData:', uploadData);
      
      // Step 2: Create instance (this is the missing step!)
      const instanceData = await createInstance(uploadData.filePath || uploadData.file_path || uploadData.filename);
      console.log('LocalFileManager: instanceData:', instanceData);
      
      // Step 3: Load file data
      const loadData = await loadFileData(uploadData.filename);
      console.log('LocalFileManager: loadData:', loadData);
      
      // Step 4: Set all the necessary data in Redux
      dispatch(setCurrentPath({ path: absolutePath }) as PayloadAction<{ path: string | null }>);
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
          fileName: absolutePath.split(/[\\/]/).pop() || '',
          filePath: absolutePath,
          source: 'local'
        }
      }));
      
      console.log('LocalFileManager: Instance created successfully with ID:', instanceData.instanceId);
      
      // Update multi-window state to ensure proper highlighting
      dispatch(updateWindowImage({ windowId: activeWindow, imagePath: absolutePath }));
      
      dispatch(setImageLoaded(true));
      router.push('/imageViewer');
    } catch (err) {
      console.error("Error processing WSI file:", err);
      setError("Failed to load WSI file.");
    }
  };

  const getAllImageFiles = useCallback(() => {
    const imageFiles: Array<{
      name: string;
      path: string;
      fullPath: string;
      size: number;
      mtime: number;
    }> = [];
    
    const extractImages = (nodes: FileTreeNode[]) => {
      nodes.forEach(node => {
        if (!node.is_dir && isWSI(node.name)) {
          imageFiles.push({
            name: node.name,
            path: node.path,
            fullPath: node.path,
            size: node.size,
            mtime: node.mtime
          });
        }
        // Extract images from children (only WSI files)
        if (node.children && node.children.length > 0) {
          extractImages(node.children);
        }
      });
    };
    
    extractImages(fileTree);
    return imageFiles;
  }, [fileTree]);

  // Image table view
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
                key={`${file.path}-${index}`} 
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
                    onClick={() => handleWsiUpload(file.path)}
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
                    <ImagePreviewCell 
                      fileName={file.name} 
                      fullPath={file.fullPath}
                      imageType="thumbnail"
                    />
                  </div>
                </div>

                {/* Label */}
                <div className="flex justify-center">
                  <div className="w-full max-w-[100px] aspect-[4/3] border rounded bg-white shadow-sm">
                    <ImagePreviewCell 
                      fileName={file.name} 
                      fullPath={file.fullPath}
                      imageType="label"
                    />
                  </div>
                </div>

                {/* Macro */}
                <div className="flex justify-center">
                  <div className="w-full max-w-[160px] aspect-[4/3] border rounded bg-white shadow-sm">
                    <ImagePreviewCell 
                      fileName={file.name} 
                      fullPath={file.fullPath}
                      imageType="macro"
                    />
                  </div>
                </div>

                {/* Actions */}
                <div className="flex justify-center">
                  <Button
                    size="sm"
                    className="bg-blue-500 hover:bg-blue-600 text-white text-xs px-3 py-1"
                    onClick={() => handleWsiUpload(file.path)}
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

  // flattenTree should be defined before use
  const flattenTree = (nodes: FileTreeNode[]): FileTreeNode[] => {
    let flat: FileTreeNode[] = [];
    nodes.forEach(node => {
      if (!showNonImageFiles && !node.is_dir && !isWSI(node.name) && !isH5(node.name)) {
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
  };

  // handleItemClick for file loading logic
  const handleItemClick = (item: FileTreeNode, e: React.MouseEvent) => {
    if (item.is_dir) {
      fetchFiles(item.path);
    } else if (isWSI(item.name)) {
      handleWsiUpload(item.path);
    } else {
      console.log('Selected absolute path (non-image):', item.path);
    }
  };

  const handleGoUp = () => {
    if (!currentDirectory || currentDirectory === rootFolder) return;
    
    // Handle both Windows and Unix path separators
    const normalizedPath = currentDirectory.replace(/\\/g, '/');
    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    
    if (lastSlashIndex === -1) {
      // No slash found, go to root
      fetchFiles(rootFolder);
    } else {
      const parentPath = currentDirectory.substring(0, lastSlashIndex);
      // Ensure we don't go above the root folder
      if (parentPath.length >= rootFolder.length) {
        fetchFiles(parentPath);
      } else {
        fetchFiles(rootFolder);
      }
    }
  };

  // --- CRUD ---
  const handleCreateFolder = async (folderName: string) => {
    if (!folderName) return;
    const newPath = currentDirectory ? electron.pathJoin(currentDirectory, folderName) : folderName;
    try {
      await electron.createLocalFolder(newPath);
      await fetchFiles(currentDirectory);
      message.success('Folder created successfully');
    } catch (err: any) {
      message.error(err.message || 'Failed to create folder');
      setError(err.message || 'Failed to create folder');
    } finally { setDialog(null); }
  };

  const handleRename = async (newName: string) => {
    if (!newName || !dialog || dialog.type !== 'rename' || !dialog.path) return;
    const oldPath = dialog.path;
    
    // Handle both Windows and Unix path separators
    const normalizedPath = oldPath.replace(/\\/g, '/');
    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    const dir = lastSlashIndex !== -1 ? oldPath.substring(0, lastSlashIndex) : '';
    const newPath = dir ? electron.pathJoin(dir, newName) : newName;
    
    try {
      await electron.renameLocalFile(oldPath, newPath);
      await fetchFiles(currentDirectory);
      message.success('Item renamed successfully');
    } catch (err: any) {
      message.error(err.message || 'Failed to rename item');
      setError(err.message || 'Failed to rename item');
    } finally { setDialog(null); }
  };

  const sortData = (data: FileTreeNode[], config: typeof sortConfig) => {
    return [...data].sort((a, b) => {
      // Always keep ".." parent link on top regardless of sort
      const aIsParent = !!(a as any).isParentLink;
      const bIsParent = !!(b as any).isParentLink;
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

  const renderBreadcrumbs = () => (
    <div className="flex items-center text-sm text-gray-500">
      <span 
        className="cursor-pointer hover:underline p-1 rounded flex items-center gap-2"
        onClick={() => fetchFiles(rootFolder)}
        >
        <Folder className="h-4 w-4" />
        {rootFolder ? rootFolder : 'Local Root'}
      </span>
      {currentDirectory && currentDirectory !== rootFolder && <ChevronRight className="h-4 w-4 mx-1" />}
      {currentDirectory && currentDirectory !== rootFolder && (() => {
        // Normalize paths for consistent handling
        const normalizedCurrent = currentDirectory.replace(/\\/g, '/');
        const normalizedRoot = rootFolder.replace(/\\/g, '/');
        const relativePath = normalizedCurrent.replace(normalizedRoot, '');
        
        if (relativePath) {
          const parts = relativePath.split('/').filter(part => part);
          return parts.map((part, index, arr) => {
            const pathUntilThisPart = normalizedRoot + '/' + arr.slice(0, index + 1).join('/');
            return (
              <React.Fragment key={index}>
                <span
                  className="cursor-pointer hover:underline p-1 rounded"
                  onClick={() => {
                    fetchFiles(pathUntilThisPart);
                  }}
                >
                  {part}
                </span>
                {index < arr.length - 1 && <ChevronRight className="h-4 w-4 mx-1" />}
              </React.Fragment>
            );
          });
        }
        return null;
      })()}
      </div>
  );

  const renderToolbar = () => {
    return (
      <div className="flex items-center justify-between p-2 border-b">
          <div className="flex items-center gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleGoUp} 
                disabled={!currentDirectory || currentDirectory === rootFolder}
              >
                  <ArrowUp className="h-4 w-4 mr-2" /> Up
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDialog({ type: 'create-folder' })}>
                  <FolderPlus className="h-4 w-4 mr-2" /> New Folder
              </Button>
              <Button variant="outline" size="sm" onClick={handleOpenRootFolder}>
                  <Folder className="h-4 w-4 mr-2" /> Open Folder
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => fetchFiles(currentDirectory || rootFolder)}
                disabled={!rootFolder || isLoading}
              >
                  <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
          </div>
        <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <List className={`h-4 w-4 ${viewMode === 'tree' ? 'text-blue-500' : 'text-gray-400'}`} />
              <Switch 
                checked={viewMode === 'table'} 
                onCheckedChange={(checked) => setViewMode(checked ? 'table' : 'tree')} 
              />
              <Grid className={`h-4 w-4 ${viewMode === 'table' ? 'text-blue-500' : 'text-gray-400'}`} />
              <span className="text-sm text-gray-600 dark:text-gray-400">Table View</span>
            </div>
            <div className="flex items-center gap-2">
                <Switch 
                    checked={showNonImageFiles}
                    onCheckedChange={setShowNonImageFiles}
                />
                <span className="text-sm text-gray-600 dark:text-gray-400">Show non-image files</span>
            </div>
        </div>
      </div>
    );
  }

  const renderItemContextMenu = (item: FileTreeNode) => (
    <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreVertical className="h-4 w-4" />
            </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setDialog({ type: 'rename', path: item.path })}>
                <Edit className="h-4 w-4 mr-2" /> Rename
            </DropdownMenuItem>
            {/* Temporarily commented out upload to cloud functionality */}
            {/*
            <DropdownMenuItem 
                onSelect={() => handleUploadToCloud(item)}
                disabled={isUploadingToCloud}
            >
                <UploadCloud className="h-4 w-4 mr-2" /> 
                {isUploadingToCloud ? 'Uploading...' : 'Upload to Cloud'}
            </DropdownMenuItem>
            */}
        </DropdownMenuContent>
    </DropdownMenu>
  );

  const formatFileType = (fileName: string) => {
    const extension = fileName.split('.').pop();
    if (extension) {
        if (isWSI(fileName)) return 'WSI';
        if (isH5(fileName)) return 'H5';
        return extension.toUpperCase();
    }
    return 'File';
  };

  const renderFileTreeRows = (nodes: FileTreeNode[]): React.ReactNode[] => {
    let rows: React.ReactNode[] = [];
    const sortedNodes = sortData(nodes, sortConfig);
    sortedNodes.forEach(item => {
        if (item.isParentLink) {
            rows.push(
                <TableRow
                    key="parent-link"
                    onClick={handleGoUp}
                    onDoubleClick={handleGoUp}
                    className="cursor-pointer transition-colors align-top hover:bg-gray-100 dark:hover:bg-gray-700 mx-2 rounded-lg bg-white dark:bg-gray-900"
                >
                    <TableCell className="px-3">
                         <div className="flex items-start gap-2">
                            <ChevronRight className="h-5 w-5 mt-0.5 text-gray-500 flex-shrink-0" />
                            <span className="break-all">{item.name}</span>
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
        if (!showNonImageFiles && !item.is_dir && !isWSI(item.name) && !isH5(item.name)) {
            if (item.children && item.children.length > 0) {
                rows = rows.concat(renderFileTreeRows(item.children));
            }
            return;
        }
        rows.push(
            <TableRow 
                key={item.path} 
                onClick={(e) => handleItemClick(item, e)}
                className={`cursor-pointer transition-colors align-top rounded-lg mx-2 hover:!bg-gray-100 dark:hover:!bg-gray-700`}
            >
                <TableCell className="px-3">
                    <div style={{ paddingLeft: `${item.depth * 24}px` }} className="flex items-start gap-3">
                        {item.is_dir 
                            ? <Folder className="h-5 w-5 text-blue-500 flex-shrink-0" /> 
                            : isWSI(item.name) 
                                ? <ImageIcon className="h-5 w-5 text-rose-500 flex-shrink-0" /> 
                                : isH5(item.name)
                                    ? <FileIcon className="h-4 w-4 text-orange-500 flex-shrink-0" />
                                    : <FileIcon className="h-5 w-5 text-gray-500 flex-shrink-0" />}
                        <span className="break-all">{item.name}</span>
                    </div>
                </TableCell>
                <TableCell className="text-right px-3">{item.is_dir ? 'Folder' : formatFileType(item.name)}</TableCell>
                <TableCell className="text-right px-3">{item.is_dir ? '—' : formatBytes(item.size)}</TableCell>
                <TableCell className="text-right px-3">{new Date(item.mtime * 1000).toLocaleString()}</TableCell>
                <TableCell className="text-right px-3" onClick={(e) => e.stopPropagation()}>
                    {renderItemContextMenu(item)}
                </TableCell>
            </TableRow>
        );
        // Always show children for WSI files (H5 files grouped under them)
        if (item.children && item.children.length > 0) {
            rows = rows.concat(renderFileTreeRows(item.children));
        }
    });
    return rows;
  };

  const renderFileTable = () => {
    const flatVisibleFiles = flattenTree(filesToRender);
    return (
      <Table>
        <TableHeader>
          <TableRow className="rounded-lg mx-2 bg-gray-100 dark:bg-gray-800">
            <TableHead className="px-3">
                <div className="flex items-center gap-3">
                    <span className="cursor-pointer" onClick={() => setSortConfig({ key: 'name', direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })}>
                        Name {sortConfig.key === 'name' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-4 w-4" /> : <ArrowDown className="inline h-4 w-4" />)}
                    </span>
                </div>
            </TableHead>
            <TableHead className="text-right cursor-pointer px-3" onClick={() => setSortConfig({ key: 'type', direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })}>
                Type {sortConfig.key === 'type' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-4 w-4" /> : <ArrowDown className="inline h-4 w-4" />)}
            </TableHead>
            <TableHead className="text-right cursor-pointer px-3" onClick={() => setSortConfig({ key: 'size', direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })}>
                Size {sortConfig.key === 'size' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-4 w-4" /> : <ArrowDown className="inline h-4 w-4" />)}
            </TableHead>
            <TableHead className="text-right cursor-pointer px-3" onClick={() => setSortConfig({ key: 'mtime', direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })}>
                Last Modified {sortConfig.key === 'mtime' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-4 w-4" /> : <ArrowDown className="inline h-4 w-4" />)}
            </TableHead>
            <TableHead className="w-20 text-right px-3">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {renderFileTreeRows(filesToRender)}
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
  }

  return (
    <div className="h-full w-full flex flex-col">
      <Card className="flex-grow">
        <CardHeader className="pb-2">
          <CardTitle>Local File Manager</CardTitle>
          <div className="flex items-center justify-between">
            {renderBreadcrumbs()}
            {/* TODO: Search functionality - commented out for future use */}
            {/* <div className="relative w-96">
              <div className="flex items-center w-full h-9 border border-gray-300 rounded-md bg-white focus-within:border-gray-400 focus-within:ring-1 focus-within:ring-gray-400 transition-all">
                <div className="flex items-center justify-center w-9 h-9">
                  <Search className="h-4 w-4 text-gray-400" />
                </div>
                <input
                  type="text"
                  placeholder="(Not implemented) Search local files..."
                  disabled
                  className="flex-1 h-full bg-transparent border-0 outline-none focus:outline-none text-sm px-2"
                />
                <button
                  className="flex items-center justify-center w-9 h-9 text-gray-400 hover:text-gray-600 transition-colors"
                  disabled
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div> */}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {renderToolbar()}
          <ScrollArea className="h-[600px]">
            {isLoading && <div className="p-4 text-center">Loading...</div>}
            {error && <div className="p-4 text-center text-red-500">{error}</div>}
            {!isLoading && !error && !rootFolder && (
                <div className="p-4 text-center text-gray-500">
                    Click Open Folder to start browsing your local files.
                </div>
            )}
            {!isLoading && !error && rootFolder && filesToRender.length === 0 && (
                <div className="p-4 text-center text-gray-500">
                    This folder is empty.
                </div>
            )}
            {!isLoading && !error && rootFolder && filesToRender.length > 0 && (
              <div className="min-h-full">
                {viewMode === 'table' ? renderImageTable() : renderFileTable()}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
      {renderDialog()}
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
              {`Already exists file: ${overwriteFileName ? `${overwriteFileName}` : ''}`}
              <br />
              {'Do you want to overwrite?'}
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
                Cancel
              </Button>
            </DialogClose>
            <Button
              onClick={() => {
                if (overwriteResolverRef.current) {
                  overwriteResolverRef.current(true);
                  overwriteResolverRef.current = null;
                }
                setOverwriteDialogOpen(false);
              }}
            >
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UploadDialog 
        isOpen={isUploadDialogOpen}
        onClose={() => {
          setIsUploadDialogOpen(false);
          setOverallUploading(false);
          setOverallProgress(0);
        }}
        onUpload={() => { /* LocalFileManager is triggered by right-click menu, not using this entry */ }}
        isUploading={overallUploading}
        uploadProgress={overallProgress}
        uploadStatus={uploadStatus}
        hideFileSelection
        onCancelAllUploads={() => {
          // Mark all ongoing tasks as cancelled (currently implemented does not support truly interrupting xhr)
          setUploadStatus(prev => {
            const next = new Map(prev);
            next.forEach((v, k) => {
              if (v.status === 'Uploading' || v.status === 'Paused') {
                next.set(k, { ...v, status: 'Cancelled' });
              }
            });
            return next;
          });
          setOverallUploading(false);
        }}
      />
    </div>
  );
};

export default LocalFileManager; 