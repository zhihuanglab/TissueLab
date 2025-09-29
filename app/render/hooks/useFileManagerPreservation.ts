import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '@/store/index';
import { 
  setCurrentDirectory, 
  setFileTree, 
  setSelectedFiles, 
  setSortConfig, 
  setTableViewMode, 
  setShowNonImageFiles,
  setSearchTerm,
  addExpandedFolder,
  removeExpandedFolder
} from '@/store/slices/webFileManagerSlice';

export const useFileManagerPreservation = () => {
  const dispatch = useDispatch();
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
  } = useSelector((state: RootState) => state.webFileManager);

  // Save state to localStorage when it changes
  useEffect(() => {
    // Check if we're in a browser environment
    if (typeof window === 'undefined') {
      return;
    }
    
    const stateToSave = {
      currentDirectory,
      selectedFiles,
      sortConfig,
      tableViewMode,
      showNonImageFiles,
      searchTerm,
      expandedFolders,
      lastVisitedPath
    };
    
    localStorage.setItem('fileManagerState', JSON.stringify(stateToSave));
  }, [
    currentDirectory,
    selectedFiles,
    sortConfig,
    tableViewMode,
    showNonImageFiles,
    searchTerm,
    expandedFolders,
    lastVisitedPath
  ]);

  // Restore state from localStorage on mount
  useEffect(() => {
    // Check if we're in a browser environment
    if (typeof window === 'undefined') {
      return;
    }
    
    const savedState = localStorage.getItem('fileManagerState');
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
        if (parsedState.searchTerm) {
          dispatch(setSearchTerm(parsedState.searchTerm));
        }
        if (parsedState.expandedFolders) {
          parsedState.expandedFolders.forEach((folder: string) => {
            dispatch(addExpandedFolder(folder));
          });
        }
      } catch (error) {
        console.error('Failed to restore file manager state:', error);
      }
    }
  }, [dispatch]);

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
