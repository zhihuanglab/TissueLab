import { useEffect, useRef, useCallback } from 'react';
import { useSelector, useDispatch } from "react-redux";
import { RootState } from "@/store";
import { setAnnotations } from "@/store/slices/viewer/annotationSlice"
import { debounce } from 'lodash';
import { setCurrentViewerCoordinates } from '@/store/slices/viewer/viewerSlice';
import { CentroidsArray } from '@/components/imageViewer/CentroidsArray';
import { ensureValidAnnotation } from '@/utils/annotationUtils';

// Empty CentroidsArray constant for reuse
const EMPTY_CENTROIDS = new CentroidsArray(new Int32Array(0), 0);

const useOpenSeadragonViewerEvents = (
  viewerInstance: any, annotatorInstance: any, socket: WebSocket | null, status: any,
  instanceId: string | null | undefined,
  updateCentroids: (centroids: CentroidsArray) => void,
  showBackendAnnotations: boolean,
  showUserAnnotations: boolean,
  showPatches: boolean,
  setLoadingAnnotations: (loading: boolean) => void,
  renderingAnnotations: any[],
  updateRenderingAnnotations: (annotations: any[]) => void
) => {
  const dispatch = useDispatch();
  const thresholdData = useSelector((state: RootState) => state.annotations.threshold)
  const thresholdDataRef = useRef(thresholdData)
  const centroidThresholdFromSettings = useSelector((state: RootState) => state.viewerSettings.centroidThreshold)
  const centroidThresholdRef = useRef(centroidThresholdFromSettings)
  const currentAnnotationLevel = useRef<string | null>(null)
  const prevLevelRef = useRef<number | null>(null);

  // Get current path for file type checking
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const currentPathRef = useRef(currentPath);

  const isOnqueryRef = useRef(false);

  const classificationEnabled = useSelector(
    (state: RootState) => state.annotations.classificationEnabled
  );
  const classificationEnabledRef = useRef(classificationEnabled);

  const currentTool = useSelector((state: RootState) => state.tool.currentTool);

  const lastFilterStateRef = useRef<string>('');

  const pendingUpdateRef = useRef<(() => void) | null>(null);

  const lastUpdateTimeRef = useRef<number>(0);
  const lastRequestCoordsRef = useRef<string>('');
  const lastPatchesCoordsRef = useRef<string>('');
  const lastDispatchedCoordsRef = useRef<string>('');

  const annotationsRequestedRef = useRef(false);

  // Update currentPath reference
  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  const sendCoordinates = useCallback(
    (coordinates: any | any[], logMessage?: string | string[]) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        if (Array.isArray(coordinates)) {
          coordinates.forEach((coord, index) => {
            const message = JSON.stringify(coord);
            if (Array.isArray(logMessage) && logMessage[index]) {
              console.log(logMessage[index]);
            }
            socket.send(message);
            setLoadingAnnotations(true);
          });
        } else {
          const message = JSON.stringify(coordinates);
          if (logMessage && typeof logMessage === 'string') {
            console.log(logMessage);
          }
          socket.send(message);
          if (coordinates.type === 'annotations') return; // Don't set loading for annotations
          setLoadingAnnotations(true);
        }
      } else {
        console.warn("WebSocket is not open.");
      }
    }, [socket]);


  useEffect(() => {
    thresholdDataRef.current = thresholdData
  }, [thresholdData])

  useEffect(() => {
    centroidThresholdRef.current = centroidThresholdFromSettings
  }, [centroidThresholdFromSettings])

  useEffect(() => {
    classificationEnabledRef.current = classificationEnabled;
    // console.log("[Event hooks] use effect now is ", classificationEnabledRef.current)
  }, [classificationEnabled]);

  useEffect(() => {
    if (viewerInstance) {
      const getVisibleImageCoordinates = (viewer: any) => {
        const viewportBounds = viewer.viewport.getBounds();
        const tiledImage = viewer.world.getItemAt(0);
        const topLeft = tiledImage ? tiledImage.viewportToImageCoordinates(viewportBounds.getTopLeft()) : viewer.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
        const bottomRight = tiledImage ? tiledImage.viewportToImageCoordinates(viewportBounds.getBottomRight()) : viewer.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());
        // Get the viewer element's bounding rectangle
        const viewerElement = viewer.element;
        const viewerRect = viewerElement.getBoundingClientRect();
        // Get the device pixel ratio (for HiDPI screens)
        const dpr = 1;
        // Get the screen coordinates of the viewer
        const screenX = Math.round((window.screenLeft + viewerRect.left) * dpr);
        const screenY = Math.round((window.screenTop + viewerRect.top) * dpr);
        // Get the current rotation angle in degrees
        // @ts-ignore - getRotation supports current parameter but types are incomplete
        const rotation = viewer.viewport.getRotation(true) || 0;

        return {
          image: {
            x1: Math.round(topLeft.x),
            y1: Math.round(topLeft.y),
            x2: Math.round(bottomRight.x),
            y2: Math.round(bottomRight.y),
          },
          screen: {
            x: screenX,
            y: screenY,
            width: Math.round(viewerRect.width * dpr),
            height: Math.round(viewerRect.height * dpr)
          },
          dpr: dpr,
          rotation: rotation  // Add rotation angle in degrees (0, 30, 60, 90, ..., 360)
        };
      };

      // Wrap the pendingUpdateRef.current function with throttle
      pendingUpdateRef.current = () => {
        if (!viewerInstance || isOnqueryRef.current) {
          return;
        }

        // Add throttling to prevent excessive requests
        const now = Date.now();
        if (now - lastUpdateTimeRef.current < 200) { // Minimum 200ms between requests (5Hz)
          return;
        }
        lastUpdateTimeRef.current = now;

        const coordinates = getVisibleImageCoordinates(viewerInstance);
        const dataPoint = {
          timestamp: new Date().toISOString(),
          coordinates: coordinates
        };

        // send to websocket channel
        const zoom = viewerInstance.viewport.getZoom();
        const maxZoom = viewerInstance.viewport.getMaxZoom();
        const minZoom = viewerInstance.viewport.getMinZoom();

        // Assuming 0 to 8 levels, calculate the current level
        const maxLevel = 8;
        const level = Math.round(((zoom - minZoom) / (maxZoom - minZoom)) * maxLevel);

        // console.log(level, zoom, maxZoom, minZoom, maxLevel);

        const threshold = thresholdDataRef.current;
        const centroidThresholdValue = centroidThresholdRef.current;
        const isAboveThreshold = zoom >= threshold;
        const isAboveCentroidThreshold = zoom >= centroidThresholdValue;

        // console.log(`Level: ${level}, Threshold: ${thresholdDataRef.current}, CurrentAnnotationLevel: ${currentAnnotationLevel.current}`);
        // check if the current level is different from the previous level
        if (prevLevelRef.current !== null && level !== prevLevelRef.current) {
          // Check if the current file is an image file (png/jpeg/bmp)
          const path = currentPathRef.current;
          const isImageFile = path &&
            (path.toLowerCase().endsWith('.png') ||
              path.toLowerCase().endsWith('.jpg') ||
              path.toLowerCase().endsWith('.jpeg') ||
              path.toLowerCase().endsWith('.bmp'));

          // Skip threshold-based clearing for image files
            // Only apply zoom-level based clearing for non-image files
            if ((isAboveCentroidThreshold && prevLevelRef.current < centroidThresholdValue)) {
              // from below centroid threshold to above centroid threshold - switch from centroids to annotations
              console.log('Zoomed in beyond centroid threshold.');
              updateCentroids(EMPTY_CENTROIDS); // clean overlay
            } else if (!isAboveCentroidThreshold && prevLevelRef.current >= centroidThresholdValue) {
              // from above centroid threshold to below centroid threshold - switch from annotations to centroids

              // get all annotations
              const allAnnotations = annotatorInstance.getAnnotations();
              const userAnnotations = allAnnotations.filter(
                (annotation: { isBackend: any }) => !annotation.isBackend
              );

              // clean all annotations
              annotatorInstance.setAnnotations([], true);
              dispatch(setAnnotations([]));

              // add user annotations back
              userAnnotations.forEach((annotation: any) => {
                const validAnnotation = ensureValidAnnotation(annotation);
                annotatorInstance.addAnnotation(validAnnotation);
              });

              console.log('Cleared backend annotations, user annotations remain.');

              // clear annotations on the backend
              if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'clear_annotations' }));
                console.log('Zoomed out below threshold. Clearing annotations and notifying backend.');
              }
            }
        }

        // update the current Threshold level
        prevLevelRef.current = zoom;

        const { x1, y1, x2, y2 } = coordinates.image;

        // Create a coordinate signature to check for duplicate requests
        const coordSignature = `${x1},${y1},${x2},${y2}`;

        // Only dispatch viewer coordinates when changed to avoid unnecessary rerenders
        if (lastDispatchedCoordsRef.current !== coordSignature) {
          dispatch(setCurrentViewerCoordinates(dataPoint.coordinates));
          lastDispatchedCoordsRef.current = coordSignature;
        }

        // Check if the current file is an image file (png/jpeg/bmp)
        const path = currentPathRef.current;
        const isImageFile = path &&
          (path.toLowerCase().endsWith('.png') ||
            path.toLowerCase().endsWith('.jpg') ||
            path.toLowerCase().endsWith('.jpeg') ||
            path.toLowerCase().endsWith('.bmp'));

        // // Prioritize file type over zoom level for request type decision
        // if (isImageFile && showBackendAnnotations && !annotationsRequestedRef.current) {
        //   // For image files (PNG/JPEG/BMP), always request annotations regardless of zoom level
        //   updateCentroids(EMPTY_CENTROIDS); // Clear any existing centroids
        //   sendCoordinates(
        //     {
        //       x1, y1, x2, y2,
        //       type: 'annotations',
        //       use_classification: classificationEnabledRef.current
        //     },
        //     'Requesting annotations for image file viewport.'
        //   );
        //   // only request annotations once for image files
        //   annotationsRequestedRef.current = true;
        //   lastRequestCoordsRef.current = coordSignature;
        //   return;
        // }
        // For non-image files, follow the original zoom-based logic
        // if (isAboveThreshold) {
        //   // High zoom level - request simple data instead of annotations
        //   updateCentroids(EMPTY_CENTROIDS);
        //   updateRenderingAnnotations([]);
        //   if (showBackendAnnotations && lastRequestCoordsRef.current !== coordSignature) {
        //     sendCoordinates(
        //       {
        //         x1, y1, x2, y2,
        //         type: 'all_annotations',
        //         use_classification: classificationEnabledRef.current
        //       },
        //       'Requesting annotations for current viewport.'
        //     );
        //     lastRequestCoordsRef.current = coordSignature;
        //   } else if (!showBackendAnnotations) {
        //     // No request when annotations are hidden
        //   }
        const needOverlayData = showBackendAnnotations || currentTool === 'filter';
        if (isImageFile || isAboveCentroidThreshold) {
          updateCentroids(EMPTY_CENTROIDS);
          if (needOverlayData && lastRequestCoordsRef.current !== coordSignature) {
            sendCoordinates(
              {
                x1, y1, x2, y2,
                type: 'all_annotations',
                use_classification: classificationEnabledRef.current,
                instance_id: instanceId,
              },
              'Requesting all annotations.'
            );
            lastRequestCoordsRef.current = coordSignature;
          }
        }
        else if (!isAboveCentroidThreshold) {
          updateRenderingAnnotations([]);
          if (needOverlayData && lastRequestCoordsRef.current !== coordSignature) {
            // Low zoom level on non-image files - request centroids
            sendCoordinates(
              { ...coordinates.image, type: 'centroids', instance_id: instanceId },
              'Requesting centroids for current viewport.'
            );
            lastRequestCoordsRef.current = coordSignature;
          }
        }

        // Request patches when showPatches is enabled (at all zoom levels)
        if (showPatches && lastPatchesCoordsRef.current !== coordSignature) {
          sendCoordinates(
            { ...coordinates.image, type: 'patches', instance_id: instanceId },
            'Requesting patches for current viewport.'
          );
          lastPatchesCoordsRef.current = coordSignature;
        }

        // set the flag to true
        isOnqueryRef.current = true;
        // Apply filter only when conditions change
        if (annotatorInstance) {
          // Include isImageFile in the filter state key
          // Simplified filter state - no longer using zoom level or backend annotation filtering
          const filterState = `${showUserAnnotations}`;

          if (lastFilterStateRef.current !== filterState) {
            console.log('Rerendering annotations');

            annotatorInstance.setFilter((anno: { isBackend: any; }) => {
              // Completely disable backend annotations in annotorious - only use DrawingOverlay
              // Always filter out backend annotations from annotorious, regardless of file type or zoom level
              if (anno.isBackend) {
                return false; // Never show backend annotations in annotorious
              }

              // Only show user-created annotations in annotorious
              if (!showUserAnnotations && !anno.isBackend) return false;

              return true;
            });

            lastFilterStateRef.current = filterState;
          }
        }
      }; // Adjust the delay as needed

      // @ts-ignore
      viewerInstance.addHandler('canvas-enter', function (event) {
        if (viewerInstance) {
          var webPoint = event.position;
          // @ts-ignore
          var viewportPoint = viewerInstance.viewport.pointFromPixel(webPoint);
          // @ts-ignore
          var tiledImage = viewerInstance.world.getItemAt(0);
          // @ts-ignore
          var imagePoint = tiledImage ? tiledImage.viewportToImageCoordinates(viewportPoint) : viewerInstance.viewport.viewportToImageCoordinates(viewportPoint);
        }
      })

      // Comment out the MouseTracker creation, it conflicts with the MouseTracker in the main component
      // const timer = setInterval(() => {
      //     if (viewerRef.current && viewerRef.current.container) {
      //         new OpenSeadragon.MouseTracker({
      //             element: viewerRef.current.container,
      //             // @ts-ignore
      //             moveHandler: function(event: { position: any }) {
      //                 if (viewerRef.current) {
      //                     const webPoint = event.position;
      //                     const viewportPoint = viewerRef.current.viewport.pointFromPixel(webPoint);
      //                     const imagePoint = viewerRef.current.viewport.viewportToImageCoordinates(viewportPoint);
      //                 }
      //             }
      //         });
      //         clearInterval(timer);
      //     }
      // }, 100);

      return () => {
        // clearInterval(timer)
      };
    }
  }, [status, socket, sendCoordinates, instanceId,
    updateCentroids, showBackendAnnotations, showUserAnnotations,
    showPatches, renderingAnnotations, updateRenderingAnnotations, currentTool, annotatorInstance]);

  // When switching to filter tool, trigger one viewport request so overlay data loads even if overlay was never on
  useEffect(() => {
    if (currentTool !== 'filter' || !viewerInstance) return;
    const t = setTimeout(() => {
      if (pendingUpdateRef.current) {
        pendingUpdateRef.current();
        pendingUpdateRef.current = null;
        isOnqueryRef.current = false;
      }
    }, 120);
    return () => clearTimeout(t);
  }, [currentTool, viewerInstance]);

  useEffect(() => {
    // @ts-ignore
    if (viewerInstance) {
      // Track viewport state to detect significant changes
      let lastViewportState = {
        zoom: viewerInstance.viewport?.getZoom?.() || 0,
        centerX: viewerInstance.viewport?.getCenter?.()?.x || 0,
        centerY: viewerInstance.viewport?.getCenter?.()?.y || 0,
      };

      // Clear pending tile requests when viewport changes significantly
      // This cancels outdated tile requests for tiles no longer in view
      const handleViewportChangeStart = () => {
        if (!viewerInstance?.viewport || !viewerInstance?.imageLoader) return;

        const currentZoom = viewerInstance.viewport.getZoom();
        const currentCenter = viewerInstance.viewport.getCenter();

        // Calculate change magnitude
        const zoomChange = Math.abs(currentZoom - lastViewportState.zoom) / Math.max(lastViewportState.zoom, 0.001);
        const panChangeX = Math.abs(currentCenter.x - lastViewportState.centerX);
        const panChangeY = Math.abs(currentCenter.y - lastViewportState.centerY);
        const panChange = Math.sqrt(panChangeX * panChangeX + panChangeY * panChangeY);

        // Clear pending requests if there's significant viewport change
        // Zoom change > 10% or pan change > 0.1 viewport units
        if (zoomChange > 0.1 || panChange > 0.1) {
          viewerInstance.imageLoader.clear();
        }

        // Update last viewport state
        lastViewportState = {
          zoom: currentZoom,
          centerX: currentCenter.x,
          centerY: currentCenter.y,
        };
      };

      const handleUpdateViewport = debounce(() => {
        requestAnimationFrame(() => {
          if (pendingUpdateRef.current) {
            pendingUpdateRef.current();
            pendingUpdateRef.current = null;
            isOnqueryRef.current = false;
          }
        });
      }, 50, { leading: false, trailing: true }); // 50ms debounce for behavior logging

      // Add handler that runs immediately on viewport change (not debounced)
      // to clear outdated tile requests early
      viewerInstance.addHandler('viewport-change', handleViewportChangeStart);
      viewerInstance.addHandler('update-viewport', handleUpdateViewport);

      // Return cleanup function
      return () => {
        if (viewerInstance) {
          viewerInstance.removeHandler('viewport-change', handleViewportChangeStart);
          viewerInstance.removeHandler('update-viewport', handleUpdateViewport);
        }
      };
    }
  }, [viewerInstance]); // Now we can safely include viewerInstance as a dependency

  // Cleanup
  useEffect(() => {
    return () => {
      pendingUpdateRef.current = null;
    };
  }, []);

  // Return a function to reset the query flag
  const resetQueryFlag = useCallback(() => {
    isOnqueryRef.current = false;
  }, []);

  return { resetQueryFlag };
}

export default useOpenSeadragonViewerEvents;
