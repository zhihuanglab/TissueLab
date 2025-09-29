import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface ModelSelectionState {
  // Path-based model selection: path -> selected model name
  selectedModelsByPath: Record<string, string | null>;
  // Track available models for each path to validate selections
  availableModelsByPath: Record<string, string[]>;
  // Track if user has explicitly made a selection for each path
  userHasSelectedByPath: Record<string, boolean>;
}

// LocalStorage key for model selection
const MODEL_SELECTION_STORAGE_KEY = 'tissuelab_model_selection';

// Load initial state from localStorage
const loadInitialState = (): ModelSelectionState => {
  if (typeof window === 'undefined') {
    return {
      selectedModelsByPath: {},
      availableModelsByPath: {},
      userHasSelectedByPath: {},
    };
  }

  try {
    const stored = localStorage.getItem(MODEL_SELECTION_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        selectedModelsByPath: parsed.selectedModelsByPath || {},
        availableModelsByPath: parsed.availableModelsByPath || {},
        userHasSelectedByPath: parsed.userHasSelectedByPath || {},
      };
    }
  } catch (error) {
    console.warn('Failed to load model selection from localStorage:', error);
  }

  return {
    selectedModelsByPath: {},
    availableModelsByPath: {},
    userHasSelectedByPath: {},
  };
};

const initialState: ModelSelectionState = loadInitialState();

// Save to localStorage helper
const saveToLocalStorage = (state: ModelSelectionState) => {
  if (typeof window === 'undefined') return;
  
  try {
    localStorage.setItem(MODEL_SELECTION_STORAGE_KEY, JSON.stringify({
      selectedModelsByPath: state.selectedModelsByPath,
      availableModelsByPath: state.availableModelsByPath,
      userHasSelectedByPath: state.userHasSelectedByPath,
    }));
  } catch (error) {
    console.warn('Failed to save model selection to localStorage:', error);
  }
};

const modelSelectionSlice = createSlice({
  name: 'modelSelection',
  initialState,
  reducers: {
    // Set selected model for a specific path
    setSelectedModelForPath: (state, action: PayloadAction<{ path: string; modelName: string | null }>) => {
      const { path, modelName } = action.payload;
      state.selectedModelsByPath[path] = modelName;
      // Mark that user has made a selection for this path
      state.userHasSelectedByPath[path] = true;
      saveToLocalStorage(state);
    },

    // Clear selected model for a specific path
    clearSelectedModelForPath: (state, action: PayloadAction<string>) => {
      const path = action.payload;
      state.selectedModelsByPath[path] = null;
      // Mark that user has made a selection for this path (even if clearing)
      state.userHasSelectedByPath[path] = true;
      saveToLocalStorage(state);
    },

    // Update available models for a path
    setAvailableModelsForPath: (state, action: PayloadAction<{ path: string; models: string[] }>) => {
      const { path, models } = action.payload;
      state.availableModelsByPath[path] = models;
      
      // Validate current selection for this path
      const currentSelection = state.selectedModelsByPath[path];
      if (currentSelection && !models.includes(currentSelection)) {
        // Model no longer available, clear selection
        state.selectedModelsByPath[path] = null;
      }
      saveToLocalStorage(state);
    },

    // Get selected model for a path (helper action)
    getSelectedModelForPath: (state, action: PayloadAction<string>) => {
      // This is a read-only action, no state changes needed
      // The selector will handle the actual logic
    },

    // Validate all selections against available models
    validateAllSelections: (state) => {
      let hasChanges = false;
      Object.keys(state.selectedModelsByPath).forEach(path => {
        const selectedModel = state.selectedModelsByPath[path];
        const availableModels = state.availableModelsByPath[path] || [];
        
        if (selectedModel && !availableModels.includes(selectedModel)) {
          state.selectedModelsByPath[path] = null;
          hasChanges = true;
        }
      });
      if (hasChanges) {
        saveToLocalStorage(state);
      }
    },

    // Clear all selections
    clearAllSelections: (state) => {
      state.selectedModelsByPath = {};
      state.userHasSelectedByPath = {};
      saveToLocalStorage(state);
    },

    // Reset to initial state
    resetModelSelection: (state) => {
      return initialState;
    },

    // Auto-select first available model for a path (if user hasn't made a selection yet)
    autoSelectFirstModel: (state, action: PayloadAction<string>) => {
      const path = action.payload;
      const availableModels = state.availableModelsByPath[path] || [];
      const currentSelection = state.selectedModelsByPath[path];
      const userHasSelected = state.userHasSelectedByPath[path];
      
      // Only auto-select if:
      // 1. User hasn't made any selection for this path yet
      // 2. No current selection
      // 3. Models are available
      if (!userHasSelected && !currentSelection && availableModels.length > 0) {
        const firstModel = availableModels[0];
        state.selectedModelsByPath[path] = firstModel;
        saveToLocalStorage(state);
      }
    },

    // Remove path and its associated data
    removePath: (state, action: PayloadAction<string>) => {
      const path = action.payload;
      delete state.selectedModelsByPath[path];
      delete state.availableModelsByPath[path];
      delete state.userHasSelectedByPath[path];
      saveToLocalStorage(state);
    },
  },
});

export const {
  setSelectedModelForPath,
  clearSelectedModelForPath,
  setAvailableModelsForPath,
  getSelectedModelForPath,
  validateAllSelections,
  clearAllSelections,
  resetModelSelection,
  autoSelectFirstModel,
  removePath,
} = modelSelectionSlice.actions;

export default modelSelectionSlice.reducer;

// Selectors
export const selectSelectedModelForPath = (state: { modelSelection: ModelSelectionState }, path: string) => {
  return state.modelSelection.selectedModelsByPath[path] || null;
};

export const selectAvailableModelsForPath = (state: { modelSelection: ModelSelectionState }, path: string) => {
  return state.modelSelection.availableModelsByPath[path] || [];
};

export const selectAllSelectedModels = (state: { modelSelection: ModelSelectionState }) => {
  return state.modelSelection.selectedModelsByPath;
};

export const selectUserHasSelectedForPath = (state: { modelSelection: ModelSelectionState }, path: string) => {
  return state.modelSelection.userHasSelectedByPath[path] || false;
};
