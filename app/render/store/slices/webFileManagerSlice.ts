import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
  children?: FileItem[];
  depth?: number;
}

interface SortConfig {
  key: 'name' | 'mtime' | 'size' | 'type';
  direction: 'asc' | 'desc';
}

interface WebFileManagerState {
  selectedFolder: string;
  fileList: FileItem[];
  isLoading: boolean;
  error: string | null;
  searchTerm: string;
  isMinimized: boolean;
  associatedModels: string[];
  viewMode: 'full' | 'nameOnly';
  showNonImageFiles: boolean;
  // New fields for preserving settings across page navigation
  currentDirectory: string;
  fileTree: any[];
  selectedFiles: string[];
  sortConfig: SortConfig;
  tableViewMode: 'tree' | 'table';
  expandedFolders: string[];
  lastVisitedPath: string;
  uploadSettings: {
    isUploading: boolean;
    uploadProgress: number;
    isUploadDialogOpen: boolean;
  };
}

const initialState: WebFileManagerState = {
  selectedFolder: '',
  fileList: [],
  isLoading: false,
  error: null,
  searchTerm: '',
  isMinimized: true,
  associatedModels: [],
  viewMode: 'nameOnly',
  showNonImageFiles: false,
  // Initialize new fields
  currentDirectory: '',
  fileTree: [],
  selectedFiles: [],
  sortConfig: { key: 'mtime', direction: 'desc' },
  tableViewMode: 'tree',
  expandedFolders: [],
  lastVisitedPath: '',
  uploadSettings: {
    isUploading: false,
    uploadProgress: 0,
    isUploadDialogOpen: false,
  },
};

const webFileManagerSlice = createSlice({
  name: 'webFileManager',
  initialState,
  reducers: {
    setSelectedFolder: (state, action: PayloadAction<string>) => {
      state.selectedFolder = action.payload;
    },
    setFileList: (state, action: PayloadAction<FileItem[]>) => {
      state.fileList = action.payload;
    },
    setIsLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },
    setSearchTerm: (state, action: PayloadAction<string>) => {
      state.searchTerm = action.payload;
    },
    setIsMinimized: (state, action: PayloadAction<boolean>) => {
      state.isMinimized = action.payload;
    },
    setAssociatedModels: (state, action: PayloadAction<string[]>) => {
      state.associatedModels = action.payload;
    },
    setViewMode: (state, action: PayloadAction<'full' | 'nameOnly'>) => {
      state.viewMode = action.payload;
    },
    setShowNonImageFiles: (state, action: PayloadAction<boolean>) => {
      state.showNonImageFiles = action.payload;
    },
    // New reducers for preserving settings
    setCurrentDirectory: (state, action: PayloadAction<string>) => {
      state.currentDirectory = action.payload;
      state.lastVisitedPath = action.payload;
    },
    setFileTree: (state, action: PayloadAction<any[]>) => {
      state.fileTree = action.payload;
    },
    setSelectedFiles: (state, action: PayloadAction<string[]>) => {
      state.selectedFiles = action.payload;
    },
    setSortConfig: (state, action: PayloadAction<SortConfig>) => {
      state.sortConfig = action.payload;
    },
    setTableViewMode: (state, action: PayloadAction<'tree' | 'table'>) => {
      state.tableViewMode = action.payload;
    },
    setExpandedFolders: (state, action: PayloadAction<string[]>) => {
      state.expandedFolders = action.payload;
    },
    addExpandedFolder: (state, action: PayloadAction<string>) => {
      if (!state.expandedFolders.includes(action.payload)) {
        state.expandedFolders.push(action.payload);
      }
    },
    removeExpandedFolder: (state, action: PayloadAction<string>) => {
      state.expandedFolders = state.expandedFolders.filter(folder => folder !== action.payload);
    },
    setUploadSettings: (state, action: PayloadAction<Partial<WebFileManagerState['uploadSettings']>>) => {
      state.uploadSettings = { ...state.uploadSettings, ...action.payload };
    },
    resetWebFileManager: (state) => {
      return initialState;
    },
    // Preserve all settings except upload state
    preserveSettings: (state, action: PayloadAction<Partial<WebFileManagerState>>) => {
      const { uploadSettings, ...settingsToPreserve } = action.payload;
      Object.assign(state, settingsToPreserve);
    },
  },
});

export const {
  setSelectedFolder,
  setFileList,
  setIsLoading,
  setError,
  setSearchTerm,
  setIsMinimized,
  setAssociatedModels,
  setViewMode,
  setShowNonImageFiles,
  setCurrentDirectory,
  setFileTree,
  setSelectedFiles,
  setSortConfig,
  setTableViewMode,
  setExpandedFolders,
  addExpandedFolder,
  removeExpandedFolder,
  setUploadSettings,
  resetWebFileManager,
  preserveSettings,
} = webFileManagerSlice.actions;

export default webFileManagerSlice.reducer;