"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useActiveSlidePath } from "@/utils/viewer/slidePath";

import ClassList from "@/components/imageViewer/review/ClassList";
import ErrorBoundary from "@/components/imageViewer/review/ErrorBoundary";
import ActiveLearningPanel, {
  ActiveLearningPanelRef,
} from "@/components/imageViewer/review/ReviewPanel";
import { useReview } from "@/hooks/review/useReview";
import { AppDispatch, RootState } from "@/store";
import {
  setReviewScope,
  setReviewSession,
  setZoom,
} from "@/store/slices/reviewSlice";
import { AnnotationClass } from "@/store/slices/viewer/annotationSlice";
import { formatPath } from "@/utils/common/path.utils";

interface WorkflowGraphActiveLearningProps {
  /** Selected node category — only NucleiSeg / NucleiClassify enable AL. */
  factory?: string;
  modelId?: string;
}

const SUPPORTED_FACTORIES = new Set(["NucleiSeg", "NucleiClassify"]);

const WorkflowGraphActiveLearning: React.FC<WorkflowGraphActiveLearningProps> = ({
  factory,
  modelId,
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const reviewState = useReview();
  const nucleiClasses = useSelector(
    (state: RootState) =>
      (state.annotations.nucleiClasses as AnnotationClass[]) || []
  );
  const currentPath = useActiveSlidePath();
  const classNamesKey = useMemo(
    () => nucleiClasses.map((item) => item.name).join("\u001f"),
    [nucleiClasses],
  );
  const scopeKey = useMemo(
    () => [
      formatPath(currentPath ?? "") || currentPath || "unknown",
      modelId || factory || "unknown",
      classNamesKey,
    ].join("\u001e"),
    [classNamesKey, currentPath, factory, modelId],
  );

  const activeLearningPanelRef = React.useRef<ActiveLearningPanelRef>(null);

  const [selectedCell, setSelectedCell] = useState<{
    cellId: string;
    centroid: { x: number; y: number };
    slideId: string;
  } | null>(null);

  useEffect(() => {
    dispatch(setReviewScope(scopeKey));
    setSelectedCell(null);
  }, [dispatch, scopeKey]);

  const handleSelectClass = useCallback(
    (className: string | null) => {
      const slideId = formatPath(currentPath ?? "") || currentPath || "unknown";
      dispatch(setReviewSession({ slideId, className }));
    },
    [currentPath, dispatch]
  );

  const handleSelectedCellChange = useCallback(
    (next: {
      cellId: string;
      centroid: { x: number; y: number };
      slideId: string;
    }) => {
      const isSwitchingCell = selectedCell?.cellId !== next.cellId;
      if (isSwitchingCell) {
        dispatch(setZoom(90));
      }
      setSelectedCell(next);
    },
    [dispatch, selectedCell?.cellId]
  );

  if (!factory || !SUPPORTED_FACTORIES.has(factory)) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
        Active Learning is available for cell segmentation and cell
        classification nodes only.
      </div>
    );
  }

  if (!currentPath) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
        Open an image to start an Active Learning review session.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ClassList
        nucleiClasses={nucleiClasses}
        selectedClass={reviewState?.className || null}
        onSelectClass={handleSelectClass}
      />
      <ErrorBoundary name="ActiveLearning">
        <ActiveLearningPanel
          ref={activeLearningPanelRef}
          selectedCell={selectedCell}
          isVisible={true}
          onSelectedCellChange={handleSelectedCellChange}
        />
      </ErrorBoundary>
    </div>
  );
};

export default WorkflowGraphActiveLearning;
