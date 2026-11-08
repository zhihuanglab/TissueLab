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
  /** Only the active (visible) viewer reacts; hidden panes keep their listener idle. Default true. */
  isActive?: boolean;
}

const ACTIVATABLE_CONTROL =
  'button, a[href], summary, [role="button"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"], [role="tab"], [role="radio"]';

/** The button-like control `el` is (or sits in), if any. */
function closestControl(el: EventTarget | null): Element | null {
  const node = el as Element | null;
  return node && typeof node.closest === 'function' ? node.closest(ACTIVATABLE_CONTROL) : null;
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

  // Whether focus was last moved with the keyboard (Tab) rather than a
  // mouse/touch press. Tracks input modality, not an element: menus and dialogs
  // hand focus back to their trigger after a click, and that still counts as
  // mouse focus.
  const keyboardFocusRef = useRef(false);

  useEffect(() => {
    const handlePointerDown = () => {
      keyboardFocusRef.current = false;
    };
    const handleTab = (event: KeyboardEvent) => {
      if (event.key === 'Tab') keyboardFocusRef.current = true;
    };
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

      // Every mounted container listens on window; let only the active one act,
      // so one key press doesn't toggle (and request) every open slide.
      if (paramsRef.current.isActive === false) return;

      const target = event.target as HTMLElement;
      const isInputElement =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.contentEditable === 'true';

      if (isInputElement) return;
      if (event.repeat) return;
      // Bindings are single keys: Cmd/Ctrl/Alt combos (Cmd+X cut, Cmd+M
      // minimize, Ctrl+1 ...) belong to the app and OS, not to the viewer.
      // AltGr (reported as Ctrl+Alt on Windows) types characters such as [ or @
      // on many layouts, so it still reaches a binding.
      const altGraph =
        typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
      if (event.metaKey || (!altGraph && (event.ctrlKey || event.altKey))) return;
      // Space/Enter on a button-like control reached with the keyboard (Tab)
      // activates that control; don't hijack it (and preventDefault) for an
      // overlay shortcut. A control that holds focus after a click (a toolbar
      // tool, or a menu trigger focus returned to) keeps the shortcut.
      // :focus-visible can't tell these apart: Chromium sets it before keydown
      // is dispatched.
      if ((event.key === ' ' || event.key === 'Enter') && keyboardFocusRef.current && closestControl(target)) {
        return;
      }
      // A widget that already acted on Space/Enter (a Radix menu trigger opens
      // on keydown, before this window listener) consumed it; toggling the
      // overlay as well would do two things for one key. Plain buttons don't
      // preventDefault on keydown, so a clicked toolbar tool keeps the shortcut.
      if ((event.key === ' ' || event.key === 'Enter') && event.defaultPrevented) return;

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
        } else if (newVal && (!socket || socket.readyState !== WebSocket.OPEN)) {
          // Only turning the overlay ON needs the socket; hiding it always works,
          // same as the toolbar button.
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
        } else if (newPatches && (!socket || socket.readyState !== WebSocket.OPEN)) {
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

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleTab, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleTab, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [dispatch]);
};
