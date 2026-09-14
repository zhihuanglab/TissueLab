"use client";
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useRouter } from 'next/router'
import { useUserInfo } from '@/contexts/UserInfoProvider'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ChevronDown, ChevronRight, Database, GitBranch, Boxes, Circle, PlayCircle, Square, Trash2, Workflow, X } from "lucide-react"
import Image from "next/image"
import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config'
import { classifiersService } from '@/services/classifier/community'
import { deleteCommunityWorkflow } from '@/services/communityWorkflows.service'
import { modelsService } from '@/services/models.service'
import NodeLogsDialog from '@/components/imageViewer/sidebar/agent/graph/NodeLogsDialog'
import DownloadArea from '@/components/community/DownloadArea'
import WorkflowAnatomy from '@/components/community/WorkflowAnatomy'
import { getErrorMessage } from '@/utils/common/apiResponse'
import { toast } from 'sonner'

// Import refactored modules
import {
  ClassifierCard,
  DatasetCard,
  FactoryTaskNodeCard,
  FactoryClassifierDetail,
  UploadClassifierDialog,
  UploadModelDialog
} from '@/components/community'
import { useFactoryNodes, useClassifiers, useClassifierFilter } from '@/hooks/community/useCommunityData'
import { useAuthorProfile } from '@/hooks/community/useAuthorProfile'
import { useNodeInstallation } from '@/hooks/community/useNodeInstallation'
import { useNodeActivation } from '@/hooks/community/useNodeActivation'
import { useClassifierUpload } from '@/hooks/community/useClassifierUpload'
import { useModelUpload } from '@/hooks/community/useModelUpload'
import { apiFetch } from '@/utils/common/apiFetch'
import { COMMUNITY_API_ENDPOINT } from '@/config/api.config'
import {
  ITEMS_PER_PAGE,
  INSTALL_STEPS_INITIAL,
  FACTORY_WHITELIST_CONFIG
} from '@/constants/community.constants'
import { deleteNode, downloadNodeForElectron } from '@/utils/agent/nodeManagement.utils'
import type { 
  ActiveTab, 
  FactoriesView,
  DatasetData,
  TaskNodeData,
  TaskNodeModelData,
  ModelData,
  SortOption
} from '@/types/community.types'
import type { CommunityWorkflow } from "@/constants/communityWorkflowsDefault"
import {
  communityWorkflowToSerializedSnapshot,
  loadMergedCommunityWorkflowPresets,
} from "@/utils/agent/workflow/communityPresets"
import {
  importWorkflowSnapshotToLocalLibrary,
  loadAllSavedWorkflows,
  notifyWorkflowLocalStorageChanged,
  writeAllSavedWorkflows,
  WORKFLOW_GRAPH_SAVED_STORAGE_KEY,
  WORKFLOW_LOCAL_STORAGE_CHANGED_EVENT,
  type SerializedWorkflow,
} from "@/utils/agent/workflow/serializedWorkflow"

const mockDatasets: DatasetData[] = []

// Preferred display order for factory categories on the Community page.
// Categories not listed keep their original (backend) order, after these.
const FACTORY_ORDER = ["NucleiClassify", "NucleiSeg", "TissueSeg", "TissueClassify"]
const factoryRank = (key: string) => {
  const i = FACTORY_ORDER.indexOf(key)
  return i === -1 ? FACTORY_ORDER.length : i
}
const orderFactoryKeys = (keys: string[]) =>
  [...keys].sort((a, b) => factoryRank(a) - factoryRank(b))
const orderFactoryEntries = (entries: [string, string[]][]) =>
  [...entries].sort((a, b) => factoryRank(a[0]) - factoryRank(b[0]))

// ── Official (TissueLab-authored) classifiers ─────────────────────────────
// Shown under a model via a Community / Official filter; official ones are
// grouped by organ, derived from the seeded id `tissuelab-<organ>-<slug>`.
const ORGAN_LABELS: Record<string, string> = {
  skin: "Skin", prostate: "Prostate", breast: "Breast", colon: "Colon / Rectum",
  lung: "Lung", lymph_node: "Lymph node", bladder: "Bladder", gastric: "Stomach / GI",
  pancreas: "Pancreas", liver: "Liver", kidney: "Kidney", agnostic: "General",
}
const ORGAN_ORDER = ["skin", "prostate", "breast", "colon", "lung", "lymph_node", "bladder", "gastric", "pancreas", "liver", "kidney", "agnostic"]
// Official classifiers are TissueLab-owned. The community-page merge maps
// ownerId into author.user_id (not a top-level ownerId), so check all shapes;
// the id prefix `tissuelab-…` (seeded ids; user uploads are `uploaded-…`) is
// the most reliable signal.
const isOfficialClassifier = (c: any) =>
  c?.ownerId === "tissuelab" ||
  c?.author?.user_id === "tissuelab" ||
  String(c?.id || "").startsWith("tissuelab-")
const organOfClassifier = (id: string) => {
  const m = /^tissuelab-([a-z_]+)-/.exec(id || "")
  return m ? m[1] : "agnostic"
}

type CommunityWorkflowModelNode = CommunityWorkflow["nodes"][number] & { kind: "model" }

function communityWorkflowModelSteps(wf: CommunityWorkflow): { label: string; type: string }[] {
  return wf.nodes
    .filter((n): n is CommunityWorkflowModelNode => n.kind === "model")
    .map((n) => ({
      label: n.label || n.modelId || "Model",
      type: n.modelId || "model",
    }))
}

function countSerializedModelNodes(wf: SerializedWorkflow): number {
  return wf.nodes.filter(
    (n) => typeof n === "object" && n !== null && (n as { kind?: string }).kind === "model"
  ).length
}

function CommunityWorkflowsPanel() {
  const { userInfo } = useUserInfo()
  const [workflows, setWorkflows] = useState<CommunityWorkflow[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedWorkflow, setSelectedWorkflow] = useState<CommunityWorkflow | null>(null)
  // Resolve the selected workflow's author display name per-uid (browser-
  // cached). Falls back to the legacy denormalized `author` string when no
  // profile is found (e.g. for community presets that have no ownerId).
  const selectedAuthorProfile = useAuthorProfile(selectedWorkflow?.ownerId)
  const [importing, setImporting] = useState(false)
  const [libraryTick, setLibraryTick] = useState(0)
  const [libraryDeleteKey, setLibraryDeleteKey] = useState<string | null>(null)
  const [pendingWorkflowDelete, setPendingWorkflowDelete] = useState<CommunityWorkflow | null>(null)
  const [workflowDeleteInFlight, setWorkflowDeleteInFlight] = useState(false)

  const performWorkflowDelete = useCallback(async (wf: CommunityWorkflow) => {
    setWorkflowDeleteInFlight(true)
    try {
      const resp = await deleteCommunityWorkflow(wf.id)
      if (!resp?.success) {
        toast.error("Workflow deletion did not complete cleanly.")
        return
      }
      setWorkflows((prev) => prev.filter((w) => w.id !== wf.id))
      setSelectedWorkflow((cur) => (cur?.id === wf.id ? null : cur))
      toast.success(`Deleted "${wf.name}" from community.`)
    } catch (e) {
      toast.error(getErrorMessage(e, "Failed to delete community workflow"))
    } finally {
      setWorkflowDeleteInFlight(false)
      setPendingWorkflowDelete(null)
    }
  }, [])

  const refreshLibrary = useCallback(() => {
    setLibraryTick((t) => t + 1)
  }, [])

  const libraryEntries = useMemo(() => {
    const all = loadAllSavedWorkflows()
    return Object.entries(all).sort(([, a], [, b]) =>
      (b.savedAt || "").localeCompare(a.savedAt || "")
    )
  }, [libraryTick])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadMergedCommunityWorkflowPresets()
      .then((list) => {
        if (!cancelled) setWorkflows(list)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const sync = () => refreshLibrary()
    const onStorage = (e: StorageEvent) => {
      if (e.key === WORKFLOW_GRAPH_SAVED_STORAGE_KEY || e.key === null) sync()
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener(WORKFLOW_LOCAL_STORAGE_CHANGED_EVENT, sync as EventListener)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(WORKFLOW_LOCAL_STORAGE_CHANGED_EVENT, sync as EventListener)
    }
  }, [refreshLibrary])

  const performDeleteLibraryItem = useCallback(
    (storageKey: string): boolean => {
      const all = loadAllSavedWorkflows()
      delete all[storageKey]
      const wrote = writeAllSavedWorkflows(all)
      if (!wrote.ok) {
        toast.error(
          wrote.reason === "quota"
            ? "Storage quota exceeded — could not update My Library."
            : "Could not update My Library."
        )
        return false
      }
      notifyWorkflowLocalStorageChanged()
      refreshLibrary()
      toast.message(`Removed "${storageKey}"`)
      return true
    },
    [refreshLibrary]
  )

  const handleImport = useCallback(() => {
    if (!selectedWorkflow || importing) return
    setImporting(true)
    try {
      const snapshot = communityWorkflowToSerializedSnapshot(selectedWorkflow)
      const result = importWorkflowSnapshotToLocalLibrary(snapshot)
      if (!result.ok) {
        toast.error(
          result.reason === "quota"
            ? "Storage quota exceeded — could not save to My Library."
            : "Could not save workflow to My Library."
        )
        return
      }
      toast.success(`Imported as "${result.storageKey}"`)
      refreshLibrary()
    } finally {
      setImporting(false)
    }
  }, [selectedWorkflow, importing, refreshLibrary])

  const fmtSavedAt = (iso: string) => {
    if (!iso) return ""
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }

  return (
    <>
    <div className="flex min-h-0 flex-1 flex-col gap-8 pb-8">
      <div className="flex min-h-[280px] flex-1 gap-4">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="mb-3 text-sm font-medium text-muted-foreground">
            Community workflows ({workflows.length})
          </div>
          {loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Loading workflows…
            </div>
          ) : workflows.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              No community workflows available.
            </div>
          ) : (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {workflows.map((wf) => {
                const steps = communityWorkflowModelSteps(wf)
                return (
                  <div
                    key={wf.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                      selectedWorkflow?.id === wf.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40 hover:bg-accent/50"
                    }`}
                    onClick={() => setSelectedWorkflow(wf)}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                      <GitBranch className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{wf.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{wf.description}</div>
                    </div>
                    <div className="shrink-0 text-xs text-muted-foreground">{steps.length} models</div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {selectedWorkflow && (
          <div className="flex w-80 shrink-0 flex-col border-l border-border pl-4 min-h-0">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="truncate text-sm font-semibold">{selectedWorkflow.name}</h3>
              <button
                type="button"
                className="text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setSelectedWorkflow(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-4 text-xs text-muted-foreground">{selectedWorkflow.description}</div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Model nodes</div>
              <div className="relative pl-4">
                <div className="absolute bottom-2 left-[11px] top-2 w-px bg-border" />

                {communityWorkflowModelSteps(selectedWorkflow).map((step, idx) => (
                  <div key={`${step.type}-${idx}`} className="relative mb-4 flex items-start gap-3 last:mb-0">
                    <div
                      className={`relative z-10 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2 ${
                        idx === 0 ? "border-primary bg-primary/20" : "border-border bg-background"
                      }`}
                    >
                      <span className="text-[10px] font-bold text-muted-foreground">{idx + 1}</span>
                    </div>
                    <div className="flex flex-col gap-0.5 pt-0.5">
                      <span className="text-xs font-medium">{step.label}</span>
                      <span className="text-[10px] text-muted-foreground">{step.type}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 border-t border-border pt-3">
              <div className="mb-2 text-[10px] text-muted-foreground">By {selectedAuthorProfile?.displayName || selectedWorkflow.author}</div>
              <Button
                size="sm"
                className="w-full"
                disabled={importing}
                onClick={handleImport}
              >
                {importing ? "Importing…" : "Import to My Library"}
              </Button>
              {/* Owner-only delete. Built-in/offline presets have no ownerId so this stays hidden for them. */}
              {!!selectedWorkflow.ownerId && userInfo?.user_id === selectedWorkflow.ownerId && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 w-full border-destructive/40 text-destructive hover:bg-destructive/10"
                  onClick={() => setPendingWorkflowDelete(selectedWorkflow)}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  Delete from community
                </Button>
              )}
              <p className="mt-2 text-[10px] text-muted-foreground">
                Same storage as Agentic AI → Save workflow in the image viewer.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border pt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">My Library</h3>
          <span className="text-xs text-muted-foreground">
            Total {libraryEntries.length}; Saved in Local Storage
          </span>
        </div>
        {libraryEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            My Library is empty. Import a community workflow above, or save from Agentic AI in the image viewer.
          </p>
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-border bg-muted/20 p-2">
            {libraryEntries.map(([storageKey, wf]) => {
              const models = countSerializedModelNodes(wf)
              const edges = wf.connections.length
              return (
                <div
                  key={storageKey}
                  className="flex items-start gap-3 rounded-md border border-border bg-background px-3 py-2.5"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                    <Workflow className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" title={storageKey}>
                      {storageKey}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Last updated {fmtSavedAt(wf.savedAt)} · {models} {models === 1 ? "model" : "models"} ·{" "}
                      {edges} {edges === 1 ? "edge" : "edges"}
                    </div>
                    {(wf.description || wf.author) && (
                      <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                        {wf.author ? `${wf.author} — ` : ""}
                        {wf.description || ""}
                      </div>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                    title="Remove from My Library"
                    onClick={() => setLibraryDeleteKey(storageKey)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>

    <AlertDialog
      open={pendingWorkflowDelete !== null}
      onOpenChange={(open) => {
        if (!open && !workflowDeleteInFlight) setPendingWorkflowDelete(null)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete community workflow?</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingWorkflowDelete ? (
              <>
                Permanently remove <span className="font-medium text-foreground">&quot;{pendingWorkflowDelete.name}&quot;</span>
                {" "}from the community. Anyone who already imported it keeps their local copy, but no one will be able
                to discover or import it again. Classifiers it references are NOT deleted.
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={workflowDeleteInFlight}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={workflowDeleteInFlight}
            onClick={(e) => {
              e.preventDefault()
              if (!pendingWorkflowDelete) return
              void performWorkflowDelete(pendingWorkflowDelete)
            }}
          >
            {workflowDeleteInFlight ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog
      open={libraryDeleteKey !== null}
      onOpenChange={(open) => {
        if (!open) setLibraryDeleteKey(null)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove from My Library?</AlertDialogTitle>
          <AlertDialogDescription>
            {libraryDeleteKey ? (
              <>
                Remove <span className="font-medium text-foreground">&quot;{libraryDeleteKey}&quot;</span> from My
                Library? This cannot be undone.
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault()
              if (!libraryDeleteKey) return
              if (performDeleteLibraryItem(libraryDeleteKey)) {
                setLibraryDeleteKey(null)
              }
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    </>
  )
}

export default function Community() {
  const router = useRouter()
  const { userInfo } = useUserInfo()
  const [activeTab, setActiveTab] = useState<ActiveTab>('home')
  const [selectedTaskNode, setSelectedTaskNode] = useState<TaskNodeData | null>(null)
  const [loading, setLoading] = useState(false)
  
  // Read tab from query parameter on mount and when query changes
  useEffect(() => {
    const tabParam = router.query.tab as string
    if (
      tabParam &&
      (tabParam === "home" ||
        tabParam === "workflows" ||
        tabParam === "factories" ||
        tabParam === "datasets")
    ) {
      setActiveTab(tabParam as ActiveTab)
    }
  }, [router.query.tab])

  // Home tab: three-layer browser state (factory → model → classifiers)
  const [homeFactory, setHomeFactory] = useState<string>('')
  const [homeModel, setHomeModel] = useState<string>('')
  // Community / Official filter tab inside a model's classifier detail.
  const [homeClassTab, setHomeClassTab] = useState<'community' | 'official'>('official')
  // Collapsed organ groups in the Official tab (organ key -> collapsed).
  const [collapsedOrgans, setCollapsedOrgans] = useState<Record<string, boolean>>({})
  const [homeSidebarSort, setHomeSidebarSort] = useState<'stars' | 'classifiers' | 'uses'>('stars')
  const [showHomeTutorial, setShowHomeTutorial] = useState(false)
  
  // Factories view state
  const [factoriesView, setFactoriesView] = useState<FactoriesView>('list')
  const [selectedFactoryNode, setSelectedFactoryNode] = useState<string>('')
  
  // Datasets state
  const [datasetSearch, setDatasetSearch] = useState('')
  const [datasetSort, setDatasetSort] = useState<SortOption>('most_stars')
  const [datasetCurrentPage, setDatasetCurrentPage] = useState(1)
  
  // Confirm delete dialog
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null)
  
  // Env options for activation
  const [envOptions, setEnvOptions] = useState<string[]>([])

  const isElectron = useMemo(() => typeof window !== 'undefined' && !!(window as any).electron, [])
  
  // Use custom hooks for data management
  const {
    categories,
    nodeInfo,
    nodesExtended,
    categoryDisplayNames,
    nodeClassifierCounts,
    fetchFactories,
    fetchRunning,
    fetchNodesExtended,
    fetchNodeClassifierCounts
  } = useFactoryNodes()

  const {
    realClassifiers,
    userUploadedClassifiers,
    firebaseClassifiers,
    loadingClassifiers,
    loadingFirebaseClassifiers,
    setUserUploadedClassifiers,
    setRealClassifiers,
    setFirebaseClassifiers,
    loadFirebaseClassifiers,
    loadUserUploadedClassifiers,
    fetchRealClassifiers
  } = useClassifiers(userInfo)

  const {
    classifierSearch,
    setClassifierSearch,
    selectedTags,
    setSelectedTags,
    classifierSort,
    setClassifierSort,
    currentPage,
    setCurrentPage,
    getPaginatedClassifiers,
    getTotalPages
  } = useClassifierFilter(firebaseClassifiers, ITEMS_PER_PAGE)

  // Installation hook
  const {
    installOpen,
    setInstallOpen,
    installSteps,
    installProgress,
    installing,
    setInstalling,
    startInstall,
    cleanup: cleanupInstallation
  } = useNodeInstallation()

  // Activation hook
  const {
    busy,
    activationMode,
    setBusy,
    activating,
    activationStatus,
    failedMeta,
    logsOpen,
    setLogsOpen,
    logsTarget,
    setLogsTarget,
    activateOpen,
    setActivateOpen,
    activateFactory,
    activateNode,
    servicePath,
    setServicePath,
    envName,
    setEnvName,
    port,
    setPort,
    enableRemote,
    setEnableRemote,
    remoteHost,
    setRemoteHost,
    mntPath,
    setMntPath,
    subscribeActivation,
    quickActivate,
    openActivate,
    submitActivate,
    stopNode,
    clearNodeStatus,
    cleanup: cleanupActivation
  } = useNodeActivation()

  // Upload classifier hook
  const {
    uploadTitle,
    setUploadTitle,
    uploadDescription,
    setUploadDescription,
    uploadFilePath,
    uploadingClassifier,
    uploadDialogOpen,
    setUploadDialogOpen,
    selectedFactory,
    setSelectedFactory,
    selectedSubCategory,
    setSelectedSubCategory,
    selectedUploadModalityTags,
    handleSelectClassifierFile,
    handleUploadClassifier,
    handleUploadModalityTagClick,
  } = useClassifierUpload(userInfo)

  // Upload model hook
  const {
    uploadTitle: modelUploadTitle,
    setUploadTitle: setModelUploadTitle,
    uploadDescription: modelUploadDescription,
    setUploadDescription: setModelUploadDescription,
    uploadFilePath: modelUploadFilePath,
    uploadingModel,
    uploadDialogOpen: modelUploadDialogOpen,
    setUploadDialogOpen: setModelUploadDialogOpen,
    selectedFactory: modelSelectedFactory,
    setSelectedFactory: setModelSelectedFactory,
    selectedSubCategory: modelSelectedSubCategory,
    setSelectedSubCategory: setModelSelectedSubCategory,
    selectedUploadModalityTags: modelSelectedUploadModalityTags,
    handleSelectModelFile,
    handleUploadModel,
    handleUploadModalityTagClick: handleModelUploadModalityTagClick,
  } = useModelUpload(userInfo)

  // Models state
  const [userUploadedModels, setUserUploadedModels] = useState<ModelData[]>([])
  const [firebaseModels, setFirebaseModels] = useState<any[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [selectedModelTags, setSelectedModelTags] = useState<string[]>([])
  const [modelSort, setModelSort] = useState<SortOption>('recently_upload')
  const [modelCurrentPage, setModelCurrentPage] = useState(1)

  const handleManualRefresh = useCallback(async () => {
    try {
      const msg = 'Refreshing classifiers...'
      console.log('[Community]', msg)
      toast.message(msg)
      await Promise.all([
        loadFirebaseClassifiers(),
        loadUserUploadedClassifiers(),
        fetchRealClassifiers(true),
        fetchNodeClassifierCounts(),
      ])
      toast.success('Refreshed')
    } catch (e) {
      console.error(e)
      toast.error(getErrorMessage(e, 'Refresh failed'))
    }
  }, [loadFirebaseClassifiers, loadUserUploadedClassifiers, fetchRealClassifiers, fetchNodeClassifierCounts])

  // Whitelist configuration
  const factoryWhitelist = useMemo(() => {
    if (isElectron) {
      return Object.keys(categories)
    }

    if (!userInfo?.user_id) {
      return Object.keys(categories)
    }
    
    const userWhitelist = FACTORY_WHITELIST_CONFIG[userInfo.user_id] || FACTORY_WHITELIST_CONFIG['default'] || []
    
    if (userWhitelist.includes('*')) {
      return Object.keys(categories)
    }
    
    return userWhitelist
  }, [isElectron, userInfo?.user_id, categories])
  
  const hasFactoryPermission = useCallback((factory: string) => {
    if (isElectron) {
      return true
    }
    if (!userInfo?.user_id) {
      return false
    }
    return factoryWhitelist.includes(factory)
  }, [isElectron, factoryWhitelist, userInfo?.user_id])
  
  const showPermissionError = useCallback(() => {
    if (!userInfo?.user_id) {
      toast.error("Please login to operate this factory")
    } else {
      toast.error("You don't have permission to operate this factory")
    }
  }, [userInfo?.user_id])
  
  const getPermissionTooltip = useCallback(() => {
    if (!userInfo?.user_id) {
      return "Please login to operate this factory"
    } else {
      return "You don't have permission to operate this factory"
    }
  }, [userInfo?.user_id])

  // Event listeners
  useEffect(() => {
    const onRefresh = () => {
      fetchFactories()
      fetchNodesExtended()
      fetchRunning()
    }
    window.addEventListener('model-zoo-refresh', onRefresh as any)
    return () => window.removeEventListener('model-zoo-refresh', onRefresh as any)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Functions are stable with useCallback, no need to include in deps

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        console.log('[Community] Page visible again, checking ground truth')
        fetchRunning()
        fetchNodesExtended()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Functions are stable with useCallback, no need to include in deps

  useEffect(() => {
    return () => {
      cleanupActivation()
      cleanupInstallation()
    }
  }, [])

  // Periodic refresh to detect offline nodes
  useEffect(() => {
    const interval = setInterval(() => {
      // Refresh node status every 30 seconds to detect offline nodes
      fetchRunning().catch(err => {
        console.error('[Community] Error refreshing node status:', err)
      })
    }, 30000) // 30 seconds

    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Functions are stable with useCallback, no need to include in deps

  // Initial data load - only run once on mount
  useEffect(() => {
    setLoading(true);
    
    (async () => {
      const [, extendedNodes] = await Promise.all([
        fetchFactories(),
        fetchNodesExtended(),
        fetchNodeClassifierCounts(),
        fetchRealClassifiers(),
        loadUserUploadedClassifiers(),
        loadFirebaseClassifiers(),
        loadFirebaseModels(),
      ])
      
      // Load user uploaded models from localStorage
      loadUserUploadedModels()
      
      const runningNodes = await fetchRunning()
      
      Object.entries(extendedNodes || {}).forEach(([nodeName, nodeData]: [string, any]) => {
        const runtime = nodeData?.runtime
        const hasRuntime = !!(runtime?.service_path || runtime?.env_name)
        const isRunning = !!runningNodes[nodeName]?.running
        // Use is_remote flag from config to determine remote node
        // Remote nodes should not be auto-activated locally
        const isRemote = runtime?.is_remote === true
        
        // Skip remote nodes - they should be already running and only need connection
        // Remote nodes should not be auto-activated locally
        if (hasRuntime && !isRunning && nodeName !== 'Scripts' && !isRemote) {
          // Do not set busy preemptively here.
          // If backend decides to skip auto-activation (e.g. invalid service_path),
          // no SSE event will arrive and busy would get stuck forever.
          subscribeActivation(nodeName, async (success) => {
            if (success) {
              await fetchRunning()
              await fetchNodesExtended()
            }
          })
        } else if (isRemote && !isRunning) {
          // For remote nodes that are not running, they might need manual connection
          // Don't set busy state or auto-activate
        } else if (hasRuntime && !isRunning && nodeName !== 'Scripts') {
        }
      })
    })()
    
    setTimeout(() => setLoading(false), 2000)
  }, []) // Empty dependency array - only run once on mount
  
  // Load conda environments - only run once on mount
  useEffect(() => {
    (async () => {
      try {
        const resp = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_conda_envs`, {
          method: 'GET',
          returnAxiosFormat: true,
        })
        const envs = (resp.data as { envs?: string[] })?.envs || []
        setEnvOptions(envs)
      } catch (e) { console.error(e) }
    })()
  }, [])

  useEffect(() => {
    if (userInfo) {
      loadUserUploadedClassifiers()
    }
  }, [userInfo, loadUserUploadedClassifiers])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      try {
        if (!e || e.key === 'userUploadedClassifiers' || e.key === 'userUploadedModels' || (e.key && e.key.startsWith('preferred_name_'))) {
          if (!e || e.key === 'userUploadedClassifiers' || (e.key && e.key.startsWith('preferred_name_'))) {
            loadUserUploadedClassifiers()
            fetchRealClassifiers(true)
            loadFirebaseClassifiers()
          }
          if (!e || e.key === 'userUploadedModels') {
            loadUserUploadedModels()
            loadFirebaseModels()
          }
        }
      } catch {}
    }
    const onLocalStorageChanged = (e: any) => {
      try {
        const key = e?.detail?.key
        if (!key || key === 'userUploadedClassifiers' || key === 'userUploadedModels' || (key && key.startsWith('preferred_name_'))) {
          if (!key || key === 'userUploadedClassifiers' || (key && key.startsWith('preferred_name_'))) {
            loadUserUploadedClassifiers()
            fetchRealClassifiers(true)
            loadFirebaseClassifiers()
          }
          if (!key || key === 'userUploadedModels') {
            loadUserUploadedModels()
            loadFirebaseModels()
          }
        }
      } catch {}
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('localStorageChanged', onLocalStorageChanged)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('localStorageChanged', onLocalStorageChanged)
    }
  }, [loadUserUploadedClassifiers, fetchRealClassifiers, loadFirebaseClassifiers])

  const isPyService = (servicePath || '').trim().toLowerCase().endsWith('.py')
  const hasServicePath = !!(servicePath || '').trim()

  const handleDeleteClassifier = async (classifierId: string) => {
    try {
      if (classifierId.startsWith('uploaded-')) {
        try {
          const deleteResponse = await classifiersService.deleteClassifier(classifierId)

          if (deleteResponse.success) {
            setFirebaseClassifiers(prev => prev.filter(c => c.id !== classifierId))
          } else {
            toast.warning('Firebase deletion completed but may not have been successful.')
          }
        } catch (error) {
          console.error('Firebase delete error:', error)
          toast.warning(getErrorMessage(error, 'Firebase deletion failed'))
        }
      }

      setUserUploadedClassifiers(prev => prev.filter(c => c.id !== classifierId))
      setRealClassifiers(prev => prev.filter(c => c.id !== classifierId))
      setFirebaseClassifiers(prev => prev.filter(c => c.id !== classifierId))

      const updatedUserClassifiers = userUploadedClassifiers.filter(c => c.id !== classifierId)
      localStorage.setItem('userUploadedClassifiers', JSON.stringify(updatedUserClassifiers))
      window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedClassifiers' } }))

    } catch (error) {
      console.error('Error in handleDeleteClassifier:', error)
      toast.error(getErrorMessage(error, 'Failed to delete classifier'))
    }
  }


  const handleStatsUpdate = (classifierId: string, stats: { downloads?: number; stars?: number }) => {
    setUserUploadedClassifiers(prev =>
      prev.map(classifier =>
        classifier.id === classifierId
          ? {
              ...classifier,
              stats: {
                ...classifier.stats,
                ...(stats.downloads !== undefined && { downloads: stats.downloads }),
                ...(stats.stars !== undefined && { stars: stats.stars })
              }
            }
          : classifier
      )
    )
    
    setFirebaseClassifiers(prev =>
      prev.map(classifier =>
        classifier.id === classifierId
          ? {
              ...classifier,
              stats: {
                ...classifier.stats,
                ...(stats.downloads !== undefined && { downloads: stats.downloads }),
                ...(stats.stars !== undefined && { stars: stats.stars })
              }
            }
          : classifier
      )
    )
  }

  const handleViewFactoryClassifiers = (factory: string, node: string) => {
    setSelectedFactoryNode(node)
    setFactoriesView('detail')
  }

  const handleBackToFactoryList = () => {
    setFactoriesView('list')
    setSelectedFactoryNode('')
  }

  const handleTagClick = (tag: string) => {
    setSelectedTags(prev => 
      prev.includes(tag) 
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    )
    setCurrentPage(1)
  }

  // Models handling functions
  const handleModelTagClick = (tag: string) => {
    setSelectedModelTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    )
    setModelCurrentPage(1)
  }

  const handleDeleteModel = async (modelId: string) => {
    try {
      if (modelId.startsWith('uploaded-')) {
        try {
          const deleteResponse = await modelsService.deleteModel(modelId)
          
          if (deleteResponse.success) {
            setFirebaseModels(prev => prev.filter(m => m.id !== modelId))
          } else {
            toast.warning('Firebase deletion completed but may not have been successful.')
          }
        } catch (error) {
          console.error('Firebase delete error:', error)
          toast.warning(getErrorMessage(error, 'Firebase deletion failed'))
        }
      }
      
      setUserUploadedModels(prev => prev.filter(m => m.id !== modelId))
      setFirebaseModels(prev => prev.filter(m => m.id !== modelId))
      
      const updatedUserModels = userUploadedModels.filter(m => m.id !== modelId)
      localStorage.setItem('userUploadedModels', JSON.stringify(updatedUserModels))
      window.dispatchEvent(new CustomEvent('localStorageChanged', { detail: { key: 'userUploadedModels' } }))
      
    } catch (error) {
      console.error('Error in handleDeleteModel:', error)
      toast.error(getErrorMessage(error, 'Failed to delete model'))
    }
  }

  const handleModelStatsUpdate = (modelId: string, stats: { downloads?: number; stars?: number }) => {
    setUserUploadedModels(prev =>
      prev.map(model =>
        model.id === modelId
          ? {
              ...model,
              stats: {
                ...model.stats,
                ...(stats.downloads !== undefined && { downloads: stats.downloads }),
                ...(stats.stars !== undefined && { stars: stats.stars })
              }
            }
          : model
      )
    )
    
    setFirebaseModels(prev =>
      prev.map(model =>
        model.id === modelId
          ? {
              ...model,
              stats: {
                ...model.stats,
                ...(stats.downloads !== undefined && { downloads: stats.downloads }),
                ...(stats.stars !== undefined && { stars: stats.stars })
              }
            }
          : model
      )
    )
  }

  // Models filter and pagination
  const getFilteredAndSortedModels = () => {
    let filtered = [...firebaseModels]

    if (modelSearch.trim()) {
      const searchLower = modelSearch.toLowerCase()
      filtered = filtered.filter(m =>
        m.title?.toLowerCase().includes(searchLower) ||
        m.description?.toLowerCase().includes(searchLower) ||
        m.tags?.some((t: string) => t.toLowerCase().includes(searchLower))
      )
    }

    if (selectedModelTags.length > 0) {
      filtered = filtered.filter(m =>
        selectedModelTags.some(tag =>
          m.factory?.toLowerCase() === tag.toLowerCase() ||
          m.model?.toLowerCase() === tag.toLowerCase() ||
          m.tags?.some((t: string) => t.toLowerCase() === tag.toLowerCase())
        )
      )
    }

    filtered.sort((a, b) => {
      if (modelSort === 'most_stars') {
        return (b.stats?.stars || 0) - (a.stats?.stars || 0)
      } else if (modelSort === 'most_downloads') {
        return (b.stats?.downloads || 0) - (a.stats?.downloads || 0)
      } else {
        return new Date(b.stats?.updatedAt || 0).getTime() - new Date(a.stats?.updatedAt || 0).getTime()
      }
    })

    return filtered
  }

  const getPaginatedModels = () => {
    const filtered = getFilteredAndSortedModels()
    const start = (modelCurrentPage - 1) * ITEMS_PER_PAGE
    return filtered.slice(start, start + ITEMS_PER_PAGE)
  }

  const getModelTotalPages = () => {
    const filtered = getFilteredAndSortedModels()
    return Math.ceil(filtered.length / ITEMS_PER_PAGE)
  }

  // Load models from localStorage
  const loadUserUploadedModels = () => {
    try {
      const saved = localStorage.getItem('userUploadedModels')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed)) {
          // Format size for each model
          const formattedModels = parsed.map((model: any) => {
            const fileSize = model.stats?.size || 0
            let formattedSize = model.stats?.size || 'Unknown'
            
            if (typeof fileSize === 'number' && fileSize > 0) {
              formattedSize = `${(fileSize / (1024 * 1024)).toFixed(2)} MB`
            } else if (typeof fileSize === 'string') {
              const numSize = parseFloat(fileSize)
              if (!isNaN(numSize) && numSize > 0) {
                formattedSize = `${(numSize / (1024 * 1024)).toFixed(2)} MB`
              } else if (fileSize.toLowerCase().includes('mb') || fileSize.toLowerCase().includes('gb')) {
                formattedSize = fileSize
              }
            }
            
            return {
              ...model,
              stats: {
                ...model.stats,
                size: formattedSize
              }
            }
          })
          setUserUploadedModels(formattedModels)
        }
      }
    } catch (error) {
      console.error('Failed to load user uploaded models:', error)
    }
  }

  // Load models from Firebase
  const loadFirebaseModels = async () => {
    try {
      setLoadingModels(true)
      const response = await modelsService.getPublicModels({ limit: 200 })
      if (response?.success && Array.isArray(response.models)) {
        const baseList = response.models || []
        
        try {
          // Collect unique owner IDs
          const ownerIds: string[] = Array.from(new Set((baseList || []).map((x: any) => x.ownerId).filter(Boolean)))
          const ownerProfiles: Record<string, any> = {}
          
          // Fetch user profiles for all owners
          await Promise.all(ownerIds.map(async (uid) => {
            try {
              const p = await apiFetch(`${COMMUNITY_API_ENDPOINT}/users/v1/public_profile/${uid}`, { method: 'GET' })
              ownerProfiles[uid] = p || {}
              
              // Cache preferred name
              if (p?.preferred_name) {
                try { 
                  const existing = localStorage.getItem(`preferred_name_${uid}`)
                  if (existing !== p.preferred_name) {
                    localStorage.setItem(`preferred_name_${uid}`, p.preferred_name)
                  }
                } catch {}
              }
              
              // Cache avatar URL
              if (p?.avatar_url) {
                try { 
                  const existing = localStorage.getItem(`user_avatar_${uid}`)
                  if (existing !== p.avatar_url) {
                    localStorage.setItem(`user_avatar_${uid}`, p.avatar_url)
                  }
                } catch {}
              }
            } catch (err) {
              console.warn(`Failed to fetch profile for ${uid}:`, err)
            }
          }))
          
          // Enrich models with user profile data
          const enrichedModels = baseList.map((model: any) => {
            const profile = ownerProfiles[model.ownerId] || {}
            const preferredName = profile?.preferred_name
            const avatarUrl = profile?.avatar_url
            
            // Convert Firestore timestamps to ISO strings
            let updatedAt = model.stats?.updatedAt || model.updatedAt
            let createdAt = model.stats?.createdAt || model.createdAt
            
            // Handle Firestore Timestamp objects
            if (updatedAt && typeof updatedAt === 'object' && updatedAt._seconds) {
              updatedAt = new Date(updatedAt._seconds * 1000).toISOString()
            } else if (updatedAt && !isNaN(Date.parse(updatedAt))) {
              updatedAt = new Date(updatedAt).toISOString()
            } else {
              updatedAt = new Date().toISOString()
            }
            
            if (createdAt && typeof createdAt === 'object' && createdAt._seconds) {
              createdAt = new Date(createdAt._seconds * 1000).toISOString()
            } else if (createdAt && !isNaN(Date.parse(createdAt))) {
              createdAt = new Date(createdAt).toISOString()
            } else {
              createdAt = new Date().toISOString()
            }
            
            // Format size to MB
            let formattedSize = model.stats?.size || 'Unknown'
            const fileSize = model.fileSize || model.stats?.size || 0
            if (typeof fileSize === 'number' && fileSize > 0) {
              formattedSize = `${(fileSize / (1024 * 1024)).toFixed(2)} MB`
            } else if (typeof fileSize === 'string') {
              const numSize = parseFloat(fileSize)
              if (!isNaN(numSize) && numSize > 0) {
                formattedSize = `${(numSize / (1024 * 1024)).toFixed(2)} MB`
              } else if (fileSize.toLowerCase().includes('mb') || fileSize.toLowerCase().includes('gb')) {
                formattedSize = fileSize
              }
            }
            
            return {
              ...model,
              author: {
                name: preferredName || model.author?.name || 'Unknown Author',
                avatar: avatarUrl || model.author?.avatar || '/avatars/default.jpg',
                user_id: model.ownerId || model.author?.user_id,
                username: model.ownerId || model.author?.username
              },
              stats: {
                ...model.stats,
                size: formattedSize,
                updatedAt,
                createdAt
              }
            }
          })
          
          setFirebaseModels(enrichedModels)
        } catch (enrichError) {
          console.error('Failed to enrich model data:', enrichError)
          // Fallback: use base list without enrichment
          setFirebaseModels(baseList)
        }
      }
    } catch (error) {
      console.error('Failed to load Firebase models:', error)
    } finally {
      setLoadingModels(false)
    }
  }

  const handleDeleteNode = async (nodeName: string) => {
    const result = await deleteNode(nodeName)
    if (result.success) {
      await fetchFactories()
      await fetchNodesExtended()
      await fetchRunning()
    }
  }

  const handleDownload = (node: string) => {
    downloadNodeForElectron(
      node,
      categories,
      installing,
      setInstalling,
      async () => {
        await fetchNodesExtended()
        await fetchRunning()
      }
    )
  }

  // Convert to UI format
  const convertToTaskNodes = (): TaskNodeData[] => {
    const taskNodes: TaskNodeData[] = []
    
    Object.entries(categories).forEach(([factory, nodes]) => {
      const displayName = categoryDisplayNames[factory] || factory
      
      const models: TaskNodeModelData[] = nodes.map(nodeName => {
        const info = nodeInfo[nodeName]
        const extended = nodesExtended[nodeName]
        const runtime = extended?.runtime || {}
        
        let status: 'downloaded' | 'available' | 'installing' = 'available'
        if (busy[nodeName]) {
          status = busy[nodeName] === 'activating' ? 'installing' : 'available'
        } else if (info?.running) {
          status = 'downloaded'
        } else if (runtime?.service_path || runtime?.env_name) {
          status = 'downloaded'
        }

        return {
          id: nodeName,
          name: nodeName,
          size: '2.1 GB',
          status,
          classifiers: Math.floor(Math.random() * 5) + 1,
          isDefault: nodeName.includes('default') || nodeName === nodes[0]
        }
      })

      taskNodes.push({
        id: factory,
        name: displayName,
        category: factory.includes('segment') ? 'Segmentation' : 
                 factory.includes('class') ? 'Classification' : 
                 factory.includes('detect') ? 'Detection' : 'Analysis',
        description: `${displayName} tools and models for tissue analysis`,
        tags: [factory.charAt(0).toUpperCase() + factory.slice(1), 'AI Models'],
        models,
        classifiers: []
      })
    })

    return taskNodes
  }

  const realTaskNodes = convertToTaskNodes()

  // Build unified classifiers list for Factories detail view
  const allClassifiersForFactories = useMemo(() => {
    const safeToIso = (v: any) => {
      try {
        if (!v) return new Date().toISOString()
        if (typeof v === 'object') {
          const t = (v as any).seconds || (v as any)._seconds
          if (typeof t === 'number') return new Date(t * 1000).toISOString()
        }
        const d = new Date(typeof v === 'number' ? v : String(v))
        if (isNaN(d.getTime())) return new Date().toISOString()
        return d.toISOString()
      } catch {
        return new Date().toISOString()
      }
    }

    const fb = (firebaseClassifiers || []).map((fc) => ({
      id: fc.id,
      title: fc.title,
      description: fc.description,
      author: {
        name: classifiersService.getAuthorDisplay(fc),
        avatar: '/avatars/default.jpg',
        user_id: fc.ownerId,
        username: fc.ownerId,
      },
      stats: {
        classes: (fc as any).classesCount || fc.stats?.classes || 0,
        size: classifiersService.formatFileSize((fc as any).fileSize || fc.stats?.size),
        downloads: fc.stats?.downloads || 0,
        stars: fc.stats?.stars || 0,
        updatedAt: safeToIso((fc as any).updatedAt),
        createdAt: safeToIso((fc as any).createdAt),
      },
      tags: fc.tags || [],
      thumbnail: '/thumbnails/default.jpg',
      filePath: (fc as any).localPath,
      downloadLink: fc.downloadLink,
      factory: fc.factory,
      model: fc.model || '',
      node: fc.model || '',
    }))

    const merged = [...fb, ...userUploadedClassifiers, ...realClassifiers]
    const byId = new Map()
    for (const c of merged) {
      if (!c || !c.id) continue
      if (!byId.has(c.id)) byId.set(c.id, c)
    }
    return Array.from(byId.values())
  }, [firebaseClassifiers, userUploadedClassifiers, realClassifiers])

  // Default-select first factory + first model when categories load
  useEffect(() => {
    const factoryKeys = orderFactoryKeys(Object.keys(categories))
    if (!factoryKeys.length) return
    if (!homeFactory || !categories[homeFactory]) {
      const firstFactory = factoryKeys[0]
      setHomeFactory(firstFactory)
      setHomeModel(categories[firstFactory]?.[0] || '')
    } else if (!homeModel || !categories[homeFactory].includes(homeModel)) {
      setHomeModel(categories[homeFactory]?.[0] || '')
    }
  }, [categories, homeFactory, homeModel])

  // Classifiers filtered for the model selected in the Home browser
  const homeClassifiersForSelectedModel = useMemo(() => {
    if (!homeModel) return []
    // Official (TissueLab) classifiers are browsed under the dedicated "Official"
    // category, so keep them out of the per-model community list.
    return allClassifiersForFactories.filter(
      (c: any) => (c.node === homeModel || c.model === homeModel) && !isOfficialClassifier(c)
    )
  }, [allClassifiersForFactories, homeModel])

  // ── Official (TissueLab) classifiers for the selected model ─────────────
  // Shown under the model detail via a Community / Official filter tab.
  const officialForModel = useMemo(() => {
    if (!homeModel) return []
    return allClassifiersForFactories.filter(
      (c: any) => (c.node === homeModel || c.model === homeModel) && isOfficialClassifier(c)
    )
  }, [allClassifiersForFactories, homeModel])

  // Per-model metrics aggregated from classifiers (stars / classifier count / downloads-as-uses)
  const homeModelMetrics = useMemo(() => {
    const acc: Record<string, { stars: number; classifiers: number; uses: number }> = {}
    for (const c of allClassifiersForFactories) {
      const key = (c as any).node || (c as any).model
      if (!key) continue
      if (!acc[key]) acc[key] = { stars: 0, classifiers: 0, uses: 0 }
      acc[key].stars += Number((c as any).stats?.stars || 0)
      acc[key].classifiers += 1
      acc[key].uses += Number((c as any).stats?.downloads || 0)
    }
    return acc
  }, [allClassifiersForFactories])

  // Models in the selected factory, sorted by the chosen metric
  const homeSortedModels = useMemo(() => {
    const list = [...(categories[homeFactory] || [])]
    list.sort((a, b) => {
      const ma = homeModelMetrics[a]?.[homeSidebarSort] || 0
      const mb = homeModelMetrics[b]?.[homeSidebarSort] || 0
      return mb - ma
    })
    return list
  }, [categories, homeFactory, homeModelMetrics, homeSidebarSort])

  const handleHomeFactoryClick = (factory: string) => {
    setHomeFactory(factory)
    setHomeModel(categories[factory]?.[0] || '')
  }

  // Filter datasets
  const getFilteredAndSortedDatasets = () => {
    let filtered = [...mockDatasets]
    
    if (datasetSearch.trim()) {
      const searchTerm = datasetSearch.toLowerCase()
      filtered = filtered.filter(dataset => 
        dataset.title.toLowerCase().includes(searchTerm) ||
        dataset.description.toLowerCase().includes(searchTerm) ||
        dataset.tags.some(tag => tag.toLowerCase().includes(searchTerm)) ||
        dataset.author.name.toLowerCase().includes(searchTerm)
      )
    }
    
    filtered.sort((a, b) => {
      switch (datasetSort) {
        case 'most_stars':
          return b.stats.stars - a.stats.stars
        case 'most_downloads':
          return b.stats.downloads - a.stats.downloads
        case 'recently_upload':
          return new Date(b.stats.updatedAt).getTime() - new Date(a.stats.updatedAt).getTime()
        default:
          return 0
      }
    })
    
    return filtered
  }

  const getPaginatedDatasets = () => {
    const filtered = getFilteredAndSortedDatasets()
    const startIndex = (datasetCurrentPage - 1) * ITEMS_PER_PAGE
    const endIndex = startIndex + ITEMS_PER_PAGE
    return filtered.slice(startIndex, endIndex)
  }

  const getDatasetTotalPages = () => {
    const filtered = getFilteredAndSortedDatasets()
    return Math.ceil(filtered.length / ITEMS_PER_PAGE)
  }

  return (
    <>
    <div className="box-border h-full w-full overflow-auto bg-background font-sans">
      <div className="w-full px-2.5 pt-3 pb-6 md:px-5">
        {/* Header */}
        <div className="mb-3 flex items-center justify-between px-1">
          <h1 className="text-lg font-semibold text-foreground">Community</h1>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleManualRefresh}>Refresh</Button>
          </div>
        </div>

        {/* Download Area */}
        <div className="mb-3">
          <DownloadArea />
        </div>

        {/* Workflow anatomy: at-a-glance explainer of workflow / tools / classifier */}
        <div className="mb-4">
          <WorkflowAnatomy />
        </div>

        {/* Main Navigation Tabs */}
        <Tabs value={activeTab} onValueChange={(value: any) => setActiveTab(value)} className="h-full">
          <TabsList className="mb-4 grid w-full max-w-2xl grid-cols-3">
            <TabsTrigger value="home" className="flex items-center gap-2">
              <Circle className="w-4 h-4" />
              Models
            </TabsTrigger>
            <TabsTrigger value="workflows" className="flex items-center gap-2">
              <Square className="w-4 h-4" />
              Workflows
            </TabsTrigger>
            <TabsTrigger value="factories" className="flex items-center gap-2">
              <Boxes className="w-4 h-4" />
              Factories
            </TabsTrigger>
          </TabsList>

          {/* Home Tab — three-layer browser: factory row → model sidebar → classifier canvas */}
          <TabsContent value="home" className="h-[calc(100%-120px)] bg-background">
            <div className="pb-16">
              {/* Layer 1: Factory cards in a horizontal row */}
              <div className="mb-6">
                <div className="mb-3 flex items-center gap-3">
                  <div className="text-sm font-medium text-muted-foreground">Browse by Factory</div>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowHomeTutorial(true)}
                  >
                    <PlayCircle className="h-4 w-4 text-red-500" />
                    <span className="text-xs">Watch Tutorial</span>
                  </button>
                </div>
                {Object.keys(categories).length === 0 ? (
                  <div className="text-sm text-muted-foreground">No factories available.</div>
                ) : (
                  <div className="grid auto-cols-fr grid-flow-col gap-2">
                    {orderFactoryKeys(Object.keys(categories)).map((factory) => {
                      const firstNode = categories[factory]?.[0]
                      const factoryMeta: any = firstNode ? (nodesExtended as any)?.[firstNode] : null
                      const iconUrl: string | undefined = factoryMeta?.icon
                      const displayName = categoryDisplayNames[factory] || factory
                      const modelCount = categories[factory]?.length || 0
                      const isSelected = homeFactory === factory
                      return (
                        <button
                          key={factory}
                          type="button"
                          onClick={() => handleHomeFactoryClick(factory)}
                          className={`flex min-w-0 flex-col items-center rounded-lg border bg-card px-2 py-3 text-center transition-shadow hover:shadow-md ${
                            isSelected ? 'border-primary ring-2 ring-primary/20' : 'border-border'
                          }`}
                        >
                          <div className="mb-2 flex h-9 w-9 items-center justify-center overflow-hidden rounded-md bg-muted">
                            {iconUrl ? (
                              <Image src={iconUrl} alt={displayName} width={36} height={36} className="h-full w-full object-cover" />
                            ) : (
                              <Boxes className="h-5 w-5 text-muted-foreground" />
                            )}
                          </div>
                          <div className="w-full truncate text-xs font-semibold text-foreground" title={displayName}>
                            {displayName}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {modelCount} {modelCount === 1 ? 'model' : 'models'}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Layers 2 & 3: model sidebar + classifier canvas */}
              <div className="flex gap-4">
                {/* Layer 2: Model sidebar */}
                <div className="w-56 shrink-0 border-r border-border pr-4">
                  <div className="mb-2 text-sm font-medium text-muted-foreground">
                    {categoryDisplayNames[homeFactory] || homeFactory || 'Models'}
                  </div>
                  <Select value={homeSidebarSort} onValueChange={(v) => setHomeSidebarSort(v as typeof homeSidebarSort)}>
                    <SelectTrigger className="mb-2 h-8 w-full text-xs">
                      <SelectValue placeholder="Sort by" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stars">Most stars</SelectItem>
                      <SelectItem value="classifiers">Most classifiers</SelectItem>
                      <SelectItem value="uses">Most uses</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex flex-col gap-1">
                    {homeSortedModels.map((model) => {
                      const modelMeta: any = (nodesExtended as any)?.[model]
                      const label = modelMeta?.displayName || model
                      const modelIconUrl: string | undefined = modelMeta?.icon
                      const isSelected = homeModel === model
                      const metricValue = homeModelMetrics[model]?.[homeSidebarSort] || 0
                      return (
                        <button
                          key={model}
                          type="button"
                          onClick={() => setHomeModel(model)}
                          className={`flex items-center gap-2 rounded-[4px] px-2 py-2 text-left text-sm transition-colors ${
                            isSelected
                              ? 'bg-accent font-medium text-accent-foreground'
                              : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'
                          }`}
                        >
                          <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted">
                            {modelIconUrl ? (
                              <Image src={modelIconUrl} alt={label} width={24} height={24} className="h-full w-full object-cover" />
                            ) : (
                              <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </div>
                          <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                            {metricValue}
                          </span>
                        </button>
                      )
                    })}
                    {homeSortedModels.length === 0 && (
                      <div className="text-xs text-muted-foreground">Select a factory to see models.</div>
                    )}
                  </div>
                </div>

                {/* Layer 3: Classifier canvas */}
                <div className="min-w-0 flex-1">
                  {(() => {
                    const community = homeClassifiersForSelectedModel
                    const official = officialForModel
                    // Auto-pick a non-empty tab so the canvas is never blank when
                    // only one side has content.
                    const tab = official.length === 0 ? 'community' : (community.length === 0 ? 'official' : homeClassTab)
                    const renderCard = (classifier: any) => (
                      <ClassifierCard
                        key={classifier.id}
                        classifier={classifier}
                        onDelete={handleDeleteClassifier}
                        canDelete={
                          !!userInfo?.user_id && (
                            firebaseClassifiers.some(c => c.id === classifier.id && c.ownerId === userInfo.user_id) ||
                            userUploadedClassifiers.some(c => c.id === classifier.id && c.author?.user_id === userInfo.user_id)
                          )
                        }
                        onTagClick={(tag) => {
                          handleTagClick(tag)
                          setClassifierSearch('')
                        }}
                        onStatsUpdate={handleStatsUpdate}
                      />
                    )
                    const tabBtn = (key: 'official' | 'community', label: string, n: number) => (
                      <button
                        type="button"
                        onClick={() => setHomeClassTab(key)}
                        className={`rounded-[4px] px-3 py-1 text-xs font-medium transition-colors ${
                          tab === key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {label} <span className="tabular-nums opacity-70">({n})</span>
                      </button>
                    )
                    const emptyState = (msg: string, spinning = false) => (
                      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12 text-center">
                        {spinning ? (
                          <div className="mb-3 h-10 w-10 animate-spin rounded-full border-b-2 border-primary"></div>
                        ) : (
                          <Database className="mb-3 h-10 w-10 text-muted-foreground/60" />
                        )}
                        <div className="text-sm text-muted-foreground">{msg}</div>
                      </div>
                    )
                    return (
                      <>
                        <div className="mb-3 flex items-center justify-between">
                          <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
                            {tabBtn('official', 'Official', official.length)}
                            {tabBtn('community', 'Community', community.length)}
                          </div>
                          <Button variant="outline" size="sm" onClick={() => setUploadDialogOpen(true)}>
                            Upload Classifier
                          </Button>
                        </div>
                        {!homeModel ? (
                          emptyState('Pick a model to see its classifiers.')
                        ) : tab === 'official' ? (
                          official.length === 0 ? (
                            emptyState('No official classifiers for this model yet.')
                          ) : (
                            <div className="space-y-4">
                              {ORGAN_ORDER.filter((o) => official.some((c: any) => organOfClassifier(c.id) === o)).map((o) => {
                                const rows = official.filter((c: any) => organOfClassifier(c.id) === o)
                                const collapsed = !!collapsedOrgans[o]
                                return (
                                  <div key={o}>
                                    <button
                                      type="button"
                                      onClick={() => setCollapsedOrgans((p) => ({ ...p, [o]: !p[o] }))}
                                      className="mb-2 flex w-full items-center gap-1.5 text-[11px] font-medium text-muted-foreground/80 hover:text-foreground"
                                    >
                                      {collapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                                      <span>{ORGAN_LABELS[o] || o}</span>
                                      <span className="tabular-nums opacity-60">({rows.length})</span>
                                    </button>
                                    {!collapsed && (
                                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{rows.map(renderCard)}</div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )
                        ) : (
                          community.length === 0 ? (
                            emptyState(loadingFirebaseClassifiers ? 'Loading classifiers…' : 'No community classifiers for this model yet.', loadingFirebaseClassifiers)
                          ) : (
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                              {community.map(renderCard)}
                            </div>
                          )
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Workflows Tab */}
          <TabsContent value="workflows" className="h-[calc(100%-120px)] bg-background">
            <CommunityWorkflowsPanel />
          </TabsContent>

          {/* Factories Tab */}
          <TabsContent value="factories" className="h-[calc(100%-120px)] bg-background">
            {factoriesView === 'detail' ? (
              <FactoryClassifierDetail
                factory={Object.keys(categories).find(f =>
                  categories[f].includes(selectedFactoryNode)
                ) || ""}
                node={selectedFactoryNode}
                onBack={handleBackToFactoryList}
                allClassifiers={allClassifiersForFactories}
                categoryDisplayNames={categoryDisplayNames}
                onDeleteClassifier={handleDeleteClassifier}
                userUploadedClassifiers={userUploadedClassifiers}
                onStatsUpdate={handleStatsUpdate}
              />
            ) : (
              <>
                <div className="mb-4">
                  <div className="flex items-center justify-between pb-2">
                    <div>
                      <h2 className="text-2xl font-semibold">Factories</h2>
                    </div>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => router.push('/community/create-custom-node')}
                    >
                      Upload New Model
                    </Button>
                  </div>
                </div>
                
                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="text-center">
                      <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-primary"></div>
                      <p className="text-muted-foreground">Loading task nodes...</p>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {orderFactoryEntries(Object.entries(categories)).map(([factory, nodes]) => (
                      <FactoryTaskNodeCard
                        key={factory}
                        factory={factory}
                        nodes={nodes}
                        nodeInfo={nodeInfo}
                        nodesExtended={nodesExtended}
                        busy={busy}
                        activationMode={activationMode}
                        onActivate={(f, n) => quickActivate(f, n, nodesExtended, nodeInfo, async (success) => {
                          // Refresh after both success and failure so UI reflects latest
                          // persisted runtime config (e.g. is_remote/remote_host/port).
                          if (success) {
                            // Wait a bit for backend to update registry on successful activation
                            await new Promise(res => setTimeout(res, 200))
                          }
                          try {
                            await fetchRunning()
                            await fetchNodesExtended()
                          } catch (err) {
                            console.error(`[Community] Error refreshing state after activation:`, err)
                          }
                        })}
                        onDeactivate={(n) => {
                          stopNode(n, nodeInfo, nodesExtended, async () => {
                            // Immediately refresh once - backend should have already removed the node
                            await fetchRunning()
                            await fetchNodesExtended()
                            clearNodeStatus(n)
                            
                            // Double-check: if node still exists, poll until removed (should be rare)
                            const latest = await fetchRunning()
                            if (latest[n]) {
                              const start = Date.now()
                              const timeoutMs = 5000  // Shorter timeout since backend should have removed it
                              while (Date.now() - start < timeoutMs) {
                                await new Promise(res => setTimeout(res, 200))
                                const check = await fetchRunning()
                                if (!check[n]) {
                                  await fetchNodesExtended()
                                  break
                                }
                              }
                            }
                          })
                        }}
                        onViewClassifiers={handleViewFactoryClassifiers}
                        onOpenActivate={(f, n) => openActivate(f, n, nodesExtended, nodeInfo)}
                        displayName={categoryDisplayNames[factory] || factory}
                        nodeClassifierCounts={nodeClassifierCounts}
                        userUploadedClassifiers={userUploadedClassifiers}
                        realClassifiers={realClassifiers}
                        firebaseClassifiers={firebaseClassifiers}
                        categoryDisplayNames={categoryDisplayNames}
                        activationStatus={activationStatus}
                        failedMeta={failedMeta}
                        isElectron={isElectron}
                        onDownload={handleDownload}
                        installing={installing}
                        activating={activating}
                        hasPermission={hasFactoryPermission(factory)}
                        showPermissionError={showPermissionError}
                        getPermissionTooltip={getPermissionTooltip}
                        userInfo={userInfo}
                        onDelete={(nodeName) => {
                          setConfirmTarget(nodeName)
                          setConfirmOpen(true)
                        }}
                        onShowLogs={(nodeName, meta) => {
                          // Use model_name (nodeName) for API call, logPath is only for metadata
                          if (!meta.logPath) return
                          setLogsTarget({ node: nodeName, path: meta.logPath, env: meta.env, port: meta.port })
                          setLogsOpen(true)
                        }}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </TabsContent>

          {/* Datasets moved to standalone /datasets page */}
        </Tabs>

        {/* Upload Classifier Dialog */}
        <UploadClassifierDialog
          open={uploadDialogOpen}
          onOpenChange={setUploadDialogOpen}
          title={uploadTitle}
          onTitleChange={setUploadTitle}
          description={uploadDescription}
          onDescriptionChange={setUploadDescription}
          filePath={uploadFilePath}
          onSelectFile={handleSelectClassifierFile}
          selectedFactory={selectedFactory}
          onFactoryChange={setSelectedFactory}
          selectedSubCategory={selectedSubCategory}
          onSubCategoryChange={setSelectedSubCategory}
          selectedModalityTags={selectedUploadModalityTags}
          onModalityTagClick={handleUploadModalityTagClick}
          uploading={uploadingClassifier}
          onUpload={() => handleUploadClassifier((classifier) => {
            setUserUploadedClassifiers(prev => [classifier, ...prev])
          })}
          categories={categories}
        />

        {/* Upload Model Dialog */}
        <UploadModelDialog
          open={modelUploadDialogOpen}
          onOpenChange={setModelUploadDialogOpen}
          title={modelUploadTitle}
          onTitleChange={setModelUploadTitle}
          description={modelUploadDescription}
          onDescriptionChange={setModelUploadDescription}
          filePath={modelUploadFilePath}
          onSelectFile={handleSelectModelFile}
          selectedFactory={modelSelectedFactory}
          onFactoryChange={setModelSelectedFactory}
          selectedSubCategory={modelSelectedSubCategory}
          onSubCategoryChange={setModelSelectedSubCategory}
          selectedModalityTags={modelSelectedUploadModalityTags}
          onModalityTagClick={handleModelUploadModalityTagClick}
          uploading={uploadingModel}
          onUpload={() => handleUploadModel((model) => {
            setUserUploadedModels(prev => [model, ...prev])
            loadFirebaseModels()
          })}
          categories={categories}
        />

        {/* Activation Dialog */}
        <Dialog open={activateOpen} onOpenChange={setActivateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{enableRemote ? 'Connect to' : 'Activate'} {activateNode} ({activateFactory})</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              {/* Remote Connection Options */}
              <div className="grid grid-cols-4 items-center gap-2">
                <Label className="text-right">Remote Connection</Label>
                <div className="col-span-3 flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="enable-remote-activate"
                    checked={enableRemote}
                    onChange={(e) => setEnableRemote(e.target.checked)}
                    className="rounded"
                  />
                  <Label htmlFor="enable-remote-activate" className="cursor-pointer">Connect to remote service</Label>
                </div>
              </div>
              {!enableRemote && (
                <>
                  <div className="grid grid-cols-4 items-center gap-2 pt-2 border-t">
                    <Label className="text-right">
                      Service File <span className="text-destructive">*</span>
                    </Label>
                    <div className="col-span-3 flex gap-2 items-center">
                      <Input className="flex-1" value={servicePath} onChange={(e)=>setServicePath(e.target.value)} placeholder="Enter .py or binary file path" />
                      <Button type="button" variant="outline" size="sm" onClick={async ()=>{
                        try {
                          const result = await (window as any).electron.invoke('open-file-dialog')
                          if (result?.filePaths?.length) setServicePath(result.filePaths[0])
                        } catch (e) { console.error(e) }
                      }}>Browse</Button>
                    </div>
                  </div>
                  <div className={`transition-all duration-300 overflow-hidden ${isPyService ? 'max-h-32 mt-2' : 'max-h-0 hidden'}`}>
                    <div className="grid grid-cols-4 items-center gap-2">
                      <Label className="text-right">
                        Conda Env <span className="text-destructive">*</span>
                      </Label>
                      <div className="col-span-3">
                        <Select value={envName} onValueChange={setEnvName}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select existing env" />
                          </SelectTrigger>
                          <SelectContent>
                            {envOptions.map((n) => (
                              <SelectItem key={n} value={n}>{n}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                </>
              )}
              {enableRemote && (
                <>
                  <div className="grid grid-cols-4 items-center gap-2">
                    <Label className="text-right">Remote Host <span className="text-destructive">*</span></Label>
                    <Input 
                      className="col-span-3" 
                      value={remoteHost} 
                      onChange={(e) => setRemoteHost(e.target.value)} 
                      placeholder="192.168.1.100 or hostname" 
                    />
                  </div>
                  <div className="grid grid-cols-4 items-center gap-2">
                    <Label className="text-right">
                      Port <span className="text-destructive">*</span>
                    </Label>
                    <Input className="col-span-3" value={port} onChange={(e)=>setPort(e.target.value.replace(/[^0-9]/g,''))} placeholder="required for remote" />
                  </div>
                  <div className="grid grid-cols-4 items-center gap-2">
                    <Label className="text-right">Mount Path (optional)</Label>
                    <Input 
                      className="col-span-3" 
                      value={mntPath} 
                      onChange={(e) => setMntPath(e.target.value)} 
                      placeholder="/mnt/shared (optional)" 
                    />
                  </div>
                </>
              )}
              {!enableRemote && (
                <div className={`transition-all duration-300 overflow-hidden ${hasServicePath ? 'max-h-20 opacity-100 mt-2' : 'max-h-0 opacity-0'}`}>
                  <div className="grid grid-cols-4 items-center gap-2">
                    <Label className="text-right">
                      Port
                    </Label>
                    <Input className="col-span-3" value={port} onChange={(e)=>setPort(e.target.value.replace(/[^0-9]/g,''))} placeholder="optional" />
                  </div>
                </div>
              )}
              <div className="flex justify-end">
                <Button
                  disabled={(!enableRemote && (!servicePath || (isPyService && !envName))) || (enableRemote && (!remoteHost || !port)) || activating}
                  onClick={() => submitActivate(async () => {
                    await fetchRunning()
                    await fetchNodesExtended()
                  })}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {activating ? (enableRemote ? 'Connecting...' : 'Activating...') : (enableRemote ? 'Connect' : 'Activate')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <NodeLogsDialog
          open={logsOpen}
          onOpenChange={setLogsOpen}
          env={logsTarget?.env}
          port={logsTarget?.port}
          node={logsTarget?.node}
          pollMs={2000}
        />

        {/* Tutorial video dialog (Browse by Factory) */}
        <Dialog open={showHomeTutorial} onOpenChange={setShowHomeTutorial}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>How to use this page</DialogTitle>
            </DialogHeader>
            <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-muted">
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <PlayCircle className="h-12 w-12" />
                <p className="text-sm">Tutorial video placeholder</p>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {confirmTarget}?</DialogTitle>
            </DialogHeader>
            <div className="text-sm text-muted-foreground">
              This removes the node from the registry. It does not uninstall its Conda environment.
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <Button variant="outline" onClick={() => { setConfirmOpen(false); setConfirmTarget(null) }}>Cancel</Button>
              <Button
                variant="destructive"
                className="hover:bg-destructive/90"
                onClick={async () => {
                if (confirmTarget) {
                  const target = confirmTarget
                  setConfirmOpen(false)
                  setConfirmTarget(null)
                  await handleDeleteNode(target)
                }
              }}
              >
                Delete
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={installOpen} onOpenChange={setInstallOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Installing bundle</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="relative pl-6">
                <div className="absolute left-2 top-1 bottom-1 w-[2px] bg-border" />
                <div className="space-y-3">
                  {installSteps.map((s) => (
                    <div key={s.key} className="relative">
                      {s.status === 'active' && (
                        <div className="absolute -left-[21px] top-[4px] z-10 h-3 w-3 animate-ping rounded-full bg-primary opacity-60" />
                      )}
                      <div
                        className={`absolute -left-[21px] top-[4px] z-20 h-3 w-3 rounded-full ${
                          s.status === 'done'
                            ? 'bg-muted-foreground'
                            : s.status === 'active'
                              ? 'bg-primary'
                              : s.status === 'failed'
                                ? 'bg-destructive'
                                : 'bg-muted'
                        }`}
                      />
                      <div className="text-sm">
                        <span className="font-medium">{s.label}</span>
                        {s.key === 'download' && installProgress.percent > 0 && (
                          <div className="mt-2">
                            <Progress value={installProgress.percent} />
                            <div className="mt-1 text-xs text-muted-foreground">{installProgress.text}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>

    </>
  )
}
