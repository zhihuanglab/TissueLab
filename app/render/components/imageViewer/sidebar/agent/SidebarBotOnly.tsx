import React from "react"
import { useSelector } from "react-redux"
import { RootState } from "@/store"
import { Chatbox } from "@/components/imageViewer/sidebar/agent/chat/Chatbox"
import { CoscientistPanel } from "@/components/imageViewer/sidebar/agent/chat/CoscientistPanel"
import eventBus from "@/utils/common/eventBus"

const SidebarBotOnly = () => {
  const selectedAgent = useSelector((state: RootState) => state.agent.selectedAgent)

  if (selectedAgent === "TL Coscientist") {
    return (
      <div className="h-full overflow-hidden">
        <CoscientistPanel />
      </div>
    )
  }

  const handleWorkflowClick = () => {
    eventBus.emit('open-sidebar', 'SidebarWorkflowGraph')
  }

  return (
    <div className="h-full overflow-hidden">
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-hidden">
          <Chatbox onWorkflowClick={handleWorkflowClick} />
        </div>
      </div>
    </div>
  )
}

export default SidebarBotOnly