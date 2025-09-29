import React from "react";
import { Activity, Clock, Play, CheckCircle, X, Square } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { WorkflowStatusSummaryProps } from "./types";
import { PanelFeedbackSummary } from "./PanelFeedbackSummary";

export const WorkflowStatusSummary: React.FC<WorkflowStatusSummaryProps> = ({ 
  panels, 
  nodeStatus, 
  nodeProgress,
  setNodeStatus,
  onStopWorkflow,
  h5Path
}) => {
  
    
  // Count nodes by status (ignore stopped -2 in UI)
  const getStatusCounts = () => {
    const counts: { notStarted: number; running: number; completed: number; failed: number; total: number } = {
      notStarted: 0,
      running: 0,
      completed: 0,
      failed: 0,
      total: panels.length,
    };
    
    panels.forEach((panel) => {
      const status = nodeStatus[panel.type] || 0;
      
      if (status === 0) counts.notStarted++;
      else if (status === 1) counts.running++;
      else if (status === 2) counts.completed++;
      else if (status === -1) counts.failed++;
      // status === -2 (stopped) is intentionally ignored
    });
    
    return counts;
  };
  
  const statusCounts = getStatusCounts();
  const progress = Math.round((statusCounts.completed / statusCounts.total) * 100) || 0;
  
  // Check if any nodes are running
  const hasRunningNodes = statusCounts.running > 0;
  
  // Do not surface "stopped" in UI
  
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[15px] font-medium flex items-center mb-0">
          <Activity className="h-4 w-4 mr-1" />
          Workflow Status
        </h3>
        <div className="flex items-center gap-2">
          {hasRunningNodes && onStopWorkflow && (
            <Button
              size="sm"
              variant="destructive"
              onClick={onStopWorkflow}
              className="h-7 px-3 text-xs font-medium"
            >
              <Square className="h-3 w-3 mr-1" />
              Stop Process
            </Button>
          )}
          <button className="p-0" onClick={() => {
            setNodeStatus({});
          }}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      
      <div className="mb-2">
        <Progress value={progress} className="h-2 w-full" />
        {statusCounts.failed > 0 && (
          <div className="text-xs text-muted-foreground mt-1">
            {statusCounts.failed > 0 && <span className="text-red-500 ml-0">({statusCounts.failed} failed)</span>}
          </div>
        )}
      </div>
      
      {/* Individual node progress */}
      {panels.length > 0 && (
        <div className="mb-3 space-y-2">
          {panels.map((panel) => {
            const status = nodeStatus[panel.type] || 0;
            const progress = nodeProgress?.[panel.type] || 0;
            const isRunning = status === 1;
            const isCompleted = status === 2;
            const isFailed = status === -1;
            const isStopped = false; // hidden in UI
            
            return (
              <div key={panel.id} className="flex items-center justify-between text-xs">
                <div className="flex items-center flex-1">
                  <div className="w-2 h-2 rounded-full mr-2 flex-shrink-0">
                    {isRunning && <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />}
                    {isCompleted && <div className="w-2 h-2 rounded-full bg-green-500" />}
                    {isFailed && <div className="w-2 h-2 rounded-full bg-red-500" />}
                    {/* stopped state intentionally hidden */}
                    {status === 0 && <div className="w-2 h-2 rounded-full bg-gray-300" />}
                  </div>
                  <span className="text-gray-700 truncate">{panel.title}</span>
                </div>
                {isRunning && progress > 0 && (
                  <></>
                )}
                {isCompleted && (
                  <div className="flex items-center ml-2">
                    <CheckCircle className="h-3 w-3 text-green-500" />
                  </div>
                )}
                {isFailed && (
                  <div className="flex items-center ml-2">
                    <X className="h-3 w-3 text-red-500" />
                  </div>
                )}
                {/* stopped state intentionally hidden */}
              </div>
            );
          })}
        </div>
      )}
      
      <div className="flex justify-center gap-2 text-xs">
        <div className="flex items-center rounded-full bg-gray-50 px-2 py-1 border border-gray-200">
          <Clock className="h-3 w-3 mr-1 text-gray-500" />
          <span>Not Started: {statusCounts.notStarted}</span>
        </div>
        <div className="flex items-center rounded-full bg-gray-50 px-2 py-1 border border-gray-200">
          <Play className="h-3 w-3 mr-1 text-blue-500" />
          <span>Running: {statusCounts.running}</span>
        </div>
        <div className="flex items-center rounded-full bg-gray-50 px-2 py-1 border border-gray-200">
          <CheckCircle className="h-3 w-3 mr-1 text-green-500" />
          <span>Completed: {statusCounts.completed}</span>
        </div>
        {statusCounts.failed > 0 && (
          <div className="flex items-center rounded-full bg-gray-50 px-2 py-1 border border-gray-200">
            <X className="h-3 w-3 mr-1 text-red-500" />
            <span>Failed: {statusCounts.failed}</span>
          </div>
        )}
        {/* stopped pill intentionally hidden */}
      </div>

      {/* Overall feedback when everything completed */}
      {statusCounts.total > 0 && statusCounts.completed === statusCounts.total && (
        <PanelFeedbackSummary
          nodes={panels.map(p => ({
            model: (p.title.includes('Tissue Segmentation') ? 'TissueSeg' : p.title.includes('Tissue Classification') ? 'TissueClassify' : p.title.includes('Cell Segmentation') ? 'NucleiSeg' : p.title.includes('Nuclei Classification') ? 'NucleiClassify' : p.type),
            impl: p.type
          }))}
          h5Path={h5Path}
        />
      )}
    </div>
  );
}; 