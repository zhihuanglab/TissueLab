import { useEffect, useRef, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '@/store';
import { updateWindowViewport } from '@/store/slices/multiWindowSlice';
import { debounce } from 'lodash';
import OpenSeadragon from 'openseadragon';

// temporarily disable sync functionality
const SYNC_DISABLED = true;

const useViewportSync = (viewerRef: React.MutableRefObject<OpenSeadragon.Viewer | null>) => {
  const dispatch = useDispatch();
  const { activeWindow, syncCoordinates, windows } = useSelector((state: RootState) => state.multiWindow);
  const currentWindow = windows[activeWindow];
  
  const isUpdatingFromSync = useRef(false);
  const lastSyncUpdate = useRef(0);

  // Function to get current viewport coordinates
  const getCurrentViewportCoordinates = useCallback(() => {
    if (!viewerRef.current) return null;
    
    const viewport = viewerRef.current.viewport;
    const center = viewport.getCenter();
    const zoom = viewport.getZoom();
    
    return {
      x: center.x,
      y: center.y,
      zoom: zoom
    };
  }, [viewerRef]);

  // Function to set viewport coordinates
  const setViewportCoordinates = useCallback((coordinates: { x: number; y: number; zoom: number }) => {
    if (!viewerRef.current) return;
    
    isUpdatingFromSync.current = true;
    
    const viewport = viewerRef.current.viewport;
    const center = new OpenSeadragon.Point(coordinates.x, coordinates.y);
    
    // Use immediately=true to avoid animation conflicts
    viewport.panTo(center, true);
    viewport.zoomTo(coordinates.zoom, center, true);
    
    // Reset flag after a short delay to allow for the update to complete
    setTimeout(() => {
      isUpdatingFromSync.current = false;
    }, 100);
  }, [viewerRef]);

  // Debounced function to update window viewport in Redux
  const updateWindowViewportDebounced = useCallback(
    debounce((windowId: number, coordinates: { x: number; y: number; zoom: number }) => {
      // if sync is disabled, do not update viewport
      if (SYNC_DISABLED) return;
      dispatch(updateWindowViewport({ windowId, coordinates }));
    }, 200),
    [dispatch]
  );

  // Handler for viewport changes
  const handleViewportChange = useCallback(() => {
    // if sync is disabled, skip all viewport updates
    if (SYNC_DISABLED) return;
    
    // Skip if this change is from a sync operation
    if (isUpdatingFromSync.current) return;
    
    const coordinates = getCurrentViewportCoordinates();
    if (coordinates) {
      updateWindowViewportDebounced(activeWindow, coordinates);
    }
  }, [getCurrentViewportCoordinates, activeWindow, updateWindowViewportDebounced]);

  // Effect to set up viewport change listeners
  useEffect(() => {
    // if sync is disabled, do not set any listeners
    if (SYNC_DISABLED || !viewerRef.current) return;

    const viewer = viewerRef.current;
    const debouncedHandler = debounce(handleViewportChange, 500); // Increased delay

    // Listen to various viewport events
    viewer.addHandler('animation-finish', debouncedHandler);
    viewer.addHandler('update-viewport', debouncedHandler);
    viewer.addHandler('pan', debouncedHandler);
    viewer.addHandler('zoom', debouncedHandler);

    return () => {
      viewer.removeHandler('animation-finish', debouncedHandler);
      viewer.removeHandler('update-viewport', debouncedHandler);
      viewer.removeHandler('pan', debouncedHandler);
      viewer.removeHandler('zoom', debouncedHandler);
      debouncedHandler.cancel();
    };
  }, [viewerRef.current, handleViewportChange]);

  // Effect to sync viewport when active window changes
  useEffect(() => {
    // if sync is disabled, skip viewport sync when active window changes
    if (SYNC_DISABLED || !viewerRef.current || !currentWindow) return;
    
    const coordinates = currentWindow.viewportCoordinates;
    if (coordinates.x !== 0 || coordinates.y !== 0 || coordinates.zoom !== 1) {
      setViewportCoordinates(coordinates);
    }
  }, [activeWindow, currentWindow, setViewportCoordinates, viewerRef]);

  // Effect to handle sync coordinates functionality
  useEffect(() => {
    // if sync is disabled, skip all sync logic
    if (SYNC_DISABLED || !syncCoordinates || !viewerRef.current) return;

    // Listen for changes in other windows' viewport coordinates
    const currentCoordinates = currentWindow?.viewportCoordinates;
    if (!currentCoordinates) return;

    // Check if any other window has more recent coordinates
    const otherWindows = Object.values(windows).filter(w => w.id !== activeWindow);
    let mostRecentUpdate = { window: null as any, coordinates: null as any };
    
    otherWindows.forEach(window => {
      const coords = window.viewportCoordinates;
      if (coords && (coords.x !== 0 || coords.y !== 0 || coords.zoom !== 1)) {
        // Simple heuristic: if coordinates are different from current, it might be newer
        if (coords.x !== currentCoordinates.x || 
            coords.y !== currentCoordinates.y || 
            coords.zoom !== currentCoordinates.zoom) {
          mostRecentUpdate = { window, coordinates: coords };
        }
      }
    });

    // If we found a more recent update from another window, sync to it
    if (mostRecentUpdate.coordinates && Date.now() - lastSyncUpdate.current > 500) {
      const currentViewport = getCurrentViewportCoordinates();
      if (currentViewport) {
        const { x, y, zoom } = mostRecentUpdate.coordinates;
        // Only sync if coordinates are significantly different to avoid sync loops
        const threshold = 0.001;
        if (Math.abs(currentViewport.x - x) > threshold ||
            Math.abs(currentViewport.y - y) > threshold ||
            Math.abs(currentViewport.zoom - zoom) > threshold) {
          setViewportCoordinates(mostRecentUpdate.coordinates);
          lastSyncUpdate.current = Date.now();
        }
      }
    }
  }, [windows, activeWindow, currentWindow, syncCoordinates, getCurrentViewportCoordinates, setViewportCoordinates]);

  return {
    getCurrentViewportCoordinates,
    setViewportCoordinates
  };
};

export default useViewportSync;