"use client"

import React from "react"
import type { TriangleDir } from "./types"

const TRIANGLE_POINTS: Record<TriangleDir, string> = {
  right: "0,0 12,6 0,12",
  down: "0,0 12,0 6,12",
  left: "12,0 0,6 12,12",
  up: "0,12 12,12 6,0",
}

/** Triangular port indicator. Inputs: white-filled, primary border. Outputs: solid primary fill. */
export const PortTriangle: React.FC<{ direction: TriangleDir; filled: boolean }> = ({ direction, filled }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" className="overflow-visible pointer-events-none">
    <polygon
      points={TRIANGLE_POINTS[direction]}
      fill={filled ? "hsl(var(--primary))" : "hsl(var(--card))"}
      stroke="hsl(var(--primary))"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
)
