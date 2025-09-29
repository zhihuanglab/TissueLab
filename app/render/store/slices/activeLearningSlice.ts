import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface ALCandidate {
  cell_id: string;
  prob: number;
  centroid: { x: number; y: number };
  crop: {
    image: string;
    bounds: { x: number; y: number; w: number; h: number };
    bbox?: { x: number; y: number; w: number; h: number };
    contour?: { x: number; y: number }[]; // Cell contour points
  };
  label?: 1 | 0; // 1=Yes, 0=No, undefined=unlabeled
}

export interface ALState {
  // Class filtering (now single selection)
  classFilter: string[]; // Kept for backward compatibility, but use selectedClass instead
  selectedClass: string | null; // Single selected class for Review mode
  
  // ROI state for Review
  roi: any | null; // Region of Interest selected by user
  
  // Threshold and histogram
  threshold: number;
  sort: 'asc' | 'desc';
  hist: number[]; // Histogram data (20 bins)
  
  // Zoom
  zoom: number;
  
  // Pagination
  page: number;
  pageSize: number;
  total: number;
  
  // Candidates data
  items: ALCandidate[];
  loading: boolean;
  error: string | null;
  
  // Current active learning session
  slideId: string | null;
  className: string | null;
  
  // UI state
  isActiveLearningOpen: boolean;
  
  // Probability distribution cache
  probDistCache: {
    key: string; // slideId + roiHash + selectedClass
    data: number[]; // histogram data
  } | null;
}

const initialState: ALState = {
  classFilter: [],
  selectedClass: null,
  roi: null,
  threshold: 0.5,
  sort: 'asc',
  hist: Array(20).fill(0),
  zoom: 90.0, // Default 90x zoom for 360px patches
  page: 0,
  pageSize: 12, // Show 3 rows x 4 columns = 12 candidates per page
  total: 0,
  items: [],
  loading: false,
  error: null,
  slideId: null,
  className: null,
  isActiveLearningOpen: false,
  probDistCache: null,
};

const activeLearningSlice = createSlice({
  name: 'activeLearning',
  initialState,
  reducers: {
    // Session management
    setActiveLearningSession: (state, action: PayloadAction<{ slideId: string; className?: string | null }>) => {
      console.log('[AL Redux] setActiveLearningSession called with:', action.payload);
      
      const newSlideId = action.payload.slideId;
      const newClassName = action.payload.className ?? null;
      
      // Check if this is the same session to avoid unnecessary reset
      const isSameSession = state.slideId === newSlideId && state.className === newClassName;
      
      if (isSameSession) {
        console.log('[AL Redux] Same session detected, skipping reset to preserve candidates');
        return; // Don't reset if it's the same session
      }
      
      console.log('[AL Redux] New session detected, resetting state');
      state.slideId = newSlideId;
      state.className = newClassName;
      console.log('[AL Redux] Updated to new session:', { slideId: newSlideId, className: newClassName });
      // Reset state when starting new session
      state.page = 0;
      state.items = [];
      state.error = null;
      state.hist = Array(20).fill(0);
    },

    clearActiveLearningSession: (state) => {
      state.slideId = null;
      state.className = null;
      state.items = [];
      state.page = 0;
      state.total = 0;
      state.error = null;
      state.hist = Array(20).fill(0);
    },

    // UI state
    setIsActiveLearningOpen: (state, action: PayloadAction<boolean>) => {
      state.isActiveLearningOpen = action.payload;
    },

    // Class filtering
    setClassFilter: (state, action: PayloadAction<string[]>) => {
      state.classFilter = action.payload;
      // Reset pagination when filter changes
      state.page = 0;
    },

    toggleClassInFilter: (state, action: PayloadAction<string>) => {
      const className = action.payload;
      const index = state.classFilter.indexOf(className);
      if (index >= 0) {
        state.classFilter.splice(index, 1);
      } else {
        state.classFilter.push(className);
      }
      // Reset pagination when filter changes
      state.page = 0;
    },

    // Single class selection for Review mode
    setSelectedClass: (state, action: PayloadAction<string | null>) => {
      state.selectedClass = action.payload;
      // Reset pagination when class selection changes
      state.page = 0;
    },

    // ROI management
    setROI: (state, action: PayloadAction<any>) => {
      state.roi = action.payload;
      // Reset pagination when ROI changes
      state.page = 0;
    },

    // Threshold
    setThreshold: (state, action: PayloadAction<number>) => {
      state.threshold = action.payload;
      // Reset pagination when threshold changes
      state.page = 0;
    },

    // Zoom
    setZoom: (state, action: PayloadAction<number>) => {
      state.zoom = action.payload;
    },


    // Sorting
    setSort: (state, action: PayloadAction<'asc' | 'desc'>) => {
      state.sort = action.payload;
      // Reset pagination when sort changes
      state.page = 0;
    },

    // Pagination
    setPage: (state, action: PayloadAction<number>) => {
      state.page = action.payload;
    },

    setPageSize: (state, action: PayloadAction<number>) => {
      state.pageSize = action.payload;
      // Reset page when page size changes
      state.page = 0;
    },

    // Data loading
    setCandidatesLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
      if (action.payload) {
        state.error = null;
      }
    },

    setCandidatesData: (state, action: PayloadAction<{
      total: number;
      hist: number[];
      items: ALCandidate[];
    }>) => {
      state.total = action.payload.total;
      state.hist = action.payload.hist;
      state.items = action.payload.items;
      state.loading = false;
      state.error = null;
    },

    setCandidatesError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
      state.loading = false;
    },

    // Individual candidate labeling
    labelCandidate: (state, action: PayloadAction<{ cell_id: string; label: 1 | 0 | undefined }>) => {
      const { cell_id, label } = action.payload;
      console.log(`[AL Redux] labelCandidate: cell_id=${cell_id}, label=${label}`);
      console.log(`[AL Redux] Before: ${state.items.length} candidates, total=${state.total}`);
      
      const candidate = state.items.find(item => item.cell_id === cell_id);
      if (candidate) {
        // If label is undefined, remove the label (for toggle off functionality)
        if (label === undefined) {
          delete candidate.label;
          console.log(`[AL Redux] Removed label for cell ${cell_id}`);
        } else {
          candidate.label = label;
          // If labeled as 0 (No), remove from candidate pool
          if (label === 0) {
            const oldLength = state.items.length;
            state.items = state.items.filter(item => item.cell_id !== cell_id);
            state.total = Math.max(0, state.total - 1);
            console.log(`[AL Redux] Removed cell ${cell_id}: ${oldLength} -> ${state.items.length} candidates`);
          }
        }
      } else {
        console.log(`[AL Redux] Warning: candidate ${cell_id} not found in current items`);
      }
      
      console.log(`[AL Redux] After: ${state.items.length} candidates, total=${state.total}`);
    },

    // Batch operations
    clearAllLabels: (state) => {
      state.items.forEach(item => {
        delete item.label;
      });
    },

    // Probability distribution cache
    setProbDistCache: (state, action: PayloadAction<{key: string; data: number[]}>) => {
      state.probDistCache = action.payload;
    },

    clearProbDistCache: (state) => {
      state.probDistCache = null;
    },

    // Reset all state
    resetActiveLearning: () => initialState,
  },
});

export const {
  setActiveLearningSession,
  clearActiveLearningSession,
  setIsActiveLearningOpen,
  setClassFilter,
  toggleClassInFilter,
  setSelectedClass,
  setROI,
  setThreshold,
  setZoom,
  setSort,
  setPage,
  setPageSize,
  setCandidatesLoading,
  setCandidatesData,
  setCandidatesError,
  labelCandidate,
  clearAllLabels,
  setProbDistCache,
  clearProbDistCache,
  resetActiveLearning,
} = activeLearningSlice.actions;

export default activeLearningSlice.reducer;