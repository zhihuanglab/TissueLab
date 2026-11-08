import { useEffect, useRef } from 'react';
import { useDispatch, useSelector, useStore } from 'react-redux';
import { RootState } from '@/store/index';
import { 
  setCurrentDirectory, 
  setFileTree, 
  setSelectedFiles, 
  setSortConfig, 
  setTableViewMode, 
  setShowNonImageFiles,
  addExpandedFolder,
  removeExpandedFolder
} from '@/store/slices/fileManagerSlice';

export const useFileManagerPreservation = (storageKey: string = 'fileManagerState') => {
  const dispatch = useDispatch();
  const store = useStore<RootState>();
  // Set once the restore effect has run; saving waits for it so defaults never overwrite saved state.
  const restoredRef = useRef(false);
  const {
    currentDirectory,
    fileTree,
    selectedFiles,
    sortConfig,
    tableViewMode,
    showNonImageFiles,
    searchTerm,
    expandedFolders,
    lastVisitedPath
  } = useSelector((state: RootState) => state.fileManager);

  // Restore state from localStorage on mount
  useEffect(() => {
    // Check if we're in a browser environment
    if (typeof window === 'undefined') {
      return;
    }
    restoredRef.current = true;
    
    const savedState = localStorage.getItem(storageKey);
    if (savedState) {
      try {
        const parsedState = JSON.parse(savedState);
        
        // Restore all settings except fileTree (which needs to be fetched from server)
        if (parsedState.currentDirectory) {
          dispatch(setCurrentDirectory(parsedState.currentDirectory));
        }
        if (parsedState.selectedFiles) {
          dispatch(setSelectedFiles(parsedState.selectedFiles));
        }
        if (parsedState.sortConfig) {
          dispatch(setSortConfig(parsedState.sortConfig));
        }
        if (parsedState.tableViewMode) {
          dispatch(setTableViewMode(parsedState.tableViewMode));
        }
        if (parsedState.showNonImageFiles !== undefined) {
          dispatch(setShowNonImageFiles(parsedState.showNonImageFiles));
        }
        // searchTerm is deliberately not restored: a search is transient, and
        // restoring the term without re-running it shows an empty folder as
        // "No files found" (R-DASH-05).
        if (parsedState.expandedFolders) {
          parsedState.expandedFolders.forEach((folder: string) => {
            dispatch(addExpandedFolder(folder));
          });
        }
      } catch (error) {
        console.error('Failed to restore file manager state:', error);
      }
    }
  }, [dispatch, storageKey]);

  // Save state to localStorage when it changes. Declared after the restore
  // effect and gated on it: on mount the restore runs first, and the values are
  // read from the store (not this render's closure, which still holds the
  // defaults) so the freshly restored state is what gets written back.
  useEffect(() => {
    // Check if we're in a browser environment
    if (typeof window === 'undefined' || !restoredRef.current) {
      return;
    }
    const latest = store.getState().fileManager;
    
    const stateToSave = {
      currentDirectory: latest.currentDirectory,
      selectedFiles: latest.selectedFiles,
      sortConfig: latest.sortConfig,
      tableViewMode: latest.tableViewMode,
      showNonImageFiles: latest.showNonImageFiles,
      searchTerm: latest.searchTerm,
      expandedFolders: latest.expandedFolders,
      lastVisitedPath: latest.lastVisitedPath
    };
    
    localStorage.setItem(storageKey, JSON.stringify(stateToSave));
  }, [
    store,
    storageKey,
    currentDirectory,
    selectedFiles,
    sortConfig,
    tableViewMode,
    showNonImageFiles,
    searchTerm,
    expandedFolders,
    lastVisitedPath
  ]);

  return {
    currentDirectory,
    fileTree,
    selectedFiles,
    sortConfig,
    tableViewMode,
    showNonImageFiles,
    searchTerm,
    expandedFolders,
    lastVisitedPath
  };
};
