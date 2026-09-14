import { CHILD_TO_PARENT, panelMap } from "@/constants/workflow.constants"
import type { WorkflowPanel } from "@/store/slices/chat/workflowSlice"
import { getZarrStructure, type ZarrObject, type ZarrStructure } from "@/services/data.service"

type PrereqNode = { modelId?: string }

const PREREQ_OUTPUT_GROUP: Record<string, string> = {
  MuskEmbedding: "Patch-Segmentation",
  HOptimusEmbedding: "Patch-Segmentation",
  VirchowEmbedding: "Patch-Segmentation",
  MuskClassification: "Patch-Classification",
  CellCast: "Cell-Segmentation",
  StarDist: "Cell-Segmentation",
  Cytoformer: "Cell-Segmentation",
  NuClass: "Cell-Classification",
  CytoformerClassification: "Cell-Classification",
}

// Cytoformer's own reuse check is stricter (hasCytoformerEmbeddings); every
// other Cell-Segmentation producer just needs the embeddings array present.
const PREREQ_OUTPUT_REQUIRED_ARRAYS: Record<string, string[]> = {
  "Cell-Segmentation": ["embeddings"],
  "Patch-Segmentation": ["embeddings"],
  "Cell-Classification": ["class_indices"],
  "Patch-Classification": ["class_indices"],
}

function findZarrObject(root: ZarrObject | undefined, path: string): ZarrObject | undefined {
  const target = path.replace(/^\/+/, "").toLowerCase()
  const visit = (node: ZarrObject | undefined): ZarrObject | undefined => {
    if (!node) return undefined
    if ((node.full_path || node.name).replace(/^\/+/, "").toLowerCase() === target) return node
    for (const child of node.children ?? []) {
      const match = visit(child)
      if (match) return match
    }
    return undefined
  }
  return visit(root)
}

/**
 * `/data/v1/structure` wraps every zarr attribute as `{ value, dtype, shape }`
 * (ZarrFileHandler._get_attributes). Read through the envelope, but accept a
 * bare value too so a plain attrs map keeps working.
 */
function zarrAttrValue(attrs: Record<string, unknown> | undefined, key: string): unknown {
  const raw = attrs?.[key]
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "value" in (raw as object)) {
    return (raw as { value?: unknown }).value
  }
  return raw
}

/**
 * Cell-Segmentation/embeddings is a slot shared by every segmentation node, so
 * look at who wrote it. The whole `embedding_*` contract is checked, not just
 * the model name: it has to agree with the backend's stage bar (tasks.py
 * `_compute_stage_progress_for_node`, same conditions), and the classification
 * tasknode only validates width + centroid count — so an older, L2-normalized
 * store would sail past it and hand the per-organ head features it was never
 * trained on. `embedding_norm=feat_norm` is exactly the marker for that.
 */
export function hasCytoformerEmbeddings(structure: ZarrStructure | undefined): boolean {
  const dataset = findZarrObject(structure?.root, "Cell-Segmentation/embeddings")
  if (!dataset) return false
  const shape = dataset.shape
  if (!Array.isArray(shape) || shape.length !== 2 || shape[0] <= 0 || shape[1] !== 1536) return false
  const centroids = findZarrObject(structure?.root, "Cell-Segmentation/centroids")?.shape
  if (!Array.isArray(centroids) || centroids[0] !== shape[0]) return false
  const attrs = dataset.attributes
  const str = (key: string) => String(zarrAttrValue(attrs, key) ?? "").trim().toLowerCase()
  return (
    str("embedding_model") === "cytoformer" &&
    str("embedding_backbone") === "h-optimus-0" &&
    Number(zarrAttrValue(attrs, "embedding_dim")) === 1536 &&
    str("embedding_norm") === "feat_norm"
  )
}

function synthesizeDefaultPanelByKey(panelKey: string): WorkflowPanel | null {
  const cfg = panelMap[panelKey]
  if (!cfg) return null
  return {
    id: `synth-${panelKey}-${Date.now()}`,
    title: cfg.title,
    type: cfg.defaultType,
    progress: 0,
    content: cfg.defaultContent.map((item) => ({ ...item, value: item.value })),
    ui: null,
    stepName: panelKey,
  }
}

/**
 * Prepend missing prerequisite backend steps. Walk CHILD_TO_PARENT; if an
 * upstream step is neither present nor already in `zarrPath`, synthesize it.
 * Shared by the graph Run button, Pipeline "Run all", and workflow batch runs.
 */
export async function augmentPanelsWithPrereqs(
  orderedGraphNodes: PrereqNode[],
  basePanels: WorkflowPanel[],
  baseTaskDeps: Record<string, string[]> | undefined,
  zarrPath: string,
  structure?: ZarrStructure,
): Promise<{ panelsToRun: WorkflowPanel[]; taskDeps: Record<string, string[]> | undefined }> {
  const presentTypes = new Set(orderedGraphNodes.map((n) => n.modelId).filter(Boolean) as string[])
  const existingPaths = new Set<string>()
  let hasReusableCytoformerEmbeddings = false
  try {
    const resolved = structure ?? (await getZarrStructure(zarrPath, "/", true, 2))
    hasReusableCytoformerEmbeddings = hasCytoformerEmbeddings(resolved)
    const walk = (obj: ZarrStructure["root"] | undefined, parentPath = "") => {
      if (!obj || typeof obj !== "object") return
      const children = Array.isArray(obj.children) ? obj.children : []
      for (const child of children) {
        const name = typeof child?.name === "string" ? child.name : ""
        const fullPath =
          typeof child?.full_path === "string"
            ? child.full_path
            : parentPath
              ? `${parentPath}/${name}`
              : name
        if (fullPath) {
          existingPaths.add(fullPath.toLowerCase())
        }
        walk(child, fullPath)
      }
    }
    walk(resolved.root, "")
  } catch {
    /* can't read the structure → prepend every missing prereq to be safe */
  }

  const outputGroupHasData = (group: string, modelType: string): boolean => {
    const g = group.toLowerCase()
    if (modelType === "Cytoformer") {
      return hasReusableCytoformerEmbeddings
    }
    const required = PREREQ_OUTPUT_REQUIRED_ARRAYS[group]
    if (!required || required.length === 0) {
      return Array.from(existingPaths).some((p) => p === g || p.endsWith(`/${g}`))
    }
    return required.every((arr) =>
      Array.from(existingPaths).some((p) => p.includes(`${g}/${arr.toLowerCase()}`)),
    )
  }

  const synthByType = new Map<string, WorkflowPanel>()
  const prereqDeps: Record<string, string[]> = {}
  const addPrereqDep = (child: string, on: string) => {
    if (!prereqDeps[child]) prereqDeps[child] = []
    if (!prereqDeps[child].includes(on)) prereqDeps[child].push(on)
  }
  for (const node of orderedGraphNodes) {
    const childType = node.modelId
    if (!childType) continue
    let lastRunning = childType
    let cur = childType
    const walked = new Set<string>([childType])
    while (true) {
      const parent = CHILD_TO_PARENT[cur]
      if (!parent || walked.has(parent.parentType)) break
      walked.add(parent.parentType)
      const pType = parent.parentType
      if (presentTypes.has(pType)) break
      const outGroup = PREREQ_OUTPUT_GROUP[pType]
      const outExists = !!(outGroup && outputGroupHasData(outGroup, pType))
      if (!outExists) {
        if (!synthByType.has(pType)) {
          const synth = synthesizeDefaultPanelByKey(parent.parentPanelKey)
          if (synth) {
            synth.type = pType
            synthByType.set(pType, synth)
          }
        }
        if (synthByType.has(pType)) {
          addPrereqDep(lastRunning, pType)
          lastRunning = pType
        }
      }
      cur = pType
    }
  }

  if (synthByType.size === 0) return { panelsToRun: basePanels, taskDeps: baseTaskDeps }

  const types = Array.from(synthByType.keys())
  const placed = new Set<string>()
  const orderedSynth: WorkflowPanel[] = []
  let guard = 0
  while (placed.size < types.length && guard++ < 1000) {
    for (const t of types) {
      if (placed.has(t)) continue
      const need = (prereqDeps[t] || []).filter((d) => synthByType.has(d) && !placed.has(d))
      if (need.length === 0) {
        orderedSynth.push(synthByType.get(t)!)
        placed.add(t)
      }
    }
  }
  for (const t of types) if (!placed.has(t)) orderedSynth.push(synthByType.get(t)!)

  let taskDeps = baseTaskDeps
  if (baseTaskDeps) {
    const merged: Record<string, string[]> = { ...baseTaskDeps }
    for (const t of types) if (!merged[t]) merged[t] = []
    for (const [k, v] of Object.entries(prereqDeps)) {
      merged[k] = Array.from(new Set([...(merged[k] || []), ...v]))
    }
    taskDeps = merged
  }
  return { panelsToRun: [...orderedSynth, ...basePanels], taskDeps }
}
