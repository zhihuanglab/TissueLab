"use client";

import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ReviewCandidate } from "@/store/slices/reviewSlice";
import Image from "next/image";

interface ClassSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  candidate: ReviewCandidate | null;
  availableClasses: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  onClassSelect: (candidateId: string, selectedClass: string) => void;
}

export const ClassSelectionModal: React.FC<ClassSelectionModalProps> = ({
  isOpen,
  onClose,
  candidate,
  availableClasses,
  onClassSelect,
}) => {
  if (!candidate) return null;

  const fixedOptions = [
    { id: "Other", name: "Other", color: "#F3F4F5", isTemporary: true },
    { id: "Not Sure", name: "Not Sure", color: "#FED7AA", isTemporary: true },
    { id: "Incorrect Segmentation", name: "Incorrect Segmentation", color: "#FECACA", isTemporary: true }
  ];

  const handleClassSelect = (className: string) => {
    onClassSelect(candidate.cell_id, className);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>Reclassify Cell</span>
            <span className="text-sm text-muted-foreground font-normal">
              (ID: {candidate.cell_id})
            </span>
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Cell preview */}
          <div className="flex items-center gap-3 p-3 bg-muted rounded">
            <div className="relative">
              <Image 
                src={candidate.crop.image} 
                alt={`Cell ${candidate.cell_id}`}
                className="w-16 h-16 rounded border border-border"
                style={{ imageRendering: 'pixelated' }}
              />
              <div className="absolute top-0 left-0 bg-black bg-opacity-60 text-white text-xs px-1 rounded">
                {candidate.prob.toFixed(3)}
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              Please select the correct classification for this cell:
            </div>
          </div>

          {/* Class selection buttons */}
          <div className="space-y-2">
            <div className="text-sm font-medium text-foreground mb-2">Available Classes:</div>
            
            {/* Dynamic classes from nuclei classes */}
            {availableClasses.map((classObj, index) => (
              <Button
                key={`available-${classObj.id}-${index}`}
                variant="outline"
                className="w-full justify-start h-auto py-2 px-3"
                onClick={() => handleClassSelect(classObj.name)}
              >
                <div className="flex items-center gap-3">
                  <div 
                    className="w-4 h-4 rounded border border-border"
                    style={{ backgroundColor: classObj.color }}
                  />
                  <span>{classObj.name}</span>
                </div>
              </Button>
            ))}
            
            {/* options separator */}
            {availableClasses.length > 0 && (
              <div className="border-t border-border pt-2 mt-3">
                <div className="text-sm font-medium text-foreground mb-2">Other Options:</div>
              </div>
            )}
            
            {/* options*/}
            {fixedOptions.map((option, index) => (
              <Button
                key={`fixed-${option.id}-${index}`}
                variant="outline"
                className="w-full justify-start h-auto py-2 px-3"
                onClick={() => handleClassSelect(option.name)}
                title="⚠️ Temporary class - will be cleared after reload"
              >
                <div className="flex items-center gap-3 w-full">
                  <div 
                    className="w-4 h-4 rounded border border-border"
                    style={{ backgroundColor: option.color }}
                  />
                  <span className="flex-1">{option.name}</span>
                  <span className="text-warning text-xs">⏱️</span>
                </div>
              </Button>
            ))}
          </div>

          {/* Cancel button */}
          <div className="flex justify-end pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ClassSelectionModal;