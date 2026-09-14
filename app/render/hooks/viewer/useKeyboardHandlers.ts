import { useEffect, useRef } from 'react';
import { useDispatch } from 'react-redux';
import { toast } from 'sonner';
import { AppDispatch } from '@/store';
import { setTool } from '@/store/slices/viewer/toolSlice';
import { useShortcuts } from '@/hooks/viewer/useShortcuts';
import type { OverlayPendingRequest } from '@/utils/viewer/overlayRequestNotify';

const MIN_PRESS_INTERVAL = 300; // Minimum 300ms between presses

interface UseKeyboardHandlersParams {
  socket: WebSocket | null;
  pendingRequest: OverlayPendingRequest;
  setShowBackendAnnotations: React.Dispatch<React.SetStateAction<boolean>>;
  setShowPatches: React.Dispatch<React.SetStateAction<boolean>>;
  setShowMask: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingRequest: React.Dispatch<React.SetStateAction<OverlayPendingRequest>>;
  keydownUpdate: (prev: boolean, newVal: boolean) => void;
  keydownUpdatePatches: (prev: boolean, newVal: boolean) => void;
  /** Updated synchronously on toggle so late WS frames / session ticks share one gate. */
  showBackendAnnotationsRef: React.MutableRefObject<boolean>;
  showPatchesRef: React.MutableRefObject<boolean>;
}

/**
 * Hook to handle keyboard shortcuts for the viewer.
 * Listener is mounted once; latest socket/pending/handlers are read from refs.
 */
export const useKeyboardHandlers = (params: UseKeyboardHandlersParams) => {
  const dispatch = useDispatch<AppDispatch>();
  const { bindings } = useShortcuts();

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  // Debounce per feature toggle (bindings are user-configurable).
  const lastKeyPressTimeRef = useRef<{ nuclei: number; patches: number; mask: number }>({
    nuclei: 0,
    patches: 0,
    mask: 0,
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const {
        socket,
        pendingRequest,
        setShowBackendAnnotations,
        setShowPatches,
        setShowMask,
        setPendingRequest,
        keydownUpdate,
        keydownUpdatePatches,
        showBackendAnnotationsRef,
        showPatchesRef,
      } = paramsRef.current;
      const keys = bindingsRef.current;

      const target = event.target as HTMLElement;
      const isInputElement =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.contentEditable === 'true';

      if (isInputElement) return;
      if (event.repeat) return;

      const eventKeyNorm =
        event.key === ' '
          ? 'Space'
          : event.key && event.key.length === 1
            ? event.key.toLowerCase()
            : event.code;
      const bind = (k: string) => (k.length === 1 ? k.toLowerCase() : k);

      // Toggle nuclei / backend cell overlay
      if (eventKeyNorm === bind(keys.toggleNuclei)) {
        const now = Date.now();
        if (now - lastKeyPressTimeRef.current.nuclei < MIN_PRESS_INTERVAL) {
          event.preventDefault();
          return;
        }
        lastKeyPressTimeRef.current.nuclei = now;

        // Decide, then commit. This block used to live inside the setState
        // updater, so every side effect in it (set_path sends, pending flips,
        // toasts) replayed whenever React invoked the updater twice.
        // The ref is the shared source of truth for this gate.
        const prev = showBackendAnnotationsRef.current;
        const newVal = !prev;

        // No set_path resend while zarr initialises: one is already in flight and
        // its ack opens the wire gate and forces a sync. Re-binding here made the
        // backend answer twice, so every toggle during load cost two viewport
        // requests, two settles and two contour FIFO entries.
        if (pendingRequest.nuclei) {
          if (newVal) {
            toast("It's loading, please wait...");
            showBackendAnnotationsRef.current = true;
            setShowBackendAnnotations(true);
          } else {
            showBackendAnnotationsRef.current = false;
            setPendingRequest((p) => ({ ...p, nuclei: false }));
            keydownUpdate(true, false);
            setShowBackendAnnotations(false);
          }
        } else if (!socket || socket.readyState !== WebSocket.OPEN) {
          toast.error(
            'Nuclei overlay requires an open WebSocket connection. Please check your connection and try again.',
          );
          setPendingRequest((p) => ({ ...p, nuclei: false }));
          showBackendAnnotationsRef.current = prev;
        } else {
          showBackendAnnotationsRef.current = newVal;
          setPendingRequest((p) => ({ ...p, nuclei: newVal }));
          // Refs already updated; overlayNeedKey effect owns reset/sync.
          keydownUpdate(prev, newVal);
          setShowBackendAnnotations(newVal);
        }
        event.preventDefault();
      }
      // Toggle patch classification overlay
      else if (eventKeyNorm === bind(keys.togglePatches)) {
        const now = Date.now();
        if (now - lastKeyPressTimeRef.current.patches < MIN_PRESS_INTERVAL) {
          event.preventDefault();
          return;
        }
        lastKeyPressTimeRef.current.patches = now;

        // Same shape as the nuclei toggle: decide first, commit once.
        const prevPatches = showPatchesRef.current;
        const newPatches = !prevPatches;

        if (pendingRequest.patches) {
          if (newPatches) {
            toast("It's loading, please wait...");
            showPatchesRef.current = true;
            setShowPatches(true);
          } else {
            showPatchesRef.current = false;
            setPendingRequest((p) => ({ ...p, patches: false }));
            keydownUpdatePatches(true, false);
            setShowPatches(false);
          }
        } else if (!socket || socket.readyState !== WebSocket.OPEN) {
          toast.error(
            'Patch overlay requires an open WebSocket connection. Please check your connection and try again.',
          );
          showPatchesRef.current = prevPatches;
        } else {
          showPatchesRef.current = newPatches;
          setPendingRequest((p) => ({ ...p, patches: newPatches }));
          keydownUpdatePatches(prevPatches, newPatches);
          setShowPatches(newPatches);
        }
        event.preventDefault();
      }
      // Toggle mask
      else if (eventKeyNorm === bind(keys.toggleMask)) {
        const now = Date.now();
        if (now - lastKeyPressTimeRef.current.mask < MIN_PRESS_INTERVAL) {
          event.preventDefault();
          return;
        }
        lastKeyPressTimeRef.current.mask = now;
        setShowMask((prev) => !prev);
        event.preventDefault();
      }
      // Tool switching shortcuts
      else if (eventKeyNorm === bind(keys['tool.move'])) {
        dispatch(setTool('move'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(keys['tool.lasso'])) {
        dispatch(setTool('lasso'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(keys['tool.polygon'])) {
        dispatch(setTool('polygon'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(keys['tool.rectangle'])) {
        dispatch(setTool('rectangle'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(keys['tool.line'])) {
        dispatch(setTool('line'));
        event.preventDefault();
      } else if (eventKeyNorm === bind(keys['tool.filter'])) {
        dispatch(setTool('filter'));
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dispatch]);
};
