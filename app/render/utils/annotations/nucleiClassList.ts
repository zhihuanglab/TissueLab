import { MODEL_DEPENDENCIES } from "@/constants/workflow.constants"
import { isNucleiClassifyModelId } from "@/utils/agent/graph/constants"
import { peekNucleiClassOperations } from "@/utils/agent/workflow/workflow.utils"

const NEGATIVE_CONTROL = "Negative control"

export type NucleiClassEntry = {
  name: string
  color: string
  /** Cells labelled AS this class. */
  count: number
  /** Cells marked "not this type"; a class can have these and no positives. */
  negativeCount?: number
  persisted?: boolean
}

function withNegativeControlFirst(classes: NucleiClassEntry[]): NucleiClassEntry[] {
  const negativeControl = classes.find((cls) => cls.name === NEGATIVE_CONTROL)
  if (!negativeControl) return classes
  return [negativeControl, ...classes.filter((cls) => cls.name !== NEGATIVE_CONTROL)]
}

/**
 * Apply a server/WS class list onto the Redux legend.
 *
 * Both modes put the incoming names FIRST, in the incoming order, and append
 * local-only classes after them. The order is not cosmetic: every overlay frame
 * carries per-cell `class_id`s that index the backend palette, and DrawingOverlay
 * colours a cell as `nucleiClasses[class_id]`. A legend in any other order paints
 * cell class 0 with class 1's colour — Negative control and Tumor swap.
 *
 * `load` (/classifications) refreshes colours from the backend; `ws` (overlay
 * frames) keeps the user's colours for classes it already knows and only adopts
 * the backend colour for classes it has never seen.
 */
export function applyIncomingNucleiClasses(opts: {
  incomingNames: string[]
  incomingColors?: string[]
  current: NucleiClassEntry[]
  mergeMode: "load" | "ws"
}): NucleiClassEntry[] {
  const { incomingNames, incomingColors = [], current, mergeMode } = opts
  const colorByName = new Map(incomingNames.map((name, index) => [name, incomingColors[index]]))
  const fromIncoming = (name: string): NucleiClassEntry => {
    const existing = current.find((cls) => cls.name === name)
    return {
      name,
      color: colorByName.get(name) || existing?.color || "#aaaaaa",
      count: existing?.count ?? 0,
      negativeCount: existing?.negativeCount ?? 0,
      persisted: true,
    }
  }

  if (mergeMode === "ws") {
    const incomingSet = new Set(incomingNames)
    const byName = new Map(current.map((cls) => [cls.name, cls]))
    let changed = false
    const ordered: NucleiClassEntry[] = incomingNames.map((name, index) => {
      const existing = byName.get(name)
      if (!existing) {
        changed = true
        return fromIncoming(name)
      }
      if (current[index] !== existing) changed = true
      const next = colorByName.get(name)
      if (next && next !== existing.color && name !== NEGATIVE_CONTROL) {
        changed = true
        return { ...existing, color: next }
      }
      return existing
    })
    // Local-only classes (added in the panel, not yet in any backend palette)
    // keep their relative order after the backend ones.
    for (const cls of current) {
      if (!incomingSet.has(cls.name)) ordered.push(cls)
    }
    if (!changed && ordered.length === current.length && ordered.every((cls, i) => cls === current[i])) {
      return current
    }
    // Only the local tail may be reshuffled: the backend prefix is the class_id space.
    const prefix = ordered.slice(0, incomingNames.length)
    const tail = withNegativeControlFirst(ordered.slice(incomingNames.length))
    return [...prefix, ...tail]
  }

  const finalClasses = incomingNames.map((name) => fromIncoming(name))
  for (const localClass of current) {
    if (!finalClasses.some((cls) => cls.name === localClass.name)) {
      finalClasses.push(localClass)
    }
  }
  return finalClasses.map((cls) => {
    const existing = current.find((entry) => entry.name === cls.name)
    return {
      ...cls,
      count: existing ? existing.count : 0,
      negativeCount: existing ? existing.negativeCount ?? 0 : 0,
      persisted: cls.persisted ?? existing?.persisted ?? true,
    }
  })
}

type ClassificationNodeLike = {
  id: string
  kind?: string
  modelId?: string
}

/** Prefer the selected classifier; if both exist, use the selected seg sibling, else NuClass. */
export function pickNucleiClassificationNode<T extends ClassificationNodeLike>(
  nodes: T[],
  selectedId: string | null | undefined,
): T | undefined {
  const classifiers = nodes.filter(
    (node) => node.kind === "model" && isNucleiClassifyModelId(node.modelId),
  )
  if (classifiers.length === 0) return undefined
  const selectedClassifier = classifiers.find((node) => node.id === selectedId)
  if (selectedClassifier) return selectedClassifier
  if (classifiers.length === 1) return classifiers[0]

  const byModel = (id: string | undefined) =>
    (id && classifiers.find((node) => node.modelId === id)) || classifiers[0]
  const selectedModel = nodes.find((node) => node.id === selectedId)?.modelId
  const fromParent = selectedModel ? MODEL_DEPENDENCIES[selectedModel]?.childType : undefined
  if (fromParent) return byModel(fromParent)
  return byModel("NuClass")
}


/**
 * What restrictClassesToAnnotated accepts. Deliberately looser than
 * NucleiClassEntry: that type is what applyIncomingNucleiClasses *produces* (its
 * consumers rely on `count` being there), while the payload builders hand over
 * whatever the caller's context happens to carry.
 */
type ClassListRow = {
  name: string
  color: string
  count?: number
  negativeCount?: number
}

function isAnnotated(cls: ClassListRow): boolean {
  return (cls.count ?? 0) > 0 || (cls.negativeCount ?? 0) > 0
}

/**
 * Class names with a one-vs-rest classifier attached for prediction. The panel
 * builds this map as an object; the graph path copies `panel.content` verbatim,
 * so there it is still the JSON text the panel stored.
 */
function classesWithOwnClassifier(inputObject: Record<string, any>): Set<string> {
  let map = inputObject.classifier_paths;
  if (typeof map === "string") {
    try {
      map = JSON.parse(map);
    } catch {
      return new Set();
    }
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return new Set();
  return new Set(
    Object.entries(map as Record<string, unknown>)
      .filter(([name, path]) => name && typeof path === "string" && path)
      .map(([name]) => name),
  );
}

/**
 * Names the user added to the class list in this session (`class_operations.adds`).
 * The graph path injects `class_operations` into the payload only after it is
 * built, so fall back to the pending-ops bridge the injection reads from.
 */
function pendingAddedClassNames(inputObject: Record<string, any>): Set<string> {
  const adds =
    inputObject.class_operations?.adds ?? peekNucleiClassOperations()?.adds;
  if (!Array.isArray(adds)) return new Set();
  return new Set(
    adds
      .map((op: any) => (typeof op?.name === "string" ? op.name : ""))
      .filter(Boolean),
  );
}

/**
 * A supervised nuclei-classification run trains on the classes the user annotated, so those are the
 * only ones worth sending. The panel's class list is often still carrying an
 * earlier zero-shot run's organ preset — the tasknode rewrites
 * `Cell-Classification/classes` (and the User-Annotations palette) from
 * `organ_to_celltypes` — and shipping those cell types back adds classes with no
 * training data behind them.
 *
 * "Annotated" includes "not this type" marks: a class can carry only those, and
 * dropping it would silently turn every one of those marks into a no-op.
 *
 * Three exceptions survive with no annotations at all: "Negative control", which
 * the tasknode pins to index 0 either way; a class the user just added, which is
 * about to be annotated and must not vanish from the list on this run; and a
 * class with a one-vs-rest classifier attached — the tasknode runs each `.tlcls`
 * only `if c in name_to_idx`, so dropping the name silently ignored a classifier
 * the user attached (multiclass re-adds the classifier's own classes, OvR does not).
 * With nothing annotated anywhere the run is zero-shot and the organ owns the
 * taxonomy, so the list is left untouched.
 */
export function restrictClassesToAnnotated(
  inputObject: Record<string, any>,
  nucleiClasses: ClassListRow[],
): void {
  if (!nucleiClasses.some(isAnnotated)) return;
  const justAdded = pendingAddedClassNames(inputObject);
  const hasClassifier = classesWithOwnClassifier(inputObject);
  const keep = nucleiClasses.filter(
    (cls) =>
      isAnnotated(cls) ||
      cls.name === NEGATIVE_CONTROL ||
      justAdded.has(cls.name) ||
      hasClassifier.has(cls.name),
  );
  inputObject.nuclei_classes = keep.map((cls) => cls.name);
  inputObject.nuclei_colors = keep.map((cls) => cls.color);
}
