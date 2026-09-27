"use client"

import { denyWriteToast, usePathWriteAccess } from "@/hooks/usePathWriteAccess"
import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ImportModelDialog } from "@/components/imageViewer/sidebar/agent/workflow/ImportModelDialog"
import type { GeneratedWorkflowStep } from "@/components/imageViewer/sidebar/agent/chat/Chatbox"
import {
  removeClassifierPathContent,
  upsertContentStringValue,
} from "@/utils/agent/workflow/panelContent"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { AlertTriangle, FolderOpen, Info, LayoutGrid, ListChecks, Loader2, Play, PlayCircle, Plus, Save, Square, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { type CommunityWorkflow } from "@/constants/communityWorkflowsDefault"
import { CHILD_TO_PARENT } from "@/constants/workflow.constants"
import { pickNucleiClassificationNode } from "@/utils/annotations/nucleiClassList"
import { useCommunityWorkflowsPresets } from "@/hooks/workflow/useCommunityWorkflowsPresets"
import { classifiersService } from "@/services/classifier/community"
import { registerCommunityWorkflow, type RegisterCommunityWorkflowPayload } from "@/services/communityWorkflows.service"
import {
  extractClassifierPathRefs,
  findUnresolvedCommunityClassifierRefs,
  rewriteClassifierPathsInPanelStates,
  rewriteLoadedClassifierPathsInNodes,
  rewriteLoadedClassifierRefsToLocalInNodes,
  rewriteCommunityRefsToLocalPaths,
  stripContentKeysInPanelStates,
  type ClassifierPathRef,
} from "@/utils/agent/workflow/publishScan"
import { uploadFiles, createDownloadLink, downloadFileDirect } from "@/services/fileManager.service"
import { useUserInfo } from "@/contexts/UserInfoProvider"
import { COMMUNITY_API_ENDPOINT } from "@/config/api.config"
import eventBus from "@/utils/common/eventBus"
import { formatPath } from "@/utils/common/path.utils"
import { sanitizeFilename } from "@/utils/common/string.utils"
import { saveClassifierFileOnServer, getClassifierInheritFrom } from "@/services/classifier/storage"
import {
  graphClassifierTasknodePersistModelName,
  normalizePathForSegClassifierApi,
} from "@/utils/agent/graph/classifierExport"
import { useWorkflowRuntimeStatus, type WorkflowCompletionResult } from "@/hooks/workflow/useWorkflowRuntimeStatus"
import { apiFetch, ApiError } from "@/utils/common/apiFetch"
import { getZarrStructure, type ZarrStructure } from "@/services/data.service"
import {
  dismissWorkflowBatchRuntimeEntry,
  getWorkflowBatchRuntimeSnapshot,
  requestStopWorkflowBatch,
  submitWorkflowBatch,
  subscribeWorkflowBatchRuntime,
} from "@/services/workflowBatchRuntime.service"
import { Progress } from "@/components/ui/progress"
import { useDispatch, useSelector } from "react-redux"
import { useActiveSlidePath } from "@/utils/viewer/slidePath";
import { AppDispatch, RootState, store } from "@/store"
import { setMessages, type ChatMessage } from "@/store/slices/chat/chatSlice"
import useRootStore from "@/store/zustand/store"
import { selectPatchClassificationData, setNucleiClasses, setPatchClassificationData, type AnnotationClass, type PatchClassificationData } from "@/store/slices/viewer/annotationSlice"
import { setShapeData, type ShapeData } from "@/store/slices/viewer/shapeSlice"
import { resetWorkflowStatus, setWorkflowCompletionHints, setUpdateClassifier, setUpdateAfterEveryAnnotation, setUpdatePatchAfterEveryAnnotation, setWorkflowStageProgress } from "@/store/slices/chat/workflowSlice"
import { setSelectedModelForPath, clearSelectedModelForPath } from "@/store/slices/chat/modelSelectionSlice"
import {
  buildStartWorkflowPayload,
  type BuildWorkflowPayloadContext,
} from "@/utils/agent/workflow/buildStartPayload"
import { augmentPanelsWithPrereqs } from "@/utils/agent/workflow/prereqPanels"
import {
  buildTaskDependenciesFromTopo,
  disconnectedModelNodeIds,
  modelNodeIdsOutsideStartEndPath,
  topoSortModelNodesForRun,
} from "@/utils/agent/workflow/graphTopo"
import {
  resetWorkflowBeforeStart,
  prepareAndStartClassificationWorkflow,
  peekNucleiClassOperations,
  peekPatchClassOperations,
  clearNucleiClassOperations,
  clearPatchClassOperations,
  injectClassifierSaveIntoPayload,
} from "@/utils/agent/workflow/workflow.utils"
import { toLocalWorkflowZarrPath, toWorkflowZarrPath, workflowZarrPathsMatch } from "@/utils/agent/workflow/pathNorm"
import {
  digestScriptSource,
  getScriptRunPolicy,
  mergePanelContentWithFactoryDefaults,
  SCRIPT_LAST_RUN_DIGEST_KEY,
  SCRIPT_LAST_RUN_OUTPUT_KEY,
  SCRIPT_LAST_RUN_RAW_OUTPUT_KEY,
} from "@/utils/agent/workflow/codingPolicy"
import { persistCodingAgentGeneratedScript } from "@/utils/agent/workflow/persistScript"
import { runCodingAgentScriptChain } from "@/utils/agent/workflow/runScriptChain"
import { WORKFLOW_CODING_SCRIPT_READY_EVENT } from "@/utils/agent/workflow/completionSideEffects"
import {
  isSerializedWorkflow,
  loadAllSavedWorkflows as loadAllSaved,
  readWorkflowGraphSessionDraft,
  writeWorkflowGraphSessionDraft,
  writeAllSavedWorkflows as writeAllSaved,
  notifyWorkflowLocalStorageChanged,
  type SerializedWorkflow,
  type SerializedWorkflowRuntimeContext,
  type WorkflowGraphSessionDraftV1,
  WORKFLOW_GRAPH_SAVED_STORAGE_KEY,
  WORKFLOW_LOCAL_STORAGE_CHANGED_EVENT,
} from "@/utils/agent/workflow/serializedWorkflow"

import { WorkflowGraphBottomDock } from "@/components/imageViewer/sidebar/agent/graph/WorkflowGraphBottomDock"
import { WorkflowBatchDialog } from "@/components/imageViewer/sidebar/agent/graph/WorkflowBatchDialog"
import { WorkflowGraphCanvas } from "@/components/imageViewer/sidebar/agent/graph/WorkflowGraphCanvas"
import { WorkflowGraphDialogs } from "@/components/imageViewer/sidebar/agent/graph/WorkflowGraphDialogs"
import { isWSI } from "@/utils/dashboard/fileType.utils"
import { isCodingAgentGenerationFailureAnswer, looksLikeCodingAgentGeneratedScript } from "@/utils/agent/graph/codingGuards"
import {
  folderClassifierOptionsFromFileList,
  loadAllClassifiers,
  remoteClassifierToOption,
  writeAllClassifiers,
} from "@/utils/agent/graph/classifiers"
import {
  COMMUNITY_CLASSIFIERS_FALLBACK,
  CODING_GRAPH_MODEL_ID,
  END_NODE_ID,
  MODEL_SUBSTAGES,
  NODE_H,
  NODE_W,
  isCellSegModelId,
  isNucleiClassifyModelId,
  isTissueClassifyModelId,
  registryNodes,
  RUNTIME_SUBSTAGE_FROM_TEMPLATE_IDS,
  START_NODE_ID,
  TERMINAL_SIZE,
} from "@/utils/agent/graph/constants"
import { workflowGraphPayloadBounds } from "@/utils/agent/graph/bboxFromShape"
import {
  computeWorkflowContentBounds,
  computeWorkflowYScale,
  getWorkflowGraphPortPosition,
  screenPointToLogicalCanvas,
} from "@/utils/agent/graph/canvasGeometry"
import { buildGeneratedWorkflowChainLayout, layoutChainVertically, layoutChainHorizontally } from "@/utils/agent/graph/chainLayout"
import WorkflowChainStrip from "@/components/imageViewer/sidebar/agent/graph/WorkflowChainStrip"
import { collectPanelStatesSnapshot } from "@/utils/agent/graph/panel"
import {
  createInitialSubStages,
  getInitialModelProgress,
  initialNodes,
  newWorkflow,
  nodeHeight,
  nodeWidth,
  normalizeWorkflowGraphNodes,
  pickPatchClassificationNode,
  sseOverallToSegEmbBars,
} from "@/utils/agent/graph/graphNode"
import {
  buildLegacyPanelFromNode,
  mergeGraphPanelClassifierPathsFromRedux,
  resolveLegacyPanelForNode,
} from "@/utils/agent/graph/legacyPanel"
import { expandRuntimeStatusNodeKeys } from "@/utils/agent/graph/registryRuntime"
import { firstNumericRuntimeValue, mergePreProcessedSubstages, normalizeWorkflowRuntimeMap, resolveLiveOrStickyProgress } from "@/utils/agent/graph/runtime.utils"
import { isWorkflowRuntimeActive } from "@/utils/agent/workflow/runtimeStatus"
import {
  clearWorkflowBatchHistory,
  createWorkflowBatchHistoryEntry,
  loadWorkflowBatchHistory,
  type WorkflowBatchFile,
  type WorkflowBatchHistoryEntry,
  type WorkflowBatchSourceMode,
  workflowBatchBasename,
} from "@/utils/agent/graph/workflowBatchHistory"
import type {
  ClassifierSource,
  CommunityClassifierOption,
  GraphConnection,
  GraphNode,
  PortSide,
  SubStage,
  Workflow,
} from "@/types/graph.types"
import { sortFileTreeData } from "@/utils/dashboard/fileManager.utils"
import type { FileTreeNode } from "@/types/fileManager.types"

type BottomMode = "none" | "chat" | "config"
const FORCE_OVERRIDE_CANCELLED = "__workflow_force_override_cancelled__"

// loadedClassifier.name is consumed by BottomDock + ClassifierStatusBanner as a
// display label. We keep it equal to the on-disk basename of the path so the
// graph card and the panel banner agree, and so community uploads don't sneak a
// "title" into a field documented as the file name. Falls back to the supplied
// label only when there's literally no path (shouldn't happen post-load).
const deriveBasenameForLoadedClassifier = (path: string | undefined, fallback: string): string => {
  const p = (path || "").replace(/\\/g, "/").trim()
  if (!p) return fallback
  const idx = p.lastIndexOf("/")
  return idx >= 0 ? p.slice(idx + 1) : p
}

// One annotated region in a publish conflict: the drawn contour (`vertices`, WSI
// pixel coords) plus provenance. Rendered as a small normalized contour thumbnail
// (no WSI pixels — the current version's regions are on other users' private slides).
type ConflictRegion = {
  image_name?: string
  annotator?: string
  bbox?: number[] | null
  vertices?: number[][] | null
}

/** Diagonal-lattice fill patterns (one per tone), defined once and referenced by
 *  every ContourThumb via `url(#…)`. Kept in a zero-size svg so the ids exist in
 *  the document. userSpaceOnUse + the fixed 0–100 thumb space = consistent grid
 *  density across all thumbnails regardless of the region's real pixel size. */
function ConflictContourDefs() {
  return (
    <svg width={0} height={0} className="absolute" aria-hidden="true">
      <defs>
        {(["you", "current"] as const).map((tone) => {
          const c = tone === "you" ? "hsl(var(--primary))" : "hsl(var(--destructive))"
          return (
            <pattern
              key={tone}
              id={tone === "you" ? "wg-hatch-you" : "wg-hatch-current"}
              width={7}
              height={7}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width={7} height={7} fill={c} fillOpacity={0.07} />
              <path d="M0 0 V7 M0 0 H7" stroke={c} strokeWidth={1.4} strokeOpacity={0.5} fill="none" />
            </pattern>
          )
        })}
      </defs>
    </svg>
  )
}

/** A single region's contour, normalized into a fixed 0–100 box and filled with a
 *  diagonal lattice. `tone` colors it to match the dialog: "you" = primary,
 *  "current" = destructive. */
function ContourThumb({ region, tone }: { region: ConflictRegion; tone: "you" | "current" }) {
  const stroke = tone === "you" ? "hsl(var(--primary))" : "hsl(var(--destructive))"
  const fillId = tone === "you" ? "wg-hatch-you" : "wg-hatch-current"
  const title = [region.image_name, region.annotator].filter(Boolean).join(" · ") || undefined
  const v = region.vertices
  if (!Array.isArray(v) || v.length < 2) {
    // Older classifiers (saved before contours were embedded) have no vertices.
    return (
      <div
        className="flex h-14 w-14 shrink-0 items-center justify-center rounded border border-dashed border-border bg-muted/30 text-[9px] text-muted-foreground"
        title={title}
      >
        no shape
      </div>
    )
  }
  // Map the polygon into a fixed 0–100 box (centered, aspect-preserved, padded) so
  // every thumb shares one coordinate space — the lattice pattern then reads the
  // same on all of them.
  const xs = v.map((p) => p[0])
  const ys = v.map((p) => p[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const w = Math.max(1, Math.max(...xs) - minX)
  const h = Math.max(1, Math.max(...ys) - minY)
  const S = 100
  const pad = 12
  const scale = (S - 2 * pad) / Math.max(w, h)
  const offX = (S - w * scale) / 2
  const offY = (S - h * scale) / 2
  const points = v
    .map((p) => `${((p[0] - minX) * scale + offX).toFixed(1)},${((p[1] - minY) * scale + offY).toFixed(1)}`)
    .join(" ")
  return (
    <svg
      viewBox={`0 0 ${S} ${S}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-14 w-14 shrink-0 rounded border border-border bg-muted/20"
    >
      {title ? <title>{title}</title> : null}
      <polygon
        points={points}
        fill={`url(#${fillId})`}
        stroke={stroke}
        strokeWidth={1.4}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** A labeled, horizontally-scrollable strip of contour thumbnails for one side
 *  of a conflict. Caps the rendered thumbs and shows "+N more" from `total`. */
function ContourStrip({
  label,
  tone,
  regions,
  total,
}: {
  label: string
  tone: "you" | "current"
  regions?: ConflictRegion[]
  total?: number
}) {
  const list = regions ?? []
  if (list.length === 0) return null
  const extra = Math.max(0, (total ?? list.length) - list.length)
  // No contours at all (pre-vertices classifier) → degrade to a compact text list
  // of the source slides instead of a row of empty "no shape" boxes.
  const hasAnyShape = list.some((r) => Array.isArray(r.vertices) && r.vertices.length >= 2)
  if (!hasAnyShape) {
    const imgs = Array.from(new Set(list.map((r) => r.image_name).filter(Boolean) as string[]))
    return (
      <div className="mt-1 text-[10px] text-muted-foreground">
        <span className="font-medium uppercase tracking-wide">{label}</span>
        {imgs.length > 0 && (
          <span className="ml-1">— {imgs.slice(0, 5).join(", ")}{imgs.length > 5 ? " …" : ""}</span>
        )}
        {extra > 0 && <span className="ml-1">(+{extra} more)</span>}
      </div>
    )
  }
  return (
    <div className="mt-1.5">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {list.map((r, i) => (
          <ContourThumb key={i} region={r} tone={tone} />
        ))}
        {extra > 0 && (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded border border-border bg-muted/30 text-[10px] text-muted-foreground">
            +{extra}
          </div>
        )}
      </div>
    </div>
  )
}

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

  // Set by createWorkflow so the new-workflow reset effect (declared further
  // down, after dispatch + runtime state setters) can wipe SSE-driven Redux
  // status + local runtime maps on the next activeWfId change.
  const pendingNewWorkflowResetRef = useRef(false)

  // ─── Workflow tab actions ───
  const createWorkflow = useCallback(() => {
    // Name as the smallest positive N where "Workflow N" isn't already taken.
    // workflows.length + 1 collides after a delete (e.g. delete Workflow 1
    // when Workflow 2 exists → length=1 → name "Workflow 2" duplicates).
    // Renamed tabs that don't match /^Workflow \d+$/ are ignored for collision.
    const used = new Set<number>()
    for (const w of workflows) {
      const m = /^Workflow (\d+)$/.exec(w.name)
      if (m) used.add(Number(m[1]))
    }
    let n = 1
    while (used.has(n)) n += 1
    const name = `Workflow ${n}`
    const wf = newWorkflow(name)
    setWorkflows((wfs) => [...wfs, wf])
    setActiveWfId(wf.id)
    setBottomMode("chat")
    setIntentPromptOpen(false)
    setIntentText("")
    pendingNewWorkflowResetRef.current = true
  }, [workflows])

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
  const { userInfo } = useUserInfo()
  const currentPath = useActiveSlidePath();
  const selectedFolder = useSelector((state: RootState) => state.fileManager.selectedFolder)
  const { assertWritable, allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(currentPath || selectedFolder)
  const fileList = useSelector((state: RootState) => state.fileManager.fileList)
  const sortConfig = useSelector((state: RootState) => state.fileManager.sortConfig)
  const isWebMode = useSelector((state: RootState) => {
    const id = state.wsi.activeInstanceId
    const activeInstance = id ? state.wsi.instances[id] : undefined
    const source = activeInstance?.fileInfo?.source as string | undefined
    return source === "web"
  })
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
      if (isWebMode) {
        const idx = norm.lastIndexOf("/")
        folder = idx > 0 ? norm.slice(0, idx) : norm
      } else {
        const sep = norm.includes("\\") ? "\\" : "/"
        const idx = norm.lastIndexOf(sep)
        folder = idx > 0 ? norm.slice(0, idx) : norm
      }
    }
    return folder
  }, [selectedFolder, currentPath, isWebMode])

  const folderClassifierOptions = useMemo(
    () => folderClassifierOptionsFromFileList(fileList, classifierListingFolder, isWebMode),
    [fileList, classifierListingFolder, isWebMode]
  )

  const batchCandidateFiles = useMemo<WorkflowBatchFile[]>(() => {
    // Sort with the same sortConfig the dashboard list uses so the batch
    // dialog presents files in the order the user just verified in the
    // dashboard — otherwise selecting by row position would mismatch.
    const wsis = fileList.filter((file) => !file.is_dir && isWSI(file.name))
    const sorted = sortFileTreeData(wsis as unknown as FileTreeNode[], sortConfig) as unknown as typeof wsis
    const candidates = sorted.map((file) => ({ name: file.name, path: formatPath(file.path) }))
    if (candidates.length > 0) return candidates
    const formatted = formatPath(currentPath ?? "")
    return formatted ? [{ name: workflowBatchBasename(formatted), path: formatted }] : []
  }, [currentPath, fileList, sortConfig])

  const [batchHistoryEntries, setBatchHistoryEntries] = useState<WorkflowBatchHistoryEntry[]>(() =>
    typeof window === "undefined" ? [] : loadWorkflowBatchHistory()
  )

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
    fetchWorkflowStageStatus,
    restoreCurrentWorkflowStatus,
  } = useWorkflowRuntimeStatus()
  const deferredNodeStatus = useDeferredValue(nodeStatus)

  const batchRuntime = useSyncExternalStore(
    subscribeWorkflowBatchRuntime,
    getWorkflowBatchRuntimeSnapshot,
    getWorkflowBatchRuntimeSnapshot
  )
  const isBatchRunning = batchRuntime.isRunning
  const activeBatchEntry = batchRuntime.entry
  const [isBatchPreparing, setIsBatchPreparing] = useState(false)

  useEffect(() => {
    setBatchHistoryEntries(loadWorkflowBatchHistory())
  }, [activeBatchEntry])

  // Batch is orchestrated on the server (no FE startWorkflow), so re-attach SSE
  // whenever the active batch file changes.
  useEffect(() => {
    if (!isBatchRunning) return
    void restoreCurrentWorkflowStatus()
  }, [
    isBatchRunning,
    activeBatchEntry?.progress.currentIndex,
    activeBatchEntry?.progress.currentPath,
    restoreCurrentWorkflowStatus,
  ])

  // ─── Run state (visual highlight on top of runtime status) ───
  const [runningId, setRunningId] = useState<string | null>(null)
  const runningIdRef = useRef<string | null>(null)
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())
  const [runtimeNodeProgressById, setRuntimeNodeProgressById] = useState<Record<string, number>>({})
  const [runtimeNodeSubStagesById, setRuntimeNodeSubStagesById] = useState<Record<string, SubStage[]>>({})
  const runtimeNodeSubStagesByIdRef = useRef<Record<string, SubStage[]>>({})
  useEffect(() => {
    runtimeNodeSubStagesByIdRef.current = runtimeNodeSubStagesById
  }, [runtimeNodeSubStagesById])
  const runAbortRef = useRef(false)
  // One-vs-rest Save: {class: path} keyed by nodeId. Injected at run start so
  // ClassificationPanel content-sync cannot clobber paths before the payload is built.
  const ovrSavePathsRef = useRef<Record<string, Record<string, string>>>({})
  const [batchDialogOpen, setBatchDialogOpen] = useState(false)
  const [isStoppingWorkflowLocal, setIsStoppingWorkflowLocal] = useState(false)
  const isStoppingWorkflow = isStoppingWorkflowLocal || batchRuntime.isStopping
  const forceOverrideResolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  const [forceOverrideDialog, setForceOverrideDialog] = useState<{ message: string } | null>(null)
  /** Last node id that had runtime status "running" (1) — only auto-select when this changes, so users can open other nodes' config during a long run. */
  const prevWorkflowRunnerNodeIdRef = useRef<string | null>(null)
  const prevRuntimeActiveRef = useRef(false)
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

  // Run-once on activeWfId change when createWorkflow flagged a brand-new tab:
  // wipe SSE-driven Redux runtime status + local graph maps so the empty new
  // workflow doesn't carry over finished bars / running marker from the
  // previously-active workflow tab.
  useEffect(() => {
    if (!pendingNewWorkflowResetRef.current) return
    pendingNewWorkflowResetRef.current = false
    dispatch(resetWorkflowStatus())
    setRuntimeNodeProgressById({})
    runtimeNodeSubStagesByIdRef.current = {}
    setRuntimeNodeSubStagesById({})
    setCompletedIds(new Set())
    setRuntimeRunningId(null)
  }, [activeWfId, dispatch, setRuntimeRunningId])

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
    return toLocalWorkflowZarrPath(currentPath)
  }, [currentPath])

  /**
   * Idle-only: fill `preProcessed` substages from backend stage_progress so an
   * already-processed slide shows prereq bars as done (same mapping as live SSE).
   */
  const refreshPreProcessedSubstages = useCallback(async () => {
    if (isRunning || workflowStatus !== "idle") return
    const zarrPath = getWorkflowZarrPath()
    if (!zarrPath) return
    const multiStageNodes = activeWf.nodes.filter(
      (n): n is GraphNode & { modelId: string } =>
        n.kind === "model" && !!n.modelId && RUNTIME_SUBSTAGE_FROM_TEMPLATE_IDS.has(n.modelId)
    )
    if (multiStageNodes.length === 0) return
    try {
      const result = await fetchWorkflowStageStatus(
        zarrPath,
        multiStageNodes.map((n) => ({ model: n.modelId }))
      )
      const stageProgress =
        result && typeof result === "object" && result.stage_progress && typeof result.stage_progress === "object"
          ? (result.stage_progress as Record<string, Record<string, number>>)
          : {}
      if (Object.keys(stageProgress).length > 0) {
        dispatch(setWorkflowStageProgress(stageProgress))
      }

      const breakdownForModel = (modelId: string) => {
        for (const key of expandRuntimeStatusNodeKeys(modelId)) {
          const sp = stageProgress[key]
          if (sp && typeof sp === "object" && Object.keys(sp).length > 0) return sp
        }
        return undefined
      }

      const statusMap = normalizeWorkflowRuntimeMap(store.getState().workflow.nodeStatus, "node_status")
      const progressMap = normalizeWorkflowRuntimeMap(store.getState().workflow.nodeProgress, "node_progress")

      setRuntimeNodeSubStagesById((prev) => {
        let changed = false
        const next = { ...prev }
        for (const node of multiStageNodes) {
          const template = MODEL_SUBSTAGES[node.modelId]
          if (!template?.length) continue
          // Start from a fresh zeroed template for preProcessed mapping — classification
          // / rerunnable bars are preserved from `prev` inside mergePreProcessedSubstages
          // so a just-finished .tlcls run is not wiped back to Pending.
          const fresh =
            createInitialSubStages(node.modelId) ??
            node.subStages?.map((s) => ({ ...s, progress: 0 })) ??
            null
          if (!fresh?.length) continue
          const breakdown = breakdownForModel(node.modelId)
          const keys = expandRuntimeStatusNodeKeys(node.modelId)
          const status = firstNumericRuntimeValue(keys.map((k) => statusMap?.[k]))
          const progress = firstNumericRuntimeValue(keys.map((k) => progressMap?.[k]))
          const nodeTerminalDone = status === 2 || progress === 100
          // Mid-run: keep in-flight local bars as the previous snapshot for merge.
          const previous = isRunning ? (next[node.id] ?? prev[node.id]) : prev[node.id]
          const patched = mergePreProcessedSubstages({
            template,
            fresh,
            previous,
            breakdown,
            nodeTerminalDone,
          })
          if (!patched) continue
          const prevStages = next[node.id]
          const sameAsPrev =
            !!prevStages &&
            patched.length === prevStages.length &&
            patched.every(
              (s, idx) =>
                s.key === prevStages[idx]?.key &&
                s.label === prevStages[idx]?.label &&
                s.progress === prevStages[idx]?.progress
            )
          if (!sameAsPrev) {
            next[node.id] = patched
            changed = true
          }
        }
        return changed ? next : prev
      })
    } catch {
      // best effort
    }
  }, [
    activeWf.nodes,
    dispatch,
    fetchWorkflowStageStatus,
    getWorkflowZarrPath,
    isRunning,
    workflowStatus,
  ])

  useEffect(() => {
    void refreshPreProcessedSubstages()
  }, [refreshPreProcessedSubstages])

  // Switching slides must drop sticky local bars AND Redux stage/progress from the
  // previous zarr. Same-slide re-runs (Update / Run) keep Done bars until the next
  // live SSE tick — only an image change resets them here (batch file hops also reset).
  const prevSlidePathForProgressRef = useRef<string | null>(null)
  useEffect(() => {
    const path = currentPath ?? null
    if (prevSlidePathForProgressRef.current === null) {
      prevSlidePathForProgressRef.current = path
      return
    }
    if (prevSlidePathForProgressRef.current === path) return
    prevSlidePathForProgressRef.current = path
    if (store.getState().workflow.isRunning) return
    dispatch(resetWorkflowStatus())
    resetAllGraphProgress()
  }, [currentPath, dispatch, resetAllGraphProgress])

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
      // Do not wipe graph bars here — same-slide re-runs should keep Done until
      // live SSE updates them. Bars reset only on slide switch (and batch file change).
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

  /**
   * Classification / Patch panel Update buttons call this via `graphStartWorkflow`.
   * Local progress bars are not cleared here — only switching slides resets them.
   */
  const startWorkflowFromPanel = useCallback(
    async (payload: Record<string, unknown>) => {
      return startWorkflow(payload)
    },
    [startWorkflow]
  )

  const stopWorkflow = useCallback(async () => {
    if (isStoppingWorkflow) return
    if (isBatchRunning) {
      try {
        await requestStopWorkflowBatch()
      } catch {
        toast.error("Failed to stop batch.")
      }
      return
    }
    setIsStoppingWorkflowLocal(true)
    const zarrPath = runningWorkflowZarrPath || getWorkflowZarrPath()
    if (!zarrPath) {
      setIsStoppingWorkflowLocal(false)
      return
    }
    runAbortRef.current = true
    // Hook owns AbortSignal timeout; finally unlocks Stopping UI when stop settles or throws.
    try {
      await stopWorkflowRequest(zarrPath)
      setRuntimeRunningId(null)
      toast.message("Workflow stopped")
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stop workflow."
      toast.error(message)
    } finally {
      setIsStoppingWorkflowLocal(false)
    }
  }, [getWorkflowZarrPath, isBatchRunning, isStoppingWorkflow, runningWorkflowZarrPath, setRuntimeRunningId, stopWorkflowRequest])

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
    eventBus.on("workflow-graph-run-start", onRunStart)
    return () => {
      eventBus.off("workflow-graph-run-start", onRunStart)
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
      if (!pathWritable) continue
      autoBypassAttemptedRef.current.add(attemptKey)
      codingGenReadyForAutoBypassRef.current = false

      const pe = merged.find((c: { key?: string }) => c.key === "prompt")
      const promptVal = typeof pe?.value === "string" ? pe.value : ""
      void (async () => {
        setGraphCodingRunNodeId(node.id)
        try {
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
    dispatch,
    handleLegacyPanelChange,
    currentPath,
    pathWritable,
    activeWf,
    setBottomMode,
  ])

  // Own trigger-*-update here so auto-update / classifier-save update still run when
  // the classification panel is not mounted (e.g. "Back to all models").
  // Handlers read a ref so we subscribe once — no unsubscribe/resubscribe churn when
  // bbox / classes / path change.
  const classificationTriggerCtxRef = useRef({
    nodes: activeWf.nodes,
    selectedId,
    currentPath,
    selectedFolder,
    nucleiClasses,
    currentOrgan,
    reduxPatchClassificationData,
    bboxBounds,
    shapeData,
    ensureLegacyPanel,
    getWorkflowZarrPath,
    startWorkflowFromPanel,
  })
  classificationTriggerCtxRef.current = {
    nodes: activeWf.nodes,
    selectedId,
    currentPath,
    selectedFolder,
    nucleiClasses,
    currentOrgan,
    reduxPatchClassificationData,
    bboxBounds,
    shapeData,
    ensureLegacyPanel,
    getWorkflowZarrPath,
    startWorkflowFromPanel,
  }

  useEffect(() => {
    const startClassificationUpdate = async (
      kind: "nuclei" | "patch",
      eventData?: { zarrPath?: string; saveClassifierPath?: string }
    ) => {
      const ctx = classificationTriggerCtxRef.current
      if (store.getState().workflow.isRunning) return
      if (denyWriteToast("run workflow", ctx.currentPath || ctx.selectedFolder)) {
        return
      }
      const zarrPath = ctx.getWorkflowZarrPath()
      if (!zarrPath) return
      const target = eventData?.zarrPath || ""
      if (
        target &&
        !workflowZarrPathsMatch(target, zarrPath) &&
        !workflowZarrPathsMatch(target, ctx.currentPath ?? "")
      ) {
        return
      }

      const node =
        kind === "nuclei"
          ? pickNucleiClassificationNode(ctx.nodes, ctx.selectedId)
          : pickPatchClassificationNode(ctx.nodes, ctx.selectedId)
      if (!node) {
        // Never fail silently here: this runs on every annotation when
        // "update after every annotation" is on, and a graph with no matching
        // node just looked like the checkbox did nothing. Deduped id so a burst
        // of annotations shows one message, not one per click.
        toast.message(
          kind === "patch"
            ? "No tissue model on this workflow to update."
            : "No cell classification model on this workflow to update.",
          { id: `no-${kind}-update-node` },
        )
        return
      }
      const panel = ctx.ensureLegacyPanel(node)
      if (!panel) return

      try {
        const buildCtx: BuildWorkflowPayloadContext = {
          currentPath: ctx.currentPath,
          nucleiClasses: ctx.nucleiClasses,
          currentOrgan: ctx.currentOrgan,
          reduxPatchClassificationData: ctx.reduxPatchClassificationData,
          x1: ctx.bboxBounds.x1,
          y1: ctx.bboxBounds.y1,
          x2: ctx.bboxBounds.x2,
          y2: ctx.bboxBounds.y2,
          shapeData: ctx.shapeData,
        }
        const { payload } = buildStartWorkflowPayload([panel], zarrPath, buildCtx)
        const pendingOvrSave = ovrSavePathsRef.current[node.id]
        if (pendingOvrSave && Object.keys(pendingOvrSave).length) {
          delete ovrSavePathsRef.current[node.id]
        }
        injectClassifierSaveIntoPayload(payload, {
          ovrSavePaths: pendingOvrSave,
          saveClassifierPath: eventData?.saveClassifierPath,
          updateClassifier: store.getState().workflow.updateClassifier,
        })
        const classOps =
          kind === "nuclei" ? peekNucleiClassOperations() : peekPatchClassOperations()
        if (classOps) {
          for (const key of Object.keys(payload)) {
            if (key.startsWith("step") && payload[key]?.input) {
              payload[key].input.class_operations = classOps
            }
          }
        }
        await prepareAndStartClassificationWorkflow({
          dispatch,
          startWorkflow: ctx.startWorkflowFromPanel,
          payload,
          refreshTissuePatches: kind === "patch",
        })
        if (classOps) {
          if (kind === "nuclei") clearNucleiClassOperations()
          else clearPatchClassOperations()
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start classification update."
        toast.error(message)
      }
    }

    const onNuclei = (eventData?: { zarrPath?: string; saveClassifierPath?: string }) => {
      void startClassificationUpdate("nuclei", eventData)
    }
    const onPatch = (eventData?: { zarrPath?: string; saveClassifierPath?: string }) => {
      void startClassificationUpdate("patch", eventData)
    }
    eventBus.on("trigger-nuclei-update", onNuclei)
    eventBus.on("trigger-patch-update", onPatch)
    return () => {
      eventBus.off("trigger-nuclei-update", onNuclei)
      eventBus.off("trigger-patch-update", onPatch)
    }
  }, [dispatch])

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
        orderedGraphNodes: GraphNode[]
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
      orderedGraphNodes,
    }
  }, [activeWf.connections, activeWf.nodes, ensureLegacyPanel])

  const runWorkflowBatch = useCallback(
    async (params: { files: WorkflowBatchFile[]; sourceMode: WorkflowBatchSourceMode; stopOnFirstError: boolean }) => {
      if (isBatchRunning || isRunning || isBatchPreparing) {
        toast.info("A workflow is already running.")
        return
      }
      const files = params.files.map((file) => ({ ...file, path: formatPath(file.path) })).filter((file) => file.path)
      if (files.length === 0) {
        toast.info("No files selected for batch processing.")
        return
      }
      if (files.some((file) => denyWriteToast("batch process workflow", file.path))) {
        return
      }
      const plan = buildBatchRunPlan()
      if (!plan.ok) {
        toast.error(plan.error)
        return
      }

      // Pre-flight: if any panel still carries a community:<id> classifier_path
      // it means import auto-download failed (or the classifier was deleted from
      // community after publish). The backend would just choke on the literal,
      // so block here and tell the user which node to fix.
      const unresolvedBatch = findUnresolvedCommunityClassifierRefs(plan.panelsToRun)
      if (unresolvedBatch.length > 0) {
        toast.error(
          `Cannot run batch: ${unresolvedBatch.length} classifier ref${unresolvedBatch.length === 1 ? "" : "s"} not downloaded (${unresolvedBatch.map((u) => u.displayName).join(", ")}). Open the affected node(s) and Load Classifier first.`
        )
        return
      }

      const historyBase = createWorkflowBatchHistoryEntry({
        sourceMode: params.sourceMode,
        files,
        settings: {
          stopOnFirstError: params.stopOnFirstError,
        },
      })

      setIsBatchPreparing(true)
      toast.message(`Preparing batch for ${files.length} file${files.length === 1 ? "" : "s"}…`)

      try {
        const batchItems: Array<{ path: string; zarr_path: string; payload: Record<string, unknown> }> = []
        for (const file of files) {
          const currentZarrPath = toWorkflowZarrPath(file.path)
          let structure: ZarrStructure
          try {
            structure = await getZarrStructure(currentZarrPath, "/", true, 2)
          } catch {
            // Omit unreadable / missing zarr from the runnable set
            continue
          }
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
          const { panelsToRun: filePanels, taskDeps: fileTaskDeps } = await augmentPanelsWithPrereqs(
            plan.orderedGraphNodes,
            plan.panelsToRun,
            plan.taskDeps,
            currentZarrPath,
            structure
          )
          const { payload } = buildStartWorkflowPayload(filePanels, currentZarrPath, ctx)
          if (fileTaskDeps) {
            payload.task_dependencies = fileTaskDeps
          }
          batchItems.push({ path: file.path, zarr_path: currentZarrPath, payload })
        }

        if (batchItems.length === 0) {
          setIsBatchPreparing(false)
          toast.info("No runnable files (missing zarr).")
          return
        }

        dispatch(resetWorkflowStatus())
        resetAllGraphProgress()
        await submitWorkflowBatch({
          items: batchItems,
          stopOnFirstError: params.stopOnFirstError,
          historyBase: {
            ...historyBase,
            progress: { ...historyBase.progress, total: batchItems.length },
            items: batchItems.map((item) => ({
              path: item.path,
              zarrPath: item.zarr_path,
              status: "queued",
            })),
          },
        })
        toast.message(`Batch started for ${batchItems.length} file${batchItems.length === 1 ? "" : "s"}.`)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start batch."
        toast.error(message)
      } finally {
        setIsBatchPreparing(false)
      }
    },
    [
      activeWf.name,
      activeWf.nodes,
      bboxBounds,
      buildBatchRunPlan,
      currentOrgan,
      dispatch,
      isBatchPreparing,
      isBatchRunning,
      isRunning,
      nucleiClasses,
      reduxPatchClassificationData,
      selectedFolder,
      resetAllGraphProgress,
      shapeData,
    ]
  )

  const runWorkflow = useCallback(async () => {
    if (isRunning || isWorkflowRuntimeActive(workflowStatus)) return
    if (!assertWritable("run workflow")) {
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

    // Auto-supply missing prerequisites — same behavior as the Pipeline "Run all"
    // on a single node, but applied across the whole graph. E.g. a lone Nuclei
    // Classification node gets its CellCast cell-seg/embedding prepended.
    const { panelsToRun: runPanels, taskDeps: runTaskDeps } = await augmentPanelsWithPrereqs(
      orderedGraphNodes,
      panelsToRun,
      taskDeps,
      zarrPath
    )

    const unresolvedRefs = findUnresolvedCommunityClassifierRefs(runPanels)
    if (unresolvedRefs.length > 0) {
      toast.error(
        `Cannot run: ${unresolvedRefs.length} classifier ref${unresolvedRefs.length === 1 ? "" : "s"} not downloaded (${unresolvedRefs.map((u) => u.displayName).join(", ")}). Open the affected node(s) and Load Classifier first.`
      )
      return
    }

    dispatch(resetWorkflowStatus())

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
    let payload: Record<string, any>
    try {
      payload = buildStartWorkflowPayload(runPanels, zarrPath, ctx).payload
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid workflow configuration.")
      return
    }
    if (runTaskDeps) {
      payload.task_dependencies = runTaskDeps
    }

    dispatch(
      setWorkflowCompletionHints({
        refreshTissuePatches: runPanels.some((p) => p.title === "Tissue Classification"),
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
    workflowStatus,
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

  /**
   * Start backend `tasks/v1/start_workflow` for a single canvas node.
   * With `includeAllSubstages` true (Pipeline-tab "Run all", canvas play
   * button), prepends the upstream backend tasks for each `preProcessed`
   * substage that is missing from the zarr so the full chain runs end-to-end —
   * a lone CytoformerClassification node gets Cytoformer seg + embedding in
   * front of it. Without it (per-substage Re-run / Run stage; Update goes
   * through startClassificationUpdate), only the selected node is sent, and a
   * missing prerequisite is reported instead of run.
   */
  const startSingleNodeWorkflow = useCallback(
    async (nodeId: string, opts: { includeAllSubstages?: boolean } = {}) => {
      if (isRunning || isWorkflowRuntimeActive(workflowStatus)) return
      if (!assertWritable("run workflow")) {
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

      // Auto-prepend the prerequisite backend steps (cell-seg + embedding, the
      // embedding/classification chain for VISTA, …) via the shared helper — same
      // rule as the graph Run button and the batch runner. Every node-run entry
      // point passes this: the helper is a no-op once the prerequisite outputs are
      // in the zarr, so it only costs anything when a step is genuinely missing,
      // or when the slot holds another model's features (Cytoformer needs its own
      // 1536-d H-optimus embeddings in the shared Cell-Segmentation/embeddings).
      // This path sequences purely by panel order (no task_dependencies override),
      // so the returned deps are unused.
      const augmented = await augmentPanelsWithPrereqs([node], [panel], undefined, zarrPath)
      if (!opts.includeAllSubstages && augmented.panelsToRun.length > 1) {
        // Re-run is this step only. Rather than let the tasknode fail with a bare
        // "embeddings not found", name what is missing and point at "Run all".
        const missing = augmented.panelsToRun
          .filter((p) => p !== panel)
          .map((p) => p.type || p.title)
          .join(", ")
        toast.error(
          `Cannot re-run ${modelId} on its own: prerequisite step(s) ${missing} have not been computed for this slide. Use "Run all" first.`
        )
        return
      }
      const panelsToRun: WorkflowPanel[] = opts.includeAllSubstages ? augmented.panelsToRun : [panel]

      setRuntimeRunningId(null)

      const unresolvedSingle = findUnresolvedCommunityClassifierRefs(panelsToRun)
      if (unresolvedSingle.length > 0) {
        toast.error(
          `Cannot run: ${unresolvedSingle.length} classifier ref${unresolvedSingle.length === 1 ? "" : "s"} not downloaded (${unresolvedSingle.map((u) => u.displayName).join(", ")}). Open the affected node(s) and Load Classifier first.`
        )
        return
      }

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
      let payload: Record<string, any>
      try {
        payload = buildStartWorkflowPayload(panelsToRun, zarrPath, ctx).payload
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Invalid workflow configuration.")
        return
      }

      dispatch(
        setWorkflowCompletionHints({
          refreshTissuePatches: panelsToRun.some((p) => p.title === "Tissue Classification"),
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
      workflowStatus,
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
      setRuntimeRunningId,
    ]
  )

  /**
   * Per-step Re-run — only wired for stages marked `rerunnable`. Runs just that
   * step's node (e.g. classification), never the pre-computed prerequisites:
   * those belong to "Run all" / Run stage, which auto-prepend what is missing.
   */
  const runStage = useCallback(
    async (nodeId: string, stageIdx: number) => {
      if (isRunning || isWorkflowRuntimeActive(workflowStatus)) return
      const node = activeWf.nodes.find((n) => n.id === nodeId)
      if (!node?.modelId) return
      const def = MODEL_SUBSTAGES[node.modelId]?.[stageIdx]
      if (!def?.rerunnable) return
      await startSingleNodeWorkflow(nodeId, { includeAllSubstages: false })
    },
    [isRunning, workflowStatus, activeWf.nodes, startSingleNodeWorkflow]
  )

  /** Active-Learning "Run stage", and the play button on a graph card. */
  const runOneNode = useCallback(
    async (nodeId: string) => {
      if (isRunning || isWorkflowRuntimeActive(workflowStatus)) return
      await startSingleNodeWorkflow(nodeId, { includeAllSubstages: true })
    },
    [isRunning, workflowStatus, startSingleNodeWorkflow]
  )

  /** Pipeline "Run all" — runs every substage in the selected node's chain. */
  const runAllSubstages = useCallback(
    async (nodeId: string) => {
      if (isRunning || isWorkflowRuntimeActive(workflowStatus)) return
      await startSingleNodeWorkflow(nodeId, { includeAllSubstages: true })
    },
    [isRunning, workflowStatus, startSingleNodeWorkflow]
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
    eventBus.on(WORKFLOW_CODING_SCRIPT_READY_EVENT, onCodingScriptReady)
    return () => {
      eventBus.off(WORKFLOW_CODING_SCRIPT_READY_EVENT, onCodingScriptReady)
    }
  }, [applyGeneratedScriptToGraphPanels])

  const sameStringSet = useCallback((a: Set<string>, b: Set<string>) => {
    if (a.size !== b.size) return false
    for (const value of a) {
      if (!b.has(value)) return false
    }
    return true
  }, [])

  useEffect(() => {
    const statusMap = normalizeWorkflowRuntimeMap(nodeStatus, "node_status")
    const progressMap = normalizeWorkflowRuntimeMap(nodeProgress, "node_progress")
    const runtimeIsActive = isRunning || isWorkflowRuntimeActive(workflowStatus)
    if (!runtimeIsActive) {
      // Keep per-node progress / substages on idle; only clear the running marker
      // on active→idle. Re-apply terminal heal while idle so late 2/100 from
      // reconcile/SSE still fills multi-stage bars (single heal path).
      const snapTerminalSubstages = () => {
        setRuntimeNodeSubStagesById((prev) => {
          let changed = false
          const next: Record<string, SubStage[]> = { ...prev }
          for (const node of activeWf.nodes) {
            if (node.kind !== "model" || !node.modelId || !node.subStages?.length) continue
            const keys = runtimeKeyCandidates(node.modelId)
            const status = firstNumericRuntimeValue(keys.map((k) => statusMap?.[k]))
            const progress = firstNumericRuntimeValue(keys.map((k) => progressMap?.[k]))
            if (status !== 2 && progress !== 100) continue
            const stages = next[node.id] ?? node.subStages
            if (!stages.some((s) => Number(s.progress || 0) < 100)) continue
            changed = true
            next[node.id] = stages.map((s) => ({ ...s, progress: 100 }))
          }
          return changed ? next : prev
        })
        setCompletedIds((prev) => {
          const next = new Set(prev)
          let changed = false
          for (const node of activeWf.nodes) {
            if (node.kind !== "model" || !node.modelId) continue
            const keys = runtimeKeyCandidates(node.modelId)
            const status = firstNumericRuntimeValue(keys.map((k) => statusMap?.[k]))
            const progress = firstNumericRuntimeValue(keys.map((k) => progressMap?.[k]))
            if (status === 2 || progress === 100) {
              if (!next.has(node.id)) {
                next.add(node.id)
                changed = true
              }
            }
          }
          return changed ? next : prev
        })
      }
      if (prevRuntimeActiveRef.current) {
        setRuntimeRunningId(null)
      }
      snapTerminalSubstages()
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
          isCellSegModelId(node.modelId) &&
          node.subStages.length === 2 &&
          node.subStages[0]?.key === "segmentation" &&
          node.subStages[1]?.key === "embedding"

        const templateStages =
          RUNTIME_SUBSTAGE_FROM_TEMPLATE_IDS.has(node.modelId) && node.modelId
            ? createInitialSubStages(node.modelId)
            : undefined
        // Active-run branch only: always seed at 0 so node.subStages / leftover
        // template progress cannot Math.max the live SSE back up to 100%.
        let nextStages = (templateStages ?? node.subStages).map((s) => ({
          ...s,
          progress: 0,
        }))

        if (isNucleiClassifyModelId(node.modelId)) {
          const segPreds = directModelPredecessors(node.id, connections, activeWf.nodes).filter((p) =>
            isCellSegModelId(p.modelId)
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
            // No NucleiSeg predecessor on canvas. Pipeline-tab "Run all" prepends a
            // synthetic cell-seg step (CellCast for NuClass, Cytoformer for
            // CytoformerClassification), so fall back to that node's SSE.
            const synthSegModelId =
              CHILD_TO_PARENT[node.modelId ?? ""]?.parentType ?? "CellCast"
            const segKeys = runtimeKeyCandidates(synthSegModelId)
            const segRunning =
              firstNumericRuntimeValue(segKeys.map((k) => statusMap?.[k])) === 1
            const synthSegState = cellSegStageState(synthSegModelId)
            nextStages[0] = {
              ...nextStages[0],
              progress: segRunning
                ? clampProgress(synthSegState.segmentation)
                : Math.max(
                    clampProgress(synthSegState.segmentation),
                    clampProgress(stageBreakdown?.segmentation)
                  ),
            }
            nextStages[1] = {
              ...nextStages[1],
              progress: segRunning
                ? clampProgress(synthSegState.embedding)
                : Math.max(
                    clampProgress(synthSegState.embedding),
                    clampProgress(stageBreakdown?.embedding)
                  ),
            }
          }
          if (nextStages.length > 2) {
            const rawClassificationProgress = typeof progress === "number" ? clampProgress(progress) : 0
            const previousClassificationProgress = runtimeNodeSubStagesByIdRef.current[node.id]?.[2]?.progress ?? 0
            const classificationProgress = resolveLiveOrStickyProgress({
              status,
              runtimeIsActive,
              liveProgress: rawClassificationProgress,
              previousProgress: previousClassificationProgress,
            })

            nextStages[2] = {
              ...nextStages[2],
              progress:
                status === 1 || runtimeIsActive
                  ? classificationProgress
                  : Math.max(previousClassificationProgress, nextStages[2].progress, classificationProgress),
            }
          }
          if (nextStages.length > 0 && nextStages.every((s) => s.progress >= 100)) {
            doneIds.add(node.id)
          }
          nextRuntimeSubStagesById[node.id] = nextStages
          continue
        }

        if (node.modelId === "VISTA") {
          // VISTA's three bars come from three different backend nodes:
          //   bar0 embedding      <- MuskEmbedding (Patch-Segmentation)
          //   bar1 classification <- MuskClassification (Patch-Classification)
          //   bar2 segmentation   <- VISTA itself
          // Prerequisites usually run synthesized (not drawn on canvas); a skipped /
          // already-done prereq never streams SSE, so once a downstream stage starts we
          // treat the upstream bars as complete.
          const readNode = (mid: string) => {
            const ks = runtimeKeyCandidates(mid)
            return {
              status: firstNumericRuntimeValue(ks.map((k) => statusMap?.[k])),
              progress: firstNumericRuntimeValue(ks.map((k) => progressMap?.[k])),
              breakdown: stageBreakdownForKeys(ks),
            }
          }
          const started = (s?: number, p?: number) =>
            s === 1 || s === 2 || (typeof p === "number" && p > 0)
          const emb = readNode("MuskEmbedding")
          const cls = readNode("MuskClassification")
          const vistaStarted = started(status, progress)
          const clsStarted = started(cls.status, cls.progress)

          // bar0 embedding — done once classification or VISTA has begun
          const embBar =
            clsStarted || vistaStarted || emb.status === 2
              ? 100
              : emb.status === 1 && typeof emb.progress === "number"
                ? clampProgress(emb.progress)
                : clampProgress(emb.breakdown?.embedding)
          nextStages[0] = { ...nextStages[0], progress: embBar }

          // bar1 classification — done once VISTA has begun; else live SSE
          const clsBar =
            vistaStarted || cls.status === 2
              ? 100
              : cls.status === 1 && typeof cls.progress === "number"
                ? clampProgress(cls.progress)
                : clampProgress(cls.breakdown?.classification)
          nextStages[1] = { ...nextStages[1], progress: clsBar }

          // bar2 segmentation — VISTA's own progress
          const prevSeg = runtimeNodeSubStagesByIdRef.current[node.id]?.[2]?.progress ?? 0
          const segBar = resolveLiveOrStickyProgress({
            status,
            runtimeIsActive,
            liveProgress: typeof progress === "number" ? clampProgress(progress) : 0,
            previousProgress: prevSeg,
          })
          nextStages[2] = {
            ...nextStages[2],
            progress:
              status === 1 || runtimeIsActive
                ? segBar
                : Math.max(prevSeg, nextStages[2].progress, segBar),
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
          // Not part of this run (classification Update / another node's Re-run):
          // keep the bars it already shows. resetWorkflowStatus cleared the zarr
          // breakdown and SSE only re-sends stage_progress for nodes in
          // node_status, so recomputing here would drop Done seg/embedding to 0.
          const prevStages = runtimeNodeSubStagesByIdRef.current[node.id]
          if (
            runtimeIsActive &&
            status === undefined &&
            typeof progress !== "number" &&
            prevStages?.length === nextStages.length
          ) {
            nextRuntimeSubStagesById[node.id] = prevStages
            continue
          }
          const zSeg = Number(stageBreakdown?.segmentation ?? 0)
          const zEmb = Number(stageBreakdown?.embedding ?? 0)
          const split = typeof progress === "number" ? sseOverallToSegEmbBars(progress) : null
          nextStages[0] = {
            ...nextStages[0],
            progress:
              status === 1 && split
                ? split.seg
                : runtimeIsActive
                  ? clampProgress(split?.seg ?? zSeg)
                  : Math.min(100, Math.max(nextStages[0].progress, zSeg, split?.seg ?? 0)),
          }
          nextStages[1] = {
            ...nextStages[1],
            progress:
              status === 1 && split
                ? split.emb
                : runtimeIsActive
                  ? clampProgress(split?.emb ?? zEmb)
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
            // Seeded at 0 above — assign mapped directly (no sticky Math.max).
            return { ...stg, progress: clampProgress(mapped) }
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
            // Actively streaming → live SSE only. Otherwise take the higher of
            // mapped stage vs overall progress for the current open substage.
            const boosted =
              status === 1
                ? clampProgress(progress)
                : Math.max(s.progress, clampProgress(progress))
            nextStages[streamIdx] = { ...s, progress: boosted }
          }
        }
        nextRuntimeSubStagesById[node.id] = nextStages
      } else if (status === 2) {
        nextRuntimeProgressById[node.id] = 100
        doneIds.add(node.id)
      } else if (typeof progress === "number") {
        nextRuntimeProgressById[node.id] = clampProgress(progress)
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
  const { presets: communityWorkflows, loading: communityWorkflowsLoading, refresh: refreshCommunityWorkflows } = useCommunityWorkflowsPresets()
  const [loadDialogOpen, setLoadDialogOpen] = useState(false)
  const [loadSearch, setLoadSearch] = useState("")

  // Auto-refresh both lists every time the Load dialog opens so a workflow
  // someone else just published / deleted shows up immediately. Also re-reads
  // localStorage in case another tab or the Save flow mutated it.
  const refreshLoadDialogLists = useCallback(() => {
    refreshCommunityWorkflows()
    setSavedList(loadAllSaved())
  }, [refreshCommunityWorkflows])

  useEffect(() => {
    if (loadDialogOpen) refreshLoadDialogLists()
  }, [loadDialogOpen, refreshLoadDialogLists])
  const [logDialogOpen, setLogDialogOpen] = useState(false)
  const [selectedLogTarget, setSelectedLogTarget] = useState<{
    node: string
    logPath?: string
    envName?: string
    port?: number
  } | null>(null)

  // Save dialog: full form (name, description, author, tags, publish) — non-dismissable on outside click
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveForm, setSaveForm] = useState<{ name: string; description: string; author: string; tags: string; publish: boolean }>({
    name: "",
    description: "",
    author: "",
    tags: "",
    publish: false,
  })

  const openSaveDialog = useCallback(() => {
    // Default Author: preferred name from profile localStorage, else the signed-in
    // email. Matches openClassifierSave so a user sees the same identity in both
    // Save dialogs. Server-side `ownerId` always comes from the auth token uid
    // (community.py register_workflow), so this label is purely cosmetic.
    const uid = userInfo?.user_id
    let defaultAuthor = ""
    if (uid && typeof window !== "undefined") {
      try {
        const stored = window.localStorage.getItem(`preferred_name_${uid}`)
        if (stored && stored !== "null") defaultAuthor = stored
      } catch { /* ignore */ }
    }
    if (!defaultAuthor) defaultAuthor = userInfo?.email || ""
    setSaveForm({ name: activeWf.name, description: "", author: defaultAuthor, tags: "", publish: false })
    setSaveDialogOpen(true)
  }, [activeWf.name, userInfo?.user_id, userInfo?.email])

  /**
   * Snapshot of the slide-independent run inputs that startWorkflow needs but
   * panelStates does not carry: the ROI bbox plus the active class lists.
   * `image_path` is omitted by design — the importer opens their own slide.
   */
  const buildRuntimeContextSnapshot = useCallback((): SerializedWorkflowRuntimeContext | undefined => {
    const ctx: SerializedWorkflowRuntimeContext = {}
    if (rectangleCoords) {
      ctx.rectangleCoords = { x1: rectangleCoords.x1, y1: rectangleCoords.y1, x2: rectangleCoords.x2, y2: rectangleCoords.y2 }
    }
    const polygon = shapeData?.polygonPoints
    if (Array.isArray(polygon) && polygon.length > 0) {
      ctx.polygonPoints = polygon.map((p) => [p[0], p[1]] as [number, number])
    }
    if (Array.isArray(nucleiClasses) && nucleiClasses.length > 0) {
      ctx.nucleiClasses = nucleiClasses.map((c) => ({
        name: c.name,
        color: c.color,
        ...(typeof c.count === "number" ? { count: c.count } : {}),
        ...(typeof c.negativeCount === "number" ? { negativeCount: c.negativeCount } : {}),
        ...(typeof c.persisted === "boolean" ? { persisted: c.persisted } : {}),
      }))
    }
    if (reduxPatchClassificationData) {
      ctx.patchClassificationData = {
        class_id: [...(reduxPatchClassificationData.class_id ?? [])],
        class_name: [...(reduxPatchClassificationData.class_name ?? [])],
        class_hex_color: [...(reduxPatchClassificationData.class_hex_color ?? [])],
        ...(Array.isArray(reduxPatchClassificationData.class_counts)
          ? { class_counts: [...reduxPatchClassificationData.class_counts] }
          : {}),
      }
    }
    return Object.keys(ctx).length > 0 ? ctx : undefined
  }, [rectangleCoords, shapeData, nucleiClasses, reduxPatchClassificationData])

  const restoreSavedWorkflowPanelsAndChat = useCallback(
    (wf: SerializedWorkflow) => {
      const cloned = JSON.parse(JSON.stringify(wf.panelStates)) as Record<string, WorkflowPanel>
      setPanelStates((prev) => ({ ...prev, ...cloned }))
      dispatch(setMessages(wf.chatMessages as ChatMessage[]))
      // Older snapshots have no runtimeContext — leave current Redux state untouched.
      const ctx = wf.runtimeContext
      if (ctx) {
        if (ctx.rectangleCoords) {
          const next: ShapeData = { rectangleCoords: ctx.rectangleCoords }
          if (Array.isArray(ctx.polygonPoints) && ctx.polygonPoints.length > 0) {
            next.polygonPoints = ctx.polygonPoints.map((p) => [p[0], p[1]] as [number, number])
          }
          dispatch(setShapeData(next))
        }
        if (Array.isArray(ctx.nucleiClasses) && ctx.nucleiClasses.length > 0) {
          dispatch(setNucleiClasses(ctx.nucleiClasses.map((c) => ({
            name: c.name,
            color: c.color,
            count: typeof c.count === "number" ? c.count : 0,
            negativeCount: typeof c.negativeCount === "number" ? c.negativeCount : 0,
            ...(typeof c.persisted === "boolean" ? { persisted: c.persisted } : {}),
          } as AnnotationClass))))
        }
        if (ctx.patchClassificationData) {
          dispatch(setPatchClassificationData(ctx.patchClassificationData as PatchClassificationData))
        }
      }
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

  // Classifier Load dialog: current FM folder (.tlcls) + community list
  const [communityClassifiers, setCommunityClassifiers] = useState<CommunityClassifierOption[]>(COMMUNITY_CLASSIFIERS_FALLBACK)
  const [communityClassifiersLoading, setCommunityClassifiersLoading] = useState(false)
  const [classifierLoadOpen, setClassifierLoadOpen] = useState(false)
  const [classifierContextNodeId, setClassifierContextNodeId] = useState<string | null>(null)
  const [classifierLoadSearch, setClassifierLoadSearch] = useState("")
  // One-vs-rest: when the Load dialog is opened for a specific cell type, the
  // chosen .tlcls is attached to THAT class (panel.content `classifier_paths`)
  // instead of the node's single `classifier_path`. null = normal single-model load.
  const [classifierLoadTargetClass, setClassifierLoadTargetClass] = useState<string | null>(null)
  // In-progress community classifier download (drives the Load dialog progress bar).
  // `pct`: 0–100, or -1 when the server sends no Content-Length (indeterminate).
  const [classifierDownload, setClassifierDownload] = useState<{ id: string; pct: number } | null>(null)
  // Global download-progress toast. The Load dialog's per-row bar only shows while
  // that dialog is open — but the "Class library (by type)" chips close the dialog
  // before the download starts, and tissuelab-owned models aren't even in the
  // community-row list. So surface a toast for EVERY classifier download (chip or
  // row) so progress is always visible, dialog open or not.
  useEffect(() => {
    const id = "classifier-download-progress"
    if (!classifierDownload) {
      toast.dismiss(id)
      return
    }
    const pct = classifierDownload.pct
    toast.loading(pct < 0 ? "Downloading classifier…" : `Downloading classifier… ${pct}%`, { id })
  }, [classifierDownload])
  // Non-null while a load-workflow flow is downloading its referenced
  // community classifiers — drives a modal overlay that blocks Run/etc.
  // until every classifier file is on disk.
  const [workflowHydration, setWorkflowHydration] = useState<{ done: number; total: number } | null>(null)
  const [classifierSaveOpen, setClassifierSaveOpen] = useState(false)
  const [classifierSaveForm, setClassifierSaveForm] = useState({
    name: "",
    description: "",
    author: "",
    tags: "",
    publish: false,
  })
  // Metadata snapshot we hand to publishClassifierToCommunity once the post-
  // Save training run completes. Lives in closures rather than state because
  // Save triggers exactly one training run we can await per click.
  type PublishInfo = {
    destFull: string
    destFileName: string
    name: string
    description: string
    author: string
    tags: string[]
    modelId: string
    factory?: string
  }

  // Re-fetched every time the Load dialog opens (and on demand via the
  // dialog's refresh button) so newly published classifiers show up.
  const fetchCommunityClassifiers = useCallback(() => {
    setCommunityClassifiersLoading(true)
    return classifiersService.getPublicClassifiers({ limit: 100 })
      .then((response) => {
        const remote = (response.classifiers || []).map(remoteClassifierToOption)
        setCommunityClassifiers(remote.length > 0 ? remote : COMMUNITY_CLASSIFIERS_FALLBACK)
      })
      .catch(() => {
        setCommunityClassifiers(COMMUNITY_CLASSIFIERS_FALLBACK)
      })
      .finally(() => {
        setCommunityClassifiersLoading(false)
      })
  }, [])

  // Refresh both lists shown by the Load Classifier dialog: re-list the
  // file browser's current folder (drives "Current folder") AND re-fetch
  // community. Used by the dialog's open-trigger and Refresh button.
  const refreshClassifierLists = useCallback(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("refresh-file-list"))
    }
    return fetchCommunityClassifiers()
  }, [fetchCommunityClassifiers])

  useEffect(() => {
    if (classifierLoadOpen) void refreshClassifierLists()
  }, [classifierLoadOpen, refreshClassifierLists])

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
    setClassifierLoadTargetClass(null)
    setClassifierLoadSearch("")
    setClassifierLoadOpen(true)
  }, [])
  // One-vs-rest: open the same Load dialog but bind the pick to one cell type.
  const openClassifierLoadForClass = useCallback((nodeId: string, className: string) => {
    setClassifierContextNodeId(nodeId)
    setClassifierLoadTargetClass(className)
    setClassifierLoadSearch("")
    setClassifierLoadOpen(true)
  }, [])
  const openNodeLogs = useCallback(
    (nodeId: string) => {
      const node = activeWf.nodes.find((n) => n.id === nodeId)
      const nodeName = node?.modelId
      if (!nodeName) return
      const meta = (nodeLogsMeta?.[nodeName] || {}) as { logPath?: string; envName?: string; port?: number }
      setSelectedLogTarget({
        node: nodeName,
        logPath: meta.logPath,
        envName: meta.envName,
        port: meta.port,
      })
      setLogDialogOpen(true)
    },
    [activeWf.nodes, nodeLogsMeta]
  )

  /**
   * Create a new classifier file for a NuClass/MUSK node, link it to the folder,
   * and trigger one update run so the workflow trains into it.
   * @param outputStem Optional sanitized filename stem from the dialog "Name" (no extension); if omitted, uses slide + node + timestamp.
   * @returns On success, includes the destination full path for library metadata.
   */
  const saveClassifierFile = useCallback(
    async (
      nodeId: string,
      options?: { outputStem?: string; beforeKickOff?: () => void }
    ): Promise<{ ok: true; destFull: string; destFileName: string } | { ok: false }> => {
      const node = activeWf.nodes.find((n) => n.id === nodeId)
      if (!node) return { ok: false }
      const panel = ensureLegacyPanel(node)
      if (!panel) return { ok: false }

      const persistModelName = graphClassifierTasknodePersistModelName(node.modelId)
      if (!persistModelName) {
        toast.error("Save classifier from memory is only available for NuClass, Cytoformer, or MUSK classification nodes.")
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
      // let, not const — the server may auto-suffix "(N)" on a name collision
      // and we adopt the real name it returns (see the save call below).
      let destFileName = `${sanitizedStem}${ext}`

      let folder = (selectedFolder ?? "").trim()
      if (!folder && currentPath) {
        const norm = formatPath(currentPath)
        if (isWebMode) {
          const idx = norm.lastIndexOf("/")
          folder = idx > 0 ? norm.slice(0, idx) : norm
        } else {
          const sep = norm.includes("\\") ? "\\" : "/"
          const idx = norm.lastIndexOf(sep)
          folder = idx > 0 ? norm.slice(0, idx) : norm
        }
      }
      if (!folder) {
        toast.error("Choose a folder in the sidebar to save into, or open a slide so the folder can be inferred.")
        return { ok: false }
      }
      if (denyWriteToast("save classifier", folder)) {
        return { ok: false }
      }

      let destFull = (() => {
        if (isWebMode) {
          return `${folder.replace(/\/+$/, "")}/${destFileName}`.replace(/\/+/g, "/")
        }
        // Desktop: keep the folder's own separator — `\` on Windows, `/` on
        // macOS/Linux. Hardcoding `\` produced mixed paths like `…/demo\foo`,
        // which Electron's read-file then failed to open (ENOENT).
        const sep = folder.includes("\\") ? "\\" : "/"
        return `${folder.replace(/[/\\]+$/, "")}${sep}${destFileName}`
      })()

      const applySavedPath = () => {
        handleLegacyPanelChange(panel.id, {
          ...panel,
          content: upsertContentStringValue(panel.content, "save_classifier_path", destFull),
        })
      }

      // Create the empty classifier file. On a name collision the backend
      // auto-suffixes "name(1).tlcls" (like file upload) and returns the path it
      // actually wrote — adopt that name so the record / selection / training
      // all point at the real file.
      try {
        const saveResp = await saveClassifierFileOnServer(
          {
            path: normalizePathForSegClassifierApi(destFull),
            fail_if_exists: true,
          })
        const serverName = (saveResp?.path || "").split(/[/\\]/).pop()
        if (serverName && serverName !== destFileName) {
          const sep = destFull.includes("\\") ? "\\" : "/"
          const dirEnd = destFull.lastIndexOf(sep)
          destFull = dirEnd >= 0 ? `${destFull.slice(0, dirEnd + 1)}${serverName}` : serverName
          destFileName = serverName
        }
      } catch (e) {
        // ApiError carries the backend's structured {code, message}; prefer it
        // for a meaningful message over a generic Error.
        const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
        toast.error(`Save failed: ${msg}`)
        return { ok: false }
      }

      // Mirror the old "Create classifier" flow: set the save path, select the
      // new classifier for this folder (link), enable update-after-every-
      // annotation, then trigger one update so the workflow trains into it.
      applySavedPath()
      // Refresh the file list so the brand-new .tlcls shows up in the
      // classifier dropdown and survives the next setAvailableModelsForPath
      // pass (which clears any selection not in the available list).
      window.dispatchEvent(new CustomEvent("refresh-file-list"))
      // updateClassifier MUST be set before setSelectedModelForPath. The
      // ClassificationPanel sync useEffect keys off both; if selectedModel flips
      // first while updateClassifier is still false, the effect's "else if
      // (saveIndex > -1) splice" branch deletes save_classifier_path from the
      // panel content — and the trained classifier never reaches disk.
      dispatch(setUpdateClassifier(true))
      // Patch classifiers (MUSK / H-optimus-0 / Virchow) refresh the PATCH
      // overlay; NuClass refreshes the cell overlay. Keyed by the classifier
      // family, not a single model id.
      const isPatchClf = isTissueClassifyModelId(persistModelName)
      if (isPatchClf) {
        dispatch(setUpdatePatchAfterEveryAnnotation(true))
      } else {
        dispatch(setUpdateAfterEveryAnnotation(true))
      }
      dispatch(setSelectedModelForPath({ path: folder, modelName: destFileName }))
      const updateEvent =
        isPatchClf ? "trigger-patch-update" : "trigger-nuclei-update"
      const updateZarrPath = formatPath(currentPath ?? "")
      // Allow callers (e.g. publish-after-train) to register a completion waiter
      // before the run is kicked off — otherwise a fast finish can be missed.
      options?.beforeKickOff?.()
      // Path is carried on the event (and Redux updateClassifier is already true) so
      // the handler can inject save_classifier_path without waiting for panel sync.
      eventBus.emit(updateEvent, {
        zarrPath: updateZarrPath,
        source: "graph-classifier-save",
        saveClassifierPath: destFull,
      })
      toast.success(`Created classifier ${destFileName}; running an update to train it…`)
      return { ok: true, destFull, destFileName }
    },
    [activeWf.nodes, ensureLegacyPanel, currentPath, selectedFolder, isWebMode, handleLegacyPanelChange, dispatch]
  )

  // One-vs-rest Save dialog: pick which classes to train/save (each its own .tlcls),
  // each with an independent "publish to community" toggle. null = closed.
  const [ovrSave, setOvrSave] = useState<{
    nodeId: string
    isPatch: boolean
    classes: string[]  // panel classes minus Negative control (dropdown source)
    rows: Array<{ className: string; saveName: string; publish: boolean }>
  } | null>(null)

  const openClassifierSave = useCallback(
    (nodeId: string) => {
      if (denyWriteToast("save classifier", selectedFolder || currentPath)) {
        return
      }
      const node = activeWf.nodes.find((n) => n.id === nodeId)
      if (!node) return
      const panel = ensureLegacyPanel(node)
      if (!panel) return
      const persistName = graphClassifierTasknodePersistModelName(node.modelId)
      if (!persistName) {
        toast.error("Save classifier from memory is only available for NuClass, Cytoformer, or MUSK classification nodes.")
        return
      }
      setClassifierContextNodeId(nodeId)

      // One-vs-rest: open the per-class Save dialog instead of the single-classifier
      // one (each class = its own binary .tlcls, chosen + published independently).
      if (node.classifierMode === "one-vs-rest") {
        const isPatch = isTissueClassifyModelId(node.modelId)
        const names: string[] = isPatch
          ? (reduxPatchClassificationData?.class_name || []).map((n) => String(n))
          : nucleiClasses.map((c) => c.name)
        const avail = names.filter((n) => n.trim().toLowerCase() !== "negative control")
        setOvrSave({ nodeId, isPatch, classes: avail, rows: [] })
        return
      }
      // Default Author: preferred name from profile localStorage, else the
      // signed-in email. User can still edit before saving.
      const uid = userInfo?.user_id
      let defaultAuthor = ""
      if (uid && typeof window !== "undefined") {
        try {
          const stored = window.localStorage.getItem(`preferred_name_${uid}`)
          if (stored && stored !== "null") defaultAuthor = stored
        } catch { /* ignore */ }
      }
      if (!defaultAuthor) defaultAuthor = userInfo?.email || ""
      setClassifierSaveForm({
        name: isTissueClassifyModelId(persistName) ? "Patch Classifier" : "Cell Classifier",
        description: "",
        author: defaultAuthor,
        tags: "",
        publish: false,
      })
      setClassifierSaveOpen(true)
    },
    [activeWf.nodes, activeWf.name, currentPath, selectedFolder, ensureLegacyPanel, userInfo?.user_id, userInfo?.email, nucleiClasses, reduxPatchClassificationData]
  )

  // Read the saved .tlcls bytes, re-upload to ctrl service `classifiers/`,
  // then register the metadata so it shows up in the community feed. Runs
  // automatically once training finishes; `toastId` reuses the training
  // toast so the user sees one continuous status with a progress bar.
  // Modal shown for single-classifier publishes (replaces the corner toast). The
  // "conflicts" phase pauses publishing to let the user review annotation conflicts
  // against the currently published version. null = closed.
  type PublishConflict = {
    your_class: string
    current_class: string
    count: number
    max_similarity: number
    your_regions?: ConflictRegion[]
    current_regions?: ConflictRegion[]
    your_regions_total?: number
    current_regions_total?: number
  }
  const [publishDialog, setPublishDialog] = useState<{
    open: boolean
    phase: "working" | "success" | "error" | "conflicts"
    title: string
    message: string
    pct: number
    conflicts?: PublishConflict[]
  } | null>(null)
  // Resolved by the conflicts-phase buttons: true = publish anyway, false = publish later.
  const publishConflictResolveRef = useRef<((proceed: boolean) => void) | null>(null)
  const resolvePublishConflict = useCallback((proceed: boolean) => {
    const r = publishConflictResolveRef.current
    publishConflictResolveRef.current = null
    if (r) r(proceed)
  }, [])

  // Publish progress is reported through this abstraction so the same publish flow
  // can surface either as a toast (workflow batch publish) or as a modal dialog
  // (single-classifier publish — leaves room for a conflicts step before uploading).
  type PublishReporter = {
    loading: (label: string, pct: number) => void
    success: (message: string) => void
    error: (message: string) => void
  }
  const publishProgressBar = (pct: number) => (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/15">
      <div
        className={pct >= 0 ? "h-full rounded-full bg-primary transition-all duration-200" : "h-full w-1/2 animate-pulse rounded-full bg-primary"}
        style={pct >= 0 ? { width: `${pct}%` } : undefined}
      />
    </div>
  )
  const makeToastReporter = (toastId: string | number): PublishReporter => {
    const body = (label: string, pct: number) => (
      <div className="flex w-full flex-col gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        {publishProgressBar(pct)}
      </div>
    )
    return {
      loading: (label, pct) => toast.loading(body(label, pct), { id: toastId }),
      success: (m) => toast.success(m, { id: toastId }),
      error: (m) => toast.error(m, { id: toastId }),
    }
  }
  const makeDialogReporter = (): PublishReporter => ({
    loading: (label, pct) => setPublishDialog({ open: true, phase: "working", title: "Publishing classifier", message: label, pct }),
    success: (m) => setPublishDialog({ open: true, phase: "success", title: "Published", message: m, pct: 100 }),
    error: (m) => setPublishDialog({ open: true, phase: "error", title: "Publish failed", message: m, pct: 0 }),
  })

  const publishClassifierToCommunity = useCallback(
    async (info: PublishInfo, reporter: PublishReporter, targetClassifierId?: string): Promise<{ classifierId: string } | null> => {
      try {
        // 1) Read the .tlcls bytes. Web slides live in ctrl-service user
        // storage (download via fm signed-link); desktop slides are on disk.
        reporter.loading(`Reading "${info.name}"…`, -1)
        let fileBlob: Blob
        if (isWebMode) {
          const link = await createDownloadLink(info.destFull)
          fileBlob = await downloadFileDirect(link.download_token)
        } else {
          const electron = (window as { electron?: { readFile?: (p: string) => Promise<ArrayBuffer | Uint8Array> } }).electron
          if (!electron?.readFile) throw new Error("Desktop file read API unavailable")
          const buf = await electron.readFile(info.destFull)
          // The electron bridge can hand us either ArrayBuffer or Uint8Array;
          // cast through unknown to satisfy the Blob ctor's BlobPart union.
          fileBlob = new Blob([buf as unknown as BlobPart])
        }
        const file = new File([fileBlob], info.destFileName, { type: "application/octet-stream" })

        // 1.5) Conflict check (republish only — a fresh publish has no prior version).
        // Compare this .tlcls against the currently published one by embedding
        // similarity; if the user's annotations conflict with existing ones, pause and
        // let them decide. Never block on the check itself failing.
        if (targetClassifierId) {
          reporter.loading(`Checking "${info.name}" for conflicts…`, -1)
          try {
            const fd = new FormData()
            fd.append("file", file)
            fd.append("threshold", "0.9")
            const cr = await apiFetch(
              `${COMMUNITY_API_ENDPOINT}/community/v1/classifiers/${encodeURIComponent(targetClassifierId)}/conflicts`,
              { method: "POST", body: fd, returnAxiosFormat: true }
            )
            const conflictData = (cr as { data?: { has_conflicts?: boolean; conflicts?: PublishConflict[] } })?.data
            if (conflictData?.has_conflicts && Array.isArray(conflictData.conflicts) && conflictData.conflicts.length) {
              const proceed = await new Promise<boolean>((resolve) => {
                publishConflictResolveRef.current = resolve
                setPublishDialog({
                  open: true,
                  phase: "conflicts",
                  title: "Possible labeling conflicts",
                  message: "",
                  pct: -1,
                  conflicts: conflictData.conflicts,
                })
              })
              if (!proceed) {
                setPublishDialog(null)
                return null // "Publish later"
              }
            }
          } catch (err) {
            console.warn("[publish] conflict check skipped:", err)
          }
        }

        // 2) Upload to ctrl service `classifiers/` (same path the community
        // download endpoint reads from). uploadFiles reports 0–100.
        const dt = new DataTransfer()
        dt.items.add(file)
        reporter.loading(`Uploading "${info.name}"… 0%`, 0)
        const uploadResp = (await uploadFiles(
          "classifiers",
          dt.files,
          (pct) => reporter.loading(`Uploading "${info.name}"… ${pct}%`, pct),
          false,
          undefined,
          false,
          { endpoint: COMMUNITY_API_ENDPOINT }
        )) as { uploaded_files?: Array<{ actual_name?: string }> } | undefined
        const actualFileName = uploadResp?.uploaded_files?.[0]?.actual_name || info.destFileName
        const filePath = `classifiers/${actualFileName}`

        // 3) Register metadata. A republish passes targetClassifierId (e.g. a
        // `tissuelab-…` cloud classifier) so the backend updates that doc in
        // place — preserving its owner + accumulating contributors + archiving
        // the prior version. A fresh publish mints a new `uploaded-…` id.
        reporter.loading(`Finalizing "${info.name}"…`, 100)
        const classifierId = targetClassifierId || `uploaded-${Date.now()}`
        const downloadLink =
          Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
        await apiFetch(`${COMMUNITY_API_ENDPOINT}/community/v1/classifiers/register`, {
          method: "POST",
          body: JSON.stringify({
            classifier_id: classifierId,
            download_link: downloadLink,
            file_name: actualFileName,
            file_path: filePath,
            title: info.name,
            description: info.description || "User uploaded classifier",
            tags: info.tags,
            file_size: file.size,
            factory: info.factory || "",
            model: info.modelId,
          }),
        })
        reporter.success(`Published "${info.name}" to community.`)
        return { classifierId }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        reporter.error(`Publish failed: ${msg}`)
        return null
      }
    },
    [isWebMode]
  )

  // "Publish to TissueLab": republish a trained TissueLab classifier back to its
  // cloud id (loadedClassifier.communityId). The trained model lives at
  // loadedClassifier.path after the run. Backend preserves owner + title, bumps
  // contributors, and archives the prior version.
  const publishToTissueLab = useCallback(
    async (nodeId: string) => {
      const node = activeWf.nodes.find((n) => n.id === nodeId)
      const communityId = node?.loadedClassifier?.communityId
      const destFull = node?.loadedClassifier?.path
      if (!communityId || !destFull) {
        toast.error("Nothing to publish — train a TissueLab classifier first.")
        return
      }
      const destFileName = destFull.split(/[/\\]/).pop() || `${communityId}.tlcls`
      const meta = node?.modelId ? registryNodes[node.modelId] : undefined
      // title/factory/model are preserved server-side on republish; these are
      // just fallbacks for the toast / logging.
      const info: PublishInfo = {
        destFull,
        destFileName,
        name: node?.loadedClassifier?.name || communityId,
        description: "",
        author: "",
        tags: [],
        modelId: node?.modelId || "",
        factory: meta?.factory,
      }
      await publishClassifierToCommunity(info, makeDialogReporter(), communityId)
    },
    [activeWf.nodes, publishClassifierToCommunity, currentPath]
  )

  // Pending workflow-publish state. Populated when a Publish-on-Save scan finds
  // local classifier files the user hasn't pushed to community yet; the confirm
  // dialog lists them and on accept we upload each before registering the
  // workflow. Stays null when there are no locals to upload (direct publish).
  type PendingPublishLocal = {
    ref: ClassifierPathRef
    publishInfo: PublishInfo
  }
  type PendingWorkflowPublish = {
    workflowName: string
    workflowId: string
    snapshot: SerializedWorkflow
    knownCommunityMap: Map<string, string>
    localItems: PendingPublishLocal[]
  }
  const [pendingWorkflowPublish, setPendingWorkflowPublish] = useState<PendingWorkflowPublish | null>(null)
  const [publishInFlight, setPublishInFlight] = useState(false)

  const finalizeWorkflowPublish = useCallback(
    async (pending: PendingWorkflowPublish) => {
      setPublishInFlight(true)
      try {
        const { workflowName, workflowId, snapshot, knownCommunityMap, localItems } = pending
        const fullMap = new Map(knownCommunityMap)

        for (const item of localItems) {
          const cToastId = toast.loading(`Publishing classifier "${item.ref.displayName}"…`)
          const result = await publishClassifierToCommunity(item.publishInfo, makeToastReporter(cToastId))
          if (!result) {
            toast.error(
              `Workflow publish aborted — classifier "${item.ref.displayName}" failed to upload.`
            )
            return
          }
          fullMap.set(item.ref.path, result.classifierId)
        }

        // Strip per-user fields before the workflow leaves this machine:
        //  1) rewrite local classifier_path → community: refs (uses uploaded ids)
        //  2) drop `save_classifier_path` (a write destination on author's disk)
        //  3) drop `path` content items (the absolute slide path the author had open)
        //  4) drop chatMessages entirely (often quotes the slide path in prompts)
        //  5) mirror (1) into each node's `loadedClassifier.path` so the
        //     audit/snapshot field doesn't leak owner-local file paths
        //     either — importers will rewrite both back to local on download.
        const rewritten = stripContentKeysInPanelStates(
          rewriteClassifierPathsInPanelStates(snapshot.panelStates as Record<string, WorkflowPanel>, fullMap),
          ["save_classifier_path", "path"]
        )
        const rewrittenNodes = rewriteLoadedClassifierPathsInNodes(snapshot.nodes as GraphNode[], fullMap)
        const wfToastId = toast.loading(`Publishing workflow "${workflowName}"…`)
        try {
          await registerCommunityWorkflow(
            workflowId,
            {
              name: snapshot.name,
              description: snapshot.description || "",
              author: snapshot.author || "",
              savedAt: snapshot.savedAt,
              nodes: rewrittenNodes,
              connections: snapshot.connections,
              panelStates: rewritten as unknown as Record<string, unknown>,
              chatMessages: [],
              selectedId: snapshot.selectedId,
              tags: snapshot.tags,
              isPublic: true,
              ...(snapshot.runtimeContext ? { runtimeContext: snapshot.runtimeContext } : {}),
            } satisfies RegisterCommunityWorkflowPayload,
            userInfo?.user_id
          )
          toast.success(`Published "${workflowName}" to community.`, { id: wfToastId })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          toast.error(`Workflow publish failed: ${msg}`, { id: wfToastId })
        }
      } finally {
        setPublishInFlight(false)
        setPendingWorkflowPublish(null)
      }
    },
    [publishClassifierToCommunity, userInfo?.user_id]
  )

  const preparePublishWorkflow = useCallback(
    (workflowName: string, snapshot: SerializedWorkflow) => {
      const refs = extractClassifierPathRefs(
        snapshot.panelStates as Record<string, WorkflowPanel>,
        activeWf.nodes
      )
      const knownCommunityMap = new Map<string, string>()
      const localRefs: ClassifierPathRef[] = []
      for (const r of refs) {
        if (r.kind === "community" && r.communityId) {
          knownCommunityMap.set(r.path, r.communityId)
        } else if (r.kind === "local") {
          localRefs.push(r)
        }
      }

      const tagsList = saveForm.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      const authorTrim = saveForm.author.trim()

      const localItems: PendingPublishLocal[] = localRefs.map((ref) => {
        const node = activeWf.nodes.find((n) => n.id === ref.nodeId)
        const meta = node?.modelId ? registryNodes[node.modelId] : undefined
        const lastSep = Math.max(ref.path.lastIndexOf("/"), ref.path.lastIndexOf("\\"))
        const destFileName = lastSep >= 0 ? ref.path.slice(lastSep + 1) : ref.path
        return {
          ref,
          publishInfo: {
            destFull: ref.path,
            destFileName,
            name: ref.displayName,
            description: "",
            author: authorTrim,
            tags: tagsList,
            modelId: node?.modelId || "",
            factory: meta?.factory,
          },
        }
      })

      const pending: PendingWorkflowPublish = {
        workflowName,
        workflowId: `wf-uploaded-${Date.now()}`,
        snapshot,
        knownCommunityMap,
        localItems,
      }

      // Always go through the confirmation dialog before any community write —
      // even when every referenced classifier is already public. Skipping the
      // dialog used to silently push the workflow upstream the moment the user
      // hit "Save & Publish", with no chance to cancel after the local save
      // (which is irreversible) gave the impression they'd committed.
      setPendingWorkflowPublish(pending)
    },
    [activeWf.nodes, saveForm.tags, saveForm.author]
  )

  const submitSave = useCallback(() => {
    const name = saveForm.name.trim()
    if (!name) {
      toast.error("Please give the workflow a name")
      return
    }
    const all = loadAllSaved()
    const runtimeContext = buildRuntimeContextSnapshot()
    const snapshot: SerializedWorkflow = {
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
      ...(runtimeContext ? { runtimeContext } : {}),
    }
    all[name] = snapshot
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

    if (saveForm.publish) {
      preparePublishWorkflow(name, snapshot)
    }
  }, [saveForm, activeWf, panelStates, chatMessages, buildRuntimeContextSnapshot, preparePublishWorkflow, currentPath])

  // Submit the One-vs-rest Save dialog: for each chosen class, write a scoped
  // save_classifier_paths ({class: <folder>/<name>.tlcls}), run ONE training pass
  // (the tasknode trains every listed class's binary), then publish the classes
  // whose toggle is on — each independently.
  const submitOvrSave = useCallback(async () => {
    const s = ovrSave
    if (!s || s.rows.length === 0) return
    const node = activeWf.nodes.find((n) => n.id === s.nodeId)
    if (!node) return
    const panel = ensureLegacyPanel(node)
    if (!panel) return

    let folder = (selectedFolder ?? "").trim()
    if (!folder && currentPath) {
      const norm = formatPath(currentPath)
      const sep = norm.includes("\\") ? "\\" : "/"
      const idx = norm.lastIndexOf(sep)
      folder = idx > 0 ? norm.slice(0, idx) : norm
    }
    if (!folder) {
      toast.error("Choose a folder in the sidebar to save into, or open a slide first.")
      return
    }
    const sep = folder.includes("\\") ? "\\" : "/"
    const savePaths: Record<string, string> = {}
    const toPublish: Array<{ path: string; fileName: string; name: string }> = []
    for (const r of s.rows) {
      const stem =
        sanitizeFilename((r.saveName || r.className).replace(/\.tlcls$/i, "")).slice(0, 120) ||
        sanitizeFilename(r.className) || "class"
      const fileName = `${stem}.tlcls`
      const full = `${folder.replace(/[/\\]+$/, "")}${sep}${fileName}`
      savePaths[r.className] = full
      if (r.publish) toPublish.push({ path: full, fileName, name: r.className })
    }

    // Scope the run to exactly these classes: an explicit save_classifier_paths in
    // panel.content (the panels prefer it over deriving one path per class).
    let nextContent = upsertContentStringValue(panel.content, "classifier_mode", "one-vs-rest")
    nextContent = upsertContentStringValue(nextContent, "save_classifier_paths", JSON.stringify(savePaths))
    nextContent = upsertContentStringValue(nextContent, "save_classifier_path", Object.values(savePaths)[0] || "")
    // Stash for race-free injection at run time (panelStates can be clobbered
    // by a ClassificationPanel content-sync effect before the trigger fires).
    ovrSavePathsRef.current[s.nodeId] = savePaths
    handleLegacyPanelChange(panel.id, { ...panel, content: nextContent })
    dispatch(setUpdateClassifier(true))
    if (s.isPatch) dispatch(setUpdatePatchAfterEveryAnnotation(true))
    else dispatch(setUpdateAfterEveryAnnotation(true))

    setOvrSave(null)
    const updateEvent = s.isPatch ? "trigger-patch-update" : "trigger-nuclei-update"
    const updateZarrPath = formatPath(currentPath ?? "")
    // Paths already in ovrSavePathsRef — emit sync; handler injects them into the payload.
    const kickOffTraining = () =>
      eventBus.emit(updateEvent, { zarrPath: updateZarrPath, source: "ovr-classifier-save" })

    const nTrain = s.rows.length
    if (toPublish.length === 0) {
      toast.success(`Training ${nTrain} classifier${nTrain > 1 ? "s" : ""}…`)
      kickOffTraining()
      return
    }
    const meta = node.modelId ? registryNodes[node.modelId] : undefined
    const pubToast = toast.loading(
      `Training ${nTrain} classifier${nTrain > 1 ? "s" : ""} — will publish ${toPublish.length} when done…`
    )
    // Waiter must be registered before the run starts or a fast finish is missed.
    const finishedPromise = waitForWorkflowCompleteSignal()
    kickOffTraining()
    void (async () => {
      try {
        const finished = await finishedPromise
        if (!finished.success) {
          toast.error("Training failed — nothing was published.", { id: pubToast })
          return
        }
        toast.dismiss(pubToast)
        for (const p of toPublish) {
          const info: PublishInfo = {
            destFull: p.path,
            destFileName: p.fileName,
            name: p.name,
            description: "",
            author: "",
            tags: [],
            modelId: node.modelId || "",
            factory: meta?.factory,
          }
          await publishClassifierToCommunity(info, makeDialogReporter())
        }
      } catch {
        toast.error("Stopped waiting for training — re-run an update to publish.", { id: pubToast })
      }
    })()
  }, [ovrSave, activeWf.nodes, ensureLegacyPanel, selectedFolder, currentPath, handleLegacyPanelChange, dispatch, waitForWorkflowCompleteSignal, publishClassifierToCommunity])

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
    const node = activeWf.nodes.find((n) => n.id === nodeId)
    if (!node?.modelId) {
      toast.error("No model node selected.")
      setClassifierSaveOpen(false)
      return
    }
    // Capture the narrowed modelId in a const — control-flow narrowing of
    // node.modelId is not preserved inside the closures below.
    const modelId = node.modelId
    const meta = registryNodes[modelId]

    const recordLocal = (path: string) => {
      const all = loadAllClassifiers()
      all[name] = {
        name,
        modelId,
        factory: meta?.factory,
        path,
        description: classifierSaveForm.description.trim() || undefined,
        author: classifierSaveForm.author.trim() || undefined,
        ...(tags.length > 0 ? { tags } : {}),
        savedAt: new Date().toISOString(),
      }
      writeAllClassifiers(all)
    }
    const buildPublishInfo = (destFull: string, destFileName: string): PublishInfo => ({
      destFull,
      destFileName,
      name,
      description: classifierSaveForm.description.trim(),
      author: classifierSaveForm.author.trim(),
      tags,
      modelId,
      factory: meta?.factory,
    })

    // If a trained classifier is already loaded into this node, publish THAT
    // file as-is (just renamed for the community). Don't create a new empty
    // file, don't re-run a training pass, and don't touch the load path — the
    // user already has the classifier they want; "Save" should just upload it.
    const loaded = node.loadedClassifier
    if (loaded?.path) {
      const destFull = loaded.path
      const destFileName = destFull.split(/[/\\]/).pop() || `${name.replace(/\.tlcls$/i, "")}.tlcls`
      recordLocal(destFull)
      setClassifierSaveOpen(false)
      if (classifierSaveForm.publish) {
        await publishClassifierToCommunity(buildPublishInfo(destFull, destFileName), makeDialogReporter())
      } else {
        toast.success(`Saved "${name}".`)
      }
      return
    }

    // No loaded classifier: persist the in-memory model by creating the file
    // and running one training/update pass into it (original flow).
    const stemForFile = name.replace(/\.tlcls$/i, "")
    let finishedPromise: Promise<WorkflowCompletionResult> | null = null
    const result = await saveClassifierFile(nodeId, {
      outputStem: stemForFile,
      beforeKickOff: classifierSaveForm.publish
        ? () => {
            finishedPromise = waitForWorkflowCompleteSignal()
          }
        : undefined,
    })
    if (!result.ok) return
    recordLocal(result.destFull)
    setClassifierSaveOpen(false)

    // "Publish to community" checked: Save already triggered exactly one
    // training run for this model. Await *that* run, then auto-publish.
    // Cast: TS CFA does not see the assignment inside beforeKickOff.
    if (classifierSaveForm.publish && finishedPromise) {
      const pendingFinish = finishedPromise as Promise<WorkflowCompletionResult>
      const info = buildPublishInfo(result.destFull, result.destFileName)
      const publishToastId = toast.loading(`Training "${info.name}" — will publish to community when done…`)
      void (async () => {
        try {
          const finished = await pendingFinish
          if (!finished.success) {
            toast.error(`Training failed — "${info.name}" was not published.`, { id: publishToastId })
            return
          }
          await publishClassifierToCommunity(info, makeDialogReporter())
        } catch {
          toast.error(`Stopped waiting for "${info.name}" training. Re-run an update to publish.`, {
            id: publishToastId,
          })
        }
      })()
    }
  }, [classifierSaveForm, classifierContextNodeId, activeWf.nodes, saveClassifierFile, waitForWorkflowCompleteSignal, publishClassifierToCommunity])

  const loadClassifierIntoNode = useCallback(
    async (classifier: {
      name: string
      source: ClassifierSource
      path?: string
      id?: string
      author?: string
      savedAt?: string
      // "load" (default) = use the classifier for inference only.
      // "train" = continue-train ON TOP of it and write the updated model back
      // (Train this cloud classifier). Community picks pass "train".
      intent?: "load" | "train"
    }) => {
      const isTrain = classifier.intent === "train"
      const node = classifierContextNodeId
        ? activeWf.nodes.find((n) => n.id === classifierContextNodeId)
        : null
      if (!node) {
        toast.error("Select a model card first")
        return
      }

      let selectedClassifierPath = classifier.path
      // True when training a UI-defined tissuelab classifier that has no model
      // file yet — we start from scratch (no base to continue from).
      let baseIsEmpty = false

      // Community classifiers live on the community server. Download the file
      // into the current slide's folder so the local task node can read it.
      if (classifier.source === "community") {
        if (!classifier.id) {
          toast.error("This community classifier has no id.")
          return
        }
        // The slide's own folder: dirname(currentPath). currentPath is a real path
        // (absolute in Electron). Fall back to selectedFolder (already a folder).
        let folder = ""
        if (currentPath) {
          const norm = formatPath(currentPath)
          const sep = norm.includes("\\") ? "\\" : "/"
          const idx = norm.lastIndexOf(sep)
          folder = idx > 0 ? norm.slice(0, idx) : norm
        } else if (selectedFolder) {
          folder = formatPath(selectedFolder.trim())
        }
        if (!folder) {
          toast.error("Open a slide first so the classifier folder can be inferred.")
          return
        }
        const sep = folder.includes("\\") ? "\\" : "/"
        const communityId = classifier.id
        // First trainer of a UI-defined tissuelab classifier: the doc exists but
        // has no model file yet (empty localPath). Skip the download (it would
        // 404) — create an empty local .tlcls and train from scratch. The
        // republish then fills the cloud localPath, and register preserves the
        // tissuelab owner (see api/community.py register_classifier).
        if (isTrain && !classifier.path) {
          const stem = sanitizeFilename((classifier.name || communityId).replace(/\.tlcls$/i, "")).slice(0, 120) || communityId
          const emptyDest = `${folder.replace(/[/\\]+$/, "")}${sep}${stem}.tlcls`
          const emptyApiPath = isWebMode ? normalizePathForSegClassifierApi(emptyDest) : emptyDest.replace(/\\/g, "/")
          try {
            const saveResp = await saveClassifierFileOnServer(
              { path: emptyApiPath, fail_if_exists: true })
            const serverName = (saveResp?.path || "").split(/[/\\]/).pop()
            selectedClassifierPath = serverName
              ? `${folder.replace(/[/\\]+$/, "")}${sep}${serverName}`
              : emptyDest
            baseIsEmpty = true
            if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("refresh-file-list"))
          } catch (e) {
            toast.error(`Failed to start classifier: ${e instanceof Error ? e.message : String(e)}`)
            return
          }
        } else {
        try {
          setClassifierDownload({ id: communityId, pct: -1 })
          const { bytes, fileName: cloudFileName } = await classifiersService.downloadClassifier(communityId, (received, total) => {
            setClassifierDownload({
              id: communityId,
              pct: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : -1,
            })
          })
          // Mirror the cloud filename locally — that's the UUID the server
          // stores under, so the local copy matches and any later download
          // of the same classifier won't end up under a divergent name.
          // Fall back to `<communityId>.tlcls` if the server didn't surface
          // file_name (legacy download-link response).
          const fileName = cloudFileName
            || (communityId.toLowerCase().endsWith(".tlcls") ? communityId : `${communityId}.tlcls`)
          const destFull = `${folder.replace(/[/\\]+$/, "")}${sep}${fileName}`
          // Electron paths are absolute and must stay absolute. Only web paths are
          // storage-relative (normalizePathForSegClassifierApi strips the leading /).
          const apiPath = isWebMode ? normalizePathForSegClassifierApi(destFull) : destFull.replace(/\\/g, "/")
          let binary = ""
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          }
          await saveClassifierFileOnServer(
            { path: apiPath, content_base64: btoa(binary) })
          selectedClassifierPath = destFull
          // The file now exists on disk — ask the file browser to re-list so
          // the imported classifier appears under "Current folder".
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("refresh-file-list"))
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          toast.error(`Failed to import community classifier: ${msg}`)
          return
        } finally {
          setClassifierDownload(null)
        }
        }
      }

      // One-vs-rest: attach the chosen .tlcls to a single cell type. Merge into
      // the panel.s `classifier_paths` map ({className: path}) and stop —
      // this is NOT the node's single classifier, so we don't touch
      // classifier_path / loadedClassifier / updateClassifier.
      if (classifierLoadTargetClass) {
        if (!selectedClassifierPath) {
          toast.error("This classifier has no file path to attach.")
          return
        }
        const targetClass = classifierLoadTargetClass
        setPanelStates((prev) => {
          const base = prev[node.id] ?? buildLegacyPanelFromNode(node)
          if (!base) return prev
          let map: Record<string, string> = {}
          const raw = base.content.find((it) => it.key === "classifier_paths")?.value
          if (typeof raw === "string" && raw) {
            try { map = JSON.parse(raw) } catch { map = {} }
          }
          map[targetClass] = selectedClassifierPath as string
          const nextContent = upsertContentStringValue(base.content, "classifier_paths", JSON.stringify(map))
          return { ...prev, [node.id]: { ...base, content: nextContent } }
        })
        setClassifierLoadTargetClass(null)
        setClassifierLoadOpen(false)
        toast.success(`Attached "${classifier.name}" to "${targetClass}"`)
        return
      }

      // A community pick carries its id directly. For a locally-loaded (folder /
      // library) .tlcls, it may still descend from a community model — ctrl-service
      // stamps `inherit_from` on download and the tasknodes preserve it across
      // retrain. Read it back so a shared / re-imported classifier is recognized as
      // that community model and Publish still works (official can't fork, community
      // can). Best-effort — a plain from-scratch model has no marker.
      let inheritedCommunityId: string | undefined
      if (classifier.source !== "community" && selectedClassifierPath) {
        try {
          const inh = await getClassifierInheritFrom(selectedClassifierPath)
          if (inh?.community_id) inheritedCommunityId = inh.community_id
        } catch {
          /* best-effort: fall back to a plain local classifier (no republish) */
        }
      }

      setPanelStates((prev) => {
        const base = prev[node.id] ?? buildLegacyPanelFromNode(node)
        if (!base) return prev
        const withoutOldPaths = removeClassifierPathContent(base.content)
        // Empty base (first trainer, no model yet) → no classifier_path to load
        // from; training starts from scratch and only save_classifier_path is set.
        let nextContent = (selectedClassifierPath && !baseIsEmpty)
          ? upsertContentStringValue(withoutOldPaths, "classifier_path", selectedClassifierPath)
          : withoutOldPaths
        // Train mode: also point save_classifier_path at the SAME file so the next
        // run continues training on top of this classifier and writes the updated
        // model back into it (republished to the same community id, author stays
        // tissuelab). Load mode leaves no save destination (inference only).
        if (isTrain && selectedClassifierPath) {
          nextContent = upsertContentStringValue(nextContent, "save_classifier_path", selectedClassifierPath)
        }
        // classifier_display_name field is gone — the FE derives display from
        // basename(classifier_path) so there's nothing to upsert here.
        nextContent = nextContent.filter((item) => item.key !== "classifier_download_link")
        return { ...prev, [node.id]: { ...base, content: nextContent } }
      })
      setNodes((prev) =>
        prev.map((n) =>
          n.id === node.id
            ? {
                ...n,
                loadedClassifier: {
                  // Use the on-disk basename, NOT the community title. The
                  // file's actual name is the only thing the user (and any
                  // post-import consumer) can verify against — community
                  // titles can drift from filename, and importers see UUID
                  // paths anyway.
                  name: deriveBasenameForLoadedClassifier(selectedClassifierPath, classifier.name),
                  source: classifier.source,
                  path: selectedClassifierPath,
                  author: classifier.author,
                  savedAt: classifier.savedAt,
                  // Remember the original community id so a later "Publish workflow"
                  // can reuse it instead of re-uploading the same .tlcls. Prefer the
                  // explicit community pick; otherwise fall back to the `inherit_from`
                  // lineage read off a locally-loaded / shared .tlcls.
                  ...((classifier.source === "community" && classifier.id)
                    ? { communityId: classifier.id }
                    : inheritedCommunityId
                      ? { communityId: inheritedCommunityId }
                      : {}),
                },
              }
            : n
        )
      )
      // Train mode turns ON the update intent so the run continues-trains and
      // writes back. Load mode clears it — otherwise the panel re-derives
      // save_classifier_path from a stale updateClassifier flag and the old save
      // path carries over to the newly loaded classifier.
      dispatch(setUpdateClassifier(isTrain))
      setClassifierLoadOpen(false)
      toast.success(
        isTrain
          ? `Training "${classifier.name}" — new annotations will update this cloud classifier`
          : classifier.source === "community"
            ? `Imported community classifier "${classifier.name}" into ${node.label || node.modelId}`
            : classifier.source === "folder"
              ? `Loaded "${classifier.name}" from current folder into ${node.label || node.modelId}`
              : `Loaded "${classifier.name}" into ${node.label || node.modelId}`
      )
    },
    [activeWf, classifierContextNodeId, classifierLoadTargetClass, setNodes, currentPath, selectedFolder, isWebMode, dispatch]
  )

  /**
   * Scan imported panelStates for `community:<id>` classifier refs, download
   * each to the current slide's folder, then return a clone of the workflow
   * with refs rewritten to the local on-disk paths. Missing or failed downloads
   * are left as `community:` refs so the user can manually Load Classifier later.
   *
   * No-op (returns the input unchanged) when nothing to download.
   */
  const ensureCommunityClassifiersResolved = useCallback(
    async (wf: SerializedWorkflow): Promise<SerializedWorkflow> => {
      const panelStates = wf.panelStates as Record<string, WorkflowPanel>
      const refs = extractClassifierPathRefs(panelStates, (wf.nodes as GraphNode[]) || [])
      // Unique refs by raw path so the same shared classifier is only downloaded once.
      const refPathToId = new Map<string, string>()
      for (const r of refs) {
        if (r.kind !== "community" || !r.communityId) continue
        if (!refPathToId.has(r.path)) refPathToId.set(r.path, r.communityId)
      }
      if (refPathToId.size === 0) return wf

      // Drop downloads next to the active slide — that's where loadClassifierIntoNode
      // also writes, so the imported and manually-loaded classifiers share a folder.
      let folder = ""
      if (currentPath) {
        const norm = formatPath(currentPath)
        const sep = norm.includes("\\") ? "\\" : "/"
        const idx = norm.lastIndexOf(sep)
        folder = idx > 0 ? norm.slice(0, idx) : norm
      } else if (selectedFolder) {
        folder = formatPath(selectedFolder.trim())
      }
      if (!folder) {
        toast.error(
          "Open a slide before importing — its folder is needed to download referenced community classifiers."
        )
        return wf
      }
      const sep = folder.includes("\\") ? "\\" : "/"

      const refPathToLocalPath = new Map<string, string>()
      const toastId = toast.loading(`Importing ${refPathToId.size} community classifier(s)…`)
      setWorkflowHydration({ done: 0, total: refPathToId.size })
      try {
      let done = 0
      for (const [refPath, communityId] of refPathToId.entries()) {
        done += 1
        toast.loading(`Importing classifier ${done}/${refPathToId.size}…`, { id: toastId })
        setWorkflowHydration({ done, total: refPathToId.size })
        try {
          const { bytes, fileName: cloudFileName } = await classifiersService.downloadClassifier(communityId)
          // Mirror the cloud filename locally — the server stores under the
          // UUID-based fileName, so the local copy uses the same name and
          // any subsequent re-download lands at the same path. Legacy
          // download-link responses without file_name fall back to
          // `<communityId>.tlcls` to match the old convention.
          const fileName = cloudFileName
            || (communityId.toLowerCase().endsWith(".tlcls") ? communityId : `${communityId}.tlcls`)
          const destFull = `${folder.replace(/[/\\]+$/, "")}${sep}${fileName}`
          const apiPath = isWebMode
            ? normalizePathForSegClassifierApi(destFull)
            : destFull.replace(/\\/g, "/")
          let binary = ""
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          }
          await saveClassifierFileOnServer(
            { path: apiPath, content_base64: btoa(binary) })
          refPathToLocalPath.set(refPath, destFull)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          // Leave this ref alone; user can manually Load Classifier later.
          toast.error(`Failed to download "${communityId}": ${msg}`)
        }
      }

      if (refPathToLocalPath.size === 0) {
        toast.error("No community classifiers could be imported — refs left in place.", { id: toastId })
        return wf
      }
      if (refPathToLocalPath.size < refPathToId.size) {
        toast.warning(
          `Downloaded ${refPathToLocalPath.size}/${refPathToId.size} classifiers — failed refs remain as community: links.`,
          { id: toastId }
        )
      } else {
        toast.success(`Downloaded ${refPathToLocalPath.size} community classifier(s).`, { id: toastId })
      }

      // Also refresh the file browser so the new files appear under "Current folder".
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("refresh-file-list"))
      }

      const rewritten = rewriteCommunityRefsToLocalPaths(panelStates, refPathToLocalPath)
      // Also push the local UUID path onto each node's loadedClassifier.path
      // so importer's audit snapshot matches the actual file on disk
      // (instead of carrying the owner's display-name path forever).
      const rewrittenNodes = rewriteLoadedClassifierRefsToLocalInNodes(
        (wf.nodes ?? []) as GraphNode[],
        refPathToLocalPath
      )
      return {
        ...wf,
        nodes: rewrittenNodes,
        panelStates: rewritten as unknown as Record<string, unknown>,
      }
      } finally {
        // Clear the modal whether the loop succeeded, returned mid-way, or
        // threw — the loaded workflow is now ready (or known-failed) and
        // the user should be able to interact with the graph again.
        setWorkflowHydration(null)
      }
    },
    [currentPath, selectedFolder, isWebMode]
  )

  const handleLoadFromStorage = useCallback(
    async (name: string) => {
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
      const resolved = await ensureCommunityClassifiersResolved(wf)
      restoreSavedWorkflowPanelsAndChat(resolved)
      toast.success(`Loaded "${name}"`)
    },
    [restoreSavedWorkflowPanelsAndChat, ensureCommunityClassifiersResolved]
  )

  // Load a preset community workflow (default JSON until online DB is wired).
  const handleLoadCommunityWorkflow = useCallback(
    async (wf: CommunityWorkflow) => {
      const loaded: Workflow = {
        id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: wf.name,
        nodes: normalizeWorkflowGraphNodes(wf.nodes as GraphNode[]),
        connections: wf.connections,
        selectedId: wf.selectedId,
      }
      setWorkflows((prev) => [...prev, loaded])
      setActiveWfId(loaded.id)
      setLoadDialogOpen(false)
      const resolved = await ensureCommunityClassifiersResolved(wf as SerializedWorkflow)
      restoreSavedWorkflowPanelsAndChat(resolved)
      toast.success(`Loaded "${wf.name}"`)
    },
    [restoreSavedWorkflowPanelsAndChat, ensureCommunityClassifiersResolved]
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
    const runtimeContext = buildRuntimeContextSnapshot()
    const payload: SerializedWorkflow = {
      name: activeWf.name,
      nodes: activeWf.nodes,
      connections: activeWf.connections,
      savedAt: new Date().toISOString(),
      panelStates: collectPanelStatesSnapshot(activeWf.nodes, panelStates),
      chatMessages: JSON.parse(JSON.stringify(chatMessages)) as ChatMessage[],
      selectedId: activeWf.selectedId ?? null,
      ...(runtimeContext ? { runtimeContext } : {}),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const safeName = activeWf.name.replace(/[^a-z0-9_\-]+/gi, "_") || "workflow"
    const a = document.createElement("a")
    a.href = url
    a.download = `${safeName}.workflow.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [activeWf, panelStates, chatMessages, buildRuntimeContextSnapshot, currentPath])

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
        const resolved = await ensureCommunityClassifiersResolved(wf)
        restoreSavedWorkflowPanelsAndChat(resolved)
        toast.success(`Imported "${loaded.name}"`)
      } catch {
        toast.error("Failed to parse workflow file")
      }
    }
    input.click()
  }, [restoreSavedWorkflowPanelsAndChat, ensureCommunityClassifiersResolved, currentPath])

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
  // Inline the graph as a compact horizontal strip; the full editable canvas opens
  // in a popup ("expand"). graphExpanded drives that Dialog.
  const [graphExpanded, setGraphExpanded] = useState(false)
  // Lay the chain out left→right using the (popup) canvas size; reused by the
  // expand effect and the popup's Auto Layout button.
  const layoutHorizontalNow = useCallback(() => {
    // Layout box size (clientWidth/Height ignores the dialog's zoom-in transform,
    // so measurements are correct even mid-animation).
    const el = canvasRef.current
    const w = el?.clientWidth || 640
    const h = el?.clientHeight || 420
    updateActiveWf((wf) => ({
      ...wf,
      nodes: layoutChainHorizontally(wf.nodes, wf.connections, {
        centerY: h / 2,
        canvasClientWidth: w,
      }),
      // Horizontal chain → edges exit the right side and enter the left, so arrows
      // point left→right instead of the vertical bottom→top.
      connections: wf.connections.map((c) => ({ ...c, fromPort: "right" as const, toPort: "left" as const })),
    }))
    setPanOffset({ x: 0, y: 0 })
  }, [updateActiveWf])
  // Lay out horizontally once the expanded popup canvas is mounted & measured.
  // rAF waits for the dialog to lay out so start/end (and everything) land in the
  // right spots even for an empty graph on first open.
  useEffect(() => {
    if (!graphExpanded) return
    const id = requestAnimationFrame(() => layoutHorizontalNow())
    return () => cancelAnimationFrame(id)
  }, [graphExpanded, layoutHorizontalNow])
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
    (modelId: string, afterNodeId?: string) => {
      updateActiveWf((wf) => {
        const prev = wf.nodes
        const start = prev.find((n) => n.id === START_NODE_ID)
        const end = prev.find((n) => n.id === END_NODE_ID)
        const subStages = createInitialSubStages(modelId)
        const initialProgress = getInitialModelProgress(modelId, subStages)
        // x/y are placeholders — layoutChainVertically below assigns final positions.
        const newNode: GraphNode = {
          id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: "model",
          modelId,
          x: 0,
          y: 0,
          progress: subStages ? undefined : initialProgress,
          subStages,
        }

        // Orientation follows the current view: horizontal (right→left ports) while
        // the expanded popup is open, vertical (bottom→top) otherwise.
        const horizontal = graphExpanded
        const fromPort = horizontal ? ("right" as const) : ("bottom" as const)
        const toPort = horizontal ? ("left" as const) : ("top" as const)

        // Auto-chain serially: splice the new node onto the tail of the current
        // chain. If a node currently feeds END, insert before it; otherwise chain
        // off the last model node, or START when the graph is empty.
        const conns = [...wf.connections]
        let tailId: string | null = null
        let nextId: string | null = null
        if (afterNodeId && prev.some((node) => node.id === afterNodeId)) {
          tailId = afterNodeId
          const outgoingIdx = conns.findIndex((connection) => connection.fromId === afterNodeId)
          if (outgoingIdx >= 0) {
            nextId = conns[outgoingIdx].toId
            conns.splice(outgoingIdx, 1)
          }
        } else {
          const toEndIdx = conns.findIndex((c) => c.toId === END_NODE_ID)
          if (toEndIdx >= 0) {
            tailId = conns[toEndIdx].fromId
            nextId = END_NODE_ID
            conns.splice(toEndIdx, 1)
          } else {
            const lastModel = [...prev].reverse().find((n) => n.kind === "model")
            tailId = lastModel ? lastModel.id : start ? START_NODE_ID : null
            nextId = end ? END_NODE_ID : null
          }
        }
        const cid = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        if (tailId) {
          conns.push({ id: `${cid}-a`, fromId: tailId, toId: newNode.id, fromPort, toPort })
        }
        if (nextId) {
          conns.push({ id: `${cid}-b`, fromId: newNode.id, toId: nextId, fromPort, toPort })
        }
        // Normalize every edge to the current orientation's ports so old and new
        // edges point the same way.
        const orientedConns = conns.map((c) => ({ ...c, fromPort, toPort }))

        // Auto-tidy the whole chain so the spliced-in node lines up cleanly.
        const rect = canvasRef.current?.getBoundingClientRect()
        const nodes = horizontal
          ? layoutChainHorizontally([...prev, newNode], orientedConns, {
              centerY: (rect?.height ?? 420) / 2,
              canvasClientWidth: rect?.width,
            })
          : layoutChainVertically([...prev, newNode], orientedConns, {
              centerX: rect ? rect.width / 2 : 200,
              canvasClientHeight: rect?.height,
              dockStripHeight,
            })

        return { ...wf, nodes, connections: orientedConns }
      })
      // Recenter the viewport so the newly added node is in view.
      setPanOffset({ x: 0, y: 0 })
    },
    [updateActiveWf, dockStripHeight, setPanOffset, graphExpanded]
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
    // initialNodes() is a vertical Start/End; keep the expanded popup horizontal.
    if (graphExpanded) layoutHorizontalNow()
  }, [updateActiveWf, graphExpanded, layoutHorizontalNow])

  const updateNodeField = useCallback(
    (id: string, patch: Partial<Pick<GraphNode, "label" | "description">>) => {
      setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)))
    },
    [setNodes]
  )

  const setClassifierMode = useCallback(
    (id: string, mode: "multiclass" | "one-vs-rest") => {
      setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, classifierMode: mode } : n)))
      // Also persist into panel.content so the mode reaches the tasknode on ANY
      // run path — the graph/workflow-level Run serializes panel.content into
      // userData and does NOT see node.classifierMode (that only lives on the
      // node object, which the ClassificationPanel's own Run reads). Without this
      // an OvR run launched from the graph falls back to multiclass/zero-shot.
      const node = activeWf.nodes.find((n) => n.id === id)
      if (!node) return
      setPanelStates((prev) => {
        const base = prev[id] ?? buildLegacyPanelFromNode(node)
        if (!base) return prev
        const nextContent = upsertContentStringValue(base.content, "classifier_mode", mode)
        return { ...prev, [id]: { ...base, content: nextContent } }
      })
    },
    [setNodes, activeWf.nodes]
  )

  const clearLoadedClassifier = useCallback(
    (id: string) => {
      setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, loadedClassifier: undefined } : n)))
      // The panel banner falls back to the FileBrowser selection in Redux, so a
      // node-only clear would leave "Selected Classifier" behind. Clear both,
      // exactly like the banner's own X does (which also drops update mode).
      let targetPath = selectedFolder || ""
      if (!targetPath && currentPath) {
        const separator = isWebMode ? "/" : currentPath.includes("\\") ? "\\" : "/"
        const lastIndex = currentPath.lastIndexOf(separator)
        targetPath = lastIndex !== -1 ? currentPath.substring(0, lastIndex) : isWebMode ? "" : currentPath
      }
      dispatch(clearSelectedModelForPath(targetPath))
      dispatch(setUpdateClassifier(false))
      setPanelStates((prev) => {
        const panel = prev[id]
        if (!panel) return prev
        return {
          ...prev,
          [id]: {
            ...panel,
            content: removeClassifierPathContent(panel.content).filter(
              (item) => item.key !== "classifier_display_name"
            ),
          },
        }
      })
      toast.message("Classifier load cleared")
    },
    [setNodes, dispatch, selectedFolder, currentPath, isWebMode]
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
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
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
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
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
  // In the expanded popup the graph is horizontal and roomy — no vertical
  // compression, so Start/End line up with the model row. Inline strip mode never
  // renders the canvas, so this only affects the popup.
  const yScale = useMemo(
    () => (graphExpanded ? 1 : computeWorkflowYScale(wrapperH, canvasSize.h || 0)),
    [graphExpanded, wrapperH, canvasSize.h]
  )
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
    // Recenter the viewport so the freshly laid-out graph is in view.
    setPanOffset({ x: 0, y: 0 })
  }, [nodes, connections, setNodes, canvasSize, setPanOffset])

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
  const showBatchBanner = !!activeBatchEntry
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
      dismissWorkflowBatchRuntimeEntry()
    }
  }, [isBatchRunning])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      {/* ─── Top: Save / Load / Tutorial bar ─── */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card/60 px-2 py-1.5">
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
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 pt-1.5">
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {workflows.map((wf) => {
            const isActive = wf.id === activeWfId
            const isRenaming = renamingWfId === wf.id
            return (
              <div
                key={wf.id}
                onClick={() => setActiveWfId(wf.id)}
                onDoubleClick={() => startRenameWorkflow(wf)}
                className={`group flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs transition-colors ${
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
            className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title="New workflow"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ─── Toolbar ─── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        <Button size="sm" variant="default" className="h-8" onClick={() => setImportOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          Add Node
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {isBatchRunning ? (
            <>
              <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => setBatchDialogOpen(true)}>
                <ListChecks className="h-3.5 w-3.5" />
                Details
              </Button>
              <Button size="sm" variant="destructive" className="h-8 gap-1" onClick={stopWorkflow} disabled={isStoppingWorkflow}>
                <Square className="h-3.5 w-3.5 fill-current" />
                {isStoppingWorkflow ? "Stopping..." : "Stop Batch"}
              </Button>
            </>
          ) : isRunning || isWorkflowRuntimeActive(workflowStatus) ? (
            <Button size="sm" variant="destructive" className="h-8 gap-1" onClick={stopWorkflow} disabled={isStoppingWorkflow}>
              <Square className="h-3.5 w-3.5 fill-current" />
              {isStoppingWorkflow ? "Stopping..." : "Stop"}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1"
                onClick={() => setBatchDialogOpen(true)}
                disabled={modelNodeCount === 0 || !pathWritable}
                title={!pathWritable ? writeBlockTitle : modelNodeCount === 0 ? "Add at least one model node first" : "Batch process workflow"}
              >
                <ListChecks className="h-3.5 w-3.5" />
                Batch
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={runWorkflow}
                disabled={modelNodeCount === 0 || !pathWritable}
                title={!pathWritable ? writeBlockTitle : modelNodeCount === 0 ? "Add at least one model node first" : "Run workflow"}
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                Run
              </Button>
            </>
          )}
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

      {/* Modal overlay shown while a loaded workflow's referenced community
          classifiers are being fetched. Blocking is the whole point — if the
          user clicks Run before the .tlcls files land on disk, the run starts
          with stale or missing classifier paths and either fails or trains
          from scratch silently. */}
      <Dialog open={!!workflowHydration}>
        {/* Hide the auto-rendered close X — letting the user dismiss this
            modal would defeat the point (they could click Run before the
            classifiers finish landing on disk). */}
        <DialogContent
          className="sm:max-w-sm [&>button.absolute]:hidden"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading workflow…
            </DialogTitle>
            <DialogDescription>
              {workflowHydration
                ? `Importing classifier ${Math.min(workflowHydration.done, workflowHydration.total)} of ${workflowHydration.total}. The graph will unlock when every classifier is on disk.`
                : ""}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

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

      {/* Classifier publish — modal instead of a corner toast (room for a conflicts step). */}
      <Dialog
        open={!!publishDialog?.open}
        onOpenChange={(open) => {
          if (open) return
          // Mid-publish can't be dismissed. Closing the conflicts phase = "Publish later".
          if (publishDialog?.phase === "conflicts") resolvePublishConflict(false)
          else if (publishDialog?.phase !== "working") setPublishDialog(null)
        }}
      >
        <DialogContent className={publishDialog?.phase === "conflicts" ? "sm:max-w-lg" : "sm:max-w-md"}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {(publishDialog?.phase === "error" || publishDialog?.phase === "conflicts") && (
                <AlertTriangle className="h-4 w-4 text-destructive" />
              )}
              {publishDialog?.title}
            </DialogTitle>
          </DialogHeader>
          {publishDialog?.phase === "working" && (
            <div className="flex flex-col gap-2 py-1">
              <span className="text-sm text-muted-foreground">{publishDialog.message}</span>
              {publishProgressBar(publishDialog.pct)}
            </div>
          )}
          {publishDialog?.phase === "success" && (
            <p className="text-sm text-muted-foreground">{publishDialog.message}</p>
          )}
          {publishDialog?.phase === "error" && (
            <p className="break-words text-sm text-destructive">{publishDialog.message}</p>
          )}
          {publishDialog?.phase === "conflicts" && (
            <div className="flex flex-col gap-3">
              <ConflictContourDefs />
              <p className="text-sm text-muted-foreground">
                Some of your annotations are nearly identical to samples the current published version labels
                differently. Please double-check before publishing.
              </p>
              <div className="max-h-80 divide-y divide-border/60 overflow-auto rounded-md border border-border">
                {(publishDialog.conflicts ?? []).map((c, i) => (
                  <div key={i} className="px-3 py-2 text-xs">
                    <div className="font-medium">
                      You: <span className="text-primary">{c.your_class}</span>
                      <span className="mx-1 text-muted-foreground">↔</span>
                      Current: <span className="text-destructive">{c.current_class}</span>
                      <span className="ml-2 font-normal text-muted-foreground">
                        {c.count} sample{c.count > 1 ? "s" : ""} · up to {Math.round((c.max_similarity || 0) * 100)}% similar
                      </span>
                    </div>
                    <ContourStrip
                      label={`You: ${c.your_class}`}
                      tone="you"
                      regions={c.your_regions}
                      total={c.your_regions_total}
                    />
                    <ContourStrip
                      label={`Current: ${c.current_class}`}
                      tone="current"
                      regions={c.current_regions}
                      total={c.current_regions_total}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            {publishDialog?.phase === "conflicts" ? (
              <>
                <Button variant="outline" onClick={() => resolvePublishConflict(false)}>
                  Publish later
                </Button>
                <Button onClick={() => resolvePublishConflict(true)}>Publish anyway</Button>
              </>
            ) : publishDialog?.phase !== "working" ? (
              <Button onClick={() => setPublishDialog(null)}>Close</Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-vs-Rest Save: pick classes to train, each its own .tlcls + publish toggle */}
      <Dialog open={!!ovrSave} onOpenChange={(o) => { if (!o) setOvrSave(null) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Train classifiers · One-vs-Rest</DialogTitle>
          </DialogHeader>
          {ovrSave && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                Pick the classes to train. Each becomes its own binary <span className="font-mono">.tlcls</span>;
                one run trains them all. Toggle <span className="font-medium">Publish</span> per class to push it to
                the community — each is independent.
              </p>
              {(() => {
                const taken = new Set(ovrSave.rows.map((r) => r.className))
                const options = ovrSave.classes.filter((c) => !taken.has(c))
                return (
                  <select
                    value=""
                    disabled={options.length === 0}
                    onChange={(e) => {
                      const c = e.target.value
                      if (!c) return
                      setOvrSave((prev) => (prev ? { ...prev, rows: [...prev.rows, { className: c, saveName: c, publish: false }] } : prev))
                    }}
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                  >
                    <option value="">{options.length ? "+ Add a class…" : "All classes added"}</option>
                    {options.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                )
              })()}
              <div className="flex flex-col divide-y divide-border/60 rounded-md border border-border">
                {ovrSave.rows.length === 0 ? (
                  <div className="px-3 py-3 text-center text-xs text-muted-foreground">Add a class above to start.</div>
                ) : (
                  ovrSave.rows.map((r, i) => (
                    <div key={r.className} className="flex items-center gap-2 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={r.className}>{r.className}</span>
                      <Input
                        value={r.saveName}
                        onChange={(e) => setOvrSave((prev) => (prev ? { ...prev, rows: prev.rows.map((x, j) => (j === i ? { ...x, saveName: e.target.value } : x)) } : prev))}
                        placeholder="file name"
                        className="h-7 w-36 text-xs"
                      />
                      <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Checkbox
                          checked={r.publish}
                          onCheckedChange={(v) => setOvrSave((prev) => (prev ? { ...prev, rows: prev.rows.map((x, j) => (j === i ? { ...x, publish: v === true } : x)) } : prev))}
                        />
                        Publish
                      </label>
                      <button
                        type="button"
                        title="Remove"
                        className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setOvrSave((prev) => (prev ? { ...prev, rows: prev.rows.filter((_, j) => j !== i) } : prev))}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOvrSave(null)}>Cancel</Button>
            <Button onClick={() => void submitOvrSave()} disabled={!ovrSave || ovrSave.rows.length === 0}>
              Train{ovrSave?.rows.length ? ` (${ovrSave.rows.length})` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WorkflowBatchDialog
        open={batchDialogOpen}
        onOpenChange={setBatchDialogOpen}
        files={batchCandidateFiles}
        selectedFolder={selectedFolder}
        isRunning={isBatchRunning || isBatchPreparing}
        isStopping={isStoppingWorkflow}
        activeEntry={activeBatchEntry}
        historyEntries={batchHistoryEntries}
        onStart={runWorkflowBatch}
        onStop={stopWorkflow}
        onClearHistory={clearBatchHistory}
      />

      {showBatchBanner && activeBatchEntry && (
        <div
          className={`flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs ${batchBannerToneClass}`}
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
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
              <div className="shrink-0 text-[10px] tabular-nums">
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
              className="h-7 w-7 shrink-0 text-current opacity-70 hover:opacity-100"
              aria-label="Dismiss batch progress"
              onClick={() => {
                dismissWorkflowBatchRuntimeEntry()
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      {/* Inline: compact horizontal dot-strip overview (nodes = dots, fill = progress). */}
      <WorkflowChainStrip
        nodes={nodes}
        connections={connections}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId(id)}
        onExpand={() => setGraphExpanded(true)}
        runningId={runningId}
        progressById={runtimeNodeProgressById}
      />

      {/* Expanded: full editable graph in a popup, laid out horizontally. */}
      <Dialog open={graphExpanded} onOpenChange={setGraphExpanded}>
        <DialogContent className="flex h-[85vh] max-w-[95vw] flex-col overflow-hidden p-0 sm:max-w-[95vw]">
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
            <Button size="sm" variant="default" className="h-8" onClick={() => setImportOpen(true)}>
              <Plus className="mr-1 h-4 w-4" />
              Add Node
            </Button>
            <Button size="sm" variant="outline" className="h-8" onClick={layoutHorizontalNow}>
              <LayoutGrid className="mr-1 h-4 w-4" />
              Auto Layout
            </Button>
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
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
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
        writeDisabled={!pathWritable}
        writeDisabledTitle={writeBlockTitle}
        deleteConnection={deleteConnection}
        handleNodeMouseDown={handleNodeMouseDown}
        handleNodeDoubleClick={handleNodeDoubleClick}
        handleOutputPortMouseDown={handleOutputPortMouseDown}
        handleInputPortMouseUp={handleInputPortMouseUp}
        deleteNode={deleteNode}
        runOneNode={runOneNode}
      />
          </div>
        </DialogContent>
      </Dialog>

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
        allNodes={nodes}
        onSelectNode={setSelectedId}
        runningId={runningId}
        isRunning={isRunning}
        isStoppingWorkflow={isStoppingWorkflow}
        stopWorkflow={stopWorkflow}
        runStage={runStage}
        runOneNode={runOneNode}
        runAllSubstages={runAllSubstages}
        writeDisabled={!pathWritable}
        writeDisabledTitle={writeBlockTitle}
        addModelNode={addNode}
        graphStartWorkflow={startWorkflowFromPanel}
        openNodeLogs={openNodeLogs}
        openClassifierSave={openClassifierSave}
        openClassifierLoad={openClassifierLoad}
        openClassifierLoadForClass={openClassifierLoadForClass}
        publishToTissueLab={publishToTissueLab}
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
        refreshClassifierLists={refreshClassifierLists}
        folderClassifiers={folderClassifierOptions}
        folderClassifiersScanPath={classifierListingFolder}
        isWebMode={isWebMode}
        loadClassifierIntoNode={loadClassifierIntoNode}
        saveClassifierFile={saveClassifierFile}
        classifierDownloadId={classifierDownload?.id ?? null}
        classifierDownloadPct={classifierDownload?.pct ?? 0}
        tutorialOpen={tutorialOpen}
        setTutorialOpen={setTutorialOpen}
        loadDialogOpen={loadDialogOpen}
        setLoadDialogOpen={setLoadDialogOpen}
        loadSearch={loadSearch}
        setLoadSearch={setLoadSearch}
        communityWorkflows={communityWorkflows}
        communityWorkflowsLoading={communityWorkflowsLoading}
        refreshLoadDialogLists={refreshLoadDialogLists}
        savedList={savedList}
        handleLoadCommunityWorkflow={handleLoadCommunityWorkflow}
        handleLoadFromStorage={handleLoadFromStorage}
        handleDeleteSaved={handleDeleteSaved}
        handleImportFile={handleImportFile}
        handleExportFile={handleExportFile}
        pendingPublish={
          pendingWorkflowPublish
            ? {
                workflowName: pendingWorkflowPublish.workflowName,
                localClassifiers: pendingWorkflowPublish.localItems.map((i) => ({
                  displayName: i.ref.displayName,
                  path: i.ref.path,
                })),
              }
            : null
        }
        publishInFlight={publishInFlight}
        onConfirmPublish={() => {
          if (pendingWorkflowPublish) void finalizeWorkflowPublish(pendingWorkflowPublish)
        }}
        onCancelPublish={() => setPendingWorkflowPublish(null)}
      />
    </div>
  )
}

export default WorkflowGraph
