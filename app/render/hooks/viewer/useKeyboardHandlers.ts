import { useEffect, useRef } from 'react';
import { useDispatch } from 'react-redux';
import { toast } from 'sonner';
import { AppDispatch } from '@/store';
import { setTool } from '@/store/slices/viewer/toolSlice';
import { useShortcuts } from '@/hooks/viewer/useShortcuts';

const MIN_PRESS_INTERVAL = 300; // Minimum 300ms between presses
const QUICK_FALLBACK_DELAY_MS = 600;
const RECENT_REFRESH_WINDOW_MS = 8000;

interface UseKeyboardHandlersParams {
  socket: WebSocket | null;
  allTilesLoaded: boolean;
  isZarrInitializing: boolean;
  isRequestPending: boolean;
  existAnnotationFile: boolean;
  showBackendAnnotations: boolean;
  showPatches: boolean;
  showMask: boolean;
  setShowBackendAnnotations: React.Dispatch<React.SetStateAction<boolean>>;
  setShowPatches: React.Dispatch<React.SetStateAction<boolean>>;
  setShowMask: React.Dispatch<React.SetStateAction<boolean>>;
  setCurrentRequestType: (type: 'space' | 'x' | null) => void;
  setIsRequestPending: (pending: boolean) => void;
  keydownUpdate: (prev: boolean, newVal: boolean) => void;
  keydownUpdatePatches: (prev: boolean, newVal: boolean) => void;
  resendSetPath: () => void;
  quickSpaceFallbackTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  lastWorkflowRefreshTsRef: React.MutableRefObject<number>;
}

/**
 * Hook to handle keyboard shortcuts for the viewer
 * Extracted from OpenSeadragonContainer to improve code organization
 * 
 * Note: This hook handles keyboard event processing, while useShortcuts handles
 * shortcut configuration management (loading/saving bindings from localStorage).
 */
export const useKeyboardHandlers = (params: UseKeyboardHandlersParams) => {
  const dispatch = useDispatch<AppDispatch>();
  const { bindings } = useShortcuts();
  const {
    socket,
    allTilesLoaded,
    isZarrInitializing,
    isRequestPending,
    existAnnotationFile,
    showBackendAnnotations,
    showPatches,
    showMask,
    setShowBackendAnnotations,
    setShowPatches,
    setShowMask,
    setCurrentRequestType,
    setIsRequestPending,
    keydownUpdate,
    keydownUpdatePatches,
    resendSetPath,
    quickSpaceFallbackTimerRef,
    lastWorkflowRefreshTsRef,
  } = params;

  // Ref to track last key press time for debouncing
  const lastKeyPressTimeRef = useRef<{ space: number; x: number; m: number }>({ space: 0, x: 0, m: 0 });

  useEffect(() => {
    const defer = (fn: () => void) => {
      window.setTimeout(fn, 0);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // Log space key for debugging
      if (event.key === ' ') {
        console.log('[OpenSeadragonContainer] Space key event received');
      }

      // Check if the target is an input element (input, textarea, select, etc.)
      const target = event.target as HTMLElement;
      const isInputElement =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.contentEditable === 'true';

      if (isInputElement) {
        if (event.key === ' ') {
          console.log('[OpenSeadragonContainer] 🛑 Space key ignored - target is input element');
        }
        return;
      }

      // Ignore auto-repeat to prevent rapid toggle on/off (especially for X)
      if (event.repeat) {
        if (event.key === ' ') {
          console.log('[OpenSeadragonContainer] 🛑 Space key ignored - auto-repeat');
        }
        return;
      }

      const eventKeyNorm =
        event.key === ' '
          ? 'Space'
          : event.key && event.key.length === 1
            ? event.key.toLowerCase()
            : event.code;
      const bind = (k: string) => (k.length === 1 ? k.toLowerCase() : k);

      // Handle Space key (toggle nuclei)
      if (eventKeyNorm === bind(bindings.toggleNuclei)) {
        console.log('[OpenSeadragonContainer] ✅ Space key matched toggle binding - processing...');



        // Debounce: prevent rapid consecutive presses
        const now = Date.now();
        if (now - lastKeyPressTimeRef.current.space < MIN_PRESS_INTERVAL) {
          console.log('[Space Key] Debounced - too fast');
          event.preventDefault();
          return;
        }
        lastKeyPressTimeRef.current.space = now;

        // Toggle backend annotation display
        setShowBackendAnnotations((prev) => {
          const newVal = !prev;

          // Check if Zarr is still initializing (just opened the image)
          // Allow first press to proceed even if Zarr is initializing - it will trigger the request
          if (newVal && isZarrInitializing && !prev) {
            console.log('[Space Key] Zarr initializing but allowing first press to proceed');
            resendSetPath();
            // Don't block the first press, let it proceed to trigger the request
          } else if (newVal && isZarrInitializing) {
            toast('Image is loading, please wait a moment...');
            return prev; // Keep current state, don't toggle yet
          }

          // Check if request is already pending
          if (isRequestPending) {
            if (newVal) {
              // Trying to open while loading - show message but keep state as "will open"
              toast("It's loading, please wait...");
              return true; // Return true so layer shows when loading completes
            } else {
              // Trying to close while loading - allow it and reset states
              setIsRequestPending(false);
              setCurrentRequestType(null);
              if (quickSpaceFallbackTimerRef.current) {
                clearTimeout(quickSpaceFallbackTimerRef.current as unknown as number);
                quickSpaceFallbackTimerRef.current = null;
              }
              defer(() => keydownUpdate(true, false)); // Force close outside render update
              return false;
            }
          }

          // Check WebSocket connection status immediately
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            toast.error(
              'Space key highlights nuclei segmentation. However, WebSocket connection is not available. Please check your connection and try again.'
            );
            setCurrentRequestType(null); // Reset request type after showing error
            return prev; // Don't change state if connection failed
          }

          // Always allow space key to trigger, even if no annotation file is loaded yet
          // This ensures the first press will send the WebSocket request
          if (newVal) {
            // When turning on backend annotations, always try to request data
            console.log('Space key pressed - attempting to load backend annotations');
            setCurrentRequestType('space'); // Set request type for error message context
            setIsRequestPending(true); // Set pending state
            defer(() => keydownUpdate(prev, newVal));

            // Quick fallback: if no response comes shortly and no recent workflow refresh, show error
            if (quickSpaceFallbackTimerRef.current) {
              clearTimeout(quickSpaceFallbackTimerRef.current as unknown as number);
              quickSpaceFallbackTimerRef.current = null;
            }
            const now = Date.now();
            const withinRecentRefresh = now - lastWorkflowRefreshTsRef.current < RECENT_REFRESH_WINDOW_MS;
            if (!withinRecentRefresh) {
              quickSpaceFallbackTimerRef.current = setTimeout(() => {
                // Check if Zarr is still initializing before showing error
                if (isZarrInitializing) {
                  toast('Image is loading, please wait a moment...');
                  setCurrentRequestType(null);
                  setIsRequestPending(false);
                  quickSpaceFallbackTimerRef.current = null;
                  return;
                }

                if (!existAnnotationFile) {
                  toast.warning('Zarr file not found. Please run segmentation workflow first.');
                  setCurrentRequestType(null);
                  setIsRequestPending(false);
                }
                quickSpaceFallbackTimerRef.current = null;
              }, QUICK_FALLBACK_DELAY_MS);
            }
          } else {
            // When turning off, reset states and proceed
            setIsRequestPending(false);
            setCurrentRequestType(null);
            if (quickSpaceFallbackTimerRef.current) {
              clearTimeout(quickSpaceFallbackTimerRef.current as unknown as number);
              quickSpaceFallbackTimerRef.current = null;
            }
            if (existAnnotationFile) {
              defer(() => keydownUpdate(prev, newVal));
            } else {
              console.log('No annotation file loaded, but turning off backend annotations');
            }
          }
          return newVal;
        });
        event.preventDefault(); // prevent scrolling
      }
      // Handle X key (toggle patches)
      else if (eventKeyNorm === bind(bindings.togglePatches)) {


        // Debounce: prevent rapid consecutive presses
        const now = Date.now();
        if (now - lastKeyPressTimeRef.current.x < MIN_PRESS_INTERVAL) {
          console.log('[X Key] Debounced - too fast');
          event.preventDefault();
          return;
        }
        lastKeyPressTimeRef.current.x = now;

        // Toggle patch display
        setShowPatches((prev) => {
          const newVal = !prev;

          // Check if Zarr is still initializing (just opened the image)
          // Allow first press to proceed even if Zarr is initializing - it will trigger the request
          if (newVal && isZarrInitializing && !prev) {
            console.log('[X Key] Zarr initializing but allowing first press to proceed');
            resendSetPath();
            // Don't block the first press, let it proceed to trigger the request
          } else if (newVal && isZarrInitializing) {
            toast('Image is loading, please wait a moment...');
            return prev; // Keep current state, don't toggle yet
          }

          // Check if request is already pending
          if (isRequestPending) {
            if (newVal) {
              // Trying to open while loading - show message but keep state as "will open"
              toast("It's loading, please wait...");
              return true; // Return true so layer shows when loading completes
            } else {
              // Trying to close while loading - allow it and reset states
              setIsRequestPending(false);
              setCurrentRequestType(null);
              defer(() => keydownUpdatePatches(true, false)); // Force close outside render update
              return false;
            }
          }

          // Check WebSocket connection status immediately
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            toast.error(
              'X key displays patch classification. However, WebSocket connection is not available. Please check your connection and try again.'
            );
            return prev; // Don't change state if connection failed
          }

          // Set pending state and request type based on action
          if (newVal) {
            setCurrentRequestType('x');
            setIsRequestPending(true);
          } else {
            setIsRequestPending(false);
            setCurrentRequestType(null);
          }

          defer(() => keydownUpdatePatches(prev, newVal));
          return newVal;
        });
        event.preventDefault();
      }
      // Handle M key (toggle mask)
      else if (eventKeyNorm === bind(bindings.toggleMask)) {


        // Debounce: prevent rapid consecutive presses
        const now = Date.now();
        if (now - lastKeyPressTimeRef.current.m < MIN_PRESS_INTERVAL) {
          console.log('[M Key] Debounced - too fast');
          event.preventDefault();
          return;
        }
        lastKeyPressTimeRef.current.m = now;

        // Toggle mask display
        setShowMask((prev) => !prev);
        event.preventDefault();
      }
      // Handle tool switching shortcuts
      else if (eventKeyNorm === bind(bindings['tool.move'])) {
        // switch to move tool
        dispatch(setTool('move'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(bindings['tool.polygon'])) {
        // switch to polygon tool
        dispatch(setTool('polygon'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(bindings['tool.rectangle'])) {
        // switch to rectangle tool
        dispatch(setTool('rectangle'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(bindings['tool.line'])) {
        // switch to ruler tool
        dispatch(setTool('line'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(bindings['tool.filter'])) {
        // switch to filter tool (draws like rectangle)
        dispatch(setTool('filter'));
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    bindings,
    socket,
    allTilesLoaded,
    isZarrInitializing,
    isRequestPending,
    existAnnotationFile,
    showMask,
    setShowBackendAnnotations,
    setShowPatches,
    setShowMask,
    setCurrentRequestType,
    setIsRequestPending,
    keydownUpdate,
    keydownUpdatePatches,
    resendSetPath,
    quickSpaceFallbackTimerRef,
    lastWorkflowRefreshTsRef,
    dispatch,
  ]);
};
