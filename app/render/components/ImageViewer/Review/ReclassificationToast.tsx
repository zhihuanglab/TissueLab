"use client";

import React, { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { X, Undo2, CheckCircle } from "lucide-react";

interface ReclassificationToastProps {
  isVisible: boolean;
  cellId: string;
  newClassName: string;
  onUndo: () => void;
  onDismiss: () => void;
}

export const ReclassificationToast: React.FC<ReclassificationToastProps> = ({
  isVisible,
  cellId,
  newClassName,
  onUndo,
  onDismiss,
}) => {
  const [timeLeft, setTimeLeft] = useState(5);
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);
  const onDismissRef = useRef(onDismiss);
  
  // Update ref when onDismiss changes
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!isVisible) {
      setTimeLeft(5);
      setIsAnimatingOut(false);
      return;
    }

    // Reset timer when toast becomes visible
    setTimeLeft(5);
    setIsAnimatingOut(false);

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          setIsAnimatingOut(true);
          setTimeout(() => onDismissRef.current(), 300); // Allow animation to complete
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isVisible]);

  const handleUndo = () => {
    setIsAnimatingOut(true);
    onUndo();
    setTimeout(onDismiss, 300);
  };

  const handleDismiss = () => {
    setIsAnimatingOut(true);
    setTimeout(onDismiss, 300);
  };

  if (!isVisible) return null;

  return (
    <div className={`
      fixed top-4 left-1/2 transform -translate-x-1/2 z-50
      bg-green-50 border border-green-200 rounded-lg shadow-lg p-3
      transition-all duration-300 ease-in-out
      ${isAnimatingOut ? 'opacity-0 translate-y-[-10px]' : 'opacity-100 translate-y-0'}
      max-w-sm
    `}>
      <div className="flex items-center gap-2">
        <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
        <div className="flex-1 text-sm">
          <span className="font-medium">Cell #{cellId}</span>
          <span className="text-gray-600"> reclassified to </span>
          <span className="font-medium text-green-700">{newClassName}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs border-green-300 text-green-700 hover:bg-green-100"
            onClick={handleUndo}
          >
            <Undo2 className="h-3 w-3 mr-1" />
            Undo ({timeLeft}s)
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 text-gray-400 hover:text-gray-600"
            onClick={handleDismiss}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      
      {/* Progress bar */}
      <div className="mt-2 w-full bg-green-100 rounded-full h-1">
        <div 
          className="bg-green-500 h-1 rounded-full transition-all duration-1000 ease-linear"
          style={{ width: `${(timeLeft / 5) * 100}%` }}
        />
      </div>
    </div>
  );
};

export default ReclassificationToast;