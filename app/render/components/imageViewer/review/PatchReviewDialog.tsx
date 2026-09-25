"use client";
import React, { useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { toast } from 'sonner';
import { Button } from "@/components/ui/button";
import { RangeInput } from "@/components/ui/range-input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { AppDispatch } from "@/store";
import { setReviewSession } from "@/store/slices/reviewSlice";
import type { AnnotationClass } from "@/store/slices/viewer/annotationSlice";
import { useReview } from "@/hooks/review/useReview";
import { apiFetch, payloadFromAxiosAppResponse } from '@/utils/common/apiFetch';
import { getErrorMessage } from '@/utils/common/apiResponse';
import { usePathWriteAccess } from "@/hooks/usePathWriteAccess";
import ActiveLearningPanel, { ActiveLearningPanelRef } from "./ReviewPanel";
import ClassList from "./ClassList";

interface PatchReviewDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the dialog should close (X / click-outside / Close button). */
  onClose: () => void;
  /** Slide under review. */
  slideId: string | null;
  /** Patch/tissue classes for the class picker and review panel. */
  reviewClasses: AnnotationClass[];
}

/**
 * Patch (MUSK) active-learning review — popup window, mirrors the cell review.
 * Extracted from PatchClassificationPanel so the review UI lives alongside the
 * other review components; the parent owns only the open/close state.
 */
export const PatchReviewDialog: React.FC<PatchReviewDialogProps> = ({
  open,
  onClose,
  slideId,
  reviewClasses,
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const reviewState = useReview();
  const { allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(slideId);
  const [selectedPatchPreview, setSelectedPatchPreview] = useState<{ cellId: string; image?: string; prob?: number; patchSize?: number } | null>(null);
  const [previewWindowPx, setPreviewWindowPx] = useState(0);
  const [zoomedImage, setZoomedImage] = useState<string | undefined>(undefined);
  // Ref + pending count for the Save button — YES/NO only stage labels;
  // they persist on Save.
  const patchReviewPanelRef = useRef<ActiveLearningPanelRef>(null);
  const [patchPendingCount, setPatchPendingCount] = useState(0);

  // Fetch the Target Patch tile at the selected view size. At the patch size
  // the candidate's own image is used (no fetch); a larger window fetches a
  // wider view. The setTimeout debounces while the slider is dragged.
  useEffect(() => {
    const patchSize = selectedPatchPreview?.patchSize ?? 0;
    if (!selectedPatchPreview?.cellId || !slideId || previewWindowPx <= patchSize) {
      setZoomedImage(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/review/v1/patch_tile`, {
          method: 'POST',
          body: JSON.stringify({
            slide_id: slideId,
            patch_id: Number(selectedPatchPreview.cellId),
            window_size_px: Math.round(previewWindowPx),
          }),
          returnAxiosFormat: true,
        });
        const payload = payloadFromAxiosAppResponse<{ image?: string }>(resp);
        if (!cancelled && payload?.image) setZoomedImage(payload.image);
      } catch (err) {
        if (!cancelled) console.error('[Patch review] view-size tile fetch failed:', err);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selectedPatchPreview?.cellId, selectedPatchPreview?.patchSize, previewWindowPx, slideId]);

  const handleClose = () => {
    onClose();
    setSelectedPatchPreview(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) handleClose(); }}
    >
      <DialogContent className="max-w-[1200px] w-full max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Patch Review &amp; Active Learning</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto" style={{ maxHeight: '80vh' }}>
          <div className="flex flex-col lg:flex-row gap-4">
            {/* Left — Target Patch preview */}
            <div className="shrink-0 w-full lg:w-[360px]">
              <h5 className="mb-3 text-base sm:text-lg">Target Patch</h5>
              {selectedPatchPreview ? (
                <>
                  <div
                    className="w-full border border-border bg-muted/40 rounded overflow-hidden"
                    style={{ height: 'clamp(240px, 42vh, 360px)' }}
                  >
                    {(() => {
                      const patchSize = selectedPatchPreview.patchSize ?? 0;
                      const img = previewWindowPx <= patchSize ? selectedPatchPreview.image : zoomedImage;
                      return img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={img}
                          alt={`Patch ${selectedPatchPreview.cellId}`}
                          className="w-full h-full object-contain"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">
                          {previewWindowPx <= patchSize ? 'No image' : 'Loading…'}
                        </div>
                      );
                    })()}
                  </div>
                  {/* View Size — drag out to see the patch in surrounding context */}
                  <div className="mt-2">
                    <RangeInput
                      label="View Size"
                      min={selectedPatchPreview.patchSize ?? 512}
                      max={(selectedPatchPreview.patchSize ?? 512) * 16}
                      step={128}
                      value={previewWindowPx}
                      showValue
                      formatValue={(v) => `${Math.round(v)}px`}
                      onChange={(e) => setPreviewWindowPx(parseFloat(e.target.value))}
                    />
                    {previewWindowPx > (selectedPatchPreview.patchSize ?? 0) && (
                      <div className="text-xs text-muted-foreground mt-0.5">yellow box = the patch</div>
                    )}
                  </div>
                  <div className="mt-2 text-sm text-muted-foreground space-y-0.5">
                    <div>Patch #{selectedPatchPreview.cellId}</div>
                    {typeof selectedPatchPreview.prob === 'number' && (
                      <div>Probability: {selectedPatchPreview.prob.toFixed(3)}</div>
                    )}
                  </div>
                </>
              ) : (
                <div
                  className="w-full border border-dashed border-border bg-muted/40 rounded flex items-center justify-center text-sm text-muted-foreground text-center px-4"
                  style={{ height: 'clamp(240px, 42vh, 360px)' }}
                >
                  Click a patch in the gallery to preview it here
                </div>
              )}
              {/* Patch class picker — choose / switch the class under review */}
              <div className="mt-3">
                <ClassList
                  nucleiClasses={reviewClasses}
                  selectedClass={reviewState?.className || null}
                  onSelectClass={(className: string | null) => {
                    if (className && slideId) {
                      dispatch(setReviewSession({ slideId, className }));
                    }
                  }}
                />
              </div>
            </div>
            {/* Right — the review panel */}
            <div className="flex-1 min-w-0 flex">
              <ActiveLearningPanel
                ref={patchReviewPanelRef}
                kind="patch"
                reviewClasses={reviewClasses}
                selectedCell={null}
                isVisible={open}
                onPendingCountChange={setPatchPendingCount}
                onSelectedCellChange={(sel: any) => {
                  const patchSize = typeof sel?.patch_size === 'number' ? sel.patch_size : 512;
                  setSelectedPatchPreview({
                    cellId: String(sel?.cellId ?? sel?.cell_id ?? ''),
                    image: sel?.crop?.image,
                    prob: typeof sel?.prob === 'number' ? sel.prob : undefined,
                    patchSize,
                  });
                  setPreviewWindowPx(patchSize);
                  setZoomedImage(undefined);
                }}
              />
            </div>
          </div>
        </div>
        {/* Save bar — staged YES/NO labels persist only when saved */}
        <DialogFooter>
          <Button
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
            disabled={!pathWritable}
            title={writeBlockTitle}
            onClick={async () => {
              try {
                const staged = patchReviewPanelRef.current?.getPendingReclassificationsCount() ?? 0;
                if (staged === 0) {
                  toast.info('No changes to save');
                  return;
                }
                // No overlay refresh here: submitPendingReclassifications emits it
                // itself, right after the write, so it cannot race a reload gate —
                // emitting it again from out here only doubles the fetch.
                const result = await patchReviewPanelRef.current!.submitPendingReclassifications();
                // null → the panel already reported the failure.
                if (!result) return;
                const written = result.marked + result.removed;
                if (written === 0) {
                  // Every staged patch was skipped server-side (no prediction to
                  // confirm, or the label was already the stored one).
                  toast.info('Nothing to write', {
                    description: `${staged} patch${staged === 1 ? '' : 'es'} already had this label.`,
                  });
                  return;
                }
                toast.success('Patch annotations saved', {
                  description: written === staged
                    ? `Saved ${written} patch label${written === 1 ? '' : 's'}.`
                    : `Saved ${written} of ${staged} patch labels; the rest were already up to date.`,
                });
              } catch (error: any) {
                toast.error('Save failed', { description: getErrorMessage(error, 'Network error') });
              }
            }}
          >
            Save{patchPendingCount > 0 ? ` (${patchPendingCount} pending)` : ''}
          </Button>
          <Button
            variant="secondary"
            onClick={async () => {
              // Auto-save staged labels before closing, like the cell modal.
              try {
                if (patchReviewPanelRef.current
                    && patchReviewPanelRef.current.getPendingReclassificationsCount() > 0) {
                  await patchReviewPanelRef.current.submitPendingReclassifications();
                }
              } catch {
                /* closing — don't block on a save error */
              }
              handleClose();
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PatchReviewDialog;
