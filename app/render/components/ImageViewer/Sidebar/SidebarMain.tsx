import React, { useState, useEffect, useRef } from 'react';
import { Camera } from 'lucide-react'
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '@/store';
import {
  toggleChannel,
  setChannelColor,
  setAllChannelsVisibility,
  initializeChannels,
  batchUpdateChannelColors
} from '@/store/slices/svsPathSlice';
import throttle from 'lodash/throttle';
import dynamic from 'next/dynamic';
import { setTrackpadGesture } from '@/store/slices/viewerSettingsSlice';
import { setImageSetting, resetImageSettings } from '@/store/slices/imageSettingsSlice';
import { useAnnotatorInstance } from '@/contexts/AnnotatorContext';
import { message } from 'antd';
import { takeSnapshot } from '@/utils/snapshot.util';
const Navigator = dynamic(() => import('@/components/ImageViewer/Navigator'), { ssr: false });

// Function to generate a random color
const getRandomColor = () => {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
};

const MainSidebar: React.FC = () => {
  const dispatch = useDispatch();
  const { viewerInstance } = useAnnotatorInstance();
  
  // Hydrate trackpad gesture preference on the client
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const isMacOS = navigator.userAgent.includes('Mac');
      dispatch(setTrackpadGesture(isMacOS));
    }
  }, [dispatch]);
  const totalChannels = useSelector((state: RootState) => state.svsPath.totalChannels);
  const channels = useSelector((state: RootState) => state.svsPath.channels);
  const visibleChannels = useSelector((state: RootState) => state.svsPath.visibleChannels);
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const slideInfo = useSelector((state: RootState) => state.svsPath.slideInfo);

  const shouldShowMultiplex = () => {
    const isQPTiff = (currentPath || '').toLowerCase().endsWith('.qptiff');
    return isQPTiff;
  };

  const [pendingChannelChanges, setPendingChannelChanges] = useState<Set<number>>(new Set());
  const batchUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (totalChannels && channels.length === 0) {
      if (shouldShowMultiplex()) {
        dispatch(initializeChannels());
      } else {
        dispatch(setAllChannelsVisibility(false));
        [0, 1, 2].forEach(index => {
          dispatch(toggleChannel(index));
        });
      }
    }
  }, [totalChannels, dispatch, channels.length, currentPath, slideInfo.imageType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update viewport info when viewer instance changes
  useEffect(() => {
    if (viewerInstance) {
      const updateViewportInfo = () => {
        try {
          const viewport = viewerInstance.viewport;
          if (viewport) {
            const zoom = viewport.getZoom();
            const center = viewport.getCenter();
            setViewportInfo({ zoom, center });
          }
        } catch (error) {
          console.warn('Could not get viewport info:', error);
        }
      };

      updateViewportInfo();
      
      // Listen for viewport changes
      const handleUpdate = () => updateViewportInfo();
      viewerInstance.addHandler('update-viewport', handleUpdate);
      viewerInstance.addHandler('zoom', handleUpdate);
      viewerInstance.addHandler('pan', handleUpdate);

      return () => {
        viewerInstance.removeHandler('update-viewport', handleUpdate);
        viewerInstance.removeHandler('zoom', handleUpdate);
        viewerInstance.removeHandler('pan', handleUpdate);
      };
    }
  }, [viewerInstance]);

  const [imageType] = useState(slideInfo.imageType || 'Brightfield H&E');

  // Use Redux state instead of local state
  const imageSettings = useSelector((state: RootState) => state.imageSettings);
  const [isSnapshotLoading, setIsSnapshotLoading] = useState(false);
  const [viewportInfo, setViewportInfo] = useState<{
    zoom: number;
    center: { x: number; y: number };
  } | null>(null);

  const handleResetDefaults = () => {
    dispatch(resetImageSettings());
  };

  const handleSettingChange = (setting: string, value: number) => {
    dispatch(setImageSetting({ setting: setting as keyof typeof imageSettings, value }));
  };

  // Snapshot current canvas view
  const handleSnapshot = async () => {
    if (!viewerInstance) {
      message.warning('Viewer instance not available');
      return;
    }

    setIsSnapshotLoading(true);

    try {
      const success = await takeSnapshot(viewerInstance, {
        backgroundColor: null,
        useCORS: true,
        allowTaint: true,
        logging: true
      });

      if (!success) {
        console.error('Snapshot failed');
      }
    } catch (error) {
      console.error('Error capturing snapshot:', error);
      message.error('Error capturing snapshot');
    } finally {
      setIsSnapshotLoading(false);
    }
  };

  const handleChannelToggle = (index: number) => {
    setPendingChannelChanges(prev => {
      const newChanges = new Set(prev);
      newChanges.add(index);

      // Clear existing timeout
      if (batchUpdateTimeoutRef.current) {
        clearTimeout(batchUpdateTimeoutRef.current);
      }

      // Set new timeout
      batchUpdateTimeoutRef.current = setTimeout(() => {
        console.log('Processing batch channel updates:', newChanges);
        newChanges.forEach(channelIndex => {
          dispatch(toggleChannel(channelIndex));
        });
        window.dispatchEvent(new CustomEvent('updateChannels'));
        setPendingChannelChanges(new Set());
      }, 500);

      return newChanges;
    });
  };

  // Throttle the color change to avoid too many re-renders
  const throttledColorChange = useRef(
    throttle((index: number, color: string) => {
      dispatch(setChannelColor({ index, color }));
      // Use setTimeout to ensure state update completes before triggering event
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('updateChannels'));
      }, 50);
    }, 100) // Reduced throttle time for more responsive updates
  ).current;

  const handleColorChange = (index: number, color: string) => {
    const fixed = color.startsWith('#') ? color : `#${color}`;
    throttledColorChange(index, fixed);
  };

  const assignRandomColors = () => {
    const newColors = channels.map((_, index) => ({
      index,
      color: getRandomColor()
    }));
    dispatch(batchUpdateChannelColors(newColors));
    // Use setTimeout to ensure state update completes before triggering event
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('updateChannels'));
    }, 50);
  };

  const allSelected = channels.length > 0 && channels.every(channel => channel.isVisible);

  const toggleAllChannels = () => {
    console.log('[Toggle All Channels] Called, current allSelected:', allSelected);
    dispatch(setAllChannelsVisibility(!allSelected));
    
    // Use setTimeout to ensure state update completes before triggering event
    setTimeout(() => {
      console.log('[Toggle All Channels] Triggering updateChannels event');
      window.dispatchEvent(new CustomEvent('updateChannels'));
    }, 50);
  };


  const isChannelVisible = (channelIndex: number) => {
    return visibleChannels.includes(channelIndex);
  };

  useEffect(() => {
    return () => {
      if (batchUpdateTimeoutRef.current) {
        clearTimeout(batchUpdateTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="space-y-6 h-screen overflow-y-auto p-4 custom-scrollbar">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Navigator</CardTitle>
        </CardHeader>
        <CardContent>
          <Navigator navigatorId="side-bar-navigator" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Slide Information</CardTitle>
        </CardHeader>
        <CardContent>
          <Table className="compact-table">
            <TableBody>
              <TableRow>
                <TableCell className="font-medium py-1 px-2">File Name</TableCell>
                <TableCell className="py-1 px-2 break-all">
                  {currentPath ? currentPath.split(/[\\/]/).pop() : 'No file loaded'}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium py-1 px-2">Image Size</TableCell>
                <TableCell className="py-1 px-2">
                  {slideInfo.dimensions
                    ? `${slideInfo.dimensions[0]} x ${slideInfo.dimensions[1]}`
                    : 'N/A'}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium py-1 px-2">File size</TableCell>
                <TableCell className="py-1 px-2">
                  {slideInfo.fileSize || 'N/A'}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium py-1 px-2">MPP</TableCell>
                <TableCell className="py-1 px-2">
                  {slideInfo.mpp ? `${slideInfo.mpp} µm` : 'N/A'}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium py-1 px-2">Magnification</TableCell>
                <TableCell className="py-1 px-2">
                  {slideInfo.magnification ? `${slideInfo.magnification}x` : 'N/A'}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* H5Card moved to separate sidebar button */}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Image settings</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4">
            <label className="font-medium mr-2">Image Type:</label>
            {shouldShowMultiplex() ? (
              <span className="whitespace-nowrap text-purple-800">Multiplex IF</span>
            ) : (
              <span className="whitespace-nowrap text-gray-700">H&E</span>
            )}
          </div>

          {shouldShowMultiplex() && (
            <div>
              <div className="font-medium mb-2">Channels</div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-2 mb-3">
                {channels.map((channel, index) => (
                  <div key={index} className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isChannelVisible(index) || pendingChannelChanges.has(index)}
                        onChange={() => handleChannelToggle(index)}
                        className="w-3.5 h-3.5"
                        id={`channel-${index}`}
                      />
                      <label
                        htmlFor={`channel-${index}`}
                        className="text-sm cursor-pointer"
                      >
                        {channel.name}
                      </label>
                    </div>
                    <input
                      type="color"
                      value={channel.color}
                      onChange={(e) => handleColorChange(index, e.target.value)}
                      className="w-5 h-5"
                    />
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={toggleAllChannels}
                >
                  {allSelected ? 'Deselect All' : 'Select All'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={assignRandomColors}
                >
                  Randomize Colors
                </Button>
              </div>
            </div>
          )}

          {!shouldShowMultiplex() && (
            <div>
              <Table className="compact-table">
                <TableBody>
                  <TableRow className="compact-row">
                    <TableCell className="font-medium">Brightness</TableCell>
                    <TableCell>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={imageSettings.brightness}
                        onChange={(e) => handleSettingChange('brightness', Number(e.target.value))}
                      />
                      <span>{imageSettings.brightness}</span>
                    </TableCell>
                  </TableRow>
                  <TableRow className="compact-row">
                    <TableCell className="font-medium">Contrast</TableCell>
                    <TableCell>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={imageSettings.contrast}
                        onChange={(e) => handleSettingChange('contrast', Number(e.target.value))}
                      />
                      <span>{imageSettings.contrast}</span>
                    </TableCell>
                  </TableRow>
                  <TableRow className="compact-row">
                    <TableCell className="font-medium">Saturation</TableCell>
                    <TableCell>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={imageSettings.saturation}
                        onChange={(e) => handleSettingChange('saturation', Number(e.target.value))}
                      />
                      <span>{imageSettings.saturation}</span>
                    </TableCell>
                  </TableRow>
                  <TableRow className="compact-row">
                    <TableCell className="font-medium">Sharpness</TableCell>
                    <TableCell>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={imageSettings.sharpness}
                        onChange={(e) => handleSettingChange('sharpness', Number(e.target.value))}
                      />
                      <span>{imageSettings.sharpness}</span>
                    </TableCell>
                  </TableRow>
                  <TableRow className="compact-row">
                    <TableCell className="font-medium">Gamma</TableCell>
                    <TableCell>
                      <input
                        type="range"
                        min="0.1"
                        max="3"
                        step="0.1"
                        value={imageSettings.gamma}
                        onChange={(e) => handleSettingChange('gamma', Number(e.target.value))}
                      />
                      <span>{imageSettings.gamma}</span>
                    </TableCell>
                  </TableRow>

                </TableBody>
              </Table>
              <Button className="m-1 text-sm py-1 px-2" onClick={handleResetDefaults}>Reset to Default</Button>
            </div>
          )}
          <Button 
            className="m-1 text-sm py-1 px-2" 
            onClick={handleSnapshot}
            disabled={!viewerInstance || isSnapshotLoading}
          >
            {isSnapshotLoading ? (
              <>
                <div className="w-4 h-4 mr-2 border-2 border-gray-600 border-t-transparent rounded-full animate-spin" />
                Capturing...
              </>
            ) : (
              <>
                <Camera className="w-4 h-4 mr-2" />
                Snapshot current canvas view
              </>
            )}
          </Button>
          {viewerInstance && viewportInfo && (
            <div className="text-xs text-gray-500 px-2 text-center space-y-1">
              <p>Captures current zoom level and viewport position</p>
              <p className="text-gray-400">
                Zoom: {viewportInfo.zoom.toFixed(2)}x | 
                Center: ({viewportInfo.center.x.toFixed(0)}, {viewportInfo.center.y.toFixed(0)})
              </p>
            </div>
          )}
        </CardContent>
      </Card>
        <Separator />
    </div>
  );
};

export default MainSidebar;
