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

interface PaginationState {
  offset: number;
  limit: number | null;
  total: number;
  hasMore: boolean;
}

interface ProjectData {
  projectName: string;
  wsiFiles: string[];
  createdAt: string;
  lastModified: string;
}

interface FolderData {
  folderName: string;
  wsiFiles: string[];
  createdAt: string;
  lastModified: string;
  fileTree: any;
}

interface FileManagerState {
  selectedFolder: string;
  fileList: FileItem[];
  isLoading: boolean;
  error: string | null;
  searchTerm: string;
  isMinimized: boolean;
  associatedModels: string[];
  viewMode: 'full' | 'nameOnly';
  showNonImageFiles: boolean;
  currentDirectory: string;
  fileTree: any[];
  selectedFiles: string[];
  sortConfig: SortConfig;
  tableViewMode: 'tree' | 'table';
  expandedFolders: string[];
  lastVisitedPath: string;
  currentImagePath: string | null;
  uploadSettings: {
    isUploading: boolean;
    uploadProgress: number;
    uploadTotalFiles: number;
    isUploadDialogOpen: boolean;
  };
  pagination: PaginationState;
  projectData: ProjectData | null;
  currentFolder: FolderData | null;
}

const initialState: FileManagerState = {
  selectedFolder: '',
  fileList: [],
  isLoading: false,
  error: null,
  searchTerm: '',
  isMinimized: true,
  associatedModels: [],
  viewMode: 'nameOnly',
  showNonImageFiles: false,
  currentDirectory: '',
  fileTree: [],
  selectedFiles: [],
  sortConfig: { key: 'mtime', direction: 'desc' },
  tableViewMode: 'tree',
  expandedFolders: [],
  lastVisitedPath: '',
  currentImagePath: null,
  uploadSettings: {
    isUploading: false,
    uploadProgress: 0,
    uploadTotalFiles: 0,
    isUploadDialogOpen: false,
  },
  pagination: {
    offset: 0,
    limit: 10,
    total: 0,
    hasMore: false,
  },
  projectData: null,
  currentFolder: null,
};

const fileManagerSlice = createSlice({
  name: 'fileManager',
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
    setCurrentImagePath: (state, action: PayloadAction<string | null>) => {
      state.currentImagePath = action.payload;
    },
    setUploadSettings: (state, action: PayloadAction<Partial<FileManagerState['uploadSettings']>>) => {
      state.uploadSettings = { ...state.uploadSettings, ...action.payload };
    },
    setPagination: (state, action: PayloadAction<Partial<PaginationState>>) => {
      state.pagination = { ...state.pagination, ...action.payload };
    },
    resetPagination: (state) => {
      state.pagination = {
        offset: 0,
        limit: state.pagination.limit,
        total: 0,
        hasMore: false,
      };
    },
    setProjectData: (state, action: PayloadAction<ProjectData>) => {
      state.projectData = action.payload;
    },
    updateProjectFiles: (state, action: PayloadAction<string[]>) => {
      if (state.projectData) {
        state.projectData.wsiFiles = action.payload;
        state.projectData.lastModified = new Date().toISOString();
      }
    },
    clearProject: (state) => {
      state.projectData = null;
    },
    removeFileFromProject: (state, action: PayloadAction<string>) => {
      if (state.projectData) {
        state.projectData.wsiFiles = state.projectData.wsiFiles.filter(
          file => file !== action.payload
        );
        state.projectData.lastModified = new Date().toISOString();
      }
    },
    addFileToProject: (state, action: PayloadAction<string>) => {
      if (state.projectData) {
        state.projectData.wsiFiles.push(action.payload);
        state.projectData.lastModified = new Date().toISOString();
      }
    },
    setCurrentFolder: (state, action: PayloadAction<FolderData>) => {
      state.currentFolder = action.payload;
    },
    setFolderName: (state, action: PayloadAction<string>) => {
      if (state.currentFolder) {
        state.currentFolder.folderName = action.payload;
      }
    },
    setFolderFileTree: (state, action: PayloadAction<any>) => {
      if (state.currentFolder) {
        state.currentFolder.fileTree = action.payload;
      }
    },
    updateFolderFiles: (state, action: PayloadAction<string[]>) => {
      if (state.currentFolder) {
        state.currentFolder.wsiFiles = action.payload;
        state.currentFolder.lastModified = new Date().toISOString();
      }
    },
    updateCurrentFolder: (state, action: PayloadAction<Partial<FolderData>>) => {
      if (state.currentFolder) {
        state.currentFolder = { ...state.currentFolder, ...action.payload };
      }
    },
    addFileToCurrentFolder: (state, action: PayloadAction<string>) => {
      if (state.currentFolder) {
        state.currentFolder.wsiFiles.push(action.payload);
        state.currentFolder.lastModified = new Date().toISOString();
      }
    },
    removeFileFromCurrentFolder: (state, action: PayloadAction<string>) => {
      if (state.currentFolder) {
        state.currentFolder.wsiFiles = state.currentFolder.wsiFiles.filter(
          file => file !== action.payload
        );
        state.currentFolder.lastModified = new Date().toISOString();
      }
    },
    clearCurrentFolder: (state) => {
      state.currentFolder = null;
    },
    resetFileManager: (state) => {
      return initialState;
    },
    preserveSettings: (state, action: PayloadAction<Partial<FileManagerState>>) => {
      const { uploadSettings, projectData, currentFolder, ...settingsToPreserve } = action.payload;
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
  setCurrentImagePath,
  setUploadSettings,
  setPagination,
  resetPagination,
  setProjectData,
  updateProjectFiles,
  clearProject,
  removeFileFromProject,
  addFileToProject,
  setCurrentFolder,
  setFolderName,
  setFolderFileTree,
  updateFolderFiles,
  updateCurrentFolder,
  addFileToCurrentFolder,
  removeFileFromCurrentFolder,
  clearCurrentFolder,
  resetFileManager,
  preserveSettings,
} = fileManagerSlice.actions;

export default fileManagerSlice.reducer;

export type { FileItem, SortConfig, PaginationState, ProjectData, FolderData, FileManagerState };

