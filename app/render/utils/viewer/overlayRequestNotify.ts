/**
 * Overlay nuclei/patches request notify policy.
 *
 * Keep this pure so the "when do we toast?" rules stay testable without
 * mounting WebSocket / React hooks.
 */

/** In-flight user overlay requests (feature layers — not keyboard keys). */
export type OverlayPendingRequest = {
  nuclei: boolean;
  patches: boolean;
};

export const EMPTY_OVERLAY_PENDING: OverlayPendingRequest = {
  nuclei: false,
  patches: false,
};

export function hasOverlayPending(p: OverlayPendingRequest | null | undefined): boolean {
  return !!(p && (p.nuclei || p.patches));
}

export type OverlayNotifyToast = {
  level: 'warning' | 'default';
  message: string;
};

/**
 * Decide whether (and what) to toast when the backend reports missing overlay data.
 * Background refreshes pass an empty pending and stay silent.
 * If both layers pending, prefer nuclei (no-seg is usually cell-first).
 */
export function resolveMissingOverlayNotify(options: {
  pendingRequest: OverlayPendingRequest;
  existAnnotationFile: boolean;
}): OverlayNotifyToast | null {
  const { pendingRequest, existAnnotationFile } = options;

  if (pendingRequest.nuclei) {
    if (!existAnnotationFile) {
      return {
        level: 'warning',
        message: 'Zarr file not found. Please run segmentation workflow first.',
      };
    }
    return { level: 'default', message: 'No cell result' };
  }

  if (pendingRequest.patches) {
    if (!existAnnotationFile) {
      return {
        level: 'warning',
        message: 'Zarr file not found. Please run patch classification workflow first.',
      };
    }
    return { level: 'default', message: 'No patch result' };
  }

  return null;
}
