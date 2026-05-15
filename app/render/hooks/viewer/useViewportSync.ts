import { useEffect, useRef, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '@/store';
import { debounce } from 'lodash';
import OpenSeadragon from 'openseadragon';

// temporarily disable sync functionality
const SYNC_DISABLED = true;

const useViewportSync = (viewerRef: React.MutableRefObject<OpenSeadragon.Viewer | null>) => {
  const dispatch = useDispatch();
  // Viewport sync functionality is disabled, so we don't need multiWindow state
  // This hook is kept for potential future use but currently does nothing
  
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

  // Handler for viewport changes (disabled)
  const handleViewportChange = useCallback(() => {
    // Viewport sync is disabled
    return;
  }, []);

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

  // Viewport sync effects are disabled

  return {
    getCurrentViewportCoordinates,
    setViewportCoordinates
  };
};

export default useViewportSync;