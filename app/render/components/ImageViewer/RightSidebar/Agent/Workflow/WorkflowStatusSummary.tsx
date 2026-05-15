import React from "react";
import { Activity, Clock, Play, CheckCircle, X, Square, Users, Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { WorkflowStatusSummaryProps } from "./types";
import { PanelFeedbackSummary } from "./PanelFeedbackSummary";

export const WorkflowStatusSummary: React.FC<WorkflowStatusSummaryProps & { isCancelling?: boolean }> = ({
  panels,
  nodeStatus,
  nodeProgress,
  setNodeStatus,
  zarrPath,
  workflowStatus = 'idle',
  queuePosition = 0,
  queueTotal = 0,
  onCancel,
  isCancelling = false
}) => {
  // After page refresh we restore nodeStatus/nodeProgress but panels may be empty.
  // Derive display node names from nodeStatus so we still show "Running" and per-node progress.
  const INTERNAL_KEYS = ['_workflow_status', '_queue_position', '_queue_total', '_error'];
  const displayNodeNames: string[] =
    panels.length > 0
      ? panels.map((p) => p.type)
      : (workflowStatus === 'running' || workflowStatus === 'queued')
        ? Object.keys(nodeStatus).filter((k) => !INTERNAL_KEYS.includes(k))
        : [];

  // Count nodes by status (ignore stopped -2 in UI)
  const getStatusCounts = () => {
    const counts: { notStarted: number; running: number; completed: number; failed: number; total: number } = {
      notStarted: 0,
      running: 0,
      completed: 0,
      failed: 0,
      total: displayNodeNames.length,
    };

    displayNodeNames.forEach((nodeName) => {
      const status = nodeStatus[nodeName] ?? 0;
      if (status === 0) counts.notStarted++;
      else if (status === 1) counts.running++;
      else if (status === 2) counts.completed++;
      else if (status === -1) counts.failed++;
    });

    return counts;
  };

  const statusCounts = getStatusCounts();
  const progress = Math.round((statusCounts.completed / statusCounts.total) * 100) || 0;

  const runningFileName = zarrPath ? zarrPath.replace(/^.*[/\\]/, '') : '';

  // Only allow cancel when in queue (not when already running)
  const canCancel = !isCancelling && workflowStatus === 'queued';

  // Do not surface "stopped" in UI

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[15px] font-medium flex items-center mb-0">
          <Activity className="h-4 w-4 mr-1" />
          Workflow Status
        </h3>
        <div className="flex items-center gap-2">
          {canCancel && onCancel && (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={onCancel}
              disabled={isCancelling}
            >
              {isCancelling ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  Cancel
                </>
              ) : (
                'Cancel'
              )}
            </Button>
          )}
          {isCancelling && !canCancel && (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-3 text-xs opacity-60 cursor-not-allowed"
              disabled={true}
            >
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Cancel
            </Button>
          )}
          <button className="p-0" onClick={() => {
            setNodeStatus({});
          }}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Right after submit, no SSE yet: show Preparing (multi-user: SSE may take a moment) */}
      {workflowStatus === 'idle' && (
        <div className="mb-3 p-3 bg-primary/10 border border-primary/20 rounded-lg">
          <div className="flex items-center">
            <Loader2 className="h-4 w-4 mr-2 text-primary animate-spin" />
            <span className="text-sm font-medium text-primary">Preparing...</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">Connecting, status will update when server responds.</div>
          {runningFileName && <div className="text-xs text-muted-foreground mt-1 truncate" title={zarrPath}>{runningFileName}</div>}
        </div>
      )}

      {/* Queue Status Display (from SSE: _workflow_status === 'queued') */}
      {workflowStatus === 'queued' && (
        <div className="mb-3 p-3 bg-primary/10 border border-primary/20 rounded-lg">
          <div className="flex items-center mb-2">
            <Users className="h-4 w-4 mr-2 text-primary" />
            <span className="text-sm font-medium text-primary">In Queue</span>
          </div>
          {runningFileName && <div className="text-xs text-muted-foreground mb-1 truncate" title={zarrPath}>{runningFileName}</div>}
          <div className="text-xs text-primary/80">
            {queuePosition > 1 ? (
              <span><span className="font-semibold">{queuePosition - 1}</span> people ahead</span>
            ) : (
              <span>You&apos;re next in queue</span>
            )}
          </div>
          {queuePosition > 0 && queueTotal > 0 && (
            <div className="mt-1">
              <Progress
                value={Math.min(100, Math.max(0, ((queueTotal - queuePosition + 1) / queueTotal) * 100))}
                className="h-1 w-full"
              />
            </div>
          )}
        </div>
      )}

      {/* Running Status Display (from SSE: _workflow_status === 'running') */}
      {workflowStatus === 'running' && statusCounts.running === 0 && statusCounts.completed === 0 && statusCounts.failed === 0 && (
        <div className="mb-3 p-3 bg-primary/10 border border-primary/20 rounded-lg">
          <div className="flex items-center">
            <Loader2 className="h-4 w-4 mr-2 text-primary animate-spin" />
            <span className="text-sm font-medium text-primary">Preparing...</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">Creating run, nodes will start shortly.</div>
          {runningFileName && <div className="text-xs text-muted-foreground mt-1 truncate" title={zarrPath}>{runningFileName}</div>}
        </div>
      )}
      {workflowStatus === 'running' && (statusCounts.running > 0 || statusCounts.completed > 0 || statusCounts.failed > 0) && (
        <div className="mb-3 p-3 bg-success/10 border border-success/20 rounded-lg">
          <div className="flex items-center">
            <Play className="h-4 w-4 mr-2 text-success" />
            <span className="text-sm font-medium text-success">Workflow Running</span>
          </div>
          {runningFileName && <div className="text-xs text-muted-foreground mt-1 truncate" title={zarrPath}>{runningFileName}</div>}
        </div>
      )}
      
      <div className="mb-2">
        <Progress value={progress} className="h-2 w-full" />
        {statusCounts.failed > 0 && (
          <div className="text-xs text-muted-foreground mt-1">
            {statusCounts.failed > 0 && <span className="text-destructive ml-0">({statusCounts.failed} failed)</span>}
          </div>
        )}
      </div>
      
      {/* Individual node progress (from panels or, after refresh restore, from nodeStatus) */}
      {displayNodeNames.length > 0 && (
        <div className="mb-3 space-y-2">
          {displayNodeNames.map((nodeName) => {
            const panel = panels.find((p) => p.type === nodeName);
            const label = panel?.title ?? nodeName;
            const status = nodeStatus[nodeName] ?? 0;
            const progress = nodeProgress?.[nodeName] ?? 0;
            const isRunning = status === 1;
            const isCompleted = status === 2;
            const isFailed = status === -1;

            return (
              <div key={nodeName} className="flex items-center justify-between text-xs">
                <div className="flex items-center flex-1">
                  <div className="w-2 h-2 rounded-full mr-2 flex-shrink-0">
                    {isRunning && <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />}
                    {isCompleted && <div className="w-2 h-2 rounded-full bg-success" />}
                    {isFailed && <div className="w-2 h-2 rounded-full bg-destructive" />}
                    {status === 0 && <div className="w-2 h-2 rounded-full bg-muted" />}
                  </div>
                  <span className="text-foreground truncate">{label}</span>
                  {isRunning && progress > 0 && (
                    <span className="ml-2 text-muted-foreground">({progress}%)</span>
                  )}
                </div>
                {isCompleted && (
                  <div className="flex items-center ml-2">
                    <CheckCircle className="h-3 w-3 text-success" />
                  </div>
                )}
                {isFailed && (
                  <div className="flex items-center ml-2">
                    <X className="h-3 w-3 text-destructive" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      
      <div className="flex justify-center gap-2 text-xs">
        <div className="flex items-center rounded-full bg-muted/40 px-2 py-1 border border-border">
          <Clock className="h-3 w-3 mr-1 text-muted-foreground" />
          <span>Not Started: {statusCounts.notStarted}</span>
        </div>
        <div className="flex items-center rounded-full bg-muted/40 px-2 py-1 border border-border">
          <Play className="h-3 w-3 mr-1 text-primary" />
          <span>Running: {statusCounts.running}</span>
        </div>
        <div className="flex items-center rounded-full bg-muted/40 px-2 py-1 border border-border">
          <CheckCircle className="h-3 w-3 mr-1 text-success" />
          <span>Completed: {statusCounts.completed}</span>
        </div>
        {statusCounts.failed > 0 && (
          <div className="flex items-center rounded-full bg-muted/40 px-2 py-1 border border-border">
            <X className="h-3 w-3 mr-1 text-destructive" />
            <span>Failed: {statusCounts.failed}</span>
          </div>
        )}
        {/* stopped pill intentionally hidden */}
      </div>

      {/* Overall feedback when everything completed (only when we have panels / full config) */}
      {panels.length > 0 && statusCounts.total > 0 && statusCounts.completed === statusCounts.total && (
        <PanelFeedbackSummary
          nodes={panels.map(p => ({
            model: (p.title.includes('Tissue Segmentation') ? 'TissueSeg' : p.title.includes('Tissue Classification') ? 'TissueClassify' : p.title.includes('Cell Segmentation') ? 'NucleiSeg' : p.title.includes('Nuclei Classification') ? 'NucleiClassify' : p.type),
            impl: p.type
          }))}
          zarrPath={zarrPath}
        />
      )}
    </div>
  );
}; 