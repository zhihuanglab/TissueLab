import type { CommunityWorkflow } from "@/constants/communityWorkflowsDefault"
import { COMMUNITY_API_ENDPOINT } from "@/config/api.config"
import { apiFetch } from "@/utils/common/apiFetch"

export interface CommunityWorkflowsListResponse {
  success?: boolean
  workflows?: unknown[]
  total?: number
  offset?: number
  limit?: number
}

function isCommunityWorkflowPayload(x: unknown): x is CommunityWorkflow {
  if (!x || typeof x !== "object") return false
  const o = x as Record<string, unknown>
  if (typeof o.id !== "string" || typeof o.name !== "string") return false
  if (!Array.isArray(o.nodes) || !Array.isArray(o.connections)) return false
  if (!o.panelStates || typeof o.panelStates !== "object" || Array.isArray(o.panelStates)) return false
  if (!Array.isArray(o.chatMessages)) return false
  if (!(o.selectedId === null || typeof o.selectedId === "string")) return false
  return true
}

export function parseCommunityWorkflowsList(workflows: unknown[]): CommunityWorkflow[] {
  return workflows.filter(isCommunityWorkflowPayload).map((w) => w as CommunityWorkflow)
}

/**
 * Public community workflows (same route shape as classifiers public list).
 * Callers should fall back to {@link communityWorkflowsDefault} on empty result or network failure.
 */
export async function getPublicCommunityWorkflows(params?: {
  offset?: number
  limit?: number
}): Promise<CommunityWorkflow[]> {
  const queryParams = new URLSearchParams()
  if (params?.offset != null) queryParams.append("offset", String(params.offset))
  if (params?.limit != null) queryParams.append("limit", String(params.limit))

  const qs = queryParams.toString()
  const url = `${COMMUNITY_API_ENDPOINT}/community/v1/workflows/public${qs ? `?${qs}` : ""}`

  const response = (await apiFetch(url, { method: "GET" })) as CommunityWorkflowsListResponse
  if (!response?.success || !Array.isArray(response.workflows)) return []
  return parseCommunityWorkflowsList(response.workflows)
}

export interface RegisterCommunityWorkflowPayload {
  /** Workflow document body — same shape as CommunityWorkflow minus `id`, plus optional `isPublic`/`tags`. */
  name: string
  description?: string
  author?: string
  savedAt: string
  nodes: unknown[]
  connections: unknown[]
  panelStates: Record<string, unknown>
  chatMessages: unknown[]
  selectedId: string | null
  tags?: string[]
  /** Defaults to true on the server when omitted. */
  isPublic?: boolean
  /** Slide-independent run inputs captured at publish time. */
  runtimeContext?: import("@/utils/agent/workflow/serializedWorkflow").SerializedWorkflowRuntimeContext
}

export interface RegisterCommunityWorkflowResponse {
  success: boolean
  workflow_id: string
  message?: string
}

export interface WorkflowReferencingClassifier {
  id: string
  name: string
  author: string
  ownerId: string
  isPublic: boolean
}

export interface WorkflowsReferencingClassifierResponse {
  success: boolean
  workflows: WorkflowReferencingClassifier[]
  total: number
}

export interface DeleteCommunityWorkflowResponse {
  success: boolean
  workflow_id?: string
  message?: string
}

/**
 * Owner-only delete (server checks auth_user.uid == doc.ownerId). 404 is
 * treated as success so a stale UI list doesn't error if someone else already
 * removed it.
 */
export async function deleteCommunityWorkflow(workflowId: string): Promise<DeleteCommunityWorkflowResponse> {
  try {
    return (await apiFetch(
      `${COMMUNITY_API_ENDPOINT}/community/v1/workflows/${encodeURIComponent(workflowId)}`,
      { method: "DELETE" }
    )) as DeleteCommunityWorkflowResponse
  } catch (error) {
    const status = (error as { status?: number } | null | undefined)?.status
    if (status === 404) {
      return { success: true, workflow_id: workflowId, message: "Workflow already deleted" }
    }
    throw error
  }
}

/**
 * Workflows whose published `panelStates` reference a given community classifier.
 * Used to warn classifier owners before deletion would orphan workflows.
 * Note: only finds workflows whose `referencedClassifierIds` was populated at
 * register time — workflows published before that field existed won't appear.
 */
export async function getWorkflowsReferencingClassifier(
  classifierId: string
): Promise<WorkflowsReferencingClassifierResponse> {
  return (await apiFetch(
    `${COMMUNITY_API_ENDPOINT}/community/v1/workflows/referencing/${encodeURIComponent(classifierId)}`,
    { method: "GET" }
  )) as WorkflowsReferencingClassifierResponse
}

/**
 * Publish a workflow to Firestore (`upload_workflows`). The caller must rewrite
 * every local `classifier_path` in `panelStates` to a community reference
 * (`community:uploaded-…`) before calling — the server does no path rewriting.
 */
export async function registerCommunityWorkflow(
  workflowId: string,
  payload: RegisterCommunityWorkflowPayload,
  userId?: string
): Promise<RegisterCommunityWorkflowResponse> {
  const body: Record<string, unknown> = {
    workflow_id: workflowId,
    workflow: payload,
  }
  if (userId) body.user_id = userId
  return (await apiFetch(`${COMMUNITY_API_ENDPOINT}/community/v1/workflows/register`, {
    method: "POST",
    body: JSON.stringify(body),
  })) as RegisterCommunityWorkflowResponse
}
