import React from "react"
import { WorkflowContainer } from "@/components/ImageViewer/Sidebar/Chat/WorkflowContainer"

const SidebarWorkflowOnly = () => {
  return (
    <div className="h-[calc(100vh-64px)] overflow-hidden">
      {/* Direct Workflow interface without tabs or headers */}
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-hidden">
          <WorkflowContainer />
        </div>
      </div>
    </div>
  )
}

export default SidebarWorkflowOnly