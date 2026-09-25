"use client"

import React from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label as UILabel } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Boxes, Check, Download, PlayCircle, Plus, RotateCw, Upload, X } from "lucide-react"
import NodeLogsDialog from "@/components/imageViewer/sidebar/agent/graph/NodeLogsDialog"
import ClassifierFolderBrowser from "@/components/imageViewer/sidebar/agent/graph/ClassifierFolderBrowser"
import { type CommunityWorkflow } from "@/constants/communityWorkflowsDefault"
import { classifierMatchesNode } from "@/utils/agent/graph/classifiers"
import { registryCategoryNames, registryNodes } from "@/utils/agent/graph/constants"
import type { CommunityClassifierOption, FolderClassifierOption, GraphNode } from "@/types/graph.types"
import type { SerializedWorkflow } from "@/utils/agent/workflow/serializedWorkflow"
import { useAuthorProfile } from "@/hooks/community/useAuthorProfile"
import { useDispatch, useSelector } from "react-redux"
import type { AppDispatch, RootState } from "@/store"
import { addNucleiClass } from "@/store/slices/viewer/annotationSlice"
import { generateRandomColor } from "@/utils/common/color.utils"
import { CELL_TAXONOMY } from "@/constants/cellTaxonomy"
import { toast } from "sonner"

// Maps a "Class library (by type)" taxonomy group + class name to the id of the
// corresponding tissuelab-authored cloud classifier. MUST mirror the seed
// script's id scheme (seed_tissuelab_classifiers.py: `tissuelab-<organ>-<slug>`)
// so a chip click resolves to the right cloud classifier to train.
const TAXO_GROUP_TO_ORGAN: Record<string, string> = {
  "Cancer-agnostic": "agnostic",
  "Skin": "skin",
  "Prostate": "prostate",
  "Breast": "breast",
  "Colon / Rectum": "colon",
  "Lung": "lung",
  "Lymph node": "lymph_node",
  "Bladder": "bladder",
  "Stomach / GI (upper)": "gastric",
  "Pancreas": "pancreas",
  "Liver": "liver",
  "Kidney": "kidney",
}
const taxoSlug = (s: string) =>
  s.replace(/\([^)]*\)/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
const taxonomyClassifierId = (group: string, name: string) =>
  `tissuelab-${TAXO_GROUP_TO_ORGAN[group] || "agnostic"}-${taxoSlug(name)}`

// Official TissueLab classifiers use the id scheme `tissuelab-<organ>-<slug>`;
// user-community uploads use `uploaded-<n>`. Only official ones are protected
// from forking (Save-as-own) — you can still contribute back via Publish. A
// user-community classifier can be both forked AND republished.
const isOfficialClassifierId = (id?: string | null): boolean =>
  !!id && id.startsWith("tissuelab-")


/**
 * One row in the Community section of the Load Workflow dialog. Extracted so
 * it can call `useAuthorProfile` (hooks can't be called inside .map). Resolves
 * the publisher's display name / avatar per-uid via the public-profile
 * endpoint (browser-cached, deduped).
 */
function CommunityWorkflowRow({
  wf,
  fmtDate,
  onSelect,
}: {
  wf: CommunityWorkflow
  fmtDate: (iso?: string) => string
  onSelect: (wf: CommunityWorkflow) => void
}) {
  const modelCount = wf.nodes.filter((n) => n.kind === "model").length
  const authorProfile = useAuthorProfile(wf.ownerId)
  // Live resolved name first, then the legacy denormalized `author` string
  // baked into older workflow docs at register time.
  const displayAuthor = authorProfile?.displayName || wf.author
  const avatarUrl = authorProfile?.avatarUrl || null
  return (
    <button
      type="button"
      onClick={() => onSelect(wf)}
      className="group flex w-full items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/30"
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={displayAuthor || "author avatar"}
          className="mt-0.5 h-8 w-8 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Boxes className="h-4 w-4" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-sm font-semibold text-foreground">{wf.name}</div>
          <div className="shrink-0 text-[10px] text-muted-foreground">{fmtDate(wf.savedAt)}</div>
        </div>
        {wf.description && (
          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{wf.description}</div>
        )}
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          {displayAuthor && <span className="truncate">By {displayAuthor}</span>}
          {displayAuthor && <span>·</span>}
          <span>{modelCount} {modelCount === 1 ? "model" : "models"}</span>
          <span>·</span>
          <span>{wf.connections.length} {wf.connections.length === 1 ? "edge" : "edges"}</span>
        </div>
      </div>
    </button>
  )
}

/** Resolves a community classifier's author uid to a display name (falls back
 *  to the raw value on miss). Extracted so `useAuthorProfile` runs outside the
 *  classifier rows' `.map()`, where hooks can't be called. */
function ClassifierAuthor({ ownerId, author }: { ownerId?: string; author?: string }) {
  // Resolve the real uid -> display name (preferred name / email). Fall back to
  // the pre-computed author string, which is itself a truncated-uid fallback —
  // so we must pass the full ownerId here, NOT `author`, or the lookup 404s.
  const profile = useAuthorProfile(ownerId)
  const name = profile?.displayName || author
  return name ? <span className="truncate">By {name}</span> : null
}

export interface WorkflowGraphDialogsProps {
  logDialogOpen: boolean
  setLogDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  selectedLogTarget: { node: string; logPath?: string; envName?: string; port?: number } | null
  saveDialogOpen: boolean
  setSaveDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  saveForm: { name: string; description: string; author: string; tags: string; publish: boolean }
  setSaveForm: React.Dispatch<React.SetStateAction<{ name: string; description: string; author: string; tags: string; publish: boolean }>>
  submitSave: () => void
  activeWf: { nodes: GraphNode[]; connections: unknown[] }
  classifierSaveOpen: boolean
  setClassifierSaveOpen: React.Dispatch<React.SetStateAction<boolean>>
  classifierSaveForm: { name: string; description: string; author: string; tags: string; publish: boolean }
  setClassifierSaveForm: React.Dispatch<React.SetStateAction<{ name: string; description: string; author: string; tags: string; publish: boolean }>>
  classifierContextNodeId: string | null
  submitClassifierSave: () => void | Promise<void>
  classifierLoadOpen: boolean
  setClassifierLoadOpen: React.Dispatch<React.SetStateAction<boolean>>
  classifierLoadSearch: string
  setClassifierLoadSearch: React.Dispatch<React.SetStateAction<string>>
  communityClassifiers: CommunityClassifierOption[]
  communityClassifiersLoading: boolean
  /** Re-list the file browser's current folder AND re-fetch community. */
  refreshClassifierLists: () => void
  /** `.tlcls` files from the current file-manager listing (Web + desktop).
   *  Seeds the browser's first paint before its own listing lands. */
  folderClassifiers: FolderClassifierOption[]
  /** Folder the classifier browser opens on (the file manager's current listing). */
  folderClassifiersScanPath: string
  /** Web storage vs. local desktop paths — picks the browser's listing source. */
  isWebMode: boolean
  loadClassifierIntoNode: (c: {
    name: string
    source: "library" | "community" | "folder"
    path?: string
    id?: string
    author?: string
    savedAt?: string
    intent?: "load" | "train"
  }) => void
  /** Create a NEW empty classifier file for the context node + start training
   *  into it (same as the Save-Classifier flow). Used by the taxonomy picker. */
  saveClassifierFile: (nodeId: string, options?: { outputStem?: string }) => Promise<{ ok: boolean }>
  /** Community classifier id currently downloading, or null when idle. */
  classifierDownloadId: string | null
  /** Download progress 0–100, or -1 for indeterminate (no Content-Length). */
  classifierDownloadPct: number
  tutorialOpen: boolean
  setTutorialOpen: React.Dispatch<React.SetStateAction<boolean>>
  loadDialogOpen: boolean
  setLoadDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  loadSearch: string
  setLoadSearch: React.Dispatch<React.SetStateAction<string>>
  communityWorkflows: CommunityWorkflow[]
  communityWorkflowsLoading: boolean
  savedList: Record<string, SerializedWorkflow>
  handleLoadCommunityWorkflow: (wf: CommunityWorkflow) => void
  handleLoadFromStorage: (name: string) => void
  handleDeleteSaved: (name: string) => void
  handleImportFile: () => void
  handleExportFile: () => void
  /** Called when the Load dialog opens AND when the user clicks the refresh icon. */
  refreshLoadDialogLists: () => void
  /** Non-null when a Publish-on-Save scan found local classifier files that need
   *  uploading first. Dialog lists them and asks the user before we kick off uploads. */
  pendingPublish: { workflowName: string; localClassifiers: { displayName: string; path: string }[] } | null
  publishInFlight: boolean
  onConfirmPublish: () => void
  onCancelPublish: () => void
}

export function WorkflowGraphDialogs(props: WorkflowGraphDialogsProps) {
  const {
    logDialogOpen,
    setLogDialogOpen,
    selectedLogTarget,
    saveDialogOpen,
    setSaveDialogOpen,
    saveForm,
    setSaveForm,
    submitSave,
    activeWf,
    classifierSaveOpen,
    setClassifierSaveOpen,
    classifierSaveForm,
    setClassifierSaveForm,
    classifierContextNodeId,
    submitClassifierSave,
    classifierLoadOpen,
    setClassifierLoadOpen,
    classifierLoadSearch,
    setClassifierLoadSearch,
    communityClassifiers,
    communityClassifiersLoading,
    refreshClassifierLists,
    folderClassifiers,
    folderClassifiersScanPath,
    isWebMode,
    loadClassifierIntoNode,
    saveClassifierFile,
    classifierDownloadId,
    classifierDownloadPct,
    tutorialOpen,
    setTutorialOpen,
    loadDialogOpen,
    setLoadDialogOpen,
    loadSearch,
    setLoadSearch,
    communityWorkflows,
    communityWorkflowsLoading,
    savedList,
    handleLoadCommunityWorkflow,
    handleLoadFromStorage,
    handleDeleteSaved,
    handleImportFile,
    handleExportFile,
    pendingPublish,
    publishInFlight,
    onConfirmPublish,
    onCancelPublish,
    refreshLoadDialogLists,
  } = props

  // Bumped by the Load dialog's Refresh so the folder browser re-lists the
  // folder it is currently showing (which is no longer the file manager's).
  const [browserRefreshToken, setBrowserRefreshToken] = React.useState(0)

  // "Class library (by type)" picker → seed an annotation class from the
  // predefined taxonomy. Adds straight into the cell class list (persists once
  // the annotator labels cells with it), mirroring a manual "New class".
  const dispatch = useDispatch<AppDispatch>()
  const nucleiClasses = useSelector((s: RootState) => s.annotations.nucleiClasses)
  const addedClassNames = React.useMemo(
    () => new Set(nucleiClasses.map((c) => c.name.toLowerCase())),
    [nucleiClasses]
  )
  const addTaxonomyClass = React.useCallback(
    async (group: string, name: string) => {
      // Add the class to the annotation UI (so cells can be labeled with it),
      // unless it's already there.
      if (!addedClassNames.has(name.toLowerCase())) {
        const color = generateRandomColor(nucleiClasses.map((c) => c.color))
        dispatch(addNucleiClass({ name, count: 0, color }))
      }
      // One pick per open — mirrors loading a classifier (single selection, closes).
      setClassifierLoadOpen(false)
      // Prefer the matching tissuelab CLOUD classifier (1:1 with the taxonomy):
      // pick it in TRAIN mode so annotations train + republish to the shared
      // model. Fall back to a local-only classifier when the cloud one isn't
      // present (not seeded in this env / list not loaded yet).
      const cloud = communityClassifiers.find(
        (c) => c.ownerId === "tissuelab" && c.id === taxonomyClassifierId(group, name)
      )
      if (cloud) {
        loadClassifierIntoNode({
          name: cloud.name,
          source: "community",
          path: cloud.path,
          id: cloud.id,
          author: cloud.author,
          savedAt: cloud.savedAt,
          intent: "train",
        })
      } else if (classifierContextNodeId) {
        await saveClassifierFile(classifierContextNodeId, { outputStem: name })
      } else {
        toast.success(`Added "${name}"`)
      }
    },
    [addedClassNames, nucleiClasses, dispatch, setClassifierLoadOpen, classifierContextNodeId, saveClassifierFile, communityClassifiers, loadClassifierIntoNode]
  )

  return (
    <>
      <NodeLogsDialog
        open={logDialogOpen}
        onOpenChange={setLogDialogOpen}
        env={selectedLogTarget?.envName}
        port={selectedLogTarget?.port}
        node={selectedLogTarget?.node}
        pollMs={2000}
      />

      {/* ─── Save Classifier dialog ─── */}
      <Dialog open={classifierSaveOpen} onOpenChange={setClassifierSaveOpen}>
        <DialogContent
          className="sm:max-w-lg"
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Save Classifier</DialogTitle>
            <DialogDescription className="text-xs">
              Only Name is required. Saves to the current folder in the sidebar; the file name is derived from Name
              (with unsafe characters removed). Other fields are optional.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {(() => {
              const node = classifierContextNodeId
                ? activeWf.nodes.find((n) => n.id === classifierContextNodeId)
                : null
              const meta = node?.modelId ? registryNodes[node.modelId] : undefined
              if (!meta) return null
              return (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                    {meta.icon ? (
                      <Image src={meta.icon} alt={meta.displayName || ""} width={32} height={32} className="h-full w-full object-cover" />
                    ) : (
                      <Boxes className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{meta.displayName || node?.modelId}</div>
                    {meta.factory && (
                      <div className="truncate text-xs text-muted-foreground">
                        {registryCategoryNames[meta.factory] || meta.factory}
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}
            <div className="space-y-1">
              <UILabel htmlFor="wg-clf-save-name" className="text-xs">
                Name <span className="text-destructive">*</span>
              </UILabel>
              <Input
                id="wg-clf-save-name"
                value={classifierSaveForm.name}
                onChange={(e) => setClassifierSaveForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="My classifier"
              />
            </div>
            <div className="space-y-1">
              <UILabel htmlFor="wg-clf-save-desc" className="text-xs">Description</UILabel>
              <Textarea
                id="wg-clf-save-desc"
                value={classifierSaveForm.description}
                onChange={(e) => setClassifierSaveForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What does this classifier do? Cohort, classes, intended use…"
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <UILabel htmlFor="wg-clf-save-author" className="text-xs">Author</UILabel>
                <Input
                  id="wg-clf-save-author"
                  value={classifierSaveForm.author}
                  onChange={(e) => setClassifierSaveForm((f) => ({ ...f, author: e.target.value }))}
                  placeholder="Your name"
                />
              </div>
              <div className="space-y-1">
                <UILabel htmlFor="wg-clf-save-tags" className="text-xs">Tags (comma-separated)</UILabel>
                <Input
                  id="wg-clf-save-tags"
                  value={classifierSaveForm.tags}
                  onChange={(e) => setClassifierSaveForm((f) => ({ ...f, tags: e.target.value }))}
                  placeholder="pathology, breast, tumor"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">Tags are comma-separated; you may leave this blank.</p>
            {isOfficialClassifierId(activeWf.nodes.find((n) => n.id === classifierContextNodeId)?.loadedClassifier?.communityId) ? (
              // An OFFICIAL TissueLab classifier is loaded — contributing back is
              // done via the node's dedicated "Publish" button (republishes to the
              // same cloud id). "Save" here only writes a local copy, so we hide the
              // "publish as a new classifier" option to avoid an accidental fork.
              // (User-community classifiers are NOT gated here — they can be forked
              // into your own new classifier AND republished via Publish.)
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
                This is a TissueLab classifier. Use the{" "}
                <span className="font-medium text-primary">Publish</span> button on the node to
                contribute your training back to it. Saving here only writes a local copy.
              </p>
            ) : (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <Checkbox
                  id="wg-clf-save-publish"
                  checked={classifierSaveForm.publish}
                  onCheckedChange={(v) =>
                    setClassifierSaveForm((f) => ({ ...f, publish: v === true }))
                  }
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <UILabel htmlFor="wg-clf-save-publish" className="text-xs font-medium leading-snug">
                    Publish to community when training completes
                  </UILabel>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Saves locally now and starts an initial training run. When the run finishes,
                    the classifier uploads to the community automatically (a toast shows progress).
                  </p>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClassifierSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submitClassifierSave()}>Save Classifier</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Save Workflow dialog — non-dismissable on outside click ─── */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent
          className="sm:max-w-lg"
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Save Workflow</DialogTitle>
            <DialogDescription className="text-xs">
              Saves the canvas graph, Agentic AI chat, and per-node configuration—including Code Calculation prompt,
              generated script, and last run outputs.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <UILabel htmlFor="wg-save-name" className="text-xs">Name <span className="text-destructive">*</span></UILabel>
              <Input
                id="wg-save-name"
                value={saveForm.name}
                onChange={(e) => setSaveForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="My Workflow"
              />
            </div>
            <div className="space-y-1">
              <UILabel htmlFor="wg-save-desc" className="text-xs">Description</UILabel>
              <Textarea
                id="wg-save-desc"
                value={saveForm.description}
                onChange={(e) => setSaveForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What does this workflow do?"
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <UILabel htmlFor="wg-save-author" className="text-xs">Author</UILabel>
                <Input
                  id="wg-save-author"
                  value={saveForm.author}
                  onChange={(e) => setSaveForm((f) => ({ ...f, author: e.target.value }))}
                  placeholder="Your name"
                />
              </div>
              <div className="space-y-1">
                <UILabel htmlFor="wg-save-tags" className="text-xs">Tags (comma-separated)</UILabel>
                <Input
                  id="wg-save-tags"
                  value={saveForm.tags}
                  onChange={(e) => setSaveForm((f) => ({ ...f, tags: e.target.value }))}
                  placeholder="pathology, segmentation"
                />
              </div>
            </div>
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {activeWf.nodes.filter((n) => n.kind === "model").length} model nodes ·{" "}
              {activeWf.connections.length} connections will be uploaded.
            </div>
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
              <Checkbox
                id="wg-save-publish"
                checked={saveForm.publish}
                onCheckedChange={(v) => setSaveForm((f) => ({ ...f, publish: v === true }))}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <UILabel htmlFor="wg-save-publish" className="text-xs font-medium leading-snug">
                  Publish to community
                </UILabel>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Also uploads to the public community feed. Any locally-trained classifiers
                  referenced by this workflow will be uploaded too (you&apos;ll be asked to confirm).
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>Cancel</Button>
            <Button onClick={submitSave}>{saveForm.publish ? "Save & Publish" : "Save to library"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Publish-time classifier-upload confirmation ─── */}
      <Dialog
        open={pendingPublish !== null}
        onOpenChange={(open) => {
          if (!open && !publishInFlight) onCancelPublish()
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Publish to community?</DialogTitle>
            <DialogDescription className="text-xs">
              {pendingPublish
                ? pendingPublish.localClassifiers.length > 0
                  ? `Publishing "${pendingPublish.workflowName}" will upload these locally-trained classifiers first, then the workflow itself. Each classifier becomes a public community classifier.`
                  : `"${pendingPublish.workflowName}" will be uploaded to the community feed. All its classifier references already exist in the community — nothing else needs to be uploaded.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {pendingPublish && pendingPublish.localClassifiers.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
              <ul className="space-y-1">
                {pendingPublish.localClassifiers.map((c, idx) => (
                  <li key={`${c.path}-${idx}`} className="flex flex-col">
                    <span className="font-medium">{c.displayName}</span>
                    <span className="truncate text-[10px] text-muted-foreground">{c.path}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onCancelPublish} disabled={publishInFlight}>
              Cancel
            </Button>
            <Button onClick={onConfirmPublish} disabled={publishInFlight}>
              {publishInFlight
                ? "Uploading…"
                : pendingPublish && pendingPublish.localClassifiers.length > 0
                  ? "Upload & publish"
                  : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Load Classifier dialog ─── */}
      <Dialog open={classifierLoadOpen} onOpenChange={setClassifierLoadOpen}>
        <DialogContent className="max-w-[min(42rem,calc(100vw-2rem))] overflow-x-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Load Classifier</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Search this folder & community..."
              value={classifierLoadSearch}
              onChange={(e) => setClassifierLoadSearch(e.target.value)}
              className="h-9"
            />
            <div className="-mx-1 max-h-[55vh] min-w-0 max-w-full space-y-2 overflow-y-auto overflow-x-hidden pr-1">
              {(() => {
                const q = classifierLoadSearch.trim().toLowerCase()
                const node = classifierContextNodeId
                  ? activeWf.nodes.find((n) => n.id === classifierContextNodeId)
                  : null
                const compatibleId = node?.modelId
                // A community download is in flight — lock the rows so a second
                // click can't kick off a concurrent import.
                const downloading = classifierDownloadId !== null
                // Filter community by compatible model/factory + search.
                const community = communityClassifiers.filter((c) => {
                  // tissuelab-authored cloud classifiers are reached via the
                  // "Class library (by type)" chips below (1:1 with the taxonomy),
                  // so keep them out of the user-upload "Community" list.
                  if (c.ownerId === "tissuelab") return false
                  const matchesModel = !compatibleId || classifierMatchesNode(c, node)
                  const matchesQ =
                    !q ||
                    c.name.toLowerCase().includes(q) ||
                    (c.description || "").toLowerCase().includes(q) ||
                    (c.author || "").toLowerCase().includes(q)
                  return matchesModel && matchesQ
                })
                return (
                  <>
                    <div className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">My files</div>
                    <ClassifierFolderBrowser
                      isWebMode={isWebMode}
                      initialPath={folderClassifiersScanPath}
                      seedOptions={folderClassifiers}
                      query={classifierLoadSearch}
                      node={node}
                      disabled={downloading}
                      refreshToken={browserRefreshToken}
                      onPick={(c) =>
                        loadClassifierIntoNode({
                          name: c.name,
                          source: "folder",
                          path: c.path,
                        })
                      }
                    />

                    <div className="mt-3 flex items-center justify-between px-1">
                      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Community</span>
                      <button
                        type="button"
                        onClick={() => {
                          setBrowserRefreshToken((n) => n + 1)
                          refreshClassifierLists()
                        }}
                        disabled={communityClassifiersLoading || downloading}
                        title="Refresh folder & community classifiers"
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RotateCw className={`h-3 w-3 ${communityClassifiersLoading ? "animate-spin" : ""}`} />
                        Refresh
                      </button>
                    </div>
                    {communityClassifiersLoading ? (
                      <div className="px-1 py-2 text-xs text-muted-foreground">Loading community classifiers...</div>
                    ) : community.length === 0 ? (
                      <div className="px-1 py-2 text-xs text-muted-foreground">No matching community classifiers.</div>
                    ) : (
                      community.map((c) => {
                        const isDownloadingThis = classifierDownloadId === c.id
                        return (
                        <button
                          key={c.id}
                          type="button"
                          disabled={downloading}
                          onClick={() => loadClassifierIntoNode({
                            name: c.name,
                            source: "community",
                            path: c.path,
                            id: c.id,
                            author: c.author,
                            savedAt: c.savedAt,
                            // Train on top + write back, same as the official chips,
                            // so annotations refine this community model and it can be
                            // republished (Publish) or forked into your own (Save).
                            intent: "train",
                          })}
                          className="flex min-w-0 max-w-full w-full flex-col gap-1 rounded-md border border-border bg-card p-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:bg-card"
                        >
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <div className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-foreground">
                              {c.name}
                            </div>
                            <div className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                              {registryNodes[c.modelId]?.displayName || c.modelId}
                            </div>
                          </div>
                          <div className="line-clamp-2 text-xs text-muted-foreground">{c.description}</div>
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <ClassifierAuthor ownerId={c.ownerId} author={c.author} />
                            {c.tags && c.tags.length > 0 && <span>·</span>}
                            {c.tags?.map((t) => (
                              <span key={t} className="rounded bg-muted px-1.5 py-0.5">{t}</span>
                            ))}
                          </div>
                          {isDownloadingThis && (
                            <div className="mt-1">
                              <div className="flex items-center justify-between text-[10px] font-medium text-primary">
                                <span>Importing…</span>
                                {classifierDownloadPct >= 0 && <span>{classifierDownloadPct}%</span>}
                              </div>
                              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-primary/15">
                                <div
                                  className={
                                    classifierDownloadPct >= 0
                                      ? "h-full rounded-full bg-primary transition-all duration-200"
                                      : "h-full w-1/2 animate-pulse rounded-full bg-primary"
                                  }
                                  style={classifierDownloadPct >= 0 ? { width: `${classifierDownloadPct}%` } : undefined}
                                />
                              </div>
                            </div>
                          )}
                        </button>
                        )
                      })
                    )}

                    {/* ─── Official classifiers: pick a cell type to train the matching
                          TissueLab (official) cloud classifier (1:1 with the taxonomy). ─── */}
                    <div className="mt-3 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Contribute to official classifier
                    </div>
                    {CELL_TAXONOMY.map((grp) => {
                      const rows = grp.classes.filter(
                        (name) => !q || name.toLowerCase().includes(q) || grp.group.toLowerCase().includes(q)
                      )
                      if (rows.length === 0) return null
                      return (
                        <div key={grp.group} className="px-1 pb-1">
                          <div className="pb-1 text-[10px] font-medium text-muted-foreground/80">{grp.group}</div>
                          <div className="flex flex-wrap gap-1.5">
                            {rows.map((name) => {
                              const added = addedClassNames.has(name.toLowerCase())
                              return (
                                <button
                                  key={name}
                                  type="button"
                                  onClick={() => addTaxonomyClass(grp.group, name)}
                                  disabled={added}
                                  title={added ? "Already added" : `Add "${name}" as a class`}
                                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors ${
                                    added
                                      ? "cursor-default border-primary/30 bg-primary/5 text-muted-foreground"
                                      : "border-border bg-card text-foreground hover:border-primary/60 hover:bg-accent/30"
                                  }`}
                                >
                                  {added ? <Check className="h-3 w-3 text-primary" /> : <Plus className="h-3 w-3" />}
                                  {name}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </>
                )
              })()}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Watch Tutorial dialog ─── */}
      <Dialog open={tutorialOpen} onOpenChange={setTutorialOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>How to use the Workflow Graph</DialogTitle>
          </DialogHeader>
          <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-muted">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <PlayCircle className="h-12 w-12" />
              <p className="text-sm">Tutorial video placeholder</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Load Workflow dialog ─── */}
      <Dialog open={loadDialogOpen} onOpenChange={setLoadDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
            <div className="space-y-1">
              <DialogTitle>Load Workflow</DialogTitle>
              <DialogDescription className="text-xs">
                Pick a community template or one of your saved workflows. The list refreshes every time you open
                this dialog.
              </DialogDescription>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => refreshLoadDialogLists()}
              disabled={communityWorkflowsLoading}
              title="Refresh lists"
            >
              <RotateCw className={`h-4 w-4 ${communityWorkflowsLoading ? "animate-spin" : ""}`} />
            </Button>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              placeholder="Search by name, description, or author…"
              value={loadSearch}
              onChange={(e) => setLoadSearch(e.target.value)}
              className="h-9"
            />

            <div className="-mx-1 max-h-[55vh] space-y-4 overflow-y-auto pr-1">
              {(() => {
                const q = loadSearch.trim().toLowerCase()
                const matchesCommunity = communityWorkflows.filter((w) => {
                  if (!q) return true
                  // Note: author search only matches the denormalized `author`
                  // string baked into older docs at register time. The
                  // current display name is resolved per-row via
                  // useAuthorProfile and isn't available at filter time.
                  const haystack = [w.name, w.description, w.author]
                    .filter((s): s is string => typeof s === "string")
                    .join(" ")
                    .toLowerCase()
                  return haystack.includes(q)
                })
                const savedEntries = Object.entries(savedList)
                  .sort(([, a], [, b]) => (b.savedAt || "").localeCompare(a.savedAt || ""))
                  .filter(
                    ([name, w]) =>
                      !q ||
                      name.toLowerCase().includes(q) ||
                      w.author?.toLowerCase().includes(q) ||
                      w.description?.toLowerCase().includes(q)
                  )

                const fmtDate = (iso?: string) => {
                  if (!iso) return ""
                  try { return new Date(iso).toLocaleDateString() } catch { return "" }
                }

                const nothingShown = matchesCommunity.length === 0 && savedEntries.length === 0

                return (
                  <>
                    <section className="space-y-2">
                      <div className="flex items-center justify-between px-1">
                        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Community
                        </h4>
                        <span className="text-[10px] text-muted-foreground">
                          {communityWorkflowsLoading ? "…" : matchesCommunity.length}
                        </span>
                      </div>
                      {communityWorkflowsLoading ? (
                        <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
                          <RotateCw className="h-3.5 w-3.5 animate-spin" />
                          Loading community workflows…
                        </div>
                      ) : matchesCommunity.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
                          {q ? "No matching community workflows." : "No community workflows published yet."}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {matchesCommunity.map((wf) => (
                            <CommunityWorkflowRow
                              key={wf.id}
                              wf={wf}
                              fmtDate={fmtDate}
                              onSelect={handleLoadCommunityWorkflow}
                            />
                          ))}
                        </div>
                      )}
                    </section>

                    <section className="space-y-2">
                      <div className="flex items-center justify-between px-1">
                        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Your library
                        </h4>
                        <span className="text-[10px] text-muted-foreground">{savedEntries.length}</span>
                      </div>
                      {savedEntries.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
                          Nothing saved yet — use the Save button after building a workflow.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {savedEntries.map(([name, wf]) => {
                            const graphNodes = wf.nodes as GraphNode[]
                            const modelCount = graphNodes.filter((n) => n.kind === "model").length
                            return (
                              <div
                                key={name}
                                className="group flex items-start gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/60 hover:bg-accent/30"
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleLoadFromStorage(name)
                                    setLoadDialogOpen(false)
                                  }}
                                  className="flex flex-1 items-start gap-3 text-left min-w-0"
                                >
                                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                                    <Boxes className="h-4 w-4" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="truncate text-sm font-semibold text-foreground">{name}</div>
                                      <div className="shrink-0 text-[10px] text-muted-foreground">{fmtDate(wf.savedAt)}</div>
                                    </div>
                                    {wf.description && (
                                      <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{wf.description}</div>
                                    )}
                                    <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                                      <span>{modelCount} {modelCount === 1 ? "model" : "models"}</span>
                                      <span>·</span>
                                      <span>{wf.connections.length} {wf.connections.length === 1 ? "edge" : "edges"}</span>
                                    </div>
                                  </div>
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); handleDeleteSaved(name) }}
                                  className="hidden h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive hover:text-destructive-foreground group-hover:flex"
                                  title="Delete from My library"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </section>

                    {nothingShown && q && (
                      <div className="py-6 text-center text-xs text-muted-foreground">
                        No workflows match &ldquo;{loadSearch}&rdquo;.
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          </div>

          <DialogFooter className="flex-row gap-2 sm:justify-between">
            <Button type="button" variant="ghost" size="sm" onClick={handleImportFile}>
              <Upload className="mr-1 h-3.5 w-3.5" />
              Import from file…
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={handleExportFile}>
              <Download className="mr-1 h-3.5 w-3.5" />
              Export current
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
