"use client"

import { ContentRenderer } from "@/components/imageViewer/RightSidebar/Agent/Workflow/ContentRenderer"
import { CustomPromptField } from "@/components/imageViewer/RightSidebar/Agent/Workflow/CustomPromptField"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import type { ContentItem } from "@/store/slices/chat/workflowSlice"
import React from "react"

export interface WorkflowGraphCustomPanelFieldsProps {
  panel: WorkflowPanel
  onContentChange: (panelId: string, updated: WorkflowPanel) => void
  optionalTitle?: string
  emptyMessage?: string
}

/** Mirrors legacy SortablePanel custom-field rendering for graph dock nodes such as VISTA. */
export function WorkflowGraphCustomPanelFields(props: WorkflowGraphCustomPanelFieldsProps) {
  const {
    panel,
    onContentChange,
    optionalTitle = "Optional Parameters",
    emptyMessage = "No parameters on this panel.",
  } = props

  const promptItem = React.useMemo(
    () => panel.content.find((item) => item.key === "prompt"),
    [panel.content],
  )

  const optionalItems = React.useMemo(
    () => panel.content.filter((item) => item.key !== "prompt" && item.key !== "organ" && item.key !== "path"),
    [panel.content],
  )

  const handleContentItemChange = React.useCallback(
    (itemKey: string, value: string | any[]) => {
      onContentChange(panel.id, {
        ...panel,
        content: panel.content.map((contentItem) =>
          contentItem.key === itemKey
            ? ({ ...contentItem, value } as ContentItem)
            : contentItem,
        ),
      })
    },
    [onContentChange, panel],
  )

  if (!promptItem && optionalItems.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {promptItem && (
        <CustomPromptField
          value={typeof promptItem.value === "string" ? promptItem.value : ""}
          onChange={(value) => handleContentItemChange("prompt", value)}
        />
      )}

      {optionalItems.length > 0 && (
        <div className="space-y-3">
          <div className="text-[11px] font-medium text-muted-foreground">{optionalTitle}</div>
          <div className="flex flex-col gap-2">
            {optionalItems.map((item, index) => (
              <ContentRenderer
                key={`${item.key || "field"}-${panel.id}-${index}`}
                item={item}
                onChange={(value) => handleContentItemChange(item.key, value)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
