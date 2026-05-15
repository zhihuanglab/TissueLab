import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ContentItem } from "@/store/slices/chat/workflowSlice"
import { cn } from "@/utils/twMerge"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react"
import React from "react"
import { CellSegmentationPanelContent } from "../CellSegmentationPanelContent"
import { ClassificationPanelContent } from "../ClassificationPanelContent"
import { panelMap } from "../constants"
import { ContentRenderer } from "../ContentRenderer"
import { CustomPromptField } from "../CustomPromptField"
import { PatchClassificationPanel } from "../PatchClassificationPanel"
import { ScriptPromptField } from "../ScriptPromptField"
import { SortablePanelProps } from "../types"
import { PanelActionButtons } from "./Panel-ActionButtons"
// import { useNodeProgress } from "@/hooks/useNodeProgress"
import { CodePanelContent } from "../CodePanelContent"
import { PanelFeedback } from "../PanelFeedback"
import { VisualSchemaEditorDialog } from "../VisualSchemaEditorDialog"

export const SortablePanel = ({
  panel,
  onContentChange,
  onDelete,
  nodeStatus,
  nodeProgress,
  nodePortsInfo,
  className,
  zarrPath,
  logMetadata,
  onShowLogs,
  collapsed
}: SortablePanelProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: panel.id })
  const [showOptional, setShowOptional] = React.useState(false)
  const [editDialogOpen, setEditDialogOpen] = React.useState(false)
  const prevFilterKeysRef = React.useRef<string[]>([])

  const promptItem = React.useMemo(() => panel.content.find(item => item.key === "prompt"), [panel.content])
  const optionalItems = React.useMemo(
    () => panel.content.filter(item => item.key !== "prompt" && item.key !== "organ" && item.key !== "path"),
    [panel.content]
  )

  React.useEffect(() => {
    const optionalKeys = [...optionalItems.map(item => item.key)].sort()
    const prevKeys = prevFilterKeysRef.current
    const hasContentChanged = optionalKeys.length !== prevKeys.length || optionalKeys.some((key, idx) => key !== prevKeys[idx])

    if (hasContentChanged) {
      // Expand by default if 2 or fewer optional parameters, collapse if more than 2
      setShowOptional(optionalKeys.length > 0 && optionalKeys.length <= 2)
      prevFilterKeysRef.current = optionalKeys
    }
  }, [optionalItems])
  
  // Get detailed progress (0-100%) directly from AI service SSE
  const realProgress = (typeof nodeProgress?.[panel.type] === 'number' && nodeProgress?.[panel.type] >= 0)
    ? nodeProgress?.[panel.type]
    : 0;
  const isComplete = (nodeStatus?.[panel.type] ?? 0) === 2 || (nodeStatus?.[panel.type] ?? 0) === -1;

  // CodingAgent (GPT-4o Agent) calls OpenAI for ~10-30s. The backend emits a
  // slow animator but the SSE stream throttles to ~1-2s ticks, so users see
  // stalls + jumps. Fake a faster client-side ramp (90% in ~6s) so movement
  // is visible immediately after status === 1.
  const isCodingAgentType = panel.type === panelMap.CodingAgent.defaultType
  const nodeStatusVal = nodeStatus?.[panel.type] ?? 0
  const [fakeCodingProgress, setFakeCodingProgress] = React.useState(0)
  React.useEffect(() => {
    if (!isCodingAgentType) return
    if (nodeStatusVal !== 1) {
      // Reset whenever the node leaves the running state so a re-run starts at 0.
      setFakeCodingProgress(0)
      return
    }
    const interval = window.setInterval(() => {
      setFakeCodingProgress((p) => (p >= 90 ? 90 : p + 3))
    }, 200)
    return () => window.clearInterval(interval)
  }, [isCodingAgentType, nodeStatusVal])

  // Effective progress: real SSE value when present, else fake ramp for CodingAgent.
  const progress = isCodingAgentType && realProgress === 0 ? fakeCodingProgress : realProgress

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  // Map node status to progress value and status text (only when backend has sent status for this node)
  const getNodeStatusInfo = () => {
    const status = nodeStatus?.[panel.type] ?? 0;
    let progressValue = 0;
    let statusText = "";
    let isError = false;
    let isInProgress = false;
    let isStarting = false;
    
    switch(status) {
      case 0:
        progressValue = 0;
        statusText = "Not Started";
        break;
      case 1:
        if (progress > 0) {
          progressValue = progress;
        } else {
          progressValue = 0;
          isStarting = true;
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

  const showProgressBlock = Boolean(nodeStatus && nodeStatus[panel.type] !== undefined);

  const { progressValue, statusText, isError, isInProgress, isStarting } = getNodeStatusInfo();
  const hasGeneratedCode = React.useMemo(() => {
    return panel.content.some((item) => item.key === "generated_script" && typeof (item as any).value === "string" && (item as any).value.trim().length > 0)
  }, [panel.content])

  const handleContentItemChange = React.useCallback(
    (itemKey: string, value: string | any[]) => {
      onContentChange(panel.id, {
        ...panel,
        content: panel.content.map((contentItem) =>
          contentItem.key === itemKey
            ? { ...contentItem, value } as ContentItem
            : contentItem
        ),
      })
    },
    [panel, onContentChange]
  )

  const isChildCard = collapsed !== undefined
  const isCodingAgentPanel = panel.type === panelMap.CodingAgent.defaultType
  const isNucleiClassifyPanel = panel.type === panelMap.NucleiClassify.defaultType
  const isTissueClassifyPanel = panel.type === panelMap.TissueClassify.defaultType
  const isNucleiSegPanel = panel.type === panelMap.NucleiSeg.defaultType
  const baseCustomPanel = !isCodingAgentPanel && !isNucleiClassifyPanel && !isTissueClassifyPanel && !isNucleiSegPanel
  const uiVariant = typeof panel.ui === "object" && panel.ui ? (panel.ui as any).variant : undefined
  const isPromptOnlyVariant = uiVariant === "prompt-only"
  const treatsAsCustomPanel = baseCustomPanel || isPromptOnlyVariant
  const hasOptionalItems = optionalItems.length > 0

  const showPatchClassificationPanel = isTissueClassifyPanel && !isPromptOnlyVariant
  const showCustomPromptField = treatsAsCustomPanel && !!promptItem

  return (
      <div 
        ref={setNodeRef} 
        style={style} 
        className={cn(
          "border border-border/50 bg-card text-card-foreground shadow-sm flex flex-col transition-shadow",
          "hover:shadow-lg",
          isChildCard && collapsed ? "rounded-xl pb-0" : "rounded-xl",
          isError && "border-destructive",
          "last:mb-0",
          className
        )}
      >
        {/* Panel header: grey background, title, and header actions */}
        <div
          className={cn(
            "flex items-center justify-between px-4 pl-2 pt-3 bg-muted/80",
            isChildCard && collapsed ? "rounded-xl pb-2 mb-0" : "rounded-t-xl pb-3 mb-2",
            isError && "bg-destructive/10"
          )}
        >
          <div className="flex items-center min-w-0 flex-1">
            <Button
                variant="ghost"
                size="icon"
                {...attributes}
                {...listeners}
                className={cn(
                  "cursor-grab active:cursor-grabbing mr-1 flex-shrink-0 rounded-[4px] hover:bg-card",
                  isChildCard ? "h-6 w-6" : "h-7 w-7"
                )}
            >
              <GripVertical className={cn("text-foreground", isChildCard ? "h-3 w-3" : "h-3 w-3 sm:h-4 sm:w-4")} />
              <span className="sr-only">Drag to reorder</span>
            </Button>
            <div className="flex flex-col min-w-0 flex-1">
              <h3 className="text-sm sm:text-base font-semibold tracking-tight break-words">
                {panel.title}
              </h3>
              {panel.type !== panelMap.NucleiSeg.defaultType && (
                <p className="text-xs text-muted-foreground mt-0.5 break-words">
                  {panel.type}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {treatsAsCustomPanel && (
              <VisualSchemaEditorDialog
                panel={panel}
                onSave={(updated) => onContentChange(panel.id, updated)}
                open={editDialogOpen}
                onOpenChange={setEditDialogOpen}
              />
            )}
            <PanelActionButtons
              panel={panel}
              onContentChange={onContentChange}
              onDelete={onDelete}
              onShowLogs={onShowLogs ? () => onShowLogs(panel.id) : undefined}
              logMetadata={logMetadata}
              compact={isChildCard}
              showEditButton={treatsAsCustomPanel}
              onEditClick={treatsAsCustomPanel ? () => setEditDialogOpen(true) : undefined}
            />
          </div>
        </div>
        {!collapsed && (
          <div className="flex flex-col gap-2 px-4 pb-4">
            {isCodingAgentPanel && (
              <ScriptPromptField
                value={typeof promptItem?.value === 'string' ? promptItem.value : ""}
                onChange={(value) => handleContentItemChange("prompt", value)}
              />
            )}

            {isNucleiClassifyPanel && (
              <ClassificationPanelContent panel={panel} onContentChange={onContentChange} />
            )}

            {showPatchClassificationPanel && (
              <PatchClassificationPanel panel={panel} onContentChange={onContentChange} />
            )}

            {isNucleiSegPanel && (
              <CellSegmentationPanelContent panel={panel} onContentChange={onContentChange} />
            )}

            {showCustomPromptField && (
              <CustomPromptField
                value={typeof promptItem?.value === 'string' ? promptItem.value : ""}
                onChange={(value) => handleContentItemChange("prompt", value)}
              />
            )}

            {treatsAsCustomPanel && hasOptionalItems && (
              <div className="flex flex-col gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowOptional((prev) => !prev)}
                  className="flex items-center justify-between text-xs text-muted-foreground hover:text-foreground h-auto px-0 py-1 font-normal"
                >
                  <span className="text-muted-foreground font-normal">Optional Parameters</span>
                  {showOptional ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </Button>

                {showOptional && (
                  <div className="flex flex-col gap-1.5">
                    {optionalItems.map((item, idx) => (
                      <ContentRenderer
                        key={`${item.key || 'field'}-${panel.id}-${idx}`}
                        item={item}
                        onChange={(value) => handleContentItemChange(item.key, value)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {!collapsed && showProgressBlock && (
          <div className="flex flex-col gap-1.5 px-3 mb-3">
              {/* Single Unified Progress Bar */}
              <div className="flex flex-col gap-1">
                <Progress
                  value={progressValue}
                  className={cn(
                    "w-full bg-primary/10",
                    isError && "bg-destructive/20 [&>div]:bg-destructive",
                    isInProgress && isStarting && "[&>div]:bg-primary/60", // Starting state (0%)
                    isInProgress && !isStarting && progressValue < 100 && "bg-primary/20 [&>div]:bg-primary", // In progress
                    isInProgress && progressValue === 100 && !isComplete && "bg-warning/20 [&>div]:bg-warning [&>div]:animate-pulse", // Processing phase
                    statusText === "Completed" && "bg-success/20 [&>div]:bg-success" // Completed state
                  )}
                />

                {statusText && (
                  <div className="flex items-center justify-between text-xs">
                    <span className={cn(
                      "font-medium",
                      isInProgress && "text-primary",
                      statusText === "Completed" && "text-success",
                      statusText === "Failed" && "text-destructive"
                    )}>
                      {statusText}
                      {isInProgress && isStarting && " (Starting...)"}
                      {isInProgress && progressValue === 100 && !isComplete && " (Processing...)"}
                    </span>

                    {isInProgress && progressValue > 0 && (
                      <span className="text-muted-foreground">{progress}%</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        {!collapsed && panel.type === panelMap.CodingAgent.defaultType && hasGeneratedCode && (
          <div>
            <CodePanelContent panel={panel} onContentChange={onContentChange} />
          </div>
        )}
        {!collapsed && nodeStatus && nodeStatus[panel.type] === 2 && (
          <div className="border-t border-border pt-3">
            <PanelFeedback
              model={panel.type === panelMap.TissueSeg.defaultType ? 'TissueSeg' : panel.type === panelMap.TissueClassify.defaultType ? 'TissueClassify' : panel.type === panelMap.NucleiSeg.defaultType ? 'NucleiSeg' : panel.type === panelMap.NucleiClassify.defaultType ? 'NucleiClassify' : panel.type}
              impl={panel.type}
              zarrPath={zarrPath}
            />
          </div>
        )}
      </div>
  )
} 
