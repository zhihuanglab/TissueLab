import type { GeneratedWorkflowStep } from "@/components/imageViewer/RightSidebar/Agent/Chatbox"
import { panelMap } from "@/components/imageViewer/RightSidebar/Agent/Workflow/constants"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { registryNodes } from "@/utils/workflowGraph/constants"
import type { GraphNode } from "@/utils/workflowGraph/types"

/** Snapshot node panels for the given graph nodes (Coding Agent code/run fields, classifiers, etc.). */
export function collectPanelStatesSnapshot(
  nodes: GraphNode[],
  panelStates: Record<string, WorkflowPanel>
): Record<string, WorkflowPanel> {
  const ids = new Set(nodes.map((n) => n.id))
  const out: Record<string, WorkflowPanel> = {}
  for (const id of ids) {
    const p = panelStates[id]
    if (p) out[id] = JSON.parse(JSON.stringify(p)) as WorkflowPanel
  }
  return out
}

export const resolveGeneratedModelId = (step: GeneratedWorkflowStep): string | null => {
  const candidates = [
    typeof step.impl === "string" ? step.impl.trim() : "",
    typeof step.type === "string" ? step.type.trim() : "",
    typeof step.model === "string" ? step.model.trim() : "",
    (panelMap as Record<string, any>)[step.model]?.defaultType,
  ].filter(Boolean)

  return candidates.find((candidate) => Boolean(registryNodes[candidate])) ?? null
}

export const buildGeneratedPanel = (
  step: GeneratedWorkflowStep,
  nodeId: string,
  modelId: string,
  formattedPath: string
): WorkflowPanel | null => {
  const factory = registryNodes[modelId]?.factory || step.model
  const cfg = (panelMap as Record<string, any>)[factory]
  if (!cfg) return null

  const joinedValue = Array.isArray(step.input) ? step.input.join(", ") : step.input ?? step.prompt ?? ""
  const isCodingAgent = modelId === panelMap.CodingAgent.defaultType

  // Parse `key=value` items from step.input so each typed panel field gets its own value
  // (e.g. patch_size=224 / level=0 / tissue_threshold=0.1 / target_mpp=0.25). Without this
  // we used to stuff `joinedValue` into every field, so multi-field panels like
  // TissueSeg/MuskEmbedding and NucleiSeg rendered the same blob (often the WSI path) in
  // every input.
  const inputItems: string[] = Array.isArray(step.input)
    ? step.input.filter((v): v is string => typeof v === "string")
    : []
  const parsedInput: Record<string, string> = {}
  for (const raw of inputItems) {
    const eq = raw.indexOf("=")
    if (eq <= 0) continue
    const key = raw.slice(0, eq).trim()
    const value = raw.slice(eq + 1).trim()
    if (key) parsedInput[key] = value
  }

  const content = cfg.defaultContent.map((contentItem: any) => {
    // Coding Agent: only `prompt` gets the chat step text — never overwrite script_run_policy /
    // digest fields (that broke policy detection and triggered spurious auto-runs).
    if (isCodingAgent && contentItem.key !== "prompt") return { ...contentItem }
    // `prompt` always carries the joined chat step text (calculation text / classes / etc.).
    if (contentItem.key === "prompt") return { ...contentItem, value: joinedValue }
    // Typed fields take their own `key=value` from step.input; leave default when absent.
    if (Object.prototype.hasOwnProperty.call(parsedInput, contentItem.key)) {
      return { ...contentItem, value: parsedInput[contentItem.key] }
    }
    return { ...contentItem }
  })

  if (modelId !== "GPT-4o Agent" && !content.some((item: any) => item.key === "path")) {
    content.push({ key: "path", type: "input", value: formattedPath ?? "" })
  }

  // Do not inject persistCodingAgentGeneratedScript here: stale zarr-key cache must not pre-fill
  // generated_script before a Run workflow has produced code (auto_bypass runs only after final apply).

  return {
    id: nodeId,
    title: cfg.title,
    type: modelId,
    progress: 0,
    content,
    ui: step.ui && typeof step.ui === "object" ? step.ui : null,
    stepName: factory,
  }
}
