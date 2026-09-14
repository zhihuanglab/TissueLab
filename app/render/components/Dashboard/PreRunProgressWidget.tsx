"use client";

import { useEffect, useSyncExternalStore } from "react";
import { CheckCircle2, ChevronUp, Info, Loader2, X } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import {
  dismissPreRunBatch,
  getPreRunBatchRuntimeSnapshot,
  setPreRunMinimized,
  subscribePreRunBatchRuntime,
} from "@/services/preRunBatchRuntime.service";

/**
 * Global CellCast pre-run progress widget. Lives in `_app` so it survives
 * navigating away from the dashboard File Manager.
 */
export function PreRunProgressWidget() {
  const snap = useSyncExternalStore(
    subscribePreRunBatchRuntime,
    getPreRunBatchRuntimeSnapshot,
    getPreRunBatchRuntimeSnapshot,
  );

  const entries = Object.entries(snap.states).filter(([, s]) => s.status !== "idle");
  const active = entries.filter(([, s]) => s.status === "queued" || s.status === "running");
  const completed = entries.filter(([, s]) => s.status === "completed");
  const errored = entries.filter(([, s]) => s.status === "error");
  const allDone = entries.length > 0 && active.length === 0;
  const allOk = allDone && errored.length === 0 && completed.length > 0;
  const hasError = allDone && errored.length > 0;

  // Minimizing after completion should clear state so the next enqueue starts fresh.
  useEffect(() => {
    if (snap.minimized && allDone) dismissPreRunBatch();
  }, [snap.minimized, allDone]);

  const sum = entries.reduce((acc, [, s]) => {
    if (s.status === "completed" || s.status === "error") return acc + 100;
    return acc + Math.max(0, Math.min(100, s.progress));
  }, 0);
  const overall = entries.length ? Math.round(sum / entries.length) : 0;

  const current =
    entries.find(([, s]) => s.status === "running") ||
    entries.find(([, s]) => s.status === "queued");
  const doneCount = completed.length + errored.length;
  const currentIndex = current
    ? entries.findIndex(([p]) => p === current[0]) + 1
    : Math.min(doneCount + 1, entries.length);

  if (entries.length === 0) return null;

  if (snap.minimized) {
    return (
      <button
        type="button"
        onClick={() => setPreRunMinimized(false)}
        className="fixed top-4 right-4 z-[60] flex items-center gap-2 rounded-lg border border-border bg-card/95 px-3 py-2 text-xs shadow-xl backdrop-blur-sm transition-colors hover:bg-muted"
        title="Show processing progress"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        <span className="font-medium text-foreground">Processing {overall}%</span>
      </button>
    );
  }

  return (
    <div className="fixed top-4 right-4 z-[60] min-w-[320px] rounded-lg border border-border bg-card/95 p-4 shadow-xl backdrop-blur-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {allOk ? (
            <CheckCircle2 className="h-4 w-4 text-primary" />
          ) : hasError ? (
            <Info className="h-4 w-4 text-destructive" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          )}
          <h3 className="text-sm font-medium text-foreground">
            {allOk
              ? "Processing complete"
              : hasError
                ? "Processing finished with errors"
                : "Processing"}
          </h3>
        </div>
        {allDone ? (
          <button
            type="button"
            onClick={() => dismissPreRunBatch()}
            className="rounded p-1.5 transition-colors hover:bg-muted"
            title="Close"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setPreRunMinimized(true)}
            className="rounded p-1.5 transition-colors hover:bg-muted"
            title="Minimize progress"
          >
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
      </div>

      {allOk ? (
        <div className="flex items-center gap-2 rounded bg-muted p-2 text-foreground">
          <CheckCircle2 className="h-4 w-4" />
          <span className="text-xs font-medium">
            {entries.length === 1
              ? "Ready to open in viewer"
              : `${completed.length} slides ready`}
          </span>
        </div>
      ) : hasError ? (
        <div className="flex items-center gap-2 rounded bg-muted p-2 text-foreground">
          <Info className="h-4 w-4 text-destructive" />
          <span className="text-xs font-medium">
            {errored.length} failed
            {completed.length > 0 ? `, ${completed.length} done` : ""}
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          <Progress value={overall} className="h-2 w-full" />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {`${Math.max(1, currentIndex)}/${entries.length}`}
            </p>
            <p className="whitespace-nowrap text-xs font-medium text-foreground">{overall}%</p>
          </div>
        </div>
      )}
    </div>
  );
}
