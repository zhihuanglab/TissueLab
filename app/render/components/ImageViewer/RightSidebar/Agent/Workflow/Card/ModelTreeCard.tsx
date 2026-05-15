import { Button } from "@/components/ui/button"
import { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { ChevronDown, ChevronRight, Plus } from "lucide-react"
import React, { useState } from "react"

export interface ModelTreeNode {
  id: string
  panel: WorkflowPanel
  children: ModelTreeNode[]
  canAddChild?: { buttonLabel: string; onAdd: () => void }
}

export interface ModelTreeCardProps {
  node: ModelTreeNode
  renderPanel: (panel: WorkflowPanel, collapsed: boolean) => React.ReactNode
}

export const ModelTreeCard = ({ node, renderPanel }: ModelTreeCardProps) => {
  const [collapsedChildren, setCollapsedChildren] = useState<Record<string, boolean>>({})
  const [stubCollapsed, setStubCollapsed] = useState(false)

  const renderSubtree = (treeNode: ModelTreeNode, isRoot: boolean) => {
    return (
      <React.Fragment key={treeNode.id}>
        {isRoot && renderPanel(treeNode.panel, false)}

        {/* Render children */}
        {treeNode.children.map((child) => {
          const isCollapsed = !!collapsedChildren[child.id]
          return (
            <React.Fragment key={child.id}>
              <div className="flex items-start">
                {/* Left connector: vertical line + chevron toggle — flush against parent */}
                <div className="ml-1 flex flex-col items-center w-5 flex-shrink-0">
                  <div className="w-[1px] h-5 bg-foreground/40 rounded-full" />
                  <button
                    className="flex items-center justify-center h-5 w-5 rounded-[6px] bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
                    onClick={() => setCollapsedChildren(prev => ({
                      ...prev,
                      [child.id]: !prev[child.id]
                    }))}
                  >
                    {isCollapsed
                      ? <ChevronRight className="h-3 w-3 stroke-[2.5]" />
                      : <ChevronDown className="h-3 w-3 stroke-[2.5]" />
                    }
                  </button>
                </div>
                {/* Child card — own top margin */}
                <div className="flex-1 min-w-0 ml-1 mt-1.5">
                  {renderPanel(child.panel, isCollapsed)}
                </div>
              </div>
              {!isCollapsed && (child.children.length > 0 || !!child.canAddChild) && (
                <div className="ml-5">
                  {renderSubtree(child, false)}
                </div>
              )}
            </React.Fragment>
          )
        })}

        {/* Stub connector: chevron + import button when no child exists yet */}
        {treeNode.canAddChild && treeNode.children.length === 0 && (
          <div className="flex items-start">
            <div className="ml-1 flex flex-col items-center w-5 flex-shrink-0">
              <div className="w-[1px] h-5 bg-foreground/50 rounded-full" />
              <button
                className="flex items-center justify-center h-5 w-5 rounded-[6px] bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
                onClick={() => setStubCollapsed(prev => !prev)}
              >
                {stubCollapsed
                  ? <ChevronRight className="h-3 w-3 stroke-[2.5]" />
                  : <ChevronDown className="h-3 w-3 stroke-[2.5]" />
                }
              </button>
            </div>
            {!stubCollapsed && (
              <div className="ml-1.5 mt-2.5 flex w-full">
                <Button
                  variant="secondary"
                  className="w-full rounded-md px-5 gap-1.5 text-sm"
                  onClick={treeNode.canAddChild.onAdd}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {treeNode.canAddChild.buttonLabel}
                </Button>
              </div>
            )}
          </div>
        )}
      </React.Fragment>
    )
  }

  return <>{renderSubtree(node, true)}</>
}
