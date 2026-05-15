"use client"

import React, { useEffect, useMemo, useState } from "react"
import { AlertCircle, CheckCircle2, Circle, Clock, FileWarning, History, Loader2, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  type WorkflowBatchFile,
  type WorkflowBatchHistoryEntry,
  type WorkflowBatchHistoryItem,
  type WorkflowBatchSourceMode,
  workflowBatchBasename,
} from "@/utils/workflowGraph/workflowBatchHistory"

type WorkflowBatchDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  files: WorkflowBatchFile[]
  selectedFolder: string
  isRunning: boolean
  isStopping: boolean
  activeEntry: WorkflowBatchHistoryEntry | null
  historyEntries: WorkflowBatchHistoryEntry[]
  onStart: (params: { files: WorkflowBatchFile[]; sourceMode: WorkflowBatchSourceMode; stopOnFirstError: boolean }) => void
  onStop: () => void
  onClearHistory: () => void
}

function formatTime(value?: number): string {
  if (!value) return "-"
  return new Date(value).toLocaleString()
}

function statusIcon(item: WorkflowBatchHistoryItem) {
  if (item.status === "completed") return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
  if (item.status === "error") return <AlertCircle className="h-3.5 w-3.5 text-destructive" />
  if (item.status === "skipped") return <FileWarning className="h-3.5 w-3.5 text-amber-500" />
  if (item.status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
  return <Circle className="h-3.5 w-3.5 text-muted-foreground" />
}

function BatchItemRow({ item }: { item: WorkflowBatchHistoryItem }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/50 bg-background/60 px-2 py-2 text-xs">
      <div className="mt-0.5 flex-shrink-0">{statusIcon(item)}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" title={item.path}>
          {workflowBatchBasename(item.path)}
        </div>
        <div className="whitespace-normal break-all text-[10px] leading-4 text-muted-foreground" title={item.path}>
          {item.path}
        </div>
        {item.errorMessage && (
          <div className="mt-1 whitespace-normal break-words rounded bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
            {item.errorPhase ? `${item.errorPhase}: ` : ""}
            {item.errorMessage}
          </div>
        )}
      </div>
      <div className="flex-shrink-0 text-[10px] uppercase text-muted-foreground">{item.status}</div>
    </div>
  )
}

function EntrySummary({ entry }: { entry: WorkflowBatchHistoryEntry }) {
  const done = entry.completedCount + entry.failedCount + entry.skippedCount
  const pct = entry.progress.total > 0 ? Math.round((done / entry.progress.total) * 100) : 0
  return (
    <div className="rounded-md border border-border/60 bg-card p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{entry.name}</div>
          <div className="text-[11px] text-muted-foreground">
            {formatTime(entry.startedAt)} · {entry.aggregateStatus}
          </div>
        </div>
        <div className="flex-shrink-0 text-xs text-muted-foreground">
          {done} / {entry.progress.total}
        </div>
      </div>
      <Progress value={pct} className="h-1.5" />
      <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        <span>Completed {entry.completedCount}</span>
        <span>Failed {entry.failedCount}</span>
        <span>Skipped {entry.skippedCount}</span>
      </div>
    </div>
  )
}

export function WorkflowBatchDialog(props: WorkflowBatchDialogProps) {
  const {
    open,
    onOpenChange,
    files,
    selectedFolder,
    isRunning,
    isStopping,
    activeEntry,
    historyEntries,
    onStart,
    onStop,
    onClearHistory,
  } = props
  const [sourceMode, setSourceMode] = useState<WorkflowBatchSourceMode>("folder_all")
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [stopOnFirstError, setStopOnFirstError] = useState(false)

  useEffect(() => {
    setSelectedPaths(new Set(files.map((file) => file.path)))
  }, [files])

  const selectedFiles = useMemo(() => {
    if (sourceMode === "folder_all") return files
    return files.filter((file) => selectedPaths.has(file.path))
  }, [files, selectedPaths, sourceMode])

  const activeDone = activeEntry
    ? activeEntry.completedCount + activeEntry.failedCount + activeEntry.skippedCount
    : 0
  const activePct = activeEntry && activeEntry.progress.total > 0
    ? Math.round((activeDone / activeEntry.progress.total) * 100)
    : 0

  const toggleFile = (path: string, checked: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (checked) next.add(path)
      else next.delete(path)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>Batch Process Workflow</DialogTitle>
          <DialogDescription>
            Run the active graph sequentially across selected slides. Failed files are recorded and skipped by default.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="run" className="min-h-0 px-5">
          <TabsList className="mb-3">
            <TabsTrigger value="run">Run</TabsTrigger>
            <TabsTrigger value="progress">Progress</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="run" className="min-h-0">
            <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
              <div className="space-y-3 rounded-md border border-border/60 bg-card p-3 text-sm">
                <div>
                  <div className="font-medium">Source</div>
                  <div className="mt-1 whitespace-normal break-all text-xs leading-5 text-muted-foreground">
                    {selectedFolder ? selectedFolder : "Current folder"}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={sourceMode === "folder_all"}
                    onCheckedChange={() => setSourceMode("folder_all")}
                    disabled={isRunning}
                  />
                  Use all images in folder
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={sourceMode === "multi_select"}
                    onCheckedChange={() => setSourceMode("multi_select")}
                    disabled={isRunning}
                  />
                  Select files manually
                </label>
                <label className="flex items-center gap-2 border-t border-border/60 pt-3 text-xs">
                  <Checkbox
                    checked={stopOnFirstError}
                    onCheckedChange={(checked) => setStopOnFirstError(checked === true)}
                    disabled={isRunning}
                  />
                  Stop on first error
                </label>
                <div className="rounded bg-muted/50 p-2 text-[11px] text-muted-foreground">
                  Batch uses the current ROI/settings for every selected slide.
                </div>
              </div>

              <div className="min-w-0 rounded-md border border-border/60">
                <div className="flex items-center justify-between border-b border-border/60 px-3 py-2 text-xs">
                  <span className="font-medium">Files ({selectedFiles.length} selected)</span>
                  {sourceMode === "multi_select" && (
                    <div className="flex gap-2">
                      <button className="text-primary hover:underline" onClick={() => setSelectedPaths(new Set(files.map((file) => file.path)))}>
                        Select all
                      </button>
                      <button className="text-muted-foreground hover:text-foreground" onClick={() => setSelectedPaths(new Set())}>
                        Clear
                      </button>
                    </div>
                  )}
                </div>
                <ScrollArea className="h-72">
                  <div className="space-y-1 p-2">
                    {files.length === 0 ? (
                      <div className="flex h-36 items-center justify-center text-xs text-muted-foreground">
                        No supported image files found in the current folder.
                      </div>
                    ) : (
                      files.map((file) => {
                        const checked = sourceMode === "folder_all" || selectedPaths.has(file.path)
                        return (
                          <label key={file.path} className="flex w-full min-w-0 items-start gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50">
                            <Checkbox
                              className="mt-0.5 flex-shrink-0"
                              checked={checked}
                              disabled={isRunning || sourceMode === "folder_all"}
                              onCheckedChange={(next) => toggleFile(file.path, next === true)}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium" title={file.name}>{file.name}</div>
                              <div className="whitespace-normal break-all text-[10px] leading-4 text-muted-foreground" title={file.path}>{file.path}</div>
                            </div>
                          </label>
                        )
                      })
                    )}
                  </div>
                </ScrollArea>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="progress" className="min-h-0">
            {activeEntry ? (
              <div className="space-y-3">
                <div className="rounded-md border border-border/60 bg-card p-3">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="font-medium">
                      {isRunning ? "Running" : "Last batch"} · {activeDone} / {activeEntry.progress.total}
                    </span>
                    <span className="text-xs text-muted-foreground">{activePct}%</span>
                  </div>
                  <Progress value={activePct} className="h-2" />
                  {activeEntry.progress.currentPath && (
                    <div className="mt-2 truncate text-xs text-muted-foreground" title={activeEntry.progress.currentPath}>
                      Current: {workflowBatchBasename(activeEntry.progress.currentPath)}
                    </div>
                  )}
                </div>
                <ScrollArea className="h-80 rounded-md border border-border/60">
                  <div className="space-y-2 p-2">
                    {activeEntry.items.map((item) => <BatchItemRow key={item.path} item={item} />)}
                  </div>
                </ScrollArea>
              </div>
            ) : (
              <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
                No batch is running yet.
              </div>
            )}
          </TabsContent>

          <TabsContent value="history" className="min-h-0">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <History className="h-4 w-4" />
                Batch history
              </div>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClearHistory} disabled={isRunning || historyEntries.length === 0}>
                Clear
              </Button>
            </div>
            <ScrollArea className="h-80">
              <div className="space-y-3 pr-2">
                {historyEntries.length === 0 ? (
                  <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
                    No batch history yet.
                  </div>
                ) : (
                  historyEntries.map((entry) => (
                    <div key={entry.id} className="space-y-2">
                      <EntrySummary entry={entry} />
                      <div className="max-h-44 overflow-auto rounded-md border border-border/50 p-2">
                        <div className="space-y-1">
                          {entry.items.map((item) => <BatchItemRow key={item.path} item={item} />)}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>

        <DialogFooter className="border-t border-border px-5 py-3">
          {isRunning ? (
            <Button variant="destructive" onClick={onStop} disabled={isStopping}>
              <Square className="mr-2 h-4 w-4" />
              {isStopping ? "Stopping..." : "Stop Batch"}
            </Button>
          ) : (
            <Button
              onClick={() => onStart({ files: selectedFiles, sourceMode, stopOnFirstError })}
              disabled={selectedFiles.length === 0}
            >
              <Clock className="mr-2 h-4 w-4" />
              Start Batch
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
