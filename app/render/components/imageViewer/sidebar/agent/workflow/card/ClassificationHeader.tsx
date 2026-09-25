import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import React from "react";
import { ClassificationCheckbox } from "./ClassificationCheckbox";

export interface ClassificationHeaderProps {
  title: string;
  titleId?: string;
  // Update Classifier checkbox props
  updateClassifierId: string;
  updateClassifierChecked: boolean;
  onUpdateClassifierChange: (checked: boolean) => void;
  updateClassifierDisabled: boolean;
  updateClassifierTitle?: string;
  // Action buttons props
  onAddClass: () => void;
  onReset: () => void;
  newClassVariant?: "default" | "outline";
  resetVariant?: "default" | "outline" | "destructive";
  writeDisabled?: boolean;
  writeDisabledTitle?: string;
}

export const ClassificationHeader: React.FC<ClassificationHeaderProps> = ({
  title,
  titleId,
  updateClassifierId,
  updateClassifierChecked,
  onUpdateClassifierChange,
  updateClassifierDisabled,
  updateClassifierTitle,
  onAddClass,
  onReset,
  newClassVariant = "outline",
  resetVariant = "outline",
  writeDisabled = false,
  writeDisabledTitle,
}) => {
  return (
    <div className="pb-1.5 space-y-1.5">
      {/* First row: Title */}
      <div>
        <Label htmlFor={titleId} className="text-sm text-muted-foreground">
          {title}
        </Label>
      </div>

      {/* Second row: Checkbox and Action buttons */}
      <div className="flex items-center justify-between">
        {/* Update Classifier checkbox */}
        <ClassificationCheckbox
          id={updateClassifierId}
          checked={updateClassifierChecked}
          onCheckedChange={onUpdateClassifierChange}
          label="Update Classifier"
          disabled={updateClassifierDisabled || writeDisabled}
          title={writeDisabled ? writeDisabledTitle : updateClassifierTitle}
          className="flex items-center gap-2"
        />

        {/* Action buttons */}
        <div className="flex items-center gap-1">          
          <Button
            size="sm"
            variant={resetVariant}
            onClick={onReset}
            className="w-24"
            disabled={writeDisabled}
            title={writeDisabled ? writeDisabledTitle : undefined}
          >
            <span>Reset</span>
          </Button>
          <Button
            size="sm"
            variant={newClassVariant}
            onClick={onAddClass}
            className="w-24 gap-1"
            disabled={writeDisabled}
            title={writeDisabled ? writeDisabledTitle : undefined}
          >
            <span>New Class</span>
          </Button>

        </div>
      </div>
    </div>
  );
};

