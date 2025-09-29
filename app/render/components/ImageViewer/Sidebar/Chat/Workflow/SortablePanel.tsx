import React from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/utils/twMerge"
import { Progress } from "@/components/ui/progress"
import { PanelActionButtons } from "./PanelActionButtons"
import { CustomPromptField } from "./CustomPromptField"
import { ScriptPromptField } from "./ScriptPromptField"
import { ClassificationPanelContent } from "./ClassificationPanelContent"
import { PatchClassificationPanel } from "./PatchClassificationPanel"
import { CellSegmentationPanelContent } from "./CellSegmentationPanelContent"
import { ContentRenderer } from "./ContentRenderer"
import { SortablePanelProps } from "./types"
import { panelMap } from "./constants"
import { useNodeProgress } from "@/hooks/useNodeProgress"
import { CodePanelContent } from "./CodePanelContent"
import { PanelFeedback } from "./PanelFeedback"

export const SortablePanel = ({
  panel,
  onContentChange,
  onDelete,
  nodeStatus,
  nodePortsInfo,
  className,
  h5Path,
  logMetadata,
  onShowLogs
}: SortablePanelProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: panel.id })
  const [showOptional, setShowOptional] = React.useState(false)
  const prevFilterKeysRef = React.useRef<string[]>([])

  React.useEffect(() => {
    const optionalKeys = panel.content
      .filter(item => item.key !== "prompt" && item.key !== "organ" && item.key !== "path")
      .map(item => item.key)
      .sort()
    const prevKeys = prevFilterKeysRef.current
    const hasContentChanged = optionalKeys.length !== prevKeys.length || optionalKeys.some((key, idx) => key !== prevKeys[idx])

    if (hasContentChanged) {
      setShowOptional(optionalKeys.length > 0)
      prevFilterKeysRef.current = optionalKeys
    }
  }, [panel.content])
  
  // Get detailed progress (0-100%) using our custom hook
  const { progress, isComplete } = useNodeProgress(
    panel.type, 
    nodeStatus?.[panel.type] ?? 0, 
    nodePortsInfo
  );

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  // Map node status to progress value and status text
  const getNodeStatusInfo = () => {
    // Get the node's status from the overall workflow status
    const status = nodeStatus?.[panel.type] ?? 0;
    
    // Map status code to progress percentage and text
    let progressValue = 0;
    let statusText = "";
    let isError = false;
    let isInProgress = false;
    let isStarting = false; // New flag to track tasks that just started
    
    switch(status) {
      case 0:
        progressValue = 0;
        statusText = "Not Started";
        break;
      case 1:
        // When status is 'running', use the detailed progress if available
        if (panel.type !== "Scripts") {
          if (progress > 0) {
            // Use the progress from our hook which already ensures non-decreasing values
            progressValue = progress;
          } else {
            progressValue = 0; // Show 0% instead of 50% when first starting
            isStarting = true; // Mark as just starting
          }
        } else {
          progressValue = 50; // Keep fixed 50% for Scripts type
        }
        statusText = "Running";
        isInProgress = true;
        break;
      case 2:
        progressValue = 100;
        statusText = "Completed";
        break;
      case -1:
        progressValue = 100;
        statusText = "Failed";
        isError = true;
        break;
      default:
        progressValue = 0;
        statusText = "Not Started";
    }
    
    return { progressValue, statusText, isError, isInProgress, isStarting };
  };

  const { progressValue, statusText, isError, isInProgress, isStarting } = getNodeStatusInfo();
  const hasGeneratedCode = React.useMemo(() => {
    return panel.content.some((item) => item.key === "generated_script" && typeof (item as any).value === "string" && (item as any).value.trim().length > 0)
  }, [panel.content])

  return (
      <div 
        ref={setNodeRef} 
        style={style} 
        className={cn(
          "bg-white rounded-lg border transition-shadow",
          "hover:shadow-lg",
          isError && "border-red-300",
          // isDragging && "shadow-md ring-2 ring-primary ring-offset-2",
          "mb-3 last:mb-0",
          className
        )}
      >
        <div className={cn(
          "flex items-center justify-between py-2 px-2 border-b",
          isError && "bg-red-50"
        )}>
          <div className="flex items-center">
            <button
                {...attributes}
                {...listeners}
                className="cursor-grab active:cursor-grabbing p-1 hover:bg-slate-100 rounded mr-2"
            >
              <GripVertical className="h-4 w-4 text-slate-500" />
              <span className="sr-only">Drag to reorder</span>
            </button>
            <div className="flex flex-col">
                <h3 className="text-sm font-medium mb-0">{panel.title}</h3>
                {panel.title !== panelMap.NucleiSeg.title && (
                  <p className="text-xs text-muted-foreground mb-0 font-light">{panel.type}</p>
                )}
            </div>
          </div>
          <PanelActionButtons
            panel={panel}
            onContentChange={onContentChange}
            onDelete={onDelete}
            onShowLogs={onShowLogs ? () => onShowLogs(panel.id) : undefined}
            logMetadata={logMetadata}
          />
        </div>
        <div className="px-[10px] py-[10px]">
          <div className="flex flex-col gap-[10px]">
            {panel.title === panelMap.Scripts.title && (
              <ScriptPromptField
                value={panel.content.find(item => item.key === "prompt")?.value ?? ""}
                onChange={(value) =>
                  onContentChange(panel.id, {
                    ...panel,
                    content: panel.content.map((item) =>
                      item.key === "prompt" ? { ...item, value } : item
                    ),
                  })
                }
              />
            )}

            {panel.title === panelMap.NucleiClassify.title && (
              <ClassificationPanelContent panel={panel} onContentChange={onContentChange} />
            )}

            {(panel.type === 'MuskClassification') && (
              <PatchClassificationPanel panel={panel} onContentChange={onContentChange} />
            )}

            {panel.title === panelMap.NucleiSeg.title && (
              <CellSegmentationPanelContent panel={panel} onContentChange={onContentChange} />
            )}

            {panel.title !== panelMap.NucleiClassify.title && 
             panel.type !== 'MuskClassification' &&
             panel.title !== panelMap.NucleiSeg.title && 
             panel.title !== panelMap.Scripts.title &&
             panel.content.some(item => item.key !== "prompt" && item.key !== "organ" && item.key !== "path") && (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setShowOptional((prev) => !prev)}
                  className="flex items-center justify-between text-sm text-muted-foreground hover:text-slate-600 transition-colors"
                >
                  <span className="text-muted-foreground font-normal">Optional Parameters</span>
                  {showOptional ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>

                {showOptional && (
                  <div className="flex flex-col gap-2">
                    {panel.content
                      .filter(item => item.key !== "prompt" && item.key !== "organ" && item.key !== "path")
                      .map((item) => (
                        <ContentRenderer
                          key={item.key}
                          item={item}
                          onChange={(value) =>
                            onContentChange(panel.id, {
                              ...panel,
                              content: panel.content.map((contentItem) =>
                                contentItem.key === item.key
                                  ? { ...contentItem, value }
                                  : contentItem
                              ),
                            })
                          }
                        />
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {nodeStatus && Object.keys(nodeStatus).length > 0 && (
            <div className="flex flex-col gap-2 mt-3">
              {/* Single Unified Progress Bar */}
              <div className="flex flex-col gap-1">
                <Progress 
                  value={progressValue} 
                  className={cn(
                    "w-full bg-blue-50",
                    isError && "bg-red-100 [&>div]:bg-red-500",
                    isInProgress && isStarting && "[&>div]:bg-blue-300", // Starting state (0%)
                    isInProgress && !isStarting && progressValue < 100 && "bg-blue-100 [&>div]:bg-blue-500", // In progress
                    isInProgress && progressValue === 100 && !isComplete && "bg-yellow-100 [&>div]:bg-yellow-500 [&>div]:animate-pulse", // Processing phase
                    statusText === "Completed" && "bg-green-100 [&>div]:bg-green-500" // Completed state
                  )} 
                />
                
                {statusText && (
                  <div className="flex items-center justify-between text-xs">
                    <span className={cn(
                      "font-medium", 
                      isInProgress && "text-blue-600",
                      statusText === "Completed" && "text-green-600",
                      statusText === "Failed" && "text-red-600"
                    )}>
                      {statusText}
                      {isInProgress && isStarting && " (Starting...)"}
                      {isInProgress && progressValue === 100 && !isComplete && " (Processing...)"}
                    </span>
                    
                    {isInProgress && progressValue > 0 && (
                      <span className="text-slate-600">{progress}%</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          {(panel.title === panelMap.Scripts.title) && hasGeneratedCode && (
            <div className="mt-3">
              <CodePanelContent panel={panel} onContentChange={onContentChange} />
            </div>
          )}
        </div>
        {/* Per-panel feedback (visible when this panel completed) */}
        {nodeStatus && nodeStatus[panel.type] === 2 && (
          <div className="border-t px-2 py-2">
            <PanelFeedback
              model={panel.title.includes('Tissue Segmentation') ? 'TissueSeg' : panel.title.includes('Tissue Classification') ? 'TissueClassify' : panel.title.includes('Cell Segmentation') ? 'NucleiSeg' : panel.title.includes('Nuclei Classification') ? 'NucleiClassify' : panel.type}
              impl={panel.type}
              h5Path={h5Path}
            />
          </div>
        )}
      </div>
  )
} 