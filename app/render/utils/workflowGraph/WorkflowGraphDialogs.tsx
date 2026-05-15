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
import { Input } from "@/components/ui/input"
import { Label as UILabel } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Boxes, Download, PlayCircle, Upload, X } from "lucide-react"
import NodeLogsDialog from "@/components/imageViewer/AgentZoo/NodeLogsDialog"
import { type CommunityWorkflow } from "@/constants/communityWorkflowsDefault"
import { classifierMatchesNode } from "@/utils/workflowGraph/classifiers"
import { registryCategoryNames, registryNodes } from "@/utils/workflowGraph/constants"
import type { CommunityClassifierOption, FolderClassifierOption, GraphNode } from "@/utils/workflowGraph/types"
import type { SerializedWorkflow } from "@/utils/workflow/serializedWorkflow"

export interface WorkflowGraphDialogsProps {
  logDialogOpen: boolean
  setLogDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  selectedLogTarget: { node: string; logPath?: string; envName?: string; port?: number } | null
  saveDialogOpen: boolean
  setSaveDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  saveForm: { name: string; description: string; author: string; tags: string }
  setSaveForm: React.Dispatch<React.SetStateAction<{ name: string; description: string; author: string; tags: string }>>
  submitSave: () => void
  activeWf: { nodes: GraphNode[]; connections: unknown[] }
  classifierSaveOpen: boolean
  setClassifierSaveOpen: React.Dispatch<React.SetStateAction<boolean>>
  classifierSaveForm: { name: string; description: string; author: string; tags: string }
  setClassifierSaveForm: React.Dispatch<React.SetStateAction<{ name: string; description: string; author: string; tags: string }>>
  classifierContextNodeId: string | null
  submitClassifierSave: () => void | Promise<void>
  classifierLoadOpen: boolean
  setClassifierLoadOpen: React.Dispatch<React.SetStateAction<boolean>>
  classifierLoadSearch: string
  setClassifierLoadSearch: React.Dispatch<React.SetStateAction<string>>
  communityClassifiers: CommunityClassifierOption[]
  communityClassifiersLoading: boolean
  /** `.tlcls` files from the current file-manager listing (Web + desktop). */
  folderClassifiers: FolderClassifierOption[]
  /** Folder path used to resolve relative `file.path` entries (hint text when empty). */
  folderClassifiersScanPath: string
  loadClassifierIntoNode: (c: {
    name: string
    source: "library" | "community" | "folder"
    path?: string
    author?: string
    savedAt?: string
  }) => void
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
    folderClassifiers,
    folderClassifiersScanPath,
    loadClassifierIntoNode,
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
  } = props

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
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>Cancel</Button>
            <Button onClick={submitSave}>Save to library</Button>
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
              placeholder="Search current folder & community..."
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
                const folderRows = folderClassifiers.filter((c) => {
                  const matchesQ =
                    !q ||
                    c.name.toLowerCase().includes(q) ||
                    c.path.toLowerCase().includes(q)
                  return matchesQ
                })
                // Filter community by compatible model/factory + search.
                const community = communityClassifiers.filter((c) => {
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
                    <div className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Current folder</div>
                    {folderRows.length === 0 ? (
                      <div className="px-1 py-2 text-xs text-muted-foreground">
                        No .tlcls in the current file list. Browse a folder in the sidebar that contains classifiers
                        {folderClassifiersScanPath ? (
                          <span className="block truncate pt-1 font-mono text-[10px] opacity-80" title={folderClassifiersScanPath}>
                            {folderClassifiersScanPath}
                          </span>
                        ) : null}
                        .
                      </div>
                    ) : (
                      folderRows.map((c) => (
                        <button
                          key={c.path}
                          type="button"
                          onClick={() =>
                            loadClassifierIntoNode({
                              name: c.name,
                              source: "folder",
                              path: c.path,
                            })
                          }
                          className="flex min-w-0 max-w-full w-full flex-col gap-1 rounded-md border border-border bg-card p-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/30"
                        >
                          <div className="min-w-0 break-words text-sm font-semibold leading-snug text-foreground">
                            {c.name}
                          </div>
                          <div
                            className="min-w-0 break-all font-mono text-[10px] leading-snug text-muted-foreground"
                            title={c.path}
                          >
                            {c.path}
                          </div>
                        </button>
                      ))
                    )}

                    <div className="mt-3 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Community</div>
                    {communityClassifiersLoading ? (
                      <div className="px-1 py-2 text-xs text-muted-foreground">Loading community classifiers...</div>
                    ) : community.length === 0 ? (
                      <div className="px-1 py-2 text-xs text-muted-foreground">No matching community classifiers.</div>
                    ) : (
                      community.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => loadClassifierIntoNode({
                            name: c.name,
                            source: "community",
                            path: c.path,
                            author: c.author,
                            savedAt: c.savedAt,
                          })}
                          className="flex min-w-0 max-w-full w-full flex-col gap-1 rounded-md border border-border bg-card p-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/30"
                        >
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <div className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-foreground">
                              {c.name}
                            </div>
                            <div className="flex-shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                              {registryNodes[c.modelId]?.displayName || c.modelId}
                            </div>
                          </div>
                          <div className="line-clamp-2 text-xs text-muted-foreground">{c.description}</div>
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span>By {c.author}</span>
                            {c.tags && c.tags.length > 0 && <span>·</span>}
                            {c.tags?.map((t) => (
                              <span key={t} className="rounded bg-muted px-1.5 py-0.5">{t}</span>
                            ))}
                          </div>
                        </button>
                      ))
                    )}
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
          <DialogHeader>
            <DialogTitle>Load Workflow</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              placeholder="Search community workflows…"
              value={loadSearch}
              onChange={(e) => setLoadSearch(e.target.value)}
              className="h-9"
            />

            <div className="-mx-1 max-h-[55vh] space-y-2 overflow-y-auto pr-1">
              {(() => {
                const q = loadSearch.trim().toLowerCase()
                const matchesCommunity = communityWorkflows.filter((w) =>
                  !q || w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q) || w.author.toLowerCase().includes(q)
                )
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
                    <div className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Community
                    </div>
                    {communityWorkflowsLoading ? (
                      <div className="px-1 py-2 text-xs text-muted-foreground">Loading community workflows...</div>
                    ) : matchesCommunity.length === 0 ? (
                      <div className="px-1 py-2 text-xs text-muted-foreground">No matching community workflows.</div>
                    ) : (
                      matchesCommunity.map((wf) => {
                        const modelCount = wf.nodes.filter((n) => n.kind === "model").length
                        return (
                          <button
                            key={wf.id}
                            type="button"
                            onClick={() => handleLoadCommunityWorkflow(wf)}
                            className="flex w-full flex-col gap-1 rounded-md border border-border bg-card p-3 text-left transition-colors hover:border-primary/60 hover:bg-accent/30"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="truncate text-sm font-semibold text-foreground">{wf.name}</div>
                              <div className="flex-shrink-0 text-[10px] text-muted-foreground">{fmtDate(wf.savedAt)}</div>
                            </div>
                            <div className="line-clamp-2 text-xs text-muted-foreground">{wf.description}</div>
                            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                              <span>By {wf.author}</span>
                              <span>·</span>
                              <span>{modelCount} {modelCount === 1 ? "model" : "models"}</span>
                              <span>·</span>
                              <span>{wf.connections.length} {wf.connections.length === 1 ? "edge" : "edges"}</span>
                            </div>
                          </button>
                        )
                      })
                    )}

                    <div className="mt-3 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Your library
                    </div>
                    {savedEntries.length === 0 ? (
                      <div className="px-1 py-2 text-xs text-muted-foreground">
                        Nothing saved yet — use the Save button to upload a workflow.
                      </div>
                    ) : (
                      savedEntries.map(([name, wf]) => {
                        const graphNodes = wf.nodes as GraphNode[]
                        const modelCount = graphNodes.filter((n) => n.kind === "model").length
                        return (
                          <div
                            key={name}
                            className="group flex items-start gap-2 rounded-md border border-border bg-card p-3 transition-colors hover:border-primary/60 hover:bg-accent/30"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                handleLoadFromStorage(name)
                                setLoadDialogOpen(false)
                              }}
                              className="flex flex-1 flex-col gap-1 text-left"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="truncate text-sm font-semibold text-foreground">{name}</div>
                                <div className="flex-shrink-0 text-[10px] text-muted-foreground">{fmtDate(wf.savedAt)}</div>
                              </div>
                              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                <span>{modelCount} {modelCount === 1 ? "model" : "models"}</span>
                                <span>·</span>
                                <span>{wf.connections.length} {wf.connections.length === 1 ? "edge" : "edges"}</span>
                              </div>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleDeleteSaved(name) }}
                              className="hidden h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive hover:text-destructive-foreground group-hover:flex"
                              title="Delete saved workflow"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )
                      })
                    )}

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
