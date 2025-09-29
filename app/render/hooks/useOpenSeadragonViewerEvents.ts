import { useEffect, useRef, useCallback } from 'react';
import { useSelector, useDispatch } from "react-redux";
import { RootState } from "@/store";
import { setAnnotations } from "@/store/slices/annotationSlice"
import { debounce } from 'lodash';
import { setCurrentViewerCoordinates } from '@/store/slices/viewerSlice';

const useOpenSeadragonViewerEvents = (
  viewerInstance: any, annotatorInstance: any, socket: WebSocket | null, status: any,
  updateCentroids: (centroids: any[]) => void,
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
  const currentAnnotationLevel = useRef<string | null>(null)
  const annotationTypeMap = useSelector((state: RootState) => state.annotations.annotationTypeMap);
  const prevLevelRef = useRef<number | null>(null);

  // Get current path for file type checking
  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const currentPathRef = useRef(currentPath);

  const isOnqueryRef = useRef(false);

  const classificationEnabled = useSelector(
    (state: RootState) => state.annotations.classificationEnabled
  );
  const classificationEnabledRef = useRef(classificationEnabled);

  const lastFilterStateRef = useRef<string>('');

  const pendingUpdateRef = useRef<(() => void) | null>(null);

  const lastUpdateTimeRef = useRef<number>(0);
  const lastRequestCoordsRef = useRef<string>('');
  const lastPatchesCoordsRef = useRef<string>('');
  const lastDispatchedCoordsRef = useRef<string>('');

  const polygon_threshold = useSelector((state: RootState) => state.annotations.polygon_threshold);

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
    classificationEnabledRef.current = classificationEnabled;
    // console.log("[Event hooks] use effect now is ", classificationEnabledRef.current)
  }, [classificationEnabled]);

  useEffect(() => {
    if (viewerInstance) {
      const getVisibleImageCoordinates = (viewer: any) => {
        const viewportBounds = viewer.viewport.getBounds();
        const topLeft = viewer.viewport.viewportToImageCoordinates(viewportBounds.getTopLeft());
        const bottomRight = viewer.viewport.viewportToImageCoordinates(viewportBounds.getBottomRight());
        // Get the viewer element's bounding rectangle
        const viewerElement = viewer.element;
        const viewerRect = viewerElement.getBoundingClientRect();
        // Get the device pixel ratio (for HiDPI screens)
        const dpr = 1;
        // Get the screen coordinates of the viewer
        const screenX = Math.round((window.screenLeft + viewerRect.left) * dpr);
        const screenY = Math.round((window.screenTop + viewerRect.top) * dpr);
        const scale = 16;
        // console.log(window.screenLeft, window.screenTop, viewerRect.left, viewerRect.top);

        return {
          image: {
            x1: Math.round(topLeft.x / scale),
            y1: Math.round(topLeft.y / scale),
            x2: Math.round(bottomRight.x / scale),
            y2: Math.round(bottomRight.y / scale)
          },
          screen: {
            x: screenX,
            y: screenY,
            width: Math.round(viewerRect.width * dpr),
            height: Math.round(viewerRect.height * dpr)
          },
          dpr: dpr
        };
      };

      // Wrap the pendingUpdateRef.current function with throttle
      pendingUpdateRef.current = () => {
        if (!viewerInstance || isOnqueryRef.current) {
          return;
        }

        // Add throttling to prevent excessive requests
        const now = Date.now();
        if (now - lastUpdateTimeRef.current < 500) { // Minimum 500ms between requests
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
        const isAboveThreshold = zoom >= threshold;
        const isAbovePolygonThreshold = zoom >= polygon_threshold;

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
          if (!isImageFile) {
            // Only apply zoom-level based clearing for non-image files
            if ((isAboveThreshold && prevLevelRef.current < threshold)) {
              // from below threshold to above threshold - switch from centroids to annotations
              console.log('Zoomed in beyond threshold.');
              updateCentroids([]); // clean overlay
            } else if (!isAboveThreshold && prevLevelRef.current >= threshold) {
              // from above threshold to below threshold - switch from annotations to centroids

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
                annotatorInstance.addAnnotation(annotation);
              });

              console.log('Cleared backend annotations, user annotations remain.');

              // clear annotations on the backend
              if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'clear_annotations' }));
                console.log('Zoomed out below threshold. Clearing annotations and notifying backend.');
              }
            }
          } else {
            console.log('Image file detected - skipping threshold-based clearing of annotations');
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

        // Prioritize file type over zoom level for request type decision
        if (isImageFile && showBackendAnnotations && !annotationsRequestedRef.current) {
          // For image files (PNG/JPEG/BMP), always request annotations regardless of zoom level
          updateCentroids([]); // Clear any existing centroids
          sendCoordinates(
            {
              x1, y1, x2, y2,
              type: 'annotations',
              use_classification: classificationEnabledRef.current
            },
            'Requesting annotations for image file viewport.'
          );
          // only request annotations once for image files
          annotationsRequestedRef.current = true;
          lastRequestCoordsRef.current = coordSignature;
          return;
        }
        // For non-image files, follow the original zoom-based logic
        if (isAboveThreshold) {
          // High zoom level - request annotations if enabled
          updateCentroids([]);
          updateRenderingAnnotations([]);
          if (showBackendAnnotations && lastRequestCoordsRef.current !== coordSignature) {
            sendCoordinates(
              {
                x1, y1, x2, y2,
                type: 'annotations',
                use_classification: classificationEnabledRef.current
              },
              'Requesting annotations for current viewport.'
            );
            lastRequestCoordsRef.current = coordSignature;
          } else if (!showBackendAnnotations) {
            // No request when annotations are hidden
          }
        }
        else if (isAbovePolygonThreshold && !isAboveThreshold) {
          updateCentroids([]);
          if (showBackendAnnotations && lastRequestCoordsRef.current !== coordSignature) {
            sendCoordinates(
              {
                x1, y1, x2, y2,
                type: 'all_annotations',
                use_classification: classificationEnabledRef.current
              },
              'Requesting all annotations.'
            );
            lastRequestCoordsRef.current = coordSignature;
          }
        }
        else if (!isAbovePolygonThreshold && !isAboveThreshold) {
          updateRenderingAnnotations([]);
          if (showBackendAnnotations && lastRequestCoordsRef.current !== coordSignature) {
            // Low zoom level on non-image files - request centroids
            sendCoordinates(
              { ...coordinates.image, type: 'centroids' },
              'Requesting centroids for current viewport.'
            );
            lastRequestCoordsRef.current = coordSignature;
          }
        }

        // Request patches when showPatches is enabled (at all zoom levels)
        if (showPatches && lastPatchesCoordsRef.current !== coordSignature) {
          sendCoordinates(
            { ...coordinates.image, type: 'patches' },
            'Requesting patches for current viewport.'
          );
          lastPatchesCoordsRef.current = coordSignature;
        }

        // set the flag to true
        isOnqueryRef.current = true;
        // Apply filter only when conditions change
        if (annotatorInstance) {
          // Include isImageFile in the filter state key
          const filterState = `${isAboveThreshold}-${showUserAnnotations}-${showBackendAnnotations}-${isImageFile}`;

          if (lastFilterStateRef.current !== filterState) {
            console.log('Rerendering annotations');

            annotatorInstance.setFilter((anno: { isBackend: any; }) => {
              // For image files, ignore threshold-based filtering
              if (isImageFile) {
                // Only apply basic visibility filters for image files
                if (!showUserAnnotations && !anno.isBackend) return false;
                if (!showBackendAnnotations && anno.isBackend) return false;
                return true;
              }

              // For non-image files, apply the original threshold-based filter
              if (anno.isBackend && !isAboveThreshold) {
                return false;
              }

              // Normal visibility filters
              if (!showUserAnnotations && !anno.isBackend) return false;
              if (!showBackendAnnotations && anno.isBackend) return false;

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
          var imagePoint = viewerInstance.viewport.viewportToImageCoordinates(viewportPoint);
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
  }, [status, socket, sendCoordinates,
    updateCentroids, showBackendAnnotations, showUserAnnotations,
    renderingAnnotations, updateRenderingAnnotations]);

  useEffect(() => {
    // @ts-ignore
    if (viewerInstance) {
      const handleUpdateViewport = debounce(() => {
        requestAnimationFrame(() => {
          if (pendingUpdateRef.current) {
            pendingUpdateRef.current();
            pendingUpdateRef.current = null;
            isOnqueryRef.current = false;
          }
        });
      }, 200, { leading: false, trailing: true }); // Increased debounce delay from 200ms to 500ms
      viewerInstance.addHandler('update-viewport', handleUpdateViewport);
      
      // Return cleanup function
      return () => {
        if (viewerInstance) {
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
