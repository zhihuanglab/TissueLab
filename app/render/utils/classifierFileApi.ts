/**
 * Server-side classifier file I/O (`/seg/v1/classifier_file/*`).
 * Typical graph flow: copy an on-disk classifier after a run — no empty placeholder required.
 */
import { AI_SERVICE_API_ENDPOINT } from "@/constants/config"
import { apiFetch } from "@/utils/common/apiFetch"

export type ClassifierFileRequestOpts = {
  /** Multi-instance web: send X-Instance-ID like other seg requests. */
  instanceId?: string | null
}

export type SaveClassifierFileBody = {
  /** Destination path (storage-relative or absolute, same rules as other seg APIs). */
  path: string
  /** Server-side copy: if set, copies this path to `path`. */
  copy_from_path?: string
  /** When copying, if source is missing create an empty destination (default true). */
  empty_if_missing_source?: boolean
  /** Raw bytes as base64; ignored when `copy_from_path` is set. Omit / null / "" → empty file. */
  content_base64?: string | null
}

function instanceHeaders(instanceId?: string | null): HeadersInit | undefined {
  if (!instanceId) return undefined
  return { "X-Instance-ID": instanceId }
}

export async function saveClassifierFileOnServer(
  body: SaveClassifierFileBody,
  opts?: ClassifierFileRequestOpts
): Promise<{ path: string; size: number; mode: string }> {
  const headers = instanceHeaders(opts?.instanceId)
  return apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classifier_file/save`, {
    method: "POST",
    body: JSON.stringify(body),
    ...(headers ? { headers } : {}),
  }) as Promise<{ path: string; size: number; mode: string }>
}

export type TasknodeClassifierSaveBody = {
  node_name: "ClassificationNode" | "MuskClassification"
  dest_path: string
}

/** NuClass/MUSK: save in-memory trained classifier to `dest_path` (seg → tasknode POST /classifier/save mode=save_trained). */
export async function saveClassifierViaTasknode(
  body: TasknodeClassifierSaveBody,
  opts?: ClassifierFileRequestOpts
): Promise<{ path: string; size: number; node_name: string }> {
  const headers = instanceHeaders(opts?.instanceId)
  return apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classifier_tasknode_save`, {
    method: "POST",
    body: JSON.stringify(body),
    ...(headers ? { headers } : {}),
  }) as Promise<{ path: string; size: number; node_name: string }>
}
