"use client"

import React from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label as UILabel } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useSelector } from "react-redux"
import {
  graphClassificationStageDone,
  graphClassifierTasknodePersistModelName,
} from "@/utils/workflowGraph/graphClassifierExport"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Chatbox } from "@/components/imageViewer/RightSidebar/Agent/Chatbox"
import { DiscoveryPanel } from "@/components/imageViewer/RightSidebar/Agent/DiscoveryPanel"
import WorkflowGraphActiveLearning from "@/components/imageViewer/RightSidebar/Agent/Workflow/WorkflowGraphActiveLearning"
import { NucleiSegRegionAndMppPanel } from "@/components/imageViewer/RightSidebar/Agent/Workflow/NucleiSegRegionAndMppPanel"
import { WorkflowGraphCustomPanelFields } from "@/utils/workflowGraph/WorkflowGraphCustomPanelFields"
import { TissueSegEmbeddingFields } from "@/utils/workflowGraph/TissueSegEmbeddingFields"
import { ClassificationPanelContent } from "@/components/imageViewer/RightSidebar/Agent/Workflow/ClassificationPanelContent"
import { PatchClassificationPanel } from "@/components/imageViewer/RightSidebar/Agent/Workflow/PatchClassificationPanel"
import { CodePanelContent } from "@/components/imageViewer/RightSidebar/Agent/Workflow/CodePanelContent"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import type { RootState } from "@/store"
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  GripHorizontal,
  MessageSquareText,
  Play,
  RotateCw,
  Save,
  Settings2,
  Square,
  TerminalSquare,
  X,
} from "lucide-react"
import { MODEL_SUBSTAGES, registryCategoryNames, registryNodes } from "@/utils/workflowGraph/constants"
import type { GraphNode } from "@/utils/workflowGraph/types"
import type { GeneratedWorkflowStep } from "@/components/imageViewer/RightSidebar/Agent/Chatbox"

type BottomMode = "none" | "chat" | "config"

function panelFromRegistryDefinition(
  node: GraphNode,
  meta: { displayName?: string; panel?: WorkflowPanel["content"] } | undefined,
  fallbackPanel: WorkflowPanel | null,
): WorkflowPanel | null {
  if (!Array.isArray(meta?.panel)) return fallbackPanel

  const existingByKey = new Map((fallbackPanel?.content ?? []).map((item) => [item.key, item]))
  const content = meta.panel.map((item) => {
    const existing = existingByKey.get(item.key)
    return existing ? { ...item, value: existing.value } : { ...item }
  })

  return {
    id: fallbackPanel?.id ?? node.id,
    title: fallbackPanel?.title ?? meta.displayName ?? node.label ?? node.modelId ?? "Node",
    type: fallbackPanel?.type ?? node.modelId ?? "CustomNode",
    progress: fallbackPanel?.progress ?? 0,
    ui: fallbackPanel?.ui ?? null,
    stepName: fallbackPanel?.stepName,
    content,
  }
}

export interface WorkflowGraphBottomDockProps {
  bottomPanelRef: React.RefObject<HTMLDivElement | null>
  dockStripRef: React.RefObject<HTMLDivElement | null>
  bottomMode: BottomMode
  sheetAnimPx: number | null
  expandedHeight: number | null
  isResizing: boolean
  handleBottomPanelTransitionEnd: (e: React.TransitionEvent<HTMLDivElement>) => void
  beginResize: (e: React.MouseEvent) => void
  togglePane: (mode: "chat" | "config") => void
  startBottomPanelClose: () => void
  handleGeneratedWorkflow: (steps: GeneratedWorkflowStep[], formattedPath: string) => void
  selectedNode: GraphNode | null | undefined
  runningId: string | null
  isRunning: boolean
  stopWorkflow: () => void | Promise<void>
  runStage: (nodeId: string, stageIdx: number) => void | Promise<void>
  runOneNode: (nodeId: string) => void | Promise<void>
  openNodeLogs: (nodeId: string) => void
  openClassifierSave: (nodeId: string) => void
  openClassifierLoad: (nodeId: string) => void
  openActiveLearning: (nodeId: string) => void
  setClassifierMode: (nodeId: string, mode: "multiclass" | "one-vs-rest") => void
  clearLoadedClassifier: (nodeId: string) => void
  /** When set, NuClass / VISTA / patch panels use hook-based start_workflow (SSE) from the graph. */
  graphStartWorkflow?: (payload: Record<string, unknown>) => Promise<unknown>
  ensureLegacyPanel: (node: GraphNode) => WorkflowPanel | null
  handleLegacyPanelChange: (panelId: string, updated: WorkflowPanel) => void
  updateNodeField: (nodeId: string, patch: Partial<Pick<GraphNode, "label" | "description">>) => void
  firstNumericRuntimeValue: (vals: unknown[]) => number | undefined
  runtimeKeyCandidates: (modelId?: string) => string[]
  graphNodeStatusMap: Record<string, unknown>
  graphCodingRunNodeId: string | null
  setGraphCodingRunNodeId: React.Dispatch<React.SetStateAction<string | null>>
  configTab: "config" | "annotation" | "active-learning"
  setConfigTab: React.Dispatch<React.SetStateAction<"config" | "annotation" | "active-learning">>
}

export function WorkflowGraphBottomDock(props: WorkflowGraphBottomDockProps) {
  const selectedAgent = useSelector((state: RootState) => state.agent.selectedAgent)
  const isDiscovery = selectedAgent === "TL Discovery"
  const {
    bottomPanelRef,
    dockStripRef,
    bottomMode,
    sheetAnimPx,
    expandedHeight,
    isResizing,
    handleBottomPanelTransitionEnd,
    beginResize,
    togglePane,
    startBottomPanelClose,
    handleGeneratedWorkflow,
    selectedNode,
    runningId,
    isRunning,
    stopWorkflow,
    runStage,
    runOneNode,
    openNodeLogs,
    openClassifierSave,
    openClassifierLoad,
    openActiveLearning,
    setClassifierMode,
    clearLoadedClassifier,
    graphStartWorkflow,
    ensureLegacyPanel,
    handleLegacyPanelChange,
    updateNodeField,
    firstNumericRuntimeValue,
    runtimeKeyCandidates,
    graphNodeStatusMap,
    graphCodingRunNodeId,
    setGraphCodingRunNodeId,
    configTab,
    setConfigTab,
  } = props

  return (
    <>
      {/* ─── Bottom panel: single shell so height can transition on open and close; dock stays inside. ─── */}
      <div
        ref={bottomPanelRef}
        className={`absolute inset-x-0 bottom-0 z-50 overflow-hidden ${
          bottomMode === "none" ? "h-10" : sheetAnimPx === null && expandedHeight === null ? "h-3/5" : ""
        }`}
        style={{
          height:
            bottomMode === "none"
              ? undefined
              : sheetAnimPx !== null
                ? sheetAnimPx
                : expandedHeight !== null
                  ? expandedHeight
                  : undefined,
          transition: isResizing ? "none" : "height 200ms ease-out",
        }}
        onTransitionEnd={handleBottomPanelTransitionEnd}
      >
        <div className="relative h-full min-h-0">
          <div
            className={`flex h-full min-h-0 flex-col overflow-hidden ${
              bottomMode === "none"
                ? "border-0 bg-transparent pb-0 shadow-none"
                : "border-l border-r border-t border-border bg-card pb-10 shadow-[0_-8px_24px_rgba(0,0,0,0.12)]"
            }`}
          >
            {bottomMode !== "none" && (
            <>
            {/* Resize handle — drag to adjust height when expanded */}
            <div
              onMouseDown={beginResize}
              className="group flex h-1.5 flex-shrink-0 cursor-row-resize items-center justify-center bg-border/40 hover:bg-primary/40"
              title="Drag to resize"
            >
              <GripHorizontal className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
            </div>

            {/* Expanded content (grows upward with the sheet; dock overlays the reserved pb-10).
                Slide-in is scoped here only — not on the outer height box — so the dock strip stays put. */}
            <div className="flex min-h-0 flex-1 flex-col animate-in fade-in slide-in-from-bottom-2 duration-200">
            {bottomMode === "chat" ? (
              // `relative` is required because Chatbox's input form uses `absolute bottom-0`
              // — without a positioned ancestor here it escapes and covers the dock strip.
              <div className="relative min-h-0 flex-1 overflow-hidden">
                {isDiscovery ? (
                  <DiscoveryPanel />
                ) : (
                  <Chatbox
                    afterWorkflowCardApply={() => startBottomPanelClose()}
                    onWorkflowGenerated={handleGeneratedWorkflow}
                  />
                )}
              </div>
            ) : (
              <>
                {/* Header for the config pane */}
                <div className="flex h-10 flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {selectedNode ? (() => {
                      const meta = selectedNode.modelId ? registryNodes[selectedNode.modelId] : undefined
                      const heading = selectedNode.label || meta?.displayName || selectedNode.modelId || "Node"
                      return (
                        <>
                          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                            {meta?.icon ? (
                              <Image src={meta.icon} alt={heading} width={28} height={28} className="h-full w-full object-cover" />
                            ) : (
                              <Boxes className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{heading}</div>
                            {meta?.factory && (
                              <div className="truncate text-[10px] text-muted-foreground">
                                {registryCategoryNames[meta.factory] || meta.factory}
                              </div>
                            )}
                          </div>
                        </>
                      )
                    })() : (
                      <div className="text-sm font-semibold text-muted-foreground">Model Configuration</div>
                    )}
                  </div>
                  {selectedNode?.modelId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() => openNodeLogs(selectedNode.id)}
                      title="Open node logs"
                    >
                      <TerminalSquare className="h-3.5 w-3.5" />
                      Logs
                    </Button>
                  )}
                </div>
                {selectedNode && (() => {
                  const _meta = selectedNode.modelId ? registryNodes[selectedNode.modelId] : undefined
                  const _factory = _meta?.factory
                  const _stages = selectedNode.subStages
                  const _stagesDef = selectedNode.modelId ? MODEL_SUBSTAGES[selectedNode.modelId] : undefined
                  const isMultiStage = !!(_stages && _stages.length > 0)

                  if (isMultiStage) {
                    // Unified merged single-pane view for any multi-stage model (NuClass, VISTA, ...).
                    // The whole pane reads as a step-by-step pipeline so it's obvious which steps
                    // are pre-computed, which take user input, and which auto-run after another.
                    const isStageRunning = runningId === selectedNode.id
                    // Class-management UI is shared by:
                    //   • NuClass (NucleiClassify)        — cells, with review panel
                    //   • Patch Classifier (TissueClassify/PatchClassifier) — patches, with review panel
                    //   • MUSK Classification (MuskClassification) — legacy PatchClassificationPanel (“Tissue”)
                    //   • VISTA (TissueSeg/VISTA)         — patches, no review panel
                    const isPatchClassifier = selectedNode.modelId === "PatchClassifier"
                    const isMuskClassification = selectedNode.modelId === "MuskClassification"
                    const isVistaPanel = selectedNode.modelId === "VISTA"
                    const usesClassPanel =
                      _factory === "NucleiClassify" ||
                      isPatchClassifier ||
                      isMuskClassification
                    const panel = usesClassPanel ? ensureLegacyPanel(selectedNode) : null
                    const nucleiSegPanel =
                      _factory === "NucleiSeg" ? ensureLegacyPanel(selectedNode) : null
                    const muskEmbeddingPanel =
                      selectedNode.modelId === "MuskEmbedding" ? ensureLegacyPanel(selectedNode) : null
                    const vistaPanel =
                      isVistaPanel
                        ? panelFromRegistryDefinition(
                            selectedNode,
                            _meta as { displayName?: string; panel?: WorkflowPanel["content"] } | undefined,
                            ensureLegacyPanel(selectedNode),
                          )
                        : null
                    const classRunDone = graphClassificationStageDone(selectedNode)
                    const tasknodeSaveModel = graphClassifierTasknodePersistModelName(selectedNode.modelId)
                    const canSaveGraphClassifier = Boolean(usesClassPanel && panel && classRunDone && tasknodeSaveModel)
                    const saveClassifierTitle = !classRunDone
                      ? "Finish this node's run (including classification) before saving"
                      : !tasknodeSaveModel
                        ? "Save classifier from memory is only for NuClass or MUSK nodes"
                        : "Save the in-memory trained classifier from this run to the sidebar folder (name required)"
                    return (
                      <div className="flex flex-1 flex-col overflow-hidden">
                        {/* NuClass / patch classifiers only - VISTA keeps its original TissueSeg-style panel. */}
                        {usesClassPanel && (
                        <div className="flex flex-shrink-0 flex-col gap-1 border-b border-border bg-card/60 px-3 py-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <div className="text-[11px] font-medium text-muted-foreground">Classifier</div>
                              {/* Segmented mode toggle */}
                              {(() => {
                                const mode = selectedNode.classifierMode ?? "multiclass"
                                const renderTab = (value: "multiclass" | "one-vs-rest", label: string, hint: string) => {
                                  const active = mode === value
                                  return (
                                    <button
                                      key={value}
                                      type="button"
                                      onClick={() => setClassifierMode(selectedNode.id, value)}
                                      className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                                        active
                                          ? "bg-primary text-primary-foreground"
                                          : "text-muted-foreground hover:text-foreground"
                                      }`}
                                      title={hint}
                                    >
                                      {label}
                                    </button>
                                  )
                                }
                                return (
                                  <div className="inline-flex overflow-hidden rounded-full border border-border bg-muted">
                                    {renderTab("multiclass", "Multiclass", "One model head with N classes (softmax).")}
                                    {renderTab("one-vs-rest", "1-vs-Rest", "N independent binary classifiers (one per class).")}
                                  </div>
                                )
                              })()}
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 gap-1 text-xs"
                                disabled={!canSaveGraphClassifier}
                                title={saveClassifierTitle}
                                onClick={() => openClassifierSave(selectedNode.id)}
                              >
                                <Save className="h-3.5 w-3.5" />
                                Save
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 gap-1 text-xs"
                                onClick={() => openClassifierLoad(selectedNode.id)}
                              >
                                <FolderOpen className="h-3.5 w-3.5" />
                                Load
                              </Button>
                            </div>
                          </div>
                          {selectedNode.loadedClassifier && (
                            <div
                              className="flex w-fit max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                              title={selectedNode.loadedClassifier.name}
                            >
                              <span className="truncate">Loaded: {selectedNode.loadedClassifier.name}</span>
                              <button
                                type="button"
                                className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full text-primary/70 hover:bg-primary/20 hover:text-primary"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  clearLoadedClassifier(selectedNode.id)
                                }}
                                title="Clear loaded classifier"
                                aria-label="Clear loaded classifier"
                              >
                                <X className="h-2.5 w-2.5" />
                              </button>
                            </div>
                          )}
                        </div>
                        )}

                        <div className="min-h-0 flex-1 overflow-y-auto">
                          {/* Top: Run-all + step timeline */}
                          <div className="space-y-3 border-b border-border bg-card/40 p-3">
                            <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-foreground">Pipeline</div>
                              <div className="truncate text-[10px] text-muted-foreground">
                                <span className="font-medium text-foreground">{_meta?.displayName || selectedNode.modelId}</span>
                                {" "}— {_stages!.length} steps
                              </div>
                            </div>
                            {isStageRunning ? (
                              <Button size="sm" variant="destructive" className="h-7 gap-1" onClick={stopWorkflow}>
                                <Square className="h-3 w-3 fill-current" />
                                Stop
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                className="h-7 gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
                                onClick={() => runOneNode(selectedNode.id)}
                                disabled={isRunning}
                                title="Run every pending step in order"
                              >
                                <Play className="h-3 w-3 fill-current" />
                                Run all
                              </Button>
                            )}
                          </div>

                          {/* Vertical step timeline */}
                          <ol className="space-y-3">
                            {_stages!.map((s, i) => {
                              const def = _stagesDef?.[i]
                              const sPct = Math.max(0, Math.min(100, s.progress))
                              const isLast = i === _stages!.length - 1
                              const done = sPct >= 100
                              const stepCircle = (
                                <div
                                  className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold transition-colors ${
                                    done
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : "border-primary/40 bg-card text-primary"
                                  }`}
                                >
                                  {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                                </div>
                              )
                              return (
                                <li key={s.key} className="flex gap-3">
                                  {/* Left rail: numbered circle + connector line down to next step */}
                                  <div className="flex flex-col items-center">
                                    {stepCircle}
                                    {!isLast && (
                                      <div className={`mt-1 w-0.5 flex-1 ${done ? "bg-primary" : "bg-border"}`} />
                                    )}
                                  </div>
                                  {/* Right: step body */}
                                  <div className="min-w-0 flex-1 pb-1">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="text-[11px] font-semibold text-foreground">
                                        Step {i + 1}: {s.label}
                                      </div>
                                      <div className="flex items-center gap-1.5">
                                        {def?.preProcessed && (
                                          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                                            Pre-computed
                                          </span>
                                        )}
                                        {def?.autoRunNext && (
                                          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700">
                                            Auto → next
                                          </span>
                                        )}
                                        {def?.rerunnable && !isStageRunning && (
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-6 gap-1 px-2 text-[10px]"
                                            onClick={() => runStage(selectedNode.id, i)}
                                            disabled={isRunning}
                                            title={done ? "Re-run this step" : "Run this step"}
                                          >
                                            <RotateCw className="h-3 w-3" />
                                            {done ? "Re-run" : "Run"}
                                          </Button>
                                        )}
                                      </div>
                                    </div>
                                    {def?.description && (
                                      <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                                        {def.description}
                                      </div>
                                    )}
                                    <div className="mt-1.5 flex items-center gap-2">
                                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                                        <div
                                          className={`h-full transition-all duration-200 ${done ? "bg-primary" : "bg-primary/70"}`}
                                          style={{ width: `${sPct}%` }}
                                        />
                                      </div>
                                      <span
                                        className={`w-16 flex-shrink-0 text-right text-[10px] tabular-nums ${done ? "text-primary font-medium" : "text-muted-foreground"}`}
                                      >
                                        {done ? "Processed" : (isStageRunning || sPct > 0) ? `${sPct}%` : "Pending"}
                                      </span>
                                    </div>
                                  </div>
                                </li>
                              )
                            })}
                          </ol>
                        </div>

                          {/* Bottom: model-specific settings (only NuClass currently has a rich panel) */}
                          <div className="p-3">
                          {panel ? (
                            isMuskClassification ? (
                              <PatchClassificationPanel
                                panel={panel}
                                onContentChange={handleLegacyPanelChange}
                              />
                            ) : (
                              <ClassificationPanelContent
                                panel={panel}
                                onContentChange={handleLegacyPanelChange}
                                terminology={isPatchClassifier ? "patch" : "cell"}
                                graphStartWorkflow={graphStartWorkflow}
                              />
                            )
                          ) : nucleiSegPanel ? (
                            <NucleiSegRegionAndMppPanel
                              panel={nucleiSegPanel}
                              onContentChange={handleLegacyPanelChange}
                              showRunControls={false}
                            />
                          ) : muskEmbeddingPanel ? (
                            <TissueSegEmbeddingFields
                              panel={muskEmbeddingPanel}
                              onContentChange={handleLegacyPanelChange}
                            />
                          ) : vistaPanel ? (
                            <WorkflowGraphCustomPanelFields
                              panel={vistaPanel}
                              onContentChange={handleLegacyPanelChange}
                            />
                          ) : (
                            <div className="space-y-3 text-sm">
                              <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                                Use the buttons above to run or re-run individual steps. Per-step settings will appear here.
                              </div>
                              <div className="space-y-1">
                                <UILabel htmlFor="wg-ms-label" className="text-xs">Label</UILabel>
                                <Input
                                  id="wg-ms-label"
                                  value={selectedNode.label ?? ""}
                                  onChange={(e) => updateNodeField(selectedNode.id, { label: e.target.value || undefined })}
                                  placeholder={_meta?.displayName || "Node label"}
                                />
                              </div>
                              <div className="space-y-1">
                                <UILabel htmlFor="wg-ms-desc" className="text-xs">Description</UILabel>
                                <Textarea
                                  id="wg-ms-desc"
                                  value={selectedNode.description ?? ""}
                                  onChange={(e) => updateNodeField(selectedNode.id, { description: e.target.value || undefined })}
                                  placeholder="Notes for this node"
                                  rows={3}
                                />
                              </div>
                            </div>
                          )}
                          </div>
                        </div>
                      </div>
                    )
                  }

                  // Coding Agent: only Generate/Run (CodePanelContent) — no outer Configuration / Annotation / AL tabs.
                  if (_factory === "CodingAgent") {
                    const codingPanel = ensureLegacyPanel(selectedNode)
                    if (codingPanel) {
                      return (
                        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-3 pt-1">
                          {(() => {
                            const runtimeStatus =
                              firstNumericRuntimeValue(
                                runtimeKeyCandidates(selectedNode.modelId).map((k) => graphNodeStatusMap[k])
                              ) ?? 0
                            const isNodeRunning = Number(runtimeStatus) === 1 || runningId === selectedNode.id
                            return (
                          <CodePanelContent
                            embedded
                            panel={codingPanel}
                            onContentChange={handleLegacyPanelChange}
                            onExecuteStateChange={(running) => {
                              setGraphCodingRunNodeId(running ? selectedNode.id : null)
                            }}
                            workflowNodeProgressPct={Math.max(0, Math.min(100, selectedNode.progress ?? 0))}
                            workflowNodeExecuting={isNodeRunning}
                            scriptChainInFlight={graphCodingRunNodeId === selectedNode.id}
                          />
                            )
                          })()}
                        </div>
                      )
                    }
                  }

                  return (
                  <Tabs value={configTab} onValueChange={(v) => setConfigTab(v as typeof configTab)} className="flex flex-1 flex-col overflow-hidden">
                    <TabsList className="mx-3 mt-2 grid h-9 grid-cols-3">
                      <TabsTrigger value="config">Configuration</TabsTrigger>
                      <TabsTrigger value="annotation">Annotation</TabsTrigger>
                      <TabsTrigger value="active-learning">Active Learning</TabsTrigger>
                    </TabsList>
                    <TabsContent value="config" className="flex-1 overflow-y-auto p-3">
                      {(() => {
                        const meta = selectedNode.modelId ? registryNodes[selectedNode.modelId] : undefined
                        const factory = meta?.factory
                        // Reuse the legacy Workflow panels for the cases that already have rich settings UI.
                        if (factory === "NucleiClassify") {
                          const panel = ensureLegacyPanel(selectedNode)
                          if (panel) {
                            return (
                              <ClassificationPanelContent
                                panel={panel}
                                onContentChange={handleLegacyPanelChange}
                                graphStartWorkflow={graphStartWorkflow}
                              />
                            )
                          }
                        }
                        return (
                          <div className="space-y-3">
                            <div className="space-y-1">
                              <UILabel htmlFor="wg-cfg-label" className="text-xs">Label</UILabel>
                              <Input
                                id="wg-cfg-label"
                                value={selectedNode.label ?? ""}
                                onChange={(e) =>
                                  updateNodeField(selectedNode.id, { label: e.target.value || undefined })
                                }
                                placeholder={meta?.displayName || "Node label"}
                              />
                            </div>
                            <div className="space-y-1">
                              <UILabel htmlFor="wg-cfg-desc" className="text-xs">Description</UILabel>
                              <Textarea
                                id="wg-cfg-desc"
                                value={selectedNode.description ?? ""}
                                onChange={(e) =>
                                  updateNodeField(selectedNode.id, { description: e.target.value || undefined })
                                }
                                placeholder="Notes for this node"
                                rows={3}
                              />
                            </div>
                            {meta?.factory && (
                              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                                Model:{" "}
                                <span className="font-medium text-foreground">
                                  {meta.displayName || selectedNode.modelId}
                                </span>{" "}
                                · Factory:{" "}
                                <span className="font-medium text-foreground">
                                  {registryCategoryNames[meta.factory] || meta.factory}
                                </span>
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </TabsContent>
                    <TabsContent value="annotation" className="flex-1 overflow-y-auto p-3">
                      <div className="space-y-3 text-sm">
                        <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                          Annotation for graph workflows is not available yet. Use the main viewer annotation tools or the Workflow tab where applicable.
                        </div>
                        <div className="space-y-1">
                          <UILabel htmlFor="wg-anno-classes" className="text-xs">Class names (comma-separated)</UILabel>
                          <Input id="wg-anno-classes" placeholder="tumor_cell, lymphocyte, stroma" />
                        </div>
                      </div>
                    </TabsContent>
                    <TabsContent value="active-learning" className="flex-1 overflow-y-auto p-3">
                      {(() => {
                        const meta = selectedNode.modelId ? registryNodes[selectedNode.modelId] : undefined
                        const stagePct = Math.max(0, Math.min(100, selectedNode.progress ?? 0))
                        const isStageRunning = runningId === selectedNode.id
                        return (
                          <div className="space-y-3">
                            {/* Per-stage Run button — runs just this node, not the whole workflow */}
                            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-foreground">Run this stage</div>
                                <div className="truncate text-[10px] text-muted-foreground">
                                  Trigger only <span className="font-medium text-foreground">{meta?.displayName || selectedNode.modelId}</span>, not the full workflow.
                                </div>
                              </div>
                              {isStageRunning ? (
                                <Button size="sm" variant="destructive" className="h-7 gap-1" onClick={stopWorkflow}>
                                  <Square className="h-3 w-3 fill-current" />
                                  Stop
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  className="h-7 gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
                                  onClick={() => runOneNode(selectedNode.id)}
                                  disabled={isRunning}
                                >
                                  <Play className="h-3 w-3 fill-current" />
                                  Run stage
                                </Button>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                                <div
                                  className={`h-full transition-all duration-200 ${stagePct >= 100 ? "bg-primary" : "bg-primary/70"}`}
                                  style={{ width: `${stagePct}%` }}
                                />
                              </div>
                              <span className="text-[10px] tabular-nums text-muted-foreground">{stagePct >= 100 ? "Processed" : `${stagePct}%`}</span>
                            </div>
                            <WorkflowGraphActiveLearning factory={meta?.factory} />
                          </div>
                        )
                      })()}
                    </TabsContent>
                  </Tabs>
                  )
                })()}
                {!selectedNode && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                    <Settings2 className="h-8 w-8 opacity-50" />
                    <div>Please first select a model card to proceed.</div>
                    <div className="text-xs text-muted-foreground/70">Click any model on the canvas, then double-click to open its configuration.</div>
                  </div>
                )}
              </>
            )}
            </div>
            </>
            )}
          </div>

          {/* Dock: pinned to the bottom of the sheet box — does not participate in flex height math */}
          <div
            ref={dockStripRef}
            className="absolute bottom-0 left-0 right-0 z-[60] flex h-10 items-stretch border-t border-border bg-card shadow-[0_-4px_12px_rgba(0,0,0,0.08)]"
          >
            <button
              type="button"
              onClick={() => togglePane("chat")}
              className={`flex flex-1 items-center justify-center gap-2 border-r border-border text-xs transition-colors ${
                bottomMode === "chat"
                  ? "bg-primary font-medium text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              }`}
            >
              <MessageSquareText className="h-3.5 w-3.5" />
              <span>Chat</span>
              {bottomMode === "chat" ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => togglePane("config")}
              className={`flex flex-1 items-center justify-center gap-2 text-xs transition-colors ${
                bottomMode === "config"
                  ? "bg-primary font-medium text-primary-foreground"
                  : !selectedNode
                    ? "text-muted-foreground/50 hover:bg-accent/40"
                    : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              }`}
              title={selectedNode ? "Open model configuration" : "Select a model node first"}
            >
              <Settings2 className="h-3.5 w-3.5" />
              <span>Model Configuration</span>
              {bottomMode === "config" ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
