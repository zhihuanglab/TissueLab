"use client"

import { useCallback, useState, useEffect } from "react"
import { ImageAnnotation } from "@annotorious/react"
import { useSelector } from "react-redux"
import { RootState } from "@/store"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { formatMppDisplay } from "@/utils/mppFormat"

interface RulerContentProps {
  annotation: ImageAnnotation
}


// Function to convert microns to appropriate unit
const convertToAppropriateUnit = (microns: number) => {
  if (microns >= 1000000) {
    return { value: microns / 1000000, unit: 'm' };
  } else if (microns >= 10000) {
    return { value: microns / 10000, unit: 'cm' };
  } else if (microns >= 1000) {
    return { value: microns / 1000, unit: 'mm' };
  } else {
    return { value: microns, unit: 'µm' };
  }
};

interface RulerData {
  start: { x: number; y: number }
  end: { x: number; y: number }
  distance: string
  distanceInUnit: string
}

// Helper function to check if MPP is valid
const isValidMPP = (mpp: any): boolean => {
  if (mpp === null || mpp === undefined) return false;
  const num = Number(mpp);
  return !isNaN(num) && num > 0 && isFinite(num);
};

export default function RulerContent({ annotation }: RulerContentProps) {
  const slideInfo = useSelector((state: RootState) => state.svsPath.slideInfo);
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const [customMPP, setCustomMPP] = useState<string>("");
  const [mppError, setMppError] = useState<string>("");

  // Clear MPP when image changes
  useEffect(() => {
    setCustomMPP("");
    setMppError("");
  }, [currentPath]);

  // Get effective MPP value
  const getEffectiveMPP = useCallback((): number | null => {
    // First check if custom MPP is provided and valid
    if (customMPP) {
      const num = Number(customMPP);
      if (!isNaN(num) && num > 0 && isFinite(num)) {
        return num;
      }
    }
    
    // Fall back to slideInfo MPP if valid
    if (isValidMPP(slideInfo?.mpp)) {
      return Number(slideInfo.mpp);
    }
    
    return null;
  }, [customMPP, slideInfo?.mpp]);

  // Handle custom MPP input change
  const handleMPPChange = (value: string) => {
    setCustomMPP(value);
    setMppError("");
    
    // Validate input
    if (value.trim() === "") {
      return; // Allow empty input
    }
    
    const num = Number(value);
    if (isNaN(num) || num <= 0 || !isFinite(num)) {
      setMppError("MPP must be a positive number");
    }
  };

  // Calculate ruler distance and coordinates for LINE annotations
  const calculateRulerData = useCallback((): RulerData | null => {
    if (annotation.target.selector?.type === 'LINE') {
      const line = annotation.target.selector.geometry as any;
      if (line?.points && line.points.length >= 2) {
        const start = line.points[0];
        const end = line.points[1];
        
        const startX = Math.round(start[0]);
        const startY = Math.round(start[1]);
        const endX = Math.round(end[0]);
        const endY = Math.round(end[1]);

        const lineLength = Math.sqrt(
          Math.pow(end[0] - start[0], 2) +
          Math.pow(end[1] - start[1], 2)
        ); // unit: pixel

        // Get effective MPP
        const mpp = getEffectiveMPP();
        
        // If no valid MPP, still return pixel distance but no unit conversion
        if (!mpp) {
          return {
            start: { x: startX, y: startY },
            end: { x: endX, y: endY },
            distance: `${Math.round(lineLength)} px`,
            distanceInUnit: "N/A (MPP required)"
          };
        }

        const lineLengthInMicrons = lineLength * mpp; // unit: micron (µm)

        // Convert to appropriate unit
        const { value: adjustedValue, unit } = convertToAppropriateUnit(lineLengthInMicrons);

        return {
          start: { x: startX, y: startY },
          end: { x: endX, y: endY },
          distance: `${Math.round(lineLength)} px`,
          distanceInUnit: `${adjustedValue.toFixed(2)} ${unit}`
        };
      }
    }
    return null;
  }, [annotation, getEffectiveMPP]);

  const rulerData = calculateRulerData();
  const effectiveMPP = getEffectiveMPP();
  const needsMPPInput = !isValidMPP(slideInfo?.mpp);

  if (!rulerData) {
    return (
      <div className="space-y-1">
        <Label className="text-sm">Distance</Label>
        <div className="h-20 p-3 border rounded-md bg-muted/50 text-sm flex items-center">
          <span className="text-muted-foreground">Unable to calculate distance</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* MPP Input Section - Show if MPP is missing or invalid */}
      {needsMPPInput && (
        <div className="space-y-1">
          <Label className="text-sm">MPP (Microns per Pixel)</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              step="0.001"
              min="0.001"
              placeholder="Enter MPP value"
              value={customMPP}
              onChange={(e) => handleMPPChange(e.target.value)}
              className={`h-8 ${mppError ? 'border-destructive' : ''}`}
            />
            <span className="text-xs text-muted-foreground shrink-0">µm/px</span>
          </div>
          {mppError && (
            <p className="text-xs text-destructive">{mppError}</p>
          )}
          {!mppError && customMPP && effectiveMPP && (
            <p className="text-xs text-muted-foreground">
              Using custom MPP: {formatMppDisplay(effectiveMPP)} µm/px
            </p>
          )}
          {!customMPP && (
            <p className="text-xs text-muted-foreground">MPP not found in image metadata. Please enter a value to calculate accurate distance.</p>
          )}
        </div>
      )}

      <div className="space-y-1">
        <Label className="text-sm">Distance</Label>
        <div className="p-3 border rounded-md bg-gradient-to-br from-blue-50/50 to-indigo-50/50 dark:from-blue-950/20 dark:to-indigo-950/20">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4 text-xs">
              <span className="font-mono">Length:</span>
              <span className="font-mono">
                {rulerData.distance} 
                {rulerData.distanceInUnit !== "N/A (MPP required)" && ` | ${rulerData.distanceInUnit}`}
                {rulerData.distanceInUnit === "N/A (MPP required)" && (
                  <span className="text-muted-foreground ml-1">({rulerData.distanceInUnit})</span>
                )}
              </span>
            </div>
            <div className="pt-2 border-t border-border/50 space-y-1.5">
              <div className="flex items-center justify-between gap-4 text-xs">
                <span className="font-mono">Start:</span>
                <span className="font-mono">({rulerData.start.x}, {rulerData.start.y})</span>
              </div>
              <div className="flex items-center justify-between gap-4 text-xs">
                <span className="font-mono">End:</span>
                <span className="font-mono">({rulerData.end.x}, {rulerData.end.y})</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

