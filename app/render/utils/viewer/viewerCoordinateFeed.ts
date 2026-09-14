/**
 * Refcount gate for `viewer.currentViewerCoordinates`.
 *
 * The session publishes that value from inside the pan/zoom animation frame,
 * where a dispatch means running every subscribed selector in the app and
 * scheduling a render. Usually nothing reads it, so it is skipped while the
 * count is zero.
 *
 * Any new consumer of `state.viewer.currentViewerCoordinates` MUST acquire for
 * as long as it needs fresh values, or it will read a stale one.
 */

let consumers = 0;

/** Returns the matching release; calling it more than once counts only once. */
export function acquireViewerCoordinateFeed(): () => void {
  consumers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    consumers = Math.max(0, consumers - 1);
  };
}

/** True when at least one consumer needs coordinates published. */
export function hasViewerCoordinateConsumers(): boolean {
  return consumers > 0;
}
