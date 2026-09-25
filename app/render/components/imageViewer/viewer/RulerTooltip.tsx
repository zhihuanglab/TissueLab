"use client";

import React from 'react';

interface RulerTooltipProps {
  visible: boolean;
  text: string;
  position: { x: number; y: number };
}

export default function RulerTooltip({ visible, text, position }: RulerTooltipProps) {
  if (!visible) return null;

  return (
    <div 
      className="absolute bg-white shadow-lg border-0 text-black p-2 rounded-md text-sm font-sans z-1000 pointer-events-none"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
    >
      {text}
    </div>
  );
}

