import type { CommunityWorkflow } from "@/constants/communityWorkflowsDefault"
import { communityWorkflowsDefault } from "@/constants/communityWorkflowsDefault"
import { getPublicCommunityWorkflows } from "@/services/communityWorkflows.service"
import type { SerializedWorkflow } from "@/utils/workflow/serializedWorkflow"

/**
 * Remote entries first; bundled defaults keep any id not present remotely (remote wins on same id).
 */
export function mergeCommunityWorkflowPresets(
  remote: CommunityWorkflow[],
  fallback: CommunityWorkflow[]
): CommunityWorkflow[] {
  const remoteIds = new Set(remote.map((w) => w.id))
  const extras = fallback.filter((w) => !remoteIds.has(w.id))
  return [...remote, ...extras]
}

/** Fetch public workflows and merge with offline defaults; on failure returns a copy of defaults only. */
export async function loadMergedCommunityWorkflowPresets(): Promise<CommunityWorkflow[]> {
  try {
    const remote = await getPublicCommunityWorkflows({ limit: 100 })
    return mergeCommunityWorkflowPresets(remote, communityWorkflowsDefault)
  } catch {
    return [...communityWorkflowsDefault]
  }
}

/** Full graph snapshot for `tl.workflowGraph.saved` (Agentic AI library). */
export function communityWorkflowToSerializedSnapshot(wf: CommunityWorkflow): SerializedWorkflow {
  return {
    name: wf.name,
    nodes: wf.nodes as unknown[],
    connections: wf.connections as unknown[],
    savedAt: wf.savedAt || new Date().toISOString(),
    panelStates: wf.panelStates as Record<string, unknown>,
    chatMessages: wf.chatMessages as unknown[],
    selectedId: wf.selectedId ?? null,
    description: wf.description,
    author: wf.author,
  }
}
