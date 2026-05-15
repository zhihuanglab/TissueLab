"use client"
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config"
import { AppDispatch, RootState } from "@/store"
import { setIsGenerating as setIsChatGenerating } from "@/store/slices/chat/chatSlice"
import {
  resetWorkflowStatus,
  setIsRunning,
  setNodeProgress,
  setNodeStatus,
  setQueueStatus,
  setWorkflowStatus,
  WorkflowPanel,
} from "@/store/slices/chat/workflowSlice"
import EventBus from "@/utils/EventBus"
import { apiFetch } from "@/utils/common/apiFetch"
import { getErrorMessage } from "@/utils/common/apiResponse"
import { formatPath } from "@/utils/pathUtils"
import { getRestrictedDirectoryMessage, isPublicReadOnlyPath } from "@/utils/sampleDirectoryUtils"
import React, { useCallback, useEffect, useState } from "react"
import { useDispatch, useSelector } from "react-redux"
import { toast } from "sonner"
import { ContentRenderer } from "./ContentRenderer"
import { NucleiSegRegionAndMppPanel } from "./NucleiSegRegionAndMppPanel"

interface CellSegmentationPanelContentProps {
  panel: WorkflowPanel
  onContentChange: (id: string, updatedPanel: WorkflowPanel) => void
  /** When true (e.g. Workflow graph dock), hide Run/Cancel — the graph pipeline controls execution. */
  embedded?: boolean
}

const NODE_STATUS_COMPLETED = 2
const NODE_STATUS_FAILED = -1
const NODE_STATUS_CANCELLED = -2
const FINAL_STATUSES = [NODE_STATUS_COMPLETED, NODE_STATUS_FAILED, NODE_STATUS_CANCELLED]

const getDefaultOutputPath = (path: string): string => {
  return path ? `${path}.zarr` : ""
}

export const CellSegmentationPanelContent: React.FC<CellSegmentationPanelContentProps> = ({
  panel,
  onContentChange,
  embedded = false,
}) => {
  const dispatch = useDispatch<AppDispatch>()
  const otherContentItems = panel.content.filter(
    (item) =>
      item.key !== "prompt" && item.key !== "target_mpp" && item.key !== "organ" && item.key !== "path"
  )

  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath)
  const [formattedPath, setFormattedPath] = useState(formatPath(currentPath ?? ""))
  const isRunning = useSelector((state: RootState) => state.workflow.isRunning)
  const nodeStatus = useSelector((state: RootState) => state.workflow.nodeStatus)
  const [isCancelling, setIsCancelling] = useState(false)
  const shapeData = useSelector((state: RootState) => state.shape.shapeData)

  useEffect(() => {
    setFormattedPath(formatPath(currentPath ?? ""))
  }, [currentPath])

  const resetWorkflowState = useCallback(() => {
    dispatch(setIsRunning(false))
    dispatch(setWorkflowStatus("idle"))
    dispatch(setNodeStatus({}))
    dispatch(setNodeProgress({}))
    dispatch(setQueueStatus({ position: 0, total: 0 }))
    dispatch(setIsChatGenerating(false))
  }, [dispatch])

  const handleCancelClick = async () => {
    setIsCancelling(true)
    const outputPath = getDefaultOutputPath(formattedPath)

    try {
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/stop_workflow`, {
        method: "POST",
        body: JSON.stringify({ zarr_path: outputPath }),
        headers: {
          "Content-Type": "application/json",
        },
        returnAxiosFormat: true,
      })

      if (response.status === 200) {
        const waitForExecuteComplete = new Promise<void>((resolve) => {
          const maxWaitTime = 30000
          let timeoutId: NodeJS.Timeout | null = null
          let isResolved = false

          const resolveOnce = () => {
            if (!isResolved) {
              isResolved = true
              if (timeoutId) clearTimeout(timeoutId)
              EventBus.off("node-execute-completed", handleExecuteComplete)
              resolve()
            }
          }

          const handleExecuteComplete = (payload: { nodeType?: string; nodeStatus: Record<string, number> }) => {
            const currentNodeStatus = payload.nodeStatus?.[panel.type]
            const isOurNode = payload.nodeType === panel.type

            if (isOurNode || (currentNodeStatus !== undefined && FINAL_STATUSES.includes(currentNodeStatus))) {
              resolveOnce()
            }
          }

          EventBus.on("node-execute-completed", handleExecuteComplete)

          if (FINAL_STATUSES.includes(nodeStatus[panel.type])) {
            resolveOnce()
            return
          }

          timeoutId = setTimeout(() => {
            resolveOnce()
          }, maxWaitTime)
        })

        await waitForExecuteComplete
        resetWorkflowState()

        setTimeout(() => {
          EventBus.emit("close-sse-connection")
        }, 50)

        EventBus.emit("workflow-graph-run-aborted")

        toast.success("Node cancelled successfully", {
          duration: 3000,
          description: "The current node has been cancelled.",
        })
      } else {
        const errorMsg = response.data?.message || response.data?.error || "Unknown error"
        resetWorkflowState()
        toast.error(errorMsg, {
          duration: 5000,
        })
      }
    } catch (error) {
      console.error("[CellSegmentationPanel] Error cancelling workflow:", error)
      resetWorkflowState()
      toast.error(getErrorMessage(error, "Error cancelling workflow"))
    } finally {
      setIsCancelling(false)
    }
  }

  const handleRunClick = async () => {
    if (isPublicReadOnlyPath(currentPath ?? "")) {
      toast.error(getRestrictedDirectoryMessage("run segmentation"))
      return
    }

    dispatch(resetWorkflowStatus())
    dispatch(setIsChatGenerating(false))

    EventBus.emit("workflow-graph-run-start")

    const outputPath = getDefaultOutputPath(formattedPath)
    const targetMppValue = panel.content.find((item) => item.key === "target_mpp")?.value

    const rect = shapeData?.rectangleCoords
    let bbox: string | null = null
    if (rect) {
      const { x1, y1, x2, y2 } = rect
      const width = x2 - x1
      const height = y2 - y1
      if (width > 0 && height > 0) {
        bbox = `${x1},${y1},${width},${height}`
      }
    }

    const workflowPayload = {
      zarr_path: outputPath,
      step1: {
        nodeId: panel.type,
        input: {
          path: formattedPath,
          target_mpp: targetMppValue,
          ...(bbox && { bbox }),
          ...(shapeData?.polygonPoints && { polygon_points: shapeData.polygonPoints }),
        },
      },
    }

    try {
      EventBus.emit("workflow-started", { timestamp: Date.now() })
      dispatch(setIsChatGenerating(true))
      dispatch(setIsRunning(true))

      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/start_workflow`, {
        method: "POST",
        body: JSON.stringify(workflowPayload),
        returnAxiosFormat: true,
      })

      if (response.status === 200) {
        setTimeout(() => {
          EventBus.emit("switchTab", "workflow")
        }, 100)
      } else {
        EventBus.emit("workflow-graph-run-aborted")
        dispatch(setIsChatGenerating(false))
        dispatch(setIsRunning(false))
      }
    } catch (error) {
      EventBus.emit("workflow-graph-run-aborted")
      dispatch(setIsChatGenerating(false))
      dispatch(setIsRunning(false))
      console.error("Error starting Segmentation workflow:", error)
      toast.error(getErrorMessage(error, "Failed to start segmentation"), { duration: 5000 })
    }
  }

  const handleInputChange = (itemKey: string, value: string | unknown[]) => {
    onContentChange(panel.id, {
      ...panel,
      content: panel.content.map((contentItem) =>
        contentItem.key === itemKey ? { ...contentItem, value } : contentItem
      ),
    })
  }

  return (
    <div>
      <NucleiSegRegionAndMppPanel
        panel={panel}
        onContentChange={onContentChange}
        showRunControls={!embedded}
        isRunning={isRunning}
        isCancelling={isCancelling}
        onRun={handleRunClick}
        onCancel={handleCancelClick}
      />

      <div>
        {otherContentItems.map((item) => (
          <ContentRenderer key={item.key} item={item} onChange={(value) => handleInputChange(item.key, value)} />
        ))}
      </div>
    </div>
  )
}
