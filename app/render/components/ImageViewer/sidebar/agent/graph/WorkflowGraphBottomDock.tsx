"use client"

import React from "react"
import Image from "next/image"
import {
  Boxes,
  Check,
  ChevronLeft,
  FolderOpen,
  Play,
  RotateCw,
  Save,
  Settings2,
  Square,
  TerminalSquare,
  UploadCloud,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label as UILabel } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type { GeneratedWorkflowStep } from "@/components/imageViewer/sidebar/agent/chat/Chatbox"
import { TissueSegEmbeddingFields } from "@/components/imageViewer/sidebar/agent/graph/TissueSegEmbeddingFields"
import { WorkflowGraphCustomPanelFields } from "@/components/imageViewer/sidebar/agent/graph/WorkflowGraphCustomPanelFields"
import WorkflowGraphActiveLearning from "@/components/imageViewer/sidebar/agent/workflow/WorkflowGraphActiveLearning"
import { ClassificationPanel } from "@/components/imageViewer/sidebar/agent/workflow/ClassificationPanel"
import { CodePanelContent } from "@/components/imageViewer/sidebar/agent/workflow/CodePanelContent"
import { NucleiSegRegionAndMppPanel } from "@/components/imageViewer/sidebar/agent/workflow/NucleiSegRegionAndMppPanel"
import { PatchClassificationPanel } from "@/components/imageViewer/sidebar/agent/workflow/PatchClassificationPanel"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import type { GraphNode } from "@/types/graph.types"
import {
  graphClassificationStageDone,
  graphClassifierTasknodePersistModelName,
} from "@/utils/agent/graph/classifierExport"
import {
  MODEL_SUBSTAGES,
  isTissueClassifyModelId,
  registryCategoryNames,
  registryNodes,
} from "@/utils/agent/graph/constants"

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
  /** All graph nodes — used to list every model when none is selected. */
  allNodes?: GraphNode[]
  /** Select a node (drives which config shows); null clears back to the list. */
  onSelectNode?: (id: string | null) => void
  runningId: string | null
  isRunning: boolean
  isStoppingWorkflow?: boolean
  stopWorkflow: () => void | Promise<void>
  runStage: (nodeId: string, stageIdx: number) => void | Promise<void>
  runOneNode: (nodeId: string) => void | Promise<void>
  /** Pipeline-tab "Run all": runs every substage, prepending the missing cell-seg +
   *  embedding step (CellCast for NuClass, Cytoformer for CytoformerClassification). */
  runAllSubstages: (nodeId: string) => void | Promise<void>
  writeDisabled?: boolean
  writeDisabledTitle?: string
  addModelNode?: (modelId: string, afterNodeId?: string) => void
  openNodeLogs: (nodeId: string) => void
  openClassifierSave: (nodeId: string) => void
  openClassifierLoad: (nodeId: string) => void
  openClassifierLoadForClass: (nodeId: string, className: string) => void
  publishToTissueLab: (nodeId: string) => void
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
    allNodes,
    onSelectNode,
    runningId,
    isRunning,
    isStoppingWorkflow = false,
    stopWorkflow,
    runStage,
    runOneNode,
    runAllSubstages,
    writeDisabled = false,
    writeDisabledTitle,
    addModelNode,
    openNodeLogs,
    openClassifierSave,
    openClassifierLoad,
    openClassifierLoadForClass,
    publishToTissueLab,
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
        className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border bg-card"
      >
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Model configuration is docked here permanently (chat lives in the top tab). */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="shrink-0 border-b border-border px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Model Configuration
              </div>
              <>
                {/* Header for the config pane */}
                <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {selectedNode ? (() => {
                      const meta = selectedNode.modelId ? registryNodes[selectedNode.modelId] : undefined
                      const heading = selectedNode.label || meta?.displayName || selectedNode.modelId || "Node"
                      return (
                        <>
                          <button
                            type="button"
                            onClick={() => onSelectNode?.(null)}
                            title="Back to all models"
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
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
                    //   • MUSK Classification (MuskClassification) — patches, with review panel
                    //   • VISTA (TissueSeg/VISTA)         — patches, no review panel
                    // Trainable patch classifiers share the MUSK class-panel + review UI.
                    // H-optimus-0 / Virchow mirror MUSK exactly.
                    const isPatchClassifier = isTissueClassifyModelId(selectedNode.modelId)
                    const isVistaPanel = selectedNode.modelId === "VISTA"
                    const hasCytoformerClf = allNodes?.some(
                      (node) => node.modelId === "CytoformerClassification",
                    )
                    const usesClassPanel =
                      _factory === "NucleiClassify" ||
                      isPatchClassifier ||
                      isVistaPanel  // VISTA reuses the patch class+color panel (shared tissue_classes/tissue_colors)
                    const panel = usesClassPanel ? ensureLegacyPanel(selectedNode) : null
                    const nucleiSegPanel =
                      _factory === "NucleiSeg" ? ensureLegacyPanel(selectedNode) : null
                    // Patch-embedding param panel: MUSK / H-optimus-0 / Virchow share it.
                    // TissueSeg also includes VISTA + radiology seg — those are not this form.
                    const muskEmbeddingPanel =
                      _factory === "TissueSeg" &&
                      selectedNode.modelId !== "VISTA" &&
                      !!MODEL_SUBSTAGES[selectedNode.modelId ?? ""]
                        ? ensureLegacyPanel(selectedNode)
                        : null
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
                    const canSaveGraphClassifier = Boolean(usesClassPanel && panel && tasknodeSaveModel)
                    const saveClassifierTitle = !tasknodeSaveModel
                      ? "Saving a classifier is only available for NuClass, Cytoformer, or MUSK nodes"
                      : classRunDone
                        ? "Save the trained classifier from this run to the sidebar folder (name required)"
                        : "Create a classifier file and run an update to train it (name required)"
                    return (
                      <div className="flex flex-1 flex-col overflow-hidden">
                        {/* NuClass / patch classifiers only - VISTA keeps its original TissueSeg-style panel. */}
                        {usesClassPanel && (
                        <div className="flex shrink-0 flex-col gap-1 border-b border-border bg-card/60 px-3 py-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <div className="text-[11px] font-medium text-muted-foreground">Classifier</div>
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
                              {selectedNode.loadedClassifier?.communityId && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 gap-1 text-xs text-primary"
                                  title="Publish this trained model back to its community classifier (contributes your training to the same cloud entry)"
                                  onClick={() => publishToTissueLab(selectedNode.id)}
                                >
                                  <UploadCloud className="h-3.5 w-3.5" />
                                  Publish
                                </Button>
                              )}
                            </div>
                          </div>
                          {selectedNode.loadedClassifier && (
                            <div
                              className="flex w-fit max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                              title={selectedNode.loadedClassifier.path || selectedNode.loadedClassifier.name}
                            >
                              {/* Show the on-disk basename — `loadedClassifier.name`
                                  is now also set to basename at load time so this
                                  matches the panel banner. */}
                              <span className="truncate">Loaded: {selectedNode.loadedClassifier.name}</span>
                              <button
                                type="button"
                                className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-primary/70 hover:bg-primary/20 hover:text-primary"
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
                              <Button
                                size="sm"
                                variant="destructive"
                                className="h-7 gap-1"
                                onClick={stopWorkflow}
                                disabled={isStoppingWorkflow}
                              >
                                <Square className="h-3 w-3 fill-current" />
                                {isStoppingWorkflow ? "Stopping..." : "Stop"}
                              </Button>
                            ) : (
                              <div className="flex items-center gap-1">
                                <Button
                                  size="sm"
                                  className="h-7 gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
                                  onClick={() => runAllSubstages(selectedNode.id)}
                                  disabled={isRunning || writeDisabled}
                                  title={writeDisabled ? writeDisabledTitle : "Run every pending step in order"}
                                >
                                  <Play className="h-3 w-3 fill-current" />
                                  Run all
                                </Button>
                              </div>
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
                                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold transition-colors ${
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
                                            disabled={isRunning || writeDisabled}
                                            title={writeDisabled ? writeDisabledTitle : (done ? "Re-run this step" : "Run this step")}
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
                                        className={`w-16 shrink-0 text-right text-[10px] tabular-nums ${done ? "text-primary font-medium" : "text-muted-foreground"}`}
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

                          {/* Bottom: model-specific settings */}
                          <div className="p-3">
                          {panel ? (
                            (isPatchClassifier || isVistaPanel) ? (
                              <PatchClassificationPanel
                                panel={panel}
                                onContentChange={handleLegacyPanelChange}
                                // VISTA reuses this panel for the shared class+color config and
                                // active learning. AL must retrain the patch classifier
                                // (MuskClassification) — NOT re-run VISTA's segmentation/feature
                                // extraction — so target the classifier node, like the MUSK panel.
                                modelId={isVistaPanel ? "MuskClassification" : selectedNode.modelId}
                                // On VISTA, Reset also clears the downstream Tissue-Segmentation.
                                clearTissueSegmentationOnReset={isVistaPanel}
                                graphStartWorkflow={graphStartWorkflow}
                                onClearLoadedClassifier={() => clearLoadedClassifier(selectedNode.id)}
                              />
                            ) : (
                              <ClassificationPanel
                                panel={panel}
                                onContentChange={handleLegacyPanelChange}
                                terminology={isPatchClassifier ? "patch" : "cell"}
                                graphStartWorkflow={graphStartWorkflow}
                                classifierMode={selectedNode.classifierMode}
                                onOvrLoadClass={(className) => openClassifierLoadForClass(selectedNode.id, className)}
                                onClearLoadedClassifier={() => clearLoadedClassifier(selectedNode.id)}
                              />
                            )
                          ) : nucleiSegPanel ? (
                            <div className="space-y-3">
                              <NucleiSegRegionAndMppPanel
                                panel={nucleiSegPanel}
                                onContentChange={handleLegacyPanelChange}
                                showRunControls={false}
                              />
                              {selectedNode.modelId === "Cytoformer" && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="h-8 w-full text-xs"
                                  onClick={() =>
                                    addModelNode?.("CytoformerClassification", selectedNode.id)
                                  }
                                  disabled={!addModelNode || hasCytoformerClf}
                                >
                                  {hasCytoformerClf
                                    ? "Cytoformer classification already added"
                                    : "Add Cytoformer classification"}
                                </Button>
                              )}
                            </div>
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
                              <ClassificationPanel
                                panel={panel}
                                onContentChange={handleLegacyPanelChange}
                                graphStartWorkflow={graphStartWorkflow}
                                classifierMode={selectedNode.classifierMode}
                                onOvrLoadClass={(className) => openClassifierLoadForClass(selectedNode.id, className)}
                                onClearLoadedClassifier={() => clearLoadedClassifier(selectedNode.id)}
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
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  className="h-7 gap-1"
                                  onClick={stopWorkflow}
                                  disabled={isStoppingWorkflow}
                                >
                                  <Square className="h-3 w-3 fill-current" />
                                  {isStoppingWorkflow ? "Stopping..." : "Stop"}
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  className="h-7 gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
                                  onClick={() => runOneNode(selectedNode.id)}
                                  disabled={isRunning || writeDisabled}
                                  title={writeDisabled ? writeDisabledTitle : undefined}
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
                            <WorkflowGraphActiveLearning
                              factory={meta?.factory}
                              modelId={selectedNode.modelId}
                            />
                          </div>
                        )
                      })()}
                    </TabsContent>
                  </Tabs>
                  )
                })()}
                {!selectedNode && (() => {
                  const models = (allNodes ?? []).filter((n) => n.kind === "model")
                  if (models.length === 0) {
                    return (
                      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                        <Settings2 className="h-8 w-8 opacity-50" />
                        <div>No models yet.</div>
                        <div className="text-xs text-muted-foreground/70">Add a node (or expand the graph) to configure it.</div>
                      </div>
                    )
                  }
                  return (
                    <div className="flex-1 overflow-y-auto p-3">
                      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        Models — select one to configure
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {models.map((n) => {
                          const meta = n.modelId ? registryNodes[n.modelId] : undefined
                          const name = n.label || meta?.displayName || n.modelId || "Node"
                          const factory = meta?.factory ? registryCategoryNames[meta.factory] || meta.factory : null
                          return (
                            <button
                              key={n.id}
                              type="button"
                              onClick={() => onSelectNode?.(n.id)}
                              className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:border-primary/60 hover:bg-accent/30"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-foreground">{name}</span>
                                {factory && <span className="block truncate text-[10px] text-muted-foreground">{factory}</span>}
                              </span>
                              <Settings2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
              </>
        </div>
      </div>
    </div>
  </div>
    </>
  )
}
