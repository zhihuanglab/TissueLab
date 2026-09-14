/**
 * Server-side classifier file I/O (`/seg/v1/classifier_file/*`).
 * Path-only APIs — no ``instanceId`` / ``X-Instance-ID`` required.
 */
import { AI_SERVICE_API_ENDPOINT } from "@/config/api.config"
import { apiFetch } from "@/utils/common/apiFetch"

export type SaveClassifierFileBody = {
  /** Destination path (storage-relative or absolute, same rules as other seg APIs). */
  path: string
  /** Server-side copy: if set, copies this path to `path`. */
  copy_from_path?: string
  /** When copying, if source is missing create an empty destination (default true). */
  empty_if_missing_source?: boolean
  /** Raw bytes as base64; ignored when `copy_from_path` is set. Omit / null / "" → empty file. */
  content_base64?: string | null
  /** When true, the server returns a wrapped error (code 409) instead of overwriting if `path` exists. */
  fail_if_exists?: boolean
}

export async function saveClassifierFileOnServer(
  body: SaveClassifierFileBody,
): Promise<{ path: string; size: number; mode: string }> {
  return apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classifier_file/save`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as Promise<{ path: string; size: number; mode: string }>
}

/**
 * Read the `model_name` tag from local .tlcls files so the Load dialog can hide
 * classifiers trained for a different patch model. Untagged / unreadable files
 * map to "" (placeholder — loadable on any node). Best-effort: returns {} on error.
 */
export async function getClassifierModelNames(
  paths: string[],
): Promise<Record<string, string>> {
  if (!paths.length) return {}
  try {
    const resp = (await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classifier_file/model_names`, {
      method: "POST",
      body: JSON.stringify({ paths }),
    })) as { models?: Record<string, string> }
    return resp?.models ?? {}
  } catch {
    return {}
  }
}

/** `inherit_from` payload stamped by ctrl-service when a community classifier is
 * downloaded; preserved across retrain by the tasknodes. Presence means the
 * .tlcls descends from a community model (so it can be republished). */
export type ClassifierInheritFrom = {
  community_id?: string
  downloaded_at?: number
}

/**
 * Read the `inherit_from` community lineage from a local .tlcls. Lets the graph
 * recognize a shared/imported classifier as descending from a community model —
 * even when it wasn't loaded through the community list — so Publish still works.
 * Best-effort: returns null on any error / untagged file.
 */
export async function getClassifierInheritFrom(
  path: string,
): Promise<ClassifierInheritFrom | null> {
  if (!path || !path.trim()) return null
  try {
    const resp = (await apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classifier_file/model_names`, {
      method: "POST",
      body: JSON.stringify({ paths: [path] }),
    })) as { inherit?: Record<string, ClassifierInheritFrom | null> }
    return resp?.inherit?.[path] ?? null
  } catch {
    return null
  }
}

export type TasknodeClassifierSaveBody = {
  // Backend node name for port resolution — NuClass / MuskClassification /
  // HOptimusClassification / VirchowClassification / … (any registered node).
  node_name: string
  dest_path: string
}

/** NuClass/MUSK: save in-memory trained classifier to `dest_path` (seg → tasknode POST /classifier/save mode=save_trained). */
export async function saveClassifierViaTasknode(
  body: TasknodeClassifierSaveBody,
): Promise<{ path: string; size: number; node_name: string }> {
  return apiFetch(`${AI_SERVICE_API_ENDPOINT}/seg/v1/classifier_tasknode_save`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as Promise<{ path: string; size: number; node_name: string }>
}
