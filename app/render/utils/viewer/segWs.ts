/**
 * Helpers for segmentation WebSocket payloads.
 * Backend handlers are keyed by viewer ``instance_id`` (not device_id).
 */

export function requireSegInstanceId(
  instanceId: string | null | undefined,
  context: string
): instanceId is string {
  if (instanceId) return true;
  console.warn(`[WebSocket] Missing instance_id; skipping ${context}`);
  return false;
}
