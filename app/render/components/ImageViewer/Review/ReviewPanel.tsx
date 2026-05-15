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
import { useReview, useNucleiClasses } from "@/hooks/useReview";
import { useUserInfo } from "@/provider/UserInfoProvider";
import {
  setReviewSession,
  clearReviewSession,
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
  ReviewCandidate,
} from "@/store/slices/reviewSlice";
import { updateNucleiClass } from "@/store/slices/viewer/annotationSlice";
import { apiFetch } from '@/utils/common/apiFetch';
import { getErrorMessage } from "@/utils/common/apiResponse";
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config";
import EventBus from "@/utils/EventBus";

import ClassList from "./ClassList";
import ProbabilityCurve from "./ProbabilityCurve";
import CandidateGallery from "./CandidateGallery";
import ReclassificationToast from "./ReclassificationToast";
import { ShuffleCandidatesDialog } from "./ShuffleCandidatesDialog";
import { Button } from "@/components/ui/button";
import { Shuffle } from "lucide-react";

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
  const reviewState = useReview();
  
  // Get user info for permission check
  const { userInfo } = useUserInfo();
  const currentUserId = userInfo?.user_id || '';
  const ALLOWED_USER_ID = 'Ws2ZFfBLRZcRrXMtnvlesE2JwS13';
  const canUseShuffle = currentUserId === ALLOWED_USER_ID;
  
  // MULTI-USER ISOLATION: Get activeInstanceId for per-instance storage
  const activeInstanceId = useSelector((state: RootState) => state.wsi.activeInstanceId);
  
  // Helper function to generate headers with instance_id for multi-user isolation
  const getApiHeaders = useCallback(() => {
    return activeInstanceId ? { 'X-Instance-ID': activeInstanceId } : undefined;
  }, [activeInstanceId]);
  
  // Batch processing: Cells pending reclassification Map<cellId, newClassName> // Mark cells pending reclassification
  const [pendingReclassifications, setPendingReclassifications] = useState<Map<string, string>>(new Map());
  // Track confirmed cells (YES button clicked), used to prevent duplicate confirmations 
  const [confirmedCells, setConfirmedCells] = useState<Set<string>>(new Set());
  
  // Track container width for responsive ProbabilityCurve
  const containerRef = useRef<HTMLDivElement>(null);
  const [curveWidth, setCurveWidth] = useState(560);
  
  // Update curve width based on container size
  useEffect(() => {
    const updateCurveWidth = () => {
      if (containerRef.current) {
        const width = containerRef.current.offsetWidth;
        // Set min 280px, max 560px
        setCurveWidth(Math.max(280, Math.min(560, width - 32)));
      }
    };
    
    updateCurveWidth();
    
    // Use ResizeObserver for better performance
    const resizeObserver = new ResizeObserver(updateCurveWidth);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    
    return () => {
      resizeObserver.disconnect();
    };
  }, [isVisible]);
  
  // Get current path from Redux (like ClassificationPanelContent does)
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  
  // Selected candidate state for Target Cell panel
  const [selectedCandidate, setSelectedCandidate] = useState<ReviewCandidate | null>(null);
  
  // Cache histogram data to prevent chart flickering during threshold changes
  const [cachedHistogram, setCachedHistogram] = useState<number[]>([]);
  // Track if we've fetched the full histogram for the current class
  const [hasFullHistogram, setHasFullHistogram] = useState(false);
  const [currentHistogramClass, setCurrentHistogramClass] = useState<string | null>(null);
  
  // Track threshold-specific loading to prevent showing stale data
  const [thresholdLoading, setThresholdLoading] = useState(false);
  const [lastLoadedThreshold, setLastLoadedThreshold] = useState<number | null>(null);
  const requestingThresholdRef = useRef<number | null>(null); // Track threshold being requested
  
  // Request cancellation to prevent race conditions
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // Filter for showing/hiding reclassified cells
  const [showReclassified, setShowReclassified] = useState(true);
  
  // Track which side of threshold to view: 'left' (prob < threshold) or 'right' (prob >= threshold)
  const [thresholdSide, setThresholdSide] = useState<"left" | "right">("left");

  // Shuffle candidates dialog state
  const [shuffleDialogOpen, setShuffleDialogOpen] = useState(false);
  
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
    if (pendingReclassifications.size === 0 || !reviewState.slideId) return;
    
    // Process all pending reclassifications in batch
    const promises = [];
    // Use Array.from to avoid TypeScript iterator errors
    const entries = Array.from(pendingReclassifications.entries());
    
    // Count reclassification quantity for each target class, used for updating counts
    const classChangeCounts = new Map<string, number>();
    
    for (const [cellId, newClass] of entries) {
      const candidate = reviewState.items.find(item => item.cell_id === cellId);
      if (candidate) {
        // Count changes for each target class
        classChangeCounts.set(newClass, (classChangeCounts.get(newClass) || 0) + 1);
        
        // Get color for the new class
        const classObj = nucleiClasses.find(c => c.name === newClass);
        const finalColor = classObj?.color || '#808080';
        
        const payload = {
          slide_id: reviewState.slideId,
          cell_id: cellId,
          original_class: reviewState.className,
          new_class: newClass,
          prob: candidate.prob,
          centroid_x: candidate.centroid?.x,
          centroid_y: candidate.centroid?.y,
          cell_color: finalColor,
          is_manual_reclassification: true
        };
        
        promises.push(
          apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/reclassify`, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: getApiHeaders(),
            returnAxiosFormat: true,
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
      
      // Trigger refresh - both annotations counts and WebSocket data reload
      EventBus.emit('refresh-annotations');
      // Trigger WebSocket path refresh to reload annotations and centroids for overlay update
      if (reviewState.slideId) {
        const zarrPath = reviewState.slideId.endsWith('.zarr') ? reviewState.slideId : `${reviewState.slideId}.zarr`;
        EventBus.emit('refresh-websocket-path', { path: reviewState.slideId.replace(/\.zarr$/, ''), forceReload: true });
      }
    } catch (error) {
      console.error('[AL] Error submitting reclassifications:', error);
    }
  }, [pendingReclassifications, reviewState.slideId, reviewState.className, reviewState.items, nucleiClasses, dispatch]);
  
  // Expose methods to parent component
  React.useImperativeHandle(ref, () => ({
    submitPendingReclassifications,
    getPendingReclassificationsCount: () => pendingReclassifications.size
  }), [submitPendingReclassifications, pendingReclassifications]);
  
  // Clean up Active Learning state when slide changes
  useEffect(() => {
    if (currentPath && currentPath !== reviewState.slideId) {
      // Force clear session to prevent immediate refetch
      dispatch(clearReviewSession());
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
  }, [currentPath, reviewState.slideId, dispatch]);
  
  // Batch processing: Submit pending reclassifications when switching classes
  useEffect(() => {
    if (reviewState.className !== currentHistogramClass && currentHistogramClass !== null) {
      // Class has been switched, submit pending reclassifications
      submitPendingReclassifications();
      // Clear confirmed cells (because switched to new class)
      setConfirmedCells(new Set());
    }
  }, [reviewState.className, currentHistogramClass, submitPendingReclassifications]);

  // Get target class from Redux state (set by ClassificationPanelContent)
  const targetClass = useMemo(() => {
    if (!reviewState.className || !nucleiClasses || nucleiClasses.length === 0) return null;
    const classObj = nucleiClasses.find(cls => cls.name === reviewState.className);
    return classObj || null;
  }, [reviewState.className, nucleiClasses]);

  // Fetch candidates data
  const fetchCandidates = useCallback(async () => {
    if (!reviewState.slideId) {
      return;
    }

    if (!reviewState.className) {
      return;
    }


    // Cancel any ongoing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    
    // Clear old data when starting new request (prevents showing wrong class data)
    // Only clear if className changed to prevent flashing during pagination
    const isClassChange = currentHistogramClass !== reviewState.className;
    if (isClassChange) {
      dispatch(setCandidatesData({ total: 0, hist: [], items: [] }));
    }
    
    dispatch(setCandidatesLoading(true));
    
    // Set threshold loading if threshold changed (regardless of hasFullHistogram)
    const isThresholdChange = currentHistogramClass === reviewState.className && 
                              lastLoadedThreshold !== null &&
                              lastLoadedThreshold !== reviewState.threshold;
    
    if (isThresholdChange) {
      setThresholdLoading(true);
    }

    try {
      // Store the current class name to check consistency after API calls
      const requestClassName = reviewState.className;
      const requestThreshold = reviewState.threshold;
      
      // Track requesting threshold immediately (ref updates are synchronous)
      requestingThresholdRef.current = requestThreshold;
      
      // Check if we need to fetch the full histogram for a new class
      const needFullHistogram = !hasFullHistogram || currentHistogramClass !== reviewState.className;
      
      // Prepare API parameters with ROI data
      const apiParams: any = {
        slide_id: reviewState.slideId,
        class_name: reviewState.className,  // Target class for active learning
        // OPTIMIZATION: Always use actual threshold, let backend cache handle histogram
        threshold: reviewState.threshold,  
        sort: reviewState.sort || "asc",   // Sort order: "asc" = Low→High, "desc" = High→Low
        limit: reviewState.pageSize,
        offset: reviewState.page * reviewState.pageSize,
        exclude_reclassified: !showReclassified,  // New parameter to control reclassified cells
        side: thresholdSide,  // "left" (prob < threshold) or "right" (prob >= threshold)
      };

      // Get ROI cell IDs if ROI is specified (reuse existing logic)
      if (reviewState.roi && reviewState.roi.rectangleCoords) {
        
        try {
          const rect = reviewState.roi.rectangleCoords;
          
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
          
          
          // Query cells in ROI using the same image coordinates as the viewer / Zarr centroids
          try {
            const queryResponse = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/query?${new URLSearchParams({
              x1: String(rectX1),
              y1: String(rectY1),
              x2: String(rectX2),
              y2: String(rectY2),
              file_path: reviewState.slideId
            }).toString()}`, {
              method: 'GET',
              returnAxiosFormat: true,
            });

            const queryData = queryResponse.data?.data || queryResponse.data;
            const matchingIndices = queryData?.matching_indices || [];

            if (matchingIndices.length > 0) {
              apiParams.cell_ids = matchingIndices.join(',');
            }
          } catch (error) {
          }
          
        } catch (roiError) {
        }
      } else if (reviewState.roi && reviewState.roi.polygonPoints) {
      } else {
      }

      const fullUrl = `${AI_SERVICE_API_ENDPOINT}/review/v1/candidates`;
      const urlWithParams = new URL(fullUrl);
      Object.entries(apiParams).forEach(([key, value]) => {
        urlWithParams.searchParams.append(key, String(value));
      });
      
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/candidates`, {
        method: 'POST',
        body: JSON.stringify(apiParams),
        signal: abortController.signal,
        headers: getApiHeaders(),
        returnAxiosFormat: true,
      });
      
      if (response.data) {
        // Check if class changed during API call - if so, ignore this response
        if (requestClassName !== reviewState.className) {
          return;
        }
        
        let total, hist, items;
        const root = response.data as Record<string, any>;
        const actualData = root.data ?? root;
        total = actualData.total;
        hist = actualData.hist || actualData.histogram_bins || [];
        items = actualData.items || actualData.candidates || [];



        // SIMPLIFIED: No double request, backend cache handles everything
        // Cache histogram if this is a new class
        const needFullHistogram = !hasFullHistogram || currentHistogramClass !== reviewState.className;
        
        if (needFullHistogram) {
          // Update histogram class even if hist is empty (to show empty state)
          setCachedHistogram(hist && hist.length > 0 ? hist : []);
          setHasFullHistogram(true);
          setCurrentHistogramClass(reviewState.className);
        }
        
        // Update candidates with received data
        dispatch(setCandidatesData({
          total: total || 0,
          hist: hist || cachedHistogram || [],
          items: items || []
        }));
        
        // Mark threshold as loaded
        setLastLoadedThreshold(requestThreshold);
        requestingThresholdRef.current = null; // Clear requesting threshold
        setThresholdLoading(false);
        
      }
    } catch (error: any) {
      // Don't handle aborted requests as errors
      if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
        return;
      }
      
      dispatch(setCandidatesError(getErrorMessage(error, 'Failed to fetch candidates')));
      requestingThresholdRef.current = null; // Clear requesting threshold on error
      setThresholdLoading(false);
    }
  }, [reviewState.slideId, reviewState.className, reviewState.threshold, reviewState.sort, reviewState.page, reviewState.pageSize, reviewState.roi, dispatch, hasFullHistogram, currentHistogramClass, cachedHistogram, showReclassified, thresholdSide]); // eslint-disable-line react-hooks/exhaustive-deps



  // Fetch candidates when dependencies change - using ref to avoid infinite loop
  const fetchCandidatesRef = useRef(fetchCandidates);
  fetchCandidatesRef.current = fetchCandidates;
  
  // Clear confirmed cells when page changes
  useEffect(() => {
    setConfirmedCells(new Set());
  }, [reviewState.page]);
  
  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    
    if (isVisible && reviewState.slideId && reviewState.className) {
      // Reset threshold test flag when class changes
      if (window._alThresholdTested && window._lastTestedClass !== reviewState.className) {
        window._alThresholdTested = false;
        window._lastTestedClass = reviewState.className;
      }
      
      // Clear histogram cache when class changes
      if (currentHistogramClass !== reviewState.className) {
        setCachedHistogram([]);
        setHasFullHistogram(false);
        setThresholdLoading(false);
        setLastLoadedThreshold(null);
      }
      
      fetchCandidatesRef.current();
    }
  }, [isVisible, reviewState.slideId, reviewState.className, reviewState.threshold, reviewState.sort, reviewState.page, reviewState.roi, showReclassified, thresholdSide]); // eslint-disable-line react-hooks/exhaustive-deps
  // Note: currentHistogramClass removed from deps to prevent double-fetch when class changes

  // Label a candidate
  const handleLabelCandidate = async (cellId: string, label: 1 | 0) => {

    if (!reviewState.slideId) {
      return;
    }

    try {
      // Get candidate to check current label state
      const candidate = reviewState.items.find(item => item.cell_id === cellId);
      if (!candidate) return;

      // IMPORTANT: Yes/No are mutually exclusive - only one can be selected at a time
      // If user clicks the same button again, toggle it off
      // If user clicks the other button, first ensure the opposite is cleared
      
      // For YES button
      if (label === 1) {
        const isAlreadyConfirmed = confirmedCells.has(cellId);
        const isNoSelected = candidate.label === 0;
        const isPendingReclassification = pendingReclassifications.has(cellId);
        
        // If NO was selected, user cannot select YES until NO is cleared
        if (isNoSelected) {
          // Silently ignore this click - YES and NO are mutually exclusive
          // User must first deselect NO before selecting YES
          console.log('[AL] YES blocked: NO is already selected for cell', cellId);
          return;
        }
        
        // If pending reclassification, user cannot select YES until reclassification is cancelled
        if (isPendingReclassification) {
          console.log('[AL] YES blocked: Cell is pending reclassification to', pendingReclassifications.get(cellId));
          return;
        }
        
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
          const targetClassIndex = nucleiClasses.findIndex(c => c.name === reviewState.className);
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
          await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/reclassify`, {
            method: 'POST',
            body: JSON.stringify({
              slide_id: reviewState.slideId,
              cell_id: cellId,
              original_class: reviewState.className,  // It's currently in this class
              new_class: 'unclassified',  // Move back to unclassified (special marker for removal)
              prob: candidate?.prob || 0,
              is_manual_reclassification: false  // Mark as cancellation
            }),
            headers: getApiHeaders(),
            returnAxiosFormat: true,
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
      
      // For NO button
      if (label === 0) {
        const isYesSelected = candidate.label === 1 || confirmedCells.has(cellId);
        
        // If YES was selected, user cannot select NO until YES is cleared
        if (isYesSelected) {
          // Silently ignore this click - YES and NO are mutually exclusive
          // User must first deselect YES before selecting NO
          console.log('[AL] NO blocked: YES is already selected for cell', cellId, 
            'candidate.label=', candidate.label, 'confirmedCells.has=', confirmedCells.has(cellId));
          return;
        }
        
        // If NO is already selected, toggle it off
        if (candidate.label === 0) {
          // Toggle OFF the NO button
          dispatch(labelCandidate({ cell_id: cellId, label: undefined }));
          return;
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
        const targetClassObj = nucleiClasses.find(c => c.name === reviewState.className);
        
        const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/reclassify`, {
          method: 'POST',
          body: JSON.stringify({
            slide_id: reviewState.slideId,
            cell_id: cellId,
            original_class: 'unclassified', // Use 'unclassified' as a special marker
            new_class: reviewState.className,
            prob: candidate?.prob || 0,
            centroid_x: candidate.centroid?.x,
            centroid_y: candidate.centroid?.y,
            cell_color: targetClassObj?.color || '#808080',
            is_manual_reclassification: true
          }),
          headers: getApiHeaders(),
          returnAxiosFormat: true,
        });

        // For YES, manually increment the class count without triggering full refresh
        // This avoids the flickering issue with other classes
        const targetClassIndex = nucleiClasses.findIndex(c => c.name === reviewState.className);
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
      } else {
        // NO button - use original label API
        const apiPayload = {
          slide_id: reviewState.slideId,
          class_name: reviewState.className,
          cell_id: cellId,
          label,
          prob: candidate?.prob || 0
        };

        const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/label`, {
          method: 'POST',
          body: JSON.stringify(apiPayload),
          headers: getApiHeaders(),
          returnAxiosFormat: true,
        });

        // For NO, trigger full refresh as it may involve reclassification
        EventBus.emit('refresh-annotations');
        EventBus.emit('refresh-websocket-path', { path: currentPath, forceReload: true });
      }

    } catch (error: any) {
      // Revert optimistic update on error
      const candidate = reviewState.items.find(item => item.cell_id === cellId);
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

    if (!reviewState.slideId) {
      return;
    }

    try {

      // Get candidate data
      const candidate = reviewState.items.find(item => item.cell_id === cellId);
      if (!candidate) {
        return;
      }

      // Store original data for undo including the original class name
      const originalData = {
        cellId: cellId,
        originalLabel: candidate.label,
        originalClass: reviewState.className || undefined // Store the original class name
      };

      // Get color for the new class
      const newClassObj = nucleiClasses.find(cls => cls.name === newClass);
      const newClassColor = newClassObj?.color || '#808080';

      // Debug: Log candidate data
      console.log('[AL Frontend] Candidate data:', {
        cellId,
        centroid: candidate.centroid,
        centroid_x: candidate.centroid?.x,
        centroid_y: candidate.centroid?.y,
        color: newClassColor
      });

      // Send reclassification to backend
      const payload = {
        slide_id: reviewState.slideId,
        cell_id: cellId,
        original_class: reviewState.className,
        new_class: newClass,
        prob: candidate.prob,
        // Pass centroid and color from frontend to avoid reading zarr again
        centroid_x: candidate.centroid?.x,
        centroid_y: candidate.centroid?.y,
        cell_color: newClassColor,
        // Add flag to indicate this is a manual reclassification action
        is_manual_reclassification: true
      };

      console.log('[AL Frontend] Sending payload:', payload);

      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/reclassify`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: getApiHeaders(),
        returnAxiosFormat: true,
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
      
      // Refresh candidates after reclassification to remove the cell from current pool
      // This is necessary because the cell has moved to a different class
      setTimeout(() => {
        fetchCandidatesRef.current();
      }, 150);

    } catch (error: any) {

      // Check if this is a 404 - API might not exist yet, fallback to label=0
      if (error.response?.status === 404) {
        dispatch(labelCandidate({ cell_id: cellId, label: 0 }));

        // Show toast for fallback behavior too
        setToastData({
          isVisible: true,
          cellId: cellId,
          newClassName: newClass,
          originalData: { cellId: cellId, originalLabel: 0, originalClass: reviewState.className || undefined }
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
    if (!toastData.originalData || !reviewState.slideId) return;

    try {
      const { cellId, originalLabel, originalClass } = toastData.originalData as any;


      // Restore to original label in Redux
      dispatch(labelCandidate({
        cell_id: cellId,
        label: (originalLabel !== undefined ? originalLabel : 0) as 0 | 1
      }));

      // Send undo to backend (restore to original class)
      const undoResponse = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/reclassify`, {
        method: 'POST',
        body: JSON.stringify({
          slide_id: reviewState.slideId,
          cell_id: cellId,
          original_class: toastData.newClassName,
          new_class: originalClass || reviewState.className, // Restore to original class
          prob: 0, // Probability doesn't matter for undo
          is_manual_reclassification: true
        }),
        headers: getApiHeaders(),
        returnAxiosFormat: true,
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
    if (!reviewState.slideId) return;

    try {
      // Send remove request to backend
      await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/remove`, {
        method: 'POST',
        body: JSON.stringify({
          slide_id: reviewState.slideId,
          cell_id: cellId
        }),
        headers: getApiHeaders(),
        returnAxiosFormat: true,
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

  if (!Array.isArray(nucleiClasses) || !reviewState) return null;

  return (
    <div ref={containerRef} className="flex-1 p-2 sm:p-3 lg:p-4 border-l border-gray-200 h-full flex flex-col relative">
      <div className="flex flex-col gap-2 sm:gap-3 flex-1 min-h-0">
        {/* Header */}
        <div>
          <div className="flex items-center justify-between mb-1 sm:mb-2">
            <h5 className="font-medium text-base sm:text-lg">🔄 Active Learning</h5>
            {/* Shuffle button - only visible for authorized user, uses currentPath instead of reviewState.slideId */}
            {currentPath && canUseShuffle && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShuffleDialogOpen(true)}
                className="flex items-center gap-2"
                title="Shuffle candidates and get AI suggestions"
              >
                <Shuffle className="w-4 h-4" />
                <span className="hidden sm:inline">Shuffle Candidates</span>
                <span className="sm:hidden">Shuffle</span>
              </Button>
            )}
          </div>
          <p className="text-xs sm:text-sm text-gray-600 mb-1 leading-tight">
            Active learning enhances nuclei classification by identifying cells with the most uncertain predictions. 
            Review and correct these prioritized candidates to improve model performance and reduce annotation workload.
          </p>
        </div>

        {/* Show message when no class is selected */}
        {!reviewState.className ? (
          <div className="flex items-center justify-center flex-1 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
            <div className="text-center">
              <p className="text-gray-500 text-lg mb-2">No class selected</p>
              <p className="text-gray-400 text-sm">Please select a cell class from the classification panel to view Active Learning candidates</p>
            </div>
          </div>
        ) : (
          <>
            {/* Probability Threshold Panel - responsive */}
            <div className="flex-shrink-0 w-full">
              <div className="w-full overflow-x-auto">
                <ProbabilityCurve
                  data={cachedHistogram.length > 0 ? cachedHistogram : (reviewState?.hist || [])}
                  initialThreshold={reviewState?.threshold || 0.5}
                  onChange={(value) => dispatch(setThreshold(value))}
                  loading={reviewState?.loading && cachedHistogram.length === 0}
                  width={curveWidth}
                  height={Math.max(150, Math.min(220, curveWidth * 0.35))}
                />
              </div>
              {/* Threshold Side Toggle */}
              <div className="flex items-center justify-center gap-2 mt-2">
                <span className="text-xs text-gray-600">View:</span>
                <div className="flex gap-1 bg-gray-100 rounded-md p-1">
                  <button
                    onClick={() => {
                      setThresholdSide("left");
                    }}
                    className={`px-3 py-1 text-xs rounded transition-colors ${
                      thresholdSide === "left"
                        ? "bg-white shadow-sm font-medium text-gray-900"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    Left (prob &lt; threshold)
                  </button>
                  <button
                    onClick={() => {
                      setThresholdSide("right");
                    }}
                    className={`px-3 py-1 text-xs rounded transition-colors ${
                      thresholdSide === "right"
                        ? "bg-white shadow-sm font-medium text-gray-900"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    Right (prob &gt;= threshold)
                  </button>
                </div>
              </div>
            </div>

            {/* Candidate Gallery - takes remaining space */}
            <div className="flex-1 min-h-0">
              <CandidateGallery
                candidates={
                  // Show candidates if class matches AND (data is current OR loading OR requesting)
                  (currentHistogramClass === reviewState.className && 
                   (lastLoadedThreshold === reviewState.threshold || 
                    requestingThresholdRef.current === reviewState.threshold ||
                    reviewState?.loading || 
                    thresholdLoading))
                    ? (reviewState?.items || [])
                    : []
                }
                loading={reviewState?.loading || thresholdLoading || (currentHistogramClass !== reviewState.className)}
                error={reviewState?.error || null}
                total={
                  // Show total if class matches AND (data is current OR loading OR requesting)
                  (currentHistogramClass === reviewState.className && 
                   (lastLoadedThreshold === reviewState.threshold || requestingThresholdRef.current === reviewState.threshold || reviewState?.loading || thresholdLoading))
                    ? (reviewState?.total || 0) 
                    : 0
                }
                page={reviewState?.page || 0}
                selectedCandidateId={selectedCandidate?.cell_id}
                slideId={currentPath || undefined} // Pass the current file path from Redux state
                pageSize={reviewState?.pageSize || 12}
                zoom={1}
                sort={reviewState?.sort || 'asc'}
                showReclassified={showReclassified}
                availableClasses={nucleiClasses ? nucleiClasses.filter(cls => cls.name !== reviewState.className).map(cls => ({
                  id: cls.name,
                  name: cls.name,
                  color: cls.color
                })) : []}
                targetClassName={reviewState?.className}
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

      {/* Shuffle Candidates Dialog */}
      {currentPath && (
        <ShuffleCandidatesDialog
          open={shuffleDialogOpen}
          onOpenChange={setShuffleDialogOpen}
          slideId={currentPath}
        />
      )}
    </div>
  );
});


// Add displayName for debugging purposes
ActiveLearningPanel.displayName = 'ActiveLearningPanel';

export default ActiveLearningPanel;
