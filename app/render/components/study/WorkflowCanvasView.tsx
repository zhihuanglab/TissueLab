"use client";

import React, { useMemo } from "react";
import Image from "next/image";
import { Boxes } from "lucide-react";

import modelRegistryFallback from "@/constants/modelRegistryFallback.json";
import { cn } from "@/utils/twMerge";

// ─── Shared types — kept in sync with WorkflowGraph.tsx ─────────────────

type PortSide = "left" | "right" | "top" | "bottom";
type NodeKind = "start" | "end" | "model";

export interface CanvasNode {
  id: string;
  kind: NodeKind;
  modelId?: string;
  x: number;
  y: number;
  label?: string;
}

export interface CanvasConnection {
  id: string;
  fromId: string;
  toId: string;
  fromPort: PortSide;
  toPort: PortSide;
}

const registryNodes = modelRegistryFallback.nodes as Record<
  string,
  { displayName?: string; icon?: string; factory?: string }
>;
const registryCategoryNames = modelRegistryFallback.category_display_names as Record<
  string,
  string
>;

// ─── Layout constants — match WorkflowGraph ─────────────────────────────

const NODE_W = 140;
const NODE_H = 64;
const TERMINAL_SIZE = 56;
const PAD = 32;

const isTerminal = (n: CanvasNode) => n.kind !== "model";
const nodeWidth = (n: CanvasNode) => (isTerminal(n) ? TERMINAL_SIZE : NODE_W);
const nodeHeight = (n: CanvasNode) => (isTerminal(n) ? TERMINAL_SIZE : NODE_H);

type TriangleDir = "right" | "down" | "left" | "up";
const TRIANGLE_POINTS: Record<TriangleDir, string> = {
  right: "0,0 12,6 0,12",
  down: "0,0 12,0 6,12",
  left: "12,0 0,6 12,12",
  up: "0,12 12,12 6,0",
};

const PortTriangle: React.FC<{ direction: TriangleDir; filled: boolean }> = ({
  direction,
  filled,
}) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    className="pointer-events-none overflow-visible"
  >
    <polygon
      points={TRIANGLE_POINTS[direction]}
      fill={filled ? "hsl(var(--primary))" : "hsl(var(--card))"}
      stroke="hsl(var(--primary))"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

const getPortPos = (node: CanvasNode, side: PortSide) => {
  const w = nodeWidth(node);
  const h = nodeHeight(node);
  switch (side) {
    case "right":
      return { x: node.x + w, y: node.y + h / 2 };
    case "left":
      return { x: node.x, y: node.y + h / 2 };
    case "top":
      return { x: node.x + w / 2, y: node.y };
    case "bottom":
      return { x: node.x + w / 2, y: node.y + h };
  }
};

interface WorkflowCanvasViewProps {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  className?: string;
  /** When true, hides connection ports and uses a denser scale — useful for hover-preview popovers. */
  compact?: boolean;
}

const WorkflowCanvasView: React.FC<WorkflowCanvasViewProps> = ({
  nodes,
  connections,
  className,
  compact = false,
}) => {
  const bounds = useMemo(() => {
    let maxX = 0;
    let maxY = 0;
    for (const n of nodes) {
      const w = nodeWidth(n);
      const h = nodeHeight(n);
      if (n.x + w > maxX) maxX = n.x + w;
      if (n.y + h > maxY) maxY = n.y + h;
    }
    return { w: maxX + PAD, h: maxY + PAD };
  }, [nodes]);

  const scale = compact ? 0.55 : 1;

  return (
    <div
      className={cn(
        "relative overflow-auto rounded-md bg-muted/30",
        className
      )}
      style={{
        backgroundImage:
          "radial-gradient(circle, hsl(var(--border)) 1px, transparent 1px)",
        backgroundSize: `${16 * scale}px ${16 * scale}px`,
      }}
    >
      <div
        className="relative"
        style={{
          width: bounds.w * scale,
          height: bounds.h * scale,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          // expand background area to cover scaled content footprint
          minWidth: bounds.w * scale,
          minHeight: bounds.h * scale,
        }}
      >
        <div
          className="relative"
          style={{ width: bounds.w, height: bounds.h }}
        >
          {/* Connections */}
          <svg
            width={bounds.w}
            height={bounds.h}
            className="pointer-events-none absolute left-0 top-0"
          >
            {connections.map((conn) => {
              const from = nodes.find((n) => n.id === conn.fromId);
              const to = nodes.find((n) => n.id === conn.toId);
              if (!from || !to) return null;
              const start = getPortPos(from, conn.fromPort);
              const end = getPortPos(to, conn.toPort);
              const dx = end.x - start.x;
              const dy = end.y - start.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              const off = Math.max(40, dist * 0.3);
              const cs = { x: start.x, y: start.y };
              const ce = { x: end.x, y: end.y };
              if (conn.fromPort === "right") cs.x += off;
              else if (conn.fromPort === "left") cs.x -= off;
              else if (conn.fromPort === "bottom") cs.y += off;
              else if (conn.fromPort === "top") cs.y -= off;
              if (conn.toPort === "right") ce.x += off;
              else if (conn.toPort === "left") ce.x -= off;
              else if (conn.toPort === "bottom") ce.y += off;
              else if (conn.toPort === "top") ce.y -= off;
              const d = `M ${start.x} ${start.y} C ${cs.x} ${cs.y}, ${ce.x} ${ce.y}, ${end.x} ${end.y}`;
              return (
                <path
                  key={conn.id}
                  d={d}
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="none"
                  opacity={0.7}
                />
              );
            })}
          </svg>

          {/* Nodes */}
          {nodes.map((n) => {
            const w = nodeWidth(n);
            const h = nodeHeight(n);

            if (isTerminal(n)) {
              const isStart = n.kind === "start";
              const ringClass = isStart
                ? "border-primary bg-primary text-primary-foreground"
                : "border-primary bg-primary/10 text-primary";
              return (
                <div
                  key={n.id}
                  className="absolute"
                  style={{ left: n.x, top: n.y, width: w, height: h, zIndex: 10 }}
                >
                  <div
                    className={cn(
                      "flex h-full w-full items-center justify-center rounded-full border-2 text-[11px] font-bold shadow-sm",
                      ringClass
                    )}
                  >
                    {isStart ? "Start" : "End"}
                  </div>
                  {!compact && isStart && (
                    <div
                      className="absolute"
                      style={{ left: w / 2 - 6, bottom: -12, zIndex: 30 }}
                    >
                      <PortTriangle direction="down" filled={true} />
                    </div>
                  )}
                  {!compact && !isStart && (
                    <div
                      className="absolute"
                      style={{ left: w / 2 - 6, top: -12, zIndex: 30 }}
                    >
                      <PortTriangle direction="down" filled={false} />
                    </div>
                  )}
                </div>
              );
            }

            const meta = n.modelId ? registryNodes[n.modelId] : undefined;
            const label = n.label || meta?.displayName || n.modelId || "Node";
            const iconUrl = meta?.icon;
            return (
              <div
                key={n.id}
                className="absolute"
                style={{ left: n.x, top: n.y, width: w, height: h, zIndex: 10 }}
              >
                <div className="relative flex h-full w-full items-center gap-2 rounded-lg border-2 border-primary/60 bg-card px-2 shadow-sm">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                    {iconUrl ? (
                      <Image
                        src={iconUrl}
                        alt={label}
                        width={36}
                        height={36}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Boxes className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-xs font-semibold text-foreground"
                      title={label}
                    >
                      {label}
                    </div>
                    {meta?.factory && (
                      <div className="truncate text-[10px] text-muted-foreground">
                        {registryCategoryNames[meta.factory] || meta.factory}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ─── Auto-layout helper ─────────────────────────────────────────────────
// Given a flat sequence of model node ids, returns positioned nodes + connections
// arranged vertically (Start at top, End at bottom) — mirrors the default layout
// produced by the Agentic AI editor.

export interface LinearWorkflowSpec {
  modelNodes: { id: string; modelId: string; label?: string }[];
}

export function buildLinearCanvas(spec: LinearWorkflowSpec): {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
} {
  const X_MODEL = 100;
  const TERMINAL_X = X_MODEL + (NODE_W - TERMINAL_SIZE) / 2;
  const VERTICAL_GAP = 36;

  const nodes: CanvasNode[] = [];
  const connections: CanvasConnection[] = [];

  const startId = "__start__";
  let cursorY = 24;
  nodes.push({ id: startId, kind: "start", x: TERMINAL_X, y: cursorY });
  cursorY += TERMINAL_SIZE + VERTICAL_GAP;

  let prevId = startId;
  for (let i = 0; i < spec.modelNodes.length; i += 1) {
    const m = spec.modelNodes[i];
    const id = m.id || `m-${i}`;
    nodes.push({
      id,
      kind: "model",
      modelId: m.modelId,
      label: m.label,
      x: X_MODEL,
      y: cursorY,
    });
    connections.push({
      id: `c-${prevId}-${id}`,
      fromId: prevId,
      fromPort: "bottom",
      toId: id,
      toPort: "top",
    });
    cursorY += NODE_H + VERTICAL_GAP;
    prevId = id;
  }

  const endId = "__end__";
  nodes.push({ id: endId, kind: "end", x: TERMINAL_X, y: cursorY });
  connections.push({
    id: `c-${prevId}-${endId}`,
    fromId: prevId,
    fromPort: "bottom",
    toId: endId,
    toPort: "top",
  });

  return { nodes, connections };
}

export default WorkflowCanvasView;
