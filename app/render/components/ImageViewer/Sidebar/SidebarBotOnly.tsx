import React from "react"
import { Chatbox } from "@/components/ImageViewer/Sidebar/Chat/Chatbox"
import EventBus from "@/utils/EventBus"

const SidebarBotOnly = () => {
  const handleWorkflowClick = () => {
    // Open the Workflow-only sidebar from the Bot-only view
    EventBus.emit('open-sidebar', 'SidebarWorkflow')
  }

  return (
    <div className="h-[calc(100vh-64px)] overflow-hidden">
      {/* Direct Bot chat interface without tabs or headers */}
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-hidden">
          <Chatbox onWorkflowClick={handleWorkflowClick} />
        </div>
      </div>
    </div>
  )
}

export default SidebarBotOnly