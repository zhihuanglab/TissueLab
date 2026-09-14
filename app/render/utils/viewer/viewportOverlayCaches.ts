/**
 * Clear both centroid and contour viewport caches together.
 * Always use this on slide/path/instance changes — never clear only one side.
 *
 * Clear scope:
 * - `(instanceId, path)` — slide switch (drop only the old key)
 * - `(instanceId)` — data mutation / reload (drop every key for that viewer;
 *   safer than path-scoped when slash / .zarr variants may disagree)
 * - `()` — wipe everything
 */
import { clearViewportGeometryCache } from './viewportGeometryCache';
import { clearViewportContourCache } from './viewportContourCache';

export function clearViewportOverlayCaches(instanceId?: string, path?: string): void {
  clearViewportGeometryCache(instanceId, path);
  clearViewportContourCache(instanceId, path);
}
