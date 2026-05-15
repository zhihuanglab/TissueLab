import { useEffect, useMemo, useRef } from 'react';
import { debounce } from 'lodash';
import { createTileSource } from '../../utils/viewer/viewerHelpers';

const DEBOUNCE_DELAY_MS = 300;

interface UseChannelUpdatesParams {
  viewerInstance: any;
  tileSource: any;
  visibleChannels: number[];
  channels: Array<{ color?: string }>;
  channelSignature: string;
  currentWSIInfo: any;
  currentWSIFileInfo: any;
  currentInstanceId?: string | null;
  getTileUrl: (level: number, x: number, y: number) => string;
  setAllTilesLoaded: (loaded: boolean) => void;
}

/**
 * Hook to handle channel updates and visible channels changes
 * Extracted from OpenSeadragonContainer to improve code organization
 */
export const useChannelUpdates = (params: UseChannelUpdatesParams) => {
  const {
    viewerInstance,
    tileSource,
    visibleChannels,
    channels,
    channelSignature,
    currentWSIInfo,
    currentWSIFileInfo,
    currentInstanceId,
    getTileUrl,
    setAllTilesLoaded,
  } = params;

  // Helper function to rebuild tiled image with new channels
  const rebuildTiledImage = useMemo(
    () => (newVisibleChannels?: number[]) => {
      const channelsToUse = newVisibleChannels || visibleChannels;
      if (tileSource && viewerInstance && currentWSIInfo) {
        try {
          // Get current dimensions from WSI info
          let level_0_width = 50000;
          let level_0_height = 50000;
          if (Array.isArray(currentWSIInfo.dimensions)) {
            if (currentWSIInfo.dimensions.length > 0 && Array.isArray(currentWSIInfo.dimensions[0])) {
              [level_0_width, level_0_height] = currentWSIInfo.dimensions[0];
            }
          } else {
            [level_0_width, level_0_height] = currentWSIInfo.dimensions;
          }

          viewerInstance.world.removeAll();

          const newTileSource = createTileSource(
            { width: level_0_width, height: level_0_height },
            getTileUrl,
            currentInstanceId ?? undefined,
            currentWSIFileInfo,
            { channelSignature }
          );

          viewerInstance.addTiledImage({ tileSource: newTileSource });
        } catch (error) {
          console.warn('[Channel Update] Failed to rebuild tiled image:', error);
        }
      }
    },
    [tileSource, getTileUrl, viewerInstance, currentInstanceId, currentWSIInfo, currentWSIFileInfo, channelSignature]
  );

  // Debounced effect to limit the number of calls to change channels
  const debouncedEffect = useMemo(
    () => debounce((newVisibleChannels: number[]) => {
      rebuildTiledImage(newVisibleChannels);
    }, DEBOUNCE_DELAY_MS),
    [rebuildTiledImage]
  );

  // Track previous visible channels to detect changes
  const prevVisibleChannelsRef = useRef(visibleChannels);

  // Handle visibleChannels changes with debouncing
  useEffect(() => {
    // Only trigger if visibleChannels has actually changed
    if (JSON.stringify(prevVisibleChannelsRef.current) !== JSON.stringify(visibleChannels)) {
      debouncedEffect(visibleChannels);
      prevVisibleChannelsRef.current = visibleChannels;
    }

    return () => {
      debouncedEffect.cancel();
    };
  }, [visibleChannels, debouncedEffect]);

  // Handle immediate redraw when visibleChannels change
  useEffect(() => {
    if (viewerInstance && viewerInstance.world.getItemCount() > 0) {
      setAllTilesLoaded(false);
      try {
        viewerInstance.forceRedraw();
      } catch (error) {
        console.warn('[Visible Channels] Failed to force redraw:', error);
      }
    }
  }, [visibleChannels, viewerInstance, setAllTilesLoaded]);

  // Handle updateChannels window event
  useEffect(() => {
    const handleUpdateChannels = () => {
      console.log('[Update Channels] Event received, rebuilding tiled image...');
      console.log('[Update Channels] Current visibleChannels:', visibleChannels);
      console.log('[Update Channels] Current channels:', channels);
      console.log('[Update Channels] Current channelSignature:', channelSignature);

      if (tileSource && viewerInstance && currentWSIInfo) {
        try {
          // Get current dimensions from WSI info
          let level_0_width = 50000;
          let level_0_height = 50000;
          if (Array.isArray(currentWSIInfo.dimensions)) {
            if (currentWSIInfo.dimensions.length > 0 && Array.isArray(currentWSIInfo.dimensions[0])) {
              [level_0_width, level_0_height] = currentWSIInfo.dimensions[0];
            }
          } else {
            [level_0_width, level_0_height] = currentWSIInfo.dimensions;
          }

          viewerInstance.world.removeAll();

          const newTileSource = createTileSource(
            { width: level_0_width, height: level_0_height },
            getTileUrl,
            currentInstanceId ?? undefined,
            currentWSIFileInfo,
            { channelSignature }
          );

          console.log('[Update Channels] Adding new tiled image with updated URL and signature:', channelSignature);
          viewerInstance.addTiledImage({ tileSource: newTileSource });
        } catch (error) {
          console.warn('[Update Channels] Failed to rebuild tiled image:', error);
          try {
            viewerInstance.forceRedraw();
          } catch {}
        }
      } else {
        console.warn('[Update Channels] Missing required components:', {
          tileSource: !!tileSource,
          viewerInstance: !!viewerInstance,
          currentWSIInfo: !!currentWSIInfo,
        });
      }
    };

    window.addEventListener('updateChannels', handleUpdateChannels);
    return () => {
      window.removeEventListener('updateChannels', handleUpdateChannels);
    };
  }, [viewerInstance, tileSource, getTileUrl, currentInstanceId, visibleChannels, channels, channelSignature, currentWSIInfo, currentWSIFileInfo]);
};

