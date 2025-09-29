"use client";
import React, { useEffect, useState, ReactElement, useCallback } from 'react';
import { CButton } from '@coreui/react';
import dynamic from 'next/dynamic';
import {
  Info,
  Cog,
  Eye,
  MessageSquareText,
  MousePointerClick,
  SquareTerminal,
  FolderOpen,
  Database
} from "lucide-react";

import styles from '../styles/imageViewer.module.css';

import AppSidebar from "@/components/Layouts/AppSidebar";
import AppHeader from "@/components/Layouts/AppHeader";

// viewer
const Annotorious = dynamic(() =>
  import('@annotorious/react').then((mod) => {
    return mod.Annotorious;
  }), { ssr: false }
);
import '@annotorious/react/annotorious-react.css';
const OpenSeadragonContainer = dynamic(() => import('@/components/ImageViewer/OpenSeadragonContainer'), {
  ssr: false,
}) as React.FC<{ instanceId?: string }>;

const MemoizedOpenSeadragonContainer = React.memo(OpenSeadragonContainer);

import FileUploader from "@/components/ImageViewer/FileUploader";

// api
import { resetSegmentationData } from '@/utils/file.service';
import { useInstanceCleanup } from '@/hooks/useInstanceCleanup';

import { AnnotatorProvider, useAnnotatorInstance } from '@/contexts/AnnotatorContext';

import { useDispatch, useSelector } from "react-redux";
import { RootState } from "@/store";
import { setImageLoaded } from "@/store/slices/sidebarSlice";
import ResizableSidebar from "@/components/ImageViewer/ResizableSidebar";
import { useWs, WsProvider } from "@/contexts/WsProvider";
import GPUStatusWatchDog from "@/components/assets/watchdog";
import { setCurrentPath, setSlideInfo, setTotalChannels } from '@/store/slices/svsPathSlice';
import PanelModal from "@/components/ImageViewer/PanelModal";
import { addWSIInstance, updateInstanceWSIInfo } from '@/store/slices/wsiSlice';
// import ViewportControls from "@/components/ImageViewer/ViewportControls"; // Now using AppHeader for both environments
import FileBrowserSidebar from "@/components/ImageViewer/FileBrowserSidebar";
import SidebarViewerSetting from "@/components/ImageViewer/Sidebar/SidebarViewerSetting";
import EventBus from "@/utils/EventBus";
import GlobalSignupModal from "@/components/auth/GlobalSignupModal/GlobalSignupModal";


const ImageViewer = () => {
  const dispatch = useDispatch();
  const { setInstanceId, instanceId } = useAnnotatorInstance();

  const { instances, activeInstanceId } = useSelector((state: RootState) => state.wsi);
  const [isSidebarVisible, setIsSidebarVisible] = useState(false);
  const [showPrefsPopup, setShowPrefsPopup] = useState(false);
  const [sidebarContent, setSidebarContent] = useState<string | null>(null);
  const imageUploaded = useSelector(
    (state: RootState) => state.sidebar.imageLoaded
  )

  const isVoiceRecordingEnabled = process.env.NEXT_PUBLIC_VOICE_RECORDING === 'true';
  
  // Use instance cleanup hook
  useInstanceCleanup();

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
  const HIGHLIGHT_COLOR = '#483D8B'; // Generic highlight color for most tabs
  const MAIN_HIGHLIGHT_COLOR = '#9E9E9E'; // Slightly lighter gray for the Main tab

  return (
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
          <div className="flex-1 flex min-h-0 overflow-x-hidden">
            {/* Central Image Viewer */}
            <div className={`relative flex-1 overflow-hidden ${isCoPilotEnabled ? styles.glowingContainer : ''}`}>
              {imageUploaded ? (
                // Multiple windows container - each window has an independent container
                <div className="w-full h-full relative">
                  {Object.entries(instances).map(([instanceId, instance]) => (
                    <div
                      key={instanceId}
                      className={`absolute inset-0 w-full h-full ${
                        instance.isActive ? 'z-10' : 'z-0 pointer-events-none'
                      }`}
                      style={{
                        display: instance.isActive ? 'block' : 'none'
                      }}
                    >
                      <Annotorious>
                        <MemoizedOpenSeadragonContainer instanceId={instanceId} />
                      </Annotorious>
                    </div>
                  ))}
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

            {/* GPU Watchdog */}
            {/* {showWatchdog && <GPUStatusWatchDog />} */}

            {/* Right Sidebar Controls */}
            <div className="relative h-full" style={{ backgroundColor: '#323a49', padding: '2px' }}>
              {/*@ts-ignore*/}
              <CButton onClick={() => toggleSidebar('SidebarMain')} className={styles['sidebar-icon-button']}
                style={{ backgroundColor: sidebarContent === 'SidebarMain' ? MAIN_HIGHLIGHT_COLOR : '#cfcfcf', color: '#000' }}>
                <Info className={styles['sidebar-button-icon']} />
                <span className={styles['sidebar-button-text']}>Main</span>
              </CButton>

              <hr style={{ margin: '8px auto', borderColor: 'rgba(255, 255, 255, 0.8)', borderWidth: '1px', width: '80%' }} />

              {/*@ts-ignore*/}
              <CButton onClick={() => toggleSidebar('SidebarChat')} className={styles['sidebar-icon-button']}
                style={{ backgroundColor: sidebarContent === 'SidebarChat' ? HIGHLIGHT_COLOR : '#8879B0' }}>
                <MessageSquareText className={styles['sidebar-button-icon']} />
                <span className={styles['sidebar-button-text']}>Chat</span>
              </CButton>

              {/*@ts-ignore*/}
              <CButton onClick={() => toggleSidebar('SidebarWorkflow')} className={styles['sidebar-icon-button']}
                style={{ backgroundColor: sidebarContent === 'SidebarWorkflow' ? HIGHLIGHT_COLOR : '#9B7EBD' }}>
                <span className={styles['sidebar-button-text']} style={{ lineHeight: '1.1', fontSize: '10px' }}>
                  Work-<br/>flow
                </span>
              </CButton>

              {/*@ts-ignore*/}
              <CButton onClick={() => toggleSidebar('SidebarAnnotation')} className={styles['sidebar-icon-button']}
                style={{ backgroundColor: sidebarContent === 'SidebarAnnotation' ? HIGHLIGHT_COLOR : '#8967B3' }}>
                <MousePointerClick className={styles['sidebar-button-icon']} />
                <span className={styles['sidebar-button-text']}>Anno</span>
              </CButton>

              {/*@ts-ignore*/}
              <CButton onClick={() => toggleSidebar('SidebarH5Data')} className={styles['sidebar-icon-button']}
                style={{ backgroundColor: sidebarContent === 'SidebarH5Data' ? HIGHLIGHT_COLOR : '#9B86BD' }}>
                <Database className={styles['sidebar-button-icon']} />
                <span className={styles['sidebar-button-text']}>H5 Data</span>
              </CButton>

              {/*@ts-ignore*/}
              <CButton onClick={() => setShowPrefsPopup(!showPrefsPopup)} className={styles['sidebar-icon-button']}
                style={{ backgroundColor: showPrefsPopup ? MAIN_HIGHLIGHT_COLOR : '#cfcfcf', color: '#000', position: 'absolute', bottom: '0' }}>
                <Cog className={styles['sidebar-button-icon']} />
                <span className={styles['sidebar-button-text']}>Prefs</span>
              </CButton>
            </div>

            {/* Resizable Right Sidebar */}
            {isSidebarVisible && (
              <ResizableSidebar sidebarContent={sidebarContent} />
            )}
          </div>
        </div>
      </div>
      <PanelModal />
    </WsProvider>
  );
};

//If don't write it this way, imageViewer will have a double header problem
ImageViewer.getLayout = function getLayout(page: ReactElement) {
  const LayoutWrapper = () => {
    const sidebarShow = useSelector((state: RootState) => state.sidebar.sidebarShow);
    const unfoldable = useSelector((state: RootState) => state.sidebar.unfoldable);

    return (
      <div className="app-container flex h-screen">
        <AppSidebar />
        <div
          className={`main-content-wrapper flex flex-col h-screen flex-grow-1 transition-all duration-300 ${
            sidebarShow ? (unfoldable ? 'w-[calc(100%-64px)]' : 'w-[calc(100%-240px)]') : 'w-full'
          }`}
        >
          <main className="main-content flex-grow-1 h-full overflow-hidden">
            {page}
          </main>
        </div>
      </div>
    );
  };

  return <LayoutWrapper />;
};

export default ImageViewer;
