import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface UploadedProject {
  projectName: string;
  wsiFiles: string[];
  createdAt: string;
  lastModified: string;
}

interface UploadedFolder {
  folderName: string;
  wsiFiles: string[];
  createdAt: string;
  lastModified: string;
  fileTree: any;
}

interface UploadedFilesState {
  projectWsiFiles: UploadedProject;
  currentFolder: UploadedFolder | null;
}

const initialState: UploadedFilesState = {
  projectWsiFiles: {
    projectName: '',
    wsiFiles: [],
    createdAt: '',
    lastModified: ''
  },
  currentFolder: {
    folderName: '',
    wsiFiles: [],
    createdAt: '',
    lastModified: '',
    fileTree: {}
  }
};

const uploadedFilesSlice = createSlice({
  name: 'uploadedFiles',
  initialState,
  reducers: {
    // Project actions
    updateProject: (state, action: PayloadAction<UploadedProject>) => {
      state.projectWsiFiles = action.payload;
    },
    updateFiles: (state, action: PayloadAction<string[]>) => {
      state.projectWsiFiles.wsiFiles = action.payload;
    },
    clearUpProject: (state) => {
      state.projectWsiFiles = {
        projectName: '',
        wsiFiles: [],
        createdAt: '',
        lastModified: ''
      };
    },
    removeFileByName: (state, action: PayloadAction<string>) => {
      state.projectWsiFiles.wsiFiles = state.projectWsiFiles.wsiFiles.filter(
        file => file !== action.payload
      );
    },
    addFileToProject: (state, action: PayloadAction<string>) => {
      state.projectWsiFiles.wsiFiles.push(action.payload);
      state.projectWsiFiles.lastModified = new Date().toISOString();
    },
    // Folder actions
    setCurrentFolder: (state, action: PayloadAction<UploadedFolder>) => {
      state.currentFolder = action.payload;
    },
    setFolderName: (state, action: PayloadAction<string>) => {
      if (state.currentFolder) {
        state.currentFolder.folderName = action.payload;
      }
    },
    setFileTree: (state, action: PayloadAction<any>) => {
      if (state.currentFolder) {
        state.currentFolder.fileTree = action.payload;
      }
    },
    updateFolderFiles: (state, action: PayloadAction<string[]>) => {
      if (state.currentFolder) {
        state.currentFolder.wsiFiles = action.payload;
      }
    },
    updateCurrentFolder: (state, action: PayloadAction<Partial<UploadedFolder>>) => {
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
    }
  }
});

export const {
  updateProject,
  updateFiles,
  clearUpProject,
  removeFileByName,
  addFileToProject,
  setCurrentFolder,
  setFolderName,
  setFileTree,
  updateFolderFiles,
  updateCurrentFolder,
  addFileToCurrentFolder,
  removeFileFromCurrentFolder,
  clearCurrentFolder
} = uploadedFilesSlice.actions;

export default uploadedFilesSlice.reducer;
