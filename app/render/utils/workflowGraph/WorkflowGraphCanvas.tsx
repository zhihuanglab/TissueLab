"use client"

import React from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { Boxes, ListChecks, Play, RotateCw, Square, X } from "lucide-react"
import {
  getCodingAgentCardBadge,
  getScriptRunPolicy,
  mergePanelContentWithFactoryDefaults,
  SCRIPT_LAST_RUN_DIGEST_KEY,
} from "@/utils/workflow/codingAgentPolicy"
import {
  CODING_GRAPH_MODEL_ID,
  PROGRESS_BAR_H,
  registryCategoryNames,
  registryNodes,
} from "@/utils/workflowGraph/constants"
import { createInitialSubStages, nodeHeight, nodeWidth } from "@/utils/workflowGraph/graphNode"
import { PortTriangle } from "@/utils/workflowGraph/PortTriangle"
import type { GraphConnection, GraphNode, PortSide, SubStage } from "@/utils/workflowGraph/types"

const RUNTIME_TEMPLATE_SUBSTAGE_MODEL_IDS = new Set([
  "ClassificationNode",
  "PatchClassifier",
  "MuskClassification",
])

export type WorkflowGraphConnectingState = {
  fromId: string
  fromPort: PortSide
  mouseX: number
  mouseY: number
} | null

export interface WorkflowGraphCanvasProps {
  canvasRef: React.RefObject<HTMLDivElement | null>
  contentWrapperRef: React.RefObject<HTMLDivElement | null>
  panOffsetRef: React.RefObject<{ x: number; y: number }>
  connectingState: WorkflowGraphConnectingState
  isPanning: boolean
  intentPromptOpen: boolean
  intentText: string
  workflowStatus: string
  queuePosition: number
  queueTotal: number
  modelNodeCount: number
  wrapperW: number
  wrapperH: number
  yScale: number
  canvasSize: { w: number; h: number }
  panOffset: { x: number; y: number }
  connections: GraphConnection[]
  nodes: GraphNode[]
  selectedId: string | null
  runningId: string | null
  clickedConn: { id: string; x: number; y: number } | null
  dragging: { id: string; offsetX: number; offsetY: number } | null
  isRunning: boolean
  isBatchRunning: boolean
  isStoppingWorkflow: boolean
  graphCodingRunNodeId: string | null
  completedIds: Set<string>
  runtimeNodeProgressById: Record<string, number>
  runtimeNodeSubStagesById: Record<string, SubStage[]>
  graphNodeStatusMap: Record<string, unknown>
  getPortPos: (node: GraphNode, side: PortSide) => { x: number; y: number }
  ensureLegacyPanel: (node: GraphNode) => WorkflowPanel | null
  runtimeKeyCandidates: (modelId?: string) => string[]
  firstNumericRuntimeValue: (vals: unknown[]) => number | undefined
  handleCanvasMouseDown: (e: React.MouseEvent) => void
  handleCanvasMouseMove: (e: React.MouseEvent) => void
  handleCanvasMouseUp: (e: React.MouseEvent) => void
  setClickedConn: React.Dispatch<React.SetStateAction<{ id: string; x: number; y: number } | null>>
  dismissIntentPrompt: () => void
  setIntentText: (v: string) => void
  submitIntentPrompt: () => void
  stopWorkflow: () => void | Promise<void>
  runWorkflow: () => void | Promise<void>
  openBatchDialog: () => void
  deleteConnection: (id: string) => void
  handleNodeMouseDown: (e: React.MouseEvent, id: string) => void
  handleNodeDoubleClick: (id: string) => void
  handleOutputPortMouseDown: (e: React.MouseEvent, id: string, port: PortSide) => void
  handleInputPortMouseUp: (e: React.MouseEvent, id: string, port: PortSide) => void
  deleteNode: (id: string) => void
  /** Re-run a single model node from the card (same as dock “Run all” for that node). */
  runOneNode: (nodeId: string) => void | Promise<void>
}

type WorkflowModelNodeCardProps = {
  n: GraphNode
  yScale: number
  w: number
  h: number
  stages?: SubStage[]
  totalBarsH: number
  pct: number
  isRun: boolean
  isDone: boolean
  isSelected: boolean
  isDragging: boolean
  isRunning: boolean
  codingBadge: string | null
  handleNodeMouseDown: (e: React.MouseEvent, id: string) => void
  handleNodeDoubleClick: (id: string) => void
  runOneNode: (nodeId: string) => void | Promise<void>
  deleteNode: (id: string) => void
  handleInputPortMouseUp: (e: React.MouseEvent, id: string, port: PortSide) => void
  handleOutputPortMouseDown: (e: React.MouseEvent, id: string, port: PortSide) => void
}

const sameSubStages = (a?: SubStage[], b?: SubStage[]) => {
  if (a === b) return true
  if (!a || !b) return !a && !b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].key !== b[i].key || a[i].label !== b[i].label || a[i].progress !== b[i].progress) return false
  }
  return true
}

const WorkflowModelNodeCard = React.memo((props: WorkflowModelNodeCardProps) => {
  const {
    n,
    yScale,
    w,
    h,
    stages,
    totalBarsH,
    pct,
    isRun,
    isDone,
    isSelected,
    isDragging,
    isRunning,
    codingBadge,
    handleNodeMouseDown,
    handleNodeDoubleClick,
    runOneNode,
    deleteNode,
    handleInputPortMouseUp,
    handleOutputPortMouseDown,
  } = props
  const meta = n.modelId ? registryNodes[n.modelId] : undefined
  const label = n.label || meta?.displayName || n.modelId || "Node"
  const iconUrl = meta?.icon

  return (
    <div
      data-workflow-node="true"
      data-workflow-node-id={n.id}
      className="group absolute select-none"
      style={{ left: n.x, top: n.y * yScale, width: w, height: h, zIndex: isDragging ? 20 : 10 }}
      onMouseDown={(e) => handleNodeMouseDown(e, n.id)}
      onDoubleClick={() => handleNodeDoubleClick(n.id)}
    >
      <div className="pointer-events-none absolute -bottom-5 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-foreground/85 px-2 py-0.5 text-[10px] text-background shadow group-hover:block">
        Double-click to configure
      </div>
      <div
        className={`relative flex h-full w-full items-center gap-2 rounded-lg border-2 bg-card px-2 shadow-sm transition-shadow hover:shadow-md ${
          isRun
            ? "animate-pulse border-amber-500 ring-2 ring-amber-300/50"
            : isSelected
            ? "border-primary ring-2 ring-primary/30"
            : isDone
            ? "border-primary/80"
            : "border-primary/60"
        }`}
        style={{ paddingBottom: totalBarsH }}
      >
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
          {iconUrl ? (
            <Image src={iconUrl} alt={label} width={36} height={36} className="h-full w-full object-cover" />
          ) : (
            <Boxes className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground" title={label}>
            {label}
          </div>
          {meta?.factory && (
            <div className="truncate text-[10px] text-muted-foreground">
              {registryCategoryNames[meta.factory] || meta.factory}
            </div>
          )}
          {codingBadge && (
            <div
              className={
                n.modelId === CODING_GRAPH_MODEL_ID
                  ? "line-clamp-2 whitespace-normal break-words text-[10px] font-medium leading-snug text-primary"
                  : "truncate text-[9px] font-medium text-primary"
              }
              title={codingBadge}
            >
              {codingBadge}
            </div>
          )}
        </div>
        {n.modelId && n.modelId !== CODING_GRAPH_MODEL_ID && (
          <button
            type="button"
            onMouseDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
            }}
            onClick={(e) => {
              e.stopPropagation()
              void runOneNode(n.id)
            }}
            disabled={isRunning}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-primary/60 bg-primary/10 text-primary transition-colors hover:bg-primary hover:text-primary-foreground disabled:pointer-events-none disabled:opacity-40"
            title="Re-run this node"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 group-hover:flex"
          onMouseDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          onClick={(e) => {
            e.stopPropagation()
            deleteNode(n.id)
          }}
          title="Delete node"
        >
          <span className="text-[10px] leading-none">×</span>
        </button>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-b-md">
          {stages && stages.length > 0 ? (
            stages.map((s, i) => {
              const sPct = Math.max(0, Math.min(100, s.progress))
              const isLast = i === stages.length - 1
              return (
                <div
                  key={s.key}
                  className={`relative bg-muted ${i > 0 ? "border-t border-border/50" : ""}`}
                  style={{ height: PROGRESS_BAR_H }}
                >
                  <div
                    className={`h-full transition-all duration-200 ${sPct >= 100 ? "bg-primary" : "bg-primary/70"}`}
                    style={{ width: `${sPct}%` }}
                  />
                  <div className="absolute inset-0 flex items-center justify-between gap-2 px-2">
                    <span className={`truncate text-[9px] font-medium ${sPct >= 100 ? "text-white" : "text-foreground/85"}`}>
                      {s.label}
                    </span>
                    <span className={`flex-shrink-0 text-[9px] tabular-nums ${sPct >= 100 ? "text-white" : "text-foreground/85"}`}>
                      {sPct >= 100 ? "Processed" : (isRun || sPct > 0) ? `${sPct}%` : "Pending"}
                    </span>
                  </div>
                </div>
              )
            })
          ) : (
            <div className="relative bg-muted" style={{ height: PROGRESS_BAR_H + 2 }}>
              <div
                className={`h-full transition-all duration-200 ${pct >= 100 ? "bg-primary" : "bg-primary/70"}`}
                style={{ width: `${pct}%` }}
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className={`text-[10px] font-medium tabular-nums ${pct >= 100 ? "text-white" : "text-foreground/85"}`}>
                  {pct >= 100 ? "Processed" : (isRun || pct > 0) ? `${pct}%` : "Pending"}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div
        className="absolute cursor-pointer transition-transform hover:scale-125"
        style={{ left: -12, top: h / 2 - 6, zIndex: 30 }}
        onMouseUp={(e) => handleInputPortMouseUp(e, n.id, "left")}
        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
      >
        <PortTriangle direction="right" filled={false} />
      </div>
      <div
        className="absolute cursor-pointer transition-transform hover:scale-125"
        style={{ left: w / 2 - 6, top: -12, zIndex: 30 }}
        onMouseUp={(e) => handleInputPortMouseUp(e, n.id, "top")}
        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
      >
        <PortTriangle direction="down" filled={false} />
      </div>
      <div
        className="absolute cursor-pointer transition-transform hover:scale-125"
        style={{ right: -12, top: h / 2 - 6, zIndex: 30 }}
        onMouseDown={(e) => handleOutputPortMouseDown(e, n.id, "right")}
      >
        <PortTriangle direction="right" filled={true} />
      </div>
      <div
        className="absolute cursor-pointer transition-transform hover:scale-125"
        style={{ left: w / 2 - 6, bottom: -12, zIndex: 30 }}
        onMouseDown={(e) => handleOutputPortMouseDown(e, n.id, "bottom")}
      >
        <PortTriangle direction="down" filled={true} />
      </div>
    </div>
  )
}, (prev, next) => {
  return (
    prev.n === next.n &&
    prev.yScale === next.yScale &&
    prev.w === next.w &&
    prev.h === next.h &&
    prev.totalBarsH === next.totalBarsH &&
    prev.pct === next.pct &&
    prev.isRun === next.isRun &&
    prev.isDone === next.isDone &&
    prev.isSelected === next.isSelected &&
    prev.isDragging === next.isDragging &&
    prev.isRunning === next.isRunning &&
    prev.codingBadge === next.codingBadge &&
    sameSubStages(prev.stages, next.stages)
  )
})

export function WorkflowGraphCanvas(props: WorkflowGraphCanvasProps) {
  const {
    canvasRef,
    contentWrapperRef,
    panOffsetRef,
    connectingState,
    isPanning,
    intentPromptOpen,
    intentText,
    workflowStatus,
    queuePosition,
    queueTotal,
    modelNodeCount,
    wrapperW,
    wrapperH,
    yScale,
    canvasSize,
    panOffset,
    connections,
    nodes,
    selectedId,
    runningId,
    clickedConn,
    dragging,
    isRunning,
    isBatchRunning,
    isStoppingWorkflow,
    graphCodingRunNodeId,
    completedIds,
    runtimeNodeProgressById,
    runtimeNodeSubStagesById,
    graphNodeStatusMap,
    getPortPos,
    ensureLegacyPanel,
    runtimeKeyCandidates,
    firstNumericRuntimeValue,
    handleCanvasMouseDown,
    handleCanvasMouseMove,
    handleCanvasMouseUp,
    setClickedConn,
    dismissIntentPrompt,
    setIntentText,
    submitIntentPrompt,
    stopWorkflow,
    runWorkflow,
    openBatchDialog,
    deleteConnection,
    handleNodeMouseDown,
    handleNodeDoubleClick,
    handleOutputPortMouseDown,
    handleInputPortMouseUp,
    deleteNode,
    runOneNode,
  } = props

  return (
    <>
      {/* ─── Canvas ─── */}
      <div
        ref={canvasRef}
        className="relative flex-1 overflow-hidden bg-muted/30"
        style={{
          backgroundImage: "radial-gradient(circle, hsl(var(--border)) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
          cursor: connectingState ? "crosshair" : isPanning ? "grabbing" : "grab",
        }}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleCanvasMouseMove}
        onMouseUp={handleCanvasMouseUp}
        onMouseLeave={handleCanvasMouseUp}
        onClick={() => setClickedConn(null)}
      >
        {/* Intent prompt — pinned to the bottom-right of the Agentic AI sidebar */}
        {intentPromptOpen && (
          <div className="pointer-events-none absolute bottom-14 right-3 z-40">
            <div className="pointer-events-auto w-80 rounded-xl border border-primary/40 bg-card/95 p-3 shadow-lg backdrop-blur-sm animate-in fade-in slide-in-from-bottom-2 duration-200">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">What can I help you with today?</div>
                  <div className="text-[11px] text-muted-foreground">Type your question or what you'd like the agent to build.</div>
                </div>
                <button
                  type="button"
                  onClick={dismissIntentPrompt}
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex items-end gap-2">
                <Textarea
                  value={intentText}
                  onChange={(e) => setIntentText(e.target.value)}
                  placeholder="e.g. Count tumor cells and lymphocytes on this slide"
                  rows={2}
                  className="min-h-0 flex-1 resize-none text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      submitIntentPrompt()
                    }
                  }}
                />
                <div className="flex flex-col gap-1">
                  <Button size="sm" className="h-7 bg-primary text-primary-foreground hover:bg-primary/90" onClick={submitIntentPrompt}>
                    Ask
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={dismissIntentPrompt}>
                    Skip
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Run / Stop Workflow button — pinned to the top-right of the canvas */}
        <div className="pointer-events-none absolute right-3 top-3 z-40 flex flex-col items-end gap-1">
          {isRunning && workflowStatus === "queued" && queueTotal > 0 && (
            <div className="pointer-events-none rounded-md border border-border bg-background/95 px-2 py-0.5 text-[10px] text-muted-foreground shadow">
              Queue {queuePosition + 1} / {queueTotal}
            </div>
          )}
          {isRunning && workflowStatus === "running" && (
            <div className="pointer-events-none rounded-md border border-border bg-background/95 px-2 py-0.5 text-[10px] text-muted-foreground shadow">
              Running
            </div>
          )}
          {isBatchRunning ? (
            <div className="pointer-events-auto flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 bg-background/95 shadow-lg"
                onClick={openBatchDialog}
              >
                <ListChecks className="h-3.5 w-3.5" />
                Details
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-8 gap-1 shadow-lg"
                onClick={stopWorkflow}
                disabled={isStoppingWorkflow}
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                {isStoppingWorkflow ? "Stopping..." : "Stop Batch"}
              </Button>
            </div>
          ) : isRunning ? (
              <Button
                size="sm"
                variant="destructive"
                className="pointer-events-auto h-8 gap-1 shadow-lg"
                onClick={stopWorkflow}
                disabled={isStoppingWorkflow}
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                {isStoppingWorkflow ? "Stopping..." : "Stop"}
              </Button>
          ) : (
            <div className="pointer-events-auto flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 bg-background/95 shadow-lg"
                onClick={openBatchDialog}
                disabled={modelNodeCount === 0}
                title={modelNodeCount === 0 ? "Add at least one model node first" : "Batch process workflow"}
              >
                <ListChecks className="h-3.5 w-3.5" />
                Batch
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1 bg-primary text-primary-foreground shadow-lg hover:bg-primary/90"
                onClick={runWorkflow}
                disabled={modelNodeCount === 0}
                title={modelNodeCount === 0 ? "Add at least one model node first" : "Run workflow"}
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                Run Workflow
              </Button>
            </div>
          )}
        </div>
        {modelNodeCount === 0 && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4">
            <div className="flex max-w-sm flex-col items-center gap-2 text-center text-sm text-muted-foreground text-balance">
              <Boxes className="h-8 w-8 opacity-60" aria-hidden />
              <p className="m-0">
                Click <span className="font-medium text-foreground">Add Node</span> to drop a model between Start and End.
              </p>
            </div>
          </div>
        )}

        {/* Content wrapper — no CSS scale; node Y positions are computed via yScale so the spacing
            between cards compresses while card sizes (icons + width + height) stay unchanged. */}
        <div
          ref={contentWrapperRef}
          className="absolute left-0 top-0"
          style={{
            width: wrapperW,
            height: Math.max(wrapperH * yScale, canvasSize.h || wrapperH),
            transform: `translate(${panOffset.x}px, ${panOffset.y}px)`,
          }}
        >

        {/* SVG: connections */}
        <svg
          className="absolute inset-0"
          style={{ zIndex: 1, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}
        >
          {connections.map((conn) => {
            const from = nodes.find((n) => n.id === conn.fromId)
            const to = nodes.find((n) => n.id === conn.toId)
            if (!from || !to) return null
            const connActive =
              Boolean(runningId) && (conn.fromId === runningId || conn.toId === runningId)
            const start = getPortPos(from, conn.fromPort)
            const end = getPortPos(to, conn.toPort)
            const dx = end.x - start.x
            const dy = end.y - start.y
            const dist = Math.sqrt(dx * dx + dy * dy)
            const off = Math.max(40, dist * 0.3)
            const cs = { x: start.x, y: start.y }
            const ce = { x: end.x, y: end.y }
            if (conn.fromPort === "right") cs.x += off
            else if (conn.fromPort === "left") cs.x -= off
            else if (conn.fromPort === "bottom") cs.y += off
            else if (conn.fromPort === "top") cs.y -= off
            if (conn.toPort === "right") ce.x += off
            else if (conn.toPort === "left") ce.x -= off
            else if (conn.toPort === "bottom") ce.y += off
            else if (conn.toPort === "top") ce.y -= off
            const d = `M ${start.x} ${start.y} C ${cs.x} ${cs.y}, ${ce.x} ${ce.y}, ${end.x} ${end.y}`
            return (
              <g key={conn.id} data-workflow-connection="true" style={{ pointerEvents: "auto" }}>
                <path
                  d={d}
                  stroke="hsl(var(--primary))"
                  strokeWidth={connActive ? 4 : 2}
                  fill="none"
                  opacity={connActive ? 1 : 0.7}
                />
                <path
                  d={d}
                  stroke="transparent"
                  strokeWidth={16}
                  fill="none"
                  style={{ cursor: "pointer", pointerEvents: "stroke" }}
                  onClick={(e) => {
                    e.stopPropagation()
                    const rect = canvasRef.current?.getBoundingClientRect()
                    if (!rect) return
                    const pan = panOffsetRef.current
                    // Button is positioned in canvas-visual pixels — store raw offsets.
                    setClickedConn({
                      id: conn.id,
                      x: e.clientX - rect.left - pan.x,
                      y: e.clientY - rect.top - pan.y,
                    })
                  }}
                />
              </g>
            )
          })}

          {connectingState &&
            (() => {
              const from = nodes.find((n) => n.id === connectingState.fromId)
              if (!from) return null
              const start = getPortPos(from, connectingState.fromPort)
              const dx = connectingState.mouseX - start.x
              const dy = connectingState.mouseY - start.y
              const off = Math.max(40, Math.sqrt(dx * dx + dy * dy) * 0.3)
              const cs = { x: start.x, y: start.y }
              if (connectingState.fromPort === "right") cs.x += off
              else if (connectingState.fromPort === "left") cs.x -= off
              else if (connectingState.fromPort === "bottom") cs.y += off
              else if (connectingState.fromPort === "top") cs.y -= off
              const mx = (start.x + connectingState.mouseX) / 2
              const my = (start.y + connectingState.mouseY) / 2
              return (
                <path
                  d={`M ${start.x} ${start.y} C ${cs.x} ${cs.y}, ${mx} ${my}, ${connectingState.mouseX} ${connectingState.mouseY}`}
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="none"
                  opacity={0.5}
                  strokeDasharray="6 3"
                />
              )
            })()}
        </svg>

        {clickedConn && (
          <button
            type="button"
            className="absolute z-50 flex items-center gap-1 rounded border border-destructive bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground shadow-lg"
            style={{ left: clickedConn.x + 8, top: clickedConn.y - 14 }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              deleteConnection(clickedConn.id)
              setClickedConn(null)
            }}
          >
            Delete connection
          </button>
        )}

        {/* Nodes */}
        {nodes.map((n) => {
          const isStart = n.kind === "start"
          const isEnd = n.kind === "end"
          const isTerm = isStart || isEnd
          const w = nodeWidth(n)
          const h = nodeHeight(n)
          const graphRuntimeActive = isRunning || isBatchRunning || workflowStatus === "running" || workflowStatus === "queued"
          const runtimeFallbackStages =
            graphRuntimeActive && n.kind === "model" && n.modelId && RUNTIME_TEMPLATE_SUBSTAGE_MODEL_IDS.has(n.modelId)
              ? createInitialSubStages(n.modelId)
              : undefined
          const stages = runtimeNodeSubStagesById[n.id] ?? runtimeFallbackStages ?? n.subStages
          const stageCount = stages?.length ?? 0
          const totalBarsH = (stageCount || 1) * PROGRESS_BAR_H
          // Single-stage progress (used when no subStages). For multi-stage, isDone uses every stage at 100.
          const pct = Math.max(0, Math.min(100, runtimeNodeProgressById[n.id] ?? n.progress ?? 0))
          const isRun = runningId === n.id
          const isDone =
            completedIds.has(n.id) ||
            (stages && stages.length > 0
              ? stages.every((s) => s.progress >= 100)
              : pct >= 100)

          if (isTerm) {
            const label = isStart ? "Start" : "End"
            // Use TissueLab primary (purple) for both terminals; lighter fill for End to differentiate.
            const ringClass = isStart
              ? "border-primary bg-primary text-primary-foreground"
              : "border-primary bg-primary/10 text-primary"
            return (
              <div
                key={n.id}
                data-workflow-node="true"
                data-workflow-node-id={n.id}
                className="absolute select-none"
                style={{ left: n.x, top: n.y * yScale, width: w, height: h, zIndex: dragging?.id === n.id ? 20 : 10 }}
                onMouseDown={(e) => handleNodeMouseDown(e, n.id)}
              >
                <div
                  className={`flex h-full w-full items-center justify-center rounded-full border-2 text-[11px] font-bold shadow-sm ${ringClass}`}
                >
                  {label}
                </div>
                {isStart && (
                  <div
                    className="absolute cursor-pointer transition-transform hover:scale-125"
                    style={{ left: w / 2 - 6, bottom: -12, zIndex: 30 }}
                    onMouseDown={(e) => handleOutputPortMouseDown(e, n.id, "bottom")}
                  >
                    <PortTriangle direction="down" filled={true} />
                  </div>
                )}
                {isEnd && (
                  <div
                    className="absolute cursor-pointer transition-transform hover:scale-125"
                    style={{ left: w / 2 - 6, top: -12, zIndex: 30 }}
                    onMouseUp={(e) => handleInputPortMouseUp(e, n.id, "top")}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                    }}
                  >
                    <PortTriangle direction="down" filled={false} />
                  </div>
                )}
              </div>
            )
          }

          let codingBadge: string | null = null
          if (n.modelId === CODING_GRAPH_MODEL_ID) {
            const pnl = ensureLegacyPanel(n)
            if (pnl) {
              const merged = mergePanelContentWithFactoryDefaults(pnl.content, "CodingAgent")
              const scriptItem = merged.find((c: { key?: string }) => c.key === "generated_script")
              const scriptSrc = typeof scriptItem?.value === "string" ? scriptItem.value : ""
              const hasScript = Boolean(scriptSrc.trim())
              const pol = getScriptRunPolicy(merged)
              const lastRun =
                (merged.find((c: { key?: string }) => c.key === SCRIPT_LAST_RUN_DIGEST_KEY)?.value as string) || ""
              const gptBackend =
                firstNumericRuntimeValue(
                  runtimeKeyCandidates(n.modelId).map((k) => graphNodeStatusMap[k])
                ) ?? 0
              codingBadge = getCodingAgentCardBadge({
                hasGeneratedScript: hasScript,
                scriptSource: scriptSrc,
                policy: pol,
                gptBackendStatus: Number(gptBackend),
                workflowRunning: isRunning,
                executeInFlight: graphCodingRunNodeId === n.id,
                lastRunDigest: lastRun,
              })
            }
          }
          return (
            <WorkflowModelNodeCard
              key={n.id}
              n={n}
              yScale={yScale}
              w={w}
              h={h}
              stages={stages}
              totalBarsH={totalBarsH}
              pct={pct}
              isRun={isRun}
              isDone={isDone}
              isSelected={selectedId === n.id}
              isDragging={dragging?.id === n.id}
              isRunning={isRunning}
              codingBadge={codingBadge}
              handleNodeMouseDown={handleNodeMouseDown}
              handleNodeDoubleClick={handleNodeDoubleClick}
              runOneNode={runOneNode}
              deleteNode={deleteNode}
              handleInputPortMouseUp={handleInputPortMouseUp}
              handleOutputPortMouseDown={handleOutputPortMouseDown}
            />
          )
        })}
        </div>
      </div>
    </>
  )
}
