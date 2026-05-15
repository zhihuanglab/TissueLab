import { Button } from "@/components/ui/button";
import React from "react";
import { ClassificationCheckbox } from "./ClassificationCheckbox";

export interface ClassificationFooterProps {
  // Update after every annotation checkbox props
  updateAfterAnnotationId: string;
  updateAfterAnnotationChecked: boolean;
  onUpdateAfterAnnotationChange: (checked: boolean) => void;
  updateAfterAnnotationDisabled?: boolean;
  updateAfterAnnotationTitle?: string;
  // Action buttons props
  onUpdate: () => void;
  onReview: () => void;
  updateVariant?: "default" | "secondary" | "success";
  reviewVariant?: "default" | "success";
}

export const ClassificationFooter: React.FC<ClassificationFooterProps> = ({
  updateAfterAnnotationId,
  updateAfterAnnotationChecked,
  onUpdateAfterAnnotationChange,
  updateAfterAnnotationDisabled = false,
  updateAfterAnnotationTitle,
  onUpdate,
  onReview,
  updateVariant = "secondary",
  reviewVariant = "default",
}) => {
  return (
    <div className="border-t border-border/40 pt-4">
      <div className="flex items-center gap-2">
        <ClassificationCheckbox
          id={updateAfterAnnotationId}
          checked={updateAfterAnnotationChecked}
          onCheckedChange={onUpdateAfterAnnotationChange}
          label="Update after every annotation"
          disabled={updateAfterAnnotationDisabled}
          title={updateAfterAnnotationTitle}
          className="flex items-center gap-2 ml-0.5"
        />

        <div className="flex gap-1 ml-auto">
          <Button
            size="sm"
            variant={updateVariant}
            onClick={onUpdate}
            className="w-24 gap-1"
          >
            {/* <RefreshCw className="h-4 w-4 mr-1" />  */}
            Update
          </Button>
          <Button
            size="sm"
            variant={reviewVariant}
            onClick={onReview}
            className="w-24 gap-1"
          >
            {/* <FileText className="h-4 w-4 mr-1" />  */}
            Review
          </Button>
        </div>
      </div>
    </div>
  );
};

