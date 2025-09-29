import React, { useState, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Chatbox } from "@/components/ImageViewer/Sidebar/Chat/Chatbox"
import { WorkflowContainer } from "@/components/ImageViewer/Sidebar/Chat/WorkflowContainer"
import { useDispatch } from "react-redux"
import EventBus from "@/utils/EventBus"

const ChatSidebar = () => {
  const [activeTab, setActiveTab] = useState<"bot" | "workflow" | "QA">("bot")
  const dispatch = useDispatch();

  useEffect(() => {
    EventBus.on("switchTab", (tab) => setActiveTab(tab));

    return () => {
      EventBus.removeAllListeners("switchTab");
    };
  }, []);

  return (
    <div className="h-[calc(100vh-108px)] overflow-hidden">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as "bot" | "workflow")}
        className="flex flex-col flex-1 relative h-full"
      >
        <div className="w-full p-2 absolute top-0 bg-gradient-to-t from-transparent via-gray-50/80 to-gray-50 z-20">
          <TabsList className="w-full h-11 p-2 rounded-lg grid grid-cols-2 bg-slate-200">
            <TabsTrigger value="bot">Bot</TabsTrigger>
            <TabsTrigger value="workflow">Workflow</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="bot" className="h-full data-[state=inactive]:hidden mt-0">
          <Chatbox onWorkflowClick={() => setActiveTab("workflow")} />
        </TabsContent>

        <TabsContent value="workflow" className="h-full data-[state=inactive]:hidden mt-0 overflow-hidden">
          <WorkflowContainer />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default ChatSidebar
