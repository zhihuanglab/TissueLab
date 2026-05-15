import type { CommunityWorkflow } from "@/constants/communityWorkflowsDefault"
import { CTRL_SERVICE_API_ENDPOINT } from "@/constants/config"
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
  const url = `${CTRL_SERVICE_API_ENDPOINT}/community/v1/workflows/public${qs ? `?${qs}` : ""}`

  const response = (await apiFetch(url, { method: "GET" })) as CommunityWorkflowsListResponse
  if (!response?.success || !Array.isArray(response.workflows)) return []
  return parseCommunityWorkflowsList(response.workflows)
}
