import { useEffect, useRef } from 'react';
import OpenSeadragon from "openseadragon";

interface UseOpenSeadragonGesturesProps {
  viewerRef: any;
  annotatorInstance: any;
  zoomSpeed: number;
  trackpadGesture: boolean;
  setMousePos: (pos: { x: number; y: number }) => void;
  setImageBounds: (bounds: { x1: number; y1: number; x2: number; y2: number }) => void;
  setMagnification: (magnification: number) => void;
}

const ZOOM_SCALE = 16;

export const useOpenSeadragonGestures = ({
  viewerRef,
  annotatorInstance,
  zoomSpeed,
  trackpadGesture,
  setMousePos,
  setImageBounds,
  setMagnification
}: UseOpenSeadragonGesturesProps) => {
  const trackerRef = useRef<any>(null);
  const lastWheelTimeRef = useRef<number>(0);
  const isGestureActiveRef = useRef<boolean>(false);

  useEffect(() => {
    if (annotatorInstance && viewerRef.current) {
      const viewer = viewerRef.current;

      // Enhanced touch and mouse gesture handling
      // Reference: https://github.com/mdn/dom-examples/blob/main/touchevents/Multi-touch_interaction.html

      // Enhanced wheel event handler based on MDN example
      const handleWheel = (event: WheelEvent) => {
        // Prevent default only if we're handling the event
        event.preventDefault();
        event.stopPropagation();

        // Debounce wheel events to prevent rapid firing
        const now = Date.now();
        if (now - lastWheelTimeRef.current < 16) { // ~60fps
          return;
        }
        lastWheelTimeRef.current = now;

        // Mark that we're actively handling gestures
        isGestureActiveRef.current = true;
        // Set global flag to prevent viewport sync during gestures
        (window as any).__isGestureActive = true;

        if (!viewer?.container) {
          return;
        }

        // Based on MDN example: handle wheel events with original speed
        if (event.ctrlKey || !trackpadGesture) {
          // Zoom with Ctrl key (like MDN example) - using original speed
          // Use exponential scaling for more uniform zoom speed
          // Enhanced for Mac trackpad: increase base multiplier and add Mac-specific scaling
          const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
          const baseMultiplier = isMac ? 0.015 : 0.005; // 3x faster on Mac
          const macSpeedBoost = isMac ? 1.5 : 1.0; // Additional 1.5x boost for Mac
          const effectiveZoomSpeed = zoomSpeed * macSpeedBoost;
          const zoomFactor = event.deltaY > 0 ? 1 / (1 + event.deltaY * baseMultiplier * effectiveZoomSpeed) : 1 + Math.abs(event.deltaY) * baseMultiplier * effectiveZoomSpeed;
          const rect = viewer.container.getBoundingClientRect();
          const relativeX = event.clientX - rect.left;
          const relativeY = event.clientY - rect.top;
          const mousePoint = new OpenSeadragon.Point(relativeX, relativeY);
          const viewportPoint = viewer.viewport.pointFromPixel(mousePoint);
          
          // Store current state before zoom
          const beforeZoom = viewer.viewport.getZoom();
          
          // Check if zoom would be within bounds
          const expectedZoom = beforeZoom * zoomFactor;
          const minZoom = viewer.viewport.getMinZoom();
          const maxZoom = viewer.viewport.getMaxZoom();
          
          if (expectedZoom >= minZoom && expectedZoom <= maxZoom) {
            // Perform zoom only if it's within bounds
            viewer.viewport.zoomBy(zoomFactor, viewportPoint);
          }
          
          // Don't call applyConstraints() to prevent automatic reset
          // viewer.viewport.applyConstraints();
          
          // Reset gesture active flag after a longer delay to ensure all events are processed
          setTimeout(() => {
            isGestureActiveRef.current = false;
            (window as any).__isGestureActive = false;
          }, 300);
        } else if (trackpadGesture) {
          // Pan with trackpad gesture (no Ctrl key)
          const currentZoom = viewer.viewport.getZoom();
          const panSpeed = 0.001 / currentZoom; // Adjust pan speed inversely to zoom level
          
          // Perform pan
          viewer.viewport.panBy(new OpenSeadragon.Point(event.deltaX * panSpeed, event.deltaY * panSpeed));
        }
      };

      // Add event listeners based on MDN example
      
      // Remove any existing wheel event listeners to prevent conflicts
      const existingWheelListeners = viewer.element.querySelectorAll('*');
      existingWheelListeners.forEach((element: any) => {
        if (element._wheelHandler) {
          element.removeEventListener('wheel', element._wheelHandler);
        }
      });
      
      // Store reference to our handler for cleanup
      viewer.element._wheelHandler = handleWheel;
      viewer.element.addEventListener('wheel', handleWheel, { passive: false, capture: true });

      // Return cleanup function for all gesture handlers
      const cleanupGestures = () => {
        if (viewer && viewer.element) {
          viewer.element.removeEventListener('wheel', handleWheel, { capture: true });
          delete viewer.element._wheelHandler;
        }
      };

      // Create MouseTracker for all platforms
      if (viewer && viewer.container) {
        // Monitor all viewport changes to detect what's resetting zoom
        const originalZoomTo = viewer.viewport.zoomTo;
        const originalZoomBy = viewer.viewport.zoomBy;
        
        // Restore original methods
        viewer.viewport.zoomTo = originalZoomTo;
        viewer.viewport.zoomBy = originalZoomBy;
        
        trackerRef.current = new OpenSeadragon.MouseTracker({
          element: viewer.container,
          moveHandler: (event: any) => {
            const webPoint = event.position;
            const viewportPoint = viewer.viewport.pointFromPixel(webPoint);
            const imagePoint = viewer.viewport.viewportToImageCoordinates(viewportPoint);
            const scaledX = imagePoint.x / ZOOM_SCALE;
            const scaledY = imagePoint.y / ZOOM_SCALE;
            setMousePos({ x: scaledX, y: scaledY });
          }
        });

        // viewport update the image bounds and zoom
        const viewportUpdateHandler = () => {
          const bounds = viewer.viewport.getBounds();
          const topLeft = viewer.viewport.viewportToImageCoordinates(bounds.getTopLeft());
          const bottomRight = viewer.viewport.viewportToImageCoordinates(bounds.getBottomRight());

          const viewerElement = viewer.element;
          const viewerRect = viewerElement.getBoundingClientRect();

          const coordinates = {
            image: {
              x1: topLeft.x,
              y1: topLeft.y,
              x2: bottomRight.x,
              y2: bottomRight.y
            },
            screen: {
              x: viewerRect.left,
              y: viewerRect.top,
              width: viewerRect.width,
              height: viewerRect.height
            },
            dpr: window.devicePixelRatio || 1
          };

          setImageBounds({
            x1: topLeft.x,
            y1: topLeft.y,
            x2: bottomRight.x,
            y2: bottomRight.y
          });

          const zoom = viewer.viewport.getZoom();
          setMagnification(zoom);
        };
        
        viewer.addHandler('update-viewport', viewportUpdateHandler);

        // Return cleanup function for both gestures and MouseTracker
        return () => {
          cleanupGestures();
          if (trackerRef.current) {
            trackerRef.current.destroy();
            trackerRef.current = null;
          }
          // Only remove the specific viewport handler we added
          if (viewer && viewportUpdateHandler) {
            viewer.removeHandler('update-viewport', viewportUpdateHandler);
          }
        };
      }

      // Default return
      return () => {
        cleanupGestures();
      };
    }
  }, [annotatorInstance, viewerRef, zoomSpeed, trackpadGesture, setMousePos, setImageBounds, setMagnification]);

  return {
    tracker: trackerRef.current
  };
}; 