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
  return (
    <div 
      className="space-y-1 transition-all duration-300 ease-in-out group-hover:!block"
    >
      <div className="flex items-center justify-between cursor-pointer">
        <Label className="text-sm font-medium">Coordinates</Label>
      </div>
      
      <div 
        className={`grid grid-cols-2 gap-2 mt-2 overflow-hidden transition-all duration-300 ease-in-out max-h-[200px] opacity-100`}
      >
        <div className="space-y-1">
          <Label htmlFor="x1" className="text-xs">
            X1
          </Label>
          <Input
            id="x1"
            value={x1}
            onFocus={onFocus}
            onBlur={onBlur}
            onChange={(e) => onX1Change(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="y1" className="text-xs">
            Y1
          </Label>
          <Input
            id="y1"
            value={y1}
            onFocus={onFocus}
            onBlur={onBlur}
            onChange={(e) => onY1Change(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="x2" className="text-xs">
            X2
          </Label>
          <Input
            id="x2"
            value={x2}
            onFocus={onFocus}
            onBlur={onBlur}
            onChange={(e) => onX2Change(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="y2" className="text-xs">
            Y2
          </Label>
          <Input
            id="y2"
            value={y2}
            onFocus={onFocus}
            onBlur={onBlur}
            onChange={(e) => onY2Change(e.target.value)}
            className="h-7 text-sm"
          />
        </div>
      </div>
    </div>
  );
}; 