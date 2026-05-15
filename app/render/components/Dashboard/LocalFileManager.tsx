"use client";
import { InlineSpinner } from '@/components/assets/PageLoading';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getErrorMessage } from '@/utils/common/apiResponse';
import {
  Archive,
  ArrowDown, ArrowUp,
  ChevronRight,
  Edit,
  File as FileIcon,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  MoreVertical,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileManagerPagination } from './FileManager/FileManagerPagination';

import { validateItemName } from '@/utils/string.utils';
import { ConversionJobStatus, enqueueH5ToZarr, getConversionJobStatus } from '@/services/data.service';
import { createInstance, getPreviewAsync, loadFileData, uploadFilePath } from '@/services/file.service';
import { RootState } from '@/store';
import { setCurrentImagePath, setSelectedFolder } from '@/store/slices/fileManagerSlice';
import { setImageLoaded } from '@/store/slices/layoutSlice';
import { setCurrentPath, setSlideInfo, setTotalChannels } from '@/store/slices/svsPathSlice';
import { setOutputPath } from '@/store/slices/chat/workflowSlice';
import { replaceCurrentInstance } from '@/store/slices/wsiSlice';
import { PayloadAction } from '@reduxjs/toolkit';
import { useRouter } from 'next/router';
import { useDispatch, useSelector } from 'react-redux';
import { toast } from 'sonner';
import { FileHeader } from './FileManager/FileHeader';
import { UploadDialog } from './UploadDialog';
import ImagePreviewCell from './FileManager/ImagePreviewCell';
import { 
  formatBytes, 
  formatFileType, 
  groupWSIAndZarrFiles, 
  sortFileTreeData,
  flattenFileTree,
  getAllImageFiles as getAllImageFilesUtil
} from '@/utils/dashboard/fileManagerUtils';
import { isWSI, isZarr, isZarrDir, isZarrZip, isH5Convertible, getWSIBaseName } from '@/utils/dashboard/fileTypeUtils';
import { FileItem, FileTreeNode, SortConfig } from '@/types/fileManagerTypes';



type ConversionJobState = {
  jobId: string;
  status: ConversionJobStatus;
  error?: string | null;
  result?: unknown;
  enqueuedAt?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  originalPath: string;
  serverSourcePath?: string;
  serverTargetPath?: string;
};

type ConversionJobMap = Record<string, ConversionJobState>;

function getOpenInSystemFileManagerMenuLabel(): string {
  if (typeof navigator === 'undefined') return 'Open in File Manager';
  const pf = navigator.platform || '';
  if (/Mac|iPhone|iPad|iPod/i.test(pf)) return 'Open in Finder';
  if (/Win/i.test(pf)) return 'Open in Explorer';
  return 'Open in File Manager';
}

const LocalFileManager = () => {
  const dispatch = useDispatch();
  const router = useRouter();

  const [conversionJobs, setConversionJobs] = useState<ConversionJobMap>({});
  const [rootFolder, setRootFolder] = useState<string>('');
  const [currentDirectory, setCurrentDirectory] = useState<string>('');
  const currentDirectoryRef = useRef<string>(''); // Ref to track current directory without causing re-renders
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [allFiles, setAllFiles] = useState<FileTreeNode[]>([]); // Store all files for pagination
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pagination state
  const [pagination, setPagination] = useState<{
    offset: number;
    limit: number | null;
    total: number;
    hasMore: boolean;
  }>({
    offset: 0,
    limit: 10, // Default page size
    total: 0,
    hasMore: false,
  });

  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: 'mtime', direction: 'desc' });
  const [showNonImageFiles, setShowNonImageFiles] = useState(false);
  const [viewMode, setViewMode] = useState<'tree' | 'table'>('tree');
  const [dialog, setDialog] = useState<
    { type: 'create-folder' | 'rename'; path?: string; } |
    null
  >(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [electron, setElectron] = useState<any>(null);
  const [isUploadingToCloud, setIsUploadingToCloud] = useState(false);
  const webCurrentDirectory = useSelector((state: RootState) => state.fileManager.currentDirectory);
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

  const getConversionErrorMessage = useCallback((err: any, fallback: string) => {
    return getErrorMessage(err, fallback);
  }, []);

  const VIRTUAL_ROOT = '__root__';

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

      // Apply WSI-Zarr grouping
      treeNodes = groupWSIAndZarrFiles(treeNodes);

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

      // Store all files and reset pagination when navigating to a new directory
      const previousDirectory = currentDirectoryRef.current;
      const shouldResetPagination = previousDirectory !== path;

      setAllFiles(treeNodes);
      setCurrentDirectory(path);
      currentDirectoryRef.current = path; // Update ref synchronously
      // Note: Pagination metadata (total, hasMore) will be updated in useEffect
      // after filtering is applied, so we don't need to set it here
      if (shouldResetPagination) {
        setPagination(prev => ({
          offset: 0,
          limit: prev.limit, // Keep the limit setting
          total: 0, // Will be updated by useEffect after filtering
          hasMore: false, // Will be updated by useEffect after filtering
        }));
      }

    } catch (err: any) {
      setError(err.message);
      setFileTree([]);
      setAllFiles([]);
      // If loading fails during initialization, clear localStorage
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('tissuelab_local_root_folder');
      }
    } finally {
      setIsLoading(false);
    }
  }, [electron, rootFolder, currentDirectory, pagination.limit]);

  // Filter files based on showNonImageFiles setting
  const filterVisibleFiles = useCallback((files: FileTreeNode[]): FileTreeNode[] => {
    return files.filter(file => {
      // If showNonImageFiles is true, show all files
      if (showNonImageFiles) {
        return true;
      }
      // Otherwise, only show directories, WSI files, and Zarr files
      return file.is_dir || isWSI(file.name) || isZarr(file.name);
    });
  }, [showNonImageFiles]);

  // Apply filtering and pagination to allFiles and update fileTree
  useEffect(() => {
    if (allFiles.length === 0) {
      setFileTree([]);
      setPagination(prev => ({
        ...prev,
        total: 0,
        hasMore: false,
      }));
      return;
    }

    const parentLinks = allFiles.filter(file => (file as any).isParentLink);
    const navigableFiles = allFiles.filter(file => !(file as any).isParentLink);

    // Only count real directory contents in pagination totals.
    const filteredFiles = filterVisibleFiles(navigableFiles);
    const filteredTotal = filteredFiles.length;

    if (pagination.limit === null) {
      // Show all filtered files if limit is null, plus the synthetic parent link.
      setFileTree([...parentLinks, ...filteredFiles]);
      setPagination(prev => ({
        ...prev,
        total: filteredTotal,
        hasMore: false,
      }));
    } else {
      // Apply pagination to filtered files
      // Bugfix: clamp offset when the filtered total shrinks (e.g. search/filter/delete)
      // so we don't render an empty page.
      const { offset, limit } = pagination;
      const maxOffset = filteredTotal > 0 ? Math.floor((filteredTotal - 1) / limit) * limit : 0;
      const safeOffset = Math.min(Math.max(0, offset), maxOffset);

      const startIndex = safeOffset;
      const endIndex = Math.min(filteredFiles.length, safeOffset + limit);
      const paginatedFiles = filteredFiles.slice(startIndex, endIndex);
      setFileTree([...parentLinks, ...paginatedFiles]);

      // Update pagination metadata based on filtered files
      setPagination(prev => ({
        ...prev,
        offset: safeOffset,
        total: filteredTotal,
        hasMore: endIndex < filteredFiles.length,
      }));
    }
    // Only depend on pagination.offset and pagination.limit, not the entire pagination object
    // (total and hasMore are set by this effect, so they shouldn't be dependencies)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFiles, pagination.offset, pagination.limit, filterVisibleFiles]);

  useEffect(() => {
    const activeEntries = Object.entries(conversionJobs).filter(
      ([, job]) => job.status === 'pending' || job.status === 'running'
    );

    if (activeEntries.length === 0) {
      return;
    }

    const intervalId = window.setInterval(async () => {
      await Promise.all(
        activeEntries.map(async ([path, job]) => {
          try {
            const updated = await getConversionJobStatus(job.jobId);
            const prevStatus = conversionJobs[path]?.status;
            const prevError = conversionJobs[path]?.error ?? null;

            setConversionJobs(prev => {
              const prevJob = prev[path];
              if (!prevJob) {
                return prev;
              }
              return {
                ...prev,
                [path]: {
                  ...prevJob,
                  status: updated.status,
                  error: updated.error ?? null,
                  result: updated.result,
                  enqueuedAt: updated.enqueuedAt,
                  startedAt: updated.startedAt ?? null,
                  finishedAt: updated.finishedAt ?? null,
                  serverSourcePath: updated.sourcePath || prevJob.serverSourcePath,
                  serverTargetPath: updated.targetPath || prevJob.serverTargetPath,
                },
              };
            });

            if (prevStatus !== updated.status || prevError !== (updated.error ?? null)) {
              const fileName = path.split(/[/\\]/).pop() || path;
              if (updated.status === 'succeeded') {
                toast.success(`Conversion completed: ${fileName}`);
                if (currentDirectory) {
                  fetchFiles(currentDirectory);
                }
                window.setTimeout(() => {
                  setConversionJobs(prev => {
                    const { [path]: _, ...rest } = prev;
                    return rest;
                  });
                }, 10000);
              } else if (updated.status === 'failed') {
                const errorMessage = updated.error ?? 'Conversion failed';
                toast.error(errorMessage);
                window.setTimeout(() => {
                  setConversionJobs(prev => {
                    const { [path]: _, ...rest } = prev;
                    return rest;
                  });
                }, 15000);
              }
            }
          } catch (err) {
            const errorMessage = getConversionErrorMessage(err, 'Failed to fetch conversion status');
            const prevStatus = conversionJobs[path]?.status;

            setConversionJobs(prev => {
              const prevJob = prev[path];
              if (!prevJob) {
                return prev;
              }
              return {
                ...prev,
                [path]: {
                  ...prevJob,
                  status: 'failed',
                  error: errorMessage,
                },
              };
            });

            if (prevStatus !== 'failed') {
              const fileName = path.split(/[/\\]/).pop() || path;
              toast.error(errorMessage);
              window.setTimeout(() => {
                setConversionJobs(prev => {
                  const { [path]: _, ...rest } = prev;
                  return rest;
                });
              }, 15000);
            }
          }
        })
      );
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [conversionJobs, currentDirectory, fetchFiles, getConversionErrorMessage]);

  // Temporarily commented out upload to cloud functionality
  /*
  const handleUploadToCloud = async (item: FileTreeNode) => {
    if (!electron) return;

    const auth = getAuth(app);
    // Use webCurrentDirectory as the source of truth
    const destPath = webCurrentDirectory || '';
    const isLoggedIn = !!auth.currentUser;

    // Permission check: Do not allow uploads to virtual root or restricted paths; Must be in personal directory or its subdirectory
    if (isLoggedIn && (destPath === VIRTUAL_ROOT || isPublicReadOnlyPath(destPath) || !isPersonalRootPath(destPath))) {
      toast.warning('Please open Personal or its subfolder to upload files.');
      return;
    }
    if (!isLoggedIn && (!destPath || isPublicReadOnlyPath(destPath))) {
      toast.warning('Upload is not allowed in this path. Please login and enter personal directory.');
      return;
    }

    setIsUploadingToCloud(true);
    setIsUploadDialogOpen(true);
    setOverallUploading(true);
    setOverallProgress(0);
    // Let the dialog render a frame to avoid visual delay
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      if (item.is_dir) {
        toast('Uploading entire folders is not supported directly from local manager. Please use drag and drop in Web File Manager.');
        return;
      }

      // Read local file and construct File object
      const fileBuffer = await electron.readFile(item.path);
      const file = new File([fileBuffer], item.name, { type: 'application/octet-stream' });

      // Overwrite confirmation: If the cloud target directory exists with the same name, prompt (using custom Dialog)
      try {
        const listing = await apiListFiles(destPath);
        const filesArr: any[] = Array.isArray(listing)
          ? listing
          : (listing?.files || listing?.items || []);
        const exists = filesArr.some((f: any) => (f?.name || f?.filename) === file.name);
        if (exists) {
          const ok = await new Promise<boolean>((resolve) => {
            overwriteResolverRef.current = resolve;
            setOverwriteFileName(file.name);
            setOverwriteDialogOpen(true);
          });
          if (!ok) {
            setOverallUploading(false);
            setIsUploadingToCloud(false);
            // Let the dialog render a frame to avoid visual delay
            setTimeout(() => setIsUploadDialogOpen(false), 150);
            toast('Upload cancelled');
            return;
          }
        }
      } catch (e) {
        // list files failed, skip overwrite check, let the backend decide the conflict strategy
        console.warn('Failed to list files for overwrite check:', e);
      }

      const fileId = `${file.name}_${Date.now()}`;
      const startTime = Date.now();

      setUploadStatus(prev => {
        const next = new Map(prev);
        next.set(fileId, {
          progress: 0,
          status: 'Uploading',
          startTime,
          fileSize: file.size,
          fileName: file.name,
        });
        return next;
      });
      // status is set when the dialog is opened

      // construct FileList
      const dt = new DataTransfer();
      dt.items.add(file);
      const files = dt.files;

      await apiUploadFiles(destPath, files, (percent) => {
        setUploadStatus(prev => {
          const next = new Map(prev);
          const s = next.get(fileId);
          if (s) {
            const elapsed = Date.now() - (s.startTime || startTime);
            next.set(fileId, {
              ...s,
              progress: percent,
              status: 'Uploading',
              uploadTime: elapsed,
              estimatedTimeRemaining: percent > 0 ? (elapsed / percent) * (100 - percent) : undefined,
            });
          }
          return next;
        });
        setOverallProgress(percent);
        setOverallUploading(true);
      }, true); // pass overwrite=true since user confirmed overwrite

      setUploadStatus(prev => {
        const next = new Map(prev);
        const s = next.get(fileId);
        if (s) next.set(fileId, { ...s, progress: 100, status: 'Completed' });
        return next;
      });
      setOverallProgress(100);
      setOverallUploading(false);

      toast.success(`Uploaded to cloud: ${file.name}`);
      // Notify WebFileManager to refresh listing/quota
      try {
        if (typeof window !== 'undefined') {
          const detail = { path: webCurrentDirectory };
          window.dispatchEvent(new CustomEvent('tissuelab:cloudUploadCompleted', { detail }));
        }
      } catch {}
    } catch (error: any) {
      console.error('Error uploading to cloud:', error);
      setUploadStatus(prev => {
        const next = new Map(prev);
        // Mark all ongoing tasks as error
        for (const [k, v] of Array.from(next.entries())) {
          if (v.status === 'Uploading' || v.status === 'Paused') {
            next.set(k, { ...v, status: 'Error', error: error?.message || String(error) });
          }
        }
        return next;
      });
      setOverallUploading(false);
      toast.error(getErrorMessage(error, 'Upload failed'));
    } finally {
      setIsUploadingToCloud(false);
    }
  };
  */

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
    // Only run when rootFolder changes, not when fetchFiles changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootFolder]);

  const handleWsiUpload = async (absolutePath: string) => {
    try {
      console.log('LocalFileManager: Starting WSI upload for:', absolutePath);

      // Step 1: Upload file path
      const uploadData = await uploadFilePath(absolutePath);
      console.log('LocalFileManager: uploadData:', uploadData);

      // Step 2: Create instance (this is the missing step!)
      console.log('LocalFileManager: Type of uploadData:', typeof uploadData);
      const instanceData = await createInstance(uploadData.filePath ?? uploadData.fileName);
      console.log('LocalFileManager: instanceData:', instanceData);

      // Step 3: Load file data
      const loadData = await loadFileData(uploadData.fileName);
      console.log('LocalFileManager: loadData:', loadData);

      // Step 4: Set all the necessary data in Redux
      dispatch(setCurrentPath({ path: absolutePath }) as PayloadAction<{ path: string | null }>);
      dispatch(setOutputPath(absolutePath ? absolutePath + '.zarr' : ''));
      dispatch(setSlideInfo({
        dimensions: (uploadData.slideInfo.dimensions ?? null) as [number, number] | null,
        fileSize: uploadData.fileSize ?? null,
        mpp: uploadData.slideInfo.mpp ?? null,
        magnification: uploadData.slideInfo.magnification ?? null,
        imageType: uploadData.slideInfo.imageType || (uploadData.slideInfo.fileFormat === 'qptiff' && uploadData.slideInfo.totalChannels && uploadData.slideInfo.totalChannels > 3) ? 'Multiplex Immunofluorescent' : 'Brightfield H&E'
      }));
      if (uploadData.slideInfo.totalChannels) {
        dispatch(setTotalChannels(uploadData.slideInfo.totalChannels));
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

      // Update current image path to ensure proper highlighting
      dispatch(setCurrentImagePath(absolutePath));

      // Sync sidebar folder to the parent of the opened image so left folder list is correct on enter (no need to click refresh)
      const sep = absolutePath.includes('\\') ? '\\' : '/';
      const lastSep = absolutePath.lastIndexOf(sep);
      const parentDir = lastSep !== -1 ? absolutePath.substring(0, lastSep) : '';
      dispatch(setSelectedFolder(parentDir));

      dispatch(setImageLoaded(true));
      router.push('/imageViewer');
    } catch (err) {
      console.error("Error processing WSI file:", err);
      setError("Failed to load WSI file.");
    }
  };



  const getAllImageFiles = useCallback(() => {
    return getAllImageFilesUtil(fileTree, false); // LocalFileManager doesn't include Zarr in image table
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
      <div className="w-full px-6">
        {/* Header */}

        <div
          className="grid gap-2 p-3 border-b font-medium text-sm text-muted-foreground"
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
                className="grid gap-2 p-3 hover:bg-primary/10 border-b items-center min-h-[120px]"
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
                    variant="outline"
                    size="sm"
                    className="gap-2 px-4"
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
  const flattenTree = useCallback((nodes: FileTreeNode[]): FileTreeNode[] => {
    return flattenFileTree(nodes, showNonImageFiles);
  }, [showNonImageFiles]);

  // handleItemClick for file loading logic
  const handleItemClick = (item: FileTreeNode, e: React.MouseEvent) => {
    if (item.is_dir && !isZarr(item.name)) {
      fetchFiles(item.path);
    } else if (isWSI(item.name)) {
      handleWsiUpload(item.path);
    } else if (isZarrZip(item.name)) {
      // For .zarr.zip files, show message that extraction is needed
      toast.warning('Please extract the zip file first before opening the workspace.');
    } else if (isZarr(item.name)) {
      // For .zarr directories, try to find and open the corresponding WSI file
      const zarrBaseName = getWSIBaseName(item.name);
      const parentDir = item.path.substring(0, item.path.lastIndexOf('/'));
      // Try to find the corresponding WSI file in the same directory
      const wsiFile = fileTree.find(file =>
        !file.is_dir &&
        isWSI(file.name) &&
        file.name.startsWith(zarrBaseName) &&
        file.path.startsWith(parentDir)
      );
      if (wsiFile) {
        handleWsiUpload(wsiFile.path);
      } else {
        console.log("No corresponding WSI file found for Zarr file:", item.path);
      }
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
    const nameError = validateItemName(folderName);
    if (nameError) { toast.error(nameError); return; }
    const sep = currentDirectory?.includes('\\') ? '\\' : '/';
    const newPath = currentDirectory ? `${currentDirectory}${sep}${folderName}` : folderName;
    try {
      await electron.invoke('create-local-folder', newPath);
      await fetchFiles(currentDirectory);
      toast.success('Folder created successfully');
    } catch (err: any) {
      const message = getErrorMessage(err, 'Failed to create folder');
      toast.error(message);
      setError(message);
    } finally { setDialog(null); }
  };

  const handleRename = async (newName: string) => {
    if (!newName || !dialog || dialog.type !== 'rename' || !dialog.path) return;
    const nameError = validateItemName(newName);
    if (nameError) { toast.error(nameError); return; }
    const oldPath = dialog.path;

    // Handle both Windows and Unix path separators
    const normalizedPath = oldPath.replace(/\\/g, '/');
    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    const dir = lastSlashIndex !== -1 ? oldPath.substring(0, lastSlashIndex) : '';
    const sep = oldPath.includes('\\') ? '\\' : '/';
    const newPath = dir ? `${dir}${sep}${newName}` : newName;

    try {
      await electron.invoke('rename-local-file', oldPath, newPath);
      await fetchFiles(currentDirectory);
      toast.success('Item renamed successfully');
    } catch (err: any) {
      const message = getErrorMessage(err, 'Failed to rename item');
      toast.error(message);
      setError(message);
    } finally { setDialog(null); }
  };

  const handleShowInSystemFileManager = useCallback(
    async (itemPath: string) => {
      if (!electron) return;
      try {
        await electron.invoke('show-item-in-folder', itemPath);
      } catch (err: unknown) {
        toast.error(getErrorMessage(err, 'Failed to open file manager'));
      }
    },
    [electron]
  );

  const handleConvertToZarr = async (item: FileTreeNode) => {
    if (item.is_dir || !isH5Convertible(item.name)) {
      toast.warning('Selected item is not a convertible H5 file.');
      return;
    }

    const existingJob = conversionJobs[item.path];
    if (existingJob && (existingJob.status === 'pending' || existingJob.status === 'running')) {
      toast.info('Conversion is already in progress for this file.');
      return;
    }

    try {
      const job = await enqueueH5ToZarr({
        source_path: item.path,
        overwrite: true,
      });

      setConversionJobs(prev => ({
        ...prev,
        [item.path]: {
          jobId: job.jobId,
          status: job.status,
          error: job.error ?? null,
          result: job.result,
          enqueuedAt: job.enqueuedAt,
          startedAt: job.startedAt ?? null,
          finishedAt: job.finishedAt ?? null,
          originalPath: item.path,
          serverSourcePath: job.sourcePath || item.path,
          serverTargetPath: job.targetPath,
        },
      }));

      toast.success('Conversion task has been queued.');
    } catch (err: any) {
      const errorMessage = getConversionErrorMessage(err, 'Failed to start conversion task.');
      toast.error(errorMessage);
      setConversionJobs(prev => {
        const next = { ...prev };
        delete next[item.path];
        return next;
      });
    }
  };

  const sortData = (data: FileTreeNode[], config: SortConfig) => {
    return sortFileTreeData(data, config);
  };

  const filesToRender = fileTree;

  // Pagination handlers
  const handlePreviousPage = useCallback(() => {
    if (pagination.offset > 0 && pagination.limit !== null) {
      const newOffset = Math.max(0, pagination.offset - pagination.limit);
      setPagination(prev => ({ ...prev, offset: newOffset }));
    }
  }, [pagination.offset, pagination.limit]);

  const handleNextPage = useCallback(() => {
    if (pagination.hasMore && pagination.limit !== null) {
      const newOffset = pagination.offset + pagination.limit;
      setPagination(prev => ({ ...prev, offset: newOffset }));
    }
  }, [pagination]);

  const handlePageSizeChange = useCallback((newLimit: number | null) => {
    setPagination(prev => ({ limit: newLimit, offset: 0, total: prev.total, hasMore: false }));
  }, []);

  const handlePageClick = useCallback((page: number) => {
    if (pagination.limit !== null) {
      const newOffset = (page - 1) * pagination.limit;
      setPagination(prev => ({ ...prev, offset: newOffset }));
    }
  }, [pagination.limit]);

  const renderItemContextMenu = (item: FileTreeNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => {
          setTimeout(() => {
            setDialog({ type: 'rename', path: item.path })
          }, 50)
        }}>
          <Edit className="h-4 w-4 mr-2" /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!electron}
          onSelect={() => {
            setTimeout(() => {
              void handleShowInSystemFileManager(item.path);
            }, 50);
          }}
        >
          <FolderOpen className="h-4 w-4 mr-2" />
          {getOpenInSystemFileManagerMenuLabel()}
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


  // Render desktop table rows only
  const renderFileTableRows = (nodes: FileTreeNode[]): React.ReactNode[] => {
    let rows: React.ReactNode[] = [];
    const sortedNodes = sortData(nodes, sortConfig);
    sortedNodes.forEach(item => {
      if (item.isParentLink) {
        rows.push(
          <TableRow
            key="parent-link"
            onClick={handleGoUp}
            onDoubleClick={handleGoUp}
            className="cursor-pointer transition-colors align-top hover:bg-muted mx-2 rounded-lg bg-card last:border-b"
          >
            <TableCell className="px-3">
              <div className="flex items-start gap-2">
                <ChevronRight className="h-5 w-5 mt-0.5 text-muted-foreground flex-shrink-0" />
                <span className="break-all">{item.name}</span>
              </div>
            </TableCell>
            <TableCell className="text-right px-3 text-muted-foreground">Parent Directory</TableCell>
            <TableCell className="text-right px-3 text-muted-foreground">—</TableCell>
            <TableCell className="text-right px-3 text-muted-foreground">—</TableCell>
            <TableCell className="text-right px-3"></TableCell>
          </TableRow>
        );
        return;
      }
      if (!showNonImageFiles && !item.is_dir && !isWSI(item.name) && !isZarr(item.name)) {
        if (item.children && item.children.length > 0) {
          rows = rows.concat(renderFileTableRows(item.children));
        }
        return;
      }
      rows.push(
        <TableRow
          key={item.path}
          onClick={(e) => handleItemClick(item, e)}
          className="even:bg-muted/20 cursor-pointer transition-colors align-top rounded-lg mx-2 hover:!bg-primary/10 last:border-b"
        >
          <TableCell className="px-3">
            <div style={{ paddingLeft: `${item.depth * 24}px` }} className="flex items-start gap-3">
              {item.is_dir && !isZarr(item.name)
                ? <Folder className="h-5 w-5 text-primary flex-shrink-0" />
                : isWSI(item.name)
                  ? <ImageIcon className="h-5 w-5 text-destructive flex-shrink-0" />
                  : isZarrZip(item.name)
                    ? <Archive className="h-4 w-4 text-primary/80 flex-shrink-0" />
                    : isZarrDir(item.name)
                      ? <FileIcon className="h-4 w-4 text-primary/60 flex-shrink-0" />
                      : <FileIcon className="h-5 w-5 text-muted-foreground flex-shrink-0" />}
              <span className="break-all">{item.name}</span>
            </div>
          </TableCell>
          <TableCell className="text-right px-3 text-muted-foreground">{item.is_dir && !isZarr(item.name) ? 'Folder' : formatFileType(item.name)}</TableCell>
          <TableCell className="text-right px-3 text-muted-foreground">{item.is_dir ? '—' : formatBytes(item.size)}</TableCell>
          <TableCell className="text-right px-3 text-muted-foreground">{new Date(item.mtime * 1000).toLocaleString()}</TableCell>
          <TableCell className="text-right px-3" onClick={(e) => e.stopPropagation()}>
            {renderItemContextMenu(item)}
          </TableCell>
        </TableRow>
      );
      if (item.children && item.children.length > 0) {
        rows = rows.concat(renderFileTableRows(item.children));
      }
    });
    return rows;
  };

  // Render mobile cards only
  const renderFileCards = (nodes: FileTreeNode[]): React.ReactNode[] => {
    let cards: React.ReactNode[] = [];
    const sortedNodes = sortData(nodes, sortConfig);
    sortedNodes.forEach(item => {
      if (item.isParentLink) {
        cards.push(
          <div
            key="parent-link"
            className="p-3 mb-2 bg-card border border-border rounded-lg cursor-pointer hover:bg-primary/10"
            onClick={handleGoUp}
          >
            <div className="flex items-center gap-2">
              <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
              <span className="font-medium">{item.name}</span>
            </div>
            <div className="text-sm text-muted-foreground mt-1">Parent Directory</div>
          </div>
        );
        return;
      }
      if (!showNonImageFiles && !item.is_dir && !isWSI(item.name) && !isZarr(item.name)) {
        if (item.children && item.children.length > 0) {
          cards = cards.concat(renderFileCards(item.children));
        }
        return;
      }
      cards.push(
        <div
          key={item.path}
          className="p-3 mb-2 bg-card border border-border rounded-lg cursor-pointer hover:bg-primary/10"
          onClick={(e) => handleItemClick(item, e)}
          style={{ marginLeft: `${item.depth * 16}px` }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 flex-1 min-w-0">
              {item.is_dir && !isZarr(item.name)
                ? <Folder className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                : isWSI(item.name)
                  ? <ImageIcon className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                  : isZarr(item.name)
                    ? <FileIcon className="h-4 w-4 text-primary/70 flex-shrink-0 mt-0.5" />
                    : <FileIcon className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />}
              <div className="flex-1 min-w-0">
                <div className="font-medium break-all text-sm">{item.name}</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-muted-foreground">
                  <span><span className="font-medium">Type:</span> {item.is_dir && !isZarr(item.name) ? 'Folder' : formatFileType(item.name)}</span>
                  {!item.is_dir && <span><span className="font-medium">Size:</span> {formatBytes(item.size)}</span>}
                  <span><span className="font-medium">Modified:</span> {new Date(item.mtime * 1000).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
            <div onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
              {renderItemContextMenu(item)}
            </div>
          </div>
        </div>
      );
      if (item.children && item.children.length > 0) {
        cards = cards.concat(renderFileCards(item.children));
      }
    });
    return cards;
  };

  const renderFileTable = () => {
    const flatVisibleFiles = flattenTree(filesToRender);
    return (
      <div>
        {/* Desktop table */}
        <div className="hidden md:block px-6 py-0">
          <Table>
            {/* <TableHeader>
              <TableRow className="rounded-lg mx-2 bg-gray-100 dark:bg-gray-800">
                <TableHead className="px-3"> */}
            <TableHeader className="p-0">
              <TableRow className="text-xs text-muted-foreground/70 last:border-b">
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
              {renderFileTableRows(filesToRender)}
            </TableBody>
          </Table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden px-2">
          {renderFileCards(filesToRender)}
        </div>
      </div>
    );
  }

  const renderDialog = () => {
    if (!dialog) return null;
    if (dialog.type === 'create-folder' || dialog.type === 'rename') {
      const isRename = dialog.type === 'rename';
      const defaultValue = isRename ? dialog.path?.split('/').pop() : '';
      return (
        <Dialog open onOpenChange={() => setDialog(null)}>
          <DialogContent className="bg-background text-foreground">
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

  const normalizedRootPath = rootFolder ? rootFolder.replace(/\\/g, '/') : '';

  const convertToSystemPath = useCallback(
    (normalizedPath: string) => {
      if (!rootFolder) return normalizedPath;
      return rootFolder.includes('\\') ? normalizedPath.replace(/\//g, '\\') : normalizedPath;
    },
    [rootFolder]
  );

  const renderBreadcrumbs = () => (
    <div className="flex items-center text-xs sm:text-sm text-gray-500 overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent py-1">
      <span
        className="cursor-pointer hover:underline p-1 rounded flex items-center gap-1 sm:gap-2 flex-shrink-0"
        onClick={() => fetchFiles(rootFolder)}
      >
        <Folder className="h-3 w-3 sm:h-4 sm:w-4" />
        <span className="truncate max-w-[120px] sm:max-w-[200px] md:max-w-none" title={rootFolder || 'Local Root'}>
          {rootFolder ? rootFolder : 'Local Root'}
        </span>
      </span>
      {currentDirectory && currentDirectory !== rootFolder && <ChevronRight className="h-3 w-3 sm:h-4 sm:w-4 mx-0.5 sm:mx-1 flex-shrink-0" />}
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
                  className="cursor-pointer hover:underline p-1 rounded truncate max-w-[100px] sm:max-w-[150px] md:max-w-none flex-shrink-0"
                  title={part}
                  onClick={() => {
                    fetchFiles(pathUntilThisPart);
                  }}
                >
                  {part}
                </span>
                {index < arr.length - 1 && <ChevronRight className="h-3 w-3 sm:h-4 sm:w-4 mx-0.5 sm:mx-1 flex-shrink-0" />}
              </React.Fragment>
            );
          });
        }
        return null;
      })()}
    </div>
  );

  return (
    <div className="flex-1 w-full flex flex-col shadow-none min-h-0">
    <Card className="flex-1 flex flex-col rounded-sm mb-0 border-border/50 min-h-0">
        <CardHeader className="p-5">
            <FileHeader
              viewMode={viewMode}
              setViewMode={setViewMode}
              showNonImageFiles={showNonImageFiles}
              setShowNonImageFiles={setShowNonImageFiles}
              onRefresh={() => fetchFiles(currentDirectory)}
              onNewFolder={() => setDialog({ type: "create-folder" })}
              onOpenFolder={handleOpenRootFolder}
              onGoUp={handleGoUp}
              canGoUp={!!currentDirectory && currentDirectory !== rootFolder}
              breadcrumb={renderBreadcrumbs()}
            />
        </CardHeader>
        <CardContent className="p-0 flex flex-col flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="flex-1">
            {isLoading && <div className="p-4 text-center text-muted-foreground">Loading...</div>}
            {error && <div className="p-4 text-center text-destructive">{error}</div>}
            {!isLoading && !error && !rootFolder && (
              <div className="p-4 text-center text-muted-foreground">
                Click Open Folder to start browsing your local files.
              </div>
            )}
            {!isLoading && !error && rootFolder && filesToRender.length === 0 && (
              <div className="p-4 text-center text-muted-foreground">
                This folder is empty.
              </div>
            )}
            {!isLoading && !error && rootFolder && filesToRender.length > 0 && (
              <div>
                {viewMode === 'table' ? renderImageTable() : renderFileTable()}
              </div>
            )}
          </ScrollArea>
          <FileManagerPagination
            pagination={pagination}
            isLoading={isLoading}
            onPrevious={handlePreviousPage}
            onNext={handleNextPage}
            onPageSizeChange={handlePageSizeChange}
            onPageClick={handlePageClick}
          />
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
