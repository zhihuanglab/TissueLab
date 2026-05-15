import React from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { CoordinateBoxProps } from "./types";

export const CoordinateBox = ({
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
}: CoordinateBoxProps) => {
  
  const formatForDisplay = (value: string): string => {
    if (!value || value.trim() === '') return value;
    const num = parseFloat(value);
    if (isNaN(num)) return value;
    // Format to 2 decimal places, but remove trailing zeros
    return Number(num.toFixed(2)).toString();
  };

  return (
    <div 
      className="space-y-1 transition-all duration-300 ease-in-out group-hover:!block"
    >

      <div className="flex gap-2 sm:gap-4 items-end w-full">
        {/* First coordinate pair (X1, Y1) */}
        <div className="flex items-end gap-1 sm:gap-1.5 flex-1 min-w-0">
          <div className="space-y-0.5 flex-1 min-w-0">
            <Label htmlFor="x1" className="text-[10px] sm:text-xs text-muted-foreground">
              X1
            </Label>
            <Input
              id="x1"
              value={formatForDisplay(x1)}
              onFocus={onFocus}
              onBlur={onBlur}
              onChange={(e) => onX1Change(e.target.value)}
              className="h-7 text-[10px] sm:text-xs font-mono min-w-0 rounded-[6px]"
            />
          </div>
          <div className="space-y-0.5 flex-1 min-w-0">
            <Label htmlFor="y1" className="text-[10px] sm:text-xs text-muted-foreground">
              Y1
            </Label>
            <Input
              id="y1"
              value={formatForDisplay(y1)}
              onFocus={onFocus}
              onBlur={onBlur}
              onChange={(e) => onY1Change(e.target.value)}
              className="h-7 text-[10px] sm:text-xs font-mono min-w-0 rounded-[6px]"
            />
          </div>
        </div>

        {/* Second coordinate pair (X2, Y2) */}
        <div className="flex items-end gap-1 sm:gap-1.5 flex-1 min-w-0">
          <div className="space-y-0.5 flex-1 min-w-0">
            <Label htmlFor="x2" className="text-[10px] sm:text-xs text-muted-foreground">
              X2
            </Label>
            <Input
              id="x2"
              value={formatForDisplay(x2)}
              onFocus={onFocus}
              onBlur={onBlur}
              onChange={(e) => onX2Change(e.target.value)}
              className="h-7 text-[10px] sm:text-xs font-mono min-w-0 rounded-[6px]"
            />
          </div>
          <div className="space-y-0.5 flex-1 min-w-0">
            <Label htmlFor="y2" className="text-[10px] sm:text-xs text-muted-foreground">
              Y2
            </Label>
            <Input
              id="y2"
              value={formatForDisplay(y2)}
              onFocus={onFocus}
              onBlur={onBlur}
              onChange={(e) => onY2Change(e.target.value)}
              className="h-7 text-[10px] sm:text-xs font-mono min-w-0 rounded-[6px]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}; 