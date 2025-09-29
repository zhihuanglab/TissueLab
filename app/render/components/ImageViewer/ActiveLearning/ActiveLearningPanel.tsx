"use client";

import React, { useEffect, useCallback, useState, useMemo, useRef } from "react";

// Extend Window interface for Active Learning globals
declare global {
  interface Window {
    _alThresholdTested?: boolean;
    _lastTestedClass?: string;
  }
}
import { useDispatch, useSelector } from "react-redux";
import { AppDispatch, RootState } from "@/store";
import { useActiveLearning, useNucleiClasses } from "@/hooks/useActiveLearning";
import {
  setActiveLearningSession,
  clearActiveLearningSession,
  setClassFilter,
  toggleClassInFilter,
  setThreshold,
  setZoom,
  setSort,
  setPage,
  setCandidatesLoading,
  setCandidatesData,
  setCandidatesError,
  labelCandidate,
  ALCandidate,
} from "@/store/slices/activeLearningSlice";
import { updateNucleiClass } from "@/store/slices/annotationSlice";
import http from "@/utils/http";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import EventBus from "@/utils/EventBus";

import ClassList from "./ClassList";
import ProbabilityCurve from "./ProbabilityCurve";
import CandidateGallery from "./CandidateGallery";
import ReclassificationToast from "./ReclassificationToast";

interface ActiveLearningPanelProps {
  selectedCell: {
    cellId: string;
    centroid: { x: number; y: number };
    slideId: string;
  } | null;
  isVisible: boolean;
  onSelectedCellChange?: (selectedCell: {
    cellId: string;
    centroid: { x: number; y: number };
    slideId: string;
  }) => void;
  // New: Notify parent component of pending submission count changes 
  onPendingCountChange?: (count: number) => void;
  // New: ref for exposing internal methods
  ref?: React.Ref<ActiveLearningPanelRef>;
}

// Exposed methods interface
export interface ActiveLearningPanelRef {
  submitPendingReclassifications: () => Promise<void>;
  getPendingReclassificationsCount: () => number;
}

export const ActiveLearningPanel = React.forwardRef<ActiveLearningPanelRef, ActiveLearningPanelProps>(({
  selectedCell,
  isVisible,
  onSelectedCellChange,
  onPendingCountChange,
}, ref) => {
  
  const dispatch = useDispatch<AppDispatch>();
  
  // Redux state using safe hooks
  const nucleiClasses = useNucleiClasses();
  const alState = useActiveLearning();
  
  // Batch processing: Cells pending reclassification Map<cellId, newClassName> // Mark cells pending reclassification
  const [pendingReclassifications, setPendingReclassifications] = useState<Map<string, string>>(new Map());
  // Track confirmed cells (YES button clicked), used to prevent duplicate confirmations 
  const [confirmedCells, setConfirmedCells] = useState<Set<string>>(new Set());
  
  // Get current path from Redux (like ClassificationPanelContent does)
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  
  // Selected candidate state for Target Cell panel
  const [selectedCandidate, setSelectedCandidate] = useState<ALCandidate | null>(null);
  
  // Cache histogram data to prevent chart flickering during threshold changes
  const [cachedHistogram, setCachedHistogram] = useState<number[]>([]);
  // Track if we've fetched the full histogram for the current class
  const [hasFullHistogram, setHasFullHistogram] = useState(false);
  const [currentHistogramClass, setCurrentHistogramClass] = useState<string | null>(null);
  
  // Track threshold-specific loading to prevent showing stale data
  const [thresholdLoading, setThresholdLoading] = useState(false);
  const [lastLoadedThreshold, setLastLoadedThreshold] = useState<number | null>(null);
  
  // Request cancellation to prevent race conditions
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // Filter for showing/hiding reclassified cells
  const [showReclassified, setShowReclassified] = useState(true);
  
  // Toast and undo state
  const [toastData, setToastData] = useState<{
    isVisible: boolean;
    cellId: string;
    newClassName: string;
    originalData?: {
      cellId: string;
      originalLabel?: number;
      originalClass?: string;
    };
  }>({ isVisible: false, cellId: '', newClassName: '' });
  
  // Batch processing: Handle pending reclassification selection //new add
  const handlePendingReclassification = useCallback((cellId: string, newClass: string) => {
    setPendingReclassifications(prev => {
      const newMap = new Map(prev);
      newMap.set(cellId, newClass);
      return newMap;
    });
  }, []);
  
  // Batch processing: Cancel pending reclassification
  const handleCancelPendingReclassification = useCallback((cellId: string) => {
    setPendingReclassifications(prev => {
      const newMap = new Map(prev);
      newMap.delete(cellId);
      return newMap;
    });
  }, []);
  
  // Notify parent component of pending submission count changes
  useEffect(() => {
    if (onPendingCountChange) {
      onPendingCountChange(pendingReclassifications.size);
    }
  }, [pendingReclassifications.size, onPendingCountChange]);
  
  // Batch processing: Submit all pending reclassifications in batch
  const submitPendingReclassifications = useCallback(async () => {
    if (pendingReclassifications.size === 0 || !alState.slideId) return;
    
    // Process all pending reclassifications in batch
    const promises = [];
    // Use Array.from to avoid TypeScript iterator errors
    const entries = Array.from(pendingReclassifications.entries());
    
    // Count reclassification quantity for each target class, used for updating counts
    const classChangeCounts = new Map<string, number>();
    
    for (const [cellId, newClass] of entries) {
      const candidate = alState.items.find(item => item.cell_id === cellId);
      if (candidate) {
        // Count changes for each target class
        classChangeCounts.set(newClass, (classChangeCounts.get(newClass) || 0) + 1);
        
        promises.push(
          http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/reclassify`, {
            slide_id: alState.slideId,
            cell_id: cellId,
            original_class: alState.className,
            new_class: newClass,
            prob: candidate.prob,
            is_manual_reclassification: true
          })
        );
        
        // Remove this candidate from UI
        dispatch(labelCandidate({ cell_id: cellId, label: 0 }));
      }
    }
    
    try {
      await Promise.all(promises);
      
      // Update class count: target class +n, current class unchanged (because these are predicted cells, not manually annotated)
      // Note: According to user requirements, when reclassifying from predicted class to other classes, original class count remains unchanged
      classChangeCounts.forEach((count, className) => {
        const targetClassIndex = nucleiClasses.findIndex(c => c.name === className);
        if (targetClassIndex !== -1) {
          const targetClass = nucleiClasses[targetClassIndex];
          dispatch(updateNucleiClass({
            index: targetClassIndex,
            newClass: {
              ...targetClass,
              count: targetClass.count + count
            }
          }));
        }
      });
      
      // Clear pending reclassification list
      setPendingReclassifications(new Map());
      
      // Trigger refresh
      EventBus.emit('refresh-annotations');
      
      // Refresh candidate list
      setTimeout(() => {
        fetchCandidatesRef.current();
      }, 100);
    } catch (error) {
      console.error('[AL] Error submitting reclassifications:', error);
    }
  }, [pendingReclassifications, alState.slideId, alState.className, alState.items, nucleiClasses, dispatch]);
  
  // Expose methods to parent component
  React.useImperativeHandle(ref, () => ({
    submitPendingReclassifications,
    getPendingReclassificationsCount: () => pendingReclassifications.size
  }), [submitPendingReclassifications, pendingReclassifications]);
  
  // Clean up Active Learning state when slide changes
  useEffect(() => {
    if (currentPath && currentPath !== alState.slideId) {
      // Force clear session to prevent immediate refetch
      dispatch(clearActiveLearningSession());
      dispatch(setCandidatesData({ total: 0, hist: Array(20).fill(0), items: [] }));
      dispatch(setCandidatesLoading(false));
      dispatch(setCandidatesError(null));
      setSelectedCandidate(null);
      setCachedHistogram([]);
      setHasFullHistogram(false);
      setCurrentHistogramClass(null);
      setThresholdLoading(false);
      setLastLoadedThreshold(null);
      // Clear pending reclassification list
      setPendingReclassifications(new Map());
      // Clear confirmed cells
      setConfirmedCells(new Set());
    }
  }, [currentPath, alState.slideId, dispatch]);
  
  // Batch processing: Submit pending reclassifications when switching classes
  useEffect(() => {
    if (alState.className !== currentHistogramClass && currentHistogramClass !== null) {
      // Class has been switched, submit pending reclassifications
      submitPendingReclassifications();
      // Clear confirmed cells (because switched to new class)
      setConfirmedCells(new Set());
    }
  }, [alState.className, currentHistogramClass, submitPendingReclassifications]);

  // Get target class from Redux state (set by ClassificationPanelContent)
  const targetClass = useMemo(() => {
    if (!alState.className || !nucleiClasses || nucleiClasses.length === 0) return null;
    const classObj = nucleiClasses.find(cls => cls.name === alState.className);
    return classObj || null;
  }, [alState.className, nucleiClasses]);

  // Fetch candidates data
  const fetchCandidates = useCallback(async () => {
    if (!alState.slideId) {
      return;
    }

    if (!alState.className) {
      return;
    }


    // Cancel any ongoing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    
    dispatch(setCandidatesLoading(true));
    
    // Set threshold loading if this is a threshold-only change
    const isThresholdOnlyChange = hasFullHistogram && 
                                  currentHistogramClass === alState.className && 
                                  lastLoadedThreshold !== alState.threshold;
    
    if (isThresholdOnlyChange) {
      setThresholdLoading(true);
    }

    try {
      // Store the current class name to check consistency after API calls
      const requestClassName = alState.className;
      const requestThreshold = alState.threshold;
      
      // Check if we need to fetch the full histogram for a new class
      const needFullHistogram = !hasFullHistogram || currentHistogramClass !== alState.className;
      
      // Prepare API parameters with ROI data
      const apiParams: any = {
        slide_id: alState.slideId,
        class_name: alState.className,  // Target class for active learning
        // If we need the full histogram, use threshold 0 to get all data
        // Otherwise use the actual threshold for candidate filtering
        threshold: needFullHistogram ? 0 : alState.threshold,  
        sort: alState.sort || "asc",   // Sort order: "asc" = Low→High, "desc" = High→Low
        limit: alState.pageSize,
        offset: alState.page * alState.pageSize,
        exclude_reclassified: !showReclassified,  // New parameter to control reclassified cells
      };

      // Get ROI cell IDs if ROI is specified (reuse existing logic)
      if (alState.roi && alState.roi.rectangleCoords) {
        
        try {
          const rect = alState.roi.rectangleCoords;
          
          // Validate rect structure (should have x1, y1, x2, y2 format)
          if (!rect || typeof rect.x1 === 'undefined' || typeof rect.y1 === 'undefined' || 
              typeof rect.x2 === 'undefined' || typeof rect.y2 === 'undefined') {
            throw new Error('Invalid ROI rectangle coordinates - expected x1,y1,x2,y2 format');
          }
          
          // Convert to numbers if they're strings  
          const rectX1 = parseFloat(rect.x1);
          const rectY1 = parseFloat(rect.y1);
          const rectX2 = parseFloat(rect.x2);
          const rectY2 = parseFloat(rect.y2);
          
          if (isNaN(rectX1) || isNaN(rectY1) || isNaN(rectX2) || isNaN(rectY2)) {
            throw new Error('ROI coordinates contain invalid numeric values');
          }
          
          
          // Test multiple scaling approaches to find cells in ROI  
          // DrawingOverlay uses ZOOM_SCALE = 16, so test that first
          const testScales = [16, 1, 0.25, 0.5, 2, 4, 8];
          let foundCells = false;
          let matchingIndices = [];
          
          
          for (const testScale of testScales) {
            const scaledX1 = rectX1 * testScale;
            const scaledY1 = rectY1 * testScale;
            const scaledX2 = rectX2 * testScale;
            const scaledY2 = rectY2 * testScale;
            
            
            try {
              const testResponse = await http.get(`${AI_SERVICE_API_ENDPOINT}/seg/v1/query`, {
                params: { 
                  x1: scaledX1, 
                  y1: scaledY1, 
                  x2: scaledX2, 
                  y2: scaledY2,
                  file_path: alState.slideId  // Add missing file_path parameter
                }
              });
              
              const testData = testResponse.data?.data || testResponse.data;
              const testIndices = testData?.matching_indices || [];
              
              
              if (testIndices.length > 0) {
                matchingIndices = testIndices;
                foundCells = true;
                break; // Use the first scale that works
              }
            } catch (error) {
            }
          }
          
          // Use the results from the scaling test above
          if (foundCells && matchingIndices.length > 0) {
            // Convert cell IDs to comma-separated string
            apiParams.cell_ids = matchingIndices.join(',');
          } else {
          }
          
        } catch (roiError) {
        }
      } else if (alState.roi && alState.roi.polygonPoints) {
      } else {
      }

      const fullUrl = `${AI_SERVICE_API_ENDPOINT}/al/v1/candidates`;
      const urlWithParams = new URL(fullUrl);
      Object.entries(apiParams).forEach(([key, value]) => {
        urlWithParams.searchParams.append(key, String(value));
      });
      
      
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/candidates`, apiParams, {
        signal: abortController.signal
      });
      
      
      // Deep analysis of response structure
      if (response.data && response.data.data) {
        const responseData = response.data.data;
      }

      if (response.data) {
        // Check if class changed during API call - if so, ignore this response
        if (requestClassName !== alState.className) {
          return;
        }
        
        // Handle different possible response formats
        let total, hist, items;

        if (response.data.code === 0 && response.data.data) {
          // Format: {code: 0, message: 'Success', data: {...}}
          const actualData = response.data.data;
          total = actualData.total;
          hist = actualData.hist || actualData.histogram_bins || [];
          items = actualData.items || actualData.candidates || [];
        } else if (response.data.total !== undefined || response.data.candidates !== undefined) {
          // Direct format: {total: N, candidates: [...], histogram_bins: [...]}
          total = response.data.total;
          hist = response.data.hist || response.data.histogram_bins || [];
          items = response.data.items || response.data.candidates || [];
        } else {
          // Fallback - treat entire response as data
          total = response.data.total || 0;
          hist = response.data.hist || response.data.histogram_bins || [];
          items = response.data.items || response.data.candidates || [];
        }



        // Check if we fetched the full histogram
        const needFullHistogram = !hasFullHistogram || currentHistogramClass !== alState.className;
        
        // If this was a full histogram fetch, cache it and mark as fetched
        if (needFullHistogram && hist && hist.length > 0) {
          setCachedHistogram(hist);
          setHasFullHistogram(true);
          setCurrentHistogramClass(alState.className);
          
          // If we fetched with threshold 0 for the histogram, but user wants different threshold,
          // we need to fetch again with the actual threshold for candidates
          if (alState.threshold > 0) {
            // Fetch again with actual threshold for candidates only
            const actualApiParams = { ...apiParams, threshold: alState.threshold, exclude_reclassified: !showReclassified };
            const actualResponse = await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/candidates`, actualApiParams, {
              signal: abortController.signal
            });
            
            // Check again if class changed during the second API call
            if (requestClassName !== alState.className) {
              return;
            }
            
            if (actualResponse.data) {
              let actualTotal, actualItems;
              
              if (actualResponse.data.code === 0 && actualResponse.data.data) {
                const actualData = actualResponse.data.data;
                actualTotal = actualData.total;
                actualItems = actualData.items || actualData.candidates || [];
              } else {
                actualTotal = actualResponse.data.total || 0;
                actualItems = actualResponse.data.items || actualResponse.data.candidates || [];
              }
              
              // Update only candidates, keep the cached histogram
              dispatch(setCandidatesData({
                total: actualTotal || 0,
                hist: cachedHistogram.length > 0 ? cachedHistogram : hist,  // Use cached histogram
                items: actualItems || []
              }));
              
              // Mark threshold as loaded
              setLastLoadedThreshold(requestThreshold);
              setThresholdLoading(false);
            }
          } else {
            // If threshold is 0, just use the data we got
            dispatch(setCandidatesData({
              total: total || 0,
              hist: hist || [],
              items: items || []
            }));
            
            // Mark threshold as loaded
            setLastLoadedThreshold(requestThreshold);
            setThresholdLoading(false);
          }
        } else {
          // Normal update - use cached histogram if available, don't update it
          dispatch(setCandidatesData({
            total: total || 0,
            hist: cachedHistogram.length > 0 ? cachedHistogram : hist,  // Keep using cached histogram
            items: items || []
          }));
          
          // Mark threshold as loaded
          setLastLoadedThreshold(requestThreshold);
          setThresholdLoading(false);
        }
        
      }
    } catch (error: any) {
      // Don't handle aborted requests as errors
      if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
        return;
      }
      
      const errorMessage = error.response?.data?.message || error.message || 'Failed to fetch candidates';
      dispatch(setCandidatesError(errorMessage));
      setThresholdLoading(false);
    }
  }, [alState.slideId, alState.className, alState.threshold, alState.sort, alState.page, alState.pageSize, alState.roi, dispatch, hasFullHistogram, currentHistogramClass, cachedHistogram, showReclassified]); // eslint-disable-line react-hooks/exhaustive-deps



  // Fetch candidates when dependencies change - using ref to avoid infinite loop
  const fetchCandidatesRef = useRef(fetchCandidates);
  fetchCandidatesRef.current = fetchCandidates;
  
  // Clear confirmed cells when page changes
  useEffect(() => {
    setConfirmedCells(new Set());
  }, [alState.page]);
  
  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    
    if (isVisible && alState.slideId && alState.className) {
      // Reset threshold test flag when class changes
      if (window._alThresholdTested && window._lastTestedClass !== alState.className) {
        window._alThresholdTested = false;
        window._lastTestedClass = alState.className;
      }
      
      // Clear histogram cache when class changes
      if (currentHistogramClass !== alState.className) {
        setCachedHistogram([]);
        setHasFullHistogram(false);
        setThresholdLoading(false);
        setLastLoadedThreshold(null);
        // Immediately clear candidates data to prevent showing wrong class cells
        dispatch(setCandidatesData({ total: 0, hist: [], items: [] }));
      }
      
      fetchCandidatesRef.current();
    }
  }, [isVisible, alState.slideId, alState.className, alState.threshold, alState.sort, alState.page, alState.roi, currentHistogramClass, showReclassified]); // eslint-disable-line react-hooks/exhaustive-deps

  // Label a candidate
  const handleLabelCandidate = async (cellId: string, label: 1 | 0) => {

    if (!alState.slideId) {
      return;
    }

    try {
      // Get candidate to check current label state
      const candidate = alState.items.find(item => item.cell_id === cellId);
      if (!candidate) return;

      // For YES button, check if this cell was already confirmed
      if (label === 1) {
        const isAlreadyConfirmed = confirmedCells.has(cellId);
        
        if (isAlreadyConfirmed) {
          // Toggle OFF the YES button - user is cancelling the confirmation
          
          // Remove from confirmed cells set
          setConfirmedCells(prev => {
            const newSet = new Set(prev);
            newSet.delete(cellId);
            return newSet;
          });
          
          // Update UI to remove the label
          dispatch(labelCandidate({ cell_id: cellId, label: undefined }));
          
          // Decrement the class count since we're cancelling the confirmation
          const targetClassIndex = nucleiClasses.findIndex(c => c.name === alState.className);
          if (targetClassIndex !== -1) {
            const targetClass = nucleiClasses[targetClassIndex];
            dispatch(updateNucleiClass({
              index: targetClassIndex,
              newClass: {
                ...targetClass,
                count: Math.max(0, targetClass.count - 1) // Ensure count doesn't go negative
              }
            }));
          }
          
          // Call API to remove the reclassification from backend
          // Use reclassify API to move it back (this will remove it from _reclassified_cells)
          await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/reclassify`, {
            slide_id: alState.slideId,
            cell_id: cellId,
            original_class: alState.className,  // It's currently in this class
            new_class: 'unclassified',  // Move back to unclassified (special marker for removal)
            prob: candidate?.prob || 0,
            is_manual_reclassification: false  // Mark as cancellation
          });
          
          return;
        } else {
          // Add to confirmed cells set
          setConfirmedCells(prev => {
            const newSet = new Set(prev);
            newSet.add(cellId);
            return newSet;
          });
        }
      }

      // Optimistically update UI
      dispatch(labelCandidate({ cell_id: cellId, label }));

      // For YES (label=1), confirm the classification
      // For NO (label=0), use the label API as before
      if (label === 1) {
        // YES button - confirm this cell belongs to the current class
        // Since label API has backend bug with 'is_original_manual', use reclassify API
        // Use a special marker to indicate this is a YES confirmation
        const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/reclassify`, {
          slide_id: alState.slideId,
          cell_id: cellId,
          original_class: 'unclassified', // Use 'unclassified' as a special marker
          new_class: alState.className,
          prob: candidate?.prob || 0,
          is_manual_reclassification: true
        });

        // For YES, manually increment the class count without triggering full refresh
        // This avoids the flickering issue with other classes
        const targetClassIndex = nucleiClasses.findIndex(c => c.name === alState.className);
        if (targetClassIndex !== -1) {
          const targetClass = nucleiClasses[targetClassIndex];
          dispatch(updateNucleiClass({
            index: targetClassIndex,
            newClass: {
              ...targetClass,
              count: targetClass.count + 1
            }
          }));
        }

        // Don't trigger any refresh to avoid flickering
      } else {
        // NO button - use original label API
        const apiPayload = {
          slide_id: alState.slideId,
          class_name: alState.className,
          cell_id: cellId,
          label,
          prob: candidate?.prob || 0
        };

        const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/label`, apiPayload);

        // For NO, trigger full refresh as it may involve reclassification
        EventBus.emit('refresh-annotations');
        EventBus.emit('refresh-websocket-path', { path: currentPath, forceReload: true });
      }

    } catch (error: any) {
      // Revert optimistic update on error
      const candidate = alState.items.find(item => item.cell_id === cellId);
      if (candidate) {
        dispatch(labelCandidate({
          cell_id: cellId,
          label: candidate.label === 1 ? 0 : 1 // Revert to opposite
        }));
      }
    }
  };

  // Handle reclassification with Toast and undo support
  const handleReclassifyCandidate = async (cellId: string, newClass: string) => {

    if (!alState.slideId) {
      return;
    }

    try {

      // Get candidate data
      const candidate = alState.items.find(item => item.cell_id === cellId);
      if (!candidate) {
        return;
      }

      // Store original data for undo including the original class name
      const originalData = {
        cellId: cellId,
        originalLabel: candidate.label,
        originalClass: alState.className || undefined // Store the original class name
      };

      // Send reclassification to backend
      const response = await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/reclassify`, {
        slide_id: alState.slideId,
        cell_id: cellId,
        original_class: alState.className,
        new_class: newClass,
        prob: candidate.prob,
        // Add flag to indicate this is a manual reclassification action
        is_manual_reclassification: true
      });

      console.log('[AL] Reclassification response:', response.data);

      // Remove from current candidate pool
      dispatch(labelCandidate({ cell_id: cellId, label: 0 }));

      // Show toast notification with undo option
      setToastData({
        isVisible: true,
        cellId: cellId,
        newClassName: newClass,
        originalData: originalData
      });

      // Trigger refresh after successful reclassification
      // Only emit refresh-annotations which will be handled by ClassificationPanelContent
      EventBus.emit('refresh-annotations');

      // Refresh candidates after a short delay to ensure backend state is updated
      setTimeout(() => {
        // Don't clear cached histogram - keep it stable
        fetchCandidatesRef.current();
      }, 100); // Short delay to ensure backend update is complete
      // fetchCandidates() will be called if user doesn't undo within 5 seconds

    } catch (error: any) {

      // Check if this is a 404 - API might not exist yet, fallback to label=0
      if (error.response?.status === 404) {
        dispatch(labelCandidate({ cell_id: cellId, label: 0 }));

        // Show toast for fallback behavior too
        setToastData({
          isVisible: true,
          cellId: cellId,
          newClassName: newClass,
          originalData: { cellId: cellId, originalLabel: 0, originalClass: alState.className || undefined }
        });

      } else {
        // For any other error, still mark as label=0 to remove from pool
        dispatch(labelCandidate({ cell_id: cellId, label: 0 }));
      }
    }
  };

  // Handle toast dismiss
  const handleToastDismiss = useCallback(() => {
    setToastData(prev => ({ ...prev, isVisible: false }));
    // Don't refresh candidates immediately - let the Redux state change persist
    // The backend will handle filtering reclassified cells when candidates are next fetched
  }, []);

  // Handle undo reclassification
  const handleUndoReclassification = async () => {
    if (!toastData.originalData || !alState.slideId) return;

    try {
      const { cellId, originalLabel, originalClass } = toastData.originalData as any;


      // Restore to original label in Redux
      dispatch(labelCandidate({
        cell_id: cellId,
        label: (originalLabel !== undefined ? originalLabel : 0) as 0 | 1
      }));

      // Send undo to backend (restore to original class)
      const undoResponse = await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/reclassify`, {
        slide_id: alState.slideId,
        cell_id: cellId,
        original_class: toastData.newClassName,
        new_class: originalClass || alState.className, // Restore to original class
        prob: 0, // Probability doesn't matter for undo
        is_manual_reclassification: true
      });

      console.log('[AL] Undo reclassification response:', undoResponse.data);

      // Trigger backend refresh after undo
      EventBus.emit('refresh-annotations');

      // Refresh candidates but keep the cached histogram
      fetchCandidates();
      
    } catch (error: any) {
      
      // If undo API fails, still restore the UI optimistically
      if (toastData.originalData) {
        dispatch(labelCandidate({ 
          cell_id: toastData.originalData.cellId, 
          label: (toastData.originalData.originalLabel !== undefined ? toastData.originalData.originalLabel : 0) as 0 | 1
        }));
      }
    }
  };

  // Remove a candidate from the class
  const handleRemoveCandidate = async (cellId: string) => {
    if (!alState.slideId) return;

    try {
      // Send remove request to backend
      await http.post(`${AI_SERVICE_API_ENDPOINT}/al/v1/remove`, {
        slide_id: alState.slideId,
        cell_id: cellId
      });

      // Refresh candidates after removal
      fetchCandidates();
    } catch (error: any) {
      // Silent error handling
    }
  };

  //Handle candidate click
  const handleCandidateClick = useCallback((clickedCandidate: any) => {
    
    // Toggle selection - if clicking the same candidate, deselect it
    // This prevents the "sticking" behavior mentioned in requirements
    if (selectedCandidate?.cell_id === clickedCandidate.cell_id) {
      setSelectedCandidate(null);
      return;
    }
    
    // Update local state for UI highlighting
    setSelectedCandidate(clickedCandidate);
    
    // Auto-clear selection after 3 seconds to prevent sticking
    setTimeout(() => {
      setSelectedCandidate(null);
    }, 3000);
    
    if (onSelectedCellChange && clickedCandidate.centroid && clickedCandidate.slideId) {
      const selectedCellData = {
        cellId: clickedCandidate.cell_id,
        nuclei_id: clickedCandidate.nuclei_id, 
        centroid: clickedCandidate.centroid,
        slideId: clickedCandidate.slideId,
        // Include contour data for direct access like nucstat.contour
        contour: clickedCandidate.contour,
        // Pass through all data for compatibility
        ...clickedCandidate
      };
      
      onSelectedCellChange(selectedCellData);
    } else {
    }
  }, [selectedCandidate, onSelectedCellChange]);

  if (!isVisible) {
    return null;
  }

  if (!Array.isArray(nucleiClasses) || !alState) return null;

  return (
    <div className="flex-1 p-4 border-l border-gray-200 h-full flex flex-col relative">
      <div className="flex flex-col gap-3 flex-1 min-h-0">
        {/* Header */}
        <div>
          <h5 className="font-medium mb-2 text-lg">🔄 Active Learning</h5>
          <p className="text-sm text-gray-600 mb-1">
            Active learning enhances nuclei classification by identifying cells with the most uncertain predictions. 
            Review and correct these prioritized candidates to improve model performance and reduce annotation workload.
          </p>
        </div>

        {/* Show message when no class is selected */}
        {!alState.className ? (
          <div className="flex items-center justify-center flex-1 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
            <div className="text-center">
              <p className="text-gray-500 text-lg mb-2">No class selected</p>
              <p className="text-gray-400 text-sm">Please select a cell class from the classification panel to view Active Learning candidates</p>
            </div>
          </div>
        ) : (
          <>
            {/* Probability Threshold Panel - fixed height */}
            <div className="flex-shrink-0">
              <ProbabilityCurve
                data={cachedHistogram.length > 0 ? cachedHistogram : (alState?.hist || [])}
                initialThreshold={alState?.threshold || 0.5}
                onChange={(value) => dispatch(setThreshold(value))}
                loading={alState?.loading && cachedHistogram.length === 0}
                width={560}
                height={220}
              />
            </div>

            {/* Candidate Gallery - takes remaining space */}
            <div className="flex-1 min-h-0">
              <CandidateGallery
                candidates={
                  // Show candidates if they match current class and threshold, 
                  // OR if we have valid histogram for current class (for immediate UI updates like reclassification)
                  (currentHistogramClass === alState.className && 
                   (lastLoadedThreshold === alState.threshold || hasFullHistogram)) 
                    ? (alState?.items || []) 
                    : []
                }
                loading={alState?.loading || thresholdLoading || (currentHistogramClass !== alState.className) || (lastLoadedThreshold !== alState.threshold && !hasFullHistogram)}
                error={alState?.error || null}
                total={
                  // Show total if data matches current class and threshold, or if we have histogram for this class
                  (currentHistogramClass === alState.className && 
                   (lastLoadedThreshold === alState.threshold || hasFullHistogram)) 
                    ? (alState?.total || 0) 
                    : 0
                }
                page={alState?.page || 0}
                selectedCandidateId={selectedCandidate?.cell_id}
                slideId={currentPath || undefined} // Pass the current file path from Redux state
                pageSize={alState?.pageSize || 12}
                zoom={1}
                sort={alState?.sort || 'asc'}
                showReclassified={showReclassified}
                availableClasses={nucleiClasses ? nucleiClasses.filter(cls => cls.name !== alState.className).map(cls => ({
                  id: cls.name,
                  name: cls.name,
                  color: cls.color
                })) : []}
                targetClassName={alState?.className}
                onPageChange={(page) => dispatch(setPage(page))}
                onSortChange={(sort) => dispatch(setSort(sort))}
                onShowReclassifiedChange={setShowReclassified}
                onLabelCandidate={handleLabelCandidate}
                onRemoveCandidate={handleRemoveCandidate}
                onReclassifyCandidate={handleReclassifyCandidate}
                onRetry={() => {
                  fetchCandidates();
                }}
                onCandidateClick={handleCandidateClick}
                // Batch processing related
                pendingReclassifications={pendingReclassifications}
                onPendingReclassification={handlePendingReclassification}
                onCancelPendingReclassification={handleCancelPendingReclassification}
              />
            </div>
          </>
        )}
      </div>
      
      {/* Reclassification Toast */}
      <ReclassificationToast
        isVisible={toastData.isVisible}
        cellId={toastData.cellId}
        newClassName={toastData.newClassName}
        onUndo={handleUndoReclassification}
        onDismiss={handleToastDismiss}
      />
    </div>
  );
});


// Add displayName for debugging purposes
ActiveLearningPanel.displayName = 'ActiveLearningPanel';

export default ActiveLearningPanel;