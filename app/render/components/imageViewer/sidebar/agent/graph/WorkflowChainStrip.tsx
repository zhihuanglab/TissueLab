"use client"

import React from "react"
import { Maximize2 } from "lucide-react"
import { registryNodes } from "@/utils/agent/graph/constants"
import type { GraphConnection, GraphNode } from "@/types/graph.types"

/**
 * Compact horizontal overview of the workflow chain rendered as a row of DOTS:
 * Start · ● · ● · End. Each model node is one dot whose fill level shows its
 * progress; click a dot to select that node (drives the configuration panel
 * below). The full editable graph (add node, run, batch, connect…) lives in the
 * "expand" popup. Dot order follows the chain walked from START via connections,
 * falling back to array order for anything unreached.
 */

export interface WorkflowChainStripProps {
  nodes: GraphNode[]
  connections: GraphConnection[]
  selectedId: string | null
  onSelect: (id: string) => void
  onExpand: () => void
  runningId?: string | null
  /** Runtime progress 0–100 per node id; falls back to node.progress. */
  progressById?: Record<string, number>
}

function orderedChain(nodes: GraphNode[], connections: GraphConnection[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const nextOf = new Map<string, string>()
  for (const c of connections) if (!nextOf.has(c.fromId)) nextOf.set(c.fromId, c.toId)
  const start = nodes.find((n) => n.kind === "start")
  const ordered: GraphNode[] = []
  const seen = new Set<string>()
  if (start) {
    ordered.push(start)
    seen.add(start.id)
    let cur = nextOf.get(start.id)
    while (cur && !seen.has(cur)) {
      const node = byId.get(cur)
      if (node) {
        ordered.push(node)
        seen.add(cur)
      }
      cur = nextOf.get(cur)
    }
  }
  for (const n of nodes) if (!seen.has(n.id)) ordered.push(n)
  return ordered
}

const WorkflowChainStrip: React.FC<WorkflowChainStripProps> = ({
  nodes,
  connections,
  selectedId,
  onSelect,
  onExpand,
  runningId,
  progressById,
}) => {
  const chain = React.useMemo(() => orderedChain(nodes, connections), [nodes, connections])
  const modelCount = chain.filter((n) => n.kind === "model").length

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-muted/20 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Workflow overview
        </span>
        <button
          type="button"
          onClick={onExpand}
          title="Open the detailed graph"
          className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          Expand
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto py-1.5">
        {chain.map((n, i) => {
          const isLast = i === chain.length - 1
          const connector = !isLast ? (
            <span key={`c-${n.id}`} className="h-px w-3 shrink-0 bg-muted-foreground/40" />
          ) : null

          // Terminals: tiny solid dots, no progress.
          if (n.kind === "start" || n.kind === "end") {
            return (
              <React.Fragment key={n.id}>
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/60"
                  title={n.kind === "start" ? "Start" : "End"}
                />
                {connector}
              </React.Fragment>
            )
          }

          const meta = n.modelId ? registryNodes[n.modelId] : undefined
          const label = n.label || meta?.displayName || n.modelId || "Node"
          const isSelected = selectedId === n.id
          const isRun = !!runningId && runningId === n.id
          const pctRaw = progressById?.[n.id] ?? n.progress ?? 0
          const pct = Math.max(0, Math.min(100, pctRaw))

          return (
            <React.Fragment key={n.id}>
              <button
                type="button"
                onClick={() => onSelect(n.id)}
                title={`${label}${pct > 0 ? ` — ${Math.round(pct)}%` : ""}`}
                aria-label={label}
                className={`flex shrink-0 items-center gap-1.5 rounded-full border bg-card py-1 pl-1 pr-2 transition-colors hover:border-primary/60 ${
                  isSelected ? "border-primary ring-1 ring-primary/30" : "border-border"
                }`}
              >
                {/* Dot: fill level rises from the bottom to show progress. */}
                <span
                  className={`relative h-3.5 w-3.5 shrink-0 overflow-hidden rounded-full border-2 ${
                    isRun
                      ? "animate-pulse border-amber-500"
                      : isSelected
                        ? "border-primary"
                        : "border-primary/60"
                  }`}
                >
                  <span
                    className={`absolute inset-x-0 bottom-0 ${pct >= 100 ? "bg-primary" : "bg-primary/70"}`}
                    style={{ height: `${pct}%` }}
                  />
                </span>
                <span className="max-w-[120px] truncate text-[11px] font-medium text-foreground">{label}</span>
              </button>
              {connector}
            </React.Fragment>
          )
        })}
        {modelCount === 0 && (
          <span className="px-1 text-[11px] text-muted-foreground">No nodes yet — expand to build the workflow.</span>
        )}
      </div>
    </div>
  )
}

export default WorkflowChainStrip
