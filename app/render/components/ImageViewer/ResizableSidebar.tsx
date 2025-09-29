'use client'

import React, { useState, useEffect, useCallback } from 'react'
import SidebarMain from "@/components/ImageViewer/Sidebar/SidebarMain";
import SidebarAnnotation from "@/components/ImageViewer/Sidebar/SidebarAnnotaion";
// import SidebarPythonScripts from "@/components/ImageViewer/Sidebar/SidebarPythonScripts";
// Original SidebarChat kept for reference (contains tabs)
// import SidebarChat from "@/components/ImageViewer/Sidebar/SidebarChat";
import SidebarBotOnly from "@/components/ImageViewer/Sidebar/SidebarBotOnly";
import SidebarWorkflowOnly from "@/components/ImageViewer/Sidebar/SidebarWorkflowOnly";
import SidebarPrefs from "@/components/ImageViewer/Sidebar/SidebarViewerSetting";
// TODO: Comment out for future use
// import SidebarAITabs from "@/components/ImageViewer/Sidebar/SidebarAITabs/index";
import SidebarH5DataViewer from "@/components/ImageViewer/Sidebar/SidebarH5DataViewer";

interface ResizableComponentProps {
  children: React.ReactNode;
  minWidth?: number;
  maxWidth?: number;
  sidebarContent: string | null;
}

const ResizableComponent: React.FC<ResizableComponentProps> = ({ children, minWidth = 400, maxWidth = 800, sidebarContent }) => {
  const [isResizing, setIsResizing] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(minWidth)

  const startResizing = useCallback((mouseDownEvent: React.MouseEvent) => {
    setIsResizing(true)
  }, [])

  const stopResizing = useCallback(() => {
    setIsResizing(false)
  }, [])

  const resize = useCallback(
    (mouseMoveEvent: MouseEvent) => {
      if (isResizing) {
        const newWidth = window.innerWidth - mouseMoveEvent.clientX
        setSidebarWidth(Math.max(minWidth, Math.min(newWidth, maxWidth)))
      }
    },
    [isResizing, minWidth, maxWidth]
  )

  // Update the sidebar width when minWidth or sidebarContent changes
  useEffect(() => {
    setSidebarWidth(Math.max(minWidth, Math.min(sidebarWidth, maxWidth)));
  }, [minWidth, sidebarWidth, maxWidth])

  useEffect(() => {
    window.addEventListener('mousemove', resize)
    window.addEventListener('mouseup', stopResizing)
    return () => {
      window.removeEventListener('mousemove', resize)
      window.removeEventListener('mouseup', stopResizing)
    }
  }, [resize, stopResizing])

  return (
    <aside
      style={{ width: sidebarWidth }}
      className="relative pl-1 flex-shrink-0 overflow-x-hidden bg-background overflow-hidden"
    >
      <div className="h-[calc(100vh-64px)] overflow-y-auto scrollbar-hide">{children}</div>
      <button
        tabIndex={0}
        onMouseDown={startResizing}
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize bg-border hover:bg-primary/50"
        aria-label="Resize sidebar"
      />
    </aside>
  )
}

interface ResizableSidebarProps {
  sidebarContent: string | null;
}

const ResizableSidebar: React.FC<ResizableSidebarProps> = ({
  sidebarContent
}) => {
  const getMinWidth = () => {
    if (sidebarContent === 'WebFileManager') {
      return 500;
    }
    return 400;
  };

  return (
    <div className="h-[calc(100vh-64px)] flex flex-row-reverse">
      {/* Careful with the height, right now it is full screen - 64px (header) */}
      <ResizableComponent
        minWidth={getMinWidth()}
        sidebarContent={sidebarContent}
      >
        {sidebarContent === 'SidebarMain' && <SidebarMain />}
        {sidebarContent === 'SidebarAnnotation' && <SidebarAnnotation />}
        {sidebarContent === 'SidebarChat' && <SidebarBotOnly />}
        {sidebarContent === 'SidebarWorkflow' && <SidebarWorkflowOnly />}
        {sidebarContent === 'SidebarH5Data' && <SidebarH5DataViewer />}
        {sidebarContent === 'SidebarViewerSetting' && <SidebarPrefs />}

      </ResizableComponent>
    </div>
  );
};

export default ResizableSidebar;
