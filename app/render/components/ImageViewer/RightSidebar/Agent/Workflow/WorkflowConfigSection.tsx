import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkflowPanel } from "@/store/slices/chat/workflowSlice";
import { ChevronDown, ChevronUp, Folder } from "lucide-react";
import React, { useState } from "react";
import { CoordinateBox } from "./CoordinateBox";
import { panelMap } from "./constants";

interface WorkflowConfigSectionProps {
  outputPath: string;
  onOutputPathChange: (value: string) => void;
  panels: WorkflowPanel[];
  x1: string;
  y1: string;
  x2: string;
  y2: string;
  onX1Change: (value: string) => void;
  onY1Change: (value: string) => void;
  onX2Change: (value: string) => void;
  onY2Change: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
}

/**
 * Configuration section showing output path and coordinates
 * Displayed in the bottom bar when workflow is idle
 */
export const WorkflowConfigSection: React.FC<WorkflowConfigSectionProps> = ({
  outputPath,
  onOutputPathChange,
  panels,
  x1,
  y1,
  x2,
  y2,
  onX1Change,
  onY1Change,
  onX2Change,
  onY2Change,
  onFocus,
  onBlur,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const needsCoordinates = panels.some(
    panel =>
      panel.title === panelMap.TissueClassify.title ||
      panel.title === panelMap.NucleiSeg.title ||
      panel.title === panelMap.TissueSeg.title
  );

  const handleSelectFolder = async () => {
    try {
      const result = await (window as any).electron.invoke('open-file-dialog');
      if (result?.filePaths?.length) {
        onOutputPathChange(result.filePaths[0]);
      }
    } catch (error) {
      console.error('Error selecting file:', error);
    }
  };

  return (
    <div className="border-b border-border/50">
      {/* Header with toggle */}
      <div 
        className="px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-muted transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <Label className="text-sm font-medium cursor-pointer mb-0">
          Configuration
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
        >
          {isExpanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* Collapsible content */}
      {isExpanded && (
        <div className="px-3 pb-2 space-y-1">
          <div className="space-y-1">
            <Label htmlFor="output" className="text-[10px] sm:text-xs text-muted-foreground">
              Output Path
            </Label>
            <div className="flex gap-1 sm:gap-2">
              <Input
                id="output"
                value={outputPath}
                onChange={(e) => onOutputPathChange(e.target.value)}
                onFocus={onFocus}
                onBlur={onBlur}
                placeholder="Enter output path..."
                className="h-8 text-[10px] sm:text-xs flex-1 font-mono min-w-0 rounded-[6px] placeholder:text-muted-foreground/40"
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={handleSelectFolder}
                className="h-8 w-8 flex-shrink-0"
              >
                <Folder className="h-3 w-3 sm:h-4 sm:w-4" />
              </Button>
            </div>
          </div>

          <CoordinateBox
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            onX1Change={onX1Change}
            onY1Change={onY1Change}
            onX2Change={onX2Change}
            onY2Change={onY2Change}
            onFocus={onFocus}
            onBlur={onBlur}
          />
        </div>
      )}
    </div>
  );
};

