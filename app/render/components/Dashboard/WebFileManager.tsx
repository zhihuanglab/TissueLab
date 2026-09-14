"use client";
import { denyWriteToast } from "@/hooks/usePathWriteAccess"
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFileManagerPreservation } from '@/hooks/dashboard/useFileManagerPreservation';
import { hasActiveUploadStatuses, useUploadProgress } from '@/hooks/dashboard/useUploadProgress';
import { useUserInfo } from '@/contexts/UserInfoProvider';
import { ConversionJobStatus, enqueueH5ToZarr, getConversionJobStatus } from '@/services/data.service';
import { createInstance, getPreviewAsync, loadFileData, uploadFilePath } from '@/services/file.service';
import { enqueuePreRunBatch } from '@/services/preRunBatchRuntime.service';
import { RootState } from '@/store/index';
import { setOutputPath } from '@/store/slices/chat/workflowSlice';
import { setCurrentImagePath } from '@/store/slices/fileManagerSlice';
import { setImageLoaded, setWsiOpening } from '@/store/slices/layoutSlice';
import { setSlideInfo, setTotalChannels } from '@/store/slices/svsPathSlice';
import {
  resetPagination,
  setCurrentDirectory,
  setError,
  setFileTree,
  setIsLoading,
  setPagination,
  setSearchTerm,
  setSelectedFolder,
  setShowNonImageFiles,
  setSortConfig,
  setTableViewMode,
  setUploadSettings
} from '@/store/slices/fileManagerSlice';
import { replaceCurrentInstance, updateInstanceWSIInfo } from '@/store/slices/wsiSlice';
import { FileItem, FileTreeNode, SortConfig } from '@/types/fileManager.types';
import {
  createFolder as apiCreateFolder,
  deleteFiles as apiDeleteFiles,
  listFiles as apiListFiles,
  listFilesPage,
  type ListFilesPagination,
  moveFiles as apiMoveFiles,
  renameFile as apiRenameFile,
  searchFiles as apiSearchFiles,
  uploadFiles as apiUploadFiles,
  compressItems,
  decompressZip,
  downloadFile,
  getConfig,
  copyFileToPersonal,
  copyFolderToPersonal,
} from '@/services/fileManager.service';
import {
  listChunkUploadResumeHints,
  isStorageQuotaError,
  type ChunkUploadResumeHint,
} from '@/services/chunkedUpload.utils';
import {
  executeZarrBatchUpload,
  getZarrRootFromRelativePath,
  type ZarrBatchFileEntry,
} from '@/services/zarrUpload.service';
import {
  buildUploadBatchUnits,
  classifyUploadEntries,
  DEFAULT_CHUNKED_UPLOAD_THRESHOLD_BYTES,
  type UploadBatchUnit,
} from '@/services/uploadBatch.utils';
import { runUploadPreflight } from '@/services/uploadPreflight.service';
import {
  emptyUploadCounts,
  executeBatchUpload,
  executeChunkedFileUpload,
  executeLargeFileBatchUpload,
  executeSmallFileBatchUpload,
} from '@/services/fileUpload.service';
import {
  flattenFileTree,
  formatBytes,
  formatFileType,
  getAllImageFiles as getAllImageFilesUtil,
  parseListingToNames,
  sortFileTreeData,
  truncateFileName
} from '@/utils/dashboard/fileManager.utils';
import { getBackendDefinedErrorMessage, getErrorMessage } from '@/utils/common/apiResponse';
import { getWSIBaseName, isH5Convertible, isWSI, isZarr, isZarrDir, isZarrZip } from '@/utils/dashboard/fileType.utils';
import { isPublicReadOnlyPath, isWriteBlockedPath } from '@/utils/common/pathAccess.utils';
import { shortHashFromString, validateItemName } from '@/utils/common/string.utils';
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@radix-ui/react-hover-card";
import {
  Archive, ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  DownloadCloud,
  Edit,
  File,
  Folder,
  FolderInput,
  Image as ImageIcon, Info,
  Link2,
  MoreVertical,
  Shapes,
  Trash2,
  Eraser,
  Upload,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector, useStore } from "react-redux";
import { toast } from 'sonner';
import {
  listingQueryKeyOf,
  listingRefetchTarget,
  normalizeNavigationPath,
  shouldApplyListingResponse,
} from '@/utils/dashboard/listingRequest';
import { recentListings, RecentListing } from '@/utils/dashboard/recentListings';
import Breadcrumbs from './Breadcrumbs';
import { FileHeader } from "./FileManager/FileHeader";
import { FileManagerPagination } from './FileManager/FileManagerPagination';
import ImagePreviewCell from './FileManager/ImagePreviewCell';
import ZarrBadgesCell from './FileManager/ZarrBadgesCell';
import { UploadDialog } from './UploadDialog';
import { SelectCircleIcon } from '@/components/assets/SelectCircleIcon';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

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
          <ImageIcon className="mr-2 h-4 w-4 text-destructive" />
          <span className="flex-1 break-words text-sm leading-tight" title={fileName} style={{ wordBreak: 'break-all' }}>
            {truncateFileName(fileName, maxLength)}
          </span>
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="z-50 w-80 space-y-3 rounded-lg border border-border bg-popover p-4 shadow-xl" sideOffset={5}>
        <div className="truncate border-b pb-2 text-sm font-bold text-foreground">{fileName}</div>
        {isLoading && (
          <div className="py-8 text-center">
            <p className="text-sm text-muted-foreground">Loading preview...</p>
          </div>
        )}
        {error && (
          <div className="py-4 text-center">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
};

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

/**
 * Placeholder rows for a listing that has nothing to show yet.
 *
 * The list used to collapse to a single line of centred text while any request
 * was in flight, so a folder switch read as: old rows flash, everything folds
 * to one line, new rows push it open again. That reads as slow however quick
 * the request was. Holding the list's shape means only the content arrives.
 *
 * Mirrors `FileManagerSkeleton` in StorageFolderCards, which covers the same
 * moment one level up.
 */
/**
 * Last width the table was measured at. Module scope so it survives the remount
 * a folder switch performs: the container is the same size either side of the
 * switch, so starting from the real width means the columns are right on the
 * first frame instead of settling a moment later.
 */
let lastMeasuredTableWidth = 0;

const ListingSkeleton: React.FC = () => (
  <div className="flex animate-pulse flex-col gap-3 p-3" aria-hidden role="presentation">
    {Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="flex items-center gap-3">
        <div className="h-5 w-5 shrink-0 rounded bg-muted/70" />
        <div
          className="h-4 flex-1 rounded bg-muted/60"
          style={{ maxWidth: `${70 - (i % 4) * 9}%` }}
        />
        <div className="h-4 w-14 shrink-0 rounded bg-muted/40" />
        <div className="h-4 w-20 shrink-0 rounded bg-muted/40" />
      </div>
    ))}
  </div>
);

// Main WebFileManager Component
interface WebFileManagerProps {
  initialPath?: string;
}

const WebFileManager = ({ initialPath: initialPathProp }: WebFileManagerProps = {}) => {

  const dispatch = useDispatch();
  const store = useStore<RootState>();
  const router = useRouter();
  const { userInfo } = useUserInfo();
  // Single local user — always signed in.
  const localUid = userInfo?.user_id ?? 'local';

  // Generate a stable key prefix for this component instance
  const [keyPrefix] = useState(() => `wfm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  const fileManagerStorageKey = `fileManagerState:${localUid}`;

  // Use the preservation hook to get and save state
  const {
    currentDirectory,
    fileTree,
    searchTerm,
    sortConfig,
    showNonImageFiles,
    tableViewMode,
    lastVisitedPath
  } = useFileManagerPreservation(fileManagerStorageKey);
  
  // Store all fetched files for client-side filtering and pagination
  const [allFetchedFiles, setAllFetchedFiles] = useState<FileTreeNode[]>([]);
  // Read inside `fetchFiles`, whose closure can predate the latest rows.
  const allFetchedFilesRef = useRef<FileTreeNode[]>([]);
  allFetchedFilesRef.current = allFetchedFiles;

  // Track the file-table container width so we can drop the least-important
  // columns first when the panel gets narrow. Actions always stays; mtime
  // disappears first, then size, then type. Name is the last to survive.
  // Breakpoints are container-relative — works inside the resizable
  // dashboard sidebar where viewport media queries don't help.
  //
  // Reserved-width budget per column (approximate, derived by eyeballing
  // typical rendered widths at the current font/padding):
  //   - Actions:        ~72px (icon button + padding)
  //   - mtime:         ~190px ("11/30/2026, 8:42:11 PM" with sort arrow)
  //   - size:          ~110px ("12.4 MB" + sort arrow)
  //   - type:          ~110px ("Folder" / ".svs" + sort arrow)
  //   - Name minimum:  ~160px (short filename + icon + chevron)
  // Threshold = sum of (Name min + Actions + columns shown at that level).
  // The constants are derived so changing one piece (e.g. mtime gets a
  // shorter format) only needs the corresponding line updated.
  //
  // Type and Size are dropped TOGETHER (single breakpoint): a "Folder /
  // 12.4 MB" pair feels coherent — showing Type alone without Size or vice
  // versa reads as broken. mtime stays independent because it's the wordiest
  // column and benefits from being dropped one tier earlier on its own.
  const COL_MIN_NAME = 240;
  const COL_W_ACTIONS = 72;
  const COL_W_TYPE = 110;
  const COL_W_SIZE = 110;
  const COL_W_MTIME = 190;
  const SHOW_TYPE_SIZE_WIDTH = COL_MIN_NAME + COL_W_TYPE + COL_W_SIZE + COL_W_ACTIONS;
  const SHOW_MTIME_WIDTH = SHOW_TYPE_SIZE_WIDTH + COL_W_MTIME;

  // Use a state-tracked node (callback ref) instead of useRef so the
  // ResizeObserver-binding effect actually fires when the table div finally
  // mounts. With a plain useRef + [] effect, the table is rendered AFTER
  // the loading state clears and `.current` is still null at the moment
  // the effect ran, so the observer never attached and columns never
  // adapted to width changes.
  const [tableContainer, setTableContainer] = useState<HTMLDivElement | null>(null);
  // Start from the last real measurement when there is one; the widest
  // threshold is only the first-ever fallback. Pinning to it every time made
  // the columns settle visibly on each switch — too wide and `Type`/`Size`
  // showed then vanished.
  const [tableWidth, setTableWidth] = useState<number>(
    () => lastMeasuredTableWidth || SHOW_MTIME_WIDTH,
  );
  useEffect(() => {
    if (!tableContainer || typeof ResizeObserver === 'undefined') return;
    // Coalesce width updates with requestAnimationFrame so dragging the
    // resizer doesn't flood React with one setState per pixel — the
    // breakpoint checks below only care about ≥ vs <, so subsample is fine.
    let rafId: number | null = null;
    let latestWidth = 0;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0;
      if (w <= 0) return;
      latestWidth = w;
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        lastMeasuredTableWidth = latestWidth;
        setTableWidth(latestWidth);
      });
    });
    ro.observe(tableContainer);
    return () => {
      ro.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [tableContainer]);
  const showType = tableWidth >= SHOW_TYPE_SIZE_WIDTH;
  const showSize = tableWidth >= SHOW_TYPE_SIZE_WIDTH;
  const showMtime = tableWidth >= SHOW_MTIME_WIDTH;
  
  const triggerStorageRefresh = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('tissuelab:cloudUsageRefresh'));
    }
  }, []);

  const {
    uploadStatus,
    uploadInterrupted,
    setUploadInterrupted,
    uploadStatusRef,
    totalUploadFilesRef,
    uploadQuotaErrorRef,
    uploadCompletionTracker,
    uploadBatchGenerationRef,
    chunkedUploadManagersRef,
    zarrSessionStoreRef,
    initializeUploadStatusBatch,
    safeUpdateOverallProgress,
    captureUploadQuotaError,
    createUnitUploadCallbacks,
    buildSmallFileBatchCallbacks,
    cleanupUploadState,
    cancelChunkedUpload,
  } = useUploadProgress();
  
  const flattenTree = useCallback((nodes: FileTreeNode[]): FileTreeNode[] => {
      return flattenFileTree(nodes, showNonImageFiles);
  }, [showNonImageFiles]);

  // Helper function to check if a file/directory exists in the file tree
  const findFileInTree = useCallback((targetPath: string, targetName: string): FileTreeNode | null => {
      const flatTree = flattenTree(fileTree);
      // Check if path matches or if name matches in the same directory
      const found = flatTree.find(node => {
          // Check exact path match
          if (node.path === targetPath) return true;
          // Check if name matches and parent directory matches
          if (node.name === targetName) {
              const nodeParent = node.path.includes('/') ? node.path.substring(0, node.path.lastIndexOf('/')) : '';
              const targetParent = targetPath.includes('/') ? targetPath.substring(0, targetPath.lastIndexOf('/')) : '';
              return nodeParent === targetParent;
          }
          return false;
      });
      return found || null;
  }, [fileTree, flattenTree]);
  

  // Get other state from Redux
  const {
    isLoading,
    error,
    uploadSettings,
    pagination: paginationState
  } = useSelector((state: RootState) => state.fileManager);

  // Local state for drag and drop and upload management
  /** Paths currently being dragged — the whole selection when a selected row starts the drag. */
  const [draggingPaths, setDraggingPaths] = useState<string[]>([]);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  
  // Conversion jobs state for h5 to zarr conversion
  const [conversionJobs, setConversionJobs] = useState<ConversionJobMap>({});
  
  // Overwrite confirmation dialog state for compression/extraction
  const [overwriteCompressDialogOpen, setOverwriteCompressDialogOpen] = useState(false);
  const [overwriteTargetPath, setOverwriteTargetPath] = useState<string | null>(null);
  const [overwriteTargetName, setOverwriteTargetName] = useState<string | null>(null);
  const [overwriteAction, setOverwriteAction] = useState<(() => Promise<void>) | null>(null);
  const [chunkUploadResumeHints, setChunkUploadResumeHints] = useState<ChunkUploadResumeHint[]>([]);
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false);
  const [overwriteFiles, setOverwriteFiles] = useState<File[]>([]);
  const [overwriteConflictDesc, setOverwriteConflictDesc] = useState<string>('');
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[]>([]);
  const [pendingRelativePaths, setPendingRelativePaths] = useState<string[] | undefined>(undefined);
  const overwriteResolverRef = useRef<((choice: 'cancel' | 'overwrite' | 'keep_both') => void) | null>(null);

  const resetOverwriteCompressDialog = useCallback(() => {
    setOverwriteCompressDialogOpen(false);
    setOverwriteTargetPath(null);
    setOverwriteTargetName(null);
    setOverwriteAction(null);
  }, []);
  /** Server capped the search results — banner shown under the list. */
  const [searchTruncated, setSearchTruncated] = useState(false);

  // Copy-to-Personal state — per-item tracking (key = item.path)
  type CopyItemState = 'copying' | 'queued';
  const [copyStates, setCopyStates] = useState<Record<string, CopyItemState>>({});
  // iOS-style: enter multi-select via explicit Select button, then tap to toggle.
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const selectionAnchorRef = useRef<string | null>(null);
  const [copyErrorDialogOpen, setCopyErrorDialogOpen] = useState(false);
  const [copyErrorTitle, setCopyErrorTitle] = useState('Copy failed');
  const [copyErrorMessage, setCopyErrorMessage] = useState('');
  // "Copy to Personal" confirm dialog: lets the user opt into ALSO copying the
  // slide's .zarr analysis (segmentation + Cell-Classification). Null = closed.
  const [copyDialogItem, setCopyDialogItem] = useState<FileTreeNode | null>(null);
  const [copyIncludeZarr, setCopyIncludeZarr] = useState(false);
  const [uploadWarningDialogOpen, setUploadWarningDialogOpen] = useState(false);
  const [uploadWarningMessage, setUploadWarningMessage] = useState('');

  const refreshChunkUploadResumeHints = useCallback(() => {
    setChunkUploadResumeHints(listChunkUploadResumeHints());
  }, []);

  useEffect(() => {
    if (uploadSettings.isUploadDialogOpen) {
      refreshChunkUploadResumeHints();
    }
  }, [uploadSettings.isUploadDialogOpen, refreshChunkUploadResumeHints]);

  // Tracks whether the UploadDialog was minimized
  // the moment uploads finish. Determines two different completion behaviours:
  //   minimized=true  → close dialog silently + show toast notification
  //   minimized=false → keep dialog open in file-selection state, no toast
  const isDialogMinimizedRef = useRef(false);

  // True immediately after an upload batch completes while the center dialog is
  // visible. Drives the "Upload complete!" notice shown in the file-selection area.
  // Cleared at the start of every new upload so it only appears once per batch.
  const [uploadJustCompleted, setUploadJustCompleted] = useState(false);

  const [dialog, setDialog] = useState<
    { type: 'create-folder' | 'rename'; path?: string; } |
    { type: 'delete'; paths: string[]; label?: string } |
    { type: 'move'; paths: string[] } |
    null
  >(null);
  
  // Destination folders for the "move to" dialog. Listings are paged now, so
  // the folders in `allFetchedFiles` are only the ones on the current page —
  // ask the server for the directory's folders instead (a dirs-only listing is
  // cheap: no zarr grouping, no per-file metadata to reconcile).
  const [moveDestinations, setMoveDestinations] = useState<FileTreeNode[] | null>(null);
  const [moveDestinationsTruncated, setMoveDestinationsTruncated] = useState(false);
  const MOVE_DESTINATION_LIMIT = 500;

  // "Pre-run CellCast after upload" checkbox (in UploadDialog).
  const [preRunAnalysis, setPreRunAnalysis] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const defaultPathRef = useRef<string>('');
  // Reactive mirror of the ref above.
  //
  // The personal root arrives from an async getConfig, and the breadcrumb uses
  // it to recognise your own folder. A ref write does not re-render, so until
  // something else triggered one the breadcrumb saw personalRoot === ''.
  // Write both together.
  const [defaultPath, setDefaultPathState] = useState<string>('');
  const setDefaultPath = useCallback((value: string) => {
    defaultPathRef.current = value;
    setDefaultPathState(value);
  }, []);
  const isPersonalRootPath = (p: string | null | undefined) => {
    if (!p) return false;
    const personal = (defaultPathRef.current || '').replace(/\\/g, '/');
    return personal !== '' && (p === personal || p.startsWith(personal + '/'));
  };

  const isFetchingRef = useRef(false);
  const lastFetchedPathRef = useRef<string>('');
  /** Latest path requested while a fetch was in flight (dashboard cards / breadcrumbs). Processed in `finally`. */
  const pendingFetchPathRef = useRef<string | null>(null);
  const currentDirectoryRef = useRef<string>(currentDirectory);

  // How the displayed listing was produced.
  //
  //   'server' — a real directory: the backend filtered, grouped, sorted and
  //              sliced it, so `allFetchedFiles` IS the page and nothing here
  //              may reorder or re-slice it.
  //   'client' — something the server cannot page: search results.
  //              `allFetchedFiles` holds every row and the local
  //              filter/sort/slice pipeline runs.
  const [listingMode, setListingMode] = useState<'server' | 'client'>('client');
  const applyListingMode = useCallback((mode: 'server' | 'client') => {
    setListingMode(mode);
    // Whatever listing is being installed replaces the previous one, so the
    // search-results banner goes with it — clicking a folder in the search
    // results lands here. `runSearch` re-raises it right after it sets the mode.
    setSearchTruncated(false);
  }, []);

  /** Everything the server needs to build the page, read straight from the store. */
  const readListingQuery = useCallback(() => {
    const fm = store.getState().fileManager;
    return {
      offset: fm.pagination.offset,
      limit: fm.pagination.limit,
      sortKey: fm.sortConfig.key,
      sortDir: fm.sortConfig.direction,
      showNonImage: fm.showNonImageFiles,
    };
  }, [store]);

  /**
   * Query the displayed page was built from. `fetchFiles` stamps it after its own
   * pagination writes so the refetch effect below can tell those apart from a
   * real user action; without it every navigation fires a second request.
   */
  const lastListingQueryKeyRef = useRef<string | null>(null);
  const stampListingQuery = useCallback(() => {
    lastListingQueryKeyRef.current = listingQueryKeyOf(readListingQuery());
  }, [readListingQuery]);

  /**
   * Pages rendered a moment ago, so returning to a folder shows it at once.
   * The store is module-level on purpose: this component is remounted by the
   * very folder switch the cache exists to speed up. See `recentListings`.
   */
  const listingIdentity = useCallback(
    (path: string) => ({
      scope: localUid,
      path,
      queryKey: listingQueryKeyOf(readListingQuery()),
    }),
    [localUid, readListingQuery],
  );

  const rememberListing = (
    path: string,
    rows: FileTreeNode[],
    pagination: ListFilesPagination | null,
  ) => {
    recentListings.remember(listingIdentity(path), rows, pagination);
  };

  /** Show the remembered page for `path` if there is a fresh one. */
  const paintRememberedListing = (path: string): boolean => {
    const hit = recentListings.recall({
      ...listingIdentity(path),
      currentPath: currentDirectoryRef.current,
      // A remount destroyed the rows even though Redux still names the folder,
      // so "same folder" alone must not stop the paint.
      hasRowsOnScreen: allFetchedFilesRef.current.length > 0,
    }) as RecentListing<FileTreeNode, ListFilesPagination> | null;
    if (!hit) return false;
    rememberListedNodes(hit.rows);
    setAllFetchedFiles(hit.rows);
    dispatch(setCurrentDirectory(path));
    if (hit.pagination) publishListingPagination(hit.pagination);
    // Rows are on screen; a spinner over them would be the flicker being
    // removed here. The refetch still runs and replaces them.
    dispatch(setIsLoading(false));
    return true;
  };

  /**
   * Enter `path`: show its remembered page if there is one, otherwise drop the
   * rows we were showing.
   *
   * Redux keeps `fileTree` across the remount a folder switch performs, so
   * without this the previous folder's contents sit under the new breadcrumb
   * until the response lands. Clearing them lets the skeleton stand in, which
   * is honest about what is known. A same-folder refetch keeps its rows: they
   * are still the right ones.
   */
  const beginListing = (path: string): boolean => {
    if (paintRememberedListing(path)) return true;
    if (normalizeNavigationPath(path) !== normalizeNavigationPath(currentDirectoryRef.current)) {
      setAllFetchedFiles([]);
      dispatch(setFileTree([]));
    }
    return false;
  };

  /**
   * Nodes seen in this directory, so a selection survives paging.
   *
   * The toolbar needs full nodes (is_dir, linkedFrom) to decide what
   * Move / Delete / Copy may do, and used to resolve them from the whole
   * directory. Only one page is in memory now, so remember rows as they scroll
   * past. Cleared on every directory change.
   */
  const selectionNodeCacheRef = useRef<Map<string, FileTreeNode>>(new Map());
  const rememberListedNodes = useCallback((nodes: FileTreeNode[]) => {
    const cache = selectionNodeCacheRef.current;
    for (const node of nodes) {
      if (!node?.path || (node as { isParentLink?: boolean }).isParentLink) continue;
      cache.set(node.path, node);
    }
  }, []);

  /**
   * Drop paths a delete / move / rename just invalidated.
   *
   * A vanished row used to stop counting on its own, because selection resolved
   * against the live listing. Resolving from the cache means it would keep
   * counting — including when the operation half-failed and left the selection
   * standing. The refreshed listing re-adds whatever survived.
   */
  const forgetSelectedPaths = useCallback((paths: string[]) => {
    if (!paths.length) return;
    // These rows just changed on disk, so every remembered page is suspect —
    // leaving them would flash a deleted row on the next return trip.
    recentListings.clear();
    const gone = new Set(paths);
    for (const path of paths) selectionNodeCacheRef.current.delete(path);
    setSelectedPaths((prev) => {
      if (![...prev].some((p) => gone.has(p))) return prev;
      const next = new Set(prev);
      gone.forEach((p) => next.delete(p));
      return next;
    });
  }, []);

  // Unified permission helper based on a simple blacklist policy: public
  // read-only roots (Samples) block every mutation; everything else is the
  // local user's own tree.
  const computeFsPermissions = (currentDir: string) => {
    const inRestricted = isPublicReadOnlyPath(currentDir); // samples, data, etc.
    const inPersonalRoot = isPersonalRootPath(currentDir);

    const canCreate = !inRestricted;
    const canUpload = !inRestricted;
    const canMoveTo = (dest: string) => !isWriteBlockedPath(dest);
    const canDropToCurrent = !inRestricted;
    const isContextDisabledForItem = (itemPath: string) =>
      isWriteBlockedPath(itemPath) || inRestricted;

    return {
      inPersonalRoot,
      canCreate,
      canUpload,
      canMoveTo,
      canDropToCurrent,
      isContextDisabledForItem,
    };
  };

  useEffect(() => {
    currentDirectoryRef.current = currentDirectory;
  }, [currentDirectory]);


  /**
   * Ask the server for the page the store currently describes.
   *
   * Only one page crosses the wire — pulling a whole directory down to compute
   * ten rows was what made a folder full of slides take seconds to open. The
   * stamp records what we asked for, so the query-watcher effect below does not
   * read our own `resetPagination` as a user action and fire a duplicate.
   */
  const requestListingPage = async (path: string) => {
    applyListingMode('server');
    stampListingQuery();
    const query = readListingQuery();
    const page = await listFilesPage(path, query.offset, query.limit, {
      sortBy: query.sortKey,
      sortDir: query.sortDir,
      includeNonImage: query.showNonImage,
      groupZarr: true,
    });
    return { page, requestedKey: listingQueryKeyOf(query) };
  };

  /**
   * Publish what the server actually returned. `offset` comes back clamped when
   * the directory shrank under a stale page, and the re-stamp keeps the watcher
   * from treating that correction as a user action.
   */
  const publishListingPagination = (pagination: ListFilesPagination) => {
    dispatch(setPagination({
      offset: pagination.offset,
      limit: pagination.limit,
      total: pagination.total,
      hasMore: pagination.has_more,
    }));
    stampListingQuery();
  };

  /** True if this response may still be written — path AND query both current. */
  const canApplyResponse = (completedPath: string, requestedKey: string) =>
    shouldApplyListingResponse({
      pendingPath: pendingFetchPathRef.current,
      completedPath,
      requestedKey,
      currentKey: listingQueryKeyOf(readListingQuery()),
    });

  const fetchFiles = useCallback(async (path: string, depth = 0) => {
    const normalizedRequestPath = normalizeNavigationPath(path);

    if (isFetchingRef.current) {
      pendingFetchPathRef.current = normalizedRequestPath;
      return;
    }

    isFetchingRef.current = true;
    lastFetchedPathRef.current = path;

    dispatch(setIsLoading(true));
    dispatch(setError(null));
    try {
      // prevent empty-path requests from frontend
      let effectivePath = (path || '').trim();
      if (!effectivePath) {
        effectivePath = defaultPathRef.current;
        if (!effectivePath) {
          try {
            const cfg = await getConfig();
            effectivePath = (cfg?.defaultPath || '').replace(/\\/g, '/');
            setDefaultPath(effectivePath);
          } catch (e) {
            effectivePath = '';
          }
        }
      }
      
      // Reset pagination when navigating to a new directory
      const previousDirectory = currentDirectoryRef.current;
      const shouldResetPagination = previousDirectory !== effectivePath;
      if (shouldResetPagination) {
        dispatch(resetPagination());
      }

      applyListingMode('server');
      beginListing(effectivePath);
      const { page, requestedKey: requestedQueryKey } = await requestListingPage(effectivePath);

      const sortedFiles: FileItem[] = page.items;

      let treeNodes: FileTreeNode[] = sortedFiles.map(file => ({
        ...file,
        depth,
        children: file.is_dir ? [] : undefined, // Folders have children array
        source: 'web' as const,
      }));

      if (effectivePath) {
        // Workspace roots (Personal / Samples) have no parent link — the
        // dashboard cards switch between them.
        const personalRoot = defaultPathRef.current || '';
        let parentPath = '';
        if (effectivePath !== personalRoot && effectivePath !== 'samples') {
          parentPath = effectivePath.includes('/') ? effectivePath.substring(0, effectivePath.lastIndexOf('/')) : '';
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
        if (parentPath) {
          treeNodes.unshift(upNode);
        }
      }

      // No client-side grouping: the server already folded each .zarr store
      // into its WSI row. Doing it here would only see one page, so a slide on
      // page 1 and its store on page 2 would surface the store as its own row.

      if (canApplyResponse(effectivePath, requestedQueryKey)) {
        if (previousDirectory !== effectivePath) selectionNodeCacheRef.current.clear();
        rememberListedNodes(treeNodes);
        setAllFetchedFiles(treeNodes);
        dispatch(setCurrentDirectory(effectivePath));
        // Totals come from the server, which counted AFTER filtering and
        // grouping — the same rows the pager walks.
        publishListingPagination(page.pagination);
        // After the publish, never before: the server echoes the page size it
        // actually used, and for "All" that is `null` where the request said 0.
        // Keyed on the requested value, the entry could never be found again.
        rememberListing(effectivePath, treeNodes, page.pagination);
      }
    } catch (err: any) {
      if (!pendingFetchPathRef.current) {
        dispatch(setError(getErrorMessage(err, 'Failed to fetch files')));
        dispatch(setFileTree([]));
        setAllFetchedFiles([]);
      }
    } finally {
      isFetchingRef.current = false;
      dispatch(setIsLoading(false));
      const pendingNav = pendingFetchPathRef.current;
      pendingFetchPathRef.current = null;
      if (pendingNav) {
        queueMicrotask(() => {
          void fetchFiles(pendingNav);
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, store, applyListingMode, stampListingQuery, readListingQuery, rememberListedNodes]);

  // Dashboard `StorageFolderCards` updates `initialPath` when switching Personal / Samples.
  //
  // The prop-watcher is the single source of truth for "what path to show"
  // now that cards drive selection. It fires once per distinct non-empty
  // prop value; overlapping calls with the same value are idempotent.
  const prevInitialPathPropRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (initialPathProp === undefined) return;
    const next = (initialPathProp || '').trim();
    if (!next) {
      prevInitialPathPropRef.current = '__pending__';
      return;
    }
    if (prevInitialPathPropRef.current === next) return;
    prevInitialPathPropRef.current = next;
    void fetchFiles(next);
  }, [initialPathProp, fetchFiles]);

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

  // Client-paged listings only (search results).
  // Filtering + sorting run over the WHOLE set, so memoize them: paging and
  // page-size changes then only re-slice instead of redoing the work. A
  // server-paged directory skips this entirely — the rows already are the page.
  const { parentLinks, sortedFiles } = React.useMemo(() => {
    const links = allFetchedFiles.filter(file => (file as any).isParentLink);
    if (listingMode === 'server') {
      return {
        parentLinks: links,
        sortedFiles: allFetchedFiles.filter(file => !(file as any).isParentLink),
      };
    }
    const navigableFiles = allFetchedFiles.filter(file => !(file as any).isParentLink);
    // Filter the actual directory contents based on showNonImageFiles.
    // Keep the synthetic parent link out of totals and pagination.
    const filteredFiles = filterVisibleFiles(navigableFiles);
    // Sort the full filtered set before slicing so switching pages keeps the
    // global ordering (previously sort ran only on the current page rows).
    return { parentLinks: links, sortedFiles: sortFileTreeData(filteredFiles, sortConfig) };
  }, [allFetchedFiles, filterVisibleFiles, sortConfig, listingMode]);

  // Server-paged: the fetch already wrote the pagination block, so just render
  // the rows it returned. Re-slicing here would page a page.
  useEffect(() => {
    if (listingMode !== 'server') return;
    dispatch(setFileTree(allFetchedFiles));
  }, [listingMode, allFetchedFiles, dispatch]);

  /**
   * Anything the server needs to rebuild the page — page offset, page size,
   * sort column/direction, the non-image filter — now requires a round trip.
   * `lastListingQueryKeyRef` is stamped by `fetchFiles` after its own
   * pagination writes, so only a genuine user action gets through here.
   */
  const listingQueryKey = `${paginationState.offset}|${paginationState.limit}|${sortConfig.key}|${sortConfig.direction}|${showNonImageFiles}`;
  useEffect(() => {
    if (listingMode !== 'server') return;
    if (lastListingQueryKeyRef.current === listingQueryKey) return;
    // While a navigation is in flight, `currentDirectory` still names the folder
    // being left. Targeting it here would queue a refetch of the OLD folder and
    // make the in-flight response look superseded by a different path, throwing
    // away the navigation the user actually asked for.
    const dir = listingRefetchTarget(
      isFetchingRef.current,
      lastFetchedPathRef.current,
      currentDirectoryRef.current,
    );
    // Stamp only once the query is actually being applied — bailing after the
    // stamp would record it as handled and never fetch it.
    if (!dir) return;
    lastListingQueryKeyRef.current = listingQueryKey;
    // `fetchFiles` queues onto the in-flight request when one is running.
    void fetchFiles(dir);
  }, [listingMode, listingQueryKey, fetchFiles]);

  // Load every folder of the current directory when the move dialog opens.
  useEffect(() => {
    if (dialog?.type !== 'move') {
      setMoveDestinations(null);
      setMoveDestinationsTruncated(false);
      return;
    }
    const dir = currentDirectoryRef.current;
    if (!dir) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await listFilesPage(dir, 0, MOVE_DESTINATION_LIMIT, { dirsOnly: true, sortBy: 'name', sortDir: 'asc' });
        if (cancelled) return;
        setMoveDestinations(page.items.map((item: any) => ({ ...item, depth: 0, source: 'web' as const })));
        setMoveDestinationsTruncated(!!page.pagination.has_more);
      } catch {
        // Keep the current-page fallback rather than emptying the dialog.
      }
    })();
    return () => { cancelled = true; };
  }, [dialog]);

  // Client-paged: apply pagination to the memoized set and update fileTree
  useEffect(() => {
    if (listingMode === 'server') return;
    if (allFetchedFiles.length === 0) {
      dispatch(setFileTree([]));
      dispatch(setPagination({
        offset: 0,
        limit: paginationState.limit,
        total: 0,
        hasMore: false,
      }));
      return;
    }

    const filteredTotal = sortedFiles.length;

    // Get current pagination state
    const currentPaginationState = store.getState().fileManager.pagination;
    const offset = currentPaginationState.offset;
    const limit = currentPaginationState.limit;

    if (limit === null) {
      // Show all filtered files if limit is null, plus the synthetic parent link.
      dispatch(setFileTree([...parentLinks, ...sortedFiles]));
      dispatch(setPagination({
        offset: 0,
        limit: null,
        total: filteredTotal,
        hasMore: false,
      }));
    } else {
      // Apply pagination to filtered files
      // Bugfix: clamp offset when the filtered total shrinks (e.g. search/filter/delete)
      // so we don't render an empty page.
      const maxOffset = filteredTotal > 0 ? Math.floor((filteredTotal - 1) / limit) * limit : 0;
      const safeOffset = Math.min(Math.max(0, offset), maxOffset);

      const startIndex = safeOffset;
      const endIndex = Math.min(sortedFiles.length, safeOffset + limit);
      const paginatedFiles = sortedFiles.slice(startIndex, endIndex);
      dispatch(setFileTree([...parentLinks, ...paginatedFiles]));

      // Update pagination metadata based on filtered files
      dispatch(setPagination({
        offset: safeOffset,
        limit,
        total: filteredTotal,
        hasMore: endIndex < sortedFiles.length,
      }));
    }
  }, [listingMode, allFetchedFiles, parentLinks, sortedFiles, dispatch, store, paginationState.offset, paginationState.limit]);

  // Helper function to recursively find and update a node in the tree
  const requestSort = (key: 'name' | 'mtime' | 'size' | 'type') => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    dispatch(setSortConfig({ key, direction } as SortConfig));
    // Keep page 1 so a new global order is visible from the start.
    dispatch(setPagination({ offset: 0 }));
  };


  useEffect(() => {
    // Load the last visited directory or defaultPath on mount.
    const initialize = async () => {
        try {
            if (!defaultPathRef.current) {
              const cfg = await getConfig();
              setDefaultPath((cfg?.defaultPath || '').replace(/\\/g, '/'));
            }
            // Fetch initial quota
            triggerStorageRefresh();
            
            // Prop-watcher (see useEffect above) is the SINGLE owner of
            // fetching whenever `initialPathProp` is wired (dashboard case).
            // Initialize only fetches when no prop is given (standalone
            // mounts in Image Viewer etc). The previous double-path —
            // initialize + prop-watcher both firing — let stale closures
            // race: when fetchFiles' useCallback ref recomputed, this
            // effect re-ran with a STALE `initialPathProp` ("samples"
            // captured at the anon-phase mount) while the prop-watcher
            // had already moved on to "users/<uid>", and the late samples
            // fetch overwrote the right one.
            // Dashboard cards always supply `initialPathProp`; the prop
            // watcher does the actual fetch. If no prop is supplied (no
            // standalone usage in the app today) we simply render whatever
            // the caller's currentDirectory already points at.
            if (initialPathProp !== undefined) return;
            if (currentDirectory) await fetchFiles(currentDirectory);
        } catch (err: any) {
            // Only show error in web browser mode, not in local Electron mode
            const isElectron = typeof window !== 'undefined' && !!(window as any).electron && typeof (window as any).electron.invoke === 'function';
            if (!isElectron) {
                dispatch(setError("Failed to load server configuration. Please check the backend connection."));
            }
        }
    };
    initialize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerStorageRefresh, fetchFiles]);

  // Listen to LocalFileManager upload-complete / pre-run-complete to refresh list + quota
  useEffect(() => {
    const onUploadCompleted = (e: any) => {
      const nextPath = e?.detail?.path || currentDirectoryRef.current;
      if (!nextPath) return;
      recentListings.clear();
      fetchFiles(nextPath);
      triggerStorageRefresh();
    };
    // Prefer the folder the user is viewing — event may carry a file or another folder.
    const onPreRunCompleted = () => {
      const dir = currentDirectoryRef.current;
      if (!dir) return;
      recentListings.clear();
      // Pre-run wrote analysis groups. The badge cells listen for this event
      // themselves — the row keeps its key, so refreshing the listing alone
      // would leave them showing what they read before the run.
      void fetchFiles(dir);
      triggerStorageRefresh();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('tissuelab:cloudUploadCompleted', onUploadCompleted);
      window.addEventListener('tissuelab:preRunCompleted', onPreRunCompleted);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('tissuelab:cloudUploadCompleted', onUploadCompleted);
        window.removeEventListener('tissuelab:preRunCompleted', onPreRunCompleted);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerStorageRefresh, fetchFiles]);

  // Refresh quota after uploads complete
  useEffect(() => {
    if (!uploadSettings?.isUploading) {
      triggerStorageRefresh();
    }
  }, [uploadSettings?.isUploading, triggerStorageRefresh]);

  const getConversionErrorMessage = useCallback((err: any, fallback: string) => {
    return getErrorMessage(err, fallback);
  }, []);

  const isStorageQuotaErrorCallback = useCallback((error: unknown) => isStorageQuotaError(error), []);

  const openUploadQuotaWarning = useCallback((error?: unknown, incomingBytes?: number) => {
    const message = getErrorMessage(
      error,
      'This upload would exceed the user storage limit. Please free up space before trying again.'
    );
    setUploadWarningMessage(message);
    setUploadWarningDialogOpen(true);
  }, []);

  const resolveUploadTargetPath = useCallback(async () => {
    const current = (currentDirectory || '').trim();
    if (current) return current;

    const cachedDefault = (defaultPathRef.current || '').trim();
    if (cachedDefault) return cachedDefault;

    const cfg = await getConfig();
    const resolved = (cfg?.defaultPath || '').replace(/\\/g, '/').trim();
    if (resolved) setDefaultPath(resolved);
    return resolved;
  }, [currentDirectory]);

  useEffect(() => {
    if (dialog?.type === 'create-folder' || dialog?.type === 'rename') {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [dialog]);

  // Poll conversion job status
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
                toast.error(updated.error ?? 'Conversion failed');
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

  const handleFolderSelect = async () => {
    // This function is now only for creating a new root selection, which is not applicable
    // in the web-style architecture. Could be re-purposed for other uploads later.
    alert("The file manager is now operating in a secure web-based mode. The root directory is fixed on the server.");
  };

  // Every keystroke used to fire a full recursive server-side walk. Debounce
  // the request and stamp it, so only the newest one is allowed to write
  // results — a slow early query can no longer land on top of a later one.
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);
  const SEARCH_DEBOUNCE_MS = 300;

  const runSearch = async (query: string, seq: number) => {
    dispatch(setIsLoading(true));
    try {
      // Scope the search to where the user currently is. Otherwise search
      // always runs against their personal root + samples and ignores the
      // subtree they're actually browsing.
      const scope = currentDirectory || undefined;
      const { items: results, truncated } = await apiSearchFiles(query, scope);
      if (seq !== searchSeqRef.current) return; // superseded by a newer query

      // Render as a flat filter inside the current scope — no tree,
      // no parent-directory chain. The name check is belt-and-braces; the
      // backend no longer pads results with parent directories.
      const q = query.trim().toLowerCase();
      const matched = (results || []).filter(
        (r) => !!r?.name && r.name.toLowerCase().includes(q)
      );
      const flatNodes: FileTreeNode[] = matched.map((file) => ({
        ...file,
        depth: 0,
        children: undefined,
        source: 'web' as const,
      }));
      // Search spans directories, so the listing endpoint cannot page it —
      // run the local filter/sort/paginate pipeline over the full result set.
      applyListingMode('client');
      setSearchTruncated(truncated);
      rememberListedNodes(flatNodes);
      setAllFetchedFiles(flatNodes);
      dispatch(resetPagination());
    } catch (err: any) {
      if (seq !== searchSeqRef.current) return;
      setSearchTruncated(false);
      dispatch(setError(getErrorMessage(err, 'Failed to search files')));
      setAllFetchedFiles([]);
      dispatch(setFileTree([]));
    } finally {
      if (seq === searchSeqRef.current) dispatch(setIsLoading(false));
    }
  };

  const handleSearch = (query: string) => {
    dispatch(setSearchTerm(query));
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    searchSeqRef.current += 1;
    setSearchTruncated(false);
    if (!query) {
      fetchFiles(currentDirectory); // Or clear and show root
      return;
    }
    const seq = searchSeqRef.current;
    searchDebounceRef.current = setTimeout(() => {
      searchDebounceRef.current = null;
      void runSearch(query, seq);
    }, SEARCH_DEBOUNCE_MS);
  };

  useEffect(() => () => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
  }, []);

  // Helper function to find corresponding WSI file for a Zarr file
  const findCorrespondingWSI = (zarrItem: FileTreeNode): FileTreeNode | undefined => {
    const zarrBaseName = getWSIBaseName(zarrItem.name);
    const parentDir = zarrItem.path.substring(0, zarrItem.path.lastIndexOf('/'));
    
    return fileTree.find(file =>
      !file.is_dir &&
      isWSI(file.name) &&
      file.name.startsWith(zarrBaseName) &&
      file.path.startsWith(parentDir)
    );
  };

  // Visible row order for Shift+range select (flat current-directory listing).
  const getVisibleOrderedPaths = useCallback((): string[] => {
    const paths: string[] = [];
    // Must be the order actually on screen, so read `fileTree` as-is rather
    // than re-deriving it — a Shift+range select that disagreed with the
    // rendered order would select the wrong rows.
    for (const item of fileTree) {
      // @ts-ignore
      if (item.isParentLink) continue;
      if (
        !showNonImageFiles &&
        !item.is_dir &&
        !isWSI(item.name) &&
        !isZarr(item.name) &&
        !isH5Convertible(item.name)
      ) {
        continue;
      }
      paths.push(item.path);
    }
    return paths;
  }, [fileTree, showNonImageFiles]);

  const openOrEnterItem = (item: FileTreeNode) => {
    // @ts-ignore
    if (item.isParentLink) {
      const target = item.path;
      if (!target) return;
      fetchFiles(target);
      return;
    }

    if (item.is_dir && !isZarr(item.name)) {
      fetchFiles(item.path);
    } else if (isWSI(item.name)) {
      handleWsiUpload(item.path);
    } else if (isZarrZip(item.name)) {
      toast.warning('Please extract the zip file first before opening the zarr data.');
    } else if (isZarr(item.name)) {
      const wsiFile = findCorrespondingWSI(item);
      if (wsiFile) {
        handleWsiUpload(wsiFile.path);
      } else {
        console.log("No corresponding WSI file found for Zarr file:", item.path);
      }
    } else {
      console.log("Opening non-WSI file:", item.path);
    }
  };

  const handleItemClick = (item: FileTreeNode, e: React.MouseEvent) => {
    // @ts-ignore
    if (item.isParentLink) {
      // Always navigate on parent link — selection doesn't apply.
      openOrEnterItem(item);
      return;
    }

    // Don't let the list background treat this as a blank click.
    e.stopPropagation();

    // Normal browsing: single click opens / enters (like LocalFileManager).
    if (!isMultiSelectMode) {
      openOrEnterItem(item);
      return;
    }

    // Multi-select mode: tap toggles; Shift ranges; Ctrl/Cmd toggles without clearing.
    if (e.shiftKey && selectionAnchorRef.current) {
      const ordered = getVisibleOrderedPaths();
      const a = ordered.indexOf(selectionAnchorRef.current);
      const b = ordered.indexOf(item.path);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = ordered.slice(lo, hi + 1);
        if (e.ctrlKey || e.metaKey) {
          setSelectedPaths((prev) => {
            const next = new Set(prev);
            range.forEach((p) => next.add(p));
            return next;
          });
        } else {
          setSelectedPaths(new Set(range));
        }
        return; // keep original anchor
      }
    }

    if (e.ctrlKey || e.metaKey) {
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(item.path)) next.delete(item.path);
        else next.add(item.path);
        return next;
      });
      selectionAnchorRef.current = item.path;
    } else {
      // iOS-style: plain tap toggles membership (does not replace the set).
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(item.path)) next.delete(item.path);
        else next.add(item.path);
        return next;
      });
      selectionAnchorRef.current = item.path;
    }
  };

  const handleWsiUpload = async (relativePath: string) => {
    dispatch(setWsiOpening(true)); // full-screen loading cover until the viewer renders
    try {
      console.log('FileManager: Starting WSI upload for:', relativePath);

      // Step 1: Upload file path
      const uploadData = await uploadFilePath(relativePath);
      console.log('FileManager: uploadData:', uploadData);
      
      // Step 2: Create instance (this is the missing step!)
      const instanceData = await createInstance(uploadData.filePath ?? uploadData.fileName);
      console.log('FileManager: instanceData:', instanceData);
      
      // Step 3: Load file data
      const loadData = await loadFileData(uploadData.fileName);
      console.log('FileManager: loadData:', loadData);
      
      // Step 4: Set slide metadata in Redux (path lives on the WSI instance)
      dispatch(updateInstanceWSIInfo(loadData));
      dispatch(setOutputPath(relativePath ? relativePath + '.zarr' : ''));
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
          fileName: relativePath.split(/[\\/]/).pop() || '',
          filePath: relativePath,
          source: 'web',
        }
      }));
      
      console.log('FileManager: Instance created successfully with ID:', instanceData.instanceId);
      
      // Update multi-window state to ensure proper highlighting
      dispatch(setCurrentImagePath(relativePath));

      // Sync sidebar folder to the parent of the opened image so left folder list is correct on enter (no need to click refresh)
      const sep = '/';
      const lastSep = relativePath.lastIndexOf(sep);
      const parentDir = lastSep !== -1 ? relativePath.substring(0, lastSep) : '';
      dispatch(setSelectedFolder(parentDir));

      dispatch(setImageLoaded(true));
      router.push('/imageViewer');
    } catch(err) {
        console.error("Error processing WSI file:", err);
        dispatch(setWsiOpening(false)); // lift the cover so the error is visible
        dispatch(setError(getErrorMessage(err, 'Failed to load WSI file.')));
    }
  }

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
      toast.error(getConversionErrorMessage(err, 'Failed to start conversion task.'));
      setConversionJobs(prev => {
        const next = { ...prev };
        delete next[item.path];
        return next;
      });
    }
  };



  const getAllImageFiles = useCallback(() => {
    return getAllImageFilesUtil(fileTree, true); // WebFileManager includes Zarr in image table
  }, [fileTree]);

  const renderImageTable = () => {
    const imageFiles = getAllImageFiles();
    
    if (imageFiles.length === 0) {
      return (
        <div className="py-8 text-center text-muted-foreground">
          No image files found in the current directory.
        </div>
      );
    }

    return (
      <div className="w-full px-6">
        {/* Header */}
        <div 
          className="grid gap-2 border-b p-3 text-sm font-medium text-muted-foreground"
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
        <div className="divide-y divide-border">
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
                className="grid min-h-[120px] items-center gap-2 border-b p-3 hover:bg-primary/10"
                style={{ gridTemplateColumns: '0.5fr 2fr 1.8fr 1.2fr 2fr 1.2fr' }}
              >
                {/* Row Number */}
                <div className="text-center text-sm font-medium text-muted-foreground">
                  {index + 1}
                </div>

                {/* Filename */}
                <div className="flex flex-col justify-center min-h-[80px] pr-2">
                  <button
                    className="text-left text-sm font-medium leading-tight text-primary hover:underline"
                    onClick={() => {
                      if (file.isZarr) {
                        // For Zarr files, try to find and open the corresponding WSI file
                        const zarrBaseName = getWSIBaseName(file.name);
                        const parentDir = file.path.substring(0, file.path.lastIndexOf('/'));
                        // Try to find the corresponding WSI file in the same directory
                        const wsiFile = fileTree.find(treeFile => 
                          !treeFile.is_dir && 
                          isWSI(treeFile.name) && 
                          treeFile.name.startsWith(zarrBaseName) &&
                          treeFile.path.startsWith(parentDir)
                        );
                        if (wsiFile) {
                          handleWsiUpload(wsiFile.path);
                        } else {
                          console.log("No corresponding WSI file found for Zarr file:", file.path);
                          toast.warning("No corresponding WSI file found for this Zarr file");
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
                  {!file.isZarr && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Size: {formatBytes(file.size)}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Modified: {new Date(file.mtime * 1000).toLocaleDateString()}
                  </div>
                </div>

                {/* Thumbnail */}
                <div className="flex justify-center">
                  <div className="aspect-[4/3] w-full max-w-[140px] rounded border border-border/50 bg-card shadow-sm">
                    {file.isZarr ? (
                      <div className="flex h-full w-full items-center justify-center bg-accent/10">
                        <div className="text-center">
                          <File className="mx-auto mb-1 h-8 w-8 text-accent-foreground" />
                          <div className="text-xs text-accent-foreground">Zarr File</div>
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
                  <div className="aspect-[4/3] w-full max-w-[100px] rounded border border-border/50 bg-card shadow-sm">
                    {file.isZarr ? (
                      <div className="flex h-full w-full items-center justify-center bg-accent/10">
                        <div className="text-center">
                          <File className="mx-auto mb-1 h-6 w-6 text-accent-foreground" />
                          <div className="text-xs text-accent-foreground">Zarr</div>
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
                  <div className="aspect-[4/3] w-full max-w-[160px] rounded border border-border/50 bg-card shadow-sm">
                    {file.isZarr ? (
                      <div className="flex h-full w-full items-center justify-center bg-accent/10">
                        <div className="text-center">
                          <File className="mx-auto mb-1 h-6 w-6 text-accent-foreground" />
                          <div className="text-xs text-accent-foreground">Zarr</div>
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
                <div className="flex justify-center gap-2">
                  {isH5Convertible(file.name) && (() => {
                    const fileNode = fileTree.find(treeFile => treeFile.path === file.path);
                    const conversionJob = fileNode ? conversionJobs[fileNode.path] : null;
                    const isConverting = conversionJob && (conversionJob.status === 'pending' || conversionJob.status === 'running');
                    return (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        disabled={!!isConverting}
                        onClick={() => {
                          if (fileNode) {
                            handleConvertToZarr(fileNode);
                          }
                        }}
                      >
                        {isConverting ? 'Converting...' : 'Convert to Zarr'}
                      </Button>
                    );
                  })()}
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => {
                      if (file.isZarr) {
                        // For Zarr files, try to find and open the corresponding WSI file
                        const zarrBaseName = getWSIBaseName(file.name);
                        const parentDir = file.path.substring(0, file.path.lastIndexOf('/'));
                        // Try to find the corresponding WSI file in the same directory
                        const wsiFile = fileTree.find(treeFile => 
                          !treeFile.is_dir && 
                          isWSI(treeFile.name) && 
                          treeFile.name.startsWith(zarrBaseName) &&
                          treeFile.path.startsWith(parentDir)
                        );
                        if (wsiFile) {
                          handleWsiUpload(wsiFile.path);
                        } else {
                          console.log("No corresponding WSI file found for Zarr file:", file.path);
                          toast.warning("No corresponding WSI file found for this Zarr file");
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
    // Personal / Samples workspace roots — never go up to a virtual root
    // (the dashboard cards switch workspaces).
    const personalRoot = defaultPathRef.current || '';
    if (!currentDirectory || currentDirectory === personalRoot || currentDirectory === 'samples') {
      return;
    }
    const parentPath = currentDirectory.includes('/') ? currentDirectory.substring(0, currentDirectory.lastIndexOf('/')) : '';
    if (!parentPath) {
      return;
    }
    fetchFiles(parentPath);
  };

  // --- Drag and Drop Handlers ---
  const handleDragStart = (e: React.DragEvent, itemPath: string) => {
    // Dragging a row that is part of the selection drags the whole selection;
    // dragging anything else drags just that row. Same rule as Google Drive.
    setDraggingPaths(selectedPaths.has(itemPath) ? Array.from(selectedPaths) : [itemPath]);
    setDragOverTarget(null); // Clear any previous drag over target
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    setDraggingPaths([]);
    setDragOverTarget(null);
  };

  const handleDragOver = (e: React.DragEvent, targetPath?: string) => {
    e.preventDefault(); // Necessary to allow dropping
    e.dataTransfer.dropEffect = 'move';
    if (targetPath !== undefined && draggingPaths.length > 0) {
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

  /**
   * A move that can be reversed: where each item ended up, and where it came from.
   * `name` is the basename, so the post-move path is `${destination}/${name}`.
   */
  type MovedItem = { name: string; from: string };

  const undoMove = async (moved: MovedItem[], destinationPath: string) => {
    const toastKey = `move_undo_${Date.now()}`;
    toast.loading(moved.length === 1 ? 'Moving back…' : `Moving ${moved.length} items back…`,
      { id: toastKey, duration: Infinity });
    let restored = 0;
    const failures: string[] = [];
    for (const item of moved) {
      const movedPath = destinationPath ? `${destinationPath}/${item.name}` : item.name;
      try {
        await apiMoveFiles([movedPath], item.from);
        restored += 1;
      } catch (err: any) {
        failures.push(`${item.name}: ${getErrorMessage(err, 'failed')}`);
      }
    }
    if (failures.length === 0) {
      toast.success(restored === 1 ? 'Move undone' : `${restored} items moved back`,
        { id: toastKey, duration: 3000 });
    } else {
      toast.error(
        restored === 0
          ? (failures.length === 1 ? `Could not undo — ${failures[0]}` : 'Could not undo the move')
          : `Moved ${restored} back, ${failures.length} failed`,
        { id: toastKey, duration: 5000 },
      );
    }
    // Whatever folder the user is on now — the undo may have refilled it.
    await fetchFiles(currentDirectoryRef.current);
    triggerStorageRefresh();
  };

  /**
   * Success toast for a move, carrying an Undo action.
   *
   * A drag is easy to trigger by accident — a slightly-long click drops a slide
   * into whichever folder the pointer passed over — and the move is otherwise
   * silent and irreversible. Drive offers the same escape hatch on the same
   * gesture; its forums are full of people who missed the window, so keep it long.
   */
  const toastMoveWithUndo = (
    toastKey: string,
    message: string,
    moved: MovedItem[],
    destinationPath: string,
    kind: 'success' | 'warning' = 'success',
  ) => {
    const options = {
      id: toastKey,
      duration: 10000,
      ...(moved.length > 0
        ? { action: { label: 'Undo', onClick: () => { void undoMove(moved, destinationPath); } } }
        : {}),
    };
    if (kind === 'warning') toast.warning(message, options);
    else toast.success(message, options);
  };

  /**
   * Move `paths` into `destinationPath`, one at a time, behind a single toast.
   *
   * The three ways to move — destination picker, drag onto a folder row, drag
   * onto the list background — differ only in how they pick the destination.
   * Everything after that is this.
   */
  const performMove = async (paths: string[], destinationPath: string, toastKey: string) => {
    const total = paths.length;
    const movedItems: MovedItem[] = [];
    const failures: string[] = [];

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const name = path.split('/').pop() || path;
      toast.loading(
        total === 1 ? `Moving “${name}”…` : `Moving ${i + 1}/${total}: “${name}”…`,
        { id: toastKey, duration: Infinity },
      );
      try {
        await apiMoveFiles([path], destinationPath);
        movedItems.push({
          name,
          from: path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '',
        });
        // Gone from this folder — drop it before the listing refreshes.
        forgetSelectedPaths([path]);
      } catch (err: any) {
        failures.push(`${name}: ${getErrorMessage(err, 'failed')}`);
      }
    }

    if (failures.length === 0) {
      toastMoveWithUndo(
        toastKey,
        total === 1 ? `Moved “${movedItems[0]?.name ?? ''}”` : `Moved ${movedItems.length} items`,
        movedItems,
        destinationPath,
      );
    } else if (movedItems.length === 0) {
      toast.error(
        failures.length === 1 ? failures[0] : `Failed to move ${failures.length} items`,
        { id: toastKey, duration: 5000 },
      );
    } else {
      // Undo covers the ones that made it; the rest never left.
      toastMoveWithUndo(
        toastKey,
        `Moved ${movedItems.length}/${total}. ${failures.length} failed.`,
        movedItems,
        destinationPath,
        'warning',
      );
    }

    // Refresh whatever folder the user is viewing now (avoid overwriting with a stale path).
    await fetchFiles(currentDirectoryRef.current);
    triggerStorageRefresh();
  };

  /** Paths that may legally move into `destinationPath`, with the rest explained. */
  const movablePathsInto = (paths: string[], destinationPath: string): string[] => {
    // A .zarr store is a directory on disk but one opaque file everywhere else,
    // so dropping onto one is a non-event — exactly like dropping onto a slide.
    // Silent for that reason. No row offers it as a target and the server
    // refuses it outright; this is the last of the three gates.
    if (destinationPath.split('/').some((part) => isZarrDir(part))) return [];
    const { canMoveTo } = computeFsPermissions(currentDirectory);
    if (!canMoveTo(destinationPath)) {
      // Say so. A drag that silently does nothing reads as the app being broken.
      toast.warning('Cannot move items to that location.');
      return [];
    }
    const movable: string[] = [];
    let intoItself = false;
    let alreadyThere = false;
    for (const path of paths) {
      if (destinationPath === path || destinationPath.startsWith(path + '/')) {
        intoItself = true;
        continue;
      }
      const sourceParent = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
      if (sourceParent === destinationPath) {
        alreadyThere = true;
        continue;
      }
      movable.push(path);
    }
    if (movable.length === 0) {
      if (intoItself) toast.error('Cannot move a folder into itself.');
      else if (alreadyThere) toast.info('Items are already in that folder.');
    }
    return movable;
  };

  const handleDrop = async (e: React.DragEvent, targetFolder: FileTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    const dragged = draggingPaths;
    setDraggingPaths([]);
    setDragOverTarget(null);
    if (dragged.length === 0 || !targetFolder.is_dir || isZarr(targetFolder.name)) return;

    const movable = movablePathsInto(dragged, targetFolder.path);
    if (movable.length === 0) return;
    await performMove(movable, targetFolder.path, `move_dnd_${Date.now()}`);
  };

  const handleDropOnCurrentDirectory = async (e: React.DragEvent) => {
    e.preventDefault();
    const dragged = draggingPaths;
    setDraggingPaths([]);
    setDragOverTarget(null);
    // A drop with nothing being dragged (an OS file landing on the list) is not
    // a rejected move and must not raise a warning.
    if (dragged.length === 0) return;

    // Every row in a normal listing already lives here, so releasing a drag over
    // empty space is a non-action — stay silent. Rows whose parent differs do
    // exist (search results) and those are a real move.
    const fromElsewhere = dragged.filter((path) => {
      const parent = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
      return parent !== currentDirectory;
    });
    if (fromElsewhere.length === 0) return;

    const { canDropToCurrent } = computeFsPermissions(currentDirectory);
    if (!canDropToCurrent) {
      toast.warning('Cannot move items to that location.');
      return;
    }
    const movable = movablePathsInto(fromElsewhere, currentDirectory);
    if (movable.length === 0) return;
    await performMove(movable, currentDirectory, `move_dnd_${Date.now()}`);
  };


  // --- File Upload Handler ---
  const handleFileUpload = async (
    files: FileList | File[] | null,
    relativePathsOrForce?: string[] | boolean,
    forceOverwriteParam?: boolean
  ) => {
    const forceOverwrite = typeof relativePathsOrForce === 'boolean' ? relativePathsOrForce : (forceOverwriteParam ?? false);
    const relativePaths = typeof relativePathsOrForce === 'object' && Array.isArray(relativePathsOrForce) ? relativePathsOrForce : undefined;
    if (!files || files.length === 0) return;
    const { canUpload } = computeFsPermissions(currentDirectory);
    if (denyWriteToast('upload files', currentDirectory)) {
      return;
    }
    if (!canUpload) {
      return;
    }

    if (
      uploadSettings.isUploading
      || hasActiveUploadStatuses(uploadStatusRef.current)
    ) {
      toast.warning('An upload is already in progress. Wait for it to finish or cancel it first.');
      return;
    }

    dispatch(setUploadSettings({ isUploading: true }));
    let uploadUnitsInitialized = false;
    const stopPreflightUpload = () => {
      if (!uploadUnitsInitialized) {
        dispatch(setUploadSettings({ isUploading: false }));
      }
    };

    try {
    // Clear the "just completed" banner whenever a new upload batch starts.
    setUploadJustCompleted(false);
    refreshChunkUploadResumeHints();

    uploadQuotaErrorRef.current = null;

    const preflight = await runUploadPreflight({
      files,
      relativePaths,
      forceOverwrite,
      resolveUploadTargetPath,
      listExistingNames: async (targetPath) =>
        parseListingToNames(await apiListFiles(targetPath, 0, undefined)),
      onQuotaExceeded: (totalBytes) => {
        openUploadQuotaWarning(new Error('You have exceeded your storage quota.'), totalBytes);
      },
      promptConflict: async ({ conflictDesc, existingFiles, validFiles: conflictValidFiles, effectiveRelPaths: conflictRelPaths }) => {
        setOverwriteConflictDesc(conflictDesc);
        return new Promise<'cancel' | 'overwrite' | 'keep_both'>((resolve) => {
          overwriteResolverRef.current = resolve;
          setOverwriteFiles(existingFiles);
          setPendingUploadFiles(conflictValidFiles);
          setPendingRelativePaths(conflictRelPaths);
          setOverwriteDialogOpen(true);
        });
      },
    });

    if (preflight === 'no_valid_files') {
      toast.warning('No valid files to upload.');
      return;
    }
    if (preflight === 'quota_exceeded' || preflight === 'cancelled') {
      if (preflight === 'cancelled') {
        toast('Upload cancelled due to file conflicts');
      }
      return;
    }

    const {
      validFiles,
      pathsForUpload,
      hasConflicts,
      keepBoth: forceKeepBoth,
      uploadTargetPath,
      totalIncomingBytes,
    } = preflight;

    const allEntries = validFiles.map((file, index) => ({
      file,
      relativePath: pathsForUpload?.[index],
    }));

    const { small: normalSmallEntries, large: largeEntries, zarrGroups: zarrEntryGroups } =
      classifyUploadEntries(allEntries, DEFAULT_CHUNKED_UPLOAD_THRESHOLD_BYTES);

    // Build all upload units up front so progress UI shows the full batch at once.
    const batchTs = Date.now();
    const uploadUnits = buildUploadBatchUnits(batchTs, normalSmallEntries, largeEntries, zarrEntryGroups);
    const smallUnits = uploadUnits.filter((u) => u.kind === 'small');
    const zarrUnits = uploadUnits.filter((u) => u.kind === 'zarr');
    const largeUnits = uploadUnits.filter((u) => u.kind === 'large');

    // Progress is tracked per upload unit: ordinary files, chunked large files,
    // and each .zarr root as one file-like unit.
    totalUploadFilesRef.current = uploadUnits.length;
    initializeUploadStatusBatch(uploadUnits);
    const batchGeneration = uploadBatchGenerationRef.current;
    uploadUnitsInitialized = true;
    dispatch(setUploadSettings({ isUploading: true, uploadProgress: 0, uploadTotalFiles: uploadUnits.length }));
    setUploadInterrupted(false);
    safeUpdateOverallProgress();

    let batchCounts = emptyUploadCounts();
    const uploadResults = {
      ...batchCounts,
      total: uploadUnits.length,
    };

    try {
      batchCounts = await executeBatchUpload({
        smallUnits,
        zarrUnits,
        largeUnits,
        uploadSmall: (units) => uploadSmallFiles(uploadTargetPath, units, hasConflicts, forceKeepBoth),
        uploadZarrUnit: (zarrUnit) => uploadZarrBatches(
          uploadTargetPath,
          zarrUnit.zarrEntries!,
          hasConflicts,
          forceKeepBoth,
          zarrUnit.fileId,
          zarrUnit.displayPath,
          zarrUnit.displayFileSize
        ),
        uploadLarge: (units) => uploadLargeFiles(uploadTargetPath, units, hasConflicts, forceKeepBoth),
      });

      Object.assign(uploadResults, batchCounts);
      
      // Show a toast only when the dialog was minimized to the bottom-right widget.
      // If the user is watching the center dialog (not minimized), skip the toast
      // entirely — cancel or complete, the dialog handles the visual state itself.
      // showUploadResults covers all result combinations (success / partial / cancelled).
      if (uploadQuotaErrorRef.current) {
        openUploadQuotaWarning(uploadQuotaErrorRef.current, totalIncomingBytes);
      } else if (isDialogMinimizedRef.current) {
        await showUploadResults(uploadResults);
      }
      // (not minimized → no toast; dialog stays open in file-selection state)

      // Refresh file list when upload completes (same as LocalFileManager)
      if (uploadResults.successful > 0 && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('tissuelab:cloudUploadCompleted', { detail: { path: uploadTargetPath } }));
      }

      // "Pre-run analysis" checkbox: enqueue CellCast (global service survives page nav).
      if (preRunAnalysis && uploadResults.successful > 0) {
        const folder = uploadTargetPath.replace(/\/+$/, '');
        const wsiPaths = validFiles
          .filter((f) => isWSI(f.name))
          .map((f) => `${folder}/${f.name}`.replace(/\/{2,}/g, '/'));
        if (wsiPaths.length > 0) {
          enqueuePreRunBatch(wsiPaths);
        }
      }

      // Ensure the overall bar reaches 100% when every non-cancelled unit finished.
      const terminalStatuses = Array.from(uploadStatusRef.current.values()).filter(
        (s) => s.status !== 'Cancelled'
      );
      if (
        terminalStatuses.length > 0 &&
        terminalStatuses.every((s) => s.status === 'Completed' || s.progress >= 100)
      ) {
        dispatch(setUploadSettings({ uploadProgress: 100 }));
      } else {
        setTimeout(() => safeUpdateOverallProgress(), 100);
      }
      
    } catch (error: any) {
      console.error('Upload process failed:', error);
      
      // Check if it's a cancellation error
      if (error.message && error.message.includes('cancelled')) {
        setUploadInterrupted(true);
        toast.warning('Upload was interrupted. Some files may not have been uploaded completely.');
      } else if (isStorageQuotaErrorCallback(error)) {
        openUploadQuotaWarning(error, totalIncomingBytes);
      } else {
        toast.error(getErrorMessage(error, 'Upload failed'));
      }
    } finally {
      // Only clean up upload state if all uploads are truly complete
      // Check if there are any ongoing uploads
      const hasOngoingUploads = hasActiveUploadStatuses(uploadStatusRef.current);

      if (!hasOngoingUploads) {
        // Clean up upload state only when no uploads are ongoing.
        // When the dialog is minimized, do NOT reset uploadProgress here — the
        // widget is still visible and would flash at 0% before the close dispatch
        // arrives. Progress will be reset later inside cleanupUploadState().
        if (isDialogMinimizedRef.current) {
          dispatch(setUploadSettings({ isUploading: false }));
        } else {
          dispatch(setUploadSettings({ isUploading: false, uploadProgress: 0 }));
        }

        // Event-driven approach: Wait for all tracked uploads to complete
        const waitForAllUploadsToComplete = async () => {
          if (uploadCompletionTracker.current.hasActiveUploads()) {
            await uploadCompletionTracker.current.waitForAll();
          }

          // Give one final progress update to show completion
          safeUpdateOverallProgress();

          // Small delay for smooth UI transition
          await new Promise(resolve => setTimeout(resolve, 100));

          // Close the dialog BEFORE cleanupUploadState() so the bottom-right
          // widget never flashes at 0% — the close dispatch unmounts it first.
          // Only close when minimized; if the user is watching the center dialog
          // it stays open in the file-selection state (cancel or complete).
          if (isDialogMinimizedRef.current) {
            dispatch(setUploadSettings({ isUploadDialogOpen: false }));
            isDialogMinimizedRef.current = false; // reset for next session
          } else if (uploadResults.successful > 0) {
            // User was watching the center dialog and at least one file succeeded —
            // show the "Upload complete" notice above the file-selection area.
            setUploadJustCompleted(true);
          }

          cleanupUploadState(batchGeneration);
          if (uploadBatchGenerationRef.current === batchGeneration) {
            refreshChunkUploadResumeHints();
          }
        };

        waitForAllUploadsToComplete();
      } else {
        dispatch(setUploadSettings({ isUploading: true }));
      }
    }
    } finally {
      stopPreflightUpload();
    }
  };

  const uploadZarrBatches = async (
    uploadPath: string,
    entries: ZarrBatchFileEntry[],
    hasConflicts: boolean = false,
    keepBoth: boolean = false,
    presetFileId?: string,
    presetDisplayPath?: string,
    presetTotalBytes?: number
  ): Promise<{ successful: number; cancelled: number; failed: number }> => {
    const zarrTotalBytes = presetTotalBytes ?? entries.reduce((sum, entry) => sum + (entry.file.size || 0), 0);
    const zarrRoots = Array.from(
      new Set(entries.map((entry) => getZarrRootFromRelativePath(entry.relativePath)).filter(Boolean))
    );
    const zarrDisplayPath = presetDisplayPath || zarrRoots[0] || 'Zarr upload';
    const zarrStatusFile = entries[0]?.file;
    const zarrFileId = presetFileId || `zarr_${zarrDisplayPath}_${zarrTotalBytes}_${Date.now()}`;

    if (!zarrStatusFile) {
      return { successful: 0, cancelled: 0, failed: 0 };
    }

    const unit = createUnitUploadCallbacks({
      fileId: zarrFileId,
      file: zarrStatusFile,
      displayPath: zarrDisplayPath,
      displayFileSize: zarrTotalBytes,
    });

    return executeZarrBatchUpload(
      {
        uploadPath,
        entries,
        hasConflicts,
        keepBoth,
        presetFileId,
        presetDisplayPath,
        presetTotalBytes,
        sessionStore: zarrSessionStoreRef.current,
      },
      {
        ...unit.buildZarrCallbacks({
          captureQuotaError: captureUploadQuotaError,
          onResumeHintsRefresh: refreshChunkUploadResumeHints,
        }),
        uploadLargeFile: (path, file, conflicts, relativePath, childFileId, abortSignal) =>
          uploadSingleLargeFile(
            path,
            file,
            conflicts,
            relativePath,
            false,
            childFileId,
            relativePath,
            { silent: true, abortSignal }
          ),
      }
    );
  };

  const uploadSmallFiles = async (
    uploadPath: string,
    units: UploadBatchUnit[],
    hasConflicts: boolean = false,
    keepBoth: boolean = false
  ): Promise<{ successful: number; cancelled: number; failed: number }> =>
    executeSmallFileBatchUpload(
      {
        uploadPath,
        units,
        hasConflicts,
        keepBoth,
        uploadFiles: apiUploadFiles,
      },
      buildSmallFileBatchCallbacks(captureUploadQuotaError)
    );

  const uploadLargeFiles = async (
    uploadPath: string,
    units: UploadBatchUnit[],
    hasConflicts: boolean = false,
    keepBoth: boolean = false
  ): Promise<{ successful: number; cancelled: number; failed: number }> =>
    executeLargeFileBatchUpload(
      units,
      (unit) => uploadSingleLargeFile(
        uploadPath,
        unit.file,
        hasConflicts,
        unit.relativePath,
        keepBoth,
        unit.fileId,
        unit.displayPath
      ),
      { onAfterBatch: () => setTimeout(() => safeUpdateOverallProgress(), 100) }
    );

  const uploadSingleLargeFile = async (
    uploadPath: string,
    file: File,
    hasConflicts: boolean = false,
    relativePath?: string,
    keepBoth: boolean = false,
    presetFileId?: string,
    presetDisplayPath?: string,
    options?: { silent?: boolean; abortSignal?: AbortSignal }
  ): Promise<{ successful: number; cancelled: number; failed: number }> => {
    const silent = options?.silent ?? false;
    const fileId = presetFileId || `${file.name}_${file.size}_${Date.now()}`;
    const displayPath = presetDisplayPath || relativePath || file.name;
    const unit = createUnitUploadCallbacks({ fileId, file, displayPath });

    if (!silent) {
      unit.trackStart();
    }

    return executeChunkedFileUpload(
      {
        file,
        uploadPath,
        hasConflicts,
        relativePath,
        keepBoth,
        fileId,
        displayPath,
        startTime: unit.getStartTime(),
        silent,
        abortSignal: options?.abortSignal,
        getCurrentProgress: () => uploadStatusRef.current.get(fileId)?.progress ?? 0,
        getMergeStartedAt: () => uploadStatusRef.current.get(fileId)?.mergeStartedAt,
        getFinalStatus: () => uploadStatusRef.current.get(fileId),
        managerRegistry: chunkedUploadManagersRef.current,
      },
      unit.buildChunkedCallbacks({
        silent,
        onResumeHintsRefresh: refreshChunkUploadResumeHints,
        captureQuotaError: captureUploadQuotaError,
      })
    );
  };

  // Show upload results and appropriate messages
  const showUploadResults = async (results: { successful: number; cancelled: number; failed: number; total: number }) => {

    // Refresh file list to show uploaded files/folders
    if (results.successful > 0) {
      await fetchFiles(currentDirectory);
      triggerStorageRefresh();
    }

    // Show single, clear message based on results
    if (results.successful === results.total && results.successful > 0) {
      // All files successful - simple success message
      toast.success(`Successfully uploaded ${results.successful} file${results.successful === 1 ? '' : 's'}`);
    } else if (results.successful > 0) {
      // Partial success - show summary
      const parts = [];
      if (results.successful > 0) parts.push(`${results.successful} uploaded`);
      if (results.failed > 0) parts.push(`${results.failed} failed`);
      if (results.cancelled > 0) parts.push(`${results.cancelled} cancelled`);
      toast.warning(`Upload completed: ${parts.join(', ')}`);
    } else if (results.cancelled === results.total) {
      // All cancelled
      toast('Upload cancelled');
    } else if (results.failed === results.total) {
      // All failed
      toast.error('Upload failed');
    } else {
      // Undetermined state (e.g. cancel race condition) — safe fallback
      toast('Upload cancelled');
    }
  };

  // --- CRUD Operations ---
  const handleCreateFolder = async (folderName: string) => {
    if (!folderName) return;
    const nameError = validateItemName(folderName);
    if (nameError) { toast.error(nameError); return; }
    // Append to current relative path
    const newPath = currentDirectory ? `${currentDirectory}/${folderName}/` : `${folderName}/`;
    try {
      await apiCreateFolder(newPath);
      await fetchFiles(currentDirectory); // Refresh
      toast.success('Folder created successfully');
    } catch(err: any) {
      toast.error(getErrorMessage(err, 'Failed to create folder'));
    }
    finally { setDialog(null); }
  };

  const handleRename = async (newName: string) => {
    if (!newName || !dialog || dialog.type !== 'rename' || !dialog.path) return;
    const nameError = validateItemName(newName);
    if (nameError) { toast.error(nameError); return; }
    const oldPath = dialog.path;
    const dir = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/')) : '';
    const newPath = dir ? `${dir}/${newName}` : newName;
    try {
        await apiRenameFile(oldPath, newPath);
        forgetSelectedPaths([oldPath]);
        await fetchFiles(currentDirectory);
        toast.success('Item renamed successfully');
    } catch(err: any) {
        if (err.status === 404) await fetchFiles(currentDirectory);
        const message = getErrorMessage(err, 'Failed to rename item');
        if (err.status === 409) {
            toast.warning(message);
        } else {
            toast.error(message);
        }
    }
    finally { setDialog(null); }
  };

  const handleDelete = async () => {
    if (!dialog || dialog.type !== 'delete' || !dialog.paths?.length) return;
    const paths = dialog.paths;
    const key = `del_${Math.random().toString(36).slice(2)}`;
    try {
        const statusMessages: Record<string, string> = {
          'pending': 'Starting deletion...',
          'processing': 'Deleting...',
          'completed': 'Deletion completed',
          'failed': 'Deletion failed'
        };

        toast.loading(statusMessages['pending'], { id: key, duration: Infinity });
        setDialog(null);

        await apiDeleteFiles(
          paths,
          (status, data) => {
            const base = statusMessages[status] || 'Processing...';
            const result = data?.result;
            if (status === 'processing' && result?.firestore_deleted) {
              const name = result.item ? `"${result.item}" — ` : '';
              toast.loading(`Deleting ${name}cleaned ${result.firestore_deleted} record(s)`, { id: key, duration: Infinity });
            } else {
              toast.loading(base, { id: key, duration: Infinity });
            }
          },
          true  // Explicitly set waitForCompletion to true to use SSE
        );

        await fetchFiles(currentDirectoryRef.current);
        triggerStorageRefresh();
        toast.success(
          paths.length > 1 ? `${paths.length} items deleted successfully` : 'Item deleted successfully',
          { id: key, duration: 2000 },
        );
        exitMultiSelectMode();
    } catch(err: any) {
        if (err.status === 404) await fetchFiles(currentDirectoryRef.current);
        const message = getErrorMessage(err, 'Failed to delete item');
        if (err.status === 409) {
            toast.warning(message, { id: key, duration: 4000 });
        } else {
            toast.error(message, { id: key, duration: 4000 });
        }
    }
    finally {
      setDialog(null);
      forgetSelectedPaths(paths);
    }
  };
  
  const filesToRender = fileTree;

  const renderBreadcrumbs = () => {
    const personalRoot = (defaultPath || '');
    return (
      <Breadcrumbs
        currentDirectory={currentDirectory}
        personalRoot={personalRoot}
        onNavigate={(p) => fetchFiles(p)}
      />
    );
  };



  // Pagination handlers
  const handlePreviousPage = useCallback(async () => {
    if (paginationState.offset > 0) {
      const newOffset = Math.max(0, paginationState.offset - (paginationState.limit || 50));
      dispatch(setPagination({ offset: newOffset }));
      // The listing-query effect issues the refetch for the new page.
    }
  }, [paginationState.offset, paginationState.limit, dispatch]);

  const handleNextPage = useCallback(async () => {
    if (paginationState.hasMore) {
      const newOffset = paginationState.offset + (paginationState.limit || 50);
      dispatch(setPagination({ offset: newOffset }));
      // The listing-query effect issues the refetch for the new page.
    }
  }, [paginationState.offset, paginationState.limit, paginationState.hasMore, dispatch]);

  const handlePageSizeChange = useCallback(async (newLimit: number | null) => {
    dispatch(setPagination({ limit: newLimit, offset: 0 }));
    // The listing-query effect issues the refetch for the new page.
  }, [dispatch]);

  const handlePageClick = useCallback(async (page: number) => {
    if (paginationState.limit !== null) {
      const newOffset = (page - 1) * paginationState.limit;
      dispatch(setPagination({ offset: newOffset }));
      // The listing-query effect issues the refetch for the new page.
    }
  }, [paginationState.limit, dispatch]);

  // const renderToolbar = () => {};
  // toolbar actions handled by FileHeader

  // Handle copying a Samples file or folder to the user's Personal root.
  // Supports automatic retry when backend returns 503 COPY_BUSY_RETRY.
  const COPY_MAX_RETRIES = 10;
  const handleCopyToPersonal = async (item: FileTreeNode, retryCount: number = 0, link: boolean = false, includeZarr: boolean = false) => {
    const itemKey = item.path;
    const toastKey = `ctp_${itemKey}`; // Stable key so toasts update in-place
    const verb = link ? 'Linking to Personal' : 'Copying to Personal';
    const doneVerb = link ? 'Linked to Personal' : 'Copied to Personal';
    // Copy/link *from* Samples or Viewer into Personal is the escape hatch —
    // do not run path-ACL denial on the source.

    if (retryCount === 0) {
      toast.loading(`${verb}…`, { id: toastKey, duration: Infinity });
    }

    // 2. Set state to 'copying'
    setCopyStates(prev => ({ ...prev, [itemKey]: 'copying' }));

    const clearItemState = () => {
      setCopyStates(prev => { const next = { ...prev }; delete next[itemKey]; return next; });
    };

    try {
      // 3. Call the appropriate API. Link mode is files-only (the backend
      // only links single slides + their .zarr overlay).
      if (item.is_dir) {
        await copyFolderToPersonal(item.path, link, includeZarr);
      } else {
        await copyFileToPersonal(item.path, link, includeZarr);
      }
      // 4. Success
      toast.success(doneVerb, { id: toastKey, duration: 3000 });
      triggerStorageRefresh();
      clearItemState();
    } catch (e: any) {
      const errorCode: string = (e as any)?.errorCode || '';
      const errorStatus: number | undefined = (e as any)?.status;

      // 5a. Backend busy (503) → queue and auto-retry.
      // Require BOTH the HTTP 503 status AND the COPY_BUSY_RETRY code so that
      // an unrelated error sharing the same code string doesn't trigger retries.
      if (errorStatus === 503 && errorCode === 'COPY_BUSY_RETRY') {
        if (retryCount >= COPY_MAX_RETRIES) {
          toast.error('Copy queue is busy. Please try again later.', { id: toastKey, duration: 4000 });
          clearItemState();
          return;
        }
        const retryAfter: number = (e as any).retryAfter ?? 10;
        setCopyStates(prev => ({ ...prev, [itemKey]: 'queued' }));
        toast.loading(`Queued… retrying in ${retryAfter}s`, { id: toastKey, duration: Infinity });
        setTimeout(() => { handleCopyToPersonal(item, retryCount + 1, link, includeZarr); }, retryAfter * 1000);
        return;
      }

      if (isStorageQuotaErrorCallback(e)) {
        toast.dismiss(toastKey);
        openUploadQuotaWarning(e);
        clearItemState();
        return;
      }

      // 5b. Other errors → error dialog
      toast.dismiss(toastKey);
      const backendDefinedMessage = getBackendDefinedErrorMessage(e);
      if (backendDefinedMessage) {
        setCopyErrorTitle(backendDefinedMessage);
        setCopyErrorMessage('');
      } else {
        setCopyErrorTitle('Copy failed');
        setCopyErrorMessage(getErrorMessage(e, 'Failed to copy to Personal. Please try again.'));
      }
      setCopyErrorDialogOpen(true);
      clearItemState();
    }
  };

  // Clear selection + exit multi-select when leaving the folder.
  useEffect(() => {
    setSelectedPaths(new Set());
    selectionAnchorRef.current = null;
    setIsMultiSelectMode(false);
  }, [currentDirectory]);

  // Image-table view has no multi-select surface — drop the mode if user switches.
  useEffect(() => {
    if (tableViewMode === 'table' && isMultiSelectMode) {
      setIsMultiSelectMode(false);
      setSelectedPaths(new Set());
      selectionAnchorRef.current = null;
    }
  }, [tableViewMode, isMultiSelectMode]);

  const clearSelection = () => {
    setSelectedPaths(new Set());
    selectionAnchorRef.current = null;
  };

  const exitMultiSelectMode = () => {
    setIsMultiSelectMode(false);
    clearSelection();
  };

  const handleListBackgroundClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('[data-file-row]')) return;
    if (target.closest('[data-keep-selection]')) return;
    // Blank click exits select mode entirely (iOS Done / Drive deselect-all feel).
    if (isMultiSelectMode) exitMultiSelectMode();
    else clearSelection();
  };

  const runCellSegmentationOn = useCallback((paths: string[]) => {
    const wsiPaths = paths.filter((p) => {
      const name = p.split('/').pop() || p;
      return isWSI(name) && !isPublicReadOnlyPath(p);
    });
    if (wsiPaths.length === 0) {
      toast.warning('Select at least one writable WSI slide.');
      return;
    }
    const n = enqueuePreRunBatch(wsiPaths);
    if (n === 0) {
      toast.info('Those slides are already queued or running.');
      return;
    }
    toast.success(
      n === 1
        ? 'Queued cell segmentation'
        : `Queued cell segmentation for ${n} slides`,
    );
  }, []);

  // Fire copy-to-personal (link=false) or link (link=true) for each selected
  // slide. Sequential on purpose: handleCopyToPersonal already shows a per-item
  // toast and handles the 503 queue retry, and the backend semaphore caps real
  // concurrency — looping one at a time keeps the UI legible.
  const handleBatchCopyToPersonal = async (nodes: FileTreeNode[], link: boolean) => {
    exitMultiSelectMode();
    for (const node of nodes) {
      await handleCopyToPersonal(node, 0, link);
    }
  };

  const handleMoveSelected = async (paths: string[], destinationPath: string) => {
    const movable = movablePathsInto(paths, destinationPath);
    if (movable.length === 0) return;

    // Close the picker immediately so the UI doesn't feel frozen during large moves.
    setDialog(null);
    exitMultiSelectMode();
    await performMove(movable, destinationPath, `move_${Date.now()}`);
  };

  const renderItemContextMenu = (item: FileTreeNode) => {
    const { isContextDisabledForItem } = computeFsPermissions(currentDirectory);
    const disabledAll: boolean = isContextDisabledForItem(item.path);
    // Whether the current directory is a Samples/read-only path (reliable for all items in this view)
    // Note: we check currentDirectory, NOT item.path, because the backend returns paths
    // without the 'samples/' prefix (e.g. 'CMU-files' instead of 'samples/CMU-files').
    const isInSamplesDir = isPublicReadOnlyPath(currentDirectory);
    // Sample listings can return child paths without the `samples/` prefix, so
    // item.path alone is not authoritative for extract permissions.
    const itemAccessPath = isInSamplesDir ? currentDirectory : item.path;
    const itemWritable = !isWriteBlockedPath(itemAccessPath);
    // Allow opening menu for files even in Samples to enable Download.
    // Also allow for (non-zarr) directories inside Samples so "Copy folder to Personal" is accessible.
    const isSamplesSubfolder = item.is_dir && isInSamplesDir && !isZarr(item.name);
    const triggerDisabled = disabledAll && item.is_dir && !isSamplesSubfolder;
    const onDownload = async () => {
      if (!itemWritable) {
        denyWriteToast('download this item', itemAccessPath);
        return;
      }
      const key = `dl_${Math.random().toString(36).slice(2)}`;
      try {
        toast.loading('Preparing download...', { id: key, duration: Infinity });
        // For zarr dirs: backend streams as zip, suggest .zip filename
        const suggestedName = isZarrDir ? `${item.name || 'download'}.zip` : (item.name || 'download');
        await downloadFile(item.path, suggestedName, (progress) => {
          if (progress.state === 'progressing' && progress.percent !== undefined) {
            toast.loading(`Downloading ${progress.percent}%`, { id: key, duration: Infinity });
          } else if (progress.state === 'completed') {
            toast.success('Download completed', { id: key, duration: 2000 });
          } else if (progress.state === 'interrupted' || progress.state === 'cancelled' || progress.state === 'failed') {
            toast.error('Download Failed', { id: key, duration: 2000 });
          }
        });
        
        toast.success('Download completed', { id: key, duration: 2000 });
      } catch (e: any) {
        toast.error(getErrorMessage(e, 'Download failed'), { id: key });
      }
    };
    const onDownloadData = async () => {
      if (denyWriteToast('download analysis data', itemAccessPath)) {
        return;
      }
      const key = `dld_${Math.random().toString(36).slice(2)}`;
      try {
        toast.loading('Preparing download...', { id: key, duration: Infinity });
        // Companion analysis data for this WSI lives at <wsi>.zarr; backend streams it as zip.
        await downloadFile(`${item.path}.zarr`, `${item.name}.zarr.zip`, (progress) => {
          if (progress.state === 'progressing' && progress.percent !== undefined) {
            toast.loading(`Downloading ${progress.percent}%`, { id: key, duration: Infinity });
          } else if (progress.state === 'completed') {
            toast.success('Download completed', { id: key, duration: 2000 });
          } else if (progress.state === 'interrupted' || progress.state === 'cancelled' || progress.state === 'failed') {
            toast.error('Download Failed', { id: key, duration: 2000 });
          }
        });
        toast.success('Download completed', { id: key, duration: 2000 });
      } catch (e: any) {
        toast.error(getErrorMessage(e, 'Download failed'), { id: key });
      }
    };
    const isZipFile = !item.is_dir && item.name.toLowerCase().endsWith('.zip');
    const isZarrDir = item.is_dir && isZarr(item.name);
    const isH5File = !item.is_dir && isH5Convertible(item.name);
    const isWsiFile = !item.is_dir && isWSI(item.name);
    const conversionJob = isH5File ? conversionJobs[item.path] : null;
    const isConverting = conversionJob && (conversionJob.status === 'pending' || conversionJob.status === 'running');
    const handleCompress = async (overwrite: boolean = false) => {
      try {
        const key = `cmp_${Math.random().toString(36).slice(2)}`;
        const statusMessages: Record<string, string> = {
          'pending': 'Starting compression...',
          'processing': 'Compressing...',
          'completed': 'Compression completed',
          'failed': 'Compression failed'
        };
        
        toast.loading(statusMessages['pending'], { id: key, duration: Infinity });
        
        const parentRel = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : '';
        // Calculate expected zip filename: {item_name}.zip
        const expectedZipName = `${item.name}.zip`;
        const expectedZipPath = parentRel ? `${parentRel}/${expectedZipName}` : expectedZipName;
        
        // Check if file exists before compressing
        if (!overwrite) {
          const existingFile = findFileInTree(expectedZipPath, expectedZipName);
          if (existingFile) {
            setOverwriteTargetPath(expectedZipPath);
            setOverwriteTargetName(expectedZipName);
            setOverwriteAction(() => () => handleCompress(true));
            setOverwriteCompressDialogOpen(true);
            toast.dismiss(key);
            return;
          }
        }
        
        await compressItems(
          [item.path],
          parentRel,
          undefined,
          overwrite,
          (status) => {
            toast.loading(statusMessages[status] || 'Processing...', { id: key, duration: Infinity });
          }
        );
        await fetchFiles(currentDirectory);
        toast.success('Compressed to zip', { id: key, duration: 2000 });
      } catch (e: any) {
        toast.error(getErrorMessage(e, 'Compression failed'));
      }
    };
    const handleExtract = async (overwrite: boolean = false) => {
      if (denyWriteToast('extract this archive', itemAccessPath)) {
        return;
      }
      try {
        const key = `ext_${Math.random().toString(36).slice(2)}`;
        const statusMessages: Record<string, string> = {
          'pending': 'Starting extraction...',
          'processing': 'Extracting...',
          'completed': 'Extraction completed',
          'failed': 'Extraction failed'
        };
        
        toast.loading(statusMessages['pending'], { id: key, duration: Infinity });
        
        // Calculate expected extraction folder name: {zip_name_without_zip}
        const zipNameWithoutExt = item.name.replace(/\.zip$/i, '');
        const expectedExtractPath = currentDirectory ? `${currentDirectory}/${zipNameWithoutExt}` : zipNameWithoutExt;
        
        // Check if directory exists before extracting
        if (!overwrite) {
          const existingDir = findFileInTree(expectedExtractPath, zipNameWithoutExt);
          if (existingDir && existingDir.is_dir) {
            setOverwriteTargetPath(expectedExtractPath);
            setOverwriteTargetName(zipNameWithoutExt);
            setOverwriteAction(() => () => handleExtract(true));
            setOverwriteCompressDialogOpen(true);
            toast.dismiss(key);
            return;
          }
        }
        
        await decompressZip(
          item.path,
          currentDirectory,
          overwrite,
          (status) => {
            toast.loading(statusMessages[status] || 'Processing...', { id: key, duration: Infinity });
          }
        );
        await fetchFiles(currentDirectory);
        toast.success('Extraction completed', { id: key, duration: 2000 });
      } catch (e: any) {
        toast.error(getErrorMessage(e, 'Extraction failed'));
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
              {(!item.is_dir || isZarrDir) && (
                <DropdownMenuItem onSelect={onDownload} disabled={!itemWritable}>
                    <DownloadCloud className="h-4 w-4 mr-2" /> Download
                </DropdownMenuItem>
              )}
              {isWsiFile && (
                <DropdownMenuItem onSelect={onDownloadData} disabled={!itemWritable}>
                    <DownloadCloud className="h-4 w-4 mr-2" /> Download data
                </DropdownMenuItem>
              )}
              {isZipFile && (
                <DropdownMenuItem onSelect={() => handleExtract()} disabled={!itemWritable}>
                  <ArchiveRestore className="h-4 w-4 mr-2" /> Extract here
                </DropdownMenuItem>
              )}
              {isH5File && (
                <DropdownMenuItem
                  onSelect={() => handleConvertToZarr(item)}
                  disabled={isConverting || disabledAll}
                >
                  <Archive className="h-4 w-4 mr-2" />
                  {isConverting ? 'Converting to Zarr...' : 'Convert to Zarr'}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => {
                setTimeout(() => {
                  setDialog({ type: 'rename', path: item.path })
                }, 50)
              }} disabled={disabledAll}>
                  <Edit className="h-4 w-4 mr-2" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => {
                setTimeout(() => {
                  setDialog({ type: 'delete', paths: [item.path] })
                }, 50)
              }} className="text-destructive" disabled={disabledAll}>
                  <Trash2 className="h-4 w-4 mr-2" /> Delete
              </DropdownMenuItem>
              {/* Clear — wipes the companion .zarr's analysis data (all of its
                  groups: segmentation, classification, …) for a WSI whose .zarr
                  is surfaced as badges (its own row is hidden). Leaves the slide
                  itself; "Delete" above is for the file. */}
              {!item.is_dir && isWSI(item.name) && item.attachedZarrPath && (
                <DropdownMenuItem onSelect={() => {
                  const zarrPath = item.attachedZarrPath!;
                  setTimeout(() => {
                    setDialog({ type: 'delete', paths: [zarrPath], label: 'all analysis data (segmentation, classification, …) for this slide' })
                  }, 50)
                }} className="text-destructive" disabled={disabledAll}>
                    <Eraser className="h-4 w-4 mr-2" /> Clear
                </DropdownMenuItem>
              )}
              {/* Copy to Personal — visible only for WSI files inside Samples (read-only paths) */}
              {isInSamplesDir && !item.is_dir && isWSI(item.name) && (
                <DropdownMenuItem
                  onSelect={() => { setCopyIncludeZarr(false); setCopyDialogItem(item); }}
                  disabled={!!copyStates[item.path]}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  {copyStates[item.path] === 'copying' ? 'Copying…' : copyStates[item.path] === 'queued' ? 'Queued…' : 'Copy to Personal'}
                </DropdownMenuItem>
              )}
              {/* Use without copying — symlinks the slide + a writable .zarr
                  overlay so the user can run/update a classifier on it without
                  duplicating the WSI + embeddings. Shares bytes in place. */}
              {isInSamplesDir && !item.is_dir && isWSI(item.name) && (
                <DropdownMenuItem
                  onSelect={() => handleCopyToPersonal(item, 0, true)}
                  disabled={!!copyStates[item.path]}
                >
                  <Link2 className="h-4 w-4 mr-2" />
                  {copyStates[item.path] === 'copying' ? 'Linking…' : copyStates[item.path] === 'queued' ? 'Queued…' : 'Link to Personal'}
                </DropdownMenuItem>
              )}
              {/* Copy folder to Personal — visible only for real (non-zarr) directories inside Samples */}
              {isInSamplesDir && item.is_dir && !isZarr(item.name) && (
                <DropdownMenuItem
                  onSelect={() => { setCopyIncludeZarr(false); setCopyDialogItem(item); }}
                  disabled={!!copyStates[item.path]}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  {copyStates[item.path] === 'copying' ? 'Copying…' : copyStates[item.path] === 'queued' ? 'Queued…' : 'Copy folder to Personal'}
                </DropdownMenuItem>
              )}
              {/* Link folder to Personal — recursive symlink: every slide is
                  linked in place (no byte copy) with a writable .zarr overlay.
                  Same primitive as "Link to Personal" but folder-scoped. */}
              {isInSamplesDir && item.is_dir && !isZarr(item.name) && (
                <DropdownMenuItem
                  onSelect={() => handleCopyToPersonal(item, 0, true)}
                  disabled={!!copyStates[item.path]}
                >
                  <Link2 className="h-4 w-4 mr-2" />
                  {copyStates[item.path] === 'copying' ? 'Linking…' : copyStates[item.path] === 'queued' ? 'Queued…' : 'Link folder to Personal'}
                </DropdownMenuItem>
              )}
          </DropdownMenuContent>
      </DropdownMenu>
    );
  };


  // iOS-style select glyph: same footprint as the file icon so layout doesn't jump.
  const renderRowLeadingIcon = (item: FileTreeNode) => {
    if (isMultiSelectMode) {
      const selected = selectedPaths.has(item.path);
      return (
        <span
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/35 bg-background'
          }`}
          aria-hidden
        >
          {selected ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
        </span>
      );
    }
    if (item.is_dir && !isZarr(item.name)) {
      return <Folder className="h-5 w-5 text-primary shrink-0" />;
    }
    if (isWSI(item.name)) return <ImageIcon className="h-5 w-5 text-destructive shrink-0" />;
    if (isZarrZip(item.name)) return <Archive className="h-4 w-4 text-primary/80 shrink-0" />;
    if (isZarrDir(item.name)) return <File className="h-4 w-4 text-primary/60 shrink-0" />;
    return <File className="h-5 w-5 text-muted-foreground shrink-0" />;
  };

  // Render desktop table rows only
  const renderFileTableRows = (nodes: FileTreeNode[], baseIndex: number = 0, showDashForMtime: boolean = false): React.ReactNode[] => {
    let rows: React.ReactNode[] = [];
    // `fileTree` is already in display order. Re-sorting here can only diverge
    // from the order the page boundaries were computed with — JS and Python
    // disagree on string order above the BMP, and an emoji in a filename is
    // enough to trigger it.
    const sortedNodes = nodes;

    sortedNodes.forEach((item, index) => {
        const globalIndex = baseIndex + index;
        // @ts-ignore
        if (item.isParentLink) {
            rows.push(
                <TableRow
                    key={`${keyPrefix}:parent:${item.path || currentDirectory}:${globalIndex}`}
                    data-file-row
                    onDragOver={(e) => handleDragOver(e, item.path)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, item)}
                    onClick={(e) => handleItemClick(item, e)}
                    className="cursor-pointer transition-colors align-middle hover:bg-primary/10 mx-2 rounded-lg bg-card border-b border-border/30 text-[12px] [&_td]:py-0.5 [&_td]:px-2"
                >
                    <TableCell style={{ minWidth: COL_MIN_NAME }}>
                         <div style={{ paddingLeft: `${item.depth * 24}px` }} className="flex items-center gap-2">
                            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            <span className="break-all leading-tight">{item.name}</span>
                         </div>
                    </TableCell>
                    {showType && <TableCell className="text-right text-muted-foreground whitespace-nowrap">Parent Directory</TableCell>}
                    {showSize && <TableCell className="text-right text-muted-foreground whitespace-nowrap" style={{ minWidth: COL_W_SIZE }}>—</TableCell>}
                    {showMtime && <TableCell className="text-right text-muted-foreground">—</TableCell>}
                    <TableCell className="text-right w-12"></TableCell>
                </TableRow>
            );
            return;
        }

        // Filter files based on showNonImageFiles setting
        if (!showNonImageFiles && !item.is_dir && !isWSI(item.name) && !isZarr(item.name) && !isH5Convertible(item.name)) {
            return;
        }

        rows.push(
            <TableRow
                key={`${keyPrefix}:node:${currentDirectory}:${item.path}:${globalIndex}`}
                data-file-row
                draggable
                onDragStart={(e) => handleDragStart(e, item.path)}
                onDragEnd={handleDragEnd}
                onDragOver={item.is_dir && !isZarr(item.name) ? (e) => handleDragOver(e, item.path) : undefined}
                onDragLeave={item.is_dir && !isZarr(item.name) ? handleDragLeave : undefined}
                onDrop={item.is_dir && !isZarr(item.name) ? (e) => handleDrop(e, item) : (e) => e.preventDefault()}
                onClick={(e) => handleItemClick(item, e)}
                className={`even:bg-muted/10 cursor-pointer transition-colors align-middle rounded-lg mx-2 hover:!bg-primary/9 ${selectedPaths.has(item.path) ? '!bg-primary/15 hover:!bg-primary/20' : ''} ${!item.is_dir && isWSI(item.name) && item.attachedZarrPath ? '' : 'border-b border-border/30'} text-[12px] [&_td]:py-0.5 [&_td]:px-2`}
            >
                <TableCell className="px-3" style={{ minWidth: COL_MIN_NAME }}>
                    <div style={{ paddingLeft: `${item.depth * 24}px` }} className="flex items-center gap-3">
                        {renderRowLeadingIcon(item)}
                        <span className="min-w-0 break-all leading-tight">{item.name}</span>
                        {item.linkedFrom && (
                          <span
                            className="ml-1.5 inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                            title="Linked from Samples. Segmentation / embedding can't be re-run on it."
                          >
                            <Link2 className="h-3 w-3" /> From Samples
                          </span>
                        )}
                    </div>
                </TableCell>
                {showType && (
                  <TableCell className="text-right text-muted-foreground whitespace-nowrap">{item.is_dir && !isZarr(item.name) ? 'Folder' : formatFileType(item.name)}</TableCell>
                )}
                {showSize && (
                  <TableCell className="text-right text-muted-foreground whitespace-nowrap" style={{ minWidth: COL_W_SIZE }}>{(item.is_dir || isZarr(item.name)) ? '—' : formatBytes(item.size)}</TableCell>
                )}
                {showMtime && (
                  <TableCell className="text-right text-muted-foreground">
                      {(showDashForMtime && item.depth === 0) ? '—' :
                       new Date(item.mtime * 1000).toLocaleString()}
                  </TableCell>
                )}
                <TableCell className="text-right w-12" onClick={(e) => e.stopPropagation()}>
                    {renderItemContextMenu(item)}
                </TableCell>
            </TableRow>
        );

        // Analysis badges for companion .zarr (no nested expand/list — Drive-style flat rows).
        if (!item.is_dir && isWSI(item.name) && item.attachedZarrPath) {
            rows.push(
                <TableRow
                    key={`${keyPrefix}:zarrbadges:${item.path}:${globalIndex}`}
                    className="align-middle text-[12px] [&_td]:px-2 hover:bg-transparent border-b border-border/30"
                >
                    <TableCell colSpan={99} className="px-3 pt-1.5 pb-2">
                        <div
                            style={{ paddingLeft: `${item.depth * 24 + 32}px` }}
                            className="flex flex-wrap items-center gap-1.5"
                        >
                            <span className="-mt-0.5 select-none text-base leading-none text-muted-foreground/50">↳</span>
                            <ZarrBadgesCell zarrPath={item.attachedZarrPath} />
                        </div>
                    </TableCell>
                </TableRow>
            );
        }
    });
    return rows;
  };

  // Render mobile cards only
  const renderFileCards = (nodes: FileTreeNode[], baseIndex: number = 0, showDashForMtime: boolean = false): React.ReactNode[] => {
    let cards: React.ReactNode[] = [];
    // Already in display order — see renderFileTableRows.
    const sortedNodes = nodes;

    sortedNodes.forEach((item, index) => {
        const globalIndex = baseIndex + index;
        // @ts-ignore
        if (item.isParentLink) {
            cards.push(
                <div 
                  key={`${keyPrefix}:parent:${item.path || currentDirectory}:${globalIndex}`}
                  data-file-row
                  className="p-3 mb-2 bg-card border-b border-border/50 rounded-lg cursor-pointer hover:bg-primary/10"
                  onClick={(e) => handleItemClick(item, e)}
                >
                  <div className="flex items-center gap-2">
                    <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
                    <span className="font-medium">{item.name}</span>
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">Parent Directory</div>
                </div>
            );
            return;
        }

        // Filter files based on showNonImageFiles setting
        if (!showNonImageFiles && !item.is_dir && !isWSI(item.name) && !isZarr(item.name) && !isH5Convertible(item.name)) {
            return;
        }

        cards.push(
            <div 
              key={`${keyPrefix}:node:${currentDirectory}:${item.path}:${globalIndex}`}
              data-file-row
              className={`p-3 mb-2 bg-card border-b border-border/50 rounded-lg cursor-pointer hover:bg-primary/10 ${selectedPaths.has(item.path) ? 'bg-primary/15 hover:bg-primary/20' : ''}`}
              onClick={(e) => handleItemClick(item, e)}
              style={{ marginLeft: `${item.depth * 16}px` }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  {renderRowLeadingIcon(item)}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium break-all text-sm">
                      {item.name}
                      {item.linkedFrom && (
                        <span
                          className="ml-1.5 inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground align-middle"
                          title="Linked from Samples. Segmentation / embedding can't be re-run on it."
                        >
                          <Link2 className="h-3 w-3" /> From Samples
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span><span className="font-medium">Type:</span> {item.is_dir && !isZarr(item.name) ? 'Folder' : formatFileType(item.name)}</span>
                      {!item.is_dir && !isZarr(item.name) && <span><span className="font-medium">Size:</span> {formatBytes(item.size)}</span>}
                      <span><span className="font-medium">Modified:</span> {
                        (showDashForMtime && item.depth === 0) ? '—' :
                        new Date(item.mtime * 1000).toLocaleDateString()
                      }</span>
                    </div>
                    {!item.is_dir && isWSI(item.name) && item.attachedZarrPath && (
                      <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                        <ZarrBadgesCell zarrPath={item.attachedZarrPath} />
                      </div>
                    )}
                  </div>
                </div>
                <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                  {renderItemContextMenu(item)}
                </div>
              </div>
            </div>
        );

        // Flat Drive-style list: enter folders via click, no nested expand rows.
    });
    return cards;
  };

  const renderFileTable = () => {
    return (
      <div>
        {/* Desktop table */}
        <div
          ref={setTableContainer}
          className="hidden md:block min-h-[200px] px-3 py-0"
          onClick={handleListBackgroundClick}
        >
          <Table
            onDragOver={(e) => handleDragOver(e, currentDirectory)}
            onDragLeave={handleDragLeave}
            onDragEnd={handleDragEnd}
            onDrop={handleDropOnCurrentDirectory}
          >
            <TableHeader className="p-0" data-keep-selection>
              <TableRow className="text-[10px] uppercase tracking-wide [&_th]:text-foreground/40 [&_th]:font-medium last:border-b hover:bg-transparent [&_th]:py-1.5 [&_th]:px-2">
                <TableHead style={{ minWidth: COL_MIN_NAME }}>
                  <div className="flex items-center gap-2">
                    <span className="cursor-pointer" onClick={() => requestSort('name')}>
                      Name {sortConfig.key === 'name' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-3.5 w-3.5" /> : <ArrowDown className="inline h-3.5 w-3.5" />)}
                    </span>
                  </div>
                </TableHead>
                {showType && (
                  <TableHead className="text-right cursor-pointer whitespace-nowrap" onClick={() => requestSort('type')}>
                      Type {sortConfig.key === 'type' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-3.5 w-3.5" /> : <ArrowDown className="inline h-3.5 w-3.5" />)}
                  </TableHead>
                )}
                {showSize && (
                  <TableHead className="text-right cursor-pointer whitespace-nowrap" style={{ minWidth: COL_W_SIZE }} onClick={() => requestSort('size')}>
                      Size {sortConfig.key === 'size' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-3.5 w-3.5" /> : <ArrowDown className="inline h-3.5 w-3.5" />)}
                  </TableHead>
                )}
                {showMtime && (
                  <TableHead className="text-right cursor-pointer" onClick={() => requestSort('mtime')}>
                      Last Modified {sortConfig.key === 'mtime' && (sortConfig.direction === 'asc' ? <ArrowUp className="inline h-3.5 w-3.5" /> : <ArrowDown className="inline h-3.5 w-3.5" />)}
                  </TableHead>
                )}
                <TableHead className="w-12 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {renderFileTableRows(filesToRender, 0, false)}
            </TableBody>
          </Table>
        </div>
        
        {/* Mobile cards */}
        <div className="md:hidden min-h-[120px] px-2" onClick={handleListBackgroundClick}>
          {renderFileCards(filesToRender, 0, false)}
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
      const count = dialog.paths.length;
      return (
        <Dialog open onOpenChange={() => setDialog(null)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Are you sure?</DialogTitle>
                    <DialogDescription>
                        {dialog.label
                          ? `This will permanently delete ${dialog.label}. This action cannot be undone.`
                          : count > 1
                            ? `This will permanently delete ${count} items. This action cannot be undone.`
                            : 'This will permanently delete this item. This action cannot be undone.'}
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

    if (dialog.type === 'move') {
      const moving = new Set(dialog.paths);
      // `moveDestinations` is the server's dirs-only listing (see the effect
      // that loads it). Until it lands, fall back to the folders on the current
      // page so the dialog is never empty.
      const folderSource = moveDestinations ?? allFetchedFiles;
      const folders = folderSource.filter(
        (n) =>
          n.is_dir &&
          !isZarr(n.name) &&
          !(n as { isParentLink?: boolean }).isParentLink &&
          !moving.has(n.path),
      );
      const parent = allFetchedFiles.find((n) => (n as { isParentLink?: boolean }).isParentLink);
      const destinations = parent ? [parent, ...folders] : folders;
      return (
        <Dialog open onOpenChange={() => setDialog(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Move {dialog.paths.length === 1 ? 'item' : `${dialog.paths.length} items`}</DialogTitle>
              <DialogDescription>
                Choose a destination folder in this location.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-64 space-y-1 overflow-y-auto py-2">
              {destinations.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">
                  No folders here. Open another folder, or create one first.
                </p>
              ) : (
                destinations.map((dest) => {
                  const isParent = !!(dest as { isParentLink?: boolean }).isParentLink;
                  return (
                    <button
                      key={dest.path || '__parent__'}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => handleMoveSelected(dialog.paths, dest.path)}
                    >
                      {isParent ? (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <Folder className="h-4 w-4 shrink-0 text-primary" />
                      )}
                      <span className="truncate">{isParent ? 'Parent folder' : dest.name}</span>
                    </button>
                  );
                })
              )}
            </div>
            {moveDestinationsTruncated && (
              <p className="px-1 text-xs text-muted-foreground">
                Showing the first {MOVE_DESTINATION_LIMIT} folders. Open the destination
                folder and move from there if it isn&apos;t listed.
              </p>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      );
    }

  }

  const { canCreate, canUpload } = computeFsPermissions(currentDirectory);
  const personalRootForUp = (defaultPath || '').replace(/\\/g, '/');
  const upButtonDisabled =
    !currentDirectory ||
    currentDirectory === 'samples' ||
    (!!personalRootForUp && currentDirectory === personalRootForUp);
  const newFolderDisabled = Boolean(error) || !canCreate;
  const uploadDisabled =
    uploadSettings.isUploading
    || hasActiveUploadStatuses(uploadStatus)
    || Boolean(error)
    || !canUpload;

  // Selection actions must see every selected node, not just the ones on screen,
  // so paging mid-select doesn't drop Move / Delete / Copy from the toolbar.
  // Only one page is fetched at a time now, so resolve against the rows still
  // rendered first and fall back to the nodes remembered as pages went by.
  const inSamplesDir = isPublicReadOnlyPath(currentDirectory);
  const canMutateSelected = !inSamplesDir;
  const selectedNodes = Array.from(selectedPaths)
    .map((selectedPath) => selectionNodeCacheRef.current.get(selectedPath))
    .filter((node): node is FileTreeNode => !!node);
  const selectedBatchNodes = selectedNodes.filter(
    (n) =>
      (!n.is_dir && isWSI(n.name) && (inSamplesDir || !n.linkedFrom)) ||
      (inSamplesDir && n.is_dir && !isZarr(n.name)),
  );
  const selectedMovableNodes = selectedNodes.filter(
    (n) => canMutateSelected && !n.linkedFrom && !isPublicReadOnlyPath(n.path),
  );
  // Count only paths that still resolve in the listing (stale after move/delete/page filter).
  const selectionCount = selectedNodes.length;
  const showSelectionBar = isMultiSelectMode && selectionCount > 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col shadow-none">
      <Card className="flex h-full min-h-0 flex-1 flex-col rounded-sm border-border/50 mb-0">
        <CardHeader
          className="shrink-0 p-3"
          {...(showSelectionBar ? { 'data-keep-selection': true } : {})}
        >
          {showSelectionBar ? (
            <div
              data-keep-selection
              className="flex flex-wrap items-center gap-2"
            >
              <span className="text-sm font-medium tabular-nums">
                {selectionCount} selected
              </span>
              {inSamplesDir ? (
                selectedBatchNodes.length > 0 && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => handleBatchCopyToPersonal(selectedBatchNodes, false)}
                    >
                      <Copy className="mr-1.5 h-4 w-4" /> Copy to Personal
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => handleBatchCopyToPersonal(selectedBatchNodes, true)}
                    >
                      <Link2 className="mr-1.5 h-4 w-4" /> Link to Personal
                    </Button>
                  </>
                )
              ) : (
                <>
                  {selectedMovableNodes.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() =>
                        setDialog({
                          type: 'move',
                          paths: selectedMovableNodes.map((n) => n.path),
                        })
                      }
                    >
                      <FolderInput className="mr-1.5 h-4 w-4" /> Move
                    </Button>
                  )}
                  {selectedBatchNodes.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => {
                        runCellSegmentationOn(selectedBatchNodes.map((n) => n.path));
                        exitMultiSelectMode();
                      }}
                    >
                      <Shapes className="mr-1.5 h-4 w-4 shrink-0" /> Detect Cells
                    </Button>
                  )}
                  {selectedMovableNodes.length === 0 && selectedBatchNodes.length === 0 && (
                    <span className="text-xs text-muted-foreground">
                      Linked items can’t be moved or re-analyzed here
                    </span>
                  )}
                </>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {!inSamplesDir && selectedMovableNodes.length > 0 && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-destructive hover:text-destructive"
                      onClick={() =>
                        setDialog({
                          type: 'delete',
                          paths: selectedMovableNodes.map((n) => n.path),
                          label:
                            selectedMovableNodes.length === 1
                              ? `"${selectedMovableNodes[0].name}"`
                              : `${selectedMovableNodes.length} selected items`,
                        })
                      }
                    >
                      <Trash2 className="mr-1.5 h-4 w-4" /> Delete
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-destructive hover:text-destructive"
                      disabled={!selectedBatchNodes.some((n) => n.attachedZarrPath)}
                      onClick={() => {
                        const zarrPaths = selectedBatchNodes
                          .map((n) => n.attachedZarrPath)
                          .filter((p): p is string => Boolean(p));
                        if (zarrPaths.length === 0) {
                          toast.warning('No analysis data to clear on the selected slides.');
                          return;
                        }
                        setDialog({
                          type: 'delete',
                          paths: zarrPaths,
                          label:
                            zarrPaths.length === 1
                              ? 'all analysis data (segmentation, classification, …) for this slide'
                              : `analysis data (segmentation, classification, …) for ${zarrPaths.length} selected slides`,
                        });
                      }}
                    >
                      <Eraser className="mr-1.5 h-4 w-4" /> Clear
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8"
                  onClick={exitMultiSelectMode}
                >
                  Done
                </Button>
              </div>
            </div>
          ) : (
          <FileHeader
            // Title intentionally empty — the StorageFolderCards tab strip
            // above already identifies the storage area. A bold heading
            // ("TissueLab Cloud Storage") on top of those cards just stacked
            // two visually-competing labels for the same thing.
            title=""
            viewMode={tableViewMode}
            setViewMode={(mode) => dispatch(setTableViewMode(mode))}
            showNonImageFiles={showNonImageFiles}
            setShowNonImageFiles={(value) => {
              dispatch(setShowNonImageFiles(value));
              // The filter changes the row count, so page 1 is the only page
              // guaranteed to exist afterwards.
              dispatch(setPagination({ offset: 0 }));
            }}
            onRefresh={() => {
              void fetchFiles(currentDirectory);
              triggerStorageRefresh();
            }}
            disableRefresh={isLoading}
            onNewFolder={() => setDialog({ type: 'create-folder' })}
            showNewFolder={canCreate}
            disableNewFolder={newFolderDisabled}
            onOpenFolder={handleFolderSelect}
            showOpenFolder={false}
            onGoUp={handleGoUp}
            canGoUp={!upButtonDisabled}
            breadcrumb={renderBreadcrumbs()}
            searchPlaceholder="Search all files..."
            searchValue={searchTerm}
            onSearchChange={handleSearch}
            onClearSearch={() => handleSearch('')}
            searchDisabled={false}
            leadingActions={
              tableViewMode !== 'table' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (isMultiSelectMode) exitMultiSelectMode();
                        else setIsMultiSelectMode(true);
                      }}
                      aria-label={isMultiSelectMode ? 'Done selecting' : 'Select'}
                      className="h-7 w-7 rounded-[6px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                    >
                      {isMultiSelectMode ? (
                        <X className="h-3.5 w-3.5" strokeWidth={2} />
                      ) : (
                        <SelectCircleIcon className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isMultiSelectMode ? 'Done' : 'Select'}
                  </TooltipContent>
                </Tooltip>
              ) : null
            }
            extraActions={
              canUpload ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => {
                        if (uploadDisabled || denyWriteToast('upload files', currentDirectory)) {
                          return;
                        }
                        dispatch(setUploadSettings({ isUploadDialogOpen: true }));
                      }}
                      disabled={uploadDisabled}
                      aria-label="Upload files"
                      className="h-7 min-w-9 px-2.5"
                    >
                      <Upload className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Upload Files</TooltipContent>
                </Tooltip>
              ) : null
            }
          />
          )}
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {/* Nothing to show yet: hold the list's shape rather than folding
                it to one line and pushing it open again. */}
            {isLoading && !error && filesToRender.length === 0 && <ListingSkeleton />}
            {/* Rows are already right for this folder and a refresh is running
                behind them (a sort, a page, a revalidating return trip). Keep
                them on screen and say so with a hairline instead. */}
            {isLoading && !error && filesToRender.length > 0 && (
              <div className="sticky top-0 z-10 h-0.5 w-full animate-pulse bg-primary/60" aria-hidden />
            )}
            {error && (
                <div className="px-3">
                  <div className="mx-auto flex max-w-xl items-center justify-center gap-2 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm text-primary">
                    <Info className="w-4 h-4" />
                    <span>{error}</span>
                  </div>
                </div>
            )}
            {!error && searchTruncated && (
                <div className="px-3 pb-2">
                  <div className="mx-auto flex max-w-xl items-center justify-center gap-2 rounded-md border border-primary/30 bg-primary/10 p-2 text-xs text-primary">
                    <Info className="w-3.5 h-3.5" />
                    <span>Too many matches to list them all — narrow the search to see the rest.</span>
                  </div>
                </div>
            )}
            {!isLoading && !error && filesToRender.length === 0 && (
                <div className="p-4 text-center text-muted-foreground">
                    {searchTerm ? `No files found for "${searchTerm}"` : "This folder is empty."}
              </div>
                )}
            {!error && filesToRender.length > 0 && (
                <div>
                  {tableViewMode === 'table' ? (
                    <div className="p-2">
                      {renderImageTable()}
                    </div>
                  ) : (
                    <>
                      {renderFileTable()}
                      {/* Empty drop zone for better UX */}
                      <div 
                        className="w-full min-h-[80px]"
                        onClick={handleListBackgroundClick}
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
          </div>
          <div className="shrink-0 border-t border-border/50">
            <FileManagerPagination
              pagination={paginationState}
              isLoading={isLoading}
              onPrevious={handlePreviousPage}
              onNext={handleNextPage}
              onPageSizeChange={handlePageSizeChange}
              onPageClick={handlePageClick}
            />
          </div>
        </CardContent>
      </Card>
      {renderDialog()}
      <UploadDialog 
        isOpen={uploadSettings.isUploadDialogOpen}
        onClose={() => {
          // Google Drive style: closing the dialog does not cancel in-flight uploads.
          setUploadJustCompleted(false);
          dispatch(setUploadSettings({
            isUploadDialogOpen: false,
            isUploading: false,
            uploadProgress: 0,
          }));
        }}
        onUpload={handleFileUpload}
        isUploading={uploadSettings.isUploading}
        uploadProgress={uploadSettings.uploadProgress}
        uploadTotalFiles={uploadSettings.uploadTotalFiles}
        uploadStatus={uploadStatus}
        onCancelChunkedUpload={async (fileId) => {
          await cancelChunkedUpload(fileId);
          refreshChunkUploadResumeHints();
        }}
        onMinimizedChange={(minimized) => { isDialogMinimizedRef.current = minimized; }}
        uploadInterrupted={uploadInterrupted}
        uploadJustCompleted={uploadJustCompleted}
        resumeHints={chunkUploadResumeHints}
        preRunAnalysis={preRunAnalysis}
        onPreRunAnalysisChange={setPreRunAnalysis}
      />

      {/* Overwrite confirmation dialog - Google Drive style: Cancel, Overwrite, Keep both */}
      <Dialog open={overwriteDialogOpen} onOpenChange={(open) => {
        setOverwriteDialogOpen(open);
        if (!open && overwriteResolverRef.current) {
          overwriteResolverRef.current('cancel');
          overwriteResolverRef.current = null;
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>File conflict</DialogTitle>
            <DialogDescription className="break-all">
              {overwriteConflictDesc || `The following files already exist: ${overwriteFiles.map(f => f.name).join(', ')}`}
              <br />
              {'Choose how to handle the conflict.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <DialogClose asChild>
              <Button
                variant="outline"
                onClick={() => {
                  if (overwriteResolverRef.current) {
                    overwriteResolverRef.current('cancel');
                    overwriteResolverRef.current = null;
                  }
                  setOverwriteDialogOpen(false);
                }}
              >
                Cancel Upload
              </Button>
            </DialogClose>
            <Button
              variant="outline"
              onClick={() => {
                if (overwriteResolverRef.current) {
                  overwriteResolverRef.current('keep_both');
                  overwriteResolverRef.current = null;
                }
                setOverwriteDialogOpen(false);
              }}
            >
              Keep both
            </Button>
            <Button
              onClick={() => {
                if (overwriteResolverRef.current) {
                  overwriteResolverRef.current('overwrite');
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
      
      {/* Per-file progress is shown inside UploadDialog and the minimized widget */}
      
      {/* Overwrite confirmation dialog for compression/extraction */}
      <Dialog open={overwriteCompressDialogOpen} onOpenChange={(open) => {
        if (!open) resetOverwriteCompressDialog();
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Overwrite Confirmation</DialogTitle>
            <DialogDescription className="break-all">
              {`The file/folder "${overwriteTargetName}" already exists at this location.`}
              <br />
              {'Do you want to overwrite it?'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" onClick={resetOverwriteCompressDialog}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              onClick={async () => {
                const action = overwriteAction;
                resetOverwriteCompressDialog();
                if (action) await action();
              }}
            >
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Copy-to-Personal: confirm + optional analysis (.zarr) copy ── */}
      <Dialog open={!!copyDialogItem} onOpenChange={(open) => { if (!open) setCopyDialogItem(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Copy to Personal</DialogTitle>
            <DialogDescription>
              {copyDialogItem?.is_dir
                ? `Copy the slides in “${copyDialogItem?.name}” into your Personal folder.`
                : `Copy “${copyDialogItem?.name}” into your Personal folder.`}
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={copyIncludeZarr}
              onChange={(e) => setCopyIncludeZarr(e.target.checked)}
            />
            <span>
              <span className="font-medium">Also copy analysis results (.zarr)</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Includes segmentation + cell classification + annotations. Larger — counts against your storage quota. Leave off to copy just the raw slide.
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyDialogItem(null)}>Cancel</Button>
            <Button
              onClick={() => {
                const it = copyDialogItem;
                const inc = copyIncludeZarr;
                setCopyDialogItem(null);
                if (it) handleCopyToPersonal(it, 0, false, inc);
              }}
            >
              <Copy className="h-4 w-4 mr-2" />
              Copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Copy-to-Personal: Error dialog (quota / generic) ── */}
      <AlertDialog open={copyErrorDialogOpen} onOpenChange={setCopyErrorDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copyErrorTitle}</AlertDialogTitle>
            {copyErrorMessage ? (
              <AlertDialogDescription className="whitespace-pre-line">
                {copyErrorMessage}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setCopyErrorDialogOpen(false)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={uploadWarningDialogOpen} onOpenChange={setUploadWarningDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Not enough storage space</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              {uploadWarningMessage}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setUploadWarningDialogOpen(false)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default WebFileManager;
