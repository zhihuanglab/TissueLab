"use client";
import {
  Database,
  FileText,
  MousePointerClick,
  Network,
  Settings
} from "lucide-react";
import dynamic from 'next/dynamic';
import React, { ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import AppHeader from "@/components/layouts/AppHeader";
import AppSidebar from "@/components/layouts/AppSidebar";
import '@annotorious/react/annotorious-react.css';

// viewer
const Annotorious = dynamic(() =>
  import('@annotorious/react').then((mod) => {
    return mod.Annotorious;
  }), { ssr: false }
);
const OpenSeadragonContainer = dynamic(() => import('@/components/imageViewer/OpenSeadragonContainer'), {
  ssr: false,
}) as React.FC<{ instanceId?: string }>;

const NiivueContainer = dynamic(() => import('@/components/imageViewer/NiivueContainer'), {
  ssr: false,
}) as React.FC<{ instanceId?: string }>;

const MemoizedOpenSeadragonContainer = React.memo(OpenSeadragonContainer);
const MemoizedNiivueContainer = React.memo(NiivueContainer);

import FileUploader from "@/components/imageViewer/FileUploader";

// api
import { useInstanceCleanup } from '@/hooks/viewer/useInstanceCleanup';
import { resetSegmentationData } from '@/services/file.service';

import { useAnnotatorInstance } from '@/contexts/AnnotatorContext';

import ResizableSidebar from "@/components/imageViewer/ResizableSidebar";
import { WsProvider } from "@/contexts/WsProvider";
import { RootState } from "@/store";
import { useDispatch, useSelector } from "react-redux";
// import ViewportControls from "@/components/ImageViewer/ViewportControls"; // Now using AppHeader for both environments
import FileBrowserSidebar from "@/components/imageViewer/LeftSidebar/FileBrowserSidebar";
import SidebarViewerSetting from "@/components/imageViewer/RightSidebar/SidebarViewerSetting";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { setOutputPath, setPanels } from "@/store/slices/chat/workflowSlice";
import {
  applyWorkflowPreviewSteps,
  findLastWorkflowCardPayload,
} from "@/utils/workflow/hydrateWorkflowFromChat";
import { setCurrentImagePath } from "@/store/slices/fileManagerSlice";
import { useWorkflowHistory } from "@/store/zustand/store";
import { setImageLoaded } from "@/store/slices/layoutSlice";
import { resetSvsPath } from "@/store/slices/svsPathSlice";
import { resetWSIState } from "@/store/slices/wsiSlice";
import EventBus from "@/utils/EventBus";
import { getFileViewerType } from "@/utils/dashboard/fileTypeUtils";
import { cn } from "@/utils/twMerge";
import { useUserInfo } from "@/provider/UserInfoProvider";


function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const ImageViewer = () => {
  const dispatch = useDispatch();
  const { setInstanceId, setAnnotatorInstance, setViewerInstance } = useAnnotatorInstance();
  const { userIdentity } = useUserInfo();
  const historyEntries = useWorkflowHistory((s) => s.entries);
  const selectedHistoryId = useWorkflowHistory((s) => s.selectedHistoryId);
  const selectEntry = useWorkflowHistory((s) => s.selectEntry);
  const clearSelection = useWorkflowHistory((s) => s.clearSelection);
  const stashLivePanels = useWorkflowHistory((s) => s.stashLivePanels);
  const stashedPanels = useWorkflowHistory((s) => s.stashedPanels);
  const stashedOutputPath = useWorkflowHistory((s) => s.stashedOutputPath);
  const loadFromCloud = useWorkflowHistory((s) => s.loadFromCloud);
  const livePanels = useSelector((state: RootState) => state.workflow.panels);
  const liveOutputPath = useSelector((state: RootState) => state.workflow.outputPath);
  const chatMessages = useSelector((state: RootState) => state.chat.messages);
  const isWorkflowRunning = useSelector((state: RootState) => state.workflow.isRunning);
  const runningExecutionId = useSelector((state: RootState) => state.workflow.runningExecutionId);
  const executionToWorkflowIdMap = useSelector((state: RootState) => state.workflow.executionToWorkflowIdMap);
  
  // Check which history entry is currently running
  const runningHistoryEntryId = useMemo(() => {
    if (!runningExecutionId || !isWorkflowRunning) return null;
    return executionToWorkflowIdMap[runningExecutionId] || null;
  }, [runningExecutionId, isWorkflowRunning, executionToWorkflowIdMap]);

  const { instances } = useSelector((state: RootState) => state.wsi);
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const isMobile = useSelector((state: RootState) => state.layout.isMobile);
  const [isSidebarVisible, setIsSidebarVisible] = useState(false);
  /** Once true, keep ResizableSidebar mounted (hidden when closed) so Workflow / Workflow Graph state is not destroyed. */
  const [sidebarMountedOnce, setSidebarMountedOnce] = useState(false);
  /** User opened Workflow or Agentic AI at least once — keep those panels mounted after closing sidebar. */
  const [workflowRailsMounted, setWorkflowRailsMounted] = useState(false);
  const [showPrefsPopup, setShowPrefsPopup] = useState(false);
  const [sidebarContent, setSidebarContent] = useState<string | null>(null);
  const [showSettingsBadge, setShowSettingsBadge] = useState(false);
  const [isElectron, setIsElectron] = useState(false);
  const previousUserIdentityRef = useRef(userIdentity);
  const imageUploaded = useSelector(
    (state: RootState) => state.layout.imageLoaded
  )
  const hasRenderableViewer = useMemo(() => {
    const instanceEntries = Object.values(instances || {});
    if (!currentPath || !imageUploaded) return false;
    return instanceEntries.some((instance) => instance?.isActive);
  }, [currentPath, imageUploaded, instances]);

  // Use instance cleanup hook
  useInstanceCleanup();

  useEffect(() => {
    setIsElectron(typeof window !== 'undefined' && !!(window as any).electron);
  }, []);

  useEffect(() => {
    const previousIdentity = previousUserIdentityRef.current;
    if (previousIdentity === 3 && userIdentity !== 3) {
      setAnnotatorInstance(null);
      setViewerInstance(null);
      setInstanceId(null);
      dispatch(resetWSIState());
      dispatch(resetSvsPath());
      dispatch(setCurrentImagePath(null));
      dispatch(setOutputPath(''));
      dispatch(setImageLoaded(false));
    }
    previousUserIdentityRef.current = userIdentity;
  }, [dispatch, setAnnotatorInstance, setInstanceId, setViewerInstance, userIdentity]);

  // Check if user has clicked settings button before
  useEffect(() => {
    const hasClickedSettings = localStorage.getItem('imageViewer_settings_clicked');
    if (!hasClickedSettings) {
      setShowSettingsBadge(true);
    }
  }, []);

  // Load workflow history from Firebase on mount
  useEffect(() => {
    loadFromCloud();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isSidebarVisible) setSidebarMountedOnce(true);
  }, [isSidebarVisible]);

  useEffect(() => {
    if (
      sidebarContent === 'SidebarWorkflow' ||
      sidebarContent === 'SidebarWorkflowGraph'
    ) {
      setWorkflowRailsMounted(true);
    }
  }, [sidebarContent]);

  // Add this useEffect
  useEffect(() => {
    // Return cleanup function that runs when component unmounts
    return () => {
      // Call reset API endpoint
      resetSegmentationData()
        .then(response => {
          console.log('Successfully reset segmentation data:', response);
        })
        .catch(error => {
          console.error('Failed to reset segmentation data:', error);
        });
    };
  }, []); // Empty dependency array means this runs once on mount and cleanup runs on unmount

  const toggleSidebar = useCallback((content: string) => {
    if (sidebarContent === content) {
      setIsSidebarVisible(false);
      setSidebarContent(null);
    } else {
      setIsSidebarVisible(true);
      setSidebarContent(content);
    }
  }, [sidebarContent]);

  // Listen for requests to open a specific sidebar from nested components
  useEffect(() => {
    const handler = (content: string) => {
      // Open and switch to the requested sidebar
      // @ts-ignore
      toggleSidebar(content)
    }
    EventBus.on('open-sidebar', handler);
    return () => {
      EventBus.off('open-sidebar', handler);
    }
  }, [toggleSidebar]);

  const isCoPilotEnabled = useSelector((state: RootState) => state.coPilot.enabled);
  
  useEffect(() => {
    console.log('isCoPilotEnabled:', isCoPilotEnabled); // Add this line
  }, [isCoPilotEnabled]);

  // Define highlight colors
  const navButtonClass = (isActive: boolean) =>
    cn(
      "h-9 w-full justify-start gap-2 px-2 rounded-[6px] text-sm transition-colors hover:bg-foreground/10 hover:text-foreground",
      isActive
        ? "bg-foreground/10 text-foreground"
        : "bg-transparent text-muted-foreground "
    );

  const prefsButtonClass = (isActive: boolean) =>
    cn(
      "h-9 w-full justify-start gap-2 px-2 rounded-[6px] text-sm transition-colors shadow-sm",
      isActive
        ? "bg-secondary text-secondary-foreground"
        : "bg-transparent text-muted-foreground hover:bg-primary/10 hover:text-foreground"
    );

  return (
    <TooltipProvider delayDuration={300}>
      <WsProvider>
        {/* Main Layout Container */}
        <div className="h-screen flex">
        {/* File Browser Sidebar - LEFT (Full Height) */}
          <FileBrowserSidebar />
        
            {/* Right Content Area */}
            <div className="flex-1 flex flex-col min-h-0 overflow-x-hidden">
            {/* Header - TOP (AppHeader for both environments, with different heights) */}
            <AppHeader />
            
            {/* Main Viewer Area */}
            <div className="relative flex-1 flex min-h-0 overflow-x-hidden border-t border-border/60">

            {/* Central Image Viewer */}
            <div className={`relative flex-1 overflow-hidden ${isCoPilotEnabled ? 'glowing-container' : ''}`}>
              {hasRenderableViewer ? (
                // Multiple windows container - each window has an independent container
                <div className="w-full h-full relative">
                  {Object.entries(instances).map(([instanceId, instance]) => {
                    const fileName = instance.fileInfo?.fileName || '';
                    const viewerType = getFileViewerType(fileName);
                    
                    return (
                      <div
                        key={instanceId}
                        className={`absolute inset-0 w-full h-full ${
                          instance.isActive ? 'z-10' : 'z-0 pointer-events-none'
                        }`}
                        style={{
                          display: instance.isActive ? 'block' : 'none'
                        }}
                      >
                        {viewerType === 'niivue' ? (
                          <MemoizedNiivueContainer instanceId={instanceId} />
                        ) : (
                          <Annotorious>
                            <MemoizedOpenSeadragonContainer instanceId={instanceId} />
                          </Annotorious>
                        )}
                      </div>
                    );
                  })}

                </div>
              ) : (
                <FileUploader />
              )}

              {/* Preferences Popup */}
              {showPrefsPopup && (
                <>
                  {/* Transparent overlay to close on outside click */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowPrefsPopup(false)}
                  />
                  <div className="absolute bottom-8 right-2 z-50 w-auto bg-white rounded-lg shadow-lg">
                    <SidebarViewerSetting />
                  </div>
                </>
              )}
            </div>


            {/* Resizable Right Sidebar — keep mounted after first open (`sidebarMountedOnce`) so closing the rail does not unmount Workflow Graph */}
            {(sidebarMountedOnce || isSidebarVisible) && !isMobile && (
              <div
                className={cn(!isSidebarVisible && 'hidden')}
                aria-hidden={!isSidebarVisible}
              >
                <ResizableSidebar
                  sidebarContent={sidebarContent}
                  isElectron={isElectron}
                  keepWorkflowRailsAlive={workflowRailsMounted}
                />
              </div>
            )}
            {(sidebarMountedOnce || isSidebarVisible) && isMobile && (
              <div
                className={cn(
                  'absolute inset-0 right-[3.25rem] z-40 flex flex-col bg-background',
                  !isSidebarVisible && 'hidden'
                )}
                aria-hidden={!isSidebarVisible}
              >
                <ResizableSidebar
                  sidebarContent={sidebarContent}
                  isElectron={isElectron}
                  fullScreen
                  keepWorkflowRailsAlive={workflowRailsMounted}
                />
              </div>
            )}
            
            {/* GPU Watchdog */}
            {/* {showWatchdog && <GPUStatusWatchDog />} */}
             {/* Right Buttons Container  */}
             <div className="relative z-50 flex h-full w-44 flex-none flex-col gap-1 bg-card px-2 py-3 border-l border-border ">
                <Button
                  variant="ghost"
                  onClick={() => toggleSidebar('SidebarMain')}
                  className={navButtonClass(sidebarContent === 'SidebarMain')}
                >
                  <FileText className="h-4 w-4 shrink-0" />
                  <span className="truncate">Main Info</span>
                </Button>

                <Button
                  variant="ghost"
                  onClick={() => toggleSidebar('SidebarWorkflowGraph')}
                  className={navButtonClass(sidebarContent === 'SidebarWorkflowGraph')}
                >
                  <Network className="h-4 w-4 shrink-0" />
                  <span className="truncate">Agentic AI</span>
                </Button>

                <Button
                  variant="ghost"
                  onClick={() => toggleSidebar('SidebarAnnotation')}
                  className={navButtonClass(sidebarContent === 'SidebarAnnotation')}
                >
                  <MousePointerClick className="h-4 w-4 shrink-0" />
                  <span className="truncate">Annotations</span>
                </Button>

                <Button
                  variant="ghost"
                  onClick={() => toggleSidebar('SidebarData')}
                  className={navButtonClass(sidebarContent === 'SidebarData')}
                >
                  <Database className="h-4 w-4 shrink-0" />
                  <span className="truncate">Workspace</span>
                </Button>

                {/* Workflow history entries */}
                {historyEntries.length > 0 && (
                  <>
                    <div className="my-1 border-t border-border" />
                    <div className="flex flex-col gap-1 overflow-y-auto flex-1 scrollbar-hide">
                      {historyEntries.map(entry => {
                        const initials = (entry.name || '').slice(0, 2) || '#';
                        const cssVar = entry.color ? `var(--${entry.color})` : 'var(--blue)';
                        const isRunning = runningHistoryEntryId === entry.id;
                        const isSelected = selectedHistoryId === entry.id;
                        return (
                          <Tooltip key={entry.id}>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                className={cn(
                                  "h-8 w-full justify-start gap-2 px-2 rounded-sm border border-border text-xs font-semibold transition-colors",
                                  isSelected && "bg-accent",
                                  isRunning && "animate-pulse"
                                )}
                                onClick={() => {
                                  if (
                                    selectedHistoryId === entry.id &&
                                    sidebarContent === 'SidebarWorkflow' &&
                                    isSidebarVisible
                                  ) {
                                    setIsSidebarVisible(false);
                                    setSidebarContent(null);
                                    return;
                                  }
                                  stashLivePanels(livePanels, liveOutputPath);
                                  selectEntry(entry.id);
                                  dispatch(setPanels(entry.panels));
                                  dispatch(setOutputPath(entry.outputPath));
                                  setIsSidebarVisible(true);
                                  setSidebarContent('SidebarWorkflow');
                                }}
                              >
                                <span
                                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-border leading-none"
                                  style={{ color: `hsl(${cssVar})` }}
                                >
                                  {initials}
                                </span>
                                <span className="truncate text-foreground">{entry.name}</span>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="left">
                              {entry.name} — {formatRelativeTime(entry.timestamp)}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </>
                )}

                <div className="mt-auto pt-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (showSettingsBadge) {
                        setShowSettingsBadge(false);
                        localStorage.setItem('imageViewer_settings_clicked', 'true');
                      }
                      setShowPrefsPopup(!showPrefsPopup);
                    }}
                    className={cn(prefsButtonClass(showPrefsPopup), "relative")}
                  >
                    <Settings className="h-4 w-4 shrink-0" />
                    <span className="truncate">Preferences</span>
                    {showSettingsBadge && (
                      <span className="absolute top-0 left-0 h-3 w-3 bg-red-500 rounded-full border-2 border-muted" />
                    )}
                  </Button>
                </div>
            </div>

            </div>
          </div>
        </div>
      </WsProvider>
    </TooltipProvider>
  );
};

//If don't write it this way, imageViewer will have a double header problem
ImageViewer.getLayout = function getLayout(page: ReactElement) {
  const LayoutWrapper = () => {
    return (
      <div className="app-container flex h-screen w-full overflow-hidden">
        <AppSidebar />
        <div className="main-content-wrapper flex flex-col h-screen flex-1 min-w-0 transition-all duration-300 px-0">
          <main className="flex-grow-1 h-full overflow-hidden">
            {page}
          </main>
        </div>
      </div>
    );
  };

  return <LayoutWrapper />;
};

export default ImageViewer;
