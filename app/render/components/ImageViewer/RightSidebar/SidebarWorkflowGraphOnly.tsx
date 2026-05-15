import React from "react"
import { WorkflowGraph } from "@/components/imageViewer/RightSidebar/Agent/WorkflowGraph"

const SidebarWorkflowGraphOnly = () => {
  return (
    <div className="h-full overflow-hidden">
      <WorkflowGraph />
    </div>
  )
}

export default SidebarWorkflowGraphOnly
