"use client"

import React from "react"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { ContentRenderer } from "@/components/imageViewer/RightSidebar/Agent/Workflow/ContentRenderer"

export interface TissueSegEmbeddingFieldsProps {
  panel: WorkflowPanel
  onContentChange: (panelId: string, updated: WorkflowPanel) => void
}

/** Patch embedding (Tissue Segmentation / MuskEmbedding) params for Workflow Graph dock; mirrors SortablePanel field filtering. */
export function TissueSegEmbeddingFields(props: TissueSegEmbeddingFieldsProps) {
  const { panel, onContentChange } = props

  const fields = React.useMemo(
    () =>
      panel.content.filter(
        (item) => item.key !== "prompt" && item.key !== "organ" && item.key !== "path"
      ),
    [panel.content]
  )

  const handleChange = React.useCallback(
    (itemKey: string, value: string | any[]) => {
      onContentChange(panel.id, {
        ...panel,
        content: panel.content.map((contentItem) =>
          contentItem.key === itemKey ? { ...contentItem, value } : contentItem
        ),
      })
    },
    [onContentChange, panel]
  )

  if (fields.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        No embedding parameters on this panel.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="text-[11px] font-medium text-muted-foreground">Patch embedding parameters</div>
      <div className="flex flex-col gap-2">
        {fields.map((item) => (
          <ContentRenderer key={item.key} item={item} onChange={(value) => handleChange(item.key, value)} />
        ))}
      </div>
    </div>
  )
}
