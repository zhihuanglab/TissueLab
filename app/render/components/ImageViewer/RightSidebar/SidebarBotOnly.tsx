import React from "react"
import { useSelector } from "react-redux"
import { RootState } from "@/store"
import { Chatbox } from "@/components/imageViewer/RightSidebar/Agent/Chatbox"
import { DiscoveryPanel } from "@/components/imageViewer/RightSidebar/Agent/DiscoveryPanel"
import EventBus from "@/utils/EventBus"

const SidebarBotOnly = () => {
  const selectedAgent = useSelector((state: RootState) => state.agent.selectedAgent)

  if (selectedAgent === "TL Discovery") {
    return (
      <div className="h-[calc(100vh-64px)] overflow-hidden">
        <DiscoveryPanel />
      </div>
    )
  }

  const handleWorkflowClick = () => {
    EventBus.emit('open-sidebar', 'SidebarWorkflow')
  }

  return (
    <div className="h-[calc(100vh-64px)] overflow-hidden">
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-hidden">
          <Chatbox onWorkflowClick={handleWorkflowClick} />
        </div>
      </div>
    </div>
  )
}

export default SidebarBotOnly