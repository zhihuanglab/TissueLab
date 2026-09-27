"use client";

import { usePathWriteAccess } from "@/hooks/usePathWriteAccess"
import React, { useEffect, useCallback, useState, useMemo, useRef } from "react";

// Extend Window interface for Active Learning globals
declare global {
  interface Window {
    _alThresholdTested?: boolean;
    _lastTestedClass?: string;
  }
}
import { useDispatch, useSelector } from "react-redux";
import { useActiveSlidePath } from "@/utils/viewer/slidePath";
import { AppDispatch, RootState } from "@/store";
import { useReview, useNucleiClasses } from "@/hooks/review/useReview";
import { useUserInfo } from "@/contexts/UserInfoProvider";
import { resolveAnnotatorLabel } from "@/utils/viewer/annotator";
import {
  clearReviewSession,
  setThreshold,
  setSort,
  setPage,
  setCandidatesLoading,
  setCandidatesData,
  setCandidatesError,
  labelCandidate,
  ReviewCandidate,
} from "@/store/slices/reviewSlice";
import {
  updateNucleiClass,
  clearPatchOverridesForIds,
  AnnotationClass,
} from "@/store/slices/viewer/annotationSlice";
import { useRefreshGtHighlightIndices } from "@/hooks/viewer/useRefreshGtHighlightIndices";
import { apiFetch, payloadFromAxiosAppResponse } from '@/utils/common/apiFetch'
import { isSegmentationHandlerNotReadyError, segFetch } from '@/utils/common/segFetch'
import { getErrorMessage } from "@/utils/common/apiResponse";
import { toast } from "sonner";
import { deleteNucleiAnnotation } from '@/services/data.service'
import { AI_SERVICE_API_ENDPOINT } from "@/config/api.config";
import eventBus from "@/utils/common/eventBus";

import ProbabilityCurve from "./ProbabilityCurve";
import CandidateGallery from "./CandidateGallery";
import { MousePointerClick, Sparkles } from "lucide-react";

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
  // Which classification this panel reviews: 'cell' (nuclei, default) or 'patch' (MUSK).
  // Drives the candidate endpoint, class-list source and save/remove endpoints.
  kind?: 'cell' | 'patch';
  // Class list to review. Cell omits it (falls back to nuclei classes); patch
  // must supply its patch/tissue classes.
  reviewClasses?: AnnotationClass[];
  // New: ref for exposing internal methods
  ref?: React.Ref<ActiveLearningPanelRef>;
}

/**
 * What a Save actually wrote, as reported by the backend — not the staged
 * count. The backend skips candidates it cannot mark (no AI prediction, or the
 * label is already the stored one), so the two numbers can differ.
 * `null` means the save failed; the panel has already shown the error.
 */
export interface ReviewSaveResult {
  marked: number;
  removed: number;
}

// Exposed methods interface
export interface ActiveLearningPanelRef {
  submitPendingReclassifications: () => Promise<ReviewSaveResult | null>;
  getPendingReclassificationsCount: () => number;
}

export const ActiveLearningPanel = React.forwardRef<ActiveLearningPanelRef, ActiveLearningPanelProps>(({
  selectedCell,
  isVisible,
  onSelectedCellChange,
  onPendingCountChange,
  kind = 'cell',
  reviewClasses: reviewClassesProp,
}, ref) => {
  // True when this panel reviews patch (MUSK) classification rather than nuclei.
  const isPatch = kind === 'patch';
  
  const dispatch = useDispatch<AppDispatch>();
  
  // Redux state using safe hooks
  const nucleiClasses = useNucleiClasses();
  // The class list under review: patch panels supply their own; cell falls back to nuclei.
  const reviewClasses = reviewClassesProp ?? nucleiClasses;
  const reviewState = useReview();

  const activeInstanceId = useSelector((state: RootState) => state.wsi.activeInstanceId);

  // The real user doing the review — sent as `annotator` so GT/review marks
  // are attributed to them rather than the backend's "Unknown" fallback.
  const { userInfo } = useUserInfo();
  
  
  // Batch processing: Cells pending reclassification Map<cellId, newClassName> // Mark cells pending reclassification
  const [pendingReclassifications, setPendingReclassifications] = useState<Map<string, string>>(new Map());
  // Track confirmed cells (YES button clicked), used to prevent duplicate confirmations
  const [confirmedCells, setConfirmedCells] = useState<Set<string>>(new Set());
  // Saved view: cells staged for removal — committed (deleted) on Save
  const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(new Set());
  
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
  
  // Get current path from Redux (like ClassificationPanel does)
  const currentPath = useActiveSlidePath();
  const { assertWritable, allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(currentPath ?? reviewState.slideId);
  // GT (yellow-box) indices are not part of the overlay frame — refetch them
  // after a save or the cells/patches just labelled stay unhighlighted.
  const refreshGtHighlightIndices = useRefreshGtHighlightIndices();
  
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
  
  
  // Track which side of threshold to view: 'left' (prob < threshold) or 'right' (prob >= threshold)
  const [thresholdSide, setThresholdSide] = useState<"left" | "right">("left");

  // Which view: 'review' = candidates still to review, 'saved' = cells already saved
  const [reviewMode, setReviewMode] = useState<"review" | "saved">("review");

  // Batch processing: Handle pending reclassification selection //new add
  const handlePendingReclassification = useCallback((cellId: string, newClass: string) => {
    if (!assertWritable("review candidates")) return;
    setPendingReclassifications(prev => {
      const newMap = new Map(prev);
      newMap.set(cellId, newClass);
      return newMap;
    });
  }, [assertWritable]);
  
  // Batch processing: Cancel pending reclassification
  const handleCancelPendingReclassification = useCallback((cellId: string) => {
    setPendingReclassifications(prev => {
      const newMap = new Map(prev);
      newMap.delete(cellId);
      return newMap;
    });
  }, []);

  // Saved view: stage / un-stage a cell for removal. The actual delete from
  // user_annotation happens on Save (submitPendingReclassifications).
  const handleToggleRemoval = useCallback((cellId: string) => {
    if (!assertWritable("review candidates")) return;
    setPendingRemovals(prev => {
      const next = new Set(prev);
      if (next.has(cellId)) next.delete(cellId);
      else next.add(cellId);
      return next;
    });
  }, [assertWritable]);
  
  // Notify parent component of pending submission count changes
  useEffect(() => {
    if (onPendingCountChange) {
      onPendingCountChange(pendingReclassifications.size + confirmedCells.size + pendingRemovals.size);
    }
  }, [pendingReclassifications.size, confirmedCells.size, pendingRemovals.size, onPendingCountChange]);
  
  // Batch processing: commit all staged review actions on Save —
  //   • "Yes" confirmations + "No" reclassifications → one save_annotation/batch call
  //   • Saved-view removals → delete each from user_annotation
  const submitPendingReclassifications = useCallback(async (): Promise<ReviewSaveResult | null> => {
    if (!activeInstanceId || !currentPath) return null;
    if (!reviewState.slideId) return null;
    if (!assertWritable("submit review changes")) {
      return null;
    }
    if (pendingReclassifications.size === 0 && confirmedCells.size === 0 && pendingRemovals.size === 0) {
      return { marked: 0, removed: 0 };
    }

    const reclassEntries = Array.from(pendingReclassifications.entries());

    // "No" cells carry an explicit target class; "Yes" cells carry none, so the
    // batch endpoint records them with their existing AI prediction.
    const cellClasses: Record<string, string> = {};
    reclassEntries.forEach(([cellId, newClass]) => {
      cellClasses[cellId] = newClass;
    });

    const stagedCellIds = [
      ...Array.from(confirmedCells),
      ...reclassEntries.map(([cellId]) => cellId),
    ];
    const cellIndices = stagedCellIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id));
    const removalIds = Array.from(pendingRemovals);

    const filePath = reviewState.slideId.endsWith('.zarr')
      ? reviewState.slideId
      : `${reviewState.slideId}.zarr`;

    // Counted from the backend replies, not from what was staged: the backend
    // skips candidates with no AI prediction and ones already stored with the
    // same label, so a staged count would over-report.
    let markedCount = 0;
    let removedCount = 0;

    try {
      // Commit Yes/No labels
      if (cellIndices.length > 0) {
        let resp;
        if (isPatch) {
          resp = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/save_patch_annotations`, {
            method: 'POST',
            body: JSON.stringify({
              path: reviewState.slideId,
              patch_indices: cellIndices,
              patch_classes: cellClasses,
              annotator: resolveAnnotatorLabel({ userId: userInfo?.user_id }),
            }),

            returnAxiosFormat: true,
          });
        } else {
          resp = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/save_annotation/batch`, {
            method: 'POST',
            body: JSON.stringify({
              path: reviewState.slideId,
              annotation_type: 'nuclei',
              cell_indices: cellIndices,
              cell_classes: cellClasses,
              annotator: resolveAnnotatorLabel({ userId: userInfo?.user_id }),
            }),

            returnAxiosFormat: true,
          });
        }
        const payload = payloadFromAxiosAppResponse<{ marked_count?: number }>(resp);
        markedCount = Number(payload?.marked_count ?? 0) || 0;
      }

      // Commit removals — drop each staged cell/patch from user_annotation
      if (removalIds.length > 0) {
        if (isPatch) {
          const resp = await segFetch(activeInstanceId, `${AI_SERVICE_API_ENDPOINT}/seg/v1/remove_patch_annotations`, {
            method: 'POST',
            body: JSON.stringify({
              path: reviewState.slideId,
              patch_indices: removalIds.map((id) => Number(id)).filter((id) => Number.isInteger(id)),
            }),

            returnAxiosFormat: true,
          });
          const payload = payloadFromAxiosAppResponse<{ removed_count?: number }>(resp);
          removedCount = Number(payload?.removed_count ?? 0) || 0;
        } else {
          // No per-cell count from this endpoint; a rejection aborts the save.
          await Promise.all(removalIds.map((cellId) =>
            deleteNucleiAnnotation(filePath, 'User-Annotations/cell', Number(cellId))
          ));
          removedCount = removalIds.length;
        }
      }

      // Bump nuclei class counts for everything committed (cell only — patch
      // counts are maintained server-side in patch_class_counts):
      //   "Yes" confirmations → the current review class
      //   "No" reclassifications → their chosen target class
      // A caller-scoped class list (patch panels) must not mutate the shared
      // cell-class Redux list.
      if (!isPatch && !reviewClassesProp) {
        const classChangeCounts = new Map<string, number>();
        if (reviewState.className && confirmedCells.size > 0) {
          classChangeCounts.set(reviewState.className, confirmedCells.size);
        }
        reclassEntries.forEach(([, newClass]) => {
          classChangeCounts.set(newClass, (classChangeCounts.get(newClass) || 0) + 1);
        });
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
      }

      // Clear all staged actions
      setPendingReclassifications(new Map());
      setConfirmedCells(new Set());
      setPendingRemovals(new Set());

      // Refetch — saved cells leave the "To Review" pool and the "Saved"
      // view reflects the new state. Avoids the stale Yes→No red highlight
      // that came from optimistically relabelling every staged cell to 0.
      fetchCandidatesRef.current();

      if (isPatch) {
        // Optimistic colors written by the region-select tool outrank anything
        // the backend sends (PatchOverlay checks patchOverrides first), so a
        // patch relabelled here would keep painting its old class.
        const touched = [...cellIndices, ...removalIds.map(Number)].filter(Number.isInteger);
        if (touched.length > 0) {
          dispatch(clearPatchOverridesForIds(touched));
        }
        // Patch labels live in the patches frame; a full set_path reload is not
        // needed and shuts the wire gate, which drops this very request.
        eventBus.emit('refresh-patches');
      } else {
        eventBus.emit('refresh-annotations');
        eventBus.emit('refresh-websocket-path', { path: reviewState.slideId.replace(/\.zarr$/, ''), forceReload: true });
      }
      refreshGtHighlightIndices(currentPath ?? reviewState.slideId);
      return { marked: markedCount, removed: removedCount };
    } catch (error) {
      if (isSegmentationHandlerNotReadyError(error)) return null;
      console.warn('[AL] Error submitting review actions:', error);
      toast.error(getErrorMessage(error, "Failed to submit review changes."));
      return null;
    }
  }, [pendingReclassifications, confirmedCells, pendingRemovals, reviewState.slideId, reviewState.className, nucleiClasses, reviewClassesProp, isPatch, dispatch, activeInstanceId, currentPath, refreshGtHighlightIndices]);

  
  // Expose methods to parent component
  React.useImperativeHandle(ref, () => ({
    submitPendingReclassifications,
    getPendingReclassificationsCount: () => pendingReclassifications.size + confirmedCells.size + pendingRemovals.size
  }), [submitPendingReclassifications, pendingReclassifications, confirmedCells, pendingRemovals]);
  
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

  // Get target class from Redux state (set by ClassificationPanel)
  const targetClass = useMemo(() => {
    if (!reviewState.className || !reviewClasses || reviewClasses.length === 0) return null;
    const classObj = reviewClasses.find(cls => cls.name === reviewState.className);
    return classObj || null;
  }, [reviewState.className, reviewClasses]);

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
        exclude_saved: true,  // Already-saved cells are excluded from the candidate pool
        side: thresholdSide,  // "left" (prob < threshold) or "right" (prob >= threshold)
        saved_only: reviewMode === 'saved',  // 'Saved' tab → only cells already saved for this class
      };

      // Pass ROI bbox directly — backend filters spatially (no /query + cell_ids CSV)
      if (reviewState.roi && reviewState.roi.rectangleCoords) {
        try {
          const rect = reviewState.roi.rectangleCoords;
          
          if (!rect || typeof rect.x1 === 'undefined' || typeof rect.y1 === 'undefined' || 
              typeof rect.x2 === 'undefined' || typeof rect.y2 === 'undefined') {
            throw new Error('Invalid ROI rectangle coordinates - expected x1,y1,x2,y2 format');
          }
          
          const rectX1 = parseFloat(rect.x1);
          const rectY1 = parseFloat(rect.y1);
          const rectX2 = parseFloat(rect.x2);
          const rectY2 = parseFloat(rect.y2);
          
          if (isNaN(rectX1) || isNaN(rectY1) || isNaN(rectX2) || isNaN(rectY2)) {
            throw new Error('ROI coordinates contain invalid numeric values');
          }

          apiParams.roi = { x1: rectX1, y1: rectY1, x2: rectX2, y2: rectY2 };
          const poly = reviewState.roi.polygonPoints;
          if (Array.isArray(poly) && poly.length >= 3) {
            apiParams.polygon_points = poly;
          }
        } catch (roiError) {
        }
      } else if (reviewState.roi && reviewState.roi.polygonPoints) {
        const poly = reviewState.roi.polygonPoints;
        if (Array.isArray(poly) && poly.length >= 3) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const p of poly) {
            const px = Number(p[0]); const py = Number(p[1]);
            if (px < minX) minX = px; if (py < minY) minY = py;
            if (px > maxX) maxX = px; if (py > maxY) maxY = py;
          }
          if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
            apiParams.roi = { x1: minX, y1: minY, x2: maxX, y2: maxY };
            apiParams.polygon_points = poly;
          }
        }
      }

      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/candidates/${kind}`, {
        method: 'POST',
        body: JSON.stringify(apiParams),
        signal: abortController.signal,
        
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
  }, [reviewState.slideId, reviewState.className, reviewState.threshold, reviewState.sort, reviewState.page, reviewState.pageSize, reviewState.roi, dispatch, hasFullHistogram, currentHistogramClass, cachedHistogram, thresholdSide, reviewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch candidates when dependencies change - using ref to avoid infinite loop
  const fetchCandidatesRef = useRef(fetchCandidates);
  fetchCandidatesRef.current = fetchCandidates;
  
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
  }, [isVisible, reviewState.slideId, reviewState.className, reviewState.threshold, reviewState.sort, reviewState.page, reviewState.roi, thresholdSide, reviewMode]); // eslint-disable-line react-hooks/exhaustive-deps
  // Note: currentHistogramClass removed from deps to prevent double-fetch when class changes

  // Label a candidate
  const handleLabelCandidate = async (cellId: string, label: 1 | 0) => {

    if (!reviewState.slideId) {
      return;
    }
    if (!assertWritable("review candidates")) {
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

          // Nothing was sent to the backend yet — Yes is committed only on
          // Save — so cancelling a confirmation is purely local state.
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

      // Optimistically update the tile label only. YES/NO are deferred — the
      // cell is staged (confirmedCells / pendingReclassifications) and
      // committed to user_annotation on Save. Class counts are bumped on Save
      // too, so closing the panel without saving leaves counts untouched.
      dispatch(labelCandidate({ cell_id: cellId, label }));

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

  if (!Array.isArray(reviewClasses) || !reviewState) return null;

  return (
    <div ref={containerRef} className="flex-1 p-2 sm:p-3 lg:p-4 border-l border-border h-full flex flex-col relative">
      <div className="flex flex-col gap-2 sm:gap-3 flex-1 min-h-0">
        {/* Header */}
        <div>
          <h5 className="flex items-center gap-1.5 font-medium text-base sm:text-lg mb-1 sm:mb-1.5">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            Active Learning
          </h5>
          <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
            Active learning surfaces the cells with the most uncertain predictions.
            Review and correct them to improve the model with less annotation effort.
          </p>
        </div>

        {/* Show message when no class is selected */}
        {!reviewState.className ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border-2 border-dashed border-border bg-muted/40 p-6">
            <div className="flex max-w-xs flex-col items-center gap-3 py-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <MousePointerClick className="h-6 w-6 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-base font-medium text-foreground">No class selected</p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Select a cell class from the classification panel to start reviewing.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* To Review / Saved tab */}
            <div className="flex gap-1 bg-muted rounded-lg p-1 shrink-0">
              {([["review", "To Review"], ["saved", "Saved"]] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => {
                    setReviewMode(mode);
                    dispatch(setPage(0));
                  }}
                  className={`flex-1 px-3 py-1 text-xs rounded-md transition-colors ${
                    reviewMode === mode
                      ? "bg-card shadow-sm font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Probability Threshold Panel - only relevant when reviewing candidates */}
            {reviewMode === "review" && (
            <div className="shrink-0 w-full">
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
                <span className="text-xs text-muted-foreground">View:</span>
                <div className="flex gap-1 bg-muted rounded-lg p-1">
                  <button
                    onClick={() => {
                      setThresholdSide("left");
                    }}
                    className={`px-3 py-1 text-xs rounded-md transition-colors ${
                      thresholdSide === "left"
                        ? "bg-card shadow-sm font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Left (prob &lt; threshold)
                  </button>
                  <button
                    onClick={() => {
                      setThresholdSide("right");
                    }}
                    className={`px-3 py-1 text-xs rounded-md transition-colors ${
                      thresholdSide === "right"
                        ? "bg-card shadow-sm font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Right (prob &gt;= threshold)
                  </button>
                </div>
              </div>
            </div>
            )}

            {/* Candidate Gallery - takes remaining space */}
            <div className="flex-1 min-h-0">
              <CandidateGallery
                candidates={
                  reviewMode === 'saved'
                    ? (reviewState?.items || [])
                    // Show candidates if class matches AND (data is current OR loading OR requesting)
                    : (currentHistogramClass === reviewState.className &&
                       (lastLoadedThreshold === reviewState.threshold ||
                        requestingThresholdRef.current === reviewState.threshold ||
                        reviewState?.loading ||
                        thresholdLoading))
                      ? (reviewState?.items || [])
                      : []
                }
                loading={reviewMode === 'saved'
                  ? (reviewState?.loading || false)
                  : (reviewState?.loading || thresholdLoading || (currentHistogramClass !== reviewState.className))}
                error={reviewState?.error || null}
                total={
                  reviewMode === 'saved'
                    ? (reviewState?.total || 0)
                    // Show total if class matches AND (data is current OR loading OR requesting)
                    : (currentHistogramClass === reviewState.className &&
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
                availableClasses={reviewClasses ? reviewClasses.filter(cls => cls.name !== reviewState.className).map(cls => ({
                  id: cls.name,
                  name: cls.name,
                  color: cls.color
                })) : []}
                targetClassName={reviewState?.className}
                savedMode={reviewMode === 'saved'}
                pendingRemovals={pendingRemovals}
                onToggleRemoval={handleToggleRemoval}
                onPageChange={(page) => dispatch(setPage(page))}
                onSortChange={(sort) => dispatch(setSort(sort))}
                onLabelCandidate={handleLabelCandidate}
                onRetry={() => {
                  fetchCandidates();
                }}
                onCandidateClick={handleCandidateClick}
                // Batch processing related
                pendingReclassifications={pendingReclassifications}
                onPendingReclassification={handlePendingReclassification}
                onCancelPendingReclassification={handleCancelPendingReclassification}
                writeDisabled={!pathWritable}
                writeDisabledTitle={writeBlockTitle}
              />
            </div>
          </>
        )}
      </div>
      
    </div>
  );
});

// Add displayName for debugging purposes
ActiveLearningPanel.displayName = 'ActiveLearningPanel';

export default ActiveLearningPanel;
