'use client'

import dynamic from 'next/dynamic';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import SidebarPanelSkeleton from '@/components/imageViewer/common/SidebarPanelSkeleton';
import eventBus from '@/utils/common/eventBus';

// Dynamically import sidebar components to avoid SSR issues with
// openseadragon. Each panel gets `loading: SidebarPanelSkeleton` so
// the chunk fetch shows a skeleton instead of a blank rectangle —
// without it the panel reads as "white screen for 2s" on cold loads.
const dynamicPanel = <P extends object>(loader: () => Promise<{ default: React.ComponentType<P> }>) =>
  dynamic(loader, { ssr: false, loading: () => <SidebarPanelSkeleton /> });

const SidebarAnnotation = dynamicPanel(() => import("@/components/imageViewer/sidebar/annotation/SidebarAnnotaion"));
const SidebarBotOnly = dynamicPanel(() => import("@/components/imageViewer/sidebar/agent/SidebarBotOnly"));
const SidebarMain = dynamicPanel(() => import("@/components/imageViewer/sidebar/main/SidebarMain"));
const SidebarPrefs = dynamicPanel(() => import("@/components/imageViewer/sidebar/settings/SidebarViewerSetting"));
const SidebarWorkflowGraphOnly = dynamicPanel(() => import("@/components/imageViewer/sidebar/agent/SidebarWorkflowGraphOnly"));
const SidebarDataViewer = dynamicPanel(() => import("@/components/imageViewer/sidebar/workspace/SidebarDataViewer"));

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
  const startXRef = useRef(0)
  const startWidthRef = useRef(minWidth)

  const clampWidth = useCallback(
    (width: number) => Math.max(minWidth, Math.min(width, maxWidth)),
    [minWidth, maxWidth],
  )

  const startResizing = useCallback((mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault()
    startXRef.current = mouseDownEvent.clientX
    startWidthRef.current = sidebarWidth
    setIsResizing(true)
  }, [sidebarWidth])

  useEffect(() => {
    setSidebarWidth((w) => clampWidth(w))
  }, [clampWidth, sidebarContent])

  useEffect(() => {
    if (!isResizing) return

    const onMove = (mouseMoveEvent: MouseEvent) => {
      const delta = startXRef.current - mouseMoveEvent.clientX
      setSidebarWidth(clampWidth(startWidthRef.current + delta))
    }
    const onEnd = () => setIsResizing(false)

    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('blur', onEnd)
    return () => {
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('blur', onEnd)
    }
  }, [isResizing, clampWidth])

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
      className="relative pl-1 shrink-0 overflow-x-hidden bg-background overflow-hidden border-l border-border h-full flex flex-col"
    >
      <div className="flex-1 overflow-y-auto scrollbar-hide min-h-0">{children}</div>
      <button
        type="button"
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
  fullScreen?: boolean;
  /**
   * Once the user opens Workflow or Agentic AI at least once, keep those roots mounted even when
   * `sidebarContent` is null (sidebar closed) so graph/list state survives toggle — mirrors SidebarChat TabsContent forceMount.
   */
  keepWorkflowRailsAlive?: boolean;
}

const ResizableSidebar: React.FC<ResizableSidebarProps> = ({
  sidebarContent,
  fullScreen = false,
  keepWorkflowRailsAlive = false,
}) => {
  const getMinWidth = () => {
    if (sidebarContent === 'WebFileManager') {
      return 500;
    }
    return 400;
  };

  // Chat and Workflow share one panel with a top tab bar.
  const isAgentView = sidebarContent === 'SidebarChat' || sidebarContent === 'SidebarWorkflowGraph';

  return (
    <div className="h-full">
      <ResizableComponent
        minWidth={getMinWidth()}
        sidebarContent={sidebarContent}
        fullScreen={fullScreen}
      >
        {sidebarContent === 'SidebarMain' && <SidebarMain />}
        {sidebarContent === 'SidebarAnnotation' && <SidebarAnnotation />}
        {/* Agent group: Chat + Workflow under one shared top tab bar. Clicking a tab
            just re-emits the existing open-sidebar event. Workflow stays mounted once
            visited (`keepWorkflowRailsAlive`) so its graph state survives toggling;
            chat mounts only while active (unchanged behavior). */}
        {(isAgentView || keepWorkflowRailsAlive) && (
          <div className={isAgentView ? 'flex h-full min-h-0 flex-col' : 'hidden'}>
            {isAgentView && (
              <div className="flex shrink-0 items-stretch border-b border-border bg-card">
                {([
                  ['SidebarChat', 'Agent'],
                  ['SidebarWorkflowGraph', 'Trajectories'],
                ] as const).map(([target, label]) => (
                  <button
                    key={target}
                    type="button"
                    onClick={() => eventBus.emit('open-sidebar', target)}
                    className={`flex-1 border-b-2 py-2 text-sm font-medium transition-colors ${
                      sidebarContent === target
                        ? 'border-primary text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              {sidebarContent === 'SidebarChat' && (
                <div className="h-full min-h-0 overflow-hidden">
                  <SidebarBotOnly />
                </div>
              )}
              <div
                className={sidebarContent === 'SidebarWorkflowGraph' ? 'h-full min-h-0 overflow-hidden' : 'hidden'}
                aria-hidden={sidebarContent !== 'SidebarWorkflowGraph'}
              >
                <SidebarWorkflowGraphOnly />
              </div>
            </div>
          </div>
        )}
        {sidebarContent === 'SidebarData' && <SidebarDataViewer />}
        {sidebarContent === 'SidebarViewerSetting' && <SidebarPrefs />}

      </ResizableComponent>
    </div>
  );
};

export default ResizableSidebar;
