import { useRef, useCallback, useEffect } from 'react';
import { useSelector, useStore, useDispatch } from 'react-redux';
import { RootState } from '@/store';
import { clearTranscript } from '@/store/slices/viewer/recordingTranscriptSlice';
import pako from 'pako';
import { useUserInfo } from '@/provider/UserInfoProvider';
import OpenSeadragon from 'openseadragon';
import Cookies from 'js-cookie';
import { toast } from 'sonner';
import {
  CTRL_SERVICE_API_ENDPOINT,
  DEBUG_ENV,
  ENABLE_BEHAVIOR_VIEW_ACT_LOGGING,
} from '@/constants/config';

/**
 * Data types for view-action logging
 */
interface MouseData {
  type: 'mouse';
  timestamp: number;
  screen: {
    x: number;  // Screen coordinates
    y: number;
  };
  image?: {
    x: number;  // Image coordinates (if viewer available)
    y: number;
  };
}

interface ViewportData {
  type: 'viewport';
  timestamp: number;
  image: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
  screen: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  dpr: number;
  rotation?: number; // Rotation angle in degrees (0, 30, 60, 90, ..., 360)
}

type ViewActionData = MouseData | ViewportData;

interface ViewActLoggerOptions {
  viewerRef?: React.MutableRefObject<any>;  // OpenSeadragon viewer ref for coordinate conversion
  enableMouseTracking?: boolean;  // Default true
  enableViewportTracking?: boolean;  // Default true
}

interface SessionMetadata {
  sessionId: string;
  imageFile: string;
  imageName: string;
  imageInfo?: {
    width: number;   // Full image width
    height: number;  // Full image height
    tileSize: number;
    format: string;  // e.g., "svs", "tif"
  };
  startTime: number;
  endTime?: number;
  durationSeconds?: number;
  hasMouseTracking: boolean;
  hasViewportTracking: boolean;
}

/**
 * Core view-action logger hook
 *
 * Usage in main branch (mouse + viewport only):
 * ```
 * const logger = useViewActLogger();
 * logger.startSession('/path/to/image.svs');
 * // ... user views image
 * await logger.endSession();
 * ```
 */
export function useViewActLogger(options?: ViewActLoggerOptions) {
  const store = useStore<RootState>();
  const dispatch = useDispatch();
  // Options with defaults
  const enableMouseTracking = options?.enableMouseTracking ?? true;
  const enableViewportTracking = options?.enableViewportTracking ?? true;
  const viewerRef = options?.viewerRef;

  // Get authenticated user ID from UserInfoProvider (same as avatar API)
  const { userInfo } = useUserInfo();
  
  // In development mode, use a test user ID if not authenticated
  const userId = userInfo?.user_id || (process.env.NODE_ENV === 'development' ? 'dev_user' : null);

  // Session state
  const sessionRef = useRef<SessionMetadata | null>(null);
  const isRecordingRef = useRef(false);

  // Data buffers
  const mouseDataRef = useRef<MouseData[]>([]);
  const viewportDataRef = useRef<ViewportData[]>([]);

  // Mouse tracking state
  const lastMouseLogTimeRef = useRef(0);
  const mouseFrequencyHz = Number(process.env.NEXT_PUBLIC_MOUSE_TRACKING_HZ) || 10;
  const mouseThrottleMs = 1000 / mouseFrequencyHz;

  // Viewport tracking
  const currentViewerCoordinates = useSelector(
    (state: RootState) => state.viewer.currentViewerCoordinates
  );
  const lastViewportRef = useRef<ViewportData | null>(null);
  const lastViewportLogTimeRef = useRef(0);
  const viewportFrequencyHz = Number(process.env.NEXT_PUBLIC_VIEWPORT_TRACKING_HZ) || 5;
  const viewportThrottleMs = 1000 / viewportFrequencyHz;
  const imageInfoCaptured = useRef(false); // Track if imageInfo has been captured

  // Development mode flag & console logs config
  const isDevelopment = process.env.NODE_ENV === 'development';
  const enableConsoleLogs = process.env.NEXT_PUBLIC_ENABLE_VIEWACT_CONSOLE_LOGS === 'true';

  /**
   * Capture image info from viewer (lazy initialization)
   */
  const captureImageInfo = useCallback(() => {
    if (imageInfoCaptured.current || !sessionRef.current || !viewerRef?.current) return;

    try {
      const viewer = viewerRef.current;
      const tiledImage = viewer.world.getItemAt(0);
      if (tiledImage) {
        const source = tiledImage.source;
        const format = sessionRef.current.imageName.split('.').pop()?.toLowerCase() || 'unknown';
        sessionRef.current.imageInfo = {
          width: source.dimensions.x,
          height: source.dimensions.y,
          tileSize: source.tileSize || 256,
          format: format,
        };
        imageInfoCaptured.current = true;
        if (enableConsoleLogs) {
          console.log('[ViewActLogger] Captured imageInfo (lazy):', sessionRef.current.imageInfo);
        }
      }
    } catch (error) {
      if (enableConsoleLogs) {
        console.warn('[ViewActLogger] Failed to capture image info (lazy):', error);
      }
    }
  }, [viewerRef, enableConsoleLogs]);

  /**
   * Log mouse movement (throttled, frequency configurable via NEXT_PUBLIC_MOUSE_TRACKING_HZ)
   */
  const logMouseMovement = useCallback((event: MouseEvent) => {
    if (!isRecordingRef.current || !enableMouseTracking) return;

    const now = Date.now();
    if (now - lastMouseLogTimeRef.current < mouseThrottleMs) return;
    lastMouseLogTimeRef.current = now;

    // Capture imageInfo on first mouse event (lazy initialization)
    captureImageInfo();

    const mouseData: MouseData = {
      type: 'mouse',
      timestamp: now,
      screen: {
        x: event.clientX,
        y: event.clientY,
      },
    };

    // Convert screen coordinates to image coordinates if viewer is available
    if (viewerRef?.current) {
      try {
        const viewer = viewerRef.current;
        const viewerElement = viewer.element;
        const rect = viewerElement.getBoundingClientRect();

        // Calculate position relative to viewer element
        const relativeX = event.clientX - rect.left;
        const relativeY = event.clientY - rect.top;

        // Convert to viewport coordinates
        const viewportPoint = viewer.viewport.pointFromPixel(
          new OpenSeadragon.Point(relativeX, relativeY)
        );

        const imagePoint = viewer.viewport.viewportToImageCoordinates(viewportPoint);
        mouseData.image = {
          x: Math.round(imagePoint.x),
          y: Math.round(imagePoint.y),
        };

        // Debug: Log first mouse conversion
        if (enableConsoleLogs && mouseDataRef.current.length === 0) {
          console.log('[ViewActLogger] First mouse conversion - screen:', mouseData.screen, 'image:', mouseData.image);
        }
      } catch (error) {
        // If conversion fails, just log screen coordinates
        if (enableConsoleLogs) {
          console.warn('[ViewActLogger] Failed to convert mouse coordinates to image space:', error);
        }
      }
    } else if (enableConsoleLogs && mouseDataRef.current.length === 0) {
      console.warn('[ViewActLogger] viewerRef not available for mouse coordinate conversion');
    }

    mouseDataRef.current.push(mouseData);

    // Debug: Log every 200th mouse event (configurable via env)
    if (enableConsoleLogs && mouseDataRef.current.length % 200 === 0) {
      console.log(`[ViewActLogger] Mouse data points: ${mouseDataRef.current.length} (${mouseFrequencyHz}Hz)`);
    }
  }, [enableMouseTracking, mouseThrottleMs, viewerRef, captureImageInfo, enableConsoleLogs, mouseFrequencyHz]);

  /**
   * Log viewport changes (throttled, frequency configurable via NEXT_PUBLIC_VIEWPORT_TRACKING_HZ)
   */
  const logViewportChange = useCallback(() => {
    if (!isRecordingRef.current || !enableViewportTracking || !currentViewerCoordinates) return;

    // Throttle based on configured frequency
    const now = Date.now();
    if (now - lastViewportLogTimeRef.current < viewportThrottleMs) return;
    lastViewportLogTimeRef.current = now;

    const img = currentViewerCoordinates.image;
    const viewportData: ViewportData = {
      type: 'viewport',
      timestamp: now,
      image: {
        x1: img.x1,
        y1: img.y1,
        x2: img.x2,
        y2: img.y2,
      },
      screen: currentViewerCoordinates.screen,
      dpr: currentViewerCoordinates.dpr,
      rotation: currentViewerCoordinates.rotation, // Rotation angle (optional)
    };

    // Only log if viewport actually changed
    const lastViewport = lastViewportRef.current;
    if (lastViewport) {
      const imageChanged =
        lastViewport.image.x1 !== viewportData.image.x1 ||
        lastViewport.image.y1 !== viewportData.image.y1 ||
        lastViewport.image.x2 !== viewportData.image.x2 ||
        lastViewport.image.y2 !== viewportData.image.y2 ||
        lastViewport.rotation !== viewportData.rotation;

      if (!imageChanged) return;
    }

    lastViewportRef.current = viewportData;
    viewportDataRef.current.push(viewportData);

    // Debug: Log viewport changes (configurable via env, reduced frequency)
    if (enableConsoleLogs && viewportDataRef.current.length % 10 === 0) {
      console.log(`[ViewActLogger] Viewport change #${viewportDataRef.current.length} (${viewportFrequencyHz}Hz):`, {
        image: `(${viewportData.image.x1}, ${viewportData.image.y1}) -> (${viewportData.image.x2}, ${viewportData.image.y2})`,
        screen: `${viewportData.screen.width}x${viewportData.screen.height}`,
        rotation: viewportData.rotation ? `${viewportData.rotation}°` : '0°'
      });
    }
  }, [enableViewportTracking, currentViewerCoordinates, viewportThrottleMs, enableConsoleLogs, viewportFrequencyHz]);

  /**
   * Start a new recording session
   */
  const startSession = useCallback(async (imageFile: string) => {
    if (!ENABLE_BEHAVIOR_VIEW_ACT_LOGGING) {
      return;
    }
    if (isRecordingRef.current) {
      console.warn('Session already in progress');
      return;
    }

    // Clear previous buffers
    mouseDataRef.current = [];
    viewportDataRef.current = [];
    imageInfoCaptured.current = false; // Reset imageInfo capture flag

    // Create session metadata
    const sessionId = `${Date.now()}`;
    const imageName = imageFile.split(/[\\/]/).pop() || 'unknown';
    const format = imageName.split('.').pop()?.toLowerCase() || 'unknown';

    // Get image info from viewer if available
    let imageInfo: SessionMetadata['imageInfo'];
    if (enableConsoleLogs) {
      console.log('[ViewActLogger] startSession - viewerRef:', viewerRef?.current ? 'available' : 'not available');
    }
    if (viewerRef?.current) {
      try {
        const viewer = viewerRef.current;
        const tiledImage = viewer.world.getItemAt(0);
        if (enableConsoleLogs) {
          console.log('[ViewActLogger] startSession - tiledImage:', tiledImage ? 'found' : 'not found');
        }
        if (tiledImage) {
          const source = tiledImage.source;
          imageInfo = {
            width: source.dimensions.x,
            height: source.dimensions.y,
            tileSize: source.tileSize || 256,
            format: format,
          };
          if (enableConsoleLogs) {
            console.log('[ViewActLogger] startSession - imageInfo:', imageInfo);
          }
        }
      } catch (error) {
        if (enableConsoleLogs) {
          console.warn('[ViewActLogger] Failed to get image info:', error);
        }
      }
    }

    sessionRef.current = {
      sessionId,
      imageFile,
      imageName,
      imageInfo,
      startTime: Date.now(),
      hasMouseTracking: enableMouseTracking,
      hasViewportTracking: enableViewportTracking,
    };

    isRecordingRef.current = true;

    // Add mouse listener
    if (enableMouseTracking) {
      window.addEventListener('mousemove', logMouseMovement);
    }

    console.log(`[ViewActLogger] Session started: ${sessionId}`);
    if (enableConsoleLogs) {
      console.log(`[ViewActLogger] Config: Mouse=${mouseFrequencyHz}Hz, Viewport=${viewportFrequencyHz}Hz, Logs=${enableConsoleLogs}`);
    }
  }, [
    enableMouseTracking,
    enableViewportTracking,
    viewerRef,
    logMouseMovement,
  ]);

  /**
   * Download session data locally (for debugging)
   * Triggers confirmation dialog in dashboard before downloading
   */
  const downloadSessionData = useCallback(() => {
    if (!ENABLE_BEHAVIOR_VIEW_ACT_LOGGING) {
      return;
    }
    if (!sessionRef.current) {
      console.warn('No session data to download');
      return;
    }

    // Prepare download info
    const fileName = `viewact_log_${sessionRef.current.sessionId}.json`;
    const eventCount = mouseDataRef.current.length + viewportDataRef.current.length;

    // Merge all data into array
    const allData: ViewActionData[] = [
      ...mouseDataRef.current,
      ...viewportDataRef.current,
    ];

    // Sort by timestamp
    allData.sort((a, b) => a.timestamp - b.timestamp);

    // Snapshot current Collect conversation (Talk With Agent segments) to include with behavior
    const conversationSegments = store.getState().recordingTranscript.segments;

    // Format as JSON object
    const jsonData = {
      metadata: {
        ...sessionRef.current,
        ...(conversationSegments.length > 0 && { conversation: conversationSegments }),
      },
      events: allData,
    };

    // Store download data globally so dashboard can access it
    if (typeof window !== 'undefined') {
      (window as any).__viewActDownloadData = jsonData;
      console.log('[ViewActLogger] downloadSessionData: dispatching event', { fileName });
      window.dispatchEvent(new CustomEvent('viewact-log-download-request', {
        detail: {
          fileName,
          eventCount,
          imageName: sessionRef.current.imageName || 'N/A',
        }
      }));
    }
  }, [store]);

  /**
   * Upload session data to backend using signed URLs (direct GCS upload)
   */
  const uploadSessionData = useCallback(async () => {
    if (!sessionRef.current) return;
    if (!ENABLE_BEHAVIOR_VIEW_ACT_LOGGING) {
      return;
    }

    // Snapshot all mutable refs immediately before any await, so a concurrent
    // startSession() call cannot wipe them mid-upload.
    const session = { ...sessionRef.current };
    const mouseData = [...mouseDataRef.current];
    const viewportData = [...viewportDataRef.current];

    try {
      // Check if user is authenticated
      if (!userId) {
        console.warn('[ViewActLogger] User not authenticated, skipping upload');
        // In dev mode, auto-download instead
        if (DEBUG_ENV === 'dev') {
          console.log('[ViewActLogger] DEBUG_ENV=dev: downloading data locally');
          downloadSessionData();
        }
        return;
      }

      const sessionId = session.sessionId;

      // Get authentication token
      const authToken = Cookies.get('tissuelab_token') || process.env.NEXT_PUBLIC_LOCAL_DEFAULT_TOKEN || 'local-default-token';

      // Step 1: Request signed URL for view-action log
      console.log('[ViewActLogger] Requesting upload URL for view-action log...');
      const viewActUrlResponse = await fetch(`${CTRL_SERVICE_API_ENDPOINT}/behavior/v1/upload-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          user_id: userId,
          session_id: sessionId,
          file_type: 'behavior_log',  // Backend expects this value
          content_type: 'application/gzip',
        }),
      });

      if (!viewActUrlResponse.ok) {
        throw new Error(`Failed to get upload URL: ${await viewActUrlResponse.text()}`);
      }

      const viewActUrlData = await viewActUrlResponse.json();
      const viewActSignedUrl = viewActUrlData.signed_url;
      const viewActPublicUrl = viewActUrlData.public_url;
      const viewActContentType = viewActUrlData.content_type;

      // Step 2: Prepare and compress view-action data
      // Snapshot current Collect conversation to include with behavior
      const conversationSegments = store.getState().recordingTranscript.segments;
      // Add session metadata as first line (same as download version); include conversation when present
      const sessionMetadataLine = JSON.stringify({
        type: 'session_metadata',
        ...session,
        ...(conversationSegments.length > 0 && { conversation: conversationSegments }),
      });

      const allData: ViewActionData[] = [
        ...mouseData,
        ...viewportData,
      ];
      allData.sort((a, b) => a.timestamp - b.timestamp);

      // Convert to JSONL string with metadata as first line
      const jsonlString = sessionMetadataLine + '\n' + allData.map(item => JSON.stringify(item)).join('\n');
      const compressed = pako.gzip(jsonlString);
      // IMPORTANT: Don't set Blob type! Let header handle Content-Type to match signed URL
      const viewActBlob = new Blob([compressed]);

      // Step 3: Upload view-action log directly to GCS
      console.log('[ViewActLogger] Uploading view-action log to GCS...');
      const uploadResponse = await fetch(viewActSignedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': viewActContentType },
        body: viewActBlob,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Failed to upload view-action log: ${uploadResponse.status} ${uploadResponse.statusText}`);
      }

      console.log('[ViewActLogger] View-action log uploaded successfully');
      toast.success('Behavior log saved');

      // Step 5: Save metadata to Firestore
      console.log('[ViewActLogger] Saving session metadata...');
      const metadata: Record<string, unknown> = {
        session_id: session.sessionId,
        user_id: userId,
        image_file: session.imageFile,
        image_name: session.imageName,
        start_time: session.startTime,
        end_time: session.endTime,
        duration_seconds: session.durationSeconds,
        has_mouse_tracking: session.hasMouseTracking,
        has_viewport_tracking: session.hasViewportTracking,
        gcs_behavior_path: `gs://${viewActPublicUrl}`,  // Backend expects this field name
        image_info: session.imageInfo,
      };
      if (conversationSegments.length > 0) {
        metadata.conversation = conversationSegments;
      }

      const metadataResponse = await fetch(`${CTRL_SERVICE_API_ENDPOINT}/behavior/v1/save-metadata`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ metadata }),
      });

      if (!metadataResponse.ok) {
        throw new Error(`Failed to save metadata: ${await metadataResponse.text()}`);
      }

      const result = await metadataResponse.json();
      console.log('[ViewActLogger] Upload complete:', result);

      // In dev mode (DEBUG_ENV=dev), also download a local copy for debugging
      if (DEBUG_ENV === 'dev') {
        console.log('[ViewActLogger] DEBUG_ENV=dev: also downloading data locally');
        downloadSessionData();
      }

      return result;

    } catch (error) {
      console.error('[ViewActLogger] Upload failed:', error);
      // Fallback: download locally in dev mode
      if (DEBUG_ENV === 'dev') {
        console.log('[ViewActLogger] Fallback (DEBUG_ENV=dev): downloading data locally');
        downloadSessionData();
      }
      throw error;
    }
  }, [userId, store, downloadSessionData]);

  /**
   * End the current session and upload data
   */
  const endSession = useCallback(async () => {
    if (!isRecordingRef.current || !sessionRef.current) {
      console.warn('No active session to end');
      return;
    }

    isRecordingRef.current = false;

    // Remove mouse listener
    if (enableMouseTracking) {
      window.removeEventListener('mousemove', logMouseMovement);
    }

    // Finalize session metadata
    const endTime = Date.now();
    sessionRef.current.endTime = endTime;
    sessionRef.current.durationSeconds = Math.round((endTime - sessionRef.current.startTime) / 1000);

    console.log(`[ViewActLogger] Session ended: ${sessionRef.current.sessionId}`);
    console.log(`  - Mouse points: ${mouseDataRef.current.length}`);
    console.log(`  - Viewport changes: ${viewportDataRef.current.length}`);

    // Prepare data for upload (toasts shown inside uploadSessionData)
    try {
      await uploadSessionData();
      // Clear Collect UI only after upload; data is already in the uploaded behavior log
      dispatch(clearTranscript());
    } catch (error) {
      console.error('Failed to upload session data:', error);
      toast.error('Session upload failed');
      // TODO: Implement retry logic or offline storage
    }

    // Clear session
    sessionRef.current = null;
    lastViewportRef.current = null;
  }, [dispatch, enableMouseTracking, logMouseMovement, uploadSessionData]);

  /**
   * Track viewport changes from Redux
   */
  useEffect(() => {
    if (isRecordingRef.current && enableViewportTracking) {
      logViewportChange();
    }
  }, [currentViewerCoordinates, enableViewportTracking, logViewportChange]);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      if (isRecordingRef.current) {
        console.warn('[ViewActLogger] Component unmounting during active session');
        endSession();
      }
    };
  }, [endSession]);

  return {
    startSession,
    endSession,
    downloadSessionData,
    isRecording: isRecordingRef.current,
    sessionMetadata: sessionRef.current,
  };
}

// ============================================================================
// Auto View-Action Logging Hook
// ============================================================================

export interface AutoViewActLoggingOptions {
  viewerRef?: React.MutableRefObject<any>;
}

/**
 * Auto view-action logging hook that monitors image path changes
 * and automatically starts/stops logging sessions for mouse + viewport
 * activity. Eye-tracking and voice-recording have been removed from
 * this build.
 */
export function useAutoViewActLogging(
  options?: React.MutableRefObject<any> | AutoViewActLoggingOptions
) {
  const isOptionsShape = typeof options === 'object' && options !== null && 'viewerRef' in options;
  const viewerRef = isOptionsShape
    ? (options as AutoViewActLoggingOptions).viewerRef
    : (options as React.MutableRefObject<any> | undefined);

  const currentPath = useSelector((state: RootState) => state.svsPath.currentPath);
  const logger = useViewActLogger({ viewerRef });
  const previousPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ENABLE_BEHAVIOR_VIEW_ACT_LOGGING) return;
    if (!currentPath) return;

    const handleSessionChange = async () => {
      try {
        if (previousPathRef.current && logger.isRecording) {
          console.log(`[AutoViewActLogging] Ending session for: ${previousPathRef.current}`);
          await logger.endSession();
        }
        console.log(`[AutoViewActLogging] Starting session for: ${currentPath}`);
        await logger.startSession(currentPath);
        previousPathRef.current = currentPath;
      } catch (error) {
        console.error('[AutoViewActLogging] Error during session change:', error);
      }
    };

    handleSessionChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  // Cleanup on unmount is handled by useViewActLogger itself
  // No additional cleanup needed here
}
