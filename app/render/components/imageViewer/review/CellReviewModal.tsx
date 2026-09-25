"use client";
import React, { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useActiveSlidePath } from "@/utils/viewer/slidePath";
import { usePathWriteAccess } from "@/hooks/usePathWriteAccess";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RangeInput } from "@/components/ui/range-input";
import { AI_SERVICE_API_ENDPOINT } from "@/config/api.config";
import { AppDispatch, RootState } from "@/store";
import { setReviewSession, setZoom } from "@/store/slices/reviewSlice";
import { AnnotationClass } from "@/store/slices/viewer/annotationSlice";
import { useReview } from "@/hooks/review/useReview";
import { apiFetch } from "@/utils/common/apiFetch";
import { getErrorMessage } from "@/utils/common/apiResponse";
import ActiveLearningPanel, { ActiveLearningPanelRef } from "./ReviewPanel";
import ClassList from "./ClassList";
import ErrorBoundary from "./ErrorBoundary";

export interface CellReviewSelectedCell {
  cellId: string;
  centroid: { x: number; y: number };
  slideId: string;
}

interface CellReviewModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /** Called when the modal should close (X / overlay / Close button). */
  onClose: () => void;
  /** Cell under review — owned by the parent (also set from the main viewer). */
  selectedCell: CellReviewSelectedCell | null;
  setSelectedCell: React.Dispatch<React.SetStateAction<CellReviewSelectedCell | null>>;
  /** Omit the Active Learning panel (e.g. VISTA). */
  hideReviewPanel?: boolean;
  /** Slide path, used for the save-refresh event and the review session. */
  formattedPath: string;
}

/**
 * Cell (nuclei) active-learning review — popup window.
 * Extracted from ClassificationPanel so the review UI lives with the
 * other review components. Same static server-rendered-tile architecture as
 * PatchReviewDialog; the parent owns only open state and selectedCell.
 */
export const CellReviewModal: React.FC<CellReviewModalProps> = ({
  open,
  onClose,
  selectedCell,
  setSelectedCell,
  hideReviewPanel = false,
  formattedPath,
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const reviewState = useReview();
  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses as AnnotationClass[]);
  const currentPath = useActiveSlidePath();
  const { allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(currentPath);

  const [reviewData, setReviewData] = useState<{
    image: string | null;
    bounds: { x: number; y: number; w: number; h: number };
    centroid?: { x: number; y: number };
    contour?: { x: number; y: number }[];
    pixel_spacing_um?: number;
    fov_um?: number;
    targetCell?: {
      centroid: { x: number; y: number };
      cellId: string;
      isFullImage: boolean;
      isLargeContext: boolean;
      tileSource?: any;
    };
  } | null>(null);
  const [showContour, setShowContour] = useState(true);
  const [isLoadingReview, setIsLoadingReview] = useState(false);
  const [isResizingView, setIsResizingView] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [contourData, setContourData] = useState<{
    contour?: { x: number; y: number }[];
    bounds?: { x: number; y: number; w: number; h: number };
  } | null>(null);
  // Cell data cached for the View Size slider re-fetch.
  const [cachedCellData, setCachedCellData] = useState<{
    slide: string;
    cellId: string;
    centroid: { x: number; y: number };
    contour: any;
    bounds: any;
  } | null>(null);
  const [pendingReclassificationsCount, setPendingReclassificationsCount] = useState(0);
  const activeLearningPanelRef = useRef<ActiveLearningPanelRef>(null);
  const viewSizeDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Reset review state whenever the modal closes (covers X / overlay / Close
  // button / parent-controlled close).
  useEffect(() => {
    if (!open) {
      setReviewData(null);
      setShowContour(false);
      setReviewError(null);
      setIsLoadingReview(false);
      setIsResizingView(false);
      setContourData(null);
      setCachedCellData(null);
    }
  }, [open]);

  // Clean up the View Size debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (viewSizeDebounceRef.current) {
        clearTimeout(viewSizeDebounceRef.current);
      }
    };
  }, []);

  // Variable patch size calculation based on zoom level
  const calculatePatchSizeFromZoom = (zoomValue: number): number => {
    // Formula: patchsize = (102-zoomval)*30
    // Range: zoomval 1-100, initial 90
    // Results: 60px (zoomval=100) to 3030px (zoomval=1), initial 360px (zoomval=90)
    const normalizedZoom = Math.max(1, Math.min(100, zoomValue));
    const patchSize = (102 - normalizedZoom) * 30;

    return patchSize;
  };

  // Fetch and display cell patch with variable size
  const fetchAndPositionCell = async (
    cell: CellReviewSelectedCell | null,
    contourDataArg: any,
    cellBounds: any,
    customPatchSize?: number, // Allow custom patch size for zoom changes
    forceContourType?: string | null, // Allow overriding contour type
  ) => {
    if (!cell) {
      return;
    }

    // Use custom patch size if provided (from slider), otherwise calculate from current zoom
    const currentZoom = reviewState?.zoom || 90; // Default zoom value
    const currentPatchSize = customPatchSize || calculatePatchSizeFromZoom(currentZoom);

    setIsLoadingReview(true);

    try {
      // Call backend API to get cell patch with variable size
      const requestPayload: any = {
        slide_id: cell.slideId,
        cell_id: cell.cellId,
        centroid: cell.centroid,
        window_size_px: currentPatchSize,  // Variable patch size
        return_contour: true,
        contour_type: forceContourType !== undefined ? forceContourType : (showContour ? 'polygon' : null)  // Contour display type
      };

      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/nuclei_classification/cell_review_tile`, {
        method: 'POST',
        body: JSON.stringify(requestPayload),
        returnAxiosFormat: true,
      });


      // Handle API response format (cell patch data)
      let patchImage: string;
      let patchData: any;

      const patchBody = response.data as Record<string, any>;
      patchData = patchBody?.image != null ? patchBody : patchBody?.data;
      if (patchData?.image) {

        // Create image URL from base64 data
        patchImage = patchData.image;

        // Check if the image data already has the data URL prefix
        if (!patchImage.startsWith('data:image/')) {
          patchImage = `data:image/jpeg;base64,${patchImage}`;
        }

        // Set up review data with cell patch
        setReviewData({
          image: patchImage,
          bounds: patchData.bounds,
          centroid: patchData.centroid,
          contour: patchData.contour,
          pixel_spacing_um: patchData.pixel_spacing_um,
          fov_um: patchData.fov_um,
          targetCell: {
            centroid: patchData.centroid,
            cellId: cell.cellId,
            isPatch: true  // Mark this as patch display (not full slide)
          } as any
        });

        // Store contour data separately
        if (patchData.contour) {
          setContourData({
            contour: patchData.contour,
            bounds: patchData.bounds
          });
        }

        // Cache cell data for slider zoom functionality
        setCachedCellData({
          slide: cell.slideId,
          cellId: cell.cellId,
          centroid: cell.centroid,
          contour: patchData.contour,
          bounds: patchData.bounds
        });

      } else {
        throw new Error(
          (response.data as { message?: string })?.message || 'Failed to get cell patch'
        );
      }

      setIsLoadingReview(false);

    } catch (error: any) {
      setReviewError(getErrorMessage(error, 'Failed to fetch and position cell'));
      setIsLoadingReview(false);
    }
  };

  // Setup cell positioning and contour display
  // forceZoom: optional zoom value to use (bypasses Redux state race condition when switching cells)
  const setupTargetCell = async (cell: CellReviewSelectedCell | null, forceZoom?: number) => {
    if (!cell) return;

    // Use forceZoom if provided (when switching cells), otherwise use Redux state
    const effectiveZoom = forceZoom ?? reviewState?.zoom;

    // Ensure we have a proper default zoom (reset if too low)
    if (!effectiveZoom || effectiveZoom < 10) {
      dispatch(setZoom(90)); // Default zoom value
    }

    setIsLoadingReview(true);
    setReviewError(null);

    try {
      // Get contour data from cell
      let contourFromCell: any = null;
      let cellBounds: any = null;

      // Try to get contour from candidate data first
      if ((cell as any).contour && Array.isArray((cell as any).contour)) {
        contourFromCell = (cell as any).contour;

        // Calculate bounds from contour coordinates
        const xs = contourFromCell.map((p: any) => p.x);
        const ys = contourFromCell.map((p: any) => p.y);
        cellBounds = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys)
        };
      } else {
        contourFromCell = null;
        cellBounds = null;
      }

      // Use forceZoom to calculate patch size directly (bypasses Redux state race condition)
      const patchSize = forceZoom ? calculatePatchSizeFromZoom(forceZoom) : undefined;
      await fetchAndPositionCell(cell, contourFromCell, cellBounds, patchSize);

    } catch (error: any) {
      setReviewError(getErrorMessage(error, 'Failed to show nuclei'));
      setIsLoadingReview(false);
    }
  };

  // Fetch contour data using original API (separate from main image)
  const fetchCellReviewData = async (cell: CellReviewSelectedCell | null, magnification?: number, overrideShowContour?: boolean) => {
    if (!cell) return;

    const currentMagnification = magnification ?? 40;

    try {
      // Validate cell data before making request
      if (!cell.cellId || !cell.centroid || typeof cell.centroid.x !== 'number' || typeof cell.centroid.y !== 'number') {
        throw new Error('Invalid cell data: missing cellId or centroid coordinates');
      }

      // Normalize the slide path for the backend
      const normalizedSlideId = cell.slideId.replace(/\\/g, '/');

      // Use current patch size from zoom state to avoid size changes
      const currentZoom = reviewState?.zoom || 90;
      const currentPatchSize = calculatePatchSizeFromZoom(currentZoom);

      // Use overrideShowContour if provided, otherwise use current state
      const effectiveShowContour = overrideShowContour !== undefined ? overrideShowContour : showContour;

      const requestPayload: any = {
        slide_id: normalizedSlideId,
        cell_id: cell.cellId,
        centroid: cell.centroid,
        window_size_px: currentPatchSize,  // Use current patch size
        padding_ratio: 0.2,
        magnification: currentMagnification,
        return_contour: true,
        contour_type: effectiveShowContour ? 'polygon' : null  // Pass contour display preference
      };

      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/nuclei_classification/cell_review_tile`, {
        method: 'POST',
        body: JSON.stringify(requestPayload),
        returnAxiosFormat: true,
      });


      const d = response.data as Record<string, any>;

      // Classification fields may sit on unwrapped body or under .data
      let cellClassificationData: any = null;
      if (d?.data && (d.data.predicted_class != null || d.data.probs || d.data.label)) {
        cellClassificationData = d.data;
      } else if (d?.predicted_class != null || d?.probs || d?.label) {
        cellClassificationData = d;
      }
      if (
        cellClassificationData?.predicted_class ||
        cellClassificationData?.probs ||
        cellClassificationData?.label
      ) {
        setSelectedCell(prev =>
          prev
            ? {
                ...prev,
                predicted_class: cellClassificationData.predicted_class,
                probs: cellClassificationData.probs,
                label: cellClassificationData.label,
              }
            : null
        );
      }

      if (response.status === 200) {
        if (d?.success && d?.data) {
          setReviewData(d.data as any);
        } else if (d?.image) {
          setReviewData(d as any);
        } else if (d?.data?.image) {
          setReviewData(d.data as any);
        } else {
          const errorMsg =
            d?.message || d?.error || 'Unknown error occurred while fetching cell data';
          setReviewError(errorMsg);
        }
      } else {
        const errorMsg = d?.error || `HTTP ${response.status} error`;
        setReviewError(errorMsg);
      }

    } catch (error: any) {
      setContourData(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
    >
      <DialogContent className="max-w-[1200px] w-full max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Cell Review &amp; Active Learning</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto" style={{ maxHeight: '80vh' }}>
        <div className="flex flex-col lg:flex-row gap-4">
          {/* Left side - Target cell / Review */}
          <div className="shrink-0 w-full lg:w-[400px] xl:w-[500px]">
            <h5 className="mb-3 text-base sm:text-lg">Target Cell</h5>

            {/* Cell patch display */}
            <div className="w-full border border-border relative bg-muted/40" style={{ height: 'clamp(250px, 50vh, 380px)' }}>
              {isLoadingReview && !reviewData ? (
                // Gray loading - only when no previous image exists
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  backgroundColor: 'hsl(var(--muted))'
                }}>
                  <div className="spinner-border" role="status" style={{ width: '2rem', height: '2rem' }}>
                    <span className="visually-hidden">Loading...</span>
                  </div>
                </div>
              ) : reviewData ? (
                <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                  {/* Cell patch image display. Plain <img>, NOT next/image:
                      reviewData.image is an inline base64 data: URL and next/image
                      (Next 16) fires onError on data URIs → blank/error tile. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={reviewData.image || '/placeholder.png'}
                    alt="Cell patch"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover', // Fill container completely
                      backgroundColor: 'hsl(var(--muted))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '4px'
                    }}
                    onLoad={() => {
                      setIsLoadingReview(false);
                    }}
                    onError={() => {
                      setIsLoadingReview(false);
                    }}
                  />
                  {/* Lightweight loading overlay for view size adjustment or cell switching */}
                  {(isResizingView || isLoadingReview) && (
                    <div style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      backgroundColor: 'rgba(0, 0, 0, 0.4)',
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                      borderRadius: '4px',
                      zIndex: 10
                    }}>
                      <div style={{
                        color: 'white',
                        fontSize: '14px',
                        fontWeight: 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                      }}>
                        <div className="animate-spin" style={{
                          width: '16px',
                          height: '16px',
                          border: '2px solid rgba(255,255,255,0.3)',
                          borderTopColor: 'white',
                          borderRadius: '50%'
                        }} />
                        {isResizingView ? 'Resizing...' : 'Loading...'}
                      </div>
                    </div>
                  )}
                </div>
              ) : reviewError ? (
                <div className="flex flex-col justify-center items-center h-full">
                  <div className="text-center">
                    <div className="text-warning mb-3">
                      <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                      </svg>
                    </div>
                    <h6 className="text-destructive">Error Loading Cell Data</h6>
                    <p className="text-muted-foreground mb-3">{reviewError}</p>
                    <Button
                      size="sm"
                      onClick={() => selectedCell && fetchCellReviewData(selectedCell)}
                    >
                      Retry
                    </Button>
                  </div>
                </div>
              ) : !reviewState?.selectedClass ? (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  backgroundColor: 'hsl(var(--muted))'
                }}>
                  <div className="text-center" style={{ width: '100%', padding: '20px' }}>
                    <p className="mb-2" style={{ textAlign: 'center', margin: '0 auto', fontSize: '14px', color: 'hsl(var(--foreground))', opacity: 0.8 }}>Click cells in the candidate pool on the right for detailed viewing</p>
                    <div style={{ textAlign: 'center', margin: '0 auto', fontSize: '13px', color: 'hsl(var(--foreground))', opacity: 0.7 }}>Please first select a cell type</div>
                  </div>
                </div>
              ) : !selectedCell ? (
                <div className="flex flex-col justify-center items-center h-full" style={{ backgroundColor: 'hsl(var(--muted))' }}>
                  <div className="text-center">
                    <div className="text-muted-foreground mb-3">
                      <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor" opacity="0.5">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                      </svg>
                    </div>
                    <p className="text-muted-foreground">Click cells in the candidate pool on the right for detailed viewing</p>
                    <span className="text-muted-foreground text-xs">Select a candidate cell to start review</span>
                  </div>
                </div>
              ) : (
                <div className="flex justify-center items-center h-full">
                  <p className="text-muted-foreground">No image data available</p>
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="mt-2 sm:mt-3">
              {/* Patch Size Control - right side = small patch, left side = large patch */}
              <div className="mb-2 sm:mb-3">
                <RangeInput
                  label={`View Size (Patch: ${calculatePatchSizeFromZoom(reviewState?.zoom || 90)}px)`}
                  min={1}
                  max={100}
                  step={1}
                  value={reviewState?.zoom || 90}
                  onChange={async (e) => {
                    const newZoom = parseFloat(e.target.value);

                    // Update Redux state immediately for visual feedback
                    dispatch(setZoom(newZoom));

                    // Show lightweight loading overlay
                    setIsResizingView(true);

                    // Clear any pending debounce
                    if (viewSizeDebounceRef.current) {
                      clearTimeout(viewSizeDebounceRef.current);
                    }

                    // Debounce the actual fetch - only trigger when user stops dragging
                    viewSizeDebounceRef.current = setTimeout(async () => {
                      const newPatchSize = calculatePatchSizeFromZoom(newZoom);

                      // Only re-fetch if we have cached data and modal is open
                      if (cachedCellData && open) {
                        try {
                          // Re-create the cell object from cached data
                          const cachedCell = {
                            cellId: cachedCellData.cellId,
                            slideId: cachedCellData.slide,
                            centroid: cachedCellData.centroid
                          };
                          await fetchAndPositionCell(cachedCell, cachedCellData.contour, cachedCellData.bounds, newPatchSize);
                        } catch (error) {
                          // Silently handle error
                        } finally {
                          setIsResizingView(false);
                        }
                      } else {
                        setIsResizingView(false);
                      }
                    }, 200); // 200ms debounce for smooth experience
                  }}
                  labelClassName="text-xs sm:text-sm"
                  containerClassName="mb-0"
                />
              </div>

              <div className="mb-2 sm:mb-3">
                <div className="flex items-center justify-between gap-2 flex-nowrap">
                   <div className="shrink-0 flex items-center gap-2" style={{ whiteSpace: 'nowrap' }}>
                     <Checkbox
                       id="show-contour-review"
                       checked={showContour}
                       onCheckedChange={async (checked) => {
                         const newShowContour = checked === true;
                         setShowContour(newShowContour);

                         // Re-fetch with new contour setting (pass explicit value to avoid async state issue)
                         if (selectedCell && open) {
                           await fetchCellReviewData(selectedCell, 40, newShowContour);
                         }
                       }}
                       disabled={!selectedCell}  // Only disable if no cell is selected - contour toggle is always available
                       className="h-4 w-4"
                     />
                     <label htmlFor="show-contour-review" className="text-sm mb-0 cursor-pointer">
                       Show contour
                     </label>
                   </div>

                </div>
                {cachedCellData && (
                  <span className="text-success block mt-1 text-xs">
                    Contour available
                  </span>
                )}
              </div>

              {/* Cell Information */}
              {selectedCell && (
                <div className="text-xs sm:text-sm text-muted-foreground mb-2">
                  <div className="mb-1">
                    <span className="font-medium">Cell ID:</span> {selectedCell.cellId}
                    {(selectedCell as any).isPreview && (
                      <Badge variant="default" className="ml-2 text-[9px] h-auto py-0.5 px-1.5">Preview</Badge>
                    )}
                  </div>
                  <div className="mb-1">
                    <span className="font-medium">Centroid:</span> ({selectedCell.centroid.x.toFixed(1)}, {selectedCell.centroid.y.toFixed(1)})
                  </div>
                  {reviewData?.pixel_spacing_um && (
                    <div className="mb-1">
                      <span className="font-medium">Resolution:</span> {reviewData.pixel_spacing_um}μm/pixel
                    </div>
                  )}
                  {reviewData?.fov_um && (
                    <div className="mb-1">
                      <span className="font-medium">FOV:</span> ~{reviewData.fov_um.toFixed(1)} μm
                    </div>
                  )}

                </div>
              )}

              {/* Class List - moved to bottom after cell information */}
              <div className="mt-2 sm:mt-3">
                <ClassList
                  nucleiClasses={nucleiClasses || []}
                  selectedClass={reviewState?.className || null}
                  onSelectClass={(className: string | null) => {
                    const finalSlideId = formattedPath || currentPath || 'unknown';
                    dispatch(setReviewSession({
                      slideId: finalSlideId,
                      className: className
                    }));
                  }}
                />
              </div>

            </div>
          </div>

          {/* Right side - Active Learning Panel (omitted when caller opts out, e.g. VISTA) */}
          {!hideReviewPanel && (
          <ErrorBoundary name="CellReview">
            <ActiveLearningPanel
              ref={activeLearningPanelRef}
              selectedCell={selectedCell}
              isVisible={open}
              onSelectedCellChange={(newSelectedCell) => {

                // Allow full Review Modal display (not preview mode)
                const cellData = {
                  ...newSelectedCell,
                  isPreview: false, // Enable full Review Modal
                  isDirectClick: true // Mark as direct click for identification
                };

                // Check if switching to a new cell
                const isSwitchingCell = selectedCell?.cellId !== newSelectedCell.cellId;

                // Reset zoom to default when switching to a new cell
                if (isSwitchingCell) {
                  dispatch(setZoom(90));
                }

                setSelectedCell(cellData);

                // Pass forceZoom=90 when switching cells to avoid Redux state race condition
                setupTargetCell(cellData, isSwitchingCell ? 90 : undefined);
              }}
              onPendingCountChange={setPendingReclassificationsCount}
            />
          </ErrorBoundary>
          )}
        </div>
        </div>
        <DialogFooter>
          <Button
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
            disabled={!pathWritable}
            title={writeBlockTitle}
            onClick={async () => {
            try {
              // Batch processing: submit all pending reclassifications first
              const staged = activeLearningPanelRef.current?.getPendingReclassificationsCount() ?? 0;
              if (staged === 0) {
                toast.info('No changes to save', {
                  description: 'No cells were labelled.',
                });
                return;
              }
              const result = await activeLearningPanelRef.current!.submitPendingReclassifications();
              // null → the panel already reported the failure.
              if (!result) return;
              // Counted by the backend: cells with no AI prediction to confirm,
              // or already stored with this label, are skipped server-side.
              const written = result.marked + result.removed;
              if (written === 0) {
                toast.info('Nothing to write', {
                  description: `${staged} cell${staged === 1 ? '' : 's'} already had this label.`,
                });
                return;
              }
              toast.success('Reclassifications saved', {
                description: written === staged
                  ? `Saved ${written} reclassification${written === 1 ? '' : 's'} to annotations.`
                  : `Saved ${written} of ${staged} reclassifications; the rest were already up to date.`,
              });
              // The overlay reload (refresh-websocket-path) is emitted by
              // submitPendingReclassifications itself — a second one here would
              // just re-run set_path for the same slide.
            } catch (error: any) {
              toast.error('Save failed', {
                description: getErrorMessage(error, 'Network error'),
              });
            }
          }}
        >
          Update {pendingReclassificationsCount > 0 && `(${pendingReclassificationsCount} pending)`}
        </Button>
        <Button
          variant="secondary"
          onClick={async () => {
            // Auto-save all reclassifications before closing
            try {
              // Submit pending batch reclassifications first
              if (activeLearningPanelRef.current) {
                const pendingCount = activeLearningPanelRef.current.getPendingReclassificationsCount();
                if (pendingCount > 0) {
                  await activeLearningPanelRef.current.submitPendingReclassifications();
                }
              }

            } catch (error) {
              // Silent failure, don't disturb user
            }

            onClose();
          }}
        >
          Close
        </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CellReviewModal;
