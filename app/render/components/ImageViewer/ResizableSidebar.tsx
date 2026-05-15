'use client'

import dynamic from 'next/dynamic';
import React, { useCallback, useEffect, useState } from 'react';

// Dynamically import sidebar components to avoid SSR issues with openseadragon
const SidebarAnnotation = dynamic(() => import("@/components/imageViewer/RightSidebar/SidebarAnnotaion"), { ssr: false });
const SidebarBotOnly = dynamic(() => import("@/components/imageViewer/RightSidebar/SidebarBotOnly"), { ssr: false });
const SidebarMain = dynamic(() => import("@/components/imageViewer/RightSidebar/SidebarMain"), { ssr: false });
const SidebarPrefs = dynamic(() => import("@/components/imageViewer/RightSidebar/SidebarViewerSetting"), { ssr: false });
const SidebarWorkflowOnly = dynamic(() => import("@/components/imageViewer/RightSidebar/SidebarWorkflowOnly"), { ssr: false });
const SidebarWorkflowGraphOnly = dynamic(() => import("@/components/imageViewer/RightSidebar/SidebarWorkflowGraphOnly"), { ssr: false });
const SidebarDataViewer = dynamic(() => import("@/components/imageViewer/RightSidebar/SidebarDataViewer"), { ssr: false });

interface ResizableComponentProps {
  children: React.ReactNode;
  minWidth?: number;
  maxWidth?: number;
  sidebarContent: string | null;
  fullScreen?: boolean;
}

const ResizableComponent: React.FC<ResizableComponentProps> = ({ children, minWidth = 400, maxWidth = 800, sidebarContent, fullScreen = false }) => {
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

  if (fullScreen) {
    return (
      <aside className="relative flex-1 overflow-x-hidden bg-background overflow-hidden h-full w-full flex flex-col">
        <div className="flex-1 overflow-y-auto scrollbar-hide min-h-0">{children}</div>
      </aside>
    );
  }

  return (
    <aside
      style={{ width: sidebarWidth }}
      className="relative pl-1 flex-shrink-0 overflow-x-hidden bg-background overflow-hidden border-l border-border h-full flex flex-col"
    >
      <div className="flex-1 overflow-y-auto scrollbar-hide min-h-0">{children}</div>
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
  isElectron?: boolean;
  fullScreen?: boolean;
  /**
   * Once the user opens Workflow or Agentic AI at least once, keep those roots mounted even when
   * `sidebarContent` is null (sidebar closed) so graph/list state survives toggle — mirrors SidebarChat TabsContent forceMount.
   */
  keepWorkflowRailsAlive?: boolean;
}

const ResizableSidebar: React.FC<ResizableSidebarProps> = ({
  sidebarContent,
  isElectron = false,
  fullScreen = false,
  keepWorkflowRailsAlive = false,
}) => {
  const getMinWidth = () => {
    if (sidebarContent === 'WebFileManager') {
      return 500;
    }
    return 400;
  };

  return (
    <div className="h-full flex flex-row-reverse">
      <ResizableComponent
        minWidth={getMinWidth()}
        sidebarContent={sidebarContent}
        fullScreen={fullScreen}
      >
        {sidebarContent === 'SidebarMain' && <SidebarMain />}
        {sidebarContent === 'SidebarAnnotation' && <SidebarAnnotation />}
        {sidebarContent === 'SidebarChat' && <SidebarBotOnly />}
        {/* Align with SidebarChat TabsContent forceMount: Workflow + Graph stay mounted once visited (`keepWorkflowRailsAlive`) even when sidebar closed (`sidebarContent` null). */}
        {(sidebarContent != null || keepWorkflowRailsAlive) && (
          <>
            <div
              className={
                sidebarContent === 'SidebarWorkflow'
                  ? 'h-full min-h-0 overflow-hidden'
                  : 'hidden'
              }
              aria-hidden={sidebarContent !== 'SidebarWorkflow'}
            >
              <SidebarWorkflowOnly />
            </div>
            <div
              className={
                sidebarContent === 'SidebarWorkflowGraph'
                  ? 'h-full min-h-0 overflow-hidden'
                  : 'hidden'
              }
              aria-hidden={sidebarContent !== 'SidebarWorkflowGraph'}
            >
              <SidebarWorkflowGraphOnly />
            </div>
          </>
        )}
        {sidebarContent === 'SidebarData' && <SidebarDataViewer />}
        {sidebarContent === 'SidebarViewerSetting' && <SidebarPrefs />}

      </ResizableComponent>
    </div>
  );
};

export default ResizableSidebar;
