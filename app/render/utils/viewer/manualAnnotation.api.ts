/**
 * API helpers for User-Annotations/manual.json persistence.
 */

import { AI_SERVICE_API_ENDPOINT } from '@/config/api.config';
import { segFetch } from '@/utils/common/segFetch';
import type { ManualAnnotationRecord } from '@/utils/viewer/annotation.utils';

export async function apiSaveManualAnnotation(
  instanceId: string | null | undefined,
  payload: ManualAnnotationRecord & { path: string },
): Promise<void> {
  if (!instanceId) throw new Error('Missing session; cannot save manual annotation.');
  // Default segFetch throws on AppResponse code !== 0.
  await segFetch(instanceId, `${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_manual_annotation`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function apiListManualAnnotations(
  instanceId: string | null | undefined,
  path: string,
): Promise<ManualAnnotationRecord[]> {
  if (!instanceId || !path) return [];
  // Let HTTP / AppResponse errors throw — callers must not treat failure as "empty".
  const payload = await segFetch(
    instanceId,
    `${AI_SERVICE_API_ENDPOINT}/tasks/v1/list_manual_annotations?path=${encodeURIComponent(path)}`,
    { method: 'GET' },
  );
  return Array.isArray(payload?.annotations) ? payload.annotations : [];
}

export async function apiDeleteManualAnnotation(
  instanceId: string | null | undefined,
  path: string,
  id: string,
): Promise<void> {
  if (!instanceId) throw new Error('Missing session; cannot delete manual annotation.');
  await segFetch(instanceId, `${AI_SERVICE_API_ENDPOINT}/tasks/v1/delete_manual_annotation`, {
    method: 'POST',
    body: JSON.stringify({ path, id }),
  });
}
