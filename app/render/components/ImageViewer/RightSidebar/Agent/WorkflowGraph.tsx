"use client"

import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ImportModelDialog } from "@/components/imageViewer/RightSidebar/Agent/ImportModelDialog"
import type { GeneratedWorkflowStep } from "@/components/imageViewer/RightSidebar/Agent/Chatbox"
import {
  getContentStringValue,
  removeClassifierPathContent,
  upsertContentStringValue,
} from "@/components/imageViewer/RightSidebar/Agent/Workflow/constants"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { AlertTriangle, FolderOpen, Info, LayoutGrid, PlayCircle, Plus, Save, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { type CommunityWorkflow } from "@/constants/communityWorkflowsDefault"
import { useCommunityWorkflowsPresets } from "@/hooks/workflow/useCommunityWorkflowsPresets"
import { classifiersService } from "@/services/classifiers.service"
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config"
import EventBus from "@/utils/EventBus"
import { formatPath } from "@/utils/pathUtils"
import { sanitizeFilename } from "@/utils/string.utils"
import { saveClassifierViaTasknode } from "@/utils/classifierFileApi"
import {
  graphClassificationStageDone,
  graphClassifierTasknodePersistModelName,
  normalizePathForSegClassifierApi,
} from "@/utils/workflowGraph/graphClassifierExport"
import { useWorkflowRuntimeStatus } from "@/hooks/workflow/useWorkflowRuntimeStatus"
import { apiFetch } from "@/utils/common/apiFetch"
import { getZarrStructure } from "@/services/data.service"
import { Progress } from "@/components/ui/progress"
import { useDispatch, useSelector } from "react-redux"
import { AppDispatch, RootState } from "@/store"
import { addMessage, setIsGenerating, setMessages, type ChatMessage } from "@/store/slices/chat/chatSlice"
import useRootStore from "@/store/zustand/store"
import { selectPatchClassificationData } from "@/store/slices/viewer/annotationSlice"
import { resetWorkflowStatus, setWorkflowCompletionHints } from "@/store/slices/chat/workflowSlice"
import {
  buildStartWorkflowPayload,
  type BuildWorkflowPayloadContext,
} from "@/utils/workflow/buildStartWorkflowPayload"
import {
  buildTaskDependenciesFromTopo,
  disconnectedModelNodeIds,
  modelNodeIdsOutsideStartEndPath,
  topoSortModelNodesForRun,
} from "@/utils/workflow/graphWorkflowTopo"
import { getRestrictedDirectoryMessage, isPublicReadOnlyPath } from "@/utils/sampleDirectoryUtils"
import { resetWorkflowBeforeStart } from "@/utils/workflowUtils"
import {
  digestScriptSource,
  getCodingAgentCardBadge,
  getScriptRunPolicy,
  mergePanelContentWithFactoryDefaults,
  SCRIPT_LAST_RUN_DIGEST_KEY,
  SCRIPT_LAST_RUN_OUTPUT_KEY,
  SCRIPT_LAST_RUN_RAW_OUTPUT_KEY,
} from "@/utils/workflow/codingAgentPolicy"
import {
  loadCodingAgentGeneratedScript,
  persistCodingAgentGeneratedScript,
} from "@/utils/workflow/persistCodingAgentScript"
import { runCodingAgentScriptChain } from "@/utils/workflow/runCodingAgentScriptChain"
import { WORKFLOW_CODING_SCRIPT_READY_EVENT } from "@/utils/workflow/workflowCompletionSideEffects"
import {
  isSerializedWorkflow,
  loadAllSavedWorkflows as loadAllSaved,
  readWorkflowGraphSessionDraft,
  writeWorkflowGraphSessionDraft,
  writeAllSavedWorkflows as writeAllSaved,
  notifyWorkflowLocalStorageChanged,
  type SerializedWorkflow,
  type WorkflowGraphSessionDraftV1,
  WORKFLOW_GRAPH_SAVED_STORAGE_KEY,
  WORKFLOW_LOCAL_STORAGE_CHANGED_EVENT,
} from "@/utils/workflow/serializedWorkflow"

import { WorkflowGraphBottomDock } from "@/utils/workflowGraph/WorkflowGraphBottomDock"
import { WorkflowBatchDialog } from "@/utils/workflowGraph/WorkflowBatchDialog"
import { WorkflowGraphCanvas } from "@/utils/workflowGraph/WorkflowGraphCanvas"
import { WorkflowGraphDialogs } from "@/utils/workflowGraph/WorkflowGraphDialogs"
import { isWSI } from "@/utils/dashboard/fileTypeUtils"
import { isCodingAgentGenerationFailureAnswer, looksLikeCodingAgentGeneratedScript } from "@/utils/workflowGraph/codingAgentGuards"
import {
  folderClassifierOptionsFromFileList,
  loadAllClassifiers,
  remoteClassifierToOption,
  writeAllClassifiers,
} from "@/utils/workflowGraph/classifiers"
import {
  COMMUNITY_CLASSIFIERS_FALLBACK,
  CODING_GRAPH_MODEL_ID,
  END_NODE_ID,
  MODEL_SUBSTAGES,
  NODE_H,
  NODE_H_CODING,
  NODE_W,
  registryNodes,
  START_NODE_ID,
  TERMINAL_SIZE,
} from "@/utils/workflowGraph/constants"
import { workflowGraphPayloadBounds } from "@/utils/workflowGraph/bboxFromShape"
import {
  computeWorkflowContentBounds,
  computeWorkflowYScale,
  getWorkflowGraphPortPosition,
  screenPointToLogicalCanvas,
} from "@/utils/workflowGraph/canvasGeometry"
import { buildGeneratedWorkflowChainLayout } from "@/utils/workflowGraph/generatedChainLayout"
import { collectPanelStatesSnapshot } from "@/utils/workflowGraph/generatedPanel"
import {
  createInitialSubStages,
  getInitialModelProgress,
  initialNodes,
  newWorkflow,
  nodeHeight,
  nodeWidth,
  normalizeWorkflowGraphNodes,
  sseOverallToSegEmbBars,
} from "@/utils/workflowGraph/graphNode"
import {
  buildLegacyPanelFromNode,
  mergeGraphPanelClassifierPathsFromRedux,
  resolveLegacyPanelForNode,
} from "@/utils/workflowGraph/legacyPanelFromNode"
import { expandRuntimeStatusNodeKeys } from "@/utils/workflowGraph/registryRuntime"
import { firstNumericRuntimeValue, normalizeWorkflowRuntimeMap } from "@/utils/workflowGraph/runtimeUtils"
import {
  clearWorkflowBatchHistory,
  createWorkflowBatchHistoryEntry,
  loadWorkflowBatchHistory,
  saveWorkflowBatchHistory,
  summarizeWorkflowBatchEntry,
  upsertWorkflowBatchHistoryEntry,
  type WorkflowBatchFile,
  type WorkflowBatchHistoryEntry,
  type WorkflowBatchHistoryItem,
  type WorkflowBatchSourceMode,
  workflowBatchBasename,
} from "@/utils/workflowGraph/workflowBatchHistory"
import type {
  ClassifierSource,
  CommunityClassifierOption,
  GraphConnection,
  GraphNode,
  PortSide,
  SubStage,
  Workflow,
} from "@/utils/workflowGraph/types"

type BottomMode = "none" | "chat" | "config"
const FORCE_OVERRIDE_CANCELLED = "__workflow_force_override_cancelled__"

/** Saved `subStages` often stays at 100% from a prior run; runtime merge must start from the template at 0. */
const RUNTIME_SUBSTAGE_FROM_TEMPLATE_IDS = new Set([
  "ClassificationNode",
  "PatchClassifier",
  "MuskClassification",
])

const isCellSegPipelineModelId = (modelId?: string) =>
  modelId === "SegmentationNode" || modelId === "InstanSegNode" || modelId === "NucSegNode"

const clampProgress = (value: unknown) =>
  Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Number(value) : 0))

function directModelPredecessors(
  nodeId: string,
  conns: GraphConnection[],
  graphNodes: GraphNode[]
): GraphNode[] {
  const fromIds = conns.filter((c) => c.toId === nodeId).map((c) => c.fromId)
  const byId = new Map(graphNodes.map((n) => [n.id, n]))
  return fromIds
    .map((id) => byId.get(id))
    .filter((n): n is GraphNode => Boolean(n && n.kind === "model" && n.modelId))
}

const zeroRuntimeTemplateSubStagesForNodes = (graphNodes: GraphNode[]) => {
  const next: Record<string, SubStage[]> = {}
  for (const node of graphNodes) {
    if (node.kind !== "model" || !node.modelId) continue
    if (!RUNTIME_SUBSTAGE_FROM_TEMPLATE_IDS.has(node.modelId)) continue
    const stages = createInitialSubStages(node.modelId)
    if (stages?.length) next[node.id] = stages.map((stage) => ({ ...stage, progress: 0 }))
  }
  return next
}

const isWorkflowActiveConflictMessage = (message: string) => {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("already has a workflow") ||
    normalized.includes("workflow running") ||
    normalized.includes("running, queued, or cancelling") ||
    normalized.includes("running or queued")
  )
}

export const WorkflowGraph: React.FC = () => {
  const canvasRef = useRef<HTMLDivElement>(null)

  // ─── Multi-workflow state ───
  const [workflows, setWorkflows] = useState<Workflow[]>(() => [newWorkflow("Workflow 1")])
  const [activeWfId, setActiveWfId] = useState<string>(() => workflows[0].id)
  const activeWfIdRef = useRef(activeWfId)
  useEffect(() => {
    activeWfIdRef.current = activeWfId
  }, [activeWfId])
  const [renamingWfId, setRenamingWfId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")

  const activeWf = workflows.find((w) => w.id === activeWfId) ?? workflows[0]
  const nodes = activeWf.nodes
  const connections = activeWf.connections
  const selectedId = activeWf.selectedId

  // Stable setters that mutate only the active workflow
  const updateActiveWf = useCallback((updater: (wf: Workflow) => Workflow) => {
    setWorkflows((wfs) => wfs.map((w) => (w.id === activeWfIdRef.current ? updater(w) : w)))
  }, [])
  const setNodes = useCallback(
    (updater: GraphNode[] | ((prev: GraphNode[]) => GraphNode[])) => {
      updateActiveWf((w) => ({ ...w, nodes: typeof updater === "function" ? (updater as any)(w.nodes) : updater }))
    },
    [updateActiveWf]
  )
  const setConnections = useCallback(
    (updater: GraphConnection[] | ((prev: GraphConnection[]) => GraphConnection[])) => {
      updateActiveWf((w) => ({
        ...w,
        connections: typeof updater === "function" ? (updater as any)(w.connections) : updater,
      }))
    },
    [updateActiveWf]
  )
  const setSelectedId = useCallback(
    (updater: string | null | ((prev: string | null) => string | null)) => {
      updateActiveWf((w) => ({
        ...w,
        selectedId: typeof updater === "function" ? (updater as any)(w.selectedId) : updater,
      }))
    },
    [updateActiveWf]
  )

  // ─── Workflow tab actions ───
  const createWorkflow = useCallback(() => {
    const name = `Workflow ${workflows.length + 1}`
    const wf = newWorkflow(name)
    setWorkflows((wfs) => [...wfs, wf])
    setActiveWfId(wf.id)
    setBottomMode("chat")
    setIntentPromptOpen(false)
    setIntentText("")
  }, [workflows.length])

  const closeWorkflow = useCallback(
    (id: string) => {
      setWorkflows((wfs) => {
        if (wfs.length <= 1) return wfs
        const remaining = wfs.filter((w) => w.id !== id)
        if (id === activeWfIdRef.current) {
          setActiveWfId(remaining[0].id)
        }
        return remaining
      })
    },
    []
  )

  const startRenameWorkflow = useCallback((wf: Workflow) => {
    setRenamingWfId(wf.id)
    setRenameValue(wf.name)
  }, [])

  const finishRenameWorkflow = useCallback(() => {
    const id = renamingWfId
    const next = renameValue.trim()
    if (id && next) {
      setWorkflows((wfs) => wfs.map((w) => (w.id === id ? { ...w, name: next } : w)))
    }
    setRenamingWfId(null)
  }, [renamingWfId, renameValue])

  // ─── Bottom panel state (mutually exclusive; strip always visible) ───
  const [bottomMode, setBottomMode] = useState<BottomMode>("chat")
  // Per-node panel state for the legacy Workflow panels (Nuclei Classification, Code Calculation, …)
  const [panelStates, setPanelStates] = useState<Record<string, WorkflowPanel>>({})
  const [graphCodingRunNodeId, setGraphCodingRunNodeId] = useState<string | null>(null)
  const autoBypassAttemptedRef = useRef<Set<string>>(new Set())
  const lastAppliedScriptRef = useRef<string | null>(null)
  /** True only after Run workflow produced a final Coding script (get_answer "done"); cleared on workflow-graph-run-start. */
  const codingGenReadyForAutoBypassRef = useRef(false)

  const dispatch = useDispatch<AppDispatch>()
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath)
  const selectedFolder = useSelector((state: RootState) => state.fileManager.selectedFolder)
  const fileList = useSelector((state: RootState) => state.fileManager.fileList)
  const activeInstanceId = useSelector((state: RootState) => state.wsi.activeInstanceId)
  const selectedAgent = useSelector((state: RootState) => state.agent.selectedAgent)
  const nucleiClasses = useSelector((state: RootState) => state.annotations.nucleiClasses)
  const currentOrgan = useSelector((state: RootState) => state.workflow.currentOrgan)
  const reduxPatchClassificationData = useSelector(selectPatchClassificationData)
  const shapeData = useSelector((state: RootState) => state.shape.shapeData)
  const rectangleCoords = useSelector((state: RootState) => state.shape.shapeData?.rectangleCoords)
  const slideDimensions = useSelector((state: RootState) => state.svsPath.slideInfo.dimensions)
  const workflowStatus = useSelector((state: RootState) => state.workflow.workflowStatus)
  const queuePosition = useSelector((state: RootState) => state.workflow.queuePosition)
  const queueTotal = useSelector((state: RootState) => state.workflow.queueTotal)
  const runningWorkflowZarrPath = useSelector((state: RootState) => state.workflow.runningWorkflowZarrPath)
  const nodeLogsMeta = useSelector((state: RootState) => state.workflow.nodeLogsMeta)
  const chatMessages = useSelector((state: RootState) => state.chat.messages)
  const reduxWorkflowPanels = useSelector((state: RootState) => state.workflow.panels)

  const classifierListingFolder = useMemo(() => {
    let folder = (selectedFolder ?? "").trim()
    if (!folder && currentPath) {
      const norm = formatPath(currentPath)
      const sep = norm.includes("\\") ? "\\" : "/"
      const idx = norm.lastIndexOf(sep)
      folder = idx > 0 ? norm.slice(0, idx) : norm
    }
    return folder
  }, [selectedFolder, currentPath])

  const folderClassifierOptions = useMemo(
    () => folderClassifierOptionsFromFileList(fileList, classifierListingFolder),
    [fileList, classifierListingFolder]
  )

  const batchCandidateFiles = useMemo<WorkflowBatchFile[]>(() => {
    const candidates = fileList
      .filter((file) => !file.is_dir && isWSI(file.name))
      .map((file) => ({ name: file.name, path: formatPath(file.path) }))
    if (candidates.length > 0) return candidates
    const formatted = formatPath(currentPath ?? "")
    return formatted ? [{ name: workflowBatchBasename(formatted), path: formatted }] : []
  }, [currentPath, fileList])

  useEffect(() => {
    const entries = loadWorkflowBatchHistory()
    setBatchHistoryEntries(entries)
  }, [])

  const bboxBounds = useMemo(
    () => workflowGraphPayloadBounds(rectangleCoords, slideDimensions ?? undefined),
    [rectangleCoords, slideDimensions]
  )

  const {
    isRunning,
    nodeStatus,
    nodeProgress,
    startWorkflow,
    stopWorkflow: stopWorkflowRequest,
    waitForWorkflowCompleteSignal,
  } = useWorkflowRuntimeStatus()
  const deferredNodeStatus = useDeferredValue(nodeStatus)

  // ─── Run state (visual highlight on top of runtime status) ───
  const [runningId, setRunningId] = useState<string | null>(null)
  const runningIdRef = useRef<string | null>(null)
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())
  const [runtimeNodeProgressById, setRuntimeNodeProgressById] = useState<Record<string, number>>({})
  // CodingAgent (GPT-4o Agent) emits no real progress while OpenAI generates
  // the script. Fake a 0→90% ramp per running CodingAgent node so the canvas
  // tile actually animates; the existing status === 2 branch jumps to 100%.
  const [fakeCodingProgressById, setFakeCodingProgressById] = useState<Record<string, number>>({})
  const [runtimeNodeSubStagesById, setRuntimeNodeSubStagesById] = useState<Record<string, SubStage[]>>({})
  const runtimeNodeSubStagesByIdRef = useRef<Record<string, SubStage[]>>({})
  useEffect(() => {
    runtimeNodeSubStagesByIdRef.current = runtimeNodeSubStagesById
  }, [runtimeNodeSubStagesById])
  const runAbortRef = useRef(false)
  const batchAbortRef = useRef(false)
  const currentBatchZarrPathRef = useRef<string | null>(null)
  const activeBatchEntryRef = useRef<WorkflowBatchHistoryEntry | null>(null)
  const [batchDialogOpen, setBatchDialogOpen] = useState(false)
  const [isBatchRunning, setIsBatchRunning] = useState(false)
  const [isStoppingWorkflow, setIsStoppingWorkflow] = useState(false)
  const forceOverrideResolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  const [forceOverrideDialog, setForceOverrideDialog] = useState<{ message: string } | null>(null)
  const [batchHistoryEntries, setBatchHistoryEntries] = useState<WorkflowBatchHistoryEntry[]>([])
  const [activeBatchEntry, setActiveBatchEntry] = useState<WorkflowBatchHistoryEntry | null>(null)
  /** When true, the top batch progress strip is hidden until the next batch starts or history is cleared. */
  const [batchBannerDismissed, setBatchBannerDismissed] = useState(false)
  /** Last node id that had runtime status "running" (1) — only auto-select when this changes, so users can open other nodes' config during a long run. */
  const prevWorkflowRunnerNodeIdRef = useRef<string | null>(null)
  const prevRuntimeActiveRef = useRef(false)
  const classificationNodesRef = useRef<Array<{ id: string; subStages: SubStage[] }>>([])
  const classificationNodeIdsKeyRef = useRef("")
  const setRuntimeRunningId = useCallback((nextRunningId: string | null) => {
    if (runningIdRef.current === nextRunningId) return
    runningIdRef.current = nextRunningId
    setRunningId(nextRunningId)
  }, [])
  const resetAllGraphProgress = useCallback(() => {
    const zeroSubStages = zeroRuntimeTemplateSubStagesForNodes(activeWf.nodes)
    setRuntimeNodeProgressById({})
    runtimeNodeSubStagesByIdRef.current = zeroSubStages
    setRuntimeNodeSubStagesById(zeroSubStages)
    setCompletedIds(new Set())
    setRuntimeRunningId(null)
  }, [activeWf.nodes, setRuntimeRunningId])
  const runtimeKeyCandidates = useCallback((modelId?: string) => {
    if (!modelId) return [] as string[]
    return expandRuntimeStatusNodeKeys(modelId)
  }, [])

  const graphNodeStatusMap = useMemo(
    () => normalizeWorkflowRuntimeMap(deferredNodeStatus, "node_status"),
    [deferredNodeStatus]
  )

  /** Sub-stage bars (segmentation / embedding / …) from SSE — same payload as workflow_stage_status. */
  const workflowStageProgress = useSelector((s: RootState) => s.workflow.workflowStageProgress)

  const getWorkflowZarrPath = useCallback(() => {
    const formatted = formatPath(currentPath ?? "")
    return formatted ? `${formatted}.zarr` : ""
  }, [currentPath])

  useEffect(() => {
    const clsNodes = activeWf.nodes
      .filter((n): n is GraphNode & { modelId: string } => n.kind === "model" && n.modelId === "ClassificationNode")
      .map((n) => ({ id: n.id, subStages: (n.subStages ?? []).map((s) => ({ ...s })) }))
    classificationNodesRef.current = clsNodes
    classificationNodeIdsKeyRef.current = clsNodes.map((n) => n.id).sort().join("|")
  }, [activeWf.nodes])

  const refreshClassificationPrereqFromZarr = useCallback(async () => {
    if (isRunning || workflowStatus !== "idle") return
    const zarrPath = getWorkflowZarrPath()
    if (!zarrPath) return
    if (!classificationNodeIdsKeyRef.current) return
    try {
      const structure = await getZarrStructure(zarrPath, "/", false, -1)
      const paths: string[] = []
      const walk = (obj: any, parentPath = "") => {
        if (!obj || typeof obj !== "object") return
        const children = Array.isArray(obj.children) ? obj.children : []
        for (const child of children) {
          const name = typeof child?.name === "string" ? child.name : ""
          const fullPath =
            typeof child?.full_path === "string"
              ? child.full_path
              : parentPath
                ? `${parentPath}/${name}`
                : name
          if (fullPath) paths.push(fullPath.toLowerCase())
          walk(child, fullPath)
        }
      }
      walk((structure as any)?.root, "")
      const hasSegContours = paths.some(
        (p) => p.includes("/segmentationnode/") && (p.endsWith("/contours") || p.includes("/contours/"))
      )
      const hasSegEmbedding = paths.some(
        (p) => p.includes("/segmentationnode/") && (p.endsWith("/embedding") || p.includes("/embedding/"))
      )
      setRuntimeNodeSubStagesById((prev) => {
        let changed = false
        const next = { ...prev }
        for (const node of classificationNodesRef.current) {
          if (!node.subStages || node.subStages.length < 2) continue
          const base = next[node.id] ?? createInitialSubStages("ClassificationNode") ?? node.subStages
          const patched = base.map((s, idx) => {
            if (idx === 0) return { ...s, progress: hasSegContours ? 100 : 0 }
            if (idx === 1) return { ...s, progress: hasSegEmbedding ? 100 : 0 }
            return s
          })
          const same =
            patched.length === base.length &&
            patched.every((s, idx) => s.key === base[idx]?.key && s.label === base[idx]?.label && s.progress === base[idx]?.progress)
          if (!same) {
            next[node.id] = patched
            changed = true
          }
        }
        return changed ? next : prev
      })
    } catch {
      // best effort: keep current stage bars when zarr structure is unavailable
    }
  }, [getWorkflowZarrPath, isRunning, workflowStatus])

  const persistBatchEntry = useCallback((entry: WorkflowBatchHistoryEntry) => {
    const summarized = summarizeWorkflowBatchEntry(entry)
    activeBatchEntryRef.current = summarized
    setActiveBatchEntry(summarized)
    setBatchHistoryEntries((prev) => {
      const next = upsertWorkflowBatchHistoryEntry(prev, summarized)
      saveWorkflowBatchHistory(next)
      return next
    })
    return summarized
  }, [])

  const requestWorkflowForceOverride = useCallback((message: string) => {
    return new Promise<boolean>((resolve) => {
      forceOverrideResolverRef.current?.(false)
      forceOverrideResolverRef.current = resolve
      setForceOverrideDialog({ message })
    })
  }, [])

  const settleWorkflowForceOverride = useCallback((confirmed: boolean) => {
    const resolve = forceOverrideResolverRef.current
    forceOverrideResolverRef.current = null
    setForceOverrideDialog(null)
    resolve?.(confirmed)
  }, [])

  const startWorkflowAllowingForceOverride = useCallback(
    async (payload: Record<string, any>) => {
      try {
        return await startWorkflow(payload)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start workflow."
        if (!isWorkflowActiveConflictMessage(message)) {
          throw error
        }
        const confirmed = await requestWorkflowForceOverride(message)
        if (!confirmed) {
          throw new Error(FORCE_OVERRIDE_CANCELLED)
        }
        return await startWorkflow({ ...payload, force_override: true })
      }
    },
    [requestWorkflowForceOverride, startWorkflow]
  )

  const stopWorkflow = useCallback(async () => {
    if (isStoppingWorkflow) return
    setIsStoppingWorkflow(true)
    if (isBatchRunning) {
      batchAbortRef.current = true
    }
    const zarrPath = (isBatchRunning ? currentBatchZarrPathRef.current : null) || runningWorkflowZarrPath || getWorkflowZarrPath()
    if (!zarrPath) {
      if (isBatchRunning) {
        setIsBatchRunning(false)
        const entry = activeBatchEntryRef.current
        if (entry) {
          persistBatchEntry({
            ...entry,
            finishedAt: Date.now(),
            aggregateStatus: "aborted_by_user",
            progress: { ...entry.progress, currentPath: null },
          })
        }
      }
      return
    }
    runAbortRef.current = true
    try {
      await stopWorkflowRequest(zarrPath)
      setRuntimeRunningId(null)
      toast.message(isBatchRunning ? "Batch stopped" : "Workflow stopped")
      if (isBatchRunning) {
        setIsBatchRunning(false)
        const entry = activeBatchEntryRef.current
        if (entry) {
          persistBatchEntry({
            ...entry,
            finishedAt: Date.now(),
            aggregateStatus: "aborted_by_user",
            progress: { ...entry.progress, currentPath: null },
          })
        }
      }
    } catch {
      toast.error("Failed to stop workflow.")
    } finally {
      setIsStoppingWorkflow(false)
    }
  }, [getWorkflowZarrPath, isBatchRunning, isStoppingWorkflow, persistBatchEntry, runningWorkflowZarrPath, setRuntimeRunningId, stopWorkflowRequest])

  // Controlled tab state for the model-config pane (so the AL button can jump straight to it)
  const [configTab, setConfigTab] = useState<"config" | "annotation" | "active-learning">("config")

  const ensureLegacyPanel = useCallback(
    (node: GraphNode): WorkflowPanel | null => {
      const base = resolveLegacyPanelForNode(node, panelStates)
      return mergeGraphPanelClassifierPathsFromRedux(node, base, reduxWorkflowPanels, activeWf.nodes)
    },
    [panelStates, reduxWorkflowPanels, activeWf.nodes]
  )
  const handleLegacyPanelChange = useCallback((panelId: string, updated: WorkflowPanel) => {
    setPanelStates((prev) => ({ ...prev, [panelId]: updated }))
  }, [])

  useEffect(() => {
    const onRunStart = () => {
      codingGenReadyForAutoBypassRef.current = false
      lastAppliedScriptRef.current = null
    }
    EventBus.on("workflow-graph-run-start", onRunStart)
    return () => {
      EventBus.off("workflow-graph-run-start", onRunStart)
    }
  }, [])

  useEffect(() => {
    if (isRunning) return
    const zarrPath = getWorkflowZarrPath()
    if (!zarrPath) return
    const agentId = "default_agent"
    const apiVersion = "v1"

    for (const node of activeWf.nodes) {
      if (node.kind !== "model" || node.modelId !== "GPT-4o Agent") continue
      const panel = panelStates[node.id]
      if (!panel) continue
      const merged = mergePanelContentWithFactoryDefaults(panel.content, "CodingAgent")
      if (getScriptRunPolicy(merged) !== "auto_bypass") continue
      const scriptItem = merged.find((c: { key?: string }) => c.key === "generated_script")
      const script = typeof scriptItem?.value === "string" ? scriptItem.value : ""
      if (!script.trim()) continue
      // Auto-bypass must not POST junk (e.g. JSON / prose from a bad import) — same bar as streaming "final" merge.
      if (!looksLikeCodingAgentGeneratedScript(script)) continue
      if (!codingGenReadyForAutoBypassRef.current) continue
      const digest = digestScriptSource(script)
      const ran = merged.find((c: { key?: string }) => c.key === SCRIPT_LAST_RUN_DIGEST_KEY)?.value as string | undefined
      if (ran === digest) continue
      const attemptKey = `${node.id}:${digest}`
      if (autoBypassAttemptedRef.current.has(attemptKey)) continue
      // Skip arming auto-bypass on read-only paths (avoid ref churn / effect noise).
      if (isPublicReadOnlyPath(currentPath ?? "")) continue
      autoBypassAttemptedRef.current.add(attemptKey)
      codingGenReadyForAutoBypassRef.current = false

      const pe = merged.find((c: { key?: string }) => c.key === "prompt")
      const promptVal = typeof pe?.value === "string" ? pe.value : ""
      void (async () => {
        setGraphCodingRunNodeId(node.id)
        try {
          // Auto-bypass: expand the Agentic AI page's own bottom chat dock
          // (not any external sidebar) so the user sees the "..." loading
          // indicator + final summary in place. setIsGenerating drives the
          // Chatbox polling loop that posts the summary once it arrives.
          dispatch(setIsGenerating(true))
          setBottomMode("chat")
          const res = await runCodingAgentScriptChain({
            code: script,
            zarrPath,
            userPrompt: promptVal,
            agentId,
            apiVersion,
            dispatch,
          })
          if (res.ok && res.chatBody != null && res.rawOutput != null) {
            let nextContent = upsertContentStringValue(merged, SCRIPT_LAST_RUN_DIGEST_KEY, digest)
            nextContent = upsertContentStringValue(nextContent, SCRIPT_LAST_RUN_RAW_OUTPUT_KEY, res.rawOutput.trim())
            nextContent = upsertContentStringValue(nextContent, SCRIPT_LAST_RUN_OUTPUT_KEY, res.chatBody.trim())
            handleLegacyPanelChange(node.id, { ...panel, content: nextContent })
            setBottomMode("chat")
            // NOTE: runCodingAgentScriptChain already dispatches addMessage()
            // with the summary chatBody (see runCodingAgentScriptChain.ts:190).
            // Do not duplicate it here.
          } else if (!res.ok) {
            const errText = `[${res.stage}:${res.statusCode}] ${res.error || "Run failed."}`
            let nextContent = upsertContentStringValue(merged, SCRIPT_LAST_RUN_RAW_OUTPUT_KEY, res.rawOutput?.trim() || "")
            nextContent = upsertContentStringValue(nextContent, SCRIPT_LAST_RUN_OUTPUT_KEY, errText)
            handleLegacyPanelChange(node.id, { ...panel, content: nextContent })
          }
          // On failure: keep attemptKey so this effect (re-runs on panelStates etc.) does not
          // immediately retry the same digest → infinite execute_script / get_answer spam.
          // User edits the script → new digest → new attemptKey → one retry allowed.
        } catch {
          /* ignore */
        } finally {
          setGraphCodingRunNodeId(null)
        }
      })()
    }
  }, [
    isRunning,
    panelStates,
    activeWf.nodes,
    getWorkflowZarrPath,
    selectedAgent,
    dispatch,
    handleLegacyPanelChange,
    currentPath,
    activeWf,
    setBottomMode,
  ])

  useEffect(() => {
    void refreshClassificationPrereqFromZarr()
  }, [refreshClassificationPrereqFromZarr])

  useEffect(() => {
    const onRunFinished = () => {
      void refreshClassificationPrereqFromZarr()
    }
    const onRunStart = () => {
      setRuntimeNodeSubStagesById((prev) => {
        let changed = false
        const next = { ...prev }
        for (const node of classificationNodesRef.current) {
          if (!node.subStages || node.subStages.length < 2) continue
          const base = next[node.id] ?? createInitialSubStages("ClassificationNode") ?? node.subStages
          const patched = base.map((s) => ({ ...s, progress: 0 }))
          const same =
            patched.length === base.length &&
            patched.every((s, idx) => s.key === base[idx]?.key && s.label === base[idx]?.label && s.progress === base[idx]?.progress)
          if (!same) {
            next[node.id] = patched
            changed = true
          }
        }
        return changed ? next : prev
      })
    }
    EventBus.on("workflow-graph-run-start", onRunStart)
    EventBus.on("workflow-graph-run-finished", onRunFinished)
    return () => {
      EventBus.off("workflow-graph-run-start", onRunStart)
      EventBus.off("workflow-graph-run-finished", onRunFinished)
    }
  }, [refreshClassificationPrereqFromZarr])
  const applyGeneratedScriptToGraphPanels = useCallback(
    (answer: string, mode: "streaming" | "final") => {
      if (!answer || answer === "wait") return
      if (isCodingAgentGenerationFailureAnswer(answer)) return
      // Streaming: show Ctrl/TissueLab incremental markdown in Generate tab. Final: only real Python (blocks summary_answer prose).
      if (mode === "final" && !looksLikeCodingAgentGeneratedScript(answer)) return
      // Streaming may end with the same string as the final "done" payload — still arm auto_bypass for final.
      if (lastAppliedScriptRef.current === answer) {
        if (mode === "final") codingGenReadyForAutoBypassRef.current = true
        return
      }
      let changed = false
      setPanelStates((prev) => {
        const next = { ...prev }
        for (const node of activeWf.nodes) {
          if (node.kind !== "model" || node.modelId !== "GPT-4o Agent") continue
          const base = prev[node.id] ?? buildLegacyPanelFromNode(node)
          if (!base) continue
          const existing = base.content.find((c) => c.key === "generated_script")
          const nextContent = existing
            ? base.content.map((c) => (c.key === "generated_script" ? { ...c, value: answer } : c))
            : [...base.content, { key: "generated_script", type: "text", value: answer } as any]
          const mergedContent = mergePanelContentWithFactoryDefaults(nextContent, "CodingAgent") as typeof base.content
          next[node.id] = { ...base, content: mergedContent }
          changed = true
        }
        return changed ? next : prev
      })
      if (changed) {
        lastAppliedScriptRef.current = answer
        const zp = getWorkflowZarrPath()
        if (zp) persistCodingAgentGeneratedScript(zp, answer)
      }
      if (mode === "final") {
        codingGenReadyForAutoBypassRef.current = true
      }
    },
    [activeWf.nodes, getWorkflowZarrPath]
  )

  const buildBatchRunPlan = useCallback(():
    | {
        ok: true
        panelsToRun: WorkflowPanel[]
        taskDeps?: Record<string, string[]>
        runNodeIds: Set<string>
        backendNodeIds: string[]
      }
    | { ok: false; error: string } => {
    const rawModelNodes = activeWf.nodes.filter((n) => n.kind === "model" && n.modelId)
    if (rawModelNodes.length === 0) {
      return { ok: false, error: "Add at least one model node first." }
    }
    const outsidePathIds = modelNodeIdsOutsideStartEndPath(
      rawModelNodes,
      activeWf.connections,
      START_NODE_ID,
      END_NODE_ID
    )
    if (outsidePathIds.length > 0) {
      const labels = outsidePathIds
        .map((id) => rawModelNodes.find((n) => n.id === id)?.label || rawModelNodes.find((n) => n.id === id)?.modelId || id)
        .join(", ")
      return { ok: false, error: `Connect Start → model(s) → End before batch processing. Unconnected: ${labels}.` }
    }
    const disconnectedIds = disconnectedModelNodeIds(rawModelNodes, activeWf.connections)
    if (disconnectedIds.length > 0) {
      const labels = disconnectedIds
        .map((id) => rawModelNodes.find((n) => n.id === id)?.label || rawModelNodes.find((n) => n.id === id)?.modelId || id)
        .join(", ")
      return { ok: false, error: `Connect all model nodes into one workflow before batch processing. Unconnected: ${labels}.` }
    }

    const idToBackend = new Map<string, string>()
    const executableModelNodes = rawModelNodes.filter((node) => node.modelId !== CODING_GRAPH_MODEL_ID)
    const scriptOnlyNodes = rawModelNodes.filter((node) => node.modelId === CODING_GRAPH_MODEL_ID)
    const topoNodes = executableModelNodes.map((n) => {
      const backendName = n.modelId!
      idToBackend.set(n.id, backendName)
      return { id: n.id, y: n.y, backendName }
    })
    const sortedTopo = topoSortModelNodesForRun(topoNodes, activeWf.connections)
    const orderedTopo =
      sortedTopo === null
        ? [...topoNodes].sort((a, b) => (a.y !== b.y ? a.y - b.y : a.id.localeCompare(b.id)))
        : sortedTopo
    const taskDeps = sortedTopo === null ? undefined : buildTaskDependenciesFromTopo(sortedTopo, activeWf.connections, idToBackend)
    const orderedGraphNodes = orderedTopo
      .map((t) => executableModelNodes.find((n) => n.id === t.id))
      .filter((n): n is GraphNode => Boolean(n))
    const orderedScriptNodes = [...scriptOnlyNodes].sort((a, b) => (a.y !== b.y ? a.y - b.y : a.id.localeCompare(b.id)))
    const allRunNodes = [...orderedGraphNodes, ...orderedScriptNodes]
    const panelsToRun: WorkflowPanel[] = []
    for (const node of allRunNodes) {
      const panel = ensureLegacyPanel(node)
      if (panel) panelsToRun.push(panel)
    }
    if (panelsToRun.length === 0) {
      return { ok: false, error: "Could not resolve panel configuration for model nodes." }
    }
    return {
      ok: true,
      panelsToRun,
      taskDeps,
      runNodeIds: new Set(allRunNodes.map((node) => node.id)),
      backendNodeIds: Array.from(new Set(topoNodes.map((node) => node.backendName))),
    }
  }, [activeWf.connections, activeWf.nodes, ensureLegacyPanel])

  const fetchRunningTaskNodes = useCallback(async (): Promise<Record<string, { running?: boolean }>> => {
    const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_node_ports`, {
      method: "GET",
      returnAxiosFormat: true,
    })
    const data = resp?.data
    return (data?.data?.nodes ?? data?.nodes ?? {}) as Record<string, { running?: boolean }>
  }, [])

  const fetchConfiguredTaskNodes = useCallback(async (): Promise<Record<string, any>> => {
    const listResp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_nodes_extended`, {
      method: "GET",
      returnAxiosFormat: true,
    })
    const payload = listResp?.data?.data ?? listResp?.data ?? {}
    return (payload.nodes ?? {}) as Record<string, any>
  }, [])

  const assertBatchTaskNodesRunning = useCallback(
    async (backendNodeIds: string[]) => {
      if (backendNodeIds.length === 0) return
      const [runningNodes, configuredNodes] = await Promise.all([
        fetchRunningTaskNodes(),
        fetchConfiguredTaskNodes(),
      ])
      const notRunning = backendNodeIds.filter((nodeId) => !runningNodes[nodeId]?.running)
      if (notRunning.length === 0) return

      const configuredButStopped = notRunning.filter((nodeId) => configuredNodes[nodeId])
      const notConfigured = notRunning.filter((nodeId) => !configuredNodes[nodeId])
      if (configuredButStopped.length > 0) {
        throw new Error(
          `Configured node${configuredButStopped.length > 1 ? "s are" : " is"} not running: ${configuredButStopped.join(", ")}. Activate/start ${configuredButStopped.length > 1 ? "them" : "it"} before batch processing.`
        )
      }
      if (notConfigured.length > 0) {
        throw new Error(
          `Workflow node${notConfigured.length > 1 ? "s are" : " is"} not configured or installed: ${notConfigured.join(", ")}. Configure ${notConfigured.length > 1 ? "them" : "it"} before batch processing.`
        )
      }
    },
    [fetchConfiguredTaskNodes, fetchRunningTaskNodes]
  )

  const updateBatchItem = useCallback(
    (
      path: string,
      updater: (item: WorkflowBatchHistoryItem) => WorkflowBatchHistoryItem,
      entryPatch?: Partial<WorkflowBatchHistoryEntry>
    ) => {
      const entry = activeBatchEntryRef.current
      if (!entry) return null
      const nextEntry = summarizeWorkflowBatchEntry({
        ...entry,
        ...entryPatch,
        items: entry.items.map((item) => (item.path === path ? updater(item) : item)),
      })
      return persistBatchEntry(nextEntry)
    },
    [persistBatchEntry]
  )

  const runWorkflowBatch = useCallback(
    async (params: { files: WorkflowBatchFile[]; sourceMode: WorkflowBatchSourceMode; stopOnFirstError: boolean }) => {
      if (isBatchRunning || isRunning) {
        toast.info("A workflow is already running.")
        return
      }
      const files = params.files.map((file) => ({ ...file, path: formatPath(file.path) })).filter((file) => file.path)
      if (files.length === 0) {
        toast.info("No files selected for batch processing.")
        return
      }
      const readOnly = files.find((file) => isPublicReadOnlyPath(file.path))
      if (readOnly || isPublicReadOnlyPath(selectedFolder ?? "")) {
        toast.error(getRestrictedDirectoryMessage("batch process workflow"))
        return
      }
      const plan = buildBatchRunPlan()
      if (!plan.ok) {
        toast.error(plan.error)
        return
      }
      try {
        await assertBatchTaskNodesRunning(plan.backendNodeIds)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Some workflow nodes are not ready."
        toast.error(message)
        return
      }

      const entry = createWorkflowBatchHistoryEntry({
        sourceMode: params.sourceMode,
        folderSnapshot: selectedFolder || undefined,
        files,
        panelsSnapshot: plan.panelsToRun,
        workflowFingerprint: `${activeWf.name}:${activeWf.nodes
          .filter((node) => node.kind === "model")
          .map((node) => node.modelId || node.label || node.id)
          .join(">")}`,
        roiSummary: {
          mode: "viewer_roi",
          bbox:
            bboxBounds.x1 && bboxBounds.y1 && bboxBounds.x2 && bboxBounds.y2
              ? [Number(bboxBounds.x1), Number(bboxBounds.y1), Number(bboxBounds.x2), Number(bboxBounds.y2)]
              : null,
        },
        settings: {
          stopOnFirstError: params.stopOnFirstError,
          skipMissingZarr: true,
        },
      })

      batchAbortRef.current = false
      setBatchBannerDismissed(false)
      setIsBatchRunning(true)
      dispatch(resetWorkflowStatus())
      resetAllGraphProgress()
      persistBatchEntry(entry)
      toast.message(`Batch started for ${files.length} file${files.length === 1 ? "" : "s"}.`)

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        if (batchAbortRef.current) break

        const startedAt = Date.now()
        updateBatchItem(
          file.path,
          (item) => ({ ...item, status: "running", startedAt, errorMessage: undefined, errorPhase: undefined }),
          { progress: { currentIndex: index + 1, total: files.length, currentPath: file.path } }
        )

        dispatch(resetWorkflowStatus())
        resetAllGraphProgress()

        let status: WorkflowBatchHistoryItem["status"] = "completed"
        let errorMessage: string | undefined
        let errorPhase: WorkflowBatchHistoryItem["errorPhase"]
        try {
          const ctx: BuildWorkflowPayloadContext = {
            currentPath: file.path,
            nucleiClasses,
            currentOrgan,
            reduxPatchClassificationData,
            x1: bboxBounds.x1,
            y1: bboxBounds.y1,
            x2: bboxBounds.x2,
            y2: bboxBounds.y2,
            shapeData,
          }
          const currentZarrPath = `${file.path}.zarr`
          currentBatchZarrPathRef.current = currentZarrPath
          const { payload } = buildStartWorkflowPayload(plan.panelsToRun, currentZarrPath, ctx)
          if (plan.taskDeps) {
            payload.task_dependencies = plan.taskDeps
          }
          dispatch(
            setWorkflowCompletionHints({
              refreshTissuePatches: plan.panelsToRun.some((panel) => panel.title === "Tissue Classification"),
            })
          )

          await startWorkflowAllowingForceOverride(payload)
          const result = await waitForWorkflowCompleteSignal()
          if (result.finalStatus === "stopped") {
            batchAbortRef.current = true
            status = "skipped"
            errorPhase = "skipped"
            errorMessage = "Stopped by user."
          } else if (!result.success) {
            status = "error"
            errorPhase = "runtime"
            errorMessage = result.errorMessage || "Workflow failed while processing this file."
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Workflow failed while processing this file."
          if (message === FORCE_OVERRIDE_CANCELLED) {
            batchAbortRef.current = true
            status = "skipped"
            errorPhase = "skipped"
            errorMessage = "Force override cancelled."
          } else {
            status = "error"
            errorMessage = message
            errorPhase = message.toLowerCase().includes("timed out") ? "timeout" : "start"
          }
        }

        const finishedAt = Date.now()
        updateBatchItem(file.path, (item) => ({
          ...item,
          status,
          finishedAt,
          durationMs: finishedAt - startedAt,
          errorMessage,
          errorPhase,
        }))

        if (batchAbortRef.current || (params.stopOnFirstError && status === "error")) {
          break
        }
      }

      const latest = activeBatchEntryRef.current
      if (latest) {
        const finishedAt = Date.now()
        const summarized = summarizeWorkflowBatchEntry(latest)
        const aborted = batchAbortRef.current
        const aggregateStatus = aborted
          ? "aborted_by_user"
          : summarized.failedCount > 0 || summarized.skippedCount > 0
            ? "partial_failure"
            : "completed"
        persistBatchEntry({
          ...summarized,
          finishedAt,
          aggregateStatus,
          progress: { ...summarized.progress, currentPath: null },
        })
        if (aggregateStatus === "completed") {
          toast.success("Batch processing completed.")
        } else if (aggregateStatus === "aborted_by_user") {
          toast.message("Batch processing stopped.")
        } else {
          toast.info("Batch processing finished with errors.")
        }
      }
      setIsBatchRunning(false)
      currentBatchZarrPathRef.current = null
      dispatch(resetWorkflowStatus())
      setRuntimeRunningId(null)
    },
    [
      activeWf.name,
      activeWf.nodes,
      bboxBounds,
      buildBatchRunPlan,
      currentOrgan,
      dispatch,
      isBatchRunning,
      isRunning,
      nucleiClasses,
      persistBatchEntry,
      reduxPatchClassificationData,
      selectedFolder,
      assertBatchTaskNodesRunning,
      resetAllGraphProgress,
      shapeData,
      startWorkflowAllowingForceOverride,
      updateBatchItem,
      waitForWorkflowCompleteSignal,
    ]
  )

  const runWorkflow = useCallback(async () => {
    if (isRunning) return
    if (isPublicReadOnlyPath(currentPath ?? "")) {
      toast.error(getRestrictedDirectoryMessage("run workflow"))
      return
    }
    const zarrPath = getWorkflowZarrPath()
    if (!zarrPath) {
      toast.error("Open an image first to determine workflow zarr path.")
      return
    }
    const rawModelNodes = activeWf.nodes.filter((n) => n.kind === "model" && n.modelId)
    if (rawModelNodes.length === 0) {
      toast.error("Add at least one model node first.")
      return
    }
    const outsidePathIds = modelNodeIdsOutsideStartEndPath(
      rawModelNodes,
      activeWf.connections,
      START_NODE_ID,
      END_NODE_ID
    )
    if (outsidePathIds.length > 0) {
      const disconnectedLabels = outsidePathIds
        .map((id) => rawModelNodes.find((n) => n.id === id)?.label || rawModelNodes.find((n) => n.id === id)?.modelId || id)
        .join(", ")
      toast.error(
        `Connect Start → model(s) → End before running the graph. Unconnected: ${disconnectedLabels}. Use Re-run/Run stage for a single node.`
      )
      return
    }
    const disconnectedIds = disconnectedModelNodeIds(rawModelNodes, activeWf.connections)
    if (disconnectedIds.length > 0) {
      const disconnectedLabels = disconnectedIds
        .map((id) => rawModelNodes.find((n) => n.id === id)?.label || rawModelNodes.find((n) => n.id === id)?.modelId || id)
        .join(", ")
      toast.error(
        `Connect all model nodes into one workflow before running. Unconnected: ${disconnectedLabels}. Use Re-run/Run stage for a single node.`
      )
      return
    }

    const idToBackend = new Map<string, string>()
    const executableModelNodes = rawModelNodes.filter((n) => n.modelId !== "GPT-4o Agent")
    const scriptOnlyNodes = rawModelNodes.filter((n) => n.modelId === "GPT-4o Agent")

    const topoNodes = executableModelNodes
      .map((n) => {
        const b = n.modelId!
        idToBackend.set(n.id, b)
        return { id: n.id, y: n.y, backendName: b }
      })
      .filter((n) => n.backendName)

    const sortedTopo = topoNodes.length > 0 ? topoSortModelNodesForRun(topoNodes, activeWf.connections) : []
    let orderedTopo = sortedTopo
    let taskDeps: Record<string, string[]> | undefined
    if (sortedTopo === null) {
      toast.message("Could not order graph (cycle or disconnected nodes). Using vertical order; dependencies may be approximate.")
      orderedTopo = [...topoNodes].sort((a, b) => (a.y !== b.y ? a.y - b.y : a.id.localeCompare(b.id)))
    } else if (topoNodes.length > 0) {
      taskDeps = buildTaskDependenciesFromTopo(sortedTopo, activeWf.connections, idToBackend)
    }

    const orderedGraphNodes = orderedTopo!
      .map((t) => executableModelNodes.find((n) => n.id === t.id))
      .filter((n): n is GraphNode => Boolean(n))
    const orderedScriptNodes = [...scriptOnlyNodes].sort((a, b) => (a.y !== b.y ? a.y - b.y : a.id.localeCompare(b.id)))
    const allRunNodes = [...orderedGraphNodes, ...orderedScriptNodes]

    const panelsToRun: WorkflowPanel[] = []
    for (const node of allRunNodes) {
      const p = ensureLegacyPanel(node)
      if (p) panelsToRun.push(p)
    }
    if (panelsToRun.length === 0) {
      toast.error("Could not resolve panel configuration for model nodes.")
      return
    }

    dispatch(resetWorkflowStatus())
    resetAllGraphProgress()

    const ctx: BuildWorkflowPayloadContext = {
      currentPath,
      nucleiClasses,
      currentOrgan,
      reduxPatchClassificationData,
      x1: bboxBounds.x1,
      y1: bboxBounds.y1,
      x2: bboxBounds.x2,
      y2: bboxBounds.y2,
      shapeData,
    }
    const { payload } = buildStartWorkflowPayload(panelsToRun, zarrPath, ctx)
    if (taskDeps) {
      payload.task_dependencies = taskDeps
    }

    dispatch(
      setWorkflowCompletionHints({
        refreshTissuePatches: panelsToRun.some((p) => p.title === "Tissue Classification"),
      })
    )

    try {
      const resp = await startWorkflowAllowingForceOverride(payload)
      const rawCode = resp?.data?.code
      const hasAppCode = rawCode !== undefined && rawCode !== null
      const code = Number(rawCode)
      const ok =
        resp?.status === 200 &&
        resp?.data?.success !== false &&
        (!hasAppCode || (Number.isFinite(code) && code === 0))
      if (!ok) {
        throw new Error(
          typeof resp?.data === "string"
            ? resp.data
            : resp?.data?.message || resp?.data?.error || "Workflow start failed"
        )
      }
      setCompletedIds(new Set())
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start workflow."
      if (message !== FORCE_OVERRIDE_CANCELLED) {
        toast.error(message)
      }
    }
  }, [
    isRunning,
    currentPath,
    getWorkflowZarrPath,
    activeWf.nodes,
    activeWf.connections,
    ensureLegacyPanel,
    bboxBounds,
    nucleiClasses,
    currentOrgan,
    reduxPatchClassificationData,
    shapeData,
    dispatch,
    resetAllGraphProgress,
    startWorkflowAllowingForceOverride,
  ])

  // Open the model-config pane and focus the Active Learning tab for the given node
  const openActiveLearning = useCallback(
    (nodeId: string) => {
      setSelectedId(nodeId)
      setConfigTab("active-learning")
      setBottomMode("config")
    },
    [setSelectedId]
  )

  /** Start backend `tasks/v1/start_workflow` for a single canvas node (NuClass Re-run, Run all, etc.). */
  const startSingleNodeWorkflow = useCallback(
    async (nodeId: string) => {
      if (isRunning) return
      if (isPublicReadOnlyPath(currentPath ?? "")) {
        toast.error(getRestrictedDirectoryMessage("run workflow"))
        return
      }
      const zarrPath = getWorkflowZarrPath()
      if (!zarrPath) {
        toast.error("Open an image first to determine workflow zarr path.")
        return
      }
      const node = activeWf.nodes.find((n) => n.id === nodeId)
      if (!node || node.kind !== "model" || !node.modelId) return
      const modelId = node.modelId
      if (modelId === CODING_GRAPH_MODEL_ID) {
        toast.message("Use the Coding Agent panel to run generated scripts.")
        return
      }

      const panel = ensureLegacyPanel(node)
      if (!panel) {
        toast.error("Could not resolve panel configuration for this node.")
        return
      }

      setRuntimeNodeProgressById((prev) => ({ ...prev, [nodeId]: 0 }))
      setRuntimeNodeSubStagesById((prev) => {
        const next = { ...prev }
        const nodeSubStages = createInitialSubStages(modelId) ?? node.subStages
        if (nodeSubStages && nodeSubStages.length > 0) {
          next[nodeId] = nodeSubStages.map((s) => ({ ...s, progress: 0 }))
        } else {
          delete next[nodeId]
        }
        return next
      })
      setCompletedIds((prev) => {
        const next = new Set(prev)
        next.delete(nodeId)
        return next
      })
      setRuntimeRunningId(null)

      await resetWorkflowBeforeStart(dispatch)

      const ctx: BuildWorkflowPayloadContext = {
        currentPath,
        nucleiClasses,
        currentOrgan,
        reduxPatchClassificationData,
        x1: bboxBounds.x1,
        y1: bboxBounds.y1,
        x2: bboxBounds.x2,
        y2: bboxBounds.y2,
        shapeData,
      }
      const { payload } = buildStartWorkflowPayload([panel], zarrPath, ctx)

      dispatch(
        setWorkflowCompletionHints({
          refreshTissuePatches: panel.title === "Tissue Classification",
        })
      )

      try {
        await startWorkflowAllowingForceOverride(payload)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start workflow."
        if (message !== FORCE_OVERRIDE_CANCELLED) {
          toast.error(message)
        }
      }
    },
    [
      isRunning,
      currentPath,
      getWorkflowZarrPath,
      activeWf.nodes,
      ensureLegacyPanel,
      bboxBounds,
      nucleiClasses,
      currentOrgan,
      reduxPatchClassificationData,
      shapeData,
      dispatch,
      startWorkflowAllowingForceOverride,
    ]
  )

  /** Per-step Re-run — only wired for stages marked `rerunnable` (e.g. NuClass classification). */
  const runStage = useCallback(
    async (nodeId: string, stageIdx: number) => {
      if (isRunning) return
      const node = activeWf.nodes.find((n) => n.id === nodeId)
      if (!node?.modelId) return
      const def = MODEL_SUBSTAGES[node.modelId]?.[stageIdx]
      if (!def?.rerunnable) return
      await startSingleNodeWorkflow(nodeId)
    },
    [isRunning, activeWf.nodes, startSingleNodeWorkflow]
  )

  /** Run all / Active Learning “Run stage” — one backend workflow for the selected node. */
  const runOneNode = useCallback(
    async (nodeId: string) => {
      if (isRunning) return
      await startSingleNodeWorkflow(nodeId)
    },
    [isRunning, startSingleNodeWorkflow]
  )

  // Reset run state when switching workflows
  useEffect(() => {
    runAbortRef.current = true
    setRuntimeRunningId(null)
    setCompletedIds(new Set())
    prevWorkflowRunnerNodeIdRef.current = null
  }, [activeWfId, setRuntimeRunningId])

  /** Merge final generated script into graph panels once per run (after `runWorkflowCompletionShared` GET get_answer). No polling during GPT code generation — progress stays on SSE. */
  useEffect(() => {
    const onCodingScriptReady = (answer: unknown) => {
      if (typeof answer !== "string" || !answer.trim()) return
      applyGeneratedScriptToGraphPanels(answer, "final")
    }
    EventBus.on(WORKFLOW_CODING_SCRIPT_READY_EVENT, onCodingScriptReady)
    return () => {
      EventBus.off(WORKFLOW_CODING_SCRIPT_READY_EVENT, onCodingScriptReady)
    }
  }, [applyGeneratedScriptToGraphPanels])

  const sameStringSet = useCallback((a: Set<string>, b: Set<string>) => {
    if (a.size !== b.size) return false
    for (const value of a) {
      if (!b.has(value)) return false
    }
    return true
  }, [])

  // Fake-progress ticker for the CodingAgent canvas node. Backend already
  // emits a 1%/0.3s animation, but the SSE stream throttles to 1-2s ticks
  // (and node_status === 1 arrives even later), so the user sees nothing
  // for ~20s then a sudden jump. Trigger the ramp the *moment* the
  // frontend kicks off the chain (graphCodingRunNodeId set), so motion
  // starts immediately. Status === 1 from SSE is an additional fallback
  // when graphCodingRunNodeId hasn't been set (manual canvas runs, etc.).
  useEffect(() => {
    const statusMap = normalizeWorkflowRuntimeMap(nodeStatus, "node_status")
    const runningCodingNodeIds = new Set<string>()
    if (graphCodingRunNodeId) {
      runningCodingNodeIds.add(graphCodingRunNodeId)
    }
    for (const node of activeWf.nodes) {
      if (node.kind !== "model" || node.modelId !== CODING_GRAPH_MODEL_ID) continue
      const status = firstNumericRuntimeValue(runtimeKeyCandidates(node.modelId).map((k) => statusMap?.[k]))
      if (status === 1) runningCodingNodeIds.add(node.id)
    }
    if (runningCodingNodeIds.size === 0) {
      setFakeCodingProgressById((prev) => (Object.keys(prev).length === 0 ? prev : {}))
      return
    }
    const interval = window.setInterval(() => {
      setFakeCodingProgressById((prev) => {
        const next: Record<string, number> = { ...prev }
        for (const id of Array.from(runningCodingNodeIds)) {
          const current = next[id] ?? 0
          next[id] = current >= 90 ? 90 : current + 3
        }
        return next
      })
    }, 200)
    return () => window.clearInterval(interval)
  }, [activeWf.nodes, nodeStatus, runtimeKeyCandidates, graphCodingRunNodeId])

  useEffect(() => {
    const statusMap = normalizeWorkflowRuntimeMap(nodeStatus, "node_status")
    const progressMap = normalizeWorkflowRuntimeMap(nodeProgress, "node_progress")
    const runtimeIsActive = isRunning || workflowStatus === "running" || workflowStatus === "queued"
    if (!runtimeIsActive) {
      // Only reset once when transitioning from active -> idle.
      // Idle-time node drags should not wipe zarr-derived preprocessed bars.
      if (prevRuntimeActiveRef.current) {
        setRuntimeRunningId(null)
        runtimeNodeSubStagesByIdRef.current = {}
        setRuntimeNodeProgressById({})
        setRuntimeNodeSubStagesById({})
        setCompletedIds(new Set())
      }
      prevRuntimeActiveRef.current = false
      return
    }
    prevRuntimeActiveRef.current = true
    const runtimeRunningNode = activeWf.nodes.find((node) => {
      if (node.kind !== "model" || !node.modelId) return false
      const status = firstNumericRuntimeValue(runtimeKeyCandidates(node.modelId).map((k) => statusMap?.[k]))
      return status === 1
    })
    const nextRunningId = runtimeRunningNode?.id || null
    setRuntimeRunningId(nextRunningId)
    const prevRunner = prevWorkflowRunnerNodeIdRef.current
    if (nextRunningId && nextRunningId !== prevRunner) {
      setSelectedId(nextRunningId)
    }
    prevWorkflowRunnerNodeIdRef.current = nextRunningId

    const stageBreakdownForKeys = (candidateKeys: string[]) => {
      for (const k of candidateKeys) {
        const sp = workflowStageProgress[k]
        if (sp && typeof sp === "object" && Object.keys(sp).length > 0) {
          return sp
        }
      }
      return undefined
    }

    const cellSegStageState = (modelId: string) => {
      const predKeys = runtimeKeyCandidates(modelId)
      const predStatus = firstNumericRuntimeValue(predKeys.map((k) => statusMap?.[k]))
      const predProgress = firstNumericRuntimeValue(predKeys.map((k) => progressMap?.[k]))
      if (predStatus === 2) {
        return { segmentation: 100, embedding: 100, complete: true }
      }
      if (predStatus === 1 && typeof predProgress === "number") {
        const split = sseOverallToSegEmbBars(predProgress)
        return {
          segmentation: clampProgress(split.seg),
          embedding: clampProgress(split.emb),
          complete: split.seg >= 100 && split.emb >= 100,
        }
      }
      const breakdown = stageBreakdownForKeys(predKeys)
      const segmentation = clampProgress(breakdown?.segmentation)
      const embedding = clampProgress(breakdown?.embedding)
      return {
        segmentation,
        embedding,
        complete: segmentation >= 100 && embedding >= 100,
      }
    }

    const doneIds = new Set<string>()
    const nextRuntimeProgressById: Record<string, number> = {}
    const nextRuntimeSubStagesById: Record<string, SubStage[]> = {}
    for (const node of activeWf.nodes) {
      if (node.kind !== "model" || !node.modelId) continue
      const keys = runtimeKeyCandidates(node.modelId)
      const status = firstNumericRuntimeValue(keys.map((k) => statusMap?.[k]))
      const progress = firstNumericRuntimeValue(keys.map((k) => progressMap?.[k]))

      if (node.subStages && node.subStages.length > 0) {
        const stageBreakdown = stageBreakdownForKeys(keys)

        const isCellSegDualBar =
          (node.modelId === "SegmentationNode" ||
            node.modelId === "InstanSegNode" ||
            node.modelId === "NucSegNode") &&
          node.subStages.length === 2 &&
          node.subStages[0]?.key === "segmentation" &&
          node.subStages[1]?.key === "embedding"

        const templateStages =
          RUNTIME_SUBSTAGE_FROM_TEMPLATE_IDS.has(node.modelId) && node.modelId
            ? createInitialSubStages(node.modelId)
            : undefined
        let nextStages = (templateStages ?? node.subStages).map((s) => ({ ...s }))

        if (node.modelId === "ClassificationNode") {
          const segPreds = directModelPredecessors(node.id, connections, activeWf.nodes).filter((p) =>
            isCellSegPipelineModelId(p.modelId)
          )
          const predStates = segPreds.map((p) => cellSegStageState(p.modelId!))
          const prereqsComplete = predStates.length === 0 || predStates.every((s) => s.complete)
          if (predStates.length > 0) {
            nextStages[0] = {
              ...nextStages[0],
              progress: Math.max(
                Math.min(...predStates.map((s) => s.segmentation)),
                clampProgress(stageBreakdown?.segmentation)
              ),
            }
            nextStages[1] = {
              ...nextStages[1],
              progress: Math.max(
                Math.min(...predStates.map((s) => s.embedding)),
                clampProgress(stageBreakdown?.embedding)
              ),
            }
          } else {
            nextStages[0] = {
              ...nextStages[0],
              progress: clampProgress(stageBreakdown?.segmentation),
            }
            nextStages[1] = {
              ...nextStages[1],
              progress: clampProgress(stageBreakdown?.embedding),
            }
          }
          if (nextStages.length > 2) {
            const rawClassificationProgress = typeof progress === "number" ? clampProgress(progress) : 0
            const previousClassificationProgress = runtimeNodeSubStagesByIdRef.current[node.id]?.[2]?.progress ?? 0

            let classificationProgress: number
            if (status === 2) {
              // Backend confirmed this node completed in the current run — trust 100%.
              classificationProgress = 100
            } else if (status === 1) {
              // Node is actively running — use the live SSE progress value directly.
              classificationProgress = rawClassificationProgress
            } else {
              // Node hasn't started yet (status 0/undefined) — keep previous or 0.
              classificationProgress = previousClassificationProgress
            }

            nextStages[2] = {
              ...nextStages[2],
              progress: Math.max(previousClassificationProgress, nextStages[2].progress, classificationProgress),
            }
          }
          if (nextStages.length > 0 && nextStages.every((s) => s.progress >= 100)) {
            doneIds.add(node.id)
          }
          nextRuntimeSubStagesById[node.id] = nextStages
          continue
        }

        if (status === 2) {
          nextStages = nextStages.map((s) => ({ ...s, progress: 100 }))
          nextRuntimeSubStagesById[node.id] = nextStages
          doneIds.add(node.id)
          continue
        }

        if (isCellSegDualBar) {
          const zSeg = Number(stageBreakdown?.segmentation ?? 0)
          const zEmb = Number(stageBreakdown?.embedding ?? 0)
          const split = typeof progress === "number" ? sseOverallToSegEmbBars(progress) : null
          nextStages[0] = {
            ...nextStages[0],
            progress:
              status === 1 && split
                ? split.seg
                : Math.min(100, Math.max(nextStages[0].progress, zSeg, split?.seg ?? 0)),
          }
          nextStages[1] = {
            ...nextStages[1],
            progress:
              status === 1 && split
                ? split.emb
                : Math.min(100, Math.max(nextStages[1].progress, zEmb, split?.emb ?? 0)),
          }
          nextRuntimeSubStagesById[node.id] = nextStages
          continue
        }

        if (stageBreakdown && typeof stageBreakdown === "object" && Object.keys(stageBreakdown).length > 0) {
          nextStages = nextStages.map((stg) => {
            const key = stg.key.toLowerCase()
            let mapped = 0
            if (key.includes("seg")) mapped = Number(stageBreakdown!.segmentation ?? 0)
            else if (key.includes("embed")) mapped = Number(stageBreakdown!.embedding ?? 0)
            else if (key.includes("class") || key.includes("al") || key.includes("pixel")) {
              mapped = Number(stageBreakdown!.classification ?? 0)
            } else if (key.includes("code")) mapped = Number(stageBreakdown!.code_running ?? 0)
            return { ...stg, progress: Math.max(stg.progress, mapped) }
          })
        }

        if (typeof progress === "number") {
          let streamIdx = nextStages.findIndex((s) => s.progress < 100)
          const allMappedComplete =
            nextStages.length > 0 && nextStages.every((s) => s.progress >= 100)
          if (streamIdx < 0 && status === 1 && progress < 100 && allMappedComplete) {
            streamIdx = nextStages.length - 1
          }
          if (streamIdx >= 0) {
            const s = nextStages[streamIdx]
            const boosted =
              streamIdx === nextStages.length - 1 &&
              status === 1 &&
              progress < 100 &&
              allMappedComplete
                ? progress
                : Math.max(s.progress, progress)
            nextStages[streamIdx] = { ...s, progress: boosted }
          }
        }
        nextRuntimeSubStagesById[node.id] = nextStages
      } else if (status === 2) {
        nextRuntimeProgressById[node.id] = 100
        doneIds.add(node.id)
      } else if (typeof progress === "number") {
        // CodingAgent has no real SSE progress; merge the faked ramp in so
        // the canvas tile actually animates while OpenAI generates the script.
        const baseProgress = Math.max(node.progress ?? 0, progress)
        if (node.modelId === CODING_GRAPH_MODEL_ID && status === 1 && baseProgress < 90) {
          const fake = fakeCodingProgressById[node.id] ?? 0
          nextRuntimeProgressById[node.id] = Math.max(baseProgress, fake)
        } else {
          nextRuntimeProgressById[node.id] = baseProgress
        }
      }
    }
    setRuntimeNodeProgressById(nextRuntimeProgressById)
    setRuntimeNodeSubStagesById(nextRuntimeSubStagesById)
    setCompletedIds((prev) => (sameStringSet(prev, doneIds) ? prev : doneIds))
  }, [
    activeWf.nodes,
    isRunning,
    nodeProgress,
    nodeStatus,
    runtimeKeyCandidates,
    sameStringSet,
    setRuntimeRunningId,
    setSelectedId,
    workflowStatus,
    workflowStageProgress,
    connections,
    fakeCodingProgressById,
  ])

  // Resizable height for the expanded bottom panel. Default sizing lives in Tailwind
  // classes; this state is only set after the user drags the resize handle.
  const bottomPanelRef = useRef<HTMLDivElement>(null)
  const dockStripRef = useRef<HTMLDivElement>(null)
  const [expandedHeight, setExpandedHeight] = useState<number | null>(null)
  /** During open/close height animation, overrides expandedHeight / Tailwind height so React does not fight DOM writes. */
  const [sheetAnimPx, setSheetAnimPx] = useState<number | null>(null)
  const [dockStripHeight, setDockStripHeight] = useState(0)
  const [isResizing, setIsResizing] = useState(false)
  const beginResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = bottomPanelRef.current?.getBoundingClientRect().height ?? expandedHeight ?? 0
    setIsResizing(true)
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY
      setExpandedHeight(Math.max(0, startH + delta))
    }
    const onUp = () => {
      setIsResizing(false)
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }, [expandedHeight])

  useEffect(() => {
    const el = dockStripRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setDockStripHeight(entry.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const isCollapsingBottomPanelRef = useRef(false)
  const prevBottomModeForSheetAnim = useRef(bottomMode)

  const handleBottomPanelTransitionEnd = useCallback((e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.propertyName !== "height" || e.target !== e.currentTarget) return
    if (!isCollapsingBottomPanelRef.current) return
    isCollapsingBottomPanelRef.current = false
    setSheetAnimPx(null)
    setBottomMode("none")
  }, [])

  const startBottomPanelClose = useCallback(() => {
    if (isCollapsingBottomPanelRef.current) return
    const el = bottomPanelRef.current
    if (!el) {
      setBottomMode("none")
      setSheetAnimPx(null)
      return
    }
    const dockH = Math.round(Math.max(dockStripRef.current?.getBoundingClientRect().height ?? 40, 40))
    const startH = Math.round(el.getBoundingClientRect().height)
    if (startH <= dockH + 0.5) {
      setBottomMode("none")
      setSheetAnimPx(null)
      return
    }
    isCollapsingBottomPanelRef.current = true
    setSheetAnimPx(startH)
    requestAnimationFrame(() => {
      setSheetAnimPx(dockH)
    })
  }, [])

  const togglePane = useCallback(
    (pane: "chat" | "config") => {
      setBottomMode((cur) => {
        if (cur === pane) {
          queueMicrotask(() => startBottomPanelClose())
          return cur
        }
        if (cur === "none") return pane
        return pane
      })
    },
    [startBottomPanelClose]
  )

  useLayoutEffect(() => {
    const was = prevBottomModeForSheetAnim.current
    if (was === "none" && bottomMode !== "none" && !isResizing) {
      const dockH = Math.round(Math.max(dockStripRef.current?.getBoundingClientRect().height ?? 40, 40))
      setSheetAnimPx(dockH)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setSheetAnimPx(null)
        })
      })
    }
    prevBottomModeForSheetAnim.current = bottomMode
  }, [bottomMode, isResizing])

  useEffect(() => {
    if (bottomMode === "none") {
      isCollapsingBottomPanelRef.current = false
      setSheetAnimPx(null)
    }
  }, [bottomMode])

  // Watch Tutorial dialog
  const [tutorialOpen, setTutorialOpen] = useState(false)

  // Intent prompt — small popover that appears whenever the user lands on Agentic AI
  // (component mount) or spins up a new workflow tab.
  const [intentPromptOpen, setIntentPromptOpen] = useState(false)
  const [intentText, setIntentText] = useState("")
  const dismissIntentPrompt = useCallback(() => {
    setIntentPromptOpen(false)
    setIntentText("")
  }, [])
  const submitIntentPrompt = useCallback(() => {
    const text = intentText.trim()
    if (text) {
      // Surface what the user typed in the chat panel for downstream handling.
      setBottomMode("chat")
      toast.message(`Got it — “${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”`)
    }
    dismissIntentPrompt()
  }, [intentText, dismissIntentPrompt])

  // ─── Save / Load (community-style popup, with offline-capable seed) ───
  const [savedList, setSavedList] = useState<Record<string, SerializedWorkflow>>(() => loadAllSaved())
  const { presets: communityWorkflows, loading: communityWorkflowsLoading } = useCommunityWorkflowsPresets()
  const [loadDialogOpen, setLoadDialogOpen] = useState(false)
  const [loadSearch, setLoadSearch] = useState("")
  const [logDialogOpen, setLogDialogOpen] = useState(false)
  const [selectedLogTarget, setSelectedLogTarget] = useState<{
    node: string
    logPath?: string
    envName?: string
    port?: number
  } | null>(null)

  // Save dialog: full form (name, description, author, tags) — non-dismissable on outside click
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveForm, setSaveForm] = useState<{ name: string; description: string; author: string; tags: string }>({
    name: "",
    description: "",
    author: "",
    tags: "",
  })

  const openSaveDialog = useCallback(() => {
    setSaveForm({ name: activeWf.name, description: "", author: "", tags: "" })
    setSaveDialogOpen(true)
  }, [activeWf.name])

  const restoreSavedWorkflowPanelsAndChat = useCallback(
    (wf: SerializedWorkflow) => {
      const cloned = JSON.parse(JSON.stringify(wf.panelStates)) as Record<string, WorkflowPanel>
      setPanelStates((prev) => ({ ...prev, ...cloned }))
      dispatch(setMessages(wf.chatMessages as ChatMessage[]))
    },
    [dispatch]
  )

  /** After layout restore from sessionStorage; avoids first passive effect overwriting the draft with defaults. */
  const [sessionReady, setSessionReady] = useState(false)
  const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    const d = readWorkflowGraphSessionDraft()
    if (d?.workflows?.length) {
      const nextWfs: Workflow[] = d.workflows.map((w) => ({
        id: w.id,
        name: w.name,
        nodes: normalizeWorkflowGraphNodes(w.nodes as GraphNode[]),
        connections: (w.connections || []) as GraphConnection[],
        selectedId: w.selectedId ?? null,
      }))
      setWorkflows(nextWfs)
      setActiveWfId(d.activeWfId)
      setPanelStates({ ...(d.panelStates as Record<string, WorkflowPanel>) })
      if (d.bottomMode === "none" || d.bottomMode === "chat" || d.bottomMode === "config") {
        setBottomMode(d.bottomMode)
      }
      if (Array.isArray(d.chatMessages) && d.chatMessages.length > 0) {
        dispatch(setMessages(d.chatMessages as ChatMessage[]))
      }
    }
    setSessionReady(true)
  }, [dispatch])

  useEffect(() => {
    if (!sessionReady) return
    const mergedPanelStates: Record<string, WorkflowPanel> = {}
    for (const w of workflows) {
      Object.assign(mergedPanelStates, collectPanelStatesSnapshot(w.nodes, panelStates))
    }
    const draft: WorkflowGraphSessionDraftV1 = {
      version: 1,
      workflows: workflows.map((w) => ({
        id: w.id,
        name: w.name,
        nodes: w.nodes,
        connections: w.connections,
        selectedId: w.selectedId ?? null,
      })),
      activeWfId,
      panelStates: mergedPanelStates as Record<string, unknown>,
      bottomMode,
      chatMessages: JSON.parse(JSON.stringify(chatMessages)) as unknown[],
    }
    if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current)
    sessionSaveTimerRef.current = setTimeout(() => {
      writeWorkflowGraphSessionDraft(draft)
      sessionSaveTimerRef.current = null
    }, 250)
    return () => {
      if (sessionSaveTimerRef.current) {
        clearTimeout(sessionSaveTimerRef.current)
        sessionSaveTimerRef.current = null
      }
      writeWorkflowGraphSessionDraft(draft)
    }
  }, [sessionReady, workflows, activeWfId, panelStates, bottomMode, chatMessages])

  const submitSave = useCallback(() => {
    const name = saveForm.name.trim()
    if (!name) {
      toast.error("Please give the workflow a name")
      return
    }
    const all = loadAllSaved()
    all[name] = {
      name,
      description: saveForm.description.trim() || undefined,
      author: saveForm.author.trim() || undefined,
      tags: saveForm.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      nodes: activeWf.nodes,
      connections: activeWf.connections,
      savedAt: new Date().toISOString(),
      panelStates: collectPanelStatesSnapshot(activeWf.nodes, panelStates),
      chatMessages: JSON.parse(JSON.stringify(chatMessages)) as ChatMessage[],
      selectedId: activeWf.selectedId ?? null,
    }
    const wrote = writeAllSaved(all)
    if (!wrote.ok) {
      toast.error(
        wrote.reason === "quota"
          ? "Storage quota exceeded — could not save. Free browser storage or export the workflow to a file."
          : "Could not save workflow to browser storage."
      )
      return
    }
    setSavedList(all)
    setSaveDialogOpen(false)
    notifyWorkflowLocalStorageChanged()
    toast.success(`Saved "${name}" (graph, chat, and node settings)`)
  }, [saveForm, activeWf, panelStates, chatMessages])

  // Classifier Load dialog: current FM folder (.tlcls) + community list
  const [communityClassifiers, setCommunityClassifiers] = useState<CommunityClassifierOption[]>(COMMUNITY_CLASSIFIERS_FALLBACK)
  const [communityClassifiersLoading, setCommunityClassifiersLoading] = useState(false)
  const [classifierLoadOpen, setClassifierLoadOpen] = useState(false)
  const [classifierContextNodeId, setClassifierContextNodeId] = useState<string | null>(null)
  const [classifierLoadSearch, setClassifierLoadSearch] = useState("")
  const [classifierSaveOpen, setClassifierSaveOpen] = useState(false)
  const [classifierSaveForm, setClassifierSaveForm] = useState({
    name: "",
    description: "",
    author: "",
    tags: "",
  })

  useEffect(() => {
    let cancelled = false
    setCommunityClassifiersLoading(true)
    classifiersService.getPublicClassifiers({ limit: 100 })
      .then((response) => {
        if (cancelled) return
        const remote = (response.classifiers || []).map(remoteClassifierToOption)
        setCommunityClassifiers(remote.length > 0 ? remote : COMMUNITY_CLASSIFIERS_FALLBACK)
      })
      .catch(() => {
        if (!cancelled) setCommunityClassifiers(COMMUNITY_CLASSIFIERS_FALLBACK)
      })
      .finally(() => {
        if (!cancelled) setCommunityClassifiersLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const syncSavedList = () => setSavedList(loadAllSaved())
    const onStorage = (e: StorageEvent) => {
      if (e.key === WORKFLOW_GRAPH_SAVED_STORAGE_KEY || e.key === null) syncSavedList()
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener(WORKFLOW_LOCAL_STORAGE_CHANGED_EVENT, syncSavedList as EventListener)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(WORKFLOW_LOCAL_STORAGE_CHANGED_EVENT, syncSavedList as EventListener)
    }
  }, [])

  const openClassifierLoad = useCallback((nodeId: string) => {
    setClassifierContextNodeId(nodeId)
    setClassifierLoadSearch("")
    setClassifierLoadOpen(true)
  }, [])
  const openNodeLogs = useCallback(
    (nodeId: string) => {
      const node = activeWf.nodes.find((n) => n.id === nodeId)
      const nodeName = node?.modelId
      if (!nodeName) return
      const meta = (nodeLogsMeta?.[nodeName] || {}) as { logPath?: string; envName?: string; port?: number }
      setSelectedLogTarget({ node: nodeName, logPath: meta.logPath, envName: meta.envName, port: meta.port })
      setLogDialogOpen(true)
    },
    [activeWf.nodes, nodeLogsMeta]
  )

  /**
   * Save the tasknode in-memory trained classifier to the current folder (NuClass/MUSK only; no file copy).
   * @param outputStem Optional sanitized filename stem from the dialog "Name" (no extension); if omitted, uses slide + node + timestamp.
   * @returns On success, includes the destination full path for library metadata.
   */
  const saveClassifierFile = useCallback(
    async (
      nodeId: string,
      options?: { outputStem?: string }
    ): Promise<{ ok: true; destFull: string; destFileName: string } | { ok: false }> => {
      if (isPublicReadOnlyPath(currentPath ?? "") || isPublicReadOnlyPath(selectedFolder ?? undefined)) {
        toast.error(getRestrictedDirectoryMessage("save classifier"))
        return { ok: false }
      }
      const node = activeWf.nodes.find((n) => n.id === nodeId)
      if (!node) return { ok: false }
      const panel = ensureLegacyPanel(node)
      if (!panel) return { ok: false }

      if (!graphClassificationStageDone(node)) {
        toast.error("Finish this node's run (including the classification step) before saving the classifier.")
        return { ok: false }
      }
      const persistModelName = graphClassifierTasknodePersistModelName(node.modelId)
      if (!persistModelName) {
        toast.error("Save classifier from memory is only available for NuClass or MUSK classification nodes.")
        return { ok: false }
      }

      const slideStem = sanitizeFilename(
        (formatPath(currentPath ?? "")
          .split(/[/\\]/)
          .pop() || "slide"
        ).replace(/\.(zarr|svs|tif|tiff|ndpi|isyntax)$/i, "")
      )
      const nodeTag = sanitizeFilename((node.label || node.modelId || "clf").slice(0, 28) || "clf")
      const ext = ".tlcls"
      const fromForm = (options?.outputStem ?? "").trim()
      const sanitizedStem = fromForm
        ? sanitizeFilename(fromForm.replace(/\.tlcls$/i, "")).slice(0, 200) || `${slideStem}_${nodeTag}_${Date.now().toString(36)}`
        : `${slideStem}_${nodeTag}_${Date.now().toString(36)}`
      const destFileName = `${sanitizedStem}${ext}`

      let folder = (selectedFolder ?? "").trim()
      if (!folder && currentPath) {
        const norm = formatPath(currentPath)
        const sep = norm.includes("\\") ? "\\" : "/"
        const idx = norm.lastIndexOf(sep)
        folder = idx > 0 ? norm.slice(0, idx) : norm
      }
      if (!folder) {
        toast.error("Choose a folder in the sidebar to save into, or open a slide so the folder can be inferred.")
        return { ok: false }
      }

      const destFull = `${folder.replace(/\\+$/, "")}\\${destFileName}`.replace(/\\+/g, "\\")

      const applySavedPath = () => {
        handleLegacyPanelChange(panel.id, {
          ...panel,
          content: upsertContentStringValue(panel.content, "save_classifier_path", destFull),
        })
      }

      try {
        await saveClassifierViaTasknode(
          {
            node_name: persistModelName,
            dest_path: normalizePathForSegClassifierApi(destFull),
          },
          { instanceId: activeInstanceId }
        )
        applySavedPath()
        toast.success(`Saved trained classifier to current folder: ${destFileName}`)
        return { ok: true, destFull, destFileName }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`Save failed: ${msg}`)
        return { ok: false }
      }
    },
    [activeWf.nodes, ensureLegacyPanel, currentPath, selectedFolder, activeInstanceId, handleLegacyPanelChange]
  )

  const openClassifierSave = useCallback(
    (nodeId: string) => {
      if (isPublicReadOnlyPath(currentPath ?? "") || isPublicReadOnlyPath(selectedFolder ?? undefined)) {
        toast.error(getRestrictedDirectoryMessage("save classifier"))
        return
      }
      const node = activeWf.nodes.find((n) => n.id === nodeId)
      if (!node) return
      const panel = ensureLegacyPanel(node)
      if (!panel) return
      if (!graphClassificationStageDone(node)) {
        toast.error("Finish this node's run (including the classification step) before saving the classifier.")
        return
      }
      const persistName = graphClassifierTasknodePersistModelName(node.modelId)
      if (!persistName) {
        toast.error("Save classifier from memory is only available for NuClass or MUSK classification nodes.")
        return
      }
      const meta = node.modelId ? registryNodes[node.modelId] : undefined
      setClassifierContextNodeId(nodeId)
      setClassifierSaveForm({
        name: `${meta?.displayName || node.modelId || "Classifier"} · ${activeWf.name}`,
        description: "",
        author: "",
        tags: "",
      })
      setClassifierSaveOpen(true)
    },
    [activeWf.nodes, activeWf.name, currentPath, selectedFolder, ensureLegacyPanel]
  )

  const submitClassifierSave = useCallback(async () => {
    const name = classifierSaveForm.name.trim()
    if (!name) {
      toast.error("Please enter a classifier name (Name).")
      return
    }
    const tags = classifierSaveForm.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
    const nodeId = classifierContextNodeId
    if (!nodeId) {
      toast.error("No model node selected.")
      return
    }
    const stemForFile = name.replace(/\.tlcls$/i, "")
    const result = await saveClassifierFile(nodeId, { outputStem: stemForFile })
    if (!result.ok) return
    const node = activeWf.nodes.find((n) => n.id === nodeId)
    if (!node?.modelId) {
      setClassifierSaveOpen(false)
      return
    }
    const meta = registryNodes[node.modelId]
    const all = loadAllClassifiers()
    all[name] = {
      name,
      modelId: node.modelId,
      factory: meta?.factory,
      path: result.destFull,
      description: classifierSaveForm.description.trim() || undefined,
      author: classifierSaveForm.author.trim() || undefined,
      ...(tags.length > 0 ? { tags } : {}),
      savedAt: new Date().toISOString(),
    }
    writeAllClassifiers(all)
    setClassifierSaveOpen(false)
  }, [classifierSaveForm, classifierContextNodeId, activeWf.nodes, saveClassifierFile])

  const loadClassifierIntoNode = useCallback(
    (classifier: {
      name: string
      source: ClassifierSource
      path?: string
      author?: string
      savedAt?: string
    }) => {
      const node = classifierContextNodeId
        ? activeWf.nodes.find((n) => n.id === classifierContextNodeId)
        : null
      if (!node) {
        toast.error("Select a model card first")
        return
      }
      const selectedClassifierPath = classifier.path
      setPanelStates((prev) => {
        const base = prev[node.id] ?? buildLegacyPanelFromNode(node)
        if (!base) return prev
        const withoutOldPaths = removeClassifierPathContent(base.content)
        let nextContent = selectedClassifierPath
          ? upsertContentStringValue(withoutOldPaths, "classifier_path", selectedClassifierPath)
          : withoutOldPaths
        nextContent = upsertContentStringValue(nextContent, "classifier_display_name", classifier.name)
        nextContent = nextContent.filter((item) => item.key !== "classifier_download_link")
        return { ...prev, [node.id]: { ...base, content: nextContent } }
      })
      setNodes((prev) =>
        prev.map((n) =>
          n.id === node.id
            ? {
                ...n,
                loadedClassifier: {
                  name: classifier.name,
                  source: classifier.source,
                  path: classifier.path,
                  author: classifier.author,
                  savedAt: classifier.savedAt,
                },
              }
            : n
        )
      )
      setClassifierLoadOpen(false)
      toast.success(
        classifier.source === "community"
          ? `Imported community classifier "${classifier.name}"`
          : classifier.source === "folder"
            ? `Loaded "${classifier.name}" from current folder into ${node.label || node.modelId}`
            : `Loaded "${classifier.name}" into ${node.label || node.modelId}`
      )
    },
    [activeWf, classifierContextNodeId, setNodes]
  )

  const handleLoadFromStorage = useCallback(
    (name: string) => {
      const wf = loadAllSaved()[name] ?? null
      if (!wf) {
        toast.error("Invalid or outdated workflow snapshot. Save again from Agentic AI.")
        return
      }
      const loaded: Workflow = {
        id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: wf.name,
        nodes: normalizeWorkflowGraphNodes(wf.nodes as GraphNode[]),
        connections: wf.connections as GraphConnection[],
        selectedId: wf.selectedId,
      }
      setWorkflows((prev) => [...prev, loaded])
      setActiveWfId(loaded.id)
      restoreSavedWorkflowPanelsAndChat(wf)
      toast.success(`Loaded "${name}"`)
    },
    [restoreSavedWorkflowPanelsAndChat]
  )

  // Load a preset community workflow (default JSON until online DB is wired).
  const handleLoadCommunityWorkflow = useCallback(
    (wf: CommunityWorkflow) => {
      const loaded: Workflow = {
        id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: wf.name,
        nodes: normalizeWorkflowGraphNodes(wf.nodes as GraphNode[]),
        connections: wf.connections,
        selectedId: wf.selectedId,
      }
      setWorkflows((prev) => [...prev, loaded])
      setActiveWfId(loaded.id)
      restoreSavedWorkflowPanelsAndChat(wf as SerializedWorkflow)
      setLoadDialogOpen(false)
      toast.success(`Loaded "${wf.name}"`)
    },
    [restoreSavedWorkflowPanelsAndChat]
  )

  const handleDeleteSaved = useCallback((name: string) => {
    const all = loadAllSaved()
    delete all[name]
    const wrote = writeAllSaved(all)
    if (!wrote.ok) {
      toast.error(
        wrote.reason === "quota"
          ? "Storage quota exceeded — could not update saved workflows."
          : "Could not update saved workflows."
      )
      return
    }
    setSavedList(all)
    notifyWorkflowLocalStorageChanged()
    toast.message(`Removed "${name}"`)
  }, [])

  const handleExportFile = useCallback(() => {
    if (typeof window === "undefined") return
    const payload: SerializedWorkflow = {
      name: activeWf.name,
      nodes: activeWf.nodes,
      connections: activeWf.connections,
      savedAt: new Date().toISOString(),
      panelStates: collectPanelStatesSnapshot(activeWf.nodes, panelStates),
      chatMessages: JSON.parse(JSON.stringify(chatMessages)) as ChatMessage[],
      selectedId: activeWf.selectedId ?? null,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const safeName = activeWf.name.replace(/[^a-z0-9_\-]+/gi, "_") || "workflow"
    const a = document.createElement("a")
    a.href = url
    a.download = `${safeName}.workflow.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [activeWf, panelStates, chatMessages])

  const handleImportFile = useCallback(() => {
    if (typeof window === "undefined") return
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "application/json,.json"
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const raw: unknown = JSON.parse(text)
        if (!isSerializedWorkflow(raw)) {
          toast.error("Invalid workflow file (expected current export shape).")
          return
        }
        const wf = raw
        const loaded: Workflow = {
          id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: wf.name || file.name.replace(/\.workflow\.json$|\.json$/i, ""),
          nodes: normalizeWorkflowGraphNodes(wf.nodes as GraphNode[]),
          connections: wf.connections as GraphConnection[],
          selectedId: wf.selectedId,
        }
        setWorkflows((prev) => [...prev, loaded])
        setActiveWfId(loaded.id)
        restoreSavedWorkflowPanelsAndChat(wf)
        toast.success(`Imported "${loaded.name}"`)
      } catch {
        toast.error("Failed to parse workflow file")
      }
    }
    input.click()
  }, [restoreSavedWorkflowPanelsAndChat])

  // ─── Other UI state ───
  const [importOpen, setImportOpen] = useState(false)
  const [dragging, setDragging] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const draggingRef = useRef<{ id: string; offsetX: number; offsetY: number; x: number; y: number } | null>(null)
  const nodeDragRafRef = useRef<number | null>(null)
  const connectingRef = useRef<{ fromId: string; fromPort: PortSide; mouseX: number; mouseY: number } | null>(null)
  const [connectingState, setConnectingState] = useState<typeof connectingRef.current>(null)
  const [clickedConn, setClickedConn] = useState<{ id: string; x: number; y: number } | null>(null)
  const contentWrapperRef = useRef<HTMLDivElement>(null)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const panOffsetRef = useRef(panOffset)
  const panSessionRef = useRef<{
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const panRafRef = useRef<number | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const applyPanOffset = useCallback((x: number, y: number) => {
    if (contentWrapperRef.current) {
      contentWrapperRef.current.style.transform = `translate(${x}px, ${y}px)`
    }
    if (canvasRef.current) {
      canvasRef.current.style.backgroundPosition = `${x}px ${y}px`
    }
  }, [])

  useEffect(() => {
    panOffsetRef.current = panOffset
    applyPanOffset(panOffset.x, panOffset.y)
  }, [panOffset, applyPanOffset])

  // ─── Canvas auto-scale: shrink content to fit when the canvas gets shorter ───
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setCanvasSize({
        w: entry.contentRect.width,
        h: Math.max(0, entry.contentRect.height - dockStripHeight),
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [dockStripHeight])

  // Center Start (top) and End (bottom) the first time a workflow's canvas is measured.
  // Once the user adds a model node we leave the terminals alone.
  const placedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (canvasSize.w === 0 || canvasSize.h === 0) return
    if (placedRef.current.has(activeWfId)) return
    const wf = workflows.find((w) => w.id === activeWfId)
    if (!wf) return
    if (wf.nodes.some((n) => n.kind === "model")) {
      placedRef.current.add(activeWfId)
      return
    }
    const cx = Math.max(0, canvasSize.w / 2 - TERMINAL_SIZE / 2)
    const startY = 24
    const endY = Math.max(startY + TERMINAL_SIZE + 80, canvasSize.h - TERMINAL_SIZE - 24)
    updateActiveWf((w) => ({
      ...w,
      nodes: w.nodes.map((n) => {
        if (n.id === START_NODE_ID) return { ...n, x: cx, y: startY }
        if (n.id === END_NODE_ID) return { ...n, x: cx, y: endY }
        return n
      }),
    }))
    placedRef.current.add(activeWfId)
  }, [canvasSize, activeWfId, workflows, updateActiveWf])

  const setConnecting = useCallback(
    (val: { fromId: string; fromPort: PortSide; mouseX: number; mouseY: number } | null) => {
      connectingRef.current = val
      setConnectingState(val)
    },
    []
  )

  // ─── Node operations ───
  const addNode = useCallback(
    (modelId: string) => {
      setNodes((prev) => {
        // Place near the logical center of the current visible canvas (X is never scaled, so use width directly).
        const rect = canvasRef.current?.getBoundingClientRect()
        const cx = rect ? rect.width / 2 - NODE_W / 2 : 80
        const start = prev.find((n) => n.id === START_NODE_ID)
        const end = prev.find((n) => n.id === END_NODE_ID)
        const startBottom = start ? start.y + TERMINAL_SIZE : 80
        const endTop = end ? end.y : 360
        const modelCount = prev.filter((n) => n.kind === "model").length
        const modelRowH = Math.max(NODE_H, NODE_H_CODING)
        const slot = startBottom + 24 + modelCount * (modelRowH + 24)
        const cy = Math.min(slot, Math.max(startBottom + 16, endTop - modelRowH - 16))
        const subStages = createInitialSubStages(modelId)
        const initialProgress = getInitialModelProgress(modelId, subStages)
        return [
          ...prev,
          {
            id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            kind: "model",
            modelId,
            x: cx,
            y: cy,
            progress: subStages ? undefined : initialProgress,
            subStages,
          },
        ]
      })
    },
    [setNodes]
  )

  const handleGeneratedWorkflow = useCallback(
    (generatedWorkflow: GeneratedWorkflowStep[], formattedPath: string) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      const layout = buildGeneratedWorkflowChainLayout(generatedWorkflow, formattedPath, {
        centerX: rect ? rect.width / 2 : 200,
        canvasClientHeight: rect?.height,
        dockStripHeight,
        baseId: Date.now(),
      })
      if (!layout) {
        toast.error("No supported workflow nodes were generated.")
        return
      }
      const modelCount = layout.graphNodes.filter((n) => n.kind === "model").length
      updateActiveWf((workflow) => ({
        ...workflow,
        nodes: layout.graphNodes,
        connections: layout.graphConnections,
        selectedId: layout.graphNodes.find((n) => n.kind === "model")?.id ?? null,
      }))
      setPanelStates(layout.generatedPanels)
      setBottomMode("none")
      setIntentPromptOpen(false)
      setIntentText("")

      toast.success(`Generated ${modelCount} node${modelCount === 1 ? "" : "s"} on the graph.`)
      if (layout.skippedSteps.length > 0) {
        toast.warning(
          `Skipped unsupported step${layout.skippedSteps.length === 1 ? "" : "s"}: ${layout.skippedSteps.join(", ")}`
        )
      }
    },
    [updateActiveWf, dockStripHeight]
  )

  const pendingApplyFromChat = useRootStore((s) => s.pendingApplyFromChat)
  const clearPendingWorkflowFromChat = useRootStore((s) => s.clearPendingWorkflowFromChat)

  useEffect(() => {
    if (!pendingApplyFromChat) return
    handleGeneratedWorkflow(
      pendingApplyFromChat.steps as GeneratedWorkflowStep[],
      pendingApplyFromChat.formattedPath
    )
    clearPendingWorkflowFromChat()
  }, [pendingApplyFromChat, handleGeneratedWorkflow, clearPendingWorkflowFromChat])

  const deleteNode = useCallback(
    (id: string) => {
      if (id === START_NODE_ID || id === END_NODE_ID) return
      setNodes((prev) => prev.filter((n) => n.id !== id))
      setConnections((prev) => prev.filter((c) => c.fromId !== id && c.toId !== id))
      setSelectedId((cur) => {
        if (cur === id) {
          setBottomMode((m) => (m === "config" ? "none" : m))
          return null
        }
        return cur
      })
    },
    [setNodes, setConnections, setSelectedId]
  )

  const deleteConnection = useCallback(
    (id: string) => setConnections((prev) => prev.filter((c) => c.id !== id)),
    [setConnections]
  )

  const clearCanvas = useCallback(() => {
    updateActiveWf((w) => ({ ...w, nodes: initialNodes(), connections: [], selectedId: null }))
    setBottomMode((m) => (m === "config" ? "none" : m))
  }, [updateActiveWf])

  const updateNodeField = useCallback(
    (id: string, patch: Partial<Pick<GraphNode, "label" | "description">>) => {
      setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)))
    },
    [setNodes]
  )

  const setClassifierMode = useCallback(
    (id: string, mode: "multiclass" | "one-vs-rest") => {
      setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, classifierMode: mode } : n)))
    },
    [setNodes]
  )

  const clearLoadedClassifier = useCallback(
    (id: string) => {
      setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, loadedClassifier: undefined } : n)))
      setPanelStates((prev) => {
        const panel = prev[id]
        if (!panel) return prev
        return {
          ...prev,
          [id]: {
            ...panel,
            content: [
              ...removeClassifierPathContent(panel.content).filter((item) => item.key !== "classifier_display_name"),
              { key: "classifier_display_name", type: "input", value: "" },
            ],
          },
        }
      })
      toast.message("Classifier load cleared")
    },
    [setNodes]
  )

  // ─── Mouse handlers ───
  // Translate a screen point to logical canvas coords. X is unscaled; Y is divided by yScale
  // so node.y (logical) and the visible Y line up under the position-only compression.
  const screenToLogical = useCallback((clientX: number, clientY: number) => {
    return screenPointToLogicalCanvas(
      clientX,
      clientY,
      canvasRef.current?.getBoundingClientRect(),
      panOffsetRef.current,
      yScaleRef.current || 1
    )
  }, [])

  const handleNodeMouseDown = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      if (e.button !== 0) return
      if (connectingRef.current) return
      const node = nodes.find((n) => n.id === nodeId)
      if (!node || !canvasRef.current) return
      // Single-click only SELECTS a model node (visual highlight + enables MC button).
      // Double-click opens the config pane — see handleNodeDoubleClick below.
      if (node.kind === "model") {
        setSelectedId(nodeId)
      }
      const { x, y } = screenToLogical(e.clientX, e.clientY)
      const nextDragging = {
        id: nodeId,
        offsetX: x - node.x,
        offsetY: y - node.y,
        x: node.x,
        y: node.y,
      }
      draggingRef.current = nextDragging
      setDragging(nextDragging)
      e.preventDefault()
    },
    [nodes, setSelectedId, screenToLogical]
  )

  const handleNodeDoubleClick = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId)
      if (!node || node.kind !== "model") return
      setSelectedId(nodeId)
      setBottomMode("config")
    },
    [nodes, setSelectedId]
  )

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!canvasRef.current) return
      const rect = canvasRef.current.getBoundingClientRect()
      const panSession = panSessionRef.current
      if (panSession && !dragging && !connectingRef.current) {
        const next = {
          x: panSession.originX + e.clientX - panSession.startX,
          y: panSession.originY + e.clientY - panSession.startY,
        }
        panOffsetRef.current = next
        if (panRafRef.current === null) {
          panRafRef.current = window.requestAnimationFrame(() => {
            panRafRef.current = null
            const { x, y } = panOffsetRef.current
            applyPanOffset(x, y)
          })
        }
        return
      }
      const activeDrag = draggingRef.current
      if (activeDrag) {
        const { x: lx, y: ly } = screenToLogical(e.clientX, e.clientY)
        activeDrag.x = Math.max(0, lx - activeDrag.offsetX)
        activeDrag.y = Math.max(0, ly - activeDrag.offsetY)
        if (nodeDragRafRef.current === null) {
          nodeDragRafRef.current = window.requestAnimationFrame(() => {
            nodeDragRafRef.current = null
            const current = draggingRef.current
            if (!current) return
            setNodes((prev) =>
              prev.map((n) => (n.id === current.id ? { ...n, x: current.x, y: current.y } : n))
            )
          })
        }
      }
      if (connectingRef.current) {
        const pan = panOffsetRef.current
        // Preview line is drawn in SVG visual coords — store raw canvas-pixel offsets.
        setConnecting({
          ...connectingRef.current,
          mouseX: e.clientX - rect.left - pan.x,
          mouseY: e.clientY - rect.top - pan.y,
        })
      }
    },
    [dragging, setConnecting, setNodes, screenToLogical, applyPanOffset]
  )

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      if (dragging || connectingRef.current) return
      const target = e.target as Element | null
      if (
        target?.closest(
          "[data-workflow-node], [data-workflow-connection], button, input, textarea, select, [role='dialog']"
        )
      ) {
        return
      }
      panSessionRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: panOffsetRef.current.x,
        originY: panOffsetRef.current.y,
      }
      setIsPanning(true)
      e.preventDefault()
    },
    [dragging]
  )

  const handleOutputPortMouseDown = useCallback(
    (e: React.MouseEvent, nodeId: string, port: PortSide) => {
      e.stopPropagation()
      e.preventDefault()
      if (!canvasRef.current) return
      const rect = canvasRef.current.getBoundingClientRect()
      const pan = panOffsetRef.current
      // Connecting preview uses visual coords for SVG drawing.
      setConnecting({
        fromId: nodeId,
        fromPort: port,
        mouseX: e.clientX - rect.left - pan.x,
        mouseY: e.clientY - rect.top - pan.y,
      })
    },
    [setConnecting]
  )

  const handleInputPortMouseUp = useCallback(
    (e: React.MouseEvent, nodeId: string, port: PortSide) => {
      e.stopPropagation()
      e.preventDefault()
      const conn = connectingRef.current
      if (conn && conn.fromId !== nodeId) {
        const exists = connections.some(
          (c) => c.fromId === conn.fromId && c.toId === nodeId && c.fromPort === conn.fromPort && c.toPort === port
        )
        if (!exists) {
          setConnections((prev) => [
            ...prev,
            {
              id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              fromId: conn.fromId,
              toId: nodeId,
              fromPort: conn.fromPort,
              toPort: port,
            },
          ])
        }
      }
      setConnecting(null)
    },
    [connections, setConnecting, setConnections]
  )

  const handleCanvasMouseUp = useCallback(() => {
    if (panSessionRef.current) {
      setPanOffset(panOffsetRef.current)
      panSessionRef.current = null
      setIsPanning(false)
    }
    const finalDrag = draggingRef.current
    if (finalDrag) {
      setNodes((prev) =>
        prev.map((n) => (n.id === finalDrag.id ? { ...n, x: finalDrag.x, y: finalDrag.y } : n))
      )
      draggingRef.current = null
    }
    setConnecting(null)
    setDragging(null)
  }, [setConnecting, setNodes])

  useEffect(() => {
    const close = () => setClickedConn(null)
    window.addEventListener("click", close)
    return () => window.removeEventListener("click", close)
  }, [])

  useEffect(() => {
    return () => {
      if (panRafRef.current !== null) {
        window.cancelAnimationFrame(panRafRef.current)
      }
      if (nodeDragRafRef.current !== null) {
        window.cancelAnimationFrame(nodeDragRafRef.current)
      }
    }
  }, [])

  // ─── Geometry & layout ───
  const contentBounds = useMemo(() => computeWorkflowContentBounds(nodes), [nodes])

  // Vertical-only fit: cards keep their size; only Y *positions* are compressed when content overflows.
  const wrapperW = Math.max(contentBounds.w, canvasSize.w || 1)
  const wrapperH = Math.max(contentBounds.h, canvasSize.h || 1)
  const yScale = useMemo(() => computeWorkflowYScale(wrapperH, canvasSize.h || 0), [wrapperH, canvasSize.h])
  const yScaleRef = useRef(yScale)
  useEffect(() => { yScaleRef.current = yScale }, [yScale])

  // Returns visual port coords. Y position is compressed by yScale so connections line up
  // with the visually-repositioned cards; card heights are unscaled.
  const getPortPos = useCallback(
    (node: GraphNode, side: PortSide) => getWorkflowGraphPortPosition(node, side, yScale),
    [yScale]
  )

  const autoLayout = useCallback(() => {
    if (nodes.length === 0) return
    const adj = new Map<string, string[]>()
    const inDeg = new Map<string, number>()
    for (const n of nodes) {
      adj.set(n.id, [])
      inDeg.set(n.id, 0)
    }
    for (const c of connections) {
      adj.get(c.fromId)?.push(c.toId)
      inDeg.set(c.toId, (inDeg.get(c.toId) || 0) + 1)
    }
    const layer = new Map<string, number>()
    const queue: string[] = []
    for (const [id, d] of inDeg) {
      if (d === 0) {
        queue.push(id)
        layer.set(id, 0)
      }
    }
    while (queue.length) {
      const cur = queue.shift()!
      const cl = layer.get(cur)!
      for (const next of adj.get(cur) || []) {
        layer.set(next, Math.max(layer.get(next) ?? 0, cl + 1))
        const d = (inDeg.get(next) || 1) - 1
        inDeg.set(next, d)
        if (d === 0) queue.push(next)
      }
    }
    for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, 0)

    layer.set(START_NODE_ID, 0)
    let maxLayer = 0
    for (const v of layer.values()) maxLayer = Math.max(maxLayer, v)
    if (nodes.some((n) => n.id === END_NODE_ID)) {
      maxLayer += 1
      layer.set(END_NODE_ID, maxLayer)
    }

    const layers = new Map<number, string[]>()
    for (const [id, l] of layer) {
      if (!layers.has(l)) layers.set(l, [])
      layers.get(l)!.push(id)
    }
    for (const [, ids] of layers) {
      ids.sort((a, b) => a.localeCompare(b))
    }

    const PAD = 24
    const MIN_GAP = 24
    const rect = canvasRef.current?.getBoundingClientRect()
    const viewportW = canvasSize.w > 0 ? canvasSize.w : rect?.width ?? 560
    const viewportH = Math.max(160, canvasSize.h > 0 ? canvasSize.h : rect?.height ?? 420)
    const fallbackUsableW = Math.max(240, viewportW - 2 * PAD)

    /** Terminals: same X (canvas horizontal center), Y aligned with initial empty-workflow placement. */
    const terminalX = Math.max(0, viewportW / 2 - TERMINAL_SIZE / 2)
    const anchorStartY = PAD
    const anchorEndY = Math.max(PAD + TERMINAL_SIZE + 80, viewportH - TERMINAL_SIZE - 24)

    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]))

      /** Non-empty topological layers in order — empty slots are skipped. */
      const rowLayers = [...layers.entries()]
        .filter(([, ids]) => ids.length > 0)
        .map(([lv]) => lv)
        .sort((a, b) => a - b)

      const layerHeights = new Map<number, number>()
      for (const lv of rowLayers) {
        const ids = layers.get(lv) ?? []
        let mh = 0
        for (const id of ids) {
          const node = byId.get(id)
          if (node) mh = Math.max(mh, nodeHeight(node))
        }
        layerHeights.set(lv, mh > 0 ? mh : NODE_H)
      }

      const layerTop = new Map<number, number>()
      const L = rowLayers.length
      const yFirst = anchorStartY
      const yLast = anchorEndY
      if (L === 0) {
        /* no-op */
      } else if (L === 1) {
        const lv = rowLayers[0]
        const h = layerHeights.get(lv) ?? NODE_H
        layerTop.set(lv, (yFirst + yLast - h) / 2)
      } else {
        for (let i = 0; i < L; i++) {
          const lv = rowLayers[i]
          const t = i / (L - 1)
          layerTop.set(lv, yFirst + t * (yLast - yFirst))
        }
      }

      /** Model rows: horizontal center = canvas center; spread uses full content width. */
      const centerX = viewportW / 2
      const spreadW = fallbackUsableW

      const posX = new Map<string, number>()
      for (let lv = 0; lv <= maxLayer; lv++) {
        const ids = layers.get(lv) ?? []
        if (ids.length === 0) continue
        const row = ids.map((id) => {
          const node = byId.get(id)
          return { id, width: node ? nodeWidth(node) : NODE_W }
        })
        const totalW = row.reduce((s, it) => s + it.width, 0)
        const nInRow = row.length
        if (nInRow === 1) {
          posX.set(row[0].id, centerX - row[0].width / 2)
        } else {
          let gap = (spreadW - totalW) / (nInRow - 1)
          if (!Number.isFinite(gap) || gap < MIN_GAP) gap = MIN_GAP
          const blockW = totalW + (nInRow - 1) * gap
          let cur = centerX - blockW / 2
          for (const it of row) {
            posX.set(it.id, cur)
            cur += it.width + gap
          }
        }
      }

      return prev.map((n) => {
        if (n.id === START_NODE_ID) {
          return { ...n, x: terminalX, y: anchorStartY }
        }
        if (n.id === END_NODE_ID) {
          return { ...n, x: terminalX, y: anchorEndY }
        }
        const lv = layer.get(n.id) ?? 0
        const x = posX.has(n.id) ? posX.get(n.id)! : n.x
        const y = layerTop.has(lv) ? layerTop.get(lv)! : n.y
        return { ...n, x: Math.max(0, x), y: Math.max(0, y) }
      })
    })
  }, [nodes, connections, setNodes, canvasSize])

  const modelNodeCount = nodes.filter((n) => n.kind === "model").length
  const selectedNode = useMemo(() => {
    const base = selectedId ? nodes.find((n) => n.id === selectedId && n.kind === "model") : null
    if (!base) return null
    return {
      ...base,
      progress: runtimeNodeProgressById[base.id] ?? base.progress,
      subStages: runtimeNodeSubStagesById[base.id] ?? base.subStages,
    }
  }, [nodes, selectedId, runtimeNodeProgressById, runtimeNodeSubStagesById])
  const batchDoneCount = activeBatchEntry
    ? activeBatchEntry.completedCount + activeBatchEntry.failedCount + activeBatchEntry.skippedCount
    : 0
  const batchProgressPct = activeBatchEntry && activeBatchEntry.progress.total > 0
    ? Math.round((batchDoneCount / activeBatchEntry.progress.total) * 100)
    : 0
  const batchCurrentPath = activeBatchEntry?.progress.currentPath
  const showBatchBanner = !!activeBatchEntry && (isBatchRunning || !batchBannerDismissed)
  const batchBannerCompleteLabel = useMemo(() => {
    if (!activeBatchEntry || isBatchRunning) return ""
    switch (activeBatchEntry.aggregateStatus) {
      case "completed":
        return "Completed"
      case "partial_failure":
        return "Finished with errors"
      case "aborted_by_user":
        return "Stopped"
      default:
        return "Done"
    }
  }, [activeBatchEntry, isBatchRunning])
  const batchBannerToneClass = useMemo(() => {
    if (!activeBatchEntry) return ""
    if (isBatchRunning) {
      return "border-primary/20 bg-primary/10 text-primary"
    }
    switch (activeBatchEntry.aggregateStatus) {
      case "completed":
        return "border-emerald-500/25 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100"
      case "partial_failure":
        return "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100"
      case "aborted_by_user":
        return "border-muted-foreground/25 bg-muted/40 text-muted-foreground"
      default:
        return "border-primary/20 bg-primary/10 text-primary"
    }
  }, [activeBatchEntry, isBatchRunning])
  const batchProgressBarClass = useMemo(() => {
    if (!activeBatchEntry) return "h-1.5 bg-primary/20 [&>div]:bg-primary"
    if (isBatchRunning) return "h-1.5 bg-primary/20 [&>div]:bg-primary"
    switch (activeBatchEntry.aggregateStatus) {
      case "completed":
        return "h-1.5 bg-emerald-500/20 [&>div]:bg-emerald-500"
      case "partial_failure":
        return "h-1.5 bg-amber-500/20 [&>div]:bg-amber-500"
      case "aborted_by_user":
        return "h-1.5 bg-muted-foreground/20 [&>div]:bg-muted-foreground"
      default:
        return "h-1.5 bg-primary/20 [&>div]:bg-primary"
    }
  }, [activeBatchEntry, isBatchRunning])
  const clearBatchHistory = useCallback(() => {
    clearWorkflowBatchHistory()
    setBatchHistoryEntries([])
    if (!isBatchRunning) {
      setActiveBatchEntry(null)
      activeBatchEntryRef.current = null
      setBatchBannerDismissed(false)
    }
  }, [isBatchRunning])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      {/* ─── Top: Save / Load / Tutorial bar ─── */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border bg-card/60 px-2 py-1.5">
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={openSaveDialog}>
          <Save className="h-3.5 w-3.5" />
          Save
        </Button>
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setLoadDialogOpen(true)}>
          <FolderOpen className="h-3.5 w-3.5" />
          Load
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setTutorialOpen(true)}
        >
          <PlayCircle className="h-3.5 w-3.5 text-red-500" />
          Watch Tutorial
        </Button>
      </div>

      {/* ─── Workflow tabs ─── */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border bg-card px-2 pt-1.5">
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {workflows.map((wf) => {
            const isActive = wf.id === activeWfId
            const isRenaming = renamingWfId === wf.id
            return (
              <div
                key={wf.id}
                onClick={() => setActiveWfId(wf.id)}
                onDoubleClick={() => startRenameWorkflow(wf)}
                className={`group flex h-8 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs transition-colors ${
                  isActive
                    ? "border-border bg-background font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                }`}
              >
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={finishRenameWorkflow}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") finishRenameWorkflow()
                      if (e.key === "Escape") setRenamingWfId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-28 bg-transparent text-xs outline-none"
                  />
                ) : (
                  <span className="truncate" title="Double-click to rename">{wf.name}</span>
                )}
                {workflows.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeWorkflow(wf.id)
                    }}
                    className="hidden h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-destructive hover:text-destructive-foreground group-hover:flex"
                    title="Close workflow"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            )
          })}
          <button
            type="button"
            onClick={createWorkflow}
            className="ml-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title="New workflow"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ─── Toolbar ─── */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        <Button size="sm" variant="default" className="h-8" onClick={() => setImportOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          Add Node
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={autoLayout}>
          <LayoutGrid className="mr-1 h-4 w-4" />
          Auto Layout
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={clearCanvas}
            disabled={modelNodeCount === 0 && connections.length === 0}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Import dialog (trigger hidden — opened via controlled state) */}
      <div className="hidden">
        <ImportModelDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          onImport={(cfg) => {
            if (cfg?.nodeType) addNode(cfg.nodeType)
          }}
        />
      </div>

      <Dialog open={!!forceOverrideDialog} onOpenChange={(open) => {
        if (!open) settleWorkflowForceOverride(false)
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Force Override Workflow?
            </DialogTitle>
            <DialogDescription className="text-xs">
              A workflow is currently marked as running, queued, or cancelling. This can happen when the queue gets stuck.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Force override clears TissueLab&apos;s scheduler/queue state for your active workflow and starts this run again. It does not kill the TaskNode process, so only use this when you believe the queue state is stale or stuck.
          </div>
          {forceOverrideDialog?.message && (
            <p className="break-words text-[11px] text-muted-foreground">{forceOverrideDialog.message}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => settleWorkflowForceOverride(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => settleWorkflowForceOverride(true)}>
              Force Override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WorkflowBatchDialog
        open={batchDialogOpen}
        onOpenChange={setBatchDialogOpen}
        files={batchCandidateFiles}
        selectedFolder={selectedFolder}
        isRunning={isBatchRunning}
        isStopping={isStoppingWorkflow}
        activeEntry={activeBatchEntry}
        historyEntries={batchHistoryEntries}
        onStart={runWorkflowBatch}
        onStop={stopWorkflow}
        onClearHistory={clearBatchHistory}
      />

      {showBatchBanner && activeBatchEntry && (
        <div
          className={`flex flex-shrink-0 items-start gap-2 border-b px-3 py-2 text-xs ${batchBannerToneClass}`}
        >
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="min-w-0 truncate font-medium" title={batchCurrentPath || undefined}>
                {isBatchRunning ? (
                  <>
                    Batch {batchDoneCount} / {activeBatchEntry.progress.total}
                    {batchCurrentPath ? ` · ${workflowBatchBasename(batchCurrentPath)}` : ""}
                  </>
                ) : (
                  <>
                    Batch {activeBatchEntry.progress.total} file{activeBatchEntry.progress.total === 1 ? "" : "s"} ·{" "}
                    {batchBannerCompleteLabel}
                  </>
                )}
              </div>
              <div className="flex-shrink-0 text-[10px] tabular-nums">
                {isBatchRunning && activeBatchEntry.failedCount > 0
                  ? `${activeBatchEntry.failedCount} failed · `
                  : !isBatchRunning && activeBatchEntry.aggregateStatus === "partial_failure"
                    ? `${activeBatchEntry.failedCount} failed · ${activeBatchEntry.skippedCount} skipped · `
                    : ""}
                {isBatchRunning || activeBatchEntry.aggregateStatus === "running"
                  ? `${batchProgressPct}%`
                  : "100%"}
              </div>
            </div>
            <Progress
              value={isBatchRunning || activeBatchEntry.aggregateStatus === "running" ? batchProgressPct : 100}
              className={batchProgressBarClass}
            />
          </div>
          {!isBatchRunning && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 flex-shrink-0 text-current opacity-70 hover:opacity-100"
              aria-label="关闭批次进度"
              onClick={() => setBatchBannerDismissed(true)}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      <WorkflowGraphCanvas
        canvasRef={canvasRef}
        contentWrapperRef={contentWrapperRef}
        panOffsetRef={panOffsetRef}
        connectingState={connectingState}
        isPanning={isPanning}
        intentPromptOpen={intentPromptOpen}
        intentText={intentText}
        workflowStatus={workflowStatus}
        queuePosition={queuePosition}
        queueTotal={queueTotal}
        modelNodeCount={modelNodeCount}
        wrapperW={wrapperW}
        wrapperH={wrapperH}
        yScale={yScale}
        canvasSize={canvasSize}
        panOffset={panOffset}
        connections={connections}
        nodes={nodes}
        selectedId={selectedId}
        runningId={runningId}
        clickedConn={clickedConn}
        dragging={dragging}
        isRunning={isRunning}
        isBatchRunning={isBatchRunning}
        isStoppingWorkflow={isStoppingWorkflow}
        graphCodingRunNodeId={graphCodingRunNodeId}
        completedIds={completedIds}
        runtimeNodeProgressById={runtimeNodeProgressById}
        runtimeNodeSubStagesById={runtimeNodeSubStagesById}
        graphNodeStatusMap={graphNodeStatusMap}
        getPortPos={getPortPos}
        ensureLegacyPanel={ensureLegacyPanel}
        runtimeKeyCandidates={runtimeKeyCandidates}
        firstNumericRuntimeValue={firstNumericRuntimeValue}
        handleCanvasMouseDown={handleCanvasMouseDown}
        handleCanvasMouseMove={handleCanvasMouseMove}
        handleCanvasMouseUp={handleCanvasMouseUp}
        setClickedConn={setClickedConn}
        dismissIntentPrompt={dismissIntentPrompt}
        setIntentText={setIntentText}
        submitIntentPrompt={submitIntentPrompt}
        stopWorkflow={stopWorkflow}
        runWorkflow={runWorkflow}
        openBatchDialog={() => setBatchDialogOpen(true)}
        deleteConnection={deleteConnection}
        handleNodeMouseDown={handleNodeMouseDown}
        handleNodeDoubleClick={handleNodeDoubleClick}
        handleOutputPortMouseDown={handleOutputPortMouseDown}
        handleInputPortMouseUp={handleInputPortMouseUp}
        deleteNode={deleteNode}
        runOneNode={runOneNode}
      />

      <WorkflowGraphBottomDock
        bottomPanelRef={bottomPanelRef}
        dockStripRef={dockStripRef}
        bottomMode={bottomMode}
        sheetAnimPx={sheetAnimPx}
        expandedHeight={expandedHeight}
        isResizing={isResizing}
        handleBottomPanelTransitionEnd={handleBottomPanelTransitionEnd}
        beginResize={beginResize}
        togglePane={togglePane}
        startBottomPanelClose={startBottomPanelClose}
        handleGeneratedWorkflow={handleGeneratedWorkflow}
        selectedNode={selectedNode}
        runningId={runningId}
        isRunning={isRunning}
        stopWorkflow={stopWorkflow}
        runStage={runStage}
        runOneNode={runOneNode}
        graphStartWorkflow={startWorkflow}
        openNodeLogs={openNodeLogs}
        openClassifierSave={openClassifierSave}
        openClassifierLoad={openClassifierLoad}
        openActiveLearning={openActiveLearning}
        setClassifierMode={setClassifierMode}
        clearLoadedClassifier={clearLoadedClassifier}
        ensureLegacyPanel={ensureLegacyPanel}
        handleLegacyPanelChange={handleLegacyPanelChange}
        updateNodeField={updateNodeField}
        firstNumericRuntimeValue={firstNumericRuntimeValue}
        runtimeKeyCandidates={runtimeKeyCandidates}
        graphNodeStatusMap={graphNodeStatusMap}
        graphCodingRunNodeId={graphCodingRunNodeId}
        setGraphCodingRunNodeId={setGraphCodingRunNodeId}
        configTab={configTab}
        setConfigTab={setConfigTab}
      />

      <WorkflowGraphDialogs
        logDialogOpen={logDialogOpen}
        setLogDialogOpen={setLogDialogOpen}
        selectedLogTarget={selectedLogTarget}
        saveDialogOpen={saveDialogOpen}
        setSaveDialogOpen={setSaveDialogOpen}
        saveForm={saveForm}
        setSaveForm={setSaveForm}
        submitSave={submitSave}
        activeWf={activeWf}
        classifierSaveOpen={classifierSaveOpen}
        setClassifierSaveOpen={setClassifierSaveOpen}
        classifierSaveForm={classifierSaveForm}
        setClassifierSaveForm={setClassifierSaveForm}
        classifierContextNodeId={classifierContextNodeId}
        submitClassifierSave={submitClassifierSave}
        classifierLoadOpen={classifierLoadOpen}
        setClassifierLoadOpen={setClassifierLoadOpen}
        classifierLoadSearch={classifierLoadSearch}
        setClassifierLoadSearch={setClassifierLoadSearch}
        communityClassifiers={communityClassifiers}
        communityClassifiersLoading={communityClassifiersLoading}
        folderClassifiers={folderClassifierOptions}
        folderClassifiersScanPath={classifierListingFolder}
        loadClassifierIntoNode={loadClassifierIntoNode}
        tutorialOpen={tutorialOpen}
        setTutorialOpen={setTutorialOpen}
        loadDialogOpen={loadDialogOpen}
        setLoadDialogOpen={setLoadDialogOpen}
        loadSearch={loadSearch}
        setLoadSearch={setLoadSearch}
        communityWorkflows={communityWorkflows}
        communityWorkflowsLoading={communityWorkflowsLoading}
        savedList={savedList}
        handleLoadCommunityWorkflow={handleLoadCommunityWorkflow}
        handleLoadFromStorage={handleLoadFromStorage}
        handleDeleteSaved={handleDeleteSaved}
        handleImportFile={handleImportFile}
        handleExportFile={handleExportFile}
      />
    </div>
  )
}

export default WorkflowGraph
